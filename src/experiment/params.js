/**
 * Scene-document parameter paths for experiment sweeps.
 */

import { MATH_PLAIN } from '../math-text.js';

/**
 * @typedef {object} SweepParam
 * @property {string} id
 * @property {string} label
 * @property {string} unit
 * @property {(doc: object, value: number) => void} apply
 * @property {(doc: object) => number|null} read
 * @property {number} [defaultMin]
 * @property {number} [defaultMax]
 * @property {number} [defaultCount]
 * @property {boolean} [preferred]
 * @property {string} [group]  optgroup label ('Body' | 'Environment')
 * @property {string} [bodyId]  scene body id when body-scoped
 */

/** @type {SweepParam[]} */
export const SWEEP_PARAMS = [
  {
    id: 'body.rock_1.velocity.vy',
    label: `${MATH_PLAIN.v0} (rock)`,
    unit: 'm/s',
    defaultMin: 4,
    defaultMax: 20,
    defaultCount: 9,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === 'rock_1');
      if (!b) return;
      if (!b.velocity) b.velocity = { vx: 0, vy: 0 };
      b.velocity.vy = value;
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === 'rock_1');
      const v = b?.velocity?.vy;
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  },
  {
    id: 'body.rock_1.mass',
    label: 'mass (rock)',
    unit: 'kg',
    defaultMin: 0.5,
    defaultMax: 4,
    defaultCount: 8,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === 'rock_1');
      if (!b) return;
      b.mass = value;
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === 'rock_1');
      const m = b?.mass;
      return typeof m === 'number' && isFinite(m) ? m : null;
    },
  },
  {
    id: 'env.air.cd',
    label: MATH_PLAIN.Cd,
    unit: '',
    group: 'Environment',
    defaultMin: 0.1,
    defaultMax: 1.2,
    defaultCount: 8,
    apply(doc, value) {
      if (!doc.environment) doc.environment = {};
      if (!doc.environment.air) doc.environment.air = { enabled: true, cd: 0.47, area: 0.045, rho: 1.225 };
      doc.environment.air.cd = value;
      doc.environment.air.enabled = true;
    },
    read(doc) {
      const v = doc.environment?.air?.cd;
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  },
  {
    id: 'env.air.enabled',
    label: 'air on (0/1)',
    unit: '',
    group: 'Environment',
    defaultMin: 0,
    defaultMax: 1,
    defaultCount: 2,
    apply(doc, value) {
      if (!doc.environment) doc.environment = {};
      if (!doc.environment.air) doc.environment.air = { enabled: true, cd: 0.47, area: 0.045, rho: 1.225 };
      doc.environment.air.enabled = value >= 0.5;
    },
    read(doc) {
      return doc.environment?.air?.enabled ? 1 : 0;
    },
  },
];

/**
 * Generic body velocity.vy for any labelled dynamic body.
 * @param {string} bodyId
 * @returns {SweepParam}
 */
export function bodyVyParam(bodyId) {
  return {
    id: `body.${bodyId}.velocity.vy`,
    label: MATH_PLAIN.vy,
    unit: 'm/s',
    group: 'Body',
    bodyId,
    defaultMin: 4,
    defaultMax: 20,
    defaultCount: 9,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b) return;
      if (!b.velocity) b.velocity = { vx: 0, vy: 0 };
      b.velocity.vy = value;
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      const v = b?.velocity?.vy;
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  };
}

/**
 * Generic body velocity.vx.
 * @param {string} bodyId
 * @returns {SweepParam}
 */
export function bodyVxParam(bodyId) {
  return {
    id: `body.${bodyId}.velocity.vx`,
    label: MATH_PLAIN.vx,
    unit: 'm/s',
    group: 'Body',
    bodyId,
    defaultMin: -10,
    defaultMax: 10,
    defaultCount: 9,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b) return;
      if (!b.velocity) b.velocity = { vx: 0, vy: 0 };
      b.velocity.vx = value;
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      const v = b?.velocity?.vx;
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  };
}

/**
 * Absolute speed |v₀|: scales velocity while preserving launch direction.
 * @param {string} bodyId
 * @param {object} [opts]
 * @param {boolean} [opts.preferred]
 * @returns {SweepParam}
 */
export function bodySpeedParam(bodyId, opts = {}) {
  return {
    id: `body.${bodyId}.velocity.speed`,
    label: `|${MATH_PLAIN.v0}|`,
    unit: 'm/s',
    group: 'Body',
    bodyId,
    preferred: opts.preferred === true,
    defaultMin: 1,
    defaultMax: 20,
    defaultCount: 10,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b) return;
      if (!b.velocity) b.velocity = { vx: 0, vy: 0 };
      const vx = b.velocity.vx ?? 0;
      const vy = b.velocity.vy ?? 0;
      const speed0 = Math.hypot(vx, vy);
      const speed = Math.max(0, value);
      if (speed0 < 1e-12) {
        // No prior direction: default along +x (θ = 0).
        b.velocity = { vx: speed, vy: 0 };
        return;
      }
      const s = speed / speed0;
      b.velocity = { vx: vx * s, vy: vy * s };
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b?.velocity) return null;
      const s = Math.hypot(b.velocity.vx ?? 0, b.velocity.vy ?? 0);
      return typeof s === 'number' && isFinite(s) ? s : null;
    },
  };
}

