// -----------------------------------------------------------------------------
// The scenarios of review r1: turns off kept until they really leave, kept
// at start, before the configuration, never resent against a later turn on;
// a 401 of one diffuser, a 400 of the login and a refusal of a replaced
// login never stop the account.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagOf } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { CONFIG, MINUTE, SECOND, setup } from './helpers/app.js';
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

const POST_OFF = (r) => r.method === 'POST' && r.json?.fanc === '0';
const LOGIN = 'POST account/token';

test('B1: network down 3.5 min: the turn off is kept and leaves once it is back', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) => (r.method === 'POST' ? { error: 'network', sent: false } : undefined);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, false);
  assert.match(off.error, /gardée/);
  await env.wait(3.5 * MINUTE);
  assert.equal(env.app.offs.get(HUBLOT_A)?.tries, 0, 'no try counted: nothing left');
  env.cloud.on = undefined;
  await env.wait(MINUTE);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  assert.equal(env.app.offs.size, 0);
  await env.app.stop();
});

test('B1: logins locked 10 min with no token: kept, sent when the lock ends', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.app.session.client.forgetToken();
  env.app.setLock(600);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.match(off.error, /gardée/);
  await env.wait(9 * MINUTE);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 0);
  assert.ok(env.app.offs.has(HUBLOT_A));
  await env.wait(2 * MINUTE);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('B2: a kept turn off failing at start is sent again', async () => {
  const clock = testClock();
  const store = createMemoryStore({
    hubs: { [HUBLOT_A]: { hash: HASH_A } },
    offs: { [HUBLOT_A]: { hash: HASH_A, at: clock.now() - SECOND, tries: 0 } },
  });
  const cloud = createCloud({ clock, hubs: [hub({ on: '1' })] });
  cloud.on = (r) => (r.method === 'POST' ? { error: 'network', sent: false } : undefined);
  const env = await setup({ clock, cloud, store });
  assert.equal(cloud.hubs[0].attributeValues.fanc, '1');
  cloud.on = undefined;
  await env.wait(MINUTE);
  assert.equal(cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('I6: a turn off clicked before the configuration is read: kept, sent once it is', async () => {
  const clock = testClock();
  const store = createMemoryStore({ hubs: { [HUBLOT_A]: { hash: HASH_A } } });
  const cloud = createCloud({ clock, hubs: [hub({ on: '1' })] });
  const env = await setup({ clock, cloud, store, start: false });
  const original = env.gladys.getConfig.bind(env.gladys);
  let calls = 0;
  let fail = true;
  env.gladys.getConfig = async () => {
    calls += 1;
    if (fail && calls > 1) throw new Error('busy');
    return original();
  };
  await env.connect();
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, false);
  assert.match(off.error, /dès la lecture de la configuration/);
  assert.ok(store.data.offs[HUBLOT_A]);
  fail = false;
  await env.wait(15 * SECOND);
  const order = cloud.requests.map((r) => `${r.method} ${r.path}`);
  assert.equal(order[1], `POST hubs/${HASH_A}/attributes/fanc`);
  assert.equal(cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('I5: a turn off sent without an answer is read back quickly, never resent against a later turn on', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) => {
    if (!POST_OFF(r)) return undefined;
    env.cloud.hubs[0].attributeValues.fanc = '0';
    return { error: 'timeout', sent: true };
  };
  await env.set(HUBLOT_A, 'power', 0);
  await env.wait(5 * SECOND);
  assert.equal(env.app.offs.size, 0, 'confirmed by the follow-up read');
  // Turned on again from the Rituals app 30 s later.
  await env.wait(25 * SECOND);
  env.cloud.hubs[0].attributeValues.fanc = '1';
  await env.wait(3 * MINUTE);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 1);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '1');
  await env.app.stop();
});

test('I1: a diffuser answering 401 to its commands costs no login, keeps the token, the others work', async () => {
  const env = await setup({
    hubs: [hub(), hub({ hublot: HUBLOT_B, hash: HASH_B, on: '1' })],
    created: [HUBLOT_A, HUBLOT_B],
  });
  env.cloud.on = (r) =>
    r.method === 'POST' && r.path.includes(HASH_A)
      ? { status: 401, body: { message: 'Unauthorized' } }
      : undefined;
  for (let i = 0; i < 10; i += 1) {
    const ack = await env.set(HUBLOT_A, 'intensity', 1 + (i % 3));
    assert.equal(ack.success, false);
    await env.wait(30 * SECOND);
  }
  assert.equal(env.cloud.count(LOGIN), 1);
  const off = await env.set(HUBLOT_B, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(env.cloud.hubs[1].attributeValues.fanc, '0');
  await env.app.stop();
});

test('I2: a 400 of the login is no refused password', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock });
  cloud.on = (r) =>
    r.path === 'account/token'
      ? { status: 400, body: { message: 'Missing field "app"' } }
      : undefined;
  const store = createMemoryStore();
  const env = await setup({ clock, cloud, store });
  assert.equal(env.app.refused, undefined);
  assert.equal(store.data.refused, undefined);
  assert.doesNotMatch(env.gladys.fake.connectionStatus.message.en, /refused the e-mail/);
  cloud.on = undefined;
  await env.wait(10 * MINUTE);
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  await env.app.stop();
});

