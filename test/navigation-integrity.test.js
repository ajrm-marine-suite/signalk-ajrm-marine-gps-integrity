"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateNavigationIntegrity, _private } = require("../plugin/lib/navigation-integrity");

test("accepts a first valid GPS fix", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    hdop: 1.2,
    satellites: 8,
  });
  assert.equal(state.trust, "normal");
  assert.equal(state.acceptedGps, true);
  assert.deepEqual(state.lastTrustedFix.position, { latitude: 56, longitude: -5 });
});

test("flags an impossible position jump as suspect", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:01.000Z",
    position: { latitude: 56.1, longitude: -5 },
  }, first);
  assert.equal(second.trust, "suspect");
  assert.equal(second.acceptedGps, false);
  assert.match(second.reasons.join(" "), /Position jump/);
  assert.equal(second.counters.evaluations, 2);
  assert.equal(second.counters.acceptedFixes, 1);
  assert.equal(second.counters.rejectedFixes, 1);
  assert.equal(second.counters.positionJumps, 1);
  assert.equal(second.counters.lostFixes, 0);
});

test("accepts a smooth shifted GPS track as a degraded baseline reset", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: Math.PI / 2,
    speedThroughWater: 5,
  });
  const jumped = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:01.000Z",
    position: { latitude: 56.01, longitude: -5 },
    headingTrue: Math.PI / 2,
    speedThroughWater: 5,
  }, first);
  assert.equal(jumped.trust, "suspect");
  assert.ok(jumped.pendingGpsCandidate);

  const continued = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:02.000Z",
    position: { latitude: 56.01, longitude: -4.99994 },
    headingTrue: Math.PI / 2,
    speedThroughWater: 5,
  }, jumped);
  assert.equal(continued.trust, "degraded");
  assert.equal(continued.acceptedGps, true);
  assert.equal(continued.pendingGpsCandidate, null);
  assert.deepEqual(continued.lastTrustedFix.position, { latitude: 56.01, longitude: -4.99994 });
  assert.match(continued.reasons.join(" "), /new track is now smooth/);
});

test("does not accept a second impossible shifted point as smooth", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  });
  const jumped = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:01.000Z",
    position: { latitude: 56.01, longitude: -5 },
  }, first);
  const jumpedAgain = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:02.000Z",
    position: { latitude: 56.03, longitude: -5 },
  }, jumped);
  assert.equal(jumpedAgain.trust, "suspect");
  assert.equal(jumpedAgain.acceptedGps, false);
});

test("propagates dead reckoning using heading, STW, and current", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 2,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
    fixValid: false,
  }, first);
  assert.equal(second.trust, "lost");
  assert.ok(second.deadReckoning.position.latitude > 56);
  assert.ok(second.deadReckoning.position.longitude > -5);
  assert.equal(second.deadReckoning.source, "heading-stw-current");
  assert.equal(second.counters.lostFixes, 1);
});

test("falls back to SOG and COG when the water speed log reads zero while moving", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
    fixValid: false,
  }, first);

  assert.equal(second.deadReckoning.source, "cog-sog");
  assert.ok(second.deadReckoning.position.longitude > -5);
  assert.ok(Math.abs(second.deadReckoning.position.latitude - 56) < 0.00002);
});

test("uses tide-only dead reckoning when GPS is lost and the boat has no reliable motion vector", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
    fixValid: false,
  }, first);

  assert.equal(second.deadReckoning.source, "tide-current");
  assert.ok(second.deadReckoning.position.longitude > -5);
  assert.equal(second.vectors.courseOverGround.source, "tide-current");
});

test("uses tide-only dead reckoning when STW is present but heading is unavailable during GPS loss", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedThroughWater: 2,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: 0,
    currentDrift: 1,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    speedThroughWater: 2,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: 0,
    currentDrift: 1,
    fixValid: false,
  }, first);

  assert.equal(second.deadReckoning.source, "tide-current");
  assert.ok(second.deadReckoning.position.latitude > 56);
});

