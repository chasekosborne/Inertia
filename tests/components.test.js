import { describe, it, expect } from 'vitest';
import { migrateBodyV1ToComponents, migratedToV2Body, detectOptionalComponentsV1 } from '../src/scene/migrate-v1-to-v2.js';
import { ensureEntity, hasComponent } from '../src/components/entity.js';
import {
  getArchetypeComponents,
  getInspectorFieldsForArchetype,
} from '../src/components/registry.js';
import { buildInspectorHtml, annotatePropertySections } from '../src/components/inspector.js';
import {
  attachProperty,
  detachProperty,
  listAttachableProperties,
  attachCoreComponents,
} from '../src/components/optional-properties.js';
import { getInspectorFields } from '../src/components/registry.js';
import { createBox, createGround, setMaterialFriction } from '../src/physics/bodies.js';
import { loadScene } from './helpers/sim.js';
import { SCENE_FORMAT, SCENE_VERSION } from '../src/scene/schema.js';
import { Entity } from '../src/components/entity.js';
import Matter from 'matter-js';
import { applyCoulombFriction, geomMeanMu } from '../src/physics/friction.js';

const { Body } = Matter;

describe('v1 → component migration', () => {
  it('maps a box scene body to core components only', () => {
    const migrated = migrateBodyV1ToComponents({
      id: 'crate',
      type: 'box',
      position: { x: 1, y: 2 },
      velocity: { vx: 0.5, vy: -0.3 },
      mass: 2,
      geometry: { width: 0.4, height: 0.2 },
    });

    expect(migrated).toBeTruthy();
    expect(migrated.archetype).toBe('box');
    expect(migrated.components.transform.position).toEqual({ x: 1, y: 2 });
    expect(migrated.components.shape).toEqual({ kind: 'box', width: 0.4, height: 0.2 });
    expect(migrated.components.rigidBody).toEqual({ mass: 2, isStatic: false });
    expect(migrated.optional.surfaceFriction).toBeUndefined();
  });

  it('detects optional surfaceFriction when muK > 0', () => {
    const optional = detectOptionalComponentsV1({
      id: 'b',
      type: 'box',
      position: { x: 0, y: 0 },
      material: { muK: 0.4, muS: 0.4, restitution: 0 },
    });
    expect(optional.surfaceFriction).toEqual({ muK: 0.4, muS: 0.4 });
    expect(optional.restitution).toEqual({ restitution: 0 });
  });

  it('does not attach surfaceFriction when muK and muS are zero', () => {
    const optional = detectOptionalComponentsV1({
      id: 'b',
      type: 'ball',
      position: { x: 0, y: 0 },
      material: { muK: 0, muS: 0, restitution: 0 },
    });
    expect(optional.surfaceFriction).toBeUndefined();
    expect(optional.restitution).toEqual({ restitution: 0 });
  });

  it('produces v2-style body records', () => {
    const migrated = migrateBodyV1ToComponents({
      id: 'b',
      type: 'ball',
      position: { x: 0, y: 0 },
      geometry: { radius: 0.1 },
    });
    const v2 = migratedToV2Body(migrated);
    expect(v2.id).toBe('b');
    expect(v2.archetype).toBe('ball');
    expect(v2.components.shape.kind).toBe('circle');
  });
});

describe('deserialize attaches components', () => {
  it('loads v1 scene bodies with core component sets', () => {
    const doc = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      meta: { name: 'box-test' },
      metricOrigin: { x: 0, y: 0 },
      bodies: [
        {
          id: 'block',
          type: 'box',
          position: { x: 0, y: 1 },
          geometry: { width: 0.2, height: 0.2 },
          mass: 1,
        },
      ],
      constraints: [],
    };
    const engine = loadScene(doc);
    const body = engine.bodies.find(b => b.label === 'block');
    expect(body).toBeTruthy();
    expect(body._archetype).toBe('box');
    expect(hasComponent(body, 'transform')).toBe(true);
    expect(hasComponent(body, 'shape')).toBe(true);
    expect(hasComponent(body, 'rigidBody')).toBe(true);
    expect(hasComponent(body, 'surfaceFriction')).toBe(false);
  });

  it('attaches lockRotation when scene material requests it on a box', () => {
    const doc = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      meta: { name: 'lock-rotation-test' },
      metricOrigin: { x: 0, y: 0 },
      bodies: [
        {
          id: 'block',
          type: 'box',
          position: { x: 0, y: 0 },
          geometry: { width: 0.2, height: 0.2 },
          mass: 1,
          material: { lockRotation: true },
        },
      ],
      constraints: [],
    };
    const engine = loadScene(doc);
    const body = engine.bodies.find(b => b.label === 'block');
    expect(hasComponent(body, 'lockRotation')).toBe(true);
    expect(body._lockRotation).toBe(true);
    expect(body.inertia).toBe(Infinity);
  });

  it('attaches surfaceFriction when demo specifies muK > 0', () => {
    const doc = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      meta: { name: 'friction-test' },
      metricOrigin: { x: 0, y: 0 },
      bodies: [
        {
          id: 'block',
          type: 'box',
          position: { x: 0, y: 0 },
          geometry: { width: 0.2, height: 0.2 },
          mass: 1,
          material: { muK: 0.4, muS: 0.4, restitution: 0 },
        },
      ],
      constraints: [],
    };
    const engine = loadScene(doc);
    const body = engine.bodies.find(b => b.label === 'block');
    expect(hasComponent(body, 'surfaceFriction')).toBe(true);
    expect(body._muK).toBeCloseTo(0.4, 3);
  });
});

