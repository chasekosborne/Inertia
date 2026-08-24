/**
 * Video exporter: rasterizes recorded frames from the live SVG canvas.
 *
 * Prefers WebCodecs → MP4 (VP9 / AV1 / H.264, whichever the browser supports).
 * Falls back to MediaRecorder → WebM on builds without WebCodecs encoders
 * (common on Gentoo / unbundled Chromium).
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { COLORS, FONT_DIAGRAM } from '../theme.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Export video frames use pure white (matches live canvas paper). */
const BG = '#ffffff';

/** Paint props copied from the live tree so blob rasterization matches the canvas. */
const PAINT_PROPS = [
  'fill', 'stroke', 'stop-color', 'color',
  'stroke-opacity', 'fill-opacity', 'opacity',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
];

/**
 * Blob-URL SVG images do not receive the page stylesheet, so CSS variables and
 * class-based colours would be lost. Copy computed paint onto the clone and
 * embed a small theme stylesheet as a fallback.
 * @param {SVGSVGElement} source
 * @param {SVGSVGElement} clone
 */
function prepareSvgCloneForExport(source, clone) {
  // Drop selection / hover chrome: export should show textbook ink colours.
  clone.querySelectorAll('.selected, .selected-part, .hover-target').forEach(el => {
    el.classList.remove('selected', 'selected-part', 'hover-target');
  });
  for (const sel of ['#layer-ui-top', '#layer-interaction-ghost', '#vel-handle', '#camera-frame-ui']) {
    clone.querySelector(sel)?.remove();
  }

  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `
    text, tspan {
      font-family: ${FONT_DIAGRAM};
    }
    .body-label {
      fill: ${COLORS.inkLight};
      font-family: ${FONT_DIAGRAM};
      font-size: 11px;
    }
    .constraint-hit {
      stroke: transparent !important;
    }
  `;
  const defs = clone.querySelector('defs');
  if (defs) defs.insertBefore(style, defs.firstChild);
  else clone.insertBefore(style, clone.firstChild);

  const srcEls = [source, ...source.querySelectorAll('*')];
  const dstEls = [clone, ...clone.querySelectorAll('*')];
  if (srcEls.length !== dstEls.length) return;

  for (let i = 0; i < srcEls.length; i++) {
    const src = srcEls[i];
    const dst = dstEls[i];
    if (!(src instanceof Element) || !(dst instanceof Element)) continue;
    if (src.tagName !== dst.tagName) continue;

    // Prefer live presentation attributes (patterns, markers, explicit hex).
    for (const prop of PAINT_PROPS) {
      const attr = src.getAttribute(prop);
      if (attr != null && attr !== '') {
        dst.setAttribute(prop, attr);
      }
    }

    const cs = getComputedStyle(src);
    for (const prop of ['fill', 'stroke']) {
      if (dst.hasAttribute(prop)) continue;
      let v = cs.getPropertyValue(prop).trim();
      if (!v || v === 'none' || v === 'transparent') continue;
      if (v.includes('url(')) continue;
      if (v === 'currentColor') {
        v = cs.getPropertyValue('color').trim() || COLORS.ink;
      }
      dst.setAttribute(prop, v);
    }

    if (src.tagName === 'text' || src.tagName === 'tspan') {
      const ff = cs.fontFamily?.trim();
      const fs = cs.fontSize?.trim();
      const fst = cs.fontStyle?.trim();
      if (ff) dst.setAttribute('font-family', ff);
      if (fs) dst.setAttribute('font-size', fs);
      if (fst && fst !== 'normal') dst.setAttribute('font-style', fst);
      if (!dst.getAttribute('fill')) dst.setAttribute('fill', COLORS.ink);
    }
  }
}

/**
 * @param {SVGSVGElement} svgEl
 * @param {number} width
 * @param {number} height
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function rasterizeSvg(svgEl, width, height) {
  const clone = /** @type {SVGSVGElement} */ (svgEl.cloneNode(true));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  prepareSvgCloneForExport(svgEl, clone);

  const serialized = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // Tag the canvas as sRGB so VideoFrame / encoders don't assume limited-range BT.709.
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', alpha: false });
  if (!ctx) throw new Error('Could not create 2D canvas context.');

  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(undefined);
      img.onerror = () => reject(new Error('Failed to rasterize SVG frame.'));
      img.src = url;
    });
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }

  return canvas;
}

/** sRGB / full-range tags so players don't treat diagram colours as limited-range video. */
const EXPORT_COLOR_SPACE = {
  primaries: /** @type {const} */ ('bt709'),
  transfer: /** @type {const} */ ('iec61966-2-1'),
  matrix: /** @type {const} */ ('bt709'),
  fullRange: true,
};

/**
 * Target bitrate for diagram video (sharp ink + flat fills need more than film content).
 * ~0.22 bits/pixel/frame, floored at 8 Mbps.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 */
function exportBitrate(width, height, fps) {
  return Math.max(8_000_000, Math.round(width * height * fps * 0.22));
}

