/**
 * 2D camera: pan + zoom via SVG group transform translate(tx,ty) scale(s).
 * Screen coords are relative to the SVG element's top-left (CSS pixels).
 */

/** Default zoom for blank / unframed scenes (world px → screen px). */
export const DEFAULT_CAMERA_SCALE = 1.35;

export class Camera {
  constructor() {
    this.tx = 0;
    this.ty = 0;
    this.s  = DEFAULT_CAMERA_SCALE;
    this._minS = 0.12;
    this._maxS = 24;
    this._worldGroup = null;

    this._panning     = false;
    this._panStartSvg = null;
    this._panStartTx  = 0;
    this._panStartTy  = 0;
  }

  attach(worldGroup) {
    this._worldGroup = worldGroup;
    this.apply();
  }

  reset() {
    this.tx = 0;
    this.ty = 0;
    this.s  = DEFAULT_CAMERA_SCALE;
    this.apply();
  }

  /** Set an explicit transform without animation (used by preset camera hints). */
  setTransform(tx, ty, s) {
    this.tx = tx;
    this.ty = ty;
    this.s  = Math.max(this._minS, Math.min(this._maxS, s));
    this.apply();
  }

  /**
   * Pan so a world point sits at the centre of a viewport of size (viewW × viewH).
   * @param {number} wx
   * @param {number} wy
   * @param {number} viewW
   * @param {number} viewH
   * @param {number} [s]  Zoom, defaults to current scale
   */
  centerOnWorld(wx, wy, viewW, viewH, s = this.s) {
    const newS = Math.max(this._minS, Math.min(this._maxS, s));
    this.s = newS;
    this.tx = viewW / 2 - wx * newS;
    this.ty = viewH / 2 - wy * newS;
    this.apply();
  }

  apply() {
    if (!this._worldGroup) return;
    this._worldGroup.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.s})`);
  }

  /** SVG-local screen px → simulation / world px */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.tx) / this.s,
      y: (sy - this.ty) / this.s,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: wx * this.s + this.tx,
      y: wy * this.s + this.ty,
    };
  }

  /** Zoom about cursor (sx, sy) in SVG-local px. deltaY > 0 = zoom out. */
  onWheel(sx, sy, deltaY) {
    const factor = deltaY > 0 ? 0.92 : 1 / 0.92;
    const newS = Math.max(this._minS, Math.min(this._maxS, this.s * factor));
    if (Math.abs(newS - this.s) < 1e-6) return;

    const wx = (sx - this.tx) / this.s;
    const wy = (sy - this.ty) / this.s;
    this.tx = sx - wx * newS;
    this.ty = sy - wy * newS;
    this.s  = newS;
    this.apply();
  }

  beginPan(sx, sy) {
    this._panning      = true;
    this._panStartSvg  = { x: sx, y: sy };
    this._panStartTx   = this.tx;
    this._panStartTy   = this.ty;
  }

  movePan(sx, sy) {
    if (!this._panning || !this._panStartSvg) return;
    this.tx = this._panStartTx + (sx - this._panStartSvg.x);
    this.ty = this._panStartTy + (sy - this._panStartSvg.y);
    this.apply();
  }

  endPan() {
    this._panning      = false;
    this._panStartSvg  = null;
  }

  get isPanning() { return this._panning; }
}
