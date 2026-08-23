import './units.js'; // patch Matter _baseDelta / Engine._deltaMax before other imports use the engine
import { PhysicsEngine }    from './physics/engine.js';
import { SvgRenderer }      from './renderer/svg-renderer.js';
import { Recorder }         from './recorder/recorder.js';
import { Playback }         from './recorder/playback.js';
import { ExportControls }   from './exporter/export-controls.js';
import { EnvironmentPanel } from './ui/environment-panel.js';
import { SceneSession }     from './scene/scene-session.js';
import { showToolbarToast } from './ui/toast.js';
import { PropertiesPanel }  from './ui/properties.js';
import { ObjectBrowser }    from './ui/object-browser.js';
import { GraphHost }        from './ui/graph-panel.js';
import { InteractionHandler } from './ui/interaction.js';
import { MeasurementManager } from './ui/measurements.js';
import { LabelManager } from './ui/labels.js';
import {
  buildBlankScene,
  deserializeScene,
  cloneSceneDocument,
  validateSceneDocument,
  captureSelectionClipboard,
  pasteClipboard,
  PASTE_OFFSET_M,
} from './scene/index.js';
import { removeRope, ropeSelection } from './physics/rope.js';
import { Camera, DEFAULT_CAMERA_SCALE } from './camera/camera.js';
import { CameraRig }        from './camera/camera-rig.js';
import { CameraOverlay }    from './ui/camera-overlay.js';
import { HistoryManager, captureSnapshot, applySnapshot } from './history.js';
import { createPointMass, createBall, createBox, createWedge } from './physics/bodies.js';
import { snapWorldCoord } from './grid.js';
import { setMetricOriginEngine, getMetricOriginWorldPx } from './world-origin.js';
import { paramsForScene } from './experiment/params.js';
import { createEditorContext } from './ui/handles/editor-context.js';
import { ScaleHandles } from './ui/handles/scale-handles.js';
import { VectorHandle } from './ui/handles/vector-handle.js';
import { EditHandles } from './ui/handles/edit-handles.js';


// ── DOM refs ──────────────────────────────────────────────────────

// Environment panel
const btnPresetMenu = document.getElementById('btn-preset-menu');
const presetMenu    = document.getElementById('preset-menu');
const presetMenuWrap = document.getElementById('preset-menu-wrap');
const btnSceneLoad  = document.getElementById('btn-scene-load');
const btnSceneSave  = document.getElementById('btn-scene-save');
const btnSceneNew   = document.getElementById('btn-scene-new');
const btnSceneReset = document.getElementById('btn-scene-reset');
const btnSceneClear = document.getElementById('btn-scene-clear');
const btnSettings   = document.getElementById('btn-settings');
const settingsBackdrop = document.getElementById('settings-backdrop');
const btnSettingsClose = document.getElementById('btn-settings-close');

// Toolbar
const btnPlayPause  = document.getElementById('btn-play-pause');
const speedSlider   = document.getElementById('speed-slider');
const speedLabel    = document.getElementById('speed-label');
const btnGrid       = document.getElementById('btn-grid');
const btnSnap       = document.getElementById('btn-snap');
const btnOrigin     = document.getElementById('btn-origin');
const btnVectors    = document.getElementById('btn-vectors');
const btnTraces     = document.getElementById('btn-traces');
const btnAddGraph   = document.getElementById('btn-add-graph');
const iconPlay      = document.getElementById('icon-play');
const iconPause     = document.getElementById('icon-pause');
const canvasContainer = document.getElementById('canvas-container');

// Timeline
const tlBadge       = document.getElementById('tl-mode-badge');
const tlJumpStart   = document.getElementById('tl-jump-start');
const tlRevFast     = document.getElementById('tl-rev-fast');
const tlRevStep     = document.getElementById('tl-rev-step');
const tlPlayReview  = document.getElementById('tl-play-review');
const tlFwdStep     = document.getElementById('tl-fwd-step');
const tlFwdFast     = document.getElementById('tl-fwd-fast');
const tlJumpEnd       = document.getElementById('tl-jump-end');
const tlClearFrames   = document.getElementById('tl-clear-frames');
const tlScrubber    = document.getElementById('tl-scrubber');
const tlFill        = document.getElementById('tl-fill');
const tlFrameCount  = document.getElementById('tl-frame-count');
const tlTimeDisplay = document.getElementById('tl-time-display');
const tlIconPlay    = document.getElementById('tl-icon-play');
const tlIconPause   = document.getElementById('tl-icon-pause');
const tlIconRev     = document.getElementById('tl-icon-rev');

// Canvas / status
const svg           = document.getElementById('sandbox-svg');
const cameraOverlaySvg = document.getElementById('camera-overlay');
const simTimeEl     = document.getElementById('sim-time');
const statusMode    = document.getElementById('status-mode');
const statusBodies  = document.getElementById('status-bodies');
const statusConstr  = document.getElementById('status-constraints');
const statusRec     = document.getElementById('status-record');
const recFramesEl   = document.getElementById('rec-frames');
const propsContent  = document.getElementById('properties-content');
const propsWrap     = document.getElementById('properties-wrap');
const btnPropsToggle = document.getElementById('btn-props-toggle');
const obContent     = document.getElementById('object-browser-content');
const obWrap        = document.getElementById('object-browser-wrap');
const btnObToggle   = document.getElementById('btn-ob-toggle');

let _propsPinnedCollapsed = false;
let _obPinnedCollapsed = false;

// ── Core objects ─────────────────────────────────────────────────
const engine   = new PhysicsEngine();
setMetricOriginEngine(engine);
/** Gravity / air-drag / arrow-scale settings panel. */
const environmentPanel = new EnvironmentPanel(engine);
const renderer = new SvgRenderer(svg, engine);
const camera   = new Camera();
const cameraRig = new CameraRig();
camera.attach(renderer.worldGroup);
const cameraOverlay = new CameraOverlay(cameraOverlaySvg, camera, cameraRig, {
  getToolMode: () => interaction.mode,
  getViewSize: () => _viewSize(),
  onFrameChanged: () => props.showCamera(cameraRig, _onCameraRigChanged),
});

function _applyCameraRig({ fitView = true } = {}) {
  const { width, height } = _viewSize();
  if (fitView && interaction.mode !== 'camera') {
    cameraRig.applyToCamera(camera, width, height);
  }
  cameraOverlay.sync();
}

const recorder = new Recorder();
const playback = new Playback(recorder, engine);

