/**
 * Kaki Land's three-trial portal progression.
 *
 * This deliberately owns only interaction and run-state progression. The
 * floating islands and portal meshes live in stages/kakiland/kakiLandStage,
 * while existing enemy / boss / victory systems continue to own combat.
 */
import { ENEMY_TIERS } from './config.js';
import { spawnEnemy } from './enemies.js';
import { sfx } from './audio.js';
import { showBanner } from './ui.js';
import { loadForestBossBars } from './forestBossBars.js';
import {
  beginKakiLandBossEncounter,
  disposeKakiLandBossEncounters,
  getKakiLandBossEncounterDebugState,
  loadKakiLandBossEncounters,
  notifyKakiLandEncounterEnemyKilled,
  tickKakiLandBossEncounter,
} from './kakiLandBossEncounters.js';
import { KAKI_LAND_PORTAL_LAYOUT } from './stages/kakiland/kakiLandPalette.js';
import {
  setKakiLandMainPortalUnlocked,
  setKakiLandTrialPortalCompleted,
} from './stages/kakiland/kakiLandStage.js';

const TRIALS = Object.freeze([
  Object.freeze({
    portalId: 'kaki-ember',
    stateKey: 'ember',
    banner: 'EMBER WARDEN',
    hint: 'Crossing cracks — the diagonals stay safe',
    color: '#ff9677',
    // Bespoke basalt cat-golem. Quake is the opening lesson; its Cinder Ward
    // then introduces Sparkmite priority adds before the roar/quake remix.
    boss: Object.freeze({ glb: 'kaki_ember_warden', family: 'kaki-boss', hp: 580, spd: 1.35, dmg: 18, scale: 2.1, elite: true, isMiniBoss: true, procAnim: 'pad', kakiLandPatternId: 'quake' }),
  }),
  Object.freeze({
    portalId: 'kaki-tide',
    stateKey: 'tide',
    banner: 'TIDEBORN WYRM',
    hint: 'The pull is coming — dash through the undertow',
    color: '#73e5ff',
    boss: Object.freeze({ glb: 'kaki_tideborn_wyrm', family: 'kaki-boss', hp: 650, spd: 1.18, dmg: 20, scale: 2.0, elite: true, isMiniBoss: true, procAnim: 'wisp', kakiLandPatternId: 'engulf' }),
  }),
  Object.freeze({
    portalId: 'kaki-bloom',
    stateKey: 'bloom',
    banner: 'BLOOM COLOSSUS',
    hint: 'Step outside the bloom before it screams',
    color: '#d3a8ff',
    boss: Object.freeze({ glb: 'kaki_bloom_colossus', family: 'kaki-boss', hp: 620, spd: 1.38, dmg: 21, scale: 2.2, elite: true, isMiniBoss: true, procAnim: 'pad', kakiLandPatternId: 'sonic' }),
  }),
]);

const MAIN_BOSS = Object.freeze({
  portalId: 'kaki-main',
  name: 'KAKI SOVEREIGN',
  banner: 'KAKI SOVEREIGN AWAKENS',
  hint: 'The three trials return — read every color',
  color: '#ffd27d',
  boss: Object.freeze({ glb: 'kaki_sovereign', family: 'kaki-boss', hp: 1600, spd: 1.22, dmg: 28, scale: 2.75, elite: true, isFinalBoss: true, procAnim: 'pad', kakiLandPatternId: 'cycle' }),
});

const TRIAL_BY_PORTAL = new Map(TRIALS.map((trial) => [trial.portalId, trial]));
const PORTAL_BY_ID = new Map([
  [KAKI_LAND_PORTAL_LAYOUT.main.id, KAKI_LAND_PORTAL_LAYOUT.main],
  ...KAKI_LAND_PORTAL_LAYOUT.trials.map((portal) => [portal.id, portal]),
]);

let _scene = null;
let _state = null;
let _activeBoss = null;
let _activePortalId = null;
let _promptPortalId = null;
let _nextInteractAt = 0;

