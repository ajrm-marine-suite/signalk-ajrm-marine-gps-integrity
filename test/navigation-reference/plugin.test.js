"use strict";

const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");
const createPlugin = require("../../plugin/components/navigation-reference");

test("migrates the previous five-second defaults without overriding custom ages", () => {
  const migrated = createPlugin._private.migrateLegacyAgeDefaults({
    positionMaxAgeSeconds: 5,
    motionMaxAgeSeconds: 5,
    headingMaxAgeSeconds: 5,
  });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.options.positionMaxAgeSeconds, 30);
  assert.equal(migrated.options.motionMaxAgeSeconds, 30);
  assert.equal(migrated.options.aisFallbackMaxAgeSeconds, 45);
  assert.equal(migrated.options.trackProxyMaxAgeSeconds, 5);

  const custom = createPlugin._private.migrateLegacyAgeDefaults({
    positionMaxAgeSeconds: 12,
    motionMaxAgeSeconds: 8,
  });
  assert.equal(custom.changed, false);
  assert.equal(custom.options.positionMaxAgeSeconds, 12);
  assert.equal(custom.options.motionMaxAgeSeconds, 8);
});

test("plugin accepts the vessel's canonical self context and publishes v1 state", async () => {
  const signalk = new EventEmitter();
  const messages = [];
  const app = {
    selfId: "urn:mrn:imo:mmsi:235008635",
    signalk,
    handleMessage(source, delta) {
      messages.push({ source, delta });
    },
    setPluginStatus() {},
  };
  const plugin = createPlugin(app);
  plugin.start({
    updateIntervalMs: 10000,
    headingAcquireSeconds: 0,
    trackProxyAcquireSeconds: 0,
  });
  const timestamp = new Date().toISOString();
  signalk.emit("delta", {
    context: "vessels.urn:mrn:imo:mmsi:235008635",
    updates: [
      {
        "$source": "YDEN.43",
        timestamp,
        values: [
          {
            path: "navigation.position",
            value: { latitude: 55.8872512, longitude: -5.724038 },
          },
          { path: "navigation.courseOverGroundTrue", value: 1 },
          { path: "navigation.speedOverGround", value: 2 },
        ],
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  const published = messages
    .flatMap((message) => message.delta.updates || [])
    .flatMap((update) => update.values || [])
    .filter((entry) => entry.path === "plugins.ajrmMarineNavigationReference.state")
    .at(-1)?.value;

  assert.equal(published.contract, "ajrm-marine-navigation-reference");
  assert.equal(published.schemaVersion, 1);
  assert.equal(published.clockReference.kind, "track-proxy");
  assert.equal(published.groundTrack.source, "YDEN.43");
  plugin.stop();
});

test("bounded BITE override remains authoritative until explicitly cleared", async () => {
  const signalk = new EventEmitter();
  const messages = [];
  const app = {
    selfId: "urn:mrn:imo:mmsi:235008635",
    signalk,
    handleMessage(source, delta) {
      messages.push({ source, delta });
    },
    setPluginStatus() {},
  };
  const plugin = createPlugin(app);
  plugin.start({ updateIntervalMs: 10000 });
  const timestamp = new Date().toISOString();
  const override = {
    contract: "ajrm-marine-navigation-reference",
    schemaVersion: 1,
    updatedAt: timestamp,
    status: "heading",
    position: null,
    groundTrack: null,
    bowHeadingTrue: null,
    clockReference: {
      kind: "heading",
      value: Math.PI / 2,
      source: "ajrm-marine-bite",
      sourceKind: "synthetic-test",
      timestamp,
      ageMs: 0,
      method: "bite-explicit-heading",
      uncertaintyRad: 0,
      gpsDependent: false,
    },
    diagnostics: { syntheticBite: true },
  };

  app.ajrmMarineNavigationReferenceApi.setBiteOverride(override, { ttlMs: 1000 });
  signalk.emit("delta", {
    context: "vessels.self",
    updates: [{
      "$source": "gps.one",
      timestamp,
      values: [
        { path: "navigation.position", value: { latitude: 56, longitude: -5 } },
        { path: "navigation.courseOverGroundTrue", value: 0 },
        { path: "navigation.speedOverGround", value: 2 },
      ],
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const active = messages
    .flatMap((message) => message.delta.updates || [])
    .flatMap((update) => update.values || [])
    .filter((entry) => entry.path === "plugins.ajrmMarineNavigationReference.state")
    .at(-1)?.value;
  assert.equal(active.clockReference.kind, "heading");
  assert.equal(active.clockReference.source, "ajrm-marine-bite");
  assert.equal(app.ajrmMarineNavigationReferenceApi.status().biteOverrideActive, true);

  app.ajrmMarineNavigationReferenceApi.clearBiteOverride();
  const cleared = messages
    .flatMap((message) => message.delta.updates || [])
    .flatMap((update) => update.values || [])
    .filter((entry) => entry.path === "plugins.ajrmMarineNavigationReference.state")
    .at(-1)?.value;
  assert.notEqual(cleared.clockReference?.source, "ajrm-marine-bite");
  assert.equal(app.ajrmMarineNavigationReferenceApi.status().biteOverrideActive, false);
  plugin.stop();
});
