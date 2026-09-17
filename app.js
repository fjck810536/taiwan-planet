import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
import { feature as topoFeature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const MAINLAND_BOX = { minLon: 120.0, maxLon: 122.12, minLat: 21.72, maxLat: 25.58 };
const OFFSHORE_TOWNS = new Set(["綠島鄉", "兰嶼鄉", "蘭嶼鄉", "琉球鄉"]);

const RADIUS = 1;
const TARGET_MAX_COLAT_DEG = 115;
const MAX_MESH_EDGE_DEG = 5;
const MAX_BORDER_EDGE_DEG = 4;
const AUDIT_EDGE_DEG = 1.5;
const MIN_CAMERA_Z = 2.0;
const MAX_CAMERA_Z = 5.3;
const ROTATION_SPEED = 0.0062;

// Area-flow policy. Topology remains continuous because every coordinate is moved
// through one shared smooth deformation field before the spherical projection.
const NANTOU_AREA_RETAIN = 0.35;
const ADJACENT_AREA_RETAIN = 0.90;
const MIDDLE_POOL_SHARE = 0.15;
const MIDDLE_GAIN_CAP = 0.20;
const COASTAL_GAIN_CAP = 2.50;
const COASTAL_RADIAL_POWER = 3;
const POLICY_WARP_STRENGTH = 0.88;
const POLICY_SIGMA_MULTIPLIER = 2.35;

const NANTOU_COUNTY = "南投縣";
const NANTOU_ADJACENT = new Set(["台中市", "彰化縣", "雲林縣", "嘉義縣", "高雄市", "花蓮縣"]);
const MIDDLE_RECEIVERS = new Set(["台北市", "嘉義市"]);

const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const statusEl = document.querySelector("#status");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(0, 0, 3.0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.appendChild(renderer.domElement);

const world = new THREE.Group();
scene.add(world);
scene.add(new THREE.HemisphereLight(0xe7f5f7, 0x082438, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(-2.8, 3.5, 4.8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x77c4ec, 0.7);
rim.position.set(3.8, -1.4, -3.2);
scene.add(rim);

const oceanMaterial = new THREE.MeshStandardMaterial({ color: 0x237fb8, roughness: 0.9, metalness: 0 });
world.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 160, 112), oceanMaterial));
world.add(new THREE.Mesh(
  new THREE.SphereGeometry(RADIUS * 1.014, 120, 88),
  new THREE.MeshBasicMaterial({ color: 0x8dd7ff, transparent: true, opacity: 0.055, side: THREE.BackSide })
));
const landGroup = new THREE.Group();
world.add(landGroup);

let projectionState = null;
let labelItems = [];

const cleanTai = value => String(value ?? "").replace(/臺/g, "台").trim();
function featureTownName(f) { return cleanTai(f.properties?.TOWNNAME ?? f.properties?.townname ?? f.properties?.TOWN ?? f.properties?.town ?? ""); }
function featureCountyName(f) { return cleanTai(f.properties?.COUNTYNAME ?? f.properties?.countyname ?? f.properties?.COUNTY ?? f.properties?.county ?? ""); }
function featureKey(f) { return `${featureCountyName(f)}|${featureTownName(f)}`; }

function ringCentroid(ring) {
  if (!ring?.length) return [999, 999];
  let sx = 0, sy = 0;
  for (const [lon, lat] of ring) { sx += lon; sy += lat; }
  return [sx / ring.length, sy / ring.length];
}
function polygonIsMainland(poly) {
  const [lon, lat] = ringCentroid(poly?.[0]);
  return lon >= MAINLAND_BOX.minLon && lon <= MAINLAND_BOX.maxLon && lat >= MAINLAND_BOX.minLat && lat <= MAINLAND_BOX.maxLat;
}
function sanitizeFeature(f) {
  if (OFFSHORE_TOWNS.has(featureTownName(f))) return null;
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Polygon") return polygonIsMainland(g.coordinates) ? f : null;
  if (g.type === "MultiPolygon") {
    const coordinates = g.coordinates.filter(polygonIsMainland);
    return coordinates.length ? { ...f, geometry: { ...g, coordinates } } : null;
  }
  return null;
}
function eachCoordinate(geometry, callback) {
  if (!geometry) return;
  if (geometry.type === "Polygon") geometry.coordinates.forEach(r => r.forEach(callback));
  else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(p => p.forEach(r => r.forEach(callback)));
}
function eachOuterRing(geometry, callback) {
  if (!geometry) return;
  if (geometry.type === "Polygon") callback(geometry.coordinates[0]);
  else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(p => callback(p[0]));
}
function centroidOfFeature(f) {
  let sx = 0, sy = 0, n = 0;
  eachCoordinate(f.geometry, ([lon, lat]) => { sx += lon; sy += lat; n++; });
  return n ? [sx / n, sy / n] : [121, 23.7];
}

function sourcePolar(centerLonDeg, centerLatDeg, lonDeg, latDeg) {
  const lon1 = THREE.MathUtils.degToRad(centerLonDeg);
  const lat1 = THREE.MathUtils.degToRad(centerLatDeg);
  const lon2 = THREE.MathUtils.degToRad(lonDeg);
  const lat2 = THREE.MathUtils.degToRad(latDeg);
  const dLon = lon2 - lon1;
  const sinLat1 = Math.sin(lat1), cosLat1 = Math.cos(lat1);
  const sinLat2 = Math.sin(lat2), cosLat2 = Math.cos(lat2);
  const cosAngle = THREE.MathUtils.clamp(
    sinLat1 * sinLat2 + cosLat1 * cosLat2 * Math.cos(dLon),
    -1,
    1
  );
  const angle = Math.acos(cosAngle);
  const bearing = Math.atan2(
    Math.sin(dLon) * cosLat2,
    cosLat1 * sinLat2 - sinLat1 * cosLat2 * Math.cos(dLon)
  );
  return { angle, bearing };
}

function rawSourceXY(centerLon, centerLat, lon, lat) {
  const { angle, bearing } = sourcePolar(centerLon, centerLat, lon, lat);
  const rho = 2 * Math.tan(angle / 2);
  return new THREE.Vector2(rho * Math.sin(bearing), rho * Math.cos(bearing));
}

function geoUnitVector(lonDeg, latDeg) {
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const lat = THREE.MathUtils.degToRad(latDeg);
  const c = Math.cos(lat);
  return new THREE.Vector3(c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat));
}

