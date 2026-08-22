/**
 * Sinusoidal model: y = A sin(ω x + φ) + C
 *
 * 1. C ≈ mean(y)
 * 2. Estimate ω from autocorrelation peak of demeaned signal (uniform-ish x)
 * 3. Linear LS: y − C = α sin(ωx) + β cos(ωx) → A, φ
 * 4. Optional 1-D refine of ω by SSE
 */

import { leastSquares } from '../linear-algebra.js';
import { fitQuality, requirePoints } from '../stats.js';
import { formatFitStrings } from '../format.js';
import { FitError } from '../types.js';

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @returns {import('../types.js').FitResult}
 */
export function fitSinusoidal(pts) {
  requirePoints(pts, 8);

  const sorted = pts.slice().sort((a, b) => a.x - b.x);
  let sumY = 0;
  for (const p of sorted) sumY += p.y;
  const C0 = sumY / sorted.length;

  const omega0 = estimateOmega(sorted, C0);
  if (!isFinite(omega0) || omega0 <= 0) {
    throw new FitError(
      'Could not estimate oscillation frequency — try a clearer period or more cycles',
      'omega_failed',
    );
  }

  const refined = refineOmega(sorted, C0, omega0);
  const { A, phi, C, omega } = fitAmpPhase(sorted, refined);

  if (!isFinite(A) || !isFinite(phi) || !isFinite(C) || !isFinite(omega)) {
    throw new FitError('Sinusoidal fit produced non-finite parameters', 'singular');
  }

  const params = { A, omega, phi, C };
  const evaluate = (x) => A * Math.sin(omega * x + phi) + C;
  const { sse, r2, residuals } = fitQuality(sorted, evaluate);
  const strings = formatFitStrings('sinusoidal', params);
  return {
    model: 'sinusoidal',
    params,
    evaluate,
    equation: strings.equation,
    desmosEquation: strings.desmosEquation,
    desmosRegression: strings.desmosRegression,
    paramSummary: strings.paramSummary,
    r2,
    residuals,
    points: sorted,
    sse,
    n: sorted.length,
  };
}

/**
 * @param {import('../types.js').FitPoint[]} sorted
 * @param {number} C
 */
function estimateOmega(sorted, C) {
  const n = sorted.length;
  const x0 = sorted[0].x;
  const x1 = sorted[n - 1].x;
  const span = x1 - x0;
  if (span <= 0) return NaN;

  // Resample demeaned y onto a uniform grid for autocorrelation
  const N = Math.min(512, Math.max(64, n * 2));
  const dt = span / (N - 1);
  const y = new Float64Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const x = x0 + i * dt;
    while (j < n - 2 && sorted[j + 1].x < x) j++;
    const a = sorted[j];
    const b = sorted[Math.min(j + 1, n - 1)];
    const den = b.x - a.x;
    const t = Math.abs(den) < 1e-15 ? 0 : (x - a.x) / den;
    y[i] = (a.y + t * (b.y - a.y)) - C;
  }

  // Autocorrelation r[lag], find first strong peak after lag 0
  const maxLag = Math.floor(N * 0.45);
  let bestLag = -1;
  let bestR = -Infinity;
  const r0 = autoAt(y, 0);
  if (r0 < 1e-20) {
    // Fallback: zero crossings
    return omegaFromZeroCrossings(sorted, C, span);
  }

  // Skip small lags (noise), require lag corresponding to period fraction
  const minLag = Math.max(2, Math.floor(N * 0.02));
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = autoAt(y, lag) / r0;
    // Local peak
    if (lag > minLag && lag < maxLag) {
      const rm = autoAt(y, lag - 1) / r0;
      const rp = autoAt(y, lag + 1) / r0;
      if (r > rm && r > rp && r > bestR && r > 0.15) {
        bestR = r;
        bestLag = lag;
      }
    }
  }

  if (bestLag < 0) {
    return omegaFromZeroCrossings(sorted, C, span);
  }

  const period = bestLag * dt;
  if (period <= 0) return NaN;
  return (2 * Math.PI) / period;
}

