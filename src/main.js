import './units.js'; // patch Matter _baseDelta / Engine._deltaMax before other imports use the engine
import Matter from 'matter-js';
import { PhysicsEngine }    from './physics/engine.js';
import { SvgRenderer }      from './renderer/svg-renderer.js';
import { Recorder }         from './recorder/recorder.js';
import { Playback }         from './recorder/playback.js';
import { exportAnimatedSVG, downloadSVG } from './exporter/svg-exporter.js';
import { exportRecordingVideo, downloadVideosSequentially, videoExportSupported, recordingDurationSec, sampleExportFrameIndices } from './exporter/mp4-exporter.js';
import { graphExportDimensions, GRAPH_ASPECT_OPTIONS } from './exporter/graph-video.js';
import { PropertiesPanel }  from './ui/properties.js';
import { ObjectBrowser }    from './ui/object-browser.js';
import { GraphHost }        from './ui/graph-panel.js';
import { InteractionHandler } from './ui/interaction.js';
import { MeasurementManager } from './ui/measurements.js';
import { LabelManager } from './ui/labels.js';
import {
  buildBlankScene,
  deserializeScene,
  serializeScene,
  cloneSceneDocument,
  downloadSceneJSON,
  pickAndLoadSceneFile,
  validateSceneDocument,
} from './scene/index.js';
import {
  removeRope, ropeSelection, setRopeEndAttachment, getRopeEndAttachment,
  ropeEndNode, snapRopePins,
} from './physics/rope.js';
import { Camera, DEFAULT_CAMERA_SCALE } from './camera/camera.js';
import { CameraRig }        from './camera/camera-rig.js';
import { CameraOverlay }    from './ui/camera-overlay.js';
import { HistoryManager, captureSnapshot, applySnapshot } from './history.js';
import { FONT_DIAGRAM, COLORS } from './theme.js';
import { createPointMass, createBall, createBox, createWedge, scaleBoxTo, scaleCircleTo,
         scaleWedgeTo, wedgeScaleHandleLocal, clampWedgeFootAngle,
         wedgeAABBCenterWorld, setWedgeAABBCenter, worldToWedgeAABBLocal,
         wedgeTriangleWorldVerts } from './physics/bodies.js';
import { snapWorldCoord, snapSegmentFromStart, snapVelocityToAngle, snapAngleRad,
         SNAP_ANGLE_STEP_5_DEG, VELOCITY_SNAP_MS } from './grid.js';
import {
  constraintAnchorWorld,
  setConstraintEndAttachment,
  findConstraintAttachTarget,
  groundTopEdgeWorld,
  replaceGroundFromTopEdge,
  isConstraintLengthStretchBody,
  stretchConstraintEndAlongAxis,
  captureHangingChain,
  applyHangingChainTranslation,
} from './physics/layout-anchors.js';
import {
  PX_PER_M,
  pxToM,
  getForcePxPerN,
  getVelocityPxPerMs,
  getForceArrowScale,
  setForceArrowScale,
  getVelocityArrowScale,
  setVelocityArrowScale,
  matterVelToDisplayMS,
  displayMSToMatterVel,
} from './units.js';
import { setMetricOriginEngine, getMetricOriginWorldPx } from './world-origin.js';
import { getAppliedForce } from './physics/applied-force.js';
import { applyQuadraticAirDrag } from './physics/air-drag.js';
import { paramsForScene } from './experiment/params.js';

const { Events: MatterEvents, Body } = Matter;

// ── DOM refs ──────────────────────────────────────────────────────

// Environment panel
const envGravityToggle = document.getElementById('env-gravity-toggle');
const envGRow          = document.getElementById('env-g-row');
const envG             = document.getElementById('env-g');
const envAirToggle  = document.getElementById('env-air-toggle');
const envCdRow      = document.getElementById('env-cd-row');
const envAreaRow    = document.getElementById('env-area-row');
const envRhoRow     = document.getElementById('env-rho-row');
const envCd         = document.getElementById('env-cd');
const envArea       = document.getElementById('env-area');
const envRho        = document.getElementById('env-rho');
const envArrowForceScale = document.getElementById('env-force-arrow-scale');
const envArrowForceScaleLabel = document.getElementById('env-force-arrow-scale-label');
const envArrowVelScale = document.getElementById('env-vel-arrow-scale');
const envArrowVelScaleLabel = document.getElementById('env-vel-arrow-scale-label');
const btnPresetMenu = document.getElementById('btn-preset-menu');
const presetMenu    = document.getElementById('preset-menu');
const presetMenuWrap = document.getElementById('preset-menu-wrap');
const btnSceneLoad  = document.getElementById('btn-scene-load');
const btnSceneSave  = document.getElementById('btn-scene-save');
const btnSceneNew   = document.getElementById('btn-scene-new');
const btnSceneReset = document.getElementById('btn-scene-reset');
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
const btnExportSvg  = document.getElementById('btn-export-svg');
const btnExportMp4  = document.getElementById('btn-export-mp4');
const videoExportBackdrop = document.getElementById('video-export-backdrop');
const btnVideoExportClose = document.getElementById('btn-video-export-close');
const btnVideoExportCancel = document.getElementById('btn-video-export-cancel');
const btnVideoExportRun = document.getElementById('btn-video-export-run');
const videoExportPreset = document.getElementById('video-export-preset');
const videoExportSize = document.getElementById('video-export-size');
const videoExportFps = document.getElementById('video-export-fps');
const videoExportFilename = document.getElementById('video-export-filename');
const videoExportFrameCount = document.getElementById('video-export-frame-count');
const videoExportIncludeSim = document.getElementById('video-export-include-sim');
const videoExportSimPanel = document.getElementById('video-export-sim-panel');
const videoExportIncludeGraphs = document.getElementById('video-export-include-graphs');
const videoExportGraphPanel = document.getElementById('video-export-graph-panel');
const videoExportGraphList = document.getElementById('video-export-graph-list');
const videoExportGraphEmpty = document.getElementById('video-export-graph-empty');
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
const renderer = new SvgRenderer(svg, engine);
const camera   = new Camera();
const cameraRig = new CameraRig();
camera.attach(renderer.worldGroup);
const cameraOverlay = new CameraOverlay(cameraOverlaySvg, camera, cameraRig);

function _syncCameraOverlaySize() {
  const { width, height } = _viewSize();
  if (!cameraOverlaySvg || width < 2) return;
  cameraOverlaySvg.setAttribute('width', String(width));
  cameraOverlaySvg.setAttribute('height', String(height));
  cameraOverlaySvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

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
  getBaselineScene: () => {
    if (!_sceneBaseline) return null;
    // Keep sweep/graph measurement lists in sync with the live overlay set.
    const doc = cloneSceneDocument(_sceneBaseline);
    doc.measurements = measurements.toScene();
    return doc;
  },
  getSceneName: () => _sceneSource?.name ?? _sceneBaseline?.meta?.name ?? null,
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
  _syncExportButtons();
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

const SVG_NS = 'http://www.w3.org/2000/svg';
let _velHandle = null;
let _draggingHandle = false;
/** True while dragging the vector handle with Ctrl: angle snapped to 5°. */
let _velHandleAngleSnap = false;
/** Handle edits either initial velocity or applied force (double-click tip to toggle). */
let _vectorHandleMode = 'velocity'; // 'velocity' | 'force'

const VEL_HANDLE_COLOR = '#2980b9';
const FORCE_HANDLE_COLOR = '#c0392b';

let _selHandleG = null;
let _selHandleDrag = null;
let _selHandleGhost = null;
let _shBuildKey = '';

let _scaleHandleG = null;
let _scaleHandleDrag = null;
let _scaleHandleGhost = null;
let _scaleBuildKey = '';

function _clearSelectionEditHandles() {
  if (_selHandleG) { _selHandleG.remove(); _selHandleG = null; }
  if (_selHandleGhost) { _selHandleGhost.remove(); _selHandleGhost = null; }
}

function _clearScaleHandles() {
  if (_scaleHandleG) { _scaleHandleG.remove(); _scaleHandleG = null; }
  if (_scaleHandleGhost) { _scaleHandleGhost.remove(); _scaleHandleGhost = null; }
  _scaleHandleDrag = null;
}

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
    _vectorHandleMode = 'velocity';
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
    _destroyVelHandle();
    _clearSelectionEditHandles();
    _clearScaleHandles();
    _scaleBuildKey = '';
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
/** @type {import('./scene/schema.js').SceneDocument|null} */
let _sceneBaseline = null;
/** @type {{ type: 'blank'|'file', name: string }|null} */
let _sceneSource = null;

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
    _syncCameraOverlaySize();
    cameraOverlay.sync();
  } else if (cameraRig.followBodyId && (engine.running || appMode === 'review')) {
    cameraRig.updateFollow(engine);
    _applyCameraRig();
  }
  renderer.render();
  labels.sync();
  measurements.sync();
  _syncVelHandle();
  _syncSelectionHandles();
  _syncScaleHandles();
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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Digit0' || e.code === 'Numpad0') {
    e.preventDefault();
    // Prefer graph home when the pointer is over a plot.
    if (graphHost.resetHoveredView()) return;
    const scale = (typeof _sceneBaseline?.camera?.s === 'number' && Number.isFinite(_sceneBaseline.camera.s))
      ? _sceneBaseline.camera.s
      : DEFAULT_CAMERA_SCALE;
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
  _destroyVelHandle();
  _clearSelectionEditHandles();
  _clearScaleHandles();
  _scaleBuildKey = '';

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
    _syncExportButtons();
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
    _syncExportButtons(true);
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
      _syncExportButtons();
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
  btnExportSvg.disabled = true;
  btnExportMp4.disabled = true;
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
      _syncExportButtons();
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

// ── Export ────────────────────────────────────────────────────────
let _videoExportOk = false;
let _exportBusy = false;

videoExportSupported().then(ok => {
  _videoExportOk = ok;
  if (!ok && btnExportMp4) {
    btnExportMp4.title = 'Video export requires WebCodecs or MediaRecorder';
  }
  _syncExportButtons();
});

/** @param {boolean} [forceDisable] */
function _syncExportButtons(forceDisable = false) {
  const hasFrames = !forceDisable && recorder.frameCount > 0 && !_exportBusy;
  const hasGraphExport = !forceDisable && graphHost.listVideoExportCandidates().length > 0 && !_exportBusy;
  if (btnExportSvg) btnExportSvg.disabled = !hasFrames;
  if (btnExportMp4) btnExportMp4.disabled = (!hasFrames && !hasGraphExport) || !_videoExportOk || _exportBusy;
}

/** @param {() => Promise<void>} fn */
async function _withExportUiHidden(fn) {
  const hidden = [];
  for (const layer of [renderer.uiTopLayer, renderer.interactionGhostLayer]) {
    if (layer && layer.style.display !== 'none') {
      hidden.push(layer);
      layer.style.display = 'none';
    }
  }
  try {
    return await fn();
  } finally {
    for (const layer of hidden) layer.style.display = '';
  }
}

