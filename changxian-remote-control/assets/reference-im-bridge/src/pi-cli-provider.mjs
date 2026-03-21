import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { buildStructuredPreview, splitShellArgs, truncateText } from './utils.mjs';
import { BACKEND_PI } from './backend-detection.mjs';
import { enabledSkillPaths } from './resource-registry.mjs';

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function commandPath(command, env = process.env) {
  const pathValue = String(env.PATH || process.env.PATH || '');
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${command}${suffix}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return '';
}

function runProbe(executable, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('close', (code) => resolve({
      ok: code === 0,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    }));
    child.on('error', (error) => resolve({
      ok: false,
      stdout: '',
      stderr: error?.message || String(error),
    }));
  });
}

function ensureJsonMode(args) {
  const hasMode = args.some((arg) => arg === '--mode');
  if (hasMode) return args;
  return [...args, '--mode', 'json'];
}

function stripModeArgs(args = []) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (token === '--mode') {
      index += 1;
      continue;
    }
    if (token === '--session' || token === '--session-dir') {
      index += 1;
      continue;
    }
    if (token === '--skill') {
      index += 1;
      continue;
    }
    if (token === '--no-skills') {
      continue;
    }
    next.push(token);
  }
  return next;
}

function sessionDir(config = {}) {
  return path.join(String(config.stateDir || os.tmpdir()), 'pi-sessions');
}

function ensureSessionDir(config = {}) {
  const dir = sessionDir(config);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function collectAssistantContent(value, bucket) {
  if (!value) return;
  if (typeof value === 'string') {
    bucket.text.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssistantContent(item, bucket));
    return;
  }
  if (typeof value !== 'object') return;

  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'thinking' && typeof value.thinking === 'string') {
    bucket.thinking.push(value.thinking);
    return;
  }
  if (type === 'text' && typeof value.text === 'string') {
    bucket.text.push(value.text);
    return;
  }
  if (Array.isArray(value.content)) {
    collectAssistantContent(value.content, bucket);
    return;
  }
  if (typeof value.text === 'string') {
    bucket.text.push(value.text);
    return;
  }
  if (typeof value.thinking === 'string') {
    bucket.thinking.push(value.thinking);
  }
}

function extractAssistantMessageContent(event) {
  const message = event?.message;
  if (!message || String(message.role || '') !== 'assistant') return { text: '', thinking: '' };
  const bucket = { text: [], thinking: [] };
  collectAssistantContent(message.content || message, bucket);
  return {
    text: bucket.text.join('').trim(),
    thinking: bucket.thinking.join('').trim(),
  };
}

