import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

const DATA_URL = "./generated/mesh.json";
const RADIUS = 1;
const MIN_CAMERA_Z = 2.0, MAX_CAMERA_Z = 5.3, ROTATION_SPEED = 0.0062;
const stage = document.querySelector("#stage"), labelsLayer = document.querySelector("#labels"), statusEl = document.querySelector("#status");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, .1, 100); camera.position.set(0,0,3);
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"high-performance"});
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setPixelRatio(Math.min(devicePixelRatio||1,2)); stage.appendChild(renderer.domElement);
const world = new THREE.Group(); scene.add(world);
scene.add(new THREE.HemisphereLight(0xe7f5f7,0x082438,1.6));
const key=new THREE.DirectionalLight(0xffffff,1.5); key.position.set(-2.8,3.5,4.8); scene.add(key);
const rim=new THREE.DirectionalLight(0x77c4ec,.7); rim.position.set(3.8,-1.4,-3.2); scene.add(rim);
world.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS,160,112),new THREE.MeshStandardMaterial({color:0x237fb8,roughness:.9,metalness:0})));
world.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS*1.014,120,88),new THREE.MeshBasicMaterial({color:0x8dd7ff,transparent:true,opacity:.055,side:THREE.BackSide})));
const landGroup=new THREE.Group(); world.add(landGroup); let labelItems=[];

function planeToVec([x,y],radius=RADIUS){ const rho=Math.hypot(x,y); if(rho<1e-12)return new THREE.Vector3(0,0,radius); const col=2*Math.atan(rho/2),s=Math.sin(col); return new THREE.Vector3(radius*s*x/rho,radius*s*y/rho,radius*Math.cos(col)); }
function stableIndex(value,modulo){ let h=0; for(let i=0;i<value.length;i++) h=((h<<5)-h+value.charCodeAt(i))|0; return Math.abs(h)%modulo; }
function buildMesh(data){
  const colors=[0x8fa978,0x98af82,0x81986d,0xa4b88d,0x91a87d,0x879f73], buckets=colors.map(()=>[]);
  for(const [a,b,c,ti] of data.triangles){ const bucket=buckets[stableIndex(data.towns[ti].county,colors.length)]; for(const vi of [a,b,c]){ const v=planeToVec(data.vertices[vi],RADIUS*1.009); bucket.push(v.x,v.y,v.z); } }
  buckets.forEach((positions,i)=>{ if(!positions.length)return; const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3)); g.computeVertexNormals(); landGroup.add(new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:colors[i],roughness:.93,metalness:0,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}))); });
  const bp=[]; for(const [a,b] of data.edges){ const va=planeToVec(data.vertices[a],RADIUS*1.016), vb=planeToVec(data.vertices[b],RADIUS*1.016); bp.push(va.x,va.y,va.z,vb.x,vb.y,vb.z); }
  const bg=new THREE.BufferGeometry(); bg.setAttribute("position",new THREE.Float32BufferAttribute(bp,3)); landGroup.add(new THREE.LineSegments(bg,new THREE.LineBasicMaterial({color:0xf4f7df,transparent:true,opacity:.5})));
}
function buildLabels(data){ labelsLayer.replaceChildren(); labelItems=[]; const counts=new Map(); for(const t of data.towns) counts.set(t.town,(counts.get(t.town)||0)+1); for(const t of data.towns){ const el=document.createElement("div"); el.className="label"; el.textContent=(counts.get(t.town)>1?`${t.county}${t.town}`:t.town); labelsLayer.appendChild(el); labelItems.push({el,local:planeToVec(t.centroid,RADIUS*1.025)}); } }

async function load(){ try{ const res=await fetch(DATA_URL,{cache:"no-store"}); if(!res.ok)throw new Error(`mesh ${res.status}`); const data=await res.json(); buildMesh(data); buildLabels(data); const worst=(data.audit||[]).slice(0,3).map(x=>`${x.region} ${Number(x.actual).toFixed(2)}×/目標${Number(x.target).toFixed(2)}`).join("・"); const d=data.diagnostics||{}; statusEl.textContent=`共享邊界 constrained mesh・${data.targetMaxColatDeg}°・${worst}・flip/invalid:${d.invalidPolygons??"?"}`; document.body.classList.add("ready"); }catch(err){console.error(err);statusEl.textContent="mesh solver 尚未產生可載入結果";} }

