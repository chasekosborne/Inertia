/**
 * Diagrammatic spring / coil path shared by live SVG, export, and drag ghosts.
 *
 * Coils fill the true endpoint distance so the squiggle pitch compresses and
 * expands with Hookean length change. Coil amplitude stays roughly constant
 * (real helical springs change pitch, not wire diameter).
 */

/** @typedef {{ coils?: number, ampl?: number, strokeWidth?: number }} SpringPathStyle */

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number|null} [restLen]  Natural length (px), used only for mild amplitude cues
 * @param {SpringPathStyle} [style]
 * @returns {{ d: string, strokeWidth: number }}
 */
export function springPathProps(ax, ay, bx, by, restLen = null, style = {}) {
  const coils = style.coils ?? 8;
  const baseAmpl = style.ampl ?? 7.5;
  const baseSw = style.strokeWidth ?? 1.05;

  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  // Keep amplitude nearly constant so pitch (coil spacing) carries compression.
  // Only nudge when extremely short/long so the mark stays readable.
  const ratio = (restLen && restLen > 1) ? len / restLen : 1;
  const a = Math.max(baseAmpl * 0.55, Math.min(baseAmpl * 1.35, baseAmpl / Math.sqrt(Math.max(ratio, 0.25))));
  const sw = Math.max(1, Math.min(2.4, baseSw * (0.85 + 0.15 / Math.max(ratio, 0.35))));

  // Lead-in / lead-out take a fixed share of length so coils visibly pack/spread.
  const lead = Math.min(len * 0.12, Math.max(4, len / (coils + 3)));
  const coilSpan = Math.max(len - 2 * lead, 1e-3);
  const pitch = coilSpan / coils;

  let d = `M ${ax} ${ay}`;
  d += ` L ${ax + ux * lead} ${ay + uy * lead}`;

  for (let i = 0; i < coils; i++) {
    const t0 = lead + i * pitch;
    const t1 = lead + (i + 0.5) * pitch;
    const t2 = lead + (i + 1) * pitch;
    const sign = (i % 2 === 0) ? 1 : -1;
    // Peak of the zig at mid-pitch, return toward axis at each pitch end.
    d += ` L ${ax + ux * t1 + nx * sign * a} ${ay + uy * t1 + ny * sign * a}`;
    d += ` L ${ax + ux * t2} ${ay + uy * t2}`;
  }

  d += ` L ${bx} ${by}`;
  return { d, strokeWidth: sw };
}
