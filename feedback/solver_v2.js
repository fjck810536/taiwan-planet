import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
import {
  featureKey, featureTownName, featureCountyName, centroidOfFeature, eachCoordinate,
  cleanRing, rawSourceXY, featurePlanarArea, featureGeoArea, buildCoastlineStats,
  sphericalTriangleArea
} from "./geo.js";

export const TARGET_MAX_COLAT_DEG = 122;
export const FINAL_AUDIT_EDGE_DEG = 1.5;
const QUICK_AUDIT_EDGE_DEG = 4.5;
const NANTOU_AREA_RETAIN = 1.00;
const ADJACENT_AREA_RETAIN = 0.90;
const MIDDLE_POOL_SHARE = 0.15;
const MIDDLE_GAIN_CAP = 0.20;
const COASTAL_GAIN_CAP = 2.50;
const COASTAL_RADIAL_POWER = 3;
const POLICY_WARP_STRENGTH = 0.88;
const POLICY_SIGMA_MULTIPLIER = 2.35;
const NANTOU_SIGMA_MULTIPLIER = 1.35;
const NANTOU_BLEND_WEIGHT = 1.80;
const FEEDBACK_PASSES = 4;
const FEEDBACK_DONOR_THRESHOLD = 1.20;
const FEEDBACK_MAX_CONTROL_CUT = 0.35;
const FEEDBACK_MIN_CONTROL_FACTOR = 0.12;
const NANTOU_FEEDBACK_LAMBDA = 0.80;
const NANTOU_MAX_CONTROL_CUT = 0.50;
const NANTOU_MIN_CONTROL_FACTOR = 0.06;
const HIGH_OUTLIER_TRIGGER = 1.50;
const HIGH_OUTLIER_TARGET = 1.30;
const HIGH_OUTLIER_LAMBDA = 0.85;
const HIGH_OUTLIER_MAX_CONTROL_CUT = 0.55;
const FEEDBACK_SOUTH_SHARE = 0.25;
const FEEDBACK_NORTH_SHARE = 0.40;
const FEEDBACK_SECOND_SHARE = 0.25;
const FEEDBACK_GENERAL_SHARE = 0.10;

const NANTOU_COUNTY = "南投縣";
const NANTOU_ADJACENT = new Set(["台中市", "彰化縣", "雲林縣", "嘉義縣", "高雄市", "花蓮縣"]);
const MIDDLE_RECEIVERS = new Set(["嘉義市"]);
const TAIPEI_CORE = new Set(["大同區", "中山區", "中正區", "大安區", "松山區", "信義區"]);
const TAIPEI_NORTH = new Set(["北投區", "士林區", "內湖區"]);
const NEW_TAIPEI_NORTH = new Set([
  "淡水區", "八里區", "三芝區", "石門區", "金山區", "萬里區", "瑞芳區", "貢寮區",
  "雙溪區", "汐止區", "五股區", "蘆洲區", "三重區"
]);
const KEELUNG_NEAR = new Set(["萬里區", "瑞芳區", "汐止區"]);

const TAIPEI_REF_LON = 121.53;
const TAIPEI_REF_LAT = 25.05;
const DIRECTIONAL_BOOST_RADIUS_DEG = 1.45;
const DIRECTIONAL_RECEIVER_FLOOR = 0.055;
const OUTLINE_PRIORITY_EXTRA = 0.10;
const OUTLINE_PRIORITY_SIGMA_MIN = 0.010;
const OUTLINE_PRIORITY_SIGMA_MAX = 0.024;

const VISIBLE_BOOST_TARGETS = new Map([
  ["台北市|北投區", 1.55], ["台北市|士林區", 1.55], ["台北市|內湖區", 1.45],
  ["新北市|金山區", 1.55], ["新北市|三芝區", 1.55], ["新北市|石門區", 1.55],
  ["新北市|貢寮區", 1.45], ["新北市|雙溪區", 1.45], ["新北市|平溪區", 1.35], ["新北市|坪林區", 1.35],
  ["基隆市|仁愛區", 1.55], ["基隆市|安樂區", 1.55], ["基隆市|暖暖區", 1.55],
  ["宜蘭縣|頭城鎮", 1.45], ["宜蘭縣|礁溪鄉", 1.45], ["宜蘭縣|宜蘭市", 1.35], ["宜蘭縣|員山鄉", 1.35],
  ["宜蘭縣|羅東鎮", 1.30], ["宜蘭縣|三星鄉", 1.30], ["宜蘭縣|冬山鄉", 1.30]
]);

function explicitBoostTarget(stat) {
  return VISIBLE_BOOST_TARGETS.get(`${stat.county}|${stat.town}`) || 1;
}

