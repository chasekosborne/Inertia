import Matter from 'matter-js';
import { applyCircleInertia } from '../../physics/bodies.js';

const { Body } = Matter;

/** @type {import('../registry.js').ComponentDefinition} */
export const lockRotationComponent = {
  id: 'lockRotation',
  optional: true,
  label: 'Lock rotation',
  description: 'Prevent this body from spinning.',
  systems: ['physics'],

  fromSceneBody(bd) {
    if (bd.material?.lockRotation === true) return { enabled: true };
    return null;
  },

  serialize(body) {
    if (!body._lockRotation) return null;
    return { enabled: true };
  },

  attach(body) {
    body._lockRotation = true;
    Body.setInertia(body, Infinity);
    Body.setAngularVelocity(body, 0);
  },

  detach(body) {
    body._lockRotation = false;
    applyCircleInertia(body);
  },

  inspectorFields: [
    {
      key: 'lock-rotation-title',
      type: 'section-title',
      label: 'Lock rotation',
      group: 'Lock rotation',
      propertyId: 'lockRotation',
      visible: (ctx) => ctx.entity.hasComponent('lockRotation'),
    },
    {
      key: 'lock-rotation',
      type: 'toggle',
      label: 'Locked',
      group: 'Lock rotation',
      id: 'prop-lock-rotation',
      visible: (ctx) => ctx.entity.hasComponent('lockRotation'),
      get: (ctx) => ctx.body._lockRotation === true || ctx.body.inertia === Infinity,
      set: (ctx, val) => {
        if (val) {
          ctx.body._lockRotation = true;
          Body.setInertia(ctx.body, Infinity);
          Body.setAngularVelocity(ctx.body, 0);
        } else {
          ctx.body._lockRotation = false;
          applyCircleInertia(ctx.body);
        }
      },
    },
  ],
};
