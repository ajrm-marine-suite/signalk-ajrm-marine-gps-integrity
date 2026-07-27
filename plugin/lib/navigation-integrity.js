"use strict";

const EARTH_RADIUS_M = 6371008.8;
const MPS_TO_KNOTS = 1.9438444924406046;
const KNOTS_TO_MPS = 0.5144444444444445;
const DEG_PER_RAD = 180 / Math.PI;
const METERS_PER_NM = 1852;
const METERS_PER_STATUTE_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const STATIONARY_REALIGN_TOLERANCE_METERS = 1;

function evaluateNavigationIntegrity(sample, previousState = null, options = {}) {
  const settings = normalizeOptions(options);
  const nowMs = timestampMs(sample.timestamp) || Date.now();
  const position = normalizePosition(sample.position);
  const positionTimestampMs = timestampMs(sample.positionTimestamp);
  const positionAgeSeconds = position && positionTimestampMs
    ? Math.max(0, (nowMs - positionTimestampMs) / 1000)
    : null;
  const positionFresh = positionAgeSeconds === null || positionAgeSeconds <= settings.gpsLostSeconds;
  const rawMotionSample = freshNavigationSample(sample, nowMs, settings);
  const hdop = finiteNumber(
    freshTimedValue(sample.hdop, sample.hdopTimestamp, nowMs, settings),
  );
  const satellites = finiteNumber(
    freshTimedValue(sample.satellites, sample.satellitesTimestamp, nowMs, settings),
  );
  const explicitGpsUnavailable =
    freshTimedValue(
      sample.explicitGpsUnavailable === true,
      sample.explicitGpsUnavailableTimestamp,
      nowMs,
      settings,
    ) === true;
  const fixValid = sample.fixValid !== false && !explicitGpsUnavailable && Boolean(position) && positionFresh;
  let motionSample = navigationSampleWithTrustedCurrent(rawMotionSample, previousState, {
    allowLiveCurrent: fixValid,
    nowMs,
    settings,
  });
  const independentMotionSample = independentNavigationSample(rawMotionSample);
  const integrityAssurance = assessIntegrityAssurance(independentMotionSample);
  const reasons = [];
  let trust = "normal";
  let acceptedGps = false;
  let lastTrustedFix = previousState?.lastTrustedFix || null;
  let lastTrustedCurrent = previousState?.lastTrustedCurrent || null;
  let operationalDeadReckoning = null;
  let integrityDeadReckoning = null;
  const previousOperationalDr = previousState?.operationalDeadReckoning || previousState?.deadReckoning || null;
  const previousIntegrityDr = previousState?.integrityDeadReckoning || previousState?.deadReckoning || null;
  let pendingGpsCandidate = previousState?.pendingGpsCandidate || null;
  let resetBaselineFromCandidate = false;
  let positionJumpRejected = false;
  let gpsTrackOverSpeed = false;
  let drDiscrepancyActive = false;
  const receivedGpsTimestamp = position
    ? new Date(positionTimestampMs || nowMs).toISOString()
    : null;
  const lastReceivedGpsTimestamp =
    receivedGpsTimestamp ||
    previousState?.gps?.lastReceivedPositionTimestamp ||
    previousState?.gps?.positionTimestamp ||
    null;

  if (!fixValid) {
    trust = "lost";
    reasons.push(
      explicitGpsUnavailable
        ? "GPS source reports no fix."
        : position && !positionFresh
        ? `GPS position is stale (${Math.round(positionAgeSeconds)} seconds old).`
        : "GPS position is missing or invalid.",
    );
  }
  if (Number.isFinite(hdop) && hdop > settings.maxHdop) {
    trust = maxTrust(trust, "degraded");
    reasons.push(`HDOP ${formatNumber(hdop, 1)} exceeds ${settings.maxHdop}.`);
  }
  if (Number.isFinite(satellites) && satellites < settings.minSatellites) {
    trust = maxTrust(trust, "degraded");
    reasons.push(`${satellites} satellites in view is below ${settings.minSatellites}.`);
  }

  const stationaryGps = fixValid && position && stationaryGpsFix(sample, motionSample, settings);
  const stationaryRealignTolerance = Math.min(
    STATIONARY_REALIGN_TOLERANCE_METERS,
    settings.positionNoiseAllowanceMeters,
  );
  const stationaryNearTrustedFix =
    stationaryGps &&
    (!lastTrustedFix?.position ||
      distanceMeters(lastTrustedFix.position, position) <= stationaryRealignTolerance);
  const stationaryAtTrustedFix =
    stationaryNearTrustedFix &&
    previousIntegrityDr?.position &&
    distanceMeters(previousIntegrityDr.position, position) <= settings.positionNoiseAllowanceMeters;
  const stationaryNeedsRealign =
    stationaryNearTrustedFix &&
    previousIntegrityDr?.position &&
    distanceMeters(previousIntegrityDr.position, position) > settings.positionNoiseAllowanceMeters;
  const integrityMotionSample = stationaryAtTrustedFix
    ? {
        ...independentMotionSample,
        currentSetTrue: undefined,
        currentDrift: undefined,
        currentEvidence: null,
      }
    : independentMotionSample;

  if (fixValid && lastTrustedFix?.position) {
    const elapsedSeconds = Math.max(0.001, (nowMs - timestampMs(lastTrustedFix.timestamp)) / 1000);
    const distance = distanceMeters(lastTrustedFix.position, position);
    const impliedSpeed = distance / elapsedSeconds;
    const maxSpeedMps = settings.maxBoatSpeedKnots * settings.replayTimeScale * KNOTS_TO_MPS;
    if (impliedSpeed > maxSpeedMps) {
      const updatedCandidate = updateOverSpeedCandidate(pendingGpsCandidate, position, nowMs, settings);
      const candidateAccepted = isPlausibleContinuation(pendingGpsCandidate, position, nowMs, settings);
      if (updatedCandidate?.sustainedOverSpeed) {
        const speedKnots = updatedCandidate.trackSpeedMps * MPS_TO_KNOTS;
        trust = maxTrust(trust, "degraded");
        gpsTrackOverSpeed = true;
        reasons.push(
          `GPS track speed exceeds configured limit: ${formatNumber(speedKnots, 1)} knots over ground.`,
        );
        pendingGpsCandidate = updatedCandidate;
      } else if (candidateAccepted) {
        trust = maxTrust(trust, "degraded");
        reasons.push("GPS position shifted, but the new track is now smooth.");
        resetBaselineFromCandidate = true;
        pendingGpsCandidate = null;
      } else {
        trust = maxTrust(trust, "suspect");
        reasons.push(
          `Position jump implies ${formatNumber(impliedSpeed * MPS_TO_KNOTS, 1)} knots over ground.`,
        );
        positionJumpRejected = true;
        pendingGpsCandidate = updatedCandidate || {
          position,
          timestamp: new Date(nowMs).toISOString(),
        };
      }
    }
  }

  const propagatedIntegrity = propagateDeadReckoningFrom(
    previousIntegrityDr?.position,
    previousState?.timestamp || previousIntegrityDr?.timestamp || previousIntegrityDr?.lastRealignedAt,
    sample,
    integrityMotionSample,
    settings,
    nowMs,
    { allowGroundTrack: false },
  );
  if (propagatedIntegrity) {
    integrityDeadReckoning = makeDrTrack({
      position: propagatedIntegrity.position,
      uncertaintyAgeSeconds: previousIntegrityDr?.lastRealignedAt
        ? Math.max(0, (nowMs - timestampMs(previousIntegrityDr.lastRealignedAt)) / 1000)
        : null,
      sample,
      motionSample: integrityMotionSample,
      settings,
      trust,
      source: integrityDrSource(integrityMotionSample, integrityAssurance),
      lastRealignedAt: previousIntegrityDr?.lastRealignedAt || null,
      realignIntervalSeconds: settings.integrityDrRealignSeconds,
      assurance: integrityAssurance,
    });
  }

  if (resetBaselineFromCandidate && position) {
    integrityDeadReckoning = makeRealignedDrTrack(
      position,
      sample,
      integrityMotionSample,
      settings,
      trust,
      nowMs,
      integrityAssurance,
    );
  } else if (stationaryNeedsRealign && position) {
    integrityDeadReckoning = makeRealignedDrTrack(
      position,
      sample,
      integrityMotionSample,
      settings,
      trust,
      nowMs,
      integrityAssurance,
    );
  } else if (
    integrityAssurance.comparisonAvailable &&
    fixValid &&
    !gpsTrackOverSpeed &&
    integrityDeadReckoning?.position &&
    !stationaryAtTrustedFix
  ) {
    const discrepancy = distanceMeters(integrityDeadReckoning.position, position);
    if (discrepancy > settings.warningDrDiscrepancyMeters) {
      trust = maxTrust(trust, "degraded");
      drDiscrepancyActive = true;
      reasons.push(
        `GPS differs from independent dead reckoning by ${formatSpokenDistance(discrepancy, settings.distanceDisplayUnit)}.`,
      );
    }
    if (discrepancy > settings.alarmDrDiscrepancyMeters) {
      trust = maxTrust(trust, "suspect");
    }
  }

  if (fixValid && trust !== "suspect" && trust !== "lost" && !gpsTrackOverSpeed) {
    acceptedGps = true;
    lastTrustedFix = {
      position,
      timestamp: new Date(nowMs).toISOString(),
      hdop: Number.isFinite(hdop) ? hdop : null,
      satellites: Number.isFinite(satellites) ? satellites : null,
      source: sample.source || null,
      provenance: sample.gnssProvenance || null,
    };
    const liveCurrent = currentSnapshotFromSample(rawMotionSample, nowMs);
    if (liveCurrent) lastTrustedCurrent = liveCurrent;
    pendingGpsCandidate = null;
  } else {
    motionSample = navigationSampleWithTrustedCurrent(rawMotionSample, previousState, {
      allowLiveCurrent: false,
      nowMs,
      settings,
    });
  }

  const ageSeconds = lastTrustedFix ? Math.max(0, (nowMs - timestampMs(lastTrustedFix.timestamp)) / 1000) : null;
  if (ageSeconds !== null && ageSeconds > settings.gpsLostSeconds) {
    if (!fixValid) trust = maxTrust(trust, "lost");
    if (fixValid) {
      reasons.push(`Last trusted GPS fix is ${Math.round(ageSeconds)} seconds old.`);
    } else if (!position) {
      const receivedAgeSeconds = lastReceivedGpsTimestamp
        ? Math.max(0, (nowMs - timestampMs(lastReceivedGpsTimestamp)) / 1000)
        : null;
      if (receivedAgeSeconds !== null) {
        reasons.push(`GPS position was last received ${Math.round(receivedAgeSeconds)} seconds ago.`);
      }
    }
  }

  const shouldRealignIntegrity =
    acceptedGps &&
    position &&
    (!integrityDeadReckoning?.position ||
      !integrityDeadReckoning?.lastRealignedAt ||
      nowMs - timestampMs(integrityDeadReckoning.lastRealignedAt) >= settings.integrityDrRealignSeconds * 1000);
  if (shouldRealignIntegrity) {
    integrityDeadReckoning = makeRealignedDrTrack(
      position,
      sample,
      integrityMotionSample,
      settings,
      trust,
      nowMs,
      integrityAssurance,
    );
  }

  if (acceptedGps && position) {
    operationalDeadReckoning = makeDrTrack({
      position,
      uncertaintyAgeSeconds: 0,
      sample,
      motionSample,
      settings,
      trust,
      source: "gps-locked",
      lastRealignedAt: new Date(nowMs).toISOString(),
      realignIntervalSeconds: 0,
    });
  } else {
    const propagatedOperational = propagateDeadReckoningFrom(
      previousOperationalDr?.position || lastTrustedFix?.position,
      previousState?.timestamp || previousOperationalDr?.timestamp || lastTrustedFix?.timestamp,
      sample,
      motionSample,
      settings,
      nowMs,
    );
    const operationalPosition = propagatedOperational?.position || previousOperationalDr?.position || lastTrustedFix?.position || null;
    operationalDeadReckoning = operationalPosition
      ? makeDrTrack({
          position: operationalPosition,
          uncertaintyAgeSeconds: ageSeconds,
          sample,
          motionSample,
          settings,
          trust,
          source: drSource(motionSample),
          lastRealignedAt: lastTrustedFix?.timestamp || null,
          realignIntervalSeconds: 0,
        })
      : makeDrTrack({
          position: null,
          uncertaintyAgeSeconds: ageSeconds,
          sample,
          motionSample,
          settings,
          trust,
          source: "last-known-position",
          lastRealignedAt: lastTrustedFix?.timestamp || null,
          realignIntervalSeconds: 0,
        });
  }

  if (!integrityDeadReckoning?.position && acceptedGps && position) {
    integrityDeadReckoning = makeRealignedDrTrack(
      position,
      sample,
      integrityMotionSample,
      settings,
      trust,
      nowMs,
      integrityAssurance,
    );
  }

  const vectors = buildVectors(motionSample, settings, trust);
  const state = notificationStateForTrust(trust);
  const counters = updateCounters(previousState?.counters, {
    acceptedGps,
    fixValid,
    trust,
    previousTrust: previousState?.trust || null,
    previousFixValid: previousState?.gps?.fixValid ?? null,
    previousDegradedSignal: previousState?.degradedSignalActive === true,
    previousDrDiscrepancy: previousState?.drDiscrepancyActive === true,
    hadTrustedFix: Boolean(previousState?.lastTrustedFix?.position),
    positionJumpRejected,
    gpsTrackOverSpeed,
    degradedSignal: (
      (Number.isFinite(hdop) && hdop > settings.maxHdop) ||
      (Number.isFinite(satellites) && satellites < settings.minSatellites)
    ),
    drDiscrepancy: drDiscrepancyActive,
  });

  return {
    ok: true,
    timestamp: new Date(nowMs).toISOString(),
    trust,
    notificationState: state,
    acceptedGps,
    reasons,
    counters,
    gps: {
      position,
      fixValid,
      positionTimestamp: sample.positionTimestamp || null,
      lastReceivedPositionTimestamp: lastReceivedGpsTimestamp,
      positionAgeSeconds,
      hdop: Number.isFinite(hdop) ? hdop : null,
      satellites: Number.isFinite(satellites) ? satellites : null,
      explicitGpsUnavailable,
      speedOverGround: finiteOrNull(motionSample.speedOverGround),
      courseOverGroundTrue: finiteOrNull(motionSample.courseOverGroundTrue),
      headingTrue: finiteOrNull(rawMotionSample.headingTrue),
      source: sample.source || null,
      provenance: sample.gnssProvenance || null,
    },
    lastTrustedFix,
    lastTrustedCurrent,
    current: currentStateFromSample(motionSample),
    pendingGpsCandidate,
    degradedSignalActive: (
      (Number.isFinite(hdop) && hdop > settings.maxHdop) ||
      (Number.isFinite(satellites) && satellites < settings.minSatellites)
    ),
    drDiscrepancyActive,
    deadReckoning: operationalDeadReckoning,
    operationalDeadReckoning,
    integrityDeadReckoning,
    integrityAssurance,
    navigationProvenance: navigationProvenance(rawMotionSample),
    diagnostics: buildDiagnostics({
      sample,
      rawMotionSample,
      motionSample,
      position,
      positionFresh,
      positionAgeSeconds,
      fixValid,
      acceptedGps,
      trust,
      state,
      reasons,
      hdop,
      satellites,
      explicitGpsUnavailable,
      positionJumpRejected,
      gpsTrackOverSpeed,
      degradedSignalActive:
        (Number.isFinite(hdop) && hdop > settings.maxHdop) ||
        (Number.isFinite(satellites) && satellites < settings.minSatellites),
      drDiscrepancyActive,
      settings,
      operationalDeadReckoning,
      integrityDeadReckoning,
      lastTrustedFix,
      lastTrustedCurrent,
      current: currentStateFromSample(motionSample),
    }),
    vectors,
  };
}