/** Apply toolbar view toggles to the renderer before export. */
function _syncExportViewToggles() {
  renderer.setShowGrid(btnGrid.classList.contains('active'));
  renderer.setShowVectors(btnVectors.classList.contains('active'));
  const traces = btnTraces.classList.contains('active');
  renderer.setShowTraces(traces);
  if (traces) {
    renderer.setTracesFromFrames(recorder.frames, playback.frameIndex);
  } else {
    renderer.clearTraces();
  }
}

function _updateVideoExportFrameCount() {
  if (!videoExportFrameCount) return;
  const n = recorder.frameCount;
  if (n <= 0) {
    videoExportFrameCount.textContent = '0';
    return;
  }
  const dur = recordingDurationSec(recorder.frames);
  const fps = Math.max(1, Math.min(120, parseInt(videoExportFps?.value ?? '60', 10) || 60));
  const { outputFrames } = sampleExportFrameIndices(recorder.frames, fps);
  videoExportFrameCount.textContent =
    `${outputFrames} export frames from ${n} recorded (${dur.toFixed(3)} s sim time @ ${fps} fps)`;
}

function _openVideoExportDialog() {
  _closePresetMenu();
  if (videoExportPreset) videoExportPreset.value = '1080p';
  _applyVideoExportPreset();
  graphHost.prepareVideoExport();
  _updateVideoExportFrameCount();
  const hasFrames = recorder.frameCount > 0;
  const summaries = graphHost.getVideoExportSummaries();
  const exportableGraphs = summaries.filter(s => s.canExport);
  if (videoExportIncludeSim) {
    videoExportIncludeSim.checked = hasFrames;
    videoExportIncludeSim.disabled = !hasFrames;
  }
  if (videoExportSimPanel) videoExportSimPanel.classList.toggle('hidden', !videoExportIncludeSim?.checked);
  if (videoExportIncludeGraphs) {
    videoExportIncludeGraphs.checked = exportableGraphs.length > 0;
    videoExportIncludeGraphs.disabled = summaries.length === 0;
  }
  _rebuildGraphExportList();
  _syncVideoExportPanels();
  videoExportBackdrop?.classList.remove('hidden');
  videoExportBackdrop?.setAttribute('aria-hidden', 'false');
}

function _syncVideoExportPanels() {
  if (videoExportSimPanel) {
    videoExportSimPanel.classList.toggle('hidden', !videoExportIncludeSim?.checked);
  }
  if (videoExportGraphPanel) {
    videoExportGraphPanel.classList.toggle('hidden', !videoExportIncludeGraphs?.checked);
  }
  if (btnVideoExportRun) {
    const sim = !!videoExportIncludeSim?.checked;
    const graphs = !!videoExportIncludeGraphs?.checked
      && !!videoExportGraphList?.querySelector('.graph-export-row:not(.is-disabled) input[type="checkbox"]:checked');
    btnVideoExportRun.disabled = !sim && !graphs;
  }
}

function _rebuildGraphExportList() {
  if (!videoExportGraphList) return;
  videoExportGraphList.innerHTML = '';
  const summaries = graphHost.getVideoExportSummaries();
  if (videoExportGraphEmpty) {
    videoExportGraphEmpty.classList.toggle('hidden', summaries.length > 0);
  }
  for (const s of summaries) {
    const row = document.createElement('div');
    row.className = 'graph-export-row' + (s.canExport ? '' : ' is-disabled');
    row.dataset.exportId = String(s.id);

    const head = document.createElement('div');
    head.className = 'graph-export-row-head';
    const includeLabel = document.createElement('label');
    const includeCb = document.createElement('input');
    includeCb.type = 'checkbox';
    includeCb.checked = s.canExport;
    includeCb.disabled = !s.canExport;
    includeCb.dataset.role = 'include';
    const titleWrap = document.createElement('span');
    titleWrap.className = 'graph-export-row-title';
    titleWrap.textContent = s.title;
    if (!s.canExport && s.reason) {
      const note = document.createElement('span');
      note.className = 'graph-export-row-note';
      note.textContent = s.reason;
      titleWrap.appendChild(document.createElement('br'));
      titleWrap.appendChild(note);
    }
    includeLabel.append(includeCb, titleWrap);
    head.appendChild(includeLabel);
    row.appendChild(head);

    const settings = document.createElement('div');
    settings.className = 'graph-export-settings';

    const aspectLabel = document.createElement('span');
    aspectLabel.className = 'prop-label';
    aspectLabel.textContent = 'Aspect';
    const aspectSel = document.createElement('select');
    aspectSel.className = 'prop-value';
    aspectSel.dataset.role = 'aspect';
    for (const opt of GRAPH_ASPECT_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      aspectSel.appendChild(o);
    }
    aspectSel.value = s.plotAspect >= 1.2 ? '16:9' : s.plotAspect >= 0.95 ? '4:3' : '9:16';

    const presetLabel = document.createElement('span');
    presetLabel.className = 'prop-label';
    presetLabel.textContent = 'Resolution';
    const presetSel = document.createElement('select');
    presetSel.className = 'prop-value';
    presetSel.dataset.role = 'preset';
    for (const [val, label] of [['720p', '720p'], ['1080p', '1080p'], ['1440p', '1440p'], ['4k', '4K']]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      if (val === '1080p') o.selected = true;
      presetSel.appendChild(o);
    }

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'prop-label';
    sizeLabel.textContent = 'Output';
    const sizeReadout = document.createElement('span');
    sizeReadout.className = 'export-size-readout';
    sizeReadout.dataset.role = 'size';

    const fpsLabel = document.createElement('span');
    fpsLabel.className = 'prop-label';
    fpsLabel.textContent = 'Frame rate';
    const fpsSel = document.createElement('select');
    fpsSel.className = 'prop-value';
    fpsSel.dataset.role = 'fps';
    for (const [val, label] of [['24', '24 fps'], ['30', '30 fps'], ['60', '60 fps']]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      if (val === '60') o.selected = true;
      fpsSel.appendChild(o);
    }

    const animLabel = document.createElement('span');
    animLabel.className = 'prop-label';
    animLabel.textContent = 'Animation';
    const animSel = document.createElement('select');
    animSel.className = 'prop-value';
    animSel.dataset.role = 'anim';
    for (const [val, label] of [
      ['draw', 'Draw progressively'],
      ['playback', 'Playback (dot on path)'],
    ]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      animSel.appendChild(o);
    }

    const syncSize = () => {
      const { label } = graphExportDimensions(
        /** @type {import('./exporter/graph-video.js').GraphResolutionPreset} */ (presetSel.value),
        /** @type {import('./exporter/graph-video.js').GraphAspectPreset} */ (aspectSel.value),
        s.plotAspect,
      );
      sizeReadout.textContent = label;
    };
    aspectSel.addEventListener('change', syncSize);
    presetSel.addEventListener('change', syncSize);
    includeCb.addEventListener('change', () => _syncVideoExportPanels());
    syncSize();

    settings.append(
      aspectLabel, aspectSel,
      presetLabel, presetSel,
      sizeLabel, sizeReadout,
      fpsLabel, fpsSel,
      animLabel, animSel,
    );
    row.appendChild(settings);
    if (!s.canExport) {
      for (const el of settings.querySelectorAll('select')) el.disabled = true;
    }
    videoExportGraphList.appendChild(row);
  }
}

function _readGraphExportEntries() {
  if (!videoExportIncludeGraphs?.checked || !videoExportGraphList) return [];
  /** @type {object[]} */
  const entries = [];
  for (const row of videoExportGraphList.querySelectorAll('.graph-export-row')) {
    const include = row.querySelector('input[data-role="include"]');
    if (!include?.checked || row.classList.contains('is-disabled')) continue;
    const exportId = Number(row.dataset.exportId);
    const win = graphHost.findByExportId(exportId);
    if (!win) continue;
    const aspect = row.querySelector('select[data-role="aspect"]')?.value ?? '16:9';
    const preset = row.querySelector('select[data-role="preset"]')?.value ?? '1080p';
    const fps = Math.max(1, Math.min(120, parseInt(row.querySelector('select[data-role="fps"]')?.value ?? '60', 10) || 60));
    const animMode = row.querySelector('select[data-role="anim"]')?.value === 'playback' ? 'playback' : 'draw';
    const { width, height } = graphExportDimensions(
      /** @type {import('./exporter/graph-video.js').GraphResolutionPreset} */ (preset),
      /** @type {import('./exporter/graph-video.js').GraphAspectPreset} */ (aspect),
      win.getPlotAspect(),
    );
    entries.push({ win, width, height, fps, animMode, preset, aspect });
  }
  return entries;
}

function _closeVideoExportDialog() {
  videoExportBackdrop?.classList.add('hidden');
  videoExportBackdrop?.setAttribute('aria-hidden', 'true');
}

function _applyVideoExportPreset() {
  const preset = videoExportPreset?.value ?? '1080p';
  const { label } = cameraRig.exportDimensionsForPreset(preset);
  if (videoExportSize) videoExportSize.textContent = label;
}

function _readVideoExportOptions() {
  const preset = videoExportPreset?.value ?? '1080p';
  const { width, height } = cameraRig.exportDimensionsForPreset(preset);
  const fps = Math.max(1, Math.min(120, parseInt(videoExportFps?.value ?? '60', 10) || 60));
  const baseName = String(videoExportFilename?.value ?? 'inertia-recording').trim() || 'inertia-recording';
  return {
    includeSim: !!videoExportIncludeSim?.checked,
    includeGraphs: !!videoExportIncludeGraphs?.checked,
    width,
    height,
    fps,
    baseName: baseName.replace(/\.(mp4|webm)$/i, ''),
    graphs: _readGraphExportEntries(),
  };
}

async function _runGraphVideoExports(graphEntries, baseName, prevModeText) {
  const frames = recorder.frames;
  /** @type {Array<{ blob: Blob, filename: string }>} */
  const downloads = [];
  let n = 0;
  for (const entry of graphEntries) {
    n += 1;
    statusMode.innerHTML = `Exporting: <strong>Graph ${n}/${graphEntries.length}</strong>`;
    entry.win.refresh();
    const { blob, filename: outName } = await entry.win.exportVideo({
      frames,
      width: entry.width,
      height: entry.height,
      fps: entry.fps,
      animMode: entry.animMode,
      onProgress: (done, total) => {
        statusMode.innerHTML = `Exporting: <strong>Graph ${n}/${graphEntries.length} · ${done}/${total}</strong>`;
      },
    });
    const ext = outName.split('.').pop() ?? (blob.type.includes('webm') ? 'webm' : 'mp4');
    downloads.push({
      blob,
      filename: `${entry.win.exportFilename(baseName)}.${ext}`,
    });
  }
  return downloads;
}

