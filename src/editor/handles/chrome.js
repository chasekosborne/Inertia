/**
 * Shared vocabulary for on-canvas edit handles (vector, selection, scale).
 * Pure DOM + constants: importable from interaction.js without a cycle.
 */
import { COLORS } from '../../theme.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const SEL_HANDLE_ATTR   = 'data-sel-handle';
export const SCALE_HANDLE_ATTR = 'data-scale-handle';
export const VECTOR_HANDLE_ID  = 'vel-handle';
export const UI_TOP_LAYER_ID   = 'layer-ui-top';
export const ANY_HANDLE_SEL =
  `#${VECTOR_HANDLE_ID}, #${UI_TOP_LAYER_ID}, [${SEL_HANDLE_ATTR}], [${SCALE_HANDLE_ATTR}]`;

export const DOT_RADIUS = { spring: 3.5, link: 5, scale: 6, ground: 7 };
export const DOT_STROKE_WIDTH = { spring: 1.25, link: 1.5, ground: 2 };

export const HANDLE_BLUE  = COLORS.vel;
export const HANDLE_RED   = COLORS.force;
export const HANDLE_STROKE = '#fff';

export function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) e.setAttribute(k, String(v));
  }
  return e;
}

/**
 * A grabbable handle dot. `data` keys become data-* attributes.
 */

export function handleDot({
  r = DOT_RADIUS.link,
  strokeWidth = DOT_STROKE_WIDTH.link,
  cursor = 'crosshair',
  color = HANDLE_BLUE,
  data = {},
  onPointerDown = null,
} = {}) {

  const circ = svgEl('circle', {
    r, cursor, fill: color, stroke: HANDLE_STROKE, 'stroke-width': strokeWidth,
  });

  for (const [k, v] of Object.entries(data)) {
    circ.setAttribute(`data-${k}`, String(v));
  }

  if (onPointerDown) {
    circ.addEventListener('pointerdown', onPointerDown);
  }
  return circ;
}

/** Non-interactive preview dot that follows the cursor during a drag. */
export function ghostDot({
  r = DOT_RADIUS.link,
  strokeWidth = 1.25,
  opacity = 0.55,
  color = HANDLE_BLUE,
} = {}) {
  return svgEl('circle', {
    r, fill: color, stroke: HANDLE_STROKE, 'stroke-width': strokeWidth,
    opacity, 'pointer-events': 'none',
  });
}

/** Handle group parented under the UI-top layer. */
export function handleGroup(id) {
  return svgEl('g', { id });
}

/** Screen (client) coords → world px.*/
export function clientToWorld(svg, camera, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return camera.screenToWorld(clientX - rect.left, clientY - rect.top);
}