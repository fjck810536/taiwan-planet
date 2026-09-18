import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
import {
  featureKey, featureTownName, featureCountyName, centroidOfFeature, eachCoordinate,
  cleanRing, rawSourceXY, featurePlanarArea, featureGeoArea, buildCoastlineStats,
  sphericalTriangleArea
} from "./geo.js";

export const TARGET_MAX_COLAT_DEG = 115;
export const FINAL_AUDIT_EDGE_DEG = 1.5;
const QUICK_AUDIT_EDGE_DEG = 4.5;
const NANTOU_AREA_RETAIN = 0.35;
const ADJACENT_AREA_RETAIN = 0.90;
const MIDDLE_POOL_SHARE = 0.15;
const MIDDLE_GAIN_CAP = 0.20;
const COASTAL_GAIN_CAP = 2.50;
const COASTAL_RADIAL_POWER = 3;
const POLICY_WARP_STRENGTH = 0.88;
const POLICY_SIGMA_MULTIPLIER = 2.35;
const FEEDBACK_PASSES = 2;
const FEEDBACK_DONOR_THRESHOLD = 1.20;
const FEEDBACK_MAX_CONTROL_CUT = 0.35;
const FEEDBACK_MIN_CONTROL_FACTOR = 0.12;
const FEEDBACK_SOUTH_SHARE = 0.35;
const FEEDBACK_NORTH_SHARE = 0.30;
const FEEDBACK_SECOND_SHARE = 0.25;
const FEEDBACK_GENERAL_SHARE = 0.10;

const NANTOU_COUNTY = "南投縣";
const NANTOU_ADJACENT = new Set(["台中市", "彰化縣", "雲林縣", "嘉義縣", "高雄市", "花蓮縣"]);
const MIDDLE_RECEIVERS = new Set(["台北市", "嘉義市"]);

function allocateWithCaps(stats, amount, weightFn, maxFactor) {
  let remaining = amount;
  let active = stats.filter(s => weightFn(s) > 0 && s.sourceArea > 0);
  for (let pass = 0; pass < 12 && remaining > 1e-14 && active.length; pass++) {
    const totalWeight = active.reduce((sum, s) => sum + weightFn(s), 0);
    if (totalWeight <= 0) break;
    let distributed = 0;
    const next = [];
    for (const stat of active) {
      const capacity = Math.max(0, stat.sourceArea * maxFactor - stat.controlArea);
      if (capacity <= 1e-14) continue;
      const proposed = remaining * weightFn(stat) / totalWeight;
      const gain = Math.min(capacity, proposed);
      stat.controlArea += gain;
      distributed += gain;
      if (capacity - gain > 1e-14) next.push(stat);
    }
    if (distributed <= 1e-14) break;
    remaining -= distributed;
    active = next;
  }
  return remaining;
}

function sinkWeight(stat) {
  const tipBonus = stat.radial > 0.82 ? 1.65 : stat.radial > 0.70 ? 1.25 : 1;
  return Math.pow(stat.radial, COASTAL_RADIAL_POWER) * stat.coastExposure * tipBonus;
}
function isEligibleCoastalSink(stat) {
  return stat.coastExposure > 0.001 &&
    stat.county !== NANTOU_COUNTY &&
    !NANTOU_ADJACENT.has(stat.county) &&
    !MIDDLE_RECEIVERS.has(stat.county);
}
function isSouthPrimeSink(stat) {
  return isEligibleCoastalSink(stat) && stat.county === "屏東縣" && stat.lat < 22.25;
}
function isNorthPrimeSink(stat) {
  if (!isEligibleCoastalSink(stat)) return false;
  return stat.county === "基隆市" ||
    (stat.county === "新北市" && (stat.lat > 24.82 || stat.lon > 121.72));
}
function sinkTier(stat) {
  if (isSouthPrimeSink(stat)) return "south";
  if (isNorthPrimeSink(stat)) return "north";
  if (isEligibleCoastalSink(stat) && stat.radial >= 0.64) return "second";
  if (isEligibleCoastalSink(stat)) return "general";
  return "none";
}

