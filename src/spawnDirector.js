/**
 * Enemy spawn director.
 *
 * Continuous-flow spawner with a difficulty curve D(t):
 *   t ∈ [0, rampSec)        → D = t / rampSec           (0 → 1)
 *   t ∈ [rampSec, maxSec)   → D linear 1 → difficultyMax
 *   t ≥ maxSec              → D = difficultyMax
 *
 * Each director tick (throttled to SPAWN.tickIntervalSec):
 *   - Tops up active enemies toward target = base + D * perD (capped).
 *   - Picks a weighted-random tier unlocked by D and spawns it on a ring
 *     around the hero, slightly off the orthographic frustum.
 *
 * Periodic events:
 *   - Horde   every SPAWN.hordeIntervalSec  → burst of hordeCount mid-tier in an arc.
 *   - Boss    every SPAWN.bossIntervalSec   → one elite at 5× HP on a wider ring.
 */
import { state } from './state.js';
import { ENEMY_TIERS, SPAWN, STAGE, NEMESIS_SPAWN } from './config.js';
import { spawnEnemy, spawnNemesis } from './enemies.js';
import { showBanner, showNemesisTease, hideNemesisArrow } from './ui.js';
import { sfx } from './audio.js';
import { spawnChestNearHero } from './chest.js';
import { shopLevel, getMeta } from './meta.js';
import { nameForMiniBoss, nameForFinalBoss } from './bossTelegraphs.js';
import { spawnHeart, spawnStar } from './pickups.js';
import { dropGem } from './xp.js';
// PHASE 4 P4J (#140) — Telemetry hook for the nemesis kill chokepoint. Static
// import; nemesis kill is the second `state.run.kills++` site outside
// enemies.js so we mirror its kill+boss_clear event pair here.
import { event as telemetryEvent } from './telemetry.js';
import { endPuzzleEarly } from './puzzleSystem.js';
import {
  FOREST_ROOMS,
  constrainForestX,
  constrainForestZ,
  isForestPositionPlayable,
} from './forestRooms.js';
import { overworldTime } from './runClock.js';
// PHASE 4 P4E (#145) — daily seed PRNG seam. `rand()` is a transparent alias
// for Math.random() unless daily mode is seeded (main.js applyMetaUpgrades),
// in which case it deterministically replays from a YYYYMMDD-seeded mulberry32
// stream. Cleared at run-end teardown so non-daily runs keep native behavior.
// Only spawn-decision call sites are routed through `rand()` — cosmetic
// per-mesh jitter in enemies.js (hue / animation phase / ranged cooldown
// start) is intentionally NOT swapped: replacing those would over-constrain
// the seam, and they don't influence the first-N spawn positions that the
// acceptance test verifies.
import { rand as _seedRand, clearDailySeed } from './dailyRng.js';
import {
  enemyEncounterTierWeight,
  getEnemyEncounterDebugState,
  isEnemyTierAllowedForStage,
  noteEnemyEncounterPick,
  noteEnemyEncounterPoolSize,
  resetEnemyEncounterDeck,
  syncEnemyEncounterDeck,
} from './enemyEncounterDeck.js';

// ── Module-local director state ──────────────────────────────────────────────
let _acc = 0;
let _nextHorde = SPAWN.hordeIntervalSec;
let _nextChest = SPAWN.chestIntervalSec * 0.5;
let _lastSeenTime = 0;
let _finalBossWarned = false;
let _finalBossSpawned = false;
let _miniBossIdx = 0;
let _miniBossWarnedFor = -1;
// Arc beats (10-min run): hordes defer while a boss is alive, the alive
// target ebbs after a miniboss dies, and surges in the window before each
// boss beat. No kill hook exists, so the ebb edge is detected by a
// was-alive → not-alive flip on state.enemies.active.
let _miniBossWasAlive = false;
let _ebbUntil = 0;
let _lastAliveCount = 0;   // mass-despawn detector (room-exit backfill cap)
const HORDE_DEFER_SEC = 15;     // re-check horde this long after a boss-alive skip
const EBB_WINDOW_SEC = 12;      // loot-and-breathe beat after a miniboss dies
const EBB_FLOOR_MUL = 0.6;
const SURGE_WINDOW_SEC = 30;    // tension build before each boss due time
const SURGE_MUL = 1.25;
const BOSS_RUSH_MINI_SCHEDULE = Object.freeze([25, 75, 135]);
const _miniSchedule = [];
const _allowedTiers = [];
const _hordeTiers = [];
let _scheduleBossRush = null;
let _scheduleFinalBossAt = NaN;
let _scheduleWeeklyExtra = null;

// ── Forest puzzle pause/resume (FE-C3A) ──────────────────────────────────────
// When state.run.roomState === 'PUZZLE_ACTIVE', the entire spawn pipeline is
// frozen:
//   - _acc does NOT advance, so the SPAWN.tickIntervalSec slice never fires.
//   - All scheduled times (_nextHorde, _nextChest, mini-boss sched, final
//     boss, nemesis) get shifted forward by the paused duration on resume.
// On resume we ALSO run a 30-second density smoothing ramp so D(t) doesn't
// dump 60s of backlog spawns at once (per FOREST_EXPANSION_PLAN §5 risk 2:
// horde clock desync). The ramp is linear 0.6 → 1.0 applied as a multiplier
// to the target alive cap.
//
// The pause/resume edge is detected purely from state.run.roomState — we
// don't subscribe to puzzleSystem events. _pausedAtGameTime is the
// state.time.game instant the pause started; null when not paused. On the
// resume frame we compute paused-duration = now - _pausedAtGameTime, shift
// every scheduled timer, set _smoothingUntil = now + 30, and clear
// _pausedAtGameTime so the next frame runs normally.
let _pausedAtGameTime = null;       // null when not paused, else state.time.game at pause start
let _smoothingUntil = 0;            // state.time.game at which the 0.6→1.0 ramp completes
let _encounterPausedSec = 0;        // keeps card previews aligned with shifted hordes
const SMOOTHING_WINDOW_SEC = 30;    // 30s ramp per spec
const SMOOTHING_FLOOR = 0.6;        // density floor at t=0 of smoothing ramp

