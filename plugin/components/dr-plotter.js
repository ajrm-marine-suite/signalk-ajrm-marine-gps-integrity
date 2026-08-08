"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageInfo = require("../../package.json");
const openApi = require("./dr-plotter-openApi.json");

const PLUGIN_ID = "signalk-ajrm-marine-dr-plotter";
const AJRM_MARINE_GPS_INTEGRITY_STATE_PATH = "plugins.ajrmMarineGpsIntegrity.navigationIntegrity";
const NAVIGATION_REFERENCE_CONTRACT = "ajrm-marine-navigation-reference";
const NAVIGATION_REFERENCE_SCHEMA_VERSION = 1;
const DATA_DIRECTORY = path.join(os.homedir(), ".signalk", "plugin-config-data", PLUGIN_ID);
const PLOT_FIXES_FILE = path.join(DATA_DIRECTORY, "plot-fixes.json");
const OPERATIONAL_TRACK_FILE = path.join(DATA_DIRECTORY, "operational-track.json");
const SETTINGS_FILE = path.join(DATA_DIRECTORY, "settings.json");
const MAX_PLOT_FIXES = 1000;
const MAX_TRACK_POINTS = 7200;

let plotFixesQueue = Promise.resolve();

module.exports = function ajrmMarineDrPlotter(app, componentOptions = {}) {
  const plugin = {};
  let options = normalizeOptions({});
  let startedAt = null;
  let unsubscribes = [];
  let lastTrustState = null;
  let gpsOutageActive = false;
  let gpsLostPlotFixRecordedFor = null;
  let plotFixesUpdatedAt = null;
  let operationalTrackUpdatedAt = null;
  let timedPlotFixWritePending = false;
  let trackWritePending = false;
  let automaticFixQueue = createSerialQueue();
  let pendingOperations = new Set();
  let running = false;

  plugin.id = PLUGIN_ID;
  plugin.name = "AJRM Marine DR Plotter";
  plugin.description =
    "Own-vessel dead-reckoning chart plotter for GPS integrity, uncertainty, and navigation vectors.";

  plugin.schema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", title: "Enable DR Plotter web app", default: true },
      refreshIntervalMs: {
        type: "integer",
        title: "Plot refresh interval",
        default: 1000,
        minimum: 500,
        maximum: 10000,
      },
      defaultLatitude: {
        type: "number",
        title: "Fallback chart latitude",
        default: 56.21,
      },
      defaultLongitude: {
        type: "number",
        title: "Fallback chart longitude",
        default: -5.56,
      },
      defaultZoom: {
        type: "integer",
        title: "Fallback chart zoom",
        default: 11,
        minimum: 1,
        maximum: 18,
      },
      coordinateFormat: {
        type: "string",
        title: "Latitude/longitude display format",
        description: "Controls cursor and popup coordinate display. Internal storage remains decimal degrees.",
        default: "dms",
        enum: ["dms", "degrees-minutes", "decimal"],
        enumNames: ["Degrees minutes seconds", "Degrees decimal minutes", "Decimal degrees"],
      },
      plotFixIntervalMinutes: {
        type: "integer",
        title: "Automatic plot-fix interval",
        description:
          "Server-side interval for navigator plot fixes. The plugin records these even when no DR Plotter browser page is open.",
        default: 10,
        minimum: 0,
        maximum: 120,
      },
    },
  };

  plugin.start = (pluginOptions = {}) => {
    running = true;
    options = normalizeOptions(pluginOptions, loadSettingsSync());
    startedAt = new Date().toISOString();
    automaticFixQueue = createSerialQueue();
    pendingOperations = new Set();
    subscribe();
    if (options.enabled) {
      trackOperation(
        recordNavigationState(getSelfPath(app, AJRM_MARINE_GPS_INTEGRITY_STATE_PATH)),
        "startup navigation state record",
      );
    }
    publishStatusProjection();
    if (!componentOptions.embedded) {
      app.setPluginStatus?.(`${options.enabled ? "Started" : "Disabled"} v${packageInfo.version}`);
    }
  };

  plugin.stop = async () => {
    running = false;
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch (_error) {
        // Best effort unsubscribe during Signal K plugin shutdown.
      }
    }
    unsubscribes = [];
    await Promise.allSettled([...pendingOperations]);
    await plotFixesQueue.catch(() => {});
    pendingOperations.clear();
    startedAt = null;
    lastTrustState = null;
    gpsOutageActive = false;
    gpsLostPlotFixRecordedFor = null;
    automaticFixQueue = createSerialQueue();
    timedPlotFixWritePending = false;
    trackWritePending = false;
    publishStatusProjection(null);
  };

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      res.json(status());
    });

    router.put("/settings", requireWriteAccess(async (req, res) => {
      try {
        const next = {
          plotFixIntervalMinutes: normalizePlotFixIntervalMinutes(
            req.body?.plotFixIntervalMinutes ?? options.plotFixIntervalMinutes,
          ),
        };
        options = { ...options, ...next };
        await saveSettings(next);
        publishStatusProjection();
        res.json({ ok: true, settings: publicSettings() });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] settings save failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.get("/plot-fixes", async (_req, res) => {
      try {
        res.json({ ok: true, plotFixes: await loadPlotFixes() });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] plot-fix load failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get("/track", async (_req, res) => {
      try {
        res.json({ ok: true, points: await loadOperationalTrack() });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] operational track load failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.put("/track", requireWriteAccess(async (req, res) => {
      try {
        const points = normalizeTrackPoints(req.body?.points || req.body?.track || []);
        await saveOperationalTrack(points);
        operationalTrackUpdatedAt = new Date().toISOString();
        res.json({ ok: true, points });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] operational track save failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.delete("/track", requireWriteAccess(async (_req, res) => {
      try {
        await saveOperationalTrack([]);
        operationalTrackUpdatedAt = new Date().toISOString();
        res.json({ ok: true, points: [] });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] operational track clear failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.get("/fixes", async (_req, res) => {
      try {
        const plotFixes = await loadPlotFixes();
        res.json({
          ok: true,
          resourceType: "fixes",
          fixes: plotFixes.map(plotFixToResource),
        });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] fix resource load failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.put("/plot-fixes", requireWriteAccess(async (req, res) => {
      try {
        const plotFixes = normalizePlotFixes(req.body?.plotFixes || req.body?.fixes || []);
        await savePlotFixes(plotFixes);
        plotFixesUpdatedAt = new Date().toISOString();
        res.json({ ok: true, plotFixes });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] plot-fix save failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.post("/plot-fixes", requireWriteAccess(async (req, res) => {
      try {
        const plotFix = normalizePlotFix(req.body?.plotFix || req.body);
        if (!plotFix) {
          res.status(400).json({ ok: false, error: "Invalid plot fix." });
          return;
        }
        const { plotFixes } = await appendPlotFixToStore(plotFix);
        res.json({ ok: true, plotFix, plotFixes });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] plot-fix append failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.delete("/plot-fixes", requireWriteAccess(async (_req, res) => {
      try {
        await savePlotFixes([]);
        plotFixesUpdatedAt = new Date().toISOString();
        res.json({ ok: true, plotFixes: [] });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] plot-fix clear failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.get("/charts", async (_req, res) => {
      try {
        if (!app.resourcesApi?.listResources) {
          throw new Error("Signal K resources API is not available.");
        }
        const charts = await app.resourcesApi.listResources("charts", {});
        res.json({ ok: true, charts: charts || {} });
      } catch (error) {
        app.error?.(`[${PLUGIN_ID}] chart resource list failed: ${error.stack || error.message}`);
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  };
  plugin.getOpenApi = () => openApi;

  return plugin;

  function requireWriteAccess(handler) {
    return function writeAccessHandler(req, res) {
      const permission = req.skPrincipal?.permissions;
      if (
        permission === "admin" ||
        permission === "readwrite" ||
        (permission === undefined && req.skIsAuthenticated !== false)
      ) {
        return handler(req, res);
      }
      res.status(403).json({
        ok: false,
        error: "DR Plotter controls require Signal K read/write or admin access.",
      });
      return undefined;
    };
  }

  function trackOperation(operation, label) {
    const tracked = Promise.resolve(operation)
      .catch((error) => {
        app.error?.(`[${PLUGIN_ID}] ${label} failed: ${error.stack || error.message}`);
      })
      .finally(() => pendingOperations.delete(tracked));
    pendingOperations.add(tracked);
    return tracked;
  }

  function status() {
    const integrity = getSelfPath(app, AJRM_MARINE_GPS_INTEGRITY_STATE_PATH) || null;
    return {
      ok: true,
      plugin: PLUGIN_ID,
      version: packageInfo.version,
      running,
      enabled: options.enabled,
      refreshIntervalMs: options.refreshIntervalMs,
      coordinateFormat: options.coordinateFormat,
      plotFixIntervalMinutes: options.plotFixIntervalMinutes,
      startedAt,
      noAisTargets: true,
      dataDirectory: DATA_DIRECTORY,
      plotFixPersistence: {
        serverSide: true,
        persisted: true,
        storage: "server",
        file: PLOT_FIXES_FILE,
        maxCount: MAX_PLOT_FIXES,
        plotFixIntervalMinutes: options.plotFixIntervalMinutes,
        retentionPolicy: "Newest records are retained server-side; manual pruning is available from the web app.",
        updatedAt: plotFixesUpdatedAt,
      },
      trackPersistence: {
        serverSide: true,
        persisted: true,
        storage: "server",
        file: OPERATIONAL_TRACK_FILE,
        maxCount: MAX_TRACK_POINTS,
        retentionPolicy: "Newest operational breadcrumb points are retained server-side.",
        updatedAt: operationalTrackUpdatedAt,
      },
      defaults: {
        latitude: options.defaultLatitude,
        longitude: options.defaultLongitude,
        zoom: options.defaultZoom,
      },
      plotFixesUpdatedAt,
      operationalTrackUpdatedAt,
      ajrmMarineGpsIntegrity: integrity,
      ajrmMarineGpsIntegrityStatePath: `vessels.self.${AJRM_MARINE_GPS_INTEGRITY_STATE_PATH}`,
    };
  }

  function publicSettings() {
    return {
      plotFixIntervalMinutes: options.plotFixIntervalMinutes,
    };
  }

  function publishStatusProjection(value = status()) {
    if (typeof app.handleMessage !== "function") return;
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "plugins.ajrmMarineDrPlotter",
              value,
            },
          ],
        },
      ],
    });
  }

  function subscribe() {
    if (!options.enabled || !app.subscriptionmanager?.subscribe) return;
    app.subscriptionmanager.subscribe(
      {
        context: "vessels.self",
        subscribe: [
          {
            path: AJRM_MARINE_GPS_INTEGRITY_STATE_PATH,
            policy: "instant",
            format: "delta",
          },
        ],
      },
      unsubscribes,
      (error) => app.error?.(`[${PLUGIN_ID}] subscription error: ${error}`),
      handleDelta,
    );
  }

  function handleDelta(delta) {
    for (const update of delta?.updates || []) {
      for (const value of update?.values || []) {
        if (value?.path === AJRM_MARINE_GPS_INTEGRITY_STATE_PATH) {
          trackOperation(recordNavigationState(value.value), "navigation state record");
        }
      }
    }
  }

  async function recordNavigationState(state) {
    if (!running || !options.enabled) return;
    await appendOperationalTrackSample(state);
    await recordAutomaticFixes(state);
  }

  async function appendOperationalTrackSample(state) {
    if (trackWritePending) return;
    const point = trackPointFromIntegrityState(state);
    if (!point) return;
    trackWritePending = true;
    try {
      const existing = await loadOperationalTrack();
      const last = existing[existing.length - 1];
      if (last && (last.timestamp === point.timestamp || distanceMeters(last, point) < 2)) return;
      const points = normalizeTrackPoints([...existing, point]);
      await saveOperationalTrack(points);
      operationalTrackUpdatedAt = new Date().toISOString();
    } finally {
      trackWritePending = false;
    }
  }

  function recordAutomaticFixes(state) {
    return automaticFixQueue.run(() => recordAutomaticFixesLocked(state));
  }

  async function recordAutomaticFixesLocked(state) {
    const memory = { lastTrustState, gpsOutageActive, gpsLostPlotFixRecordedFor };
    const decision = automaticFixDecision(memory, state);
    if (decision.plotType) {
      const recorded = await appendPlotFix(createPlotFixFromIntegrityState(state, true, decision.plotType));
      if (recorded) {
        applyAutomaticFixMemory(decision.next);
      }
    } else {
      applyAutomaticFixMemory(decision.next);
    }

    if ((state?.trust || "unknown") !== "lost") {
      await appendTimedPlotFixIfDue(state);
    }
  }

  function applyAutomaticFixMemory(memory) {
    lastTrustState = memory.lastTrustState;
    gpsOutageActive = memory.gpsOutageActive;
    gpsLostPlotFixRecordedFor = memory.gpsLostPlotFixRecordedFor;
  }

  async function appendTimedPlotFixIfDue(state) {
    if (timedPlotFixWritePending) return;
    const intervalMinutes = normalizePlotFixIntervalMinutes(options.plotFixIntervalMinutes);
    if (!intervalMinutes) return;
    if (state?.acceptedGps === false) return;
    const timestampMs = Date.parse(state?.timestamp);
    if (!Number.isFinite(timestampMs)) return;
    timedPlotFixWritePending = true;
    try {
      await appendTimedPlotFixLocked(state, timestampMs, intervalMinutes);
    } finally {
      timedPlotFixWritePending = false;
    }
  }

  async function appendPlotFix(plotFix) {
    const normalized = normalizePlotFix(plotFix);
    if (!normalized) return null;
    const result = await appendPlotFixToStore(normalized);
    return result.plotFix;
  }

  async function appendTimedPlotFixLocked(state, timestampMs, intervalMinutes) {
    return withPlotFixesLock(async () => {
      const existing = await loadPlotFixesUnlocked();
      const lastFix = existing[existing.length - 1];
      const lastMs = Date.parse(lastFix?.timestamp);
      if (Number.isFinite(lastMs) && timestampMs - lastMs < intervalMinutes * 60 * 1000) return null;
      const normalized = normalizePlotFix(createPlotFixFromIntegrityState(state, true, "timed"));
      if (!normalized) return null;
      const plotFixes = normalizePlotFixes([...existing, normalized]);
      await savePlotFixesUnlocked(plotFixes);
      plotFixesUpdatedAt = new Date().toISOString();
      return normalized;
    });
  }

  async function appendPlotFixToStore(plotFix) {
    return withPlotFixesLock(async () => {
      const existing = await loadPlotFixesUnlocked();
      const plotFixes = normalizePlotFixes([...existing, plotFix]);
      await savePlotFixesUnlocked(plotFixes);
      plotFixesUpdatedAt = new Date().toISOString();
      return { plotFix, plotFixes };
    });
  }
};

function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    run(operation) {
      const run = tail.catch(() => {}).then(operation);
      tail = run.catch(() => {});
      return run;
    },
  };
}

function loadSettingsSync() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (_error) {
    return {};
  }
}

async function saveSettings(settings) {
  await fs.promises.mkdir(DATA_DIRECTORY, { recursive: true });
  await writeJsonFileAtomic(SETTINGS_FILE, settings);
}

async function loadPlotFixes() {
  await plotFixesQueue.catch(() => {});
  return loadPlotFixesUnlocked();
}

async function loadPlotFixesUnlocked() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(PLOT_FIXES_FILE, "utf8"));
    return normalizePlotFixes(parsed?.plotFixes || parsed?.fixes || []);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function savePlotFixes(plotFixes) {
  const normalized = normalizePlotFixes(plotFixes);
  return withPlotFixesLock(async () => {
    await savePlotFixesUnlocked(normalized);
  });
}

async function savePlotFixesUnlocked(plotFixes) {
  const normalized = normalizePlotFixes(plotFixes);
  await fs.promises.mkdir(DATA_DIRECTORY, { recursive: true });
  await writeJsonFileAtomic(PLOT_FIXES_FILE, { schemaVersion: 1, plotFixes: normalized });
}

function withPlotFixesLock(operation) {
  const run = plotFixesQueue.catch(() => {}).then(operation);
  plotFixesQueue = run.catch(() => {});
  return run;
}

async function loadOperationalTrack() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(OPERATIONAL_TRACK_FILE, "utf8"));
    return normalizeTrackPoints(parsed?.points || parsed?.track || []);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function saveOperationalTrack(points) {
  const normalized = normalizeTrackPoints(points);
  await fs.promises.mkdir(DATA_DIRECTORY, { recursive: true });
  await writeJsonFileAtomic(OPERATIONAL_TRACK_FILE, { schemaVersion: 1, points: normalized });
}

async function writeJsonFileAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EPERM", "EEXIST"].includes(error.code)) {
      throw error;
    }
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rename(temporaryPath, filePath);
  }
}

function trackPointFromIntegrityState(state) {
  const position = ownshipFollowPosition(state);
  if (!position) return null;
  const operationalDr = state?.operationalDeadReckoning || state?.deadReckoning || {};
  const reference = navigationReferenceSummary(state);
  return normalizeTrackPoint({
    ...position,
    timestamp: state?.timestamp || new Date().toISOString(),
    trust: state?.trust || null,
    source: operationalDr.source || null,
    uncertaintyRadiusMeters: operationalDr.uncertaintyRadiusMeters ?? null,
    gpsDependent: operationalDr.gpsDependent,
    leewayStatus: operationalDr.leewayStatus || null,
    currentOrigin: operationalDr.currentOrigin || null,
    referenceKind: reference.kind,
    referenceSource: reference.source,
    referenceAgeSeconds: reference.ageSeconds,
    referenceUncertaintyDegrees: reference.uncertaintyDegrees,
    referenceGpsDependent: reference.gpsDependent,
  });
}

function normalizeTrackPoints(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeTrackPoint)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-MAX_TRACK_POINTS);
}

function normalizeTrackPoint(value) {
  const latitude = Number(value?.latitude);
  const longitude = Number(value?.longitude);
  const timestamp = normalizeTimestamp(value?.timestamp);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !timestamp) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude,
    longitude,
    timestamp,
    trust: typeof value.trust === "string" && value.trust.trim() ? value.trust.trim().slice(0, 40) : null,
    source: typeof value.source === "string" && value.source.trim() ? value.source.trim().slice(0, 80) : null,
    uncertaintyRadiusMeters: finiteOrNull(value.uncertaintyRadiusMeters),
    gpsDependent: booleanOrNull(value.gpsDependent),
    leewayStatus: stringOrNull(value.leewayStatus),
    currentOrigin: stringOrNull(value.currentOrigin),
    referenceKind: stringOrNull(value.referenceKind),
    referenceSource: stringOrNull(value.referenceSource),
    referenceAgeSeconds: finiteOrNull(value.referenceAgeSeconds),
    referenceUncertaintyDegrees: finiteOrNull(value.referenceUncertaintyDegrees),
    referenceGpsDependent: booleanOrNull(value.referenceGpsDependent),
  };
}

function createPlotFixFromIntegrityState(state, automatic, plotType = automatic ? "timed" : "manual") {
  const operationalDr = state?.operationalDeadReckoning || state?.deadReckoning || {};
  const integrityDr = state?.integrityDeadReckoning || {};
  const reference = navigationReferenceSummary(state);
  const position = plotType === "gps-return"
    ? normalizePosition(state?.gps?.position)
    : ownshipFollowPosition(state);
  if (!position) return null;
  const lastTrustedPosition = normalizePosition(state?.lastTrustedFix?.position);
  const timestamp = normalizeTimestamp(state?.timestamp || new Date().toISOString());
  const timestampMs = Date.parse(timestamp);
  const lastTrustedMs = Date.parse(state?.lastTrustedFix?.timestamp);
  return {
    id: `fix-${timestamp}-${plotType}`,
    timestamp,
    automatic,
    plotType,
    position,
    trust: state?.trust || null,
    drSource: operationalDr.source || null,
    uncertaintyRadiusMeters: operationalDr.uncertaintyRadiusMeters ?? null,
    drGpsDependent: operationalDr.gpsDependent,
    drLeewayStatus: operationalDr.leewayStatus || null,
    drCurrentOrigin: operationalDr.currentOrigin || null,
    drHeadingSource: provenanceSource(operationalDr.provenance?.heading),
    drTrackThroughWaterSource: provenanceSource(operationalDr.provenance?.trackThroughWater),
    drSpeedThroughWaterSource: provenanceSource(operationalDr.provenance?.speedThroughWater),
    drCurrentSource: provenanceSource(operationalDr.provenance?.current),
    drLeewaySource: provenanceSource(operationalDr.provenance?.leeway),
    integritySource: integrityDr.source || null,
    integrityAssurance: integrityDr.assurance || state?.integrityAssurance?.status || null,
    integrityComparisonAvailable:
      integrityDr.comparisonAvailable ?? state?.integrityAssurance?.comparisonAvailable,
    integrityUnavailableReason:
      integrityDr.unavailableReason || state?.integrityAssurance?.reason || null,
    integrityAgeSeconds: integrityDr.ageSeconds ?? null,
    integrityUncertaintyRadiusMeters: integrityDr.uncertaintyRadiusMeters ?? null,
    integrityGpsDependent: integrityDr.gpsDependent,
    integrityLeewayStatus: integrityDr.leewayStatus || state?.integrityAssurance?.leewayStatus || null,
    integrityCurrentOrigin: integrityDr.currentOrigin || null,
    integrityHeadingSource: provenanceSource(integrityDr.provenance?.heading),
    integrityTrackThroughWaterSource: provenanceSource(integrityDr.provenance?.trackThroughWater),
    integritySpeedThroughWaterSource: provenanceSource(integrityDr.provenance?.speedThroughWater),
    integrityCurrentSource: provenanceSource(integrityDr.provenance?.current),
    integrityLeewaySource: provenanceSource(integrityDr.provenance?.leeway),
    referenceKind: reference.kind,
    referenceSource: reference.source,
    referenceMethod: reference.method,
    referenceAgeSeconds: reference.ageSeconds,
    referenceUncertaintyDegrees: reference.uncertaintyDegrees,
    referenceGpsDependent: reference.gpsDependent,
    lastTrustedFixAgeSeconds: Number.isFinite(lastTrustedMs) && Number.isFinite(timestampMs)
      ? Math.max(0, (timestampMs - lastTrustedMs) / 1000)
      : operationalDr.ageSeconds ?? null,
    distanceFromLastTrustedFixMeters: lastTrustedPosition ? distanceMeters(lastTrustedPosition, position) : null,
    stwMps: state?.vectors?.headingThroughWater?.speedMps ?? null,
    headingTrueDegrees: state?.vectors?.headingThroughWater?.bearingTrueDegrees ?? null,
    sogMps: state?.vectors?.courseOverGround?.speedMps ?? state?.gps?.speedOverGround ?? null,
    cogTrueDegrees: state?.vectors?.courseOverGround?.bearingTrueDegrees ?? radiansToDegrees(state?.gps?.courseOverGroundTrue),
    currentDriftMps: state?.vectors?.tide?.speedMps ?? null,
    currentSetTrueDegrees: state?.vectors?.tide?.bearingTrueDegrees ?? null,
  };
}

function recoveredGpsPositionAvailable(state) {
  return state?.acceptedGps !== false && Boolean(normalizePosition(state?.gps?.position));
}

function automaticFixDecision(memory, state) {
  const current = {
    lastTrustState: memory?.lastTrustState || null,
    gpsOutageActive: memory?.gpsOutageActive === true,
    gpsLostPlotFixRecordedFor: memory?.gpsLostPlotFixRecordedFor || null,
  };
  const trust = state?.trust || "unknown";
  if (trust === "lost") {
    const lostKey = state?.lastTrustedFix?.timestamp || state?.timestamp || "lost";
    const plotType = !current.gpsOutageActive && current.gpsLostPlotFixRecordedFor !== lostKey ? "gps-lost" : null;
    return {
      plotType,
      next: {
        lastTrustState: trust,
        gpsOutageActive: true,
        gpsLostPlotFixRecordedFor: plotType ? lostKey : current.gpsLostPlotFixRecordedFor,
      },
    };
  }
  const plotType = current.gpsOutageActive && recoveredGpsPositionAvailable(state) ? "gps-return" : null;
  return {
    plotType,
    next: {
      lastTrustState: trust,
      gpsOutageActive: plotType ? false : current.gpsOutageActive,
      gpsLostPlotFixRecordedFor: plotType ? null : current.gpsLostPlotFixRecordedFor,
    },
  };
}

function ownshipFollowPosition(state) {
  return (
    normalizePosition(state?.operationalDeadReckoning?.position) ||
    normalizePosition(state?.deadReckoning?.position) ||
    normalizePosition(state?.gps?.position) ||
    null
  );
}

function normalizePlotFixes(value) {
  const fixes = (Array.isArray(value) ? value : [])
    .map(normalizePlotFix)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const byId = new Map();
  for (const fix of fixes) byId.set(fix.id, fix);
  return [...byId.values()].slice(-MAX_PLOT_FIXES);
}

function normalizePlotFix(value) {
  const position = normalizePosition(value?.position);
  const timestamp = normalizeTimestamp(value?.timestamp);
  if (!position || !timestamp) return null;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 80) : `plot-${timestamp}`,
    timestamp,
    automatic: value.automatic === true,
    position,
    trust: stringOrNull(value.trust),
    drSource: stringOrNull(value.drSource),
    uncertaintyRadiusMeters: finiteOrNull(value.uncertaintyRadiusMeters),
    drGpsDependent: booleanOrNull(value.drGpsDependent),
    drLeewayStatus: stringOrNull(value.drLeewayStatus),
    drCurrentOrigin: stringOrNull(value.drCurrentOrigin),
    drHeadingSource: stringOrNull(value.drHeadingSource),
    drTrackThroughWaterSource: stringOrNull(value.drTrackThroughWaterSource),
    drSpeedThroughWaterSource: stringOrNull(value.drSpeedThroughWaterSource),
    drCurrentSource: stringOrNull(value.drCurrentSource),
    drLeewaySource: stringOrNull(value.drLeewaySource),
    integritySource: stringOrNull(value.integritySource),
    integrityAssurance: stringOrNull(value.integrityAssurance),
    integrityComparisonAvailable: booleanOrNull(value.integrityComparisonAvailable),
    integrityUnavailableReason: longStringOrNull(value.integrityUnavailableReason),
    integrityAgeSeconds: finiteOrNull(value.integrityAgeSeconds),
    integrityUncertaintyRadiusMeters: finiteOrNull(value.integrityUncertaintyRadiusMeters),
    integrityGpsDependent: booleanOrNull(value.integrityGpsDependent),
    integrityLeewayStatus: stringOrNull(value.integrityLeewayStatus),
    integrityCurrentOrigin: stringOrNull(value.integrityCurrentOrigin),
    integrityHeadingSource: stringOrNull(value.integrityHeadingSource),
    integrityTrackThroughWaterSource: stringOrNull(value.integrityTrackThroughWaterSource),
    integritySpeedThroughWaterSource: stringOrNull(value.integritySpeedThroughWaterSource),
    integrityCurrentSource: stringOrNull(value.integrityCurrentSource),
    integrityLeewaySource: stringOrNull(value.integrityLeewaySource),
    referenceKind: stringOrNull(value.referenceKind),
    referenceSource: stringOrNull(value.referenceSource),
    referenceMethod: stringOrNull(value.referenceMethod),
    referenceAgeSeconds: finiteOrNull(value.referenceAgeSeconds),
    referenceUncertaintyDegrees: finiteOrNull(value.referenceUncertaintyDegrees),
    referenceGpsDependent: booleanOrNull(value.referenceGpsDependent),
    plotType: normalizePlotType(value.plotType),
    note: stringOrNull(value.note),
    lastTrustedFixAgeSeconds: finiteOrNull(value.lastTrustedFixAgeSeconds),
    distanceFromLastTrustedFixMeters: finiteOrNull(value.distanceFromLastTrustedFixMeters),
    stwMps: finiteOrNull(value.stwMps),
    headingTrueDegrees: finiteOrNull(value.headingTrueDegrees),
    sogMps: finiteOrNull(value.sogMps),
    cogTrueDegrees: finiteOrNull(value.cogTrueDegrees),
    currentDriftMps: finiteOrNull(value.currentDriftMps),
    currentSetTrueDegrees: finiteOrNull(value.currentSetTrueDegrees),
    resource: normalizeFixResource(value),
  };
}

function normalizeFixResource(value) {
  const position = normalizePosition(value?.position);
  const timestamp = normalizeTimestamp(value?.timestamp);
  if (!position || !timestamp) return null;
  const plotType = normalizePlotType(value.plotType);
  const properties = {
    timestamp,
    method: fixMethod(plotType, value?.trust),
    symbol: fixSymbol(plotType, value?.trust),
    type: plotType || "manual",
    source: PLUGIN_ID,
    trust: stringOrNull(value?.trust),
    note: stringOrNull(value?.note),
    drSource: stringOrNull(value?.drSource),
    uncertaintyRadiusMeters: finiteOrNull(value?.uncertaintyRadiusMeters),
    drGpsDependent: booleanOrNull(value?.drGpsDependent),
    drLeewayStatus: stringOrNull(value?.drLeewayStatus),
    drCurrentOrigin: stringOrNull(value?.drCurrentOrigin),
    drHeadingSource: stringOrNull(value?.drHeadingSource),
    drTrackThroughWaterSource: stringOrNull(value?.drTrackThroughWaterSource),
    drSpeedThroughWaterSource: stringOrNull(value?.drSpeedThroughWaterSource),
    drCurrentSource: stringOrNull(value?.drCurrentSource),
    drLeewaySource: stringOrNull(value?.drLeewaySource),
    integritySource: stringOrNull(value?.integritySource),
    integrityAssurance: stringOrNull(value?.integrityAssurance),
    integrityComparisonAvailable: booleanOrNull(value?.integrityComparisonAvailable),
    integrityUnavailableReason: longStringOrNull(value?.integrityUnavailableReason),
    integrityAgeSeconds: finiteOrNull(value?.integrityAgeSeconds),
    integrityUncertaintyRadiusMeters: finiteOrNull(value?.integrityUncertaintyRadiusMeters),
    integrityGpsDependent: booleanOrNull(value?.integrityGpsDependent),
    integrityLeewayStatus: stringOrNull(value?.integrityLeewayStatus),
    integrityCurrentOrigin: stringOrNull(value?.integrityCurrentOrigin),
    integrityHeadingSource: stringOrNull(value?.integrityHeadingSource),
    integrityTrackThroughWaterSource: stringOrNull(value?.integrityTrackThroughWaterSource),
    integritySpeedThroughWaterSource: stringOrNull(value?.integritySpeedThroughWaterSource),
    integrityCurrentSource: stringOrNull(value?.integrityCurrentSource),
    integrityLeewaySource: stringOrNull(value?.integrityLeewaySource),
    referenceKind: stringOrNull(value?.referenceKind),
    referenceSource: stringOrNull(value?.referenceSource),
    referenceMethod: stringOrNull(value?.referenceMethod),
    referenceAgeSeconds: finiteOrNull(value?.referenceAgeSeconds),
    referenceUncertaintyDegrees: finiteOrNull(value?.referenceUncertaintyDegrees),
    referenceGpsDependent: booleanOrNull(value?.referenceGpsDependent),
    lastTrustedFixAgeSeconds: finiteOrNull(value?.lastTrustedFixAgeSeconds),
    distanceFromLastTrustedFixMeters: finiteOrNull(value?.distanceFromLastTrustedFixMeters),
    stwMps: finiteOrNull(value?.stwMps),
    headingTrueDegrees: finiteOrNull(value?.headingTrueDegrees),
    sogMps: finiteOrNull(value?.sogMps),
    cogTrueDegrees: finiteOrNull(value?.cogTrueDegrees),
    currentDriftMps: finiteOrNull(value?.currentDriftMps),
    currentSetTrueDegrees: finiteOrNull(value?.currentSetTrueDegrees),
  };
  return {
    resourceType: "fixes",
    feature: {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [position.longitude, position.latitude],
      },
      properties,
    },
  };
}

function plotFixToResource(plotFix) {
  const normalized = normalizePlotFix(plotFix);
  if (!normalized?.resource) return null;
  return {
    id: normalized.id,
    name: `${fixTitle(normalized.plotType, normalized.trust)} ${normalized.timestamp.slice(11, 16)}`,
    description: normalized.note || fixTitle(normalized.plotType, normalized.trust),
    ...normalized.resource,
  };
}

function fixTitle(plotType, trust) {
  if (plotType === "observed-fix") return "Observed fix";
  if (plotType === "gps-lost" || trust === "lost") return "Estimated position";
  if (plotType === "gps-return") return "GPS fix";
  if (plotType === "timed") return "Timed electronic fix";
  return "Dead reckoning fix";
}

function fixMethod(plotType, trust) {
  if (plotType === "observed-fix") return "observed";
  if (plotType === "gps-lost" || trust === "lost") return "estimated";
  if (plotType === "gps-return" || plotType === "timed") return "electronic";
  return "dead-reckoning";
}

function fixSymbol(plotType, trust) {
  if (plotType === "observed-fix") return "circle-dot";
  if (plotType === "gps-lost" || trust === "lost") return "triangle-dot";
  if (plotType === "gps-return" || plotType === "timed") return "square-dot";
  return "half-circle-dot";
}

function normalizePlotType(value) {
  return ["manual", "timed", "gps-lost", "gps-return", "observed-fix"].includes(value) ? value : null;
}

function normalizePosition(value) {
  const latitude = finiteOrNull(value?.latitude);
  const longitude = finiteOrNull(value?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function normalizeTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function longStringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function navigationReferenceSummary(state) {
  const navigationReference = state?.navigationProvenance?.navigationReference;
  const contractAccepted =
    navigationReference?.contract === NAVIGATION_REFERENCE_CONTRACT &&
    navigationReference?.schemaVersion === NAVIGATION_REFERENCE_SCHEMA_VERSION;
  const reference = contractAccepted ? navigationReference.clockReference : null;
  return {
    kind: stringOrNull(reference?.kind),
    source: stringOrNull(reference?.source),
    method: stringOrNull(reference?.method),
    ageSeconds: millisecondsToSeconds(reference?.ageMs),
    uncertaintyDegrees: radiansMagnitudeToDegrees(reference?.uncertaintyRad),
    gpsDependent: booleanOrNull(reference?.gpsDependent),
  };
}

function provenanceSource(value) {
  return stringOrNull(value?.source);
}

function millisecondsToSeconds(value) {
  const milliseconds = finiteOrNull(value);
  return milliseconds === null ? null : Math.max(0, milliseconds / 1000);
}

function radiansMagnitudeToDegrees(value) {
  const radians = finiteOrNull(value);
  return radians === null ? null : Math.abs(radians * 180 / Math.PI);
}

function getSelfPath(app, path) {
  try {
    return unwrapSignalKValue(app.getSelfPath?.(path));
  } catch (_error) {
    return undefined;
  }
}

function unwrapSignalKValue(entry) {
  if (entry && typeof entry === "object" && Object.hasOwn(entry, "value")) return entry.value;
  return entry;
}

function normalizeOptions(value = {}, persisted = {}) {
  const refreshIntervalMs = Number.parseInt(value.refreshIntervalMs, 10);
  const defaultZoom = Number.parseInt(value.defaultZoom, 10);
  return {
    enabled: value.enabled !== false,
    refreshIntervalMs: Number.isFinite(refreshIntervalMs)
      ? Math.min(10000, Math.max(500, refreshIntervalMs))
      : 1000,
    defaultLatitude: finite(value.defaultLatitude, 56.21),
    defaultLongitude: finite(value.defaultLongitude, -5.56),
    defaultZoom: Number.isFinite(defaultZoom) ? Math.min(18, Math.max(1, defaultZoom)) : 11,
    coordinateFormat: normalizeCoordinateFormat(value.coordinateFormat),
    plotFixIntervalMinutes: normalizePlotFixIntervalMinutes(
      persisted.plotFixIntervalMinutes ?? value.plotFixIntervalMinutes,
    ),
  };
}

function normalizePlotFixIntervalMinutes(value) {
  const interval = Number.parseInt(value, 10);
  return Number.isFinite(interval) ? Math.min(120, Math.max(0, interval)) : 10;
}

function normalizeCoordinateFormat(value) {
  return ["dms", "degrees-minutes", "decimal"].includes(value) ? value : "dms";
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function radiansToDegrees(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? ((number * 180 / Math.PI) + 360) % 360 : null;
}

function distanceMeters(left, right) {
  const from = normalizePosition(left);
  const to = normalizePosition(right);
  if (!from || !to) return null;
  const radius = 6371000;
  const phi1 = from.latitude * Math.PI / 180;
  const phi2 = to.latitude * Math.PI / 180;
  const deltaPhi = (to.latitude - from.latitude) * Math.PI / 180;
  const deltaLambda = (to.longitude - from.longitude) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports._private = {
  createPlotFixFromIntegrityState,
  normalizePlotFix,
  normalizePlotFixes,
  normalizeTrackPoint,
  normalizeTrackPoints,
  automaticFixDecision,
  recoveredGpsPositionAvailable,
  createSerialQueue,
  trackPointFromIntegrityState,
  normalizeOptions,
  normalizePlotFixIntervalMinutes,
  plotFixToResource,
  navigationReferenceSummary,
  unwrapSignalKValue,
  writeJsonFileAtomic,
};
