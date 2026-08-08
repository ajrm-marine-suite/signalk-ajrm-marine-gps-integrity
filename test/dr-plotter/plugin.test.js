"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const pluginFactory = require("../../plugin/components/dr-plotter");
const packageInfo = require("../../package.json");

test("DR Plotter is bundled into GPS Integrity", () => {
  assert.deepEqual(packageInfo.signalk.recommends, []);
  assert.equal(packageInfo.name, "signalk-ajrm-marine-gps-integrity");
});

test("normalizes configured defaults", () => {
  const options = pluginFactory._private.normalizeOptions({
    refreshIntervalMs: 50,
    defaultLatitude: "57.1",
    defaultLongitude: "-6.2",
    defaultZoom: 99,
    coordinateFormat: "decimal",
    plotFixIntervalMinutes: "999",
  });
  assert.equal(options.refreshIntervalMs, 500);
  assert.equal(options.defaultLatitude, 57.1);
  assert.equal(options.defaultLongitude, -6.2);
  assert.equal(options.defaultZoom, 18);
  assert.equal(options.coordinateFormat, "decimal");
  assert.equal(options.plotFixIntervalMinutes, 120);
  assert.equal(pluginFactory._private.normalizeOptions({ coordinateFormat: "bad" }).coordinateFormat, "dms");
  assert.equal(pluginFactory._private.normalizeOptions({}, { plotFixIntervalMinutes: 5 }).plotFixIntervalMinutes, 5);
});

