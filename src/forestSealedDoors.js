/**
 * Forest Sealed Door Room Progression — FOREST-V2-A14 (2026-05-17).
 *
 * Canonical Forest portal-trial coordinator. A normal run owns six authored
 * side-room trials. Activating an outbound Glade portal starts two compact
 * enemy waves plus a guardian; the return gate stays sealed until every tagged
 * trial enemy is dead. Clearing all six awakens the fixed Boss Gate.
 *
 * Glade is the hub — its portals NEVER seal; the hero can always go OUT
 * to a room. Only the room→glade RETURN portal seals (player can run away
 * back to glade only after clearing the boss). This matches the brief's
 * design note: "all 6 sealed rooms only connect to glade (radial layout)".
 *
 * ── State (per run, lives in state.run._sealedRooms) ───────────────────────
 *   _sealedRooms[roomId] = { bossId, alive: boolean }
 * Initialized to {} by resetState() in state.js. Keyed by room id so re-
 * entry can distinguish "never visited" (key missing) vs "visited, boss
 * still alive" (alive=true) vs "cleared" (alive=false, key kept).
 *
 * ── Boss tagging ───────────────────────────────────────────────────────────
 * Spawned enemies are stamped with `_isRoomBoss = true` and `_roomBossId =
 * roomId`. enemies.killEnemy() calls onRoomBossKilled() early in its death
 * branch (single-line check) so the unseal fires reliably regardless of
 * which kill path resolves the death (signature weapon, contact, DoT).
 *
 * ── Difficulty band ────────────────────────────────────────────────────────
 * Tier selection is time-banded so early rooms feel beatable:
 *   t < 300s   → lowest-minD elite available
 *   t < 900s   → any elite already in pool at current difficulty
 *   t ≥ 900s   → highest-minD elite available
 * In the FE-V0.2 elite pool there are only TWO elites (giant minD=6.0,
 * dragon minD=7.0) so the time bands collapse to "giant early, dragon
 * late" — recorded for future tuning when the elite pool grows.
 *
 * Cumulative HP scale per cleared sealed room: hpMul *= (1 + cleared*0.2).
 * Applied AFTER spawnEnemy bakes the base hp/hpMax (we multiply both fields
 * post-spawn so kill-bar math stays consistent with the spawnEnemy formula).
 *
 * ── Portal sealing ─────────────────────────────────────────────────────────
 * forestPortals.js owns the Blender-authored living gate geometry. We mutate
 * portal records via getForestPortals() and its presentation-only state seam:
 *   portal._sealed       = true|false   (consumed by _findReadyPortalNearHero)
 *   portal.gateVisualState = AVAILABLE|SEALED|CLEARED
 * Tint still goes slot-6 amber, while SEALED physically closes the thorn
 * shutters and hides the veil. Unseal restores the cached colors and reveals
 * the CLEARED moonbloom state. Mechanics remain `_sealed`-authoritative.
 *
 * ── Proximity prompt ───────────────────────────────────────────────────────
 * When hero is within 3u of a sealed portal AND the room boss is alive,
 * show a single DOM overlay "SEALED — clear room first" near screen-bottom
 * (no world-space anchor needed — VS-style center prompt is enough at this
 * production tier; mirrors the lockdown banner shape without the slam FX).
 * Auto-hides when the hero leaves the radius or the boss dies.
 *
 * ── Palette (slot-locked; no new hex constants) ────────────────────────────
 *   slot 6 #f5a300 — sealed tint (re-used from COLOR_AMBER_IDLE)
 *   slot 7 #ffd86b — sealed pulse peak (re-used from COLOR_AMBER_FLASH)
 *
 * ── Hard caps ──────────────────────────────────────────────────────────────
 *   - At most ONE boss spawn per room per run (state.run._sealedRooms gate).
 *   - Banner uses showBanner() from ui.js — same hook the reaper cohort uses.
 *   - All mutations are static-import, no dynamic imports in the hot path.
 *
 * Public API:
 *   loadForestSealedDoors(scene, state) — once-per-scene init (no geometry
 *                                          this module spawns; sets up the
 *                                          DOM prompt + state ref).
 *   tickForestSealedDoors(state, dt)    — pulse sealed portal tint + manage
 *                                          proximity prompt visibility.
 *   onRoomEnter(roomId)                 — called by main.js when the room
 *                                          transition detects a new room id;
 *                                          spawns boss + seals on first entry.
 *   onRoomBossKilled(enemy)             — called by enemies.killEnemy on the
 *                                          `_isRoomBoss` death branch.
 *   disposeForestSealedDoors()          — removes DOM prompt; clears state.
 */
