"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createNavigationReferenceResolver,
} = require("../../plugin/lib/navigation-reference");
const { createWmmCalculator } = require("../../plugin/lib/wmm");

const SECOND = 1000;

test("uses moving COG as an explicitly labelled proxy before a compass appears", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    trackProxyAcquireSeconds: 2,
  });
  const now = Date.parse("2026-07-16T09:04:30.000Z");
  ingestGnss(resolver, now, { course: Math.PI / 2, speed: 2 });

  let state = resolver.resolve(now);
  assert.equal(state.status, "unavailable");
  assert.equal(state.clockReference, null);
  assert.equal(state.diagnostics.trackProxy.reason, "acquiring-stable-track");

  ingestGnss(resolver, now + 2 * SECOND, {
    course: Math.PI / 2 + Math.PI / 180,
    speed: 2,
  });
  state = resolver.resolve(now + 2 * SECOND);
  assert.equal(state.status, "track-proxy");
  assert.equal(state.clockReference.kind, "track-proxy");
  assert.equal(state.clockReference.source, "YDEN.43");
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.groundTrack.coherent, true);
});

test("low-speed COG does not become a clock reference", () => {
  const resolver = resolverForTests({
    trackProxyAcquireSeconds: 0,
    trackProxyMinimumSpeed: 0.5,
    trackProxyReleaseSpeed: 0.3,
  });
  const now = Date.parse("2026-07-16T09:04:35.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 0.49 });

  const state = resolver.resolve(now);
  assert.ok(state.groundTrack);
  assert.equal(state.clockReference, null);
  assert.equal(state.diagnostics.trackProxy.reason, "below-acquire-speed");
});

test("COG proxy speed hysteresis suppresses threshold chatter", () => {
  const resolver = resolverForTests({
    trackProxyAcquireSeconds: 0,
    trackProxyMinimumSpeed: 0.5,
    trackProxyReleaseSpeed: 0.3,
  });
  const now = Date.parse("2026-07-16T09:04:40.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 0.6 });
  assert.equal(resolver.resolve(now).clockReference.kind, "track-proxy");

  ingestGnss(resolver, now + SECOND, { course: 1.01, speed: 0.4 });
  assert.equal(
    resolver.resolve(now + SECOND).clockReference.kind,
    "track-proxy",
  );

  ingestGnss(resolver, now + 2 * SECOND, { course: 1.02, speed: 0.29 });
  let state = resolver.resolve(now + 2 * SECOND);
  assert.equal(state.clockReference, null);
  assert.equal(state.diagnostics.trackProxy.reason, "below-release-speed");

  ingestGnss(resolver, now + 3 * SECOND, { course: 1.03, speed: 0.4 });
  state = resolver.resolve(now + 3 * SECOND);
  assert.equal(state.clockReference, null);
  assert.equal(state.diagnostics.trackProxy.reason, "below-acquire-speed");

  ingestGnss(resolver, now + 4 * SECOND, { course: 1.04, speed: 0.6 });
  assert.equal(
    resolver.resolve(now + 4 * SECOND).clockReference.kind,
    "track-proxy",
  );
});

test("implausibly unstable COG immediately releases the clock proxy", () => {
  const resolver = resolverForTests({
    trackProxyAcquireSeconds: 0,
    trackProxyMaximumTurnRateDegreesPerSecond: 15,
  });
  const now = Date.parse("2026-07-16T09:04:50.000Z");
  ingestGnss(resolver, now, { course: 0, speed: 2 });
  assert.equal(resolver.resolve(now).clockReference.kind, "track-proxy");

  ingestGnss(resolver, now + SECOND, { course: Math.PI, speed: 2 });
  const state = resolver.resolve(now + SECOND);
  assert.equal(state.clockReference, null);
  assert.equal(
    state.diagnostics.trackProxy.reason,
    "unstable-course-over-ground",
  );
});

test("COG stability handles the zero-degree wrap without a false release", () => {
  const resolver = resolverForTests({
    trackProxyAcquireSeconds: 1,
    trackProxyMaximumTurnRateDegreesPerSecond: 15,
  });
  const now = Date.parse("2026-07-16T09:04:53.000Z");
  ingestGnss(resolver, now, {
    course: (359 * Math.PI) / 180,
    speed: 2,
  });
  assert.equal(resolver.resolve(now).clockReference, null);

  ingestGnss(resolver, now + SECOND, {
    course: Math.PI / 180,
    speed: 2,
  });
  const state = resolver.resolve(now + SECOND);
  assert.equal(state.clockReference.kind, "track-proxy");
  assert.equal(state.diagnostics.trackProxy.reason, "qualified");
});

test("a fresh excessive rate of turn also rejects the COG clock proxy", () => {
  const resolver = resolverForTests({
    trackProxyAcquireSeconds: 0,
    trackProxyMaximumTurnRateDegreesPerSecond: 15,
  });
  const now = Date.parse("2026-07-16T09:04:55.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 2 });
  ingest(
    resolver,
    "turn-sensor",
    now,
    [{
      path: "navigation.rateOfTurn",
      value: (30 * Math.PI) / 180,
    }],
  );

  const state = resolver.resolve(now);
  assert.equal(state.clockReference, null);
  assert.equal(
    state.diagnostics.trackProxy.reason,
    "unstable-course-over-ground",
  );
  assert.equal(
    state.diagnostics.trackProxy.reportedTurnRateSource,
    "turn-sensor",
  );
});

test("converts TP32 magnetic heading with local WMM and expires it when stale", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    headingMaxAgeSeconds: 3,
    preferredMagneticHeadingSources: ["YDEN.4"],
  });
  const now = Date.parse("2026-07-16T09:05:00.000Z");
  ingestGnss(resolver, now, { course: Math.PI / 2, speed: 2 });
  ingest(
    resolver,
    "YDEN.4",
    now,
    [{ path: "navigation.headingMagnetic", value: 1 }],
  );

  let state = resolver.resolve(now);
  assert.equal(state.clockReference.kind, "heading");
  assert.equal(state.bowHeadingTrue.method, "magnetic-heading-plus-wmm");
  assert.equal(state.bowHeadingTrue.source, "YDEN.4");
  assert.ok(Math.abs(state.bowHeadingTrue.value - 1.02) < 1e-12);
  assert.equal(state.magneticVariation.model, "WMM 2025");

  state = resolver.resolve(now + 4 * SECOND);
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference.kind, "track-proxy");
});

