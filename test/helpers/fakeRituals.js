// -----------------------------------------------------------------------------
// A fake Rituals cloud behind the transport of src/rituals/http.js: the
// account (one e-mail and password), the tokens (JWTs dated with the clock of
// the test), the diffusers and their sensors, shaped after the recorded
// answers of ritualsgenie. `cloud.on(request)` may answer instead:
//   { status, body, headers } | { error: code, sent } | 'hang' | a Promise.
// Every request is recorded in `cloud.requests` (the headers included).
// -----------------------------------------------------------------------------

import { RitualsError } from '../../src/rituals/http.js';

export const EMAIL = 'someone@example.com';
export const PASSWORD = 'correct horse battery staple';
export const HUBLOT_A = 'LOT000-00-00000-00001';
export const HUBLOT_B = 'LOT000-00-00000-00002';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

export function hub({
  hublot = HUBLOT_A,
  hash = HASH_A,
  name = 'Salon',
  on = '0',
  speed = '2',
  status = 1,
  battery = false,
} = {}) {
  return {
    hublot,
    hash,
    status,
    attributes: { roomc: true, speedc: true, fanc: true, roomnamec: true, ledc: true },
    attributeValues: { roomc: '2', speedc: speed, fanc: on, roomnamec: name, ledc: '0' },
    firmwareInfo: { currentFirmware: '5.4', currentFirmwareId: 127 },
    deviceFlowVersion: 2,
    sensors: { wific: true, battc: battery, fillc: true, rfidc: true, versionc: true },
  };
}

export const SENSORS = {
  wific: { title: 'Medium', icon: 'icon-signal-75.png', raw: '-80' },
  fillc: { title: '70-80%', icon: 'icon-fill.png', raw: '5818' },
  rfidc: { title: 'The Ritual of Sakura', scentFound: true, raw: '05377650' },
  battc: { title: 'Full', icon: 'battery-full.png' },
};

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

export function createCloud({ clock, hubs = [hub()], tokenLife = 3600, date = true } = {}) {
  const cloud = {
    email: EMAIL,
    password: PASSWORD,
    hubs: hubs.map((h) => structuredClone(h)),
    sensors: structuredClone(SENSORS),
    tokens: new Set(),
    tokenLife,
    /** false: no Date header (the expiry cannot be compared). */
    date,
    /** ms before a write shows in the list (a cloud that applies late). */
    applyDelay: 0,
    requests: [],
    on: undefined,
    issued: 0,
    hangs: [],
    count(match) {
      return cloud.requests.filter((r) =>
        match instanceof RegExp
          ? match.test(`${r.method} ${r.path}`)
          : `${r.method} ${r.path}` === match,
      ).length;
    },
    hubOf(hash) {
      return cloud.hubs.find((h) => h.hash === hash);
    },
    dateHeader() {
      return cloud.date ? { date: new Date(clock.now()).toUTCString() } : {};
    },
    token() {
      cloud.issued += 1;
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(clock.now() / 1000) + cloud.tokenLife, n: cloud.issued }),
      ).toString('base64url');
      const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig${cloud.issued}`;
      cloud.tokens.add(token);
      return token;
    },
    answer(request) {
      const { method, path, json: body, headers } = request;
      if (method === 'POST' && path === 'account/token') {
        if (body?.email === cloud.email && body?.password === cloud.password) {
          return json(200, { success: cloud.token() }, cloud.dateHeader());
        }
        return json(200, { success: false, message: 'Invalid email or password' });
      }
      if (!cloud.tokens.has(headers.Authorization)) {
        return json(401, { code: 401, message: 'Unauthorized' });
      }
      if (method === 'GET' && path === 'account/hubs') return json(200, cloud.hubs);
      let match = /^account\/hubs\/([A-Za-z0-9]+)$/.exec(path);
      if (method === 'GET' && match) {
        const h = cloud.hubOf(match[1]);
        return h ? json(200, h) : json(404, { message: 'Not found' });
      }
      match = /^hubs\/([A-Za-z0-9]+)\/sensors\/(\w+)$/.exec(path);
      if (method === 'GET' && match) {
        const h = cloud.hubOf(match[1]);
        if (!h) return json(401, { message: "This hub is not linked to the user's account" });
        return json(200, cloud.sensors[match[2]] ?? {});
      }
      match = /^hubs\/([A-Za-z0-9]+)\/attributes\/(\w+)$/.exec(path);
      if (method === 'POST' && match) {
        const h = cloud.hubOf(match[1]);
        if (!h) return json(401, { message: "This hub is not linked to the user's account" });
        const value = body?.[match[2]];
        const apply = () => {
          h.attributeValues[match[2]] = value;
        };
        if (cloud.applyDelay > 0) clock.timers.setTimeout(apply, cloud.applyDelay);
        else apply();
        return json(200, { [match[2]]: value });
      }
      return json(404, { message: 'Not found' });
    },
    async transport(options) {
      const request = {
        method: options.method ?? 'GET',
        path: options.path,
        json: options.json,
        headers: options.headers,
        timeout: options.timeout,
        at: clock.elapsed,
      };
      if (options.signal?.aborted) throw new RitualsError('aborted');
      // Nothing leaves before beforeSend (as in http.js): it may cancel.
      try {
        options.beforeSend?.();
      } catch {
        throw new RitualsError('aborted');
      }
      cloud.requests.push(request);
      let answer = cloud.on?.(request);
      if (answer === 'hang') {
        answer = new Promise((resolve, reject) => {
          cloud.hangs.push({ resolve, reject, request });
          options.signal?.addEventListener('abort', () =>
            reject(new RitualsError('aborted', { sent: true })),
          );
        });
      }
      answer = await answer;
      if (answer?.error) throw new RitualsError(answer.error, { sent: answer.sent ?? false });
      if (answer?.status) {
        return {
          status: answer.status,
          headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
          body: Buffer.from(
            typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}),
          ),
        };
      }
      options.onActivity?.();
      return cloud.answer(request);
    },
  };
  cloud.transport = cloud.transport.bind(cloud);
  return cloud;
}
