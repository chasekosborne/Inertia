import {
  clearAppliedForce,
  setDrivenAppliedForce,
  getAppliedForce,
  getAppliedForceDirection,
  isDrivenAppliedForce,
  getDrivenAppliedForceExpr,
  getDrivenAppliedParameters,
  DEFAULT_DRIVEN_APPLIED_FORCE_EXPR,
} from '../../physics/applied-force.js';
import { MATH } from '../../math-text.js';

/** @type {import('../registry.js').ComponentDefinition} */
export const appliedForceComponent = {
  id: 'appliedForce',
  optional: true,
  label: 'Applied force',
  description: 'Constant or time-varying force F(t) along a direction θ.',
  systems: ['physics'],

  fromSceneBody(bd) {
    if (bd.drivenApplied === true || bd.appliedForce) {
      return {
        driven: bd.drivenApplied === true,
        expression: bd.drivenAppliedForce,
        frequency: bd.drivenAppliedFrequency,
        phaseParameter: bd.drivenAppliedPhaseParameter,
        parameters: bd.parameters,
        F: bd.appliedForce?.F,
        thetaDeg: bd.appliedForce?.thetaDeg,
      };
    }
    return null;
  },

  serialize(body) {
    return { attached: true };
  },

  attach(body) {
    body._appliedForceCapable = true;
  },

  detach(body) {
    clearAppliedForce(body);
    setDrivenAppliedForce(body, false);
    body._appliedForceCapable = false;
  },

  inspectorFields: [
    {
      key: 'applied-force-slot',
      type: 'custom',
      slot: 'appliedForce',
      group: 'Applied force',
      visible: (ctx) => ctx.entity.hasComponent('appliedForce'),
    },
  ],
};

export function appliedForceLegacyHtml(body, helpers) {
  return helpers.appliedForceRowsHtml(body);
}
