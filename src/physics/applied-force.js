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
  'ball', 'point', 'box', 'wedge',
]);

/** Default drive: gentle sinusoidal force (N). */
export const DEFAULT_DRIVEN_APPLIED_FORCE_EXPR = '5sin(2pi t)';
/** Default driven frequency (Hz), used for live angular-frequency readouts. */
export const DEFAULT_DRIVEN_APPLIED_FREQUENCY_EXPR = '1';

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
    body._drivenAppliedFrequencyFn = null;
    body._drivenAppliedFrequencyError = null;
    body._drivenAppliedLastOmega = null;
    body._drivenAppliedPhaseParameter = null;
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
  if (!body._drivenAppliedFrequencyExpr) {
    setDrivenAppliedFrequencyExpr(body, DEFAULT_DRIVEN_APPLIED_FREQUENCY_EXPR);
  } else {
    setDrivenAppliedFrequencyExpr(body, body._drivenAppliedFrequencyExpr);
  }
}

/**
 * Compile named time-dependent parameters for a driven force.
 *
 * Definitions may be `{ omega: { expression: '2pi*(0.4 + 0.01t)' } }`.
 * Parameter expressions can reference other named parameters.
 *
 * @param {import('matter-js').Body} body
 * @param {object|null|undefined} definitions
 * @returns {{ ok: true }|{ ok: false, error: string }}
 */
