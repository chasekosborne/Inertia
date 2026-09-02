import { hasComponent } from '../components/entity.js';
import { getComponent } from '../components/registry.js';
import { PX_PER_M } from '../units.js';

/**
 * Build v1 material block from attached optional components.
 * @param {import('matter-js').Body} body
 * @returns {object|undefined}
 */
export function serializeBodyMaterial(body) {
  if (body._newtonType === 'anchor' || body._newtonType === 'metric-basis') return undefined;

  /** @type {Record<string, unknown>} */
  const material = {};

  if (hasComponent(body, 'restitution')) {
    material.restitution = body.restitution;
  }
  if (hasComponent(body, 'surfaceFriction')) {
    const d = getComponent('surfaceFriction')?.serialize?.(body);
    if (d) {
      material.muK = d.muK;
      material.muS = d.muS;
    }
  }
  if (hasComponent(body, 'stickyContact') && body._stickOnContact) {
    material.stickOnContact = true;
  }
  if (hasComponent(body, 'lockRotation') && body._lockRotation) {
    material.lockRotation = true;
  }
  if (body.frictionAir > 0) {
    material.frictionAir = body.frictionAir;
  }

  if (body._ropeSegment) {
    material.ropeSegment = true;
    if (body._ropeId) material.ropeId = body._ropeId;
    if (Number.isFinite(body._ropeIndex)) material.ropeIndex = body._ropeIndex;
    if (Number.isFinite(body._ropeCount)) material.ropeCount = body._ropeCount;
    if (typeof body._ropeName === 'string' && body._ropeName) material.ropeName = body._ropeName;
    if (body._ropeRestLength > 0) material.ropeRestLength = body._ropeRestLength / PX_PER_M;
    if (body._ropeHost?.body) {
      material.ropeHost = {
        body: body._ropeHost.body.label ?? String(body._ropeHost.body.id),
        x: (body._ropeHost.local?.x ?? 0) / PX_PER_M,
        y: (body._ropeHost.local?.y ?? 0) / PX_PER_M,
      };
    }
  }

  return Object.keys(material).length ? material : undefined;
}
