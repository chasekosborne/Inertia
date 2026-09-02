import { setBodyAnchored, setBodyMass, bodyDisplayMass } from '../../physics/bodies.js';

/** @type {import('../registry.js').ComponentDefinition} */
export const rigidBodyComponent = {
  id: 'rigidBody',
  systems: ['physics'],

  fromSceneBody(bd) {
    if (bd.type === 'anchor' || bd.type === 'ground' || bd.type === 'metric-basis') return null;
    return {
      mass: bd.mass ?? 1,
      isStatic: bd.isStatic === true,
    };
  },

  serialize(body) {
    if (body._newtonType === 'anchor' || body._newtonType === 'ground') return null;
    const data = { mass: bodyDisplayMass(body) };
    if (body.isStatic) data.isStatic = true;
    return data;
  },

  inspectorFields: [
    {
      key: 'anchored',
      type: 'toggle',
      label: 'Anchored',
      group: 'Rigid body',
      id: 'prop-anchored',
      visible: (ctx) => ctx.entity.hasComponent('rigidBody'),
      get: (ctx) => ctx.body.isStatic,
      set: (ctx, val) => {
        setBodyAnchored(ctx.body, !!val);
        ctx.extras?.onAnchoredChange?.(ctx.body);
      },
    },
    {
      key: 'mass',
      type: 'number',
      label: 'mass',
      unit: 'kg',
      step: 0.1,
      min: 0.01,
      group: 'Rigid body',
      id: 'prop-mass',
      bindable: true,
      visible: (ctx) => ctx.entity.hasComponent('rigidBody'),
      get: (ctx) => bodyDisplayMass(ctx.body),
      set: (ctx, val) => {
        const v = Number(val);
        if (v > 0) setBodyMass(ctx.body, v);
      },
    },
  ],
};
