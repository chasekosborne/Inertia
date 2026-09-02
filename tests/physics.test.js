import { describe, it, expect } from 'vitest';
import { cloneSceneDocument } from '../src/scene/serialize.js';
import {
  loadScene,
  runForSeconds,
  findBody,
  bodyDisplayPos,
  bodyDisplayVel,
  sampleEnergy,
  sampleWhileRunning,
  estimateHalfPeriodFromPeaks,
} from './helpers/sim.js';
import { evaluateMeasurementOnEngine } from '../src/editor/measure-eval.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

/** Shorter sim for rope-heavy demos: NaN smoke only, avoids CI timeouts on 100-segment ropes. */
function smokeTestSeconds(doc) {
  const ropeSegs = (doc.bodies ?? []).filter(b => b.material?.ropeSegment === true).length;
  if (ropeSegs >= 40) return 0.15;
  if (ropeSegs >= 10) return 0.3;
  return 1;
}

function conservativeDoc(path) {
  const doc = cloneSceneDocument(demoScenes[path]);
  if (doc.environment?.air) doc.environment.air.enabled = false;
  if (doc.environment?.gravity == null) {
    doc.environment = { ...(doc.environment ?? {}), gravity: { enabled: true, g: 9.81 } };
  }
  for (const b of doc.bodies ?? []) {
    if (!b.material) b.material = {};
    b.material.muK = 0;
    b.material.muS = 0;
    b.material.frictionAir = 0;
    if (b.material.restitution == null) b.material.restitution = 0;
  }
  return doc;
}

describe('energy conservation (conservative demos)', () => {
  const cases = [
    '../demo/Classic/simple-pendulum.json',
    '../demo/Classic/simple-harmonic-oscillator.json',
    '../demo/Classic/double-pendulum-slight.json',
  ];

  for (const path of cases) {
    it(`holds mechanical energy for ${path.replace('../demo/', '')}`, () => {
      const doc = conservativeDoc(path);
      const engine = loadScene(doc);
      const E0 = sampleEnergy(engine);
      expect(Number.isFinite(E0)).toBe(true);

      runForSeconds(engine, 3);
      const E1 = sampleEnergy(engine);
      const relDrift = Math.abs(E1 - E0) / Math.max(Math.abs(E0), 1e-9);
      expect(relDrift).toBeLessThan(0.05);
    });
  }
});

describe('simple pendulum', () => {
  it('swings with expected finite-amplitude period', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-pendulum.json']);
    const engine = loadScene(doc);
    const thetaMeas = doc.measurements?.find(m => m.id === 'theta_arc');
    expect(thetaMeas).toBeTruthy();

    const { t, v } = sampleWhileRunning(engine, 8, () => {
      const val = evaluateMeasurementOnEngine(thetaMeas, engine);
      return typeof val === 'number' ? Math.abs(val) : 0;
    });

    const halfPeriod = estimateHalfPeriodFromPeaks(t, v);
    expect(halfPeriod).not.toBeNull();
    // Meta: finite-amplitude T ≈ 2.249 s (full period); peak-to-peak ≈ half period.
    const fullPeriod = (halfPeriod ?? 0) * 2;
    expect(fullPeriod).toBeGreaterThan(2.0);
    expect(fullPeriod).toBeLessThan(2.6);
  });

  it('keeps bob near constant rod length', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-pendulum.json']);
    const engine = loadScene(doc);
    const anchor = findBody(engine, 'anchor_1');
    const bob = findBody(engine, 'bob');
    expect(anchor && bob).toBeTruthy();

    runForSeconds(engine, 4);
    const ap = bodyDisplayPos(engine, anchor);
    const bp = bodyDisplayPos(engine, bob);
    const len = Math.hypot(bp.x - ap.x, bp.y - ap.y);
    expect(len).toBeCloseTo(1.2, 1);
  });
});

describe('projectile motion', () => {
  it('reaches expected range and apex', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/projectile-motion-2d.json']);
    const engine = loadScene(doc);
    const point = findBody(engine, 'point');
    expect(point).toBeTruthy();

    let maxY = -Infinity;
    let landingX = null;
    for (let i = 0; i < 960 * 3; i++) {
      engine.step();
      const { x, y } = bodyDisplayPos(engine, point);
      if (y > maxY) maxY = y;
      const { vyMs } = bodyDisplayVel(point);
      if (landingX == null && y < 0.2 && vyMs < -1) landingX = x;
    }
    if (landingX == null) {
      const { x } = bodyDisplayPos(engine, point);
      landingX = x;
    }

    // Meta: R ≈ 5.65 m, H ≈ 2.45 m
    expect(maxY).toBeGreaterThan(2.2);
    expect(maxY).toBeLessThan(2.7);
    expect(landingX).not.toBeNull();
    expect(landingX).toBeGreaterThan(5.2);
    expect(landingX).toBeLessThan(6.1);
  });
});

