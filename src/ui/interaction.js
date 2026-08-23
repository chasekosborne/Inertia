/**
 * Interaction handler: manages tool modes and pointer events on the SVG canvas.
 *
 * Modes:
 *   select         : drag bodies, string/rod/spring bobs arc at fixed length
 *                     (Ctrl → 5°), hanging chains (e.g. double pendulum) translate
 *                     with the dragged mass so lower link lengths stay fixed,
 *                     with constraint selected, drag its line to translate attached
 *                     non-static bodies together
 *   rotate         : drag a body around its centre to set angle (Ctrl → 5°)
 *   scale          : drag handles to resize box (width/height) or circle (radius)
 *   point-mass     : drag-to-place legacy (prefer add-bar drag-drop in main.js)
 *   box             :
 *   anchor         : click to place
 *   ground         : pointer down sets start (anywhere on canvas), drag shows a
 *                     segment preview like a constraint, release to place, Ctrl = 5° steps
 *   rope           : click-drag to place, drop on a body to attach that end
 *                     (standalone if both ends are in empty space)
 *   string|rod|spring: drag from body A to body B
 *   pan            : click-drag pans the camera
 *   (any mode)     : hold Shift + drag for temporary pan
 */

import Matter from 'matter-js';
import { createPointMass, createBall, createBox, createWedge, createAnchor, createGround,
         createString, wedgeAABBCenterWorld, setWedgeAABBCenter, snapWedgeToGrid,
         wedgeContainsWorldPoint } from '../physics/bodies.js';
import { createRod, createSpring } from '../physics/constraints.js';
import {
  createFreeRope, ropeSegmentCountForLength, ropeSelection, listRopeSegments, clampRopeSegments,
  snapRopePins,
} from '../physics/rope.js';
import {
  findPendulumGuidance,
  constraintAnchorWorld,
  findConstraintAttachTarget,
  captureHangingChain,
  applyHangingChainTranslation,
} from '../physics/layout-anchors.js';
import { springPathProps } from '../renderer/spring-path.js';
import { snapWorldCoord, snapSegmentFromStart, snapAngleRad, SNAP_ANGLE_STEP_5_DEG } from '../grid.js';
import { FONT_DIAGRAM, COLORS } from '../theme.js';
import { pxToM } from '../units.js';

const { Body, Vertices, Bounds } = Matter;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Non-static bodies attached to the constraint (world anchor side omitted). */
function bodiesToTranslateForConstraint(c) {
  const out = [];
  if (c.bodyA && !c.bodyA.isStatic) out.push(c.bodyA);
  if (c.bodyB && !c.bodyB.isStatic) out.push(c.bodyB);
  return out;
}

export class InteractionHandler {
  /**
   * @param {SVGSVGElement} svg
   * @param {PhysicsEngine} physicsEngine
   * @param {(sel: object|null) => void} onSelect
   * @param {import('../camera/camera.js').Camera|null} [camera]
   * @param {SVGElement|null} [ghostParent]: `<g>` for placement previews (use renderer `interactionGhostLayer`, sits under `uiTopLayer`).
   */
  constructor(svg, physicsEngine, onSelect, camera = null, ghostParent = null) {
    this.svg     = svg;
    this.engine  = physicsEngine;
    this._onSelect = onSelect;
    this._camera  = camera;

    this._mode   = 'select';
    this._snapEnabled = true;
    this._metricOriginSelectable = false;

    /**
     * Optional callback invoked just before a body drag begins (select mode).
     * Set from outside, e.g. `interaction.onBeforeDrag = () => history.push(...)`.
     */
    this.onBeforeDrag = null;

    /**
     * Optional: current setup selection `{ type, id }` (e.g. constraint) for line-drag translate.
     * Set from main, e.g. `interaction.getSetupSelection = () => _currentSelection`.
     * @type {(() => ({ type: string, id: number } | null)) | null}
     */
    this.getSetupSelection = null;

    /**
     * Optional: toolbar UI for temporary Shift-pan preview.
     * Called with `true` while Shift is held (and the real tool is not already Pan).
     * @type {((active: boolean) => void) | null}
     */
    this.onTempPanPreview = null;

    /**
     * Optional measurement overlays (length / angle tools).
     * @type {import('./measurements.js').MeasurementManager|null}
     */
    this.measurements = null;

    /**
     * Optional text labels (callout / inline).
     * @type {import('./labels.js').LabelManager|null}
     */
    this.labels = null;

    // Body drag state (select mode)
    this._dragging  = null;
    this._dragOffX  = 0;
    this._dragOffY  = 0;

    /** @type {{ body: import('matter-js').Body, ptr0: number, angle0: number } | null } */
    this._rotating = null;

    // Constraint drag state (both ends must attach to a body / constraint end)
    this._constraintSrc  = null;   // source body
    this._constraintSrcLocal = null; // local attach on source
    this._constraintDown = null;   // pointer-down world pt

    /** @type {{ pivot: {x:number,y:number}, radius: number, localAttach: {x:number,y:number}, kind?: string } | null } */
    this._pendulumDrag = null;
    /** Hanging chain that translates with the dragged body (double pendulum, etc.). */
    this._hangingChain = null;

    // Ground drag: first point in world (empty space or over a body: same start)
    this._groundStart = null;
    /** Free-rope placement start (world px). */
    this._ropeStart = null;
    /** Optional segment-count override while placing (wheel). */
    this._ropeSegOverride = null;

    /** @type {{ ptr0: {x:number,y:number}, origins: Array<{ body: import('matter-js').Body, ox: number, oy: number }> } | null } */
    this._bulkConstraintDrag = null;

    /** Shift held (for temporary pan cursor / gesture). */
    this._shiftHeld = false;
    /** True while a Shift-drag temporary pan is in progress. */
    this._shiftPanning = false;
    /** Suppress the click that follows a pan pointer-up (avoids clearing selection). */
    this._ignoreNextClick = false;
    /** Last value sent to `onTempPanPreview`. */
    this._tempPanPreview = false;

    if (ghostParent) {
      this._ghostLayer = ghostParent;
    } else {
      this._ghostLayer = svgEl('g', { id: 'layer-ghost-fallback', 'pointer-events': 'none' });
      this.svg.appendChild(this._ghostLayer);
    }

    this._bindEvents();
  }

  setMode(mode) {
    this._mode = mode;
    this._cancelDrag();
    this._clearGhost();
    this.measurements?.setTool(
      mode === 'measure-length' || mode === 'measure-angle' ? mode : null,
    );
    this.labels?.setTool(mode === 'label' ? 'label' : null);
    this._syncCursorClass();
  }

