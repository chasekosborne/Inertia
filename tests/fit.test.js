import { describe, it, expect } from 'vitest';
import { fit, sampleFit, FitError, FIT_MODELS } from '../src/fit/index.js';

describe('curve fitting', () => {
  it('exposes all expected models', () => {
    const ids = FIT_MODELS.map(m => m.id);
    expect(ids).toEqual([
      'linear', 'polynomial', 'exponential', 'logarithmic', 'power', 'sinusoidal',
    ]);
  });

  it('fits a line to noiseless data', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 2.5 * i - 1 }));
    const result = fit(pts, 'linear');
    expect(result.params.m).toBeCloseTo(2.5, 6);
    expect(result.params.b).toBeCloseTo(-1, 6);
    expect(result.r2).toBeCloseTo(1, 10);
  });

  it('fits a quadratic polynomial', () => {
    const pts = Array.from({ length: 12 }, (_, i) => {
      const x = i * 0.3 - 1.5;
      return { x, y: 0.5 * x * x - 2 * x + 1 };
    });
    const result = fit(pts, 'polynomial', { degree: 2 });
    expect(result.params.a2).toBeCloseTo(0.5, 2);
    expect(result.params.a1).toBeCloseTo(-2, 2);
    expect(result.params.a0).toBeCloseTo(1, 2);
    expect(result.r2).toBeGreaterThan(0.999);
  });

  it('fits exponential y = A e^(kx)', () => {
    const pts = Array.from({ length: 8 }, (_, i) => {
      const x = i * 0.4;
      return { x, y: 3 * Math.exp(0.7 * x) };
    });
    const result = fit(pts, 'exponential');
    expect(result.params.A).toBeCloseTo(3, 2);
    expect(result.params.k).toBeCloseTo(0.7, 2);
  });

  it('samples a fit over an interval', () => {
    const result = fit([[0, 0], [1, 2], [2, 4]], 'linear');
    const samples = sampleFit(result, 0, 2, 3);
    expect(samples).toHaveLength(3);
    expect(samples[0].v).toBeCloseTo(0, 6);
    expect(samples[2].v).toBeCloseTo(4, 6);
  });

  it('throws on insufficient points', () => {
    expect(() => fit([[0, 0]], 'linear')).toThrow(FitError);
    expect(() => fit([[0, 0], [1, 1], [2, 2]], 'sinusoidal')).toThrow(FitError);
  });
});
