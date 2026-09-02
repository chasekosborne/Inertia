/**
 * Environment settings panel: gravity, air drag, and arrow display scales.
 *
 * **Gravity.** Physics unit is 100 px = 1 m at a fixed step of 1000/SIM_HZ ms
 * (see units.js). Matter's force law is `mass * g.y * g.scale`, where `g.y` is
 * dimensionless and the millisecond timestep is folded into `g.scale`. We
 * expose g in m/s² and compute `scale = g_ms2 * 0.001 / 9.81`, so the default
 * 9.81 lands on Matter's stock 0.001.
 *
 * **Air drag.** Matter's `frictionAir` is a per-step velocity multiplier, not a
 * force, so it is bypassed entirely. Instead a `beforeUpdate` hook applies an
 * explicit F = ½ρCdAv² per body, which keeps Cd / ρ / A physically meaningful.
 *
 * **Arrow scales** are display-only multipliers on the force and velocity
 * arrow lengths (see units.js); they do not affect the simulation.
 */

import Matter from 'matter-js';
import { applyQuadraticAirDrag, clearAirDragVisuals } from '../physics/air-drag.js';
import {
  getForceArrowScale, setForceArrowScale,
  getVelocityArrowScale, setVelocityArrowScale,
} from '../units.js';

const { Events: MatterEvents } = Matter;

const DEFAULT_GRAVITY_MS2 = 9.81;
const DEFAULT_DRAG_COEFFICIENT = 0.47;
const DEFAULT_AREA_M2 = 0.045;
const DEFAULT_DENSITY_KG_M3 = 1.225;
/** Matter's stock gravity scale, which corresponds to g = 9.81 m/s². */
const MATTER_GRAVITY_SCALE = 0.001;
/** Opacity for a row whose toggle is off. */
const DIMMED_OPACITY = '0.35';

function byId(id) {
  return document.getElementById(id);
}

/** @param {HTMLInputElement|null} input @param {number} fallback */
function readNumber(input, fallback) {
  return parseFloat(input?.value) || fallback;
}

/** @param {HTMLElement[]} rows @param {boolean} disabled */
function setRowsDisabled(rows, disabled) {
  for (const row of rows) {
    if (!row) continue;
    row.style.opacity = disabled ? DIMMED_OPACITY : '1';
    row.style.pointerEvents = disabled ? 'none' : '';
  }
}

function formatArrowScale(scale) {
  return `${Number(scale).toFixed(1)}×`;
}

export class EnvironmentPanel {
  /** @param {import('../physics/engine.js').PhysicsEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this._airEnabled = false;

    this.elements = {
      gravityToggle: byId('env-gravity-toggle'),
      gravityRow: byId('env-g-row'),
      gravity: byId('env-g'),
      airToggle: byId('env-air-toggle'),
      dragCoefficientRow: byId('env-cd-row'),
      areaRow: byId('env-area-row'),
      densityRow: byId('env-rho-row'),
      dragCoefficient: byId('env-cd'),
      area: byId('env-area'),
      density: byId('env-rho'),
      forceArrowScale: byId('env-force-arrow-scale'),
      forceArrowScaleLabel: byId('env-force-arrow-scale-label'),
      velocityArrowScale: byId('env-vel-arrow-scale'),
      velocityArrowScaleLabel: byId('env-vel-arrow-scale-label'),
    };

    this._bindEvents();
    this._applyGravity();
    this._syncForceArrowScaleUi();
    this._syncVelocityArrowScaleUi();
  }

  // ─── Public ──────────────────────────────────────────────────────

  /** Current settings in scene-document form. */
  readScene() {
    const el = this.elements;
    return {
      gravity: {
        enabled: el.gravityToggle.checked,
        g: readNumber(el.gravity, DEFAULT_GRAVITY_MS2),
      },
      air: {
        enabled: this._airEnabled,
        cd: readNumber(el.dragCoefficient, DEFAULT_DRAG_COEFFICIENT),
        area: readNumber(el.area, DEFAULT_AREA_M2),
        rho: readNumber(el.density, DEFAULT_DENSITY_KG_M3),
      },
    };
  }

