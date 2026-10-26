// -----------------------------------------------------------------------------
// The integration: the Rituals account, the read of its diffusers (one
// request for the list, then the sensors of one diffuser whose readings are
// older than TIMINGS.sensorsEvery), the Gladys devices and states, the
// commands (turn on, turn off, intensity), the badges and the test button.
// index.js only wires the SDK handlers to it.
//
// Two clocks: `now` (wall clock) only dates what /data keeps; `monotonic`
// paces the reads, the pauses, the logins, the freshness and the command
// budgets, so that a wall clock set back or forward never stops nor hurries
// them. The clock is read once per decision (`dueAt(mono)`).
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form with the
// same account, the test button, the Discovery tab, a restart: the time of
// the last read is kept in /data, written before the request).
//
// A turn off is a protective command: it never waits behind a read, a pause
// (429/5xx), the login spacing nor a queue; it logs in when there is no
// token; it cancels the commands waiting for the same diffuser; it is kept
// in /data and sent again (TIMINGS.offRetry, offTries times at most) until a
// read made after it shows the diffuser off, unless a newer command for that
// diffuser left meanwhile. Its only refusals: no account configured, the
// login refused by Rituals (kept until the e-mail or password changes or the
// test button succeeds), logins locked by Rituals with no token held, a
// diffuser never seen on the account. See docs/en.md.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { ATTRIBUTE, LIMITS, SENSOR, TIMINGS } from './constants.js';
import {
  COMMANDS,
  buildDevice,
  hubStates,
  idsOf,
  parseDeviceId,
  parseFeatureId,
  sensorStates,
} from './devices.js';
import { T, age } from './i18n.js';
import { RitualsClient } from './rituals/client.js';
import { RitualsError, httpTransport } from './rituals/http.js';
import { HASH, HUBLOT, SENSOR_READERS, cleanText, parseHub, parseHubs } from './rituals/model.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Errors of a login: whatever the command, nothing of it was sent. */
const LOGIN_CODES = new Set(['refused', 'locked', 'login_wait', 'no_credentials']);
/** Answers meaning Rituals took the command and did not apply it. */
const REJECTED = new Set(['unauthorized', 'not_linked', 'http', 'rate_limited']);
/** A protective command that never left is tried again (within its budget) after these. */
const RETRYABLE = new Set(['network', 'timeout']);

/** The marker of a refused password: 8 bits of a salted hash, never more. */
export const tagOf = (salt, password) =>
  createHash('sha256').update(`${salt}\u0000${password}`, 'utf8').digest()[0];

