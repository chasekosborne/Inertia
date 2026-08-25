/**
 * Newton link constraints: separate from Matter.js rigid distance constraints.
 *
 * RodConstraint  : fixed separation via Matter (stiffness = 1).
 * SpringConstraint: Hooke's law only (F = −k Δx), never enters Matter's solver.
 * Viscous damper c is omitted: use contact friction and air drag for dissipation.
 *
 * Matter quirk: for *static* bodies, Constraint.solve treats pointA/pointB as
 * world-space offsets from body.position (no rotation by body.angle). Dynamic
 * bodies keep body-local points (Matter rotates them in place as angle changes).
 * Our public API always uses body-local offsets; RodConstraint / strings sync
 * the Matter representation via {@link matterPointFromLocal}.
 */

import Matter from 'matter-js';
import { PX_PER_M } from '../units.js';

const { Constraint, World, Body, Common } = Matter;

let _labelCounter = 0;
const nextLabel = (prefix) => `${prefix}_${++_labelCounter}`;

/**
 * Body-local → Matter constraint point.
 * Static bodies: rotate into a world-space offset (Matter does not apply angle).
 * Dynamic / null: leave as body-local (or absolute world point when body is null).
 *
 * @param {import('matter-js').Body|null|undefined} body
 * @param {{ x: number, y: number }} local
 */
export function matterPointFromLocal(body, local) {
  const p = { x: local?.x ?? 0, y: local?.y ?? 0 };
  if (!body || !body.isStatic) return p;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}

/**
 * Body-local attachment stored on a constraint (Rod / Spring / string).
 * @param {object} c
 * @param {'A'|'B'} which
 */
export function constraintLocalPoint(c, which) {
  if (which === 'A') {
    if (c._localA) return c._localA;
    if (c._pointALocal) return c._pointALocal;
    return c.pointA ?? { x: 0, y: 0 };
  }
  if (c._localB) return c._localB;
  if (c._pointBLocal) return c._pointBLocal;
  return c.pointB ?? { x: 0, y: 0 };
}

/** World position of an attachment point (body-local or fixed world point). */
export function constraintAnchorWorld(c, which) {
  const body = which === 'A' ? c.bodyA : c.bodyB;
  const local = constraintLocalPoint(c, which);
  if (!body) return { x: local.x, y: local.y };
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  return {
    x: body.position.x + cos * local.x - sin * local.y,
    y: body.position.y + sin * local.x + cos * local.y,
  };
}

function separationPx(bodyA, bodyB, pointA, pointB) {
  const pA = bodyA
    ? constraintAnchorWorld({ bodyA, pointA }, 'A')
    : { x: pointA.x, y: pointA.y };
  const pB = bodyB
    ? constraintAnchorWorld({ bodyB, pointB }, 'B')
    : { x: pointB.x, y: pointB.y };
  return Math.hypot(pB.x - pA.x, pB.y - pA.y);
}

/**
 * Write body-local points onto a Matter (or Matter-backed) constraint, converting
 * static ends to Matter's world-offset form.
 * @param {object} c
 */
export function syncMatterConstraintPoints(c) {
  if (!c) return;
  if (typeof c._syncMatterPoints === 'function') {
    c._syncMatterPoints();
    return;
  }
  // Legacy Matter string: locals on _pointALocal / _pointBLocal when present.
  const localA = c._pointALocal ?? c.pointA ?? { x: 0, y: 0 };
  const localB = c._pointBLocal ?? c.pointB ?? { x: 0, y: 0 };
  if (!c._pointALocal) c._pointALocal = { x: localA.x, y: localA.y };
  if (!c._pointBLocal) c._pointBLocal = { x: localB.x, y: localB.y };
  c.pointA = matterPointFromLocal(c.bodyA, c._pointALocal);
  c.pointB = matterPointFromLocal(c.bodyB, c._pointBLocal);
}

/**
 * Rigid rod: enforces a fixed distance between attachment points.
 * Implemented as a fully stiff Matter.js distance constraint.
 */
export class RodConstraint {
  /**
   * @param {import('matter-js').Body|null} bodyA
   * @param {import('matter-js').Body} bodyB
   * @param {object} [opts]
   */
  constructor(bodyA, bodyB, opts = {}) {
    this._newtonType = 'rod';
    this._localA = { ...(opts.pointA ?? { x: 0, y: 0 }) };
    this._localB = { ...(opts.pointB ?? { x: 0, y: 0 }) };
    const length = opts.length ?? separationPx(bodyA, bodyB, this._localA, this._localB);

    this._matter = Constraint.create({
      bodyA,
      bodyB,
      pointA: matterPointFromLocal(bodyA, this._localA),
      pointB: matterPointFromLocal(bodyB, this._localB),
      length,
      stiffness: opts.stiffness ?? 1,
      damping: opts.damping ?? 0,
      label: opts.label ?? nextLabel('rod'),
    });
  }

  get id() { return this._matter.id; }
  get label() { return this._matter.label; }
  set label(v) { this._matter.label = v; }

  get bodyA() { return this._matter.bodyA; }
  set bodyA(v) {
    this._matter.bodyA = v;
    this._syncMatterPoints();
  }
  get bodyB() { return this._matter.bodyB; }
  set bodyB(v) {
    this._matter.bodyB = v;
    this._syncMatterPoints();
  }

