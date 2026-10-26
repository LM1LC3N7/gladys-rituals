// -----------------------------------------------------------------------------
// The scenarios of review r2: a token revoked after the list accepted it, a
// 429 with a long Retry-After on a turn off, repeated turns off of one
// diffuser, a quick read of an unanswered turn off during a pause, and the
// login spacing of commands, the pace kept at a restart, the refusal message.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { CONFIG, MINUTE, SECOND, setup } from './helpers/app.js';
import { testClock } from './helpers/clock.js';
import { HASH_A, HUBLOT_A, createCloud } from './helpers/fakeRituals.js';

const POST_OFF = (r) => r.method === 'POST' && r.json?.fanc === '0';
const LOGIN = 'POST account/token';
const READ_A = `GET account/hubs/${HASH_A}`;

test('R1: a token revoked after the list accepted it: the turn off logs in again and leaves (12 min)', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.tokens.clear();
  await env.wait(10 * SECOND);
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, true);
  assert.equal(env.cloud.count(LOGIN), 2);
  await env.wait(12 * MINUTE);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  assert.equal(env.app.offs.size, 0);
  await env.app.stop();
});

test('R1: a diffuser refusing every token: one forced login per token, 3 sends counted, then given up', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) =>
    r.path.includes(HASH_A) ? { status: 401, body: { message: 'Unauthorized' } } : undefined;
  await env.set(HUBLOT_A, 'power', 0);
  await env.wait(12 * MINUTE);
  assert.ok(env.cloud.count(LOGIN) <= 3, `${env.cloud.count(LOGIN)} logins`);
  assert.equal(env.app.offs.size, 0, 'given up after 3 sends refused on a validated token');
  assert.ok(env.cloud.requests.filter(POST_OFF).length <= 8);
  await env.app.stop();
});

test('R2: a 429 with Retry-After 1 h on a turn off: no request to it before the end', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) =>
    POST_OFF(r) || `${r.method} ${r.path}` === READ_A
      ? { status: 429, headers: { 'retry-after': '3600' }, body: {} }
      : undefined;
  await env.set(HUBLOT_A, 'power', 0);
  await env.wait(30 * MINUTE + SECOND);
  await env.wait(MINUTE);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 1);
  assert.equal(env.cloud.count(READ_A), 0);
  assert.equal(env.app.offs.size, 0, 'given up at its 30 min end');
  await env.app.stop();
});

test('R2: a 429 with Retry-After 2 min on a turn off: sent again once it ends', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  let first = true;
  env.cloud.on = (r) => {
    if (POST_OFF(r) && first) {
      first = false;
      return { status: 429, headers: { 'retry-after': '120' }, body: {} };
    }
    return undefined;
  };
  await env.set(HUBLOT_A, 'power', 0);
  await env.wait(MINUTE);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 1);
  await env.wait(2 * MINUTE);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 2);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('m1: thirty turns off of one diffuser in a row join the one on its way', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  let release;
  env.cloud.on = (r) =>
    POST_OFF(r) && !release
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const acks = [];
  for (let i = 0; i < 30; i += 1) {
    acks.push(env.set(HUBLOT_A, 'power', 0));
    await env.clock.advance(0);
  }
  release(undefined);
  const results = await Promise.all(acks);
  assert.ok(results.every((a) => a.success));
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 1);
  await env.app.stop();
});

test('m2: during a pause, an unanswered turn off is read back alone; a later turn on from the app stays', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) => {
    if (r.path === 'account/hubs')
      return { status: 429, headers: { 'retry-after': '3600' }, body: {} };
    if (!POST_OFF(r)) return undefined;
    env.cloud.hubs[0].attributeValues.fanc = '0';
    return { error: 'timeout', sent: true };
  };
  await env.wait(5 * MINUTE);
  assert.ok(env.app.pause);
  await env.set(HUBLOT_A, 'power', 0);
  await env.wait(5 * SECOND);
  assert.equal(env.app.offs.size, 0, 'confirmed by the read of this diffuser');
  await env.wait(25 * SECOND);
  env.cloud.hubs[0].attributeValues.fanc = '1';
  await env.wait(3 * MINUTE);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 1);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '1');
  await env.app.stop();
});

test('m4: a turn on needing a login within 2 min of the last one: nothing sent, no login', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.app.session.client.forgetToken();
  const ack = await env.set(HUBLOT_A, 'power', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Rien envoyé : connexion espacée/);
  assert.equal(env.cloud.count(LOGIN), 1);
  await env.app.stop();
});

test('m4: the time of every read is in /data: a restart 30 s after a read waits the interval', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock });
  const config = { ...CONFIG, poll_interval: 120 };
  const env = await setup({ clock, cloud, store, config });
  await env.wait(2 * MINUTE);
  assert.equal(cloud.count('GET account/hubs'), 2);
  await env.wait(30 * SECOND);
  // A crash: nothing written at the stop, only what each read wrote before it.
  store.failSave = true;
  await env.app.stop();
  store.failSave = false;
  const again = await setup({ clock, cloud, store, config });
  await again.wait(90 * SECOND - SECOND);
  assert.equal(cloud.count('GET account/hubs'), 2);
  await again.wait(2 * SECOND);
  assert.equal(cloud.count('GET account/hubs'), 3);
  await again.app.stop();
});

test('m4: a turn off whose login is refused says exactly why', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.app.session.client.forgetToken();
  env.cloud.password = 'changed';
  const off = await env.set(HUBLOT_A, 'power', 0);
  assert.equal(off.success, false);
  assert.match(off.error, /Rien envoyé : e-mail ou mot de passe refusé/);
  await env.app.stop();
});
