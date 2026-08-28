/**
 * World-space attachment helpers for constraints and ground resize handles.
 */

import Matter from 'matter-js';
import { createGround, anchorContainsWorldPoint } from './bodies.js';
import {
  constraintAnchorWorld,
  isSpringConstraint,
  syncMatterConstraintPoints,
} from './constraints.js';
import { snapWorldCoord } from '../grid.js';
import { hangingBodiesFromRopes, listRopeSegments, setRopeEndAttachment } from './rope.js';

export { constraintAnchorWorld };

const { World, Body, Events } = Matter;

/**
 * True when `a` and `b` are ends of the same rod or string.
 * Linked pairs skip mutual collision so a bob does not fight the ground/slab it hangs from.
 */
export function areConstraintLinked(a, b, constraints) {
  if (!a || !b) return false;
  for (const c of constraints ?? []) {
    if (c._ropeLink) continue;
    const t = c._newtonType;
    if (t !== 'rod' && t !== 'string') continue;
    const ba = c.bodyA;
    const bb = c.bodyB;
    if (!ba || !bb) continue;
    const aId = a.id;
    const bId = b.id;
    if ((ba === a || ba.id === aId) && (bb === b || bb.id === bId)) return true;
    if ((ba === b || ba.id === bId) && (bb === a || bb.id === aId)) return true;
  }
  return false;
}

/** Matter pair body → parent (compounds report the part; links use the parent). */
function _pairBody(b) {
  return b?.parent && b.parent !== b ? b.parent : b;
}

/** Disable Matter contact between rod/string ends (ground pendula, linked dumbbells). */
export function installConstraintLinkCollisionFilter(physics) {
  const suppress = event => {
    for (const pair of event.pairs) {
      if (areConstraintLinked(_pairBody(pair.bodyA), _pairBody(pair.bodyB), physics.constraints)) {
        pair.isActive = false;
      }
    }
  };
  Events.on(physics.engine, 'collisionStart', suppress);
  Events.on(physics.engine, 'collisionActive', suppress);
}

/**
 * Move rod/string/spring ends (and rope pins) from `oldBody` onto `newBody`,
 * preserving world attachment points.
 */
export function retargetBodyAttachments(engine, oldBody, newBody) {
  if (!oldBody || !newBody) return;
  for (const c of engine.constraints ?? []) {
    if (c._ropeLink) continue;
    for (const which of /** @type {const} */ (['A', 'B'])) {
      const body = which === 'A' ? c.bodyA : c.bodyB;
      if (body !== oldBody && body?.id !== oldBody.id) continue;
      const world = constraintAnchorWorld(c, which);
      const local = worldToBodyLocal(newBody, world.x, world.y);
      if (which === 'A') {
        c.bodyA = newBody;
        if (c._pointALocal) c._pointALocal = { ...local };
        c.pointA = local;
      } else {
        c.bodyB = newBody;
        if (c._pointBLocal) c._pointBLocal = { ...local };
        c.pointB = local;
      }
      if (c._newtonType === 'string' && !(typeof c._syncMatterPoints === 'function')) {
        syncMatterConstraintPoints(c);
      }
      _syncConstraintAfterAnchorEdit(c);
    }
  }
  for (const n of engine.bodies ?? []) {
    if (!n._ropeHost?.body) continue;
    const host = n._ropeHost.body;
    if (host !== oldBody && host?.id !== oldBody.id) continue;
    const world = constraintAnchorWorld({ bodyA: oldBody, pointA: n._ropeHost.local }, 'A');
    const local = worldToBodyLocal(newBody, world.x, world.y);
    const nodes = listRopeSegments(engine, n._ropeId);
    const which = nodes[0] === n ? 'A' : nodes[nodes.length - 1] === n ? 'B' : null;
    if (which) setRopeEndAttachment(engine, n._ropeId, which, newBody, local);
  }
}

/** True when a blue constraint-end handle should stretch length (not reattach). */
export function isConstraintLengthStretchBody(body) {
  if (!body || body.isStatic) return false;
  return body._newtonType === 'point-mass' || body._newtonType === 'ball' || body._newtonType === 'box' || body._newtonType === 'wedge';
}