  /** Body-local attach (public API / serialize). */
  get pointA() { return this._localA; }
  set pointA(v) {
    this._localA = { x: v?.x ?? 0, y: v?.y ?? 0 };
    this._syncMatterPoints();
  }
  get pointB() { return this._localB; }
  set pointB(v) {
    this._localB = { x: v?.x ?? 0, y: v?.y ?? 0 };
    this._syncMatterPoints();
  }

  /** Fixed link length (px): enforced rigidly each step. */
  get length() { return this._matter.length; }
  set length(v) { this._matter.length = v; }

  get stiffness() { return this._matter.stiffness; }
  get damping() { return this._matter.damping; }
  get angleA() { return this._matter.angleA; }
  set angleA(v) { this._matter.angleA = v; }
  get angleB() { return this._matter.angleB; }
  set angleB(v) { this._matter.angleB = v; }

  _syncMatterPoints() {
    this._matter.pointA = matterPointFromLocal(this._matter.bodyA, this._localA);
    this._matter.pointB = matterPointFromLocal(this._matter.bodyB, this._localB);
    if (this._matter.bodyA) this._matter.angleA = this._matter.bodyA.angle;
    if (this._matter.bodyB) this._matter.angleB = this._matter.bodyB.angle;
  }

  /** @param {import('./engine.js').PhysicsEngine} engine */
  attachEngine(engine) {
    // Rope links are projected with PBD (see rope.js): Matter's Gauss-Seidel
    // distance constraints stretch and blow up long chains under gravity.
    if (this._ropeLink) return;
    this._syncMatterPoints();
    World.add(engine.world, this._matter);
  }

  /** @param {import('./engine.js').PhysicsEngine} engine */
  detachEngine(engine) {
    World.remove(engine.world, this._matter);
  }
}

/**
 * Elastic spring: stores a natural rest length and applies
 * F = k·Δx along the axis (compression and extension). No viscous damper.
 * Not registered with Matter's constraint solver.
 */
export class SpringConstraint {
  /**
   * @param {import('matter-js').Body|null} bodyA
   * @param {import('matter-js').Body} bodyB
   * @param {object} [opts]
   * @param {number} [opts.length]  Rest length (px)
   * @param {number} [opts.kNm=40]  Spring constant (N/m)
   */
  constructor(bodyA, bodyB, opts = {}) {
    this._newtonType = 'spring';
    this.id = Common.nextId();
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.pointA = { ...(opts.pointA ?? { x: 0, y: 0 }) };
    this.pointB = { ...(opts.pointB ?? { x: 0, y: 0 }) };
    this.label = opts.label ?? nextLabel('spring');
    this._restLength = opts.length ?? separationPx(bodyA, bodyB, this.pointA, this.pointB);
    this._kNm = opts.kNm ?? 40;
    /** Max stretch beyond rest length (m), null = unlimited. */
    this._maxExtensionM = opts.maxExtensionM ?? null;
    /** Max compression below rest length (m), null = unlimited. */
    this._maxCompressionM = opts.maxCompressionM ?? null;
    this.angleA = bodyA?.angle ?? 0;
    this.angleB = bodyB?.angle ?? 0;
  }

  /** Natural length (px): zero force when current separation equals this. */
  get restLength() { return this._restLength; }
  set restLength(v) { this._restLength = v; }

  /** Alias for panels / history (`rest length (m)`). */
  get length() { return this._restLength; }
  set length(v) { this._restLength = v; }

  /** Apply Hooke's law (F = k Δx) for one fixed physics step. */
  applyForces() {
    const pA = this.bodyA
      ? constraintAnchorWorld(this, 'A')
      : { x: this.pointA.x, y: this.pointA.y };
    const pB = this.bodyB
      ? constraintAnchorWorld(this, 'B')
      : { x: this.pointB.x, y: this.pointB.y };

    const dx = pB.x - pA.x;
    const dy = pB.y - pA.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;

    const nx = dx / len;
    const ny = dy / len;

    // Positive extension = stretched, negative = compressed.
    let extM = (len - this._restLength) / PX_PER_M;
    if (this._maxExtensionM != null && extM > this._maxExtensionM) {
      extM = this._maxExtensionM;
    }
    if (this._maxCompressionM != null && extM < -this._maxCompressionM) {
      extM = -this._maxCompressionM;
    }

    const F_N = this._kNm * extM;
    const F_m = F_N * PX_PER_M / 1e6;

    if (this.bodyA && !this.bodyA.isStatic) {
      Body.applyForce(this.bodyA, pA, { x: F_m * nx, y: F_m * ny });
    }
    if (this.bodyB && !this.bodyB.isStatic) {
      Body.applyForce(this.bodyB, pB, { x: -F_m * nx, y: -F_m * ny });
    }
  }

  attachEngine(_engine) { /* force-only: not in Matter solver */ }
  detachEngine(_engine) { /* no-op */ }
}

/** @returns {RodConstraint} */
export function createRod(bodyA, bodyB, opts = {}) {
  return new RodConstraint(bodyA, bodyB, opts);
}

/** @returns {SpringConstraint} */
export function createSpring(bodyA, bodyB, opts = {}) {
  return new SpringConstraint(bodyA, bodyB, opts);
}

/** @param {unknown} c */
export function isSpringConstraint(c) {
  return c instanceof SpringConstraint;
}

/** @param {unknown} c */
export function isRodConstraint(c) {
  return c instanceof RodConstraint;
}
