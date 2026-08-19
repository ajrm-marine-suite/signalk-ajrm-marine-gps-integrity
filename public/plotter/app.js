/**
 * Implements the app responsibilities of the AJRM Marine Navigation Integrity browser application.
 */

import * as MapCore from "./ajrm-map-core.mjs?v=0.7.9";

const apiBase = "/plugins/signalk-ajrm-marine-gps-integrity/plotter";
const gpsIntegrityApiBase = "/plugins/signalk-ajrm-marine-gps-integrity";
const navigationReferenceContract = "ajrm-marine-navigation-reference";
const navigationReferenceSchemaVersion = 1;
const elements = {
  map: document.querySelector("#map"),
  subtitle: document.querySelector("#subtitle"),
  toggleStatus: document.querySelector("#toggleStatus"),
  toggleCharts: document.querySelector("#toggleCharts"),
  centreOwnship: document.querySelector("#centreOwnship"),
  plotNow: document.querySelector("#plotNow"),
  gpsStatusIndicator: document.querySelector("#gpsStatusIndicator"),
  gpsStatusText: document.querySelector("#gpsStatusText"),
  chartCycleStatus: document.querySelector("#chartCycleStatus"),
  statusDrawer: document.querySelector("#statusDrawer"),
  chartDrawer: document.querySelector("#chartDrawer"),
  statusLine: document.querySelector("#statusLine"),
  trustBadge: document.querySelector("#trustBadge"),
  warningText: document.querySelector("#warningText"),
  referenceKind: document.querySelector("#referenceKind"),
  referenceSource: document.querySelector("#referenceSource"),
  referenceAge: document.querySelector("#referenceAge"),
  referenceUncertainty: document.querySelector("#referenceUncertainty"),
  referenceDependency: document.querySelector("#referenceDependency"),
  fixAge: document.querySelector("#fixAge"),
  uncertainty: document.querySelector("#uncertainty"),
  drSource: document.querySelector("#drSource"),
  drDependency: document.querySelector("#drDependency"),
  drLeeway: document.querySelector("#drLeeway"),
  drCurrentOrigin: document.querySelector("#drCurrentOrigin"),
  drProvenance: document.querySelector("#drProvenance"),
  integritySource: document.querySelector("#integritySource"),
  integrityAssurance: document.querySelector("#integrityAssurance"),
  integrityComparison: document.querySelector("#integrityComparison"),
  integrityReason: document.querySelector("#integrityReason"),
  integrityAge: document.querySelector("#integrityAge"),
  integrityUncertainty: document.querySelector("#integrityUncertainty"),
  integrityDependency: document.querySelector("#integrityDependency"),
  integrityLeeway: document.querySelector("#integrityLeeway"),
  integrityCurrentOrigin: document.querySelector("#integrityCurrentOrigin"),
  integrityProvenance: document.querySelector("#integrityProvenance"),
  hdop: document.querySelector("#hdop"),
  coordinateFormat: document.querySelector("#coordinateFormat"),
  mapFollowLookAhead: document.querySelector("#mapFollowLookAhead"),
  mapFollowLookAheadValue: document.querySelector("#mapFollowLookAheadValue"),
  plotInterval: document.querySelector("#plotInterval"),
  plotNowDrawer: document.querySelector("#plotNowDrawer"),
  clearPlots: document.querySelector("#clearPlots"),
  clearAllPlots: document.querySelector("#clearAllPlots"),
  manualFixLatitude: document.querySelector("#manualFixLatitude"),
  manualFixLongitude: document.querySelector("#manualFixLongitude"),
  manualFixNote: document.querySelector("#manualFixNote"),
  pickManualFixFromCursor: document.querySelector("#pickManualFixFromCursor"),
  applyManualFix: document.querySelector("#applyManualFix"),
  prunePlotFixesAge: document.querySelector("#prunePlotFixesAge"),
  prunePlotFixes: document.querySelector("#prunePlotFixes"),
  plotStatus: document.querySelector("#plotStatus"),
  chartStatus: document.querySelector("#chartStatus"),
  baseMapChoices: [...document.querySelectorAll('input[name="baseMap"]')],
  autoCharts: document.querySelector("#checkAutoCharts"),
  openSeaMap: document.querySelector("#checkOpenSeaMap"),
  toast: document.querySelector("#toast"),
  cursorPosition: document.querySelector("#cursorPosition"),
};

let map;
let baseLayers = {};
let currentBaseLayer;
let autoChartGroup;
let autoChartLayer;
let autoChartFallbackLayer;
let autoChartId;
let autoChartList = [];
let chartCycle = null;
let mapActionToolbar = null;
let chartResourcesLoaded = false;
let chartResourcesLoading = null;
let seamarkLayer;
let routeLayer;
let trackLayer;
let plotFixLayer;
let overlayLayer;
let latestStatus = null;
let mapFollowSelf = true;
let disableMapFollowPause = false;
let operationalTrack = [];
let plotFixes = [];
let plotFixesLoaded = false;
let plotFixSavePending = false;
let lastPlotFixesUpdatedAt = null;
let lastOperationalTrackUpdatedAt = null;
let coordinateFormat = "dms";
let coordinateFormatOverride = normalizeCoordinateFormat(
  localStorage.getItem("ajrmMarineDrPlotterCoordinateFormat"),
  null,
);
let lastCursorEvent = null;
let manualFixPickMode = false;
let activeRouteSignature = "none";
const maxTrackPoints = 7200;
const maxPlotFixes = 1000;
const trackStorageKey = "ajrmMarineDrPlotterOperationalTrack";
const plotFixStorageKey = "ajrmMarineDrPlotterPlotFixes";
const mpsToKnots = 1.9438444924406046;
const chartLayerZIndex = 650;
const seamarkLayerZIndex = 750;

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.style.background = isError ? "#7f1d1d" : "#0f172a";
  elements.toast.classList.add("visible");
  setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

async function requestJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
  return data;
}

async function sendJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
  return data;
}

function initMap(defaults = {}) {
  const lat = Number(defaults.latitude) || 56.21;
  const lon = Number(defaults.longitude) || -5.56;
  const zoom = Number(defaults.zoom) || 11;
  map = L.map(elements.map, { zoomControl: true }).setView([lat, lon], zoom);
  MapCore.labelLeafletZoomControls(map);
  const naturalEarth = makeNaturalEarthLayer();
  const empty = L.tileLayer("");
  const openStreetMap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    maxZoom: 22,
    attribution: "© OpenStreetMap contributors",
  });
  const openTopoMap = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 17,
    maxZoom: 22,
    attribution: "Map data © OpenStreetMap contributors | Style © OpenTopoMap",
  });
  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 17, maxZoom: 22, attribution: "© Esri © OpenStreetMap Contributors" },
  );
  seamarkLayer = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    maxZoom: 22,
    zIndex: seamarkLayerZIndex,
    attribution: "© OpenSeaMap contributors",
  });
  baseLayers = {
    Empty: empty,
    "NaturalEarth (offline)": naturalEarth,
    OpenStreetMap: openStreetMap,
    OpenTopoMap: openTopoMap,
    Satellite: satellite,
  };
  autoChartGroup = L.layerGroup();
  routeLayer = L.layerGroup().addTo(map);
  trackLayer = L.layerGroup().addTo(map);
  plotFixLayer = L.layerGroup().addTo(map);
  overlayLayer = L.layerGroup().addTo(map);
  loadOperationalTrack();
  redrawOperationalTrack();
  loadPlotFixes();
  setBaseMap(localStorage.getItem("ajrmMarineDrPlotterBaseMap") || "NaturalEarth (offline)");
  setOverlay(autoChartGroup, localStorage.getItem("ajrmMarineDrPlotterAutoCharts") === "true", "ajrmMarineDrPlotterAutoCharts");
  setOverlay(seamarkLayer, localStorage.getItem("ajrmMarineDrPlotterOpenSeaMap") !== "false", "ajrmMarineDrPlotterOpenSeaMap");
  installCommonChartSelector();
  map.on("dragstart", pauseMapFollowFromUserAction);
  map.on("moveend zoomend", updateAutoChart);
  map.on("mousemove", updateCursorPosition);
  map.on("mouseout", clearCursorPosition);
  map.on("click", handleMapClick);
  updateControlButtonStates();
  loadChartResources();
  refreshActiveRoute();
}

