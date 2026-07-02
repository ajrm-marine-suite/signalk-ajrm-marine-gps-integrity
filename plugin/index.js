"use strict";

const packageInfo = require("../package.json");
const { evaluateNavigationIntegrity } = require("./lib/navigation-integrity");

const PLUGIN_ID = "signalk-ajrm-marine-gps-integrity";
const LOGGER_PLAYBACK_PATH = "plugins.ajrmMarineLogger.playback";
const STATE_PATH = "plugins.ajrmMarineGpsIntegrity.navigationIntegrity";
const NOTIFICATION_PATH = "notifications.navigation.gnss.integrity";
const TRUSTED_PREFIX = "plugins.ajrmMarineGpsIntegrity.trusted";
const DEAD_RECKONING_PREFIX = "plugins.ajrmMarineGpsIntegrity.deadReckoning";
const COUNTERS_PREFIX = "plugins.ajrmMarineGpsIntegrity.counters";
const DISTANCE_METADATA_PATHS = [
  "navigation.closestApproach.distance",
  "navigation.courseGreatCircle.distance",
  "navigation.courseRhumbline.distance",
];
const PROJECTION_PATHS = [
  `${TRUSTED_PREFIX}.accepted`,
  `${TRUSTED_PREFIX}.position`,
  `${TRUSTED_PREFIX}.speedOverGround`,
  `${TRUSTED_PREFIX}.courseOverGroundTrue`,
  `${TRUSTED_PREFIX}.headingTrue`,
  `${TRUSTED_PREFIX}.timestamp`,
  `${TRUSTED_PREFIX}.source`,
  `${TRUSTED_PREFIX}.rejectionReason`,
  `${DEAD_RECKONING_PREFIX}.position`,
  `${DEAD_RECKONING_PREFIX}.uncertaintyRadiusMeters`,
  `${DEAD_RECKONING_PREFIX}.source`,
  `${DEAD_RECKONING_PREFIX}.ageSeconds`,
  `${DEAD_RECKONING_PREFIX}.operational.position`,
  `${DEAD_RECKONING_PREFIX}.operational.uncertaintyRadiusMeters`,
  `${DEAD_RECKONING_PREFIX}.operational.source`,
  `${DEAD_RECKONING_PREFIX}.operational.ageSeconds`,
  `${DEAD_RECKONING_PREFIX}.operational.lastRealignedAt`,
  `${DEAD_RECKONING_PREFIX}.integrity.position`,
  `${DEAD_RECKONING_PREFIX}.integrity.uncertaintyRadiusMeters`,
  `${DEAD_RECKONING_PREFIX}.integrity.source`,
  `${DEAD_RECKONING_PREFIX}.integrity.ageSeconds`,
  `${DEAD_RECKONING_PREFIX}.integrity.lastRealignedAt`,
  `${DEAD_RECKONING_PREFIX}.integrity.realignIntervalSeconds`,
  `${COUNTERS_PREFIX}.evaluations`,
  `${COUNTERS_PREFIX}.acceptedFixes`,
  `${COUNTERS_PREFIX}.rejectedFixes`,
  `${COUNTERS_PREFIX}.positionJumps`,
  `${COUNTERS_PREFIX}.lostFixes`,
  `${COUNTERS_PREFIX}.degradedSignals`,
  `${COUNTERS_PREFIX}.drDiscrepancies`,
];

