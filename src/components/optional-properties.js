import { APPLIED_FORCE_BODY_TYPES } from '../physics/applied-force.js';
import {
  attachComponent,
  detachComponent,
  Entity,
} from './entity.js';
import {
  getComponent,
  getArchetypeComponents,
  listComponents,
  CORE_COMPONENT_IDS,
} from './registry.js';

/**
 * @param {import('./entity.js').Entity} entity
 * @param {string} id
 */
export function canAttachProperty(entity, id) {
  const def = getComponent(id);
  if (!def?.optional) return false;
  if (entity.hasComponent(id)) return false;

  const body = entity.body;
  if (!body) return false;

  if (['surfaceFriction', 'restitution', 'stickyContact'].includes(id)) {
    if (!entity.hasComponent('shape')) return false;
  }
  if (id === 'appliedForce') {
    if (!entity.hasComponent('rigidBody')) return false;
    if (body.isStatic) return false;
    if (!APPLIED_FORCE_BODY_TYPES.has(body._newtonType ?? body._archetype)) return false;
  }
  if (id === 'appliedTorque') {
    if (!entity.hasComponent('rigidBody')) return false;
    if (body.isStatic) return false;
    if (body.inertia === Infinity || body._lockRotation) return false;
  }
  if (id === 'lockRotation') {
    if (!entity.hasComponent('rigidBody')) return false;
    if (body.isStatic) return false;
  }
  return true;
}

/**
 * @param {import('./entity.js').Entity} entity
 * @param {string} id
 */
export function canDetachProperty(entity, id) {
  if (CORE_COMPONENT_IDS.has(id)) return false;
  return entity.hasComponent(id);
}

/**
 * @param {import('./entity.js').Entity} entity
 * @returns {import('./registry.js').ComponentDefinition[]}
 */
export function listAttachableProperties(entity) {
  return listComponents()
    .filter(def => def.optional && canAttachProperty(entity, def.id));
}

/**
 * @param {import('matter-js').Body} body
 * @param {string} id
 * @param {object} [data]
 */
export function attachProperty(body, id, data) {
  const def = getComponent(id);
  if (!def) return false;
  const entity = Entity.fromBody(body);
  if (!canAttachProperty(entity, id)) return false;

  def.attach?.(body, data);
  attachComponent(body, id);
  if (!body._componentData) body._componentData = {};
  body._componentData[id] = data ?? def.serialize?.(body) ?? { enabled: true };
  return true;
}

/**
 * @param {import('matter-js').Body} body
 * @param {string} id
 */
export function detachProperty(body, id) {
  const def = getComponent(id);
  if (!def) return false;
  const entity = Entity.fromBody(body);
  if (!canDetachProperty(entity, id)) return false;

  def.detach?.(body);
  detachComponent(body, id);
  if (body._componentData) delete body._componentData[id];
  return true;
}

/**
 * Attach core archetype components on a freshly created body.
 * @param {import('matter-js').Body} body
 */
export function attachCoreComponents(body) {
  const archetype = body._archetype ?? body._newtonType;
  for (const id of getArchetypeComponents(archetype)) {
    attachComponent(body, id);
  }
  if (!body._archetype) body._archetype = body._newtonType;
  if (!body._entityId) body._entityId = body.label ?? String(body.id);
}

/**
 * Apply migrated optional properties with attach() side effects.
 * @param {import('matter-js').Body} body
 * @param {Record<string, object>} optionalComponents
 */
export function attachOptionalFromMigration(body, optionalComponents) {
  for (const [id, data] of Object.entries(optionalComponents)) {
    if (id.startsWith('_')) continue;
    attachProperty(body, id, data);
  }
}
