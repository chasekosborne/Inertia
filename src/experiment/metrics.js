/**
 * Dependent metrics extracted from a headless run.
 */

import Matter from 'matter-js';
import { PX_PER_M, matterVelToDisplayMS } from '../units.js';
import { deserializeScene } from '../scene/deserialize.js';
import { cloneSceneDocument } from '../scene/serialize.js';
import { setAppliedForce } from '../physics/applied-force.js';
import { MATH_PLAIN } from '../math-text.js';
import {
  evaluateMeasurementOnEngine,
  measurementDisplayLabel,
  measurementRefsBody,
  unwrapAngleStep,
} from '../ui/measure-eval.js';

const { Body } = Matter;

/**
 * @typedef {object} MetricDef
 * @property {string} id
 * @property {string} label
 * @property {string} unit
 * @property {string} [bodyId]  default body for rock demos
 * @property {'sim'|'slip-force'|'extrema'|'resonance'|'measurement'} [kind]
 * @property {boolean} [preferred]
 * @property {number} [tMax]  Override sim horizon (s) for this metric
 * @property {number} [discardFrac]  Resonance: fraction of tMax to discard as transient
 * @property {string} [group]  optgroup label
 * @property {(ctx: MetricContext) => number|null} compute
 */

/**
 * @typedef {object} MetricContext
 * @property {import('../physics/engine.js').PhysicsEngine} engine
 * @property {object} doc
 * @property {string} bodyId
 * @property {number} tMax
 * @property {(engine: import('../physics/engine.js').PhysicsEngine, env: object|null|undefined, state: object) => void} [applyEnvironment]
 * @property {object} [airState]
 */

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {string} bodyId
 */
