import { REGION_COLORS, DEFAULT_REGION_COLORS } from "./palette.js";

const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");

const LAND_RADIUS = 1.009;
const BORDER_RADIUS = 1.016;
const LABEL_RADIUS = 1.025;
const MIN_CAMERA_Z = 2.0;
const MAX_CAMERA_Z = 5.3;
const DRAG_ACTIVATION_PX = 2.5;
const PINCH_EXPONENT = 0.92;
const MAX_INERTIA_RAD_PER_MS = 0.0015;
const INERTIA_DECAY_MS = 320;
const INERTIA_STOP_RAD_PER_MS = 0.00002;
const FOV_DEG = 40;
const NEAR = 0.1;
const FAR = 100;

const canvas = document.createElement("canvas");
stage.appendChild(canvas);
const gl = canvas.getContext("webgl2", {
  antialias: true,
  alpha: true,
  depth: true,
  powerPreference: "high-performance"
});
if (!gl) throw new Error("WebGL2 unavailable");

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
  }
  return shader;
}

const vertexShader = compile(gl.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform mat3 uRot;
uniform float uRadius;
uniform float uCameraZ;
uniform float uAspect;
uniform float uFovF;
uniform float uNear;
uniform float uFar;
out vec3 vNormal;
void main() {
  vec3 p = normalize(aPosition);
  vec3 world = uRot * (p * uRadius);
  vec3 view = world - vec3(0.0, 0.0, uCameraZ);
  float A = (uFar + uNear) / (uNear - uFar);
  float B = (2.0 * uFar * uNear) / (uNear - uFar);
  gl_Position = vec4(
    view.x * uFovF / uAspect,
    view.y * uFovF,
    A * view.z + B,
    -view.z
  );
  vNormal = normalize(uRot * p);
}
`);

const fragmentShader = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform float uLit;
in vec3 vNormal;
out vec4 outColor;
void main() {
  vec3 lightDir = normalize(vec3(-0.42, 0.53, 0.74));
  float diffuse = max(dot(normalize(vNormal), lightDir), 0.0);
  float lighting = mix(1.0, 0.70 + diffuse * 0.30, uLit);
  outColor = vec4(uColor.rgb * lighting, uColor.a);
}
`);

const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program) || "program link failed");
}
gl.deleteShader(vertexShader);
gl.deleteShader(fragmentShader);

const U = {
  rot: gl.getUniformLocation(program, "uRot"),
  radius: gl.getUniformLocation(program, "uRadius"),
  cameraZ: gl.getUniformLocation(program, "uCameraZ"),
  aspect: gl.getUniformLocation(program, "uAspect"),
  fovF: gl.getUniformLocation(program, "uFovF"),
  near: gl.getUniformLocation(program, "uNear"),
  far: gl.getUniformLocation(program, "uFar"),
  color: gl.getUniformLocation(program, "uColor"),
  lit: gl.getUniformLocation(program, "uLit")
};

gl.useProgram(program);
gl.enable(gl.DEPTH_TEST);
gl.depthFunc(gl.LEQUAL);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

const landBuffer = gl.createBuffer();
const borderBuffer = gl.createBuffer();
const sphereBuffer = gl.createBuffer();
const sphereIndexBuffer = gl.createBuffer();

let meta = null;
let labelItems = [];
let sphereIndexCount = 0;
let worldX = 0;
let worldY = 0;
let worldZ = 0;
let cameraZ = 3.0;
let renderQueued = false;

function stableIndex(value, modulo) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return Math.abs(h) % modulo;
}

function hexColor(hex) {
  const s = String(hex || "#ffffff").replace("#", "");
  const full = s.length === 3 ? s.split("").map(x => x + x).join("") : s.padEnd(6, "f");
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255
  ];
}

function regionColor(region) {
  const override = REGION_COLORS[region.id] ?? REGION_COLORS[region.label];
  if (override) return hexColor(override);
  return hexColor(DEFAULT_REGION_COLORS[stableIndex(region.colorSeed || region.id, DEFAULT_REGION_COLORS.length)]);
}

