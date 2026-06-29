"use strict";

const EARTH_RADIUS_M = 6371008.8;
const MPS_TO_KNOTS = 1.9438444924406046;
const KNOTS_TO_MPS = 0.5144444444444445;
const DEG_PER_RAD = 180 / Math.PI;
const METERS_PER_NM = 1852;
const METERS_PER_STATUTE_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

function evaluateNavigationIntegrity(sample, previousState = null, options = {}) {
  const settings = normalizeOptions(options);
  const nowMs = timestampMs(sample.timestamp) || Date.now();
  const position = normalizePosition(sample.position);
  const positionTimestampMs = timestampMs(sample.positionTimestamp);
  const positionAgeSeconds = position && positionTimestampMs
    ? Math.max(0, (nowMs - positionTimestampMs) / 1000)
    : null;
  const positionFresh = positionAgeSeconds === null || positionAgeSeconds <= settings.gpsLostSeconds;
  const motionSample = freshNavigationSample(sample, nowMs, settings);
  const hdop = finiteNumber(sample.hdop);
  const satellites = finiteNumber(sample.satellites);
  const fixValid = sample.fixValid !== false && Boolean(position) && positionFresh;
  const reasons = [];
  let trust = "normal";
  let acceptedGps = false;
  let lastTrustedFix = previousState?.lastTrustedFix || null;
  let operationalDeadReckoning = null;
  let integrityDeadReckoning = null;
  const previousOperationalDr = previousState?.operationalDeadReckoning || previousState?.deadReckoning || null;
  const previousIntegrityDr = previousState?.integrityDeadReckoning || previousState?.deadReckoning || null;
  let pendingGpsCandidate = previousState?.pendingGpsCandidate || null;
  let resetBaselineFromCandidate = false;
  let positionJumpRejected = false;

  if (!fixValid) {
    trust = "lost";
    reasons.push(
      position && !positionFresh
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

  if (fixValid && lastTrustedFix?.position) {
    const elapsedSeconds = Math.max(0.001, (nowMs - timestampMs(lastTrustedFix.timestamp)) / 1000);
    const distance = distanceMeters(lastTrustedFix.position, position);
    const impliedSpeed = distance / elapsedSeconds;
    if (impliedSpeed > settings.maxBoatSpeedKnots * settings.replayTimeScale * KNOTS_TO_MPS) {
      const candidateAccepted = isPlausibleContinuation(pendingGpsCandidate, position, nowMs, settings);
      if (candidateAccepted) {
        trust = maxTrust(trust, "degraded");
        reasons.push("GPS position shifted, but the new track is now smooth.");
        resetBaselineFromCandidate = true;
        pendingGpsCandidate = null;
      } else {
        trust = maxTrust(trust, "suspect");
        reasons.push(
          `Position jump implies ${formatNumber(impliedSpeed * MPS_TO_KNOTS, 1)} kn over ground.`,
        );
        positionJumpRejected = true;
        pendingGpsCandidate = {
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
    motionSample,
    settings,
    nowMs,
  );
  if (propagatedIntegrity) {
    integrityDeadReckoning = makeDrTrack({
      position: propagatedIntegrity.position,
      uncertaintyAgeSeconds: previousIntegrityDr?.lastRealignedAt
        ? Math.max(0, (nowMs - timestampMs(previousIntegrityDr.lastRealignedAt)) / 1000)
        : null,
      sample,
      motionSample,
      settings,
      trust,
      source: drSource(motionSample),
      lastRealignedAt: previousIntegrityDr?.lastRealignedAt || null,
      realignIntervalSeconds: settings.integrityDrRealignSeconds,
    });
  }

  if (resetBaselineFromCandidate && position) {
    integrityDeadReckoning = makeRealignedDrTrack(position, sample, motionSample, settings, trust, nowMs);
  } else if (fixValid && integrityDeadReckoning?.position) {
    const discrepancy = distanceMeters(integrityDeadReckoning.position, position);
    if (discrepancy > settings.warningDrDiscrepancyMeters) {
      trust = maxTrust(trust, "degraded");
      reasons.push(
        `GPS differs from independent dead reckoning by ${formatSpokenDistance(discrepancy, settings.distanceDisplayUnit)}.`,
      );
    }
    if (discrepancy > settings.alarmDrDiscrepancyMeters) {
      trust = maxTrust(trust, "suspect");
    }
  }

  if (fixValid && trust !== "suspect" && trust !== "lost") {
    acceptedGps = true;
    lastTrustedFix = {
      position,
      timestamp: new Date(nowMs).toISOString(),
      hdop: Number.isFinite(hdop) ? hdop : null,
      satellites: Number.isFinite(satellites) ? satellites : null,
    };
    pendingGpsCandidate = null;
  }

  const ageSeconds = lastTrustedFix ? Math.max(0, (nowMs - timestampMs(lastTrustedFix.timestamp)) / 1000) : null;
  if (ageSeconds !== null && ageSeconds > settings.gpsLostSeconds) {
    trust = maxTrust(trust, "lost");
    reasons.push(`Last trusted GPS fix is ${Math.round(ageSeconds)} seconds old.`);
  }

  const shouldRealignIntegrity =
    acceptedGps &&
    position &&
    (!integrityDeadReckoning?.position ||
      !integrityDeadReckoning?.lastRealignedAt ||
      nowMs - timestampMs(integrityDeadReckoning.lastRealignedAt) >= settings.integrityDrRealignSeconds * 1000);
  if (shouldRealignIntegrity) {
    integrityDeadReckoning = makeRealignedDrTrack(position, sample, motionSample, settings, trust, nowMs);
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
    integrityDeadReckoning = makeRealignedDrTrack(position, sample, motionSample, settings, trust, nowMs);
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
    degradedSignal: (
      (Number.isFinite(hdop) && hdop > settings.maxHdop) ||
      (Number.isFinite(satellites) && satellites < settings.minSatellites)
    ),
    drDiscrepancy: reasons.some((reason) => reason.startsWith("GPS differs from independent dead reckoning")),
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
      positionAgeSeconds,
      hdop: Number.isFinite(hdop) ? hdop : null,
      satellites: Number.isFinite(satellites) ? satellites : null,
      speedOverGround: finiteOrNull(motionSample.speedOverGround),
      courseOverGroundTrue: finiteOrNull(motionSample.courseOverGroundTrue),
      headingTrue: finiteOrNull(motionSample.headingTrue),
    },
    lastTrustedFix,
    pendingGpsCandidate,
    degradedSignalActive: (
      (Number.isFinite(hdop) && hdop > settings.maxHdop) ||
      (Number.isFinite(satellites) && satellites < settings.minSatellites)
    ),
    drDiscrepancyActive: reasons.some((reason) => reason.startsWith("GPS differs from independent dead reckoning")),
    deadReckoning: operationalDeadReckoning,
    operationalDeadReckoning,
    integrityDeadReckoning,
    vectors,
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

function freshNavigationSample(sample, nowMs, settings) {
  return {
    ...sample,
    speedOverGround: freshTimedValue(sample.speedOverGround, sample.speedOverGroundTimestamp, nowMs, settings),
    courseOverGroundTrue: freshTimedValue(
      sample.courseOverGroundTrue,
      sample.courseOverGroundTrueTimestamp,
      nowMs,
      settings,
    ),
    headingTrue: freshTimedValue(sample.headingTrue, sample.headingTrueTimestamp, nowMs, settings),
    headingMagnetic: freshTimedValue(sample.headingMagnetic, sample.headingMagneticTimestamp, nowMs, settings),
    speedThroughWater: freshTimedValue(
      sample.speedThroughWater,
      sample.speedThroughWaterTimestamp,
      nowMs,
      settings,
    ),
  };
}

function freshTimedValue(value, timestamp, nowMs, settings) {
  if (value === undefined || value === null) return value;
  const valueTimestampMs = timestampMs(timestamp);
  if (!valueTimestampMs) return value;
  return nowMs - valueTimestampMs <= settings.gpsLostSeconds * 1000 ? value : undefined;
}

function propagateDeadReckoning(previousState, sample, settings, nowMs) {
  const previousPosition =
    previousState?.deadReckoning?.position || previousState?.lastTrustedFix?.position || null;
  const previousTime = previousState?.timestamp || previousState?.lastTrustedFix?.timestamp;
  return propagateDeadReckoningFrom(previousPosition, previousTime, sample, sample, settings, nowMs);
}

function propagateDeadReckoningFrom(previousPosition, previousTimestamp, sample, motionSample, settings, nowMs) {
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
  const motion = drMotion(effectiveSample, settings);
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

function makeRealignedDrTrack(position, sample, motionSample, settings, trust, nowMs) {
  return makeDrTrack({
    position,
    uncertaintyAgeSeconds: 0,
    sample,
    motionSample,
    settings,
    trust,
    source: "gps-realigned",
    lastRealignedAt: new Date(nowMs).toISOString(),
    realignIntervalSeconds: settings.integrityDrRealignSeconds,
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
}) {
  return {
    position,
    uncertaintyRadiusMeters: uncertaintyRadius(uncertaintyAgeSeconds, motionSample || sample, settings, trust),
    source,
    ageSeconds: uncertaintyAgeSeconds,
    lastRealignedAt,
    realignIntervalSeconds,
  };
}

function buildVectors(sample, settings = normalizeOptions({}), trust = "normal") {
  const heading = firstFinite(sample.headingTrue, sample.headingMagnetic);
  const derivedOverGround = makeDerivedOverGroundVector(sample, settings);
  const gpsOverGround = makeVector(sample.speedOverGround, sample.courseOverGroundTrue, "double");
  return {
    headingThroughWater: makeVector(
      firstFinite(sample.speedThroughWater, sample.speedOverGround),
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
  const currentSet = finiteNumber(sample.currentSetTrue);
  const currentDrift = finiteNumber(sample.currentDrift);
  if (!Number.isFinite(currentSet) || !Number.isFinite(currentDrift)) {
    return { east: 0, north: 0, available: false };
  }
  return { ...vectorFromSpeedBearing(currentDrift, currentSet), available: true };
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
  return Math.round(base + ageSeconds * (settings.uncertaintyGrowthMetersPerSecond + currentPenalty));
}

function drSource(sample) {
  const motion = drMotion(sample, normalizeOptions({}));
  if (motion.source === "heading-stw" && Number.isFinite(finiteNumber(sample.currentDrift))) {
    return "heading-stw-current";
  }
  if (motion.source) return motion.source;
  return "last-known-position";
}

function drMotion(sample, settings) {
  const stw = finiteNumber(sample.speedThroughWater);
  const sog = finiteNumber(sample.speedOverGround);
  const heading = firstFinite(sample.headingTrue, sample.headingMagnetic);
  const cog = finiteNumber(sample.courseOverGroundTrue);
  if (Number.isFinite(stw) && stw >= settings.minReliableStwMps && Number.isFinite(heading)) {
    return { speed: stw, bearing: heading, source: "heading-stw" };
  }
  if (Number.isFinite(sog) && sog >= settings.minReliableSogMps && Number.isFinite(cog)) {
    return { speed: sog, bearing: cog, source: "cog-sog" };
  }
  if (Number.isFinite(stw) && Number.isFinite(heading)) {
    return { speed: stw, bearing: heading, source: "heading-stw" };
  }
  if (Number.isFinite(sog) && Number.isFinite(cog)) {
    return { speed: sog, bearing: cog, source: "cog-sog" };
  }
  return { speed: 0, bearing: 0, source: "" };
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
    minReliableStwMps: clampNumber(value.minReliableStwMps, 0, 2, 0.25),
    minReliableSogMps: clampNumber(value.minReliableSogMps, 0, 2, 0.35),
    integrityDrRealignSeconds: clampNumber(value.integrityDrRealignSeconds, 60, 86400, 300),
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
