/**
 * Free multi-segment rope: point-mass nodes with inextensible PBD links.
 *
 * Look: one rounded stroke through the node centres (flush, not faceted
 * sticks). Physics: lock-rotated disks (no spin) + inextensible hinged PBD
 * so segments can fold independently. A rope attached at both ends also
 * has a max-distance between the hosts (the chain does not pull the hosts,
 * which would drain a pendulum). Matter distance constraints are not used.
 */

import Matter from 'matter-js';
import { createPointMass } from './bodies.js';
import { createRod, constraintAnchorWorld } from './constraints.js';
import { mToPx, pxToM, PX_PER_M } from '../units.js';

const { Body } = Matter;

/** Negative group ⇒ same-group pairs never collide (Matter.js). */
export const ROPE_COLLISION_GROUP = -7;

/** Node diameter / stroke thickness (m). Shown as 0.050 in the properties panel. */
export const ROPE_THICKNESS_M = 0.05;

/**
 * SVG stroke width (px) from rope node radii, or the default thickness.
 * Skips host bodies on pinned ends (they are not rope nodes).
 *
 * @param {import('matter-js').Body[]|object[]} [items]  Rope nodes or PBD links
 */
export function ropeStrokeWidthPx(items = []) {
  for (const item of items) {
    const a = item.bodyA ?? item;
    const b = item.bodyB;
    if (a?._ropeSegment && a._radius > 0) return Math.max(2, 2 * a._radius);
    if (b?._ropeSegment && b._radius > 0) return Math.max(2, 2 * b._radius);
  }
  return Math.max(2, mToPx(ROPE_THICKNESS_M));
}

/** Minimum / maximum stroke pieces (= nodes − 1). */
export const ROPE_MIN_SEGMENTS = 2;
export const ROPE_MAX_SEGMENTS = 100;

/** @param {number} n */
export function clampRopeSegments(n) {
  return Math.max(ROPE_MIN_SEGMENTS, Math.min(ROPE_MAX_SEGMENTS, Math.round(n)));
}

const ROPE_HINGE_STIFFNESS = 1;
const ROPE_HINGE_DAMPING = 0;
/** Gauss-Seidel PBD iterations per physics step (alternating sweep direction). */
const ROPE_PBD_ITERS = 48;
const ROPE_PBD_POLISH_ITERS = 12;

let _ropeIdCounter = 0;
export function nextRopeId(prefix = 'rope') {
  return `${prefix}_${++_ropeIdCounter}`;
}

/**
 * @typedef {object} FreeRopeOpts
 * @property {number} [segments]   Number of stroke pieces (= nodes − 1)
 * @property {boolean} [exactNodes] Use polyline points as nodes (no resample)
 * @property {number} [totalMass=1]
 * @property {number} [thicknessM]
 * @property {number} [muK=0]
 * @property {number} [muS=0]
 * @property {string} [idPrefix]
 * @property {string} [ropeId]
 * @property {string} [ropeName]  Display name for the rope aggregate
 * @property {{ body: object, local?: {x:number,y:number} }|null} [attachA]
 * @property {{ body: object, local?: {x:number,y:number} }|null} [attachB]
 * @property {number} [restLengthPx]  Preserve rest length on rebuild (world px)
 * @property {number} [restLengthM]   Scene-doc rest length (m)
 */

/**
 * Place a free rope along a world-px polyline.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {{ x: number, y: number }[]} pointsWorldPx
 * @param {FreeRopeOpts} [opts]
 * @returns {{ bodies: import('matter-js').Body[], constraints: object[], ropeId: string }}
 */
export function createFreeRope(engine, pointsWorldPx, opts = {}) {
  const nodes = _nodeSpecsFromPolyline(
    pointsWorldPx.filter(p => p && isFinite(p.x) && isFinite(p.y)),
    opts,
    /* metres */ false,
  );
  if (nodes.length < 2) return { bodies: [], constraints: [], ropeId: opts.ropeId ?? '' };

  const radius = mToPx(opts.thicknessM ?? ROPE_THICKNESS_M) / 2;
  const mass = (opts.totalMass ?? 1) / nodes.length;
  const muK = opts.muK ?? 0;
  const muS = opts.muS ?? 0;
  const ropeId = opts.ropeId ?? nextRopeId(opts.idPrefix ?? 'rope');
  const prefix = opts.idPrefix ?? ropeId;
  const ropeName = opts.ropeName ?? 'Rope';
  const nSeg = nodes.length - 1;

  const bodies = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const node = createPointMass(n.x, n.y, {
      radius,
      mass,
      muK,
      muS,
      restitution: 0,
      frictionAir: 0,
      ropeSegment: true,
      // Generous slop so the table lip does not launch nodes.
      slop: 0.5,
      collisionFilter: { group: ROPE_COLLISION_GROUP },
    });
    _tagRopeNode(node, ropeId, i, nSeg, prefix, ropeName);
    Body.setVelocity(node, { x: 0, y: 0 });
    Body.setAngularVelocity(node, 0);
    engine.addBody(node);
    bodies.push(node);
  }

  const constraints = _linkNodes(engine, bodies, prefix, opts.attachA, opts.attachB);
  const restPx = opts.restLengthPx ?? _polylineLength(nodes);
  _applyRestLength(bodies, constraints, restPx);
  if (opts.attachA?.body) {
    setRopeEndAttachment(engine, ropeId, 'A', opts.attachA.body, opts.attachA.local);
  }
  if (opts.attachB?.body) {
    setRopeEndAttachment(engine, ropeId, 'B', opts.attachB.body, opts.attachB.local);
  }
  _updateRopeCollision(engine, ropeId);
  return { bodies, constraints, ropeId };
}

/**
 * Scene-document parts (positions in metres, Matter +y down).
 *
 * @param {{ x: number, y: number }[]} pointsM
 * @param {FreeRopeOpts} [opts]
 */
