import Matter from 'matter-js';
import { BASE_DELTA_MS, METRIC_BASIS_DEFAULT_M, mToPx } from '../units.js';
import { createMetricBasis } from './bodies.js';
import { SpringConstraint, RodConstraint, syncMatterConstraintPoints } from './constraints.js';
import { applyCoulombFriction, snapStaticFrictionRest } from './friction.js';
import {
  appliedForceToMatter,
  getAppliedForce,
  isDrivenAppliedForce,
  solveDrivenAppliedForces,
} from './applied-force.js';
import { appliedTorqueToMatter, getAppliedTorque } from './applied-torque.js';
import { solveDrivenPivots, resetDrivenVisualAngles } from './driven-pivot.js';
import { ccdStepFraction } from './ccd.js';
import { installStickyCollisions } from './sticky.js';
import { installRoundContactSolver } from './circle-contact.js';
import { solveRopeConstraints, ROPE_PBD_POLISH, clearRopeAttachmentsToBody, retargetRopeHosts } from './rope.js';
import { installConstraintLinkCollisionFilter } from './layout-anchors.js';
import {
  mechanicalEnergy,
  restoreMechanicalEnergy,
  hasNonConservativeDrive,
  hasInelasticContact,
} from './energy.js';

const { Engine, World, Body, Composite, Events, Resolver } = Matter;

installRoundContactSolver();

// ── Physics accuracy settings ─────────────────────────────────────
//
// _restingThresh: closing speed (px/step) below which Matter switches to
//   its "resting contact" branch (Catto GDC08).  That branch stabilises
//   stacked objects but dissipates energy.  We push the threshold to near-
//   zero so essentially all contacts use the elastic impulse path.
Resolver._restingThresh = 0.001;

// Default _restingThreshTangent is sqrt(6) (same units as position −
// positionPrev per step).  Too small a value lets the solver switch to the
// “resting tangent” branch mid-impact (after slip is partially resolved), which
// can zero horizontal speed in one frame even with low μ.  Keep this low enough
// that true micro-slip still uses the resting model, but above numerical noise
// at SIM_HZ ≈ 960 so glancing / sliding impacts stay in the kinetic-tangent path.
Resolver._restingThreshTangent = 0.022;

// Fixed timestep BASE_DELTA_MS (see units.SIM_HZ). Engine.update always
// receives this nominal delta with timeScale = 1.
//
// The RAF loop accumulates wall-clock time and takes only whole substeps
// (classic fixed-step accumulator). Variable timeScale-per-frame used to
// “catch up” exactly each refresh caused Verlet / constraint energy drift
// that depended on display Hz.
//
// After each conservative step we also project mechanical energy back to a
// captured target so residual Gauss-Seidel / Verlet bleed does not damp
// pendulums and frictionless oscillators. Intentional dissipation (friction,
// air, inelastic contacts, applied drives) updates the target instead.

/** Max physics catch-up per frame (avoids spiral-of-death after a stall). */
const MAX_SUBSTEPS_PER_FRAME = 64;

export class PhysicsEngine {
  constructor() {
    this.engine = Engine.create({
      gravity: { x: 0, y: 1, scale: 0.001 },
      positionIterations: 12,
      velocityIterations: 10,
      // Higher constraint iterations keep the rod effectively rigid so the
      // pendulum doesn't bleed energy through residual constraint stretch.
      constraintIterations: 10,
    });
    this.world  = this.engine.world;
    this._constraints = [];
    this._running  = false;
    this._speed    = 1;
    this._lastTime = null;
    this._accumulator = 0;
    this._rafId    = null;
    this._onStepCbs = [];
    this._onWeldCbs = [];
    this._simTime  = 0;
    /** True only while inside a deliberate Engine.update (play / step). */
    this._integrating = false;
    /** Hold mechanical energy when no intentional dissipation is active. */
    this._conserveEnergy = true;
    this._energyTarget = null;
    this._stepDissipated = false;

    Events.on(this.engine, 'beforeUpdate', () => {
      this._tuneConstraintIterations();
      this._syncStaticConstraintPoints();
      this._solveSprings();
      this._solveAppliedForces();
      this._solveDrivenAppliedForces();
      this._solveAppliedTorques();
      this._solveDrivenPivots();
    });
    Events.on(this.engine, 'afterUpdate', () => {
      if (!this._integrating) return;
      // Inextensible rope after collisions, then friction, then a short polish.
      solveRopeConstraints(this._constraints, { engine: this });
      this._solveFriction();
      snapStaticFrictionRest(this.bodies);
      solveRopeConstraints(this._constraints, { iterations: ROPE_PBD_POLISH, engine: this });
    });

    installStickyCollisions(this);
    installConstraintLinkCollisionFilter(this);

    // Always start with a metric basis so the sandbox never boots empty.
    World.add(
      this.world,
      createMetricBasis(mToPx(METRIC_BASIS_DEFAULT_M.xm), mToPx(METRIC_BASIS_DEFAULT_M.ym)),
    );
  }