const pointers=new Map(); let lastSingle=null,pinchStartDistance=0,pinchStartCameraZ=camera.position.z,twistStartAngle=0,twistStartWorldZ=world.rotation.z;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y), angleBetween=(a,b)=>Math.atan2(b.y-a.y,b.x-a.x), normalizeAngle=a=>Math.atan2(Math.sin(a),Math.cos(a));
function beginTwo(){ const [a,b]=[...pointers.values()]; pinchStartDistance=Math.max(1,distance(a,b)); pinchStartCameraZ=camera.position.z; twistStartAngle=angleBetween(a,b); twistStartWorldZ=world.rotation.z; lastSingle=null; }
function down(e){e.preventDefault();document.body.classList.add("interacted","dragging");renderer.domElement.setPointerCapture?.(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===1)lastSingle={x:e.clientX,y:e.clientY};else if(pointers.size===2)beginTwo();}
function move(e){if(!pointers.has(e.pointerId))return;e.preventDefault();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===1){const p=[...pointers.values()][0];if(lastSingle){world.rotation.y+=(p.x-lastSingle.x)*ROTATION_SPEED;world.rotation.x+=(p.y-lastSingle.y)*ROTATION_SPEED;world.rotation.x=THREE.MathUtils.clamp(world.rotation.x,-1.48,1.48);}lastSingle={...p};}else if(pointers.size===2){const[a,b]=[...pointers.values()],d=Math.max(1,distance(a,b)),ang=angleBetween(a,b);camera.position.z=THREE.MathUtils.clamp(pinchStartCameraZ*(pinchStartDistance/d),MIN_CAMERA_Z,MAX_CAMERA_Z);world.rotation.z=twistStartWorldZ-normalizeAngle(ang-twistStartAngle);}}
function up(e){e.preventDefault();pointers.delete(e.pointerId);if(!pointers.size){lastSingle=null;document.body.classList.remove("dragging");}else if(pointers.size===1)lastSingle={...[...pointers.values()][0]};else if(pointers.size===2)beginTwo();}
[["pointerdown",down],["pointermove",move],["pointerup",up],["pointercancel",up]].forEach(([t,f])=>renderer.domElement.addEventListener(t,f,{passive:false}));
const block=e=>e.preventDefault();["gesturestart","gesturechange","gestureend","contextmenu","dragstart","selectstart"].forEach(t=>document.addEventListener(t,block,{passive:false})); document.addEventListener("touchmove",e=>{if(e.touches.length>1)e.preventDefault();},{passive:false});
function resize(){const w=innerWidth,h=innerHeight;camera.aspect=w/Math.max(1,h);camera.updateProjectionMatrix();renderer.setSize(w,h,false);renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));} addEventListener("resize",resize,{passive:true});visualViewport?.addEventListener("resize",resize,{passive:true});resize();
const tmpWorld=new THREE.Vector3(),tmpProjected=new THREE.Vector3(),tmpNormal=new THREE.Vector3(),tmpToCamera=new THREE.Vector3();
function updateLabels(){const w=innerWidth,h=innerHeight,zoom=camera.position.z,limit=zoom<2.45?90:zoom<3?56:zoom<3.8?30:14,cellW=zoom<2.45?72:86,cellH=zoom<2.45?24:28,occupied=new Set(),candidates=[];world.updateMatrixWorld(true);for(const item of labelItems){tmpWorld.copy(item.local).applyMatrix4(world.matrixWorld);tmpNormal.copy(tmpWorld).normalize();tmpToCamera.copy(camera.position).sub(tmpWorld).normalize();const facing=tmpNormal.dot(tmpToCamera);if(facing<=.035){item.el.style.opacity="0";continue;}tmpProjected.copy(tmpWorld).project(camera);const sx=(tmpProjected.x*.5+.5)*w,sy=(-tmpProjected.y*.5+.5)*h;if(tmpProjected.z<-1||tmpProjected.z>1||sx<-90||sx>w+90||sy<-45||sy>h+45){item.el.style.opacity="0";continue;}candidates.push({item,facing,sx,sy});}candidates.sort((a,b)=>b.facing-a.facing);let shown=0;for(const c of candidates){const gx=Math.floor(c.sx/cellW),gy=Math.floor(c.sy/cellH),k=`${gx}:${gy}`;if(shown>=limit||occupied.has(k)){c.item.el.style.opacity="0";continue;}occupied.add(k);shown++;c.item.el.style.transform=`translate3d(${c.sx}px,${c.sy}px,0) translate(-50%,-50%)`;c.item.el.style.opacity=String(THREE.MathUtils.clamp((c.facing-.035)*3.2,0,1));}}
function animate(){updateLabels();renderer.render(scene,camera);requestAnimationFrame(animate);} load();animate();
