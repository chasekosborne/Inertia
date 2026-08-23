/**
 * Export controls: the toolbar buttons and the video-export dialog.
 *
 * Owns its own markup (the `video-export-*` ids in index.html) and drives the
 * three exporter modules: {@link ../exporter/mp4-exporter.js} for the
 * simulation video, {@link ../exporter/graph-video.js} for plot sizing, and
 * {@link ../exporter/svg-exporter.js} for the animated SVG.
 *
 * A batch run can emit several files — the simulation plus one video per graph
 * window — so it drives playback and the camera rig directly, then restores
 * both in a `finally`.
 *
 * The only method the app needs is {@link ExportControls#syncButtons}, called
 * whenever recording state changes.
 */

import {
  exportRecordingVideo, downloadVideosSequentially, videoExportSupported,
  recordingDurationSec, sampleExportFrameIndices,
} from './mp4-exporter.js';
import { exportAnimatedSVG, downloadSVG } from './svg-exporter.js';
import { graphExportDimensions, GRAPH_ASPECT_OPTIONS } from './graph-video.js';

const MIN_FPS = 1;
const MAX_FPS = 120;
const DEFAULT_FPS = 60;
const DEFAULT_RESOLUTION = '1080p';
const DEFAULT_FILENAME = 'inertia-recording';

const RESOLUTION_OPTIONS = [
  ['720p', '720p'], ['1080p', '1080p'], ['1440p', '1440p'], ['4k', '4K'],
];
const FPS_OPTIONS = [['24', '24 fps'], ['30', '30 fps'], ['60', '60 fps']];
const ANIMATION_OPTIONS = [
  ['draw', 'Draw progressively'],
  ['playback', 'Playback (dot on path)'],
];

/** @param {unknown} raw */
function clampFps(raw) {
  const value = parseInt(String(raw ?? DEFAULT_FPS), 10) || DEFAULT_FPS;
  return Math.max(MIN_FPS, Math.min(MAX_FPS, value));
}

/** File extension for an encoded blob, preferring the name the encoder chose. */
function blobExtension(outputName, blob) {
  return outputName.split('.').pop() ?? (blob.type.includes('webm') ? 'webm' : 'mp4');
}

function byId(id) {
  return document.getElementById(id);
}

export class ExportControls {
  /**
   * @param {object} deps
   * @param {object} deps.engine
   * @param {object} deps.recorder
   * @param {object} deps.playback
   * @param {object} deps.renderer
   * @param {object} deps.graphHost
   * @param {object} deps.cameraRig
   * @param {object} deps.camera
   * @param {SVGSVGElement} deps.svg
   * @param {{ sync: () => void }} deps.labels
   * @param {{ sync: () => void }} deps.measurements
   * @param {() => void} deps.enterReview      Switch the app into review mode.
   * @param {() => void} deps.closeMenu        Close the preset dropdown.
   * @param {() => void} deps.applyCameraRig   Restore the on-screen framing.
   * @param {() => { width: number, height: number }} deps.getViewSize
   * @param {() => { grid: boolean, vectors: boolean, traces: boolean }} deps.getViewToggles
   * @param {() => string} deps.getStatus
   * @param {(html: string) => void} deps.setStatus
   */
  constructor(deps) {
    this.deps = deps;

    /** Resolved by an async probe; buttons stay disabled until it lands. */
    this._videoSupported = false;
    this._busy = false;

    this.elements = {
      exportSvg: byId('btn-export-svg'),
      exportVideo: byId('btn-export-mp4'),
      backdrop: byId('video-export-backdrop'),
      close: byId('btn-video-export-close'),
      cancel: byId('btn-video-export-cancel'),
      run: byId('btn-video-export-run'),
      preset: byId('video-export-preset'),
      size: byId('video-export-size'),
      fps: byId('video-export-fps'),
      filename: byId('video-export-filename'),
      frameCount: byId('video-export-frame-count'),
      includeSim: byId('video-export-include-sim'),
      simPanel: byId('video-export-sim-panel'),
      includeGraphs: byId('video-export-include-graphs'),
      graphPanel: byId('video-export-graph-panel'),
      graphList: byId('video-export-graph-list'),
      graphEmpty: byId('video-export-graph-empty'),
    };

    this._bindEvents();

    videoExportSupported().then(supported => {
      this._videoSupported = supported;
      if (!supported && this.elements.exportVideo) {
        this.elements.exportVideo.title =
          'Video export requires WebCodecs or MediaRecorder';
      }
      this.syncButtons();
    });
  }