export function buildFreeRopeSceneParts(pointsM, opts = {}) {
  const nodes = _nodeSpecsFromPolyline(
    pointsM.filter(p => p && isFinite(p.x) && isFinite(p.y)),
    opts,
    /* metres */ true,
  );
  if (nodes.length < 2) return { bodies: [], constraints: [], ropeId: opts.ropeId ?? '' };

  const thicknessM = opts.thicknessM ?? ROPE_THICKNESS_M;
  const radiusM = thicknessM / 2;
  const mass = (opts.totalMass ?? 1) / nodes.length;
  const muK = opts.muK ?? 0;
  const muS = opts.muS ?? 0;
  const ropeId = opts.ropeId ?? nextRopeId(opts.idPrefix ?? 'rope');
  const prefix = opts.idPrefix ?? ropeId;
  const nSeg = nodes.length - 1;
  const restM = opts.restLengthM ?? _polylineLength(nodes);

  const bodies = nodes.map((n, i) => ({
    id: `${prefix}_${i}`,
    type: 'point-mass',
    position: { x: n.x, y: n.y },
    angle: 0,
    mass,
    velocity: { vx: 0, vy: 0 },
    geometry: { radius: radiusM, hollow: false },
    material: {
      restitution: 0,
      muK,
      muS,
      frictionAir: 0,
      ropeSegment: true,
      ropeId,
      ropeIndex: i,
      ropeCount: nSeg,
      ropeName: opts.ropeName ?? 'Rope',
      ropeRestLength: restM,
      lockRotation: true,
      ...(i === 0 && _sceneAttachId(opts.attachA) ? {
        ropeHost: {
          body: _sceneAttachId(opts.attachA),
          ..._sceneAttachLocalM(opts.attachA),
        },
      } : {}),
      ...(i === nodes.length - 1 && _sceneAttachId(opts.attachB) ? {
        ropeHost: {
          body: _sceneAttachId(opts.attachB),
          ..._sceneAttachLocalM(opts.attachB),
        },
      } : {}),
    },
  }));

  const hostA = _sceneAttachId(opts.attachA);
  const hostB = _sceneAttachId(opts.attachB);
  const locA = _sceneAttachLocalM(opts.attachA);
  const locB = _sceneAttachLocalM(opts.attachB);
  const constraints = [];
  for (let i = 0; i < bodies.length - 1; i++) {
    let bodyA = bodies[i].id;
    let bodyB = bodies[i + 1].id;
    let anchorA = { x: 0, y: 0 };
    let anchorB = { x: 0, y: 0 };
    if (i === 0 && hostA) {
      bodyA = hostA;
      anchorA = locA;
    }
    if (i === bodies.length - 2 && hostB) {
      bodyB = hostB;
      anchorB = locB;
    }
    const len = restM / nSeg;
    constraints.push({
      id: `${prefix}_seg_${i}`,
      type: 'rod',
      bodyA,
      bodyB,
      anchorA,
      anchorB,
      length: len,
      stiffness: ROPE_HINGE_STIFFNESS,
      damping: ROPE_HINGE_DAMPING,
      ropeLink: true,
      ropeId,
    });
  }

  return { bodies, constraints, ropeId };
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 */
export function listRopeSegments(engine, ropeId) {
  return engine.bodies
    .filter(b => b._ropeSegment && b._ropeId === ropeId)
    .sort((a, b) => (a._ropeIndex ?? 0) - (b._ropeIndex ?? 0));
}

/** Alias: nodes are the selectable rope pieces. */
export const listRopeNodes = listRopeSegments;

/**
 * Folder / properties label for a rope aggregate.
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 */
export function ropeDisplayName(engine, ropeId) {
  const named = listRopeSegments(engine, ropeId).find(n => n._ropeName);
  return named?._ropeName || 'Rope';
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @param {string} name
 */
export function renameRope(engine, ropeId, name) {
  const next = String(name ?? '').trim();
  if (!next) return;
  for (const node of listRopeSegments(engine, ropeId)) {
    node._ropeName = next;
  }
}

/**
 * Sandbox / browser selection for the whole rope aggregate.
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @returns {{ type: 'rope', ropeId: string, memberIds: number[], id: number, key: string }|null}
 */
export function ropeSelection(engine, ropeId) {
  if (!ropeId) return null;
  const nodes = listRopeSegments(engine, ropeId);
  if (!nodes.length) return null;
  return {
    type: 'rope',
    ropeId,
    memberIds: nodes.map(n => n.id),
    id: nodes[0].id,
    key: `rope:${ropeId}`,
  };
}

/**
 * World-px centerline through node centres.
 * @param {import('matter-js').Body[]} nodes
 */
export function ropeCenterlineWorldPx(nodes) {
  return nodes.map(n => ({ x: n.position.x, y: n.position.y }));
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 */
export function removeRope(engine, ropeId) {
  const nodes = listRopeSegments(engine, ropeId);
  const ids = new Set(nodes.map(s => s.id));
  for (const c of [...engine.constraints]) {
    if (!c._ropeLink) continue;
    if (ids.has(c.bodyA?.id) || ids.has(c.bodyB?.id) || c._ropeId === ropeId) {
      engine.removeConstraint(c);
    }
  }
  for (const n of nodes) engine.removeBody(n);
}

/**
 * Rebuild along the current centerline with a new segment count.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @param {object} [opts]
 */
export function rebuildRope(engine, ropeId, opts = {}) {
  const old = listRopeSegments(engine, ropeId);
  if (!old.length) return null;
  const pts = ropeCenterlineWorldPx(old);
  const totalMass = opts.totalMass
    ?? old.reduce((m, s) => m + (s.mass || 0), 0);
  const thicknessM = opts.thicknessM
    ?? pxToM(2 * (old[0]._radius ?? old[0].circleRadius ?? mToPx(ROPE_THICKNESS_M) / 2));
  const muK = opts.muK ?? old[0]._muK ?? 0;
  const muS = opts.muS ?? old[0]._muS ?? 0;
  const nSeg = clampRopeSegments(opts.segments ?? (old.length - 1));
  const ropeName = opts.ropeName ?? old[0]?._ropeName ?? 'Rope';
  const attachA = opts.attachA ?? _cloneHost(old[0]?._ropeHost);
  const attachB = opts.attachB ?? _cloneHost(old[old.length - 1]?._ropeHost);
  const restLengthPx = opts.restLengthPx
    ?? old.find(n => n._ropeRestLength > 0)?._ropeRestLength
    ?? _polylineLength(pts);

  removeRope(engine, ropeId);
  return createFreeRope(engine, pts, {
    segments: nSeg,
    totalMass,
    thicknessM,
    muK,
    muS,
    ropeId,
    idPrefix: ropeId,
    ropeName,
    attachA,
    attachB,
    restLengthPx,
  });
}

function _cloneHost(host) {
  if (!host?.body) return null;
  return { body: host.body, local: { x: host.local?.x ?? 0, y: host.local?.y ?? 0 } };
}

function _endWhich(engine, node) {
  if (!node?._ropeId) return null;
  const nodes = listRopeSegments(engine, node._ropeId);
  if (nodes[0] === node) return 'A';
  if (nodes[nodes.length - 1] === node) return 'B';
  return null;
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @param {'A'|'B'} which
 */
export function ropeEndNode(engine, ropeId, which) {
  const nodes = listRopeSegments(engine, ropeId);
  if (!nodes.length) return null;
  return which === 'A' ? nodes[0] : nodes[nodes.length - 1];
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @param {'A'|'B'} which
 * @returns {{ body: object, local: {x:number,y:number} }|null}
 */
export function getRopeEndAttachment(engine, ropeId, which) {
  return ropeEndNode(engine, ropeId, which)?._ropeHost ?? null;
}

/**
 * Nearest rope end under the cursor (for joining chains).
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {number} wx
 * @param {number} wy
 * @param {object} [opts]
 * @param {number} [opts.hitPx=32]
 * @param {string|null} [opts.excludeRopeId]  Skip this rope (usually the one being dragged)
 * @returns {{ ropeId: string, which: 'A'|'B', node: object, world: {x:number,y:number} }|null}
 */
export function findRopeEndTarget(engine, wx, wy, opts = {}) {
  const hitPx = opts.hitPx ?? 32;
  const excludeRopeId = opts.excludeRopeId ?? null;
  let best = null;
  let bestD = hitPx;
  const seen = new Set();
  for (const b of engine.bodies ?? []) {
    if (!b._ropeSegment || !b._ropeId || seen.has(b._ropeId)) continue;
    seen.add(b._ropeId);
    if (excludeRopeId != null && b._ropeId === excludeRopeId) continue;
    for (const which of /** @type {const} */ (['A', 'B'])) {
      const node = ropeEndNode(engine, b._ropeId, which);
      if (!node) continue;
      const d = Math.hypot(wx - node.position.x, wy - node.position.y);
      if (d <= bestD) {
        bestD = d;
        best = {
          ropeId: b._ropeId,
          which,
          node,
          world: { x: node.position.x, y: node.position.y },
        };
      }
    }
  }
  return best;
}

/**
 * Join two ropes at the given ends into one chain. Keeps `ropeIdA`'s id / name.
 * Far-end body attachments are preserved. Returns the merged rope or null.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeIdA
 * @param {'A'|'B'} whichA  End of A that meets B
 * @param {string} ropeIdB
 * @param {'A'|'B'} whichB  End of B that meets A
 * @returns {{ bodies: object[], constraints: object[], ropeId: string }|null}
 */
export function mergeRopesAtEnds(engine, ropeIdA, whichA, ropeIdB, whichB) {
  if (!ropeIdA || !ropeIdB || ropeIdA === ropeIdB) return null;
  if ((whichA !== 'A' && whichA !== 'B') || (whichB !== 'A' && whichB !== 'B')) return null;

  const nodesA = listRopeSegments(engine, ropeIdA);
  const nodesB = listRopeSegments(engine, ropeIdB);
  if (nodesA.length < 2 || nodesB.length < 2) return null;

  let ptsA = ropeCenterlineWorldPx(nodesA);
  let ptsB = ropeCenterlineWorldPx(nodesB);
  // Orient so whichA is the last point of A and whichB is the first of B.
  if (whichA === 'A') ptsA = ptsA.slice().reverse();
  if (whichB === 'B') ptsB = ptsB.slice().reverse();

  const jx = (ptsA[ptsA.length - 1].x + ptsB[0].x) / 2;
  const jy = (ptsA[ptsA.length - 1].y + ptsB[0].y) / 2;
  let pts = [
    ...ptsA.slice(0, -1),
    { x: jx, y: jy },
    ...ptsB.slice(1),
  ];
  if (pts.length < 2) return null;

  const farA = whichA === 'A' ? 'B' : 'A';
  const farB = whichB === 'A' ? 'B' : 'A';
  const attachStart = _cloneHost(getRopeEndAttachment(engine, ropeIdA, farA));
  const attachEnd = _cloneHost(getRopeEndAttachment(engine, ropeIdB, farB));
  // Same host on both far ends is illegal for a single rope.
  if (attachStart?.body && attachEnd?.body
    && (attachStart.body === attachEnd.body || attachStart.body.id === attachEnd.body.id)) {
    return null;
  }

  const restA = nodesA.find(n => n._ropeRestLength > 0)?._ropeRestLength
    ?? _polylineLength(ptsA);
  const restB = nodesB.find(n => n._ropeRestLength > 0)?._ropeRestLength
    ?? _polylineLength(ptsB);
  const totalMass = nodesA.reduce((m, s) => m + (s.mass || 0), 0)
    + nodesB.reduce((m, s) => m + (s.mass || 0), 0);
  const thicknessM = pxToM(2 * (nodesA[0]._radius ?? nodesA[0].circleRadius
    ?? mToPx(ROPE_THICKNESS_M) / 2));
  const muK = nodesA[0]._muK ?? 0;
  const muS = nodesA[0]._muS ?? 0;
  const ropeName = nodesA[0]?._ropeName ?? nodesB[0]?._ropeName ?? 'Rope';

  const maxNodes = ROPE_MAX_SEGMENTS + 1;
  const exactNodes = pts.length <= maxNodes;
  if (!exactNodes) {
    pts = _resamplePolyline(pts, maxNodes);
  }

  removeRope(engine, ropeIdB);
  removeRope(engine, ropeIdA);
  return createFreeRope(engine, pts, {
    exactNodes,
    segments: Math.max(ROPE_MIN_SEGMENTS, pts.length - 1),
    totalMass: Math.max(0.05, totalMass),
    thicknessM,
    muK,
    muS,
    ropeId: ropeIdA,
    idPrefix: ropeIdA,
    ropeName,
    attachA: attachStart,
    attachB: attachEnd,
    restLengthPx: restA + restB,
  });
}

/**
 * Pin or unpin a rope end to a body (constraint-like). `body` null = free end.
 * Both ends may not share the same body. Rope nodes are not valid hosts.
 *
 * @returns {boolean}
 */
export function setRopeEndAttachment(engine, ropeId, which, body, local = { x: 0, y: 0 }) {
  const node = ropeEndNode(engine, ropeId, which);
  if (!node) return false;
  if (body?._ropeSegment) return false;
  const other = ropeEndNode(engine, ropeId, which === 'A' ? 'B' : 'A');
  if (body && other?._ropeHost?.body && other._ropeHost.body.id === body.id) return false;
  if (!body) {
    node._ropeHost = null;
    _setPinnedCollision(node, false);
    _rewireRopeEndLink(engine, ropeId, which, null, { x: 0, y: 0 });
    _updateRopeCollision(engine, ropeId);
    return true;
  }
  node._ropeHost = {
    body,
    local: { x: local.x ?? 0, y: local.y ?? 0 },
  };
  _setPinnedCollision(node, true);
  _snapNodeToHost(node, body, node._ropeHost.local);
  _rewireRopeEndLink(engine, ropeId, which, body, node._ropeHost.local);
  _updateRopeCollision(engine, ropeId);
  return true;
}

/** Unpin every rope end that was attached to `body` (after the host is deleted). */
export function clearRopeAttachmentsToBody(engine, body) {
  if (!body) return;
  for (const n of engine.bodies ?? []) {
    if (!n._ropeHost?.body) continue;
    if (n._ropeHost.body === body || n._ropeHost.body.id === body.id) {
      n._ropeHost = null;
      _setPinnedCollision(n, false);
      const which = _endWhich(engine, n);
      if (which) _rewireRopeEndLink(engine, n._ropeId, which, null);
    }
  }
}

/**
 * After a sticky weld, hosts that pointed at removed members follow the compound.
 * @param {number[]} removedIds
 */
export function retargetRopeHosts(engine, removedIds, compound) {
  if (!compound || !removedIds?.length) return;
  const gone = new Set(removedIds);
  for (const n of engine.bodies ?? []) {
    const host = n._ropeHost?.body;
    if (!host || !gone.has(host.id)) continue;
    n._ropeHost = {
      body: compound,
      local: _worldToLocal(compound, n.position.x, n.position.y),
    };
    _setPinnedCollision(n, true);
    const which = _endWhich(engine, n);
    if (which) _rewireRopeEndLink(engine, n._ropeId, which, compound, n._ropeHost.local);
  }
}

/** Kinematic snap: setup drags and deserialize. */
export function snapRopePins(engine) {
  for (const n of engine.bodies ?? []) {
    const h = n._ropeHost;
    if (!h?.body) continue;
    const alive = (engine.bodies ?? []).includes(h.body);
    if (!alive) {
      n._ropeHost = null;
      _setPinnedCollision(n, false);
      continue;
    }
    _snapNodeToHost(n, h.body, h.local ?? { x: 0, y: 0 });
  }
}

/**
 * Rope nodes (and the other-end host, if dynamic) that should ride a setup drag
 * of `rootBody`, like hanging constraint chains.
 */
export function hangingBodiesFromRopes(engine, rootBody) {
  if (!rootBody) return [];
  const ropeIds = new Set();
  for (const b of engine.bodies ?? []) {
    if (b._ropeHost?.body === rootBody || b._ropeHost?.body?.id === rootBody.id) {
      if (b._ropeId) ropeIds.add(b._ropeId);
    }
  }
  const out = [];
  const seen = new Set();
  for (const id of ropeIds) {
    const nodes = listRopeSegments(engine, id);
    const twoHost = !!(nodes[0]?._ropeHost?.body && nodes[nodes.length - 1]?._ropeHost?.body);
    if (twoHost) {
      // Only the end pinned to this host rides the drag, the span can go slack.
      for (const n of [nodes[0], nodes[nodes.length - 1]]) {
        const host = n?._ropeHost?.body;
        if (!n || (host !== rootBody && host?.id !== rootBody.id)) continue;
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n);
      }
      continue;
    }
    for (const n of nodes) {
      const host = n._ropeHost?.body;
      if (host && host !== rootBody && host.isStatic) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    for (const n of [nodes[0], nodes[nodes.length - 1]]) {
      const host = n?._ropeHost?.body;
      if (!host || host === rootBody || host.isStatic) continue;
      if (seen.has(host.id)) continue;
      seen.add(host.id);
      out.push(host);
    }
  }
  return out;
}

function _setPinnedCollision(node, pinned) {
  if (!node.collisionFilter) node.collisionFilter = {};
  if (pinned) {
    node.collisionFilter.mask = 0;
  } else {
    node.collisionFilter.mask = 0xFFFFFFFF;
    node.collisionFilter.group = ROPE_COLLISION_GROUP;
  }
}

function _attachWorld(host, local) {
  const lx = local?.x ?? 0;
  const ly = local?.y ?? 0;
  const cos = Math.cos(host.angle);
  const sin = Math.sin(host.angle);
  return {
    x: host.position.x + cos * lx - sin * ly,
    y: host.position.y + sin * lx + cos * ly,
  };
}

function _worldToLocal(body, wx, wy) {
  const dx = wx - body.position.x;
  const dy = wy - body.position.y;
  const ca = Math.cos(-body.angle);
  const sa = Math.sin(-body.angle);
  return { x: ca * dx - sa * dy, y: sa * dx + ca * dy };
}

function _pointVelocity(body, worldPt) {
  const rx = worldPt.x - body.position.x;
  const ry = worldPt.y - body.position.y;
  const w = body.angularVelocity || 0;
  return {
    x: (body.velocity?.x ?? 0) - w * ry,
    y: (body.velocity?.y ?? 0) + w * rx,
  };
}

function _snapNodeToHost(node, host, local) {
  const P = _attachWorld(host, local);
  Body.setPosition(node, P);
  const v = _pointVelocity(host, P);
  Body.setVelocity(node, v);
  Body.setAngularVelocity(node, 0);
  node.force.x = 0;
  node.force.y = 0;
  node.torque = 0;
}

/**
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {import('matter-js').Body[]} bodies
 * @param {string} prefix
 * @param {{ body: object, local?: {x:number,y:number} }|null} [attachA]
 * @param {{ body: object, local?: {x:number,y:number} }|null} [attachB]
 */
function _linkNodes(engine, bodies, prefix, attachA = null, attachB = null) {
  const constraints = [];
  const ropeId = bodies[0]?._ropeId;
  const n = bodies.length;
  if (n < 2) return constraints;
  const hostA = attachA?.body && !attachA.body._ropeSegment ? attachA : null;
  const hostB = attachB?.body && !attachB.body._ropeSegment ? attachB : null;

  for (let i = 0; i < n - 1; i++) {
    let a = bodies[i];
    let b = bodies[i + 1];
    let pointA = { x: 0, y: 0 };
    let pointB = { x: 0, y: 0 };
    if (i === 0 && hostA) {
      a = hostA.body;
      pointA = { x: hostA.local?.x ?? 0, y: hostA.local?.y ?? 0 };
    }
    if (i === n - 2 && hostB) {
      b = hostB.body;
      pointB = { x: hostB.local?.x ?? 0, y: hostB.local?.y ?? 0 };
    }
    const pA = _attachWorld(a, pointA);
    const pB = _attachWorld(b, pointB);
    const len = Math.hypot(pB.x - pA.x, pB.y - pA.y);
    const link = createRod(a, b, {
      length: len,
      pointA,
      pointB,
      label: `${prefix}_seg_${i}`,
      stiffness: ROPE_HINGE_STIFFNESS,
      damping: ROPE_HINGE_DAMPING,
    });
    link._ropeLink = true;
    link._ropeId = ropeId;
    link.label = `${prefix}_seg_${i}`;
    engine.addConstraint(link);
    constraints.push(link);
  }
  return constraints;
}

function _ropeLinksSorted(engine, ropeId) {
  return (engine.constraints ?? [])
    .filter(c => c._ropeLink && c._ropeId === ropeId)
    .sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? ''), undefined, { numeric: true }));
}

/** First/last PBD link is host ↔ neighbour so the pin is visual-only. */
function _rewireRopeEndLink(engine, ropeId, which, host, local = { x: 0, y: 0 }) {
  const nodes = listRopeSegments(engine, ropeId);
  if (nodes.length < 2) return;
  const links = _ropeLinksSorted(engine, ropeId);
  if (!links.length) return;
  const link = which === 'A' ? links[0] : links[links.length - 1];
  const neighbor = which === 'A' ? nodes[1] : nodes[nodes.length - 2];
  const end = which === 'A' ? nodes[0] : nodes[nodes.length - 1];
  const loc = { x: local.x ?? 0, y: local.y ?? 0 };
  if (which === 'A') {
    link.bodyA = host || end;
    link.pointA = host ? loc : { x: 0, y: 0 };
    link.bodyB = neighbor;
    link.pointB = { x: 0, y: 0 };
  } else {
    link.bodyA = neighbor;
    link.pointA = { x: 0, y: 0 };
    link.bodyB = host || end;
    link.pointB = host ? loc : { x: 0, y: 0 };
  }
  _redistributeRest(engine, ropeId);
}

function _sceneAttachId(attach) {
  if (!attach?.body) return null;
  if (typeof attach.body === 'string' || typeof attach.body === 'number') {
    return String(attach.body);
  }
  return attach.body.label ?? (attach.body.id != null ? String(attach.body.id) : null);
}

function _sceneAttachLocalM(attach) {
  const loc = attach?.local ?? { x: 0, y: 0 };
  if (attach?.body && typeof attach.body === 'object' && attach.body.position) {
    return { x: pxToM(loc.x ?? 0), y: pxToM(loc.y ?? 0) };
  }
  return { x: loc.x ?? 0, y: loc.y ?? 0 };
}

/**
 * @param {import('matter-js').Body} node
 * @param {string} ropeId
 * @param {number} index
 * @param {number} segmentCount
 * @param {string} prefix
 * @param {string} [ropeName]
 */
function _tagRopeNode(node, ropeId, index, segmentCount, prefix, ropeName = 'Rope') {
  node.label = `${prefix}_${index}`;
  node._ropeSegment = true;
  node._ropeId = ropeId;
  node._ropeIndex = index;
  node._ropeCount = segmentCount;
  node._ropeName = ropeName;
  node.sleepThreshold = Infinity;
  node._lockRotation = true;
  Body.setInertia(node, Infinity);
  Body.setAngularVelocity(node, 0);
}

/**
 * Rest length of a rope in world px.
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 */
export function ropeRestLengthPx(engine, ropeId) {
  return _ropeRestPx(engine, ropeId, _ropeLinksSorted(engine, ropeId));
}

/**
 * Setup-time inextensible projection: bilateral link lengths, hosts frozen.
 * Call after editor moves so the chain cannot be left stretched.
 *
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @param {object} [opts]
 * @param {number} [opts.iterations]
 */
export function enforceRopeLength(engine, ropeId, opts = {}) {
  if (!engine || !ropeId) return;
  const links = _ropeLinksSorted(engine, ropeId);
  if (!links.length) return;
  snapRopePins(engine);

  const twoHost = _isTwoHostGroup(engine, links);
  if (twoHost) _seedSlackSag(engine, links);

  const iters = Math.max(1, opts.iterations ?? ROPE_PBD_ITERS);
  const n = links.length;
  for (let k = 0; k < iters; k++) {
    const fwd = (k % 2) === 0;
    for (let i = 0; i < n; i++) {
      // Bilateral + freeze hosts: rope nodes move, pins stay put.
      _projectRopeLink(links[fwd ? i : n - 1 - i], false, true);
    }
  }
  snapRopePins(engine);
  for (const node of listRopeSegments(engine, ropeId)) {
    Body.setVelocity(node, { x: 0, y: 0 });
    Body.setAngularVelocity(node, 0);
    node.force.x = 0;
    node.force.y = 0;
    node.torque = 0;
  }
}

/**
 * World pivot for the end opposite `which` (host attach point, or free node).
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {string} ropeId
 * @param {'A'|'B'} which
 */
export function ropeOtherEndPivot(engine, ropeId, which) {
  const other = ropeEndNode(engine, ropeId, which === 'A' ? 'B' : 'A');
  if (!other) return null;
  const host = other._ropeHost;
  if (host?.body) return _attachWorld(host.body, host.local);
  return { x: other.position.x, y: other.position.y };
}

/**
 * Clamp a desired tip position so the chord from the other end ≤ rest length.
 * @returns {{ x: number, y: number, clamped: boolean }}
 */
export function clampRopeTipToRest(engine, ropeId, which, wx, wy) {
  const pivot = ropeOtherEndPivot(engine, ropeId, which);
  const rest = ropeRestLengthPx(engine, ropeId);
  if (!pivot || !(rest > 0)) return { x: wx, y: wy, clamped: false };
  const dx = wx - pivot.x;
  const dy = wy - pivot.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > rest + 1e-6)) return { x: wx, y: wy, clamped: false };
  const s = rest / dist;
  return { x: pivot.x + dx * s, y: pivot.y + dy * s, clamped: true };
}