/**
 * Slide the body on constraint end `which` along the link axis toward/away from
 * the other end, and set length (including spring rest length) to match.
 *
 * @param {object} c
 * @param {'A'|'B'} which
 * @param {number} wx  Cursor world x (px)
 * @param {number} wy  Cursor world y (px)
 * @param {object} [opts]
 * @param {number} [opts.minLen=5]
 * @param {boolean} [opts.snapGrid=false]  Snap the moving tip onto the world grid
 * @param {{ x: number, y: number }} [opts.axis]  Unit direction frozen at drag start
 * @returns {{ length: number, attach: {x:number,y:number}, pivot: {x:number,y:number}, axis: {x:number,y:number} } | null}
 */
export function stretchConstraintEndAlongAxis(c, which, wx, wy, opts = {}) {
  const minLen = opts.minLen ?? 5;
  const snapGrid = !!opts.snapGrid;
  const body = which === 'A' ? c.bodyA : c.bodyB;
  if (!isConstraintLengthStretchBody(body)) return null;

  const otherWhich = which === 'A' ? 'B' : 'A';
  const pivot = constraintAnchorWorld(c, otherWhich);
  const localAttach = which === 'A'
    ? { ...(c.pointA ?? { x: 0, y: 0 }) }
    : { ...(c.pointB ?? { x: 0, y: 0 }) };

  let ux;
  let uy;
  if (opts.axis && Number.isFinite(opts.axis.x) && Number.isFinite(opts.axis.y)) {
    const aLen = Math.hypot(opts.axis.x, opts.axis.y);
    if (aLen < 1e-8) return null;
    ux = opts.axis.x / aLen;
    uy = opts.axis.y / aLen;
  } else {
    const cur = constraintAnchorWorld(c, which);
    let dx = cur.x - pivot.x;
    let dy = cur.y - pivot.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = wx - pivot.x;
      dy = wy - pivot.y;
      len = Math.hypot(dx, dy);
      if (len < 1e-6) return null;
    }
    ux = dx / len;
    uy = dy / len;
  }

  let t = (wx - pivot.x) * ux + (wy - pivot.y) * uy;
  if (snapGrid) {
    // Snap the tip onto the world grid, then keep it on the frozen axis
    // (same idea as velocity / ground handles).
    let tipX = pivot.x + ux * t;
    let tipY = pivot.y + uy * t;
    tipX = snapWorldCoord(tipX, true);
    tipY = snapWorldCoord(tipY, true);
    t = (tipX - pivot.x) * ux + (tipY - pivot.y) * uy;
  }
  if (t < minLen) t = minLen;

  const attach = { x: pivot.x + ux * t, y: pivot.y + uy * t };

  const θ = body.angle;
  const cosθ = Math.cos(θ);
  const sinθ = Math.sin(θ);
  const lax = cosθ * localAttach.x - sinθ * localAttach.y;
  const lay = sinθ * localAttach.x + cosθ * localAttach.y;
  Body.setPosition(body, { x: attach.x - lax, y: attach.y - lay });
  Body.setVelocity(body, { x: 0, y: 0 });
  body.force.x = 0;
  body.force.y = 0;
  body.torque = 0;

  // Rods/strings and springs: length tracks the pulled separation (rest length for springs).
  c.length = t;
  if (c.bodyA) c.angleA = c.bodyA.angle;
  if (c.bodyB) c.angleB = c.bodyB.angle;

  return { length: t, attach, pivot, axis: { x: ux, y: uy } };
}

/** True when this end stays fixed during setup drags (world point or non-metric static body). */
function _endActsAsFixedPivot(body) {
  return !body || (body.isStatic && body._newtonType !== 'metric-basis');
}

/** True for the anchor pivot object (not ground or other static bodies). */
function _isPivotObject(body) {
  return !!body && body._newtonType === 'anchor';
}

/**
 * Dynamic bodies reachable from `rootBody` through string/rod/spring links,
 * stopping at static anchors / ground. Used so setup drags translate a hanging
 * chain (e.g. double-pendulum lower bob) instead of stretching the lower links.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {import('matter-js').Body} rootBody
 * @param {object} [opts]
 * @param {number[]} [opts.skipConstraintIds]
 * @returns {import('matter-js').Body[]}
 */
