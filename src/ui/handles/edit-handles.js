/**
 * Selection edit handles: the grab dots that appear on whatever is selected.
 *
 * This is a facade. The per-object behaviour lives in `edit/`:
 *
 *   constraint-handles  rod / string / spring ends — stretch or reattach
 *   rope-handles        rope ends — reattach, or detach into empty space
 *   ground-handles      ground top corners — lay the segment
 *
 * Everything those three share is owned here: the handle `<g>`, the build key
 * that decides when to rebuild rather than reposition, the in-flight drag, the
 * ghost preview slot, the capture-phase document listeners, and the
 * hover-target highlight. A strategy only implements what makes it different.
 *
 * `main.js` sees one object with `sync()` / `reset()`.
 */

import { handleGroup } from './chrome.js';
import { constraintHandles } from './edit/constraint-handles.js';
import { ropeHandles } from './edit/rope-handles.js';
import { groundHandles } from './edit/ground-handles.js';

const STRATEGIES = [constraintHandles, ropeHandles, groundHandles];

export class EditHandles {
  /** @param {import('./editor-context.js').EditorContext} context */
  constructor(context) {
    this.context = context;
    /** @type {SVGGElement|null} */
    this._group = null;
    /** @type {object|null} In-flight drag descriptor, owned by a strategy. */
    this._drag = null;
    /** Strategy that started the current drag. */
    this._dragStrategy = null;
    /** @type {SVGElement|null} Preview element for the current drag. */
    this._ghost = null;
    /** `<prefix>:<id>`, or '' when nothing is shown. */
    this._buildKey = '';
    /** Strategy matching `_buildKey`. */
    this._strategy = null;
    /** Id suffix of `_buildKey`. */
    this._id = '';

    // Bound once: add/removeEventListener must see the same reference.
    this._onDocumentMove = this._onDocumentMove.bind(this);
    this._onDocumentUp = this._onDocumentUp.bind(this);

    /** One session per strategy, so `beginDrag` knows who called it. */
    this._sessions = new Map(
      STRATEGIES.map(strategy => [strategy, this._makeSession(strategy)]),
    );
  }

  // ─── Session handed to strategies ────────────────────────────────

  _makeSession(strategy) {
    return {
      context: this.context,
      updatePositions: () => this._updatePositions(),
      setHoverHighlight: bodyId => this._setHoverHighlight(bodyId),
      getGhost: () => this._ghost,
      setGhost: element => this._setGhost(element),
      getDrag: () => this._drag,
      invalidateBuildKey: () => { this._buildKey = ''; },
      beginDrag: drag => this._beginDrag(strategy, drag),
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /** Called every render frame. */
  sync() {
    const { context } = this;
    // Select tool only, and never while live. In the creation tools these dots
    // sit on top of the very anchors you press to start a new link, and
    // `interaction._onDown` bails on anything carrying the handle attribute —
    // ground corner handles in particular would swallow the gesture.
    if (context.getToolMode() !== 'select' || context.getAppMode() === 'live') {
      if (!this._drag) this.reset();
      return;
    }
    if (this._drag) {
      this._updatePositions();
      return;
    }

    const selection = context.getSelection();
    let strategy = null;
    let id = '';
    for (const candidate of STRATEGIES) {
      const match = candidate.keyFor(selection, context);
      if (match != null) {
        strategy = candidate;
        id = match;
        break;
      }
    }

    if (!strategy) {
      this.reset();
      return;
    }

    const key = `${strategy.prefix}:${id}`;
    if (key !== this._buildKey) {
      this._clearDom();
      this._buildKey = key;
      this._strategy = strategy;
      this._id = id;
      this._build();
    }
    this._updatePositions();
  }

  /** Drop handle DOM and invalidate the build key. */
  reset() {
    this._clearDom();
    this._buildKey = '';
    this._strategy = null;
    this._id = '';
  }

  /** Remove listeners and DOM. */
  destroy() {
    this._unbindDrag();
    this.reset();
  }

  _clearDom() {
    if (this._group) { this._group.remove(); this._group = null; }
    this._setGhost(null);
    this._drag = null;
    this._dragStrategy = null;
  }

  // ─── Build / position ────────────────────────────────────────────

  _build() {
    const group = handleGroup('selection-edit-handles');
    this.context.layer.appendChild(group);
    this._group = group;
    this._strategy.build(group, this._id, this._sessions.get(this._strategy));
  }

  _updatePositions() {
    if (!this._group || !this._strategy) return;
    if (!this.context.getSelection()) return;
    this._strategy.updatePositions(
      this._group, this._id, this._sessions.get(this._strategy),
    );
  }

  // ─── Ghost slot ──────────────────────────────────────────────────

  _setGhost(element) {
    if (this._ghost === element) return;
    if (this._ghost) this._ghost.remove();
    this._ghost = element;
    if (element) this.context.layer.appendChild(element);
  }

  // ─── Hover highlight ─────────────────────────────────────────────

  _setHoverHighlight(bodyId) {
    for (const group of this.context.svg.querySelectorAll('.body-group')) {
      const id = parseInt(group.id.replace('body-', ''), 10);
      group.classList.toggle('hover-target', bodyId != null && id === bodyId);
    }
  }

  // ─── Drag ────────────────────────────────────────────────────────

  _beginDrag(strategy, drag) {
    this._drag = drag;
    this._dragStrategy = strategy;
    document.addEventListener('pointermove', this._onDocumentMove, true);
    document.addEventListener('pointerup', this._onDocumentUp, true);
  }

  _unbindDrag() {
    document.removeEventListener('pointermove', this._onDocumentMove, true);
    document.removeEventListener('pointerup', this._onDocumentUp, true);
  }

  _onDocumentMove(event) {
    if (!this._drag || !this._dragStrategy) return;
    const world = this.context.clientToWorld(event.clientX, event.clientY);
    this._dragStrategy.onMove(
      this._drag, world, event, this._sessions.get(this._dragStrategy),
    );
  }

  _onDocumentUp() {
    this._unbindDrag();
    const drag = this._drag;
    const strategy = this._dragStrategy;
    this._drag = null;
    this._dragStrategy = null;
    this._setHoverHighlight(null);
    this._setGhost(null);
    if (drag && strategy) strategy.onUp(drag, this._sessions.get(strategy));
  }
}