function buildDiagnostics({
  sample,
  rawMotionSample,
  motionSample,
  position,
  positionFresh,
  positionAgeSeconds,
  fixValid,
  acceptedGps,
  trust,
  state,
  reasons,
  hdop,
  satellites,
  explicitGpsUnavailable,
  positionJumpRejected,
  gpsTrackOverSpeed,
  degradedSignalActive,
  drDiscrepancyActive,
  settings,
  operationalDeadReckoning,
  integrityDeadReckoning,
  lastTrustedFix,
  lastTrustedCurrent,
  current,
}) {
  return {
    contract: "ajrm-marine-gps-integrity-diagnostics",
    contractVersion: 1,
    observed: {
      positionPresent: Boolean(position),
      positionTimestamp: sample.positionTimestamp || null,
      positionAgeSeconds: finiteOrNull(positionAgeSeconds),
      positionFresh: Boolean(positionFresh),
      explicitGpsUnavailable: Boolean(explicitGpsUnavailable),
      fixValid: Boolean(fixValid),
      hdop: finiteOrNull(hdop),
      satellites: finiteOrNull(satellites),
      speedOverGround: finiteOrNull(rawMotionSample.speedOverGround),
      courseOverGroundTrue: finiteOrNull(rawMotionSample.courseOverGroundTrue),
      headingTrue: finiteOrNull(rawMotionSample.headingTrue),
      speedThroughWater: finiteOrNull(rawMotionSample.speedThroughWater),
      currentSetTrue: finiteOrNull(rawMotionSample.currentSetTrue),
      currentDrift: finiteOrNull(rawMotionSample.currentDrift),
      gnssSource: sample.source || null,
      gnssProvenance: sample.gnssProvenance || null,
      navigationReference: sample.navigationReference || null,
    },
    decision: {
      trust,
      notificationState: state,
      acceptedGps: Boolean(acceptedGps),
      positionJumpRejected: Boolean(positionJumpRejected),
      gpsTrackOverSpeed: Boolean(gpsTrackOverSpeed),
      degradedSignalActive: Boolean(degradedSignalActive),
      drDiscrepancyActive: Boolean(drDiscrepancyActive),
      reasons: Array.isArray(reasons) ? reasons.slice(0, 8) : [],
    },
    motionUsed: {
      speedOverGround: finiteOrNull(motionSample.speedOverGround),
      courseOverGroundTrue: finiteOrNull(motionSample.courseOverGroundTrue),
      headingTrue: finiteOrNull(motionSample.headingTrue),
      speedThroughWater: finiteOrNull(motionSample.speedThroughWater),
      current,
      leewayStatus: motionSample.leewayStatus || "unknown",
    },
    deadReckoning: {
      operationalSource: operationalDeadReckoning?.source || null,
      operationalAgeSeconds: finiteOrNull(operationalDeadReckoning?.ageSeconds),
      operationalUncertaintyRadiusMeters: finiteOrNull(operationalDeadReckoning?.uncertaintyRadiusMeters),
      integritySource: integrityDeadReckoning?.source || null,
      integrityAgeSeconds: finiteOrNull(integrityDeadReckoning?.ageSeconds),
      integrityUncertaintyRadiusMeters: finiteOrNull(integrityDeadReckoning?.uncertaintyRadiusMeters),
      integrityAssurance: integrityDeadReckoning?.assurance || "unavailable",
      integrityComparisonAvailable: integrityDeadReckoning?.comparisonAvailable === true,
      integrityUnavailableReason: integrityDeadReckoning?.unavailableReason || null,
      integrityLeewayStatus: integrityDeadReckoning?.leewayStatus || "unknown",
    },
    baseline: {
      lastTrustedFixTimestamp: lastTrustedFix?.timestamp || null,
      lastTrustedFixSource: lastTrustedFix?.source || null,
      lastTrustedCurrentTimestamp: lastTrustedCurrent?.timestamp || null,
      lastTrustedCurrentSetTrue: finiteOrNull(lastTrustedCurrent?.setTrue),
      lastTrustedCurrentDrift: finiteOrNull(lastTrustedCurrent?.drift),
    },
    thresholds: {
      maxBoatSpeedKnots: settings.maxBoatSpeedKnots,
      maxHdop: settings.maxHdop,
      minSatellites: settings.minSatellites,
      gpsLostSeconds: settings.gpsLostSeconds,
      warningDrDiscrepancyMeters: settings.warningDrDiscrepancyMeters,
      alarmDrDiscrepancyMeters: settings.alarmDrDiscrepancyMeters,
      integrityDrRealignSeconds: settings.integrityDrRealignSeconds,
      positionNoiseAllowanceMeters: settings.positionNoiseAllowanceMeters,
      overSpeedConfirmationSamples: settings.overSpeedConfirmationSamples,
      overSpeedCoherenceMultiplier: settings.overSpeedCoherenceMultiplier,
      replayTimeScale: settings.replayTimeScale,
      currentMaxAgeSeconds: settings.currentMaxAgeSeconds,
      retainedCurrentMaxAgeSeconds: settings.retainedCurrentMaxAgeSeconds,
    },
  };
}

