import { AgentAcpProvider } from './base.mjs';

export class CodexAcpProvider extends AgentAcpProvider {
  constructor(config, buildExecutionEnv) {
    super(config, buildExecutionEnv, {
      backend: 'codex',
      displayName: 'Codex',
      authHint(detail = '', stderr = '') {
        if (/auth|login|api[_ -]?key|openai/i.test(`${detail}\n${stderr}`)) {
          return ' Run `codex auth login` or set `CODEX_API_KEY` / `OPENAI_API_KEY`.';
        }
        return '';
      },
    });
  }
}
