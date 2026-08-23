import Matter from 'matter-js';
import {
  mToPx,
  DEFAULT_CIRCLE_RADIUS_M,
  DEFAULT_BALL_RADIUS_M,
  DEFAULT_BOX_SIZE_M,
} from '../units.js';
import { COLORS } from '../theme.js';
import { snapWorldCoord } from '../grid.js';

/** Hull sides for dynamic disks. Matter.Bodies.circle caps sides at pixel radius. */
export const CIRCLE_HULL_SIDES = 32;

const { Bodies, Body, Constraint } = Matter;

let _idCounter = 0;
const nextId = () => ++_idCounter;

/**
 * Default material properties.
 * Matter uses `friction` for kinetic and `frictionStatic` for static.
 * We store both on the body as `_muK` and `_muS` so panels and the
 * renderer can read them directly without touching Matter internals.
 */
const DEFAULTS = {
  mass:        1,
  restitution: 0.5,
  muK:         0.3,    // kinetic friction (dynamic)
  muS:         0.4,    // static friction
  frictionAir: 0.00,
};

/** Apply μk and μs to a Matter body (keeps _muK/_muS in sync). */
export function setMaterialFriction(body, muK, muS) {
  body.friction         = muK;
  body.frictionStatic   = muS;
  body._muK             = muK;
  body._muS             = muS;
}

/**
 * Anchor / un-anchor a body (Matter `isStatic`).
 * Anchored bodies ignore gravity and do not receive collision impulses: like ground.
 * Call after mass is finalized, Matter's create-time `isStatic` + later `setMass` breaks inverseMass.
 */
export function setBodyAnchored(body, anchored) {
  if (!body) return;
  const want = !!anchored;
  const rest = body.restitution;
  const muK = body._muK ?? body.friction ?? DEFAULTS.muK;
  const muS = body._muS ?? body.frictionStatic ?? DEFAULTS.muS;

  if (want) {
    Body.setVelocity(body, { x: 0, y: 0 });
    Body.setAngularVelocity(body, 0);
    body.force.x = 0;
    body.force.y = 0;
    body.torque = 0;
    if (!body.isStatic || body.inverseMass !== 0) {
      Body.setStatic(body, true);
    }
    // Matter.setStatic zeros restitution / sets friction=1: restore material for bounce-off & panels.
    body.restitution = rest;
    if (body._original) body._original.restitution = rest;
    setMaterialFriction(body, muK, muS);
  } else if (body.isStatic) {
    Body.setStatic(body, false);
    setMaterialFriction(body, muK, muS);
    if (rest != null && isFinite(rest)) body.restitution = rest;
  }
}

/** Mass for panels: Matter reports Infinity while static. */
export function bodyDisplayMass(body) {
  if (!body) return 1;
  if (body.isStatic && body._original?.mass != null && isFinite(body._original.mass)) {
    return body._original.mass;
  }
  return isFinite(body.mass) ? body.mass : 1;
}

/**
 * Textbook planar inertia for a round body (Matter’s setMass / polygon scale
 * inflate I by Body._inertiaScale ≈ 4 and break rolling ↔ translation coupling).
 *
 * Solid disk: I = ½ m r², hollow ring: I = m r².
 * @param {import('matter-js').Body} body
 */
export function applyCircleInertia(body) {
  if (!body || !isRoundBody(body)) return;
  if (body._lockRotation || body.inertia === Infinity) return;
  const r = body._radius ?? body.circleRadius;
  const m = body.mass;
  if (!(r > 0) || !(m > 0) || !isFinite(m)) return;
  const I = body._hollow === true ? m * r * r : 0.5 * m * r * r;
  Body.setInertia(body, I);
}

/** Set mass, preserves anchored state. Round bodies keep finite disk/ring inertia. */
export function setBodyMass(body, mass) {
  if (!body || !(mass > 0) || !isFinite(mass)) return;
  const wasAnchored = !!body.isStatic;
  if (wasAnchored) Body.setStatic(body, false);
  Body.setMass(body, mass);
  applyCircleInertia(body);
  if (wasAnchored) setBodyAnchored(body, true);
}

/**
 * Shared Matter circle / ball: finite disk inertia so friction can roll or slip.
 * @param {'point-mass'|'ball'} newtonType
 */
