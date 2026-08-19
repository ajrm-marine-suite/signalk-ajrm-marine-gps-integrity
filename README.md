# AJRM Marine Navigation Integrity (GPS Integrity)

Version `0.8.6` adds a package-root Webapps icon and disables chart cycling while Auto Charts is off, consistently
with the other suite map applications.

Version `0.8.4` adds the suite's shared COG-oriented map following to DR
Plotter. It leaves 66% of the visible chart ahead and 34% behind by default,
shares the browser setting with Display, and centres the vessel when COG is
unavailable.

One Signal K package for source-aware Navigation Reference, GPS/GNSS trust,
dead reckoning, and the charted DR Plotter. The established Signal K paths and
DR Plotter data files remain unchanged.

## Install

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-gps-integrity.git#v0.8.6 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Enable **AJRM Marine Navigation Integrity** in Signal K. Navigation Reference
is now its internal source-selection provider. Select **Open DR Plotter** from
the status page for the charted dead-reckoning display. Existing standalone
Navigation Reference settings and DR Plotter fixes, track, and settings are
loaded from their previous files during migration.

DR Plotter also displays the route currently selected in **AJRM Marine
Display**. The route is a read-only orange overlay in DR Plotter; opening,
closing or reversing it remains a Display operation, and changes appear in DR
Plotter automatically.

During GPS loss the dead-reckoning motion vector uses electronic heading
together with speed through water. By default Navigation Reference
automatically selects available non-GNSS heading sensors and an available
speed-through-water sensor. The preferred-source fields are optional priority
overrides for boats with multiple sensors; they do not need to be filled in for
the normal case. Sources declared as calculated remain excluded, and a heading
source carrying GNSS evidence is not treated as independent unless explicitly
configured. `navigation.speedOverGround` and
`navigation.courseOverGroundTrue` normally come from GNSS, so they are not
treated as independent motion evidence after GNSS is lost. The Simulator keeps
publishing `navigation.headingMagnetic` and `navigation.speedThroughWater`
while withdrawing those GNSS-derived values, matching this behaviour.
Navigation Integrity retains the last valid position only for the local WMM
magnetic-variation calculation when GNSS subsequently reports no fix. It does
not treat that retained position as a live navigation fix. This lets fresh
magnetic heading and speed through water continue to drive DR during GPS loss.

The monitor tolerates sparse and duplicated position cadence observed in real
voyages. The default GPS-loss threshold is 60 seconds; positions older than 10
seconds are explicitly labelled `delayed`, while an explicit receiver no-fix
still takes effect immediately. Position-jump speed is calculated between GPS
measurement timestamps. Small position differences within the configurable
250 ms coincidence window are treated as duplicate reports of one fix (for
example NMEA 2000 PGNs 129025 and 129029), while larger jumps are rejected.

The provider publishes:

- `vessels.self.plugins.ajrmMarineGpsIntegrity.navigationIntegrity`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.trusted.*`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.*`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.*`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.*`
- `vessels.self.notifications.navigation.gnss.integrity`

The status includes the current GPS trust level, last trusted fix, operational
dead reckoning, independent integrity dead reckoning, uncertainty radii, and
vectors for heading through water, tide/current, and course over ground.
`navigationIntegrity.diagnostics` records the observed inputs, decision flags,
thresholds, current source, and DR uncertainty used for that evaluation so
captured voyages can explain GPS loss, weak signal, jumps, and DR mismatch
events later in AJRM Marine Capture voyage review.

GPS trust and integrity assurance are deliberately separate. A coherent,
healthy GPS fix can be accepted while `integrityAssurance.status` is
`unavailable` or `reduced`. This happens, for example, before an independent
compass and water-speed input become available. The plugin does not call a
GPS-derived COG/SOG track an independent comparison.

When available, the plugin consumes the versioned navigation authority at:

`vessels.self.plugins.ajrmMarineNavigationReference.state`

The accepted contract is
`contract: "ajrm-marine-navigation-reference", schemaVersion: 1`. It uses the
provider's coherent `position` and `groundTrack`, independent
`bowHeadingTrue`/`throughWater`, explicit leeway status, and qualified atomic
`current`. When that independent current is unavailable, a fresh qualified
`ground-minus-water-residual` can be retained as a short-term operational
current correction. It remains explicitly GPS-dependent and is never admitted
to the independent integrity comparison. A provider ground-track triplet is
accepted only when it explicitly declares coherence and its position, COG, SOG,
and parent ground-track source all match; a malformed triplet is withheld rather
than repaired from raw paths. Raw Signal K remains a compatibility input when
the authority is absent, but raw magnetic heading is never treated as true
heading.
The published navigation provenance forwards the provider's selected
`clockReference` (kind, source, age, uncertainty, method, and GPS dependence)
and WMM magnetic-variation evidence so DR Plotter and voyage diagnostics can
show what directional reference was actually used.

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
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.position`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.uncertaintyRadiusMeters`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.source`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.ageSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.gpsDependent`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.leewayStatus`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.currentOrigin`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.position`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.uncertaintyRadiusMeters`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.source`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.ageSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.realignIntervalSeconds`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.assurance`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.comparisonAvailable`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.unavailableReason`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.gpsDependent`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.leewayStatus`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.currentOrigin`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.evaluations`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.acceptedFixes`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.rejectedFixes`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.positionJumps`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.lostFixes`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.degradedSignals`
- `vessels.self.plugins.ajrmMarineGpsIntegrity.counters.drDiscrepancies`

