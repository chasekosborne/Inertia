import './units.js'; // patch Matter _baseDelta / Engine._deltaMax before other imports use the engine
import { PhysicsEngine }    from './physics/engine.js';
import { SvgRenderer }      from './editor/view/svg-renderer.js';
import { Recorder }         from './recorder/recorder.js';
import { Playback }         from './recorder/playback.js';
import { ExportControls }   from './exporter/export-controls.js';
import { EnvironmentPanel } from './editor/environment-panel.js';
import { SceneSession }     from './scene/scene-session.js';
import { showToolbarToast } from './editor/toast.js';
import { PropertiesPanel }  from './editor/properties.js';
import { ObjectBrowser }    from './editor/object-browser.js';
import { GraphHost }        from './editor/graph-panel.js';
import { InteractionHandler } from './editor/interaction.js';
import { MeasurementManager } from './editor/measurements.js';
import { LabelManager } from './editor/labels.js';
import {
  buildBlankScene,
  deserializeScene,
  cloneSceneDocument,
  validateSceneDocument,
} from './scene/index.js';
import { removeRope, ropeSelection } from './physics/rope.js';
import { Camera, DEFAULT_CAMERA_SCALE } from './editor/camera/camera.js';
import { CameraRig }        from './editor/camera/camera-rig.js';
import { CameraOverlay }    from './editor/camera-overlay.js';
import { HistoryManager, captureSnapshot, applySnapshot } from './history.js';
import { setMetricOriginEngine, getMetricOriginWorldPx } from './world-origin.js';
import { paramsForScene } from './experiment/params.js';
import { createEditorContext } from './editor/handles/editor-context.js';
import { ScaleHandles } from './editor/handles/scale-handles.js';
import { VectorHandle } from './editor/handles/vector-handle.js';
import { EditHandles } from './editor/handles/edit-handles.js';
import { ObjectClipboard } from './editor/object-clipboard.js';
import { TimelineBar } from './editor/timeline-bar.js';
import { PalettePlacement } from './editor/palette-placement.js';
import { bindShortcuts } from './editor/shortcuts.js';


// ── DOM refs ──────────────────────────────────────────────────────

// Environment panel
const btnPresetMenu = document.getElementById('btn-preset-menu');
const presetMenu    = document.getElementById('preset-menu');
const presetMenuWrap = document.getElementById('preset-menu-wrap');
const btnSceneLoad  = document.getElementById('btn-scene-load');
const btnSceneSave  = document.getElementById('btn-scene-save');
const btnSceneReset = document.getElementById('btn-scene-reset');
const btnSceneClear = document.getElementById('btn-scene-clear');
const btnSettings   = document.getElementById('btn-settings');
const settingsBackdrop = document.getElementById('settings-backdrop');
const btnSettingsClose = document.getElementById('btn-settings-close');

// Settings — display toggles (grid, snap, origin, vectors, traces)
const envGridToggle    = document.getElementById('env-grid-toggle');
const envSnapToggle    = document.getElementById('env-snap-toggle');
const envOriginToggle  = document.getElementById('env-origin-toggle');
const envVectorsToggle = document.getElementById('env-vectors-toggle');
const envTracesToggle  = document.getElementById('env-traces-toggle');

const btnAddGraph   = document.getElementById('btn-add-graph');
const canvasContainer = document.getElementById('canvas-container');
// Canvas / status
const svg           = document.getElementById('sandbox-svg');
const cameraOverlaySvg = document.getElementById('camera-overlay');
const statusMode    = document.getElementById('status-mode');
const statusBodies  = document.getElementById('status-bodies');
const statusConstr  = document.getElementById('status-constraints');
const propsContent  = document.getElementById('properties-content');
const sidebarWrap   = document.getElementById('sidebar-wrap');
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
const obContent     = document.getElementById('object-browser-content');

let _sidebarCollapsed = true;

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