export function findHangingBodies(engine, rootBody, opts = {}) {
  if (!rootBody) return [];
  const skip = new Set(opts.skipConstraintIds ?? []);
  const visited = new Set([rootBody.id]);
  const result = [];
  const queue = [rootBody];

  while (queue.length) {
    const cur = queue.shift();
    for (const c of engine.constraints) {
      if (skip.has(c.id)) continue;
      if (c._ropeLink) continue;
      if (!['string', 'rod', 'spring'].includes(c._newtonType)) continue;
      // Springs do not rigidly couple setup drags — rest length tracks the drag instead.
      if (isSpringConstraint(c)) continue;

      let other = null;
      if (c.bodyA === cur) other = c.bodyB;
      else if (c.bodyB === cur) other = c.bodyA;
      if (!other || visited.has(other.id)) continue;
      if (_endActsAsFixedPivot(other) || other._newtonType === 'metric-basis') continue;

      visited.add(other.id);
      result.push(other);
      queue.push(other);
    }
    for (const extra of hangingBodiesFromRopes(engine, cur)) {
      if (!extra || visited.has(extra.id)) continue;
      if (_endActsAsFixedPivot(extra) || extra._newtonType === 'metric-basis') continue;
      visited.add(extra.id);
      result.push(extra);
      queue.push(extra);
    }
  }
  return result;
}

/**
 * Snapshot hanging-chain body origins so they can ride a Δ from `rootBody`.
 * @returns {{ root0: {x:number,y:number}, origins: Array<{ body: object, ox: number, oy: number }> } | null}
 */
export function captureHangingChain(engine, rootBody, opts = {}) {
  if (!rootBody) return null;
  const hangers = findHangingBodies(engine, rootBody, opts);
  if (!hangers.length) return null;
  return {
    root0: { x: rootBody.position.x, y: rootBody.position.y },
    origins: hangers.map(b => ({ body: b, ox: b.position.x, oy: b.position.y })),
  };
}

/**
 * Apply the same translation rootBody moved since `captureHangingChain`.
 * @param {{ root0: {x:number,y:number}, origins: Array<{ body: object, ox: number, oy: number }> }} chain
 * @param {import('matter-js').Body} rootBody
 */
export function applyHangingChainTranslation(chain, rootBody) {
  if (!chain || !rootBody) return;
  const dx = rootBody.position.x - chain.root0.x;
  const dy = rootBody.position.y - chain.root0.y;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return;
  for (const { body, ox, oy } of chain.origins) {
    if (!body || body.isStatic) continue;
    Body.setPosition(body, { x: ox + dx, y: oy + dy });
    Body.setVelocity(body, { x: 0, y: 0 });
    body.force.x = 0;
    body.force.y = 0;
    body.torque = 0;
  }
}

/**
 * If `draggedBody` is linked by string/rod (or a spring whose other end is an
 * anchor pivot), returns pivot, radius, and local attach so setup drag can move
 * the bob on a circular arc.
 *
 * All other springs omit arc guidance — the body drags freely while rest length
 * stays fixed and the coil visually extends or compresses. Ropes clamp host drags to
 * rest length and reproject segments (see syncRopesAfterHostMove).
 *
 * Prefers a fixed pivot (world / static anchor) when present — e.g. the upper
 * bob of a double pendulum. Otherwise pivots about the other dynamic body on
 * a rod/string link (lower bob arcs about the upper). Change length via the blue
 * end-handle instead.
 *
 * @returns {{
 *   pivot: { x: number, y: number },
 *   radius: number,
 *   localAttach: { x: number, y: number },
 *   kind: string,
 *   constraintId: number,
 *   pivotBody: import('matter-js').Body|null,
 * } | null}
 */