  /** Apply select/pan/rotate/scale cursor classes based on tool mode and Shift hold. */
  _syncCursorClass() {
    this.svg.classList.remove('mode-select', 'mode-pan', 'mode-rotate', 'mode-scale', 'mode-measure', 'mode-camera');
    if (this._mode === 'pan' || this._shiftPanning || this._shiftHeld) {
      this.svg.classList.add('mode-pan');
    } else if (this._mode === 'rotate') {
      this.svg.classList.add('mode-rotate');
    } else if (this._mode === 'scale') {
      this.svg.classList.add('mode-scale');
    } else if (this._mode === 'measure-length' || this._mode === 'measure-angle' || this._mode === 'label') {
      this.svg.classList.add('mode-measure');
    } else if (this._mode === 'camera') {
      this.svg.classList.add('mode-camera');
    } else if (this._mode === 'select') {
      this.svg.classList.add('mode-select');
    }
    this._notifyTempPanPreview();
  }

  _notifyTempPanPreview() {
    const active = (this._shiftHeld || this._shiftPanning) && this._mode !== 'pan';
    if (this._tempPanPreview === active) return;
    this._tempPanPreview = active;
    this.onTempPanPreview?.(active);
  }

  get mode() { return this._mode; }

  setSnapEnabled(v) { this._snapEnabled = v; }
  setMetricOriginSelectable(v) { this._metricOriginSelectable = !!v; }

  // ─── Events ────────────────────────────────────────────────────

  _bindEvents() {
    this.svg.addEventListener('pointerdown',  this._onDown.bind(this));
    this.svg.addEventListener('pointermove',  this._onMove.bind(this));
    this.svg.addEventListener('pointerup',    this._onUp.bind(this));
    this.svg.addEventListener('pointerleave', this._onLeave.bind(this));
    // Prevent accidental text selection while dragging bodies / velocity handles.
    this.svg.addEventListener('selectstart', e => e.preventDefault());
    this.svg.addEventListener('dragstart', e => e.preventDefault());
    this.svg.addEventListener('click', e => {
      if (this._ignoreNextClick) {
        this._ignoreNextClick = false;
        return;
      }
      if (this._mode === 'pan' || this._shiftPanning) return;
      // Interactive chrome lives above bodies: don't treat as empty canvas.
      if (e.target?.closest?.('#vel-handle, #layer-ui-top, [data-sel-handle], [data-scale-handle]')) {
        return;
      }

      const pt = this._svgPoint(e);
      // Geometric hits: overlays use pointer-events:none, so target may be the grid.
      // Bodies/constraints beat measurements so overlapping objects keep selection.
      if (this._bodyAt(pt) || this._constraintAt(pt) || this._ropeHitAt(pt)) return;
      if (this.measurements?._hitEditHandle?.(pt) || this.measurements?._hitTest?.(pt)) return;
      if (this.labels?._hitTest?.(pt)) return;

      // Empty canvas (grid / background): clear selection.
      this._onSelect(null);
    });

    window.addEventListener('keydown', e => {
      if (e.key !== 'Shift' || e.repeat) return;
      this._shiftHeld = true;
      this._syncCursorClass();
    });
    window.addEventListener('keyup', e => {
      if (e.key !== 'Shift') return;
      this._shiftHeld = false;
      if (this._shiftPanning && this._camera) {
        this._camera.endPan();
        this._shiftPanning = false;
      }
      this._syncCursorClass();
    });
    window.addEventListener('blur', () => {
      this._shiftHeld = false;
      if (this._shiftPanning && this._camera) {
        this._camera.endPan();
        this._shiftPanning = false;
      }
      this._syncCursorClass();
    });
  }

