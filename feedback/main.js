import { feature as topoFeature, merge as topoMerge } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { sanitizeFeature, featureCountyName } from "./geo.js";
import { buildSolvedProjection } from "./solver_v2.js";
import { createTaiwanView } from "./view.js";

const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const KEEP_TOWN_BORDERS = new Set(["台北市", "新北市", "基隆市"]);

const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const view = createTaiwanView(stage, labelsLayer);

function buildDisplayFeatures(topology, object, collection) {
  const sourceGeometries = object?.geometries || [];
  const keptTownFeatures = [];
  const countyGeometries = new Map();

  for (let i = 0; i < collection.features.length; i++) {
    const sourceFeature = collection.features[i];
    const sanitized = sanitizeFeature(sourceFeature);
    if (!sanitized) continue;

    const county = featureCountyName(sanitized);
    if (KEEP_TOWN_BORDERS.has(county)) {
      keptTownFeatures.push(sanitized);
      continue;
    }

    const geometry = sourceGeometries[i];
    if (!geometry) continue;
    if (!countyGeometries.has(county)) countyGeometries.set(county, []);
    countyGeometries.get(county).push(geometry);
  }

  const mergedCounties = [];
  for (const [county, geometries] of countyGeometries) {
    if (!geometries.length) continue;
    const mergedGeometry = topoMerge(topology, geometries);
    const mergedFeature = sanitizeFeature({
      type: "Feature",
      properties: {
        COUNTYNAME: county,
        TOWNNAME: county
      },
      geometry: mergedGeometry
    });
    if (mergedFeature) mergedCounties.push(mergedFeature);
  }

  return [...keptTownFeatures, ...mergedCounties];
}

async function loadTaiwan() {
  try {
    const res = await fetch(DATA_URL, { cache: "force-cache" });
    if (!res.ok) throw new Error(`TopoJSON ${res.status}`);

    const topology = await res.json();
    const object = topology.objects.towns || Object.values(topology.objects)[0];
    const collection = topoFeature(topology, object);

    // Solver geometry stays exactly at town level so the accepted 170° shape
    // and all existing deformation logic remain unchanged.
    const solverFeatures = collection.features.map(sanitizeFeature).filter(Boolean);
    if (!solverFeatures.length) throw new Error("找不到台灣本島行政區");

    // Display only: keep districts for Taipei / New Taipei / Keelung.
    // Everywhere else is dissolved to one feature per county/city.
    const displayFeatures = buildDisplayFeatures(topology, object, collection);

    const projection = buildSolvedProjection(solverFeatures);
    view.setProjection(projection);
    view.buildLand(displayFeatures);
    view.buildLabels(displayFeatures);

    document.body.classList.add("ready");
  } catch (err) {
    console.error(err);
  }
}

loadTaiwan();
