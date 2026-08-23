/**
 * Desmos-oriented export: clipboard helpers + open-in-Desmos viewer.
 * Opens a local viewer page that embeds the Desmos calculator API
 * (no Desmos account / OAuth required).
 */

import { fmtDesmos, fmtNum } from '../fit/format.js';

const DESMOS_STORAGE_KEY = 'inertia-desmos-view-v1';
/** Cap table size so the viewer stays responsive. */
const MAX_TABLE_ROWS = 400;

/**
 * @param {number} v
 */
function listNum(v) {
  if (!isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-5)) return Number(v.toPrecision(6)).toString();
  let s = v.toPrecision(8);
  if (s.includes('e') || s.includes('E')) return Number(v.toPrecision(6)).toString();
  return String(Number(s));
}

/**
 * @param {number} v
 */
function latexNum(v) {
  return listNum(v);
}

/**
 * Desmos list pair for pasting into expressions / tables.
 * @param {number[]} xs
 * @param {number[]} ys
 * @param {{ xName?: string, yName?: string }} [opts]
 */
export function formatDesmosLists(xs, ys, opts = {}) {
  const xName = opts.xName ?? 'x_1';
  const yName = opts.yName ?? 'y_1';
  const n = Math.min(xs.length, ys.length);
  const xv = [];
  const yv = [];
  for (let i = 0; i < n; i++) {
    if (!isFinite(xs[i]) || !isFinite(ys[i])) continue;
    xv.push(listNum(xs[i]));
    yv.push(listNum(ys[i]));
  }
  return `${xName}=[${xv.join(', ')}]\n${yName}=[${yv.join(', ')}]`;
}

/**
 * @param {{ t: number, v: number }[] | { x: number, y: number }[]} series
 */
export function seriesToXY(series) {
  const xs = [];
  const ys = [];
  for (const p of series) {
    const x = 't' in p ? p.t : p.x;
    const y = 'v' in p ? p.v : p.y;
    if (isFinite(x) && isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  return { xs, ys };
}

/**
 * @param {{ t: number, v: number }[] | { x: number, y: number }[]} series
 */
export function formatDesmosListsFromSeries(series) {
  const { xs, ys } = seriesToXY(series);
  return formatDesmosLists(xs, ys);
}

/**
 * @param {import('../fit/types.js').FitResult|null|undefined} fitResult
 */
export function formatDesmosEquation(fitResult) {
  if (!fitResult?.desmosEquation) return '';
  return fitResult.desmosEquation;
}

/**
 * @param {import('../fit/types.js').FitResult|null|undefined} fitResult
 */
export function formatDesmosRegression(fitResult) {
  if (!fitResult?.desmosRegression) return '';
  return fitResult.desmosRegression;
}

/**
 * Bundle data + fit for "Copy all".
 * @param {{ t: number, v: number }[]} series
 * @param {import('../fit/types.js').FitResult|null|undefined} fitResult
 */
export function formatDesmosBundle(series, fitResult) {
  const parts = [formatDesmosListsFromSeries(series)];
  if (fitResult?.desmosEquation) {
    parts.push('');
    parts.push(`# fitted equation`);
    parts.push(fitResult.desmosEquation);
  }
  if (fitResult?.desmosRegression) {
    parts.push('');
    parts.push(`# regression template`);
    parts.push(fitResult.desmosRegression);
  }
  if (fitResult?.paramSummary) {
    parts.push('');
    parts.push(`# parameters (display)`);
    parts.push(fitResult.paramSummary);
    if (fitResult.r2 != null) parts.push(`R^2 = ${fmtNum(fitResult.r2)}`);
  }
  return parts.join('\n');
}

/**
 * Subsample evenly if longer than maxRows.
 * @param {number[]} xs
 * @param {number[]} ys
 * @param {number} maxRows
 */
function subsampleXY(xs, ys, maxRows = MAX_TABLE_ROWS) {
  const n = Math.min(xs.length, ys.length);
  if (n <= maxRows) return { xs: xs.slice(0, n), ys: ys.slice(0, n) };
  const outX = [];
  const outY = [];
  for (let i = 0; i < maxRows; i++) {
    const j = Math.round(i * (n - 1) / (maxRows - 1));
    outX.push(xs[j]);
    outY.push(ys[j]);
  }
  return { xs: outX, ys: outY };
}

/**
 * Build Desmos API expression list + viewport for the viewer page.
 * @param {{ t: number, v: number }[]} series
 * @param {import('../fit/types.js').FitResult|null|undefined} fitResult
 * @param {{ title?: string }} [opts]
 */
export function buildDesmosViewPayload(series, fitResult, opts = {}) {
  const raw = seriesToXY(series);
  const { xs, ys } = subsampleXY(raw.xs, raw.ys);
  /** @type {object[]} */
  const expressions = [];

  if (xs.length) {
    expressions.push({
      type: 'table',
      id: 'inertia-table',
      columns: [
        {
          latex: 'x_1',
          values: xs.map(latexNum),
          color: '#2d70b3',
          points: true,
          lines: false,
        },
        {
          latex: 'y_1',
          values: ys.map(latexNum),
          color: '#2d70b3',
          points: true,
          lines: true,
        },
      ],
    });
  }

  if (fitResult?.desmosEquation) {
    expressions.push({
      id: 'inertia-fit',
      latex: fitResult.desmosEquation,
      color: '#a63d2f',
      lineStyle: 'SOLID',
      lineWidth: 2.5,
    });
  }

  let xmin = 0;
  let xmax = 1;
  let ymin = 0;
  let ymax = 1;
  if (xs.length) {
    xmin = Math.min(...xs);
    xmax = Math.max(...xs);
    ymin = Math.min(...ys);
    ymax = Math.max(...ys);
    if (xmax <= xmin) xmax = xmin + 1;
    if (ymax <= ymin) {
      ymin -= 0.5;
      ymax += 0.5;
    }
    const dx = (xmax - xmin) * 0.08;
    const dy = (ymax - ymin) * 0.12;
    xmin -= dx;
    xmax += dx;
    ymin -= dy;
    ymax += dy;
  }

  return {
    version: 1,
    title: opts.title || 'Inertia → Desmos',
    viewport: { xmin, xmax, ymin, ymax },
    expressions,
  };
}

/**
 * Open the Desmos viewer in a new tab with data + fit loaded.
 * Uses localStorage (shared across tabs): sessionStorage is per-tab and
 * often empty in the newly opened window.
 * @param {{ t: number, v: number }[]} series
 * @param {import('../fit/types.js').FitResult|null|undefined} fitResult
 * @param {{ title?: string }} [opts]
 * @returns {boolean}
 */
export function openInDesmos(series, fitResult, opts = {}) {
  if (!series?.length) return false;
  const payload = buildDesmosViewPayload(series, fitResult, opts);
  const json = JSON.stringify(payload);
  try {
    localStorage.setItem(DESMOS_STORAGE_KEY, json);
  } catch {
    return false;
  }
  // Cache-bust so a previously blank tab reload still picks up fresh data.
  const url = new URL('desmos-view.html', window.location.href);
  url.searchParams.set('t', String(Date.now()));
  const win = window.open(url.href, '_blank');
  return !!win;
}

export { DESMOS_STORAGE_KEY };

/**
 * Copy plain text to the clipboard.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  if (text == null || text === '') return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export { fmtDesmos, fmtNum };
