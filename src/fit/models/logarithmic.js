/**
 * Logarithmic model: y = a ln(x) + b  (via ln x linearization)
 */

import { fitLine } from '../linear-algebra.js';
import { fitQuality, requirePoints } from '../stats.js';
import { formatFitStrings } from '../format.js';
import { FitError } from '../types.js';

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @returns {import('../types.js').FitResult}
 */
export function fitLogarithmic(pts) {
  const valid = pts.filter(p => p.x > 0);
  if (valid.length < 2) {
    throw new FitError(
      'Logarithmic fit needs at least 2 points with x > 0',
      'insufficient_points',
    );
  }
  requirePoints(valid, 2);

  const logPts = valid.map(p => ({ x: Math.log(p.x), y: p.y }));
  const { m: a, b } = fitLine(logPts);
  if (!isFinite(a) || !isFinite(b)) {
    throw new FitError('Logarithmic fit produced non-finite parameters', 'singular');
  }

  const params = { a, b };
  const evaluate = (x) => (x > 0 ? a * Math.log(x) + b : NaN);
  const { sse, r2, residuals } = fitQuality(valid, evaluate);
  const strings = formatFitStrings('logarithmic', params);
  return {
    model: 'logarithmic',
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