function ensureProgress(s) {
  if (!s || !s.run) return null;
  if (!s.run.kakiLand) {
    s.run.kakiLand = {
      trials: { ember: false, tide: false, bloom: false },
      mainPortalUnlocked: false,
      mainBossSpawned: false,
    };
  }
  const progress = s.run.kakiLand;
  if (!progress.trials) progress.trials = { ember: false, tide: false, bloom: false };
  for (const trial of TRIALS) {
    if (typeof progress.trials[trial.stateKey] !== 'boolean') progress.trials[trial.stateKey] = false;
  }
  if (typeof progress.mainPortalUnlocked !== 'boolean') progress.mainPortalUnlocked = false;
  if (typeof progress.mainBossSpawned !== 'boolean') progress.mainBossSpawned = false;
  return progress;
}

function allTrialsComplete(progress) {
  return !!progress && TRIALS.every((trial) => progress.trials[trial.stateKey]);
}

function refreshPortalVisuals(s) {
  const progress = ensureProgress(s);
  if (!progress) return;
  for (const trial of TRIALS) {
    setKakiLandTrialPortalCompleted(trial.portalId, !!progress.trials[trial.stateKey]);
  }
  const unlocked = allTrialsComplete(progress);
  progress.mainPortalUnlocked = unlocked;
  setKakiLandMainPortalUnlocked(unlocked);
}

function runTime(s) {
  return (s && s.time && Number.isFinite(s.time.game)) ? s.time.game : 0;
}

function showOnce(portalId, title, subtitle, color, visible = true) {
  if (_promptPortalId === portalId) return;
  _promptPortalId = portalId;
  // `showBanner` is deliberately cinematic and large. A sealed central gate
  // is under the hero at run start, so do not cover the new map with a
  // repeated warning merely because the player spawned nearby. Locked/spent
  // details remain available on an explicit interaction; ready trial gates
  // still announce their enter prompt once on approach.
  if (!visible) return;
  // `showBanner` intentionally has one text line, so keep the portal name
  // and the action together rather than overwriting the first message.
  const message = subtitle ? `${title} — ${subtitle}` : title;
  try { showBanner(message, 1.8, color); } catch (_) {}
}

function portalStatus(portalId, progress) {
  if (portalId === MAIN_BOSS.portalId) {
    if (!allTrialsComplete(progress)) return { kind: 'locked', title: 'MAIN GATE SEALED', detail: 'Clear all three portal trials' };
    if (progress.mainBossSpawned) return { kind: 'spent', title: 'SOVEREIGN GATE', detail: 'The main boss has already answered' };
    return { kind: 'ready', title: 'KAKI SOVEREIGN', detail: 'Press E to enter the final portal', color: MAIN_BOSS.color };
  }

  const trial = TRIAL_BY_PORTAL.get(portalId);
  if (!trial) return { kind: 'locked', title: 'UNKNOWN PORTAL', detail: '' };
  if (progress.trials[trial.stateKey]) return { kind: 'spent', title: `${trial.banner} CLEARED`, detail: 'This portal is quiet now', color: trial.color };
  if (_activeBoss) return { kind: 'busy', title: 'TRIAL IN PROGRESS', detail: 'Defeat the active portal boss first', color: trial.color };
  return { kind: 'ready', title: trial.banner, detail: 'Press E to enter this portal', color: trial.color };
}

function nearestPortal(s) {
  if (!s || !s.hero || !s.hero.pos) return null;
  const hx = s.hero.pos.x;
  const hz = s.hero.pos.z;
  let best = null;
  for (const portal of PORTAL_BY_ID.values()) {
    const dx = hx - portal.x;
    const dz = hz - portal.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq > 5.9 * 5.9) continue;
    if (!best || distanceSq < best.distanceSq) best = { portal, distanceSq };
  }
  return best;
}

function findTier(glb) {
  return ENEMY_TIERS.find((tier) => tier.glb === glb) || null;
}