  _svgScreenPoint(e) {
    const rect = this.svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _svgPoint(e) {
    const sp = this._svgScreenPoint(e);
    if (this._camera) return this._camera.screenToWorld(sp.x, sp.y);
    return sp;
  }

  /** True if `pt` is inside body geometry (anchors use a bespoke hit-zone). */
  _bodyHitsPoint(b, pt) {
    // Wedge: use AABB triangle test: Matter parts/bounds can desync after rescale.
    if (b._newtonType === 'wedge') {
      return wedgeContainsWorldPoint(b, pt.x, pt.y);
    }

    if (!Bounds.contains(b.bounds, pt)) return false;

    // Anchor: pivot at body.position (matches rendered hinge circle).
    if (b._newtonType === 'anchor') {
      const px = b.position.x;
      const py = b.position.y;
      const dx = px - pt.x;
      const dy = py - pt.y;
      return dx * dx + dy * dy <= 18 * 18;
    }

    const startIdx = b.parts.length === 1 ? 0 : 1;
    for (let j = startIdx; j < b.parts.length; j++) {
      const part = b.parts[j];
      if (Bounds.contains(part.bounds, pt) && Vertices.contains(part.vertices, pt)) return true;
    }
    return false;
  }

  /**
   * Bodies hit-tested in draw order: dynamics first so they beat wide statics
   * (e.g. ground) underneath.
   * @returns {{ body: import('matter-js').Body, partIndex: number|null }|null}
   */
  _bodyPartAt(pt) {
    for (const b of this.engine.bodies) {
      if (b._newtonType === 'metric-basis') {
        if (!this._metricOriginSelectable) continue;
        if (this._bodyHitsPoint(b, pt)) return { body: b, partIndex: null };
      }
    }
    const candidates = [
      ...this.engine.bodies.filter(b => !b.isStatic && b._newtonType !== 'metric-basis'),
      ...this.engine.bodies.filter(b => b.isStatic && b._newtonType !== 'metric-basis'),
    ];
    for (const b of candidates) {
      if (b._newtonType === 'compound' && b.parts?.length > 1) {
        for (let j = 1; j < b.parts.length; j++) {
          const part = b.parts[j];
          if (Bounds.contains(part.bounds, pt) && Vertices.contains(part.vertices, pt)) {
            return { body: b, partIndex: j - 1 };
          }
        }
        continue;
      }
      if (this._bodyHitsPoint(b, pt)) return { body: b, partIndex: null };
    }
    return null;
  }

  _bodyAt(pt) {
    return this._bodyPartAt(pt)?.body ?? null;
  }

  _selectBodyHit(hit) {
    if (!hit) return;
    if (hit.body?._ropeSegment && hit.body._ropeId) {
      this._selectRope(hit.body._ropeId);
      return;
    }
    this._onSelect({
      type: 'body',
      id: hit.body.id,
      partIndex: hit.partIndex,
    });
  }

  /**
   * Rope id under the pointer (node or stroke), or null.
   * @param {{ x: number, y: number }} pt
   */
  _ropeHitAt(pt) {
    const body = this._bodyAt(pt);
    if (body?._ropeSegment && body._ropeId) return body._ropeId;
    const c = this._constraintAt(pt, 22);
    if (c?._ropeLink) return c._ropeId ?? c.bodyA?._ropeId ?? c.bodyB?._ropeId ?? null;
    return null;
  }

  /**
   * Select the rope aggregate. Optionally begin a whole-chain translate.
   * @param {string} ropeId
   * @param {{ drag?: boolean, pt?: { x: number, y: number } }} [opts]
   */
  _selectRope(ropeId, opts = {}) {
    const sel = ropeSelection(this.engine, ropeId);
    if (!sel) return false;
    this._onSelect(sel);
    if (opts.drag && opts.pt && !this.engine.running) {
      const nodes = listRopeSegments(this.engine, ropeId)
        .filter(b => !b._ropeHost?.body);
      if (nodes.length) {
        this.onBeforeDrag?.();
        this._bulkConstraintDrag = {
          ptr0: { ...opts.pt },
          origins: nodes.map(b => ({
            body: b,
            ox: b.position.x,
            oy: b.position.y,
          })),
        };
      }
    }
    return true;
  }

  /** Distance from point to segment AB (world px). */
  _distToSeg(pt, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(pt.x - a.x, pt.y - a.y);
    let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
  }

  /**
   * Nearest constraint within hit radius (world px). Springs/rods/strings are
   * selectable so their properties (e.g. spring k) can be edited.
   */
  _constraintAt(pt, hitPx = 14) {
    let best = null;
    let bestD = hitPx;
    for (const c of this.engine.constraints) {
      const a = constraintAnchorWorld(c, 'A');
      const b = constraintAnchorWorld(c, 'B');
      const d = this._distToSeg(pt, a, b);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // ─── Pointer down ──────────────────────────────────────────────

  _onDown(e) {
    if (e.button !== 0) return;

    // Camera tool is an isolated mode: sandbox objects are not selectable or editable.
    if (this._mode === 'camera') return;

    if (e.target?.closest?.('[data-sel-handle]')) return;

    // Scale handles: main.js owns resize drags.
    if (e.target?.closest?.('[data-scale-handle]')) return;

    // v₀ SVG handle: let it capture drags without starting select-move on the body.
    if (e.target?.closest?.('#vel-handle')) return;

    // Pan tool, or temporary Shift+drag pan from any other tool.
    if (this._camera && (this._mode === 'pan' || e.shiftKey)) {
      const sp = this._svgScreenPoint(e);
      this._camera.beginPan(sp.x, sp.y);
      this._shiftPanning = e.shiftKey && this._mode !== 'pan';
      this._shiftHeld = e.shiftKey;
      this._syncCursorClass();
      this.svg.setPointerCapture(e.pointerId);
      return;
    }

    const pt = this._svgPoint(e);
    this.svg.setPointerCapture(e.pointerId);

    // Measurement edit handles + measure-tool placement take priority.
    // Selecting a measurement is deferred until after bodies/constraints so
    // overlapping objects win.
    if (this.measurements?.handlePointerDown(pt, {
      mode: this._mode,
      ctrlKey: e.ctrlKey,
      editAndToolsOnly: true,
    })) {
      // Measurement hit tests are geometric (layer is pointer-events: none), so the
      // following click often targets the bare SVG and would clear selection.
      this._ignoreNextClick = true;
      return;
    }

    if (this.labels?.handlePointerDown(pt, {
      mode: this._mode,
      ctrlKey: e.ctrlKey,
    })) {
      this._ignoreNextClick = true;
      return;
    }

    if (this._mode === 'select') {
      // Physics running: don't drag bodies (spring forces would fight the drag).
      if (this.engine.running) {
        const ropeId = this._ropeHitAt(pt);
        if (ropeId) {
          this._selectRope(ropeId);
          return;
        }
        const hit = this._bodyPartAt(pt);
        const con = this._constraintAt(pt);
        if (con && !con._ropeLink && (!hit || this._distToSeg(pt, constraintAnchorWorld(con, 'A'), constraintAnchorWorld(con, 'B')) < 12)) {
          this._onSelect({ type: 'constraint', id: con.id });
        } else if (hit) {
          this._selectBodyHit(hit);
        } else if (this.measurements?.handlePointerDown(pt, { mode: 'select', selectOnly: true })) {
          this._ignoreNextClick = true;
        } else {
          this._onSelect(null);
        }
        return;
      }

      const ropeIdDown = this._ropeHitAt(pt);
      if (ropeIdDown) {
        this._selectRope(ropeIdDown, { drag: true, pt });
        return;
      }

      const sel = typeof this.getSetupSelection === 'function' ? this.getSetupSelection() : null;
      const conHit = this._constraintAt(pt);
      const grp = e.target.closest?.('.constraint-group');
      const grpId = grp ? parseInt(grp.id?.replace(/^constraint-/, '') ?? '', 10) : NaN;
      const c = conHit
        ?? (!Number.isNaN(grpId) ? this.engine.constraints.find(x => x.id === grpId) : null);

      if (c?._ropeLink) {
        const rid = c._ropeId ?? c.bodyA?._ropeId ?? c.bodyB?._ropeId;
        if (rid) {
          this._selectRope(rid, { drag: true, pt });
          return;
        }
      }

      // Already-selected constraint: drag attached bodies together.
      if (sel?.type === 'constraint' && c && c.id === sel.id) {
        const movers = bodiesToTranslateForConstraint(c);
        if (movers.length) {
          this.onBeforeDrag?.();
          this._bulkConstraintDrag = {
            ptr0: { ...pt },
            origins: movers.map(b => ({
              body: b,
              ox: b.position.x,
              oy: b.position.y,
            })),
          };
          return;
        }
        this._onSelect({ type: 'constraint', id: c.id });
        return;
      }

      // Prefer the spring/rod link when the chord is under the cursor so k can be edited.
      if (c) {
        const body = this._bodyAt(pt);
        const a = constraintAnchorWorld(c, 'A');
        const b = constraintAnchorWorld(c, 'B');
        const onLink = this._distToSeg(pt, a, b) <= 12;
        if (onLink && (!body || body.isStatic || body._newtonType === 'anchor')) {
          this._onSelect({ type: 'constraint', id: c.id });
          return;
        }
        // Mid-span click on spring even over empty space / near bob: still select spring.
        if (onLink && c._newtonType === 'spring' && !body) {
          this._onSelect({ type: 'constraint', id: c.id });
          return;
        }
        if (onLink && c._newtonType === 'spring') {
          // Click on link nearer mid-span than to body centre → select spring.
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const dMid = Math.hypot(pt.x - mid.x, pt.y - mid.y);
          const dBody = Math.hypot(pt.x - body.position.x, pt.y - body.position.y);
          if (dMid < dBody) {
            this._onSelect({ type: 'constraint', id: c.id });
            return;
          }
        }
      }

      const hit = this._bodyPartAt(pt);
      if (hit) {
        const body = hit.body;
        this.onBeforeDrag?.();
        this._dragging = body;
        if (body._newtonType === 'wedge') {
          const aabb = wedgeAABBCenterWorld(body);
          this._dragOffX = pt.x - aabb.x;
          this._dragOffY = pt.y - aabb.y;
        } else {
          this._dragOffX = pt.x - body.position.x;
          this._dragOffY = pt.y - body.position.y;
        }
        this._pendulumDrag = findPendulumGuidance(this.engine, body);
        // Descendants ride with this body (skip the parent link so we do not
        // pull the pivot bob when dragging a lower pendulum mass).
        const skipIds = this._pendulumDrag?.constraintId != null
          ? [this._pendulumDrag.constraintId]
          : [];
        this._hangingChain = captureHangingChain(this.engine, body, {
          skipConstraintIds: skipIds,
        });
        this._selectBodyHit(hit);
      } else if (c) {
        this._onSelect({ type: 'constraint', id: c.id });
      } else if (this.measurements?.handlePointerDown(pt, { mode: 'select', selectOnly: true })) {
        this._ignoreNextClick = true;
      } else {
        // Empty canvas: clear selection immediately (don't rely on click alone).
        this._onSelect(null);
      }
      return;
    }

    if (this._mode === 'rotate') {
      if (this.engine.running) {
        const hit = this._bodyPartAt(pt);
        if (hit?.body?._ropeSegment) this._selectRope(hit.body._ropeId);
        else if (hit && this._canRotate(hit.body)) this._selectBodyHit(hit);
        return;
      }
      const hit = this._bodyPartAt(pt);
      if (hit?.body?._ropeSegment) {
        this._selectRope(hit.body._ropeId);
        return;
      }
      if (hit && this._canRotate(hit.body)) {
        const body = hit.body;
        this.onBeforeDrag?.();
        const pivot = body._newtonType === 'wedge'
          ? wedgeAABBCenterWorld(body)
          : body.position;
        const dx = pt.x - pivot.x;
        const dy = pt.y - pivot.y;
        this._rotating = {
          body,
          ptr0: Math.atan2(dy, dx),
          angle0: body.angle,
          pivot: body._newtonType === 'wedge' ? { ...pivot } : null,
        };
        this._selectBodyHit(hit);
      }
      return;
    }

    if (this._mode === 'scale') {
      const hit = this._bodyPartAt(pt);
      if (hit?.body?._ropeSegment) this._selectRope(hit.body._ropeId);
      else if (hit && this._canScale(hit.body)) {
        this._selectBodyHit(hit);
      }
      return;
    }

    if (['string', 'rod', 'spring'].includes(this._mode)) {
      const attach = findConstraintAttachTarget(this.engine, pt.x, pt.y, {
        hitPx: 30,
        snapGrid: this._snapEnabled,
      });
      if (attach) {
        this._constraintSrc = attach.body;
        this._constraintSrcLocal = { ...attach.local };
        this._constraintDown = { x: attach.world.x, y: attach.world.y };
        this.svg.querySelector(`#body-${attach.body.id}`)?.classList.add('selected');
      }
      return;
    }

    if (this._mode === 'ground') {
      let x = pt.x;
      let y = pt.y;
      if (this._snapEnabled) {
        x = snapWorldCoord(x, true);
        y = snapWorldCoord(y, true);
      }
      this._groundStart = { x, y };
      return;
    }

    // Rope: click-drag, attach an end when the pointer is over a body.
    if (this._mode === 'rope') {
      const attach = this._ropeAttachTarget(pt);
      if (attach) {
        this._ropeStart = { x: attach.world.x, y: attach.world.y, attach };
      } else {
        let x = pt.x;
        let y = pt.y;
        if (this._snapEnabled) {
          x = snapWorldCoord(x, true);
          y = snapWorldCoord(y, true);
        }
        this._ropeStart = { x, y, attach: null };
      }
      this._ropeSegOverride = null;
      return;
    }
  }

  // ─── Pointer move ──────────────────────────────────────────────

  _onMove(e) {
    if (e.target?.closest?.('#vel-handle')) return;

    if (this._camera?.isPanning) {
      const sp = this._svgScreenPoint(e);
      this._camera.movePan(sp.x, sp.y);
      return;
    }

    const pt = this._svgPoint(e);

    if (this.measurements?.isEditing?.() || this.measurements?.handlesMode(this._mode)) {
      if (this.measurements.handlePointerMove(pt, { ctrlKey: e.ctrlKey })) return;
    }

    if (this.labels?.isEditing?.() || this.labels?.handlesMode(this._mode)) {
      if (this.labels.handlePointerMove(pt)) return;
    }

    if (this._bulkConstraintDrag) {
      if (this.engine.running) return;
      const { ptr0, origins } = this._bulkConstraintDrag;
      const dx = pt.x - ptr0.x;
      const dy = pt.y - ptr0.y;
      for (const { body, ox, oy } of origins) {
        Body.setPosition(body, { x: ox + dx, y: oy + dy });
        Body.setVelocity(body, { x: 0, y: 0 });
        body.force.x = 0;
        body.force.y = 0;
        body.torque = 0;
      }
      snapRopePins(this.engine);
      return;
    }

    // Body drag (select mode): pendulum → arc around fixed pivot + dotted guide circle
    if (this._dragging && this._pendulumDrag) {
      const body = this._dragging;
      const { pivot, radius, localAttach } = this._pendulumDrag;
      const θ = body.angle;
      const cosθ = Math.cos(θ);
      const sinθ = Math.sin(θ);
      const lax = cosθ * localAttach.x - sinθ * localAttach.y;
      const lay = sinθ * localAttach.x + cosθ * localAttach.y;

      let ax = pt.x - this._dragOffX;
      let ay = pt.y - this._dragOffY;

      let curAx = ax + lax;
      let curAy = ay + lay;
      let dx = curAx - pivot.x;
      let dy = curAy - pivot.y;
      let phi = Math.atan2(dy, dx);
      if (Math.hypot(dx, dy) < 1e-6) {
        phi = 0;
      } else if (e.ctrlKey) {
        phi = snapAngleRad(phi, true);
      }

      const desiredAx = pivot.x + Math.cos(phi) * radius;
      const desiredAy = pivot.y + Math.sin(phi) * radius;
      Body.setPosition(body, { x: desiredAx - lax, y: desiredAy - lay });

      Body.setVelocity(body, { x: 0, y: 0 });

      this._clearGhost();
      this._ghostLayer.appendChild(svgEl('circle', {
        cx: pivot.x,
        cy: pivot.y,
        r: radius,
        fill: 'none',
        stroke: '#666',
        'stroke-width': 1,
        'stroke-dasharray': '5 8',
        opacity: 0.85,
      }));
      if (e.ctrlKey) {
        const dtxt = svgEl('text', {
          x: pivot.x + radius + 8,
          y: pivot.y - 4,
          fill: '#666',
          'font-size': 10,
          'font-family': FONT_DIAGRAM,
        });
        dtxt.textContent = `${((phi * 180) / Math.PI).toFixed(0)}° (${SNAP_ANGLE_STEP_5_DEG}° snap)`;
        this._ghostLayer.appendChild(dtxt);
      }
      applyHangingChainTranslation(this._hangingChain, body);
      snapRopePins(this.engine);
      return;
    }

    if (this._dragging) {
      if (this.engine.running) return;
      let nx = pt.x - this._dragOffX;
      let ny = pt.y - this._dragOffY;
      if (this._dragging._newtonType === 'wedge') {
        // Place from the pointer, then grid-snap edges (cardinal) or AABB centre.
        if (!this._snapEnabled) {
          nx = Math.round(nx);
          ny = Math.round(ny);
        }
        setWedgeAABBCenter(this._dragging, nx, ny);
        snapWedgeToGrid(this._dragging, this._snapEnabled);
      } else {
        if (this._snapEnabled) {
          nx = snapWorldCoord(nx, true);
          ny = snapWorldCoord(ny, true);
        }
        Body.setPosition(this._dragging, { x: nx, y: ny });
      }
      Body.setVelocity(this._dragging, { x: 0, y: 0 });
      this._dragging.force.x = 0;
      this._dragging.force.y = 0;
      this._dragging.torque = 0;
      applyHangingChainTranslation(this._hangingChain, this._dragging);
      snapRopePins(this.engine);
      return;
    }

    // Rotate tool: spin body about its centre (Ctrl → 5°): wedge uses AABB centre
    if (this._rotating) {
      if (this.engine.running) return;
      const { body, ptr0, angle0, pivot } = this._rotating;
      const cx = pivot?.x ?? body.position.x;
      const cy = pivot?.y ?? body.position.y;
      const dx = pt.x - cx;
      const dy = pt.y - cy;
      if (dx * dx + dy * dy < 4) return;
      let angle = angle0 + (Math.atan2(dy, dx) - ptr0);
      if (e.ctrlKey) angle = snapAngleRad(angle, true);
      Body.setAngle(body, angle);
      if (pivot && body._newtonType === 'wedge') {
        setWedgeAABBCenter(body, pivot.x, pivot.y);
      }
      Body.setAngularVelocity(body, 0);
      body.torque = 0;
      snapRopePins(this.engine);

      this._clearGhost();
      this._drawRotateGhost(body, e.ctrlKey);
      return;
    }

    // Constraint preview: end snaps only to bodies / other constraint ends
    if (this._constraintSrc) {
      this._clearGhost();
      const src = this._constraintSrc;
      const ax = this._constraintDown?.x ?? src.position.x;
      const ay = this._constraintDown?.y ?? src.position.y;
      const hover = findConstraintAttachTarget(this.engine, pt.x, pt.y, {
        excludeBodyId: src.id,
        hitPx: 30,
        snapGrid: this._snapEnabled,
      });
      const bx = hover ? hover.world.x : (this._snapEnabled ? snapWorldCoord(pt.x, true) : pt.x);
      const by = hover ? hover.world.y : (this._snapEnabled ? snapWorldCoord(pt.y, true) : pt.y);
      const len = Math.hypot(bx - ax, by - ay);

      if (this._mode === 'spring') {
        this._ghostLayer.appendChild(this._makeSpringGhost(ax, ay, bx, by));
      } else {
        this._ghostLayer.appendChild(svgEl('line', {
          x1: ax, y1: ay, x2: bx, y2: by,
          stroke: COLORS.ink,
          'stroke-width': this._mode === 'rod' ? 3.5 : 1.5,
          'stroke-dasharray': '6 4',
          opacity: 0.5,
          'stroke-linecap': 'round',
        }));
      }

      if (hover) {
        this._ghostLayer.appendChild(svgEl('circle', {
          cx: bx, cy: by, r: 5,
          fill: '#2d70b3', stroke: '#fff', 'stroke-width': 1.5, opacity: 0.95,
        }));
      }

      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const txt = svgEl('text', {
        x: mx + 8, y: my - 4,
        fill: '#333',
        'font-size': 11,
        'font-family': FONT_DIAGRAM,
      });
      txt.textContent = hover
        ? `${len.toFixed(0)} px`
        : 'Drop on a body or constraint end';
      this._ghostLayer.appendChild(txt);

      this.svg.querySelectorAll('.body-group').forEach(g => {
        const id = parseInt(g.id.replace('body-', ''));
        g.classList.toggle('hover-target', !!(hover && hover.body.id === id));
      });
      return;
    }

    // Ground drag preview (top edge from first click toward cursor, Ctrl = 5° direction snap)
    if (this._groundStart) {
      this._clearGhost();
      const ax = this._groundStart.x;
      const ay = this._groundStart.y;
      const end = this._snapGroundSegmentEnd(ax, ay, pt.x, pt.y, e.ctrlKey);
      if (end.len > 4) {
        this._drawGroundPreview(ax, ay, end.ex, end.ey, end.angle, end.len, e.ctrlKey);
      }
      return;
    }

    // Rope placement preview: end snaps to a body when nearby.
    if (this._ropeStart) {
      this._clearGhost();
      const ax = this._ropeStart.x;
      const ay = this._ropeStart.y;
      const hover = this._ropePreviewEnd(pt);
      const len = Math.hypot(hover.x - ax, hover.y - ay);
      if (len > 4) {
        const nSeg = this._ropeSegOverride
          ?? ropeSegmentCountForLength(len);
        this._drawRopeGhost(ax, ay, hover.x, hover.y, nSeg, hover.attach);
      }
      return;
    }
  }

  /**
   * Ghost preview of a ground slab: solid top walking edge + hatched underside,
   * matching the final placed look so top vs bottom is unambiguous.
   */
  _drawGroundPreview(ax, ay, ex, ey, phi, len, ctrlSnap) {
    const gh = 20;
    // Inward normal (from top edge toward bottom face): same as placement.
    const nx = -Math.sin(phi);
    const ny =  Math.cos(phi);
    const bx1 = ax + gh * nx;
    const by1 = ay + gh * ny;
    const bx2 = ex + gh * nx;
    const by2 = ey + gh * ny;

    const g = svgEl('g', { opacity: '0.85' });

    // Hatched body (underside / thickness)
    g.appendChild(svgEl('polygon', {
      points: `${ax},${ay} ${ex},${ey} ${bx2},${by2} ${bx1},${by1}`,
      fill: 'url(#hatch)',
      stroke: COLORS.ink,
      'stroke-width': 1,
      opacity: 0.9,
    }));

    // Solid top walking surface (matches placed ground)
    g.appendChild(svgEl('line', {
      x1: ax, y1: ay, x2: ex, y2: ey,
      stroke: COLORS.ink,
      'stroke-width': 2.5,
      'stroke-linecap': 'round',
    }));

    // Lighter bottom edge
    g.appendChild(svgEl('line', {
      x1: bx1, y1: by1, x2: bx2, y2: by2,
      stroke: COLORS.ink,
      'stroke-width': 1,
      opacity: 0.45,
      'stroke-linecap': 'round',
    }));

    // Side caps
    g.appendChild(svgEl('line', {
      x1: ax, y1: ay, x2: bx1, y2: by1,
      stroke: COLORS.ink, 'stroke-width': 1, opacity: 0.5,
    }));
    g.appendChild(svgEl('line', {
      x1: ex, y1: ey, x2: bx2, y2: by2,
      stroke: COLORS.ink, 'stroke-width': 1, opacity: 0.5,
    }));

    // Labels: "top" outside the walking face, "bottom" outside the hatched face
    const midTx = (ax + ex) / 2;
    const midTy = (ay + ey) / 2;
    const midBx = (bx1 + bx2) / 2;
    const midBy = (by1 + by2) / 2;
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);

    const mkLabel = (x, y, text, weight = '600') => {
      const t = svgEl('text', {
        x, y,
        fill: COLORS.ink,
        'font-size': 11,
        'font-family': FONT_DIAGRAM,
        'font-weight': weight,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      });
      t.textContent = text;
      return t;
    };
    // Outward from top (= opposite inward normal)
    g.appendChild(mkLabel(midTx - nx * 14, midTy - ny * 14, 'top'));
    g.appendChild(mkLabel(midBx + nx * 14, midBy + ny * 14, 'bottom', '400'));

    // Length / angle along the segment (offset past the end so it doesn't sit on labels)
    const infoX = ex + ux * 28 - nx * 8;
    const infoY = ey + uy * 28 - ny * 8;
    const info = svgEl('text', {
      x: infoX,
      y: infoY - (ctrlSnap ? 6 : 0),
      fill: '#333',
      'font-size': 11,
      'font-family': FONT_DIAGRAM,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    });
    info.textContent = `${len.toFixed(0)} px`;
    g.appendChild(info);
    if (ctrlSnap) {
      const deg = (phi * 180 / Math.PI).toFixed(0);
      const t2 = svgEl('text', {
        x: infoX,
        y: infoY + 10,
        fill: '#666',
        'font-size': 10,
        'font-family': FONT_DIAGRAM,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      });
      t2.textContent = `${deg}° (${SNAP_ANGLE_STEP_5_DEG}° snap)`;
      g.appendChild(t2);
    }

    this._ghostLayer.appendChild(g);
  }

  // ─── Pointer up ────────────────────────────────────────────────

  _onUp(e) {
    if (e.button !== 0) return;

    if (this._camera?.isPanning) {
      this._camera.endPan();
      this._shiftPanning = false;
      this._ignoreNextClick = true;
      this._syncCursorClass();
      this._clearGhost();
      return;
    }

    if (e.target?.closest?.('#vel-handle')) return;

    const pt = this._svgPoint(e);
    this._clearGhost();

    if (this.measurements?.handlePointerUp?.()) {
      this._ignoreNextClick = true;
      return;
    }

    if (this.labels?.handlePointerUp?.()) {
      this._ignoreNextClick = true;
      return;
    }

    if (this._bulkConstraintDrag) {
      this._bulkConstraintDrag = null;
      this._ignoreNextClick = true;
      return;
    }

    // End body drag
    if (this._dragging) {
      this._dragging = null;
      this._pendulumDrag = null;
      this._hangingChain = null;
      this._ignoreNextClick = true;
      return;
    }

    if (this._rotating) {
      const body = this._rotating.body;
      if (body?._newtonType === 'wedge' && this._snapEnabled) {
        snapWedgeToGrid(body, true);
        snapRopePins(this.engine);
      }
      this._rotating = null;
      this._ignoreNextClick = true;
      return;
    }

    // Finish constraint drag: both ends must land on a body / constraint end
    if (this._constraintSrc) {
      const src = this._constraintSrc;
      const dest = findConstraintAttachTarget(this.engine, pt.x, pt.y, {
        excludeBodyId: src.id,
        hitPx: 30,
        snapGrid: this._snapEnabled,
      });
      if (dest && dest.body.id !== src.id) {
        const a = this._constraintDown ?? { x: src.position.x, y: src.position.y };
        const len = Math.hypot(dest.world.x - a.x, dest.world.y - a.y);
        this._addConstraint(src, dest.body, len, {
          pointA: this._constraintSrcLocal ?? { x: 0, y: 0 },
          pointB: dest.local,
        });
      }
      this.svg.querySelector(`#body-${src.id}`)?.classList.remove('selected');
      this.svg.querySelectorAll('.hover-target').forEach(g => g.classList.remove('hover-target'));
      this._constraintSrc = null;
      this._constraintSrcLocal = null;
      this._constraintDown = null;
      return;
    }

    // Finish ground drag
    if (this._groundStart) {
      const ax = this._groundStart.x;
      const ay = this._groundStart.y;
      const end = this._snapGroundSegmentEnd(ax, ay, pt.x, pt.y, e.ctrlKey);
      this._groundStart = null;
      const minLen = 10;
      const gh = 20;
      if (end.len > minLen) {
        // Drag chord = top surface of the slab (local y = -h/2). Centre is half thickness
        // along world inward normal (-sin φ, cos φ) for tangent u = (cos φ, sin φ).
        const mTopX = (ax + end.ex) / 2;
        const mTopY = (ay + end.ey) / 2;
        const phi = end.angle;
        const mx = mTopX + (gh / 2) * (-Math.sin(phi));
        const my = mTopY + (gh / 2) * Math.cos(phi);
        const b = createGround(mx, my, end.len, gh, { angle: phi });
        this.engine.addBody(b);
      }
      return;
    }

    // Finish rope placement: attach ends that landed on bodies, otherwise free.
    if (this._ropeStart) {
      const ax = this._ropeStart.x;
      const ay = this._ropeStart.y;
      const startAttach = this._ropeStart.attach ?? null;
      const hover = this._ropePreviewEnd(pt, startAttach?.body?.id ?? null);
      this._ropeStart = null;
      const ex = hover.x;
      const ey = hover.y;
      const len = Math.hypot(ex - ax, ey - ay);
      if (len > 20) {
        this.onBeforeDrag?.();
        const nSeg = this._ropeSegOverride
          ?? ropeSegmentCountForLength(len);
        this._ropeSegOverride = null;
        const endAttach = hover.attach
          && hover.attach.body?.id !== startAttach?.body?.id
          ? hover.attach
          : null;
        const placed = createFreeRope(this.engine, [{ x: ax, y: ay }, { x: ex, y: ey }], {
          segments: nSeg,
          totalMass: Math.max(0.4, pxToM(len) * 0.5),
          thicknessM: 0.05,
          muK: 0,
          muS: 0,
          attachA: startAttach ? { body: startAttach.body, local: startAttach.local } : null,
          attachB: endAttach ? { body: endAttach.body, local: endAttach.local } : null,
        });
        if (placed.ropeId) this._selectRope(placed.ropeId);
      }
      this.svg.querySelectorAll('.hover-target').forEach(g => g.classList.remove('hover-target'));
      return;
    }

    // Single-click placement tools
    this._handleClick(pt);
  }

  _onLeave(e) {
    if (this._camera?.isPanning) {
      this._camera.endPan();
      this._shiftPanning = false;
      this._syncCursorClass();
    }
    // Only cancel ghost if we're not mid-drag
    if (!this._dragging && !this._bulkConstraintDrag && !this._rotating) {
      this._clearGhost();
    }
  }

  // ─── Click placement ───────────────────────────────────────────

  /** Snap a world coordinate to the minor grid when snap is enabled. */
  _snap(v) { return snapWorldCoord(v, this._snapEnabled); }

  /**
   * End point of the ground **top walking edge** from (sx,sy) toward (ex,ey).
   * Optional grid snap on the raw end, then optional Ctrl: lock direction to 5°
   * increments while keeping the same chord length from the snapped cursor.
   */
  _snapGroundSegmentEnd(sx, sy, exRaw, eyRaw, ctrlLockAngle) {
    const o = snapSegmentFromStart(sx, sy, exRaw, eyRaw, this._snapEnabled, ctrlLockAngle);
    return { ex: o.x, ey: o.y, len: o.len, angle: o.angle };
  }

  /** Bodies that have a meaningful (or editable) orientation. */
  _canRotate(body) {
    if (body?._ropeSegment) return false;
    const t = body?._newtonType;
    return t === 'box' || t === 'ground' || t === 'ball' || t === 'point-mass' || t === 'wedge';
  }

  /** Bodies resized by the scale tool. */
  _canScale(body) {
    if (body?._ropeSegment) return false;
    const t = body?._newtonType;
    return t === 'box' || t === 'point-mass' || t === 'wedge';
  }

  /** Ghost overlay while rotating: radial guide + angle readout. */
  _drawRotateGhost(body, ctrlSnap) {
    const pivot = body._newtonType === 'wedge' ? wedgeAABBCenterWorld(body) : body.position;
    const cx = pivot.x;
    const cy = pivot.y;
    const angle = body.angle;
    const r = Math.max(
      28,
      Math.hypot(body._width ?? body._baseWidth ?? 0, body._height ?? 0) * 0.35,
      (body._radius ?? body.circleRadius ?? 20) + 8,
    );
    const ax = cx + Math.cos(angle) * r;
    const ay = cy + Math.sin(angle) * r;

    this._ghostLayer.appendChild(svgEl('circle', {
      cx, cy, r,
      fill: 'none',
      stroke: '#666',
      'stroke-width': 1,
      'stroke-dasharray': '4 6',
      opacity: 0.7,
    }));
    this._ghostLayer.appendChild(svgEl('line', {
      x1: cx, y1: cy, x2: ax, y2: ay,
      stroke: COLORS.ink,
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      opacity: 0.85,
    }));
    this._ghostLayer.appendChild(svgEl('circle', {
      cx: ax, cy: ay, r: 3.5,
      fill: '#2d70b3',
      stroke: '#fff',
      'stroke-width': 1,
    }));

    const deg = (angle * 180 / Math.PI);
    // Normalize display to (-180, 180]
    let disp = ((deg + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(disp) < 1e-9) disp = 0;
    const label = ctrlSnap
      ? `${disp.toFixed(0)}° (${SNAP_ANGLE_STEP_5_DEG}° snap)`
      : `${disp.toFixed(1)}°`;
    const txt = svgEl('text', {
      x: cx + r + 10,
      y: cy - 4,
      fill: '#333',
      'font-size': 11,
      'font-family': FONT_DIAGRAM,
    });
    txt.textContent = label;
    this._ghostLayer.appendChild(txt);
  }

  _handleClick(pt) {
    if (this._mode === 'pan' || this._mode === 'rotate' || this._mode === 'scale') return;
    switch (this._mode) {
      case 'ball':
        this.engine.addBody(createBall(this._snap(pt.x), this._snap(pt.y)));
        break;
      case 'point-mass':
        this.engine.addBody(createPointMass(this._snap(pt.x), this._snap(pt.y)));
        break;
      case 'box':
        this.engine.addBody(createBox(this._snap(pt.x), this._snap(pt.y)));
        break;
      case 'wedge':
        this.engine.addBody(createWedge(this._snap(pt.x), this._snap(pt.y)));
        break;
      case 'anchor':
        this.engine.addBody(createAnchor(this._snap(pt.x), this._snap(pt.y)));
        break;
      case 'select': {
        const hit = this._bodyPartAt(pt);
        if (hit) this._selectBodyHit(hit);
        else if (!this._constraintAt(pt) && !this._ropeHitAt(pt)
          && !this.measurements?._hitTest?.(pt)
          && !this.labels?._hitTest?.(pt)) {
          this._onSelect(null);
        }
        break;
      }
    }
  }

  // ─── Constraint factory ────────────────────────────────────────

  _addConstraint(bodyA, bodyB, length, attach = {}) {
    if (!bodyA || !bodyB) return;
    let c;
    const opts = {
      length,
      pointA: attach.pointA ?? { x: 0, y: 0 },
      pointB: attach.pointB ?? { x: 0, y: 0 },
    };
    switch (this._mode) {
      case 'string': c = createString(bodyA, bodyB, opts); break;
      case 'rod':    c = createRod(bodyA, bodyB, opts);    break;
      case 'spring': c = createSpring(bodyA, bodyB, opts); break;
    }
    if (c) this.engine.addConstraint(c);
  }

  // ─── Ghost / preview helpers ───────────────────────────────────

  _clearGhost() {
    this._ghostLayer.innerHTML = '';
  }

  _cancelDrag() {
    if (this._camera?.isPanning) this._camera.endPan();
    this._shiftPanning = false;
    this._dragging        = null;
    this._rotating        = null;
    this._pendulumDrag    = null;
    this._hangingChain    = null;
    this._bulkConstraintDrag = null;
    this._constraintSrc  = null;
    this._constraintSrcLocal = null;
    this._constraintDown = null;
    this._groundStart     = null;
    this._ropeStart       = null;
    this._ropeSegOverride = null;
  }

  /** Body under the pointer that a rope end may pin to (not a rope node). */
  _ropeAttachTarget(pt, excludeBodyId = null) {
    return findConstraintAttachTarget(this.engine, pt.x, pt.y, {
      excludeBodyId,
      hitPx: 30,
      snapGrid: this._snapEnabled,
    });
  }

  /**
   * Preview end of a rope stroke: attached world point, or grid-snapped cursor.
   * @returns {{ x: number, y: number, attach: object|null }}
   */
  _ropePreviewEnd(pt, excludeBodyId = null) {
    const exclude = excludeBodyId ?? this._ropeStart?.attach?.body?.id ?? null;
    const attach = this._ropeAttachTarget(pt, exclude);
    this.svg.querySelectorAll('.body-group').forEach(g => {
      const id = parseInt(g.id.replace('body-', ''), 10);
      g.classList.toggle('hover-target', !!(attach && attach.body.id === id));
    });
    if (attach) return { x: attach.world.x, y: attach.world.y, attach };
    let ex = pt.x;
    let ey = pt.y;
    if (this._snapEnabled && this._ropeStart) {
      const snapped = snapSegmentFromStart(this._ropeStart.x, this._ropeStart.y, ex, ey, true);
      ex = snapped.x;
      ey = snapped.y;
    }
    return { x: ex, y: ey, attach: null };
  }

  _drawRopeGhost(ax, ay, ex, ey, nSeg, endAttach) {
    this._ghostLayer.appendChild(svgEl('line', {
      x1: ax, y1: ay, x2: ex, y2: ey,
      stroke: COLORS.ink,
      'stroke-width': 5,
      'stroke-linecap': 'round',
      opacity: 0.5,
    }));
    if (this._ropeStart?.attach) {
      this._ghostLayer.appendChild(svgEl('circle', {
        cx: ax, cy: ay, r: 5,
        fill: '#2d70b3', stroke: '#fff', 'stroke-width': 1.5, opacity: 0.95,
      }));
    }
    if (endAttach) {
      this._ghostLayer.appendChild(svgEl('circle', {
        cx: ex, cy: ey, r: 5,
        fill: '#2d70b3', stroke: '#fff', 'stroke-width': 1.5, opacity: 0.95,
      }));
    }
    const txt = svgEl('text', {
      x: (ax + ex) / 2 + 8, y: (ay + ey) / 2 - 8,
      fill: '#333',
      'font-size': 11,
      'font-family': FONT_DIAGRAM,
    });
    const nAtt = (this._ropeStart?.attach ? 1 : 0) + (endAttach ? 1 : 0);
    const tag = nAtt === 2 ? 'both ends attached' : nAtt === 1 ? 'one end attached' : 'scroll to change';
    txt.textContent = `rope · ${pxToM(Math.hypot(ex - ax, ey - ay)).toFixed(2)} m · ${nSeg} segments · ${tag}`;
    this._ghostLayer.appendChild(txt);
  }

  /**
   * Wheel while placing a rope adjusts segment count (consumes the event).
   * @param {WheelEvent} e
   * @returns {boolean}
   */
  handleWheel(e) {
    if (!this._ropeStart) return false;
    const pt = this._svgPoint(e);
    const ax = this._ropeStart.x;
    const ay = this._ropeStart.y;
    const hover = this._ropePreviewEnd(pt);
    const len = Math.hypot(hover.x - ax, hover.y - ay);
    const base = this._ropeSegOverride ?? ropeSegmentCountForLength(Math.max(len, 20));
    const step = e.deltaY > 0 ? -1 : 1;
    this._ropeSegOverride = clampRopeSegments(base + step);
    this._clearGhost();
    if (len > 4) {
      this._drawRopeGhost(ax, ay, hover.x, hover.y, this._ropeSegOverride, hover.attach);
    }
    return true;
  }

  /**
   * Call when a body is removed outside normal pointer-up paths (e.g. Delete key)
   * so we do not keep dangling references or leave constraint-drag highlights on.
   */
  notifyBodyRemoved(bodyId) {
    this._clearGhost();
    if (this._bulkConstraintDrag?.origins.some(o => o.body.id === bodyId)) {
      this._bulkConstraintDrag = null;
    }
    if (this._dragging?.id === bodyId) {
      this._dragging = null;
      this._pendulumDrag = null;
      this._hangingChain = null;
    }
    if (this._rotating?.body.id === bodyId) {
      this._rotating = null;
    }
    if (this._constraintSrc?.id === bodyId) {
      this.svg.querySelector(`#body-${bodyId}`)?.classList.remove('selected');
      this.svg.querySelectorAll('.hover-target').forEach(g => g.classList.remove('hover-target'));
      this._constraintSrc = null;
      this._constraintSrcLocal = null;
      this._constraintDown = null;
    }
  }

  _makeSpringGhost(ax, ay, bx, by) {
    const { d, strokeWidth } = springPathProps(ax, ay, bx, by, null, {
      coils: 8, ampl: 7.5, strokeWidth: 1.05,
    });
    return svgEl('path', {
      d, fill: 'none', stroke: COLORS.ink,
      'stroke-width': strokeWidth, opacity: 0.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
  }
}
