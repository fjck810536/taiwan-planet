import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "three";
import { feature as topoFeature, merge as topoMerge } from "topojson-client";

const ROOT = process.cwd();
const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const OUT_DIR = path.join(ROOT, "baked");
const TMP_DIR = path.join(ROOT, ".bake-runtime");

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.rm(TMP_DIR, { recursive: true, force: true });
await fs.mkdir(TMP_DIR, { recursive: true });

async function transformModule(srcPath, outName) {
  let source = await fs.readFile(path.join(ROOT, srcPath), "utf8");
  source = source
    .replace(
      /https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.180\.0\/build\/three\.module\.js/g,
      "three"
    )
    .replace(/\.\/geo\.js/g, "./geo.mjs");
  const outPath = path.join(TMP_DIR, outName);
  await fs.writeFile(outPath, source);
  return outPath;
}

const geoPath = await transformModule("feedback/geo.js", "geo.mjs");
const solverPath = await transformModule("feedback/solver.js", "solver.mjs");
const solverV2Path = await transformModule("feedback/solver_v2.js", "solver_v2.mjs");

const geo = await import(pathToFileURL(geoPath).href);
const renderSolver = await import(pathToFileURL(solverPath).href);
const solverV2 = await import(pathToFileURL(solverV2Path).href);

const response = await fetch(DATA_URL);
if (!response.ok) throw new Error(`TopoJSON fetch failed: ${response.status}`);
const topology = await response.json();
const object = topology.objects.towns || Object.values(topology.objects)[0];
const collection = topoFeature(topology, object);
const sourceGeometries = object.geometries || [];

const solverFeatures = collection.features.map(geo.sanitizeFeature).filter(Boolean);
if (!solverFeatures.length) throw new Error("No mainland Taiwan features");

const projection = solverV2.buildSolvedProjection(solverFeatures);
if (solverV2.TARGET_MAX_COLAT_DEG !== 170) {
  throw new Error(`Expected 170°, got ${solverV2.TARGET_MAX_COLAT_DEG}`);
}
const neihu = solverFeatures.find(f =>
  geo.featureCountyName(f) === "台北市" && geo.featureTownName(f) === "內湖區"
);
if (!neihu) throw new Error("Neihu center source feature missing");

const TAIPEI = "台北市";
const NEW_TAIPEI = "新北市";
const KEELUNG = "基隆市";
const shortName = value => String(value || "").replace(/[縣市]$/, "");

function mergedFeature(label, geometries) {
  if (!geometries.length) return null;
  const merged = geo.sanitizeFeature({
    type: "Feature",
    properties: {
      COUNTYNAME: label,
      TOWNNAME: label,
      DISPLAY_LABEL: label,
      REGION_ID: label
    },
    geometry: topoMerge(topology, geometries)
  });
  return merged;
}

const display = [];
const keelung = [];
const mergedByName = new Map();

for (let i = 0; i < collection.features.length; i++) {
  const sanitized = geo.sanitizeFeature(collection.features[i]);
  if (!sanitized) continue;
  const county = geo.featureCountyName(sanitized);
  const town = geo.featureTownName(sanitized);
  const geometry = sourceGeometries[i];

  if (county === TAIPEI || county === NEW_TAIPEI) {
    display.push({
      feature: sanitized,
      id: `${county}|${town}`,
      label: town,
      colorSeed: county
    });
    continue;
  }

  if (!geometry) continue;
  if (county === KEELUNG) {
    keelung.push(geometry);
    continue;
  }

  const name = shortName(county);
  if (!mergedByName.has(name)) mergedByName.set(name, []);
  mergedByName.get(name).push(geometry);
}

const keelungFeature = mergedFeature("基隆", keelung);
if (keelungFeature) {
  display.push({ feature: keelungFeature, id: "基隆", label: "基隆", colorSeed: "基隆" });
}
for (const [name, geometries] of mergedByName) {
  const merged = mergedFeature(name, geometries);
  if (merged) display.push({ feature: merged, id: name, label: name, colorSeed: name });
}

const MAX_MESH_EDGE_DEG = 5;
const MAX_BORDER_EDGE_DEG = 4;
const land = [];
const borders = [];
const regions = [];

const midpointCoord = (a,b) => [(a[0]+b[0])/2,(a[1]+b[1])/2];
const mappedUnit = coord =>
  renderSolver.geoToVector3WithProjection(coord[0], coord[1], projection, 1).normalize();
const sourceXY = (lon,lat) =>
  renderSolver.sourceLocalXYForProjection(lon,lat,projection);