/**
 * Build a VideoFrame with explicit full-range colour metadata.
 * Falling back to the canvas constructor if ImageData construction isn't supported.
 * @param {HTMLCanvasElement} canvas
 * @param {number} timestampUs
 * @param {number} durationUs
 */
function createExportVideoFrame(canvas, timestampUs, durationUs) {
  const width = canvas.width;
  const height = canvas.height;
  try {
    // Reuse the existing 2d context from rasterizeSvg (options are fixed at creation).
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    const imageData = ctx.getImageData(0, 0, width, height);
    return new VideoFrame(imageData.data, {
      format: 'RGBA',
      codedWidth: width,
      codedHeight: height,
      timestamp: timestampUs,
      duration: durationUs,
      colorSpace: EXPORT_COLOR_SPACE,
    });
  } catch {
    return new VideoFrame(canvas, {
      timestamp: timestampUs,
      duration: durationUs,
    });
  }
}

/** @typedef {{ webCodec: string, muxCodec: 'vp9'|'av1'|'avc', label: string }} EncoderCandidate */

/** Prefer royalty-free codecs first: H.264 is often missing on Linux Chromium. */
const ENCODER_CANDIDATES = /** @type {EncoderCandidate[]} */ ([
  { webCodec: 'vp09.00.10.08', muxCodec: 'vp9', label: 'VP9' },
  { webCodec: 'vp09.00.41.08', muxCodec: 'vp9', label: 'VP9' },
  { webCodec: 'av01.0.08M.08', muxCodec: 'av1', label: 'AV1' },
  { webCodec: 'av01.0.05M.08', muxCodec: 'av1', label: 'AV1' },
  { webCodec: 'avc1.42001E', muxCodec: 'avc', label: 'H.264' },
  { webCodec: 'avc1.4D401E', muxCodec: 'avc', label: 'H.264' },
  { webCodec: 'avc1.64001E', muxCodec: 'avc', label: 'H.264' },
]);

const WEBM_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** @returns {Promise<boolean>} */
export async function mp4ExportSupported() {
  return videoExportSupported();
}

/** @returns {Promise<boolean>} */
export async function videoExportSupported() {
  return (await pickEncoderConfig(640, 360)) != null || pickWebmMimeType() != null;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {Promise<(EncoderCandidate & { codec: string })|null>}
 */
async function pickEncoderConfig(width, height) {
  if (typeof VideoEncoder === 'undefined') return null;

  for (const candidate of ENCODER_CANDIDATES) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec: candidate.webCodec,
        width,
        height,
        bitrate: 4_000_000,
      });
      if (supported) return { ...candidate, codec: candidate.webCodec };
    } catch {
      // isConfigSupported can throw on some builds: try next codec.
    }
  }
  return null;
}

/** @returns {string|null} */
function pickWebmMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of WEBM_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

/**
 * @param {number} width
 * @param {number} height
 */
function normalizeVideoSize(width, height) {
  let w = Math.max(2, Math.round(width ?? 800));
  let h = Math.max(2, Math.round(height ?? 600));
  w &= ~1;
  h &= ~1;
  return { width: w, height: h };
}

/** Simulation duration covered by a recording (seconds). */
export function recordingDurationSec(frames) {
  if (!frames?.length) return 0;
  if (frames.length === 1) return 1 / 60;
  return Math.max(0, frames[frames.length - 1].t - frames[0].t);
}

/**
 * Pick output frame times at a fixed export rate and map each to the nearest
 * recorded simulation frame index.
 * @param {object[]} frames
 * @param {number} fps  Target export frame rate (rounded to a positive integer).
 * @returns {{ indices: number[], exportFps: number, outputFrames: number }}
 */
export function sampleExportFrameIndices(frames, fps) {
  const exportFps = Math.max(1, Math.min(120, Math.round(Number(fps) || 60)));
  if (!frames?.length) return { indices: [], exportFps, outputFrames: 0 };
  if (frames.length === 1) return { indices: [0], exportFps, outputFrames: 1 };

  const t0 = frames[0].t ?? 0;
  const duration = recordingDurationSec(frames);
  const dt = 1 / exportFps;
  /** @type {number[]} */
  const indices = [];

  for (let k = 0; ; k++) {
    const relT = k * dt;
    if (relT > duration + 1e-9) break;
    const target = t0 + relT;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].t - target);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    indices.push(best);
  }

  if (!indices.length) indices.push(0);
  return { indices, exportFps, outputFrames: indices.length };
}

/**
 * Encode recorded frames to a video file (MP4 when possible, else WebM).
 *
 * @param {object[]} frames
 * @param {object} opts
 * @param {(frameIndex: number) => Promise<void>} opts.renderFrame
 * @param {SVGSVGElement} opts.svg
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.fps=60]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{ blob: Blob, filename: string, format: 'mp4'|'webm' }>}
 */