function navigationProvenance(sample) {
  return {
    gnss: sample.gnssProvenance || null,
    headingTrue: sample.headingTrueEvidence || null,
    speedThroughWater: sample.speedThroughWaterEvidence || null,
    trackThroughWaterTrue: sample.trackThroughWaterTrueEvidence || null,
    leeway: sample.leewayEvidence || null,
    leewayStatus: sample.leewayStatus || "unknown",
    current: sample.currentEvidence || null,
    navigationReference: sample.navigationReference || null,
  };
}

function updateCounters(previousCounters = {}, event) {
  const countingStarted = event.hadTrustedFix || event.acceptedGps;
  const counters = {
    evaluations: finiteCounter(previousCounters.evaluations),
    acceptedFixes: finiteCounter(previousCounters.acceptedFixes),
    rejectedFixes: finiteCounter(previousCounters.rejectedFixes),
    positionJumps: finiteCounter(previousCounters.positionJumps),
    lostFixes: finiteCounter(previousCounters.lostFixes),
    degradedSignals: finiteCounter(previousCounters.degradedSignals),
    drDiscrepancies: finiteCounter(previousCounters.drDiscrepancies),
  };
  if (!countingStarted) return counters;
  counters.evaluations += 1;
  if (event.acceptedGps) counters.acceptedFixes += 1;
  if (!event.acceptedGps && event.fixValid) counters.rejectedFixes += 1;
  if (event.positionJumpRejected) counters.positionJumps += 1;
  if (isLostEventStart(event)) counters.lostFixes += 1;
  if (event.degradedSignal && !event.previousDegradedSignal) counters.degradedSignals += 1;
  if (event.drDiscrepancy && !event.previousDrDiscrepancy) counters.drDiscrepancies += 1;
  return counters;
}

