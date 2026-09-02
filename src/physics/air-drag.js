/**
 * Quadratic air drag F = ½ ρ Cd A v² opposite velocity (Matter force units).
 */

import Matter from 'matter-js';
import { PX_PER_M, matterVelToPxPerSec } from '../units.js';

const { Body } = Matter;

/**
 * Clear the last computed drag-force display vectors.
 * @param {import('matter-js').Body[]} bodies
 */
export function clearAirDragVisuals(bodies) {
  for (const b of bodies ?? []) {
    if (b) b._airDragVis = null;
  }
}

/**
 * @param {import('matter-js').Body[]} bodies
 * @param {{ rho: number, Cd: number, A: number }} params
 * @param {{ noteEnergyDissipation?: () => void }|null} [engine]
 * @returns {boolean} whether any drag force was applied
 */
export function applyQuadraticAirDrag(bodies, params, engine = null) {
  const { rho, Cd, A } = params;
  let applied = false;
  clearAirDragVisuals(bodies);
  for (const b of bodies) {
    if (!b || b.isStatic) continue;
    const { vxPps, vyPps } = matterVelToPxPerSec(b.velocity.x, b.velocity.y);
    const vxMs = vxPps / PX_PER_M;
    const vyMs = vyPps / PX_PER_M;
    const vMs2 = vxMs * vxMs + vyMs * vyMs;
    if (vMs2 < 1e-6) continue;
    const vMag = Math.sqrt(vMs2);

    const FN = 0.5 * rho * Cd * A * vMs2;
    const Fmatter = FN * PX_PER_M / 1e6;

    Body.applyForce(b, b.position, {
      x: -(vxMs / vMag) * Fmatter,
      y: -(vyMs / vMag) * Fmatter,
    });
    b._airDragVis = {
      fxN: -(vxMs / vMag) * FN,
      fyN: -(vyMs / vMag) * FN,
    };
    applied = true;
  }
  if (applied) engine?.noteEnergyDissipation?.();
  return applied;
}
