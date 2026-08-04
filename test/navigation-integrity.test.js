"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateNavigationIntegrity, _private } = require("../plugin/lib/navigation-integrity");

function qualifiedCurrent(setTrue, drift, timestamp, {
  source = "independent-current",
  gpsDependent = false,
  origin = "measured-current",
} = {}) {
  return {
    currentSetTrue: setTrue,
    currentDrift: drift,
    currentTimestamp: timestamp,
    currentEvidence: {
      setTrue,
      drift,
      source,
      timestamp,
      origin,
      gpsDependent,
      quality: { status: "good" },
    },
  };
}

function independentMotion({
  headingTrue = 0,
  speedThroughWater = 0,
  leeway = 0,
  currentSetTrue = 0,
  currentDrift = 0,
  timestamp,
} = {}) {
  return {
    headingTrue,
    headingTrueTimestamp: timestamp,
    headingTrueEvidence: {
      value: headingTrue,
      source: "independent-compass",
      timestamp,
      gpsDependent: false,
      uncertaintyRad: 5 * Math.PI / 180,
    },
    speedThroughWater,
    speedThroughWaterTimestamp: timestamp,
    speedThroughWaterEvidence: {
      value: speedThroughWater,
      source: "water-log",
      timestamp,
      gpsDependent: false,
    },
    leeway,
    leewayTimestamp: timestamp,
    leewayEvidence: {
      value: leeway,
      source: "leeway-model",
      timestamp,
      gpsDependent: false,
    },
    leewayStatus: "known",
    ...qualifiedCurrent(currentSetTrue, currentDrift, timestamp),
  };
}

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
  assert.equal(second.diagnostics.contract, "ajrm-marine-gps-integrity-diagnostics");
  assert.equal(second.diagnostics.observed.positionPresent, true);
  assert.equal(second.diagnostics.decision.positionJumpRejected, true);
  assert.equal(second.diagnostics.thresholds.maxBoatSpeedKnots, 30);
  assert.match(second.diagnostics.decision.reasons.join(" "), /Position jump/);
});

test("uses GPS measurement time across a sparse but plausible position stream", () => {
  const baseMs = Date.parse("2026-07-29T12:00:00.000Z");
  const timestamp = (seconds) =>
    new Date(baseMs + seconds * 1000).toISOString();
  const start = { latitude: 56, longitude: -5 };
  let state = evaluateNavigationIntegrity({
    timestamp: timestamp(0),
    positionTimestamp: timestamp(0),
    position: start,
  });

  for (let seconds = 1; seconds <= 5; seconds += 1) {
    state = evaluateNavigationIntegrity({
      timestamp: timestamp(seconds),
      positionTimestamp: timestamp(0),
      position: start,
    }, state);
  }

  state = evaluateNavigationIntegrity({
    timestamp: timestamp(6),
    positionTimestamp: timestamp(6),
    position: {
      latitude: 56 + 18 / 111320,
      longitude: -5,
    },
  }, state);

  assert.equal(state.trust, "normal");
  assert.equal(state.acceptedGps, true);
  assert.equal(state.counters.acceptedFixes, 2);
  assert.equal(state.counters.positionJumps, 0);
  assert.equal(state.lastTrustedFix.measurementTimestamp, timestamp(6));
  assert.equal(state.lastTrustedFix.acceptedAt, timestamp(6));
  assert.doesNotMatch(state.reasons.join(" "), /Position jump/);
});

test("coalesces near-simultaneous 129025 and 129029-style positions from one GNSS epoch", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-07-17T14:10:01.145Z",
    positionTimestamp: "2026-07-17T14:10:01.145Z",
    source: "YDEN.c078c3001ca4fe77",
    position: { longitude: -5.6764784, latitude: 55.8485696 },
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-07-17T14:10:01.176Z",
    positionTimestamp: "2026-07-17T14:10:01.176Z",
    source: "YDEN.c078c3001ca4fe77",
    position: {
      longitude: -5.6764783159934975,
      latitude: 55.84856956943729,
    },
  }, first);

  assert.equal(second.trust, "normal");
  assert.equal(second.acceptedGps, true);
  assert.equal(second.counters.positionJumps, 0);
  assert.equal(second.lastTrustedFix.measurementTimestamp, "2026-07-17T14:10:01.176Z");
  assert.doesNotMatch(second.reasons.join(" "), /Position jump/);
});