function spawnPortalBoss(s, portalId) {
  const progress = ensureProgress(s);
  const portal = PORTAL_BY_ID.get(portalId);
  if (!progress || !portal || _activeBoss || runTime(s) < _nextInteractAt) return false;

  const isMain = portalId === MAIN_BOSS.portalId;
  const spec = isMain ? MAIN_BOSS : TRIAL_BY_PORTAL.get(portalId);
  if (!spec) return false;
  if (isMain) {
    if (!allTrialsComplete(progress) || progress.mainBossSpawned) return false;
  } else if (progress.trials[spec.stateKey]) {
    return false;
  }

  // `spawnEnemy` needs the GLB key to correspond to an ordinary tier so its
  // pool can clone a model. Copy the portal-specific numbers on top of that
  // base tier; no normal spawn uses this object.
  // Ambient tiers inherit the shared config row. Bespoke boss-only GLBs are
  // intentionally absent from ENEMY_TIERS/Codex and use their authored spec
  // directly; spawnEnemy only requires a loaded GLB key + combat numbers.
  const baseTier = findTier(spec.boss.glb) || spec.boss;
  const bossTier = {
    ...baseTier,
    ...spec.boss,
    displayName: spec.name || spec.banner,
    kakiLandPortalId: portalId,
  };
  const spawnAngle = isMain ? Math.PI * 0.62 : Math.atan2(-portal.x, -portal.z);
  const spawnDistance = isMain ? 6.4 : 5.1;
  const enemy = spawnEnemy(bossTier,
    portal.x + Math.sin(spawnAngle) * spawnDistance,
    portal.z + Math.cos(spawnAngle) * spawnDistance,
  );
  if (!enemy) {
    try { showBanner('PORTAL UNSTABLE', 1.8, '#ff9d86'); } catch (_) {}
    return false;
  }

  // Enemy pools calculate their feet-on-ground offset using the source tier's
  // normal scale. Portal bosses deliberately scale beyond that silhouette, so
  // carry the offset with the scale too; otherwise their enlarged meshes sink
  // into the island surface.
  const baseScale = baseTier.scale || 1;
  const scaleRatio = (bossTier.scale || baseScale) / baseScale;
  if (scaleRatio !== 1 && enemy.mesh) {
    const adjustedY = (enemy._baseY || enemy.mesh.position.y || 0) * scaleRatio;
    enemy.mesh.position.y = adjustedY;
    enemy._baseY = adjustedY;
  }

  enemy.kakiLandPortalId = portalId;
  enemy._kakiLandPortalId = portalId;
  enemy.kakiLandMainBoss = isMain;
  beginKakiLandBossEncounter(enemy, portalId);
  _activeBoss = enemy;
  _activePortalId = portalId;
  if (isMain) progress.mainBossSpawned = true;
  _nextInteractAt = runTime(s) + 0.7;
  s.fx.bloomBoost = Math.max(s.fx.bloomBoost || 0, isMain ? 1 : 0.65);
  s.fx.shake = Math.max(s.fx.shake || 0, isMain ? 0.75 : 0.38);
  try { if (sfx && sfx.bossWarn) sfx.bossWarn(); } catch (_) {}
  try {
    showBanner(spec.hint ? `${spec.banner} — ${spec.hint}` : spec.banner, 2.8, spec.color);
  } catch (_) {}
  return true;
}

/** Mount or restore the Kaki Land portal controller. Idempotent by scene. */
export function loadKakiLandPortals(scene, s) {
  if (!scene || !s) return false;
  if (_scene && _scene !== scene) disposeKakiLandPortals(_scene);
  _scene = scene;
  _state = s;
  _activeBoss = null;
  _activePortalId = null;
  _promptPortalId = null;
  _nextInteractAt = runTime(s) + 0.2;
  loadKakiLandBossEncounters(scene, s);
  // Menu/stage swaps can dispose the shared threat-bar DOM while leaving an
  // earlier arenaDecor loaded flag set. Re-mount idempotently at the owner
  // boundary so Kaki bosses always get their phase/ward presentation.
  loadForestBossBars(scene, s);
  s._bossBarsLoaded = true;
  // Avoid a stageRules → portal-controller → enemies import cycle in the
  // hot kill path. The stage rule calls this narrow, run-owned hook instead;
  // it is installed only while Kaki Land is mounted and cleared on teardown.
  s._onKakiLandBossKilled = (enemy) => onKakiLandBossKilled(enemy, s);
  refreshPortalVisuals(s);
  return true;
}