function normalizeThoughtText(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeThinkingPreview(thinkingText = '') {
  const content = normalizeThoughtText(thinkingText);
  return buildStructuredPreview(`thinking\n${content}`, {
    status: 'Running',
    marker: 'thinking',
  });
}

function makeAssistantPreview(assistantText = '') {
  const content = String(assistantText || '').trim();
  return buildStructuredPreview(content, {
    status: 'Running',
    marker: 'assistant',
  });
}

function parsePiEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function shouldRetryFreshSession(errorText = '') {
  const message = String(errorText || '').toLowerCase();
  return message.includes('no session found matching');
}

export class PiCliProvider {
  constructor(config, buildExecutionEnv) {
    this.config = config;
    this.buildExecutionEnv = buildExecutionEnv;
    this.cliPath = '';
    this.cliVersion = '';
    this.diagnostics = {
      backend: BACKEND_PI,
      initialized: false,
      cliPath: '',
      cliVersion: '',
      lastInitError: '',
      lastResumeSkipReason: '',
    };
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  resolveCli() {
    if (this.cliPath) return this.cliPath;
    const explicit = String(this.config.piExecutable || '').trim();
    const detected = explicit || commandPath('pi', this.buildExecutionEnv(process.env));
    if (!detected) {
      this.diagnostics = {
        ...this.diagnostics,
        initialized: false,
        cliPath: '',
        cliVersion: '',
        lastInitError: 'Pi CLI not found. Install @mariozechner/pi-coding-agent or set RC_PI_EXECUTABLE.',
      };
      return '';
    }
    this.cliPath = detected;
    return detected;
  }

  async ensureCli(commandPrefix = '') {
    const prefixArgs = splitShellArgs(commandPrefix || '');
    const fallbackExecutable = prefixArgs[0] || '';
    const cliPath = fallbackExecutable || this.resolveCli();
    if (!cliPath) throw new Error(this.diagnostics.lastInitError);
    if (this.diagnostics.initialized && this.diagnostics.cliPath === cliPath) return cliPath;

    const probeArgs = fallbackExecutable
      ? [...stripModeArgs(prefixArgs.slice(1)), '--version']
      : ['--version'];
    const versionProbe = await runProbe(cliPath, probeArgs, this.buildExecutionEnv(process.env));
    this.cliVersion = firstLine(versionProbe.stdout || versionProbe.stderr);
    this.diagnostics = {
      ...this.diagnostics,
      initialized: versionProbe.ok,
      cliPath,
      cliVersion: this.cliVersion,
      lastInitError: versionProbe.ok ? '' : (this.cliVersion || 'failed to query pi version'),
    };
    if (!versionProbe.ok) throw new Error(`Pi CLI init failed: ${this.diagnostics.lastInitError}`);
    return cliPath;
  }

  async runTask(params) {
    const {
      prompt,
      commandPrefix,
      workingDirectory,
      sessionId,
      abortSignal,
      onProgress,
      files = [],
    } = params;

    const cliPath = await this.ensureCli(commandPrefix);
    const runOnce = async (resumeSessionId = '') => {
      const prefixArgs = splitShellArgs(commandPrefix || '');
      const executable = prefixArgs.shift() || cliPath;
      const args = ensureJsonMode(stripModeArgs(prefixArgs));
      const skillPaths = enabledSkillPaths().filter((skillPath) => fs.existsSync(skillPath));
      args.push('--no-skills');
      for (const skillPath of skillPaths) {
        args.push('--skill', skillPath);
      }
      const dir = ensureSessionDir(this.config);
      args.push('--session-dir', dir);
      if (resumeSessionId) {
        args.push('--session', String(resumeSessionId).trim());
      }
      for (const file of files) {
        const filePath = String(file?.path || file?.filePath || '').trim();
        if (filePath && fs.existsSync(filePath)) args.push(`@${filePath}`);
      }
      args.push(String(prompt || ''));

      const env = this.buildExecutionEnv(process.env);
      const child = spawn(executable, args, {
        cwd: workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timeoutMs = Math.max(1, Number(this.config.piTimeoutSeconds || 21600)) * 1000;
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
        }, 1000).unref?.();
      }, timeoutMs);
      timeoutHandle.unref?.();

      let activeSessionId = String(resumeSessionId || '').trim();
      let finalText = '';
      let finalThinking = '';
      let streamedText = '';
      let streamedThinking = '';
      let stderr = '';
      let stdoutBuffer = '';

      const handleEvent = async (event) => {
        if (!event || typeof event !== 'object') return;

        if (event.type === 'session' && event.id) {
          activeSessionId = String(event.id).trim();
          return;
        }

        if (event.type === 'thinking_start') {
          streamedThinking = '';
          return;
        }

        if (event.type === 'thinking_delta') {
          const delta = String(event.delta || event.assistantMessageEvent?.delta || '');
          if (delta) {
            streamedThinking += delta;
            const preview = makeThinkingPreview(streamedThinking);
            await onProgress?.({
              marker: 'thinking',
              text: truncateText(preview.summary || streamedThinking, 1200) || 'thinking...',
              preview,
            });
          }
          return;
        }

        if (event.type === 'thinking_end') {
          const content = String(event.content || '').trim();
          if (content) {
            streamedThinking = content;
            finalThinking = content;
          }
          return;
        }

        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          const delta = String(event.assistantMessageEvent.delta || '');
          if (delta) {
            streamedText += delta;
            const preview = makeAssistantPreview(streamedText);
            await onProgress?.({
              marker: 'assistant',
              text: truncateText(preview.summary || streamedText, 1200) || 'thinking...',
              preview,
            });
          }
          return;
        }

        if (event.type === 'tool_execution_start') {
          await onProgress?.({
            marker: 'exec',
            text: `执行工具: ${String(event.toolName || 'tool')}`,
            preview: {
              phase: 'exec',
              summary: `执行工具: ${String(event.toolName || 'tool')}`,
              content: truncateText(JSON.stringify(event.args || {}), 400),
            },
          });
          return;
        }

        if (event.type === 'message_end') {
          const content = extractAssistantMessageContent(event);
          if (content.text) finalText = content.text;
          if (content.thinking) finalThinking = content.thinking;
          return;
        }

        if (event.type === 'turn_end') {
          const content = extractAssistantMessageContent(event);
          if (content.text) finalText = content.text;
          if (content.thinking) finalThinking = content.thinking;
        }
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += String(chunk);
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          const event = parsePiEvent(line);
          if (event) {
            handleEvent(event).catch(() => {});
          } else if (line) {
            streamedText += `${streamedText ? '\n' : ''}${line}`;
          }
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      const abortHandler = () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
        }, 1000).unref?.();
      };
      abortSignal?.addEventListener('abort', abortHandler, { once: true });

      const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      }).finally(() => {
        clearTimeout(timeoutHandle);
        abortSignal?.removeEventListener('abort', abortHandler);
      });

      if (stdoutBuffer.trim()) {
        const event = parsePiEvent(stdoutBuffer.trim());
        if (event) {
          await handleEvent(event);
        } else {
          streamedText += `${streamedText ? '\n' : ''}${stdoutBuffer.trim()}`;
        }
      }

      if (abortSignal?.aborted) {
        throw new Error('Pi task aborted');
      }
      if (exitCode !== 0) {
        if (timedOut) throw new Error(`Pi task timed out after ${Math.round(timeoutMs / 1000)}s`);
        throw new Error(firstLine(stderr) || `pi exited with code ${exitCode}`);
      }

      return {
        output: String(finalText || streamedText || finalThinking || streamedThinking || firstLine(stderr) || '').trim(),
        sessionId: activeSessionId,
      };
    };

    let activeSessionId = String(sessionId || '').trim();
    try {
      return await runOnce(activeSessionId);
    } catch (error) {
      const detail = error?.message || String(error);
      if (activeSessionId && shouldRetryFreshSession(detail)) {
        this.diagnostics = {
          ...this.diagnostics,
          lastResumeSkipReason: detail,
        };
        return await runOnce('');
      }
      throw error;
    }
  }
}
