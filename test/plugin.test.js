"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const pluginFactory = require("../plugin");

test("samples wrapped Signal K self-path values", () => {
  const paths = {
    "navigation.position": { value: { latitude: 56, longitude: -5 }, timestamp: "2026-06-22T12:00:00.000Z" },
    "navigation.speedOverGround": { value: 2, timestamp: "2026-06-22T12:00:00.100Z" },
    "navigation.courseOverGroundTrue": { value: 1.2, timestamp: "2026-06-22T12:00:00.200Z" },
    "navigation.headingTrue": { value: 1.1, timestamp: "2026-06-22T12:00:00.300Z" },
    "navigation.speedThroughWater": { value: 1.9, timestamp: "2026-06-22T12:00:00.400Z" },
    "environment.current.setTrue": {
      $source: "derived-current",
      values: {
        "derived-current": { value: 1.57, timestamp: "2026-06-22T12:00:00.500Z" },
      },
    },
    "environment.current.drift": {
      value: 0.6,
      timestamp: "2026-06-22T12:00:00.600Z",
    },
    "navigation.gnss.horizontalDilution": { value: 0.8 },
    "navigation.gnss.satellites": { value: 9 },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });
  assert.deepEqual(sample.position, { latitude: 56, longitude: -5 });
  assert.equal(sample.positionTimestamp, "2026-06-22T12:00:00.000Z");
  assert.equal(sample.fixValid, true);
  assert.equal(sample.speedOverGround, 2);
  assert.equal(sample.speedOverGroundTimestamp, "2026-06-22T12:00:00.100Z");
  assert.equal(sample.headingTrue, 1.1);
  assert.equal(sample.headingTrueTimestamp, "2026-06-22T12:00:00.300Z");
  assert.equal(sample.currentSetTrue, undefined);
  assert.equal(sample.currentDrift, undefined);
  assert.equal(sample.currentEvidence, null);
  assert.equal(sample.hdop, 0.8);
  assert.equal(sample.satellites, 9);
});

test("chooses a coherent moving navigation source over canonical stationary values", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.211333, longitude: -5.559139 },
      $source: "stationary-source",
      timestamp: "2026-06-22T17:00:18.490Z",
      values: {
        "moving-source": {
          value: { latitude: 56.211222, longitude: -5.550586 },
          timestamp: "2026-06-22T17:00:18.466Z",
        },
        "stationary-source": {
          value: { latitude: 56.211333, longitude: -5.559139 },
          timestamp: "2026-06-22T17:00:18.490Z",
        },
      },
    },
    "navigation.speedOverGround": {
      value: 0,
      $source: "stationary-source",
      timestamp: "2026-06-22T17:00:18.490Z",
      values: {
        "moving-source": { value: 5.14444, timestamp: "2026-06-22T17:00:18.466Z" },
        "stationary-source": { value: 0, timestamp: "2026-06-22T17:00:18.490Z" },
      },
    },
    "navigation.courseOverGroundTrue": {
      value: 0,
      $source: "stationary-source",
      values: {
        "moving-source": { value: Math.PI / 2, timestamp: "2026-06-22T17:00:18.466Z" },
        "stationary-source": { value: 0, timestamp: "2026-06-22T17:00:18.490Z" },
      },
    },
    "navigation.headingTrue": {
      value: Math.PI / 2,
      $source: "moving-source",
      values: {
        "moving-source": { value: Math.PI / 2, timestamp: "2026-06-22T17:00:18.466Z" },
        "stationary-source": { value: 0, timestamp: "2026-06-22T17:00:18.490Z" },
      },
    },
    "navigation.speedThroughWater": {
      value: 5.14444,
      $source: "moving-source",
      timestamp: "2026-06-22T17:00:18.466Z",
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });
  assert.equal(sample.source, "moving-source");
  assert.deepEqual(sample.position, { latitude: 56.211222, longitude: -5.550586 });
  assert.equal(sample.positionTimestamp, "2026-06-22T17:00:18.466Z");
  assert.equal(sample.speedOverGround, 5.14444);
  assert.equal(sample.courseOverGroundTrue, Math.PI / 2);
  assert.equal(sample.headingTrue, Math.PI / 2);
  assert.equal(sample.speedThroughWater, 5.14444);
});

test("treats wrapped null position as invalid GPS", () => {
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      if (path === "navigation.position") return { value: null };
      return undefined;
    },
  });
  assert.equal(sample.position, null);
  assert.equal(sample.fixValid, false);
});

