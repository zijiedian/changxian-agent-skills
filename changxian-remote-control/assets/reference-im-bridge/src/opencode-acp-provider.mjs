import { AgentAcpProvider } from './acp-provider.mjs';

export class OpencodeAcpProvider extends AgentAcpProvider {
  constructor(config, buildExecutionEnv) {
    super(config, buildExecutionEnv, {
      backend: 'opencode-acp',
      displayName: 'OpenCode',
      authHint(detail = '', stderr = '') {
        if (/auth/i.test(detail) || /auth/i.test(stderr)) {
          return ' Run `opencode auth login` or check your OpenCode provider credentials.';
        }
        return '';
      },
    });
  }
}
