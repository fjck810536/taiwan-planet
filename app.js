import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
import { feature as topoFeature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
const DATA_URL = "https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json";
const POLE_TARGETS = ["大同","中山","中正","大安","松山","信義"];
const MAINLAND_BOX = { minLon:120.0, maxLon:122.12, minLat:21.72, maxLat:25.58 };
const OFFSHORE_TOWNS = new Set(["綠島鄉","兰嶼鄉","蘭嶼鄉","琉球鄉"]);
const RADIUS = 1;
const MIN_CAMERA_Z = 2.05;
const MAX_CAMERA_Z = 5.45;
const ROTATION_SPEED = 0.0062;
const CAP_DEG = 22;
const MAX_COLAT_DEG = 168;
const SOURCE_MAIN_HALF_DEG = 120;
const TARGET_MAIN_HALF_DEG = 157;
const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const statusEl = document.querySelector("#status");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40,1,.1,100);
camera.position.set(0,0,3.35);
const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, powerPreference:"high-performance"});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,2));
stage.appendChild(renderer.domElement);
const world = new THREE.Group();
world.rotation.x = 0.52;
world.rotation.y = -0.06;
scene.add(world);
scene.add(new THREE.HemisphereLight(0xe7f5f7,0x082438,1.6));
const key = new THREE.DirectionalLight(0xffffff,1.5);
key.position.set(-2.8,3.5,4.8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x77c4ec,.7);
rim.position.set(3.8,-1.4,-3.2);
scene.add(rim);
const oceanMaterial = new THREE.MeshStandardMaterial({color:0x1f78ad, roughness:.9, metalness:0});
const globe = new THREE.Mesh(new THREE.SphereGeometry(RADIUS,160,112),oceanMaterial);
world.add(globe);
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(RADIUS*1.014,120,88),new THREE.MeshBasicMaterial({color:0x8dd7ff, transparent:true, opacity:.06, side:THREE.BackSide}));
world.add(atmosphere);
const landGroup=new THREE.Group();
world.add(landGroup);
let projectionState = null;
let labelItems = [];
const normalizeName = (value) => String(value ?? "").replace(/臺/g,"台").replace(/[鄉鎮市區]$/u,"").trim();
function featureTownName(f) {
const p=f.properties || {};
const direct = p.TOWNNAME ?? p.townname ?? p.TOWN ?? p.town ?? p.NAME ?? p.name;
if (typeof direct === "string" && direct.trim()) return direct.trim().replace(/臺/g,"台");
for (const value of Object.values(p)) {
if (typeof value !== "string") continue;
const s=value.trim().replace(/臺/g,"台");
if (/[鄉鎮市區]$/u.test(s) && s.length <= 8) return s;
}
return "";
}
function featureTargetName(f) {
const n=normalizeName(featureTownName(f));
return POLE_TARGETS.includes(n) ? n : null;
}
function ringCentroid(ring) {
if (!ring?.length) return [999,999];
let sx=0,sy=0,n=0;
for (const [lon,lat] of ring) { sx+=lon; sy+=lat; n++; }
return n ? [sx/n,sy/n] : [999,999];
}
function polygonIsMainland(poly) {
const [lon,lat]=ringCentroid(poly?.[0]);
return lon>=MAINLAND_BOX.minLon && lon<=MAINLAND_BOX.maxLon && lat>=MAINLAND_BOX.minLat && lat<=MAINLAND_BOX.maxLat;
}
function sanitizeFeature(f) {
const town=featureTownName(f);
if (OFFSHORE_TOWNS.has(town)) return null;
const g=f.geometry;
if (!g) return null;
if (g.type==="Polygon") {
if (!polygonIsMainland(g.coordinates)) return null;
return { ...f, geometry:{...g, coordinates:g.coordinates} };
}
if (g.type==="MultiPolygon") {
const polys=g.coordinates.filter(polygonIsMainland);
if (!polys.length) return null;
return { ...f, geometry:{...g, coordinates:polys} };
}
return null;
}
function eachCoordinate(geometry,callback) {
if (!geometry) return;
if (geometry.type==="Polygon") geometry.coordinates.forEach(r=>r.forEach(callback));
else if (geometry.type==="MultiPolygon") geometry.coordinates.forEach(p=>p.forEach(r=>r.forEach(callback)));
}
function centroidOfFeature(f) {
let sx=0,sy=0,n=0;
eachCoordinate(f.geometry,([lon,lat])=>{sx+=lon; sy+=lat; n++;});
return n ? [sx/n,sy/n] : [121.54,25.04];
}
function buildProjection(features) {
const targets=features.filter(f=>featureTargetName(f));
const targetCenters=targets.map(centroidOfFeature);
const fallback=[121.544,25.044];
const meanCenter=targetCenters.length ? [targetCenters.reduce((a,p)=>a+p[0],0)/targetCenters.length,targetCenters.reduce((a,p)=>a+p[1],0)/targetCenters.length] : fallback;
let center=meanCenter;
let best=Infinity;
for (const f of targets) eachCoordinate(f.geometry,([lon,lat])=>{
const d=(lon-meanCenter[0])**2+(lat-meanCenter[1])**2;
if (d<best) { best=d; center=[lon,lat]; }
});
const cosLat=Math.cos(center[1]*Math.PI/180);
let maxR=.001;
let capR=.001;
for (const f of features) eachCoordinate(f.geometry,([lon,lat])=>{
const r=Math.hypot((lon-center[0])*cosLat,lat-center[1]);
maxR=Math.max(maxR,r);
if (featureTargetName(f)) capR=Math.max(capR,r);
});
capR=Math.min(maxR*.35,capR*1.06);
return {center,cosLat,maxR,capR};
}
function normDeg(deg) { return ((deg+180)%360+360)%360-180; }
function warpBearingDeg(bearing) {
const b=normDeg(bearing);
const s=SOURCE_MAIN_HALF_DEG;
const d=TARGET_MAIN_HALF_DEG;
if (b>=-s && b<=s) return b*(d/s);
const compressed=(180-d)/(180-s);
if (b>s) return d+(b-s)*compressed;
return -d+(b+s)*compressed;
}
function geoToPlanet(lon,lat) {
const {center,cosLat,maxR,capR}=projectionState;
const dx=(lon-center[0])*cosLat;
const dy=lat-center[1];
const r=Math.hypot(dx,dy);
let colatDeg;
if (r<=capR) colatDeg=CAP_DEG*(r/Math.max(capR,1e-9));
else {
const t=(r-capR)/Math.max(maxR-capR,1e-9);
colatDeg=CAP_DEG+(MAX_COLAT_DEG-CAP_DEG)*Math.pow(Math.max(0,Math.min(1,t)),.94);
}
const bearing=Math.atan2(dx,-dy)*180/Math.PI;
return [warpBearingDeg(bearing),90-colatDeg];
}
function latLonToVector3(latDeg,lonDeg,radius=1) {
const lat=THREE.MathUtils.degToRad(latDeg);
const lon=THREE.MathUtils.degToRad(lonDeg);
return new THREE.Vector3(radius*Math.cos(lat)*Math.sin(lon),radius*Math.sin(lat),radius*Math.cos(lat)*Math.cos(lon));
}
function cleanRing(ring) {
if (!ring?.length) return [];
const out=ring.slice();
if (out.length>1) {
const a=out[0],b=out[out.length-1];
if (Math.abs(a[0]-b[0])<1e-12 && Math.abs(a[1]-b[1])<1e-12) out.pop();
}
return out;
}
function addPolygonGeometry(bucket,polygon,borderPositions) {
if (!polygon?.length) return;
const outer=cleanRing(polygon[0]);
if (outer.length<3) return;
const holes=polygon.slice(1).map(cleanRing).filter(r=>r.length>=3);
const to2D=([lon,lat])=>new THREE.Vector2((lon-projectionState.center[0])*projectionState.cosLat,lat-projectionState.center[1]);
const contour2D=outer.map(to2D);
const holes2D=holes.map(r=>r.map(to2D));
const faces=THREE.ShapeUtils.triangulateShape(contour2D,holes2D);
const all=outer.concat(...holes);
const base=bucket.positions.length/3;
for (const [lon,lat] of all) {
const [pLon,pLat]=geoToPlanet(lon,lat);
const v=latLonToVector3(pLat,pLon,RADIUS*1.009);
bucket.positions.push(v.x,v.y,v.z);
const n=v.clone().normalize();
bucket.normals.push(n.x,n.y,n.z);
}
for (const tri of faces) bucket.indices.push(base+tri[0],base+tri[1],base+tri[2]);
for (const ring of [outer,...holes]) {
for (let i=0;i<ring.length;i++) {
const a=ring[i],b=ring[(i+1)%ring.length];
const [aLon,aLat]=geoToPlanet(a[0],a[1]);
const [bLon,bLat]=geoToPlanet(b[0],b[1]);
const va=latLonToVector3(aLat,aLon,RADIUS*1.016);
const vb=latLonToVector3(bLat,bLon,RADIUS*1.016);
borderPositions.push(va.x,va.y,va.z,vb.x,vb.y,vb.z);
}
}
}
function disposeLand() {
while (landGroup.children.length) {
const child=landGroup.children[landGroup.children.length-1];
landGroup.remove(child);
child.geometry?.dispose?.();
child.material?.dispose?.();
}
}
function buildLandGeometry(features) {
disposeLand();
const colors=[0x92aa78,0x9eae7f,0x899f70,0xa5b689,0xd0d6a7];
const buckets=colors.map(()=>({positions:[],normals:[],indices:[]}));
const borderPositions=[];
features.forEach((f,index)=>{
const bucket=buckets[featureTargetName(f)?4:index%4];
const g=f.geometry;
if (g.type==="Polygon") addPolygonGeometry(bucket,g.coordinates,borderPositions);
else if (g.type==="MultiPolygon") g.coordinates.forEach(p=>addPolygonGeometry(bucket,p,borderPositions));
});
buckets.forEach((bucket,i)=>{
if (!bucket.indices.length) return;
const geometry=new THREE.BufferGeometry();
geometry.setAttribute("position",new THREE.Float32BufferAttribute(bucket.positions,3));
geometry.setAttribute("normal",new THREE.Float32BufferAttribute(bucket.normals,3));
geometry.setIndex(bucket.indices);
geometry.computeBoundingSphere();
const material=new THREE.MeshStandardMaterial({color:colors[i],roughness:.93,metalness:0,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
landGroup.add(new THREE.Mesh(geometry,material));
});
const borderGeometry=new THREE.BufferGeometry();
borderGeometry.setAttribute("position",new THREE.Float32BufferAttribute(borderPositions,3));
const borderMaterial=new THREE.LineBasicMaterial({color:0xf4f7df,transparent:true,opacity:.48});
landGroup.add(new THREE.LineSegments(borderGeometry,borderMaterial));
}
function buildLabels(features) {
labelsLayer.replaceChildren();
labelItems=[];
for (const f of features) {
const fullName=featureTownName(f);
if (!fullName) continue;
const [lon,lat]=centroidOfFeature(f);
const [pLon,pLat]=geoToPlanet(lon,lat);
const pole=Boolean(featureTargetName(f));
const el=document.createElement("div");
el.className=`label${pole ? " pole" : ""}`;
el.textContent=pole ? normalizeName(fullName) : fullName;
labelsLayer.appendChild(el);
labelItems.push({name:fullName, pole, el,local:latLonToVector3(pLat,pLon,RADIUS*1.025)});
}
}
async function loadTaiwan() {
try {
const res=await fetch(DATA_URL,{cache:"force-cache"});
if (!res.ok) throw new Error(`TopoJSON ${res.status}`);
const topology=await res.json();
const object=topology.objects.towns || Object.values(topology.objects)[0];
const collection=topoFeature(topology,object);
const features=collection.features.map(sanitizeFeature).filter(Boolean);
if (!features.length) throw new Error("找不到台灣本島行政區");
projectionState=buildProjection(features);
oceanMaterial.map=null;
oceanMaterial.color.setHex(0x237fb8);
oceanMaterial.needsUpdate=true;
buildLandGeometry(features);
buildLabels(features);
statusEl.textContent=`本島行政區 ${features.length} 個`;
document.body.classList.add("ready");
} catch (err) {
console.error(err);
statusEl.textContent="台灣圖資載入失敗";
}
}
const pointers=new Map();
let lastSingle=null;
let pinchStartDistance=0;
let pinchStartCameraZ=camera.position.z;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const markInteraction=()=>document.body.classList.add("interacted");
function onPointerDown(event) {
event.preventDefault();
markInteraction();
renderer.domElement.setPointerCapture?.(event.pointerId);
pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
document.body.classList.add("dragging");
if (pointers.size===1) lastSingle={x:event.clientX,y:event.clientY};
else if (pointers.size===2) {
const [a,b]=[...pointers.values()];
pinchStartDistance=Math.max(1,distance(a,b));
pinchStartCameraZ=camera.position.z;
lastSingle=null;
}
}
function onPointerMove(event) {
if (!pointers.has(event.pointerId)) return;
event.preventDefault();
pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
if (pointers.size===1) {
const point=[...pointers.values()][0];
if (lastSingle) {
const dx=point.x-lastSingle.x;
const dy=point.y-lastSingle.y;
world.rotation.y+=dx*ROTATION_SPEED;
world.rotation.x+=dy*ROTATION_SPEED;
world.rotation.x=THREE.MathUtils.clamp(world.rotation.x,-1.48,1.48);
}
lastSingle={...point};
} else if (pointers.size===2) {
const [a,b]=[...pointers.values()];
const current=Math.max(1,distance(a,b));
camera.position.z=THREE.MathUtils.clamp(pinchStartCameraZ*(pinchStartDistance/current),MIN_CAMERA_Z,MAX_CAMERA_Z);
}
}
function onPointerUp(event) {
event.preventDefault();
pointers.delete(event.pointerId);
if (pointers.size===0) {
lastSingle=null;
document.body.classList.remove("dragging");
} else if (pointers.size===1) lastSingle={...[...pointers.values()][0]};
}
["pointerdown","pointermove","pointerup","pointercancel"].forEach(type=>{
renderer.domElement.addEventListener(type,type==="pointerdown" ? onPointerDown : type==="pointermove" ? onPointerMove : onPointerUp,{passive:false});
});
const block=event=>event.preventDefault();
["gesturestart","gesturechange","gestureend","contextmenu","dragstart","selectstart"].forEach(type=>document.addEventListener(type,block,{passive:false}));
document.addEventListener("touchmove",event=>{if (event.touches.length>1) event.preventDefault();},{passive:false});
let lastTouchEnd=0;
document.addEventListener("touchend",event=>{const now=Date.now();if (now-lastTouchEnd<=300) event.preventDefault();lastTouchEnd=now;},{passive:false});
function resize() {
const width=window.innerWidth;
const height=window.innerHeight;
camera.aspect=width/Math.max(1,height);
camera.updateProjectionMatrix();
renderer.setSize(width,height,false);
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
}
window.addEventListener("resize",resize,{passive:true});
window.visualViewport?.addEventListener("resize",resize,{passive:true});
resize();
const tmpWorld=new THREE.Vector3();
const tmpProjected=new THREE.Vector3();
const tmpNormal=new THREE.Vector3();
const tmpToCamera=new THREE.Vector3();
function updateLabels() {
if (!labelItems.length) return;
const width=window.innerWidth;
const height=window.innerHeight;
const zoom=camera.position.z;
const limit=zoom<2.55 ? 82 : zoom<3.2 ? 48 : zoom<4.0 ? 24 : 10;
const cellW=zoom<2.55 ? 72 : 88;
const cellH=zoom<2.55 ? 24 : 28;
const occupied=new Set();
const candidates=[];
world.updateMatrixWorld(true);
for (const item of labelItems) {
tmpWorld.copy(item.local).applyMatrix4(world.matrixWorld);
tmpNormal.copy(tmpWorld).normalize();
tmpToCamera.copy(camera.position).sub(tmpWorld).normalize();
const facing=tmpNormal.dot(tmpToCamera);
if (facing<=.035) { item.el.style.opacity="0"; continue; }
tmpProjected.copy(tmpWorld).project(camera);
const sx=(tmpProjected.x*.5+.5)*width;
const sy=(-tmpProjected.y*.5+.5)*height;
if (tmpProjected.z<-1 || tmpProjected.z>1 || sx<-70 || sx>width+70 || sy<-40 || sy>height+40) {
item.el.style.opacity="0";
continue;
}
candidates.push({item,facing,sx,sy});
}
candidates.sort((a,b)=>Number(b.item.pole)-Number(a.item.pole) || b.facing-a.facing);
let shown=0;
for (const c of candidates) {
const {item,sx,sy,facing}=c;
const gx=Math.floor(sx/cellW);
const gy=Math.floor(sy/cellH);
const key=`${gx}:${gy}`;
if (!item.pole && (shown>=limit || occupied.has(key))) {
item.el.style.opacity="0";
continue;
}
occupied.add(key);
shown++;
item.el.style.transform=`translate3d(${sx}px,${sy}px,0) translate(-50%,-50%)`;
item.el.style.opacity=String(THREE.MathUtils.clamp((facing-.035)*3.2,0,1));
}
}
function animate() {
updateLabels();
renderer.render(scene,camera);
requestAnimationFrame(animate);
}
loadTaiwan();
animate();
