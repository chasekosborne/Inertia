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
import { evaluateMeasurementOnEngine } from '../src/ui/measure-eval.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

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

describe('demo scenes load and step', () => {
  for (const [path, doc] of Object.entries(demoScenes)) {
    it(`steps without NaN state: ${path.replace('../demo/', '')}`, () => {
      const engine = loadScene(cloneSceneDocument(doc));
      runForSeconds(engine, 1);
      for (const b of engine.bodies) {
        expect(Number.isFinite(b.position.x)).toBe(true);
        expect(Number.isFinite(b.position.y)).toBe(true);
        expect(Number.isFinite(b.velocity.x)).toBe(true);
        expect(Number.isFinite(b.velocity.y)).toBe(true);
      }
    });
  }
});
