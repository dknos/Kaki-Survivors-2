/**
 * Overworld schedule clock.
 *
 * Combat time keeps advancing inside the Catacomb so weapons, hazards, and
 * i-frames remain honest. Overworld-only schedules must not advance while
 * their owners are suspended, so they read this derived clock instead.
 */
import { state } from './state.js';

export function overworldTime(source = state) {
  const game = source && source.time ? Number(source.time.game) || 0 : 0;
  const paused = source && source.run ? Number(source.run._overworldPausedTime) || 0 : 0;
  return Math.max(0, game - paused);
}

export function addOverworldPause(seconds, source = state) {
  if (!source || !source.run || !Number.isFinite(seconds) || seconds <= 0) return;
  source.run._overworldPausedTime = (Number(source.run._overworldPausedTime) || 0) + seconds;
}