function sphericalTriangleArea(a, b, c) {
  const numerator = Math.abs(a.dot(new THREE.Vector3().crossVectors(b, c)));
  const denominator = 1 + a.dot(b) + b.dot(c) + c.dot(a);
  return 2 * Math.atan2(numerator, Math.max(1e-15, denominator));
}

function featureGeoArea(feature, centerLon, centerLat) {
  const polygonArea = polygon => {
    if (!polygon?.length) return 0;
    const outer = cleanRing(polygon[0]);
    if (outer.length < 3) return 0;
    const holes = polygon.slice(1).map(cleanRing).filter(r => r.length >= 3);
    const contour2D = outer.map(([lon, lat]) => rawSourceXY(centerLon, centerLat, lon, lat));
    const holes2D = holes.map(r => r.map(([lon, lat]) => rawSourceXY(centerLon, centerLat, lon, lat)));
    const faces = THREE.ShapeUtils.triangulateShape(contour2D, holes2D);
    const all = outer.concat(...holes);
    let area = 0;
    for (const tri of faces) {
      const a = geoUnitVector(all[tri[0]][0], all[tri[0]][1]);
      const b = geoUnitVector(all[tri[1]][0], all[tri[1]][1]);
      const c = geoUnitVector(all[tri[2]][0], all[tri[2]][1]);
      area += sphericalTriangleArea(a, b, c);
    }
    return area;
  };
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === "Polygon") return polygonArea(g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((sum, poly) => sum + polygonArea(poly), 0);
  return 0;
}

function ringPlanarArea(ring, centerLon, centerLat) {
  if (!ring?.length) return 0;
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = rawSourceXY(centerLon, centerLat, ring[i][0], ring[i][1]);
    const bCoord = ring[(i + 1) % ring.length];
    const b = rawSourceXY(centerLon, centerLat, bCoord[0], bCoord[1]);
    area2 += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area2) * 0.5;
}

