// -----------------------------------------------------------------------------
// The app with its real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, the fake Rituals cloud and a virtual clock that moves.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RitualsApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { testClock } from './clock.js';
import { EMAIL, PASSWORD, createCloud } from './fakeRituals.js';

export const SELECTOR = 'rituals';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const CONFIG = { email: EMAIL, password: PASSWORD, poll_interval: 300, language: 'fr' };
export const F = (hublot, key) => `ext:${SELECTOR}:diffuser:${hublot}:${key}`;
export const D = (hublot) => `ext:${SELECTOR}:diffuser:${hublot}`;

export function memoryLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/**
 * `start: false` leaves Gladys unconnected (call `connect()`); `hubs` and
 * `cloud` shape the account; `created`: hublots whose discovered device the
 * user created after the first read.
 */
export async function setup({
  clock = testClock(),
  cloud,
  hubs,
  store = createMemoryStore(),
  config = CONFIG,
  devices = [],
  timings,
  start = true,
  created = [],
} = {}) {
  const rituals = cloud ?? createCloud({ clock, ...(hubs ? { hubs } : {}) });
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  const logger = memoryLogger();
  const app = new RitualsApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    transport: rituals.transport,
    random: () => '0123456789abcdef0123456789abcdef',
    timings,
  });
  registerHandlers(gladys, app, logger);
  const wait = async (ms = 0) => {
    await clock.advance(ms);
    await app.idle();
    await clock.advance(0);
  };
  const env = { app, gladys, clock, cloud: rituals, store, logger, wait };
  env.connect = async () => {
    await gladys.connect();
    await wait(0);
  };
  env.create = async (hublot) => {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === D(hublot));
    if (!device) throw new Error(`${hublot} not discovered`);
    await gladys.fake.deviceCreated(structuredClone(device));
    await wait(0);
    return gladys.fake.devices.find((d) => d.external_id === D(hublot));
  };
  env.set = (hublot, key, value) => {
    const device = gladys.fake.devices.find((d) => d.external_id === D(hublot));
    const feature = device?.features.find((f) => f.external_id === F(hublot, key)) ?? {
      external_id: F(hublot, key),
    };
    return gladys.fake.setValue(device ?? { external_id: D(hublot) }, feature, value);
  };
  env.statesOf = (hublot, key) =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === F(hublot, key));
  if (start) {
    await env.connect();
    for (const hublot of created) await env.create(hublot);
  }
  return env;
}
