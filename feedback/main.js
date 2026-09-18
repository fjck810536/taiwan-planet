import { feature as topoFeature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { sanitizeFeature } from "./geo.js";
import { buildSolvedProjection, auditProjectedAreas as auditCurrentAreas, FINAL_AUDIT_EDGE_DEG } from "./solver_laea.js";
import { auditProjectedAreas as auditBaselineAreas } from "./solver.js";
import { buildSolvedProjection as buildBaselineProjection } from "./solver_146_baseline.js";
import { createTaiwanView } from "./view.js";

const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const view = createTaiwanView(stage, labelsLayer);

const priorityMonitorBody = document.querySelector("#priority-monitor-body");
const BOOST_GROUPS = [
  ["台北", ["台北市|北投區", "台北市|士林區", "台北市|內湖區"]],
  ["新北", ["新北市|林口區", "新北市|八里區", "新北市|蘆洲區", "新北市|淡水區", "新北市|三芝區", "新北市|金山區", "新北市|萬里區", "新北市|石門區", "新北市|貢寮區", "新北市|雙溪區", "新北市|平溪區", "新北市|坪林區"]],
  ["基隆", ["基隆市|仁愛區", "基隆市|安樂區", "基隆市|暖暖區"]],
  ["宜蘭", ["宜蘭縣|頭城鎮", "宜蘭縣|礁溪鄉", "宜蘭縣|宜蘭市", "宜蘭縣|員山鄉", "宜蘭縣|羅東鎮", "宜蘭縣|三星鄉", "宜蘭縣|冬山鄉"]]
];

const SHRINK_GROUPS = [
  ["南投", ["南投縣"]],
  ["嘉義", ["嘉義縣", "嘉義市"]],
  ["花蓮", ["花蓮縣"]]
];

function keysForCounties(rows, counties) {
  const allowed = new Set(counties);
  return [...rows.values()]
    .filter(row => allowed.has(row.stat?.county))
    .map(row => row.key)
    .sort((a, b) => townOnly(a).localeCompare(townOnly(b), "zh-Hant"));
}

function townOnly(regionKey) {
  return regionKey.split("|")[1] || regionKey;
}

function renderRegionGroup(container, groupName, keys, currentRows, baselineRows) {
  const group = document.createElement("section");
  group.className = "monitor-group";

  const ratios = keys.map(key => {
    const current = currentRows.get(key);
    const baseline = baselineRows.get(key);
    if (!current || !baseline || baseline.actualArea <= 0) return null;
    return current.actualArea / baseline.actualArea;
  }).filter(value => Number.isFinite(value));

  const mean = ratios.length
    ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    : 0;

  const heading = document.createElement("div");
  heading.className = "monitor-group-title";
  heading.innerHTML = `<span>${groupName}</span><strong>${mean.toFixed(2)}×</strong>`;
  group.appendChild(heading);

  for (const key of keys) {
    const current = currentRows.get(key);
    const baseline = baselineRows.get(key);
    const item = document.createElement("div");
    item.className = "monitor-row";

    if (!current || !baseline || baseline.actualArea <= 0) {
      item.innerHTML = `<span>${townOnly(key)}</span><span class="monitor-missing">—</span>`;
    } else {
      const ratio = current.actualArea / baseline.actualArea;
      const deltaPct = (ratio - 1) * 100;
      item.dataset.change = Math.abs(deltaPct) < 2 ? "flat" : (deltaPct > 0 ? "up" : "down");
      const sign = deltaPct >= 0 ? "+" : "";
      item.innerHTML = `<span>${townOnly(key)}</span><span class="monitor-pair"><b>${ratio.toFixed(2)}×</b><i>${sign}${deltaPct.toFixed(0)}%</i></span>`;
    }
    group.appendChild(item);
  }
  container.appendChild(group);
}

function addMonitorSectionTitle(text, mode) {
  const el = document.createElement("div");
  el.className = `monitor-section-title ${mode}`;
  el.textContent = text;
  priorityMonitorBody.appendChild(el);
}

function renderPriorityMonitor(currentAudit, baselineAudit) {
  if (!priorityMonitorBody) return;
  const currentRows = new Map(currentAudit.rows.map(row => [row.key, row]));
  const baselineRows = new Map(baselineAudit.rows.map(row => [row.key, row]));
  priorityMonitorBody.replaceChildren();

  addMonitorSectionTitle("重點增幅", "boost");
  for (const [groupName, keys] of BOOST_GROUPS) {
    renderRegionGroup(priorityMonitorBody, groupName, keys, currentRows, baselineRows);
  }

  addMonitorSectionTitle("重點縮小", "shrink");
  for (const [groupName, counties] of SHRINK_GROUPS) {
    const keys = keysForCounties(currentRows, counties);
    renderRegionGroup(priorityMonitorBody, groupName, keys, currentRows, baselineRows);
  }
}

async function loadTaiwan() {
  try {
    const res = await fetch(DATA_URL, { cache: "force-cache" });
    if (!res.ok) throw new Error(`TopoJSON ${res.status}`);
    const topology = await res.json();
    const object = topology.objects.towns || Object.values(topology.objects)[0];
    const collection = topoFeature(topology, object);
    const features = collection.features.map(sanitizeFeature).filter(Boolean);
    if (!features.length) throw new Error("找不到台灣本島行政區");

    const projection = buildSolvedProjection(features);
    const baselineProjection = buildBaselineProjection(features);
    const currentRenderedAudit = auditCurrentAreas(
      projection.towns,
      projection,
      FINAL_AUDIT_EDGE_DEG,
      true
    );
    const baselineRenderedAudit = auditBaselineAreas(
      baselineProjection.towns,
      baselineProjection,
      FINAL_AUDIT_EDGE_DEG,
      false
    );
    renderPriorityMonitor(currentRenderedAudit, baselineRenderedAudit);
    view.setProjection(projection);
    view.buildLand(features);
    view.buildLabels(features);

    document.body.classList.add("ready");
  } catch (err) {
    console.error(err);
  }
}

loadTaiwan();
