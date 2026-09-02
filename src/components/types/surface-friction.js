import { setMaterialFriction } from '../../physics/bodies.js';
import { MATH } from '../../math-text.js';

export const DEFAULT_MU_K = 0.3;
export const DEFAULT_MU_S = 0.4;

/** @type {import('../registry.js').ComponentDefinition} */
export const surfaceFrictionComponent = {
  id: 'surfaceFriction',
  optional: true,
  label: 'Surface friction',
  description: 'Coulomb friction between this surface and others that also have friction enabled.',
  systems: ['physics'],

  fromSceneBody(bd) {
    const mat = bd.material ?? {};
    const muK = mat.muK ?? 0;
    const muS = mat.muS ?? 0;
    if (muK <= 0 && muS <= 0) return null;
    return { muK, muS };
  },

  serialize(body) {
    const muK = body._muK ?? body.friction ?? 0;
    const muS = body._muS ?? body.frictionStatic ?? 0;
    if (muK <= 0 && muS <= 0) return null;
    return { muK, muS };
  },

  attach(body, data) {
    const muK = data?.muK ?? DEFAULT_MU_K;
    const muS = data?.muS ?? DEFAULT_MU_S;
    setMaterialFriction(body, muK, muS);
  },

  detach(body) {
    setMaterialFriction(body, 0, 0);
  },

  inspectorFields: [
    {
      key: 'friction-title',
      type: 'section-title',
      label: 'Friction (surface)',
      group: 'Surface friction',
      propertyId: 'surfaceFriction',
      visible: (ctx) => ctx.entity.hasComponent('surfaceFriction'),
    },
    {
      key: 'friction-hint',
      type: 'hint',
      label: 'Friction applies only when both contacting surfaces have friction enabled.',
      group: 'Surface friction',
      visible: (ctx) => ctx.entity.hasComponent('surfaceFriction'),
    },
    {
      key: 'muS',
      type: 'number',
      label: `${MATH.mus}`,
      step: 0.01,
      min: 0,
      max: 5,
      group: 'Surface friction',
      id: 'prop-mus',
      visible: (ctx) => ctx.entity.hasComponent('surfaceFriction'),
      get: (ctx) => ctx.body._muS ?? ctx.body.frictionStatic ?? 0,
      set: (ctx, val) => {
        const muK = ctx.body._muK ?? ctx.body.friction ?? 0;
        setMaterialFriction(ctx.body, muK, Number(val));
      },
    },
    {
      key: 'muK',
      type: 'number',
      label: `${MATH.muk}`,
      step: 0.01,
      min: 0,
      max: 5,
      group: 'Surface friction',
      id: 'prop-muk',
      visible: (ctx) => ctx.entity.hasComponent('surfaceFriction'),
      get: (ctx) => ctx.body._muK ?? ctx.body.friction ?? 0,
      set: (ctx, val) => {
        const muS = ctx.body._muS ?? ctx.body.frictionStatic ?? 0;
        setMaterialFriction(ctx.body, Number(val), muS);
      },
    },
  ],
};
