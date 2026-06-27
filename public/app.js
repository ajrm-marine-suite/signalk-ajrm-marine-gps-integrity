const apiBase = "/plugins/signalk-ajrm-marine-gps-integrity";
const trust = document.querySelector("#trust");
const subtitle = document.querySelector("#subtitle");
const summary = document.querySelector("#summary");
const gpsFacts = document.querySelector("#gpsFacts");
const drFacts = document.querySelector("#drFacts");
const counterFacts = document.querySelector("#counterFacts");
const reasons = document.querySelector("#reasons");
const stateCard = document.querySelector("#stateCard");
const alertsEnabled = document.querySelector("#alertsEnabled");
const settingsStatus = document.querySelector("#settingsStatus");
let savingSettings = false;

function renderFacts(element, facts) {
  element.innerHTML = "";
  for (const [label, value] of facts) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    element.append(term, detail);
  }
}

function renderStatus(data) {
  const state = data.state || {};
  const sample = data.sample || {};
  stateCard.dataset.trust = state.trust || "unknown";
  trust.textContent = (state.trust || "unknown").toUpperCase();
  subtitle.textContent = `Provider v${data.version}`;
  if (!savingSettings) {
    alertsEnabled.checked = data.alertsEnabled !== false;
  }
  const counters = state.counters || {};
  const errorCount = (counters.rejectedFixes || 0) + (counters.lostFixes || 0) + (counters.degradedSignals || 0);
  summary.textContent = state.reasons?.[0] || `GPS integrity is normal. ${errorCount} detected issues since start.`;
  const gps = state.gps || {};
  const operationalDr = state.operationalDeadReckoning || state.deadReckoning || {};
  const integrityDr = state.integrityDeadReckoning || {};
  renderFacts(gpsFacts, [
    ["Source", sample.source || "canonical"],
    ["Fix", gps.fixValid ? "Valid" : "Missing"],
    ["HDOP", gps.hdop ?? "n/a"],
    ["Satellites", gps.satellites ?? "n/a"],
    ["SOG", gps.speedOverGround == null ? "n/a" : `${(gps.speedOverGround * 1.943844492).toFixed(1)} kn`],
    ["Sample SOG", sample.speedOverGround == null ? "n/a" : `${(sample.speedOverGround * 1.943844492).toFixed(1)} kn`],
    ["Sample STW", sample.speedThroughWater == null ? "n/a" : `${(sample.speedThroughWater * 1.943844492).toFixed(1)} kn`],
    ["Sample COG", sample.courseOverGroundTrue == null ? "n/a" : `${(sample.courseOverGroundTrue * 180 / Math.PI).toFixed(0)} deg`],
    ["Sample HDG", sample.headingTrue == null ? "n/a" : `${(sample.headingTrue * 180 / Math.PI).toFixed(0)} deg`],
  ]);
  renderFacts(drFacts, [
    ["Operational source", operationalDr.source || "n/a"],
    ["Operational age", operationalDr.ageSeconds == null ? "n/a" : `${Math.round(operationalDr.ageSeconds)} s`],
    [
      "Operational uncertainty",
      operationalDr.uncertaintyRadiusMeters == null ? "n/a" : `${Math.round(operationalDr.uncertaintyRadiusMeters)} m`,
    ],
    ["Integrity source", integrityDr.source || "n/a"],
    ["Integrity age", integrityDr.ageSeconds == null ? "n/a" : `${Math.round(integrityDr.ageSeconds)} s`],
    [
      "Integrity uncertainty",
      integrityDr.uncertaintyRadiusMeters == null ? "n/a" : `${Math.round(integrityDr.uncertaintyRadiusMeters)} m`,
    ],
    [
      "Integrity realign",
      integrityDr.realignIntervalSeconds == null ? "n/a" : `${Math.round(integrityDr.realignIntervalSeconds / 60)} min`,
    ],
  ]);
  renderFacts(counterFacts, [
    ["Evaluations", formatCount(counters.evaluations)],
    ["Accepted fixes", formatCount(counters.acceptedFixes)],
    ["Rejected fixes", formatCount(counters.rejectedFixes)],
    ["Position jumps", formatCount(counters.positionJumps)],
    ["GPS outages", formatCount(counters.lostFixes)],
    ["Weak signal", formatCount(counters.degradedSignals)],
    ["DR mismatch", formatCount(counters.drDiscrepancies)],
  ]);
  reasons.innerHTML = "";
  for (const reason of state.reasons || ["No active warning."]) {
    const item = document.createElement("li");
    item.textContent = reason;
    reasons.append(item);
  }
}

function formatCount(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "0";
}

alertsEnabled.addEventListener("change", async () => {
  savingSettings = true;
  settingsStatus.textContent = "Saving...";
  alertsEnabled.disabled = true;
  try {
    const response = await fetch(`${apiBase}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ alertsEnabled: alertsEnabled.checked }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    alertsEnabled.checked = body.alertsEnabled !== false;
    settingsStatus.textContent = alertsEnabled.checked ? "Alerts enabled" : "Alerts disabled";
    renderStatus(body);
  } catch (error) {
    settingsStatus.textContent = error.message || "Unable to save alert setting.";
    await refresh();
  } finally {
    alertsEnabled.disabled = false;
    savingSettings = false;
  }
});

async function refresh() {
  try {
    const response = await fetch(`${apiBase}/status`, { headers: { Accept: "application/json" } });
    renderStatus(await response.json());
  } catch (error) {
    trust.textContent = "OFFLINE";
    summary.textContent = error.message || "Unable to read GPS integrity state.";
    stateCard.dataset.trust = "lost";
  }
}

refresh();
setInterval(refresh, 2000);
