/**
 * Scale tool handles: box side lengths, circle radius, wedge base / height.
 *
 * Handles are rebuilt only when the selected body changes (build key), then
 * repositioned every render frame. Drags are tracked with capture-phase
 * document listeners so the pointer can outrun the handle dot.
 *
 * Wedge drags support two extras: Ctrl snaps the *opposite* interior angle to
 * 5° (drawing a textbook arc + degree mark), and dragging past the pinned edge
 * inverts the wedge via `_wedgeFlipX` / `_wedgeFlipY`.
 */

import {
  scaleBoxTo, scaleCircleTo, scaleWedgeTo, wedgeScaleHandleLocal,
  clampWedgeFootAngle, wedgeAABBCenterWorld, worldToWedgeAABBLocal,
  wedgeTriangleWorldVerts, wedgeFlipFlags,
} from '../../physics/bodies.js';
import { worldToBodyLocal } from '../../physics/layout-anchors.js';
import { snapWorldCoord, snapAngleRad, snapBodySizePx } from '../../grid.js';
import { pxToM } from '../../units.js';
import { FONT_DIAGRAM, COLORS } from '../../theme.js';
import {
  svgEl, handleDot, handleGroup, DOT_RADIUS, DOT_STROKE_WIDTH, HANDLE_BLUE, SCALE_HANDLE_ATTR,
} from './chrome.js';

/** Minimum half-extent while dragging (world px). */
const MIN_HALF_PX = 4;

function boxHandleWorld(body, edge) {
  const w = body._width ?? 40;
  const h = body._height ?? 40;
  let lx = 0;
  let ly = 0;
  if (edge === 'R') lx = w / 2;
  else if (edge === 'L') lx = -w / 2;
  else if (edge === 'T') ly = -h / 2;
  else if (edge === 'B') ly = h / 2;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: body.position.x + c * lx - s * ly,
    y: body.position.y + s * lx + c * ly,
  };
}

function circleHandleWorld(body) {
  const r = body._radius ?? body.circleRadius ?? 20;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: body.position.x + c * r,
    y: body.position.y + s * r,
  };
}

function wedgeHandleWorld(body, edge) {
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const { flipX, flipY } = wedgeFlipFlags(body);
  const loc = wedgeScaleHandleLocal(W, H, edge, undefined, flipX, flipY);
  const aabb = wedgeAABBCenterWorld(body);
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: aabb.x + c * loc.x - s * loc.y,
    y: aabb.y + s * loc.x + c * loc.y,
  };
}

/** Resize cursor for a wedge handle from the growth axis in world space. */
function wedgeHandleCursor(body, edge) {
  const { flipX, flipY } = wedgeFlipFlags(body);
  // W grows along local ±x (toward the foot); H along local ±y (toward the apex).
  let axis = body.angle;
  if (edge === 'W') {
    if (flipX) axis += Math.PI;
  } else {
    axis += flipY ? Math.PI / 2 : -Math.PI / 2;
  }
  const ux = Math.cos(axis);
  const uy = Math.sin(axis);
  return Math.abs(ux) >= Math.abs(uy) ? 'ew-resize' : 'ns-resize';
}

function handleWorldForBody(body, kind, edge) {
  if (kind === 'circle') return circleHandleWorld(body);
  if (kind === 'wedge') return wedgeHandleWorld(body, edge);
  return boxHandleWorld(body, edge);
}

export class ScaleHandles {
  /** @param {import('./editor-context.js').EditorContext} context */

