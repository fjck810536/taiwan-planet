import { REGION_COLORS, DEFAULT_REGION_COLORS } from "./palette.js";

const stage = document.querySelector("#stage");
const labelsLayer = document.querySelector("#labels");
const compass = document.querySelector("#compass");
const compassNeedle = document.querySelector("#compassNeedle");

const LAND_RADIUS = 1.009;
const BORDER_RADIUS = 1.016;
const LABEL_RADIUS = 1.025;

const MIN_CAMERA_Z = 2.0;
const MAX_CAMERA_Z = 5.3;
const FOV_DEG = 40;
const NEAR = 0.1;
const FAR = 100;

// Camera-trackball tuning.
const ARC_RADIUS_SCREEN = 0.46;
const DRAG_START_PX = 1.5;
const MAX_SPIN_RAD_PER_MS = 0.0060;
const SPIN_DECAY_MS = 1800;
const SPIN_STOP_RAD_PER_MS = 0.000006;
const PINCH_EXPONENT = 0.96;
const TWIST_START_RAD = 1.5 * Math.PI / 180;
const TWIST_STEP_EPS = 0.0008;

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

uniform mat3 uViewRot;
uniform float uRadius;
uniform float uCameraZ;
uniform float uAspect;
uniform float uFovF;
uniform float uNear;
uniform float uFar;

out vec3 vNormal;

void main() {
  vec3 world = normalize(aPosition) * uRadius;

  // The globe is fixed in world space.
  // uViewRot is the camera trackball's world->camera rotation.
  vec3 rotated = uViewRot * world;
  vec3 view = rotated - vec3(0.0, 0.0, uCameraZ);

  float A = (uFar + uNear) / (uNear - uFar);
  float B = (2.0 * uFar * uNear) / (uNear - uFar);

  gl_Position = vec4(
    view.x * uFovF / uAspect,
    view.y * uFovF,
    A * view.z + B,
    -view.z
  );

  vNormal = normalize(uViewRot * normalize(aPosition));
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
  viewRot: gl.getUniformLocation(program, "uViewRot"),
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
let poleItems = [];
let resolvedPoles = null;
let sphereIndexCount = 0;

const POLAR_CORE_REGION_IDS = [
  "台北市|大同區",
  "台北市|中山區",
  "台北市|中正區",
  "台北市|大安區",
  "台北市|松山區",
  "台北市|信義區"
];

const INITIAL_NORTH_VIEW = normalize3([0, 0.82, 0.58]);

// Spherical compass tuning.
// The compass shows the great-circle direction from the screen-center surface point
// toward the canonical north pole. Near the pole that direction becomes undefined,
// so the needle intentionally destabilizes instead of fading out.
const COMPASS_UNSTABLE_START_RAD = 8 * Math.PI / 180;
const COMPASS_CHAOS_FULL_RAD = 1 * Math.PI / 180;
const COMPASS_CHAOS_SPIN_RAD_PER_MS = 0.020;
const COMPASS_TANGENT_EPS = 1e-7;

// One pose only: camera trackball orientation.
// This quaternion maps world axes into camera/view axes.
let cameraViewQuat = [0, 0, 0, 1];
let cameraZ = 3.0;

let renderQueued = false;
let compassChaosFrame = 0;
let compassNorthingFrame = 0;

function stableIndex(value, modulo) {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % modulo;
}

function hexColor(hex) {
  const s = String(hex || "#ffffff").replace("#", "");
  const full = s.length === 3
    ? s.split("").map(x => x + x).join("")
    : s.padEnd(6, "f");

  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255
  ];
}

function regionColor(region) {
  const override = REGION_COLORS[region.id] ?? REGION_COLORS[region.label];
  if (override) return hexColor(override);

  return hexColor(
    DEFAULT_REGION_COLORS[
      stableIndex(region.colorSeed || region.id, DEFAULT_REGION_COLORS.length)
    ]
  );
}

function normalize3(v) {
  const d = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / d, v[1] / d, v[2] / d];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function transform3(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z
  ];
}

