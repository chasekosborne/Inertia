/**
 * Rope end handles.
 *
 * Free ropes: dragging an end translates the whole chain (shape preserved).
 * If the other end is pinned, the tip stays within rest length and the chain
 * is reprojected so links cannot stretch. Drop on a body to pin, or on another
 * rope end to join.
 */

import Matter from 'matter-js';
import {
  ropeEndNode, getRopeEndAttachment, setRopeEndAttachment, snapRopePins,
  listRopeSegments, findRopeEndTarget, mergeRopesAtEnds, ropeSelection,
  ropeOtherEndPinned, clampRopeTipToRest, enforceRopeLength, ropeRestLengthPx,
  ropeOtherEndPivot,
} from '../../../physics/rope.js';
import { findConstraintAttachTarget } from '../../../physics/layout-anchors.js';
import { snapWorldCoord } from '../../../grid.js';
import { handleDot, ghostDot, DOT_RADIUS, DOT_STROKE_WIDTH, HANDLE_BLUE } from '../chrome.js';

const { Body } = Matter;

/** Search radius for an attach / join target under the cursor (world px). */
const ATTACH_HIT_PX = 32;

/** Rigid-translate every node from drag-start origins by (dx, dy). */
function _translateAllNodes(drag, dx, dy) {
  for (const o of drag.origins ?? []) {
    Body.setPosition(o.body, { x: o.ox + dx, y: o.oy + dy });
    Body.setVelocity(o.body, { x: 0, y: 0 });
    o.body.force.x = 0;
    o.body.force.y = 0;
  }
}

/**
 * Place the dragged tip at (wx, wy), clamped to rest length when the other end
 * is pinned, then project link lengths.
 */
function _placeConstrainedTip(engine, drag, wx, wy) {
  const { ropeId, end } = drag;
  setRopeEndAttachment(engine, ropeId, end, null);
  let x = wx;
  let y = wy;
  if (ropeOtherEndPinned(engine, ropeId, end)) {
    const clamped = clampRopeTipToRest(engine, ropeId, end, wx, wy);
    x = clamped.x;
    y = clamped.y;
    const tip = ropeEndNode(engine, ropeId, end);
    if (tip) {
      Body.setPosition(tip, { x, y });
      Body.setVelocity(tip, { x: 0, y: 0 });
    }
    enforceRopeLength(engine, ropeId);
  } else {
    _translateAllNodes(drag, x - drag.endOrigin.x, y - drag.endOrigin.y);
  }
  return { x, y };
}

/** True when a body attach would put both ends beyond rest length. */
function _attachWithinRest(engine, ropeId, end, world) {
  if (!ropeOtherEndPinned(engine, ropeId, end)) return true;
  const pivot = ropeOtherEndPivot(engine, ropeId, end);
  const rest = ropeRestLengthPx(engine, ropeId);
  if (!pivot || !(rest > 0)) return true;
  return Math.hypot(world.x - pivot.x, world.y - pivot.y) <= rest + 0.5;
}

