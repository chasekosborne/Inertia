/**
 * Mechanical energy (SI) for the sandbox: kinetic + gravitational + spring.
 *
 * Matter’s Verlet + Gauss-Seidel constraints slowly bleed energy even with
 * damping = 0 and a fixed timestep. When no intentional dissipation is active,
 * we rescale free-body velocities to hold total E at a captured target.
 */

import Matter from 'matter-js';
import { PX_PER_M, matterVelToDisplayMS } from '../units.js';
import { gravityMs2 } from './friction.js';
import {
  bodyInertiaSI,
  matterOmegaToDisplay,
} from './angular.js';
import {
  constraintAnchorWorld,
  isSpringConstraint,
} from './constraints.js';
import { getAppliedForce, hasDrivenAppliedForce } from './applied-force.js';
import { getAppliedTorque } from './applied-torque.js';
import { hasDrivenPivot } from './driven-pivot.js';

const { Body } = Matter;

/** @param {import('matter-js').Body} b */
function isDynamic(b) {
  return !!(b && !b.isStatic && b._newtonType !== 'metric-basis');
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @returns {number}  Total mechanical energy (J)
 */
export function mechanicalEnergy(engine) {
  const g = gravityMs2(engine.engine.gravity);
  const gx = engine.engine.gravity?.x ?? 0;
  const gy = engine.engine.gravity?.y ?? 0;
  const glen = Math.hypot(gx, gy);
  const ux = glen > 1e-15 ? gx / glen : 0;
  const uy = glen > 1e-15 ? gy / glen : 1;

  let E = 0;
  for (const b of engine.bodies) {
    if (!isDynamic(b)) continue;
    const { vxMs, vyMs } = matterVelToDisplayMS(b.velocity.x, b.velocity.y);
    E += 0.5 * b.mass * (vxMs * vxMs + vyMs * vyMs);

    const I = bodyInertiaSI(b);
    if (I != null) {
      const omega = matterOmegaToDisplay(b.angularVelocity || 0);
      E += 0.5 * I * omega * omega;
    }

    // Height increases opposite gravity (Matter +y down when gy > 0).
    const h = -(b.position.x * ux + b.position.y * uy) / PX_PER_M;
    E += b.mass * g * h;
  }

  for (const c of engine.constraints) {
    if (!isSpringConstraint(c)) continue;
    const pA = constraintAnchorWorld(c, 'A');
    const pB = constraintAnchorWorld(c, 'B');
    const len = Math.hypot(pB.x - pA.x, pB.y - pA.y);
    const extM = (len - c.restLength) / PX_PER_M;
    E += 0.5 * (c._kNm ?? 0) * extM * extM;
  }

  return E;
}

/**
 * True when an external drive would change energy by design (not numerical drift).
 * @param {import('./engine.js').PhysicsEngine} engine
 */
export function hasNonConservativeDrive(engine) {
  if (hasDrivenPivot(engine)) return true;
  if (hasDrivenAppliedForce(engine)) return true;
  for (const b of engine.bodies) {
    if (!isDynamic(b)) continue;
    if (getAppliedForce(b)) return true;
    if (getAppliedTorque(b) != null) return true;
  }
  return false;
}

/**
 * Active contact involving an inelastic body (restitution &lt, 1).
 * @param {import('./engine.js').PhysicsEngine} engine
 */
export function hasInelasticContact(engine) {
  const pairs = engine.engine.pairs?.list;
  if (!pairs?.length) return false;
  for (const p of pairs) {
    if (!p?.isActive) continue;
    const eA = p.bodyA?.restitution ?? 0;
    const eB = p.bodyB?.restitution ?? 0;
    if (Math.min(eA, eB) < 0.999) return true;
  }
  return false;
}

/**
 * Uniformly scale free-body linear/angular velocities so total E matches target.
 * Potential (gravity + springs) is left unchanged.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {number} E_target
 * @returns {boolean} whether velocities were adjusted
 */
export function restoreMechanicalEnergy(engine, E_target) {
  if (!isFinite(E_target)) return false;

  let KE = 0;
  let PE = 0;
  const g = gravityMs2(engine.engine.gravity);
  const gx = engine.engine.gravity?.x ?? 0;
  const gy = engine.engine.gravity?.y ?? 0;
  const glen = Math.hypot(gx, gy);
  const ux = glen > 1e-15 ? gx / glen : 0;
  const uy = glen > 1e-15 ? gy / glen : 1;

  const dyn = [];
  for (const b of engine.bodies) {
    if (!isDynamic(b)) continue;
    dyn.push(b);
    const { vxMs, vyMs } = matterVelToDisplayMS(b.velocity.x, b.velocity.y);
    KE += 0.5 * b.mass * (vxMs * vxMs + vyMs * vyMs);
    const I = bodyInertiaSI(b);
    if (I != null) {
      const omega = matterOmegaToDisplay(b.angularVelocity || 0);
      KE += 0.5 * I * omega * omega;
    }
    const h = -(b.position.x * ux + b.position.y * uy) / PX_PER_M;
    PE += b.mass * g * h;
  }

  for (const c of engine.constraints) {
    if (!isSpringConstraint(c)) continue;
    const pA = constraintAnchorWorld(c, 'A');
    const pB = constraintAnchorWorld(c, 'B');
    const len = Math.hypot(pB.x - pA.x, pB.y - pA.y);
    const extM = (len - c.restLength) / PX_PER_M;
    PE += 0.5 * (c._kNm ?? 0) * extM * extM;
  }

  const KE_needed = E_target - PE;
  // Turning points / resting: nothing to scale without inventing a direction.
  if (!(KE > 1e-14)) return false;
  if (!(KE_needed > 0)) {
    for (const b of dyn) {
      Body.setVelocity(b, { x: 0, y: 0 });
      if (isFinite(b.inertia) && b.inertia !== Infinity) {
        Body.setAngularVelocity(b, 0);
      }
    }
    return true;
  }

  const s = Math.sqrt(KE_needed / KE);
  if (!isFinite(s) || Math.abs(s - 1) < 1e-12) return false;

  for (const b of dyn) {
    Body.setVelocity(b, {
      x: b.velocity.x * s,
      y: b.velocity.y * s,
    });
    if (isFinite(b.inertia) && b.inertia !== Infinity) {
      Body.setAngularVelocity(b, (b.angularVelocity || 0) * s);
    }
  }
  return true;
}
