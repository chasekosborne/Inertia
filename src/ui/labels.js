/**
 * Text labels: inline on bodies, or callouts with a dotted leader to a target.
 *
 * Scene JSON:
 *   Inline:  { "text": "m", "body": "mass", "offset": { "x": 0, "y": 0 } }
 *     — text rides on the body (body-local offset m, rotates with it).
 *   Callout (static world point):
 *     { "text": "x_0", "point": { "x": 0, "y": -0.1 }, "offset": { "x": 0, "y": -0.3 } }
 *   Callout (dynamic / static object anchor):
 *     { "text": "P", "target": { "kind": "body", "body": "bob" }, "offset": { "x": 0.2, "y": 0.1 } }
 *     Set `"dynamic": false` and optional `"frozen": { "x": 120, "y": 80 }` (world px) to pin the leader tip.
 *
 * Tool UX:
 *   Alt+click on a body  → inline label at the click (inside/on the object).
 *   Two-click elsewhere  → callout: 1st click picks target (body, vertex, or world point), 2nd places text.
 *
 * Selected callouts expose a white target handle (drag to retarget) and a draggable text position.
 * Inline labels drag their body-relative offset only.
 */

import { PX_PER_M, mToPx, pxToM } from '../units.js';
import { COLORS, FONT_DIAGRAM } from '../theme.js';
import { setSvgMathLabel } from '../math-text.js';
import { wedgeAABBCenterWorld } from '../physics/bodies.js';
import { worldToBodyLocal } from '../physics/layout-anchors.js';
import { snapWorldCoord } from '../grid.js';
import { worldPxToDisplayedM } from '../world-origin.js';
import { resolveAnchor as resolveAnchorFromScene } from './measure-eval.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HIT_PX = 10;
/** Pointer hit radius for selected callout target dots (visual r ≈ 2.2). */
const HANDLE_HIT_PX = 6;

let _nextId = 1;

function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== false) e.setAttribute(k, String(v));
  }
  return e;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** @param {{ x: number, y: number }} basePx @param {{ x: number, y: number }} offsetM display metres (+y up) */
function applyDisplayOffsetM(basePx, offsetM) {
  return {
    x: basePx.x + mToPx(offsetM.x ?? 0),
    y: basePx.y - mToPx(offsetM.y ?? 0),
  };
}

