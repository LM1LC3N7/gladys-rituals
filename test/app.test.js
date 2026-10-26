// -----------------------------------------------------------------------------
// The app end to end: SDK wiring, fake Gladys, fake Rituals cloud, a virtual
// clock that moves at every read. Reads, pace, logins, pauses, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { CONFIG, D, F, HOUR, MINUTE, SECOND, setup } from './helpers/app.js';
import { testClock } from './helpers/clock.js';
import {
  HASH_A,
  HASH_B,
  HUBLOT_A,
  HUBLOT_B,
  PASSWORD,
  createCloud,
  hub,
} from './helpers/fakeRituals.js';

const LIST = 'GET account/hubs';
const LOGIN = 'POST account/token';

test('first read: one login, the list, the sensors of one diffuser; Discovery and status', async () => {
  const env = await setup({
    hubs: [hub(), hub({ hublot: HUBLOT_B, hash: HASH_B, name: 'Chambre' })],
  });
  assert.equal(env.cloud.count(LOGIN), 1);
  assert.equal(env.cloud.count(LIST), 1);
  // The sensors of ONE diffuser per read (one request per sensor).
  assert.equal(env.cloud.count(/sensors/), 3);
  const devices = env.gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [D(HUBLOT_A), D(HUBLOT_B)],
  );
  assert.equal(devices[1].name, 'Chambre');
  assert.deepEqual(
    devices[0].features.map((f) => f.external_id.split(':').pop()),
    ['power', 'intensity', 'fill', 'perfume', 'wifi'],
  );
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  // Nothing created yet: no state.
  assert.equal(env.gladys.fake.states.length, 0);
  // The own User-Agent of the integration, never an app's; no app key.
  for (const r of env.cloud.requests) {
    assert.equal(r.headers['User-Agent'], 'gladys-rituals');
    assert.deepEqual(
      Object.keys(r.headers).sort(),
      r.path === 'account/token'
        ? ['Accept', 'User-Agent']
        : ['Accept', 'Authorization', 'User-Agent'],
    );
  }
  await env.app.stop();
});

test('a created device gets its fresh values at once, and the next reads only the changes', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 0);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'intensity')), 2);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'fill')), 70);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'perfume')), 'The Ritual of Sakura');
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'wifi')), 2);
  const count = env.gladys.fake.states.length;
  env.cloud.hubs[0].attributeValues.fanc = '1';
  await env.wait(5 * MINUTE);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'power')), 1);
  assert.equal(env.gladys.fake.states.length, count + 1, 'only the changed state');
  await env.app.stop();
});

test('pace: one list read per interval, sensors every 30 min, token reused', async () => {
  const env = await setup();
  await env.wait(5 * MINUTE - SECOND);
  assert.equal(env.cloud.count(LIST), 1, 'never sooner than the interval');
  await env.wait(SECOND);
  assert.equal(env.cloud.count(LIST), 2);
  await env.wait(25 * MINUTE);
  assert.equal(env.cloud.count(LIST), 7);
  assert.equal(env.cloud.count(/sensors/), 6, 'the sensors again after 30 min');
  assert.equal(env.cloud.count(LOGIN), 1, 'one login while the token is valid');
  await env.app.stop();
});

test('the token is renewed before its expiry, read against the Date of Rituals', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock });
  // The wall clock of Gladys is 2 h late: never compared with the expiry.
  clock.wall = -2 * HOUR;
  const env = await setup({ clock, cloud });
  await env.wait(55 * MINUTE);
  assert.equal(env.cloud.count(LOGIN), 1);
  await env.wait(5 * MINUTE);
  assert.equal(env.cloud.count(LOGIN), 2, 'renewed one minute before the hour');
  assert.equal(env.cloud.count(/401/), 0);
  await env.app.stop();
});

test('without a Date header the token is used until Rituals refuses it, then one login', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock, date: false });
  const env = await setup({ clock, cloud });
  await env.wait(65 * MINUTE);
  assert.equal(env.cloud.count(LOGIN), 1, 'never "expired" without a readable date');
  cloud.tokens.clear();
  await env.wait(5 * MINUTE);
  assert.equal(env.cloud.count(LOGIN), 2, 'a 401 on an old token: one login, one retry');
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  await env.app.stop();
});

