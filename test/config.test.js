import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

test('credentials: a password without an e-mail is refused; controls refused', () => {
  assert.equal(normalizeConfig({}).problem, 'missing_credentials');
  assert.equal(normalizeConfig({ password: 'x' }).problem, 'missing_email');
  assert.equal(normalizeConfig({ email: 'a@b.c' }).problem, 'missing_password');
  assert.equal(normalizeConfig({ email: 'a@b.c\r\n', password: 'x' }).problem, undefined);
  assert.equal(normalizeConfig({ email: 'a@b\nc', password: 'x' }).problem, 'invalid_email');
  assert.equal(normalizeConfig({ email: 'ab.c', password: 'x' }).problem, 'invalid_email');
  assert.equal(normalizeConfig({ email: 'a@b.c', password: 'x\ny' }).problem, 'invalid_password');
  const ok = normalizeConfig({ email: ' a@b.c ', password: ' p ' });
  assert.equal(ok.email, 'a@b.c');
  assert.equal(ok.password, ' p ', 'a password is never trimmed');
});

test('poll interval bounded, empty = default; language fr/en', () => {
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 120);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, DEFAULTS.poll_interval);
  assert.equal(normalizeConfig({ poll_interval: null }).pollInterval, DEFAULTS.poll_interval);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, DEFAULTS.poll_interval);
  assert.equal(normalizeConfig({ language: 'EN' }).language, 'en');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});
