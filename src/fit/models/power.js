/**
 * Power-law model: y = A x^k  (via ln-ln linearization)
 */

import { fitLine } from '../linear-algebra.js';
import { fitQuality, requirePoints } from '../stats.js';
import { formatFitStrings } from '../format.js';
import { FitError } from '../types.js';

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @returns {import('../types.js').FitResult}
 */
export function fitPower(pts) {
  const valid = pts.filter(p => p.x > 0 && p.y > 0);
  if (valid.length < 2) {
    throw new FitError(
      'Power-law fit needs at least 2 points with x > 0 and y > 0',
      'insufficient_points',
    );
  }
  requirePoints(valid, 2);

  const logPts = valid.map(p => ({ x: Math.log(p.x), y: Math.log(p.y) }));
  const { m: k, b: lnA } = fitLine(logPts);
  const A = Math.exp(lnA);
  if (!isFinite(A) || !isFinite(k)) {
    throw new FitError('Power-law fit produced non-finite parameters', 'singular');
  }

  const params = { A, k };
  const evaluate = (x) => (x === 0 ? (k > 0 ? 0 : Infinity) : A * (x ** k));
  const { sse, r2, residuals } = fitQuality(valid, evaluate);
  const strings = formatFitStrings('power', params);
  return {
    model: 'power',
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
