/**
 * Screen-space overlay for the camera tool: red dotted frame + origin handle.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FRAME_STROKE = '#a63d2f';
const HANDLE = 8;
const ORIGIN_R = 6;
const MIN_SCREEN = 24;

function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class CameraOverlay {
  /**
   * @param {SVGSVGElement} overlaySvg screen-space overlay (matches canvas size)
   * @param {import('../camera/camera.js').Camera} camera
   * @param {import('../camera/camera-rig.js').CameraRig} rig
   */
  constructor(overlaySvg, camera, rig) {
    this.svg = overlaySvg;
    this.camera = camera;
    this.rig = rig;
    this._g = el('g', { id: 'camera-frame-ui' });
    this.svg.appendChild(this._g);
    this._active = false;

    /** @type {'move'|'origin'|'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'|null} */
    this._dragMode = null;
    this._dragStart = null;
    this._rigStart = null;
  }

  setActive(on) {
    this._active = !!on;
    this.svg.style.display = on ? 'block' : 'none';
    this.svg.style.pointerEvents = on ? 'auto' : 'none';
    this.svg.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (!on) this.endDrag();
    this.sync();
  }

  sync() {
    this._g.replaceChildren();
    if (!this._active) return;

    const r = this.rig.screenRect(this.camera);
    if (r.width < 2 || r.height < 2) return;

    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const aspect = this.rig.aspectLabel();
    const resizing = this.isResizing;

    // View boundary: red dotted export frame.
    this._g.appendChild(el('rect', {
      x: r.x, y: r.y, width: r.width, height: r.height,
      fill: 'rgba(166, 61, 47, 0.04)',
      stroke: FRAME_STROKE,
      'stroke-width': 2,
      'stroke-dasharray': '5 4',
      'pointer-events': 'none',
    }));

    // Aspect ratio badge (emphasized while resizing).
    const badgeW = Math.max(52, aspect.length * 8 + 16);
    const badgeH = resizing ? 24 : 20;
    const badgeY = r.y + 10;
    this._g.appendChild(el('rect', {
      x: cx - badgeW / 2, y: badgeY - badgeH / 2,
      width: badgeW, height: badgeH,
      rx: 3, ry: 3,
      fill: resizing ? 'rgba(166, 61, 47, 0.92)' : 'rgba(255, 255, 255, 0.94)',
      stroke: FRAME_STROKE,
      'stroke-width': 1.25,
      'pointer-events': 'none',
    }));
    const aspectText = el('text', {
      x: cx, y: badgeY + (resizing ? 5 : 4),
      'text-anchor': 'middle',
      fill: resizing ? '#ffffff' : FRAME_STROKE,
      'font-size': resizing ? '13' : '11',
      'font-weight': resizing ? '600' : '500',
      'font-family': 'DM Sans, system-ui, sans-serif',
      'pointer-events': 'none',
    });
    aspectText.textContent = aspect;
    this._g.appendChild(aspectText);

    // Corner / edge scale handles.
    const handles = [
      ['nw', r.x, r.y, 'nwse-resize'],
      ['ne', r.x + r.width, r.y, 'nesw-resize'],
      ['sw', r.x, r.y + r.height, 'nesw-resize'],
      ['se', r.x + r.width, r.y + r.height, 'nwse-resize'],
      ['n', cx, r.y, 'ns-resize'],
      ['s', cx, r.y + r.height, 'ns-resize'],
      ['w', r.x, cy, 'ew-resize'],
      ['e', r.x + r.width, cy, 'ew-resize'],
    ];
    for (const [mode, hx, hy, cursor] of handles) {
      this._g.appendChild(el('rect', {
        x: hx - HANDLE / 2, y: hy - HANDLE / 2,
        width: HANDLE, height: HANDLE,
        fill: '#ffffff',
        stroke: FRAME_STROKE,
        'stroke-width': 1.5,
        'data-cam-handle': mode,
        style: `cursor:${cursor}`,
      }));
    }

    // Camera origin: drag to move the whole frame in world space.
    const origin = el('g', { 'data-cam-handle': 'origin', style: 'cursor:move' });
    origin.appendChild(el('circle', {
      cx, cy, r: ORIGIN_R,
      fill: '#ffffff',
      stroke: FRAME_STROKE,
      'stroke-width': 2,
    }));
    origin.appendChild(el('line', {
      x1: cx - 12, y1: cy, x2: cx + 12, y2: cy,
      stroke: FRAME_STROKE, 'stroke-width': 1.5, 'pointer-events': 'none',
    }));
    origin.appendChild(el('line', {
      x1: cx, y1: cy - 12, x2: cx, y2: cy + 12,
      stroke: FRAME_STROKE, 'stroke-width': 1.5, 'pointer-events': 'none',
    }));
    this._g.appendChild(origin);
  }

  /** @param {number} sx @param {number} sy */
  hitHandle(sx, sy) {
    for (const h of this._g.querySelectorAll('[data-cam-handle]')) {
      const mode = h.getAttribute('data-cam-handle');
      if (mode === 'move') continue;
      if (mode === 'origin') {
        const c = h.querySelector('circle');
        const cx = parseFloat(c?.getAttribute('cx') ?? '0');
        const cy = parseFloat(c?.getAttribute('cy') ?? '0');
        if (Math.hypot(sx - cx, sy - cy) <= ORIGIN_R + 4) return 'origin';
        continue;
      }
      const x = parseFloat(h.getAttribute('x') ?? '0');
      const y = parseFloat(h.getAttribute('y') ?? '0');
      const w = parseFloat(h.getAttribute('width') ?? '0');
      const hh = parseFloat(h.getAttribute('height') ?? '0');
      if (sx >= x && sx <= x + w && sy >= y && sy <= y + hh) return mode;
    }
    const r = this.rig.screenRect(this.camera);
    if (sx >= r.x && sx <= r.x + r.width && sy >= r.y && sy <= r.y + r.height) return 'move';
    return null;
  }

  /** @param {string} mode @param {number} sx @param {number} sy */
  beginDrag(mode, sx, sy) {
    this._dragMode = mode === 'origin' ? 'move' : mode;
    this._dragStart = { x: sx, y: sy };
    this._rigStart = {
      cx: this.rig.centerX,
      cy: this.rig.centerY,
      vw: this.rig.viewWidth,
      vh: this.rig.viewHeight,
    };
  }

  /** @param {number} sx @param {number} sy */
  moveDrag(sx, sy) {
    if (!this._dragMode || !this._dragStart || !this._rigStart) return;
    const s = this.camera.s || 1;
    const dxWorld = (sx - this._dragStart.x) / s;
    const dyWorld = (sy - this._dragStart.y) / s;
    const rs = this._rigStart;

    if (this._dragMode === 'move') {
      // Drag direction matches the frame on screen (view transform stays fixed).
      this.rig.centerX = rs.cx + dxWorld;
      this.rig.centerY = rs.cy + dyWorld;
    } else {
      const b = {
        minX: rs.cx - rs.vw / 2,
        minY: rs.cy - rs.vh / 2,
        maxX: rs.cx + rs.vw / 2,
        maxY: rs.cy + rs.vh / 2,
      };
      const w = this.camera.screenToWorld(sx, sy);
      const mode = this._dragMode;
      if (mode.includes('e')) b.maxX = Math.max(b.minX + MIN_SCREEN / s, w.x);
      if (mode.includes('w')) b.minX = Math.min(b.maxX - MIN_SCREEN / s, w.x);
      if (mode.includes('s')) b.maxY = Math.max(b.minY + MIN_SCREEN / s, w.y);
      if (mode.includes('n')) b.minY = Math.min(b.maxY - MIN_SCREEN / s, w.y);
      this.rig.centerX = (b.minX + b.maxX) / 2;
      this.rig.centerY = (b.minY + b.maxY) / 2;
      this.rig.viewWidth = Math.max(MIN_SCREEN / s, b.maxX - b.minX);
      this.rig.viewHeight = Math.max(MIN_SCREEN / s, b.maxY - b.minY);
    }

    // View transform stays fixed: only the world-space frame changes.
    this.sync();
  }

  endDrag() {
    this._dragMode = null;
    this._dragStart = null;
    this._rigStart = null;
  }

  get isDragging() { return this._dragMode != null; }
  get isResizing() { return this._dragMode != null && this._dragMode !== 'move'; }
}