import { state as _gameState } from './state.js';
import { ENEMY_TIERS, SPAWN } from './config.js';
import { FOREST_ROOMS, FOREST_TRIAL_ROOM_IDS } from './forestRooms.js';
import { spawnEnemy } from './enemies.js';
import {
  getForestPortals,
  setForestPortalGateState,
  COLOR_AMBER_IDLE,
  COLOR_AMBER_FLASH,
} from './forestPortals.js';
import { preloadDungeonKit } from './assets.js';
import { sfx } from './audio.js';
import { showBanner } from './ui.js';

// ── tuning constants ─────────────────────────────────────────────────────────
const PROMPT_RADIUS              = 3.0;
const PROMPT_RADIUS_SQ           = PROMPT_RADIUS * PROMPT_RADIUS;
const SEAL_PULSE_HZ              = 1.2;       // gentle "still sealed" pulse
const SEAL_EMISSIVE_MIN          = 1.4;       // matches portal idle min
const SEAL_EMISSIVE_MAX          = 2.6;       // peak warning intensity
const CLEAR_BANNER_SEC           = 2.0;
const CLEAR_BANNER_COLOR         = '#f5a300'; // slot 6 amber gold per brief
const TRIAL_WAVES                = 3;         // two packs + one guardian
const WAVE_INTERMISSION_SEC      = 0.9;
const GUARDIAN_HP_MUL            = 1.65;
const GUARDIAN_SCALE_MUL         = 1.2;

const ROOM_ROSTERS = Object.freeze({
  saphollow:      Object.freeze(['slime', 'beetle', 'caterpillar']),
  crystalchoir:   Object.freeze(['butterfly', 'wizard', 'ghost']),
  amberlabyrinth: Object.freeze(['beetle', 'mantis', 'wasp']),
  bramblemaze:    Object.freeze(['spider', 'wolf', 'mantis']),
  mossroot:       Object.freeze(['ant', 'slime', 'caterpillar']),
  glowfen:        Object.freeze(['ghost', 'wasp', 'butterfly']),
});
const TIER_BY_GLB = Object.freeze(Object.fromEntries(ENEMY_TIERS.map((tier) => [tier.glb, tier])));

// Same difficulty curve as spawnDirector.computeDifficulty / enemies._computeDifficulty
// (kept inline so we don't reach into private helpers). Matches the published
// rampHpPerD scaling used by spawnEnemy at lines 371-374 of enemies.js.
function _computeD(gameTime) {
  // Mirrors src/spawnDirector.js via the SPAWN constants (a hardcoded copy of
  // this formula went stale when the curve compressed to 660s and silently
  // locked sealed-room bosses to giants for the whole run).
  const t = Math.max(0, gameTime || 0);
  const ramp = SPAWN.difficultyRampSec || 60;
  if (t <= ramp) return t / ramp;
  const span = (SPAWN.difficultyMaxSec || 660) - ramp;
  return Math.min(SPAWN.difficultyMax || 10,
    1.0 + (t - ramp) * ((SPAWN.difficultyMax - 1) / span));
}

// ── module state ─────────────────────────────────────────────────────────────
let _stateRef = null;
let _promptEl = null;
let _promptVisible = false;
let _pulseT = 0;

// Per-boss bookkeeping — keyed by roomId so we can null out the live enemy
// reference on death without iterating state.enemies.active.
const _bossByRoom = Object.create(null);

// Cache of portal seal originals (per portal id) so unsealing restores the
// exact pre-seal hex values (which may differ from defaults if some other
// cohort recolored a portal mid-run — defensive).
const _sealCache = Object.create(null);

function _isSpecialObjectiveMode(state) {
  return !!(state && state.modes
    && (state.modes.bossRush || state.modes.daily || state.modes.weekly));
}

function _newTrialState() {
  const rooms = {};
  for (const id of FOREST_TRIAL_ROOM_IDS) {
    rooms[id] = { status: 'AVAILABLE', wave: 0, waves: TRIAL_WAVES, live: 0, phase: 'IDLE' };
  }
  return {
    rooms,
    cleared: 0,
    total: FOREST_TRIAL_ROOM_IDS.length,
    bossUnlocked: false,
    bossDefeated: false,
    activeRoom: null,
  };
}

