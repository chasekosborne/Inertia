/**
 * Graph video export: resolution / aspect helpers for plot animations.
 */

/** @typedef {'16:9'|'4:3'|'3:2'|'1:1'|'9:16'|'auto'} GraphAspectPreset */
/** @typedef {'720p'|'1080p'|'1440p'|'4k'} GraphResolutionPreset */
/** @typedef {'draw'|'playback'} GraphAnimMode */

export const GRAPH_ASPECT_OPTIONS = /** @type {const} */ ([
  { id: '16:9', w: 16, h: 9, label: '16∶9' },
  { id: '4:3', w: 4, h: 3, label: '4∶3' },
  { id: '3:2', w: 3, h: 2, label: '3∶2' },
  { id: '1:1', w: 1, h: 1, label: '1∶1' },
  { id: '9:16', w: 9, h: 16, label: '9∶16' },
  { id: 'auto', label: 'Auto (plot)' },
]);

const SHORT_SIDE = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 };

/**
 * Pixel export size for a graph video preset and aspect ratio.
 * @param {GraphResolutionPreset} preset
 * @param {GraphAspectPreset} aspectId
 * @param {number} [autoAspect=16/9] Plot width ÷ height when aspect is auto.
 */
export function graphExportDimensions(preset, aspectId, autoAspect = 16 / 9) {
  const shortSide = SHORT_SIDE[preset] ?? 1080;
  let aspect = Math.max(0.05, autoAspect);
  if (aspectId !== 'auto') {
    const opt = GRAPH_ASPECT_OPTIONS.find(o => o.id === aspectId);
    if (opt?.w && opt?.h) aspect = opt.w / opt.h;
  }
  let width;
  let height;
  if (aspect >= 1) {
    height = shortSide;
    width = Math.round(shortSide * aspect);
  } else {
    width = shortSide;
    height = Math.round(shortSide / aspect);
  }
  width = Math.max(2, width & ~1);
  height = Math.max(2, height & ~1);
  return { width, height, label: `${width} × ${height}` };
}

/** @param {string} title */
export function graphExportSlug(title) {
  return String(title ?? 'graph')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'graph';
}
