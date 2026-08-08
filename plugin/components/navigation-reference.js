/**
 * Implements the navigation reference responsibilities of the AJRM Marine Navigation Integrity Signal K server.
 */

"use strict";

const packageInfo = require("../../package.json");
const {
  STATE_PATH,
  createNavigationReferenceResolver,
} = require("../lib/navigation-reference");

const PLUGIN_ID = "signalk-ajrm-marine-navigation-reference";
const API_REGISTRY = Symbol.for("ajrmMarineNavigationReferenceApi");
const MAX_BITE_OVERRIDE_MS = 10000;

module.exports = function ajrmMarineNavigationReference(app, componentOptions = {}) {
  const plugin = {};
  let options = {};
  let resolver = null;
  let deltaListener = null;
  let publishTimer = null;
  let ageTimer = null;
  let lastState = null;
  let biteOverride = null;

  plugin.id = PLUGIN_ID;
  plugin.name = "AJRM Marine Navigation Reference";
  plugin.description =
    "Selects a source-aware own-vessel bow heading and ground track, calculates WMM magnetic variation, and exposes current/residual provenance.";

  plugin.schema = {
    type: "object",
    properties: {
      preferredGnssSources: sourceList(
        "Preferred GNSS sources",
        "Optional source IDs in priority order. A selected source must provide a coherent position, COG, and SOG set.",
      ),
      preferredTrueHeadingSources: sourceList(
        "Preferred direct true-heading sources",
        "Optional exact source IDs in priority order. Leave empty to choose automatically from available non-GNSS sensor sources. When set, only listed or explicitly independent sources are used. A preferred source remains GPS-dependent unless its exact ID is also declared independent.",
      ),
      independentTrueHeadingSources: sourceList(
        "Verified independent true-heading sources",
        "Exact source IDs whose true heading is verified to come from an independent calibrated compass. Also list the source under Preferred direct true-heading sources to set its priority. Do not list dual-antenna GNSS or calculated heading here.",
      ),
      preferredMagneticHeadingSources: sourceList(
        "Preferred magnetic-heading sources",
        "Optional exact magnetic-compass source IDs in priority order. Leave empty to choose automatically from available non-GNSS sensor sources. When set, only listed or explicitly independent sources are used.",
      ),
      independentMagneticHeadingSources: sourceList(
        "GNSS-associated magnetic-heading sources with independent compass evidence",
        "Optional exact source IDs whose magnetic heading is verified to come from an independent calibrated compass despite sharing a source with GNSS data. Also list each source under Preferred magnetic-heading sources. Do not list calculated magnetic heading here.",
      ),
      preferredSpeedThroughWaterSources: sourceList(
        "Preferred speed-through-water sources",
        "Optional water-speed source IDs in priority order. Leave empty to choose automatically from available sensor sources.",
      ),
      independentCurrentSources: sourceList(
        "Independent current sources",
        "Optional sensor source IDs allowed to provide an atomic set/drift vector. GPS-derived plugin current must not be listed.",
      ),
      independentLeewaySources: sourceList(
        "Independent leeway sources",
        "Optional source IDs allowed to provide explicit performance.leeway.",
      ),
      calculatedSources: sourceList(
        "Additional calculated source IDs",
        "Sources to exclude from direct sensor selection in addition to AJRM, Derived Data, route, and resource plugin defaults.",
      ),
      calculatedSourcePrefixes: sourceList(
        "Calculated source prefixes",
        "Source prefixes excluded from direct sensor selection.",
        ["signalk-ajrm-marine-"],
      ),
      allowGnssTrueHeading: {
        type: "boolean",
        title: "Allow true heading from the selected GNSS source",
        description:
          "Normally off because a GNSS course/heading value is not proof of bow heading. When enabled, only the currently selected coherent GNSS source is permitted, and it remains GPS-dependent unless its exact source is separately declared independent.",
        default: false,
      },
      positionMaxAgeSeconds: numberSetting(
        "Direct GNSS position usable age",
        30,
        1,
        300,
      ),
      motionMaxAgeSeconds: numberSetting(
        "Direct COG/SOG/STW usable age",
        30,
        1,
        300,
      ),
      aisFallbackMaxAgeSeconds: numberSetting(
        "Own-AIS fallback usable age",
        45,
        1,
        300,
      ),
      maxInputSkewSeconds: numberSetting(
        "Maximum same-source input skew",
        3,
        0,
        30,
      ),
      headingMaxAgeSeconds: numberSetting("Heading maximum age", 5, 1, 300),
      headingAcquireSeconds: numberSetting(
        "Compass acquisition stability time",
        2,
        0,
        30,
      ),
      gnssQualitySwitchMargin: {
        type: "number",
        title: "GNSS quality switch margin",
        description:
          "How much better another coherent GNSS source's same-source fix evidence must be before replacing the current source.",
        default: 5,
        minimum: 0,
        maximum: 100,
      },
      trackProxyMinimumSpeed: {
        type: "number",
        title: "COG clock-proxy acquire SOG (m/s)",
        description:
          "The COG proxy must be at or above this speed while acquiring. Default 0.5 m/s is about 1 knot.",
        default: 0.5,
        minimum: 0,
        maximum: 10,
      },
      trackProxyReleaseSpeed: {
        type: "number",
        title: "COG clock-proxy release SOG (m/s)",
        description:
          "An active COG proxy is released below this lower speed, preventing chatter near the acquire threshold. Values above the acquire speed are clamped to it.",
        default: 0.3,
        minimum: 0,
        maximum: 10,
      },
      trackProxyAcquireSeconds: numberSetting(
        "COG clock-proxy acquisition time (seconds)",
        2,
        0,
        30,
      ),
      trackProxyCogStabilityWindowSeconds: numberSetting(
        "COG stability window (seconds)",
        5,
        1,
        30,
      ),
      trackProxyMaxAgeSeconds: numberSetting(
        "COG clock-proxy maximum age",
        5,
        1,
        30,
      ),
      trackProxyMaximumTurnRateDegreesPerSecond: {
        type: "number",
        title: "Maximum stable COG turn rate (degrees/second)",
        description:
          "Rejects the clock proxy when recent COG changes or a fresh reported rate of turn exceed this limit.",
        default: 15,
        minimum: 0,
        maximum: 180,
      },
      magneticHeadingUncertaintyDegrees: {
        type: "number",
        title: "Magnetic compass uncertainty (degrees)",
        default: 5,
        minimum: 0,
        maximum: 45,
      },
      directHeadingUncertaintyDegrees: {
        type: "number",
        title: "Direct true-heading uncertainty (degrees)",
        default: 2,
        minimum: 0,
        maximum: 45,
      },
      unknownLeewayUncertaintyDegrees: {
        type: "number",
        title: "Unknown leeway allowance (degrees)",
        default: 5,
        minimum: 0,
        maximum: 45,
      },
      updateIntervalMs: {
        type: "integer",
        title: "Projection age refresh interval (ms)",
        default: 1000,
        minimum: 250,
        maximum: 10000,
      },
    },
  };

  plugin.start = (pluginOptions = {}) => {
    const migrated = migrateLegacyAgeDefaults(pluginOptions);
    options = {
      ...migrated.options,
      ownSource: PLUGIN_ID,
      selfContexts: [
        "vessels.self",
        normalizeSelfContext(app.selfId),
      ].filter(Boolean),
    };
    resolver = createNavigationReferenceResolver(options);
    if (!componentOptions.embedded && migrated.changed && typeof app.savePluginOptions === "function") {
      app.savePluginOptions(migrated.options, (error) => {
        if (error) {
          if (!componentOptions.embedded) app.setPluginError?.(
            `Could not persist 30-second GNSS age migration: ${error.message || error}`,
          );
        }
      });
    }
    deltaListener = (delta) => {
      if (!resolver) return;
      const accepted = resolver.ingestDelta(delta);
      if (accepted > 0) schedulePublish();
    };
    app.signalk?.on?.("delta", deltaListener);
    ageTimer = setInterval(publish, clampInterval(options.updateIntervalMs));
    ageTimer.unref?.();
    exposeApi();
    publish();
    if (!componentOptions.embedded) {
      app.setPluginStatus?.(`AJRM Marine Navigation Reference v${packageInfo.version} started`);
    }
  };

  plugin.stop = () => {
    if (deltaListener) app.signalk?.removeListener?.("delta", deltaListener);
    deltaListener = null;
    if (publishTimer) clearTimeout(publishTimer);
    if (ageTimer) clearInterval(ageTimer);
    publishTimer = null;
    ageTimer = null;
    biteOverride = null;
    resolver = null;
    lastState = null;
    if (app.ajrmMarineNavigationReferenceApi?.pluginId === PLUGIN_ID) {
      delete app.ajrmMarineNavigationReferenceApi;
    }
    if (globalThis[API_REGISTRY]?.pluginId === PLUGIN_ID) {
      delete globalThis[API_REGISTRY];
    }
    publishValue(null);
  };

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      res.json({
        ok: true,
        version: packageInfo.version,
        state: lastState,
        sources: resolver?.sourceSnapshot?.() || [],
      });
    });
  };

  return plugin;

  function schedulePublish() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      publish();
    }, 50);
  }

  function publish() {
    if (!resolver) return;
    const nowMs = Date.now();
    if (biteOverride && nowMs >= biteOverride.expiresAtMs) {
      biteOverride = null;
    }
    lastState = biteOverride?.value || resolver.resolve(nowMs);
    publishValue(lastState);
    const reference = lastState.clockReference;
    if (reference?.kind === "heading") {
      if (!componentOptions.embedded) app.setPluginStatus?.(
        `Bow heading from ${reference.source}; WMM ${formatDegrees(lastState.magneticVariation?.value)}`,
      );
    } else if (reference?.kind === "track-proxy") {
      if (!componentOptions.embedded) app.setPluginStatus?.(`COG track proxy from ${reference.source}; no fresh compass heading`);
    } else {
      if (!componentOptions.embedded) app.setPluginStatus?.("No reliable heading or moving COG reference");
    }
  }

  function exposeApi() {
    const api = {
      pluginId: PLUGIN_ID,
      version: packageInfo.version,
      setBiteOverride(value, { ttlMs = 5000 } = {}) {
        if (!validBiteOverride(value)) {
          throw new Error("Navigation Reference BITE override must be an explicit synthetic BITE v1 contract");
        }
        biteOverride = {
          value: JSON.parse(JSON.stringify(value)),
          expiresAtMs: Date.now() + Math.min(
            MAX_BITE_OVERRIDE_MS,
            Math.max(250, Number(ttlMs) || 5000),
          ),
        };
        publish();
        return { ok: true, expiresAt: new Date(biteOverride.expiresAtMs).toISOString() };
      },
      clearBiteOverride() {
        const cleared = Boolean(biteOverride);
        biteOverride = null;
        publish();
        return { ok: true, cleared };
      },
      status() {
        return {
          ok: true,
          version: packageInfo.version,
          biteOverrideActive: Boolean(biteOverride && Date.now() < biteOverride.expiresAtMs),
          state: lastState,
        };
      },
    };
    app.ajrmMarineNavigationReferenceApi = api;
    globalThis[API_REGISTRY] = api;
  }

  function publishValue(value) {
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date().toISOString(),
          values: [{ path: STATE_PATH, value }],
        },
      ],
    });
  }
};

