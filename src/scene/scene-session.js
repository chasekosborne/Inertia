/**
 * Scene session: what "the current scene" is, and the file / checkpoint
 * operations around it.
 *
 * Holds two pieces of state the rest of the app reads:
 *
 *   baseline — the document Reset restores to. Set on load, and re-set by
 *              Ctrl+S, which captures the live setup *without* writing a file.
 *   source   — where that baseline came from (blank / file / demo) and its
 *              display name, used for window titles and the Reset tooltip.
 *
 * Loading is deliberately not here: it touches most of the app, so it stays in
 * the controller and calls back in through `loadDocument`.
 */

import { serializeScene, cloneSceneDocument } from './serialize.js';
import { validateSceneDocument } from './validate.js';
import { downloadSceneJSON, pickAndLoadSceneFile } from './io.js';
import { showToolbarToast } from '../ui/toast.js';

/** Smallest viewport we trust for capturing the camera framing (px). */
const MIN_VIEW_PX = 2;

/** @param {string} name */
function filenameSlug(name) {
  return (name ?? 'scene').replace(/[^\w\-]+/g, '-').toLowerCase();
}

export class SceneSession {
  /**
   * @param {object} deps
   * @param {import('../physics/engine.js').PhysicsEngine} deps.engine
   * @param {object} deps.camera
   * @param {object} deps.cameraRig
   * @param {{ toScene: () => object[] }} deps.measurements
   * @param {{ toScene: () => object[] }} deps.labels
   * @param {{ readScene: () => object }} deps.environmentPanel
   * @param {HTMLButtonElement|null} deps.resetButton
   * @param {() => string} deps.getToolMode
   * @param {() => { width: number, height: number }} deps.getViewSize
   * @param {(doc: object, source: object, opts?: object) => void} deps.loadDocument
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {import('./schema.js').SceneDocument|null} */
    this._baseline = null;
    /** @type {{ type: string, name: string, demoId?: string }|null} */
    this._source = null;
    this.updateResetButton();
  }

  // ─── State ───────────────────────────────────────────────────────

  /** The document Reset restores to, or null before the first load. */
  get baseline() {
    return this._baseline;
  }

  get source() {
    return this._source;
  }

  /** Display name for the current scene, or null. */
  get name() {
    return this._source?.name ?? this._baseline?.meta?.name ?? null;
  }

  /** Camera zoom stored with the baseline, or null (used by reset-view). */
  get baselineCameraScale() {
    const scale = this._baseline?.camera?.s;
    return typeof scale === 'number' && Number.isFinite(scale) ? scale : null;
  }

  /**
   * A clone of the baseline with the live measurement set patched in, so graph
   * sweeps stay in step with overlays added since the load.
   */
  baselineWithLiveMeasurements() {
    if (!this._baseline) return null;
    const doc = cloneSceneDocument(this._baseline);
    doc.measurements = this.deps.measurements.toScene();
    return doc;
  }

  /**
   * Adopt a freshly loaded document as the new baseline.
   * A 'reset' load keeps the previous type and demo id — it is the same scene.
   * @param {object} doc
   * @param {{ type: string, name: string, demoId?: string }} source
   */
  adopt(doc, source) {
    this._baseline = cloneSceneDocument(doc);
    this._source = {
      type: source.type === 'reset' ? (this._source?.type ?? 'blank') : source.type,
      name: source.name,
      demoId: source.demoId ?? (source.type === 'reset' ? this._source?.demoId : undefined),
    };
  }

  updateResetButton() {
    const { resetButton } = this.deps;
    if (!resetButton) return;
    const hasBaseline = !!this._baseline;
    resetButton.disabled = !hasBaseline;
    const label = hasBaseline
      ? `Reset to last saved (“${this._source?.name ?? 'saved setup'}”)`
      : 'Reset scene';
    resetButton.title = label;
    resetButton.setAttribute('aria-label', label);
  }

  // ─── Serialising the live scene ──────────────────────────────────

  /**
   * Snapshot the live world as a scene document.
   *
   * Free pan/zoom moves the live camera but not the rig, so the rig is synced
   * first and the file stores the view the user sees — except in camera-tool
   * mode, where the rig *is* the intentional export frame and may legitimately
   * differ from the live pan.
   *
   * @param {string} defaultName Used when the session has no name yet.
   */
  serializeCurrent(defaultName) {
    const {
      engine, camera, cameraRig, measurements, labels,
      environmentPanel, getToolMode, getViewSize,
    } = this.deps;

    if (getToolMode() !== 'camera') {
      const { width, height } = getViewSize();
      if (width >= MIN_VIEW_PX && height >= MIN_VIEW_PX) {
        cameraRig.syncFromCamera(camera, width, height);
      }
    }

    return serializeScene(engine, {
      meta: {
        name: this.name ?? defaultName,
        source: this._source?.type ?? 'editor',
      },
      environment: environmentPanel.readScene(),
      camera: cameraRig.toSceneDoc(),
      measurements: measurements.toScene(),
      labels: labels.toScene(),
    });
  }

  // ─── Operations ──────────────────────────────────────────────────

  /**
   * Capture the live setup as the Reset checkpoint (Ctrl+S).
   * Does not download a file — that is {@link exportToFile}.
   */
  saveCheckpoint() {
    const doc = this.serializeCurrent('Untitled scene');
    const validated = validateSceneDocument(doc);
    if (!validated.ok) {
      alert(validated.error);
      return;
    }
    const name = doc.meta?.name ?? 'Untitled scene';
    this._baseline = cloneSceneDocument(validated.doc);
    this._source = this._source ? { ...this._source, name } : { type: 'editor', name };
    this.updateResetButton();
    showToolbarToast('Setup saved');
  }

  /** Download the live scene as JSON. */
  exportToFile() {
    const doc = this.serializeCurrent('Scene');
    downloadSceneJSON(doc, `${filenameSlug(doc.meta?.name)}.json`);
  }

  /** Pick a JSON file and load it. */
  async importFromFile() {
    const result = await pickAndLoadSceneFile();
    if (!result.ok) {
      if (result.error !== 'No file selected.') alert(result.error);
      return;
    }
    this.deps.loadDocument(result.doc, {
      type: 'file',
      name: result.doc.meta?.name ?? 'Imported scene',
    });
  }

  /** Reload the baseline, leaving it in place as the checkpoint. */
  restoreBaseline() {
    if (!this._baseline) return;
    this.deps.loadDocument(
      cloneSceneDocument(this._baseline),
      {
        type: 'reset',
        name: this._source?.name ?? 'Scene',
        demoId: this._source?.demoId,
      },
      { storeBaseline: false },
    );
  }
}
