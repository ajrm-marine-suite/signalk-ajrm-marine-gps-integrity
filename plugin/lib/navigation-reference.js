"use strict";

const { createWmmCalculator, validPosition } = require("./wmm");

const CONTRACT = "ajrm-marine-navigation-reference";
const SCHEMA_VERSION = 1;
const CAPTURE_PLAYBACK_PATH = "plugins.ajrmMarineCapture.playback";
const STATE_PATH = "plugins.ajrmMarineNavigationReference.state";
const AIS_DYNAMIC_NMEA2000_PGNS = new Set([129038, 129039, 129040]);

const INPUT_PATHS = new Set([
  "navigation.position",
  "navigation.speedOverGround",
  "navigation.courseOverGroundTrue",
  "navigation.headingTrue",
  "navigation.headingMagnetic",
  "navigation.speedThroughWater",
  "navigation.rateOfTurn",
  "navigation.magneticVariation",
  "navigation.gnss.methodQuality",
  "navigation.gnss.satellites",
  "navigation.gnss.satellitesInView",
  "navigation.gnss.horizontalDilution",
  "navigation.gnss.hdop",
  "navigation.gnss.integrity",
  "navigation.gnss.type",
  "navigation.gps.methodQuality",
  "navigation.gps.satellites",
  "navigation.gps.horizontalDilution",
  "performance.leeway",
  "environment.current.setTrue",
  "environment.current.drift",
]);

const DEFAULT_CALCULATED_SOURCES = [
  "derived-data",
  "signalk-derived-data",
  "SK Derived Data",
  "course-provider",
  "courseApi",
  "resources-provider",
  "sk-ais-status",
];

