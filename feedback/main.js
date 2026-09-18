import { feature as topoFeature, merge as topoMerge } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { sanitizeFeature, featureCountyName, featureTownName } from "./geo.js";
import { buildSolvedProjection } from "./solver_v2.js";
import { createTaiwanView } from "./view.js";

const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const TAIPEI = "台北市";
const NEW_TAIPEI = "新北市";
const KEELUNG = "基隆市";
const NEW_TAIPEI_STANDALONE = new Set(["板橋區", "新莊區"]);

const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const view = createTaiwanView(stage, labelsLayer);

function shortAdminName(name) {
  return String(name || "").replace(/[縣市]$/, "");
}

function mergedDisplayFeature(topology, county, label, geometries) {
  if (!geometries?.length) return null;
  const geometry = topoMerge(topology, geometries);
  return sanitizeFeature({
    type: "Feature",
    properties: {
      COUNTYNAME: county,
      TOWNNAME: label,
      DISPLAY_LABEL: label
    },
    geometry
  });
}

function buildDisplayFeatures(topology, object, collection) {
  const sourceGeometries = object?.geometries || [];
  const displayFeatures = [];

  const newTaipeiRest = [];
  const keelungAll = [];
  const mergedByName = new Map();

  for (let i = 0; i < collection.features.length; i++) {
    const sourceFeature = collection.features[i];
    const sanitized = sanitizeFeature(sourceFeature);
    if (!sanitized) continue;

    const county = featureCountyName(sanitized);
    const town = featureTownName(sanitized);
    const geometry = sourceGeometries[i];

    // Taipei and New Taipei keep every district as separate display areas.
    if (county === TAIPEI || county === NEW_TAIPEI) {
      displayFeatures.push(sanitized);
      continue;
    }

    // Keelung is fully dissolved and shown simply as "基隆".
    if (county === KEELUNG) {
      if (geometry) keelungAll.push(geometry);
      continue;
    }

    // Every other county/city is one dissolved display area.
    // The label drops the administrative suffix: 宜蘭縣 -> 宜蘭, 桃園市 -> 桃園.
    if (!geometry) continue;
    const mergedName = shortAdminName(county);
    if (!mergedByName.has(mergedName)) mergedByName.set(mergedName, []);
    mergedByName.get(mergedName).push(geometry);
  }

  const keelung = mergedDisplayFeature(topology, KEELUNG, "基隆", keelungAll);
  if (keelung) displayFeatures.push(keelung);

  for (const [name, geometries] of mergedByName) {
    const merged = mergedDisplayFeature(
      topology,
      name,
      name,
      geometries
    );
    if (merged) displayFeatures.push(merged);
  }

  return displayFeatures;
}

async function loadTaiwan() {
  try {
    const res = await fetch(DATA_URL, { cache: "force-cache" });
    if (!res.ok) throw new Error(`TopoJSON ${res.status}`);

    const topology = await res.json();
    const object = topology.objects.towns || Object.values(topology.objects)[0];
    const collection = topoFeature(topology, object);

    // Solver stays town-level: accepted Neihu-centered 170° geometry is unchanged.
    const solverFeatures = collection.features.map(sanitizeFeature).filter(Boolean);
    if (!solverFeatures.length) throw new Error("找不到台灣本島行政區");

    // Display-only administrative grouping.
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
