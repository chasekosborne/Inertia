/**
 * Constraint end handles (rod / string / spring).
 *
 * Both ends get a grab dot, and which drag they start depends on what sits at
 * that end:
 *
 *   - circle / ball / box / wedge → **stretch**: slide the body along the link
 *     axis and set the link length to match, dragging any hanging chain below
 *     it so lower link lengths stay fixed.
 *   - anchor / ground → **reattach**: pick a different body to hang from.
 *
 * Reattach never allows a free world end: releasing over empty space restores
 * the previous attachment (and the previous length, for non-springs).
 */

import {
  constraintAnchorWorld,
  setConstraintEndAttachment,
  findConstraintAttachTarget,
  isConstraintLengthStretchBody,
  stretchConstraintEndAlongAxis,
  captureHangingChain,
  applyHangingChainTranslation,
} from '../../../physics/layout-anchors.js';
import { snapWorldCoord } from '../../../grid.js';
import { PX_PER_M } from '../../../units.js';
import { FONT_DIAGRAM } from '../../../theme.js';
import {
  svgEl, handleDot, ghostDot, DOT_RADIUS, DOT_STROKE_WIDTH, HANDLE_BLUE,
} from '../chrome.js';

/** Shortest a link may be stretched to (world px). */
const MIN_LENGTH_PX = 5;
/** Search radius for an attach target under the cursor (world px). */
const ATTACH_HIT_PX = 32;

function isSpringConstraint(constraint) {
  return constraint?._newtonType === 'spring';
}

/** Springs use smaller reattach dots; rods / strings a bit larger for grab. */
function dotSize(constraint) {
  return isSpringConstraint(constraint)
    ? { r: DOT_RADIUS.spring, strokeWidth: DOT_STROKE_WIDTH.spring }
    : { r: DOT_RADIUS.link, strokeWidth: DOT_STROKE_WIDTH.link };
}

/** Axis-aligned resize cursor for stretch ends, crosshair for reattach ends. */
function cursorFor(constraint, end, body) {
  if (!isConstraintLengthStretchBody(body) || !constraint) return 'crosshair';
  const other = end === 'A'
    ? constraintAnchorWorld(constraint, 'B')
    : constraintAnchorWorld(constraint, 'A');
  const here = constraintAnchorWorld(constraint, end);
  const dx = Math.abs(here.x - other.x);
  const dy = Math.abs(here.y - other.y);
  return dx >= dy ? 'ew-resize' : 'ns-resize';
}

