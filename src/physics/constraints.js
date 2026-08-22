/**
 * Newton link constraints: separate from Matter.js rigid distance constraints.
 *
 * RodConstraint  : fixed separation via Matter (stiffness = 1).
 * SpringConstraint: Hooke's law only (F = −k Δx), never enters Matter's solver.
 * Viscous damper c is omitted: use contact friction and air drag for dissipation.
 */

import Matter from 'matter-js';
import { PX_PER_M } from '../units.js';

const { Constraint, World, Body, Common } = Matter;

let _labelCounter = 0;
const nextLabel = (prefix) => `${prefix}_${++_labelCounter}`;

/** World position of an attachment point (body-local or fixed world point). */
export function constraintAnchorWorld(c, which) {
  const body = which === 'A' ? c.bodyA : c.bodyB;
  const local = which === 'A' ? c.pointA : c.pointB;
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
    const pointA = { ...(opts.pointA ?? { x: 0, y: 0 }) };
    const pointB = { ...(opts.pointB ?? { x: 0, y: 0 }) };
    const length = opts.length ?? separationPx(bodyA, bodyB, pointA, pointB);

    this._matter = Constraint.create({
      bodyA,
      bodyB,
      pointA,
      pointB,
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
  set bodyA(v) { this._matter.bodyA = v; }
  get bodyB() { return this._matter.bodyB; }
  set bodyB(v) { this._matter.bodyB = v; }

  get pointA() { return this._matter.pointA; }
  set pointA(v) { this._matter.pointA = v; }
  get pointB() { return this._matter.pointB; }
  set pointB(v) { this._matter.pointB = v; }

  /** Fixed link length (px): enforced rigidly each step. */
  get length() { return this._matter.length; }
  set length(v) { this._matter.length = v; }

  get stiffness() { return this._matter.stiffness; }
  get damping() { return this._matter.damping; }
  get angleA() { return this._matter.angleA; }
  set angleA(v) { this._matter.angleA = v; }
  get angleB() { return this._matter.angleB; }
  set angleB(v) { this._matter.angleB = v; }

  /** @param {import('./engine.js').PhysicsEngine} engine */
  attachEngine(engine) {
    // Rope links are projected with PBD (see rope.js): Matter's Gauss-Seidel
    // distance constraints stretch and blow up long chains under gravity.
    if (this._ropeLink) return;
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
