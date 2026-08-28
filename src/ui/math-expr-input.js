/**
 * Desmos-style symbolic drive-expression input (MathLive, no virtual keyboard).
 *
 * Edits LaTeX visually; values round-trip through {@link latexToExpr} /
 * {@link exprToLatex} into the ASCII dialect used by {@link compileExpr}.
 */

import 'mathlive/fonts.css';
import { MathfieldElement } from 'mathlive';
import { latexToExpr, exprToLatex } from '../physics/expr.js';

let configured = false;

function configureMathLive() {
  if (configured) return;
  configured = true;
  MathfieldElement.keypressSound = null;
  MathfieldElement.plonkSound = null;
  MathfieldElement.keypressVibration = false;
}

/**
 * Mount a math-field into `container` (replaces children).
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} opts.expr            Initial ASCII expression
 * @param {string} [opts.fallbackExpr]  Used when the field is empty on apply
 * @param {(ascii: string) => void} opts.onApply
 */
export function mountMathExprInput(container, { expr, fallbackExpr = '', onApply }) {
  if (!container || container.dataset.bound === '1') return;

  configureMathLive();

  const mf = document.createElement('math-field');
  mf.classList.add('prop-math-expr-field');
  mf.setAttribute('math-virtual-keyboard-policy', 'manual');
  mf.setAttribute('popover-policy', 'off');
  mf.setAttribute('default-mode', 'math');

  const initial = exprToLatex(expr || fallbackExpr);
  mf.setValue(initial, { silenceNotifications: true });

  const apply = () => {
    const latex = mf.getValue('latex');
    const ascii = latexToExpr(latex).trim() || fallbackExpr;
    onApply(ascii);
  };

  mf.addEventListener('change', apply);
  mf.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
      mf.blur();
    }
  });

  container.replaceChildren(mf);
  container.dataset.bound = '1';
  container.dataset.mode = 'math';

  // menuItems requires a mounted mathfield — hide menu via CSS instead.
  mf.addEventListener('mount', () => {
    try { mf.menuItems = []; } catch { /* CSS fallback hides toggle */ }
  }, { once: true });
}

/**
 * @param {HTMLElement} container
 * @param {string} expr  ASCII expression
 */
export function syncMathExprInput(container, expr) {
  const mf = container.querySelector('math-field');
  if (!mf) return;
  mf.setValue(exprToLatex(expr), { silenceNotifications: true });
}
