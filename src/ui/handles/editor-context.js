import { clientToWorld } from './chrome.js';

/**
 * @typedef {object} EditorContext
 * Everything an on-canvas handle widget needs from the app.
 */

export function createEditorContext(deps) {
  const {
    engine, camera, svg, renderer,
    getSnapEnabled, getSelection, getAppMode, getToolMode, getShowVectors,
    pushHistory, onSelect, refreshBrowser, showProperties,
    applyVelocity, applyAppliedForce,
  } = deps;

  return {
    engine,
    camera,
    svg,
    /** Shared parent for all handle DOM. */
    layer: renderer.uiTopLayer,

    //Volatile state (getters)
    getSnapEnabled,      // () => boolean
    getSelection,        // () => { type, id, … } | null
    getAppMode,          // () => 'setup' | 'live' | 'review'
    getToolMode,         // () => 'select' | 'scale' | 'camera' | …
    getShowVectors,      // () => boolean — force/velocity arrow layer visible
    canEdit: () => getAppMode() === 'setup',

    //Commands
    pushHistory,         // () => void   — snapshot BEFORE a drag begins
    onSelect,            // (sel) => void
    refreshBrowser,      // () => void
    showProperties,      // (selection) => void — re-render the properties panel
    selectBodies: (ids, opts) => renderer.select(ids, opts),
    applyVelocity,       // (body, vx, vy, opts) => void
    applyAppliedForce,   // (body, F, thetaDeg) => void

    //Helpers
    clientToWorld: (cx, cy) => clientToWorld(svg, camera, cx, cy),
  };
}