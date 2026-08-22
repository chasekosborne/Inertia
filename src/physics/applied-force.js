/**
 * Constant applied pull / push on a body (display-frame SI).
 *
 * F (N) at angle θ° above +x (right). Matter’s +y is down, so the upward
 * component is −sin θ in Matter force units.
 */

import { PX_PER_M } from '../units.js';

/** 1 N = 1 kg·m/s² → Matter kg·px/ms² (same as air-drag / springs). */
export function newtonsToMatterForce(FN) {
  return FN * PX_PER_M / 1e6;
}

/**
 * @param {number} F          Newtons
 * @param {number} thetaDeg   Degrees above +x (display / textbook)
 * @returns {{ fx: number, fy: number }} Matter force components
 */
export function appliedForceToMatter(F, thetaDeg) {
  if (!(F > 0) || !isFinite(F) || !isFinite(thetaDeg)) return { fx: 0, fy: 0 };
  const rad = thetaDeg * Math.PI / 180;
  const Fm = newtonsToMatterForce(F);
  return {
    fx: Fm * Math.cos(rad),
    fy: -Fm * Math.sin(rad),
  };
}

/**
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
 * @param {import('matter-js').Body} body
 * @param {number} F
 * @param {number} thetaDeg
 */
export function setAppliedForce(body, F, thetaDeg) {
  const f = Number(F);
  const th = Number(thetaDeg);
  if (!(f > 0) || !isFinite(f) || !isFinite(th)) {
    body._appliedForce = null;
    return;
  }
  body._appliedForce = { F: f, thetaDeg: th };
}

/** Clear applied force (treat as none). */
export function clearAppliedForce(body) {
  body._appliedForce = null;
}

/**
 * Matter-frame components of the body’s applied force, or zeros.
 * @param {import('matter-js').Body} body
 */
export function appliedForceMatterComponents(body) {
  const af = getAppliedForce(body);
  if (!af) return { fx: 0, fy: 0 };
  return appliedForceToMatter(af.F, af.thetaDeg);
}
