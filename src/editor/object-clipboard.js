/**
 * Copy / paste for the current selection (Ctrl+C, Ctrl+V).
 *
 * Setup mode only, and inert while the camera tool owns input.
 *
 * Repeated pastes step diagonally away from the original rather than stacking
 * on top of each other; the offset multiplier resets on the next copy. After a
 * paste the new objects become the selection, preferring the most specific
 * shape available — a rope over its segments, an aggregate over its members,
 * a single body over a one-element group.
 */

import {
  captureSelectionClipboard, pasteClipboard, PASTE_OFFSET_M,
} from '../scene/clipboard.js';
import { getUiAggregates } from '../scene/aggregates.js';
import { ropeSelection } from '../physics/rope.js';

export class ObjectClipboard {
  /** @param {import('./handles/editor-context.js').EditorContext} context */
  constructor(context) {
    this.context = context;
    /** @type {{ bodies: object[], constraints: object[], uiAggregates?: object[] }|null} */
    this._contents = null;
    /** Paste-stack offset multiplier; resets on a new copy. */
    this._pasteGeneration = 0;
  }

  /** True while copy / paste should respond at all. */
  _enabled() {
    const { context } = this;
    return context.canEdit() && context.getToolMode() !== 'camera';
  }

  /** @returns {boolean} whether the event was consumed. */
  copy() {
    if (!this._enabled()) return false;
    const { context } = this;
    const captured = captureSelectionClipboard(context.engine, context.getSelection());
    if (!captured) return false;
    this._contents = captured;
    this._pasteGeneration = 0;
    return true;
  }

  /** @returns {boolean} whether the event was consumed. */
  paste() {
    if (!this._enabled()) return false;
    if (!this._contents?.bodies?.length) return false;
    const { context } = this;

    this._pasteGeneration += 1;
    const offset = PASTE_OFFSET_M * this._pasteGeneration;
    context.pushHistory();
    const result = pasteClipboard(context.engine, this._contents, {
      dxM: offset,
      dyM: offset,
    });
    if (!result) return false;

    const bodies = Object.values(result.bodyMap);
    context.refreshBrowser();
    // Nothing to select is not the same as "select nothing": leave the
    // existing selection alone rather than clearing it.
    const selection = this._selectionFor(bodies);
    if (selection) context.onSelect(selection);
    return true;
  }

  /**
   * Most specific selection covering the freshly pasted bodies.
   * @param {object[]} bodies
   */
  _selectionFor(bodies) {
    const { engine } = this.context;

    // A rope pastes as many segments but is selected as one rope.
    const ropeBodies = bodies.filter(b => b._ropeSegment && b._ropeId);
    if (ropeBodies.length && ropeBodies.every(b => b._ropeId === ropeBodies[0]._ropeId)) {
      const selection = ropeSelection(engine, ropeBodies[0]._ropeId);
      if (selection) return selection;
    }

    // An aggregate whose every member was pasted comes back as that aggregate.
    const pastedIds = new Set(bodies.map(b => b.id));
    const aggregates = getUiAggregates(engine).filter(aggregate =>
      Array.isArray(aggregate.memberIds)
      && aggregate.memberIds.length >= 2
      && aggregate.memberIds.every(id => pastedIds.has(id)),
    );
    if (aggregates.length) {
      const aggregate = aggregates[aggregates.length - 1];
      return {
        type: 'aggregate',
        aggId: aggregate.id,
        id: aggregate.id,
        key: `agg:${aggregate.id}`,
        memberIds: [...aggregate.memberIds],
      };
    }

    if (bodies.length === 1) {
      return { type: 'body', id: bodies[0].id };
    }
    if (bodies.length > 1) {
      return {
        type: 'aggregate',
        memberIds: bodies.map(b => b.id),
        key: `paste:${bodies[0].id}`,
      };
    }
    return null;
  }
}
