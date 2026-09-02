/**
 * Pure v1 scene body → internal component model (no Matter side effects).
 */

import { getComponent, getArchetypeComponents } from '../components/registry.js';

/**
 * @typedef {object} MigratedBody
 * @property {string} id
 * @property {string} archetype
 * @property {Record<string, object>} components  Core components
 * @property {Record<string, object>} optional  Optional properties
 */

/**
 * Detect optional properties from v1 scene body fields.
 * @param {import('./schema.js').SceneBody} bd
 * @returns {Record<string, object>}
 */
export function detectOptionalComponentsV1(bd) {
  /** @type {Record<string, object>} */
  const optional = {};
  const mat = bd.material ?? {};

  const frictionDef = getComponent('surfaceFriction')?.fromSceneBody?.(bd);
  if (frictionDef) optional.surfaceFriction = frictionDef;

  const restDef = getComponent('restitution')?.fromSceneBody?.(bd);
  if (restDef) optional.restitution = restDef;

  const stickyDef = getComponent('stickyContact')?.fromSceneBody?.(bd);
  if (stickyDef) optional.stickyContact = stickyDef;

  const lockDef = getComponent('lockRotation')?.fromSceneBody?.(bd);
  if (lockDef) optional.lockRotation = lockDef;

  const forceDef = getComponent('appliedForce')?.fromSceneBody?.(bd);
  if (forceDef) optional.appliedForce = forceDef;

  const torqueDef = getComponent('appliedTorque')?.fromSceneBody?.(bd);
  if (torqueDef) optional.appliedTorque = torqueDef;

  // frictionAir on body (legacy) — store on body directly, not a component yet
  if (mat.frictionAir != null && mat.frictionAir > 0) {
    optional._frictionAir = mat.frictionAir;
  }

  return optional;
}

/**
 * @param {import('./schema.js').SceneBody} bd
 * @returns {MigratedBody|null}
 */
export function migrateBodyV1ToComponents(bd) {
  if (!bd?.id || !bd.type) return null;
  if (bd.type === 'metric-basis') return null;

  const archetype = bd.type;
  const componentIds = getArchetypeComponents(archetype);
  /** @type {Record<string, object>} */
  const components = {};

  for (const id of componentIds) {
    const def = getComponent(id);
    if (!def?.fromSceneBody) continue;
    const data = def.fromSceneBody(bd);
    if (data != null) components[id] = data;
  }

  const optional = detectOptionalComponentsV1(bd);

  return { id: bd.id, archetype, components, optional };
}

/**
 * @param {import('./schema.js').SceneBody[]} bodies
 * @returns {MigratedBody[]}
 */
export function migrateSceneV1ToComponents(bodies) {
  if (!Array.isArray(bodies)) return [];
  return bodies
    .map(migrateBodyV1ToComponents)
    .filter(Boolean);
}

/**
 * @param {MigratedBody} migrated
 * @returns {object}  v2-style body entry (for future serialize)
 */
export function migratedToV2Body(migrated) {
  return {
    id: migrated.id,
    archetype: migrated.archetype,
    components: { ...migrated.components, ...migrated.optional },
  };
}
