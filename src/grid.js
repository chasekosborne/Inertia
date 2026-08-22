/*
 * World space grid used for snap-to-grid placement and velocity-handle alignment.
 * Keep {@link GRID_CELL_PX} in sync with renderer minor grid spacing.
 */
import {
  getVelocityPxPerMs,
  matterVelToDisplayMS,
  displayMSToMatterVel,
} from './units.js';

// 1 m = 100 px | See ../units.js (PX_PER_M).
// Snap resolution = 0.1 m = 10 px, major grid cell = 1 m = 100 px.
export const GRID_CELL_PX = 10;

/**
 * Tip within this many world px of the body centre clears v₀ / F
 * (drag-to-origin). Larger than a hair so grid snap cannot leave a
 * residual when the body is off the snap lattice.
 */
export const VECTOR_ZERO_TIP_PX = 10;

export function snapWorldCoord(v, enabled) {
  if (!enabled) return Math.round(v);
  return Math.round(v / GRID_CELL_PX) * GRID_CELL_PX;
}

/*
 * Snap velocity so the v_0 handle tip lies on the world grid.
 * Tip offset uses {@link getVelocityPxPerMs} world px per 1 m/s.
 * `vx` / `vy` are Matter linear velocities (arguments in `Body.setVelocity`).
 */
export function snapVelocityToGrid(cx, cy, vxMat, vyMat, enabled) {
  const vPx = getVelocityPxPerMs();
  const { vxMs, vyMs } = matterVelToDisplayMS(vxMat, vyMat);
  const tipX0 = cx + vxMs * vPx;
  const tipY0 = cy - vyMs * vPx;
  // Dragging the tip onto the body centre always clears velocity, even with snap.
  if ((tipX0 - cx) ** 2 + (tipY0 - cy) ** 2 <= VECTOR_ZERO_TIP_PX * VECTOR_ZERO_TIP_PX) {
    return { vx: 0, vy: 0 };
  }
  if (!enabled) return { vx: vxMat, vy: vyMat };
  let tipX = tipX0;
  let tipY = tipY0;
  tipX = snapWorldCoord(tipX, true);
  tipY = snapWorldCoord(tipY, true);
  if ((tipX - cx) ** 2 + (tipY - cy) ** 2 <= VECTOR_ZERO_TIP_PX * VECTOR_ZERO_TIP_PX) {
    return { vx: 0, vy: 0 };
  }
  const vxMs2 = (tipX - cx) / vPx;
  const vyMs2 = -(tipY - cy) / vPx;
  return displayMSToMatterVel(vxMs2, vyMs2);
}

// Radians, consistent 5° step for Ctrl-snap on segments, pendulum arcs, and rotate.
export const SNAP_ANGLE_STEP_5_RAD = (5 * Math.PI) / 180;

// Degrees same step as {@link SNAP_ANGLE_STEP_5_RAD}.
export const SNAP_ANGLE_STEP_5_DEG = 5;

/*
 * Snap an angle (radians) to the nearest Ctrl-lock increment.
 */
export function snapAngleRad(angleRad, enabled = true) {
  if (!enabled) return angleRad;
  return Math.round(angleRad / SNAP_ANGLE_STEP_5_RAD) * SNAP_ANGLE_STEP_5_RAD;
}

/*
 * Snap display-space velocity (m/s, +y up) to the nearest 5° while keeping |v|,
 * optionally rounding speed to {@link VELOCITY_SNAP_MS} when `speedStep` is set.
 * Used for Ctrl-drag on the v₀ handle.
 */
export const VELOCITY_SNAP_MS = 0.1;

/*
 * @param {number} vxMs
 * @param {number} vyMs
 * @param {{ angle?: boolean, speedStep?: number|null }} [opts]
 *   `angle`: snap direction to 5° (default true).
 *   `speedStep`: if set (e.g. 0.1), round |v| to that increment along the snapped direction.
 */
export function snapVelocityToAngle(vxMs, vyMs, opts = {}) {
  const angleSnap = opts.angle !== false;
  const speedStep = opts.speedStep ?? null;
  const speed0 = Math.hypot(vxMs, vyMs);
  if (speed0 < 1e-12) return { vxMs: 0, vyMs: 0 };
  const ang = angleSnap
    ? snapAngleRad(Math.atan2(vyMs, vxMs), true)
    : Math.atan2(vyMs, vxMs);
  let speed = speed0;
  if (speedStep != null && speedStep > 0) {
    speed = Math.round(speed0 / speedStep) * speedStep;
  }
  return {
    vxMs: speed * Math.cos(ang),
    vyMs: speed * Math.sin(ang),
  };
}

/*
 * From start (sx,sy), chord toward (exRaw,eyRaw): optional grid snap on the free end,
 * then optional Ctrl: snap direction to 5° while keeping chord length.
 * @returns {{ x: number, y: number, len: number, angle: number }}
 */
export function snapSegmentFromStart(sx, sy, exRaw, eyRaw, snapGrid, ctrlLockAngle) {
  let ex = exRaw;
  let ey = eyRaw;
  if (snapGrid) {
    ex = snapWorldCoord(ex, true);
    ey = snapWorldCoord(ey, true);
  }
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: sx, y: sy, len: 0, angle: 0 };
  let angle = Math.atan2(dy, dx);
  if (ctrlLockAngle) {
    angle = snapAngleRad(angle, true);
  }
  return {
    x: sx + len * Math.cos(angle),
    y: sy + len * Math.sin(angle),
    len,
    angle,
  };
}