  // ─── Public ──────────────────────────────────────────────────────

  /**
   * Enable / disable the toolbar export buttons.
   * @param {boolean} [forceDisable] Disable regardless of state (e.g. while recording).
   */
  syncButtons(forceDisable = false) {
    const { recorder, graphHost } = this.deps;
    const { exportSvg, exportVideo } = this.elements;
    const hasFrames = !forceDisable && recorder.frameCount > 0 && !this._busy;
    const hasGraphExport = !forceDisable
      && graphHost.listVideoExportCandidates().length > 0
      && !this._busy;
    // SVG export UI is hidden for now; keep the exporter module for later.
    if (exportSvg) exportSvg.disabled = true;
    if (exportVideo) {
      exportVideo.disabled =
        (!hasFrames && !hasGraphExport) || !this._videoSupported || this._busy;
    }
  }

  // ─── Wiring ──────────────────────────────────────────────────────

  _bindEvents() {
    const el = this.elements;

    el.exportSvg?.addEventListener('click', () => this._onExportSvg());
    el.exportVideo?.addEventListener('click', () => {
      this.deps.closeMenu();
      if (el.exportVideo.disabled || this._busy) return;
      this._openDialog();
    });

    el.preset?.addEventListener('change', () => this._applyPreset());
    el.fps?.addEventListener('change', () => this._updateFrameCount());
    el.includeSim?.addEventListener('change', () => this._syncPanels());
    el.includeGraphs?.addEventListener('change', () => this._syncPanels());

    el.close?.addEventListener('click', () => this._closeDialog());
    el.cancel?.addEventListener('click', () => this._closeDialog());
    el.backdrop?.addEventListener('click', event => {
      if (event.target === el.backdrop) this._closeDialog();
    });

    el.run?.addEventListener('click', () => this._onRun());
  }

  async _onRun() {
    if (this.elements.run.disabled || this._busy) return;
    const options = this._readOptions();
    if (!options.includeSim && (!options.includeGraphs || !options.graphs.length)) return;
    this._closeDialog();
    try {
      await this._runBatch(options);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Video export failed.');
    }
  }

  _onExportSvg() {
    const { recorder, closeMenu, getViewSize, getViewToggles } = this.deps;
    closeMenu();
    // The SVG button is currently absent from index.html; kept for when it returns.
    if (!this.elements.exportSvg || this.elements.exportSvg.disabled) return;
    const { width, height } = getViewSize();
    const toggles = getViewToggles();
    const markup = exportAnimatedSVG(recorder.frames, {
      width,
      height,
      showGrid: toggles.grid,
      showTraces: toggles.traces,
      showVectors: toggles.vectors,
    });
    downloadSVG(markup, 'inertia-animation.svg');
  }

  // ─── Dialog ──────────────────────────────────────────────────────

  _openDialog() {
    const { recorder, graphHost, closeMenu } = this.deps;
    const el = this.elements;
    closeMenu();
    if (el.preset) el.preset.value = DEFAULT_RESOLUTION;
    this._applyPreset();
    graphHost.prepareVideoExport();
    this._updateFrameCount();

    const hasFrames = recorder.frameCount > 0;
    const summaries = graphHost.getVideoExportSummaries();
    const exportableGraphs = summaries.filter(summary => summary.canExport);

    if (el.includeSim) {
      el.includeSim.checked = hasFrames;
      el.includeSim.disabled = !hasFrames;
    }
    if (el.simPanel) el.simPanel.classList.toggle('hidden', !el.includeSim?.checked);
    if (el.includeGraphs) {
      el.includeGraphs.checked = exportableGraphs.length > 0;
      el.includeGraphs.disabled = summaries.length === 0;
    }

    this._rebuildGraphList();
    this._syncPanels();
    el.backdrop?.classList.remove('hidden');
    el.backdrop?.setAttribute('aria-hidden', 'false');
  }