test("still rejects a large near-simultaneous position jump", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-07-17T14:10:01.145Z",
    positionTimestamp: "2026-07-17T14:10:01.145Z",
    position: { longitude: -5.6764784, latitude: 55.8485696 },
  });
  const jumped = evaluateNavigationIntegrity({
    timestamp: "2026-07-17T14:10:01.176Z",
    positionTimestamp: "2026-07-17T14:10:01.176Z",
    position: { longitude: -5.6764784, latitude: 55.8495696 },
  }, first);

  assert.equal(jumped.trust, "suspect");
  assert.equal(jumped.acceptedGps, false);
  assert.equal(jumped.counters.positionJumps, 1);
});

test("does not count repeated evaluation of one rejected measurement as new jumps", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-07-29T12:00:00.000Z",
    positionTimestamp: "2026-07-29T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  });
  const jumped = evaluateNavigationIntegrity({
    timestamp: "2026-07-29T12:00:01.000Z",
    positionTimestamp: "2026-07-29T12:00:01.000Z",
    position: { latitude: 56.1, longitude: -5 },
  }, first);
  const repeated = evaluateNavigationIntegrity({
    timestamp: "2026-07-29T12:00:02.000Z",
    positionTimestamp: "2026-07-29T12:00:01.000Z",
    position: { latitude: 56.1, longitude: -5 },
  }, jumped);

  assert.equal(repeated.trust, "suspect");
  assert.equal(repeated.counters.positionJumps, 1);
  assert.equal(repeated.counters.rejectedFixes, 1);
  assert.match(repeated.reasons.join(" "), /awaiting a new measurement/);
});

test("labels an aged valid position delayed before the 60-second lost threshold", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-07-29T12:00:00.000Z",
    positionTimestamp: "2026-07-29T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  });
  const delayed = evaluateNavigationIntegrity({
    timestamp: "2026-07-29T12:00:11.000Z",
    positionTimestamp: "2026-07-29T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  }, first);
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-07-29T12:01:01.000Z",
    positionTimestamp: "2026-07-29T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
  }, delayed);

  assert.equal(delayed.trust, "normal");
  assert.equal(delayed.gps.positionState, "delayed");
  assert.equal(delayed.gps.positionAgeSeconds, 11);
  assert.equal(lost.trust, "lost");
  assert.equal(lost.gps.positionState, "lost");
  assert.match(lost.reasons.join(" "), /GPS position is stale/);
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

test("treats a coherent over-limit GPS stream as sustained degraded instead of repeated jumps", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-07-07T12:57:36.000Z",
    position: { latitude: 56, longitude: -5 },
  }, null, { maxBoatSpeedKnots: 30 });

  const oneSecondAt50Kn = 25.7222;
  const latStep = oneSecondAt50Kn / 111320;
  const jumped = evaluateNavigationIntegrity({
    timestamp: "2026-07-07T12:57:37.000Z",
    position: { latitude: 56 + latStep, longitude: -5 },
  }, first, { maxBoatSpeedKnots: 30 });
  assert.equal(jumped.trust, "suspect");
  assert.equal(jumped.acceptedGps, false);
  assert.match(jumped.reasons.join(" "), /Position jump/);
  assert.match(jumped.reasons.join(" "), /knots over ground/);
  assert.doesNotMatch(jumped.reasons.join(" "), /\bkn\b/);
  assert.equal(jumped.counters.positionJumps, 1);

  const sustained = evaluateNavigationIntegrity({
    timestamp: "2026-07-07T12:57:38.000Z",
    position: { latitude: 56 + latStep * 2, longitude: -5 },
  }, jumped, { maxBoatSpeedKnots: 30 });

  assert.equal(sustained.trust, "degraded");
  assert.equal(sustained.acceptedGps, false);
  assert.match(sustained.reasons.join(" "), /GPS track speed exceeds configured limit/);
  assert.match(sustained.reasons.join(" "), /knots over ground/);
  assert.doesNotMatch(sustained.reasons.join(" "), /\bkn\b/);
  assert.doesNotMatch(sustained.reasons.join(" "), /new track is now smooth/);
  assert.equal(sustained.counters.positionJumps, 1);
  assert.equal(sustained.pendingGpsCandidate.sustainedOverSpeed, true);
  assert.equal(sustained.diagnostics.thresholds.overSpeedConfirmationSamples, 2);
});