async function _runBatchVideoExport(opts) {
  if (_exportBusy) return;
  _exportBusy = true;
  _syncExportButtons();
  if (btnVideoExportRun) btnVideoExportRun.disabled = true;

  const prevModeText = statusMode.innerHTML;
  const savedIdx = playback.frameIndex;
  playback.stop();

  /** @type {Array<{ blob: Blob, filename: string }>} */
  const downloads = [];

  try {
    if (opts.includeSim) {
      playback.jumpToStart();
      _enterReview();
      _syncExportViewToggles();
      cameraRig.applyToCamera(camera, opts.width, opts.height);
      statusMode.innerHTML = 'Exporting: <strong>Simulation…</strong>';
      const { blob, filename: outName } = await _withExportUiHidden(() => exportRecordingVideo(recorder.frames, {
        svg: svg,
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        onProgress: (done, total) => {
          statusMode.innerHTML = `Exporting: <strong>Simulation ${done}/${total}</strong>`;
        },
        renderFrame: async (i) => {
          playback.seek(i);
          if (cameraRig.followBodyId) cameraRig.updateFollow(engine);
          cameraRig.applyToCamera(camera, opts.width, opts.height);
          renderer.render();
          labels.sync();
          measurements.sync();
          await new Promise(r => requestAnimationFrame(r));
        },
      }));
      const ext = outName.split('.').pop() ?? (blob.type.includes('webm') ? 'webm' : 'mp4');
      downloads.push({
        blob,
        filename: `${opts.baseName}-simulation.${ext}`,
      });
    }

    if (opts.includeGraphs && opts.graphs.length) {
      const graphDownloads = await _runGraphVideoExports(opts.graphs, opts.baseName, prevModeText);
      downloads.push(...graphDownloads);
    }

    if (downloads.length) {
      statusMode.innerHTML = `Downloading: <strong>${downloads.length} file${downloads.length === 1 ? '' : 's'}…</strong>`;
      await downloadVideosSequentially(downloads);
    }
  } finally {
    playback.seek(savedIdx);
    renderer.render();
    measurements.sync();
    _applyCameraRig();
    statusMode.innerHTML = prevModeText;
    _exportBusy = false;
    if (btnVideoExportRun) btnVideoExportRun.disabled = false;
    _syncExportButtons();
  }
}

btnExportSvg.addEventListener('click', () => {
  _closePresetMenu();
  if (btnExportSvg.disabled) return;
  const size   = _viewSize();
  const svgStr = exportAnimatedSVG(recorder.frames, {
    width:       size.width,
    height:      size.height,
    showGrid:    btnGrid.classList.contains('active'),
    showTraces:  btnTraces.classList.contains('active'),
    showVectors: btnVectors.classList.contains('active'),
  });
  downloadSVG(svgStr, 'inertia-animation.svg');
});

btnExportMp4?.addEventListener('click', () => {
  _closePresetMenu();
  if (btnExportMp4.disabled || _exportBusy) return;
  _openVideoExportDialog();
});

videoExportPreset?.addEventListener('change', _applyVideoExportPreset);
videoExportFps?.addEventListener('change', _updateVideoExportFrameCount);

videoExportIncludeSim?.addEventListener('change', _syncVideoExportPanels);
videoExportIncludeGraphs?.addEventListener('change', _syncVideoExportPanels);

btnVideoExportClose?.addEventListener('click', _closeVideoExportDialog);
btnVideoExportCancel?.addEventListener('click', _closeVideoExportDialog);

videoExportBackdrop?.addEventListener('click', e => {
  if (e.target === videoExportBackdrop) _closeVideoExportDialog();
});

