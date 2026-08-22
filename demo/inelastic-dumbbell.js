/**
 * Demo: inelastic collision of a point mass with a stationary dumbbell
 * (frictionless horizontal table, top view).
 *
 * A mass m with speed v sticks to one end of a dumbbell (two masses m joined
 * by a massless rod of length ℓ). Find the post-collision spin ω of the
 * three-mass system, and the velocity of the double-mass end after half a
 * revolution about the centre of mass.
 *
 * Ideal point-mass analytics (centres coincide on stick):
 *   V_cm = v/3
 *   I_cm = (2/3) m ℓ²
 *   ω   = v / (2ℓ)   (into the page / clockwise for a hit from the left on the top mass)
 * After Δθ = π, the double-mass end has lab speed v/2 in the original +x direction.
 *
 * Finite disk radius makes the weld slightly off-axis, keep r ≪ ℓ.
 */

import { SCENE_FORMAT, SCENE_VERSION } from '../src/scene/schema.js';

/** @typedef {import('../src/scene/schema.js').SceneDocument} SceneDocument */

/**
 * @param {object} [opts]
 * @param {number} [opts.m=1]       Mass of each point mass (kg)
 * @param {number} [opts.v=2]       Incoming speed (m/s)
 * @param {number} [opts.l=1]       Rod length, centre-to-centre (m)
 * @param {number} [opts.radius]    Disk radius (m), default min(0.06, ℓ/12)
 * @returns {SceneDocument}
 */
export function buildInelasticDumbbellScene(opts = {}) {
  const m = opts.m ?? 1;
  const v = opts.v ?? 2;
  const l = opts.l ?? 1;
  if (!(m > 0) || !(v > 0) || !(l > 0)) {
    throw new Error('Need m > 0, v > 0, and ℓ > 0 for the inelastic-dumbbell demo.');
  }

  const radius = opts.radius ?? Math.min(0.06, l / 12);
  if (!(2 * radius < l)) {
    throw new Error('Need 2r < ℓ so the dumbbell masses do not overlap.');
  }

  // Top view: gravity off. Dumbbell along ±y, incoming mass on +x toward the top end.
  const topY = -l / 2;
  const botY = l / 2;
  // Clearance so the run starts before contact (Matter will stick on first touch).
  const gap = 0.02;
  const projectileX = -(2 * radius + gap);

  const frictionless = {
    restitution: 0,
    muK: 0,
    muS: 0,
    frictionAir: 0,
  };

  const omega = v / (2 * l);
  const vCm = v / 3;
  const vHeavyHalfTurn = v / 2;

  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: {
      name: 'Inelastic stick — mass into dumbbell',
      source: 'demo',
      demoId: 'inelastic-dumbbell',
      description:
        `Frictionless table (top view). Point mass m = ${m} kg at speed v = ${v} m/s `
        + `collides and sticks to one end of a stationary dumbbell (two masses m, `
        + `massless rod ℓ = ${l} m). `
        + `Ideal analytics: V_cm = v/3 ≈ ${vCm.toFixed(3)} m/s, `
        + `ω = v/(2ℓ) ≈ ${omega.toFixed(3)} rad/s (into the page), `
        + `double-mass end after half a revolution: v/2 ≈ ${vHeavyHalfTurn.toFixed(3)} m/s.`,
    },
    metricOrigin: { x: 0, y: 0 },
    environment: {
      gravity: { enabled: false, g: 9.81 },
      air: { enabled: false, cd: 0.47, area: 0.045, rho: 1.225 },
    },
    camera: { s: 1.1 },
    bodies: [
      {
        id: 'projectile',
        type: 'point-mass',
        position: { x: projectileX, y: topY },
        angle: 0,
        mass: m,
        velocity: { vx: v, vy: 0 },
        geometry: { radius, hollow: false },
        material: {
          ...frictionless,
          stickOnContact: true,
        },
      },
      {
        id: 'dumbbell_top',
        type: 'point-mass',
        position: { x: 0, y: topY },
        angle: 0,
        mass: m,
        velocity: { vx: 0, vy: 0 },
        geometry: { radius, hollow: false },
        material: {
          ...frictionless,
          stickOnContact: true,
        },
      },
      {
        id: 'dumbbell_bottom',
        type: 'point-mass',
        position: { x: 0, y: botY },
        angle: 0,
        mass: m,
        velocity: { vx: 0, vy: 0 },
        geometry: { radius, hollow: false },
        material: { ...frictionless },
      },
    ],
    constraints: [
      {
        id: 'rod_1',
        type: 'rod',
        bodyA: 'dumbbell_top',
        bodyB: 'dumbbell_bottom',
        anchorA: { x: 0, y: 0 },
        anchorB: { x: 0, y: 0 },
        length: l,
      },
    ],
    uiAggregates: [
      {
        id: 'agg_dumbbell',
        name: 'Dumbbell',
        members: ['dumbbell_top', 'dumbbell_bottom'],
      },
    ],
  };
}

/** Ideal post-collision spin (rad/s) for point masses: ω = v / (2ℓ). */
export function inelasticDumbbellOmega(v = 2, l = 1) {
  return v / (2 * l);
}

/** Ideal COM speed after the stick: V_cm = v/3. */
export function inelasticDumbbellVcm(v = 2) {
  return v / 3;
}

/** Ideal lab speed of the double-mass end after half a revolution: v/2. */
export function inelasticDumbbellHeavyEndAfterHalfTurn(v = 2) {
  return v / 2;
}