function validBiteOverride(value) {
  return Boolean(
    value &&
    value.contract === "ajrm-marine-navigation-reference" &&
    value.schemaVersion === 1 &&
    value.diagnostics?.syntheticBite === true,
  );
}

function sourceList(title, description, defaultValue = []) {
  return {
    type: "array",
    title,
    description,
    default: defaultValue,
    items: { type: "string" },
  };
}

function numberSetting(title, defaultValue, minimum, maximum) {
  return {
    type: "number",
    title,
    default: defaultValue,
    minimum,
    maximum,
  };
}

function clampInterval(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(10000, Math.max(250, number)) : 1000;
}

function formatDegrees(value) {
  return Number.isFinite(value) ? `${((value * 180) / Math.PI).toFixed(2)}°` : "unavailable";
}

function normalizeSelfContext(selfId) {
  const value = String(selfId || "").trim();
  if (!value) return null;
  return value.startsWith("vessels.") ? value : `vessels.${value}`;
}

function migrateLegacyAgeDefaults(value = {}) {
  const options = { ...value };
  const legacyDefaults =
    Number(options.positionMaxAgeSeconds) === 5 &&
    Number(options.motionMaxAgeSeconds) === 5 &&
    options.aisFallbackMaxAgeSeconds == null &&
    options.trackProxyMaxAgeSeconds == null;
  if (!legacyDefaults) return { options, changed: false };
  return {
    changed: true,
    options: {
      ...options,
      positionMaxAgeSeconds: 30,
      motionMaxAgeSeconds: 30,
      aisFallbackMaxAgeSeconds: 45,
      trackProxyMaxAgeSeconds: 5,
    },
  };
}

module.exports._private = {
  migrateLegacyAgeDefaults,
};
