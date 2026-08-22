/**
 * Display rounding and equation / Desmos string formatting for fit results.
 */

/**
 * Round for display (~3-4 significant figures).
 * @param {number} v
 * @param {number} [sig=4]
 */
export function fmtNum(v, sig = 4) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e4 || abs < 1e-3) return v.toExponential(Math.max(1, sig - 1));
  const rounded = Number(v.toPrecision(sig));
  let s = String(rounded);
  if (s.includes('e') || s.includes('E')) return v.toExponential(Math.max(1, sig - 1));
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

/**
 * Desmos-safe number (ASCII minus).
 * @param {number} v
 */
export function fmtDesmos(v) {
  return fmtNum(v).replace(/−/g, '-');
}

/**
 * @param {number} c
 * @param {number} k
 * @param {boolean} desmos
 * @param {boolean} first
 */
function polyTerm(c, k, desmos, first) {
  const f = desmos ? fmtDesmos : fmtNum;
  const abs = Math.abs(c);
  let body;
  if (k === 0) body = f(abs);
  else if (k === 1) body = `${f(abs)}x`;
  else body = desmos ? `${f(abs)}x^{${k}}` : `${f(abs)}x^${k}`;

  if (first) return c < 0 ? `-${body}` : body;
  return c < 0 ? (desmos ? `-${body}` : ` - ${body}`) : (desmos ? `+${body}` : ` + ${body}`);
}

function formatUiSin(A, omega, phi, C) {
  let s = `y = ${fmtNum(A)} sin(${fmtNum(omega)}x`;
  if (phi < 0) s += ` − ${fmtNum(-phi)}`;
  else if (Math.abs(phi) > 1e-15) s += ` + ${fmtNum(phi)}`;
  s += ')';
  if (C < 0) s += ` − ${fmtNum(-C)}`;
  else if (Math.abs(C) > 1e-15) s += ` + ${fmtNum(C)}`;
  return s;
}

function formatDesmosSin(A, omega, phi, C) {
  let s = `y=${fmtDesmos(A)}\\sin(${fmtDesmos(omega)}x`;
  if (phi < 0) s += `-${fmtDesmos(-phi)}`;
  else if (Math.abs(phi) > 1e-15) s += `+${fmtDesmos(phi)}`;
  s += ')';
  if (C < 0) s += `-${fmtDesmos(-C)}`;
  else if (Math.abs(C) > 1e-15) s += `+${fmtDesmos(C)}`;
  return s;
}

function formatDesmosLinear(m, b) {
  const ms = fmtDesmos(m);
  if (b === 0) return `y=${ms}x`;
  if (b < 0) return `y=${ms}x-${fmtDesmos(-b)}`;
  return `y=${ms}x+${fmtDesmos(b)}`;
}

/**
 * Build UI + Desmos strings for a completed model.
 * @param {import('./types.js').FitModelId} model
 * @param {Record<string, number>} params
 * @param {number} [degree]
 */
export function formatFitStrings(model, params, degree) {
  if (model === 'linear') {
    const { m, b } = params;
    const equation = b === 0
      ? `y = ${fmtNum(m)}x`
      : (b < 0 ? `y = ${fmtNum(m)}x − ${fmtNum(-b)}` : `y = ${fmtNum(m)}x + ${fmtNum(b)}`);
    return {
      equation,
      desmosEquation: formatDesmosLinear(m, b),
      desmosRegression: 'y_1\\sim mx_1+b',
      paramSummary: `m = ${fmtNum(m)},  b = ${fmtNum(b)}`,
    };
  }

  if (model === 'polynomial') {
    const deg = degree ?? Math.max(0, ...Object.keys(params)
      .filter(k => /^a\d+$/.test(k))
      .map(k => Number(k.slice(1))));
    /** @type {number[]} */
    const a = [];
    for (let k = 0; k <= deg; k++) a[k] = params[`a${k}`] ?? 0;

    let equation = 'y = ';
    let desmosEquation = 'y=';
    let first = true;
    for (let k = deg; k >= 0; k--) {
      const c = a[k];
      if (Math.abs(c) < 1e-15 && !(k === 0 && first)) continue;
      equation += polyTerm(c, k, false, first);
      desmosEquation += polyTerm(c, k, true, first);
      first = false;
    }
    if (first) {
      equation += '0';
      desmosEquation += '0';
    }

    const paramSummary = Array.from({ length: deg + 1 }, (_, i) => {
      const k = deg - i;
      return `a_${k} = ${fmtNum(a[k])}`;
    }).join(',  ');

    const letters = 'abcdefghij';
    const regParts = [];
    for (let k = deg; k >= 0; k--) {
      const L = letters[deg - k] || `p_${k}`;
      if (k === 0) regParts.push(L);
      else if (k === 1) regParts.push(`${L}x_1`);
      else regParts.push(`${L}x_1^{${k}}`);
    }

    return {
      equation,
      desmosEquation,
      desmosRegression: `y_1\\sim ${regParts.join('+')}`,
      paramSummary,
    };
  }

  if (model === 'exponential') {
    const { A, k } = params;
    return {
      equation: `y = ${fmtNum(A)} e^(${fmtNum(k)}x)`,
      desmosEquation: `y=${fmtDesmos(A)}e^{${fmtDesmos(k)}x}`,
      desmosRegression: 'y_1\\sim ae^{bx_1}',
      paramSummary: `A = ${fmtNum(A)},  k = ${fmtNum(k)}`,
    };
  }

  if (model === 'logarithmic') {
    const { a, b } = params;
    const equation = b === 0
      ? `y = ${fmtNum(a)} ln(x)`
      : (b < 0
        ? `y = ${fmtNum(a)} ln(x) − ${fmtNum(-b)}`
        : `y = ${fmtNum(a)} ln(x) + ${fmtNum(b)}`);
    const desmosEquation = b === 0
      ? `y=${fmtDesmos(a)}\\ln(x)`
      : (b < 0
        ? `y=${fmtDesmos(a)}\\ln(x)-${fmtDesmos(-b)}`
        : `y=${fmtDesmos(a)}\\ln(x)+${fmtDesmos(b)}`);
    return {
      equation,
      desmosEquation,
      desmosRegression: 'y_1\\sim a\\ln(x_1)+b',
      paramSummary: `a = ${fmtNum(a)},  b = ${fmtNum(b)}`,
    };
  }

  if (model === 'power') {
    const { A, k } = params;
    return {
      equation: `y = ${fmtNum(A)} x^${fmtNum(k)}`,
      desmosEquation: `y=${fmtDesmos(A)}x^{${fmtDesmos(k)}}`,
      desmosRegression: 'y_1\\sim ax_1^{b}',
      paramSummary: `A = ${fmtNum(A)},  k = ${fmtNum(k)}`,
    };
  }

  if (model === 'sinusoidal') {
    const { A, omega, phi, C } = params;
    return {
      equation: formatUiSin(A, omega, phi, C),
      desmosEquation: formatDesmosSin(A, omega, phi, C),
      desmosRegression: 'y_1\\sim a\\sin(bx_1+c)+d',
      paramSummary: `A = ${fmtNum(A)},  ω = ${fmtNum(omega)},  φ = ${fmtNum(phi)},  C = ${fmtNum(C)}`,
    };
  }

  return {
    equation: 'y = ?',
    desmosEquation: 'y=0',
    desmosRegression: null,
    paramSummary: '',
  };
}