function _createCircleBody(x, y, opts, newtonType, defaultRadiusM, labelPrefix) {
  const r    = opts.radius ?? mToPx(defaultRadiusM);
  const mass = opts.mass   ?? DEFAULTS.mass;
  const muK  = opts.muK ?? opts.friction ?? DEFAULTS.muK;
  const muS  = opts.muS ?? opts.frictionStatic ?? DEFAULTS.muS;
  const circleOpts = {
    restitution:    opts.restitution ?? DEFAULTS.restitution,
    friction:       muK,
    frictionStatic: muS,
    frictionAir:    opts.frictionAir ?? DEFAULTS.frictionAir,
    isStatic:       false,
    label: `${labelPrefix}_${nextId()}`,
  };
  if (Number.isFinite(opts.slop)) circleOpts.slop = opts.slop;
  if (opts.collisionFilter) circleOpts.collisionFilter = opts.collisionFilter;
  // Bodies.circle caps sides at pixel radius, so small disks become 10-gons and
  // chatter when rolling. Rope nodes stay as cheap default circles.
  const body = opts.ropeSegment
    ? Bodies.circle(x, y, r, circleOpts)
    : Bodies.polygon(x, y, CIRCLE_HULL_SIDES, r, circleOpts);
  body.circleRadius = r;
  Body.setMass(body, mass);
  body._newtonType = newtonType;
  body._radius     = r;
  body._muK        = muK;
  body._muS        = muS;
  if (opts.ropeSegment) body._ropeSegment = true;
  if (newtonType === 'point-mass') {
    // Filled particle by default; user can switch to a hollow ring in properties.
    body._hollow = opts.hollow === true;
  }
  applyCircleInertia(body);
  // Rope nodes are point masses: spin from polygon contacts makes chains explode.
  if (opts.ropeSegment) {
    body._lockRotation = true;
    Body.setInertia(body, Infinity);
    Body.setAngularVelocity(body, 0);
  }
  if (opts.isStatic) setBodyAnchored(body, true);
  return body;
}

/**
 * Point mass: diameter matches the default box ({@link DEFAULT_BOX_SIZE_M}).
 * Drawn as a filled particle (ink); set `hollow: true` for a ring.
 * Physics type id remains `point-mass` for scenes. Finite inertia → can roll.
 */
export function createPointMass(x, y, opts = {}) {
  return _createCircleBody(x, y, opts, 'point-mass', DEFAULT_CIRCLE_RADIUS_M, 'point');
}

/** Alias: same as {@link createPointMass}. */
export function createCircle(x, y, opts = {}) {
  return createPointMass(x, y, opts);
}

/**
 * Solid ball: smaller filled disk, rolls or slips under Coulomb friction.
 */
export function createBall(x, y, opts = {}) {
  return _createCircleBody(x, y, opts, 'ball', DEFAULT_BALL_RADIUS_M, 'ball');
}

/** True for round dynamic bodies (circle or solid ball). */
export function isRoundBody(body) {
  return body?._newtonType === 'point-mass' || body?._newtonType === 'ball';
}

/** Fill / outline for textbook-style rigid boxes (outline sits inside physics bounds). */
export const BOX_FILL_HEX = '#cccccc';
/** Same soft off-black as other outlined diagram objects ({@link COLORS.ink}). */
export const BOX_STROKE_HEX = COLORS.ink;

/**
 * Black outline thickness (px). Inset rendering uses this so the stroke’s outer edge
 * matches the Matter rectangle (outline is part of the hitbox).
 */
export function boxOutlineStrokePx(w, h) {
  const m = Math.min(w, h);
  if (!(m > 0) || !isFinite(m)) return 0.75;
  const sIdeal = Math.max(0.75, Math.min(2.25, 0.055 * m));
  return Math.min(sIdeal, 0.98 * m);
}

/** Fixed circle outline thickness (px): same at every radius after scaling. */
export const CIRCLE_OUTLINE_STROKE_PX = (() => {
  const r0 = mToPx(DEFAULT_CIRCLE_RADIUS_M);
  return Math.min(Math.max(0.75, 0.05 * 2 * r0), 0.2 * r0);
})();

/** Stroke width for a circle outline / ring (outer edge ≈ Matter radius). */
export function circleRingStrokePx(r) {
  if (!(r > 0) || !isFinite(r)) return CIRCLE_OUTLINE_STROKE_PX;
  // Keep stroke constant when scaling, only shrink for very small circles.
  return Math.min(CIRCLE_OUTLINE_STROKE_PX, 0.98 * 2 * r);
}

/**
 * Create a rigid box (default side = {@link DEFAULT_BOX_SIZE_M}).
 */