test("fresh null GPS source beats stale valid position from another source", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.21122, longitude: -5.55756 },
      $source: "old-gps",
      timestamp: "2026-07-02T17:20:26.918Z",
      values: {
        "old-gps": {
          value: { latitude: 56.21122, longitude: -5.55756 },
          timestamp: "2026-07-02T17:20:26.918Z",
        },
        "simulator": {
          value: null,
          timestamp: "2026-07-02T18:30:03.608Z",
        },
      },
    },
    "navigation.speedOverGround": {
      values: {
        "old-gps": { value: 2.5, timestamp: "2026-07-02T17:20:26.918Z" },
        "simulator": { value: null, timestamp: "2026-07-02T18:30:03.608Z" },
      },
    },
    "navigation.courseOverGroundTrue": {
      values: {
        "old-gps": { value: 1.2, timestamp: "2026-07-02T17:20:26.918Z" },
        "simulator": { value: null, timestamp: "2026-07-02T18:30:03.608Z" },
      },
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });
  assert.equal(sample.source, "simulator");
  assert.equal(sample.position, null);
  assert.equal(sample.positionTimestamp, "2026-07-02T18:30:03.608Z");
  assert.equal(sample.fixValid, false);
});

test("does not combine unqualified raw set and drift values", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.21122, longitude: -5.55756 },
      timestamp: "2026-07-03T16:54:03.610Z",
    },
    "environment.current.setTrue": {
      value: Math.PI,
      $source: "stale-current",
      timestamp: "2026-07-03T14:58:53.548Z",
      values: {
        "stale-current": { value: Math.PI, timestamp: "2026-07-03T14:58:53.548Z" },
        "ajrm-marine-bite": { value: Math.PI / 2, timestamp: "2026-07-03T16:54:03.610Z" },
      },
    },
    "environment.current.drift": {
      value: 0,
      $source: "stale-current",
      timestamp: "2026-07-03T14:58:53.548Z",
      values: {
        "stale-current": { value: 0, timestamp: "2026-07-03T14:58:53.548Z" },
        "ajrm-marine-bite": { value: 0.514444, timestamp: "2026-07-03T16:54:03.610Z" },
      },
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.currentSetTrue, undefined);
  assert.equal(sample.currentDrift, undefined);
  assert.equal(sample.currentEvidence, null);
});

test("consumes navigation reference v1 with explicit independent provenance", () => {
  const timestamp = new Date().toISOString();
  const measurement = (value, source, gpsDependent, extra = {}) => ({
    value,
    source,
    sourceKind: gpsDependent ? "gnss" : "sensor",
    timestamp,
    ageMs: 0,
    method: "selected",
    gpsDependent,
    ...extra,
  });
  const paths = {
    "plugins.ajrmMarineNavigationReference.state": {
      value: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        updatedAt: timestamp,
        status: "degraded",
        position: measurement({ latitude: 56.21, longitude: -5.56 }, "gps.one", true),
        groundTrack: {
          courseTrue: measurement(Math.PI / 2, "gps.one", true),
          speedOverGround: measurement(2.1, "gps.one", true),
          source: "gps.one",
          timestamp,
          ageMs: 0,
          gpsDependent: true,
          coherent: true,
        },
        bowHeadingTrue: measurement(0.2, "compass.one", false, {
          uncertaintyRad: 5 * Math.PI / 180,
        }),
        clockReference: {
          ...measurement(0.2, "compass.one", false, {
            uncertaintyRad: 5 * Math.PI / 180,
          }),
          kind: "heading",
        },
        magneticVariation: measurement(
          -1.36 * Math.PI / 180,
          "signalk-ajrm-marine-navigation-reference",
          false,
          { method: "WMM-2025" },
        ),
        throughWater: {
          headingTrue: measurement(0.2, "compass.one", false),
          speedThroughWater: measurement(1.8, "water-log.one", false),
          leeway: measurement(0.03, "leeway-model", false),
          trackTrue: measurement(0.23, "navigation-reference", false),
          leewayStatus: "known",
        },
        current: {
          setTrue: Math.PI,
          drift: 0.4,
          source: "tidal-model.one",
          sourceKind: "tidal-model",
          timestamp,
          ageMs: 0,
          origin: "independent-tidal-model",
          gpsDependent: false,
          quality: { status: "good" },
        },
        residual: {
          setTrue: 1,
          drift: 9,
          source: "gps.one+water-log.one+compass.one",
          sourceKind: "calculated",
          timestamp,
          ageMs: 0,
          origin: "ground-minus-water-residual",
          gpsDependent: true,
          leewayStatus: "known",
          quality: "instantaneous",
        },
      },
    },
    "navigation.position": {
      value: { latitude: 0, longitude: 0 },
      $source: "other-gps",
      timestamp,
    },
    "navigation.headingMagnetic": {
      value: 2.8,
      $source: "autopilot",
      timestamp,
    },
    "navigation.gnss.horizontalDilution": {
      $source: "gps.one",
      value: 0.7,
      timestamp,
    },
    "navigation.gnss.satellites": {
      $source: "gps.one",
      value: 10,
      timestamp,
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.source, "gps.one");
  assert.deepEqual(sample.position, { latitude: 56.21, longitude: -5.56 });
  assert.equal(sample.speedOverGround, 2.1);
  assert.equal(sample.courseOverGroundTrue, Math.PI / 2);
  assert.equal(sample.headingTrue, 0.2);
  assert.equal(sample.headingTrueEvidence.gpsDependent, false);
  assert.equal(sample.speedThroughWater, 1.8);
  assert.equal(sample.trackThroughWaterTrue, 0.23);
  assert.equal(sample.leewayStatus, "known");
  assert.equal(sample.currentEvidence.source, "tidal-model.one");
  assert.equal(sample.currentEvidence.origin, "independent-tidal-model");
  assert.equal(sample.currentEvidence.gpsDependent, false);
  assert.equal(sample.currentDrift, 0.4);
  assert.equal(sample.navigationReference.schemaVersion, 1);
  assert.equal(sample.navigationReference.clockReference.kind, "heading");
  assert.equal(
    sample.navigationReference.clockReference.source,
    "compass.one",
  );
  assert.equal(
    sample.navigationReference.clockReference.uncertaintyRad,
    5 * Math.PI / 180,
  );
  assert.equal(
    sample.navigationReference.magneticVariation.method,
    "WMM-2025",
  );
  assert.equal(sample.navigationReference.residual.gpsDependent, true);
});

