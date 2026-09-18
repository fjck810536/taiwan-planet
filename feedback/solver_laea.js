import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
import {
  featureKey, featureTownName, featureCountyName, centroidOfFeature, eachCoordinate,
  cleanRing, sourcePolar, featureGeoArea, geoUnitVector, sphericalTriangleArea
} from "./geo.js";

export const TARGET_MAX_COLAT_DEG = 146;
export const FINAL_AUDIT_EDGE_DEG = 1.5;

const TAIPEI_CORE_TOWNS = new Set([
  "大同區", "中山區", "中正區", "大安區", "松山區", "信義區"
]);

function taipeiCoreAreaWeightedCenter(features) {
  const core = features.filter(feature =>
    featureCountyName(feature) === "台北市" &&
    TAIPEI_CORE_TOWNS.has(featureTownName(feature))
  );
  if (!core.length) throw new Error("找不到台北六區，無法建立 LAEA 中心");

  const sum = new THREE.Vector3();
  let totalWeight = 0;
  for (const feature of core) {
    const [lon, lat] = centroidOfFeature(feature);
    // Spherical area is the weight; the fixed nearby triangulation center is
    // only used to construct the polygon triangulation robustly.
    const weight = Math.max(featureGeoArea(feature, 121.53, 25.05), 1e-12);
    sum.addScaledVector(geoUnitVector(lon, lat), weight);
    totalWeight += weight;
  }
  if (!(totalWeight > 0) || sum.lengthSq() < 1e-18) {
    throw new Error("台北六區面積加權中心計算失敗");
  }

  sum.normalize();
  const lon = THREE.MathUtils.radToDeg(Math.atan2(sum.y, sum.x));
  const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sum.z, -1, 1)));
  return [lon, lat];
}

function laeaXY(centerLon, centerLat, lon, lat) {
  const { angle, bearing } = sourcePolar(centerLon, centerLat, lon, lat);
  const rho = 2 * Math.sin(angle / 2);
  return new THREE.Vector2(rho * Math.sin(bearing), rho * Math.cos(bearing));
}

function buildTowns(features, centerLon, centerLat) {
  const towns = new Map();
  for (const feature of features) {
    const key = featureKey(feature);
    const [lon, lat] = centroidOfFeature(feature);
    const sourceArea = featureGeoArea(feature, centerLon, centerLat);
    towns.set(key, {
      key, feature,
      county: featureCountyName(feature),
      town: featureTownName(feature),
      lon, lat, sourceArea,
      baseTargetArea: sourceArea,
      controlArea: sourceArea
    });
  }
  return towns;
}

export function sourceLocalXYForProjection(lon, lat, p) {
  return laeaXY(p.centerLon, p.centerLat, lon, lat);
}

export function geoToVector3WithProjection(lon, lat, p, radius = 1) {
  const q = sourceLocalXYForProjection(lon, lat, p).multiplyScalar(p.equalAreaScale);
  const rho = q.length();
  if (rho < 1e-12) return new THREE.Vector3(0, 0, radius);
  const colat = 2 * Math.asin(THREE.MathUtils.clamp(rho / 2, 0, 1));
  const s = Math.sin(colat);
  return new THREE.Vector3(
    radius * s * q.x / rho,
    radius * s * q.y / rho,
    radius * Math.cos(colat)
  );
}

const midpoint = (a,b) => [(a[0]+b[0])/2,(a[1]+b[1])/2];

