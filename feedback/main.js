import { feature as topoFeature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { sanitizeFeature } from "./geo.js";
import { buildSolvedProjection, auditProjectedAreas, FINAL_AUDIT_EDGE_DEG, TARGET_MAX_COLAT_DEG } from "./solver_v2.js";
import { createTaiwanView } from "./view.js";

const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const statusEl = document.querySelector("#status");
const view = createTaiwanView(stage, labelsLayer);

const priorityMonitorBody = document.querySelector("#priority-monitor-body");
const PRIORITY_GROUPS = [
  ["台北", ["台北市|北投區", "台北市|士林區", "台北市|內湖區"]],
  ["新北", ["新北市|金山區", "新北市|三芝區", "新北市|石門區", "新北市|貢寮區", "新北市|雙溪區", "新北市|平溪區", "新北市|坪林區"]],
  ["基隆", ["基隆市|仁愛區", "基隆市|安樂區", "基隆市|暖暖區"]],
  ["宜蘭", ["宜蘭縣|頭城鎮", "宜蘭縣|礁溪鄉", "宜蘭縣|宜蘭市", "宜蘭縣|員山鄉", "宜蘭縣|羅東鎮", "宜蘭縣|三星鄉", "宜蘭縣|冬山鄉"]]
];

function townOnly(regionKey) {
  return regionKey.split("|")[1] || regionKey;
}

function renderPriorityMonitor(audit) {
  if (!priorityMonitorBody) return;
  const rows = new Map(audit.rows.map(row => [row.key, row]));
  priorityMonitorBody.replaceChildren();

  for (const [groupName, keys] of PRIORITY_GROUPS) {
    const group = document.createElement("section");
    group.className = "monitor-group";

    const validRows = keys.map(key => rows.get(key)).filter(Boolean);
    const mean = validRows.length
      ? validRows.reduce((sum, row) => sum + row.actualFactor, 0) / validRows.length
      : 0;

    const heading = document.createElement("div");
    heading.className = "monitor-group-title";
    heading.innerHTML = `<span>${groupName}</span><strong>${mean.toFixed(2)}×</strong>`;
    group.appendChild(heading);

    for (const key of keys) {
      const row = rows.get(key);
      const item = document.createElement("div");
      item.className = "monitor-row";
      if (!row) {
        item.innerHTML = `<span>${townOnly(key)}</span><span class="monitor-missing">—</span>`;
      } else {
        const delta = row.actualFactor - row.targetFactor;
        item.dataset.state = Math.abs(delta) <= 0.05 ? "near" : (delta > 0 ? "over" : "under");
        item.innerHTML = `<span>${townOnly(key)}</span><span><b>${row.actualFactor.toFixed(2)}×</b><i>/ ${row.targetFactor.toFixed(2)}</i></span>`;
      }
      group.appendChild(item);
    }
    priorityMonitorBody.appendChild(group);
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

    statusEl.textContent = `計算 ${TARGET_MAX_COLAT_DEG}° 面積 feedback…`;
    const projection = buildSolvedProjection(features);
    const audit = auditProjectedAreas(projection.towns, projection, FINAL_AUDIT_EDGE_DEG, true);
    renderPriorityMonitor(audit);
    view.setProjection(projection);
    view.buildLand(features);
    view.buildLabels(features);

    const worstText = audit.worst.map(x => `${x.region} ${x.actual.toFixed(2)}×/目標${x.target.toFixed(2)}`).join("・");
    statusEl.textContent = `本島行政區 ${features.length} 個・${TARGET_MAX_COLAT_DEG}°・feedback×${projection.feedbackPasses}・${worstText}`;
    document.body.classList.add("ready");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "台灣圖資載入失敗";
  }
}

loadTaiwan();