function polygonPlanarArea(polygon, centerLon, centerLat) {
  if (!polygon?.length) return 0;
  let area = ringPlanarArea(polygon[0], centerLon, centerLat);
  for (let i = 1; i < polygon.length; i++) area -= ringPlanarArea(polygon[i], centerLon, centerLat);
  return Math.max(0, area);
}

function featurePlanarArea(feature, centerLon, centerLat) {
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === "Polygon") return polygonPlanarArea(g.coordinates, centerLon, centerLat);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((sum, p) => sum + polygonPlanarArea(p, centerLon, centerLat), 0);
  return 0;
}

const coordKey = ([lon, lat]) => `${Number(lon).toFixed(5)},${Number(lat).toFixed(5)}`;
function segmentKey(a, b) {
  const ka = coordKey(a), kb = coordKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function buildCoastlineStats(features, centerLon, centerLat) {
  const segmentCounts = new Map();
  for (const f of features) eachOuterRing(f.geometry, ring => {
    if (!ring?.length) return;
    for (let i = 0; i < ring.length - 1; i++) {
      const key = segmentKey(ring[i], ring[i + 1]);
      segmentCounts.set(key, (segmentCounts.get(key) || 0) + 1);
    }
  });

  const stats = new Map();
  for (const f of features) {
    let totalLength = 0, coastLength = 0;
    eachOuterRing(f.geometry, ring => {
      if (!ring?.length) return;
      for (let i = 0; i < ring.length - 1; i++) {
        const a = rawSourceXY(centerLon, centerLat, ring[i][0], ring[i][1]);
        const b = rawSourceXY(centerLon, centerLat, ring[i + 1][0], ring[i + 1][1]);
        const len = a.distanceTo(b);
        totalLength += len;
        if ((segmentCounts.get(segmentKey(ring[i], ring[i + 1])) || 0) === 1) coastLength += len;
      }
    });
    stats.set(featureKey(f), {
      coastLength,
      totalLength,
      coastExposure: totalLength > 0 ? coastLength / totalLength : 0
    });
  }
  return stats;
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
      const capacity = Math.max(0, stat.sourceArea * maxFactor - stat.targetArea);
      if (capacity <= 1e-14) continue;
      const proposed = remaining * weightFn(stat) / totalWeight;
      const gain = Math.min(capacity, proposed);
      stat.targetArea += gain;
      distributed += gain;
      if (capacity - gain > 1e-14) next.push(stat);
    }
    if (distributed <= 1e-14) break;
    remaining -= distributed;
    active = next;
  }
  return remaining;
}

