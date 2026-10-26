// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, POLL_INTERVAL } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { parseHub } from '../src/rituals/model.js';
import { hub } from './helpers/fakeRituals.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; the version set by hand everywhere, never frozen here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0 (TODO.md)');
  assert.equal(manifest.countries, undefined);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-rituals:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-rituals');
  assert.equal(lock.name, 'gladys-rituals');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['appliances']);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial, not affiliated with Rituals/);
  assert.match(fields.intro.description.fr, /Non officiel, sans lien avec Rituals/);
  assert.match(read('docs/en.md'), /never been tested with a real diffuser/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai diffuseur/i);
});

test('the license and the notices ship in the image; no person named in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  assert.match(
    read('THIRD_PARTY_NOTICES.md'),
    /ritualsgenie[\s\S]*MIT License[\s\S]*Franck Nijhof/,
  );
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; the secret without default, described as kept', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'email',
    'password',
    'poll_interval',
    'language',
  ]);
  assert.equal(fields.poll_interval.min, POLL_INTERVAL.min);
  assert.equal(fields.poll_interval.max, POLL_INTERVAL.max);
  for (const option of fields.language.options) {
    assert.equal(typeof option.value, 'string');
    assert.equal(typeof option.label.en, 'string');
  }
  assert.equal(fields.password.type, 'secret');
  assert.ok(
    manifest.config_schema.filter((f) => f.type === 'secret').every((f) => !('default' in f)),
  );
  assert.match(
    fields.password.description.en,
    /Kept by Gladys in its database, never shown again, sent only to Rituals/,
  );
  assert.match(
    fields.password.description.fr,
    /Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à Rituals/,
  );
  assert.ok(
    !manifest.config_schema.some((f) => f.key.startsWith('gladys_')),
    'GLADYS_* is the core',
  );
  assert.doesNotMatch(JSON.stringify(manifest), /chiffré|encrypted|hachage/i);
});

test('sections store nothing', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions), Object.values(ACTIONS));
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(', 'onDeviceCreated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('features: units only those the core lists for the category; no switch for anything sensitive', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core (server/utils/constants.js), the categories used here.
  const allowed = {
    battery: ['percent'],
    'level-sensor': ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile', 'percent'],
  };
  const gladys = createFakeGladys({ selector: 'rituals' });
  const device = buildDevice(gladys, parseHub(hub({ battery: true })), 'en');
  assert.equal(device.features.length, 7);
  for (const feature of device.features) {
    assert.ok(feature.category && feature.type, feature.name);
    assert.equal(feature.supported_options, undefined);
    if (feature.unit === undefined) continue;
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(feature.unit));
    assert.ok(
      allowed[feature.category]?.includes(feature.unit),
      `${feature.name}: ${feature.unit}`,
    );
  }
  // The only switch: diffusing, a plain on/off of a perfume diffuser.
  const switches = device.features.filter((f) => f.category === 'switch');
  assert.deepEqual(
    switches.map((f) => f.external_id.split(':').pop()),
    ['power'],
  );
  assert.deepEqual(
    device.features.filter((f) => !f.read_only).map((f) => f.external_id.split(':').pop()),
    ['power', 'intensity'],
  );
});
