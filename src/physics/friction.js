/**
 * Coulomb contact friction: forces/impulses in the **contact plane** only.
 *
 * Matter’s built-in tangent solver is disabled (see engine.js).
 *
 * Round bodies (circle / ball, finite I):
 *   Friction is applied **after** the collision solve as a tangential velocity
 *   impulse at the geometric rim (see circle-contact.js) so it couples
 *   translation and spin. Static friction tries to enforce zero contact slip
 *   (pure rolling), if that needs more than μₛ N Δt², kinetic μₖ N Δt² acts
 *   and the body slips.
 *
 *   Applying as a post-step impulse (not a beforeUpdate force) is essential:
 *   Matter’s normal solver otherwise injects spurious torque at polygon
 *   support points and continuously erases rolling spin. Rim contacts also
 *   stop a rolling disk from chattering / skipping off the surface.
 *
 * Polygonal bodies (box / wedge):
 *   Friction impulse through the COM only: face contact must not invent a tip
 *   / “rolling” torque. While the face is aligned with the contact tangent,
 *   residual ω is cleared so boxes slide or stick without tumbling.
 *
 * Interface μ is the geometric mean √(μₐ μᵦ).
 */

import Matter from 'matter-js';
import { isRoundBody } from './bodies.js';
import { appliedForceMatterComponents } from './applied-force.js';
import { circleContact } from './circle-contact.js';
import { BASE_DELTA_MS } from '../units.js';

const { Body, Collision } = Matter;

/** Matter Verlet: Δv = (F/m) Δt² with Δt in ms (= BASE_DELTA_MS). */
const DT2 = BASE_DELTA_MS * BASE_DELTA_MS;

const MIN_CONTACT_DEPTH_PX = 0.02;
const SOLID_CONTACT_DEPTH_PX = 0.08;
const LAUNCH_VN_MATTER = 0.02;
const SEPARATING_VN_MATTER = 0.004;
const STATIC_CAPTURE_STEPS = 20;
const REST_SLIP_NOISE = 1e-5;

/**
 * Matter-unit slip below which static friction may capture / hold.
 * @param {number} maxStaticP  μₛ N · Δt² (velocity-impulse units)
 * @param {number} P_parallel  Impulse that cancels in-plane load for rest
 * @param {number} compliance  Δv_slip / P  (K for roll, invMass for slide)
 */
export function staticRestSlipMatter(maxStaticP, P_parallel, compliance) {
  const leftover = maxStaticP - Math.abs(P_parallel);
  if (!(leftover > 1e-18) || !(compliance > 0) || !isFinite(compliance)) return 0;
  return leftover * compliance * STATIC_CAPTURE_STEPS;
}

/** @deprecated Prefer {@link staticRestSlipMatter}, kept as a flat-surface reference scale. */
export const FRICTION_REST_SLIP_MS = 0.1;

export function geomMeanMu(a, b) {
  return Math.sqrt(Math.max(0, a) * Math.max(0, b));
}

export function gravityMs2(gravity) {
  const gx = gravity?.x ?? 0;
  const gy = gravity?.y ?? 0;
  const mag = Math.hypot(gx, gy);
  const scale = gravity?.scale ?? 0;
  if (mag < 1e-15 || scale === 0) return 0;
  return (scale / 0.001) * 9.81 * mag;
}

/**
 * Supporting unit normal (opposes gravity) and an orthonormal in-plane tangent.
 * @returns {{ nx:number, ny:number, tx:number, ty:number }|null}
 */
export function contactFrame(rawN, gx, gy) {
  const nLen = Math.hypot(rawN.x, rawN.y);
  if (!(nLen > 1e-8)) return null;
  let nx = rawN.x / nLen;
  let ny = rawN.y / nLen;
  if (nx * gx + ny * gy > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny, tx: -ny, ty: nx };
}

/** True when a round body can spin (finite inertia). */
export function canRoll(body) {
  return isRoundBody(body)
    && !body.isStatic
    && body.inverseInertia > 1e-18
    && isFinite(body.inertia);
}

function isPolygonal(body) {
  if (body?._ropeSegment) return false;
  const t = body?._newtonType;
  return t === 'box' || t === 'wedge';
}

function velocityAtPoint(body, px, py) {
  const ox = px - body.position.x;
  const oy = py - body.position.y;
  const w = body.angularVelocity || 0;
  return {
    vx: body.velocity.x - w * oy,
    vy: body.velocity.y + w * ox,
  };
}

