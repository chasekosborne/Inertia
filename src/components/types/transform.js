import Matter from 'matter-js';
import { displayedMToWorldPx, worldPxToDisplayedM } from '../../world-origin.js';
import { displayMSToMatterVel, matterVelToDisplayMS } from '../../units.js';
import { matterOmegaToDisplay } from '../../physics/angular.js';
import { snapWorldCoord } from '../../grid.js';
import { MATH } from '../../math-text.js';

const { Body } = Matter;

/** @type {import('../registry.js').ComponentDefinition} */
export const transformComponent = {
  id: 'transform',
  systems: ['physics', 'render'],

  fromSceneBody(bd) {
    return {
      position: { x: bd.position?.x ?? 0, y: bd.position?.y ?? 0 },
      angle: bd.angle ?? 0,
      velocity: { vx: bd.velocity?.vx ?? 0, vy: bd.velocity?.vy ?? 0 },
      angularVelocity: bd.angularVelocity ?? 0,
    };
  },

  serialize(body) {
    const { xm, ym } = worldPxToDisplayedM(body.position.x, body.position.y);
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    return {
      position: { x: xm, y: ym },
      angle: body.angle,
      velocity: { vx: vxMs, vy: vyMs },
      angularVelocity: matterOmegaToDisplay(body.angularVelocity || 0),
    };
  },

  inspectorFields: [
    {
      key: 'position-title',
      type: 'section-title',
      label: 'Position',
      group: 'Position',
      visible: (ctx) => ctx.entity.hasComponent('transform'),
    },
    {
      key: 'x',
      type: 'number',
      label: `${MATH.x}`,
      unit: 'm',
      step: 0.1,
      group: 'Position',
      id: 'prop-x',
      liveRefresh: true,
      bindable: true,
      get: (ctx) => {
        if (ctx.extras?.getPosition) return ctx.extras.getPosition(ctx.body).xm;
        return worldPxToDisplayedM(ctx.body.position.x, ctx.body.position.y).xm;
      },
      set: (ctx, val) => {
        if (ctx.extras?.setPosition) {
          ctx.extras.setPosition(ctx.body, Number(val), null);
          return;
        }
        const cur = worldPxToDisplayedM(ctx.body.position.x, ctx.body.position.y);
        const { x: xPx, y: yKeep } = displayedMToWorldPx(Number(val), cur.ym);
        Body.setPosition(ctx.body, {
          x: snapWorldCoord(xPx, ctx.snapOn()),
          y: snapWorldCoord(yKeep, ctx.snapOn()),
        });
        ctx.syncRopes?.(ctx.body);
      },
    },
    {
      key: 'y',
      type: 'number',
      label: `${MATH.y}`,
      unit: 'm',
      step: 0.1,
      group: 'Position',
      id: 'prop-y',
      liveRefresh: true,
      bindable: true,
      get: (ctx) => {
        if (ctx.extras?.getPosition) return ctx.extras.getPosition(ctx.body).ym;
        return worldPxToDisplayedM(ctx.body.position.x, ctx.body.position.y).ym;
      },
      set: (ctx, val) => {
        if (ctx.extras?.setPosition) {
          ctx.extras.setPosition(ctx.body, null, Number(val));
          return;
        }
        const cur = worldPxToDisplayedM(ctx.body.position.x, ctx.body.position.y);
        const { x: xKeep, y: yPx } = displayedMToWorldPx(cur.xm, Number(val));
        Body.setPosition(ctx.body, {
          x: snapWorldCoord(xKeep, ctx.snapOn()),
          y: snapWorldCoord(yPx, ctx.snapOn()),
        });
        ctx.syncRopes?.(ctx.body);
      },
    },
  ],
};
