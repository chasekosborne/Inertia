/**
 * SVG Exporter: converts Recorder frames into a self-contained animated SVG.
 *
 * Uses SMIL <animate> / <animateTransform> elements which are supported in
 * all modern browsers (Firefox, Safari, Chrome, Edge) and vector tools
 * (Inkscape, Illustrator, Affinity Designer).
 *
 * The output is a single .svg file that plays back the recorded simulation
 * as a looping vector animation.
 */

import {
  mToPx,
  DEFAULT_CIRCLE_RADIUS_M,
  DEFAULT_BALL_RADIUS_M,
  matterVelToDisplayMS,
  getVelocityPxPerMs,
  getWeightPxPerKg,
} from '../units.js';
import { BOX_FILL_HEX, BOX_STROKE_HEX, boxOutlineStrokePx, circleRingStrokePx, CIRCLE_OUTLINE_STROKE_PX,
         wedgeVertsCentred, insetPolygonVerts, wedgeOutlineStrokePx,
         ANCHOR_PIVOT_R, ANCHOR_STROKE_PX, anchorTriangleLocalVerts } from '../physics/bodies.js';
import { FONT_DIAGRAM, COLORS } from '../theme.js';
import { springPathProps } from '../renderer/spring-path.js';
import { appendDrivenPivotGlyph } from '../renderer/svg-renderer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_CIRCLE_R = mToPx(DEFAULT_CIRCLE_RADIUS_M);
const DEFAULT_BALL_R = mToPx(DEFAULT_BALL_RADIUS_M);

const INK  = COLORS.ink;
const AMPL  = 7.5;
const COILS = 8;

