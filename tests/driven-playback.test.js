import { describe, it, expect } from 'vitest';
import { cloneSceneDocument } from '../src/scene/serialize.js';
import { Recorder } from '../src/recorder/recorder.js';
import { Playback } from '../src/recorder/playback.js';
import { collectDrivenAppForces } from '../src/physics/driven-pivot.js';
import { collectDrivenAppliedAppForces } from '../src/physics/applied-force.js';
import { loadScene, runForSeconds, findBody } from './helpers/sim.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('driven drive display in playback', () => {
  it('restores pivot glyph angle and F_app when scrubbing', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/angular-driven-pendulum.json']);
    const engine = loadScene(doc);
    const pivot = findBody(engine, 'anchor_1');
    const bob = findBody(engine, 'bob');
    expect(pivot).toBeTruthy();
    expect(bob).toBeTruthy();

    const recorder = new Recorder();
    recorder.start();
    engine.onStep((t) => {
      recorder.capture(t, engine.bodies, engine.constraints);
    });
    runForSeconds(engine, 0.8);
    recorder.stop();
    engine.pause();

    expect(recorder.frameCount).toBeGreaterThan(10);

    const mid = Math.floor(recorder.frameCount / 2);
    const midSnap = recorder.frames[mid].bodies.find(b => b.id === pivot.id);
    expect(Number.isFinite(midSnap.drivenVisualAngle)).toBe(true);
    expect(midSnap.driven).toBe(true);
    expect(Number.isFinite(midSnap.drivenTorque)).toBe(true);

    const playback = new Playback(recorder, engine);
    playback.seek(mid);

    expect(pivot._drivenVisualAngle).toBeCloseTo(midSnap.drivenVisualAngle, 10);
    expect(pivot._drivenTorqueLast).toBeCloseTo(midSnap.drivenTorque, 10);

    const forces = collectDrivenAppForces(engine);
    const f = forces.get(bob.id);
    // Non-zero torque at mid frame should produce a visible F_app on the bob.
    if (Math.abs(midSnap.drivenTorque) > 1e-6) {
      expect(f).toBeTruthy();
      expect(f.F).toBeGreaterThan(0);
    }

    // Scrubbing to start should move the glyph, not leave it stuck at the end.
    const startSnap = recorder.frames[0].bodies.find(b => b.id === pivot.id);
    playback.seek(0);
    expect(pivot._drivenVisualAngle).toBeCloseTo(startSnap.drivenVisualAngle, 10);
  });

  it('restores driven applied F_app when scrubbing', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    const body = engine.bodies.find(b => !b.isStatic && b._newtonType !== 'metric-basis' && b._drivenApplied);
    expect(body).toBeTruthy();

    const recorder = new Recorder();
    recorder.start();
    engine.onStep((t) => {
      recorder.capture(t, engine.bodies, engine.constraints);
    });
    runForSeconds(engine, 0.6);
    recorder.stop();
    engine.pause();

    const mid = Math.floor(recorder.frameCount / 2);
    const midSnap = recorder.frames[mid].bodies.find(b => b.id === body.id);
    expect(midSnap.drivenApplied).toBe(true);
    expect(Number.isFinite(midSnap.drivenAppliedF)).toBe(true);

    const playback = new Playback(recorder, engine);
    playback.seek(mid);

    expect(body._drivenAppliedLastF).toBeCloseTo(midSnap.drivenAppliedF, 10);
    const f = collectDrivenAppliedAppForces(engine).get(body.id);
    if (Math.abs(midSnap.drivenAppliedF) > 1e-6) {
      expect(f).toBeTruthy();
      expect(f.F).toBeCloseTo(Math.abs(midSnap.drivenAppliedF), 6);
    }
  });
});
