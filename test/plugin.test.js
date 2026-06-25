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
  assert.equal(sample.hdop, 0.8);
  assert.equal(sample.satellites, 9);
});

test("chooses a coherent moving navigation source over canonical stationary values", () => {
  const paths = {
    "navigation.position": {
      value: { latitude: 56.211333, longitude: -5.559139 },
      $source: "vessel-simulator",
      timestamp: "2026-06-22T17:00:18.490Z",
      values: {
        "self-track-simulator": {
          value: { latitude: 56.211222, longitude: -5.550586 },
          timestamp: "2026-06-22T17:00:18.466Z",
        },
        "vessel-simulator": {
          value: { latitude: 56.211333, longitude: -5.559139 },
          timestamp: "2026-06-22T17:00:18.490Z",
        },
      },
    },
    "navigation.speedOverGround": {
      value: 0,
      $source: "vessel-simulator",
      timestamp: "2026-06-22T17:00:18.490Z",
      values: {
        "self-track-simulator": { value: 5.14444, timestamp: "2026-06-22T17:00:18.466Z" },
        "vessel-simulator": { value: 0, timestamp: "2026-06-22T17:00:18.490Z" },
      },
    },
    "navigation.courseOverGroundTrue": {
      value: 0,
      $source: "vessel-simulator",
      values: {
        "self-track-simulator": { value: Math.PI / 2, timestamp: "2026-06-22T17:00:18.466Z" },
        "vessel-simulator": { value: 0, timestamp: "2026-06-22T17:00:18.490Z" },
      },
    },
    "navigation.headingTrue": {
      value: Math.PI / 2,
      $source: "self-track-simulator",
      values: {
        "self-track-simulator": { value: Math.PI / 2, timestamp: "2026-06-22T17:00:18.466Z" },
        "vessel-simulator": { value: 0, timestamp: "2026-06-22T17:00:18.490Z" },
      },
    },
    "navigation.speedThroughWater": {
      value: 5.14444,
      $source: "self-track-simulator",
      timestamp: "2026-06-22T17:00:18.466Z",
    },
  };
  const sample = pluginFactory._private.sampleFromSignalK({
    getSelfPath(path) {
      return paths[path];
    },
  });
  assert.equal(sample.source, "self-track-simulator");
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
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.deadReckoning.integrity.realignIntervalSeconds"], 1800);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.counters.evaluations"], 1);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.counters.acceptedFixes"], 1);
  assert.equal(values["plugins.ajrmMarineGpsIntegrity.counters.positionJumps"], 0);
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

function valuesFromUpdate(message) {
  return Object.assign(
    {},
    ...message.updates.flatMap((update) => update.values).map((item) => ({ [item.path]: item.value })),
  );
}