test("does not add tide again when independent DR uses COG/SOG", () => {
  const start = { latitude: 56, longitude: -5 };
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
  }, null, {
    warningDrDiscrepancyMeters: 5,
    alarmDrDiscrepancyMeters: 50,
  });

  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: _private.destinationMeters(start, 15, 0),
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
  }, first, {
    warningDrDiscrepancyMeters: 5,
    alarmDrDiscrepancyMeters: 50,
  });

  assert.equal(second.trust, "normal");
  assert.equal(second.integrityDeadReckoning.source, "cog-sog");
  assert.doesNotMatch(second.reasons.join(" "), /independent dead reckoning/);
});

test("falls back to course over ground when heading is unavailable", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedThroughWater: 2,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    speedThroughWater: 2,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
    fixValid: false,
  }, first);

  assert.equal(second.deadReckoning.source, "cog-sog");
  assert.ok(second.deadReckoning.position.longitude > -5);
  assert.equal(second.vectors.headingThroughWater.available, false);
  assert.equal(second.vectors.courseOverGround.available, true);
});

test("ignores stale cached heading and falls back to COG/SOG", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    positionTimestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    headingTrueTimestamp: "2026-06-22T12:00:00.000Z",
    speedThroughWater: 2,
    speedThroughWaterTimestamp: "2026-06-22T12:00:00.000Z",
    speedOverGround: 1.5,
    speedOverGroundTimestamp: "2026-06-22T12:00:00.000Z",
    courseOverGroundTrue: Math.PI / 2,
    courseOverGroundTrueTimestamp: "2026-06-22T12:00:00.000Z",
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:20.000Z",
    positionTimestamp: "2026-06-22T12:00:20.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    headingTrueTimestamp: "2026-06-22T12:00:00.000Z",
    speedThroughWater: 2,
    speedThroughWaterTimestamp: "2026-06-22T12:00:20.000Z",
    speedOverGround: 1.5,
    speedOverGroundTimestamp: "2026-06-22T12:00:20.000Z",
    courseOverGroundTrue: Math.PI / 2,
    courseOverGroundTrueTimestamp: "2026-06-22T12:00:20.000Z",
  }, first, {
    gpsLostSeconds: 15,
  });

  assert.equal(second.trust, "normal");
  assert.equal(second.gps.headingTrue, null);
  assert.equal(second.operationalDeadReckoning.source, "gps-locked");
  assert.equal(second.integrityDeadReckoning.source, "cog-sog");
  assert.equal(second.vectors.headingThroughWater.available, false);
  assert.equal(second.vectors.courseOverGround.available, true);
});

test("counts a continuous GPS outage once until GPS recovers", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:01.000Z",
    position: null,
    fixValid: false,
  }, first);
  const stillLost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:02.000Z",
    position: null,
    fixValid: false,
  }, lost);
  const recovered = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:03.000Z",
    position: { latitude: 56, longitude: -5 },
  }, stillLost);
  const lostAgain = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:04.000Z",
    position: null,
    fixValid: false,
  }, recovered);

  assert.equal(lost.counters.lostFixes, 1);
  assert.equal(stillLost.counters.lostFixes, 1);
  assert.equal(recovered.counters.lostFixes, 1);
  assert.equal(lostAgain.counters.lostFixes, 2);
});

test("treats a stale cached Signal K position as lost GPS", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    positionTimestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
  });
  const stale = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:16.000Z",
    positionTimestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
  }, first, {
    gpsLostSeconds: 15,
    warningDrDiscrepancyMeters: 5,
  });

  assert.equal(stale.trust, "lost");
  assert.equal(stale.acceptedGps, false);
  assert.equal(stale.gps.fixValid, false);
  assert.equal(stale.gps.positionAgeSeconds, 16);
  assert.match(stale.reasons.join(" "), /GPS position is stale/);
  assert.equal(stale.counters.lostFixes, 1);
  assert.equal(stale.counters.drDiscrepancies, 0);
});

