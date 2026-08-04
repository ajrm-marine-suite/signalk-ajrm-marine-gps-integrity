# Changelog

## 0.6.8

- Translate poor-HDOP warnings into plain English, explaining that the GPS
  position-quality rating is poor and that lower values are better, while
  retaining the measured rating and configured limit.
- Clarify the HDOP setting and status-page label without removing the standard
  technical term.

## 0.6.7

- Consume the explicit AJRM Marine Capture replay contract instead of the
  retired Logger API/path.
- Use Capture's `replayOriginalAt` as logical voyage time while sensor
  timestamps are refreshed for Signal K.

## 0.6.6

- Evaluate replay measurements against Logger's logical replay clock so a
  paused or starved replay cannot manufacture GPS-age alarms from wall time.
- Remap newly observed replay measurement timestamps onto that logical clock,
  preserving correct age and position-jump intervals even after a long host
  stall.

## 0.6.5

- Coalesce small, near-simultaneous position differences from duplicate GNSS
  reports of one measurement epoch, such as NMEA 2000 PGNs 129025 and 129029,
  instead of interpreting their millisecond spacing as impossible boat speed.
- Continue to reject large near-simultaneous jumps and expose the configurable
  coincidence window in plugin settings and diagnostics.
- Raise the default GPS-loss age from 30 to 60 seconds for the sparse fixes
  observed on a busy real NMEA 2000 network. Delayed status at 10 seconds and
  immediate explicit no-fix handling are unchanged.

## 0.6.4

- Calculate implied GPS speed between position measurement timestamps instead
  of one-second evaluator timestamps, so plausible movement across a sparse
  GNSS stream is not rejected as a position jump.
- Keep measurement time separate from acceptance time, avoid counting repeated
  evaluations of one cached fix as new fixes, and propagate operational DR
  between genuinely new measurements.
- Raise the default GPS-loss age to 30 seconds, label valid positions older
  than 10 seconds as `delayed`, and retain immediate loss for explicit no-fix
  evidence.
- Suppress startup GPS-loss notification delivery while Logger replay is still
  warming up and no first replay fix has been received.

## 0.6.3

- Consume explicit GNSS fix status and quality evidence from Navigation
  Reference even when that provider withholds position and ground track.
- Preserve `explicitGpsUnavailable`, no-fix wording, satellite count, HDOP, and
  evidence timestamps across the provider boundary instead of reducing an
  explicit receiver failure to generic missing-position state.

## 0.6.2

- Publish Signal K metadata for trusted SOG (`m/s`), true COG and heading
  (`rad`), and dead-reckoning distance/time projections (`m` and `s`).
  Numeric values are unchanged; this fixes unit discovery for the Signal K
  Data Browser and other interoperable clients.

## 0.6.1

- Consume AJRM Marine Navigation Reference schema v1 when available and retain
  explicit source, freshness, uncertainty, GPS-dependence, current origin, and
  leeway provenance.
- Keep GNSS position, SOG, COG, method quality, satellite count, and HDOP on
  one selected source.
- Separate operational fallback DR from integrity comparison DR. Integrity DR
  no longer uses the GNSS-under-test COG/SOG or GPS-derived current/residual.
- Require current as a fresh atomic same-source vector with explicit origin,
  GPS-dependence, and quality metadata; do not pair raw set and drift
  independently.
- Retain a fresh qualified Navigation Reference ground-minus-water residual as
  GPS-dependent operational current when independent current is unavailable,
  while continuing to exclude it from integrity DR.
- Report full, reduced, or unavailable integrity assurance and expose unknown
  leeway in the state, projection paths, diagnostics, and status page.
- Withhold malformed mixed-source Navigation Reference ground triplets, and do
  not label reduced or unavailable GPS-realigned integrity projections as
  GPS-independent.
- Stop treating magnetic heading as true heading and avoid adding current or
  leeway twice to an over-ground vector.

## 0.5.24

- Track dead-reckoning discrepancy state from the numeric evaluator result
  instead of re-reading the English reason text.

## 0.5.23

- Expand GPS speed warning wording from `kn` to `knots` so Piper and other
  speech engines do not read the unit abbreviation awkwardly.

## 0.5.22

- Treat a coherent GPS track that remains above the configured maximum boat
  speed as one sustained degraded GPS condition, rather than alternating every
  evaluation between "position jump" and "track is now smooth".
- Keep sustained over-speed GPS fixes out of the trusted baseline and skip
  secondary DR-mismatch escalation for that already-untrusted GPS stream.
- Lower GPS suspect/lost audio priority below traffic collision alarms so GPS
  integrity context cannot starve collision-alarm speech.

## 0.5.14

- For lost-GPS wording, report how recently a GPS position was received instead
  of how long ago GPS Integrity last accepted a trusted fix. This avoids
  misleading messages after a period of suspect/rejected GPS fixes.

## 0.5.13

- Add an explicit tide/current-only dead-reckoning source so operational DR
  continues to drift when GPS is lost, SOG/COG are unavailable or zero, and the
  boat has no reliable heading/STW vector.

## 0.5.12

- Add Signal K AppStore relationship metadata recommending DR Plotter as the
  visual companion for GPS integrity and dead-reckoning output.
- Add the reusable Signal K plugin CI workflow.

## 0.5.9

- Add a manual observed-fix endpoint so a skipper can rebase trusted position
  and operational dead reckoning from bearings, transits, radar, or another
  non-GPS fix while GPS remains unavailable.

## 0.5.8

- Avoid double-counting tide/current when independent dead reckoning falls back
  to COG/SOG, which already represents motion over the ground.
- Keep operational dead reckoning drifting on tide/current when GPS is lost and
  the boat is stopped.

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
