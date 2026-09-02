/**
 * Demo: zero-gravity billiards break — cue ball breaks a full 15-ball rack
 * inside a cushioned rectangular table (top view).
 *
 * Ball colours follow standard numbered pool balls (solids 1–8, stripes 9–15
 * use the same hues as their solid counterparts). The cue ball is white.
 */

import { SCENE_FORMAT, SCENE_VERSION } from '../../src/scene/schema.js';

/** @typedef {import('../../src/scene/schema.js').SceneDocument} SceneDocument */

/** Standard pool-ball colours (solids 1–8). Stripes 9–15 reuse 1–7. */
const SOLID_COLORS = {
  1: '#F9D71C',
  2: '#0B3D91',
  3: '#C41E3A',
  4: '#6A0DAD',
  5: '#FF6B00',
  6: '#0B7A3B',
  7: '#7B1113',
  8: '#1A1A1A',
};

/** @param {number} n  Ball number 1–15 */
function ballColor(n) {
  if (n === 8) return SOLID_COLORS[8];
  if (n <= 7) return SOLID_COLORS[n];
  return SOLID_COLORS[n - 8];
}

/** Triangle rack order (apex = ball 1, 8-ball centred in the third row). */
const RACK_ORDER = [
  [1],
  [2, 3],
  [4, 8, 5],
  [6, 7, 9, 10],
  [11, 12, 13, 14, 15],
];

/** Regulation 9 ft table ≈ 100″ × 50″ playing surface → ~44 ball diameters × ~22. */
const TABLE_LENGTH_PER_R = 82;
const TABLE_WIDTH_PER_R = 45;

/**
 * @param {object} [opts]
 * @param {number} [opts.ballRadius=0.1]  Ball radius (m)
 * @param {number} [opts.tableWidth]  Playing surface width (m, horizontal); default regulation ratio
 * @param {number} [opts.tableHeight]  Playing surface length (m, vertical); default regulation ratio
 * @param {number} [opts.cueSpeed=6]
 * @returns {SceneDocument}
 */
export function buildBilliardsScene(opts = {}) {
  const r = opts.ballRadius ?? 0.1;
  const tableX = opts.tableWidth ?? TABLE_WIDTH_PER_R * r;
  const tableY = opts.tableHeight ?? TABLE_LENGTH_PER_R * r;
  const cueSpeed = opts.cueSpeed ?? 6;
  const d = 2 * r + 0.0005;
  const cos30 = Math.sqrt(3) / 2;

  const cushionT = 1.5 * r;
  const cushionSpanX = tableX + cushionT;
  const cushionSpanY = tableY + cushionT;
  const viewPad = 4 * r;

  const material = {
    restitution: 0.92,
    muK: 0,
    muS: 0,
    frictionAir: 0,
  };

  const cushion = {
    restitution: 0.85,
    muK: 0,
    muS: 0,
    frictionAir: 0,
  };

  /** @type {import('../../src/scene/schema.js').SceneBody[]} */
  const bodies = [
  // Table cushions (ground segments) — long axis vertical (+y).
    {
      id: 'cushion_bottom',
      type: 'ground',
      position: { x: tableX / 2, y: tableY + cushionT / 2 },
      angle: 0,
      geometry: { width: cushionSpanX, height: cushionT },
      material: cushion,
    },
    {
      id: 'cushion_top',
      type: 'ground',
      position: { x: tableX / 2, y: -cushionT / 2 },
      angle: Math.PI,
      geometry: { width: cushionSpanX, height: cushionT },
      material: cushion,
    },
    {
      id: 'cushion_left',
      type: 'ground',
      position: { x: -cushionT / 2, y: tableY / 2 },
      angle: Math.PI / 2,
      geometry: { width: cushionSpanY, height: cushionT },
      material: cushion,
    },
    {
      id: 'cushion_right',
      type: 'ground',
      position: { x: tableX + cushionT / 2, y: tableY / 2 },
      angle: -Math.PI / 2,
      geometry: { width: cushionSpanY, height: cushionT },
      material: cushion,
    },
  ];

  // Cue ball at the foot (bottom); rack at the head (top). Break shoots upward.
  const rackApexX = tableX / 2;
  const rackApexY = tableY * 0.25;
  const cueX = tableX / 2;
  const cueY = tableY * 0.75;

  bodies.push({
    id: 'cue',
    type: 'ball',
    position: { x: cueX, y: cueY },
    angle: 0,
    mass: 0.17,
    velocity: { vx: 0, vy: -cueSpeed },
    geometry: { radius: r, fill: '#F5F5F0', stroke: '#333333' },
    material,
  });

  // 15-ball triangle rack.
  for (let row = 0; row < RACK_ORDER.length; row++) {
    const nums = RACK_ORDER[row];
    for (let col = 0; col < nums.length; col++) {
      const n = nums[col];
      const x = rackApexX + (col - (nums.length - 1) / 2) * d;
      const y = rackApexY - row * d * cos30;
      bodies.push({
        id: `ball_${n}`,
        type: 'ball',
        position: { x, y },
        angle: 0,
        mass: 0.17,
        velocity: { vx: 0, vy: 0 },
        geometry: {
          radius: r,
          fill: ballColor(n),
          ...(n === 8 ? { stroke: '#444444' } : {}),
        },
        material,
      });
    }
  }

  /** @type {object[]} */
  const labels = [];
  for (let n = 1; n <= 15; n++) {
    labels.push({
      id: `label_${n}`,
      text: String(n),
      body: `ball_${n}`,
      fontSize: 8,
    });
  }

  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: {
      name: 'Billiards break',
      source: 'demo',
      demoId: 'billiards',
      description:
        'Top-view billiards table with zero gravity. A white cue ball breaks a full '
        + '15-ball rack inside four cushioned walls. Balls are coloured like standard '
        + 'numbered pool balls.',
    },
    metricOrigin: { x: 0, y: 0 },
    environment: {
      gravity: { enabled: false, g: 9.81 },
      air: { enabled: false, cd: 0.47, area: 0.045, rho: 1.225 },
    },
    camera: {
      center: { x: tableX / 2, y: tableY / 2 },
      view: { width: tableX + viewPad + cushionT, height: tableY + viewPad + cushionT },
    },
    bodies,
    constraints: [],
    labels,
  };
}
