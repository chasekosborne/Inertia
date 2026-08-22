/**
 * Pure measurement evaluation for graphs / sweeps: no SVG layer required.
 *
 * Works against a live PhysicsEngine or recorder frames (+ optional scene doc
 * for constant applied-force anchors).
 */

import { pxToM, mToPx, matterVelToDisplayMS, getVelocityPxPerMs, getForcePxPerN } from '../units.js';
import { getAppliedForce } from '../physics/applied-force.js';
import { wedgeComOffsetFromAABB } from '../physics/bodies.js';
import { constraintAnchorWorld } from '../physics/constraints.js';
import { LabelManager } from './labels.js';

const VEL_TIP_LEN = 72;

/**
 * @typedef {{ x: number, y: number }} Pt
 * @typedef {{
 *   label?: string|null,
 *   type?: string|null,
 *   x: number, y: number,
 *   angle?: number,
 *   vx?: number, vy?: number,
 *   baseWidth?: number|null,
 *   height?: number|null,
 *   width?: number|null,
 *   appliedForce?: { F: number, thetaDeg: number }|null,
 * }} BodyPose
 */

/**
 * @param {import('matter-js').Body} body
 * @returns {BodyPose}
 */
export function poseFromMatterBody(body) {
  const af = getAppliedForce(body);
  return {
    label: typeof body.label === 'string' ? body.label : null,
    type: body._newtonType ?? null,
    x: body.position.x,
    y: body.position.y,
    angle: body.angle ?? 0,
    vx: body.velocity?.x ?? 0,
    vy: body.velocity?.y ?? 0,
    baseWidth: body._baseWidth ?? null,
    height: body._height ?? null,
    width: body._width ?? null,
    appliedForce: af ? { F: af.F, thetaDeg: af.thetaDeg } : null,
  };
}

/**
 * @param {object} frameBody  recorder snapshot
 * @param {object|null} [sceneBody]  matching scene-doc body (for appliedForce)
 * @returns {BodyPose}
 */