/**
 * True when the end opposite `which` is pinned to a body.
 */
export function ropeOtherEndPinned(engine, ropeId, which) {
  const other = ropeEndNode(engine, ropeId, which === 'A' ? 'B' : 'A');
  return !!other?._ropeHost?.body;
}

/**
 * Inextensible hinged chain (PBD). Two-host ropes are slackable (unilateral
 * segments) with a separate host-host max-length so the bob is not hauled
 * by light nodes (that coupling dumps pendulum energy).
 *
 * @param {object[]} constraints
 * @param {{ iterations?: number, velocity?: boolean, engine?: import('./engine.js').PhysicsEngine }} [opts]
 */
export function solveRopeConstraints(constraints, opts = {}) {
  const links = [];
  for (const c of constraints ?? []) {
    if (!c?._ropeLink || !c.bodyA || !c.bodyB) continue;
    links.push(c);
  }
  const engine = opts.engine;
  if (engine) snapRopePins(engine);
  if (!links.length) return;

  const groups = _groupRopeLinks(links);
  const attached = [];
  const freezeHosts = new Set();
  for (const group of groups) {
    if (engine && _isTwoHostGroup(engine, group)) {
      attached.push(group);
      if (group[0]._ropeId) freezeHosts.add(group[0]._ropeId);
    }
  }

  for (const group of attached) _seedSlackSag(engine, group);

  const n = links.length;
  const iters = Math.max(1, opts.iterations ?? ROPE_PBD_ITERS);
  for (let k = 0; k < iters; k++) {
    const fwd = (k % 2) === 0;
    for (let i = 0; i < n; i++) {
      const c = links[fwd ? i : n - 1 - i];
      const slackable = freezeHosts.has(c._ropeId);
      _projectRopeLink(c, slackable, slackable);
    }
  }

  for (const group of attached) _solveTwoHostSpan(engine, group, false);
  if (engine) snapRopePins(engine);

  if (opts.velocity !== false) {
    for (const c of links) {
      const slackable = freezeHosts.has(c._ropeId);
      _relaxRopeLinkVelocity(c, slackable, slackable);
    }
    for (const group of attached) _solveTwoHostSpan(engine, group, true);
    if (engine) snapRopePins(engine);
  }
}