test("rejects true heading from the selected GNSS unless explicitly allowed", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:06:00.000Z");
  ingestGnss(resolver, now, {
    course: 1,
    speed: 2,
    headingTrue: 2,
  });

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference.kind, "track-proxy");
  assert.equal(state.diagnostics.directTrueHeadingFromGnssRejected, true);
});

test("permitted GNSS-associated heading remains GPS-dependent", () => {
  const resolver = resolverForTests({
    allowGnssTrueHeading: true,
    headingAcquireSeconds: 0,
  });
  const now = Date.parse("2026-07-16T09:06:10.000Z");
  ingestGnss(resolver, now, {
    course: 1,
    speed: 2,
    headingTrue: 2,
  });

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue.value, 2);
  assert.equal(state.bowHeadingTrue.gpsDependent, true);
  assert.equal(state.clockReference.kind, "heading");
  assert.equal(state.clockReference.gpsDependent, true);
});

test("an explicitly independent integrated compass source is not GPS-dependent", () => {
  const resolver = resolverForTests({
    independentTrueHeadingSources: ["YDEN.43"],
    headingAcquireSeconds: 0,
  });
  const now = Date.parse("2026-07-16T09:06:12.000Z");
  ingestGnss(resolver, now, {
    course: 1,
    speed: 2,
    headingTrue: 2,
  });

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue.value, 2);
  assert.equal(state.bowHeadingTrue.gpsDependent, false);
});

