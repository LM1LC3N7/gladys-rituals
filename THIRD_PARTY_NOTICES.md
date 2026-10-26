# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license.

## ritualsgenie (frenck/python-ritualsgenie)

<https://github.com/frenck/python-ritualsgenie>, by Franck Nijhof, the
asynchronous Python client of the Rituals Perfume Genie API used by the
Rituals Perfume Genie integration of Home Assistant (the successor of
pyrituals). Version 0.1.0 (`main` at commit ed5efb0, 2026-10-26).

Ported to JavaScript in `src/rituals/client.js` and `src/rituals/model.js`:
the base URL of the API (`https://rituals.apiv2.sense-company.com/apiv2/`),
the login (`POST account/token` with the e-mail and the password, the token
in `success`, sent back as is in `Authorization`), a refused login read from
`success: false` or a 400/401/422, the lockout message ("Too many login
attempts. Try again in N seconds"), a 401 on a token just obtained or about a
diffuser "not linked" that a new login does not cure, Retry-After on a 429, the
endpoints (`account/hubs`, `account/hubs/<hash>`,
`hubs/<hash>/sensors/<sensor>`, `POST hubs/<hash>/attributes/<attribute>`), the
attributes (`fanc` on/off, `speedc` intensity 1 to 3, `roomnamec` the name)
and their string values, `status` 1 online / 0 offline, the sensors
(`wific`, `fillc`, `rfidc`, `battc`) with the battery and Wi-Fi levels of the
app icons, the fill level from the use counter of the cartridge (10 % per
2000, clamped into the range of its title, `-1` for no measurement), `0` for
no cartridge and the legacy ids 19 (no cartridge) and 21 (charging). The test
answers in `test/helpers/fakeRituals.js` are shaped after the recorded
answers of the library.

Like the library, the integration sends its own User-Agent
(`gladys-rituals`), never the one of the Rituals app, and no key nor client
identifier of the app.

Changed here: identifiers checked against strict patterns, a value not
exactly as expected read as unknown (never 0), the token expiry compared with
the Date header of Rituals (never the clock of Gladys), the Wi-Fi level as the
0-5 bars of Gladys, logins rationed and a refused password kept until it
changes, a pause on 429 kept across restarts, a turn off that is never
blocked and is tried again (30 minutes, three sends at most) until a read
shows the diffuser off. A 400/422 of the login counts as refused only with a
message about the credentials. The room size,
the standby LED, the firmware update and the hublot details of the library
are not ported.

Its license, reproduced as it appears in the repository:

```text
# MIT License

Copyright (c) 2026 Franck Nijhof

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