// Nemesis Elite (C3 + Punch List #2) — singleton hunter that spawns outside
// the standard wave / boss schedule. `active` holds the live enemy object
// (null when no nemesis is on the field); `nextSpawnAt` is the absolute
// state.time.game instant the next nemesis is allowed to spawn.
//
// Punch List #2 (2026-05-16) wired three new concepts:
//   - First spawn is anchored to NEMESIS_SPAWN.wave * waveSec (480s by
//     default) instead of the random 90-120s C3 window.
//   - At telegraphWave * waveSec (420s) the director fires a banner + arrow
//     telegraph for ALL players, gated only by `telegraphed` (once per run).
//   - The actual spawn is gated by `meta.unlockFlags.finalBossWin === true`
//     (first-victory meta gate). New players never see the spawn but DO see
//     the telegraph (tension teaches the mechanic).
//   - `_nemesisState.angle` carries the pre-rolled spawn direction from the
//     telegraph fire to the actual spawn so the arrow points at the same
//     vector the hunter eventually appears from.
//
// Single-active rule preserved: if the timer fires while a nemesis is still
// alive, we SKIP the spawn (no doubling up) but don't push the timer back —
// the next clean check after the kill will respect the post-kill cooldown.
function _firstNemesisSpawnAt() {
  return NEMESIS_SPAWN.wave * NEMESIS_SPAWN.waveSec;
}
function _nemesisTelegraphAt() {
  return NEMESIS_SPAWN.telegraphWave * NEMESIS_SPAWN.waveSec;
}
function _rollNemesisRespawn(now) {
  return now + NEMESIS_SPAWN.respawnMinSec + _seedRand() * NEMESIS_SPAWN.respawnJitterSec;
}
function _hasFirstVictory() {
  try {
    const m = getMeta();
    return !!(m && m.unlockFlags && m.unlockFlags.finalBossWin);
  } catch (_) { return false; }
}
const _nemesisState = {
  active: null,
  nextSpawnAt: _firstNemesisSpawnAt(),
  telegraphed: false,       // run-scoped: telegraph fires once per run
  angle: 0,                 // pre-rolled spawn direction (radians, world XZ)
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function weightedPick(tiers, encounterMode = 0) {
  const horde = encounterMode === 2;
  let total = 0;
  for (let i = 0; i < tiers.length; i++) {
    total += encounterMode
      ? enemyEncounterTierWeight(tiers[i], horde)
      : tiers[i].weight;
  }
  let r = _seedRand() * total;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    r -= encounterMode ? enemyEncounterTierWeight(t, horde) : t.weight;
    if (r <= 0) {
      if (encounterMode) noteEnemyEncounterPick(t);
      return t;
    }
  }
  const fallback = tiers[tiers.length - 1];
  if (encounterMode) noteEnemyEncounterPick(fallback);
  return fallback;
}

function computeDifficulty(t) {
  if (t <= 0) return 0;
  if (t < SPAWN.difficultyRampSec) return t / SPAWN.difficultyRampSec;
  if (t < SPAWN.difficultyMaxSec) {
    const span = SPAWN.difficultyMaxSec - SPAWN.difficultyRampSec;
    const k = (t - SPAWN.difficultyRampSec) / span;
    return 1 + k * (SPAWN.difficultyMax - 1);
  }
  return SPAWN.difficultyMax;
}

function _enemyEncounterRunSeed() {
  // Replay URLs are the strongest identity. Daily/weekly modes then use their
  // calendar seed instead of the environment's normal per-run random seed, so
  // the themed sequence remains fair and identical across leaderboard runs.
  if (state.replaySeed && state.replaySeed.seed) return state.replaySeed.seed;
  const run = state.run;
  if (state.modes && state.modes.daily && run && run.daily
      && Number.isFinite(run.daily.seed)) return run.daily.seed;
  if (state.modes && state.modes.weekly && run && run.weekly
      && run.weekly.weekKey) return run.weekly.weekKey;
  if (run && Number.isFinite(run.environmentSeed)) return run.environmentSeed;
  return (run && run.startedAt) || 0;
}

let _forestSpawnX = 0;
let _forestSpawnZ = 0;
function _fitForestRingPoint(hp, angle, radius, padding) {
  // Preserve the requested ring distance at map edges. Rotating around the
  // ring avoids the old clamp behavior that could put a 33u boss 3u away.
  for (let attempt = 0; attempt < 12; attempt++) {
    const step = attempt === 0 ? 0 : Math.ceil(attempt / 2) * (Math.PI / 6) * (attempt & 1 ? 1 : -1);
    const a = angle + step;
    const x = hp.x + Math.cos(a) * radius;
    const z = hp.z + Math.sin(a) * radius;
    if (!isForestPositionPlayable(x, z, padding)) continue;
    _forestSpawnX = x;
    _forestSpawnZ = z;
    return;
  }
  // Defensive fallback for a future map narrower than the spawn diameter.
  const inward = Math.atan2(-hp.z, -hp.x);
  _forestSpawnX = constrainForestX(hp.x + Math.cos(inward) * radius, padding);
  _forestSpawnZ = constrainForestZ(hp.z + Math.sin(inward) * radius, padding);
}

function spawnOnRing(tier, angle, radiusMul = 1) {
  // Stage rule may tighten/widen the ring (Forest "Overgrowth" = 0.75×).
  const stageRingMul = (state.run && state.run.stageRuleSpawnRingMul) || 1;
  const r = (SPAWN.ringRadius + (_seedRand() * 2 - 1) * SPAWN.ringJitter) * radiusMul * stageRingMul;
  const hp = state.hero.pos;
  let x = hp.x + Math.cos(angle) * r;
  let z = hp.z + Math.sin(angle) * r;
  if (state.run && state.run.stage && state.run.stage.id === 'forest') {
    _fitForestRingPoint(hp, angle, r, 2);
    x = _forestSpawnX;
    z = _forestSpawnZ;
  }
  // P4D NG+ (#143) — return the spawned enemy so the Twin Bosses caller can
  // tag the twin via _isTwin post-spawn. spawnEnemy hard-copies known
  // tierConfig fields (enemies.js line 389 region) so custom tags must be
  // stamped on the returned object, not the tier blob. Returns null on pool
  // exhaustion (rare).
  return spawnEnemy(tier, x, z);
}

