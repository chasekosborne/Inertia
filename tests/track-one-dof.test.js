import { describe, it, expect } from 'vitest';
import { trackIsOneDof } from '../src/editor/graph-panel.js';
import { loadScene, findBody } from './helpers/sim.js';
import { cloneSceneDocument } from '../src/scene/serialize.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('trackIsOneDof', () => {
  it('recognizes a horizontal spring–mass as 1-DOF', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    const mass = findBody(engine, 'mass');
    expect(mass._lockRotation).toBe(true);
    expect(trackIsOneDof(engine, mass.id)).toBe(true);
  });

  it('recognizes the driven harmonic oscillator mass as 1-DOF', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/driven-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    const mass = findBody(engine, 'mass');
    expect(trackIsOneDof(engine, mass.id)).toBe(true);
  });
});