btnVideoExportRun?.addEventListener('click', async () => {
  if (btnVideoExportRun.disabled || _exportBusy) return;
  const opts = _readVideoExportOptions();
  if (!opts.includeSim && (!opts.includeGraphs || !opts.graphs.length)) return;
  _closeVideoExportDialog();
  try {
    await _runBatchVideoExport(opts);
  } catch (err) {
    console.error(err);
    window.alert(err instanceof Error ? err.message : 'Video export failed.');
  }
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

function _overlayPoint(e) {
  const rect = cameraOverlaySvg.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** View pan while in camera mode (distinct from frame-handle drags). */
let _cameraViewPanning = false;

function _endCameraViewPan() {
  if (!_cameraViewPanning) return;
  _cameraViewPanning = false;
  camera.endPan();
  cameraOverlaySvg?.classList.remove('camera-pan-active');
}

cameraOverlaySvg?.addEventListener('pointerdown', e => {
  if (interaction.mode !== 'camera') return;
  const pt = _overlayPoint(e);

  // Shift+drag or middle-button drag pans the view, frame handles edit the export bounds.
  if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
    _endCameraViewPan();
    camera.beginPan(pt.x, pt.y);
    _cameraViewPanning = true;
    cameraOverlaySvg.classList.add('camera-pan-active');
    cameraOverlaySvg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  if (e.button !== 0) return;

  const mode = cameraOverlay.hitHandle(pt.x, pt.y);
  if (mode) {
    _endCameraViewPan();
    cameraOverlay.beginDrag(mode, pt.x, pt.y);
    cameraOverlaySvg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  // Outside the frame: drag to pan the view.
  _endCameraViewPan();
  camera.beginPan(pt.x, pt.y);
  _cameraViewPanning = true;
  cameraOverlaySvg.classList.add('camera-pan-active');
  cameraOverlaySvg.setPointerCapture(e.pointerId);
  e.preventDefault();
});

cameraOverlaySvg?.addEventListener('pointermove', e => {
  const pt = _overlayPoint(e);
  if (_cameraViewPanning) {
    camera.movePan(pt.x, pt.y);
    cameraOverlay.sync();
    return;
  }
  if (!cameraOverlay.isDragging) return;
  cameraOverlay.moveDrag(pt.x, pt.y);
});

cameraOverlaySvg?.addEventListener('pointerup', () => {
  const wasFrameDrag = cameraOverlay.isDragging;
  cameraOverlay.endDrag();
  _endCameraViewPan();
  if (wasFrameDrag && interaction.mode === 'camera') {
    props.showCamera(cameraRig, _onCameraRigChanged);
  }
});
cameraOverlaySvg?.addEventListener('pointercancel', () => {
  const wasFrameDrag = cameraOverlay.isDragging;
  cameraOverlay.endDrag();
  _endCameraViewPan();
  if (wasFrameDrag && interaction.mode === 'camera') {
    props.showCamera(cameraRig, _onCameraRigChanged);
  }
});

cameraOverlaySvg?.addEventListener('wheel', e => {
  if (interaction.mode !== 'camera') return;
  e.preventDefault();
  const pt = _overlayPoint(e);
  camera.onWheel(pt.x, pt.y, e.deltaY);
  cameraOverlay.sync();
}, { passive: false });

window.addEventListener('resize', () => {
  _syncCameraOverlaySize();
  if (interaction.mode === 'camera') cameraOverlay.sync();
});
interaction.measurements = measurements;
interaction.labels = labels;

// Record undo snapshot before a body drag begins
interaction.onBeforeDrag = _pushHistory;
interaction.getSetupSelection = () => (appMode === 'setup' ? _currentSelection : null);
interaction.onTempPanPreview = (active) => {
  document.body.classList.toggle('shift-pan-preview', active);
  cameraOverlaySvg?.classList.toggle('camera-pan-ready', active && interaction.mode === 'camera');
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

// ── Environment panel ─────────────────────────────────────────────
// Physics unit: 100 px = 1 m. Fixed step ≈ 1000/SIM_HZ ms (see units.js).
// Matter gravity formula: force = mass * g.y * g.scale
// To get real-world acceleration: a_px = g_ms2 * PX_PER_M = g_ms2 * 100 px/s²
// Matter scale links g.y (dimensionless 1) to px/ms² implicitly via dt in ms.
// With scale=0.001, g.y=1 → ~9.8 px/(physics step)² at the chosen SIM_HZ ≈ real-ish.
// We expose g in m/s² and compute scale = g_ms2 * 0.001 / 9.81 so the default
// 9.81 → scale 0.001 as before.

function _applyGravity() {
  const enabled = envGravityToggle.checked;
  const gMs2    = enabled ? (parseFloat(envG.value) || 9.81) : 0;
  engine.engine.gravity.y     = 1;
  engine.engine.gravity.x     = 0;
  engine.engine.gravity.scale = gMs2 * 0.001 / 9.81;
  engine.invalidateEnergyTarget();
}

function _syncGravityRowUI() {
  const disabled = !envGravityToggle.checked;
  envGRow.style.opacity       = disabled ? '0.35' : '1';
  envGRow.style.pointerEvents = disabled ? 'none'  : '';
}

envGravityToggle.addEventListener('change', () => {
  _syncGravityRowUI();
  _applyGravity();
});

// Air-drag is applied each physics step via a per-body force.
// F_drag = 0.5 * rho * Cd * A * v² (N), converted to px-force.
// frictionAir in Matter is a velocity multiplier per step (dimensionless).
// We bypass frictionAir and instead apply an explicit force so Cd/rho/A are real.
let _airEnabled = false;

function _syncAirRowsUI() {
  const disabled = !_airEnabled;
  [envCdRow, envAreaRow, envRhoRow].forEach(r => {
    r.style.opacity       = disabled ? '0.35' : '1';
    r.style.pointerEvents = disabled ? 'none'  : '';
  });
}

function _airParams() {
  return {
    rho:  parseFloat(envRho.value)  || 1.225,
    Cd:   parseFloat(envCd.value)   || 0.47,
    A:    parseFloat(envArea.value) || 0.045,
  };
}

// Register a before-update hook to apply drag force
MatterEvents.on(engine.engine, 'beforeUpdate', () => {
  if (!_airEnabled) return;
  applyQuadraticAirDrag(engine.bodies, _airParams(), engine);
});

envAirToggle.addEventListener('change', () => {
  _airEnabled = envAirToggle.checked;
  _syncAirRowsUI();
});

// ── Explicit spring forces are solved in PhysicsEngine._solveSprings() ──
// (SpringConstraint: not Matter rigid links)
[envG, envCd, envArea, envRho].forEach(el => {
  el.addEventListener('change', _applyGravity);
});
_applyGravity();

function _formatArrowScale(scale) {
  return `${Number(scale).toFixed(1)}×`;
}

function _syncForceArrowScaleUI(scale = getForceArrowScale()) {
  if (envArrowForceScale) {
    envArrowForceScale.value = String(scale);
    envArrowForceScale.setAttribute('aria-valuenow', String(scale));
  }
  if (envArrowForceScaleLabel) {
    envArrowForceScaleLabel.textContent = _formatArrowScale(scale);
  }
}

function _syncVelocityArrowScaleUI(scale = getVelocityArrowScale()) {
  if (envArrowVelScale) {
    envArrowVelScale.value = String(scale);
    envArrowVelScale.setAttribute('aria-valuenow', String(scale));
  }
  if (envArrowVelScaleLabel) {
    envArrowVelScaleLabel.textContent = _formatArrowScale(scale);
  }
}

function _applyForceArrowScale() {
  const raw = parseFloat(envArrowForceScale?.value ?? '1');
  const scale = setForceArrowScale(Number.isFinite(raw) ? raw : 1);
  _syncForceArrowScaleUI(scale);
}

function _applyVelocityArrowScale() {
  const raw = parseFloat(envArrowVelScale?.value ?? '1');
  const scale = setVelocityArrowScale(Number.isFinite(raw) ? raw : 1);
  _syncVelocityArrowScaleUI(scale);
}

envArrowForceScale?.addEventListener('input', _applyForceArrowScale);
envArrowVelScale?.addEventListener('input', _applyVelocityArrowScale);
_syncForceArrowScaleUI();
_syncVelocityArrowScaleUI();

// ── Velocity / force drag handle on SVG ───────────────────────────
// Tip offset: getVelocityPxPerMs() world px per 1 m/s, or getForcePxPerN() px per N.
// Double-click the tip to switch between v₀ and applied F (same tip, recolored).
// (SVG_NS, _velHandle, _draggingHandle declared with selection state above.)

const VECTOR_HANDLE_DBLCLICK_MS = 350;
const VECTOR_HANDLE_DRAG_PX = 4;

function _vectorHandleColor() {
  return _vectorHandleMode === 'force' ? FORCE_HANDLE_COLOR : VEL_HANDLE_COLOR;
}

function _applyVectorHandleChrome(group) {
  if (!group) return;
  const color = _vectorHandleColor();
  const isForce = _vectorHandleMode === 'force';
  const shaft = group.querySelector('#vel-handle-shaft');
  const lbl = group.querySelector('#vel-handle-lbl');
  const angleLbl = group.querySelector('#vel-handle-angle');
  const dot = group.querySelector('#vel-handle-dot');
  const hit = group.querySelector('#vel-handle-hit');
  if (shaft) shaft.setAttribute('stroke', color);
  if (lbl) {
    lbl.setAttribute('fill', color);
    lbl.textContent = isForce ? 'F' : 'v₀';
  }
  if (angleLbl) angleLbl.setAttribute('fill', color);
  if (dot) dot.setAttribute('fill', color);
  if (hit) {
    hit.removeAttribute('title');
  }
}

/**
 * Flip v₀ ↔ F, keeping the tip where it is (reinterprets px → the other quantity).
 * @param {import('matter-js').Body} body
 */
function _toggleVectorHandleMode(body) {
  const bx = body.position.x;
  const by = body.position.y;

  if (_vectorHandleMode === 'velocity') {
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const vPx = getVelocityPxPerMs();
    const fPx = getForcePxPerN();
    const tipX = bx + vxMs * vPx;
    const tipY = by - vyMs * vPx;
    const Fx = (tipX - bx) / fPx;
    const Fy = -(tipY - by) / fPx;
    const F = Math.hypot(Fx, Fy);
    const thetaDeg = F > 1e-9 ? Math.atan2(Fy, Fx) * 180 / Math.PI : 0;
    _vectorHandleMode = 'force';
    props.applyAppliedForce(body, F > 1e-6 ? F : 0, thetaDeg);
  } else {
    const af = getAppliedForce(body);
    const F = af?.F ?? 0;
    const rad = ((af?.thetaDeg ?? 0) * Math.PI) / 180;
    const vPx = getVelocityPxPerMs();
    const fPx = getForcePxPerN();
    const tipX = bx + F * Math.cos(rad) * fPx;
    const tipY = by - F * Math.sin(rad) * fPx;
    const vxMs = (tipX - bx) / vPx;
    const vyMs = -(tipY - by) / vPx;
    const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
    _vectorHandleMode = 'velocity';
    props.applyVelocity(body, vx, vy, { snapGrid: false });
  }

  if (_velHandle?.el) _applyVectorHandleChrome(_velHandle.el);
}

/** @returns {import('matter-js').Body|null} */
function _velHandleBody() {
  const id = _velHandle?.bodyId;
  if (id == null) return null;
  return engine.bodies.find(b => b.id === id) ?? null;
}

function _clientToWorldPx(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return camera.screenToWorld(clientX - rect.left, clientY - rect.top);
}

/** Screen-space radius for “drop on centre → clear” (stable across zoom). */
const VECTOR_ZERO_TIP_SCREEN_PX = 12;

/**
 * Write v₀ / F from a world-space tip. No mid-drag zero clamp: that made the
 * tip stick to the body while the pointer moved away.
 * @param {import('matter-js').Body} body
 * @param {{ x: number, y: number }} wpt
 * @param {{ snapGrid?: boolean, snapAngle?: boolean }} [opts]
 */
function _applyVectorHandleTip(body, wpt, opts = {}) {
  const bx = body.position.x;
  const by = body.position.y;
  const snapAngle = !!opts.snapAngle;
  const snapGrid = !!opts.snapGrid && !snapAngle;

  if (_vectorHandleMode === 'force') {
    const fPx = getForcePxPerN();
    let Fx = (wpt.x - bx) / fPx;
    let Fy = -(wpt.y - by) / fPx;
    if (snapAngle) {
      ({ vxMs: Fx, vyMs: Fy } = snapVelocityToAngle(Fx, Fy, {
        angle: true,
        speedStep: _snapEnabled ? 0.1 : null,
      }));
    } else if (snapGrid) {
      let tipX = snapWorldCoord(bx + Fx * fPx, true);
      let tipY = snapWorldCoord(by - Fy * fPx, true);
      Fx = (tipX - bx) / fPx;
      Fy = -(tipY - by) / fPx;
    }
    const F = Math.hypot(Fx, Fy);
    const thetaDeg = F > 1e-9 ? Math.atan2(Fy, Fx) * 180 / Math.PI : 0;
    props.applyAppliedForce(body, F > 1e-6 ? F : 0, thetaDeg);
    return;
  }

  const vPx = getVelocityPxPerMs();
  let vxMs = (wpt.x - bx) / vPx;
  let vyMs = -(wpt.y - by) / vPx;
  if (snapAngle) {
    ({ vxMs, vyMs } = snapVelocityToAngle(vxMs, vyMs, {
      angle: true,
      speedStep: _snapEnabled ? VELOCITY_SNAP_MS : null,
    }));
  }
  const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
  props.applyVelocity(body, vx, vy, { snapGrid });
}

function _unbindVelHandleWindowDrag() {
  window.removeEventListener('pointermove', _onVelHandleWindowMove);
  window.removeEventListener('pointerup', _onVelHandleWindowUp);
  window.removeEventListener('pointercancel', _onVelHandleWindowUp);
}

function _destroyVelHandle() {
  if (_draggingHandle) {
    _draggingHandle = false;
    _unbindVelHandleWindowDrag();
  }
  _velHandleAngleSnap = false;
  if (_velHandle) {
    _velHandle.el.remove();
    _velHandle = null;
  }
}

function _onVelHandleWindowMove(e) {
  if (!_draggingHandle || !_velHandle) return;
  if (!_velHandle.dragMoved) {
    const dx = e.clientX - _velHandle.downX;
    const dy = e.clientY - _velHandle.downY;
    if (dx * dx + dy * dy < VECTOR_HANDLE_DRAG_PX * VECTOR_HANDLE_DRAG_PX) return;
    _velHandle.dragMoved = true;
  }

  const body = _velHandleBody();
  if (!body) return;

  const wpt = _clientToWorldPx(e.clientX, e.clientY);
  _velHandle.dragTip = { x: wpt.x, y: wpt.y };
  _velHandleAngleSnap = e.ctrlKey;
  // Live drag follows the pointer exactly: snap / clear only on release.
  _applyVectorHandleTip(body, wpt, {
    snapGrid: false,
    snapAngle: _velHandleAngleSnap,
  });
}

function _onVelHandleWindowUp(e) {
  const wasDragging = _draggingHandle;
  const moved = _velHandle?.dragMoved;
  const tip = _velHandle?.dragTip ? { ..._velHandle.dragTip } : null;
  const body = _velHandleBody();
  const angleSnap = _velHandleAngleSnap;

  _draggingHandle = false;
  _velHandleAngleSnap = false;
  _unbindVelHandleWindowDrag();
  if (_velHandle) _velHandle.dragTip = null;

  if (!wasDragging || !body) return;

  if (moved && tip) {
    const bx = body.position.x;
    const by = body.position.y;
    const screenDist = Math.hypot(tip.x - bx, tip.y - by) * (camera.s || 1);
    if (screenDist <= VECTOR_ZERO_TIP_SCREEN_PX) {
      if (_vectorHandleMode === 'force') props.applyAppliedForce(body, 0, 0);
      else props.applyVelocity(body, 0, 0, { snapGrid: false });
    } else {
      _applyVectorHandleTip(body, tip, {
        snapGrid: !angleSnap && _snapEnabled,
        snapAngle: angleSnap,
      });
    }
    return;
  }

  // Click / double-click on the tip (no drag).
  if (!_velHandle) return;
  const now = performance.now();
  if (now - _velHandle.lastClickMs < VECTOR_HANDLE_DBLCLICK_MS) {
    _velHandle.lastClickMs = 0;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    _toggleVectorHandleMode(body);
  } else {
    _velHandle.lastClickMs = now;
  }
}

// Called every render frame
function _syncVelHandle() {
  const selId = _currentSelection?.type === 'body' ? _currentSelection.id : null;
  const body = selId
    ? engine.bodies.find(
        b => b.id === selId && !b.isStatic &&
          (b._newtonType === 'point-mass' || b._newtonType === 'ball' || b._newtonType === 'box' || b._newtonType === 'wedge'),
      )
    : null;

  if (!body || appMode === 'live') {
    _destroyVelHandle();
    return;
  }

  // Rebuild if the selected body changed
  if (_velHandle && _velHandle.bodyId !== body.id) {
    _destroyVelHandle();
  }

  if (!_velHandle) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.id = 'vel-handle';

    const shaft = document.createElementNS(SVG_NS, 'line');
    shaft.id = 'vel-handle-shaft';
    shaft.setAttribute('stroke-width', '1.2');
    shaft.setAttribute('stroke-dasharray', '4 3');
    shaft.setAttribute('pointer-events', 'none');
    group.appendChild(shaft);

    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.id = 'vel-handle-lbl';
    lbl.setAttribute('font-size', '9');
    lbl.setAttribute('font-family', FONT_DIAGRAM);
    lbl.setAttribute('font-style', 'italic');
    lbl.setAttribute('pointer-events', 'none');
    group.appendChild(lbl);

    const angleLbl = document.createElementNS(SVG_NS, 'text');
    angleLbl.id = 'vel-handle-angle';
    angleLbl.setAttribute('font-size', '9');
    angleLbl.setAttribute('font-family', FONT_DIAGRAM);
    angleLbl.setAttribute('pointer-events', 'none');
    group.appendChild(angleLbl);

    const hit = document.createElementNS(SVG_NS, 'circle');
    hit.id = 'vel-handle-hit';
    hit.setAttribute('r', '14');
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('cursor', 'crosshair');
    hit.setAttribute('pointer-events', 'auto');
    group.appendChild(hit);

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.id = 'vel-handle-dot';
    dot.setAttribute('r', '5');
    dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', '1.5');
    dot.setAttribute('pointer-events', 'none');
    group.appendChild(dot);

    _applyVectorHandleChrome(group);
    renderer.uiTopLayer.appendChild(group);
    _velHandle = {
      el: group,
      bodyId: body.id,
      lastClickMs: 0,
      dragMoved: false,
      downX: 0,
      downY: 0,
      /** @type {{ x: number, y: number }|null} */
      dragTip: null,
    };

    hit.addEventListener('pointerdown', e => {
      if (appMode === 'live') return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      _velHandle.downX = e.clientX;
      _velHandle.downY = e.clientY;
      _velHandle.dragMoved = false;
      _velHandle.dragTip = null;
      _pushHistory();
      _draggingHandle = true;
      _velHandleAngleSnap = e.ctrlKey;
      try { hit.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      // Window listeners keep tracking even if the tip races ahead of the hit target.
      _unbindVelHandleWindowDrag();
      window.addEventListener('pointermove', _onVelHandleWindowMove);
      window.addEventListener('pointerup', _onVelHandleWindowUp);
      window.addEventListener('pointercancel', _onVelHandleWindowUp);
    });
  }

  _applyVectorHandleChrome(_velHandle.el);

  const bx = body.position.x;
  const by = body.position.y;
  let tipX;
  let tipY;
  let angX;
  let angY;

  // While dragging, pin the tip to the pointer so the shaft never lags behind.
  if (_draggingHandle && _velHandle.dragTip) {
    tipX = _velHandle.dragTip.x;
    tipY = _velHandle.dragTip.y;
    if (_vectorHandleMode === 'force') {
      const fPx = getForcePxPerN();
      angX = (tipX - bx) / fPx;
      angY = -(tipY - by) / fPx;
    } else {
      const vPx = getVelocityPxPerMs();
      angX = (tipX - bx) / vPx;
      angY = -(tipY - by) / vPx;
    }
  } else if (_vectorHandleMode === 'force') {
    const af = getAppliedForce(body);
    const F = af?.F ?? 0;
    const rad = ((af?.thetaDeg ?? 0) * Math.PI) / 180;
    const Fx = F * Math.cos(rad);
    const Fy = F * Math.sin(rad);
    const fPx = getForcePxPerN();
    tipX = bx + Fx * fPx;
    tipY = by - Fy * fPx;
    angX = Fx;
    angY = Fy;
  } else {
    const { vxMs, vyMs } = matterVelToDisplayMS(body.velocity.x, body.velocity.y);
    const vPx = getVelocityPxPerMs();
    tipX = bx + vxMs * vPx;
    tipY = by - vyMs * vPx;
    angX = vxMs;
    angY = vyMs;
  }

  const shaftLen = Math.hypot(tipX - bx, tipY - by);
  const hasV = shaftLen > 1;
  const longEnough = shaftLen > 12;

  const dot = _velHandle.el.querySelector('#vel-handle-dot');
  const hit = _velHandle.el.querySelector('#vel-handle-hit');
  const shaft = _velHandle.el.querySelector('#vel-handle-shaft');
  const lbl = _velHandle.el.querySelector('#vel-handle-lbl');
  const angleLbl = _velHandle.el.querySelector('#vel-handle-angle');

  if (dot) { dot.setAttribute('cx', tipX); dot.setAttribute('cy', tipY); }
  if (hit) {
    hit.setAttribute('cx', tipX);
    hit.setAttribute('cy', tipY);
    hit.setAttribute('pointer-events', 'auto');
  }
  if (shaft) {
    shaft.setAttribute('x1', bx); shaft.setAttribute('y1', by);
    shaft.setAttribute('x2', tipX); shaft.setAttribute('y2', tipY);
    shaft.setAttribute('opacity', hasV ? '1' : '0.45');
  }
  if (lbl) {
    lbl.setAttribute('x', tipX + 6);
    lbl.setAttribute('y', tipY - 5);
    lbl.setAttribute('opacity', hasV ? '1' : '0.85');
  }
  if (angleLbl) {
    if (longEnough) {
      const degNum = Math.atan2(angY, angX) * 180 / Math.PI;
      const deg = _velHandleAngleSnap ? degNum.toFixed(0) : degNum.toFixed(1);
      angleLbl.textContent = _velHandleAngleSnap
        ? `${deg}° (${SNAP_ANGLE_STEP_5_DEG}° snap)`
        : `${deg}°`;
      const mx = (bx + tipX) / 2;
      const my = (by + tipY) / 2;
      const nx = -(tipY - by) / shaftLen;
      const ny = (tipX - bx) / shaftLen;
      angleLbl.setAttribute('x', (mx + nx * 8).toFixed(1));
      angleLbl.setAttribute('y', (my + ny * 8).toFixed(1));
      angleLbl.setAttribute('text-anchor', 'middle');
      angleLbl.setAttribute('opacity', '1');
    } else {
      angleLbl.setAttribute('opacity', '0');
    }
  }
}

function _updateSelHandlePositionsOnly() {
  if (!_selHandleG || !_currentSelection) return;
  if (_currentSelection.type === 'constraint') {
    const c = engine.constraints.find(x => x.id === _currentSelection.id);
    if (!c) return;
    const pa = constraintAnchorWorld(c, 'A');
    const pb = constraintAnchorWorld(c, 'B');
    const [ca, cb] = _selHandleG.querySelectorAll('circle');
    if (ca) { ca.setAttribute('cx', String(pa.x)); ca.setAttribute('cy', String(pa.y)); }
    if (cb) { cb.setAttribute('cx', String(pb.x)); cb.setAttribute('cy', String(pb.y)); }
    return;
  }
  if (_currentSelection.type === 'body') {
    const b = engine.bodies.find(x => x.id === _currentSelection.id && x._newtonType === 'ground');
    if (!b) return;
    const { L, R } = groundTopEdgeWorld(b);
    const [ca, cb] = _selHandleG.querySelectorAll('circle');
    if (ca) { ca.setAttribute('cx', String(L.x)); ca.setAttribute('cy', String(L.y)); }
    if (cb) { cb.setAttribute('cx', String(R.x)); cb.setAttribute('cy', String(R.y)); }
  }
  if (_currentSelection.type === 'rope') {
    const ropeId = _currentSelection.ropeId;
    const [ca, cb] = _selHandleG.querySelectorAll('circle');
    const nA = ropeEndNode(engine, ropeId, 'A');
    const nB = ropeEndNode(engine, ropeId, 'B');
    if (ca && nA) { ca.setAttribute('cx', String(nA.position.x)); ca.setAttribute('cy', String(nA.position.y)); }
    if (cb && nB) { cb.setAttribute('cx', String(nB.position.x)); cb.setAttribute('cy', String(nB.position.y)); }
  }
}

function _onSelHandleDocMove(e) {
  if (!_selHandleDrag) return;
  const rect = svg.getBoundingClientRect();
  const raw = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const ctrl = e.ctrlKey;
  if (_selHandleDrag.kind === 'constraint-length') {
    const c = engine.constraints.find(x => x.id === _selHandleDrag.cId);
    if (!c || !_selHandleDrag.axis) return;
    const result = stretchConstraintEndAlongAxis(c, _selHandleDrag.end, raw.x, raw.y, {
      axis: _selHandleDrag.axis,
      minLen: 5,
      snapGrid: _snapEnabled,
    });
    if (!result) return;
    _selHandleDrag.lastLength = result.length;
    const movedBody = _selHandleDrag.end === 'A' ? c.bodyA : c.bodyB;
    if (movedBody && _selHandleDrag.hangingChain) {
      applyHangingChainTranslation(_selHandleDrag.hangingChain, movedBody);
    }
    _updateSelHandlePositionsOnly();

    // Guide: dashed axis from pivot through new attach + live length label
    if (!_selHandleGhost) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('pointer-events', 'none');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke', '#2980b9');
      line.setAttribute('stroke-width', '1.25');
      line.setAttribute('stroke-dasharray', '5 4');
      line.setAttribute('opacity', '0.85');
      const tip = document.createElementNS(SVG_NS, 'circle');
      tip.setAttribute('r', c._newtonType === 'spring' ? '3.5' : '5');
      tip.setAttribute('fill', '#2980b9');
      tip.setAttribute('stroke', '#fff');
      tip.setAttribute('stroke-width', '1.25');
      tip.setAttribute('opacity', '0.95');
      const lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('fill', '#2980b9');
      lbl.setAttribute('font-size', '11');
      lbl.setAttribute('font-family', FONT_DIAGRAM);
      g.appendChild(line);
      g.appendChild(tip);
      g.appendChild(lbl);
      _selHandleGhost = g;
      _selHandleGhost._line = line;
      _selHandleGhost._tip = tip;
      _selHandleGhost._lbl = lbl;
      renderer.uiTopLayer.appendChild(g);
    }
    const { pivot, attach, length, axis } = result;
    const extend = Math.max(40, length + 24);
    _selHandleGhost._line.setAttribute('x1', String(pivot.x));
    _selHandleGhost._line.setAttribute('y1', String(pivot.y));
    _selHandleGhost._line.setAttribute('x2', String(pivot.x + axis.x * extend));
    _selHandleGhost._line.setAttribute('y2', String(pivot.y + axis.y * extend));
    _selHandleGhost._tip.setAttribute('cx', String(attach.x));
    _selHandleGhost._tip.setAttribute('cy', String(attach.y));
    _selHandleGhost._lbl.setAttribute('x', String(attach.x + axis.y * 10 + 6));
    _selHandleGhost._lbl.setAttribute('y', String(attach.y - axis.x * 10 - 4));
    _selHandleGhost._lbl.textContent = `${(length / PX_PER_M).toFixed(3)} m`;
  } else if (_selHandleDrag.kind === 'constraint') {
    const c = engine.constraints.find(x => x.id === _selHandleDrag.cId);
    if (!c) return;
    const otherBody = _selHandleDrag.end === 'A' ? c.bodyB : c.bodyA;
    const target = findConstraintAttachTarget(engine, raw.x, raw.y, {
      excludeConstraintId: c.id,
      excludeBodyId: otherBody?.id ?? null,
      hitPx: 32,
    });
    _selHandleDrag.hoverTarget = target;
    if (target) {
      setConstraintEndAttachment(c, _selHandleDrag.end, target.body, target.local);
    } else if (_selHandleDrag.orig) {
      // Keep last valid body attachment: never leave a free world end.
      setConstraintEndAttachment(
        c,
        _selHandleDrag.end,
        _selHandleDrag.orig.body,
        _selHandleDrag.orig.local,
      );
    }
    _updateSelHandlePositionsOnly();
    _syncAttachHoverHighlight(target?.body?.id ?? null);

    // Ghost follows the cursor until a valid attach target is under it.
    if (!_selHandleGhost) {
      _selHandleGhost = document.createElementNS(SVG_NS, 'circle');
      _selHandleGhost.setAttribute('r', c._newtonType === 'spring' ? '3.5' : '5');
      _selHandleGhost.setAttribute('fill', '#2980b9');
      _selHandleGhost.setAttribute('stroke', '#fff');
      _selHandleGhost.setAttribute('stroke-width', '1.25');
      _selHandleGhost.setAttribute('opacity', '0.55');
      _selHandleGhost.setAttribute('pointer-events', 'none');
      renderer.uiTopLayer.appendChild(_selHandleGhost);
    }
    const gx = target ? target.world.x : raw.x;
    const gy = target ? target.world.y : raw.y;
    _selHandleGhost.setAttribute('cx', String(gx));
    _selHandleGhost.setAttribute('cy', String(gy));
    _selHandleGhost.setAttribute('opacity', target ? '0.95' : '0.45');
  } else if (_selHandleDrag.kind === 'rope-end') {
    const ropeId = _selHandleDrag.ropeId;
    const other = getRopeEndAttachment(engine, ropeId, _selHandleDrag.end === 'A' ? 'B' : 'A');
    const target = findConstraintAttachTarget(engine, raw.x, raw.y, {
      excludeBodyId: other?.body?.id ?? null,
      hitPx: 32,
    });
    const attached = target
      ? setRopeEndAttachment(engine, ropeId, _selHandleDrag.end, target.body, target.local)
      : false;
    if (!attached) {
      _selHandleDrag.hoverTarget = null;
      setRopeEndAttachment(engine, ropeId, _selHandleDrag.end, null);
      const node = ropeEndNode(engine, ropeId, _selHandleDrag.end);
      if (node) {
        Body.setPosition(node, { x: raw.x, y: raw.y });
        Body.setVelocity(node, { x: 0, y: 0 });
      }
    } else {
      _selHandleDrag.hoverTarget = target;
    }
    snapRopePins(engine);
    _updateSelHandlePositionsOnly();
    _syncAttachHoverHighlight(attached ? target.body.id : null);
    if (!_selHandleGhost) {
      _selHandleGhost = document.createElementNS(SVG_NS, 'circle');
      _selHandleGhost.setAttribute('r', '5');
      _selHandleGhost.setAttribute('fill', '#2980b9');
      _selHandleGhost.setAttribute('stroke', '#fff');
      _selHandleGhost.setAttribute('stroke-width', '1.5');
      _selHandleGhost.setAttribute('opacity', '0.55');
      _selHandleGhost.setAttribute('pointer-events', 'none');
      renderer.uiTopLayer.appendChild(_selHandleGhost);
    }
    const gx = attached ? target.world.x : raw.x;
    const gy = attached ? target.world.y : raw.y;
    _selHandleGhost.setAttribute('cx', String(gx));
    _selHandleGhost.setAttribute('cy', String(gy));
    _selHandleGhost.setAttribute('opacity', attached ? '0.95' : '0.45');
  } else if (_selHandleDrag.kind === 'ground') {
    const d = _selHandleDrag;
    const out = snapSegmentFromStart(d.fix.x, d.fix.y, raw.x, raw.y, _snapEnabled, ctrl);
    const Lw = d.moving === 'L' ? { x: out.x, y: out.y } : { ...d.fix };
    const Rw = d.moving === 'R' ? { x: out.x, y: out.y } : { ...d.fix };
    d._Lw = Lw;
    d._Rw = Rw;
    if (_selHandleGhost) {
      _selHandleGhost.setAttribute('x1', String(Lw.x));
      _selHandleGhost.setAttribute('y1', String(Lw.y));
      _selHandleGhost.setAttribute('x2', String(Rw.x));
      _selHandleGhost.setAttribute('y2', String(Rw.y));
    }
    _updateSelHandlePositionsOnly();
  }
}

function _syncAttachHoverHighlight(bodyId) {
  svg.querySelectorAll('.body-group').forEach(g => {
    const id = parseInt(g.id.replace('body-', ''), 10);
    g.classList.toggle('hover-target', bodyId != null && id === bodyId);
  });
}

function _onSelHandleDocUp() {
  document.removeEventListener('pointermove', _onSelHandleDocMove, true);
  document.removeEventListener('pointerup', _onSelHandleDocUp, true);
  const drag = _selHandleDrag;
  _selHandleDrag = null;
  _syncAttachHoverHighlight(null);
  if (_selHandleGhost) {
    _selHandleGhost.remove();
    _selHandleGhost = null;
  }
  if (drag?.kind === 'constraint-length') {
    _updateSelHandlePositionsOnly();
    return;
  }
  if (drag?.kind === 'constraint') {
    const c = engine.constraints.find(x => x.id === drag.cId);
    if (!c || !drag.orig) return;
    // Must snap to a body/constraint end, otherwise restore the prior attachment.
    if (!drag.hoverTarget) {
      setConstraintEndAttachment(c, drag.end, drag.orig.body, drag.orig.local);
      if (!isSpringConstraintLike(c) && drag.orig.length != null) {
        c.length = drag.orig.length;
      }
    }
    _updateSelHandlePositionsOnly();
    return;
  }
  if (drag?.kind === 'rope-end') {
    const ropeId = drag.ropeId;
    if (!ropeId) return;
    // Empty space detaches (allowed for ropes). Snap to a body if hovered.
    if (drag.hoverTarget) {
      setRopeEndAttachment(engine, ropeId, drag.end, drag.hoverTarget.body, drag.hoverTarget.local);
    } else {
      setRopeEndAttachment(engine, ropeId, drag.end, null);
    }
    snapRopePins(engine);
    _updateSelHandlePositionsOnly();
    props.show(_currentSelection);
    objectBrowser?.scheduleRefresh();
    return;
  }
  if (drag?.kind === 'ground') {
    const b = engine.bodies.find(x => x.id === drag.bodyId);
    if (!b || !drag._Lw || !drag._Rw) return;
    const neo = replaceGroundFromTopEdge(engine, b, drag._Lw, drag._Rw);
    if (neo) {
      _shBuildKey = '';
      _onSandboxSelect({ type: 'body', id: neo.id });
    }
  }
}

function isSpringConstraintLike(c) {
  return c?._newtonType === 'spring';
}

function _onConHandleDown(e) {
  if (appMode !== 'setup') return;
  e.stopPropagation();
  e.preventDefault();
  const cId = parseInt(e.currentTarget.getAttribute('data-conid'), 10);
  const end = e.currentTarget.getAttribute('data-end');
  const c = engine.constraints.find(x => x.id === cId);
  if (!c) return;
  const body = end === 'A' ? c.bodyA : c.bodyB;
  if (!body) return; // free ends are not editable: both ends must be attached
  const local = end === 'A'
    ? { ...(c.pointA ?? { x: 0, y: 0 }) }
    : { ...(c.pointB ?? { x: 0, y: 0 }) };
  _pushHistory();

  // Circle/box ends: stretch length along the constraint axis (move the body).
  // Anchor/ground ends: keep reattach behaviour.
  if (isConstraintLengthStretchBody(body)) {
    const otherEnd = end === 'A' ? 'B' : 'A';
    const pivot = constraintAnchorWorld(c, otherEnd);
    const here = constraintAnchorWorld(c, end);
    let dx = here.x - pivot.x;
    let dy = here.y - pivot.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 0;
      dy = 1;
      len = 1;
    }
    _selHandleDrag = {
      kind: 'constraint-length',
      cId,
      end,
      axis: { x: dx / len, y: dy / len },
      orig: { body, local, length: c.length },
      lastLength: c.length,
      hangingChain: captureHangingChain(engine, body),
    };
  } else {
    _selHandleDrag = {
      kind: 'constraint',
      cId,
      end,
      orig: { body, local, length: c.length },
      hoverTarget: null,
    };
  }
  document.addEventListener('pointermove', _onSelHandleDocMove, true);
  document.addEventListener('pointerup', _onSelHandleDocUp, true);
}

function _onRopeHandleDown(e) {
  if (appMode !== 'setup') return;
  e.stopPropagation();
  e.preventDefault();
  const ropeId = e.currentTarget.getAttribute('data-rope-id');
  const end = e.currentTarget.getAttribute('data-end');
  if (!ropeId || (end !== 'A' && end !== 'B')) return;
  const host = getRopeEndAttachment(engine, ropeId, end);
  _pushHistory();
  _selHandleDrag = {
    kind: 'rope-end',
    ropeId,
    end,
    orig: host ? { body: host.body, local: { ...(host.local ?? { x: 0, y: 0 }) } } : null,
    hoverTarget: host ? { body: host.body, local: host.local, world: null } : null,
  };
  document.addEventListener('pointermove', _onSelHandleDocMove, true);
  document.addEventListener('pointerup', _onSelHandleDocUp, true);
}

function _onGroundHandleDown(e) {
  if (appMode !== 'setup') return;
  e.stopPropagation();
  e.preventDefault();
  const bodyId = parseInt(e.currentTarget.getAttribute('data-bid'), 10);
  const end = e.currentTarget.getAttribute('data-end');
  const b = engine.bodies.find(x => x.id === bodyId);
  if (!b || b._newtonType !== 'ground') return;
  const { L, R } = groundTopEdgeWorld(b);
  const fix = end === 'L' ? { ...R } : { ...L };
  _pushHistory();
  _selHandleDrag = { kind: 'ground', bodyId, moving: end, fix, _Lw: { ...L }, _Rw: { ...R } };
  _selHandleGhost = document.createElementNS(SVG_NS, 'line');
  _selHandleGhost.setAttribute('stroke', '#2980b9');
  _selHandleGhost.setAttribute('stroke-width', '2');
  _selHandleGhost.setAttribute('stroke-dasharray', '5 4');
  _selHandleGhost.setAttribute('pointer-events', 'none');
  renderer.uiTopLayer.appendChild(_selHandleGhost);
  _onSelHandleDocMove(e);
  document.addEventListener('pointermove', _onSelHandleDocMove, true);
  document.addEventListener('pointerup', _onSelHandleDocUp, true);
}

function _buildSelHandles(key) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.id = 'selection-edit-handles';
  renderer.uiTopLayer.appendChild(group);
  _selHandleG = group;

  if (key.startsWith('c:')) {
    const id = parseInt(key.slice(2), 10);
    const c = engine.constraints.find(x => x.id === id);
    // Springs use smaller reattach dots, rods/strings a bit larger for grab.
    const r = c?._newtonType === 'spring' ? '3.5' : '5';
    const strokeW = c?._newtonType === 'spring' ? '1.25' : '1.5';
    for (const end of ['A', 'B']) {
      const body = end === 'A' ? c?.bodyA : c?.bodyB;
      if (!body) continue; // free ends are not shown / not editable
      const circ = document.createElementNS(SVG_NS, 'circle');
      circ.setAttribute('r', r);
      circ.setAttribute('fill', '#2980b9');
      circ.setAttribute('stroke', '#fff');
      circ.setAttribute('stroke-width', strokeW);
      // Stretch handles: axis-aligned resize cursor, reattach: crosshair
      if (isConstraintLengthStretchBody(body) && c) {
        const other = end === 'A' ? constraintAnchorWorld(c, 'B') : constraintAnchorWorld(c, 'A');
        const here = constraintAnchorWorld(c, end);
        const ax = Math.abs(here.x - other.x);
        const ay = Math.abs(here.y - other.y);
        circ.setAttribute('cursor', ax >= ay ? 'ew-resize' : 'ns-resize');
      } else {
        circ.setAttribute('cursor', 'crosshair');
      }
      circ.setAttribute('data-sel-handle', '1');
      circ.setAttribute('data-end', end);
      circ.setAttribute('data-conid', String(id));
      circ.addEventListener('pointerdown', _onConHandleDown);
      group.appendChild(circ);
    }
  } else if (key.startsWith('rope:')) {
    const ropeId = key.slice(5);
    for (const end of ['A', 'B']) {
      const circ = document.createElementNS(SVG_NS, 'circle');
      circ.setAttribute('r', '5');
      circ.setAttribute('fill', '#2980b9');
      circ.setAttribute('stroke', '#fff');
      circ.setAttribute('stroke-width', '1.5');
      circ.setAttribute('cursor', 'crosshair');
      circ.setAttribute('data-sel-handle', '1');
      circ.setAttribute('data-end', end);
      circ.setAttribute('data-rope-id', ropeId);
      circ.addEventListener('pointerdown', _onRopeHandleDown);
      group.appendChild(circ);
    }
  } else if (key.startsWith('g:')) {
    const id = parseInt(key.slice(2), 10);
    for (const end of ['L', 'R']) {
      const circ = document.createElementNS(SVG_NS, 'circle');
      circ.setAttribute('r', '7');
      circ.setAttribute('fill', '#2980b9');
      circ.setAttribute('stroke', '#fff');
      circ.setAttribute('stroke-width', '2');
      circ.setAttribute('cursor', 'crosshair');
      circ.setAttribute('data-sel-handle', '1');
      circ.setAttribute('data-end', end);
      circ.setAttribute('data-bid', String(id));
      circ.addEventListener('pointerdown', _onGroundHandleDown);
      group.appendChild(circ);
    }
  }
}

function _syncSelectionHandles() {
  if (interaction.mode === 'camera' || appMode === 'live') {
    if (!_selHandleDrag) _clearSelectionEditHandles();
    return;
  }
  if (_selHandleDrag) {
    _updateSelHandlePositionsOnly();
    return;
  }

  let key = '';
  if (_currentSelection?.type === 'constraint') {
    key = `c:${_currentSelection.id}`;
  } else if (_currentSelection?.type === 'body') {
    const b = engine.bodies.find(x => x.id === _currentSelection.id);
    if (b?._newtonType === 'ground') key = `g:${b.id}`;
  } else if (_currentSelection?.type === 'rope' && _currentSelection.ropeId) {
    key = `rope:${_currentSelection.ropeId}`;
  }

  if (!key) {
    _clearSelectionEditHandles();
    _shBuildKey = '';
    return;
  }

  if (key !== _shBuildKey) {
    _clearSelectionEditHandles();
    _shBuildKey = key;
    _buildSelHandles(key);
  }
  _updateSelHandlePositionsOnly();
}

// ── Scale tool handles (box side lengths / circle radius) ─────────

function _bodyWorldToLocal(body, wx, wy) {
  const dx = wx - body.position.x;
  const dy = wy - body.position.y;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

function _boxScaleHandleWorld(body, edge) {
  const w = body._width ?? 40;
  const h = body._height ?? 40;
  let lx = 0;
  let ly = 0;
  if (edge === 'R') lx = w / 2;
  else if (edge === 'L') lx = -w / 2;
  else if (edge === 'T') ly = -h / 2;
  else if (edge === 'B') ly = h / 2;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: body.position.x + c * lx - s * ly,
    y: body.position.y + s * lx + c * ly,
  };
}

function _circleScaleHandleWorld(body) {
  const r = body._radius ?? body.circleRadius ?? 20;
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: body.position.x + c * r,
    y: body.position.y + s * r,
  };
}

function _scaleHandleWorldPt(e) {
  const rect = svg.getBoundingClientRect();
  return camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
}

function _wedgeScaleHandleWorld(body, edge) {
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const loc = wedgeScaleHandleLocal(W, H, edge);
  const aabb = wedgeAABBCenterWorld(body);
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  return {
    x: aabb.x + c * loc.x - s * loc.y,
    y: aabb.y + s * loc.x + c * loc.y,
  };
}

function _scaleHandleWorldForBody(body, kind, edge) {
  if (kind === 'circle') return _circleScaleHandleWorld(body);
  if (kind === 'wedge') return _wedgeScaleHandleWorld(body, edge);
  return _boxScaleHandleWorld(body, edge);
}

function _updateScaleHandlePositionsOnly() {
  if (!_scaleHandleG || !_currentSelection) return;
  const b = engine.bodies.find(x => x.id === _currentSelection.id);
  if (!b) return;
  for (const h of _scaleHandleG.querySelectorAll('[data-scale-handle]')) {
    const edge = h.getAttribute('data-edge');
    const kind = h.getAttribute('data-scale-kind');
    const p = _scaleHandleWorldForBody(b, kind, edge);
    h.setAttribute('cx', String(p.x));
    h.setAttribute('cy', String(p.y));
  }
}

function _buildScaleHandles(key) {
  const [kind, idStr] = key.split(':');
  const id = parseInt(idStr, 10);
  const body = engine.bodies.find(b => b.id === id);
  if (!body) return;

  const group = document.createElementNS(SVG_NS, 'g');
  group.id = 'scale-edit-handles';
  renderer.uiTopLayer.appendChild(group);
  _scaleHandleG = group;

  const mkHandle = (edge, cursor) => {
    const circ = document.createElementNS(SVG_NS, 'circle');
    circ.setAttribute('r', '6');
    circ.setAttribute('fill', '#2980b9');
    circ.setAttribute('stroke', '#fff');
    circ.setAttribute('stroke-width', '1.5');
    circ.setAttribute('cursor', cursor);
    circ.setAttribute('data-scale-handle', '1');
    circ.setAttribute('data-scale-kind', kind);
    circ.setAttribute('data-bid', String(id));
    circ.setAttribute('data-edge', edge);
    circ.addEventListener('pointerdown', _onScaleHandleDown);
    group.appendChild(circ);
  };

  if (kind === 'box') {
    mkHandle('R', 'ew-resize');
    mkHandle('L', 'ew-resize');
    mkHandle('T', 'ns-resize');
    mkHandle('B', 'ns-resize');
  } else if (kind === 'wedge') {
    mkHandle('W', 'ew-resize');
    mkHandle('H', 'ns-resize');
  } else {
    mkHandle('R', 'ew-resize');
  }
}

function _onScaleHandleDown(e) {
  if (appMode !== 'setup') return;
  e.stopPropagation();
  e.preventDefault();
  const bodyId = parseInt(e.currentTarget.getAttribute('data-bid'), 10);
  const kind = e.currentTarget.getAttribute('data-scale-kind');
  const edge = e.currentTarget.getAttribute('data-edge');
  const body = engine.bodies.find(b => b.id === bodyId);
  if (!body) return;
  _pushHistory();
  _scaleHandleDrag = { kind, bodyId, edge };

  _scaleHandleGhost = document.createElementNS(SVG_NS, 'g');
  _scaleHandleGhost.setAttribute('pointer-events', 'none');
  renderer.uiTopLayer.appendChild(_scaleHandleGhost);

  _onScaleHandleDocMove(e);
  document.addEventListener('pointermove', _onScaleHandleDocMove, true);
  document.addEventListener('pointerup', _onScaleHandleDocUp, true);
}

function _clearScaleGhostContents() {
  if (!_scaleHandleGhost) return;
  while (_scaleHandleGhost.firstChild) _scaleHandleGhost.removeChild(_scaleHandleGhost.firstChild);
}

/** Size readout next to the body centre (non-Ctrl scale). */
function _setScaleGhostSizeLabel(body, text) {
  _clearScaleGhostContents();
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(body.position.x + 12));
  t.setAttribute('y', String(body.position.y - 14));
  t.setAttribute('fill', '#333');
  t.setAttribute('font-size', '11');
  t.setAttribute('font-family', FONT_DIAGRAM);
  t.textContent = text;
  _scaleHandleGhost.appendChild(t);
}