export function setDrivenAppliedParameters(body, definitions) {
  if (!supportsAppliedForce(body)) return { ok: false, error: 'Not a forceable body' };
  const source = definitions && typeof definitions === 'object' ? definitions : {};
  const names = Object.keys(source)
    .filter(name => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
    .map(name => name.toLowerCase());
  const allowed = new Set(names);
  /** @type {Record<string, object>} */
  const normalized = {};
  /** @type {Record<string, object>} */
  const compiled = {};

  for (const rawName of Object.keys(source)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) continue;
    const raw = source[rawName];
    const definition = typeof raw === 'string' ? { expression: raw } : (raw ?? {});
    const expression = String(definition.expression ?? definition.expr ?? '').trim();
    if (!expression) return { ok: false, error: `Parameter "${rawName}" has an empty expression` };
    const result = compileExpr(expression, { variables: allowed });
    if (!result.ok) return { ok: false, error: `Parameter "${rawName}": ${result.error}` };
    normalized[name] = {
      expression: result.source,
      ...(typeof definition.label === 'string' ? { label: definition.label } : {}),
      ...(typeof definition.unit === 'string' ? { unit: definition.unit } : {}),
    };
    compiled[name] = {
      eval: result.eval,
      dependencies: names.filter(other => other !== name
        && new RegExp(`\\b${other}\\b`, 'i').test(expression)),
    };
  }

  body._drivenAppliedParameters = normalized;
  body._drivenAppliedParameterFns = compiled;
  body._drivenAppliedParameterError = null;
  if (body._drivenAppliedExpr) {
    setDrivenAppliedForceExpr(body, body._drivenAppliedExpr);
  }
  return { ok: true };
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {object}
 */
export function getDrivenAppliedParameters(body) {
  return body?._drivenAppliedParameters && typeof body._drivenAppliedParameters === 'object'
    ? body._drivenAppliedParameters
    : {};
}

/**
 * Set the named parameter whose integral supplies the force phase.
 * @param {import('matter-js').Body} body
 * @param {string|null|undefined} name
 */
export function setDrivenAppliedPhaseParameter(body, name) {
  body._drivenAppliedPhaseParameter = typeof name === 'string' && name.trim()
    ? name.trim().toLowerCase()
    : null;
  if (body._drivenAppliedExpr) setDrivenAppliedForceExpr(body, body._drivenAppliedExpr);
}

/**
 * @param {import('matter-js').Body} body
 * @param {number} t
 * @returns {Record<string, number>}
 */
export function evaluateDrivenAppliedParameters(body, t) {
  const fns = body._drivenAppliedParameterFns ?? {};
  const values = {};
  const active = new Set();
  const evaluate = (name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    if (active.has(name)) return NaN;
    const entry = fns[name];
    if (!entry) return NaN;
    active.add(name);
    const dependencies = entry.dependencies ?? [];
    const dependencyValues = {};
    for (const dependency of dependencies) {
      dependencyValues[dependency] = evaluate(dependency);
    }
    const value = entry.eval({ t, ...dependencyValues });
    active.delete(name);
    values[name] = Number.isFinite(value) ? value : NaN;
    return values[name];
  };
  for (const name of Object.keys(fns)) evaluate(name);
  return values;
}

/**
 * Numerically integrate a named parameter from zero to t. This is used only
 * for phase parameters, so `sin(omega t)` has the correct instantaneous ω.
 * @param {import('matter-js').Body} body
 * @param {string} name
 * @param {number} t
 */
function integrateDrivenAppliedParameter(body, name, t) {
  if (!Number.isFinite(t) || t === 0) return 0;
  const steps = 64;
  const h = t / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const ti = i * h;
    const value = evaluateDrivenAppliedParameters(body, ti)[name];
    if (!Number.isFinite(value)) return null;
    sum += value * (i === 0 || i === steps ? 0.5 : 1);
  }
  return sum * h;
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
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {string}
 */
export function getDrivenAppliedFrequencyExpr(body) {
  if (!supportsAppliedForce(body)) return '';
  return typeof body._drivenAppliedFrequencyExpr === 'string'
    ? body._drivenAppliedFrequencyExpr
    : '';
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
  const compiled = compileExpr(src, {
    variables: Object.keys(body._drivenAppliedParameters ?? {}),
  });
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
 * Compile and store instantaneous drive frequency f(t), in Hz.
 * @param {import('matter-js').Body} body
 * @param {string} expr
 * @returns {{ ok: true, source: string }|{ ok: false, error: string }}
 */
export function setDrivenAppliedFrequencyExpr(body, expr) {
  if (!supportsAppliedForce(body)) return { ok: false, error: 'Not a forceable body' };
  const src = String(expr ?? '').trim();
  if (!src) {
    body._drivenAppliedFrequencyExpr = '';
    body._drivenAppliedFrequencyFn = null;
    body._drivenAppliedFrequencyError = 'Empty expression';
    return { ok: false, error: 'Empty expression' };
  }
  const compiled = compileExpr(src);
  if (!compiled.ok) {
    body._drivenAppliedFrequencyExpr = src;
    body._drivenAppliedFrequencyFn = null;
    body._drivenAppliedFrequencyError = compiled.error;
    return compiled;
  }
  body._drivenAppliedFrequencyExpr = compiled.source;
  body._drivenAppliedFrequencyFn = compiled.eval;
  body._drivenAppliedFrequencyError = null;
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
  // Keep the authored instantaneous parameter values separate from the
  // phase value substituted into this one force evaluation.
  const parameters = evaluateDrivenAppliedParameters(body, t);
  const phaseParameter = body._drivenAppliedPhaseParameter;
  if (phaseParameter && Object.prototype.hasOwnProperty.call(parameters, phaseParameter)) {
    const phase = integrateDrivenAppliedParameter(body, phaseParameter, t);
    if (phase == null) return null;
    parameters[phaseParameter] = t === 0 ? 0 : phase / t;
  }
  const v = fn({ t, ...parameters });
  return isFinite(v) ? v : null;
}

/**
 * Evaluate instantaneous driven frequency f(t) in Hz, or null.
 * @param {import('matter-js').Body} body
 * @param {number} t  sim time (s)
 */
export function evaluateDrivenAppliedFrequency(body, t) {
  if (!isDrivenAppliedForce(body)) return null;
  const phaseParameter = body._drivenAppliedPhaseParameter;
  if (phaseParameter && body._drivenAppliedParameterFns?.[phaseParameter]) {
    const parameters = evaluateDrivenAppliedParameters(body, t);
    const omega = parameters[phaseParameter];
    return isFinite(omega) ? omega / (2 * Math.PI) : null;
  }
  const fn = body._drivenAppliedFrequencyFn;
  if (typeof fn !== 'function') return null;
  const v = fn({ t, ...evaluateDrivenAppliedParameters(body, t) });
  return isFinite(v) ? v : null;
}

/**
 * Evaluate instantaneous angular frequency ω(t) in rad/s, or null.
 * @param {import('matter-js').Body} body
 * @param {number} t  sim time (s)
 */
export function evaluateDrivenAppliedOmega(body, t) {
  const phaseParameter = body?._drivenAppliedPhaseParameter;
  if (phaseParameter && body?._drivenAppliedParameterFns?.[phaseParameter]) {
    // UI readouts use the authored instantaneous value. Only force evaluation
    // above replaces the local parameter with its time average for sin(...).
    const parameters = evaluateDrivenAppliedParameters(body, t);
    const omega = parameters[phaseParameter];
    return isFinite(omega) ? omega : null;
  }
  const f = evaluateDrivenAppliedFrequency(body, t);
  return f == null ? null : 2 * Math.PI * f;
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
    b._drivenAppliedLastOmega = evaluateDrivenAppliedOmega(b, t);
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
