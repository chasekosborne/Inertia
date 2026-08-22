/**
 * Sticky inelastic welds: on contact, sticky bodies fuse with other dynamic
 * (non-ground / non-anchor) bodies into one compound with a shared COM,
 * conserving linear and angular momentum.
 *
 * Deferred to afterUpdate so Matter’s world stays consistent mid-solve.
 */

import Matter from 'matter-js';
import { constraintAnchorWorld } from './constraints.js';
import { applyCircleInertia, isRoundBody, CIRCLE_HULL_SIDES } from './bodies.js';

const { Body, Bodies, Events } = Matter;

/**
 * @param {import('./engine.js').PhysicsEngine} physics
 */
export function installStickyCollisions(physics) {
  /** @type {{ a: import('matter-js').Body, b: import('matter-js').Body, snapA: object, snapB: object, extras: Map<number, object>, anchors: object[] }[]} */
  const pending = [];

  Events.on(physics.engine, 'collisionStart', event => {
    if (!physics._integrating) return;
    for (const pair of event.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      if (!_canWeld(a, b)) continue;

      const snapA = _snapshotBody(a);
      const snapB = _snapshotBody(b);
      if (!_snapshotOk(snapA) || !_snapshotOk(snapB)) continue;

      // Freeze constraint partners + world anchors before the solver can NaN them.
      const extras = new Map();
      /** @type {{ c: object, which: 'A'|'B', wx: number, wy: number }[]} */
      const anchors = [];
      for (const c of physics.constraints) {
        for (const which of /** @type {const} */ (['A', 'B'])) {
          const body = which === 'A' ? c.bodyA : c.bodyB;
          if (!body || (body !== a && body !== b)) continue;
          const wpt = constraintAnchorWorld(c, which);
          if (Number.isFinite(wpt.x) && Number.isFinite(wpt.y)) {
            anchors.push({ c, which, wx: wpt.x, wy: wpt.y });
          }
          const other = which === 'A' ? c.bodyB : c.bodyA;
          if (other && other !== a && other !== b && !other.isStatic && !extras.has(other.id)) {
            const s = _snapshotBody(other);
            if (_snapshotOk(s)) extras.set(other.id, { body: other, snap: s });
          }
        }
      }

      pending.push({ a, b, snapA, snapB, extras, anchors });
    }
  });

  Events.on(physics.engine, 'afterUpdate', () => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    const seen = new Set();
    for (const { a, b, snapA, snapB, extras } of batch) {
      if (seen.has(a.id) || seen.has(b.id)) continue;
      if (!physics.bodies.includes(a) || !physics.bodies.includes(b)) continue;

      // Restore rod partners corrupted mid-step, then fold the whole rod graph
      // into one rigid compound (massless rods become internal structure).
      for (const { body, snap } of extras.values()) {
        if (!physics.bodies.includes(body)) continue;
        if (!Number.isFinite(body.position.x) || !Number.isFinite(body.velocity.x)) {
          _restoreBody(body, snap);
        }
      }

      const snaps = new Map([
        [a.id, { body: a, snap: snapA }],
        [b.id, { body: b, snap: snapB }],
      ]);
      for (const [id, entry] of extras) snaps.set(id, entry);

      const group = _rodConnectedGroup(physics, [a, b]);
      for (const body of group) {
        if (snaps.has(body.id)) continue;
        const s = _snapshotBody(body);
        if (_snapshotOk(s)) snaps.set(body.id, { body, snap: s });
        else if (!Number.isFinite(body.position.x)) continue;
      }

      const members = [...snaps.values()].map(e => e.body).filter(b => physics.bodies.includes(b));
      if (members.length < 2) continue;
      for (const m of members) seen.add(m.id);

      const removedIds = members.map(m => m.id);
      const compound = _weldGroup(physics, [...snaps.values()]);
      if (compound) {
        seen.add(compound.id);
        physics._emitWeld?.(compound, removedIds);
      }
    }
  });
}