/**
 * Textbook-style angle mark (arc + degree) at a wedge vertex.
 * @param {'foot'|'top'} which
 */
function _setScaleGhostAngleMark(body, which) {
  _clearScaleGhostContents();
  const { bl, br, tl } = wedgeTriangleWorldVerts(body);
  const W = body._baseWidth ?? 40;
  const H = body._height ?? 40;
  const vertex = which === 'foot' ? br : tl;
  const pA = bl;
  const pB = which === 'foot' ? tl : br;
  const deg = which === 'foot'
    ? (body._footAngle * 180 / Math.PI)
    : (Math.atan2(W, H) * 180 / Math.PI);

  let dx0 = pA.x - vertex.x, dy0 = pA.y - vertex.y;
  let dx1 = pB.x - vertex.x, dy1 = pB.y - vertex.y;
  const l0 = Math.hypot(dx0, dy0);
  const l1 = Math.hypot(dx1, dy1);
  if (l0 < 1e-6 || l1 < 1e-6) return;
  dx0 /= l0; dy0 /= l0;
  dx1 /= l1; dy1 /= l1;

  const r = Math.max(12, Math.min(34, 0.24 * Math.min(W, H)));
  const x0 = vertex.x + dx0 * r;
  const y0 = vertex.y + dy0 * r;
  const x1 = vertex.x + dx1 * r;
  const y1 = vertex.y + dy1 * r;
  const cross = dx0 * dy1 - dy0 * dx1;
  const sweep = cross > 0 ? 1 : 0;

  const arc = document.createElementNS(SVG_NS, 'path');
  arc.setAttribute('d', `M ${x0} ${y0} A ${r} ${r} 0 0 ${sweep} ${x1} ${y1}`);
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', COLORS.ink);
  arc.setAttribute('stroke-width', '1.25');
  arc.setAttribute('stroke-linecap', 'round');
  _scaleHandleGhost.appendChild(arc);

  let bx = dx0 + dx1;
  let by = dy0 + dy1;
  const blen = Math.hypot(bx, by);
  if (blen < 1e-6) return;
  bx /= blen; by /= blen;
  const labelR = r + Math.max(11, r * 0.38);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(vertex.x + bx * labelR));
  t.setAttribute('y', String(vertex.y + by * labelR));
  t.setAttribute('fill', COLORS.ink);
  t.setAttribute('font-size', '12');
  t.setAttribute('font-family', FONT_DIAGRAM);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'middle');
  t.textContent = `${deg.toFixed(0)}°`;
  _scaleHandleGhost.appendChild(t);
}