export const ROPE_PBD_POLISH = ROPE_PBD_POLISH_ITERS;

function _groupRopeLinks(links) {
  const map = new Map();
  for (const c of links) {
    const id = c._ropeId ?? `anon:${c.bodyA?.id}:${c.bodyB?.id}`;
    let g = map.get(id);
    if (!g) {
      g = [];
      map.set(id, g);
    }
    g.push(c);
  }
  return [...map.values()];
}

function _isTwoHostGroup(engine, group) {
  const id = group[0]?._ropeId;
  if (!id) return false;
  const nodes = listRopeSegments(engine, id);
  return !!(nodes[0]?._ropeHost?.body && nodes[nodes.length - 1]?._ropeHost?.body);
}

function _polylineLength(pts) {
  let L = 0;
  for (let i = 0; i < (pts?.length ?? 0) - 1; i++) {
    L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return L;
}

function _applyRestLength(nodes, links, restPx) {
  if (!(restPx > 0)) return;
  for (const n of nodes) n._ropeRestLength = restPx;
  if (!links.length) return;
  const each = restPx / links.length;
  for (const c of links) c.length = each;
}

function _ropeRestPx(engine, ropeId, group) {
  const stored = listRopeSegments(engine, ropeId).find(n => n._ropeRestLength > 0)?._ropeRestLength;
  if (stored > 0) return stored;
  let rest = 0;
  for (const c of group ?? []) rest += c.length || 0;
  return rest;
}

function _redistributeRest(engine, ropeId) {
  const links = _ropeLinksSorted(engine, ropeId);
  _applyRestLength(listRopeSegments(engine, ropeId), links, _ropeRestPx(engine, ropeId, links));
}

function _updateRopeCollision(engine, ropeId) {
  const nodes = listRopeSegments(engine, ropeId);
  if (!nodes.length) return;
  const twoHost = !!(nodes[0]._ropeHost?.body && nodes[nodes.length - 1]._ropeHost?.body);
  for (const n of nodes) {
    _setPinnedCollision(n, twoHost || !!n._ropeHost?.body);
  }
}

/**
 * Colinear compressed segments stay on the chord (looks like a shrinking
 * spring). A gravity-aligned nudge lets the chain fold when slack.
 */
function _seedSlackSag(engine, group) {
  const id = group[0]?._ropeId;
  const nodes = listRopeSegments(engine, id);
  const hA = nodes[0]?._ropeHost;
  const hB = nodes[nodes.length - 1]?._ropeHost;
  if (!hA?.body || !hB?.body || nodes.length < 3) return;
  const pA = _attachWorld(hA.body, hA.local);
  const pB = _attachWorld(hB.body, hB.local);
  const chord = Math.hypot(pB.x - pA.x, pB.y - pA.y);
  const rest = _ropeRestPx(engine, id, group);
  if (!(chord < rest - 1e-3)) return;
  const g = engine.engine?.gravity;
  let gx = g?.x ?? 0;
  let gy = g?.y ?? 1;
  const glen = Math.hypot(gx, gy);
  if (glen < 1e-9) return;
  gx /= glen;
  gy /= glen;
  const amp = Math.min((rest - chord) * 0.15, rest * 0.05);
  for (let i = 1; i < nodes.length - 1; i++) {
    const n = nodes[i];
    if (n._ropeHost?.body) continue;
    Body.translate(n, { x: gx * amp, y: gy * amp }, false);
  }
}

/** Host-host max-length only: the chain must not impulse the hosts. */
function _solveTwoHostSpan(engine, group, velocity) {
  const id = group[0]?._ropeId;
  const nodes = listRopeSegments(engine, id);
  const hA = nodes[0]?._ropeHost;
  const hB = nodes[nodes.length - 1]?._ropeHost;
  if (!hA?.body || !hB?.body) return;
  const rest = _ropeRestPx(engine, id, group);
  const pA = _attachWorld(hA.body, hA.local);
  const pB = _attachWorld(hB.body, hB.local);
  if (velocity) _relaxDistance(hA.body, pA, hB.body, pB, rest, true, false);
  else _projectDistance(hA.body, pA, hB.body, pB, rest, true, false);
}

function _pbdWeight(body, worldPt, nx, ny, freezeHosts) {
  if (!body || body.isStatic || (freezeHosts && !body._ropeSegment)) {
    return { wLin: 0, Iinv: 0, rcn: 0, w: 0 };
  }
  const wLin = body.inverseMass || 0;
  const Iinv = body.inertia > 0 && isFinite(body.inertia) ? 1 / body.inertia : 0;
  const rx = worldPt.x - body.position.x;
  const ry = worldPt.y - body.position.y;
  const rcn = rx * ny - ry * nx;
  return { wLin, Iinv, rcn, w: wLin + rcn * rcn * Iinv };
}

function _applyPosLam(body, w, nx, ny, lam) {
  if (!body || body.isStatic || !(w?.w > 0)) return;
  if (w.wLin > 0) Body.translate(body, { x: nx * lam * w.wLin, y: ny * lam * w.wLin }, false);
  if (w.Iinv > 0) {
    const dA = lam * w.Iinv * w.rcn;
    if (Math.abs(dA) > 1e-12) Body.setAngle(body, body.angle + dA);
  }
}

function _applyVelLam(body, w, nx, ny, lam) {
  if (!body || body.isStatic || !(w?.w > 0)) return;
  if (w.wLin > 0) {
    Body.setVelocity(body, {
      x: body.velocity.x + lam * nx * w.wLin,
      y: body.velocity.y + lam * ny * w.wLin,
    });
  }
  if (w.Iinv > 0) {
    Body.setAngularVelocity(body, (body.angularVelocity || 0) + lam * w.Iinv * w.rcn);
  }
}

function _projectDistance(a, pA, b, pB, rest, unilateral, freezeHosts) {
  if (!a || !b || !(rest > 1e-9)) return;
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 1e-9)) return;
  const err = dist - rest;
  if (unilateral ? !(err > 1e-8) : Math.abs(err) < 1e-8) return;
  const nx = dx / dist;
  const ny = dy / dist;
  const wA = _pbdWeight(a, pA, nx, ny, freezeHosts);
  const wB = _pbdWeight(b, pB, nx, ny, freezeHosts);
  const w = wA.w + wB.w;
  if (!(w > 1e-18)) return;
  const lam = err / w;
  _applyPosLam(a, wA, nx, ny, lam);
  _applyPosLam(b, wB, nx, ny, -lam);
}