test('a 401 on a token just given is not a refused password: spaced, doubled, no stop', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock });
  cloud.on = (r) =>
    r.path === 'account/hubs' ? { status: 401, body: { message: 'Unauthorized' } } : undefined;
  const env = await setup({ clock, cloud });
  assert.equal(env.gladys.fake.connectionStatus.connected, false);
  assert.doesNotMatch(env.gladys.fake.connectionStatus.message.en, /refused the e-mail/);
  assert.equal(env.app.refused, undefined);
  await env.wait(4 * HOUR);
  // A read may send the list twice (a 401 on an older token: one login, one retry).
  const reads = cloud.requests
    .filter((r) => r.path === 'account/hubs')
    .map((r) => r.at)
    .filter((at, i, all) => i === 0 || at - all[i - 1] > SECOND);
  const gaps = reads.slice(1).map((at, i) => Math.round((at - reads[i]) / MINUTE));
  // Never sooner than the interval, doubled up to one hour.
  assert.ok(
    gaps.every((g) => g >= 5),
    `${gaps}`,
  );
  assert.ok(
    gaps.every((g, i) => i === 0 || g >= gaps[i - 1]),
    `${gaps}`,
  );
  assert.equal(gaps.at(-1), 60, `${gaps}`);
  // Logins never closer than 2 min, and never a "refused" stop.
  const logins = cloud.requests.filter((r) => r.path === 'account/token').map((r) => r.at);
  assert.ok(logins.slice(1).every((at, i) => at - logins[i] >= 2 * MINUTE));
  assert.match(env.gladys.fake.connectionStatus.message.en, /token refused by Rituals/);
  await env.app.stop();
});

test('a refused password stops everything, kept across a restart, lifted by a new password', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock });
  cloud.password = 'another one';
  const env = await setup({ clock, cloud, store });
  assert.equal(env.gladys.fake.connectionStatus.connected, false);
  assert.match(env.gladys.fake.connectionStatus.message.en, /refused the e-mail or the password/);
  assert.equal(cloud.count(LOGIN), 1);
  await env.wait(6 * HOUR);
  assert.equal(cloud.count(LOGIN), 1, 'never tried again by itself');
  // The marker: 8 bits of a salted hash, never the password nor its full hash.
  assert.ok(Number.isInteger(store.data.refused.tag) && store.data.refused.tag < 256);
  assert.doesNotMatch(JSON.stringify(store.data), /correct horse|another one|someone@example/);
  await env.app.stop();

  // A restart: still refused, no login at all.
  const again = await setup({ clock, cloud, store });
  await again.wait(HOUR);
  assert.equal(cloud.count(LOGIN), 1);
  assert.match(again.gladys.fake.connectionStatus.message.en, /refused/);
  // Turning off is refused clearly (nothing can be sent).
  const ack = await again.set(HUBLOT_A, 'power', 0);
  assert.equal(ack.success, false);
  assert.equal(cloud.count(LOGIN), 1);
  // The user fixes the password in the account and in Gladys.
  cloud.password = 'fixed';
  await again.gladys.fake.configUpdated({ ...CONFIG, password: 'fixed' });
  await again.wait(0);
  assert.equal(cloud.count(LOGIN), 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, undefined);
  await again.app.stop();
});

test('the test button tries a refused account once per click and lifts it on success', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock });
  cloud.password = 'changed in the app';
  const env = await setup({ clock, cloud });
  // Right after the refusal: not another login (30 s after a failed one).
  const soon = await env.gladys.fake.action('test_connection');
  assert.match(soon.data.message.en, /try again in/);
  assert.equal(cloud.count(LOGIN), 1);
  await env.wait(31 * SECOND);
  const no = await env.gladys.fake.action('test_connection');
  assert.match(no.data.message.en, /refused/);
  assert.equal(cloud.count(LOGIN), 2);
  // A second click right away: not another login (30 s after a failed one).
  await env.gladys.fake.action('test_connection');
  assert.equal(cloud.count(LOGIN), 2);
  cloud.password = PASSWORD;
  await env.wait(31 * SECOND);
  const yes = await env.gladys.fake.action('test_connection');
  assert.match(yes.data.message.en, /Connection succeeded: 1 diffuser/);
  assert.equal(env.app.refused, undefined);
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  await env.app.stop();
});

test('a lockout of Rituals is kept: no login before its end, even after a restart', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock });
  cloud.on = (r) =>
    r.path === 'account/token'
      ? {
          status: 200,
          body: { success: false, message: 'Too many login attempts. Try again in 1296 seconds.' },
        }
      : undefined;
  const env = await setup({ clock, cloud, store });
  assert.match(env.gladys.fake.connectionStatus.message.en, /locked the logins/);
  assert.equal(env.app.refused, undefined, 'a lockout is not a refused password');
  await env.app.stop();
  const again = await setup({ clock, cloud, store });
  await again.wait(20 * MINUTE);
  assert.equal(cloud.count(LOGIN), 1);
  cloud.on = undefined;
  await again.wait(2 * MINUTE);
  assert.equal(cloud.count(LOGIN), 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  await again.app.stop();
});