export function findPendulumGuidance(engine, draggedBody) {
  if (!draggedBody || draggedBody.isStatic || draggedBody._newtonType === 'anchor' ||
      draggedBody._newtonType === 'metric-basis') return null;

  let fixedHit = null;
  let dynamicHit = null;

  for (const c of engine.constraints) {
    if (c._ropeLink) continue;
    if (!['string', 'rod', 'spring'].includes(c._newtonType)) continue;
    const L = typeof c.length === 'number' ? c.length : 0;
    if (L < 1e-3) continue;

    /** @type {'A'|'B'|null} */
    let draggedEnd = null;
    /** @type {'A'|'B'|null} */
    let otherEnd = null;
    if (c.bodyB === draggedBody) {
      draggedEnd = 'B';
      otherEnd = 'A';
    } else if (c.bodyA === draggedBody) {
      draggedEnd = 'A';
      otherEnd = 'B';
    }
    if (!draggedEnd || !otherEnd) continue;

    const otherBody = otherEnd === 'A' ? c.bodyA : c.bodyB;
    const localAttach = draggedEnd === 'A'
      ? (c.pointA ? { ...c.pointA } : { x: 0, y: 0 })
      : (c.pointB ? { ...c.pointB } : { x: 0, y: 0 });
    const hit = {
      pivot: constraintAnchorWorld(c, otherEnd),
      radius: L,
      localAttach,
      kind: c._newtonType,
      constraintId: c.id,
      pivotBody: otherBody ?? null,
    };

    if (c._newtonType === 'spring') {
      // Spring: arc only when the other end is an anchor pivot; otherwise stretch on drag.
      if (_isPivotObject(otherBody) && !fixedHit) fixedHit = hit;
      continue;
    }

    if (_endActsAsFixedPivot(otherBody)) {
      if (!fixedHit) fixedHit = hit;
    } else if (otherBody && otherBody._newtonType !== 'metric-basis' && !dynamicHit) {
      dynamicHit = hit;
    }
  }

  return fixedHit ?? dynamicHit;
}

/**
 * Move one anchor to a world point (px), update the other body's local offset,
 * and set `constraint.length` to the current world separation.
 * Only valid when that end already has a body (no free world ends).
 */
export function setConstraintAnchorWorldPx(c, which, wx, wy) {
  const body = which === 'A' ? c.bodyA : c.bodyB;
  if (!body) return;
  const local = worldToBodyLocal(body, wx, wy);
  if (which === 'A') {
    if (c._pointALocal) c._pointALocal = { ...local };
    c.pointA = local;
  } else {
    if (c._pointBLocal) c._pointBLocal = { ...local };
    c.pointB = local;
  }
  if (c._newtonType === 'string' && !(typeof c._syncMatterPoints === 'function')) {
    syncMatterConstraintPoints(c);
  }
  _syncConstraintAfterAnchorEdit(c);
}

