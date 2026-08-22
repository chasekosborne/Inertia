import {
  PX_PER_M,
  matterVelToDisplayMS,
} from '../units.js';
import { getOriginDisplayedM, worldPxToDisplayedM } from '../world-origin.js';
import { SCENE_FORMAT, SCENE_VERSION } from './schema.js';
import { wedgeAABBCenterWorld, bodyDisplayMass } from '../physics/bodies.js';
import { getAppliedForce } from '../physics/applied-force.js';
import { getAppliedTorque } from '../physics/applied-torque.js';
import { matterOmegaToDisplay } from '../physics/angular.js';

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {object} [opts]
 * @param {object} [opts.meta]
 * @param {object|null} [opts.environment]
 * @param {{ tx: number, ty: number, s: number }|null} [opts.camera]
 * @param {object[]} [opts.measurements]  Length / angle overlays (scene form)
 * @param {boolean} [opts.includeEnvironment=true]
 * @param {boolean} [opts.includeCamera=true]
 * @returns {import('./schema.js').SceneDocument}
 */
export function serializeScene(engine, opts = {}) {
  const includeEnvironment = opts.includeEnvironment !== false;
  const includeCamera = opts.includeCamera !== false;

  const bodies = engine.bodies
    .filter(b => b._newtonType !== 'metric-basis')
    .map(b => {
      const origin = b._newtonType === 'wedge' ? wedgeAABBCenterWorld(b) : b.position;
      const { xm, ym } = worldPxToDisplayedM(origin.x, origin.y);
      const { vxMs, vyMs } = matterVelToDisplayMS(b.velocity.x, b.velocity.y);
      /** @type {import('./schema.js').SceneBody} */
      const entry = {
        id: b.label,
        type: b._newtonType,
        position: { x: xm, y: ym },
        angle: b.angle,
        velocity: { vx: vxMs, vy: vyMs },
      };

      if (b._newtonType === 'point-mass' || b._newtonType === 'ball' || b._newtonType === 'anchor') {
        entry.mass = bodyDisplayMass(b);
        entry.geometry = { radius: (b._radius ?? b.circleRadius ?? 10) / PX_PER_M };
        if (b._newtonType === 'point-mass') {
          entry.geometry.hollow = b._hollow === true;
        }
      } else if (b._newtonType === 'box') {
        entry.mass = bodyDisplayMass(b);
        entry.geometry = {
          width: (b._width ?? 40) / PX_PER_M,
          height: (b._height ?? 40) / PX_PER_M,
        };
      } else if (b._newtonType === 'wedge') {
        entry.mass = bodyDisplayMass(b);
        entry.geometry = {
          baseWidth: (b._baseWidth ?? 40) / PX_PER_M,
          height: (b._height ?? 40) / PX_PER_M,
        };
      } else if (b._newtonType === 'ground') {
        entry.geometry = {
          width: (b._width ?? 400) / PX_PER_M,
          height: (b._height ?? 20) / PX_PER_M,
        };
      }

      if (b._newtonType !== 'anchor') {
        entry.material = {
          restitution: b.restitution,
          muK: b._muK ?? b.friction,
          muS: b._muS ?? b.frictionStatic ?? b.friction,
          frictionAir: b.frictionAir,
        };
        if (b._stickOnContact) entry.material.stickOnContact = true;
        if (b._lockRotation) entry.material.lockRotation = true;
        if (b._ropeSegment) {
          entry.material.ropeSegment = true;
          if (b._ropeId) entry.material.ropeId = b._ropeId;
          if (Number.isFinite(b._ropeIndex)) entry.material.ropeIndex = b._ropeIndex;
          if (Number.isFinite(b._ropeCount)) entry.material.ropeCount = b._ropeCount;
          if (typeof b._ropeName === 'string' && b._ropeName) entry.material.ropeName = b._ropeName;
          if (b._ropeRestLength > 0) entry.material.ropeRestLength = b._ropeRestLength / PX_PER_M;
          if (b._ropeHost?.body) {
            entry.material.ropeHost = {
              body: b._ropeHost.body.label ?? String(b._ropeHost.body.id),
              x: (b._ropeHost.local?.x ?? 0) / PX_PER_M,
              y: (b._ropeHost.local?.y ?? 0) / PX_PER_M,
            };
          }
        }
      }

      if (
        (b._newtonType === 'point-mass' || b._newtonType === 'ball'
          || b._newtonType === 'box' || b._newtonType === 'wedge')
        && b.isStatic
      ) {
        entry.isStatic = true;
      }

      const af = getAppliedForce(b);
      if (af) {
        entry.appliedForce = { F: af.F, thetaDeg: af.thetaDeg };
      }

      const omega = matterOmegaToDisplay(b.angularVelocity || 0);
      if (Math.abs(omega) > 1e-9) {
        entry.angularVelocity = omega;
      }
      const tau = getAppliedTorque(b);
      if (tau != null) {
        entry.appliedTorque = tau;
      }

      return entry;
    });

  const constraints = engine.constraints.map(c => {
    const base = {
      id: c.label,
      type: c._newtonType,
      bodyA: c.bodyA?.label ?? null,
      bodyB: c.bodyB?.label ?? null,
      anchorA: { x: c.pointA.x / PX_PER_M, y: c.pointA.y / PX_PER_M },
      anchorB: { x: c.pointB.x / PX_PER_M, y: c.pointB.y / PX_PER_M },
    };

    if (c._newtonType === 'spring') {
      return {
        ...base,
        restLength: c.length / PX_PER_M,
        k: c._kNm ?? 40,
        limits: {
          maxExtension: c._maxExtensionM ?? null,
          maxCompression: c._maxCompressionM ?? null,
        },
      };
    }

    return {
      ...base,
      length: c.length / PX_PER_M,
      stiffness: c.stiffness ?? undefined,
      dampingMatter: c.damping ?? undefined,
      ...(c._ropeLink ? { ropeLink: true, ropeId: c._ropeId } : {}),
    };
  });

  const origin = getOriginDisplayedM();

  // UI aggregate folders (body labels, not Matter ids)
  const labelById = new Map(engine.bodies.map(b => [b.id, b.label]));
  const uiAggregates = (engine._uiAggregates ?? [])
    .map(a => ({
      id: a.id,
      name: a.name,
      members: (a.memberIds ?? [])
        .map(id => labelById.get(id))
        .filter(l => typeof l === 'string' && l.length),
    }))
    .filter(a => a.members.length >= 2);

  /** @type {import('./schema.js').SceneDocument} */
  const doc = {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    meta: { ...(opts.meta ?? {}), name: opts.meta?.name ?? 'Untitled scene' },
    metricOrigin: { x: origin.xm, y: origin.ym },
    bodies,
    constraints,
  };

  if (uiAggregates.length) doc.uiAggregates = uiAggregates;

  if (opts.measurements !== undefined) {
    doc.measurements = Array.isArray(opts.measurements) ? opts.measurements : [];
  }

  if (opts.labels !== undefined) {
    doc.labels = Array.isArray(opts.labels) ? opts.labels : [];
  }

  if (includeEnvironment) doc.environment = opts.environment ?? null;
  if (includeCamera) doc.camera = opts.camera ?? null;

  return doc;
}

/** Deep clone for reset baseline storage. */
export function cloneSceneDocument(doc) {
  return JSON.parse(JSON.stringify(doc));
}