test("status declares that AIS targets are intentionally absent", async () => {
  const messages = [];
  const app = {
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
    getSelfPath(path) {
      if (path === "plugins.ajrmMarineGpsIntegrity.navigationIntegrity") return { value: { trust: "normal" } };
      return null;
    },
  };
  const plugin = pluginFactory(app);
  plugin.start({});
  let json = null;
  plugin.registerWithRouter({
    get(path, handler) {
      if (path === "/status") handler({}, { json(value) { json = value; } });
    },
    put() {},
    post() {},
    delete() {},
  });
  assert.equal(json.noAisTargets, true);
  assert.equal(json.running, true);
  assert.equal(json.coordinateFormat, "dms");
  assert.equal(Number.isFinite(json.plotFixIntervalMinutes), true);
  assert.equal(json.plotFixPersistence.serverSide, true);
  assert.equal(json.plotFixPersistence.storage, "server");
  assert.equal(json.plotFixPersistence.maxCount, 1000);
  assert.equal(json.trackPersistence.serverSide, true);
  assert.equal(json.trackPersistence.storage, "server");
  assert.equal(json.trackPersistence.maxCount, 7200);
  assert.match(json.dataDirectory, /signalk-ajrm-marine-dr-plotter$/);
  assert.match(json.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(json.ajrmMarineGpsIntegrity, { trust: "normal" });
  const projection = messages[0].updates[0].values[0];
  assert.equal(projection.path, "plugins.ajrmMarineDrPlotter");
  assert.equal(projection.value.plotFixPersistence.serverSide, true);
  const openApi = plugin.getOpenApi();
  assert.equal(openApi.openapi, "3.0.3");
  for (const routePath of ["/status", "/settings", "/plot-fixes", "/track", "/fixes", "/charts", "/active-route"]) {
    assert.ok(openApi.paths[routePath], `${routePath} is documented`);
  }
  const stopResult = plugin.stop();
  assert.equal(typeof stopResult?.then, "function");
  await stopResult;
  const stoppedProjection = messages.at(-1).updates[0].values[0];
  assert.equal(stoppedProjection.path, "plugins.ajrmMarineDrPlotter");
  assert.equal(stoppedProjection.value, null);
});

test("exposes the route selected in AJRM Marine Display", async () => {
  const active = {
    resourceId: "route-1",
    revision: 3,
    resource: {
      name: "Test route",
      feature: { geometry: { type: "LineString", coordinates: [[-5.5, 56.2], [-5.4, 56.3]] } },
    },
  };
  const plugin = pluginFactory({
    ajrmMarineDisplayApi: {
      async currentRoute() {
        return active;
      },
    },
    handleMessage() {},
  });
  let handler;
  plugin.registerWithRouter({
    get(routePath, routeHandler) {
      if (routePath === "/active-route") handler = routeHandler;
    },
    put() {},
    post() {},
    delete() {},
  });
  let body;
  await handler({}, { json(value) { body = value; } });
  assert.equal(body.ok, true);
  assert.deepEqual(body.active, active);
});

test("all mutating routes require Signal K write access", async () => {
  const plugin = pluginFactory({
    handleMessage() {},
    setPluginStatus() {},
  });
  const routes = new Map();
  plugin.registerWithRouter({
    get() {},
    put(routePath, handler) {
      routes.set(`PUT ${routePath}`, handler);
    },
    post(routePath, handler) {
      routes.set(`POST ${routePath}`, handler);
    },
    delete(routePath, handler) {
      routes.set(`DELETE ${routePath}`, handler);
    },
  });

  for (const routeName of [
    "PUT /settings",
    "PUT /track",
    "DELETE /track",
    "PUT /plot-fixes",
    "POST /plot-fixes",
    "DELETE /plot-fixes",
  ]) {
    let statusCode = 200;
    let body = null;
    await routes.get(routeName)(
      { skIsAuthenticated: false, body: {} },
      {
        status(code) {
          statusCode = code;
          return this;
        },
        json(value) {
          body = value;
        },
      },
    );
    assert.equal(statusCode, 403, routeName);
    assert.match(body.error, /read\/write|admin/i, routeName);
  }
});

test("unwraps plain Signal K values without changing them", () => {
  assert.equal(pluginFactory._private.unwrapSignalKValue(42), 42);
  assert.deepEqual(pluginFactory._private.unwrapSignalKValue({ value: { ok: true } }), { ok: true });
});

test("normalizes persisted plot fixes", () => {
  const fixes = pluginFactory._private.normalizePlotFixes([
    {
      id: "lost-fix",
      timestamp: "2026-06-29T10:00:00.000Z",
      automatic: true,
      plotType: "gps-lost",
      position: { latitude: "56.2", longitude: "-5.5" },
      trust: "lost",
      drSource: "heading-stw-current",
      uncertaintyRadiusMeters: "42",
      lastTrustedFixAgeSeconds: "600",
      distanceFromLastTrustedFixMeters: "1234",
      stwMps: "0",
      headingTrueDegrees: "90",
      sogMps: "1.2",
      cogTrueDegrees: "95",
      currentDriftMps: "0.8",
      currentSetTrueDegrees: "180",
    },
    {
      id: "observed",
      timestamp: "2026-06-29T10:05:00.000Z",
      plotType: "observed-fix",
      position: { latitude: 56.21, longitude: -5.56 },
      note: "visual bearings",
    },
    {
      id: "gps-return",
      timestamp: "2026-06-29T10:06:00.000Z",
      plotType: "gps-return",
      position: { latitude: 56.22, longitude: -5.57 },
    },
  ]);

  assert.equal(fixes.length, 3);
  assert.equal(fixes[0].id, "lost-fix");
  assert.equal(fixes[0].plotType, "gps-lost");
  assert.equal(fixes[0].position.latitude, 56.2);
  assert.equal(fixes[0].distanceFromLastTrustedFixMeters, 1234);
  assert.equal(fixes[1].plotType, "observed-fix");
  assert.equal(fixes[1].note, "visual bearings");
  assert.equal(fixes[2].plotType, "gps-return");
  assert.equal(fixes[2].resource.resourceType, "fixes");
  assert.deepEqual(fixes[2].resource.feature.geometry.coordinates, [-5.57, 56.22]);
  assert.equal(fixes[2].resource.feature.properties.symbol, "square-dot");
});

test("atomic JSON writes replace files without leaving shared temp files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajrm-dr-plotter-atomic-"));
  const filePath = path.join(tempDir, "plot-fixes.json");
  try {
    for (let index = 0; index < 10; index += 1) {
      await pluginFactory._private.writeJsonFileAtomic(filePath, {
        schemaVersion: 1,
        plotFixes: [{ id: `fix-${index}` }],
      });
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.plotFixes.length, 1);
    assert.equal(parsed.plotFixes[0].id, "fix-9");
    assert.deepEqual(
      fs.readdirSync(tempDir).filter((name) => name.includes(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("web app renders lost GPS plot fixes as estimated positions", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "styles.css"), "utf8");

  assert.match(app, /estimated-position/);
  assert.match(app, /trust === "lost"/);
  assert.match(app, /className: `plot-fix-symbol-marker/);
  assert.match(app, /className: "plot-fix-label-marker"/);
  assert.match(app, /iconSize: \[28, 28\]/);
  assert.match(app, /iconAnchor: \[14, 14\]/);
  assert.match(css, /\.plot-fix-symbol-marker\.estimated-position \.plot-fix-symbol/);
  assert.match(css, /left: 14px/);
  assert.match(css, /top: 14px/);
  assert.match(css, /transform: translate\(-50%, -50%\)/);
  assert.match(app, /Current\/residual drift \/ set/);
  assert.doesNotMatch(app, /Tide drift \/ set/);
});

test("web app includes Display-style GPS status LED", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "styles.css"), "utf8");

  assert.match(html, /id="gpsStatusIndicator"/);
  assert.match(html, /ajrm-marine-gps-status-led/);
  assert.match(app, /function updateGpsStatusIndicator/);
  assert.match(app, /GPS OK/);
  assert.match(app, /GPS LOST/);
  assert.match(css, /\.ajrm-marine-gps-status-ok \.ajrm-marine-gps-status-led/);
  assert.match(css, /\.ajrm-marine-gps-status-alert \.ajrm-marine-gps-status-led/);
});

test("web app hides the independent DR uncertainty circle", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");

  assert.match(app, /addPoint\(integrityPosition, "integrity-dr", "IDR"\)/);
  assert.match(app, /integrityDeadReckoning\?\.comparisonAvailable === false/);
  assert.doesNotMatch(app, /radius: integrityDr\.uncertaintyRadiusMeters/);
});

test("web app exposes manual plot-fix pruning", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");

  assert.match(html, /id="prunePlotFixesAge"/);
  assert.match(html, /Prune old fixes/);
  assert.match(app, /function pruneOldPlotFixes/);
  assert.match(app, /savePlotFixesServer\(\)/);
});

test("web app forces breadcrumb points at plotted electronic fixes", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");

  assert.match(app, /updateOperationalTrack\(normalized\.position, normalized\.timestamp, true\)/);
  assert.match(app, /function updateOperationalTrack\(position, timestamp, force = false\)/);
  assert.match(app, /!force && last && distanceMeters\(last, position\) < 2/);
});

test("server creates a GPS-return fix from the returned GPS coordinate", () => {
  const fix = pluginFactory._private.createPlotFixFromIntegrityState(
    {
      timestamp: "2026-06-29T18:56:00.000Z",
      trust: "normal",
      acceptedGps: true,
      gps: {
        position: { latitude: 56.2, longitude: -5.5 },
        speedOverGround: 2,
        courseOverGroundTrue: Math.PI / 2,
      },
      operationalDeadReckoning: {
        position: { latitude: 56.3, longitude: -5.6 },
        source: "heading-stw-current",
        uncertaintyRadiusMeters: 120,
        gpsDependent: false,
        leewayStatus: "known",
        currentOrigin: "independent-tidal-model",
        provenance: {
          trackThroughWater: { source: "compass.one+leeway-model" },
          speedThroughWater: { source: "water-log.one" },
          current: { source: "tidal-model.one" },
          leeway: { source: "leeway-model" },
        },
      },
      integrityDeadReckoning: {
        position: { latitude: 56.29, longitude: -5.59 },
        source: "heading-stw-independent-current",
        assurance: "full",
        comparisonAvailable: true,
        ageSeconds: 45,
        uncertaintyRadiusMeters: 80,
        gpsDependent: false,
        leewayStatus: "known",
        currentOrigin: "independent-tidal-model",
        provenance: {
          trackThroughWater: { source: "compass.one+leeway-model" },
          speedThroughWater: { source: "water-log.one" },
          current: { source: "tidal-model.one" },
          leeway: { source: "leeway-model" },
        },
      },
      lastTrustedFix: {
        timestamp: "2026-06-29T18:50:00.000Z",
        position: { latitude: 56.19, longitude: -5.49 },
      },
      navigationProvenance: {
        navigationReference: {
          contract: "ajrm-marine-navigation-reference",
          schemaVersion: 1,
          clockReference: {
            kind: "heading",
            source: "compass.one",
            method: "direct-true-heading",
            ageMs: 1500,
            uncertaintyRad: 5 * Math.PI / 180,
            gpsDependent: false,
          },
        },
      },
      vectors: {
        courseOverGround: { speedMps: 2, bearingTrueDegrees: 90 },
      },
    },
    true,
    "gps-return",
  );

  assert.equal(fix.plotType, "gps-return");
  assert.deepEqual(fix.position, { latitude: 56.2, longitude: -5.5 });
  assert.equal(fix.cogTrueDegrees, 90);
  assert.equal(fix.distanceFromLastTrustedFixMeters > 0, true);
  assert.equal(fix.drGpsDependent, false);
  assert.equal(fix.drCurrentOrigin, "independent-tidal-model");
  assert.equal(fix.drTrackThroughWaterSource, "compass.one+leeway-model");
  assert.equal(fix.integrityAssurance, "full");
  assert.equal(fix.integrityComparisonAvailable, true);
  assert.equal(fix.integrityUncertaintyRadiusMeters, 80);
  assert.equal(fix.integrityCurrentSource, "tidal-model.one");
  assert.equal(fix.referenceKind, "heading");
  assert.equal(fix.referenceSource, "compass.one");
  assert.equal(fix.referenceAgeSeconds, 1.5);
  assert.equal(Math.round(fix.referenceUncertaintyDegrees), 5);
  assert.equal(fix.referenceGpsDependent, false);
  const persisted = pluginFactory._private.normalizePlotFix(fix);
  assert.equal(persisted.integrityCurrentSource, "tidal-model.one");
  assert.equal(persisted.referenceKind, "heading");
  assert.equal(persisted.resource.feature.properties.integrityCurrentSource, "tidal-model.one");
  assert.equal(persisted.resource.feature.properties.referenceMethod, "direct-true-heading");
});

test("summarizes explicit Navigation Reference context without inventing missing values", () => {
  const summary = pluginFactory._private.navigationReferenceSummary({
    navigationProvenance: {
      navigationReference: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        clockReference: {
          kind: "track-proxy",
          source: "gps.one",
          method: "moving-course-over-ground-proxy",
          ageMs: 2500,
          uncertaintyRad: 10 * Math.PI / 180,
          gpsDependent: true,
        },
      },
    },
  });

  assert.equal(summary.kind, "track-proxy");
  assert.equal(summary.source, "gps.one");
  assert.equal(summary.method, "moving-course-over-ground-proxy");
  assert.equal(summary.ageSeconds, 2.5);
  assert.equal(Math.round(summary.uncertaintyDegrees), 10);
  assert.equal(summary.gpsDependent, true);
  assert.deepEqual(pluginFactory._private.navigationReferenceSummary({}), {
    kind: null,
    source: null,
    method: null,
    ageSeconds: null,
    uncertaintyDegrees: null,
    gpsDependent: null,
  });
  assert.equal(
    pluginFactory._private.navigationReferenceSummary({
      navigationProvenance: {
        navigationReference: {
          contract: "ajrm-marine-navigation-reference",
          schemaVersion: 2,
          clockReference: { kind: "heading", source: "unaccepted.future.contract" },
        },
      },
    }).source,
    null,
  );
});

test("server treats GPS return as usable when acceptedGps is omitted but position is present", () => {
  assert.equal(pluginFactory._private.recoveredGpsPositionAvailable({
    trust: "normal",
    gps: { position: { latitude: 56.2, longitude: -5.5 } },
  }), true);
  assert.equal(pluginFactory._private.recoveredGpsPositionAvailable({
    trust: "normal",
    acceptedGps: false,
    gps: { position: { latitude: 56.2, longitude: -5.5 } },
  }), false);
  assert.equal(pluginFactory._private.recoveredGpsPositionAvailable({
    trust: "normal",
    acceptedGps: true,
  }), false);
});

test("automatic GPS outage fixes record one lost fix and one return fix per outage", () => {
  const firstLost = pluginFactory._private.automaticFixDecision({}, {
    timestamp: "2026-07-07T12:02:29.000Z",
    trust: "lost",
    lastTrustedFix: { timestamp: "2026-07-07T12:02:20.000Z" },
  });
  assert.equal(firstLost.plotType, "gps-lost");
  assert.equal(firstLost.next.gpsOutageActive, true);

  const repeatedLost = pluginFactory._private.automaticFixDecision(firstLost.next, {
    timestamp: "2026-07-07T12:02:30.000Z",
    trust: "lost",
    lastTrustedFix: { timestamp: "2026-07-07T12:02:21.000Z" },
  });
  assert.equal(repeatedLost.plotType, null);
  assert.equal(repeatedLost.next.gpsOutageActive, true);

  const intermediateNonLostWithoutFix = pluginFactory._private.automaticFixDecision(repeatedLost.next, {
    timestamp: "2026-07-07T12:03:00.000Z",
    trust: "suspect",
  });
  assert.equal(intermediateNonLostWithoutFix.plotType, null);
  assert.equal(intermediateNonLostWithoutFix.next.gpsOutageActive, true);

  const returned = pluginFactory._private.automaticFixDecision(intermediateNonLostWithoutFix.next, {
    timestamp: "2026-07-07T12:03:18.000Z",
    trust: "normal",
    gps: { position: { latitude: 56.22, longitude: -5.56 } },
  });
  assert.equal(returned.plotType, "gps-return");
  assert.equal(returned.next.gpsOutageActive, false);
  assert.equal(returned.next.gpsLostPlotFixRecordedFor, null);
});

test("concurrent GPS recovery observations serialize to one return fix", async () => {
  const queue = pluginFactory._private.createSerialQueue();
  const recorded = [];
  let memory = {};
  const record = (state) => queue.run(async () => {
    const decision = pluginFactory._private.automaticFixDecision(memory, state);
    if (decision.plotType) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recorded.push(decision.plotType);
    }
    memory = decision.next;
  });

  await record({
    timestamp: "2026-08-03T19:16:44.639Z",
    trust: "lost",
    lastTrustedFix: { timestamp: "2026-08-03T19:16:13.500Z" },
  });
  await Promise.all([
    record({
      timestamp: "2026-08-03T19:17:42.107Z",
      trust: "normal",
      gps: { position: { latitude: 56.2253, longitude: -5.56749 } },
    }),
    record({
      timestamp: "2026-08-03T19:17:43.163Z",
      trust: "normal",
      gps: { position: { latitude: 56.22532, longitude: -5.56751 } },
    }),
  ]);

  assert.deepEqual(recorded, ["gps-lost", "gps-return"]);
  assert.equal(memory.gpsOutageActive, false);
});

test("status reporting does not record navigation state", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "components", "dr-plotter.js"), "utf8");
  const statusFunction = source.match(/function status\(\) \{[\s\S]*?\n  function publicSettings\(\)/)?.[0];
  assert.ok(statusFunction);
  assert.doesNotMatch(statusFunction, /recordNavigationState/);
});

test("server creates operational track points from GPS Integrity state", () => {
  const point = pluginFactory._private.trackPointFromIntegrityState({
    timestamp: "2026-06-30T15:34:00.000Z",
    trust: "normal",
    gps: {
      position: { latitude: 56.2, longitude: -5.5 },
    },
    operationalDeadReckoning: {
      position: { latitude: 56.21, longitude: -5.51 },
      source: "gps-locked",
      uncertaintyRadiusMeters: 10,
      gpsDependent: true,
      leewayStatus: "unknown",
      currentOrigin: "ground-minus-water-residual",
    },
    navigationProvenance: {
      navigationReference: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        clockReference: {
          kind: "track-proxy",
          source: "gps.one",
          ageMs: 500,
          uncertaintyRad: Math.PI / 18,
          gpsDependent: true,
        },
      },
    },
  });

  assert.deepEqual(point, {
    latitude: 56.21,
    longitude: -5.51,
    timestamp: "2026-06-30T15:34:00.000Z",
    trust: "normal",
    source: "gps-locked",
    uncertaintyRadiusMeters: 10,
    gpsDependent: true,
    leewayStatus: "unknown",
    currentOrigin: "ground-minus-water-residual",
    referenceKind: "track-proxy",
    referenceSource: "gps.one",
    referenceAgeSeconds: 0.5,
    referenceUncertaintyDegrees: 10,
    referenceGpsDependent: true,
  });
});

test("normalizes operational track points for server persistence", () => {
  const points = pluginFactory._private.normalizeTrackPoints([
    {
      latitude: "56.3",
      longitude: "-5.3",
      timestamp: "2026-06-30T15:35:00.000Z",
      trust: "lost",
      source: "heading-stw-current",
    },
    {
      latitude: 56.2,
      longitude: -5.2,
      timestamp: "2026-06-30T15:34:00.000Z",
    },
    {
      latitude: 99,
      longitude: -5.4,
      timestamp: "2026-06-30T15:36:00.000Z",
    },
  ]);

  assert.equal(points.length, 2);
  assert.equal(points[0].timestamp, "2026-06-30T15:34:00.000Z");
  assert.equal(points[1].timestamp, "2026-06-30T15:35:00.000Z");
  assert.equal(points[1].source, "heading-stw-current");
  assert.equal(points[0].uncertaintyRadiusMeters, null);
  assert.equal(points[0].gpsDependent, null);
});

test("server exposes plot fixes as resource-style fix features", () => {
  const resource = pluginFactory._private.plotFixToResource({
    id: "return",
    timestamp: "2026-06-29T18:56:00.000Z",
    plotType: "gps-return",
    position: { latitude: 56.2, longitude: -5.5 },
    trust: "normal",
    uncertaintyRadiusMeters: 12,
    drGpsDependent: false,
    drLeewayStatus: "known",
    drCurrentOrigin: "independent-tidal-model",
    integritySource: "heading-stw-independent-current",
    integrityAssurance: "full",
    integrityComparisonAvailable: true,
    integrityGpsDependent: false,
    referenceKind: "heading",
    referenceSource: "compass.one",
    referenceAgeSeconds: 1.5,
    referenceUncertaintyDegrees: 5,
    referenceGpsDependent: false,
  });

  assert.equal(resource.id, "return");
  assert.equal(resource.resourceType, "fixes");
  assert.equal(resource.feature.type, "Feature");
  assert.deepEqual(resource.feature.geometry.coordinates, [-5.5, 56.2]);
  assert.equal(resource.feature.properties.method, "electronic");
  assert.equal(resource.feature.properties.symbol, "square-dot");
  assert.equal(resource.feature.properties.trust, "normal");
  assert.equal(resource.feature.properties.uncertaintyRadiusMeters, 12);
  assert.equal(resource.feature.properties.drGpsDependent, false);
  assert.equal(resource.feature.properties.drCurrentOrigin, "independent-tidal-model");
  assert.equal(resource.feature.properties.integrityAssurance, "full");
  assert.equal(resource.feature.properties.integrityComparisonAvailable, true);
  assert.equal(resource.feature.properties.referenceKind, "heading");
  assert.equal(resource.feature.properties.referenceSource, "compass.one");
  assert.equal(resource.feature.properties.referenceGpsDependent, false);
});

test("missing plot-fix evidence stays unavailable while explicit zero remains zero", () => {
  const integrityReason =
    "Independent integrity comparison unavailable: missing independent true heading, independent speed through water, independent current, and leeway evidence.";
  const [fix] = pluginFactory._private.normalizePlotFixes([
    {
      timestamp: "2026-07-27T12:00:00.000Z",
      position: { latitude: 56.2, longitude: -5.5 },
      stwMps: 0,
      uncertaintyRadiusMeters: null,
      integrityComparisonAvailable: false,
      integrityUnavailableReason: integrityReason,
    },
  ]);

  assert.equal(fix.stwMps, 0);
  assert.equal(fix.uncertaintyRadiusMeters, null);
  assert.equal(fix.cogTrueDegrees, null);
  assert.equal(fix.referenceUncertaintyDegrees, null);
  assert.equal(fix.integrityComparisonAvailable, false);
  assert.equal(fix.integrityUnavailableReason, integrityReason);
});

test("web app exposes operational, integrity-assurance, and reference provenance separately", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");

  assert.match(html, /id="referenceKind"/);
  assert.match(html, /id="referenceUncertainty"/);
  assert.match(html, /id="drDependency"/);
  assert.match(html, /id="drLeeway"/);
  assert.match(html, /id="integrityAssurance"/);
  assert.match(html, /id="integrityComparison"/);
  assert.match(html, /current\/residual origin/i);
  assert.match(html, /independent integrity comparison DR/);
  assert.match(app, /navigationProvenance\?\.navigationReference/);
  assert.match(app, /navigationReference\?\.contract === navigationReferenceContract/);
  assert.match(app, /formatDependency/);
  assert.match(app, /formatDrProvenance/);
  assert.match(app, /ground-minus-water-residual/);
});

test("web app reloads server-authored plot fixes when status changes", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");
  const plugin = fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "components", "dr-plotter.js"), "utf8");

  assert.match(app, /latestStatus\.plotFixesUpdatedAt/);
  assert.match(app, /lastPlotFixesUpdatedAt/);
  assert.doesNotMatch(app, /lastTrustState === "lost"/);
  assert.doesNotMatch(app, /function maybeAddAutomaticPlotFix/);
  assert.doesNotMatch(app, /plotFixIntervalStorageKey/);
  assert.match(plugin, /appendTimedPlotFixIfDue/);
  assert.match(plugin, /plotFixIntervalMinutes/);
  assert.match(plugin, /router\.put\("\/settings"/);
  assert.match(app, /\/settings`, "PUT"/);
  assert.match(app, /if \(plotFix\.plotType === "gps-return"\) return "GPS fix"/);
});

test("web app reloads server-authored operational track when status changes", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");
  const plugin = fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "components", "dr-plotter.js"), "utf8");

  assert.match(plugin, /OPERATIONAL_TRACK_FILE/);
  assert.match(plugin, /router\.get\("\/track"/);
  assert.match(plugin, /operationalTrackUpdatedAt/);
  assert.match(plugin, /trackPointFromIntegrityState/);
  assert.match(app, /latestStatus\.operationalTrackUpdatedAt/);
  assert.match(app, /\$\{apiBase\}\/track/);
  assert.match(app, /\$\{apiBase\}\/track`, "DELETE"/);
  assert.doesNotMatch(app, /function syncOperationalTrackSession/);
});

test("web app shows live cursor latitude and longitude", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "styles.css"), "utf8");

  assert.match(html, /id="cursorPosition"/);
  assert.match(app, /map\.on\("mousemove", updateCursorPosition\)/);
  assert.match(app, /function formatLatLon/);
  assert.match(app, /function formatCoordinate/);
  assert.match(app, /function cursorRangeText/);
  assert.match(app, /function bearingDegrees/);
  assert.match(app, /Range/);
  assert.match(app, /coordinateFormat = "dms"/);
  assert.match(app, /ajrmMarineDrPlotterCoordinateFormat/);
  assert.match(app, /applyCoordinateFormat/);
  assert.match(html, /id="coordinateFormat"/);
  assert.match(html, /Degrees decimal minutes/);
  assert.match(css, /\.cursor-position/);
});

test("coordinate-format changes refresh clickable plot-fix popups", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");

  assert.match(app, /const formatChanged = coordinateFormat !== nextCoordinateFormat/);
  assert.match(app, /if \(formatChanged && plotFixesLoaded\) redrawPlotFixes\(\)/);
  assert.match(app, /marker\.bindPopup\(\(\) => plotFixPopupHtml\(plotFix\)/);
  assert.match(app, /popupRow\("Position", formatPosition\(plotFix\.position\)\)/);
});

test("web app exposes a debugging clear-all-plots control", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");

  assert.match(html, /id="clearAllPlots"/);
  assert.match(app, /function clearAllPlots/);
  assert.match(app, /operationalTrack = \[\]/);
});

test("web app can submit observed fixes to GPS Integrity", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "plotter", "styles.css"), "utf8");

  assert.match(html, /id="manualFixLatitude"/);
  assert.match(html, /id="pickManualFixFromCursor"/);
  assert.match(html, /type="text" inputmode="text"/);
  assert.match(html, /56N 12' 40\.4''/);
  assert.match(html, /5W 33' 28\.4''/);
  assert.match(html, /Set observed fix/);
  assert.match(app, /gpsIntegrityApiBase/);
  assert.match(app, /function applyManualFix/);
  assert.match(app, /function parseCoordinateInput/);
  assert.match(app, /text\.match\(\/\[NSEW\]\//);
  assert.match(app, /function formatCoordinateInput/);
  assert.match(app, /function startManualFixPickMode/);
  assert.match(app, /function handleMapClick/);
  assert.match(app, /formatCoordinateInput\(lat, "N", "S"\)/);
  assert.match(app, /observed-fix/);
  assert.match(css, /\.plot-fix-symbol-marker\.observed-fix/);
  assert.match(css, /\.manual-fix-pick-mode/);
});
