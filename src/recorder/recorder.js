/**
 * Recorder: captures per-frame snapshots of the physics world state.
 *
 * Each frame snapshot stores:
 *   - simTime (s)
 *   - per-body: id, type, pose, velocity, geometry (enough to rebuild on scrub)
 *   - per-constraint: id, type, body ids, local anchors, world endpoints
 */

export class Recorder {
  constructor() {
    this._frames  = [];
    this._active  = false;
    this._startTime = null;
  }

  get isRecording() { return this._active; }
  get frameCount()  { return this._frames.length; }
  get frames()      { return this._frames; }

  /** Begin (or continue) recording: does NOT clear existing frames. */
  start() {
    this._active = true;
  }

  stop() { this._active = false; }

  /** Discard all recorded frames and reset the time reference. */
  clear() {
    this._frames    = [];
    this._startTime = null;
  }

  /**
   * Called each physics step.
   * @param {number} simTime - accumulated simulation time (s)
   * @param {Body[]} bodies
   * @param {Constraint[]} constraints
   */
  capture(simTime, bodies, constraints) {
    if (!this._active) return;
    if (this._startTime === null) this._startTime = simTime;

    const t = simTime - this._startTime;

    const bodiesSnap = bodies.map(b => this._snapBody(b));
    const constraintsSnap = constraints.map(c => this._snapConstraint(c));

    this._frames.push({ t, bodies: bodiesSnap, constraints: constraintsSnap });
  }

  _snapBody(b) {
    const snap = {
      id:    b.id,
      type:  b._newtonType ?? 'generic',
      label: b.label || null,
      x:     b.position.x,
      y:     b.position.y,
      angle: b.angle,
      vx:    b.velocity.x,
      vy:    b.velocity.y,
      w:     Number.isFinite(b.angularVelocity) ? b.angularVelocity : 0,
      mass:     b.mass,
      radius:   b._radius ?? b.circleRadius ?? null,
      hollow:   b._hollow === true,
      baseWidth: b._baseWidth ?? null,
      footAngle: b._footAngle ?? null,
      bWidth:   b._width ?? b._baseWidth ?? null,
      bHeight:  b._height ?? null,
      isStatic: !!b.isStatic,
      restitution: b.restitution,
      muK: b._muK ?? b.friction ?? null,
      muS: b._muS ?? b.frictionStatic ?? null,
      frictionAir: b.frictionAir ?? null,
      stickOnContact: !!b._stickOnContact,
      lockRotation: !!b._lockRotation,
      weldParts: null,
    };

    if (b._newtonType === 'compound' && b.parts?.length > 1) {
      snap.weldParts = this._snapWeldParts(b);
    }
    return snap;
  }

  _snapWeldParts(body) {
    const cos = Math.cos(-body.angle);
    const sin = Math.sin(-body.angle);
    const sub = body.parts.slice(1);
    return sub.map((p, i) => {
      const meta = body._weldParts?.[i] ?? {};
      const dx = p.position.x - body.position.x;
      const dy = p.position.y - body.position.y;
      return {
        type: meta.type ?? (p.circleRadius ? 'point-mass' : 'box'),
        width: meta.width ?? (p.bounds.max.x - p.bounds.min.x),
        height: meta.height ?? (p.bounds.max.y - p.bounds.min.y),
        radius: meta.radius ?? p.circleRadius ?? p._radius ?? null,
        hollow: meta.hollow === true,
        mass: p.mass > 0 ? p.mass : body.mass / sub.length,
        stickOnContact: meta.stickOnContact === true,
        label: meta.label ?? null,
        sourceId: meta.sourceId ?? null,
        lx: dx * cos - dy * sin,
        ly: dx * sin + dy * cos,
        la: p.angle - body.angle,
      };
    });
  }

  _snapConstraint(c) {
    const pA = this._constraintPt(c, 'A');
    const pB = this._constraintPt(c, 'B');
    return {
      id:      c.id,
      type:    c._newtonType ?? 'string',
      bodyAId: c.bodyA?.id ?? null,
      bodyBId: c.bodyB?.id ?? null,
      pointA:  c.pointA ? { x: c.pointA.x, y: c.pointA.y } : { x: 0, y: 0 },
      pointB:  c.pointB ? { x: c.pointB.x, y: c.pointB.y } : { x: 0, y: 0 },
      ax:      pA.x, ay: pA.y,
      bx:      pB.x, by: pB.y,
      restLen: c.length,
    };
  }

  _constraintPt(c, which) {
    const body  = which === 'A' ? c.bodyA : c.bodyB;
    const local = which === 'A' ? c.pointA : c.pointB;
    if (body) {
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      return {
        x: body.position.x + cos * local.x - sin * local.y,
        y: body.position.y + sin * local.x + cos * local.y,
      };
    }
    return local ?? { x: 0, y: 0 };
  }
}
