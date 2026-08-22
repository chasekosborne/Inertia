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
 * Fill an SVG 〈text〉 with italic math, turning `base_sub` into a real subscript
 * via 〈tspan〉 (e.g. `F_sp`, `F_st`). Labels without `_` are left as-is (may
 * already use Unicode like `fₖ`, `v₀`).
 * @param {SVGTextElement} textEl
 * @param {string} label
 */
export function setSvgMathLabel(textEl, label) {
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
  const us = label.indexOf('_');
  if (us <= 0) {
    textEl.appendChild(document.createTextNode(label));
    return;
  }
  textEl.appendChild(document.createTextNode(label.slice(0, us)));
  const tspan = document.createElementNS(SVG_NS, 'tspan');
  tspan.setAttribute('baseline-shift', 'sub');
  tspan.setAttribute('font-size', '70%');
  tspan.textContent = label.slice(us + 1);
  textEl.appendChild(tspan);
}