test("fresh GPS rejected by independent DR mismatch stays suspect, not lost", () => {
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedOverGround: 2.2,
    courseOverGroundTrue: Math.PI / 2,
  }, null, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 40,
    gpsLostSeconds: 15,
    integrityDrRealignSeconds: 300,
  });

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:25.000Z",
    position: { latitude: 56, longitude: -5 },
    positionTimestamp: "2026-06-22T12:00:25.000Z",
    speedOverGround: 2.2,
    courseOverGroundTrue: Math.PI / 2,
  }, state, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 40,
    gpsLostSeconds: 15,
    integrityDrRealignSeconds: 300,
  });

  assert.equal(state.gps.fixValid, true);
  assert.equal(state.trust, "suspect");
  assert.equal(state.acceptedGps, false);
  assert.match(state.reasons.join(" "), /GPS differs from independent dead reckoning/);
  assert.match(state.reasons.join(" "), /Last trusted GPS fix is 25 seconds old/);
  assert.equal(state.counters.lostFixes, 0);
});

test("lost GPS reports time since last received position, not stale trusted baseline", () => {
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedOverGround: 2.2,
    courseOverGroundTrue: Math.PI / 2,
  }, null, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 40,
    gpsLostSeconds: 15,
    integrityDrRealignSeconds: 300,
  });

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:06:00.000Z",
    position: { latitude: 56, longitude: -5 },
    positionTimestamp: "2026-06-22T12:06:00.000Z",
    speedOverGround: 2.2,
    courseOverGroundTrue: Math.PI / 2,
  }, state, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 40,
    gpsLostSeconds: 15,
    integrityDrRealignSeconds: 300,
  });

  assert.equal(state.trust, "suspect");
  assert.match(state.reasons.join(" "), /Last trusted GPS fix is 360 seconds old/);

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:06:02.000Z",
    position: null,
    fixValid: false,
  }, state, {
    gpsLostSeconds: 15,
  });

  assert.equal(state.trust, "lost");
  assert.match(state.reasons.join(" "), /GPS position was last received 2 seconds ago/);
  assert.doesNotMatch(state.reasons.join(" "), /Last trusted GPS fix is 362 seconds old/);
});

test("does not count startup with no GPS as an outage before the first trusted fix", () => {
  const startup = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: null,
    fixValid: false,
  });
  const firstFix = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:01.000Z",
    position: { latitude: 56, longitude: -5 },
  }, startup);

  assert.equal(startup.trust, "lost");
  assert.equal(startup.counters.evaluations, 0);
  assert.equal(startup.counters.lostFixes, 0);
  assert.equal(firstFix.trust, "normal");
  assert.equal(firstFix.counters.evaluations, 1);
  assert.equal(firstFix.counters.acceptedFixes, 1);
  assert.equal(firstFix.counters.lostFixes, 0);
});

test("counts degraded signal and dead-reckoning discrepancy events", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    hdop: 1,
    satellites: 8,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: { latitude: 56.0006, longitude: -5 },
    hdop: 6,
    satellites: 3,
  }, first, { maxBoatSpeedKnots: 30, warningDrDiscrepancyMeters: 20, alarmDrDiscrepancyMeters: 500 });

  assert.equal(second.trust, "degraded");
  assert.equal(second.counters.evaluations, 2);
  assert.equal(second.counters.acceptedFixes, 2);
  assert.equal(second.counters.degradedSignals, 1);
  assert.equal(second.counters.drDiscrepancies, 1);

  const third = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:20.000Z",
    position: { latitude: 56.0012, longitude: -5 },
    hdop: 6,
    satellites: 3,
  }, second, { maxBoatSpeedKnots: 30, warningDrDiscrepancyMeters: 20, alarmDrDiscrepancyMeters: 500 });

  assert.equal(third.trust, "degraded");
  assert.equal(third.counters.degradedSignals, 1);
  assert.equal(third.counters.drDiscrepancies, 1);
});

