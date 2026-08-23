/**
 * Floating graph windows: recorded observables vs time, or parameter sweeps.
 *
 * Position y uses textbook +y up (negated Matter display metres).
 * Velocities use {@link matterVelToDisplayMS} (+y up).
 *
 * Hover the plot: wheel zooms, drag pans, 0 resets to recorded bounds.
 */

import { PX_PER_M, matterVelToDisplayMS } from '../units.js';
import { FONT_DIAGRAM, COLORS } from '../theme.js';
import { ExperimentRunner } from '../experiment/runner.js';
import { paramsForScene } from '../experiment/params.js';
import { metricsForScene } from '../experiment/metrics.js';
import { cloneSceneDocument } from '../scene/serialize.js';
import { MATH_PLAIN, setSvgAxisTitle } from '../math-text.js';
import { FIT_MODELS, fit, sampleFit, FitError, fmtNum } from '../fit/index.js';
import {
  copyText,
  formatDesmosListsFromSeries,
  formatDesmosEquation,
  formatDesmosRegression,
  formatDesmosBundle,
  openInDesmos,
} from '../export/desmos.js';
import { exportRecordingVideo } from '../exporter/mp4-exporter.js';
import { graphExportSlug } from '../exporter/graph-video.js';
import desmosIconUrl from '../Images/desmos_icon.png';
import {
  evaluateMeasurementOnFrame,
  measurementDisplayLabel,
  measurementVectorParent,
  unwrapAngleStep,
} from './measure-eval.js';

/** @typedef {'x'|'y'|'vx'|'vy'|'px'|'py'|'theta'|'ptheta'} ObservableId */
/** @typedef {'time'|'phase'|'sweep'} GraphMode */
/** @typedef {'body'|'measurement'} GraphSourceKind */
/** @typedef {'draw'|'playback'} GraphExportAnimMode */

/** @typedef {{ t0: number, t1: number, v0: number, v1: number }} GraphView */

/** @type {{ id: ObservableId, label: string, unit: string }[]} */
export const GRAPH_OBSERVABLES = [
  { id: 'x',  label: 'x',           unit: 'm' },
  { id: 'y',  label: 'y',           unit: 'm' },
  { id: 'vx', label: MATH_PLAIN.vx, unit: 'm/s' },
  { id: 'vy', label: MATH_PLAIN.vy, unit: 'm/s' },
  { id: 'px', label: 'pₓ',          unit: 'kg·m/s' },
  { id: 'py', label: 'pᵧ',          unit: 'kg·m/s' },
  { id: 'theta',  label: MATH_PLAIN.theta, unit: 'rad' },
  { id: 'ptheta', label: 'pθ',            unit: 'kg·m²/s' },
];

const MIN_WIN_W = 240;
const MIN_WIN_H = 180;
const PAD = { l: 44, r: 12, t: 12, b: 28 };
/**
 * On-screen plot short side used as the 1× reference for export ink.
 * At 1440p (~1440 short side) this yields ~4× strokes/fonts so lines stay readable.
 */
const EXPORT_REF_SHORT = 360;

/**
 * Stroke/font multiplier when the SVG viewBox is export pixel size (1 unit = 1 px).
 * @param {number} W
 * @param {number} H
 */
function exportInkScale(W, H) {
  const short = Math.min(W, H);
  if (!Number.isFinite(short) || short <= 0) return 1;
  return Math.max(1, short / EXPORT_REF_SHORT);
}

/**
 * Plot padding scaled for export so tick/axis titles clear the thicker ink.
 * @param {number} s
 */
function exportPadForScale(s) {
  return {
    l: Math.round(46 * s),
    r: Math.round(14 * s),
    t: Math.round(14 * s),
    b: Math.round(38 * s),
  };
}

/**
 * @param {object} frame
 * @param {number} trackId  Stable id: free body Matter id, or weld-part sourceId
 * @param {ObservableId} obs
 * @returns {number|null}
 */
export function sampleObservable(frame, trackId, obs) {
  const hit = resolveTrackInFrame(frame, trackId);
  if (!hit) return null;
  const origin = frame.bodies.find(b => b.type === 'metric-basis');
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;

  const { x, y, vx, vy, mass } = hit;
  if (obs === 'x') return (x - ox) / PX_PER_M;
  if (obs === 'y') return -(y - oy) / PX_PER_M; // +y up
  if (obs === 'vx' || obs === 'vy') {
    const { vxMs, vyMs } = matterVelToDisplayMS(vx, vy);
    return obs === 'vx' ? vxMs : vyMs;
  }
  if (obs === 'px' || obs === 'py') {
    const { vxMs, vyMs } = matterVelToDisplayMS(vx, vy);
    const m = Number.isFinite(mass) ? mass : 1;
    return obs === 'px' ? (m * vxMs) : (m * vyMs);
  }
  if (obs === 'theta' || obs === 'ptheta') {
    const pivot = findPendulumPivotInFrame(frame, trackId);
    if (!pivot) return null;
    return _samplePendulumObservable(frame, hit, pivot, obs);
  }
  return null;
}

/**
 * Locate a tracked mass in a frame: free body by id, or welded component by sourceId.
 * @param {object} frame
 * @param {number} trackId
 * @returns {{ x: number, y: number, vx: number, vy: number, mass: number, hostId: number, label: string|null }|null}
 */
export function resolveTrackInFrame(frame, trackId) {
  if (trackId == null || !frame?.bodies) return null;

  const direct = frame.bodies.find(b => b.id === trackId);
  if (direct) {
    return {
      x: direct.x,
      y: direct.y,
      vx: direct.vx ?? 0,
      vy: direct.vy ?? 0,
      mass: Number.isFinite(direct.mass) ? direct.mass : 1,
      hostId: direct.id,
      label: direct.label ?? null,
    };
  }

  for (const b of frame.bodies) {
    if (!b.weldParts?.length) continue;
    const part = b.weldParts.find(p => p.sourceId === trackId);
    if (!part) continue;
    const kin = partWorldKinematics(b, part);
    return {
      ...kin,
      hostId: b.id,
      label: part.label ?? b.label ?? null,
    };
  }
  return null;
}

/**
 * Find a fixed pivot for pendulum kinematics by walking rod/string links in a frame.
 * Works for a direct rod or a multi-link chain (e.g. rope pendulum → anchor).
 * @param {object} frame
 * @param {number} trackId
 * @returns {{ pivotWx: number, pivotWy: number }|null}
 */
export function findPendulumPivotInFrame(frame, trackId) {
  if (!frame?.bodies?.length || trackId == null) return null;
  const hit = resolveTrackInFrame(frame, trackId);
  const startId = hit?.hostId ?? trackId;

  const staticIds = new Set(
    frame.bodies
      .filter(b => b.isStatic || b.type === 'anchor' || b.type === 'ground')
      .map(b => b.id),
  );
  if (!staticIds.size) return null;

  const links = (frame.constraints ?? []).filter(c =>
    c.type === 'rod' || c.type === 'string',
  );
  if (!links.length) return null;

  const visited = new Set([startId]);
  /** @type {number[]} */
  let frontier = [startId];

  while (frontier.length) {
    /** @type {number[]} */
    const next = [];
    for (const bid of frontier) {
      for (const c of links) {
        if (c.bodyBId === bid && c.bodyAId != null && staticIds.has(c.bodyAId)) {
          return { pivotWx: c.ax, pivotWy: c.ay };
        }
        if (c.bodyAId === bid && c.bodyBId != null && staticIds.has(c.bodyBId)) {
          return { pivotWx: c.bx, pivotWy: c.by };
        }
        if (c.bodyBId === bid && c.bodyAId != null && !visited.has(c.bodyAId) && !staticIds.has(c.bodyAId)) {
          visited.add(c.bodyAId);
          next.push(c.bodyAId);
        }
        if (c.bodyAId === bid && c.bodyBId != null && !visited.has(c.bodyBId) && !staticIds.has(c.bodyBId)) {
          visited.add(c.bodyBId);
          next.push(c.bodyBId);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Pendulum angle θ (rad) and conjugate angular momentum pθ about the detected pivot.
 * θ is measured from downward vertical, positive counter-clockwise (+y up display frame).
 * @param {object} frame
 * @param {{ x: number, y: number, vx: number, vy: number, mass: number }} hit
 * @param {{ pivotWx: number, pivotWy: number }} pivot
 * @param {ObservableId} obs
 * @returns {number|null}
 */
function _samplePendulumObservable(frame, hit, pivot, obs) {
  const origin = frame.bodies.find(b => b.type === 'metric-basis');
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  const px = (pivot.pivotWx - ox) / PX_PER_M;
  const py = -(pivot.pivotWy - oy) / PX_PER_M;
  const bx = (hit.x - ox) / PX_PER_M;
  const by = -(hit.y - oy) / PX_PER_M;
  const rx = bx - px;
  const ry = by - py;
  if (obs === 'theta') {
    if (Math.hypot(rx, ry) < 1e-9) return 0;
    return Math.atan2(rx, -ry);
  }
  const { vxMs, vyMs } = matterVelToDisplayMS(hit.vx, hit.vy);
  const m = Number.isFinite(hit.mass) ? hit.mass : 1;
  return m * (rx * vyMs - ry * vxMs);
}

/**
 * @param {import('matter-js').Body} b
 * @returns {boolean}
 */
function _isFixedBody(b) {
  return !!b?.isStatic || b?._newtonType === 'anchor' || b?._newtonType === 'ground';
}

/**
 * @param {import('matter-js').Body} b
 * @returns {boolean}
 */
function _isTranslationLockedBody(b) {
  return !!b?._lockRotation || b?._newtonType === 'ball' || b?._newtonType === 'point-mass';
}

/**
 * @param {{ bodies?: import('matter-js').Body[], constraints?: object[] }} engine
 * @param {number} trackId
 * @returns {{ body: import('matter-js').Body, hostId: number, part?: object }|null}
 */
function _resolveTrackInEngine(engine, trackId) {
  if (!engine?.bodies || trackId == null) return null;
  for (const b of engine.bodies) {
    if (b._newtonType === 'metric-basis') continue;
    if (b.id === trackId) return { body: b, hostId: b.id };
    if (b._weldParts?.length) {
      const part = b._weldParts.find(p => p.sourceId === trackId);
      if (part) return { body: b, hostId: b.id, part };
    }
  }
  return null;
}

/**
 * Constraint-connected component (includes rope links: they holonomically couple the chain).
 * @param {{ bodies?: import('matter-js').Body[], constraints?: object[] }} engine
 * @param {number} startId
 * @returns {Set<number>}
 */
function _constraintComponent(engine, startId) {
  const idSet = new Set(
    engine.bodies.filter(b => b._newtonType !== 'metric-basis').map(b => b.id),
  );
  const visited = new Set([startId]);
  /** @type {number[]} */
  let frontier = [startId];
  while (frontier.length) {
    /** @type {number[]} */
    const next = [];
    for (const bid of frontier) {
      for (const c of engine.constraints ?? []) {
        if (!['rod', 'string', 'spring'].includes(c._newtonType)) continue;
        let nid = null;
        if (c.bodyA?.id === bid) nid = c.bodyB?.id;
        else if (c.bodyB?.id === bid) nid = c.bodyA?.id;
        if (nid != null && idSet.has(nid) && !visited.has(nid)) {
          visited.add(nid);
          next.push(nid);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

/**
 * @param {{ bodies?: import('matter-js').Body[], constraints?: object[] }} engine
 * @param {Set<number>} componentIds
 * @returns {boolean}
 */
function _componentAnchoredToFixed(engine, componentIds) {
  const fixed = new Set(engine.bodies.filter(_isFixedBody).map(b => b.id));
  for (const c of engine.constraints ?? []) {
    const a = c.bodyA?.id;
    const b = c.bodyB?.id;
    if (a == null || b == null) continue;
    if (componentIds.has(a) && fixed.has(b)) return true;
    if (componentIds.has(b) && fixed.has(a)) return true;
  }
  return false;
}

/**
 * @param {{ bodies?: import('matter-js').Body[], constraints?: object[] }} engine
 * @param {Set<number>} componentIds
 * @returns {number}
 */
function _countHolonomicConstraints(engine, componentIds) {
  let n = 0;
  for (const c of engine.constraints ?? []) {
    if (c._newtonType !== 'rod' && c._newtonType !== 'string' && !c._ropeLink) continue;
    const a = c.bodyA?.id;
    const b = c.bodyB?.id;
    if (a != null && b != null && componentIds.has(a) && componentIds.has(b)) n++;
  }
  return n;
}

/**
 * True when the tracked mass belongs to an effectively 1-DOF subsystem
 * (pendulum, spring-mass, etc.) suitable for a phase portrait.
 * @param {{ bodies?: import('matter-js').Body[], constraints?: object[] }} engine
 * @param {number} trackId
 * @returns {boolean}
 */
export function trackIsOneDof(engine, trackId) {
  const resolved = _resolveTrackInEngine(engine, trackId);
  if (!resolved) return false;
  const { hostId, body, part } = resolved;

  if (body._newtonType === 'compound' && body._weldParts?.length > 1 && hostId === body.id && !part) {
    return false;
  }

  const component = _constraintComponent(engine, hostId);
  if (!_componentAnchoredToFixed(engine, component)) return false;

  const bodyById = new Map(engine.bodies.map(b => [b.id, b]));
  const dynamic = [...component]
    .map(id => bodyById.get(id))
    .filter(b => b && !_isFixedBody(b));
  const nonRope = dynamic.filter(b => !b._ropeSegment);

  if (dynamic.some(b => b._ropeSegment)) {
    return nonRope.length === 1;
  }

  if (nonRope.length === 1) {
    const b = nonRope[0];
    if (!_isTranslationLockedBody(b)) return false;
    const holonomic = _countHolonomicConstraints(engine, component);
    const hasSpring = (engine.constraints ?? []).some(c =>
      c._newtonType === 'spring'
      && c.bodyA && c.bodyB
      && component.has(c.bodyA.id)
      && component.has(c.bodyB.id),
    );
    if (holonomic === 1) return true;
    if (holonomic === 0 && hasSpring) return true;
    return false;
  }

  if (nonRope.length === 0) return false;

  const transDof = nonRope.reduce((sum, b) => (
    sum + (_isTranslationLockedBody(b) ? 2 : 3)
  ), 0);
  return transDof - _countHolonomicConstraints(engine, component) === 1;
}

/**
 * World pose / velocity of a rigid weld part from compound COM state.
 * @param {{ x: number, y: number, angle?: number, vx?: number, vy?: number, w?: number, mass?: number }} body
 * @param {{ lx?: number, ly?: number, mass?: number }} part
 */
export function partWorldKinematics(body, part) {
  const ang = body.angle ?? 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const lx = part.lx ?? 0;
  const ly = part.ly ?? 0;
  const rx = c * lx - s * ly;
  const ry = s * lx + c * ly;
  const w = Number.isFinite(body.w) ? body.w : 0;
  return {
    x: body.x + rx,
    y: body.y + ry,
    vx: (body.vx ?? 0) - w * ry,
    vy: (body.vy ?? 0) + w * rx,
    mass: Number.isFinite(part.mass) ? part.mass : (Number.isFinite(body.mass) ? body.mass : 1),
  };
}

/**
 * @param {object[]} frames
 * @param {number} trackId
 * @param {ObservableId} obs
 * @param {{ unwrapAngle?: boolean }} [opts]  Unwrap θ past ±π when true
 * @returns {{ t: number, v: number, i: number }[]}
 */
export function buildSeries(frames, trackId, obs, opts = {}) {
  const pts = [];
  const unwrap = opts.unwrapAngle === true && obs === 'theta';
  /** @type {{ prev: number, accum: number }|null} */
  let angState = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let v = sampleObservable(f, trackId, obs);
    if (v == null || !isFinite(v) || !isFinite(f.t)) continue;
    if (unwrap) {
      const step = unwrapAngleStep(angState, v, 2 * Math.PI);
      angState = step.state;
      v = step.value;
    }
    pts.push({ t: f.t, v, i });
  }
  return pts;
}

/**
 * Phase portrait: pairs two observables (e.g. x vs v_x) for 1-DOF motion.
 * Series uses `t` for the horizontal axis value and `v` for the vertical.
 * @param {object[]} frames
 * @param {number} trackId
 * @param {ObservableId} xObs
 * @param {ObservableId} yObs
 * @param {{ unwrapAngle?: boolean }} [opts]  Unwrap θ on either axis past ±π
 * @returns {{ t: number, v: number, i: number }[]}
 */
export function buildPhaseSeries(frames, trackId, xObs, yObs, opts = {}) {
  const pts = [];
  const unwrap = opts.unwrapAngle === true;
  /** @type {{ prev: number, accum: number }|null} */
  let xState = null;
  /** @type {{ prev: number, accum: number }|null} */
  let yState = null;
  for (let i = 0; i < frames.length; i++) {
    let x = sampleObservable(frames[i], trackId, xObs);
    let y = sampleObservable(frames[i], trackId, yObs);
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
    if (unwrap && xObs === 'theta') {
      const step = unwrapAngleStep(xState, x, 2 * Math.PI);
      xState = step.state;
      x = step.value;
    }
    if (unwrap && yObs === 'theta') {
      const step = unwrapAngleStep(yState, y, 2 * Math.PI);
      yState = step.state;
      y = step.value;
    }
    pts.push({ t: x, v: y, i });
  }
  return pts;
}

/**
 * Time series for a scene measurement (angle ° or length m).
 * Angle measurements with `continuous: true` unwrap past ±180°.
 * @param {object[]} frames
 * @param {object} measurement  scene measurement entry
 * @param {object|null} [sceneDoc]
 * @returns {{ t: number, v: number, i: number }[]}
 */
export function buildMeasurementSeries(frames, measurement, sceneDoc = null) {
  const pts = [];
  if (!measurement || !frames?.length) return pts;
  const continuous = measurement.kind === 'angle' && measurement.continuous === true
    && measurement.signed !== false;
  /** @type {{ prev: number, accum: number }|null} */
  let angState = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let v = evaluateMeasurementOnFrame(measurement, f, sceneDoc);
    if (v == null || !isFinite(v) || !isFinite(f.t)) continue;
    if (continuous) {
      const step = unwrapAngleStep(angState, v, 360);
      angState = step.state;
      v = step.value;
    }
    pts.push({ t: f.t, v, i });
  }
  return pts;
}

/**
 * Parametric plot of two scene measurements (e.g. θ₁ vs θ₂).
 * Series uses `t` for the horizontal axis value and `v` for the vertical.
 * @param {object[]} frames
 * @param {object} measX
 * @param {object} measY
 * @param {object|null} [sceneDoc]
 * @param {{ unwrapAngle?: boolean }} [opts]
 *   Force unwrap on angle axes (also honors each measurement's `continuous` flag).
 * @returns {{ t: number, v: number, i: number }[]}
 */
export function buildMeasurementPhaseSeries(frames, measX, measY, sceneDoc = null, opts = {}) {
  const pts = [];
  if (!measX || !measY || !frames?.length) return pts;
  const forceUnwrap = opts.unwrapAngle === true;
  const contX = measX.kind === 'angle' && measX.signed !== false
    && (forceUnwrap || measX.continuous === true);
  const contY = measY.kind === 'angle' && measY.signed !== false
    && (forceUnwrap || measY.continuous === true);
  /** @type {{ prev: number, accum: number }|null} */
  let xState = null;
  /** @type {{ prev: number, accum: number }|null} */
  let yState = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let x = evaluateMeasurementOnFrame(measX, f, sceneDoc);
    let y = evaluateMeasurementOnFrame(measY, f, sceneDoc);
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
    if (contX) {
      const step = unwrapAngleStep(xState, x, 360);
      xState = step.state;
      x = step.value;
    }
    if (contY) {
      const step = unwrapAngleStep(yState, y, 360);
      yState = step.state;
      y = step.value;
    }
    pts.push({ t: x, v: y, i });
  }
  return pts;
}

/**
 * Data extents with padding: used for auto-fit / home (0).
 * @param {{ t: number, v: number }[]} series
 * @returns {GraphView|null}
 */
export function seriesBounds(series) {
  if (!series.length) return null;
  let t0 = Infinity;
  let t1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of series) {
    if (p.t < t0) t0 = p.t;
    if (p.t > t1) t1 = p.t;
    if (p.v < v0) v0 = p.v;
    if (p.v > v1) v1 = p.v;
  }
  if (!isFinite(t0) || !isFinite(t1)) { t0 = 0; t1 = 1; }
  if (t1 <= t0) t1 = t0 + 1e-3;
  if (!isFinite(v0) || !isFinite(v1)) { v0 = 0; v1 = 1; }
  if (Math.abs(v1 - v0) < 1e-9) {
    v0 -= 0.5;
    v1 += 0.5;
  }
  const vPad = (v1 - v0) * 0.06;
  const tPad = (t1 - t0) * 0.02;
  return { t0: t0 - tPad, t1: t1 + tPad, v0: v0 - vPad, v1: v1 + vPad };
}

/**
 * Series point at/near a recorded frame index (exact match preferred).
 * @param {{ i: number }[]} series
 * @param {number} frameIndex
 * @returns {{ i: number, t: number, v: number }|null}
 */
function seriesPointNearFrame(series, frameIndex) {
  if (!series?.length || !(frameIndex >= 0)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of series) {
    if (!Number.isFinite(p.i)) continue;
    const d = Math.abs(p.i - frameIndex);
    if (d < bestDist) {
      bestDist = d;
      best = p;
      if (d === 0) break;
    }
  }
  return best;
}


function _el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') n.className = v;
    else if (v != null) n.setAttribute(k, v);
  }
  if (text != null) n.textContent = text;
  return n;
}

function _svg(tag, attrs = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) n.setAttribute(k, String(v));
  }
  return n;
}

/**
 * Normalized direction arrow in plot pixel space (shaft + filled head).
 * @param {SVGGElement} g
 * @param {number} cx
 * @param {number} cy
 * @param {number} dirX  screen-space direction (need not be unit)
 * @param {number} dirY
 * @param {number} lengthPx
 * @param {string} color
 * @param {number} [opacity=0.55]
 * @param {number} [inkScale=1]
 */
function _drawNormArrow(g, cx, cy, dirX, dirY, lengthPx, color, opacity = 0.55, inkScale = 1) {
  const mag = Math.hypot(dirX, dirY);
  if (!Number.isFinite(mag) || mag < 1e-7 || !Number.isFinite(lengthPx) || lengthPx < 2) return;

  const s = Math.max(1, inkScale);
  const ux = dirX / mag;
  const uy = dirY / mag;
  const headLen = Math.max(3.5 * s, Math.min(8 * s, lengthPx * 0.32));
  const headHalf = headLen * 0.45;
  const half = lengthPx * 0.5;
  const xTail = cx - ux * half;
  const yTail = cy - uy * half;
  const xTip = cx + ux * half;
  const yTip = cy + uy * half;
  const xShaft = xTip - ux * headLen;
  const yShaft = yTip - uy * headLen;
  const nx = -uy;
  const ny = ux;

  g.appendChild(_svg('line', {
    x1: xTail,
    y1: yTail,
    x2: xShaft,
    y2: yShaft,
    stroke: color,
    'stroke-width': 1.25 * s,
    'stroke-opacity': opacity,
    'stroke-linecap': 'round',
  }));
  g.appendChild(_svg('path', {
    d: `M${xShaft + nx * headHalf},${yShaft + ny * headHalf} L${xTip},${yTip} L${xShaft - nx * headHalf},${yShaft - ny * headHalf} Z`,
    fill: color,
    'fill-opacity': opacity,
  }));
}

/** @typedef {{ x: number, y: number, dxdt: number, dydt: number }} PhaseTangent */

/**
 * Kernel-weighted phase flow at a point (from recorded trajectory tangents).
 * @param {PhaseTangent[]} tangents
 * @param {number} gx
 * @param {number} gy
 * @param {number} sx
 * @param {number} sy
 * @returns {{ wx: number, wy: number, speed: number, hamiltonian: number }|null}
 */
function _samplePhaseFlow(tangents, gx, gy, sx, sy) {
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  for (const s of tangents) {
    const dx = (s.x - gx) / sx;
    const dy = (s.y - gy) / sy;
    const w = Math.exp(-(dx * dx + dy * dy) * 2.2);
    wx += w * s.dxdt;
    wy += w * s.dydt;
    wsum += w;
  }
  if (wsum < 1e-6) return null;
  wx /= wsum;
  wy /= wsum;
  // Hamiltonian proxy: ∇H ⊥ flow for 1-DOF Hamiltonian systems (H ∝ y·ẋ − x·ẏ).
  return { wx, wy, speed: Math.hypot(wx, wy), hamiltonian: gy * wx - gx * wy };
}

/**
 * Marching-squares contour segments for a scalar grid.
 * @param {Float64Array|number[]} values  row-major, index j * cols + i
 * @param {number} cols
 * @param {number} rows
 * @param {number} level
 * @param {(i: number, j: number) => [number, number]} cornerXY  grid corner → plot px
 * @returns {number[][]}  [x1,y1,x2,y2] segments
 */
function _marchingSquares(values, cols, rows, level, cornerXY) {
  /** @type {number[][]} */
  const segs = [];
  const TAB = [
    [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
    [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [1, 3], [0, 1], [0, 3], [],
  ];

  const edgePt = (i0, j0, i1, j1, va, vb) => {
    const d = vb - va;
    const t = Math.abs(d) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, (level - va) / d));
    const [x0, y0] = cornerXY(i0, j0);
    const [x1, y1] = cornerXY(i1, j1);
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  };

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const v0 = values[j * cols + i];
      const v1 = values[j * cols + i + 1];
      const v2 = values[(j + 1) * cols + i + 1];
      const v3 = values[(j + 1) * cols + i];
      if (![v0, v1, v2, v3].every(Number.isFinite)) continue;

      let c = 0;
      if (v0 >= level) c |= 1;
      if (v1 >= level) c |= 2;
      if (v2 >= level) c |= 4;
      if (v3 >= level) c |= 8;
      if (c === 0 || c === 15) continue;

      if (c === 5 || c === 10) {
        const avg = (v0 + v1 + v2 + v3) * 0.25;
        if (c === 5) c = avg >= level ? 10 : 5;
        else c = avg >= level ? 5 : 10;
      }

      const edges = TAB[c];
      if (!edges.length) continue;

      const pts = [
        edgePt(i, j, i + 1, j, v0, v1),
        edgePt(i + 1, j, i + 1, j + 1, v1, v2),
        edgePt(i + 1, j + 1, i, j + 1, v2, v3),
        edgePt(i, j + 1, i, j, v3, v0),
      ];
      for (let k = 0; k < edges.length; k += 2) {
        const a = pts[edges[k]];
        const b = pts[edges[k + 1]];
        segs.push([a[0], a[1], b[0], b[1]]);
      }
    }
  }
  return segs;
}