/** Transport button, mode badge, review controls, scrubber, readouts. */
const timeline = new TimelineBar({
  engine, recorder, playback,
  enterReview:    () => _enterReview(),
  toggleCapture:  () => _toggleCaptureSession(),
  clearRecording: () => _clearRecording(),
});

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
  getScrubIndex: () => timeline.getScrubIndex(),
  onSeek: (frameIndex) => {
    _enterReview();
    playback.stop();
    playback.seek(frameIndex);
    timeline.refreshReviewIcon();
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
    const body = engine.bodies.find(b => b.id === _currentSelection.id);
    if (body?._newtonType === 'anchor' && body._driven === true) {
      seed.observable = 'tau';
    } else if (body?._drivenApplied === true && !body.isStatic) {
      seed.observable = 'Fapp';
    } else {
      seed.observable = 'y';
    }
  } else {
    // Prefer vertical position for textbook-style plots (e.g. rock air-drag).
    seed.observable = 'y';
  }
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
    grid:    !!envGridToggle?.checked,
    vectors: !!envVectorsToggle?.checked,
    traces:  !!envTracesToggle?.checked,
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
    }
  },
  onPickModeChange: () => {
    if (labels.isPicking()) {
      statusMode.innerHTML = 'Mode: <strong>Pick label attach (Esc to cancel)</strong>';
    } else if (_currentSelection?.type === 'label') {
      props?.show(_currentSelection);
      objectBrowser?.scheduleRefresh();
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
    objectBrowser?.scheduleRefresh();
  },
});