module.exports = function ajrmMarineGpsIntegrity(app) {
  const plugin = {};
  let options = normalizeOptions({});
  let timer = null;
  let latestState = null;
  let latestSample = null;
  let lastNotificationSignature = null;
  let activeNotificationKey = null;
  let activeNotificationEventId = null;
  let activeNotificationRevision = null;
  let unsubscribes = [];
  let activeReplayKey = null;
  let activeReplayRate = 1;
  let lastReplayClock = null;

  plugin.id = PLUGIN_ID;
  plugin.name = "AJRM Marine GPS Integrity";
  plugin.description =
    "Monitors GNSS trust, compares GPS with dead reckoning, and publishes navigation integrity state.";

  plugin.schema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", title: "Enable GPS integrity monitor", default: true },
      alertsEnabled: { type: "boolean", title: "Enable GPS integrity alerts", default: true },
      updateIntervalMs: {
        type: "integer",
        title: "Evaluation interval",
        default: 1000,
        minimum: 500,
        maximum: 10000,
      },
      maxBoatSpeedKnots: {
        type: "number",
        title: "Maximum physically possible boat speed",
        default: 30,
        minimum: 3,
        maximum: 80,
      },
      maxHdop: { type: "number", title: "Maximum acceptable HDOP", default: 4 },
      minSatellites: { type: "integer", title: "Minimum satellites", default: 4 },
      warningDrDiscrepancyMeters: {
        type: "number",
        title: "Dead-reckoning warning discrepancy",
        default: 50,
      },
      alarmDrDiscrepancyMeters: {
        type: "number",
        title: "Dead-reckoning alarm discrepancy",
        default: 150,
      },
      gpsLostSeconds: { type: "number", title: "GPS lost age", default: 15 },
      integrityDrRealignSeconds: {
        type: "number",
        title: "Spoofing check reset interval",
        description:
          "How often the independent dead-reckoning comparison track is reset to trusted GPS while GPS is healthy. Shorter reduces normal drift warnings; longer is stricter for slow spoofing.",
        default: 300,
        minimum: 60,
        maximum: 86400,
      },
    },
  };

  plugin.start = (pluginOptions = {}) => {
    options = normalizeOptions(pluginOptions);
    latestState = null;
    lastNotificationSignature = null;
    activeNotificationKey = null;
    activeNotificationEventId = null;
    activeNotificationRevision = null;
    activeReplayKey = null;
    activeReplayRate = 1;
    lastReplayClock = null;
    if (options.enabled) {
      subscribeToLoggerPlayback();
      timer = setInterval(evaluateAndPublish, options.updateIntervalMs);
      evaluateAndPublish();
    }
    app.setPluginStatus?.(`${options.enabled ? "Started" : "Disabled"} v${packageInfo.version}`);
  };

  plugin.stop = () => {
    if (timer) clearInterval(timer);
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Best-effort during shutdown.
      }
    }
    unsubscribes = [];
    timer = null;
    latestState = null;
    lastNotificationSignature = null;
    activeNotificationKey = null;
    activeNotificationEventId = null;
    activeNotificationRevision = null;
    activeReplayKey = null;
    activeReplayRate = 1;
    lastReplayClock = null;
    publishValue(STATE_PATH, null);
    publishValues(PROJECTION_PATHS.map((path) => ({ path, value: null })));
    publishValue(NOTIFICATION_PATH, null);
  };

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      res.json(statusResponse());
    });
    router.put("/settings", async (req, res) => {
      try {
        options = normalizeOptions({
          ...options,
          alertsEnabled: req.body?.alertsEnabled,
          integrityDrRealignSeconds: req.body?.integrityDrRealignSeconds,
        });
        await savePluginOptions(options);
        if (!options.alertsEnabled) publishValue(NOTIFICATION_PATH, null);
        res.json(statusResponse());
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] settings save failed: ${error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });
    router.post("/reset", (_req, res) => {
      resetRuntimeState("manual");
      if (options.enabled) evaluateAndPublish();
      res.json(statusResponse());
    });
    router.post("/manual-fix", (req, res) => {
      try {
        const manualFix = normalizeManualFix(req.body);
        latestState = manualFixState(manualFix);
        latestSample = sampleFromSignalK(app);
        publishValues([
          { path: STATE_PATH, value: latestState },
          ...navigationProjectionValues(latestState),
        ]);
        publishNotification(notificationValue(latestState));
        res.json({ ok: true, manualFix, state: latestState });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });
  };

  return plugin;

  function subscribeToLoggerPlayback() {
    if (!app.subscriptionmanager?.subscribe) return;
    app.subscriptionmanager.subscribe(
      {
        context: "vessels.self",
        subscribe: [{ path: LOGGER_PLAYBACK_PATH, policy: "instant", format: "delta" }],
      },
      unsubscribes,
      (error) => app.error?.(`[${PLUGIN_ID}] subscription error: ${error}`),
      handleLoggerPlaybackDelta,
    );
  }

  function handleLoggerPlaybackDelta(delta) {
    for (const update of delta?.updates || []) {
      const context = update.context || delta.context || "vessels.self";
      if (context !== "vessels.self") continue;
      for (const entry of update.values || []) {
        if (entry.path !== LOGGER_PLAYBACK_PATH) continue;
        handleLoggerPlaybackValue(entry.value);
      }
    }
  }

  function handleLoggerPlaybackValue(value = {}) {
    if (!value || typeof value !== "object" || !value.playing) {
      activeReplayKey = null;
      activeReplayRate = 1;
      lastReplayClock = null;
      return;
    }
    const replayKey = [
      value.voyageFileName || "",
      value.displayFileName || "",
      value.fileName || "",
      value.sourceKind || "",
    ].join("|");
    if (replayKey && replayKey !== activeReplayKey) {
      resetRuntimeStateForReplay();
      activeReplayKey = replayKey;
      lastReplayClock = null;
    }
    activeReplayRate = replayRateFromPlaybackValue(value);
  }

  function resetRuntimeStateForReplay() {
    resetRuntimeState("replay");
  }

  function resetRuntimeState(_reason = "manual") {
    latestState = null;
    latestSample = null;
    lastNotificationSignature = null;
    activeNotificationKey = null;
    activeNotificationEventId = null;
    activeNotificationRevision = null;
  }

  function manualFixState(manualFix) {
    const sample = sampleFromSignalK(app);
    const timestamp = manualFix.timestamp;
    const lastTrustedFix = {
      position: manualFix.position,
      timestamp,
      hdop: null,
      satellites: null,
      source: "manual-fix",
      note: manualFix.note || null,
    };
    const motionSample = {
      ...sample,
      position: manualFix.position,
      positionTimestamp: timestamp,
      fixValid: false,
    };
    const deadReckoning = {
      position: manualFix.position,
      uncertaintyRadiusMeters: 10,
      source: "manual-fix",
      ageSeconds: 0,
      lastRealignedAt: timestamp,
      realignIntervalSeconds: 0,
    };
    return {
      ok: true,
      timestamp,
      trust: "lost",
      notificationState: "alarm",
      acceptedGps: false,
      acceptedManualFix: true,
      reasons: ["Position set from manual observed fix. GPS position is missing or invalid."],
      counters: latestState?.counters || {},
      gps: {
        position: sample.position || null,
        fixValid: false,
        positionTimestamp: sample.positionTimestamp || null,
        positionAgeSeconds: null,
        hdop: null,
        satellites: null,
        speedOverGround: sample.speedOverGround ?? null,
        courseOverGroundTrue: sample.courseOverGroundTrue ?? null,
        headingTrue: sample.headingTrue ?? null,
      },
      lastTrustedFix,
      manualFix,
      pendingGpsCandidate: null,
      degradedSignalActive: false,
      drDiscrepancyActive: false,
      deadReckoning,
      operationalDeadReckoning: deadReckoning,
      integrityDeadReckoning: {
        ...deadReckoning,
        source: "manual-fix",
        realignIntervalSeconds: options.integrityDrRealignSeconds,
      },
      vectors: buildManualFixVectors(motionSample),
    };
  }

  function replayRateFromPlaybackValue(value) {
    const explicitRate = normalizeReplayRate(value.rate);
    if (explicitRate !== null) {
      lastReplayClock = replayClock(value);
      return explicitRate;
    }
    const clock = replayClock(value);
    if (!clock || !lastReplayClock) {
      lastReplayClock = clock;
      return Math.max(20, activeReplayRate);
    }
    const sourceElapsed = clock.sourceMs - lastReplayClock.sourceMs;
    const wallElapsed = clock.wallMs - lastReplayClock.wallMs;
    lastReplayClock = clock;
    if (sourceElapsed > 0 && wallElapsed > 0) {
      return Math.min(500, Math.max(20, activeReplayRate, sourceElapsed / wallElapsed));
    }
    return Math.max(20, activeReplayRate);
  }

  function replayClock(value) {
    const sourceMs = Date.parse(value?.capturedAt);
    if (!Number.isFinite(sourceMs)) return null;
    return { sourceMs, wallMs: Date.now() };
  }

  function normalizeReplayRate(value) {
    if (String(value || "").toLowerCase() === "max") return null;
    if (value === undefined || value === null || value === "") return null;
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  function evaluateAndPublish() {
    updateReplayBoundaryFromSignalK();
    const sample = sampleFromSignalK(app);
    latestSample = sample;
    latestState = evaluateNavigationIntegrity(sample, latestState, {
      ...options,
      replayTimeScale: activeReplayRate,
      distanceDisplayUnit: preferredDistanceUnit(),
    });
    publishValues([
      { path: STATE_PATH, value: latestState },
      ...navigationProjectionValues(latestState),
    ]);
    publishNotification(notificationValue(latestState));
  }

  function updateReplayBoundaryFromSignalK() {
    handleLoggerPlaybackValue(getSelfPath(app, LOGGER_PLAYBACK_PATH));
  }

  function statusResponse() {
    return {
      ok: true,
      plugin: PLUGIN_ID,
      version: packageInfo.version,
      enabled: options.enabled,
      alertsEnabled: options.alertsEnabled,
      integrityDrRealignSeconds: options.integrityDrRealignSeconds,
      replayTimeScale: activeReplayRate,
      statePath: `vessels.self.${STATE_PATH}`,
      notificationPath: `vessels.self.${NOTIFICATION_PATH}`,
      trustedPrefix: `vessels.self.${TRUSTED_PREFIX}`,
      deadReckoningPrefix: `vessels.self.${DEAD_RECKONING_PREFIX}`,
      countersPrefix: `vessels.self.${COUNTERS_PREFIX}`,
      sample: latestSample || sampleFromSignalK(app),
      state: latestState || evaluateNavigationIntegrity(sampleFromSignalK(app), null, {
        ...options,
        replayTimeScale: activeReplayRate,
        distanceDisplayUnit: preferredDistanceUnit(),
      }),
    };
  }

  function navigationProjectionValues(state) {
    const trustedAccepted = Boolean(
      (state?.acceptedGps && state?.gps?.position) ||
        (state?.acceptedManualFix && state?.lastTrustedFix?.position),
    );
    const trustedPosition = state?.acceptedGps ? state.gps.position : state?.lastTrustedFix?.position;
    const trustedSource = trustedAccepted
      ? state.lastTrustedFix?.source === "manual-fix"
        ? "manual-fix"
        : state.trust === "normal"
          ? "gps"
          : "gps-degraded"
      : state?.trust === "lost"
        ? "unavailable"
        : state?.trust === "suspect"
          ? "rejected"
          : "unknown";
    const deadReckoning = state?.deadReckoning || {};
    const operational = state?.operationalDeadReckoning || deadReckoning || {};
    const integrity = state?.integrityDeadReckoning || {};
    const counters = state?.counters || {};
    return [
      { path: `${TRUSTED_PREFIX}.accepted`, value: trustedAccepted },
      { path: `${TRUSTED_PREFIX}.position`, value: trustedAccepted ? trustedPosition : null },
      { path: `${TRUSTED_PREFIX}.speedOverGround`, value: state?.acceptedGps ? state.gps.speedOverGround : null },
      { path: `${TRUSTED_PREFIX}.courseOverGroundTrue`, value: state?.acceptedGps ? state.gps.courseOverGroundTrue : null },
      { path: `${TRUSTED_PREFIX}.headingTrue`, value: state?.acceptedGps ? state.gps.headingTrue : null },
      { path: `${TRUSTED_PREFIX}.timestamp`, value: trustedAccepted ? state.lastTrustedFix?.timestamp || state.timestamp : null },
      { path: `${TRUSTED_PREFIX}.source`, value: trustedSource },
      { path: `${TRUSTED_PREFIX}.rejectionReason`, value: trustedAccepted ? null : state?.reasons?.join(" ") || null },
      { path: `${DEAD_RECKONING_PREFIX}.position`, value: deadReckoning.position || null },
      {
        path: `${DEAD_RECKONING_PREFIX}.uncertaintyRadiusMeters`,
        value: deadReckoning.uncertaintyRadiusMeters ?? null,
      },
      { path: `${DEAD_RECKONING_PREFIX}.source`, value: deadReckoning.source || null },
      { path: `${DEAD_RECKONING_PREFIX}.ageSeconds`, value: deadReckoning.ageSeconds ?? null },
      { path: `${DEAD_RECKONING_PREFIX}.operational.position`, value: operational.position || null },
      {
        path: `${DEAD_RECKONING_PREFIX}.operational.uncertaintyRadiusMeters`,
        value: operational.uncertaintyRadiusMeters ?? null,
      },
      { path: `${DEAD_RECKONING_PREFIX}.operational.source`, value: operational.source || null },
      { path: `${DEAD_RECKONING_PREFIX}.operational.ageSeconds`, value: operational.ageSeconds ?? null },
      { path: `${DEAD_RECKONING_PREFIX}.operational.lastRealignedAt`, value: operational.lastRealignedAt || null },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.position`, value: integrity.position || null },
      {
        path: `${DEAD_RECKONING_PREFIX}.integrity.uncertaintyRadiusMeters`,
        value: integrity.uncertaintyRadiusMeters ?? null,
      },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.source`, value: integrity.source || null },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.ageSeconds`, value: integrity.ageSeconds ?? null },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.lastRealignedAt`, value: integrity.lastRealignedAt || null },
      {
        path: `${DEAD_RECKONING_PREFIX}.integrity.realignIntervalSeconds`,
        value: integrity.realignIntervalSeconds ?? null,
      },
      { path: `${COUNTERS_PREFIX}.evaluations`, value: counters.evaluations ?? 0 },
      { path: `${COUNTERS_PREFIX}.acceptedFixes`, value: counters.acceptedFixes ?? 0 },
      { path: `${COUNTERS_PREFIX}.rejectedFixes`, value: counters.rejectedFixes ?? 0 },
      { path: `${COUNTERS_PREFIX}.positionJumps`, value: counters.positionJumps ?? 0 },
      { path: `${COUNTERS_PREFIX}.lostFixes`, value: counters.lostFixes ?? 0 },
      { path: `${COUNTERS_PREFIX}.degradedSignals`, value: counters.degradedSignals ?? 0 },
      { path: `${COUNTERS_PREFIX}.drDiscrepancies`, value: counters.drDiscrepancies ?? 0 },
    ];
  }

  function notificationValue(state) {
    if (!state || state.trust === "normal") {
      activeNotificationKey = null;
      activeNotificationEventId = null;
      activeNotificationRevision = null;
      return null;
    }
    const title = state.trust === "lost"
      ? "GPS lost"
      : state.trust === "suspect"
        ? "GPS position suspect"
        : "GPS signal degraded";
    const notificationKey = `${state.trust}:${state.notificationState}`;
    if (notificationKey !== activeNotificationKey) {
      activeNotificationKey = notificationKey;
      activeNotificationEventId = `${PLUGIN_ID}:${state.trust}:${state.timestamp}`;
      activeNotificationRevision = Date.parse(state.timestamp) || Date.now();
    }
    return {
      state: state.notificationState,
      method: ["visual", "sound"],
      message: state.reasons[0] || title,
      data: {
        ajrmMarineNotifications: {
          schemaVersion: 1,
          provider: PLUGIN_ID,
          subjectKey: "navigation.gnss.integrity",
          eventId: activeNotificationEventId,
          revision: activeNotificationRevision,
          lifecycle: "active",
          priority: {
            level: state.trust === "degraded" ? "warning" : "danger",
            score: state.trust === "degraded" ? 500 : 850,
          },
          history: { policy: "on-resolve" },
          delivery: {
            visual: true,
            audio: true,
            repeatSeconds: state.trust === "degraded" ? 300 : 120,
            preempt: false,
          },
          presentation: {
            title,
            message: state.reasons.join(" ") || title,
            category: "Navigation",
            facts: state.reasons,
          },
          context: {
            trust: state.trust,
            statePath: `vessels.self.${STATE_PATH}`,
          },
        },
      },
    };
  }

  function publishNotification(value) {
    if (!options.alertsEnabled) {
      value = null;
    }
    const signature = JSON.stringify(value);
    if (signature === lastNotificationSignature) return;
    lastNotificationSignature = signature;
    publishValue(NOTIFICATION_PATH, value);
  }

  function publishValue(path, value) {
    publishValues([{ path, value }]);
  }

  function savePluginOptions(nextOptions) {
    return new Promise((resolve, reject) => {
      if (typeof app.savePluginOptions !== "function") {
        resolve();
        return;
      }
      app.savePluginOptions(nextOptions, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function publishValues(values) {
    if (!app.handleMessage) return;
    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          values,
        },
      ],
    });
  }

  function preferredDistanceUnit() {
    for (const pathName of DISTANCE_METADATA_PATHS) {
      const metadata = app.getMetadata?.(pathName);
      const unit =
        metadata?.displayUnits?.targetUnit ||
        metadata?.displayUnits?.units ||
        metadata?.displayUnits?.symbol;
      if (unit) return unit;
    }
    return "nmi";
  }
};

