/**
 * Point cleaning, R², and residual helpers.
 */

import { FitError } from './types.js';

/**
 * Normalize input to cleaned finite {x,y}[] points.
 * @param {{ x: number[], y: number[] } | Array<[number, number]> | Array<{x:number,y:number}>} data
 * @returns {import('./types.js').FitPoint[]}
 */
export function cleanPoints(data) {
  /** @type {import('./types.js').FitPoint[]} */
  const out = [];
  if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
    for (const pair of data) {
      const x = Number(pair[0]);
      const y = Number(pair[1]);
      if (isFinite(x) && isFinite(y)) out.push({ x, y });
    }
  } else if (Array.isArray(data) && data.length && typeof data[0] === 'object' && data[0] != null && 'x' in data[0]) {
    for (const p of data) {
      const x = Number(p.x);
      const y = Number(p.y);
      if (isFinite(x) && isFinite(y)) out.push({ x, y });
    }
  } else if (data && typeof data === 'object' && Array.isArray(data.x) && Array.isArray(data.y)) {
    const n = Math.min(data.x.length, data.y.length);
    for (let i = 0; i < n; i++) {
      const x = Number(data.x[i]);
      const y = Number(data.y[i]);
      if (isFinite(x) && isFinite(y)) out.push({ x, y });
    }
  } else {
    throw new FitError('Invalid data: expected {x[], y[]} or [[x,y], …]', 'bad_data');
  }
  return out;
}

/**
 * @param {import('./types.js').FitPoint[]} pts
 * @param {(x: number) => number} evaluate
 * @returns {number[]}
 */
export function residuals(pts, evaluate) {
  return pts.map(p => p.y - evaluate(p.x));
}

/**
 * @param {import('./types.js').FitPoint[]} pts
 * @param {(x: number) => number} evaluate
 * @returns {{ sse: number, r2: number|null, residuals: number[] }}
 */
export function fitQuality(pts, evaluate) {
  const r = residuals(pts, evaluate);
  let sse = 0;
  let sumY = 0;
  for (let i = 0; i < pts.length; i++) {
    sse += r[i] * r[i];
    sumY += pts[i].y;
  }
  const n = pts.length;
  const meanY = n > 0 ? sumY / n : 0;
  let sst = 0;
  for (const p of pts) {
    const d = p.y - meanY;
    sst += d * d;
  }
  let r2 = null;
  if (sst > 1e-30) r2 = 1 - sse / sst;
  else if (sse < 1e-30) r2 = 1;
  return { sse, r2, residuals: r };
}

/**
 * @param {import('./types.js').FitPoint[]} pts
 * @param {number} min
 */
export function requirePoints(pts, min) {
  if (pts.length < min) {
    throw new FitError(
      `Need at least ${min} finite data points (have ${pts.length})`,
      'insufficient_points',
    );
  }
}