function pushUnit(target, v) {
  const n = v.clone().normalize();
  target.push(
    Math.round(THREE.MathUtils.clamp(n.x,-1,1)*32767),
    Math.round(THREE.MathUtils.clamp(n.y,-1,1)*32767),
    Math.round(THREE.MathUtils.clamp(n.z,-1,1)*32767)
  );
}

function emitTriangle(target,a,b,c,depth=0) {
  const ua=mappedUnit(a), ub=mappedUnit(b), uc=mappedUnit(c);
  const maxEdge=Math.max(ua.angleTo(ub),ub.angleTo(uc),uc.angleTo(ua));
  if (maxEdge > THREE.MathUtils.degToRad(MAX_MESH_EDGE_DEG) && depth < 6) {
    const ab=midpointCoord(a,b), bc=midpointCoord(b,c), ca=midpointCoord(c,a);
    emitTriangle(target,a,ab,ca,depth+1);
    emitTriangle(target,ab,b,bc,depth+1);
    emitTriangle(target,ca,bc,c,depth+1);
    emitTriangle(target,ab,bc,ca,depth+1);
    return;
  }
  pushUnit(target,ua); pushUnit(target,ub); pushUnit(target,uc);
}

function addBorder(a,b) {
  const ua=mappedUnit(a), ub=mappedUnit(b);
  const steps=Math.max(1,Math.ceil(
    THREE.MathUtils.radToDeg(ua.angleTo(ub))/MAX_BORDER_EDGE_DEG
  ));
  let prev=a;
  for (let i=1;i<=steps;i++) {
    const t=i/steps;
    const next=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
    pushUnit(borders,mappedUnit(prev));
    pushUnit(borders,mappedUnit(next));
    prev=next;
  }
}

function addPolygon(featurePolygon) {
  if (!featurePolygon?.length) return;
  const outer=geo.cleanRing(featurePolygon[0]);
  if (outer.length<3) return;
  const holes=featurePolygon.slice(1).map(geo.cleanRing).filter(r=>r.length>=3);
  const contour=outer.map(([lon,lat])=>sourceXY(lon,lat));
  const holeContours=holes.map(r=>r.map(([lon,lat])=>sourceXY(lon,lat)));
  const faces=THREE.ShapeUtils.triangulateShape(contour,holeContours);
  const all=outer.concat(...holes);
  for (const tri of faces) emitTriangle(land,all[tri[0]],all[tri[1]],all[tri[2]]);
  for (const ring of [outer,...holes]) {
    for (let i=0;i<ring.length;i++) addBorder(ring[i],ring[(i+1)%ring.length]);
  }
}

for (const item of display) {
  const start=land.length/3;
  const g=item.feature.geometry;
  if (g.type==="Polygon") addPolygon(g.coordinates);
  else if (g.type==="MultiPolygon") for (const p of g.coordinates) addPolygon(p);
  const count=land.length/3-start;

  const [lon,lat]=geo.centroidOfFeature(item.feature);
  const anchor=mappedUnit([lon,lat]);
  const anchorQ=[
    Math.round(anchor.x*32767),
    Math.round(anchor.y*32767),
    Math.round(anchor.z*32767)
  ];

  regions.push({
    id:item.id,
    label:item.label,
    colorSeed:item.colorSeed,
    start,
    count,
    anchor:anchorQ
  });
}

const landArray=Int16Array.from(land);
const borderArray=Int16Array.from(borders);
const binary=Buffer.concat([
  Buffer.from(landArray.buffer,landArray.byteOffset,landArray.byteLength),
  Buffer.from(borderArray.buffer,borderArray.byteOffset,borderArray.byteLength)
]);

const meta={
  version:1,
  projection:"stereographic-neihu-170-baked",
  quantization:"snorm16",
  landValues:landArray.length,
  borderValues:borderArray.length,
  landVertices:landArray.length/3,
  borderVertices:borderArray.length/3,
  regions,
  grouping:{
    taipei:"districts",
    newTaipei:"districts",
    keelung:"merged",
    sameNameCountyCity:"merged-by-short-name"
  }
};

await fs.writeFile(path.join(OUT_DIR,"map.bin"),binary);
await fs.writeFile(path.join(OUT_DIR,"meta.json"),JSON.stringify(meta));

console.log(JSON.stringify({
  regions:regions.length,
  landVertices:meta.landVertices,
  borderVertices:meta.borderVertices,
  binaryBytes:binary.length,
  projection:meta.projection
},null,2));