function installCommonChartSelector() {
  MapCore.createChartSelectorControl({
    L,
    map,
    baseMaps: baseLayers,
    getBaseMap: () => localStorage.getItem("ajrmMarineDrPlotterBaseMap") || "NaturalEarth (offline)",
    setBaseMap,
    overlays: [
      { name: MapCore.OPEN_SEA_MAP_NAME, isEnabled: () => map.hasLayer(seamarkLayer), setEnabled: (enabled) => setOverlay(seamarkLayer, enabled, "ajrmMarineDrPlotterOpenSeaMap") },
      { name: MapCore.AUTO_CHARTS_NAME, isEnabled: () => map.hasLayer(autoChartGroup), setEnabled: setAutoChartsEnabled },
    ],
    onFoldersChanged: async () => {
      await loadChartResources({ force: true });
      updateAutoChart();
    },
  }).addTo();
  chartCycle = MapCore.createChartCycleControl({
    L,
    map,
    getCharts: () => autoChartList,
		isEnabled: () => map.hasLayer(autoChartGroup),
    onChange: updateAutoChart,
    statusElement: elements.chartCycleStatus,
  }).addTo();
  mapActionToolbar = MapCore.createActionToolbarControl({
    L,
    map,
    actions: [
      { title: "Navigation integrity", icon: MapCore.MAP_ACTION_ICONS.status, activate: () => elements.toggleStatus.click(), isPressed: () => elements.statusDrawer.classList.contains("open") },
      { title: "Centre / follow own vessel", icon: MapCore.MAP_ACTION_ICONS.follow, activate: () => elements.centreOwnship.click(), isPressed: () => mapFollowSelf },
      { title: "Plot current DR position", icon: MapCore.MAP_ACTION_ICONS.plot, activate: () => elements.plotNow.click() },
    ],
  }).addTo();
}

function makeNaturalEarthLayer() {
  if (window.protomapsL?.leafletLayer) {
    const options = {
      url: "./ne_10m_land.pmtiles",
      flavor: "light",
      theme: "light",
      lang: "en",
      maxDataZoom: 5,
    };
    if (window.protomapsL.light && window.protomapsL.paintRules && window.protomapsL.labelRules) {
      options.paintRules = window.protomapsL.paintRules({ ...window.protomapsL.light, water: "rgba(0,0,0,0)" });
      options.labelRules = window.protomapsL.labelRules(window.protomapsL.light);
    }
    return window.protomapsL.leafletLayer(options);
  }
  return L.tileLayer("", { attribution: "NaturalEarth unavailable" });
}

function setBaseMap(name) {
  if (!map || !baseLayers[name]) return;
  if (currentBaseLayer) map.removeLayer(currentBaseLayer);
  currentBaseLayer = baseLayers[name];
  currentBaseLayer.addTo(map);
  localStorage.setItem("ajrmMarineDrPlotterBaseMap", name);
  for (const choice of elements.baseMapChoices) choice.checked = choice.value === name;
  keepChartLayersOnTop();
}

function setOverlay(layer, enabled, storageKey) {
  if (!map || !layer) return;
  if (enabled) layer.addTo(map);
  else map.removeLayer(layer);
  localStorage.setItem(storageKey, String(enabled));
  if (layer === autoChartGroup) {
    elements.autoCharts.checked = enabled;
    chartCycle?.update();
  }
  if (layer === seamarkLayer) elements.openSeaMap.checked = enabled;
  updateAutoChart();
  keepChartLayersOnTop();
}

function updateCursorPosition(event) {
  lastCursorEvent = event;
  const prefix = manualFixPickMode ? "Pick fix" : "Cursor";
  elements.cursorPosition.textContent = `${prefix} ${formatLatLon(event.latlng)}${cursorRangeText(event.latlng)}`;
}

function clearCursorPosition() {
  lastCursorEvent = null;
  elements.cursorPosition.textContent = "Cursor --";
}

function normalizeCoordinateFormat(value, fallback = "dms") {
  return ["dms", "degrees-minutes", "decimal"].includes(value)
    ? value
    : fallback;
}

function applyCoordinateFormat(value, { persist = true } = {}) {
  const nextCoordinateFormat = normalizeCoordinateFormat(value);
  const formatChanged = coordinateFormat !== nextCoordinateFormat;
  coordinateFormat = nextCoordinateFormat;
  elements.coordinateFormat.value = coordinateFormat;
  if (persist) {
    coordinateFormatOverride = coordinateFormat;
    localStorage.setItem("ajrmMarineDrPlotterCoordinateFormat", coordinateFormat);
  }
  if (lastCursorEvent) updateCursorPosition(lastCursorEvent);
  if (formatChanged && plotFixesLoaded) redrawPlotFixes();
}

