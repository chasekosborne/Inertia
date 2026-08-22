/**
 * Playback: scrubs through recorded frames and replays them.
 *
 * Applies snapshots back onto Matter.js bodies so the renderer
 * reflects any position in the recording without running new physics.
 *
 * Sticky welds replace bodies with a new compound (new Matter ids). When the
 * body set in a frame differs from the live world, topology is rebuilt from
 * the snapshot so scrubbing across the weld stays consistent.
 */

import Matter from 'matter-js';
import { createBodyFromSnap } from './replay-bodies.js';

const { Body } = Matter;

export class Playback {
  constructor(recorder, engine) {
    this._recorder  = recorder;
    this._engine    = engine;
    this._frameIdx  = 0;
    this._autoPlay  = false;
    this._playDir   = 1;     // 1 = forward, -1 = reverse
    this._playSpeed = 1;     // multiplier: 1, 2, or 4
    this._rafId     = null;
    this._prevTs    = null;
    this._onChangeCb = null;
  }

  // ─── Public state ──────────────────────────────────────────────
  get frameIndex() { return this._frameIdx; }
  get frameCount()  { return this._recorder.frames.length; }
  get isPlaying()   { return this._autoPlay; }
  get atStart()     { return this._frameIdx === 0; }
  get atEnd()       { return this._frameIdx >= this.frameCount - 1; }

  /** cb(frameIndex, event?): called on every seek, event = 'start'|'end' when auto-play halts */
  onChange(cb) { this._onChangeCb = cb; }

  // ─── Navigation ────────────────────────────────────────────────

  seek(rawIdx) {
    const frames = this._recorder.frames;
    if (!frames.length) return;
    const idx = Math.max(0, Math.min(frames.length - 1, Math.round(rawIdx)));
    this._frameIdx = idx;
    this._applyFrame(frames[idx]);
    this._onChangeCb?.(idx);
  }

  stepForward() { this.stop(); this.seek(this._frameIdx + 1); }
  stepBack()    { this.stop(); this.seek(this._frameIdx - 1); }
  jumpToStart() { this.stop(); this.seek(0); }
  jumpToEnd()   { this.stop(); this.seek(this.frameCount - 1); }

  // ─── Playback ──────────────────────────────────────────────────

  /**
   * Start (or restart) auto-play.
   * @param {number} direction  1 = forward, -1 = reverse
   * @param {number} speed      1 | 2 | 4
   */
  play(direction = 1, speed = 1) {
    // Toggle off if already playing same direction+speed
    if (this._autoPlay && this._playDir === direction && this._playSpeed === speed) {
      this.stop();
      return;
    }
    // Can't play forward past end or backward past start
    if (direction === 1  && this.atEnd)   return;
    if (direction === -1 && this.atStart) return;

    this._playDir   = direction;
    this._playSpeed = speed;
    this._autoPlay  = true;
    this._prevTs    = null;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  stop() {
    this._autoPlay = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._prevTs = null;
  }

  // ─── Internal loop ─────────────────────────────────────────────

  _loop(ts) {
    if (!this._autoPlay) return;

    if (this._prevTs !== null) {
      const wall = Math.min(ts - this._prevTs, 80);  // cap at 80 ms
      // Keyframes are captured once per render frame (~60 Hz), not per physics substep.
      const frameDelta = (wall / (1000 / 60)) * this._playSpeed * this._playDir;
      const next = this._frameIdx + frameDelta;

      if (next >= this.frameCount - 1) {
        this.seek(this.frameCount - 1);
        this._autoPlay = false;
        this._onChangeCb?.(this._frameIdx, 'end');
        return;
      }
      if (next <= 0) {
        this.seek(0);
        this._autoPlay = false;
        this._onChangeCb?.(this._frameIdx, 'start');
        return;
      }
      this.seek(next);
    }

    this._prevTs = ts;
    this._rafId  = requestAnimationFrame(this._loop.bind(this));
  }

  // ─── Snapshot application ──────────────────────────────────────

  _applyFrame(frame) {
    this._syncTopology(frame);

    const bodyMap = new Map(this._engine.bodies.map(b => [b.id, b]));
    for (const snap of frame.bodies) {
      const body = bodyMap.get(snap.id);
      if (!body) continue;
      Body.setPosition(body,          { x: snap.x, y: snap.y });
      Body.setAngle(body,               snap.angle);
      Body.setVelocity(body,          { x: snap.vx, y: snap.vy });
      const w = Number.isFinite(snap.w) ? snap.w : 0;
      Body.setAngularVelocity(body,     w);
    }

    this._applyConstraints(frame, bodyMap);
  }

  /**
   * Ensure live bodies match the recorded set (create missing, remove extras).
   * Only runs work when the id set actually changes (cheap across most seeks).
   */
  _syncTopology(frame) {
    const wantIds = new Set(frame.bodies.map(b => b.id));
    const live = this._engine.bodies;
    const haveIds = new Set(live.map(b => b.id));

    let changed = wantIds.size !== haveIds.size;
    if (!changed) {
      for (const id of wantIds) {
        if (!haveIds.has(id)) { changed = true; break; }
      }
    }
    if (!changed) return;

    const snapById = new Map(frame.bodies.map(b => [b.id, b]));

    // Create missing first so constraints can retarget onto them.
    for (const snap of frame.bodies) {
      if (haveIds.has(snap.id)) continue;
      const neo = createBodyFromSnap(snap);
      if (!neo) continue;
      this._engine.addBody(neo);
      haveIds.add(snap.id);
    }

    const bodyMap = new Map(this._engine.bodies.map(b => [b.id, b]));
    this._applyConstraints(frame, bodyMap);

    // Remove bodies that should not exist in this frame.
    for (const body of [...this._engine.bodies]) {
      if (wantIds.has(body.id)) continue;
      if (body._newtonType === 'metric-basis') continue;
      this._engine.removeBody(body);
    }
  }

  _applyConstraints(frame, bodyMap) {
    if (!frame.constraints?.length) return;
    const byId = new Map(this._engine.constraints.map(c => [c.id, c]));
    for (const cs of frame.constraints) {
      const c = byId.get(cs.id);
      if (!c) continue;
      if (cs.bodyAId != null) {
        const a = bodyMap.get(cs.bodyAId);
        if (a) c.bodyA = a;
      }
      if (cs.bodyBId != null) {
        const b = bodyMap.get(cs.bodyBId);
        if (b) c.bodyB = b;
      }
      if (cs.pointA) c.pointA = { x: cs.pointA.x, y: cs.pointA.y };
      if (cs.pointB) c.pointB = { x: cs.pointB.x, y: cs.pointB.y };
    }
  }
}
