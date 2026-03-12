import http from 'node:http';
import process from 'node:process';

import { loadConfig } from './config.mjs';
import { StateStore } from './store.mjs';
import { RuntimeController } from './controller.mjs';
import { startTelegramAdapter } from './adapters.telegram.mjs';
import { startWeComAdapter } from './adapters.wecom.mjs';
import { SchedulerRuntime } from './scheduler.mjs';

const startedAtMs = Date.now();
const config = loadConfig();
const store = new StateStore(config.stateDir);
store.init();
const controller = new RuntimeController(config, store);
const adapters = [];
const adapterMap = {};
let readinessTimer = null;
const requestedAdapters = [];
if (config.tgBotToken) requestedAdapters.push('telegram');
if (config.wecomBotId && config.wecomBotSecret) requestedAdapters.push('wecom');

const bootState = {
  startedAt: new Date(startedAtMs).toISOString(),
  listeningAt: null,
  launchCompletedAt: null,
  schedulerStartedAt: null,
  readyAt: null,
  pendingAdapters: new Set(requestedAdapters),
  adapterLaunch: Object.fromEntries(requestedAdapters.map((name) => [name, {
    state: 'pending',
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    error: null,
  }])),
};

function sinceStartupMs() {
  return Date.now() - startedAtMs;
}

function adapterStates() {
  return Object.fromEntries(adapters.map((adapter) => [adapter.name, adapter.status]));
}

function bootSnapshot() {
  return {
    startedAt: bootState.startedAt,
    listeningAt: bootState.listeningAt,
    launchCompletedAt: bootState.launchCompletedAt,
    schedulerStartedAt: bootState.schedulerStartedAt,
    readyAt: bootState.readyAt,
    uptimeMs: sinceStartupMs(),
    pendingAdapters: [...bootState.pendingAdapters],
    adapters: Object.fromEntries(
      Object.entries(bootState.adapterLaunch).map(([name, state]) => [name, { ...state }]),
    ),
  };
}

function maybeMarkReady(scheduler) {
  if (bootState.readyAt) return;
  const schedulerActive = !config.enableScheduler || scheduler.snapshot().active;
  const adaptersReady = requestedAdapters.every((name) => {
    const adapter = adapterMap[name];
    return adapter && adapter.status.lastError == null && adapter.status.connected !== false;
  });
  if (bootState.listeningAt && bootState.launchCompletedAt && schedulerActive && adaptersReady) {
    bootState.readyAt = new Date().toISOString();
  }
}

function startReadinessWatch(scheduler) {
  if (readinessTimer || bootState.readyAt) return;
  readinessTimer = setInterval(() => {
    maybeMarkReady(scheduler);
    if (!bootState.readyAt) return;
    clearInterval(readinessTimer);
    readinessTimer = null;
    console.log(JSON.stringify({
      ok: true,
      phase: 'ready',
      stateDir: config.stateDir,
      adapters: adapters.map((adapter) => adapter.name),
      scheduler: scheduler.snapshot(),
      startupMs: sinceStartupMs(),
    }));
  }, 250);
}

async function launchAdapter(name, start) {
  const startedMs = Date.now();
  const state = bootState.adapterLaunch[name] || {
    state: 'pending',
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    error: null,
  };
  bootState.adapterLaunch[name] = state;
  state.state = 'starting';
  state.startedAt = new Date(startedMs).toISOString();
  state.error = null;
  try {
    const adapter = await start();
    if (adapter) {
      adapters.push(adapter);
      adapterMap[adapter.name] = adapter;
      state.state = 'launched';
    } else {
      state.state = 'disabled';
    }
  } catch (error) {
    state.state = 'error';
    state.error = error?.message || String(error);
    console.error(`[reference-im-bridge] ${name} adapter startup failed`, error);
  } finally {
    state.finishedAt = new Date().toISOString();
    state.elapsedMs = Date.now() - startedMs;
    bootState.pendingAdapters.delete(name);
  }
}

const scheduler = new SchedulerRuntime(config, store, controller, adapterMap);
controller.attachScheduler(scheduler);

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    maybeMarkReady(scheduler);
    const adapterStatesSnapshot = adapterStates();
    const schedulerState = scheduler.snapshot();
    const ok = requestedAdapters.every((name) => bootState.adapterLaunch[name]?.state !== 'error')
      && Object.values(adapterStatesSnapshot).every((adapter) => !adapter.enabled || adapter.lastError == null)
      && !schedulerState.lastError;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok,
      ready: Boolean(bootState.readyAt),
      stateDir: config.stateDir,
      boot: bootSnapshot(),
      adapters: adapterStatesSnapshot,
      scheduler: schedulerState,
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});
await new Promise((resolve) => server.listen(config.healthPort, config.host, resolve));
bootState.listeningAt = new Date().toISOString();
console.log(JSON.stringify({
  ok: true,
  phase: 'listening',
  stateDir: config.stateDir,
  healthPort: config.healthPort,
  startupMs: sinceStartupMs(),
  requestedAdapters,
}));

void (async () => {
  await Promise.all([
    config.tgBotToken ? launchAdapter('telegram', () => startTelegramAdapter(config, controller)) : Promise.resolve(),
    config.wecomBotId && config.wecomBotSecret ? launchAdapter('wecom', () => startWeComAdapter(config, controller)) : Promise.resolve(),
  ]);
  bootState.launchCompletedAt = new Date().toISOString();
  scheduler.start();
  bootState.schedulerStartedAt = new Date().toISOString();
  startReadinessWatch(scheduler);
  maybeMarkReady(scheduler);
  console.log(JSON.stringify({
    ok: true,
    phase: 'bootstrap-complete',
    stateDir: config.stateDir,
    adapters: adapters.map((adapter) => adapter.name),
    scheduler: scheduler.snapshot(),
    startupMs: sinceStartupMs(),
  }));
})().catch((error) => {
  console.error('[reference-im-bridge] bootstrap failed', error);
});

async function shutdown(signal) {
  console.warn(`[reference-im-bridge] shutting down via ${signal}`);
  if (readinessTimer) {
    clearInterval(readinessTimer);
    readinessTimer = null;
  }
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
