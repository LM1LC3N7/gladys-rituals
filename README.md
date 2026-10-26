# gladys-rituals

A [Gladys Assistant](https://gladysassistant.com) external integration for the
**Rituals Perfume Genie 2.0** diffusers, through the Rituals cloud with the
e-mail and the password of the user's Rituals account.

- One device per diffuser: diffusing (on/off), perfume intensity (1 to 3),
  perfume level, perfume name, Wi-Fi signal, and the battery of the portable
  model.
- Turning off is never blocked by a pause, a queue or a read in progress, and
  is sent again until a read shows the diffuser off.
- Polite with the Rituals cloud: one request per read of the list (every 5
  minutes by default), the sensors of one diffuser at most every 30 minutes,
  logins rationed, a refused password never tried again by itself.

**Never tested with a real diffuser**: ported from
[ritualsgenie](https://github.com/frenck/python-ritualsgenie) (MIT, the library
of the Home Assistant Rituals integration), tested against a simulated cloud.
It presents itself with its own name, never as the Rituals app.

Unofficial integration, not affiliated with Rituals.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Status, decisions and next steps: [TODO.md](TODO.md).
- Rules for contributors: [CLAUDE.md](CLAUDE.md).
- Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run cover        # regenerate cover.png (plain Node)
```

License: Apache-2.0 ([LICENSE](LICENSE)).
