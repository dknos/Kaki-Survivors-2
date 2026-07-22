/**
 * Cave achievements (P4A cohort 6, 2026-05-20).
 *
 * Per-stage achievement file per docs/STAGE_AUTHORING.md §8d — mirrors the
 * src/forestAchievements.js shape but stays small: it registers cave-specific
 * defs into the shared registry (so they flow through the existing unlock →
 * toast → meta → title-panel pipeline) and owns the cave-only eligibility
 * checks. The generic kill/time/weapon achievements in forestAchievements.js
 * are already stage-agnostic and fire on cave runs too; this module adds the
 * cave-flavored chase goals on top.
 *
 * Five defs, all immediately reachable now or wired to existing cave state.
 * Future cohorts (boss / miniboss) can register more ids the same way and the
 * boss-kill counters will flow straight into unlockAchievement().
 *
 * Lifecycle (no DOM, no dispose — defs are a permanent registry entry and the
 * per-run toast dedup is owned by forestAchievements' run Set):
 *   loadCaveAchievements()  — register defs once. Idempotent.
 *   tickCaveAchievements()  — cave-only eligibility scan. Called from
 *                             caveStage.tickCave (already frame-wired), reads
 *                             the shared state import. unlockAchievement is
 *                             itself idempotent per run + per lifetime, so the
 *                             repeated cave_enter call each frame is a cheap
 *                             no-op after the first.
 *
 * Constraints honored:
 *   - Static imports only ([[feedback_kks_export_origin_module_break.md]]).
 *   - No main.js edit — rides the existing tickCave hook.
 *   - Self-gated on stage.id === 'cave'.
 */
import { registerExternalAchievements, unlockAchievement } from './forestAchievements.js';
import { state as _gameState } from './state.js';

// Categories reuse the existing modal order set so they render in the
// title-screen panel with no extra wiring (Exploration/Progression/Survival).
const CAVE_ACH_DEFS = [
  { id: 'cave_enter',        name: 'Measure Twice',    desc: 'Begin a run on Glass Mile',               category: 'Exploration' },
  { id: 'cave_gloomshrimp',  name: 'Shrimp Startler',  desc: 'Spook a gloomshrimp in the cave',        category: 'Exploration' },
  { id: 'cave_time_10min',   name: 'Deep Delver',      desc: 'Reach 10:00 in the cave',                category: 'Progression' },
  { id: 'cave_clear',        name: 'Last Survey Mark', desc: 'Clear Glass Mile',                        category: 'Progression' },
  { id: 'cave_flawless_3min',name: 'Sure-Footed',      desc: 'Take no damage for the first 3:00 in the cave', category: 'Survival' },
];

let _loaded = false;

/** Register cave defs into the shared achievement registry. Idempotent. */
export function loadCaveAchievements() {
  if (_loaded) return;
  registerExternalAchievements(CAVE_ACH_DEFS);
  _loaded = true;
}

/** Cave-def list (for smoke probes / future panel filtering). */
export function getCaveAchievements() { return CAVE_ACH_DEFS.slice(); }

/**
 * Cave-only eligibility scan. Called every frame from caveStage.tickCave;
 * self-gates on stage.id so a forest run dropping in (it won't — tickCave is
 * cave-only) would be a no-op anyway. unlockAchievement handles per-run +
 * per-lifetime dedup, so calling cave_enter each frame costs one Set lookup
 * after the first unlock.
 */
export function tickCaveAchievements() {
  const st = _gameState;
  if (!st || !st.run || !st.run.stage || st.run.stage.id !== 'cave') return;
  const t = (st.time && st.time.game) || 0;

  // Earned on the first cave frame — proves the player reached the stage.
  unlockAchievement('cave_enter');

  // Cohort-5 tie-in: caveGloomshrimp sets this flag the first time a shrimp
  // darts away from the hero.
  if (st.run._caveShrimpStartled) unlockAchievement('cave_gloomshrimp');

  if (t >= 600) unlockAchievement('cave_time_10min');

  if (st.victory === true) unlockAchievement('cave_clear');

  if (t >= 180 && (st.run.dmgTaken | 0) === 0) unlockAchievement('cave_flawless_3min');
}
