/**
 * LaTeX-style math notation for UI labels (HTML) and plain-text contexts
 * (〈select〉 options, SVG textContent where HTML isn't available).
 */

/** Wrap inner HTML in the shared `.math` span (KaTeX / Computer Modern italic). */
export function mathHtml(inner) {
  return `<span class="math">${inner}</span>`;
}

/** Base + subscript as HTML, e.g. `v` + `0` → italic v₀. */
export function subHtml(base, sub) {
  return mathHtml(`${base}<sub>${sub}</sub>`);
}

/** Common property / settings label fragments (HTML). */
export const MATH = {
  F:     mathHtml('F'),
  x:     mathHtml('x'),
  y:     mathHtml('y'),
  v0:    mathHtml('v<sub>0</sub>'),
  vx:    mathHtml('v<sub>x</sub>'),
  vy:    mathHtml('v<sub>y</sub>'),
  Fx:    mathHtml('F<sub>x</sub>'),
  Fy:    mathHtml('F<sub>y</sub>'),
  L:     mathHtml('L'),
  tau:   mathHtml('τ'),
  omega: mathHtml('ω'),
  theta: mathHtml('θ'),
  mus:   mathHtml('μ<sub>s</sub>'),
  muk:   mathHtml('μ<sub>k</sub>'),
  xm:    mathHtml('x<sub>m</sub>'),
  ym:    mathHtml('y<sub>m</sub>'),
  g:     mathHtml('g'),
  Cd:    mathHtml('C<sub>d</sub>'),
  A:     mathHtml('A'),
  rho:   mathHtml('ρ'),
  k:     mathHtml('k'),
  ell:   mathHtml('ℓ'),
  dx:    mathHtml('Δx'),
  dy:    mathHtml('Δy'),
};

/**
 * Plain-text math (Unicode subscripts) for 〈option〉 labels and similar.
 * Prefer these over underscore ASCII (`v_y`, `μ_k`).
 */
export const MATH_PLAIN = {
  F: 'F',
  v0: 'v₀',
  vx: 'vₓ',
  vy: 'vᵧ',
  Fx: 'Fₓ',
  Fy: 'Fᵧ',
  theta: 'θ',
  mus: 'μₛ',
  muk: 'μₖ',
  /** Plain selects can’t do HTML subscripts, use Cd (HTML UI uses C<sub>d</sub>). */
  Cd: 'Cd',
  Fsp: 'Fₛₚ',
  Fst: 'Fₛₜ',
  fk: 'fₖ',
  ell: 'ℓ',
  dx: 'Δx',
  dy: 'Δy',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Common LaTeX / plain-Greek identifiers → Unicode (base or subscript tokens).
 * Matched case-insensitively after an optional leading `\`.
 */
const MATH_TOKEN = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ',
  Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Omega: 'Ω',
  ell: 'ℓ', hbar: 'ℏ',
  deg: '°', degree: '°',
};

/**
 * Map a single math token (`theta`, `\omega`, `m`) to display text.
 * @param {string} raw
 * @returns {string}
 */
export function resolveMathToken(raw) {
  if (typeof raw !== 'string' || !raw) return raw ?? '';
  let t = raw.trim();
  if (t.startsWith('\\')) t = t.slice(1);
  if (Object.prototype.hasOwnProperty.call(MATH_TOKEN, t)) return MATH_TOKEN[t];
  const lower = t.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MATH_TOKEN, lower)) return MATH_TOKEN[lower];
  return t;
}

/**
 * Strip optional `$...$` wrappers used in LaTeX-ish label entry.
 * @param {string} label
 */
function unwrapMathDelimiters(label) {
  let s = label.trim();
  if (s.length >= 2 && s.startsWith('$') && s.endsWith('$')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Append math notation (base + optional subscript) to an SVG 〈text〉.
 * @param {SVGTextElement} textEl
 * @param {string} label
 */
function appendSvgMathLabel(textEl, label) {
  const s = unwrapMathDelimiters(label);
  const us = s.indexOf('_');
  const baseRaw = us > 0 ? s.slice(0, us) : s;
  const subRaw = us > 0 ? s.slice(us + 1) : null;

  textEl.appendChild(document.createTextNode(resolveMathToken(baseRaw)));

  if (subRaw != null && subRaw !== '') {
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    // Relative shift: works in Chromium / Firefox / Safari (unlike baseline-shift alone).
    tspan.setAttribute('dy', '0.4em');
    tspan.setAttribute('font-size', '70%');
    tspan.textContent = resolveMathToken(subRaw);
    textEl.appendChild(tspan);
  }
}

/**
 * Fill an SVG 〈text〉 with math-ish notation:
 * - `base_sub` → base with a real subscript via 〈tspan dy〉 (e.g. `theta_0` → θ₀)
 * - Greek / LaTeX names (`theta`, `\omega`, `ell`) map to Unicode
 * - Labels without `_` still get Greek-name resolution (`theta` → θ)
 *
 * Prefer `dy` over `baseline-shift` for cross-browser SVG subscripts.
 *
 * @param {SVGTextElement} textEl
 * @param {string} label
 */
export function setSvgMathLabel(textEl, label) {
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
  if (typeof label !== 'string' || !label) return;
  appendSvgMathLabel(textEl, label);
}

/**
 * Axis / title string: math symbol (with optional subscript) plus optional unit in parens.
 * e.g. `θ_1 (°)`, `theta_2 (°)`, `t (s)`.
 *
 * @param {SVGTextElement} textEl
 * @param {string} title
 */
export function setSvgAxisTitle(textEl, title) {
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
  if (typeof title !== 'string' || !title) return;

  const trimmed = title.trim();
  const unitMatch = /^(.*)\s+\(([^)]+)\)\s*$/.exec(trimmed);
  const mathPart = (unitMatch ? unitMatch[1] : trimmed).trim();
  const unitPart = unitMatch ? unitMatch[2].trim() : null;

  if (mathPart) appendSvgMathLabel(textEl, mathPart);
  if (unitPart) textEl.appendChild(document.createTextNode(` (${unitPart})`));
}
