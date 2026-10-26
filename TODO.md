# TODO — Rituals Perfume Genie v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm audit --omit=dev`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (lot 16).

## Status

- [x] **Milestone 1 — core** (2026-10-26): Rituals cloud client ported from
      ritualsgenie 0.1.0 (login, token, list, one hub, sensors, attributes),
      one device per diffuser (diffusing, intensity, level, perfume, Wi-Fi,
      battery, charging), commands confirmed by a read back, turn off
      protective (kept in /data, sent again), logins rationed, refusal,
      lockout and 429 pause kept in /data, test button. Tested against the
      SDK's fake Gladys, a fake Rituals cloud, real loopback HTTP servers
      and a real-clock test. **Never tested with a real diffuser.**
- [ ] **Milestone 2 — real account** (a tester with a Genie 2.0): check
  - whether `account/hubs` still carries `status`, `attributeValues` and
    `sensors` as in the recorded answers of ritualsgenie;
  - how fast an attribute written shows in `account/hubs/<hash>` (the read
    back within 3.5 s may say "not applied yet" every time: then rely on the
    follow-up reads only);
  - the RSSI bounds of `wific` (the 0-5 bars are a guess), the fill level of
    a refilled cartridge (the use counter does not go back, per Rituals);
  - whether the token really lives an hour and whether `Date` is always sent;
  - what Rituals answers when the diffuser is offline and a command is sent.
- [ ] **Later** (ask on the forum first): the room size, the standby LED, the
      firmware update (ritualsgenie has them), the Genie 1.0 (older API).

## Decisions

- **Version 0.1.0 set by hand** (package.json, package-lock.json, manifest,
  `docker_image` tag) before the first release. Versions belong to the
  Release workflow from then on.
- **SDK `^0.16.0`** (the template's): published on npm (registry `latest`
  0.16.0, 2026-10-25; a cached `npm view` may still say 0.15.0).
- **No app identity**: checked in ritualsgenie 0.1.0 (`const.py`,
  `ritualsgenie.py`): its only header of its own is `User-Agent:
PythonRitualsGenie`, no key, no client id, no signature. This integration
  sends `User-Agent: gladys-rituals`, `Accept`, and the token. Nothing to ask
  Louis.
- **Ids**: device `diffuser:<hublot>` (the hardware lot, what Home Assistant
  keys on), features `power`, `intensity`, `fill`, `perfume`, `wifi`,
  `battery`, `charging`. The `hash` of the API is re-read from the list
  before each request; a hublot or hash shared by two hubs leaves both out.
- **Features**: diffusing `switch/binary` (allowed by the proposal: a perfume
  diffuser, no safety stake), intensity `fan/speed` 1-3, level
  `level-sensor/liquid-level-percent` %, perfume `text`, Wi-Fi `signal` 0-5
  (from the RSSI; the core has no dBm unit), battery `battery/integer` % and
  `battery/charging`. No scene trigger nor action in v1.
- **Pace**: list every `poll_interval` (120-3600 s, default 300), the
  sensors (one request each) of the one diffuser whose readings are the
  oldest, at most every 30 min, dated with the start of the read. The time
  of the last read is in /data before the request (every 5 min at most);
  failures never retry sooner than the interval.
- **Logins**: token in memory only (never in /data). Renewed 1 min before
  `exp`, compared with the `Date` of Rituals; no `Date` or no `exp`: used
  until a 401. Automatic logins at least 2 min apart (the time of the attempt
  in /data before it), a click after a failed login 30 s. A 401 on a fresh
  token is "token refused", spaced from the interval doubled to 1 h, never a
  refused password.
- **Refused password**: an 8-bit salted marker of the refused password and a
  salted hash of the e-mail in /data; no automatic try until the e-mail or
  the password changes, or the test button succeeds (one login per click).
  Turn off refused while it stands.
- **Lockout** ("Too many login attempts… N seconds"): kept in /data
  (bounded 1 min-6 h); no login until it ends, turn off included (kept).
- **Pauses**: 429 (any path) and 5xx of a read: Retry-After or 1 min doubled,
  6 h max, kept in /data; commands refused during it except turn off. A 5xx
  on a command or a sensor concerns that diffuser only (no pause).
- **Turn off = protective** (fiche): out of the queue, cancels the waiting
  commands at once, logs in when needed (not when refused or locked), cuts a
  read silent for 1 s (not a failure), retried within 250 ms when it never
  left (3 attempts), kept in /data (written without being awaited: a turn
  off never waits for the disk), sent again every minute, 3 sends in all,
  within 30 min, until a read started after it shows `fanc` "0", unless a
  newer command left (the number set in `beforeSend`, undone on 4xx/429 or
  when nothing left). After a command in flight when the turn off left, the
  turn off is sent again. At start, a kept turn off leaves once the
  configuration is read (credentials needed), before the first read. A 5xx
  or no answer: "sent without confirmation", kept.
- **Turn on / intensity**: per-diffuser queue of 2 waiting; refused with
  nothing sent during a pause, while refused, for an offline or unknown
  diffuser; values checked (0/1, integer 1-3). Success shown only by the
  read back (`account/hubs/<hash>`, same hublot); otherwise follow-up list
  reads at 5 s and 20 s (one request for all). The ack resolves for anything
  sent (Gladys does not show it), fails for "nothing sent" and 4xx.
- **Freshness**: a read started before a command never publishes that
  diffuser's diffusing/intensity; a device created gets the list values when
  read within 2 intervals, the sensor values within 2 h; nothing republished
  at a reconnection (the SDK's change cache is cleared, the next read
  sends).
- **Offline diffuser** (`status` 0): no state published, badge unreachable
  (degraded, message).
- **/data** unreadable (anything but ENOENT): never written over; a write
  failure only logs (no sensitive command here).
- **Network**: node:https, one request per connection, no redirect, 256 KB
  cap cut while reading, 10 s per read request, the command within 2.5 s and
  its read back within the 3.5 s ack budget.
- **Not in the manifest**: `keywords`, `countries` (need a newer
  `gladys_version`); categories `appliances`.