function isLostEventStart(event) {
  const currentLost = !event.fixValid || event.trust === "lost";
  if (!currentLost) return false;
  if (!event.hadTrustedFix) return false;
  const previousLost = event.previousFixValid === false || event.previousTrust === "lost";
  return !previousLost;
}

function isPlausibleContinuation(candidate, position, nowMs, settings) {
  if (!candidate?.position || !candidate.timestamp || !position) return false;
  const elapsedSeconds = Math.max(0.001, (nowMs - timestampMs(candidate.timestamp)) / 1000);
  const distance = distanceMeters(candidate.position, position);
  const allowedDistance = settings.maxBoatSpeedKnots * KNOTS_TO_MPS * elapsedSeconds;
  return distance <= allowedDistance + settings.positionNoiseAllowanceMeters;
}

function updateOverSpeedCandidate(candidate, position, nowMs, settings) {
  const timestamp = new Date(nowMs).toISOString();
  if (!candidate?.position || !candidate.timestamp || !position) {
    return {
      position,
      timestamp,
      lastPosition: position,
      lastTimestamp: timestamp,
      overSpeedSamples: 1,
      trackSpeedMps: null,
      sustainedOverSpeed: false,
    };
  }

  const previousPosition = candidate.lastPosition || candidate.position;
  const previousTimestamp = candidate.lastTimestamp || candidate.timestamp;
  const elapsedSeconds = Math.max(0.001, (nowMs - timestampMs(previousTimestamp)) / 1000);
  const distance = distanceMeters(previousPosition, position);
  const trackSpeedMps = distance / elapsedSeconds;
  const maxSpeedMps = settings.maxBoatSpeedKnots * settings.replayTimeScale * KNOTS_TO_MPS;
  const coherentOverSpeed =
    trackSpeedMps > maxSpeedMps &&
    trackSpeedMps <= maxSpeedMps * settings.overSpeedCoherenceMultiplier;

  return {
    position: candidate.position,
    timestamp: candidate.timestamp,
    lastPosition: position,
    lastTimestamp: timestamp,
    overSpeedSamples: coherentOverSpeed ? (Number(candidate.overSpeedSamples) || 1) + 1 : 1,
    trackSpeedMps,
    sustainedOverSpeed:
      coherentOverSpeed &&
      ((Number(candidate.overSpeedSamples) || 1) + 1) >= settings.overSpeedConfirmationSamples,
  };
}

function freshNavigationSample(sample, nowMs, settings) {
  const speedOverGround = freshTimedValue(
    sample.speedOverGround,
    sample.speedOverGroundTimestamp,
    nowMs,
    settings,
  );
  const courseOverGroundTrue = freshTimedValue(
    sample.courseOverGroundTrue,
    sample.courseOverGroundTrueTimestamp,
    nowMs,
    settings,
  );
  const headingTrue = freshTimedValue(sample.headingTrue, sample.headingTrueTimestamp, nowMs, settings);
  const speedThroughWater = freshTimedValue(
    sample.speedThroughWater,
    sample.speedThroughWaterTimestamp,
    nowMs,
    settings,
  );
  const trackThroughWaterTrue = freshTimedValue(
    sample.trackThroughWaterTrue,
    sample.trackThroughWaterTrueTimestamp,
    nowMs,
    settings,
  );
  const leeway = freshTimedValue(sample.leeway, sample.leewayTimestamp, nowMs, settings);
  return {
    ...sample,
    speedOverGround,
    courseOverGroundTrue,
    headingTrue,
    headingTrueEvidence: headingTrue === undefined ? null : sample.headingTrueEvidence,
    speedThroughWater,
    speedThroughWaterEvidence: speedThroughWater === undefined ? null : sample.speedThroughWaterEvidence,
    trackThroughWaterTrue,
    trackThroughWaterTrueEvidence:
      trackThroughWaterTrue === undefined ? null : sample.trackThroughWaterTrueEvidence,
    leeway,
    leewayEvidence: leeway === undefined ? null : sample.leewayEvidence,
    currentEvidence: currentSnapshotFromSample(sample, nowMs, settings),
  };
}

function freshTimedValue(value, timestamp, nowMs, settings) {
  if (value === undefined || value === null) return value;
  const valueTimestampMs = timestampMs(timestamp);
  if (!valueTimestampMs) return value;
  return nowMs - valueTimestampMs <= settings.gpsLostSeconds * 1000 ? value : undefined;
}