  _closeDialog() {
    this.elements.backdrop?.classList.add('hidden');
    this.elements.backdrop?.setAttribute('aria-hidden', 'true');
  }

  _syncPanels() {
    const el = this.elements;
    if (el.simPanel) {
      el.simPanel.classList.toggle('hidden', !el.includeSim?.checked);
    }
    if (el.graphPanel) {
      el.graphPanel.classList.toggle('hidden', !el.includeGraphs?.checked);
    }
    if (el.run) {
      const sim = !!el.includeSim?.checked;
      const graphs = !!el.includeGraphs?.checked
        && !!el.graphList?.querySelector(
          '.graph-export-row:not(.is-disabled) input[type="checkbox"]:checked',
        );
      el.run.disabled = !sim && !graphs;
    }
  }

  _applyPreset() {
    const preset = this.elements.preset?.value ?? DEFAULT_RESOLUTION;
    const { label } = this.deps.cameraRig.exportDimensionsForPreset(preset);
    if (this.elements.size) this.elements.size.textContent = label;
  }

  _updateFrameCount() {
    const { recorder } = this.deps;
    const el = this.elements;
    if (!el.frameCount) return;
    const recorded = recorder.frameCount;
    if (recorded <= 0) {
      el.frameCount.textContent = '0';
      return;
    }
    const duration = recordingDurationSec(recorder.frames);
    const fps = clampFps(el.fps?.value);
    const { outputFrames } = sampleExportFrameIndices(recorder.frames, fps);
    el.frameCount.textContent =
      `${outputFrames} export frames from ${recorded} recorded `
      + `(${duration.toFixed(3)} s sim time @ ${fps} fps)`;
  }

  // ─── Per-graph rows ──────────────────────────────────────────────

  _rebuildGraphList() {
    const el = this.elements;
    if (!el.graphList) return;
    el.graphList.innerHTML = '';
    const summaries = this.deps.graphHost.getVideoExportSummaries();
    if (el.graphEmpty) {
      el.graphEmpty.classList.toggle('hidden', summaries.length > 0);
    }
    for (const summary of summaries) {
      el.graphList.appendChild(this._buildGraphRow(summary));
    }
  }

  _buildGraphRow(summary) {
    const row = document.createElement('div');
    row.className = 'graph-export-row' + (summary.canExport ? '' : ' is-disabled');
    row.dataset.exportId = String(summary.id);

    const head = document.createElement('div');
    head.className = 'graph-export-row-head';
    const includeLabel = document.createElement('label');
    const includeCheckbox = document.createElement('input');
    includeCheckbox.type = 'checkbox';
    includeCheckbox.checked = summary.canExport;
    includeCheckbox.disabled = !summary.canExport;
    includeCheckbox.dataset.role = 'include';
    const titleWrap = document.createElement('span');
    titleWrap.className = 'graph-export-row-title';
    titleWrap.textContent = summary.title;
    if (!summary.canExport && summary.reason) {
      const note = document.createElement('span');
      note.className = 'graph-export-row-note';
      note.textContent = summary.reason;
      titleWrap.appendChild(document.createElement('br'));
      titleWrap.appendChild(note);
    }
    includeLabel.append(includeCheckbox, titleWrap);
    head.appendChild(includeLabel);
    row.appendChild(head);

    const settings = document.createElement('div');
    settings.className = 'graph-export-settings';

    const aspectSelect = this._select('aspect',
      GRAPH_ASPECT_OPTIONS.map(option => [option.id, option.label]));
    aspectSelect.value = summary.plotAspect >= 1.2
      ? '16:9'
      : summary.plotAspect >= 0.95 ? '4:3' : '9:16';

    const presetSelect = this._select('preset', RESOLUTION_OPTIONS, DEFAULT_RESOLUTION);
    const fpsSelect = this._select('fps', FPS_OPTIONS, String(DEFAULT_FPS));
    const animationSelect = this._select('anim', ANIMATION_OPTIONS);

    const sizeReadout = document.createElement('span');
    sizeReadout.className = 'export-size-readout';
    sizeReadout.dataset.role = 'size';

    const syncSize = () => {
      const { label } = graphExportDimensions(
        /** @type {import('./graph-video.js').GraphResolutionPreset} */ (presetSelect.value),
        /** @type {import('./graph-video.js').GraphAspectPreset} */ (aspectSelect.value),
        summary.plotAspect,
      );
      sizeReadout.textContent = label;
    };
    aspectSelect.addEventListener('change', syncSize);
    presetSelect.addEventListener('change', syncSize);
    includeCheckbox.addEventListener('change', () => this._syncPanels());
    syncSize();

    settings.append(
      this._label('Aspect'), aspectSelect,
      this._label('Resolution'), presetSelect,
      this._label('Output'), sizeReadout,
      this._label('Frame rate'), fpsSelect,
      this._label('Animation'), animationSelect,
    );
    row.appendChild(settings);

    if (!summary.canExport) {
      for (const select of settings.querySelectorAll('select')) select.disabled = true;
    }
    return row;
  }

