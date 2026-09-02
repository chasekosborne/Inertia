/**
 * Lightweight entity wrapper bridging scene ids and Matter bodies during migration.
 */

/** @typedef {Set<string>} ComponentSet */

/**
 * @param {import('matter-js').Body} body
 * @returns {ComponentSet}
 */
export function getBodyComponents(body) {
  if (!body._entityComponents) body._entityComponents = new Set();
  return body._entityComponents;
}

/**
 * @param {import('matter-js').Body} body
 * @param {string} componentId
 */
export function attachComponent(body, componentId) {
  getBodyComponents(body).add(componentId);
}

/**
 * @param {import('matter-js').Body} body
 * @param {string} componentId
 */
export function detachComponent(body, componentId) {
  getBodyComponents(body).delete(componentId);
}

/**
 * @param {import('matter-js').Body} body
 * @param {string} componentId
 */
export function hasComponent(body, componentId) {
  return getBodyComponents(body).has(componentId);
}

/**
 * @param {import('matter-js').Body} body
 * @param {string[]} componentIds
 */
export function attachComponents(body, componentIds) {
  const set = getBodyComponents(body);
  for (const id of componentIds) set.add(id);
}

export class Entity {
  /**
   * @param {import('matter-js').Body} body
   */
  constructor(body) {
    this.body = body;
    this.id = body.label ?? String(body.id);
    this.archetype = body._archetype ?? body._newtonType ?? 'unknown';
  }

  /** @param {string} componentId */
  hasComponent(componentId) {
    return hasComponent(this.body, componentId);
  }

  /** @returns {string[]} */
  listComponents() {
    return [...getBodyComponents(this.body)];
  }

  /** @param {import('matter-js').Body} body */
  static fromBody(body) {
    return new Entity(body);
  }
}

import { getArchetypeComponents } from './registry.js';

/**
 * Ensure entity metadata exists on a runtime body (idempotent).
 * @param {import('matter-js').Body} body
 * @returns {Entity}
 */
export function ensureEntity(body) {
  if (!body._entityId) body._entityId = body.label ?? String(body.id);
  if (!body._archetype) body._archetype = body._newtonType;
  if (!body._entityComponents?.size) {
    attachComponents(body, getArchetypeComponents(body._archetype ?? body._newtonType));
  }
  return Entity.fromBody(body);
}

/**
 * Attach component set from migrated scene data.
 * @param {import('matter-js').Body} body
 * @param {{ archetype?: string, components?: Record<string, object> }} migrated
 */
export function attachFromMigration(body, migrated) {
  body._entityId = body.label ?? String(body.id);
  if (migrated.archetype) {
    body._archetype = migrated.archetype;
  }
  if (migrated.components) {
    body._componentData = migrated.components;
    attachComponents(body, Object.keys(migrated.components));
  }
}