export function createBox(x, y, opts = {}) {
  const side = mToPx(DEFAULT_BOX_SIZE_M);
  const w    = opts.width  ?? side;
  const h    = opts.height ?? side;
  const mass = opts.mass   ?? DEFAULTS.mass;
  const muK  = opts.muK ?? opts.friction ?? DEFAULTS.muK;
  const muS  = opts.muS ?? opts.frictionStatic ?? DEFAULTS.muS;
  const rectOpts = {
    restitution: opts.restitution ?? DEFAULTS.restitution,
    friction:       muK,
    frictionStatic: muS,
    frictionAir: opts.frictionAir ?? DEFAULTS.frictionAir,
    isStatic:    false,
    angle: opts.angle ?? 0,
    label: `box_${nextId()}`,
  };
  if (opts.collisionFilter) rectOpts.collisionFilter = opts.collisionFilter;
  if (opts.ropeSegment) {
    // Rounded collision corners slide over table edges, SVG stroke stays square.
    const cr = Math.min(h * 0.45, w * 0.25, h / 2 - 0.05);
    if (cr > 0.5) rectOpts.chamfer = { radius: cr };
  }
  const body = Bodies.rectangle(x, y, w, h, rectOpts);
  Body.setMass(body, mass);
  body._newtonType = 'box';
  body._width  = w;
  body._height = h;
  body._muK    = muK;
  body._muS    = muS;
  if (opts.ropeSegment) body._ropeSegment = true;
  if (opts.isStatic) setBodyAnchored(body, true);
  return body;
}

const MIN_BOX_PX = 8;
const MIN_CIRCLE_R_PX = 4;

/** Scale a box to new width/height (px), preserving centre. */
export function scaleBoxTo(body, nw, nh, minPx = MIN_BOX_PX) {
  const ow = body._width ?? 40;
  const oh = body._height ?? 40;
  nw = Math.max(minPx, nw);
  nh = Math.max(minPx, nh);
  if (Math.abs(nw - ow) < 1e-6 && Math.abs(nh - oh) < 1e-6) return;
  Body.scale(body, nw / ow, nh / oh, body.position);
  body._width  = nw;
  body._height = nh;
}

/** Scale a circle (point-mass) to a new radius (px), preserving centre. */
export function scaleCircleTo(body, newR, minPx = MIN_CIRCLE_R_PX) {
  const oldR = body.circleRadius ?? body._radius ?? minPx;
  newR = Math.max(minPx, newR);
  if (Math.abs(newR - oldR) < 1e-6) return;
  if (oldR > 1e-6) {
    const s = newR / oldR;
    Body.scale(body, s, s, body.position);
  }
  body._radius = newR;
  // Body.scale multiplies Matter’s inflated inertia: restore textbook disk/ring I.
  applyCircleInertia(body);
}

const MIN_WEDGE_PX = 8;
const MIN_FOOT_ANGLE_RAD = (5 * Math.PI) / 180;
const MAX_FOOT_ANGLE_RAD = (85 * Math.PI) / 180;

/** Acute angle at the right foot: always atan(height / base) for a right triangle. */
export function defaultWedgeFootAngle(baseW, height) {
  if (!(baseW > 0) || !(height > 0)) return Math.PI / 4;
  return clampWedgeFootAngle(Math.atan(height / baseW));
}

export function clampWedgeFootAngle(angleRad) {
  return Math.max(MIN_FOOT_ANGLE_RAD, Math.min(MAX_FOOT_ANGLE_RAD, angleRad));
}

/**
 * Right-triangle verts before any COM shift (AABB centred at origin, +y down).
 * Default: right angle at bottom-left, base along +x, vertical on the left.
 * `flipX` / `flipY` mirror across the AABB midlines (invert via scale drag).
 * Returns [rightAngle, foot, verticalApex].
 */
export function wedgeRawVerts(baseW, height, flipX = false, flipY = false) {
  const hw = baseW / 2;
  const hh = height / 2;
  let ra = { x: -hw, y: hh };
  let foot = { x: hw, y: hh };
  let apex = { x: -hw, y: -hh };
  if (flipX) {
    ra = { x: hw, y: ra.y };
    foot = { x: -hw, y: foot.y };
    apex = { x: hw, y: apex.y };
  }
  if (flipY) {
    ra = { x: ra.x, y: -ra.y };
    foot = { x: foot.x, y: -foot.y };
    apex = { x: apex.x, y: -apex.y };
  }
  return [ra, foot, apex];
}

/** @param {import('matter-js').Body|null|undefined} body */
export function wedgeFlipFlags(body) {
  return {
    flipX: body?._wedgeFlipX === true,
    flipY: body?._wedgeFlipY === true,
  };
}