export function findBody(engine, bodyId) {
  return engine.bodies.find(b => b.label === bodyId) ?? null;
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {import('matter-js').Body} body
 */
export function sampleDisplayY(engine, body) {
  const origin = engine.bodies.find(b => b._newtonType === 'metric-basis');
  const oy = origin?.position.y ?? 0;
  return -(body.position.y - oy) / PX_PER_M;
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {import('matter-js').Body} body
 */
export function sampleDisplayX(engine, body) {
  const origin = engine.bodies.find(b => b._newtonType === 'metric-basis');
  const ox = origin?.position.x ?? 0;
  return (body.position.x - ox) / PX_PER_M;
}

/**
 * @param {import('matter-js').Body} body
 */
export function sampleDisplayVy(body) {
  return matterVelToDisplayMS(body.velocity.x, body.velocity.y).vyMs;
}

/**
 * @param {import('matter-js').Body} body
 */
export function sampleDisplayVx(body) {
  return matterVelToDisplayMS(body.velocity.x, body.velocity.y).vxMs;
}

/**
 * @typedef {object} ExtremaTrack
 * @property {number} max_x
 * @property {number} min_x
 * @property {number} max_y
 * @property {number} min_y
 * @property {number} max_vx
 * @property {number} min_vx
 * @property {number} max_vy
 * @property {number} min_vy
 * @property {number} max_speed
 */

/**
 * Sample display kinematics for a live body.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {import('matter-js').Body} body
 */
function sampleState(engine, body) {
  const x = sampleDisplayX(engine, body);
  const y = sampleDisplayY(engine, body);
  const vx = sampleDisplayVx(body);
  const vy = sampleDisplayVy(body);
  const speed = Math.hypot(vx, vy);
  return { x, y, vx, vy, speed };
}

/**
 * Run until tMax while tracking extrema of display kinematics.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {string} bodyId
 * @param {number} tMax
 * @returns {ExtremaTrack|null}
 */
export function runTrackExtrema(engine, bodyId, tMax) {
  const body = findBody(engine, bodyId);
  if (!body) return null;

  const tLimit = Math.max(0.05, tMax);
  let s0 = sampleState(engine, body);
  /** @type {ExtremaTrack} */
  const track = {
    max_x: s0.x,
    min_x: s0.x,
    max_y: s0.y,
    min_y: s0.y,
    max_vx: s0.vx,
    min_vx: s0.vx,
    max_vy: s0.vy,
    min_vy: s0.vy,
    max_speed: s0.speed,
  };

  const absorb = (s) => {
    if (s.x > track.max_x) track.max_x = s.x;
    if (s.x < track.min_x) track.min_x = s.x;
    if (s.y > track.max_y) track.max_y = s.y;
    if (s.y < track.min_y) track.min_y = s.y;
    if (s.vx > track.max_vx) track.max_vx = s.vx;
    if (s.vx < track.min_vx) track.min_vx = s.vx;
    if (s.vy > track.max_vy) track.max_vy = s.vy;
    if (s.vy < track.min_vy) track.min_vy = s.vy;
    if (s.speed > track.max_speed) track.max_speed = s.speed;
  };

  while (engine.simTime < tLimit) {
    engine.step();
    absorb(sampleState(engine, body));
  }

  return track;
}

/**
 * Run until tMax; return steady-state amplitude of display x
 * (half peak-to-peak after discarding an initial transient fraction).
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {string} bodyId
 * @param {number} tMax
 * @param {{ discardFrac?: number }} [opts]
 * @returns {number|null}
 */
export function runSteadyAmplitudeX(engine, bodyId, tMax, opts = {}) {
  const body = findBody(engine, bodyId);
  if (!body) return null;

  const tLimit = Math.max(0.2, tMax);
  const discardFrac = Math.min(0.95, Math.max(0, opts.discardFrac ?? 0.7));
  const tDiscard = tLimit * discardFrac;

  let maxX = -Infinity;
  let minX = Infinity;
  let n = 0;

  while (engine.simTime < tLimit) {
    engine.step();
    if (engine.simTime < tDiscard) continue;
    const x = sampleDisplayX(engine, body);
    if (x > maxX) maxX = x;
    if (x < minX) minX = x;
    n++;
  }

  if (n < 2 || !isFinite(maxX) || !isFinite(minX)) return null;
  return 0.5 * (maxX - minX);
}

/**
 * Advance until display vy crosses ≤ 0 (apex) or y falls after rising.
 * @returns {{ tYMax: number, yMax: number }|null}
 */
export function runUntilYMax(engine, bodyId, tMax) {
  const body = findBody(engine, bodyId);
  if (!body) return null;

  let yMax = sampleDisplayY(engine, body);
  let tYMax = engine.simTime;
  let rising = sampleDisplayVy(body) > 0.05;
  let sawRise = rising;

  const tLimit = Math.max(0.05, tMax);

  while (engine.simTime < tLimit) {
    engine.step();
    const y = sampleDisplayY(engine, body);
    const vy = sampleDisplayVy(body);

    if (y > yMax) {
      yMax = y;
      tYMax = engine.simTime;
    }

    if (vy > 0.05) {
      rising = true;
      sawRise = true;
    } else if (sawRise && vy <= 0) {
      return { tYMax, yMax };
    }

    // Fallback: y decreasing after a clear rise
    if (sawRise && rising && y < yMax - 1e-4 && vy < 0) {
      return { tYMax, yMax };
    }
  }

  return sawRise ? { tYMax, yMax } : null;
}

/**
 * Load a scene into the experiment engine and apply environment hooks.
 * @param {MetricContext} ctx
 * @param {object} doc
 */
function _loadDoc(ctx, doc) {
  const { environment } = deserializeScene(doc, ctx.engine);
  ctx.applyEnvironment?.(ctx.engine, environment ?? doc.environment, ctx.airState);
  ctx.engine.resetSimTime();
  ctx.engine.pause();
}

/**
 * Probe whether the body starts sliding under its current applied force.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {string} bodyId
 * @param {number} [tProbe=0.4]
 */
export function bodySlips(engine, bodyId, tProbe = 0.4) {
  const body = findBody(engine, bodyId);
  if (!body) return false;

  // Settle contact briefly with force already applied (static friction can grip).
  Body.setVelocity(body, { x: 0, y: 0 });
  Body.setAngularVelocity(body, 0);
  const settleEnd = engine.simTime + 0.08;
  while (engine.simTime < settleEnd) engine.step();

  Body.setVelocity(body, { x: 0, y: 0 });
  Body.setAngularVelocity(body, 0);
  const x1 = body.position.x;
  const tEnd = engine.simTime + tProbe;
  while (engine.simTime < tEnd) engine.step();

  const dx = Math.abs(body.position.x - x1);
  const vx = Math.abs(body.velocity.x);
  // ~2 mm of travel or a clear horizontal speed ⇒ slipped.
  return dx > 0.2 || vx > 0.015;
}

/**
 * Binary-search the smallest applied F (N) that makes the body slip at the
 * scene’s current θ (and μ, m, g).
 * @param {MetricContext} ctx
 * @returns {number|null}
 */
export function findMinSlipForce(ctx) {
  const bodyId = ctx.bodyId;
  const baseline = cloneSceneDocument(ctx.doc);
  const bd = baseline.bodies?.find(b => b.id === bodyId);
  if (!bd) return null;

  const thetaDeg = bd.appliedForce?.thetaDeg ?? 0;
  const mu = Math.max(
    bd.material?.muS ?? 0,
    bd.material?.muK ?? 0,
  );
  const mass = bd.mass ?? 1;
  const g = baseline.environment?.gravity?.enabled === false
    ? 0
    : (baseline.environment?.gravity?.g ?? 9.81);

  // Upper bound: above horizontal slip force, with margin for angled lift.
  const Fhoriz = mu * mass * g;
  let hi = Math.max(Fhoriz * 2.5, bd.appliedForce?.F ?? 0, 1);
  let lo = 0;

  const tryF = (F) => {
    const doc = cloneSceneDocument(baseline);
    const body = doc.bodies.find(b => b.id === bodyId);
    if (!body) return false;
    body.appliedForce = { F, thetaDeg };
    _loadDoc(ctx, doc);
    if (!findBody(ctx.engine, bodyId)) return false;
    return bodySlips(ctx.engine, bodyId);
  };

  // Expand hi until it slips (or give up).
  for (let i = 0; i < 8 && !tryF(hi); i++) {
    lo = hi;
    hi *= 1.8;
    if (hi > 200) return null;
  }
  if (!tryF(hi)) return null;

  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (tryF(mid)) hi = mid;
    else lo = mid;
  }

  // Leave the engine in the threshold configuration for debugging.
  const finalDoc = cloneSceneDocument(baseline);
  const finalBody = finalDoc.bodies.find(b => b.id === bodyId);
  if (finalBody) {
    finalBody.appliedForce = { F: hi, thetaDeg };
    _loadDoc(ctx, finalDoc);
    const live = findBody(ctx.engine, bodyId);
    if (live) setAppliedForce(live, hi, thetaDeg);
  }

  return hi;
}

/** @type {MetricDef[]} */
export const SWEEP_METRICS = [
  {
    id: 't_y_max',
    label: 't (y max)',
    unit: 's',
    kind: 'sim',
    bodyId: 'rock_1',
    compute(ctx) {
      const result = runUntilYMax(ctx.engine, ctx.bodyId, ctx.tMax);
      return result?.tYMax ?? null;
    },
  },
  {
    id: 'y_max',
    label: 'y max',
    unit: 'm',
    kind: 'sim',
    bodyId: 'rock_1',
    compute(ctx) {
      const result = runUntilYMax(ctx.engine, ctx.bodyId, ctx.tMax);
      return result?.yMax ?? null;
    },
  },
];

/** @type {{ key: keyof ExtremaTrack, label: string, unit: string }[]} */
const EXTREMA_KEYS = [
  { key: 'max_y', label: 'max y', unit: 'm' },
  { key: 'min_y', label: 'min y', unit: 'm' },
  { key: 'max_x', label: 'max x', unit: 'm' },
  { key: 'min_x', label: 'min x', unit: 'm' },
  { key: 'max_vy', label: `max ${MATH_PLAIN.vy}`, unit: 'm/s' },
  { key: 'min_vy', label: `min ${MATH_PLAIN.vy}`, unit: 'm/s' },
  { key: 'max_vx', label: `max ${MATH_PLAIN.vx}`, unit: 'm/s' },
  { key: 'min_vx', label: `min ${MATH_PLAIN.vx}`, unit: 'm/s' },
  { key: 'max_speed', label: 'max |v|', unit: 'm/s' },
];

/**
 * @param {string} bodyId
 * @param {{ preferMaxY?: boolean }} [opts]
 * @returns {MetricDef[]}
 */
function extremaMetricsForBody(bodyId, opts = {}) {
  const preferMaxY = opts.preferMaxY !== false;
  return EXTREMA_KEYS.map(({ key, label, unit }) => ({
    id: `${key}:${bodyId}`,
    label,
    unit,
    kind: 'extrema',
    group: 'Extrema',
    bodyId,
    preferred: preferMaxY && key === 'max_y',
    compute(ctx) {
      const track = runTrackExtrema(ctx.engine, bodyId, ctx.tMax);
      if (!track) return null;
      const v = track[key];
      return typeof v === 'number' && isFinite(v) ? v : null;
    },
  }));
}

/**
 * Metrics that make sense for a scene (optionally filtered to one body).
 * @param {object} doc
 * @param {{ bodyId?: string|null }} [opts]
 * @returns {MetricDef[]}
 */
export function metricsForScene(doc, opts = {}) {
  const filterId = opts.bodyId ?? null;
  const bodies = (doc?.bodies ?? []).filter(
    b => b && b.type !== 'ground' && b.type !== 'anchor' && b.type !== 'metric-basis',
  );
  const selected = filterId
    ? bodies.filter(b => b.id === filterId)
    : bodies;

  const out = [];

  // Scene measurements: always available for sweeps (filtered by body ref when set).
  out.push(...measurementMetricsForScene(doc, { bodyId: filterId }));

  if (!selected.length) {
    if (filterId) return out;
    return out.length ? out : SWEEP_METRICS;
  }

  const preferDrive = doc?.meta?.demoId === 'driven-harmonic-oscillator'
    || selected.some(b => b?.drivenApplied === true);
  const preferSlip = !preferDrive && (
    doc?.meta?.demoId === 'pull-at-angle'
    || selected.some(b => b?.appliedForce && b.appliedForce.F > 0)
  );

  for (const b of selected) {
    if (b.drivenApplied === true || preferDrive) {
      const discardFrac = 0.7;
      const resonanceTMax = 25;
      out.push({
        id: `amp_x:${b.id}`,
        label: 'Aₓ (steady)',
        unit: 'm',
        kind: 'resonance',
        group: 'Resonance',
        bodyId: b.id,
        preferred: preferDrive,
        tMax: resonanceTMax,
        discardFrac,
        compute(ctx) {
          return runSteadyAmplitudeX(ctx.engine, b.id, ctx.tMax, { discardFrac });
        },
      });
    }

    out.push(...extremaMetricsForBody(b.id, { preferMaxY: !preferSlip && !preferDrive }));

    out.push({
      ...SWEEP_METRICS[0],
      id: `t_y_max:${b.id}`,
      label: 't (y max)',
      group: 'Apex',
      bodyId: b.id,
      preferred: false,
      compute(ctx) {
        const result = runUntilYMax(ctx.engine, b.id, ctx.tMax);
        return result?.tYMax ?? null;
      },
    });
    out.push({
      ...SWEEP_METRICS[1],
      id: `y_max:${b.id}`,
      label: 'y max (apex)',
      group: 'Apex',
      bodyId: b.id,
      preferred: false,
      compute(ctx) {
        const result = runUntilYMax(ctx.engine, b.id, ctx.tMax);
        return result?.yMax ?? null;
      },
    });

    if (b.type === 'box' || b.type === 'ball' || b.type === 'wedge' || b.type === 'point-mass') {
      out.push({
        id: `F_slip:${b.id}`,
        label: `${MATH_PLAIN.F} to slip`,
        unit: 'N',
        kind: 'slip-force',
        group: 'Special',
        preferred: preferSlip,
        bodyId: b.id,
        compute(ctx) {
          return findMinSlipForce({ ...ctx, bodyId: b.id });
        },
      });
    }
  }
  return out;
}

/**
 * Dependent metrics from scene measurement overlays (angle ° / length m).
 * Each measurement contributes max / min over the run (clear for sweeps).
 * @param {object} doc
 * @param {{ bodyId?: string|null }} [opts]
 * @returns {MetricDef[]}
 */
export function measurementMetricsForScene(doc, opts = {}) {
  const filterId = opts.bodyId ?? null;
  const list = Array.isArray(doc?.measurements) ? doc.measurements : [];
  const out = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind !== 'angle' && raw.kind !== 'length') continue;
    if (filterId && !measurementRefsBody(raw, filterId)) continue;

    const id = typeof raw.id === 'string' ? raw.id : null;
    if (!id) continue;

    const isAngle = raw.kind === 'angle';
    const label = measurementDisplayLabel(raw);
    const unit = isAngle ? '°' : 'm';
    // Prefer a body referenced by the measurement so runOne can estimate tMax.
    const bodyId = _measurementBodyId(raw, doc) ?? filterId ?? undefined;

    for (const which of /** @type {const} */ (['max', 'min'])) {
      out.push({
        id: `meas:${which}:${id}`,
        label: `${which} ${label}`,
        unit,
        kind: 'measurement',
        group: 'Measurements',
        bodyId,
        preferred: which === 'max',
        compute(ctx) {
          const track = runTrackMeasurement(ctx.engine, raw, ctx.tMax);
          if (!track) return null;
          return which === 'max' ? track.max : track.min;
        },
      });
    }
  }
  return out;
}