test("withholds a malformed mixed-source Navigation Reference ground triplet", () => {
  const timestamp = new Date().toISOString();
  const measurement = (value, source) => ({
    value,
    source,
    sourceKind: "gnss",
    timestamp,
    ageMs: 0,
    method: "selected",
    gpsDependent: true,
  });
  const paths = {
    "plugins.ajrmMarineNavigationReference.state": {
      value: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        position: measurement(
          { latitude: 56.21, longitude: -5.56 },
          "gps.one",
        ),
        groundTrack: {
          courseTrue: measurement(Math.PI / 2, "gps.two"),
          speedOverGround: measurement(2.1, "gps.one"),
          source: "gps.one",
          timestamp,
          ageMs: 0,
          gpsDependent: true,
          coherent: true,
        },
      },
    },
    "navigation.position": {
      value: { latitude: 0, longitude: 0 },
      $source: "raw-gps",
      timestamp,
    },
    "navigation.courseOverGroundTrue": {
      value: 1,
      $source: "raw-gps",
      timestamp,
    },
    "navigation.speedOverGround": {
      value: 2,
      $source: "raw-gps",
      timestamp,
    },
  };

  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.source, null);
  assert.equal(sample.position, undefined);
  assert.equal(sample.courseOverGroundTrue, undefined);
  assert.equal(sample.speedOverGround, undefined);
  assert.equal(sample.fixValid, false);
  assert.equal(sample.gnssProvenance.coherent, false);
  assert.equal(sample.gnssProvenance.method, "navigation-reference");
});

test("bridges a qualified provider residual as GPS-dependent operational current", () => {
  const timestamp = new Date().toISOString();
  const paths = {
    "plugins.ajrmMarineNavigationReference.state": {
      value: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        current: {
          setTrue: 0,
          drift: 0,
          source: "malformed-current",
        },
        residual: {
          setTrue: Math.PI / 2,
          drift: 0.45,
          source: "gps.one+water-log.one+compass.one",
          sourceKind: "calculated",
          timestamp,
          ageMs: 0,
          origin: "ground-minus-water-residual",
          gpsDependent: true,
          quality: "instantaneous",
        },
      },
    },
  };

  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.currentSetTrue, Math.PI / 2);
  assert.equal(sample.currentDrift, 0.45);
  assert.deepEqual(sample.currentEvidence, {
    setTrue: Math.PI / 2,
    drift: 0.45,
    source: "gps.one+water-log.one+compass.one",
    sourceKind: "calculated",
    timestamp,
    ageSeconds: 0,
    origin: "ground-minus-water-residual",
    gpsDependent: true,
    quality: "instantaneous",
  });
});

