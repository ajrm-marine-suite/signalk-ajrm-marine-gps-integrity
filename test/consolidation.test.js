"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const createPlugin = require("../plugin");

test("combined package mounts Navigation Reference and DR Plotter", async () => {
  const routes = [];
  const signalk = new EventEmitter();
  const app = {
    selfId: "urn:mrn:imo:mmsi:999999999",
    signalk,
    getSelfPath() { return null; },
    handleMessage() {},
    setPluginStatus() {},
    subscriptionmanager: {
      subscribe(_request, unsubscribes) {
        unsubscribes.push(() => {});
      },
    },
  };
  const router = Object.fromEntries(
    ["get", "put", "post", "delete"].map((method) => [
      method,
      (route) => routes.push(`${method.toUpperCase()} ${route}`),
    ]),
  );
  const plugin = createPlugin(app);
  plugin.registerWithRouter(router);
  plugin.start({ enabled: false, drPlotter: { enabled: false } });

  assert.ok(routes.includes("GET /reference/status"));
  assert.ok(routes.includes("GET /plotter/status"));
  assert.ok(routes.includes("GET /plotter/plot-fixes"));
  assert.equal(typeof app.ajrmMarineNavigationReferenceApi?.setBiteOverride, "function");

  await plugin.stop();
  assert.equal(app.ajrmMarineNavigationReferenceApi, undefined);
});
