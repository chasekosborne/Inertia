/**
 * Velocity / applied-force drag handle.
 *
 * One draggable tip on the selected dynamic body. Tip offset is
 * `getVelocityPxPerMs()` world px per 1 m/s, or `getForcePxPerN()` px per N.
 * Double-click the tip to switch between v₀ and applied F — the tip stays put
 * and is reinterpreted through the other scale factor.
 *
 * Drag tracking lives on `window`, not the hit circle, because the tip can
 * outrun its own hit target. Snapping is deferred to release: a mid-drag snap
 * made the tip feel stuck to the body.
 *
 * **Deferring to the rendered arrow.** The renderer already draws this exact
 * vector — same endpoints, same colour, same label — whenever the arrow layer
 * is on and the value is long enough to paint. Drawing our own shaft and `F` /
 * `v₀` label on top of it just doubled the ink. So when the arrow is present
 * the handle collapses to a hollow grab ring on the arrowhead, and the shaft
 * reappears only during a drag — where it is *not* redundant: the shaft tracks
 * the raw pointer while the arrow shows the committed (possibly snapped)
 * value, and the gap between them is the snap feedback.
 *
 * With the arrow layer off, or the value too short to render, the handle draws
 * itself in full so it never becomes an unanchored floating dot.
 */

import {
  getForcePxPerN, getVelocityPxPerMs, matterVelToDisplayMS, displayMSToMatterVel,
} from '../../units.js';
import {
  snapWorldCoord, snapVelocityToAngle, VELOCITY_SNAP_MS, SNAP_ANGLE_STEP_5_DEG,
} from '../../grid.js';
import { getAppliedForce } from '../../physics/applied-force.js';
import { VECTOR_MIN_LEN } from '../../editor/view/svg-renderer.js';
import { FONT_DIAGRAM } from '../../theme.js';
import { svgEl, HANDLE_BLUE, HANDLE_RED, VECTOR_HANDLE_ID } from './chrome.js';

/** Max gap between tip clicks that still counts as a double-click (ms). */
const DBLCLICK_MS = 350;
/** Pointer travel before a press becomes a drag (client px). */
const DRAG_PX = 4;
/** Screen-space radius for "drop on centre → clear" (stable across zoom). */
const ZERO_TIP_SCREEN_PX = 12;
/** Force-mode speed step when Ctrl-snapping (N). */
const FORCE_SNAP_N = 0.1;
/** Tip dot radius: solid when the handle stands alone, smaller ring when deferring. */
const DOT_RADIUS_SOLID = 5;
const DOT_RADIUS_RING = 4.5;

/** Sub-element ids, derived so a rename of the group id carries through. */
const ID = {
  group: VECTOR_HANDLE_ID,
  shaft: `${VECTOR_HANDLE_ID}-shaft`,
  label: `${VECTOR_HANDLE_ID}-label`,
  angle: `${VECTOR_HANDLE_ID}-angle`,
  hit:   `${VECTOR_HANDLE_ID}-hit`,
  dot:   `${VECTOR_HANDLE_ID}-dot`,
};

/** Body types that carry an editable v₀ / F. */
const EDITABLE_TYPES = new Set(['point-mass', 'ball', 'box', 'wedge']);