function formatLatLon(latlng) {
  const lat = Number(latlng?.lat);
  const lon = Number(latlng?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "--";
  return `${formatCoordinate(lat, "N", "S")} ${formatCoordinate(lon, "E", "W")}`;
}

function formatCoordinate(value, positive, negative) {
  const absolute = Math.abs(Number(value));
  if (!Number.isFinite(absolute)) return "n/a";
  const hemisphere = value >= 0 ? positive : negative;
  if (coordinateFormat === "decimal") return `${absolute.toFixed(6)}°${hemisphere}`;
  const degrees = Math.floor(absolute);
  const minutesTotal = (absolute - degrees) * 60;
  if (coordinateFormat === "degrees-minutes") {
    return `${degrees}° ${minutesTotal.toFixed(3)}'${hemisphere}`;
  }
  const minutes = Math.floor(minutesTotal);
  const seconds = (minutesTotal - minutes) * 60;
  return `${degrees}° ${String(minutes).padStart(2, "0")}' ${seconds.toFixed(1)}"${hemisphere}`;
}

function cursorRangeText(latlng) {
  const currentPosition = ownshipFollowPosition(latestStatus?.ajrmMarineGpsIntegrity);
  const cursorPosition = leafletLatLngToPosition(latlng);
  if (!currentPosition || !cursorPosition) return "";
  const distance = distanceMeters(currentPosition, cursorPosition);
  const bearing = bearingDegrees(currentPosition, cursorPosition);
  if (!Number.isFinite(distance) || !Number.isFinite(bearing)) return "";
  return ` | Range ${formatDistance(distance)} / ${formatDegrees(bearing)}`;
}

function leafletLatLngToPosition(latlng) {
  const latitude = Number(latlng?.lat);
  const longitude = Number(latlng?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

async function setAutoChartsEnabled(enabled) {
  setOverlay(autoChartGroup, enabled, "ajrmMarineDrPlotterAutoCharts");
  if (enabled && !chartResourcesLoaded) {
    elements.chartStatus.textContent = "Loading Signal K chart resources...";
    await loadChartResources({ force: true });
    updateAutoChart();
  }
}

async function loadChartResources({ force = false } = {}) {
  if (chartResourcesLoading) return chartResourcesLoading;
  if (chartResourcesLoaded && !force) return autoChartList;
  chartResourcesLoading = (async () => {
    try {
      let charts = null;
      try {
        charts = await requestJson("/signalk/v1/api/resources/charts");
      } catch (_error) {
        const data = await requestJson(`${apiBase}/charts`);
        charts = data.charts || {};
      }
      autoChartList = MapCore.normalizeChartResources(charts);
      chartResourcesLoaded = true;
      elements.chartStatus.textContent = `${autoChartList.length} chart resource${autoChartList.length === 1 ? "" : "s"} found`;
      updateAutoChart();
    } catch (error) {
      autoChartList = [];
      chartResourcesLoaded = false;
      elements.chartStatus.textContent = `Chart resources not available: ${error.message}`;
    } finally {
      chartResourcesLoading = null;
    }
    return autoChartList;
  })();
  return chartResourcesLoading;
}

function chartUrl(chart) {
  return chart?.tilemapUrl || chart?.url || chart?.tileUrl || chart?.href || "";
}

function chartZoom(chart) {
  const min = Number(chart?.minzoom ?? chart?.minZoom ?? 0);
  const max = Number(chart?.maxzoom ?? chart?.maxZoom ?? 24);
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 24,
  };
}

function chartBoundsCandidates(chart) {
  const source =
    chart?.bounds ||
    chart?.boundingBox ||
    chart?.extent ||
    chart?.bbox ||
    chart?.properties?.bounds ||
    chart?.properties?.bbox ||
    chart?.metadata?.bounds;
  const candidates = [];
  if (Array.isArray(source) && source.some(Array.isArray)) {
    const points = source
      .filter(Array.isArray)
      .map((point) => point.slice(0, 2).map(Number))
      .filter((point) => point.length === 2 && point.every(Number.isFinite));
    if (points.length >= 2) {
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      candidates.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      candidates.push([Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)]);
    }
  } else {
    let bounds = null;
    if (Array.isArray(source)) {
      bounds = source.slice(0, 4).map(Number);
    } else if (typeof source === "string") {
      bounds = source.split(/[\\s,]+/).map(Number).filter(Number.isFinite).slice(0, 4);
    } else if (source && typeof source === "object") {
      if (source.sw && source.ne) {
        bounds = [
          source.sw.lng ?? source.sw.lon ?? source.sw[1],
          source.sw.lat ?? source.sw[0],
          source.ne.lng ?? source.ne.lon ?? source.ne[1],
          source.ne.lat ?? source.ne[0],
        ].map(Number);
      } else {
        bounds = [
          source.minLon ?? source.west ?? source.left ?? source.minx ?? source.xmin,
          source.minLat ?? source.south ?? source.bottom ?? source.miny ?? source.ymin,
          source.maxLon ?? source.east ?? source.right ?? source.maxx ?? source.xmax,
          source.maxLat ?? source.north ?? source.top ?? source.maxy ?? source.ymax,
        ].map(Number);
      }
    }
    if (bounds?.length >= 4) {
      const [a, b, c, d] = bounds;
      candidates.push([Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]);
      candidates.push([Math.min(b, d), Math.min(a, c), Math.max(b, d), Math.max(a, c)]);
    }
  }
  return candidates.filter(
    (bounds) =>
      bounds.every(Number.isFinite) &&
      bounds[0] >= -180 &&
      bounds[2] <= 180 &&
      bounds[1] >= -90 &&
      bounds[3] <= 90 &&
      bounds[0] < bounds[2] &&
      bounds[1] < bounds[3],
  );
}

function chartBounds(chart, lat, lon) {
  const candidates = chartBoundsCandidates(chart);
  return (
    candidates.find(
      (bounds) => lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3],
    ) ||
    candidates[0] ||
    null
  );
}

function chartContains(chart, lat, lon) {
  const bounds = chartBounds(chart, lat, lon);
  return Boolean(bounds && lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]);
}

function chartArea(chart, lat, lon) {
  const bounds = chartBounds(chart, lat, lon);
  return bounds ? Math.abs((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) : Number.MAX_VALUE;
}

function makeAutoChartLayer(chart) {
  const url = chartUrl(chart);
  if (!url) return null;
  const zoom = chartZoom(chart);
  return L.tileLayer(url, {
    minNativeZoom: zoom.min,
    maxNativeZoom: zoom.max,
    minZoom: zoom.min,
    maxZoom: 22,
    zIndex: chartLayerZIndex,
    attribution: "",
    errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
  });
}

function makeAutoChartFallbackLayer() {
  return L.tileLayer("", { attribution: "" });
}

function chooseAutoChart() {
  return map ? (chartCycle
    ? chartCycle.choose(autoChartList, map)
    : MapCore.chooseChart(autoChartList, map)) : null;
}

function updateAutoChart() {
  if (!map || !autoChartGroup || !map.hasLayer(autoChartGroup)) return;
  if (!chartResourcesLoaded) {
    elements.chartStatus.textContent = chartResourcesLoading
      ? "Loading Signal K chart resources..."
      : "Chart resources have not loaded yet.";
    return;
  }
  const chart = chooseAutoChart();
  if (!chart) {
    elements.chartStatus.textContent = autoChartList.length
      ? "No chart covers the current map centre."
      : "No Signal K chart resources found.";
    if (autoChartId === "__fallback") return;
    autoChartGroup.clearLayers();
    autoChartLayer = null;
    autoChartId = "__fallback";
    autoChartFallbackLayer = makeAutoChartFallbackLayer();
    autoChartGroup.addLayer(autoChartFallbackLayer);
    keepChartLayersOnTop();
    return;
  }
  elements.chartStatus.textContent = chart.name || chart.description || chart.__autoChartId || "Auto chart selected";
  if (autoChartId === chart.__autoChartId && autoChartLayer && autoChartGroup.hasLayer(autoChartLayer)) {
    keepChartLayersOnTop();
    return;
  }
  autoChartGroup.clearLayers();
  autoChartLayer = makeAutoChartLayer(chart);
  autoChartId = chart.__autoChartId;
  if (autoChartLayer) autoChartGroup.addLayer(autoChartLayer);
  keepChartLayersOnTop();
}

function keepChartLayersOnTop() {
  autoChartGroup?.eachLayer((layer) => layer.setZIndex?.(chartLayerZIndex));
  if (seamarkLayer && map?.hasLayer(seamarkLayer)) {
    seamarkLayer.setZIndex?.(seamarkLayerZIndex);
    seamarkLayer.bringToFront?.();
  }
  if (routeLayer) routeLayer.bringToFront?.();
  if (trackLayer) trackLayer.bringToFront?.();
  if (plotFixLayer) plotFixLayer.bringToFront?.();
  if (overlayLayer) overlayLayer.bringToFront?.();
}

function routeSignature(active) {
  if (!active) return "none";
  return [
    active.resourceId || "draft",
    active.revision || 0,
    active.reversed === true ? "reverse" : "forward",
    active.changedAt || active.openedAt || "",
  ].join(":");
}

function routePoints(active) {
  const coordinates = active?.resource?.feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  return coordinates
    .filter((coordinate) =>
      Array.isArray(coordinate) &&
      Number.isFinite(Number(coordinate[0])) &&
      Number.isFinite(Number(coordinate[1])))
    .map(([longitude, latitude]) => [Number(latitude), Number(longitude)]);
}

function routeArrows(points, maximum = 20) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const step = Math.max(1, Math.ceil((points.length - 1) / maximum));
  const arrows = [];
  for (let index = 1; index < points.length; index += step) {
    const start = points[index - 1];
    const finish = points[index];
    const bearing = bearingDegrees(
      { latitude: start[0], longitude: start[1] },
      { latitude: finish[0], longitude: finish[1] },
    );
    arrows.push({
      position: [(start[0] + finish[0]) / 2, (start[1] + finish[1]) / 2],
      rotation: bearing - 90,
    });
  }
  return arrows;
}

