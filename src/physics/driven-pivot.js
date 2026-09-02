/**
 * Driven pivots: pivots (internal type `anchor`) that apply τ(t) about the
 * hinge to linked bodies.
 *
 * Visual: checkered hinge disk rotates with the drive function
 * (dθ/dt ∝ τ(t)), not the hanging shaft angle.
 */

import Matter from 'matter-js';
import { PX_PER_M, BASE_DELTA_MS } from '../units.js';
import { newtonsToMatterForce } from './applied-force.js';
import { appliedTorqueToMatter } from './applied-torque.js';
import { constraintAnchorWorld } from './constraints.js';
import { compileExpr } from './expr.js';

const { Body } = Matter;

/** Default drive: gentle sinusoidal torque (N·m). */
export const DEFAULT_DRIVEN_TORQUE_EXPR = '0.5sin(2pi t)';

/**
 * Visual spin: 1 N·m → this many rad/s on the checkered disk.
 * Chosen so typical drives (0.1–1 N·m) read clearly on screen.
 */
export const DRIVEN_VISUAL_RAD_PER_NM_S = 1;

/**
 * @param {import('matter-js').Body|null|undefined} body
 */
export function isDrivenPivot(body) {
  return !!body && body._newtonType === 'anchor' && body._driven === true;
}

/**
 * @param {import('matter-js').Body} body
 * @param {boolean} driven
 */
