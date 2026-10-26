// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, and a real local HTTP server playing the Rituals cloud through
// the real transport: the list is read at once, then once per interval (the
// gaps measured by the server), with a bounded number of timers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RitualsApp } from '../src/app.js';
import { httpTransport } from '../src/rituals/http.js';
import { createMemoryStore } from '../src/store.js';
import { EMAIL, PASSWORD, SENSORS, hub } from './helpers/fakeRituals.js';

const SPEED = 20;
const INTERVAL = 120_000;

test(
  'real clock (x20): the list at once, then every interval, never sooner',
  { timeout: 30_000 },
  async () => {
    const reads = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status, value) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            date: new Date().toUTCString(),
          });
          res.end(JSON.stringify(value));
        };
        if (req.url === '/apiv2/account/token') {
          const { email, password } = JSON.parse(body);
          return send(200, {
            success: email === EMAIL && password === PASSWORD ? 'h.e30.s' : false,
          });
        }
        if (req.headers.authorization !== 'h.e30.s') return send(401, { message: 'Unauthorized' });
        if (req.url === '/apiv2/account/hubs') {
          reads.push(performance.now() * SPEED);
          return send(200, [hub()]);
        }
        const sensor = /sensors\/(\w+)$/.exec(req.url)?.[1];
        return send(200, SENSORS[sensor] ?? {});
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let timersSet = 0;
    const timers = {
      setTimeout(fn, ms) {
        timersSet += 1;
        return setTimeout(fn, Math.max(0, ms) / SPEED);
      },
      clearTimeout: (id) => clearTimeout(id),
    };
    const gladys = createFakeGladys({ selector: 'rituals' });
    await gladys.connect();
    const quiet = () => {};
    const app = new RitualsApp({
      gladys,
      logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
      now: () => Date.now() * SPEED,
      monotonic: () => performance.now() * SPEED,
      timers,
      store: createMemoryStore(),
      transport: httpTransport({ base: `http://127.0.0.1:${server.address().port}/apiv2/` }),
    });
    const started = performance.now() * SPEED;
    try {
      await app.start({ email: EMAIL, password: PASSWORD, poll_interval: INTERVAL / 1000 });
      const until = started + 2.5 * INTERVAL;
      while (performance.now() * SPEED < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await app.stop();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    const at = reads.map((t) => Math.round(t - started));
    assert.equal(reads.length, 3, `reads at ${at}`);
    assert.ok(reads[0] - started < INTERVAL / 4, `the first read at once: ${at}`);
    for (let i = 1; i < reads.length; i += 1) {
      const gap = reads[i] - reads[i - 1];
      assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
      assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
    }
    assert.ok(timersSet <= 10, `${timersSet} timers`);
    assert.equal(gladys.fake.connectionStatus.connected, true);
  },
);
