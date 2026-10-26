// -----------------------------------------------------------------------------
// The only network access: one HTTPS request per connection (no keep-alive,
// no pipelining), no redirect followed, the answer cut as soon as it grows
// beyond its limit, a deadline on the whole request. The request is written
// only once the connection is up: `beforeSend` runs at that instant, so the
// caller knows whether a command may have reached Rituals (`sent`) or surely
// did not (DNS, refused connection, TLS failure: nothing left).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { API_BASE, LIMITS } from '../constants.js';

/**
 * A failure of the Rituals cloud or of the way to it. `code` is one of
 * network, timeout, size, aborted (the transport); unauthorized, not_linked,
 * rate_limited, server, http, bad_response (an answer); refused, locked
 * (a login); and the app's own: login_wait, no_credentials.
 * `sent`: the request may have reached Rituals.
 */
export class RitualsError extends Error {
  constructor(code, { status, retryAfter, sent = false, detail } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RitualsError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.sent = sent;
    this.detail = detail;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The transport to the Rituals API. Plain HTTP is accepted on the loopback
 * only (the tests' local servers), never for the real API.
 */
export function httpTransport({ base = API_BASE } = {}) {
  const root = new URL(base);
  if (root.protocol !== 'https:' && !(root.protocol === 'http:' && LOOPBACK.has(root.hostname))) {
    throw new Error('The Rituals API is only reached over HTTPS');
  }
  const lib = root.protocol === 'https:' ? https : http;
  // No socket cap: a turn off never waits for a socket behind reads or commands
  // (still one request per connection).
  const agent = new lib.Agent({ keepAlive: false });

  /**
   * `{ method, path, headers, json, timeout, maxBytes, signal, beforeSend, onActivity }`
   * -> `{ status, headers, body: Buffer }`; throws a RitualsError.
   */
  return function transport({
    method = 'GET',
    path,
    headers = {},
    json,
    timeout,
    maxBytes = LIMITS.body,
    signal,
    beforeSend,
    onActivity,
  }) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, root);
      if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
        reject(new RitualsError('bad_request'));
        return;
      }
      const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json), 'utf8');
      let sent = false;
      let settled = false;
      let timer;
      const req = lib.request(url, {
        method,
        agent,
        headers: {
          ...headers,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
        },
      });
      const done = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (code, extra = {}) => {
        if (settled) return;
        done();
        req.destroy();
        reject(new RitualsError(code, { sent, ...extra }));
      };
      function onAbort() {
        fail('aborted');
      }
      if (signal?.aborted) {
        fail('aborted');
        return;
      }
      signal?.addEventListener('abort', onAbort);
      timer = setTimeout(() => fail('timeout'), Math.max(1, timeout));
      const go = () => {
        if (settled || sent) return;
        try {
          beforeSend?.();
        } catch (err) {
          fail('aborted', { detail: err.message });
          return;
        }
        sent = true;
        onActivity?.();
        req.end(payload);
      };
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          go();
          return;
        }
        socket.once(lib === https ? 'secureConnect' : 'connect', go);
      });
      req.on('error', () => fail('network'));
      req.on('response', (res) => {
        onActivity?.();
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          fail('size', { status: res.statusCode });
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            fail('size', { status: res.statusCode });
            return;
          }
          onActivity?.();
          chunks.push(chunk);
        });
        res.on('error', () => fail('network'));
        res.on('aborted', () => fail('network'));
        res.on('end', () => {
          if (settled) return;
          done();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      });
    });
  };
}
