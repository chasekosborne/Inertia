import { transformComponent } from './types/transform.js';
import { shapeComponent } from './types/shape.js';
import { rigidBodyComponent } from './types/rigid-body.js';
import { surfaceFrictionComponent } from './types/surface-friction.js';
import { restitutionComponent } from './types/restitution.js';
import { stickyContactComponent } from './types/sticky-contact.js';
import { lockRotationComponent } from './types/lock-rotation.js';
import { appliedForceComponent } from './types/applied-force-component.js';
import { appliedTorqueComponent } from './types/applied-torque-component.js';

/**
 * @typedef {object} ComponentDefinition
 * @property {string} id
 * @property {boolean} [optional]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string[]} [systems]
 * @property {(bd: import('../scene/schema.js').SceneBody) => object|null} [fromSceneBody]
 * @property {(body: import('matter-js').Body) => object|null} [serialize]
 * @property {(body: import('matter-js').Body, data?: object) => void} [attach]
 * @property {(body: import('matter-js').Body) => void} [detach]
 * @property {import('./metadata.js').InspectorField[]} [inspectorFields]
 */

/** @type {Map<string, ComponentDefinition>} */
const _registry = new Map();

/** Core components always attached per archetype (no material behaviors). */
const ARCHETYPE_COMPONENTS = {
  'ball': ['transform', 'shape', 'rigidBody'],
  point: ['transform', 'shape', 'rigidBody'],
  box: ['transform', 'shape', 'rigidBody'],
  wedge: ['transform', 'shape', 'rigidBody'],
  ground: ['transform', 'shape'],
  anchor: ['transform'],
};

export const CORE_COMPONENT_IDS = new Set(['transform', 'shape', 'rigidBody']);

/**
 * @param {ComponentDefinition} def
 */
export function registerComponent(def) {
  _registry.set(def.id, def);
}

/**
 * @param {string} id
 * @returns {ComponentDefinition|undefined}
 */
export function getComponent(id) {
  return _registry.get(id);
}

/**
 * @returns {ComponentDefinition[]}
 */
export function listComponents() {
  return [..._registry.values()];
}

/**
 * @param {string} archetype
 * @returns {string[]}
 */
export function getArchetypeComponents(archetype) {
  return ARCHETYPE_COMPONENTS[archetype] ?? [];
}

/**
 * @param {import('./entity.js').Entity} entity
 * @returns {ComponentDefinition[]}
 */
export function listForEntity(entity) {
  return entity.listComponents()
    .map(id => getComponent(id))
    .filter(Boolean);
}

/**
 * Collect inspector fields for an entity, preserving component registration order.
 * @param {import('./entity.js').Entity} entity
 * @returns {import('./metadata.js').InspectorField[]}
 */
export function getInspectorFields(entity) {
  const fields = [];
  const seen = new Set();
  const order = [
    ...getArchetypeComponents(entity.archetype),
    'surfaceFriction', 'restitution', 'stickyContact', 'lockRotation',
    'appliedForce', 'appliedTorque',
  ];
  for (const id of order) {
    if (!entity.hasComponent(id)) continue;
    const comp = getComponent(id);
    if (!comp) continue;
    for (const field of comp.inspectorFields ?? []) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Inspector fields for a named archetype preset (before entity exists).
 * @param {string} archetype
 */
export function getInspectorFieldsForArchetype(archetype) {
  const fields = [];
  const seen = new Set();
  for (const id of getArchetypeComponents(archetype)) {
    const comp = getComponent(id);
    if (!comp) continue;
    for (const field of comp.inspectorFields ?? []) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  }
  return fields;
}

registerComponent(transformComponent);
registerComponent(shapeComponent);
registerComponent(rigidBodyComponent);
registerComponent(surfaceFrictionComponent);
registerComponent(restitutionComponent);
registerComponent(stickyContactComponent);
registerComponent(lockRotationComponent);
registerComponent(appliedForceComponent);
registerComponent(appliedTorqueComponent);

export { ARCHETYPE_COMPONENTS };
