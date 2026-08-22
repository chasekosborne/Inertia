/**
 * Shared types for the curve-fitting layer.
 * Operates on generic (x, y) data: no physics engine dependency.
 */

/**
 * @typedef {{ x: number, y: number }} FitPoint
 */

/**
 * @typedef {'linear'|'polynomial'|'exponential'|'logarithmic'|'power'|'sinusoidal'} FitModelId
 */

/**
 * @typedef {object} FitResult
 * @property {FitModelId} model
 * @property {Record<string, number>} params  Full-precision named parameters
 * @property {(x: number) => number} evaluate
 * @property {string} equation  UI display string
 * @property {string} desmosEquation
 * @property {string|null} desmosRegression
 * @property {number|null} r2
 * @property {number[]} residuals  r_i = y_i − y_fit(x_i) for cleaned points
 * @property {FitPoint[]} points  Cleaned points used in the fit
 * @property {number} sse
 * @property {number} n
 * @property {string} [paramSummary]  Short UI line of key params
 */

/**
 * @typedef {object} FitModelDef
 * @property {FitModelId} id
 * @property {string} label
 * @property {number} minPoints
 * @property {(pts: FitPoint[], opts?: object) => FitResult} fit
 */

export class FitError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'fit_error') {
    super(message);
    this.name = 'FitError';
    this.code = code;
  }
}