export function poseFromFrameBody(frameBody, sceneBody = null) {
  const af = sceneBody?.appliedForce && typeof sceneBody.appliedForce === 'object'
    ? {
      F: Number(sceneBody.appliedForce.F) || 0,
      thetaDeg: Number(sceneBody.appliedForce.thetaDeg) || 0,
    }
    : null;
  return {
    label: frameBody.label ?? sceneBody?.id ?? null,
    type: frameBody.type ?? sceneBody?.type ?? null,
    x: frameBody.x,
    y: frameBody.y,
    angle: frameBody.angle ?? 0,
    vx: frameBody.vx ?? 0,
    vy: frameBody.vy ?? 0,
    baseWidth: frameBody.baseWidth ?? frameBody.bWidth ?? sceneBody?.geometry?.baseWidth ?? null,
    height: frameBody.bHeight
      ?? sceneBody?.geometry?.height
      ?? null,
    width: frameBody.bWidth ?? sceneBody?.geometry?.width ?? null,
    appliedForce: af && af.F > 0 ? af : null,
  };
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @returns {Map<string, BodyPose>}
 */
export function poseMapFromEngine(engine) {
  /** @type {Map<string, BodyPose>} */
  const map = new Map();
  for (const b of engine.bodies) {
    if (b._newtonType === 'metric-basis') continue;
    const pose = poseFromMatterBody(b);
    if (pose.label) map.set(pose.label, pose);
  }
  return map;
}

/**
 * @param {object} frame
 * @param {object|null} [sceneDoc]
 * @returns {Map<string, BodyPose>}
 */
export function poseMapFromFrame(frame, sceneDoc = null) {
  /** @type {Map<string, BodyPose>} */
  const map = new Map();
  const sceneById = new Map();
  for (const b of sceneDoc?.bodies ?? []) {
    if (b?.id) sceneById.set(b.id, b);
  }
  for (const fb of frame?.bodies ?? []) {
    if (fb.type === 'metric-basis') continue;
    const sceneBody = (fb.label && sceneById.get(fb.label)) || null;
    const pose = poseFromFrameBody(fb, sceneBody);
    if (pose.label) map.set(pose.label, pose);
  }
  return map;
}

/**
 * Wedge triangle verts from COM pose (Matter convention).
 * @param {BodyPose} pose
 * @returns {{ bl: Pt, br: Pt, tl: Pt }|null}
 */
export function wedgeVertsFromPose(pose) {
  const W = pose.baseWidth ?? 40;
  const H = pose.height ?? 40;
  if (!(W > 0) || !(H > 0)) return null;
  const o = wedgeComOffsetFromAABB(W, H);
  const ang = pose.angle ?? 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const aabb = {
    x: pose.x - (c * o.x - s * o.y),
    y: pose.y - (s * o.x + c * o.y),
  };
  const hw = W / 2;
  const hh = H / 2;
  const toWorld = (lx, ly) => ({
    x: aabb.x + c * lx - s * ly,
    y: aabb.y + s * lx + c * ly,
  });
  return {
    bl: toWorld(-hw, hh),
    br: toWorld(hw, hh),
    tl: toWorld(-hw, -hh),
  };
}

/**
 * @param {BodyPose} pose
 * @param {'groundA'|'groundB'} which
 * @returns {Pt|null}
 */
function groundEndFromPose(pose, which) {
  const w = pose.width ?? 400;
  const h = pose.height ?? 20;
  const ang = pose.angle ?? 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const hx = w / 2;
  const hy = -h / 2;
  const sign = which === 'groundB' ? 1 : -1;
  return {
    x: pose.x + c * (sign * hx) - s * hy,
    y: pose.y + s * (sign * hx) + c * hy,
  };
}

function tipFromDisplayAngle(origin, angleRad, len) {
  return {
    x: origin.x + Math.cos(angleRad) * len,
    y: origin.y - Math.sin(angleRad) * len,
  };
}

/**
 * @param {object} anchor
 * @param {Map<string, BodyPose>} poses
 * @param {object|null} sceneDoc
 * @returns {Pt|null}
 */
function constraintAnchorFromSceneDoc(anchor, poses, sceneDoc) {
  const cid = anchor.constraintLabel ?? anchor.constraint;
  if (typeof cid !== 'string' || !cid) return null;
  const cd = sceneDoc?.constraints?.find(c => c?.id === cid);
  if (!cd) return null;
  const end = anchor.end === 'B' ? 'B' : 'A';
  const bodyLabel = end === 'A' ? cd.bodyA : cd.bodyB;
  const anchorM = end === 'A' ? cd.anchorA : cd.anchorB;
  const lx = mToPx(anchorM?.x ?? 0);
  const ly = mToPx(anchorM?.y ?? 0);
  if (!bodyLabel) return null;
  const pose = poses.get(bodyLabel);
  if (!pose) return null;
  const ang = pose.angle ?? 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return {
    x: pose.x + c * lx - s * ly,
    y: pose.y + s * lx + c * ly,
  };
}

/** @param {number|null} value @param {object} m */
function applyLengthBaseline(value, m) {
  if (value == null || !Number.isFinite(value)) return value;
  if (m?.baselineM == null || !Number.isFinite(m.baselineM)) return value;
  return value - m.baselineM;
}

/**
 * Resolve a scene/runtime anchor against a label→pose map.
 * @param {object} anchor
 * @param {Map<string, BodyPose>} poses
 * @param {{ engine?: import('../physics/engine.js').PhysicsEngine, sceneDoc?: object|null }} [ctx]
 * @returns {Pt|null}
 */
export function resolveAnchor(anchor, poses, ctx = {}) {
  if (!anchor) return null;
  if (anchor.kind === 'world') {
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  if (anchor.kind === 'constraint') {
    if (ctx.engine) {
      const cid = anchor.constraintLabel ?? anchor.constraint;
      const c = ctx.engine.constraints.find(x => x.label === cid);
      if (c) return constraintAnchorWorld(c, anchor.end === 'B' ? 'B' : 'A');
    }
    if (ctx.sceneDoc) return constraintAnchorFromSceneDoc(anchor, poses, ctx.sceneDoc);
    return null;
  }

  if (anchor.kind === 'label') {
    if (ctx.sceneDoc) return LabelManager.resolveFromScene(anchor, poses, ctx.sceneDoc);
    return null;
  }

  const label = typeof anchor.body === 'string'
    ? anchor.body
    : (typeof anchor.bodyLabel === 'string' ? anchor.bodyLabel : null);
  if (!label) return null;
  const pose = poses.get(label);
  if (!pose) return null;

  if (anchor.kind === 'body') {
    // Wedges: use AABB centre (matches MeasurementManager / wedgeAABBCenterWorld).
    if (pose.type === 'wedge') {
      const W = pose.baseWidth ?? 40;
      const H = pose.height ?? 40;
      const o = wedgeComOffsetFromAABB(W, H);
      const ang = pose.angle ?? 0;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      return {
        x: pose.x - (c * o.x - s * o.y),
        y: pose.y - (s * o.x + c * o.y),
      };
    }
    return { x: pose.x, y: pose.y };
  }

  if (anchor.kind === 'velocity') {
    const { vxMs, vyMs } = matterVelToDisplayMS(pose.vx ?? 0, pose.vy ?? 0);
    const vPx = getVelocityPxPerMs();
    const tip = {
      x: pose.x + vxMs * vPx,
      y: pose.y - vyMs * vPx,
    };
    if (Math.hypot(tip.x - pose.x, tip.y - pose.y) < 1) {
      const speed = Math.hypot(vxMs, vyMs);
      const ux = speed > 1e-9 ? vxMs / speed : 1;
      const uy = speed > 1e-9 ? -vyMs / speed : 0;
      return { x: pose.x + ux * VEL_TIP_LEN, y: pose.y + uy * VEL_TIP_LEN };
    }
    return tip;
  }

  if (anchor.kind === 'force') {
    const af = pose.appliedForce;
    if (!af || !(af.F > 0)) return { x: pose.x, y: pose.y };
    const rad = (af.thetaDeg * Math.PI) / 180;
    const tip = tipFromDisplayAngle(pose, rad, af.F * getForcePxPerN());
    if (Math.hypot(tip.x - pose.x, tip.y - pose.y) < 1) {
      return tipFromDisplayAngle(pose, rad, VEL_TIP_LEN);
    }
    return tip;
  }

  if (anchor.kind === 'ray') {
    const rad = ((anchor.angleDeg ?? 0) * Math.PI) / 180;
    return tipFromDisplayAngle(pose, rad, VEL_TIP_LEN);
  }

  if (anchor.kind === 'horizontal') {
    let dir = anchor.dir ?? 1;
    if (anchor.followVelocityX) {
      const { vxMs } = matterVelToDisplayMS(pose.vx ?? 0, pose.vy ?? 0);
      dir = vxMs < 0 ? -1 : 1;
    }
    return { x: pose.x + dir * VEL_TIP_LEN, y: pose.y };
  }

  if (anchor.kind === 'vertex') {
    if (pose.type === 'wedge') {
      const verts = wedgeVertsFromPose(pose);
      return verts?.[anchor.vertex] ?? null;
    }
    if (pose.type === 'ground') {
      return groundEndFromPose(pose, anchor.vertex);
    }
  }
  return null;
}

/**
 * Resolve an endpoint honouring frozen static pose.
 * @param {object} m  scene or runtime measurement
 * @param {'vertex'|'a'|'b'} key
 * @param {Map<string, BodyPose>} poses
 * @param {{ engine?: import('../physics/engine.js').PhysicsEngine, sceneDoc?: object|null }} [ctx]
 * @returns {Pt|null}
 */
export function resolveMeasurementEnd(m, key, poses, ctx = {}) {
  if (m.dynamic === false && m.frozen?.[key]
    && Number.isFinite(m.frozen[key].x) && Number.isFinite(m.frozen[key].y)) {
    return { x: m.frozen[key].x, y: m.frozen[key].y };
  }
  return resolveAnchor(m[key], poses, ctx);
}

/**
 * Signed angle from reference ray (v→a) to (v→b) in display frame (+y up),
 * CCW positive, range (−180°, 180°]. Pass `{ signed: false }` for the
 * unsigned minor angle (wedge interior marks).
 * @param {Pt} v
 * @param {Pt} a  reference end
 * @param {Pt} b  measured end
 * @param {{ signed?: boolean }} [opts]
 * @returns {number|null} degrees
 */
export function angleDegBetween(v, a, b, opts = {}) {
  // SVG world is +y down, flip y into the display frame used elsewhere.
  let dx0 = a.x - v.x;
  let dy0 = -(a.y - v.y);
  let dx1 = b.x - v.x;
  let dy1 = -(b.y - v.y);
  const l0 = Math.hypot(dx0, dy0);
  const l1 = Math.hypot(dx1, dy1);
  if (l0 < 1e-6 || l1 < 1e-6) return null;
  dx0 /= l0; dy0 /= l0;
  dx1 /= l1; dy1 /= l1;
  const cross = dx0 * dy1 - dy0 * dx1;
  const dot = dx0 * dx1 + dy0 * dy1;
  const signedDeg = (Math.atan2(cross, dot) * 180) / Math.PI;
  if (opts.signed === false) return Math.abs(signedDeg);
  return signedDeg;
}

/**
 * Unwrap a principal-value angle so successive samples can cross ±period/2
 * and accumulate past a full turn (e.g. 370°, −720°).
 *
 * @param {{ prev: number, accum: number }|null|undefined} state
 * @param {number} wrapped  Principal value in (−period/2, period/2]
 * @param {number} [period=360]
 * @returns {{ value: number, state: { prev: number, accum: number } }}
 */
export function unwrapAngleStep(state, wrapped, period = 360) {
  if (!isFinite(wrapped) || !(period > 0)) {
    return { value: wrapped, state: state ?? { prev: wrapped, accum: wrapped } };
  }
  if (!state || !isFinite(state.prev) || !isFinite(state.accum)) {
    return { value: wrapped, state: { prev: wrapped, accum: wrapped } };
  }
  let d = wrapped - state.prev;
  const half = period / 2;
  if (d > half) d -= period;
  else if (d < -half) d += period;
  const accum = state.accum + d;
  return { value: accum, state: { prev: wrapped, accum } };
}

/**
 * Unwrap a sequence of principal-value samples in place (returns new array).
 * @param {number[]} values
 * @param {number} [period=360]
 * @returns {number[]}
 */
export function unwrapAngleSeries(values, period = 360) {
  /** @type {{ prev: number, accum: number }|null} */
  let state = null;
  const out = [];
  for (const w of values) {
    if (w == null || !isFinite(w)) {
      out.push(w);
      continue;
    }
    const step = unwrapAngleStep(state, w, period);
    state = step.state;
    out.push(step.value);
  }
  return out;
}

/** Graphed / labelled length: Euclidean, |Δx|, |Δy|, or the L-path |Δx|+|Δy|. */
export const LENGTH_COMPONENTS = /** @type {const} */ ([
  'distance',
  'dx',
  'dy',
  'manhattan',
]);

/**
 * @param {unknown} raw
 * @returns {'distance'|'dx'|'dy'|'manhattan'}
 */
export function normalizeLengthComponent(raw) {
  if (raw === 'dx' || raw === 'dy' || raw === 'manhattan') return raw;
  return 'distance';
}

/**
 * Display-frame components (+x right, +y up) between two world-px points.
 * @param {Pt} a
 * @param {Pt} b
 * @returns {{ dx: number, dy: number, distance: number, manhattan: number }|null}
 */
export function lengthPartsM(a, b) {
  if (!a || !b) return null;
  const dx = pxToM(b.x - a.x);
  const dy = pxToM(-(b.y - a.y));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const distance = Math.hypot(dx, dy);
  return { dx, dy, distance, manhattan: Math.abs(dx) + Math.abs(dy) };
}

/**
 * @param {{ dx: number, dy: number, distance: number, manhattan: number }} parts
 * @param {string} [component]
 * @returns {number}
 */
export function lengthValueFromParts(parts, component = 'distance', signed = false) {
  const c = normalizeLengthComponent(component);
  if (c === 'dx') return signed ? parts.dx : Math.abs(parts.dx);
  if (c === 'dy') return signed ? parts.dy : Math.abs(parts.dy);
  if (c === 'manhattan') return parts.manhattan;
  return parts.distance;
}

/**
 * @param {Pt} a
 * @param {Pt} b
 * @param {string} [component]
 * @returns {number|null} metres
 */
export function lengthValueM(a, b, component = 'distance', signed = false) {
  const parts = lengthPartsM(a, b);
  if (!parts) return null;
  return lengthValueFromParts(parts, component, signed);
}

/**
 * Euclidean distance in metres.
 * @param {Pt} a
 * @param {Pt} b
 * @returns {number|null} metres
 */
export function lengthMBetween(a, b) {
  return lengthValueM(a, b, 'distance');
}

/**
 * Evaluate a scene/runtime measurement against a pose map.
 * @param {object} m
 * @param {Map<string, BodyPose>} poses
 * @param {{ engine?: import('../physics/engine.js').PhysicsEngine, sceneDoc?: object|null }} [ctx]
 * @returns {number|null}
 */
export function evaluateMeasurement(m, poses, ctx = {}) {
  if (!m) return null;
  if (m.kind === 'angle') {
    const v = resolveMeasurementEnd(m, 'vertex', poses, ctx);
    const a = resolveMeasurementEnd(m, 'a', poses, ctx);
    const b = resolveMeasurementEnd(m, 'b', poses, ctx);
    if (!v || !a || !b) return null;
    return angleDegBetween(v, a, b, { signed: m.signed !== false });
  }
  if (m.kind === 'length') {
    const a = resolveMeasurementEnd(m, 'a', poses, ctx);
    const b = resolveMeasurementEnd(m, 'b', poses, ctx);
    if (!a || !b) return null;
    const signed = m.signed === true && (m.component === 'dx' || m.component === 'dy');
    return applyLengthBaseline(lengthValueM(a, b, m.component, signed), m);
  }
  return null;
}

/**
 * @param {object} m  scene measurement
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {object|null} [sceneDoc]
 * @returns {number|null}
 */
export function evaluateMeasurementOnEngine(m, engine, sceneDoc = null) {
  return evaluateMeasurement(m, poseMapFromEngine(engine), { engine, sceneDoc });
}

/**
 * @param {object} m
 * @param {object} frame
 * @param {object|null} [sceneDoc]
 * @returns {number|null}
 */
export function evaluateMeasurementOnFrame(m, frame, sceneDoc = null) {
  return evaluateMeasurement(m, poseMapFromFrame(frame, sceneDoc), { sceneDoc });
}

/**
 * Whether a scene measurement references a body id (label).
 * @param {object} m
 * @param {string} bodyId
 */
export function measurementRefsBody(m, bodyId) {
  if (!m || !bodyId) return false;
  const anchors = m.kind === 'angle'
    ? [m.vertex, m.a, m.b]
    : [m.a, m.b];
  return anchors.some(a => a && (a.body === bodyId || a.bodyLabel === bodyId));
}

/**
 * If a ray is coupled to a body's velocity or force vector, return that parent.
 * Angle measures may also be standalone (no couple): then returns null.
 * @param {object} m  scene or runtime measurement
 * @returns {{ bodyLabel: string, couple: 'velocity'|'force' }|null}
 */
export function measurementVectorParent(m) {
  if (!m) return null;
  const ends = m.kind === 'angle' || m.kind === 'length' ? [m.a, m.b] : [];
  for (const a of ends) {
    if (!a || (a.kind !== 'velocity' && a.kind !== 'force')) continue;
    const bodyLabel = typeof a.body === 'string' ? a.body
      : (typeof a.bodyLabel === 'string' ? a.bodyLabel : null);
    if (bodyLabel) return { bodyLabel, couple: a.kind };
  }
  return null;
}

/**
 * Display label for graph / sweep UI.
 * @param {object} m
 */
export function measurementDisplayLabel(m) {
  if (!m) return 'measurement';
  if (typeof m.label === 'string' && m.label.trim()) return m.label.trim();
  if (m.kind === 'length') {
    const c = normalizeLengthComponent(m.component);
    if (c === 'dx') return '|Δx|';
    if (c === 'dy') return '|Δy|';
    if (c === 'manhattan') return '|Δx|+|Δy|';
    return m.id || 'length';
  }
  return m.id || (m.kind === 'angle' ? 'angle' : 'length');
}