function el(tag, attrs = {}, ns = SVG_NS) {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function smilValues(keyValues, keyTimes, duration) {
  return {
    values:    keyValues.join(';'),
    keyTimes:  keyTimes.join(';'),
    dur:       `${duration.toFixed(3)}s`,
    repeatCount: 'indefinite',
    calcMode:  'linear',
    begin:     '0s',
  };
}

/**
 * @param {object[]} frames - from Recorder.frames
 * @param {object}   opts   - { width, height, fps }
 * @returns {string} SVG document string
 */
export function exportAnimatedSVG(frames, opts = {}) {
  if (!frames.length) return '';

  const width       = opts.width       ?? 800;
  const height      = opts.height      ?? 600;
  const showGrid    = opts.showGrid    ?? true;
  const showTraces  = opts.showTraces  ?? false;
  const showVectors = opts.showVectors ?? false;
  const duration = frames[frames.length - 1].t || 1;

  // Build keyTimes array (0..1)
  const keyTimes = frames.map(f => (f.t / duration).toFixed(4));

  const svg = el('svg', {
    xmlns: SVG_NS,
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    'font-family': FONT_DIAGRAM,
    style: 'background:#ffffff',
  });

  // ── Defs ──────────────────────────────────────────────────────
  const defs = el('defs');

  const hatch = el('pattern', {
    id: 'hatch', x: 0, y: 0, width: 8, height: 8,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  hatch.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 8,
    stroke: INK, 'stroke-width': 1.5, opacity: 0.35 }));
  defs.appendChild(hatch);

  const cHatch = el('pattern', {
    id: 'ceil-hatch', x: 0, y: 0, width: 8, height: 8,
    patternUnits: 'userSpaceOnUse',
  });
  cHatch.appendChild(el('line', { x1: 0, y1: 0, x2: 8, y2: 8,
    stroke: INK, 'stroke-width': 1.2, opacity: 0.4 }));
  defs.appendChild(cHatch);

  svg.appendChild(defs);

  // ── Background grid (only if enabled) ───────────────────────
  if (showGrid) {
    const gridG = el('g', { id: 'grid', opacity: 0.6 });
    for (let x = 0; x <= width; x += 20) {
      gridG.appendChild(el('line', {
        x1: x, y1: 0, x2: x, y2: height,
        stroke: '#ebebeb', 'stroke-width': x % 100 === 0 ? 1 : 0.4,
      }));
    }
    for (let y = 0; y <= height; y += 20) {
      gridG.appendChild(el('line', {
        x1: 0, y1: y, x2: width, y2: y,
        stroke: '#ebebeb', 'stroke-width': y % 100 === 0 ? 1 : 0.4,
      }));
    }
    svg.appendChild(gridG);
  }

  // ── Collect unique body/constraint IDs across all frames (welds change the set) ──
  const bodyIds = [...new Set(frames.flatMap(f => f.bodies.map(b => b.id)))];
  const constraintIds = [...new Set(frames.flatMap(f => f.constraints.map(c => c.id)))];

  // ── Constraint layer ─────────────────────────────────────────
  const constraintLayer = el('g', { id: 'constraints' });
  for (const cId of constraintIds) {
    const cSnapshots = frames.map(f => f.constraints.find(c => c.id === cId));
    const first = cSnapshots.find(Boolean);
    if (!first) continue;

    const cType = first.type;
    const g     = el('g', { id: `c-${cId}` });

    if (cType === 'spring') {
      // Spring: animated path: amplitude and stroke-width change with deformation.
      // restLen is constant per spring, read it from the first available snapshot.
      const restLen = cSnapshots.find(Boolean)?.restLen ?? null;
      const pathEl = el('path', {
        fill: 'none', stroke: INK,
        'stroke-width': 1.5,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      });
      const dValues = cSnapshots.map(snap =>
        snap ? _springPath(snap.ax, snap.ay, snap.bx, snap.by, restLen) : ''
      );
      const anim = el('animate', {
        attributeName: 'd',
        ...smilValues(dValues, keyTimes, duration),
      });
      pathEl.appendChild(anim);
      g.appendChild(pathEl);
    } else {
      const lw = cType === 'rod' ? 3.5 : 1.5;
      const line = el('line', { stroke: INK, 'stroke-width': lw, 'stroke-linecap': 'round' });

      line.appendChild(el('animate', {
        attributeName: 'x1',
        ...smilValues(cSnapshots.map(s => s ? s.ax.toFixed(2) : '0'), keyTimes, duration),
      }));
      line.appendChild(el('animate', {
        attributeName: 'y1',
        ...smilValues(cSnapshots.map(s => s ? s.ay.toFixed(2) : '0'), keyTimes, duration),
      }));
      line.appendChild(el('animate', {
        attributeName: 'x2',
        ...smilValues(cSnapshots.map(s => s ? s.bx.toFixed(2) : '0'), keyTimes, duration),
      }));
      line.appendChild(el('animate', {
        attributeName: 'y2',
        ...smilValues(cSnapshots.map(s => s ? s.by.toFixed(2) : '0'), keyTimes, duration),
      }));

      g.appendChild(line);
    }
    constraintLayer.appendChild(g);
  }
  svg.appendChild(constraintLayer);

  // ── Body layer ───────────────────────────────────────────────
  const bodyLayer = el('g', { id: 'bodies' });
  for (const bId of bodyIds) {
    const bSnapshots = frames.map(f => f.bodies.find(b => b.id === bId));
    const first = bSnapshots.find(Boolean);
    if (!first) continue;

    const bType = first.type;
    const g     = el('g', { id: `b-${bId}` });
    const poses = _poseSeries(bSnapshots, first);
    const txValues = poses.map(s => s.x.toFixed(2));
    const tyValues = poses.map(s => s.y.toFixed(2));
    const raValues = poses.map(s => (s.angle * 180 / Math.PI).toFixed(2));
    _appendPresenceOpacity(g, bSnapshots, keyTimes, duration);

    if (bType === 'anchor') {
      const driven = first.driven === true;
      if (driven) {
        _drawDrivenAnchor(g, first.x, first.y, bId, bSnapshots, keyTimes, duration);
      } else {
        _drawStaticAnchor(g, first.x, first.y);
      }
    } else if (bType === 'ground') {
      _drawStaticGround(g, first.x, first.y, first.bWidth ?? 400, first.bHeight ?? 20);
    } else if (bType === 'point-mass') {
      const r  = first.radius ?? DEFAULT_CIRCLE_R;
      const s  = circleRingStrokePx(r);
      const hollow = first.hollow === true;
      const cx = el('circle', {
        cx: 0, cy: 0, r: Math.max(0.5, r - s / 2),
        fill: hollow ? 'none' : BOX_FILL_HEX,
        stroke: hollow ? INK : BOX_STROKE_HEX,
        'stroke-width': s,
      });

      const txAnim = el('animateTransform', {
        attributeName: 'transform',
        type: 'translate',
        ...smilValues(txValues.map((tx, i) => `${tx} ${tyValues[i]}`), keyTimes, duration),
        additive: 'sum',
      });
      const raAnim = el('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        ...smilValues(raValues.map((ra, i) => `${ra} 0 0`), keyTimes, duration),
        additive: 'sum',
      });

      // Use a wrapper g for transforms
      const wrapper = el('g');
      wrapper.appendChild(cx);
      wrapper.appendChild(txAnim);
      wrapper.appendChild(raAnim);
      g.appendChild(wrapper);

    } else if (bType === 'ball') {
      const r  = first.radius ?? DEFAULT_BALL_R;
      const cx = el('circle', { cx: 0, cy: 0, r, fill: INK });

      const txAnim = el('animateTransform', {
        attributeName: 'transform',
        type: 'translate',
        ...smilValues(txValues.map((tx, i) => `${tx} ${tyValues[i]}`), keyTimes, duration),
        additive: 'sum',
      });
      const raAnim = el('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        ...smilValues(raValues.map((ra, i) => `${ra} 0 0`), keyTimes, duration),
        additive: 'sum',
      });

      const wrapper = el('g');
      wrapper.appendChild(cx);
      wrapper.appendChild(txAnim);
      wrapper.appendChild(raAnim);
      g.appendChild(wrapper);

    } else if (bType === 'box') {
      const w = first.bWidth  ?? 40;
      const h = first.bHeight ?? 40;
      const s = boxOutlineStrokePx(w, h);
      const rect = el('rect', {
        x: -w / 2 + s / 2,
        y: -h / 2 + s / 2,
        width: w - s,
        height: h - s,
        fill: BOX_FILL_HEX,
        stroke: BOX_STROKE_HEX,
        'stroke-width': s,
      });

      const wrapper = el('g');
      wrapper.appendChild(rect);
      wrapper.appendChild(el('animateTransform', {
        attributeName: 'transform',
        type: 'translate',
        ...smilValues(txValues.map((tx, i) => `${tx} ${tyValues[i]}`), keyTimes, duration),
        additive: 'sum',
      }));
      wrapper.appendChild(el('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        ...smilValues(raValues.map((ra, i) => `${ra} 0 0`), keyTimes, duration),
        additive: 'sum',
      }));
      g.appendChild(wrapper);

    } else if (bType === 'wedge') {
      const W = first.baseWidth ?? first.bWidth ?? 40;
      const H = first.bHeight ?? 40;
      const s = wedgeOutlineStrokePx(W, H);
      const verts = insetPolygonVerts(wedgeVertsCentred(W, H, first.flipX === true, first.flipY === true), s / 2);
      const poly = el('polygon', {
        points: verts.map(v => `${v.x},${v.y}`).join(' '),
        fill: 'none',
        stroke: INK,
        'stroke-width': s,
        'stroke-linejoin': 'round',
      });
      const wrapper = el('g');
      wrapper.appendChild(poly);
      wrapper.appendChild(el('animateTransform', {
        attributeName: 'transform',
        type: 'translate',
        ...smilValues(txValues.map((tx, i) => `${tx} ${tyValues[i]}`), keyTimes, duration),
        additive: 'sum',
      }));
      wrapper.appendChild(el('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        ...smilValues(raValues.map((ra, i) => `${ra} 0 0`), keyTimes, duration),
        additive: 'sum',
      }));
      g.appendChild(wrapper);

    } else if (bType === 'compound') {
      const wrapper = el('g');
      for (const p of first.weldParts ?? []) {
        const lx = p.lx ?? 0;
        const ly = p.ly ?? 0;
        const deg = ((p.la ?? 0) * 180) / Math.PI;
        if ((p.type === 'point-mass' || p.type === 'ball') && p.radius) {
          const s = circleRingStrokePx(p.radius);
          const greyFill = p.type === 'point-mass' && !p.hollow;
          wrapper.appendChild(el('circle', {
            cx: lx, cy: ly,
            r: greyFill || p.hollow ? Math.max(0.5, p.radius - s / 2) : p.radius,
            fill: p.hollow ? 'none' : (greyFill ? BOX_FILL_HEX : INK),
            stroke: p.hollow ? INK : (greyFill ? BOX_STROKE_HEX : 'none'),
            'stroke-width': greyFill || p.hollow ? s : 0,
          }));
        } else {
          const w = p.width ?? 40;
          const h = p.height ?? 40;
          const s = boxOutlineStrokePx(w, h);
          const rect = el('rect', {
            x: lx - w / 2 + s / 2,
            y: ly - h / 2 + s / 2,
            width: w - s,
            height: h - s,
            fill: BOX_FILL_HEX,
            stroke: BOX_STROKE_HEX,
            'stroke-width': s,
            transform: deg ? `rotate(${deg} ${lx} ${ly})` : undefined,
          });
          wrapper.appendChild(rect);
        }
      }
      wrapper.appendChild(el('animateTransform', {
        attributeName: 'transform',
        type: 'translate',
        ...smilValues(txValues.map((tx, i) => `${tx} ${tyValues[i]}`), keyTimes, duration),
        additive: 'sum',
      }));
      wrapper.appendChild(el('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        ...smilValues(raValues.map((ra, i) => `${ra} 0 0`), keyTimes, duration),
        additive: 'sum',
      }));
      g.appendChild(wrapper);
    }

    bodyLayer.appendChild(g);
  }
  svg.appendChild(bodyLayer);

  // ── Trajectory traces (if enabled) ──────────────────────────
  if (showTraces) {
    const traceLayer = el('g', { id: 'traces', opacity: 0.4 });
    // One path per body: built from all frame positions
    for (const bId of bodyIds) {
      const bSnapshots = frames.map(f => f.bodies.find(b => b.id === bId));
      const first = bSnapshots.find(Boolean);
      if (!first || first.isStatic) continue;
      const pts = bSnapshots.filter(Boolean);
      if (pts.length < 2) continue;
      const d = pts.reduce((acc, s, i) =>
        acc + (i === 0 ? `M ${s.x.toFixed(1)} ${s.y.toFixed(1)}`
                       : ` L ${s.x.toFixed(1)} ${s.y.toFixed(1)}`), '');
      traceLayer.appendChild(el('path', {
        d, fill: 'none', stroke: INK,
        'stroke-width': 1, 'stroke-dasharray': '3 3',
      }));
    }
    svg.appendChild(traceLayer);
  }

  // ── Force / velocity vectors (if enabled) ───────────────────
  if (showVectors) {
    // Add arrow markers to defs
    const mkW = el('marker', {
      id: 'exp-arrow-w', markerWidth: '6', markerHeight: '6',
      refX: '5', refY: '3', orient: 'auto',
    });
    mkW.appendChild(el('path', { d: 'M0,0 L0,6 L6,3 z', fill: '#c0392b' }));
    defs.appendChild(mkW);
    const mkV = el('marker', {
      id: 'exp-arrow-v', markerWidth: '6', markerHeight: '6',
      refX: '5', refY: '3', orient: 'auto',
    });
    mkV.appendChild(el('path', { d: 'M0,0 L0,6 L6,3 z', fill: '#2d70b3' }));
    defs.appendChild(mkV);

    const vecLayer = el('g', { id: 'vectors' });
    for (const bId of bodyIds) {
      const bSnapshots = frames.map(f => f.bodies.find(b => b.id === bId));
      const first = bSnapshots.find(Boolean);
      if (!first || first.isStatic) continue;

      // Weight arrow (direction is always straight down: constant)
      const wG   = el('g', { id: `vec-w-${bId}` });
      const wLine = el('line', {
        stroke: '#c0392b', 'stroke-width': 1, 'stroke-linecap': 'round',
        'marker-end': 'url(#exp-arrow-w)',
      });
      // Animate positions
      const weightPx = getWeightPxPerKg();
      const txW = bSnapshots.map(s => s ? s.x.toFixed(1) : '0');
      const tyW = bSnapshots.map(s => s ? s.y.toFixed(1) : '0');
      const teyW = bSnapshots.map(s => s ? (s.y + (s.mass ?? 1) * weightPx - 4).toFixed(1) : '0');
      wLine.appendChild(el('animate', { attributeName: 'x1', ...smilValues(txW, keyTimes, duration) }));
      wLine.appendChild(el('animate', { attributeName: 'y1', ...smilValues(tyW, keyTimes, duration) }));
      wLine.appendChild(el('animate', { attributeName: 'x2', ...smilValues(txW, keyTimes, duration) }));
      wLine.appendChild(el('animate', { attributeName: 'y2', ...smilValues(teyW, keyTimes, duration) }));
      wG.appendChild(wLine);
      vecLayer.appendChild(wG);

      // Velocity arrow
      const vG    = el('g', { id: `vec-v-${bId}` });
      const vLine = el('line', {
        stroke: '#2d70b3', 'stroke-width': 1, 'stroke-linecap': 'round',
        'marker-end': 'url(#exp-arrow-v)',
      });
      const vPx  = getVelocityPxPerMs();
      const txV  = bSnapshots.map(s => s ? s.x.toFixed(1) : '0');
      const tyV  = bSnapshots.map(s => s ? s.y.toFixed(1) : '0');
      const texV = bSnapshots.map(s => {
        if (!s) return '0';
        const { vxMs } = matterVelToDisplayMS(s.vx, s.vy);
        return (s.x + vxMs * vPx).toFixed(1);
      });
      const teyV = bSnapshots.map(s => {
        if (!s) return '0';
        const { vyMs } = matterVelToDisplayMS(s.vx, s.vy);
        return (s.y - vyMs * vPx).toFixed(1);
      });
      vLine.appendChild(el('animate', { attributeName: 'x1', ...smilValues(txV, keyTimes, duration) }));
      vLine.appendChild(el('animate', { attributeName: 'y1', ...smilValues(tyV, keyTimes, duration) }));
      vLine.appendChild(el('animate', { attributeName: 'x2', ...smilValues(texV, keyTimes, duration) }));
      vLine.appendChild(el('animate', { attributeName: 'y2', ...smilValues(teyV, keyTimes, duration) }));
      vG.appendChild(vLine);
      vecLayer.appendChild(vG);
    }
    svg.appendChild(vecLayer);
  }

  // ── Time label ───────────────────────────────────────────────
  const timeLabel = el('text', {
    x: width - 10, y: 20,
    'text-anchor': 'end',
    'font-size': 12,
    fill: '#999',
    'font-family': FONT_DIAGRAM,
  });
  timeLabel.textContent = `t = 0.000 s`;
  // Animate content via <animate> on textContent isn't possible in SMIL,
  // we'll skip it for the export (SMIL doesn't support text value animation easily).
  svg.appendChild(timeLabel);

  // ── Serialize ────────────────────────────────────────────────
  const serializer = new XMLSerializer();
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + serializer.serializeToString(svg);
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Hold last known pose when a body is absent in a frame (pre/post weld). */
function _poseSeries(bSnapshots, first) {
  let last = first;
  return bSnapshots.map(s => {
    if (s) last = s;
    return last;
  });
}