export function setDriven(body, driven) {
  if (body._newtonType !== 'anchor') return;
  body._driven = !!driven;
  if (!body._driven) {
    body._drivenVisualAngle = 0;
    return;
  }
  if (!body._drivenTorqueExpr) {
    setDrivenTorqueExpr(body, DEFAULT_DRIVEN_TORQUE_EXPR);
  } else {
    setDrivenTorqueExpr(body, body._drivenTorqueExpr);
  }
  if (!isFinite(body._drivenVisualAngle)) body._drivenVisualAngle = 0;
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {string}
 */
export function getDrivenTorqueExpr(body) {
  if (!body || body._newtonType !== 'anchor') return '';
  return typeof body._drivenTorqueExpr === 'string' ? body._drivenTorqueExpr : '';
}

/**
 * Compile and store τ(t) expression. Returns compile result.
 * @param {import('matter-js').Body} body
 * @param {string} expr
 * @returns {{ ok: true, source: string }|{ ok: false, error: string }}
 */
export function setDrivenTorqueExpr(body, expr) {
  if (body._newtonType !== 'anchor') return { ok: false, error: 'Not a pivot' };
  const src = String(expr ?? '').trim();
  if (!src) {
    body._drivenTorqueExpr = '';
    body._drivenTorqueFn = null;
    body._drivenTorqueError = 'Empty expression';
    return { ok: false, error: 'Empty expression' };
  }
  const compiled = compileExpr(src);
  if (!compiled.ok) {
    body._drivenTorqueExpr = src;
    body._drivenTorqueFn = null;
    body._drivenTorqueError = compiled.error;
    return compiled;
  }
  body._drivenTorqueExpr = compiled.source;
  body._drivenTorqueFn = compiled.eval;
  body._drivenTorqueError = null;
  return { ok: true, source: compiled.source };
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {string|null}
 */
export function getDrivenTorqueError(body) {
  return body?._drivenTorqueError ?? null;
}

/**
 * Evaluate τ(t) in display N·m, or null if inactive / invalid.
 * @param {import('matter-js').Body} body
 * @param {number} t  sim time (s)
 */
export function evaluateDrivenTorque(body, t) {
  if (!isDrivenPivot(body)) return null;
  const fn = body._drivenTorqueFn;
  if (typeof fn !== 'function') return null;
  const v = fn({ t });
  return isFinite(v) ? v : null;
}

/**
 * Advance the checkered-disk angle from the drive function: dθ/dt ∝ τ(t).
 * SVG rotate is CW-positive (+y down); display +τ is CCW, so we subtract.
 * @param {import('matter-js').Body} body
 * @param {number} t
 * @param {number} dt  seconds
 */
export function updateDrivenVisualAngleFromDrive(body, t, dt) {
  if (!isDrivenPivot(body) || !(dt > 0)) return;
  const tau = evaluateDrivenTorque(body, t);
  if (tau == null) return;
  const prev = Number.isFinite(body._drivenVisualAngle) ? body._drivenVisualAngle : 0;
  body._drivenVisualAngle = prev - DRIVEN_VISUAL_RAD_PER_NM_S * tau * dt;
}

/**
 * Tangential force (SI) that realizes τ about the pivot on the linked body.
 * Same conversion used by {@link applyDrivenTorqueOnConstraint}.
 *
 * @param {import('matter-js').Body} pivot
 * @param {object} c
 * @param {number} tauDisplay  N·m, + CCW / out of screen
 * @returns {{
 *   body: import('matter-js').Body,
 *   F: number,
 *   thetaDeg: number,
 *   FxN: number,
 *   FyN: number,
 *   at: { x: number, y: number },
 * }|null}
 */
export function drivenTangentialForceSI(pivot, c, tauDisplay) {
  if (!isFinite(tauDisplay) || tauDisplay === 0) return null;
  const which = c.bodyA === pivot ? 'A' : c.bodyB === pivot ? 'B' : null;
  if (!which) return null;
  const otherWhich = which === 'A' ? 'B' : 'A';
  const other = otherWhich === 'A' ? c.bodyA : c.bodyB;
  if (!other || other.isStatic) return null;

  const pivotW = constraintAnchorWorld(c, which);
  const otherW = constraintAnchorWorld(c, otherWhich);
  const rx = otherW.x - pivotW.x;
  const ry = otherW.y - pivotW.y;
  const r2px = rx * rx + ry * ry;
  // Pure body-torque path (no lever arm): no linear F_app to draw.
  if (r2px < 1e-4) return null;

  const rxM = rx / PX_PER_M;
  const ryM = ry / PX_PER_M;
  const r2m = rxM * rxM + ryM * ryM;
  if (!(r2m > 0)) return null;

  // Matter-frame newtons (+y down)
  const FxN = tauDisplay * ryM / r2m;
  const FyN = -tauDisplay * rxM / r2m;
  // Display-frame (+y up) for arrow angle
  const Fdx = FxN;
  const Fdy = -FyN;
  const F = Math.hypot(Fdx, Fdy);
  if (!(F > 1e-12)) return null;
  const thetaDeg = Math.atan2(Fdy, Fdx) * 180 / Math.PI;
  return { body: other, F, thetaDeg, FxN, FyN, at: otherW };
}

/**
 * Apply τ(t) about the pivot onto one constraint partner.
 * @param {import('matter-js').Body} pivot
 * @param {object} c
 * @param {number} tauDisplay  N·m, + CCW / out of screen
 */
export function applyDrivenTorqueOnConstraint(pivot, c, tauDisplay) {
  if (!isFinite(tauDisplay) || tauDisplay === 0) return false;
  const which = c.bodyA === pivot ? 'A' : c.bodyB === pivot ? 'B' : null;
  if (!which) return false;
  const otherWhich = which === 'A' ? 'B' : 'A';
  const other = otherWhich === 'A' ? c.bodyA : c.bodyB;
  if (!other || other.isStatic) return false;

  const pivotW = constraintAnchorWorld(c, which);
  const otherW = constraintAnchorWorld(c, otherWhich);
  const rx = otherW.x - pivotW.x;
  const ry = otherW.y - pivotW.y;
  const r2px = rx * rx + ry * ry;

  if (r2px < 1e-4) {
    if (other.inertia === Infinity) return false;
    const tMat = appliedTorqueToMatter(tauDisplay);
    if (Math.abs(tMat) < 1e-18) return false;
    other.torque += tMat;
    return true;
  }

  const force = drivenTangentialForceSI(pivot, c, tauDisplay);
  if (!force) return false;
  const fx = newtonsToMatterForce(force.FxN);
  const fy = newtonsToMatterForce(force.FyN);
  if (Math.abs(fx) < 1e-18 && Math.abs(fy) < 1e-18) return false;
  Body.applyForce(other, force.at, { x: fx, y: fy });
  return true;
}

/**
 * Net linear drive force on each linked body from all driven pivots (for arrows).
 * Forces from multiple links/pivots on the same body are summed.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @returns {Map<number, { body: import('matter-js').Body, F: number, thetaDeg: number, FxN: number, FyN: number }>}
 */
export function collectDrivenAppForces(engine) {
  /** @type {Map<number, { body: import('matter-js').Body, FxN: number, FyN: number }>} */
  const acc = new Map();
  const t = engine.simTime;
  const useLast = engine._integrating === false;
  for (const pivot of engine.bodies) {
    if (!isDrivenPivot(pivot)) continue;
    let tau = null;
    if (useLast && Number.isFinite(pivot._drivenTorqueLast)) {
      tau = pivot._drivenTorqueLast;
    } else {
      tau = evaluateDrivenTorque(pivot, t);
    }
    if (tau == null || tau === 0) continue;
    for (const c of engine.constraints) {
      const force = drivenTangentialForceSI(pivot, c, tau);
      if (!force) continue;
      const prev = acc.get(force.body.id);
      if (prev) {
        prev.FxN += force.FxN;
        prev.FyN += force.FyN;
      } else {
        acc.set(force.body.id, {
          body: force.body,
          FxN: force.FxN,
          FyN: force.FyN,
        });
      }
    }
  }

  /** @type {Map<number, { body: import('matter-js').Body, F: number, thetaDeg: number, FxN: number, FyN: number }>} */
  const out = new Map();
  for (const [id, v] of acc) {
    const Fdx = v.FxN;
    const Fdy = -v.FyN;
    const F = Math.hypot(Fdx, Fdy);
    if (!(F > 1e-12)) continue;
    out.set(id, {
      body: v.body,
      F,
      thetaDeg: Math.atan2(Fdy, Fdx) * 180 / Math.PI,
      FxN: v.FxN,
      FyN: v.FyN,
    });
  }
  return out;
}

/**
 * Apply all driven-pivot torques for one physics step.
 * @param {import('./engine.js').PhysicsEngine} engine
 */
export function solveDrivenPivots(engine) {
  const t = engine.simTime;
  const dt = BASE_DELTA_MS / 1000;
  const constraints = engine.constraints;
  let any = false;
  for (const b of engine.bodies) {
    if (!isDrivenPivot(b)) {
      b._drivenTorqueLast = null;
      continue;
    }
    updateDrivenVisualAngleFromDrive(b, t, dt);
    const tau = evaluateDrivenTorque(b, t);
    b._drivenTorqueLast = tau;
    if (tau == null || tau === 0) continue;
    for (const c of constraints) {
      if (applyDrivenTorqueOnConstraint(b, c, tau)) any = true;
    }
  }
  return any;
}

/**
 * True if any driven pivot is active (energy is intentionally non-conservative).
 * @param {import('./engine.js').PhysicsEngine} engine
 */
export function hasDrivenPivot(engine) {
  for (const b of engine.bodies) {
    if (!isDrivenPivot(b)) continue;
    if (typeof b._drivenTorqueFn === 'function') return true;
    if (getDrivenTorqueExpr(b)) return true;
  }
  return false;
}

/** Reset visual spin on all driven pivots (e.g. after sim reset). */
export function resetDrivenVisualAngles(engine) {
  for (const b of engine.bodies) {
    if (b?._newtonType === 'anchor') b._drivenVisualAngle = 0;
  }
}
