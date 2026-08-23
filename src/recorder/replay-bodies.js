/**
 * Rebuild Matter bodies from recorder snapshots so review scrubbing can
 * restore pre-weld / post-weld topology (IDs change when sticky welds).
 */

import Matter from 'matter-js';
import {
  createBox,
  createPointMass,
  createBall,
  createWedge,
  createAnchor,
  createGround,
  createMetricBasis,
  setBodyAnchored,
  setMaterialFriction,
} from '../physics/bodies.js';
import { materializeWeldPart } from '../physics/sticky.js';

const { Body } = Matter;

/**
 * @param {object} snap  Recorder body snapshot
 * @returns {import('matter-js').Body|null}
 */
export function createBodyFromSnap(snap) {
  if (!snap || snap.type == null) return null;

  const mat = {
    mass: snap.mass,
    restitution: snap.restitution,
    muK: snap.muK,
    muS: snap.muS,
    frictionAir: snap.frictionAir,
  };

  let body = null;
  switch (snap.type) {
    case 'metric-basis':
      body = createMetricBasis(snap.x, snap.y);
      break;
    case 'anchor':
      body = createAnchor(snap.x, snap.y);
      break;
    case 'ground':
      body = createGround(snap.x, snap.y, snap.bWidth ?? 400, snap.bHeight ?? 20, mat);
      break;
    case 'box':
      body = createBox(snap.x, snap.y, {
        ...mat,
        width: snap.bWidth ?? 40,
        height: snap.bHeight ?? 40,
      });
      break;
    case 'point-mass':
      body = createPointMass(snap.x, snap.y, {
        ...mat,
        radius: snap.radius ?? 10,
      });
      if (snap.hollow) body._hollow = true;
      break;
    case 'ball':
      body = createBall(snap.x, snap.y, {
        ...mat,
        radius: snap.radius ?? 10,
      });
      break;
    case 'wedge':
      body = createWedge(snap.x, snap.y, {
        ...mat,
        baseWidth: snap.baseWidth ?? snap.bWidth,
        height: snap.bHeight,
        footAngle: snap.footAngle,
        flipX: snap.flipX === true,
        flipY: snap.flipY === true,
      });
      break;
    case 'compound':
      body = _createCompoundFromSnap(snap);
      break;
    default:
      return null;
  }

  if (!body) return null;

  // Preserve the recorded Matter id so later frames can find this body again.
  body.id = snap.id;
  if (snap.label != null) body.label = snap.label;
  if (snap.stickOnContact) body._stickOnContact = true;
  if (snap.lockRotation) {
    body._lockRotation = true;
    Body.setInertia(body, Infinity);
  }
  if (snap.isStatic && !body.isStatic) setBodyAnchored(body, true);
  if (snap.muK != null || snap.muS != null) {
    setMaterialFriction(body, snap.muK ?? body._muK ?? 0, snap.muS ?? body._muS ?? 0);
  }

  Body.setPosition(body, { x: snap.x, y: snap.y });
  Body.setAngle(body, snap.angle ?? 0);
  Body.setVelocity(body, { x: snap.vx ?? 0, y: snap.vy ?? 0 });
  Body.setAngularVelocity(body, Number.isFinite(snap.w) ? snap.w : 0);
  return body;
}

function _createCompoundFromSnap(snap) {
  const parts = snap.weldParts;
  if (!Array.isArray(parts) || parts.length < 2) return null;

  const cos = Math.cos(snap.angle ?? 0);
  const sin = Math.sin(snap.angle ?? 0);
  const freeParts = parts.map(spec => {
    const lx = spec.lx ?? 0;
    const ly = spec.ly ?? 0;
    const la = spec.la ?? 0;
    return materializeWeldPart({
      type: spec.type ?? 'box',
      width: spec.width,
      height: spec.height,
      radius: spec.radius,
      hollow: spec.hollow === true,
      mass: spec.mass ?? 1,
      x: snap.x + cos * lx - sin * ly,
      y: snap.y + sin * lx + cos * ly,
      angle: (snap.angle ?? 0) + la,
      vertices: null,
    });
  });

  const muK = snap.muK ?? 0;
  const muS = snap.muS ?? 0;
  const compound = Body.create({
    parts: freeParts,
    restitution: snap.restitution ?? 0,
    friction: muK,
    frictionStatic: muS,
    frictionAir: snap.frictionAir ?? 0,
  });
  compound._newtonType = 'compound';
  compound._muK = muK;
  compound._muS = muS;
  compound._stickOnContact = parts.some(p => p.stickOnContact);
  compound._weldParts = parts.map(spec => ({
    type: spec.type,
    width: spec.width,
    height: spec.height,
    radius: spec.radius,
    hollow: spec.hollow,
    stickOnContact: !!spec.stickOnContact,
    label: spec.label ?? null,
    sourceId: spec.sourceId ?? null,
  }));
  if (snap.lockRotation) {
    compound._lockRotation = true;
    Body.setInertia(compound, Infinity);
  }
  return compound;
}
