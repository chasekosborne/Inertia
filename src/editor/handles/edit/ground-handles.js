/**
 * Ground top-edge handles.
 *
 * Drag either top corner to lay the ground segment; Ctrl locks the angle to 5°
 * steps. Unlike the other edit handles nothing moves during the drag — a dashed
 * preview line follows the cursor and the ground body is rebuilt only on
 * release, because `replaceGroundFromTopEdge` destroys and recreates it (new
 * Matter id), which would invalidate the handles mid-drag.
 */

import { groundTopEdgeWorld, replaceGroundFromTopEdge } from '../../../physics/layout-anchors.js';
import { snapSegmentFromStart } from '../../../grid.js';
import { svgEl, handleDot, DOT_RADIUS, DOT_STROKE_WIDTH, HANDLE_BLUE } from '../chrome.js';

export const groundHandles = {
  prefix: 'g',
  kinds: ['ground'],

  keyFor(selection, context) {
    if (selection?.type !== 'body') return null;
    const body = context.engine.bodies.find(x => x.id === selection.id);
    return body?._newtonType === 'ground' ? String(body.id) : null;
  },

  build(group, id, session) {
    const bodyId = parseInt(id, 10);
    for (const end of ['L', 'R']) {
      group.appendChild(handleDot({
        r: DOT_RADIUS.ground,
        strokeWidth: DOT_STROKE_WIDTH.ground,
        cursor: 'crosshair',
        color: HANDLE_BLUE,
        data: { 'sel-handle': '1', end, bid: bodyId },
        onPointerDown: event => this._onDown(event, session),
      }));
    }
  },

  updatePositions(group, id, session) {
    const body = session.context.engine.bodies.find(
      x => x.id === parseInt(id, 10) && x._newtonType === 'ground',
    );
    if (!body) return;
    const { L, R } = groundTopEdgeWorld(body);
    const [dotL, dotR] = group.querySelectorAll('circle');
    if (dotL) { dotL.setAttribute('cx', String(L.x)); dotL.setAttribute('cy', String(L.y)); }
    if (dotR) { dotR.setAttribute('cx', String(R.x)); dotR.setAttribute('cy', String(R.y)); }
  },

  // ─── Drag start ──────────────────────────────────────────────────

  _onDown(event, session) {
    const { context } = session;
    if (!context.canEdit()) return;
    event.stopPropagation();
    event.preventDefault();
    const bodyId = parseInt(event.currentTarget.getAttribute('data-bid'), 10);
    const end = event.currentTarget.getAttribute('data-end');
    const body = context.engine.bodies.find(x => x.id === bodyId);
    if (!body || body._newtonType !== 'ground') return;
    const { L, R } = groundTopEdgeWorld(body);
    const fixed = end === 'L' ? { ...R } : { ...L };
    context.pushHistory();

    session.setGhost(svgEl('line', {
      stroke: HANDLE_BLUE,
      'stroke-width': '2',
      'stroke-dasharray': '5 4',
      'pointer-events': 'none',
    }));

    session.beginDrag({
      kind: 'ground',
      bodyId,
      moving: end,
      fixed,
      left: { ...L },
      right: { ...R },
    });

    // Seed the preview from the press point so it appears before the first move.
    this.onMove(session.getDrag(), context.clientToWorld(event.clientX, event.clientY), event, session);
  },

  // ─── Drag move ───────────────────────────────────────────────────

  onMove(drag, world, event, session) {
    if (!drag) return;
    const snapped = snapSegmentFromStart(
      drag.fixed.x, drag.fixed.y, world.x, world.y,
      session.context.getSnapEnabled(), event.ctrlKey,
    );
    const moved = { x: snapped.x, y: snapped.y };
    drag.left = drag.moving === 'L' ? moved : { ...drag.fixed };
    drag.right = drag.moving === 'R' ? moved : { ...drag.fixed };

    const ghost = session.getGhost();
    if (ghost) {
      ghost.setAttribute('x1', String(drag.left.x));
      ghost.setAttribute('y1', String(drag.left.y));
      ghost.setAttribute('x2', String(drag.right.x));
      ghost.setAttribute('y2', String(drag.right.y));
    }
    session.updatePositions();
  },

  // ─── Drag end ────────────────────────────────────────────────────

  onUp(drag, session) {
    const { context } = session;
    const body = context.engine.bodies.find(x => x.id === drag.bodyId);
    if (!body || !drag.left || !drag.right) return;
    const rebuilt = replaceGroundFromTopEdge(context.engine, body, drag.left, drag.right);
    if (rebuilt) {
      // The old body is gone, so the build key now points at a dead id.
      session.invalidateBuildKey();
      context.onSelect({ type: 'body', id: rebuilt.id });
    }
  },
};
