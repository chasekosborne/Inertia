import { SCENE_FORMAT, SCENE_VERSION } from './schema.js';

const BODY_TYPES = new Set(['point-mass', 'ball', 'box', 'wedge', 'ground', 'anchor', 'metric-basis']);
const CONSTRAINT_TYPES = new Set(['spring', 'rod', 'string']);

/**
 * @param {unknown} doc
 * @returns {{ ok: true, doc: import('./schema.js').SceneDocument } | { ok: false, error: string }}
 */
export function validateSceneDocument(doc) {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'File is not a valid JSON object.' };
  }

  const d = /** @type {Record<string, unknown>} */ (doc);

  if (d.format !== SCENE_FORMAT) {
    return { ok: false, error: `Unsupported format "${d.format}". Expected "${SCENE_FORMAT}".` };
  }

  const version = d.version;
  if (typeof version !== 'number' || version > SCENE_VERSION) {
    return { ok: false, error: `Unsupported scene version ${version}. This app supports up to version ${SCENE_VERSION}.` };
  }

  if (!Array.isArray(d.bodies)) {
    return { ok: false, error: 'Scene is missing a "bodies" array.' };
  }

  if (!Array.isArray(d.constraints)) {
    return { ok: false, error: 'Scene is missing a "constraints" array.' };
  }

  const ids = new Set();
  for (const b of d.bodies) {
    if (!b || typeof b !== 'object') {
      return { ok: false, error: 'Each body must be an object.' };
    }
    const body = /** @type {Record<string, unknown>} */ (b);
    if (typeof body.id !== 'string' || !body.id) {
      return { ok: false, error: 'Every body needs a non-empty string "id".' };
    }
    if (ids.has(body.id)) {
      return { ok: false, error: `Duplicate body id "${body.id}".` };
    }
    ids.add(body.id);
    if (!BODY_TYPES.has(/** @type {string} */ (body.type))) {
      return { ok: false, error: `Unknown body type "${body.type}" on "${body.id}".` };
    }
    if (!body.position || typeof body.position !== 'object') {
      return { ok: false, error: `Body "${body.id}" is missing "position".` };
    }
  }

  for (const c of d.constraints) {
    if (!c || typeof c !== 'object') {
      return { ok: false, error: 'Each constraint must be an object.' };
    }
    const con = /** @type {Record<string, unknown>} */ (c);
    if (typeof con.id !== 'string' || !con.id) {
      return { ok: false, error: 'Every constraint needs a non-empty string "id".' };
    }
    if (!CONSTRAINT_TYPES.has(/** @type {string} */ (con.type))) {
      return { ok: false, error: `Unknown constraint type "${con.type}" on "${con.id}".` };
    }
    if (typeof con.bodyA !== 'string' || !con.bodyA) {
      return { ok: false, error: `Constraint "${con.id}" must attach both ends — bodyA is required.` };
    }
    if (typeof con.bodyB !== 'string' || !con.bodyB) {
      return { ok: false, error: `Constraint "${con.id}" must attach both ends — bodyB is required.` };
    }
    if (!ids.has(con.bodyA)) {
      return { ok: false, error: `Constraint "${con.id}" references unknown bodyA "${con.bodyA}".` };
    }
    if (!ids.has(con.bodyB)) {
      return { ok: false, error: `Constraint "${con.id}" references unknown bodyB "${con.bodyB}".` };
    }
    if (con.bodyA === con.bodyB) {
      return { ok: false, error: `Constraint "${con.id}" cannot attach both ends to the same body.` };
    }
    if (con.type === 'spring') {
      if (typeof con.k !== 'number' || con.k <= 0) {
        return { ok: false, error: `Spring "${con.id}" needs a positive "k" (N/m).` };
      }
    }
  }

  return { ok: true, doc: /** @type {import('./schema.js').SceneDocument} */ (doc) };
}