function buildAreaPolicy(features, centerLon, centerLat) {
  const coastlineStats = buildCoastlineStats(features, centerLon, centerLat);
  const towns = new Map();
  let maxCenterRadius = 1e-12;

  for (const f of features) {
    const key = featureKey(f);
    const [lon, lat] = centroidOfFeature(f);
    const center = rawSourceXY(centerLon, centerLat, lon, lat);
    maxCenterRadius = Math.max(maxCenterRadius, center.length());
    const planarArea = featurePlanarArea(f, centerLon, centerLat);
    const sourceArea = featureGeoArea(f, centerLon, centerLat);
    const coast = coastlineStats.get(key) || { coastLength: 0, totalLength: 0, coastExposure: 0 };
    towns.set(key, {
      key,
      county: featureCountyName(f),
      town: featureTownName(f),
      center,
      planarArea,
      sourceArea,
      targetArea: sourceArea,
      coastExposure: coast.coastExposure
    });
  }

  for (const stat of towns.values()) {
    stat.radial = THREE.MathUtils.clamp(stat.center.length() / maxCenterRadius, 0, 1);
    stat.eqRadius = Math.sqrt(Math.max(stat.planarArea, 1e-12) / Math.PI);
  }

  let pool = 0;
  for (const stat of towns.values()) {
    if (stat.county === NANTOU_COUNTY) {
      stat.targetArea = stat.sourceArea * NANTOU_AREA_RETAIN;
      pool += stat.sourceArea - stat.targetArea;
    } else if (NANTOU_ADJACENT.has(stat.county)) {
      stat.targetArea = stat.sourceArea * ADJACENT_AREA_RETAIN;
      pool += stat.sourceArea - stat.targetArea;
    }
  }

  const middleStats = [...towns.values()].filter(s => MIDDLE_RECEIVERS.has(s.county));
  const middleBase = middleStats.reduce((sum, s) => sum + s.sourceArea, 0);
  const desiredMiddleGain = pool * MIDDLE_POOL_SHARE;
  const middleCapacity = middleBase * MIDDLE_GAIN_CAP;
  const middleGain = Math.min(desiredMiddleGain, middleCapacity);
  if (middleGain > 0 && middleBase > 0) {
    for (const stat of middleStats) stat.targetArea += middleGain * stat.sourceArea / middleBase;
  }

  let coastalGain = pool - middleGain;
  const coastalStats = [...towns.values()].filter(s =>
    s.coastExposure > 0.001 &&
    s.county !== NANTOU_COUNTY &&
    !NANTOU_ADJACENT.has(s.county) &&
    !MIDDLE_RECEIVERS.has(s.county)
  );

  const sinkWeight = stat => {
    const tipBonus = stat.radial > 0.82 ? 1.65 : stat.radial > 0.70 ? 1.25 : 1;
    return Math.pow(stat.radial, COASTAL_RADIAL_POWER) * stat.coastExposure * tipBonus;
  };
  coastalGain = allocateWithCaps(coastalStats, coastalGain, sinkWeight, COASTAL_GAIN_CAP);

  // If every coastal sink hits its cap, keep any tiny leftover in the middle layer
  // rather than silently changing the total land-area budget.
  if (coastalGain > 1e-14 && middleStats.length) {
    allocateWithCaps(middleStats, coastalGain, s => s.sourceArea, 1 + MIDDLE_GAIN_CAP);
  }

  const seeds = [];
  const targetFactors = new Map();
  const policyAudit = [];
  for (const stat of towns.values()) {
    const factor = stat.sourceArea > 0 ? stat.targetArea / stat.sourceArea : 1;
    const linearScale = Math.sqrt(Math.max(0.05, factor));
    const sigma = Math.max(0.0035, stat.eqRadius * POLICY_SIGMA_MULTIPLIER);
    seeds.push({ key: stat.key, center: stat.center, linearScale, sigma, factor });
    targetFactors.set(stat.key, factor);
    policyAudit.push({
      region: stat.key,
      coast: Number(stat.coastExposure.toFixed(3)),
      radial: Number(stat.radial.toFixed(3)),
      target: Number(factor.toFixed(3)),
      sinkWeight: Number(sinkWeight(stat).toFixed(4))
    });
  }
  console.groupCollapsed("Taiwan Planet area policy targets");
  console.table(policyAudit.sort((a, b) => b.target - a.target));
  console.groupEnd();
  return { seeds, targetFactors };
}

function warpSourceXY(raw, seeds, strength = POLICY_WARP_STRENGTH) {
  if (!seeds?.length || strength <= 0) return raw.clone();
  let dx = 0, dy = 0, totalW = 0;
  for (const seed of seeds) {
    const ox = raw.x - seed.center.x;
    const oy = raw.y - seed.center.y;
    const d2 = ox * ox + oy * oy;
    const sigma2 = seed.sigma * seed.sigma;
    const w = Math.exp(-d2 / (2 * sigma2));
    if (w < 1e-5) continue;
    const localDelta = seed.linearScale - 1;
    dx += w * localDelta * ox;
    dy += w * localDelta * oy;
    totalW += w;
  }
  const norm = Math.max(1, totalW);
  return new THREE.Vector2(
    raw.x + strength * dx / norm,
    raw.y + strength * dy / norm
  );
}

