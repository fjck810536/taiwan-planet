import { feature as topoFeature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { sanitizeFeature } from "./geo.js";
import { buildSolvedProjection, auditProjectedAreas, FINAL_AUDIT_EDGE_DEG, TARGET_MAX_COLAT_DEG } from "./solver_v2.js";
import { createTaiwanView } from "./view.js";

const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const statusEl = document.querySelector("#status");
const view = createTaiwanView(stage, labelsLayer);

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