labels.setAnchorHelpers({
  pickAnchor: (pt, snap) => measurements._pickAnchor(pt, snap),
  resolveAnchor: (a) => measurements.resolve(a),
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
 * (in setup mode) before every structural change. Rope nodes and links are
 * skipped: a rope is one undo step (the caller snapshots once before the
 * whole create / rebuild / delete).
 */
function _isRopeHistoryUnit(name, args) {
  const obj = args[0];
  if (!obj) return false;
  if (name === 'addBody' || name === 'removeBody') return !!obj._ropeSegment;
  if (name === 'addConstraint' || name === 'removeConstraint') return !!obj._ropeLink;
  return false;
}

function _wrapEngineMethod(name) {
  const orig = engine[name].bind(engine);
  engine[name] = (...args) => {
    if (!_isRopeHistoryUnit(name, args)) _pushHistory();
    orig(...args);
  };
}
_wrapEngineMethod('addBody');
_wrapEngineMethod('removeBody');
_wrapEngineMethod('addConstraint');
_wrapEngineMethod('removeConstraint');



function _syncSidebar() {
  sidebarWrap?.classList.toggle('collapsed', _sidebarCollapsed);
  btnSidebarToggle?.setAttribute('aria-expanded', String(!_sidebarCollapsed));
  if (btnSidebarToggle) {
    btnSidebarToggle.title = _sidebarCollapsed ? 'Open sidebar' : 'Close sidebar';
  }
}

function _onSandboxSelect(selection) {
  if (interaction.mode === 'camera') return;
  if (selection) {
    _sidebarCollapsed = false;
    _syncSidebar();
  }
  if (selection?.type === 'measurement') {
    labels.select(null);
    measurements.select(selection.id);
    _currentSelection = selection;
    renderer.select([]);
    props.show(selection);
    objectBrowser?.setSelection(selection);
    return;
  }
  if (selection?.type === 'label') {
    measurements.select(null);
    labels.select(selection.id);
    _currentSelection = selection;
    renderer.select([]);
    props.show(selection);
    objectBrowser?.setSelection(selection);
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
}, () => _snapEnabled, {
  getManager: () => measurements,
  getLabelManager: () => labels,
  onChanged: () => objectBrowser?.scheduleRefresh(),
});

const objectBrowser = new ObjectBrowser(obContent, engine, {
  onSelect: (sel) => _onSandboxSelect(sel),
  beforeChange: () => _pushHistory(),
  listMeasurements: () => measurements.toScene(),
  listLabels: () => labels.listForBrowser(),
  onRenameBody: (id, name) => {
    const body = engine.bodies.find(b => b.id === id);
    if (body) body.label = name;
  },
  onRenameConstraint: (id, name) => {
    const c = engine.constraints.find(x => x.id === id);
    if (c) c.label = name;
  },
  onRenameLabel: (id, text) => {
    labels.setText(id, text);
    if (_currentSelection?.type === 'label' && _currentSelection.id === id) {
      props?.show({ type: 'label', id });
    }
  },
  onAggregateChange: () => objectBrowser.scheduleRefresh(),
});
objectBrowser.refresh();
_syncSidebar();

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

btnSidebarToggle?.addEventListener('click', () => {
  _sidebarCollapsed = !_sidebarCollapsed;
  _syncSidebar();
});

renderer.onSelect(_onSandboxSelect);

// ── App mode ──────────────────────────────────────────────────────
// 'setup'  : no recording, physics paused. Set initial conditions here.
// 'live'   : physics running, recording active (if toggled).
// 'review' : physics frozen, scrubbing through recorded frames.
let appMode   = 'setup';

function setMode(mode) {
  appMode = mode;
  timeline.syncToMode(mode);
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
  timeline.setSimTime(simTime);
  if (recorder.isRecording) {
    recorder.capture(simTime, engine.bodies, engine.constraints);
    // Trail length only advances with recorded frames (not every RAF tick).
    if (envTracesToggle?.checked) {
      renderer.sampleTraces(engine.bodies);
    }
    timeline.setRecordedFrames(recorder.frameCount);
    timeline.syncFromRecording();
    _syncGraphs();
  }
});

/** Rebuild trajectory trails from footage up to the given review frame. */
function _syncReviewTraces(frameIdx = playback.frameIndex) {
  if (!envTracesToggle?.checked) return;
  renderer.setTracesFromFrames(recorder.frames, frameIdx);
}

// ── Playback seeks ────────────────────────────────────────────────
playback.onChange((frameIdx, event) => {
  timeline.syncToFrame(frameIdx);
  if (event === 'end' || event === 'start') {
    timeline.refreshReviewIcon();
  }
  _syncReviewTraces(frameIdx);
  _syncGraphs(true);
});

/**
 * Global shortcuts, in priority order — earlier entries win a shared key.
 *
 * Modifier fields are tri-state: omitting one means "don't care", which is how
 * a binding ends up swallowing things like Ctrl+Shift+I. Be explicit.
 */
bindShortcuts([
  // ── View ──
  {
    code: ['Digit0', 'Numpad0'], ctrl: false,
    run: () => {
      // Prefer graph home when the pointer is over a plot.
      if (graphHost.resetHoveredView()) return;
      _frameMetricBasis(sceneSession.baselineCameraScale ?? DEFAULT_CAMERA_SCALE);
      if (interaction.mode === 'camera') cameraOverlay.sync();
    },
  },

  // ── History ──
  { code: 'KeyZ', ctrl: true, shift: false, run: () => _doUndo() },
  { code: 'KeyZ', ctrl: true, shift: true,  run: () => _doRedo() },
  { code: 'KeyY', ctrl: true,               run: () => _doRedo() },

  // ── Clipboard ── (only consume the key if something was actually copied)
  { code: 'KeyC', ctrl: true, alt: false, shift: false, run: () => objectClipboard.copy() },
  { code: 'KeyV', ctrl: true, alt: false, shift: false, run: () => objectClipboard.paste() },

  // ── Scene ──
  { code: 'KeyS', ctrl: true, alt: false, shift: false, run: () => sceneSession.saveCheckpoint() },

  // ── Transport ──
  {
    code: 'Space', ctrl: false,
    run: () => {
      if (appMode === 'review') timeline.toggleReviewPlay();
      else _toggleCaptureSession();
    },
  },
  {
    code: 'ArrowRight', when: () => appMode === 'review',
    run: () => { playback.stepForward(); timeline.refreshReviewIcon(); },
  },
  {
    code: 'ArrowLeft', when: () => appMode === 'review',
    run: () => { playback.stepBack(); timeline.refreshReviewIcon(); },
  },
  { code: 'KeyI', ctrl: false, run: () => timeline.jumpToStart() },

  // ── Tools ── (R doubles as reverse-play while reviewing)
  {
    code: 'KeyR', ctrl: false, alt: false,
    run: () => {
      if (appMode === 'review') timeline.toggleReviewPlay();
      else _activateTool('rotate', 'Rotate');
    },
  },
  { code: 'KeyS', ctrl: false, alt: false, run: () => _activateTool('select', 'Select / Move') },
  { code: 'KeyC', ctrl: false, alt: false, run: () => _activateTool('scale', 'Scale') },
  { code: 'KeyV', ctrl: false, alt: false, run: () => _activateTool('camera', 'Camera') },

  // ── Selection ──
  // Escape cancels an in-progress draft first; only if there is none does it
  // fall through to closing the menus.
  { code: 'Escape', run: () => measurements.cancelDraft() || labels.cancelPick() || labels.cancelDraft() },
  { code: 'Escape', run: () => { _closeSettings(); _closePresetMenu(); } },
  { code: 'Delete', run: () => _deleteSelection() },
]);

// ── Undo / redo operations ────────────────────────────────────────

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
    return;
  }
  if (selLabelId && labels.getById(selLabelId)) {
    labels.select(selLabelId);
    objectBrowser?.setSelection({ type: 'label', id: selLabelId });
    props.show({ type: 'label', id: selLabelId });
    objectBrowser?.scheduleRefresh();
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
      return;
    }
  }
  props.show(null);
  objectBrowser?.setSelection(null);
  objectBrowser?.scheduleRefresh();
}