/** Bodies reachable from seeds through rod constraints (rigid massless links). */
function _rodConnectedGroup(physics, seeds) {
  const set = new Set(seeds.filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of physics.constraints) {
      if (c._newtonType !== 'rod') continue;
      const ba = c.bodyA;
      const bb = c.bodyB;
      if (!ba || !bb) continue;
      if (set.has(ba) && !set.has(bb) && !bb.isStatic) {
        set.add(bb);
        changed = true;
      }
      if (set.has(bb) && !set.has(ba) && !ba.isStatic) {
        set.add(ba);
        changed = true;
      }
    }
  }
  return [...set];
}

/**
 * Weld many bodies into one compound, conserving linear + angular momentum
 * about the new COM. Internal rods between members are removed.
 * @param {import('./engine.js').PhysicsEngine} physics
 * @param {{ body: import('matter-js').Body, snap: object }[]} entries
 */
function _weldGroup(physics, entries) {
  const usable = entries.filter(e => e?.body && _snapshotOk(e.snap) && physics.bodies.includes(e.body));
  if (usable.length < 2) return null;

  let M = 0;
  let px = 0;
  let py = 0;
  for (const { snap } of usable) {
    M += snap.mass;
    px += snap.mass * snap.vx;
    py += snap.mass * snap.vy;
  }
  if (!(M > 0)) return null;
  const vx = px / M;
  const vy = py / M;
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;

  const lockRotation = usable.some(e => e.body._lockRotation);

  // External constraints (not rods wholly inside the group).
  const memberSet = new Set(usable.map(e => e.body));
  /** @type {{ c: object, which: 'A'|'B', wx: number, wy: number }[]} */
  const externalAnchors = [];
  /** @type {object[]} */
  const internalRods = [];
  for (const c of physics.constraints) {
    const ba = c.bodyA;
    const bb = c.bodyB;
    const aIn = ba && memberSet.has(ba);
    const bIn = bb && memberSet.has(bb);
    if (aIn && bIn && c._newtonType === 'rod') {
      internalRods.push(c);
      continue;
    }
    if (aIn || bIn) {
      // Prefer collision-time world anchors from member snaps when possible.
      for (const which of /** @type {const} */ (['A', 'B'])) {
        const body = which === 'A' ? ba : bb;
        if (!body || !memberSet.has(body)) continue;
        const entry = usable.find(e => e.body === body);
        const wpt = entry
          ? { x: entry.snap.x, y: entry.snap.y } // COM attachment fallback
          : constraintAnchorWorld(c, which);
        // Better: use live anchor if finite, else snap COM.
        const live = constraintAnchorWorld(c, which);
        const pt = Number.isFinite(live.x) ? live : wpt;
        if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
          externalAnchors.push({ c, which, wx: pt.x, wy: pt.y });
        }
      }
    }
  }

  const survivorLabel = _preferLabel(
    physics,
    usable[0].body,
    usable[1]?.body ?? usable[0].body,
  );
  let muK = Infinity;
  let muS = Infinity;
  for (const { body } of usable) {
    muK = Math.min(muK, body._muK ?? body.friction ?? 0);
    muS = Math.min(muS, body._muS ?? body.frictionStatic ?? 0);
  }
  if (!Number.isFinite(muK)) muK = 0;
  if (!Number.isFinite(muS)) muS = 0;

  const partSpecs = [];
  /** @type {{ body: import('matter-js').Body, start: number, end: number }[]} */
  const ranges = [];
  for (const { body, snap } of usable) {
    const start = partSpecs.length;
    partSpecs.push(..._explodeParts(body, snap));
    ranges.push({ body, start, end: partSpecs.length });
  }
  if (partSpecs.length < 2) return null;
  if (partSpecs.some(s => !Number.isFinite(s.x) || !Number.isFinite(s.y))) return null;

  function _partIndexForMember(body) {
    const r = ranges.find(x => x.body === body);
    return r && r.start < r.end ? r.start : -1;
  }

  /** Visual rods kept after Matter constraints are removed. */
  const weldLinks = [];
  for (const rod of internalRods) {
    const partA = _partIndexForMember(rod.bodyA);
    const partB = _partIndexForMember(rod.bodyB);
    if (partA >= 0 && partB >= 0 && partA !== partB) {
      weldLinks.push({ partA, partB });
    }
  }

  const freeParts = partSpecs.map(spec => _materializePart(spec));
  const compound = Body.create({
    parts: freeParts,
    restitution: 0,
    friction: muK,
    frictionStatic: muS,
    frictionAir: 0,
  });
  if (!Number.isFinite(compound.position.x) || !Number.isFinite(compound.position.y)) {
    return null;
  }
  compound.deltaTime = Body._baseDelta;

  // Matter Body.create underestimates compound I for spaced circle parts.
  // Restore Σ(I_i + m_i d_i²) so L = Iω conservation is physical.
  _fixCompoundInertia(compound);

  const com = compound.position;
  let L = 0;
  for (const { snap } of usable) {
    L += _spinLFromSnap(snap);
    L += snap.mass * _cross2(snap.x - com.x, snap.y - com.y, snap.vx, snap.vy);
  }
  let w = L / Math.max(compound.inertia, 1e-9);
  if (!Number.isFinite(w)) w = 0;

  compound._newtonType = 'compound';
  compound._stickOnContact = partSpecs.some(s => s.stickOnContact);
  compound._muK = muK;
  compound._muS = muS;
  compound.label = survivorLabel;
  compound._weldParts = partSpecs.map(spec => ({
    type: spec.type,
    width: spec.width,
    height: spec.height,
    radius: spec.radius,
    hollow: spec.hollow,
    stickOnContact: !!spec.stickOnContact,
    label: spec.label ?? null,
    sourceId: spec.sourceId ?? null,
  }));
  compound._weldLinks = weldLinks;
  _applyLockRotation(compound, lockRotation);

  Body.setVelocity(compound, { x: vx, y: vy });
  Body.setAngularVelocity(compound, lockRotation ? 0 : w);

  for (const rod of internalRods) {
    physics.removeConstraint(rod);
  }
  for (const { body } of usable) {
    physics.removeBody(body);
  }
  physics.addBody(compound);

  for (const fix of externalAnchors) {
    if (fix.which === 'A') fix.c.bodyA = compound;
    else fix.c.bodyB = compound;
    const local = _worldToLocal(compound, fix.wx, fix.wy);
    if (fix.which === 'A') fix.c.pointA = local;
    else fix.c.pointB = local;
    if (fix.c.length != null) {
      const wA = constraintAnchorWorld(fix.c, 'A');
      const wB = constraintAnchorWorld(fix.c, 'B');
      if (Number.isFinite(wA.x) && Number.isFinite(wB.x)) {
        fix.c.length = Math.hypot(wB.x - wA.x, wB.y - wA.y);
      }
    }
  }

  return compound;
}