/**
 * @typedef {object} GraphHostOpts
 * @property {HTMLElement} container
 * @property {() => object[]} getFrames
 * @property {() => { id: number, trackId?: number, label: string, type: string }[]} listBodies
 * @property {() => object[]} [listMeasurements]  scene-form measurement entries
 * @property {() => number} getScrubIndex
 * @property {(frameIndex: number) => void} [onSeek]
 * @property {() => number|null} [getSelectedBodyId]
 * @property {() => number|null} [getSelectedTrackId]
 * @property {() => object|null} [getBaselineScene]
 * @property {() => string|null} [getSceneName]
 * @property {() => import('../physics/engine.js').PhysicsEngine|null} [getEngine]
 */

export class GraphHost {
  /** @param {GraphHostOpts} opts */
  constructor(opts) {
    this._opts = opts;
    /** @type {GraphWindow[]} */
    this._windows = [];
    this._nextZ = 40;
    this._nextExportId = 1;
    this._stackOffset = 0;
    /** @type {GraphWindow|null} */
    this._hovered = null;
    this._dock = _el('div', {
      className: 'graph-dock',
      hidden: true,
      role: 'toolbar',
      'aria-label': 'Minimized graphs',
    });
    opts.container.appendChild(this._dock);
  }

  get count() { return this._windows.length; }

  get hovered() { return this._hovered; }

  /**
   * If a graph plot is hovered, reset its view to recorded bounds.
   * @returns {boolean}
   */
  resetHoveredView() {
    if (!this._hovered) return false;
    this._hovered.resetView();
    return true;
  }

  /**
   * @param {object} [seed]
   * @param {GraphMode} [seed.mode]
   * @param {number} [seed.bodyId]
   * @param {number} [seed.trackId]  Stable mass id (survives sticky welds)
   * @param {ObservableId} [seed.observable]
   * @param {ObservableId} [seed.phaseObsX]
   * @param {ObservableId} [seed.phaseObsY]
   * @param {GraphSourceKind} [seed.sourceKind]
   * @param {string|null} [seed.measurementId]
   * @param {string|null} [seed.measurementIdY]
   */
  addGraph(seed = {}) {
    const bodies = this._opts.listBodies();
    const measurements = this._opts.listMeasurements?.()
      ?? this._opts.getBaselineScene?.()?.measurements
      ?? [];
    let sourceKind = seed.sourceKind === 'measurement' ? 'measurement' : 'body';
    let measurementId = seed.measurementId ?? null;
    let measurementIdY = seed.measurementIdY ?? null;
    let bodyId = seed.bodyId ?? this._opts.getSelectedBodyId?.() ?? null;
    let trackId = seed.trackId ?? this._opts.getSelectedTrackId?.() ?? bodyId;

    if (sourceKind === 'measurement') {
      if (!measurementId || !measurements.some(m => m.id === measurementId)) {
        measurementId = measurements[0]?.id ?? null;
      }
      if (!measurementId) sourceKind = 'body';
      else if (!measurementIdY || measurementIdY === measurementId
        || !measurements.some(m => m.id === measurementIdY)) {
        measurementIdY = measurements.find(m => m.id !== measurementId)?.id ?? null;
      }
    }

    if (sourceKind === 'body') {
      if (bodyId == null || !bodies.some(b => b.id === bodyId || b.trackId === trackId)) {
        bodyId = bodies[0]?.id ?? null;
        trackId = bodies[0]?.trackId ?? bodyId;
      }
      // Prefer the list entry that matches the track (component inside a group).
      const match = bodies.find(b => b.trackId === trackId)
        ?? bodies.find(b => b.id === bodyId);
      if (match) {
        bodyId = match.id;
        trackId = match.trackId ?? match.id;
      }
    } else {
      bodyId = null;
      trackId = null;
    }

    const observable = seed.observable ?? 'y';
    let mode = seed.mode === 'sweep' ? 'sweep'
      : seed.mode === 'phase' ? 'phase'
        : 'time';
    if (mode === 'phase') {
      if (sourceKind === 'measurement') {
        if (!(measurements.length >= 2 && measurementId && measurementIdY)) mode = 'time';
      } else {
        const engine = this._opts.getEngine?.();
        if (!engine || !trackIsOneDof(engine, trackId)) mode = 'time';
      }
    }
    const win = new GraphWindow(this, {
      mode,
      bodyId,
      trackId,
      observable,
      phaseObsX: seed.phaseObsX ?? 'x',
      phaseObsY: seed.phaseObsY ?? 'px',
      sourceKind,
      measurementId,
      measurementIdY,
      left: 24 + (this._stackOffset % 5) * 28,
      top: 24 + (this._stackOffset % 5) * 28,
    });
    this._stackOffset += 1;
    this._windows.push(win);
    this._opts.container.appendChild(win.el);
    win.focus();
    win.refresh();
    return win;
  }

  removeGraph(win) {
    if (this._hovered === win) this._hovered = null;
    const i = this._windows.indexOf(win);
    if (i >= 0) this._windows.splice(i, 1);
    win.dispose?.();
    win.el.remove();
    this._syncDock();
  }

  /** @param {GraphWindow} win */
  minimizeGraph(win) {
    win.minimize();
    this._syncDock();
  }

  /** @param {GraphWindow} win */
  restoreGraph(win) {
    win.restore();
    this._syncDock();
    this.bringToFront(win);
  }

  _syncDock() {
    if (!this._dock) return;
    const any = this._windows.some(w => w.minimized);
    this._dock.hidden = !any;
  }

  /** Refresh time-series and phase-portrait windows from the recorder. */
  sync() {
    for (const w of this._windows) {
      if ((w.mode === 'time' || w.mode === 'phase') && !w.minimized) w.refresh();
    }
  }

  /** @returns {GraphWindow[]} Graphs that can be encoded from recorded frames. */
  listVideoExportCandidates() {
    return this._windows.filter(w => w.canExportVideo());
  }

  /**
   * Summaries for the export dialog.
   * @returns {{ id: number, title: string, canExport: boolean, reason: string, plotAspect: number }[]}
   */
  getVideoExportSummaries() {
    return this._windows.map(w => ({
      id: w.exportId,
      title: w.getExportTitle(),
      canExport: w.canExportVideo(),
      reason: w.exportBlockedReason(),
      plotAspect: w.getPlotAspect(),
    }));
  }

  /**
   * @param {number} exportId
   * @returns {GraphWindow|undefined}
   */
  findByExportId(exportId) {
    return this._windows.find(w => w.exportId === exportId);
  }

  /** Refresh graph data before opening the export dialog. */
  prepareVideoExport() {
    for (const w of this._windows) {
      if (w.mode !== 'sweep') w.refresh();
    }
  }

  /**
   * Keep graphs following a mass through a sticky weld (new compound Matter id).
   * @param {import('matter-js').Body} compound
   * @param {number[]} removedIds
   */
  followWeld(compound, removedIds) {
    const partSourceIds = new Set(
      (compound._weldParts ?? []).map(p => p.sourceId).filter(id => id != null),
    );
    for (const w of this._windows) {
      if (w.mode !== 'time' && w.mode !== 'phase') continue;
      const trackInParts = partSourceIds.has(w.trackId);
      const lostHost = removedIds.includes(w.bodyId) || removedIds.includes(w.trackId);
      if (!trackInParts && !lostHost) continue;
      if (removedIds.includes(w.trackId) && !trackInParts) {
        // Was graphing a whole body/group COM that got absorbed: follow new group COM.
        w.trackId = compound.id;
      }
      w.bodyId = compound.id;
      w.refresh();
    }
  }

  /** Refresh sweep option lists after a scene load. */
  refreshSweepOptions() {
    for (const w of this._windows) {
      if (w.mode === 'sweep') w.refreshSweepOptions();
    }
  }

  bringToFront(win) {
    this._nextZ += 1;
    win.el.style.zIndex = String(this._nextZ);
  }

  _setHovered(win) {
    this._hovered = win;
  }

  _clearHovered(win) {
    if (this._hovered === win) this._hovered = null;
  }
}

