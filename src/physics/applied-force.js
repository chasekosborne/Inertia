/**
 * Applied force on dynamic bodies (display-frame SI).
 *
 * Constant: F (N) at angle θ° above +x (right). Matter’s +y is down, so the
 * upward component is −sin θ in Matter force units.
 *
 * Driven: F(t) expression (signed Newtons) along the same θ; negative reverses
 * direction. Shown on the free-body diagram as F_app.
 */

import Matter from 'matter-js';
import { PX_PER_M } from '../units.js';
import { compileExpr } from './expr.js';

const { Body } = Matter;

/** Body types that support applied / driven F. */
export const APPLIED_FORCE_BODY_TYPES = new Set([
  'point-mass', 'ball', 'box', 'wedge',
]);

/** Default drive: gentle sinusoidal force (N). */
export const DEFAULT_DRIVEN_APPLIED_FORCE_EXPR = '5*sin(2*pi*t)';

/** 1 N = 1 kg·m/s² → Matter kg·px/ms² (same as air-drag / springs). */
export function newtonsToMatterForce(FN) {
  return FN * PX_PER_M / 1e6;
}

/**
 * @param {number} F          Newtons (positive along θ; signed OK)
 * @param {number} thetaDeg   Degrees above +x (display / textbook)
 * @returns {{ fx: number, fy: number }} Matter force components
 */