/** Floating observable graphs over the canvas. */
const graphHost = new GraphHost({
  container: canvasContainer,
  getFrames: () => recorder.frames,
  listBodies: () => {
    /** @type {{ id: number, trackId: number, label: string, type: string }[]} */
    const out = [];
    for (const b of engine.bodies) {
      if (b._newtonType === 'metric-basis') continue;
      if (b._ropeSegment) continue;
      if (b._newtonType === 'compound' && b._weldParts?.length) {
        out.push({
          id: b.id,
          trackId: b.id,
          label: `${b.label || 'Group'} (COM)`,
          type: 'compound',
          sceneId: typeof b.label === 'string' ? b.label : null,
        });
        b._weldParts.forEach((p, i) => {
          if (p.sourceId == null) return;
          out.push({
            id: b.id,
            trackId: p.sourceId,
            label: `${p.label || `Part ${i + 1}`} · in group`,
            type: p.type ?? 'part',
            sceneId: typeof p.label === 'string' ? p.label : null,
          });
        });
      } else {
        out.push({
          id: b.id,
          trackId: b.id,
          label: b.label || b._newtonType || `body ${b.id}`,
          type: b._newtonType ?? 'generic',
          sceneId: typeof b.label === 'string' ? b.label : null,
        });
      }
    }
    return out;
  },
  listMeasurements: () => measurements.toScene(),
  getScrubIndex: () => {
    if (recorder.frameCount === 0) return 0;
    return parseInt(tlScrubber.value, 10) || 0;
  },
  onSeek: (frameIndex) => {
    _enterReview();
    playback.stop();
    playback.seek(frameIndex);
    _updateReviewPlayIcon();
  },
  getSelectedBodyId: () => (
    _currentSelection?.type === 'body' ? _currentSelection.id : null
  ),
  getSelectedTrackId: () => {
    if (_currentSelection?.type !== 'body') return null;
    const body = engine.bodies.find(b => b.id === _currentSelection.id);
    if (!body) return _currentSelection.id;
    const partIndex = _currentSelection.partIndex;
    if (body._newtonType === 'compound' && partIndex != null) {
      const sid = body._weldParts?.[partIndex]?.sourceId;
      if (sid != null) return sid;
    }
    return body.id;
  },
  getBaselineScene: () => sceneSession.baselineWithLiveMeasurements(),
  getSceneName: () => sceneSession.name,
  getEngine: () => engine,
  onSweepPoint: ({ x, paramId, paramLabel, baseline }) => {
    if (!baseline || !paramId || !Number.isFinite(x)) return false;
    const doc = cloneSceneDocument(baseline);
    const param = paramsForScene(doc).find(p => p.id === paramId);
    if (!param) {
      alert('Could not restore that sweep parameter on this scene.');
      return false;
    }
    param.apply(doc, x);
    const label = paramLabel || param.label || paramId;
    const xStr = Number.isFinite(x) ? (Math.abs(x) >= 1e3 || Math.abs(x) < 1e-3 ? x.toExponential(3) : String(Number(x.toPrecision(5)))) : String(x);
    _loadSceneDocument(doc, {
      type: 'file',
      name: `Sweep · ${label} = ${xStr}`,
    });
    return true;
  },
});

let _graphSyncCooldown = 0;
function _syncGraphs(force = false) {
  if (!graphHost.count) return;
  if (!force) {
    const now = performance.now();
    if (now - _graphSyncCooldown < 80) return;
    _graphSyncCooldown = now;
  }
  graphHost.sync();
}

btnAddGraph?.addEventListener('click', () => {
  const seed = {};
  if (_currentSelection?.type === 'body') {
    seed.bodyId = _currentSelection.id;
    seed.trackId = graphHost._opts.getSelectedTrackId?.() ?? _currentSelection.id;
  }
  // Prefer vertical position for textbook-style plots (e.g. rock air-drag).
  seed.observable = 'y';
  graphHost.addGraph(seed);
  exportControls.syncButtons();
});

/** Toolbar export buttons + the video-export dialog. */
const exportControls = new ExportControls({
  engine, recorder, playback, renderer, graphHost, cameraRig, camera, svg,
  get labels() { return labels; },
  get measurements() { return measurements; },
  enterReview:    () => _enterReview(),
  closeMenu:      () => _closePresetMenu(),
  applyCameraRig: () => _applyCameraRig(),
  getViewSize:    () => _viewSize(),
  getViewToggles: () => ({
    grid:    btnGrid.classList.contains('active'),
    vectors: btnVectors.classList.contains('active'),
    traces:  btnTraces.classList.contains('active'),
  }),
  getStatus: () => statusMode.innerHTML,
  setStatus: (html) => { statusMode.innerHTML = html; },
});

// ── Undo / redo history ───────────────────────────────────────────
const history = new HistoryManager();

let _snapEnabled = true;

let _currentSelection = null;

// Scene text labels, symbols attached to bodies or fixed in space.
const labels = new LabelManager({
  layer: renderer.labelLayer,
  leaderLayer: renderer.leaderLayer,
  engine,
  getMetricOriginWorldPx,
  getSnapEnabled: () => _snapEnabled,
  onBeforeChange: () => _pushHistory(),
  onSelect: (sel) => {
    if (sel?.type === 'label') {
      measurements.select(null);
      _currentSelection = sel;
      renderer.select([]);
      props?.show(sel);
      objectBrowser?.setSelection(sel);
      objectBrowser?.scheduleRefresh();
      _syncPropsPanel();
    }
  },
});

// Scene measurement overlays are created early so renderLoop / selection can use them.
const measurements = new MeasurementManager({
  layer: renderer.measureLayer,
  leaderLayer: renderer.leaderLayer,
  engine,
  getSnapEnabled: () => _snapEnabled,
  onBeforeChange: () => _pushHistory(),
  labelHooks: labels,
  onSelect: (sel) => {
    if (sel?.type !== 'measurement') return;
    labels.select(null);
    _currentSelection = sel;
    renderer.select([]);
    props?.show(sel);
    objectBrowser?.setSelection(sel);
    _syncPropsPanel();
  },
});

/** Current scene identity: Reset baseline, source, and the file operations. */
const sceneSession = new SceneSession({
  engine, camera, cameraRig, measurements, labels, environmentPanel,
  resetButton: btnSceneReset,
  getToolMode: () => interaction.mode,
  getViewSize: () => _viewSize(),
  loadDocument: (doc, source, opts) => _loadSceneDocument(doc, source, opts),
});

// Push a snapshot onto the undo stack, used only during setup phase.
function _pushHistory() {
  if (appMode === 'setup') {
    history.push(captureSnapshot(engine, {
      measurements: measurements.toScene(),
      labels: labels.toScene(),
    }));
  }
}

/*
 * Wrap an engine mutating method so it automatically records an undo snapshot
 * (in setup mode) before every structural change.
*/
function _wrapEngineMethod(name) {
  const orig = engine[name].bind(engine);
  engine[name] = (...args) => {
    _pushHistory();
    orig(...args);
  };
}
_wrapEngineMethod('addBody');
_wrapEngineMethod('removeBody');
_wrapEngineMethod('addConstraint');
_wrapEngineMethod('removeConstraint');



