import {
  applyCrashDamagePresentation,
  applyCrashDamageSnapshot,
  resetCrashDamagePresentation,
} from './crashDamagePresentation.js';
import {
  buildReplayShotPlan,
  replayShotAt,
  replayWindowForHighlights,
} from './crashReplayDirector.js';
import { CRASH_DETACHED_PART_BITS } from './crashCollisionEvents.js';

const PLAYBACK_SPEEDS = Object.freeze([1, 0.5, 0.25, 0.12]);

function resetDamageGeometry(entity) {
  resetCrashDamagePresentation(entity);
}

export class CrashReplayPlayer {
  constructor(session) {
    this.session = session;
    this.recorder = session.replayRecorder;
    this.clip = null;
    this.plan = [];
    this.time = 0;
    this.playing = false;
    this.finished = false;
    this.eventCursor = 0;
    this.stateEvents = [];
    this.manualSpeed = null;
    this.lastShot = null;
    this.highlight = null;
  }

  start() {
    const frames = this.recorder.chronologicalFrames();
    const history = { start: frames[0]?.time || 0, end: frames.at(-1)?.time || 0 };
    const window = replayWindowForHighlights(this.recorder.events, history);
    this.clip = this.recorder.createClip(window.start, window.end);
    this.stateEvents = this.clip.stateEvents || this.clip.events;
    this.highlight = window.highlight;
    this.plan = buildReplayShotPlan(this.clip.events, window, { reduceMotion: !!this.session.reduceMotion });
    this.time = this.clip.start;
    this.eventCursor = 0;
    this.playing = true;
    this.finished = false;
    this.manualSpeed = null;
    this.lastShot = null;
    this._resetPresentation();
    this._applyStateEventsThrough(this.time, false);
    this._applyTransforms(this.time);
    return { clip: this.clip, plan: this.plan, highlight: this.highlight };
  }

  _allEntities() {
    return this.session.replayEntities?.() || [];
  }

  _entity(id) {
    return this.session.entityById?.get?.(id) || null;
  }

  _resetPresentation() {
    for (const entity of this._allEntities()) {
      resetDamageGeometry(entity);
      if (entity.sourcePart) {
        entity.visual.root.visible = false;
        entity.sourcePart.visible = true;
      }
      for (const part of entity.visual?.parts?.values?.() || []) {
        if (part) part.visible = true;
      }
    }
  }

  _applyTransforms(time) {
    for (const id of this.clip.objectIds) {
      const entity = this._entity(id);
      const root = entity?.visual?.root;
      if (!root) continue;
      const sample = this.clip.sample(id, time);
      if (!sample) continue;
      root.visible = sample.active;
      root.position.fromArray(sample.position);
      root.quaternion.fromArray(sample.quaternion);
      entity.replayDamage = sample.damage;
      entity.replayDetachedMask = sample.detachedMask;
      applyCrashDamageSnapshot(entity, sample);
      for (const [partName, bit] of Object.entries(CRASH_DETACHED_PART_BITS)) {
        if (!(sample.detachedMask & bit)) continue;
        const part = entity.visual?.parts?.get?.(partName) || root.getObjectByName?.(partName);
        if (part) part.visible = false;
      }
      for (let index = 0; index < (sample.wheelState?.length || 0); index++) {
        const wheel = entity.wheelVisualBindings?.[index];
        const state = sample.wheelState[index];
        if (!wheel || !state) continue;
        wheel.visible = state.visible;
        wheel.position.fromArray(state.position);
        wheel.quaternion.fromArray(state.quaternion);
      }
    }
  }

  _applyEvent(event, replayVfx = true) {
    const entity = this._entity(event.subjectId);
    if (event.type === 'damage' && entity?.visual) {
      applyCrashDamagePresentation(entity, event);
    } else if (event.type === 'part-detached') {
      const debris = this._entity(event.debrisId);
      if (debris?.sourcePart) debris.sourcePart.visible = false;
      if (debris?.visual?.root) debris.visual.root.visible = true;
    }
    if (replayVfx && ['impact', 'damage', 'part-detached', 'explosion', 'kakiBoom', 'structure-collapse', 'break'].includes(event.type)) {
      this.session.onReplayEvent?.(event);
    }
  }

  _applyStateEventsThrough(target, replayVfx = false, previous = -Infinity) {
    while (this.eventCursor < this.stateEvents.length && this.stateEvents[this.eventCursor].time <= target) {
      const event = this.stateEvents[this.eventCursor++];
      this._applyEvent(event, replayVfx && event.time >= Math.max(this.clip.start, previous - 1e-6));
    }
  }

  setSpeed(speed) {
    const nearest = PLAYBACK_SPEEDS.reduce((best, candidate) => Math.abs(candidate - speed) < Math.abs(best - speed) ? candidate : best, 1);
    this.manualSpeed = nearest;
    return nearest;
  }

  clearManualSpeed() {
    this.manualSpeed = null;
  }

  seek(time, { replayVfx = false } = {}) {
    if (!this.clip) return false;
    const target = Math.max(this.clip.start, Math.min(this.clip.end, Number(time) || this.clip.start));
    if (target < this.time) {
      this.eventCursor = 0;
      this._resetPresentation();
    }
    this._applyStateEventsThrough(target, replayVfx, this.time);
    this.time = target;
    this._applyTransforms(this.time);
    this.lastShot = replayShotAt(this.plan, this.time);
    this.finished = this.time >= this.clip.end - 1e-6;
    this.playing = !this.finished;
    return true;
  }

  update(dt) {
    if (!this.playing || !this.clip) return { finished: this.finished, time: this.time, shot: this.lastShot, speed: 0 };
    const shot = replayShotAt(this.plan, this.time);
    let speed = this.manualSpeed || shot?.speed || 1;
    if (!this.manualSpeed && shot?.highlight && Math.abs(this.time - (this.highlight?.time || 0)) < 0.13 && !this.session.reduceMotion) speed = 0.12;
    const previous = this.time;
    this.time = Math.min(this.clip.end, this.time + Math.max(0, dt) * speed);
    this._applyStateEventsThrough(this.time, true, previous);
    this._applyTransforms(this.time);
    this.lastShot = replayShotAt(this.plan, this.time) || shot;
    if (this.time >= this.clip.end - 1e-6) {
      this.playing = false;
      this.finished = true;
    }
    return { finished: this.finished, time: this.time, shot: this.lastShot, speed };
  }

  skip() {
    if (!this.clip) return false;
    this.time = this.clip.end;
    this._applyStateEventsThrough(this.time, false);
    this._applyTransforms(this.time);
    this.playing = false;
    this.finished = true;
    return true;
  }

  replayAgain() {
    if (!this.clip) return false;
    this.plan = buildReplayShotPlan(this.clip.events, {
      start: this.clip.start,
      end: this.clip.end,
      duration: this.clip.end - this.clip.start,
    }, { reduceMotion: !!this.session.reduceMotion });
    this.time = this.clip.start;
    this.eventCursor = 0;
    this.playing = true;
    this.finished = false;
    this.manualSpeed = null;
    this.lastShot = null;
    this._resetPresentation();
    this._applyStateEventsThrough(this.time, false);
    this._applyTransforms(this.time);
    return true;
  }

  snapshot() {
    return {
      active: this.playing,
      finished: this.finished,
      time: this.time,
      start: this.clip?.start || 0,
      end: this.clip?.end || 0,
      speed: this.manualSpeed || this.lastShot?.speed || 1,
      shot: this.lastShot?.family || '',
      highlightTime: this.highlight?.time ?? null,
    };
  }
}

export { PLAYBACK_SPEEDS };
