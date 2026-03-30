import { AgentAcpProvider } from './acp-provider.mjs';

export class PiAcpProvider extends AgentAcpProvider {
  constructor(config, buildExecutionEnv) {
    super(config, buildExecutionEnv, {
      backend: 'pi',
      displayName: 'Pi',
      authHint(detail = '', stderr = '') {
        if (/auth|provider|api[_ -]?key|login/i.test(`${detail}\n${stderr}`)) {
          return ' Check your Pi provider login or API key configuration.';
        }
        return '';
      },
    });
  }
}
