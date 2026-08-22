/*
 * Undo / redo history for the Inertia setup phase.
 *
 * Uses the unified scene serializer (bodies + constraints + measurements,
 * environment survives undo/redo intentionally).
 */

import {
  serializeScene,
  deserializeScene,
  cloneSceneDocument,
} from './scene/index.js';

const MAX_HISTORY = 50;

export class HistoryManager {
  constructor() {
    this._undo  = [];
    this._redo  = [];
    this.frozen = false;
  }

  push(snapshot) {
    if (this.frozen) return;
    this._undo.push(snapshot);
    this._redo = [];
    if (this._undo.length > MAX_HISTORY) this._undo.shift();
  }

  undo(currentSnapshot) {
    if (!this._undo.length) return null;
    this._redo.push(currentSnapshot);
    return this._undo.pop();
  }

  redo(currentSnapshot) {
    if (!this._redo.length) return null;
    this._undo.push(currentSnapshot);
    return this._redo.pop();
  }

  clear() {
    this._undo = [];
    this._redo = [];
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
}

/**
 * @param {import('./physics/engine.js').PhysicsEngine} engine
 * @param {object} [extras]
 * @param {object[]} [extras.measurements]
 * @param {object[]} [extras.labels]
 */
export function captureSnapshot(engine, extras = {}) {
  const measurements = Array.isArray(extras.measurements) ? extras.measurements : [];
  const labels = Array.isArray(extras.labels) ? extras.labels : [];
  return cloneSceneDocument(serializeScene(engine, {
    includeEnvironment: false,
    includeCamera: false,
    meta: { name: 'Undo snapshot' },
    measurements,
    labels,
  }));
}

// @param {object} snapshot @param {import('./physics/engine.js').PhysicsEngine} engine
export function applySnapshot(snapshot, engine) {
  deserializeScene(snapshot, engine, {
    applyEnvironment: false,
    applyCamera: false,
  });
}
