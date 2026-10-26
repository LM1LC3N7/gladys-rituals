// -----------------------------------------------------------------------------
// The Rituals account: the login (e-mail and password exchanged for a token,
// a JWT valid about an hour), the token kept in memory only, and the calls.
// Ported from ritualsgenie (MIT, see THIRD_PARTY_NOTICES.md): the endpoints,
// the token sent as is in `Authorization` (no "Bearer"), a refused login read
// from `success: false` or a 400/401/422, the lockout message ("Too many
// login attempts. Try again in N seconds"), a 401 on a token just obtained or
// about a diffuser "not linked" that a new login would not cure, Retry-After.
//
// Changed here: the token expiry is compared with the Date header of Rituals
// (never with the clock of Gladys); without a readable Date or expiry, the
// token is used until Rituals refuses it. Whether a login may happen at all
// is the app's decision (`mayLogin`), taken before every login.
// -----------------------------------------------------------------------------

import { TIMINGS, USER_AGENT } from '../constants.js';
import { RitualsError } from './http.js';

const LOGIN_FAILURE_STATUSES = new Set([400, 401, 422]);
const NOT_TOKEN_RELATED = ['not linked', 'not your'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A message of Rituals, short and printable (never shown for a login). */
export function cleanMessage(value, max = 120) {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, max);
}

/** The "message" (or "error", or the string) of an error body. */
function errorMessage(body) {
  try {
    const data = JSON.parse(body.toString('utf8'));
    if (typeof data === 'string') return cleanMessage(data, 300);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return cleanMessage(data.message, 300) ?? cleanMessage(data.error, 300);
    }
  } catch {
    // Not JSON: no message.
  }
  return undefined;
}

/** The seconds of a lockout message, if it is one. */
export function lockoutSeconds(message) {
  const match = /too many login attempts[^0-9]{0,80}?(\d{1,7}) seconds/i.exec(message ?? '');
  return match ? Number(match[1]) : undefined;
}

/** Retry-After in seconds (digits only), undefined otherwise. */
function retryAfterOf(headers) {
  const value = headers?.['retry-after'];
  return typeof value === 'string' && /^\d{1,6}$/.test(value.trim())
    ? Number(value.trim())
    : undefined;
}