test("does not bridge a provider residual without strict operational provenance", () => {
  const timestamp = new Date().toISOString();
  const baseResidual = {
    setTrue: Math.PI / 2,
    drift: 0.45,
    source: "gps.one+water-log.one+compass.one",
    sourceKind: "calculated",
    timestamp,
    ageMs: 0,
    origin: "ground-minus-water-residual",
    gpsDependent: true,
    quality: "instantaneous",
  };
  const invalidResiduals = [
    { ...baseResidual, origin: "independent-tidal-model" },
    { ...baseResidual, gpsDependent: false },
    { ...baseResidual, timestamp: null },
    { ...baseResidual, quality: null },
  ];

  for (const residual of invalidResiduals) {
    const sample = pluginFactory._private.sampleFromSignalK({
      getSelfPath(path) {
        if (path !== "plugins.ajrmMarineNavigationReference.state") {
          return undefined;
        }
        return {
          value: {
            contract: "ajrm-marine-navigation-reference",
            schemaVersion: 1,
            current: null,
            residual,
          },
        };
      },
    });

    assert.equal(sample.currentEvidence, null);
    assert.equal(sample.currentSetTrue, undefined);
    assert.equal(sample.currentDrift, undefined);
  }
});

test("does not restore raw navigation values withheld by a valid Navigation Reference", () => {
  const timestamp = new Date().toISOString();
  const paths = {
    "navigation.position": {
      value: { latitude: 56.21, longitude: -5.56 },
      timestamp,
      $source: "gps.raw",
    },
    "navigation.courseOverGroundTrue": {
      value: Math.PI / 2,
      timestamp,
      $source: "gps.raw",
    },
    "navigation.speedOverGround": {
      value: 2.1,
      timestamp,
      $source: "gps.raw",
    },
    "navigation.headingTrue": {
      value: 1.1,
      timestamp,
      $source: "gps.raw",
    },
    "navigation.speedThroughWater": {
      value: 1.8,
      timestamp,
      $source: "water-log.raw",
    },
    "plugins.ajrmMarineNavigationReference.state": {
      value: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        updatedAt: timestamp,
        status: "unavailable",
        position: null,
        groundTrack: null,
        bowHeadingTrue: null,
        clockReference: null,
        throughWater: {
          headingTrue: null,
          speedThroughWater: null,
          leewayStatus: "unknown",
        },
        current: null,
      },
    },
  };

  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.source, null);
  assert.equal(sample.position, undefined);
  assert.equal(sample.speedOverGround, undefined);
  assert.equal(sample.courseOverGroundTrue, undefined);
  assert.equal(sample.headingTrue, undefined);
  assert.equal(sample.speedThroughWater, undefined);
  assert.equal(sample.headingTrueEvidence, null);
  assert.equal(sample.speedThroughWaterEvidence, null);
  assert.equal(sample.fixValid, false);
  assert.equal(sample.gnssProvenance.method, "navigation-reference");
});

test("keeps GNSS quality on the selected position source", () => {
  const timestamp = "2026-07-02T18:30:03.000Z";
  const paths = {
    "navigation.position": {
      value: { latitude: 56.2, longitude: -5.5 },
      $source: "gps.good",
      timestamp,
    },
    "navigation.speedOverGround": { value: 1, $source: "gps.good", timestamp },
    "navigation.courseOverGroundTrue": { value: 1, $source: "gps.good", timestamp },
    "navigation.gnss.methodQuality": {
      value: "no GPS",
      $source: "gps.other",
      timestamp,
    },
    "navigation.gnss.satellites": {
      value: 0,
      $source: "gps.other",
      timestamp,
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });
  assert.equal(sample.source, "gps.good");
  assert.equal(sample.methodQuality, undefined);
  assert.equal(sample.satellites, undefined);
  assert.equal(sample.explicitGpsUnavailable, false);
  assert.equal(sample.fixValid, true);
});