test('429: a pause from Retry-After, kept in /data across a restart; 5xx: doubled', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock });
  let answer = { status: 429, headers: { 'retry-after': '1800' }, body: { message: 'Slow down' } };
  cloud.on = (r) => (r.path === 'account/hubs' ? answer : undefined);
  const env = await setup({ clock, cloud, store });
  assert.match(env.gladys.fake.connectionStatus.message.en, /paused, next try in 30 min/);
  assert.equal(store.data.pause.code, 'rate_limited');
  await env.app.stop();
  const again = await setup({ clock, cloud, store });
  await again.wait(29 * MINUTE);
  assert.equal(cloud.count(LIST), 1, 'the restart keeps the pause');
  answer = { status: 503, body: {} };
  await again.wait(MINUTE);
  assert.equal(cloud.count(LIST), 2);
  // A 5xx: the pause doubles (2, 4, 8 min); reads never closer than the interval either.
  assert.equal(store.data.pause.code, 'server');
  assert.equal(store.data.pause.count, 2);
  const lengths = [];
  for (let i = 0; i < 2; i += 1) {
    const before = cloud.count(LIST);
    const until = store.data.pause.until;
    while (cloud.count(LIST) === before) await again.wait(10 * SECOND);
    lengths.push(Math.round((store.data.pause.until - until) / MINUTE));
  }
  assert.ok(store.data.pause.count === 4, `${store.data.pause.count}`);
  answer = undefined;
  await again.wait(9 * MINUTE);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.pause, undefined);
  await again.app.stop();
});

test('restart: the next read never comes sooner than the interval, wall clock set back or not', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock });
  const env = await setup({ clock, cloud, store });
  await env.app.stop();
  await env.wait(MINUTE);
  const again = await setup({ clock, cloud, store });
  assert.equal(cloud.count(LIST), 1);
  await again.wait(4 * MINUTE - SECOND);
  assert.equal(cloud.count(LIST), 1);
  await again.wait(2 * SECOND);
  assert.equal(cloud.count(LIST), 2);
  await again.app.stop();
  // The wall clock set back 3 h: the date kept is in the future, brought to now.
  clock.wall = -3 * HOUR;
  const third = await setup({ clock, cloud, store });
  await third.wait(5 * MINUTE - SECOND);
  assert.equal(cloud.count(LIST), 2);
  await third.wait(2 * SECOND);
  assert.equal(cloud.count(LIST), 3);
  // A wall clock jumping forward does not hurry the reads either.
  clock.wall = 5 * HOUR;
  await third.wait(4 * MINUTE);
  assert.equal(cloud.count(LIST), 3);
  await third.wait(MINUTE + SECOND);
  assert.equal(cloud.count(LIST), 4);
  await third.app.stop();
});

test('a reconnection, a save of the same form, Discovery: no read sooner, nothing stale republished', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  const states = env.gladys.fake.states.length;
  await env.wait(MINUTE);
  await env.gladys.disconnect();
  await env.gladys.connect();
  await env.wait(0);
  await env.gladys.fake.configUpdated({ ...CONFIG });
  await env.gladys.fake.scanRequest();
  await env.gladys.fake.action('test_connection');
  await env.wait(0);
  assert.equal(env.cloud.count(LIST), 1);
  assert.equal(env.gladys.fake.states.length, states, 'no state without a read');
  assert.equal(env.gladys.fake.discoveredDevices.length, 1, 'Discovery sent again');
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  // The next read sends the values again (Gladys may have lost them).
  await env.wait(4 * MINUTE);
  assert.equal(env.cloud.count(LIST), 2);
  assert.ok(env.gladys.fake.states.length > states);
  await env.app.stop();
});

test('device created long after the last read: no old value published as new', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock });
  cloud.on = (r) =>
    r.path === 'account/hubs' && cloud.requests.length > 6 ? { error: 'network' } : undefined;
  const env = await setup({ clock, cloud, timings: { retryMin: HOUR, retryMax: HOUR } });
  await env.wait(3 * HOUR);
  await env.create(HUBLOT_A);
  assert.equal(env.gladys.fake.states.length, 0);
  await env.app.stop();
});

