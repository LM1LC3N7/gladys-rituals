// -----------------------------------------------------------------------------
// Constants: the Rituals cloud, the pace, the bounds. Ported values (see
// THIRD_PARTY_NOTICES.md) come from the ritualsgenie library (MIT).
// -----------------------------------------------------------------------------

/** The cloud API of the Rituals app, the one ritualsgenie talks to. */
export const API_BASE = 'https://rituals.apiv2.sense-company.com/apiv2/';

/**
 * Our own name, on purpose: never the User-Agent of the Rituals app. Rituals
 * can tell (and throttle) this integration apart from everyone else.
 */
export const USER_AGENT = 'gladys-rituals';

/** Seconds between two reads of the diffuser list (one request each). */
export const POLL_INTERVAL = { default: 300, min: 120, max: 3600 };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** The sensors of a diffuser (one request per sensor) are read at most this often. */
  sensorsEvery: 30 * MINUTE,
  /** A sensor value older than this is never published (restart, device created). */
  sensorsFresh: 2 * HOUR,
  /**
   * Logins the integration decides itself (expiry, restart, a 401): never two
   * closer than this (the shortest interval: a login before a read never
   * delays it).
   */
  loginGap: 2 * MINUTE,
  /** A login asked by a click (command, test button) after a failed one: not sooner. */
  clickLoginGap: 30 * SECOND,
  /** A token is renewed this long before it expires (compared with the Date of Rituals). */
  tokenMargin: MINUTE,
  /** 429 / 5xx: the pause, doubled each time, between these bounds. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** Network errors and wrong answers: the retry, doubled each time. */
  retryMin: 30 * SECOND,
  retryMax: 30 * MINUTE,
  /** A 401 on a token just obtained (not a refused password): spacing doubled up to this. */
  unauthorizedMax: HOUR,
  /** One read request; a read waits no longer for a byte. */
  readTimeout: 10 * SECOND,
  /** Gladys cuts a command at 5 s: the whole answer within this. */
  ackBudget: 3500,
  /** The command request itself, within the ack budget. */
  commandTimeout: 2500,
  /** A confirmation read is not started with less than this left in the budget. */
  confirmMin: 300,
  /** A turn off that never left is tried again within this budget. */
  protectRetryBudget: 250,
  /** A read without a byte for this long is cut by a turn off (not a failure). */
  frozenRead: SECOND,
  /** Follow-up reads after a command not confirmed yet. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A turn off not confirmed is sent again this often, at most offTries times. */
  offRetry: MINUTE,
  offTries: 3,
  /** A turn off kept in /data is given up after this long. */
  offKeep: 30 * MINUTE,
  /** getConfig() failing at start: tried again this often. */
  configRetry: 15 * SECOND,
  /** The time of the last read is written to /data before every read (0: always). */
  attemptSaveEvery: 0,
  /** stop(): the running read is awaited at most this long. */
  stopWait: 3 * SECOND,
};

export const LIMITS = {
  /** Diffusers read per account: 7 states each stay far below 300 states/min. */
  hubs: 20,
  /** Any answer longer than this is cut before it is read whole. */
  body: 256 * 1024,
  /** Names and perfume titles kept, in characters. */
  text: 80,
  /** Commands waiting per diffuser (turn on and intensity; a turn off never waits). */
  queue: 2,
  /** Turns off kept in /data. */
  offs: 20,
};

/** The attributes (write) and sensors (read) of the API. */
export const ATTRIBUTE = { FAN: 'fanc', SPEED: 'speedc', NAME: 'roomnamec' };
export const SENSOR = { BATTERY: 'battc', FILL: 'fillc', PERFUME: 'rfidc', WIFI: 'wific' };

export const SPEED = { min: 1, max: 3 };

export const ACTIONS = { TEST_CONNECTION: 'test_connection' };