function _ensureTrialState(state) {
  if (!state || !state.run) return null;
  let trial = state.run.forestPortalTrials;
  if (!trial || !trial.rooms || trial.total !== FOREST_TRIAL_ROOM_IDS.length) {
    trial = _newTrialState();
    state.run.forestPortalTrials = trial;
  }
  return trial;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Pick a miniboss tier from ENEMY_TIERS based on game time. Three bands per
 * brief; with only 2 elites in the current pool (giant minD=6.0, dragon
 * minD=7.0) the bands map to:
 *   0-300s   → giant (lowest-minD elite still in difficulty window)
 *   300-900s → giant if D not yet up to dragon, else dragon
 *   900s+    → dragon (highest-minD elite)
 * Fallback: if NO elites match D (e.g. very early run, D=0 → both elites
 * gated out by minD), use the entire elite pool unfiltered so we always
 * have a boss to spawn.
 */
function _pickBossTier(gameTime) {
  const D = _computeD(gameTime);
  // !t.dungeon: catacomb elites (skel_warrior, minD 999) live in ENEMY_TIERS
  // but their GLBs aren't loaded outside the catacomb — picking one makes the
  // room boss silently fail to spawn.
  const allElites = ENEMY_TIERS.filter(t => t.elite && !t.dungeon);
  if (allElites.length === 0) return null;
  // Sort ascending by minD so [0] = easiest, [last] = hardest.
  const sorted = allElites.slice().sort((a, b) => (a.minD || 0) - (b.minD || 0));

  // Bands scaled to the 10-min arc (was 300/900 on the dead 15-min arc).
  let tier;
  if (gameTime < 150) {
    // Easy band — lowest-minD elite (whether or not difficulty has caught up).
    tier = sorted[0];
  } else if (gameTime < 480) {
    // Mid band — pick the hardest elite currently in difficulty window, else
    // fall back to lowest-minD elite.
    const allowed = sorted.filter(t => t.minD <= D + 1);
    tier = allowed.length > 0 ? allowed[allowed.length - 1] : sorted[0];
  } else {
    // Hard band — top elite.
    tier = sorted[sorted.length - 1];
  }
  return tier;
}

function _roomSeed(roomId) {
  let h = 2166136261;
  for (let i = 0; i < roomId.length; i++) h = Math.imul(h ^ roomId.charCodeAt(i), 16777619);
  return h >>> 0;
}

function _liveTrialCount(state, roomId) {
  const active = state && state.enemies && state.enemies.active;
  if (!active) return 0;
  let n = 0;
  for (let i = 0; i < active.length; i++) {
    const enemy = active[i];
    if (enemy && enemy.alive && enemy._forestTrialRoom === roomId) n++;
  }
  return n;
}

function _tagTrialEnemy(enemy, roomId, wave) {
  if (!enemy) return null;
  enemy._forestTrialRoom = roomId;
  enemy._forestTrialWave = wave;
  enemy.room = roomId;
  return enemy;
}

function _spawnTrialWave(state, roomId, waveIndex) {
  const trial = _ensureTrialState(state);
  const room = FOREST_ROOMS[roomId];
  const rec = trial && trial.rooms[roomId];
  if (!trial || !room || !rec || rec.status !== 'ACTIVE') return 0;

  const wave = waveIndex + 1;
  rec.wave = wave;
  rec.phase = 'FIGHTING';
  rec.nextWaveAt = 0;
  let spawned = 0;
  const seed = _roomSeed(roomId) + waveIndex * 977 + trial.cleared * 131;
  const baseAngle = (seed % 6283) / 1000;
  const inset = 4;

  if (wave === TRIAL_WAVES) {
    const tier = _pickBossTier((state.time && state.time.game) || 0);
    if (tier) {
      const angle = baseAngle + 0.7;
      const x = Math.max(room.bounds.minX + inset, Math.min(room.bounds.maxX - inset,
        room.center.x + Math.cos(angle) * 7));
      const z = Math.max(room.bounds.minZ + inset, Math.min(room.bounds.maxZ - inset,
        room.center.z + Math.sin(angle) * 7));
      // Stamp isMiniBoss after spawn so six compact trials do not each fire the
      // full-screen boss-intro cinematic; kill rewards and boss bars still work.
      const enemy = _tagTrialEnemy(spawnEnemy({
        ...tier,
        hp: tier.hp * GUARDIAN_HP_MUL,
        scale: (tier.scale || 1) * GUARDIAN_SCALE_MUL,
        displayName: `${room.name.toUpperCase()} GUARDIAN`,
      }, x, z), roomId, wave);
      if (enemy) {
        const clearedScale = 1 + trial.cleared * 0.12;
        enemy.hp *= clearedScale;
        enemy.hpMax *= clearedScale;
        enemy.isMiniBoss = true;
        enemy._isRoomBoss = true;
        enemy._heavy = true;
        enemy._noKnockback = true;
        enemy._roomBossId = roomId;
        enemy.displayName = `${room.name.toUpperCase()} GUARDIAN`;
        _bossByRoom[roomId] = enemy;
        rec.bossId = tier.glb;
        spawned = 1;
      }
    }
    try { showBanner(`${room.name.toUpperCase()} — GUARDIAN`, 1.8, '#ffb35c'); } catch (_) {}
  } else {
    const roster = ROOM_ROSTERS[roomId] || ['ant', 'beetle', 'spider'];
    const count = Math.min(10, 5 + waveIndex * 2 + Math.floor(trial.cleared / 2));
    const D = _computeD((state.time && state.time.game) || 0);
    const fallback = ENEMY_TIERS.find((tier) => !tier.elite && !tier.dungeon && tier.minD <= D + 1.2)
      || ENEMY_TIERS.find((tier) => !tier.elite && !tier.dungeon);
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (i / count) * Math.PI * 2;
      const radius = 7 + ((seed + i * 17) % 5);
      const x = Math.max(room.bounds.minX + inset, Math.min(room.bounds.maxX - inset,
        room.center.x + Math.cos(angle) * radius));
      const z = Math.max(room.bounds.minZ + inset, Math.min(room.bounds.maxZ - inset,
        room.center.z + Math.sin(angle) * radius));
      const themed = TIER_BY_GLB[roster[(i + waveIndex) % roster.length]];
      const tier = themed && themed.minD <= D + 2.2 ? themed : fallback;
      const enemy = _tagTrialEnemy(tier ? spawnEnemy(tier, x, z) : null, roomId, wave);
      if (enemy) spawned++;
    }
    try { showBanner(`${room.name.toUpperCase()} — WAVE ${wave} / ${TRIAL_WAVES}`, 1.7, '#ffd86b'); } catch (_) {}
  }

  rec.live = spawned;
  if (state.run && state.run._sealedRooms) {
    state.run._sealedRooms[roomId] = { bossId: rec.bossId || 'trial-wave', alive: true, wave };
  }
  return spawned;
}