function _onScaleHandleDocMove(e) {
  if (!_scaleHandleDrag) return;
  const body = engine.bodies.find(b => b.id === _scaleHandleDrag.bodyId);
  if (!body) return;
  const pt = _scaleHandleWorldPt(e);
  const loc = _bodyWorldToLocal(body, pt.x, pt.y);
  const snap = _snapEnabled;
  const minHalf = 4;
  const ctrl = e.ctrlKey;

  if (_scaleHandleDrag.kind === 'box') {
    let nw = body._width ?? 40;
    let nh = body._height ?? 40;
    const edge = _scaleHandleDrag.edge;
    if (edge === 'R') nw = 2 * Math.max(minHalf, loc.x);
    else if (edge === 'L') nw = 2 * Math.max(minHalf, -loc.x);
    else if (edge === 'T') nh = 2 * Math.max(minHalf, -loc.y);
    else if (edge === 'B') nh = 2 * Math.max(minHalf, loc.y);
    if (snap) {
      nw = snapWorldCoord(nw, true);
      nh = snapWorldCoord(nh, true);
    }
    scaleBoxTo(body, nw, nh);
    if (_scaleHandleGhost) {
      _setScaleGhostSizeLabel(body,
        `${pxToM(body._width).toFixed(2)} × ${pxToM(body._height).toFixed(2)} m`);
    }
  } else if (_scaleHandleDrag.kind === 'wedge') {
    let W = body._baseWidth ?? 40;
    let H = body._height ?? 40;
    const edge = _scaleHandleDrag.edge;
    const loc = worldToWedgeAABBLocal(body, pt.x, pt.y);
    if (ctrl) {
      // Same pin as normal drag, but snap the angle at the opposite handle (5°).
      if (edge === 'W') {
        // Pin left, snap top ∠ (near H handle): β = atan(W/H), keep H.
        const Wraw = Math.max(minHalf * 2, loc.x + W / 2);
        let beta = clampWedgeFootAngle(Math.atan2(Wraw, H));
        beta = clampWedgeFootAngle(snapAngleRad(beta, true));
        W = Math.max(minHalf * 2, H * Math.tan(beta));
        scaleWedgeTo(body, W, H, { pin: 'left' });
        if (_scaleHandleGhost) _setScaleGhostAngleMark(body, 'top');
      } else {
        // Pin bottom, snap foot ∠ (near W handle): α = atan(H/W), keep W.
        const Hraw = Math.max(minHalf * 2, H / 2 - loc.y);
        let alpha = clampWedgeFootAngle(Math.atan2(Hraw, W));
        alpha = clampWedgeFootAngle(snapAngleRad(alpha, true));
        H = Math.max(minHalf * 2, W * Math.tan(alpha));
        scaleWedgeTo(body, W, H, { pin: 'bottom' });
        if (_scaleHandleGhost) _setScaleGhostAngleMark(body, 'foot');
      }
    } else if (edge === 'W') {
      // Grow/shrink base, keep the opposite (vertical) edge fixed.
      W = Math.max(minHalf * 2, loc.x + W / 2);
      if (snap) W = snapWorldCoord(W, true);
      scaleWedgeTo(body, W, H, { pin: 'left' });
      if (_scaleHandleGhost) {
        _setScaleGhostSizeLabel(body,
          `${pxToM(body._baseWidth).toFixed(2)} × ${pxToM(body._height).toFixed(2)} m`);
      }
    } else if (edge === 'H') {
      // Grow/shrink height, keep the opposite (base) edge fixed.
      H = Math.max(minHalf * 2, H / 2 - loc.y);
      if (snap) H = snapWorldCoord(H, true);
      scaleWedgeTo(body, W, H, { pin: 'bottom' });
      if (_scaleHandleGhost) {
        _setScaleGhostSizeLabel(body,
          `${pxToM(body._baseWidth).toFixed(2)} × ${pxToM(body._height).toFixed(2)} m`);
      }
    }
  } else {
    let r = Math.hypot(loc.x, loc.y);
    if (snap) r = Math.max(4, snapWorldCoord(r, true));
    scaleCircleTo(body, r);
    if (_scaleHandleGhost) {
      _setScaleGhostSizeLabel(body, `r = ${pxToM(body._radius).toFixed(2)} m`);
    }
  }
  _updateScaleHandlePositionsOnly();
}