function _appendPresenceOpacity(g, bSnapshots, keyTimes, duration) {
  if (!bSnapshots.some(s => !s)) return;
  g.appendChild(el('animate', {
    attributeName: 'opacity',
    ...smilValues(bSnapshots.map(s => (s ? '1' : '0')), keyTimes, duration),
  }));
}

function _springPath(ax, ay, bx, by, restLen = null) {
  const { d } = springPathProps(ax, ay, bx, by, restLen, {
    coils: COILS, ampl: AMPL, strokeWidth: 1.05,
  });
  // SMIL keyframes prefer fixed decimals for stable interpolation.
  return d.replace(/-?\d+\.?\d*/g, n => Number(n).toFixed(1));
}

function _drawStaticAnchor(g, x, y) {
  const { apex, left, right } = anchorTriangleLocalVerts();
  g.appendChild(el('polygon', {
    points: `${x + apex.x},${y + apex.y} ${x + left.x},${y + left.y} ${x + right.x},${y + right.y}`,
    fill: 'none', stroke: INK, 'stroke-width': ANCHOR_STROKE_PX,
  }));
  g.appendChild(el('circle', {
    cx: x, cy: y, r: ANCHOR_PIVOT_R,
    fill: '#fff', stroke: INK, 'stroke-width': 2,
  }));
}

