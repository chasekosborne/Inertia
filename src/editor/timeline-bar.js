/**
 * Transport and timeline chrome: the play/capture button, the mode badge, the
 * review transport row, the scrubber, and the time / frame readouts.
 *
 * This is presentation only. It reflects recorder and playback state onto the
 * DOM and turns clicks into calls, but it never decides app mode itself — the
 * controller owns that and pushes changes in through {@link syncToMode}.
 * Anything that has to pause the engine or stop recording is delegated back
 * out through `enterReview` / `toggleCapture` / `clearRecording`.
 */

/** Review-play speed multiplier for the "fast" buttons. */
const FAST_SPEED = 2;

const BADGE = {
  setup: { className: 'tl-setup', text: 'SETUP' },
  live: { className: 'tl-live', text: '● LIVE' },
  review: { className: 'tl-review', text: 'REVIEW' },
};

function byId(id) {
  return document.getElementById(id);
}

export class TimelineBar {
  /**
   * @param {object} deps
   * @param {object} deps.engine
   * @param {object} deps.recorder
   * @param {object} deps.playback
   * @param {() => void} deps.enterReview       Switch the app into review mode.
   * @param {() => void} deps.toggleCapture     Start / stop a capture session.
   * @param {() => void} deps.clearRecording    Drop frames, traces, and graphs.
   */
  constructor(deps) {
    this.deps = deps;

    this.elements = {
      bar: byId('timeline-bar'),

      // Main transport (top toolbar)
      playPause: byId('btn-play-pause'),
      iconPlay: byId('icon-play'),
      iconPause: byId('icon-pause'),
      speedSlider: byId('speed-slider'),
      speedLabel: byId('speed-label'),

      // Timeline row
      badge: byId('tl-mode-badge'),
      jumpStart: byId('tl-jump-start'),
      reverseFast: byId('tl-rev-fast'),
      reverseStep: byId('tl-rev-step'),
      playReview: byId('tl-play-review'),
      forwardStep: byId('tl-fwd-step'),
      forwardFast: byId('tl-fwd-fast'),
      jumpEnd: byId('tl-jump-end'),
      clearFrames: byId('tl-clear-frames'),
      scrubber: byId('tl-scrubber'),
      fill: byId('tl-fill'),
      frameCount: byId('tl-frame-count'),
      timeDisplay: byId('tl-time-display'),
      reviewIconPlay: byId('tl-icon-play'),
      reviewIconPause: byId('tl-icon-pause'),
      reviewIconReverse: byId('tl-icon-rev'),

      // Status bar
      simTime: byId('sim-time'),
      recordingBadge: byId('status-record'),
      recordedFrames: byId('rec-frames'),
    };

    /** Frame-scoped controls, enabled only when a recording exists. */
    this._frameControls = [
      this.elements.jumpStart,
      this.elements.reverseFast,
      this.elements.reverseStep,
      this.elements.forwardStep,
      this.elements.forwardFast,
      this.elements.jumpEnd,
      this.elements.scrubber,
      this.elements.clearFrames,
    ];

    this._bindEvents();
  }

  // ─── Public: state pushed in by the controller ───────────────────

  /** Reflect a new app mode: badge, control enablement, transport icons. */
  syncToMode(mode) {
    const { recorder } = this.deps;
    const el = this.elements;

    const badge = BADGE[mode] ?? BADGE.review;
    el.badge.className = 'tl-badge';
    el.badge.classList.add(badge.className);
    el.badge.textContent = badge.text;

    // Timeline controls: enabled only when there is recorded data.
    const hasFrames = recorder.frameCount > 0;
    for (const control of this._frameControls) control.disabled = !hasFrames;
    if (hasFrames) el.scrubber.max = recorder.frameCount - 1;

    this.refreshReviewIcon();
    this.refreshTransport();
    this._syncBarVisibility();
  }

  /** Main play/capture button: icon swap + title. */
  refreshTransport() {
    const { recorder, engine } = this.deps;
    const el = this.elements;
    const capturing = recorder.isRecording && engine.running;
    el.iconPlay.style.display = capturing ? 'none' : '';
    el.iconPause.style.display = capturing ? '' : 'none';
    el.playPause.classList.toggle('recording', capturing);
    el.playPause.title = capturing ? 'Stop (Space)' : 'Play (Space)';
  }

  /** Review play button: play / pause / reverse icon. */
  refreshReviewIcon() {
    const { playback } = this.deps;
    const el = this.elements;
    const playing = playback.isPlaying;
    const reversing = playing && playback.playDirection === -1;
    el.reviewIconPlay.style.display = !playing ? '' : 'none';
    el.reviewIconPause.style.display = (playing && !reversing) ? '' : 'none';
    el.reviewIconReverse.style.display = reversing ? '' : 'none';
    el.playReview.classList.toggle('active', playing);
  }