/**
 * COM offset from AABB centre for {@link wedgeRawVerts} (local, unrotated).
 * Matter stores the body at the COM; layout/snap use AABB centre.
 */
export function wedgeComOffsetFromAABB(baseW, height, flipX = false, flipY = false) {
  const [ra, foot, apex] = wedgeRawVerts(baseW, height, flipX, flipY);
  return {
    x: (ra.x + foot.x + apex.x) / 3,
    y: (ra.y + foot.y + apex.y) / 3,
  };
}

/** Vertices centred on the triangle centroid (Matter body / SVG at body.position). */
export function wedgeVertsCentred(baseW, height, flipX = false, flipY = false) {
  const o = wedgeComOffsetFromAABB(baseW, height, flipX, flipY);
  return wedgeRawVerts(baseW, height, flipX, flipY).map(v => ({ x: v.x - o.x, y: v.y - o.y }));
}

/**
 * Inset a simple convex polygon by `dist` so a centred SVG stroke’s outer edge
 * matches the original verts (same idea as {@link boxOutlineStrokePx} inset rects).
 * @param {{ x: number, y: number }[]} verts
 * @param {number} dist
 * @returns {{ x: number, y: number }[]}
 */
export function insetPolygonVerts(verts, dist) {
  const n = verts?.length ?? 0;
  if (n < 3 || !(dist > 0)) return verts?.map(v => ({ x: v.x, y: v.y })) ?? [];

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    area2 += a.x * b.y - b.x * a.y;
  }
  // Positive area2 ⇒ CCW in math coords, inward is left of each edge.
  const inward = area2 >= 0 ? 1 : -1;

  const offset = [];
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = inward * (-dy / len);
    const ny = inward * (dx / len);
    offset.push({
      ax: a.x + nx * dist,
      ay: a.y + ny * dist,
      bx: b.x + nx * dist,
      by: b.y + ny * dist,
    });
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const e0 = offset[(i + n - 1) % n];
    const e1 = offset[i];
    const den = (e0.ax - e0.bx) * (e1.ay - e1.by) - (e0.ay - e0.by) * (e1.ax - e1.bx);
    if (Math.abs(den) < 1e-12) {
      out.push({ x: e1.ax, y: e1.ay });
      continue;
    }
    const t = ((e0.ax - e1.ax) * (e1.ay - e1.by) - (e0.ay - e1.ay) * (e1.ax - e1.bx)) / den;
    out.push({
      x: e0.ax + t * (e0.bx - e0.ax),
      y: e0.ay + t * (e0.by - e0.ay),
    });
  }
  return out;
}

/** Stroke width for a wedge outline (outer edge ≈ AABB triangle). */
export function wedgeOutlineStrokePx(baseW, height) {
  return boxOutlineStrokePx(baseW, height);
}

/** World-space AABB centre (layout origin: same role as a box’s centre). */
export function wedgeAABBCenterWorld(body, flipX = undefined, flipY = undefined) {
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const flags = wedgeFlipFlags(body);
  const fx = flipX !== undefined ? flipX === true : flags.flipX;
  const fy = flipY !== undefined ? flipY === true : flags.flipY;
  const o = wedgeComOffsetFromAABB(W, H, fx, fy);
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: body.position.x - (c * o.x - s * o.y),
    y: body.position.y - (s * o.x + c * o.y),
  };
}

/** Place the body so its AABB centre is at (ax, ay). */
export function setWedgeAABBCenter(body, ax, ay) {
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const { flipX, flipY } = wedgeFlipFlags(body);
  const o = wedgeComOffsetFromAABB(W, H, flipX, flipY);
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  Body.setPosition(body, {
    x: ax + c * o.x - s * o.y,
    y: ay + s * o.x + c * o.y,
  });
}

/** Radians: treat as axis-aligned if within this of a multiple of 90°. */
const WEDGE_CARDINAL_SNAP_RAD = (2.5 * Math.PI) / 180;

/**
 * Snap a wedge onto the world grid.
 *
 * At (near) 0°/90°/180°/270°, the legs are axis-aligned: snapping the world
 * AABB's min corner keeps edges on grid lines even when half-extents are odd
 * multiples of the cell (AABB-centre snap alone would leave verts off-grid).
 * Otherwise fall back to snapping the layout AABB centre.
 *
 * @param {import('matter-js').Body} body
 * @param {boolean} [enabled=true]
 * @returns {boolean} true if the body was moved
 */