function _snapshotBody(body) {
  return {
    x: body.position.x,
    y: body.position.y,
    vx: body.velocity.x,
    vy: body.velocity.y,
    w: body.angularVelocity || 0,
    angle: body.angle || 0,
    mass: body.mass,
    inertia: body.inertia,
  };
}

function _snapshotOk(s) {
  return s
    && Number.isFinite(s.x) && Number.isFinite(s.y)
    && Number.isFinite(s.vx) && Number.isFinite(s.vy)
    && Number.isFinite(s.w) && Number.isFinite(s.mass) && s.mass > 0;
}

function _restoreBody(body, snap) {
  const r = body._radius ?? body.circleRadius;
  if (!(r > 0)) {
    Body.setPosition(body, { x: snap.x, y: snap.y });
    Body.setVelocity(body, { x: snap.vx, y: snap.vy });
    return;
  }

  // Replace NaN world vertices with a clean circle at the snap pose.
  const clean = Bodies.polygon(snap.x, snap.y, CIRCLE_HULL_SIDES, r, { angle: snap.angle || 0 });
  clean.circleRadius = r;
  const verts = clean.vertices.map(v => ({ x: v.x, y: v.y }));
  Body.setVertices(body, verts);
  body.vertices = verts;
  if (body.parts?.length) {
    for (const p of body.parts) {
      p.vertices = verts.map(v => ({ x: v.x, y: v.y }));
      p.position.x = snap.x;
      p.position.y = snap.y;
      p.positionPrev.x = snap.x;
      p.positionPrev.y = snap.y;
    }
  }

  body.position.x = snap.x;
  body.position.y = snap.y;
  body.positionPrev.x = snap.x - snap.vx;
  body.positionPrev.y = snap.y - snap.vy;
  body.angle = snap.angle || 0;
  body.anglePrev = snap.angle || 0;
  Body.setVelocity(body, { x: snap.vx, y: snap.vy });
  Body.setAngularVelocity(body, snap.w || 0);
  if (snap.mass > 0 && isFinite(snap.mass)) {
    Body.setMass(body, snap.mass);
    applyCircleInertia(body);
  }
  // Force axis/bounds refresh.
  Body.setAngle(body, snap.angle || 0);
}

