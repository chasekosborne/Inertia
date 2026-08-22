/**
 * Default / blank scene documents.
 */

import { SCENE_FORMAT, SCENE_VERSION, defaultEnvironment } from './schema.js';

/**
 * Empty sandbox: metric origin at (0, 0) m, default environment, no bodies.
 * Camera framing is applied on load so the origin sits at the centre of the viewport.
 * @returns {import('./schema.js').SceneDocument}
 */
export function buildBlankScene() {
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: { name: 'Untitled scene', source: 'blank' },
    metricOrigin: { x: 0, y: 0 },
    environment: defaultEnvironment(),
    camera: null,
    bodies: [],
    constraints: [],
  };
}