function buildTownStats(features, centerLon, centerLat) {
  const coastline = buildCoastlineStats(features, centerLon, centerLat);
  const towns = new Map();
  let maxRadius = 1e-12;
  for (const f of features) {
    const key = featureKey(f);
    const [lon, lat] = centroidOfFeature(f);
    const center = rawSourceXY(centerLon, centerLat, lon, lat);
    maxRadius = Math.max(maxRadius, center.length());
    towns.set(key, {
      key, feature: f,
      county: featureCountyName(f), town: featureTownName(f),
      lon, lat, center,
      planarArea: featurePlanarArea(f, centerLon, centerLat),
      sourceArea: featureGeoArea(f, centerLon, centerLat),
      coastExposure: coastline.get(key)?.coastExposure || 0
    });
  }
  for (const s of towns.values()) {
    s.radial = THREE.MathUtils.clamp(s.center.length() / maxRadius, 0, 1);
    s.eqRadius = Math.sqrt(Math.max(s.planarArea, 1e-12) / Math.PI);
    s.baseTargetArea = s.sourceArea;
    s.controlArea = s.sourceArea;
  }
  return towns;
}

function applyBasePolicy(towns) {
  let pool = 0;
  for (const s of towns.values()) {
    if (s.county === NANTOU_COUNTY) {
      s.controlArea = s.sourceArea * NANTOU_AREA_RETAIN;
      pool += s.sourceArea - s.controlArea;
    } else if (NANTOU_ADJACENT.has(s.county)) {
      s.controlArea = s.sourceArea * ADJACENT_AREA_RETAIN;
      pool += s.sourceArea - s.controlArea;
    }
  }

  const middle = [...towns.values()].filter(s => MIDDLE_RECEIVERS.has(s.county));
  const middleBase = middle.reduce((sum, s) => sum + s.sourceArea, 0);
  const middleGain = Math.min(pool * MIDDLE_POOL_SHARE, middleBase * MIDDLE_GAIN_CAP);
  if (middleGain > 0 && middleBase > 0) {
    for (const s of middle) s.controlArea += middleGain * s.sourceArea / middleBase;
  }

  let coastalGain = pool - middleGain;
  const coastal = [...towns.values()].filter(isEligibleCoastalSink);
  coastalGain = allocateWithCaps(coastal, coastalGain, sinkWeight, COASTAL_GAIN_CAP);
  if (coastalGain > 1e-14 && middle.length) {
    allocateWithCaps(middle, coastalGain, s => s.sourceArea, 1 + MIDDLE_GAIN_CAP);
  }
  for (const s of towns.values()) s.baseTargetArea = s.controlArea;
}

function seedsFromTowns(towns) {
  return [...towns.values()].map(s => ({
    key: s.key,
    center: s.center,
    factor: s.sourceArea > 0 ? s.controlArea / s.sourceArea : 1,
    linearScale: Math.sqrt(Math.max(0.03, s.sourceArea > 0 ? s.controlArea / s.sourceArea : 1)),
    sigma: Math.max(0.0035, s.eqRadius * POLICY_SIGMA_MULTIPLIER)
  }));
}
export function warpSourceXY(raw, seeds, strength = POLICY_WARP_STRENGTH) {
  if (!seeds?.length || strength <= 0) return raw.clone();
  let dx = 0, dy = 0, totalW = 0;
  for (const seed of seeds) {
    const ox = raw.x - seed.center.x;
    const oy = raw.y - seed.center.y;
    const d2 = ox * ox + oy * oy;
    const sigma2 = seed.sigma * seed.sigma;
    const w = Math.exp(-d2 / (2 * sigma2));
    if (w < 1e-5) continue;
    const delta = seed.linearScale - 1;
    dx += w * delta * ox;
    dy += w * delta * oy;
    totalW += w;
  }
  const norm = Math.max(1, totalW);
  return new THREE.Vector2(raw.x + strength * dx / norm, raw.y + strength * dy / norm);
}

