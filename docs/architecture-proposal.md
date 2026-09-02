# Architecture

## Goals

1. **Composable objects** — users attach properties (material, forces, sticky, appearance, …) to entities; toolbox items are presets, not hard types.
2. **Stable identity** — app entity IDs outlive Matter body IDs, undo rebuilds, and welds (graphs/selection already need this).
3. **Layer isolation** — physics and scene logic do not import DOM, panels, or file/export code; UI and I/O talk to the core through a narrow API.
4. **One authoritative edit document** — setup/undo/save share the same scene shape; Matter and recorder frames are derived runtimes.

---

## Layer model

```
┌─────────────────────────────────────────────────────────────┐
│  app/          bootstrap, modes (setup | live | review)     │
├─────────────────┬───────────────────────┬───────────────────┤
│  editor/ (UI)   │  core/                │  io/              │
│  panels, tools, │  domain + sim         │  files, clipboard,│
│  handles, SVG   │  entities/components  │  export, demos,   │
│  live view      │  systems, Matter bridge│  recorder media   │
└────────┬────────┴──────────┬────────────┴─────────┬─────────┘
         │  commands/queries │                      │
         └───────────────────┴──────────────────────┘
                   scene document (JSON)
```

| Layer | May depend on | Must not depend on |
|-------|---------------|--------------------|
| **core** | units, pure math, Matter (behind a bridge) | DOM, `index.html`, panels, file pickers, muxers |
| **editor (UI)** | core public API, shared draw helpers | file system, network, codec details |
| **io** | core document types + serialize helpers | interaction handlers, property panels |
| **app** | all layers (composition root only) | — |

**Working elements** = `core/` (domain model + simulation systems). Everything else is a client of that core.

---

## Entity / component model

### Entities

Stable string IDs owned by the app. Matter IDs are an implementation detail of the bridge.

### Components (data only)

Suggested families (evolve as needed):

| Component | Role |
|-----------|------|
| `Transform` | position, angle |
| `Motion` | linear / angular velocity |
| `RigidBody` | mass, anchored/static, lock rotation |
| `Collider` | shape params (circle, box, wedge, ground, …) |
| `Material` | restitution, μₖ, μₛ, … |
| `Forces` | applied force / torque; air-drag flags |
| `Sticky` | stick-on-contact |
| `Appearance` | fill, stroke, hollow, display name |
| `Rope` / `RopeSegment` | aggregate membership + rest lengths |
| `ConstraintRef` | spring / rod endpoints and params (or constraint entities) |
| `Membership` | UI folder / weld group |

Bodies are no longer “a box type with optional fields.” A box preset is an entity that *has* `Collider.box` + defaults for `Material`, `RigidBody`, etc. The user can add or edit `Material` on any eligible entity without going through a toolbox type.

### Archetypes (toolbox presets)

Named recipes that spawn component sets (and child entities for ropes):

- `point-mass`, `ball`, `box`, `wedge`, `anchor`, `ground`
- `rod`, `spring`, `rope` (multi-entity)
- Demo / blank scenes = documents built from the same archetypes

Palette buttons call `spawn(archetype, pose)`, not `createBox(...)` directly.

### Systems (behavior)

Scheduled passes over component queries — largely what already lives as modules under `src/physics/`:

- integrate / Matter step (bridge)
- applied force & torque
- air drag
- springs / rods
- rope PBD
- Coulomb friction
- sticky welds
- energy bookkeeping

UI never schedules these; `sim` does.

---

## Directory structure

```
src/
  app/                          # composition root (thin)
    bootstrap.js                # wire core ↔ editor ↔ io
    modes.js                    # setup | live | review
    main.js                     # entry; shrink toward bootstrap only

  core/                         # WORKING ELEMENTS (no DOM, no file I/O)
    domain/
      ids.js
      components/               # schemas, defaults, validators
        transform.js
        rigid-body.js
        collider.js
        material.js
        forces.js
        appearance.js
        …
      archetypes/               # toolbox + fragment presets
        bodies.js
        constraints.js
        rope.js
      queries.js                # listDynamics, ropeMembers, …
      commands.js               # spawn, setComponent, remove, attachConstraint
    scene/                      # document types + pure convert
      schema.js                 # newton-scene format (component-oriented)
      document.js               # createBlank, migrate version
      from-world.js             # runtime → document (serialize)
      to-world.js               # document → runtime (deserialize)
      validate.js
    sim/
      world.js                  # entity store + component maps
      engine.js                 # step loop, system order
      matter-bridge.js          # sync entities ↔ Matter bodies
      systems/
        applied-force.js
        applied-torque.js
        air-drag.js
        friction.js
        rope.js
        sticky.js
        springs.js
        energy.js
        …

  editor/                       # UI ONLY (DOM + pointer + panels)
    selection.js
    history-host.js             # pushes core snapshots / command log
    tools/
      palette-placement.js
      interaction.js            # modes: select, ground, rod, rope, …
    properties/                 # one module per component family
      material-panel.js
      rigid-body-panel.js
      forces-panel.js
      rope-panel.js
      constraint-panel.js
      environment-panel.js
      index.js                  # registers panels for selection
    handles/
    object-browser.js
    measurements/
    labels/
    graph/
    timeline/
    camera/
    view/                       # live SVG; read-only over world
      draw/                     # shared textbook primitives (also used by io export)
      svg-renderer.js
      spring-path.js
    chrome/                     # shortcuts, toast, theme bindings

  io/                           # I/O ONLY (files, clipboard, export codecs)
    scene-file.js               # open / save / download JSON
    clipboard.js                # system + internal object clipboard
    demos.js                    # load demo documents from /demo
    export/
      svg-exporter.js           # uses editor/view/draw (or core poses + draw)
      mp4-exporter.js
      graph-video.js
      desmos.js
      export-controls.js        # dialog OK here; encoding stays in io
    record/
      recorder.js               # frame capture API
      playback.js
      replay-bodies.js

  shared/                       # cross-cutting, still UI/I/O-agnostic
    units.js
    grid.js
    theme.js                    # tokens only; DOM application stays in editor
    math-text.js
    world-origin.js
```