function _isPropsCollapsed() {
  return !_currentSelection || _propsPinnedCollapsed;
}

function _syncPropsPanel() {
  const collapsed = _isPropsCollapsed();
  propsWrap?.classList.toggle('collapsed', collapsed);
  btnPropsToggle?.setAttribute('aria-expanded', String(!collapsed));
  if (btnPropsToggle) {
    btnPropsToggle.title = collapsed ? 'Expand properties' : 'Collapse properties';
  }
}

function _syncObjectBrowserPanel() {
  const collapsed = _obPinnedCollapsed;
  obWrap?.classList.toggle('collapsed', collapsed);
  btnObToggle?.setAttribute('aria-expanded', String(!collapsed));
  if (btnObToggle) {
    btnObToggle.title = collapsed ? 'Expand object browser' : 'Collapse object browser';
  }
}

function _onSandboxSelect(selection) {
  if (interaction.mode === 'camera') return;
  if (selection?.type === 'measurement') {
    labels.select(null);
    measurements.select(selection.id);
    _currentSelection = selection;
    renderer.select([]);
    props.show(selection);
    objectBrowser?.setSelection(selection);
    _syncPropsPanel();
    return;
  }
  if (selection?.type === 'label') {
    measurements.select(null);
    labels.select(selection.id);
    _currentSelection = selection;
    renderer.select([]);
    props.show(selection);
    objectBrowser?.setSelection(selection);
    _syncPropsPanel();
    return;
  }
  if (selection?.type === 'body') {
    const body = engine.bodies.find(b => b.id === selection.id);
    if (body?._ropeSegment && body._ropeId) {
      selection = ropeSelection(engine, body._ropeId) ?? selection;
    }
  }
  measurements.select(null);
  labels.select(null);
  if (selection?.type === 'body' && selection.id !== _currentSelection?.id) {
    vectorHandle.resetQuantity();
  }
  _currentSelection = selection;
  if (selection?.type === 'aggregate' && Array.isArray(selection.memberIds)) {
    renderer.select(selection.memberIds, { partIndex: null });
  } else if (selection?.type === 'rope' && Array.isArray(selection.memberIds)) {
    renderer.select(selection.memberIds, { partIndex: null, ropeId: selection.ropeId });
  } else {
    renderer.select(selection ? [selection.id] : [], {
      partIndex: selection?.type === 'body' ? (selection.partIndex ?? null) : null,
    });
  }
  props.show(selection);
  objectBrowser?.setSelection(selection);
  if (!selection) {
    vectorHandle.reset();
    editHandles.reset();
    scaleHandles.reset();
  }
  _syncPropsPanel();
}

const props = new PropertiesPanel(propsContent, engine, _pushHistory, (idOrSel, partIndex = null) => {
  if (idOrSel == null) {
    _onSandboxSelect(null);
    return;
  }
  if (typeof idOrSel === 'object') {
    _onSandboxSelect(idOrSel);
    if (idOrSel.type === 'rope') objectBrowser?.scheduleRefresh();
    return;
  }
  _currentSelection = { type: 'body', id: idOrSel, partIndex };
  renderer.select([idOrSel], { partIndex });
  objectBrowser?.setSelection(_currentSelection);
  _syncPropsPanel();
}, () => _snapEnabled, {
  getManager: () => measurements,
  getLabelManager: () => labels,
  onChanged: () => objectBrowser?.scheduleRefresh(),
});

const objectBrowser = new ObjectBrowser(obContent, engine, {
  onSelect: (sel) => _onSandboxSelect(sel),
  beforeChange: () => _pushHistory(),
  listMeasurements: () => measurements.toScene(),
  listLabels: () => labels.toScene(),
  onRenameBody: (id, name) => {
    const body = engine.bodies.find(b => b.id === id);
    if (body) body.label = name;
  },
  onRenameConstraint: (id, name) => {
    const c = engine.constraints.find(x => x.id === id);
    if (c) c.label = name;
  },
  onAggregateChange: () => objectBrowser.scheduleRefresh(),
});
objectBrowser.refresh();
_syncObjectBrowserPanel();

/** Keep selection and graphs following sticky groups after a weld. */
engine.onWeld((compound, removedIds) => {
  graphHost.followWeld(compound, removedIds);
  objectBrowser.scheduleRefresh();
  if (_currentSelection?.type === 'aggregate') {
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return;
  }
  if (_currentSelection?.type !== 'body') return;
  if (!removedIds.includes(_currentSelection.id)) return;
  // Prefer the welded component that matches the old body id (simple-body → part).
  const partIndex = compound._weldParts?.findIndex(p => p.sourceId === _currentSelection.id) ?? -1;
  _onSandboxSelect({
    type: 'body',
    id: compound.id,
    partIndex: partIndex >= 0 ? partIndex : null,
  });
});

btnPropsToggle?.addEventListener('click', () => {
  if (_isPropsCollapsed()) {
    _propsPinnedCollapsed = false;
  } else {
    _propsPinnedCollapsed = true;
  }
  _syncPropsPanel();
});

btnObToggle?.addEventListener('click', () => {
  _obPinnedCollapsed = !_obPinnedCollapsed;
  _syncObjectBrowserPanel();
});

renderer.onSelect(_onSandboxSelect);

// ── App mode ──────────────────────────────────────────────────────
// 'setup'  : no recording, physics paused. Set initial conditions here.
// 'live'   : physics running, recording active (if toggled).
// 'review' : physics frozen, scrubbing through recorded frames.
let appMode   = 'setup';

function setMode(mode) {
  appMode = mode;

  const badge = tlBadge;
  badge.className = 'tl-badge';
  if (mode === 'setup') {
    badge.classList.add('tl-setup');
    badge.textContent = 'SETUP';
  } else if (mode === 'live') {
    badge.classList.add('tl-live');
    badge.textContent = '● LIVE';
  } else {
    badge.classList.add('tl-review');
    badge.textContent = 'REVIEW';
  }

  // Timeline controls: enabled only when there is recorded data
  const hasFrames = recorder.frameCount > 0;
  tlJumpStart.disabled   = !hasFrames;
  tlRevFast.disabled     = !hasFrames;
  tlRevStep.disabled     = !hasFrames;
  tlFwdStep.disabled     = !hasFrames;
  tlFwdFast.disabled     = !hasFrames;
  tlJumpEnd.disabled     = !hasFrames;
  tlScrubber.disabled    = !hasFrames;
  tlClearFrames.disabled = !hasFrames;

  // Scrubber range
  if (hasFrames) {
    tlScrubber.max = recorder.frameCount - 1;
  }

  // Play-review button icon
  _updateReviewPlayIcon();

  // Main transport button (play / pause + capture)
  _updateMainTransportButton();
}

