# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the Rituals Perfume Genie 2.0
diffusers: a Node.js service (Node 22+, ESM, no build step) that runs in its
own sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the diffusers of a Rituals account
through the Rituals cloud API (ported from ritualsgenie, MIT) and turns them
on and off and sets their intensity. See `TODO.md` for the status and every
decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "turn off"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # regenerate cover.png (plain Node)
```

## Architecture

```
index.js                 SDK wiring only (src/handlers.js)
src/handlers.js          every SDK handler, registered before connect()
src/app.js               RitualsApp: start, pace, logins, pauses, states, commands, turn off
src/rituals/http.js      the only network access (HTTPS, size cap, no redirect, "sent" or not)
src/rituals/client.js    the account: login, token expiry from Date, 401 handling, calls
src/rituals/model.js     answers -> diffusers and sensor values (pure, strict)
src/devices.js           Gladys devices and states (pure)
src/config.js            normalization of the form
src/store.js             /data: pace, logins, pause, lockout, refusal, diffusers, turns off
src/i18n.js              statuses and messages (en / fr)
test/                    node --test, fake Gladys (SDK) + fake Rituals cloud + loopback HTTP
```

## Rules

- **External ids are forever**: `diffuser:<hublot>` and the feature keys of
  `src/devices.js` FEATURES. The same goes for the manifest keys.
- **No app identity**: our own User-Agent (`gladys-rituals`), never the one of
  the Rituals app, no key nor client id of the app. Any change needs Louis.
- **Turn off is protective**: it never waits for a read, a pause, the login
  spacing or a queue; its refusals are listed in `docs/en.md` and must stay
  exact. Any new command needs Louis's decision.
- **Polite polling**: one request for the list per interval, the sensors of
  one diffuser per read at most every 30 min, logins rationed. Never add a
  request outside `RitualsClient`.
- **Secrets**: the password, the e-mail and the token are never in a log, an
  error message, a status, a state or /data (`test/app.test.js` checks it).
  /data keeps an 8-bit marker of a refused password and a salted hash of the
  e-mail.
- **Clocks**: one read of the monotonic clock per decision (`dueAt(mono)`);
  the wall clock only dates /data. Tests use a clock that moves at every
  read; `test/realclock.test.js` runs on the real clock.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  them by hand (0.1.0 was set by hand once). `test/manifest.test.js` checks
  they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }`; a secret field has no
  default and is described as kept by Gladys in its database, never shown
  again, never as protected by any cipher.
- **Units**: only those the core lists for the category.
- **Encoding.** UTF-8 without BOM, no mojibake (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
