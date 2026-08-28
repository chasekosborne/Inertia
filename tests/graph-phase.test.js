import { describe, it, expect } from 'vitest';
import { splitSeriesAtPeriodicJumps, sampleObservable, buildSeries, graphObservablesForTrack } from '../src/ui/graph-panel.js';

describe('splitSeriesAtPeriodicJumps', () => {
  it('splits at wrapped θ jumps on the y axis', () => {
    const series = [
      { t: 0, v: 3.0 },
      { t: 0.1, v: 3.1 },
      { t: 0.2, v: -3.1 },
      { t: 0.3, v: -3.0 },
    ];
    const segs = splitSeriesAtPeriodicJumps(series, { yPeriod: 2 * Math.PI });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[1]).toHaveLength(2);
  });

  it('keeps a continuous unwrapped series intact', () => {
    const series = [
      { t: 0, v: 0 },
      { t: 1, v: 1 },
      { t: 2, v: 2 },
    ];
    const segs = splitSeriesAtPeriodicJumps(series, { yPeriod: 2 * Math.PI });
    expect(segs).toHaveLength(1);
    expect(segs[0]).toHaveLength(3);
  });
});

describe('driven applied force observable', () => {
  it('exposes Fapp only when requested', () => {
    expect(graphObservablesForTrack(false).some(o => o.id === 'Fapp')).toBe(false);
    expect(graphObservablesForTrack(true).some(o => o.id === 'Fapp')).toBe(true);
  });

  it('samples signed F_app from recorded frames', () => {
    const frames = [
      { t: 0, bodies: [{ id: 7, x: 0, y: 0, vx: 0, vy: 0, mass: 1, drivenApplied: true, drivenAppliedF: 0 }] },
      { t: 0.25, bodies: [{ id: 7, x: 0, y: 0, vx: 0, vy: 0, mass: 1, drivenApplied: true, drivenAppliedF: 5 }] },
      { t: 0.5, bodies: [{ id: 7, x: 0, y: 0, vx: 0, vy: 0, mass: 1, drivenApplied: true, drivenAppliedF: -2 }] },
      { t: 0.75, bodies: [{ id: 7, x: 0, y: 0, vx: 0, vy: 0, mass: 1, drivenApplied: false, drivenAppliedF: null }] },
    ];
    expect(sampleObservable(frames[1], 7, 'Fapp')).toBeCloseTo(5, 10);
    expect(sampleObservable(frames[2], 7, 'Fapp')).toBeCloseTo(-2, 10);
    expect(sampleObservable(frames[3], 7, 'Fapp')).toBeNull();
    const series = buildSeries(frames, 7, 'Fapp');
    expect(series.map(p => p.v)).toEqual([0, 5, -2]);
  });
});

describe('driven pivot torque observable', () => {
  it('exposes tau only when requested', () => {
    expect(graphObservablesForTrack({}).some(o => o.id === 'tau')).toBe(false);
    expect(graphObservablesForTrack({ drivenTorque: true }).some(o => o.id === 'tau')).toBe(true);
  });

  it('samples signed τ from recorded frames', () => {
    const frames = [
      { t: 0, bodies: [{ id: 3, type: 'anchor', x: 0, y: 0, vx: 0, vy: 0, mass: 1, driven: true, drivenTorque: 0 }] },
      { t: 0.25, bodies: [{ id: 3, type: 'anchor', x: 0, y: 0, vx: 0, vy: 0, mass: 1, driven: true, drivenTorque: 0.5 }] },
      { t: 0.5, bodies: [{ id: 3, type: 'anchor', x: 0, y: 0, vx: 0, vy: 0, mass: 1, driven: true, drivenTorque: -0.2 }] },
      { t: 0.75, bodies: [{ id: 3, type: 'anchor', x: 0, y: 0, vx: 0, vy: 0, mass: 1, driven: false, drivenTorque: null }] },
    ];
    expect(sampleObservable(frames[1], 3, 'tau')).toBeCloseTo(0.5, 10);
    expect(sampleObservable(frames[2], 3, 'tau')).toBeCloseTo(-0.2, 10);
    expect(sampleObservable(frames[3], 3, 'tau')).toBeNull();
    const series = buildSeries(frames, 3, 'tau');
    expect(series.map(p => p.v)).toEqual([0, 0.5, -0.2]);
  });
});