export function appliedForceToMatter(F, thetaDeg) {
  if (!isFinite(F) || F === 0 || !isFinite(thetaDeg)) return { fx: 0, fy: 0 };
  const rad = thetaDeg * Math.PI / 180;
  const Fm = newtonsToMatterForce(F);
  return {
    fx: Fm * Math.cos(rad),
    fy: -Fm * Math.sin(rad),
  };
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 */
export function supportsAppliedForce(body) {
  return !!body && APPLIED_FORCE_BODY_TYPES.has(body._newtonType);
}

/**
 * Constant applied force (F > 0), or null.
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {{ F: number, thetaDeg: number }|null}
 */
export function getAppliedForce(body) {
  const af = body?._appliedForce;
  if (!af || typeof af !== 'object') return null;
  const F = Number(af.F);
  const thetaDeg = Number(af.thetaDeg);
  if (!(F > 0) || !isFinite(F) || !isFinite(thetaDeg)) return null;
  return { F, thetaDeg };
}

/**
 * Direction θ° above +x (kept even when |F| = 0 for driven F(t)).
 * @param {import('matter-js').Body|null|undefined} body
 */
export function getAppliedForceDirection(body) {
  const th = Number(body?._appliedForce?.thetaDeg);
  return isFinite(th) ? th : 0;
}

/**
 * Store / update direction without requiring a positive magnitude.
 * @param {import('matter-js').Body} body
 * @param {number} thetaDeg
 */
export function setAppliedForceDirection(body, thetaDeg) {
  const th = Number(thetaDeg);
  if (!isFinite(th)) return;
  const prevF = Number(body._appliedForce?.F);
  body._appliedForce = { F: prevF > 0 ? prevF : 0, thetaDeg: th };
}

/**
 * @param {import('matter-js').Body} body
 * @param {number} F
 * @param {number} thetaDeg
 */
export function setAppliedForce(body, F, thetaDeg) {
  const f = Number(F);
  const th = Number(thetaDeg);
  if (!isFinite(th)) {
    if (!(f > 0) || !isFinite(f)) {
      body._appliedForce = null;
      return;
    }
  }
  if (!(f > 0) || !isFinite(f)) {
    // Keep θ for driven F(t); otherwise clear.
    if (body._drivenApplied) {
      body._appliedForce = { F: 0, thetaDeg: isFinite(th) ? th : getAppliedForceDirection(body) };
      return;
    }
    body._appliedForce = null;
    return;
  }
  body._appliedForce = { F: f, thetaDeg: isFinite(th) ? th : 0 };
}

/** Clear constant applied force (and direction unless driven). */
export function clearAppliedForce(body) {
  if (body._drivenApplied) {
    body._appliedForce = { F: 0, thetaDeg: getAppliedForceDirection(body) };
    return;
  }
  body._appliedForce = null;
}

/**
 * Matter-frame components of the body’s applied force (constant or last driven
 * F(t) sample), or zeros.
 * @param {import('matter-js').Body} body
 */
export function appliedForceMatterComponents(body) {
  if (isDrivenAppliedForce(body)) {
    const F = body._drivenAppliedLastF;
    if (F == null || F === 0) return { fx: 0, fy: 0 };
    return appliedForceToMatter(F, getAppliedForceDirection(body));
  }
  const af = getAppliedForce(body);
  if (!af) return { fx: 0, fy: 0 };
  return appliedForceToMatter(af.F, af.thetaDeg);
}

// ── Driven F(t) ───────────────────────────────────────────────────

/**
 * @param {import('matter-js').Body|null|undefined} body
 */
export function isDrivenAppliedForce(body) {
  return supportsAppliedForce(body) && body._drivenApplied === true && !body.isStatic;
}

/**
 * @param {import('matter-js').Body} body
 * @param {boolean} driven
 */
export function setDrivenAppliedForce(body, driven) {
  if (!supportsAppliedForce(body)) return;
  body._drivenApplied = !!driven;
  if (!body._drivenApplied) {
    body._drivenAppliedFn = null;
    body._drivenAppliedError = null;
    // Drop zero-magnitude placeholder if no constant F remains.
    const af = body._appliedForce;
    if (af && !(Number(af.F) > 0)) body._appliedForce = null;
    return;
  }
  if (!body._appliedForce || typeof body._appliedForce !== 'object') {
    body._appliedForce = { F: 0, thetaDeg: 0 };
  }
  if (!body._drivenAppliedExpr) {
    setDrivenAppliedForceExpr(body, DEFAULT_DRIVEN_APPLIED_FORCE_EXPR);
  } else {
    setDrivenAppliedForceExpr(body, body._drivenAppliedExpr);
  }
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {string}
 */
export function getDrivenAppliedForceExpr(body) {
  if (!supportsAppliedForce(body)) return '';
  return typeof body._drivenAppliedExpr === 'string' ? body._drivenAppliedExpr : '';
}

/**
 * Compile and store F(t) expression. Returns compile result.
 * @param {import('matter-js').Body} body
 * @param {string} expr
 * @returns {{ ok: true, source: string }|{ ok: false, error: string }}
 */
export function setDrivenAppliedForceExpr(body, expr) {
  if (!supportsAppliedForce(body)) return { ok: false, error: 'Not a forceable body' };
  const src = String(expr ?? '').trim();
  if (!src) {
    body._drivenAppliedExpr = '';
    body._drivenAppliedFn = null;
    body._drivenAppliedError = 'Empty expression';
    return { ok: false, error: 'Empty expression' };
  }
  const compiled = compileExpr(src);
  if (!compiled.ok) {
    body._drivenAppliedExpr = src;
    body._drivenAppliedFn = null;
    body._drivenAppliedError = compiled.error;
    return compiled;
  }
  body._drivenAppliedExpr = compiled.source;
  body._drivenAppliedFn = compiled.eval;
  body._drivenAppliedError = null;
  return { ok: true, source: compiled.source };
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {string|null}
 */
export function getDrivenAppliedForceError(body) {
  return body?._drivenAppliedError ?? null;
}

/**
 * Evaluate F(t) in display Newtons, or null if inactive / invalid.
 * @param {import('matter-js').Body} body
 * @param {number} t  sim time (s)
 */
export function evaluateDrivenAppliedForce(body, t) {
  if (!isDrivenAppliedForce(body)) return null;
  const fn = body._drivenAppliedFn;
  if (typeof fn !== 'function') return null;
  const v = fn({ t });
  return isFinite(v) ? v : null;
}

/**
 * Apply F(t) for one physics step on all driven applied-force bodies.
 * @param {import('./engine.js').PhysicsEngine} engine
 * @returns {boolean}
 */
export function solveDrivenAppliedForces(engine) {
  const t = engine.simTime;
  let any = false;
  for (const b of engine.bodies ?? []) {
    if (!isDrivenAppliedForce(b)) {
      if (b) b._drivenAppliedLastF = null;
      continue;
    }
    const F = evaluateDrivenAppliedForce(b, t);
    b._drivenAppliedLastF = F;
    if (F == null || F === 0) continue;
    const thetaDeg = getAppliedForceDirection(b);
    const { fx, fy } = appliedForceToMatter(F, thetaDeg);
    if (Math.abs(fx) < 1e-18 && Math.abs(fy) < 1e-18) continue;
    Body.applyForce(b, b.position, { x: fx, y: fy });
    any = true;
  }
  return any;
}

/**
 * Collect driven F_app for diagram arrows (keyed by body id).
 * Negative F flips the arrow 180° so length stays positive.
 * @param {import('./engine.js').PhysicsEngine} engine
 * @returns {Map<number, { body: import('matter-js').Body, F: number, thetaDeg: number, signedF: number }>}
 */
export function collectDrivenAppliedAppForces(engine) {
  /** @type {Map<number, { body: import('matter-js').Body, F: number, thetaDeg: number, signedF: number }>} */
  const out = new Map();
  const t = engine.simTime;
  const useLast = engine._integrating === false;
  for (const b of engine.bodies ?? []) {
    if (!isDrivenAppliedForce(b)) continue;
    let signedF = null;
    if (useLast && Number.isFinite(b._drivenAppliedLastF)) {
      signedF = b._drivenAppliedLastF;
    } else {
      signedF = evaluateDrivenAppliedForce(b, t);
    }
    if (signedF == null || Math.abs(signedF) < 1e-12) continue;
    const baseTheta = getAppliedForceDirection(b);
    const F = Math.abs(signedF);
    const thetaDeg = signedF < 0 ? baseTheta + 180 : baseTheta;
    out.set(b.id, { body: b, F, thetaDeg, signedF });
  }
  return out;
}

/**
 * True if any driven applied force is active (energy non-conservative).
 * @param {import('./engine.js').PhysicsEngine} engine
 */
export function hasDrivenAppliedForce(engine) {
  for (const b of engine.bodies ?? []) {
    if (!isDrivenAppliedForce(b)) continue;
    if (typeof b._drivenAppliedFn === 'function') return true;
    if (getDrivenAppliedForceExpr(b)) return true;
  }
  return false;
}