/**
 * Launch angle θ of v₀ (degrees above +x), keeping |v₀| fixed.
 * @param {string} bodyId
 * @returns {SweepParam}
 */
export function bodyVelocityThetaParam(bodyId) {
  return {
    id: `body.${bodyId}.velocity.thetaDeg`,
    label: `${MATH_PLAIN.v0} ${MATH_PLAIN.theta}`,
    unit: '°',
    group: 'Body',
    bodyId,
    defaultMin: 0,
    defaultMax: 90,
    defaultCount: 10,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b) return;
      if (!b.velocity) b.velocity = { vx: 0, vy: 0 };
      const vx = b.velocity.vx ?? 0;
      const vy = b.velocity.vy ?? 0;
      let speed = Math.hypot(vx, vy);
      if (speed < 1e-12) speed = 1;
      const rad = (value * Math.PI) / 180;
      b.velocity = {
        vx: speed * Math.cos(rad),
        vy: speed * Math.sin(rad),
      };
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b?.velocity) return null;
      const vx = b.velocity.vx ?? 0;
      const vy = b.velocity.vy ?? 0;
      if (Math.hypot(vx, vy) < 1e-12) return null;
      return (Math.atan2(vy, vx) * 180) / Math.PI;
    },
  };
}

/**
 * Applied-force angle θ (degrees above +x) for a body.
 * @param {string} bodyId
 * @param {object} [opts]
 * @param {boolean} [opts.preferred]
 * @returns {SweepParam}
 */
export function bodyForceThetaParam(bodyId, opts = {}) {
  return {
    id: `body.${bodyId}.appliedForce.thetaDeg`,
    label: MATH_PLAIN.theta,
    unit: '°',
    group: 'Body',
    bodyId,
    preferred: opts.preferred === true,
    defaultMin: 0,
    defaultMax: 80,
    defaultCount: 17,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b) return;
      const F = b.appliedForce?.F > 0 ? b.appliedForce.F : 1;
      b.appliedForce = { F, thetaDeg: value };
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      const v = b?.appliedForce?.thetaDeg;
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  };
}

/**
 * Applied-force magnitude F (N) for a body.
 * @param {string} bodyId
 * @returns {SweepParam}
 */
export function bodyForceFParam(bodyId) {
  return {
    id: `body.${bodyId}.appliedForce.F`,
    label: MATH_PLAIN.F,
    unit: 'N',
    group: 'Body',
    bodyId,
    defaultMin: 0.5,
    defaultMax: 10,
    defaultCount: 12,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (!b) return;
      const thetaDeg = b.appliedForce?.thetaDeg ?? 0;
      b.appliedForce = { F: Math.max(0, value), thetaDeg };
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      const v = b?.appliedForce?.F;
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  };
}

/**
 * @param {string} bodyId
 * @returns {SweepParam}
 */
export function bodyMassParam(bodyId) {
  return {
    id: `body.${bodyId}.mass`,
    label: 'mass',
    unit: 'kg',
    group: 'Body',
    bodyId,
    defaultMin: 0.5,
    defaultMax: 4,
    defaultCount: 8,
    apply(doc, value) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      if (b) b.mass = value;
    },
    read(doc) {
      const b = doc.bodies?.find(x => x.id === bodyId);
      const m = b?.mass;
      return typeof m === 'number' && isFinite(m) ? m : null;
    },
  };
}

/**
 * Params available for a given scene document.
 * @param {object} doc
 * @param {{ bodyId?: string|null }} [opts]
 * @returns {SweepParam[]}
 */
export function paramsForScene(doc, opts = {}) {
  const filterId = opts.bodyId ?? null;
  const list = [];
  const bodies = doc?.bodies ?? [];
  const preferForce = doc?.meta?.demoId === 'pull-at-angle'
    || bodies.some(b => b?.appliedForce && b.appliedForce.F > 0);

  for (const b of bodies) {
    if (!b?.id) continue;
    if (b.type === 'ground' || b.type === 'anchor' || b.type === 'metric-basis') continue;
    if (filterId && b.id !== filterId) continue;

    if (b.type === 'box' || b.type === 'ball' || b.type === 'wedge' || b.type === 'point-mass') {
      list.push(bodyForceThetaParam(b.id, { preferred: preferForce }));
      list.push(bodyForceFParam(b.id));
    }

    const speed = Math.hypot(b.velocity?.vx ?? 0, b.velocity?.vy ?? 0);
    const preferSpeed = !preferForce && speed > 1e-6;
    list.push(bodySpeedParam(b.id, { preferred: preferSpeed }));
    list.push(bodyVelocityThetaParam(b.id));
    list.push(bodyVyParam(b.id));
    list.push(bodyVxParam(b.id));
    if (b.type === 'ball' || b.type === 'box' || b.type === 'wedge' || b.type === 'point-mass') {
      list.push(bodyMassParam(b.id));
    }
  }

  // Environment params always available when present (even with body filter).
  if (doc?.environment?.air) {
    list.push(SWEEP_PARAMS.find(p => p.id === 'env.air.cd'));
    list.push(SWEEP_PARAMS.find(p => p.id === 'env.air.enabled'));
  }
  return list.filter(Boolean);
}

/**
 * @param {number} min
 * @param {number} max
 * @param {number} count
 * @returns {number[]}
 */
export function linspace(min, max, count) {
  const n = Math.max(2, Math.round(count));
  if (n === 2) return [min, max];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(min + (max - min) * (i / (n - 1)));
  }
  return out;
}
