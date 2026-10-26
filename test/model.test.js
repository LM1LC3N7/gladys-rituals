// -----------------------------------------------------------------------------
// The answers of the API read strictly: identifiers, values, sensors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barsOf,
  parseBattery,
  parseFill,
  parseHub,
  parseHubs,
  parsePerfume,
  parseWifi,
} from '../src/rituals/model.js';
import { hub } from './helpers/fakeRituals.js';

test('a hub: identifiers, state, intensity, name, sensors', () => {
  const h = parseHub(hub({ on: '1', speed: '3', name: 'Salon\u0007 bleu' }));
  assert.equal(h.on, true);
  assert.equal(h.speed, 3);
  assert.equal(h.online, true);
  assert.equal(h.name, 'Salon bleu');
  assert.deepEqual(h.sensors, ['fillc', 'rfidc', 'wific']);
  assert.equal(h.generation, 2);
  assert.equal(h.firmware, '5.4');
});

test('values not exactly as expected are unknown, never 0 or off', () => {
  for (const [fan, speed] of [
    ['', ''],
    ['2', '0'],
    [' 1', '4'],
    [null, null],
    ['true', '2.5'],
  ]) {
    const raw = hub();
    raw.attributeValues.fanc = fan;
    raw.attributeValues.speedc = speed;
    const h = parseHub(raw);
    assert.equal(h.on, undefined, `${fan}`);
    assert.equal(h.speed, undefined, `${speed}`);
  }
  const raw = hub();
  raw.status = '1';
  assert.equal(parseHub(raw).online, undefined);
});

test('identifiers: strict patterns (no path, no colon, no dot)', () => {
  for (const hublot of ['', '../x', 'a:b', 'a.b', 'a/b', 'a b', 'x'.repeat(65), 5]) {
    assert.equal(parseHub(hub({ hublot })).reason, 'hublot', `${hublot}`);
  }
  for (const hash of ['', 'a/b', '..', 'a%2f', 'a?b', null]) {
    assert.equal(parseHub(hub({ hash })).reason, 'hash', `${hash}`);
  }
  assert.equal(parseHub(null).reason, 'not_an_object');
  assert.equal(parseHub([]).reason, 'not_an_object');
});

test('a list: duplicates all left out, a bound, not a list = undefined', () => {
  assert.equal(parseHubs({}), undefined);
  assert.equal(parseHubs(null), undefined);
  const many = Array.from({ length: 30 }, (_, i) => hub({ hublot: `L${i}`, hash: `h${i}` }));
  const { hubs, skipped } = parseHubs(many);
  assert.equal(hubs.length, 20);
  assert.equal(skipped.filter((s) => s.reason === 'limit').length, 10);
  const dup = parseHubs([hub(), hub({ hash: 'other' })]);
  assert.equal(dup.hubs.length, 0);
  // A key "__proto__" in the JSON stays a plain key.
  const polluted = JSON.parse(
    '[{"hublot":"L1","hash":"h1","attributeValues":{"__proto__":{"fanc":"1"}}}]',
  );
  assert.equal(parseHubs(polluted).hubs[0].on, undefined);
  assert.equal({}.fanc, undefined);
});

test('Wi-Fi: RSSI to 0-5 bars, the icon otherwise', () => {
  assert.deepEqual(parseWifi({ raw: '-80', icon: 'icon-signal-75.png' }), { bars: 2, rssi: -80 });
  assert.deepEqual(parseWifi({ raw: '-50' }), { bars: 5, rssi: -50 });
  assert.deepEqual(parseWifi({ raw: '', icon: 'icon-signal-low.png' }), { bars: 1 });
  assert.equal(parseWifi({ raw: '0' }), undefined);
  assert.equal(parseWifi({ raw: '-200' }), undefined);
  assert.equal(parseWifi({}), undefined);
  assert.deepEqual([-40, -60, -70, -78, -88, -95].map(barsOf), [5, 4, 3, 2, 1, 0]);
});

test('fill level: use counter within the title range; no measurement = unknown', () => {
  assert.deepEqual(parseFill({ title: '70-80%', raw: '5818' }, 2), { percent: 70 });
  assert.deepEqual(parseFill({ title: '90-100%', raw: '0' }, 2), { percent: 100 });
  assert.deepEqual(parseFill({ title: 'x', raw: '30000' }, 2), { percent: 0 });
  assert.deepEqual(parseFill({ raw: '42' }, 3), { percent: 42 });
  assert.equal(parseFill({ title: 'No measurement available', raw: '-1' }, 2), undefined);
  assert.equal(parseFill({ raw: '' }, 2), undefined);
  assert.equal(parseFill({ raw: '1e3' }, 2), undefined);
});

test('perfume: name, no cartridge, legacy ids', () => {
  assert.deepEqual(parsePerfume({ title: 'Sakura', raw: '05377650', scentFound: true }), {
    cartridge: true,
    name: 'Sakura',
  });
  assert.deepEqual(parsePerfume({ title: 'Cartridge is not loaded', raw: '0' }), {
    cartridge: false,
    name: undefined,
  });
  assert.deepEqual(parsePerfume({ id: 19, title: 'No cartridge' }), {
    cartridge: false,
    name: undefined,
  });
  assert.equal(parsePerfume({ title: 'x' }), undefined);
});

test('battery: icon levels, charging, unknown icon', () => {
  assert.deepEqual(parseBattery({ icon: 'battery-full.png' }), { charging: false, percent: 100 });
  assert.deepEqual(parseBattery({ icon: 'battery-charge.png' }), { charging: true });
  assert.deepEqual(parseBattery({ id: 21 }), { charging: true });
  assert.equal(parseBattery({ icon: 'battery-unknown.png' }), undefined);
});

test('perfume: an empty raw is unknown, not "no cartridge"', () => {
  assert.equal(parsePerfume({ title: 'x', raw: '' }), undefined);
  assert.deepEqual(parsePerfume({ title: 'Sakura', raw: '', scentFound: true }), {
    cartridge: true,
    name: 'Sakura',
  });
});