test("propagates dead reckoning using heading, STW, and current", () => {
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 2,
      currentSetTrue: Math.PI / 2,
      currentDrift: 1,
      timestamp: "2026-06-22T12:00:00.000Z",
    }),
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 2,
      currentSetTrue: Math.PI / 2,
      currentDrift: 1,
      timestamp: "2026-06-22T12:00:10.000Z",
    }),
    fixValid: false,
  }, first);
  assert.equal(first.integrityAssurance.status, "full");
  assert.equal(first.integrityDeadReckoning.gpsDependent, false);
  assert.equal(second.trust, "lost");
  assert.ok(second.deadReckoning.position.latitude > 56);
  assert.ok(second.deadReckoning.position.longitude > -5);
  assert.equal(second.deadReckoning.source, "heading-stw-current");
  assert.equal(second.counters.lostFixes, 1);
});

test("uses the last trusted current vector after GPS is lost", () => {
  const start = { latitude: 56, longitude: -5 };
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...qualifiedCurrent(Math.PI / 2, 1, "2026-06-22T12:00:00.000Z"),
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...qualifiedCurrent(Math.PI, 5, "2026-06-22T12:00:10.000Z", {
      gpsDependent: true,
      origin: "gps-derived-residual",
    }),
    fixValid: false,
  }, first);

  assert.equal(first.lastTrustedCurrent.setTrue, Math.PI / 2);
  assert.equal(first.lastTrustedCurrent.drift, 1);
  assert.equal(lost.current.source, "last-trusted-current");
  assert.equal(lost.current.setTrue, Math.PI / 2);
  assert.equal(lost.current.drift, 1);
  assert.equal(lost.operationalDeadReckoning.source, "tide-current");
  assert.ok(lost.operationalDeadReckoning.position.longitude > start.longitude);
  assert.ok(Math.abs(lost.operationalDeadReckoning.position.latitude - start.latitude) < 0.00002);
  assert.ok(_private.distanceMeters(start, lost.operationalDeadReckoning.position) > 9);
  assert.ok(_private.distanceMeters(start, lost.operationalDeadReckoning.position) < 11);
});

test("explicit GNSS no-fix beats a fresh cached position", () => {
  const start = { latitude: 56, longitude: -5 };
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    positionTimestamp: "2026-06-22T12:00:00.000Z",
    hdop: 0.8,
    satellites: 8,
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:02.000Z",
    position: start,
    positionTimestamp: "2026-06-22T12:00:00.000Z",
    explicitGpsUnavailable: true,
    satellites: 0,
  }, first);

  assert.equal(lost.trust, "lost");
  assert.equal(lost.acceptedGps, false);
  assert.equal(lost.gps.fixValid, false);
  assert.equal(lost.gps.explicitGpsUnavailable, true);
  assert.match(lost.reasons.join(" "), /GPS source reports no fix/);
  assert.equal(lost.counters.lostFixes, 1);
});

test("does not trust live current values during GPS loss before a current baseline exists", () => {
  const start = { latitude: 56, longitude: -5 };
  const first = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    currentSetTrue: Math.PI / 2,
    currentDrift: 5,
    fixValid: false,
  }, first);

  assert.equal(lost.current.available, false);
  assert.equal(lost.operationalDeadReckoning.source, "heading-stw");
  assert.deepEqual(lost.operationalDeadReckoning.position, start);
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
    ...qualifiedCurrent(Math.PI / 2, 1, "2026-06-22T12:00:00.000Z"),
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...qualifiedCurrent(Math.PI / 2, 1, "2026-06-22T12:00:10.000Z"),
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
    ...qualifiedCurrent(0, 1, "2026-06-22T12:00:00.000Z"),
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    speedThroughWater: 2,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...qualifiedCurrent(0, 1, "2026-06-22T12:00:10.000Z"),
    fixValid: false,
  }, first);

  assert.equal(second.deadReckoning.source, "tide-current");
  assert.ok(second.deadReckoning.position.latitude > 56);
});

