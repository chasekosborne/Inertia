/**
 * Linear model: y = m x + b
 */

import { fitLine } from '../linear-algebra.js';
import { fitQuality, requirePoints } from '../stats.js';
import { formatFitStrings } from '../format.js';

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @returns {import('../types.js').FitResult}
 */
export function fitLinear(pts) {
  requirePoints(pts, 2);
  const { m, b } = fitLine(pts);
  const params = { m, b };
  const evaluate = (x) => m * x + b;
  const { sse, r2, residuals } = fitQuality(pts, evaluate);
  const strings = formatFitStrings('linear', params);
  return {
    model: 'linear',
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
  };
}