test("formats dead-reckoning discrepancy reasons with spoken distance units", () => {
  assert.equal(_private.formatSpokenDistance(54, "nmi"), "54 meters");
  assert.equal(_private.formatSpokenDistance(1200, "nmi"), "0.6 miles");
  assert.equal(_private.formatSpokenDistance(3704, "nmi"), "2 miles");
  assert.equal(_private.formatSpokenDistance(54, "m"), "54 meters");
  assert.equal(_private.formatSpokenDistance(1200, "m"), "1.2 kilometers");
  assert.equal(_private.formatSpokenDistance(54, "ft"), "177 feet");
  assert.equal(_private.formatSpokenDistance(1609.344, "ft"), "1 mile");
});

test("keeps operational DR GPS-locked while integrity DR detects slow spoof drift", () => {
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedOverGround: 0,
    courseOverGroundTrue: 0,
  }, null, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 500,
    integrityDrRealignSeconds: 1800,
  });

  for (let second = 1; second <= 15; second += 1) {
    state = evaluateNavigationIntegrity({
      timestamp: new Date(Date.parse("2026-06-22T12:00:00.000Z") + second * 1000).toISOString(),
      position: _private.destinationMeters({ latitude: 56, longitude: -5 }, second * 2, 0),
      speedOverGround: 0,
      courseOverGroundTrue: 0,
    }, state, {
      warningDrDiscrepancyMeters: 20,
      alarmDrDiscrepancyMeters: 500,
      integrityDrRealignSeconds: 1800,
    });
  }

  assert.equal(state.trust, "degraded");
  assert.match(state.reasons.join(" "), /independent dead reckoning/);
  assert.doesNotMatch(state.reasons.join(" "), /\d+ m\./);
  assert.equal(state.counters.drDiscrepancies, 1);
  assert.deepEqual(state.deadReckoning.position, state.gps.position);
  assert.deepEqual(state.operationalDeadReckoning.position, state.gps.position);
  assert.ok(state.integrityDeadReckoning.position.longitude < state.gps.position.longitude);
});

test("realigns integrity DR after the configured interval", () => {
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedOverGround: 0,
    courseOverGroundTrue: 0,
  }, null, {
    warningDrDiscrepancyMeters: 5,
    alarmDrDiscrepancyMeters: 500,
    integrityDrRealignSeconds: 300,
  });
  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:04:59.000Z",
    position: _private.destinationMeters({ latitude: 56, longitude: -5 }, 20, 0),
    speedOverGround: 0,
    courseOverGroundTrue: 0,
  }, state, {
    warningDrDiscrepancyMeters: 5,
    alarmDrDiscrepancyMeters: 500,
    integrityDrRealignSeconds: 300,
  });
  assert.ok(state.integrityDeadReckoning.position.longitude < state.gps.position.longitude);

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:05:00.000Z",
    position: _private.destinationMeters({ latitude: 56, longitude: -5 }, 21, 0),
    speedOverGround: 0,
    courseOverGroundTrue: 0,
  }, state, {
    warningDrDiscrepancyMeters: 5,
    alarmDrDiscrepancyMeters: 500,
    integrityDrRealignSeconds: 300,
  });
  assert.deepEqual(state.integrityDeadReckoning.position, state.gps.position);
  assert.equal(state.integrityDeadReckoning.ageSeconds, 0);
});

test("scales position jump threshold during accelerated replay", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:01.000Z",
    position: _private.destinationMeters({ latitude: 56, longitude: -5 }, 30, 0),
  }, first, {
    maxBoatSpeedKnots: 20,
    replayTimeScale: 5,
  });

  assert.equal(second.trust, "normal");
  assert.equal(second.acceptedGps, true);
  assert.equal(second.counters.positionJumps, 0);
});

