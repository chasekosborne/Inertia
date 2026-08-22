/**
 * World ↔ SI helpers. Positions in Matter are px with fixed scale, velocities
 * use Matter’s post-step convention (see {@link https://brm.io/matter-js/docs/classes/Body.html Matter.Body.updateVelocities}).
 */

import Matter from 'matter-js';

const { Body, Common, Engine } = Matter;

/** World length: pixels per metre (matches grid major spacing). */
export const PX_PER_M = 100;

/**
 * World-space pixels per 1 m/s for the v₀ handle (before {@link getVelocityArrowScale}).
 * Must match `GRID_CELL_PX` in `grid.js` (one minor square = 1 m/s at scale 1).
 */
export const VELOCITY_PX_PER_MS = 10;

/**
 * Diagram / handle scale for weight: px per kg at g ≈ 9.81 (before force arrow scale).
 * 1.5× the original 40 px/kg so force arrows read a bit larger by default.
 */
export const WEIGHT_PX_PER_KG = 60;

/**
 * Diagram / handle scale for applied force: px per newton (before force arrow scale).
 * Matches weight arrow length: |W| = mg → {@link WEIGHT_PX_PER_KG} px for 1 kg at g = 9.81.
 */
export const FORCE_PX_PER_N = WEIGHT_PX_PER_KG / 9.81;

const ARROW_SCALE_MIN = 0.25;
const ARROW_SCALE_MAX = 4;

/** @param {number} s */
function _clampArrowScale(s) {
  const n = Number(s);
  return Math.max(ARROW_SCALE_MIN, Math.min(ARROW_SCALE_MAX, Number.isFinite(n) ? n : 1));
}

/** User multiplier for force arrow / handle lengths (settings slider). */
let _forceArrowScale = 1;
/** User multiplier for velocity arrow / handle lengths (settings slider). */
let _velocityArrowScale = 1;

export function getForceArrowScale() {
  return _forceArrowScale;
}

/** @param {number} s  Clamped to [0.25, 4]. */
export function setForceArrowScale(s) {
  _forceArrowScale = _clampArrowScale(s);
  return _forceArrowScale;
}

export function getVelocityArrowScale() {
  return _velocityArrowScale;
}

/** @param {number} s  Clamped to [0.25, 4]. */
export function setVelocityArrowScale(s) {
  _velocityArrowScale = _clampArrowScale(s);
  return _velocityArrowScale;
}

/** Effective px per newton (base × force arrow scale). */
export function getForcePxPerN() {
  return FORCE_PX_PER_N * _forceArrowScale;
}

/** Effective px per (m/s) for velocity arrows / handles. */
export function getVelocityPxPerMs() {
  return VELOCITY_PX_PER_MS * _velocityArrowScale;
}

/** Effective px per kg for weight arrows (uses force arrow scale). */
export function getWeightPxPerKg() {
  return WEIGHT_PX_PER_KG * _forceArrowScale;
}

/** Default box side length (m): boxes are square on place. */
export const DEFAULT_BOX_SIZE_M = 0.4;

/**
 * Default radius for circle / point-mass (m).
 * Diameter equals {@link DEFAULT_BOX_SIZE_M} so a circle matches a default box.
 */
export const DEFAULT_CIRCLE_RADIUS_M = DEFAULT_BOX_SIZE_M / 2;

/** @deprecated Use {@link DEFAULT_CIRCLE_RADIUS_M}. */
export const DEFAULT_POINT_MASS_RADIUS_M = DEFAULT_CIRCLE_RADIUS_M;

/** Default radius for solid ball (m): smaller than the circle. */
export const DEFAULT_BALL_RADIUS_M = 0.06;

/**
 * Default position of the metric-basis body in world space (metres → px via {@link mToPx}).
 * Scene loads re-centre the camera on this body in the viewport.
 */
export const METRIC_BASIS_DEFAULT_M = { xm: 0, ym: 0 };

/** Fixed physics rate (Hz). Must match patched Matter `Body` / `Common` `_baseDelta`.
 *  Higher rates reduce the per-bounce energy error (= 10 / SIM_HZ  m/s) from gravity
 *  discretisation in Matter's Verlet integrator.  960 Hz → ~0.01 m/s/bounce (<1% over 10 bounces). */
export const SIM_HZ = 960;

/** `Engine.update` delta (ms), same value passed every fixed step. */
export const BASE_DELTA_MS = 1000 / SIM_HZ;

Body._baseDelta = BASE_DELTA_MS;
Common._baseDelta = BASE_DELTA_MS;
Engine._deltaMax = BASE_DELTA_MS;

/**
 * **Physical friction (what you edit in the UI)**  
 * Coefficients are ordinary dimensionless Coulomb μk, μs: the same numbers
 * you would look up for materials (dry, order-of-magnitude):
 *
 * | Interface (typical)        | μk (rough) |
 * |---------------------------|------------|
 * | Ice on ice                | 0.03-0.06  |
 * | Smooth polymer / HDPE etc.| 0.15-0.30  |
 *
 * Contact friction is applied as explicit Newton forces in
 * `physics/friction.js` (Matter’s built-in tangent solver is disabled).
 * Interface μ is the geometric mean √(μ₁ μ₂).
 */

export function pxToM(px) {
  return px / PX_PER_M;
}

export function mToPx(m) {
  return m * PX_PER_M;
}

/** Linear speed in px/s from Matter `body.velocity` (after updateVelocities). */
export function matterVelToPxPerSec(vxMat, vyMat) {
  const k = 1000 / BASE_DELTA_MS;
  return { vxPps: vxMat * k, vyPps: vyMat * k };
}

/** Matter velocity → display m/s with +y = up on screen. */
export function matterVelToDisplayMS(vxMat, vyMat) {
  const { vxPps, vyPps } = matterVelToPxPerSec(vxMat, vyMat);
  return { vxMs: vxPps / PX_PER_M, vyMs: -vyPps / PX_PER_M };
}

/** Display m/s (+y up) → arguments for `Body.setVelocity`. */
export function displayMSToMatterVel(vxMs, vyMsDisplayUpPos) {
  const k = PX_PER_M * (BASE_DELTA_MS / 1000);
  return { vx: vxMs * k, vy: -vyMsDisplayUpPos * k };
}