test('getConfig failing at start: retried with a status, then started', async () => {
  const clock = testClock();
  const env = await setup({ clock, start: false });
  const original = env.gladys.getConfig.bind(env.gladys);
  let fail = true;
  let calls = 0;
  env.gladys.getConfig = async () => {
    // The first call is the SDK's own resynchronization; the app's fail.
    calls += 1;
    if (fail && calls > 1) throw new Error('Gladys busy');
    return original();
  };
  await env.connect();
  assert.match(env.gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  assert.equal(env.cloud.requests.length, 0);
  fail = false;
  await env.wait(15 * SECOND);
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  assert.equal(env.cloud.count(LIST), 1);
  await env.app.stop();
});

test('/data unreadable: never written over, nothing learnt from it', async () => {
  const store = createMemoryStore({ salt: 'f'.repeat(32), lastAttemptAt: 1 });
  store.failLoad = true;
  const env = await setup({ store });
  await env.wait(10 * MINUTE);
  assert.equal(store.saves, 0);
  assert.equal(store.data.salt, 'f'.repeat(32));
  assert.match(env.logger.lines.join('\n'), /\/data unreadable/);
  await env.app.stop();
});

test('missing e-mail: the password is never sent; invalid e-mail refused before any request', async () => {
  const env = await setup({ config: { password: PASSWORD } });
  assert.equal(env.cloud.requests.length, 0);
  assert.match(
    env.gladys.fake.connectionStatus.message.en,
    /e-mail of the Rituals account is missing/,
  );
  await env.gladys.fake.configUpdated({ email: 'a@b\nc', password: PASSWORD });
  await env.wait(0);
  assert.equal(env.cloud.requests.length, 0);
  assert.match(env.gladys.fake.connectionStatus.message.en, /not valid/);
  await env.app.stop();
});

test('secrets: neither the password, the e-mail nor the token in logs, /data or statuses', async () => {
  const store = createMemoryStore();
  const clock = testClock();
  const cloud = createCloud({ clock });
  const env = await setup({ clock, cloud, store, created: [HUBLOT_A] });
  await env.set(HUBLOT_A, 'power', 1);
  await env.set(HUBLOT_A, 'power', 0);
  cloud.tokens.clear();
  cloud.password = 'x';
  await env.wait(2 * HOUR);
  const token = [...cloud.requests]
    .map((r) => r.headers.Authorization)
    .filter(Boolean)
    .pop();
  const everything = [
    env.logger.lines.join('\n'),
    JSON.stringify(store.data),
    JSON.stringify(env.gladys.fake.connectionStatuses),
    JSON.stringify(env.gladys.fake.discoveredDevices),
  ].join('\n');
  for (const secret of [PASSWORD, 'someone@example.com', token]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 6)}…`);
  }
  await env.app.stop();
});

test('duplicates and wrong identifiers are left out; an unexpected answer stops nothing', async () => {
  const env = await setup({
    hubs: [
      hub(),
      hub({ hublot: HUBLOT_B, hash: HASH_A }),
      hub({ hublot: '../x', hash: HASH_B }),
      { ...hub({ hublot: 'LOT9', hash: 'c'.repeat(64) }), attributeValues: null },
      'nonsense',
    ],
  });
  assert.deepEqual(
    env.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [D('LOT9')],
  );
  env.cloud.on = (r) =>
    r.path === 'account/hubs' ? { status: 200, body: { not: 'a list' } } : undefined;
  await env.wait(5 * MINUTE);
  assert.equal(env.gladys.fake.connectionStatus.connected, false);
  env.cloud.on = undefined;
  await env.wait(5 * MINUTE);
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  await env.app.stop();
});

test('an offline diffuser: no state published, an unreachable badge', async () => {
  const env = await setup({ hubs: [hub({ status: 0, on: '1' })] });
  await env.create(HUBLOT_A);
  assert.equal(env.gladys.fake.states.length, 0);
  const badge = env.gladys.fake.transports.at(-1);
  assert.equal(badge.transport, 'unreachable');
  assert.equal(badge.degraded, true);
  await env.app.stop();
});

test('battery diffuser: battery and charging features and states', async () => {
  const env = await setup({ hubs: [hub({ battery: true })] });
  await env.create(HUBLOT_A);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'battery')), 100);
  assert.equal(env.gladys.fake.lastState(F(HUBLOT_A, 'charging')), 0);
  await env.app.stop();
});

test('a language change renames the features without a read', async () => {
  const env = await setup();
  await env.gladys.fake.configUpdated({ ...CONFIG, language: 'en' });
  await env.wait(0);
  assert.equal(env.gladys.fake.discoveredDevices[0].features[0].name, 'Diffusing');
  assert.equal(env.cloud.count(LIST), 1);
  await env.app.stop();
});

test('the poll interval of the form is bounded (2 min to 1 h)', async () => {
  const env = await setup({ config: { ...CONFIG, poll_interval: 5 } });
  await env.wait(2 * MINUTE - SECOND);
  assert.equal(env.cloud.count(LIST), 1);
  await env.wait(SECOND);
  assert.equal(env.cloud.count(LIST), 2);
  await env.app.stop();
});
