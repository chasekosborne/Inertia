/**
 * Headless simulation helpers for tests (mirrors experiment/runner.js setup).
 */

import { PhysicsEngine } from '../../src/physics/engine.js';
import { deserializeScene } from '../../src/scene/deserialize.js';
import { setMetricOriginEngine } from '../../src/world-origin.js';
import { BASE_DELTA_MS, matterVelToDisplayMS, PX_PER_M } from '../../src/units.js';
import { mechanicalEnergy } from '../../src/physics/energy.js';
import { applyQuadraticAirDrag } from '../../src/physics/air-drag.js';
import Matter from 'matter-js';

const { Events } = Matter;

/** @param {import('../../src/physics/engine.js').PhysicsEngine} engine */
export function applyEnvironment(engine, env) {
  const gOn = env?.gravity?.enabled ?? true;
  const gMs2 = gOn ? (env?.gravity?.g ?? 9.81) : 0;
  engine.engine.gravity.x = 0;
  engine.engine.gravity.y = 1;
  engine.engine.gravity.scale = gMs2 * 0.001 / 9.81;
}

/**
 * Load a scene document into a fresh engine and return it ready to step.
 * @param {import('../../src/scene/schema.js').SceneDocument} doc
 * @returns {import('../../src/physics/engine.js').PhysicsEngine}
 */
export function loadScene(doc) {
  const engine = new PhysicsEngine();
  setMetricOriginEngine(engine);

  const airState = { airEnabled: false, airParams: { rho: 1.225, Cd: 0.47, A: 0.045 } };
  Events.on(engine.engine, 'beforeUpdate', () => {
    if (!airState.airEnabled || !engine._integrating) return;
    applyQuadraticAirDrag(engine.bodies, airState.airParams, engine);
  });

  const { environment } = deserializeScene(doc, engine, { applyCamera: false });
  const env = environment ?? doc.environment;
  applyEnvironment(engine, env);
  if (env?.air?.enabled === true) {
    airState.airEnabled = true;
    airState.airParams = {
      rho: env.air.rho ?? 1.225,
      Cd: env.air.cd ?? 0.47,
      A: env.air.area ?? 0.045,
    };
  }

  engine.resetSimTime();
  engine.pause();
  return engine;
}

/** @param {import('../../src/physics/engine.js').PhysicsEngine} engine @param {number} seconds */
export function runForSeconds(engine, seconds) {
  const dt = BASE_DELTA_MS / 1000;
  const n = Math.max(0, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) engine.step();
  return n * dt;
}

/** @param {import('../../src/physics/engine.js').PhysicsEngine} engine @param {string} label */
export function findBody(engine, label) {
  return engine.bodies.find(b => b.label === label) ?? null;
}

/** Display-frame position (m), +y up. */
export function bodyDisplayPos(engine, body) {
  const origin = engine.bodies.find(b => b._newtonType === 'metric-basis');
  const ox = origin?.position.x ?? 0;
  const oy = origin?.position.y ?? 0;
  return {
    x: (body.position.x - ox) / PX_PER_M,
    y: -(body.position.y - oy) / PX_PER_M,
  };
}

/** Display-frame velocity (m/s), +y up. */
export function bodyDisplayVel(body) {
  return matterVelToDisplayMS(body.velocity.x, body.velocity.y);
}

/** @param {import('../../src/physics/engine.js').PhysicsEngine} engine */
export function sampleEnergy(engine) {
  return mechanicalEnergy(engine);
}

/**
 * Run sim, sampling a scalar each step. Returns { t[], v[] } arrays.
 * @param {import('../../src/physics/engine.js').PhysicsEngine} engine
 * @param {number} seconds
 * @param {(engine: import('../../src/physics/engine.js').PhysicsEngine) => number} sample
 */
export function sampleWhileRunning(engine, seconds, sample) {
  const dt = BASE_DELTA_MS / 1000;
  const n = Math.max(0, Math.round(seconds / dt));
  /** @type {number[]} */
  const t = [];
  /** @type {number[]} */
  const v = [];
  for (let i = 0; i < n; i++) {
    engine.step();
    t.push(engine.simTime);
    v.push(sample(engine));
  }
  return { t, v };
}

/**
 * Estimate half-period (s) between successive local maxima of a sampled signal.
 * @param {number[]} t
 * @param {number[]} v
 */
export function estimateHalfPeriodFromPeaks(t, v) {
  /** @type {number[]} */
  const peaks = [];
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] > v[i - 1] && v[i] >= v[i + 1]) peaks.push(t[i]);
  }
  if (peaks.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}