test('I3: the refusal of a login still running is not pinned on the new password', async () => {
  const clock = testClock();
  const cloud = createCloud({ clock });
  cloud.password = 'the good one';
  let release;
  cloud.on = (r) =>
    r.path === 'account/token' && r.json.password === PASSWORD
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const env = await setup({ clock, cloud, start: false });
  const connecting = env.connect();
  await clock.advance(0);
  await env.gladys.fake.configUpdated({ ...CONFIG, password: 'the good one' });
  release(undefined);
  await connecting;
  await env.wait(0);
  assert.equal(env.app.refused, undefined);
  await env.wait(5 * MINUTE);
  assert.equal(env.gladys.fake.connectionStatus.connected, true);
  await env.app.stop();
});

test('m6: the 8-bit marker cannot single out the refused password (brute force)', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  const marker = tagOf(salt, 'my secret');
  let same = 0;
  for (let i = 0; i < 5000; i += 1) if (tagOf(salt, `candidate ${i}`) === marker) same += 1;
  assert.ok(same >= 5, `${same} candidates share the marker`);
});

test('m7: a turn off cancels a command whose login is still running (checked in beforeSend)', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.app.session.client.forgetToken();
  env.cloud.tokens.clear();
  await env.wait(2 * MINUTE);
  let release;
  env.cloud.on = (r) =>
    r.path === 'account/token' && !release
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const on = env.set(HUBLOT_A, 'power', 1);
  await env.clock.advance(0);
  assert.ok(release, 'the turn on waits for its login');
  env.app.target(HUBLOT_A).offSeq = env.app.seq + 1;
  release(undefined);
  const ack = await on;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Annulée/);
  assert.equal(env.cloud.requests.filter((r) => r.json?.fanc === '1').length, 0);
  await env.app.stop();
});

test('m7: a read started before the turn off never confirms it', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  let release;
  env.cloud.on = (r) => {
    if (r.path === 'account/hubs' && !release) {
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    // Taken by the cloud, not applied: the diffuser stays on.
    if (POST_OFF(r)) return { status: 200, body: {} };
    return undefined;
  };
  await env.clock.advance(5 * MINUTE);
  assert.ok(release);
  await env.set(HUBLOT_A, 'power', 0);
  // The old read answers with a list where it was off (before a turn on).
  release({ status: 200, body: [hub({ on: '0' })] });
  await env.wait(0);
  assert.ok(env.app.offs.has(HUBLOT_A), 'still to confirm');
  await env.app.stop();
});

test('m7: automatic logins at least 2 min apart', async () => {
  const env = await setup();
  await assert.rejects(env.app.mayLogin('auto'), /login_wait/);
  await env.wait(2 * MINUTE);
  await env.app.mayLogin('auto');
  await env.app.stop();
});