  /** Extra Matter constraint iterations only for non-rope rods/strings. */
  _tuneConstraintIterations() {
    let other = 0;
    for (const c of this._constraints) {
      if (c._ropeLink || c instanceof SpringConstraint) continue;
      other++;
    }
    this.engine.constraintIterations = other > 0 ? 12 : 10;
  }

  /**
   * Keep Matter static-end offsets aligned with body-local attach points
   * (ground / anchored bodies may move in setup without recreating the link).
   */
  _syncStaticConstraintPoints() {
    for (const c of this._constraints) {
      if (c._ropeLink || c instanceof SpringConstraint) continue;
      const aStatic = !c.bodyA || c.bodyA.isStatic;
      const bStatic = !c.bodyB || c.bodyB.isStatic;
      if (!aStatic && !bStatic) continue;
      syncMatterConstraintPoints(c);
    }
  }

  /**
   * Keep Matter static-end offsets in sync with body-local anchors (angled ground,
   * dragged slabs). Dynamic ends stay body-local; Matter rotates those itself.
   */
  _syncStaticConstraintPoints() {
    for (const c of this._constraints) {
      if (c._ropeLink || c instanceof SpringConstraint) continue;
      syncMatterConstraintPoints(c);
    }
  }

  /** Apply Hooke's-law forces for all spring constraints (not Matter rigid links). */
  _solveSprings() {
    // Never apply spring forces outside of a real physics step (e.g. setup drags).
    if (!this._integrating) return;
    for (const c of this._constraints) {
      if (c instanceof SpringConstraint) c.applyForces();
    }
  }

  /** Constant applied pulls (F, θ): see {@link applied-force.js}. */
  _solveAppliedForces() {
    if (!this._integrating) return;
    for (const b of this.bodies) {
      if (!b || b.isStatic) continue;
      // Driven F(t) replaces constant F while active.
      if (isDrivenAppliedForce(b)) continue;
      const af = getAppliedForce(b);
      if (!af) continue;
      const { fx, fy } = appliedForceToMatter(af.F, af.thetaDeg);
      if (Math.abs(fx) < 1e-18 && Math.abs(fy) < 1e-18) continue;
      Body.applyForce(b, b.position, { x: fx, y: fy });
    }
  }

  /** Time-varying applied F(t): see {@link applied-force.js}. */
  _solveDrivenAppliedForces() {
    if (!this._integrating) return;
    if (solveDrivenAppliedForces(this)) this.noteEnergyDissipation();
  }

  /** Constant applied torque τ: see {@link applied-torque.js}. */
  _solveAppliedTorques() {
    if (!this._integrating) return;
    for (const b of this.bodies) {
      if (!b || b.isStatic) continue;
      if (b.inertia === Infinity) continue;
      const tau = getAppliedTorque(b);
      if (tau == null) continue;
      const tMat = appliedTorqueToMatter(tau);
      if (Math.abs(tMat) < 1e-18) continue;
      b.torque += tMat;
    }
  }