/** @param {Map<string, number>} labelToId @param {object} a raw scene anchor */
function _mapSceneAnchor(a, labelToId) {
  if (!a || typeof a !== 'object') return null;
  const out = { ...a };
  if (out.kind === 'constraint') {
    out.constraintLabel = typeof a.constraint === 'string' ? a.constraint : null;
    out.end = a.end === 'B' ? 'B' : 'A';
    return out.constraintLabel ? out : null;
  }
  if (out.kind === 'label') {
    out.labelId = typeof a.label === 'string' ? a.label : null;
    return out.labelId ? out : null;
  }
  if (typeof a.body === 'string') {
    out.bodyId = labelToId.get(a.body);
    out.bodyLabel = a.body;
    delete out.body;
  }
  if (out.kind === 'world') {
    const x = Number(a.x);
    const y = Number(a.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { kind: 'world', x, y } : null;
  }
  if (out.bodyId == null && out.bodyLabel == null
    && ['body', 'velocity', 'force', 'ray', 'vertex', 'horizontal'].includes(out.kind)) {
    return null;
  }
  return out;
}

/** @param {object|null} anchor runtime anchor */
function _anchorToScene(anchor) {
  if (!anchor) return null;
  if (anchor.kind === 'world') {
    return { kind: 'world', x: anchor.x, y: anchor.y };
  }
  if (anchor.kind === 'constraint' && anchor.constraintLabel) {
    return { kind: 'constraint', constraint: anchor.constraintLabel, end: anchor.end === 'B' ? 'B' : 'A' };
  }
  if (anchor.kind === 'label' && anchor.labelId) {
    return { kind: 'label', label: anchor.labelId };
  }
  if (!anchor.bodyLabel) return null;
  /** @type {Record<string, unknown>} */
  const out = { kind: anchor.kind, body: anchor.bodyLabel };
  if (anchor.vertex) out.vertex = anchor.vertex;
  if (Number.isFinite(anchor.angleDeg)) out.angleDeg = anchor.angleDeg;
  if (anchor.followVelocityX) out.followVelocityX = true;
  if (Number.isFinite(anchor.dir)) out.dir = anchor.dir;
  return out;
}

/** @param {import('matter-js').Body} body @param {{ x: number, y: number }} pt world px */
function _clickToBodyOffsetM(body, pt) {
  let cx = body.position.x;
  let cy = body.position.y;
  if (body._newtonType === 'wedge') {
    const c = wedgeAABBCenterWorld(body);
    cx = c.x;
    cy = c.y;
  }
  const local = worldToBodyLocal(body, pt.x, pt.y);
  return { x: pxToM(local.x), y: pxToM(local.y) };
}

/** @param {object|null} sceneDoc @param {{ x: number, y: number }} pointM */
function pointMToWorldPx(sceneDoc, pointM) {
  const ox = (sceneDoc?.metricOrigin?.x ?? 0) * PX_PER_M;
  const oy = (sceneDoc?.metricOrigin?.y ?? 0) * PX_PER_M;
  return {
    x: ox + mToPx(pointM.x ?? 0),
    y: oy + mToPx(pointM.y ?? 0),
  };
}

export class LabelManager {
  /**
   * @param {object} opts
   * @param {SVGElement} opts.layer
   * @param {SVGElement} [opts.leaderLayer]
   * @param {import('../physics/engine.js').PhysicsEngine} opts.engine
   * @param {() => { x: number, y: number }} [opts.getMetricOriginWorldPx]
   * @param {() => boolean} [opts.getSnapEnabled]
   * @param {(() => void)|null} [opts.onBeforeChange]
   * @param {((sel: object|null) => void)|null} [opts.onSelect]
   */
  constructor({
    layer,
    leaderLayer = null,
    engine,
    getMetricOriginWorldPx = () => ({ x: 0, y: 0 }),
    getSnapEnabled = () => true,
    onBeforeChange = null,
    onSelect = null,
    onPickModeChange = null,
  }) {
    this.layer = layer;
    this._leaderLayer = leaderLayer;
    this.engine = engine;
    this._getMetricOriginWorldPx = getMetricOriginWorldPx;
    this._snapEnabled = getSnapEnabled;
    this._onBeforeChange = onBeforeChange;
    this._onSelect = onSelect;
    /** @type {object[]} */
    this.items = [];
    /** @type {string|null} */
    this._selectedId = null;
    /** @type {'label'|null} */
    this._tool = null;
    /** @type {{ pointM: { x: number, y: number }, cursor: { x: number, y: number } }|null} */
    this._draft = null;
    /** @type {{ id: string, which: 'target'|'text', startPt: {x:number,y:number}, startPointM?: {x:number,y:number}, startOffsetM?: {x:number,y:number}, startPositionM?: {x:number,y:number}, historyPushed?: boolean }|null} */
    this._edit = null;
    /** @type {{ id: string, mode: 'inline'|'callout-target'|'callout-world' }|null} */
    this._pickMode = null;
    this._onPickModeChange = onPickModeChange;
    /** @type {((pt: {x:number,y:number}, snapGrid: boolean) => object)|null} */
    this._pickAnchor = null;
    /** @type {((anchor: object) => {x:number,y:number}|null)|null} */
    this._resolveAnchor = null;
    this.layer.setAttribute('pointer-events', 'none');
    this._leaderLayer?.setAttribute('pointer-events', 'none');
  }

  _clearLayers() {
    this.layer.innerHTML = '';
    if (this._leaderLayer) this._leaderLayer.innerHTML = '';
  }

  clearAll() {
    this.items = [];
    this._selectedId = null;
    this._draft = null;
    this._edit = null;
    this._pickMode = null;
    this.sync();
  }

  /** @param {'label'|null|string} tool */
  setTool(tool) {
    const next = tool === 'label' ? 'label' : null;
    if (this._tool === next) return;
    this._tool = next;
    this._draft = null;
    this._edit = null;
    this.sync();
  }

  handlesMode(mode) {
    return mode === 'label';
  }

  /**
   * Shared anchor pick / resolve (from MeasurementManager).
   * @param {{ pickAnchor?: (pt: {x:number,y:number}, snapGrid: boolean) => object, resolveAnchor?: (a: object) => {x:number,y:number}|null }} helpers
   */
  setAnchorHelpers(helpers = {}) {
    this._pickAnchor = helpers.pickAnchor ?? null;
    this._resolveAnchor = helpers.resolveAnchor ?? null;
  }

  isEditing() {
    return !!this._edit;
  }

  isPicking() {
    return !!this._pickMode;
  }

  /** Cancel attach-target pick mode (Escape). */
  cancelPick() {
    if (!this._pickMode) return false;
    this._pickMode = null;
    this._onPickModeChange?.();
    this.sync();
    return true;
  }

  /**
   * Click on the canvas to attach the label (from properties panel).
   * @param {string} id
   * @param {'inline'|'callout-target'|'callout-world'} mode
   */
  beginPick(id, mode) {
    if (!this.getById(id)) return;
    this._pickMode = { id, mode };
    this._draft = null;
    this.select(id);
    this._onPickModeChange?.();
    this.sync();
  }

  /**
   * Apply attach mode from the properties panel.
   * "Inside object" with a known host → centered inline (no leader), no pick needed.
   * @param {string} id
   * @param {'inline'|'callout-target'|'callout-world'} mode
   * @returns {'done'|'pick'} whether a canvas pick is still required
   */
  setAttachMode(id, mode) {
    const item = this.getById(id);
    if (!item) return 'done';

    if (mode === 'inline') {
      const body = this._hostBodyForItem(item);
      if (body) {
        this._onBeforeChange?.();
        this._makeInlineCentered(item, body);
        this._pickMode = null;
        this._onPickModeChange?.();
        this.sync();
        return 'done';
      }
      this.beginPick(id, 'inline');
      return 'pick';
    }

    // Callout modes: pick a new target (or keep current and wait for Pick).
    this.beginPick(id, mode);
    return 'pick';
  }

  /**
   * Place the label inside `body` at its centre — no leader / callout.
   * @param {object} item
   * @param {import('matter-js').Body} body
   */
  _makeInlineCentered(item, body) {
    item.placement = 'inline';
    item.bodyLabel = body.label ?? item.bodyLabel ?? null;
    item.bodyId = body.id;
    item.offsetM = { x: 0, y: 0 };
    delete item.targetAnchor;
    delete item.pointM;
    delete item.textOffsetM;
    delete item.positionM;
    delete item.frozenTarget;
    item.dynamic = undefined;
  }

  /**
   * Prefer body already hosting this label (inline or object callout).
   * @param {object} item
   * @returns {import('matter-js').Body|null}
   */
  _hostBodyForItem(item) {
    if (!item) return null;
    if (item.bodyId != null) {
      const byId = this.engine.bodies.find(b => b.id === item.bodyId);
      if (byId) return byId;
    }
    if (item.bodyLabel) {
      const byLabel = this.engine.bodies.find(b => b.label === item.bodyLabel);
      if (byLabel) return byLabel;
    }
    const a = item.targetAnchor;
    if (a?.bodyId != null) {
      const byId = this.engine.bodies.find(b => b.id === a.bodyId);
      if (byId) return byId;
    }
    if (a?.bodyLabel) {
      return this.engine.bodies.find(b => b.label === a.bodyLabel) ?? null;
    }
    return null;
  }

  /**
   * Body label this label is attached to (inline host or callout target body).
   * @param {object} item
   */
  hostBodyLabel(item) {
    if (!item) return null;
    if (item.placement === 'inline') return item.bodyLabel ?? null;
    const a = item.targetAnchor;
    if (a?.bodyLabel) return a.bodyLabel;
    return null;
  }

  /** Object-browser rows (host nesting + display type). */
  listForBrowser() {
    return this.items.map(l => ({
      id: l.id,
      text: l.text,
      hostBodyLabel: this.hostBodyLabel(l),
      type: l.placement === 'inline'
        ? 'inline'
        : l.targetAnchor
          ? 'callout · object'
          : l.pointM
            ? 'callout · point'
            : 'label',
    }));
  }

  /**
   * @param {string} id
   * @param {number} size px
   */
  setFontSize(id, size) {
    const item = this.getById(id);
    if (!item) return;
    const n = Number(size);
    if (!Number.isFinite(n)) return;
    item.fontSize = Math.max(8, Math.min(48, Math.round(n)));
    this.sync();
  }

  /**
   * @param {string} id
   * @param {boolean} italic
   */
  setItalic(id, italic) {
    const item = this.getById(id);
    if (!item) return;
    item.italic = !!italic;
    this.sync();
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

  /** @param {string|null} id */
  select(id) {
    if (this._selectedId === id) {
      this.sync();
      return;
    }
    this._selectedId = id;
    this._onSelect?.(id ? { type: 'label', id } : null);
    this.sync();
  }

  /** @param {string} id */
  getById(id) {
    return this.items.find(l => l.id === id) ?? null;
  }

  /**
   * Show or hide label text / leader (anchor still usable for measurements).
   * @param {string} id
   * @param {boolean} visible
   */
  setVisible(id, visible) {
    const item = this.getById(id);
    if (!item) return;
    item.visible = !!visible;
    this.sync();
  }

  cancelDraft() {
    if (!this._draft) return false;
    this._draft = null;
    this.sync();
    return true;
  }

  deleteSelected() {
    if (!this._selectedId) return false;
    this._onBeforeChange?.();
    const id = this._selectedId;
    this.items = this.items.filter(l => l.id !== id);
    this._selectedId = null;
    this._onSelect?.(null);
    this.sync();
    return true;
  }

  /**
   * @param {{ x: number, y: number }} pt world px
   * @param {{ mode?: string, ctrlKey?: boolean }} [opts]
   * @returns {boolean}
   */
  handlePointerDown(pt, opts = {}) {
    if (this._pickMode) {
      return this._applyPick(pt);
    }

    const mode = opts.mode ?? null;

    const handle = this._hitEditHandle(pt);
    if (handle) {
      this._beginEdit(handle.item, handle.which, pt);
      return true;
    }

    if (mode === 'label') {
      this._tool = 'label';
      return this._pointerDown(pt, opts);
    }

    if (mode === 'select') {
      const hit = this._hitTest(pt);
      if (hit) {
        this.select(hit.id);
        const part = this._hitPart(hit, pt);
        if (part) this._beginEdit(hit, part, pt);
        return true;
      }
    }

    return false;
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @returns {boolean}
   */
  handlePointerMove(pt) {
    if (this._edit) {
      this._applyEdit(pt);
      return true;
    }
    if (!this._draft) return false;
    this._draft.cursor = this._snapPt(pt);
    this.sync();
    return true;
  }

  handlePointerUp() {
    if (!this._edit) return false;
    this._edit = null;
    this.sync();
    return true;
  }

  /**
   * Move a callout / standalone target (used when a measurement endpoint is
   * attached to this label, or when dragging the white target handle).
   * @param {string} id
   * @param {{ x: number, y: number }} pt world px
   * @param {{ snap?: boolean }} [opts]
   */
  moveTarget(id, pt, opts = {}) {
    const item = this.getById(id);
    if (!item) return false;
    let p = { ...pt };
    if (opts.snap !== false && this._snapEnabled()) p = this._snapPt(p);

    if (item.targetAnchor && this._pickAnchor) {
      const picked = this._pickAnchor(p, opts.snap !== false && this._snapEnabled());
      if (picked.kind === 'world') {
        item.targetAnchor = null;
        item.pointM = this._worldPxToPointM({ x: picked.x, y: picked.y });
        item.dynamic = false;
        item.frozenTarget = { x: picked.x, y: picked.y };
        delete item.positionM;
      } else {
        item.targetAnchor = { ...picked };
        item.dynamic = true;
        delete item.frozenTarget;
        delete item.pointM;
      }
      this.sync();
      return true;
    }

    const pointM = this._worldPxToPointM(p);
    if (item.placement === 'callout') {
      item.pointM = pointM;
      item.dynamic = false;
      item.frozenTarget = { ...p };
    } else if (item.placement === 'standalone') {
      item.positionM = pointM;
    } else {
      return false;
    }
    this.sync();
    return true;
  }

  /**
   * Pin or unpin a callout leader tip (dynamic ↔ static world point).
   * @param {string} id
   * @param {boolean} dynamic
   */
  setDynamic(id, dynamic) {
    const item = this.getById(id);
    if (!item || item.placement !== 'callout') return;
    if (dynamic) {
      item.dynamic = true;
      delete item.frozenTarget;
      if (!item.targetAnchor && !item.pointM) item.dynamic = false;
    } else {
      const pos = this._resolveTarget(item);
      if (!pos) return;
      item.dynamic = false;
      item.frozenTarget = { x: pos.x, y: pos.y };
      if (item.targetAnchor) {
        item.pointM = this._worldPxToPointM(pos);
        item.targetAnchor = null;
      }
    }
    this.sync();
  }

  /**
   * @param {string} id
   * @param {string} text
   */
  setText(id, text) {
    const item = this.getById(id);
    if (!item) return;
    const next = String(text ?? '').trim();
    if (!next) return;
    item.text = next;
    this.sync();
  }

  /**
   * Keep the text where it is after retargeting / placement change.
   * @param {object} item
   */
  _preserveTextOffsetFrom(item, targetPx) {
    const textPos = this._resolveTextPos(item);
    if (!textPos || !targetPx) return;
    item.textOffsetM = {
      x: pxToM(textPos.x - targetPx.x),
      y: -pxToM(textPos.y - targetPx.y),
    };
  }

  /** @param {{ x: number, y: number }} pt */
  _applyPick(pt) {
    const pick = this._pickMode;
    if (!pick || !this._pickAnchor) return false;
    const item = this.getById(pick.id);
    if (!item) {
      this._pickMode = null;
      this._onPickModeChange?.();
      return false;
    }

    const snapped = this._snapPt(pt);
    const picked = this._pickAnchor(snapped, this._snapEnabled());
    this._onBeforeChange?.();

    if (pick.mode === 'inline') {
      if (picked.kind === 'world') return false;
      const body = picked.bodyId != null
        ? this.engine.bodies.find(b => b.id === picked.bodyId)
        : this.engine.bodies.find(b => b.label === picked.bodyLabel);
      if (!body) return false;
      this._makeInlineCentered(item, body);
    } else if (pick.mode === 'callout-target') {
      if (picked.kind === 'world') return false;
      item.placement = 'callout';
      item.targetAnchor = { ...picked };
      item.dynamic = true;
      delete item.bodyLabel;
      delete item.bodyId;
      delete item.offsetM;
      delete item.pointM;
      delete item.positionM;
      delete item.frozenTarget;
      const targetPx = this._resolveAnchor?.(picked);
      if (targetPx) this._preserveTextOffsetFrom(item, targetPx);
      if (!item.textOffsetM) item.textOffsetM = { x: 0, y: 0.15 };
    } else {
      const wx = picked.kind === 'world' ? picked.x : snapped.x;
      const wy = picked.kind === 'world' ? picked.y : snapped.y;
      item.placement = 'callout';
      item.pointM = this._worldPxToPointM({ x: wx, y: wy });
      item.dynamic = false;
      item.frozenTarget = { x: wx, y: wy };
      delete item.targetAnchor;
      delete item.bodyLabel;
      delete item.bodyId;
      delete item.offsetM;
      delete item.positionM;
      const targetPx = { x: wx, y: wy };
      this._preserveTextOffsetFrom(item, targetPx);
      if (!item.textOffsetM) item.textOffsetM = { x: 0, y: 0.15 };
    }

    this._pickMode = null;
    this._onPickModeChange?.();
    this.sync();
    return true;
  }

  /**
   * @param {object} item
   * @param {'target'|'text'} which
   * @param {{ x: number, y: number }} pt
   */
  _beginEdit(item, which, pt) {
    this._edit = {
      id: item.id,
      which,
      startPt: { x: pt.x, y: pt.y },
      startPointM: item.pointM ? { ...item.pointM } : undefined,
      startOffsetM: (item.placement === 'callout' || item.placement === 'standalone')
        ? { ...(item.textOffsetM ?? { x: 0, y: 0 }) }
        : { ...(item.offsetM ?? { x: 0, y: 0 }) },
      startPositionM: item.positionM ? { ...item.positionM } : undefined,
      historyPushed: false,
    };
  }

  /** @param {{ x: number, y: number }} pt */
  _applyEdit(pt) {
    if (!this._edit) return;
    const item = this.getById(this._edit.id);
    if (!item) {
      this._edit = null;
      return;
    }

    this._ensureEditHistory();

    if (this._edit.which === 'target') {
      this.moveTarget(item.id, pt, { snap: this._snapEnabled() });
      return;
    }

    // Text / inline offset drag: display metres (+y up).
    const start = this._edit.startPt;
    const dxM = pxToM(pt.x - start.x);
    const dyM = -pxToM(pt.y - start.y);
    const base = this._edit.startOffsetM ?? { x: 0, y: 0 };

    if (item.placement === 'callout' || item.placement === 'standalone') {
      item.textOffsetM = { x: base.x + dxM, y: base.y + dyM };
    } else if (item.placement === 'inline') {
      item.offsetM = { x: base.x + dxM, y: base.y + dyM };
    }
    this.sync();
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @param {{ altKey?: boolean }} [opts]
   * @returns {boolean}
   */
  _pointerDown(pt, opts = {}) {
    if (!this._tool) return false;

    const hit = this._hitTest(pt);
    if (hit && !this._draft) {
      this.select(hit.id);
      const part = this._hitPart(hit, pt);
      if (part) this._beginEdit(hit, part, pt);
      return true;
    }

    const snapped = this._snapPt(pt);
    const snapGrid = this._snapEnabled();
    const picked = this._pickAnchor?.(snapped, snapGrid)
      ?? { kind: 'world', x: snapped.x, y: snapped.y };

    // Alt+click on a body → inline label at the click (text inside/on the object).
    if (opts.altKey && picked.kind !== 'world' && (picked.bodyLabel || picked.bodyId != null)) {
      const body = picked.bodyId != null
        ? this.engine.bodies.find(b => b.id === picked.bodyId)
        : this.engine.bodies.find(b => b.label === picked.bodyLabel);
      if (body) {
        this._onBeforeChange?.();
        const item = {
          id: `lbl${_nextId++}`,
          text: 'm',
          placement: 'inline',
          bodyLabel: body.label ?? picked.bodyLabel,
          bodyId: body.id,
          offsetM: _clickToBodyOffsetM(body, snapped),
          italic: true,
        };
        this.items.push(item);
        this.select(item.id);
        return true;
      }
    }

    if (!this._draft) {
      /** @type {object} */
      const draft = { cursor: { ...snapped } };
      if (picked.kind === 'world') {
        draft.pointM = this._worldPxToPointM({ x: picked.x, y: picked.y });
      } else {
        draft.targetAnchor = { ...picked };
        draft.dynamic = true;
      }
      this._draft = draft;
      this.sync();
      return true;
    }

    const textM = this._worldPxToPointM(snapped);
    const draftTarget = this._draftTargetPx(this._draft);
    const baseM = draftTarget
      ? this._worldPxToPointM(draftTarget)
      : this._draft.pointM;
    const offsetM = {
      x: textM.x - (baseM?.x ?? textM.x),
      y: textM.y - (baseM?.y ?? textM.y),
    };

    this._onBeforeChange?.();
    /** @type {object} */
    const item = {
      id: `lbl${_nextId++}`,
      text: 'x',
      placement: 'callout',
      textOffsetM: offsetM,
      italic: true,
    };
    if (this._draft.targetAnchor) {
      item.targetAnchor = { ...this._draft.targetAnchor };
      item.dynamic = this._draft.dynamic !== false;
    } else if (this._draft.pointM) {
      item.pointM = { ...this._draft.pointM };
      item.dynamic = false;
    }
    this.items.push(item);
    this._draft = null;
    this.select(item.id);
    return true;
  }

  /** @param {object} draft */
  _draftTargetPx(draft) {
    if (draft.targetAnchor) {
      return this._resolveAnchor?.(draft.targetAnchor)
        ?? (draft.targetAnchor.kind === 'world'
          ? { x: draft.targetAnchor.x, y: draft.targetAnchor.y }
          : null);
    }
    if (draft.pointM) {
      const origin = this._getMetricOriginWorldPx();
      return {
        x: origin.x + mToPx(draft.pointM.x),
        y: origin.y + mToPx(draft.pointM.y),
      };
    }
    return null;
  }

  /** @param {{ x: number, y: number }} pt */
  _snapPt(pt) {
    if (!this._snapEnabled()) return { ...pt };
    return {
      x: snapWorldCoord(pt.x),
      y: snapWorldCoord(pt.y),
    };
  }

  /** @param {{ x: number, y: number }} pt world px */
  _worldPxToPointM(pt) {
    const { xm, ym } = worldPxToDisplayedM(pt.x, pt.y);
    return { x: xm, y: ym };
  }

  /**
   * @param {import('../scene/schema.js').SceneDocument|object} doc
   */
  loadFromScene(doc) {
    this.items = [];
    this._draft = null;
    const list = doc?.labels;
    if (!Array.isArray(list) || !list.length) {
      this.sync();
      return;
    }

    const labelToId = new Map();
    for (const b of this.engine.bodies) {
      if (typeof b.label === 'string' && b.label) labelToId.set(b.label, b.id);
    }

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      // Invisible anchors may omit text; they still resolve for measurements.
      if (!text && raw.visible !== false) continue;

      /** @type {object} */
      const item = {
        id: typeof raw.id === 'string' ? raw.id : `lbl${_nextId++}`,
        text: text || '·',
        italic: raw.italic === true,
        visible: raw.visible !== false,
        fontSize: Number.isFinite(raw.fontSize) ? raw.fontSize : 13,
      };

      const offsetM = {
        x: Number(raw.offset?.x) || 0,
        y: Number(raw.offset?.y) || 0,
      };

      if (raw.point && typeof raw.point === 'object') {
        item.placement = 'callout';
        item.pointM = {
          x: Number(raw.point.x) || 0,
          y: Number(raw.point.y) || 0,
        };
        item.textOffsetM = offsetM;
        item.dynamic = false;
        if (raw.frozen && typeof raw.frozen === 'object') {
          const fx = Number(raw.frozen.x);
          const fy = Number(raw.frozen.y);
          if (Number.isFinite(fx) && Number.isFinite(fy)) {
            item.frozenTarget = { x: fx, y: fy };
          }
        }
      } else if (raw.target && typeof raw.target === 'object') {
        const targetAnchor = _mapSceneAnchor(raw.target, labelToId);
        if (!targetAnchor) continue;
        item.placement = 'callout';
        item.targetAnchor = targetAnchor;
        item.textOffsetM = offsetM;
        item.dynamic = raw.dynamic !== false;
        if (raw.dynamic === false && raw.frozen && typeof raw.frozen === 'object') {
          const fx = Number(raw.frozen.x);
          const fy = Number(raw.frozen.y);
          if (Number.isFinite(fx) && Number.isFinite(fy)) {
            item.frozenTarget = { x: fx, y: fy };
          }
        }
      } else if (typeof raw.body === 'string' && raw.body) {
        item.placement = 'inline';
        item.bodyLabel = raw.body;
        item.bodyId = labelToId.get(raw.body) ?? null;
        item.offsetM = offsetM;
      } else if (raw.position && typeof raw.position === 'object') {
        item.placement = 'standalone';
        item.positionM = {
          x: Number(raw.position.x) || 0,
          y: Number(raw.position.y) || 0,
        };
        item.textOffsetM = offsetM;
      } else {
        continue;
      }
      this.items.push(item);
    }
    this.sync();
  }

  /** @returns {object[]} */
  toScene() {
    const out = [];
    for (const l of this.items) {
      /** @type {Record<string, unknown>} */
      const entry = { id: l.id, text: l.text };
      if (l.italic) entry.italic = true;
      if (l.visible === false) entry.visible = false;
      if (l.fontSize != null && l.fontSize !== 13) entry.fontSize = l.fontSize;

      if (l.placement === 'callout') {
        if (l.targetAnchor) {
          const target = _anchorToScene(l.targetAnchor);
          if (target) entry.target = target;
          if (l.dynamic === false) entry.dynamic = false;
          if (l.frozenTarget) {
            entry.frozen = { x: l.frozenTarget.x, y: l.frozenTarget.y };
          }
        } else if (l.pointM) {
          entry.point = { x: l.pointM.x, y: l.pointM.y };
          entry.dynamic = l.dynamic === false ? false : undefined;
          if (l.frozenTarget) {
            entry.frozen = { x: l.frozenTarget.x, y: l.frozenTarget.y };
          }
        }
        if (l.textOffsetM && (l.textOffsetM.x || l.textOffsetM.y)) {
          entry.offset = { x: l.textOffsetM.x, y: l.textOffsetM.y };
        }
      } else if (l.placement === 'inline' && l.bodyLabel) {
        entry.body = l.bodyLabel;
        if (l.offsetM && (l.offsetM.x || l.offsetM.y)) {
          entry.offset = { x: l.offsetM.x, y: l.offsetM.y };
        }
      } else if (l.placement === 'standalone' && l.positionM) {
        entry.position = { x: l.positionM.x, y: l.positionM.y };
        if (l.textOffsetM && (l.textOffsetM.x || l.textOffsetM.y)) {
          entry.offset = { x: l.textOffsetM.x, y: l.textOffsetM.y };
        }
      } else {
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Anchor / measurement target (callout point, body attach, or standalone position).
   * @param {object|string} itemOrId
   * @returns {{ x: number, y: number }|null}
   */
  resolveTarget(itemOrId) {
    const item = typeof itemOrId === 'string' ? this.getById(itemOrId) : itemOrId;
    if (!item) return null;
    return this._resolveTarget(item);
  }

  /** @deprecated use resolveTarget: alias for measurement hooks */
  resolvePosition(itemOrId) {
    return this.resolveTarget(itemOrId);
  }

  /**
   * @param {{ label?: string, labelId?: string }} anchor
   * @returns {{ x: number, y: number }|null}
   */
  resolveAnchor(anchor) {
    const id = anchor.labelId ?? anchor.label;
    if (typeof id !== 'string' || !id) return null;
    return this.resolveTarget(id);
  }

  /** @param {object} item */
  _bodyAttachPx(item) {
    const body = item.bodyId != null
      ? this.engine.bodies.find(b => b.id === item.bodyId)
      : this.engine.bodies.find(b => b.label === item.bodyLabel);
    if (!body) return null;
    if (item.bodyLabel && body.label) item.bodyId = body.id;
    let cx = body.position.x;
    let cy = body.position.y;
    if (body._newtonType === 'wedge') {
      const c = wedgeAABBCenterWorld(body);
      cx = c.x;
      cy = c.y;
    }
    const ox = mToPx(item.offsetM?.x ?? 0);
    const oy = mToPx(item.offsetM?.y ?? 0);
    const ang = body.angle ?? 0;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return {
      x: cx + c * ox - s * oy,
      y: cy + s * ox + c * oy,
    };
  }

  /** @param {object} item */
  _resolveTarget(item) {
    if (item.placement === 'inline') return this._bodyAttachPx(item);

    if (item.targetAnchor) {
      if (item.dynamic === false && item.frozenTarget) {
        return { x: item.frozenTarget.x, y: item.frozenTarget.y };
      }
      return this._resolveAnchor?.(item.targetAnchor) ?? null;
    }

    if (item.placement === 'callout') {
      if (item.dynamic === false && item.frozenTarget) {
        return { x: item.frozenTarget.x, y: item.frozenTarget.y };
      }
      if (item.pointM) {
        const origin = this._getMetricOriginWorldPx();
        return {
          x: origin.x + mToPx(item.pointM.x),
          y: origin.y + mToPx(item.pointM.y),
        };
      }
    }
    if (item.placement === 'standalone' && item.positionM) {
      const origin = this._getMetricOriginWorldPx();
      return {
        x: origin.x + mToPx(item.positionM.x),
        y: origin.y + mToPx(item.positionM.y),
      };
    }
    return null;
  }

  /** @param {object} item */
  _resolveTextPos(item) {
    // Callouts (object or world) and standalone labels: text = target + textOffsetM.
    // Object-target callouts used to skip the offset, so dragging text had no effect.
    if (item.placement === 'callout' || item.placement === 'standalone') {
      const target = this._resolveTarget(item);
      if (!target) return null;
      return applyDisplayOffsetM(target, item.textOffsetM ?? { x: 0, y: 0 });
    }
    return this._resolveTarget(item);
  }

  /**
   * @param {{ label?: string }} anchor
   * @param {Map<string, import('./measure-eval.js').BodyPose>} poses
   * @param {object|null} sceneDoc
   */
  static resolveFromScene(anchor, poses, sceneDoc) {
    const id = anchor?.label;
    if (typeof id !== 'string' || !id || !sceneDoc?.labels) return null;
    const def = sceneDoc.labels.find(l => l?.id === id);
    if (!def) return null;

    if (def.target && typeof def.target === 'object') {
      if (def.dynamic === false && def.frozen && typeof def.frozen === 'object') {
        const fx = Number(def.frozen.x);
        const fy = Number(def.frozen.y);
        if (Number.isFinite(fx) && Number.isFinite(fy)) return { x: fx, y: fy };
      }
      return resolveAnchorFromScene(def.target, poses, { sceneDoc });
    }

    if (def.point && typeof def.point === 'object') {
      if (def.dynamic === false && def.frozen && typeof def.frozen === 'object') {
        const fx = Number(def.frozen.x);
        const fy = Number(def.frozen.y);
        if (Number.isFinite(fx) && Number.isFinite(fy)) return { x: fx, y: fy };
      }
      return pointMToWorldPx(sceneDoc, def.point);
    }

    if (typeof def.body === 'string' && def.body) {
      const pose = poses.get(def.body);
      if (!pose) return null;
      const ox = mToPx(def.offset?.x ?? 0);
      const oy = mToPx(def.offset?.y ?? 0);
      const ang = pose.angle ?? 0;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      return {
        x: pose.x + c * ox - s * oy,
        y: pose.y + s * ox + c * oy,
      };
    }

    if (def.position && typeof def.position === 'object') {
      return pointMToWorldPx(sceneDoc, def.position);
    }
    return null;
  }

  /** @param {{ x: number, y: number }} pt */
  _hitTest(pt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      const textPos = this._resolveTextPos(item);
      if (!textPos) continue;
      if (dist(pt, textPos) <= HIT_PX + 4) return item;
      if (item.placement === 'callout' || item.placement === 'standalone') {
        const target = this._resolveTarget(item);
        if (target && dist(pt, target) <= HANDLE_HIT_PX) return item;
        if (target && distToSeg(pt, textPos, target) <= HIT_PX) return item;
      }
    }
    return null;
  }

  /**
   * @param {{ x: number, y: number }} pt
   * @returns {{ item: object, which: 'target'|'text' }|null}
   */
  _hitEditHandle(pt) {
    if (!this._selectedId) return null;
    const item = this.getById(this._selectedId);
    if (!item) return null;
    const which = this._hitPart(item, pt);
    return which ? { item, which } : null;
  }

  /**
   * @param {object} item
   * @param {{ x: number, y: number }} pt
   * @returns {'target'|'text'|null}
   */
  _hitPart(item, pt) {
    if (item.placement === 'callout' || item.placement === 'standalone') {
      const target = this._resolveTarget(item);
      if (target && dist(pt, target) <= HANDLE_HIT_PX) return 'target';
    }
    const textPos = this._resolveTextPos(item);
    if (textPos && dist(pt, textPos) <= HIT_PX + 6) return 'text';
    return null;
  }

  /**
   * Dotted leader from the label text to the referenced world point.
   * Drawn on the label layer (above bodies) so ground hatch does not hide it.
   * @param {SVGElement} lineParent
   * @param {SVGElement|null} markParent
   * @param {{ x: number, y: number }} textPos
   * @param {{ x: number, y: number }} target
   * @param {string} ink
   * @param {boolean} selected
   */
  _appendPointLeader(lineParent, markParent, textPos, target, ink, selected) {
    if (!target) return;
    const dx = textPos.x - target.x;
    const dy = textPos.y - target.y;
    const len = Math.hypot(dx, dy);
    if (len > 1.5) {
      // Stop short of the glyph so the line reads as a pointer to the mark.
      const inset = Math.min(12, len * 0.4);
      const x2 = textPos.x - (dx / len) * inset;
      const y2 = textPos.y - (dy / len) * inset;
      lineParent.appendChild(el('line', {
        x1: target.x,
        y1: target.y,
        x2,
        y2,
        stroke: ink,
        'stroke-width': 1.25,
        'stroke-dasharray': '3 3',
        opacity: 0.85,
        'vector-effect': 'non-scaling-stroke',
      }));
    }
    // White drag handle only while selected.
    if (selected && markParent) {
      markParent.appendChild(el('circle', {
        cx: target.x,
        cy: target.y,
        r: 2.2,
        fill: '#fff',
        stroke: ink,
        'stroke-width': 1,
        'vector-effect': 'non-scaling-stroke',
      }));
    }
  }

  /**
   * @param {SVGElement} g
   * @param {{ x: number, y: number }} textPos
   * @param {object} item
   * @param {boolean} draft
   */
  _appendLabelText(g, textPos, item, draft = false) {
    const t = el('text', {
      x: textPos.x,
      y: textPos.y,
      fill: draft ? (COLORS.inkLight ?? COLORS.ink) : COLORS.ink,
      'font-size': item.fontSize ?? 13,
      'font-family': FONT_DIAGRAM,
      'font-style': item.italic ? 'italic' : null,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      opacity: draft ? 0.65 : null,
      'pointer-events': 'none',
    });
    setSvgMathLabel(t, item.text);
    g.appendChild(t);
  }

  sync() {
    this._clearLayers();
    const ink = COLORS.inkLight ?? COLORS.ink;

    for (const item of this.items) {
      const textPos = this._resolveTextPos(item);
      if (!textPos) continue;
      const selected = this._selectedId === item.id;
      const showChrome = item.visible !== false;

      const g = el('g', {
        class: `scene-label scene-label-${item.placement}${selected ? ' selected' : ''}${showChrome ? '' : ' scene-label-hidden'}`,
      });

      if (item.placement === 'callout' || item.placement === 'standalone') {
        const target = this._resolveTarget(item);
        if (showChrome) {
          // Keep leaders with the label (above bodies). The shared leaderLayer paints
          // under ground, which hid pointers like x₀ below the floor.
          this._appendPointLeader(g, g, textPos, target, ink, selected);
        } else if (selected && target) {
          // Invisible anchors still show a handle when selected for editing.
          g.appendChild(el('circle', {
            cx: target.x,
            cy: target.y,
            r: 2.2,
            fill: '#fff',
            stroke: ink,
            'stroke-width': 1,
            'vector-effect': 'non-scaling-stroke',
          }));
        }
      }

      if (showChrome) this._appendLabelText(g, textPos, item, false);
      if (showChrome || selected) this.layer.appendChild(g);
    }

    if (this._pickMode) {
      const g = el('g', { class: 'scene-label scene-label-pick-hint' });
      const t = el('text', {
        x: 12,
        y: 22,
        fill: COLORS.inkLight ?? COLORS.ink,
        'font-size': 12,
        'font-family': FONT_DIAGRAM,
        opacity: 0.85,
      });
      const hint = this._pickMode.mode === 'inline'
        ? 'Click a body to place the label inside it'
        : this._pickMode.mode === 'callout-target'
          ? 'Click an object to point the leader at'
          : 'Click a world point for the leader target';
      t.textContent = `${hint} (Esc to cancel)`;
      g.appendChild(t);
      this.layer.appendChild(g);
    }

    if (this._draft) {
      const target = this._draftTargetPx(this._draft);
      const textPos = this._draft.cursor;
      const g = el('g', { class: 'scene-label scene-label-callout draft' });
      if (target) this._appendPointLeader(g, g, textPos, target, ink, false);
      this._appendLabelText(g, textPos, { text: 'x', italic: true }, true);
      this.layer.appendChild(g);
    }
  }
}