function _drawDrivenAnchor(g, x, y, bId, snapshots, keyTimes, duration) {
  const { apex, left, right } = anchorTriangleLocalVerts();
  g.appendChild(el('polygon', {
    points: `${x + apex.x},${y + apex.y} ${x + left.x},${y + left.y} ${x + right.x},${y + right.y}`,
    fill: 'none', stroke: INK, 'stroke-width': ANCHOR_STROKE_PX,
  }));
  const hinge = el('g', { transform: `translate(${x},${y})` });
  appendDrivenPivotGlyph(hinge, `export-${bId}`, 0);
  const disk = hinge.querySelector('.driven-pivot-disk');
  if (disk) {
    const angles = snapshots.map(s => {
      const a = (s?.drivenVisualAngle ?? 0) * 180 / Math.PI;
      return a.toFixed(2);
    });
    disk.appendChild(el('animateTransform', {
      attributeName: 'transform',
      type: 'rotate',
      ...smilValues(angles.map(a => `${a} 0 0`), keyTimes, duration),
      additive: 'sum',
    }));
  }
  g.appendChild(hinge);
}

function _drawStaticGround(g, x, y, w, h) {
  g.appendChild(el('line', {
    x1: x - w/2, y1: y - h/2, x2: x + w/2, y2: y - h/2,
    stroke: INK, 'stroke-width': 2,
  }));
  g.appendChild(el('rect', {
    x: x - w/2, y: y - h/2, width: w, height: h,
    fill: 'url(#hatch)',
  }));
}

/**
 * Trigger a browser download of the SVG string.
 * @param {string} svgStr
 * @param {string} filename
 */
export function downloadSVG(svgStr, filename = 'inertia-animation.svg') {
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