function renderActiveRoute(active) {
  if (!routeLayer) return;
  const signature = routeSignature(active);
  if (signature === activeRouteSignature) return;
  activeRouteSignature = signature;
  routeLayer.clearLayers();
  const points = routePoints(active);
  if (points.length < 2) return;
  const color = "#ff7a00";
  const name = active?.resource?.name || "Unnamed route";
  L.polyline(points, {
    color,
    weight: 4,
    opacity: 0.9,
    interactive: true,
  })
    .bindTooltip(`Route: ${name}`, { sticky: true })
    .addTo(routeLayer);
  for (const arrow of routeArrows(points)) {
    const icon = L.divIcon({
      className: "dr-route-arrow-marker",
      html: `<span style="color:${color};transform:rotate(${arrow.rotation}deg)">➤</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    L.marker(arrow.position, { icon, interactive: false }).addTo(routeLayer);
  }
  keepChartLayersOnTop();
}

async function refreshActiveRoute() {
  if (!map) return;
  try {
    const data = await requestJson(`${apiBase}/active-route`);
    renderActiveRoute(data.active || null);
  } catch (_error) {
    // Display is optional. Retain the last route through a transient failure.
  }
}

function renderIntegrity(state) {
  overlayLayer.clearLayers();
  updateGpsStatusIndicator(state);
  const trust = state?.trust || "unknown";
  elements.trustBadge.textContent = `GPS ${trust.toUpperCase()}`;
  elements.trustBadge.dataset.trust = trust;
  elements.statusLine.textContent = state?.timestamp ? `Updated ${new Date(state.timestamp).toLocaleTimeString()}` : "No provider state";
  const operationalDr = state?.operationalDeadReckoning || state?.deadReckoning || {};
  const integrityDr = state?.integrityDeadReckoning || {};
  const integrityAssurance = state?.integrityAssurance || {};
  const reference = navigationReferenceSummary(state);
  const assuranceStatus = integrityDr.assurance || integrityAssurance.status || null;
  const assuranceReason = integrityDr.unavailableReason || integrityAssurance.reason || null;
  elements.warningText.textContent =
    state?.reasons?.[0] ||
    (assuranceStatus && assuranceStatus !== "full"
      ? assuranceReason || `Integrity assurance is ${assuranceStatus}.`
      : "No active GPS integrity warning.");
  elements.referenceKind.textContent = reference.kind || "unavailable";
  elements.referenceSource.textContent = reference.source || "n/a";
  elements.referenceAge.textContent = formatAgeValue(reference.ageSeconds);
  elements.referenceUncertainty.textContent = formatAngleUncertainty(reference.uncertaintyDegrees);
  elements.referenceDependency.textContent = formatDependency(reference.gpsDependent);
  elements.fixAge.textContent = operationalDr.ageSeconds == null ? "n/a" : `${Math.round(operationalDr.ageSeconds)} s`;
  elements.uncertainty.textContent =
    operationalDr.uncertaintyRadiusMeters == null ? "n/a" : `${Math.round(operationalDr.uncertaintyRadiusMeters)} m`;
  elements.drSource.textContent = operationalDr.source || "n/a";
  elements.drDependency.textContent = formatDependency(operationalDr.gpsDependent);
  elements.drLeeway.textContent = operationalDr.leewayStatus || "unknown";
  elements.drCurrentOrigin.textContent = operationalDr.currentOrigin || "n/a";
  elements.drProvenance.textContent = formatDrProvenance(operationalDr);
  elements.integritySource.textContent = integrityDr.source || "n/a";
  elements.integrityAssurance.textContent = assuranceStatus || "unavailable";
  elements.integrityComparison.textContent = formatComparison(
    integrityDr.comparisonAvailable ?? integrityAssurance.comparisonAvailable,
  );
  elements.integrityReason.textContent = assuranceReason || "n/a";
  elements.integrityAge.textContent = formatAgeValue(integrityDr.ageSeconds);
  elements.integrityUncertainty.textContent = formatMeters(integrityDr.uncertaintyRadiusMeters);
  elements.integrityDependency.textContent = formatDependency(integrityDr.gpsDependent);
  elements.integrityLeeway.textContent =
    integrityDr.leewayStatus || integrityAssurance.leewayStatus || "unknown";
  elements.integrityCurrentOrigin.textContent = integrityDr.currentOrigin || "n/a";
  elements.integrityProvenance.textContent = formatDrProvenance(integrityDr);
  elements.hdop.textContent = state?.gps?.hdop ?? "n/a";

  const gps = state?.gps?.position;
  const dr = operationalDr.position;
  const integrityPosition = integrityDr.position;
  updateOperationalTrack(ownshipFollowPosition(state), state?.timestamp);
  if (gps) addPoint(gps, "gps", "GPS");
  if (dr && shouldDrawOperationalDr(gps, dr, state)) {
    addPoint(dr, "dr", "DR");
    if (operationalDr.uncertaintyRadiusMeters) {
      L.circle([dr.latitude, dr.longitude], {
        radius: operationalDr.uncertaintyRadiusMeters,
        color: colorForTrust(trust),
        fillColor: colorForTrust(trust),
        fillOpacity: 0.12,
        weight: 2,
      }).addTo(overlayLayer);
    }
  }
  if (shouldDrawIntegrityDr(state, gps, dr, integrityPosition)) {
    addPoint(integrityPosition, "integrity-dr", "IDR");
  }
  if (dr) {
    drawVectors(dr, state.vectors || {});
  }
  followOwnshipIfEnabled(state);
  keepChartLayersOnTop();
}

function shouldDrawOperationalDr(gps, dr, state) {
  if (!gps) return true;
  if (state?.acceptedGps === false) return true;
  return distanceMeters(gps, dr) > 5;
}

function shouldDrawIntegrityDr(state, gps, dr, integrityPosition) {
  if (!integrityPosition || !gps || state?.trust === "lost") return false;
  if (state?.integrityDeadReckoning?.comparisonAvailable === false) return false;
  const comparisonPosition = dr || gps;
  return distanceMeters(comparisonPosition, integrityPosition) > 8;
}

function followOwnshipIfEnabled(state) {
  if (!mapFollowSelf || !map) return;
  const position = ownshipFollowPosition(state);
  if (!position) return;
  disableMapFollowPause = true;
  try {
    map.panTo(ownshipFollowMapCenter(state, position), { animate: false });
    updateAutoChart();
  } finally {
    disableMapFollowPause = false;
  }
}

function ownshipFollowPosition(state) {
  return (
    state?.operationalDeadReckoning?.position ||
    state?.deadReckoning?.position ||
    state?.gps?.position ||
    null
  );
}

function ownshipFollowCogRadians(state) {
  const vectorDegrees = state?.vectors?.courseOverGround?.bearingTrueDegrees;
  if (vectorDegrees != null && Number.isFinite(Number(vectorDegrees))) {
    return (Number(vectorDegrees) * Math.PI) / 180;
  }
  const gpsCogRadians = state?.gps?.courseOverGroundTrue;
  return gpsCogRadians != null && Number.isFinite(Number(gpsCogRadians))
    ? Number(gpsCogRadians)
    : null;
}

function ownshipFollowMapCenter(state, position = ownshipFollowPosition(state)) {
  return MapCore.mapFollowLookAheadCenter({
    map,
    position,
    cogRadians: ownshipFollowCogRadians(state),
    lookAheadPercent: MapCore.loadMapFollowLookAheadPercent(localStorage),
  });
}

function applyMapFollowLookAheadSetting(value) {
  const normalized = value == null
    ? MapCore.loadMapFollowLookAheadPercent(localStorage)
    : MapCore.saveMapFollowLookAheadPercent(value, localStorage);
  elements.mapFollowLookAhead.value = String(normalized);
  elements.mapFollowLookAheadValue.textContent =
    `${normalized}% ahead / ${100 - normalized}% behind`;
  return normalized;
}

function pauseMapFollowFromUserAction() {
  if (!disableMapFollowPause) setMapFollowSelf(false);
}

function setMapFollowSelf(enabled) {
  mapFollowSelf = Boolean(enabled);
  updateControlButtonStates();
}

function recenterOnOwnship() {
  const position = ownshipFollowPosition(latestStatus?.ajrmMarineGpsIntegrity);
  if (!position || !map) return;
  setMapFollowSelf(true);
  disableMapFollowPause = true;
  try {
    map.panTo(
      ownshipFollowMapCenter(latestStatus?.ajrmMarineGpsIntegrity, position),
      { animate: false },
    );
    if (map.getZoom() < 13) map.setZoom(13, { animate: false });
    updateAutoChart();
  } finally {
    disableMapFollowPause = false;
  }
}

function updateControlButtonStates() {
  elements.toggleStatus.setAttribute("aria-pressed", String(elements.statusDrawer.classList.contains("open")));
  elements.toggleCharts.setAttribute("aria-pressed", String(elements.chartDrawer.classList.contains("open")));
  elements.centreOwnship.setAttribute("aria-pressed", String(mapFollowSelf));
  elements.centreOwnship.classList.toggle("following", mapFollowSelf);
  elements.centreOwnship.classList.toggle("paused", !mapFollowSelf);
  elements.centreOwnship.title = mapFollowSelf ? "Following own vessel" : "Follow paused. Click to centre own vessel";
  elements.centreOwnship.setAttribute("aria-label", elements.centreOwnship.title);
  mapActionToolbar?.update();
}

function updateOperationalTrack(position, timestamp, force = false) {
  if (!position || !trackLayer) return;
  const last = operationalTrack[operationalTrack.length - 1];
  if (!force && last && distanceMeters(last, position) < 2) return;
  operationalTrack.push({
    latitude: position.latitude,
    longitude: position.longitude,
    timestamp: timestamp || new Date().toISOString(),
  });
  if (operationalTrack.length > maxTrackPoints) {
    operationalTrack = operationalTrack.slice(operationalTrack.length - maxTrackPoints);
  }
  redrawOperationalTrack();
}

async function loadOperationalTrack() {
  try {
    const data = await requestJson(`${apiBase}/track`);
    operationalTrack = normalizeTrackPoints(data.points || []);
  } catch {
    operationalTrack = loadOperationalTrackLocal();
  }
  redrawOperationalTrack();
}

function loadOperationalTrackLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(trackStorageKey) || "null");
    return normalizeTrackPoints(parsed?.points || parsed || []);
  } catch {
    return [];
  }
}

function saveOperationalTrackLocal() {
  try {
    localStorage.setItem(trackStorageKey, JSON.stringify({ points: operationalTrack.slice(-maxTrackPoints) }));
  } catch (_error) {
    // Browser storage is only a degraded fallback; server persistence is preferred.
  }
}

function normalizeTrackPoints(points) {
  return points
    .map((point) => ({
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      timestamp: typeof point.timestamp === "string" ? point.timestamp : null,
      trust: stringOrNull(point.trust),
      source: stringOrNull(point.source),
      uncertaintyRadiusMeters: finiteOrNull(point.uncertaintyRadiusMeters),
      gpsDependent: booleanOrNull(point.gpsDependent),
      leewayStatus: stringOrNull(point.leewayStatus),
      currentOrigin: stringOrNull(point.currentOrigin),
      referenceKind: stringOrNull(point.referenceKind),
      referenceSource: stringOrNull(point.referenceSource),
      referenceAgeSeconds: finiteOrNull(point.referenceAgeSeconds),
      referenceUncertaintyDegrees: finiteOrNull(point.referenceUncertaintyDegrees),
      referenceGpsDependent: booleanOrNull(point.referenceGpsDependent),
    }))
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .slice(-maxTrackPoints);
}

function redrawOperationalTrack() {
  trackLayer.clearLayers();
  if (operationalTrack.length < 2) return;
  L.polyline(operationalTrack.map((point) => [point.latitude, point.longitude]), {
    color: "#0f172a",
    weight: 3,
    opacity: 0.58,
    dashArray: "2 8",
    lineCap: "round",
  }).addTo(trackLayer);
}

async function loadPlotFixes() {
  try {
    const data = await requestJson(`${apiBase}/plot-fixes`);
    plotFixes = normalizePlotFixes(data.plotFixes || []);
    plotFixesLoaded = true;
    savePlotFixesLocal();
  } catch (_error) {
    plotFixes = loadPlotFixesLocal();
    plotFixesLoaded = true;
  }
  redrawPlotFixes();
  updatePlotStatus();
}

function loadPlotFixesLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(plotFixStorageKey) || "null");
    return normalizePlotFixes(parsed?.plotFixes || parsed || []);
  } catch {
    return [];
  }
}

function savePlotFixesLocal() {
  try {
    localStorage.setItem(plotFixStorageKey, JSON.stringify({ plotFixes: plotFixes.slice(-maxPlotFixes) }));
  } catch (_error) {
    // Browser storage is a convenience fallback; server persistence is preferred.
  }
}

async function savePlotFixesServer() {
  if (plotFixSavePending) return;
  plotFixSavePending = true;
  try {
    await sendJson(`${apiBase}/plot-fixes`, "PUT", { plotFixes });
  } catch (_error) {
    savePlotFixesLocal();
  } finally {
    plotFixSavePending = false;
  }
}

function normalizePlotFixes(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizePlotFix)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-maxPlotFixes);
}

function normalizePlotFix(value) {
  const position = value?.position;
  const latitude = Number(position?.latitude);
  const longitude = Number(position?.longitude);
  const timestampMs = Date.parse(value?.timestamp);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(timestampMs)) return null;
  return {
    id: typeof value.id === "string" ? value.id : `plot-${new Date(timestampMs).toISOString()}`,
    timestamp: new Date(timestampMs).toISOString(),
    automatic: value.automatic === true,
    position: { latitude, longitude },
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
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function normalizePlotType(value) {
  return ["manual", "timed", "gps-lost", "gps-return", "observed-fix"].includes(value) ? value : null;
}

function selectedPlotIntervalMinutes() {
  const value = Number(elements.plotInterval.value);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function savePlotIntervalSetting() {
  try {
    const data = await sendJson(`${apiBase}/settings`, "PUT", {
      plotFixIntervalMinutes: selectedPlotIntervalMinutes(),
    });
    if (data.settings?.plotFixIntervalMinutes != null) {
      elements.plotInterval.value = String(data.settings.plotFixIntervalMinutes);
    }
    updatePlotStatus();
    showToast("Plot interval saved.");
  } catch (error) {
    showToast(error.message || "Unable to save plot interval.", true);
  }
}

function createPlotFix(state, automatic, plotType = automatic ? "timed" : "manual") {
  const operationalDr = state?.operationalDeadReckoning || state?.deadReckoning || {};
  const integrityDr = state?.integrityDeadReckoning || {};
  const reference = navigationReferenceSummary(state);
  const position = ownshipFollowPosition(state);
  if (!position) return null;
  const lastTrustedPosition = state?.lastTrustedFix?.position || null;
  const timestamp = state?.timestamp || new Date().toISOString();
  const timestampMs = Date.parse(timestamp);
  const lastTrustedMs = Date.parse(state?.lastTrustedFix?.timestamp);
  return {
    id: `plot-${new Date(Number.isFinite(timestampMs) ? timestampMs : Date.now()).toISOString()}-${automatic ? "auto" : "manual"}`,
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
    cogTrueDegrees: state?.vectors?.courseOverGround?.bearingTrueDegrees ?? radToDegrees(state?.gps?.courseOverGroundTrue),
    currentDriftMps: state?.vectors?.tide?.speedMps ?? null,
    currentSetTrueDegrees: state?.vectors?.tide?.bearingTrueDegrees ?? null,
  };
}

async function applyManualFix() {
  const latitude = parseCoordinateInput(elements.manualFixLatitude.value, "latitude");
  const longitude = parseCoordinateInput(elements.manualFixLongitude.value, "longitude");
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    showToast("Enter a latitude between -90 and 90.", true);
    return;
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    showToast("Enter a longitude between -180 and 180.", true);
    return;
  }
  try {
    elements.applyManualFix.disabled = true;
    const note = elements.manualFixNote.value.trim();
    const result = await sendJson(`${gpsIntegrityApiBase}/manual-fix`, "POST", {
      position: { latitude, longitude },
      note,
    });
    latestStatus = {
      ...(latestStatus || {}),
      ajrmMarineGpsIntegrity: result.state,
    };
    const plotFix = createPlotFix(result.state, false, "observed-fix");
    if (plotFix) {
      plotFix.id = `plot-${plotFix.timestamp}-observed`;
      plotFix.position = { latitude, longitude };
      plotFix.note = note || "Manual observed fix";
      addPlotFix(plotFix, false);
    }
    showToast(`Observed fix set ${formatTime(result.state?.timestamp || new Date().toISOString())}.`);
    await refreshStatus();
  } catch (error) {
    showToast(error.message || "Unable to set observed fix.", true);
  } finally {
    elements.applyManualFix.disabled = false;
  }
}

function parseCoordinateInput(value, axis) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const hemisphere = text.match(/[NSEW]/)?.[0] || "";
  if (axis === "latitude" && hemisphere && !["N", "S"].includes(hemisphere)) return null;
  if (axis === "longitude" && hemisphere && !["E", "W"].includes(hemisphere)) return null;
  const parts = text.match(/[-+]?\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  const explicitSign = parts[0] < 0 ? -1 : 1;
  const hemisphereSign = ["S", "W"].includes(hemisphere) ? -1 : ["N", "E"].includes(hemisphere) ? 1 : null;
  const sign = hemisphereSign ?? explicitSign;
  const degrees = Math.abs(parts[0]);
  const minutes = Math.abs(parts[1] ?? 0);
  const seconds = Math.abs(parts[2] ?? 0);
  if (minutes >= 60 || seconds >= 60) return null;
  const decimal = sign * (degrees + minutes / 60 + seconds / 3600);
  const limit = axis === "latitude" ? 90 : 180;
  return Math.abs(decimal) <= limit ? decimal : null;
}

function formatCoordinateInput(value, positive, negative) {
  return formatCoordinate(value, positive, negative);
}

function startManualFixPickMode() {
  if (!map) return;
  manualFixPickMode = true;
  elements.map.classList.add("manual-fix-pick-mode");
  elements.pickManualFixFromCursor.disabled = true;
  elements.pickManualFixFromCursor.textContent = "Click chart...";
  elements.cursorPosition.textContent = "Pick fix: click chart position";
  showToast("Click the chart position for the observed fix.");
}

function stopManualFixPickMode() {
  manualFixPickMode = false;
  elements.map.classList.remove("manual-fix-pick-mode");
  elements.pickManualFixFromCursor.disabled = false;
  elements.pickManualFixFromCursor.textContent = "Get from cursor";
}

function handleMapClick(event) {
  if (!manualFixPickMode) return;
  const lat = Number(event.latlng?.lat);
  const lon = Number(event.latlng?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  elements.manualFixLatitude.value = formatCoordinateInput(lat, "N", "S");
  elements.manualFixLongitude.value = formatCoordinateInput(lon, "E", "W");
  stopManualFixPickMode();
  elements.cursorPosition.textContent = `Observed fix ${formatLatLon(event.latlng)}`;
  showToast("Observed fix position copied from chart.");
}

function addPlotFix(plotFix, announce = true) {
  const normalized = normalizePlotFix(plotFix);
  if (!normalized) {
    if (announce) showToast("No DR position available to plot.", true);
    return false;
  }
  plotFixes = normalizePlotFixes([...plotFixes, normalized]);
  if (normalized.plotType !== "observed-fix") {
    updateOperationalTrack(normalized.position, normalized.timestamp, true);
  }
  savePlotFixesLocal();
  redrawPlotFixes();
  updatePlotStatus();
  savePlotFixesServer();
  if (announce) showToast(`Plotted DR fix ${formatTime(normalized.timestamp)}.`);
  return true;
}

function clearPlotFixes() {
  plotFixes = [];
  savePlotFixesLocal();
  redrawPlotFixes();
  updatePlotStatus();
  sendJson(`${apiBase}/plot-fixes`, "DELETE").catch(() => {});
  showToast("Plot fixes cleared.");
}

function clearAllPlots() {
  operationalTrack = [];
  saveOperationalTrackLocal();
  redrawOperationalTrack();
  sendJson(`${apiBase}/track`, "DELETE").catch(() => {});
  clearPlotFixes();
  showToast("All DR plots cleared.");
}

function pruneOldPlotFixes() {
  const days = Number(elements.prunePlotFixesAge.value);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = plotFixes.length;
  plotFixes = plotFixes.filter((plotFix) => {
    const timestampMs = Date.parse(plotFix.timestamp);
    return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
  });
  savePlotFixesLocal();
  redrawPlotFixes();
  updatePlotStatus();
  savePlotFixesServer();
  const removed = before - plotFixes.length;
  showToast(removed ? `Pruned ${removed} old plot fix${removed === 1 ? "" : "es"}.` : "No old plot fixes to prune.");
}

function redrawPlotFixes() {
  if (!plotFixLayer) return;
  plotFixLayer.clearLayers();
  for (const plotFix of plotFixes) {
    const latlng = [plotFix.position.latitude, plotFix.position.longitude];
    const marker = L.marker(latlng, {
      icon: L.divIcon({
        className: `plot-fix-symbol-marker ${plotFixMarkerClass(plotFix)}`,
        html: `<span class="plot-fix-symbol"></span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -18],
      }),
    });
    marker.bindPopup(() => plotFixPopupHtml(plotFix), { maxWidth: 320 });
    marker.addTo(plotFixLayer);
    L.marker(latlng, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "plot-fix-label-marker",
        html: `<span class="plot-fix-time">${escapeHtml(formatTime(plotFix.timestamp))}</span>`,
        iconSize: [74, 24],
        iconAnchor: [37, 38],
      }),
    }).addTo(plotFixLayer);
  }
  keepChartLayersOnTop();
}

