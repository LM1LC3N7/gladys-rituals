// -----------------------------------------------------------------------------
// Diffusers -> Gladys devices and states (pure functions).
//
// External ids are forever: device `ext:<selector>:diffuser:<hublot>` (the
// hardware lot of the diffuser, the id Home Assistant also keys it on),
// feature `<device>:<key>` with the keys of FEATURES. The `hash` of the API
// is only a parameter: it is what the requests use, re-read from the account
// before each of them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { SENSOR, SPEED } from './constants.js';
import { FEATURE_NAMES, NO_CARTRIDGE } from './i18n.js';
import { HUBLOT } from './rituals/model.js';

const sensor = { read_only: true, has_feedback: false };

/** Every feature a diffuser may have, in the order shown. */
export const FEATURES = {
  power: {
    category: C.SWITCH,
    type: T.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  intensity: {
    category: C.FAN,
    type: T.FAN.SPEED,
    min: SPEED.min,
    max: SPEED.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  fill: {
    ...sensor,
    category: C.LEVEL_SENSOR,
    type: T.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
    unit: U.PERCENT,
    min: 0,
    max: 100,
    keep_history: true,
  },
  perfume: { ...sensor, category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false },
  wifi: {
    ...sensor,
    category: C.SIGNAL,
    type: T.SIGNAL.QUALITY,
    min: 0,
    max: 5,
    keep_history: true,
  },
  battery: {
    ...sensor,
    category: C.BATTERY,
    type: T.BATTERY.INTEGER,
    unit: U.PERCENT,
    min: 0,
    max: 100,
    keep_history: true,
  },
  charging: {
    ...sensor,
    category: C.BATTERY,
    type: T.BATTERY.CHARGING,
    min: 0,
    max: 1,
    keep_history: true,
  },
};

/** The features commanded from Gladys. */
export const COMMANDS = ['power', 'intensity'];

export const idsOf = (gladys, hublot) => gladys.externalIds('diffuser', hublot);

/** `{ hublot, key }` of a feature external id of this integration, undefined otherwise. */
export function parseFeatureId(gladys, externalId) {
  const prefix = gladys.externalId('diffuser:');
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const rest = externalId.slice(prefix.length);
  const at = rest.lastIndexOf(':');
  const hublot = rest.slice(0, at);
  const key = rest.slice(at + 1);
  return at > 0 && HUBLOT.test(hublot) && Object.hasOwn(FEATURES, key)
    ? { hublot, key }
    : undefined;
}

/** `hublot` of a device external id of this integration, undefined otherwise. */
export function parseDeviceId(gladys, externalId) {
  const prefix = gladys.externalId('diffuser:');
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const hublot = externalId.slice(prefix.length);
  return HUBLOT.test(hublot) ? hublot : undefined;
}

/** The feature keys of a diffuser: from what it supports, and what the created device has. */
export function keysOf(hub, createdKeys = new Set()) {
  const keys = new Set(['power', 'intensity']);
  if (hub.sensors?.includes(SENSOR.FILL)) keys.add('fill');
  if (hub.sensors?.includes(SENSOR.PERFUME)) keys.add('perfume');
  if (hub.sensors?.includes(SENSOR.WIFI)) keys.add('wifi');
  if (hub.sensors?.includes(SENSOR.BATTERY)) {
    keys.add('battery');
    keys.add('charging');
  }
  for (const key of createdKeys) {
    if (Object.hasOwn(FEATURES, key)) keys.add(key);
  }
  return Object.keys(FEATURES).filter((key) => keys.has(key));
}

export const nameOf = (hub) => hub.name ?? `Rituals Genie ${hub.hublot}`;

export function buildDevice(gladys, hub, language, createdKeys) {
  const ids = idsOf(gladys, hub.hublot);
  const params = [{ name: 'hublot', value: hub.hublot }];
  if (hub.firmware) params.push({ name: 'firmware', value: hub.firmware });
  return {
    name: nameOf(hub),
    external_id: ids.device,
    model: 'Perfume Genie',
    features: keysOf(hub, createdKeys).map((key) => ({
      name: FEATURE_NAMES[key][language] ?? FEATURE_NAMES[key].en,
      external_id: ids.feature(key),
      ...FEATURES[key],
    })),
    params,
  };
}

/** The states of the hub list: diffusing and intensity. */
export function hubStates(gladys, hub) {
  const ids = idsOf(gladys, hub.hublot);
  const states = [];
  if (hub.on !== undefined) {
    states.push({ device_feature_external_id: ids.feature('power'), state: hub.on ? 1 : 0 });
  }
  if (hub.speed !== undefined) {
    states.push({ device_feature_external_id: ids.feature('intensity'), state: hub.speed });
  }
  return states;
}

/** The states of the sensor readings `{ wifi, fill, perfume, battery }` (each optional). */
export function sensorStates(gladys, hublot, readings, language) {
  const ids = idsOf(gladys, hublot);
  const states = [];
  const push = (key, value) =>
    states.push({ device_feature_external_id: ids.feature(key), ...value });
  if (readings.fill) push('fill', { state: readings.fill.percent });
  if (readings.perfume) {
    push('perfume', {
      text: readings.perfume.cartridge
        ? (readings.perfume.name ?? '?')
        : (NO_CARTRIDGE[language] ?? NO_CARTRIDGE.en),
    });
  }
  if (readings.wifi) push('wifi', { state: readings.wifi.bars });
  if (readings.battery) {
    push('charging', { state: readings.battery.charging ? 1 : 0 });
    if (readings.battery.percent !== undefined) {
      push('battery', { state: readings.battery.percent });
    }
  }
  return states;
}
