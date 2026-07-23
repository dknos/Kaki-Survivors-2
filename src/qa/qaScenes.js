/**
 * Deterministic renderer-migration scenes.
 *
 * This module is dynamically imported by main.js only for an exact, known
 * `?qa=` selector. Normal play and the older `?qa=1` / `?qa=crash` harnesses
 * never load it. Scene entry deliberately uses the same public lifecycle
 * hooks as the menu so renderer work is exercised without a second game boot.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { ENEMY_TIERS, STAGE, STAGES } from '../config.js';
import { getMeta } from '../meta.js';
import { spawnEnemy } from '../enemies.js';
import { hasSpritePool } from '../sprites/index.js';
import {
  getRendererCanvas,
  getRendererDiagnostics,
  getRendererInstance,
} from '../rendering/rendererAccess.js';

const STAGE_IDS = Object.freeze(['forest', 'twilight', 'cinder', 'void', 'cave', 'kakiland']);
const STAGE_SET = new Set(STAGE_IDS);
const FIXED_SCENES = new Set([
  'menu',
  'main-menu',
  'hero-selection',
  'forest-horde',
  'max-weapon-fx',
  'kakiland-boss',
  'town-night',
  'town-house-interior',
  'town-casino-interior',
  'catacomb',
  'bullet-hell',
  'rally-heavy',
  'rally-first-person',
  'rally-chase',
  'monster-smash',
  'monster-smash-chase',
  'draw-track',
  'trials',
  'catastrophe',
  'postfx',
  'low-effects',
  'reduced-motion',
  'reduced-flashing',
  'high-contrast',
]);

export const QA_SCENE_IDS = Object.freeze([
  'menu',
  'main-menu',
  'hero-selection',
  ...STAGE_IDS.map((id) => `stage-${id}`),
  'forest-horde',
  'max-weapon-fx',
  ...STAGE_IDS.map((id) => `final-boss-${id}`),
  'kakiland-boss',
  'town-night',
  'town-house-interior',
  'town-casino-interior',
  'catacomb',
  'bullet-hell',
  'rally-heavy',
  'rally-first-person',
  'rally-chase',
  'monster-smash',
  'monster-smash-chase',
  'draw-track',
  'trials',
  'catastrophe',
  'postfx',
  'low-effects',
  'reduced-motion',
  'reduced-flashing',
  'high-contrast',
]);

export function isRecognizedQaScene(selector) {
  if (FIXED_SCENES.has(selector)) return true;
  if (selector.startsWith('stage-')) return STAGE_SET.has(selector.slice(6));
  if (selector.startsWith('final-boss-')) return STAGE_SET.has(selector.slice(11));
  return false;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function hashSeed(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let out = Math.imul(value ^ (value >>> 15), 1 | value);
    out ^= out + Math.imul(out ^ (out >>> 7), 61 | out);
    return ((out ^ (out >>> 14)) >>> 0) / 4294967296;
  };
}

function snapshotStorage(storage) {
  const entries = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key != null) entries.push([key, storage.getItem(key)]);
    }
  } catch (_) {}
  return entries;
}

function restoreStorageSnapshot(storage, entries) {
  const saved = new Map(entries);
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key != null && !saved.has(key)) storage.removeItem(key);
    }
    for (const [key, value] of entries) {
      if (value == null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
  } catch (_) {}
}

function errorRecord(value, source = 'qa') {
  const error = value instanceof Error ? value : new Error(String(value ?? 'Unknown error'));
  return {
    source,
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || '',
    atMs: Math.round(now() * 100) / 100,
  };
}

function backendLabel(renderer) {
  const explicit = window.__kkRendererService?.backend
    || window.__kkRendererDiagnostics?.backend
    || window.__kkRendererBackend;
  if (explicit) return String(explicit).toLowerCase();

  const backend = renderer?.backend || renderer?._backend;
  if (backend?.isWebGPUBackend || /webgpu/i.test(backend?.constructor?.name || '')) return 'webgpu';
  if (backend?.isWebGLBackend || /webgl/i.test(backend?.constructor?.name || '')) return 'webgl2';
  if (renderer?.isWebGPURenderer) return 'webgpu';
  return 'unknown';
}

function rendererSnapshot() {
  const renderer = getRendererInstance(state);
  const canvas = getRendererCanvas(state);
  const diagnostics = getRendererDiagnostics(state);
  return {
    backend: diagnostics.backend || backendLabel(renderer),
    renderer: renderer?.constructor?.name || null,
    threeRevision: THREE.REVISION,
    width: canvas?.width || 0,
    height: canvas?.height || 0,
    cssWidth: canvas?.clientWidth || 0,
    cssHeight: canvas?.clientHeight || 0,
    dpr: diagnostics.dpr || renderer?.getPixelRatio?.() || window.devicePixelRatio || 1,
    info: {
      memory: {
        geometries: diagnostics.geometries || 0,
        textures: diagnostics.textures || 0,
        renderTargets: diagnostics.renderTargets || 0,
      },
      render: {
        calls: diagnostics.drawCalls || 0,
        drawCalls: diagnostics.drawCalls || 0,
        renderCalls: diagnostics.renderCalls || 0,
        triangles: diagnostics.triangles || 0,
        points: diagnostics.points || 0,
        lines: diagnostics.lines || 0,
      },
      programs: diagnostics.programs,
    },
  };
}

function qaSnapshot(qa) {
  let visibleObjects = 0;
  let sceneObjects = 0;
  try {
    state.scene?.traverse((object) => {
      sceneObjects++;
      if (object.visible !== false) visibleObjects++;
    });
  } catch (_) {}
  return {
    schemaVersion: 1,
    selector: qa.selector,
    status: qa.status,
    ready: qa.status === 'ready',
    seed: qa.seed,
    createdAtMs: qa.createdAtMs,
    setupStartedAtMs: qa.setupStartedAtMs,
    readyAtMs: qa.readyAtMs,
    setupDurationMs: qa.readyAtMs == null ? null : qa.readyAtMs - qa.setupStartedAtMs,
    mode: state.mode,
    started: !!state.started,
    paused: !!state.time?.paused,
    stage: state.run?.stage?.id || null,
    gameTime: state.time?.game || 0,
    enemies: state.enemies?.active?.length || 0,
    projectiles: state.projectiles?.active?.length || 0,
    sceneObjects,
    visibleObjects,
    details: { ...qa.details },
    renderer: rendererSnapshot(),
    errors: qa.errors.map((entry) => ({ ...entry })),
  };
}

function nextFrames(count = 1) {
  return new Promise((resolve) => {
    const step = () => {
      count--;
      if (count <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function waitUntil(predicate, label, timeoutMs = 90000) {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeHeroSafe() {
  if (!state.hero) return;
  state.hero.hpMax = 1e9;
  state.hero.hp = 1e9;
  if (state.hero.statMul) state.hero.statMul.dmgTaken = 0;
  state.gameOver = false;
  state.pendingLevelUp = false;
}

function configureNormalQaMeta(stageId = 'forest') {
  const meta = getMeta();
  meta.selectedStage = stageId;
  meta.optMusic = false;
  // QA scene selectors must be addressable from a clean profile without
  // rewriting campaign unlock flags into the save envelope.
  meta.optDevUnlockAllLevels = true;
  meta.optDaily = false;
  meta.optWeekly = false;
  meta.optHyper = false;
  meta.optEndless = false;
  meta.optBossRush = false;
  meta.optNgMirror = false;
  meta.optNgTwin = false;
  meta.optNgHalfPickup = false;
  return meta;
}

async function withIntroSuppressed(work) {
  const keys = ['kks_introSeen', 'kks_forestTrialsIntroSeen_v1', 'kks_kakiLandIntroSeen_v1'];
  const previous = keys.map((key) => [key, localStorage.getItem(key)]);
  for (const key of keys) localStorage.setItem(key, '1');
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }
}

async function startRun(stageId) {
  configureNormalQaMeta(stageId);
  await withIntroSuppressed(() => window.kkStartRun());
  await waitUntil(
    () => state.started && state.mode === 'run' && state.run?.stage?.id === stageId,
    `${stageId} run`,
  );
  makeHeroSafe();
}

function placeStableEnemy(tier, x, z) {
  const enemy = spawnEnemy(tier, x, z);
  if (!enemy) return null;
  enemy.hp = enemy.hpMax = 1e9;
  enemy.spd = 0;
  enemy.dmg = 0;
  enemy.ranged = null;
  return enemy;
}

async function setupForestHorde(qa) {
  await startRun('forest');
  // Prefer the production billboard pool. If atlas bootstrap is still in
  // flight, a bounded wait avoids accidentally cloning a 3D mesh per body.
  try {
    await waitUntil(
      () => hasSpritePool('forest-enemies-v2'),
      'Forest enemy sprite v2 pool',
      12000,
    );
  } catch (_) {
    // Bootstrap failure deliberately falls through to the v1 atlas/GLB path.
  }

  const tierIds = [
    'ant', 'beetle', 'ladybug', 'grasshopper', 'butterfly', 'bee',
    'wasp', 'cockroach', 'caterpillar', 'mantis', 'spider',
  ];
  const tiers = tierIds.map((id) => ENEMY_TIERS.find((tier) => tier.glb === id)).filter(Boolean);
  const center = state.hero.pos;
  let spawned = 0;
  // Production swarm ceiling. Keep this exact so sprite-runtime revisions are
  // compared against the same deterministic 350-enemy renderer workload.
  const count = 350;
  for (let i = 0; i < count; i++) {
    const ring = i % 6;
    const slot = Math.floor(i / 6);
    const radius = 7.5 + ring * 2.8;
    const angle = (slot / (count / 6)) * Math.PI * 2 + ring * 0.19;
    const tier = tiers[i % tiers.length];
    if (placeStableEnemy(tier, center.x + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius)) spawned++;
  }
  state.run.weeklySpawnMul = 1;
  state.run.dailySpawnMul = 1;
  qa.details.spawned = spawned;
  qa.details.target = count;
}

async function setupHeroSelection(qa) {
  await waitUntil(
    () => state.mode === 'menu' && !document.getElementById('kk-boot-loader'),
    'main menu',
  );
  const heroesButton = document.querySelector('.kkv2-navitem[data-nav="characters"]');
  if (!(heroesButton instanceof HTMLElement)) {
    throw new Error('The main-menu Heroes control is unavailable.');
  }
  heroesButton.click();
  await waitUntil(() => {
    const title = document.querySelector('.kkv2-overlay-title');
    const canvas = document.querySelector('.kkv2-overlay-host canvas');
    return title?.textContent?.trim() === 'Heroes' && !!canvas;
  }, 'Heroes carousel');
  await waitUntil(() => {
    const host = document.querySelector('.kkv2-overlay-host');
    return !!host && !host.querySelector('.kk-preview-renderer-status');
  }, 'Heroes preview renderer');
  qa.details.screen = 'heroes-carousel';
  qa.details.selectedAvatar = getMeta().selectedAvatar || 'kitty';
  qa.details.previewCanvas = true;
  qa.details.previewRendererReady = true;
}

async function setupMaxWeaponFx(qa) {
  // A normal run can carry six non-hidden weapons. Pin Kitty for a stable
  // signature starter, suppress optional hidden Forest kits, then fill the
  // remaining five live slots through the production acquisition API.
  const meta = configureNormalQaMeta('forest');
  meta.selectedAvatar = 'kitty';
  meta.forestWeapons = [];
  await startRun('forest');
  try { await waitUntil(() => hasSpritePool('enemies'), 'enemy sprite pool', 12000); } catch (_) {}

  const {
    REGISTRY,
    EVOLUTIONS,
    acquireWeapon,
    applyEvolution,
    applyFiller,
    applyPassive,
    checkEvolutionEligibility,
  } = await import('../weapons/index.js');
  const visibleWeapons = () => state.weapons.filter((entry) => REGISTRY[entry.id] && !REGISTRY[entry.id].hidden);
  const candidates = ['orbitals', 'chain', 'autoaim', 'web', 'frostbloom', 'sigilbell'];
  for (const id of candidates) {
    if (visibleWeapons().length >= 6) break;
    if (!state.weapons.some((entry) => entry.id === id)) acquireWeapon(id);
  }
  for (const entry of visibleWeapons()) {
    const def = REGISTRY[entry.id];
    while (entry.level < def.maxLevel) acquireWeapon(entry.id);
  }

  // Satisfy the four shipped weapon-evolution recipes using the same public
  // filler/passive paths as level-up cards. Mirror Step is a normal seventh
  // (non-slot) evolution once the authored dash and mini-boss gates are met.
  applyFiller({ id: 'magnet' });
  applyFiller({ id: 'magnet' });
  applyFiller({ id: 'cooldown' });
  applyFiller({ id: 'cooldown' });
  applyPassive({ id: 'echo' });
  applyPassive({ id: 'steadfast' });
  state.hero.level = Math.max(state.hero.level || 1, 30);
  state.hero.dashUnlocked = true;
  state.hero.dashLevel = 5;
  state.run.miniBossKills = Math.max(state.run.miniBossKills || 0, 2);
  checkEvolutionEligibility();
  const evolved = [];
  for (const id of ['orbitals', 'chain', 'autoaim', 'web', 'dash']) {
    if (id !== 'dash' && !state.weapons.some((entry) => entry.id === id)) continue;
    applyEvolution(id);
    evolved.push(EVOLUTIONS[id]?.id || id);
  }

  // Ninety-six stationary, harmless targets keep chain, projectile, web, and
  // orbital effects simultaneously active without the pathological cost of
  // equipping every hidden/registry-only weapon.
  const tierIds = ['ant', 'beetle', 'ladybug', 'grasshopper', 'bee', 'mantis'];
  const tiers = tierIds.map((id) => ENEMY_TIERS.find((tier) => tier.glb === id)).filter(Boolean);
  const center = state.hero.pos;
  let spawned = 0;
  for (let i = 0; i < 96; i++) {
    const ring = i % 4;
    const slot = Math.floor(i / 4);
    const radius = 4.5 + ring * 3.25;
    const angle = (slot / 24) * Math.PI * 2 + ring * 0.21;
    const tier = tiers[i % tiers.length];
    if (tier && placeStableEnemy(tier, center.x + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius)) spawned++;
  }
  state.fx.bloomBoost = 1;
  await nextFrames(18);

  qa.details.fixture = 'bounded-live-max-build';
  qa.details.visibleWeaponLimit = 6;
  qa.details.weapons = visibleWeapons().map((entry) => ({
    id: entry.id,
    level: entry.level,
    maxLevel: REGISTRY[entry.id].maxLevel,
    evolved: !!entry.inst?.evolved,
  }));
  qa.details.evolutions = evolved;
  qa.details.stressTargets = spawned;
  qa.details.omitted = 'hidden registry-only Forest/coffin weapons';
}

async function setupFinalBoss(qa, stageId) {
  await startRun(stageId);
  const base = stageId === 'kakiland'
    ? {
        glb: 'kaki_sovereign', displayName: 'The Kaki Sovereign', family: 'kaki-boss',
        hp: 1600, spd: 1.22, dmg: 28, scale: 2.75, elite: true,
        procAnim: 'pad', kakiLandPatternId: 'cycle',
      }
    : ENEMY_TIERS.find((tier) => tier.glb === 'dragon');
  if (!base) throw new Error('Final-boss source tier is unavailable');
  const tier = stageId === 'kakiland'
    ? { ...base, isFinalBoss: true }
    : {
        ...base,
        displayName: `${stageId.toUpperCase()} QA SOVEREIGN`,
        hp: base.hp * STAGE.finalBossHpMul,
        scale: (base.scale || 1) * STAGE.finalBossScaleMul,
        isFinalBoss: true,
      };
  const hero = state.hero.pos;
  const boss = placeStableEnemy(tier, hero.x + 9, hero.z + 6);
  if (!boss) throw new Error(`Could not spawn ${stageId} final boss`);
  qa.details.boss = boss.glbKey;
  qa.details.bossPosition = { x: boss.mesh.position.x, z: boss.mesh.position.z };
}

async function setupTown(qa) {
  configureNormalQaMeta('twilight');
  const meta = getMeta();
  const previousVisits = meta.townVisits;
  await window.kkEnterTown();
  await waitUntil(() => state.started && state.mode === 'town', 'Town');
  // enterTown owns this persistent counter. Put it back so opening a QA URL
  // cannot advance a real player's visit history.
  meta.townVisits = previousVisits;
  makeHeroSafe();
  qa.details.lighting = 'authored-town-dusk';
}

async function setupTownInterior(qa, room) {
  await setupTown(qa);
  if (room === 'house') {
    await window.kkPreloadHomeDecor?.();
    const { buildInterior, enterInterior } = await import('../interior.js');
    buildInterior(state.scene);
    enterInterior();
    await waitUntil(() => state.mode === 'interior', 'Town house interior');
    qa.details.room = 'house';
    qa.details.sceneGroup = 'interiorGroup';
  } else if (room === 'casino') {
    await window.kkPreloadCasino?.();
    const { buildCasinoInterior, enterCasinoInterior } = await import('../casinoInterior.js');
    buildCasinoInterior(state.scene);
    enterCasinoInterior();
    await waitUntil(() => state.mode === 'casino_interior', 'Town casino interior');
    qa.details.room = 'casino';
    qa.details.sceneGroup = 'casinoInteriorGroup';
  } else {
    throw new Error(`Unknown Town interior: ${room}`);
  }
  makeHeroSafe();
}

async function setupCatacomb() {
  // Forest's authored portal trials intentionally guard Catacomb entry. Use
  // Twilight, the same unlocked non-Forest path as the canonical dungeon
  // smoke, so this technical fixture does not bypass progression rules.
  configureNormalQaMeta('twilight');
  state.run.stage = STAGES.find((stage) => stage.id === 'twilight');
  state.run.environmentSeed = 0xc0ffee;
  const entered = await withIntroSuppressed(() => window.__kkTestEnterCatacomb());
  if (!entered) throw new Error('Catacomb entry was rejected by a progression or encounter guard.');
  await waitUntil(() => state.started && state.mode === 'catacomb', 'Catacomb');
  makeHeroSafe();
}

async function setupBulletHell(qa) {
  configureNormalQaMeta('forest');
  await window.kkStartBulletHell();
  await waitUntil(() => state.started && state.mode === 'bullethell' && window.__kkBh?.active, 'Bullet Hell');
  makeHeroSafe();
  window.__kkBhSetWave?.(5);
  await waitUntil(() => window.__kkBh?.wave === 5 && window.__kkBh?.boss, 'Bullet Hell boss wave');
  window.__kkBhWarp?.(0, 12);
  qa.details.wave = 5;
}

const DRAWN_QA_COURSE = Object.freeze({
  id: 'forest',
  customTrackId: 'qa-renderer-loop-v1',
  isDrawTrack: true,
  name: 'Renderer QA Loop',
  tagline: 'A fixed technical loop for backend comparisons.',
  laps: 1,
  points: Object.freeze([
    [-44, -10], [-35, -35], [-8, -47], [24, -40], [45, -17],
    [42, 18], [20, 42], [-12, 46], [-39, 25], [-50, 4],
  ]),
  trackWidth: 9,
  drawSizeId: 'grand',
  drawWidthId: 'standard',
  drawDirection: 'forward',
  drawStats: Object.freeze({ length: 310, personality: 'FLOWING QA LOOP' }),
  samples: 192,
  rampFractions: Object.freeze([0.18, 0.64]),
  boostFractions: Object.freeze([0.38, 0.82]),
  repairFractions: Object.freeze([0.9]),
  overpasses: Object.freeze([]),
});

async function setupRacing(qa, kind) {
  configureNormalQaMeta('forest');
  let options;
  if (kind === 'rally-heavy') {
    options = { mode: 'stock', carCount: 16 };
  } else if (kind === 'rally-first-person' || kind === 'rally-chase') {
    options = { mode: 'circuit', carCount: 8 };
  } else if (kind === 'monster-smash' || kind === 'monster-smash-chase') {
    options = {
      mode: 'monster', carCount: 1, monsterVehicle: 'cyber',
      monsterArena: 'pileup-pyramid-yard', monsterEvent: 'smashdown',
    };
  } else if (kind === 'draw-track') {
    options = {
      mode: 'draw',
      carCount: 8,
      customCourse: DRAWN_QA_COURSE,
      customTrack: {
        id: DRAWN_QA_COURSE.customTrackId,
        name: DRAWN_QA_COURSE.name,
        widthId: DRAWN_QA_COURSE.drawWidthId,
      },
    };
  } else if (kind === 'trials') {
    options = { mode: 'trials', carCount: 1, trialsTrackId: 'meadow', trialsVehicle: 'monster' };
  } else {
    options = { mode: 'crash', carCount: 1, crashVehicle: 'muscle', crashQuality: 'high' };
  }

  await window.kkStartRacing('forest', options);
  await waitUntil(() => state.started && state.mode === 'racing' && state.racing, kind);
  // Renderer parity captures must represent the authored mode, not the
  // TextureLoader/GLTF placeholder interval. The runtime can enter immediately
  // and stream its lease normally; deterministic QA waits for that same lease
  // before declaring the scene ready.
  if (kind !== 'catastrophe' && state.racing.assetLease?.ready) {
    await state.racing.assetLease.ready;
    await nextFrames(2);
    qa.details.assetsReady = true;
  }
  makeHeroSafe();
  if (kind === 'catastrophe') {
    window.__kkCrash?.skipIntro?.();
  } else {
    window.__kkRacing?.skipCountdown?.();
  }
  if (kind === 'rally-heavy' || kind === 'rally-first-person' || kind === 'rally-chase') {
    window.__kkRacing?.warpShowcase?.(0.18);
  }
  if (kind === 'rally-first-person' || kind === 'rally-chase') {
    const cameraMode = kind === 'rally-first-person' ? 'driver_fpv' : 'chase';
    const accepted = window.__kkRacing?.setCameraMode?.(cameraMode);
    if (!accepted) throw new Error(`Rally rejected QA camera mode ${cameraMode}`);
    await waitUntil(
      () => {
        const camera = window.__kkRacing?.snapshot?.()?.camera;
        return camera?.mode === cameraMode
          && camera.projection === 'perspective'
          && (cameraMode !== 'driver_fpv' || !!camera.visionStage);
      },
      `Rally ${cameraMode} camera`,
      30000,
    );
    qa.details.camera = window.__kkRacing.snapshot().camera;
  }
  if (kind === 'monster-smash' || kind === 'monster-smash-chase') {
    window.__kkRacing?.fillChaos?.();
    window.__kkRacing?.showMonsterBusyState?.();
    if (kind === 'monster-smash-chase') {
      const accepted = window.__kkRacing?.setCameraMode?.('chase');
      if (!accepted) throw new Error('Monster Smash rejected QA chase camera mode');
      await waitUntil(
        () => {
          const camera = window.__kkRacing?.snapshot?.()?.camera;
          return camera?.mode === 'chase' && camera.projection === 'perspective';
        },
        'Monster Smash chase camera',
        30000,
      );
      qa.details.camera = window.__kkRacing.snapshot().camera;
    }
  }
  qa.details.raceMode = state.racing?.raceMode || kind;
  qa.details.carCount = state.racing?.cars?.length || 0;
}

async function setupPostfx(qa) {
  await startRun('forest');
  state.fx.chromaticPulse = 1;
  state.fx.bloomBoost = 1;
  if (state.postFXPass?.uniforms?.chromatic) state.postFXPass.uniforms.chromatic.value = 0.0048;
  if (state.bloomPass) state.bloomPass.strength = 0.6;
  // Hold the authored stress values while retaining the normal render loop.
  state.time.paused = true;
  qa.details.chromatic = state.postFXPass?.uniforms?.chromatic?.value ?? null;
  qa.details.bloomStrength = state.bloomPass?.strength ?? null;
}

async function setupAccessibility(qa, fixture) {
  await startRun('forest');
  const meta = getMeta();
  const options = {
    reduceMotion: fixture === 'reduced-motion',
    reducedFlashing: fixture === 'reduced-flashing',
    highContrast: fixture === 'high-contrast',
    colorblind: 'off',
    effectsScale: fixture === 'low-effects' ? 0 : 1,
  };

  // Write the serialized-option source of truth and every current live cache.
  // The explicit pipeline/service calls are optional seams for the WebGPU
  // implementation; the legacy ShaderPass is updated through its public helper.
  meta.optVfx = options.effectsScale;
  meta.optReduceMotion = options.reduceMotion;
  meta.optReduceMotionUserSet = options.reduceMotion;
  meta.optReducedFlashing = options.reducedFlashing;
  meta.optHighContrast = options.highContrast;
  meta.optColorblind = options.colorblind;
  state._optVfx = options.effectsScale;
  state._optReduceMotion = options.reduceMotion;
  state._optReducedFlashing = options.reducedFlashing;
  state._optShakeMul = options.reduceMotion ? 0 : Number(meta.optShake);
  const { applyAccessibilityOptions } = await import('../rendering/postfx/accessibilityPostfx.js');
  applyAccessibilityOptions(state.postFXPass, options);
  await Promise.resolve(state.renderPipeline?.setAccessibility?.(options));
  await Promise.resolve(window.__kkRendererService?.setAccessibility?.(options));

  if (options.reduceMotion || options.reducedFlashing || options.effectsScale === 0) {
    state.fx.chromaticPulse = 0;
    state.fx.bloomBoost = 0;
  }
  await nextFrames(3);
  const uniforms = state.postFXPass?.uniforms;
  qa.details.accessibility = { ...options };
  qa.details.live = {
    reduceMotion: !!state._optReduceMotion,
    reducedFlashing: !!state._optReducedFlashing,
    shakeMultiplier: state._optShakeMul,
    effectsScale: meta.optVfx,
    postReduceMotion: uniforms?.uReduceMotion?.value ?? null,
    postHighContrast: uniforms?.uHighContrast?.value ?? null,
    bloomStrength: state.bloomPass?.strength ?? null,
  };
}

async function setupScene(qa) {
  const selector = qa.selector;
  if (selector === 'menu' || selector === 'main-menu') {
    await waitUntil(() => state.mode === 'menu' && !document.getElementById('kk-boot-loader'), 'main menu');
    return;
  }
  if (selector === 'hero-selection') return setupHeroSelection(qa);
  if (selector.startsWith('stage-')) {
    await startRun(selector.slice(6));
    return;
  }
  if (selector === 'forest-horde') return setupForestHorde(qa);
  if (selector === 'max-weapon-fx') return setupMaxWeaponFx(qa);
  if (selector.startsWith('final-boss-')) return setupFinalBoss(qa, selector.slice(11));
  if (selector === 'kakiland-boss') return setupFinalBoss(qa, 'kakiland');
  if (selector === 'town-night') return setupTown(qa);
  if (selector === 'town-house-interior') return setupTownInterior(qa, 'house');
  if (selector === 'town-casino-interior') return setupTownInterior(qa, 'casino');
  if (selector === 'catacomb') return setupCatacomb();
  if (selector === 'bullet-hell') return setupBulletHell(qa);
  if (['rally-heavy', 'rally-first-person', 'rally-chase', 'monster-smash', 'monster-smash-chase', 'draw-track', 'trials', 'catastrophe'].includes(selector)) {
    return setupRacing(qa, selector);
  }
  if (selector === 'postfx') return setupPostfx(qa);
  if (['low-effects', 'reduced-motion', 'reduced-flashing', 'high-contrast'].includes(selector)) {
    return setupAccessibility(qa, selector);
  }
  throw new Error(`Unsupported QA selector: ${selector}`);
}

/** Start the selected scene once. Called after main's first RAF has started. */
export function initializeQaScene(selector = new URLSearchParams(location.search).get('qa') || '') {
  if (!isRecognizedQaScene(selector)) return Promise.resolve(null);
  if (window.__kkQa?.selector === selector && window.__kkQa.promise) return window.__kkQa.promise;

  const params = new URLSearchParams(location.search);
  const seedParam = params.get('qaSeed');
  const requestedSeed = seedParam == null ? Number.NaN : Number(seedParam);
  const seed = Number.isFinite(requestedSeed) && requestedSeed >= 0
    ? requestedSeed >>> 0
    : hashSeed(`kitty-kaki-renderer:${selector}:v1`);
  const originalRandom = Math.random;
  const qa = {
    schemaVersion: 1,
    selector,
    seed,
    status: 'setting-up',
    createdAtMs: now(),
    setupStartedAtMs: now(),
    readyAtMs: null,
    details: {},
    errors: [],
    snapshot: null,
    promise: null,
    restoreRandom: () => { Math.random = originalRandom; },
  };
  const persistedStorage = {
    local: snapshotStorage(localStorage),
    session: snapshotStorage(sessionStorage),
  };
  qa.restoreStorage = () => {
    restoreStorageSnapshot(localStorage, persistedStorage.local);
    restoreStorageSnapshot(sessionStorage, persistedStorage.session);
  };
  qa.snapshot = () => qaSnapshot(qa);
  window.__kkQa = qa;

  Math.random = seededRandom(seed);
  const onError = (event) => qa.errors.push(errorRecord(event.error || event.message, 'window.error'));
  const onRejection = (event) => qa.errors.push(errorRecord(event.reason, 'unhandledrejection'));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  qa.promise = (async () => {
    try {
      await setupScene(qa);
      await nextFrames(2);
      // Lifecycle entry and codex-discovery paths legitimately persist during
      // normal play. A QA URL must not make those technical fixtures part of
      // the player's real save, so restore the pre-QA serialized envelope.
      qa.restoreStorage();
      qa.readyAtMs = now();
      qa.status = 'ready';
      window.dispatchEvent(new CustomEvent('kkqa:ready', { detail: qa.snapshot() }));
      return qa.snapshot();
    } catch (error) {
      qa.restoreStorage();
      qa.errors.push(errorRecord(error, 'setup'));
      qa.readyAtMs = now();
      qa.status = 'error';
      window.dispatchEvent(new CustomEvent('kkqa:error', { detail: qa.snapshot() }));
      console.error(`[qa:${selector}] setup failed`, error);
      throw error;
    }
  })();
  // The baseline harness waits on status and should not trigger an additional
  // browser-level unhandled rejection merely because setup reported an error.
  qa.promise.catch(() => {});
  window.addEventListener('pagehide', () => {
    qa.restoreStorage();
    qa.restoreRandom();
  }, { once: true });
  return qa.promise;
}