function mappedTriangleArea(a,b,c,p,edgeDeg,depth=0) {
  const ua=geoToVector3WithProjection(a[0],a[1],p,1).normalize();
  const ub=geoToVector3WithProjection(b[0],b[1],p,1).normalize();
  const uc=geoToVector3WithProjection(c[0],c[1],p,1).normalize();
  const maxEdge=Math.max(ua.angleTo(ub),ub.angleTo(uc),uc.angleTo(ua));
  if (maxEdge>THREE.MathUtils.degToRad(edgeDeg) && depth<6) {
    const ab=midpoint(a,b), bc=midpoint(b,c), ca=midpoint(c,a);
    return mappedTriangleArea(a,ab,ca,p,edgeDeg,depth+1)
      + mappedTriangleArea(ab,b,bc,p,edgeDeg,depth+1)
      + mappedTriangleArea(ca,bc,c,p,edgeDeg,depth+1)
      + mappedTriangleArea(ab,bc,ca,p,edgeDeg,depth+1);
  }
  return sphericalTriangleArea(ua,ub,uc);
}

function featureMappedArea(feature,p,edgeDeg) {
  const polygonArea = polygon => {
    if (!polygon?.length) return 0;
    const outer=cleanRing(polygon[0]);
    if (outer.length<3) return 0;
    const holes=polygon.slice(1).map(cleanRing).filter(r=>r.length>=3);
    const contour=outer.map(([lon,lat])=>sourceLocalXYForProjection(lon,lat,p));
    const holeContours=holes.map(r=>r.map(([lon,lat])=>sourceLocalXYForProjection(lon,lat,p)));
    const faces=THREE.ShapeUtils.triangulateShape(contour,holeContours);
    const all=outer.concat(...holes);
    return faces.reduce((sum,t)=>sum+mappedTriangleArea(all[t[0]],all[t[1]],all[t[2]],p,edgeDeg),0);
  };
  const g=feature.geometry;
  if (!g) return 0;
  if (g.type==="Polygon") return polygonArea(g.coordinates);
  if (g.type==="MultiPolygon") return g.coordinates.reduce((sum,poly)=>sum+polygonArea(poly),0);
  return 0;
}

export function auditProjectedAreas(towns,p,edgeDeg,logTables=false) {
  const rows=[...towns.values()].map(stat=>({
    stat,
    key:stat.key,
    sourceArea:stat.sourceArea,
    targetFactor:1,
    controlFactor:1,
    actualArea:featureMappedArea(stat.feature,p,edgeDeg)
  }));
  const sourceTotal=rows.reduce((s,r)=>s+r.sourceArea,0);
  const actualTotal=rows.reduce((s,r)=>s+r.actualArea,0);
  for (const row of rows) {
    const sourceShare=row.sourceArea/sourceTotal;
    const actualShare=row.actualArea/actualTotal;
    row.actualFactor=sourceShare>0?actualShare/sourceShare:1;
    row.errorVsTarget=row.actualFactor;
  }
  const townAudit=rows.map(r=>({region:r.key,actual:Number(r.actualFactor.toFixed(4))}))
    .sort((a,b)=>Math.abs(b.actual-1)-Math.abs(a.actual-1));
  if (logTables) {
    console.group("LAEA-146 area audit");
    console.table(townAudit);
    console.groupEnd();
  }
  return {rows,townAudit,worst:townAudit.slice(0,3)};
}

export function buildSolvedProjection(features) {
  const [centerLon, centerLat] = taipeiCoreAreaWeightedCenter(features);
  let maxSourceRho=1e-12;
  for (const f of features) eachCoordinate(f.geometry,([lon,lat])=>{
    maxSourceRho=Math.max(maxSourceRho,laeaXY(centerLon,centerLat,lon,lat).length());
  });

  const targetMaxColat=THREE.MathUtils.degToRad(TARGET_MAX_COLAT_DEG);
  const targetMaxRho=2*Math.sin(targetMaxColat/2);
  const p={
    projectionType:"lambert-azimuthal-equal-area",
    centerLon,centerLat,maxSourceRho,targetMaxRho,
    equalAreaScale:targetMaxRho/maxSourceRho,
    feedbackPasses:0,
    policyVersion:"laea146-taipei-core-area-weighted-center"
  };
  p.towns=buildTowns(features,centerLon,centerLat);
  return p;
}
