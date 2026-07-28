"use strict";

const packageInfo = require("../package.json");
const { evaluateNavigationIntegrity } = require("./lib/navigation-integrity");

const PLUGIN_ID = "signalk-ajrm-marine-gps-integrity";
const LOGGER_PLAYBACK_PATH = "plugins.ajrmMarineLogger.playback";
const NAVIGATION_REFERENCE_PATH = "plugins.ajrmMarineNavigationReference.state";
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
  `${DEAD_RECKONING_PREFIX}.operational.gpsDependent`,
  `${DEAD_RECKONING_PREFIX}.operational.leewayStatus`,
  `${DEAD_RECKONING_PREFIX}.operational.currentOrigin`,
  `${DEAD_RECKONING_PREFIX}.integrity.position`,
  `${DEAD_RECKONING_PREFIX}.integrity.uncertaintyRadiusMeters`,
  `${DEAD_RECKONING_PREFIX}.integrity.source`,
  `${DEAD_RECKONING_PREFIX}.integrity.ageSeconds`,
  `${DEAD_RECKONING_PREFIX}.integrity.lastRealignedAt`,
  `${DEAD_RECKONING_PREFIX}.integrity.realignIntervalSeconds`,
  `${DEAD_RECKONING_PREFIX}.integrity.assurance`,
  `${DEAD_RECKONING_PREFIX}.integrity.comparisonAvailable`,
  `${DEAD_RECKONING_PREFIX}.integrity.unavailableReason`,
  `${DEAD_RECKONING_PREFIX}.integrity.gpsDependent`,
  `${DEAD_RECKONING_PREFIX}.integrity.leewayStatus`,
  `${DEAD_RECKONING_PREFIX}.integrity.currentOrigin`,
  `${COUNTERS_PREFIX}.evaluations`,
  `${COUNTERS_PREFIX}.acceptedFixes`,
  `${COUNTERS_PREFIX}.rejectedFixes`,
  `${COUNTERS_PREFIX}.positionJumps`,
  `${COUNTERS_PREFIX}.lostFixes`,
  `${COUNTERS_PREFIX}.degradedSignals`,
  `${COUNTERS_PREFIX}.drDiscrepancies`,
];
const PROJECTION_METADATA = [
  {
    path: `${TRUSTED_PREFIX}.speedOverGround`,
    value: {
      units: "m/s",
      description: "Speed over ground associated with the currently trusted GPS fix.",
    },
  },
  {
    path: `${TRUSTED_PREFIX}.courseOverGroundTrue`,
    value: {
      units: "rad",
      description: "True course over ground associated with the currently trusted GPS fix.",
    },
  },
  {
    path: `${TRUSTED_PREFIX}.headingTrue`,
    value: {
      units: "rad",
      description: "True heading associated with the currently trusted GPS fix.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.uncertaintyRadiusMeters`,
    value: {
      units: "m",
      description: "Compatibility dead-reckoning uncertainty radius.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.ageSeconds`,
    value: {
      units: "s",
      description: "Compatibility dead-reckoning age.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.operational.uncertaintyRadiusMeters`,
    value: {
      units: "m",
      description: "Operational dead-reckoning uncertainty radius.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.operational.ageSeconds`,
    value: {
      units: "s",
      description: "Operational dead-reckoning age.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.integrity.uncertaintyRadiusMeters`,
    value: {
      units: "m",
      description: "Independent integrity dead-reckoning uncertainty radius.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.integrity.ageSeconds`,
    value: {
      units: "s",
      description: "Independent integrity dead-reckoning age.",
    },
  },
  {
    path: `${DEAD_RECKONING_PREFIX}.integrity.realignIntervalSeconds`,
    value: {
      units: "s",
      description: "Independent integrity dead-reckoning realignment interval.",
    },
  },
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
    publishProjectionMetadata();
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

  function publishProjectionMetadata() {
    app.handleMessage?.(PLUGIN_ID, {
      updates: [
        {
          meta: PROJECTION_METADATA,
        },
      ],
    });
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
        assurance: "unavailable",
        comparisonAvailable: false,
        unavailableReason: "Manual fix establishes a position baseline but not independent motion evidence.",
        gpsDependent: false,
        leewayStatus: sample.leewayStatus || "unknown",
      },
      integrityAssurance: {
        status: "unavailable",
        comparisonAvailable: false,
        reason: "Manual fix establishes a position baseline but not independent motion evidence.",
        leewayStatus: sample.leewayStatus || "unknown",
      },
      navigationProvenance: {
        gnss: sample.gnssProvenance || null,
        headingTrue: sample.headingTrueEvidence || null,
        speedThroughWater: sample.speedThroughWaterEvidence || null,
        current: sample.currentEvidence || null,
        leewayStatus: sample.leewayStatus || "unknown",
        navigationReference: sample.navigationReference || null,
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
      { path: `${DEAD_RECKONING_PREFIX}.operational.gpsDependent`, value: operational.gpsDependent ?? null },
      { path: `${DEAD_RECKONING_PREFIX}.operational.leewayStatus`, value: operational.leewayStatus || "unknown" },
      { path: `${DEAD_RECKONING_PREFIX}.operational.currentOrigin`, value: operational.currentOrigin || null },
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
      { path: `${DEAD_RECKONING_PREFIX}.integrity.assurance`, value: integrity.assurance || "unavailable" },
      {
        path: `${DEAD_RECKONING_PREFIX}.integrity.comparisonAvailable`,
        value: integrity.comparisonAvailable === true,
      },
      {
        path: `${DEAD_RECKONING_PREFIX}.integrity.unavailableReason`,
        value: integrity.unavailableReason || null,
      },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.gpsDependent`, value: integrity.gpsDependent ?? null },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.leewayStatus`, value: integrity.leewayStatus || "unknown" },
      { path: `${DEAD_RECKONING_PREFIX}.integrity.currentOrigin`, value: integrity.currentOrigin || null },
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
            score: state.trust === "degraded" ? 500 : 750,
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
  const navigationReference = validNavigationReference(
    getSelfPath(app, NAVIGATION_REFERENCE_PATH),
  );
  const gnssEntries = {
    position: getSelfEntry(app, "navigation.position"),
    speedOverGround: getSelfEntry(app, "navigation.speedOverGround"),
    courseOverGroundTrue: getSelfEntry(app, "navigation.courseOverGroundTrue"),
  };
  const candidateReferencePosition = referenceMeasurement(navigationReference?.position);
  const candidateReferenceCourse = referenceMeasurement(
    navigationReference?.groundTrack?.courseTrue,
  );
  const candidateReferenceSpeed = referenceMeasurement(
    navigationReference?.groundTrack?.speedOverGround,
  );
  const referenceGnss =
    navigationReference?.gnss &&
    typeof navigationReference.gnss === "object" &&
    !Array.isArray(navigationReference.gnss)
      ? navigationReference.gnss
      : null;
  const providerAvailable = Boolean(navigationReference);
  const referenceGnssCoherent = Boolean(
    navigationReference?.groundTrack?.coherent === true &&
      navigationReference?.groundTrack?.gpsDependent === true &&
      candidateReferencePosition &&
      candidateReferenceCourse &&
      candidateReferenceSpeed &&
      candidateReferencePosition.gpsDependent === true &&
      candidateReferenceCourse.gpsDependent === true &&
      candidateReferenceSpeed.gpsDependent === true &&
      candidateReferencePosition.source &&
      candidateReferencePosition.source === candidateReferenceCourse.source &&
      candidateReferencePosition.source === candidateReferenceSpeed.source &&
      candidateReferencePosition.source === navigationReference.groundTrack.source,
  );
  const malformedReferenceGroundTrack = Boolean(
    providerAvailable &&
      navigationReference?.groundTrack &&
      !referenceGnssCoherent,
  );
  const referencePosition = malformedReferenceGroundTrack
    ? null
    : candidateReferencePosition;
  const referenceCourse = referenceGnssCoherent
    ? candidateReferenceCourse
    : null;
  const referenceSpeed = referenceGnssCoherent
    ? candidateReferenceSpeed
    : null;
  const source = providerAvailable
    ? referencePosition?.source ||
      referenceCourse?.source ||
      referenceSpeed?.source ||
      referenceGnss?.source ||
      null
    : chooseNavigationSource(gnssEntries);
  const position = providerAvailable
    ? referencePosition?.value
    : readEntryValue(gnssEntries.position, source);
  const speedOverGround = providerAvailable
    ? referenceSpeed?.value
    : readEntryValue(gnssEntries.speedOverGround, source);
  const courseOverGroundTrue = providerAvailable
    ? referenceCourse?.value
    : readEntryValue(gnssEntries.courseOverGroundTrue, source);
  const positionTimestampMs = providerAvailable
    ? timestampNumber(referencePosition?.timestamp)
    : sourceTimestamp(gnssEntries.position, source);
  const speedOverGroundTimestampMs = providerAvailable
    ? timestampNumber(referenceSpeed?.timestamp)
    : sourceTimestamp(gnssEntries.speedOverGround, source);
  const courseOverGroundTrueTimestampMs = providerAvailable
    ? timestampNumber(referenceCourse?.timestamp)
    : sourceTimestamp(gnssEntries.courseOverGroundTrue, source);
  const methodQualityEntry = source || !providerAvailable
    ? firstEntryForSource(app, [
        "navigation.gnss.methodQuality",
        "navigation.gps.methodQuality",
        "navigation.gnss.type",
      ], source)
    : undefined;
  const satellitesEntry = source || !providerAvailable
    ? firstEntryForSource(app, [
        "navigation.gnss.satellites",
        "navigation.gnss.satellitesInView",
        "navigation.gps.satellites",
      ], source)
    : undefined;
  const hdopEntry = source || !providerAvailable
    ? firstEntryForSource(app, [
        "navigation.gnss.horizontalDilution",
        "navigation.gnss.hdop",
        "navigation.gps.horizontalDilution",
      ], source)
    : undefined;
  const methodQualityTimestampMs = sourceTimestamp(methodQualityEntry, source);
  const satellitesTimestampMs = sourceTimestamp(satellitesEntry, source);
  const hdopTimestampMs = sourceTimestamp(hdopEntry, source);
  const referenceGnssTimestampMs = timestampNumber(referenceGnss?.timestamp);
  const methodQuality = providerAvailable && referenceGnss
    ? referenceGnss.methodQuality
    : readEntryValue(methodQualityEntry, source);
  const satellites = providerAvailable && referenceGnss
    ? referenceGnss.satellites
    : readEntryValue(satellitesEntry, source);
  const hdop = providerAvailable && referenceGnss
    ? referenceGnss.horizontalDilution
    : readEntryValue(hdopEntry, source);
  const explicitGpsUnavailable = providerAvailable && referenceGnss
    ? referenceGnss.explicitUnavailable === true ||
      referenceGnss.fixValid === false
    : explicitNoGps(methodQuality, satellites);
  const headingEntry = getSelfEntry(app, "navigation.headingTrue");
  const speedThroughWaterEntry = getSelfEntry(app, "navigation.speedThroughWater");
  const rawHeadingSource = defaultEntrySource(headingEntry);
  const rawSpeedThroughWaterSource = defaultEntrySource(speedThroughWaterEntry);
  const headingMeasurement = providerAvailable
    ? referenceMeasurement(navigationReference?.bowHeadingTrue) ||
      referenceMeasurement(navigationReference?.throughWater?.headingTrue)
    : rawMeasurement(headingEntry, rawHeadingSource, "raw-signalk-heading-true");
  const speedThroughWaterMeasurement = providerAvailable
    ? referenceMeasurement(navigationReference?.throughWater?.speedThroughWater)
    : rawMeasurement(
        speedThroughWaterEntry,
        rawSpeedThroughWaterSource,
        "raw-signalk-speed-through-water",
      );
  const trackThroughWaterMeasurement = referenceMeasurement(
    navigationReference?.throughWater?.trackTrue,
  );
  const leewayMeasurement = referenceMeasurement(navigationReference?.throughWater?.leeway);
  const independentCurrentEvidence = referenceIndependentCurrent(
    navigationReference?.current,
  );
  const residualCurrentEvidence = referenceResidualCurrent(
    navigationReference?.residual,
  );
  const currentEvidence =
    independentCurrentEvidence || residualCurrentEvidence;
  const clockReferenceMeasurement = referenceMeasurement(
    navigationReference?.clockReference,
  );
  return {
    timestamp: new Date().toISOString(),
    source,
    position,
    positionTimestamp: positionTimestampMs ? new Date(positionTimestampMs).toISOString() : null,
    speedOverGround,
    speedOverGroundTimestamp: speedOverGroundTimestampMs ? new Date(speedOverGroundTimestampMs).toISOString() : null,
    courseOverGroundTrue,
    courseOverGroundTrueTimestamp: courseOverGroundTrueTimestampMs
      ? new Date(courseOverGroundTrueTimestampMs).toISOString()
      : null,
    headingTrue: headingMeasurement?.value,
    headingTrueTimestamp: headingMeasurement?.timestamp || null,
    headingTrueEvidence: headingMeasurement,
    speedThroughWater: speedThroughWaterMeasurement?.value,
    speedThroughWaterTimestamp: speedThroughWaterMeasurement?.timestamp || null,
    speedThroughWaterEvidence: speedThroughWaterMeasurement,
    trackThroughWaterTrue: trackThroughWaterMeasurement?.value,
    trackThroughWaterTrueTimestamp: trackThroughWaterMeasurement?.timestamp || null,
    trackThroughWaterTrueEvidence: trackThroughWaterMeasurement,
    leeway: leewayMeasurement?.value,
    leewayTimestamp: leewayMeasurement?.timestamp || null,
    leewayEvidence: leewayMeasurement,
    leewayStatus: navigationReference?.throughWater?.leewayStatus === "known" ? "known" : "unknown",
    currentSetTrue: currentEvidence?.setTrue,
    currentDrift: currentEvidence?.drift,
    currentTimestamp: currentEvidence?.timestamp || null,
    currentEvidence,
    hdop,
    hdopTimestamp: referenceGnssTimestampMs
      ? new Date(referenceGnssTimestampMs).toISOString()
      : hdopTimestampMs
        ? new Date(hdopTimestampMs).toISOString()
        : null,
    methodQuality,
    methodQualityTimestamp: referenceGnssTimestampMs
      ? new Date(referenceGnssTimestampMs).toISOString()
      : methodQualityTimestampMs
        ? new Date(methodQualityTimestampMs).toISOString()
        : null,
    satellites,
    satellitesTimestamp: referenceGnssTimestampMs
      ? new Date(referenceGnssTimestampMs).toISOString()
      : satellitesTimestampMs
        ? new Date(satellitesTimestampMs).toISOString()
        : null,
    explicitGpsUnavailable,
    explicitGpsUnavailableTimestamp: Math.max(
      referenceGnssTimestampMs || methodQualityTimestampMs || 0,
      referenceGnssTimestampMs || satellitesTimestampMs || 0,
    )
      ? new Date(Math.max(
          referenceGnssTimestampMs || methodQualityTimestampMs || 0,
          referenceGnssTimestampMs || satellitesTimestampMs || 0,
        )).toISOString()
      : null,
    fixValid: position != null && !explicitGpsUnavailable,
    gnssProvenance: {
      coherent: providerAvailable
        ? referenceGnssCoherent
        : Boolean(
            isPosition(position) &&
              Number.isFinite(finiteNumber(speedOverGround)) &&
              Number.isFinite(finiteNumber(courseOverGroundTrue)),
          ),
      source: source || null,
      method: providerAvailable ? "navigation-reference" : "raw-source-coherent",
      position: providerAvailable
        ? referencePosition
        : entryEvidence(gnssEntries.position, source),
      speedOverGround: providerAvailable
        ? referenceSpeed
        : entryEvidence(gnssEntries.speedOverGround, source),
      courseOverGroundTrue: providerAvailable
        ? referenceCourse
        : entryEvidence(gnssEntries.courseOverGroundTrue, source),
      methodQuality: entryEvidence(methodQualityEntry, source),
      satellites: entryEvidence(satellitesEntry, source),
      hdop: entryEvidence(hdopEntry, source),
    },
    navigationReference: navigationReference
      ? {
          contract: navigationReference.contract,
          schemaVersion: navigationReference.schemaVersion,
          updatedAt: navigationReference.updatedAt || null,
          status: navigationReference.status || null,
          clockReference: clockReferenceMeasurement
            ? {
                ...clockReferenceMeasurement,
                kind: ["heading", "track-proxy"].includes(
                  navigationReference.clockReference?.kind,
                )
                  ? navigationReference.clockReference.kind
                  : null,
              }
            : null,
          magneticVariation: referenceMeasurement(
            navigationReference.magneticVariation,
          ),
          residual: navigationReference.residual || null,
        }
      : null,
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
  if (source) {
    return source === entry?.$source && Object.hasOwn(entry || {}, "value")
      ? entry.value
      : undefined;
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
  const timestamp = source
    ? entry?.values?.[source]?.timestamp ||
      (source === entry?.$source ? entry?.timestamp : null)
    : entry?.timestamp;
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function defaultEntrySource(entry) {
  return entry?.$source || Object.keys(entry?.values || {})[0] || "";
}

function validNavigationReference(value) {
  if (!value || typeof value !== "object") return null;
  if (value.contract !== "ajrm-marine-navigation-reference") return null;
  if (Number(value.schemaVersion) !== 1) return null;
  return value;
}

function referenceMeasurement(value) {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "value")) return null;
  return {
    value: value.value,
    source: stringOrNull(value.source),
    sourceKind: stringOrNull(value.sourceKind),
    timestamp: isoTimestamp(value.timestamp || value.originalTimestamp),
    originalTimestamp: isoTimestamp(value.originalTimestamp),
    ageMs: finiteOrNull(value.ageMs),
    method: stringOrNull(value.method),
    uncertaintyRad: finiteOrNull(value.uncertaintyRad),
    uncertaintyMeters: finiteOrNull(value.uncertaintyMeters),
    gpsDependent: typeof value.gpsDependent === "boolean" ? value.gpsDependent : null,
  };
}

function rawMeasurement(entry, source, method) {
  const value = readEntryValue(entry, source);
  if (!Number.isFinite(finiteNumber(value))) return null;
  const timestamp = sourceTimestamp(entry, source);
  return {
    value,
    source: source || entry?.$source || null,
    sourceKind: "raw-signalk",
    timestamp: timestamp ? new Date(timestamp).toISOString() : null,
    originalTimestamp: null,
    ageMs: null,
    method,
    uncertaintyRad: null,
    uncertaintyMeters: null,
    gpsDependent: null,
  };
}

function referenceCurrent(value) {
  if (!value || typeof value !== "object") return null;
  const setMeasurement = referenceMeasurement(value.setTrue);
  const driftMeasurement = referenceMeasurement(value.drift);
  const setTrue = finiteNumber(setMeasurement?.value ?? value.setTrue);
  const drift = finiteNumber(driftMeasurement?.value ?? value.drift);
  const source = stringOrNull(value.source || setMeasurement?.source || driftMeasurement?.source);
  const childSources = [setMeasurement?.source, driftMeasurement?.source].filter(Boolean);
  if (
    !Number.isFinite(setTrue) ||
    !Number.isFinite(drift) ||
    !source ||
    childSources.some((childSource) => childSource !== source)
  ) {
    return null;
  }
  return {
    setTrue,
    drift,
    source,
    sourceKind: stringOrNull(value.sourceKind),
    timestamp: isoTimestamp(
      value.timestamp || setMeasurement?.timestamp || driftMeasurement?.timestamp,
    ),
    ageSeconds: Number.isFinite(finiteNumber(value.ageMs))
      ? Math.max(0, finiteNumber(value.ageMs) / 1000)
      : null,
    origin: stringOrNull(value.origin),
    gpsDependent: typeof value.gpsDependent === "boolean" ? value.gpsDependent : null,
    quality: value.quality ?? null,
  };
}

function referenceIndependentCurrent(value) {
  const current = referenceCurrent(value);
  if (
    !current ||
    current.gpsDependent !== false ||
    !current.timestamp ||
    !current.origin ||
    !hasExplicitQuality(current.quality)
  ) {
    return null;
  }
  return current;
}

function referenceResidualCurrent(value) {
  const residual = referenceCurrent(value);
  if (
    !residual ||
    residual.origin !== "ground-minus-water-residual" ||
    residual.gpsDependent !== true ||
    !residual.timestamp ||
    !hasExplicitQuality(residual.quality)
  ) {
    return null;
  }
  return residual;
}

function hasExplicitQuality(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0,
  );
}

function firstEntryForSource(app, paths, source) {
  for (const path of paths) {
    const entry = getSelfEntry(app, path);
    if (!entry || typeof entry !== "object") continue;
    if (source) {
      if (hasSourceValue(entry, source)) return entry;
      continue;
    }
    if (Object.hasOwn(entry, "value")) return entry;
  }
  return undefined;
}

function entryEvidence(entry, source) {
  if (!entry) return null;
  const timestamp = sourceTimestamp(entry, source);
  return {
    source: source || entry?.$source || null,
    timestamp: timestamp ? new Date(timestamp).toISOString() : null,
  };
}

function timestampNumber(value) {
  const result = Date.parse(value || "");
  return Number.isFinite(result) ? result : 0;
}

function isoTimestamp(value) {
  const result = timestampNumber(value);
  return result ? new Date(result).toISOString() : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteOrNull(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? number : null;
}

function explicitNoGps(methodQuality, satellites) {
  const quality = String(methodQuality || "").trim().toLowerCase();
  if (quality && /no\s*(gps|gnss|fix)|invalid|unavailable|none|lost/.test(quality)) return true;
  const satelliteCount = Number(satellites);
  return Number.isFinite(satelliteCount) && satelliteCount <= 0;
}

function isPosition(value) {
  return Number.isFinite(Number(value?.latitude)) && Number.isFinite(Number(value?.longitude));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return NaN;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
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
    headingThroughWater: vector(
      sample.speedThroughWater,
      sample.trackThroughWaterTrue ?? sample.headingTrue,
      "single",
    ),
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
