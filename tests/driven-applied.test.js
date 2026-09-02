import { describe, it, expect } from 'vitest';
import {
  setDrivenAppliedForce,
  setDrivenAppliedForceExpr,
  evaluateDrivenAppliedFrequency,
  evaluateDrivenAppliedOmega,
  evaluateDrivenAppliedForce,
  isDrivenAppliedForce,
  collectDrivenAppliedAppForces,
  getAppliedForceDirection,
  DEFAULT_DRIVEN_APPLIED_FORCE_EXPR,
} from '../src/physics/applied-force.js';
import { serializeScene } from '../src/scene/serialize.js';
import { cloneSceneDocument } from '../src/scene/serialize.js';
import { loadScene, runForSeconds, findBody } from './helpers/sim.js';

const PULL_AT_ANGLE = '../demo/Physics_Problems/pull-at-angle.json';
const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('driven applied force', () => {
  it('applies constant F(t) and accelerates a box', () => {
    const doc = cloneSceneDocument(demoScenes[PULL_AT_ANGLE]);
    // Drop gravity / constant F so only our drive moves the body.
    if (doc.environment?.gravity) doc.environment.gravity.enabled = false;
    for (const b of doc.bodies ?? []) {
      delete b.appliedForce;
      delete b.velocity;
    }

    const engine = loadScene(doc);
    const box = engine.bodies.find(b => b._newtonType === 'box' || b._newtonType === 'ball' || b._newtonType === 'point' || b._newtonType === 'point-mass')
      ?? engine.bodies.find(b => !b.isStatic && b._newtonType !== 'metric-basis');
    expect(box).toBeTruthy();

    const x0 = box.position.x;
    setDrivenAppliedForce(box, true);
    setDrivenAppliedForceExpr(box, '10');
    // Force along +x
    box._appliedForce = { F: 0, thetaDeg: 0 };
    expect(isDrivenAppliedForce(box)).toBe(true);
    expect(evaluateDrivenAppliedForce(box, 0)).toBeCloseTo(10, 10);

    runForSeconds(engine, 1);
    expect(box.position.x).toBeGreaterThan(x0 + 1);
  });

  it('exposes F_app for the free-body diagram', () => {
    const doc = cloneSceneDocument(demoScenes[PULL_AT_ANGLE]);
    if (doc.environment?.gravity) doc.environment.gravity.enabled = false;
    for (const b of doc.bodies ?? []) delete b.appliedForce;

    const engine = loadScene(doc);
    const body = engine.bodies.find(b => !b.isStatic && b._newtonType !== 'metric-basis');
    setDrivenAppliedForce(body, true);
    setDrivenAppliedForceExpr(body, '4');
    body._appliedForce = { F: 0, thetaDeg: 90 };

    const forces = collectDrivenAppliedAppForces(engine);
    const f = forces.get(body.id);
    expect(f).toBeTruthy();
    expect(f.F).toBeCloseTo(4, 6);
    expect(f.thetaDeg).toBeCloseTo(90, 6);
  });

  it('flips F_app 180° when F(t) is negative', () => {
    const doc = cloneSceneDocument(demoScenes[PULL_AT_ANGLE]);
    const engine = loadScene(doc);
    const body = engine.bodies.find(b => !b.isStatic && b._newtonType !== 'metric-basis');
    setDrivenAppliedForce(body, true);
    setDrivenAppliedForceExpr(body, '-3');
    body._appliedForce = { F: 0, thetaDeg: 0 };

    const f = collectDrivenAppliedAppForces(engine).get(body.id);
    expect(f.F).toBeCloseTo(3, 6);
    expect(f.thetaDeg).toBeCloseTo(180, 6);
  });

  it('serializes and reloads driven applied force', () => {
    const doc = cloneSceneDocument(demoScenes[PULL_AT_ANGLE]);
    const engine = loadScene(doc);
    const body = engine.bodies.find(b => !b.isStatic && b._newtonType !== 'metric-basis');
    const id = body.label;
    setDrivenAppliedForce(body, true);
    setDrivenAppliedForceExpr(body, DEFAULT_DRIVEN_APPLIED_FORCE_EXPR);
    body._appliedForce = { F: 0, thetaDeg: 45 };

    const out = serializeScene(engine);
    const entry = out.bodies.find(b => b.id === id);
    expect(entry.drivenApplied).toBe(true);
    expect(entry.drivenAppliedForce).toBe(DEFAULT_DRIVEN_APPLIED_FORCE_EXPR);
    expect(entry.appliedForce?.thetaDeg).toBeCloseTo(45, 5);

    const engine2 = loadScene(out);
    const b2 = findBody(engine2, id);
    expect(isDrivenAppliedForce(b2)).toBe(true);
    expect(getAppliedForceDirection(b2)).toBeCloseTo(45, 5);
    expect(evaluateDrivenAppliedForce(b2, 0.25)).toBeCloseTo(5, 8);
  });

  it('tracks instantaneous frequency and angular frequency for a chirped drive', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    const body = findBody(engine, 'mass');

    expect(evaluateDrivenAppliedFrequency(body, 0)).toBeCloseTo(0.4, 8);
    expect(evaluateDrivenAppliedFrequency(body, 2)).toBeCloseTo(0.42, 8);
    expect(evaluateDrivenAppliedOmega(body, 2)).toBeCloseTo(2 * Math.PI * 0.42, 8);

    const out = serializeScene(engine);
    const entry = out.bodies.find(b => b.id === 'mass');
    expect(entry.parameters.omega.expression).toBe('2pi(0.4 + 0.01t)');
    expect(entry.drivenAppliedForce).toBe('2sin(omega t)');
    expect(entry.drivenAppliedPhaseParameter).toBe('omega');
  });

  it('works on circle, point, box, and wedge types', () => {
    const doc = {
      format: 'newton-scene',
      version: 2,
      metricOrigin: { x: 0, y: 0 },
      environment: { gravity: { enabled: false, g: 9.81 } },
      bodies: [
        { id: 'b0', type: 'point', position: { x: 0, y: 0 }, mass: 1, geometry: { radius: 0.2 } },
        { id: 'b1', type: 'ball', position: { x: 1, y: 0 }, mass: 1 },
        { id: 'b2', type: 'box', position: { x: 2, y: 0 }, mass: 1, geometry: { width: 0.4, height: 0.4 } },
        { id: 'b3', type: 'wedge', position: { x: 3, y: 0 }, mass: 1, geometry: { width: 0.6, height: 0.4 } },
      ],
      constraints: [],
    };
    const engine = loadScene(doc);
    for (const id of ['b0', 'b1', 'b2', 'b3']) {
      const b = findBody(engine, id);
      expect(b).toBeTruthy();
      setDrivenAppliedForce(b, true);
      setDrivenAppliedForceExpr(b, '2');
      b._appliedForce = { F: 0, thetaDeg: 0 };
      expect(isDrivenAppliedForce(b)).toBe(true);
      expect(evaluateDrivenAppliedForce(b, 0)).toBeCloseTo(2, 10);
    }
  });
});
