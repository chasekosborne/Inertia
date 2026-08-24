/**
 * SVG Renderer: draws physics bodies in a physics-textbook diagrammatic style.
 *
 * Coordinate system: Matter.js uses screen coords (y down).
 * The SVG viewport is set to match the container naturally.
 */

import Matter from 'matter-js';
import { getMetricOriginWorldPx } from '../world-origin.js';
import {
  mToPx, DEFAULT_CIRCLE_RADIUS_M, DEFAULT_BALL_RADIUS_M, matterVelToDisplayMS, PX_PER_M,
  getForcePxPerN, getVelocityPxPerMs, getWeightPxPerKg,
} from '../units.js';
import { BOX_FILL_HEX, BOX_STROKE_HEX, boxOutlineStrokePx, circleRingStrokePx, CIRCLE_OUTLINE_STROKE_PX,
         wedgeVertsCentred, wedgeOutlineStrokePx } from '../physics/bodies.js';
import { getAppliedForce } from '../physics/applied-force.js';
import { getAppliedTorque } from '../physics/applied-torque.js';
import {
  bodySpinAngularMomentumSI,
  outOfPlaneGlyphRadius,
  outOfPlaneLGlyphRadius,
} from '../physics/angular.js';
import { FONT_DIAGRAM, COLORS } from '../theme.js';
import { springPathProps } from './spring-path.js';
import { setSvgMathLabel } from '../math-text.js';
import { ropeSelection } from '../physics/rope.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_CIRCLE_R = mToPx(DEFAULT_CIRCLE_RADIUS_M);
const DEFAULT_BALL_R = mToPx(DEFAULT_BALL_RADIUS_M);

/**
 * Shortest arrow the renderer will actually draw (world px). Below this
 * `_drawVector` bails, so nothing is painted.
 *
 * Exported because the v₀ / F handle defers its own shaft to the rendered
 * arrow and must agree on when that arrow exists.
 */
export const VECTOR_MIN_LEN = {
  /** Weight, applied force, friction, spring. */
  default: 6,
  /** Velocity is allowed to render shorter so slow motion still reads. */
  velocity: 2,
};

const STYLE = {
  ink:           COLORS.ink,
  inkLight:      COLORS.inkLight,
  ground:        COLORS.ink,
  anchorStroke:  COLORS.ink,
  stringStroke:  COLORS.ink,
  stringWidth:   1.5,
  rodWidth:      3.5,
  springWidth:   1.05,
  springCoils:   8,
  springAmpl:    7.5,
  gridColor:     '#ebebeb',
  gridColorMajor:'#d4d4d4',
  gridMinor:     10,   // 0.1 m at 100 px/m
  gridMajor:     100,  // 1 m at 100 px/m
  traceColor:    COLORS.ink,
  traceOpacity:  0.25,
  // All force arrows (weight, friction, spring, applied F, …) share this colour
  forceColor:    '#c0392b',
  /** Ignore contacts with negligible relative slip when classifying kinetic direction (m/s). */
  frictionSlipEpsMs:    1e-4,
  // Velocity (kinematic, not a force): same world scale as the v₀ handle
  velColor:      '#2980b9',
  vectorMinLen:  VECTOR_MIN_LEN.default,
  /** Min time a force/velocity label keeps its side before re-picking. */
  vectorLabelHoldMs: 550,
  /** Other side must beat current by at least this score to flip after hold. */
  vectorLabelHysteresis: 0.85,
};

function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Live Matter body eligible for a trajectory trail. */
function _traceBody(b) {
  if (!b || b.isStatic) return false;
  const t = b._newtonType;
  return t !== 'metric-basis' && t !== 'anchor' && t !== 'ground';
}

/** Recorded body snapshot eligible for a trajectory trail. */
function _traceSnap(b) {
  if (!b || b.isStatic) return false;
  const t = b.type;
  return t !== 'metric-basis' && t !== 'anchor' && t !== 'ground';
}