function directionalBoostScore(stat) {
  if (isTaipeiCore(stat) || stat.county === NANTOU_COUNTY) return 0;

  const cosLat = Math.cos(THREE.MathUtils.degToRad(TAIPEI_REF_LAT));
  const dx = (stat.lon - TAIPEI_REF_LON) * cosLat;
  const dy = stat.lat - TAIPEI_REF_LAT;
  const dist = Math.hypot(dx, dy);
  const proximity = Math.exp(-Math.pow(dist / DIRECTIONAL_BOOST_RADIUS_DEG, 2));

  const northSector = dy >= Math.abs(dx) * 0.45;
  let directional = northSector ? 1.00 : (dx < 0 ? 0.72 : 0.52);

  if (dy < -0.9) directional *= Math.exp(-Math.pow((-dy - 0.9) / 0.85, 2));
  return directional * proximity;
}
function isBoostRegion(stat) {
  return directionalBoostScore(stat) >= DIRECTIONAL_RECEIVER_FLOOR;
}
function boostWeight(stat) {
  return stat.sourceArea * directionalBoostScore(stat);
}

function buildOutlinePrioritySeeds(towns) {
  return [...towns.values()]
    .map(stat => {
      const target = explicitBoostTarget(stat);
      if (target <= 1) return null;
      const weight = THREE.MathUtils.clamp((target - 1) / 0.55, 0, 1);
      const sigma = THREE.MathUtils.clamp(
        stat.eqRadius * 3.2,
        OUTLINE_PRIORITY_SIGMA_MIN,
        OUTLINE_PRIORITY_SIGMA_MAX
      );
      return { center: stat.center.clone(), weight, sigma };
    })
    .filter(Boolean);
}
function outlinePriorityScore(raw, seeds) {
  if (!seeds?.length) return 0;
  let field = 0;
  for (const seed of seeds) {
    const dx = raw.x - seed.center.x;
    const dy = raw.y - seed.center.y;
    const d2 = dx * dx + dy * dy;
    const sigma2 = seed.sigma * seed.sigma;
    field += seed.weight * Math.exp(-d2 / (2 * sigma2));
  }
  return 1 - Math.exp(-field);
}
function applyOutlineExpansion(point, rawForScore, seeds) {
  const score = outlinePriorityScore(rawForScore, seeds);
  return point.clone().multiplyScalar(1 + OUTLINE_PRIORITY_EXTRA * score);
}

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

function isTaipeiCore(stat) {
  return stat.county === "台北市" && TAIPEI_CORE.has(stat.town);
}
function isNorthBeltSink(stat) {
  if (isTaipeiCore(stat)) return false;
  if (stat.county === "基隆市") return true;
  if (stat.county === "台北市" && TAIPEI_NORTH.has(stat.town)) return true;
  return stat.county === "新北市" && NEW_TAIPEI_NORTH.has(stat.town);
}
function sinkWeight(stat) {
  const tipBonus = stat.radial > 0.82 ? 1.65 : stat.radial > 0.70 ? 1.25 : 1;
  return Math.pow(stat.radial, COASTAL_RADIAL_POWER) * stat.coastExposure * tipBonus;
}
function northWeight(stat) {
  if (!isNorthBeltSink(stat)) return 0;
  const exposure = Math.max(stat.coastExposure, 0.18);
  let bonus = 1.35;
  if (stat.county === "基隆市") bonus = 2.60;
  else if (stat.county === "新北市" && KEELUNG_NEAR.has(stat.town)) bonus = 2.20;
  else if (stat.county === "新北市" && stat.coastExposure > 0.001) bonus = 1.75;
  else if (stat.county === "台北市") bonus = 1.50;
  return Math.pow(Math.max(0.20, stat.radial), COASTAL_RADIAL_POWER) * exposure * bonus;
}
function isEligibleCoastalSink(stat) {
  return !isTaipeiCore(stat) && stat.coastExposure > 0.001 &&
    stat.county !== NANTOU_COUNTY &&
    !MIDDLE_RECEIVERS.has(stat.county);
}
function isSouthPrimeSink(stat) {
  return isEligibleCoastalSink(stat) && stat.county === "屏東縣" && stat.lat < 22.25;
}
function isNorthPrimeSink(stat) {
  return isNorthBeltSink(stat);
}
function sinkTier(stat) {
  return isBoostRegion(stat) ? "boost" : "none";
}
function anySinkWeight(stat) {
  return boostWeight(stat);
}

