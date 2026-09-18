import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
import { featureTownName, featureCountyName, featureKey, centroidOfFeature, cleanRing } from "./geo.js";
import { geoToVector3WithProjection, sourceLocalXYForProjection } from "./solver_laea.js";

const RADIUS = 1;
const MAX_MESH_EDGE_DEG = 5;
const MAX_BORDER_EDGE_DEG = 4;
const MIN_CAMERA_Z = 2.0;
const MAX_CAMERA_Z = 5.3;
const ROTATION_SPEED = 0.0062;

export function createTaiwanView(stage, labelsLayer) {
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

  let projection = null;
  let labelItems = [];
  const midpointCoord = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const mappedUnit = coord => geoToVector3WithProjection(coord[0], coord[1], projection, 1).normalize();
  const geoToVector3 = (lon, lat, radius = RADIUS) => geoToVector3WithProjection(lon, lat, projection, radius);
  const sourceLocalXY = (lon, lat) => sourceLocalXYForProjection(lon, lat, projection);

  function emitWarpedTriangle(bucket, a, b, c, depth = 0) {
    const ua = mappedUnit(a), ub = mappedUnit(b), uc = mappedUnit(c);
    const maxEdge = Math.max(ua.angleTo(ub), ub.angleTo(uc), uc.angleTo(ua));
    if (maxEdge > THREE.MathUtils.degToRad(MAX_MESH_EDGE_DEG) && depth < 6) {
      const ab = midpointCoord(a, b), bc = midpointCoord(b, c), ca = midpointCoord(c, a);
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
      const child = landGroup.children[0];
      landGroup.remove(child);
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
  }
  function stableIndex(value, modulo) {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
    return Math.abs(h) % modulo;
  }
  function buildLand(features) {
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
        color: colors[i], roughness: 0.93, metalness: 0, side: THREE.DoubleSide,
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
      const text = (counts.get(town) || 0) > 1 ? `${county}${town}` : town;
      const [lon, lat] = centroidOfFeature(f);
      const el = document.createElement("div");
      el.className = "label";
      el.textContent = text;
      labelsLayer.appendChild(el);
      labelItems.push({ key: featureKey(f), el, local: geoToVector3(lon, lat, RADIUS * 1.025) });
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
      camera.position.z = THREE.MathUtils.clamp(pinchStartCameraZ * pinchStartDistance / currentDistance, MIN_CAMERA_Z, MAX_CAMERA_Z);
      world.rotation.z = twistStartWorldZ - twistDelta;
    }
  }
  function onPointerUp(e) {
    e.preventDefault();
    pointers.delete(e.pointerId);
    if (!pointers.size) {
      lastSingle = null;
      document.body.classList.remove("dragging");
    } else if (pointers.size === 1) lastSingle = { ...[...pointers.values()][0] };
    else if (pointers.size === 2) beginTwoFingerGesture();
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
      const gx = Math.floor(c.sx / cellW), gy = Math.floor(c.sy / cellH), gridKey = `${gx}:${gy}`;
      if (shown >= limit || occupied.has(gridKey)) { c.item.el.style.opacity = "0"; continue; }
      occupied.add(gridKey); shown++;
      c.item.el.style.transform = `translate3d(${c.sx}px,${c.sy}px,0) translate(-50%,-50%)`;
      c.item.el.style.opacity = String(THREE.MathUtils.clamp((c.facing - 0.035) * 3.2, 0, 1));
    }
  }
  function animate() { updateLabels(); renderer.render(scene, camera); requestAnimationFrame(animate); }
  animate();

  return {
    setProjection(value) { projection = value; },
    buildLand,
    buildLabels
  };
}
