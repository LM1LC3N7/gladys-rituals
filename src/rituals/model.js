// -----------------------------------------------------------------------------
// The answers of the Rituals API, read strictly (pure functions). Ported from
// the models of ritualsgenie (MIT, see THIRD_PARTY_NOTICES.md): a diffuser is
// a "hub" with its `hash` (the id of the API paths) and its `hublot` (the
// hardware lot), its attribute values as strings (`fanc` "1"/"0", `speedc`
// "1".."3", `roomnamec` the name), `status` 1 online / 0 offline, the sensors
// it supports; the sensor readings (`raw`, `title`, `icon`), the battery and
// Wi-Fi levels of the app icons, the fill level from the use counter of the
// cartridge (10 % per 2000, clamped into the range of its title), "0" for no
// cartridge, "-1" for no fill measurement.
//
// Changed here: identifiers checked against strict patterns (they end up in
// the URL and in the Gladys ids), a hub without them or sharing them with
// another is left out, a value that is not exactly what is expected is
// unknown (never 0), the Wi-Fi level as the 0-5 bars of Gladys.
// -----------------------------------------------------------------------------

import { ATTRIBUTE, LIMITS, SENSOR, SPEED } from '../constants.js';

export const HUBLOT = /^[A-Za-z0-9_-]{1,64}$/;
export const HASH = /^[A-Za-z0-9]{1,128}$/;

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

