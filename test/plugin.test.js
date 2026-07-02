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
  assert.equal(sample.currentSetTrue, 1.57);
  assert.equal(sample.currentSetTrueTimestamp, "2026-06-22T12:00:00.500Z");
  assert.equal(sample.currentDrift, 0.6);
  assert.equal(sample.currentDriftTimestamp, "2026-06-22T12:00:00.600Z");
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

test("explicit GNSS no-fix invalidates a cached position immediately", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.21122, longitude: -5.55756 },
      $source: "old-gps",
      timestamp: "2026-07-02T18:30:00.000Z",
    },
    "navigation.gnss.methodQuality": {
      value: "no GPS",
      timestamp: "2026-07-02T18:30:03.000Z",
    },
    "navigation.gnss.satellites": {
      value: 0,
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
    .flatMap((message) => message.updates.flatMap((update) => update.values))
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");

  assert.equal(notificationValues.length, 2);
  assert.equal(notificationValues[0].value, null);
  assert.equal(notificationValues[1].value, null);
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
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.source"], "gps-realigned");
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
    .flatMap((message) => message.updates.flatMap((update) => update.values))
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");
  const alarms = notificationValues.filter((item) => item.value?.state === "alarm");

  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].value.data.ajrmMarineNotifications.delivery.preempt, false);
  assert.match(
    alarms[0].value.data.ajrmMarineNotifications.eventId,
    /^signalk-ajrm-marine-gps-integrity:lost:/,
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
    .flatMap((message) => message.updates.flatMap((update) => update.values))
    .filter((value) => value.path === "notifications.navigation.gnss.integrity");

  assert.ok(notificationValues.length > 0);
  assert.equal(notificationValues.some((item) => item.value?.state === "alarm"), false);
});

function valuesFromUpdate(message) {
  return Object.assign(
    {},
    ...message.updates.flatMap((update) => update.values).map((item) => ({ [item.path]: item.value })),
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
