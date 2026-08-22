/**
 * Minimal linear-algebra helpers for normal-equation least squares.
 */

import { FitError } from './types.js';

const SINGULAR_EPS = 1e-12;

/**
 * Solve A x = b in-place via Gaussian elimination with partial pivoting.
 * A is n×n row-major nested arrays, b is length n. Returns x or throws.
 * @param {number[][]} A
 * @param {number[]} b
 * @returns {number[]}
 */
export function solveLinearSystem(A, b) {
  const n = b.length;
  if (A.length !== n) throw new FitError('Matrix size mismatch', 'singular');

  /** @type {number[][]} */
  const M = A.map((row, i) => {
    if (row.length !== n) throw new FitError('Matrix size mismatch', 'singular');
    return row.slice().concat(b[i]);
  });

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < SINGULAR_EPS) {
      throw new FitError('Fit is singular or ill-conditioned', 'singular');
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const diag = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }

  return M.map(row => row[n]);
}

/**
 * Ordinary least squares: solve (Xᵀ X) β = Xᵀ y for design matrix X (n×p).
 * @param {number[][]} X  rows = observations
 * @param {number[]} y
 * @returns {number[]} β length p
 */
export function leastSquares(X, y) {
  const n = X.length;
  if (!n) throw new FitError('No observations', 'insufficient_points');
  const p = X[0].length;
  if (y.length !== n) throw new FitError('X/y length mismatch', 'bad_data');
  if (n < p) {
    throw new FitError(`Need at least ${p} points for this model (have ${n})`, 'insufficient_points');
  }

  /** @type {number[][]} */
  const AtA = Array.from({ length: p }, () => Array(p).fill(0));
  /** @type {number[]} */
  const Aty = Array(p).fill(0);

  for (let i = 0; i < n; i++) {
    const row = X[i];
    const yi = y[i];
    for (let a = 0; a < p; a++) {
      Aty[a] += row[a] * yi;
      for (let b = a; b < p; b++) {
        AtA[a][b] += row[a] * row[b];
      }
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) AtA[a][b] = AtA[b][a];
  }

  return solveLinearSystem(AtA, Aty);
}

/**
 * Simple 2-parameter linear regression y = m x + b.
 * @param {import('./types.js').FitPoint[]} pts
 * @returns {{ m: number, b: number }}
 */
export function fitLine(pts) {
  const n = pts.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const p of pts) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y;
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < SINGULAR_EPS) {
    throw new FitError('Cannot fit a line — x values are all the same', 'singular');
  }
  const m = (n * sxy - sx * sy) / den;
  const b = (sy - m * sx) / n;
  return { m, b };
}
