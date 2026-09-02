import { pxToM, mToPx, DEFAULT_CIRCLE_RADIUS_M, DEFAULT_BALL_RADIUS_M } from '../../units.js';
import { snapBodySizePx } from '../../grid.js';
import { scaleBoxTo, scaleCircleTo, scaleWedgeTo, setWedgeGeometry, applyCircleInertia } from '../../physics/bodies.js';
import { defaultWedgeFootAngle, clampWedgeFootAngle } from '../../physics/bodies.js';

/** @type {import('../registry.js').ComponentDefinition} */
export const shapeComponent = {
  id: 'shape',
  systems: ['physics', 'render'],

  fromSceneBody(bd) {
    const geo = bd.geometry ?? {};
    switch (bd.type) {
      case 'ball':
      case 'point':
        return { kind: 'circle', radius: geo.radius, hollow: geo.hollow === true };
      case 'box':
        return { kind: 'box', width: geo.width, height: geo.height };
      case 'wedge':
        return {
          kind: 'wedge',
          baseWidth: geo.baseWidth ?? geo.width,
          height: geo.height,
          flipX: geo.flipX === true,
          flipY: geo.flipY === true,
          footAngle: geo.footAngle,
        };
      case 'ground':
        return { kind: 'box', width: geo.width, height: geo.height };
      default:
        return null;
    }
  },

  serialize(body) {
    const nt = body._newtonType;
    if (nt === 'box' || nt === 'ground') {
      return {
        kind: 'box',
        width: (body._width ?? 40) / 100,
        height: (body._height ?? 40) / 100,
      };
    }
    if (nt === 'ball' || nt === 'point') {
      return {
        kind: 'circle',
        radius: (body._radius ?? body.circleRadius ?? 10) / 100,
        hollow: body._hollow === true,
      };
    }
    if (nt === 'wedge') {
      return {
        kind: 'wedge',
        baseWidth: (body._baseWidth ?? 40) / 100,
        height: (body._height ?? 40) / 100,
        flipX: body._wedgeFlipX === true,
        flipY: body._wedgeFlipY === true,
      };
    }
    return null;
  },

  inspectorFields: [
  // ── Box ──
    {
      key: 'size-title',
      type: 'section-title',
      label: 'Size',
      group: 'Size',
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'box',
    },
    {
      key: 'width',
      type: 'number',
      label: 'width',
      unit: 'm',
      step: 0.1,
      min: 0.08,
      group: 'Size',
      id: 'prop-box-w',
      liveRefresh: true,
      bindable: true,
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'box',
      get: (ctx) => pxToM(ctx.body._width ?? 40),
      set: (ctx, val) => {
        const nw = snapBodySizePx(mToPx(Number(val)), ctx.snapOn());
        const nh = ctx.body._height ?? 40;
        ctx.scaleBox?.(ctx.body, nw, nh);
      },
    },
    {
      key: 'height',
      type: 'number',
      label: 'height',
      unit: 'm',
      step: 0.1,
      min: 0.08,
      group: 'Size',
      id: 'prop-box-h',
      liveRefresh: true,
      bindable: true,
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'box',
      get: (ctx) => pxToM(ctx.body._height ?? 40),
      set: (ctx, val) => {
        const nh = snapBodySizePx(mToPx(Number(val)), ctx.snapOn());
        const nw = ctx.body._width ?? 40;
        ctx.scaleBox?.(ctx.body, nw, nh);
      },
    },
  // ── Circle ──
    {
      key: 'radius-title',
      type: 'section-title',
      label: 'Size',
      group: 'Size',
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'circle',
    },
    {
      key: 'radius',
      type: 'number',
      label: 'radius',
      unit: 'm',
      step: 0.01,
      min: 0.04,
      group: 'Size',
      id: 'prop-radius',
      liveRefresh: true,
      bindable: true,
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'circle',
      get: (ctx) => pxToM(ctx.body._radius ?? ctx.body.circleRadius ?? mToPx(DEFAULT_CIRCLE_RADIUS_M)),
      set: (ctx, val) => {
        const r = snapBodySizePx(mToPx(Number(val)), ctx.snapOn());
        scaleCircleTo(ctx.body, r);
      },
    },
    {
      key: 'hollow',
      type: 'toggle',
      label: 'Hollow',
      group: 'Size',
      id: 'prop-hollow',
      visible: (ctx) => ctx.entity.hasComponent('shape')
        && ctx.extras?.shapeKind === 'circle'
        && ctx.extras?.showHollow === true,
      get: (ctx) => ctx.body._hollow === true,
      set: (ctx, val) => {
        ctx.body._hollow = !!val;
        applyCircleInertia(ctx.body);
      },
    },
  // ── Wedge ──
    {
      key: 'wedge-size-title',
      type: 'section-title',
      label: 'Size',
      group: 'Size',
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'wedge',
    },
    {
      key: 'wedge-base',
      type: 'number',
      label: 'base',
      unit: 'm',
      step: 0.1,
      min: 0.08,
      group: 'Size',
      id: 'prop-wedge-w',
      liveRefresh: true,
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'wedge',
      get: (ctx) => pxToM(ctx.body._baseWidth ?? 40),
      set: (ctx, val) => {
        const W = snapBodySizePx(mToPx(Number(val)), ctx.snapOn());
        scaleWedgeTo(ctx.body, W, ctx.body._height ?? 40, { pin: 'left' });
        ctx.extras?.snapWedge?.(ctx.body);
      },
    },
    {
      key: 'wedge-height',
      type: 'number',
      label: 'height',
      unit: 'm',
      step: 0.1,
      min: 0.08,
      group: 'Size',
      id: 'prop-wedge-h',
      liveRefresh: true,
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'wedge',
      get: (ctx) => pxToM(ctx.body._height ?? 40),
      set: (ctx, val) => {
        const H = snapBodySizePx(mToPx(Number(val)), ctx.snapOn());
        scaleWedgeTo(ctx.body, ctx.body._baseWidth ?? 40, H, { pin: 'bottom' });
        ctx.extras?.snapWedge?.(ctx.body);
      },
    },
    {
      key: 'wedge-foot',
      type: 'number',
      label: 'foot ∠',
      unit: '°',
      step: 1,
      min: 5,
      max: 85,
      group: 'Size',
      id: 'prop-wedge-foot',
      visible: (ctx) => ctx.entity.hasComponent('shape') && ctx.extras?.shapeKind === 'wedge',
      get: (ctx) => {
        const W = ctx.body._baseWidth ?? 40;
        const H = ctx.body._height ?? 40;
        return ((ctx.body._footAngle ?? defaultWedgeFootAngle(W, H)) * 180 / Math.PI);
      },
      set: (ctx, val) => {
        const W = ctx.body._baseWidth ?? 40;
        const H = ctx.body._height ?? 40;
        const rad = clampWedgeFootAngle(Number(val) * Math.PI / 180);
        setWedgeGeometry(ctx.body, W, H, rad);
        ctx.extras?.snapWedge?.(ctx.body);
      },
    },
  ],
};