function buildProjectionFromTowns(features, centerLon, centerLat, towns) {
  const seeds = seedsFromTowns(towns);
  let maxSourceRho = 1e-12;
  for (const f of features) eachCoordinate(f.geometry, ([lon, lat]) => {
    const warped = warpSourceXY(rawSourceXY(centerLon, centerLat, lon, lat), seeds);
    maxSourceRho = Math.max(maxSourceRho, warped.length());
  });
  const targetMaxColat = THREE.MathUtils.degToRad(TARGET_MAX_COLAT_DEG);
  const targetMaxRho = 2 * Math.tan(targetMaxColat / 2);
  return { centerLon, centerLat, seeds, maxSourceRho, conformalScale: targetMaxRho / maxSourceRho };
}
export function sourceLocalXYForProjection(lon, lat, p) {
  return warpSourceXY(rawSourceXY(p.centerLon, p.centerLat, lon, lat), p.seeds);
}
export function geoToVector3WithProjection(lon, lat, p, radius = 1) {
  const source = sourceLocalXYForProjection(lon, lat, p);
  const x = source.x * p.conformalScale, y = source.y * p.conformalScale;
  const rho = Math.hypot(x, y);
  if (rho < 1e-12) return new THREE.Vector3(0, 0, radius);
  const colat = 2 * Math.atan(rho / 2), s = Math.sin(colat);
  return new THREE.Vector3(radius * s * x / rho, radius * s * y / rho, radius * Math.cos(colat));
}

const midpointCoord = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
function mappedUnitForProjection(coord, p) {
  return geoToVector3WithProjection(coord[0], coord[1], p, 1).normalize();
}
function mappedTriangleArea(a, b, c, p, edgeDeg, depth = 0) {
  const ua = mappedUnitForProjection(a, p), ub = mappedUnitForProjection(b, p), uc = mappedUnitForProjection(c, p);
  const maxEdge = Math.max(ua.angleTo(ub), ub.angleTo(uc), uc.angleTo(ua));
  if (maxEdge > THREE.MathUtils.degToRad(edgeDeg) && depth < 6) {
    const ab = midpointCoord(a, b), bc = midpointCoord(b, c), ca = midpointCoord(c, a);
    return mappedTriangleArea(a, ab, ca, p, edgeDeg, depth + 1)
      + mappedTriangleArea(ab, b, bc, p, edgeDeg, depth + 1)
      + mappedTriangleArea(ca, bc, c, p, edgeDeg, depth + 1)
      + mappedTriangleArea(ab, bc, ca, p, edgeDeg, depth + 1);
  }
  return sphericalTriangleArea(ua, ub, uc);
}
function featureMappedArea(feature, p, edgeDeg) {
  const polygonArea = polygon => {
    if (!polygon?.length) return 0;
    const outer = cleanRing(polygon[0]);
    if (outer.length < 3) return 0;
    const holes = polygon.slice(1).map(cleanRing).filter(r => r.length >= 3);
    const contour2D = outer.map(([lon, lat]) => sourceLocalXYForProjection(lon, lat, p));
    const holes2D = holes.map(r => r.map(([lon, lat]) => sourceLocalXYForProjection(lon, lat, p)));
    const faces = THREE.ShapeUtils.triangulateShape(contour2D, holes2D);
    const all = outer.concat(...holes);
    let area = 0;
    for (const tri of faces) area += mappedTriangleArea(all[tri[0]], all[tri[1]], all[tri[2]], p, edgeDeg);
    return area;
  };
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === "Polygon") return polygonArea(g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((sum, poly) => sum + polygonArea(poly), 0);
  return 0;
}

export function auditProjectedAreas(towns, p, edgeDeg, logTables = false) {
  const rows = [...towns.values()].map(s => ({
    stat: s,
    key: s.key,
    sourceArea: s.sourceArea,
    targetFactor: s.sourceArea > 0 ? s.baseTargetArea / s.sourceArea : 1,
    controlFactor: s.sourceArea > 0 ? s.controlArea / s.sourceArea : 1,
    actualArea: featureMappedArea(s.feature, p, edgeDeg)
  }));
  const sourceTotal = rows.reduce((sum, r) => sum + r.sourceArea, 0);
  const actualTotal = rows.reduce((sum, r) => sum + r.actualArea, 0);
  for (const r of rows) {
    const sourceShare = sourceTotal > 0 ? r.sourceArea / sourceTotal : 0;
    const actualShare = actualTotal > 0 ? r.actualArea / actualTotal : 0;
    r.actualFactor = sourceShare > 0 ? actualShare / sourceShare : 1;
    r.errorVsTarget = r.targetFactor > 0 ? r.actualFactor / r.targetFactor : 1;
  }
  const townAudit = rows.map(r => ({
    region: r.key,
    target: Number(r.targetFactor.toFixed(3)),
    control: Number(r.controlFactor.toFixed(3)),
    actual: Number(r.actualFactor.toFixed(3)),
    actualOverTarget: Number(r.errorVsTarget.toFixed(3))
  })).sort((a, b) => b.actualOverTarget - a.actualOverTarget);
  if (logTables) {
    console.group("Taiwan Planet feedback area audit");
    console.table(townAudit);
    console.groupEnd();
  }
  return { rows, townAudit, worst: townAudit.slice(0, 3) };
}