test("does not borrow COG or SOG from a different GNSS source", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.2, longitude: -5.5 },
      $source: "gps.complete",
      timestamp: "2026-07-14T12:00:00.000Z",
      values: {
        "gps.complete": {
          value: { latitude: 56.2, longitude: -5.5 },
          timestamp: "2026-07-14T12:00:00.000Z",
        },
        "gps.position-only": {
          value: { latitude: 56.21, longitude: -5.51 },
          timestamp: "2026-07-14T12:01:00.000Z",
        },
      },
    },
    "navigation.speedOverGround": {
      value: 2,
      $source: "gps.complete",
      timestamp: "2026-07-14T12:00:00.000Z",
      values: {
        "gps.complete": { value: 2, timestamp: "2026-07-14T12:00:00.000Z" },
      },
    },
    "navigation.courseOverGroundTrue": {
      value: 1,
      $source: "gps.complete",
      timestamp: "2026-07-14T12:00:00.000Z",
      values: {
        "gps.complete": { value: 1, timestamp: "2026-07-14T12:00:00.000Z" },
      },
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.source, "gps.position-only");
  assert.deepEqual(sample.position, { latitude: 56.21, longitude: -5.51 });
  assert.equal(sample.speedOverGround, undefined);
  assert.equal(sample.courseOverGroundTrue, undefined);
  assert.equal(sample.gnssProvenance.coherent, false);
});

test("explicit GNSS no-fix invalidates a cached position immediately", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.21122, longitude: -5.55756 },
      $source: "old-gps",
      timestamp: "2026-07-02T18:30:00.000Z",
    },
    "navigation.gnss.methodQuality": {
      value: "no GPS",
      $source: "old-gps",
      timestamp: "2026-07-02T18:30:03.000Z",
    },
    "navigation.gnss.satellites": {
      value: 0,
      $source: "old-gps",
      timestamp: "2026-07-02T18:30:03.000Z",
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });
  assert.deepEqual(sample.position, { latitude: 56.21122, longitude: -5.55756 });
  assert.equal(sample.methodQuality, "no GPS");
  assert.equal(sample.satellites, 0);
  assert.equal(sample.explicitGpsUnavailable, true);
  assert.equal(sample.fixValid, false);
});

test("explicit Navigation Reference no-fix remains visible without a position", () => {
  const timestamp = "2026-07-02T18:30:03.000Z";
  const paths = {
    "plugins.ajrmMarineNavigationReference.state": {
      value: {
        contract: "ajrm-marine-navigation-reference",
        schemaVersion: 1,
        updatedAt: timestamp,
        position: null,
        groundTrack: null,
        gnss: {
          source: "gps.one",
          sourceKind: "gnss",
          timestamp,
          ageMs: 0,
          gpsDependent: true,
          fixValid: false,
          explicitUnavailable: true,
          rejectionReason: "gnss-method-reports-no-valid-fix",
          methodQuality: "no GPS",
          satellites: 0,
          horizontalDilution: null,
          evidence: "same-source-gnss-quality",
        },
      },
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });

  assert.equal(sample.source, "gps.one");
  assert.equal(sample.position, undefined);
  assert.equal(sample.methodQuality, "no GPS");
  assert.equal(sample.satellites, 0);
  assert.equal(sample.explicitGpsUnavailable, true);
  assert.equal(sample.explicitGpsUnavailableTimestamp, timestamp);
  assert.equal(sample.fixValid, false);
});

test("reads preferred distance unit from Signal K metadata", () => {
  assert.equal(pluginFactory._private.preferredDistanceUnit({
    getMetadata(path) {
      if (path === "navigation.closestApproach.distance") {
        return { displayUnits: { targetUnit: "ft" } };
      }
      return null;
    },
  }), "ft");
  assert.equal(pluginFactory._private.preferredDistanceUnit({}), "nmi");
});

