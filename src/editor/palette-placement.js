/**
 * Drag-to-place from the object palette.
 *
 * Press a palette button and a floating HTML ghost of its icon follows the
 * cursor; release over the canvas to create that body at the drop point.
 *
 * The ghost is an HTML div positioned in client coordinates, not an SVG
 * element in world space, so it stays the same size regardless of camera zoom
 * and can be dragged outside the canvas. Pointer capture stays on the button
 * for the whole gesture, which is why every handler lives here rather than on
 * the canvas.
 */

import {
  createBall, createPoint, createBox, createWedge, createAnchor,
} from '../physics/bodies.js';
import { attachCoreComponents } from '../components/optional-properties.js';
import { snapWorldCoord } from '../grid.js';

/** Palette tool id → body factory. */
const FACTORIES = {
  'ball': createBall,
  'point': createPoint,
  'box': createBox,
  'wedge': createWedge,
  'anchor': createAnchor,
};

/** Class put on the canvas while a drag hovers it. */
const DROP_TARGET_CLASS = 'palette-drop-target';

export class PalettePlacement {
  /**
   * @param {object} deps
   * @param {SVGSVGElement} deps.svg
   * @param {object} deps.camera
   * @param {object} deps.engine
   * @param {() => string} deps.getToolMode
   * @param {() => boolean} deps.getSnapEnabled
   * @param {(body: object) => void} deps.onPlaced  Select the new body.
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {{ type: string, ghost: HTMLElement }|null} */
    this._drag = null;
    this._bindEvents();
  }

  _bindEvents() {
    for (const button of document.querySelectorAll('.obj-btn[data-drag-place]')) {
      button.addEventListener('pointerdown', event => this._onDown(event, button));
      button.addEventListener('pointermove', event => this._onMove(event));
      button.addEventListener('pointerup', event => this._onUp(event));
      button.addEventListener('pointercancel', () => this._cancel());
    }
  }

  /** Is this client point over the canvas? */
  _overCanvas(event) {
    const rect = this.deps.svg.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  _onDown(event, button) {
    if (this.deps.getToolMode() === 'camera') return;
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);

    const ghost = document.createElement('div');
    ghost.id = 'palette-drag-ghost';
    ghost.innerHTML = button.querySelector('svg').outerHTML;
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;
    document.body.appendChild(ghost);

    this._drag = { type: button.dataset.tool, ghost };
  }

  _onMove(event) {
    if (!this._drag) return;
    this._drag.ghost.style.left = `${event.clientX}px`;
    this._drag.ghost.style.top = `${event.clientY}px`;
    this.deps.svg.classList.toggle(DROP_TARGET_CLASS, this._overCanvas(event));
  }

  _onUp(event) {
    if (!this._drag) return;
    const { type } = this._drag;
    this._cancel();
    if (!this._overCanvas(event)) return;

    const { svg, camera, engine, getSnapEnabled, onPlaced } = this.deps;
    const rect = svg.getBoundingClientRect();
    const world = camera.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const snap = getSnapEnabled();

    const factory = FACTORIES[type];
    if (!factory) return;
    const body = factory(snapWorldCoord(world.x, snap), snapWorldCoord(world.y, snap));
    if (!body) return;

    attachCoreComponents(body);
    engine.addBody(body);
    onPlaced(body);
  }

  /** Drop the ghost and the hover highlight without placing anything. */
  _cancel() {
    if (!this._drag) return;
    this._drag.ghost.remove();
    this.deps.svg.classList.remove(DROP_TARGET_CLASS);
    this._drag = null;
  }
}
