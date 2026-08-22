import Matter from 'matter-js';
import {
  createPointMass, createBall, createBox, createWedge, createAnchor, createGround,
  createMetricBasis, createString, setMaterialFriction,
} from '../physics/bodies.js';
import { createRod, createSpring } from '../physics/constraints.js';
import { applyRopeMaterialFlags, resolveRopeHosts, ROPE_COLLISION_GROUP } from '../physics/rope.js';
import { setAppliedForce } from '../physics/applied-force.js';
import { setAppliedTorque } from '../physics/applied-torque.js';
import { displayOmegaToMatter } from '../physics/angular.js';
import {
  PX_PER_M, mToPx, displayMSToMatterVel,
  DEFAULT_CIRCLE_RADIUS_M, DEFAULT_BALL_RADIUS_M,
} from '../units.js';

const { Body, World, Engine } = Matter;

/**
 * @param {import('./schema.js').SceneBody} bd
 * @param {number} wx  World px
 * @param {number} wy  World px
 */
function createBodyFromScene(bd, wx, wy) {
  const mat = bd.material ?? {};
  const geo = bd.geometry ?? {};

  switch (bd.type) {
    case 'point-mass':
      return createPointMass(wx, wy, {
        mass: bd.mass ?? 1,
        radius: mToPx(geo.radius ?? DEFAULT_CIRCLE_RADIUS_M),
        hollow: geo.hollow === true,
        restitution: mat.restitution,
        muK: mat.muK,
        muS: mat.muS,
        frictionAir: mat.frictionAir,
        isStatic: bd.isStatic === true,
        ropeSegment: mat.ropeSegment === true,
        slop: mat.ropeSegment === true ? 0.5 : undefined,
        collisionFilter: mat.ropeSegment === true ? { group: ROPE_COLLISION_GROUP } : undefined,
      });

    case 'ball':
      return createBall(wx, wy, {
        mass: bd.mass ?? 1,
        radius: mToPx(geo.radius ?? DEFAULT_BALL_RADIUS_M),
        restitution: mat.restitution,
        muK: mat.muK,
        muS: mat.muS,
        frictionAir: mat.frictionAir,
        isStatic: bd.isStatic === true,
      });

    case 'box':
      return createBox(wx, wy, {
        mass: bd.mass ?? 1,
        width: mToPx(geo.width ?? 0.4),
        height: mToPx(geo.height ?? 0.4),
        restitution: mat.restitution,
        muK: mat.muK,
        muS: mat.muS,
        frictionAir: mat.frictionAir,
        isStatic: bd.isStatic === true,
        angle: bd.angle ?? 0,
        ropeSegment: mat.ropeSegment === true,
        collisionFilter: mat.ropeSegment === true ? { group: ROPE_COLLISION_GROUP } : undefined,
      });

    case 'wedge':
      return createWedge(wx, wy, {
        mass: bd.mass ?? 1,
        baseWidth: mToPx(geo.baseWidth ?? geo.width ?? 0.4),
        height: mToPx(geo.height ?? 0.4),
        footAngle: geo.footAngle,
        restitution: mat.restitution,
        muK: mat.muK,
        muS: mat.muS,
        frictionAir: mat.frictionAir,
        isStatic: bd.isStatic === true,
      });

    case 'anchor':
      return createAnchor(wx, wy);

    case 'ground':
      return createGround(wx, wy, mToPx(geo.width ?? 4), mToPx(geo.height ?? 0.2), {
        angle: bd.angle ?? 0,
        restitution: mat.restitution,
        muK: mat.muK,
        muS: mat.muS,
      });

    default:
      return null;
  }
}

/**
 * @param {import('./schema.js').SceneConstraint} cd
 * @param {import('matter-js').Body|null} bodyA
 * @param {import('matter-js').Body} bodyB
 */
function createConstraintFromScene(cd, bodyA, bodyB) {
  const pointA = {
    x: mToPx(cd.anchorA?.x ?? 0),
    y: mToPx(cd.anchorA?.y ?? 0),
  };
  const pointB = {
    x: mToPx(cd.anchorB?.x ?? 0),
    y: mToPx(cd.anchorB?.y ?? 0),
  };

  if (cd.type === 'spring') {
    return createSpring(bodyA, bodyB, {
      pointA, pointB,
      length: mToPx(cd.restLength ?? 1),
      kNm: cd.k ?? 40,
      maxExtensionM: cd.limits?.maxExtension ?? null,
      maxCompressionM: cd.limits?.maxCompression ?? null,
    });
  }

  if (cd.type === 'rod') {
    return createRod(bodyA, bodyB, {
      pointA, pointB,
      length: mToPx(cd.length ?? cd.restLength ?? 1),
      stiffness: cd.stiffness ?? 1,
      damping: cd.dampingMatter ?? cd.damping ?? (cd.ropeLink ? 0.05 : 0),
    });
  }

  return createString(bodyA, bodyB, {
    pointA, pointB,
    length: mToPx(cd.length ?? 1),
    stiffness: cd.stiffness ?? 0.9,
    damping: cd.dampingMatter ?? 0.01,
  });
}