/** @param {import('./constraints.js').RodConstraint|import('./constraints.js').SpringConstraint|object} c */
function _syncConstraintAfterAnchorEdit(c) {
  const a = constraintAnchorWorld(c, 'A');
  const b = constraintAnchorWorld(c, 'B');
  // Rods/strings: link length follows anchor edit. Springs keep rest length.
  if (!isSpringConstraint(c)) {
    c.length = Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (c.bodyA) c.angleA = c.bodyA.angle;
  if (c.bodyB) c.angleB = c.bodyB.angle;
}

/**
 * Attach (or reattach) one constraint end to a body at a local offset.
 * Both ends must stay body-attached: `body` is required.
 * @returns {boolean}
 */
export function setConstraintEndAttachment(c, which, body, local = { x: 0, y: 0 }) {
  if (!c || !body) return false;
  const other = which === 'A' ? c.bodyB : c.bodyA;
  if (other && other.id === body.id) return false;
  const loc = { x: local.x ?? 0, y: local.y ?? 0 };
  if (which === 'A') {
    c.bodyA = body;
    if (c._pointALocal) c._pointALocal = { ...loc };
    c.pointA = loc;
  } else {
    c.bodyB = body;
    if (c._pointBLocal) c._pointBLocal = { ...loc };
    c.pointB = loc;
  }
  // Legacy Matter strings: keep Matter points in static world-offset form.
  if (c._newtonType === 'string' && !(typeof c._syncMatterPoints === 'function')) {
    syncMatterConstraintPoints(c);
  }
  _syncConstraintAfterAnchorEdit(c);
  return true;
}

/**
 * World → body-local offset for an attachment point.
 * @param {import('matter-js').Body} body
 * @param {number} wx
 * @param {number} wy
 */
export function worldToBodyLocal(body, wx, wy) {
  const dx = wx - body.position.x;
  const dy = wy - body.position.y;
  const ca = Math.cos(-body.angle);
  const sa = Math.sin(-body.angle);
  return { x: ca * dx - sa * dy, y: sa * dx + ca * dy };
}

/**
 * Preferred attach point on a body near (wx, wy).
 * Point masses / anchors / boxes → centre. Ground → closest point on top edge.
 * @param {object} [opts]
 * @param {boolean} [opts.snapGrid=false]  Snap along the ground top edge to the grid
 */
export function attachPointOnBody(body, wx, wy, opts = {}) {
  if (!body) return null;
  if (body._newtonType === 'ground') {
    const { L, R } = groundTopEdgeWorld(body);
    const dx = R.x - L.x;
    const dy = R.y - L.y;
    const edgeLen = Math.hypot(dx, dy);
    let t = 0.5;
    if (edgeLen > 1e-8) {
      t = ((wx - L.x) * dx + (wy - L.y) * dy) / (edgeLen * edgeLen);
      t = Math.max(0, Math.min(1, t));
      if (opts.snapGrid) {
        let dist = t * edgeLen;
        dist = snapWorldCoord(dist, true);
        t = Math.max(0, Math.min(1, dist / edgeLen));
      }
    }
    const world = { x: L.x + t * dx, y: L.y + t * dy };
    return { body, local: worldToBodyLocal(body, world.x, world.y), world };
  }
  return {
    body,
    local: { x: 0, y: 0 },
    world: { x: body.position.x, y: body.position.y },
  };
}

/**
 * Nearest valid attach target for a constraint end: another body, or another
 * constraint's endpoint (inherits that end's body + local offset).
 * Free world points are never returned.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {number} wx
 * @param {number} wy
 * @param {object} [opts]
 * @param {number} [opts.excludeConstraintId]  Constraint being edited
 * @param {number|null} [opts.excludeBodyId]   Other end's body (cannot attach both ends to same body)
 * @param {number} [opts.hitPx=28]
 * @param {boolean} [opts.snapGrid=false]  Snap ground-edge attachments to the grid
 * @returns {{ body: object, local: {x:number,y:number}, world: {x:number,y:number}, kind: string } | null}
 */
export function findConstraintAttachTarget(engine, wx, wy, opts = {}) {
  const hitPx = opts.hitPx ?? 28;
  const excludeC = opts.excludeConstraintId;
  const excludeBodyId = opts.excludeBodyId ?? null;
  const snapGrid = !!opts.snapGrid;
  let best = null;
  let bestD = hitPx;

  for (const c of engine.constraints) {
    if (excludeC != null && c.id === excludeC) continue;
    if (c._ropeLink) continue;
    for (const end of ['A', 'B']) {
      const body = end === 'A' ? c.bodyA : c.bodyB;
      if (!body || body._newtonType === 'metric-basis' || body._ropeSegment) continue;
      if (excludeBodyId != null && body.id === excludeBodyId) continue;
      const world = constraintAnchorWorld(c, end);
      const d = Math.hypot(wx - world.x, wy - world.y);
      if (d <= bestD) {
        bestD = d;
        const local = end === 'A'
          ? { ...(c.pointA ?? { x: 0, y: 0 }) }
          : { ...(c.pointB ?? { x: 0, y: 0 }) };
        best = { body, local, world, kind: 'constraint-end' };
      }
    }
  }

  for (const body of engine.bodies) {
    if (body._newtonType === 'metric-basis' || body._ropeSegment) continue;
    if (excludeBodyId != null && body.id === excludeBodyId) continue;

    let world;
    let local;
    let d;

    if (body._newtonType === 'ground') {
      const ap = attachPointOnBody(body, wx, wy, { snapGrid });
      world = ap.world;
      local = ap.local;
      d = Math.hypot(wx - world.x, wy - world.y);
      const hw = (body._width ?? 400) / 2;
      const hh = (body._height ?? 20) / 2;
      const cos = Math.cos(-body.angle);
      const sin = Math.sin(-body.angle);
      const lx = cos * (wx - body.position.x) - sin * (wy - body.position.y);
      const ly = sin * (wx - body.position.x) + cos * (wy - body.position.y);
      const overSlab = Math.abs(lx) <= hw + 8 && Math.abs(ly) <= hh + 8;
      if (!overSlab && d > hitPx) continue;
      if (overSlab) d = Math.min(d, hitPx);
    } else if (body._newtonType === 'anchor') {
      if (!anchorContainsWorldPoint(body, wx, wy)) continue;
      world = { x: body.position.x, y: body.position.y };
      local = { x: 0, y: 0 };
      d = 0;
    } else if (body._newtonType === 'box' || body._newtonType === 'wedge') {
      const hw = (body._width ?? body._baseWidth ?? 40) / 2;
      const hh = (body._height ?? 40) / 2;
      const cos = Math.cos(-body.angle);
      const sin = Math.sin(-body.angle);
      const lx = cos * (wx - body.position.x) - sin * (wy - body.position.y);
      const ly = sin * (wx - body.position.x) + cos * (wy - body.position.y);
      if (Math.abs(lx) > hw + hitPx || Math.abs(ly) > hh + hitPx) continue;
      const ap = attachPointOnBody(body, wx, wy, { snapGrid });
      world = ap.world;
      local = ap.local;
      d = Math.hypot(wx - world.x, wy - world.y);
    } else {
      // point-mass / anchor: centre, generous hit for small radii
      const r = body._radius ?? body.circleRadius ?? 12;
      d = Math.hypot(wx - body.position.x, wy - body.position.y);
      if (d > Math.max(hitPx, r + 10)) continue;
      world = { x: body.position.x, y: body.position.y };
      local = { x: 0, y: 0 };
    }

    if (d <= bestD) {
      bestD = d;
      best = { body, local, world, kind: 'body' };
    }
  }

  return best;
}

/** Left / right endpoints of the ground top edge in world px (+ thickness). */
export function groundTopEdgeWorld(body) {
  const w = body._width ?? 400;
  const h = body._height ?? 20;
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const corner = (lx, ly) => ({
    x: body.position.x + cos * lx - sin * ly,
    y: body.position.y + sin * lx + cos * ly,
  });
  return { L: corner(-w / 2, -h / 2), R: corner(w / 2, -h / 2), h };
}

/** Centre, size, angle for `createGround` when the top walking edge runs L → R. */
export function groundLayoutFromTopCorners(L, R, thickness) {
  const w = Math.hypot(R.x - L.x, R.y - L.y);
  const ang = Math.atan2(R.y - L.y, R.x - L.x);
  const mTopX = (L.x + R.x) / 2;
  const mTopY = (L.y + R.y) / 2;
  const cx = mTopX + (thickness / 2) * (-Math.sin(ang));
  const cy = mTopY + (thickness / 2) * Math.cos(ang);
  return { cx, cy, w, h: thickness, angle: ang };
}

/**
 * Replace a ground body using a new top edge (world px). Preserves label and material.
 * Caller should record history. Returns the new body or null if too small.
 */
export function replaceGroundFromTopEdge(engine, oldBody, L, R) {
  const h = oldBody._height ?? 20;
  const w = Math.hypot(R.x - L.x, R.y - L.y);
  if (w < 10) return null;
  const { cx, cy, w: w2, h: h2, angle } = groundLayoutFromTopCorners(L, R, h);
  const neo = createGround(cx, cy, w2, h2, {
    angle,
    muK: oldBody._muK ?? oldBody.friction,
    muS: oldBody._muS ?? oldBody.frictionStatic ?? oldBody.friction,
    restitution: oldBody.restitution,
  });
  if (oldBody.label) neo.label = oldBody.label;
  retargetBodyAttachments(engine, oldBody, neo);
  World.remove(engine.world, oldBody);
  World.add(engine.world, neo);
  return neo;
}