function coastRawPoints(features, centerLon, centerLat) {
  const edges = new Map();
  function addRing(ring) {
    const pts = cleanRing(ring);
    if (pts.length < 2) return;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ak = `${a[0].toFixed(7)},${a[1].toFixed(7)}`;
      const bk = `${b[0].toFixed(7)},${b[1].toFixed(7)}`;
      const key = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
      const rec = edges.get(key);
      if (rec) rec.count += 1;
      else edges.set(key, { count: 1, a, b });
    }
  }
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      for (const ring of g.coordinates) addRing(ring);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) for (const ring of poly) addRing(ring);
    }
  }
  const out = [];
  for (const rec of edges.values()) {
    if (rec.count !== 1) continue;
    out.push(rawSourceXY(centerLon, centerLat, rec.a[0], rec.a[1]));
    out.push(rawSourceXY(centerLon, centerLat, rec.b[0], rec.b[1]));
  }
  return out;
}

function applyXinyiLocalWarp(raw, p) {
  const amp = p?.xinyiLocalAmp || 0;
  const center = p?.xinyiLocalCenter;
  const radius = p?.xinyiLocalRadius || 0;
  if (!(amp > 0) || !center || !(radius > 0)) return raw.clone();
  const dx = raw.x - center.x, dy = raw.y - center.y;
  const r = Math.hypot(dx, dy);
  if (r >= radius) return raw.clone();
  const u = r / radius;
  const falloff = (1 - u) * (1 - u);
  const gain = 1 - amp * falloff;
  return new THREE.Vector2(center.x + dx * gain, center.y + dy * gain);
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
    }
  }

  for (const s of towns.values()) {
    const targetFactor = explicitBoostTarget(s);
    if (targetFactor > 1) {
      s.controlArea = Math.max(s.controlArea, s.sourceArea * targetFactor);
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
  if (coastalGain > 1e-14) {
    const north = [...towns.values()].filter(isNorthBeltSink);
    coastalGain = allocateWithCaps(north, coastalGain, northWeight, COASTAL_GAIN_CAP);
  }
  if (coastalGain > 1e-14 && middle.length) {
    allocateWithCaps(middle, coastalGain, s => s.sourceArea, 1 + MIDDLE_GAIN_CAP);
  }
  for (const s of towns.values()) s.baseTargetArea = s.controlArea;
}

function seedsFromTowns(towns) {
  return [...towns.values()].map(s => {
    const isNantou = s.county === NANTOU_COUNTY;
    const factor = s.sourceArea > 0 ? s.controlArea / s.sourceArea : 1;
    return {
      key: s.key,
      center: s.center,
      factor,
      linearScale: Math.sqrt(Math.max(0.02, factor)),
      sigma: Math.max(isNantou ? 0.0025 : 0.0035, s.eqRadius * (isNantou ? NANTOU_SIGMA_MULTIPLIER : POLICY_SIGMA_MULTIPLIER)),
      blendWeight: isNantou ? NANTOU_BLEND_WEIGHT : 1
    };
  });
}
export function warpSourceXY(raw, seeds, strength = POLICY_WARP_STRENGTH) {
  if (!seeds?.length || strength <= 0) return raw.clone();
  let dx = 0, dy = 0, totalW = 0;
  for (const seed of seeds) {
    const ox = raw.x - seed.center.x;
    const oy = raw.y - seed.center.y;
    const d2 = ox * ox + oy * oy;
    const sigma2 = seed.sigma * seed.sigma;
    const w = Math.exp(-d2 / (2 * sigma2)) * (seed.blendWeight || 1);
    if (w < 1e-5) continue;
    const delta = seed.linearScale - 1;
    dx += w * delta * ox;
    dy += w * delta * oy;
    totalW += w;
  }
  const norm = Math.max(1, totalW);
  return new THREE.Vector2(raw.x + strength * dx / norm, raw.y + strength * dy / norm);
}

function buildProjectionFromTowns(features, centerLon, centerLat, towns, local = null) {
  const seeds = seedsFromTowns(towns);
  const outlinePrioritySeeds = buildOutlinePrioritySeeds(towns);
  const localState = {
    xinyiLocalAmp: local?.amp || 0,
    xinyiLocalCenter: local?.center || null,
    xinyiLocalRadius: local?.radius || 0
  };
  let maxSourceRho = 1e-12;
  for (const f of features) eachCoordinate(f.geometry, ([lon, lat]) => {
    const raw = rawSourceXY(centerLon, centerLat, lon, lat);
    const localRaw = applyXinyiLocalWarp(raw, localState);
    const warped = warpSourceXY(localRaw, seeds);
    const expanded = applyOutlineExpansion(warped, raw, outlinePrioritySeeds);
    maxSourceRho = Math.max(maxSourceRho, expanded.length());
  });
  const targetMaxColat = THREE.MathUtils.degToRad(TARGET_MAX_COLAT_DEG);
  const targetMaxRho = 2 * Math.tan(targetMaxColat / 2);
  return {
    centerLon, centerLat, seeds, outlinePrioritySeeds,
    maxSourceRho, conformalScale: targetMaxRho / maxSourceRho, ...localState
  };
}
export function sourceLocalXYForProjection(lon, lat, p) {
  const raw = rawSourceXY(p.centerLon, p.centerLat, lon, lat);
  const localRaw = applyXinyiLocalWarp(raw, p);
  const warped = warpSourceXY(localRaw, p.seeds);
  return applyOutlineExpansion(warped, raw, p.outlinePrioritySeeds);
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
    console.group("Taiwan Planet feedback area audit v2");
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
  return !isBoostRegion(stat);
}
function allocateFeedbackPool(towns, pool) {
  if (pool <= 1e-14) return 0;
  const receivers = [...towns.values()].filter(isBoostRegion);
  return allocateWithCaps(receivers, pool, boostWeight, COASTAL_GAIN_CAP);
}
function applyFeedback(towns, audit) {
  let pool = 0;
  const donorLog = [];
  for (const row of audit.rows) {
    const s = row.stat;
    const q = row.errorVsTarget;
    const isNantou = s.county === NANTOU_COUNTY;
    const isHighOutlier = !isNantou && !isBoostRegion(s) && row.actualFactor > HIGH_OUTLIER_TRIGGER;
    const lambda = isHighOutlier
      ? HIGH_OUTLIER_LAMBDA
      : (isNantou ? (q > 1.05 ? NANTOU_FEEDBACK_LAMBDA : 0) : donorLambda(q));
    if (!feedbackDonorEligible(s) || lambda <= 0 || row.actualFactor <= row.targetFactor) continue;
    const donorTarget = isHighOutlier ? Math.max(HIGH_OUTLIER_TARGET, row.targetFactor) : row.targetFactor;
    const desired = s.sourceArea * Math.max(0, row.actualFactor - donorTarget) * lambda;
    const maxCut = s.controlArea * (
      isHighOutlier ? HIGH_OUTLIER_MAX_CONTROL_CUT
        : (isNantou ? NANTOU_MAX_CONTROL_CUT : FEEDBACK_MAX_CONTROL_CUT)
    );
    const floorArea = s.sourceArea * (isNantou ? NANTOU_MIN_CONTROL_FACTOR : FEEDBACK_MIN_CONTROL_FACTOR);
    const cut = Math.max(0, Math.min(desired, maxCut, s.controlArea - floorArea));
    if (cut <= 1e-14) continue;
    s.controlArea -= cut;
    pool += cut;
    donorLog.push({ region: s.key, q: Number(q.toFixed(2)), cutPctSource: Number((100 * cut / s.sourceArea).toFixed(1)) });
  }
  const leftover = allocateFeedbackPool(towns, pool);
  console.groupCollapsed("Taiwan Planet feedback donors v2");
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
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const towns = buildTownStats(features, centerLon, centerLat);
  applyBasePolicy(towns);
  let p = buildProjectionFromTowns(features, centerLon, centerLat, towns);
  for (let pass = 0; pass < FEEDBACK_PASSES; pass++) {
    const quick = auditProjectedAreas(towns, p, QUICK_AUDIT_EDGE_DEG, false);
    applyFeedback(towns, quick);
    p = buildProjectionFromTowns(features, centerLon, centerLat, towns);
  }

  const xinyi = [...towns.values()].find(s => s.county === "南投縣" && s.town === "信義鄉");
  if (xinyi) {
    const coast = coastRawPoints(features, centerLon, centerLat);
    let minCoastDistance = Infinity;
    for (const q of coast) minCoastDistance = Math.min(minCoastDistance, q.distanceTo(xinyi.center));
    const supportRadius = Math.min(
      Number.isFinite(minCoastDistance) ? minCoastDistance * 0.70 : xinyi.eqRadius * 2.4,
      xinyi.eqRadius * 2.8
    );
    const targetActual = 1.20;
    const solveAt = amp => {
      const q = buildProjectionFromTowns(features, centerLon, centerLat, towns, {
        amp, center: xinyi.center, radius: supportRadius
      });
      const a = auditProjectedAreas(towns, q, QUICK_AUDIT_EDGE_DEG, false);
      const row = a.rows.find(r => r.stat === xinyi);
      return { projection: q, actual: row?.actualFactor ?? Infinity };
    };

    let lo = 0, hi = 0.85;
    let hiResult = solveAt(hi);
    if (hiResult.actual > targetActual) {
      p = hiResult.projection;
    } else {
      let best = hiResult;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        const result = solveAt(mid);
        if (result.actual > targetActual) lo = mid;
        else {
          hi = mid;
          best = result;
        }
      }
      p = best.projection;
    }
    p.xinyiLocalSupportRadius = supportRadius;
    p.xinyiLocalNearestCoast = minCoastDistance;
  }

  p.towns = towns;
  p.feedbackPasses = FEEDBACK_PASSES;
  p.policyVersion = "outline122+priority10+visible-boost-v2+high-outlier-donor1.3+xinyi-local1.2";
  return p;
}
