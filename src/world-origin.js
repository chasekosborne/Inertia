/**
 * Metric frame: (0,0) m in the properties panel is at the draggable metric-basis body.
 * Lengths stay absolute metres, other positions are relative to that body.
 */

import Matter from 'matter-js';
import { METRIC_BASIS_DEFAULT_M, PX_PER_M, mToPx } from './units.js';

const { Body } = Matter;

/** @type {import('./physics/engine.js').PhysicsEngine|null} */
let _engine = null;

export function setMetricOriginEngine(engine) {
  _engine = engine;
}

function _basisBody() {
  return _engine?.bodies?.find(b => b._newtonType === 'metric-basis') ?? null;
}

export function getMetricOriginWorldPx() {
  const b = _basisBody();
  return b ? { x: b.position.x, y: b.position.y } : { x: 0, y: 0 };
}

/** Move the basis (same as dragging), snaps should be applied by caller if needed. */
export function setMetricOriginWorldPx(x, y) {
  const b = _basisBody();
  if (b) Body.setPosition(b, { x, y });
}

export function setMetricOriginDisplayedM(xm, ym) {
  setMetricOriginWorldPx(mToPx(xm), mToPx(ym));
}

export function worldPxToDisplayedM(wx, wy) {
  const { x: ox, y: oy } = getMetricOriginWorldPx();
  return { xm: (wx - ox) / PX_PER_M, ym: (wy - oy) / PX_PER_M };
}

export function displayedMToWorldPx(xm, ym) {
  const { x: ox, y: oy } = getMetricOriginWorldPx();
  return { x: ox + mToPx(xm), y: oy + mToPx(ym) };
}

export function getOriginDisplayedM() {
  const { x, y } = getMetricOriginWorldPx();
  return { xm: x / PX_PER_M, ym: y / PX_PER_M };
}

export function resetMetricOrigin() {
  setMetricOriginWorldPx(mToPx(METRIC_BASIS_DEFAULT_M.xm), mToPx(METRIC_BASIS_DEFAULT_M.ym));
}