/** Per-frame proximity prompt and E/B interaction reader. */
export function tickKakiLandPortals(dt, s = _state) {
  if (!_scene || !s || !s.run || !s.run.stage || s.run.stage.id !== 'kakiland') return;
  tickKakiLandBossEncounter(dt);
  const progress = ensureProgress(s);
  if (!progress) return;
  refreshPortalVisuals(s);

  // A defensive stale-reference release covers a pool/reset path that removes
  // an enemy without its normal kill hook.
  if (_activeBoss && !_activeBoss.alive) {
    _activeBoss = null;
    _activePortalId = null;
  }

  const nearby = nearestPortal(s);
  if (!nearby) {
    _promptPortalId = null;
    return;
  }

  const status = portalStatus(nearby.portal.id, progress);
  showOnce(
    nearby.portal.id,
    status.title,
    status.detail,
    status.color || '#ccd8e8',
    status.kind === 'ready',
  );
  if (!s.input || !s.input.interactPressed || runTime(s) < _nextInteractAt) return;

  if (status.kind === 'ready') {
    spawnPortalBoss(s, nearby.portal.id);
  } else {
    _nextInteractAt = runTime(s) + 0.45;
    try { showBanner(status.detail || status.title, 1.7, status.color || '#b5c3d7'); } catch (_) {}
  }
}

/**
 * Synchronous enemy-death hook, called by the Kaki Land stage rule before
 * the normal final-boss victory flow. Returns true when the kill belonged to
 * this portal route.
 */
export function onKakiLandBossKilled(enemy, s = _state) {
  if (!enemy || !enemy.kakiLandPortalId) return false;
  // Intermission adds share the portal id so the stage kill hook can report
  // them synchronously, but they must never complete the portal itself.
  if (enemy._kakiEncounterAdd) {
    notifyKakiLandEncounterEnemyKilled(enemy);
    return true;
  }
  const progress = ensureProgress(s);
  if (!progress) return false;
  notifyKakiLandEncounterEnemyKilled(enemy);
  const portalId = enemy.kakiLandPortalId;
  if (_activeBoss === enemy || _activePortalId === portalId) {
    _activeBoss = null;
    _activePortalId = null;
  }

  if (portalId === MAIN_BOSS.portalId) {
    try { showBanner('KAKI LAND SAVED', 3.0, MAIN_BOSS.color); } catch (_) {}
    return true;
  }

  const trial = TRIAL_BY_PORTAL.get(portalId);
  if (!trial || progress.trials[trial.stateKey]) return !!trial;
  progress.trials[trial.stateKey] = true;
  setKakiLandTrialPortalCompleted(trial.portalId, true);
  const complete = allTrialsComplete(progress);
  progress.mainPortalUnlocked = complete;
  setKakiLandMainPortalUnlocked(complete);
  if (complete) {
    try { showBanner('MAIN BOSS PORTAL UNLOCKED', 3.2, MAIN_BOSS.color); } catch (_) {}
  } else {
    const cleared = TRIALS.filter((item) => progress.trials[item.stateKey]).length;
    try { showBanner(`${cleared} / ${TRIALS.length} PORTALS CLEARED`, 2.2, trial.color); } catch (_) {}
  }
  return true;
}

/** Tear down controller state; geometry itself is disposed by the stage module. */
export function disposeKakiLandPortals(scene) {
  if (scene && _scene && scene !== _scene) return false;
  disposeKakiLandBossEncounters(_scene || scene);
  if (_state && _state._onKakiLandBossKilled) delete _state._onKakiLandBossKilled;
  _scene = null;
  _state = null;
  _activeBoss = null;
  _activePortalId = null;
  _promptPortalId = null;
  _nextInteractAt = 0;
  return true;
}

/** Small, read-only support surface for smoke tests and devtools. */
export function getKakiLandPortalDebugState() {
  return {
    loaded: !!_scene,
    activePortalId: _activePortalId,
    activeBoss: _activeBoss,
    trialPortalIds: TRIALS.map((trial) => trial.portalId),
    mainPortalId: MAIN_BOSS.portalId,
    encounter: getKakiLandBossEncounterDebugState(),
  };
}