  /** Time-varying pivot drive τ(t): see {@link driven-pivot.js}. */
  _solveDrivenPivots() {
    if (!this._integrating) return;
    if (solveDrivenPivots(this)) this.noteEnergyDissipation();
  }

  /** Textbook Coulomb friction (see {@link applyCoulombFriction}). */
  _solveFriction() {
    if (!this._integrating) return;
    if (applyCoulombFriction(this.bodies, this.engine.gravity, this._constraints)) {
      this.noteEnergyDissipation();
    }
  }

  /**
   * Mark that this physics step changed energy by design (friction, air,
   * inelastic contact, weld). The energy target is recaptured afterward.
   */
  noteEnergyDissipation() {
    this._stepDissipated = true;
  }

  /** Drop the energy anchor so the next conservative step re-samples E. */
  invalidateEnergyTarget() {
    this._energyTarget = null;
  }

  setConserveEnergy(on) {
    this._conserveEnergy = !!on;
    if (!on) this._energyTarget = null;
  }

  getConserveEnergy() {
    return this._conserveEnergy;
  }

  get simTime() { return this._simTime; }
  get running()  { return this._running; }
  get gravity()  { return this.engine.gravity; }

  setGravity(gx, gy) {
    this.engine.gravity.x = gx;
    this.engine.gravity.y = gy;
    this.invalidateEnergyTarget();
  }

  setSpeed(s) { this._speed = Math.max(0.01, s); }

  addBody(body)       {
    World.add(this.world, body);
    this.invalidateEnergyTarget();
  }
  removeBody(body)    {
    if (body && body._newtonType === 'metric-basis') return;
    clearRopeAttachmentsToBody(this, body);
    for (const c of [...this._constraints]) {
      if (c.bodyA === body || c.bodyB === body
        || c.bodyA?.id === body.id || c.bodyB?.id === body.id) {
        this.removeConstraint(c);
      }
    }
    World.remove(this.world, body);
    this.invalidateEnergyTarget();
  }
  addConstraint(c) {
    this._constraints.push(c);
    this.invalidateEnergyTarget();
    if (c instanceof SpringConstraint) return;
    if (c instanceof RodConstraint) {
      c.attachEngine(this);
      return;
    }
    // Legacy Matter constraint (e.g. string)
    World.add(this.world, c);
  }

  removeConstraint(c) {
    const i = this._constraints.indexOf(c);
    if (i >= 0) this._constraints.splice(i, 1);
    this.invalidateEnergyTarget();
    if (c instanceof SpringConstraint) return;
    if (c instanceof RodConstraint) {
      c.detachEngine(this);
      return;
    }
    World.remove(this.world, c);
  }

  get bodies()      { return Composite.allBodies(this.world); }
  get constraints() { return this._constraints; }

  onStep(cb) { this._onStepCbs.push(cb); }

  /**
   * Fired after sticky bodies weld into a compound group.
   * @param {(compound: import('matter-js').Body, removedIds: number[]) => void} cb
   */
  onWeld(cb) { this._onWeldCbs.push(cb); }

  /** @param {import('matter-js').Body} compound @param {number[]} removedIds */
  _emitWeld(compound, removedIds) {
    this.noteEnergyDissipation();
    retargetRopeHosts(this, removedIds, compound);
    for (const cb of this._onWeldCbs) cb(compound, removedIds);
  }

  play() {
    if (this._running) return;
    this._running  = true;
    this._lastTime = null;
    this._accumulator = 0;
    this.invalidateEnergyTarget();
    this._rafId    = requestAnimationFrame(this._loop.bind(this));
  }

  pause() {
    this._running = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._lastTime = null;
    this._accumulator = 0;
    this._clearAccumulatedForces();
  }

  /** Drop leftover applyForce accumulators so paused setup won't "kick" on next play. */
  _clearAccumulatedForces() {
    for (const b of this.bodies) {
      b.force.x = 0;
      b.force.y = 0;
      b.torque = 0;
    }
  }