// ── Continuous render loop ────────────────────────────────────────
let _obLastBodyN = -1;
let _obLastConN = -1;
let _obLastMeasN = -1;
function renderLoop() {
  if (interaction.mode === 'camera') {
    if (cameraRig.followBodyId && (engine.running || appMode === 'review')) {
      cameraRig.updateFollow(engine);
    }
    cameraOverlay.syncSize();
    cameraOverlay.sync();
  } else if (cameraRig.followBodyId && (engine.running || appMode === 'review')) {
    cameraRig.updateFollow(engine);
    _applyCameraRig();
  }
  renderer.render();
  labels.sync();
  measurements.sync();
  vectorHandle.sync();
  editHandles.sync();
  scaleHandles.sync();
  statusBodies.textContent = `Bodies: ${engine.bodies.length}`;
  statusConstr.textContent = `Constraints: ${engine.constraints.length}`;
  props.refresh();
  const bn = engine.bodies.length;
  const cn = engine.constraints.length;
  const mn = measurements.items.length;
  if (bn !== _obLastBodyN || cn !== _obLastConN || mn !== _obLastMeasN) {
    _obLastBodyN = bn;
    _obLastConN = cn;
    _obLastMeasN = mn;
    objectBrowser.scheduleRefresh();
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ── Physics step callback (recording + time display) ──────────────
engine.onStep(simTime => {
  simTimeEl.textContent = `t = ${simTime.toFixed(3)} s`;
  if (recorder.isRecording) {
    recorder.capture(simTime, engine.bodies, engine.constraints);
    // Trail length only advances with recorded frames (not every RAF tick).
    if (btnTraces.classList.contains('active')) {
      renderer.sampleTraces(engine.bodies);
    }
    recFramesEl.textContent = recorder.frameCount;
    tlClearFrames.disabled = false;
    // Keep scrubber range and fill updated as frames accumulate
    _updateScrubberFromLive();
    _syncGraphs();
  }
});

/** Rebuild trajectory trails from footage up to the given review frame. */
function _syncReviewTraces(frameIdx = playback.frameIndex) {
  if (!btnTraces.classList.contains('active')) return;
  renderer.setTracesFromFrames(recorder.frames, frameIdx);
}

// ── Playback seeks ────────────────────────────────────────────────
playback.onChange((frameIdx, event) => {
  _updateScrubberThumb(frameIdx);
  const frame = recorder.frames[frameIdx];
  if (frame) {
    tlTimeDisplay.textContent = `${frame.t.toFixed(3)} s`;
    simTimeEl.textContent     = `t = ${frame.t.toFixed(3)} s`;
  }
  if (event === 'end' || event === 'start') {
    _updateReviewPlayIcon();
  }
  _syncReviewTraces(frameIdx);
  _syncGraphs(true);
});

// ── Toolbar: single Run / Capture control ──────────────────────────
btnPlayPause.addEventListener('click', () => _toggleCaptureSession());

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.target.isContentEditable) return;
  if (e.code === 'Digit0' || e.code === 'Numpad0') {
    e.preventDefault();
    // Prefer graph home when the pointer is over a plot.
    if (graphHost.resetHoveredView()) return;
    const scale = sceneSession.baselineCameraScale ?? DEFAULT_CAMERA_SCALE;
    _frameMetricBasis(scale);
    if (interaction.mode === 'camera') cameraOverlay.sync();
    return;
  }
  // Undo: Ctrl+Z
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    _doUndo();
    return;
  }
  // Redo: Ctrl+Y  or  Ctrl+Shift+Z
  if ((e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) ||
      (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
    e.preventDefault();
    _doRedo();
    return;
  }
  // Copy / paste selected objects (setup mode)
  if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    if (_copySelection()) e.preventDefault();
    return;
  }
  if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    if (_pasteSelection()) e.preventDefault();
    return;
  }
  // Save checkpoint for Reset (Ctrl/Cmd+S)
  if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    sceneSession.saveCheckpoint();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    if (appMode === 'review') {
      _toggleReviewPlay();
    } else {
      _toggleCaptureSession();
    }
  }
  if (e.code === 'ArrowRight' && appMode === 'review') {
    e.preventDefault(); playback.stepForward(); _updateReviewPlayIcon();
  }
  if (e.code === 'ArrowLeft' && appMode === 'review') {
    e.preventDefault(); playback.stepBack(); _updateReviewPlayIcon();
  }
  if (e.code === 'KeyI') {
    e.preventDefault(); _reviewJumpStart();
  }
  if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (appMode === 'review') _toggleReviewPlay();
    else _activateTool('rotate', 'Rotate');
  }
  if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    _activateTool('select', 'Select / Move');
  }
  if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    _activateTool('scale', 'Scale');
  }
  if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    _activateTool('camera', 'Camera');
  }
});

// ── Undo / redo operations ────────────────────────────────────────

/** @type {{ bodies: object[], constraints: object[], uiAggregates?: object[] }|null} */
let _objectClipboard = null;
/** Paste-stack offset multiplier (resets on new copy). */
let _pasteGeneration = 0;

function _copySelection() {
  if (appMode !== 'setup') return false;
  if (interaction.mode === 'camera') return false;
  const frag = captureSelectionClipboard(engine, _currentSelection);
  if (!frag) return false;
  _objectClipboard = frag;
  _pasteGeneration = 0;
  return true;
}

function _pasteSelection() {
  if (appMode !== 'setup') return false;
  if (interaction.mode === 'camera') return false;
  if (!_objectClipboard?.bodies?.length) return false;

  _pasteGeneration += 1;
  const n = _pasteGeneration;
  _pushHistory();
  const result = pasteClipboard(engine, _objectClipboard, {
    dxM: PASTE_OFFSET_M * n,
    dyM: PASTE_OFFSET_M * n,
  });
  if (!result) return false;

  const bodies = Object.values(result.bodyMap);
  objectBrowser?.scheduleRefresh();

  const ropeBodies = bodies.filter(b => b._ropeSegment && b._ropeId);
  if (ropeBodies.length && ropeBodies.every(b => b._ropeId === ropeBodies[0]._ropeId)) {
    const sel = ropeSelection(engine, ropeBodies[0]._ropeId);
    if (sel) {
      _onSandboxSelect(sel);
      return true;
    }
  }

  const pastedIds = new Set(bodies.map(b => b.id));
  const aggs = (engine._uiAggregates ?? []).filter(a =>
    Array.isArray(a.memberIds)
    && a.memberIds.length >= 2
    && a.memberIds.every(id => pastedIds.has(id)),
  );
  if (aggs.length) {
    const a = aggs[aggs.length - 1];
    _onSandboxSelect({
      type: 'aggregate',
      aggId: a.id,
      id: a.id,
      key: `agg:${a.id}`,
      memberIds: [...a.memberIds],
    });
    return true;
  }

  if (bodies.length === 1) {
    _onSandboxSelect({ type: 'body', id: bodies[0].id });
    return true;
  }
  if (bodies.length > 1) {
    _onSandboxSelect({
      type: 'aggregate',
      memberIds: bodies.map(b => b.id),
      key: `paste:${bodies[0].id}`,
    });
    return true;
  }
  return true;
}

