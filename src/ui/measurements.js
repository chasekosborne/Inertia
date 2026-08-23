/**
 * Visual measurement overlays: textbook-style length dimensions and angle arcs.
 *
 * Anchors can be free world points, body centres, wedge/ground vertices, free
 * rays, or a body's velocity / applied-force direction (for β-style angles).
 *
 * Selected angles expose draggable ray tips (Ctrl → 5° snap). Tips couple to
 * velocity or force vectors when dragged near them, coupled rays match the
 * drawn vector length. Ctrl also snaps free rays to 5° while creating.
 * Selected lengths expose draggable endpoints (Ctrl → axis-align), a draggable
 * dimension arm (offset), and a draggable value label.
 *
 * Wedge interior angles: click near a corner inside a wedge to place a static
 * mark, or snap rays along faces from a corner vertex.
 *
 * Body attachments prefer stable `bodyLabel` (scene id) so overlays survive
 * undo/redo and deserialize (Matter numeric ids change).
 *
 * Values can be plotted in the graph system (time series + sweep dependents).
 * Angle values are signed from ray A (reference) to ray B (display +y up,
 * CCW positive) unless `signed: false` (wedge interior marks).
 * With `continuous: true`, the live / graphed value unwraps past ±180° so
 * full revolutions accumulate (370°, −720°, …). The drawn arc still shows
 * the principal sector.
 *
 * Length values default to Euclidean distance. A `component` property selects
 * |Δx|, |Δy|, or the L-path |Δx|+|Δy| (table-and-hanging rope). Ctrl snaps a
 * free endpoint onto the horizontal or vertical through the other end.
 */

import { snapWorldCoord, snapAngleRad, SNAP_ANGLE_STEP_5_DEG } from '../grid.js';
import { matterVelToDisplayMS, getVelocityPxPerMs, getForcePxPerN } from '../units.js';
import { getAppliedForce } from '../physics/applied-force.js';
import {
  wedgeAABBCenterWorld,
  wedgeTriangleWorldVerts,
  wedgeContainsWorldPoint,
} from '../physics/bodies.js';
import { constraintAnchorWorld } from '../physics/layout-anchors.js';
import { COLORS, FONT_DIAGRAM } from '../theme.js';
import { setSvgMathLabel } from '../math-text.js';
import {
  lengthPartsM,
  lengthValueFromParts,
  normalizeLengthComponent,
  angleDegBetween,
  unwrapAngleStep,
} from './measure-eval.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HIT_PX = 14;
/** Pointer hit radius for selected edit dots (visual r ≈ 2.2). */
const HANDLE_HIT_PX = 6;
const COUPLE_HIT_PX = 16;
/** Default distance of a length dimension arm from its endpoints (world px). */
const DEFAULT_DIM_OFFSET = 22;
/** Default label offset along the dimension normal (world px). */
const DEFAULT_LABEL_OUT = 12;
/** Treat |value| below this as zero for display. */
const LENGTH_ZERO_EPS = 5e-3;
/** Screen-space tip length for direction rays (world px). */
const VEL_TIP_LEN = 72;

/** @param {number|null|undefined} value */
function formatLengthMetres(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < LENGTH_ZERO_EPS) return '0 m';
  return `${value.toFixed(2)} m`;
}

/** @param {object|null|undefined} m */
function dimOffsetOf(m) {
  return Number.isFinite(m?.dimOffset) ? m.dimOffset : DEFAULT_DIM_OFFSET;
}

function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== false) e.setAttribute(k, String(v));
  }
  return e;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unit(dx, dy) {
  const L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}

/** Display-frame angle (rad, +y up) from vertex → point in SVG world. */
function displayAngleFromVertex(vertex, pt) {
  return Math.atan2(-(pt.y - vertex.y), pt.x - vertex.x);
}

function tipFromDisplayAngle(origin, angleRad, len = VEL_TIP_LEN) {
  return {
    x: origin.x + Math.cos(angleRad) * len,
    y: origin.y - Math.sin(angleRad) * len,
  };
}

let _nextId = 1;

/**
 * @param {unknown} raw
 * @param {string[]} keys
 * @returns {Record<string, { x: number, y: number }>|null}
 */