test("publishes normal GPS notification clear only once while state stays normal", async () => {
  const messages = [];
  const plugin = pluginFactory({
    getSelfPath(path) {
      const values = {
        "navigation.position": { value: { latitude: 56, longitude: -5 } },
        "navigation.speedOverGround": { value: 1 },
        "navigation.courseOverGroundTrue": { value: 1.2 },
        "navigation.gnss.horizontalDilution": { value: 0.8 },
        "navigation.gnss.satellites": { value: 9 },
      };
      return values[path];
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  plugin.start({ updateIntervalMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 560));
  plugin.stop();

  const notificationValues = messages
    .flatMap((message) =>
      message.updates.flatMap((update) => update.values || []),
    )
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");

  assert.equal(notificationValues.length, 2);
  assert.equal(notificationValues[0].value, null);
  assert.equal(notificationValues[1].value, null);
});

test("publishes explicit units metadata for trusted motion and dead-reckoning projections", () => {
  const messages = [];
  const plugin = pluginFactory({
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  plugin.start({ enabled: false });

  const metadataUpdate = messages
    .flatMap((message) => message.updates)
    .find((update) => Array.isArray(update.meta));
  assert.ok(metadataUpdate);
  assert.equal(Object.hasOwn(metadataUpdate, "values"), false);
  const metadata = Object.fromEntries(
    metadataUpdate.meta.map((entry) => [entry.path, entry.value]),
  );
  assert.equal(
    metadata["plugins.ajrmMarineGpsIntegrity.trusted.speedOverGround"].units,
    "m/s",
  );
  assert.equal(
    metadata[
      "plugins.ajrmMarineGpsIntegrity.trusted.courseOverGroundTrue"
    ].units,
    "rad",
  );
  assert.equal(
    metadata["plugins.ajrmMarineGpsIntegrity.trusted.headingTrue"].units,
    "rad",
  );
  assert.equal(
    metadata[
      "plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.uncertaintyRadiusMeters"
    ].units,
    "m",
  );
  assert.equal(
    metadata[
      "plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.realignIntervalSeconds"
    ].units,
    "s",
  );
});

test("publishes trusted GPS and dead-reckoning projection paths", async () => {
  const messages = [];
  const plugin = pluginFactory({
    getSelfPath(path) {
      const values = {
        "navigation.position": { value: { latitude: 56, longitude: -5 } },
        "navigation.speedOverGround": { value: 2 },
        "navigation.courseOverGroundTrue": { value: 1.2 },
        "navigation.headingTrue": { value: 1.1 },
        "navigation.gnss.horizontalDilution": { value: 0.8 },
        "navigation.gnss.satellites": { value: 9 },
      };
      return values[path];
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  plugin.start({ updateIntervalMs: 500 });
  plugin.stop();

  const values = valuesFromUpdate(messages.find((message) => {
    const updateValues = valuesFromUpdate(message);
    return updateValues["plugins.ajrmMarineGpsIntegrity.trusted.accepted"] === true;
  }));
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.trusted.accepted"], true);
  assert.deepEqual(values["plugins.ajrmMarineGpsIntegrity.trusted.position"], { latitude: 56, longitude: -5 });
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.trusted.speedOverGround"], 2);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.trusted.courseOverGroundTrue"], 1.2);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.trusted.headingTrue"], 1.1);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.trusted.source"], "gps");
  assert.deepEqual(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.position"], { latitude: 56, longitude: -5 });
  assert.deepEqual(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.position"], { latitude: 56, longitude: -5 });
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.source"], "gps-locked");
  assert.deepEqual(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.position"], { latitude: 56, longitude: -5 });
  assert.equal(
    values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.source"],
    "gps-realigned-no-independent-motion",
  );
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.assurance"], "unavailable");
  assert.equal(
    values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.comparisonAvailable"],
    false,
  );
  assert.equal(
    values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.gpsDependent"],
    true,
  );
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.realignIntervalSeconds"], 300);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.counters.evaluations"], 1);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.counters.acceptedFixes"], 1);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.counters.positionJumps"], 0);
});

test("settings route persists independent DR realign interval", async () => {
  let savedOptions = null;
  const plugin = pluginFactory({
    getSelfPath() {},
    handleMessage() {},
    savePluginOptions(options, callback) {
      savedOptions = options;
      callback();
    },
    setPluginStatus() {},
  });
  const routes = new Map();
  plugin.registerWithRouter({
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    put(path, handler) {
      routes.set(`PUT ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  });
  plugin.start({ updateIntervalMs: 500 });

  let statusCode = 200;
  let body = null;
  await routes.get("PUT /settings")(
    {
      body: {
        alertsEnabled: false,
        integrityDrRealignSeconds: 120,
      },
    },
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
  plugin.stop();

  assert.equal(statusCode, 200);
  assert.equal(body.alertsEnabled, false);
  assert.equal(body.integrityDrRealignSeconds, 120);
  assert.equal(savedOptions.alertsEnabled, false);
  assert.equal(savedOptions.integrityDrRealignSeconds, 120);
});

test("manual fix route publishes a trusted observed position and DR baseline", async () => {
  const messages = [];
  const plugin = pluginFactory({
    getSelfPath(path) {
      const values = {
        "navigation.position": { value: null },
        "navigation.speedOverGround": { value: 0.5 },
        "navigation.courseOverGroundTrue": { value: Math.PI / 2 },
        "navigation.headingTrue": { value: Math.PI / 2 },
        "navigation.speedThroughWater": { value: 0.4 },
      };
      return values[path];
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });
  const routes = new Map();
  plugin.registerWithRouter({
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    put(path, handler) {
      routes.set(`PUT ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  });

  plugin.start({ updateIntervalMs: 500 });
  const body = await routeJson(routes.get("POST /manual-fix"), {
    body: {
      position: { latitude: 56.21, longitude: -5.56 },
      timestamp: "2026-06-29T11:00:00.000Z",
      note: "visual bearings",
    },
  });
  plugin.stop();

  assert.equal(body.ok, true);
  assert.equal(body.state.acceptedManualFix, true);
  assert.equal(body.state.acceptedGps, false);
  assert.equal(body.state.lastTrustedFix.source, "manual-fix");
  assert.deepEqual(body.state.lastTrustedFix.position, { latitude: 56.21, longitude: -5.56 });
  assert.equal(body.state.lastTrustedFix.note, "visual bearings");

  const publishedValues = valuesFromUpdate(messages.find((message) => {
    const values = valuesFromUpdate(message);
    return values["plugins.ajrmMarineGpsIntegrity.trusted.source"] === "manual-fix";
  }));
  assert.equal(publishedValues["plugins.ajrmMarineGpsIntegrity.trusted.accepted"], true);
  assert.deepEqual(
    publishedValues["plugins.ajrmMarineGpsIntegrity.trusted.position"],
    { latitude: 56.21, longitude: -5.56 },
  );
  assert.equal(publishedValues["plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.source"], "manual-fix");
  assert.deepEqual(
    publishedValues["plugins.ajrmMarineGpsIntegrity.deadReckoning.operational.position"],
    { latitude: 56.21, longitude: -5.56 },
  );
});

test("reset route rebaselines runtime state to the current valid GPS fix", async () => {
  const messages = [];
  let position = { latitude: 56, longitude: -5 };
  let now = Date.parse("2026-06-24T12:00:00.000Z");
  const originalDate = global.Date;
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  FixedDate.parse = originalDate.parse;
  FixedDate.UTC = originalDate.UTC;
  global.Date = FixedDate;
  const plugin = pluginFactory({
    getSelfPath(path) {
      const values = {
        "navigation.position": { value: position, timestamp: new Date(now).toISOString() },
        "navigation.speedOverGround": { value: 2, timestamp: new Date(now).toISOString() },
        "navigation.courseOverGroundTrue": { value: 1.2, timestamp: new Date(now).toISOString() },
        "navigation.headingTrue": { value: 1.1, timestamp: new Date(now).toISOString() },
        "navigation.gnss.horizontalDilution": { value: 0.8 },
        "navigation.gnss.satellites": { value: 9 },
      };
      return values[path];
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });
  const routes = new Map();
  plugin.registerWithRouter({
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    put(path, handler) {
      routes.set(`PUT ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  });

  try {
    plugin.start({ updateIntervalMs: 500, maxBoatSpeedKnots: 20 });
    position = { latitude: 56.1, longitude: -5 };
    now += 1000;
    await new Promise((resolve) => setTimeout(resolve, 560));

    const suspect = await routeJson(routes.get("GET /status"));
    assert.equal(suspect.state.trust, "suspect");

    let body = null;
    await routes.get("POST /reset")(
      {},
      {
        status() {
          return this;
        },
        json(value) {
          body = value;
        },
      },
    );

    assert.equal(body.state.trust, "normal");
    assert.equal(body.state.acceptedGps, true);
    assert.deepEqual(body.state.lastTrustedFix.position, { latitude: 56.1, longitude: -5 });
  } finally {
    plugin.stop();
    global.Date = originalDate;
  }
});

test("clears trusted GPS projection when a jump is rejected", async () => {
  const messages = [];
  let position = { latitude: 56, longitude: -5 };
  let now = Date.parse("2026-06-24T12:00:00.000Z");
  const originalDate = global.Date;
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  FixedDate.parse = originalDate.parse;
  FixedDate.UTC = originalDate.UTC;
  global.Date = FixedDate;
  const plugin = pluginFactory({
    getSelfPath(path) {
      const values = {
        "navigation.position": { value: position },
        "navigation.speedOverGround": { value: 2 },
        "navigation.courseOverGroundTrue": { value: 1.2 },
        "navigation.headingTrue": { value: 1.1 },
        "navigation.gnss.horizontalDilution": { value: 0.8 },
        "navigation.gnss.satellites": { value: 9 },
      };
      return values[path];
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  try {
    plugin.start({ updateIntervalMs: 500, maxBoatSpeedKnots: 20 });
    position = { latitude: 56.1, longitude: -5 };
    now += 1000;
    await new Promise((resolve) => setTimeout(resolve, 560));
    plugin.stop();
  } finally {
    global.Date = originalDate;
  }

  const rejectedMessage = messages.find((message) => {
    const values = valuesFromUpdate(message);
    return values["plugins.ajrmMarineGpsIntegrity.trusted.accepted"] === false;
  });
  const rejectedValues = valuesFromUpdate(rejectedMessage);
  assert.equal(rejectedValues["plugins.ajrmMarineGpsIntegrity.trusted.position"], null);
  assert.equal(rejectedValues["plugins.ajrmMarineGpsIntegrity.trusted.source"], "rejected");
  assert.match(rejectedValues["plugins.ajrmMarineGpsIntegrity.trusted.rejectionReason"], /Position jump/);
  assert.equal(rejectedValues["plugins.ajrmMarineGpsIntegrity.counters.rejectedFixes"], 1);
  assert.equal(rejectedValues["plugins.ajrmMarineGpsIntegrity.counters.positionJumps"], 1);
  const drPosition = rejectedValues["plugins.ajrmMarineGpsIntegrity.deadReckoning.position"];
  assert.ok(Math.abs(drPosition.latitude - 56) < 0.00002);
  assert.ok(Math.abs(drPosition.longitude - -5) < 0.00004);
});

test("publishes continuous lost GPS as one stable active notification", async () => {
  const messages = [];
  const plugin = pluginFactory({
    getSelfPath(path) {
      if (path === "navigation.position") return { value: null };
      return undefined;
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  plugin.start({ updateIntervalMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 1120));
  plugin.stop();

  const notificationValues = messages
    .flatMap((message) =>
      message.updates.flatMap((update) => update.values || []),
    )
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");
  const alarms = notificationValues.filter((item) => item.value?.state === "alarm");

  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].value.data.ajrmMarineNotifications.delivery.preempt, false);
  assert.equal(alarms[0].value.data.ajrmMarineNotifications.priority.score, 750);
  assert.match(
    alarms[0].value.data.ajrmMarineNotifications.eventId,
    /^signalk-ajrm-marine-gps-integrity:lost:/,
  );
});

test("suppresses replay startup GPS loss until warm-up receives its first fix", async () => {
  const messages = [];
  const plugin = pluginFactory({
    getSelfPath(path) {
      if (path === "navigation.position") return { value: null };
      if (path === "plugins.ajrmMarineLogger.playback") {
        return {
          playing: true,
          warmupActive: true,
          voyageFileName: "voyage-sparse-gps.zip",
          sourceKind: "voyages",
          capturedAt: "2026-07-17T12:11:28.577Z",
          rate: 1,
        };
      }
      return undefined;
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  plugin.start({ updateIntervalMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 560));
  plugin.stop();

  const notificationValues = messages
    .flatMap((message) =>
      message.updates.flatMap((update) => update.values || []),
    )
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");
  assert.equal(
    notificationValues.some((item) => item.value?.state === "alarm"),
    false,
  );
});

test("suppresses GPS integrity notifications when alerts are disabled", async () => {
  const messages = [];
  const plugin = pluginFactory({
    getSelfPath(path) {
      if (path === "navigation.position") return { value: null };
      return undefined;
    },
    handleMessage(_pluginId, message) {
      messages.push(message);
    },
    setPluginStatus() {},
  });

  plugin.start({ updateIntervalMs: 500, alertsEnabled: false });
  await new Promise((resolve) => setTimeout(resolve, 560));
  plugin.stop();

  const notificationValues = messages
    .flatMap((message) =>
      message.updates.flatMap((update) => update.values || []),
    )
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");

  assert.ok(notificationValues.length > 0);
  assert.equal(notificationValues.some((item) => item.value?.state === "alarm"), false);
});

function valuesFromUpdate(message) {
  return Object.assign(
    {},
    ...message.updates
      .flatMap((update) => update.values || [])
      .map((item) => ({ [item.path]: item.value })),
  );
}

async function routeJson(handler, req = {}) {
  let body = null;
  await handler(req, {
    status() {
      return this;
    },
    json(value) {
      body = value;
    },
  });
  return body;
}