describe('simple harmonic oscillator', () => {
  it('oscillates near the documented angular frequency', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    const mass = findBody(engine, 'mass');
    expect(mass).toBeTruthy();

    const { t, v } = sampleWhileRunning(engine, 4, () => bodyDisplayPos(engine, mass).x);
    const halfPeriod = estimateHalfPeriodFromPeaks(t, v.map(x => Math.abs(x - 0)));
    expect(halfPeriod).not.toBeNull();
    const omega = Math.PI / (halfPeriod ?? 1);
    // Meta: ω ≈ 6.32 rad/s
    expect(omega).toBeGreaterThan(5.5);
    expect(omega).toBeLessThan(7.0);
  });
});

describe('ground collision', () => {
  it('uses a thin collider along the top edge only', async () => {
    const { createGround, createBall, GROUND_COLLISION_THICKNESS } = await import('../src/physics/bodies.js');
    const { groundTopEdgeWorld } = await import('../src/physics/layout-anchors.js');
    const { PhysicsEngine } = await import('../src/physics/engine.js');

    const ground = createGround(400, 300, 400, 20, { muK: 0, muS: 0, restitution: 0 });
    expect(ground.bounds.max.y - ground.bounds.min.y).toBeCloseTo(GROUND_COLLISION_THICKNESS, 1);

    const { L, R } = groundTopEdgeWorld(ground);
    const midX = (L.x + R.x) / 2;
    const midY = (L.y + R.y) / 2;
    const cos = Math.cos(ground.angle);
    const sin = Math.sin(ground.angle);
    // Inside the hatched slab but off the walking surface (beside the line).
    const sideX = midX + cos * 80;
    const sideY = midY + sin * 80 + 10;

    const engine = new PhysicsEngine();
    engine.addBody(ground);
    const ball = createBall(sideX, sideY, { radius: 12, mass: 1, muK: 0, muS: 0, restitution: 0 });
    engine.addBody(ball);

    for (let i = 0; i < 30; i++) engine.step();

    // Should fall through the visual slab (no side collision).
    expect(ball.position.y).toBeGreaterThan(sideY + 5);
  });
});

describe('rod to angled ground', () => {
  it('pivots about the top-edge attach point (Matter static offset)', async () => {
    const { PhysicsEngine } = await import('../src/physics/engine.js');
    const { createGround, createBall } = await import('../src/physics/bodies.js');
    const { createRod, constraintAnchorWorld, matterPointFromLocal } = await import('../src/physics/constraints.js');
    const { groundTopEdgeWorld, worldToBodyLocal } = await import('../src/physics/layout-anchors.js');
    const { BASE_DELTA_MS } = await import('../src/units.js');

    const engine = new PhysicsEngine();
    engine.setConserveEnergy(true);
    engine.engine.gravity.scale = 0.001;

    const ang = Math.PI / 6;
    const ground = createGround(400, 300, 400, 20, { angle: ang, muK: 0, muS: 0, restitution: 0 });
    const { L, R } = groundTopEdgeWorld(ground);
    const attach = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
    const local = worldToBodyLocal(ground, attach.x, attach.y);
    const Lrod = 150;
    const bob = createBall(attach.x, attach.y + Lrod, {
      radius: 12, mass: 1, muK: 0, muS: 0, restitution: 0, frictionAir: 0,
    });
    bob.frictionAir = 0;
    const rod = createRod(ground, bob, {
      pointA: local, pointB: { x: 0, y: 0 }, length: Lrod,
    });

    // Matter must store the rotated world-offset for the static end.
    const expectedMatter = matterPointFromLocal(ground, local);
    expect(rod._matter.pointA.x).toBeCloseTo(expectedMatter.x, 6);
    expect(rod._matter.pointA.y).toBeCloseTo(expectedMatter.y, 6);

    engine.addBody(ground);
    engine.addBody(bob);
    engine.addConstraint(rod);

    // Kick sideways and integrate.
    const Matter = (await import('matter-js')).default;
    Matter.Body.setVelocity(bob, { x: 2.5, y: 0 });

    let maxPivotErr = 0;
    let maxLenErr = 0;
    const steps = Math.round(2 / (BASE_DELTA_MS / 1000));
    for (let i = 0; i < steps; i++) {
      engine.step();
      const pivot = constraintAnchorWorld(rod, 'A');
      maxPivotErr = Math.max(maxPivotErr, Math.hypot(pivot.x - attach.x, pivot.y - attach.y));
      const tip = constraintAnchorWorld(rod, 'B');
      const len = Math.hypot(tip.x - pivot.x, tip.y - pivot.y);
      maxLenErr = Math.max(maxLenErr, Math.abs(len - Lrod));
    }

    expect(maxPivotErr).toBeLessThan(0.5);
    expect(maxLenErr).toBeLessThan(1.0);
  });
});

describe('demo scenes load and step', () => {
  for (const [path, doc] of Object.entries(demoScenes)) {
    it(`steps without NaN state: ${path.replace('../demo/', '')}`, () => {
      const scene = cloneSceneDocument(doc);
      const engine = loadScene(scene);
      runForSeconds(engine, smokeTestSeconds(scene));
      for (const b of engine.bodies) {
        expect(Number.isFinite(b.position.x)).toBe(true);
        expect(Number.isFinite(b.position.y)).toBe(true);
        expect(Number.isFinite(b.velocity.x)).toBe(true);
        expect(Number.isFinite(b.velocity.y)).toBe(true);
      }
    });
  }
});
