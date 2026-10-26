// -----------------------------------------------------------------------------
// The scenarios of review r3: a turn off joins the one on its way only when no
// other command of the diffuser left since; a 401 on a token not validated
// again is no send; a Retry-After of a turn off survives a restart.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { MINUTE, SECOND, setup } from './helpers/app.js';
import { testClock } from './helpers/clock.js';
import { HUBLOT_A, createCloud, hub } from './helpers/fakeRituals.js';

const POST_OFF = (r) => r.method === 'POST' && r.json?.fanc === '0';
const POST_ON = (r) => r.method === 'POST' && r.json?.fanc === '1';

function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  return { promise, open };
}

test('B: off, on, off (0 / 650 / 700 ms): the last click wins, the diffuser ends off', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  const firstOff = gate();
  const on = gate();
  let offs = 0;
  env.cloud.on = (r) => {
    if (POST_OFF(r) && (offs += 1) === 1) return firstOff.promise;
    if (POST_ON(r)) return on.promise;
    return undefined;
  };
  const a = env.set(HUBLOT_A, 'power', 0);
  await env.clock.advance(650);
  const b = env.set(HUBLOT_A, 'power', 1);
  await env.clock.advance(50);
  const c = env.set(HUBLOT_A, 'power', 0);
  await env.clock.advance(0);
  // The first turn off lands, then the turn on.
  firstOff.open();
  await env.clock.advance(0);
  on.open();
  const acks = await Promise.all([a, b, c]);
  await env.wait(0);
  assert.ok(
    acks.every((x) => x.success),
    JSON.stringify(acks),
  );
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  assert.deepEqual(
    env.cloud.requests.filter((r) => r.path.endsWith('/fanc')).map((r) => r.json.fanc),
    ['0', '1', '0', '0'],
  );
  await env.wait(2 * MINUTE);
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('a joined turn off is confirmed only by a read started after the last click', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  const held = gate();
  let first = true;
  env.cloud.on = (r) => {
    if (POST_OFF(r) && first) {
      first = false;
      return held.promise;
    }
    return undefined;
  };
  const a = env.set(HUBLOT_A, 'power', 0);
  await env.clock.advance(100);
  const b = env.set(HUBLOT_A, 'power', 0);
  await env.clock.advance(0);
  held.open();
  await Promise.all([a, b]);
  assert.equal(env.cloud.requests.filter(POST_OFF).length, 1, 'joined: one POST');
  assert.equal(env.cloud.hubs[0].attributeValues.fanc, '0');
  await env.app.stop();
});

test('a 401 on a token not validated again is not a send', async () => {
  const env = await setup({ created: [HUBLOT_A] });
  env.cloud.hubs[0].attributeValues.fanc = '1';
  env.cloud.on = (r) => {
    if (!POST_OFF(r)) return undefined;
    // Another login replaced the token meanwhile: this 401 says nothing of it.
    env.app.session.client.token = 'replaced';
    return { status: 401, body: { message: 'Unauthorized' } };
  };
  await env.set(HUBLOT_A, 'power', 0);
  assert.equal(env.app.offs.get(HUBLOT_A).tries, 0);
  await env.app.stop();
});

test('the Retry-After of a turn off is kept in /data: a restart does not send it sooner', async () => {
  const clock = testClock();
  const store = createMemoryStore();
  const cloud = createCloud({ clock, hubs: [hub({ on: '1' })] });
  const env = await setup({ clock, cloud, store, created: [HUBLOT_A] });
  cloud.on = (r) =>
    POST_OFF(r) ? { status: 429, headers: { 'retry-after': '600' }, body: {} } : undefined;
  await env.set(HUBLOT_A, 'power', 0);
  await env.app.stop();
  cloud.on = undefined;
  await clock.advance(SECOND);
  const again = await setup({ clock, cloud, store });
  assert.equal(cloud.requests.filter(POST_OFF).length, 1, 'not at the restart');
  await again.wait(8 * MINUTE);
  assert.equal(cloud.requests.filter(POST_OFF).length, 1);
  await again.wait(3 * MINUTE);
  assert.equal(cloud.requests.filter(POST_OFF).length, 2);
  assert.equal(cloud.hubs[0].attributeValues.fanc, '0');
  await again.app.stop();
});
