/**
 * Public curve-fitting API: physics-independent.
 *
 *   fit(data, model, options) → FitResult
 */

import { FitError } from './types.js';
import { cleanPoints } from './stats.js';
import { fitLinear } from './models/linear.js';
import { fitPolynomial } from './models/polynomial.js';
import { fitExponential } from './models/exponential.js';
import { fitLogarithmic } from './models/logarithmic.js';
import { fitPower } from './models/power.js';
import { fitSinusoidal } from './models/sinusoidal.js';

export { FitError } from './types.js';
export { fmtNum, formatFitStrings } from './format.js';

/**
 * @type {import('./types.js').FitModelDef[]}
 */
export const FIT_MODELS = [
  { id: 'linear',      label: 'Linear',      minPoints: 2, fit: (pts) => fitLinear(pts) },
  { id: 'polynomial',  label: 'Polynomial',  minPoints: 2, fit: (pts, opts) => fitPolynomial(pts, opts) },
  { id: 'exponential',  label: 'Exponential',  minPoints: 2, fit: (pts) => fitExponential(pts) },
  { id: 'logarithmic',  label: 'Logarithmic',  minPoints: 2, fit: (pts) => fitLogarithmic(pts) },
  { id: 'power',        label: 'Power',        minPoints: 2, fit: (pts) => fitPower(pts) },
  { id: 'sinusoidal',   label: 'Sinusoidal',   minPoints: 8, fit: (pts) => fitSinusoidal(pts) },
];

/**
 * @param {import('./types.js').FitModelId} id
 */
export function getFitModel(id) {
  return FIT_MODELS.find(m => m.id === id) ?? null;
}

/**
 * Fit a model to generic (x, y) data.
 *
 * @param {{ x: number[], y: number[] } | Array<[number, number]> | Array<{x:number,y:number}>} data
 * @param {import('./types.js').FitModelId} model
 * @param {{ degree?: number }} [options]
 * @returns {import('./types.js').FitResult}
 */
export function fit(data, model, options = {}) {
  const def = getFitModel(model);
  if (!def) throw new FitError(`Unknown fit model: ${model}`, 'unknown_model');

  const pts = cleanPoints(data);
  if (pts.length < def.minPoints) {
    throw new FitError(
      `${def.label} fit needs at least ${def.minPoints} finite points (have ${pts.length})`,
      'insufficient_points',
    );
  }

  return def.fit(pts, options);
}

/**
 * Dense samples of a fit over [x0, x1] for graph overlay.
 * @param {import('./types.js').FitResult} result
 * @param {number} x0
 * @param {number} x1
 * @param {number} [count=200]
 * @returns {{ t: number, v: number }[]}
 */
export function sampleFit(result, x0, x1, count = 200) {
  if (!result?.evaluate || !isFinite(x0) || !isFinite(x1)) return [];
  let a = x0;
  let b = x1;
  if (b < a) { const t = a; a = b; b = t; }
  if (result.model === 'logarithmic' && a <= 0) {
    a = Math.max(1e-12, b > 0 ? Math.min(1e-6, b * 1e-4) : 1e-6);
    if (a >= b) return [];
  }
  if (b - a < 1e-15) b = a + 1e-6;
  const n = Math.max(2, Math.round(count));
  /** @type {{ t: number, v: number }[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = a + (b - a) * (i / (n - 1));
    const v = result.evaluate(t);
    if (isFinite(v)) out.push({ t, v });
  }
  return out;
}
