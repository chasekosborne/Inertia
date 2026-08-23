/**
 * Camera rig: world-space framing (center + view bounds) with optional body follow.
 * Drives the live {@link Camera} transform and video export framing.
 */

import { PX_PER_M, mToPx } from '../units.js';
import { displayedMToWorldPx, worldPxToDisplayedM } from '../world-origin.js';

const MIN_VIEW_PX = 40;

/** Major grid spacing in world px (1 m at {@link PX_PER_M}). */
export const GRID_MAJOR_PX = PX_PER_M;

/** Default whole major cells shown along the long viewport axis. */
export const DEFAULT_GRID_CELLS_LONG = 7;
export const DEFAULT_GRID_CELLS_SHORT = 5;
export const DEFAULT_VIEW_PADDING_PX = 36;

/** Default framed world extent (px): ~7 m × 5 m at {@link PX_PER_M}. */
export const DEFAULT_VIEW_WIDTH_PX = DEFAULT_GRID_CELLS_LONG * GRID_MAJOR_PX;
export const DEFAULT_VIEW_HEIGHT_PX = DEFAULT_GRID_CELLS_SHORT * GRID_MAJOR_PX;

export class CameraRig {
  constructor() {
    /** @type {number} world px */
    this.centerX = 0;
    /** @type {number} world px */
    this.centerY = 0;
    /** @type {number} world px */
    this.viewWidth = DEFAULT_VIEW_WIDTH_PX;
    /** @type {number} world px */
    this.viewHeight = DEFAULT_VIEW_HEIGHT_PX;
    /** @type {number|null} Matter body id */
    this.followBodyId = null;
    /** @type {string|null} scene body label for serialize */
    this.followBodyLabel = null;
  }

  /** Width ÷ height of the framed world bounds. */
  aspectRatio() {
    return this.viewWidth / Math.max(1, this.viewHeight);
  }

  /**
   * Frame a whole-number major grid extent to fit the viewport (metric origin centred).
   * @param {number} viewW
   * @param {number} viewH
   * @param {number} centerX world px
   * @param {number} centerY world px
   * @param {number} [paddingPx]
   */
  fitGridToViewport(viewW, viewH, centerX, centerY, paddingPx = DEFAULT_VIEW_PADDING_PX) {
    const innerW = Math.max(MIN_VIEW_PX, viewW - paddingPx * 2);
    const innerH = Math.max(MIN_VIEW_PX, viewH - paddingPx * 2);
    const aspect = innerW / innerH;
    let cellsW;
    let cellsH;
    if (aspect >= 1) {
      cellsW = DEFAULT_GRID_CELLS_LONG;
      cellsH = Math.max(DEFAULT_GRID_CELLS_SHORT, Math.ceil(cellsW / aspect));
    } else {
      cellsH = DEFAULT_GRID_CELLS_LONG;
      cellsW = Math.max(DEFAULT_GRID_CELLS_SHORT, Math.ceil(cellsH * aspect));
    }
    this.centerX = centerX;
    this.centerY = centerY;
    this.viewWidth = cellsW * GRID_MAJOR_PX;
    this.viewHeight = cellsH * GRID_MAJOR_PX;
  }