function plotFixMarkerClass(plotFix) {
  const classes = [plotFix.plotType || (plotFix.automatic ? "timed" : "manual")];
  if (plotFix.plotType === "observed-fix") {
    classes.push("observed-fix");
  } else {
    classes.push(plotFix.trust === "lost" || plotFix.plotType === "gps-lost" ? "estimated-position" : "electronic-fix");
  }
  return classes.join(" ");
}

function plotFixPopupHtml(plotFix) {
  return `
    <div class="plot-popup">
      <h3>${escapeHtml(plotFixTitle(plotFix))} ${escapeHtml(formatTime(plotFix.timestamp))}</h3>
      <dl>
        ${popupRow("Position", formatPosition(plotFix.position))}
        ${plotFix.note ? popupRow("Note", plotFix.note) : ""}
        ${popupRow("GPS status", plotFix.trust ? plotFix.trust.toUpperCase() : "n/a")}
        ${popupRow("Reference kind", plotFix.referenceKind || "n/a")}
        ${popupRow("Reference source", plotFix.referenceSource || "n/a")}
        ${popupRow("Reference age", formatAgeValue(plotFix.referenceAgeSeconds))}
        ${popupRow("Reference uncertainty", formatAngleUncertainty(plotFix.referenceUncertaintyDegrees))}
        ${popupRow("Reference dependence", formatDependency(plotFix.referenceGpsDependent))}
        ${popupRow("Operational DR source", plotFix.drSource || "n/a")}
        ${popupRow("Operational dependence", formatDependency(plotFix.drGpsDependent))}
        ${popupRow("Operational leeway", plotFix.drLeewayStatus || "unknown")}
        ${popupRow("Operational current origin", plotFix.drCurrentOrigin || "n/a")}
        ${popupRow("Operational provenance", formatPlotFixProvenance(plotFix))}
        ${popupRow("Operational uncertainty", formatMeters(plotFix.uncertaintyRadiusMeters))}
        ${popupRow("Integrity source", plotFix.integritySource || "n/a")}
        ${popupRow("Integrity assurance", plotFix.integrityAssurance || "unavailable")}
        ${popupRow("Integrity comparison", formatComparison(plotFix.integrityComparisonAvailable))}
        ${plotFix.integrityUnavailableReason ? popupRow("Integrity reason", plotFix.integrityUnavailableReason) : ""}
        ${popupRow("Integrity uncertainty", formatMeters(plotFix.integrityUncertaintyRadiusMeters))}
        ${popupRow("Integrity leeway", plotFix.integrityLeewayStatus || "unknown")}
        ${popupRow("Integrity current origin", plotFix.integrityCurrentOrigin || "n/a")}
        ${popupRow("Integrity provenance", formatIntegrityPlotFixProvenance(plotFix))}
        ${popupRow("Last trusted GPS", formatAge(plotFix.lastTrustedFixAgeSeconds))}
        ${popupRow("DR distance since GPS", formatDistance(plotFix.distanceFromLastTrustedFixMeters))}
        ${popupRow("STW / heading", `${formatKnots(plotFix.stwMps)} / ${formatDegrees(plotFix.headingTrueDegrees)}`)}
        ${popupRow("SOG / COG", `${formatKnots(plotFix.sogMps)} / ${formatDegrees(plotFix.cogTrueDegrees)}`)}
        ${popupRow(currentVectorLabel(plotFix.drCurrentOrigin), `${formatKnots(plotFix.currentDriftMps)} / ${formatDegrees(plotFix.currentSetTrueDegrees)}`)}
      </dl>
    </div>
  `;
}