/**
 * @param {Float64Array} y
 * @param {number} lag
 */
function autoAt(y, lag) {
  let s = 0;
  const n = y.length - lag;
  for (let i = 0; i < n; i++) s += y[i] * y[i + lag];
  return s;
}

/**
 * @param {import('../types.js').FitPoint[]} sorted
 * @param {number} C
 * @param {number} span
 */
function omegaFromZeroCrossings(sorted, C, span) {
  const crossings = [];
  for (let i = 1; i < sorted.length; i++) {
    const y0 = sorted[i - 1].y - C;
    const y1 = sorted[i].y - C;
    if (y0 === 0 || y0 * y1 < 0) {
      const den = y1 - y0;
      const t = Math.abs(den) < 1e-15 ? 0 : -y0 / den;
      crossings.push(sorted[i - 1].x + t * (sorted[i].x - sorted[i - 1].x));
    }
  }
  if (crossings.length < 3) {
    // Assume roughly one half-period over the span
    if (span > 0) return Math.PI / span;
    return NaN;
  }
  let sumT = 0;
  let count = 0;
  for (let i = 2; i < crossings.length; i += 2) {
    const T = crossings[i] - crossings[i - 2];
    if (T > 0) { sumT += T; count++; }
  }
  if (count === 0) {
    const T = 2 * (crossings[1] - crossings[0]);
    if (T > 0) return (2 * Math.PI) / T;
    return NaN;
  }
  const period = sumT / count;
  return (2 * Math.PI) / period;
}

/**
 * @param {import('../types.js').FitPoint[]} pts
 * @param {number} omega
 */
function fitAmpPhase(pts, omega) {
  let sumY = 0;
  for (const p of pts) sumY += p.y;
  // Fit C jointly: y = α sin(ωx) + β cos(ωx) + C
  const n = pts.length;
  /** @type {number[][]} */
  const X = Array.from({ length: n }, (_, i) => {
    const x = pts[i].x;
    return [Math.sin(omega * x), Math.cos(omega * x), 1];
  });
  const y = pts.map(p => p.y);
  const [alpha, beta, C] = leastSquares(X, y);
  const A = Math.hypot(alpha, beta);
  // A sin(ωx + φ) = A (sin ωx cos φ + cos ωx sin φ) = α sin + β cos
  // α = A cos φ, β = A sin φ
  let phi = Math.atan2(beta, alpha);
  return { A, phi, C, omega, alpha, beta };
}

/**
 * Golden-section-ish refine of ω around omega0 minimizing SSE.
 * @param {import('../types.js').FitPoint[]} pts
 * @param {number} C0  unused except for bracket scale
 * @param {number} omega0
 */
function refineOmega(pts, C0, omega0) {
  const lo = omega0 * 0.5;
  const hi = omega0 * 1.5;
  let bestW = omega0;
  let bestSse = Infinity;

  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const w = lo + (hi - lo) * (i / steps);
    try {
      const { A, phi, C } = fitAmpPhase(pts, w);
      let sse = 0;
      for (const p of pts) {
        const r = p.y - (A * Math.sin(w * p.x + phi) + C);
        sse += r * r;
      }
      if (sse < bestSse) {
        bestSse = sse;
        bestW = w;
      }
    } catch {
      // skip singular
    }
  }

  // Local polish
  const d = (hi - lo) / steps;
  for (let i = 0; i < 8; i++) {
    const candidates = [bestW - d / (i + 1), bestW, bestW + d / (i + 1)];
    for (const w of candidates) {
      if (w <= 0) continue;
      try {
        const { A, phi, C } = fitAmpPhase(pts, w);
        let sse = 0;
        for (const p of pts) {
          const r = p.y - (A * Math.sin(w * p.x + phi) + C);
          sse += r * r;
        }
        if (sse < bestSse) {
          bestSse = sse;
          bestW = w;
        }
      } catch { }
    }
  }
  return bestW;
}