export function snapWedgeToGrid(body, enabled = true) {
  if (!enabled || body?._newtonType !== 'wedge') return false;

  const tau = Math.PI * 2;
  let a = body.angle % tau;
  if (a < 0) a += tau;
  const quarter = Math.PI / 2;
  const k = Math.round(a / quarter);
  const cardinal = (k * quarter) % tau;
  let err = Math.abs(a - cardinal);
  err = Math.min(err, tau - err);

  const before = wedgeAABBCenterWorld(body);

  if (err <= WEDGE_CARDINAL_SNAP_RAD) {
    const t = wedgeTriangleWorldVerts(body);
    const xs = [t.bl.x, t.br.x, t.tl.x];
    const ys = [t.bl.y, t.br.y, t.tl.y];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const dx = snapWorldCoord(minX, true) - minX;
    const dy = snapWorldCoord(minY, true) - minY;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return false;
    setWedgeAABBCenter(body, before.x + dx, before.y + dy);
    return true;
  }

  const ax = snapWorldCoord(before.x, true);
  const ay = snapWorldCoord(before.y, true);
  if (Math.abs(ax - before.x) < 1e-9 && Math.abs(ay - before.y) < 1e-9) return false;
  setWedgeAABBCenter(body, ax, ay);
  return true;
}

/** Small visual pad so scale handles sit just outside the edges. */
export const WEDGE_HANDLE_OUTSET_PX = 8;

/**
 * Scale-handle positions in AABB-centred local coords.
 * `W`: outside the foot tip (base), `H`: outside the vertical apex.
 */
export function wedgeScaleHandleLocal(
  baseW, height, edge, outsetPx = WEDGE_HANDLE_OUTSET_PX, flipX = false, flipY = false,
) {
  const [ra, foot, apex] = wedgeRawVerts(baseW, height, flipX, flipY);
  if (edge === 'W') {
    const vx = (ra.x + apex.x) / 2;
    const vy = (ra.y + apex.y) / 2;
    const dx = foot.x - vx;
    const dy = foot.y - vy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: foot.x + (dx / len) * outsetPx, y: foot.y + (dy / len) * outsetPx };
  }
  if (edge === 'H') {
    const dx = apex.x - ra.x;
    const dy = apex.y - ra.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: apex.x + (dx / len) * outsetPx, y: apex.y + (dy / len) * outsetPx };
  }
  return { x: 0, y: 0 };
}

/** World → AABB-local (same convention as a box centre). */
export function worldToWedgeAABBLocal(body, wx, wy) {
  const aabb = wedgeAABBCenterWorld(body);
  const dx = wx - aabb.x;
  const dy = wy - aabb.y;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/** AABB-local → world. */
export function wedgeAABBLocalToWorld(body, lx, ly) {
  const aabb = wedgeAABBCenterWorld(body);
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: aabb.x + c * lx - s * ly,
    y: aabb.y + s * lx + c * ly,
  };
}

/**
 * World vertices of the right △.
 * `bl`: 90°, `br`: foot, `tl`: vertical apex (opposite the right angle on the vertical).
 */
export function wedgeTriangleWorldVerts(body) {
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const { flipX, flipY } = wedgeFlipFlags(body);
  const [ra, foot, apex] = wedgeRawVerts(W, H, flipX, flipY);
  return {
    bl: wedgeAABBLocalToWorld(body, ra.x, ra.y),
    br: wedgeAABBLocalToWorld(body, foot.x, foot.y),
    tl: wedgeAABBLocalToWorld(body, apex.x, apex.y),
  };
}

/** Foot angle from pointer in AABB-local coords (right foot at (+W/2, +H/2)). */
export function footAngleFromAABBLocal(loc, baseW, height) {
  const hw = baseW / 2;
  const hh = height / 2;
  const br = { x: hw, y: hh };
  const bl = { x: -hw, y: hh };
  const vBase = { x: bl.x - br.x, y: bl.y - br.y };
  const vPtr = { x: loc.x - br.x, y: loc.y - br.y };
  const blen = Math.hypot(vBase.x, vBase.y);
  const plen = Math.hypot(vPtr.x, vPtr.y);
  if (blen < 1e-6 || plen < 1e-6) return defaultWedgeFootAngle(baseW, height);
  const dot = (vBase.x * vPtr.x + vBase.y * vPtr.y) / (blen * plen);
  const cross = (vBase.x * vPtr.y - vBase.y * vPtr.x) / (blen * plen);
  return clampWedgeFootAngle(Math.atan2(Math.abs(cross), Math.max(-1, Math.min(1, dot))));
}