function buildProjection(features) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of features) eachCoordinate(f.geometry, ([lon, lat]) => {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  });

  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const policy = buildAreaPolicy(features, centerLon, centerLat);
  let maxSourceRho = 1e-12;
  for (const f of features) eachCoordinate(f.geometry, ([lon, lat]) => {
    const raw = rawSourceXY(centerLon, centerLat, lon, lat);
    const warped = warpSourceXY(raw, policy.seeds);
    maxSourceRho = Math.max(maxSourceRho, warped.length());
  });

  const targetMaxColat = THREE.MathUtils.degToRad(TARGET_MAX_COLAT_DEG);
  const targetMaxRho = 2 * Math.tan(targetMaxColat / 2);
  return {
    centerLon,
    centerLat,
    policySeeds: policy.seeds,
    targetFactors: policy.targetFactors,
    maxSourceRho,
    targetMaxRho,
    conformalScale: targetMaxRho / maxSourceRho
  };
}

function sourceLocalXY(lon, lat) {
  const p = projectionState;
  const raw = rawSourceXY(p.centerLon, p.centerLat, lon, lat);
  return warpSourceXY(raw, p.policySeeds);
}

function geoToVector3(lon, lat, radius = RADIUS) {
  const source = sourceLocalXY(lon, lat);
  const x = source.x * projectionState.conformalScale;
  const y = source.y * projectionState.conformalScale;
  const rho = Math.hypot(x, y);
  if (rho < 1e-12) return new THREE.Vector3(0, 0, radius);
  const colat = 2 * Math.atan(rho / 2);
  const s = Math.sin(colat);
  return new THREE.Vector3(
    radius * s * (x / rho),
    radius * s * (y / rho),
    radius * Math.cos(colat)
  );
}

function cleanRing(ring) {
  if (!ring?.length) return [];
  const out = ring.slice();
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) out.pop();
  }
  return out;
}

const midpointCoord = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const mappedUnit = coord => geoToVector3(coord[0], coord[1], 1).normalize();

function mappedTriangleArea(a, b, c, depth = 0) {
  const ua = mappedUnit(a), ub = mappedUnit(b), uc = mappedUnit(c);
  const maxEdge = Math.max(ua.angleTo(ub), ub.angleTo(uc), uc.angleTo(ua));
  if (maxEdge > THREE.MathUtils.degToRad(AUDIT_EDGE_DEG) && depth < 6) {
    const ab = midpointCoord(a, b);
    const bc = midpointCoord(b, c);
    const ca = midpointCoord(c, a);
    return mappedTriangleArea(a, ab, ca, depth + 1)
      + mappedTriangleArea(ab, b, bc, depth + 1)
      + mappedTriangleArea(ca, bc, c, depth + 1)
      + mappedTriangleArea(ab, bc, ca, depth + 1);
  }
  return sphericalTriangleArea(ua, ub, uc);
}

function featureMappedArea(feature) {
  const polygonArea = polygon => {
    if (!polygon?.length) return 0;
    const outer = cleanRing(polygon[0]);
    if (outer.length < 3) return 0;
    const holes = polygon.slice(1).map(cleanRing).filter(r => r.length >= 3);
    const contour2D = outer.map(([lon, lat]) => sourceLocalXY(lon, lat));
    const holes2D = holes.map(r => r.map(([lon, lat]) => sourceLocalXY(lon, lat)));
    const faces = THREE.ShapeUtils.triangulateShape(contour2D, holes2D);
    const all = outer.concat(...holes);
    let area = 0;
    for (const tri of faces) area += mappedTriangleArea(all[tri[0]], all[tri[1]], all[tri[2]]);
    return area;
  };
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === "Polygon") return polygonArea(g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((sum, poly) => sum + polygonArea(poly), 0);
  return 0;
}