  /** Show / hide the recording indicator and update its frame counter. */
  setRecording(on) {
    this.elements.recordingBadge.classList.toggle('hidden', !on);
    if (on) this.setRecordedFrames(this.deps.recorder.frameCount);
  }

  setRecordedFrames(count) {
    this.elements.recordedFrames.textContent = count;
  }

  /** Live simulation clock (also driven by playback while scrubbing). */
  setSimTime(seconds) {
    this.elements.simTime.textContent = `t = ${seconds.toFixed(3)} s`;
  }

  /** Frames are accumulating: pin the scrubber to the newest frame. */
  syncFromRecording() {
    const { recorder } = this.deps;
    const el = this.elements;
    const total = recorder.frameCount;
    el.clearFrames.disabled = total === 0;
    el.scrubber.max = Math.max(0, total - 1);
    el.scrubber.value = total - 1;
    this._setFill(total - 1);
    el.frameCount.textContent = `${total} fr`;
    const last = recorder.frames[total - 1];
    if (last) el.timeDisplay.textContent = `${last.t.toFixed(3)} s`;
    this._syncBarVisibility();
  }

  /** Playback seeked: move the thumb and the readouts to this frame. */
  syncToFrame(frameIndex) {
    const { recorder } = this.deps;
    const el = this.elements;
    el.scrubber.max = Math.max(0, recorder.frameCount - 1);
    el.scrubber.value = frameIndex;
    this._setFill(frameIndex);
    el.frameCount.textContent = `${frameIndex} / ${recorder.frameCount} fr`;
    const frame = recorder.frames[frameIndex];
    if (frame) {
      el.timeDisplay.textContent = `${frame.t.toFixed(3)} s`;
      this.setSimTime(frame.t);
    }
  }

  /** Back to an empty timeline (scene load, or frames cleared). */
  reset() {
    const el = this.elements;
    el.scrubber.value = 0;
    el.scrubber.max = 0;
    this._setFill(0);
    el.frameCount.textContent = '0 fr';
    el.timeDisplay.textContent = '0.000 s';
    this._syncBarVisibility();
  }

  /** Current scrubber position, for callers that need it without a seek. */
  getScrubIndex() {
    if (this.deps.recorder.frameCount === 0) return 0;
    return parseInt(this.elements.scrubber.value, 10) || 0;
  }

  // ─── Internals ───────────────────────────────────────────────────

  _setFill(frameIndex) {
    const max = parseInt(this.elements.scrubber.max, 10) || 1;
    this.elements.fill.style.width = `${(frameIndex / max) * 100}%`;
  }

  /** Slide the bar in once footage exists; collapse when cleared. */
  _syncBarVisibility() {
    const hasFrames = this.deps.recorder.frameCount > 0;
    this.elements.bar?.classList.toggle('collapsed', !hasFrames);
    this.elements.bar?.setAttribute('aria-hidden', String(!hasFrames));
  }

  /** Jump to the first recorded frame (keyboard: I). */
  jumpToStart() {
    this._review(() => this.deps.playback.jumpToStart());
  }

  /** Enter review, run a playback command, then refresh the icon. */
  _review(command) {
    this.deps.enterReview();
    command();
    this.refreshReviewIcon();
  }

  /** Space in review mode, and the review play button. */
  toggleReviewPlay() {
    const { recorder, playback, enterReview } = this.deps;
    if (recorder.frameCount === 0) return;
    enterReview();
    if (playback.isPlaying) {
      playback.stop();
    } else {
      // Reverse from the end, forward otherwise.
      playback.play(playback.atEnd ? -1 : 1, 1);
    }
    this.refreshReviewIcon();
  }

  _bindEvents() {
    const el = this.elements;
    const { playback, engine, toggleCapture, clearRecording } = this.deps;

    el.playPause.addEventListener('click', () => toggleCapture());
    el.playReview.addEventListener('click', () => this.toggleReviewPlay());
    el.clearFrames.addEventListener('click', () => clearRecording());

    el.jumpStart.addEventListener('click', () => this.jumpToStart());
    el.jumpEnd.addEventListener('click', () => this._review(() => playback.jumpToEnd()));
    el.reverseStep.addEventListener('click', () => this._review(() => playback.stepBack()));
    el.forwardStep.addEventListener('click', () => this._review(() => playback.stepForward()));
    el.reverseFast.addEventListener('click', () => this._review(() => playback.play(-1, FAST_SPEED)));
    el.forwardFast.addEventListener('click', () => this._review(() => playback.play(1, FAST_SPEED)));

    el.scrubber.addEventListener('mousedown', () => this._review(() => playback.stop()));
    el.scrubber.addEventListener('input', () => {
      const frameIndex = parseInt(el.scrubber.value, 10);
      playback.seek(frameIndex);
      this._setFill(frameIndex);
    });

    el.speedSlider.addEventListener('input', () => {
      const speed = parseFloat(el.speedSlider.value);
      engine.setSpeed(speed);
      el.speedLabel.textContent = `${speed.toFixed(1)}×`;
    });
  }
}
