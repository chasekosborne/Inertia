/**
 * Angular kinematics / momentum in display SI (+y up).
 *
 * Matter uses +y down, positive Matter ω appears clockwise on screen.
 * Display convention: positive ω and L point out of the screen (⊙) = CCW
 * when viewing the page, negative = into the screen (⊗) = CW.
 *
 * About the COM, L = Iω (spin only). About a fixed point O,
 * L_O = Iω + r_com/O × p  (spin + orbital). The ⊙/⊗ glyph at the COM
 * shows spin L (painted above bodies). Planar force / velocity arrows
 * paint above body fills (below L/τ). Contact friction changes spin while coupling to
 * translation so pure rolling (v = ωr) can develop; total L about an
 * inertial origin is conserved when net external torque about that origin
 * vanishes.
 */

import { PX_PER_M, BASE_DELTA_MS, matterVelToDisplayMS, pxToM } from '../units.js';

/** Matter ω (rad / baseDelta) → rad/s (Matter frame, + = CCW in Matter coords). */
export function matterOmegaToRadPerSec(wMat) {
  if (!isFinite(wMat)) return 0;
  return wMat * (1000 / BASE_DELTA_MS);
}

/** Display ω_z (rad/s, + = out of screen / CCW) → Matter angularVelocity. */
export function displayOmegaToMatter(omegaDisplay) {
  if (!isFinite(omegaDisplay)) return 0;
  return -omegaDisplay * (BASE_DELTA_MS / 1000);
}

/** Matter ω → display ω_z (rad/s, + = out of screen / CCW). */
export function matterOmegaToDisplay(wMat) {
  return -matterOmegaToRadPerSec(wMat);
}

/**
 * Moment of inertia in SI (kg·m²) from Matter inertia (kg·px²).
 * @param {import('matter-js').Body} body
 */
export function bodyInertiaSI(body) {
  const I = body?.inertia;
  if (!isFinite(I) || I === Infinity || I <= 0) return null;
  return I / (PX_PER_M * PX_PER_M);
}

/** 2D cross product z-component (display +y up). */
function crossZ(rx, ry, vx, vy) {
  return rx * vy - ry * vx;
}

/**
 * Spin angular momentum about the COM: L = Iω (display SI, + out of screen).
 * @param {import('matter-js').Body} body
 * @returns {number|null}
 */
export function bodySpinAngularMomentumSI(body) {
  if (!body || body.isStatic) return null;
  const I = bodyInertiaSI(body);
  if (I == null) return null;
  const omega = matterOmegaToDisplay(body.angularVelocity || 0);
  return I * omega;
}

/** @deprecated Prefer {@link bodySpinAngularMomentumSI}. */
export function bodyAngularMomentumSI(body) {
  return bodySpinAngularMomentumSI(body);
}

/**
 * Orbital angular momentum of the COM about a display-frame origin (m): r × p.
 * @param {import('matter-js').Body} body
 * @param {{ x: number, y: number }} [originM]  Display metres (+y up), default (0,0)
 * @returns {number|null}
 */
export function bodyOrbitalAngularMomentumAboutSI(body, originM = { x: 0, y: 0 }) {
  if (!body || body.isStatic) return null;
  if (!(body.mass > 0) || !isFinite(body.mass)) return null;
  const xm = pxToM(body.position.x) - (originM.x ?? 0);
  // Matter +y down → display +y up
  const ym = -pxToM(body.position.y) - (originM.y ?? 0);
  const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
  return body.mass * crossZ(xm, ym, vxMs, vyMs);
}

/**
 * Total angular momentum about a display-frame origin: Iω + r × p.
 * @param {import('matter-js').Body} body
 * @param {{ x: number, y: number }} [originM]
 * @returns {number|null}
 */
export function bodyAngularMomentumAboutSI(body, originM = { x: 0, y: 0 }) {
  const spin = bodySpinAngularMomentumSI(body);
  const orb = bodyOrbitalAngularMomentumAboutSI(body, originM);
  if (spin == null && orb == null) return null;
  return (spin ?? 0) + (orb ?? 0);
}

/**
 * Sum of L about an origin over free bodies (for conservation checks).
 * @param {import('matter-js').Body[]} bodies
 * @param {{ x: number, y: number }} [originM]
 */
export function systemAngularMomentumAboutSI(bodies, originM = { x: 0, y: 0 }) {
  let L = 0;
  for (const b of bodies ?? []) {
    if (!b || b.isStatic || b._newtonType === 'metric-basis') continue;
    const Li = bodyAngularMomentumAboutSI(b, originM);
    if (Li != null && isFinite(Li)) L += Li;
  }
  return L;
}

/**
 * Glyph radius (world px) from a signed magnitude.
 * Compact defaults so ⊙/⊗ sit at the COM without dominating the body.
 * @param {number} magAbs
 * @param {number} [base=5]
 * @param {number} [gain=2]
 * @param {number} [maxR=11]
 */
export function outOfPlaneGlyphRadius(magAbs, base = 5, gain = 2, maxR = 11) {
  if (!(magAbs > 0) || !isFinite(magAbs)) return base;
  return Math.min(maxR, base + gain * Math.sqrt(magAbs));
}

/** Compact ⊙/⊗ radius for angular velocity (rad/s). */
export function outOfPlaneOmegaGlyphRadius(omegaAbs) {
  return outOfPlaneGlyphRadius(omegaAbs, 2.6, 0.35, 5);
}

/** ⊙/⊗ radius for spin angular momentum |L| (kg·m²/s). */
export function outOfPlaneLGlyphRadius(LAbs) {
  return outOfPlaneGlyphRadius(LAbs, 3.2, 0.85, 9);
}