function _onScaleHandleDocUp() {
  document.removeEventListener('pointermove', _onScaleHandleDocMove, true);
  document.removeEventListener('pointerup', _onScaleHandleDocUp, true);
  _scaleHandleDrag = null;
  if (_scaleHandleGhost) {
    _scaleHandleGhost.remove();
    _scaleHandleGhost = null;
  }
  _updateScaleHandlePositionsOnly();
}

function _syncScaleHandles() {
  if (appMode !== 'setup' || interaction.mode !== 'scale') {
    if (!_scaleHandleDrag) {
      _clearScaleHandles();
      _scaleBuildKey = '';
    }
    return;
  }
  if (_scaleHandleDrag) {
    _updateScaleHandlePositionsOnly();
    return;
  }

  let key = '';
  if (_currentSelection?.type === 'body') {
    const b = engine.bodies.find(x => x.id === _currentSelection.id);
    if (b?._newtonType === 'box') key = `box:${b.id}`;
    else if (b?._newtonType === 'point-mass') key = `circle:${b.id}`;
    else if (b?._newtonType === 'wedge') key = `wedge:${b.id}`;
  }

  if (!key) {
    _clearScaleHandles();
    _scaleBuildKey = '';
    return;
  }

  if (key !== _scaleBuildKey) {
    _clearScaleHandles();
    _scaleBuildKey = key;
    _buildScaleHandles(key);
  }
  _updateScaleHandlePositionsOnly();
}

