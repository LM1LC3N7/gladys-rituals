// -----------------------------------------------------------------------------
// Commands: turn on and intensity (wait their turn, never during a pause),
// turn off (protective: never blocked, kept and sent again until confirmed),
// confirmation by a read back, "nothing sent" vs "sent without confirmation".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RitualsApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import { CONFIG, F, MINUTE, SECOND, SELECTOR, memoryLogger, setup } from './helpers/app.js';
import { testClock } from './helpers/clock.js';
import { HASH_A, HASH_B, HUBLOT_A, HUBLOT_B, createCloud, hub } from './helpers/fakeRituals.js';

const POST_FAN = `POST hubs/${HASH_A}/attributes/fanc`;
const POST_SPEED = `POST hubs/${HASH_A}/attributes/speedc`;
const READ_A = `GET account/hubs/${HASH_A}`;
const LIST = 'GET account/hubs';
const LOGIN = 'POST account/token';

/** A gate: `on` answers with it, `open()` lets the default answer through. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  return { promise, open };
}

test('turn on: sent, read back, confirmed: the state follows the read back', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  const ack = await env.set(HUBLOT_A, 'power', 1);
  assert.equal(ack.success, true);
  const last = env.cloud.requests.slice(-2).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(last, [POST_FAN, READ_A]);
  assert.deepEqual(env.cloud.requests.at(-2).json, { fanc: '1' });
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 1);
  await env.app.stop();
});

test('intensity 1 to 3 only; anything else: nothing sent', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  const ok = await env.set(HUBLOT_A, 'intensity', 3);
  assert.equal(ok.success, true);
  assert.deepEqual(env.cloud.requests.find((r) => `${r.method} ${r.path}` === POST_SPEED).json, {
    speedc: '3',
  });
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'intensity')), 3);
  const count = env.cloud.requests.length;
  for (const value of [0, 4, 1.5, -1, Number.NaN, 'x', '']) {
    const ack = await env.set(HUBLOT_A, 'intensity', value);
    assert.equal(ack.success, false, `${value}`);
    assert.match(ack.error, /Valeur invalide : rien envoyé/);
  }
  for (const value of [2, 0.5, 'on']) {
    const ack = await env.set(HUBLOT_A, 'power', value);
    assert.equal(ack.success, false, `${value}`);
  }
  assert.equal(env.cloud.requests.length, count);
  await env.app.stop();
});

test('a read back equal to the state before: not applied yet, follow-up reads show it later', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.applyDelay = 10 * SECOND;
  const ack = await env.set(HUBLOT_A, 'power', 1);
  assert.equal(ack.success, true, 'sent: not a failure');
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 0, 'not confirmed: no new state');
  assert.match(env.logger.lines.join('\n'), /not applied yet/);
  await env.wait(5 * SECOND);
  assert.equal(env.cloud.count(LIST), 2, 'follow-up at 5 s');
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 0);
  await env.wait(15 * SECOND);
  assert.equal(env.cloud.count(LIST), 3, 'follow-up at 20 s');
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 1);
  await env.app.stop();
});

test('sent without an answer: neither success state nor refusal, a quick read; never left: "nothing sent"', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.on = (r) =>
    r.method === 'POST' && r.path.endsWith('fanc') ? { error: 'timeout', sent: true } : undefined;
  const sent = await env.set(HUBLOT_A, 'power', 1);
  assert.equal(sent.success, true);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 0);
  assert.match(env.logger.lines.join('\n'), /sent without confirmation \(timeout\)/);
  await env.wait(5 * SECOND);
  assert.equal(env.cloud.count(LIST), 2);
  env.cloud.on = (r) =>
    r.method === 'POST' && r.path.endsWith('speedc')
      ? { error: 'network', sent: false }
      : undefined;
  const never = await env.set(HUBLOT_A, 'intensity', 1);
  assert.equal(never.success, false);
  assert.match(never.error, /Rien envoyé : erreur réseau/);
  await env.app.stop();
});

test('a 400 of Rituals is a refusal; 401 "not linked" too, and it is no refused password', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.on = (r) =>
    r.method === 'POST' && r.path.endsWith('speedc')
      ? { status: 400, body: { message: 'Value 4 is not a valid option' } }
      : r.method === 'POST'
        ? { status: 401, body: { message: "This hub is not linked to the user's account" } }
        : undefined;
  const bad = await env.set(HUBLOT_A, 'intensity', 2);
  assert.equal(bad.success, false);
  assert.match(bad.error, /Refusée par Rituals/);
  const notLinked = await env.set(HUBLOT_A, 'power', 1);
  assert.equal(notLinked.success, false);
  assert.match(notLinked.error, /non lié/);
  assert.equal(env.app.refused, undefined);
  assert.equal(env.cloud.count(LOGIN), 1);
  await env.app.stop();
});

test('unknown or offline diffuser, no account: nothing sent', async () => {
  const env = await setup({ hubs: [hub(), hub({ hublot: HUBLOT_B, hash: HASH_B, status: 0 })] });
  const count = env.cloud.requests.length;
  const unknown = await env.set('LOT404', 'power', 1);
  assert.match(unknown.error, /Diffuseur inconnu/);
  const offline = await env.set(HUBLOT_B, 'power', 1);
  assert.match(offline.error, /hors ligne/);
  assert.equal(env.cloud.requests.length, count);
  await env.gladys.fake.configUpdated({ password: 'x' });
  await env.wait(0);
  const none = await env.set(HUBLOT_A, 'power', 0);
  assert.match(none.error, /aucun compte configuré/);
  await env.app.stop();
});

test('during a 429 pause: turn on refused (nothing sent), turn off sent anyway', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) =>
    r.path === 'account/hubs'
      ? { status: 429, headers: { 'retry-after': '3600' }, body: {} }
      : undefined;
  await env.wait(5 * MINUTE);
  assert.match(env.gladys.fake.connectionStatus.message.en, /paused/);
  env.cloud.on = undefined;
  const on = await env.set(HUBLOT_A, 'intensity', 1);
  assert.match(on.error, /Rien envoyé : Rituals demande d’attendre/);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(env.cloud.count(POST_FAN), 1);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 0);
  await env.app.stop();
});

test('turn off without a token logs in at once, even right after a login and during a lockout-free pause', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.tokens.clear();
  env.app.session.client.forgetToken();
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(env.cloud.count(LOGIN), 2);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('turn off with logins locked by Rituals and no token: refused clearly, kept for later', async () => {
  const store = createMemoryStore();
  const env = await setup({ created: [HUBLOT_A], store });
  env.app.session.client.forgetToken();
  env.app.setLock(1200);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, false);
  assert.match(off.error, /pas encore partie \(connexions bloquées par Rituals\)/);
  assert.equal(env.cloud.count(POST_FAN), 0);
  assert.ok(store.data.offs[HUBLOT_A]);
  await env.app.stop();
});

test('turn off cancels the commands waiting and does not wait for the one in flight', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  const held = gate();
  env.cloud.on = (r) => (r.method === 'POST' && r.json?.fanc === '1' ? held.promise : undefined);
  const first = env.set(HUBLOT_A, 'power', 1);
  await env.wait(0);
  const second = env.set(HUBLOT_A, 'intensity', 3);
  await env.wait(0);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true, 'the turn off left while the turn on was in flight');
  const waiting = await second;
  assert.equal(waiting.success, false);
  assert.match(waiting.error, /Annulée par une extinction/);
  assert.equal(env.cloud.count(POST_SPEED), 0);
  // The turn on in flight lands after the turn off: the turn off is sent again.
  held.open();
  await first;
  await env.wait(0);
  const posts = env.cloud.requests.filter((r) => r.method === 'POST' && r.path.endsWith('fanc'));
  assert.deepEqual(
    posts.map((r) => r.json.fanc),
    ['1', '0', '0'],
  );
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('queue full: a third waiting command is refused, a turn off still goes', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  const held = gate();
  env.cloud.on = (r) => (r.method === 'POST' && r.json?.fanc === '1' ? held.promise : undefined);
  const pending = [env.set(HUBLOT_A, 'power', 1)];
  await env.wait(0);
  pending.push(env.set(HUBLOT_A, 'intensity', 1), env.set(HUBLOT_A, 'intensity', 2));
  await env.wait(0);
  const full = await env.set(HUBLOT_A, 'intensity', 3);
  assert.match(full.error, /Trop de commandes/);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  held.open();
  await Promise.all(pending);
  await env.app.stop();
});

test('a frozen read is cut by a turn off and does not count as a failure', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) => (r.path === 'account/hubs' ? 'hang' : undefined);
  await env.clock.advance(5 * MINUTE);
  await env.clock.advance(2 * SECOND);
  assert.ok(env.app.readCtl, 'a read is hanging');
  env.cloud.on = undefined;
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  await env.wait(0);
  assert.equal(env.app.readCtl, undefined, 'the frozen read was cut');
  assert.equal(env.app.failures, 0);
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  assert.match(env.logger.lines.join('\n'), /frozen read was cut/);
  await env.app.stop();
});

test('turn off not confirmed: kept in /data, sent again every minute, 3 times at most', async () => {
  const store = createMemoryStore();
  const env = await setup({ created: [HUBLOT_A], store });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  // The cloud takes the turn off but the diffuser stays on.
  env.cloud.on = (r) =>
    r.method === 'POST' && r.json?.fanc === '0' ? { status: 200, body: {} } : undefined;
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(store.data.offs[HUBLOT_A].tries, 1);
  await env.wait(MINUTE);
  assert.equal(env.cloud.count(POST_FAN), 2);
  await env.wait(MINUTE);
  assert.equal(env.cloud.count(POST_FAN), 3);
  await env.wait(5 * MINUTE);
  assert.equal(env.cloud.count(POST_FAN), 3, 'given up after 3 tries');
  assert.equal(store.data.offs[HUBLOT_A], undefined);
  await env.app.stop();
});

test('the resend of a turn off yields to a newer command that left, not to one refused', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) =>
    r.method === 'POST' && r.json?.fanc === '0'
      ? { status: 200, body: {} }
      : r.method === 'POST' && r.json?.speedc === '2'
        ? { status: 400, body: { message: 'no' } }
        : undefined;
  await env.set(HUBLOT_A, 'power', 0);
  // A newer command refused by Rituals (400): the turn off is still sent again.
  await env.set(HUBLOT_A, 'intensity', 2);
  await env.wait(MINUTE);
  assert.equal(env.cloud.count(POST_FAN), 2);
  // A newer command that left: the turn off is not sent again.
  await env.set(HUBLOT_A, 'intensity', 1);
  await env.wait(MINUTE);
  assert.equal(env.cloud.count(POST_FAN), 2);
  assert.equal(env.app.offs.size, 0);
  await env.app.stop();
});

test('a turn off kept in /data leaves right after a restart, before the first read', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock });
  cloud.hubs[0].attributeValues.fanc = '1';
  const env = await setup({ clock, cloud, store, created: [HUBLOT_A] });
  cloud.on = () => ({ error: 'network', sent: false });
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, false);
  assert.match(off.error, /gardée/);
  await env.app.stop();
  cloud.on = undefined;
  await clock.advance(10 * SECOND);
  const count = cloud.requests.length;
  const again = await setup({ clock, cloud, store });
  const after = cloud.requests.slice(count).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(after.slice(0, 2), [LOGIN, POST_FAN]);
  assert.equal(cloud.hubs[0].attributeValues.fanc, '0');
  // The next read confirms it.
  await again.wait(5 * MINUTE);
  assert.equal(store.data.offs[HUBLOT_A], undefined);
  await again.app.stop();
});

test('/data that cannot be written never blocks a turn off', async () => {
  const store = createMemoryStore();
  const env = await setup({ created: [HUBLOT_A], store });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  store.failSave = true;
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('a read back of another diffuser is no confirmation', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.on = (r) =>
    `${r.method} ${r.path}` === READ_A
      ? { status: 200, body: hub({ hublot: HUBLOT_B, hash: HASH_A, on: '1' }) }
      : undefined;
  await env.set(HUBLOT_A, 'power', 1);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 0);
  assert.match(env.logger.lines.join('\n'), /not this diffuser/);
  await env.app.stop();
});

test('a read started before a command never publishes the state the command replaced', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  const held = gate();
  env.cloud.on = (r) => (r.path === 'account/hubs' ? held.promise : undefined);
  await env.clock.advance(5 * MINUTE);
  env.cloud.on = undefined;
  // The list answer was taken while the diffuser was off, sent after the turn on.
  const old = structuredClone(env.cloud.hubs);
  const ack = await env.set(HUBLOT_A, 'power', 1);
  assert.equal(ack.success, true);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 1);
  const live = env.cloud.hubs;
  env.cloud.hubs = old;
  held.open();
  await env.wait(0);
  env.cloud.hubs = live;
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 1);
  await env.app.stop();
});

test('a 5xx on one diffuser neither pauses nor stops the others', async () => {
  const env = await setup({
    hubs: [hub(), hub({ hublot: HUBLOT_B, hash: HASH_B })],
    created: [HUBLOT_A, HUBLOT_B],
  });
  env.cloud.on = (r) =>
    r.method === 'POST' && r.path.includes(HASH_A) ? { status: 503, body: {} } : undefined;
  const a = await env.set(HUBLOT_A, 'power', 1);
  const b = await env.set(HUBLOT_B, 'power', 1);
  assert.equal(a.success, true, 'a 5xx: sent, not confirmed');
  assert.equal(b.success, true);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_B, 'power')), 1);
  assert.equal(env.app.pause, undefined);
  await env.app.stop();
});

test('a scene on 5 slow diffusers (600 ms per request, real clock): all 5 set within the ack', async () => {
  const hubs = Array.from({ length: 5 }, (_, i) =>
    hub({ hublot: `LOT${i}`, hash: `${i}`.repeat(64) }),
  );
  const clock = {
    now: Date.now,
    monotonic: () => performance.now(),
    timers: { setTimeout, clearTimeout },
  };
  const cloud = createCloud({ clock: { ...clock, elapsed: 0 }, hubs });
  cloud.on = (r) =>
    r.method === 'POST' || r.path.startsWith('account/hubs/')
      ? new Promise((resolve) => setTimeout(() => resolve(undefined), 600))
      : undefined;
  const gladys = createFakeGladys({ selector: SELECTOR, config: CONFIG });
  const logger = memoryLogger();
  const app = new RitualsApp({
    gladys,
    logger,
    ...clock,
    store: createMemoryStore(),
    transport: cloud.transport,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  while (gladys.fake.discoveredDevices.length < 5) await new Promise((r) => setTimeout(r, 10));
  await app.idle();
  for (const h of hubs) {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(h.hublot));
    await gladys.fake.deviceCreated(device);
  }
  const started = performance.now();
  const acks = await Promise.all(
    hubs.map((h) =>
      gladys.fake.setValue({ external_id: '' }, { external_id: F(h.hublot, 'power') }, 1),
    ),
  );
  const took = performance.now() - started;
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
  assert.ok(took < 3500, `${Math.round(took)} ms`);
  for (const h of hubs) {
    assert.equal(gladys.fake.lastState(F(h.hublot, 'power')), 1, h.hublot);
  }
  await app.stop();
});

test('Gladys reconnecting with getConfig failing: the configuration in memory still turns off', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  const original = env.gladys.getConfig.bind(env.gladys);
  let calls = 0;
  env.gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1) throw new Error('Gladys busy');
    return original();
  };
  await env.gladys.disconnect();
  await env.gladys.connect();
  await env.wait(0);
  assert.ok(calls >= 2);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});
