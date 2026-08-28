import { describe, it, expect } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../src/physics/engine.js';
import { createAnchor, createPointMass } from '../src/physics/bodies.js';
import {
  createFreeRope,
  listRopeSegments,
  ropeRestLengthPx,
  syncRopesAfterHostMove,
  snapRopePins,
} from '../src/physics/rope.js';

const { Body } = Matter;

/** Max absolute link-length error vs rest / (n-1). */
function maxLinkStretch(engine, ropeId) {
  const nodes = listRopeSegments(engine, ropeId);
  const rest = ropeRestLengthPx(engine, ropeId);
  const linkRest = rest / Math.max(1, nodes.length - 1);
  let maxErr = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i].position;
    const b = nodes[i + 1].position;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    maxErr = Math.max(maxErr, Math.abs(L - linkRest));
  }
  return maxErr;
}

describe('rope host setup move', () => {
  it('reprojects segments and clamps past rest when the bob is dragged', () => {
    const engine = new PhysicsEngine();
    const pivot = createAnchor(0, 0);
    const bob = createPointMass(0, 200, { mass: 1, radius: 8 });
    engine.addBody(pivot);
    engine.addBody(bob);

    const { ropeId } = createFreeRope(engine, [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 0, y: 200 },
    ], {
      segments: 4,
      attachA: { body: pivot, local: { x: 0, y: 0 } },
      attachB: { body: bob, local: { x: 0, y: 0 } },
    });
    expect(ropeId).toBeTruthy();

    const rest = ropeRestLengthPx(engine, ropeId);
    expect(rest).toBeGreaterThan(100);

    // Drag bob far past rest — without sync this would stretch every link.
    Body.setPosition(bob, { x: 0, y: rest * 2 });
    snapRopePins(engine);
    expect(maxLinkStretch(engine, ropeId)).toBeGreaterThan(20);

    syncRopesAfterHostMove(engine, bob);

    const chord = Math.hypot(bob.position.x - pivot.position.x, bob.position.y - pivot.position.y);
    expect(chord).toBeLessThanOrEqual(rest + 1);
    expect(maxLinkStretch(engine, ropeId)).toBeLessThan(2);
  });

  it('keeps link lengths when the bob moves within rest length', () => {
    const engine = new PhysicsEngine();
    const pivot = createAnchor(0, 0);
    const bob = createPointMass(0, 150, { mass: 1, radius: 8 });
    engine.addBody(pivot);
    engine.addBody(bob);

    const { ropeId } = createFreeRope(engine, [
      { x: 0, y: 0 },
      { x: 0, y: 75 },
      { x: 0, y: 150 },
    ], {
      segments: 5,
      attachA: { body: pivot, local: { x: 0, y: 0 } },
      attachB: { body: bob, local: { x: 0, y: 0 } },
    });

    const rest = ropeRestLengthPx(engine, ropeId);
    Body.setPosition(bob, { x: 40, y: rest * 0.6 });
    syncRopesAfterHostMove(engine, bob);

    expect(maxLinkStretch(engine, ropeId)).toBeLessThan(2);
  });
});