function _resolveMiniSchedule(bossRush, finalBossAt, weeklyExtra) {
  if (_scheduleBossRush === bossRush &&
      _scheduleFinalBossAt === finalBossAt &&
      _scheduleWeeklyExtra === !!weeklyExtra) return _miniSchedule;

  _scheduleBossRush = bossRush;
  _scheduleFinalBossAt = finalBossAt;
  _scheduleWeeklyExtra = !!weeklyExtra;
  _miniSchedule.length = 0;

  const base = bossRush ? BOSS_RUSH_MINI_SCHEDULE : STAGE.miniBossSchedule;
  const cutoff = finalBossAt - 60;
  for (let i = 0; i < base.length; i++) {
    const due = base[i];
    if (bossRush || due < cutoff) _miniSchedule.push(due);
  }
  // Add after filtering: the old append-then-`< cutoff` filter immediately
  // removed this exact cutoff value, silently disabling BOSS_PARADE.
  if (!bossRush && weeklyExtra) _miniSchedule.push(cutoff);
  return _miniSchedule;
}

// ── Public API ───────────────────────────────────────────────────────────────
export function initSpawnDirector() {
  // P4E (#145) — Defensive: drop any stale daily seed UNLESS this run is
  // already in daily mode (in which case main.js applyMetaUpgrades has
  // already seeded for the current day and we'd lose that seed by
  // clearing here). Without this guard, a crashed daily run that didn't
  // reach _teardownActiveRun could leave _seedRand pinned to a
  // deterministic stream during the next non-daily run. The state.modes
  // check is the live source of truth — applyMetaUpgrades wrote it just
  // before kkStartRun would normally call init() the second time around,
  // and tests that call resetSpawnDirector mid-run will see the same.
  try {
    if (!(state.modes && state.modes.daily)) clearDailySeed();
  } catch (_) {}
  _acc = 0;
  _nextHorde = SPAWN.hordeIntervalSec;
  _nextChest = SPAWN.chestIntervalSec * 0.5;
  _lastSeenTime = 0;
  _finalBossWarned = false;
  _finalBossSpawned = false;
  _miniBossIdx = 0;
  _miniBossWarnedFor = -1;
  _miniBossWasAlive = false;
  _ebbUntil = 0;
  _lastAliveCount = 0;
  _nemesisState.active = null;
  _nemesisState.nextSpawnAt = _firstNemesisSpawnAt();
  _nemesisState.telegraphed = false;
  _nemesisState.angle = 0;
  // FE-C3A — clear puzzle pause/smoothing so a fresh run can't inherit a
  // mid-puzzle paused state from a prior crashed run.
  _pausedAtGameTime = null;
  _smoothingUntil = 0;
  _encounterPausedSec = 0;
  _scheduleBossRush = null;
  resetEnemyEncounterDeck();
  try { hideNemesisArrow(); } catch (_) {}
}

function spawnMiniBoss() {
  // Explicit tier ladder keyed to _miniBossIdx (2:30 / 5:30 / 8:00 beats).
  // D(t) sits below the elite minD gates (giant 6, dragon 7) until ~D5, so a
  // `minD <= D + 1` filter is always empty for the first two beats and would
  // silently fall back to a random elite.
  const _giant  = ENEMY_TIERS.find(t => t.glb === 'giant');
  const _dragon = ENEMY_TIERS.find(t => t.glb === 'dragon');
  let choice;
  if (_miniBossIdx === 0)      choice = _giant;
  else if (_miniBossIdx === 1) choice = _seedRand() < 0.5 ? _giant : _dragon;
  else                         choice = _dragon;
  if (!choice) {
    // Safety net if the tier table is ever renamed. Excludes dungeon tiers —
    // their minD:999/weight:0 gates don't apply to a flat elite filter.
    const pool = ENEMY_TIERS.filter(t => t.elite && !t.dungeon);
    if (pool.length === 0) return;
    choice = pool[Math.floor(_seedRand() * pool.length)];
  }
  const buffed = {
    ...choice,
    displayName: nameForMiniBoss(_miniBossIdx).name,
    hp: choice.hp * STAGE.miniBossHpMul,
    scale: (choice.scale || 1) * STAGE.miniBossScaleMul,
    isMiniBoss: true,
    _patternIdx: _miniBossIdx, // tells bossTelegraphs which signature attack
  };
  const angle = _seedRand() * Math.PI * 2;
  spawnOnRing(buffed, angle, 1.3);
  // P4D NG+ Twin Bosses (#143) — spawn a second adjacent miniboss with the
  // same buffed stats; offset by ~PI/12 around the ring (small angular
  // separation so both sit inside the ring band but read as a pair). _isTwin
  // tags the second for telemetry / debug; HP bar dispatch is automatic since
  // forestBossBars.js iterates state.enemies.active and renders one row per
  // isMiniBoss / isFinalBoss entity (MAX_ROWS=3, so two minibosses fit).
  // spawnEnemy strips unknown tierConfig fields (enemies.js:389 region) so
  // we stamp _isTwin on the returned live enemy, not the tier blob.
  if (state.modes && state.modes.ngTwin) {
    const twinAngle = angle + Math.PI / 12;
    const twinEnemy = spawnOnRing(buffed, twinAngle, 1.3);
    if (twinEnemy) twinEnemy._isTwin = true;
  }
  state.fx.chromaticPulse = 0.9;
  state.fx.bloomBoost = 0.6;
  state.fx.shake = Math.max(state.fx.shake || 0, 0.5);
}

export function resetSpawnDirector() { initSpawnDirector(); }

/** Stable, allocation-free encounter state for the profiler/dev console. */
export function getSpawnEncounterDebugState() {
  return getEnemyEncounterDebugState();
}

/**
 * Called from enemies.killEnemy when the Nemesis dies. Drops the bonus
 * reward bundle (3 hearts + gem cluster), tears down the procedural mesh
 * (it's NOT pooled — built fresh per spawn), bumps the kill counter, and
 * schedules the next nemesis 120-180s out. The single-active rule means
 * this is the ONLY place that re-arms the schedule from a kill — the
 * fallback safety check in tickSpawnDirector covers defensive cases only.
 */
