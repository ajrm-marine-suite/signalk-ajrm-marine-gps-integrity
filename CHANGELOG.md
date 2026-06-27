# Changelog

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