function _completeTrialRoom(state, roomId, enemy = null) {
  const trial = _ensureTrialState(state);
  const rec = trial && trial.rooms[roomId];
  if (!trial || !rec || rec.status === 'CLEARED') return false;
  rec.status = 'CLEARED';
  rec.phase = 'CLEARED';
  rec.live = 0;
  rec.wave = TRIAL_WAVES;
  trial.activeRoom = null;
  trial.cleared = FOREST_TRIAL_ROOM_IDS.reduce(
    (sum, id) => sum + (trial.rooms[id] && trial.rooms[id].status === 'CLEARED' ? 1 : 0), 0,
  );
  const justUnlocked = !trial.bossUnlocked && trial.cleared >= trial.total;
  trial.bossUnlocked = trial.cleared >= trial.total;
  // Begin the one sizeable transition load before the player reaches the
  // gate. Five cleared rooms is late enough to avoid paying for dungeon assets
  // in abandoned runs, while the final trial gives the browser useful overlap.
  if (trial.cleared >= Math.max(1, trial.total - 1)) {
    preloadDungeonKit().catch(() => {});
  }
  // The combat is complete, but the trial room still owns spawning until the
  // hero uses its newly-opened return gate. Otherwise the regular director can
  // refill the chamber on the very next frame and muddy the clear moment.
  // onRoomEnter('glade') releases this pause after the portal transfer.
  state.run.forestTrialActive = state.run.currentRoom !== 'glade';
  state.run.roomState = state.run.currentRoom === 'glade' ? 'ARENA' : 'IN_ROOM';
  state.run.portalShards = Math.min(5, trial.cleared); // legacy ambience-growth seam
  if (!state.run._sealedRooms) state.run._sealedRooms = {};
  state.run._sealedRooms[roomId] = {
    bossId: (enemy && (enemy.glbKey || enemy.displayName)) || rec.bossId || 'guardian',
    alive: false,
    wave: TRIAL_WAVES,
  };
  if (_bossByRoom[roomId] === enemy || !enemy) _bossByRoom[roomId] = null;
  const portal = _findReturnPortalForRoom(roomId);
  if (portal) _applyUnsealVisual(portal);
  try {
    showBanner(justUnlocked
      ? 'ALL GROVE TRIALS CLEARED — BOSS GATE AWAKENED'
      : `TRIAL CLEARED  ${trial.cleared} / ${trial.total}`,
    justUnlocked ? 3.4 : CLEAR_BANNER_SEC,
    justUnlocked ? '#d8a0ff' : CLEAR_BANNER_COLOR);
  } catch (_) {}
  try { if (sfx && sfx.evolutionChime) sfx.evolutionChime(); } catch (_) {}
  if (state.fx) state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, justUnlocked ? 1 : 0.6);
  return true;
}