class GraphWindow {
  /**
   * @param {GraphHost} host
   * @param {{ mode: GraphMode, bodyId: number|null, trackId?: number|null, observable: ObservableId, phaseObsX?: ObservableId, phaseObsY?: ObservableId, left: number, top: number, sourceKind?: GraphSourceKind, measurementId?: string|null, measurementIdY?: string|null }} cfg
   */
  constructor(host, cfg) {
    this.host = host;
    this.exportId = host._nextExportId++;
    /** @type {GraphMode} */
    this.mode = cfg.mode;
    this.bodyId = cfg.bodyId;
    /** Stable mass id: free body id or weld-part sourceId (survives welds). */
    this.trackId = cfg.trackId ?? cfg.bodyId;
    this.observable = cfg.observable;
    /** @type {ObservableId} Horizontal axis in phase portrait mode. */
    this.phaseObsX = cfg.phaseObsX ?? 'x';
    /** @type {ObservableId} Vertical axis in phase portrait mode. */
    this.phaseObsY = cfg.phaseObsY ?? 'px';
    /** @type {GraphSourceKind} */
    this.sourceKind = cfg.sourceKind === 'measurement' ? 'measurement' : 'body';
    /** @type {string|null} */
    this.measurementId = cfg.measurementId ?? null;
    /** Second measurement for parametric (X–Y) plots. */
    /** @type {string|null} */
    this.measurementIdY = cfg.measurementIdY ?? null;
    /** Unwrap θ past ±π in time / phase plots (body observable). */
    this.unwrapAngle = false;
    this._selectedIndex = null;
    this._series = [];
    /** @type {GraphView|null} */
    this._view = null;
    /** @type {GraphView|null} */
    this._dataBounds = null;
    /** When true, view tracks recorded bounds on each refresh. */
    this._autoView = true;
    this._clipSeq = 0;

    /** @type {{ pointerId: number, x: number, y: number, view: GraphView, moved: boolean }|null} */
    this._drag = null;
    /** @type {{ t: number, v: number, i: number }|null} */
    this._hoverPt = null;

    /** Sweep state */
    this._runner = null;
    this._sweepRunning = false;
    this._sweepXLabel = 'x';
    this._sweepYLabel = 'y';
    this._sweepStatus = '';
    /** @type {object|null} Scene document cloned when the last sweep started */
    this._sweepBaseline = null;
    /** @type {string|null} Independent SweepParam id for the last sweep */
    this._sweepParamId = null;
    /** @type {string} */
    this._sweepParamLabel = '';

    /** @type {import('../fit/types.js').FitResult|null} */
    this._fitResult = null;
    /** @type {{ t: number, v: number }[]} */
    this._fitOverlay = [];
    this._fitError = '';
    this._fitKey = '';
    /** @type {{ t0: number, t1: number }|null} */
    this._fitDomainUsed = null;
    /** @type {{ t0: number, t1: number }|null} */
    this._fitDomainAuto = null;

    /** @type {{ iMax: number, iMin: number }|null} */
    this._yExtrema = null;

    this.minimized = false;
    /** @type {HTMLButtonElement|null} */
    this._tabEl = null;

    this.el = _el('div', { className: 'graph-window', role: 'dialog', 'aria-label': 'Graph window' });
    this.el.style.left = `${cfg.left}px`;
    this.el.style.top = `${cfg.top}px`;
    if (cfg.mode === 'sweep') {
      this.el.style.width = '900px';
      this.el.style.height = '500px';
    } else {
      this.el.style.width = '900px';
      this.el.style.height = '360px';
    }

    const header = _el('div', { className: 'graph-window-header' });
    this._titleEl = _el('span', { className: 'graph-window-title' }, 'Graph');
    const headerBtns = _el('div', { className: 'graph-window-header-btns' });
    const minBtn = _el('button', {
      type: 'button',
      className: 'graph-window-min',
      title: 'Minimize graph',
      'aria-label': 'Minimize graph',
    }, '–');
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      host.minimizeGraph(this);
    });
    const closeBtn = _el('button', {
      type: 'button',
      className: 'graph-window-close',
      title: 'Close graph',
      'aria-label': 'Close graph',
    }, '×');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      host.removeGraph(this);
    });
    headerBtns.append(minBtn, closeBtn);
    header.append(this._titleEl, headerBtns);
    this._wireDrag(header);

    this._mainToolbar = _el('div', { className: 'graph-window-toolbar' });
    this._bodySelect = _el('select', { className: 'graph-select', title: 'Source', 'aria-label': 'Source' });
    this._bodySelect.addEventListener('change', () => this._onBodyChange());
    this._obsSelect = _el('select', { className: 'graph-select graph-select-math', title: 'Observable', 'aria-label': 'Observable' });
    for (const o of GRAPH_OBSERVABLES) {
      this._obsSelect.appendChild(_el('option', { value: o.id }, `${o.label} (${o.unit})`));
    }
    this._obsSelect.value = this.observable;
    this._obsSelect.addEventListener('change', () => {
      this.observable = /** @type {ObservableId} */ (this._obsSelect.value);
      this._selectedIndex = null;
      this._syncUnwrapChrome();
      this._clearFit();
      if (this.mode === 'sweep') {
        this.setMode('time');
        return;
      }
      this.resetView(false);
      this.refresh();
    });
    this._obsLabel = _el('label', { className: 'graph-field-label' }, 'Obs');

    this._unwrapWrap = _el('label', {
      className: 'graph-unwrap-toggle',
      title: 'Off: wrap θ to ±π. On: accumulate past full turns.',
      hidden: true,
    });
    this._unwrapCheck = _el('input', {
      type: 'checkbox',
      'aria-label': 'Unwrap angle past ±π',
    });
    this._unwrapCheck.checked = this.unwrapAngle;
    this._unwrapCheck.addEventListener('change', () => {
      this.unwrapAngle = !!this._unwrapCheck.checked;
      this._selectedIndex = null;
      this._clearFit();
      this.resetView(false);
      this.refresh();
    });
    this._unwrapWrap.append(this._unwrapCheck, document.createTextNode(' Unwrap θ'));

    this._phaseObsWrap = _el('span', { className: 'graph-phase-obs-wrap', hidden: true });
    this._obsXSelect = _el('select', { className: 'graph-select graph-select-math', title: 'X-axis', 'aria-label': 'X-axis' });
    this._obsYSelect = _el('select', { className: 'graph-select graph-select-math', title: 'Y-axis', 'aria-label': 'Y-axis' });
    /** @type {'body'|'measurement'|null} What the X/Y selects currently list. */
    this._phaseSelectKind = null;
    this._fillBodyPhaseObsSelects();
    this._obsXSelect.value = this.phaseObsX;
    this._obsYSelect.value = this.phaseObsY;
    const onPhaseObsChange = () => {
      if (this.sourceKind === 'measurement' && this.mode === 'phase') {
        this.measurementId = this._obsXSelect.value || null;
        this.measurementIdY = this._obsYSelect.value || null;
        if (this.measurementId) this._bodySelect.value = `meas:${this.measurementId}`;
      } else {
        this.phaseObsX = /** @type {ObservableId} */ (this._obsXSelect.value);
        this.phaseObsY = /** @type {ObservableId} */ (this._obsYSelect.value);
      }
      this._syncUnwrapChrome();
      this._selectedIndex = null;
      this._clearFit();
      this.resetView(false);
      this.refresh();
    };
    this._obsXSelect.addEventListener('change', onPhaseObsChange);
    this._obsYSelect.addEventListener('change', onPhaseObsChange);
    this._phaseObsWrap.append(
      _el('label', { className: 'graph-field-label' }, 'X'),
      this._obsXSelect,
      _el('label', { className: 'graph-field-label' }, 'Y'),
      this._obsYSelect,
    );
    /** @type {'off'|'vectors'|'contour'} */
    this._phaseOverlay = 'vectors';
    this._phaseOverlaySelect = _el('select', {
      className: 'graph-select graph-phase-overlay-select',
      title: 'Phase background — vector field or energy contours',
      'aria-label': 'Phase background',
    });
    for (const [value, label] of [
      ['vectors', 'Vectors'],
      ['contour', 'Contour'],
      ['off', 'Off'],
    ]) {
      this._phaseOverlaySelect.appendChild(_el('option', { value }, label));
    }
    this._phaseOverlaySelect.value = this._phaseOverlay;
    this._phaseOverlaySelect.addEventListener('change', () => {
      const v = this._phaseOverlaySelect.value;
      this._phaseOverlay = v === 'contour' || v === 'off' ? v : 'vectors';
      if (this.mode === 'phase') this._redrawOnly();
    });
    this._phaseBgLabel = _el('label', { className: 'graph-field-label' }, 'Bg');
    this._phaseObsWrap.append(
      this._phaseBgLabel,
      this._phaseOverlaySelect,
    );

    this._phaseBoundsWrap = _el('span', { className: 'graph-phase-bounds-wrap', hidden: true });
    this._phaseXMin = _el('input', { type: 'number', className: 'graph-num graph-phase-bound', step: 'any', title: 'Phase x min' });
    this._phaseXMax = _el('input', { type: 'number', className: 'graph-num graph-phase-bound', step: 'any', title: 'Phase x max' });
    this._phaseYMin = _el('input', { type: 'number', className: 'graph-num graph-phase-bound', step: 'any', title: 'Phase y min' });
    this._phaseYMax = _el('input', { type: 'number', className: 'graph-num graph-phase-bound', step: 'any', title: 'Phase y max' });
    const phaseApplyBtn = _el('button', { type: 'button', className: 'graph-fit-btn graph-fit-btn-muted' }, 'Apply');
    phaseApplyBtn.addEventListener('click', () => this._applyPhaseBoundsFromInputs());
    const phaseAutoBtn = _el('button', { type: 'button', className: 'graph-fit-btn graph-fit-btn-muted' }, 'Auto');
    phaseAutoBtn.addEventListener('click', () => {
      this._autoView = true;
      if (this._series.length) {
        this._dataBounds = seriesBounds(this._series);
      }
      this._view = this._dataBounds ? { ...this._dataBounds } : null;
      this._syncPhaseBoundsInputs();
      if (this.mode === 'phase') this._redrawOnly();
    });
    this._phaseBoundsWrap.append(
      _el('label', { className: 'graph-field-label' }, 'xmin'),
      this._phaseXMin,
      _el('label', { className: 'graph-field-label' }, 'xmax'),
      this._phaseXMax,
      _el('label', { className: 'graph-field-label' }, 'ymin'),
      this._phaseYMin,
      _el('label', { className: 'graph-field-label' }, 'ymax'),
      this._phaseYMax,
      phaseApplyBtn,
      phaseAutoBtn,
    );

    this._phaseBtn = _el('button', {
      type: 'button',
      className: 'graph-fit-btn graph-fit-btn-muted graph-phase-btn',
      title: 'Parametric / phase portrait — plot one quantity vs another',
    }, 'Phase');
    this._phaseBtn.addEventListener('click', () => {
      this.setMode(this.mode === 'phase' ? 'time' : 'phase');
    });

    this._mainToolbar.append(
      _el('label', { className: 'graph-field-label' }, 'Source'),
      this._bodySelect,
      this._obsLabel,
      this._obsSelect,
      this._unwrapWrap,
      this._phaseObsWrap,
      this._phaseBoundsWrap,
      this._phaseBtn,
    );

    this._advanced = _el('details', { className: 'graph-advanced' });
    if (cfg.mode === 'sweep') this._advanced.open = true;
    this._advancedSummary = _el('summary', { className: 'graph-advanced-summary' }, 'Advanced — parameter sweep');
    this._sweepPanel = _el('div', { className: 'graph-sweep-panel' });
    const form = _el('div', { className: 'graph-sweep-form' });
    this._indepSelect = _el('select', { className: 'graph-select graph-select-wide graph-select-math', title: 'Independent variable' });
    this._depSelect = _el('select', { className: 'graph-select graph-select-wide graph-select-math', title: 'Dependent variable' });
    this._minInput = _el('input', { type: 'number', className: 'graph-num', step: 'any', value: '4' });
    this._maxInput = _el('input', { type: 'number', className: 'graph-num', step: 'any', value: '20' });
    this._countInput = _el('input', { type: 'number', className: 'graph-num', min: '2', max: '64', step: '1', value: '9' });
    this._indepSelect.addEventListener('change', () => this._onIndepChange());
    form.append(
      _sweepField('Independent', this._indepSelect),
      _sweepField('Dependent', this._depSelect),
      _sweepField('From', this._minInput),
      _sweepField('To', this._maxInput),
      _sweepField('Runs', this._countInput),
    );
    const sweepActions = _el('div', { className: 'graph-sweep-actions' });
    this._runBtn = _el('button', { type: 'button', className: 'graph-sweep-run' }, 'Run sweep');
    this._runBtn.addEventListener('click', () => this._runSweep());
    this._showTimeBtn = _el('button', {
      type: 'button',
      className: 'graph-fit-btn graph-fit-btn-muted graph-sweep-show-time',
      hidden: true,
    }, 'Show vs time');
    this._showTimeBtn.addEventListener('click', () => this.setMode('time'));
    sweepActions.append(this._runBtn, this._showTimeBtn);
    this._sweepPanel.append(form, sweepActions);
    this._advanced.append(this._advancedSummary, this._sweepPanel);
    this._advanced.addEventListener('toggle', () => {
      if (this._advanced.open) this.refreshSweepOptions();
    });

    this._fitBar = this._buildFitBar();

    this._readout = _el('div', { className: 'graph-readout' }, 'No data — run a capture.');
    this._plotWrap = _el('div', { className: 'graph-plot-wrap' });
    this._svg = _svg('svg', { class: 'graph-plot', width: '100%', height: '100%' });
    this._plotWrap.appendChild(this._svg);

    const resizeHandle = _el('div', {
      className: 'graph-window-resize',
      title: 'Resize',
      'aria-label': 'Resize graph window',
    });
    this._wireResize(resizeHandle);
    this._wirePlotNav();

    /** True while the pointer is over the plot (show datapoint / extrema marks). */
    this._plotHovered = false;
    /** @type {SVGGElement|null} */
    this._hoverMarksG = null;

    this.el.append(
      header,
      this._mainToolbar,
      this._advanced,
      this._fitBar,
      this._readout,
      this._plotWrap,
      resizeHandle,
    );
    this.el.addEventListener('pointerdown', () => host.bringToFront(this));

    this._applyModeChrome();

    this._ro = new ResizeObserver(() => {
      if (this._series.length) this._redrawOnly();
    });
    this._ro.observe(this._plotWrap);
  }

  dispose() {
    this._ro?.disconnect();
    this._ro = null;
    this.host._clearHovered(this);
    this._removeDockTab();
  }

  focus() {
    if (this.minimized) this.host.restoreGraph(this);
    else this.host.bringToFront(this);
  }

  minimize() {
    if (this.minimized) return;
    this.minimized = true;
    this.el.hidden = true;
    this.el.classList.add('is-minimized');
    this.host._clearHovered(this);
    this._ensureDockTab();
    this._syncDockTabLabel();
  }

  restore() {
    if (!this.minimized) return;
    this.minimized = false;
    this.el.hidden = false;
    this.el.classList.remove('is-minimized');
    this._removeDockTab();
    // Re-layout plot after being hidden.
    requestAnimationFrame(() => {
      if (this._series.length) this._redrawOnly();
      else this.refresh();
    });
  }

  _ensureDockTab() {
    if (this._tabEl) return;
    this._tabEl = _el('button', {
      type: 'button',
      className: 'graph-dock-tab',
      title: 'Restore graph',
    });
    this._tabEl.addEventListener('click', () => this.host.restoreGraph(this));
    this.host._dock.appendChild(this._tabEl);
  }

  _removeDockTab() {
    this._tabEl?.remove();
    this._tabEl = null;
  }

  _syncDockTabLabel() {
    if (!this._tabEl) return;
    const label = this._titleEl?.textContent?.trim() || 'Graph';
    this._tabEl.textContent = label;
    this._tabEl.title = `Restore: ${label}`;
  }

  /** @param {string} text */
  _setTitle(text) {
    this._titleEl.textContent = text;
    this._syncDockTabLabel();
  }

  /**
   * @param {GraphMode} mode
   */
  setMode(mode) {
    if (mode !== 'time' && mode !== 'phase' && mode !== 'sweep') return;
    if (mode === 'phase' && !this._canEnterPhase()) return;
    if (this.mode === mode) {
      this._applyModeChrome();
      return;
    }
    if (mode === 'phase') {
      if (this.sourceKind === 'measurement') {
        this._ensureMeasPhasePair();
      } else {
        this._inferPhaseAxes();
        if (this._obsXSelect) this._obsXSelect.value = this.phaseObsX;
        if (this._obsYSelect) this._obsYSelect.value = this.phaseObsY;
      }
      const h = Math.max(this.el.offsetHeight, 420);
      this.el.style.height = `${h}px`;
    }
    this.mode = mode;
    this._selectedIndex = null;
    this._hoverPt = null;
    this._autoView = true;
    this._view = null;
    this._dataBounds = null;
    this._series = [];
    this._yExtrema = null;
    this._clearFit();
    this._applyModeChrome();
    if (mode === 'sweep') {
      if (this._advanced) this._advanced.open = true;
      const h = Math.max(this.el.offsetHeight, 380);
      this.el.style.height = `${h}px`;
      this.refreshSweepOptions();
    }
    this.refresh();
  }

  _applyModeChrome() {
    const isSweep = this.mode === 'sweep';
    let isPhase = this.mode === 'phase';
    const isMeas = this.sourceKind === 'measurement';
    const canPhase = this._canEnterPhase();
    if (isPhase && !canPhase) {
      this.mode = 'time';
      isPhase = false;
      this._clearFit();
    }
    if (isPhase && isMeas) this._ensureMeasPhasePair();
    this._syncPhaseAxisSelects();
    this.el.classList.toggle('graph-window-sweep', isSweep);
    this.el.classList.toggle('graph-window-phase', isPhase);
    this.el.setAttribute('aria-label', isSweep
      ? 'Parameter sweep graph'
      : isPhase
        ? (isMeas ? 'Parametric measurement graph' : 'Phase portrait graph')
        : 'Observable graph');
    if (this._obsSelect) this._obsSelect.disabled = isSweep || isMeas || isPhase;
    if (this._obsLabel) this._obsLabel.hidden = isMeas || isPhase;
    if (this._obsSelect) this._obsSelect.hidden = isMeas || isPhase;
    if (this._phaseObsWrap) this._phaseObsWrap.hidden = !isPhase;
    if (this._phaseBoundsWrap) this._phaseBoundsWrap.hidden = !isPhase;
    const showPhaseBg = isPhase && !isMeas;
    if (this._phaseBgLabel) this._phaseBgLabel.hidden = !showPhaseBg;
    if (this._phaseOverlaySelect) this._phaseOverlaySelect.hidden = !showPhaseBg;
    this._syncUnwrapChrome();
    if (this._phaseBtn) {
      this._phaseBtn.hidden = isSweep;
      this._phaseBtn.disabled = !canPhase;
      this._phaseBtn.classList.toggle('active', isPhase);
      if (isPhase) this._phaseBtn.textContent = 'Time';
      else if (isMeas) this._phaseBtn.textContent = 'Parametric';
      else this._phaseBtn.textContent = 'Phase';
      this._phaseBtn.title = isPhase
        ? 'Switch to time series plot'
        : isMeas
          ? (canPhase
            ? 'Parametric plot — one measurement vs another (e.g. θ₁ vs θ₂)'
            : 'Need at least two measurements for a parametric plot')
          : canPhase
            ? 'Phase portrait — conjugate position vs momentum (1 DOF)'
            : 'Phase portrait requires a 1-DOF body (e.g. pendulum, spring–mass)';
    }
    if (this._fitBar) this._fitBar.hidden = isPhase;
    if (this._showTimeBtn) this._showTimeBtn.hidden = !isSweep;
    if (this._advancedSummary) {
      this._advancedSummary.textContent = isSweep
        ? 'Advanced — parameter sweep (showing sweep)'
        : 'Advanced — parameter sweep';
    }
    this._syncFitDegreeVisibility();
    if (isPhase) this._syncPhaseBoundsInputs();
  }

  /** Show Unwrap θ when plotting pendulum angle (time or phase). */
  _syncUnwrapChrome() {
    if (!this._unwrapWrap) return;
    if (this.mode === 'sweep') {
      this._unwrapWrap.hidden = true;
      return;
    }
    if (this.sourceKind === 'measurement') {
      // Parametric: optional unwrap past ±180°. Time series uses measurement.continuous.
      const show = this.mode === 'phase' && (
        this._selectedMeasurement()?.kind === 'angle'
        || this._selectedMeasurementY()?.kind === 'angle'
      );
      this._unwrapWrap.hidden = !show;
      if (this._unwrapCheck) this._unwrapCheck.checked = this.unwrapAngle;
      return;
    }
    const wantsTheta = this.mode === 'phase'
      ? (this.phaseObsX === 'theta' || this.phaseObsY === 'theta')
      : this.observable === 'theta';
    this._unwrapWrap.hidden = !wantsTheta;
    if (this._unwrapCheck) this._unwrapCheck.checked = this.unwrapAngle;
  }

  /** @returns {boolean} */
  _trackIsOneDof() {
    if (this.sourceKind !== 'body' || this.trackId == null) return false;
    const engine = this.host._opts.getEngine?.();
    return !!(engine && trackIsOneDof(engine, this.trackId));
  }

  /** @returns {object[]} */
  _listMeasurements() {
    return this.host._opts.listMeasurements?.()
      ?? this.host._opts.getBaselineScene?.()?.measurements
      ?? [];
  }

  /** @returns {boolean} */
  _canMeasurementParametric() {
    return this._listMeasurements().filter(m => m?.id).length >= 2;
  }

  /** Body 1-DOF phase portrait or measurement×measurement parametric. */
  _canEnterPhase() {
    if (this.sourceKind === 'measurement') return this._canMeasurementParametric();
    return this._trackIsOneDof();
  }

  _fillBodyPhaseObsSelects() {
    if (!this._obsXSelect || !this._obsYSelect) return;
    this._obsXSelect.innerHTML = '';
    this._obsYSelect.innerHTML = '';
    for (const o of GRAPH_OBSERVABLES) {
      this._obsXSelect.appendChild(_el('option', { value: o.id }, `${o.label} (${o.unit})`));
      this._obsYSelect.appendChild(_el('option', { value: o.id }, `${o.label} (${o.unit})`));
    }
    this._phaseSelectKind = 'body';
  }

  _fillMeasPhaseObsSelects() {
    if (!this._obsXSelect || !this._obsYSelect) return;
    const measurements = this._listMeasurements().filter(m => m?.id);
    this._obsXSelect.innerHTML = '';
    this._obsYSelect.innerHTML = '';
    for (const m of measurements) {
      const unit = m.kind === 'length' ? 'm' : '°';
      const name = `${measurementDisplayLabel(m)} (${unit})`;
      this._obsXSelect.appendChild(_el('option', { value: m.id }, name));
      this._obsYSelect.appendChild(_el('option', { value: m.id }, name));
    }
    this._phaseSelectKind = 'measurement';
  }

  /** Keep X/Y selects populated for body phase vs measurement parametric. */
  _syncPhaseAxisSelects() {
    if (!this._obsXSelect || this.mode !== 'phase') return;
    if (this.sourceKind === 'measurement') {
      this._fillMeasPhaseObsSelects();
      if (this.measurementId) this._obsXSelect.value = this.measurementId;
      if (this.measurementIdY) this._obsYSelect.value = this.measurementIdY;
    } else {
      if (this._phaseSelectKind !== 'body') this._fillBodyPhaseObsSelects();
      this._obsXSelect.value = this.phaseObsX;
      this._obsYSelect.value = this.phaseObsY;
    }
  }

  /** Ensure measurementId / measurementIdY form a valid distinct pair. */
  _ensureMeasPhasePair() {
    const measurements = this._listMeasurements().filter(m => m?.id);
    if (measurements.length < 2) return;
    if (!this.measurementId || !measurements.some(m => m.id === this.measurementId)) {
      this.measurementId = measurements[0].id;
    }
    if (!this.measurementIdY
      || this.measurementIdY === this.measurementId
      || !measurements.some(m => m.id === this.measurementIdY)) {
      this.measurementIdY = measurements.find(m => m.id !== this.measurementId)?.id ?? null;
    }
  }

  /** Pick conjugate position/momentum axes from the current time-series observable. */
  _inferPhaseAxes() {
    const obs = this.observable;
    if (obs === 'theta' || obs === 'ptheta') {
      this.phaseObsX = 'theta';
      this.phaseObsY = 'ptheta';
      return;
    }
    if (obs === 'vx' || obs === 'px') { this.phaseObsX = 'x'; this.phaseObsY = 'px'; return; }
    if (obs === 'vy' || obs === 'py') { this.phaseObsX = 'y'; this.phaseObsY = 'py'; return; }
    if (obs === 'y') { this.phaseObsX = 'y'; this.phaseObsY = 'py'; return; }
    this.phaseObsX = 'x';
    this.phaseObsY = 'px';
  }

  _syncPhaseBoundsInputs() {
    if (!this._phaseXMin || !this._view) return;
    const { t0, t1, v0, v1 } = this._view;
    this._phaseXMin.value = String(Number(t0.toPrecision(8)));
    this._phaseXMax.value = String(Number(t1.toPrecision(8)));
    this._phaseYMin.value = String(Number(v0.toPrecision(8)));
    this._phaseYMax.value = String(Number(v1.toPrecision(8)));
  }

  _applyPhaseBoundsFromInputs() {
    if (!this._phaseXMin || this.mode !== 'phase') return;
    const t0 = parseFloat(this._phaseXMin.value);
    const t1 = parseFloat(this._phaseXMax.value);
    const v0 = parseFloat(this._phaseYMin.value);
    const v1 = parseFloat(this._phaseYMax.value);
    if (![t0, t1, v0, v1].every(Number.isFinite)) return;
    if (Math.abs(t1 - t0) < 1e-9 || Math.abs(v1 - v0) < 1e-9) return;
    this._autoView = false;
    this._view = {
      t0: Math.min(t0, t1),
      t1: Math.max(t0, t1),
      v0: Math.min(v0, v1),
      v1: Math.max(v0, v1),
    };
    this._redrawOnly();
  }

  _onBodyChange() {
    const opt = this._bodySelect.selectedOptions[0];
    const wasPhase = this.mode === 'phase';
    if (!opt || opt.value === '') {
      this.bodyId = null;
      this.trackId = null;
      this.sourceKind = 'body';
      this.measurementId = null;
      this.measurementIdY = null;
    } else if (opt.dataset.kind === 'measurement' || opt.value.startsWith('meas:')) {
      this.sourceKind = 'measurement';
      this.measurementId = opt.dataset.measId || opt.value.slice(5);
      this.bodyId = null;
      this.trackId = null;
      if (wasPhase) this._ensureMeasPhasePair();
    } else {
      this.sourceKind = 'body';
      this.measurementId = null;
      this.measurementIdY = null;
      this.trackId = Number(opt.value);
      const hostId = opt.dataset.hostId != null ? Number(opt.dataset.hostId) : this.trackId;
      this.bodyId = hostId;
    }
    if (wasPhase && !this._canEnterPhase()) {
      this.mode = 'time';
    }
    this._applyModeChrome();
    this._selectedIndex = null;
    if (this._advanced?.open || this.mode === 'sweep') {
      this.refreshSweepOptions();
    }
    if (this.mode === 'sweep') {
      // Keep sweep plot, options updated for the next run.
      this._updateReadoutOnly();
      return;
    }
    this._clearFit();
    this.resetView(false);
    this.refresh();
  }

  /**
   * Scene-document body id for the selected Body (Matter label / doc id).
   * For v/F-coupled measurements, returns the parent body label.
   * @returns {string|null}
   */
  _sceneBodyId() {
    if (this.sourceKind === 'measurement') {
      const doc = this.host._opts.getBaselineScene?.();
      const m = this._selectedMeasurement(doc);
      const parent = m ? measurementVectorParent(m) : null;
      if (parent?.bodyLabel) return parent.bodyLabel;
      if (m) {
        const anchors = m.kind === 'angle' ? [m.vertex, m.a, m.b] : [m.a, m.b];
        for (const a of anchors) {
          const id = a?.body ?? a?.bodyLabel;
          if (typeof id === 'string') return id;
        }
      }
      const bodies = (doc?.bodies ?? []).filter(
        b => b && b.type !== 'ground' && b.type !== 'anchor' && b.type !== 'metric-basis',
      );
      return bodies[0]?.id ?? null;
    }
    const opt = this._bodySelect.selectedOptions[0];
    if (opt?.dataset.sceneId) return opt.dataset.sceneId;
    const doc = this.host._opts.getBaselineScene?.();
    const bodies = (doc?.bodies ?? []).filter(
      b => b && b.type !== 'ground' && b.type !== 'anchor' && b.type !== 'metric-basis',
    );
    if (!bodies.length) return null;
    if (opt?.value) {
      const byId = bodies.find(b => b.id === opt.dataset.sceneId || b.id === opt.textContent);
      if (byId) return byId.id;
    }
    return bodies[0]?.id ?? null;
  }

  /**
   * @param {object|null} [doc]
   * @returns {object|null}
   */
  _selectedMeasurement(doc = null) {
    if (this.sourceKind !== 'measurement' || !this.measurementId) return null;
    const live = this.host._opts.listMeasurements?.() ?? [];
    const fromLive = live.find(m => m.id === this.measurementId);
    if (fromLive) return fromLive;
    const baseline = doc ?? this.host._opts.getBaselineScene?.();
    return (baseline?.measurements ?? []).find(m => m.id === this.measurementId) ?? null;
  }

  /**
   * Y-axis measurement for parametric plots.
   * @param {object|null} [doc]
   * @returns {object|null}
   */
  _selectedMeasurementY(doc = null) {
    if (!this.measurementIdY) return null;
    const live = this.host._opts.listMeasurements?.() ?? [];
    const fromLive = live.find(m => m.id === this.measurementIdY);
    if (fromLive) return fromLive;
    const baseline = doc ?? this.host._opts.getBaselineScene?.();
    return (baseline?.measurements ?? []).find(m => m.id === this.measurementIdY) ?? null;
  }

  _buildFitBar() {
    const bar = _el('div', { className: 'graph-fit-bar' });

    this._fitModelSelect = _el('select', {
      className: 'graph-select graph-select-math',
      title: 'Fit model',
      'aria-label': 'Fit model',
    });
    for (const m of FIT_MODELS) {
      this._fitModelSelect.appendChild(_el('option', { value: m.id }, m.label));
    }
    this._fitModelSelect.value = 'sinusoidal';
    this._fitModelSelect.addEventListener('change', () => this._syncFitDegreeVisibility());

    this._fitDegreeWrap = _el('span', { className: 'graph-fit-degree-wrap' });
    this._fitDegreeWrap.append(_el('label', { className: 'graph-field-label' }, 'deg'));
    this._fitDegreeInput = _el('input', {
      type: 'number',
      className: 'graph-num graph-fit-degree',
      min: '1',
      max: '8',
      step: '1',
      value: '2',
      title: 'Polynomial degree',
      'aria-label': 'Polynomial degree',
    });
    this._fitDegreeWrap.appendChild(this._fitDegreeInput);

    this._fitDomainWrap = _el('span', { className: 'graph-fit-domain-wrap' });
    this._fitDomainWrap.append(_el('label', { className: 'graph-field-label' }, 'x∈'));
    this._fitDomainMin = _el('input', {
      type: 'number',
      className: 'graph-num graph-fit-domain',
      step: 'any',
      placeholder: 'from',
      title: 'Fit domain start (x min)',
      'aria-label': 'Fit domain from',
    });
    this._fitDomainWrap.appendChild(this._fitDomainMin);
    this._fitDomainWrap.append(_el('span', { className: 'graph-fit-domain-sep' }, '–'));
    this._fitDomainMax = _el('input', {
      type: 'number',
      className: 'graph-num graph-fit-domain',
      step: 'any',
      placeholder: 'to',
      title: 'Fit domain end (x max)',
      'aria-label': 'Fit domain to',
    });
    this._fitDomainWrap.appendChild(this._fitDomainMax);
    const domainAllBtn = _el('button', {
      type: 'button',
      className: 'graph-fit-btn graph-fit-btn-muted graph-fit-domain-all',
      title: 'Use full data range',
    }, 'All');
    domainAllBtn.addEventListener('click', () => this._fillFitDomainFromSeries(true));
    this._fitDomainWrap.appendChild(domainAllBtn);

    /** Last auto-filled series extents: used so we can refresh defaults without clobbering edits. */
    // (also tracked on the window as this._fitDomainAuto)

    const fitBtn = _el('button', { type: 'button', className: 'graph-fit-btn' }, 'Fit');
    fitBtn.addEventListener('click', () => this._runFit());
    const clearBtn = _el('button', { type: 'button', className: 'graph-fit-btn graph-fit-btn-muted' }, 'Clear');
    clearBtn.addEventListener('click', () => {
      this._clearFit();
      this._redrawOnly();
      this._updateReadoutOnly();
    });

    const desmosWrap = _el('div', { className: 'graph-desmos-wrap' });

    const viewBtn = _el('button', {
      type: 'button',
      className: 'graph-fit-btn graph-desmos-view-btn',
      title: 'View in Desmos',
    });
    viewBtn.append(
      _desmosIcon(),
      document.createTextNode('View in Desmos'),
    );
    viewBtn.addEventListener('click', () => {
      if (!this._series.length) {
        this._flashDesmosStatus('No data to open — run a capture first');
        return;
      }
      const title = this._titleEl?.textContent?.trim() || 'Inertia graph';
      const ok = openInDesmos(this._series, this._fitResult, { title: `Inertia · ${title}` });
      this._flashDesmosStatus(ok ? 'Opened Desmos in a new tab' : 'Could not open Desmos view');
    });

    const copyWrap = _el('div', { className: 'graph-desmos-copy-wrap' });
    const copyBtn = _el('button', {
      type: 'button',
      className: 'graph-fit-btn graph-fit-btn-muted graph-desmos-copy-btn',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Copy for pasting into Desmos',
    }, 'Copy ▾');
    const menu = _el('div', {
      className: 'graph-desmos-menu hidden',
      role: 'menu',
    });
    const items = [
      { id: 'data', label: 'Copy data' },
      { id: 'equation', label: 'Copy equation' },
      { id: 'regression', label: 'Copy regression' },
      { id: 'all', label: 'Copy all' },
    ];
    for (const it of items) {
      const b = _el('button', { type: 'button', className: 'graph-desmos-item', role: 'menuitem', 'data-action': it.id }, it.label);
      b.addEventListener('click', async () => {
        menu.classList.add('hidden');
        copyBtn.setAttribute('aria-expanded', 'false');
        await this._copyDesmos(it.id);
      });
      menu.appendChild(b);
    }
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      copyBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', () => {
      menu.classList.add('hidden');
      copyBtn.setAttribute('aria-expanded', 'false');
    });
    copyWrap.append(copyBtn, menu);
    desmosWrap.append(viewBtn, copyWrap);

    bar.append(
      _el('label', { className: 'graph-field-label' }, 'Fit'),
      this._fitModelSelect,
      this._fitDegreeWrap,
      this._fitDomainWrap,
      fitBtn,
      clearBtn,
      desmosWrap,
    );
    this._syncFitDegreeVisibility();
    return bar;
  }

  _syncFitDegreeVisibility() {
    const poly = this._fitModelSelect?.value === 'polynomial';
    if (this._fitDegreeWrap) this._fitDegreeWrap.hidden = !poly;
  }

  _clearFit() {
    this._fitResult = null;
    this._fitOverlay = [];
    this._fitError = '';
    this._fitKey = '';
    this._fitDomainUsed = null;
  }

  _currentFitKey() {
    if (this.mode === 'sweep') return `sweep:${this._indepSelect?.value}:${this._depSelect?.value}`;
    if (this.mode === 'phase' && this.sourceKind === 'measurement') {
      return `phase:meas:${this.measurementId}:${this.measurementIdY}`;
    }
    if (this.mode === 'phase') return `phase:${this.trackId}:${this.phaseObsX}:${this.phaseObsY}`;
    if (this.sourceKind === 'measurement') return `time:meas:${this.measurementId}`;
    return `time:${this.trackId}:${this.observable}`;
  }

  /**
   * Full x-extent of the current series.
   * @returns {{ t0: number, t1: number }|null}
   */
  _seriesXExtent() {
    if (!this._series.length) return null;
    let t0 = this._series[0].t;
    let t1 = t0;
    for (const p of this._series) {
      if (p.t < t0) t0 = p.t;
      if (p.t > t1) t1 = p.t;
    }
    return { t0, t1 };
  }

  /**
   * Fill domain inputs from series. If `force` is false, only update when empty
   * or still matching the previous auto-fill (so manual edits stick).
   * @param {boolean} [force=false]
   */
  _fillFitDomainFromSeries(force = false) {
    const ext = this._seriesXExtent();
    if (!ext || !this._fitDomainMin || !this._fitDomainMax) return;
    const lo = this._fitDomainMin.value.trim();
    const hi = this._fitDomainMax.value.trim();
    const auto = this._fitDomainAuto;
    const stillAuto = auto
      && lo !== '' && hi !== ''
      && Math.abs(parseFloat(lo) - auto.t0) < 1e-9
      && Math.abs(parseFloat(hi) - auto.t1) < 1e-9;
    if (!force && lo !== '' && hi !== '' && !stillAuto) return;

    this._fitDomainMin.value = String(Number(ext.t0.toPrecision(8)));
    this._fitDomainMax.value = String(Number(ext.t1.toPrecision(8)));
    this._fitDomainAuto = { t0: ext.t0, t1: ext.t1 };
  }

  /**
   * Domain used for fitting. Empty / invalid inputs → full series.
   * @returns {{ t0: number, t1: number }|null}
   */
  _getFitDomain() {
    const ext = this._seriesXExtent();
    if (!ext) return null;
    let t0 = parseFloat(this._fitDomainMin?.value ?? '');
    let t1 = parseFloat(this._fitDomainMax?.value ?? '');
    if (!Number.isFinite(t0)) t0 = ext.t0;
    if (!Number.isFinite(t1)) t1 = ext.t1;
    if (t1 < t0) { const s = t0; t0 = t1; t1 = s; }
    return { t0, t1 };
  }

  /**
   * @param {{ t0: number, t1: number }} domain
   * @returns {{ t: number, v: number, i: number }[]}
   */
  _seriesInDomain(domain) {
    const eps = Math.max(1e-12, (domain.t1 - domain.t0) * 1e-12);
    return this._series.filter(p => p.t >= domain.t0 - eps && p.t <= domain.t1 + eps);
  }

  _runFit() {
    if (this.mode === 'phase') {
      this._fitError = 'Curve fitting is not available for phase portraits';
      this._fitResult = null;
      this._fitOverlay = [];
      this._updateReadoutOnly();
      return;
    }
    if (!this._series.length) {
      this._fitError = 'No data to fit — run a capture or sweep first';
      this._fitResult = null;
      this._fitOverlay = [];
      this._updateReadoutOnly();
      return;
    }

    const domain = this._getFitDomain();
    if (!domain) {
      this._fitError = 'Invalid fit domain';
      this._updateReadoutOnly();
      return;
    }

    const subset = this._seriesInDomain(domain);
    if (!subset.length) {
      this._fitError = 'No data points in the chosen domain';
      this._fitResult = null;
      this._fitOverlay = [];
      this._redrawOnly();
      this._updateReadoutOnly();
      return;
    }

    const model = /** @type {import('../fit/types.js').FitModelId} */ (this._fitModelSelect.value);
    const degree = Math.max(1, Math.min(8, Math.round(parseFloat(this._fitDegreeInput.value) || 2)));
    this._fitDegreeInput.value = String(degree);

    try {
      const result = fit(
        subset.map(p => ({ x: p.t, y: p.v })),
        model,
        { degree },
      );
      this._fitResult = result;
      this._fitError = '';
      this._fitKey = this._currentFitKey();
      this._fitDomainUsed = { t0: domain.t0, t1: domain.t1 };
      this._rebuildFitOverlay();
      this._includeFitInBounds();
      this._redrawOnly();
      this._updateReadoutOnly();
    } catch (err) {
      this._fitResult = null;
      this._fitOverlay = [];
      this._fitDomainUsed = null;
      this._fitError = err instanceof FitError ? err.message : (err?.message ?? 'Fit failed');
      this._redrawOnly();
      this._updateReadoutOnly();
    }
  }

  _rebuildFitOverlay() {
    if (!this._fitResult || !this._series.length) {
      this._fitOverlay = [];
      return;
    }
    const domain = this._fitDomainUsed || this._getFitDomain() || this._seriesXExtent();
    if (!domain) {
      this._fitOverlay = [];
      return;
    }
    this._fitOverlay = sampleFit(this._fitResult, domain.t0, domain.t1, 220);
  }

  _includeFitInBounds() {
    if (!this._fitOverlay.length || !this._dataBounds) return;
    let v0 = this._dataBounds.v0;
    let v1 = this._dataBounds.v1;
    for (const p of this._fitOverlay) {
      if (p.v < v0) v0 = p.v;
      if (p.v > v1) v1 = p.v;
    }
    this._dataBounds = { ...this._dataBounds, v0, v1 };
    if (this._autoView) this._view = { ...this._dataBounds };
  }

  /**
   * @param {'data'|'equation'|'regression'|'all'} action
   */
  async _copyDesmos(action) {
    let text = '';
    if (action === 'data') {
      if (!this._series.length) {
        this._flashDesmosStatus('No data to copy');
        return;
      }
      text = formatDesmosListsFromSeries(this._series);
    } else if (action === 'equation') {
      text = formatDesmosEquation(this._fitResult);
      if (!text) {
        this._flashDesmosStatus('Fit a model first');
        return;
      }
    } else if (action === 'regression') {
      text = formatDesmosRegression(this._fitResult);
      if (!text) {
        this._flashDesmosStatus('Fit a model first');
        return;
      }
    } else {
      if (!this._series.length) {
        this._flashDesmosStatus('No data to copy');
        return;
      }
      text = formatDesmosBundle(this._series, this._fitResult);
    }
    const ok = await copyText(text);
    this._flashDesmosStatus(ok ? 'Copied for Desmos' : 'Copy failed');
  }

  _flashDesmosStatus(msg) {
    const prev = this._readout.textContent;
    this._readout.textContent = msg;
    clearTimeout(this._desmosFlashTimer);
    this._desmosFlashTimer = setTimeout(() => {
      this._updateReadoutOnly();
      if (this._readout.textContent === msg) {
        // readout restored by _updateReadoutOnly
      }
      void prev;
    }, 1200);
  }

  /**
   * Fit view to recorded data bounds.
   * @param {boolean} [redraw=true]
   */
  resetView(redraw = true) {
    this._autoView = true;
    this._view = this._dataBounds ? { ...this._dataBounds } : null;
    if (redraw && this._series.length) this._redrawOnly();
  }

  _wireDrag(header) {
    let dragging = false;
    let ox = 0;
    let oy = 0;
    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      ox = e.clientX - this.el.offsetLeft;
      oy = e.clientY - this.el.offsetTop;
      header.setPointerCapture(e.pointerId);
      this.focus();
    });
    header.addEventListener('pointermove', e => {
      if (!dragging) return;
      const parent = this.el.offsetParent || document.body;
      const maxL = Math.max(0, parent.clientWidth - 80);
      const maxT = Math.max(0, parent.clientHeight - 40);
      this.el.style.left = `${Math.min(maxL, Math.max(0, e.clientX - ox))}px`;
      this.el.style.top = `${Math.min(maxT, Math.max(0, e.clientY - oy))}px`;
    });
    header.addEventListener('pointerup', () => { dragging = false; });
    header.addEventListener('pointercancel', () => { dragging = false; });
  }

  _wireResize(handle) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = this.el.offsetWidth;
      startH = this.el.offsetHeight;
      handle.setPointerCapture(e.pointerId);
      this.focus();
    });
    handle.addEventListener('pointermove', e => {
      if (!resizing) return;
      const parent = this.el.offsetParent || document.body;
      const maxW = Math.max(MIN_WIN_W, parent.clientWidth - this.el.offsetLeft - 8);
      const maxH = Math.max(MIN_WIN_H, parent.clientHeight - this.el.offsetTop - 8);
      const w = Math.min(maxW, Math.max(MIN_WIN_W, startW + (e.clientX - startX)));
      const h = Math.min(maxH, Math.max(MIN_WIN_H, startH + (e.clientY - startY)));
      this.el.style.width = `${w}px`;
      this.el.style.height = `${h}px`;
    });
    handle.addEventListener('pointerup', () => { resizing = false; });
    handle.addEventListener('pointercancel', () => { resizing = false; });
  }

  /**
   * Interaction lives on the HTML wrap so SVG redraws do not drop pointer capture.
   */
  _wirePlotNav() {
    const wrap = this._plotWrap;

    wrap.addEventListener('pointerenter', () => {
      this.host._setHovered(this);
      this._setPlotHovered(true);
    });
    wrap.addEventListener('pointerleave', () => {
      if (this._drag) return;
      this.host._clearHovered(this);
      this._hoverPt = null;
      this._setPlotHovered(false);
      this._updateReadoutOnly();
    });

    wrap.addEventListener('wheel', e => {
      if (!this._series.length || !this._view) return;
      e.preventDefault();
      e.stopPropagation();

      const map = this._clientToPlot(e.clientX, e.clientY);
      if (!map || !map.inPlot) return;

      const view = this._view;
      const { tAt, vAt, fx, fy } = map;
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;

      let tSpan = (view.t1 - view.t0) * factor;
      let vSpan = (view.v1 - view.v0) * factor;
      const bounds = this._dataBounds;
      if (bounds) {
        const maxT = Math.max(bounds.t1 - bounds.t0, 1e-6) * 8;
        const maxV = Math.max(bounds.v1 - bounds.v0, 1e-6) * 8;
        const minT = Math.max(bounds.t1 - bounds.t0, 1e-6) / 200;
        const minV = Math.max(bounds.v1 - bounds.v0, 1e-6) / 200;
        tSpan = Math.min(maxT, Math.max(minT, tSpan));
        vSpan = Math.min(maxV, Math.max(minV, vSpan));
      }

      this._autoView = false;
      this._view = {
        t0: tAt - fx * tSpan,
        t1: tAt + (1 - fx) * tSpan,
        v0: vAt - (1 - fy) * vSpan,
        v1: vAt + fy * vSpan,
      };
      this._redrawOnly();
      if (this.mode === 'phase') this._syncPhaseBoundsInputs();
    }, { passive: false });

    wrap.addEventListener('pointerdown', e => {
      if (!this._series.length || !this._view) return;
      if (e.button !== 0 && e.button !== 1) return;
      const map = this._clientToPlot(e.clientX, e.clientY);
      if (!map?.inPlot) return;
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      this._drag = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        view: { ...this._view },
        moved: false,
      };
      this.focus();
      this.host._setHovered(this);
      wrap.classList.add('graph-plot-active');
    });

    wrap.addEventListener('pointermove', e => {
      if (this._drag && this._drag.pointerId === e.pointerId) {
        const dx = e.clientX - this._drag.x;
        const dy = e.clientY - this._drag.y;
        if (!this._drag.moved && (dx * dx + dy * dy) < 16) {
          this._hoverPt = this._nearestAtClient(e.clientX, e.clientY);
          this._updateReadoutOnly();
          return;
        }
        this._drag.moved = true;
        this._autoView = false;
        wrap.classList.add('graph-plot-panning');
        const { W, H, iw, ih } = this._plotGeom();
        const rect = this._svg.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        const dT = -(dx / rect.width) * W / iw * (this._drag.view.t1 - this._drag.view.t0);
        const dV = (dy / rect.height) * H / ih * (this._drag.view.v1 - this._drag.view.v0);
        this._view = {
          t0: this._drag.view.t0 + dT,
          t1: this._drag.view.t1 + dT,
          v0: this._drag.view.v0 + dV,
          v1: this._drag.view.v1 + dV,
        };
        this._redrawOnly();
        return;
      }

      if (!this._series.length) return;
      const map = this._clientToPlot(e.clientX, e.clientY);
      if (!map?.inPlot) {
        this._hoverPt = null;
        this._setPlotHovered(false);
        this._updateReadoutOnly();
        return;
      }
      this._setPlotHovered(true);
      this._hoverPt = this._nearestAtClient(e.clientX, e.clientY);
      this._updateReadoutOnly();
      this._drawHoverOverlay();
    });

    const endDrag = (e) => {
      if (!this._drag || this._drag.pointerId !== e.pointerId) return;
      const wasPan = this._drag.moved;
      this._drag = null;
      wrap.classList.remove('graph-plot-panning', 'graph-plot-active');
      if (wasPan && this.mode === 'phase') this._syncPhaseBoundsInputs();
      if (!wasPan && e.type === 'pointerup' && (e.button === 0 || e.button === -1)) {
        const p = this._nearestAtClient(e.clientX, e.clientY, {
          maxPx: (this.mode === 'sweep' || this.mode === 'phase') ? 18 : Infinity,
        });
        if (p) {
          this._selectedIndex = p.i;
          if (this.mode === 'time' || this.mode === 'phase') {
            this.host._opts.onSeek?.(p.i);
          } else if (this.mode === 'sweep') {
            this._loadSweepPoint(p);
          }
          this._redrawOnly();
        }
      }
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
  }

  /**
   * @param {{ W?: number, H?: number }|null|undefined} [override]
   * @param {{ l: number, r: number, t: number, b: number }|null|undefined} [padOverride]
   */
  _plotGeom(override, padOverride = null) {
    const W = override?.W ?? (this._plotWrap.clientWidth || 320);
    const H = override?.H ?? (this._plotWrap.clientHeight || 180);
    const pad = padOverride ?? PAD;
    const iw = Math.max(10, W - pad.l - pad.r);
    const ih = Math.max(10, H - pad.t - pad.b);
    return { W, H, iw, ih, pad };
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  _clientToPlot(clientX, clientY) {
    if (!this._view) return null;
    const { W, H, iw, ih, pad } = this._plotGeom();
    const rect = this._svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const sx = ((clientX - rect.left) / rect.width) * W;
    const sy = ((clientY - rect.top) / rect.height) * H;
    const inPlot = sx >= pad.l && sx <= pad.l + iw && sy >= pad.t && sy <= pad.t + ih;
    const view = this._view;
    const fx = (sx - pad.l) / iw;
    const fy = (sy - pad.t) / ih;
    const tAt = view.t0 + fx * (view.t1 - view.t0);
    const vAt = view.v1 - fy * (view.v1 - view.v0);
    return { sx, sy, fx, fy, tAt, vAt, inPlot, W, H, iw, ih, pad };
  }

  _nearestAtClientX(clientX) {
    return this._nearestAtClient(clientX, this._svg.getBoundingClientRect().top + 1);
  }

  /**
   * Nearest series point to a client position.
   * Time mode: nearest in x (t). Sweep mode: nearest in plot pixels (2D).
   * @param {number} clientX
   * @param {number} clientY
   * @param {{ maxPx?: number }} [opts]
   * @returns {{ t: number, v: number, i: number }|null}
   */
  _nearestAtClient(clientX, clientY, opts = {}) {
    if (!this._series.length || !this._view) return null;
    const maxPx = opts.maxPx ?? Infinity;
    const map = this._clientToPlot(clientX, clientY);
    if (!map) return this._series[0];

    const view = this._view;
    const { iw, ih, pad } = map;
    const xOf = (t) => pad.l + ((t - view.t0) / (view.t1 - view.t0 || 1)) * iw;
    const yOf = (v) => pad.t + ((view.v1 - v) / (view.v1 - view.v0 || 1)) * ih;

    let best = null;
    let bestD = Infinity;

    if (this.mode === 'sweep' || this.mode === 'phase') {
      const sx = map.sx;
      const sy = map.sy;
      for (const p of this._series) {
        const dx = xOf(p.t) - sx;
        const dy = yOf(p.v) - sy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best && Number.isFinite(maxPx) && bestD > maxPx * maxPx) return null;
      return best;
    }

    const tCursor = map.tAt;
    for (const p of this._series) {
      const d = Math.abs(p.t - tCursor);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * Load the live scene configured as the selected sweep run.
   * @param {{ t: number, v: number, i: number }} point
   */
  _loadSweepPoint(point) {
    if (!this._sweepBaseline || !this._sweepParamId) {
      this._sweepStatus = 'Re-run the sweep to load points into the scene.';
      this._updateReadoutOnly();
      return;
    }
    const ok = this.host._opts.onSweepPoint?.({
      x: point.t,
      y: point.v,
      paramId: this._sweepParamId,
      paramLabel: this._sweepParamLabel,
      baseline: this._sweepBaseline,
    });
    if (ok === false) return;
    const xLab = this._sweepXLabel || 'x';
    this._sweepStatus = `Loaded ${xLab} = ${point.t.toFixed(4)}`;
    this._updateReadoutOnly();
  }

  _syncBodyOptions() {
    const bodies = this.host._opts.listBodies();
    const measurements = this.host._opts.listMeasurements?.()
      ?? this.host._opts.getBaselineScene?.()?.measurements
      ?? [];
    const prevTrack = this.trackId;
    const prevMeas = this.measurementId;
    const prevMeasY = this.measurementIdY;
    const prevKind = this.sourceKind;
    this._bodySelect.innerHTML = '';

    if (!bodies.length && !measurements.length) {
      this._bodySelect.appendChild(_el('option', { value: '' }, 'No sources'));
      this.bodyId = null;
      this.trackId = null;
      this.sourceKind = 'body';
      this.measurementId = null;
      this.measurementIdY = null;
      return;
    }

    if (bodies.length) {
      const gBodies = /** @type {HTMLOptGroupElement} */ (_el('optgroup', { label: 'Bodies' }));
      for (const b of bodies) {
        const trackId = b.trackId ?? b.id;
        const name = b.label || b.type || `body ${b.id}`;
        const opt = _el('option', { value: String(trackId) }, name);
        opt.dataset.kind = 'body';
        opt.dataset.hostId = String(b.id);
        if (b.sceneId) opt.dataset.sceneId = String(b.sceneId);
        gBodies.appendChild(opt);
      }
      this._bodySelect.appendChild(gBodies);
    }

    // Nest v/F-coupled measurements under their parent, standalone stay separate.
    /** @type {Map<string, object[]>} */
    const byParent = new Map();
    /** @type {object[]} */
    const standalone = [];
    for (const m of measurements) {
      if (!m?.id) continue;
      const parent = measurementVectorParent(m);
      if (parent?.bodyLabel) {
        if (!byParent.has(parent.bodyLabel)) byParent.set(parent.bodyLabel, []);
        byParent.get(parent.bodyLabel).push({ m, parent });
      } else {
        standalone.push(m);
      }
    }
    for (const [bodyLabel, list] of byParent) {
      const g = /** @type {HTMLOptGroupElement} */ (
        _el('optgroup', { label: `${bodyLabel} · measurements` })
      );
      for (const { m, parent } of list) {
        const unit = m.kind === 'length' ? 'm' : '°';
        const tag = parent.couple === 'force' ? 'F' : 'v';
        const name = `${measurementDisplayLabel(m)} (${unit}, ${tag})`;
        const opt = _el('option', { value: `meas:${m.id}` }, name);
        opt.dataset.kind = 'measurement';
        opt.dataset.measId = String(m.id);
        opt.dataset.parentBody = bodyLabel;
        opt.dataset.couple = parent.couple;
        g.appendChild(opt);
      }
      this._bodySelect.appendChild(g);
    }
    if (standalone.length) {
      const gMeas = /** @type {HTMLOptGroupElement} */ (
        _el('optgroup', { label: 'Measurements' })
      );
      for (const m of standalone) {
        const unit = m.kind === 'length' ? 'm' : '°';
        const name = `${measurementDisplayLabel(m)} (${unit})`;
        const opt = _el('option', { value: `meas:${m.id}` }, name);
        opt.dataset.kind = 'measurement';
        opt.dataset.measId = String(m.id);
        gMeas.appendChild(opt);
      }
      this._bodySelect.appendChild(gMeas);
    }

    if (prevKind === 'measurement' && prevMeas
      && measurements.some(m => m.id === prevMeas)) {
      this.sourceKind = 'measurement';
      this.measurementId = prevMeas;
      this.measurementIdY = prevMeasY && measurements.some(m => m.id === prevMeasY)
        ? prevMeasY
        : null;
      this.bodyId = null;
      this.trackId = null;
      this._bodySelect.value = `meas:${prevMeas}`;
      if (this.mode === 'phase') this._ensureMeasPhasePair();
      this._applyModeChrome();
      return;
    }

    const stillThere = prevTrack != null && bodies.some(b => (b.trackId ?? b.id) === prevTrack);
    if (stillThere) {
      this.sourceKind = 'body';
      this.measurementId = null;
      this.measurementIdY = null;
      this.trackId = prevTrack;
      const entry = bodies.find(b => (b.trackId ?? b.id) === prevTrack);
      this.bodyId = entry?.id ?? prevTrack;
      this._bodySelect.value = String(prevTrack);
      this._applyModeChrome();
      return;
    }

    const host = bodies.find(b => b.id === this.bodyId)
      ?? bodies.find(b => b.trackId === prevTrack)
      ?? bodies[0];
    if (host) {
      this.sourceKind = 'body';
      this.measurementId = null;
      this.measurementIdY = null;
      this.bodyId = host.id;
      this.trackId = host.trackId ?? host.id;
      this._bodySelect.value = String(this.trackId);
    } else if (measurements[0]?.id) {
      this.sourceKind = 'measurement';
      this.measurementId = measurements[0].id;
      this.bodyId = null;
      this.trackId = null;
      this._bodySelect.value = `meas:${this.measurementId}`;
      if (this.mode === 'phase') this._ensureMeasPhasePair();
    }
    this._applyModeChrome();
  }

  /** Refresh param/metric lists from the current baseline scene (filtered by Body). */
  refreshSweepOptions() {
    this._syncBodyOptions();
    const doc = this.host._opts.getBaselineScene?.();
    const name = this.host._opts.getSceneName?.() || doc?.meta?.name || 'scene';
    if (!this._series.length && !this._sweepRunning) {
      this._setTitle(`Sweep · ${name}`);
    }

    const sceneBodyId = this._sceneBodyId();
    // Coupled measurements scope independents to their parent body (v/F host).
    // Standalone measurements keep that body's filter when they reference one.
    const filterBody = sceneBodyId;
    const params = doc ? paramsForScene(doc, { bodyId: filterBody }) : [];
    const metrics = doc ? metricsForScene(doc, { bodyId: filterBody }) : [];

    const prevIndep = this._indepSelect.value;
    const prevDep = this._depSelect.value;
    _fillGroupedSelect(this._indepSelect, params, (p) => (
      `${p.label}${p.unit ? ` (${p.unit})` : ''}`
    ), 'No sweepable params');
    _fillGroupedSelect(this._depSelect, metrics, (m) => (
      `${m.label} (${m.unit})`
    ), 'No metrics');

    const m = this.sourceKind === 'measurement' ? this._selectedMeasurement(doc) : null;
    const parent = m ? measurementVectorParent(m) : null;

    let preferIndep = params.find(p => p.preferred)?.id ?? '';
    if (parent?.couple === 'velocity') {
      preferIndep = params.find(p => p.id.includes('velocity.speed'))?.id
        ?? params.find(p => p.id.includes('velocity.thetaDeg'))?.id
        ?? preferIndep;
    } else if (parent?.couple === 'force') {
      preferIndep = params.find(p => p.id.includes('appliedForce.F'))?.id
        ?? params.find(p => p.id.includes('appliedForce.thetaDeg'))?.id
        ?? preferIndep;
    }
    if (!preferIndep) {
      preferIndep = params.find(p => p.id.includes('appliedForce.thetaDeg'))?.id
        ?? params.find(p => p.id.includes('velocity.speed'))?.id
        ?? params.find(p => p.id.includes('velocity.vy'))?.id
        ?? params[0]?.id
        ?? '';
    }

    const preferDep = (this.measurementId && (
      metrics.find(met => met.id === `meas:max:${this.measurementId}`)?.id
      ?? metrics.find(met => met.id === `meas:min:${this.measurementId}`)?.id
    ))
      ?? metrics.find(met => met.preferred)?.id
      ?? metrics.find(met => String(met.id).startsWith('F_slip'))?.id
      ?? metrics.find(met => String(met.id).startsWith('max_y:'))?.id
      ?? metrics[0]?.id
      ?? '';

    if (params.some(p => p.id === prevIndep)) this._indepSelect.value = prevIndep;
    else this._indepSelect.value = preferIndep;

    if (metrics.some(met => met.id === prevDep)) this._depSelect.value = prevDep;
    else this._depSelect.value = preferDep;

    this._onIndepChange();
  }

  _onIndepChange() {
    const doc = this.host._opts.getBaselineScene?.();
    if (!doc) return;
    const sceneBodyId = this._sceneBodyId();
    const filterBody = sceneBodyId;
    const param = paramsForScene(doc, { bodyId: filterBody })
      .find(p => p.id === this._indepSelect.value);
    if (!param) return;
    if (param.defaultMin != null) this._minInput.value = String(param.defaultMin);
    if (param.defaultMax != null) this._maxInput.value = String(param.defaultMax);
    if (param.defaultCount != null) this._countInput.value = String(param.defaultCount);
    const cur = param.read(doc);
    if (cur != null && (param.defaultMin == null || param.defaultMax == null)) {
      this._minInput.value = String(cur * 0.5);
      this._maxInput.value = String(cur * 1.5);
    }
  }

  async _runSweep() {
    if (this._sweepRunning) return;
    const doc = this.host._opts.getBaselineScene?.();
    if (!doc) {
      this._sweepStatus = 'No scene loaded — open a preset or blank scene first.';
      this._updateReadoutOnly();
      return;
    }

    const sceneBodyId = this._sceneBodyId();
    const filterBody = sceneBodyId;
    const params = paramsForScene(doc, { bodyId: filterBody });
    const metrics = metricsForScene(doc, { bodyId: filterBody });
    const param = params.find(p => p.id === this._indepSelect.value);
    const metric = metrics.find(m => m.id === this._depSelect.value);
    if (!param || !metric) {
      this._sweepStatus = 'Choose an independent and dependent variable.';
      this._updateReadoutOnly();
      return;
    }

    const min = parseFloat(this._minInput.value);
    const max = parseFloat(this._maxInput.value);
    const count = parseInt(this._countInput.value, 10);
    if (![min, max, count].every(Number.isFinite) || count < 2 || max === min) {
      this._sweepStatus = 'Invalid range — need From ≠ To and at least 2 runs.';
      this._updateReadoutOnly();
      return;
    }

    if (!this._runner) this._runner = new ExperimentRunner();

    // Enter sweep view without going through setMode (which would clear mid-setup).
    this.mode = 'sweep';
    if (this._advanced) this._advanced.open = true;
    const h = Math.max(this.el.offsetHeight, 380);
    this.el.style.height = `${h}px`;
    this._applyModeChrome();

    this._sweepRunning = true;
    this._runBtn.disabled = true;
    this._selectedIndex = null;
    this._hoverPt = null;
    this._series = [];
    this._yExtrema = null;
    this._clearFit();
    this._autoView = true;
    this._view = null;
    this._dataBounds = null;
    this._sweepBaseline = cloneSceneDocument(doc);
    this._sweepParamId = param.id;
    this._sweepParamLabel = param.label;
    this._sweepXLabel = `${param.label}${param.unit ? ` (${param.unit})` : ''}`;
    this._sweepYLabel = `${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`;
    this._sweepStatus = 'Running…';
    this._setTitle(`${this._sweepXLabel} → ${this._sweepYLabel}`);
    this._drawEmpty('Collecting…');

    try {
      const points = await this._runner.runSweep({
        baseline: this._sweepBaseline,
        param,
        metric,
        min,
        max,
        count,
        onProgress: (done, total, point) => {
          if (point) {
            this._series.push({ t: point.x, v: point.y, i: this._series.length });
            this._yExtrema = _seriesYExtremumIndices(this._series);
            const bounds = seriesBounds(this._series);
            this._dataBounds = bounds;
            if (this._autoView || !this._view) {
              this._view = bounds ? { ...bounds } : null;
            }
            this._redrawOnly();
          }
          this._sweepStatus = `Running ${done} / ${total}…`;
          this._updateReadoutOnly();
        },
      });
      this._series = points.map((p, i) => ({ t: p.x, v: p.y, i }));
      this._yExtrema = _seriesYExtremumIndices(this._series);
      this._sweepStatus = points.length
        ? `Done — ${points.length} points`
        : 'Done — no valid points (check scene bodies / metric).';
      if (this._series.length) {
        this._fillFitDomainFromSeries(true);
        const bounds = seriesBounds(this._series);
        this._dataBounds = bounds;
        if (this._autoView || !this._view) {
          this._view = bounds ? { ...bounds } : null;
          this._autoView = true;
        }
        this._redrawOnly();
      } else {
        this._drawEmpty(this._sweepStatus);
      }
    } catch (err) {
      console.error(err);
      this._sweepStatus = `Sweep failed: ${err?.message ?? err}`;
      this._updateReadoutOnly();
    } finally {
      this._sweepRunning = false;
      this._runBtn.disabled = false;
    }
  }

  refresh() {
    if (this.mode === 'sweep') {
      this._refreshSweep();
      return;
    }
    if (this.mode === 'phase') {
      this._refreshPhase();
      return;
    }
    this._refreshTime();
  }

  _refreshSweep() {
    this._syncBodyOptions();
    if (!this._indepSelect.options.length || this._indepSelect.options[0]?.value === '') {
      this.refreshSweepOptions();
    } else {
      const doc = this.host._opts.getBaselineScene?.();
      const name = this.host._opts.getSceneName?.() || doc?.meta?.name || 'scene';
      if (!this._series.length && !this._sweepRunning) {
        this._setTitle(`Sweep · ${name}`);
      } else if (this._series.length) {
        this._setTitle(`${this._sweepXLabel} → ${this._sweepYLabel}`);
      }
    }

    if (!this._series.length) {
      this._dataBounds = null;
      this._view = null;
      this._autoView = true;
      this._yExtrema = null;
      this._drawEmpty(
        this._sweepRunning
          ? 'Collecting…'
          : (this._sweepStatus || 'Choose variables and run a sweep'),
      );
      return;
    }

    if (!this._yExtrema) {
      this._yExtrema = _seriesYExtremumIndices(this._series);
    }

    const bounds = seriesBounds(this._series);
    this._dataBounds = bounds;
    if (this._autoView || !this._view) {
      this._view = bounds ? { ...bounds } : null;
      this._autoView = true;
    }
    this._redrawOnly();
  }

  _refreshTime() {
    this._syncBodyOptions();
    const frames = this.host._opts.getFrames();
    const doc = this.host._opts.getBaselineScene?.();

    if (this.sourceKind === 'measurement') {
      const m = this._selectedMeasurement(doc);
      const label = m ? measurementDisplayLabel(m) : (this.measurementId || 'measurement');
      const unit = m?.kind === 'length' ? 'm' : '°';
      this._setTitle(`${label} (${unit})`);

      if (!m || !frames.length) {
        this._series = [];
        this._yExtrema = null;
        this._dataBounds = null;
        this._view = null;
        this._autoView = true;
        this._clearFit();
        this._drawEmpty(frames.length ? 'Select a measurement' : 'No recorded frames — run a capture');
        return;
      }

      this._series = buildMeasurementSeries(frames, m, doc);
      if (!this._series.length) {
        this._yExtrema = null;
        this._dataBounds = null;
        this._view = null;
        this._autoView = true;
        this._clearFit();
        this._drawEmpty('Measurement could not be resolved in recording');
        return;
      }

      this._yExtrema = _seriesYExtremumIndices(this._series);
      this._fillFitDomainFromSeries(false);

      if (this._fitResult && this._fitKey !== this._currentFitKey()) {
        this._clearFit();
      } else if (this._fitResult) {
        this._rebuildFitOverlay();
      }

      const bounds = seriesBounds(this._series);
      this._dataBounds = bounds;
      if (this._fitOverlay.length) this._includeFitInBounds();
      if (this._autoView || !this._view) {
        this._view = this._dataBounds ? { ...this._dataBounds } : null;
        this._autoView = true;
      }

      this._redrawOnly();
      return;
    }

    const obsMeta = GRAPH_OBSERVABLES.find(o => o.id === this.observable) ?? GRAPH_OBSERVABLES[1];
    const bodyOpt = [...this._bodySelect.options].find(o => o.value === String(this.trackId));
    const bodyName = bodyOpt?.textContent ?? 'body';
    this._setTitle(`${bodyName} · ${obsMeta.label}(${obsMeta.unit})`);

    if (this.trackId == null || !frames.length) {
      this._series = [];
      this._yExtrema = null;
      this._dataBounds = null;
      this._view = null;
      this._autoView = true;
      this._clearFit();
      this._drawEmpty(frames.length ? 'Select a body' : 'No recorded frames — run a capture');
      return;
    }

    this._series = buildSeries(frames, this.trackId, this.observable, {
      unwrapAngle: this.unwrapAngle,
    });
    if (!this._series.length) {
      this._yExtrema = null;
      this._dataBounds = null;
      this._view = null;
      this._autoView = true;
      this._clearFit();
      this._drawEmpty('Body not present in recording');
      return;
    }

    this._yExtrema = _seriesYExtremumIndices(this._series);
    this._fillFitDomainFromSeries(false);

    if (this._fitResult && this._fitKey !== this._currentFitKey()) {
      this._clearFit();
    } else if (this._fitResult) {
      this._rebuildFitOverlay();
    }

    const bounds = seriesBounds(this._series);
    this._dataBounds = bounds;
    if (this._fitOverlay.length) this._includeFitInBounds();
    if (this._autoView || !this._view) {
      this._view = this._dataBounds ? { ...this._dataBounds } : null;
      this._autoView = true;
    }

    this._redrawOnly();
  }

  _refreshPhase() {
    this._clearFit();
    this._syncBodyOptions();
    const frames = this.host._opts.getFrames();
    const doc = this.host._opts.getBaselineScene?.();

    if (this.sourceKind === 'measurement') {
      this._ensureMeasPhasePair();
      const mx = this._selectedMeasurement(doc);
      const my = this._selectedMeasurementY(doc);
      const xLabel = mx ? measurementDisplayLabel(mx) : (this.measurementId || 'x');
      const yLabel = my ? measurementDisplayLabel(my) : (this.measurementIdY || 'y');
      this._setTitle(`${xLabel} vs ${yLabel}`);

      if (!mx || !my || !frames.length) {
        this._series = [];
        this._yExtrema = null;
        this._dataBounds = null;
        this._view = null;
        this._autoView = true;
        this._drawEmpty(frames.length ? 'Select two measurements' : 'No recorded frames — run a capture');
        return;
      }

      this._series = buildMeasurementPhaseSeries(frames, mx, my, doc, {
        unwrapAngle: this.unwrapAngle,
      });
      if (!this._series.length) {
        this._yExtrema = null;
        this._dataBounds = null;
        this._view = null;
        this._autoView = true;
        this._drawEmpty('Measurements could not be resolved in recording');
        return;
      }

      this._yExtrema = _seriesYExtremumIndices(this._series);
      const bounds = seriesBounds(this._series);
      this._dataBounds = bounds;
      if (this._autoView || !this._view) {
        this._view = this._dataBounds ? { ...this._dataBounds } : null;
        this._autoView = true;
      }
      this._syncPhaseBoundsInputs();
      this._redrawOnly();
      return;
    }

    const xMeta = GRAPH_OBSERVABLES.find(o => o.id === this.phaseObsX) ?? GRAPH_OBSERVABLES[0];
    const yMeta = GRAPH_OBSERVABLES.find(o => o.id === this.phaseObsY)
      ?? GRAPH_OBSERVABLES.find(o => o.id === 'px')
      ?? GRAPH_OBSERVABLES[2];
    const bodyOpt = [...this._bodySelect.options].find(o => o.value === String(this.trackId));
    const bodyName = bodyOpt?.textContent ?? 'body';
    this._setTitle(`${bodyName} · ${xMeta.label} vs ${yMeta.label}`);

    if (this.trackId == null || !frames.length) {
      this._series = [];
      this._yExtrema = null;
      this._dataBounds = null;
      this._view = null;
      this._autoView = true;
      this._drawEmpty(frames.length ? 'Select a body' : 'No recorded frames — run a capture');
      return;
    }

    this._series = buildPhaseSeries(frames, this.trackId, this.phaseObsX, this.phaseObsY, {
      unwrapAngle: this.unwrapAngle,
    });
    if (!this._series.length) {
      this._yExtrema = null;
      this._dataBounds = null;
      this._view = null;
      this._autoView = true;
      this._drawEmpty('Body not present in recording');
      return;
    }

    this._yExtrema = _seriesYExtremumIndices(this._series);
    const bounds = seriesBounds(this._series);
    this._dataBounds = bounds;
    if (this._autoView || !this._view) {
      this._view = this._dataBounds ? { ...this._dataBounds } : null;
      this._autoView = true;
    }
    this._syncPhaseBoundsInputs();
    this._redrawOnly();
  }

  _redrawOnly() {
    if (!this._series.length) return;
    if (!this._view && this._dataBounds) this._view = { ...this._dataBounds };
    if (!this._view) {
      this._drawEmpty('No data');
      return;
    }
    if (this.mode === 'sweep') {
      this._drawPlot(this._series, -1, {
        id: 'sweep',
        label: this._sweepYLabel,
        unit: '',
        xLabel: this._sweepXLabel,
      }, this._view);
    } else if (this.mode === 'phase') {
      const scrub = this.host._opts.getScrubIndex();
      this._drawPlot(this._series, scrub, this._obsMetaForDraw(), this._view);
    } else if (this.sourceKind === 'measurement') {
      const m = this._selectedMeasurement();
      const scrub = this.host._opts.getScrubIndex();
      this._drawPlot(this._series, scrub, {
        id: `meas:${this.measurementId}`,
        label: m ? measurementDisplayLabel(m) : (this.measurementId || 'meas'),
        unit: m?.kind === 'length' ? 'm' : '°',
      }, this._view);
    } else {
      const obsMeta = GRAPH_OBSERVABLES.find(o => o.id === this.observable) ?? GRAPH_OBSERVABLES[1];
      const scrub = this.host._opts.getScrubIndex();
      this._drawPlot(this._series, scrub, obsMeta, this._view);
    }
    if (this._hoverPt) this._drawHoverOverlay();
  }

  /** @returns {string} */
  getExportTitle() {
    return this._titleEl?.textContent?.trim() || 'Graph';
  }

  /** @returns {boolean} */
  canExportVideo() {
    if (this.mode === 'sweep') return false;
    const frames = this.host._opts.getFrames?.() ?? [];
    if (!frames.length) return false;
    if (!this._series.length) return false;
    return this._series.some(p => Number.isFinite(p.i));
  }

  /** @returns {string} */
  exportBlockedReason() {
    if (this.mode === 'sweep') return 'Parameter sweeps cannot be exported as frame videos';
    const frames = this.host._opts.getFrames?.() ?? [];
    if (!frames.length) return 'No recorded frames';
    if (!this._series.length) {
      return this.mode === 'phase'
        ? 'No parametric / phase plot data'
        : 'No plot data';
    }
    return '';
  }

  /** Plot area aspect (width ÷ height) for auto export sizing. */
  getPlotAspect() {
    const { iw, ih } = this._plotGeom();
    return iw / Math.max(1, ih);
  }

  /** @returns {{ id: string, label: string, unit: string, xLabel?: string }} */
  _obsMetaForDraw() {
    if (this.mode === 'phase' && this.sourceKind === 'measurement') {
      const mx = this._selectedMeasurement();
      const my = this._selectedMeasurementY();
      const xLabel = mx ? measurementDisplayLabel(mx) : (this.measurementId || 'x');
      const yLabel = my ? measurementDisplayLabel(my) : (this.measurementIdY || 'y');
      const xUnit = mx?.kind === 'length' ? 'm' : '°';
      const yUnit = my?.kind === 'length' ? 'm' : '°';
      return {
        id: `phase:meas:${this.measurementId}:${this.measurementIdY}`,
        label: yLabel,
        unit: yUnit,
        xLabel: `${xLabel} (${xUnit})`,
      };
    }
    if (this.mode === 'phase') {
      const xMeta = GRAPH_OBSERVABLES.find(o => o.id === this.phaseObsX) ?? GRAPH_OBSERVABLES[0];
      const yMeta = GRAPH_OBSERVABLES.find(o => o.id === this.phaseObsY)
        ?? GRAPH_OBSERVABLES.find(o => o.id === 'px')
        ?? GRAPH_OBSERVABLES[2];
      return {
        id: `phase:${this.phaseObsX}:${this.phaseObsY}`,
        label: yMeta.label,
        unit: yMeta.unit,
        xLabel: `${xMeta.label} (${xMeta.unit})`,
      };
    }
    if (this.sourceKind === 'measurement') {
      const m = this._selectedMeasurement();
      return {
        id: `meas:${this.measurementId}`,
        label: m ? measurementDisplayLabel(m) : (this.measurementId || 'meas'),
        unit: m?.kind === 'length' ? 'm' : '°',
      };
    }
    return GRAPH_OBSERVABLES.find(o => o.id === this.observable) ?? GRAPH_OBSERVABLES[1];
  }

  /**
   * @param {number} frameIndex
   * @param {GraphExportAnimMode} animMode
   * @param {number} plotW
   * @param {number} plotH
   */
  _drawExportFrame(frameIndex, animMode, plotW, plotH) {
    if (!this._series.length || !this._view) return;
    const scrubIndex = animMode === 'playback' ? frameIndex : -1;
    this._drawPlot(this._series, scrubIndex, this._obsMetaForDraw(), this._view, {
      forExport: true,
      animMode,
      frameIndex,
      plotW,
      plotH,
    });
  }

  /**
   * Encode this graph as a video from recorded frames.
   * @param {object} opts
   * @param {object[]} opts.frames
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} opts.fps
   * @param {GraphExportAnimMode} opts.animMode
   * @param {(done: number, total: number) => void} [opts.onProgress]
   */
  async exportVideo({ frames, width, height, fps, animMode, onProgress }) {
    if (this.mode === 'sweep') {
      throw new Error(this.exportBlockedReason() || 'Sweep graphs cannot be exported as video');
    }
    this.refresh();
    if (!this.canExportVideo()) {
      throw new Error(this.exportBlockedReason() || 'Graph cannot be exported');
    }
    if (!this._view && this._dataBounds) this._view = { ...this._dataBounds };
    if (!this._view) throw new Error('Graph has no view bounds');
    if (!this._series.length) {
      throw new Error(
        this.mode === 'phase'
          ? 'Parametric / phase graph has no plot data to export'
          : 'Graph has no plot data to export',
      );
    }

    const plotW = width;
    const plotH = height;
    const savedStyle = {
      width: this._plotWrap.style.width,
      height: this._plotWrap.style.height,
      flex: this._plotWrap.style.flex,
    };
    this._plotWrap.style.width = `${plotW}px`;
    this._plotWrap.style.height = `${plotH}px`;
    this._plotWrap.style.flex = 'none';

    try {
      return await exportRecordingVideo(frames, {
        svg: this._svg,
        width,
        height,
        fps,
        onProgress,
        renderFrame: async (i) => {
          this._drawExportFrame(i, animMode, plotW, plotH);
          await new Promise(r => requestAnimationFrame(r));
        },
      });
    } finally {
      this._plotWrap.style.width = savedStyle.width;
      this._plotWrap.style.height = savedStyle.height;
      this._plotWrap.style.flex = savedStyle.flex;
      this._svg.removeAttribute('width');
      this._svg.removeAttribute('height');
      this._redrawOnly();
    }
  }

  /** @param {string} baseName */
  exportFilename(baseName) {
    const slug = graphExportSlug(this.getExportTitle());
    const root = String(baseName ?? 'inertia').replace(/\.(mp4|webm)$/i, '').trim() || 'inertia';
    return `${root}-graph-${slug}`;
  }

  _drawEmpty(msg) {
    this._svg.innerHTML = '';
    this._readout.textContent = msg;
  }

  /**
   * @param {{ t: number, v: number, i: number }[]} series
   * @param {number} scrubIndex
   * @param {{ id: string, label: string, unit: string, xLabel?: string }} obsMeta
   * @param {GraphView} view
   * @param {object} [exportOpts]
   * @param {boolean} [exportOpts.forExport]
   * @param {GraphExportAnimMode} [exportOpts.animMode]
   * @param {number} [exportOpts.frameIndex]
   * @param {number} [exportOpts.plotW]
   * @param {number} [exportOpts.plotH]
   */
  _drawPlot(series, scrubIndex, obsMeta, view, exportOpts = {}) {
    const forExport = !!exportOpts.forExport;
    const plotOverride = exportOpts.plotW && exportOpts.plotH
      ? { W: exportOpts.plotW, H: exportOpts.plotH }
      : null;
    const ink = forExport && plotOverride
      ? exportInkScale(plotOverride.W, plotOverride.H)
      : 1;
    const padOverride = forExport ? exportPadForScale(ink) : null;
    const { W, H, iw, ih, pad } = this._plotGeom(plotOverride, padOverride);
    this._svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (forExport) {
      this._svg.setAttribute('width', String(W));
      this._svg.setAttribute('height', String(H));
    } else {
      this._svg.removeAttribute('width');
      this._svg.removeAttribute('height');
    }
    this._svg.innerHTML = '';
    this._obsMeta = obsMeta;
    this._scrubIndex = scrubIndex;
    const isSweep = this.mode === 'sweep';
    const isPhase = this.mode === 'phase';
    const isStatePlot = isSweep || isPhase;
    const sw = (n) => +(n * ink).toFixed(2);
    const fs = (n) => Math.max(1, Math.round(n * ink));
    const dash = (a, b) => `${sw(a)} ${sw(b)}`;
    // Export needs heavier traces than the live UI (viewBox = pixel size).
    const seriesStroke = forExport ? 2.5 : 1.5;
    const fitStroke = forExport ? 2.75 : 1.75;
    const axisStroke = forExport ? 1.75 : 1.25;

    let plotSeries = series;
    let plotScrub = scrubIndex;
    if (forExport && exportOpts.animMode === 'draw') {
      const fi = exportOpts.frameIndex ?? 0;
      plotSeries = series.filter(p => p.i <= fi);
      plotScrub = -1;
    } else if (forExport && exportOpts.animMode === 'playback') {
      plotScrub = exportOpts.frameIndex ?? scrubIndex;
    }

    let { t0: tMin, t1: tMax, v0: vMin, v1: vMax } = view;
    if (tMax <= tMin) tMax = tMin + 1e-3;
    if (vMax <= vMin) vMax = vMin + 1e-3;

    const xOf = t => pad.l + ((t - tMin) / (tMax - tMin)) * iw;
    const yOf = v => pad.t + (1 - (v - vMin) / (vMax - vMin)) * ih;
    this._xOf = xOf;
    this._yOf = yOf;
    this._viewDrawn = { tMin, tMax, vMin, vMax, pad, iw, ih };

    this._clipSeq += 1;
    const clipId = `gclip-${this._clipSeq}`;
    const defs = _svg('defs');
    const clip = _svg('clipPath', { id: clipId });
    clip.appendChild(_svg('rect', { x: pad.l, y: pad.t, width: iw, height: ih }));
    defs.appendChild(clip);
    this._svg.appendChild(defs);

    const xTicks = _niceTicks(tMin, tMax, 5);
    const yTicks = _niceTicks(vMin, vMax, 5);

    const grid = _svg('g', {
      class: 'graph-grid',
      fill: 'none',
      stroke: COLORS.inkLight,
      'stroke-width': sw(1),
      'stroke-opacity': '0.28',
    });
    for (const t of xTicks) {
      const x = xOf(t);
      if (x < pad.l - 0.5 || x > pad.l + iw + 0.5) continue;
      grid.appendChild(_svg('line', {
        x1: x, y1: pad.t, x2: x, y2: pad.t + ih,
      }));
    }
    for (const v of yTicks) {
      const y = yOf(v);
      if (y < pad.t - 0.5 || y > pad.t + ih + 0.5) continue;
      grid.appendChild(_svg('line', {
        x1: pad.l, y1: y, x2: pad.l + iw, y2: y,
      }));
    }
    this._svg.appendChild(grid);

    // Fit-domain guides (vertical bounds)
    const fitDom = this._getFitDomain();
    const fullExt = this._seriesXExtent();
    if (fitDom && fullExt
      && (Math.abs(fitDom.t0 - fullExt.t0) > 1e-9 || Math.abs(fitDom.t1 - fullExt.t1) > 1e-9)) {
      const domainG = _svg('g', {
        class: 'graph-fit-domain-guides',
        fill: 'none',
        stroke: COLORS.fit ?? '#a63d2f',
        'stroke-width': sw(1),
        'stroke-dasharray': dash(3, 3),
        'stroke-opacity': '0.55',
      });
      for (const t of [fitDom.t0, fitDom.t1]) {
        if (t < tMin || t > tMax) continue;
        const x = xOf(t);
        domainG.appendChild(_svg('line', {
          x1: x, y1: pad.t, x2: x, y2: pad.t + ih,
        }));
      }
      this._svg.appendChild(domainG);
    }

    const axis = _svg('g', {
      class: 'graph-axes',
      fill: 'none',
      stroke: COLORS.inkLight,
      'stroke-width': sw(axisStroke),
    });
    axis.appendChild(_svg('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + ih }));
    axis.appendChild(_svg('line', { x1: pad.l, y1: pad.t + ih, x2: pad.l + iw, y2: pad.t + ih }));
    this._svg.appendChild(axis);

    const labels = _svg('g', {
      fill: COLORS.inkLight,
      'font-size': String(fs(forExport ? 12 : 10)),
      'font-family': FONT_DIAGRAM,
    });
    const tickY = forExport ? H - pad.b + Math.round(14 * ink) : H - 8;
    const yTickX = pad.l - Math.round(6 * ink);
    for (const t of xTicks) {
      const tx = _svg('text', {
        x: xOf(t), y: tickY, 'text-anchor': 'middle',
      });
      tx.textContent = isStatePlot ? _fmtTick(t) : `${_fmtTick(t)}s`;
      labels.appendChild(tx);
    }
    for (const v of yTicks) {
      const tx = _svg('text', {
        x: yTickX, y: yOf(v), 'text-anchor': 'end', 'dominant-baseline': 'middle',
      });
      tx.textContent = isStatePlot ? _fmtTick(v, 3) : _fmtTick(v);
      labels.appendChild(tx);
    }
    this._svg.appendChild(labels);

    if (forExport) {
      this._drawAxisTitles(obsMeta, { W, H, iw, ih, pad, isSweep, isPhase, ink });
    }

    const content = forExport
      ? _svg('g')
      : _svg('g', { 'clip-path': `url(#${clipId})` });
    const isBodyPhase = isPhase && this.sourceKind !== 'measurement';
    if (isBodyPhase && this._phaseOverlay === 'vectors') {
      this._drawPhaseVectorField(content, series, {
        tMin, tMax, vMin, vMax, xOf, yOf, iw, ih, ink,
      });
    } else if (isBodyPhase && this._phaseOverlay === 'contour') {
      this._drawPhaseContourField(content, series, {
        tMin, tMax, vMin, vMax, xOf, yOf, iw, ih, ink,
      });
    }
    const d = plotSeries.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
    if (d) {
      content.appendChild(_svg('path', {
        d, fill: 'none', stroke: COLORS.blue, 'stroke-width': sw(seriesStroke), 'stroke-linejoin': 'round',
      }));
    }

    if (this._fitOverlay?.length && !isPhase && !(forExport && exportOpts.animMode === 'draw')) {
      const fd = this._fitOverlay
        .map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`)
        .join(' ');
      content.appendChild(_svg('path', {
        d: fd,
        fill: 'none',
        stroke: COLORS.fit ?? '#a63d2f',
        'stroke-width': sw(fitStroke),
        'stroke-dasharray': dash(5, 3),
        'stroke-linejoin': 'round',
        class: 'graph-fit-curve',
      }));
    }

    // Datapoint dots + max/min marks: only while hovering the plot (not during export).
    this._hoverMarksG = _svg('g', { class: 'graph-hover-marks' });
    if (!forExport && !this._plotHovered) this._hoverMarksG.setAttribute('display', 'none');

    if (!forExport && isStatePlot) {
      for (const p of series) {
        if (p.t < tMin || p.t > tMax) continue;
        this._hoverMarksG.appendChild(_svg('circle', {
          cx: xOf(p.t), cy: yOf(p.v), r: isPhase ? 2.2 : 3.5, fill: COLORS.blue, class: 'graph-dot',
        }));
      }
    } else if (!forExport) {
      const stride = Math.max(1, Math.floor(series.length / 80));
      for (let i = 0; i < series.length; i += stride) {
        const p = series[i];
        if (p.t < tMin || p.t > tMax) continue;
        this._hoverMarksG.appendChild(_svg('circle', {
          cx: xOf(p.t), cy: yOf(p.v), r: 2.2, fill: COLORS.blue, class: 'graph-dot',
        }));
      }
      const last = series[series.length - 1];
      if ((series.length - 1) % stride !== 0 && last.t >= tMin && last.t <= tMax) {
        this._hoverMarksG.appendChild(_svg('circle', {
          cx: xOf(last.t), cy: yOf(last.v), r: 2.2, fill: COLORS.blue, class: 'graph-dot',
        }));
      }
    }

    const ext = this._yExtrema ?? _seriesYExtremumIndices(series);
    const maxPt = !forExport && ext.iMax != null ? series[ext.iMax] : null;
    const minPt = !forExport && ext.iMin != null ? series[ext.iMin] : null;
    if (maxPt && maxPt.t >= tMin && maxPt.t <= tMax) {
      this._hoverMarksG.appendChild(_svg('circle', {
        cx: xOf(maxPt.t), cy: yOf(maxPt.v), r: 6.5,
        fill: COLORS.sweepMax ?? '#b8860b',
        stroke: '#fff',
        'stroke-width': 1.25,
        class: 'graph-dot-max',
      }));
    }
    if (minPt && minPt.t >= tMin && minPt.t <= tMax
      && !(maxPt && minPt.i === maxPt.i)) {
      this._hoverMarksG.appendChild(_svg('circle', {
        cx: xOf(minPt.t), cy: yOf(minPt.v), r: 6.5,
        fill: COLORS.sweepMin ?? '#2a6f6f',
        stroke: '#fff',
        'stroke-width': 1.25,
        class: 'graph-dot-min',
      }));
    }

    content.appendChild(this._hoverMarksG);
    this._svg.appendChild(content);

    const scrubPt = !isSweep && plotScrub >= 0
      ? seriesPointNearFrame(series, plotScrub)
      : null;
    const selPt = !forExport && this._selectedIndex != null
      ? series.find(p => p.i === this._selectedIndex)
      : null;

    if (scrubPt && scrubPt.t >= tMin && scrubPt.t <= tMax) {
      this._svg.appendChild(_svg('circle', {
        cx: xOf(scrubPt.t), cy: yOf(scrubPt.v), r: sw(4.5),
        fill: 'none', stroke: COLORS.ink, 'stroke-width': sw(1.75),
      }));
    }
    if (selPt && selPt.t >= tMin && selPt.t <= tMax) {
      this._svg.appendChild(_svg('circle', {
        cx: xOf(selPt.t), cy: yOf(selPt.v), r: isSweep ? 6 : 5,
        fill: isSweep ? 'none' : '#a63d2f',
        stroke: isSweep ? '#a63d2f' : '#fff',
        'stroke-width': isSweep ? 1.5 : 1.25,
      }));
    }

    this._hoverG = _svg('g', { class: 'graph-hover', display: 'none' });
    this._hoverV = _svg('line', { stroke: COLORS.inkLight, 'stroke-dasharray': '3 2', 'stroke-width': 1 });
    this._hoverH = _svg('line', { stroke: COLORS.inkLight, 'stroke-dasharray': '3 2', 'stroke-width': 1 });
    this._hoverDot = _svg('circle', { r: 4, fill: COLORS.blue, stroke: '#fff', 'stroke-width': 1 });
    this._hoverG.append(this._hoverV, this._hoverH, this._hoverDot);
    if (!forExport) this._svg.appendChild(this._hoverG);

    if (!forExport) this._setReadout(this._hoverPt ?? selPt, obsMeta, scrubPt);
  }

  _drawHoverOverlay() {
    const p = this._hoverPt;
    const drawn = this._viewDrawn;
    if (!p || !drawn || !this._hoverG || !this._xOf || !this._yOf) return;
    const { pad, iw, ih, tMin, tMax } = drawn;
    if (p.t < tMin || p.t > tMax) {
      this._hoverG.setAttribute('display', 'none');
      return;
    }
    const x = this._xOf(p.t);
    const y = this._yOf(p.v);
    this._hoverG.removeAttribute('display');
    this._hoverV.setAttribute('x1', x); this._hoverV.setAttribute('x2', x);
    this._hoverV.setAttribute('y1', pad.t); this._hoverV.setAttribute('y2', pad.t + ih);
    this._hoverH.setAttribute('x1', pad.l); this._hoverH.setAttribute('x2', pad.l + iw);
    this._hoverH.setAttribute('y1', y); this._hoverH.setAttribute('y2', y);
    this._hoverDot.setAttribute('cx', x); this._hoverDot.setAttribute('cy', y);
  }

  _phaseTangents(series) {
    const frames = this.host._opts.getFrames?.() ?? [];
    if (series.length < 3 || !frames.length) return [];
    const out = [];
    for (let i = 1; i < series.length - 1; i++) {
      const a = series[i - 1];
      const b = series[i + 1];
      const ta = frames[a.i]?.t;
      const tb = frames[b.i]?.t;
      if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue;
      const dt = tb - ta;
      if (!Number.isFinite(dt) || Math.abs(dt) < 1e-9) continue;
      out.push({
        x: series[i].t,
        y: series[i].v,
        dxdt: (b.t - a.t) / dt,
        dydt: (b.v - a.v) / dt,
      });
    }
    return out;
  }

  _drawPhaseVectorField(content, series, geom) {
    const tangents = this._phaseTangents(series);
    if (!tangents.length) return;
    const { tMin, tMax, vMin, vMax, xOf, yOf, iw, ih } = geom;
    const ink = geom.ink ?? 1;
    const nx = Math.max(12, Math.min(40, Math.round(iw / (28 * ink))));
    const ny = Math.max(10, Math.min(32, Math.round(ih / (28 * ink))));
    const cellW = iw / nx;
    const cellH = ih / ny;
    const arrowLenPx = Math.max(7 * ink, Math.min(18 * ink, Math.min(cellW, cellH) * 0.58));
    const sx = Math.max(1e-9, (tMax - tMin) / 7);
    const sy = Math.max(1e-9, (vMax - vMin) / 7);
    const color = COLORS.ink;

    const g = _svg('g', { class: 'graph-phase-field' });

    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        const gx = tMin + ((ix + 0.5) / nx) * (tMax - tMin);
        const gy = vMin + ((iy + 0.5) / ny) * (vMax - vMin);
        const flow = _samplePhaseFlow(tangents, gx, gy, sx, sy);
        if (!flow) continue;

        const sdx = (flow.wx / Math.max(1e-9, tMax - tMin)) * iw;
        const sdy = (-flow.wy / Math.max(1e-9, vMax - vMin)) * ih;
        _drawNormArrow(g, xOf(gx), yOf(gy), sdx, sdy, arrowLenPx, color, 0.52, ink);
      }
    }
    content.appendChild(g);
  }

  _drawPhaseContourField(content, series, geom) {
    const tangents = this._phaseTangents(series);
    if (!tangents.length) return;
    const { tMin, tMax, vMin, vMax, xOf, yOf, iw, ih } = geom;
    const ink = geom.ink ?? 1;
    const nx = Math.max(28, Math.min(72, Math.round(iw / (14 * Math.max(1, ink * 0.5)))));
    const ny = Math.max(24, Math.min(56, Math.round(ih / (14 * Math.max(1, ink * 0.5)))));
    const cols = nx + 1;
    const rows = ny + 1;
    const sx = Math.max(1e-9, (tMax - tMin) / 7);
    const sy = Math.max(1e-9, (vMax - vMin) / 7);
    const values = new Float64Array(cols * rows);
    let minH = Infinity;
    let maxH = -Infinity;

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const gx = tMin + (i / nx) * (tMax - tMin);
        const gy = vMin + (j / ny) * (vMax - vMin);
        const flow = _samplePhaseFlow(tangents, gx, gy, sx, sy);
        const h = flow?.hamiltonian ?? NaN;
        values[j * cols + i] = h;
        if (Number.isFinite(h)) {
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH - minH < 1e-9) return;

    const cornerXY = (i, j) => {
      const gx = tMin + (i / nx) * (tMax - tMin);
      const gy = vMin + (j / ny) * (vMax - vMin);
      return [xOf(gx), yOf(gy)];
    };

    const color = COLORS.ink;
    const g = _svg('g', { class: 'graph-phase-contour' });
    const nLevels = 8;
    const strokeW = +(1 * ink).toFixed(2);
    for (let k = 0; k < nLevels; k++) {
      const level = minH + ((k + 1) / (nLevels + 1)) * (maxH - minH);
      const opacity = 0.16 + (k / Math.max(1, nLevels - 1)) * 0.44;
      const segments = _marchingSquares(values, cols, rows, level, cornerXY);
      for (const [x1, y1, x2, y2] of segments) {
        g.appendChild(_svg('line', {
          x1, y1, x2, y2,
          stroke: color,
          'stroke-width': strokeW,
          'stroke-opacity': opacity,
          'stroke-linecap': 'round',
        }));
      }
    }
    content.appendChild(g);
  }

  /** @param {boolean} on */
  _setPlotHovered(on) {
    if (this._plotHovered === on) return;
    this._plotHovered = on;
    if (!this._hoverMarksG) return;
    if (on) this._hoverMarksG.removeAttribute('display');
    else this._hoverMarksG.setAttribute('display', 'none');
  }

  _updateReadoutOnly() {
    if (this.mode === 'sweep') {
      const obsMeta = {
        id: 'sweep',
        label: this._sweepYLabel,
        unit: '',
        xLabel: this._sweepXLabel,
      };
      const selPt = this._selectedIndex != null
        ? this._series.find(p => p.i === this._selectedIndex)
        : null;
      this._setReadout(this._hoverPt ?? selPt, obsMeta, null);
      if (this._hoverPt) this._drawHoverOverlay();
      else if (this._hoverG) this._hoverG.setAttribute('display', 'none');
      return;
    }

    if (this.mode === 'phase') {
      const obsMeta = this._obsMetaForDraw();
      const scrub = this.host._opts.getScrubIndex();
      const scrubPt = this._series.find(p => p.i === scrub) ?? null;
      const selPt = this._selectedIndex != null
        ? this._series.find(p => p.i === this._selectedIndex)
        : null;
      this._setReadout(this._hoverPt ?? selPt, obsMeta, scrubPt);
      if (this._hoverPt) this._drawHoverOverlay();
      else if (this._hoverG) this._hoverG.setAttribute('display', 'none');
      return;
    }

    const obsMeta = this._obsMeta
      ?? GRAPH_OBSERVABLES.find(o => o.id === this.observable)
      ?? GRAPH_OBSERVABLES[1];
    const scrub = this.host._opts.getScrubIndex();
    const scrubPt = this._series.find(p => p.i === scrub) ?? null;
    const selPt = this._selectedIndex != null
      ? this._series.find(p => p.i === this._selectedIndex)
      : null;
    this._setReadout(this._hoverPt ?? selPt, obsMeta, scrubPt);
    if (this._hoverPt) this._drawHoverOverlay();
    else if (this._hoverG) this._hoverG.setAttribute('display', 'none');
  }

  /**
   * Axis titles for exported graph frames (live UI uses the window title instead).
   * @param {{ label: string, unit: string, xLabel?: string }} obsMeta
   * @param {{ W: number, H: number, iw: number, ih: number, pad: { l:number,r:number,t:number,b:number }, isSweep: boolean, isPhase: boolean, ink?: number }} geom
   */
  _drawAxisTitles(obsMeta, geom) {
    const { H, iw, ih, pad, isSweep, isPhase } = geom;
    const ink = geom.ink ?? 1;
    let xTitle;
    let yTitle;
    if (isPhase) {
      xTitle = obsMeta.xLabel || 'x';
      yTitle = `${obsMeta.label} (${obsMeta.unit})`;
    } else if (isSweep) {
      xTitle = obsMeta.xLabel || this._sweepXLabel || 'x';
      yTitle = obsMeta.label || this._sweepYLabel || 'y';
    } else {
      xTitle = 't (s)';
      yTitle = `${obsMeta.label} (${obsMeta.unit})`;
    }

    const titles = _svg('g', {
      class: 'graph-axis-titles',
      fill: COLORS.ink,
      'font-size': String(Math.max(1, Math.round(16 * ink))),
      'font-family': FONT_DIAGRAM,
    });

    const xEl = _svg('text', {
      x: pad.l + iw / 2,
      y: H - Math.round(10 * ink),
      'text-anchor': 'middle',
    });
    setSvgAxisTitle(xEl, xTitle);
    titles.appendChild(xEl);

    const yCx = Math.round(16 * ink);
    const yCy = pad.t + ih / 2;
    const yEl = _svg('text', {
      x: yCx,
      y: yCy,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      transform: `rotate(-90 ${yCx} ${yCy})`,
    });
    setSvgAxisTitle(yEl, yTitle);
    titles.appendChild(yEl);

    this._svg.appendChild(titles);
  }

  /**
   * @param {{ t: number, v: number, i: number }|null|undefined} sel
   * @param {{ label: string, unit: string, xLabel?: string }} obsMeta
   * @param {{ t: number, v: number, i: number }|null} scrub
   */
  _setReadout(sel, obsMeta, scrub) {
    const fitLine = this._fitReadoutSuffix();

    if (this.mode === 'sweep') {
      const xLab = obsMeta.xLabel || this._sweepXLabel;
      const yLab = obsMeta.label || this._sweepYLabel;
      let base;
      if (this._hoverPt && sel === this._hoverPt) {
        base = `${xLab} = ${sel.t.toFixed(4)}  ·  ${yLab} = ${sel.v.toFixed(4)}`;
      } else if (sel) {
        base = `selected  ${xLab} = ${sel.t.toFixed(4)}  ·  ${yLab} = ${sel.v.toFixed(4)}`;
      } else if (this._sweepStatus && (this._sweepRunning || !this._series.length)) {
        base = this._sweepStatus;
      } else if (this._series.length) {
        const ext = this._yExtrema ?? _seriesYExtremumIndices(this._series);
        const maxPt = ext.iMax != null ? this._series[ext.iMax] : null;
        const minPt = ext.iMin != null ? this._series[ext.iMin] : null;
        const parts = [
          this._sweepStatus,
          `${this._series.length} pts`,
        ].filter(Boolean);
        if (maxPt) parts.push(`max ${yLab}=${maxPt.v.toFixed(4)} @ ${xLab}=${maxPt.t.toFixed(4)}`);
        if (minPt && !(maxPt && minPt.i === maxPt.i)) {
          parts.push(`min ${yLab}=${minPt.v.toFixed(4)} @ ${xLab}=${minPt.t.toFixed(4)}`);
        }
        parts.push('click a point to load');
        base = parts.join(' · ');
      } else {
        base = this._sweepStatus || 'Choose variables and run a sweep';
      }
      this._readout.textContent = fitLine ? `${base}  ·  ${fitLine}` : base;
      return;
    }

    if (this.mode === 'phase') {
      const xLab = obsMeta.xLabel || 'x';
      const yLab = `${obsMeta.label} (${obsMeta.unit})`;
      const frames = this.host._opts.getFrames();
      const frameT = (idx) => {
        const f = frames[idx];
        return f && Number.isFinite(f.t) ? f.t.toFixed(3) : '?';
      };
      let base;
      if (this._hoverPt && sel === this._hoverPt) {
        base = `${xLab} = ${sel.t.toFixed(4)}  ·  ${yLab} = ${sel.v.toFixed(4)}  ·  t = ${frameT(sel.i)} s`;
      } else if (sel) {
        base = `selected  ${xLab} = ${sel.t.toFixed(4)}  ·  ${yLab} = ${sel.v.toFixed(4)}  ·  t = ${frameT(sel.i)} s`;
      } else if (scrub) {
        base = `playhead  ${xLab} = ${scrub.t.toFixed(4)}  ·  ${yLab} = ${scrub.v.toFixed(4)}  ·  t = ${frameT(scrub.i)} s`;
      } else if (this._series.length) {
        base = `${this._series.length} pts · click to scrub · scroll zoom · drag pan · 0 fit`;
      } else {
        base = 'No data';
      }
      this._readout.textContent = base;
      return;
    }

    const parts = [];
    if (this._hoverPt && sel === this._hoverPt) {
      parts.push(`t = ${sel.t.toFixed(3)} s · ${obsMeta.label} = ${sel.v.toFixed(4)} ${obsMeta.unit}`);
    } else if (sel) {
      parts.push(`selected  t = ${sel.t.toFixed(3)} s · ${obsMeta.label} = ${sel.v.toFixed(4)} ${obsMeta.unit}`);
    } else if (scrub) {
      parts.push(`playhead  t = ${scrub.t.toFixed(3)} s · ${obsMeta.label} = ${scrub.v.toFixed(4)} ${obsMeta.unit}`);
    } else if (this._series.length) {
      const last = this._series[this._series.length - 1];
      const ext = this._yExtrema ?? _seriesYExtremumIndices(this._series);
      const maxPt = ext.iMax != null ? this._series[ext.iMax] : null;
      const minPt = ext.iMin != null ? this._series[ext.iMin] : null;
      const bits = [
        `${this._series.length} pts`,
        `t ∈ [0, ${last.t.toFixed(3)}] s`,
      ];
      if (maxPt) bits.push(`max ${obsMeta.label}=${maxPt.v.toFixed(4)} @ t=${maxPt.t.toFixed(3)} s`);
      if (minPt && !(maxPt && minPt.i === maxPt.i)) {
        bits.push(`min ${obsMeta.label}=${minPt.v.toFixed(4)} @ t=${minPt.t.toFixed(3)} s`);
      }
      bits.push('scroll zoom · drag pan · 0 fit');
      parts.push(bits.join(' · '));
    } else {
      parts.push('No data');
    }
    if (fitLine) parts.push(fitLine);
    this._readout.textContent = parts.join('  ·  ');
  }

  _fitReadoutSuffix() {
    if (this.mode === 'phase') return '';
    if (this._fitError) return `fit: ${this._fitError}`;
    if (!this._fitResult) return '';
    const r = this._fitResult;
    const r2 = r.r2 != null ? `R² = ${fmtNum(r.r2)}` : '';
    let domain = '';
    if (this._fitDomainUsed) {
      const { t0, t1 } = this._fitDomainUsed;
      domain = `on [${fmtNum(t0)}, ${fmtNum(t1)}]`;
    }
    return [r.equation, r.paramSummary, r2, domain].filter(Boolean).join('  ·  ');
  }
}

function _sweepField(label, control) {
  const row = _el('div', { className: 'graph-sweep-field' });
  row.append(_el('label', { className: 'graph-field-label' }, label), control);
  return row;
}

/**
 * Fill a <select> with optional <optgroup>s from items that have `.group`.
 * @param {HTMLSelectElement} select
 * @param {Array<{ id: string, group?: string }>} items
 * @param {(item: object) => string} formatLabel
 * @param {string} emptyLabel
 */
function _fillGroupedSelect(select, items, formatLabel, emptyLabel) {
  select.innerHTML = '';
  if (!items.length) {
    select.appendChild(_el('option', { value: '' }, emptyLabel));
    return;
  }
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const it of items) {
    const g = it.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  for (const [g, list] of groups) {
    const parent = g
      ? /** @type {HTMLOptGroupElement} */ (_el('optgroup', { label: g }))
      : select;
    if (g) select.appendChild(parent);
    for (const it of list) {
      parent.appendChild(_el('option', { value: it.id }, formatLabel(it)));
    }
  }
}

/**
 * @param {{ t: number, v: number, i: number }[]} series
 * @returns {{ iMax: number|null, iMin: number|null }}
 */
function _seriesYExtremumIndices(series) {
  if (!series.length) return { iMax: null, iMin: null };
  let iMax = 0;
  let iMin = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].v > series[iMax].v) iMax = i;
    if (series[i].v < series[iMin].v) iMin = i;
  }
  return { iMax, iMin };
}

/** Desmos mark used on the View in Desmos button. */
function _desmosIcon() {
  const img = document.createElement('img');
  img.src = desmosIconUrl;
  img.width = 14;
  img.height = 14;
  img.alt = '';
  img.className = 'graph-desmos-icon';
  img.setAttribute('aria-hidden', 'true');
  return img;
}

/**
 * Approximately `count` nice tick values in [lo, hi].
 * @param {number} lo
 * @param {number} hi
 * @param {number} [count=5]
 * @returns {number[]}
 */
function _niceTicks(lo, hi, count = 5) {
  if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  const span = hi - lo;
  if (span < 1e-15) return [lo];

  const raw = span / Math.max(2, count - 1);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const err = raw / pow;
  let step;
  if (err <= 1.5) step = pow;
  else if (err <= 3) step = 2 * pow;
  else if (err <= 7) step = 5 * pow;
  else step = 10 * pow;

  const start = Math.ceil((lo - step * 1e-9) / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) {
    // Avoid -0 and floating noise
    const n = Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12));
    ticks.push(n);
    if (ticks.length > 24) break;
  }
  return ticks.length ? ticks : [lo, hi];
}

/**
 * @param {number} v
 * @param {number} [maxFrac=2]
 */
function _fmtTick(v, maxFrac = 2) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e4 || a < 5e-3)) return v.toExponential(1);
  const s = v.toFixed(maxFrac);
  return s.replace(/\.?0+$/, '') || '0';
}