/** Apply environment toggles after loading a scene (gravity / air drag). */
function _readEnvironmentFromUI() {
  return {
    gravity: {
      enabled: envGravityToggle.checked,
      g: parseFloat(envG.value) || 9.81,
    },
    air: {
      enabled: _airEnabled,
      cd: parseFloat(envCd.value) || 0.47,
      area: parseFloat(envArea.value) || 0.045,
      rho: parseFloat(envRho.value) || 1.225,
    },
  };
}

function _applyEnvironmentFromScene(env) {
  if (!env) return;
  envGravityToggle.checked = env.gravity?.enabled ?? true;
  envG.value = env.gravity?.g ?? 9.81;
  _syncGravityRowUI();
  _applyGravity();

  envAirToggle.checked = env.air?.enabled ?? false;
  _airEnabled = env.air?.enabled ?? false;
  if (env.air) {
    envCd.value = env.air.cd ?? 0.47;
    envArea.value = env.air.area ?? 0.045;
    envRho.value = env.air.rho ?? 1.225;
  }
  _syncAirRowsUI();
}

function _updateSceneResetButton() {
  if (!btnSceneReset) return;
  const hasBaseline = !!_sceneBaseline;
  btnSceneReset.disabled = !hasBaseline;
  const label = hasBaseline
    ? `Reset to "${_sceneSource?.name ?? 'loaded scene'}"`
    : 'Reset scene';
  btnSceneReset.title = label;
  btnSceneReset.setAttribute('aria-label', label);
}

function _finishSceneLoad(source) {
  renderer.clearTraces();
  recorder.clear();
  _destroyVelHandle();
  _clearSelectionEditHandles();
  renderer.render();
  playback.stop();
  tlScrubber.value = 0; tlScrubber.max = 0;
  _updateFill(0);
  tlFrameCount.textContent  = '0 fr';
  tlTimeDisplay.textContent = '0.000 s';
  simTimeEl.textContent     = 't = 0.000 s';
  btnExportSvg.disabled = true;
  btnExportMp4.disabled = true;
  setMode('setup');
  _updateMainTransportButton();
  _updateSceneResetButton();
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

  if (environment) _applyEnvironmentFromScene(environment);

  // Camera framing from scene doc, or default metric-basis view.
  const bodyByLabel = new Map(
    engine.bodies.filter(b => typeof b.label === 'string').map(b => [b.label, b]),
  );
  if (camDoc?.center) {
    cameraRig.loadFromSceneDoc(camDoc, bodyByLabel);
    _whenViewReady(() => {
      _syncCameraOverlaySize();
      _applyCameraRig();
    });
  } else {
    const scale = (typeof camDoc?.s === 'number' && Number.isFinite(camDoc.s)) ? camDoc.s : DEFAULT_CAMERA_SCALE;
    _frameMetricBasisWhenReady(scale, 0, () => {
      const { width, height } = _viewSize();
      cameraRig.syncFromCamera(camera, width, height);
      _syncCameraOverlaySize();
    });
  }

  if (storeBaseline) {
    _sceneBaseline = cloneSceneDocument(doc);
    _sceneSource = {
      type: source.type === 'reset' ? (_sceneSource?.type ?? 'blank') : source.type,
      name: source.name,
      demoId: source.demoId ?? (source.type === 'reset' ? _sceneSource?.demoId : undefined),
    };
  }

  _finishSceneLoad(source);
  _clearSelectionAfterLoad();
}

function _loadBlankScene() {
  const doc = buildBlankScene();
  _loadSceneDocument(doc, { type: 'blank', name: doc.meta?.name ?? 'Untitled scene' });
}

function _resetScene() {
  if (!_sceneBaseline) return;
  _loadSceneDocument(
    cloneSceneDocument(_sceneBaseline),
    {
      type: 'reset',
      name: _sceneSource?.name ?? 'Scene',
      demoId: _sceneSource?.demoId,
    },
    { storeBaseline: false },
  );
}

function _exportSceneJSON() {
  const doc = serializeScene(engine, {
    meta: {
      name: _sceneSource?.name ?? 'Scene',
      source: _sceneSource?.type ?? 'editor',
    },
    environment: _readEnvironmentFromUI(),
    camera: cameraRig.toSceneDoc(),
    measurements: measurements.toScene(),
    labels: labels.toScene(),
  });
  const slug = (doc.meta?.name ?? 'scene').replace(/[^\w\-]+/g, '-').toLowerCase();
  downloadSceneJSON(doc, `${slug}.json`);
}

async function _importSceneJSON() {
  const result = await pickAndLoadSceneFile();
  if (!result.ok) {
    if (result.error !== 'No file selected.') {
      alert(result.error);
    }
    return;
  }
  _loadSceneDocument(result.doc, {
    type: 'file',
    name: result.doc.meta?.name ?? 'Imported scene',
  });
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
  _importSceneJSON();
});

btnSceneSave?.addEventListener('click', () => {
  _closePresetMenu();
  _exportSceneJSON();
});

btnSceneReset?.addEventListener('click', () => {
  _resetScene();
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
    _syncCameraOverlaySize();
    cameraOverlay.setActive(true);
    cameraOverlay.sync();
    props.showCamera(cameraRig, _onCameraRigChanged);
  } else {
    cameraOverlay.setActive(false);
    _endCameraViewPan();
    cameraOverlaySvg?.classList.remove('camera-pan-ready', 'camera-pan-active');
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