test("rejects a declared calculated direct true-heading producer, including north", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    calculatedSources: ["unlisted-heading-calculator"],
  });
  const now = Date.parse("2026-07-16T09:06:13.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 2 });
  ingest(
    resolver,
    "unlisted-heading-calculator",
    now,
    [{ path: "navigation.headingTrue", value: 0 }],
  );

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference.kind, "track-proxy");
});

test("a preferred direct true-heading source remains GPS-dependent by default", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    preferredTrueHeadingSources: ["verified-source-id"],
    independentLeewaySources: ["leeway-sensor"],
  });
  const now = Date.parse("2026-07-16T09:06:14.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 2 });
  ingest(
    resolver,
    "verified-source-id",
    now,
    [{ path: "navigation.headingTrue", value: 0 }],
  );
  ingest(
    resolver,
    "leeway-sensor",
    now,
    [{ path: "performance.leeway", value: 0.1 }],
  );

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue.value, 0);
  assert.equal(state.bowHeadingTrue.gpsDependent, true);
  assert.equal(state.throughWater.trackTrue.gpsDependent, true);
});

test("rejects true heading from an alternate GNSS source unless explicitly allowed", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:06:15.000Z");
  ingest(
    resolver,
    "YDEN.primary",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88722, longitude: -5.72406 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1 },
      { path: "navigation.speedOverGround", value: 2 },
      { path: "navigation.gnss.satellites", value: 20 },
    ],
  );
  ingest(
    resolver,
    "YDEN.alternate",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88723, longitude: -5.72405 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.1 },
      { path: "navigation.speedOverGround", value: 2.1 },
      { path: "navigation.gnss.satellites", value: 5 },
      { path: "navigation.headingTrue", value: 2 },
    ],
  );

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack.source, "YDEN.primary");
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference.kind, "track-proxy");
  assert.equal(state.diagnostics.directTrueHeadingFromGnssRejected, true);
});

test("allowing selected-GNSS heading does not permit an alternate GNSS source", () => {
  const resolver = resolverForTests({
    allowGnssTrueHeading: true,
    headingAcquireSeconds: 0,
  });
  const now = Date.parse("2026-07-16T09:06:16.000Z");
  ingest(
    resolver,
    "YDEN.primary",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88722, longitude: -5.72406 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1 },
      { path: "navigation.speedOverGround", value: 2 },
      { path: "navigation.gnss.satellites", value: 20 },
    ],
  );
  ingest(
    resolver,
    "YDEN.alternate",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88723, longitude: -5.72405 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.1 },
      { path: "navigation.speedOverGround", value: 2.1 },
      { path: "navigation.gnss.satellites", value: 5 },
      { path: "navigation.headingTrue", value: 2 },
    ],
  );

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack.source, "YDEN.primary");
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference.kind, "track-proxy");
  assert.equal(state.diagnostics.directTrueHeadingFromGnssRejected, true);
});

test("selects stronger same-source GNSS fix evidence instead of newest arrival", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:06:30.000Z");
  ingest(
    resolver,
    "YDEN.2",
    now - 200,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88722, longitude: -5.72406 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.1 },
      { path: "navigation.speedOverGround", value: 2.1 },
      { path: "navigation.gnss.methodQuality", value: "GNSS Fix" },
      { path: "navigation.gnss.satellites", value: 20 },
      { path: "navigation.gnss.horizontalDilution", value: 0.61 },
      {
        path: "navigation.gnss.type",
        value: "GPS+SBAS/WAAS+GLONASS",
      },
    ],
  );
  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88725, longitude: -5.72403 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.2 },
      { path: "navigation.speedOverGround", value: 2.2 },
      { path: "navigation.gnss.methodQuality", value: "GNSS Fix" },
    ],
  );

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack.source, "YDEN.2");
  assert.equal(state.groundTrack.quality.satellites, 20);
  assert.equal(state.groundTrack.quality.horizontalDilution, 0.61);
  assert.equal(
    state.diagnostics.selectedGnssQuality.evidence,
    "same-source-gnss-quality",
  );
});