function contactPoint(col, fallbackBody) {
  const n = col.supportCount ?? 0;
  const supports = col.supports;
  if (supports && n > 0) {
    let sx = 0;
    let sy = 0;
    let used = 0;
    for (let i = 0; i < n; i++) {
      const p = supports[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      sx += p.x;
      sy += p.y;
      used++;
    }
    if (used > 0) return { x: sx / used, y: sy / used };
  }
  return { x: fallbackBody.position.x, y: fallbackBody.position.y };
}

/**
 * Round bodies: Matter support points vs wedges are often far off the rim.
 * Use the surface point along the supporting normal (COM − n̂ R).
 */
function frictionPoint(col, dyn, nx, ny) {
  if (canRoll(dyn)) {
    const R = dyn._radius ?? dyn.circleRadius;
    if (R > 1e-6) {
      return {
        x: dyn.position.x - nx * R,
        y: dyn.position.y - ny * R,
      };
    }
  }
  return contactPoint(col, dyn);
}

/**
 * Apply tangential velocity impulse P at a world point (Δv = P/m, τΔt² → Δω).
 * P has Matter “force · Δt²” units so Δv_slip = P · K with K = invM + (r×t)² invI.
 */
function applyTangentImpulse(body, tx, ty, P, rCrossT) {
  if (!body || !(Math.abs(P) > 1e-18)) return;
  Body.setVelocity(body, {
    x: body.velocity.x + P * body.inverseMass * tx,
    y: body.velocity.y + P * body.inverseMass * ty,
  });
  if (
    rCrossT != null
    && body.inverseInertia > 1e-18
    && isFinite(body.inertia)
    && !body._lockRotation
  ) {
    Body.setAngularVelocity(
      body,
      (body.angularVelocity || 0) + rCrossT * P * body.inverseInertia,
    );
  }
}

/**
 * Post-collision Coulomb friction (call from engine `afterUpdate`).
 * @param {import('matter-js').Body[]} bodies
 * @param {{ x:number, y:number, scale:number }} gravity
 * @returns {boolean} whether any frictional impulse / stick was applied
 */
export function applyCoulombFriction(bodies, gravity) {
  const gx = gravity?.x ?? 0;
  const gy = gravity?.y ?? 0;
  const gMag = Math.hypot(gx, gy);
  const gScale = gravity?.scale ?? 0;
  if (gMag < 1e-15 || Math.abs(gScale) < 1e-18) return false;

  const gnx = gx / gMag;
  const gny = gy / gMag;

  const list = bodies.filter(b => b._newtonType !== 'metric-basis');
  const n = list.length;
  let applied = false;

  for (let i = 0; i < n; i++) {
    list[i]._fricRestHold = false;
    list[i]._fricRestOther = null;
    list[i]._fricLastP = 0;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = list[i];
      const B = list[j];
      if (A.isStatic && B.isStatic) continue;
      // Kinematic rope nodes (pinned / two-host chord): do not friction the host.
      if ((A._ropeSegment && A.collisionFilter?.mask === 0)
        || (B._ropeSegment && B.collisionFilter?.mask === 0)) continue;

      const dyn = A.isStatic ? B : A;
      const other = dyn === A ? B : A;
      if (dyn.isStatic) continue;

      const rolling = canRoll(dyn);
      const geo = rolling ? circleContact(dyn, other) : null;
      const col = geo ? null : Collision.collides(A, B);
      if (geo) {
        if (!(geo.depth > -SOLID_CONTACT_DEPTH_PX)) continue;
      } else {
        if (!col || !(col.depth > MIN_CONTACT_DEPTH_PX)) continue;
        if (!col.normal) continue;
      }

      const frame = geo
        ? { nx: geo.nx, ny: geo.ny, tx: geo.tx, ty: geo.ty }
        : contactFrame(col.normal, gnx, gny);
      if (!frame) continue;
      const { nx, ny, tx, ty } = frame;

      const vOtherN = other.isStatic
        ? 0
        : other.velocity.x * nx + other.velocity.y * ny;
      const vSep = dyn.velocity.x * nx + dyn.velocity.y * ny - vOtherN;
      const vOtherT = other.isStatic
        ? 0
        : other.velocity.x * tx + other.velocity.y * ty;
      const vTan = dyn.velocity.x * tx + dyn.velocity.y * ty - vOtherT;
      const contactDepth = geo ? geo.depth : col.depth;

      if (vSep > LAUNCH_VN_MATTER) continue;
      if (
        vSep > SEPARATING_VN_MATTER
        && contactDepth < SOLID_CONTACT_DEPTH_PX
        && Math.abs(vTan) > REST_SLIP_NOISE * 50
      ) continue;

      const muKa = dyn._muK ?? dyn.friction ?? 0;
      const muKb = other._muK ?? other.friction ?? 0;
      const muSa = dyn._muS ?? dyn.frictionStatic ?? muKa;
      const muSb = other._muS ?? other.frictionStatic ?? muKb;
      const muK = geomMeanMu(muKa, muKb);
      const muS = geomMeanMu(muSa, muSb);
      if (muK < 1e-12 && muS < 1e-12) continue;

      const cos = Math.abs(nx * gnx + ny * gny);
      const W_m = dyn.mass * gMag * gScale;
      const { fx: Fapp_x, fy: Fapp_y } = appliedForceMatterComponents(dyn);
      const Fapp_n = Fapp_x * nx + Fapp_y * ny;
      const Fapp_t = Fapp_x * tx + Fapp_y * ty;
      const N_m = Math.max(0, W_m * Math.min(1, cos) - Fapp_n);
      if (N_m < 1e-18) continue;

      const pt = geo
        ? { x: geo.px, y: geo.py }
        : frictionPoint(col, dyn, nx, ny);
      const ox = pt.x - dyn.position.x;
      const oy = pt.y - dyn.position.y;

      const vd = velocityAtPoint(dyn, pt.x, pt.y);
      const voPt = other.isStatic
        ? { vx: 0, vy: 0 }
        : velocityAtPoint(other, pt.x, pt.y);
      const vContactSlip = (vd.vx - voPt.vx) * tx + (vd.vy - voPt.vy) * ty;

      const vOtherCom = other.isStatic ? 0 : (
        other.velocity.x * tx + other.velocity.y * ty
      );
      const vComSlip = dyn.velocity.x * tx + dyn.velocity.y * ty - vOtherCom;

      const Fg_t = dyn.mass * gScale * (gx * tx + gy * ty);
      const F_load_t = Fg_t + Fapp_t;
      // Velocity-impulse caps: P = F · Δt² matches Matter’s Verlet force scale.
      const maxStaticP = muS * N_m * DT2;
      const maxKineticP = muK * N_m * DT2;

      const rCrossT = ox * ty - oy * tx;

      let P = 0;
      let canStatic = false;

      if (rolling) {
        const K = dyn.inverseMass + rCrossT * rCrossT * dyn.inverseInertia;
        if (!(K > 1e-18)) continue;

        // After integrate+collide, kill contact slip in one impulse (rolling).
        const P_grip = -vContactSlip / K;
        // Impulse that maintains rolling against tangential load alone (μ test).
        // Solver noise in v_slip is corrected whenever |P_hold| fits in μₛ N :
        // otherwise Matter’s normal contacts continually break rolling.
        const P_hold = -(F_load_t * DT2) / K;
        const restSlip = staticRestSlipMatter(maxStaticP, P_hold, K);

        const slipAbs = Math.abs(vContactSlip);
        let mode = dyn._fricRollMode === 'kinetic' ? 'kinetic' : 'static';
        if (mode === 'kinetic') {
          if (Math.abs(P_hold) <= maxStaticP && slipAbs < Math.max(restSlip * 4, 0.02)) {
            mode = 'static';
          }
        } else if (Math.abs(P_hold) > maxStaticP) {
          mode = 'kinetic';
        }
        dyn._fricRollMode = mode;
        canStatic = mode === 'static';

        if (canStatic) {
          // Enforce pure rolling (correct collision-injected slip in full).
          P = P_grip;
          dyn._fricKinSign = 0;
        } else {
          let s = dyn._fricKinSign || 0;
          const sHint = Math.sign(vComSlip) || Math.sign(F_load_t) || Math.sign(vContactSlip);
          if (s === 0) {
            s = sHint || 1;
          } else if (
            sHint !== 0
            && sHint !== s
            && Math.abs(vComSlip) > Math.max(restSlip * 8, REST_SLIP_NOISE)
            && Math.sign(vComSlip) === sHint
          ) {
            s = sHint;
          }
          dyn._fricKinSign = s;
          P = -s * maxKineticP;
          if (s > 0) P = Math.max(P, P_grip);
          else P = Math.min(P, P_grip);
        }

        if (isFinite(P) && Math.abs(P) > 1e-18) {
          applyTangentImpulse(dyn, tx, ty, P, rCrossT);
          if (!other.isStatic) {
            const oxO = pt.x - other.position.x;
            const oyO = pt.y - other.position.y;
            const rCrossTO = oxO * ty - oyO * tx;
            applyTangentImpulse(other, tx, ty, -P, canRoll(other) ? rCrossTO : null);
          }
          dyn._fricLastP = P;
          applied = true;
        }
      } else {
        // Slide / stick through COM: no friction torque (boxes must not “roll”).
        const slipAbs = Math.abs(vComSlip);
        const P_hold = -F_load_t * DT2;
        const P_grip = -vComSlip * dyn.mass; // = -vComSlip / invMass
        const restSlip = staticRestSlipMatter(maxStaticP, P_hold, dyn.inverseMass);
        const canHoldLoad = Math.abs(P_hold) <= maxStaticP + 1e-15;

        let mode = dyn._fricSlideMode === 'kinetic' ? 'kinetic' : 'static';
        if (mode === 'kinetic') {
          if (canHoldLoad && slipAbs <= restSlip) mode = 'static';
        } else if (!canHoldLoad) {
          mode = 'kinetic';
        } else if (slipAbs > restSlip * 2.5 && Math.abs(P_grip) > maxStaticP) {
          mode = 'kinetic';
        }
        dyn._fricSlideMode = mode;
        canStatic = mode === 'static';

        if (canStatic && canHoldLoad) {
          clearTangentialVelocity(dyn, nx, ny);
          dyn._fricRestHold = true;
          dyn._fricRestNx = nx;
          dyn._fricRestNy = ny;
          dyn._fricRestOther = other;
          dyn._fricLastP = P_hold;
          P = 0;
          applied = true;
        } else if (canStatic) {
          P = P_grip;
          if (Math.abs(P) > maxStaticP) P = Math.sign(P) * maxStaticP;
        } else {
          let s = Math.sign(vComSlip) || Math.sign(vContactSlip) || Math.sign(F_load_t);
          if (s === 0) s = Math.sign(P_grip);
          if (s === 0) continue;
          P = -s * maxKineticP;
          if (vComSlip > 0) P = Math.max(P, P_grip);
          else if (vComSlip < 0) P = Math.min(P, P_grip);
        }

        if (isFinite(P) && Math.abs(P) > 1e-18) {
          applyTangentImpulse(dyn, tx, ty, P, null);
          if (!other.isStatic) {
            applyTangentImpulse(other, tx, ty, -P, null);
          }
          dyn._fricLastP = P;
          applied = true;
        }

        if (isPolygonal(dyn) && faceAlignedToTangent(dyn.angle, tx, ty, 0.035)) {
          const snapped = snapAngleToFace(dyn.angle, tx, ty);
          if (Math.abs(snapped - dyn.angle) > 1e-6) {
            Body.setAngle(dyn, snapped);
          }
          if (Math.abs(dyn.angularVelocity) > 1e-8) {
            Body.setAngularVelocity(dyn, 0);
            applied = true;
          }
        }
      }
    }
  }
  return applied;
}