function plotFixTitle(plotFix) {
  if (plotFix.trust === "lost" || plotFix.plotType === "gps-lost") return "Estimated position";
  if (plotFix.plotType === "gps-return") return "GPS fix";
  if (plotFix.plotType === "observed-fix") return "Observed fix";
  if (plotFix.plotType === "timed" || plotFix.automatic) return "Timed plot fix";
  return "Manual plot fix";
}

function popupRow(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function updatePlotStatus() {
  const count = plotFixes.length;
  const interval = selectedPlotIntervalMinutes();
  elements.plotStatus.textContent = `${count} plot fix${count === 1 ? "" : "es"}. ${
    interval ? `Automatic every ${interval} min.` : "Automatic plotting off."
  }`;
}

function addPoint(position, className, label) {
  const marker = L.divIcon({
    className: `own-marker ${className}`,
    html: `<span>${label}</span>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
  L.marker([position.latitude, position.longitude], { icon: marker }).addTo(overlayLayer);
}

function drawVectors(origin, vectors) {
  drawVector(origin, vectors.headingThroughWater, "#2563eb", 1);
  drawVector(origin, vectors.courseOverGround, "#7c3aed", 2);
  drawVector(origin, vectors.tide, "#0891b2", 3);
}

function drawVector(origin, vector, color, arrows) {
  if (!vector?.available) return;
  const lengthMeters = Math.max(80, vector.speedMps * 240);
  const end = destination(origin, vector.bearingTrueDegrees, lengthMeters);
  L.polyline([[origin.latitude, origin.longitude], [end.latitude, end.longitude]], {
    color,
    weight: 4,
    opacity: 0.9,
  }).addTo(overlayLayer);
  for (let index = 0; index < arrows; index += 1) {
    const fraction = 0.76 - index * 0.08;
    addArrowHead(origin, end, fraction, color, vector.bearingTrueDegrees);
  }
}

function addArrowHead(origin, end, fraction, color, bearing) {
  const point = {
    latitude: origin.latitude + (end.latitude - origin.latitude) * fraction,
    longitude: origin.longitude + (end.longitude - origin.longitude) * fraction,
  };
  const left = destination(point, bearing + 150, 35);
  const right = destination(point, bearing - 150, 35);
  L.polyline([[left.latitude, left.longitude], [point.latitude, point.longitude], [right.latitude, right.longitude]], {
    color,
    weight: 3,
    opacity: 0.9,
  }).addTo(overlayLayer);
}

function destination(position, bearingDegrees, distanceMeters) {
  const radius = 6371008.8;
  const bearing = bearingDegrees * Math.PI / 180;
  const lat1 = position.latitude * Math.PI / 180;
  const lon1 = position.longitude * Math.PI / 180;
  const angular = distanceMeters / radius;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { latitude: lat2 * 180 / Math.PI, longitude: lon2 * 180 / Math.PI };
}

function distanceMeters(a, b) {
  const radius = 6371008.8;
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDegrees(a, b) {
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function radToDegrees(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return ((number * 180 / Math.PI) % 360 + 360) % 360;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "n/a";
  const number = Number(seconds);
  if (!Number.isFinite(number)) return "n/a";
  if (number < 90) return `${Math.round(number)} s ago`;
  return `${Math.round(number / 60)} min ago`;
}

function formatPosition(position) {
  if (!position) return "n/a";
  return formatLatLon({ lat: position.latitude, lng: position.longitude });
}

function formatMeters(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)} m` : "n/a";
}

function formatDistance(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const meters = Number(value);
  if (!Number.isFinite(meters)) return "n/a";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1852).toFixed(meters < 3704 ? 1 : 0)} miles`;
}

function formatKnots(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * mpsToKnots).toFixed(1)} kn` : "n/a";
}

function formatDegrees(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)} deg` : "n/a";
}

function navigationReferenceSummary(state) {
  const navigationReference = state?.navigationProvenance?.navigationReference;
  const contractAccepted =
    navigationReference?.contract === navigationReferenceContract &&
    navigationReference?.schemaVersion === navigationReferenceSchemaVersion;
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

function formatAgeValue(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "n/a";
  const number = Number(seconds);
  return Number.isFinite(number) ? `${number < 10 ? number.toFixed(1) : Math.round(number)} s` : "n/a";
}

function formatAngleUncertainty(degrees) {
  if (degrees === null || degrees === undefined || degrees === "") return "n/a";
  const number = Number(degrees);
  return Number.isFinite(number) ? `±${number.toFixed(1)} deg` : "n/a";
}

function formatDependency(value) {
  if (value === true) return "GPS-dependent";
  if (value === false) return "Independent";
  return "Unknown";
}

function formatComparison(value) {
  if (value === true) return "Active";
  if (value === false) return "Not active";
  return "Unknown";
}

function formatDrProvenance(dr) {
  const provenance = dr?.provenance || {};
  return formatProvenanceSources({
    trackThroughWater: provenanceSource(provenance.trackThroughWater),
    heading: provenanceSource(provenance.heading),
    speedThroughWater: provenanceSource(provenance.speedThroughWater),
    current: provenanceSource(provenance.current),
    leeway: provenanceSource(provenance.leeway),
  });
}

function formatPlotFixProvenance(plotFix) {
  return formatProvenanceSources({
    trackThroughWater: plotFix.drTrackThroughWaterSource,
    heading: plotFix.drHeadingSource,
    speedThroughWater: plotFix.drSpeedThroughWaterSource,
    current: plotFix.drCurrentSource,
    leeway: plotFix.drLeewaySource,
  });
}

function formatIntegrityPlotFixProvenance(plotFix) {
  return formatProvenanceSources({
    trackThroughWater: plotFix.integrityTrackThroughWaterSource,
    heading: plotFix.integrityHeadingSource,
    speedThroughWater: plotFix.integritySpeedThroughWaterSource,
    current: plotFix.integrityCurrentSource,
    leeway: plotFix.integrityLeewaySource,
  });
}

function formatProvenanceSources(value) {
  const parts = [
    value.trackThroughWater ? `water track ${value.trackThroughWater}` : null,
    !value.trackThroughWater && value.heading ? `heading ${value.heading}` : null,
    value.speedThroughWater ? `STW ${value.speedThroughWater}` : null,
    value.current ? `current ${value.current}` : null,
    value.leeway ? `leeway ${value.leeway}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "n/a";
}

