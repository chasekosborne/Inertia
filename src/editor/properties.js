/**
 * Properties panel: body inspector with SI-style readouts.
 *
 * World length is stored in px with fixed scale {@link PX_PER_M} px = 1 m.
 * Point mass / box / ground layout fields are edited in metres, velocities
 * are shown in m/s (+y up) using {@link ../units.js}.
 */

import Matter from 'matter-js';
import {
  setMaterialFriction, createGround, scaleBoxTo, scaleCircleTo, scaleWedgeTo, setWedgeGeometry,
  defaultWedgeFootAngle, clampWedgeFootAngle, wedgeAABBCenterWorld, setWedgeAABBCenter,
  snapWedgeToGrid,
  setBodyAnchored, setBodyMass, bodyDisplayMass, applyCircleInertia,
} from '../physics/bodies.js';
import {
  setAppliedForce,
  clearAppliedForce,
  getAppliedForce,
  getAppliedForceDirection,
  isDrivenAppliedForce,
  setDrivenAppliedForce,
  getDrivenAppliedForceExpr,
  setDrivenAppliedForceExpr,
  getDrivenAppliedForceError,
  DEFAULT_DRIVEN_APPLIED_FORCE_EXPR,
} from '../physics/applied-force.js';
import { setAppliedTorque, clearAppliedTorque, getAppliedTorque } from '../physics/applied-torque.js';
import {
  isDrivenPivot,
  setDriven,
  getDrivenTorqueExpr,
  setDrivenTorqueExpr,
  getDrivenTorqueError,
  DEFAULT_DRIVEN_TORQUE_EXPR,
} from '../physics/driven-pivot.js';
import {
  matterOmegaToDisplay,
  displayOmegaToMatter,
  bodyAngularMomentumSI,
} from '../physics/angular.js';
import { updateCompoundPart } from '../physics/sticky.js';
import { retargetBodyAttachments } from '../physics/layout-anchors.js';
import {
  listRopeSegments, rebuildRope, removeRope, ropeCenterlineWorldPx, ROPE_THICKNESS_M,
  ROPE_MIN_SEGMENTS, ROPE_MAX_SEGMENTS, clampRopeSegments,
  ropeSelection, ropeDisplayName, renameRope, getRopeEndAttachment,
  syncRopesAfterHostMove,
} from '../physics/rope.js';
import { aggregateState, bodyDisplayName } from '../scene/aggregates.js';
import { snapWorldCoord, snapVelocityToGrid, snapBodySizePx } from '../grid.js';
import { displayedMToWorldPx, worldPxToDisplayedM } from '../world-origin.js';
import {
  PX_PER_M,
  pxToM,
  mToPx,
  matterVelToDisplayMS,
  displayMSToMatterVel,
  DEFAULT_CIRCLE_RADIUS_M,
  DEFAULT_BALL_RADIUS_M,
} from '../units.js';
import { MATH } from '../math-text.js';
import { mountMathExprInput, syncMathExprInput } from './math-expr-input.js';

const { Body } = Matter;

export { PX_PER_M };