/**
 * Sticky welds to any other unanchored, non-ground partner.
 * At least one body must be sticky.
 */
function _canWeld(a, b) {
  if (!a || !b) return false;
  if (!a._stickOnContact && !b._stickOnContact) return false;
  if (!_weldablePartner(a) || !_weldablePartner(b)) return false;
  return true;
}

function _weldablePartner(body) {
  if (!body || body.isStatic) return false;
  if (body._ropeSegment) return false;
  const t = body._newtonType;
  if (t === 'ground' || t === 'anchor' || t === 'metric-basis') return false;
  return true;
}

/**
 * @param {import('./engine.js').PhysicsEngine} physics
 * @param {import('matter-js').Body} a
 * @param {import('matter-js').Body} b
 * @param {object} snapA  Pose/velocity at collisionStart
 * @param {object} snapB
 * @param {{ c: object, which: 'A'|'B', wx: number, wy: number }[]} [anchorSnaps]
 */
function _weldBodies(physics, a, b, snapA, snapB, anchorSnaps = []) {
  const m1 = snapA.mass;
  const m2 = snapB.mass;
  if (!(m1 > 0) || !(m2 > 0)) return null;

  const M = m1 + m2;
  const vx = (m1 * snapA.vx + m2 * snapB.vx) / M;
  const vy = (m1 * snapA.vy + m2 * snapB.vy) / M;
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;

  const Lspin = _spinLFromSnap(snapA) + _spinLFromSnap(snapB);
  const lockRotation = !!(a._lockRotation || b._lockRotation);

  const anchorFixes = anchorSnaps.length
    ? anchorSnaps.filter(f => Number.isFinite(f.wx) && Number.isFinite(f.wy))
    : (() => {
      /** @type {{ c: object, which: 'A'|'B', wx: number, wy: number }[]} */
      const fixes = [];
      for (const c of physics.constraints) {
        for (const which of /** @type {const} */ (['A', 'B'])) {
          const body = which === 'A' ? c.bodyA : c.bodyB;
          if (body !== a && body !== b) continue;
          const wpt = constraintAnchorWorld(c, which);
          if (!Number.isFinite(wpt.x) || !Number.isFinite(wpt.y)) continue;
          fixes.push({ c, which, wx: wpt.x, wy: wpt.y });
        }
      }
      return fixes;
    })();

  const survivorLabel = _preferLabel(physics, a, b);
  const muK = Math.min(a._muK ?? a.friction ?? 0, b._muK ?? b.friction ?? 0);
  const muS = Math.min(a._muS ?? a.frictionStatic ?? 0, b._muS ?? b.frictionStatic ?? 0);

  const partSpecs = [
    ..._explodeParts(a, snapA),
    ..._explodeParts(b, snapB),
  ];
  if (partSpecs.length < 2) return null;
  if (partSpecs.some(s => !Number.isFinite(s.x) || !Number.isFinite(s.y))) return null;

  const freeParts = partSpecs.map(spec => _materializePart(spec));
  const compound = Body.create({
    parts: freeParts,
    restitution: 0,
    friction: muK,
    frictionStatic: muS,
    frictionAir: 0,
  });
  if (!Number.isFinite(compound.position.x) || !Number.isFinite(compound.position.y)) {
    return null;
  }
  compound.deltaTime = Body._baseDelta;
  _fixCompoundInertia(compound);

  const com = compound.position;
  const Lorb =
    m1 * _cross2(snapA.x - com.x, snapA.y - com.y, snapA.vx, snapA.vy)
    + m2 * _cross2(snapB.x - com.x, snapB.y - com.y, snapB.vx, snapB.vy);
  let w = (Lspin + Lorb) / Math.max(compound.inertia, 1e-9);
  if (!Number.isFinite(w)) w = 0;

  compound._newtonType = 'compound';
  compound._stickOnContact = partSpecs.some(s => s.stickOnContact);
  compound._muK = muK;
  compound._muS = muS;
  compound.label = survivorLabel;
  compound._weldParts = partSpecs.map(spec => ({
    type: spec.type,
    width: spec.width,
    height: spec.height,
    radius: spec.radius,
    hollow: spec.hollow,
    stickOnContact: !!spec.stickOnContact,
    label: spec.label ?? null,
    sourceId: spec.sourceId ?? null,
  }));
  _applyLockRotation(compound, lockRotation);

  Body.setVelocity(compound, { x: vx, y: vy });
  Body.setAngularVelocity(compound, lockRotation ? 0 : w);

  physics.removeBody(a);
  physics.removeBody(b);
  physics.addBody(compound);

  for (const fix of anchorFixes) {
    if (fix.which === 'A') fix.c.bodyA = compound;
    else fix.c.bodyB = compound;
    const local = _worldToLocal(compound, fix.wx, fix.wy);
    if (fix.which === 'A') fix.c.pointA = local;
    else fix.c.pointB = local;
  }

  // Prestressed rods explode to NaN in Matter’s solver: retarget length to the
  // post-weld anchor separation.
  for (const fix of anchorFixes) {
    const c = fix.c;
    if (c.length == null) continue;
    const wA = constraintAnchorWorld(c, 'A');
    const wB = constraintAnchorWorld(c, 'B');
    if (!Number.isFinite(wA.x) || !Number.isFinite(wB.x)) continue;
    c.length = Math.hypot(wB.x - wA.x, wB.y - wA.y);
  }

  return compound;
}