function currentVectorLabel(origin) {
  if (origin === "ground-minus-water-residual") return "Residual drift / set";
  return origin ? "Current drift / set" : "Current/residual drift / set";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function colorForTrust(trust) {
  if (trust === "normal") return "#16a34a";
  if (trust === "degraded") return "#ca8a04";
  return "#dc2626";
}

function updateGpsStatusIndicator(state) {
  const status = classifyGpsStatus(state);
  elements.gpsStatusIndicator.classList.remove(
    "ajrm-marine-gps-status-ok",
    "ajrm-marine-gps-status-alert",
    "ajrm-marine-gps-status-unknown",
  );
  elements.gpsStatusIndicator.classList.add(`ajrm-marine-gps-status-${status.kind}`);
  elements.gpsStatusText.textContent = status.label;
  elements.gpsStatusIndicator.title = status.title;
}

function classifyGpsStatus(state) {
  const gps = state?.gps || {};
  const trust = String(state?.trust || "").toLowerCase();
  if (gps.fixValid === false || trust === "lost" || trust === "unavailable") {
    return {
      kind: "alert",
      label: "GPS LOST",
      title: "GPS position is missing or invalid",
    };
  }
  if (
    gps.fixValid === true &&
    ["normal", "trusted", "ok", "accepted"].includes(trust)
  ) {
    return {
      kind: "ok",
      label: "GPS OK",
      title: "GPS received OK",
    };
  }
  if (trust) {
    return {
      kind: "alert",
      label: "GPS ALERT",
      title: `GPS integrity state: ${trust}`,
    };
  }
  return {
    kind: "unknown",
    label: "GPS ?",
    title: "GPS status unknown",
  };
}

async function refreshStatus() {
  try {
    latestStatus = await requestJson(`${apiBase}/status`);
    applyCoordinateFormat(
      coordinateFormatOverride || latestStatus.coordinateFormat || "dms",
      { persist: false },
    );
    if (
      latestStatus.plotFixIntervalMinutes != null &&
      document.activeElement !== elements.plotInterval
    ) {
      elements.plotInterval.value = String(latestStatus.plotFixIntervalMinutes);
      updatePlotStatus();
    }
    if (!map) initMap(latestStatus.defaults);
    if (latestStatus.operationalTrackUpdatedAt && latestStatus.operationalTrackUpdatedAt !== lastOperationalTrackUpdatedAt) {
      lastOperationalTrackUpdatedAt = latestStatus.operationalTrackUpdatedAt;
      loadOperationalTrack();
    }
    if (latestStatus.plotFixesUpdatedAt && latestStatus.plotFixesUpdatedAt !== lastPlotFixesUpdatedAt) {
      lastPlotFixesUpdatedAt = latestStatus.plotFixesUpdatedAt;
      loadPlotFixes();
    }
    renderIntegrity(latestStatus.ajrmMarineGpsIntegrity);
  } catch (error) {
    showToast(error.message || "Unable to refresh DR state", true);
    updateGpsStatusIndicator(null);
  }
}

elements.toggleStatus.addEventListener("click", () => {
  elements.statusDrawer.classList.toggle("open");
  updateControlButtonStates();
});
elements.toggleCharts.addEventListener("click", () => {
  elements.chartDrawer.classList.toggle("open");
  updateControlButtonStates();
});
elements.centreOwnship.addEventListener("click", recenterOnOwnship);
elements.plotNow.addEventListener("click", () => addPlotFix(createPlotFix(latestStatus?.ajrmMarineGpsIntegrity, false, "manual")));
elements.plotNowDrawer.addEventListener("click", () => addPlotFix(createPlotFix(latestStatus?.ajrmMarineGpsIntegrity, false, "manual")));
elements.clearPlots.addEventListener("click", clearPlotFixes);
elements.clearAllPlots.addEventListener("click", clearAllPlots);
elements.pickManualFixFromCursor.addEventListener("click", startManualFixPickMode);
elements.applyManualFix.addEventListener("click", applyManualFix);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && manualFixPickMode) stopManualFixPickMode();
});
elements.prunePlotFixes.addEventListener("click", pruneOldPlotFixes);
elements.plotInterval.addEventListener("change", () => {
  updatePlotStatus();
  savePlotIntervalSetting();
});
elements.coordinateFormat.addEventListener("change", () => {
  applyCoordinateFormat(elements.coordinateFormat.value);
});
elements.mapFollowLookAhead.addEventListener("input", () => {
  applyMapFollowLookAheadSetting(elements.mapFollowLookAhead.value);
  if (mapFollowSelf) recenterOnOwnship();
});
for (const choice of elements.baseMapChoices) {
  choice.addEventListener("change", () => setBaseMap(choice.value));
}
elements.autoCharts.addEventListener("change", () => setAutoChartsEnabled(elements.autoCharts.checked));
elements.openSeaMap.addEventListener("change", () => setOverlay(seamarkLayer, elements.openSeaMap.checked, "ajrmMarineDrPlotterOpenSeaMap"));

applyMapFollowLookAheadSetting();
refreshStatus();
setInterval(refreshStatus, 1000);
setInterval(refreshActiveRoute, 5000);