test("integrity DR refuses COG/SOG from the GNSS under test", () => {
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
  assert.equal(second.integrityDeadReckoning.source, "independent-motion-unavailable");
  assert.equal(second.integrityDeadReckoning.assurance, "unavailable");
  assert.equal(second.integrityDeadReckoning.comparisonAvailable, false);
  assert.equal(second.integrityDeadReckoning.gpsDependent, true);
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

test("ignores stale cached heading without using GNSS COG/SOG for integrity DR", () => {
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
  assert.equal(second.integrityDeadReckoning.source, "independent-motion-unavailable");
  assert.equal(second.integrityDeadReckoning.comparisonAvailable, false);
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

test("fresh GPS is not rejected when independent integrity motion is unavailable", () => {
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    speedOverGround: 2.2,
    courseOverGroundTrue: Math.PI / 2,
    ...independentMotion({
      headingTrue: Math.PI / 2,
      speedThroughWater: 2.2,
      timestamp: "2026-06-22T12:00:00.000Z",
    }),
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
  assert.equal(state.trust, "normal");
  assert.equal(state.acceptedGps, true);
  assert.doesNotMatch(state.reasons.join(" "), /GPS differs from independent dead reckoning/);
  assert.equal(state.integrityAssurance.status, "unavailable");
  assert.equal(state.integrityAssurance.comparisonAvailable, false);
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
    ...independentMotion({
      headingTrue: Math.PI / 2,
      speedThroughWater: 2.2,
      timestamp: "2026-06-22T12:06:00.000Z",
    }),
  }, state, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 40,
    gpsLostSeconds: 15,
    integrityDrRealignSeconds: 300,
  });

  assert.equal(state.trust, "suspect");
  assert.equal(state.acceptedGps, false);

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
    ...independentMotion({ timestamp: "2026-06-22T12:00:00.000Z" }),
  });
  const second = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: { latitude: 56.0006, longitude: -5 },
    hdop: 6,
    satellites: 3,
    ...independentMotion({ timestamp: "2026-06-22T12:00:10.000Z" }),
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
    ...independentMotion({ timestamp: "2026-06-22T12:00:20.000Z" }),
  }, second, { maxBoatSpeedKnots: 30, warningDrDiscrepancyMeters: 20, alarmDrDiscrepancyMeters: 500 });

  assert.equal(third.trust, "degraded");
  assert.equal(third.counters.degradedSignals, 1);
  assert.equal(third.counters.drDiscrepancies, 1);
});

test("explains poor GPS position quality without relying on HDOP jargon", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-08-04T15:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    hdop: 7.5,
    satellites: 8,
  }, null, { maxHdop: 4 });

  assert.equal(state.trust, "degraded");
  assert.equal(
    state.reasons[0],
    "GPS position quality is poor. Accuracy rating 7.5; lower is better, and the acceptable limit is 4.",
  );
  assert.equal(state.gps.hdop, 7.5);
  assert.equal(state.diagnostics.thresholds.maxHdop, 4);
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
    ...independentMotion({ timestamp: "2026-06-22T12:00:00.000Z" }),
  }, null, {
    warningDrDiscrepancyMeters: 20,
    alarmDrDiscrepancyMeters: 500,
    integrityDrRealignSeconds: 1800,
  });

  for (let second = 1; second <= 15; second += 1) {
    const timestamp = new Date(Date.parse("2026-06-22T12:00:00.000Z") + second * 1000).toISOString();
    state = evaluateNavigationIntegrity({
      timestamp,
      position: _private.destinationMeters({ latitude: 56, longitude: -5 }, second * 2, 0),
      speedOverGround: 0,
      courseOverGroundTrue: 0,
      ...independentMotion({ timestamp }),
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
    ...qualifiedCurrent(Math.PI / 2, 1, "2026-06-22T12:00:00.000Z"),
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    headingTrue: 0,
    speedThroughWater: 0,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...qualifiedCurrent(Math.PI / 2, 1, "2026-06-22T12:00:10.000Z"),
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
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...independentMotion({
      currentSetTrue: Math.PI / 2,
      currentDrift: 2,
      timestamp: "2026-06-22T12:00:00.000Z",
    }),
  });

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:02:00.000Z",
    position: start,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...independentMotion({
      currentSetTrue: Math.PI / 2,
      currentDrift: 2,
      timestamp: "2026-06-22T12:02:00.000Z",
    }),
  }, state);

  assert.equal(state.trust, "normal");
  assert.equal(state.acceptedGps, true);
  assert.equal(state.reasons.length, 0);
  assert.equal(state.integrityDeadReckoning.source, "heading-stw");
  assert.ok(_private.distanceMeters(start, state.integrityDeadReckoning.position) < 1);
});

