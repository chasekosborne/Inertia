/**
 * Inspector field metadata schema for component-driven properties panels.
 *
 * @typedef {'number'|'boolean'|'section-title'|'read-only'|'toggle'|'custom'} InspectorFieldType
 */

/**
 * @typedef {object} InspectorField
 * @property {string} key
 * @property {string} [label]
 * @property {InspectorFieldType} type
 * @property {string} [unit]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} [group]
 * @property {string} [id]  DOM element id (defaults to prop-{key})
 * @property {number} [decimals]  Display precision for read-only refresh
 * @property {boolean} [bindable]  Eligible for label/graph binding (Phase 3)
 * @property {(ctx: InspectorContext) => boolean} [visible]
 * @property {(ctx: InspectorContext) => boolean} [editable]
 * @property {(ctx: InspectorContext) => string|number|boolean} [get]
 * @property {(ctx: InspectorContext, value: unknown) => void} [set]
 * @property {(ctx: InspectorContext) => string} [format]  Custom display formatter
 * @property {boolean} [liveRefresh]  Update on sim tick when not focused
 */

/**
 * @typedef {object} InspectorContext
 * @property {import('./entity.js').Entity} entity
 * @property {import('matter-js').Body} body
 * @property {() => void} push
 * @property {() => boolean} snapOn
 * @property {(body: import('matter-js').Body) => void} [syncRopes]
 * @property {(body: import('matter-js').Body, nw: number, nh: number) => void} [scaleBox]
 * @property {() => void} [deleteBody]
 * @property {Record<string, unknown>} [extras]
 */

export function fieldId(field) {
  return field.id ?? `prop-${field.key}`;
}