/** Top (vertical-apex) angle from pointer: at TL (−W/2, −H/2). */
export function topAngleFromAABBLocal(loc, baseW, height) {
  const hw = baseW / 2;
  const hh = height / 2;
  const tl = { x: -hw, y: -hh };
  const bl = { x: -hw, y: hh };
  // Along vertical toward base
  const vVert = { x: bl.x - tl.x, y: bl.y - tl.y };
  const vPtr = { x: loc.x - tl.x, y: loc.y - tl.y };
  const vlen = Math.hypot(vVert.x, vVert.y);
  const plen = Math.hypot(vPtr.x, vPtr.y);
  if (vlen < 1e-6 || plen < 1e-6) {
    return clampWedgeFootAngle(Math.atan2(baseW, height)); // β = atan(W/H)
  }
  const dot = (vVert.x * vPtr.x + vVert.y * vPtr.y) / (vlen * plen);
  const cross = (vVert.x * vPtr.y - vVert.y * vPtr.x) / (vlen * plen);
  return clampWedgeFootAngle(Math.atan2(Math.abs(cross), Math.max(-1, Math.min(1, dot))));
}

/** Acute top angle β = atan(base / height). */
export function defaultWedgeTopAngle(baseW, height) {
  if (!(baseW > 0) || !(height > 0)) return Math.PI / 4;
  return clampWedgeFootAngle(Math.atan(baseW / height));
}

/**
 * Foot ∠ with vertical (opp. side) held fixed.
 * @returns {{ baseWidth: number, height: number }}
 */
export function wedgeSizeFromFootAngleKeepHeight(heightPx, footAngleRad) {
  const a = clampWedgeFootAngle(footAngleRad);
  const tanA = Math.tan(a);
  return {
    baseWidth: Math.max(MIN_WEDGE_PX, heightPx / Math.max(tanA, 1e-6)),
    height: Math.max(MIN_WEDGE_PX, heightPx),
  };
}

/**
 * Top ∠ with base (opp. side) held fixed.
 * @returns {{ baseWidth: number, height: number }}
 */
export function wedgeSizeFromTopAngleKeepWidth(baseWidthPx, topAngleRad) {
  const b = clampWedgeFootAngle(topAngleRad);
  const tanB = Math.tan(b);
  return {
    baseWidth: Math.max(MIN_WEDGE_PX, baseWidthPx),
    height: Math.max(MIN_WEDGE_PX, baseWidthPx / Math.max(tanB, 1e-6)),
  };
}

/**
 * Rebuild right-triangle wedge verts.
 * @param {{ pin?: 'centre'|'left'|'bottom'|'corner'|'topLeft'|'bottomRight',
 *           pinFlipX?: boolean, pinFlipY?: boolean }} [opts]
 *   `centre` (default): keep AABB centre.
 *   `left`: keep the vertical leg fixed in world.
 *   `bottom`: keep the base leg fixed in world.
 *   `corner`: keep the right-angle corner fixed.
 *   `topLeft`: keep the vertical apex fixed (opp. the foot).
 *   `bottomRight`: keep the foot fixed (opp. the vertical apex).
 *   `pinFlipX` / `pinFlipY`: flips that were active when the pin edge was measured
 *   (defaults to the body's current flips).
 */