function transform3Transpose(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z
  ];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep01(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function quatNormalize(q) {
  const d = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / d, q[1] / d, q[2] / d, q[3] / d];
}

function quatMultiply(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];

  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

function quatFromAxisAngle(axisRaw, angle) {
  const axis = normalize3(axisRaw);
  const half = angle * 0.5;
  const s = Math.sin(half);

  return quatNormalize([
    axis[0] * s,
    axis[1] * s,
    axis[2] * s,
    Math.cos(half)
  ]);
}

function quatFromUnitVectors(a, b) {
  const dot = Math.max(-1, Math.min(1, dot3(a, b)));

  if (dot < -0.999999) {
    const fallback = Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    return quatFromAxisAngle(normalize3(cross3(a, fallback)), Math.PI);
  }

  const cross = cross3(a, b);
  return quatNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}

function quatToMat3(qRaw) {
  const q = quatNormalize(qRaw);
  const x = q[0], y = q[1], z = q[2], w = q[3];

  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;

  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy + wz),     2 * (xz - wy),
    2 * (xy - wz),     1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy),     2 * (yz - wx),     1 - 2 * (xx + yy)
  ]);
}

function cameraViewMatrix() {
  return quatToMat3(cameraViewQuat);
}

function buildSphere(latSegments = 28, lonSegments = 42) {
  const positions = [];
  const indices = [];

  for (let y = 0; y <= latSegments; y++) {
    const v = y / latSegments;
    const theta = v * Math.PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);

    for (let x = 0; x <= lonSegments; x++) {
      const u = x / lonSegments;
      const phi = u * Math.PI * 2;
      positions.push(
        st * Math.cos(phi),
        ct,
        st * Math.sin(phi)
      );
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
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array(indices),
    gl.STATIC_DRAW
  );
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

function setCommonUniforms(viewRot) {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);

  gl.uniformMatrix3fv(U.viewRot, false, viewRot);
  gl.uniform1f(U.cameraZ, cameraZ);
  gl.uniform1f(U.aspect, width / height);
  gl.uniform1f(U.fovF, 1 / Math.tan((FOV_DEG * Math.PI / 180) / 2));
  gl.uniform1f(U.near, NEAR);
  gl.uniform1f(U.far, FAR);
}

function drawScene() {
  renderQueued = false;
  if (!meta) return;

  const viewRot = cameraViewMatrix();

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(program);
  setCommonUniforms(viewRot);

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

  updateLabels(viewRot);
  updatePoleMarkers(viewRot);
  updateCompass(viewRot);
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(drawScene);
}

function resolvePoleAnchors() {
  if (resolvedPoles) return resolvedPoles;

  if (meta?.poles?.north && meta?.poles?.south) {
    resolvedPoles = {
      north: normalize3(meta.poles.north.map(v => v / 32767)),
      south: normalize3(meta.poles.south.map(v => v / 32767))
    };
    return resolvedPoles;
  }

  const anchors = POLAR_CORE_REGION_IDS.map(id => {
    const region = meta.regions.find(item => item.id === id);
    if (!region) throw new Error(`Polar core region missing: ${id}`);
    return normalize3(region.anchor.map(v => v / 32767));
  });

  const north = normalize3(
    anchors.reduce(
      (sum, v) => [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]],
      [0, 0, 0]
    )
  );

  resolvedPoles = {
    north,
    south: north.map(v => -v)
  };
  return resolvedPoles;
}

function buildPoleMarkers() {
  const poles = resolvePoleAnchors();

  poleItems = [
    { id: "north", anchor: poles.north },
    { id: "south", anchor: poles.south }
  ].map(item => {
    const el = document.createElement("div");
    el.className = `pole-point ${item.id}`;
    el.dataset.pole = item.id;
    labelsLayer.appendChild(el);
    return { ...item, el };
  });

  cameraViewQuat = quatFromUnitVectors(poles.north, INITIAL_NORTH_VIEW);
}