/** A text of the API, printable and bounded; undefined when empty. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : [...text].slice(0, max).join('');
}

/** An attribute value: the API sends strings ("1"), sometimes plain numbers. */
function attributeText(values, key) {
  const value = own(values, key);
  if (typeof value === 'string') return value;
  if (Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** A hub of the API -> a diffuser, or `{ reason }` when it cannot be used. */
export function parseHub(raw) {
  if (!plain(raw)) return { reason: 'not_an_object' };
  const hash = own(raw, 'hash');
  const hublot = own(raw, 'hublot');
  if (typeof hublot !== 'string' || !HUBLOT.test(hublot)) return { reason: 'hublot' };
  if (typeof hash !== 'string' || !HASH.test(hash)) return { reason: 'hash' };
  const values = plain(own(raw, 'attributeValues')) ? own(raw, 'attributeValues') : {};
  const sensors = plain(own(raw, 'sensors')) ? own(raw, 'sensors') : {};
  const fan = attributeText(values, ATTRIBUTE.FAN);
  const speedText = attributeText(values, ATTRIBUTE.SPEED);
  const speed = /^\d$/.test(speedText ?? '') ? Number(speedText) : undefined;
  const status = own(raw, 'status');
  const flow = own(raw, 'deviceFlowVersion');
  const firmware = plain(own(raw, 'firmwareInfo')) ? own(raw, 'firmwareInfo') : {};
  return {
    hublot,
    hash,
    name: cleanText(attributeText(values, ATTRIBUTE.NAME)),
    online: status === 1 ? true : status === 0 ? false : undefined,
    on: fan === '1' ? true : fan === '0' ? false : undefined,
    speed: speed !== undefined && speed >= SPEED.min && speed <= SPEED.max ? speed : undefined,
    sensors: Object.values(SENSOR).filter((key) => own(sensors, key) === true),
    generation: Number.isSafeInteger(flow) ? Math.max(flow, 1) : undefined,
    firmware: cleanText(
      typeof own(firmware, 'currentFirmware') === 'number'
        ? String(own(firmware, 'currentFirmware'))
        : own(firmware, 'currentFirmware'),
      16,
    ),
  };
}

/**
 * The list of hubs -> `{ hubs, skipped }`. Not a list: undefined (a wrong
 * answer). Hubs sharing a hublot or a hash are all left out (which one is
 * which cannot be told); beyond LIMITS.hubs, left out too.
 */
export function parseHubs(raw) {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw.slice(0, 200).map(parseHub);
  const count = (key) => {
    const seen = new Map();
    for (const hub of parsed) {
      if (!hub.reason) seen.set(hub[key], (seen.get(hub[key]) ?? 0) + 1);
    }
    return seen;
  };
  const hublots = count('hublot');
  const hashes = count('hash');
  const hubs = [];
  const skipped = [];
  for (const hub of parsed) {
    if (hub.reason) {
      skipped.push({ reason: hub.reason });
    } else if (hublots.get(hub.hublot) > 1 || hashes.get(hub.hash) > 1) {
      skipped.push({ reason: 'duplicate', hublot: hub.hublot });
    } else if (hubs.length >= LIMITS.hubs) {
      skipped.push({ reason: 'limit', hublot: hub.hublot });
    } else {
      hubs.push(hub);
    }
  }
  if (raw.length > 200) skipped.push({ reason: 'limit' });
  return { hubs, skipped };
}

// --- Sensors ------------------------------------------------------------------

const BATTERY_ICONS = {
  'battery-full.png': 100,
  'Battery-75.png': 50,
  'battery-50.png': 25,
  'battery-low.png': 10,
};
const BATTERY_CHARGING_ICON = 'battery-charge.png';
const BATTERY_CHARGING_ID = 21;
const WIFI_ICONS = {
  'icon-signal.png': 5,
  'icon-signal-75.png': 4,
  'icon-signal-low.png': 1,
  'icon-signal-0.png': 0,
};
const NO_CARTRIDGE_ID = 19;
const FILL_USE_PER_PERCENT = 200;

/** A reading: `{ title, raw, icon, id, scentFound }`, each undefined when not as expected. */
function readingOf(raw) {
  if (!plain(raw)) return undefined;
  const value = own(raw, 'raw');
  const id = own(raw, 'id');
  return {
    title: typeof own(raw, 'title') === 'string' ? own(raw, 'title') : undefined,
    raw:
      typeof value === 'string'
        ? value.trim()
        : Number.isSafeInteger(value)
          ? String(value)
          : undefined,
    icon: typeof own(raw, 'icon') === 'string' ? own(raw, 'icon') : undefined,
    id: Number.isSafeInteger(id) ? id : undefined,
    scentFound: typeof own(raw, 'scentFound') === 'boolean' ? own(raw, 'scentFound') : undefined,
  };
}

/** RSSI (dBm) -> 0..5 bars. */
export function barsOf(rssi) {
  if (rssi >= -55) return 5;
  if (rssi >= -65) return 4;
  if (rssi >= -72) return 3;
  if (rssi >= -80) return 2;
  if (rssi >= -90) return 1;
  return 0;
}

export function parseWifi(raw) {
  const r = readingOf(raw);
  if (!r) return undefined;
  if (/^-\d{1,3}$/.test(r.raw ?? '')) {
    const rssi = Number(r.raw);
    if (rssi >= -120 && rssi < 0) return { bars: barsOf(rssi), rssi };
  }
  const bars = r.icon === undefined ? undefined : WIFI_ICONS[r.icon];
  return bars === undefined ? undefined : { bars };
}

/** "70-80%" -> [70, 80]. */
function rangeOf(title) {
  const match = /^(\d{1,3})\s*-\s*(\d{1,3})\s*%$/.exec((title ?? '').trim());
  if (!match) return undefined;
  const low = Number(match[1]);
  const high = Number(match[2]);
  return low <= high && high <= 100 ? [low, high] : undefined;
}

export function parseFill(raw, generation) {
  const r = readingOf(raw);
  if (!r || !/^\d{1,9}$/.test(r.raw ?? '')) return undefined;
  const value = Number(r.raw);
  let percent =
    generation !== undefined && generation >= 3
      ? Math.min(100, value)
      : Math.max(0, Math.min(100, Math.floor(100 - value / FILL_USE_PER_PERCENT)));
  const range = rangeOf(r.title);
  if (range) percent = Math.max(range[0], Math.min(range[1], percent));
  return { percent };
}

export function parsePerfume(raw) {
  const r = readingOf(raw);
  if (!r) return undefined;
  let cartridge;
  // An empty raw is unknown (not "no cartridge"): the other fields decide.
  if (r.raw !== undefined && r.raw !== '') cartridge = r.raw !== '0';
  else if (r.id !== undefined) cartridge = r.id !== NO_CARTRIDGE_ID;
  else if (r.scentFound === true) cartridge = true;
  if (cartridge === undefined) return undefined;
  return { cartridge, name: cartridge ? cleanText(r.title) : undefined };
}

export function parseBattery(raw) {
  const r = readingOf(raw);
  if (!r) return undefined;
  if (r.icon === BATTERY_CHARGING_ICON || r.id === BATTERY_CHARGING_ID) {
    return { charging: true };
  }
  const percent = r.icon === undefined ? undefined : BATTERY_ICONS[r.icon];
  return percent === undefined ? undefined : { charging: false, percent };
}

/** The reader of each sensor, by its API key. */
export const SENSOR_READERS = {
  [SENSOR.WIFI]: (raw) => parseWifi(raw),
  [SENSOR.FILL]: (raw, generation) => parseFill(raw, generation),
  [SENSOR.PERFUME]: (raw) => parsePerfume(raw),
  [SENSOR.BATTERY]: (raw) => parseBattery(raw),
};
