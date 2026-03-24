import { AgentAcpProvider } from './acp-provider.mjs';

export class ClaudeAgentAcpProvider extends AgentAcpProvider {
  constructor(config, buildExecutionEnv) {
    super(config, buildExecutionEnv, {
      backend: 'claude',
      displayName: 'Claude Agent',
      authHint(detail = '', stderr = '') {
        if (/auth|login|anthropic/i.test(`${detail}\n${stderr}`)) {
          return ' Run `claude auth login` or set `ANTHROPIC_API_KEY`.';
        }
        return '';
      },
    });
  }
}