export const ropeHandles = {
  prefix: 'rope',
  kinds: ['rope-end'],

  keyFor(selection) {
    return selection?.type === 'rope' && selection.ropeId ? String(selection.ropeId) : null;
  },

  build(group, ropeId, session) {
    for (const end of ['A', 'B']) {
      group.appendChild(handleDot({
        r: DOT_RADIUS.link,
        strokeWidth: DOT_STROKE_WIDTH.link,
        cursor: 'crosshair',
        color: HANDLE_BLUE,
        data: { 'sel-handle': '1', end, 'rope-id': ropeId },
        onPointerDown: event => this._onDown(event, session),
      }));
    }
  },

  updatePositions(group, ropeId, session) {
    const { engine } = session.context;
    const [dotA, dotB] = group.querySelectorAll('circle');
    const nodeA = ropeEndNode(engine, ropeId, 'A');
    const nodeB = ropeEndNode(engine, ropeId, 'B');
    if (dotA && nodeA) {
      dotA.setAttribute('cx', String(nodeA.position.x));
      dotA.setAttribute('cy', String(nodeA.position.y));
    }
    if (dotB && nodeB) {
      dotB.setAttribute('cx', String(nodeB.position.x));
      dotB.setAttribute('cy', String(nodeB.position.y));
    }
  },

  // ─── Drag start ──────────────────────────────────────────────────

  _onDown(event, session) {
    const { context } = session;
    if (!context.canEdit()) return;
    event.stopPropagation();
    event.preventDefault();
    const ropeId = event.currentTarget.getAttribute('data-rope-id');
    const end = event.currentTarget.getAttribute('data-end');
    if (!ropeId || (end !== 'A' && end !== 'B')) return;
    const node = ropeEndNode(context.engine, ropeId, end);
    if (!node) return;
    const host = getRopeEndAttachment(context.engine, ropeId, end);
    context.pushHistory();
    const nodes = listRopeSegments(context.engine, ropeId);
    session.beginDrag({
      kind: 'rope-end',
      ropeId,
      end,
      original: host
        ? { body: host.body, local: { ...(host.local ?? { x: 0, y: 0 }) } }
        : null,
      hoverTarget: host
        ? { body: host.body, local: host.local, world: null }
        : null,
      hoverRope: null,
      endOrigin: { x: node.position.x, y: node.position.y },
      origins: nodes.map(b => ({
        body: b,
        ox: b.position.x,
        oy: b.position.y,
      })),
    });
  },

  // ─── Drag move ───────────────────────────────────────────────────

  onMove(drag, world, event, session) {
    const { context } = session;
    const { engine } = context;
    const snap = context.getSnapEnabled();
    const ropeId = drag.ropeId;
    const other = getRopeEndAttachment(engine, ropeId, drag.end === 'A' ? 'B' : 'A');
    const bodyTarget = findConstraintAttachTarget(engine, world.x, world.y, {
      excludeBodyId: other?.body?.id ?? null,
      hitPx: ATTACH_HIT_PX,
      snapGrid: snap,
    });
    const ropeTarget = findRopeEndTarget(engine, world.x, world.y, {
      excludeRopeId: ropeId,
      hitPx: ATTACH_HIT_PX,
    });

    let useBody = false;
    if (bodyTarget && ropeTarget) {
      const dBody = Math.hypot(world.x - bodyTarget.world.x, world.y - bodyTarget.world.y);
      const dRope = Math.hypot(world.x - ropeTarget.world.x, world.y - ropeTarget.world.y);
      useBody = dBody <= dRope;
    } else if (bodyTarget) {
      useBody = true;
    }

    // Refuse a body pin that would stretch past rest length.
    if (useBody && bodyTarget && !_attachWithinRest(engine, ropeId, drag.end, bodyTarget.world)) {
      useBody = false;
    }

    const attached = useBody
      ? setRopeEndAttachment(engine, ropeId, drag.end, bodyTarget.body, bodyTarget.local)
      : false;

    let tip = { x: world.x, y: world.y };
    if (attached) {
      drag.hoverTarget = bodyTarget;
      drag.hoverRope = null;
      enforceRopeLength(engine, ropeId);
      tip = bodyTarget.world;
    } else if (ropeTarget && _attachWithinRest(engine, ropeId, drag.end, ropeTarget.world)) {
      drag.hoverTarget = null;
      drag.hoverRope = ropeTarget;
      tip = _placeConstrainedTip(engine, drag, ropeTarget.world.x, ropeTarget.world.y);
    } else {
      drag.hoverTarget = null;
      drag.hoverRope = null;
      const x = snapWorldCoord(world.x, snap);
      const y = snapWorldCoord(world.y, snap);
      tip = _placeConstrainedTip(engine, drag, x, y);
    }

    snapRopePins(engine);
    session.updatePositions();
    const highlightId = attached
      ? bodyTarget.body.id
      : (drag.hoverRope ? drag.hoverRope.node.id : null);
    session.setHoverHighlight(highlightId);

    let ghost = session.getGhost();
    if (!ghost) {
      ghost = ghostDot({ r: DOT_RADIUS.link, strokeWidth: DOT_STROKE_WIDTH.link });
      session.setGhost(ghost);
    }
    ghost.setAttribute('cx', String(tip.x));
    ghost.setAttribute('cy', String(tip.y));
    ghost.setAttribute('opacity', (attached || drag.hoverRope) ? '0.95' : '0.45');
  },

  // ─── Drag end ────────────────────────────────────────────────────

  onUp(drag, session) {
    const { context } = session;
    const ropeId = drag.ropeId;
    if (!ropeId) return;

    if (drag.hoverRope) {
      const merged = mergeRopesAtEnds(
        context.engine,
        ropeId,
        drag.end,
        drag.hoverRope.ropeId,
        drag.hoverRope.which,
      );
      snapRopePins(context.engine);
      if (merged?.ropeId) {
        enforceRopeLength(context.engine, merged.ropeId);
        const sel = ropeSelection(context.engine, merged.ropeId);
        if (sel) context.onSelect?.(sel);
        session.invalidateBuildKey();
      }
    } else if (drag.hoverTarget) {
      setRopeEndAttachment(
        context.engine, ropeId, drag.end, drag.hoverTarget.body, drag.hoverTarget.local,
      );
      enforceRopeLength(context.engine, ropeId);
    } else {
      setRopeEndAttachment(context.engine, ropeId, drag.end, null);
      enforceRopeLength(context.engine, ropeId);
    }
    snapRopePins(context.engine);
    session.updatePositions();
    context.showProperties?.(context.getSelection());
    context.refreshBrowser?.();
  },
};