function _doUndo() {
  if (appMode !== 'setup') return;
  const snapshot = history.undo(captureSnapshot(engine, {
    measurements: measurements.toScene(),
    labels: labels.toScene(),
  }));
  if (!snapshot) return;
  _applyHistorySnapshot(snapshot);
}

function _doRedo() {
  if (appMode !== 'setup') return;
  const snapshot = history.redo(captureSnapshot(engine, {
    measurements: measurements.toScene(),
    labels: labels.toScene(),
  }));
  if (!snapshot) return;
  _applyHistorySnapshot(snapshot);
}

function _applyHistorySnapshot(snapshot) {
  // Remember which body was selected (by label) so we can restore it after.
  const selBody  = _currentSelection?.type === 'body'
    ? engine.bodies.find(b => b.id === _currentSelection.id)
    : null;
  const selLabel = selBody?.label ?? null;
  const selMeasure = _currentSelection?.type === 'measurement' ? _currentSelection.id : null;
  const selLabelId = _currentSelection?.type === 'label' ? _currentSelection.id : null;

  // Drop in-progress overlay drags so they cannot keep mutating after restore.
  measurements.cancelEdit?.();
  labels.cancelEdit?.();

  // Rebuild world without recording history for the intermediate addBody calls.
  history.frozen = true;
  applySnapshot(snapshot, engine);
  history.frozen = false;

  measurements.loadFromScene(snapshot);
  labels.loadFromScene(snapshot);

  // Clean up any stale velocity-handle DOM element.
  vectorHandle.reset();
  editHandles.reset();
  scaleHandles.reset();

  // Restore selection by label (body IDs change after recreation).
  _currentSelection = null;
  renderer.select([]);
  measurements.select(null);
  labels.select(null);
  if (selMeasure && measurements.items.some(m => m.id === selMeasure)) {
    measurements.select(selMeasure);
    objectBrowser?.setSelection({ type: 'measurement', id: selMeasure });
    props.show({ type: 'measurement', id: selMeasure });
    objectBrowser?.scheduleRefresh();
    _syncPropsPanel();
    return;
  }
  if (selLabelId && labels.getById(selLabelId)) {
    labels.select(selLabelId);
    objectBrowser?.setSelection({ type: 'label', id: selLabelId });
    props.show({ type: 'label', id: selLabelId });
    objectBrowser?.scheduleRefresh();
    _syncPropsPanel();
    return;
  }
  if (selLabel) {
    const restored = engine.bodies.find(b => b.label === selLabel);
    if (restored) {
      _currentSelection = { type: 'body', id: restored.id };
      renderer.select([restored.id]);
      props.show(_currentSelection);
      objectBrowser?.setSelection(_currentSelection);
      objectBrowser?.scheduleRefresh();
      _syncPropsPanel();
      return;
    }
  }
  props.show(null);
  objectBrowser?.setSelection(null);
  objectBrowser?.scheduleRefresh();
  _syncPropsPanel();
}

function _toggleCaptureSession() {
  const capturing = recorder.isRecording && engine.running;

  if (capturing) {
    engine.pause();
    recorder.stop();
    statusRec.classList.add('hidden');
    exportControls.syncButtons();
    setMode('setup');
  } else {
    if (appMode === 'review') playback.stop();
    recorder.start();          // resumes / continues: does NOT clear frames
    if (recorder.frameCount === 0) {
      recorder.capture(engine.simTime, engine.bodies, engine.constraints);
      recFramesEl.textContent = recorder.frameCount;
      if (btnTraces.classList.contains('active')) {
        renderer.sampleTraces(engine.bodies);
      }
    }
    statusRec.classList.remove('hidden');
    exportControls.syncButtons(true);
    if (!engine.running) engine.play();
    setMode('live');
  }
  _updateMainTransportButton();
}

function _updateMainTransportButton() {
  const capturing = recorder.isRecording && engine.running;
  iconPlay.style.display  = capturing ? 'none' : '';
  iconPause.style.display = capturing ? ''     : 'none';
  btnPlayPause.classList.toggle('recording', capturing);
  btnPlayPause.title = capturing
    ? 'Stop (Space)'
    : 'Play (Space)';
}

// ── Timeline: review play/pause ───────────────────────────────────
tlPlayReview.addEventListener('click', () => _toggleReviewPlay());

function _toggleReviewPlay() {
  if (recorder.frameCount === 0) return;

  if (appMode !== 'review') {
    if (recorder.isRecording) {
      recorder.stop();
      statusRec.classList.add('hidden');
      exportControls.syncButtons();
    }
    if (engine.running) engine.pause();
    _updateMainTransportButton();
    setMode('review');
  }

  if (playback.isPlaying) {
    playback.stop();
  } else {
    const dir = playback.atEnd ? -1 : 1; // reverse from end, forward otherwise
    playback.play(dir, 1);
  }
  _updateReviewPlayIcon();
}

function _updateReviewPlayIcon() {
  const playing = playback.isPlaying;
  const rev     = playing && playback._playDir === -1;
  tlIconPlay.style.display  = (!playing)      ? '' : 'none';
  tlIconPause.style.display = (playing && !rev) ? '' : 'none';
  tlIconRev.style.display   = rev              ? '' : 'none';
  tlPlayReview.classList.toggle('active', playing);
}

// ── Timeline: clear all frames ────────────────────────────────────
tlClearFrames.addEventListener('click', () => {
  if (recorder.isRecording) {
    recorder.stop();
    statusRec.classList.add('hidden');
  }
  if (appMode === 'review') {
    playback.stop();
    if (engine.running) engine.pause();
    _updateMainTransportButton();
  }
  recorder.clear();
  renderer.clearTraces();
  tlScrubber.value = 0; tlScrubber.max = 0;
  _updateFill(0);
  tlFrameCount.textContent  = '0 fr';
  tlTimeDisplay.textContent = '0.000 s';
  exportControls.syncButtons(true);
  setMode('setup');
  _syncGraphs(true);
});

// ── Timeline: jump / step / fast ─────────────────────────────────
tlJumpStart.addEventListener('click',  _reviewJumpStart);
tlJumpEnd.addEventListener('click',    () => { _enterReview(); playback.jumpToEnd();   _updateReviewPlayIcon(); });
tlRevStep.addEventListener('click',    () => { _enterReview(); playback.stepBack();    _updateReviewPlayIcon(); });
tlFwdStep.addEventListener('click',    () => { _enterReview(); playback.stepForward(); _updateReviewPlayIcon(); });
tlRevFast.addEventListener('click',    () => {
  _enterReview();
  playback.play(-1, 2);
  _updateReviewPlayIcon();
});
tlFwdFast.addEventListener('click',    () => {
  _enterReview();
  playback.play(1, 2);
  _updateReviewPlayIcon();
});