function _aabbOverlapArea(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

function _distPointToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class SvgRenderer {
  /**
   * @param {SVGSVGElement} svg
   * @param {PhysicsEngine} physicsEngine
   */
  constructor(svg, physicsEngine) {
    this.svg    = svg;
    this.engine = physicsEngine;
    this._worldGroup = null;

    this._showGrid    = true;
    this._showVectors = true;
    this._showTraces  = false;
    this._showMetricOrigin = false;
    this._traces      = new Map();   // body.id → { points: [], pathEl }
    this._maxTrace    = 400;

    this._selectedIds = new Set();
    this._selectedPartIndex = null;
    this._selectedRopeId = null;
    this._onSelectCb  = null;
    /** @type {Array<object>} */
    this._vectorObstacles = [];
    /** Sticky perp-side for vector labels: key → { side: 'a'|'b', until: number }. */
    this._vectorLabelSide = new Map();

    this._buildDefs();
    this._buildLayers();
    this._bindResize();
    this.syncMetricOrigin();
  }

  // ─── Public API ────────────────────────────────────────────────

  setShowGrid(v)    {
    this._showGrid = v;
    this._gridLayer.style.display    = v ? '' : 'none';
  }
  get showVectors() { return this._showVectors; }
  setShowVectors(v) {
    this._showVectors = v;
    const disp = v ? '' : 'none';
    this._vectorLayer.style.display = disp;
    if (this._angularVectorLayer) this._angularVectorLayer.style.display = disp;
  }
  setShowTraces(v)  {
    this._showTraces = v;
    this._traceLayer.style.display = v ? '' : 'none';
  }
  get showTraces() { return this._showTraces; }
  /** Max samples kept on a live trail (also the review window length). */
  get maxTrace() { return this._maxTrace; }

  setShowMetricOrigin(v) {
    this._showMetricOrigin = !!v;
    this._applyMetricOriginVisibility();
  }
  get showMetricOrigin() { return this._showMetricOrigin; }

  onSelect(cb) { this._onSelectCb = cb; }

  select(ids, opts = {}) {
    this._selectedIds = new Set(ids);
    this._selectedPartIndex = opts.partIndex ?? null;
    this._selectedRopeId = opts.ropeId ?? null;
    this._applySelection();
  }

  clearSelection() { this.select([]); }

  clearTraces() {
    this._traces.forEach(t => t.pathEl.remove());
    this._traces.clear();
  }

  /** Called every animation frame to sync SVG to world state. */
  render() {
    this.syncMetricOrigin();
    const bodies      = this.engine.bodies;
    const constraints = this.engine.constraints;
    this._syncBodies(bodies);
    this._syncConstraints(constraints);
    if (this._showVectors)  this._syncVectors(bodies);
    // Traces are sampled only while recording (see sampleTraces) or rebuilt
    // from footage in review (see setTracesFromFrames): not every RAF tick.
    this._restackLayers();
  }

  /** Preserve paint order: leaders → constraints → bodies → planar F/v → angular L/τ → labels → UI. */
  _restackLayers() {
    for (const layer of [
      this._gridLayer,
      this._traceLayer,
      this._leaderLayer,
      this._constraintLayer,
      this._bodyLayer,
      this._vectorLayer,
      this._angularVectorLayer,
      this._labelLayer,
      this._interactionGhostLayer,
      this._measureLayer,
      this._uiTopLayer,
    ]) {
      if (layer?.parentNode === this._worldGroup) this._worldGroup.appendChild(layer);
    }
  }

  // ─── Defs ──────────────────────────────────────────────────────

  _buildDefs() {
    const defs = el('defs');

    // ── Grid patterns (tile infinite world space via userSpaceOnUse) ─
    // Minor grid: one cell with a bottom + left edge drawn as a path.
    const minorPat = el('pattern', {
      id: 'grid-minor-pat',
      x: 0, y: 0,
      width: STYLE.gridMinor, height: STYLE.gridMinor,
      patternUnits: 'userSpaceOnUse',
    });
    minorPat.appendChild(el('path', {
      d: `M ${STYLE.gridMinor} 0 L 0 0 0 ${STYLE.gridMinor}`,
      fill: 'none',
      stroke: STYLE.gridColor,
      'stroke-width': 0.5,
    }));
    defs.appendChild(minorPat);

    // Major grid: filled with minor pattern + heavier edges on major cell boundary.
    const majorPat = el('pattern', {
      id: 'grid-major-pat',
      x: 0, y: 0,
      width: STYLE.gridMajor, height: STYLE.gridMajor,
      patternUnits: 'userSpaceOnUse',
    });
    majorPat.appendChild(el('rect', {
      width: STYLE.gridMajor, height: STYLE.gridMajor,
      fill: 'url(#grid-minor-pat)',
    }));
    majorPat.appendChild(el('path', {
      d: `M ${STYLE.gridMajor} 0 L 0 0 0 ${STYLE.gridMajor}`,
      fill: 'none',
      stroke: STYLE.gridColorMajor,
      'stroke-width': 1,
    }));
    defs.appendChild(majorPat);

    // Hatch pattern for ground / fixed surfaces
    const hatch = el('pattern', {
      id: 'hatch', x: '0', y: '0',
      width: '8', height: '8',
      patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    });
    const hLine = el('line', { x1: '0', y1: '0', x2: '0', y2: '8',
      stroke: STYLE.ink, 'stroke-width': '1.5', opacity: '0.35' });
    hatch.appendChild(hLine);
    defs.appendChild(hatch);

    // Ceiling hatch (horizontal lines going up-left)
    const ceilHatch = el('pattern', {
      id: 'ceil-hatch', x: '0', y: '0',
      width: '8', height: '8',
      patternUnits: 'userSpaceOnUse',
    });
    const cLine = el('line', { x1: '0', y1: '0', x2: '8', y2: '8',
      stroke: STYLE.ink, 'stroke-width': '1.2', opacity: '0.4' });
    ceilHatch.appendChild(cLine);
    defs.appendChild(ceilHatch);

    // Force / velocity arrowheads are drawn as polygons in _drawVector (SVG
    // marker-end is unreliable on short shafts and under camera transforms).

    this.svg.insertBefore(defs, this.svg.firstChild);
  }

  // ─── Layers ────────────────────────────────────────────────────

  _buildLayers() {
    this._worldGroup = el('g', { id: 'world-camera' });
    const defs = this.svg.querySelector('defs');
    if (defs?.nextSibling) {
      this.svg.insertBefore(this._worldGroup, defs.nextSibling);
    } else if (defs) {
      this.svg.appendChild(this._worldGroup);
    } else {
      this.svg.appendChild(this._worldGroup);
    }

    this._gridLayer       = this._addLayer('layer-grid');
    this._traceLayer      = this._addLayer('layer-traces');
    // Dotted extension / callout leaders: below constraints and all foreground geometry.
    this._leaderLayer     = this._addLayer('layer-leaders');
    this._leaderLayer.setAttribute('pointer-events', 'none');
    this._constraintLayer = this._addLayer('layer-constraints');
    this._bodyLayer       = this._addLayer('layer-bodies');
    // Planar F/v above fills so tips stay visible; L / τ above those at the COM.
    this._vectorLayer     = this._addLayer('layer-vectors');
    this._angularVectorLayer = this._addLayer('layer-angular-vectors');
    this._angularVectorLayer.setAttribute('pointer-events', 'none');
    this._labelLayer      = this._addLayer('layer-labels');

    // Interaction previews (constraints, ground, …), non-interactive wrapper.
    this._interactionGhostLayer = this._addLayer('layer-interaction-ghost');
    this._interactionGhostLayer.setAttribute('pointer-events', 'none');

    // Length / angle measurement overlays (solid dims + labels, leaders on layer-leaders).
    this._measureLayer = this._addLayer('layer-measurements');
    this._measureLayer.setAttribute('pointer-events', 'none');

    // Constraint/ground anchor dots, velocity handle: must paint above bodies.
    this._uiTopLayer = this._addLayer('layer-ui-top');

    this._drawGrid();

    if (!this._showVectors) {
      this._vectorLayer.style.display = 'none';
      this._angularVectorLayer.style.display = 'none';
    }
    if (!this._showTraces)  this._traceLayer.style.display   = 'none';
  }

  /** Root `<g>` for all simulation graphics (camera transform applied here). */
  get worldGroup() { return this._worldGroup; }

  /** Layer for InteractionHandler ghost previews (`pointer-events: none`). Always below handles. */
  get interactionGhostLayer() { return this._interactionGhostLayer; }

  /** Length / angle measurement overlays. */
  get measureLayer() { return this._measureLayer; }

  /** Dotted leaders for labels and length-measure extension lines. */
  get leaderLayer() { return this._leaderLayer; }

  /** Text labels (symbols, subscripts). */
  get labelLayer() { return this._labelLayer; }

  /** Constraint/ground anchor dots, v₀ handle: always above bodies and constraints. */
  get uiTopLayer() { return this._uiTopLayer; }

  _addLayer(id) {
    const g = el('g', { id });
    this._worldGroup.appendChild(g);
    return g;
  }

  // ─── Grid ──────────────────────────────────────────────────────

  _drawGrid() {
    this._gridLayer.innerHTML = '';
    // Phase-align major 1 m lines with the metric origin (see syncMetricOrigin).
    this._gridFillRect = el('rect', {
      id: 'grid-infinite-fill',
      x: -10000, y: -10000, width: 30000, height: 30000,
      fill: 'url(#grid-major-pat)',
    });
    this._gridLayer.appendChild(this._gridFillRect);
  }

  /** Phase-align 1 m grid lines with the metric-basis body position. */
  syncMetricOrigin() {
    const { x: ox, y: oy } = getMetricOriginWorldPx();
    const G = STYLE.gridMajor;
    const phaseX = ((-ox % G) + G) % G;
    const phaseY = ((-oy % G) + G) % G;
    if (this._gridFillRect) {
      this._gridFillRect.setAttribute('x', String(-10000 - phaseX));
      this._gridFillRect.setAttribute('y', String(-10000 - phaseY));
    }
  }

  _bindResize() {
    // Pattern-based grid tiles infinitely, no resize redraw needed.
  }

  // ─── Bodies ────────────────────────────────────────────────────

  _syncBodies(bodies) {
    const seen = new Set();
    for (const b of bodies) {
      seen.add(b.id);
      let g = this.svg.querySelector(`#body-${b.id}`);
      if (!g) g = this._createBodyGroup(b);
      this._updateBodyGroup(g, b);
    }
    // Remove stale body groups (trails are owned by sampleTraces / setTracesFromFrames).
    for (const g of [...this._bodyLayer.children]) {
      const id = parseInt(g.id.replace('body-', ''));
      if (!seen.has(id)) g.remove();
    }
    const mb = bodies.find(b => b._newtonType === 'metric-basis');
    if (mb) {
      const g = this.svg.querySelector(`#body-${mb.id}`);
      if (g?.parentNode === this._bodyLayer) this._bodyLayer.appendChild(g);
      this._applyMetricOriginVisibility();
    }
  }

  _applyMetricOriginVisibility() {
    const mb = this.engine.bodies.find(b => b._newtonType === 'metric-basis');
    if (!mb) return;
    const g = this.svg.querySelector(`#body-${mb.id}`);
    if (!g) return;
    const show = this._showMetricOrigin;
    g.style.display = show ? '' : 'none';
    g.style.pointerEvents = show ? '' : 'none';
  }

  _createBodyGroup(body) {
    const g = el('g', { id: `body-${body.id}`, class: 'body-group' });
    g.addEventListener('click', e => {
      e.stopPropagation();
      if (body._newtonType === 'metric-basis' && !this._showMetricOrigin) return;
      const partEl = e.target.closest?.('[data-part-index]');
      let partIndex = null;
      if (partEl) {
        const n = parseInt(partEl.getAttribute('data-part-index') ?? '', 10);
        if (Number.isFinite(n)) partIndex = n;
      }
      if (body._ropeSegment && body._ropeId) {
        this._onSelectCb?.(ropeSelection(this.engine, body._ropeId));
        return;
      }
      this._onSelectCb?.({ type: 'body', id: body.id, partIndex });
    });
    this._bodyLayer.appendChild(g);
    if (body._newtonType === 'metric-basis' && !this._showMetricOrigin) {
      g.style.display = 'none';
      g.style.pointerEvents = 'none';
    }
    return g;
  }

  _updateBodyGroup(g, body) {
    g.innerHTML = '';
    const { x, y } = body.position;
    const angle = body.angle;
    const type  = body._newtonType;

    g.setAttribute('transform', `translate(${x},${y}) rotate(${angle * 180 / Math.PI})`);

    if (type === 'compound' || (body.parts && body.parts.length > 1 && type !== 'wedge')) {
      // World-space part outlines (sticky weld).
      g.removeAttribute('transform');
      const start = body.parts.length > 1 ? 1 : 0;

      // Draw former internal rods so the dumbbell link stays visible after welding.
      for (const link of body._weldLinks ?? []) {
        const pa = body.parts[start + link.partA];
        const pb = body.parts[start + link.partB];
        if (!pa || !pb) continue;
        g.appendChild(el('line', {
          x1: pa.position.x, y1: pa.position.y,
          x2: pb.position.x, y2: pb.position.y,
          stroke: STYLE.ink,
          'stroke-width': STYLE.rodWidth,
          'stroke-linecap': 'round',
          class: 'weld-link',
          'pointer-events': 'none',
        }));
      }

      for (let i = start; i < body.parts.length; i++) {
        const part = body.parts[i];
        const partIndex = i - start;
        const meta = body._weldParts?.[partIndex];
        const pType = meta?.type ?? part._partType ?? 'box';
        if (pType === 'point-mass' || pType === 'ball' || part.circleRadius) {
          const r = meta?.radius ?? part._radius ?? part.circleRadius ?? 10;
          const hollow = meta?.hollow === true || part._hollow === true;
          const s = circleRingStrokePx(r);
          const inkFill = pType === 'ball' || pType === 'point-mass';
          g.appendChild(el('circle', {
            cx: part.position.x, cy: part.position.y,
            r: hollow ? Math.max(0.5, r - s / 2) : r,
            fill: hollow ? 'none' : (inkFill ? STYLE.ink : BOX_FILL_HEX),
            stroke: hollow ? STYLE.ink : (inkFill ? 'none' : BOX_STROKE_HEX),
            'stroke-width': hollow || !inkFill ? s : 0,
            class: 'body-shape',
            'data-part-index': partIndex,
          }));
        } else {
          const pts = part.vertices.map(v => `${v.x},${v.y}`).join(' ');
          const s = boxOutlineStrokePx(
            meta?.width ?? (part.bounds.max.x - part.bounds.min.x),
            meta?.height ?? (part.bounds.max.y - part.bounds.min.y),
          );
          g.appendChild(el('polygon', {
            points: pts,
            fill: BOX_FILL_HEX,
            stroke: BOX_STROKE_HEX,
            'stroke-width': Math.max(0.75, s),
            'stroke-linejoin': 'round',
            class: 'body-shape box-body',
            'data-part-index': partIndex,
          }));
        }
      }
      return;
    }
    if (type === 'metric-basis') {
      const arm = body._basisArmPx ?? 36;
      g.appendChild(el('line', {
        x1: 0, y1: 0, x2: arm, y2: 0,
        stroke: STYLE.velColor, 'stroke-width': 3, 'stroke-linecap': 'round',
        class: 'body-shape',
      }));
      g.appendChild(el('line', {
        x1: 0, y1: 0, x2: 0, y2: arm,
        stroke: STYLE.forceColor, 'stroke-width': 3, 'stroke-linecap': 'round',
        class: 'body-shape',
      }));
      return;
    }
    if (type === 'point-mass') {
      if (body._ropeSegment) {
        // Nodes are invisible: the rope is one rounded stroke through centres.
        // Keep a transparent hit target so the chain stays selectable.
        const r = body._radius ?? DEFAULT_CIRCLE_R;
        g.appendChild(el('circle', {
          cx: 0, cy: 0, r,
          fill: 'transparent',
          stroke: 'none',
          class: 'body-shape rope-node',
        }));
        return;
      }
      // Point: filled particle (ink); hollow ring when body._hollow.
      const r = body._radius ?? DEFAULT_CIRCLE_R;
      const s = circleRingStrokePx(r);
      const hollow = body._hollow === true;
      const circle = el('circle', {
        cx: 0, cy: 0, r: hollow ? Math.max(0.5, r - s / 2) : r,
        fill: hollow ? 'none' : STYLE.ink,
        stroke: hollow ? STYLE.ink : 'none',
        'stroke-width': hollow ? s : 0,
        class: hollow ? 'body-shape circle-ring' : 'body-shape point-body',
      });
      g.appendChild(circle);
    } else if (type === 'ball') {
      const r = body._radius ?? DEFAULT_BALL_R;
      const circle = el('circle', {
        cx: 0, cy: 0, r,
        fill: STYLE.ink,
        class: 'body-shape ball-body',
      });
      g.appendChild(circle);
    } else if (type === 'box') {
      const w = body._width  ?? 40;
      const h = body._height ?? 40;
      if (body._ropeSegment) {
        // Legacy box ropes (if any): still square stroke ends.
        const line = el('line', {
          x1: -w / 2,
          y1: 0,
          x2: w / 2,
          y2: 0,
          stroke: STYLE.ink,
          'stroke-width': Math.max(2, h),
          'stroke-linecap': 'butt',
          fill: 'none',
          class: 'body-shape rope-segment',
        });
        g.appendChild(line);
      } else {
        const s = boxOutlineStrokePx(w, h);
        // Inset rect + centred stroke so the stroke’s outer edge matches Matter’s bounds.
        const rect = el('rect', {
          x: -w / 2 + s / 2,
          y: -h / 2 + s / 2,
          width: w - s,
          height: h - s,
          fill: BOX_FILL_HEX,
          stroke: BOX_STROKE_HEX,
          'stroke-width': s,
          class: 'body-shape box-body',
        });
        g.appendChild(rect);
      }
    } else if (type === 'wedge') {
      // Hollow outline whose OUTER edge sits on the Matter triangle (grid-aligned).
      // Clip the stroke to the triangle so only the inward half is painted — that
      // way the outer edge stays on the physics bounds even if CSS tweaks stroke-width.
      const W = body._baseWidth ?? 40;
      const H = body._height ?? 40;
      const s = wedgeOutlineStrokePx(W, H);
      const { flipX, flipY } = body._wedgeFlipX || body._wedgeFlipY
        ? { flipX: body._wedgeFlipX === true, flipY: body._wedgeFlipY === true }
        : { flipX: false, flipY: false };
      const verts = wedgeVertsCentred(W, H, flipX, flipY);
      const pts = verts.map(v => `${v.x},${v.y}`).join(' ');
      const clipId = `wedge-clip-${body.id}`;
      const clip = el('clipPath', { id: clipId });
      clip.appendChild(el('polygon', { points: pts }));
      g.appendChild(clip);
      g.appendChild(el('polygon', {
        points: pts,
        fill: 'none',
        stroke: STYLE.ink,
        'stroke-width': 2 * s,
        'stroke-linejoin': 'miter',
        'stroke-miterlimit': '8',
        'clip-path': `url(#${clipId})`,
        class: 'body-shape wedge-body wedge-ring',
      }));
    } else if (type === 'anchor') {
      // Inverted triangle on pivot circle at body.position
      g.removeAttribute('transform'); // anchor uses absolute coords
      this._drawAnchor(g, x, y);
      return;
    } else if (type === 'ground') {
      const w = body._width  ?? 400;
      const h = body._height ?? 20;
      g.appendChild(el('line', {
        x1: -w / 2, y1: -h / 2,
        x2: w / 2, y2: -h / 2,
        stroke: STYLE.ink, 'stroke-width': 2,
        class: 'body-shape',
      }));
      g.appendChild(el('rect', {
        x: -w / 2, y: -h / 2,
        width: w, height: h,
        fill: 'url(#hatch)',
      }));
      return;
    } else {
      // Generic fallback: convex hull
      const verts = body.vertices;
      if (verts?.length) {
        const pts = verts.map(v => `${v.x - x},${v.y - y}`).join(' ');
        g.appendChild(el('polygon', { points: pts, fill: STYLE.ink, class: 'body-shape' }));
      }
    }
  }

  _drawAnchor(g, x, y) {
    const r = 4;
    const size = 14;
    const triH = size * 1.4;
    // Inverted triangle above pivot circle; hinge at circle centre (x, y).
    g.appendChild(el('polygon', {
      points: `${x},${y - r} ${x - size},${y - r - triH} ${x + size},${y - r - triH}`,
      fill: 'none', stroke: STYLE.ink, 'stroke-width': 2,
      class: 'body-shape',
    }));
    g.appendChild(el('circle', {
      cx: x, cy: y, r,
      fill: '#fff', stroke: STYLE.ink, 'stroke-width': 2,
    }));
  }

  // ─── Constraints ───────────────────────────────────────────────

  _syncConstraints(constraints) {
    const seen = new Set();
    const ropeLinks = [];
    for (const c of constraints) {
      seen.add(c.id);
      if (c._ropeLink) ropeLinks.push(c);
      let g = this.svg.querySelector(`#constraint-${c.id}`);
      if (!g) g = this._createConstraintGroup(c);
      this._updateConstraintGroup(g, c);
    }
    this._syncRopeStrokes(ropeLinks);
    for (const g of [...this._constraintLayer.children]) {
      if (g.id.startsWith('rope-stroke-')) continue;
      const id = parseInt(g.id.replace('constraint-', ''));
      if (!seen.has(id)) g.remove();
    }
  }

  /**
   * One rounded polyline per rope so joints sit flush (no faceted sticks).
   * @param {object[]} links
   */
  _syncRopeStrokes(links) {
    const byId = new Map();
    for (const c of links) {
      const id = c._ropeId || `anon-${c.id}`;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(c);
    }
    const seenDom = new Set();
    for (const [ropeId, segs] of byId) {
      segs.sort((a, b) => (a.bodyA?._ropeIndex ?? 0) - (b.bodyA?._ropeIndex ?? 0));
      const pts = [];
      const p0 = this._constraintPoint(segs[0], 'A');
      if (p0) pts.push(p0);
      for (const c of segs) {
        const pB = this._constraintPoint(c, 'B');
        if (pB) pts.push(pB);
      }
      if (pts.length < 2) continue;
      const thick = Math.max(
        2,
        2 * (segs[0].bodyA?._radius ?? segs[0].bodyB?._radius ?? 2.5),
      );
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const domId = `rope-stroke-${String(ropeId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      seenDom.add(domId);
      let g = this._constraintLayer.querySelector(`#${CSS.escape(domId)}`);
      if (!g) {
        g = el('g', { id: domId, class: 'rope-stroke', 'pointer-events': 'none' });
        this._constraintLayer.insertBefore(g, this._constraintLayer.firstChild);
      }
      g.innerHTML = '';
      g.classList.toggle('selected', this._selectedRopeId === ropeId
        || (this._selectedRopeId == null && segs.some(c => this._selectedIds.has(c.bodyA?.id) || this._selectedIds.has(c.bodyB?.id))));
      g.appendChild(el('path', {
        d,
        fill: 'none',
        stroke: STYLE.ink,
        'stroke-width': thick,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        class: 'rope-stroke-path',
      }));
    }
    for (const g of [...this._constraintLayer.querySelectorAll('[id^="rope-stroke-"]')]) {
      if (!seenDom.has(g.id)) g.remove();
    }
  }

  _createConstraintGroup(c) {
    const g = el('g', { id: `constraint-${c.id}`, class: 'constraint-group' });
    g.addEventListener('click', e => {
      e.stopPropagation();
      if (c._ropeLink) {
        const ropeId = c._ropeId ?? c.bodyA?._ropeId ?? c.bodyB?._ropeId;
        if (ropeId) this._onSelectCb?.(ropeSelection(this.engine, ropeId));
        return;
      }
      this._onSelectCb?.({ type: 'constraint', id: c.id });
    });
    this._constraintLayer.appendChild(g);
    return g;
  }

  _updateConstraintGroup(g, c) {
    g.innerHTML = '';
    const pA = this._constraintPoint(c, 'A');
    const pB = this._constraintPoint(c, 'B');
    if (!pA || !pB) return;

    // Rope: visible stroke is the shared polyline, this group is pick-only.
    if (c._ropeLink) {
      g.style.display = '';
      const thick = Math.max(
        2,
        2 * (c.bodyA?._radius ?? c.bodyB?._radius ?? 2.5),
      );
      g.appendChild(el('line', {
        x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y,
        stroke: 'transparent',
        'stroke-width': Math.max(14, thick + 8),
        'stroke-linecap': 'round',
        class: 'rope-segment-hit',
      }));
      return;
    }

    g.style.display = '';
    const type = c._newtonType;

    if (type === 'spring') {
      const visSpring = this._makeSpringPath(pA, pB, c.length);
      g.appendChild(visSpring);
      // Wide hit target so springs can be selected to edit k / rest length.
      const dPath = visSpring.getAttribute('d');
      if (dPath) {
        g.appendChild(el('path', {
          d: dPath,
          fill: 'none',
          stroke: 'transparent',
          'stroke-width': 22,
          'pointer-events': 'stroke',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          class: 'constraint-hit',
        }));
      }
    } else {
      const lineW = type === 'rod' ? STYLE.rodWidth : STYLE.stringWidth;
      const dash  = type === 'string' ? '' : '';
      const line  = el('line', {
        x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y,
        stroke: STYLE.ink,
        'stroke-width': lineW,
        'stroke-linecap': 'round',
      });
      if (dash) line.setAttribute('stroke-dasharray', dash);
      g.appendChild(line);
      g.appendChild(el('line', {
        x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y,
        stroke: 'transparent',
        'stroke-width': 20,
        'pointer-events': 'stroke',
        'stroke-linecap': 'round',
        class: 'constraint-hit',
      }));
    }
  }

  _constraintPoint(c, which) {
    const body  = which === 'A' ? c.bodyA : c.bodyB;
    const local = which === 'A' ? c.pointA : c.pointB;
    if (body) {
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      return {
        x: body.position.x + cos * local.x - sin * local.y,
        y: body.position.y + sin * local.x + cos * local.y,
      };
    }
    return local ? { ...local } : null;
  }

  _makeSpringPath(pA, pB, restLen = null) {
    const { d, strokeWidth } = springPathProps(pA.x, pA.y, pB.x, pB.y, restLen, {
      coils: STYLE.springCoils,
      ampl: STYLE.springAmpl,
      strokeWidth: STYLE.springWidth,
    });
    return el('path', {
      d,
      fill: 'none',
      stroke: STYLE.ink,
      'stroke-width': strokeWidth,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    });
  }

  // ─── Force vectors ─────────────────────────────────────────────

  _syncVectors(bodies) {
    this._vectorLayer.innerHTML = '';
    if (this._angularVectorLayer) this._angularVectorLayer.innerHTML = '';
    this._vectorObstacles = this._collectVectorObstacles(bodies);
    /** @type {Set<string>} */
    const labelKeysSeen = new Set();

    for (const b of bodies) {
      if (b.isStatic) continue;
      // Rope segments are the rope itself: skip per-piece force clutter.
      if (b._ropeSegment) continue;

      // Always place body vectors at the mass centre (compound COM = body.position).
      let px = b.position.x;
      let py = b.position.y;
      if (b._newtonType === 'compound' && b.parts?.length > 1) {
        let M = 0;
        let sx = 0;
        let sy = 0;
        for (const p of b.parts.slice(1)) {
          const m = p.mass;
          if (!(m > 0)) continue;
          M += m;
          sx += m * p.position.x;
          sy += m * p.position.y;
        }
        if (M > 0) {
          px = sx / M;
          py = sy / M;
        }
      }

      // ── Weight W (red): only when gravity field is active (scale × direction ≠ 0)
      const g = this.engine.gravity;
      const gStrength = (g.scale ?? 0) * Math.hypot(g.x ?? 0, g.y ?? 0);
      if (gStrength > 1e-12) {
        const wLen = b.mass * getWeightPxPerKg();
        const gMag = Math.hypot(g.x, g.y) || 1;
        const wex  = px + (g.x / gMag) * wLen;
        const wey  = py + (g.y / gMag) * wLen;
        this._drawVector(px, py, wex, wey, STYLE.forceColor, 'W', {
          stickyKey: `${b.id}:W`,
          _labelKeysSeen: labelKeysSeen,
        });
      }

      // ── Applied pull F (blue): constant force at θ above +x ──
      const af = getAppliedForce(b);
      if (af) {
        const rad = af.thetaDeg * Math.PI / 180;
        const len = af.F * getForcePxPerN();
        // Matter y-down: +θ (up) → negative y tip
        const fex = px + Math.cos(rad) * len;
        const fey = py - Math.sin(rad) * len;
        this._drawVector(px, py, fex, fey, STYLE.forceColor, 'F', {
          stickyKey: `${b.id}:F`,
          _labelKeysSeen: labelKeysSeen,
        });
      }

      // ── Friction (kinetic fₖ or static F_st) ──────────────────
      const fFric = this._frictionDisplayVector(b);
      if (fFric) {
        this._drawVector(
          px, py, px + fFric.x, py + fFric.y,
          STYLE.forceColor, fFric.label,
          { stickyKey: `${b.id}:fric`, _labelKeysSeen: labelKeysSeen },
        );
      }

      // ── Velocity v (blue, not a force): SI m/s → world px like v₀ handle
      const { vxMs, vyMs } = matterVelToDisplayMS(b.velocity.x, b.velocity.y);
      const speed = Math.hypot(vxMs, vyMs);
      if (speed > 1e-9) {
        const vPx = getVelocityPxPerMs();
        const vex = px + vxMs * vPx;
        const vey = py - vyMs * vPx;
        this._drawVector(px, py, vex, vey, STYLE.velColor, 'v', {
          minLen: VECTOR_MIN_LEN.velocity,
          stickyKey: `${b.id}:v`,
          _labelKeysSeen: labelKeysSeen,
        });
      }

      // ── Spin angular momentum L (⊙/⊗) on top of the body fill ──
      let hasL = false;
      const locked = b.inertia === Infinity || b._lockRotation === true;
      if (!locked) {
        const L = bodySpinAngularMomentumSI(b);
        hasL = L != null && Math.abs(L) > 1e-6;
        if (hasL) {
          const r = outOfPlaneLGlyphRadius(Math.abs(L));
          this._drawOutOfPlaneGlyph(px, py, Math.sign(L), STYLE.velColor, r, 'L', {
            stickyKey: `${b.id}:L`,
            _labelKeysSeen: labelKeysSeen,
          });
        }
      }
      const tau = getAppliedTorque(b);
      if (tau != null && Math.abs(tau) > 1e-9) {
        const r = outOfPlaneGlyphRadius(Math.abs(tau), 3.5, 1.4, 8);
        // Keep τ off the COM when L is shown so the glyphs do not stack.
        const ox = hasL ? -(r + 8) : 0;
        const oy = hasL ? -(r + 5) : 0;
        this._drawOutOfPlaneGlyph(px + ox, py + oy, Math.sign(tau), STYLE.forceColor, r, 'τ', {
          stickyKey: `${b.id}:tau`,
          _labelKeysSeen: labelKeysSeen,
        });
      }
    }

    // ── Spring restoring force F_sp = −k Δx (red) on each free end ──
    this._drawSpringRestoringVectors(labelKeysSeen);
    this._pruneVectorLabelSides(labelKeysSeen);
  }

  /**
   * Out-of-plane vector glyph at (cx, cy).
   * sign > 0 → out of screen (⊙), sign < 0 → into screen (⊗).
   * Painted on {@link _angularVectorLayer} (above bodies).
   * @param {number} cx
   * @param {number} cy
   * @param {number} sign
   * @param {string} color
   * @param {number} r
   * @param {string} [label]
   * @param {{ stickyKey?: string, _labelKeysSeen?: Set<string> }} [opts]
   */
  _drawOutOfPlaneGlyph(cx, cy, sign, color, r, label, opts = {}) {
    const strokeW = Math.max(1, Math.min(1.25, r * 0.18));
    const layer = this._angularVectorLayer ?? this._vectorLayer;
    const g = el('g', { class: 'vector-oop', 'pointer-events': 'none' });
    g.appendChild(el('circle', {
      cx, cy, r,
      fill: 'none',
      stroke: color,
      'stroke-width': strokeW,
    }));
    if (sign > 0) {
      // Out of screen: center dot
      g.appendChild(el('circle', {
        cx, cy, r: Math.max(1.1, r * 0.22),
        fill: color,
        stroke: 'none',
      }));
    } else {
      // Into screen: ×
      const s = r * 0.55;
      g.appendChild(el('line', {
        x1: cx - s, y1: cy - s, x2: cx + s, y2: cy + s,
        stroke: color, 'stroke-width': strokeW, 'stroke-linecap': 'round',
      }));
      g.appendChild(el('line', {
        x1: cx + s, y1: cy - s, x2: cx - s, y2: cy + s,
        stroke: color, 'stroke-width': strokeW, 'stroke-linecap': 'round',
      }));
    }
    layer.appendChild(g);
    if (label) {
      const below = { x: cx, y: cy + r + 6 };
      const above = { x: cx, y: cy - r - 6 };
      const box = (p) => this._vectorLabelBox(p.x, p.y, label);
      const scoreBelow = this._scoreVectorLabelBox(box(below));
      const scoreAbove = this._scoreVectorLabelBox(box(above));
      const side = this._pickStickyLabelSide(
        opts.stickyKey, scoreBelow, scoreAbove, true, opts._labelKeysSeen,
      );
      const pick = side === 'a' ? below : above;
      const txt = el('text', {
        x: pick.x, y: pick.y,
        fill: color,
        'font-size': 7,
        'font-family': FONT_DIAGRAM,
        'font-style': 'italic',
        'text-anchor': 'middle',
        'dominant-baseline': pick === below ? 'hanging' : 'auto',
      });
      setSvgMathLabel(txt, label);
      layer.appendChild(txt);
      this._vectorObstacles.push({ kind: 'aabb', ...box(pick) });
    }
  }

  /**
   * Diagrammatic Hookean restoring force for each spring.
   * F_sp = −k·Δx along the spring axis (damping omitted: restoring force only).
   * @param {Set<string>} [labelKeysSeen]
   */
  _drawSpringRestoringVectors(labelKeysSeen) {
    for (const c of this.engine.constraints) {
      if (c._newtonType !== 'spring') continue;

      const pA = this._constraintPoint(c, 'A');
      const pB = this._constraintPoint(c, 'B');
      if (!pA || !pB) continue;

      const dx = pB.x - pA.x;
      const dy = pB.y - pA.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;

      const nx = dx / len;
      const ny = dy / len;
      const restPx = c.length ?? len;
      const extM = (len - restPx) / PX_PER_M;
      const kNm = c._kNm ?? 40;
      // Signed newton: + when stretched (pulls ends together)
      const F_N = kNm * extM;
      if (!isFinite(F_N) || Math.abs(F_N) < 1e-6) continue;

      const arrowPx = F_N * getForcePxPerN();
      // Body A: +F along n when stretched, body B: opposite
      if (c.bodyA && !c.bodyA.isStatic) {
        const ox = c.bodyA.position.x;
        const oy = c.bodyA.position.y;
        this._drawVector(
          ox, oy,
          ox + arrowPx * nx, oy + arrowPx * ny,
          STYLE.forceColor, 'F_sp',
          { stickyKey: `${c.bodyA.id}:F_sp`, _labelKeysSeen: labelKeysSeen },
        );
      }
      if (c.bodyB && !c.bodyB.isStatic) {
        const ox = c.bodyB.position.x;
        const oy = c.bodyB.position.y;
        this._drawVector(
          ox, oy,
          ox - arrowPx * nx, oy - arrowPx * ny,
          STYLE.forceColor, 'F_sp',
          { stickyKey: `${c.bodyB.id}:F_sp`, _labelKeysSeen: labelKeysSeen },
        );
      }
    }
  }

  /**
   * Friction vector in display space (pixels), same force scale as W / F_sp.
   *
   * Driven by the Coulomb solver’s last applied contact (`body._fricVis`) so
   * we never invent arrows from noisy SAT overlaps the solver skipped
   * (launch frames, glancing chatter, etc.).
   */
  _frictionDisplayVector(body) {
    const vis = body?._fricVis;
    if (!vis) return null;

    const { tx, ty, kinetic, cos, muK, muS, F_load_t, P } = vis;
    if (!isFinite(tx) || !isFinite(ty)) return null;

    const forcePx = getForcePxPerN();
    const Wdisp = body.mass * getWeightPxPerKg();
    const Ndisp = Math.max(0, Wdisp * Math.min(1, Math.max(0, cos)));

    let fMag;
    let dir;
    if (kinetic) {
      fMag = muK * Ndisp;
      dir = Math.abs(P) < 1e-18 ? 0 : Math.sign(P);
    } else {
      const loadDisp = Math.abs(F_load_t) * (forcePx / (PX_PER_M / 1e6));
      fMag = Math.min(muS * Ndisp, loadDisp);
      dir = Math.abs(P) > 1e-18
        ? Math.sign(P)
        : (Math.abs(F_load_t) < 1e-18 ? 0 : -Math.sign(F_load_t));
    }

    if (dir === 0 || !(fMag > 1e-9)) return null;

    const sx = dir * tx * fMag;
    const sy = dir * ty * fMag;
    const rawLen = Math.hypot(sx, sy);
    if (!isFinite(rawLen) || rawLen < STYLE.vectorMinLen * 0.2) return null;

    return { x: sx, y: sy, label: kinetic ? 'f_k' : 'F_st' };
  }

  /**
   * Draw a planar force / velocity arrow (shaft + filled triangular head).
   * Heads are polygons rather than SVG markers so they stay visible on short
   * shafts and under the camera transform.
   */
  _drawVector(x1, y1, x2, y2, color, label, opts = {}) {
    const minLen = opts.minLen ?? STYLE.vectorMinLen;
    const showTip = opts.showTip !== false;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < minLen) return;

    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    // Scale head with length so short arrows keep a visible tip (never longer than the shaft).
    const headLen = showTip ? Math.min(6, Math.max(2.5, len * 0.32)) : 0;
    const tipLen = Math.min(headLen, len * 0.45);
    const headHalf = tipLen * 0.45;
    const stopX = x2 - ux * tipLen;
    const stopY = y2 - uy * tipLen;

    this._vectorLayer.appendChild(el('line', {
      x1, y1, x2: stopX, y2: stopY,
      stroke: color, 'stroke-width': 1,
      'stroke-linecap': 'round',
      class: 'vector-arrow',
    }));
    this._vectorObstacles.push({ kind: 'seg', a: { x: x1, y: y1 }, b: { x: stopX, y: stopY } });

    if (showTip && tipLen > 0) {
      const nx = -uy;
      const ny = ux;
      const d = [
        `M${stopX + nx * headHalf},${stopY + ny * headHalf}`,
        `L${x2},${y2}`,
        `L${stopX - nx * headHalf},${stopY - ny * headHalf}`,
        'Z',
      ].join(' ');
      this._vectorLayer.appendChild(el('path', {
        d, fill: color, class: 'vector-arrow',
      }));
    }

    if (!label) return;

    // Label near the tip: sticky perp side (hold + hysteresis) to avoid flicker.
    const off = 10;
    const a = { x: x2 + uy * off, y: y2 - ux * off };
    const b = { x: x2 - uy * off, y: y2 + ux * off };
    const boxA = this._vectorLabelBox(a.x, a.y, label);
    const boxB = this._vectorLabelBox(b.x, b.y, label);
    const scoreA = this._scoreVectorLabelBox(boxA);
    const scoreB = this._scoreVectorLabelBox(boxB);
    const tiePreferA = a.y <= b.y;
    const side = this._pickStickyLabelSide(
      opts.stickyKey, scoreA, scoreB, tiePreferA, opts._labelKeysSeen,
    );
    const pick = side === 'a' ? a : b;
    const box = side === 'a' ? boxA : boxB;
    const txt = el('text', {
      x: pick.x, y: pick.y,
      fill: color,
      'font-size': 9,
      'font-family': FONT_DIAGRAM,
      'font-style': 'italic',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    });
    setSvgMathLabel(txt, label);
    this._vectorLayer.appendChild(txt);
    this._vectorObstacles.push({ kind: 'aabb', ...box });
  }

  /**
   * Choose label side 'a' or 'b' with cooldown + hysteresis so overlap
   * avoidance does not flip every frame while scores chatter.
   * @param {string|undefined} key
   * @param {number} scoreA  lower is better
   * @param {number} scoreB
   * @param {boolean} tiePreferA
   * @param {Set<string>|undefined} seen
   * @returns {'a'|'b'}
   */
  _pickStickyLabelSide(key, scoreA, scoreB, tiePreferA, seen) {
    const ideal = scoreA < scoreB || (scoreA === scoreB && tiePreferA) ? 'a' : 'b';
    if (!key) return ideal;
    seen?.add(key);

    const now = performance.now();
    const prev = this._vectorLabelSide.get(key);
    if (!prev) {
      this._vectorLabelSide.set(key, { side: ideal, until: now + STYLE.vectorLabelHoldMs });
      return ideal;
    }

    if (now < prev.until) return prev.side;

    const curScore = prev.side === 'a' ? scoreA : scoreB;
    const altScore = prev.side === 'a' ? scoreB : scoreA;
    if (altScore < curScore - STYLE.vectorLabelHysteresis) {
      this._vectorLabelSide.set(key, {
        side: prev.side === 'a' ? 'b' : 'a',
        until: now + STYLE.vectorLabelHoldMs,
      });
      return prev.side === 'a' ? 'b' : 'a';
    }

    // Refresh hold while keeping the current side.
    prev.until = now + STYLE.vectorLabelHoldMs;
    return prev.side;
  }

  /** Drop sticky entries for labels that were not drawn this frame. */
  _pruneVectorLabelSides(seen) {
    for (const key of this._vectorLabelSide.keys()) {
      if (!seen.has(key)) this._vectorLabelSide.delete(key);
    }
  }

  /**
   * Geometry that vector labels should avoid: bodies, constraints, prior arrows/labels.
   * @param {import('matter-js').Body[]} bodies
   */
  _collectVectorObstacles(bodies) {
    /** @type {Array<{ kind: 'aabb', x0: number, y0: number, x1: number, y1: number }|{ kind: 'seg', a: {x:number,y:number}, b: {x:number,y:number} }>} */
    const out = [];
    for (const body of bodies) {
      if (body._newtonType === 'metric-basis' && !this._showMetricOrigin) continue;
      const bb = body.bounds;
      if (!bb) continue;
      out.push({ kind: 'aabb', x0: bb.min.x, y0: bb.min.y, x1: bb.max.x, y1: bb.max.y });
    }
    for (const c of this.engine.constraints) {
      const pA = this._constraintPoint(c, 'A');
      const pB = this._constraintPoint(c, 'B');
      if (pA && pB) out.push({ kind: 'seg', a: pA, b: pB });
    }
    return out;
  }

  /** Approximate AABB for a vector symbol near (cx, cy). */
  _vectorLabelBox(cx, cy, label) {
    const n = String(label ?? '').length;
    const hw = Math.max(7, n * 3.4);
    const hh = 6.5;
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
  }

  /** Lower is better. Counts overlaps and how much they cover the label box. */
  _scoreVectorLabelBox(box) {
    let score = 0;
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const pad = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.45;
    for (const o of this._vectorObstacles) {
      if (o.kind === 'aabb') {
        const area = _aabbOverlapArea(box, o);
        if (area > 0) score += 1 + area * 0.04;
      } else if (o.kind === 'seg') {
        const d = _distPointToSeg(cx, cy, o.a.x, o.a.y, o.b.x, o.b.y);
        if (d < pad) score += 1 + (pad - d) * 0.15;
      }
    }
    return score;
  }

  // ─── Traces ────────────────────────────────────────────────────

  /**
   * Append one sample per dynamic body. Call once per recorded frame so the
   * disappear window (_maxTrace) only advances while capturing.
   * @param {import('matter-js').Body[]} bodies
   */
  sampleTraces(bodies) {
    if (!this._showTraces) return;
    const liveIds = new Set();
    for (const b of bodies) {
      if (!_traceBody(b)) continue;
      liveIds.add(b.id);
      this._ensureTrace(b.id);
      const t = this._traces.get(b.id);
      t.points.push({ x: b.position.x, y: b.position.y });
      if (t.points.length > this._maxTrace) t.points.shift();
      this._paintTrace(t);
    }
    // Drop trails for bodies that left the world (e.g. welded away).
    for (const [id, t] of [...this._traces]) {
      if (liveIds.has(id)) continue;
      t.pathEl.remove();
      this._traces.delete(id);
    }
  }

  /**
   * Rebuild trails from recorded frames up to `endIdx` (inclusive), keeping
   * only the last `_maxTrace` samples: playback of the path as filmed.
   * @param {object[]} frames
   * @param {number} endIdx
   */
  setTracesFromFrames(frames, endIdx) {
    this.clearTraces();
    if (!this._showTraces || !frames?.length || endIdx < 0) return;
    const last = Math.min(endIdx, frames.length - 1);
    const start = Math.max(0, last - this._maxTrace + 1);

    /** @type {Map<number|string, { x: number, y: number }[]>} */
    const byId = new Map();
    for (let i = start; i <= last; i++) {
      const bodies = frames[i]?.bodies;
      if (!bodies) continue;
      for (const b of bodies) {
        if (!_traceSnap(b)) continue;
        let pts = byId.get(b.id);
        if (!pts) {
          pts = [];
          byId.set(b.id, pts);
        }
        pts.push({ x: b.x, y: b.y });
      }
    }

    for (const [id, points] of byId) {
      this._ensureTrace(id);
      const t = this._traces.get(id);
      t.points = points;
      this._paintTrace(t);
    }
  }

  /** @param {number|string} id */
  _ensureTrace(id) {
    if (this._traces.has(id)) return;
    const pathEl = el('path', {
      fill: 'none',
      stroke: STYLE.traceColor,
      'stroke-width': 1,
      'stroke-dasharray': '3 3',
      opacity: STYLE.traceOpacity,
      class: 'trace-path',
    });
    this._traceLayer.appendChild(pathEl);
    this._traces.set(id, { points: [], pathEl });
  }

  /** @param {{ points: {x:number,y:number}[], pathEl: SVGPathElement }} t */
  _paintTrace(t) {
    if (t.points.length < 2) {
      t.pathEl.setAttribute('d', '');
      return;
    }
    const d = t.points.reduce((acc, p, i) =>
      acc + (i === 0 ? `M ${p.x} ${p.y}` : ` L ${p.x} ${p.y}`), '');
    t.pathEl.setAttribute('d', d);
  }

  // ─── Selection ─────────────────────────────────────────────────

  _applySelection() {
    this.svg.querySelectorAll('.body-group, .constraint-group, .rope-stroke').forEach(g => {
      g.classList.remove('selected');
    });
    this.svg.querySelectorAll('.body-shape.selected-part').forEach(n => {
      n.classList.remove('selected-part');
    });
    for (const id of this._selectedIds) {
      const g = this.svg.querySelector(`#body-${id}`) || this.svg.querySelector(`#constraint-${id}`);
      if (g) g.classList.add('selected');
      if (g && this._selectedPartIndex != null) {
        const part = g.querySelector(`[data-part-index="${this._selectedPartIndex}"]`);
        if (part) part.classList.add('selected-part');
      }
    }
    if (this._selectedRopeId) {
      const domId = `rope-stroke-${String(this._selectedRopeId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      this.svg.querySelector(`#${CSS.escape(domId)}`)?.classList.add('selected');
    }
  }
}