function navigationSampleWithTrustedCurrent(sample, previousState, {
  allowLiveCurrent,
  nowMs,
  settings = normalizeOptions({}),
}) {
  const liveCurrent = currentSnapshotFromSample(sample, nowMs, settings);
  if (liveCurrent && (allowLiveCurrent || liveCurrent.gpsDependent === false)) {
    return {
      ...sample,
      currentSetTrue: liveCurrent.setTrue,
      currentDrift: liveCurrent.drift,
      currentTimestamp: liveCurrent.timestamp,
      currentSource: "live",
      currentAgeSeconds: liveCurrent.ageSeconds,
      currentEvidence: liveCurrent,
    };
  }

  const retainedCurrent = normalizeCurrentSnapshot(previousState?.lastTrustedCurrent);
  const retainedAgeSeconds = retainedCurrent?.timestamp
    ? Math.max(0, (nowMs - timestampMs(retainedCurrent.timestamp)) / 1000)
    : null;
  if (
    retainedCurrent &&
    retainedAgeSeconds !== null &&
    retainedAgeSeconds <= settings.retainedCurrentMaxAgeSeconds
  ) {
    const currentTimestampMs = timestampMs(retainedCurrent.timestamp);
    return {
      ...sample,
      currentSetTrue: retainedCurrent.setTrue,
      currentDrift: retainedCurrent.drift,
      currentTimestamp: retainedCurrent.timestamp,
      currentSource: "last-trusted-current",
      currentAgeSeconds: currentTimestampMs ? Math.max(0, (nowMs - currentTimestampMs) / 1000) : null,
      currentEvidence: {
        ...retainedCurrent,
        ageSeconds: retainedAgeSeconds,
      },
    };
  }

  return {
    ...sample,
    currentSetTrue: undefined,
    currentDrift: undefined,
    currentTimestamp: null,
    currentSource: "unavailable",
    currentAgeSeconds: null,
    currentEvidence: null,
  };
}

function independentNavigationSample(sample) {
  const headingEvidence = normalizeMeasurementEvidence(
    sample.headingTrueEvidence,
    sample.headingTrue,
    sample.headingTrueTimestamp,
  );
  const speedEvidence = normalizeMeasurementEvidence(
    sample.speedThroughWaterEvidence,
    sample.speedThroughWater,
    sample.speedThroughWaterTimestamp,
  );
  const trackEvidence = normalizeMeasurementEvidence(
    sample.trackThroughWaterTrueEvidence,
    sample.trackThroughWaterTrue,
    sample.trackThroughWaterTrueTimestamp,
  );
  const leewayEvidence = normalizeMeasurementEvidence(
    sample.leewayEvidence,
    sample.leeway,
    sample.leewayTimestamp,
  );
  const currentEvidence = normalizeCurrentSnapshot(sample.currentEvidence);
  const independentHeading = headingEvidence?.gpsDependent === false ? headingEvidence : null;
  const independentSpeed = speedEvidence?.gpsDependent === false ? speedEvidence : null;
  const independentTrack = trackEvidence?.gpsDependent === false ? trackEvidence : null;
  const independentLeeway = leewayEvidence?.gpsDependent === false ? leewayEvidence : null;
  const independentCurrent = currentEvidence?.gpsDependent === false ? currentEvidence : null;
  return {
    ...sample,
    speedOverGround: undefined,
    courseOverGroundTrue: undefined,
    headingTrue: independentHeading?.value,
    headingTrueTimestamp: independentHeading?.timestamp || null,
    headingTrueEvidence: independentHeading,
    speedThroughWater: independentSpeed?.value,
    speedThroughWaterTimestamp: independentSpeed?.timestamp || null,
    speedThroughWaterEvidence: independentSpeed,
    trackThroughWaterTrue: independentTrack?.value,
    trackThroughWaterTrueTimestamp: independentTrack?.timestamp || null,
    trackThroughWaterTrueEvidence: independentTrack,
    leeway: independentLeeway?.value,
    leewayTimestamp: independentLeeway?.timestamp || null,
    leewayEvidence: independentLeeway,
    leewayStatus: sample.leewayStatus === "known" && independentLeeway ? "known" : "unknown",
    currentSetTrue: independentCurrent?.setTrue,
    currentDrift: independentCurrent?.drift,
    currentTimestamp: independentCurrent?.timestamp || null,
    currentAgeSeconds: independentCurrent?.ageSeconds ?? null,
    currentSource: independentCurrent ? "live-independent" : "unavailable",
    currentEvidence: independentCurrent,
  };
}

function assessIntegrityAssurance(sample) {
  const headingAvailable = Number.isFinite(finiteNumber(sample.trackThroughWaterTrue)) ||
    Number.isFinite(finiteNumber(sample.headingTrue));
  const speedAvailable = Number.isFinite(finiteNumber(sample.speedThroughWater));
  const currentAvailable = Boolean(normalizeCurrentSnapshot(sample.currentEvidence));
  const leewayKnown =
    sample.leewayStatus === "known" &&
    (Number.isFinite(finiteNumber(sample.trackThroughWaterTrue)) ||
      Number.isFinite(finiteNumber(sample.leeway)));
  const missing = [];
  if (!headingAvailable) missing.push("independent true heading");
  if (!speedAvailable) missing.push("independent speed through water");
  if (!currentAvailable) missing.push("independent current");
  if (!leewayKnown) missing.push("leeway");
  const status = !headingAvailable || !speedAvailable
    ? "unavailable"
    : currentAvailable && leewayKnown
      ? "full"
      : "reduced";
  return {
    status,
    comparisonAvailable: status === "full",
    gpsDependent: status !== "full",
    missing,
    reason: missing.length
      ? `Independent integrity comparison ${status}: missing ${missing.join(", ")}.`
      : "Independent heading, water speed, current, and leeway are available.",
    leewayStatus: leewayKnown ? "known" : "unknown",
    headingSource: sample.trackThroughWaterTrueEvidence?.source || sample.headingTrueEvidence?.source || null,
    speedThroughWaterSource: sample.speedThroughWaterEvidence?.source || null,
    currentSource: sample.currentEvidence?.source || null,
    currentOrigin: sample.currentEvidence?.origin || null,
  };
}

function currentSnapshotFromSample(sample, nowMs, settings = normalizeOptions({})) {
  const evidence = normalizeCurrentSnapshot(sample.currentEvidence);
  if (!evidence) return null;
  const timestampMsValue = timestampMs(evidence.timestamp);
  const reportedAgeSeconds = Number.isFinite(finiteNumber(evidence.ageSeconds))
    ? Math.max(0, finiteNumber(evidence.ageSeconds))
    : null;
  const timestampAgeSeconds = timestampMsValue
    ? Math.max(0, (nowMs - timestampMsValue) / 1000)
    : null;
  const ageSeconds =
    reportedAgeSeconds === null
      ? timestampAgeSeconds
      : timestampAgeSeconds === null
        ? reportedAgeSeconds
        : Math.max(reportedAgeSeconds, timestampAgeSeconds);
  if (ageSeconds === null || ageSeconds > settings.currentMaxAgeSeconds) return null;
  return {
    ...evidence,
    setTrueDegrees: normalizeDegrees(evidence.setTrue * DEG_PER_RAD),
    driftKnots: evidence.drift * MPS_TO_KNOTS,
    ageSeconds,
  };
}

