import { spawn } from 'node:child_process';
import {
  buildStructuredPreview as sharedBuildStructuredPreview,
  cleanOutput as sharedCleanOutput,
  extractPreview as sharedExtractPreview,
  extractStructuredPreview as sharedExtractStructuredPreview,
  sanitizePreview as sharedSanitizePreview,
} from './utils.mjs';

export async function* runCommand(cmd, args, { cwd, timeoutSeconds }) {
  const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now();
  let stdoutEnded = false;
  const chunks = [];

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (data) => chunks.push(String(data)));
  proc.stderr.on('data', (data) => chunks.push(String(data)));
  proc.stdout.on('end', () => {
    stdoutEnded = true;
  });

  while (!stdoutEnded || chunks.length > 0) {
    if ((Date.now() - started) / 1000 > timeoutSeconds) {
      proc.kill('SIGKILL');
      throw new Error(`codex command timed out after ${timeoutSeconds}s`);
    }
    if (chunks.length > 0) {
      yield chunks.shift();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const code = await new Promise((resolve) => proc.on('close', resolve));
  if (code !== 0) {
    throw new Error(`codex exited with code ${code}`);
  }
}

export function cleanOutput(output) {
  return sharedCleanOutput(output);
}

export function sanitizePreview(output, status = 'Done') {
  return sharedSanitizePreview(output, status);
}

export function extractPreview(output, status = 'Done') {
  return sharedExtractPreview(output, status);
}

export function buildStructuredPreview(output, options = {}) {
  return sharedBuildStructuredPreview(output, options);
}

export function extractStructuredPreview(output, status = 'Done') {
  return sharedExtractStructuredPreview(output, status);
}