export function setWedgeGeometry(body, baseW, height, opts = {}) {
  const W = Math.max(MIN_WEDGE_PX, baseW);
  const H = Math.max(MIN_WEDGE_PX, height);
  const pin = opts.pin ?? 'centre';
  const W0 = body._baseWidth ?? W;
  const H0 = body._height ?? H;
  const { flipX, flipY } = wedgeFlipFlags(body);
  const flipX0 = opts.pinFlipX !== undefined ? opts.pinFlipX === true : flipX;
  const flipY0 = opts.pinFlipY !== undefined ? opts.pinFlipY === true : flipY;
  // When flips just changed, Matter pose still matches pinFlip* — use those for AABB.
  const aabb0 = wedgeAABBCenterWorld(body, flipX0, flipY0);
  const angle = body.angle;
  const mass = body.mass;
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  const localToWorld = (ox, oy, lx, ly) => ({
    x: ox + c * lx - s * ly,
    y: oy + s * lx + c * ly,
  });

  const vertX = (fl, w) => (fl ? w / 2 : -w / 2);
  const baseY = (fl, h) => (fl ? -h / 2 : h / 2);

  let aabb = { ...aabb0 };
  if (pin === 'left') {
    const vx0 = vertX(flipX0, W0);
    const vx1 = vertX(flipX, W);
    const left = localToWorld(aabb0.x, aabb0.y, vx0, 0);
    aabb = {
      x: left.x - (c * vx1 - s * 0),
      y: left.y - (s * vx1 + c * 0),
    };
  } else if (pin === 'bottom') {
    const by0 = baseY(flipY0, H0);
    const by1 = baseY(flipY, H);
    const bot = localToWorld(aabb0.x, aabb0.y, 0, by0);
    aabb = {
      x: bot.x - (c * 0 - s * by1),
      y: bot.y - (s * 0 + c * by1),
    };
  } else if (pin === 'corner') {
    const [ra0] = wedgeRawVerts(W0, H0, flipX0, flipY0);
    const [ra1] = wedgeRawVerts(W, H, flipX, flipY);
    const corner = localToWorld(aabb0.x, aabb0.y, ra0.x, ra0.y);
    aabb = {
      x: corner.x - (c * ra1.x - s * ra1.y),
      y: corner.y - (s * ra1.x + c * ra1.y),
    };
  } else if (pin === 'topLeft') {
    const [, , apex0] = wedgeRawVerts(W0, H0, flipX0, flipY0);
    const [, , apex1] = wedgeRawVerts(W, H, flipX, flipY);
    const tl = localToWorld(aabb0.x, aabb0.y, apex0.x, apex0.y);
    aabb = {
      x: tl.x - (c * apex1.x - s * apex1.y),
      y: tl.y - (s * apex1.x + c * apex1.y),
    };
  } else if (pin === 'bottomRight') {
    const [, foot0] = wedgeRawVerts(W0, H0, flipX0, flipY0);
    const [, foot1] = wedgeRawVerts(W, H, flipX, flipY);
    const br = localToWorld(aabb0.x, aabb0.y, foot0.x, foot0.y);
    aabb = {
      x: br.x - (c * foot1.x - s * foot1.y),
      y: br.y - (s * foot1.x + c * foot1.y),
    };
  }

  body._baseWidth = W;
  body._height = H;
  body._footAngle = defaultWedgeFootAngle(W, H);

  // Matter stores verts in world space tracked by body.angle. Apply unrotated
  // COM-local verts at angle 0, then restore angle: avoids double-rotation /
  // desync that breaks bounds & hit-testing after scale.
  const localVerts = wedgeVertsCentred(W, H, flipX, flipY);
  Body.setAngle(body, 0);
  const pos = body.position;
  Body.setVertices(body, localVerts.map(v => ({
    x: pos.x + v.x,
    y: pos.y + v.y,
  })));
  // Flatten any compound parts left over from Bodies.fromVertices so hit-tests
  // use the updated parent vertices (parts.length > 1 skips the parent).
  if (body.parts && body.parts.length > 1) {
    Body.setParts(body, [body], true);
  }
  Body.setMass(body, mass);
  Body.setAngle(body, angle);
  setWedgeAABBCenter(body, aabb.x, aabb.y);
}

/**
 * True if world point lies inside the wedge’s triangle (AABB footprint).
 * Used for selection hit-tests so hollow outline + Matter parts cannot desync UI.
 */
