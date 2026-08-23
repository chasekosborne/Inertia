import { describe, it, expect } from 'vitest';
import { validateSceneDocument } from '../src/scene/validate.js';
import { SCENE_FORMAT, SCENE_VERSION } from '../src/scene/schema.js';
import { serializeScene, cloneSceneDocument } from '../src/scene/serialize.js';
import { deserializeScene } from '../src/scene/deserialize.js';
import { setMetricOriginEngine } from '../src/world-origin.js';
import { loadScene, findBody } from './helpers/sim.js';

const demoScenes = import.meta.glob('../demo/**/*.json', { eager: true, import: 'default' });

describe('scene validation', () => {
  it('accepts a minimal valid document', () => {
    const doc = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      meta: { name: 'test' },
      metricOrigin: { x: 0, y: 0 },
      bodies: [
        { id: 'a', type: 'anchor', position: { x: 0, y: 0 } },
        { id: 'b', type: 'ball', position: { x: 1, y: 0 } },
      ],
      constraints: [
        {
          id: 'rod',
          type: 'rod',
          bodyA: 'a',
          bodyB: 'b',
          length: 1,
        },
      ],
    };
    const result = validateSceneDocument(doc);
    expect(result.ok).toBe(true);
  });

  it('rejects unknown format and duplicate body ids', () => {
    expect(validateSceneDocument(null).ok).toBe(false);
    expect(validateSceneDocument({ format: 'bad' }).ok).toBe(false);

    const dup = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      bodies: [
        { id: 'x', type: 'anchor', position: { x: 0, y: 0 } },
        { id: 'x', type: 'ball', position: { x: 1, y: 0 } },
      ],
      constraints: [],
    };
    expect(validateSceneDocument(dup).ok).toBe(false);
  });

  it('requires positive spring stiffness', () => {
    const doc = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      bodies: [
        { id: 'a', type: 'anchor', position: { x: 0, y: 0 } },
        { id: 'b', type: 'ball', position: { x: 1, y: 0 } },
      ],
      constraints: [
        { id: 's', type: 'spring', bodyA: 'a', bodyB: 'b', k: 0 },
      ],
    };
    expect(validateSceneDocument(doc).ok).toBe(false);
  });
});

describe('demo scene files', () => {
  for (const [path, doc] of Object.entries(demoScenes)) {
    it(`validates ${path.replace('../demo/', '')}`, () => {
      const result = validateSceneDocument(doc);
      expect(result.ok, result.ok ? '' : /** @type {{ error: string }} */ (result).error).toBe(true);
    });
  }
});

describe('serialize / deserialize roundtrip', () => {
  it('preserves body ids and constraint topology for simple-pendulum', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-pendulum.json']);
    const engine = loadScene(doc);
    const round = serializeScene(engine, {
      meta: doc.meta,
      environment: doc.environment,
      measurements: doc.measurements,
    });

    expect(round.format).toBe(SCENE_FORMAT);
    expect(round.bodies.map(b => b.id).sort()).toEqual(doc.bodies.map(b => b.id).sort());
    expect(round.constraints.map(c => c.id).sort()).toEqual(doc.constraints.map(c => c.id).sort());

    const engine2 = loadScene(round);
    for (const bd of round.bodies) {
      expect(findBody(engine2, bd.id)).toBeTruthy();
    }
  });

  it('reloads deserialized state without losing dynamic bodies', () => {
    const doc = cloneSceneDocument(demoScenes['../demo/Classic/simple-harmonic-oscillator.json']);
    const engine = loadScene(doc);
    setMetricOriginEngine(engine);
    const snapshot = serializeScene(engine, { environment: doc.environment });

    const fresh = loadScene(snapshot);
    expect(findBody(fresh, 'mass')).toBeTruthy();
    expect(findBody(fresh, 'ground_floor')).toBeTruthy();
    expect(fresh.constraints.length).toBe(engine.constraints.length);
  });
});

describe('deserializeScene', () => {
  it('clears prior world state when loading a new document', () => {
    const pendulum = cloneSceneDocument(demoScenes['../demo/Classic/simple-pendulum.json']);
    const projectile = cloneSceneDocument(demoScenes['../demo/Classic/projectile-motion-2d.json']);
    const engine = loadScene(pendulum);
    deserializeScene(projectile, engine);
    expect(findBody(engine, 'bob')).toBeNull();
    expect(findBody(engine, 'point')).toBeTruthy();
  });
});