function _relaxDistance(a, pA, b, pB, rest, unilateral, freezeHosts) {
  if (!a || !b || !(rest > 1e-9)) return;
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 1e-9)) return;
  if (unilateral && !(dist > rest - 1e-6)) return;
  const nx = dx / dist;
  const ny = dy / dist;
  const vA = _pointVelocity(a, pA);
  const vB = _pointVelocity(b, pB);
  const rel = (vB.x - vA.x) * nx + (vB.y - vA.y) * ny;
  if (unilateral ? !(rel > 1e-12) : Math.abs(rel) < 1e-12) return;
  const wA = _pbdWeight(a, pA, nx, ny, freezeHosts);
  const wB = _pbdWeight(b, pB, nx, ny, freezeHosts);
  const w = wA.w + wB.w;
  if (!(w > 1e-18)) return;
  const lam = rel / w;
  _applyVelLam(a, wA, nx, ny, lam);
  _applyVelLam(b, wB, nx, ny, -lam);
}

function _projectRopeLink(c, unilateral, freezeHosts) {
  _projectDistance(
    c.bodyA, constraintAnchorWorld(c, 'A'),
    c.bodyB, constraintAnchorWorld(c, 'B'),
    c.length, unilateral, freezeHosts,
  );
}

function _relaxRopeLinkVelocity(c, unilateral, freezeHosts) {
  _relaxDistance(
    c.bodyA, constraintAnchorWorld(c, 'A'),
    c.bodyB, constraintAnchorWorld(c, 'B'),
    c.length, unilateral, freezeHosts,
  );
}

