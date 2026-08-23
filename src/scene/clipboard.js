/**
 * Copy / paste selected scene objects as a scene fragment (bodies + constraints).
 */

import { serializeScene, cloneSceneDocument } from './serialize.js';
import { appendSceneFragment } from './deserialize.js';
import { listRopeSegments, nextRopeId } from '../physics/rope.js';

/** Default paste nudge in displayed metres (2 grid cells). */
export const PASTE_OFFSET_M = 0.2;

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {object|null} selection
 * @returns {{ bodies: object[], constraints: object[], uiAggregates?: object[] }|null}
 */
export function captureSelectionClipboard(engine, selection) {
  if (!selection || !engine) return null;

  const full = serializeScene(engine, { includeCamera: false, includeEnvironment: false });
  const byLabel = new Map(full.bodies.map(b => [b.id, b]));
  const wanted = new Set();
  /** @type {string|null} */
  let onlyConstraintLabel = null;
  /** @type {string|null} */
  let onlyAggregateId = null;

  const addBodyLabel = (label) => {
    if (typeof label === 'string' && label && byLabel.has(label)) wanted.add(label);
  };

  const addRope = (ropeId) => {
    if (!ropeId) return;
    for (const n of listRopeSegments(engine, ropeId)) {
      addBodyLabel(n.label);
    }
  };

  if (selection.type === 'body') {
    const body = engine.bodies.find(b => b.id === selection.id);
    if (!body || body._newtonType === 'metric-basis') return null;
    if (body._ropeSegment && body._ropeId) {
      addRope(body._ropeId);
    } else {
      addBodyLabel(body.label);
    }
  } else if (selection.type === 'rope') {
    addRope(selection.ropeId);
  } else if (selection.type === 'aggregate') {
    onlyAggregateId = selection.aggId ?? selection.id ?? null;
    for (const id of selection.memberIds ?? []) {
      const body = engine.bodies.find(b => b.id === id);
      if (!body || body._newtonType === 'metric-basis') continue;
      if (body._ropeSegment && body._ropeId) addRope(body._ropeId);
      else addBodyLabel(body.label);
    }
  } else if (selection.type === 'constraint') {
    const c = engine.constraints.find(x => x.id === selection.id);
    if (!c) return null;
    onlyConstraintLabel = c.label ?? null;
    addBodyLabel(c.bodyA?.label);
    addBodyLabel(c.bodyB?.label);
    if (wanted.size === 0) return null;
  } else {
    return null;
  }

  if (wanted.size === 0) return null;

  const bodies = full.bodies.filter(b => wanted.has(b.id));
  const constraints = full.constraints.filter(c => {
    if (onlyConstraintLabel != null) {
      return c.id === onlyConstraintLabel;
    }
    const aOk = c.bodyA == null || wanted.has(c.bodyA);
    const bOk = c.bodyB != null && wanted.has(c.bodyB);
    return aOk && bOk;
  });

  /** @type {object[]} */
  let uiAggregates = [];
  if (Array.isArray(full.uiAggregates)) {
    if (onlyAggregateId != null) {
      const hit = full.uiAggregates.find(a => a.id === onlyAggregateId);
      if (hit) uiAggregates = [hit];
    } else {
      uiAggregates = full.uiAggregates.filter(a =>
        Array.isArray(a.members) && a.members.length >= 2
        && a.members.every(m => wanted.has(m)));
    }
  }

  return cloneSceneDocument({ bodies, constraints, uiAggregates });
}

/**
 * @param {Set<string>} used
 * @param {string} base
 */
function uniqueId(used, base) {
  const stem = String(base || 'obj').replace(/_\d+$/, '') || 'obj';
  let n = 1;
  let id = `${stem}_${n}`;
  while (used.has(id)) {
    n += 1;
    id = `${stem}_${n}`;
  }
  used.add(id);
  return id;
}

/**
 * Remap fragment ids so they do not collide with the live scene.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {{ bodies: object[], constraints: object[], uiAggregates?: object[] }} fragment
 */
function remapFragmentIds(engine, fragment) {
  const usedBodies = new Set(
    engine.bodies.map(b => b.label).filter(l => typeof l === 'string' && l),
  );
  const usedCons = new Set(
    engine.constraints.map(c => c.label).filter(l => typeof l === 'string' && l),
  );
  const usedAggs = new Set(
    (engine._uiAggregates ?? []).map(a => a.id).filter(id => typeof id === 'string' && id),
  );
  const usedRopes = new Set();
  for (const b of engine.bodies) {
    if (b._ropeId) usedRopes.add(b._ropeId);
  }

  const bodyMap = new Map();
  const ropeMap = new Map();

  const doc = cloneSceneDocument(fragment);

  for (const bd of doc.bodies) {
    const oldId = bd.id;
    const newId = uniqueId(usedBodies, oldId);
    bodyMap.set(oldId, newId);
    bd.id = newId;

    const mat = bd.material;
    if (mat?.ropeSegment && mat.ropeId) {
      if (!ropeMap.has(mat.ropeId)) {
        let rid = nextRopeId('rope');
        while (usedRopes.has(rid) || [...ropeMap.values()].includes(rid)) {
          rid = nextRopeId('rope');
        }
        usedRopes.add(rid);
        ropeMap.set(mat.ropeId, rid);
      }
      mat.ropeId = ropeMap.get(mat.ropeId);
    }
  }

  // Remap rope hosts after all body ids are known; drop hosts outside the fragment.
  for (const bd of doc.bodies) {
    const host = bd.material?.ropeHost;
    if (!host || typeof host.body !== 'string') continue;
    if (bodyMap.has(host.body)) {
      host.body = bodyMap.get(host.body);
    } else {
      delete bd.material.ropeHost;
    }
  }

  for (const cd of doc.constraints) {
    cd.id = uniqueId(usedCons, cd.id || 'constraint');
    if (cd.bodyA != null) cd.bodyA = bodyMap.get(cd.bodyA) ?? null;
    if (cd.bodyB != null) cd.bodyB = bodyMap.get(cd.bodyB) ?? null;
    if (cd.ropeId && ropeMap.has(cd.ropeId)) {
      cd.ropeId = ropeMap.get(cd.ropeId);
    }
  }

  if (Array.isArray(doc.uiAggregates)) {
    doc.uiAggregates = doc.uiAggregates.map(a => ({
      ...a,
      id: uniqueId(usedAggs, a.id || 'agg'),
      members: (a.members ?? []).map(m => bodyMap.get(m)).filter(Boolean),
    })).filter(a => a.members.length >= 2);
  }

  return doc;
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {{ bodies: object[], constraints: object[], uiAggregates?: object[] }} clipboard
 * @param {{ dxM?: number, dyM?: number }} [opts]
 * @returns {{ bodyMap: Record<string, import('matter-js').Body>, fragment: object }|null}
 */
export function pasteClipboard(engine, clipboard, opts = {}) {
  if (!clipboard?.bodies?.length) return null;
  const dxM = opts.dxM ?? PASTE_OFFSET_M;
  const dyM = opts.dyM ?? PASTE_OFFSET_M;

  const remapped = remapFragmentIds(engine, clipboard);
  for (const bd of remapped.bodies) {
    if (!bd.position) bd.position = { x: 0, y: 0 };
    bd.position.x = (bd.position.x ?? 0) + dxM;
    bd.position.y = (bd.position.y ?? 0) + dyM;
  }

  const bodyMap = appendSceneFragment(engine, remapped);
  return { bodyMap, fragment: remapped };
}