function normalizeCurrentSnapshot(value) {
  const setTrue = finiteNumber(value?.setTrue ?? value?.currentSetTrue);
  const drift = finiteNumber(value?.drift ?? value?.currentDrift);
  const source = nonEmptyString(value?.source);
  const timestamp = nonEmptyString(value?.timestamp);
  const origin = nonEmptyString(value?.origin);
  const quality = value?.quality;
  if (
    !Number.isFinite(setTrue) ||
    !Number.isFinite(drift) ||
    !source ||
    !timestamp ||
    !origin ||
    typeof value?.gpsDependent !== "boolean" ||
    !hasExplicitQuality(quality)
  ) {
    return null;
  }
  return {
    setTrue,
    drift,
    setTrueDegrees: normalizeDegrees(setTrue * DEG_PER_RAD),
    driftKnots: drift * MPS_TO_KNOTS,
    timestamp,
    source,
    sourceKind: nonEmptyString(value?.sourceKind),
    origin,
    gpsDependent: value.gpsDependent,
    quality,
    ageSeconds: Number.isFinite(finiteNumber(value?.ageSeconds))
      ? Math.max(0, finiteNumber(value.ageSeconds))
      : null,
  };
}

function normalizeMeasurementEvidence(evidence, fallbackValue, fallbackTimestamp) {
  const value = finiteNumber(evidence?.value ?? fallbackValue);
  if (!Number.isFinite(value)) return null;
  return {
    value,
    source: nonEmptyString(evidence?.source),
    sourceKind: nonEmptyString(evidence?.sourceKind),
    timestamp: nonEmptyString(evidence?.timestamp) || fallbackTimestamp || null,
    method: nonEmptyString(evidence?.method),
    gpsDependent: typeof evidence?.gpsDependent === "boolean" ? evidence.gpsDependent : null,
    uncertaintyRad: finiteOrNull(evidence?.uncertaintyRad),
  };
}

