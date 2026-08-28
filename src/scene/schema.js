/** Unified Newton scene document format (export, import, reset). */

export const SCENE_FORMAT = 'newton-scene';
export const SCENE_VERSION = 1;

/** @typedef {{ x: number, y: number }} Vec2M */
/** @typedef {{ vx: number, vy: number }} Vel2MS */

/**
 * @typedef {object} SceneDocument
 * @property {string} format
 * @property {number} version
 * @property {object} meta
 * @property {string} [meta.name]
 * @property {string} [meta.demoId]
 * @property {string} [meta.presetId]  Legacy alias
 * @property {string} [meta.source]
 * @property {Vec2M} metricOrigin  Display-frame origin (m)
 * @property {object} environment
 * @property {{ tx: number, ty: number, s: number, center?: { x: number, y: number }, view?: { width: number, height: number }, followBody?: string|null }|null} [camera]
 * @property {SceneBody[]} bodies
 * @property {SceneConstraint[]} constraints
 * @property {object[]} [measurements]  Length / angle overlays (see MeasurementManager).
 *   Lengths may set `component`: 'distance' | 'dx' | 'dy' | 'manhattan'.
 * @property {object[]} [labels]  Inline on bodies, callouts to world points or anchored targets.
 * @property {{ id: string, name: string, members: string[] }[]} [uiAggregates]
 */

/**
 * @typedef {object} SceneBody
 * @property {string} id
 * @property {'point-mass'|'ball'|'box'|'wedge'|'ground'|'anchor'|'metric-basis'} type
 * @property {Vec2M} position
 * @property {number} [angle]
 * @property {Vel2MS} [velocity]
 * @property {number} [mass]
 * @property {boolean} [isStatic]  Anchored: fixed like ground (circle/ball/box/wedge)
 * @property {object} [geometry]  radius (m), point-mass hollow, box/wedge size (m)
 * @property {object} [material]
 * @property {{ F: number, thetaDeg: number }} [appliedForce]  Constant pull (N, ° above +x); F may be 0 when drivenApplied
 * @property {boolean} [drivenApplied]  Body: time-varying applied F(t) along θ
 * @property {string} [drivenAppliedForce]  Body drive F(t) expression (N), e.g. `5*sin(2*pi*t)`
 * @property {number} [angularVelocity]  Display ω_z (rad/s): + CCW / out of screen
 * @property {number} [appliedTorque]  Display τ (N·m): + CCW / out of screen
 * @property {boolean} [driven]  Anchor: time-varying drive
 * @property {string} [drivenTorque]  Anchor drive τ(t) expression (N·m), e.g. `0.5*sin(2*pi*t)`
 */

/**
 * @typedef {object} SceneConstraint
 * @property {string} id
 * @property {'spring'|'rod'|'string'} type
 * @property {string|null} bodyA
 * @property {string} bodyB
 * @property {Vec2M} [anchorA]
 * @property {Vec2M} [anchorB]
 * @property {number} [restLength]  m: springs
 * @property {number} [length]      m: rods / strings
 * @property {number} [k]
 * @property {{ maxExtension: number|null, maxCompression: number|null }} [limits]
 * @property {number} [stiffness]
 * @property {number} [dampingMatter]  strings only (Matter constraint damping)

 */

/**
 * @typedef {object} SceneCamera
 * @property {{ x: number, y: number }} [center]  View centre (display m)
 * @property {{ width: number, height: number }} [view]  Visible extent (m)
 * @property {string|null} [followBody]  Body label to track
 * @property {number} [tx]  Legacy pan
 * @property {number} [ty]
 * @property {number} [s]   Legacy zoom
 */

export function defaultEnvironment() {
  return {
    gravity: { enabled: true, g: 9.81 },
    air: { enabled: false, cd: 0.47, area: 0.045, rho: 1.225 },
  };
}
