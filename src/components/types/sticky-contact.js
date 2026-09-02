/** @type {import('../registry.js').ComponentDefinition} */
export const stickyContactComponent = {
  id: 'stickyContact',
  optional: true,
  label: 'Sticky contact',
  description: 'Bodies weld together on contact (perfectly inelastic merge).',
  systems: ['physics'],

  fromSceneBody(bd) {
    if (bd.material?.stickOnContact === true) return { enabled: true };
    return null;
  },

  serialize(body) {
    if (!body._stickOnContact) return null;
    return { enabled: true };
  },

  attach(body) {
    body._stickOnContact = true;
    body.restitution = 0;
  },

  detach(body) {
    body._stickOnContact = false;
  },

  inspectorFields: [
    {
      key: 'sticky-title',
      type: 'section-title',
      label: 'Sticky contact',
      group: 'Sticky contact',
      propertyId: 'stickyContact',
      visible: (ctx) => ctx.entity.hasComponent('stickyContact'),
    },
    {
      key: 'sticky',
      type: 'toggle',
      label: 'Sticky',
      group: 'Sticky contact',
      id: 'prop-sticky',
      visible: (ctx) => ctx.entity.hasComponent('stickyContact'),
      get: (ctx) => !!ctx.body._stickOnContact,
      set: (ctx, val) => {
        ctx.body._stickOnContact = !!val;
        if (val) ctx.body.restitution = 0;
      },
    },
  ],
};