function auditProjectedAreas(features) {
  const rows = features.map(f => ({
    key: featureKey(f),
    county: featureCountyName(f),
    town: featureTownName(f),
    sourceArea: featureGeoArea(f, projectionState.centerLon, projectionState.centerLat),
    targetFactor: projectionState.targetFactors?.get(featureKey(f)) ?? 1,
    actualArea: featureMappedArea(f)
  }));
  const sourceTotal = rows.reduce((sum, r) => sum + r.sourceArea, 0);
  const actualTotal = rows.reduce((sum, r) => sum + r.actualArea, 0);
  for (const row of rows) {
    const sourceShare = sourceTotal > 0 ? row.sourceArea / sourceTotal : 0;
    const actualShare = actualTotal > 0 ? row.actualArea / actualTotal : 0;
    row.actualFactor = sourceShare > 0 ? actualShare / sourceShare : 1;
    row.errorVsTarget = row.targetFactor > 0 ? row.actualFactor / row.targetFactor : 1;
  }

  const townAudit = rows.map(r => ({
    region: r.key,
    target: Number(r.targetFactor.toFixed(3)),
    actual: Number(r.actualFactor.toFixed(3)),
    actualOverTarget: Number(r.errorVsTarget.toFixed(3))
  })).sort((a, b) => b.actual - a.actual);

  const countyMap = new Map();
  for (const row of rows) {
    if (!countyMap.has(row.county)) countyMap.set(row.county, { county: row.county, source: 0, target: 0, actual: 0 });
    const county = countyMap.get(row.county);
    county.source += row.sourceArea;
    county.target += row.sourceArea * row.targetFactor;
    county.actual += row.actualArea;
  }
  const countyAudit = [...countyMap.values()].map(county => {
    const sourceShare = county.source / sourceTotal;
    const actualShare = county.actual / actualTotal;
    return {
      county: county.county,
      target: Number((county.target / county.source).toFixed(3)),
      actual: Number((actualShare / sourceShare).toFixed(3))
    };
  }).sort((a, b) => b.actual - a.actual);

  console.group("Taiwan Planet spherical area audit");
  console.table(countyAudit);
  console.table(townAudit);
  console.groupEnd();

  return { townAudit, countyAudit, worst: townAudit.slice(0, 3) };
}

function emitWarpedTriangle(bucket, a, b, c, depth = 0) {
  const ua = mappedUnit(a), ub = mappedUnit(b), uc = mappedUnit(c);
  const maxEdge = Math.max(ua.angleTo(ub), ub.angleTo(uc), uc.angleTo(ua));
  if (maxEdge > THREE.MathUtils.degToRad(MAX_MESH_EDGE_DEG) && depth < 6) {
    const ab = midpointCoord(a, b);
    const bc = midpointCoord(b, c);
    const ca = midpointCoord(c, a);
    emitWarpedTriangle(bucket, a, ab, ca, depth + 1);
    emitWarpedTriangle(bucket, ab, b, bc, depth + 1);
    emitWarpedTriangle(bucket, ca, bc, c, depth + 1);
    emitWarpedTriangle(bucket, ab, bc, ca, depth + 1);
    return;
  }

  const base = bucket.positions.length / 3;
  for (const coord of [a, b, c]) {
    const v = geoToVector3(coord[0], coord[1], RADIUS * 1.009);
    bucket.positions.push(v.x, v.y, v.z);
    const n = v.clone().normalize();
    bucket.normals.push(n.x, n.y, n.z);
  }
  bucket.indices.push(base, base + 1, base + 2);
}

function addBorderSegment(borderPositions, a, b) {
  const ua = mappedUnit(a), ub = mappedUnit(b);
  const steps = Math.max(1, Math.ceil(THREE.MathUtils.radToDeg(ua.angleTo(ub)) / MAX_BORDER_EDGE_DEG));
  let prev = a;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const next = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const va = geoToVector3(prev[0], prev[1], RADIUS * 1.016);
    const vb = geoToVector3(next[0], next[1], RADIUS * 1.016);
    borderPositions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
    prev = next;
  }
}

function addPolygonGeometry(bucket, polygon, borderPositions) {
  if (!polygon?.length) return;
  const outer = cleanRing(polygon[0]);
  if (outer.length < 3) return;
  const holes = polygon.slice(1).map(cleanRing).filter(r => r.length >= 3);
  const contour2D = outer.map(([lon, lat]) => sourceLocalXY(lon, lat));
  const holes2D = holes.map(r => r.map(([lon, lat]) => sourceLocalXY(lon, lat)));
  const faces = THREE.ShapeUtils.triangulateShape(contour2D, holes2D);
  const all = outer.concat(...holes);

  for (const tri of faces) emitWarpedTriangle(bucket, all[tri[0]], all[tri[1]], all[tri[2]]);
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++) addBorderSegment(borderPositions, ring[i], ring[(i + 1) % ring.length]);
  }
}