function _toggleCaptureSession() {
  const capturing = recorder.isRecording && engine.running;

  if (capturing) {
    engine.pause();
    recorder.stop();
    timeline.setRecording(false);
    exportControls.syncButtons();
    setMode('setup');
  } else {
    if (appMode === 'review') playback.stop();
    recorder.start();          // resumes / continues: does NOT clear frames
    if (recorder.frameCount === 0) {
      recorder.capture(engine.simTime, engine.bodies, engine.constraints);
      if (envTracesToggle?.checked) {
        renderer.sampleTraces(engine.bodies);
      }
    }
    timeline.setRecording(true);
    exportControls.syncButtons(true);
    if (!engine.running) engine.play();
    setMode('live');
  }
  timeline.refreshTransport();
}

function _enterReview() {
  if (appMode === 'review') return;
  if (recorder.isRecording) {
    recorder.stop();
    timeline.setRecording(false);
    exportControls.syncButtons();
  }
  if (engine.running) engine.pause();
  timeline.refreshTransport();
  setMode('review');
}

/** Drop the recording and every view derived from it. */
function _clearRecording() {
  if (recorder.isRecording) {
    recorder.stop();
    timeline.setRecording(false);
  }
  if (appMode === 'review') {
    playback.stop();
    if (engine.running) engine.pause();
    timeline.refreshTransport();
  }
  recorder.clear();
  renderer.clearTraces();
  timeline.reset();
  exportControls.syncButtons(true);
  setMode('setup');
  _syncGraphs(true);
}

// ── View toggles (settings panel) ─────────────────────────────────
function _applyTracesToggle(on) {
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
}

function _applyOriginToggle(on) {
  renderer.setShowMetricOrigin(on);
  interaction.setMetricOriginSelectable(on);
  if (!on && _currentSelection?.type === 'body') {
    const b = engine.bodies.find(x => x.id === _currentSelection.id);
    if (b?._newtonType === 'metric-basis') _onSandboxSelect(null);
  }
}

// ── Interaction / selection ───────────────────────────────────────
const interaction = new InteractionHandler(svg, engine, _onSandboxSelect, camera, renderer.interactionGhostLayer);

_snapEnabled = !!envSnapToggle?.checked;
interaction.setSnapEnabled(_snapEnabled);
renderer.setShowGrid(!!envGridToggle?.checked);
renderer.setShowVectors(!!envVectorsToggle?.checked);
_applyTracesToggle(!!envTracesToggle?.checked);
_applyOriginToggle(!!envOriginToggle?.checked);

envGridToggle?.addEventListener('change', () => {
  renderer.setShowGrid(!!envGridToggle.checked);
});
envSnapToggle?.addEventListener('change', () => {
  _snapEnabled = !!envSnapToggle.checked;
  interaction.setSnapEnabled(_snapEnabled);
});
envOriginToggle?.addEventListener('change', () => {
  _applyOriginToggle(!!envOriginToggle.checked);
});
envVectorsToggle?.addEventListener('change', () => {
  renderer.setShowVectors(!!envVectorsToggle.checked);
});
envTracesToggle?.addEventListener('change', () => {
  _applyTracesToggle(!!envTracesToggle.checked);
});

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