function mat3Mul(a, b) {
  const out = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      out[c * 3 + r] =
        a[0 * 3 + r] * b[c * 3 + 0] +
        a[1 * 3 + r] * b[c * 3 + 1] +
        a[2 * 3 + r] * b[c * 3 + 2];
    }
  }
  return out;
}
function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1,0,0, 0,c,s, 0,-s,c]);
}
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c,0,-s, 0,1,0, s,0,c]);
}
function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c,s,0, -s,c,0, 0,0,1]);
}
function rotationMatrix() {
  return mat3Mul(rotZ(worldZ), mat3Mul(rotY(worldY), rotX(worldX)));
}
function transform3(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z
  ];
}
function normalize3(v) {
  const d = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / d, v[1] / d, v[2] / d];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function buildSphere(latSegments = 28, lonSegments = 42) {
  const positions = [];
  const indices = [];
  for (let y = 0; y <= latSegments; y++) {
    const v = y / latSegments;
    const theta = v * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let x = 0; x <= lonSegments; x++) {
      const u = x / lonSegments;
      const phi = u * Math.PI * 2;
      positions.push(st * Math.cos(phi), ct, st * Math.sin(phi));
    }
  }
  const stride = lonSegments + 1;
  for (let y = 0; y < latSegments; y++) {
    for (let x = 0; x < lonSegments; x++) {
      const a = y * stride + x;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  sphereIndexCount = indices.length;
  gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIndexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
}

function bindFloatPositions(buffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
}
function bindSnorm16Positions(buffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(0, 3, gl.SHORT, true, 0, 0);
  gl.enableVertexAttribArray(0);
}

function setCommonUniforms(rot) {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  gl.uniformMatrix3fv(U.rot, false, rot);
  gl.uniform1f(U.cameraZ, cameraZ);
  gl.uniform1f(U.aspect, width / height);
  gl.uniform1f(U.fovF, 1 / Math.tan((FOV_DEG * Math.PI / 180) / 2));
  gl.uniform1f(U.near, NEAR);
  gl.uniform1f(U.far, FAR);
}

function drawScene() {
  renderQueued = false;
  if (!meta) return;
  const rot = rotationMatrix();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(program);
  setCommonUniforms(rot);

  bindFloatPositions(sphereBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIndexBuffer);
  gl.uniform1f(U.radius, 1.0);
  gl.uniform1f(U.lit, 1.0);
  gl.uniform4f(U.color, 0.137, 0.498, 0.722, 1.0);
  gl.drawElements(gl.TRIANGLES, sphereIndexCount, gl.UNSIGNED_SHORT, 0);

  bindSnorm16Positions(landBuffer);
  gl.uniform1f(U.radius, LAND_RADIUS);
  gl.uniform1f(U.lit, 1.0);
  for (const region of meta.regions) {
    const c = regionColor(region);
    gl.uniform4f(U.color, c[0], c[1], c[2], 1.0);
    gl.drawArrays(gl.TRIANGLES, region.start, region.count);
  }

  bindSnorm16Positions(borderBuffer);
  gl.uniform1f(U.radius, BORDER_RADIUS);
  gl.uniform1f(U.lit, 0.0);
  gl.uniform4f(U.color, 0.957, 0.969, 0.875, 0.52);
  gl.drawArrays(gl.LINES, 0, meta.borderVertices);

  updateLabels(rot);
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(drawScene);
}

function buildLabels() {
  labelsLayer.replaceChildren();
  labelItems = meta.regions.map(region => {
    const el = document.createElement("div");
    el.className = "label";
    el.textContent = region.label;
    labelsLayer.appendChild(el);
    return {
      el,
      anchor: region.anchor.map(v => v / 32767)
    };
  });
}

function updateLabels(rot) {
  if (!labelItems.length) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = Math.max(1e-6, canvas.width / Math.max(1, canvas.height));
  const f = 1 / Math.tan((FOV_DEG * Math.PI / 180) / 2);
  const limit = cameraZ < 2.45 ? 90 : cameraZ < 3.0 ? 56 : cameraZ < 3.8 ? 30 : 14;
  const cellW = cameraZ < 2.45 ? 72 : 86;
  const cellH = cameraZ < 2.45 ? 24 : 28;
  const occupied = new Set();
  const candidates = [];

  for (const item of labelItems) {
    const unit = normalize3(transform3(rot, item.anchor));
    const world = unit.map(v => v * LABEL_RADIUS);
    const toCamera = normalize3([-world[0], -world[1], cameraZ - world[2]]);
    const facing = dot3(unit, toCamera);
    const viewZ = world[2] - cameraZ;
    if (facing <= 0.035 || viewZ >= -0.01) {
      item.el.style.opacity = "0";
      continue;
    }

    const ndcX = (world[0] * f / aspect) / (-viewZ);
    const ndcY = (world[1] * f) / (-viewZ);
    const sx = (ndcX * 0.5 + 0.5) * width;
    const sy = (-ndcY * 0.5 + 0.5) * height;
    if (sx < -90 || sx > width + 90 || sy < -45 || sy > height + 45) {
      item.el.style.opacity = "0";
      continue;
    }
    candidates.push({ item, facing, sx, sy });
  }

  candidates.sort((a, b) => b.facing - a.facing);
  let shown = 0;
  for (const c of candidates) {
    const gx = Math.floor(c.sx / cellW);
    const gy = Math.floor(c.sy / cellH);
    const key = `${gx}:${gy}`;
    if (shown >= limit || occupied.has(key)) {
      c.item.el.style.opacity = "0";
      continue;
    }
    occupied.add(key);
    shown++;
    c.item.el.style.transform = `translate3d(${c.sx}px,${c.sy}px,0) translate(-50%,-50%)`;
    c.item.el.style.opacity = String(Math.max(0, Math.min(1, (c.facing - 0.035) * 3.2)));
  }
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
  }
  requestRender();
}
window.addEventListener("resize", resize, { passive: true });
window.visualViewport?.addEventListener("resize", resize, { passive: true });