function sampleFromSignalK(app) {
  const entries = {
    position: getSelfEntry(app, "navigation.position"),
    speedOverGround: getSelfEntry(app, "navigation.speedOverGround"),
    courseOverGroundTrue: getSelfEntry(app, "navigation.courseOverGroundTrue"),
    headingTrue: getSelfEntry(app, "navigation.headingTrue"),
    headingMagnetic: getSelfEntry(app, "navigation.headingMagnetic"),
    speedThroughWater: getSelfEntry(app, "navigation.speedThroughWater"),
  };
  const source = chooseNavigationSource(entries);
  const position = readEntryValue(entries.position, source);
  const positionTimestampMs = sourceTimestamp(entries.position, source);
  const speedOverGroundTimestampMs = sourceTimestamp(entries.speedOverGround, source);
  const courseOverGroundTrueTimestampMs = sourceTimestamp(entries.courseOverGroundTrue, source);
  const headingTrueTimestampMs = sourceTimestamp(entries.headingTrue, source);
  const headingMagneticTimestampMs = sourceTimestamp(entries.headingMagnetic, source);
  const speedThroughWaterTimestampMs = sourceTimestamp(entries.speedThroughWater, source);
  return {
    timestamp: new Date().toISOString(),
    source,
    position,
    positionTimestamp: positionTimestampMs ? new Date(positionTimestampMs).toISOString() : null,
    speedOverGround: readEntryValue(entries.speedOverGround, source),
    speedOverGroundTimestamp: speedOverGroundTimestampMs ? new Date(speedOverGroundTimestampMs).toISOString() : null,
    courseOverGroundTrue: readEntryValue(entries.courseOverGroundTrue, source),
    courseOverGroundTrueTimestamp: courseOverGroundTrueTimestampMs
      ? new Date(courseOverGroundTrueTimestampMs).toISOString()
      : null,
    headingTrue: readEntryValue(entries.headingTrue, source),
    headingTrueTimestamp: headingTrueTimestampMs ? new Date(headingTrueTimestampMs).toISOString() : null,
    headingMagnetic: readEntryValue(entries.headingMagnetic, source),
    headingMagneticTimestamp: headingMagneticTimestampMs ? new Date(headingMagneticTimestampMs).toISOString() : null,
    speedThroughWater: readEntryValue(entries.speedThroughWater, source),
    speedThroughWaterTimestamp: speedThroughWaterTimestampMs
      ? new Date(speedThroughWaterTimestampMs).toISOString()
      : null,
    currentSetTrue: firstPath(app, [
      "environment.current.setTrue",
      "environment.tide.setTrue",
      "environment.water.current.setTrue",
    ]),
    currentDrift: firstPath(app, [
      "environment.current.drift",
      "environment.tide.drift",
      "environment.water.current.drift",
    ]),
    hdop: firstPath(app, [
      "navigation.gnss.horizontalDilution",
      "navigation.gnss.hdop",
      "navigation.gps.horizontalDilution",
    ]),
    satellites: firstPath(app, [
      "navigation.gnss.satellites",
      "navigation.gnss.satellitesInView",
      "navigation.gps.satellites",
    ]),
    fixValid: position != null,
  };
}