test("explicit GNSS preference overrides automatic quality scoring", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    preferredGnssSources: ["YDEN.43"],
  });
  const now = Date.parse("2026-07-16T09:06:45.000Z");
  for (const [source, satellites] of [["YDEN.2", 20], ["YDEN.43", 5]]) {
    ingest(
      resolver,
      source,
      now,
      [
        {
          path: "navigation.position",
          value: { latitude: 55.88722, longitude: -5.72406 },
        },
        { path: "navigation.courseOverGroundTrue", value: 1.1 },
        { path: "navigation.speedOverGround", value: 2.1 },
        { path: "navigation.gnss.methodQuality", value: "GNSS Fix" },
        { path: "navigation.gnss.satellites", value: satellites },
      ],
    );
  }

  assert.equal(resolver.resolve(now).groundTrack.source, "YDEN.43");
});

test("keeps direct GNSS ahead of an own-MMSI AIS self-report from the same interface", () => {
  const ownContext = "vessels.urn:mrn:imo:mmsi:235008635";
  const resolver = resolverForTests({ selfContexts: [ownContext] });
  const now = Date.parse("2026-07-16T09:09:32.000Z");
  const directPosition = { latitude: 55.8805248, longitude: -5.7230836 };
  const aisPosition = { latitude: 55.880992, longitude: -5.723146 };

  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      { path: "navigation.position", value: directPosition },
      { path: "navigation.courseOverGroundTrue", value: 3.1 },
      { path: "navigation.speedOverGround", value: 2.4 },
    ],
    { context: ownContext, pgn: 129025 },
  );
  ingest(
    resolver,
    "YDEN.43",
    now + 100,
    [
      { path: "navigation.position", value: aisPosition },
      { path: "navigation.courseOverGroundTrue", value: 3.05 },
      { path: "navigation.speedOverGround", value: 2.41 },
    ],
    { context: ownContext, pgn: 129039 },
  );

  const state = resolver.resolve(now + 100);
  assert.deepEqual(state.position.value, directPosition);
  assert.equal(state.position.method, "coherent-gnss-position");
  assert.equal(state.groundTrack.fallbackKind, null);
});

test("uses an own-MMSI AIS self-report only after direct GNSS becomes stale", () => {
  const ownContext = "vessels.urn:mrn:imo:mmsi:235008635";
  const resolver = resolverForTests({
    selfContexts: [ownContext],
    positionMaxAgeSeconds: 5,
    motionMaxAgeSeconds: 5,
  });
  const now = Date.parse("2026-07-16T09:09:32.000Z");
  const aisPosition = { latitude: 55.880992, longitude: -5.723146 };

  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.8805248, longitude: -5.7230836 },
      },
      { path: "navigation.courseOverGroundTrue", value: 3.1 },
      { path: "navigation.speedOverGround", value: 2.4 },
    ],
    { context: ownContext, pgn: 129029 },
  );
  ingest(
    resolver,
    "YDEN.43",
    now + 6000,
    [
      { path: "navigation.position", value: aisPosition },
      { path: "navigation.courseOverGroundTrue", value: 3.05 },
      { path: "navigation.speedOverGround", value: 2.41 },
    ],
    { context: ownContext, pgn: 129039 },
  );

  const state = resolver.resolve(now + 6000);
  assert.deepEqual(state.position.value, aisPosition);
  assert.equal(state.position.method, "ais-self-report-position-fallback");
  assert.equal(state.groundTrack.fallbackKind, "ais-self-report");
});

