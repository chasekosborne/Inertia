/**
 * Rope end handles.
 *
 * Like a constraint reattach, with one deliberate difference: a rope end may
 * be left hanging. Releasing over empty space detaches the end and parks the
 * node at the cursor, where a constraint would snap back to its old host.
 */

import Matter from 'matter-js';
import {
  ropeEndNode, getRopeEndAttachment, setRopeEndAttachment, snapRopePins,
} from '../../../physics/rope.js';
import { findConstraintAttachTarget } from '../../../physics/layout-anchors.js';
import { snapWorldCoord } from '../../../grid.js';
import { handleDot, ghostDot, DOT_RADIUS, DOT_STROKE_WIDTH, HANDLE_BLUE } from '../chrome.js';

const { Body } = Matter;

/** Search radius for an attach target under the cursor (world px). */
const ATTACH_HIT_PX = 32;

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
    const host = getRopeEndAttachment(context.engine, ropeId, end);
    context.pushHistory();
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
    });
  },

  // ─── Drag move ───────────────────────────────────────────────────

  onMove(drag, world, event, session) {
    const { context } = session;
    const { engine } = context;
    const snap = context.getSnapEnabled();
    const ropeId = drag.ropeId;
    const other = getRopeEndAttachment(engine, ropeId, drag.end === 'A' ? 'B' : 'A');
    const target = findConstraintAttachTarget(engine, world.x, world.y, {
      excludeBodyId: other?.body?.id ?? null,
      hitPx: ATTACH_HIT_PX,
      snapGrid: snap,
    });
    const attached = target
      ? setRopeEndAttachment(engine, ropeId, drag.end, target.body, target.local)
      : false;

    if (!attached) {
      drag.hoverTarget = null;
      setRopeEndAttachment(engine, ropeId, drag.end, null);
      const node = ropeEndNode(engine, ropeId, drag.end);
      if (node) {
        Body.setPosition(node, {
          x: snapWorldCoord(world.x, snap),
          y: snapWorldCoord(world.y, snap),
        });
        Body.setVelocity(node, { x: 0, y: 0 });
      }
    } else {
      drag.hoverTarget = target;
    }

    snapRopePins(engine);
    session.updatePositions();
    session.setHoverHighlight(attached ? target.body.id : null);

    let ghost = session.getGhost();
    if (!ghost) {
      ghost = ghostDot({ r: DOT_RADIUS.link, strokeWidth: DOT_STROKE_WIDTH.link });
      session.setGhost(ghost);
    }
    const x = attached ? target.world.x : snapWorldCoord(world.x, snap);
    const y = attached ? target.world.y : snapWorldCoord(world.y, snap);
    ghost.setAttribute('cx', String(x));
    ghost.setAttribute('cy', String(y));
    ghost.setAttribute('opacity', attached ? '0.95' : '0.45');
  },

  // ─── Drag end ────────────────────────────────────────────────────

  onUp(drag, session) {
    const { context } = session;
    const ropeId = drag.ropeId;
    if (!ropeId) return;
    // Empty space detaches (allowed for ropes). Snap to a body if hovered.
    if (drag.hoverTarget) {
      setRopeEndAttachment(
        context.engine, ropeId, drag.end, drag.hoverTarget.body, drag.hoverTarget.local,
      );
    } else {
      setRopeEndAttachment(context.engine, ropeId, drag.end, null);
    }
    snapRopePins(context.engine);
    session.updatePositions();
    context.showProperties?.(context.getSelection());
    context.refreshBrowser?.();
  },
};
