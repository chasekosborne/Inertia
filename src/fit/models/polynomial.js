/**
 * Polynomial model: y = a_n x^n + … + a_1 x + a_0
 */

import { leastSquares } from '../linear-algebra.js';
import { fitQuality, requirePoints } from '../stats.js';
import { formatFitStrings } from '../format.js';
import { FitError } from '../types.js';

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @param {{ degree?: number }} [opts]
 * @returns {import('../types.js').FitResult}
 */
export function fitPolynomial(pts, opts = {}) {
  let degree = Math.round(Number(opts.degree ?? 2));
  if (!Number.isFinite(degree)) degree = 2;
  degree = Math.max(1, Math.min(8, degree));

  requirePoints(pts, degree + 1);

  const n = pts.length;
  /** @type {number[][]} */
  const X = Array.from({ length: n }, (_, i) => {
    const row = Array(degree + 1);
    let xp = 1;
    const x = pts[i].x;
    for (let k = 0; k <= degree; k++) {
      row[k] = xp;
      xp *= x;
    }
    return row;
  });
  const y = pts.map(p => p.y);

  let beta;
  try {
    beta = leastSquares(X, y);
  } catch (e) {
    if (e instanceof FitError) throw e;
    throw new FitError('Polynomial fit failed', 'singular');
  }

  /** @type {Record<string, number>} */
  const params = {};
  for (let k = 0; k <= degree; k++) params[`a${k}`] = beta[k];

  const evaluate = (x) => {
    let s = 0;
    let xp = 1;
    for (let k = 0; k <= degree; k++) {
      s += beta[k] * xp;
      xp *= x;
    }
    return s;
  };

  const { sse, r2, residuals } = fitQuality(pts, evaluate);
  const strings = formatFitStrings('polynomial', params, degree);
  return {
    model: 'polynomial',
    params,
    evaluate,
    equation: strings.equation,
    desmosEquation: strings.desmosEquation,
    desmosRegression: strings.desmosRegression,
    paramSummary: strings.paramSummary,
    r2,
    residuals,
    points: pts,
    sse,
    n: pts.length,
    degree,
  };
}