test("retains sparse direct GNSS for 30 seconds without retaining stale COG as a clock proxy", () => {
  const resolver = resolverForTests();
  const now = Date.parse("2026-07-16T09:09:40.000Z");
  ingestGnss(resolver, now, { course: Math.PI / 2, speed: 3 });

  const delayed = resolver.resolve(now + 24 * SECOND);
  assert.equal(delayed.position.ageMs, 24 * SECOND);
  assert.equal(delayed.groundTrack.ageMs, 24 * SECOND);
  assert.equal(delayed.clockReference, null);
  assert.equal(
    delayed.diagnostics.trackProxy.reason,
    "ground-track-stale",
  );

  const expired = resolver.resolve(now + 31 * SECOND);
  assert.equal(expired.position, null);
  assert.equal(expired.groundTrack, null);
});

test("keeps own-AIS fallback available for a Class B-sized reporting gap", () => {
  const ownContext = "vessels.urn:mrn:imo:mmsi:235008635";
  const resolver = resolverForTests({ selfContexts: [ownContext] });
  const now = Date.parse("2026-07-16T09:10:00.000Z");
  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88, longitude: -5.72 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.2 },
      { path: "navigation.speedOverGround", value: 2.4 },
    ],
    { context: ownContext, pgn: 129029 },
  );
  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.881, longitude: -5.721 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.1 },
      { path: "navigation.speedOverGround", value: 2.3 },
    ],
    { context: ownContext, pgn: 129039 },
  );

  const state = resolver.resolve(now + 40 * SECOND);
  assert.equal(state.position.method, "ais-self-report-position-fallback");
  assert.equal(state.groundTrack.fallbackKind, "ais-self-report");
  assert.equal(state.position.ageMs, 40 * SECOND);
});

test("rejects a fresh same-source GNSS triplet when its timestamps are incoherent", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    maxInputSkewSeconds: 3,
  });
  const now = Date.parse("2026-07-16T09:06:50.000Z");
  ingest(
    resolver,
    "YDEN.43",
    now - 4000,
    [{
      path: "navigation.position",
      value: { latitude: 55.88722, longitude: -5.72406 },
    }],
  );
  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      { path: "navigation.courseOverGroundTrue", value: 1.1 },
      { path: "navigation.speedOverGround", value: 2.1 },
    ],
  );

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack, null);
  assert.equal(state.clockReference, null);
});

test("rejects GNSS motion when the same source explicitly reports no fix", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:06:55.000Z");
  ingest(
    resolver,
    "YDEN.43",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88722, longitude: -5.72406 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1.1 },
      { path: "navigation.speedOverGround", value: 2.1 },
      { path: "navigation.gnss.methodQuality", value: "No fix" },
    ],
  );

  const state = resolver.resolve(now);
  assert.equal(state.position, null);
  assert.equal(state.groundTrack, null);
  assert.equal(state.clockReference, null);
  assert.equal(state.gnss.source, "YDEN.43");
  assert.equal(state.gnss.fixValid, false);
  assert.equal(state.gnss.explicitUnavailable, true);
  assert.equal(state.gnss.methodQuality, "No fix");
  assert.equal(state.gnss.rejectionReason, "gnss-method-reports-no-valid-fix");
});

test("rejects a preferred GNSS source that explicitly reports zero satellites", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    preferredGnssSources: ["YDEN.zero"],
  });
  const now = Date.parse("2026-07-16T09:06:56.000Z");
  for (const [source, satellites] of [["YDEN.zero", 0], ["YDEN.healthy", 12]]) {
    ingest(
      resolver,
      source,
      now,
      [
        {
          path: "navigation.position",
          value: { latitude: 55.88722, longitude: -5.72406 },
        },
        { path: "navigation.courseOverGroundTrue", value: 1.1 },
        { path: "navigation.speedOverGround", value: 2.1 },
        { path: "navigation.gnss.satellites", value: satellites },
      ],
    );
  }

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack.source, "YDEN.healthy");
  assert.equal(state.groundTrack.quality.satellites, 12);
});