/**
 * Find the return portal whose room matches roomId. Return portals seal in
 * the room↔glade pair (per brief design): the return portal is the one
 * sitting INSIDE the puzzle/relic room, with destRoomId='glade'.
 *
 * Returns null silently if forestPortals hasn't been loaded yet (e.g. first
 * tick of a transition before the load fires).
 */
function _findReturnPortalForRoom(roomId) {
  const portals = getForestPortals();
  if (!portals) return null;
  for (const p of portals) {
    if (p.kind === 'return' && p.roomId === roomId) return p;
  }
  return null;
}

/**
 * Snapshot the portal's current colors so unsealing restores precisely.
 * We cache per-portal-id (NOT per-roomId) so re-seal/unseal cycles within
 * one run reuse the same snapshot — defensive against a future code path
 * that re-seals after unseal (e.g. multi-boss room variant).
 */
function _cachePortalColors(portal) {
  if (_sealCache[portal.id]) return; // first cache wins (preserve pre-mod state)
  const disc = portal.discMat && portal.discMat.emissive
    ? portal.discMat.emissive.getHex() : null;
  const rim = portal.rimMat && portal.rimMat.color
    ? portal.rimMat.color.getHex() : null;
  const crystal = portal.crystalMat && portal.crystalMat.emissive
    ? portal.crystalMat.emissive.getHex() : null;
  _sealCache[portal.id] = {
    discEmissive: disc,
    rimColor: rim,
    crystalEmissive: crystal,
    baseColorHex: portal.baseColorHex,
  };
}

/**
 * Apply slot-6 amber tint to the portal materials so it reads as "warning,
 * sealed". We mutate emissive/color (not the disc.color which is the slot-2
 * crystal undertone) so the portal still looks like a portal — just with a
 * hot amber rim and floating glyph.
 */
function _applySealVisual(portal) {
  if (!portal) return;
  _cachePortalColors(portal);
  if (portal.discMat && portal.discMat.emissive) {
    portal.discMat.emissive.setHex(COLOR_AMBER_IDLE);
  }
  if (portal.rimMat && portal.rimMat.color) {
    portal.rimMat.color.setHex(COLOR_AMBER_IDLE);
  }
  if (portal.crystalMat && portal.crystalMat.emissive) {
    portal.crystalMat.emissive.setHex(COLOR_AMBER_IDLE);
  }
  // Hide cooldown ring while sealed — the cooldown UX is irrelevant when
  // the portal can't be used at all.
  if (portal.cooldownRing && portal.cooldownRing.mat) {
    portal.cooldownRing.mat.opacity = 0;
    if (portal.cooldownRing.mesh) portal.cooldownRing.mesh.visible = false;
  }
  // Override base color hex so forestPortals.tick's pulse loop keeps the
  // sealed tint on PASS 1 (it writes peakColorHex on peak, baseColorHex
  // otherwise). Stash the original first.
  portal._sealed = true;
  portal.baseColorHex = COLOR_AMBER_IDLE;
  portal.peakColorHex = COLOR_AMBER_FLASH;
  setForestPortalGateState(portal, 'SEALED');
}

/**
 * Restore the portal to its pre-seal colors. Reads from _sealCache so a
 * mid-run color change (e.g. cohort N adds a stage-rule tint) is preserved.
 */