test("healthy stationary GPS realigns stale independent DR after tide-only drift", () => {
  const start = { latitude: 56, longitude: -5 };
  let state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: start,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...independentMotion({
      currentSetTrue: Math.PI / 2,
      currentDrift: 2,
      timestamp: "2026-06-22T12:00:00.000Z",
    }),
  });
  state = {
    ...state,
    integrityDeadReckoning: {
      ...state.integrityDeadReckoning,
      position: { latitude: 56, longitude: -4.998 },
      lastRealignedAt: "2026-06-22T11:55:00.000Z",
    },
  };

  state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:02:00.000Z",
    position: start,
    speedOverGround: 0,
    courseOverGroundTrue: 0,
    ...independentMotion({
      currentSetTrue: Math.PI / 2,
      currentDrift: 2,
      timestamp: "2026-06-22T12:02:00.000Z",
    }),
  }, state);

  assert.equal(state.trust, "normal");
  assert.equal(state.acceptedGps, true);
  assert.equal(state.reasons.length, 0);
  assert.equal(state.integrityDeadReckoning.source, "gps-realigned");
  assert.ok(_private.distanceMeters(start, state.integrityDeadReckoning.position) < 1);
});

test("publishes single-arrow vector only when heading is available", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingTrue: Math.PI,
    speedThroughWater: 4,
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
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 2,
      currentSetTrue: Math.PI / 2,
      currentDrift: 1,
      timestamp: "2026-06-22T12:00:00.000Z",
    }),
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: "2026-06-22T12:00:10.000Z",
    position: null,
    speedOverGround: 4,
    courseOverGroundTrue: Math.PI,
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 2,
      currentSetTrue: Math.PI / 2,
      currentDrift: 1,
      timestamp: "2026-06-22T12:00:10.000Z",
    }),
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
    ...qualifiedCurrent(Math.PI / 2, 1.5, "2026-06-22T12:00:00.000Z"),
  });

  assert.equal(state.vectors.tide.available, true);
  assert.equal(state.vectors.tide.arrow, "triple");
  assert.equal(state.vectors.tide.speedMps, 1.5);
  assert.equal(state.vectors.tide.bearingTrueDegrees, 90);
});

test("never treats magnetic heading as true heading", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-07-14T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    headingMagnetic: Math.PI / 2,
    speedThroughWater: 2,
  });

  assert.equal(state.gps.headingTrue, null);
  assert.equal(state.vectors.headingThroughWater.available, false);
  assert.equal(state.integrityAssurance.status, "unavailable");
  assert.match(state.integrityAssurance.reason, /independent true heading/);
});

test("rejects current without atomic provenance metadata", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-07-14T12:00:00.000Z",
    position: { latitude: 56, longitude: -5 },
    currentSetTrue: Math.PI / 2,
    currentDrift: 1,
    currentEvidence: {
      setTrue: Math.PI / 2,
      drift: 1,
      source: "set-source-only",
      timestamp: "2026-07-14T12:00:00.000Z",
      gpsDependent: false,
    },
  });

  assert.equal(state.current.available, false);
  assert.equal(state.lastTrustedCurrent, null);
  assert.equal(state.vectors.tide.available, false);
});

test("rejects stale qualified current", () => {
  const state = evaluateNavigationIntegrity({
    timestamp: "2026-07-14T12:01:00.000Z",
    position: { latitude: 56, longitude: -5 },
    ...qualifiedCurrent(Math.PI / 2, 1, "2026-07-14T12:00:00.000Z"),
  }, null, {
    currentMaxAgeSeconds: 30,
  });

  assert.equal(state.current.available, false);
  assert.equal(state.lastTrustedCurrent, null);
});

test("reports reduced assurance and unknown leeway without independent current", () => {
  const timestamp = "2026-07-14T12:00:00.000Z";
  const evidence = independentMotion({
    headingTrue: 0,
    speedThroughWater: 2,
    timestamp,
  });
  delete evidence.currentEvidence;
  delete evidence.currentSetTrue;
  delete evidence.currentDrift;
  delete evidence.currentTimestamp;
  delete evidence.leewayEvidence;
  delete evidence.leeway;
  evidence.leewayStatus = "unknown";

  const state = evaluateNavigationIntegrity({
    timestamp,
    position: { latitude: 56, longitude: -5 },
    ...evidence,
  });

  assert.equal(state.integrityAssurance.status, "reduced");
  assert.equal(state.integrityAssurance.comparisonAvailable, false);
  assert.equal(state.integrityAssurance.gpsDependent, true);
  assert.equal(state.integrityDeadReckoning.gpsDependent, true);
  assert.equal(state.integrityDeadReckoning.leewayStatus, "unknown");
  assert.match(state.integrityDeadReckoning.unavailableReason, /independent current, leeway/);
  assert.ok(state.integrityDeadReckoning.uncertaintyRadiusMeters >= 10);
});

