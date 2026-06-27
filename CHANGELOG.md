# Changelog

## 0.5.7

- Remove obsolete suite naming from package metadata and test fixtures.

## 0.5.6

- Add an explicit GPS baseline reset endpoint and page control for deliberate simulator resets, relocation, or confirmed-good GPS recovery.

## 0.5.5

- Change the independent DR realign default to 5 minutes and add a persisted
  GPS Integrity page control for tuning it live.

## 0.5.4

- Keep Max replay GPS integrity scaling from dropping back to live-time between
  playback clock samples.

## 0.5.3

- Scale GPS jump checks and dead-reckoning propagation by AJRM Marine Logger
  replay rate, so accelerated replay is judged against source-time motion
  rather than wall-clock motion.

## 0.5.2

- Also detect AJRM Marine Logger replay boundaries from the Signal K playback
  clock during normal evaluation, so GPS integrity state resets reliably when a
  new replay file starts.
- Add a GPS Integrity page toggle to enable or disable GPS integrity alerts
  while keeping diagnostics visible.

## 0.5.1

- Reset runtime dead-reckoning state at AJRM Marine Logger replay boundaries so
  separate recordings do not inherit GPS integrity drift from previous replays.
- Count weak-signal and independent dead-reckoning discrepancy events once per
  active episode instead of once per evaluation tick.

## 0.5.0

- Initial public beta release as AJRM Marine GPS Integrity.