function _applyUnsealVisual(portal) {
  if (!portal) return;
  portal._sealed = false;
  const cache = _sealCache[portal.id];
  if (cache) {
    if (cache.discEmissive != null && portal.discMat && portal.discMat.emissive) {
      portal.discMat.emissive.setHex(cache.discEmissive);
    }
    if (cache.rimColor != null && portal.rimMat && portal.rimMat.color) {
      portal.rimMat.color.setHex(cache.rimColor);
    }
    if (cache.crystalEmissive != null && portal.crystalMat && portal.crystalMat.emissive) {
      portal.crystalMat.emissive.setHex(cache.crystalEmissive);
    }
    if (cache.baseColorHex != null) {
      portal.baseColorHex = cache.baseColorHex;
    }
    // Reset the peak so it matches the post-restore baseColor's natural pair
    // (the original portal init set peakColorHex = COLOR_AMBER_FLASH for all
    // portals; keep that constant since both kinds flash slot-7 on activate).
    portal.peakColorHex = COLOR_AMBER_FLASH;
    delete _sealCache[portal.id];
  }
  // A cleared room opens onto a visibly flowered return gate instead of only
  // restoring the old mint tint. This is presentation-only; `_sealed=false`
  // above remains the authoritative interaction state.
  setForestPortalGateState(portal, 'CLEARED');
}

/**
 * Build (or recover) the proximity prompt DOM overlay. Lives on document.body
 * (same root the lockdown banner uses, traversed by ui.js — keeps things
 * consistent without coupling to ui's internal _root reference).
 */