export async function exportRecordingVideo(frames, opts) {
  if (!frames?.length) throw new Error('No recorded frames to export.');

  const { width, height } = normalizeVideoSize(opts.width, opts.height);
  const encoderConfig = await pickEncoderConfig(width, height);
  if (encoderConfig) {
    const blob = await _exportWebCodecsMp4(frames, { ...opts, width, height }, encoderConfig);
    return { blob, filename: 'inertia-recording.mp4', format: 'mp4' };
  }

  const webmMime = pickWebmMimeType();
  if (webmMime) {
    const blob = await _exportMediaRecorderWebm(frames, { ...opts, width, height }, webmMime);
    return { blob, filename: 'inertia-recording.webm', format: 'webm' };
  }

  throw new Error(
    'No video encoder available. WebCodecs (VP9/AV1/H.264) and MediaRecorder are both unavailable '
    + 'in this browser build.',
  );
}

/** @deprecated Use exportRecordingVideo: kept for callers expecting MP4-only. */
export async function exportRecordingMP4(frames, opts) {
  const result = await exportRecordingVideo(frames, opts);
  return result.blob;
}

/**
 * @param {object[]} frames
 * @param {object} opts
 * @param {EncoderCandidate & { codec: string }} encoderConfig
 */
async function _exportWebCodecsMp4(frames, opts, encoderConfig) {
  const { width, height } = opts;
  const { indices, exportFps } = sampleExportFrameIndices(frames, opts.fps ?? 60);
  const total = indices.length;
  const frameDurationUs = Math.round(1_000_000 / exportFps);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: encoderConfig.muxCodec, width, height, frameRate: exportFps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  /** @type {Error|null} */
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encodeError = e instanceof Error ? e : new Error(String(e)); },
  });

  const encoderConfigBase = {
    codec: encoderConfig.codec,
    width,
    height,
    bitrate: exportBitrate(width, height, exportFps),
    framerate: exportFps,
  };
  try {
    encoder.configure({ ...encoderConfigBase, latencyMode: 'quality' });
  } catch {
    encoder.configure(encoderConfigBase);
  }

  const keyInterval = Math.max(1, exportFps);

  for (let k = 0; k < total; k++) {
    if (encodeError) throw encodeError;
    const frameIndex = indices[k];
    await opts.renderFrame(frameIndex);
    const canvas = await rasterizeSvg(opts.svg, width, height);
    const timestampUs = k * frameDurationUs;
    const videoFrame = createExportVideoFrame(canvas, timestampUs, frameDurationUs);
    encoder.encode(videoFrame, { keyFrame: k === 0 || k % keyInterval === 0 });
    videoFrame.close();
    opts.onProgress?.(k + 1, total);
    if (k % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();

  const buffer = muxer.target.buffer;
  if (!buffer?.byteLength) throw new Error('Video export produced an empty file.');
  return new Blob([buffer], { type: 'video/mp4' });
}

/**
 * @param {object[]} frames
 * @param {object} opts
 * @param {string} mimeType
 */
async function _exportMediaRecorderWebm(frames, opts, mimeType) {
  const { width, height } = opts;
  const { indices, exportFps } = sampleExportFrameIndices(frames, opts.fps ?? 60);
  const total = indices.length;
  const frameIntervalMs = 1000 / exportFps;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', alpha: false });
  if (!ctx) throw new Error('Could not create 2D canvas context.');

  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  /** @type {MediaRecorder} */
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: exportBitrate(width, height, exportFps),
  });

  /** @type {BlobPart[]} */
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
    recorder.onerror = () => reject(recorder.error ?? new Error('MediaRecorder failed during export.'));
  });
  recorder.ondataavailable = e => {
    if (e.data?.size) chunks.push(e.data);
  };

  recorder.start();

  for (let k = 0; k < total; k++) {
    await opts.renderFrame(indices[k]);
    const frameCanvas = await rasterizeSvg(opts.svg, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(frameCanvas, 0, 0);
    if (typeof videoTrack.requestFrame === 'function') {
      videoTrack.requestFrame();
    }
    opts.onProgress?.(k + 1, total);
    if (k < total - 1) {
      await new Promise(r => setTimeout(r, Math.max(1, frameIntervalMs)));
    }
    if (k % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }

  await new Promise(r => setTimeout(r, 100));
  recorder.stop();
  const blob = await finished;
  if (!blob.size) throw new Error('Video export produced an empty file.');
  return blob;
}

/**
 * @param {Blob} blob
 * @param {string} [filename]
 */
export function downloadMP4(blob, filename = 'inertia-recording.mp4') {
  downloadVideo(blob, filename);
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadVideo(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the blob URL alive briefly: browsers may still be reading it after click().
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Trigger successive downloads with a short gap so browsers don't coalesce / block them.
 * @param {Array<{ blob: Blob, filename: string }>} files
 * @param {number} [gapMs]
 */
export async function downloadVideosSequentially(files, gapMs = 400) {
  for (let i = 0; i < files.length; i++) {
    const { blob, filename } = files[i];
    downloadVideo(blob, filename);
    if (i < files.length - 1) {
      await new Promise(r => setTimeout(r, gapMs));
    }
  }
}