function _spinLFromSnap(snap) {
  if (!snap || !Number.isFinite(snap.inertia) || snap.inertia === Infinity) return 0;
  if (!Number.isFinite(snap.w)) return 0;
  return snap.inertia * snap.w;
}

/** Matter underestimates I for spaced circle compounds: use Σ(Iᵢ + mᵢdᵢ²). */
function _fixCompoundInertia(compound) {
  if (!compound?.parts || compound.parts.length < 2) return;
  const com = compound.position;
  let Isum = 0;
  for (const p of compound.parts.slice(1)) {
    const dx = p.position.x - com.x;
    const dy = p.position.y - com.y;
    const Ii = Number.isFinite(p.inertia) ? p.inertia : 0;
    Isum += Ii + p.mass * (dx * dx + dy * dy);
  }
  if (Isum > 1e-9) Body.setInertia(compound, Isum);
}

/**
 * Live part specs from a compound (world poses + per-part mass / sticky).
 * @param {import('matter-js').Body} compound
 */
export function liveCompoundPartSpecs(compound) {
  return _explodeParts(compound);
}

/**
 * Patch one welded part and rebuild the compound in place.
 * @param {import('./engine.js').PhysicsEngine} physics
 * @param {import('matter-js').Body} compound
 * @param {number} partIndex  0-based index into parts[1…] / _weldParts
 * @param {object} patch
 * @returns {import('matter-js').Body|null}  new compound body (id may change)
 */
