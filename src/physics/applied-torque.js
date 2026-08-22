/**
 * Constant applied torque on a body (display-frame SI).
 *
 * τ (N·m), signed: positive = CCW / out of the screen (⊙),
 * negative = CW / into the screen (⊗). Matter +y is down, so the
 * Matter torque sign is flipped relative to display.
 */

import { PX_PER_M } from '../units.js';

/**
 * 1 N·m = 1 kg·m²/s² → Matter kg·px²/ms² (same time scaling as applied force).
 * @param {number} tauNm
 */
export function newtonMetresToMatterTorque(tauNm) {
  return tauNm * (PX_PER_M * PX_PER_M) / 1e6;
}

/**
 * Display τ → Matter torque increment (additive each step).
 * @param {number} tauDisplay  N·m, + = CCW / out of screen
 */
export function appliedTorqueToMatter(tauDisplay) {
  if (!isFinite(tauDisplay) || tauDisplay === 0) return 0;
  // Flip: display + (CCW on screen) is Matter − (CW in Matter +y-down).
  return -newtonMetresToMatterTorque(tauDisplay);
}

/**
 * @param {import('matter-js').Body|null|undefined} body
 * @returns {number|null}  Display τ in N·m, or null if none
 */
export function getAppliedTorque(body) {
  const t = body?._appliedTorque;
  if (t == null || typeof t !== 'object') return null;
  const tau = Number(t.tau);
  if (!isFinite(tau) || tau === 0) return null;
  return tau;
}

/**
 * @param {import('matter-js').Body} body
 * @param {number} tauNm  Display N·m (+ CCW). 0 / non-finite clears.
 */
export function setAppliedTorque(body, tauNm) {
  const tau = Number(tauNm);
  if (!isFinite(tau) || tau === 0) {
    body._appliedTorque = null;
    return;
  }
  body._appliedTorque = { tau };
}

/** Clear applied torque. */
export function clearAppliedTorque(body) {
  body._appliedTorque = null;
}