export const constraintHandles = {
  prefix: 'c',
  kinds: ['constraint', 'constraint-length'],

  keyFor(selection) {
    return selection?.type === 'constraint' ? String(selection.id) : null;
  },

  build(group, id, session) {
    const constraintId = parseInt(id, 10);
    const constraint = session.context.engine.constraints.find(x => x.id === constraintId);
    const { r, strokeWidth } = dotSize(constraint);

    for (const end of ['A', 'B']) {
      const body = end === 'A' ? constraint?.bodyA : constraint?.bodyB;
      // Free ends are not shown and not editable.
      if (!body) continue;
      group.appendChild(handleDot({
        r,
        strokeWidth,
        cursor: cursorFor(constraint, end, body),
        color: HANDLE_BLUE,
        data: { 'sel-handle': '1', end, conid: constraintId },
        onPointerDown: event => this._onDown(event, session),
      }));
    }
  },

  updatePositions(group, id, session) {
    const constraint = session.context.engine.constraints.find(x => x.id === parseInt(id, 10));
    if (!constraint) return;
    const a = constraintAnchorWorld(constraint, 'A');
    const b = constraintAnchorWorld(constraint, 'B');
    const [dotA, dotB] = group.querySelectorAll('circle');
    if (dotA) { dotA.setAttribute('cx', String(a.x)); dotA.setAttribute('cy', String(a.y)); }
    if (dotB) { dotB.setAttribute('cx', String(b.x)); dotB.setAttribute('cy', String(b.y)); }
  },

  // ─── Drag start ──────────────────────────────────────────────────

  _onDown(event, session) {
    const { context } = session;
    if (!context.canEdit()) return;
    event.stopPropagation();
    event.preventDefault();
    const constraintId = parseInt(event.currentTarget.getAttribute('data-conid'), 10);
    const end = event.currentTarget.getAttribute('data-end');
    const constraint = context.engine.constraints.find(x => x.id === constraintId);
    if (!constraint) return;
    const body = end === 'A' ? constraint.bodyA : constraint.bodyB;
    // Free ends are not editable: both ends must be attached.
    if (!body) return;
    const local = end === 'A'
      ? { ...(constraint.pointA ?? { x: 0, y: 0 }) }
      : { ...(constraint.pointB ?? { x: 0, y: 0 }) };
    context.pushHistory();

    if (isConstraintLengthStretchBody(body)) {
      const otherEnd = end === 'A' ? 'B' : 'A';
      const pivot = constraintAnchorWorld(constraint, otherEnd);
      const here = constraintAnchorWorld(constraint, end);
      let dx = here.x - pivot.x;
      let dy = here.y - pivot.y;
      let length = Math.hypot(dx, dy);
      if (length < 1e-6) {
        dx = 0;
        dy = 1;
        length = 1;
      }
      session.beginDrag({
        kind: 'constraint-length',
        constraintId,
        end,
        axis: { x: dx / length, y: dy / length },
        original: { body, local, length: constraint.length },
        lastLength: constraint.length,
        hangingChain: captureHangingChain(context.engine, body, {
          skipConstraintIds: [constraintId],
        }),
      });
    } else {
      session.beginDrag({
        kind: 'constraint',
        constraintId,
        end,
        original: { body, local, length: constraint.length },
        hoverTarget: null,
      });
    }
  },

  // ─── Drag move ───────────────────────────────────────────────────

  onMove(drag, world, event, session) {
    if (drag.kind === 'constraint-length') this._moveStretch(drag, world, session);
    else this._moveReattach(drag, world, session);
  },

  _moveStretch(drag, world, session) {
    const { context } = session;
    const constraint = context.engine.constraints.find(x => x.id === drag.constraintId);
    if (!constraint || !drag.axis) return;
    const result = stretchConstraintEndAlongAxis(constraint, drag.end, world.x, world.y, {
      axis: drag.axis,
      minLen: MIN_LENGTH_PX,
      snapGrid: context.getSnapEnabled(),
    });
    if (!result) return;
    drag.lastLength = result.length;
    const movedBody = drag.end === 'A' ? constraint.bodyA : constraint.bodyB;
    if (movedBody && drag.hangingChain) {
      applyHangingChainTranslation(drag.hangingChain, movedBody);
    }
    session.updatePositions();

    // Guide: dashed axis from the pivot through the new attach point,
    // plus a live length readout.
    let ghost = session.getGhost();
    if (!ghost) {
      ghost = svgEl('g', { 'pointer-events': 'none' });
      const line = svgEl('line', {
        stroke: HANDLE_BLUE,
        'stroke-width': '1.25',
        'stroke-dasharray': '5 4',
        opacity: '0.85',
      });
      const tip = ghostDot({ ...dotSize(constraint), opacity: 0.95 });
      const label = svgEl('text', {
        fill: HANDLE_BLUE,
        'font-size': '11',
        'font-family': FONT_DIAGRAM,
      });
      ghost.append(line, tip, label);
      ghost._line = line;
      ghost._tip = tip;
      ghost._label = label;
      session.setGhost(ghost);
    }

    const { pivot, attach, length, axis } = result;
    const extend = Math.max(40, length + 24);
    ghost._line.setAttribute('x1', String(pivot.x));
    ghost._line.setAttribute('y1', String(pivot.y));
    ghost._line.setAttribute('x2', String(pivot.x + axis.x * extend));
    ghost._line.setAttribute('y2', String(pivot.y + axis.y * extend));
    ghost._tip.setAttribute('cx', String(attach.x));
    ghost._tip.setAttribute('cy', String(attach.y));
    ghost._label.setAttribute('x', String(attach.x + axis.y * 10 + 6));
    ghost._label.setAttribute('y', String(attach.y - axis.x * 10 - 4));
    ghost._label.textContent = `${(length / PX_PER_M).toFixed(3)} m`;
  },

  _moveReattach(drag, world, session) {
    const { context } = session;
    const constraint = context.engine.constraints.find(x => x.id === drag.constraintId);
    if (!constraint) return;
    const snap = context.getSnapEnabled();
    const otherBody = drag.end === 'A' ? constraint.bodyB : constraint.bodyA;
    const target = findConstraintAttachTarget(context.engine, world.x, world.y, {
      excludeConstraintId: constraint.id,
      excludeBodyId: otherBody?.id ?? null,
      hitPx: ATTACH_HIT_PX,
      snapGrid: snap,
    });
    drag.hoverTarget = target;
    if (target) {
      setConstraintEndAttachment(constraint, drag.end, target.body, target.local);
    } else if (drag.original) {
      // Keep the last valid body attachment: never leave a free world end.
      setConstraintEndAttachment(
        constraint, drag.end, drag.original.body, drag.original.local,
      );
    }
    session.updatePositions();
    session.setHoverHighlight(target?.body?.id ?? null);

    // Ghost follows the cursor until a valid attach target is under it.
    let ghost = session.getGhost();
    if (!ghost) {
      ghost = ghostDot(dotSize(constraint));
      session.setGhost(ghost);
    }
    const x = target ? target.world.x : snapWorldCoord(world.x, snap);
    const y = target ? target.world.y : snapWorldCoord(world.y, snap);
    ghost.setAttribute('cx', String(x));
    ghost.setAttribute('cy', String(y));
    ghost.setAttribute('opacity', target ? '0.95' : '0.45');
  },

  // ─── Drag end ────────────────────────────────────────────────────

  onUp(drag, session) {
    if (drag.kind === 'constraint-length') {
      session.updatePositions();
      return;
    }
    const { context } = session;
    const constraint = context.engine.constraints.find(x => x.id === drag.constraintId);
    if (!constraint || !drag.original) return;
    // Must land on a body / constraint end, otherwise restore the prior attachment.
    if (!drag.hoverTarget) {
      setConstraintEndAttachment(
        constraint, drag.end, drag.original.body, drag.original.local,
      );
      if (!isSpringConstraint(constraint) && drag.original.length != null) {
        constraint.length = drag.original.length;
      }
    }
    session.updatePositions();
  },
};
