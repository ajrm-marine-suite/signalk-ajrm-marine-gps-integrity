"use strict";

const packageInfo = require("../package.json");
const { evaluateNavigationIntegrity } = require("./lib/navigation-integrity");

const PLUGIN_ID = "signalk-ajrm-marine-gps-integrity";
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

  plugin.id = PLUGIN_ID;
  plugin.name = "AJRM Marine GPS Integrity";
  plugin.description =
    "Monitors GNSS trust, compares GPS with dead reckoning, and publishes navigation integrity state.";

  plugin.schema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", title: "Enable GPS integrity monitor", default: true },
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
        title: "Independent DR realign interval",
        default: 1800,
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
    if (options.enabled) {
      timer = setInterval(evaluateAndPublish, options.updateIntervalMs);
      evaluateAndPublish();
    }
    app.setPluginStatus?.(`${options.enabled ? "Started" : "Disabled"} v${packageInfo.version}`);
  };

  plugin.stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    latestState = null;
    lastNotificationSignature = null;
    activeNotificationKey = null;
    activeNotificationEventId = null;
    activeNotificationRevision = null;
    publishValue(STATE_PATH, null);
    publishValues(PROJECTION_PATHS.map((path) => ({ path, value: null })));
    publishValue(NOTIFICATION_PATH, null);
  };

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      res.json(statusResponse());
    });
  };

  return plugin;

  function evaluateAndPublish() {
    const sample = sampleFromSignalK(app);
    latestSample = sample;
    latestState = evaluateNavigationIntegrity(sample, latestState, {
      ...options,
      distanceDisplayUnit: preferredDistanceUnit(),
    });
    publishValues([
      { path: STATE_PATH, value: latestState },
      ...navigationProjectionValues(latestState),
    ]);
    publishNotification(notificationValue(latestState));
  }

  function statusResponse() {
    return {
      ok: true,
      plugin: PLUGIN_ID,
      version: packageInfo.version,
      enabled: options.enabled,
      statePath: `vessels.self.${STATE_PATH}`,
      notificationPath: `vessels.self.${NOTIFICATION_PATH}`,
      trustedPrefix: `vessels.self.${TRUSTED_PREFIX}`,
      deadReckoningPrefix: `vessels.self.${DEAD_RECKONING_PREFIX}`,
      countersPrefix: `vessels.self.${COUNTERS_PREFIX}`,
      sample: latestSample || sampleFromSignalK(app),
      state: latestState || evaluateNavigationIntegrity(sampleFromSignalK(app), null, {
        ...options,
        distanceDisplayUnit: preferredDistanceUnit(),
      }),
    };
  }

  function navigationProjectionValues(state) {
    const accepted = Boolean(state?.acceptedGps && state?.gps?.position);
    const trustedSource = accepted
      ? state.trust === "normal"
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
      { path: `${TRUSTED_PREFIX}.accepted`, value: accepted },
      { path: `${TRUSTED_PREFIX}.position`, value: accepted ? state.gps.position : null },
      { path: `${TRUSTED_PREFIX}.speedOverGround`, value: accepted ? state.gps.speedOverGround : null },
      { path: `${TRUSTED_PREFIX}.courseOverGroundTrue`, value: accepted ? state.gps.courseOverGroundTrue : null },
      { path: `${TRUSTED_PREFIX}.headingTrue`, value: accepted ? state.gps.headingTrue : null },
      { path: `${TRUSTED_PREFIX}.timestamp`, value: accepted ? state.lastTrustedFix?.timestamp || state.timestamp : null },
      { path: `${TRUSTED_PREFIX}.source`, value: trustedSource },
      { path: `${TRUSTED_PREFIX}.rejectionReason`, value: accepted ? null : state?.reasons?.join(" ") || null },
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
    const signature = JSON.stringify(value);
    if (signature === lastNotificationSignature) return;
    lastNotificationSignature = signature;
    publishValue(NOTIFICATION_PATH, value);
  }

  function publishValue(path, value) {
    publishValues([{ path, value }]);
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
    if (!isPosition(position)) continue;
    const sog = finiteNumber(readEntryValue(entries.speedOverGround, source));
    const stw = finiteNumber(readEntryValue(entries.speedThroughWater, source));
    const cog = finiteNumber(readEntryValue(entries.courseOverGroundTrue, source));
    const heading = finiteNumber(readEntryValue(entries.headingTrue, source));
    const timestamp = sourceTimestamp(entries.position, source);
    let score = timestamp / 1000000000000;
    if (Number.isFinite(sog) && sog > 0.05) score += 100;
    if (Number.isFinite(stw) && stw > 0.05) score += 80;
    if (Number.isFinite(cog)) score += 10;
    if (Number.isFinite(heading)) score += 8;
    if (source === entries.position?.$source) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = source;
    }
  }
  return best || entries.position?.$source || "";
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
    updateIntervalMs: Number.isFinite(interval) ? Math.min(10000, Math.max(500, interval)) : 1000,
    maxBoatSpeedKnots: value.maxBoatSpeedKnots,
    maxHdop: value.maxHdop,
    minSatellites: value.minSatellites,
    warningDrDiscrepancyMeters: value.warningDrDiscrepancyMeters,
    alarmDrDiscrepancyMeters: value.alarmDrDiscrepancyMeters,
    gpsLostSeconds: value.gpsLostSeconds,
    integrityDrRealignSeconds: value.integrityDrRealignSeconds,
    distanceDisplayUnit: value.distanceDisplayUnit,
  };
}

module.exports._private = {
  chooseNavigationSource,
  DISTANCE_METADATA_PATHS,
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