const pointers = new Map();
let dragState = null;
let pinchStartDistance = 0;
let pinchStartCameraZ = cameraZ;
let gestureMode = "idle";

let inertiaYaw = 0;
let inertiaPitch = 0;
let inertiaFrame = 0;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function rotationSensitivity() {
  const minDim = Math.max(320, Math.min(window.innerWidth, window.innerHeight));
  const base = 2.15 / minDim;
  const zoomScale = Math.pow(cameraZ / 3.0, 0.42);
  return Math.max(0.0032, Math.min(0.0063, base * zoomScale));
}

function stopInertia() {
  if (inertiaFrame) cancelAnimationFrame(inertiaFrame);
  inertiaFrame = 0;
  inertiaYaw = 0;
  inertiaPitch = 0;
}

function clampInertia() {
  const speed = Math.hypot(inertiaYaw, inertiaPitch);
  if (speed <= MAX_INERTIA_RAD_PER_MS || speed <= 1e-12) return;
  const k = MAX_INERTIA_RAD_PER_MS / speed;
  inertiaYaw *= k;
  inertiaPitch *= k;
}

function startInertia() {
  clampInertia();
  if (Math.hypot(inertiaYaw, inertiaPitch) < INERTIA_STOP_RAD_PER_MS * 3) {
    stopInertia();
    return;
  }

  let last = performance.now();
  const tick = now => {
    const dt = Math.min(34, Math.max(1, now - last));
    last = now;

    worldY += inertiaYaw * dt;
    const nextX = Math.max(-1.48, Math.min(1.48, worldX + inertiaPitch * dt));
    if (nextX === -1.48 || nextX === 1.48) inertiaPitch = 0;
    worldX = nextX;

    const decay = Math.exp(-dt / INERTIA_DECAY_MS);
    inertiaYaw *= decay;
    inertiaPitch *= decay;

    drawScene();

    if (Math.hypot(inertiaYaw, inertiaPitch) > INERTIA_STOP_RAD_PER_MS) {
      inertiaFrame = requestAnimationFrame(tick);
    } else {
      inertiaFrame = 0;
      inertiaYaw = 0;
      inertiaPitch = 0;
    }
  };
  inertiaFrame = requestAnimationFrame(tick);
}

function beginSingleGesture(point) {
  gestureMode = "drag";
  dragState = {
    x: point.x,
    y: point.y,
    startX: point.x,
    startY: point.y,
    t: point.t,
    active: false
  };
  inertiaYaw = 0;
  inertiaPitch = 0;
}

function beginPinchGesture() {
  const [a, b] = [...pointers.values()];
  gestureMode = "pinch";
  pinchStartDistance = Math.max(1, distance(a, b));
  pinchStartCameraZ = cameraZ;
  dragState = null;
  inertiaYaw = 0;
  inertiaPitch = 0;
}