test("keeps live position separate from the longer-lived WMM model position", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    positionMaxAgeSeconds: 5,
    preferredMagneticHeadingSources: ["YDEN.4"],
    variationPositionMaxAgeSeconds: 3600,
  });
  const now = Date.parse("2026-07-16T09:06:58.000Z");
  ingest(
    resolver,
    "YDEN.43",
    now,
    [{
      path: "navigation.position",
      value: { latitude: 55.88722, longitude: -5.72406 },
    }],
  );

  let state = resolver.resolve(now);
  assert.equal(state.position.method, "selected-gnss-position");
  assert.equal(state.groundTrack, null);

  ingest(
    resolver,
    "YDEN.4",
    now + 10 * SECOND,
    [{ path: "navigation.headingMagnetic", value: 1 }],
  );
  state = resolver.resolve(now + 10 * SECOND);
  assert.equal(state.position, null);
  assert.equal(state.bowHeadingTrue.method, "magnetic-heading-plus-wmm");
  assert.equal(state.magneticVariation.positionSource, "YDEN.43");
});

test("retains the last valid position for WMM when GNSS reports no fix", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    variationPositionMaxAgeSeconds: 3600,
  });
  const now = Date.parse("2026-08-08T10:42:35.000Z");
  ingest(
    resolver,
    "YDEN.2",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 56.21523, longitude: -5.56059 },
      },
      { path: "navigation.courseOverGroundTrue", value: 4.71 },
      { path: "navigation.speedOverGround", value: 3.93 },
      { path: "navigation.gnss.methodQuality", value: "GNSS fix" },
    ],
  );

  ingest(
    resolver,
    "YDEN.2",
    now + SECOND,
    [{ path: "navigation.gnss.methodQuality", value: "No fix" }],
  );
  ingest(
    resolver,
    "YDEN.4",
    now + SECOND,
    [{ path: "navigation.headingMagnetic", value: 4.709 }],
  );
  ingest(
    resolver,
    "YDEN.35",
    now + SECOND,
    [{ path: "navigation.speedThroughWater", value: 5.14444 }],
  );

  const state = resolver.resolve(now + SECOND);
  assert.equal(state.position, null);
  assert.equal(state.groundTrack, null);
  assert.equal(state.gnss.fixValid, false);
  assert.equal(state.bowHeadingTrue.source, "YDEN.4");
  assert.equal(state.bowHeadingTrue.method, "magnetic-heading-plus-wmm");
  assert.equal(state.magneticVariation.positionSource, "YDEN.2");
  assert.equal(state.throughWater.speedThroughWater.source, "YDEN.35");
  assert.equal(state.throughWater.headingTrue.source, "YDEN.4");
});

test("a separate direct true compass outranks magnetic conversion", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    preferredMagneticHeadingSources: ["YDEN.4"],
    preferredTrueHeadingSources: ["can0.calibrated-compass"],
    independentTrueHeadingSources: ["can0.calibrated-compass"],
  });
  const now = Date.parse("2026-07-16T09:07:00.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 2 });
  ingest(
    resolver,
    "YDEN.4",
    now,
    [{ path: "navigation.headingMagnetic", value: 1 }],
  );
  ingest(
    resolver,
    "can0.calibrated-compass",
    now,
    [{ path: "navigation.headingTrue", value: 2 }],
  );

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue.value, 2);
  assert.equal(state.bowHeadingTrue.source, "can0.calibrated-compass");
  assert.equal(state.bowHeadingTrue.method, "direct-true-heading");
});

test("rejects a declared calculated magnetic-heading producer", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    calculatedSources: ["unlisted-magnetic-calculator"],
  });
  const now = Date.parse("2026-07-16T09:07:30.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 2 });
  ingest(
    resolver,
    "unlisted-magnetic-calculator",
    now,
    [{ path: "navigation.headingMagnetic", value: 0 }],
  );

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference.kind, "track-proxy");
});