function _ensurePromptEl() {
  if (_promptEl) return _promptEl;
  if (typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.id = 'kk-sealed-prompt';
  el.style.cssText = [
    'position: fixed',
    'left: 50%',
    'bottom: 18%',
    'transform: translateX(-50%)',
    'font-family: monospace',
    'font-size: 14px',
    'font-weight: 800',
    'letter-spacing: 0.10em',
    'color: #f5a300',
    'text-shadow: 0 2px 10px rgba(0,0,0,0.65), 0 0 16px #f5a30055',
    'pointer-events: none',
    'z-index: 70',
    'padding: 8px 18px',
    'background: linear-gradient(180deg, rgba(20,18,10,0.72), rgba(8,7,4,0.78))',
    'border-top: 1px solid #f5a30066',
    'border-bottom: 1px solid #f5a30066',
    'box-shadow: 0 8px 24px rgba(0,0,0,0.55)',
    'white-space: nowrap',
    'opacity: 0',
    'transition: opacity 0.15s ease-out',
  ].join('; ') + ';';
  el.textContent = 'SEALED — clear room first';
  document.body.appendChild(el);
  _promptEl = el;
  _promptVisible = false;
  return el;
}

function _showPrompt() {
  if (!_promptEl) return;
  if (_promptVisible) return;
  _promptVisible = true;
  _promptEl.style.opacity = '1';
}

function _hidePrompt() {
  if (!_promptEl) return;
  if (!_promptVisible) return;
  _promptVisible = false;
  _promptEl.style.opacity = '0';
}

export function syncForestSealedDoorUiVisibility(state) {
  const active = !!(state && state.started && state.mode === 'run'
    && !state.gameOver && !state.pendingLevelUp
    && !(state.time && state.time.paused)
    && state.run && state.run.stage && state.run.stage.id === 'forest');
  if (!active) _hidePrompt();
}

// ── public: load ─────────────────────────────────────────────────────────────

/**
 * Once-per-scene init. Mirrors the gated-load shape used by every other
 * FOREST-V2 module (chests, reaper, neutrals, etc.). Idempotent.
 *
 * @param {THREE.Scene} scene
 * @param {object} state
 */
export function loadForestSealedDoors(scene, state) {
  void scene; // no scene geometry — module is event-driven over existing portals
  _stateRef = state || _gameState;
  _ensurePromptEl();
  // Defensive: if state.run._sealedRooms hasn't been initialized by
  // resetState (legacy save or test harness), seed it here so onRoomEnter
  // can safely write into it without an undefined-key crash.
  if (_stateRef && _stateRef.run && !_stateRef.run._sealedRooms) {
    _stateRef.run._sealedRooms = {};
  }
  if (_stateRef && !_isSpecialObjectiveMode(_stateRef)) _ensureTrialState(_stateRef);
  _pulseT = 0;
}

// ── public: tick ─────────────────────────────────────────────────────────────

/**
 * Per-frame tick. Cheap fast-path when no seals are active: a single loop
 * over getForestPortals() with an early continue on `!portal._sealed`.
 *
 * Two responsibilities:
 *   1. Pulse the slot-6 emissive intensity on sealed portal disc/rim so the
 *      "sealed" state reads visually (calm steady pulse, slower than the
 *      portal's own idle pulse so the two layers don't beat against each other).
 *   2. Show/hide the proximity prompt based on hero distance to the NEAREST
 *      sealed portal (single prompt, single z-order).
 *
 * @param {object} state
 * @param {number} dt
 */
export function tickForestSealedDoors(state, dt) {
  if (!state || _isSpecialObjectiveMode(state)) return;
  const trial = _ensureTrialState(state);
  const portals = getForestPortals();
  if (!portals || portals.length === 0) {
    if (_promptVisible) _hidePrompt();
    return;
  }
  _pulseT += dt;

  const k = 0.5 + 0.5 * Math.sin(_pulseT * Math.PI * 2 * SEAL_PULSE_HZ);
  const emissive = SEAL_EMISSIVE_MIN + (SEAL_EMISSIVE_MAX - SEAL_EMISSIVE_MIN) * k;

  const hero = state.hero;
  const heroPos = hero && hero.pos;
  let nearestSealedD2 = Infinity;

  for (const portal of portals) {
    if (!portal._sealed) continue;
    if (portal.discMat) {
      portal.discMat.emissiveIntensity = emissive;
    }
    if (heroPos) {
      const dx = heroPos.x - portal.x;
      const dz = heroPos.z - portal.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestSealedD2) nearestSealedD2 = d2;
    }
  }

  // Prompt logic: show only while hero is alive, within radius, and game not
  // paused. Bails to hide otherwise so a paused-mid-prompt session resumes
  // cleanly without a stuck overlay.
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);
  const paused = !!(state.time && state.time.paused);
  if (heroAlive && !paused && nearestSealedD2 <= PROMPT_RADIUS_SQ) {
    const active = trial && trial.activeRoom && trial.rooms[trial.activeRoom];
    if (_promptEl && active) {
      _promptEl.textContent = `SEALED  •  WAVE ${active.wave} / ${active.waves}  •  ${active.live} LEFT`;
    }
    _showPrompt();
  } else {
    _hidePrompt();
  }

  // Exact trial-owned completion: unrelated overworld enemies never hold a
  // door shut. The director is paused while this flag is true, but this tag
  // check remains the authoritative source of truth.
  const roomId = trial && trial.activeRoom;
  const rec = roomId && trial.rooms[roomId];
  if (!roomId || !rec || rec.status !== 'ACTIVE' || state.mode !== 'run') return;
  rec.live = _liveTrialCount(state, roomId);
  if (rec.phase === 'FIGHTING' && rec.live === 0) {
    if (rec.wave >= TRIAL_WAVES) {
      // Guardian death normally arrives through onRoomBossKilled. This fallback
      // prevents a missing/retired visual from soft-locking the room.
      _completeTrialRoom(state, roomId, _bossByRoom[roomId]);
      return;
    }
    rec.phase = 'INTERMISSION';
    rec.nextWaveAt = ((state.time && state.time.game) || 0) + WAVE_INTERMISSION_SEC;
    try { showBanner(`WAVE ${rec.wave} CLEARED`, 1.2, '#9fe0bf'); } catch (_) {}
  }
  if (rec.phase === 'INTERMISSION'
      && ((state.time && state.time.game) || 0) >= rec.nextWaveAt) {
    const spawned = _spawnTrialWave(state, roomId, rec.wave);
    if (spawned === 0) _completeTrialRoom(state, roomId);
  }
}

// ── public: room entry hook ──────────────────────────────────────────────────

/**
 * Called by main.js::_tickForestRoomTransition the tick the hero's detected
 * room flips to a new id. Drives the per-run seal state machine:
 *
 *   - roomId === 'glade'                      → no-op (glade never seals)
 *   - record missing                          → spawn boss + seal portal
 *   - record exists, alive=true               → re-apply seal (defensive
 *                                                re-tint for cosmetic
 *                                                consistency; do NOT respawn)
 *   - record exists, alive=false              → no-op (already cleared)
 *
 * @param {string} roomId
 */