function updatePoleMarkers(viewRot) {
  if (!poleItems.length) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = Math.max(1e-6, canvas.width / Math.max(1, canvas.height));
  const f = 1 / Math.tan((FOV_DEG * Math.PI / 180) / 2);
  const radius = BORDER_RADIUS + 0.006;

  for (const item of poleItems) {
    const cameraUnit = normalize3(transform3(viewRot, item.anchor));
    const rotated = cameraUnit.map(v => v * radius);
    const toCamera = normalize3([
      -rotated[0],
      -rotated[1],
      cameraZ - rotated[2]
    ]);
    const facing = dot3(cameraUnit, toCamera);
    const viewZ = rotated[2] - cameraZ;

    if (facing <= 0.0 || viewZ >= -0.01) {
      item.el.style.opacity = "0";
      continue;
    }

    const ndcX = (rotated[0] * f / aspect) / (-viewZ);
    const ndcY = (rotated[1] * f) / (-viewZ);
    const sx = (ndcX * 0.5 + 0.5) * width;
    const sy = (-ndcY * 0.5 + 0.5) * height;

    if (sx < -16 || sx > width + 16 || sy < -16 || sy > height + 16) {
      item.el.style.opacity = "0";
      continue;
    }

    item.el.style.transform =
      `translate3d(${sx}px,${sy}px,0) translate(-50%,-50%)`;
    item.el.style.opacity = String(
      Math.max(0, Math.min(1, facing * 4.0))
    );
  }
}

function compassState(viewRot, now = performance.now()) {
  const poles = resolvePoleAnchors();
  const north = poles.north;

  // The screen-center ray hits the front-most point of the globe at +Z in camera space.
  // Convert that surface normal back into world space.
  const centerPoint = normalize3(
    transform3Transpose(viewRot, [0, 0, 1])
  );

  const northDot = Math.max(-1, Math.min(1, dot3(centerPoint, north)));
  const poleDistance = Math.acos(northDot);

  // Project north into the tangent plane at the current center point.
  const tangent = [
    north[0] - northDot * centerPoint[0],
    north[1] - northDot * centerPoint[1],
    north[2] - northDot * centerPoint[2]
  ];
  const tangentLength = Math.hypot(tangent[0], tangent[1], tangent[2]);

  let baseAngle = 0;
  if (tangentLength > COMPASS_TANGENT_EPS) {
    const cameraTangent = transform3(
      viewRot,
      tangent.map(v => v / tangentLength)
    );
    // CSS zero degrees points upward. Positive rotation is clockwise on screen.
    baseAngle = Math.atan2(cameraTangent[0], cameraTangent[1]);
  }

  const chaosMix = smoothstep01(
    (COMPASS_UNSTABLE_START_RAD - poleDistance) /
    (COMPASS_UNSTABLE_START_RAD - COMPASS_CHAOS_FULL_RAD)
  );

  if (poleDistance <= COMPASS_CHAOS_FULL_RAD || tangentLength <= COMPASS_TANGENT_EPS) {
    const chaos =
      now * COMPASS_CHAOS_SPIN_RAD_PER_MS +
      Math.sin(now * 0.031) * 1.3 +
      Math.sin(now * 0.017 + 1.7) * 0.9;
    return { angle: chaos, baseAngle, poleDistance, chaosMix: 1 };
  }

  const chaoticAngle =
    baseAngle +
    chaosMix * (
      now * COMPASS_CHAOS_SPIN_RAD_PER_MS * 0.65 +
      Math.sin(now * 0.027) * 0.9 +
      Math.sin(now * 0.013 + 0.8) * 0.55
    );

  return {
    angle: chaoticAngle,
    baseAngle,
    poleDistance,
    chaosMix
  };
}