export function updateCompoundPart(physics, compound, partIndex, patch) {
  if (!compound || compound._newtonType !== 'compound') return null;
  const specs = _explodeParts(compound);
  if (partIndex < 0 || partIndex >= specs.length) return null;
  Object.assign(specs[partIndex], patch);
  if (patch.mass != null) specs[partIndex].mass = Math.max(1e-6, patch.mass);
  if (patch.width != null) specs[partIndex].width = patch.width;
  if (patch.height != null) specs[partIndex].height = patch.height;
  if (patch.radius != null) specs[partIndex].radius = patch.radius;
  if (patch.stickOnContact != null) specs[partIndex].stickOnContact = !!patch.stickOnContact;
  if (patch.hollow != null) specs[partIndex].hollow = !!patch.hollow;
  if (patch.label !== undefined) specs[partIndex].label = patch.label || null;
  return _rebuildCompound(physics, compound, specs);
}

function _syncStickyFlag(compound) {
  compound._stickOnContact = (compound._weldParts ?? []).some(p => p.stickOnContact);
}

/**
 * @param {import('./engine.js').PhysicsEngine} physics
 * @param {import('matter-js').Body} old
 * @param {object[]} specs
 */
function _rebuildCompound(physics, old, specs) {
  if (specs.length < 1) return null;

  const vx = old.velocity.x;
  const vy = old.velocity.y;
  const w = Number.isFinite(old.angularVelocity) ? old.angularVelocity : 0;
  const label = old.label;
  const muK = old._muK ?? 0;
  const muS = old._muS ?? 0;
  const lockRotation = !!old._lockRotation;

  /** @type {{ c: object, which: 'A'|'B', wx: number, wy: number }[]} */
  const anchorFixes = [];
  for (const c of physics.constraints) {
    for (const which of /** @type {const} */ (['A', 'B'])) {
      const body = which === 'A' ? c.bodyA : c.bodyB;
      if (body !== old) continue;
      const wpt = constraintAnchorWorld(c, which);
      anchorFixes.push({ c, which, wx: wpt.x, wy: wpt.y });
    }
  }

  const freeParts = specs.map(spec => _materializePart(spec));
  if (specs.length === 1) {
    // Degenerate: single part becomes a normal body
    const alone = freeParts[0];
    alone._newtonType = specs[0].type === 'ball' ? 'ball'
      : specs[0].type === 'point-mass' ? 'point-mass'
      : specs[0].type === 'box' ? 'box'
      : 'box';
    alone._stickOnContact = !!specs[0].stickOnContact;
    alone._muK = muK;
    alone._muS = muS;
    alone.label = specs[0].label || label;
    if (alone._newtonType === 'box') {
      alone._width = specs[0].width;
      alone._height = specs[0].height;
    }
    _applyLockRotation(alone, lockRotation);
    Body.setVelocity(alone, { x: vx, y: vy });
    Body.setAngularVelocity(alone, lockRotation ? 0 : w);
    physics.removeBody(old);
    physics.addBody(alone);
    for (const fix of anchorFixes) {
      if (fix.which === 'A') fix.c.bodyA = alone;
      else fix.c.bodyB = alone;
      const local = _worldToLocal(alone, fix.wx, fix.wy);
      if (fix.which === 'A') fix.c.pointA = local;
      else fix.c.pointB = local;
    }
    return alone;
  }

  const compound = Body.create({
    parts: freeParts,
    restitution: 0,
    friction: muK,
    frictionStatic: muS,
    frictionAir: 0,
  });
  compound.deltaTime = Body._baseDelta;
  _fixCompoundInertia(compound);
  compound._newtonType = 'compound';
  compound._muK = muK;
  compound._muS = muS;
  compound.label = label;
  compound._weldParts = specs.map(spec => ({
    type: spec.type,
    width: spec.width,
    height: spec.height,
    radius: spec.radius,
    hollow: spec.hollow,
    stickOnContact: !!spec.stickOnContact,
    label: spec.label ?? null,
    sourceId: spec.sourceId ?? null,
  }));
  // Keep visual rod links across property rebuilds (drop links that point past new parts).
  const nParts = specs.length;
  compound._weldLinks = (old._weldLinks ?? []).filter(
    link => link.partA >= 0 && link.partB >= 0 && link.partA < nParts && link.partB < nParts,
  );
  _syncStickyFlag(compound);
  _applyLockRotation(compound, lockRotation);
  Body.setVelocity(compound, { x: vx, y: vy });
  Body.setAngularVelocity(compound, lockRotation ? 0 : w);

  physics.removeBody(old);
  physics.addBody(compound);

  for (const fix of anchorFixes) {
    if (fix.which === 'A') fix.c.bodyA = compound;
    else fix.c.bodyB = compound;
    const local = _worldToLocal(compound, fix.wx, fix.wy);
    if (fix.which === 'A') fix.c.pointA = local;
    else fix.c.pointB = local;
  }
  return compound;
}