/** Physics-convention angle (atan2, +y up). Ctrl-snap labels jump in 5° steps. */
function _formatVectorAngleLabel(angX, angY, snapped) {
  if (!(angX * angX + angY * angY > 1e-12)) return '0°';
  let deg = Math.atan2(angY, angX) * 180 / Math.PI;
  if (snapped) deg = Math.round(deg / SNAP_ANGLE_STEP_5_DEG) * SNAP_ANGLE_STEP_5_DEG;
  let disp = ((deg + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(disp) < 1e-9) disp = 0;
  return snapped ? `${disp.toFixed(0)}°` : `${disp.toFixed(1)}°`;
}

export class VectorHandle {
  /** @param {import('./editor-context.js').EditorContext} context */
  constructor(context) {
    this.context = context;
    /**
     * Live handle, or null when nothing is shown. Doubles as the
     * "does the handle exist" sentinel throughout.
     * @type {{ el: SVGGElement, bodyId: number, lastClickMs: number,
     *          dragMoved: boolean, downX: number, downY: number,
     *          dragTip: { x: number, y: number }|null }|null}
     */
    this._handle = null;
    this._dragging = false;
    /** True while dragging with Ctrl: angle snapped to 5°. */
    this._angleSnap = false;
    /** Which quantity the tip edits. @type {'velocity'|'force'} */
    this._quantity = 'velocity';

    // Bound once: add/removeEventListener must see the same reference.
    this._onWindowMove = this._onWindowMove.bind(this);
    this._onWindowUp = this._onWindowUp.bind(this);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /**
   * Selection moved to a different body — go back to editing v₀.
   * Called from the selection router, not from sync(): the reset must happen
   * even when no handle currently exists (e.g. selecting a static body
   * between two dynamic ones).
   */
  resetQuantity() {
    this._quantity = 'velocity';
  }

  /** Called every render frame. */
  sync() {
    const { context } = this;
    const selection = context.getSelection();
    const selId = selection?.type === 'body' ? selection.id : null;
    const body = selId
      ? context.engine.bodies.find(
          b => b.id === selId && !b.isStatic && EDITABLE_TYPES.has(b._newtonType),
        )
      : null;

    // Setup only: editing v₀ / F while live or scrubbing a recording writes a
    // value the next physics step or seek immediately overwrites.
    //
    // Select tool only: with v₀ = 0 the grab circle sits on the body centre,
    // which is exactly where you press to start a rod / spring / rope from
    // that body, or to rotate it. `interaction._onDown` bails on anything
    // inside this handle, so leaving it live would swallow those gestures.
    if (!body || !context.canEdit() || context.getToolMode() !== 'select') {
      this.reset();
      return;
    }

    // Rebuild if the selected body changed.
    if (this._handle && this._handle.bodyId !== body.id) {
      this.reset();
    }
    if (!this._handle) this._build(body);

    this._applyChrome(this._handle.el);
    this._position(body);
  }

  /** Tear down the handle and any in-flight drag. */
  reset() {
    if (this._dragging) {
      this._dragging = false;
      this._unbindWindowDrag();
    }
    this._angleSnap = false;
    if (this._handle) {
      this._handle.el.remove();
      this._handle = null;
    }
  }

  destroy() {
    this.reset();
  }

  // ─── Build ─────────────────────────────────────────────────────

  _build(body) {
    const group = svgEl('g', { id: ID.group });

    group.appendChild(svgEl('line', {
      id: ID.shaft,
      'stroke-width': '1.2',
      'stroke-dasharray': '4 3',
      'pointer-events': 'none',
    }));

    group.appendChild(svgEl('text', {
      id: ID.label,
      'font-size': '9',
      'font-family': FONT_DIAGRAM,
      'font-style': 'italic',
      'pointer-events': 'none',
    }));

    group.appendChild(svgEl('text', {
      id: ID.angle,
      'font-size': '9',
      'font-family': FONT_DIAGRAM,
      'pointer-events': 'none',
    }));

    const hit = svgEl('circle', {
      id: ID.hit,
      r: '14',
      fill: 'transparent',
      cursor: 'crosshair',
      'pointer-events': 'auto',
    });
    group.appendChild(hit);

    group.appendChild(svgEl('circle', {
      id: ID.dot,
      r: '5',
      stroke: '#fff',
      'stroke-width': '1.5',
      'pointer-events': 'none',
    }));

    this._applyChrome(group);
    this.context.layer.appendChild(group);
    this._handle = {
      el: group,
      bodyId: body.id,
      lastClickMs: 0,
      dragMoved: false,
      downX: 0,
      downY: 0,
      dragTip: null,
    };

    hit.addEventListener('pointerdown', e => this._onHitDown(e, hit));
  }

  // ─── Chrome ────────────────────────────────────────────────────

  _color() {
    return this._quantity === 'force' ? HANDLE_RED : HANDLE_BLUE;
  }

  /**
   * Colour + label text only. Dot geometry and per-element visibility depend on
   * whether we are deferring to the rendered arrow, so they live in
   * {@link _position}, which is the only place that knows.
   */
  _applyChrome(group) {
    if (!group) return;
    const color = this._color();
    const isForce = this._quantity === 'force';
    const shaft = group.querySelector(`#${ID.shaft}`);
    const label = group.querySelector(`#${ID.label}`);
    const angleLabel = group.querySelector(`#${ID.angle}`);
    if (shaft) shaft.setAttribute('stroke', color);
    if (label) {
      label.setAttribute('fill', color);
      label.textContent = isForce ? 'F' : 'v₀';
    }
    if (angleLabel) angleLabel.setAttribute('fill', color);
  }

  // ─── Quantity flip ─────────────────────────────────────────────

  /**
   * Flip v₀ ↔ F, keeping the tip where it is (reinterprets px → the other
   * quantity).
   * @param {import('matter-js').Body} body
   */
  _toggleQuantity(body) {
    const { context } = this;
    const bx = body.position.x;
    const by = body.position.y;

    if (this._quantity === 'velocity') {
      const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
      const vPx = getVelocityPxPerMs();
      const fPx = getForcePxPerN();
      const tipX = bx + vxMs * vPx;
      const tipY = by - vyMs * vPx;
      const Fx = (tipX - bx) / fPx;
      const Fy = -(tipY - by) / fPx;
      const F = Math.hypot(Fx, Fy);
      const thetaDeg = F > 1e-9 ? Math.atan2(Fy, Fx) * 180 / Math.PI : 0;
      this._quantity = 'force';
      context.applyAppliedForce(body, F > 1e-6 ? F : 0, thetaDeg);
    } else {
      const af = getAppliedForce(body);
      const F = af?.F ?? 0;
      const rad = ((af?.thetaDeg ?? 0) * Math.PI) / 180;
      const vPx = getVelocityPxPerMs();
      const fPx = getForcePxPerN();
      const tipX = bx + F * Math.cos(rad) * fPx;
      const tipY = by - F * Math.sin(rad) * fPx;
      const vxMs = (tipX - bx) / vPx;
      const vyMs = -(tipY - by) / vPx;
      const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
      this._quantity = 'velocity';
      context.applyVelocity(body, vx, vy, { snapGrid: false });
    }

    if (this._handle?.el) this._applyChrome(this._handle.el);
  }

  // ─── Writing the value ─────────────────────────────────────────

  /** @returns {import('matter-js').Body|null} */
  _body() {
    const id = this._handle?.bodyId;
    if (id == null) return null;
    return this.context.engine.bodies.find(b => b.id === id) ?? null;
  }

  /**
   * Write v₀ / F from a world-space tip. No mid-drag zero clamp: that made the
   * tip stick to the body while the pointer moved away.
   * @param {import('matter-js').Body} body
   * @param {{ x: number, y: number }} wpt
   * @param {{ snapGrid?: boolean, snapAngle?: boolean }} [opts]
   */
  _applyTip(body, wpt, opts = {}) {
    const { context } = this;
    const bx = body.position.x;
    const by = body.position.y;
    const snapAngle = !!opts.snapAngle;
    const snapGrid = !!opts.snapGrid && !snapAngle;

    if (this._quantity === 'force') {
      const fPx = getForcePxPerN();
      let Fx = (wpt.x - bx) / fPx;
      let Fy = -(wpt.y - by) / fPx;
      if (snapAngle) {
        ({ vxMs: Fx, vyMs: Fy } = snapVelocityToAngle(Fx, Fy, {
          angle: true,
          speedStep: context.getSnapEnabled() ? FORCE_SNAP_N : null,
        }));
      } else if (snapGrid) {
        let tipX = snapWorldCoord(bx + Fx * fPx, true);
        let tipY = snapWorldCoord(by - Fy * fPx, true);
        Fx = (tipX - bx) / fPx;
        Fy = -(tipY - by) / fPx;
      }
      const F = Math.hypot(Fx, Fy);
      const thetaDeg = F > 1e-9 ? Math.atan2(Fy, Fx) * 180 / Math.PI : 0;
      context.applyAppliedForce(body, F > 1e-6 ? F : 0, thetaDeg);
      return;
    }

    const vPx = getVelocityPxPerMs();
    let vxMs = (wpt.x - bx) / vPx;
    let vyMs = -(wpt.y - by) / vPx;
    if (snapAngle) {
      ({ vxMs, vyMs } = snapVelocityToAngle(vxMs, vyMs, {
        angle: true,
        speedStep: context.getSnapEnabled() ? VELOCITY_SNAP_MS : null,
      }));
    }
    const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
    context.applyVelocity(body, vx, vy, { snapGrid });
  }

  // ─── Drag ──────────────────────────────────────────────────────

  _onHitDown(e, hit) {
    if (!this.context.canEdit()) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this._handle.downX = e.clientX;
    this._handle.downY = e.clientY;
    this._handle.dragMoved = false;
    this._handle.dragTip = null;
    this.context.pushHistory();
    this._dragging = true;
    this._angleSnap = e.ctrlKey;
    try { hit.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Window listeners keep tracking even if the tip races ahead of the hit target.
    this._unbindWindowDrag();
    window.addEventListener('pointermove', this._onWindowMove);
    window.addEventListener('pointerup', this._onWindowUp);
    window.addEventListener('pointercancel', this._onWindowUp);
  }

  _unbindWindowDrag() {
    window.removeEventListener('pointermove', this._onWindowMove);
    window.removeEventListener('pointerup', this._onWindowUp);
    window.removeEventListener('pointercancel', this._onWindowUp);
  }

  _onWindowMove(e) {
    if (!this._dragging || !this._handle) return;
    if (!this._handle.dragMoved) {
      const dx = e.clientX - this._handle.downX;
      const dy = e.clientY - this._handle.downY;
      if (dx * dx + dy * dy < DRAG_PX * DRAG_PX) return;
      this._handle.dragMoved = true;
    }

    const body = this._body();
    if (!body) return;

    const wpt = this.context.clientToWorld(e.clientX, e.clientY);
    this._handle.dragTip = { x: wpt.x, y: wpt.y };
    this._angleSnap = e.ctrlKey;
    // Live drag follows the pointer exactly: snap / clear only on release.
    this._applyTip(body, wpt, {
      snapGrid: false,
      snapAngle: this._angleSnap,
    });
  }

  _onWindowUp(e) {
    const { context } = this;
    const wasDragging = this._dragging;
    const moved = this._handle?.dragMoved;
    const tip = this._handle?.dragTip ? { ...this._handle.dragTip } : null;
    const body = this._body();
    const angleSnap = this._angleSnap;

    this._dragging = false;
    this._angleSnap = false;
    this._unbindWindowDrag();
    if (this._handle) this._handle.dragTip = null;

    if (!wasDragging || !body) return;

    if (moved && tip) {
      const bx = body.position.x;
      const by = body.position.y;
      const screenDist = Math.hypot(tip.x - bx, tip.y - by) * (context.camera.s || 1);
      if (screenDist <= ZERO_TIP_SCREEN_PX) {
        if (this._quantity === 'force') context.applyAppliedForce(body, 0, 0);
        else context.applyVelocity(body, 0, 0, { snapGrid: false });
      } else {
        this._applyTip(body, tip, {
          snapGrid: !angleSnap && context.getSnapEnabled(),
          snapAngle: angleSnap,
        });
      }
      return;
    }

    // Click / double-click on the tip (no drag).
    if (!this._handle) return;
    const now = performance.now();
    if (now - this._handle.lastClickMs < DBLCLICK_MS) {
      this._handle.lastClickMs = 0;
      e?.preventDefault?.();
      e?.stopPropagation?.();
      this._toggleQuantity(body);
    } else {
      this._handle.lastClickMs = now;
    }
  }

  // ─── Position ──────────────────────────────────────────────────

  _position(body) {
    const { context } = this;
    const bx = body.position.x;
    const by = body.position.y;
    const isForce = this._quantity === 'force';
    const scalePx = isForce ? getForcePxPerN() : getVelocityPxPerMs();

    // ── Committed value: exactly what the renderer paints as the arrow ──
    let cAngX;
    let cAngY;
    if (isForce) {
      const af = getAppliedForce(body);
      const F = af?.F ?? 0;
      const rad = ((af?.thetaDeg ?? 0) * Math.PI) / 180;
      cAngX = F * Math.cos(rad);
      cAngY = F * Math.sin(rad);
    } else {
      const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
      cAngX = vxMs;
      cAngY = vyMs;
    }
    const cTipX = bx + cAngX * scalePx;
    const cTipY = by - cAngY * scalePx;

    // Does an arrow actually exist to defer to? `_drawVector` bails below minLen.
    const committedLen = Math.hypot(cTipX - bx, cTipY - by);
    const minLen = isForce ? VECTOR_MIN_LEN.default : VECTOR_MIN_LEN.velocity;
    const deferring = !!context.getShowVectors?.() && committedLen >= minLen;

    // ── Displayed tip: raw pointer while dragging, committed value at rest ──
    let tipX;
    let tipY;
    let angX;
    let angY;
    if (this._dragging && this._handle.dragTip) {
      // Pin the tip to the pointer so the shaft never lags behind.
      tipX = this._handle.dragTip.x;
      tipY = this._handle.dragTip.y;
      angX = (tipX - bx) / scalePx;
      angY = -(tipY - by) / scalePx;
    } else {
      tipX = cTipX;
      tipY = cTipY;
      angX = cAngX;
      angY = cAngY;
    }

    const shaftLen = Math.hypot(tipX - bx, tipY - by);
    const hasV = shaftLen > 1;
    const longEnough = shaftLen > 12;

    // Shaft is redundant with the arrow at rest, but not during a drag: then it
    // tracks the raw pointer while the arrow shows the snapped value.
    const showShaft = !deferring || this._dragging;
    const showQuantityLabel = !deferring;
    const showAngle = this._dragging && longEnough;

    const el = this._handle.el;
    const dot = el.querySelector(`#${ID.dot}`);
    const hit = el.querySelector(`#${ID.hit}`);
    const shaft = el.querySelector(`#${ID.shaft}`);
    const label = el.querySelector(`#${ID.label}`);
    const angleLabel = el.querySelector(`#${ID.angle}`);

    if (dot) {
      dot.setAttribute('cx', tipX);
      dot.setAttribute('cy', tipY);
      // Hollow ring when deferring so the arrowhead reads through it.
      if (deferring) {
        dot.setAttribute('r', String(DOT_RADIUS_RING));
        dot.setAttribute('fill', 'none');
        dot.setAttribute('stroke', this._color());
        dot.setAttribute('stroke-width', '1.75');
      } else {
        dot.setAttribute('r', String(DOT_RADIUS_SOLID));
        dot.setAttribute('fill', this._color());
        dot.setAttribute('stroke', '#fff');
        dot.setAttribute('stroke-width', '1.5');
      }
    }
    if (hit) {
      hit.setAttribute('cx', tipX);
      hit.setAttribute('cy', tipY);
      hit.setAttribute('pointer-events', 'auto');
    }
    if (shaft) {
      shaft.setAttribute('x1', bx); shaft.setAttribute('y1', by);
      shaft.setAttribute('x2', tipX); shaft.setAttribute('y2', tipY);
      shaft.setAttribute('opacity', showShaft ? (hasV ? '1' : '0.45') : '0');
    }
    if (label) {
      label.setAttribute('x', tipX + 6);
      label.setAttribute('y', tipY - 5);
      label.setAttribute('opacity', showQuantityLabel ? (hasV ? '1' : '0.85') : '0');
    }
    if (angleLabel) {
      if (showAngle) {
        angleLabel.textContent = _formatVectorAngleLabel(angX, angY, this._angleSnap);
        const mx = (bx + tipX) / 2;
        const my = (by + tipY) / 2;
        const nx = -(tipY - by) / shaftLen;
        const ny = (tipX - bx) / shaftLen;
        angleLabel.setAttribute('x', (mx + nx * 8).toFixed(1));
        angleLabel.setAttribute('y', (my + ny * 8).toFixed(1));
        angleLabel.setAttribute('text-anchor', 'middle');
        angleLabel.setAttribute('opacity', '1');
      } else {
        angleLabel.setAttribute('opacity', '0');
      }
    }
  }
}