export class PropertiesPanel {
  /**
   * @param {HTMLElement} panelEl
   * @param {import('../physics/engine.js').PhysicsEngine} physicsEngine
   * @param {(() => void)|null} [beforeChange] : undo snapshot before mutation
   * @param {((bodyId: number) => void)|null} [onFocusedBodyChange] : notify app
   *    when inspected body ID changes after a rebuild (same physical object slot).
   * @param {(() => boolean)|null} [getSnapEnabled] : toolbar snap-to-grid toggle
   * @param {{
   *   getManager?: () => import('./measurements.js').MeasurementManager|null,
   *   getLabelManager?: () => import('./labels.js').LabelManager|null,
   *   onChanged?: () => void,
   * }|null} [measurementHooks]
   */
  constructor(panelEl, physicsEngine, beforeChange = null, onFocusedBodyChange = null, getSnapEnabled = null, measurementHooks = null) {
    this.panel  = panelEl;
    this.engine = physicsEngine;
    this._current = null;
    this._suppressRefresh = false;
    this._beforeChange = beforeChange;
    this._onFocusedBodyChange = onFocusedBodyChange;
    this._getSnapEnabled = getSnapEnabled;
    this._measurementHooks = measurementHooks;
    this._pushArmed = false;

    // Enter commits the focused property field.
    this.panel.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.type === 'checkbox' || t.type === 'radio' || t.type === 'button' || t.type === 'file') return;
      e.preventDefault();
      // Fire change explicitly so Enter commits even when blur alone would not
      // (value equal to the pre-focus string after reformatting, etc.).
      t.dispatchEvent(new Event('change', { bubbles: true }));
      t.blur();
    });
  }

  /** Notify caller that a mutation is about to happen. */
  _push() {
    // Coalesce duplicate change events (Enter often fires change + blur change).
    if (this._pushArmed) return;
    this._pushArmed = true;
    try { this._beforeChange?.(); }
    finally { queueMicrotask(() => { this._pushArmed = false; }); }
  }

  _snapOn() { return this._getSnapEnabled?.() ?? false; }

  /** After a host body moves in the panel, reproject attached ropes (no stretch). */
  _syncBodyRopes(body) {
    if (body) syncRopesAfterHostMove(this.engine, body);
  }

  /** Non-negative number from an input or raw string; empty/invalid → 0. */
  _parseNonNeg(elOrValue) {
    const raw = (typeof elOrValue === 'object' && elOrValue != null && 'value' in elOrValue)
      ? elOrValue.value
      : elOrValue;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  /**
   * Apply μs / μk from the panel. Lowering either side clamps the other so
   * μs ≥ μk, and both may be zero (frictionless ground / body).
   * @param {import('matter-js').Body|import('matter-js').Body[]} bodies
   * @param {'mus'|'muk'} which
   * @param {number} value
   */
  _applyFrictionEdit(bodies, which, value) {
    const list = Array.isArray(bodies) ? bodies : [bodies];
    const body0 = list.find(Boolean);
    if (!body0) return;
    let muK = body0._muK ?? body0.friction ?? 0;
    let muS = body0._muS ?? body0.frictionStatic ?? muK;
    if (!Number.isFinite(muK)) muK = 0;
    if (!Number.isFinite(muS)) muS = 0;
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (which === 'mus') {
      muS = v;
      if (muK > muS) muK = muS;
    } else {
      muK = v;
      if (muS < muK) muS = muK;
    }
    for (const b of list) {
      if (b) setMaterialFriction(b, muK, muS);
    }
    const musEl = this.panel.querySelector('#prop-mus');
    const mukEl = this.panel.querySelector('#prop-muk');
    if (musEl) musEl.value = muS.toFixed(3);
    if (mukEl) mukEl.value = muK.toFixed(3);
  }

  /**
   * Wire μs / μk inputs for one body or a list (rope segments).
   * @param {() => (import('matter-js').Body|import('matter-js').Body[]|null|undefined)} getBodies
   */
  _bindFrictionInputs(getBodies) {
    const run = (which) => (e) => {
      const bodies = getBodies();
      if (!bodies || (Array.isArray(bodies) && !bodies.length)) return;
      this._push();
      this._applyFrictionEdit(bodies, which, this._parseNonNeg(e.target));
    };
    this.panel.querySelector('#prop-mus')?.addEventListener('change', run('mus'));
    this.panel.querySelector('#prop-muk')?.addEventListener('change', run('muk'));
  }

  /** Checkbox row: Anchored = Matter static (no gravity / no impulse to this body). */
  _anchoredRowHtml(body) {
    const checked = body.isStatic ? 'checked' : '';
    return `
      <div class="prop-row">
        <span class="prop-label">Anchored</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-anchored" ${checked}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>`;
  }

  _bindAnchoredToggle(body) {
    this.panel.querySelector('#prop-anchored')?.addEventListener('change', e => {
      this._push();
      setBodyAnchored(body, !!e.target.checked);
      this._rebuildVelocityInputs(body);
      // Refresh mass field (static bodies report Infinity in Matter).
      this._setVField('#prop-mass', bodyDisplayMass(body).toFixed(3));
    });
  }

  /** Binary sticky toggle: same switch chrome as Anchored / Hollow. */
  _stickyToggleHtml(checked) {
    return `
      <div class="prop-row">
        <span class="prop-label">Sticky</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-sticky" ${checked ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>`;
  }

  /** Human label for a welded component type. */
  _partTypeLabel(type) {
    if (type === 'point-mass') return 'Point';
    if (type === 'ball') return 'Ball';
    if (type === 'box') return 'Box';
    if (type === 'wedge') return 'Wedge';
    return type || 'Part';
  }

  /**
   * Display name for a weld component (original body label preferred).
   * @param {object} meta
   * @param {number} partIndex
   * @param {import('matter-js').Body} [part]
   */
  _partDisplayName(meta, partIndex, part) {
    const label = meta?.label || part?.label;
    if (label) return label;
    return `${this._partTypeLabel(meta?.type)} ${partIndex + 1}`;
  }

  _bindStickyToggle(body) {
    this.panel.querySelector('#prop-sticky')?.addEventListener('change', e => {
      this._push();
      body._stickOnContact = !!e.target.checked;
      if (e.target.checked) body.restitution = 0;
    });
  }

  /** Bind F / θ inputs, `newtonType` narrows the body lookup (e.g. `'box'`). */
  _bindAppliedForceInputs(newtonType) {
    const readBody = () => this.engine.bodies.find(
      x => x.id === this._current?.id && (!newtonType || x._newtonType === newtonType),
    );

    const getF = () => Math.max(0, parseFloat(this.panel.querySelector('#prop-F')?.value ?? 0) || 0);
    const getAngle = () => parseFloat(this.panel.querySelector('#prop-F-theta')?.value ?? 0) || 0;
    const getFx = () => parseFloat(this.panel.querySelector('#prop-Fx')?.value ?? 0) || 0;
    const getFy = () => parseFloat(this.panel.querySelector('#prop-Fy')?.value ?? 0) || 0;

    const applyPolar = () => {
      const b = readBody();
      if (!b) return;
      this._push();
      const F = getF();
      const thetaDeg = getAngle();
      const rad = thetaDeg * Math.PI / 180;
      const Fx = F * Math.cos(rad);
      const Fy = F * Math.sin(rad);
      this._setVField('#prop-Fx', Fx.toFixed(3));
      this._setVField('#prop-Fy', Fy.toFixed(3));
      this.applyAppliedForce(b, F, thetaDeg);
    };

    const applyCartesian = () => {
      const b = readBody();
      if (!b) return;
      this._push();
      const Fx = getFx();
      const Fy = getFy();
      const F = Math.hypot(Fx, Fy);
      const thetaDeg = F > 1e-12 ? Math.atan2(Fy, Fx) * 180 / Math.PI : 0;
      this._setVField('#prop-F', F.toFixed(3));
      this._setVField('#prop-F-theta', thetaDeg.toFixed(1));
      this.applyAppliedForce(b, F, thetaDeg);
    };

    this.panel.querySelector('#prop-F')?.addEventListener('change', applyPolar);
    this.panel.querySelector('#prop-F-theta')?.addEventListener('change', applyPolar);
    this.panel.querySelector('#prop-Fx')?.addEventListener('change', applyCartesian);
    this.panel.querySelector('#prop-Fy')?.addEventListener('change', applyCartesian);

    this.panel.querySelector('#prop-driven-applied')?.addEventListener('change', e => {
      const b = readBody();
      if (!b) return;
      this._push();
      const on = !!e.target.checked;
      setDrivenAppliedForce(b, on);
      const section = this.panel.querySelector('#prop-driven-applied-section');
      section?.classList.toggle('hidden', !on);
      const constRows = this.panel.querySelector('#prop-applied-const-rows');
      constRows?.classList.toggle('hidden', on);
      if (on) {
        requestAnimationFrame(() => this._bindDrivenAppliedExprInput(b));
      }
      this.engine.invalidateEnergyTarget?.();
    });

    const b0 = readBody();
    if (b0 && isDrivenAppliedForce(b0)) this._bindDrivenAppliedExprInput(b0);
  }

  applyVelocity(body, vxPx, vyPx, { snapGrid } = {}) {
    const useGrid = snapGrid ?? this._snapOn();
    const { vx, vy } = snapVelocityToGrid(
      body.position.x, body.position.y, vxPx, vyPx, useGrid,
    );
    Body.setVelocity(body, { x: vx, y: vy });
    this.engine?.invalidateEnergyTarget?.();
    this._rebuildVelocityInputs(body);
  }

  /** Update constant applied pull F (N) at θ° above +x. F ≤ 0 clears it. */
  applyAppliedForce(body, F, thetaDeg) {
    if (F > 0 && isFinite(F) && isFinite(thetaDeg)) setAppliedForce(body, F, thetaDeg);
    else if (isDrivenAppliedForce(body) && isFinite(thetaDeg)) setAppliedForce(body, 0, thetaDeg);
    else clearAppliedForce(body);
    this._rebuildAppliedForceInputs(body);
  }

  /** Polar + Cartesian applied-force rows (mirrors v₀), plus optional F(t). */
  _appliedForceRowsHtml(body) {
    const af = getAppliedForce(body);
    const driven = isDrivenAppliedForce(body);
    const F = af?.F ?? 0;
    const thetaDeg = af?.thetaDeg ?? getAppliedForceDirection(body);
    const rad = thetaDeg * Math.PI / 180;
    const Fx = F * Math.cos(rad);
    const Fy = F * Math.sin(rad);
    const expr = getDrivenAppliedForceExpr(body) || DEFAULT_DRIVEN_APPLIED_FORCE_EXPR;
    const err = getDrivenAppliedForceError(body);
    return `
      <div class="prop-section-title" style="margin-top:8px">Applied force ${MATH.F}</div>
      <div class="prop-row">
        <span class="prop-label">Driven</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-driven-applied" ${driven ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      <div id="prop-driven-applied-section" class="${driven ? '' : 'hidden'}">
        <div class="prop-section-title" style="margin-top:8px">${MATH.F}(t) (N)</div>
        <div class="prop-math-expr-wrap" id="prop-driven-F-applied-wrap"
          data-expr="${_escapeHtml(expr)}"></div>
        <p class="prop-expr-error ${err ? '' : 'hidden'}" id="prop-driven-F-applied-err">${err ? _escapeHtml(err) : ''}</p>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.theta} (°)</span>
        <input class="prop-value" id="prop-F-theta" type="number" step="1" min="-180" max="180" value="${thetaDeg.toFixed(1)}"/>
      </div>
      <div id="prop-applied-const-rows" class="${driven ? 'hidden' : ''}">
        <div class="prop-row">
          <span class="prop-label">|${MATH.F}| (N)</span>
          <input class="prop-value" id="prop-F" type="number" step="0.1" min="0" value="${F.toFixed(3)}"/>
        </div>
        <div class="prop-row">
          <span class="prop-label">${MATH.Fx} (N)</span>
          <input class="prop-value" id="prop-Fx" type="number" step="0.1" value="${Fx.toFixed(3)}"/>
        </div>
        <div class="prop-row">
          <span class="prop-label">${MATH.Fy} (N)</span>
          <input class="prop-value" id="prop-Fy" type="number" step="0.1" value="${Fy.toFixed(3)}"/>
        </div>
      </div>`;
  }

  /** Rebuild applied-force sub-fields without rebuilding the whole panel. */
  _rebuildAppliedForceInputs(body) {
    const af = getAppliedForce(body);
    const F = af?.F ?? 0;
    const thetaDeg = af?.thetaDeg ?? getAppliedForceDirection(body);
    const rad = thetaDeg * Math.PI / 180;
    const Fx = F * Math.cos(rad);
    const Fy = F * Math.sin(rad);
    this._setVField('#prop-F', F.toFixed(3));
    this._setVField('#prop-F-theta', thetaDeg.toFixed(1));
    this._setVField('#prop-Fx', Fx.toFixed(3));
    this._setVField('#prop-Fy', Fy.toFixed(3));
  }

  /**
   * Symbolic F(t) input for driven applied force.
   * @param {import('matter-js').Body} body
   */
  _bindDrivenAppliedExprInput(body) {
    const wrap = this.panel.querySelector('#prop-driven-F-applied-wrap');
    if (!wrap || wrap.dataset.bound === '1') return;

    const applyAscii = (ascii) => {
      this._push();
      const result = setDrivenAppliedForceExpr(
        body,
        ascii || DEFAULT_DRIVEN_APPLIED_FORCE_EXPR,
      );
      if (result.ok) syncMathExprInput(wrap, result.source);
      const errEl = this.panel.querySelector('#prop-driven-F-applied-err');
      if (errEl) {
        if (result.ok) {
          errEl.textContent = '';
          errEl.classList.add('hidden');
        } else {
          errEl.textContent = result.error ?? 'Invalid expression';
          errEl.classList.remove('hidden');
        }
      }
      this.engine.invalidateEnergyTarget?.();
    };

    mountMathExprInput(wrap, {
      expr: getDrivenAppliedForceExpr(body) || DEFAULT_DRIVEN_APPLIED_FORCE_EXPR,
      fallbackExpr: DEFAULT_DRIVEN_APPLIED_FORCE_EXPR,
      onApply: applyAscii,
    });
  }

  /**
   * Angular velocity ω, angular momentum L, and applied torque τ.
   * Sign: + = CCW / out of screen (⊙), − = CW / into screen (⊗).
   */
  _angularRowsHtml(body) {
    const locked = body.inertia === Infinity || body._lockRotation === true;
    if (locked) {
      return `
      <div class="prop-section-title" style="margin-top:8px">Rotation</div>
      <p class="hint" style="font-size:10px;margin:0 0 6px">Rotation locked</p>`;
    }
    const omega = matterOmegaToDisplay(body.angularVelocity || 0);
    const L = bodyAngularMomentumSI(body);
    const tau = getAppliedTorque(body) ?? 0;
    const Lstr = L == null || !isFinite(L) ? '—' : L.toFixed(4);
    return `
      <div class="prop-section-title" style="margin-top:8px">Rotation</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.omega} (rad/s)</span>
        <input class="prop-value" id="prop-omega" type="number" step="0.1" value="${omega.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.L} (kg·m²/s)</span>
        <span class="prop-value" id="prop-L" style="opacity:0.85">${Lstr}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.tau} (N·m)</span>
        <input class="prop-value" id="prop-tau" type="number" step="0.05" value="${tau.toFixed(3)}"/>
      </div>`;
  }

  _bindAngularInputs(newtonType) {
    const readBody = () => this.engine.bodies.find(
      x => x.id === this._current?.id && (!newtonType || x._newtonType === newtonType),
    );

    this.panel.querySelector('#prop-omega')?.addEventListener('change', e => {
      const b = readBody();
      if (!b || b.inertia === Infinity) return;
      this._push();
      const omega = parseFloat(e.target.value) || 0;
      Body.setAngularVelocity(b, displayOmegaToMatter(omega));
      this._rebuildAngularInputs(b);
    });

    this.panel.querySelector('#prop-tau')?.addEventListener('change', e => {
      const b = readBody();
      if (!b) return;
      this._push();
      const tau = parseFloat(e.target.value) || 0;
      if (tau === 0) clearAppliedTorque(b);
      else setAppliedTorque(b, tau);
      this._rebuildAngularInputs(b);
    });
  }

  _rebuildAngularInputs(body) {
    if (!this.panel.querySelector('#prop-omega')) return;
    const locked = body.inertia === Infinity || body._lockRotation === true;
    if (locked) return;
    const omega = matterOmegaToDisplay(body.angularVelocity || 0);
    const L = bodyAngularMomentumSI(body);
    const tau = getAppliedTorque(body) ?? 0;
    this._setVField('#prop-omega', omega.toFixed(3));
    const Lel = this.panel.querySelector('#prop-L');
    if (Lel) Lel.textContent = L == null || !isFinite(L) ? '—' : L.toFixed(4);
    this._setVField('#prop-tau', tau.toFixed(3));
  }

  clear() {
    this._current = null;
    this.panel.innerHTML = '';
  }

  show(selection) {
    if (!selection) { this.clear(); return; }
    const { type, id } = selection;
    if (type === 'measurement') {
      this._buildMeasurementPanel(id);
      return;
    }
    if (type === 'label') {
      this._buildLabelPanel(id);
      return;
    }
    if (type === 'aggregate') {
      this._buildAggregatePanel(selection);
      return;
    }
    if (type === 'rope') {
      this._buildRopePanel(selection.ropeId);
      return;
    }
    if (type === 'body') {
      const body = this.engine.bodies.find(b => b.id == id);
      if (!body) { this.clear(); return; }
      if (body._ropeSegment && body._ropeId) {
        this._buildRopePanel(body._ropeId);
        return;
      }
      const partIndex = selection.partIndex ?? null;
      this._current = { type: 'body', id: body.id, partIndex };
      if (body._newtonType === 'compound' && partIndex != null) {
        this._buildWeldPartPanel(body, partIndex);
      } else {
        this._showBody(body);
      }
      return;
    }
    if (type === 'constraint') {
      const c = this.engine.constraints.find(x => x.id === id);
      if (!c) { this.clear(); return; }
      this._buildConstraintPanel(c);
      return;
    }
    if (type === 'camera') {
      this._buildCameraPanel();
    }
  }

  /**
   * Camera rig: framing for viewport + video export.
   * @param {import('../editor/camera/camera-rig.js').CameraRig} rig
   * @param {() => void} onApply
   */
  showCamera(rig, onApply) {
    this._cameraRig = rig;
    this._cameraApply = onApply;
    this.show({ type: 'camera' });
  }

  _buildCameraPanel() {
    const rig = this._cameraRig;
    const onApply = this._cameraApply;
    if (!rig) { this.clear(); return; }

    this._current = { type: 'camera' };
    const c = worldPxToDisplayedM(rig.centerX, rig.centerY);
    const vw = rig.viewWidth / PX_PER_M;
    const vh = rig.viewHeight / PX_PER_M;

    const bodies = this.engine.bodies.filter(b => b._newtonType !== 'metric-basis');
    const followOpts = ['<option value="">None</option>']
      .concat(bodies.map(b => {
        const label = typeof b.label === 'string' ? b.label : `body ${b.id}`;
        const sel = rig.followBodyId === b.id ? ' selected' : '';
        return `<option value="${_escapeHtml(label)}"${sel}>${_escapeHtml(label)}</option>`;
      }));

    this.panel.innerHTML = `
      <div class="prop-section-title">Camera frame</div>
      <div class="prop-row">
        <span class="prop-label">Aspect ratio</span>
        <span class="prop-value export-size-readout" id="prop-cam-aspect">${rig.aspectLabel()}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Centre x (m)</span>
        <input class="prop-value" id="prop-cam-cx" type="number" step="0.01" value="${c.xm.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">Centre y (m)</span>
        <input class="prop-value" id="prop-cam-cy" type="number" step="0.01" value="${c.ym.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">View width (m)</span>
        <input class="prop-value" id="prop-cam-vw" type="number" step="0.05" min="0.2" value="${vw.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">View height (m)</span>
        <input class="prop-value" id="prop-cam-vh" type="number" step="0.05" min="0.2" value="${vh.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">Follow body</span>
        <select class="prop-value" id="prop-cam-follow">${followOpts.join('')}</select>
      </div>
      <button type="button" class="prop-delete-btn" id="prop-cam-frame-all" style="margin-top:8px">Frame all bodies</button>
      <p class="export-hint" style="margin-top:10px">Drag the origin or frame to reframe. Scroll to zoom; Shift+drag or drag outside the frame to pan. Follow body from the dropdown.</p>
    `;

    const applyFields = () => {
      const cx = parseFloat(this.panel.querySelector('#prop-cam-cx')?.value ?? c.xm);
      const cy = parseFloat(this.panel.querySelector('#prop-cam-cy')?.value ?? c.ym);
      const w = parseFloat(this.panel.querySelector('#prop-cam-vw')?.value ?? vw);
      const h = parseFloat(this.panel.querySelector('#prop-cam-vh')?.value ?? vh);
      const wpx = displayedMToWorldPx(cx, cy);
      rig.centerX = wpx.x;
      rig.centerY = wpx.y;
      rig.viewWidth = Math.max(40, mToPx(w));
      rig.viewHeight = Math.max(40, mToPx(h));
      const followLabel = String(this.panel.querySelector('#prop-cam-follow')?.value ?? '').trim();
      if (!followLabel) {
        rig.followBodyId = null;
        rig.followBodyLabel = null;
      } else {
        const body = this.engine.bodies.find(b => b.label === followLabel);
        rig.setFollowBody(body ?? null);
      }
      onApply?.();
    };

    for (const sel of ['#prop-cam-cx', '#prop-cam-cy', '#prop-cam-vw', '#prop-cam-vh', '#prop-cam-follow']) {
      this.panel.querySelector(sel)?.addEventListener('change', applyFields);
    }

    this.panel.querySelector('#prop-cam-frame-all')?.addEventListener('click', () => {
      this._push();
      rig.fitAllBodies(this.engine);
      onApply?.();
      this._buildCameraPanel();
    });
  }

  /**
   * Angle / length measurement overlays.
   * @param {string} id
   */
  _buildMeasurementPanel(id) {
    const mgr = this._measurementHooks?.getManager?.();
    const m = mgr?.getById?.(id);
    if (!m) { this.clear(); return; }

    this._current = { type: 'measurement', id: m.id };
    const isAngle = m.kind === 'angle';
    const title = isAngle ? 'Angle' : 'Length';
    const dynamic = m.dynamic !== false;
    const symbol = m.label ?? '';
    const deg = isAngle ? mgr.measureAngleDeg(m.id) : null;
    const degStr = deg == null || !Number.isFinite(deg) ? '—' : `${deg.toFixed(1)}°`;
    const component = m.component ?? 'distance';
    const parts = isAngle ? null : mgr.measureLengthParts(m.id);
    const lenVal = isAngle ? null : mgr.measureLengthM(m.id);
    const fmtM = (n) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(3);
    const fmtSigned = (n) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(3);

    const lengthRows = isAngle ? '' : `
      <div class="prop-row">
        <span class="prop-label">Measure</span>
        <select class="prop-value" id="prop-meas-component"
                title="Which length is labelled on the overlay and graphed">
          <option value="distance"${component === 'distance' ? ' selected' : ''}>Distance</option>
          <option value="dx"${component === 'dx' ? ' selected' : ''}>|Δx|</option>
          <option value="dy"${component === 'dy' ? ' selected' : ''}>|Δy|</option>
          <option value="manhattan"${component === 'manhattan' ? ' selected' : ''}>|Δx|+|Δy|</option>
        </select>
      </div>
      ${component === 'manhattan' ? `
      <div class="prop-row">
        <span class="prop-label">Corner</span>
        <select class="prop-value" id="prop-meas-elbow"
                title="L-path: horizontal then vertical (xy), or vertical then horizontal (yx)">
          <option value="xy"${m.elbow !== 'yx' ? ' selected' : ''}>along x then y</option>
          <option value="yx"${m.elbow === 'yx' ? ' selected' : ''}>along y then x</option>
        </select>
      </div>` : ''}
      <div class="prop-row">
        <span class="prop-label">Value (m)</span>
        <span class="prop-value" id="prop-meas-length" style="opacity:0.85">${fmtM(lenVal)}</span>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Components</div>
      <div class="prop-row">
        <span class="prop-label">|${MATH.ell}| (m)</span>
        <span class="prop-value" id="prop-meas-dist" style="opacity:0.85">${fmtM(parts?.distance)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.dx} (m)</span>
        <span class="prop-value" id="prop-meas-dx" style="opacity:0.85">${fmtSigned(parts?.dx)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.dy} (m)</span>
        <span class="prop-value" id="prop-meas-dy" style="opacity:0.85">${fmtSigned(parts?.dy)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">|${MATH.dx}|+|${MATH.dy}|</span>
        <span class="prop-value" id="prop-meas-manh" style="opacity:0.85">${fmtM(parts?.manhattan)}</span>
      </div>`;

    this.panel.innerHTML = `
      <div class="prop-section-title">${title}</div>
      <div class="prop-row">
        <span class="prop-label">Symbol</span>
        <input class="prop-value" id="prop-meas-symbol" type="text" maxlength="24"
               value="${_escapeHtml(symbol)}" placeholder="${isAngle ? 'θ' : 'ℓ'}" spellcheck="false"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">Dynamic</span>
        <label class="toggle-label" title="On: follow bodies and vectors. Off: freeze in place.">
          <input type="checkbox" id="prop-meas-dynamic" ${dynamic ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      ${isAngle ? `
      <div class="prop-row">
        <span class="prop-label">Angle</span>
        <span class="prop-value" id="prop-meas-angle" style="opacity:0.85">${degStr}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Continuous</span>
        <label class="toggle-label" title="Off: wrap to ±180°. On: accumulate past full turns (370°, −720°, …).">
          <input type="checkbox" id="prop-meas-continuous" ${m.continuous === true ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>` : lengthRows}
    `;

    const symbolEl = this.panel.querySelector('#prop-meas-symbol');
    symbolEl?.addEventListener('change', () => {
      this._push();
      mgr.setLabel(m.id, symbolEl.value);
      this._measurementHooks?.onChanged?.();
    });
    symbolEl?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        symbolEl.blur();
      }
    });

    this.panel.querySelector('#prop-meas-dynamic')?.addEventListener('change', e => {
      this._push();
      mgr.setDynamic(m.id, !!e.target.checked);
      this._measurementHooks?.onChanged?.();
    });

    this.panel.querySelector('#prop-meas-continuous')?.addEventListener('change', e => {
      this._push();
      mgr.setContinuous(m.id, !!e.target.checked);
      this._measurementHooks?.onChanged?.();
    });

    this.panel.querySelector('#prop-meas-component')?.addEventListener('change', e => {
      this._push();
      mgr.setComponent(m.id, e.target.value);
      this._measurementHooks?.onChanged?.();
      this._buildMeasurementPanel(m.id);
    });
    this.panel.querySelector('#prop-meas-elbow')?.addEventListener('change', e => {
      this._push();
      mgr.setElbow(m.id, e.target.value);
      this._measurementHooks?.onChanged?.();
    });
  }

  /** Text label (inline on body or callout to a point / object). @param {string} id */
  _buildLabelPanel(id) {
    const mgr = this._measurementHooks?.getLabelManager?.();
    const l = mgr?.getById?.(id);
    if (!l) { this.clear(); return; }

    this._current = { type: 'label', id: l.id };
    const attachMode = l.placement === 'inline'
      ? 'inline'
      : l.targetAnchor
        ? 'callout-target'
        : 'callout-world';
    const placement = l.placement === 'inline' ? 'Inside object (centred)'
      : l.placement === 'callout'
        ? (l.targetAnchor
          ? (l.dynamic !== false ? 'Callout · follows target' : 'Callout · fixed point')
          : 'Callout · world point')
        : 'Standalone';
    const hostLabel = mgr.hostBodyLabel?.(l);

    let anchorRows = '';
    if (l.placement === 'inline') {
      anchorRows = `
      <div class="prop-row">
        <span class="prop-label">Body</span>
        <span class="prop-value" style="opacity:0.85">${_escapeHtml(l.bodyLabel ?? hostLabel ?? '—')}</span>
      </div>`;
    } else if (l.placement === 'callout') {
      const targetSummary = l.targetAnchor
        ? _escapeHtml(_anchorSummaryLabel(l.targetAnchor))
        : `(${ (l.pointM?.x ?? 0).toFixed(3) }, ${ (l.pointM?.y ?? 0).toFixed(3) }) m`;
      anchorRows = `
      <div class="prop-row">
        <span class="prop-label">Target</span>
        <span class="prop-value" style="opacity:0.85">${targetSummary}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Follow target</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-label-dynamic" ${l.dynamic !== false && !!l.targetAnchor ? 'checked' : ''} ${l.targetAnchor ? '' : 'disabled'}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      <div class="prop-row">
        <span class="prop-label">Text offset x (m)</span>
        <span class="prop-value" style="opacity:0.85">${(l.textOffsetM?.x ?? 0).toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Text offset y (m)</span>
        <span class="prop-value" style="opacity:0.85">${(l.textOffsetM?.y ?? 0).toFixed(3)}</span>
      </div>`;
    } else if (l.placement === 'standalone') {
      anchorRows = `
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <span class="prop-value" style="opacity:0.85">${(l.positionM?.x ?? 0).toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <span class="prop-value" style="opacity:0.85">${(l.positionM?.y ?? 0).toFixed(3)}</span>
      </div>`;
    }

    this.panel.innerHTML = `
      <div class="prop-section-title">Label</div>
      <div class="prop-row">
        <span class="prop-label">Text</span>
        <input class="prop-value" id="prop-label-text" type="text" value="${_escapeHtml(l.text)}"
          placeholder="theta_0, \\theta_{0}, $x$" title="LaTeX-style math: theta_0, \\omega, Greek names"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">Font size (px)</span>
        <input class="prop-value" id="prop-label-font" type="number" min="8" max="48" step="1" value="${l.fontSize ?? 13}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">Italic</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-label-italic" ${l.italic ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      <div class="prop-row">
        <span class="prop-label">Attach</span>
        <select class="prop-value" id="prop-label-attach-mode">
          <option value="inline" ${attachMode === 'inline' ? 'selected' : ''}>Inside object</option>
          <option value="callout-target" ${attachMode === 'callout-target' ? 'selected' : ''}>Point to object</option>
          <option value="callout-world" ${attachMode === 'callout-world' ? 'selected' : ''}>Point to world</option>
        </select>
      </div>
      <div class="prop-row">
        <span class="prop-label"></span>
        <button type="button" class="prop-action-btn" id="prop-label-pick">Pick on canvas…</button>
      </div>
      <div class="prop-row">
        <span class="prop-label">Placement</span>
        <span class="prop-value" style="opacity:0.85">${placement}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Visible</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-label-visible" ${l.visible !== false ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      ${anchorRows}
    `;

    this.panel.querySelector('#prop-label-text')?.addEventListener('change', e => {
      this._push();
      mgr.setText(l.id, e.target.value);
      this._measurementHooks?.onChanged?.();
      this.show({ type: 'label', id: l.id });
    });

    this.panel.querySelector('#prop-label-font')?.addEventListener('change', e => {
      this._push();
      mgr.setFontSize(l.id, parseFloat(e.target.value));
      this._measurementHooks?.onChanged?.();
    });

    this.panel.querySelector('#prop-label-italic')?.addEventListener('change', e => {
      this._push();
      mgr.setItalic(l.id, !!e.target.checked);
      this._measurementHooks?.onChanged?.();
    });

    this.panel.querySelector('#prop-label-pick')?.addEventListener('click', () => {
      const mode = this.panel.querySelector('#prop-label-attach-mode')?.value ?? 'inline';
      mgr.beginPick(l.id, mode);
    });

    this.panel.querySelector('#prop-label-attach-mode')?.addEventListener('change', e => {
      const mode = e.target.value;
      this._push();
      const result = mgr.setAttachMode?.(l.id, mode) ?? 'pick';
      this._measurementHooks?.onChanged?.();
      if (result === 'done') this.show({ type: 'label', id: l.id });
    });

    this.panel.querySelector('#prop-label-visible')?.addEventListener('change', e => {
      this._push();
      mgr.setVisible(l.id, !!e.target.checked);
      this._measurementHooks?.onChanged?.();
    });

    this.panel.querySelector('#prop-label-dynamic')?.addEventListener('change', e => {
      this._push();
      mgr.setDynamic(l.id, !!e.target.checked);
      this._measurementHooks?.onChanged?.();
      this.show({ type: 'label', id: l.id });
    });
  }

  /**
   * Constraint-linked multi-body aggregate (not a sticky weld compound).
   * @param {{ key: string, memberIds: number[] }} selection
   */
  _buildAggregatePanel(selection) {
    const memberIds = selection.memberIds ?? [];
    const members = memberIds
      .map(id => this.engine.bodies.find(b => b.id === id))
      .filter(Boolean);
    this._current = {
      type: 'aggregate',
      key: selection.key,
      aggId: selection.aggId ?? null,
      memberIds: [...memberIds],
    };
    const st = aggregateState(members);
    const folderName = selection.aggId
      ? (this.engine._uiAggregates ?? []).find(a => a.id === selection.aggId)?.name
      : null;
    const title = folderName || 'Linked aggregate';
    const rows = members.map(b => `
      <button type="button" class="prop-component-row" data-member-id="${b.id}" title="Inspect ${bodyDisplayName(b)}">
        <span class="prop-component-name">${_escapeHtml(bodyDisplayName(b))}</span>
        <span class="prop-component-meta">${_escapeHtml(b._newtonType ?? 'body')} · ${(b.mass ?? 0).toFixed(3)} kg</span>
      </button>
    `).join('');

    const links = (this.engine.constraints ?? [])
      .filter(c => {
        const a = c.bodyA?.id;
        const b = c.bodyB?.id;
        return a != null && b != null && memberIds.includes(a) && memberIds.includes(b);
      })
      .map(c => `<li>${_escapeHtml(c.label || c._newtonType || `link ${c.id}`)}</li>`)
      .join('');

    this.panel.innerHTML = `
      <div class="prop-section-title">${_escapeHtml(title)}</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.xm} COM (m)</span>
        <span class="prop-value" id="prop-agg-x" style="border:none">${st.comM.x.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.ym} COM (m)</span>
        <span class="prop-value" id="prop-agg-y" style="border:none">${st.comM.y.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">total mass (kg)</span>
        <span class="prop-value" id="prop-agg-mass" style="border:none">${st.mass.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.L} about COM</span>
        <span class="prop-value" id="prop-agg-L" style="border:none">${st.LaboutCom.toFixed(4)}</span>
      </div>
      <div class="prop-section-title" style="margin-top:10px">Members</div>
      <div class="prop-component-list" id="prop-agg-members">${rows || '<p class="hint">No members</p>'}</div>
      <div class="prop-section-title" style="margin-top:10px">Constraints</div>
      <ul class="prop-agg-links" style="margin:0;padding-left:16px;font-size:11px">${links || '<li class="hint">None</li>'}</ul>
    `;

    this.panel.querySelector('#prop-agg-members')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-member-id]');
      if (!btn) return;
      const id = parseInt(btn.getAttribute('data-member-id'), 10);
      if (!Number.isFinite(id)) return;
      this._current = { type: 'body', id, partIndex: null };
      this._onFocusedBodyChange?.(id, null);
      const body = this.engine.bodies.find(b => b.id === id);
      if (body) this._showBody(body);
    });
  }

  /** Call every render frame to keep live readouts fresh. */
  refresh() {
    if (!this._current || this._suppressRefresh) return;
    if (this._current.type === 'measurement') {
      const mgr = this._measurementHooks?.getManager?.();
      const m = mgr?.getById?.(this._current.id);
      if (!m) { this.clear(); return; }
      if (m.kind === 'angle') {
        const deg = mgr.measureAngleDeg(m.id);
        const el = this.panel.querySelector('#prop-meas-angle');
        if (el) el.textContent = deg == null || !Number.isFinite(deg) ? '—' : `${deg.toFixed(1)}°`;
      } else if (m.kind === 'length') {
        const parts = mgr.measureLengthParts(m.id);
        const val = mgr.measureLengthM(m.id);
        const fmt = (n) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(3);
        this._setVField('#prop-meas-length', fmt(val));
        this._setVField('#prop-meas-dist', fmt(parts?.distance));
        this._setVField('#prop-meas-dx', fmt(parts?.dx));
        this._setVField('#prop-meas-dy', fmt(parts?.dy));
        this._setVField('#prop-meas-manh', fmt(parts?.manhattan));
      }
      return;
    }
    if (this._current.type === 'aggregate') {
      const members = (this._current.memberIds ?? [])
        .map(id => this.engine.bodies.find(b => b.id === id))
        .filter(Boolean);
      if (!members.length) { this.clear(); return; }
      const st = aggregateState(members);
      this._setVField('#prop-agg-x', st.comM.x.toFixed(3));
      this._setVField('#prop-agg-y', st.comM.y.toFixed(3));
      this._setVField('#prop-agg-mass', st.mass.toFixed(3));
      this._setVField('#prop-agg-L', st.LaboutCom.toFixed(4));
      return;
    }
    if (this._current.type === 'rope') {
      const ropeId = this._current.ropeId;
      const nodes = ropeId ? listRopeSegments(this.engine, ropeId) : [];
      if (!nodes.length) { this.clear(); return; }
      this._current.memberIds = nodes.map(n => n.id);
      const pts = ropeCenterlineWorldPx(nodes);
      let lengthM = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        lengthM += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) / PX_PER_M;
      }
      this._setVField('#prop-rope-len', lengthM.toFixed(3));
      const st = aggregateState(nodes);
      this._setVField('#prop-agg-x', st.comM.x.toFixed(3));
      this._setVField('#prop-agg-y', st.comM.y.toFixed(3));
      this._setVField('#prop-rope-att-a', _ropeAttachLabel(this.engine, ropeId, 'A'));
      this._setVField('#prop-rope-att-b', _ropeAttachLabel(this.engine, ropeId, 'B'));
      return;
    }
    if (this._current.type === 'constraint') {
      const c = this.engine.constraints.find(x => x.id === this._current.id);
      if (!c) { this.clear(); return; }
      this._setVField('#prop-con-len', pxToM(c.length).toFixed(3));
      if (c._newtonType === 'spring') {
        this._setVField('#prop-con-stiff', (c._kNm ?? 40).toFixed(1));
        this._setVField('#prop-con-max-ext', c._maxExtensionM != null ? c._maxExtensionM.toFixed(3) : '');
        this._setVField('#prop-con-max-com', c._maxCompressionM != null ? c._maxCompressionM.toFixed(3) : '');
      }
      return;
    }
    if (this._current.type === 'label') {
      const mgr = this._measurementHooks?.getLabelManager?.();
      if (!mgr?.getById?.(this._current.id)) { this.clear(); return; }
      return;
    }
    const body = this.engine.bodies.find(b => b.id == this._current.id);
    if (!body) { this.clear(); return; }
    if (this._current.partIndex != null && body._newtonType === 'compound') {
      const part = body.parts?.[this._current.partIndex + 1];
      if (part) {
        const { xm, ym } = worldPxToDisplayedM(part.position.x, part.position.y);
        this._setVField('#prop-part-x', xm.toFixed(3));
        this._setVField('#prop-part-y', ym.toFixed(3));
      }
      return;
    }
    this._updateLive(body);
  }

  _showBody(body) {
    if (body._ropeSegment && body._ropeId) {
      this._buildRopePanel(body._ropeId);
      return;
    }
    this._current = {
      type: 'body',
      id: body.id,
      partIndex: this._current?.id === body.id ? (this._current.partIndex ?? null) : null,
    };
    const nt = body._newtonType;
    if (nt === 'metric-basis') this._buildMetricBasisPanel(body);
    else if (nt === 'point-mass') this._buildRoundBodyPanel(body, {
      title: 'Point',
      defaultRadiusM: DEFAULT_CIRCLE_RADIUS_M,
      showHollow: true,
    });
    else if (nt === 'ball') this._buildRoundBodyPanel(body, {
      title: 'Ball',
      defaultRadiusM: DEFAULT_BALL_RADIUS_M,
      showHollow: false,
    });
    else if (nt === 'ground') this._buildGroundPanel(body);
    else if (nt === 'box') this._buildBoxPanel(body);
    else if (nt === 'wedge') this._buildWedgePanel(body);
    else if (nt === 'compound') this._buildCompoundPanel(body);
    else if (nt === 'anchor') this._buildAnchorPanel(body);
    else this._buildGenericPanel(body);
  }

  _buildCompoundPanel(body) {
    const { xm: xM0, ym: yM0 } = worldPxToDisplayedM(body.position.x, body.position.y);
    const components = this._compoundComponentRowsHtml(body);

    this.panel.innerHTML = `
      <div class="prop-section-title">Group</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.xm} (m)</span>
        <span class="prop-value" id="prop-x" style="border:none">${xM0.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.ym} (m)</span>
        <span class="prop-value" id="prop-y" style="border:none">${yM0.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">total mass (kg)</span>
        <span class="prop-value" id="prop-mass" style="border:none">${body.mass.toFixed(3)}</span>
      </div>
      ${this._stickyToggleHtml(!!body._stickOnContact)}
      <div class="prop-section-title" style="margin-top:10px">Components</div>
      <div class="prop-component-list" id="prop-component-list">
        ${components}
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete group</button>
    `;
    this.panel.querySelector('#prop-sticky')?.addEventListener('change', e => {
      this._push();
      const on = !!e.target.checked;
      body._stickOnContact = on;
      if (body._weldParts) {
        for (const p of body._weldParts) p.stickOnContact = on;
      }
      if (on) body.restitution = 0;
    });
    this.panel.querySelector('#prop-component-list')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-part-index]');
      if (!btn) return;
      const partIndex = parseInt(btn.getAttribute('data-part-index'), 10);
      if (!Number.isFinite(partIndex)) return;
      this._selectCompoundPart(body, partIndex);
    });
    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      this._push();
      this.engine.removeBody(body);
      this.clear();
    });
  }

  /**
   * Clickable roster of component masses inside a sticky group.
   * @param {import('matter-js').Body} body
   */
  _compoundComponentRowsHtml(body) {
    const nParts = Math.max(0, (body.parts?.length ?? 1) - 1);
    if (!nParts) return '<p class="hint" style="font-size:10px;margin:0">No components</p>';
    const rows = [];
    for (let i = 0; i < nParts; i++) {
      const meta = body._weldParts?.[i] ?? {};
      const part = body.parts?.[i + 1];
      const name = this._partDisplayName(meta, i, part);
      const typeLabel = this._partTypeLabel(meta.type ?? part?._partType);
      const mass = part?.mass ?? (body.mass / nParts);
      rows.push(`
        <button type="button" class="prop-component-row" data-part-index="${i}" title="Inspect ${name}">
          <span class="prop-component-name">${_escapeHtml(name)}</span>
          <span class="prop-component-meta">${_escapeHtml(typeLabel)} · ${mass.toFixed(3)} kg</span>
        </button>
      `);
    }
    return rows.join('');
  }

  /**
   * Focus a component within a sticky group.
   * @param {import('matter-js').Body} body
   * @param {number} partIndex
   */
  _selectCompoundPart(body, partIndex) {
    this._current = { type: 'body', id: body.id, partIndex };
    this._onFocusedBodyChange?.(body.id, partIndex);
    this._buildWeldPartPanel(body, partIndex);
  }

  /** Return to the group-level inspector. */
  _selectCompoundGroup(body) {
    this._current = { type: 'body', id: body.id, partIndex: null };
    this._onFocusedBodyChange?.(body.id, null);
    this._buildCompoundPanel(body);
  }

  _buildWeldPartPanel(body, partIndex) {
    const meta = body._weldParts?.[partIndex] ?? {};
    const part = body.parts?.[partIndex + 1];
    const nParts = Math.max(0, (body.parts?.length ?? 1) - 1);
    const type = meta.type ?? 'box';
    const name = this._partDisplayName(meta, partIndex, part);
    const mass = part?.mass ?? (body.mass / Math.max(nParts, 1));
    const { xm, ym } = worldPxToDisplayedM(
      part?.position.x ?? body.position.x,
      part?.position.y ?? body.position.y,
    );
    const stickyOn = meta.stickOnContact === true;

    let geomRows = '';
    if (type === 'box') {
      const wM = pxToM(meta.width ?? 40).toFixed(3);
      const hM = pxToM(meta.height ?? 40).toFixed(3);
      geomRows = `
        <div class="prop-row">
          <span class="prop-label">width (m)</span>
          <input class="prop-value" id="prop-part-w" type="number" step="0.01" min="0.05" value="${wM}"/>
        </div>
        <div class="prop-row">
          <span class="prop-label">height (m)</span>
          <input class="prop-value" id="prop-part-h" type="number" step="0.01" min="0.05" value="${hM}"/>
        </div>`;
    } else if (type === 'point-mass' || type === 'ball') {
      const rM = pxToM(meta.radius ?? 10).toFixed(3);
      geomRows = `
        <div class="prop-row">
          <span class="prop-label">radius (m)</span>
          <input class="prop-value" id="prop-part-r" type="number" step="0.01" min="0.02" value="${rM}"/>
        </div>`;
    }

    this.panel.innerHTML = `
      <button type="button" class="prop-back-btn" id="prop-back-group" title="Back to group">← Group</button>
      <div class="prop-section-title">${_escapeHtml(name)}</div>
      <div class="prop-row">
        <span class="prop-label">label</span>
        <input class="prop-value" id="prop-part-label" type="text" value="${_escapeAttr(meta.label ?? '')}" placeholder="${_escapeAttr(name)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <span class="prop-value" id="prop-part-x" style="border:none">${xm.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <span class="prop-value" id="prop-part-y" style="border:none">${ym.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">mass (kg)</span>
        <input class="prop-value" id="prop-part-mass" type="number" step="0.1" min="0.01" value="${mass.toFixed(3)}"/>
      </div>
      ${geomRows}
      ${this._stickyToggleHtml(stickyOn)}
      <button class="prop-delete-btn" id="prop-delete">Delete group</button>
    `;

    const applyPatch = (patch) => {
      this._push();
      const next = updateCompoundPart(this.engine, body, partIndex, patch);
      if (!next) return;
      this._current = { type: 'body', id: next.id, partIndex };
      this._onFocusedBodyChange?.(next.id, partIndex);
      if (next._newtonType === 'compound') this._buildWeldPartPanel(next, partIndex);
      else this._showBody(next);
    };

    this.panel.querySelector('#prop-back-group')?.addEventListener('click', () => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id) ?? body;
      if (b?._newtonType === 'compound') this._selectCompoundGroup(b);
    });
    this.panel.querySelector('#prop-part-label')?.addEventListener('change', e => {
      const raw = String(e.target.value ?? '').trim();
      applyPatch({ label: raw || null });
    });
    this.panel.querySelector('#prop-part-mass')?.addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (v > 0) applyPatch({ mass: v });
    });
    this.panel.querySelector('#prop-part-w')?.addEventListener('change', e => {
      applyPatch({ width: mToPx(parseFloat(e.target.value)) });
    });
    this.panel.querySelector('#prop-part-h')?.addEventListener('change', e => {
      applyPatch({ height: mToPx(parseFloat(e.target.value)) });
    });
    this.panel.querySelector('#prop-part-r')?.addEventListener('change', e => {
      applyPatch({ radius: mToPx(parseFloat(e.target.value)) });
    });
    this.panel.querySelector('#prop-sticky')?.addEventListener('change', e => {
      applyPatch({ stickOnContact: !!e.target.checked });
    });
    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      this._push();
      const b = this.engine.bodies.find(x => x.id === this._current?.id);
      if (b) this.engine.removeBody(b);
      this.clear();
    });
  }

  _buildMetricBasisPanel(body) {
    const xM = pxToM(body.position.x).toFixed(2);
    const yM = pxToM(body.position.y).toFixed(2);
    this.panel.innerHTML = `
      <div class="prop-section-title">Metric basis</div>
      <div class="prop-section-title" style="margin-top:8px">World position</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <input class="prop-value" id="prop-x" type="number" step="0.1" value="${xM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <input class="prop-value" id="prop-y" type="number" step="0.1" value="${yM}"/>
      </div>
    `;
    this.panel.querySelector('#prop-x')?.addEventListener('change', e => {
      this._push();
      const xPx = snapWorldCoord(mToPx(parseFloat(e.target.value)), this._snapOn());
      Body.setPosition(body, { x: xPx, y: body.position.y });
    });
    this.panel.querySelector('#prop-y')?.addEventListener('change', e => {
      this._push();
      const yPx = snapWorldCoord(mToPx(parseFloat(e.target.value)), this._snapOn());
      Body.setPosition(body, { x: body.position.x, y: yPx });
    });
  }

  _buildRoundBodyPanel(body, { title, defaultRadiusM, showHollow = false }) {
    const { xm: xM0, ym: yM0 } = worldPxToDisplayedM(body.position.x, body.position.y);
    const xM    = xM0.toFixed(2);
    const yM    = yM0.toFixed(2);
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const speed = Math.hypot(vxMs, vyMs).toFixed(3);
    const angleDeg = (Math.atan2(vyMs, vxMs) * 180 / Math.PI).toFixed(1);

    const rM = pxToM(body._radius ?? body.circleRadius ?? mToPx(defaultRadiusM)).toFixed(2);
    const hollowChecked = body._hollow === true ? 'checked' : '';
    const hollowRow = showHollow ? `
      <div class="prop-row">
        <span class="prop-label">Hollow</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-hollow" ${hollowChecked}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>` : '';

    this.panel.innerHTML = `
      <div class="prop-section-title">${title}</div>
      <div class="prop-section-title" style="margin-top:8px">Position</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <input class="prop-value" id="prop-x" type="number" step="0.1" value="${xM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <input class="prop-value" id="prop-y" type="number" step="0.1" value="${yM}"/>
      </div>

      <div class="prop-section-title" style="margin-top:8px">Initial velocity ${MATH.v0}</div>
      <div class="prop-row">
        <span class="prop-label">|${MATH.v0}| (m/s)</span>
        <input class="prop-value" id="prop-speed" type="number" step="0.1" min="0" value="${speed}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.theta} (°)</span>
        <input class="prop-value" id="prop-angle" type="number" step="1" min="-180" max="180" value="${angleDeg}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.vx} (m/s)</span>
        <input class="prop-value" id="prop-vx" type="number" step="0.1" value="${vxMs.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.vy} (m/s)</span>
        <input class="prop-value" id="prop-vy" type="number" step="0.1" value="${vyMs.toFixed(3)}"/>
      </div>
      ${this._appliedForceRowsHtml(body)}
      ${this._angularRowsHtml(body)}

      <div class="prop-section-title" style="margin-top:8px">Properties</div>
      ${this._anchoredRowHtml(body)}
      ${hollowRow}
      <div class="prop-row">
        <span class="prop-label">mass (kg)</span>
        <input class="prop-value" id="prop-mass" type="number" step="0.1" min="0.01" value="${bodyDisplayMass(body).toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">radius (m)</span>
        <input class="prop-value" id="prop-radius" type="number" step="0.01" min="0.04" value="${rM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">restitution</span>
        <input class="prop-value" id="prop-rest" type="number" step="0.05" min="0" max="1" value="${body.restitution.toFixed(2)}"/>
      </div>
      ${this._stickyToggleHtml(!!body._stickOnContact)}

      <div class="prop-section-title" style="margin-top:8px">Friction (this surface)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.mus}</span>
        <input class="prop-value" id="prop-mus" type="number" step="0.01" min="0" max="5" value="${(body._muS ?? body.frictionStatic ?? 0.4).toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.muk}</span>
        <input class="prop-value" id="prop-muk" type="number" step="0.01" min="0" max="5" value="${(body._muK ?? body.friction ?? 0.3).toFixed(3)}"/>
      </div>
      <button class="prop-delete-btn" id="prop-delete" style="margin-top:10px">Delete</button>
    `;

    this._bindProjectileInputs(body, { defaultRadiusM, showHollow });
    this._bindAnchoredToggle(body);
    this._bindStickyToggle(body);
    this._bindAppliedForceInputs(body._newtonType);
    this._bindAngularInputs(body._newtonType);
    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      this._push();
      this.engine.removeBody(body);
      this.clear();
    });
  }

  _bindProjectileInputs(body, { defaultRadiusM, showHollow = false } = {}) {
    this._bindV0Inputs(body);

    this.panel.querySelector('#prop-x')?.addEventListener('change', e => {
      this._push();
      const cur = worldPxToDisplayedM(body.position.x, body.position.y);
      const { x: xPx, y: yKeep } = displayedMToWorldPx(parseFloat(e.target.value), cur.ym);
      const nx = snapWorldCoord(xPx, this._snapOn());
      const ny = snapWorldCoord(yKeep, this._snapOn());
      Body.setPosition(body, { x: nx, y: ny });
      this._syncBodyRopes(body);
    });
    this.panel.querySelector('#prop-y')?.addEventListener('change', e => {
      this._push();
      const cur = worldPxToDisplayedM(body.position.x, body.position.y);
      const { x: xKeep, y: yPx } = displayedMToWorldPx(cur.xm, parseFloat(e.target.value));
      const nx = snapWorldCoord(xKeep, this._snapOn());
      const ny = snapWorldCoord(yPx, this._snapOn());
      Body.setPosition(body, { x: nx, y: ny });
      this._syncBodyRopes(body);
    });
    this.panel.querySelector('#prop-mass')?.addEventListener('change', e => {
      this._push();
      const v = parseFloat(e.target.value);
      if (v > 0) setBodyMass(body, v);
    });
    this.panel.querySelector('#prop-rest')?.addEventListener('change', e => {
      this._push();
      body.restitution = parseFloat(e.target.value);
    });
    this.panel.querySelector('#prop-radius')?.addEventListener('change', e => {
      this._push();
      const newR = Math.max(4, mToPx(parseFloat(e.target.value)));
      scaleCircleTo(body, newR);
    });
    if (showHollow) {
      this.panel.querySelector('#prop-hollow')?.addEventListener('change', e => {
        this._push();
        body._hollow = !!e.target.checked;
        applyCircleInertia(body);
      });
    }
    this._bindFrictionInputs(() => body);
  }

  /** Polar + Cartesian v₀ editors (projectile UI), only modifies linear velocity: no geometry. */
  _bindV0Inputs(body) {
    const getSpeed = () => parseFloat(this.panel.querySelector('#prop-speed')?.value ?? 0);
    const getAngle = () => parseFloat(this.panel.querySelector('#prop-angle')?.value ?? 0);
    const getVx    = () => parseFloat(this.panel.querySelector('#prop-vx')?.value    ?? 0);
    const getVy    = () => parseFloat(this.panel.querySelector('#prop-vy')?.value    ?? 0);

    const applyPolar = () => {
      this._push();
      const rad  = getAngle() * Math.PI / 180;
      const spd  = Math.max(0, getSpeed());
      const vxMs = spd * Math.cos(rad);
      const vyMs = spd * Math.sin(rad);  // positive = upward in display
      this._setVField('#prop-vx', vxMs.toFixed(3));
      this._setVField('#prop-vy', vyMs.toFixed(3));
      // Keep θ fixed when editing |v| (or θ): grid tip-snap would rotate the vector.
      const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
      this.applyVelocity(body, vx, vy, { snapGrid: false });
    };

    const applyCartesian = () => {
      this._push();
      const vxMs = getVx();
      const vyMs = getVy();
      const spd  = Math.hypot(vxMs, vyMs);
      const deg  = (Math.atan2(vyMs, vxMs) * 180 / Math.PI).toFixed(1);
      this._setVField('#prop-speed', spd.toFixed(3));
      this._setVField('#prop-angle', deg);
      const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
      this.applyVelocity(body, vx, vy);
    };

    this.panel.querySelector('#prop-speed')?.addEventListener('change', applyPolar);
    this.panel.querySelector('#prop-angle')?.addEventListener('change', applyPolar);
    this.panel.querySelector('#prop-vx')?.addEventListener('change', applyCartesian);
    this.panel.querySelector('#prop-vy')?.addEventListener('change', applyCartesian);
  }

  /** Rebuild only the velocity sub-fields without rebuilding the whole panel. */
  _rebuildVelocityInputs(body) {
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const speed = Math.hypot(vxMs, vyMs).toFixed(3);
    const angleDeg = (Math.atan2(vyMs, vxMs) * 180 / Math.PI).toFixed(1);
    this._setVField('#prop-speed', speed);
    this._setVField('#prop-angle', angleDeg);
    this._setVField('#prop-vx', vxMs.toFixed(3));
    this._setVField('#prop-vy', vyMs.toFixed(3));
  }

  _setVField(sel, val) {
    const el = this.panel.querySelector(sel);
    if (!el || document.activeElement === el) return;
    if ('value' in el && el.tagName !== 'SPAN') el.value = val;
    else el.textContent = val;
  }

  /** Keep position / layout readouts in sync while the sim runs (skip focused inputs). */
  _rebuildPositionInputs(body) {
    const nt = body._newtonType;
    if (nt === 'point-mass' || nt === 'ball' || nt === 'box' || nt === 'wedge' || nt === 'anchor') {
      const origin = nt === 'wedge' ? wedgeAABBCenterWorld(body) : body.position;
      const { xm, ym } = worldPxToDisplayedM(origin.x, origin.y);
      this._setVField('#prop-x', xm.toFixed(2));
      this._setVField('#prop-y', ym.toFixed(2));
      if (nt === 'box') {
        const w = body._width ?? 40;
        const h = body._height ?? 40;
        this._setVField('#prop-box-w', pxToM(w).toFixed(2));
        this._setVField('#prop-box-h', pxToM(h).toFixed(2));
      } else if (nt === 'wedge') {
        this._setVField('#prop-wedge-w', pxToM(body._baseWidth ?? 40).toFixed(2));
        this._setVField('#prop-wedge-h', pxToM(body._height ?? 40).toFixed(2));
        this._setVField('#prop-wedge-foot', ((body._footAngle ?? defaultWedgeFootAngle(body._baseWidth, body._height)) * 180 / Math.PI).toFixed(1));
      }
    } else if (nt === 'ground') {
      const w = body._width ?? 400;
      const h = body._height ?? 20;
      const { xm, ym } = worldPxToDisplayedM(body.position.x, body.position.y);
      this._setVField('#prop-ground-cx', xm.toFixed(2));
      this._setVField('#prop-ground-cy', ym.toFixed(2));
      this._setVField('#prop-ground-w', pxToM(w).toFixed(2));
      this._setVField('#prop-ground-h', pxToM(h).toFixed(2));
      this._setVField('#prop-ground-theta', (body.angle * 180 / Math.PI).toFixed(1));
    } else if (!body.isStatic) {
      const { xm, ym } = worldPxToDisplayedM(body.position.x, body.position.y);
      this._setVField('#prop-x', xm.toFixed(2));
      this._setVField('#prop-y', ym.toFixed(2));
    }
  }

  _groundBody() {
    if (!this._current) return null;
    return this.engine.bodies.find(b => b.id === this._current.id && b._newtonType === 'ground');
  }

  /** Replace ground with a fresh static rect (centre in physics px, angle in rad). */
  _replaceGround(body, cx, cy, width, height, angleRad = 0) {
    width  = Math.max(12, width);
    height = Math.max(8, height);
    const neo = createGround(cx, cy, width, height, {
      muK: body._muK ?? body.friction,
      muS: body._muS ?? body.frictionStatic ?? body.friction,
      restitution: body.restitution,
      angle: angleRad,
    });
    if (body.label) neo.label = body.label;

    retargetBodyAttachments(this.engine, body, neo);
    this._push();
    this.engine.removeBody(body);
    this.engine.addBody(neo);

    const id = neo.id;
    this._onFocusedBodyChange?.(id);
    this.show({ type: 'body', id });
  }

  _buildGroundPanel(body) {
    const w   = body._width  ?? 400;
    const h   = body._height ?? 20;
    const { xm: cxM0, ym: cyM0 } = worldPxToDisplayedM(body.position.x, body.position.y);
    const cxM = cxM0.toFixed(2);
    const cyM = cyM0.toFixed(2);
    const wM  = pxToM(w).toFixed(2);
    const hM  = pxToM(h).toFixed(2);
    const thetaDeg = (body.angle * 180 / Math.PI).toFixed(1);
    const muK = (body._muK ?? body.friction).toFixed(3);
    const muS = (body._muS ?? body.frictionStatic ?? body.friction * 1.3).toFixed(3);

    this.panel.innerHTML = `
      <div class="prop-section-title">Ground</div>
      <div class="prop-section-title" style="margin-top:8px">Layout</div>
      <div class="prop-row">
        <span class="prop-label">centre x (m)</span>
        <input class="prop-value" id="prop-ground-cx" type="number" step="0.1" value="${cxM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">centre y (m)</span>
        <input class="prop-value" id="prop-ground-cy" type="number" step="0.1" value="${cyM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.theta} (°)</span>
        <input class="prop-value" id="prop-ground-theta" type="number" step="1" value="${thetaDeg}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">width (m)</span>
        <input class="prop-value" id="prop-ground-w" type="number" step="0.1" min="0.12" value="${wM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">thickness (m)</span>
        <input class="prop-value" id="prop-ground-h" type="number" step="0.01" min="0.08" value="${hM}"/>
      </div>

      <div class="prop-section-title" style="margin-top:8px">Material</div>
      <div class="prop-row">
        <span class="prop-label">restitution</span>
        <input class="prop-value" id="prop-rest" type="number" step="0.05" min="0" max="1" value="${body.restitution.toFixed(2)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Friction (surface)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.mus}</span>
        <input class="prop-value" id="prop-mus" type="number" step="0.01" min="0" max="5" value="${muS}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.muk}</span>
        <input class="prop-value" id="prop-muk" type="number" step="0.01" min="0" max="5" value="${muK}"/>
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete ground</button>
    `;

    const commitLayout = () => {
      const g = this._groundBody();
      if (!g) return;
      const gh = g._height ?? 20;
      const rawXM = parseFloat(this.panel.querySelector('#prop-ground-cx')?.value
        ?? worldPxToDisplayedM(g.position.x, g.position.y).xm);
      const rawYM = parseFloat(this.panel.querySelector('#prop-ground-cy')?.value
        ?? worldPxToDisplayedM(g.position.x, g.position.y).ym);
      const thetaDeg = parseFloat(this.panel.querySelector('#prop-ground-theta')?.value ?? '0');
      const angleRad = (thetaDeg * Math.PI) / 180;
      const nw = mToPx(parseFloat(this.panel.querySelector('#prop-ground-w')?.value ?? pxToM(g._width ?? 400)));
      const nh = mToPx(parseFloat(this.panel.querySelector('#prop-ground-h')?.value ?? pxToM(gh)));
      const { x: cxWorldPx, y: cyWorldPx } = displayedMToWorldPx(rawXM, rawYM);
      const nx = snapWorldCoord(cxWorldPx, this._snapOn());
      const ny = snapWorldCoord(cyWorldPx, this._snapOn());
      this._replaceGround(g, nx, ny, nw, nh, angleRad);
    };

    this.panel.querySelector('#prop-ground-cx')?.addEventListener('change', commitLayout);
    this.panel.querySelector('#prop-ground-cy')?.addEventListener('change', commitLayout);
    this.panel.querySelector('#prop-ground-theta')?.addEventListener('change', commitLayout);
    this.panel.querySelector('#prop-ground-w')?.addEventListener('change', commitLayout);
    this.panel.querySelector('#prop-ground-h')?.addEventListener('change', commitLayout);

    this.panel.querySelector('#prop-rest')?.addEventListener('change', e => {
      const g = this._groundBody();
      if (!g) return;
      this._push();
      g.restitution = parseFloat(e.target.value);
    });
    this._bindFrictionInputs(() => this._groundBody());

    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      const g = this._groundBody();
      if (!g) return;
      this._push();
      this.engine.removeBody(g);
      this.clear();
    });
  }

  _constraintById() {
    if (!this._current || this._current.type !== 'constraint') return null;
    return this.engine.constraints.find(x => x.id === this._current.id) ?? null;
  }

  _buildConstraintPanel(c) {
    this._current = { type: 'constraint', id: c.id };
    const nt = c._newtonType ?? 'link';
    const lenM = pxToM(c.length).toFixed(3);
    const springRows = nt === 'spring' ? `
      <div class="prop-section-title" style="margin-top:8px">Spring (Hooke's law)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.k} (N/m)</span>
        <input class="prop-value" id="prop-con-stiff" type="number" step="5" min="1" max="2000" value="${(c._kNm ?? 40).toFixed(1)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">max extension (m)</span>
        <input class="prop-value" id="prop-con-max-ext" type="number" step="0.05" min="0" placeholder="∞" value="${c._maxExtensionM != null ? c._maxExtensionM.toFixed(3) : ''}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">max compression (m)</span>
        <input class="prop-value" id="prop-con-max-com" type="number" step="0.05" min="0" placeholder="∞" value="${c._maxCompressionM != null ? c._maxCompressionM.toFixed(3) : ''}"/>
      </div>` : '';

    this.panel.innerHTML = `
      <div class="prop-section-title">Constraint (${nt})</div>
      <div class="prop-section-title" style="margin-top:8px">${nt === 'spring' ? 'Geometry' : 'Size'}</div>
      <div class="prop-row">
        <span class="prop-label">${nt === 'spring' ? 'rest length (m)' : 'length (m)'}</span>
        <input class="prop-value" id="prop-con-len" type="number" step="0.05" min="0.05" value="${lenM}"/>
      </div>
      ${springRows}
      <button class="prop-delete-btn" id="prop-delete" style="margin-top:10px">Delete constraint</button>
    `;

    this.panel.querySelector('#prop-con-len')?.addEventListener('change', e => {
      const con = this._constraintById();
      if (!con) return;
      this._push();
      const px = mToPx(parseFloat(e.target.value));
      con.length = Math.max(5, px);
    });

    this.panel.querySelector('#prop-con-stiff')?.addEventListener('change', e => {
      const con = this._constraintById();
      if (!con || con._newtonType !== 'spring') return;
      this._push();
      const k = Math.max(1, parseFloat(e.target.value) || 40);
      con._kNm = k;
      e.target.value = k.toFixed(1);
    });

    const bindSpringLimit = (sel, field) => {
      this.panel.querySelector(sel)?.addEventListener('change', e => {
        const con = this._constraintById();
        if (!con || con._newtonType !== 'spring') return;
        this._push();
        const raw = String(e.target.value).trim();
        if (!raw) {
          con[field] = null;
          e.target.value = '';
          return;
        }
        const n = Math.max(0, parseFloat(raw));
        con[field] = n > 0 ? n : null;
        e.target.value = con[field] != null ? con[field].toFixed(3) : '';
      });
    };
    bindSpringLimit('#prop-con-max-ext', '_maxExtensionM');
    bindSpringLimit('#prop-con-max-com', '_maxCompressionM');

    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      const con = this._constraintById();
      if (!con) return;
      this._push();
      this.engine.removeConstraint(con);
      this.clear();
    });
  }

  /** Scale rectangular box dims (non-static) preserving centre. */
  _scaleBoxTo(body, nw, nh) {
    scaleBoxTo(body, nw, nh);
  }

  /**
   * Rope constraint as a single aggregate: segment count rebuilds the chain.
   * @param {string} ropeId
   */
  _buildRopePanel(ropeId) {
    const sel = ropeSelection(this.engine, ropeId);
    const nodes = ropeId ? listRopeSegments(this.engine, ropeId) : [];
    if (!sel || !nodes.length) { this.clear(); return; }

    this._current = sel;
    const nSeg = Math.max(1, nodes.length - 1);
    const totalMass = nodes.reduce((m, s) => m + (s.mass || 0), 0);
    const thickM = pxToM(2 * (nodes[0]._radius ?? mToPx(ROPE_THICKNESS_M) / 2));
    const pts = ropeCenterlineWorldPx(nodes);
    let lengthM = 0;
    const restPx = nodes.find(n => n._ropeRestLength > 0)?._ropeRestLength;
    if (restPx > 0) {
      lengthM = restPx / PX_PER_M;
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        lengthM += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) / PX_PER_M;
      }
    }
    const muK = Number(nodes[0]._muK ?? nodes[0].friction ?? 0).toFixed(3);
    const muS = Number(nodes[0]._muS ?? nodes[0].frictionStatic ?? 0).toFixed(3);
    const name = ropeDisplayName(this.engine, ropeId);
    const st = aggregateState(nodes);

    this.panel.innerHTML = `
      <div class="prop-section-title">${_escapeHtml(name)}</div>
      <div class="prop-row">
        <span class="prop-label">name</span>
        <input class="prop-value" id="prop-rope-name" type="text" value="${_escapeAttr(name)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.xm} COM (m)</span>
        <span class="prop-value" id="prop-agg-x" style="border:none">${st.comM.x.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.ym} COM (m)</span>
        <span class="prop-value" id="prop-agg-y" style="border:none">${st.comM.y.toFixed(3)}</span>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Attachments</div>
      <div class="prop-row">
        <span class="prop-label">end A</span>
        <span class="prop-value" id="prop-rope-att-a" style="border:none">${_escapeHtml(_ropeAttachLabel(this.engine, ropeId, 'A'))}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">end B</span>
        <span class="prop-value" id="prop-rope-att-b" style="border:none">${_escapeHtml(_ropeAttachLabel(this.engine, ropeId, 'B'))}</span>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Geometry</div>
      <div class="prop-row">
        <span class="prop-label">length (m)</span>
        <span class="prop-value" id="prop-rope-len" style="border:none">${lengthM.toFixed(3)}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">segments</span>
        <input class="prop-value" id="prop-rope-segs" type="number" step="1" min="${ROPE_MIN_SEGMENTS}" max="${ROPE_MAX_SEGMENTS}" value="${nSeg}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">thickness (m)</span>
        <input class="prop-value" id="prop-rope-thick" type="number" step="0.005" min="0.01" max="0.2" value="${thickM.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">total mass (kg)</span>
        <input class="prop-value" id="prop-rope-mass" type="number" step="0.1" min="0.05" value="${totalMass.toFixed(3)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Friction (surface)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.mus}</span>
        <input class="prop-value" id="prop-mus" type="number" step="0.01" min="0" max="5" value="${muS}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.muk}</span>
        <input class="prop-value" id="prop-muk" type="number" step="0.01" min="0" max="5" value="${muK}"/>
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete rope</button>
    `;

    const notifyRope = () => {
      const next = ropeSelection(this.engine, ropeId);
      if (next) this._onFocusedBodyChange?.(next);
      else this._onFocusedBodyChange?.(null);
    };

    const rebuildFromPanel = () => {
      if (!listRopeSegments(this.engine, ropeId).length) return;
      this._push();
      const n = clampRopeSegments(parseFloat(this.panel.querySelector('#prop-rope-segs')?.value) || nSeg);
      const mass = Math.max(0.05, parseFloat(this.panel.querySelector('#prop-rope-mass')?.value) || totalMass);
      const thick = Math.max(0.01, parseFloat(this.panel.querySelector('#prop-rope-thick')?.value) || thickM);
      const muk = this._parseNonNeg(this.panel.querySelector('#prop-muk'));
      const mus = Math.max(muk, this._parseNonNeg(this.panel.querySelector('#prop-mus')));
      const nameNow = String(this.panel.querySelector('#prop-rope-name')?.value ?? '').trim() || name;
      const result = rebuildRope(this.engine, ropeId, {
        segments: n,
        totalMass: mass,
        thicknessM: thick,
        muK: muk,
        muS: mus,
        ropeName: nameNow,
      });
      if (result?.bodies?.length) notifyRope();
      else {
        this._onFocusedBodyChange?.(null);
        this.clear();
      }
    };

    this.panel.querySelector('#prop-rope-name')?.addEventListener('change', e => {
      const next = String(e.target.value ?? '').trim() || name;
      this._push();
      renameRope(this.engine, ropeId, next);
      e.target.value = next;
      notifyRope();
    });
    this.panel.querySelector('#prop-rope-segs')?.addEventListener('change', rebuildFromPanel);
    this.panel.querySelector('#prop-rope-thick')?.addEventListener('change', rebuildFromPanel);
    this.panel.querySelector('#prop-rope-mass')?.addEventListener('change', rebuildFromPanel);

    this._bindFrictionInputs(() => listRopeSegments(this.engine, ropeId));

    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      this._push();
      removeRope(this.engine, ropeId);
      this._onFocusedBodyChange?.(null);
      this.clear();
    });
  }

  _buildBoxPanel(body) {
    const w   = body._width  ?? 40;
    const h   = body._height ?? 40;
    const rawK = body._muK ?? body.friction ?? 0.3;
    const rawS = body._muS ?? body.frictionStatic ?? rawK * 1.3;
    const muK = Number(rawK).toFixed(3);
    const muS = Number(rawS).toFixed(3);
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const speed = Math.hypot(vxMs, vyMs).toFixed(3);
    const angleDeg = (Math.atan2(vyMs, vxMs) * 180 / Math.PI).toFixed(1);
    const { xm: xM0, ym: yM0 } = worldPxToDisplayedM(body.position.x, body.position.y);
    const xM = xM0.toFixed(2);
    const yM = yM0.toFixed(2);
    const wM = pxToM(w).toFixed(2);
    const hM = pxToM(h).toFixed(2);

    this.panel.innerHTML = `
      <div class="prop-section-title">Box</div>
      <div class="prop-section-title" style="margin-top:8px">Position</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <input class="prop-value" id="prop-x" type="number" step="0.1" value="${xM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <input class="prop-value" id="prop-y" type="number" step="0.1" value="${yM}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Initial velocity ${MATH.v0}</div>
      <div class="prop-row">
        <span class="prop-label">|${MATH.v0}| (m/s)</span>
        <input class="prop-value" id="prop-speed" type="number" step="0.1" min="0" value="${speed}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.theta} (°)</span>
        <input class="prop-value" id="prop-angle" type="number" step="1" min="-180" max="180" value="${angleDeg}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.vx} (m/s)</span>
        <input class="prop-value" id="prop-vx" type="number" step="0.1" value="${vxMs.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.vy} (m/s)</span>
        <input class="prop-value" id="prop-vy" type="number" step="0.1" value="${vyMs.toFixed(3)}"/>
      </div>
      ${this._appliedForceRowsHtml(body)}
      ${this._angularRowsHtml(body)}
      <div class="prop-section-title" style="margin-top:8px">Size</div>
      <div class="prop-row">
        <span class="prop-label">width (m)</span>
        <input class="prop-value" id="prop-box-w" type="number" step="0.1" min="0.08" value="${wM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">height (m)</span>
        <input class="prop-value" id="prop-box-h" type="number" step="0.1" min="0.08" value="${hM}"/>
      </div>
      ${this._anchoredRowHtml(body)}
      <div class="prop-row">
        <span class="prop-label">mass (kg)</span>
        <input class="prop-value" id="prop-mass" type="number" step="0.1" min="0.01" value="${bodyDisplayMass(body).toFixed(3)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Material</div>
      <div class="prop-row">
        <span class="prop-label">restitution</span>
        <input class="prop-value" id="prop-rest" type="number" step="0.05" min="0" max="1" value="${body.restitution.toFixed(2)}"/>
      </div>
      ${this._stickyToggleHtml(!!body._stickOnContact)}
      <div class="prop-section-title" style="margin-top:8px">Friction (surface)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.mus}</span>
        <input class="prop-value" id="prop-mus" type="number" step="0.01" min="0" max="5" value="${muS}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.muk}</span>
        <input class="prop-value" id="prop-muk" type="number" step="0.01" min="0" max="5" value="${muK}"/>
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete</button>
    `;

    this._bindV0Inputs(body);
    this._bindAnchoredToggle(body);
    this._bindAppliedForceInputs('box');
    this._bindAngularInputs('box');
    this._bindStickyToggle(body);

    this.panel.querySelector('#prop-x')?.addEventListener('change', e => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      this._push();
      const cur = worldPxToDisplayedM(b.position.x, b.position.y);
      const { x: xPx, y: yKeep } = displayedMToWorldPx(parseFloat(e.target.value), cur.ym);
      Body.setPosition(b, {
        x: snapWorldCoord(xPx, this._snapOn()),
        y: snapWorldCoord(yKeep, this._snapOn()),
      });
      this._syncBodyRopes(b);
    });
    this.panel.querySelector('#prop-y')?.addEventListener('change', e => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      this._push();
      const cur = worldPxToDisplayedM(b.position.x, b.position.y);
      const { x: xKeep, y: yPx } = displayedMToWorldPx(cur.xm, parseFloat(e.target.value));
      Body.setPosition(b, {
        x: snapWorldCoord(xKeep, this._snapOn()),
        y: snapWorldCoord(yPx, this._snapOn()),
      });
      this._syncBodyRopes(b);
    });
    this.panel.querySelector('#prop-box-w')?.addEventListener('change', e => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      this._push();
      const nw = snapBodySizePx(mToPx(parseFloat(e.target.value)), this._snapOn());
      const nh = b._height ?? 40;
      this._scaleBoxTo(b, nw, nh);
    });
    this.panel.querySelector('#prop-box-h')?.addEventListener('change', e => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      const nh = snapBodySizePx(mToPx(parseFloat(e.target.value)), this._snapOn());
      const nw = b._width ?? 40;
      this._push();
      this._scaleBoxTo(b, nw, nh);
    });
    this.panel.querySelector('#prop-mass')?.addEventListener('change', e => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      this._push();
      const v = parseFloat(e.target.value);
      if (v > 0) setBodyMass(b, v);
    });
    this.panel.querySelector('#prop-rest')?.addEventListener('change', e => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      this._push();
      b.restitution = parseFloat(e.target.value);
    });
    this._bindFrictionInputs(() =>
      this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box'));

    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      const b = this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'box');
      if (!b) return;
      this._push();
      this.engine.removeBody(b);
      this.clear();
    });
  }

  _buildWedgePanel(body) {
    const W = body._baseWidth ?? 40;
    const H = body._height ?? 40;
    const footDeg = ((body._footAngle ?? defaultWedgeFootAngle(W, H)) * 180 / Math.PI).toFixed(1);
    const rawK = body._muK ?? body.friction ?? 0.3;
    const rawS = body._muS ?? body.frictionStatic ?? rawK * 1.3;
    const muK = Number(rawK).toFixed(3);
    const muS = Number(rawS).toFixed(3);
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const speed = Math.hypot(vxMs, vyMs).toFixed(3);
    const angleDeg = (Math.atan2(vyMs, vxMs) * 180 / Math.PI).toFixed(1);
    const aabb = wedgeAABBCenterWorld(body);
    const { xm: xM0, ym: yM0 } = worldPxToDisplayedM(aabb.x, aabb.y);
    const xM = xM0.toFixed(2);
    const yM = yM0.toFixed(2);

    this.panel.innerHTML = `
      <div class="prop-section-title">Wedge</div>
      <div class="prop-section-title" style="margin-top:8px">Position</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <input class="prop-value" id="prop-x" type="number" step="0.1" value="${xM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <input class="prop-value" id="prop-y" type="number" step="0.1" value="${yM}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Initial velocity ${MATH.v0}</div>
      <div class="prop-row">
        <span class="prop-label">|${MATH.v0}| (m/s)</span>
        <input class="prop-value" id="prop-speed" type="number" step="0.1" min="0" value="${speed}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.theta} (°)</span>
        <input class="prop-value" id="prop-angle" type="number" step="1" min="-180" max="180" value="${angleDeg}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.vx} (m/s)</span>
        <input class="prop-value" id="prop-vx" type="number" step="0.1" value="${vxMs.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.vy} (m/s)</span>
        <input class="prop-value" id="prop-vy" type="number" step="0.1" value="${vyMs.toFixed(3)}"/>
      </div>
      ${this._appliedForceRowsHtml(body)}
      ${this._angularRowsHtml(body)}
      <div class="prop-section-title" style="margin-top:8px">Size</div>
      <div class="prop-row">
        <span class="prop-label">base (m)</span>
        <input class="prop-value" id="prop-wedge-w" type="number" step="0.1" min="0.08" value="${pxToM(W).toFixed(2)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">height (m)</span>
        <input class="prop-value" id="prop-wedge-h" type="number" step="0.1" min="0.08" value="${pxToM(H).toFixed(2)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">foot ∠ (°)</span>
        <input class="prop-value" id="prop-wedge-foot" type="number" step="1" min="5" max="85" value="${footDeg}"/>
      </div>
      ${this._anchoredRowHtml(body)}
      <div class="prop-row">
        <span class="prop-label">mass (kg)</span>
        <input class="prop-value" id="prop-mass" type="number" step="0.1" min="0.01" value="${bodyDisplayMass(body).toFixed(3)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Material</div>
      <div class="prop-row">
        <span class="prop-label">restitution</span>
        <input class="prop-value" id="prop-rest" type="number" step="0.05" min="0" max="1" value="${body.restitution.toFixed(2)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Friction (surface)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.mus}</span>
        <input class="prop-value" id="prop-mus" type="number" step="0.01" min="0" max="5" value="${muS}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.muk}</span>
        <input class="prop-value" id="prop-muk" type="number" step="0.01" min="0" max="5" value="${muK}"/>
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete</button>
    `;

    this._bindV0Inputs(body);
    this._bindAnchoredToggle(body);
    this._bindAppliedForceInputs('wedge');
    this._bindAngularInputs('wedge');
    const findW = () => this.engine.bodies.find(x => x.id === this._current?.id && x._newtonType === 'wedge');

    this.panel.querySelector('#prop-x')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      const cur = wedgeAABBCenterWorld(b);
      const { xm, ym } = worldPxToDisplayedM(cur.x, cur.y);
      const { x: xPx, y: yKeep } = displayedMToWorldPx(parseFloat(e.target.value), ym);
      setWedgeAABBCenter(b, xPx, yKeep);
      snapWedgeToGrid(b, this._snapOn());
    });
    this.panel.querySelector('#prop-y')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      const cur = wedgeAABBCenterWorld(b);
      const { xm, ym } = worldPxToDisplayedM(cur.x, cur.y);
      const { x: xKeep, y: yPx } = displayedMToWorldPx(xm, parseFloat(e.target.value));
      setWedgeAABBCenter(b, xKeep, yPx);
      snapWedgeToGrid(b, this._snapOn());
    });
    this.panel.querySelector('#prop-wedge-w')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      const W = snapBodySizePx(mToPx(parseFloat(e.target.value)), this._snapOn());
      scaleWedgeTo(b, W, b._height ?? 40, { pin: 'left' });
      snapWedgeToGrid(b, this._snapOn());
    });
    this.panel.querySelector('#prop-wedge-h')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      const H = snapBodySizePx(mToPx(parseFloat(e.target.value)), this._snapOn());
      scaleWedgeTo(b, b._baseWidth ?? 40, H, { pin: 'bottom' });
      snapWedgeToGrid(b, this._snapOn());
    });
    this.panel.querySelector('#prop-wedge-foot')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      const rad = clampWedgeFootAngle(parseFloat(e.target.value) * Math.PI / 180);
      const H = b._height ?? 40;
      // Keep opposite side (vertical height) + right-angle corner, adjust base.
      const W = Math.max(8, H / Math.tan(rad));
      setWedgeGeometry(b, W, H, { pin: 'corner' });
    });
    this.panel.querySelector('#prop-mass')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      const v = parseFloat(e.target.value);
      if (v > 0) setBodyMass(b, v);
    });
    this.panel.querySelector('#prop-rest')?.addEventListener('change', e => {
      const b = findW(); if (!b) return;
      this._push();
      b.restitution = parseFloat(e.target.value);
    });
    this._bindFrictionInputs(findW);
    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      const b = findW(); if (!b) return;
      this._push();
      this.engine.removeBody(b);
      this.clear();
    });
  }

  _buildAnchorPanel(body) {
    const { xm: xM0, ym: yM0 } = worldPxToDisplayedM(body.position.x, body.position.y);
    const driven = isDrivenPivot(body);
    const expr = getDrivenTorqueExpr(body) || DEFAULT_DRIVEN_TORQUE_EXPR;
    const err = getDrivenTorqueError(body);

    this.panel.innerHTML = `
      <div class="prop-section-title">Pivot</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <input class="prop-value" id="prop-x" type="number" step="0.1" value="${xM0.toFixed(3)}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <input class="prop-value" id="prop-y" type="number" step="0.1" value="${yM0.toFixed(3)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:10px">Driven oscillator</div>
      <div class="prop-row">
        <span class="prop-label">Driven</span>
        <label class="toggle-label">
          <input type="checkbox" id="prop-driven" ${driven ? 'checked' : ''}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      <div id="prop-driven-section" class="${driven ? '' : 'hidden'}">
        <div class="prop-section-title" style="margin-top:8px">${MATH.tau}(t) (N·m)</div>
        <div class="prop-math-expr-wrap" id="prop-driven-tau-wrap"
          data-expr="${_escapeHtml(expr)}"></div>
        <p class="prop-expr-error ${err ? '' : 'hidden'}" id="prop-driven-err">${err ? _escapeHtml(err) : ''}</p>
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete</button>
    `;

    this.panel.querySelector('#prop-x')?.addEventListener('change', e => {
      this._push();
      const cur = worldPxToDisplayedM(body.position.x, body.position.y);
      const { x: xPx, y: yKeep } = displayedMToWorldPx(parseFloat(e.target.value), cur.ym);
      Body.setPosition(body, {
        x: snapWorldCoord(xPx, this._snapOn()),
        y: snapWorldCoord(yKeep, this._snapOn()),
      });
      this._syncBodyRopes(body);
    });
    this.panel.querySelector('#prop-y')?.addEventListener('change', e => {
      this._push();
      const cur = worldPxToDisplayedM(body.position.x, body.position.y);
      const { x: xKeep, y: yPx } = displayedMToWorldPx(cur.xm, parseFloat(e.target.value));
      Body.setPosition(body, {
        x: snapWorldCoord(xKeep, this._snapOn()),
        y: snapWorldCoord(yPx, this._snapOn()),
      });
      this._syncBodyRopes(body);
    });

    this.panel.querySelector('#prop-driven')?.addEventListener('change', e => {
      this._push();
      const on = !!e.target.checked;
      setDriven(body, on);
      const section = this.panel.querySelector('#prop-driven-section');
      section?.classList.toggle('hidden', !on);
      if (on) {
        requestAnimationFrame(() => this._bindDrivenExprInput(body));
      }
      this.engine.invalidateEnergyTarget?.();
    });

    if (driven) this._bindDrivenExprInput(body);

    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      this._push();
      this.engine.removeBody(body);
      this.clear();
    });
  }

  /**
   * Symbolic τ(t) input for driven pivot.
   * @param {import('matter-js').Body} body
   */
  _bindDrivenExprInput(body) {
    const wrap = this.panel.querySelector('#prop-driven-tau-wrap');
    if (!wrap || wrap.dataset.bound === '1') return;

    const applyAscii = (ascii) => {
      this._push();
      const result = setDrivenTorqueExpr(
        body,
        ascii || DEFAULT_DRIVEN_TORQUE_EXPR,
      );
      if (result.ok) syncMathExprInput(wrap, result.source);
      const errEl = this.panel.querySelector('#prop-driven-err');
      if (errEl) {
        if (result.ok) {
          errEl.textContent = '';
          errEl.classList.add('hidden');
        } else {
          errEl.textContent = result.error ?? 'Invalid expression';
          errEl.classList.remove('hidden');
        }
      }
      this.engine.invalidateEnergyTarget?.();
    };

    mountMathExprInput(wrap, {
      expr: getDrivenTorqueExpr(body) || DEFAULT_DRIVEN_TORQUE_EXPR,
      fallbackExpr: DEFAULT_DRIVEN_TORQUE_EXPR,
      onApply: applyAscii,
    });
  }

  _buildGenericPanel(body) {
    const bType  = body._newtonType ?? 'generic';
    const muK    = (body._muK ?? body.friction).toFixed(3);
    const muS    = (body._muS ?? body.frictionStatic ?? body.friction * 1.3).toFixed(3);
    const { xm: xM0, ym: yM0 } = worldPxToDisplayedM(body.position.x, body.position.y);
    const xM = xM0.toFixed(2);
    const yM = yM0.toFixed(2);
    this.panel.innerHTML = `
      <div class="prop-section-title">${bType.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}</div>
      ${!body.isStatic ? `
      <div class="prop-row">
        <span class="prop-label">${MATH.x} (m)</span>
        <input class="prop-value" id="prop-x" type="number" step="0.1" value="${xM}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.y} (m)</span>
        <input class="prop-value" id="prop-y" type="number" step="0.1" value="${yM}"/>
      </div>` : ''}
      <div class="prop-row">
        <span class="prop-label">restitution</span>
        <input class="prop-value" id="prop-rest" type="number" step="0.05" min="0" max="1" value="${body.restitution.toFixed(2)}"/>
      </div>
      <div class="prop-section-title" style="margin-top:8px">Friction (this surface)</div>
      <div class="prop-row">
        <span class="prop-label">${MATH.mus}</span>
        <input class="prop-value" id="prop-mus" type="number" step="0.01" min="0" max="5" value="${muS}"/>
      </div>
      <div class="prop-row">
        <span class="prop-label">${MATH.muk}</span>
        <input class="prop-value" id="prop-muk" type="number" step="0.01" min="0" max="5" value="${muK}"/>
      </div>
      <button class="prop-delete-btn" id="prop-delete">Delete</button>
    `;
    if (!body.isStatic) {
      this.panel.querySelector('#prop-x')?.addEventListener('change', e => {
        this._push();
        const cur = worldPxToDisplayedM(body.position.x, body.position.y);
        const { x: xPx, y: yKeep } = displayedMToWorldPx(parseFloat(e.target.value), cur.ym);
        Body.setPosition(body, {
          x: snapWorldCoord(xPx, this._snapOn()),
          y: snapWorldCoord(yKeep, this._snapOn()),
        });
        this._syncBodyRopes(body);
      });
      this.panel.querySelector('#prop-y')?.addEventListener('change', e => {
        this._push();
        const cur = worldPxToDisplayedM(body.position.x, body.position.y);
        const { x: xKeep, y: yPx } = displayedMToWorldPx(cur.xm, parseFloat(e.target.value));
        Body.setPosition(body, {
          x: snapWorldCoord(xKeep, this._snapOn()),
          y: snapWorldCoord(yPx, this._snapOn()),
        });
        this._syncBodyRopes(body);
      });
    }
    this.panel.querySelector('#prop-rest')?.addEventListener('change', e => {
      this._push();
      body.restitution = parseFloat(e.target.value);
    });
    this._bindFrictionInputs(() => body);
    this.panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      this._push();
      this.engine.removeBody(body);
      this.clear();
    });
  }

  // ─── Live refresh ──────────────────────────────────────────────

  _updateLive(body) {
    const nt = body._newtonType;
    if (nt === 'compound') {
      const { xm, ym } = worldPxToDisplayedM(body.position.x, body.position.y);
      this._setVField('#prop-x', xm.toFixed(3));
      this._setVField('#prop-y', ym.toFixed(3));
      this._setVField('#prop-mass', body.mass.toFixed(3));
      return;
    }
    if (nt === 'point-mass' || nt === 'ball' || nt === 'box' || nt === 'wedge') {
      this._rebuildVelocityInputs(body);
      this._rebuildAngularInputs(body);
    }
    if (nt === 'metric-basis') {
      this._setVField('#prop-x', pxToM(body.position.x).toFixed(2));
      this._setVField('#prop-y', pxToM(body.position.y).toFixed(2));
    } else if (nt === 'point-mass' || nt === 'ball' || nt === 'box' || nt === 'wedge' || nt === 'ground' || nt === 'anchor' || !body.isStatic) {
      this._rebuildPositionInputs(body);
    }
  }
}

function _ropeAttachLabel(engine, ropeId, which) {
  const host = getRopeEndAttachment(engine, ropeId, which);
  if (!host?.body) return 'Free';
  return bodyDisplayName(host.body);
}

function _anchorSummaryLabel(anchor) {
  if (!anchor) return '—';
  if (anchor.kind === 'world') return `World (${Number(anchor.x).toFixed(0)}, ${Number(anchor.y).toFixed(0)}) px`;
  if (anchor.kind === 'body') return `Body · ${anchor.bodyLabel ?? '?'}`;
  if (anchor.kind === 'vertex') return `Vertex ${anchor.vertex ?? ''} · ${anchor.bodyLabel ?? '?'}`;
  if (anchor.kind === 'velocity') return `Velocity · ${anchor.bodyLabel ?? '?'}`;
  if (anchor.kind === 'force') return `Force · ${anchor.bodyLabel ?? '?'}`;
  if (anchor.kind === 'constraint') return `Constraint · ${anchor.constraintLabel ?? '?'}`;
  if (anchor.kind === 'label') return `Label · ${anchor.labelId ?? '?'}`;
  return anchor.kind ?? '—';
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _escapeAttr(s) {
  return _escapeHtml(s).replace(/'/g, '&#39;');
}
