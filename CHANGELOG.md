# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the Rituals Perfume Genie 2.0 diffusers of a Rituals
  account, through the Rituals cloud, ported from ritualsgenie. One device per
  diffuser: diffusing (on/off), perfume intensity (1 to 3), perfume level,
  perfume name, Wi-Fi signal, battery and charging (portable model).
- Commands confirmed by a read back of the diffuser; follow-up reads 5 and 20
  seconds later when Rituals does not show the value yet.
- Turning off is a protective command: never paused, never queued, logs in
  when needed, cancels the commands waiting, kept in /data and tried again
  for 30 minutes (three sends that reached Rituals at most) until a read
  shows the diffuser off; a turn off clicked before the configuration is read
  is kept too.
- Logins rationed, a refused password kept until it changes or the test
  button succeeds, a lockout and a 429 pause kept across restarts.
- A "Test the connection" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-rituals/commits/main