function disposeLand() {
  while (landGroup.children.length) {
    const child = landGroup.children.pop();
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
}
function stableIndex(value, modulo) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return Math.abs(h) % modulo;
}
function buildLandGeometry(features) {
  disposeLand();
  const colors = [0x8fa978, 0x98af82, 0x81986d, 0xa4b88d, 0x91a87d, 0x879f73];
  const buckets = colors.map(() => ({ positions: [], normals: [], indices: [] }));
  const borderPositions = [];
  for (const f of features) {
    const bucket = buckets[stableIndex(featureCountyName(f), colors.length)];
    const g = f.geometry;
    if (g.type === "Polygon") addPolygonGeometry(bucket, g.coordinates, borderPositions);
    else g.coordinates.forEach(p => addPolygonGeometry(bucket, p, borderPositions));
  }
  buckets.forEach((bucket, i) => {
    if (!bucket.indices.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(bucket.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(bucket.normals, 3));
    geometry.setIndex(bucket.indices);
    geometry.computeBoundingSphere();
    landGroup.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: colors[i], roughness: 0.93, metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    })));
  });
  const borderGeometry = new THREE.BufferGeometry();
  borderGeometry.setAttribute("position", new THREE.Float32BufferAttribute(borderPositions, 3));
  landGroup.add(new THREE.LineSegments(borderGeometry, new THREE.LineBasicMaterial({ color: 0xf4f7df, transparent: true, opacity: 0.5 })));
}

function buildLabels(features) {
  labelsLayer.replaceChildren();
  labelItems = [];
  const counts = new Map();
  for (const f of features) counts.set(featureTownName(f), (counts.get(featureTownName(f)) || 0) + 1);
  for (const f of features) {
    const town = featureTownName(f);
    if (!town) continue;
    const county = featureCountyName(f);
    const duplicate = (counts.get(town) || 0) > 1;
    const text = duplicate ? `${county}${town}` : town;
    const [lon, lat] = centroidOfFeature(f);
    const el = document.createElement("div");
    el.className = "label";
    el.textContent = text;
    labelsLayer.appendChild(el);
    labelItems.push({ key: featureKey(f), el, local: geoToVector3(lon, lat, RADIUS * 1.025) });
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
    projectionState = buildProjection(features);
    const audit = auditProjectedAreas(features);
    buildLandGeometry(features);
    buildLabels(features);
    const worstText = audit.worst.map(x => `${x.region} ${x.actual.toFixed(2)}×`).join("・");
    statusEl.textContent = `本島行政區 ${features.length} 個・115°・面積流 audit・${worstText}`;
    document.body.classList.add("ready");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "台灣圖資載入失敗";
  }
}

const pointers = new Map();
let lastSingle = null;
let pinchStartDistance = 0;
let pinchStartCameraZ = camera.position.z;
let twistStartAngle = 0;
let twistStartWorldZ = world.rotation.z;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleBetween = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const normalizeAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const markInteraction = () => document.body.classList.add("interacted");