/** The key of an account in /data: a salted hash of the e-mail. */
export const accountOf = (salt, email) =>
  createHash('sha256')
    .update(`${salt}\u0000${email.toLowerCase()}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

const word = (text, language) => (typeof text === 'string' ? text : (text[language] ?? text.en));

export class RitualsApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'rituals' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    transport = httpTransport(),
    random = () => randomBytes(16).toString('hex'),
    timings = {},
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.transport = transport;
    this.random = random;
    this.t = { ...TIMINGS, ...timings };
    this.config = normalizeConfig();
    this.started = false;
    this.running = false;
    /** `{ client }` of the current e-mail and password; replaced when they change. */
    this.session = undefined;
    this.sessionKey = undefined;
    this.account = '';
    this.seq = 0;
    /** hublot -> the diffuser of the last list (`readAt`: monotonic start of that read). */
    this.hubs = new Map();
    /** hublot -> { wifi, fill, perfume, battery: { value, at } } */
    this.readings = new Map();
    /** hublot -> monotonic time its sensors were last asked for. */
    this.sensorsAt = new Map();
    /** hublot -> command bookkeeping (see target()). */
    this.targets = new Map();
    this.timer = undefined;
    this.offTimer = undefined;
    this.configTimer = undefined;
    this.followTimers = [];
    this.busy = undefined;
    this.readCtl = undefined;
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    this.statusConnected = false;
    this.published = undefined;
    this.badges = new Map();
    this.warned = new Set();
    /** Monotonic: reads. */
    this.lastReadAt = undefined;
    this.nextTryAt = undefined;
    this.failures = 0;
    this.unauthorized = 0;
    /** The last read: `{ ok, code }`. */
    this.outcome = undefined;
    this.lastLoginMono = undefined;
    this.lastLoginFailedMono = undefined;
    this.ready = this.loadKept();
  }

  // --- /data ------------------------------------------------------------------

  async loadKept() {
    let data = null;
    this.storeBroken = false;
    try {
      data = await this.store.load();
    } catch (err) {
      // Unreadable is not empty: nothing is written over it (the pace, the
      // refused login and the turns off it holds would be lost).
      this.storeBroken = true;
      this.logger.warn(`rituals: /data unreadable (${err?.code ?? err?.name}), not written over`);
    }
    const kept = plain(data) ? data : {};
    const at = this.now();
    const mono = this.monotonic();
    this.salt =
      typeof kept.salt === 'string' && /^[0-9a-f]{32}$/.test(kept.salt) ? kept.salt : this.random();
    this.keptAccount =
      typeof kept.account === 'string' && /^[0-9a-f]{16}$/.test(kept.account) ? kept.account : '';
    // A date in the future (a clock set back) is brought to now: never sooner.
    if (finite(kept.lastAttemptAt)) {
      this.lastAttemptAt = Math.min(kept.lastAttemptAt, at);
      this.lastReadAt = mono - (at - this.lastAttemptAt);
    }
    this.savedAttemptAt = this.lastAttemptAt;
    if (finite(kept.lastLoginAt)) {
      this.lastLoginAt = Math.min(kept.lastLoginAt, at);
      this.lastLoginMono = mono - (at - this.lastLoginAt);
    }
    this.pause = this.keptWait(kept.pause, at, mono, ['rate_limited', 'server']);
    this.lock = this.keptWait(kept.lock, at, mono, ['locked']);
    this.refused =
      plain(kept.refused) &&
      typeof kept.refused.account === 'string' &&
      /^[0-9a-f]{16}$/.test(kept.refused.account) &&
      Number.isInteger(kept.refused.tag) &&
      kept.refused.tag >= 0 &&
      kept.refused.tag < 256
        ? { account: kept.refused.account, tag: kept.refused.tag }
        : undefined;
    /** hublot -> { hash, name }: the diffusers seen, for a turn off before the first read. */
    this.known = new Map();
    for (const [hublot, value] of Object.entries(plain(kept.hubs) ? kept.hubs : {})) {
      if (
        HUBLOT.test(hublot) &&
        plain(value) &&
        typeof value.hash === 'string' &&
        HASH.test(value.hash)
      ) {
        this.known.set(hublot, { hash: value.hash, name: cleanText(value.name) });
      }
    }
    this.known = new Map([...this.known].slice(-2 * LIMITS.hubs));
    /** hublot -> { hash, at (wall), tries, seq, mono }: turns off still to confirm. */
    this.offs = new Map();
    for (const [hublot, value] of Object.entries(plain(kept.offs) ? kept.offs : {})) {
      if (
        HUBLOT.test(hublot) &&
        plain(value) &&
        typeof value.hash === 'string' &&
        HASH.test(value.hash) &&
        finite(value.at) &&
        value.at <= at &&
        at - value.at <= this.t.offKeep &&
        Number.isInteger(value.tries) &&
        value.tries >= 0 &&
        value.tries < this.t.offTries
      ) {
        this.seq += 1;
        this.offs.set(hublot, {
          hash: value.hash,
          at: value.at,
          tries: value.tries,
          seq: this.seq,
          mono: undefined,
          fromData: true,
        });
      }
    }
  }

  /** A pause or a lockout read back from /data: its rest capped to pauseMax from now. */
  keptWait(value, at, mono, codes) {
    if (!plain(value) || !finite(value.until) || !codes.includes(value.code)) return undefined;
    const left = Math.min(Math.max(0, value.until - at), this.t.pauseMax);
    if (left <= 0) return undefined;
    return {
      code: value.code,
      until: at + left,
      due: mono + left,
      count: Number.isInteger(value.count) ? Math.min(Math.max(value.count, 1), 32) : 1,
    };
  }

  snapshot() {
    const hubs = {};
    for (const [hublot, value] of this.known) hubs[hublot] = value;
    const offs = {};
    for (const [hublot, off] of [...this.offs].slice(-LIMITS.offs)) {
      offs[hublot] = { hash: off.hash, at: off.at, tries: off.tries };
    }
    const wait = (w) => (w ? { code: w.code, until: w.until, count: w.count } : undefined);
    return {
      version: 1,
      salt: this.salt,
      account: this.keptAccount,
      lastAttemptAt: this.lastAttemptAt,
      lastLoginAt: this.lastLoginAt,
      pause: wait(this.pause),
      lock: wait(this.lock),
      refused: this.refused,
      hubs,
      offs,
    };
  }

  /** Resolves true once written; false when /data is unreadable or the write failed. */
  async saveState() {
    if (this.storeBroken) return false;
    try {
      await this.store.save(this.snapshot());
      return true;
    } catch (err) {
      this.warnOnce('save', `rituals: writing /data failed (${err?.code ?? err?.name})`);
      return false;
    }
  }

  async saveAttempt(at) {
    this.lastAttemptAt = at;
    if (
      this.savedAttemptAt === undefined ||
      at < this.savedAttemptAt ||
      at - this.savedAttemptAt >= this.t.attemptSaveEvery
    ) {
      this.savedAttemptAt = at;
      await this.saveState();
    }
  }

  // --- Lifecycle ----------------------------------------------------------------

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** Resolves once the queued lifecycle jobs and the running read are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.busy;
  }

  /**
   * Gladys (re)connected. The first time: read the configuration (tried
   * again until it answers) and start. Later: Gladys may have restarted and
   * lost what it keeps in memory (status, Discovery list, badges): sent
   * again, and the states at the next read (never an old value as new).
   */
  async connected() {
    await this.ready;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`rituals: reading the configuration failed (${err?.name})`);
      if (!this.started) await this.setStatus(false, T.configUnread);
      this.armConfigRetry();
    }
    if (raw !== undefined) {
      if (this.configTimer !== undefined) {
        this.timers.clearTimeout(this.configTimer);
        this.configTimer = undefined;
      }
      if (!this.started) {
        await this.start(raw);
        return;
      }
      await this.configUpdated(raw);
    }
    if (this.started) await this.resync();
  }

  armConfigRetry() {
    if (this.configTimer !== undefined || this.stopped) return;
    this.configTimer = this.timers.setTimeout(() => {
      this.configTimer = undefined;
      this.connected().catch((err) => this.logger.error(`rituals: ${err?.name}`));
    }, this.t.configRetry);
  }

  async resync() {
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.published = undefined;
    this.badges.clear();
    this.gladys.forgetPublishedStates?.();
    await this.publishDiscovered();
    await this.publishBadges();
  }

  start(raw) {
    return this.serialize(async () => {
      await this.ready;
      this.started = true;
      this.running = true;
      await this.applyConfig(raw, true);
    });
  }

  configUpdated(raw) {
    return this.serialize(async () => {
      await this.ready;
      if (!this.started) {
        this.started = true;
        this.running = true;
        await this.applyConfig(raw, true);
        return;
      }
      await this.applyConfig(raw, false);
    });
  }

  async applyConfig(raw, first) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.config = next;
    const key = JSON.stringify([next.email, next.password, next.problem ?? null]);
    const changed = first || key !== this.sessionKey;
    if (changed) {
      this.sessionKey = key;
      this.session = next.problem
        ? undefined
        : {
            client: new RitualsClient({
              email: next.email,
              password: next.password,
              transport: this.transport,
              monotonic: this.monotonic,
              onLogin: (result) => this.loggedIn(result),
            }),
          };
      this.account = next.problem ? '' : accountOf(this.salt, next.email);
      if (this.account !== '' && this.account !== this.keptAccount) {
        // Another account: what was kept for the previous one does not apply.
        if (this.keptAccount !== '') {
          this.known.clear();
          this.offs.clear();
          this.pause = undefined;
          this.lock = undefined;
          this.lastLoginAt = undefined;
          this.lastLoginMono = undefined;
          this.hubs.clear();
          this.readings.clear();
          this.published = undefined;
        }
        this.keptAccount = this.account;
        await this.saveState();
      }
      if (!first) {
        // New credentials: they may be tried at once (not the old failures).
        this.failures = 0;
        this.unauthorized = 0;
        this.nextTryAt = undefined;
        this.lastReadAt = undefined;
        this.outcome = undefined;
        this.lastLoginMono = undefined;
        this.lastLoginFailedMono = undefined;
      }
      if (this.refused && !this.refusedApplies()) {
        this.refused = undefined;
        await this.saveState();
      }
    }
    if (next.language !== previous.language) {
      await this.publishDiscovered();
    }
    if (!this.session) {
      this.clearReadTimer();
      await this.setStatus(false, T.problems[next.problem]);
      return;
    }
    if (this.refusedApplies()) {
      this.clearReadTimer();
      await this.setStatus(false, T.refused);
    } else if (changed) {
      await this.setStatus(false, T.connecting);
    }
    if (first && this.offs.size > 0) {
      // Kept turns off leave before anything else, without a read first.
      await this.resendOffs({ check: false });
    }
    if (changed || next.pollInterval !== previous.pollInterval) {
      this.schedule();
    }
  }

  async stop() {
    this.stopped = true;
    this.running = false;
    this.clearReadTimer();
    for (const timer of [this.offTimer, this.configTimer, ...this.followTimers]) {
      if (timer !== undefined) this.timers.clearTimeout(timer);
    }
    this.offTimer = undefined;
    this.configTimer = undefined;
    this.followTimers = [];
    await this.saveState();
    if (this.busy) {
      let timer;
      await Promise.race([
        this.busy.catch(() => {}),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(resolve, this.t.stopWait);
        }),
      ]);
      this.timers.clearTimeout(timer);
      await this.saveState();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.statusConnected = connected;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`rituals: setConnectionStatus failed (${err?.name})`));
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Logins -------------------------------------------------------------------

  refusedApplies() {
    return Boolean(
      this.refused &&
      this.session &&
      this.refused.account === this.account &&
      this.refused.tag === tagOf(this.salt, this.config.password),
    );
  }

  /** What is left of the lockout of Rituals (ms), capped at every use. */
  lockLeft(mono) {
    return this.lock ? Math.min(Math.max(0, this.lock.due - mono), this.t.pauseMax) : 0;
  }

  pauseLeft(mono) {
    return this.pause ? Math.min(Math.max(0, this.pause.due - mono), this.t.pauseMax) : 0;
  }

  /**
   * Asked before every login. `kind`: auto (a read: spaced by loginGap),
   * click (a command), test (the test button: also when refused),
   * protective (a turn off). The time of the attempt is in /data before it.
   */
  async mayLogin(kind) {
    const mono = this.monotonic();
    if (kind !== 'test' && this.refusedApplies()) {
      throw new RitualsError('refused');
    }
    const locked = this.lockLeft(mono);
    if (locked > 0) {
      throw new RitualsError('locked', { retryAfter: Math.ceil(locked / 1000) });
    }
    if (kind === 'auto' && this.lastLoginMono !== undefined) {
      const left = this.lastLoginMono + this.t.loginGap - mono;
      if (left > 0) throw new RitualsError('login_wait', { retryAfter: Math.ceil(left / 1000) });
    }
    if ((kind === 'click' || kind === 'test') && this.lastLoginFailedMono !== undefined) {
      const left = this.lastLoginFailedMono + this.t.clickLoginGap - mono;
      if (left > 0) throw new RitualsError('login_wait', { retryAfter: Math.ceil(left / 1000) });
    }
    this.lastLoginMono = mono;
    this.lastLoginAt = this.now();
    await this.saveState();
  }

  /** Every login ends here: a refusal or a lockout is kept in /data. */
  loggedIn({ ok, error }) {
    if (ok) {
      this.lastLoginFailedMono = undefined;
      if (this.refused) {
        this.refused = undefined;
        this.logger.info('rituals: the account is accepted again');
        this.saveState();
      }
      return;
    }
    this.lastLoginFailedMono = this.monotonic();
    if (error?.code === 'refused') {
      this.refused = { account: this.account, tag: tagOf(this.salt, this.config.password) };
      this.clearReadTimer();
      this.logger.warn('rituals: Rituals refused the e-mail or the password');
      this.saveState();
      this.setStatus(false, T.refused);
    } else if (error?.code === 'locked') {
      this.setLock(error.retryAfter);
    }
  }

  setLock(seconds) {
    const left = Math.min(Math.max((seconds ?? 0) * 1000, this.t.pauseMin), this.t.pauseMax);
    this.lock = {
      code: 'locked',
      until: this.now() + left,
      due: this.monotonic() + left,
      count: 1,
    };
    this.logger.warn(`rituals: logins locked by Rituals for ${age(left)}`);
    this.saveState();
  }

  // --- Reads ----------------------------------------------------------------------

  interval() {
    return this.config.pollInterval * 1000;
  }

  /** The monotonic time from which the next read may start, from the instant `mono` read once. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval();
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    due = Math.max(due, mono + this.pauseLeft(mono));
    if (!this.session?.client.hasToken(mono)) due = Math.max(due, mono + this.lockLeft(mono));
    return due;
  }

  clearReadTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** One timer: the next read when it is due; none while the login is refused. */
  schedule() {
    this.clearReadTimer();
    if (!this.running || !this.session || this.refusedApplies()) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loop().catch((err) => this.logger.error(`rituals: unexpected error (${err?.name})`));
    }, wait);
  }

  async loop() {
    const session = this.session;
    await this.tick();
    if (session === this.session && this.running) this.schedule();
  }

  /** One read when it is due; a read running is never doubled. */
  tick() {
    if (!this.busy) {
      this.busy = this.read().finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  async read() {
    const session = this.session;
    if (!session || !this.running || this.refusedApplies()) return;
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) return;
    const gone = () => session !== this.session || !this.running;
    this.lastReadAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    const ctl = { controller: new AbortController(), last: mono, cut: false };
    this.readCtl = ctl;
    try {
      const data = await this.callRead(session, 'account/hubs', ctl);
      if (gone()) return;
      const parsed = parseHubs(data);
      if (!parsed) throw new RitualsError('bad_response', { sent: true });
      await this.applyHubs(parsed, mono);
      if (gone()) return;
      const due = this.sensorsDue(mono);
      if (due) await this.readSensors(session, due, ctl, gone, mono);
      if (gone()) return;
      this.failures = 0;
      this.unauthorized = 0;
      this.nextTryAt = undefined;
      if (this.pause) {
        this.pause = undefined;
        await this.saveState();
      }
      this.outcome = { ok: true };
      const online = [...this.hubs.values()].filter((h) => h.online).length;
      await this.setStatus(true, T.connected(this.hubs.size, online));
    } catch (err) {
      if (gone()) return;
      if (ctl.cut) {
        // Cut by a turn off: not a failure (read again at the next interval).
        this.logger.info('rituals: a frozen read was cut by a turn off');
        return;
      }
      await this.failed(err);
    } finally {
      if (this.readCtl === ctl) this.readCtl = undefined;
    }
    if (!gone()) await this.publishBadges();
  }

  callRead(session, path, ctl) {
    return session.client.call(path, {
      timeout: this.t.readTimeout,
      signal: ctl?.controller.signal,
      onActivity: () => {
        if (ctl) ctl.last = this.monotonic();
      },
      mayLogin: () => this.mayLogin('auto'),
    });
  }

  /** A turn off cuts a read that has had no byte for frozenRead (not a failure). */
  cutFrozenRead() {
    const ctl = this.readCtl;
    if (ctl && this.monotonic() - ctl.last >= this.t.frozenRead) {
      ctl.cut = true;
      ctl.controller.abort();
    }
  }

  async failed(err) {
    const code = err instanceof RitualsError ? err.code : 'bad_response';
    const mono = this.monotonic();
    this.outcome = { ok: false, code };
    if (!(err instanceof RitualsError)) {
      this.logger.error(`rituals: unexpected error (${err?.name})`);
    }
    if (code === 'refused') {
      // loggedIn() stopped everything and kept it in /data.
      await this.setStatus(false, T.refused);
      await this.publishBadges();
      return;
    }
    if (code === 'locked') {
      if (!this.lock) this.setLock(err.retryAfter);
      await this.setStatus(false, T.locked(age(this.lockLeft(mono))));
      await this.publishBadges();
      return;
    }
    if (code === 'rate_limited' || code === 'server') {
      const left = this.pauseFor(err);
      await this.setStatus(false, T.paused(code, age(left)));
      await this.publishBadges();
      return;
    }
    let wait;
    if (code === 'unauthorized') {
      // A token refused right after being given: not a refused password.
      this.unauthorized += 1;
      wait = Math.min(
        Math.max(this.interval(), this.t.retryMin) * 2 ** (this.unauthorized - 1),
        this.t.unauthorizedMax,
      );
    } else if (code === 'login_wait') {
      wait = Math.max((err.retryAfter ?? 0) * 1000, this.t.retryMin);
    } else {
      this.failures += 1;
      wait = Math.min(this.t.retryMin * 2 ** (this.failures - 1), this.t.retryMax);
    }
    this.nextTryAt = mono + wait;
    this.logger.warn(`rituals: read failed (${code}), next try in ${age(wait)}`);
    await this.setStatus(false, T.retry(code, age(wait)));
    await this.publishBadges();
  }

  /** A 429 or a 5xx: the pause (doubled each time, bounded), kept in /data. Returns its length. */
  pauseFor(err) {
    const count = (this.pause?.count ?? 0) + 1;
    const asked = err.retryAfter !== undefined ? err.retryAfter * 1000 : undefined;
    const left = Math.min(
      Math.max(asked ?? this.t.pauseMin * 2 ** (count - 1), this.t.pauseMin),
      this.t.pauseMax,
    );
    this.pause = {
      code: err.code,
      until: this.now() + left,
      due: this.monotonic() + left,
      count: Math.min(count, 32),
    };
    this.logger.warn(`rituals: ${err.code} (HTTP ${err.status}), paused for ${age(left)}`);
    this.saveState();
    return left;
  }

  /** The list read at `started` (monotonic): diffusers, Discovery, states, turns off confirmed. */
  async applyHubs({ hubs, skipped }, started, { follow = false } = {}) {
    for (const s of skipped) {
      this.warnOnce(
        `skip:${s.reason}:${s.hublot ?? ''}`,
        `rituals: a diffuser left out (${s.reason})`,
      );
    }
    const seen = new Set();
    let knownChanged = false;
    for (const hub of hubs) {
      seen.add(hub.hublot);
      const previous = this.known.get(hub.hublot);
      if (previous && previous.hash !== hub.hash) {
        this.logger.info(`rituals: diffuser ${hub.hublot} has a new API hash`);
      }
      if (!previous || previous.hash !== hub.hash || previous.name !== hub.name) {
        this.known.delete(hub.hublot);
        this.known.set(hub.hublot, { hash: hub.hash, name: hub.name });
        knownChanged = true;
      }
      this.hubs.set(hub.hublot, { ...hub, readAt: started });
    }
    if (!follow) {
      for (const hublot of [...this.hubs.keys()]) {
        if (!seen.has(hublot)) this.hubs.delete(hublot);
      }
    }
    while (this.known.size > 2 * LIMITS.hubs) {
      this.known.delete(this.known.keys().next().value);
    }
    // A turn off is confirmed by a read that started after it.
    let offsChanged = false;
    for (const [hublot, off] of this.offs) {
      const hub = this.hubs.get(hublot);
      if (
        hub &&
        seen.has(hublot) &&
        hub.on === false &&
        (off.mono === undefined || off.mono < started)
      ) {
        this.offs.delete(hublot);
        offsChanged = true;
        this.logger.info(`rituals: turn off of ${hublot} confirmed`);
      }
    }
    if (knownChanged || offsChanged) await this.saveState();
    if (!follow) await this.publishDiscovered();
    const states = [];
    for (const hub of hubs) {
      if (hub.online === false) continue;
      // A command sent after this read started: its answer is not this read's.
      const target = this.targets.get(hub.hublot);
      if (target?.lastCmdMono !== undefined && target.lastCmdMono >= started) continue;
      states.push(...hubStates(this.gladys, hub));
    }
    await this.publish(states);
  }

  /** The diffuser whose sensors are the oldest, when due. */
  sensorsDue(mono) {
    let best;
    for (const hub of this.hubs.values()) {
      if (hub.online !== true || hub.sensors.length === 0) continue;
      const at = this.sensorsAt.get(hub.hublot);
      if (at !== undefined && mono - at < this.t.sensorsEvery) continue;
      if (!best || (this.sensorsAt.get(best.hublot) ?? -Infinity) > (at ?? -Infinity)) best = hub;
    }
    return best;
  }

  /** One request per sensor; a failing sensor never fails the read of the list. */
  async readSensors(session, hub, ctl, gone, mono) {
    // Dated with the start of the read: the period is the interval's multiple, never one more.
    this.sensorsAt.set(hub.hublot, mono);
    const keys = {
      [SENSOR.WIFI]: 'wifi',
      [SENSOR.FILL]: 'fill',
      [SENSOR.PERFUME]: 'perfume',
      [SENSOR.BATTERY]: 'battery',
    };
    const fresh = {};
    for (const sensor of hub.sensors) {
      const started = this.monotonic();
      let data;
      try {
        data = await this.callRead(session, `hubs/${hub.hash}/sensors/${sensor}`, ctl);
      } catch (err) {
        if (gone() || ctl.cut) return;
        if (err instanceof RitualsError && err.code === 'rate_limited') {
          // The account is rate limited; a 5xx of one sensor is only that sensor.
          this.pauseFor(err);
          break;
        }
        this.warnOnce(
          `sensor:${hub.hublot}:${sensor}:${err?.code}`,
          `rituals: sensor ${sensor} of ${hub.hublot} not read (${err?.code ?? err?.name})`,
        );
        if (err instanceof RitualsError && LOGIN_CODES.has(err.code)) break;
        continue;
      }
      if (gone()) return;
      const value = SENSOR_READERS[sensor](data, hub.generation);
      if (value !== undefined) fresh[keys[sensor]] = { value, at: started };
    }
    const readings = { ...(this.readings.get(hub.hublot) ?? {}), ...fresh };
    this.readings.set(hub.hublot, readings);
    const values = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.value]));
    await this.publish(sensorStates(this.gladys, hub.hublot, values, this.config.language));
  }

  // --- Gladys ---------------------------------------------------------------------

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevice(hublot) {
    const id = idsOf(this.gladys, hublot).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  /** The states of created features, changed ones only (the SDK keeps the last values). */
  async publish(states, created = this.createdFeatures()) {
    const wanted = states.filter((s) => created.has(s.device_feature_external_id));
    if (wanted.length === 0) return;
    await this.gladys
      .publishChangedStates(wanted)
      .catch((err) => this.logger.warn(`rituals: sending states failed (${err?.name})`));
  }

  async publishDiscovered() {
    if (this.hubs.size === 0 && this.published === undefined) return;
    const devices = [...this.hubs.values()].map((hub) => {
      const created = this.createdDevice(hub.hublot);
      const prefix = `${idsOf(this.gladys, hub.hublot).device}:`;
      const keys = new Set(
        (created?.features ?? [])
          .map((f) => f.external_id)
          .filter((id) => typeof id === 'string' && id.startsWith(prefix))
          .map((id) => id.slice(prefix.length)),
      );
      return buildDevice(this.gladys, hub, this.config.language, keys);
    });
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`rituals: publishing the discovered devices failed (${err?.name})`);
    }
  }

  badgeOf(hublot) {
    const hub = this.hubs.get(hublot);
    if (!this.outcome?.ok || !hub) return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    if (hub.online === false) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.offline };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }

  async publishBadges() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const hublot = parseDeviceId(this.gladys, device.external_id);
      if (!hublot) continue;
      const entry = { external_id: device.external_id, ...this.badgeOf(hublot) };
      const json = JSON.stringify(entry);
      if (this.badges.get(device.external_id) !== json) {
        this.badges.set(device.external_id, json);
        entries.push(entry);
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`rituals: badges failed (${err?.name})`));
    }
  }

  /** A device created (or updated): its last values at once, when they are fresh. */
  async deviceCreated(device) {
    const hublot = parseDeviceId(this.gladys, device?.external_id);
    if (!hublot) return;
    this.badges.delete(device.external_id);
    const created = this.createdFeatures();
    for (const f of device.features ?? []) created.add(f.external_id);
    const mono = this.monotonic();
    const hub = this.hubs.get(hublot);
    const states = [];
    if (hub && hub.online !== false && mono - hub.readAt <= 2 * this.interval()) {
      states.push(...hubStates(this.gladys, hub));
    }
    const readings = this.readings.get(hublot) ?? {};
    const values = {};
    for (const [key, reading] of Object.entries(readings)) {
      if (mono - reading.at <= this.t.sensorsFresh) values[key] = reading.value;
    }
    states.push(...sensorStates(this.gladys, hublot, values, this.config.language));
    await this.publish(states, created);
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    if (device?.external_id) this.badges.delete(device.external_id);
  }

  /** Discovery: the list of the last read; a read only when it is due. */
  async scan() {
    await this.ready;
    const mono = this.monotonic();
    if (this.session && !this.refusedApplies() && mono >= this.dueAt(mono)) {
      await this.tick();
      this.schedule();
    }
    this.published = undefined;
    await this.publishDiscovered();
  }

  // --- Commands -------------------------------------------------------------------

  target(hublot) {
    let t = this.targets.get(hublot);
    if (!t) {
      t = {
        chain: Promise.resolve(),
        waiters: new Set(),
        offSeq: 0,
        sentSeq: 0,
        inflight: undefined,
        lastCmdMono: undefined,
        resendOff: undefined,
      };
      this.targets.set(hublot, t);
    }
    return t;
  }

  async setValue(_device, feature, value) {
    await this.ready;
    const target = parseFeatureId(this.gladys, feature?.external_id);
    const language = this.config.language;
    if (!target || !COMMANDS.includes(target.key)) {
      throw new Error(`${feature?.external_id} cannot be set`);
    }
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (target.key === 'power') {
      if (number !== 0 && number !== 1) throw new Error(word(T.command.invalid, language));
      return number === 0
        ? this.turnOff(target.hublot)
        : this.command(target.hublot, ATTRIBUTE.FAN, '1', { field: 'on', value: true });
    }
    if (!Number.isInteger(number) || number < 1 || number > 3) {
      throw new Error(word(T.command.invalid, language));
    }
    return this.command(target.hublot, ATTRIBUTE.SPEED, String(number), {
      field: 'speed',
      value: number,
    });
  }

  fail(text) {
    return new Error(word(text, this.config.language));
  }

  /** Turn on or intensity: waits its turn for the diffuser, never during a pause. */
  async command(hublot, attribute, value, expect) {
    const started = this.monotonic();
    const session = this.session;
    if (!session) throw this.fail(T.command.nothingSent('no_credentials'));
    if (this.refusedApplies()) throw this.fail(T.command.nothingSent('refused'));
    if (this.pauseLeft(started) > 0) throw this.fail(T.command.nothingSent(this.pause.code));
    const hub = this.hubs.get(hublot);
    if (!hub) throw this.fail(T.command.unknown);
    if (hub.online === false) throw this.fail(T.command.offline);
    const t = this.target(hublot);
    if (t.waiters.size >= LIMITS.queue) throw this.fail(T.command.queueFull);
    this.seq += 1;
    const seq = this.seq;
    t.lastCmdMono = started;
    // Waiting its turn; a turn off cancels it at once.
    const waiter = { seq };
    const cancelled = new Promise((_, reject) => {
      waiter.cancel = () => {
        t.waiters.delete(waiter);
        reject(this.fail(T.command.cancelled));
      };
    });
    cancelled.catch(() => {});
    t.waiters.add(waiter);
    const run = t.chain.then(() => {
      if (!t.waiters.delete(waiter)) throw this.fail(T.command.cancelled);
      return this.sendCommand(session, hublot, attribute, value, expect, seq, started);
    });
    t.chain = run.catch(() => {});
    return Promise.race([run, cancelled]);
  }

  async sendCommand(session, hublot, attribute, value, expect, seq, started) {
    const t = this.target(hublot);
    const left = () => this.t.ackBudget - (this.monotonic() - started);
    if (t.offSeq > seq) throw this.fail(T.command.cancelled);
    if (session !== this.session) throw this.fail(T.command.nothingSent('no_credentials'));
    if (left() < this.t.confirmMin) throw this.fail(T.command.nothingSent('timeout'));
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) throw this.fail(T.command.nothingSent(this.pause.code));
    if (this.refusedApplies()) throw this.fail(T.command.nothingSent('refused'));
    // The identity: the hash of this hublot in the last list of the account.
    const hub = this.hubs.get(hublot);
    if (!hub) throw this.fail(T.command.unknown);
    let leftAt;
    let cancelled = false;
    t.inflight = seq;
    try {
      await session.client.call(`hubs/${hub.hash}/attributes/${attribute}`, {
        method: 'POST',
        json: { [attribute]: value },
        timeout: () => Math.min(this.t.commandTimeout, left() - this.t.confirmMin),
        mayLogin: () => this.mayLogin('click'),
        beforeSend: () => {
          if (t.offSeq > seq) {
            cancelled = true;
            throw new Error('cancelled');
          }
          leftAt = t.sentSeq;
          t.sentSeq = Math.max(t.sentSeq, seq);
        },
      });
    } catch (err) {
      const unsend = () => {
        if (leftAt !== undefined && t.sentSeq === seq) t.sentSeq = leftAt;
      };
      if (cancelled) throw this.fail(T.command.cancelled);
      if (!(err instanceof RitualsError)) {
        unsend();
        throw err;
      }
      if (leftAt === undefined || LOGIN_CODES.has(err.code) || !err.sent) {
        unsend();
        throw this.fail(T.command.nothingSent(err.code));
      }
      // A 429 is the account's limit; a 5xx concerns this diffuser (the others go on).
      if (err.code === 'rate_limited') this.pauseFor(err);
      if (REJECTED.has(err.code)) {
        unsend();
        throw this.fail(T.command.rejected(err.code));
      }
      // Sent, no useful answer: neither a success nor a refusal.
      this.logger.warn(`rituals: command to ${hublot} sent without confirmation (${err.code})`);
      this.followUp();
      return undefined;
    } finally {
      t.inflight = undefined;
      this.afterInflight(hublot);
    }
    // Overtaken by a turn off: its read back would only show a passing state.
    if (this.target(hublot).offSeq < seq) await this.confirm(session, hublot, hub, expect, left);
    return undefined;
  }

  /**
   * Reads the diffuser back within the ack budget: success only when it shows
   * the value asked; otherwise follow-up reads (5 s, 20 s).
   */
  async confirm(session, hublot, hub, expect, left) {
    if (left() < this.t.confirmMin) {
      this.followUp();
      return false;
    }
    const started = this.monotonic();
    let fresh;
    try {
      const data = await session.client.call(`account/hubs/${hub.hash}`, {
        timeout: () => left() - 50,
        mayLogin: () => {
          throw new RitualsError('login_wait');
        },
      });
      fresh = parseHub(data);
    } catch (err) {
      this.logger.info(`rituals: ${hublot} not read back (${err?.code ?? err?.name})`);
      this.followUp();
      return false;
    }
    if (fresh.reason || fresh.hublot !== hublot) {
      this.logger.warn(`rituals: the read back of ${hublot} is not this diffuser: not confirmed`);
      this.followUp();
      return false;
    }
    const known = this.hubs.get(hublot);
    const before = known?.[expect.field];
    this.hubs.set(hublot, { ...(known ?? hub), ...fresh, readAt: started });
    if (fresh[expect.field] === expect.value) {
      const t = this.target(hublot);
      // A newer command may have been sent meanwhile: its own read will tell.
      if (t.lastCmdMono === undefined || t.lastCmdMono <= started) {
        await this.publish(hubStates(this.gladys, this.hubs.get(hublot)));
      }
      return true;
    }
    this.logger.info(
      fresh[expect.field] === before
        ? `rituals: ${hublot} not applied yet`
        : `rituals: ${hublot} shows another value`,
    );
    this.followUp();
    return false;
  }

  /** Follow-up reads of the list (one request for all diffusers), 5 s and 20 s later. */
  followUp() {
    if (this.followTimers.length > 0 || !this.running) return;
    this.followTimers = this.t.followUps.map((delay, i) => {
      const timer = this.timers.setTimeout(() => {
        if (i === this.t.followUps.length - 1) this.followTimers = [];
        this.followRead().catch((err) => this.logger.warn(`rituals: ${err?.name}`));
      }, delay);
      return timer;
    });
  }

  async followRead() {
    const session = this.session;
    const mono = this.monotonic();
    if (!session || !this.running || this.refusedApplies() || this.pauseLeft(mono) > 0) return;
    try {
      const data = await this.callRead(session, 'account/hubs');
      if (session !== this.session) return;
      const parsed = parseHubs(data);
      if (parsed) await this.applyHubs(parsed, mono, { follow: true });
    } catch (err) {
      if (err instanceof RitualsError && (err.code === 'rate_limited' || err.code === 'server')) {
        this.pauseFor(err);
      }
      this.logger.info(`rituals: follow-up read failed (${err?.code ?? err?.name})`);
    }
  }

  // --- Turn off (protective) ------------------------------------------------------

  async turnOff(hublot) {
    const started = this.monotonic();
    const t = this.target(hublot);
    this.seq += 1;
    const seq = this.seq;
    // Every command still waiting for this diffuser is cancelled.
    t.offSeq = seq;
    for (const waiter of [...t.waiters]) waiter.cancel();
    t.lastCmdMono = started;
    const hash = this.hubs.get(hublot)?.hash ?? this.known.get(hublot)?.hash;
    if (!hash) throw this.fail(T.command.unknown);
    const session = this.session;
    if (!session) throw this.fail(T.command.nothingSent('no_credentials'));
    if (this.refusedApplies()) throw this.fail(T.command.nothingSent('refused'));
    this.offs.delete(hublot);
    this.offs.set(hublot, { hash, at: this.now(), tries: 0, seq, mono: started });
    // Kept for a restart; the turn off never waits for the disk.
    this.saveState();
    t.offHash = hash;
    if (t.inflight !== undefined) t.resendOff = seq;
    this.cutFrozenRead();
    const result = await this.sendOff(session, hublot, started);
    this.armOffTimer();
    if (result.error) throw this.fail(result.error);
    return undefined;
  }

  /**
   * After a command that was in flight when a turn off left: it may have
   * landed after the turn off, so the turn off is sent again (kept until a
   * read confirms it), unless a command newer than it left meanwhile.
   */
  afterInflight(hublot) {
    const t = this.targets.get(hublot);
    if (t?.resendOff === undefined) return;
    t.resendOff = undefined;
    const seq = t.offSeq;
    if (t.sentSeq > seq || !this.session || !t.offHash) return;
    const off = this.offs.get(hublot);
    if (!off || off.seq !== seq) {
      this.offs.delete(hublot);
      this.offs.set(hublot, { hash: t.offHash, at: this.now(), tries: 0, seq, mono: undefined });
    }
    this.offs.get(hublot).mono = this.monotonic();
    this.sendOff(this.session, hublot, this.monotonic())
      .then(() => this.armOffTimer())
      .catch((err) => this.logger.warn(`rituals: ${err?.name}`));
  }

  /**
   * Sends the kept turn off of `hublot`, retried within protectRetryBudget
   * when it never left. Returns `{ error }` (a text) when nothing left or
   * Rituals refused it, `{}` otherwise; the turn off stays kept until a read
   * shows the diffuser off.
   */
  async sendOff(session, hublot, started, { counted = true, confirm = true } = {}) {
    const off = this.offs.get(hublot);
    if (!off) return {};
    const t = this.target(hublot);
    if (counted) off.tries += 1;
    const left = () => this.t.ackBudget - (this.monotonic() - started);
    let lastError;
    for (let attempt = 1; ; attempt += 1) {
      let leftAt;
      try {
        await session.client.call(`hubs/${off.hash}/attributes/${ATTRIBUTE.FAN}`, {
          method: 'POST',
          json: { [ATTRIBUTE.FAN]: '0' },
          timeout: () => Math.min(this.t.commandTimeout, left() - this.t.confirmMin),
          mayLogin: () => this.mayLogin('protective'),
          beforeSend: () => {
            leftAt = t.sentSeq;
            t.sentSeq = Math.max(t.sentSeq, off.seq);
          },
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        const code = err instanceof RitualsError ? err.code : 'bad_response';
        const reached = leftAt !== undefined && err instanceof RitualsError && err.sent;
        // Never left, or answered 4xx/429: it does not count as sent.
        if (
          leftAt !== undefined &&
          (!reached || LOGIN_CODES.has(code) || REJECTED.has(code)) &&
          t.sentSeq === off.seq
        ) {
          t.sentSeq = leftAt;
        }
        const retry =
          !reached &&
          RETRYABLE.has(code) &&
          attempt < 3 &&
          this.monotonic() - started < this.t.protectRetryBudget;
        if (!retry) {
          lastError.reached = reached;
          break;
        }
      }
    }
    if (lastError) {
      const code = lastError instanceof RitualsError ? lastError.code : 'bad_response';
      if (lastError.reached && code === 'rate_limited') {
        // The pause applies to the reads and the other commands, never to a turn off.
        this.pauseFor(lastError);
      }
      if (code === 'not_linked') {
        // Not this account's diffuser any more: sending again cannot help.
        this.offs.delete(hublot);
        this.saveState();
        return { error: T.command.rejected(code) };
      }
      if (!lastError.reached || LOGIN_CODES.has(code) || code === 'rate_limited') {
        this.logger.warn(`rituals: turn off of ${hublot} not applied (${code}), kept`);
        this.saveState();
        return { error: T.command.offKept(code) };
      }
      if (code === 'http' || code === 'unauthorized') {
        this.logger.warn(`rituals: turn off of ${hublot} refused by Rituals (${code}), kept`);
        this.saveState();
        return { error: T.command.rejected(code) };
      }
      this.logger.warn(`rituals: turn off of ${hublot} sent without confirmation (${code})`);
      this.saveState();
      return {};
    }
    this.saveState();
    if (confirm) {
      const hub = this.hubs.get(hublot) ?? { hublot, hash: off.hash, sensors: [] };
      const ok = await this.confirm(session, hublot, hub, { field: 'on', value: false }, left);
      if (ok && this.offs.get(hublot) === off) {
        this.offs.delete(hublot);
        this.logger.info(`rituals: ${hublot} turned off`);
        this.saveState();
      }
    }
    return {};
  }

  armOffTimer() {
    if (this.offTimer !== undefined || this.offs.size === 0 || !this.running) return;
    this.offTimer = this.timers.setTimeout(() => {
      this.offTimer = undefined;
      this.resendOffs({ check: true })
        .catch((err) => this.logger.warn(`rituals: ${err?.name}`))
        .finally(() => this.armOffTimer());
    }, this.t.offRetry);
  }

  /**
   * Every turn off still kept, at once: given up when too old, tried
   * offTries times or overtaken by a newer command that left; with `check`,
   * the diffuser is read first (already off: confirmed).
   */
  async resendOffs({ check }) {
    const session = this.session;
    if (!session || this.refusedApplies()) return;
    const at = this.now();
    const jobs = [];
    let changed = false;
    for (const [hublot, off] of [...this.offs]) {
      const t = this.target(hublot);
      if (
        off.at > at ||
        at - off.at > this.t.offKeep ||
        off.tries >= this.t.offTries ||
        t.sentSeq > off.seq
      ) {
        this.offs.delete(hublot);
        changed = true;
        this.logger.warn(`rituals: turn off of ${hublot} given up (not confirmed)`);
        continue;
      }
      jobs.push(this.resendOff(session, hublot, off, check));
    }
    if (changed) await this.saveState();
    await Promise.all(jobs);
  }

  async resendOff(session, hublot, off, check) {
    const started = this.monotonic();
    if (check) {
      try {
        const data = await session.client.call(`account/hubs/${off.hash}`, {
          timeout: this.t.readTimeout,
          mayLogin: () => this.mayLogin('protective'),
        });
        const hub = parseHub(data);
        if (!hub.reason && hub.hublot === hublot && hub.on === false) {
          if (this.offs.get(hublot) === off) {
            this.offs.delete(hublot);
            this.logger.info(`rituals: turn off of ${hublot} confirmed`);
            await this.saveState();
          }
          const known = this.hubs.get(hublot);
          if (known) this.hubs.set(hublot, { ...known, ...hub, readAt: started });
          await this.publish(hubStates(this.gladys, hub));
          return;
        }
      } catch (err) {
        this.logger.info(
          `rituals: ${hublot} not read before the turn off (${err?.code ?? err?.name})`,
        );
      }
    }
    await this.sendOff(session, hublot, this.monotonic(), { confirm: check });
  }

  // --- "Test the connection" ------------------------------------------------------

  async testConnection() {
    await this.ready;
    await this.lifecycle;
    if (!this.session) return T.problems[this.config.problem];
    if (this.refusedApplies()) {
      // One login per click: how a refused account is tried again.
      try {
        await this.mayLogin('test');
        await this.session.client.login();
      } catch (err) {
        const code = err instanceof RitualsError ? err.code : 'bad_response';
        if (code === 'refused') return T.refused;
        if (code === 'login_wait') return T.test.wait(age((err.retryAfter ?? 1) * 1000));
        if (code === 'locked') return T.locked(age(this.lockLeft(this.monotonic())));
        return T.retry(code, age(this.t.retryMin));
      }
      this.lastReadAt = undefined;
      this.nextTryAt = undefined;
    }
    const mono = this.monotonic();
    const due = this.dueAt(mono);
    let note = '';
    if (mono >= due) {
      await this.tick();
      this.schedule();
    } else {
      note = T.test.recent(age(due - mono));
    }
    if (!this.outcome) return this.lastStatus ? JSON.parse(this.lastStatus)[1] : T.connecting;
    if (!this.outcome.ok) {
      const message = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return message ?? T.retry(this.outcome.code, age(this.t.retryMin));
    }
    const hubs = [...this.hubs.values()];
    const names = hubs
      .map((h) => ` ${h.name ?? h.hublot}${h.online === false ? ' (offline)' : ''}.`)
      .join('');
    const ok = T.test.ok(hubs.length, hubs.filter((h) => h.online).length, names);
    return { en: `${ok.en}${note ? note.en : ''}`, fr: `${ok.fr}${note ? note.fr : ''}` };
  }
}