export function onNemesisKilled(enemy) {
  if (!enemy) return;
  const ex = enemy.mesh ? enemy.mesh.position.x : 0;
  const ez = enemy.mesh ? enemy.mesh.position.z : 0;

  // Reward bundle: 3 hearts arrayed around the death point + 5 gem cluster
  // (small-value gems for visual splash + the standard elite XP bump).
  try {
    spawnHeart(ex - 1.2, ez);
    spawnHeart(ex + 1.2, ez);
    spawnHeart(ex, ez - 1.2);
    spawnStar(ex, ez + 1.4);
  } catch (_) {}

  // Gem cluster — 6 small gems scattered. Uses enemy.mesh.position directly
  // (already a THREE.Vector3) so dropGem.clone() works without an import.
  // The single big XP gem matches NEMESIS_TIER.xp = 50.
  try {
    if (enemy.mesh && enemy.mesh.position) {
      dropGem(enemy.mesh.position.clone(), 50);
      // Six small surround gems so the kill feels like loot rain.
      const tmp = enemy.mesh.position.clone();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
        tmp.set(ex + Math.cos(a) * 1.6, enemy.mesh.position.y, ez + Math.sin(a) * 1.6);
        dropGem(tmp.clone(), 3);
      }
    }
  } catch (_) {}

  // Banner + small camera punch — the player should feel the kill.
  try { showBanner('NEMESIS SLAIN', 3.0, '#ffd24a'); } catch (_) {}
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.9);
  state.fx.shake = Math.max(state.fx.shake || 0, 0.55);

  // Tear down the custom mesh (NOT pooled). traverse() so geometries +
  // materials get released — the procedural mesh has 1 group + ~5 child
  // meshes, lightweight but worth disposing so a long run doesn't slowly
  // leak per-nemesis assets.
  if (enemy.mesh) {
    if (enemy.mesh.userData) {
      enemy.mesh.userData.damageFlashController = null;
      enemy.mesh.userData.creatureAnimationController = null;
    }
    if (enemy.mesh.parent) enemy.mesh.parent.remove(enemy.mesh);
    enemy.mesh.traverse(o => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m && m.dispose) m.dispose(); }
      }
    });
  }

  // Kill bookkeeping — mirrors the tail of killEnemy() that we early-returned
  // past. Run kills/dmg/quest counters all bump here so the nemesis counts.
  state.run.kills++;
  state.run.noDmgKills = (state.run.noDmgKills || 0) + 1;
  // PHASE 4 P4J — telemetry kill + boss_clear (nemesis is treated as a boss).
  try { telemetryEvent('kill'); telemetryEvent('boss_clear'); } catch (_) {}

  // Reschedule + clear the active slot. Doing this LAST so any throw above
  // doesn't leave the schedule armed against a dangling mesh.
  _nemesisState.active = null;
  _nemesisState.nextSpawnAt = _rollNemesisRespawn(overworldTime());
}

/** Returns seconds-until next mini-boss, or null if all 3 are done / final boss next. */
export function secondsUntilNextMiniBoss() {
  // Kaki Land is a self-contained portal route. Its three trial bosses and
  // Sovereign are spawned only by kakiLandPortals, never on the global clock.
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland') return null;
  // The six Grove guardians replace the legacy Forest elite schedule. Keep
  // the HUD honest as well as the spawning logic; advertising an elite that
  // can never arrive makes the portal objective look like a second system.
  const forestPortalRoute = !!(state.run && state.run.stage
    && state.run.stage.id === 'forest'
    && !(state.modes && (state.modes.bossRush || state.modes.daily || state.modes.weekly)));
  if (forestPortalRoute) return null;
  if (_miniBossIdx >= STAGE.miniBossSchedule.length) return null;
  const due = STAGE.miniBossSchedule[_miniBossIdx];
  return Math.max(0, due - overworldTime());
}

function spawnFinalBoss() {
  // Pick the highest-minD finale-eligible elite (dragon if unlocked, else
  // giant). Rare authored encounter elites such as Moonwing opt out so adding
  // a late-wave enemy cannot silently replace every stage's tuned finale.
  // !t.dungeon is load-bearing: catacomb tiers (skel_warrior, minD 999) sit in
  // ENEMY_TIERS too, and their GLBs aren't loaded outside the catacomb —
  // picking one made spawnEnemy return null and the boss silently never spawn.
  const elites = ENEMY_TIERS.filter(t => t.elite && !t.dungeon && t.finalBossEligible !== false);
  const choice = elites.reduce((best, cur) => (!best || cur.minD > best.minD) ? cur : best, null);
  if (!choice) return;
  const buffed = {
    ...choice,
    displayName: nameForFinalBoss().name,
    hp: choice.hp * STAGE.finalBossHpMul,
    // ×2.2 (dragon 1.2 → 2.64): probes showed the finale boss was the
    // SLOWEST entity in the game — 80% of fight-seconds dealt zero boss
    // damage and a circle-strafer never engaged. Still slower than the
    // hero (8.0): kitable, but it now closes when you stop.
    spd: choice.spd * 2.2,
    scale: (choice.scale || 1) * STAGE.finalBossScaleMul,
    isFinalBoss: true,
  };
  const angle = _seedRand() * Math.PI * 2;
  const r = SPAWN.ringRadius * 1.5;
  const hp = state.hero.pos;
  let fbx = hp.x + Math.cos(angle) * r;
  let fbz = hp.z + Math.sin(angle) * r;
  const forest = state.run && state.run.stage && state.run.stage.id === 'forest';
  if (forest) {
    _fitForestRingPoint(hp, angle, r, 3);
    fbx = _forestSpawnX;
    fbz = _forestSpawnZ;
  }
  spawnEnemy(buffed, fbx, fbz);
  // P4D NG+ Twin Bosses (#143) — second final boss with ~3u tangential offset
  // (perpendicular to the ring radial so both bosses share the same ring
  // distance — keeps the visual "pair" framing). spawnEnemy strips unknown
  // tier fields, so _isTwin is stamped on the returned live enemy.
  if (state.modes && state.modes.ngTwin) {
    const offX = -Math.sin(angle) * 3;
    const offZ =  Math.cos(angle) * 3;
    let twinX = fbx + offX;
    let twinZ = fbz + offZ;
    if (forest && !isForestPositionPlayable(twinX, twinZ, 3)) {
      // Flip the small tangential offset inward instead of collapsing both
      // bosses onto the boundary clamp.
      twinX = fbx - offX;
      twinZ = fbz - offZ;
      if (!isForestPositionPlayable(twinX, twinZ, 3)) {
        twinX = constrainForestX(twinX, 3);
        twinZ = constrainForestZ(twinZ, 3);
      }
    }
    const twinEnemy = spawnEnemy(buffed, twinX, twinZ);
    if (twinEnemy) twinEnemy._isTwin = true;
  }
  state.fx.chromaticPulse = 1.0;
  state.fx.bloomBoost = 1.0;
  state.fx.shake = 0.8;
}

