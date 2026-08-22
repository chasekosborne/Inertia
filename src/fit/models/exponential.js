/**
 * Exponential model: y = A e^{k x}  (via ln y linearization)
 */

import { fitLine } from '../linear-algebra.js';
import { fitQuality, requirePoints } from '../stats.js';
import { formatFitStrings } from '../format.js';
import { FitError } from '../types.js';

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @returns {import('../types.js').FitResult}
 */
export function fitExponential(pts) {
  const valid = pts.filter(p => p.y > 0);
  if (valid.length < 2) {
    throw new FitError(
      'Exponential fit needs at least 2 points with y > 0',
      'insufficient_points',
    );
  }
  requirePoints(valid, 2);

  const logPts = valid.map(p => ({ x: p.x, y: Math.log(p.y) }));
  const { m: k, b: lnA } = fitLine(logPts);
  const A = Math.exp(lnA);
  if (!isFinite(A) || !isFinite(k)) {
    throw new FitError('Exponential fit produced non-finite parameters', 'singular');
  }

  const params = { A, k };
  const evaluate = (x) => A * Math.exp(k * x);
  // Quality on the positive points used for the transform
  const { sse, r2, residuals } = fitQuality(valid, evaluate);
  const strings = formatFitStrings('exponential', params);
  return {
    model: 'exponential',
    params,
    evaluate,
    equation: strings.equation,
    desmosEquation: strings.desmosEquation,
    desmosRegression: strings.desmosRegression,
    paramSummary: strings.paramSummary,
    r2,
    residuals,
    points: valid,
    sse,
    n: valid.length,
  };
}