describe('optional properties', () => {
  it('new box has zero friction and no surfaceFriction component', () => {
    const body = createBox(100, 100);
    attachCoreComponents(body);
    expect(body._muK ?? body.friction).toBe(0);
    expect(hasComponent(body, 'surfaceFriction')).toBe(false);
  });

  it('attachProperty surfaceFriction sets mu; detach zeros mu', () => {
    const body = createBox(100, 100);
    attachCoreComponents(body);
    attachProperty(body, 'surfaceFriction');
    expect(hasComponent(body, 'surfaceFriction')).toBe(true);
    expect(body._muK).toBeGreaterThan(0);
    detachProperty(body, 'surfaceFriction');
    expect(hasComponent(body, 'surfaceFriction')).toBe(false);
    expect(body._muK ?? body.friction).toBe(0);
  });

  it('listAttachableProperties excludes attached components', () => {
    const body = createBox(100, 100);
    attachCoreComponents(body);
    const entity = Entity.fromBody(body);
    const before = listAttachableProperties(entity).map(d => d.id);
    expect(before).toContain('surfaceFriction');
    attachProperty(body, 'surfaceFriction');
    const after = listAttachableProperties(Entity.fromBody(body)).map(d => d.id);
    expect(after).not.toContain('surfaceFriction');
  });
});

describe('friction pairing', () => {
  it('geomMeanMu is zero when either surface is frictionless', () => {
    expect(geomMeanMu(0, 0.4)).toBe(0);
    expect(geomMeanMu(0.4, 0)).toBe(0);
  });

  it('geomMeanMu is non-zero when both surfaces have friction', () => {
    expect(geomMeanMu(0.4, 0.4)).toBeCloseTo(0.4, 6);
  });

  it('skips Coulomb friction when only one body has mu > 0', () => {
    const ground = createGround(200, 300, 400, 20, { muK: 0.4, muS: 0.4 });
    const box = createBox(200, 250, { muK: 0, muS: 0 });
    attachCoreComponents(box);
    setMaterialFriction(ground, 0.4, 0.4);

    Body.setVelocity(box, { x: 0.5, y: 0 });
    const gravity = { x: 0, y: 1, scale: 0.001 };
    const applied = applyCoulombFriction([ground, box], gravity, []);
    expect(applied).toBe(false);
  });
});

describe('box metadata inspector', () => {
  it('lists expected core field keys for box archetype', () => {
    const fields = getInspectorFieldsForArchetype('box');
    const keys = fields.map(f => f.key);
    expect(keys).toContain('x');
    expect(keys).toContain('width');
    expect(keys).toContain('mass');
    expect(keys).not.toContain('muK');
    expect(keys).not.toContain('restitution');
  });

  it('renders HTML without friction fields when no optional properties attached', () => {
    const body = createBox(100, 200, { mass: 1, width: 40, height: 30 });
    body.label = 'test-box';
    attachCoreComponents(body);
    const entity = ensureEntity(body);
    const html = buildInspectorHtml('Box', getInspectorFieldsForArchetype('box'), {
      entity,
      body,
      push: () => {},
      snapOn: () => false,
      extras: { shapeKind: 'box' },
    });

    expect(html).toContain('prop-x');
    expect(html).toContain('prop-mass');
    expect(html).not.toContain('prop-muk');
    expect(html).not.toContain('prop-rest');
    expect(html).toContain('prop-add-property');
    expect(html).toContain('<span class="math">');
    expect(html).not.toContain('&lt;span class=&quot;math&quot;&gt;');
    const addIdx = html.indexOf('prop-add-property');
    const posIdx = html.indexOf('prop-x');
    expect(addIdx).toBeGreaterThan(-1);
    expect(posIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(posIdx);
  });

  it('renders remove control and math labels for attached optional properties', () => {
    const body = createBox(100, 200, { mass: 1, width: 40, height: 30 });
    body.label = 'test-box';
    attachCoreComponents(body);
    attachProperty(body, 'surfaceFriction');
    const entity = ensureEntity(body);
    const fields = annotatePropertySections(getInspectorFieldsForArchetype('box').concat(
      getInspectorFields(entity).filter(f => f.group === 'Surface friction'),
    ), entity);
    const html = buildInspectorHtml('Box', fields, {
      entity,
      body,
      push: () => {},
      snapOn: () => false,
      extras: {
        shapeKind: 'box',
        canDetach: () => true,
      },
    });

    expect(html).toContain('data-detach="surfaceFriction"');
    expect(html).toContain('<span class="math">μ<sub>s</sub></span>');
    expect(html).not.toContain('&lt;span class=&quot;math&quot;&gt;');
  });

  it('box archetype registers three core components', () => {
    expect(getArchetypeComponents('box')).toEqual([
      'transform', 'shape', 'rigidBody',
    ]);
  });
});
