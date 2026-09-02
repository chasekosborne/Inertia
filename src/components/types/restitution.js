export const DEFAULT_RESTITUTION = 0.5;

/** @type {import('../registry.js').ComponentDefinition} */
export const restitutionComponent = {
  id: 'restitution',
  optional: true,
  label: 'Restitution',
  description: 'Bounce coefficient on collision (0 = inelastic, 1 = perfectly elastic).',
  systems: ['physics'],

  fromSceneBody(bd) {
    if (bd.type === 'anchor' || bd.type === 'metric-basis') return null;
    const mat = bd.material ?? {};
    if (mat.restitution == null) return null;
    return { restitution: mat.restitution };
  },

  serialize(body) {
    if (body._newtonType === 'anchor') return null;
    return { restitution: body.restitution };
  },

  attach(body, data) {
    body.restitution = data?.restitution ?? DEFAULT_RESTITUTION;
    if (body._original) body._original.restitution = body.restitution;
  },

  detach(body) {
    body.restitution = 0;
    if (body._original) body._original.restitution = 0;
  },

  inspectorFields: [
    {
      key: 'restitution-title',
      type: 'section-title',
      label: 'Restitution',
      group: 'Restitution',
      propertyId: 'restitution',
      visible: (ctx) => ctx.entity.hasComponent('restitution'),
    },
    {
      key: 'restitution',
      type: 'number',
      label: 'restitution',
      step: 0.05,
      min: 0,
      max: 1,
      group: 'Restitution',
      id: 'prop-rest',
      visible: (ctx) => ctx.entity.hasComponent('restitution'),
      get: (ctx) => ctx.body.restitution,
      set: (ctx, val) => { ctx.body.restitution = Number(val); },
    },
  ],
};