function _reviewJumpStart() {
  _enterReview();
  playback.jumpToStart();
  _updateReviewPlayIcon();
}

function _enterReview() {
  if (appMode !== 'review') {
    if (recorder.isRecording) {
      recorder.stop();
      statusRec.classList.add('hidden');
      exportControls.syncButtons();
    }
    if (engine.running) engine.pause();
    _updateMainTransportButton();
    setMode('review');
  }
}

// ── Scrubber drag ─────────────────────────────────────────────────
tlScrubber.addEventListener('mousedown', () => {
  _enterReview();
  playback.stop();
  _updateReviewPlayIcon();
});
tlScrubber.addEventListener('input', () => {
  const idx = parseInt(tlScrubber.value, 10);
  playback.seek(idx);
  _updateFill(idx);
});

// ── Speed ─────────────────────────────────────────────────────────
speedSlider.addEventListener('input', () => {
  const v = parseFloat(speedSlider.value);
  engine.setSpeed(v);
  speedLabel.textContent = `${v.toFixed(1)}×`;
});

// ── View toggles ──────────────────────────────────────────────────
btnGrid.addEventListener('click', () => {
  renderer.setShowGrid(btnGrid.classList.toggle('active'));
});
btnSnap.addEventListener('click', () => {
  _snapEnabled = btnSnap.classList.toggle('active');
  interaction.setSnapEnabled(_snapEnabled);
});
btnOrigin?.addEventListener('click', () => {
  const on = btnOrigin.classList.toggle('active');
  btnOrigin.setAttribute('aria-pressed', String(on));
  renderer.setShowMetricOrigin(on);
  interaction.setMetricOriginSelectable(on);
  // Drop selection if the hidden origin was selected
  if (!on && _currentSelection?.type === 'body') {
    const b = engine.bodies.find(x => x.id === _currentSelection.id);
    if (b?._newtonType === 'metric-basis') _onSandboxSelect(null);
  }
});
btnVectors.addEventListener('click', () => {
  renderer.setShowVectors(btnVectors.classList.toggle('active'));
});
btnTraces.addEventListener('click', () => {
  const on = btnTraces.classList.toggle('active');
  renderer.setShowTraces(on);
  if (!on) {
    renderer.clearTraces();
    return;
  }
  // Show path from footage when reviewing, otherwise start empty and fill while recording.
  if (appMode === 'review' && recorder.frameCount > 0) {
    renderer.setTracesFromFrames(recorder.frames, playback.frameIndex);
  } else if (recorder.isRecording && recorder.frameCount > 0) {
    renderer.setTracesFromFrames(recorder.frames, recorder.frameCount - 1);
  } else {
    renderer.clearTraces();
  }
});

// ── Interaction / selection ───────────────────────────────────────
const interaction = new InteractionHandler(svg, engine, _onSandboxSelect, camera, renderer.interactionGhostLayer);

const editorContext = createEditorContext({
  engine, camera, svg, renderer,
  getSnapEnabled: () => _snapEnabled,
  getSelection:   () => _currentSelection,
  getAppMode:     () => appMode,
  getToolMode:    () => interaction.mode,
  getShowVectors: () => renderer.showVectors,
  pushHistory:    () => _pushHistory(),
  onSelect:       (sel) => _onSandboxSelect(sel),
  refreshBrowser: () => objectBrowser?.scheduleRefresh(),
  showProperties: (selection) => props.show(selection),
  applyVelocity:     (b, vx, vy, o) => props.applyVelocity(b, vx, vy, o),
  applyAppliedForce: (b, F, θ)      => props.applyAppliedForce(b, F, θ),
});

/** Scale tool handles (box sides / circle radius / wedge base+height). */
const scaleHandles = new ScaleHandles(editorContext);

/** Draggable v₀ / applied-F tip on the selected body. */
const vectorHandle = new VectorHandle(editorContext);

/** Constraint / rope / ground grab dots for whatever is selected. */
const editHandles = new EditHandles(editorContext);

window.addEventListener('resize', () => {
  cameraOverlay.syncSize();
  if (interaction.mode === 'camera') cameraOverlay.sync();
});
interaction.measurements = measurements;
interaction.labels = labels;

// Record undo snapshot before a body drag begins
interaction.onBeforeDrag = _pushHistory;
interaction.getSetupSelection = () => (appMode === 'setup' ? _currentSelection : null);
interaction.onTempPanPreview = (active) => {
  document.body.classList.toggle('shift-pan-preview', active);
  cameraOverlay.setPanReady(active);
};

document.addEventListener('keydown', e => {
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
  if (t.isContentEditable) return;

  if (e.code === 'Escape') {
    if (measurements.cancelDraft()) {
      e.preventDefault();
      return;
    }
    if (labels.cancelDraft()) {
      e.preventDefault();
      return;
    }
  }

  if (e.code !== 'Delete') return;
  if (interaction.mode === 'camera') return;
  if (measurements.deleteSelected()) {
    e.preventDefault();
    return;
  }
  if (labels.deleteSelected()) {
    e.preventDefault();
    _onSandboxSelect(null);
    objectBrowser?.scheduleRefresh();
    return;
  }
  if (appMode !== 'setup') return;
  if (!_currentSelection) return;

  if (_currentSelection.type === 'measurement') {
    measurements.deleteSelected();
    e.preventDefault();
    return;
  }

  if (_currentSelection.type === 'constraint') {
    const c = engine.constraints.find(x => x.id === _currentSelection.id);
    if (!c) {
      _onSandboxSelect(null);
      return;
    }
    e.preventDefault();
    engine.removeConstraint(c);
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return;
  }

  if (_currentSelection.type === 'aggregate') {
    const ids = [...(_currentSelection.memberIds ?? [])];
    e.preventDefault();
    for (const id of ids) {
      const body = engine.bodies.find(b => b.id === id);
      if (!body || body._newtonType === 'metric-basis') continue;
      engine.removeBody(body);
      interaction.notifyBodyRemoved(id);
    }
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return;
  }

  if (_currentSelection.type === 'rope') {
    const ropeId = _currentSelection.ropeId;
    if (!ropeId) return;
    e.preventDefault();
    const ids = engine.bodies.filter(b => b._ropeId === ropeId).map(b => b.id);
    removeRope(engine, ropeId);
    for (const id of ids) interaction.notifyBodyRemoved(id);
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return;
  }

  if (_currentSelection.type !== 'body') return;

  const body = engine.bodies.find(b => b.id === _currentSelection.id);
  if (!body) {
    _onSandboxSelect(null);
    return;
  }
  if (body._newtonType === 'metric-basis') return;
  e.preventDefault();
  if (body._ropeSegment && body._ropeId) {
    const ropeId = body._ropeId;
    const ids = engine.bodies.filter(b => b._ropeId === ropeId).map(b => b.id);
    removeRope(engine, ropeId);
    for (const id of ids) interaction.notifyBodyRemoved(id);
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return;
  }
  const removedId = body.id;
  engine.removeBody(body);
  interaction.notifyBodyRemoved(removedId);
  objectBrowser.scheduleRefresh();
  _onSandboxSelect(null);
});

