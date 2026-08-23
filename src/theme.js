/**
 * Shared typography and palette for UI (CSS) and SVG diagram labels.
 */

export const FONT_SERIF =
  "'Source Serif 4', 'Libre Baskerville', Georgia, 'Times New Roman', serif";
export const FONT_SANS =
  "'DM Sans', 'Segoe UI', system-ui, sans-serif";

/**
 * LaTeX / Computer Modern face (loaded via KaTeX CSS).
 * Used for variables, Greek letters, and diagram vector labels.
 */
export const FONT_MATH =
  "KaTeX_Main, 'Latin Modern Roman', 'Times New Roman', Times, serif";

/** Physics notation on the canvas: vector labels, angles, v₀, etc. */
export const FONT_DIAGRAM = FONT_MATH;

export const COLORS = {
  /** Diagram ink: soft off-black (slightly gray, not pure #000 / #1a1a1a). */
  ink: '#333333',
  inkLight: '#666666',
  /** Desmos-style saturated royal blue. */
  blue: '#2d70b3',
  /** Fitted curve overlay on graphs. */
  fit: '#a63d2f',
  paper: '#ffffff',
  /** Sweep scatter: overall max / min Y markers. */
  sweepMax: '#b8860b',
  sweepMin: '#2a6f6f',
};