function hasExplicitQuality(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function currentStateFromSample(sample) {
  const setTrue = finiteNumber(sample.currentSetTrue);
  const drift = finiteNumber(sample.currentDrift);
  if (!Number.isFinite(setTrue) || !Number.isFinite(drift)) {
    return {
      available: false,
      source: sample.currentSource || "unavailable",
      ageSeconds: null,
      timestamp: null,
    };
  }
  return {
    available: true,
    source: sample.currentSource || "live",
    setTrue,
    setTrueDegrees: normalizeDegrees(setTrue * DEG_PER_RAD),
    drift,
    driftKnots: drift * MPS_TO_KNOTS,
    timestamp: sample.currentTimestamp || null,
    ageSeconds: sample.currentAgeSeconds ?? null,
    origin: sample.currentEvidence?.origin || null,
    gpsDependent: sample.currentEvidence?.gpsDependent ?? null,
    quality: sample.currentEvidence?.quality ?? null,
    providerSource: sample.currentEvidence?.source || null,
  };
}

function propagateDeadReckoning(previousState, sample, settings, nowMs) {
  const previousPosition =
    previousState?.deadReckoning?.position || previousState?.lastTrustedFix?.position || null;
  const previousTime = previousState?.timestamp || previousState?.lastTrustedFix?.timestamp;
  return propagateDeadReckoningFrom(previousPosition, previousTime, sample, sample, settings, nowMs);
}

function propagateDeadReckoningFrom(
  previousPosition,
  previousTimestamp,
  sample,
  motionSample,
  settings,
  nowMs,
  motionPolicy = {},
) {
  const previousTime = timestampMs(previousTimestamp);
  if (!previousPosition || !previousTime) return null;
  const elapsedSeconds = Math.max(
    0,
    Math.min(
      settings.maxPropagationSeconds * settings.replayTimeScale,
      ((nowMs - previousTime) / 1000) * settings.replayTimeScale,
    ),
  );
  if (elapsedSeconds <= 0) return { position: previousPosition };

  const effectiveSample = motionSample || sample;
  const motion = drMotion(effectiveSample, settings, motionPolicy);
  const boat = vectorFromSpeedBearing(motion.speed, motion.bearing);
  const current = currentVectorForMotion(motion, effectiveSample);
  const total = {
    east: boat.east + current.east,
    north: boat.north + current.north,
  };
  return {
    position: destinationMeters(previousPosition, total.east * elapsedSeconds, total.north * elapsedSeconds),
  };
}

function makeRealignedDrTrack(
  position,
  sample,
  motionSample,
  settings,
  trust,
  nowMs,
  assurance = null,
) {
  return makeDrTrack({
    position,
    uncertaintyAgeSeconds: 0,
    sample,
    motionSample,
    settings,
    trust,
    source: assurance?.status === "unavailable" ? "gps-realigned-no-independent-motion" : "gps-realigned",
    lastRealignedAt: new Date(nowMs).toISOString(),
    realignIntervalSeconds: settings.integrityDrRealignSeconds,
    assurance,
  });
}

function makeDrTrack({
  position,
  uncertaintyAgeSeconds,
  sample,
  motionSample,
  settings,
  trust,
  source,
  lastRealignedAt,
  realignIntervalSeconds,
  assurance = null,
}) {
  return {
    position,
    uncertaintyRadiusMeters: uncertaintyRadius(uncertaintyAgeSeconds, motionSample || sample, settings, trust),
    source,
    ageSeconds: uncertaintyAgeSeconds,
    lastRealignedAt,
    realignIntervalSeconds,
    assurance: assurance?.status || null,
    comparisonAvailable: assurance?.comparisonAvailable ?? null,
    unavailableReason: assurance?.reason || null,
    gpsDependent: assurance
      ? assurance.gpsDependent !== false
      : drGpsDependency(source, motionSample),
    leewayStatus: assurance?.leewayStatus || motionSample?.leewayStatus || "unknown",
    currentOrigin: motionSample?.currentEvidence?.origin || null,
    provenance: {
      heading: motionSample?.headingTrueEvidence || null,
      trackThroughWater: motionSample?.trackThroughWaterTrueEvidence || null,
      speedThroughWater: motionSample?.speedThroughWaterEvidence || null,
      current: motionSample?.currentEvidence || null,
      leeway: motionSample?.leewayEvidence || null,
    },
  };
}

function drGpsDependency(source, sample) {
  if (source === "gps-locked" || source === "cog-sog" || source === "cog-sog-gps-dependent") {
    return true;
  }
  const dependencies =
    source === "tide-current"
      ? [sample?.currentEvidence?.gpsDependent]
      : source === "heading-stw" || source === "heading-stw-current"
        ? [
            sample?.trackThroughWaterTrueEvidence
              ? sample.trackThroughWaterTrueEvidence.gpsDependent
              : sample?.headingTrueEvidence?.gpsDependent,
            sample?.speedThroughWaterEvidence?.gpsDependent,
            ...(sample?.trackThroughWaterTrueEvidence || sample?.leewayStatus !== "known"
              ? []
              : [sample?.leewayEvidence?.gpsDependent]),
            ...(source === "heading-stw-current"
              ? [sample?.currentEvidence?.gpsDependent]
              : []),
          ]
        : [];
  if (dependencies.some((value) => typeof value !== "boolean")) return null;
  if (dependencies.includes(true)) return true;
  if (dependencies.length > 0) return false;
  return null;
}

function buildVectors(sample, settings = normalizeOptions({}), trust = "normal") {
  const heading = trackThroughWaterBearing(sample);
  const derivedOverGround = makeDerivedOverGroundVector(sample, settings);
  const gpsOverGround = makeVector(sample.speedOverGround, sample.courseOverGroundTrue, "double");
  return {
    headingThroughWater: makeVector(
      sample.speedThroughWater,
      heading,
      "single",
    ),
    tide: makeVector(sample.currentDrift, sample.currentSetTrue, "triple"),
    courseOverGround: trust === "lost" && derivedOverGround.available
      ? derivedOverGround
      : gpsOverGround.available
        ? gpsOverGround
        : derivedOverGround,
  };
}

function makeDerivedOverGroundVector(sample, settings) {
  const motion = drMotion(sample, settings);
  if (!motion.source) return { available: false, arrow: "double" };
  const boat = vectorFromSpeedBearing(motion.speed, motion.bearing);
  const current = currentVectorForMotion(motion, sample);
  const east = boat.east + current.east;
  const north = boat.north + current.north;
  const speedMps = Math.sqrt(east ** 2 + north ** 2);
  if (!Number.isFinite(speedMps)) return { available: false, arrow: "double" };
  const bearing = Math.atan2(east, north);
  return {
    available: true,
    speedMps,
    speedKnots: speedMps * MPS_TO_KNOTS,
    bearingTrueDegrees: normalizeDegrees(bearing * DEG_PER_RAD),
    arrow: "double",
    source: `${motion.source}${current.available ? "-current" : ""}`,
  };
}

function currentVectorForMotion(motion, sample) {
  if (motion?.source !== "heading-stw") return { east: 0, north: 0, available: false };
  return currentVector(sample);
}

function currentVector(sample) {
  const currentSet = finiteNumber(sample.currentSetTrue);
  const currentDrift = finiteNumber(sample.currentDrift);
  if (!Number.isFinite(currentSet) || !Number.isFinite(currentDrift)) {
    return { east: 0, north: 0, available: false };
  }
  return { ...vectorFromSpeedBearing(currentDrift, currentSet), available: true };
}

function stationaryGpsFix(sample, motionSample = sample, settings = normalizeOptions({})) {
  const position = normalizePosition(sample.position);
  const fixValid = sample.fixValid !== false && Boolean(position);
  if (!fixValid) return false;
  const sog = finiteNumber(motionSample.speedOverGround);
  const stw = finiteNumber(motionSample.speedThroughWater);
  const sogStationary = !Number.isFinite(sog) || Math.abs(sog) < settings.minReliableSogMps;
  const stwStationary = !Number.isFinite(stw) || Math.abs(stw) < settings.minReliableStwMps;
  return sogStationary && stwStationary;
}

function makeVector(speed, bearing, arrow) {
  const numericSpeed = finiteNumber(speed);
  const numericBearing = finiteNumber(bearing);
  if (!Number.isFinite(numericSpeed) || !Number.isFinite(numericBearing)) {
    return { available: false, arrow };
  }
  return {
    available: true,
    speedMps: numericSpeed,
    speedKnots: numericSpeed * MPS_TO_KNOTS,
    bearingTrueDegrees: normalizeDegrees(numericBearing * DEG_PER_RAD),
    arrow,
  };
}

function uncertaintyRadius(ageSeconds, sample, settings, trust) {
  if (ageSeconds === null) return null;
  const base = trust === "normal" ? settings.baseUncertaintyMeters : settings.degradedBaseUncertaintyMeters;
  const currentPenalty = Number.isFinite(finiteNumber(sample.currentDrift)) ? 0.3 : 1;
  const speedThroughWater = Math.abs(finiteNumber(sample.speedThroughWater));
  const angularUncertainty = firstFinite(
    sample.trackThroughWaterTrueEvidence?.uncertaintyRad,
    sample.headingTrueEvidence?.uncertaintyRad,
    0,
  );
  const transversePenalty = Number.isFinite(speedThroughWater)
    ? speedThroughWater * Math.abs(Math.sin(angularUncertainty))
    : 0;
  const unknownLeewayPenalty =
    sample.leewayStatus === "known" || !Number.isFinite(speedThroughWater)
      ? 0
      : speedThroughWater * settings.unknownLeewayFraction;
  return Math.round(
    base +
      ageSeconds *
        (settings.uncertaintyGrowthMetersPerSecond +
          currentPenalty +
          transversePenalty +
          unknownLeewayPenalty),
  );
}

function drSource(sample) {
  const motion = drMotion(sample, normalizeOptions({}), { allowGroundTrack: true });
  if (motion.source === "heading-stw" && currentVectorForMotion(motion, sample).available) {
    return "heading-stw-current";
  }
  if (motion.source) return motion.source;
  return "last-known-position";
}

function integrityDrSource(sample, assurance) {
  if (assurance?.status === "unavailable") return "independent-motion-unavailable";
  const motion = drMotion(sample, normalizeOptions({}), { allowGroundTrack: false });
  if (motion.source === "heading-stw" && currentVectorForMotion(motion, sample).available) {
    return "heading-stw-independent-current";
  }
  return motion.source || "independent-motion-unavailable";
}

function drMotion(sample, settings, { allowGroundTrack = true } = {}) {
  const stw = finiteNumber(sample.speedThroughWater);
  const sog = finiteNumber(sample.speedOverGround);
  const heading = trackThroughWaterBearing(sample);
  const cog = finiteNumber(sample.courseOverGroundTrue);
  if (Number.isFinite(stw) && stw >= settings.minReliableStwMps && Number.isFinite(heading)) {
    return { speed: stw, bearing: heading, source: "heading-stw" };
  }
  if (allowGroundTrack && Number.isFinite(sog) && sog >= settings.minReliableSogMps && Number.isFinite(cog)) {
    return { speed: sog, bearing: cog, source: "cog-sog" };
  }
  const current = currentVector(sample);
  if (current.available) {
    const currentSet = finiteNumber(sample.currentSetTrue);
    const currentDrift = finiteNumber(sample.currentDrift);
    return { speed: currentDrift, bearing: currentSet, source: "tide-current" };
  }
  if (Number.isFinite(stw) && Number.isFinite(heading)) {
    return { speed: stw, bearing: heading, source: "heading-stw" };
  }
  if (allowGroundTrack && Number.isFinite(sog) && Number.isFinite(cog)) {
    return { speed: sog, bearing: cog, source: "cog-sog" };
  }
  return { speed: 0, bearing: 0, source: "" };
}

function trackThroughWaterBearing(sample) {
  const explicitTrack = finiteNumber(sample.trackThroughWaterTrue);
  if (Number.isFinite(explicitTrack)) return explicitTrack;
  const heading = finiteNumber(sample.headingTrue);
  if (!Number.isFinite(heading)) return NaN;
  const leeway = finiteNumber(sample.leeway);
  if (sample.leewayStatus === "known" && Number.isFinite(leeway)) {
    const fullTurn = Math.PI * 2;
    return ((heading + leeway) % fullTurn + fullTurn) % fullTurn;
  }
  return heading;
}

function normalizeOptions(value = {}) {
  return {
    maxBoatSpeedKnots: clampNumber(value.maxBoatSpeedKnots, 3, 80, 30),
    maxHdop: clampNumber(value.maxHdop, 0.5, 50, 4),
    minSatellites: clampNumber(value.minSatellites, 0, 20, 4),
    warningDrDiscrepancyMeters: clampNumber(value.warningDrDiscrepancyMeters, 5, 5000, 50),
    alarmDrDiscrepancyMeters: clampNumber(value.alarmDrDiscrepancyMeters, 10, 10000, 150),
    gpsLostSeconds: clampNumber(value.gpsLostSeconds, 2, 600, 15),
    baseUncertaintyMeters: clampNumber(value.baseUncertaintyMeters, 1, 1000, 10),
    degradedBaseUncertaintyMeters: clampNumber(value.degradedBaseUncertaintyMeters, 5, 5000, 40),
    uncertaintyGrowthMetersPerSecond: clampNumber(value.uncertaintyGrowthMetersPerSecond, 0.1, 50, 1.5),
    maxPropagationSeconds: clampNumber(value.maxPropagationSeconds, 1, 600, 30),
    positionNoiseAllowanceMeters: clampNumber(value.positionNoiseAllowanceMeters, 1, 200, 20),
    overSpeedConfirmationSamples: clampNumber(value.overSpeedConfirmationSamples, 2, 20, 2),
    overSpeedCoherenceMultiplier: clampNumber(value.overSpeedCoherenceMultiplier, 1.2, 10, 3),
    minReliableStwMps: clampNumber(value.minReliableStwMps, 0, 2, 0.25),
    minReliableSogMps: clampNumber(value.minReliableSogMps, 0, 2, 0.35),
    integrityDrRealignSeconds: clampNumber(value.integrityDrRealignSeconds, 60, 86400, 300),
    currentMaxAgeSeconds: clampNumber(value.currentMaxAgeSeconds, 1, 600, 30),
    retainedCurrentMaxAgeSeconds: clampNumber(value.retainedCurrentMaxAgeSeconds, 1, 86400, 900),
    unknownLeewayFraction: clampNumber(value.unknownLeewayFraction, 0, 1, 0.1),
    distanceDisplayUnit: normalizeDistanceUnit(value.distanceDisplayUnit),
    replayTimeScale: clampNumber(value.replayTimeScale, 1, 500, 1),
  };
}

function formatSpokenDistance(distanceMeters, unit = "nmi") {
  const distance = Math.abs(Number(distanceMeters));
  if (!Number.isFinite(distance)) return "unknown distance";
  switch (normalizeDistanceUnit(unit)) {
    case "metric":
      return distance < 1000
        ? numberWithUnit(Math.max(1, Math.round(distance)), "meter", "meters")
        : numberWithUnit(displayDistance(distance / 1000), "kilometer", "kilometers");
    case "statute": {
      const feet = distance / METERS_PER_FOOT;
      return feet < 1000
        ? numberWithUnit(Math.max(1, Math.round(feet)), "foot", "feet")
        : numberWithUnit(displayDistance(distance / METERS_PER_STATUTE_MILE), "mile", "miles");
    }
    default:
      return distance < 1000
        ? numberWithUnit(Math.max(1, Math.round(distance)), "meter", "meters")
        : numberWithUnit(displayDistance(distance / METERS_PER_NM), "mile", "miles");
  }
}

function displayDistance(value) {
  if (value < 10) return Number(value.toFixed(1));
  return Math.round(value);
}

function numberWithUnit(value, singular, plural) {
  const number = Number(value);
  const display = Number.isInteger(number) ? String(number) : String(value);
  return `${display} ${number === 1 && display === "1" ? singular : plural}`;
}

function normalizeDistanceUnit(unit) {
  const text = String(unit || "").trim().toLowerCase();
  if (["m", "meter", "meters", "metre", "metres", "km", "kilometer", "kilometers", "kilometre", "kilometres"].includes(text)) {
    return "metric";
  }
  if (["ft", "foot", "feet", "mi", "mile", "miles", "statutemile", "statutemiles"].includes(text)) {
    return "statute";
  }
  return "nmi";
}

function notificationStateForTrust(trust) {
  if (trust === "normal") return "normal";
  if (trust === "degraded") return "warn";
  if (trust === "suspect") return "alarm";
  return "alarm";
}

function distanceMeters(a, b) {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function destinationMeters(position, eastMeters, northMeters) {
  const latRad = toRad(position.latitude);
  return {
    latitude: position.latitude + (northMeters / EARTH_RADIUS_M) * DEG_PER_RAD,
    longitude:
      position.longitude + (eastMeters / (EARTH_RADIUS_M * Math.max(0.05, Math.cos(latRad)))) * DEG_PER_RAD,
  };
}

function vectorFromSpeedBearing(speedMps, bearingRad) {
  if (!Number.isFinite(speedMps) || !Number.isFinite(bearingRad)) return { east: 0, north: 0 };
  return {
    east: speedMps * Math.sin(bearingRad),
    north: speedMps * Math.cos(bearingRad),
  };
}

function normalizePosition(value) {
  const latitude = finiteNumber(value?.latitude);
  const longitude = finiteNumber(value?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return NaN;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function finiteOrNull(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? number : null;
}

function finiteCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function timestampMs(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function maxTrust(left, right) {
  const order = ["normal", "degraded", "suspect", "lost"];
  return order[Math.max(order.indexOf(left), order.indexOf(right))] || right;
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

function formatNumber(value, decimals) {
  return Number(value).toFixed(decimals);
}

module.exports = {
  evaluateNavigationIntegrity,
  _private: {
    destinationMeters,
    distanceMeters,
    drMotion,
    normalizeOptions,
    formatSpokenDistance,
    normalizeDistanceUnit,
    propagateDeadReckoning,
    propagateDeadReckoningFrom,
    isPlausibleContinuation,
  },
};