/**
 * Step to tMax while tracking extrema of a measurement value.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {object} raw  scene measurement
 * @param {number} tMax
 * @returns {{ max: number, min: number }|null}
 */
export function runTrackMeasurement(engine, raw, tMax) {
  const continuous = raw.kind === 'angle' && raw.continuous === true && raw.signed !== false;
  const v0 = evaluateMeasurementOnEngine(raw, engine);
  if (v0 == null || !Number.isFinite(v0)) return null;

  /** @type {{ prev: number, accum: number }|null} */
  let angState = null;
  let v = v0;
  if (continuous) {
    const step = unwrapAngleStep(angState, v0, 360);
    angState = step.state;
    v = step.value;
  }

  let max = v;
  let min = v;
  const tLimit = Math.max(0.05, tMax ?? 1);

  while (engine.simTime < tLimit) {
    engine.step();
    let next = evaluateMeasurementOnEngine(raw, engine);
    if (next == null || !Number.isFinite(next)) continue;
    if (continuous) {
      const step = unwrapAngleStep(angState, next, 360);
      angState = step.state;
      next = step.value;
    }
    if (next > max) max = next;
    if (next < min) min = next;
  }

  return { max, min };
}

/**
 * @param {object} m
 * @param {object} doc
 * @returns {string|null}
 */
function _measurementBodyId(m, doc) {
  const anchors = m.kind === 'angle' ? [m.vertex, m.a, m.b] : [m.a, m.b];
  for (const a of anchors) {
    const id = a?.body ?? a?.bodyLabel;
    if (typeof id === 'string' && doc?.bodies?.some(b => b.id === id)) return id;
  }
  return doc?.bodies?.find(
    b => b && b.type !== 'ground' && b.type !== 'anchor' && b.type !== 'metric-basis',
  )?.id ?? null;
}