function getSelfEntry(app, path) {
  try {
    return app.getSelfPath?.(path);
  } catch (_error) {
    return undefined;
  }
}

function getSelfPath(app, path) {
  try {
    return unwrapSignalKValue(getSelfEntry(app, path));
  } catch (_error) {
    return undefined;
  }
}

function unwrapSignalKValue(entry) {
  if (entry && typeof entry === "object" && Object.hasOwn(entry, "value")) return entry.value;
  return entry;
}

function readEntryValue(entry, source) {
  if (source && entry?.values?.[source] && Object.hasOwn(entry.values[source], "value")) {
    return entry.values[source].value;
  }
  return unwrapSignalKValue(entry);
}

function chooseNavigationSource(entries) {
  const sources = new Set();
  for (const entry of Object.values(entries)) {
    if (entry?.$source) sources.add(entry.$source);
    for (const source of Object.keys(entry?.values || {})) sources.add(source);
  }
  let best = "";
  let bestScore = -Infinity;
  for (const source of sources) {
    const position = readEntryValue(entries.position, source);
    const hasPositionValue = hasSourceValue(entries.position, source);
    if (!hasPositionValue) continue;
    const validPosition = isPosition(position);
    const sog = finiteNumber(readEntryValue(entries.speedOverGround, source));
    const stw = finiteNumber(readEntryValue(entries.speedThroughWater, source));
    const cog = finiteNumber(readEntryValue(entries.courseOverGroundTrue, source));
    const heading = finiteNumber(readEntryValue(entries.headingTrue, source));
    const timestamp = sourceTimestamp(entries.position, source);
    let score = timestamp;
    if (validPosition) score += 500;
    if (Number.isFinite(sog) && sog > 0.05) score += 2000;
    if (Number.isFinite(stw) && stw > 0.05) score += 1500;
    if (Number.isFinite(cog)) score += 200;
    if (Number.isFinite(heading)) score += 100;
    if (source === entries.position?.$source) score += 50;
    if (score > bestScore) {
      bestScore = score;
      best = source;
    }
  }
  return best || entries.position?.$source || "";
}

