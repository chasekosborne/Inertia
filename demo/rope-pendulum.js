/**
 * Demo: pendulum on a rope constraint (light inextensible chain).
 *
 * Pivot at the origin, bob released from rest at θ from vertical.
 * Small-angle period T ≈ 2π √(ℓ/g) for a massless rod, a light rope is close.
 *
 * Coupling used to glue a massive end-node onto the bob (2-DOF pin), which
 * drained swing energy. The first/last PBD link is now host ↔ next free node.
 */

import { SCENE_FORMAT, SCENE_VERSION } from '../src/scene/schema.js';
import { buildFreeRopeSceneParts, ROPE_THICKNESS_M } from '../src/physics/rope.js';

/** @typedef {import('../src/scene/schema.js').SceneDocument} SceneDocument */

/**
 * @param {object} [opts]
 * @param {number} [opts.l=1.2]         Pivot-to-COM length (m)
 * @param {number} [opts.thetaDeg=50]   Release angle from vertical (deg)
 * @param {number} [opts.m=1]           Bob mass (kg)
 * @param {number} [opts.radius=0.1]    Bob radius (m)
 * @param {number} [opts.ropeMass=0.05]
 * @param {number} [opts.segments=8]
 * @param {number} [opts.g=9.81]
 * @returns {SceneDocument}
 */
export function buildRopePendulumScene(opts = {}) {
  const l = opts.l ?? 1.2;
  const thetaDeg = opts.thetaDeg ?? 50;
  const m = opts.m ?? 1;
  const radius = opts.radius ?? 0.1;
  const ropeMass = opts.ropeMass ?? 0.05;
  const nSeg = Math.max(4, opts.segments ?? 8);
  const g = opts.g ?? 9.81;
  const thickness = ROPE_THICKNESS_M;

  if (!(l > 2 * radius) || !(m > 0) || !(ropeMass > 0)) {
    throw new Error('Need ℓ > 2r and positive masses for the rope pendulum.');
  }

  const theta = (thetaDeg * Math.PI) / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  // Matter +y down: hanging vertical is +y.
  const bobX = l * sinT;
  const bobY = l * cosT;

  /** @type {{ x: number, y: number }[]} */
  const points = [];
  for (let i = 0; i <= nSeg; i++) {
    const t = i / nSeg;
    points.push({ x: bobX * t, y: bobY * t });
  }

  const { bodies: ropeBodies, constraints } = buildFreeRopeSceneParts(points, {
    segments: nSeg,
    exactNodes: true,
    totalMass: ropeMass,
    thicknessM: thickness,
    muK: 0,
    muS: 0,
    idPrefix: 'rope',
    ropeId: 'rope',
    ropeName: 'Rope',
    attachA: { body: 'anchor_1', local: { x: 0, y: 0 } },
    attachB: { body: 'bob', local: { x: 0, y: 0 } },
  });

  const tSmall = 2 * Math.PI * Math.sqrt(l / g);
  // First elliptic correction: T/T₀ ≈ 1 + (1/16) θ₀².
  const tLarge = tSmall * (1 + (theta * theta) / 16);

  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: {
      name: 'Pendulum on a rope constraint',
      source: 'demo',
      demoId: 'rope-pendulum',
      description:
        `Bob m = ${m} kg, r = ${radius} m, hanging from a light rope (M = ${ropeMass} kg, `
        + `${nSeg} segments) of length ℓ = ${l} m (pivot to COM). Released from rest at `
        + `θ = ${thetaDeg}° from vertical. Frictionless, no air. `
        + `Small-angle T ≈ 2π√(ℓ/g) ≈ ${tSmall.toFixed(3)} s; `
        + `finite-amplitude ≈ ${tLarge.toFixed(3)} s.`,
    },
    metricOrigin: { x: 0, y: 0 },
    environment: {
      gravity: { enabled: true, g },
      air: { enabled: false, cd: 0.47, area: 0.045, rho: 1.225 },
    },
    camera: { s: 0.7 },
    bodies: [
      {
        id: 'anchor_1',
        type: 'anchor',
        position: { x: 0, y: 0 },
        angle: 0,
      },
      {
        id: 'bob',
        type: 'ball',
        position: { x: bobX, y: bobY },
        angle: 0,
        mass: m,
        velocity: { vx: 0, vy: 0 },
        geometry: { radius },
        material: {
          restitution: 0,
          muK: 0,
          muS: 0,
          frictionAir: 0,
          lockRotation: true,
        },
      },
      ...ropeBodies,
    ],
    constraints,
  };
}