/**
 * Keep only the contact-normal velocity, clear in-plane (friction) slip.
 * Friction must never cancel motion off the surface.
 */
function clearTangentialVelocity(body, nx, ny) {
  const vn = body.velocity.x * nx + body.velocity.y * ny;
  Body.setVelocity(body, { x: vn * nx, y: vn * ny });
}

/**
 * After Matter’s collision pass, clear leftover *tangential* slip only if the
 * body is still overlapping its rest-hold partner (not mid-air after launch).
 */
export function snapStaticFrictionRest(bodies) {
  for (const b of bodies) {
    if (!b || !b._fricRestHold || b.isStatic) continue;
    const other = b._fricRestOther;
    const nx = b._fricRestNx;
    const ny = b._fricRestNy;
    if (!other || nx == null || ny == null) {
      b._fricRestHold = false;
      continue;
    }

    const col = Collision.collides(b, other);
    if (!col || !(col.depth > MIN_CONTACT_DEPTH_PX)) {
      b._fricRestHold = false;
      b._fricRestOther = null;
      continue;
    }

    const vOtherN = other.isStatic
      ? 0
      : other.velocity.x * nx + other.velocity.y * ny;
    const vSep = b.velocity.x * nx + b.velocity.y * ny - vOtherN;
    if (vSep > LAUNCH_VN_MATTER) {
      b._fricRestHold = false;
      b._fricRestOther = null;
      continue;
    }

    clearTangentialVelocity(b, nx, ny);
  }
}

/** True when a box edge is nearly parallel to the contact tangent (face contact). */
function faceAlignedToTangent(angle, tx, ty, tolRad) {
  const edge = Math.atan2(ty, tx);
  let a = angle - edge;
  a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  return Math.min(a, Math.PI / 2 - a) < tolRad;
}

function snapAngleToFace(angle, tx, ty) {
  const edge = Math.atan2(ty, tx);
  let best = angle;
  let bestD = Infinity;
  for (let k = -8; k <= 8; k++) {
    const cand = edge + k * (Math.PI / 2);
    const d = Math.abs(cand - angle);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best;
}