function hasSourceValue(entry, source) {
  if (!entry || typeof entry !== "object") return false;
  if (source && entry.values?.[source] && Object.hasOwn(entry.values[source], "value")) return true;
  return source === entry.$source && Object.hasOwn(entry, "value");
}

function sourceTimestamp(entry, source) {
  const timestamp = source && entry?.values?.[source]?.timestamp
    ? entry.values[source].timestamp
    : entry?.timestamp;
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isPosition(value) {
  return Number.isFinite(Number(value?.latitude)) && Number.isFinite(Number(value?.longitude));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function firstPath(app, paths) {
  for (const path of paths) {
    const value = getSelfPath(app, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeOptions(value = {}) {
  const interval = Number.parseInt(value.updateIntervalMs, 10);
  return {
    enabled: value.enabled !== false,
    alertsEnabled: value.alertsEnabled !== false,
    updateIntervalMs: Number.isFinite(interval) ? Math.min(10000, Math.max(500, interval)) : 1000,
    maxBoatSpeedKnots: value.maxBoatSpeedKnots,
    maxHdop: value.maxHdop,
    minSatellites: value.minSatellites,
    warningDrDiscrepancyMeters: value.warningDrDiscrepancyMeters,
    alarmDrDiscrepancyMeters: value.alarmDrDiscrepancyMeters,
    gpsLostSeconds: value.gpsLostSeconds,
    integrityDrRealignSeconds: clampNumber(value.integrityDrRealignSeconds, 60, 86400, 300),
    distanceDisplayUnit: value.distanceDisplayUnit,
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeManualFix(value = {}) {
  const source = value.position || value;
  const latitude = Number(source.latitude ?? source.lat);
  const longitude = Number(source.longitude ?? source.lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("Manual fix latitude must be between -90 and 90.");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Manual fix longitude must be between -180 and 180.");
  }
  const timestampMs = value.timestamp ? Date.parse(value.timestamp) : Date.now();
  if (!Number.isFinite(timestampMs)) throw new Error("Manual fix timestamp is invalid.");
  return {
    position: { latitude, longitude },
    timestamp: new Date(timestampMs).toISOString(),
    note: typeof value.note === "string" && value.note.trim() ? value.note.trim().slice(0, 160) : null,
  };
}

function buildManualFixVectors(sample) {
  const toDegrees = (radians) => Number.isFinite(Number(radians))
    ? ((((Number(radians) * 180) / Math.PI) % 360) + 360) % 360
    : null;
  const vector = (speed, bearing, arrow) => {
    const numericSpeed = Number(speed);
    const bearingDegrees = toDegrees(bearing);
    if (!Number.isFinite(numericSpeed) || bearingDegrees === null) return { available: false, arrow };
    return {
      available: true,
      speedMps: numericSpeed,
      speedKnots: numericSpeed * 1.9438444924406046,
      bearingTrueDegrees: bearingDegrees,
      arrow,
    };
  };
  return {
    headingThroughWater: vector(sample.speedThroughWater ?? sample.speedOverGround, sample.headingTrue ?? sample.headingMagnetic, "single"),
    tide: vector(sample.currentDrift, sample.currentSetTrue, "triple"),
    courseOverGround: vector(sample.speedOverGround, sample.courseOverGroundTrue, "double"),
  };
}

module.exports._private = {
  buildManualFixVectors,
  chooseNavigationSource,
  DISTANCE_METADATA_PATHS,
  normalizeManualFix,
  normalizeOptions,
  preferredDistanceUnit: (app) => {
    for (const pathName of DISTANCE_METADATA_PATHS) {
      const metadata = app.getMetadata?.(pathName);
      const unit =
        metadata?.displayUnits?.targetUnit ||
        metadata?.displayUnits?.units ||
        metadata?.displayUnits?.symbol;
      if (unit) return unit;
    }
    return "nmi";
  },
  PROJECTION_PATHS,
  readEntryValue,
  sampleFromSignalK,
  unwrapSignalKValue,
};
