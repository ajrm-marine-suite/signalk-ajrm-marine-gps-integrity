# AJRM Marine GPS Integrity

Signal K plugin and small status webapp for monitoring GPS/GNSS trust and
publishing a dead-reckoning state for AJRM Marine apps.

`v0.5.11` treats a healthy fixed GPS position with zero SOG/STW as stationary
for the independent DR comparison, so tide alone does not create a false
spoofing alarm while tied up. Lost GPS still allows DR to drift with tide.

The provider publishes:

- `vessels.self.plugins.ajrmMarineGpsIntegrity.navigationIntegrity`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.*`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.*`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.*`
- `vessels.self.notifications.navigation.gnss.integrity`

The status includes the current GPS trust level, last trusted fix, operational
dead reckoning, independent integrity dead reckoning, uncertainty radii, and
vectors for heading through water, tide/current, and course over ground.

This plugin owns the safety decision. Display apps should render its state
rather than deriving their own GPS integrity policy from raw Signal K values.
It does not overwrite the raw Signal K navigation paths.

## Projection paths

Apps that want a filtered navigation feed can subscribe to:

- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.accepted`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.position`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.speedOverGround`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.courseOverGroundTrue`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.headingTrue`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.timestamp`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.source`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.rejectionReason`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.position`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.uncertaintyRadiusMeters`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.source`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.ageSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.position`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.uncertaintyRadiusMeters`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.source`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.ageSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.position`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.uncertaintyRadiusMeters`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.source`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.ageSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.realignIntervalSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.evaluations`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.acceptedFixes`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.rejectedFixes`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.positionJumps`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.lostFixes`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.degradedSignals`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.drDiscrepancies`

When a current GPS fix is accepted, `trusted.position` carries that fix. When
GPS is lost or rejected, `trusted.accepted` is false and the trusted position is
cleared so consumers do not accidentally use stale GPS as live position.

The flat `deadReckoning.*` paths remain as compatibility aliases for operational
DR. Operational DR is locked to accepted GPS while GPS is healthy, then
propagates from the last trusted fix when GPS is lost or rejected. Integrity DR
is independent between realignments and is used to detect slow spoof-like drift.
Its default realign interval is 300 seconds (5 minutes). The GPS Integrity page
labels this as the **Spoofing check reset interval**: it controls how often the
independent DR comparison track is reset to trusted GPS while GPS is healthy.
Shorter intervals reduce normal drift warnings; longer intervals give slow
spoofing more time to show as a GPS-versus-DR mismatch.

The counters reset when the plugin starts, but do not begin incrementing until
the first trusted GPS fix. They are intended for voyage review and soak testing:
accepted fixes, rejected fixes, detected position jumps, lost GPS outages,
weak-signal evaluations, and DR discrepancy evaluations. A continuous GPS outage
counts once until GPS recovers; it does not increment once per evaluation
interval.

## First scope

- Detect missing or invalid own-vessel position.
- Flag degraded HDOP or satellite count when available.
- Reject physically impossible GPS jumps.
- Compare GPS against an independent propagated dead-reckoning estimate.
- Keep operational DR GPS-locked until GPS is unavailable, so the fallback DR
  starts from the best recent trusted position.
- Keep integrity DR independent between configured realignments so slow spoof
  drift can accumulate into a DR discrepancy instead of being reset away.
- Publish standard Signal K notifications with a Notifications Plus envelope.

## Notes

The first implementation is intentionally conservative. It uses live Signal K
snapshot values and simple propagation from heading, speed through water, and
current when available. If the water-speed log is near zero but SOG/COG show
clear movement, dead reckoning falls back to SOG/COG because paddle and log
sensors can read zero at low speeds. Future releases can add weighted evidence
windows, multiple GNSS receivers, sensor freshness scoring, and chart/depth
cross-checks.


## Public Beta

GNSS integrity monitor for AJRM Marine Suite.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
