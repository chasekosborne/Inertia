import { describe, it, expect } from 'vitest';
import { compileExpr } from '../src/physics/expr.js';
import {
  setDrivenAppliedParameters,
  setDrivenAppliedPhaseParameter,
  setDrivenAppliedForce,
  setDrivenAppliedForceExpr,
  evaluateDrivenAppliedForce,
  evaluateDrivenAppliedOmega,
} from '../src/physics/applied-force.js';
import { serializeScene } from '../src/scene/serialize.js';
import { Recorder } from '../src/recorder/recorder.js';
import {
  graphObservablesForTrack,
  graphObservablesForBody,
  parameterObsId,
  sampleParameter,
} from '../src/editor/graph-panel.js';
import { buildObjectBrowserTree } from '../src/scene/aggregates.js';
import { loadScene, findBody } from './helpers/sim.js';

function parameterScene() {
  return {
    format: 'newton-scene',
    version: 1,
    metricOrigin: { x: 0, y: 0 },
    environment: { gravity: { enabled: false, g: 9.81 } },
    bodies: [{
      id: 'mass',
      type: 'box',
      position: { x: 0, y: 0 },
      mass: 1,
      geometry: { width: 0.2, height: 0.2 },
      drivenApplied: true,
      parameters: {
        omega: { expression: '2pi(0.4 + 0.01t)', unit: 'rad/s' },
        gain: { expression: '2', unit: 'N' },
      },
      drivenAppliedForce: 'gain sin(omega t)',
      drivenAppliedPhaseParameter: 'omega',
    }],
    constraints: [],
  };
}

describe('named driven-force parameters', () => {
  it('accepts natural implicit multiplication with named variables', () => {
    const compiled = compileExpr('2omega + omega t', { variables: ['omega'] });
    expect(compiled.ok).toBe(true);
    expect(compiled.eval({ t: 3, omega: 4 })).toBe(20);
  });

  it('integrates a time-dependent omega into the force phase', () => {
    const engine = loadScene(parameterScene());
    const body = findBody(engine, 'mass');
    const expectedPhase = 2 * Math.PI * (0.4 + 0.005);

    expect(evaluateDrivenAppliedOmega(body, 1)).toBeCloseTo(2 * Math.PI * 0.41, 10);
    expect(evaluateDrivenAppliedForce(body, 1))
      .toBeCloseTo(2 * Math.sin(expectedPhase), 8);
  });

  it('persists named parameters and records current omega', () => {
    const engine = loadScene(parameterScene());
    const body = findBody(engine, 'mass');
    const out = serializeScene(engine);

    const outputBody = out.bodies.find(b => b.id === 'mass');
    expect(outputBody.parameters.omega.expression).toBe('2pi(0.4 + 0.01t)');
    expect(outputBody.drivenAppliedPhaseParameter).toBe('omega');
    const reloaded = loadScene(out);
    expect(evaluateDrivenAppliedOmega(findBody(reloaded, 'mass'), 1))
      .toBeCloseTo(2 * Math.PI * 0.41, 10);

    const recorder = new Recorder();
    recorder.start();
    recorder.capture(1, engine.bodies, engine.constraints);
    const frame = recorder.frames[0];
    const omega = frame.bodies.find(b => b.id === body.id).drivenAppliedOmega;
    const parameterValues = frame.bodies.find(b => b.id === body.id).drivenAppliedParameters;
    expect(omega).toBeCloseTo(2 * Math.PI * 0.41, 10);
    expect(parameterValues.omega).toBeCloseTo(2 * Math.PI * 0.41, 10);
    expect(sampleParameter(frame, body.id, 'omega')).toBeCloseTo(omega, 10);
    expect(graphObservablesForTrack({ drivenApplied: true }).some(o => o.id === 'omega')).toBe(false);
    expect(graphObservablesForBody(out, 'mass', { drivenApplied: true }).some(o => o.id === parameterObsId('omega'))).toBe(true);
  });

  it('nests parameters beneath their body in the object tree', () => {
    const engine = loadScene(parameterScene());
    const tree = buildObjectBrowserTree(engine);
    const mass = tree.roots.find(node => node.name === 'mass');
    expect(mass.icon).toBe('object');
    expect(mass.children.some(node => (
      node.kind === 'parameter'
      && node.parameterName === 'omega'
      && node.icon === 'parameter'
    ))).toBe(true);
  });

  it('can attach parameters to a force configured at runtime', () => {
    const engine = loadScene({
      format: 'newton-scene',
      version: 1,
      metricOrigin: { x: 0, y: 0 },
      environment: { gravity: { enabled: false, g: 9.81 } },
      bodies: [{ id: 'mass', type: 'box', position: { x: 0, y: 0 }, mass: 1 }],
      constraints: [],
    });
    const body = findBody(engine, 'mass');
    setDrivenAppliedParameters(body, { omega: { expression: 'pi' } });
    setDrivenAppliedForce(body, true);
    setDrivenAppliedPhaseParameter(body, 'omega');
    setDrivenAppliedForceExpr(body, 'sin(omega t)');
    expect(evaluateDrivenAppliedForce(body, 1)).toBeCloseTo(0, 10);
  });
});