/** Ctrl+C / Ctrl+V for the current selection. */
const objectClipboard = new ObjectClipboard(editorContext);

/** Drag a body out of the object palette onto the canvas. */
const palettePlacement = new PalettePlacement({
  svg, camera, engine,
  getToolMode: () => interaction.mode,
  getSnapEnabled: () => _snapEnabled,
  onPlaced: (body) => _onSandboxSelect({ type: 'body', id: body.id }),
});

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

/**
 * Delete whatever is selected. Overlays first (they can be selected while a
 * body is), then setup-mode scene objects.
 * @returns {boolean} whether the keystroke was consumed.
 */
function _deleteSelection() {
  if (interaction.mode === 'camera') return false;
  if (measurements.deleteSelected()) return true;
  if (labels.deleteSelected()) {
    _onSandboxSelect(null);
    objectBrowser?.scheduleRefresh();
    return true;
  }
  if (appMode !== 'setup') return false;
  if (!_currentSelection) return false;

  if (_currentSelection.type === 'measurement') {
    measurements.deleteSelected();
    return true;
  }

  if (_currentSelection.type === 'constraint') {
    const constraint = engine.constraints.find(x => x.id === _currentSelection.id);
    if (!constraint) {
      _onSandboxSelect(null);
      return false;
    }
    engine.removeConstraint(constraint);
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return true;
  }

  if (_currentSelection.type === 'aggregate') {
    for (const id of [...(_currentSelection.memberIds ?? [])]) {
      const body = engine.bodies.find(b => b.id === id);
      if (!body || body._newtonType === 'metric-basis') continue;
      engine.removeBody(body);
      interaction.notifyBodyRemoved(id);
    }
    objectBrowser.scheduleRefresh();
    _onSandboxSelect(null);
    return true;
  }

  if (_currentSelection.type === 'rope') {
    if (!_currentSelection.ropeId) return false;
    _removeRopeById(_currentSelection.ropeId);
    return true;
  }

  if (_currentSelection.type !== 'body') return false;

  const body = engine.bodies.find(b => b.id === _currentSelection.id);
  if (!body) {
    _onSandboxSelect(null);
    return false;
  }
  if (body._newtonType === 'metric-basis') return false;

  // A rope segment stands in for the whole rope.
  if (body._ropeSegment && body._ropeId) {
    _removeRopeById(body._ropeId);
    return true;
  }

  const removedId = body.id;
  engine.removeBody(body);
  interaction.notifyBodyRemoved(removedId);
  objectBrowser.scheduleRefresh();
  _onSandboxSelect(null);
  return true;
}

/** Remove every segment of a rope and clear the selection. */
function _removeRopeById(ropeId) {
  _pushHistory();
  const ids = engine.bodies.filter(b => b._ropeId === ropeId).map(b => b.id);
  removeRope(engine, ropeId);
  for (const id of ids) interaction.notifyBodyRemoved(id);
  objectBrowser.scheduleRefresh();
  _onSandboxSelect(null);
}

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
  timeline.reset();
  timeline.setSimTime(0);
  exportControls.syncButtons(true);
  setMode('setup');
  timeline.refreshTransport();
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
  timeline.setRecording(false);
  engine.resetSimTime();
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
  _closePresetMenu();
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

// Ground in the add bar activates drag-to-lay placement (palette-style), not palette drag-drop.
document.querySelectorAll('.obj-btn-ground').forEach(btn => {
  btn.addEventListener('click', () => _activateTool('ground', 'Ground'));
});

// Object / constraint tools: click to change mode (rod|spring|rope = drag between bodies)
document.querySelectorAll('.obj-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    const label = (btn.getAttribute('title')?.split('—')[0] ?? tool).trim();
    _activateTool(tool, label);
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
  cameraRig.syncFromCamera(camera, vw, vh);
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

// ── Boot ─────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  requestAnimationFrame(() => {
    _loadBlankScene();
  });
});