test("applies known leeway once to the through-water track", () => {
  const firstTimestamp = "2026-07-14T12:00:00.000Z";
  const secondTimestamp = "2026-07-14T12:00:10.000Z";
  const first = evaluateNavigationIntegrity({
    timestamp: firstTimestamp,
    position: { latitude: 56, longitude: -5 },
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 1,
      leeway: Math.PI / 2,
      timestamp: firstTimestamp,
    }),
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: secondTimestamp,
    position: null,
    fixValid: false,
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 1,
      leeway: Math.PI / 2,
      timestamp: secondTimestamp,
    }),
  }, first);

  assert.ok(lost.operationalDeadReckoning.position.longitude > -5);
  assert.ok(Math.abs(lost.operationalDeadReckoning.position.latitude - 56) < 0.00002);
  assert.equal(lost.operationalDeadReckoning.gpsDependent, false);
});

test("GPS-derived current is operational evidence but never integrity evidence", () => {
  const timestamp = "2026-07-14T12:00:00.000Z";
  const state = evaluateNavigationIntegrity({
    timestamp,
    position: { latitude: 56, longitude: -5 },
    headingTrue: 0,
    speedThroughWater: 2,
    headingTrueEvidence: {
      value: 0,
      source: "compass",
      timestamp,
      gpsDependent: false,
    },
    speedThroughWaterEvidence: {
      value: 2,
      source: "water-log",
      timestamp,
      gpsDependent: false,
    },
    leeway: 0,
    leewayTimestamp: timestamp,
    leewayEvidence: {
      value: 0,
      source: "leeway-model",
      timestamp,
      gpsDependent: false,
    },
    leewayStatus: "known",
    ...qualifiedCurrent(Math.PI / 2, 1, timestamp, {
      gpsDependent: true,
      origin: "ground-minus-water-residual",
    }),
  });

  assert.equal(state.current.available, true);
  assert.equal(state.current.gpsDependent, true);
  assert.equal(state.integrityAssurance.status, "reduced");
  assert.equal(state.integrityAssurance.comparisonAvailable, false);
  assert.equal(state.integrityDeadReckoning.currentOrigin, null);
});

test("retains a GPS-derived residual through an outage for operational DR only", () => {
  const firstTimestamp = "2026-07-14T12:00:00.000Z";
  const secondTimestamp = "2026-07-14T12:00:10.000Z";
  const first = evaluateNavigationIntegrity({
    timestamp: firstTimestamp,
    position: { latitude: 56, longitude: -5 },
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 1,
      leeway: 0,
      currentSetTrue: Math.PI / 2,
      currentDrift: 1,
      timestamp: firstTimestamp,
    }),
    ...qualifiedCurrent(Math.PI / 2, 1, firstTimestamp, {
      source: "gps.one+water-log.one+compass.one",
      gpsDependent: true,
      origin: "ground-minus-water-residual",
    }),
  });
  const lost = evaluateNavigationIntegrity({
    timestamp: secondTimestamp,
    position: null,
    fixValid: false,
    ...independentMotion({
      headingTrue: 0,
      speedThroughWater: 1,
      leeway: 0,
      currentDrift: 0,
      timestamp: secondTimestamp,
    }),
    currentSetTrue: undefined,
    currentDrift: undefined,
    currentTimestamp: null,
    currentEvidence: null,
  }, first);

  assert.ok(lost.operationalDeadReckoning.position.latitude > 56);
  assert.ok(lost.operationalDeadReckoning.position.longitude > -5);
  assert.equal(lost.operationalDeadReckoning.source, "heading-stw-current");
  assert.equal(
    lost.operationalDeadReckoning.currentOrigin,
    "ground-minus-water-residual",
  );
  assert.equal(lost.operationalDeadReckoning.gpsDependent, true);
  assert.equal(
    lost.operationalDeadReckoning.provenance.current.gpsDependent,
    true,
  );
  assert.equal(lost.current.source, "last-trusted-current");
  assert.equal(lost.integrityAssurance.status, "reduced");
  assert.equal(lost.integrityAssurance.comparisonAvailable, false);
  assert.equal(lost.integrityDeadReckoning.currentOrigin, null);
  assert.equal(lost.integrityDeadReckoning.provenance.current, null);
});

test("distance and destination helpers are metre scale", () => {
  const start = { latitude: 56, longitude: -5 };
  const moved = _private.destinationMeters(start, 100, 0);
  const distance = _private.distanceMeters(start, moved);
  assert.ok(distance > 99 && distance < 101);
});