test("operational DR propagates only after GPS is unavailable", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: { latitude: 56.0001, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
  }, first);
  assert.deepEqual(second.operationalDeadReckoning.position, second.gps.position);
  assert.equal(second.operationalDeadReckoning.source, "gps-locked");

  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:20.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 2,
    fixValid: false,
  }, second);
  assert.ok(lost.operationalDeadReckoning.position.latitude > second.gps.position.latitude);
  assert.equal(lost.deadReckoning.position, lost.operationalDeadReckoning.position);
});

test("operational DR drifts on tide when GPS is lost and the boat is stopped", () => {
  const start = { latitude: 56, longitude: -5 };
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
    fixValid: false,
  }, first);

  assert.equal(lost.trust, "lost");
  assert.equal(lost.operationalDeadReckoning.source, "tide-current");
  assert.ok(lost.operationalDeadReckoning.position.longitude > start.longitude);
  assert.ok(Math.abs(lost.operationalDeadReckoning.position.latitude - start.latitude) < 0.00002);
  assert.ok(_private.distanceMeters(start, lost.operationalDeadReckoning.position) > 9);
  assert.ok(_private.distanceMeters(start, lost.operationalDeadReckoning.position) < 11);
});

test("healthy stationary GPS does not diverge from independent DR on tide alone", () => {
  const start = { latitude: 56, longitude: -5 };
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 2,
  });

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:02:00.000Z",
    position: start,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 2,
  }, state);

  assert.equal(state.trust, "normal");
  assert.equal(state.acceptedGps, true);
  assert.equal(state.reasons.length, 0);
  assert.equal(state.integrityDeadReckoning.source, "heading-stw");
  assert.ok(_private.distanceMeters(start, state.integrityDeadReckoning.position) < 1);
});

test("publishes single-arrow vector only when heading is available", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedOverGround: 4,
    headingTrue: Math.PI,
    courseOverGroundTrue: Math.PI / 2,
  });

  assert.equal(state.vectors.headingThroughWater.available, true);
  assert.equal(state.vectors.headingThroughWater.arrow, "single");
  assert.equal(state.vectors.headingThroughWater.speedMps, 4);
  assert.equal(state.vectors.headingThroughWater.bearingTrueDegrees, 180);
});

test("lost GPS double-arrow vector follows operational DR over ground", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 2,
    speedOverGround: 4,
    courseOverGroundTrue: Math.PI,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
    fixValid: false,
  }, first);

  assert.equal(lost.operationalDeadReckoning.source, "heading-stw-current");
  assert.equal(lost.vectors.courseOverGround.arrow, "double");
  assert.equal(lost.vectors.courseOverGround.source, "heading-stw-current");
  assert.ok(lost.vectors.courseOverGround.bearingTrueDegrees > 25);
  assert.ok(lost.vectors.courseOverGround.bearingTrueDegrees < 27);
});

test("lost GPS double-arrow vector does not add current to COG/SOG", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 1.5,
    courseOverGroundTrue: Math.PI / 2,
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
    fixValid: false,
  }, first);

  assert.equal(lost.vectors.courseOverGround.arrow, "double");
  assert.equal(lost.vectors.courseOverGround.source, "cog-sog");
  assert.equal(lost.vectors.courseOverGround.speedMps, 1.5);
  assert.equal(lost.vectors.courseOverGround.bearingTrueDegrees, 90);
});

test("publishes tide/current as the triple-arrow vector", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    currentSetTrue: Math.PI / 2,
    currentDrift: 1.5,
  });

  assert.equal(state.vectors.tide.available, true);
  assert.equal(state.vectors.tide.arrow, "triple");
  assert.equal(state.vectors.tide.speedMps, 1.5);
  assert.equal(state.vectors.tide.bearingTrueDegrees, 90);
});

test("distance and destination helpers are metre scale", () => {
  const start = { latitude: 56, longitude: -5 };
  const moved = _private.destinationMeters(start, 100, 0);
  const distance = _private.distanceMeters(start, moved);
  assert.ok(distance > 99 && distance < 101);
});