  _label(text) {
    const span = document.createElement('span');
    span.className = 'prop-label';
    span.textContent = text;
    return span;
  }

  /** @param {Array<[string, string]>} options */
  _select(role, options, selected = null) {
    const select = document.createElement('select');
    select.className = 'prop-value';
    select.dataset.role = role;
    for (const [value, label] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (selected != null && value === selected) option.selected = true;
      select.appendChild(option);
    }
    return select;
  }

  // ─── Reading the dialog ──────────────────────────────────────────

  _readGraphEntries() {
    const el = this.elements;
    if (!el.includeGraphs?.checked || !el.graphList) return [];
    const entries = [];
    for (const row of el.graphList.querySelectorAll('.graph-export-row')) {
      const include = row.querySelector('input[data-role="include"]');
      if (!include?.checked || row.classList.contains('is-disabled')) continue;
      const graphWindow = this.deps.graphHost.findByExportId(Number(row.dataset.exportId));
      if (!graphWindow) continue;
      const aspect = row.querySelector('select[data-role="aspect"]')?.value ?? '16:9';
      const preset = row.querySelector('select[data-role="preset"]')?.value ?? DEFAULT_RESOLUTION;
      const fps = clampFps(row.querySelector('select[data-role="fps"]')?.value);
      const animationMode =
        row.querySelector('select[data-role="anim"]')?.value === 'playback'
          ? 'playback'
          : 'draw';
      const { width, height } = graphExportDimensions(
        /** @type {import('./graph-video.js').GraphResolutionPreset} */ (preset),
        /** @type {import('./graph-video.js').GraphAspectPreset} */ (aspect),
        graphWindow.getPlotAspect(),
      );
      entries.push({ graphWindow, width, height, fps, animationMode, preset, aspect });
    }
    return entries;
  }

  _readOptions() {
    const el = this.elements;
    const preset = el.preset?.value ?? DEFAULT_RESOLUTION;
    const { width, height } = this.deps.cameraRig.exportDimensionsForPreset(preset);
    const baseName =
      String(el.filename?.value ?? DEFAULT_FILENAME).trim() || DEFAULT_FILENAME;
    return {
      includeSim: !!el.includeSim?.checked,
      includeGraphs: !!el.includeGraphs?.checked,
      width,
      height,
      fps: clampFps(el.fps?.value),
      baseName: baseName.replace(/\.(mp4|webm)$/i, ''),
      graphs: this._readGraphEntries(),
    };
  }

  // ─── Running the export ──────────────────────────────────────────

