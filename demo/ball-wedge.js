/**
 * Demo pair: ball on an anchored right-triangle wedge (θ = atan(H/W)).
 *
 * Rolling (no slip): finite disk I = ½ m r², friction holds v = ω r.
 *   μ ≥ (1/3) tan θ,  a_cm = (2/3) g sin θ along the slope.
 *
 * Sliding (no rotation): lockRotation: linear momentum only.
 *   Kinetic friction,  a_cm = g (sin θ − μ cos θ)  (needs μ < tan θ to start).
 */

import { SCENE_FORMAT, SCENE_VERSION } from '../src/scene/schema.js';

/** @typedef {import('../src/scene/schema.js').SceneDocument} SceneDocument */

const DEFAULTS = {
  m: 1,
  radius: 0.1,
  thetaDeg: 30,
  /** Base on 0.2 m grid so half-extents land on the 0.1 m minor grid. */
  base: 3.0,
  mu: 0.4,
  g: 9.81,
};

const SIZE_STEP_M = 0.2;

/**
 * Shared anchored wedge + floor + seated ball.
 * @param {object} opts
 * @param {boolean} opts.lockRotation
 * @param {string} opts.name
 * @param {string} opts.demoId
 * @param {string} opts.description
 */
function buildBallOnWedgeScene(opts) {
  const m = opts.m ?? DEFAULTS.m;
  const radius = opts.radius ?? DEFAULTS.radius;
  const thetaTargetDeg = opts.thetaDeg ?? DEFAULTS.thetaDeg;
  const base = opts.base ?? DEFAULTS.base;
  const mu = opts.mu ?? DEFAULTS.mu;
  const g = opts.g ?? DEFAULTS.g;
  const lockRotation = opts.lockRotation === true;

  if (!(m > 0) || !(radius > 0) || !(base > 0)) {
    throw new Error('Need positive m, radius, and base.');
  }

  // Snap height to the size grid: keeps vertices on minor grid lines at θ ≈ target.
  const height = Math.round((base * Math.tan((thetaTargetDeg * Math.PI) / 180)) / SIZE_STEP_M) * SIZE_STEP_M;
  const theta = Math.atan(height / base);
  const thetaDeg = (theta * 180) / Math.PI;
  const L = Math.hypot(base, height);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);

  // AABB centre: hypotenuse from (0, 0) → (base, height). Matter +y down.
  const aabbCx = base / 2;
  const aabbCy = height / 2;

  // Downslope û, outward normal from the slope (into the ball).
  const ux = cosT;
  const uy = sinT;
  const nx = sinT;
  const ny = -cosT;

  const along = L * 0.18;
  const nest = 0.008;
  const ballX = along * ux + (radius - nest) * nx;
  const ballY = along * uy + (radius - nest) * ny;

  const groundH = 0.2;
  const groundW = 5;
  const toeX = base;
  const groundCx = toeX + groundW * 0.2;
  const groundCy = height + groundH / 2 - 0.1;

  const friction = {
    restitution: 0,
    muK: mu,
    muS: mu,
    frictionAir: 0,
  };

  const ballMaterial = { ...friction };
  if (lockRotation) ballMaterial.lockRotation = true;

  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: {
      name: opts.name,
      source: 'demo',
      demoId: opts.demoId,
      description: opts.description,
    },
    metricOrigin: { x: 0, y: 0 },
    environment: {
      gravity: { enabled: true, g },
      air: { enabled: false, cd: 0.47, area: 0.045, rho: 1.225 },
    },
    camera: { s: 0.55 },
    bodies: [
      {
        id: 'wedge_1',
        type: 'wedge',
        position: { x: aabbCx, y: aabbCy },
        angle: 0,
        mass: 1,
        isStatic: true,
        geometry: { baseWidth: base, height },
        material: { ...friction },
      },
      {
        id: 'ground_1',
        type: 'ground',
        position: { x: groundCx, y: groundCy },
        angle: 0,
        geometry: { width: groundW, height: groundH },
        material: { restitution: 0, muK: mu, muS: mu, frictionAir: 0 },
      },
      {
        id: 'ball_1',
        type: 'ball',
        position: { x: ballX, y: ballY },
        angle: 0,
        mass: m,
        velocity: { vx: 0, vy: 0 },
        geometry: { radius },
        material: ballMaterial,
      },
    ],
    constraints: [],
  };
}

/**
 * @param {object} [opts]
 * @returns {SceneDocument}
 */
export function buildBallWedgeRollingScene(opts = {}) {
  const m = opts.m ?? DEFAULTS.m;
  const radius = opts.radius ?? DEFAULTS.radius;
  const thetaTargetDeg = opts.thetaDeg ?? DEFAULTS.thetaDeg;
  const base = opts.base ?? DEFAULTS.base;
  const mu = opts.mu ?? DEFAULTS.mu;
  const g = opts.g ?? DEFAULTS.g;
  const height = Math.round((base * Math.tan((thetaTargetDeg * Math.PI) / 180)) / SIZE_STEP_M) * SIZE_STEP_M;
  const theta = Math.atan(height / base);
  const thetaDeg = (theta * 180) / Math.PI;
  const aRoll = (2 / 3) * g * Math.sin(theta);
  const muMin = Math.tan(theta) / 3;

  return buildBallOnWedgeScene({
    ...opts,
    lockRotation: false,
    name: 'Ball rolling down a wedge (no slip)',
    demoId: 'ball-wedge-rolling',
    description:
      `Anchored wedge θ ≈ ${thetaDeg.toFixed(1)}°. Solid disk m = ${m} kg, r = ${radius} m, `
      + `released from rest. Rotation free — rolling without slip (I = ½mr²). `
      + `Coulomb μ = ${mu} (need μ ≥ (1/3)tanθ ≈ ${muMin.toFixed(3)}). `
      + `Ideal a_cm = (2/3) g sinθ ≈ ${aRoll.toFixed(3)} m/s² along the slope.`,
  });
}

/**
 * @param {object} [opts]
 * @returns {SceneDocument}
 */
export function buildBallWedgeSlidingScene(opts = {}) {
  const m = opts.m ?? DEFAULTS.m;
  const radius = opts.radius ?? DEFAULTS.radius;
  const thetaTargetDeg = opts.thetaDeg ?? DEFAULTS.thetaDeg;
  const base = opts.base ?? DEFAULTS.base;
  const mu = opts.mu ?? DEFAULTS.mu;
  const g = opts.g ?? DEFAULTS.g;
  const height = Math.round((base * Math.tan((thetaTargetDeg * Math.PI) / 180)) / SIZE_STEP_M) * SIZE_STEP_M;
  const theta = Math.atan(height / base);
  const thetaDeg = (theta * 180) / Math.PI;
  const aSlide = g * (Math.sin(theta) - mu * Math.cos(theta));

  return buildBallOnWedgeScene({
    ...opts,
    lockRotation: true,
    name: 'Ball sliding down a wedge (no rotation)',
    demoId: 'ball-wedge-sliding',
    description:
      `Same anchored wedge θ ≈ ${thetaDeg.toFixed(1)}°. Solid disk m = ${m} kg, r = ${radius} m, `
      + `released from rest with rotation locked — linear momentum only (ω ≡ 0). `
      + `Coulomb μ = ${mu}; kinetic sliding a_cm = g(sinθ − μ cosθ) ≈ ${aSlide.toFixed(3)} m/s² `
      + `along the slope.`,
  });
}