function updateCompass(viewRot, now = performance.now()) {
  if (!compass || !compassNeedle || !meta) return;

  const state = compassState(viewRot, now);
  compassNeedle.style.transform =
    `translate(-50%,-50%) rotate(${state.angle}rad)`;

  compass.classList.toggle("unstable", state.chaosMix > 0.02);
  compass.classList.toggle("chaotic", state.chaosMix >= 0.999);

  if (state.chaosMix > 0.02 && !compassChaosFrame) {
    const tick = time => {
      compassChaosFrame = 0;
      if (!meta) return;

      const liveViewRot = cameraViewMatrix();
      const live = compassState(liveViewRot, time);
      compassNeedle.style.transform =
        `translate(-50%,-50%) rotate(${live.angle}rad)`;
      compass.classList.toggle("unstable", live.chaosMix > 0.02);
      compass.classList.toggle("chaotic", live.chaosMix >= 0.999);

      if (live.chaosMix > 0.02) {
        compassChaosFrame = requestAnimationFrame(tick);
      }
    };
    compassChaosFrame = requestAnimationFrame(tick);
  } else if (state.chaosMix <= 0.02 && compassChaosFrame) {
    cancelAnimationFrame(compassChaosFrame);
    compassChaosFrame = 0;
  }
}

function stopCompassNorthing() {
  if (compassNorthingFrame) cancelAnimationFrame(compassNorthingFrame);
  compassNorthingFrame = 0;
}

function alignScreenNorth() {
  if (!meta || !compass) return;

  stopSpin();
  stopCompassNorthing();

  const viewRot = cameraViewMatrix();
  const state = compassState(viewRot);

  // At the north pole itself, local north is mathematically undefined.
  // Keep the intentional polar-chaos behavior instead of inventing a direction.
  if (
    state.poleDistance <= COMPASS_CHAOS_FULL_RAD ||
    !Number.isFinite(state.baseAngle)
  ) {
    compass.classList.add("chaotic");
    return;
  }

  const totalRoll = normalizeAngle(state.baseAngle);
  if (Math.abs(totalRoll) < 0.001) {
    requestRender();
    return;
  }

  const duration = 260;
  const started = performance.now();
  let applied = 0;

  const tick = now => {
    const t = clamp01((now - started) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const targetApplied = totalRoll * eased;
    const step = targetApplied - applied;
    applied = targetApplied;

    const rollDelta = quatFromAxisAngle([0, 0, 1], step);
    cameraViewQuat = quatNormalize(
      quatMultiply(rollDelta, cameraViewQuat)
    );

    drawScene();

    if (t < 1) {
      compassNorthingFrame = requestAnimationFrame(tick);
    } else {
      compassNorthingFrame = 0;
      requestRender();
    }
  };

  compassNorthingFrame = requestAnimationFrame(tick);
}

compass?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  alignScreenNorth();
});

function buildLabels() {
  labelsLayer.replaceChildren();

  labelItems = meta.regions
    .filter(region => region.showLabel !== false)
    .map(region => {
      const el = document.createElement("div");
      el.className = "label";
      el.textContent = region.label;
      labelsLayer.appendChild(el);

      return {
        el,
        anchor: region.anchor.map(v => v / 32767),
        alwaysLabel: region.alwaysLabel === true,
        labelOffset: region.labelOffset || [0, 0],
        offshore: region.offshore === true
      };
    });
}