/**
 * Sample `segments + 1` nodes along the polyline.
 * @param {{ x: number, y: number }[]} pts
 * @param {FreeRopeOpts} opts
 * @param {boolean} metres
 */
function _nodeSpecsFromPolyline(pts, opts, metres) {
  if (pts.length < 2) return [];
  // Exact node list (e.g. demo centerline that must not cut through a table).
  if (opts.exactNodes || opts.segments === pts.length - 1) {
    return pts.map(p => ({ x: p.x, y: p.y }));
  }
  const nSeg = clampRopeSegments(opts.segments ?? (pts.length - 1));
  return _resamplePolyline(pts, nSeg + 1);
}

/**
 * @param {{ x: number, y: number }[]} pts
 * @param {number} n
 */
function _resamplePolyline(pts, n) {
  if (pts.length === 1) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const segLens = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLens.push(d);
    total += d;
  }
  if (total < 1e-9) {
    return Array.from({ length: n }, () => ({ ...pts[0] }));
  }

  const out = [];
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    let acc = 0;
    let placed = false;
    for (let i = 0; i < segLens.length; i++) {
      const next = acc + segLens[i];
      if (target <= next + 1e-9 || i === segLens.length - 1) {
        const t = segLens[i] < 1e-9 ? 0 : (target - acc) / segLens[i];
        const u = Math.max(0, Math.min(1, t));
        out.push({
          x: pts[i].x + u * (pts[i + 1].x - pts[i].x),
          y: pts[i].y + u * (pts[i + 1].y - pts[i].y),
        });
        placed = true;
        break;
      }
      acc = next;
    }
    if (!placed) out.push({ ...pts[pts.length - 1] });
  }
  return out;
}