  /**
   * Pixel export size for a standard preset using this rig's aspect ratio.
   * @param {'720p'|'1080p'|'1440p'|'4k'} preset
   */
  exportDimensionsForPreset(preset) {
    const shortSide = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 }[preset] ?? 1080;
    const aspect = this.aspectRatio();
    let width;
    let height;
    if (aspect >= 1) {
      height = shortSide;
      width = Math.round(shortSide * aspect);
    } else {
      width = shortSide;
      height = Math.round(shortSide / aspect);
    }
    width = Math.max(2, width & ~1);
    height = Math.max(2, height & ~1);
    return { width, height, label: `${width} × ${height}` };
  }

  /** Human-readable aspect ratio label (e.g. `16:9`). */
  aspectLabel() {
    const w = Math.max(1, this.viewWidth);
    const h = Math.max(1, this.viewHeight);
    const ratio = w / h;
    const common = [
      [21, 9], [16, 9], [16, 10], [3, 2], [4, 3], [5, 4], [1, 1],
      [4, 5], [3, 4], [2, 3], [9, 16], [10, 16], [9, 21],
    ];
    for (const [a, b] of common) {
      if (Math.abs(ratio - a / b) < 0.015) return `${a}:${b}`;
    }
    const g = (a, b) => (b ? g(b, a % b) : a);
    let aw = Math.round(w * 10);
    let ah = Math.round(h * 10);
    const d = g(aw, ah);
    aw = Math.round(aw / d);
    ah = Math.round(ah / d);
    if (aw <= 30 && ah <= 30) return `${aw}:${ah}`;
    return `${ratio.toFixed(2)}:1`;
  }

  /** @param {import('./camera.js').Camera} camera @param {number} viewW @param {number} viewH */
  syncFromCamera(camera, viewW, viewH) {
    const s = camera.s || 1;
    this.centerX = (viewW / 2 - camera.tx) / s;
    this.centerY = (viewH / 2 - camera.ty) / s;
    this.viewWidth = Math.max(MIN_VIEW_PX, viewW / s);
    this.viewHeight = Math.max(MIN_VIEW_PX, viewH / s);
  }

  /**
   * Fit the view bounds to contain all given world points (with padding).
   * @param {{ x: number, y: number }[]} points
   * @param {number} [paddingPx=40]
   */
  fitPoints(points, paddingPx = 40) {
    if (!points.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return;
    const w = Math.max(MIN_VIEW_PX, maxX - minX + paddingPx * 2);
    const h = Math.max(MIN_VIEW_PX, maxY - minY + paddingPx * 2);
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
    this.viewWidth = w;
    this.viewHeight = h;
  }

  /** @param {import('../physics/engine.js').PhysicsEngine} engine */
  fitAllBodies(engine, paddingPx = 48) {
    const pts = [];
    for (const b of engine.bodies) {
      if (b._newtonType === 'metric-basis') continue;
      pts.push({ x: b.position.x, y: b.position.y });
      if (b.bounds) {
        pts.push({ x: b.bounds.min.x, y: b.bounds.min.y });
        pts.push({ x: b.bounds.max.x, y: b.bounds.max.y });
      }
    }
    this.fitPoints(pts, paddingPx);
  }

  /** @param {import('../physics/engine.js').PhysicsEngine} engine */
  updateFollow(engine) {
    if (this.followBodyId == null) return false;
    const body = engine.bodies.find(b => b.id === this.followBodyId);
    if (!body) return false;
    this.centerX = body.position.x;
    this.centerY = body.position.y;
    return true;
  }

  /**
   * @param {import('./camera.js').Camera} camera
   * @param {number} viewW
   * @param {number} viewH
   */
  applyToCamera(camera, viewW, viewH) {
    const vw = Math.max(MIN_VIEW_PX, this.viewWidth);
    const vh = Math.max(MIN_VIEW_PX, this.viewHeight);
    const s = Math.min(viewW / vw, viewH / vh);
    camera.setTransform(
      viewW / 2 - this.centerX * s,
      viewH / 2 - this.centerY * s,
      s,
    );
  }

  /** World-space axis-aligned bounds. */
  worldBounds() {
    const hw = this.viewWidth / 2;
    const hh = this.viewHeight / 2;
    return {
      minX: this.centerX - hw,
      minY: this.centerY - hh,
      maxX: this.centerX + hw,
      maxY: this.centerY + hh,
    };
  }

  /** @param {import('./camera.js').Camera} camera */
  screenRect(camera) {
    const b = this.worldBounds();
    const tl = camera.worldToScreen(b.minX, b.minY);
    const br = camera.worldToScreen(b.maxX, b.maxY);
    return {
      x: Math.min(tl.x, br.x),
      y: Math.min(tl.y, br.y),
      width: Math.abs(br.x - tl.x),
      height: Math.abs(br.y - tl.y),
    };
  }

  /** @returns {import('../scene/schema.js').SceneCamera|null} */
  toSceneDoc() {
    const c = worldPxToDisplayedM(this.centerX, this.centerY);
    return {
      center: { x: c.xm, y: c.ym },
      view: {
        width: this.viewWidth / PX_PER_M,
        height: this.viewHeight / PX_PER_M,
      },
      followBody: this.followBodyLabel ?? null,
    };
  }

  /**
   * @param {import('../scene/schema.js').SceneCamera|null|undefined} doc
   * @param {Map<string, import('matter-js').Body>} [bodyByLabel]
   */
  loadFromSceneDoc(doc, bodyByLabel = null) {
    if (!doc) return;
    if (doc.center && Number.isFinite(doc.center.x) && Number.isFinite(doc.center.y)) {
      const w = displayedMToWorldPx(doc.center.x, doc.center.y);
      this.centerX = w.x;
      this.centerY = w.y;
    }
    if (doc.view) {
      if (Number.isFinite(doc.view.width) && doc.view.width > 0) {
        this.viewWidth = Math.max(MIN_VIEW_PX, mToPx(doc.view.width));
      }
      if (Number.isFinite(doc.view.height) && doc.view.height > 0) {
        this.viewHeight = Math.max(MIN_VIEW_PX, mToPx(doc.view.height));
      }
    } else if (Number.isFinite(doc.s) && doc.s > 0) {
      // Legacy: only scale stored: keep center, infer size from default viewport later.
    }
    this.followBodyLabel = typeof doc.followBody === 'string' && doc.followBody ? doc.followBody : null;
    this.followBodyId = null;
    if (this.followBodyLabel && bodyByLabel?.has(this.followBodyLabel)) {
      this.followBodyId = bodyByLabel.get(this.followBodyLabel).id;
    }
  }

  /** @param {import('matter-js').Body|null} body */
  setFollowBody(body) {
    if (!body) {
      this.followBodyId = null;
      this.followBodyLabel = null;
      return;
    }
    this.followBodyId = body.id;
    this.followBodyLabel = typeof body.label === 'string' ? body.label : null;
    this.centerX = body.position.x;
    this.centerY = body.position.y;
  }
}