/** The expiry of a JWT (epoch ms), undefined when unreadable. Never checks the signature. */
export function tokenExpiry(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isSafeInteger(claims?.exp) && claims.exp > 0 ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

const validToken = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !CONTROL.test(value) &&
  !/\s/.test(value);

export class RitualsClient {
  /**
   * `transport` (http.js), `monotonic` (the clock of the decisions),
   * `onLogin({ ok, error })` (the app keeps the time of every attempt).
   */
  constructor({ email, password, transport, monotonic, onLogin = () => {} }) {
    this.email = email;
    this.password = password;
    this.transport = transport;
    this.monotonic = monotonic;
    this.onLogin = onLogin;
    this.token = undefined;
    /** Monotonic time from which the token is renewed; undefined: used until refused. */
    this.tokenDue = undefined;
    this.loginRun = undefined;
  }

  /** Whether a token is held and not due for renewal at `mono`. */
  hasToken(mono) {
    return this.token !== undefined && (this.tokenDue === undefined || mono < this.tokenDue);
  }

  forgetToken() {
    this.token = undefined;
    this.tokenDue = undefined;
  }

  /** One login at a time: a second caller joins the one running. */
  login(options = {}) {
    if (!this.loginRun) {
      this.loginRun = this.doLogin(options).finally(() => {
        this.loginRun = undefined;
      });
    }
    return this.loginRun;
  }

  async doLogin({ timeout = TIMINGS.readTimeout, signal } = {}) {
    let answer;
    try {
      answer = await this.transport({
        method: 'POST',
        path: 'account/token',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        json: { email: this.email, password: this.password },
        timeout,
        signal,
      });
    } catch (err) {
      this.onLogin({ ok: false, error: err });
      throw err;
    }
    try {
      const token = this.readLogin(answer);
      const expiry = tokenExpiry(token);
      const date = Date.parse(answer.headers?.date ?? '');
      const left = expiry !== undefined && Number.isFinite(date) ? expiry - date : undefined;
      this.token = token;
      this.tokenDue =
        left !== undefined && left > TIMINGS.tokenMargin
          ? this.monotonic() + left - TIMINGS.tokenMargin
          : undefined;
      this.onLogin({ ok: true });
      return token;
    } catch (err) {
      this.onLogin({ ok: false, error: err });
      throw err;
    }
  }

  /** The token of a login answer, or the RitualsError it means. */
  readLogin({ status, headers, body }) {
    const refusal = (message) => {
      const seconds = lockoutSeconds(message);
      return seconds === undefined
        ? new RitualsError('refused', { status, sent: true })
        : new RitualsError('locked', { status, retryAfter: seconds, sent: true });
    };
    if (LOGIN_FAILURE_STATUSES.has(status)) {
      throw refusal(errorMessage(body));
    }
    const failure = this.statusError(status, headers, body);
    if (failure) throw failure;
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      throw new RitualsError('bad_response', { status, sent: true });
    }
    if (data && typeof data === 'object' && validToken(data.success)) {
      return data.success;
    }
    // Only an explicit "success": false is a refused login.
    if (data && typeof data === 'object' && data.success === false) {
      throw refusal(cleanMessage(data.message, 300));
    }
    throw new RitualsError('bad_response', { status, sent: true });
  }

  /** The error of a non-2xx answer (401 excepted), undefined for a 2xx. */
  statusError(status, headers, body) {
    if (status === 429) {
      return new RitualsError('rate_limited', {
        status,
        retryAfter: retryAfterOf(headers),
        sent: true,
      });
    }
    if (status >= 500) {
      return new RitualsError('server', { status, retryAfter: retryAfterOf(headers), sent: true });
    }
    if (status < 200 || status >= 300) {
      return new RitualsError('http', { status, sent: true, detail: errorMessage(body) });
    }
    return undefined;
  }

  /**
   * One call with the token. `await mayLogin()` comes before any login and
   * throws when none may happen now. A 401 on an older token: one new login,
   * one retry. A 401 on a token just obtained, or about a diffuser not
   * linked: `unauthorized` / `not_linked`, never a refused password.
   */
  async call(path, { method = 'GET', json, timeout, signal, beforeSend, onActivity, mayLogin }) {
    // `timeout`: ms, or a function giving the ms left (a command shares one budget).
    const ms = () => (typeof timeout === 'function' ? Math.max(1, timeout()) : timeout);
    const send = (fresh) =>
      this.send(path, { method, json, timeout: ms(), signal, beforeSend, onActivity, fresh });
    let fresh = false;
    if (!this.hasToken(this.monotonic())) {
      await mayLogin();
      await this.login({ timeout: ms(), signal });
      fresh = true;
    }
    try {
      return await send(fresh);
    } catch (err) {
      if (!(err instanceof RitualsError) || err.code !== 'retry_login') throw err;
    }
    this.forgetToken();
    await mayLogin();
    await this.login({ timeout: ms(), signal });
    try {
      return await send(true);
    } catch (err) {
      if (err instanceof RitualsError && err.code === 'retry_login') {
        throw new RitualsError('unauthorized', { status: 401, sent: true });
      }
      throw err;
    }
  }

  async send(path, { method, json, timeout, signal, beforeSend, onActivity, fresh }) {
    const token = this.token;
    const { status, headers, body } = await this.transport({
      method,
      path,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: token },
      json,
      timeout,
      signal,
      beforeSend,
      onActivity,
    });
    if (status === 401) {
      const message = (errorMessage(body) ?? '').toLowerCase();
      if (NOT_TOKEN_RELATED.some((known) => message.includes(known))) {
        throw new RitualsError('not_linked', { status, sent: true });
      }
      if (fresh || token !== this.token) {
        throw new RitualsError('unauthorized', { status, sent: true });
      }
      throw new RitualsError('retry_login', { status, sent: true });
    }
    const failure = this.statusError(status, headers, body);
    if (failure) throw failure;
    const type = String(headers?.['content-type'] ?? '');
    if (body.length === 0 || body.toString('utf8').trim() === '' || !type.includes('json')) {
      return null;
    }
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw new RitualsError('bad_response', { status, sent: true });
    }
  }
}