svg.addEventListener('wheel', e => {
  e.preventDefault();
  if (interaction.mode === 'camera') return;
  if (interaction.handleWheel(e)) return;
  const rect = svg.getBoundingClientRect();
  camera.onWheel(e.clientX - rect.left, e.clientY - rect.top, e.deltaY);
}, { passive: false });


function _clearEntireScene() {
  const ok = window.confirm(
    'Clear the entire scene?\n\nAll bodies, constraints, measurements, and labels will be deleted. This cannot be undone.',
  );
  if (!ok) return;
  _loadBlankScene();
}

function _finishSceneLoad(source) {
  renderer.clearTraces();
  recorder.clear();
  vectorHandle.reset();
  editHandles.reset();
  renderer.render();
  playback.stop();
  tlScrubber.value = 0; tlScrubber.max = 0;
  _updateFill(0);
  tlFrameCount.textContent  = '0 fr';
  tlTimeDisplay.textContent = '0.000 s';
  simTimeEl.textContent     = 't = 0.000 s';
  exportControls.syncButtons(true);
  setMode('setup');
  _updateMainTransportButton();
  sceneSession.updateResetButton();
  _syncGraphs(true);
  graphHost.refreshSweepOptions();
}

function _clearSelectionAfterLoad() {
  _currentSelection = null;
  renderer.select([]);
  props.clear();
  objectBrowser.setSelection(null);
  objectBrowser.refresh();
  _syncPropsPanel();
}

/**
 * Load a validated scene document: single path for blank, import, demo, and reset.
 * @param {import('./scene/schema.js').SceneDocument} doc
 * @param {{ type: 'blank'|'file'|'demo'|'reset', name: string, demoId?: string }} source
 * @param {object} [opts]
 * @param {boolean} [opts.storeBaseline=true]
 */
function _loadSceneDocument(doc, source, opts = {}) {
  const storeBaseline = opts.storeBaseline !== false;

  const validated = validateSceneDocument(doc);
  if (!validated.ok) {
    alert(validated.error);
    return;
  }
  doc = validated.doc;

  history.clear();
  if (engine.running) engine.pause();
  recorder.stop();
  statusRec.classList.add('hidden');
  measurements.clearAll();
  labels.clearAll();

  history.frozen = true;
  const { environment, camera: camDoc } = deserializeScene(doc, engine);
  history.frozen = false;

  labels.loadFromScene(doc);
  measurements.loadFromScene(doc);

  if (environment) environmentPanel.applyScene(environment);

  // Camera framing from scene doc, or default metric-basis view.
  const bodyByLabel = new Map(
    engine.bodies.filter(b => typeof b.label === 'string').map(b => [b.label, b]),
  );
  if (camDoc?.center) {
    cameraRig.loadFromSceneDoc(camDoc, bodyByLabel);
    _whenViewReady(() => {
      cameraOverlay.syncSize();
      _applyCameraRig();
    });
  } else {
    const scale = (typeof camDoc?.s === 'number' && Number.isFinite(camDoc.s)) ? camDoc.s : DEFAULT_CAMERA_SCALE;
    _frameMetricBasisWhenReady(scale, 0, () => {
      const { width, height } = _viewSize();
      cameraRig.syncFromCamera(camera, width, height);
      cameraOverlay.syncSize();
    });
  }

  if (storeBaseline) sceneSession.adopt(doc, source);

  _finishSceneLoad(source);
  _clearSelectionAfterLoad();
}

function _loadBlankScene() {
  const doc = buildBlankScene();
  _loadSceneDocument(doc, { type: 'blank', name: doc.meta?.name ?? 'Untitled scene' });
}

function _closePresetMenu() {
  presetMenu?.classList.add('hidden');
  btnPresetMenu?.setAttribute('aria-expanded', 'false');
}

function _togglePresetMenu() {
  const opening = presetMenu?.classList.contains('hidden');
  if (opening) {
    presetMenu?.classList.remove('hidden');
    btnPresetMenu?.setAttribute('aria-expanded', 'true');
    _closeSettings();
  } else {
    _closePresetMenu();
  }
}

function _openSettings() {
  settingsBackdrop?.classList.remove('hidden');
  settingsBackdrop?.setAttribute('aria-hidden', 'false');
  _closePresetMenu();
}

function _closeSettings() {
  settingsBackdrop?.classList.add('hidden');
  settingsBackdrop?.setAttribute('aria-hidden', 'true');
}

btnPresetMenu?.addEventListener('click', e => {
  e.stopPropagation();
  _togglePresetMenu();
});

btnSceneNew?.addEventListener('click', () => {
  _closePresetMenu();
  _loadBlankScene();
});

btnSceneLoad?.addEventListener('click', () => {
  _closePresetMenu();
  sceneSession.importFromFile();
});

btnSceneSave?.addEventListener('click', () => {
  _closePresetMenu();
  sceneSession.exportToFile();
});

btnSceneReset?.addEventListener('click', () => {
  sceneSession.restoreBaseline();
});

btnSceneClear?.addEventListener('click', () => {
  _clearEntireScene();
});

btnSettings?.addEventListener('click', () => {
  if (settingsBackdrop?.classList.contains('hidden')) _openSettings();
  else _closeSettings();
});

btnSettingsClose?.addEventListener('click', _closeSettings);

settingsBackdrop?.addEventListener('click', e => {
  if (e.target === settingsBackdrop) _closeSettings();
});

document.addEventListener('click', e => {
  if (presetMenuWrap && !presetMenuWrap.contains(e.target)) _closePresetMenu();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    _closeSettings();
    _closePresetMenu();
  }
});

// ── Tool buttons (palette + object bar) ───────────────────────────
function _onCameraRigChanged() {
  _applyCameraRig({ fitView: interaction.mode !== 'camera' });
  if (interaction.mode === 'camera') props.showCamera(cameraRig, _onCameraRigChanged);
}

