import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

export const MAINLAND_BOX = { minLon: 120.0, maxLon: 122.12, minLat: 21.72, maxLat: 25.58 };
export const OFFSHORE_TOWNS = new Set(["綠島鄉", "兰嶼鄉", "蘭嶼鄉", "琉球鄉"]);

export const cleanTai = value => String(value ?? "").replace(/臺/g, "台").trim();
export function featureTownName(f) { return cleanTai(f.properties?.TOWNNAME ?? f.properties?.townname ?? f.properties?.TOWN ?? f.properties?.town ?? ""); }
export function featureCountyName(f) { return cleanTai(f.properties?.COUNTYNAME ?? f.properties?.countyname ?? f.properties?.COUNTY ?? f.properties?.county ?? ""); }
export function featureKey(f) { return `${featureCountyName(f)}|${featureTownName(f)}`; }

export function ringCentroid(ring) {
  if (!ring?.length) return [999, 999];
  let sx = 0, sy = 0;
  for (const [lon, lat] of ring) { sx += lon; sy += lat; }
  return [sx / ring.length, sy / ring.length];
}
export function polygonIsMainland(poly) {
  const [lon, lat] = ringCentroid(poly?.[0]);
  return lon >= MAINLAND_BOX.minLon && lon <= MAINLAND_BOX.maxLon && lat >= MAINLAND_BOX.minLat && lat <= MAINLAND_BOX.maxLat;
}
export function sanitizeFeature(f) {
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
export function eachCoordinate(geometry, callback) {
  if (!geometry) return;
  if (geometry.type === "Polygon") geometry.coordinates.forEach(r => r.forEach(callback));
  else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(p => p.forEach(r => r.forEach(callback)));
}
export function eachOuterRing(geometry, callback) {
  if (!geometry) return;
  if (geometry.type === "Polygon") callback(geometry.coordinates[0]);
  else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(p => callback(p[0]));
}
export function centroidOfFeature(f) {
  let sx = 0, sy = 0, n = 0;
  eachCoordinate(f.geometry, ([lon, lat]) => { sx += lon; sy += lat; n++; });
  return n ? [sx / n, sy / n] : [121, 23.7];
}
export function cleanRing(ring) {
  if (!ring?.length) return [];
  const out = ring.slice();
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) out.pop();
  }
  return out;
}

export function sourcePolar(centerLonDeg, centerLatDeg, lonDeg, latDeg) {
  const lon1 = THREE.MathUtils.degToRad(centerLonDeg);
  const lat1 = THREE.MathUtils.degToRad(centerLatDeg);
  const lon2 = THREE.MathUtils.degToRad(lonDeg);
  const lat2 = THREE.MathUtils.degToRad(latDeg);
  const dLon = lon2 - lon1;
  const sinLat1 = Math.sin(lat1), cosLat1 = Math.cos(lat1);
  const sinLat2 = Math.sin(lat2), cosLat2 = Math.cos(lat2);
  const cosAngle = THREE.MathUtils.clamp(sinLat1 * sinLat2 + cosLat1 * cosLat2 * Math.cos(dLon), -1, 1);
  const angle = Math.acos(cosAngle);
  const bearing = Math.atan2(Math.sin(dLon) * cosLat2, cosLat1 * sinLat2 - sinLat1 * cosLat2 * Math.cos(dLon));
  return { angle, bearing };
}
export function rawSourceXY(centerLon, centerLat, lon, lat) {
  const { angle, bearing } = sourcePolar(centerLon, centerLat, lon, lat);
  const rho = 2 * Math.tan(angle / 2);
  return new THREE.Vector2(rho * Math.sin(bearing), rho * Math.cos(bearing));
}
export function geoUnitVector(lonDeg, latDeg) {
  const lon = THREE.MathUtils.degToRad(lonDeg), lat = THREE.MathUtils.degToRad(latDeg), c = Math.cos(lat);
  return new THREE.Vector3(c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat));
}
export function sphericalTriangleArea(a, b, c) {
  const cross = new THREE.Vector3().crossVectors(b, c);
  const numerator = Math.abs(a.dot(cross));
  const denominator = 1 + a.dot(b) + b.dot(c) + c.dot(a);
  return 2 * Math.atan2(numerator, Math.max(1e-15, denominator));
}

export function ringPlanarArea(ring, centerLon, centerLat) {
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
export function polygonPlanarArea(polygon, centerLon, centerLat) {
  if (!polygon?.length) return 0;
  let area = ringPlanarArea(polygon[0], centerLon, centerLat);
  for (let i = 1; i < polygon.length; i++) area -= ringPlanarArea(polygon[i], centerLon, centerLat);
  return Math.max(0, area);
}
export function featurePlanarArea(feature, centerLon, centerLat) {
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === "Polygon") return polygonPlanarArea(g.coordinates, centerLon, centerLat);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((sum, p) => sum + polygonPlanarArea(p, centerLon, centerLat), 0);
  return 0;
}
export function featureGeoArea(feature, centerLon, centerLat) {
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
      area += sphericalTriangleArea(
        geoUnitVector(all[tri[0]][0], all[tri[0]][1]),
        geoUnitVector(all[tri[1]][0], all[tri[1]][1]),
        geoUnitVector(all[tri[2]][0], all[tri[2]][1])
      );
    }
    return area;
  };
  const g = feature.geometry;
  if (!g) return 0;
  if (g.type === "Polygon") return polygonArea(g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((sum, p) => sum + polygonArea(p), 0);
  return 0;
}

const coordKey = ([lon, lat]) => `${Number(lon).toFixed(5)},${Number(lat).toFixed(5)}`;
function segmentKey(a, b) {
  const ka = coordKey(a), kb = coordKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}
export function buildCoastlineStats(features, centerLon, centerLat) {
  const counts = new Map();
  for (const f of features) eachOuterRing(f.geometry, ring => {
    if (!ring?.length) return;
    for (let i = 0; i < ring.length - 1; i++) {
      const k = segmentKey(ring[i], ring[i + 1]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  });
  const stats = new Map();
  for (const f of features) {
    let total = 0, coast = 0;
    eachOuterRing(f.geometry, ring => {
      if (!ring?.length) return;
      for (let i = 0; i < ring.length - 1; i++) {
        const a = rawSourceXY(centerLon, centerLat, ring[i][0], ring[i][1]);
        const b = rawSourceXY(centerLon, centerLat, ring[i + 1][0], ring[i + 1][1]);
        const len = a.distanceTo(b);
        total += len;
        if ((counts.get(segmentKey(ring[i], ring[i + 1])) || 0) === 1) coast += len;
      }
    });
    stats.set(featureKey(f), { coastExposure: total > 0 ? coast / total : 0 });
  }
  return stats;
}
