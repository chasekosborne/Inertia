/**
 * Scene object aggregates for the browser / properties.
 *
 * Browser tree is filesystem-like:
 *   - Bodies are files (constraints nested under the bodies they attach to)
 *   - Aggregates are folders of connected bodies + their shared constraints
 *   - Rope constraints are top-level aggregate folders (segment count in Properties)
 *   - Sticky welds are folders of weld parts
 *
 * User aggregates are UI groupings only (must already be constraint-linked
 * or welded). Created by dragging a connected body onto another body/folder.
 */

import { pxToM, matterVelToDisplayMS } from '../units.js';
import { bodySpinAngularMomentumSI } from '../physics/angular.js';
import { ropeDisplayName } from '../physics/rope.js';

/** @typedef {{ id: string, name: string, memberIds: number[] }} UiAggregate */

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @returns {UiAggregate[]}
 */
export function getUiAggregates(engine) {
  if (!engine._uiAggregates) engine._uiAggregates = [];
  return engine._uiAggregates;
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {UiAggregate[]} list
 */
export function setUiAggregates(engine, list) {
  engine._uiAggregates = list ?? [];
}

/** @param {import('../physics/engine.js').PhysicsEngine} engine */
export function clearUiAggregates(engine) {
  engine._uiAggregates = [];
}

/**
 * Drop stale member ids and empty folders after scene edits.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 */
export function pruneUiAggregates(engine) {
  const valid = new Set(listBrowsableBodies(engine).map(b => b.id));
  const next = getUiAggregates(engine)
    .map(a => ({
      ...a,
      memberIds: (a.memberIds ?? []).filter(id => valid.has(id)),
    }))
    .filter(a => a.memberIds.length >= 2);
  setUiAggregates(engine, next);
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @returns {import('matter-js').Body[]}
 */
export function listBrowsableBodies(engine) {
  return (engine.bodies ?? []).filter(b => {
    if (!b || b._newtonType === 'metric-basis') return false;
    if (b._ropeSegment) return false;
    return true;
  });
}

/**
 * Connected components of bodies linked by constraints (rod/spring/string).
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @returns {number[][]}
 */
export function constraintLinkedGroups(engine) {
  const bodies = listBrowsableBodies(engine);
  const idSet = new Set(bodies.map(b => b.id));
  /** @type {Map<number, number>} */
  const parent = new Map();
  for (const id of idSet) parent.set(id, id);

  function find(x) {
    let p = parent.get(x);
    while (p !== parent.get(p)) {
      parent.set(p, parent.get(parent.get(p)));
      p = parent.get(p);
    }
    return p;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const c of engine.constraints ?? []) {
    if (c._ropeLink) continue;
    const a = c.bodyA;
    const b = c.bodyB;
    if (!a || !b) continue;
    if (!idSet.has(a.id) || !idSet.has(b.id)) continue;
    union(a.id, b.id);
  }

  /** @type {Map<number, number[]>} */
  const groups = new Map();
  for (const id of idSet) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }

  return [...groups.values()].filter(g => g.length >= 2);
}

/**
 * True if every id shares one constraint-connected component (or single id).
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {number[]} ids
 */
export function bodiesAreConnected(engine, ids) {
  const uniq = [...new Set(ids.filter(id => Number.isFinite(id)))];
  if (uniq.length <= 1) return true;
  const groups = constraintLinkedGroups(engine);
  return groups.some(g => {
    const set = new Set(g);
    return uniq.every(id => set.has(id));
  });
}

/**
 * Constraints attached to a body (non-rope internal links).
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {number} bodyId
 */
export function constraintsForBody(engine, bodyId) {
  return (engine.constraints ?? []).filter(c => {
    if (!c || c._ropeLink) return false;
    return c.bodyA?.id === bodyId || c.bodyB?.id === bodyId;
  });
}

/**
 * Constraints whose both ends are in memberIds.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {number[]} memberIds
 */
export function constraintsWithin(engine, memberIds) {
  const set = new Set(memberIds);
  return (engine.constraints ?? []).filter(c => {
    if (!c || c._ropeLink) return false;
    const a = c.bodyA?.id;
    const b = c.bodyB?.id;
    return a != null && b != null && set.has(a) && set.has(b);
  });
}

/**
 * Display name for a body (scene label preferred).
 * @param {import('matter-js').Body} body
 */
export function bodyDisplayName(body) {
  if (!body) return 'Object';
  if (typeof body.label === 'string' && body.label
    && !/^(circle|ball|box|wedge|ground|anchor|pivot|compound)_?\d*$/i.test(body.label)) {
    return body.label;
  }
  const t = body._newtonType ?? 'body';
  if (t === 'compound') return 'Group';
  if (t === 'point-mass') return 'Point';
  if (t === 'anchor') {
    // Prefer pivot_N / anchor_N labels; otherwise "Pivot"
    if (typeof body.label === 'string' && body.label) return body.label.replace(/^anchor_/i, 'pivot_');
    return 'Pivot';
  }
  if (typeof body.label === 'string' && body.label) return body.label;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * @param {import('matter-js').Body} body
 * @param {number} partIndex
 */
export function weldPartDisplayName(body, partIndex) {
  const meta = body?._weldParts?.[partIndex];
  if (meta?.label) return meta.label;
  const type = meta?.type ?? 'part';
  const nice = type === 'point-mass' ? 'Point' : (type.charAt(0).toUpperCase() + type.slice(1));
  return `${nice} ${partIndex + 1}`;
}

/**
 * @param {object} c
 */
export function constraintDisplayName(c) {
  if (!c) return 'Constraint';
  if (typeof c.label === 'string' && c.label) return c.label;
  const t = c._newtonType ?? 'link';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Centre-of-mass kinematics for a set of bodies (display SI, +y up).
 * @param {import('matter-js').Body[]} bodies
 */
export function aggregateState(bodies) {
  const list = (bodies ?? []).filter(b => b && !b.isStatic && b._newtonType !== 'metric-basis');
  let M = 0;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  for (const b of list) {
    const m = b.mass;
    if (!(m > 0) || !isFinite(m)) continue;
    M += m;
    sx += m * b.position.x;
    sy += m * b.position.y;
    px += m * b.velocity.x;
    py += m * b.velocity.y;
  }
  if (!(M > 0)) {
    return {
      mass: 0,
      comM: { x: 0, y: 0 },
      vMs: { vx: 0, vy: 0 },
      LaboutCom: 0,
      memberCount: list.length,
    };
  }
  const comX = sx / M;
  const comY = sy / M;
  const { vxMs, vyMs } = matterVelToDisplayMS(px / M, py / M);
  let Lspin = 0;
  for (const b of list) {
    const Ls = bodySpinAngularMomentumSI(b);
    if (Ls != null) Lspin += Ls;
    const rx = pxToM(b.position.x - comX);
    const ry = -pxToM(b.position.y - comY);
    const v = matterVelToDisplayMS(b.velocity.x, b.velocity.y);
    Lspin += b.mass * (rx * v.vyMs - ry * v.vxMs);
  }
  return {
    mass: M,
    comM: { x: pxToM(comX), y: -pxToM(comY) },
    vMs: { vx: vxMs, vy: vyMs },
    LaboutCom: Lspin,
    memberCount: list.length,
  };
}

let _aggSeq = 0;
function _nextAggId() {
  return `agg_${++_aggSeq}_${Date.now().toString(36)}`;
}

/**
 * Merge body ids into a UI aggregate folder. Requires constraint connectivity.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {number[]} memberIds
 * @param {{ name?: string, intoId?: string }} [opts]
 * @returns {UiAggregate|null}
 */
export function formUiAggregate(engine, memberIds, opts = {}) {
  const ids = [...new Set(memberIds.filter(Number.isFinite))];
  if (ids.length < 2) return null;
  if (!bodiesAreConnected(engine, ids)) return null;

  pruneUiAggregates(engine);
  const aggs = getUiAggregates(engine);

  // Pull members out of any existing folders, then merge into target or new.
  for (const a of aggs) {
    a.memberIds = a.memberIds.filter(id => !ids.includes(id));
  }

  let target = opts.intoId ? aggs.find(a => a.id === opts.intoId) : null;
  if (!target) {
    // Prefer extending an aggregate that already contains any of the ids
    // (caller may have filtered them out above: check opts.preferAggId).
    target = null;
  }

  if (target) {
    const merged = [...new Set([...target.memberIds, ...ids])];
    if (!bodiesAreConnected(engine, merged)) return null;
    target.memberIds = merged;
    if (opts.name) target.name = opts.name;
  } else {
    const byId = new Map(listBrowsableBodies(engine).map(b => [b.id, b]));
    const name = opts.name
      || (byId.get(ids[0]) ? `${bodyDisplayName(byId.get(ids[0]))} group` : 'Aggregate');
    target = { id: _nextAggId(), name, memberIds: ids };
    aggs.push(target);
  }

  setUiAggregates(engine, aggs.filter(a => a.memberIds.length >= 2));
  return target;
}

/**
 * Remove a body from its UI aggregate (dissolve folder if < 2 left).
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {number} bodyId
 */
export function removeBodyFromUiAggregate(engine, bodyId) {
  const aggs = getUiAggregates(engine);
  for (const a of aggs) {
    a.memberIds = a.memberIds.filter(id => id !== bodyId);
  }
  setUiAggregates(engine, aggs.filter(a => a.memberIds.length >= 2));
}

/**
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {string} aggId
 * @param {string} name
 */
export function renameUiAggregate(engine, aggId, name) {
  const a = getUiAggregates(engine).find(x => x.id === aggId);
  if (a && name) a.name = name;
}

/**
 * Drag payload → drop target: form / extend aggregate when connected.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @param {{ kind: string, id?: number, aggId?: string, memberIds?: number[] }} drag
 * @param {{ kind: string, id?: number, aggId?: string }} drop
 * @returns {{ ok: boolean, reason?: string, aggregate?: UiAggregate }}
 */
export function tryAggregateDrop(engine, drag, drop) {
  if (!drag || !drop) return { ok: false, reason: 'nothing' };

  /** Collect body ids from a drag source */
  function dragIds() {
    if (drag.kind === 'body' && drag.id != null) return [drag.id];
    if (drag.kind === 'aggregate' && drag.aggId) {
      const a = getUiAggregates(engine).find(x => x.id === drag.aggId);
      return a ? [...a.memberIds] : [];
    }
    if (drag.kind === 'constraint' && drag.id != null) {
      const c = engine.constraints.find(x => x.id === drag.id);
      if (!c) return [];
      const out = [];
      if (c.bodyA) out.push(c.bodyA.id);
      if (c.bodyB) out.push(c.bodyB.id);
      return out;
    }
    return [];
  }

  const moving = dragIds();
  if (!moving.length) return { ok: false, reason: 'empty drag' };

  if (drop.kind === 'body' && drop.id != null) {
    if (moving.length === 1 && moving[0] === drop.id) {
      return { ok: false, reason: 'same body' };
    }
    const existing = getUiAggregates(engine).find(a => a.memberIds.includes(drop.id));
    const memberIds = [...new Set([...moving, drop.id, ...(existing?.memberIds ?? [])])];
    if (!bodiesAreConnected(engine, memberIds)) {
      return { ok: false, reason: 'not connected by a constraint' };
    }
    const agg = formUiAggregate(engine, memberIds, {
      intoId: existing?.id,
      name: existing?.name,
    });
    return agg ? { ok: true, aggregate: agg } : { ok: false, reason: 'could not form' };
  }

  if (drop.kind === 'aggregate' && drop.aggId) {
    const target = getUiAggregates(engine).find(a => a.id === drop.aggId);
    if (!target) return { ok: false, reason: 'missing folder' };
    const memberIds = [...new Set([...target.memberIds, ...moving])];
    if (!bodiesAreConnected(engine, memberIds)) {
      return { ok: false, reason: 'not connected by a constraint' };
    }
    const agg = formUiAggregate(engine, memberIds, { intoId: target.id, name: target.name });
    return agg ? { ok: true, aggregate: agg } : { ok: false, reason: 'could not form' };
  }

  if (drop.kind === 'root') {
    // Ungroup: remove dragged bodies from aggregates
    for (const id of moving) removeBodyFromUiAggregate(engine, id);
    return { ok: true };
  }

  return { ok: false, reason: 'unsupported drop' };
}

/**
 * Filesystem-style tree for the object browser.
 * @param {import('../physics/engine.js').PhysicsEngine} engine
 * @returns {{ roots: object[] }}
 */
export function buildObjectBrowserTree(engine) {
  pruneUiAggregates(engine);
  const bodies = listBrowsableBodies(engine);
  const byId = new Map(bodies.map(b => [b.id, b]));
  const nestedInAgg = new Set();
  for (const a of getUiAggregates(engine)) {
    for (const id of a.memberIds) nestedInAgg.add(id);
  }

  /** @type {object[]} */
  const roots = [];

  // Sticky weld compounds → folders
  for (const b of bodies) {
    if (b._newtonType !== 'compound' || !b._weldParts?.length) continue;
    if (nestedInAgg.has(b.id)) continue;
    const parts = b._weldParts.map((p, i) => ({
      kind: 'weld-part',
      id: b.id,
      partIndex: i,
      name: weldPartDisplayName(b, i),
      type: p.type ?? 'part',
      icon: 'file',
    }));
    const links = constraintsForBody(engine, b.id).map(c => ({
      kind: 'constraint',
      id: c.id,
      name: constraintDisplayName(c),
      type: c._newtonType ?? 'link',
      icon: 'link',
    }));
    roots.push({
      kind: 'weld',
      key: `weld:${b.id}`,
      id: b.id,
      name: bodyDisplayName(b),
      type: 'compound',
      memberIds: [b.id],
      icon: 'folder',
      children: [...parts, ...links],
    });
  }

  // User aggregate folders
  for (const a of getUiAggregates(engine)) {
    const members = a.memberIds.map(id => byId.get(id)).filter(Boolean);
    if (members.length < 2) continue;
    const bodyChildren = members.map(m => {
      if (m._newtonType === 'compound' && m._weldParts?.length) {
        return {
          kind: 'weld',
          key: `weld:${m.id}`,
          id: m.id,
          name: bodyDisplayName(m),
          type: 'compound',
          icon: 'folder',
          children: m._weldParts.map((p, i) => ({
            kind: 'weld-part',
            id: m.id,
            partIndex: i,
            name: weldPartDisplayName(m, i),
            type: p.type ?? 'part',
            icon: 'file',
          })),
        };
      }
      // Constraints that leave the aggregate still nest under the body,
      // internal ones are listed once at folder level.
      const internal = new Set(constraintsWithin(engine, a.memberIds).map(c => c.id));
      const external = constraintsForBody(engine, m.id)
        .filter(c => !internal.has(c.id))
        .map(c => ({
          kind: 'constraint',
          id: c.id,
          name: constraintDisplayName(c),
          type: c._newtonType ?? 'link',
          icon: 'link',
        }));
      return {
        kind: 'body',
        id: m.id,
        name: bodyDisplayName(m),
        type: m._newtonType ?? 'body',
        icon: 'file',
        children: external,
      };
    });
    const internalLinks = constraintsWithin(engine, a.memberIds).map(c => ({
      kind: 'constraint',
      id: c.id,
      name: constraintDisplayName(c),
      type: c._newtonType ?? 'link',
      icon: 'link',
    }));
    roots.push({
      kind: 'aggregate',
      key: `ui:${a.id}`,
      aggId: a.id,
      name: a.name,
      type: 'aggregate',
      memberIds: [...a.memberIds],
      icon: 'folder',
      children: [...bodyChildren, ...internalLinks],
    });
  }

  // Free top-level bodies (with nested constraints)
  for (const b of bodies) {
    if (b._newtonType === 'compound') continue;
    if (nestedInAgg.has(b.id)) continue;
    const links = constraintsForBody(engine, b.id).map(c => ({
      kind: 'constraint',
      id: c.id,
      name: constraintDisplayName(c),
      type: c._newtonType ?? 'link',
      icon: 'link',
    }));
    roots.push({
      kind: 'body',
      id: b.id,
      name: bodyDisplayName(b),
      type: (b._newtonType === 'anchor' ? 'pivot' : (b._newtonType ?? 'body')),
      icon: 'file',
      children: links,
    });
  }

  // Rope aggregates (one folder per chain: nodes stay hidden)
  const ropeIds = new Set();
  for (const b of engine.bodies ?? []) {
    if (b._ropeSegment && b._ropeId) ropeIds.add(b._ropeId);
  }
  for (const ropeId of ropeIds) {
    const nodes = (engine.bodies ?? [])
      .filter(b => b._ropeId === ropeId)
      .sort((a, b) => (a._ropeIndex ?? 0) - (b._ropeIndex ?? 0));
    const n = nodes.length;
    const nSeg = Math.max(0, n - 1);
    const nAtt = (nodes[0]?._ropeHost?.body ? 1 : 0)
      + (nodes[nodes.length - 1]?._ropeHost?.body ? 1 : 0);
    const att = nAtt === 2 ? 'both ends attached' : nAtt === 1 ? 'one end attached' : 'free';
    roots.push({
      kind: 'rope',
      key: `rope:${ropeId}`,
      ropeId,
      id: nodes[0]?.id,
      name: ropeDisplayName(engine, ropeId),
      type: 'aggregate',
      icon: 'folder',
      memberIds: nodes.map(b => b.id),
      children: [
        {
          kind: 'rope-info',
          name: `${nSeg} segment${nSeg === 1 ? '' : 's'} · ${att}`,
          type: 'info',
          icon: 'meta',
        },
      ],
    });
  }

  // Sort: folders first, then files, by name
  const rank = n => (n.icon === 'folder' ? 0 : 1);
  roots.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));

  return { roots };
}
