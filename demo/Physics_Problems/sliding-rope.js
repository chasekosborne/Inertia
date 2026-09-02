/**
 * Demo: flexible rope sliding off a frictionless tabletop.
 *
 * Problem: rope of length ℓ released from rest with hanging length ℓ₀ < ℓ/2.
 * Find the time when the hanging length reaches 2ℓ₀.
 *
 * Analytical: x = ℓ₀ cosh(t √(g/ℓ)) ⇒ t = √(ℓ/g) arcosh(2).
 *
 * Rope is a chain of lock-rotated point masses with inextensible PBD links,
 * drawn as one rounded stroke.
 */

import { SCENE_FORMAT, SCENE_VERSION } from '../src/scene/schema.js';
import {
  buildFreeRopeSceneParts, ROPE_THICKNESS_M, ROPE_MAX_SEGMENTS, clampRopeSegments,
} from '../src/physics/rope.js';

/** @typedef {import('../src/scene/schema.js').SceneDocument} SceneDocument */

/**
 * @param {object} [opts]
 * @param {number} [opts.l=2]       Total rope length (m)
 * @param {number} [opts.l0=0.4]    Initial hanging length (m), must be < l/2
 * @param {number} [opts.g=9.81]
 * @param {number} [opts.segments]  Override segment count (default max resolution)
 * @returns {SceneDocument}
 */
export function buildSlidingRopeScene(opts = {}) {
  const l = opts.l ?? 2;
  const l0 = opts.l0 ?? 0.4;
  const g = opts.g ?? 9.81;
  if (!(l0 > 0) || !(l > 2 * l0)) {
    throw new Error('Need 0 < l0 < l/2 for the sliding-rope demo.');
  }

  const nSeg = clampRopeSegments(Math.max(12, opts.segments ?? ROPE_MAX_SEGMENTS));
  const thickness = ROPE_THICKNESS_M;
  const r = thickness / 2;
  const edgeX = 0;
  const tableW = Math.max(l - l0 + 0.8, 2.4);
  const tableCx = edgeX - tableW / 2;
  const tableTop = 0;
  const yOnTable = tableTop - r;
  // Sit just clear of the vertical end-face (centreline offset by radius).
  const hangX = edgeX + r;

  const nHang = Math.max(6, Math.round(nSeg * (l0 / l)));
  const nTable = Math.max(10, nSeg - nHang);
  /** @type {{ x: number, y: number }[]} */
  const points = [];
  const onTable = l - l0;
  for (let i = 0; i <= nTable; i++) {
    const t = i / nTable;
    points.push({
      x: edgeX - onTable * (1 - t),
      y: yOnTable,
    });
  }
  for (let j = 1; j <= nHang; j++) {
    const t = j / nHang;
    points.push({
      x: hangX,
      y: yOnTable + l0 * t,
    });
  }

  const { bodies: ropeBodies, constraints } = buildFreeRopeSceneParts(points, {
    segments: points.length - 1,
    exactNodes: true,
    totalMass: 1,
    thicknessM: thickness,
    muK: 0,
    muS: 0,
    idPrefix: 'rope',
    ropeId: 'rope',
    ropeName: 'Rope',
  });

  const tStar = Math.sqrt(l / g) * Math.acosh(2);
  const hangId = `rope_${points.length - 1}`;

  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: {
      name: 'Rope sliding off a frictionless table',
      source: 'demo',
      demoId: 'sliding-rope',
      description:
        `Flexible rope of length ℓ = ${l} m released from rest with hanging length `
        + `ℓ₀ = ${l0} m (ℓ₀ < ℓ/2). Frictionless table. Find the time when the hanging `
        + `length reaches 2ℓ₀ = ${2 * l0} m. `
        + `Analytic: t = √(ℓ/g)·arcosh(2) ≈ ${tStar.toFixed(3)} s.`,
    },
    metricOrigin: { x: 0, y: 0 },
    environment: {
      gravity: { enabled: true, g },
      air: { enabled: false, cd: 0.47, area: 0.045, rho: 1.225 },
    },
    camera: { s: 0.85 },
    bodies: [
      {
        id: 'table_1',
        type: 'ground',
        position: { x: tableCx, y: 0.1 },
        angle: 0,
        geometry: { width: tableW, height: 0.2 },
        material: { restitution: 0, muK: 0, muS: 0, frictionAir: 0 },
      },
      ...ropeBodies,
    ],
    constraints,
    measurements: [
      {
        id: 'l0',
        kind: 'length',
        label: 'ℓ₀',
        component: 'dy',
        a: { kind: 'vertex', body: 'table_1', vertex: 'groundB' },
        b: { kind: 'body', body: hangId },
      },
      {
        id: 'ell',
        kind: 'length',
        label: 'ℓ',
        component: 'manhattan',
        elbow: 'xy',
        a: { kind: 'body', body: 'rope_0' },
        b: { kind: 'body', body: hangId },
      },
    ],
  };
}

/** Analytic time for hanging length ℓ₀ → 2ℓ₀. */
export function slidingRopeAnalyticTime(l = 2, g = 9.81) {
  return Math.sqrt(l / g) * Math.acosh(2);
}
