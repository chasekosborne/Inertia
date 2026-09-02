import { describe, it, expect } from 'vitest';
import {
  parseDrivenSinusoid,
  formatDrivenSinusoid,
  paramsForScene,
  bodyDrivenForceFreqParam,
} from '../src/experiment/params.js';
import { metricsForScene, runSteadyAmplitudeX } from '../src/experiment/metrics.js';
import { ExperimentRunner } from '../src/experiment/runner.js';
import { cloneSceneDocument } from '../src/scene/serialize.js';
import { loadScene, runForSeconds, findBody } from './helpers/sim.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('driven sinusoid parse/format', () => {
  it('parses F0*sin(2*pi*f*t)', () => {
    expect(parseDrivenSinusoid('2*sin(2*pi*0.7*t)')).toEqual({ F0: 2, fHz: 0.7 });
    expect(parseDrivenSinusoid('2 * sin(2 * pi * 1.006 * t)')).toEqual({ F0: 2, fHz: 1.006 });
  });

  it('round-trips format', () => {
    const s = formatDrivenSinusoid(2, 1.01);
    expect(parseDrivenSinusoid(s)).toEqual({ F0: 2, fHz: 1.01 });
  });
});

describe('driven harmonic oscillator demo', () => {
  it('loads with driven applied force on the mass', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    expect(doc.meta.demoId).toBe('driven-harmonic-oscillator');
    const engine = loadScene(doc);
    const mass = findBody(engine, 'mass');
    expect(mass).toBeTruthy();
    expect(mass._drivenApplied).toBe(true);
    runForSeconds(engine, 0.5);
    expect(Math.abs(mass.velocity.x)).toBeGreaterThan(1e-6);
  });

  it('exposes drive frequency and steady amplitude for sweeps', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    const params = paramsForScene(doc);
    const metrics = metricsForScene(doc);
    const freq = params.find(p => p.id === 'body.mass.drivenApplied.freqHz');
    const amp = metrics.find(m => m.id === 'amp_x:mass');
    expect(freq?.preferred).toBe(true);
    expect(amp?.preferred).toBe(true);
    expect(freq.read(doc)).toBeCloseTo(0.4, 5);
  });

  it('resonance sweep peaks near natural frequency', async () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    const param = bodyDrivenForceFreqParam('mass', { preferred: true });
    const discardFrac = 0.65;
    const metric = {
      id: 'amp_x:mass',
      label: 'Aₓ (steady)',
      unit: 'm',
      kind: 'resonance',
      bodyId: 'mass',
      tMax: 18,
      discardFrac,
      compute(ctx) {
        return runSteadyAmplitudeX(ctx.engine, 'mass', ctx.tMax, { discardFrac });
      },
    };

    const runner = new ExperimentRunner();
    const points = await runner.runSweep({
      baseline: doc,
      param,
      metric,
      min: 0.5,
      max: 1.5,
      count: 11,
    });

    expect(points.length).toBeGreaterThanOrEqual(9);
    let best = points[0];
    for (const p of points) {
      if (p.y > best.y) best = p;
    }
    // f₀ = √40 / (2π) ≈ 1.006 Hz
    expect(best.x).toBeGreaterThan(0.85);
    expect(best.x).toBeLessThan(1.15);
    expect(best.y).toBeGreaterThan(0.05);
  }, 120_000);
});
