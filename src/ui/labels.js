/**
 * Text labels: inline on bodies or callouts with a dotted leader to a point.
 *
 * Scene JSON:
 *   Inline:  { "text": "m", "body": "mass", "offset": { "x": 0, "y": 0 } }
 *   Callout: { "text": "x_0", "point": { "x": 0, "y": -0.1 }, "offset": { "x": 0, "y": -0.3 } }
 *    : text sits at point + offset (display metres, +y up), dotted line to point.
 *   Standalone: { "text": "A", "position": { "x": 0, "y": 0 }, "offset": { ... } }
 *    : like a callout anchored at `position`, offset draws a leader to that point.
 *
 * Selected callouts expose a white target handle (drag to retarget) and a
 * draggable text position. Inline labels drag their body-relative offset.
 */

import { PX_PER_M, mToPx, pxToM } from '../units.js';
import { COLORS, FONT_DIAGRAM } from '../theme.js';
import { setSvgMathLabel } from '../math-text.js';
import { wedgeAABBCenterWorld } from '../physics/bodies.js';
import { snapWorldCoord } from '../grid.js';
import { worldPxToDisplayedM } from '../world-origin.js';

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
    const mode = opts.mode ?? null;

    const handle = this._hitEditHandle(pt);
    if (handle) {
      this._beginEdit(handle.item, handle.which, pt);
      return true;
    }

    if (mode === 'label') {
      this._tool = 'label';
      return this._pointerDown(pt);
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
   * attached to this label).
   * @param {string} id
   * @param {{ x: number, y: number }} pt world px
   * @param {{ snap?: boolean }} [opts]
   */
  moveTarget(id, pt, opts = {}) {
    const item = this.getById(id);
    if (!item) return false;
    let p = { ...pt };
    if (opts.snap !== false && this._snapEnabled()) p = this._snapPt(p);
    const pointM = this._worldPxToPointM(p);
    if (item.placement === 'callout') {
      item.pointM = pointM;
    } else if (item.placement === 'standalone') {
      item.positionM = pointM;
    } else {
      return false;
    }
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
   * @returns {boolean}
   */
  _pointerDown(pt) {
    if (!this._tool) return false;

    const hit = this._hitTest(pt);
    if (hit && !this._draft) {
      this.select(hit.id);
      const part = this._hitPart(hit, pt);
      if (part) this._beginEdit(hit, part, pt);
      return true;
    }

    const snapped = this._snapPt(pt);

    if (!this._draft) {
      this._draft = {
        pointM: this._worldPxToPointM(snapped),
        cursor: { ...snapped },
      };
      this.sync();
      return true;
    }

    const textM = this._worldPxToPointM(snapped);
    const offsetM = {
      x: textM.x - this._draft.pointM.x,
      y: textM.y - this._draft.pointM.y,
    };

    this._onBeforeChange?.();
    const item = {
      id: `lbl${_nextId++}`,
      text: 'x',
      placement: 'callout',
      pointM: { ...this._draft.pointM },
      textOffsetM: offsetM,
    };
    this.items.push(item);
    this._draft = null;
    this.select(item.id);
    return true;
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
      if (!text) continue;

      /** @type {object} */
      const item = {
        id: typeof raw.id === 'string' ? raw.id : `lbl${_nextId++}`,
        text,
        italic: raw.italic === true,
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
      if (l.fontSize != null && l.fontSize !== 13) entry.fontSize = l.fontSize;

      if (l.placement === 'callout' && l.pointM) {
        entry.point = { x: l.pointM.x, y: l.pointM.y };
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
    if (item.placement === 'callout' && item.pointM) {
      const origin = this._getMetricOriginWorldPx();
      return {
        x: origin.x + mToPx(item.pointM.x),
        y: origin.y + mToPx(item.pointM.y),
      };
    }
    if (item.placement === 'inline') return this._bodyAttachPx(item);
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
    if (item.placement === 'callout' && item.pointM) {
      const target = this._resolveTarget(item);
      if (!target) return null;
      return applyDisplayOffsetM(target, item.textOffsetM ?? { x: 0, y: 0 });
    }
    if (item.placement === 'standalone' && item.positionM) {
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

    if (def.point && typeof def.point === 'object') {
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

      const g = el('g', {
        class: `scene-label scene-label-${item.placement}${selected ? ' selected' : ''}`,
      });

      if (item.placement === 'callout' || item.placement === 'standalone') {
        const target = this._resolveTarget(item);
        // Keep leaders with the label (above bodies). The shared leaderLayer paints
        // under ground, which hid pointers like x₀ below the floor.
        this._appendPointLeader(g, g, textPos, target, ink, selected);
      }

      this._appendLabelText(g, textPos, item, false);
      this.layer.appendChild(g);
    }

    if (this._draft) {
      const origin = this._getMetricOriginWorldPx();
      const target = {
        x: origin.x + mToPx(this._draft.pointM.x),
        y: origin.y + mToPx(this._draft.pointM.y),
      };
      const textPos = this._draft.cursor;
      const g = el('g', { class: 'scene-label scene-label-callout draft' });
      this._appendPointLeader(g, g, textPos, target, ink, false);
      this._appendLabelText(g, textPos, { text: 'x', italic: true }, true);
      this.layer.appendChild(g);
    }
  }
}