function _activateTool(tool, label) {
  // Deactivate all tool buttons across both bars
  document.querySelectorAll('.tool-btn, .obj-btn').forEach(b => b.classList.remove('active'));
  // Activate the matching button(s)
  document.querySelectorAll(`[data-tool="${tool}"]`).forEach(b => b.classList.add('active'));
  interaction.setMode(tool);
  statusMode.innerHTML = `Mode: <strong>${label}</strong>`;

  if (tool === 'camera') {
    _onSandboxSelect(null);
    // Keep the existing export frame: only user drags / property edits reframe it.
    cameraOverlay.syncSize();
    cameraOverlay.setActive(true);
    cameraOverlay.sync();
    props.showCamera(cameraRig, _onCameraRigChanged);
  } else {
    cameraOverlay.setActive(false);
  }
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool  = btn.dataset.tool;
    const label = btn.dataset.tip ?? tool;
    _activateTool(tool, label);
  });
});

// ── Palette drag-to-place ─────────────────────────────────────────
// Drag an obj-btn onto the canvas to create the object at the drop point.

let _paletteDrag = null;  // { type, ghostEl }

// Ground in the add bar activates drag-to-lay placement (palette-style), not palette drag-drop.
document.querySelectorAll('.obj-btn-ground').forEach(btn => {
  btn.addEventListener('click', () => _activateTool('ground', 'Ground'));
});

// Object / constraint tools: click to change mode (anchor = click-place, rod|spring = drag between bodies)
document.querySelectorAll('.obj-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    const label = (btn.getAttribute('title')?.split('—')[0] ?? tool).trim();
    _activateTool(tool, label);
  });
});

document.querySelectorAll('.obj-btn[data-drag-place]').forEach(btn => {
  btn.addEventListener('pointerdown', e => {
    if (interaction.mode === 'camera') return;
    if (e.button !== 0) return;
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);

    const type  = btn.dataset.tool;
    const ghost = document.createElement('div');
    ghost.id = 'palette-drag-ghost';
    ghost.innerHTML = btn.querySelector('svg').outerHTML;
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top  = `${e.clientY}px`;
    document.body.appendChild(ghost);

    _paletteDrag = { type, ghostEl: ghost };
  });

  btn.addEventListener('pointermove', e => {
    if (!_paletteDrag) return;
    _paletteDrag.ghostEl.style.left = `${e.clientX}px`;
    _paletteDrag.ghostEl.style.top  = `${e.clientY}px`;

    // Highlight canvas while hovering over it
    const svgRect = svg.getBoundingClientRect();
    const overCanvas = e.clientX >= svgRect.left && e.clientX <= svgRect.right &&
                       e.clientY >= svgRect.top  && e.clientY <= svgRect.bottom;
    svg.classList.toggle('palette-drop-target', overCanvas);
  });

  btn.addEventListener('pointerup', e => {
    if (!_paletteDrag) return;
    const { type, ghostEl } = _paletteDrag;
    ghostEl.remove();
    svg.classList.remove('palette-drop-target');
    _paletteDrag = null;

    const svgRect = svg.getBoundingClientRect();
    const overCanvas = e.clientX >= svgRect.left && e.clientX <= svgRect.right &&
                       e.clientY >= svgRect.top  && e.clientY <= svgRect.bottom;
    if (!overCanvas) return;

    const sp  = { x: e.clientX - svgRect.left, y: e.clientY - svgRect.top };
    const wpt = camera.screenToWorld(sp.x, sp.y);
    const sx  = snapWorldCoord(wpt.x, _snapEnabled);
    const sy  = snapWorldCoord(wpt.y, _snapEnabled);

    let body;
    switch (type) {
      case 'ball': body = createBall(sx, sy); break;
      case 'point-mass': body = createPointMass(sx, sy); break;
      case 'box':        body = createBox(sx, sy);       break;
      case 'wedge':      body = createWedge(sx, sy);     break;
    }
    if (body) {
      engine.addBody(body);
      _currentSelection = { type: 'body', id: body.id };
      renderer.select([body.id]);
      props.show(_currentSelection);
      _syncPropsPanel();
    }
  });

  btn.addEventListener('pointercancel', () => {
    if (!_paletteDrag) return;
    _paletteDrag.ghostEl.remove();
    svg.classList.remove('palette-drop-target');
    _paletteDrag = null;
  });
});

document.querySelector('[data-tool="select"]')?.classList.add('active');


// ── Helpers ───────────────────────────────────────────────────────
function _viewSize() {
  const rect = svg.getBoundingClientRect();
  return {
    width:  Math.round(rect.width)  || svg.clientWidth  || 800,
    height: Math.round(rect.height) || svg.clientHeight || 600,
  };
}

/** True when the SVG has a real laid-out size (not a pre-layout 0×0). */
function _viewLaidOut() {
  const rect = svg.getBoundingClientRect();
  const w = Math.round(rect.width) || svg.clientWidth;
  const h = Math.round(rect.height) || svg.clientHeight;
  return w >= 2 && h >= 2;
}

/** Pan + zoom so the metric basis sits at the centre of the simulator view. */
function _frameMetricBasis(scale = DEFAULT_CAMERA_SCALE) {
  const { width: vw, height: vh } = _viewSize();
  const origin = getMetricOriginWorldPx();
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;
  camera.centerOnWorld(origin.x, origin.y, vw, vh, scale);
  renderer.syncMetricOrigin();
}

/**
 * Frame the metric origin once the canvas has a real size.
 * Avoids locking the camera to the 800×600 fallback before layout.
 */
function _frameMetricBasisWhenReady(scale = DEFAULT_CAMERA_SCALE, attempt = 0, onReady = null) {
  if (_viewLaidOut() || attempt >= 60) {
    _frameMetricBasis(scale);
    onReady?.();
    return;
  }
  requestAnimationFrame(() => _frameMetricBasisWhenReady(scale, attempt + 1, onReady));
}

function _whenViewReady(fn, attempt = 0) {
  if (_viewLaidOut() || attempt >= 60) {
    fn();
    return;
  }
  requestAnimationFrame(() => _whenViewReady(fn, attempt + 1));
}

function _updateScrubberFromLive() {
  const total = recorder.frameCount;
  tlScrubber.max   = Math.max(0, total - 1);
  tlScrubber.value = total - 1;
  _updateFill(total - 1);
  tlFrameCount.textContent = `${total} fr`;
  const last = recorder.frames[total - 1];
  if (last) tlTimeDisplay.textContent = `${last.t.toFixed(3)} s`;
}

function _updateScrubberThumb(idx) {
  tlScrubber.max   = Math.max(0, recorder.frameCount - 1);
  tlScrubber.value = idx;
  _updateFill(idx);
  tlFrameCount.textContent = `${idx} / ${recorder.frameCount} fr`;
}

function _updateFill(idx) {
  const max = parseInt(tlScrubber.max, 10) || 1;
  const pct = (idx / max) * 100;
  tlFill.style.width = `${pct}%`;
}

// ── Boot ─────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  requestAnimationFrame(() => {
    _loadBlankScene();
  });
});