function beginTwoFingerGesture() {
  const [a, b] = [...pointers.values()];
  pinchStartDistance = Math.max(1, distance(a, b));
  pinchStartCameraZ = camera.position.z;
  twistStartAngle = angleBetween(a, b);
  twistStartWorldZ = world.rotation.z;
  lastSingle = null;
}
function onPointerDown(e) {
  e.preventDefault(); markInteraction();
  renderer.domElement.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  document.body.classList.add("dragging");
  if (pointers.size === 1) lastSingle = { x: e.clientX, y: e.clientY };
  else if (pointers.size === 2) beginTwoFingerGesture();
}
function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault(); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    if (lastSingle) {
      world.rotation.y += (p.x - lastSingle.x) * ROTATION_SPEED;
      world.rotation.x += (p.y - lastSingle.y) * ROTATION_SPEED;
      world.rotation.x = THREE.MathUtils.clamp(world.rotation.x, -1.48, 1.48);
    }
    lastSingle = { ...p };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const currentDistance = Math.max(1, distance(a, b));
    const currentAngle = angleBetween(a, b);
    const twistDelta = normalizeAngle(currentAngle - twistStartAngle);
    camera.position.z = THREE.MathUtils.clamp(
      pinchStartCameraZ * (pinchStartDistance / currentDistance),
      MIN_CAMERA_Z,
      MAX_CAMERA_Z
    );
    world.rotation.z = twistStartWorldZ - twistDelta;
  }
}
function onPointerUp(e) {
  e.preventDefault();
  pointers.delete(e.pointerId);
  if (!pointers.size) {
    lastSingle = null;
    document.body.classList.remove("dragging");
  } else if (pointers.size === 1) {
    lastSingle = { ...[...pointers.values()][0] };
  } else if (pointers.size === 2) {
    beginTwoFingerGesture();
  }
}
["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(type => {
  renderer.domElement.addEventListener(type, type === "pointerdown" ? onPointerDown : type === "pointermove" ? onPointerMove : onPointerUp, { passive: false });
});
const block = e => e.preventDefault();
["gesturestart", "gesturechange", "gestureend", "contextmenu", "dragstart", "selectstart"].forEach(type => document.addEventListener(type, block, { passive: false }));
document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", e => { const now = Date.now(); if (now - lastTouchEnd <= 300) e.preventDefault(); lastTouchEnd = now; }, { passive: false });

function resize() {
  const width = window.innerWidth, height = window.innerHeight;
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
}
window.addEventListener("resize", resize, { passive: true });
window.visualViewport?.addEventListener("resize", resize, { passive: true });
resize();

const tmpWorld = new THREE.Vector3(), tmpProjected = new THREE.Vector3(), tmpNormal = new THREE.Vector3(), tmpToCamera = new THREE.Vector3();
function updateLabels() {
  if (!labelItems.length) return;
  const width = window.innerWidth, height = window.innerHeight, zoom = camera.position.z;
  const limit = zoom < 2.45 ? 90 : zoom < 3.0 ? 56 : zoom < 3.8 ? 30 : 14;
  const cellW = zoom < 2.45 ? 72 : 86, cellH = zoom < 2.45 ? 24 : 28;
  const occupied = new Set(), candidates = [];
  world.updateMatrixWorld(true);
  for (const item of labelItems) {
    tmpWorld.copy(item.local).applyMatrix4(world.matrixWorld);
    tmpNormal.copy(tmpWorld).normalize();
    tmpToCamera.copy(camera.position).sub(tmpWorld).normalize();
    const facing = tmpNormal.dot(tmpToCamera);
    if (facing <= 0.035) { item.el.style.opacity = "0"; continue; }
    tmpProjected.copy(tmpWorld).project(camera);
    const sx = (tmpProjected.x * 0.5 + 0.5) * width;
    const sy = (-tmpProjected.y * 0.5 + 0.5) * height;
    if (tmpProjected.z < -1 || tmpProjected.z > 1 || sx < -90 || sx > width + 90 || sy < -45 || sy > height + 45) { item.el.style.opacity = "0"; continue; }
    candidates.push({ item, facing, sx, sy });
  }
  candidates.sort((a, b) => b.facing - a.facing);
  let shown = 0;
  for (const c of candidates) {
    const gx = Math.floor(c.sx / cellW), gy = Math.floor(c.sy / cellH), key = `${gx}:${gy}`;
    if (shown >= limit || occupied.has(key)) { c.item.el.style.opacity = "0"; continue; }
    occupied.add(key); shown++;
    c.item.el.style.transform = `translate3d(${c.sx}px,${c.sy}px,0) translate(-50%,-50%)`;
    c.item.el.style.opacity = String(THREE.MathUtils.clamp((c.facing - 0.035) * 3.2, 0, 1));
  }
}
function animate() { updateLabels(); renderer.render(scene, camera); requestAnimationFrame(animate); }
loadTaiwan();
animate();
