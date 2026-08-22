/**
 * True-circle contact for round bodies.
 *
 * Matter approximates circles as polygons, so SAT support vertices sit on
 * facets rather than the rim. A normal impulse at an offset vertex applies
 * spurious torque and a vertical kick: a rolling disk chatters / “skips”
 * and bleeds speed as if it had rolling resistance.
 *
 * Before Matter’s velocity solver we rewrite the contact to the geometric
 * rim point along the surface normal so the normal impulse passes through
 * the COM (zero torque) and friction can enforce v = ωR at the true contact.
 */

import Matter from 'matter-js';
import { isRoundBody } from './bodies.js';

const { Pair, Resolver } = Matter;

/**
 * Closest point on a world-space polygon boundary.
 * @param {{ x:number, y:number }[]} verts
 * @returns {{ x:number, y:number, distSq:number }}
 */
export function closestPointOnVertices(verts, px, py) {
  let bestX = px;
  let bestY = py;
  let bestD = Infinity;
  const n = verts?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const ax = verts[i].x;
    const ay = verts[i].y;
    const b = verts[(i + 1) % n];
    const abx = b.x - ax;
    const aby = b.y - ay;
    const ab2 = abx * abx + aby * aby;
    let t = ab2 > 1e-18 ? ((px - ax) * abx + (py - ay) * aby) / ab2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const qx = ax + t * abx;
    const qy = ay + t * aby;
    const dx = px - qx;
    const dy = py - qy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      bestX = qx;
      bestY = qy;
    }
  }
  return { x: bestX, y: bestY, distSq: bestD };
}

/**
 * Geometric circle contact against another hull.
 * Normal points from the other surface toward the circle centre.
 * @returns {{ nx:number, ny:number, tx:number, ty:number, dist:number, depth:number, px:number, py:number }|null}
 */
export function circleContact(dyn, other) {
  const R = dyn?._radius ?? dyn?.circleRadius;
  if (!(R > 1e-6) || !other?.vertices) return null;
  const closest = closestPointOnVertices(other.vertices, dyn.position.x, dyn.position.y);
  let dx = dyn.position.x - closest.x;
  let dy = dyn.position.y - closest.y;
  let dist = Math.hypot(dx, dy);
  if (dist < 1e-8) return null;
  const nx = dx / dist;
  const ny = dy / dist;
  return {
    nx,
    ny,
    tx: -ny,
    ty: nx,
    dist,
    depth: R - dist,
    px: closest.x,
    py: closest.y,
  };
}

function roundRadius(body) {
  return body?._radius ?? body?.circleRadius ?? 0;
}

/** Rewrite SAT pair → circle contact (normal, depth, single rim vertex). */
function rewriteRoundPair(pair) {
  const col = pair?.collision;
  if (!col) return;
  const A = col.parentA;
  const B = col.parentB;
  if (!A || !B) return;

  const roundA = isRoundBody(A);
  const roundB = isRoundBody(B);
  if (!roundA && !roundB) return;
  // Rope nodes are lock-rotated point masses, leave their table contacts to SAT.
  if (A._ropeSegment || B._ropeSegment) return;

  let nx;
  let ny;
  let depth;
  let px;
  let py;

  if (roundA && roundB) {
    const RA = roundRadius(A);
    const RB = roundRadius(B);
    const dx = B.position.x - A.position.x;
    const dy = B.position.y - A.position.y;
    const dist = Math.hypot(dx, dy);
    if (!(dist > 1e-8) || !(RA > 0) || !(RB > 0)) return;
    nx = dx / dist;
    ny = dy / dist;
    depth = RA + RB - dist;
    px = A.position.x + nx * RA;
    py = A.position.y + ny * RA;
  } else {
    const round = roundA ? A : B;
    const other = round === A ? B : A;
    const c = circleContact(round, other);
    if (!c) return;
    depth = c.depth;
    const R = roundRadius(round);
    // Rim point toward the other body (along −n̂ from the centre).
    px = round.position.x - c.nx * R;
    py = round.position.y - c.ny * R;
    // Candidate from A → B, Matter then wants n · (B − A) < 0 (flipped below).
    if (round === B) {
      nx = c.nx;
      ny = c.ny;
    } else {
      nx = -c.nx;
      ny = -c.ny;
    }
  }

  if (!isFinite(nx) || !isFinite(ny) || !isFinite(px) || !isFinite(py)) return;

  // Same orientation SAT uses: normal faces so n · (B − A) < 0.
  const ddx = B.position.x - A.position.x;
  const ddy = B.position.y - A.position.y;
  if (nx * ddx + ny * ddy >= 0) {
    nx = -nx;
    ny = -ny;
  }

  col.normal.x = nx;
  col.normal.y = ny;
  col.tangent.x = -ny;
  col.tangent.y = nx;
  const d = Math.max(0, depth);
  col.depth = d;
  if (col.penetration) {
    col.penetration.x = nx * d;
    col.penetration.y = ny * d;
  }
  pair.separation = d;
  pair.contactCount = 1;
  if (pair.contacts?.[0]) {
    pair.contacts[0].vertex = { x: px, y: py };
  }
}

function snapRoundContactVertices(pairs) {
  if (!pairs) return;
  for (let i = 0; i < pairs.length; i++) {
    rewriteRoundPair(pairs[i]);
  }
}

/**
 * Patch Matter pair + velocity solver so round bodies use rim contacts.
 * Also zeros built-in Coulomb (applied instead by {@link applyCoulombFriction}).
 */
export function installRoundContactSolver() {
  const _pairUpdate = Pair.update;
  Pair.update = function(pair, collision, timestamp) {
    _pairUpdate(pair, collision, timestamp);
    pair.friction = 0;
    pair.frictionStatic = 0;
    rewriteRoundPair(pair);
  };

  const _preSolveVelocity = Resolver.preSolveVelocity;
  Resolver.preSolveVelocity = function(pairs) {
    snapRoundContactVertices(pairs);
    _preSolveVelocity(pairs);
  };

  const _solveVelocity = Resolver.solveVelocity;
  Resolver.solveVelocity = function(pairs, delta) {
    snapRoundContactVertices(pairs);
    _solveVelocity(pairs, delta);
  };
}