function donorLambda(q) {
  if (q > 2.0) return 0.55;
  if (q > 1.5) return 0.45;
  if (q > FEEDBACK_DONOR_THRESHOLD) return 0.30;
  return 0;
}
function feedbackDonorEligible(stat) {
  return stat.coastExposure < 0.08 || stat.baseTargetArea < stat.sourceArea;
}
function allocateFeedbackPool(towns, pool) {
  if (pool <= 1e-14) return 0;
  const all = [...towns.values()];
  const groups = {
    south: all.filter(s => sinkTier(s) === "south"),
    north: all.filter(s => sinkTier(s) === "north"),
    second: all.filter(s => sinkTier(s) === "second"),
    general: all.filter(s => sinkTier(s) === "general")
  };
  const quotas = [
    [groups.south, pool * FEEDBACK_SOUTH_SHARE],
    [groups.north, pool * FEEDBACK_NORTH_SHARE],
    [groups.second, pool * FEEDBACK_SECOND_SHARE],
    [groups.general, pool * FEEDBACK_GENERAL_SHARE]
  ];
  let leftover = 0;
  for (const [group, amount] of quotas) leftover += allocateWithCaps(group, amount, sinkWeight, COASTAL_GAIN_CAP);
  if (leftover > 1e-14) leftover = allocateWithCaps(all.filter(isEligibleCoastalSink), leftover, sinkWeight, COASTAL_GAIN_CAP);
  return leftover;
}
function applyFeedback(towns, audit) {
  let pool = 0;
  const donorLog = [];
  for (const row of audit.rows) {
    const s = row.stat;
    const q = row.errorVsTarget;
    const lambda = donorLambda(q);
    if (!feedbackDonorEligible(s) || lambda <= 0 || row.actualFactor <= row.targetFactor) continue;
    const desired = s.sourceArea * (row.actualFactor - row.targetFactor) * lambda;
    const maxCut = s.controlArea * FEEDBACK_MAX_CONTROL_CUT;
    const floorArea = s.sourceArea * FEEDBACK_MIN_CONTROL_FACTOR;
    const cut = Math.max(0, Math.min(desired, maxCut, s.controlArea - floorArea));
    if (cut <= 1e-14) continue;
    s.controlArea -= cut;
    pool += cut;
    donorLog.push({ region: s.key, q: Number(q.toFixed(2)), cutPctSource: Number((100 * cut / s.sourceArea).toFixed(1)) });
  }
  const leftover = allocateFeedbackPool(towns, pool);
  console.groupCollapsed("Taiwan Planet feedback donors");
  console.table(donorLog.sort((a, b) => b.q - a.q));
  console.log("feedback pool", pool, "unallocated", leftover);
  console.groupEnd();
  return pool;
}

export function buildSolvedProjection(features) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of features) eachCoordinate(f.geometry, ([lon, lat]) => {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  });
  const centerLon = 121.60;
  const centerLat = 25.25;
  const towns = buildTownStats(features, centerLon, centerLat);
  applyBasePolicy(towns);
  let p = buildProjectionFromTowns(features, centerLon, centerLat, towns);
  for (let pass = 0; pass < FEEDBACK_PASSES; pass++) {
    const quick = auditProjectedAreas(towns, p, QUICK_AUDIT_EDGE_DEG, false);
    applyFeedback(towns, quick);
    p = buildProjectionFromTowns(features, centerLon, centerLat, towns);
  }
  p.towns = towns;
  p.feedbackPasses = FEEDBACK_PASSES;
  return p;
}