export function wedgeContainsWorldPoint(body, wx, wy, padPx = 4) {
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const loc = worldToWedgeAABBLocal(body, wx, wy);
  const hw = W / 2 + padPx;
  const hh = H / 2 + padPx;
  if (Math.abs(loc.x) > hw + 1 || Math.abs(loc.y) > hh + 1) return false;

  const { flipX, flipY } = wedgeFlipFlags(body);
  let [a, b, c] = wedgeRawVerts(W, H, flipX, flipY);
  if (padPx > 0) {
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    const expand = (p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * padPx, y: p.y + (dy / len) * padPx };
    };
    a = expand(a);
    b = expand(b);
    c = expand(c);
  }
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(loc, a, b);
  const d2 = sign(loc, b, c);
  const d3 = sign(loc, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Scale wedge base / height, optional edge pin (see {@link setWedgeGeometry}). */
export function scaleWedgeTo(body, baseW, height, opts = {}) {
  setWedgeGeometry(body, baseW, height, opts);
}

/**
 * Right-triangle wedge: same default AABB as the box ({@link DEFAULT_BOX_SIZE_M}).
 * `(x, y)` is the AABB centre (matches box placement / grid snap).
 */
export function createWedge(x, y, opts = {}) {
  const side = mToPx(DEFAULT_BOX_SIZE_M);
  let baseW = opts.baseWidth ?? opts.width ?? side;
  let height = opts.height ?? side;
  if (opts.footAngle != null && opts.height == null) {
    height = Math.max(MIN_WEDGE_PX, baseW * Math.tan(clampWedgeFootAngle(opts.footAngle)));
  } else if (opts.footAngle != null && opts.baseWidth == null && opts.width == null) {
    baseW = Math.max(MIN_WEDGE_PX, height / Math.tan(clampWedgeFootAngle(opts.footAngle)));
  }
  const mass = opts.mass ?? DEFAULTS.mass;
  const muK = opts.muK ?? opts.friction ?? DEFAULTS.muK;
  const muS = opts.muS ?? opts.frictionStatic ?? DEFAULTS.muS;
  const localVerts = wedgeVertsCentred(baseW, height, opts.flipX === true, opts.flipY === true);
  const body = Bodies.fromVertices(x, y, [localVerts], {
    restitution: opts.restitution ?? DEFAULTS.restitution,
    friction: muK,
    frictionStatic: muS,
    frictionAir: opts.frictionAir ?? DEFAULTS.frictionAir,
    isStatic: false,
    label: `wedge_${nextId()}`,
  });
  Body.setMass(body, mass);
  body._newtonType = 'wedge';
  body._baseWidth = Math.max(MIN_WEDGE_PX, baseW);
  body._height = Math.max(MIN_WEDGE_PX, height);
  body._footAngle = defaultWedgeFootAngle(body._baseWidth, body._height);
  body._muK = muK;
  body._muS = muS;
  if (opts.flipX === true) body._wedgeFlipX = true;
  if (opts.flipY === true) body._wedgeFlipY = true;
  // Flatten fromVertices parts + place by AABB centre (same as box placement).
  setWedgeGeometry(body, body._baseWidth, body._height, { pin: 'centre' });
  setWedgeAABBCenter(body, x, y);
  if (opts.isStatic) setBodyAnchored(body, true);
  return body;
}

/**
 * Create a static pivot anchor: triangle with pivot circle at the apex
 * (body.position = constraint attachment).
 */
export function createAnchor(x, y) {
  const body = Bodies.circle(x, y, 6, {
    isStatic: true,
    collisionFilter: { mask: 0 },
    label: `anchor_${nextId()}`,
  });
  body._newtonType = 'anchor';
  return body;
}

/**
 * Create the draggable metric basis: +x (blue) and +y (red) in screen space.
 * No collisions, defines where panel coordinates (0,0) sit in world px.
 */
export function createMetricBasis(x, y) {
  const r = 22;
  const body = Bodies.circle(x, y, r, {
    isStatic:       true,
    isSensor:       true,
    collisionFilter: { mask: 0 },
    label:          'metric_basis',
  });
  body._newtonType = 'metric-basis';
  body._radius     = r;
  body._basisArmPx = 36;
  return body;
}

/**
 * Create a static ground segment (thick static rectangle).
 * Matter stores the body at the rectangle centre, width runs along local +x,
 * then `angle` rotates the slab in the world plane.
 */
export function createGround(x, y, width = 400, height = 20, opts = {}) {
  const muK = opts.muK ?? 0.6;
  const muS = opts.muS ?? 0.8;
  const body = Bodies.rectangle(x, y, width, height, {
    isStatic:       true,
    friction:       muK,
    frictionStatic: muS,
    restitution:    opts.restitution ?? 0.3,
    angle:          opts.angle ?? 0,
    label: `ground_${nextId()}`,
  });
  body._newtonType = 'ground';
  body._width  = width;
  body._height = height;
  body._muK    = muK;
  body._muS    = muS;
  return body;
}

/**
 * Create a string constraint between two bodies (or body + world point).
 * A "string" only pulls (length = rest length), modelled as a stiff constraint
 * that can go slack by using a very short stiffness when stretched.
 *
 * For now we model it as a standard Matter constraint with stiffness=1 and
 * damping=0 (ideal inextensible string approximation).
 */
export function createString(bodyA, bodyB, opts = {}) {
  const c = Constraint.create({
    bodyA,
    bodyB,
    pointA: opts.pointA ?? { x: 0, y: 0 },
    pointB: opts.pointB ?? { x: 0, y: 0 },
    length:    opts.length    ?? undefined,   // auto from current positions
    stiffness: opts.stiffness ?? 0.9,
    damping:   opts.damping   ?? 0.01,
    label: `string_${nextId()}`,
  });
  c._newtonType = 'string';
  return c;
}

/** Anchor a constraint to a fixed world point (no bodyA). */
export function anchorToWorld(c, worldPoint) {
  c.bodyA  = null;
  c.pointA = { ...worldPoint };
}