function _readFrozen(raw, keys) {
  if (!raw || typeof raw !== 'object') return null;
  /** @type {Record<string, { x: number, y: number }>} */
  const out = {};
  let any = false;
  for (const k of keys) {
    const p = /** @type {Record<string, unknown>} */ (raw)[k];
    if (!p || typeof p !== 'object') continue;
    const x = Number(/** @type {Record<string, unknown>} */ (p).x);
    const y = Number(/** @type {Record<string, unknown>} */ (p).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[k] = { x, y };
    any = true;
  }
  return any ? out : null;
}

/**
 * @typedef {'world'|'body'|'vertex'|'velocity'|'force'|'horizontal'|'ray'} AnchorKind
 * @typedef {{
 *   kind: AnchorKind,
 *   x?: number, y?: number,
 *   bodyId?: number,
 *   bodyLabel?: string,
 *   vertex?: 'bl'|'br'|'tl'|'groundA'|'groundB',
 *   dir?: number,
 *   followVelocityX?: boolean,
 *   angleDeg?: number,
 * }} MeasureAnchor
 */

export class MeasurementManager {
  /**
   * @param {object} opts
   * @param {SVGElement} opts.layer
   * @param {SVGElement} [opts.leaderLayer]
   * @param {import('../physics/engine.js').PhysicsEngine} opts.engine
   * @param {() => boolean} [opts.getSnapEnabled]
   * @param {(sel: object|null) => void} [opts.onSelect]
   * @param {() => void} [opts.onBeforeChange]
   * @param {{ resolveAnchor: (anchor: object) => { x: number, y: number }|null }|null} [opts.labelHooks]
   */
  constructor({ layer, leaderLayer = null, engine, getSnapEnabled = () => true, onSelect = null, onBeforeChange = null, labelHooks = null }) {
    this.layer = layer;
    this._leaderLayer = leaderLayer;
    this.engine = engine;
    this._getSnapEnabled = getSnapEnabled;
    this._onSelect = onSelect;
    this._onBeforeChange = onBeforeChange;
    this._labelHooks = labelHooks;

    /** @type {Array<object>} */
    this.items = [];
    /** @type {object|null} */
    this._draft = null;
    /** @type {string|null} */
    this._selectedId = null;
    /** @type {'measure-length'|'measure-angle'|null} */
    this._tool = null;
    /** @type {{ measureId: string, which: 'a'|'b'|'vertex'|'dim'|'label', startPt?: {x:number,y:number}, startDimOffset?: number, startLabelNudge?: {x:number,y:number}, dimNormal?: {x:number,y:number}, historyPushed?: boolean }|null} */
    this._edit = null;

    this.layer.setAttribute('pointer-events', 'none');
    this._leaderLayer?.setAttribute('pointer-events', 'none');
  }

  _clearLayers() {
    while (this.layer.firstChild) this.layer.removeChild(this.layer.firstChild);
    if (this._leaderLayer) {
      while (this._leaderLayer.firstChild) this._leaderLayer.removeChild(this._leaderLayer.firstChild);
    }
  }

  /** @param {'measure-length'|'measure-angle'|null|string} tool */
  setTool(tool) {
    const next = (tool === 'measure-length' || tool === 'measure-angle') ? tool : null;
    if (this._tool === next) return;
    this._tool = next;
    this._draft = null;
    this.sync();
  }

  get tool() { return this._tool; }

  handlesMode(mode) {
    return mode === 'measure-length' || mode === 'measure-angle';
  }

  clearAll() {
    this.items = [];
    this._draft = null;
    this._selectedId = null;
    this._edit = null;
    this.sync();
  }

  /**
   * Load measurements from a scene document (body ids are scene labels).
   * @param {import('../scene/schema.js').SceneDocument|object} doc
   */
  loadFromScene(doc) {
    this.clearAll();
    const list = doc?.measurements;
    if (!Array.isArray(list) || !list.length) return;

    const labelToId = new Map();
    for (const b of this.engine.bodies) {
      if (typeof b.label === 'string' && b.label) labelToId.set(b.label, b.id);
    }

    const mapAnchor = (a) => {
      if (!a || typeof a !== 'object') return null;
      const out = { ...a };
      if (out.kind === 'constraint') {
        out.constraintLabel = typeof a.constraint === 'string' ? a.constraint : null;
        out.end = a.end === 'B' ? 'B' : 'A';
        if (!out.constraintLabel) return null;
        return out;
      }
      if (out.kind === 'label') {
        out.labelId = typeof a.label === 'string' ? a.label : null;
        if (!out.labelId) return null;
        return out;
      }
      if (typeof a.body === 'string') {
        out.bodyId = labelToId.get(a.body);
        out.bodyLabel = a.body;
        delete out.body;
      } else if (typeof a.bodyLabel === 'string') {
        out.bodyId = labelToId.get(a.bodyLabel);
      }
      if (out.bodyId == null && (out.kind === 'body' || out.kind === 'velocity'
        || out.kind === 'force' || out.kind === 'ray'
        || out.kind === 'vertex' || out.kind === 'horizontal')) {
        return null;
      }
      if (out.kind === 'ray' && typeof out.angleDeg !== 'number') {
        out.angleDeg = 0;
      }
      return out;
    };

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.kind === 'angle') {
        const vertex = mapAnchor(raw.vertex);
        const a = mapAnchor(raw.a);
        const b = mapAnchor(raw.b);
        if (!vertex || !a || !b) continue;
        this.items.push({
          id: typeof raw.id === 'string' ? raw.id : `m${_nextId++}`,
          kind: 'angle',
          label: typeof raw.label === 'string' ? raw.label : null,
          dynamic: raw.dynamic !== false,
          // Default signed (ray A = reference). Explicit false → unsigned |∠|.
          signed: raw.signed !== false,
          // Optional: unwrap past ±180° so revolutions accumulate.
          continuous: raw.continuous === true,
          frozen: _readFrozen(raw.frozen, ['vertex', 'a', 'b']),
          vertex, a, b,
        });
      } else if (raw.kind === 'length') {
        const a = mapAnchor(raw.a);
        const b = mapAnchor(raw.b);
        if (!a || !b) continue;
        this.items.push({
          id: typeof raw.id === 'string' ? raw.id : `m${_nextId++}`,
          kind: 'length',
          label: typeof raw.label === 'string' ? raw.label : null,
          dynamic: raw.dynamic !== false,
          component: normalizeLengthComponent(raw.component),
          elbow: raw.elbow === 'yx' ? 'yx' : 'xy',
          signed: raw.signed === true,
          baselineM: Number.isFinite(raw.baselineM) ? raw.baselineM : null,
          dimOffset: Number.isFinite(raw.dimOffset) ? raw.dimOffset : DEFAULT_DIM_OFFSET,
          labelNudge: (raw.labelNudge && typeof raw.labelNudge === 'object')
            ? {
              x: Number(raw.labelNudge.x) || 0,
              y: Number(raw.labelNudge.y) || 0,
            }
            : { x: 0, y: 0 },
          frozen: _readFrozen(raw.frozen, ['a', 'b']),
          a, b,
        });
      }
    }
    this.sync();
  }

  /**
   * Scene-JSON form (labels, not Matter ids) for serialize / undo / export.
   * @returns {object[]}
   */
  toScene() {
    const anchorOut = (a) => {
      if (!a) return null;
      if (a.kind === 'world') {
        return { kind: 'world', x: a.x, y: a.y };
      }
      if (a.kind === 'constraint') {
        if (!a.constraintLabel) return null;
        return { kind: 'constraint', constraint: a.constraintLabel, end: a.end === 'B' ? 'B' : 'A' };
      }
      if (a.kind === 'label') {
        if (!a.labelId) return null;
        return { kind: 'label', label: a.labelId };
      }
      const body = this._bodyForAnchor(a);
      const label = a.bodyLabel
        || (typeof body?.label === 'string' && body.label ? body.label : null);
      if (!label) return null;
      /** @type {Record<string, unknown>} */
      const out = { kind: a.kind, body: label };
      if (a.kind === 'vertex' && a.vertex) out.vertex = a.vertex;
      if (a.followVelocityX) out.followVelocityX = true;
      if (typeof a.dir === 'number' && Number.isFinite(a.dir)) out.dir = a.dir;
      if (a.kind === 'ray' && typeof a.angleDeg === 'number') out.angleDeg = a.angleDeg;
      return out;
    };

    const out = [];
    for (const m of this.items) {
      if (m.kind === 'angle') {
        const vertex = anchorOut(m.vertex);
        const a = anchorOut(m.a);
        const b = anchorOut(m.b);
        if (!vertex || !a || !b) continue;
        /** @type {Record<string, unknown>} */
        const entry = { id: m.id, kind: 'angle', vertex, a, b };
        if (m.label) entry.label = m.label;
        if (m.signed === false) entry.signed = false;
        if (m.continuous === true) entry.continuous = true;
        if (m.dynamic === false) {
          entry.dynamic = false;
          if (m.frozen) entry.frozen = m.frozen;
        }
        out.push(entry);
      } else if (m.kind === 'length') {
        const a = anchorOut(m.a);
        const b = anchorOut(m.b);
        if (!a || !b) continue;
        /** @type {Record<string, unknown>} */
        const entry = { id: m.id, kind: 'length', a, b };
        if (m.label) entry.label = m.label;
        const component = normalizeLengthComponent(m.component);
        if (component !== 'distance') entry.component = component;
        if (m.signed === true) entry.signed = true;
        if (m.elbow === 'yx') entry.elbow = 'yx';
        if (m.baselineM != null && Number.isFinite(m.baselineM)) entry.baselineM = m.baselineM;
        if (Number.isFinite(m.dimOffset) && Math.abs(m.dimOffset - DEFAULT_DIM_OFFSET) > 1e-6) {
          entry.dimOffset = m.dimOffset;
        }
        if (m.labelNudge && (m.labelNudge.x || m.labelNudge.y)) {
          entry.labelNudge = { x: m.labelNudge.x, y: m.labelNudge.y };
        }
        if (m.dynamic === false) {
          entry.dynamic = false;
          if (m.frozen) entry.frozen = m.frozen;
        }
        out.push(entry);
      }
    }
    return out;
  }

  /** @param {string} id */
  getById(id) {
    return this.items.find(m => m.id === id) ?? null;
  }

  /**
   * @param {string} id
   * @param {string|null} label
   */
  setLabel(id, label) {
    const m = this.getById(id);
    if (!m) return;
    const next = typeof label === 'string' ? label.trim() : '';
    m.label = next || null;
    this.sync();
  }

  /**
   * Length component: Euclidean, |Δx|, |Δy|, or L-path |Δx|+|Δy|.
   * @param {string} id
   * @param {string} component
   */
  setComponent(id, component) {
    const m = this.getById(id);
    if (!m || m.kind !== 'length') return;
    const next = normalizeLengthComponent(component);
    if (m.component === next) return;
    m.component = next;
    if (next === 'manhattan') {
      m.elbow = this._guessElbow(m);
    }
    this.sync();
  }

  /**
   * Manhattan elbow: 'xy' = horizontal then vertical from A, 'yx' = vertical first.
   * @param {string} id
   * @param {'xy'|'yx'} elbow
   */
  setElbow(id, elbow) {
    const m = this.getById(id);
    if (!m || m.kind !== 'length') return;
    m.elbow = elbow === 'yx' ? 'yx' : 'xy';
    this.sync();
  }

  /**
   * Dynamic: follow bodies / vectors. Static: freeze world pose.
   * @param {string} id
   * @param {boolean} dynamic
   */
  setDynamic(id, dynamic) {
    const m = this.getById(id);
    if (!m) return;
    const next = !!dynamic;
    if ((m.dynamic !== false) === next) {
      m.dynamic = next;
      return;
    }
    if (!next) {
      this._freezeMeasure(m);
      m.dynamic = false;
    } else {
      m.dynamic = true;
      m.frozen = null;
    }
    this.sync();
  }

  /**
   * Continuous angles: unwrap past ±180° so full turns accumulate on the
   * readout / graphs. Arc geometry still uses the principal value.
   * @param {string} id
   * @param {boolean} continuous
   */
  setContinuous(id, continuous) {
    const m = this.getById(id);
    if (!m || m.kind !== 'angle') return;
    const next = !!continuous;
    if (m.continuous === next) return;
    m.continuous = next;
    m._unwrap = null;
    this.sync();
  }

  /** Snapshot current world pose into `frozen`. */
  _freezeMeasure(m) {
    if (m.kind === 'angle') {
      const vertex = this.resolve(m.vertex);
      const a = this.resolve(m.a);
      const b = this.resolve(m.b);
      m.frozen = {
        vertex: vertex ? { ...vertex } : undefined,
        a: a ? { ...a } : undefined,
        b: b ? { ...b } : undefined,
      };
    } else if (m.kind === 'length') {
      const a = this.resolve(m.a);
      const b = this.resolve(m.b);
      m.frozen = {
        a: a ? { ...a } : undefined,
        b: b ? { ...b } : undefined,
      };
    }
  }

  /**
   * Resolve an endpoint, honouring static freeze.
   * @param {object} m
   * @param {'vertex'|'a'|'b'} key
   */
  _resolveEnd(m, key) {
    if (m.dynamic === false && m.frozen?.[key]
      && Number.isFinite(m.frozen[key].x) && Number.isFinite(m.frozen[key].y)) {
      return { x: m.frozen[key].x, y: m.frozen[key].y };
    }
    return this.resolve(m[key]);
  }

  /** Live angle in degrees for the properties readout / graphs. */
  measureAngleDeg(id) {
    const m = this.getById(id);
    if (!m || m.kind !== 'angle') return null;
    const v = this._resolveEnd(m, 'vertex');
    const a = this._resolveEnd(m, 'a');
    const b = this._resolveEnd(m, 'b');
    if (!v || !a || !b) return null;
    const wrapped = angleDegBetween(v, a, b, { signed: m.signed !== false });
    if (wrapped == null || !Number.isFinite(wrapped)) return null;
    if (!m.continuous) {
      m._unwrap = null;
      return wrapped;
    }
    const step = unwrapAngleStep(m._unwrap, wrapped, 360);
    m._unwrap = step.state;
    return step.value;
  }

  /** Live length in metres for the properties readout / graphs. */
  measureLengthM(id) {
    const parts = this.measureLengthParts(id);
    if (!parts) return null;
    const m = this.getById(id);
    let v = lengthValueFromParts(parts, m?.component, m?.signed === true);
    if (m?.baselineM != null && Number.isFinite(m.baselineM)) v -= m.baselineM;
    return v;
  }

  /**
   * Display-frame Δx / Δy / distance / L-path (metres) for the inspector.
   * @param {string} id
   * @returns {{ dx: number, dy: number, distance: number, manhattan: number }|null}
   */
  measureLengthParts(id) {
    const m = this.getById(id);
    if (!m || m.kind !== 'length') return null;
    const a = this._resolveEnd(m, 'a');
    const b = this._resolveEnd(m, 'b');
    if (!a || !b) return null;
    return lengthPartsM(a, b);
  }

  /**
   * Place a static interior angle at a wedge corner (foot / top / right-angle).
   * @param {import('matter-js').Body} body
   * @param {'foot'|'top'|'right'} which
   * @param {string|null} [label]
   * @returns {string|null} new measurement id
   */
  addWedgeInteriorAngle(body, which, label = null) {
    if (!body || body._newtonType !== 'wedge') return null;
    const meta = this._anchorMeta(body);
    /** @type {{ vertex: string, a: string, b: string, defaultLabel: string }} */
    let spec;
    if (which === 'foot') {
      spec = { vertex: 'br', a: 'bl', b: 'tl', defaultLabel: 'θ' };
    } else if (which === 'top') {
      spec = { vertex: 'tl', a: 'bl', b: 'br', defaultLabel: 'θ' };
    } else {
      spec = { vertex: 'bl', a: 'br', b: 'tl', defaultLabel: '90°' };
    }
    const mk = (corner) => ({ kind: 'vertex', ...meta, vertex: corner });
    this._onBeforeChange?.();
    const id = `m${_nextId++}`;
    const item = {
      id,
      kind: 'angle',
      dynamic: true,
      signed: false, // interior mark: always positive magnitude
      frozen: null,
      label: label ?? spec.defaultLabel,
      vertex: mk(spec.vertex),
      a: mk(spec.a),
      b: mk(spec.b),
    };
    this.items.push(item);
    // Freeze immediately so it behaves as a static textbook mark.
    this._freezeMeasure(item);
    item.dynamic = false;
    this.select(id);
    this.sync();
    return id;
  }

  /** @param {string|null} id */
  select(id) {
    if (this._selectedId === id) {
      this.sync();
      return;
    }
    this._selectedId = id;
    this._onSelect?.(id ? { type: 'measurement', id } : null);
    this.sync();
  }

  deleteSelected() {
    if (!this._selectedId) return false;
    this._onBeforeChange?.();
    const id = this._selectedId;
    this.items = this.items.filter(m => m.id !== id);
    this._selectedId = null;
    this._onSelect?.(null);
    this.sync();
    return true;
  }

  cancelDraft() {
    if (!this._draft) return false;
    this._draft = null;
    this.sync();
    return true;
  }

  isEditing() {
    return !!this._edit;
  }

  /** Cancel an in-progress handle drag (e.g. before undo/redo). */
  cancelEdit() {
    if (!this._edit) return false;
    this._edit = null;
    this.sync();
    return true;
  }

  /** Record one undo snapshot for the current edit (at most once per gesture). */
  _ensureEditHistory() {
    if (!this._edit || this._edit.historyPushed) return;
    this._onBeforeChange?.();
    this._edit.historyPushed = true;
  }

  /**
   * Unified pointer entry for InteractionHandler.
   * @param {{ x: number, y: number }} pt
   * @param {{ mode?: string, ctrlKey?: boolean, selectOnly?: boolean, editAndToolsOnly?: boolean }} [opts]
   * @returns {boolean} consumed
   */
  handlePointerDown(pt, opts = {}) {
    const mode = opts.mode ?? null;
    const selectOnly = opts.selectOnly === true;
    const editAndToolsOnly = opts.editAndToolsOnly === true;

    if (!selectOnly) {
      // Drag handles on the selected length / angle (any mode except pan).
      const handle = this._hitEditHandle(pt);
      if (handle) {
        this._beginEdit(handle, pt);
        return true;
      }

      if (mode === 'measure-length' || mode === 'measure-angle') {
        this._tool = mode;
        return this.pointerDown(pt, !!opts.ctrlKey);
      }

      if (editAndToolsOnly) return false;
    }

    // Select mode: click an existing measurement to select it (and start a drag if on a handle).
    // Call this *after* body/constraint hits so overlapping objects win.
    if (mode === 'select' || selectOnly) {
      const hit = this._hitTest(pt);
      if (hit) {
        this.select(hit.id);
        const after = this._hitEditHandle(pt);
        if (after) this._beginEdit(after, pt);
        return true;
      }
    }

    return false;
  }

  /**
   * @param {{ m: object, which: string }} handle
   * @param {{ x: number, y: number }} pt
   */
  _beginEdit(handle, pt) {
    /** @type {{ measureId: string, which: string, startPt: {x:number,y:number}, startDimOffset?: number, startLabelNudge?: {x:number,y:number}, dimNormal?: {x:number,y:number}, historyPushed: boolean }} */
    const edit = {
      measureId: handle.m.id,
      which: handle.which,
      startPt: { x: pt.x, y: pt.y },
      historyPushed: false,
    };
    if (handle.which === 'dim' || handle.which === 'label') {
      edit.startDimOffset = dimOffsetOf(handle.m);
      edit.startLabelNudge = {
        x: handle.m.labelNudge?.x ?? 0,
        y: handle.m.labelNudge?.y ?? 0,
      };
      const a = this._resolveEnd(handle.m, 'a');
      const b = this._resolveEnd(handle.m, 'b');
      if (a && b) {
        const segs = this._lengthDrawSegments(a, b, handle.m);
        if (segs[0]) edit.dimNormal = { x: segs[0].nx, y: segs[0].ny };
      }
    }
    this._edit = edit;
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @param {{ ctrlKey?: boolean }} [opts]
   * @returns {boolean}
   */
  handlePointerMove(pt, opts = {}) {
    if (this._edit) {
      this._applyEdit(pt, !!opts.ctrlKey);
      return true;
    }
    if (this._draft) {
      this._draft.cursor = this._draftCursor(pt, !!opts.ctrlKey);
      // Face-snap preview while placing angle rays on a wedge.
      if (this._draft.kind === 'angle' && this._draft.vertex && !opts.ctrlKey) {
        const face = this._pickWedgeFaceFromVertex(this._draft.vertex, pt);
        if (face) {
          const end = this.resolve(face);
          if (end) this._draft.cursor = { ...end };
        }
      }
      this.sync();
      return true;
    }
    return false;
  }

  /**
   * Draft preview cursor: Ctrl snaps angle rays to 5° about the vertex,
   * and length ends onto the horizontal / vertical through the first point.
   * @param {{ x: number, y: number }} pt
   * @param {boolean} ctrlKey
   */
  _draftCursor(pt, ctrlKey) {
    if (!ctrlKey || !this._draft) return { ...pt };
    if (this._draft.kind === 'length' && this._draft.a) {
      const a = this.resolve(this._draft.a);
      if (!a) return { ...pt };
      return this._axisSnapPoint(a, pt);
    }
    if (this._draft.kind !== 'angle' || !this._draft.vertex) {
      return { ...pt };
    }
    const v = this.resolve(this._draft.vertex);
    if (!v) return { ...pt };
    let ang = displayAngleFromVertex(v, pt);
    ang = snapAngleRad(ang, true);
    const len = Math.max(dist(v, pt), VEL_TIP_LEN * 0.55);
    return tipFromDisplayAngle(v, ang, len);
  }

  /**
   * Project `pt` onto the nearer axis through `origin` (CAD ortho).
   * @param {{ x: number, y: number }} origin
   * @param {{ x: number, y: number }} pt
   */
  _axisSnapPoint(origin, pt) {
    const dx = pt.x - origin.x;
    const dy = pt.y - origin.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: pt.x, y: origin.y };
    return { x: origin.x, y: pt.y };
  }

  /**
   * Length endpoint: snap to bodies as usual, Ctrl + free world point → axis align.
   * @param {MeasureAnchor} picked
   * @param {MeasureAnchor|null|undefined} other
   * @param {boolean} ctrlKey
   * @returns {MeasureAnchor}
   */
  _lengthAnchor(picked, other, ctrlKey) {
    if (!ctrlKey || !other || picked?.kind !== 'world') return picked;
    const origin = this.resolve(other);
    if (!origin) return picked;
    const snapped = this._axisSnapPoint(origin, { x: picked.x, y: picked.y });
    return { kind: 'world', x: snapped.x, y: snapped.y };
  }

  /**
   * Prefer the AABB elbow nearer a ground vertex (table edge).
   * @param {object} m
   * @returns {'xy'|'yx'}
   */
  _guessElbow(m) {
    const a = this._resolveEnd(m, 'a');
    const b = this._resolveEnd(m, 'b');
    if (!a || !b) return 'xy';
    const xy = { x: b.x, y: a.y };
    const yx = { x: a.x, y: b.y };
    let best = 'xy';
    let bestD = Infinity;
    for (const body of this.engine.bodies) {
      if (body._newtonType !== 'ground') continue;
      const meta = this._anchorMeta(body);
      for (const vertex of /** @type {const} */ (['groundA', 'groundB'])) {
        const v = this.resolve({ kind: 'vertex', ...meta, vertex });
        if (!v) continue;
        const dxy = dist(xy, v);
        const dyx = dist(yx, v);
        if (dxy < bestD) { bestD = dxy; best = 'xy'; }
        if (dyx < bestD) { bestD = dyx; best = 'yx'; }
      }
    }
    return best;
  }

  handlePointerUp() {
    if (!this._edit) return false;
    this._edit = null;
    this.sync();
    return true;
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @param {boolean} [ctrlKey]
   * @returns {boolean} consumed
   */
  pointerDown(pt, ctrlKey = false) {
    if (!this._tool) return false;

    // Click an existing measurement to select (and finish draft).
    const hit = this._hitTest(pt);
    if (hit && !this._draft) {
      this.select(hit.id);
      const after = this._hitEditHandle(pt);
      if (after) this._beginEdit(after, pt);
      return true;
    }

    const snap = this._snapEnabled();

    if (this._tool === 'measure-length') {
      const picked = this._pickAnchor(pt, snap);
      const anchor = this._lengthAnchor(picked, this._draft?.a, ctrlKey);
      if (!this._draft) {
        this._draft = { kind: 'length', a: anchor, cursor: { ...pt } };
      } else {
        this._onBeforeChange?.();
        const item = {
          id: `m${_nextId++}`,
          kind: 'length',
          dynamic: true,
          frozen: null,
          label: null,
          component: 'distance',
          elbow: 'xy',
          dimOffset: DEFAULT_DIM_OFFSET,
          labelNudge: { x: 0, y: 0 },
          a: this._draft.a,
          b: anchor,
        };
        item.elbow = this._guessElbow(item);
        this.items.push(item);
        this._draft = null;
        this.select(item.id);
      }
      this.sync();
      return true;
    }

    // measure-angle: one-click static interior angle inside a wedge
    if (!this._draft) {
      const wedgeHit = this._pickWedgeInteriorAngle(pt);
      if (wedgeHit) {
        this.addWedgeInteriorAngle(wedgeHit.body, wedgeHit.which);
        return true;
      }
      const vertex = this._pickAnchor(pt, snap);
      this._draft = { kind: 'angle', vertex, a: null, cursor: { ...pt } };
    } else if (!this._draft.a) {
      this._draft.a = this._pickAngleRayAnchor(this._draft.vertex, pt, ctrlKey, snap);
      this._draft.cursor = this._draftCursor(pt, ctrlKey);
    } else {
      const b = this._pickAngleRayAnchor(this._draft.vertex, pt, ctrlKey, snap);
      this._onBeforeChange?.();
      const item = {
        id: `m${_nextId++}`,
        kind: 'angle',
        dynamic: true,
        signed: true,
        frozen: null,
        label: null,
        vertex: this._draft.vertex,
        a: this._draft.a,
        b,
      };
      // Pure wedge-corner geometry → freeze as a static textbook mark.
      if (this._isWedgeCornerAngle(item)) {
        item.signed = false;
        this.items.push(item);
        this._freezeMeasure(item);
        item.dynamic = false;
      } else {
        this.items.push(item);
      }
      this._draft = null;
      this.select(item.id);
    }
    this.sync();
    return true;
  }

  /**
   * Ray anchor while creating an angle: Ctrl → 5° snap, else face-snap on wedges.
   * @param {MeasureAnchor} vertexAnchor
   * @param {{ x: number, y: number }} pt
   * @param {boolean} ctrlKey
   * @param {boolean} snapGrid
   */
  _pickAngleRayAnchor(vertexAnchor, pt, ctrlKey, snapGrid) {
    if (ctrlKey) return this._anchorFromRayDrag(vertexAnchor, pt, true);
    const face = this._pickWedgeFaceFromVertex(vertexAnchor, pt);
    if (face) return face;
    return this._pickAnchor(pt, snapGrid);
  }

  /**
   * True when vertex/a/b are three distinct corners of the same wedge.
   * @param {object} item
   */
  _isWedgeCornerAngle(item) {
    const verts = [item.vertex, item.a, item.b];
    if (!verts.every(a => a?.kind === 'vertex' && a.vertex)) return false;
    const label = verts[0].bodyLabel ?? verts[0].bodyId;
    if (label == null) return false;
    const same = verts.every(a => (a.bodyLabel ?? a.bodyId) === label);
    if (!same) return false;
    const keys = new Set(verts.map(a => a.vertex));
    return keys.size === 3
      && keys.has('bl') && keys.has('br') && keys.has('tl');
  }

  /**
   * Click inside a wedge near a corner → which interior angle to place.
   * @param {{ x: number, y: number }} pt
   * @returns {{ body: import('matter-js').Body, which: 'foot'|'top'|'right' }|null}
   */
  _pickWedgeInteriorAngle(pt) {
    let best = null;
    let bestD = HIT_PX * 2.5;
    for (const b of this.engine.bodies) {
      if (b._newtonType !== 'wedge') continue;
      if (!wedgeContainsWorldPoint(b, pt.x, pt.y, 8)) continue;
      const verts = wedgeTriangleWorldVerts(b);
      const candidates = [
        { which: /** @type {const} */ ('right'), p: verts.bl },
        { which: /** @type {const} */ ('foot'), p: verts.br },
        { which: /** @type {const} */ ('top'), p: verts.tl },
      ];
      for (const c of candidates) {
        const d = dist(pt, c.p);
        if (d < bestD) {
          bestD = d;
          best = { body: b, which: c.which };
        }
      }
    }
    return best;
  }

  /**
   * If the angle vertex is a wedge corner, snap the ray onto a face when near it.
   * @param {MeasureAnchor} vertexAnchor
   * @param {{ x: number, y: number }} pt
   * @returns {MeasureAnchor|null}
   */
  _pickWedgeFaceFromVertex(vertexAnchor, pt) {
    if (!vertexAnchor || vertexAnchor.kind !== 'vertex') return null;
    const body = this._bodyForAnchor(vertexAnchor);
    if (!body || body._newtonType !== 'wedge') return null;
    const corner = vertexAnchor.vertex;
    if (corner !== 'bl' && corner !== 'br' && corner !== 'tl') return null;

    const verts = wedgeTriangleWorldVerts(body);
    const V = verts[corner];
    if (!V) return null;
    const meta = this._anchorMeta(body);

    /** Other two corners = the two faces from this vertex. */
    const others = /** @type {('bl'|'br'|'tl')[]} */ (
      ['bl', 'br', 'tl'].filter(k => k !== corner)
    );

    let best = null;
    let bestD = HIT_PX * 1.75;
    for (const key of others) {
      const end = verts[key];
      const d = this._distToSeg(pt, V, end);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'vertex', ...meta, vertex: key };
      }
    }
    return best;
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @returns {boolean}
   */
  pointerMove(pt) {
    return this.handlePointerMove(pt, {});
  }

  /** Redraw all measurements from current body state (call every frame). */
  sync() {
    this._clearLayers();

    for (const m of this.items) {
      if (m.kind === 'length') this._drawLength(m, m.id === this._selectedId);
      else if (m.kind === 'angle') this._drawAngle(m, m.id === this._selectedId);
    }

    if (this._draft) this._drawDraft(this._draft);
  }

  _snapEnabled() {
    return this._getSnapEnabled?.() ?? true;
  }

  // ─── Edit / couple ─────────────────────────────────────────────

  /**
   * Tip position used for drawing / edit handles (along the resolved ray).
   * When `full`, keep the true endpoint length (velocity / force vector size).
   * @param {{ x: number, y: number }} vertex
   * @param {{ x: number, y: number }} end
   * @param {{ full?: boolean }} [opts]
   */
  _displayRayTip(vertex, end, opts = {}) {
    const dx = end.x - vertex.x;
    const dy = end.y - vertex.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return { ...end };
    if (opts.full) return { x: end.x, y: end.y };
    const rayLen = Math.max(56, Math.min(110, 0.85 * l));
    const len = Math.max(rayLen, Math.min(l, 140));
    return { x: vertex.x + (dx / l) * len, y: vertex.y + (dy / l) * len };
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @returns {{ m: object, which: 'a'|'b'|'vertex'|'dim'|'label' }|null}
   */
  _hitEditHandle(pt) {
    if (!this._selectedId) return null;
    const m = this.items.find(x => x.id === this._selectedId);
    if (!m) return null;

    if (m.kind === 'length') {
      const a = this._resolveEnd(m, 'a');
      const b = this._resolveEnd(m, 'b');
      if (a && dist(pt, a) <= HANDLE_HIT_PX) return { m, which: 'a' };
      if (b && dist(pt, b) <= HANDLE_HIT_PX) return { m, which: 'b' };
      if (a && b) {
        const labelPos = this._lengthLabelPos(a, b, m);
        if (labelPos && dist(pt, labelPos) <= HANDLE_HIT_PX + 6) return { m, which: 'label' };
        const segs = this._lengthDrawSegments(a, b, m);
        if (segs.some(s => this._distToSeg(pt, s.p0, s.p1) <= HIT_PX)) return { m, which: 'dim' };
      }
      return null;
    }

    if (m.kind !== 'angle') return null;
    const v = this._resolveEnd(m, 'vertex');
    const a = this._resolveEnd(m, 'a');
    const b = this._resolveEnd(m, 'b');
    if (!v) return null;

    const tipA = a
      ? this._displayRayTip(v, a, {
        full: m.dynamic !== false && (m.a?.kind === 'velocity' || m.a?.kind === 'force'),
      })
      : null;
    const tipB = b
      ? this._displayRayTip(v, b, {
        full: m.dynamic !== false && (m.b?.kind === 'velocity' || m.b?.kind === 'force'),
      })
      : null;

    // Prefer ray tips over vertex when overlapping.
    if (tipA && dist(pt, tipA) <= HANDLE_HIT_PX) return { m, which: 'a' };
    if (tipB && dist(pt, tipB) <= HANDLE_HIT_PX) return { m, which: 'b' };
    if (dist(pt, v) <= HANDLE_HIT_PX) return { m, which: 'vertex' };
    return null;
  }

  /**
   * Default value-label anchor for a length dimension (before nudge).
   * @param {{ x: number, y: number }} a
   * @param {{ x: number, y: number }} b
   * @param {object} measure
   */
  _lengthLabelPos(a, b, measure) {
    const segs = this._lengthDrawSegments(a, b, measure);
    if (!segs.length) return null;
    const component = normalizeLengthComponent(measure?.component);
    let seg = segs[0];
    if (component === 'manhattan' && segs.length === 2) {
      const hLen = Math.abs(b.x - a.x);
      const vLen = Math.abs(b.y - a.y);
      seg = hLen >= vLen ? segs[0] : segs[1];
    }
    const mid = { x: (seg.p0.x + seg.p1.x) / 2, y: (seg.p0.y + seg.p1.y) / 2 };
    const nudge = measure?.labelNudge ?? { x: 0, y: 0 };
    return {
      x: mid.x + seg.nx * DEFAULT_LABEL_OUT + (nudge.x || 0),
      y: mid.y + seg.ny * DEFAULT_LABEL_OUT + (nudge.y || 0),
    };
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @param {boolean} ctrlKey
   */
  _applyEdit(pt, ctrlKey) {
    if (!this._edit) return;
    const m = this.items.find(x => x.id === this._edit.measureId);
    if (!m) {
      this._edit = null;
      return;
    }

    this._ensureEditHistory();

    if (m.kind === 'length') {
      this._applyLengthEdit(m, pt, ctrlKey);
      return;
    }

    if (m.kind !== 'angle') {
      this._edit = null;
      return;
    }

    // Static: edit frozen world pose only (no body / vector coupling).
    if (m.dynamic === false) {
      if (!m.frozen) this._freezeMeasure(m);
      const snap = this._snapEnabled();
      if (this._edit.which === 'vertex') {
        let x = pt.x;
        let y = pt.y;
        if (snap) {
          x = snapWorldCoord(x, true);
          y = snapWorldCoord(y, true);
        }
        m.frozen.vertex = { x, y };
      } else {
        const V = m.frozen.vertex ?? this.resolve(m.vertex);
        if (!V) return;
        let ang = displayAngleFromVertex(V, pt);
        if (ctrlKey) ang = snapAngleRad(ang, true);
        m.frozen[this._edit.which] = tipFromDisplayAngle(V, ang);
      }
      this.sync();
      return;
    }

    if (this._edit.which === 'vertex') {
      m.vertex = this._pickAnchor(pt, this._snapEnabled());
      this.sync();
      return;
    }

    const which = this._edit.which;
    if (!ctrlKey) {
      const face = this._pickWedgeFaceFromVertex(m.vertex, pt);
      if (face) {
        m[which] = face;
        this.sync();
        return;
      }
    }
    m[which] = this._anchorFromRayDrag(m.vertex, pt, ctrlKey);
    this.sync();
  }

  /**
   * Drag a length endpoint, dimension offset, or value label.
   * Ctrl axis-aligns a free world point to the other end.
   * @param {object} m
   * @param {{ x: number, y: number }} pt
   * @param {boolean} ctrlKey
   */
  _applyLengthEdit(m, pt, ctrlKey) {
    const which = this._edit?.which;

    if (which === 'dim') {
      const n = this._edit.dimNormal ?? { x: 0, y: -1 };
      const start = this._edit.startPt ?? pt;
      const base = this._edit.startDimOffset ?? DEFAULT_DIM_OFFSET;
      const d = (pt.x - start.x) * n.x + (pt.y - start.y) * n.y;
      m.dimOffset = base + d;
      this.sync();
      return;
    }

    if (which === 'label') {
      const start = this._edit.startPt ?? pt;
      const base = this._edit.startLabelNudge ?? { x: 0, y: 0 };
      m.labelNudge = {
        x: base.x + (pt.x - start.x),
        y: base.y + (pt.y - start.y),
      };
      this.sync();
      return;
    }

    if (which !== 'a' && which !== 'b') return;
    const otherKey = which === 'a' ? 'b' : 'a';

    if (m.dynamic === false) {
      if (!m.frozen) this._freezeMeasure(m);
      const other = m.frozen[otherKey] ?? this.resolve(m[otherKey]);
      let x = pt.x;
      let y = pt.y;
      if (ctrlKey && other) {
        const snapped = this._axisSnapPoint(other, pt);
        x = snapped.x;
        y = snapped.y;
      } else if (this._snapEnabled()) {
        x = snapWorldCoord(x, true);
        y = snapWorldCoord(y, true);
      }
      m.frozen[which] = { x, y };
      this.sync();
      return;
    }

    // Endpoint attached to a scene label: drag moves that label's target point.
    const end = m[which];
    if (end?.kind === 'label' && end.labelId && this._labelHooks?.moveTarget) {
      this._labelHooks.moveTarget(end.labelId, pt, { snap: this._snapEnabled() });
      this.sync();
      return;
    }

    const picked = this._pickAnchor(pt, this._snapEnabled());
    m[which] = this._lengthAnchor(picked, m[otherKey], ctrlKey);
    this.sync();
  }

  /**
   * Build a ray-end anchor from a drag around the angle vertex.
   * Couples to velocity / force / horizontal when near those tips.
   * @param {MeasureAnchor} vertexAnchor
   * @param {{ x: number, y: number }} pt
   * @param {boolean} ctrlKey
   * @returns {MeasureAnchor}
   */
  _anchorFromRayDrag(vertexAnchor, pt, ctrlKey) {
    const V = this.resolve(vertexAnchor);
    if (!V) return this._pickAnchor(pt, this._snapEnabled());

    let ang = displayAngleFromVertex(V, pt);
    if (ctrlKey) ang = snapAngleRad(ang, true);

    const tip = tipFromDisplayAngle(V, ang);
    const host = this._bodyForAnchor(vertexAnchor);

    // Prefer coupling on the vertex host body, then any nearby dynamic body.
    const bodies = [];
    if (host) bodies.push(host);
    for (const b of this.engine.bodies) {
      if (b === host) continue;
      if (b.isStatic || b._newtonType === 'metric-basis' || b._newtonType === 'anchor'
        || b._newtonType === 'ground') continue;
      bodies.push(b);
    }

    let best = null;
    let bestD = COUPLE_HIT_PX;

    const consider = (d, anchor) => {
      if (d < bestD) {
        bestD = d;
        best = anchor;
      }
    };

    for (const b of bodies) {
      const meta = this._anchorMeta(b);
      const vTip = this._velocityTip(b);
      const vVec = this._velocityVectorTip(b);
      if (vTip) consider(dist(tip, vTip), { kind: 'velocity', ...meta });
      if (vVec) consider(dist(pt, vVec), { kind: 'velocity', ...meta });
      if (vTip) consider(dist(pt, vTip), { kind: 'velocity', ...meta });

      const fTip = this._forceTip(b);
      const fVec = this._forceVectorTip(b);
      if (fTip) consider(dist(tip, fTip), { kind: 'force', ...meta });
      if (fVec) consider(dist(pt, fVec), { kind: 'force', ...meta });
      if (fTip) consider(dist(pt, fTip), { kind: 'force', ...meta });

      // Horizontal (±x) relative to this body.
      for (const dir of /** @type {const} */ ([1, -1])) {
        const h = { x: b.position.x + dir * VEL_TIP_LEN, y: b.position.y };
        consider(dist(tip, h), { kind: 'horizontal', ...meta, dir });
        consider(dist(pt, h), { kind: 'horizontal', ...meta, dir });
      }
    }

    if (best) return best;

    // Free ray on the host body, or world tip if vertex is world-only.
    if (host) {
      const meta = this._anchorMeta(host);
      const deg = (ang * 180) / Math.PI;
      return {
        kind: 'ray',
        ...meta,
        angleDeg: ctrlKey ? Math.round(deg / SNAP_ANGLE_STEP_5_DEG) * SNAP_ANGLE_STEP_5_DEG : deg,
      };
    }

    return { kind: 'world', x: tip.x, y: tip.y };
  }

  // ─── Anchor picking / resolving ────────────────────────────────

  /** @param {import('matter-js').Body} b */
  _anchorMeta(b) {
    const label = typeof b.label === 'string' && b.label ? b.label : undefined;
    return label ? { bodyId: b.id, bodyLabel: label } : { bodyId: b.id };
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @param {boolean} snapGrid
   * @returns {MeasureAnchor}
   */
  _pickAnchor(pt, snapGrid) {
    let best = null;
    let bestD = HIT_PX;

    const consider = (d, anchor) => {
      if (d < bestD) {
        bestD = d;
        best = anchor;
      }
    };

    for (const b of this.engine.bodies) {
      if (b._newtonType === 'metric-basis') continue;
      const meta = this._anchorMeta(b);

      if (b._newtonType === 'wedge') {
        const verts = wedgeTriangleWorldVerts(b);
        for (const key of /** @type {const} */ (['bl', 'br', 'tl'])) {
          const v = verts[key];
          consider(dist(pt, v), { kind: 'vertex', ...meta, vertex: key });
        }
        const aabb = wedgeAABBCenterWorld(b);
        consider(dist(pt, aabb), { kind: 'body', ...meta });
      } else if (b._newtonType === 'ground') {
        const w = b._width ?? 400;
        const h = b._height ?? 20;
        const c = Math.cos(b.angle);
        const s = Math.sin(b.angle);
        // Top-edge ends (walking surface).
        const hx = w / 2;
        const hy = -h / 2;
        const a = {
          x: b.position.x + c * (-hx) - s * hy,
          y: b.position.y + s * (-hx) + c * hy,
        };
        const e = {
          x: b.position.x + c * hx - s * hy,
          y: b.position.y + s * hx + c * hy,
        };
        consider(dist(pt, a), { kind: 'vertex', ...meta, vertex: 'groundA' });
        consider(dist(pt, e), { kind: 'vertex', ...meta, vertex: 'groundB' });
        consider(dist(pt, b.position), { kind: 'body', ...meta });
      } else {
        consider(dist(pt, b.position), { kind: 'body', ...meta });
      }

      if (!b.isStatic && b._newtonType !== 'anchor' && b._newtonType !== 'ground') {
        const vTip = this._velocityTip(b);
        if (vTip) consider(dist(pt, vTip), { kind: 'velocity', ...meta });
        const vVec = this._velocityVectorTip(b);
        if (vVec) consider(dist(pt, vVec), { kind: 'velocity', ...meta });
        const fTip = this._forceTip(b);
        if (fTip) consider(dist(pt, fTip), { kind: 'force', ...meta });
        const fVec = this._forceVectorTip(b);
        if (fVec) consider(dist(pt, fVec), { kind: 'force', ...meta });
      }
    }

    for (const c of this.engine.constraints) {
      if (c._ropeLink) continue;
      for (const end of /** @type {const} */ (['A', 'B'])) {
        const p = constraintAnchorWorld(c, end);
        if (p) consider(dist(pt, p), {
          kind: 'world',
          x: p.x,
          y: p.y,
        });
      }
    }

    if (best) return best;

    let x = pt.x;
    let y = pt.y;
    if (snapGrid) {
      x = snapWorldCoord(x, true);
      y = snapWorldCoord(y, true);
    }
    return { kind: 'world', x, y };
  }

  /** @param {import('matter-js').Body} body */
  _velocityTip(body) {
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const speed = Math.hypot(vxMs, vyMs);
    const ux = (speed > 1e-9 ? vxMs / speed : 1);
    const uy = (speed > 1e-9 ? -vyMs / speed : 0);
    return {
      x: body.position.x + ux * VEL_TIP_LEN,
      y: body.position.y + uy * VEL_TIP_LEN,
    };
  }

  /** Actual v₀ vector tip (matches the drag handle). */
  _velocityVectorTip(body) {
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const vPx = getVelocityPxPerMs();
    const tip = {
      x: body.position.x + vxMs * vPx,
      y: body.position.y - vyMs * vPx,
    };
    if (Math.hypot(tip.x - body.position.x, tip.y - body.position.y) < 1) return null;
    return tip;
  }

  /** @param {import('matter-js').Body} body */
  _forceTip(body) {
    const af = getAppliedForce(body);
    if (!af) return null;
    const rad = (af.thetaDeg * Math.PI) / 180;
    return tipFromDisplayAngle(body.position, rad, VEL_TIP_LEN);
  }

  /** Actual applied-force vector tip (matches the drag handle). */
  _forceVectorTip(body) {
    const af = getAppliedForce(body);
    if (!af) return null;
    const rad = (af.thetaDeg * Math.PI) / 180;
    const fPx = getForcePxPerN();
    const tip = tipFromDisplayAngle(body.position, rad, af.F * fPx);
    if (Math.hypot(tip.x - body.position.x, tip.y - body.position.y) < 1) return null;
    return tip;
  }

  /**
   * Horizontal reference from a body centre (Matter +x).
   * @param {import('matter-js').Body} body
   * @param {MeasureAnchor} a
   */
  _horizontalTip(body, a) {
    let dir = a.dir ?? 1;
    if (a.followVelocityX) {
      const { vxMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
      dir = vxMs < 0 ? -1 : 1;
    }
    return {
      x: body.position.x + dir * VEL_TIP_LEN,
      y: body.position.y,
    };
  }

  /**
   * Prefer scene label (stable), fall back to Matter id.
   * @param {MeasureAnchor} a
   * @returns {import('matter-js').Body|null}
   */
  _bodyForAnchor(a) {
    if (!a) return null;
    if (typeof a.bodyLabel === 'string' && a.bodyLabel) {
      const byLabel = this.engine.bodies.find(b => b.label === a.bodyLabel);
      if (byLabel) {
        a.bodyId = byLabel.id;
        return byLabel;
      }
    }
    if (a.bodyId != null) {
      return this.engine.bodies.find(b => b.id === a.bodyId) ?? null;
    }
    return null;
  }

  /**
   * @param {MeasureAnchor} a
   * @returns {{ x: number, y: number }|null}
   */
  resolve(a) {
    if (!a) return null;
    if (a.kind === 'world') return { x: a.x, y: a.y };

    if (a.kind === 'constraint') {
      const c = this.engine.constraints.find(x => x.label === a.constraintLabel);
      if (!c) return null;
      return constraintAnchorWorld(c, a.end === 'B' ? 'B' : 'A');
    }

    if (a.kind === 'label') {
      return this._labelHooks?.resolveAnchor?.(a) ?? null;
    }

    const body = this._bodyForAnchor(a);
    if (!body) return null;

    if (a.kind === 'body') {
      if (body._newtonType === 'wedge') return wedgeAABBCenterWorld(body);
      return { x: body.position.x, y: body.position.y };
    }

    if (a.kind === 'velocity') {
      // Prefer the drawn v₀ tip so the angle ray matches vector size.
      const tip = this._velocityVectorTip(body) ?? this._velocityTip(body);
      return tip ?? { x: body.position.x, y: body.position.y };
    }

    if (a.kind === 'force') {
      const tip = this._forceVectorTip(body) ?? this._forceTip(body);
      return tip ?? { x: body.position.x, y: body.position.y };
    }

    if (a.kind === 'ray') {
      const rad = ((a.angleDeg ?? 0) * Math.PI) / 180;
      return tipFromDisplayAngle(body.position, rad, VEL_TIP_LEN);
    }

    if (a.kind === 'horizontal') return this._horizontalTip(body, a);

    if (a.kind === 'vertex') {
      if (body._newtonType === 'wedge') {
        const verts = wedgeTriangleWorldVerts(body);
        return verts[a.vertex] ?? null;
      }
      if (body._newtonType === 'ground') {
        const w = body._width ?? 400;
        const h = body._height ?? 20;
        const c = Math.cos(body.angle);
        const s = Math.sin(body.angle);
        const hx = w / 2;
        const hy = -h / 2;
        const sign = a.vertex === 'groundB' ? 1 : -1;
        return {
          x: body.position.x + c * (sign * hx) - s * hy,
          y: body.position.y + s * (sign * hx) + c * hy,
        };
      }
    }
    return null;
  }

  // ─── Hit testing ───────────────────────────────────────────────

  _hitTest(pt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      if (m.kind === 'length') {
        const a = this._resolveEnd(m, 'a');
        const b = this._resolveEnd(m, 'b');
        if (!a || !b) continue;
        if (dist(pt, a) <= HANDLE_HIT_PX || dist(pt, b) <= HANDLE_HIT_PX) return m;
        const labelPos = this._lengthLabelPos(a, b, m);
        if (labelPos && dist(pt, labelPos) <= HANDLE_HIT_PX + 6) return m;
        if (this._distToSeg(pt, a, b) <= HIT_PX) return m;
        const segs = this._lengthDrawSegments(a, b, m);
        if (segs.some(s => this._distToSeg(pt, s.p0, s.p1) <= HIT_PX)) return m;
      } else if (m.kind === 'angle') {
        const v = this._resolveEnd(m, 'vertex');
        if (v && dist(pt, v) <= HIT_PX + 6) return m;
        const a = this._resolveEnd(m, 'a');
        const b = this._resolveEnd(m, 'b');
        if (v && a && this._distToSeg(pt, v, a) <= HIT_PX) return m;
        if (v && b && this._distToSeg(pt, v, b) <= HIT_PX) return m;
      }
    }
    return null;
  }

  /**
   * Screen-space dimension segments for a length (chord, |Δx|, |Δy|, or L-path).
   * @param {{ x: number, y: number }} a
   * @param {{ x: number, y: number }} b
   * @param {object|null} [measure]
   * @returns {{ p0: {x:number,y:number}, p1: {x:number,y:number}, nx: number, ny: number }[]}
   */
  _lengthDrawSegments(a, b, measure = null) {
    const component = normalizeLengthComponent(measure?.component);
    const off = dimOffsetOf(measure);
    if (component === 'dx') {
      const y = Math.min(a.y, b.y) - off;
      return [{ p0: { x: a.x, y }, p1: { x: b.x, y }, nx: 0, ny: -1 }];
    }
    if (component === 'dy') {
      const x = Math.max(a.x, b.x) + off;
      return [{ p0: { x, y: a.y }, p1: { x, y: b.y }, nx: 1, ny: 0 }];
    }
    if (component === 'manhattan') {
      const which = measure?.elbow === 'yx' ? 'yx' : 'xy';
      const elbow = this._manhattanElbow(a, b, which);
      const ny = elbow.y <= Math.min(a.y, b.y) + 1e-6 ? -1 : 1;
      const nx = elbow.x >= Math.max(a.x, b.x) - 1e-6 ? 1 : -1;
      const join = { x: elbow.x + nx * off, y: elbow.y + ny * off };
      if (which === 'yx') {
        return [
          { p0: { x: join.x, y: a.y }, p1: join, nx, ny: 0 },
          { p0: join, p1: { x: b.x, y: join.y }, nx: 0, ny },
        ];
      }
      return [
        { p0: { x: a.x, y: join.y }, p1: join, nx: 0, ny },
        { p0: join, p1: { x: join.x, y: b.y }, nx, ny: 0 },
      ];
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      // Collapsed chord: keep a tick location so the zero label still draws.
      return [{
        p0: { x: a.x, y: a.y - off },
        p1: { x: a.x, y: a.y - off },
        nx: 0,
        ny: -1,
      }];
    }
    const u = unit(dx, dy);
    const nx = -u.y;
    const ny = u.x;
    return [{
      p0: { x: a.x + nx * off, y: a.y + ny * off },
      p1: { x: b.x + nx * off, y: b.y + ny * off },
      nx, ny,
    }];
  }

  /**
   * @param {{ x: number, y: number }} a
   * @param {{ x: number, y: number }} b
   * @param {'xy'|'yx'|string|null|undefined} elbow
   */
  _manhattanElbow(a, b, elbow) {
    if (elbow === 'yx') return { x: a.x, y: b.y };
    return { x: b.x, y: a.y };
  }

  _distToSeg(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-8) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // ─── Drawing ───────────────────────────────────────────────────

  _drawDraft(draft) {
    const cursor = draft.cursor;
    if (draft.kind === 'length') {
      const a = this.resolve(draft.a);
      if (!a || !cursor) return;
      this._drawLengthGeom(a, cursor, false, true);
      return;
    }
    const v = this.resolve(draft.vertex);
    if (!v) return;
    if (!draft.a) {
      this._drawRay(v, cursor, true, this._leaderLayer ?? this.layer);
      this._drawDot(v);
      return;
    }
    const a = this.resolve(draft.a);
    if (!a) return;
    this._drawAngleGeom(v, a, cursor, false, true);
  }

  _drawLength(m, selected) {
    const a = this._resolveEnd(m, 'a');
    const b = this._resolveEnd(m, 'b');
    if (!a || !b) return;
    this._drawLengthGeom(a, b, selected, false, m.label, m);
  }

  _drawAngle(m, selected) {
    const v = this._resolveEnd(m, 'vertex');
    const a = this._resolveEnd(m, 'a');
    const b = this._resolveEnd(m, 'b');
    if (!v || !a || !b) return;
    const dashA = m.dynamic !== false && m.a?.kind === 'horizontal';
    const dashB = m.dynamic !== false && m.b?.kind === 'horizontal';
    this._drawAngleGeom(v, a, b, selected, false, m.label, dashA, dashB, m);
  }

  _measureInk(_selected) {
    return COLORS.inkLight;
  }

  _drawLengthGeom(a, b, selected, draft, labelText = null, measure = null) {
    const g = el('g', {
      class: `measure-length${selected ? ' selected' : ''}${draft ? ' draft' : ''}`,
      opacity: draft ? '0.65' : '1',
    });
    const gLeader = el('g', {
      class: `measure-length-leaders${selected ? ' selected' : ''}${draft ? ' draft' : ''}`,
      opacity: draft ? '0.65' : '1',
    });
    const segs = this._lengthDrawSegments(a, b, measure);
    if (!segs.length) return;

    const ink = this._measureInk(selected);
    const sw = selected ? 2 : 1.75;
    const tick = 6;
    const component = normalizeLengthComponent(measure?.component);
    const parts = lengthPartsM(a, b);
    let value = parts ? lengthValueFromParts(parts, component, measure?.signed === true) : null;
    if (value != null && measure?.baselineM != null && Number.isFinite(measure.baselineM)) {
      value -= measure.baselineM;
    }
    const metres = formatLengthMetres(value);
    const label = labelText ? `${labelText} = ${metres}` : metres;
    const nudge = measure?.labelNudge ?? { x: 0, y: 0 };

    const extendTo = (from, to) => {
      gLeader.appendChild(el('line', {
        x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        stroke: ink, 'stroke-width': 1.25, 'stroke-dasharray': '3 3', opacity: 0.75,
        'vector-effect': 'non-scaling-stroke',
      }));
    };

    const drawArm = (seg, showLabel) => {
      const { p0, p1, nx, ny } = seg;
      g.appendChild(el('line', {
        x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y,
        stroke: ink, 'stroke-width': sw, 'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke',
      }));
      g.appendChild(el('line', {
        x1: p0.x - nx * tick, y1: p0.y - ny * tick,
        x2: p0.x + nx * tick, y2: p0.y + ny * tick,
        stroke: ink, 'stroke-width': sw,
        'vector-effect': 'non-scaling-stroke',
      }));
      g.appendChild(el('line', {
        x1: p1.x - nx * tick, y1: p1.y - ny * tick,
        x2: p1.x + nx * tick, y2: p1.y + ny * tick,
        stroke: ink, 'stroke-width': sw,
        'vector-effect': 'non-scaling-stroke',
      }));
      if (showLabel) {
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        this._drawLabel(
          g,
          mid.x + nx * DEFAULT_LABEL_OUT + (nudge.x || 0),
          mid.y + ny * DEFAULT_LABEL_OUT + (nudge.y || 0),
          label,
          ink,
          !!labelText,
        );
      }
    };

    if (component === 'dx') {
      extendTo(a, segs[0].p0);
      extendTo(b, segs[0].p1);
      drawArm(segs[0], true);
    } else if (component === 'dy') {
      extendTo(a, segs[0].p0);
      extendTo(b, segs[0].p1);
      drawArm(segs[0], true);
    } else if (component === 'manhattan' && segs.length === 2) {
      extendTo(a, segs[0].p0);
      extendTo(b, segs[1].p1);
      const hLen = Math.abs(b.x - a.x);
      const vLen = Math.abs(b.y - a.y);
      drawArm(segs[0], hLen >= vLen);
      drawArm(segs[1], vLen > hLen);
    } else {
      extendTo(a, segs[0].p0);
      extendTo(b, segs[0].p1);
      drawArm(segs[0], true);
    }

    if (selected && !draft) {
      this._drawEditHandle(a, g, ink, null);
      this._drawEditHandle(b, g, ink, null);
    }
    (this._leaderLayer ?? this.layer).appendChild(gLeader);
    this.layer.appendChild(g);
  }

  _drawAngleGeom(vertex, pA, pB, selected, draft, labelName = null, dashA = false, dashB = false, measure = null) {
    const g = el('g', {
      class: `measure-angle${selected ? ' selected' : ''}${draft ? ' draft' : ''}`,
      opacity: draft ? '0.65' : '1',
    });
    const leaderParent = this._leaderLayer ?? g;
    const ink = this._measureInk(selected);
    const sw = selected ? 2 : 1.75;

    let dx0 = pA.x - vertex.x;
    let dy0 = pA.y - vertex.y;
    let dx1 = pB.x - vertex.x;
    let dy1 = pB.y - vertex.y;
    const l0 = Math.hypot(dx0, dy0);
    const l1 = Math.hypot(dx1, dy1);
    if (l0 < 1e-6 || l1 < 1e-6) return;
    dx0 /= l0; dy0 /= l0;
    dx1 /= l1; dy1 /= l1;

    // Coupled velocity / force rays use the true vector tip length.
    const fullA = measure?.dynamic !== false
      && (measure?.a?.kind === 'velocity' || measure?.a?.kind === 'force');
    const fullB = measure?.dynamic !== false
      && (measure?.b?.kind === 'velocity' || measure?.b?.kind === 'force');
    const tipA = this._displayRayTip(vertex, pA, { full: fullA });
    const tipB = this._displayRayTip(vertex, pB, { full: fullB });
    const tipLenA = Math.hypot(tipA.x - vertex.x, tipA.y - vertex.y) || 1;
    const tipLenB = Math.hypot(tipB.x - vertex.x, tipB.y - vertex.y) || 1;
    const rayLen = Math.max(56, Math.min(110, 0.85 * Math.min(tipLenA, tipLenB)));
    dx0 = (tipA.x - vertex.x) / tipLenA;
    dy0 = (tipA.y - vertex.y) / tipLenA;
    dx1 = (tipB.x - vertex.x) / tipLenB;
    dy1 = (tipB.y - vertex.y) / tipLenB;
    this._drawRay(vertex, tipA, dashA, dashA ? leaderParent : g, ink, sw);
    this._drawRay(vertex, tipB, dashB, dashB ? leaderParent : g, ink, sw);

    const r = Math.max(14, Math.min(32, rayLen * 0.32));
    const x0 = vertex.x + dx0 * r;
    const y0 = vertex.y + dy0 * r;
    const x1 = vertex.x + dx1 * r;
    const y1 = vertex.y + dy1 * r;
    // Signed from reference ray A → B in display (+y up, CCW +).
    const signedDeg = angleDegBetween(vertex, tipA, tipB, { signed: true }) ?? 0;
    const useSigned = measure?.signed !== false;
    const principal = useSigned ? signedDeg : Math.abs(signedDeg);
    // Arc geometry always uses the principal sector, continuous mode only
    // affects the numeric label (and graphs / properties).
    let deg = principal;
    if (measure?.continuous && useSigned) {
      const step = unwrapAngleStep(measure._unwrap, signedDeg, 360);
      measure._unwrap = step.state;
      deg = step.value;
    } else if (measure) {
      measure._unwrap = null;
    }
    const ang = (Math.abs(signedDeg) * Math.PI) / 180;
    // SVG +y-down: (dx0,dy0)×(dx1,dy1) > 0 is clockwise = sweep-flag 1.
    // That keeps the vertex as the arc centre, the other centre inverts the bulge.
    const svgCross = dx0 * dy1 - dy0 * dx1;
    const sweep = svgCross > 0 ? 1 : 0;
    const large = ang > Math.PI ? 1 : 0;

    g.appendChild(el('path', {
      d: `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`,
      fill: 'none',
      stroke: ink,
      'stroke-width': sw,
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
    }));

    // Label along the swept-sector bisector.
    let bx;
    let by;
    if (useSigned) {
      if (Math.abs(signedDeg) < 1e-6 || Math.abs(Math.abs(signedDeg) - 180) < 1e-6) {
        bx = -dy0;
        by = dx0;
        if (signedDeg < 0) { bx = -bx; by = -by; }
      } else {
        const half = (signedDeg * Math.PI) / 180 / 2;
        const axD = dx0;
        const ayD = -dy0;
        const c = Math.cos(half);
        const s = Math.sin(half);
        const bxD = axD * c - ayD * s;
        const byD = axD * s + ayD * c;
        bx = bxD;
        by = -byD;
      }
    } else {
      bx = dx0 + dx1;
      by = dy0 + dy1;
      if (Math.hypot(bx, by) < 1e-6) {
        bx = -dy0;
        by = dx0;
        if (svgCross < 0) { bx = -bx; by = -by; }
      }
    }
    const blen = Math.hypot(bx, by) || 1;
    bx /= blen;
    by /= blen;
    const labelR = r + 18;
    const text = labelName
      ? `${labelName} = ${deg.toFixed(1)}°`
      : `${deg.toFixed(1)}°`;
    this._drawLabel(
      g,
      vertex.x + bx * labelR + 12,
      vertex.y + by * labelR,
      text,
      ink,
      !!labelName,
      9,
    );

    // White edit handles only while this measurement is selected.
    if (selected && !draft) {
      const coupleA = measure?.dynamic !== false ? measure?.a?.kind : null;
      const coupleB = measure?.dynamic !== false ? measure?.b?.kind : null;
      this._drawEditHandle(tipA, g, ink, coupleA);
      this._drawEditHandle(tipB, g, ink, coupleB);
      this._drawEditHandle(vertex, g, ink, null);
    }

    this.layer.appendChild(g);
  }

  /**
   * @param {{ x: number, y: number }} p
   * @param {SVGElement} parent
   * @param {string} ink
   * @param {string|null|undefined} coupleKind
   */
  _drawEditHandle(p, parent, ink, coupleKind) {
    parent.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: 2.2,
      fill: '#fff',
      stroke: ink,
      'stroke-width': 1,
      'vector-effect': 'non-scaling-stroke',
    }));
    if (coupleKind === 'velocity' || coupleKind === 'force') {
      const t = el('text', {
        x: p.x + 6,
        y: p.y - 4,
        fill: coupleKind === 'force' ? '#c0392b' : '#2980b9',
        'font-size': 9,
        'font-family': FONT_DIAGRAM,
        'font-style': 'italic',
        'pointer-events': 'none',
      });
      t.textContent = coupleKind === 'force' ? 'F' : 'v';
      parent.appendChild(t);
    }
  }

  _drawLabel(parent, x, y, text, ink, italic = false, fontSize = 10) {
    const t = el('text', {
      x, y,
      fill: ink,
      'font-size': fontSize,
      'font-family': FONT_DIAGRAM,
      'font-style': italic ? 'italic' : null,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'pointer-events': 'none',
    });
    setSvgMathLabel(t, text);
    parent.appendChild(t);
  }

  _drawRay(from, to, dashed = false, parent = this.layer, ink = COLORS.ink, sw = 1.75) {
    parent.appendChild(el('line', {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
      stroke: ink,
      'stroke-width': sw,
      'stroke-linecap': 'round',
      'stroke-dasharray': dashed ? '5 4' : null,
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  _drawDot(p, parent = this.layer, ink = COLORS.ink) {
    parent.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: 1.4,
      fill: '#fff',
      stroke: ink,
      'stroke-width': 1,
      'vector-effect': 'non-scaling-stroke',
    }));
  }
}