  constructor(context) {
    this.context = context;
    /** @type {SVGGElement|null} */
    this._group = null;
    /** @type {{ kind: string, bodyId: number, edge: string }|null} */
    this._drag = null;
    /** @type {SVGGElement|null} */
    this._ghost = null;
    this._buildKey = '';

    // Bound once: add/removeEventListener must see the same reference.
    this._onDocMove = this._onDocMove.bind(this);
    this._onDocUp = this._onDocUp.bind(this);
    this._onHandleDown = this._onHandleDown.bind(this);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Called every render frame. */
  sync() {
    const { context } = this;
    if (!context.canEdit() || context.getToolMode() !== 'scale') {
      if (!this._drag) this.reset();
      return;
    }
    if (this._drag) {
      this._updatePositions();
      return;
    }

    const selection = context.getSelection();
    let key = '';
    if (selection?.type === 'body') {
      const b = context.engine.bodies.find(x => x.id === selection.id);
      if (b?._newtonType === 'box') key = `box:${b.id}`;
      else if (b?._newtonType === 'point-mass') key = `circle:${b.id}`;
      else if (b?._newtonType === 'wedge') key = `wedge:${b.id}`;
    }

    if (!key) {
      this.reset();
      return;
    }

    if (key !== this._buildKey) {
      this._clearDom();
      this._buildKey = key;
      this._build(key);
    }
    this._updatePositions();
  }

  /** Drop handle DOM and invalidate the build key (selection / scene change). */
  reset() {
    this._clearDom();
    this._buildKey = '';
  }

  /** Remove listeners and DOM. */
  destroy() {
    this._unbindDrag();
    this.reset();
  }

  _clearDom() {
    if (this._group) { this._group.remove(); this._group = null; }
    if (this._ghost) { this._ghost.remove(); this._ghost = null; }
    this._drag = null;
  }

  // ─── Build / position ──────────────────────────────────────────

  _build(key) {
    const [kind, idStr] = key.split(':');
    const id = parseInt(idStr, 10);
    const body = this.context.engine.bodies.find(b => b.id === id);
    if (!body) return;

    const group = handleGroup('scale-edit-handles');
    this.context.layer.appendChild(group);
    this._group = group;

    const mkHandle = (edge, cursor) => {
      group.appendChild(handleDot({
        r: DOT_RADIUS.scale,
        strokeWidth: DOT_STROKE_WIDTH.link,
        cursor,
        color: HANDLE_BLUE,
        data: { 'scale-handle': '1', 'scale-kind': kind, bid: id, edge },
        onPointerDown: this._onHandleDown,
      }));
    };

    if (kind === 'box') {
      mkHandle('R', 'ew-resize');
      mkHandle('L', 'ew-resize');
      mkHandle('T', 'ns-resize');
      mkHandle('B', 'ns-resize');
    } else if (kind === 'wedge') {
      mkHandle('W', wedgeHandleCursor(body, 'W'));
      mkHandle('H', wedgeHandleCursor(body, 'H'));
    } else {
      mkHandle('R', 'ew-resize');
    }
  }

  _updatePositions() {
    const selection = this.context.getSelection();
    if (!this._group || !selection) return;
    const b = this.context.engine.bodies.find(x => x.id === selection.id);
    if (!b) return;
    for (const h of this._group.querySelectorAll(`[${SCALE_HANDLE_ATTR}]`)) {
      const edge = h.getAttribute('data-edge');
      const kind = h.getAttribute('data-scale-kind');
      const p = handleWorldForBody(b, kind, edge);
      h.setAttribute('cx', String(p.x));
      h.setAttribute('cy', String(p.y));
      if (kind === 'wedge') {
        h.setAttribute('cursor', wedgeHandleCursor(b, edge));
      }
    }
  }

  // ─── Drag ──────────────────────────────────────────────────────

  _onHandleDown(e) {
    if (!this.context.canEdit()) return;
    e.stopPropagation();
    e.preventDefault();
    const bodyId = parseInt(e.currentTarget.getAttribute('data-bid'), 10);
    const kind = e.currentTarget.getAttribute('data-scale-kind');
    const edge = e.currentTarget.getAttribute('data-edge');
    const body = this.context.engine.bodies.find(b => b.id === bodyId);
    if (!body) return;
    this.context.pushHistory();
    this._drag = { kind, bodyId, edge };

    this._ghost = svgEl('g', { 'pointer-events': 'none' });
    this.context.layer.appendChild(this._ghost);

    this._onDocMove(e);
    document.addEventListener('pointermove', this._onDocMove, true);
    document.addEventListener('pointerup', this._onDocUp, true);
  }

  _unbindDrag() {
    document.removeEventListener('pointermove', this._onDocMove, true);
    document.removeEventListener('pointerup', this._onDocUp, true);
  }

  _onDocMove(e) {
    if (!this._drag) return;
    const { context } = this;
    const body = context.engine.bodies.find(b => b.id === this._drag.bodyId);
    if (!body) return;
    const pt = context.clientToWorld(e.clientX, e.clientY);
    const loc = worldToBodyLocal(body, pt.x, pt.y);
    const snap = context.getSnapEnabled();
    const minHalf = MIN_HALF_PX;
    const ctrl = e.ctrlKey;

    if (this._drag.kind === 'box') {
      let nw = body._width ?? 40;
      let nh = body._height ?? 40;
      const edge = this._drag.edge;
      if (edge === 'R') nw = 2 * Math.max(minHalf, loc.x);
      else if (edge === 'L') nw = 2 * Math.max(minHalf, -loc.x);
      else if (edge === 'T') nh = 2 * Math.max(minHalf, -loc.y);
      else if (edge === 'B') nh = 2 * Math.max(minHalf, loc.y);
      if (snap) {
        nw = snapBodySizePx(nw, true);
        nh = snapBodySizePx(nh, true);
      }
      scaleBoxTo(body, nw, nh);
      if (this._ghost) {
        this._ghostSizeLabel(body,
          `${pxToM(body._width).toFixed(2)} × ${pxToM(body._height).toFixed(2)} m`);
      }
    } else if (this._drag.kind === 'wedge') {
      let W = body._baseWidth ?? 40;
      let H = body._height ?? 40;
      const edge = this._drag.edge;
      const loc = worldToWedgeAABBLocal(body, pt.x, pt.y);
      const { flipX, flipY } = wedgeFlipFlags(body);
      if (ctrl) {
        // Same pin as normal drag, but snap the angle at the opposite handle (5°).
        if (edge === 'W') {
          // Pin vertical, snap top ∠: β = atan(W/H), keep H.
          const vLocalX = flipX ? W / 2 : -W / 2;
          let signed = (loc.x - vLocalX) * (flipX ? -1 : 1);
          signed = Math.max(minHalf * 2, signed);
          let beta = clampWedgeFootAngle(Math.atan2(signed, H));
          beta = clampWedgeFootAngle(snapAngleRad(beta, true));
          W = Math.max(minHalf * 2, H * Math.tan(beta));
          scaleWedgeTo(body, W, H, { pin: 'left', pinFlipX: flipX, pinFlipY: flipY });
          if (this._ghost) this._ghostAngleMark(body, 'top');
        } else {
          // Pin base, snap foot ∠: α = atan(H/W), keep W.
          const bLocalY = flipY ? -H / 2 : H / 2;
          let signed = (bLocalY - loc.y) * (flipY ? -1 : 1);
          signed = Math.max(minHalf * 2, signed);
          let alpha = clampWedgeFootAngle(Math.atan2(signed, W));
          alpha = clampWedgeFootAngle(snapAngleRad(alpha, true));
          H = Math.max(minHalf * 2, W * Math.tan(alpha));
          scaleWedgeTo(body, W, H, { pin: 'bottom', pinFlipX: flipX, pinFlipY: flipY });
          if (this._ghost) this._ghostAngleMark(body, 'foot');
        }
      } else if (edge === 'W') {
        // Grow/shrink base; drag past the vertical to invert (flipX).
        const vLocalX = flipX ? W / 2 : -W / 2;
        let signed = (loc.x - vLocalX) * (flipX ? -1 : 1);
        const pinFlipX = flipX;
        const pinFlipY = flipY;
        if (signed < 0) {
          body._wedgeFlipX = !flipX;
          signed = -signed;
        }
        W = Math.max(minHalf * 2, signed);
        if (snap) W = snapBodySizePx(W, true);
        scaleWedgeTo(body, W, H, { pin: 'left', pinFlipX, pinFlipY });
        if (this._ghost) {
          this._ghostSizeLabel(body,
            `${pxToM(body._baseWidth).toFixed(2)} × ${pxToM(body._height).toFixed(2)} m`);
        }
      } else if (edge === 'H') {
        // Grow/shrink height; drag past the base to invert (flipY).
        const bLocalY = flipY ? -H / 2 : H / 2;
        let signed = (bLocalY - loc.y) * (flipY ? -1 : 1);
        const pinFlipX = flipX;
        const pinFlipY = flipY;
        if (signed < 0) {
          body._wedgeFlipY = !flipY;
          signed = -signed;
        }
        H = Math.max(minHalf * 2, signed);
        if (snap) H = snapBodySizePx(H, true);
        scaleWedgeTo(body, W, H, { pin: 'bottom', pinFlipX, pinFlipY });
        if (this._ghost) {
          this._ghostSizeLabel(body,
            `${pxToM(body._baseWidth).toFixed(2)} x ${pxToM(body._height).toFixed(2)} m`);
        }
      }
    } else {
      let r = Math.hypot(loc.x, loc.y);
      if (snap) r = Math.max(4, snapWorldCoord(r, true));
      scaleCircleTo(body, r);
      if (this._ghost) {
        this._ghostSizeLabel(body, `r = ${pxToM(body._radius).toFixed(2)} m`);
      }
    }
    this._updatePositions();
  }

  _onDocUp() {
    this._unbindDrag();
    this._drag = null;
    if (this._ghost) {
      this._ghost.remove();
      this._ghost = null;
    }
    this._updatePositions();
  }

  // ─── Ghost overlay ─────────────────────────────────────────────

  _clearGhostContents() {
    if (!this._ghost) return;
    while (this._ghost.firstChild) this._ghost.removeChild(this._ghost.firstChild);
  }

  /** Size readout next to the body centre (non-Ctrl scale). */
  _ghostSizeLabel(body, text) {
    this._clearGhostContents();
    const t = svgEl('text', {
      x: String(body.position.x + 12),
      y: String(body.position.y - 14),
      fill: '#333',
      'font-size': '11',
      'font-family': FONT_DIAGRAM,
    });
    t.textContent = text;
    this._ghost.appendChild(t);
  }

  /**
   * Textbook-style angle mark (arc + degree) at a wedge vertex.
   * @param {'foot'|'top'} which
   */
  _ghostAngleMark(body, which) {
    this._clearGhostContents();
    const { bl, br, tl } = wedgeTriangleWorldVerts(body);
    const W = body._baseWidth ?? 40;
    const H = body._height ?? 40;
    const vertex = which === 'foot' ? br : tl;
    const pA = bl;
    const pB = which === 'foot' ? tl : br;
    const deg = which === 'foot'
      ? (body._footAngle * 180 / Math.PI)
      : (Math.atan2(W, H) * 180 / Math.PI);

    let dx0 = pA.x - vertex.x, dy0 = pA.y - vertex.y;
    let dx1 = pB.x - vertex.x, dy1 = pB.y - vertex.y;
    const l0 = Math.hypot(dx0, dy0);
    const l1 = Math.hypot(dx1, dy1);
    if (l0 < 1e-6 || l1 < 1e-6) return;
    dx0 /= l0; dy0 /= l0;
    dx1 /= l1; dy1 /= l1;

    const r = Math.max(12, Math.min(34, 0.24 * Math.min(W, H)));
    const x0 = vertex.x + dx0 * r;
    const y0 = vertex.y + dy0 * r;
    const x1 = vertex.x + dx1 * r;
    const y1 = vertex.y + dy1 * r;
    const cross = dx0 * dy1 - dy0 * dx1;
    const sweep = cross > 0 ? 1 : 0;

    this._ghost.appendChild(svgEl('path', {
      d: `M ${x0} ${y0} A ${r} ${r} 0 0 ${sweep} ${x1} ${y1}`,
      fill: 'none',
      stroke: COLORS.ink,
      'stroke-width': '1.25',
      'stroke-linecap': 'round',
    }));

    let bx = dx0 + dx1;
    let by = dy0 + dy1;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-6) return;
    bx /= blen; by /= blen;
    const labelR = r + Math.max(11, r * 0.38);
    const t = svgEl('text', {
      x: String(vertex.x + bx * labelR),
      y: String(vertex.y + by * labelR),
      fill: COLORS.ink,
      'font-size': '12',
      'font-family': FONT_DIAGRAM,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    });
    t.textContent = `${deg.toFixed(0)}°`;
    this._ghost.appendChild(t);
  }
}