test("preferred GNSS-associated magnetic heading remains GPS-dependent", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    preferredMagneticHeadingSources: ["YDEN.integrated"],
  });
  const now = Date.parse("2026-07-16T09:07:31.000Z");
  ingest(
    resolver,
    "YDEN.integrated",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88722, longitude: -5.72406 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1 },
      { path: "navigation.speedOverGround", value: 2 },
      { path: "navigation.headingMagnetic", value: 0 },
    ],
  );

  const state = resolver.resolve(now);
  assert.ok(Math.abs(state.bowHeadingTrue.value - 0.02) < 1e-12);
  assert.equal(state.bowHeadingTrue.gpsDependent, true);
  assert.equal(state.clockReference.gpsDependent, true);
});

test("verified independent magnetic heading is not GPS-dependent", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    preferredMagneticHeadingSources: ["YDEN.integrated"],
    independentMagneticHeadingSources: ["YDEN.integrated"],
  });
  const now = Date.parse("2026-07-16T09:07:32.000Z");
  ingest(
    resolver,
    "YDEN.integrated",
    now,
    [
      {
        path: "navigation.position",
        value: { latitude: 55.88722, longitude: -5.72406 },
      },
      { path: "navigation.courseOverGroundTrue", value: 1 },
      { path: "navigation.speedOverGround", value: 2 },
      { path: "navigation.headingMagnetic", value: 0 },
    ],
  );

  const state = resolver.resolve(now);
  assert.ok(Math.abs(state.bowHeadingTrue.value - 0.02) < 1e-12);
  assert.equal(state.bowHeadingTrue.gpsDependent, false);
  assert.equal(state.clockReference.gpsDependent, false);
});

test("plugin heading and current sources are not treated as sensors", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:08:00.000Z");
  ingestGnss(resolver, now, { course: 1, speed: 2 });
  ingest(
    resolver,
    "derived-data",
    now,
    [
      { path: "navigation.headingTrue", value: 2 },
      { path: "environment.current.setTrue", value: 1 },
      { path: "environment.current.drift", value: 0.5 },
    ],
  );

  const state = resolver.resolve(now);
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.current, null);
  assert.deepEqual(state.diagnostics.calculatedSourcesIgnored, ["derived-data"]);
});

test("update-local source label outranks a conflicting delta-level source", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:08:15.000Z");
  resolver.ingestDelta(
    {
      context: "vessels.self",
      "$source": "YDEN.physical-gateway",
      updates: [{
        source: { label: "derived-data" },
        timestamp: new Date(now).toISOString(),
        values: [
          {
            path: "navigation.position",
            value: { latitude: 55.8872512, longitude: -5.724038 },
          },
          { path: "navigation.courseOverGroundTrue", value: 1 },
          { path: "navigation.speedOverGround", value: 2 },
        ],
      }],
    },
    now,
  );

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack, null);
  assert.equal(state.clockReference, null);
  assert.deepEqual(state.diagnostics.calculatedSourcesIgnored, ["derived-data"]);
});

test("navigation values without an explicit source are not treated as sensors", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const now = Date.parse("2026-07-16T09:08:30.000Z");
  resolver.ingestDelta(
    {
      context: "vessels.self",
      updates: [{
        timestamp: new Date(now).toISOString(),
        values: [
          {
            path: "navigation.position",
            value: { latitude: 55.8872512, longitude: -5.724038 },
          },
          { path: "navigation.courseOverGroundTrue", value: 1 },
          { path: "navigation.speedOverGround", value: 2 },
          { path: "navigation.headingTrue", value: 2 },
        ],
      }],
    },
    now,
  );

  const state = resolver.resolve(now);
  assert.equal(state.groundTrack, null);
  assert.equal(state.bowHeadingTrue, null);
  assert.equal(state.clockReference, null);
  assert.equal(state.diagnostics.sourceCount, 0);
});

