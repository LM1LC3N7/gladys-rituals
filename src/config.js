// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized and checked.
// -----------------------------------------------------------------------------

import { POLL_INTERVAL } from './constants.js';

export const LANGUAGES = ['fr', 'en'];

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = { poll_interval: POLL_INTERVAL.default, language: 'fr' };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * `{ email, password, pollInterval, language, problem }`. `problem`: why the
 * account cannot be used (`missing_credentials`, `missing_email`,
 * `missing_password`, `invalid_email`, `invalid_password`), undefined when it
 * can: a password without an e-mail is never sent anywhere.
 */
export function normalizeConfig(raw = {}) {
  const email = typeof raw?.email === 'string' ? raw.email.trim() : '';
  const password = typeof raw?.password === 'string' ? raw.password : '';
  const interval = Number(raw?.poll_interval);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  let problem;
  if (email === '' && password === '') problem = 'missing_credentials';
  else if (email === '') problem = 'missing_email';
  else if (password === '') problem = 'missing_password';
  else if (
    email.length > 254 ||
    CONTROL.test(email) ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    email.includes(' ')
  ) {
    problem = 'invalid_email';
  } else if (password.length > 256 || CONTROL.test(password)) {
    problem = 'invalid_password';
  }
  return {
    email,
    password,
    problem,
    pollInterval:
      raw?.poll_interval !== '' &&
      raw?.poll_interval !== null &&
      raw?.poll_interval !== undefined &&
      Number.isFinite(interval)
        ? Math.round(Math.max(POLL_INTERVAL.min, Math.min(POLL_INTERVAL.max, interval)))
        : DEFAULTS.poll_interval,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