export function tickSpawnDirector(dt) {
  const t = overworldTime();

  // Detect restart (game time rewound)
  if (t < _lastSeenTime) {
    _acc = 0;
    _nextHorde = SPAWN.hordeIntervalSec;
    _nextChest = SPAWN.chestIntervalSec * 0.5;
    _finalBossWarned = false;
    _finalBossSpawned = false;
    _miniBossIdx = 0;
    _miniBossWarnedFor = -1;
    _miniBossWasAlive = false;
    _ebbUntil = 0;
    _lastAliveCount = 0;
    _nemesisState.active = null;
    _nemesisState.nextSpawnAt = _firstNemesisSpawnAt();
    _nemesisState.telegraphed = false;
    _nemesisState.angle = 0;
    // FE-C3A — drop any in-flight puzzle pause across restart.
    _pausedAtGameTime = null;
    _smoothingUntil = 0;
    _encounterPausedSec = 0;
    _scheduleBossRush = null;
    resetEnemyEncounterDeck();
    try { hideNemesisArrow(); } catch (_) {}
  }
  _lastSeenTime = t;

  // Do the rewind bookkeeping above, then stop before any ambient horde,
  // elite, chest, nemesis, or timer-final schedule can compete with Kaki
  // Land's deliberately quiet three-trial route.
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland') return;

  // ── Puzzle pause/resume (FE-C3A) + Lockdown pause (FOREST ITER C1) ──
  // Detect the PUZZLE_ACTIVE edge OR an active lockdown. While paused: record
  // pause time once and bail BEFORE any schedule advances or spawn work runs.
  // Updating _lastSeenTime above (BEFORE this bail) is mandatory so the
  // restart-rewind branch doesn't trip on every paused frame. Lockdown reuses
  // the puzzle pause path so horde/chest/nemesis timers all shift forward on
  // resume — the substitute wave dispatcher in src/lockdownArena.js owns
  // spawns while paused.
  const _roomState = state.run && state.run.roomState;
  const _lockdownActive = !!(state.run && state.run.lockdownActive);
  const _portalTrialActive = !!(state.run && state.run.forestTrialActive);
  const _forestPortalFinale = !!(state.run && state.run.stage
    && state.run.stage.id === 'forest'
    && !(state.modes && (state.modes.bossRush || state.modes.daily || state.modes.weekly)));
  if (_roomState === 'PUZZLE_ACTIVE' || _lockdownActive || _portalTrialActive) {
    // The final boss must not be blockable by idling in a puzzle: the hard
    // freeze below bails before the finalBossAt branch, so a run sitting in
    // PUZZLE_ACTIVE at 10:00 simply never got its boss. Force-end the puzzle
    // at boss time and fall through — the normal warn/spawn flow (incl. the
    // FE-C3A force-return) runs this same tick. Lockdowns are short and own
    // their own waves — let them finish; the boss fires on the resume edge.
    const _fbDue = !_forestPortalFinale && !(state.modes && state.modes.bossRush) && !_finalBossSpawned
      && t >= ((state.run && state.run.stageFinalBossAt) != null
                ? state.run.stageFinalBossAt : STAGE.finalBossAt);
    if (_roomState === 'PUZZLE_ACTIVE' && !_lockdownActive && !_portalTrialActive && _fbDue) {
      try { endPuzzleEarly(); } catch (_) {}
    } else {
      if (_pausedAtGameTime == null) _pausedAtGameTime = t;
      return; // hard freeze: no horde/chest/miniboss/finalboss/nemesis logic, no top-up
    }
  }
  // Resume edge: a puzzle just ended. Shift every scheduled timer forward by
  // the paused duration so D(t)-derived events don't dump a backlog at once.
  // Then arm the 30s density smoothing ramp (applied below in the swarmMul
  // chain). _pausedAtGameTime is the per-pause anchor; we treat it as the
  // "now" before pause started, so shift = t - _pausedAtGameTime.
  if (_pausedAtGameTime != null) {
    const pausedDur = t - _pausedAtGameTime;
    if (pausedDur > 0) {
      _nextHorde += pausedDur;
      _nextChest += pausedDur;
      _encounterPausedSec += pausedDur;
      // Mini-boss + final-boss schedules are absolute game-time values stored
      // in STAGE.miniBossSchedule / config; we can't mutate those, but we
      // CAN bump the warn/spawn watermarks indirectly by leaving them alone
      // (the schedule will simply fire later relative to wall-clock). For
      // continuous-flow consistency though, we DO advance the Nemesis next-
      // spawn watermark since it's an absolute timestamp:
      if (Number.isFinite(_nemesisState.nextSpawnAt)) {
        _nemesisState.nextSpawnAt += pausedDur;
      }
    }
    _smoothingUntil = t + SMOOTHING_WINDOW_SEC;
    _pausedAtGameTime = null;
  }

  // Boss-rush mode compresses the boss schedule and pauses the cannon-fodder
  // swarm to focus entirely on boss fights. Stage 2+ can also shift the
  // final-boss time (Twilight Hollow = 12 min instead of 15).
  const bossRush  = !!(state.modes && state.modes.bossRush);
  const stageFB   = state.run && state.run.stageFinalBossAt;
  const finalBossAt = bossRush
    ? 200
    : (stageFB != null ? stageFB : STAGE.finalBossAt);
  // Weekly BOSS_PARADE: a fourth mini-boss 60s before the final boss (was a
  // hardcoded 660s — tuned to the dead 15-min arc, it landed INSIDE the boss
  // fight). Only stacks onto the normal schedule (not boss-rush).
  const weeklyExtra = !bossRush && state.run && state.run.weeklyExtraMiniBoss;
  // Cached for the run: this used to spread/filter a new array on every frame.
  const miniSched = _resolveMiniSchedule(bossRush, finalBossAt, weeklyExtra);

  // ── Mini-boss schedule ──
  // Forest's normal route already owns six escalating room guardians. Do not
  // layer the legacy timed elites over that authored objective: a survivor
  // left in another portal room could otherwise make a visibly-ready Boss
  // Gate reject entry for reasons the player cannot see.
  if (!_forestPortalFinale && _miniBossIdx < miniSched.length) {
    const due = miniSched[_miniBossIdx];
    // Warn first
    if (_miniBossWarnedFor !== _miniBossIdx && t >= due - STAGE.miniBossWarnSec) {
      _miniBossWarnedFor = _miniBossIdx;
      showBanner('ELITE INCOMING', 3.0, '#ff8855');
      if (sfx && sfx.bossWarn) sfx.bossWarn();
    }
    // Spawn at due time
    if (t >= due) {
      spawnMiniBoss();
      const named = nameForMiniBoss(_miniBossIdx);
      showBanner(`${named.name} — ${named.subtitle.toUpperCase()}`, 2.6, '#ff8855');
      _miniBossIdx++;
    }
  }

  // ── Periodic chest spawn ──
  // Weekly CHEST_LOCKDOWN gates the entire schedule for the first N seconds
  // (default 300s = 5 min). We don't advance _nextChest during the lock window;
  // the first chest naturally spawns the instant the gate lifts because
  // _nextChest is already in the past.
  const weeklyChestLockSec = state.run && state.run.weeklyChestLockUntilSec ? state.run.weeklyChestLockUntilSec : 0;
  if (t >= _nextChest && t >= weeklyChestLockSec) {
    spawnChestNearHero(7, 14);
    // Luck shop upgrade speeds up the chest cadence by 3% per level.
    const luckMul = 1 - 0.03 * shopLevel('luck');
    const dailyMul = state.run && state.run.dailyChestMul ? state.run.dailyChestMul : 1;
    // Iter 11c — SHOP_TREE Greed tier-2 "Lucky Charm" (+0.05 per level) raises
    // chest spawn rate. Since chest cadence is expressed as an INTERVAL (lower
    // = more chests), a "+rate" bonus must DIVIDE the interval. Read is gated
    // by the weeklyChestLockUntilSec check above so the iter-9 weekly chest
    // lockdown still suppresses the entire schedule for its first N seconds.
    const passiveChestRate = (state.run && state.run.passive_chestRate) || 0;
    const chestRateDiv = 1 + passiveChestRate;
    _nextChest = t + (SPAWN.chestIntervalSec * luckMul * dailyMul) / chestRateDiv;
  }

  // ── Final boss warning + spawn ──
  if (!_forestPortalFinale && !_finalBossWarned && t >= finalBossAt - STAGE.finalBossWarnSec) {
    _finalBossWarned = true;
    showBanner('A POWERFUL FOE APPROACHES', 4.5, '#ff4444');
    if (sfx && sfx.bossWarn) sfx.bossWarn();
  }
  if (!_forestPortalFinale && !_finalBossSpawned && t >= finalBossAt) {
    _finalBossSpawned = true;
    // FE-C3A — boss force-return rule. If the hero is anywhere but the Glade
    // arena when the final boss is due (mid-puzzle, mid-transition, inside a
    // puzzle room), force-end the puzzle (no unlock), teleport hero to the
    // Glade center, fire a banner, then spawn the boss. Gated to Forest
    // stage so other stages keep their original boss-spawn flow.
    const onForest = !!(state.run && state.run.stage && state.run.stage.id === 'forest');
    const _curRoomState = state.run && state.run.roomState;
    if (onForest && _curRoomState !== 'ARENA') {
      try { endPuzzleEarly(); } catch (_) {}
      // Even if endPuzzleEarly didn't fire (e.g. no active puzzle but still
      // mid-transition), reset roomState explicitly so the spawn-pause path
      // can't re-engage while the boss is alive.
      state.run.roomState  = 'ARENA';
      state.run.currentRoom = 'glade';
      state.run.activePuzzle = null;
      // Teleport hero to glade center. FOREST_ROOMS.glade.center is {x,z}.
      const gladeCenter = FOREST_ROOMS.glade && FOREST_ROOMS.glade.center;
      if (gladeCenter && state.hero && state.hero.pos) {
        state.hero.pos.x = gladeCenter.x;
        state.hero.pos.z = gladeCenter.z;
        if (state.hero.mesh && state.hero.mesh.position) {
          state.hero.mesh.position.x = gladeCenter.x;
          state.hero.mesh.position.z = gladeCenter.z;
        }
      }
      // Palette-locked banner — C.amber-ish '#ffd27f' for "warning" hue per
      // existing FE banner conventions; '#ff5e5e' is C.red for danger weight.
      try { showBanner('⚠ FINAL BOSS — RETURNED TO GLADE', 4.0, '#ff5e5e'); } catch (_) {}
    }
    spawnFinalBoss();
    const _fb = nameForFinalBoss();   // stage-aware: cave → THE HOLLOW SOVEREIGN
    showBanner(`${_fb.name} — ${_fb.subtitle.toUpperCase()}`, 3.0, '#ffe14a');
  }

  // ── Nemesis Elite (C3 + Punch List #2) ──
  // Hunts player relentlessly, ignores standard wave logic. Single active.
  // Boss-rush mode pauses the nemesis schedule so the boss fights stay clean.
  //
  // Two-stage flow (Punch List #2):
  //   1. Telegraph at telegraphWave * waveSec — banner + arrow fire for ALL
  //      players (newbies AND vets). Pre-rolls the spawn angle so the arrow
  //      points where the hunter will appear.
  //   2. Spawn at wave * waveSec — gated by meta first-victory flag. If a
  //      newbie, the angle/arrow simply fade after arrowLifetimeSec and no
  //      hunter ever shows up this run (tension built for free, mechanic
  //      taught without overwhelming).
  if (!_forestPortalFinale && !bossRush
      && !_nemesisState.telegraphed && t >= _nemesisTelegraphAt()) {
    _nemesisState.telegraphed = true;
    _nemesisState.angle = _seedRand() * Math.PI * 2;
    try { showNemesisTease(_nemesisState.angle, NEMESIS_SPAWN.arrowLifetimeSec); } catch (_) {}
    if (sfx && sfx.bossWarn) sfx.bossWarn();
  }

  if (!_forestPortalFinale && !bossRush
      && _nemesisState.active === null && t >= _nemesisState.nextSpawnAt) {
    // Meta-gate: actual spawn only fires if player has won at least one
    // run. Telegraph already fired above for newbies.
    const isFirstSpawn = (_nemesisState.nextSpawnAt === _firstNemesisSpawnAt());
    const gateOK = !isFirstSpawn || _hasFirstVictory();
    if (!gateOK) {
      // New player: skip the spawn entirely AND push the next check past
      // wave 8 so we don't re-evaluate every tick. Respawn cadence path
      // never fires for newbies because we never set an active nemesis.
      _nemesisState.nextSpawnAt = Number.POSITIVE_INFINITY;
    } else {
      // Spawn at ring edge well off-screen so the player has 3s telegraph
      // time before the nemesis closes distance (4.0 u/s × 3s = 12u of
      // warning). Reuse the pre-rolled telegraph angle when available so the
      // arrow lines up with the actual spawn direction; fall back to a
      // fresh roll for respawn paths.
      const hp = state.hero.pos;
      const angle = (isFirstSpawn && _nemesisState.telegraphed)
        ? _nemesisState.angle
        : _seedRand() * Math.PI * 2;
      const r = NEMESIS_SPAWN.spawnRadius;
      let nx = hp.x + Math.cos(angle) * r;
      let nz = hp.z + Math.sin(angle) * r;
      if (state.run && state.run.stage && state.run.stage.id === 'forest') {
        // The Nemesis uses a wider ring than normal waves, but it still belongs
        // inside the visible Wildwood. Keep the pre-rolled angle as the first
        // candidate, then rotate deterministically only when that direction
        // would make the hunter emerge through the boundary trees.
        _fitForestRingPoint(hp, angle, r, 3);
        nx = _forestSpawnX;
        nz = _forestSpawnZ;
      }
      const ne = spawnNemesis(nx, nz);
      if (ne) {
        _nemesisState.active = ne;
        try { hideNemesisArrow(); } catch (_) {}
        showBanner('⚔ THE NEMESIS HUNTS', 3.0, '#ff2020');
        if (sfx && sfx.bossWarn) sfx.bossWarn();
        // Camera punch so the banner has weight.
        state.fx.chromaticPulse = Math.max(state.fx.chromaticPulse || 0, 0.7);
        state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
      }
    }
  }
  // Safety: if the active nemesis died via a path that didn't reach
  // onNemesisKilled (defensive — should never happen), clear the slot so
  // the next spawn isn't blocked forever.
  if (_nemesisState.active && _nemesisState.active.alive === false) {
    _nemesisState.active = null;
    if (t >= _nemesisState.nextSpawnAt) _nemesisState.nextSpawnAt = _rollNemesisRespawn(t);
  }

  _acc += dt;
  if (_acc < SPAWN.tickIntervalSec) return;
  _acc = 0;

  const D = computeDifficulty(t);

  const stageId = (state.run && state.run.stage && state.run.stage.id) || '';
  syncEnemyEncounterDeck(
    stageId,
    _enemyEncounterRunSeed(),
    Math.max(0, t - _encounterPausedSec),
    D,
  );

  // Tiers currently allowed by difficulty and native to this biome. This is
  // also a load-safety boundary: Forest bugs are stage-lazy-loaded and must
  // never leak into Twilight/Cinder/Void/Cave pools.
  _allowedTiers.length = 0;
  for (let i = 0; i < ENEMY_TIERS.length; i++) {
    const tier = ENEMY_TIERS[i];
    if (tier.minD <= D && isEnemyTierAllowedForStage(stageId, tier)) {
      _allowedTiers.push(tier);
    }
  }
  const allowedTiers = _allowedTiers;
  noteEnemyEncounterPoolSize(allowedTiers.length);
  if (allowedTiers.length === 0) return;

  // ── Arc beats: boss-alive scan ──
  // Feeds the horde defer, the post-miniboss ebb edge, and the pre-boss
  // surge below.
  let _miniAlive = false, _finalAlive = false;
  for (const e of state.enemies.active) {
    if (e.isMiniBoss) _miniAlive = true;
    else if (e.isFinalBoss) _finalAlive = true;
  }
  if (_miniBossWasAlive && !_miniAlive) _ebbUntil = t + EBB_WINDOW_SEC;
  _miniBossWasAlive = _miniAlive;

  // ── Continuous top-up ──
  const dailyMul  = state.run && state.run.dailySpawnMul  ? state.run.dailySpawnMul  : 1;
  const ruleMul   = state.run && state.run.stageRuleSpawnMul ? state.run.stageRuleSpawnMul : 1;
  const weeklyMul = state.run && state.run.weeklySpawnMul ? state.run.weeklySpawnMul : 1;
  // Iter 17 — Helltide mega-event multiplies the alive cap by ~2.5× for
  // the duration of the event. Composed with daily/rule/weekly so we
  // never compound past targetAliveCap (still hard-capped below).
  const helltideMul = state.run && state.run.helltideSpawnMul ? state.run.helltideSpawnMul : 1;
  // FE-C3A — Forest puzzle resume smoothing. For SMOOTHING_WINDOW_SEC after a
  // puzzle ends, lerp density 0.6 → 1.0 so the just-resumed horde clock
  // doesn't dump a giant wave on the player who just walked out of a 75s
  // puzzle. Forest-stage gated so other stages pay zero cost.
  let _puzzleSmoothMul = 1;
  if (_smoothingUntil > 0 && t < _smoothingUntil
      && state.run && state.run.stage && state.run.stage.id === 'forest') {
    const remaining = _smoothingUntil - t;
    const k = 1 - Math.max(0, Math.min(1, remaining / SMOOTHING_WINDOW_SEC));
    _puzzleSmoothMul = SMOOTHING_FLOOR + (1 - SMOOTHING_FLOOR) * k;
  }
  // P4D NG+ Mirror Mobs (#143) — +50% on the alive-cap target. Composes
  // multiplicatively into swarmMul alongside daily/rule/weekly/helltide and
  // the puzzle-smoothing ramp; targetAliveCap below still hard-caps the
  // composition so we never overshoot the engine's bookkeeping limit. The
  // alive-cap bump is the dominant lever for "+50% spawn" (matches the
  // existing hyper/weekly modifiers — they all bend the cap, not the cadence).
  const ngMirrorMul = (state.modes && state.modes.ngMirror) ? 1.5 : 1;
  // Post-miniboss ebb: loot-and-breathe beat for EBB_WINDOW_SEC after a
  // miniboss dies. Pre-boss surge: tension build for SURGE_WINDOW_SEC before
  // the next miniboss beat (or the final boss once all minis are done).
  const _ebbMul = (t < _ebbUntil) ? EBB_FLOOR_MUL : 1;
  // Finale spotlight: probes showed the final boss was out-threatened by its
  // own fodder (a stationary maxed hero died to swarm chip in 4.6s with zero
  // boss hits) and swarm XP fed 10 draft pauses mid-fight. Damp the ambient
  // swarm so the telegraph dance IS the fight.
  const _bossSpotlightMul = _finalAlive ? 0.35 : 1;
  const _nextBeatAt = _forestPortalFinale
    ? Infinity
    : (_miniBossIdx < miniSched.length ? miniSched[_miniBossIdx]
      : (_finalBossSpawned ? Infinity : finalBossAt));
  const _surgeMul = (t >= _nextBeatAt - SURGE_WINDOW_SEC && t < _nextBeatAt) ? SURGE_MUL : 1;
  // Weekly DOUBLE_SPAWNS multiplies the target alive cap. Compose with daily +
  // stage-rule swarms so a Daily SWARM_DAY happening to be Weekly DOUBLE_SPAWNS
  // doesn't compound past targetAliveCap (still hard-capped below).
  const swarmMul = dailyMul * ruleMul * weeklyMul * helltideMul * _puzzleSmoothMul * ngMirrorMul * _ebbMul * _surgeMul * _bossSpotlightMul;
  // Boss rush: tiny ambient swarm (3-4 alive) so the player still has XP and
  // pickups, but the focus is the bosses.
  // Fun-loop iter 1.1 — opening ramp: base alive count lerps 45 → 100 over
  // the first targetAliveRampSec so minute 1 isn't a maxed-out fodder shower
  // (was: instant 128 alive = 10 level-ups in 16s + AFK env-hazard farm).
  const _rampK = Math.min(1, t / (SPAWN.targetAliveRampSec || 90));
  const baseAlive = SPAWN.targetAliveBase + (SPAWN.targetAliveRampAdd || 0) * _rampK;
  const target = bossRush
    ? 4
    : Math.min(
        SPAWN.targetAliveCap,
        (baseAlive + D * SPAWN.targetAlivePerD) * swarmMul
      );
  // Mass-despawn detector: sealed-room exits (IN_ROOM → ARENA) retire all
  // off-room mobs in one tick WITHOUT going through the puzzle pause path,
  // so nothing armed the smoothing window and the top-up backfilled the
  // full deficit at 213/s onto the hero. Any >80 one-tick collapse arms it.
  const _aliveNow = state.enemies.active.length;
  if (_lastAliveCount - _aliveNow > 80) {
    _smoothingUntil = Math.max(_smoothingUntil, t + 15);
  }
  _lastAliveCount = _aliveNow;

  const deficit = target - state.enemies.active.length;
  if (deficit > 0) {
    // During the post-puzzle/room smoothing window, cap the REFILL RATE too —
    // the smoothing multiplier only lowers the target, but at 32/tick (213/s)
    // a room exit still backfilled 21 → 345 alive in <3s, materializing on
    // top of the hero (the one unfair death class left in playtests). 6/tick
    // = ~40/s rebuilds the field over ~8s instead.
    const _batchCap = (_smoothingUntil > 0 && t < _smoothingUntil)
      ? 6 : SPAWN.spawnBatchPerTick;
    const n = Math.min(_batchCap, Math.ceil(deficit));
    for (let i = 0; i < n; i++) {
      const tier = weightedPick(allowedTiers, 1);
      const angle = _seedRand() * Math.PI * 2;
      spawnOnRing(tier, angle);
    }
  }

  // ── Horde event ──
  if (t >= _nextHorde) {
    // Defer while a boss is alive (noise), during the post-boss ebb (a 70-count
    // burst would erase the loot-and-breathe beat the ebb exists for), or when
    // a boss beat is due within 20s (don't pre-stomp the warn banner). The
    // deferred horde then lands as the opening punch of the next build phase.
    if (_miniAlive || _finalAlive || t < _ebbUntil || (_nextBeatAt - t) < 20) {
      _nextHorde = t + HORDE_DEFER_SEC;
    } else {
      // Mid-tier: allowed by D, not elite. Fall back to allowed if filter is empty.
      _hordeTiers.length = 0;
      for (let i = 0; i < allowedTiers.length; i++) {
        const tier = allowedTiers[i];
        if (!tier.elite) _hordeTiers.push(tier);
      }
      const pool = _hordeTiers.length > 0 ? _hordeTiers : allowedTiers;

      // Tight arc on one side of hero
      const center = _seedRand() * Math.PI * 2;
      const arc = Math.PI / 3; // 60° spread
      for (let i = 0; i < SPAWN.hordeCount; i++) {
        const tier = weightedPick(pool, 2);
        const angle = center + (_seedRand() - 0.5) * arc;
        spawnOnRing(tier, angle);
      }

      state.fx.chromaticPulse = 0.8;
      state.fx.bloomBoost = 0.5;
      _nextHorde += SPAWN.hordeIntervalSec;
    }
  }

}