/**
 * @param {number} lengthPx
 */
export function ropeSegmentCountForLength(lengthPx) {
  const lenM = lengthPx / PX_PER_M;
  return Math.max(3, Math.min(28, Math.round(lenM / 0.12)));
}

/**
 * @param {import('matter-js').Body} body
 * @param {object} mat
 */
export function applyRopeMaterialFlags(body, mat) {
  if (!mat?.ropeSegment) return;
  body._ropeSegment = true;
  body._ropeId = mat.ropeId ?? body.label?.replace(/_\d+$/, '') ?? nextRopeId();
  body._ropeIndex = Number.isFinite(mat.ropeIndex) ? mat.ropeIndex : 0;
  body._ropeCount = Number.isFinite(mat.ropeCount) ? mat.ropeCount : undefined;
  if (typeof mat.ropeName === 'string' && mat.ropeName) body._ropeName = mat.ropeName;
  if (Number.isFinite(mat.ropeRestLength) && mat.ropeRestLength > 0) {
    body._ropeRestLength = mToPx(mat.ropeRestLength);
  }
  if (mat.ropeHost && typeof mat.ropeHost === 'object') {
    body._ropeHostSpec = {
      body: mat.ropeHost.body,
      x: mat.ropeHost.x,
      y: mat.ropeHost.y,
    };
  }
  body.sleepThreshold = Infinity;
  body._lockRotation = true;
  Body.setInertia(body, Infinity);
  Body.setAngularVelocity(body, 0);
  if (!body.collisionFilter) body.collisionFilter = {};
  body.collisionFilter.group = ROPE_COLLISION_GROUP;
}

