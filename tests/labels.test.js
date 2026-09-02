import { describe, it, expect } from 'vitest';
import { readLabelProperty, resolveLabelText } from '../src/editor/labels.js';

describe('live label property values', () => {
  const engine = {
    bodies: [{
      label: 'mass',
      mass: 1,
      _drivenAppliedExpr: '2*sin(2*pi*0.7*t)',
      _appliedForce: { F: 3, thetaDeg: 45 },
    }],
  };

  it('reads stable body property paths', () => {
    const body = engine.bodies[0];
    expect(readLabelProperty(body, 'mass')).toBe(1);
    expect(readLabelProperty(body, 'appliedForce.F')).toBe(3);
    expect(readLabelProperty(body, 'drivenAppliedForce')).toBe('2*sin(2*pi*0.7*t)');
  });

  it('replaces bound values and renders drive expressions as LaTeX', () => {
    const label = {
      text: 'F(t) = {{value}}',
      valueBinding: {
        body: 'mass',
        property: 'drivenAppliedForce',
        format: 'latex',
      },
    };
    expect(resolveLabelText(label, engine))
      .toBe('F(t) = 2\\cdot \\sin(2\\cdot \\pi\\cdot 0.7\\cdot t)');
  });

  it('supports direct body.property placeholders', () => {
    expect(resolveLabelText(
      { text: 'm = {{mass.mass}} kg' },
      engine,
    )).toBe('m = 1 kg');
  });

  it('appends a bound value when the template has no value token', () => {
    expect(resolveLabelText(
      { text: 'mass', valueBinding: { body: 'mass', property: 'mass' } },
      engine,
    )).toBe('mass 1');
  });

  it('resolves the current angular frequency at simulation time', () => {
    const body = {
      ...engine.bodies[0],
      _newtonType: 'box',
      _drivenApplied: true,
      isStatic: false,
      _drivenAppliedFrequencyFn: ({ t }) => 0.7 + 0.2 * t,
    };
    const liveEngine = { simTime: 2, bodies: [body] };
    expect(resolveLabelText({
      text: 'ω(t) = {{value}} rad/s',
      valueBinding: { body: 'mass', property: 'drivenAppliedOmega' },
    }, liveEngine)).toBe('ω(t) = 6.9115 rad/s');
  });

  it('shows instantaneous parameter input instead of integrated phase', () => {
    const body = {
      label: 'mass',
      _newtonType: 'box',
      _drivenAppliedPhaseParameter: 'omega',
      _drivenAppliedParameterFns: {
        omega: { eval: ({ t }) => 2 * Math.PI * (0.4 + 0.01 * t), dependencies: [] },
      },
    };
    expect(resolveLabelText({
      text: 'ω(t) = {{value}}',
      valueBinding: { body: 'mass', property: 'drivenAppliedOmega' },
    }, { simTime: 1, bodies: [body] })).toBe('ω(t) = 2.5761');
  });
});
