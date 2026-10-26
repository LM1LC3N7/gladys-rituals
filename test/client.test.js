// -----------------------------------------------------------------------------
// The network layer on real local servers (size cut, deadline, "sent" or not,
// no redirect, HTTPS only for a remote host) and the account client (login
// answers, lockout, token expiry from the Date header, 401 handling).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { RitualsClient, lockoutSeconds, tokenExpiry } from '../src/rituals/client.js';
import { RitualsError, httpTransport } from '../src/rituals/http.js';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/apiv2/`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const rejects = async (promise, code, sent) => {
  const err = await promise.then(
    () => assert.fail('resolved'),
    (e) => e,
  );
  assert.ok(err instanceof RitualsError, String(err));
  assert.equal(err.code, code);
  if (sent !== undefined) assert.equal(err.sent, sent);
  return err;
};

test('an oversized answer is cut before it is read whole (declared or streamed)', async () => {
  let streamed = 0;
  const srv = await serve((req, res) => {
    if (req.url.endsWith('declared')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 10_000_000 });
      res.write('[');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const pump = () => {
      while (!closed && streamed < 4_000_000) {
        streamed += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
  const transport = httpTransport({ base: srv.base });
  await rejects(transport({ path: 'declared', timeout: 2000 }), 'size', true);
  await rejects(transport({ path: 'streamed', timeout: 2000 }), 'size', true);
  await srv.close();
});

test('a silent server: timeout, after the request left (sent)', async () => {
  const srv = await serve(() => {});
  const transport = httpTransport({ base: srv.base });
  let before = 0;
  await rejects(
    transport({ path: 'x', timeout: 150, beforeSend: () => (before += 1) }),
    'timeout',
    true,
  );
  assert.equal(before, 1);
  await srv.close();
});

test('a refused connection: nothing sent, beforeSend never called', async () => {
  const probe = createNet();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const transport = httpTransport({ base: `http://127.0.0.1:${port}/apiv2/` });
  let before = 0;
  await rejects(
    transport({ path: 'x', timeout: 1000, beforeSend: () => (before += 1) }),
    'network',
    false,
  );
  assert.equal(before, 0);
});

test('a redirect is never followed; the path cannot leave the API', async () => {
  const seen = [];
  const srv = await serve((req, res) => {
    seen.push(req.url);
    res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end();
  });
  const transport = httpTransport({ base: srv.base });
  const answer = await transport({
    path: 'account/token',
    method: 'POST',
    json: { a: 1 },
    timeout: 1000,
  });
  assert.equal(answer.status, 302);
  assert.deepEqual(seen, ['/apiv2/account/token']);
  await rejects(transport({ path: 'http://evil.example/x', timeout: 1000 }), 'bad_request');
  await rejects(transport({ path: '../other', timeout: 1000 }), 'bad_request');
  await srv.close();
  assert.throws(() => httpTransport({ base: 'http://rituals.example.com/apiv2/' }), /HTTPS/);
});