/**
 * Resolve `material.ropeHost` body labels after deserialize.
 * @param {import('./engine.js').PhysicsEngine} engine
 * @param {Record<string, import('matter-js').Body>} bodyMap
 */
export function resolveRopeHosts(engine, bodyMap) {
  for (const n of engine.bodies ?? []) {
    const spec = n._ropeHostSpec;
    if (!spec) continue;
    delete n._ropeHostSpec;
    const host = typeof spec.body === 'string' ? bodyMap[spec.body] : spec.body;
    if (!host || host._ropeSegment) continue;
    n._ropeHost = {
      body: host,
      local: { x: mToPx(spec.x ?? 0), y: mToPx(spec.y ?? 0) },
    };
    _setPinnedCollision(n, true);
    _snapNodeToHost(n, host, n._ropeHost.local);
  }
  _stampRopeRestAndCollision(engine);
}

function _stampRopeRestAndCollision(engine) {
  const ids = new Set();
  for (const b of engine.bodies ?? []) {
    if (b._ropeId) ids.add(b._ropeId);
  }
  for (const id of ids) {
    const nodes = listRopeSegments(engine, id);
    const links = _ropeLinksSorted(engine, id);
    const stored = nodes.find(n => n._ropeRestLength > 0)?._ropeRestLength;
    const rest = stored > 0 ? stored : links.reduce((s, c) => s + (c.length || 0), 0);
    _applyRestLength(nodes, links, rest);
    _updateRopeCollision(engine, id);
  }
}
