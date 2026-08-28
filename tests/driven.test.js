import { describe, it, expect } from 'vitest';
import { compileExpr, latexToExpr, exprToLatex, evalExpr } from '../src/physics/expr.js';
import {
  setDriven,
  setDrivenTorqueExpr,
  evaluateDrivenTorque,
  isDrivenPivot,
  collectDrivenAppForces,
  DEFAULT_DRIVEN_TORQUE_EXPR,
} from '../src/physics/driven-pivot.js';
import { serializeScene } from '../src/scene/serialize.js';
import { cloneSceneDocument } from '../src/scene/serialize.js';
import { loadScene, runForSeconds, findBody } from './helpers/sim.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('expr compiler', () => {
  it('evaluates trig drive expressions', () => {
    const c = compileExpr('0.5*sin(2*pi*t)');
    expect(c.ok).toBe(true);
    expect(c.eval({ t: 0 })).toBeCloseTo(0, 10);
    expect(c.eval({ t: 0.25 })).toBeCloseTo(0.5, 10);
  });

  it('handles implicit multiplication', () => {
    expect(evalExpr('2pi', 0)).toBeCloseTo(2 * Math.PI, 10);
    expect(evalExpr('2t', 3)).toBeCloseTo(6, 10);
  });

  it('rejects unknown identifiers', () => {
    const c = compileExpr('sin(x)');
    expect(c.ok).toBe(false);
  });

  it('converts MathLive-style latex', () => {
    const latex = '5\\sin\\left(2\\pi t\\right)';
    const ascii = latexToExpr(latex);
    expect(evalExpr(ascii, 0.25)).toBeCloseTo(5 * Math.sin(2 * Math.PI * 0.25), 8);
  });

  it('round-trips latex helpers', () => {
    const ascii = '0.5*sin(2*pi*t)';
    const latex = exprToLatex(ascii);
    expect(latex).toContain('\\sin');
    expect(latex).toContain('\\pi');
    const back = latexToExpr(latex);
    const v0 = evalExpr(ascii, 0.125);
    const v1 = evalExpr(back, 0.125);
    expect(v1).toBeCloseTo(v0, 8);
  });
});

describe('driven pivot', () => {
  it('applies constant drive torque and moves the bob', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-pendulum.json']);
    const bobDoc = doc.bodies.find(b => b.id === 'bob');
    if (bobDoc) bobDoc.position = { x: 0, y: 1.2 };

    const engine = loadScene(doc);
    const anchor = findBody(engine, 'anchor_1');
    expect(anchor).toBeTruthy();

    setDriven(anchor, true);
    setDrivenTorqueExpr(anchor, '2');
    expect(isDrivenPivot(anchor)).toBe(true);
    expect(evaluateDrivenTorque(anchor, 0)).toBeCloseTo(2, 10);

    runForSeconds(engine, 2);

    const bob = findBody(engine, 'bob');
    // θ ≈ θ_eq (1 − cos ωt); after ~2 s should leave the vertical by >0.5°.
    const angDeg = Math.abs(Math.atan2(bob.position.x - anchor.position.x, bob.position.y - anchor.position.y)) * 180 / Math.PI;
    expect(angDeg).toBeGreaterThan(0.5);
  });

  it('serializes and reloads driven torque expression', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-pendulum.json']);
    const engine = loadScene(doc);
    const anchor = findBody(engine, 'anchor_1');
    setDriven(anchor, true);
    setDrivenTorqueExpr(anchor, DEFAULT_DRIVEN_TORQUE_EXPR);

    const out = serializeScene(engine);
    const a = out.bodies.find(b => b.id === 'anchor_1');
    expect(a.driven).toBe(true);
    expect(a.drivenTorque).toBe(DEFAULT_DRIVEN_TORQUE_EXPR);

    const engine2 = loadScene(out);
    const a2 = findBody(engine2, 'anchor_1');
    expect(isDrivenPivot(a2)).toBe(true);
    expect(evaluateDrivenTorque(a2, 0.25)).toBeCloseTo(0.5, 8);
  });

  it('rotates the hinge glyph from the drive function', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/angular-driven-pendulum.json']);
    const engine = loadScene(doc);
    const pivot = findBody(engine, 'anchor_1');
    expect(isDrivenPivot(pivot)).toBe(true);
    const a0 = pivot._drivenVisualAngle ?? 0;
    runForSeconds(engine, 0.5);
    expect(Math.abs((pivot._drivenVisualAngle ?? 0) - a0)).toBeGreaterThan(0.05);
  });

  it('exposes F_app = τ/r on the linked bob', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/angular-driven-pendulum.json']);
    // Constant torque so |F| = |τ|/ℓ is exact.
    doc.bodies.find(b => b.id === 'anchor_1').drivenTorque = '0.6';
    const bobDoc = doc.bodies.find(b => b.id === 'bob');
    bobDoc.position = { x: 0, y: 1.2 };

    const engine = loadScene(doc);
    const bob = findBody(engine, 'bob');
    const forces = collectDrivenAppForces(engine);
    const f = forces.get(bob.id);
    expect(f).toBeTruthy();
    expect(f.F).toBeCloseTo(0.6 / 1.2, 6);
    // Hanging bob + +τ → horizontal force in display frame
    expect(Math.abs(Math.cos(f.thetaDeg * Math.PI / 180))).toBeCloseTo(1, 5);
  });
});