function updateLabels(viewRot) {
  if (!labelItems.length) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = Math.max(
    1e-6,
    canvas.width / Math.max(1, canvas.height)
  );
  const f = 1 / Math.tan((FOV_DEG * Math.PI / 180) / 2);

  const limit =
    cameraZ < 2.45 ? 90 :
    cameraZ < 3.0 ? 56 :
    cameraZ < 3.8 ? 30 :
    14;

  const cellW = cameraZ < 2.45 ? 72 : 86;
  const cellH = cameraZ < 2.45 ? 24 : 28;

  const occupied = new Set();
  const candidates = [];

  for (const item of labelItems) {
    const cameraUnit = normalize3(transform3(viewRot, item.anchor));
    const rotated = cameraUnit.map(v => v * LABEL_RADIUS);

    const toCamera = normalize3([
      -rotated[0],
      -rotated[1],
      cameraZ - rotated[2]
    ]);

    const facing = dot3(cameraUnit, toCamera);
    const viewZ = rotated[2] - cameraZ;

    if (facing <= 0.035 || viewZ >= -0.01) {
      item.el.style.opacity = "0";
      continue;
    }

    const ndcX = (rotated[0] * f / aspect) / (-viewZ);
    const ndcY = (rotated[1] * f) / (-viewZ);

    const sx = (ndcX * 0.5 + 0.5) * width + item.labelOffset[0];
    const sy = (-ndcY * 0.5 + 0.5) * height + item.labelOffset[1];

    if (
      sx < -90 || sx > width + 90 ||
      sy < -45 || sy > height + 45
    ) {
      item.el.style.opacity = "0";
      continue;
    }

    candidates.push({ item, facing, sx, sy, alwaysLabel: item.alwaysLabel });
  }

  candidates.sort((a, b) =>
    Number(b.alwaysLabel) - Number(a.alwaysLabel) || b.facing - a.facing
  );

  let shown = 0;

  for (const c of candidates) {
    const gx = Math.floor(c.sx / cellW);
    const gy = Math.floor(c.sy / cellH);
    const key = `${gx}:${gy}`;

    if (!c.alwaysLabel && (shown >= limit || occupied.has(key))) {
      c.item.el.style.opacity = "0";
      continue;
    }

    occupied.add(key);
    if (!c.alwaysLabel) shown++;

    c.item.el.style.transform =
      `translate3d(${c.sx}px,${c.sy}px,0) translate(-50%,-50%)`;

    c.item.el.style.opacity = String(
      Math.max(0, Math.min(1, (c.facing - 0.035) * 3.2))
    );
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

// -----------------------------------------------------------------------------
// Camera Trackball
// -----------------------------------------------------------------------------

const pointers = new Map();

let gestureMode = "idle";
let dragState = null;

let pinchStartDistance = 0;
let pinchStartCameraZ = cameraZ;
let pinchStartAngle = 0;
let pinchLastAngle = 0;
let pinchAccumulatedTwist = 0;
let pinchTwistActive = false;

let spinVelocity = [0, 0, 0];
let spinFrame = 0;

const distance = (a, b) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const angleBetween = (a, b) =>
  Math.atan2(b.y - a.y, b.x - a.x);

const normalizeAngle = angle =>
  Math.atan2(Math.sin(angle), Math.cos(angle));

function mapToTrackball(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const radius = Math.max(
    1,
    Math.min(rect.width, rect.height) * ARC_RADIUS_SCREEN
  );

  let x =
    (clientX - (rect.left + rect.width * 0.5)) / radius;

  let y =
    ((rect.top + rect.height * 0.5) - clientY) / radius;

  const d2 = x * x + y * y;
  let z;

  // Sphere near the center, hyperbolic sheet near the rim.
  // This avoids the "hard edge" feeling of a clamped virtual sphere.
  if (d2 <= 0.5) {
    z = Math.sqrt(Math.max(0, 1 - d2));
  } else {
    z = 0.5 / Math.sqrt(d2);
  }

  return normalize3([x, y, z]);
}

function angularVectorFromQuat(qRaw, dt) {
  let q = quatNormalize(qRaw);

  // q and -q encode the same rotation.
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];

  const xyz = Math.hypot(q[0], q[1], q[2]);
  if (xyz < 1e-8) return [0, 0, 0];

  const angle =
    2 * Math.atan2(xyz, Math.max(1e-8, q[3]));

  const speed =
    angle / Math.max(4, Math.min(40, dt));

  return [
    q[0] / xyz * speed,
    q[1] / xyz * speed,
    q[2] / xyz * speed
  ];
}

function clampSpin(v) {
  const speed = Math.hypot(v[0], v[1], v[2]);

  if (speed <= MAX_SPIN_RAD_PER_MS || speed < 1e-12) {
    return v;
  }

  const k = MAX_SPIN_RAD_PER_MS / speed;

  return [
    v[0] * k,
    v[1] * k,
    v[2] * k
  ];
}

function stopSpin() {
  if (spinFrame) cancelAnimationFrame(spinFrame);
  spinFrame = 0;
  spinVelocity = [0, 0, 0];
}

function startSpin() {
  spinVelocity = clampSpin(spinVelocity);

  if (Math.hypot(...spinVelocity) < SPIN_STOP_RAD_PER_MS * 4) {
    stopSpin();
    return;
  }

  let last = performance.now();

  const tick = now => {
    const dt = Math.min(34, Math.max(1, now - last));
    last = now;

    const speed = Math.hypot(...spinVelocity);

    if (speed <= SPIN_STOP_RAD_PER_MS) {
      spinFrame = 0;
      spinVelocity = [0, 0, 0];
      return;
    }

    const axis = [
      spinVelocity[0] / speed,
      spinVelocity[1] / speed,
      spinVelocity[2] / speed
    ];

    // Left-multiply because this angular velocity lives in camera/view space.
    const delta =
      quatFromAxisAngle(axis, speed * dt);

    cameraViewQuat = quatNormalize(
      quatMultiply(delta, cameraViewQuat)
    );

    const decay = Math.exp(-dt / SPIN_DECAY_MS);

    spinVelocity = [
      spinVelocity[0] * decay,
      spinVelocity[1] * decay,
      spinVelocity[2] * decay
    ];

    drawScene();
    spinFrame = requestAnimationFrame(tick);
  };

  spinFrame = requestAnimationFrame(tick);
}

function beginDrag(point) {
  gestureMode = "drag";

  dragState = {
    startX: point.x,
    startY: point.y,
    lastT: point.t,
    lastVec: mapToTrackball(point.x, point.y),
    active: false
  };

  spinVelocity = [0, 0, 0];
}

function beginPinch() {
  const [a, b] = [...pointers.values()];

  gestureMode = "pinch";

  pinchStartDistance = Math.max(1, distance(a, b));
  pinchStartCameraZ = cameraZ;

  pinchStartAngle = angleBetween(a, b);
  pinchLastAngle = pinchStartAngle;
  pinchAccumulatedTwist = 0;
  pinchTwistActive = false;

  dragState = null;
  spinVelocity = [0, 0, 0];
}

canvas.addEventListener("pointerdown", e => {
  e.preventDefault();

  stopSpin();
  stopCompassNorthing();
  canvas.setPointerCapture?.(e.pointerId);

  const point = {
    x: e.clientX,
    y: e.clientY,
    t: performance.now()
  };

  pointers.set(e.pointerId, point);
  document.body.classList.add("dragging");

  if (pointers.size === 1) {
    beginDrag(point);
  } else if (pointers.size === 2) {
    beginPinch();
  }
}, { passive: false });

canvas.addEventListener("pointermove", e => {
  if (!pointers.has(e.pointerId)) return;

  e.preventDefault();

  const now = performance.now();
  const point = {
    x: e.clientX,
    y: e.clientY,
    t: now
  };

  pointers.set(e.pointerId, point);

  if (
    pointers.size === 1 &&
    gestureMode === "drag" &&
    dragState
  ) {
    const travel = Math.hypot(
      point.x - dragState.startX,
      point.y - dragState.startY
    );

    if (!dragState.active && travel < DRAG_START_PX) {
      return;
    }

    dragState.active = true;

    const currentVec =
      mapToTrackball(point.x, point.y);

    // This delta is in view space.
    // Applying it to cameraViewQuat means the CAMERA orbits the fixed globe.
    const delta =
      quatFromUnitVectors(dragState.lastVec, currentVec);

    cameraViewQuat = quatNormalize(
      quatMultiply(delta, cameraViewQuat)
    );

    const instant =
      angularVectorFromQuat(delta, now - dragState.lastT);

    spinVelocity = clampSpin([
      spinVelocity[0] * 0.52 + instant[0] * 0.48,
      spinVelocity[1] * 0.52 + instant[1] * 0.48,
      spinVelocity[2] * 0.52 + instant[2] * 0.48
    ]);

    dragState.lastVec = currentVec;
    dragState.lastT = now;

    requestRender();
    return;
  }

  if (
    pointers.size === 2 &&
    gestureMode === "pinch"
  ) {
    const [a, b] = [...pointers.values()];

    // Dolly / zoom.
    const currentDistance =
      Math.max(1, distance(a, b));

    const ratio =
      currentDistance / pinchStartDistance;

    cameraZ = Math.max(
      MIN_CAMERA_Z,
      Math.min(
        MAX_CAMERA_Z,
        pinchStartCameraZ /
          Math.pow(ratio, PINCH_EXPONENT)
      )
    );

    // Google-Maps-style two-finger twist.
    // Screen coordinates have Y downward, so the view-space roll uses -twistStep.
    const currentAngle = angleBetween(a, b);
    const twistStep =
      normalizeAngle(currentAngle - pinchLastAngle);

    pinchAccumulatedTwist =
      normalizeAngle(currentAngle - pinchStartAngle);

    if (
      !pinchTwistActive &&
      Math.abs(pinchAccumulatedTwist) >= TWIST_START_RAD
    ) {
      pinchTwistActive = true;
    }

    if (
      pinchTwistActive &&
      Math.abs(twistStep) >= TWIST_STEP_EPS
    ) {
      const rollDelta =
        quatFromAxisAngle([0, 0, 1], -twistStep);

      cameraViewQuat = quatNormalize(
        quatMultiply(rollDelta, cameraViewQuat)
      );
    }

    pinchLastAngle = currentAngle;

    requestRender();
  }
}, { passive: false });

function endPointer(e, cancelled = false) {
  e.preventDefault();

  pointers.delete(e.pointerId);

  if (!pointers.size) {
    const shouldSpin =
      !cancelled &&
      gestureMode === "drag" &&
      dragState?.active;

    gestureMode = "idle";
    dragState = null;

    document.body.classList.remove("dragging");

    if (shouldSpin) startSpin();
    else stopSpin();

    return;
  }

  stopSpin();

  // Gesture-state transition is explicit.
  // Re-anchor the surviving finger instead of reusing a stale trackball delta.
  if (pointers.size === 1) {
    const point = [...pointers.values()][0];

    beginDrag({
      ...point,
      t: performance.now()
    });
  } else if (pointers.size === 2) {
    beginPinch();
  }
}

canvas.addEventListener(
  "pointerup",
  e => endPointer(e, false),
  { passive: false }
);

canvas.addEventListener(
  "pointercancel",
  e => endPointer(e, true),
  { passive: false }
);

const block = e => e.preventDefault();

[
  "gesturestart",
  "gesturechange",
  "gestureend",
  "contextmenu",
  "dragstart",
  "selectstart"
].forEach(type => {
  document.addEventListener(type, block, { passive: false });
});

document.addEventListener("touchmove", e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

async function load() {
  const [metaResponse, binResponse] = await Promise.all([
    fetch("./baked/meta.json", { cache: "no-cache" }),
    fetch("./baked/map.bin", { cache: "no-cache" })
  ]);

  if (!metaResponse.ok || !binResponse.ok) {
    throw new Error("Baked map assets missing");
  }

  meta = await metaResponse.json();

  const bytes = await binResponse.arrayBuffer();
  const borderOffset = meta.landValues * 2;

  const land =
    new Int16Array(bytes, 0, meta.landValues);

  const borders =
    new Int16Array(bytes, borderOffset, meta.borderValues);

  gl.bindBuffer(gl.ARRAY_BUFFER, landBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, land, gl.STATIC_DRAW);

  gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, borders, gl.STATIC_DRAW);

  buildSphere();
  buildLabels();
  buildPoleMarkers();
  resize();

  document.body.classList.add("ready");
}

load().catch(err => {
  console.error(err);
});