  /** Hide interactive chrome so it does not get rasterized into the video. */
  async _withUiHidden(run) {
    const { renderer } = this.deps;
    const hidden = [];
    for (const layer of [renderer.uiTopLayer, renderer.interactionGhostLayer]) {
      if (layer && layer.style.display !== 'none') {
        hidden.push(layer);
        layer.style.display = 'none';
      }
    }
    try {
      return await run();
    } finally {
      for (const layer of hidden) layer.style.display = '';
    }
  }

  /** Apply toolbar view toggles to the renderer before export. */
  _syncViewToggles() {
    const { renderer, recorder, playback, getViewToggles } = this.deps;
    const toggles = getViewToggles();
    renderer.setShowGrid(toggles.grid);
    renderer.setShowVectors(toggles.vectors);
    renderer.setShowTraces(toggles.traces);
    if (toggles.traces) {
      renderer.setTracesFromFrames(recorder.frames, playback.frameIndex);
    } else {
      renderer.clearTraces();
    }
  }

  async _runGraphExports(entries, baseName) {
    const { recorder, setStatus } = this.deps;
    const frames = recorder.frames;
    const downloads = [];
    let index = 0;
    for (const entry of entries) {
      index += 1;
      setStatus(`Exporting: <strong>Graph ${index}/${entries.length}</strong>`);
      entry.graphWindow.refresh();
      const { blob, filename: outputName } = await entry.graphWindow.exportVideo({
        frames,
        width: entry.width,
        height: entry.height,
        fps: entry.fps,
        animMode: entry.animationMode,
        onProgress: (done, total) => {
          setStatus(
            `Exporting: <strong>Graph ${index}/${entries.length} · ${done}/${total}</strong>`,
          );
        },
      });
      downloads.push({
        blob,
        filename: `${entry.graphWindow.exportFilename(baseName)}.${blobExtension(outputName, blob)}`,
      });
    }
    return downloads;
  }

  async _runBatch(options) {
    if (this._busy) return;
    const {
      engine, recorder, playback, renderer, cameraRig, camera, svg,
      labels, measurements, enterReview, applyCameraRig, getStatus, setStatus,
    } = this.deps;

    this._busy = true;
    this.syncButtons();
    if (this.elements.run) this.elements.run.disabled = true;

    const previousStatus = getStatus();
    const savedFrameIndex = playback.frameIndex;
    playback.stop();

    /** @type {Array<{ blob: Blob, filename: string }>} */
    const downloads = [];

    try {
      if (options.includeSim) {
        playback.jumpToStart();
        enterReview();
        this._syncViewToggles();
        cameraRig.applyToCamera(camera, options.width, options.height);
        setStatus('Exporting: <strong>Simulation…</strong>');
        const { blob, filename: outputName } = await this._withUiHidden(
          () => exportRecordingVideo(recorder.frames, {
            svg,
            width: options.width,
            height: options.height,
            fps: options.fps,
            onProgress: (done, total) => {
              setStatus(`Exporting: <strong>Simulation ${done}/${total}</strong>`);
            },
            renderFrame: async (index) => {
              playback.seek(index);
              if (cameraRig.followBodyId) cameraRig.updateFollow(engine);
              cameraRig.applyToCamera(camera, options.width, options.height);
              renderer.render();
              labels.sync();
              measurements.sync();
              await new Promise(resolve => requestAnimationFrame(resolve));
            },
          }),
        );
        downloads.push({
          blob,
          filename: `${options.baseName}-simulation.${blobExtension(outputName, blob)}`,
        });
      }

      if (options.includeGraphs && options.graphs.length) {
        downloads.push(...await this._runGraphExports(options.graphs, options.baseName));
      }

      if (downloads.length) {
        const plural = downloads.length === 1 ? '' : 's';
        setStatus(`Downloading: <strong>${downloads.length} file${plural}…</strong>`);
        await downloadVideosSequentially(downloads);
      }
    } finally {
      playback.seek(savedFrameIndex);
      renderer.render();
      measurements.sync();
      applyCameraRig();
      setStatus(previousStatus);
      this._busy = false;
      if (this.elements.run) this.elements.run.disabled = false;
      this.syncButtons();
    }
  }
}
