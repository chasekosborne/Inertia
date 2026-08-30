import { describe, it, expect } from 'vitest';
import { Recorder } from '../src/recorder/recorder.js';
import { isDrivenAppliedForce } from '../src/physics/applied-force.js';
import { isDrivenPivot } from '../src/physics/driven-pivot.js';
import { sampleObservable, buildSeries, graphObservablesForTrack } from '../src/editor/graph-panel.js';
import { cloneSceneDocument } from '../src/scene/serialize.js';
import { loadScene, runForSeconds, findBody } from './helpers/sim.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('recorded drive observables', () => {
  it('records and plots Fapp for driven applied force', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    const mass = findBody(engine, 'mass');
    expect(isDrivenAppliedForce(mass)).toBe(true);

    const rec = new Recorder();
    rec.start();
    engine.onStep(t => rec.capture(t, engine.bodies, engine.constraints));
    runForSeconds(engine, 0.5);

    expect(rec.frames.length).toBeGreaterThan(10);
    const withF = rec.frames.filter(f => {
      const b = f.bodies.find(x => x.id === mass.id);
      return b?.drivenApplied === true && Number.isFinite(b.drivenAppliedF);
    });
    expect(withF.length).toBeGreaterThan(5);

    const series = buildSeries(rec.frames, mass.id, 'Fapp');
    expect(series.length).toBeGreaterThan(5);
    expect(series.some(p => Math.abs(p.v) > 0.1)).toBe(true);
    expect(graphObservablesForTrack({ drivenApplied: true }).some(o => o.id === 'Fapp')).toBe(true);
  });

  it('records and plots tau for driven pivot', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/angular-driven-pendulum.json']);
    const engine = loadScene(doc);
    const pivot = findBody(engine, 'anchor_1');
    expect(isDrivenPivot(pivot)).toBe(true);

    const rec = new Recorder();
    rec.start();
    engine.onStep(t => rec.capture(t, engine.bodies, engine.constraints));
    runForSeconds(engine, 0.5);

    const withTau = rec.frames.filter(f => {
      const b = f.bodies.find(x => x.id === pivot.id);
      return b?.driven === true && Number.isFinite(b.drivenTorque);
    });
    expect(withTau.length).toBeGreaterThan(5);

    expect(sampleObservable(withTau[5], pivot.id, 'tau')).not.toBeNull();
    const series = buildSeries(rec.frames, pivot.id, 'tau');
    expect(series.length).toBeGreaterThan(5);
    expect(series.some(p => Math.abs(p.v) > 0.05)).toBe(true);
    expect(graphObservablesForTrack({ drivenTorque: true }).some(o => o.id === 'tau')).toBe(true);
  });
});