export function onRoomEnter(roomId, travel = null) {
  const state = _stateRef || _gameState;
  if (!state || !state.run) return;
  if (state.mode !== 'run' || !state.run.stage || state.run.stage.id !== 'forest') return;
  if (_isSpecialObjectiveMode(state)) return;
  const trial = _ensureTrialState(state);
  if (!roomId || roomId === 'glade') {
    state.run.forestTrialActive = false;
    if (trial) trial.activeRoom = null;
    return;
  }
  const room = FOREST_ROOMS[roomId];
  if (!room) return;

  if (!state.run._sealedRooms) state.run._sealedRooms = {};
  const rec = trial.rooms[roomId];
  if (!rec) return;
  if (rec.status === 'CLEARED') {
    // Already cleared this run — make sure the return portal is unsealed
    // and flowered. This is unconditional because a freshly rebuilt portal
    // starts AVAILABLE/_sealed=false even when the persisted trial is CLEARED.
    const portal = _findReturnPortalForRoom(roomId);
    if (portal) _applyUnsealVisual(portal);
    return;
  }

  if (rec.status === 'ACTIVE') {
    trial.activeRoom = roomId;
    state.run.forestTrialActive = true;
    state.run.roomState = 'PORTAL_TRIAL';
    const portal = _findReturnPortalForRoom(roomId);
    if (portal && !portal._sealed) _applySealVisual(portal);
    return;
  }

  // A trial may start only from the matching outbound portal activation.
  if (!travel || !travel.viaPortal || travel.kind !== 'outbound') return;
  rec.status = 'ACTIVE';
  rec.phase = 'PREPARING';
  rec.wave = 0;
  rec.live = 0;
  trial.activeRoom = roomId;
  state.run.forestTrialActive = true;
  state.run.roomState = 'PORTAL_TRIAL';
  state.run._sealedRooms[roomId] = { bossId: 'trial-wave', alive: true, wave: 0 };
  const portal = _findReturnPortalForRoom(roomId);
  if (portal) _applySealVisual(portal);
  _spawnTrialWave(state, roomId, 0);

  try { if (sfx && sfx.bossWarn) sfx.bossWarn(); } catch (_) {}
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.4);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.25);
  }
}

// ── public: room boss kill hook ──────────────────────────────────────────────

/**
 * Called by enemies.killEnemy() when an `_isRoomBoss`-tagged enemy dies.
 * Resolves the room id off the enemy, flips alive=false, unseals the return
 * portal, drops a chest, and shows the ROOM CLEARED banner.
 *
 * @param {object} enemy
 */
export function onRoomBossKilled(enemy) {
  if (!enemy) return;
  const state = _stateRef || _gameState;
  if (!state || !state.run) return;
  const roomId = enemy._roomBossId;
  if (!roomId) return;
  _completeTrialRoom(state, roomId, enemy);
}

// ── public: dispose ──────────────────────────────────────────────────────────

/**
 * Tear down DOM + module state. Idempotent. Safe to call on non-forest stages
 * (called by main.js stage-swap teardown). Does NOT touch portal materials —
 * forestPortals.disposeForestPortals owns those and clears the underlying
 * mesh tree (our cached hex values become orphaned on portal teardown, which
 * is fine since the cache is keyed by id and the next loadForestPortals
 * issues fresh ids).
 */
export function disposeForestSealedDoors() {
  if (_promptEl && _promptEl.parentNode) {
    _promptEl.parentNode.removeChild(_promptEl);
  }
  _promptEl = null;
  _promptVisible = false;
  _stateRef = null;
  _pulseT = 0;
  for (const k in _bossByRoom) delete _bossByRoom[k];
  for (const k in _sealCache) delete _sealCache[k];
}

// ── debug exports ────────────────────────────────────────────────────────────
export function _debugSealedRooms() {
  const state = _stateRef || _gameState;
  return state && state.run && state.run._sealedRooms
    ? JSON.parse(JSON.stringify(state.run._sealedRooms))
    : null;
}
export function _debugBossByRoom() { return { ..._bossByRoom }; }
export function _debugSealCache()  { return JSON.parse(JSON.stringify(_sealCache)); }

/** Stable read-only progress snapshot for UI, Catacomb gating, and QA. */
export function getForestTrialProgress() {
  const state = _stateRef || _gameState;
  const trial = state && state.run && state.run.forestPortalTrials;
  if (!trial) return null;
  return {
    cleared: trial.cleared || 0,
    total: trial.total || FOREST_TRIAL_ROOM_IDS.length,
    activeRoom: trial.activeRoom || null,
    bossUnlocked: !!trial.bossUnlocked,
    bossDefeated: !!trial.bossDefeated,
    rooms: Object.fromEntries(Object.entries(trial.rooms || {}).map(([id, rec]) => [id, { ...rec }])),
  };
}

export function _debugForestPortalTrials() {
  return getForestTrialProgress();
}