test('an abort cuts a request in flight', async () => {
  const srv = await serve(() => {});
  const transport = httpTransport({ base: srv.base });
  const controller = new AbortController();
  const pending = transport({ path: 'x', timeout: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await rejects(pending, 'aborted');
  await srv.close();
});

// --- The account client -------------------------------------------------------

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

function scripted(answers) {
  const calls = [];
  const transport = async (options) => {
    calls.push(options);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
      body: Buffer.from(typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  return { calls, transport };
}

const client = (transport, mono = { t: 0 }) =>
  new RitualsClient({
    email: 'a@b.c',
    password: 'p',
    transport,
    monotonic: () => (mono.t += 0.001),
  });

test('login answers: token, refused (success false or 400/401/422), lockout, anything else', async () => {
  const date = 'Mon, 26 Oct 2026 10:00:00 GMT';
  const exp = Date.parse(date) / 1000 + 3600;
  for (const [answer, code] of [
    [{ body: { success: false, message: 'Wrong password' } }, 'refused'],
    [{ status: 401, body: { message: 'Invalid' } }, 'refused'],
    [{ status: 422, body: {} }, 'refused'],
    [
      { body: { success: false, message: 'Too many login attempts. Try again in 1296 seconds.' } },
      'locked',
    ],
    [{ status: 403, body: {} }, 'http'],
    [{ status: 404, body: {} }, 'http'],
    [{ status: 429, headers: { 'retry-after': '60' }, body: {} }, 'rate_limited'],
    [{ status: 503, body: {} }, 'server'],
    [{ body: { success: 'bad\r\ntoken' } }, 'bad_response'],
    [{ body: 'not json' }, 'bad_response'],
    [{ body: { something: 'else' } }, 'bad_response'],
  ]) {
    const { transport } = scripted([answer]);
    const err = await rejects(client(transport).login(), code);
    if (code === 'locked') assert.equal(err.retryAfter, 1296);
  }
  const mono = { t: 0 };
  const { transport, calls } = scripted([{ headers: { date }, body: { success: jwt(exp) } }]);
  const c = client(transport, mono);
  await c.login();
  assert.equal(calls[0].path, 'account/token');
  assert.deepEqual(calls[0].json, { email: 'a@b.c', password: 'p' });
  assert.ok(Math.abs(c.tokenDue - (3600_000 - 60_000)) < 10, `${c.tokenDue}`);
  assert.equal(c.hasToken(3_530_000), true);
  assert.equal(c.hasToken(3_541_000), false);
});

test('expiry unknown (no Date, no exp): the token is kept until refused', async () => {
  const { transport } = scripted([{ body: { success: 'opaque-token' } }]);
  const c = client(transport);
  await c.login();
  assert.equal(c.tokenDue, undefined);
  assert.equal(c.hasToken(1e12), true);
  assert.equal(tokenExpiry('opaque'), undefined);
  assert.equal(lockoutSeconds('Too many login attempts. Try again in 12 seconds.'), 12);
  assert.equal(lockoutSeconds('Wrong password'), undefined);
});

test('401 on an older token: one login, one retry; on a fresh one: unauthorized; "not linked": not_linked', async () => {
  const ok = { body: { success: 'token-1' } };
  const ok2 = { body: { success: 'token-2' } };
  const unauthorized = { status: 401, body: { message: 'Unauthorized' } };
  const mayLogin = async () => {};
  // Fresh token refused at once: not retried, never "refused".
  let s = scripted([ok, unauthorized]);
  await rejects(client(s.transport).call('account/hubs', { mayLogin }), 'unauthorized');
  assert.equal(s.calls.length, 2);
  // An older token refused: a new login and a retry.
  s = scripted([ok, { body: [] }, unauthorized, ok2, { body: [1] }]);
  const c = client(s.transport);
  await c.call('account/hubs', { mayLogin });
  const answer = await c.call('account/hubs', { mayLogin });
  assert.deepEqual(answer, [1]);
  assert.equal(s.calls[4].headers.Authorization, 'token-2');
  // Not linked: no login.
  s = scripted([
    ok,
    { status: 401, body: { message: "This hub is not linked to the user's account" } },
  ]);
  await rejects(client(s.transport).call('hubs/x/sensors/wific', { mayLogin }), 'not_linked');
  // mayLogin refusing: no login request at all.
  s = scripted([]);
  await rejects(
    client(s.transport).call('account/hubs', {
      mayLogin: async () => {
        throw new RitualsError('login_wait');
      },
    }),
    'login_wait',
  );
  assert.equal(s.calls.length, 0);
});

test('one login at a time: concurrent calls share it', async () => {
  let release;
  const calls = [];
  const transport = (options) => {
    calls.push(options.path);
    if (options.path === 'account/token') {
      return new Promise((resolve) => {
        release = () =>
          resolve({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ success: 't' })),
          });
      });
    }
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('[]'),
    });
  };
  const c = client(transport);
  const both = Promise.all([
    c.call('account/hubs', { mayLogin: async () => {} }),
    c.call('account/hubs', { mayLogin: async () => {} }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await both;
  assert.equal(calls.filter((p) => p === 'account/token').length, 1);
});