test("ground-minus-water residual uses nautical flow-to direction", () => {
  const resolver = resolverForTests({
    headingAcquireSeconds: 0,
    independentLeewaySources: ["leeway-sensor"],
    independentTrueHeadingSources: ["compass"],
    maxInputSkewSeconds: 5,
    magneticHeadingUncertaintyDegrees: 0,
    preferredTrueHeadingSources: ["compass"],
    unknownLeewayUncertaintyDegrees: 0,
  });
  const now = Date.parse("2026-07-16T09:09:00.000Z");
  ingestGnss(resolver, now, { course: Math.PI / 2, speed: 5 });
  ingest(
    resolver,
    "compass",
    now,
    [{ path: "navigation.headingTrue", value: 0 }],
  );
  ingest(
    resolver,
    "water-speed",
    now,
    [{ path: "navigation.speedThroughWater", value: 2.5 }],
  );
  ingest(
    resolver,
    "leeway-sensor",
    now,
    [{ path: "performance.leeway", value: 0 }],
  );

  const state = resolver.resolve(now);
  assert.ok(state.residual);
  assert.equal(Math.round((state.residual.setTrue * 180) / Math.PI * 10) / 10, 116.6);
  assert.equal(state.residual.origin, "ground-minus-water-residual");
  assert.equal(state.residual.gpsDependent, true);
  assert.equal(state.residual.leewayStatus, "known");
  assert.equal(
    state.residual.source,
    "YDEN.43+water-speed+compass+leeway-sensor",
  );
});

test("preserves original voyage time from the explicit Capture playback clock", () => {
  const resolver = resolverForTests({ headingAcquireSeconds: 0 });
  const wallNow = Date.parse("2026-07-27T12:00:00.000Z");
  ingest(
    resolver,
    "signalk-ajrm-marine-capture",
    wallNow,
    [
      {
        path: "plugins.ajrmMarineCapture.playback",
        value: {
          active: true,
          capturedAt: "2026-07-16T09:04:23.166Z",
          replayMode: "sensor-only",
          voyageFileName: "voyage-20260716T090451Z.zip",
          rate: 1,
        },
      },
    ],
  );
  ingestGnss(resolver, wallNow, { course: 1, speed: 2 });

  const state = resolver.resolve(wallNow);
  assert.equal(
    state.groundTrack.courseTrue.originalTimestamp,
    "2026-07-16T09:04:23.166Z",
  );
  assert.equal(state.replay.active, true);
  assert.equal(state.replay.mode, "sensor-only");
});

test("WMM 2025 matches the 16 July voyage position", () => {
  const result = createWmmCalculator()(
    { latitude: 55.8872512, longitude: -5.724038 },
    "2026-07-16T09:04:23.166Z",
  );
  const degrees = (result.value * 180) / Math.PI;
  assert.ok(Math.abs(degrees - -1.36745) < 0.01);
  assert.equal(result.model, "WMM 2025");
  assert.equal(result.epochDate, "2026-07-16");
});

function resolverForTests(options = {}) {
  return createNavigationReferenceResolver({
    trackProxyAcquireSeconds: 0,
    variationCalculator: () => ({
      value: 0.02,
      model: "WMM 2025",
      epochDate: "2026-07-16",
      uncertaintyRad: 0,
    }),
    ...options,
  });
}

function ingestGnss(resolver, now, {
  course,
  speed,
  headingTrue,
}) {
  const values = [
    {
      path: "navigation.position",
      value: { latitude: 55.8872512, longitude: -5.724038 },
    },
    { path: "navigation.courseOverGroundTrue", value: course },
    { path: "navigation.speedOverGround", value: speed },
  ];
  if (Number.isFinite(headingTrue)) {
    values.push({ path: "navigation.headingTrue", value: headingTrue });
  }
  ingest(resolver, "YDEN.43", now, values);
}

function ingest(
  resolver,
  source,
  now,
  values,
  { context = "vessels.self", pgn = null } = {},
) {
  resolver.ingestDelta(
    {
      context,
      updates: [
        {
          "$source": source,
          source: Number.isInteger(pgn)
            ? {
                label: source.split(".")[0],
                type: "NMEA2000",
                pgn,
              }
            : undefined,
          timestamp: new Date(now).toISOString(),
          values,
        },
      ],
    },
    now,
  );
}