  /** Push a loaded scene's environment into the form and onto the engine. */
  applyScene(environment) {
    if (!environment) return;
    const el = this.elements;

    el.gravityToggle.checked = environment.gravity?.enabled ?? true;
    el.gravity.value = environment.gravity?.g ?? DEFAULT_GRAVITY_MS2;
    this._syncGravityRowUi();
    this._applyGravity();

    el.airToggle.checked = environment.air?.enabled ?? false;
    this._airEnabled = environment.air?.enabled ?? false;
    if (!this._airEnabled) clearAirDragVisuals(this.engine.bodies);
    if (environment.air) {
      el.dragCoefficient.value = environment.air.cd ?? DEFAULT_DRAG_COEFFICIENT;
      el.area.value = environment.air.area ?? DEFAULT_AREA_M2;
      el.density.value = environment.air.rho ?? DEFAULT_DENSITY_KG_M3;
    }
    this._syncAirRowsUi();
  }

  // ─── Wiring ──────────────────────────────────────────────────────

  _bindEvents() {
    const el = this.elements;

    el.gravityToggle.addEventListener('change', () => {
      this._syncGravityRowUi();
      this._applyGravity();
    });

    el.airToggle.addEventListener('change', () => {
      this._airEnabled = el.airToggle.checked;
      if (!this._airEnabled) clearAirDragVisuals(this.engine.bodies);
      this._syncAirRowsUi();
    });

    for (const input of [el.gravity, el.dragCoefficient, el.area, el.density]) {
      input.addEventListener('change', () => this._applyGravity());
    }

    el.forceArrowScale?.addEventListener('input', () => this._applyForceArrowScale());
    el.velocityArrowScale?.addEventListener('input', () => this._applyVelocityArrowScale());

    // Air drag runs as an explicit per-body force each physics step.
    MatterEvents.on(this.engine.engine, 'beforeUpdate', () => {
      if (!this._airEnabled) return;
      applyQuadraticAirDrag(this.engine.bodies, this._airParams(), this.engine);
    });
  }

  // ─── Gravity / air ───────────────────────────────────────────────

  _applyGravity() {
    const el = this.elements;
    const enabled = el.gravityToggle.checked;
    const gravityMs2 = enabled ? readNumber(el.gravity, DEFAULT_GRAVITY_MS2) : 0;
    const gravity = this.engine.engine.gravity;
    gravity.y = 1;
    gravity.x = 0;
    gravity.scale = gravityMs2 * MATTER_GRAVITY_SCALE / DEFAULT_GRAVITY_MS2;
    this.engine.invalidateEnergyTarget();
  }

  _syncGravityRowUi() {
    setRowsDisabled([this.elements.gravityRow], !this.elements.gravityToggle.checked);
  }

  _syncAirRowsUi() {
    const el = this.elements;
    setRowsDisabled([el.dragCoefficientRow, el.areaRow, el.densityRow], !this._airEnabled);
  }

  _airParams() {
    const el = this.elements;
    return {
      rho: readNumber(el.density, DEFAULT_DENSITY_KG_M3),
      Cd: readNumber(el.dragCoefficient, DEFAULT_DRAG_COEFFICIENT),
      A: readNumber(el.area, DEFAULT_AREA_M2),
    };
  }

  // ─── Arrow scales ────────────────────────────────────────────────

  _syncForceArrowScaleUi(scale = getForceArrowScale()) {
    const el = this.elements;
    if (el.forceArrowScale) {
      el.forceArrowScale.value = String(scale);
      el.forceArrowScale.setAttribute('aria-valuenow', String(scale));
    }
    if (el.forceArrowScaleLabel) {
      el.forceArrowScaleLabel.textContent = formatArrowScale(scale);
    }
  }

  _syncVelocityArrowScaleUi(scale = getVelocityArrowScale()) {
    const el = this.elements;
    if (el.velocityArrowScale) {
      el.velocityArrowScale.value = String(scale);
      el.velocityArrowScale.setAttribute('aria-valuenow', String(scale));
    }
    if (el.velocityArrowScaleLabel) {
      el.velocityArrowScaleLabel.textContent = formatArrowScale(scale);
    }
  }

  _applyForceArrowScale() {
    const raw = parseFloat(this.elements.forceArrowScale?.value ?? '1');
    this._syncForceArrowScaleUi(setForceArrowScale(Number.isFinite(raw) ? raw : 1));
  }

  _applyVelocityArrowScale() {
    const raw = parseFloat(this.elements.velocityArrowScale?.value ?? '1');
    this._syncVelocityArrowScaleUi(setVelocityArrowScale(Number.isFinite(raw) ? raw : 1));
  }
}