The plugin publishes Signal K metadata for its numeric projection paths:

| Projection | Signal K unit |
| --- | --- |
| `trusted.speedOverGround` | `m/s` |
| `trusted.courseOverGroundTrue` | `rad` |
| `trusted.headingTrue` | `rad` |
| `deadReckoning.*.uncertaintyRadiusMeters` | `m` |
| `deadReckoning.*.ageSeconds` | `s` |
| `deadReckoning.integrity.realignIntervalSeconds` | `s` |

In particular, `trusted.headingTrue` has always carried a Signal K true-heading
number in radians. The added `meta.units: "rad"` makes that existing contract
discoverable; it does not convert or otherwise change the numeric value.

When a current GPS fix is accepted, `trusted.position` carries that fix. When
GPS is lost or rejected, `trusted.accepted` is false and the trusted position is
cleared so consumers do not accidentally use stale GPS as live position.

Operational DR is locked to accepted GPS while GPS is healthy, then
propagates from the last trusted fix when GPS is lost or rejected. It may use
COG/SOG as an explicitly GPS-dependent fallback, or independent heading/STW and
a qualified current. If no independent current is available, it may retain the
fresh Navigation Reference ground-minus-water residual observed before the
outage. That residual can include unseparated leeway when leeway is unknown, so
it is labelled as a GPS-dependent operational correction rather than asserted
as independently measured tide. Operational DR never adds current or leeway
again to a COG/SOG over-ground vector.

Integrity DR never uses COG/SOG from the GNSS being tested. It requires
independent true heading and speed through water. A current vector is accepted
only as one fresh atomic object with a common source, timestamp, origin,
`gpsDependent` flag, and quality metadata; separate newest set and drift values
are not paired. GPS-derived ground-minus-water residuals are excluded from the
integrity comparison. Unknown leeway and compass uncertainty are exposed and
increase the uncertainty estimate.

Integrity assurance is:

- `full` when independent heading, STW, current, and known leeway are available;
- `reduced` when independent heading/STW exist but current or leeway is missing;
- `unavailable` when independent heading or STW is missing.

Only `full` assurance can produce a GPS-versus-independent-DR discrepancy
decision. A full-assurance integrity projection is independent between
realignments and is used to detect slow spoof-like drift. A GPS-realigned
projection with `reduced` or `unavailable` assurance remains labelled
GPS-dependent, so consumers cannot display it as an independent comparison.
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
- Flag poor GPS position quality using the receiver's HDOP accuracy rating
  (lower is better), or a low satellite count, when those measurements are
  available.
- Reject physically impossible GPS jumps.
- Keep a rejected position-jump warning queued until Audio delivers it or its
  freshness window expires, even if GPS state changes during speech rendering.
- Compare GPS against an independent propagated dead-reckoning estimate.
- Keep operational DR GPS-locked until GPS is unavailable, so the fallback DR
  starts from the best recent trusted position.
- Keep integrity DR independent between configured realignments so slow spoof
  drift can accumulate into a DR discrepancy instead of being reset away.
- Publish standard Signal K notifications with an AJRM Marine Notifications envelope.

## Notes

The implementation is intentionally conservative. GNSS position, SOG, COG,
method quality, satellite count, and HDOP are selected from one source rather
than mixed across receivers. Operational fallback may use a coherent COG/SOG
vector when the water-speed log is unavailable, but that path is labelled
GPS-dependent and is never used as integrity evidence. Future releases can add
longer evidence windows and chart/depth cross-checks.

> This software is Alpha Release and has not been tested in live environments
> and must not be relied upon for navigation or safety. The Authors do not
> accept any responsibility for loss or damage as a result of using this
> software.

## Public Beta

GNSS integrity monitor for AJRM Marine Suite.

AJRM Marine GPS Integrity is authored and maintained by Anthony McDonald, with
assistance from William McAusland. It builds on the Signal K project and the
work of Signal K plugin authors.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You may use, study, share, and modify it under that licence. If you modify it and make it available to users over a network, the corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want different terms.
