# Component architecture

Inertia uses a **pragmatic component model**: entities wrap Matter.js bodies with
optional property components defined as data + adapters.

## Layout

```
src/components/
  registry.js           registerComponent(), archetypes, getInspectorFields()
  entity.js             Entity wrapper, attachComponent()
  optional-properties.js attachProperty(), detachProperty(), listAttachableProperties()
  metadata.js           InspectorField schema
  inspector.js            Generic DOM renderer + "+ Add property" UI
  parameter-registry.js discoverIdentifiers() for drive expressions
  types/
    transform.js        position
    shape.js            geometry (box / circle / wedge kinds)
    rigid-body.js       mass, anchored
    surface-friction.js optional μₛ, μₖ
    restitution.js      optional bounce
    sticky-contact.js   optional weld-on-touch
    lock-rotation.js    optional spin lock (round bodies)
    applied-force-component.js
    applied-torque-component.js
```

## Core vs optional

**Always attached** (per archetype): `transform`, `shape`, `rigidBody` (dynamic types).

**Optional** (via "+ Add property" in the properties panel):

| Property | Effect |
|----------|--------|
| `surfaceFriction` | Sets body μₛ/μₖ; friction engages only when **both** contacting bodies have this property (geometric mean in `friction.js`) |
| `restitution` | Bounce coefficient on collision |
| `stickyContact` | Weld on contact |
| `lockRotation` | Prevent spinning (point-mass / ball) |
| `appliedForce` | Constant or F(t) drive |
| `appliedTorque` | Constant τ |

New palette bodies start with **zero friction and no optional material properties**.

## Friction pairing

Coulomb friction uses `geomMeanMu(μₐ, μᵦ)`. If either surface has μ = 0 (no
`surfaceFriction` property), the pair skips friction entirely.

## v1 migration

`migrate-v1-to-v2.js` attaches optional properties only when v1 scene fields
indicate them (e.g. `muK > 0` → `surfaceFriction`, `restitution != null` →
`restitution`). Demos load unchanged.

## Extension

1. Create `types/your-property.js` with `optional: true`, `attach`, `detach`, `inspectorFields`.
2. `registerComponent()` in `registry.js`.
3. Add compatibility rules in `optional-properties.js` `canAttachProperty()`.
