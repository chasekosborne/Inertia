import { setAppliedTorque, clearAppliedTorque, getAppliedTorque } from '../../physics/applied-torque.js';
import { MATH } from '../../math-text.js';

/** @type {import('../registry.js').ComponentDefinition} */
export const appliedTorqueComponent = {
  id: 'appliedTorque',
  optional: true,
  label: 'Applied torque',
  description: 'Constant torque τ about the centre of mass.',
  systems: ['physics'],

  fromSceneBody(bd) {
    if (typeof bd.appliedTorque === 'number' && isFinite(bd.appliedTorque) && bd.appliedTorque !== 0) {
      return { tau: bd.appliedTorque };
    }
    return null;
  },

  serialize(body) {
    const tau = getAppliedTorque(body);
    if (tau == null || tau === 0) return null;
    return { tau };
  },

  attach(body, data) {
    body._appliedTorqueCapable = true;
  },

  detach(body) {
    clearAppliedTorque(body);
    body._appliedTorqueCapable = false;
  },

  inspectorFields: [
    {
      key: 'applied-torque-title',
      type: 'section-title',
      label: 'Applied torque',
      group: 'Applied torque',
      propertyId: 'appliedTorque',
      visible: (ctx) => ctx.entity.hasComponent('appliedTorque'),
    },
    {
      key: 'applied-torque',
      type: 'number',
      label: `${MATH.tau}`,
      unit: 'N·m',
      step: 0.05,
      group: 'Applied torque',
      id: 'prop-tau',
      visible: (ctx) => ctx.entity.hasComponent('appliedTorque')
        && ctx.body.inertia !== Infinity
        && !ctx.body._lockRotation,
      get: (ctx) => getAppliedTorque(ctx.body) ?? 0,
      set: (ctx, val) => {
        const tau = Number(val) || 0;
        if (tau === 0) clearAppliedTorque(ctx.body);
        else setAppliedTorque(ctx.body, tau);
      },
    },
  ],
};