/**
 * @param {import('./schema.js').SceneDocument} doc
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {object} [opts]
 * @param {boolean} [opts.applyEnvironment=true]
 * @param {boolean} [opts.applyCamera=true]
 * @returns {{ environment?: object|null, camera?: object|null }}
 */
export function deserializeScene(doc, engine, opts = {}) {
  const applyEnvironment = opts.applyEnvironment !== false;
  const applyCamera = opts.applyCamera !== false;

  while (engine.constraints.length) {
    engine.removeConstraint(engine.constraints[0]);
  }
  World.clear(engine.world, false);
  Engine.clear(engine.engine);

  const origin = doc.metricOrigin ?? { x: 0, y: 0 };
  engine.addBody(createMetricBasis(mToPx(origin.x), mToPx(origin.y)));

  const bodyMap = {};

  for (const bd of doc.bodies) {
    if (bd.type === 'metric-basis') continue;

    const wx = origin.x * PX_PER_M + bd.position.x * PX_PER_M;
    const wy = origin.y * PX_PER_M + bd.position.y * PX_PER_M;

    let body = createBodyFromScene(bd, wx, wy);
    if (!body) continue;

    if ((bd.type === 'box' || bd.type === 'wedge') && bd.material) {
      setMaterialFriction(
        body,
        bd.material.muK ?? body._muK ?? body.friction,
        bd.material.muS ?? body._muS ?? body.frictionStatic,
      );
    }

    body.label = bd.id;
    if (bd.material?.stickOnContact === true) {
      body._stickOnContact = true;
      // Sticky merges are perfectly inelastic.
      if (bd.material.restitution == null) body.restitution = 0;
    }
    if (bd.material?.lockRotation === true) {
      Body.setInertia(body, Infinity);
      body._lockRotation = true;
    }
    if (bd.material?.ropeSegment === true) {
      applyRopeMaterialFlags(body, bd.material);
    }
    if (bd.appliedForce && typeof bd.appliedForce === 'object') {
      setAppliedForce(body, bd.appliedForce.F, bd.appliedForce.thetaDeg);
    }
    if (typeof bd.appliedTorque === 'number' && isFinite(bd.appliedTorque) && bd.appliedTorque !== 0) {
      setAppliedTorque(body, bd.appliedTorque);
    }
    const { vx, vy } = displayMSToMatterVel(
      bd.velocity?.vx ?? 0,
      bd.velocity?.vy ?? 0,
    );
    Body.setVelocity(body, { x: vx, y: vy });
    Body.setAngle(body, bd.angle ?? 0);
    if (typeof bd.angularVelocity === 'number' && isFinite(bd.angularVelocity)) {
      Body.setAngularVelocity(body, displayOmegaToMatter(bd.angularVelocity));
    }
    bodyMap[bd.id] = body;
    engine.addBody(body);
  }

  for (const cd of doc.constraints) {
    const bodyA = cd.bodyA ? (bodyMap[cd.bodyA] ?? null) : null;
    const bodyB = bodyMap[cd.bodyB];
    if (!bodyB) continue;

    const c = createConstraintFromScene(cd, bodyA, bodyB);
    if (c) {
      c.label = cd.id;
      if (cd.ropeLink || (bodyA?._ropeSegment && bodyB?._ropeSegment)) {
        c._ropeLink = true;
        c._ropeId = cd.ropeId ?? bodyA?._ropeId ?? bodyB?._ropeId;
      }
      engine.addConstraint(c);
    }
  }

  resolveRopeHosts(engine, bodyMap);

  // Restore UI aggregate folders (scene body ids → Matter ids)
  engine._uiAggregates = [];
  if (Array.isArray(doc.uiAggregates)) {
    for (const a of doc.uiAggregates) {
      if (!a || !Array.isArray(a.members)) continue;
      const memberIds = a.members
        .map(label => bodyMap[label]?.id)
        .filter(id => Number.isFinite(id));
      if (memberIds.length < 2) continue;
      engine._uiAggregates.push({
        id: typeof a.id === 'string' ? a.id : `agg_${memberIds.join('_')}`,
        name: typeof a.name === 'string' && a.name ? a.name : 'Aggregate',
        memberIds,
      });
    }
  }

  return {
    environment: applyEnvironment ? (doc.environment ?? null) : undefined,
    camera: applyCamera ? (doc.camera ?? null) : undefined,
  };
}
