/**
 * Headless parameter sweeps on a dedicated PhysicsEngine.
 */

import Matter from 'matter-js';
import { PhysicsEngine } from '../physics/engine.js';
import { deserializeScene } from '../scene/deserialize.js';
import { cloneSceneDocument } from '../scene/serialize.js';
import { applyQuadraticAirDrag } from '../physics/air-drag.js';
import { linspace } from './params.js';
import { findBody } from './metrics.js';

const { Events } = Matter;

/**
 * @typedef {object} SweepPoint
 * @property {number} x
 * @property {number} y
 * @property {object} [meta]
 */

/**
 * Apply gravity/air from a scene environment onto an experiment engine.
 * @param {PhysicsEngine} engine
 * @param {object|null|undefined} env
 * @param {{ airEnabled: boolean, airParams: { rho: number, Cd: number, A: number } }} state
 */
function applyEnvironment(engine, env, state) {
  const gOn = env?.gravity?.enabled ?? true;
  const gMs2 = gOn ? (env?.gravity?.g ?? 9.81) : 0;
  engine.engine.gravity.x = 0;
  engine.engine.gravity.y = 1;
  engine.engine.gravity.scale = gMs2 * 0.001 / 9.81;

  state.airEnabled = env?.air?.enabled === true;
  state.airParams = {
    rho: env?.air?.rho ?? 1.225,
    Cd: env?.air?.cd ?? 0.47,
    A: env?.air?.area ?? 0.045,
  };
}

/**
 * Estimate a safe sim horizon from independent value when sweeping v₀.
 * @param {object} doc
 * @param {string} bodyId
 * @param {number} indepHint
 */
function estimateTMax(doc, bodyId, indepHint) {
  const g = doc.environment?.gravity?.enabled === false
    ? 1
    : (doc.environment?.gravity?.g ?? 9.81);
  const body = doc.bodies?.find(b => b.id === bodyId);
  const v0 = Math.abs(indepHint) > 0.01
    ? Math.abs(indepHint)
    : Math.abs(body?.velocity?.vy ?? 10);
  // Vacuum rise time v/g, with drag, rise is shorter: use 3× margin.
  return Math.max(1.5, 3 * v0 / Math.max(g, 0.5));
}

export class ExperimentRunner {
  constructor() {
    this.engine = new PhysicsEngine();
    this._air = {
      airEnabled: false,
      airParams: { rho: 1.225, Cd: 0.47, A: 0.045 },
    };

    Events.on(this.engine.engine, 'beforeUpdate', () => {
      if (!this._air.airEnabled) return;
      // Only during deliberate steps (integrating flag)
      if (!this.engine._integrating) return;
      applyQuadraticAirDrag(this.engine.bodies, this._air.airParams, this.engine);
    });
  }

  /**
   * Run one configured scene until the metric is obtained.
   * @param {object} doc
   * @param {object} metric
   * @param {number} [indepHint]  used for tMax estimate
   * @returns {number|null}
   */
  runOne(doc, metric, indepHint = 0) {
    const working = cloneSceneDocument(doc);
    const bodyId = metric.bodyId
      ?? working.bodies?.find(b => b.type === 'ball' || b.type === 'point-mass' || b.type === 'box')?.id
      ?? 'rock_1';

    const ctxBase = {
      engine: this.engine,
      doc: working,
      bodyId,
      tMax: 1,
      applyEnvironment,
      airState: this._air,
    };

    // Threshold metrics (e.g. F to slip) drive their own load/search loop.
    if (metric.kind === 'slip-force') {
      const y = metric.compute(ctxBase);
      return (typeof y === 'number' && isFinite(y)) ? y : null;
    }

    const { environment } = deserializeScene(working, this.engine);
    applyEnvironment(this.engine, environment ?? working.environment, this._air);
    this.engine.resetSimTime();
    this.engine.pause();

    // Measurement metrics may not need a particular body present for findBody :
    // still prefer one when available for tMax estimation.
    if (metric.kind !== 'measurement' && metric.kind !== 'slip-force') {
      if (!findBody(this.engine, bodyId)) return null;
    }

    const tMax = estimateTMax(working, bodyId, indepHint);
    const y = metric.compute({
      ...ctxBase,
      tMax,
    });
    return (typeof y === 'number' && isFinite(y)) ? y : null;
  }

  /**
   * @param {object} opts
   * @param {object} opts.baseline  scene document
   * @param {import('./params.js').SweepParam} opts.param
   * @param {object} opts.metric
   * @param {number} opts.min
   * @param {number} opts.max
   * @param {number} opts.count
   * @param {(done: number, total: number, point: SweepPoint|null) => void} [opts.onProgress]
   * @returns {Promise<SweepPoint[]>}
   */
  async runSweep(opts) {
    const { baseline, param, metric, min, max, count, onProgress } = opts;
    const values = linspace(min, max, count);
    const points = [];

    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      const doc = cloneSceneDocument(baseline);
      param.apply(doc, x);
      const y = this.runOne(doc, metric, x);
      const point = y == null ? null : { x, y, meta: { param: param.id, metric: metric.id } };
      if (point) points.push(point);
      onProgress?.(i + 1, values.length, point);

      // Yield so the UI can update between runs
      await new Promise(r => setTimeout(r, 0));
    }

    return points;
  }
}
