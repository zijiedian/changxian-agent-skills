import http from 'node:http';
import process from 'node:process';

import { loadConfig } from './config.mjs';
import { StateStore } from './store.mjs';
import { RuntimeController } from './controller.mjs';
import { startTelegramAdapter } from './adapters.telegram.mjs';
import { startWeComAdapter } from './adapters.wecom.mjs';
import { SchedulerRuntime } from './scheduler.mjs';

const config = loadConfig();
const store = new StateStore(config.stateDir);
store.init();
const controller = new RuntimeController(config, store);
const adapters = [];
const adapterMap = {};

if (config.tgBotToken) {
  const adapter = await startTelegramAdapter(config, controller);
  if (adapter) { adapters.push(adapter); adapterMap[adapter.name] = adapter; }
}
if (config.wecomBotId && config.wecomBotSecret) {
  const adapter = await startWeComAdapter(config, controller);
  if (adapter) { adapters.push(adapter); adapterMap[adapter.name] = adapter; }
}

const scheduler = new SchedulerRuntime(config, store, controller, adapterMap);
controller.attachScheduler(scheduler);
scheduler.start();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const adapterStates = Object.fromEntries(adapters.map((adapter) => [adapter.name, adapter.status]));
    const schedulerState = scheduler.snapshot();
    const ok = adapters.every((adapter) => !adapter.status.enabled || adapter.status.lastError == null) && !schedulerState.lastError;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, stateDir: config.stateDir, adapters: adapterStates, scheduler: schedulerState }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});
await new Promise((resolve) => server.listen(config.healthPort, config.host, resolve));
console.log(JSON.stringify({ ok: true, stateDir: config.stateDir, adapters: adapters.map((adapter) => adapter.name), scheduler: scheduler.snapshot(), healthPort: config.healthPort }));

async function shutdown(signal) {
  console.warn(`[reference-im-bridge] shutting down via ${signal}`);
  await scheduler.stop().catch(() => {});
  for (const adapter of adapters) {
    await adapter.stop().catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});