  /** Advance exactly one fixed timestep (1 / SIM_HZ s) regardless of play state. */
  step() {
    this.engine.timing.timeScale = 1;
    this._ccdStep(BASE_DELTA_MS);
    this._simTime += BASE_DELTA_MS / 1000;
    this._onStepCbs.forEach(cb => cb(this._simTime));
  }

  /** Zero accumulated simulation time without clearing the world. */
  resetSimTime() {
    this._simTime = 0;
    resetDrivenVisualAngles(this);
  }

  reset() {
    this.pause();
    this._simTime = 0;
    this._energyTarget = null;
    for (const c of this._constraints) {
      if (c instanceof RodConstraint) c.detachEngine(this);
      else if (!(c instanceof SpringConstraint)) World.remove(this.world, c);
    }
    this._constraints = [];
    World.clear(this.world, false);
    Engine.clear(this.engine);
    this.engine.gravity.x = 0;
    this.engine.gravity.y = 1;
    this.engine.gravity.scale = 0.001;
    this.engine.timing.timeScale = 1;
    World.add(
      this.world,
      createMetricBasis(mToPx(METRIC_BASIS_DEFAULT_M.xm), mToPx(METRIC_BASIS_DEFAULT_M.ym)),
    );
  }

  /**
   * CCD-aware step.  Finds the earliest fractional time t at which any
   * dynamic circle would first contact a static body this step.  If t < 1,
   * splits the step into two Engine.update calls so the collision impulse is
   * applied at the exact contact instant: fixing systematic energy loss that
   * occurs when bounces happen mid-frame (see ccd.js for full explanation).
   * Total simulated time is always exactly dt (timeScale stays 1).
   */
  _ccdStep(dt) {
    this._integrating = true;
    this._stepDissipated = false;
    // Anchor energy to the pre-step state the first time after invalidate/play.
    if (
      this._conserveEnergy
      && this._energyTarget == null
      && !hasNonConservativeDrive(this)
    ) {
      const E0 = mechanicalEnergy(this);
      if (isFinite(E0)) this._energyTarget = E0;
    }
    try {
      const t = ccdStepFraction(Composite.allBodies(this.world), this._constraints);
      if (t < 1 - 1e-4) {
        Engine.update(this.engine, t * dt);
        Engine.update(this.engine, (1 - t) * dt);
      } else {
        Engine.update(this.engine, dt);
      }
    } finally {
      this._integrating = false;
    }
    this._stabilizeEnergy();
  }

  /**
   * After a fixed step: if the scene is conservative, hold mechanical energy
   * at the captured target, otherwise adopt the post-step energy as the new
   * target (friction, air, inelastic hits, applied drives, etc.).
   */
  _stabilizeEnergy() {
    if (!this._conserveEnergy) return;

    if (hasNonConservativeDrive(this)) {
      this._energyTarget = null;
      return;
    }

    if (hasInelasticContact(this)) {
      this.noteEnergyDissipation();
    }

    const E = mechanicalEnergy(this);
    if (!isFinite(E)) return;

    if (this._stepDissipated || this._energyTarget == null) {
      this._energyTarget = E;
      return;
    }

    restoreMechanicalEnergy(this, this._energyTarget);
  }

  _loop(timestamp) {
    if (!this._running) return;
    if (this._lastTime !== null) {
      const wallMs = Math.min(Math.max(timestamp - this._lastTime, 0), 80);
      this._accumulator += wallMs * this._speed;

      const maxAcc = BASE_DELTA_MS * MAX_SUBSTEPS_PER_FRAME;
      if (this._accumulator > maxAcc) this._accumulator = maxAcc;

      this.engine.timing.timeScale = 1;
      let stepped = false;
      while (this._accumulator >= BASE_DELTA_MS) {
        this._ccdStep(BASE_DELTA_MS);
        this._simTime += BASE_DELTA_MS / 1000;
        this._accumulator -= BASE_DELTA_MS;
        stepped = true;
      }
      if (stepped) this._onStepCbs.forEach(cb => cb(this._simTime));
    }
    this._lastTime = timestamp;
    this._rafId    = requestAnimationFrame(this._loop.bind(this));
  }
}