### Mapping from today (rough)

| Current | Proposed |
|---------|----------|
| `src/physics/*` | `core/sim/` (+ domain pieces pulled out of `bodies.js`) |
| `src/scene/*` | `core/scene/` (+ `io/scene-file`, `io/clipboard`, `io/demos`) |
| `src/presets.js` / `scene/presets.js` | `core/domain/archetypes/` + blank document helper |
| `src/editor/*` | `editor/` |
| `src/renderer/*` | `editor/view/` |
| `src/exporter/*`, `src/export/*` | `io/export/` |
| `src/recorder/*` | `io/record/` |
| `src/main.js` | `app/` (thin) |
| `src/history.js` | driven by `core` snapshots; host glue in `editor/` or `app/` |
| `src/experiment/*`, `src/fit/*` | stay as analysis clients of core (later: `analysis/`) |

---

## Separating UI and I/O from the core

### Core public surface

Something small and intentional, e.g.:

- **Queries** — `getEntity`, `query('Material', 'Collider')`, `listBrowsable`, rope members  
- **Commands** — `spawn`, `setComponent`, `removeEntity`, `addConstraint`, `setEnvironment`  
- **Lifecycle** — `loadDocument`, `toDocument`, `play`, `pause`, `step`, `resetFromDocument`  
- **Events** — `onStep`, `onWeld`, `onWorldChanged` (for selection/graph retargeting)

Editor and I/O may call this API. They should not reach into Matter bodies or underscore fields.

### UI responsibilities

- Selection, tools, property widgets, handles, object browser  
- Live SVG view and editor chrome  
- Translate pointer gestures into **commands** (not Matter mutations)  
- Subscribe to world events to refresh panels  

### I/O responsibilities

- Read/write scene JSON (File API, download, demo fetch)  
- Clipboard payload encode/decode (payload = document fragments)  
- Recording frames and encoding SVG/MP4/Desmos  
- No property layout, no tool modes, no hit-testing  

### Shared draw, not shared mutation

Live renderer and SVG exporter should share **draw primitives** and pose/appearance reads. Neither owns material defaults or body factories.

---

## Data flow

### Edit (setup)

```
Tool / Properties / Handles
        → commands (core)
        → world + components
        → optional Matter bridge sync (pose/preview)
        → history stores document snapshot (core/scene)
        → view queries world and redraws
```

### Simulate (live)

```
app mode → sim.engine.step
        → systems (core)
        → onStep → recorder (io) if armed
        → view render
```

### Persist

```
Save / demo / undo restore
        → io reads/writes bytes
        → core loadDocument / toDocument
```

### Export / review

```
recorder frames (io)
        → playback rewrites poses for review
        → exporters consume frames + appearance from document/world
```

**Rule of thumb:** bytes and codecs live in `io/`; editable truth lives in `core/` documents; pixels and widgets live in `editor/`.

---

## Scene document direction

Evolve `newton-scene` from typed bodies (`type: 'box'`) toward:

```json
{
  "format": "newton-scene",
  "version": 2,
  "entities": [
    {
      "id": "body_1",
      "components": {
        "transform": { "x": 0, "y": 1, "angle": 0 },
        "rigidBody": { "mass": 1, "anchored": false },
        "collider": { "kind": "box", "width": 0.5, "height": 0.3 },
        "material": { "restitution": 0.5, "muK": 0.3, "muS": 0.4 },
        "appearance": { "name": "Block" }
      }
    }
  ],
  "environment": { },
  "camera": { },
  "measurements": [],
  "labels": [],
  "uiAggregates": []
}
```

Keep a migration path from v1 (`bodies[]` + `type`) so demos keep loading. Toolbox presets are just partial documents / archetype builders that produce the same component maps.

---

## App modes (unchanged roles, clearer owners)

| Mode | Owner | Behavior |
|------|--------|----------|
| `setup` | editor + core commands | mutate document/world; history on |
| `live` | core sim + io recorder | step systems; UI mostly read-only |
| `review` | io playback + editor view | scrub frames; no physics edits |

`app/modes.js` switches which clients are armed; it should not contain physics or panel logic.

---

## Migration

1. **Document + IDs** — introduce stable entity IDs and a v2-friendly schema (still backed by current Matter factories).  
2. **Archetypes** — route palette + deserialize through preset spawners; toolbox becomes presets.  
3. **Commands** — stop direct Matter writes from `properties` / `interaction`; go through `core` commands.  
4. **Move folders** — `physics` → `core/sim`, peel DOM-free scene helpers into `core/scene`, file/export into `io/`.  
5. **Split UI monoliths** — properties/interaction/graph by component or tool; shared `editor/view/draw`.  
6. **Thin `main.js`** — only bootstrap and mode wiring.

Do not replace Matter until the document/runtime/command split is real.

---

## Do not do

- Full game-engine ECS (bitsets, archetype storage) — unnecessary at current scale  
- Rewriting graph fitting, measurements, or experiment runners in the first pass  
- Removing Matter in the same effort as the folder split  

---

## Success criteria

- Adding friction/restitution (or a new material field) means editing `Material` + one properties widget — not factories, renderer, exporter, and interaction in parallel by hand  
- New toolbox entries are archetype definitions only  
- `core/` tests run without DOM or canvas  
- Export/save code does not import interaction or property panels  
- `main.js` (or `app/bootstrap.js`) is wiring, not business logic  