function _cross2(rx, ry, vx, vy) {
  return rx * vy - ry * vx;
}

/** Spin L = Iω, locked / infinite-I bodies contribute 0 (avoid Infinity*0 → NaN). */
function _spinAngularMomentum(body) {
  if (!body || body._lockRotation) return 0;
  const I = body.inertia;
  const w = body.angularVelocity;
  if (!Number.isFinite(I) || !Number.isFinite(w)) return 0;
  return I * w;
}

function _applyLockRotation(body, lock) {
  body._lockRotation = !!lock;
  if (lock) {
    Body.setInertia(body, Infinity);
    Body.setAngularVelocity(body, 0);
  }
}

function _worldToLocal(body, wx, wy) {
  const dx = wx - body.position.x;
  const dy = wy - body.position.y;
  const c = Math.cos(-body.angle);
  const s = Math.sin(-body.angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

function _preferLabel(physics, a, b) {
  const aLinked = physics.constraints.some(c => c.bodyA === a || c.bodyB === a);
  const bLinked = physics.constraints.some(c => c.bodyA === b || c.bodyB === b);
  if (aLinked && !bLinked) return a.label;
  if (bLinked && !aLinked) return b.label;
  return a.mass >= b.mass ? a.label : b.label;
}

/**
 * Expand a body into geometric part specs (world pose + mass share).
 * @param {import('matter-js').Body} body
 * @param {object} [poseSnap]  Optional {x,y,angle,mass} overriding live body pose
 */
function _explodeParts(body, poseSnap = null) {
  const px = poseSnap?.x ?? body.position.x;
  const py = poseSnap?.y ?? body.position.y;
  const pang = poseSnap?.angle ?? body.angle;
  const pmass = poseSnap?.mass ?? body.mass;

  if (body._newtonType === 'compound' && body.parts?.length > 1) {
    const sub = body.parts.slice(1);
    return sub.map((p, i) => {
      const meta = body._weldParts?.[i];
      return {
        type: meta?.type ?? _guessPartType(p),
        x: p.position.x,
        y: p.position.y,
        angle: p.angle,
        width: meta?.width ?? (p.bounds.max.x - p.bounds.min.x),
        height: meta?.height ?? (p.bounds.max.y - p.bounds.min.y),
        radius: meta?.radius ?? p.circleRadius ?? null,
        hollow: meta?.hollow === true,
        stickOnContact: meta?.stickOnContact === true,
        label: meta?.label ?? null,
        sourceId: meta?.sourceId ?? null,
        mass: p.mass > 0 ? p.mass : (body.mass / sub.length),
        vertices: p.vertices.map(v => ({ x: v.x, y: v.y })),
      };
    });
  }

  const t = body._newtonType;
  const sticky = !!body._stickOnContact;
  /** Stable identity for graphs across later welds. */
  const sourceId = body.id;
  if (t === 'box') {
    return [{
      type: 'box',
      x: px,
      y: py,
      angle: pang,
      width: body._width ?? 40,
      height: body._height ?? 40,
      radius: null,
      hollow: false,
      stickOnContact: sticky,
      label: body.label ?? null,
      sourceId,
      mass: pmass,
      vertices: null,
    }];
  }
  if (t === 'point-mass' || t === 'ball') {
    return [{
      type: t,
      x: px,
      y: py,
      angle: pang,
      width: null,
      height: null,
      radius: body._radius ?? body.circleRadius ?? 10,
      hollow: body._hollow === true,
      stickOnContact: sticky,
      label: body.label ?? null,
      sourceId,
      mass: pmass,
      vertices: null,
    }];
  }

  // Wedge / generic: keep world vertices (live: only used when pose is finite).
  return [{
    type: t || 'generic',
    x: px,
    y: py,
    angle: pang,
    width: body._baseWidth ?? body._width ?? null,
    height: body._height ?? null,
    radius: null,
    hollow: false,
    stickOnContact: sticky,
    label: body.label ?? null,
    sourceId,
    mass: pmass,
    vertices: body.vertices.map(v => ({ x: v.x, y: v.y })),
  }];
}

function _guessPartType(part) {
  if (part.circleRadius) return 'point-mass';
  return 'box';
}

/**
 * @param {object} spec
 * @returns {import('matter-js').Body}
 */
function _materializePart(spec) {
  const opts = {
    restitution: 0,
    friction: 0,
    frictionStatic: 0,
    frictionAir: 0,
  };

  let part;
  if (spec.type === 'box' && spec.width && spec.height) {
    part = Bodies.rectangle(spec.x, spec.y, spec.width, spec.height, {
      ...opts,
      angle: spec.angle,
    });
    part._width = spec.width;
    part._height = spec.height;
  } else if ((spec.type === 'point-mass' || spec.type === 'ball') && spec.radius) {
    part = Bodies.polygon(spec.x, spec.y, CIRCLE_HULL_SIDES, spec.radius, {
      ...opts,
      angle: spec.angle,
    });
    part.circleRadius = spec.radius;
    part._radius = spec.radius;
    part._hollow = spec.hollow === true;
  } else if (spec.vertices?.length >= 3) {
    part = Bodies.fromVertices(spec.x, spec.y, [spec.vertices], opts) ?? null;
    if (!part) {
      part = Bodies.rectangle(spec.x, spec.y, spec.width || 20, spec.height || 20, {
        ...opts,
        angle: spec.angle,
      });
    }
  } else {
    part = Bodies.rectangle(spec.x, spec.y, spec.width || 20, spec.height || 20, {
      ...opts,
      angle: spec.angle,
    });
  }

  part._partType = spec.type;
  Body.setMass(part, Math.max(1e-6, spec.mass));
  if (spec.type === 'point-mass' || spec.type === 'ball') {
    // Matter setMass inflates circle I: restore disk / ring inertia for rolling.
    const r = part._radius ?? part.circleRadius;
    if (r > 0) {
      const m = part.mass;
      const I = part._hollow === true ? m * r * r : 0.5 * m * r * r;
      Body.setInertia(part, I);
    }
  }
  return part;
}

/** @param {object} spec */
export function materializeWeldPart(spec) {
  return _materializePart(spec);
}