canvas.addEventListener("pointerdown", e => {
  e.preventDefault();
  stopInertia();
  canvas.setPointerCapture?.(e.pointerId);

  const point = { x: e.clientX, y: e.clientY, t: performance.now() };
  pointers.set(e.pointerId, point);
  document.body.classList.add("dragging");

  if (pointers.size === 1) beginSingleGesture(point);
  else if (pointers.size === 2) beginPinchGesture();
}, { passive: false });

canvas.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();

  const now = performance.now();
  const point = { x: e.clientX, y: e.clientY, t: now };
  pointers.set(e.pointerId, point);

  if (pointers.size === 1 && dragState) {
    const dx = point.x - dragState.x;
    const dy = point.y - dragState.y;
    const total = Math.hypot(point.x - dragState.startX, point.y - dragState.startY);

    if (!dragState.active && total >= DRAG_ACTIVATION_PX) {
      dragState.active = true;
      dragState.x = point.x;
      dragState.y = point.y;
      dragState.t = now;
      return;
    }

    if (dragState.active) {
      const sensitivity = rotationSensitivity();
      const yawDelta = dx * sensitivity;
      const wantedPitch = dy * sensitivity;
      const nextX = Math.max(-1.48, Math.min(1.48, worldX + wantedPitch));
      const appliedPitch = nextX - worldX;

      worldY += yawDelta;
      worldX = nextX;

      const dt = Math.max(4, Math.min(40, now - dragState.t));
      const targetYaw = yawDelta / dt;
      const targetPitch = appliedPitch / dt;

      inertiaYaw = inertiaYaw * 0.58 + targetYaw * 0.42;
      inertiaPitch = inertiaPitch * 0.58 + targetPitch * 0.42;
      clampInertia();

      dragState.x = point.x;
      dragState.y = point.y;
      dragState.t = now;
      requestRender();
    }
  } else if (pointers.size === 2 && gestureMode === "pinch") {
    const [a, b] = [...pointers.values()];
    const currentDistance = Math.max(1, distance(a, b));
    const ratio = currentDistance / pinchStartDistance;

    cameraZ = Math.max(
      MIN_CAMERA_Z,
      Math.min(MAX_CAMERA_Z, pinchStartCameraZ / Math.pow(ratio, PINCH_EXPONENT))
    );
    requestRender();
  }
}, { passive: false });

function endPointer(e, cancelled = false) {
  e.preventDefault();
  pointers.delete(e.pointerId);

  if (!pointers.size) {
    const shouldGlide = !cancelled && gestureMode === "drag" && dragState?.active;
    dragState = null;
    gestureMode = "idle";
    document.body.classList.remove("dragging");
    if (shouldGlide) startInertia();
    else stopInertia();
    return;
  }

  stopInertia();

  if (pointers.size === 1) {
    const point = [...pointers.values()][0];
    beginSingleGesture({ ...point, t: performance.now() });
  } else if (pointers.size === 2) {
    beginPinchGesture();
  }
}

canvas.addEventListener("pointerup", e => endPointer(e, false), { passive: false });
canvas.addEventListener("pointercancel", e => endPointer(e, true), { passive: false });

const block = e => e.preventDefault();
["gesturestart","gesturechange","gestureend","contextmenu","dragstart","selectstart"].forEach(type =>
  document.addEventListener(type, block, { passive: false })
);
document.addEventListener("touchmove", e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

async function load() {
  const [metaResponse, binResponse] = await Promise.all([
    fetch("./baked/meta.json", { cache: "force-cache" }),
    fetch("./baked/map.bin", { cache: "force-cache" })
  ]);
  if (!metaResponse.ok || !binResponse.ok) {
    throw new Error("Baked map assets missing");
  }
  meta = await metaResponse.json();
  const bytes = await binResponse.arrayBuffer();
  const borderOffset = meta.landValues * 2;
  const land = new Int16Array(bytes, 0, meta.landValues);
  const borders = new Int16Array(bytes, borderOffset, meta.borderValues);

  gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, land, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, borders, gl.STATIC_DRAW);

  buildSphere();
  buildLabels();
  resize();
  document.body.classList.add("ready");
}

load().catch(err => {
  console.error(err);
});