function createNavigationReferenceResolver(inputOptions = {}) {
  const options = normalizeOptions(inputOptions);
  const variationCalculator =
    typeof inputOptions.variationCalculator === "function"
      ? inputOptions.variationCalculator
      : createWmmCalculator();
  const sources = new Map();
  let selectedGnssSource = null;
  let selectedHeadingKey = null;
  let pendingHeadingKey = null;
  let pendingHeadingSinceMs = null;
  let trackProxyActive = false;
  let trackProxySource = null;
  let pendingTrackProxySource = null;
  let pendingTrackProxySinceMs = null;
  let pendingTrackProxyCourseTimestampMs = null;
  let trackProxyDiagnostic = null;
  let replayClock = null;

  return {
    ingestDelta,
    resolve,
    reset,
    sourceSnapshot,
  };

  function reset() {
    sources.clear();
    selectedGnssSource = null;
    selectedHeadingKey = null;
    pendingHeadingKey = null;
    pendingHeadingSinceMs = null;
    resetTrackProxy();
    trackProxyDiagnostic = null;
    replayClock = null;
  }

  function ingestDelta(delta, receivedAtMs = Date.now()) {
    if (!delta || typeof delta !== "object") return 0;
    let accepted = 0;
    for (const update of delta.updates || []) {
      const context = update.context || delta.context || "vessels.self";
      if (!options.selfContexts.includes(context)) continue;
      const source = sourceId(update, delta);
      const aisSelfReport = isAisDynamicNmea2000Update(update, delta);
      const updateTimestamp = timestampOf(update.timestamp || delta.timestamp, receivedAtMs);
      for (const entry of update.values || []) {
        if (entry?.path === CAPTURE_PLAYBACK_PATH) {
          ingestPlaybackClock(unwrapValue(entry.value));
          continue;
        }
        if (!INPUT_PATHS.has(entry?.path)) continue;
        if (!source) continue;
        if (source === options.ownSource) continue;
        const valueInfo = unwrapSignalKValue(entry.value);
        const sampleTimestamp = timestampOf(
          valueInfo.timestamp || updateTimestamp,
          receivedAtMs,
        );
        if (!validInput(entry.path, valueInfo.value)) continue;
        const state = sourceState(source);
        const samples = aisSelfReport
          ? state.aisFallbackSamples
          : state.samples;
        const sample = {
          value: cloneValue(valueInfo.value),
          source,
          sourceKind: classifySource(source, options),
          timestamp: sampleTimestamp,
          timestampMs: Date.parse(sampleTimestamp),
          receivedAtMs,
          originalTimestamp:
            replayClock?.active && replayClock.capturedAt
              ? replayClock.capturedAt
              : sampleTimestamp,
          fallbackKind: aisSelfReport ? "ais-self-report" : null,
        };
        samples.set(entry.path, sample);
        if (entry.path === "navigation.courseOverGroundTrue") {
          recordCourseSample(
            state,
            sample,
            aisSelfReport ? "aisFallbackCourseHistory" : "courseHistory",
          );
        }
        state.lastReceivedAtMs = receivedAtMs;
        state.sampleCount += 1;
        accepted += 1;
      }
    }
    return accepted;
  }

  function ingestPlaybackClock(value) {
    if (!value || typeof value !== "object" || value.active !== true) {
      replayClock = null;
      return;
    }
    replayClock = {
      active: true,
      capturedAt: validTimestamp(value.capturedAt) ? value.capturedAt : null,
      mode: value.mode || value.replayMode || null,
      parentVoyage: value.voyageFileName || null,
      rate: value.rate ?? null,
    };
  }

  function resolve(nowMs = Date.now()) {
    const groundSelection = selectGroundTrack(nowMs);
    const position =
      groundSelection?.position ||
      selectPosition(
        nowMs,
        options.positionMaxAgeMs,
        "selected-gnss-position",
      );
    const variationPosition =
      position ||
      selectPosition(
        nowMs,
        options.variationPositionMaxAgeMs,
        "position-for-magnetic-model",
      );
    const magneticVariation = calculateVariation(variationPosition, nowMs);
    const bowHeadingTrue = selectBowHeading({
      nowMs,
      magneticVariation,
    });
    const clockReference = selectClockReference({
      nowMs,
      bowHeadingTrue,
      groundTrack: groundSelection?.groundTrack || null,
    });
    const throughWater = selectThroughWater({
      nowMs,
      bowHeadingTrue,
    });
    const current = selectIndependentCurrent(nowMs);
    const residual = calculateResidual({
      nowMs,
      groundTrack: groundSelection?.groundTrack || null,
      throughWater,
    });
    const gnss = selectGnssStatus(nowMs, groundSelection);
    const status = clockReference?.kind || "unavailable";

    return {
      contract: CONTRACT,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date(nowMs).toISOString(),
      status,
      position,
      groundTrack: groundSelection?.groundTrack || null,
      gnss,
      bowHeadingTrue,
      clockReference,
      magneticVariation,
      throughWater,
      current,
      residual,
      replay: replayClock
        ? {
            active: true,
            capturedAt: replayClock.capturedAt,
            mode: replayClock.mode,
            parentVoyage: replayClock.parentVoyage,
            rate: replayClock.rate,
          }
        : { active: false },
      diagnostics: {
        selectedGnssSource: groundSelection?.source || null,
        selectedGnssQuality: groundSelection?.quality || null,
        selectedHeadingSource: bowHeadingTrue?.source || null,
        selectedHeadingMethod: bowHeadingTrue?.method || null,
        sourceCount: sources.size,
        calculatedSourcesIgnored: Array.from(sources.values())
          .filter((entry) => classifySource(entry.source, options) === "calculated")
          .map((entry) => entry.source)
          .sort(),
        directTrueHeadingFromGnssRejected:
          Array.from(sources.values()).some(
            (source) =>
              classifySource(source.source, options) === "sensor"
              && sourceHasGnssEvidence(source)
              && freshSample(
                source.samples.get("navigation.headingTrue"),
                nowMs,
                options.headingMaxAgeMs,
              )
              && !options.preferredTrueHeadingSources.includes(source.source)
              && !options.independentTrueHeadingSources.includes(source.source)
              && !(
                options.allowGnssTrueHeading
                && selectedGnssSource !== null
                && source.source === selectedGnssSource
              ),
          ),
        trackProxy: trackProxyDiagnostic,
        leewayStatus: throughWater.leewayStatus,
      },
    };
  }

  function selectGroundTrack(nowMs) {
    let candidates = groundTrackCandidates(nowMs, "samples", false);
    if (candidates.length === 0) {
      candidates = groundTrackCandidates(
        nowMs,
        "aisFallbackSamples",
        true,
      );
    }
    const selected = chooseCandidate(
      candidates,
      options.preferredGnssSources,
      selectedGnssSource,
      options.gnssQualitySwitchMargin,
    );
    selectedGnssSource = selected?.source || null;
    if (!selected) return null;

    const position = projectMeasurement(selected.position, nowMs, {
      method: selected.fallback
        ? "ais-self-report-position-fallback"
        : "coherent-gnss-position",
      gpsDependent: true,
    });
    const courseTrue = projectMeasurement(selected.course, nowMs, {
      method: selected.fallback
        ? "ais-self-report-ground-track-fallback"
        : "direct-ground-track",
      gpsDependent: true,
      uncertaintyRad: options.cogUncertaintyRad,
    });
    const speedOverGround = projectMeasurement(selected.speed, nowMs, {
      method: selected.fallback
        ? "ais-self-report-speed-over-ground-fallback"
        : "direct-speed-over-ground",
      gpsDependent: true,
    });
    const timestampMs = Math.min(
      selected.position.timestampMs,
      selected.course.timestampMs,
      selected.speed.timestampMs,
    );
    return {
      source: selected.source,
      position,
      quality: selected.quality,
      groundTrack: {
        courseTrue,
        speedOverGround,
        source: selected.source,
        timestamp: new Date(timestampMs).toISOString(),
        ageMs: Math.max(0, nowMs - timestampMs),
        gpsDependent: true,
        coherent: true,
        fallbackKind: selected.fallback ? "ais-self-report" : null,
        quality: selected.quality,
      },
    };
  }

  function groundTrackCandidates(nowMs, sampleStoreName, fallback) {
    const candidates = [];
    for (const source of sources.values()) {
      if (classifySource(source.source, options) !== "sensor") continue;
      const samples = source[sampleStoreName];
      const position = freshSample(
        samples.get("navigation.position"),
        nowMs,
        fallback
          ? options.aisFallbackMaxAgeMs
          : options.positionMaxAgeMs,
      );
      const course = freshSample(
        samples.get("navigation.courseOverGroundTrue"),
        nowMs,
        fallback
          ? options.aisFallbackMaxAgeMs
          : options.motionMaxAgeMs,
      );
      const speed = freshSample(
        samples.get("navigation.speedOverGround"),
        nowMs,
        fallback
          ? options.aisFallbackMaxAgeMs
          : options.motionMaxAgeMs,
      );
      if (!position || !course || !speed) continue;
      const timestamps = [
        position.timestampMs,
        course.timestampMs,
        speed.timestampMs,
      ];
      if (Math.max(...timestamps) - Math.min(...timestamps) > options.maxInputSkewMs) {
        continue;
      }
      const quality = gnssQualityEvidence(source, nowMs, options);
      if (quality.usable === false) continue;
      candidates.push({
        source: source.source,
        position,
        course,
        speed,
        quality,
        qualityScore: quality.score,
        newestMs: Math.max(position.timestampMs, course.timestampMs, speed.timestampMs),
        fallback,
      });
    }
    return candidates;
  }

  function selectGnssStatus(nowMs, groundSelection) {
    if (groundSelection) {
      return gnssStatusProjection(groundSelection.quality, {
        source: groundSelection.source,
        fixValid: true,
        explicitUnavailable: false,
      });
    }
    const candidates = [];
    for (const source of sources.values()) {
      if (classifySource(source.source, options) !== "sensor") continue;
      const quality = gnssQualityEvidence(source, nowMs, options);
      if (quality.evidence === "unreported") continue;
      candidates.push({ source: source.source, quality });
    }
    candidates.sort((left, right) =>
      finiteOr(right.quality.timestampMs, 0) - finiteOr(left.quality.timestampMs, 0)
    );
    const selected = candidates[0];
    if (!selected) return null;
    return gnssStatusProjection(selected.quality, {
      source: selected.source,
      fixValid: selected.quality.usable === false ? false : null,
      explicitUnavailable: selected.quality.usable === false,
    });
  }

  function selectPosition(
    nowMs,
    maximumAgeMs = options.variationPositionMaxAgeMs,
    method = "position-for-magnetic-model",
  ) {
    let candidates = positionCandidates(
      nowMs,
      maximumAgeMs,
      "samples",
      false,
    );
    if (candidates.length === 0) {
      candidates = positionCandidates(
        nowMs,
        Math.min(maximumAgeMs, options.aisFallbackMaxAgeMs),
        "aisFallbackSamples",
        true,
      );
    }
    const selected = chooseCandidate(
      candidates,
      options.preferredGnssSources,
      selectedGnssSource,
    );
    return selected
      ? projectMeasurement(selected.sample, nowMs, {
          method: selected.fallback
            ? "ais-self-report-position-fallback"
            : method,
          gpsDependent: true,
        })
      : null;
  }

  function positionCandidates(
    nowMs,
    maximumAgeMs,
    sampleStoreName,
    fallback,
  ) {
    const candidates = [];
    for (const source of sources.values()) {
      if (classifySource(source.source, options) !== "sensor") continue;
      const position = freshSample(
        source[sampleStoreName].get("navigation.position"),
        nowMs,
        maximumAgeMs,
      );
      const quality = gnssQualityEvidence(source, nowMs, options);
      if (position && quality.usable !== false) {
        candidates.push({
          source: source.source,
          sample: position,
          quality,
          qualityScore: quality.score,
          newestMs: position.timestampMs,
          fallback,
        });
      }
    }
    return candidates;
  }

  function calculateVariation(position, nowMs) {
    if (!position || !validPosition(position.value)) return null;
    const calculationDate = position.originalTimestamp || position.timestamp;
    let calculated;
    try {
      calculated = variationCalculator(position.value, calculationDate);
    } catch {
      return null;
    }
    if (!calculated || !Number.isFinite(calculated.value)) return null;
    return {
      value: normalizeSignedRadians(calculated.value),
      source: options.ownSource,
      sourceKind: "model",
      timestamp: new Date(nowMs).toISOString(),
      ageMs: 0,
      method: calculated.model || "WMM",
      model: calculated.model || "WMM",
      epochDate: calculated.epochDate || String(calculationDate || "").slice(0, 10) || null,
      uncertaintyRad: finiteOr(calculated.uncertaintyRad, options.variationUncertaintyRad),
      gpsDependent: false,
      positionSource: position.source,
      originalTimestamp: position.originalTimestamp || null,
    };
  }

  function selectBowHeading({
    nowMs,
    magneticVariation,
  }) {
    const directCandidates = [];
    const magneticCandidates = [];

    for (const source of sources.values()) {
      if (classifySource(source.source, options) !== "sensor") continue;
      const direct = freshSample(
        source.samples.get("navigation.headingTrue"),
        nowMs,
        options.headingMaxAgeMs,
      );
      const explicitlyPreferred =
        options.preferredTrueHeadingSources.includes(source.source);
      const explicitlyIndependent =
        options.independentTrueHeadingSources.includes(source.source);
      const selectedGnssHeadingAllowed =
        options.allowGnssTrueHeading
        && selectedGnssSource !== null
        && source.source === selectedGnssSource;
      const directExplicitlyAllowed =
        explicitlyPreferred
        || explicitlyIndependent
        || selectedGnssHeadingAllowed;
      if (direct && directExplicitlyAllowed) {
        directCandidates.push({
          source: source.source,
          sample: direct,
          newestMs: direct.timestampMs,
          method: "direct-true-heading",
          gpsDependent: !explicitlyIndependent,
          rank: 0,
        });
      }

      const magnetic = freshSample(
        source.samples.get("navigation.headingMagnetic"),
        nowMs,
        options.headingMaxAgeMs,
      );
      const magneticExplicitlyPreferred =
        options.preferredMagneticHeadingSources.includes(source.source);
      if (magnetic && magneticVariation && magneticExplicitlyPreferred) {
        const explicitlyIndependent =
          options.independentMagneticHeadingSources.includes(source.source);
        magneticCandidates.push({
          source: source.source,
          sample: magnetic,
          newestMs: magnetic.timestampMs,
          method: "magnetic-heading-plus-wmm",
          gpsDependent:
            sourceHasGnssEvidence(source)
            && !explicitlyIndependent,
          rank: 1,
        });
      }
    }

    const direct = chooseCandidate(
      directCandidates,
      options.preferredTrueHeadingSources,
      sourceFromHeadingKey(selectedHeadingKey),
    );
    const magnetic = chooseCandidate(
      magneticCandidates,
      options.preferredMagneticHeadingSources,
      sourceFromHeadingKey(selectedHeadingKey),
    );
    const candidate = direct || magnetic;
    if (!candidate) {
      selectedHeadingKey = null;
      pendingHeadingKey = null;
      pendingHeadingSinceMs = null;
      return null;
    }

    const candidateKey = `${candidate.method}:${candidate.source}`;
    const selectedStillFresh = selectedHeadingKey === candidateKey;
    if (!selectedStillFresh && options.headingAcquireMs > 0) {
      if (pendingHeadingKey !== candidateKey) {
        pendingHeadingKey = candidateKey;
        pendingHeadingSinceMs = nowMs;
      }
      if (nowMs - pendingHeadingSinceMs < options.headingAcquireMs) return null;
    }
    selectedHeadingKey = candidateKey;
    pendingHeadingKey = null;
    pendingHeadingSinceMs = null;

    if (candidate.method === "direct-true-heading") {
      return projectMeasurement(candidate.sample, nowMs, {
        method: candidate.method,
        gpsDependent: candidate.gpsDependent === true,
        uncertaintyRad: options.directHeadingUncertaintyRad,
      });
    }

    const timestampMs = Math.min(
      candidate.sample.timestampMs,
      Date.parse(magneticVariation.timestamp),
    );
    return {
      value: normalizeRadians(candidate.sample.value + magneticVariation.value),
      source: candidate.source,
      sourceKind: "sensor",
      timestamp: new Date(timestampMs).toISOString(),
      ageMs: Math.max(0, nowMs - timestampMs),
      method: candidate.method,
      uncertaintyRad: Math.hypot(
        options.magneticHeadingUncertaintyRad,
        magneticVariation.uncertaintyRad || 0,
      ),
      gpsDependent: candidate.gpsDependent === true,
      magneticHeading: candidate.sample.value,
      magneticVariation: magneticVariation.value,
      magneticVariationSource: magneticVariation.source,
      originalTimestamp: candidate.sample.originalTimestamp || null,
    };
  }

  function selectClockReference({ nowMs, bowHeadingTrue, groundTrack }) {
    const trackProxy = selectTrackProxy({ nowMs, groundTrack });
    if (bowHeadingTrue) {
      return {
        ...bowHeadingTrue,
        kind: "heading",
      };
    }
    return trackProxy;
  }

  function selectTrackProxy({ nowMs, groundTrack }) {
    const speed = groundTrack?.speedOverGround?.value;
    const source = groundTrack?.source || null;
    if (!groundTrack || !source || !Number.isFinite(speed)) {
      resetTrackProxy();
      trackProxyDiagnostic = {
        active: false,
        source,
        reason: "ground-track-unavailable",
      };
      return null;
    }
    if (
      !Number.isFinite(groundTrack.ageMs) ||
      groundTrack.ageMs > options.trackProxyMaxAgeMs
    ) {
      resetTrackProxy();
      trackProxyDiagnostic = {
        active: false,
        source,
        speed,
        ageMs: groundTrack.ageMs ?? null,
        maximumAgeMs: options.trackProxyMaxAgeMs,
        reason: "ground-track-stale",
      };
      return null;
    }

    const stability = assessTrackProxyStability(groundTrack, nowMs);
    if (!stability.stable) {
      resetTrackProxy();
      trackProxyDiagnostic = {
        active: false,
        source,
        speed,
        ...stability,
        reason: stability.reason,
      };
      return null;
    }

    const activeForSource = trackProxyActive && trackProxySource === source;
    const speedThreshold = activeForSource
      ? options.trackProxyReleaseSpeed
      : options.trackProxyMinimumSpeed;
    if (speed < speedThreshold) {
      resetTrackProxy();
      trackProxyDiagnostic = {
        active: false,
        source,
        speed,
        speedThreshold,
        ...stability,
        reason: activeForSource
          ? "below-release-speed"
          : "below-acquire-speed",
      };
      return null;
    }

    if (!activeForSource) {
      trackProxyActive = false;
      trackProxySource = null;
      if (pendingTrackProxySource !== source) {
        pendingTrackProxySource = source;
        pendingTrackProxySinceMs = nowMs;
        pendingTrackProxyCourseTimestampMs = Date.parse(
          groundTrack.courseTrue?.timestamp,
        );
      }
      const acquisitionAgeMs = Math.max(0, nowMs - pendingTrackProxySinceMs);
      const hasCourseEvidence =
        options.trackProxyAcquireMs === 0
        || (
          stability.courseSampleCount >= 2
          && Number.isFinite(stability.latestCourseTimestampMs)
          && Number.isFinite(pendingTrackProxyCourseTimestampMs)
          && stability.latestCourseTimestampMs
            > pendingTrackProxyCourseTimestampMs
        );
      if (
        acquisitionAgeMs < options.trackProxyAcquireMs
        || !hasCourseEvidence
      ) {
        trackProxyDiagnostic = {
          active: false,
          source,
          speed,
          speedThreshold,
          acquisitionAgeMs,
          ...stability,
          reason: "acquiring-stable-track",
        };
        return null;
      }
      trackProxyActive = true;
      trackProxySource = source;
      pendingTrackProxySource = null;
      pendingTrackProxySinceMs = null;
      pendingTrackProxyCourseTimestampMs = null;
    }

    const speedFactor = Math.min(1, Math.max(0, speed / 3));
    const projection = {
      ...groundTrack.courseTrue,
      kind: "track-proxy",
      method: "moving-course-over-ground-proxy",
      uncertaintyRad:
        options.trackProxyMaximumUncertaintyRad
        - speedFactor
          * (options.trackProxyMaximumUncertaintyRad
            - options.trackProxyMinimumUncertaintyRad),
      gpsDependent: true,
    };
    trackProxyDiagnostic = {
      active: true,
      source,
      speed,
      speedThreshold: options.trackProxyReleaseSpeed,
      ...stability,
      reason: "qualified",
    };
    return projection;
  }

  function assessTrackProxyStability(groundTrack, nowMs) {
    const source = sources.get(groundTrack?.source);
    const historyName = groundTrack?.fallbackKind === "ais-self-report"
      ? "aisFallbackCourseHistory"
      : "courseHistory";
    const courseHistory = (source?.[historyName] || [])
      .filter((sample) =>
        freshSample(
          sample,
          nowMs,
          options.trackProxyCogStabilityWindowMs,
        ))
      .sort((left, right) => left.timestampMs - right.timestampMs);
    let maxCogTurnRateRadPerSecond = null;
    for (let index = 1; index < courseHistory.length; index += 1) {
      const previous = courseHistory[index - 1];
      const current = courseHistory[index];
      const elapsedSeconds =
        (current.timestampMs - previous.timestampMs) / 1000;
      if (!(elapsedSeconds > 0)) continue;
      const change = Math.abs(
        normalizeSignedRadians(current.value - previous.value),
      );
      const rate = change / elapsedSeconds;
      maxCogTurnRateRadPerSecond =
        maxCogTurnRateRadPerSecond === null
          ? rate
          : Math.max(maxCogTurnRateRadPerSecond, rate);
    }

    let maxReportedTurnRateRadPerSecond = null;
    let reportedTurnRateSource = null;
    for (const candidate of sources.values()) {
      if (classifySource(candidate.source, options) !== "sensor") continue;
      const rate = freshSample(
        candidate.samples.get("navigation.rateOfTurn"),
        nowMs,
        options.motionMaxAgeMs,
      );
      if (!rate) continue;
      const absoluteRate = Math.abs(rate.value);
      if (
        maxReportedTurnRateRadPerSecond === null
        || absoluteRate > maxReportedTurnRateRadPerSecond
      ) {
        maxReportedTurnRateRadPerSecond = absoluteRate;
        reportedTurnRateSource = candidate.source;
      }
    }

    const observedRates = [
      maxCogTurnRateRadPerSecond,
      maxReportedTurnRateRadPerSecond,
    ].filter(Number.isFinite);
    const maximumObservedTurnRateRadPerSecond =
      observedRates.length > 0 ? Math.max(...observedRates) : null;
    const stable =
      maximumObservedTurnRateRadPerSecond === null
      || maximumObservedTurnRateRadPerSecond
        <= options.trackProxyMaximumTurnRateRadPerSecond;
    return {
      stable,
      reason: stable ? "stable" : "unstable-course-over-ground",
      courseSampleCount: courseHistory.length,
      maxCogTurnRateRadPerSecond,
      maxReportedTurnRateRadPerSecond,
      reportedTurnRateSource,
      maximumObservedTurnRateRadPerSecond,
      maximumAllowedTurnRateRadPerSecond:
        options.trackProxyMaximumTurnRateRadPerSecond,
      latestCourseTimestampMs:
        courseHistory.at(-1)?.timestampMs ?? null,
    };
  }

  function resetTrackProxy() {
    trackProxyActive = false;
    trackProxySource = null;
    pendingTrackProxySource = null;
    pendingTrackProxySinceMs = null;
    pendingTrackProxyCourseTimestampMs = null;
  }

  function selectThroughWater({ nowMs, bowHeadingTrue }) {
    const speedCandidates = [];
    for (const source of sources.values()) {
      if (classifySource(source.source, options) !== "sensor") continue;
      const sample = freshSample(
        source.samples.get("navigation.speedThroughWater"),
        nowMs,
        options.motionMaxAgeMs,
      );
      if (sample) {
        speedCandidates.push({
          source: source.source,
          sample,
          newestMs: sample.timestampMs,
        });
      }
    }
    const speed = chooseCandidate(
      speedCandidates,
      options.preferredSpeedThroughWaterSources,
      null,
    );
    const speedThroughWater = speed
      ? projectMeasurement(speed.sample, nowMs, {
          method: "direct-speed-through-water",
          gpsDependent: false,
        })
      : null;

    const leeway = selectConfiguredMeasurement({
      path: "performance.leeway",
      nowMs,
      maxAgeMs: options.leewayMaxAgeMs,
      preferredSources: options.independentLeewaySources,
      method: "explicit-leeway",
      gpsDependent: false,
      requireConfiguredSources: true,
    });
    const trackTrue = bowHeadingTrue && leeway
      ? {
          value: normalizeRadians(bowHeadingTrue.value + leeway.value),
          source: `${bowHeadingTrue.source}+${leeway.source}`,
          sourceKind: "combined",
          timestamp:
            Date.parse(bowHeadingTrue.timestamp) <= Date.parse(leeway.timestamp)
              ? bowHeadingTrue.timestamp
              : leeway.timestamp,
          ageMs: Math.max(bowHeadingTrue.ageMs, leeway.ageMs),
          method: "heading-plus-explicit-leeway",
          uncertaintyRad: Math.hypot(
            bowHeadingTrue.uncertaintyRad || 0,
            leeway.uncertaintyRad || options.leewayUncertaintyRad,
          ),
          gpsDependent:
            bowHeadingTrue.gpsDependent !== false
            || leeway.gpsDependent !== false,
        }
      : null;
    return {
      headingTrue: bowHeadingTrue,
      speedThroughWater,
      leeway,
      trackTrue,
      leewayStatus: leeway ? "known" : "unknown",
    };
  }

  function selectIndependentCurrent(nowMs) {
    if (!options.independentCurrentSources.length) return null;
    const candidates = [];
    for (const sourceName of options.independentCurrentSources) {
      const source = sources.get(sourceName);
      if (!source || classifySource(source.source, options) !== "sensor") continue;
      const setTrue = freshSample(
        source.samples.get("environment.current.setTrue"),
        nowMs,
        options.currentMaxAgeMs,
      );
      const drift = freshSample(
        source.samples.get("environment.current.drift"),
        nowMs,
        options.currentMaxAgeMs,
      );
      if (!setTrue || !drift) continue;
      if (Math.abs(setTrue.timestampMs - drift.timestampMs) > options.maxInputSkewMs) continue;
      candidates.push({
        source: sourceName,
        setTrue,
        drift,
        newestMs: Math.max(setTrue.timestampMs, drift.timestampMs),
      });
    }
    const selected = chooseCandidate(
      candidates,
      options.independentCurrentSources,
      null,
    );
    if (!selected) return null;
    const timestampMs = Math.min(selected.setTrue.timestampMs, selected.drift.timestampMs);
    return {
      setTrue: normalizeRadians(selected.setTrue.value),
      drift: selected.drift.value,
      source: selected.source,
      sourceKind: "sensor",
      timestamp: new Date(timestampMs).toISOString(),
      ageMs: Math.max(0, nowMs - timestampMs),
      origin: "independent-sensor",
      gpsDependent: false,
      quality: "configured",
    };
  }

  function calculateResidual({ nowMs, groundTrack, throughWater }) {
    const course = groundTrack?.courseTrue;
    const speedOverGround = groundTrack?.speedOverGround;
    const heading = throughWater?.headingTrue;
    const speedThroughWater = throughWater?.speedThroughWater;
    if (!course || !speedOverGround || !heading || !speedThroughWater) return null;
    const timestamps = [
      course.timestamp,
      speedOverGround.timestamp,
      heading.timestamp,
      speedThroughWater.timestamp,
    ].map(Date.parse);
    if (
      timestamps.some((value) => !Number.isFinite(value))
      || Math.max(...timestamps) - Math.min(...timestamps) > options.maxInputSkewMs
    ) {
      return null;
    }
    if (
      speedOverGround.value < options.residualMinimumSpeed
      && speedThroughWater.value < options.residualMinimumSpeed
    ) {
      return null;
    }

    const waterTrackMeasurement = throughWater.trackTrue || heading;
    const waterTrack = waterTrackMeasurement.value;
    const east =
      speedOverGround.value * Math.sin(course.value)
      - speedThroughWater.value * Math.sin(waterTrack);
    const north =
      speedOverGround.value * Math.cos(course.value)
      - speedThroughWater.value * Math.cos(waterTrack);
    const drift = Math.hypot(east, north);
    const setTrue = drift <= 1e-9 ? null : normalizeRadians(Math.atan2(east, north));
    const headingUncertainty = throughWater.trackTrue?.uncertaintyRad
      ?? Math.hypot(
        heading.uncertaintyRad || 0,
        throughWater.leeway ? 0 : options.unknownLeewayUncertaintyRad,
      );
    return {
      setTrue,
      drift,
      east,
      north,
      source:
        `${groundTrack.source}+${speedThroughWater.source}`
        + `+${waterTrackMeasurement.source}`,
      sourceKind: "calculated",
      timestamp: new Date(Math.min(...timestamps)).toISOString(),
      ageMs: Math.max(0, nowMs - Math.min(...timestamps)),
      origin: "ground-minus-water-residual",
      gpsDependent: true,
      leewayStatus: throughWater.leewayStatus,
      quality: "instantaneous",
      uncertaintyMetersPerSecond:
        Math.abs(speedThroughWater.value * Math.sin(headingUncertainty)),
    };
  }

  function selectConfiguredMeasurement({
    path,
    nowMs,
    maxAgeMs,
    preferredSources,
    method,
    gpsDependent,
    requireConfiguredSources,
  }) {
    if (requireConfiguredSources && !preferredSources.length) return null;
    const candidates = [];
    for (const source of sources.values()) {
      if (classifySource(source.source, options) !== "sensor") continue;
      if (preferredSources.length && !preferredSources.includes(source.source)) continue;
      const sample = freshSample(source.samples.get(path), nowMs, maxAgeMs);
      if (sample) {
        candidates.push({
          source: source.source,
          sample,
          newestMs: sample.timestampMs,
        });
      }
    }
    const selected = chooseCandidate(candidates, preferredSources, null);
    return selected
      ? projectMeasurement(selected.sample, nowMs, {
          method,
          gpsDependent,
          uncertaintyRad: options.leewayUncertaintyRad,
        })
      : null;
  }

  function sourceState(source) {
    const key = String(source || "unknown");
    if (!sources.has(key)) {
      sources.set(key, {
        source: key,
        samples: new Map(),
        aisFallbackSamples: new Map(),
        courseHistory: [],
        aisFallbackCourseHistory: [],
        lastReceivedAtMs: 0,
        sampleCount: 0,
      });
    }
    return sources.get(key);
  }

  function recordCourseSample(source, sample, historyName = "courseHistory") {
    const history = source[historyName];
    const duplicateIndex = history.findIndex(
      (entry) => entry.timestampMs === sample.timestampMs,
    );
    if (duplicateIndex >= 0) {
      history[duplicateIndex] = sample;
    } else {
      history.push(sample);
    }
    history.sort((left, right) => left.timestampMs - right.timestampMs);
    const newestTimestampMs = history.at(-1)?.timestampMs || sample.timestampMs;
    const retentionMs =
      2 * Math.max(
        options.trackProxyCogStabilityWindowMs,
        options.motionMaxAgeMs,
      );
    source[historyName] = history
      .filter((entry) => entry.timestampMs >= newestTimestampMs - retentionMs)
      .slice(-64);
  }

  function sourceSnapshot() {
    return Array.from(sources.values())
      .map((source) => ({
        source: source.source,
        sourceKind: classifySource(source.source, options),
        sampleCount: source.sampleCount,
        paths: Array.from(source.samples.keys()).sort(),
        aisFallbackPaths: Array.from(source.aisFallbackSamples.keys()).sort(),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
  }
}

function sourceHasGnssEvidence(source) {
  if (!source?.samples) return false;
  return [
    "navigation.position",
    "navigation.courseOverGroundTrue",
    "navigation.speedOverGround",
    "navigation.gnss.methodQuality",
    "navigation.gnss.satellites",
    "navigation.gnss.satellitesInView",
    "navigation.gnss.horizontalDilution",
    "navigation.gnss.hdop",
    "navigation.gnss.integrity",
    "navigation.gnss.type",
    "navigation.gps.methodQuality",
    "navigation.gps.satellites",
    "navigation.gps.horizontalDilution",
  ].some((path) => source.samples.has(path));
}

function normalizeOptions(value = {}) {
  const trackProxyMinimumSpeed = Math.max(
    0,
    finiteOr(value.trackProxyMinimumSpeed, 0.5),
  );
  const trackProxyAcquireMs = seconds(value.trackProxyAcquireSeconds, 2);
  const trackProxyCogStabilityWindowMs = Math.max(
    trackProxyAcquireMs,
    seconds(value.trackProxyCogStabilityWindowSeconds, 5),
  );
  return {
    ownSource: String(value.ownSource || "signalk-ajrm-marine-navigation-reference"),
    selfContexts: uniqueStrings([
      "vessels.self",
      ...(Array.isArray(value.selfContexts) ? value.selfContexts : []),
    ]),
    calculatedSources: uniqueStrings([
      ...DEFAULT_CALCULATED_SOURCES,
      ...(Array.isArray(value.calculatedSources) ? value.calculatedSources : []),
    ]),
    calculatedSourcePrefixes: uniqueStrings(
      Array.isArray(value.calculatedSourcePrefixes)
        ? value.calculatedSourcePrefixes
        : ["signalk-ajrm-marine-"],
    ),
    preferredGnssSources: uniqueStrings(value.preferredGnssSources),
    preferredTrueHeadingSources: uniqueStrings(value.preferredTrueHeadingSources),
    independentTrueHeadingSources: uniqueStrings(
      value.independentTrueHeadingSources,
    ),
    preferredMagneticHeadingSources: uniqueStrings(value.preferredMagneticHeadingSources),
    independentMagneticHeadingSources: uniqueStrings(
      value.independentMagneticHeadingSources,
    ),
    preferredSpeedThroughWaterSources: uniqueStrings(value.preferredSpeedThroughWaterSources),
    independentCurrentSources: uniqueStrings(value.independentCurrentSources),
    independentLeewaySources: uniqueStrings(value.independentLeewaySources),
    allowGnssTrueHeading: value.allowGnssTrueHeading === true,
    positionMaxAgeMs: seconds(value.positionMaxAgeSeconds, 30),
    variationPositionMaxAgeMs: seconds(value.variationPositionMaxAgeSeconds, 3600),
    motionMaxAgeMs: seconds(value.motionMaxAgeSeconds, 30),
    aisFallbackMaxAgeMs: seconds(value.aisFallbackMaxAgeSeconds, 45),
    headingMaxAgeMs: seconds(value.headingMaxAgeSeconds, 5),
    currentMaxAgeMs: seconds(value.currentMaxAgeSeconds, 30),
    leewayMaxAgeMs: seconds(value.leewayMaxAgeSeconds, 10),
    headingAcquireMs: seconds(value.headingAcquireSeconds, 2),
    gnssQualityMaxAgeMs: seconds(value.gnssQualityMaxAgeSeconds, 30),
    gnssQualitySwitchMargin: Math.max(
      0,
      finiteOr(value.gnssQualitySwitchMargin, 5),
    ),
    maxInputSkewMs: seconds(value.maxInputSkewSeconds, 3),
    trackProxyMinimumSpeed,
    trackProxyReleaseSpeed: Math.min(
      trackProxyMinimumSpeed,
      Math.max(0, finiteOr(value.trackProxyReleaseSpeed, 0.3)),
    ),
    trackProxyAcquireMs,
    trackProxyCogStabilityWindowMs,
    trackProxyMaxAgeMs: seconds(value.trackProxyMaxAgeSeconds, 5),
    trackProxyMaximumTurnRateRadPerSecond: degrees(
      Math.max(
        0,
        finiteOr(value.trackProxyMaximumTurnRateDegreesPerSecond, 15),
      ),
      15,
    ),
    residualMinimumSpeed: finiteOr(value.residualMinimumSpeed, 0.25),
    directHeadingUncertaintyRad: degrees(value.directHeadingUncertaintyDegrees, 2),
    magneticHeadingUncertaintyRad: degrees(value.magneticHeadingUncertaintyDegrees, 5),
    variationUncertaintyRad: degrees(value.variationUncertaintyDegrees, 0.5),
    cogUncertaintyRad: degrees(value.cogUncertaintyDegrees, 3),
    trackProxyMinimumUncertaintyRad: degrees(
      value.trackProxyMinimumUncertaintyDegrees,
      3,
    ),
    trackProxyMaximumUncertaintyRad: degrees(
      value.trackProxyMaximumUncertaintyDegrees,
      15,
    ),
    leewayUncertaintyRad: degrees(value.leewayUncertaintyDegrees, 2),
    unknownLeewayUncertaintyRad: degrees(value.unknownLeewayUncertaintyDegrees, 5),
  };
}

function classifySource(source, options) {
  const name = String(source || "").trim();
  if (!name || name === "unknown") return "unknown";
  if (options.calculatedSources.includes(name)) return "calculated";
  if (options.calculatedSourcePrefixes.some((prefix) => name.startsWith(prefix))) {
    return "calculated";
  }
  return "sensor";
}

function sourceId(update, delta) {
  const value =
    update?.$source
    || update?.source?.label
    || delta?.$source
    || delta?.source?.label;
  const name = String(value || "").trim();
  return name || null;
}

function isAisDynamicNmea2000Update(update, delta) {
  const source = update?.source || delta?.source;
  if (String(source?.type || "").toUpperCase() !== "NMEA2000") return false;
  const pgn = Number(source?.pgn);
  return Number.isInteger(pgn) && AIS_DYNAMIC_NMEA2000_PGNS.has(pgn);
}

function unwrapSignalKValue(input) {
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.prototype.hasOwnProperty.call(input, "value")
    && (
      Object.prototype.hasOwnProperty.call(input, "timestamp")
      || Object.prototype.hasOwnProperty.call(input, "$source")
    )
  ) {
    return { value: input.value, timestamp: input.timestamp };
  }
  return { value: input, timestamp: null };
}

function unwrapValue(input) {
  if (
    input
    && typeof input === "object"
    && Object.prototype.hasOwnProperty.call(input, "value")
  ) {
    return input.value;
  }
  return input;
}

function validInput(path, value) {
  if (path === "navigation.position") return validPosition(value);
  if (
    path === "navigation.gnss.methodQuality"
    || path === "navigation.gnss.integrity"
    || path === "navigation.gnss.type"
    || path === "navigation.gps.methodQuality"
  ) {
    return typeof value === "string" || Number.isFinite(value);
  }
  return Number.isFinite(value);
}

function freshSample(sample, nowMs, maxAgeMs) {
  if (!sample || !Number.isFinite(sample.timestampMs)) return null;
  const timestampAge = nowMs - sample.timestampMs;
  const arrivalAge = nowMs - sample.receivedAtMs;
  if (timestampAge < -5000 || timestampAge > maxAgeMs || arrivalAge > maxAgeMs) return null;
  return sample;
}

function chooseCandidate(
  candidates,
  preferredSources,
  currentSource,
  qualitySwitchMargin = 0,
) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const preferences = Array.isArray(preferredSources) ? preferredSources : [];
  return [...candidates].sort((left, right) => {
    const leftPreference = preferenceIndex(left.source, preferences);
    const rightPreference = preferenceIndex(right.source, preferences);
    if (leftPreference !== rightPreference) return leftPreference - rightPreference;
    const leftQuality = finiteOr(left.qualityScore, 0);
    const rightQuality = finiteOr(right.qualityScore, 0);
    if (left.source === currentSource && right.source !== currentSource) {
      if (leftQuality + qualitySwitchMargin >= rightQuality) return -1;
    }
    if (right.source === currentSource && left.source !== currentSource) {
      if (rightQuality + qualitySwitchMargin >= leftQuality) return 1;
    }
    if (leftQuality !== rightQuality) return rightQuality - leftQuality;
    if (right.newestMs !== left.newestMs) return right.newestMs - left.newestMs;
    return String(left.source).localeCompare(String(right.source));
  })[0];
}

function gnssQualityEvidence(source, nowMs, options) {
  const methodQuality = firstFreshSample(
    source,
    [
      "navigation.gnss.methodQuality",
      "navigation.gps.methodQuality",
    ],
    nowMs,
    options.gnssQualityMaxAgeMs,
  );
  const satellites = firstFreshSample(
    source,
    [
      "navigation.gnss.satellites",
      "navigation.gnss.satellitesInView",
      "navigation.gps.satellites",
    ],
    nowMs,
    options.gnssQualityMaxAgeMs,
  );
  const horizontalDilution = firstFreshSample(
    source,
    [
      "navigation.gnss.horizontalDilution",
      "navigation.gnss.hdop",
      "navigation.gps.horizontalDilution",
    ],
    nowMs,
    options.gnssQualityMaxAgeMs,
  );
  const integrity = firstFreshSample(
    source,
    ["navigation.gnss.integrity"],
    nowMs,
    options.gnssQualityMaxAgeMs,
  );
  const type = firstFreshSample(
    source,
    ["navigation.gnss.type"],
    nowMs,
    options.gnssQualityMaxAgeMs,
  );
  const methodText = String(methodQuality?.value ?? "").trim();
  const integrityText = String(integrity?.value ?? "").trim();
  const typeText = String(type?.value ?? "").trim();
  const satelliteCount = numericOrNull(satellites?.value);
  const hdop = numericOrNull(horizontalDilution?.value);
  const methodUnusable =
    /(no gps|no fix|invalid|unavailable)/i.test(methodText);
  const integrityUnusable =
    /(unsafe|invalid|failed)/i.test(integrityText);
  const satellitesUnusable =
    Number.isFinite(satelliteCount) && satelliteCount <= 0;
  const evidenceSamples = [
    methodQuality,
    satellites,
    horizontalDilution,
    integrity,
    type,
  ].filter(Boolean);
  const newestEvidence = evidenceSamples.sort(
    (left, right) => right.timestampMs - left.timestampMs,
  )[0] || null;
  let score = methodQualityScore(methodText);
  if (Number.isFinite(satelliteCount)) {
    score += Math.max(-100, Math.min(30, satelliteCount));
    if (satelliteCount < 4) score -= 100;
  }
  if (Number.isFinite(hdop)) {
    score += Math.max(-100, Math.min(20, 20 - 5 * hdop));
    if (hdop > 10) score -= 100;
  }
  if (/(sbas|waas|egnos|glonass|galileo|beidou|dgnss|rtk)/i.test(typeText)) {
    score += 5;
  }
  if (/(unsafe|invalid|failed|caution)/i.test(integrityText)) score -= 100;
  return {
    score,
    usable: !methodUnusable && !integrityUnusable && !satellitesUnusable,
    rejectionReason: methodUnusable
      ? "gnss-method-reports-no-valid-fix"
      : integrityUnusable
        ? "gnss-integrity-reports-unusable"
        : satellitesUnusable
          ? "gnss-satellites-report-no-fix"
          : null,
    methodQuality: methodText || null,
    satellites: satelliteCount,
    horizontalDilution: hdop,
    integrity: integrityText || null,
    type: typeText || null,
    source: source.source,
    timestamp: newestEvidence
      ? new Date(newestEvidence.timestampMs).toISOString()
      : null,
    timestampMs: newestEvidence?.timestampMs ?? null,
    ageMs: newestEvidence
      ? Math.max(0, nowMs - newestEvidence.timestampMs)
      : null,
    evidence:
      methodQuality || satellites || horizontalDilution || integrity || type
        ? "same-source-gnss-quality"
        : "unreported",
  };
}

function gnssStatusProjection(quality, {
  source,
  fixValid,
  explicitUnavailable,
}) {
  return {
    source,
    sourceKind: "gnss",
    timestamp: quality?.timestamp || null,
    ageMs: quality?.ageMs ?? null,
    gpsDependent: true,
    fixValid,
    explicitUnavailable,
    rejectionReason: quality?.rejectionReason || null,
    methodQuality: quality?.methodQuality || null,
    satellites: quality?.satellites ?? null,
    horizontalDilution: quality?.horizontalDilution ?? null,
    integrity: quality?.integrity || null,
    type: quality?.type || null,
    evidence: quality?.evidence || "unreported",
  };
}

function firstFreshSample(source, paths, nowMs, maxAgeMs) {
  for (const path of paths) {
    const sample = freshSample(source.samples.get(path), nowMs, maxAgeMs);
    if (sample) return sample;
  }
  return null;
}

function methodQualityScore(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return 0;
  if (
    text.includes("no gps")
    || text.includes("no fix")
    || text.includes("invalid")
    || text.includes("unavailable")
  ) {
    return -1000;
  }
  if (
    text.includes("fix")
    || text.includes("precise")
    || text.includes("differential")
    || text.includes("rtk")
  ) {
    return 100;
  }
  return 0;
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function preferenceIndex(source, preferences) {
  const index = preferences.indexOf(source);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function projectMeasurement(sample, nowMs, extras = {}) {
  return {
    value: cloneValue(sample.value),
    source: sample.source,
    sourceKind: sample.sourceKind,
    timestamp: sample.timestamp,
    ageMs: Math.max(0, nowMs - sample.timestampMs),
    method: extras.method || "direct",
    uncertaintyRad:
      Number.isFinite(extras.uncertaintyRad) ? extras.uncertaintyRad : undefined,
    uncertaintyMeters:
      Number.isFinite(extras.uncertaintyMeters) ? extras.uncertaintyMeters : undefined,
    gpsDependent: extras.gpsDependent === true,
    originalTimestamp: sample.originalTimestamp || null,
  };
}

function sourceFromHeadingKey(value) {
  if (!value) return null;
  const separator = value.indexOf(":");
  return separator === -1 ? null : value.slice(separator + 1);
}

function timestampOf(value, fallbackMs) {
  if (validTimestamp(value)) return new Date(value).toISOString();
  return new Date(fallbackMs).toISOString();
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value));
}

function normalizeRadians(value) {
  if (!Number.isFinite(value)) return null;
  return ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function normalizeSignedRadians(value) {
  const normalized = normalizeRadians(value);
  return normalized > Math.PI ? normalized - 2 * Math.PI : normalized;
}

function uniqueStrings(value) {
  const entries = Array.isArray(value) ? value : [];
  return [...new Set(entries.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function seconds(value, fallback) {
  const number = Number(value);
  return (Number.isFinite(number) ? Math.max(0, number) : fallback) * 1000;
}

function degrees(value, fallback) {
  return (finiteOr(value, fallback) * Math.PI) / 180;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  CONTRACT,
  DEFAULT_CALCULATED_SOURCES,
  CAPTURE_PLAYBACK_PATH,
  SCHEMA_VERSION,
  STATE_PATH,
  classifySource,
  createNavigationReferenceResolver,
  normalizeOptions,
  normalizeRadians,
};
