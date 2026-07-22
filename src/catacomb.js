/**
 * Catacomb — procedural multi-room dungeon the player descends into mid-run.
 *
 * Sibling to interior.js, but combat continues inside. The player enters via a
 * stairs-down interactable in the run scene; combat runs normally in catacomb
 * mode (enemies, weapons, FX). The interior is a SEEDED procedural dungeon
 * (dungeonGen.js → dungeonBuild.js): ~14 rooms of KayKit "Dungeon Remastered"
 * geometry with per-room encounters, sealed doorways, and a boss-room reward.
 *
 * This file owns the run-side glue only: the polished overworld entrance mesh,
 * mode enter/exit, the codebase's FIRST grid collision layer (circle-vs-cell
 * slide on hero + enemies), the per-room encounter state machine, and reward /
 * unlock hooks. All geometry + torch lighting lives in dungeonBuild.js.
 *
 * Entry is transactional: every critical asset and the generated layout are
 * ready before the overworld is hidden or any run-owned enemies are retired.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { grantEmbers, grantSigils, grantCatacombReward, setUnlockFlag, questEvent } from './meta.js';
import { ENEMY_TIERS } from './config.js';
import { bindPrompt, setPromptLabel } from './buttonPrompts.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { cloneCached, GLTF_CACHE, preloadDungeonKit } from './assets.js';
import { fxTex } from './fxTextures.js';
import { tex } from './particleTextures.js';
import { applyFloorTier, floorDecalGeometry, floorDecalMaterial } from './fxLayers.js';
import { generateDungeon, TYPE } from './dungeonGen.js';
import { buildDungeon } from './dungeonBuild.js';
import { buildCatacombHazards, tickCatacombHazards, disposeCatacombHazards } from './catacombHazards.js';
import {
  buildCatacombEncounters,
  activateCatacombEncounter,
  completeCatacombEncounter,
  decorateCatacombEnemy,
  tickCatacombEncounters,
  catacombEncounterLabel,
  debugCatacombEncounters,
  disposeCatacombEncounters,
} from './catacombEncounters.js';
import { completeFinalBossVictory, releaseEnemyVisual, spawnEnemy } from './enemies.js';
import { clearEnemyProjectiles } from './enemyProjectiles.js';
import { spawnChestRaw, resetChests } from './chest.js';
import { dropGem, resetXP, vacuumAllGemsInstant } from './xp.js';
import { spawnHeart, resetPickups } from './pickups.js';
import { showBanner, isSlotOpen } from './ui.js';
import { moveSprite } from './sprites/index.js';
import { disposeBossTelegraphs, resetBossTelegraphs } from './bossTelegraphs.js';
import { isMiniEventBlockingCatacomb } from './miniEvents.js';
import { addOverworldPause } from './runClock.js';
import { isForestReaperBlockingCatacomb } from './forestReaper.js';

// Shared scratch matrix for the entrance mote column (no per-frame alloc).
const _entranceM4 = new THREE.Matrix4();

// Shared rune-ring texture for catacomb glyphs (entrance lip + exit-stair foot).
let _runeTex = null;
function _getRuneTex() {
  if (_runeTex) return _runeTex;
  _runeTex = fxTex('portal_catacomb_outer') || makeRuneRingTexture();
  return _runeTex;
}

function _mat(color, roughness = 0.92, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// ── module state ────────────────────────────────────────────────────────────
let _scene = null;
let _group = null;          // parked container; the built dungeon lives inside
let _promptEl = null;
let _promptBinding = null;
let _progressEl = null;
let _depthChoiceEl = null;
let _depthChoiceKeyHandler = null;
let _returnPos = null;      // stashed run-scene hero pos before entering
let _hiddenOverworld = [];  // exact visibility snapshot for stage-only roots

// Overworld entrance (a stairs-down mesh in the run scene).
let _entranceMesh = null;
export const CATACOMB_ENTRANCE_POS = Object.freeze({ x: 0, z: 30 });
// The old Forest stairs overlapped both the creek and the north trap corridor.
// This clear grass shelf keeps the finale legible and safely interactable.
export const FOREST_BOSS_GATE_POS = Object.freeze({ x: -24, z: 12 });
const ENTRANCE_POS = CATACOMB_ENTRANCE_POS;
let _activeOnEntrance = false;

// Procedural dungeon build + per-entry encounter state.
let _build = null;          // buildDungeon(...) result
let _layout = null;         // generateDungeon(...) result
let _roomInfo = null;       // { [roomId]: { type, cleared, active, mobs:Set, doorways, spawnPts } }
let _roomIds = [];          // cached numeric room ids (avoids per-frame for-in in _tickRooms)
let _bossRoomId = -1;
let _bossCleared = false;
let _roomCount = 14;
let _floorDepth = 0;
let _exit = null;           // { group, x, z } — exit stairs spawned on boss clear
let _exitActive = false;
let _rewardChest = null;
let _entryPromise = null;
let _entryGeneration = 0;
let _forestFinaleSession = false;
let _activeRoomId = -1;
let _criticalPath = [];
let _criticalProgress = 0;
let _lastProgressText = '';
let _enteredAtGameTime = null;
let _floorTransitioning = false;
let _depthChoiceWasPaused = false;
const _chamberMobIds = new Set();   // every enemy this catacomb spawned
const _parkedOverworldEnemies = []; // suspended intact for the return trip

// Cached spawn helpers (dynamic-import prefetched on entry so the per-frame
// hot path never calls import(); resolves instantly from main's module cache).
const _fnSpawnEnemy = spawnEnemy;
const _fnSpawnChest = spawnChestRaw;
const _fnDropGem = dropGem;
const _fnSpawnHeart = spawnHeart;

// Collision + spawn tuning.
const HERO_R = 0.6;         // hero collision radius (fits a 3-wide=6u corridor)
const SKEL_CAP = 6;         // max concurrent skinned skeletons (perf)
let _runSeq = 0;            // per-entry seed salt
let _fallbackCache = null;

const _resOut = { x: 0, z: 0 };
const _rewardGemPos = new THREE.Vector3();

function _forestBossGateRequired() {
  return !!(state.mode === 'run' && state.run && state.run.stage
    && state.run.stage.id === 'forest'
    && !(state.modes && (state.modes.bossRush || state.modes.daily || state.modes.weekly)));
}

function _forestBossGateProgress() {
  const trial = state.run && state.run.forestPortalTrials;
  return {
    cleared: trial ? trial.cleared || 0 : 0,
    total: trial ? trial.total || 6 : 6,
    unlocked: !!(trial && trial.bossUnlocked),
  };
}

function _currentEntrancePos() {
  return _forestBossGateRequired() ? FOREST_BOSS_GATE_POS : CATACOMB_ENTRANCE_POS;
}

function _setEntranceGateVisual(required, unlocked, cleared = 0, total = 6) {
  if (!_entranceMesh) return;
  const mode = required ? (unlocked ? 'ready' : 'locked') : 'open';
  const visualKey = `${mode}:${Math.max(0, Math.min(total, cleared))}`;
  if (_entranceMesh.userData._gateVisual === visualKey) return;
  _entranceMesh.userData._gateVisual = visualKey;
  const locked = mode === 'locked';
  const color = locked ? 0x6f8294 : (mode === 'ready' ? 0xc87bff : 0xff7a3a);
  const rune = _entranceMesh.userData._rune;
  const inner = _entranceMesh.userData._innerRune;
  const beamMat = _entranceMesh.userData._beamMat;
  const moteMat = _entranceMesh.userData._moteMat;
  const gatewayMat = _entranceMesh.userData._gatewayMat;
  const sockets = _entranceMesh.userData._sockets || [];
  const legacyStairs = _entranceMesh.userData._legacyStairs || [];
  const light = _entranceMesh.userData._light;
  if (rune && rune.material && rune.material.color) rune.material.color.setHex(color);
  if (inner && inner.material && inner.material.color) inner.material.color.setHex(color);
  if (beamMat && beamMat.color) beamMat.color.setHex(color);
  if (moteMat && moteMat.color) moteMat.color.setHex(color);
  if (moteMat) moteMat.opacity = locked ? 0.12 : 0.92;
  if (gatewayMat) {
    // The dormant gate must still read as a destination, not disappear into
    // Forest fog. Its brighter cool stone frame stays visually inactive
    // because the beam, motes, runes, and point light remain nearly dark.
    gatewayMat.color.setHex(locked ? 0x91aab7 : color);
    gatewayMat.opacity = locked ? 0.86 : 0.98;
  }
  for (const part of legacyStairs) part.visible = !required;
  for (let i = 0; i < sockets.length; i++) {
    const socket = sockets[i];
    socket.visible = required;
    const lit = i < cleared;
    if (socket.material && socket.material.color) {
      socket.material.color.setHex(unlocked ? 0xe7b7ff : (lit ? 0x8fffe5 : 0x343947));
      socket.material.opacity = unlocked ? 1 : (lit ? 0.96 : 0.42);
    }
  }
  if (light) {
    light.color.setHex(color);
    light.intensity = locked ? 0.32 : (mode === 'ready' ? 3.2 : 2.4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Overworld entrance mesh (polished — kept essentially as-is from iter 33x).
// ─────────────────────────────────────────────────────────────────────────────
function _makeEntranceStairs() {
  const g = new THREE.Group();
  const legacyStairs = [];
  for (let i = 0; i < 4; i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(2.4 - i * 0.3, 0.22, 0.55),
      _mat(0x3a3328, 0.95),
    );
    step.position.set(0, -0.11 - i * 0.18, i * 0.45);
    step.receiveShadow = true; step.castShadow = true;
    g.add(step);
    legacyStairs.push(step);
  }
  const pit = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({ color: 0x0a0608 }),
  );
  pit.rotation.x = -Math.PI / 2;
  pit.position.set(0, -1.0, 1.2);
  g.add(pit);
  legacyStairs.push(pit);
  for (const [dx, dz] of [[-1.5, 0], [1.5, 0], [0, -0.8]]) {
    const rock = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.5, 0.6),
      _mat(0x5a5048, 0.95),
    );
    rock.position.set(dx, 0.25, dz);
    rock.rotation.y = Math.random() * Math.PI;
    rock.castShadow = true;
    g.add(rock);
    legacyStairs.push(rock);
  }
  g.userData._legacyStairs = legacyStairs;
  // Glowing rune at the lip — warm 0xff7a3a "danger below" cue.
  const rune = new THREE.Mesh(
    floorDecalGeometry(1.56),
    floorDecalMaterial({ map: _getRuneTex(), color: 0xff7a3a, opacity: 0.85 }),
  );
  rune.position.set(0, 0.05, -0.85);
  applyFloorTier(rune, 'portal');
  rune.userData._spin = 0.35;
  g.add(rune);
  g.userData._rune = rune;

  // Inner counter-rotating sigil.
  const innerTex = fxTex('portal_catacomb_inner');
  if (innerTex) {
    const inner = new THREE.Mesh(
      floorDecalGeometry(0.95),
      floorDecalMaterial({ map: innerTex, color: 0xff9a55, opacity: 0.95 }),
    );
    inner.position.set(0, 0.07, -0.85);
    applyFloorTier(inner, 'telegraph');
    inner.userData._spin = -0.6;
    g.add(inner);
    g.userData._innerRune = inner;
  }

  // A large authored silhouette makes this read as the one Boss Gate rather
  // than another anonymous floor effect. Six rune sockets tell the entire
  // Forest objective at a glance and illuminate as Grove Trials are cleared.
  const gatewayTex = fxTex('portal_forest_gateway');
  if (gatewayTex) {
    const gatewayMat = new THREE.SpriteMaterial({
      map: gatewayTex,
      color: 0x586171,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const gateway = new THREE.Sprite(gatewayMat);
    gateway.name = 'moonrootBossGate';
    // Sit behind the interaction pad along the fixed isometric camera vector;
    // this keeps the upright transparent art from painting over the hero.
    gateway.position.set(-2.4, 3.6, -2.4);
    // Preserve the authored root-circle silhouette. The generous upright
    // scale distinguishes this destination gate from circular floor AoEs.
    gateway.scale.set(7.2, 7.2, 1);
    gateway.layers.enable(BLOOM_LAYER);
    g.add(gateway);
    g.userData._gatewayMat = gatewayMat;

    const socketTex = fxTex('ring_arcane') || tex('glowWhite');
    const socketPositions = [
      [-2.65, 1.70], [-3.10, 3.90], [-1.90, 6.10],
      [ 1.90, 6.10], [ 3.10, 3.90], [ 2.65, 1.70],
    ];
    const sockets = [];
    for (let i = 0; i < socketPositions.length; i++) {
      const mat = new THREE.SpriteMaterial({
        map: socketTex,
        color: 0x343947,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      const socket = new THREE.Sprite(mat);
      socket.name = `moonrootRune${i + 1}`;
      socket.position.set(socketPositions[i][0] - 2.4, socketPositions[i][1], -2.32);
      socket.scale.set(0.58, 0.58, 1);
      socket.layers.enable(BLOOM_LAYER);
      g.add(socket);
      sockets.push(socket);
    }
    g.userData._sockets = sockets;
  }

  // Vertical light pillar — two crossed additive planes.
  const beamTex = fxTex('pickup_pulse') || _getRuneTex();
  const PILLAR_H = 6.0, PILLAR_W = 1.4;
  const beamMat = new THREE.MeshBasicMaterial({
    map: beamTex, color: 0xff7a3a, transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beamA = new THREE.Mesh(new THREE.PlaneGeometry(PILLAR_W, PILLAR_H), beamMat);
  beamA.position.set(0, PILLAR_H * 0.5, -0.85);
  beamA.layers.enable(BLOOM_LAYER);
  g.add(beamA);
  const beamB = new THREE.Mesh(new THREE.PlaneGeometry(PILLAR_W, PILLAR_H), beamMat);
  beamB.position.set(0, PILLAR_H * 0.5, -0.85);
  beamB.rotation.y = Math.PI / 2;
  beamB.layers.enable(BLOOM_LAYER);
  g.add(beamB);
  g.userData._pillar = beamA;
  g.userData._beamMat = beamMat;

  // Mote column (32-slot InstancedMesh, rising motes).
  const MOTE_COUNT = 32;
  const moteMat = new THREE.MeshBasicMaterial({
    map: tex('moteAmber') || tex('glowWhite'),
    color: 0xffb070, transparent: true, opacity: 0.92,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const motes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.20, 0.20), moteMat, MOTE_COUNT);
  motes.frustumCulled = false;
  motes.layers.enable(BLOOM_LAYER);
  motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  motes.position.set(0, 0, -0.85);
  const moteState = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    moteState.push({
      a: Math.random() * Math.PI * 2,
      r: 0.55 + Math.random() * 0.28,
      y: Math.random() * PILLAR_H,
      speed: 0.55 + Math.random() * 0.7,
    });
  }
  motes.userData._state = moteState;
  motes.userData._pillarH = PILLAR_H;
  g.add(motes);
  g.userData._motes = motes;
  g.userData._moteMat = moteMat;

  const pl = new THREE.PointLight(0xff8a3a, 2.4, 14, 1.6);
  pl.position.set(0, 1.6, -0.85);
  g.add(pl);
  g.userData._light = pl;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
export function buildCatacomb(scene) {
  if (_group) return _group;
  _scene = scene;

  // Empty parked container — the dungeon is generated + built per entry and
  // fully disposed on exit (a 14-room dungeon is too big to park at y=-200).
  const g = new THREE.Group();
  g.name = 'catacombGroup';
  g.position.y = -200;
  scene.add(g);
  _group = g;

  // Overworld entrance — always visible in run mode.
  _entranceMesh = _makeEntranceStairs();
  _entranceMesh.position.set(ENTRANCE_POS.x, 0, ENTRANCE_POS.z);
  scene.add(_entranceMesh);

  // DOM prompt (enter/exit handled via state.input.interactPressed — see
  // tickCatacombEntrance/tickCatacomb — which already carries keyboard E AND
  // gamepad B via hero.js's shared interact listener; no window keydown here).
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-catacomb-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 10px 22px; pointer-events: none; z-index: 90;
      background: linear-gradient(180deg, rgba(40,32,24,0.94), rgba(24,18,12,0.92));
      border: 1px solid rgba(255,210,74,0.55); border-radius: 8px;
      color: #ffd24a; font: 600 16px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,210,74,0.2);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
  }
  if (!_progressEl) {
    _progressEl = document.createElement('div');
    _progressEl.id = 'kk-dungeon-progress';
    _progressEl.style.cssText = `
      position:fixed; top:max(58px,calc(env(safe-area-inset-top) + 48px));
      left:50%; transform:translateX(-50%); display:none;
      max-width:88vw; box-sizing:border-box; padding:7px 18px;
      pointer-events:none; z-index:89; white-space:nowrap; overflow:hidden;
      text-overflow:ellipsis;
      background:linear-gradient(180deg,rgba(28,22,34,.92),rgba(12,9,18,.94));
      border:1px solid rgba(210,156,255,.62); border-radius:999px;
      color:#f0dcff; font:700 14px 'Cinzel Decorative',serif;
      letter-spacing:.10em; text-align:center;
      box-shadow:0 5px 18px rgba(0,0,0,.58),0 0 16px rgba(164,92,225,.22);
      text-shadow:0 0 9px rgba(210,156,255,.54);
    `;
    document.body.appendChild(_progressEl);
  }
  return g;
}

function _ensureDepthChoice() {
  if (_depthChoiceEl) return _depthChoiceEl;
  const overlay = document.createElement('div');
  overlay.id = 'kk-catacomb-depth-choice';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Choose whether to continue deeper into the Catacomb');
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:240; display:none;
    align-items:center; justify-content:center; padding:24px;
    background:rgba(5,3,9,.72); backdrop-filter:blur(5px);
    -webkit-backdrop-filter:blur(5px); pointer-events:auto;
  `;
  const panel = document.createElement('div');
  panel.style.cssText = `
    width:min(560px,92vw); padding:26px 28px 24px; box-sizing:border-box;
    border:1px solid rgba(216,160,255,.72); border-radius:16px;
    background:linear-gradient(165deg,rgba(42,30,50,.98),rgba(15,10,22,.98));
    color:#f4e8ff; text-align:center;
    box-shadow:0 24px 70px rgba(0,0,0,.72),0 0 38px rgba(184,112,235,.22),inset 0 1px rgba(255,255,255,.08);
  `;
  const eyebrow = document.createElement('div');
  eyebrow.textContent = 'CRYPT WARDEN DEFEATED';
  eyebrow.style.cssText = `font:700 11px 'Geist Mono',monospace;letter-spacing:.28em;color:#ffd36b;margin-bottom:10px;`;
  const title = document.createElement('div');
  title.dataset.role = 'title';
  title.style.cssText = `font:700 25px 'Cinzel Decorative',serif;letter-spacing:.08em;color:#f0dcff;`;
  const copy = document.createElement('div');
  copy.dataset.role = 'copy';
  copy.style.cssText = `margin:12px auto 22px;max-width:440px;font:500 14px/1.65 'Nunito',sans-serif;color:rgba(244,232,255,.76);`;
  const actions = document.createElement('div');
  actions.style.cssText = `display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;`;
  const deeper = document.createElement('button');
  deeper.type = 'button';
  deeper.dataset.action = 'deeper';
  deeper.style.cssText = `padding:14px 16px;border:1px solid #d8a0ff;border-radius:10px;cursor:pointer;background:linear-gradient(180deg,rgba(86,48,112,.96),rgba(42,22,60,.96));color:#fff2ff;font:700 13px 'Cinzel Decorative',serif;letter-spacing:.08em;box-shadow:0 8px 20px rgba(0,0,0,.4),0 0 18px rgba(216,160,255,.18);`;
  const surface = document.createElement('button');
  surface.type = 'button';
  surface.dataset.action = 'surface';
  surface.textContent = 'Return to the Surface';
  surface.style.cssText = `padding:14px 16px;border:1px solid rgba(255,211,107,.72);border-radius:10px;cursor:pointer;background:linear-gradient(180deg,rgba(70,53,28,.94),rgba(32,23,13,.96));color:#ffe6a6;font:700 13px 'Cinzel Decorative',serif;letter-spacing:.07em;box-shadow:0 8px 20px rgba(0,0,0,.4);`;
  const hint = document.createElement('div');
  hint.textContent = 'Deeper floors grow harder and pay larger Ember, Sigil, and XP rewards.';
  hint.style.cssText = `margin-top:15px;font:600 11px/1.45 'Geist Mono',monospace;color:rgba(244,232,255,.52);letter-spacing:.03em;`;
  deeper.addEventListener('click', () => {
    continueCatacomb();
  });
  surface.addEventListener('click', () => {
    exitCatacomb();
  });
  actions.appendChild(deeper);
  actions.appendChild(surface);
  panel.appendChild(eyebrow);
  panel.appendChild(title);
  panel.appendChild(copy);
  panel.appendChild(actions);
  panel.appendChild(hint);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  overlay.userData = { title, copy, deeper, surface };
  _depthChoiceEl = overlay;
  return overlay;
}

function _openDepthChoice() {
  if (_floorTransitioning || state.mode !== 'catacomb' || !_bossCleared
      || (_rewardChest && _rewardChest.alive)) return false;
  if (isSlotOpen && isSlotOpen()) {
    try { showBanner('CHOOSE YOUR GOLDEN CHEST REWARD FIRST', 2.6, '#ffd36b'); } catch (_) {}
    return false;
  }
  if (state.pendingLevelUp || (state.pendingLevelCount || 0) > 0) {
    try { showBanner('CHOOSE YOUR LEVEL-UP REWARDS FIRST', 2.6, '#8fffe5'); } catch (_) {}
    return false;
  }
  // Pull every remaining dungeon gem into the normal XP pipeline before the
  // floor decision. If that opens a draft, keep the stairs sealed until the
  // player resolves it; continuation and Forest victory can then never stack
  // on top of a newly-created level-up modal.
  try { vacuumAllGemsInstant(); } catch (_) {}
  if (state.pendingLevelUp || (state.pendingLevelCount || 0) > 0) {
    try { showBanner('POWER GATHERED — CHOOSE YOUR LEVEL-UP REWARDS', 2.8, '#8fffe5'); } catch (_) {}
    return false;
  }
  const overlay = _ensureDepthChoice();
  if (overlay.style.display === 'flex') return true;
  const nextDepth = _floorDepth + 1;
  overlay.userData.title.textContent = `Catacomb Depth ${_floorDepth} Cleared`;
  overlay.userData.copy.textContent = `Bank this floor and return safely, or descend to Depth ${nextDepth} with your current build and health.`;
  overlay.userData.deeper.textContent = `Descend to Depth ${nextDepth}`;
  overlay.style.display = 'flex';
  _depthChoiceWasPaused = !!(state.time && state.time.paused);
  if (state.time) state.time.paused = true;
  if (state.input) state.input.interactPressed = false;
  _depthChoiceKeyHandler = (event) => {
    if (!_depthChoiceEl || _depthChoiceEl.style.display !== 'flex') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      _closeDepthChoice(true);
    }
  };
  document.addEventListener('keydown', _depthChoiceKeyHandler, true);
  requestAnimationFrame(() => { try { overlay.userData.deeper.focus(); } catch (_) {} });
  return true;
}

function _closeDepthChoice(restorePause = true) {
  if (_depthChoiceKeyHandler) {
    document.removeEventListener('keydown', _depthChoiceKeyHandler, true);
    _depthChoiceKeyHandler = null;
  }
  if (_depthChoiceEl) _depthChoiceEl.style.display = 'none';
  if (restorePause && state.time) state.time.paused = _depthChoiceWasPaused;
  _depthChoiceWasPaused = false;
  if (state.input) state.input.interactPressed = false;
}

/**
 * Run-mode: entrance FX + proximity prompt. Enters the catacomb when the hero
 * stands on the entrance and presses interact (keyboard E or gamepad B).
 */
export function tickCatacombEntrance(dt) {
  if (!_entranceMesh) return;
  if (state.mode !== 'run') {
    if (_entranceMesh.visible) _entranceMesh.visible = false;
    _activeOnEntrance = false;
    if (_promptEl && _promptEl.style.display !== 'none' && state.mode !== 'catacomb') {
      _promptEl.style.display = 'none';
    }
    return;
  }
  // Kaki Land is a floating final chapter, not an overworld exploration map.
  // The default entrance sits directly on its north bridge, so hide it and
  // suppress its prompt rather than allowing a legacy route to overlap.
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland') {
    _entranceMesh.visible = false;
    _activeOnEntrance = false;
    if (_promptEl) _promptEl.style.display = 'none';
    return;
  }
  if (!_entranceMesh.visible) _entranceMesh.visible = true;
  const gateRequired = _forestBossGateRequired();
  const gate = _forestBossGateProgress();
  const gateReady = !gateRequired || gate.unlocked;
  const entrancePos = _currentEntrancePos();
  if (_entranceMesh.position.x !== entrancePos.x || _entranceMesh.position.z !== entrancePos.z) {
    _entranceMesh.position.x = entrancePos.x;
    _entranceMesh.position.z = entrancePos.z;
  }
  _setEntranceGateVisual(gateRequired, gateReady, gate.cleared, gate.total);

  const rune = _entranceMesh.userData._rune;
  if (rune) {
    rune.material.opacity = gateReady ? 0.55 + 0.30 * Math.sin(state.time.real * 3.2) : 0.08;
    rune.rotation.y += dt * (gateReady ? (rune.userData._spin || 0.35) : 0.08);
  }
  const innerRune = _entranceMesh.userData._innerRune;
  if (innerRune) {
    innerRune.material.opacity = gateReady ? 0.55 + 0.30 * Math.sin(state.time.real * 3.2 + Math.PI) : 0.04;
    innerRune.rotation.y += dt * (gateReady ? (innerRune.userData._spin || -0.6) : -0.05);
  }
  const pillar = _entranceMesh.userData._pillar;
  if (pillar) pillar.material.opacity = gateReady ? 0.45 + 0.12 * Math.sin(state.time.real * 1.7) : 0.025;
  const motes = _entranceMesh.userData._motes;
  if (motes) {
    const states = motes.userData._state;
    const H = motes.userData._pillarH || 6;
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      s.y += s.speed * dt;
      if (s.y > H) { s.y -= H; s.a = Math.random() * Math.PI * 2; s.r = 0.55 + Math.random() * 0.28; }
      _entranceM4.makeTranslation(Math.cos(s.a) * s.r, s.y, Math.sin(s.a) * s.r);
      motes.setMatrixAt(i, _entranceM4);
    }
    motes.instanceMatrix.needsUpdate = true;
  }

  const dx = state.hero.pos.x - entrancePos.x;
  const dz = state.hero.pos.z - entrancePos.z;
  _activeOnEntrance = (dx * dx + dz * dz) < 2.2 * 2.2;
  if (_activeOnEntrance) {
    const conquered = !!(state.run && state.run.catacombCleared);
    setPromptLabel(_promptBinding, gateRequired && !gate.unlocked
      ? `Boss Gate sealed — clear Grove Trials ${gate.cleared}/${gate.total}`
      : conquered
        ? 'Boss dungeon conquered this run'
        : (_entryPromise ? 'Preparing the Boss Dungeon…' : gateRequired
          ? 'Enter the Moonroot Boss Gate'
          : 'Descend into the Catacomb'));
    _promptEl.style.display = 'block';
    if (gateReady && !conquered && !_entryPromise && state.input && state.input.interactPressed) {
      enterCatacomb({ x: state.hero.pos.x, y: 0, z: state.hero.pos.z }).catch((e) => {
        console.warn('[catacomb] entrance preparation failed:', e);
      });
    }
  } else if (_promptEl.style.display !== 'none') {
    _promptEl.style.display = 'none';
  }
}

// ── enemy teardown helpers ───────────────────────────────────────────────────
function _retireEnemy(e) {
  if (!e) return;
  e.alive = false;
  // Idempotency guard mirrors enemies.js#_releaseEnemyMesh: an enemy that died
  // DURING the run already pooled its mesh (killEnemy → corpse drain →
  // _releaseEnemyMesh, which sets _meshReleased). _chamberMobIds still holds it,
  // so re-pooling here on exit/reset would push the same mesh twice AND hide a
  // live enemy that has since reused it. Release the mesh exactly once.
  if (e._meshReleased) {
    try { if (state.enemies.spatial) state.enemies.spatial.remove(e); } catch (_) {}
    return;
  }
  releaseEnemyVisual(e);
  try { if (state.enemies.spatial) state.enemies.spatial.remove(e); } catch (_) {}
}

/**
 * Suspend the overworld cohort without killing it. Some records are owned by
 * totem/pylon/bell/Nemesis systems and must never go through generic retirement;
 * ordinary enemies also resume exactly where the player left them.
 */
function _parkOverworldEnemies() {
  const active = state.enemies.active;
  _parkedOverworldEnemies.length = 0;
  for (let i = 0; i < active.length; i++) {
    const enemy = active[i];
    if (!enemy) continue;
    const meshVisible = !!(enemy.mesh && enemy.mesh.visible);
    const tellVisible = !!(enemy._tellRing && enemy._tellRing.visible);
    _parkedOverworldEnemies.push({ enemy, meshVisible, tellVisible });
    if (enemy.mesh) enemy.mesh.visible = false;
    if (enemy._tellRing) enemy._tellRing.visible = false;
    if (enemy.isMiniBoss || enemy.isFinalBoss) {
      try { disposeBossTelegraphs(enemy); } catch (_) {}
      enemy._telegraphInit = false;
    }
    if (enemy._isSprite && enemy._spriteSlot >= 0) {
      try { moveSprite(enemy._spriteAtlasId || 'enemies', enemy._spriteSlot, 0, -500, 0); } catch (_) {}
    }
    try { if (state.enemies.spatial) state.enemies.spatial.remove(enemy); } catch (_) {}
  }
  active.length = 0;
  try { if (state.enemies.spatial && state.enemies.spatial.clear) state.enemies.spatial.clear(); } catch (_) {}
  try { resetBossTelegraphs(); } catch (_) {}
  clearEnemyProjectiles();
}

function _restoreOverworldEnemies() {
  const active = state.enemies.active;
  for (let i = 0; i < _parkedOverworldEnemies.length; i++) {
    const rec = _parkedOverworldEnemies[i];
    const enemy = rec.enemy;
    if (!enemy || !enemy.alive || active.includes(enemy)) continue;
    if (enemy.mesh) enemy.mesh.visible = rec.meshVisible;
    if (enemy._tellRing) enemy._tellRing.visible = rec.tellVisible;
    if (enemy._isSprite && enemy._spriteSlot >= 0 && enemy.mesh) {
      const p = enemy.mesh.position;
      try { moveSprite(enemy._spriteAtlasId || 'enemies', enemy._spriteSlot, p.x, 0.06, p.z); } catch (_) {}
    }
    try { if (state.enemies.spatial) state.enemies.spatial.insert(enemy); } catch (_) {}
    active.push(enemy);
  }
  _parkedOverworldEnemies.length = 0;
}

function _discardParkedOverworldEnemies() {
  for (let i = 0; i < _parkedOverworldEnemies.length; i++) {
    const enemy = _parkedOverworldEnemies[i].enemy;
    if (!enemy) continue;
    if (enemy.isMiniBoss || enemy.isFinalBoss) {
      try { disposeBossTelegraphs(enemy); } catch (_) {}
      enemy._telegraphInit = false;
    }
    // Bespoke owners are reset by their own modules during full-run teardown.
    if (enemy.isTotem || enemy.isPylon || enemy.isBell) {
      if (enemy.mesh && enemy.mesh.parent) enemy.mesh.parent.remove(enemy.mesh);
      continue;
    }
    // Nemesis geometry is unique rather than pooled; silently free it here.
    if (enemy.isNemesis && enemy.mesh) {
      if (enemy.mesh.parent) enemy.mesh.parent.remove(enemy.mesh);
      enemy.mesh.traverse((o) => {
        if (!o.isMesh) return;
        try { o.geometry && o.geometry.dispose(); } catch (_) {}
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) try { mat && mat.dispose && mat.dispose(); } catch (_) {}
      });
      enemy.alive = false;
      continue;
    }
    _retireEnemy(enemy);
  }
  _parkedOverworldEnemies.length = 0;
}

/** Pool-return only the mobs this catacomb spawned (on exit). */
function _teardownChamberMobs() {
  const active = state.enemies.active;
  for (const e of _chamberMobIds) {
    if (!e) continue;
    _retireEnemy(e);
    const idx = active.indexOf(e);
    if (idx >= 0) active.splice(idx, 1);
  }
  _chamberMobIds.clear();
}

function _hasLiveFinalBoss() {
  const active = state.enemies && state.enemies.active;
  if (!active) return false;
  for (let i = 0; i < active.length; i++) {
    const enemy = active[i];
    if (enemy && enemy.alive && enemy.isFinalBoss) return true;
  }
  return false;
}

function _entryEncounterBlocked() {
  const roomRec = state.run && state.run._sealedRooms
    && state.run._sealedRooms[state.run.currentRoom];
  let reaperActive = false;
  try { reaperActive = isForestReaperBlockingCatacomb(); } catch (_) {}
  reaperActive = reaperActive || !!(state.run
    && state.run.stage && state.run.stage.id === 'forest'
    && state.run._reaperWarned && !state.run._reaperOutlastedFired);
  const active = state.enemies && state.enemies.active;
  const liveBossEncounter = !!(active && active.some((enemy) => enemy && enemy.alive
    && (enemy.isMiniBoss || enemy.isNemesis)));
  let worldEventActive = false;
  try { worldEventActive = isMiniEventBlockingCatacomb(); } catch (_) {}
  return !!((state.run && state.run.lockdownActive)
    || (roomRec && roomRec.alive)
    || reaperActive
    || liveBossEncounter
    || worldEventActive);
}

function _entryStateIsValid() {
  return !!(_group && state.started && state.mode === 'run' && !state.gameOver
    && !state.pendingLevelUp && !(state.time && state.time.paused)
    && !_hasLiveFinalBoss() && !_entryEncounterBlocked());
}

// ── enter / exit ─────────────────────────────────────────────────────────────
export function enterCatacomb(returnPos) {
  if (!_group) return Promise.resolve(false);
  if (_entryPromise) return _entryPromise;
  if (state.run && state.run.catacombCleared) {
    try { showBanner('THE CATACOMB IS QUIET — ITS REWARD IS CLAIMED', 2.8, '#c9a4dd'); } catch (_) {}
    return Promise.resolve(false);
  }
  if (_forestBossGateRequired() && !_forestBossGateProgress().unlocked) {
    const gate = _forestBossGateProgress();
    try { showBanner(`BOSS GATE SEALED — CLEAR GROVE TRIALS ${gate.cleared}/${gate.total}`, 2.6, '#ffb36b'); } catch (_) {}
    return Promise.resolve(false);
  }
  if (_hasLiveFinalBoss()) {
    showBanner('DEFEAT THE FINAL BOSS BEFORE DESCENDING', 2.8, '#ff9a5a');
    return Promise.resolve(false);
  }
  if (_entryEncounterBlocked()) {
    try { showBanner('THE WAY BELOW WILL NOT OPEN DURING AN ENCOUNTER', 2.8, '#ff9a5a'); } catch (_) {}
    return Promise.resolve(false);
  }
  if (!_entryStateIsValid()) return Promise.resolve(false);
  const snapshot = returnPos
    ? { x: returnPos.x, y: returnPos.y || 0, z: returnPos.z }
    : { x: state.hero.pos.x, y: 0, z: state.hero.pos.z };
  if (state.run) state.run.dungeonPhase = 'PREPARING';
  try { showBanner('THE CATACOMB STIRS BELOW…', 2.2, '#c9a4dd'); } catch (_) {}

  const generation = ++_entryGeneration;
  _entryPromise = (async () => {
    // Asset preparation completes before any destructive mode/world mutation.
    await preloadDungeonKit();
    if (generation !== _entryGeneration || !_entryStateIsValid()
        || (_forestBossGateRequired() && !_forestBossGateProgress().unlocked)) {
      if (state.run && state.mode === 'run') state.run.dungeonPhase = 'IDLE';
      if (_hasLiveFinalBoss()) showBanner('THE FINAL BOSS INTERRUPTS THE DESCENT', 2.8, '#ff9a5a');
      return false;
    }
    return _commitCatacombEntry(snapshot);
  })().catch((err) => {
    if (state.run) state.run.dungeonPhase = 'IDLE';
    try { showBanner('THE CATACOMB FAILED TO OPEN', 3.0, '#ff7a6b'); } catch (_) {}
    throw err;
  }).finally(() => { _entryPromise = null; });
  return _entryPromise;
}

function _commitCatacombEntry(returnPos) {
  // Build the fully dressed procedural floor while its parent remains parked.
  // A thrown build leaves the overworld untouched and the player free to retry.
  try { disposeCatacombHazards(); } catch (_) {}
  try { disposeCatacombEncounters(); } catch (_) {}
  if (_build) { try { _build.dispose(); } catch (_) {} _build = null; }
  _disposeExit();
  _layout = null;
  _roomInfo = null;
  _floorDepth = 1;
  _buildGeneratedFloor(_floorDepth);

  _returnPos = { ...returnPos };
  // Capture ownership while still in run mode. Once below, state.mode changes
  // to `catacomb`, so the overworld gate predicate intentionally returns false.
  _forestFinaleSession = _forestBossGateRequired() && _forestBossGateProgress().unlocked;
  _enteredAtGameTime = state.time && Number.isFinite(state.time.game) ? state.time.game : 0;
  // Fresh ownership boundary: overworld mobs are parked intact rather than
  // killed, so owner-managed objectives and finale state survive the descent.
  _parkOverworldEnemies();
  resetXP();
  resetPickups();
  resetChests();
  state.mode = 'catacomb';
  _group.position.y = 0;
  if (state.envGroup) state.envGroup.position.y = -200;
  if (_entranceMesh) _entranceMesh.visible = false;

  _hiddenOverworld.length = 0;
  if (_scene) {
    const overworldRoot = /^(?:__forest|__void|__twilight|__cinder|__puzzle|__miniEvent|__arenaDecor$|__stageLife$|__dashSmashSecrets$|__portalShard$|forestSkyDome$|caveStage_|trapCorridor:|lockdownArena:)/;
    for (const child of _scene.children) {
      if (child === _group || !child.name || !overworldRoot.test(child.name)) continue;
      _hiddenOverworld.push({ child, visible: child.visible });
      child.visible = false;
    }
  }

  _beginBuiltFloor();
  try { showBanner('DEPTH 1 — CLEAR EACH SEALED CHAMBER', 3.0, '#d8a0ff'); } catch (_) {}
  return true;
}

function _buildGeneratedFloor(depth) {
  _roomCount = Math.min(20, 14 + Math.max(0, depth - 1) * 2);
  const runSeed = state.run && Number.isFinite(state.run.environmentSeed)
    ? state.run.environmentSeed >>> 0
    : Date.now() >>> 0;
  let seed = (runSeed ^ (_runSeq++ * 2654435761) ^ (depth * 2246822519)) >>> 0;
  let nextLayout = generateDungeon({ seed, roomCount: _roomCount, loopChance: 0.30 });
  for (let tries = 0; !nextLayout.valid && tries < 4; tries++) {
    seed = ((seed * 1103515245) + 12345) >>> 0;
    nextLayout = generateDungeon({ seed, roomCount: _roomCount, loopChance: 0.30 });
  }
  if (!nextLayout.valid) throw new Error('failed to generate a connected dungeon layout');
  const criticalKitKeys = ['kkd_floor_large', 'kkd_wall', 'kkd_wall_doorway', 'kk_dungeon_gate', 'skel_warrior'];
  if (!criticalKitKeys.every((key) => !!GLTF_CACHE[key])) {
    throw new Error('critical dungeon assets did not finish loading');
  }
  _layout = nextLayout;
  try {
    _build = buildDungeon(_layout, _group);
    _initRoomInfo();
    buildCatacombHazards(_layout, _build, _group, seed);
    buildCatacombEncounters(_layout, _build, _group, seed);
  } catch (err) {
    if (_build) { try { _build.dispose(); } catch (_) {} _build = null; }
    try { disposeCatacombHazards(); } catch (_) {}
    try { disposeCatacombEncounters(); } catch (_) {}
    _layout = null; _roomInfo = null;
    throw err;
  }
  return seed;
}

function _beginBuiltFloor() {
  const e = _build.entryWorld;
  state.hero.pos.set(e.x, 0, e.z);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, -1);
  _bossCleared = false;
  _exitActive = false;
  _rewardChest = null;
  _activeRoomId = -1;
  _chamberMobIds.clear();
  if (state.run) {
    state.run.dungeonPhase = 'ACTIVE';
    state.run.dungeonDepth = _floorDepth;
  }
  state.hero.iFramesUntil = Math.max(state.hero.iFramesUntil || 0, state.time.game + 2.0);
  if (_progressEl) _progressEl.style.display = 'block';
  _updateProgressHud(true);
}

/** Build the next procedural floor while keeping the current run build. */
export function continueCatacomb() {
  if (_floorTransitioning || state.mode !== 'catacomb' || !_bossCleared
      || (_rewardChest && _rewardChest.alive)) return false;
  if (isSlotOpen && isSlotOpen()) {
    try { showBanner('CHOOSE YOUR GOLDEN CHEST REWARD FIRST', 2.6, '#ffd36b'); } catch (_) {}
    return false;
  }
  if (state.pendingLevelUp || (state.pendingLevelCount || 0) > 0) {
    try { showBanner('CHOOSE YOUR LEVEL-UP REWARDS FIRST', 2.6, '#8fffe5'); } catch (_) {}
    return false;
  }
  _floorTransitioning = true;
  _closeDepthChoice(true);
  const nextDepth = _floorDepth + 1;
  try { showBanner(`DESCENDING TO CATACOMB DEPTH ${nextDepth}…`, 2.2, '#d8a0ff'); } catch (_) {}
  try {
    try { disposeCatacombHazards(); } catch (_) {}
    try { disposeCatacombEncounters(); } catch (_) {}
    _teardownChamberMobs();
    clearEnemyProjectiles();
    // Every active gem below belongs to this dungeon (overworld gems are
    // cleared on entry). Bank them before the generated floor is replaced so
    // the visible jackpot can never be lost by choosing to delve deeper.
    try { vacuumAllGemsInstant(); } catch (_) {}
    resetXP();
    resetPickups();
    resetChests();
    if (_build) { try { _build.dispose(); } catch (_) {} _build = null; }
    _disposeExit();
    _layout = null; _roomInfo = null; _bossRoomId = -1;
    _criticalPath = []; _criticalProgress = 0; _activeRoomId = -1;
    _rewardChest = null;
    _floorDepth = nextDepth;
    _buildGeneratedFloor(_floorDepth);
    _beginBuiltFloor();
    try { showBanner(`DEPTH ${_floorDepth} — ENEMIES GROW STRONGER`, 3.0, '#d8a0ff'); } catch (_) {}
    return true;
  } catch (err) {
    console.warn('[catacomb] deeper floor generation failed:', err);
    _bossCleared = true;
    _rewardChest = null;
    try { showBanner('THE DEEPER STAIR COLLAPSED — RETURNING SAFELY', 3.2, '#ffb36b'); } catch (_) {}
    return exitCatacomb();
  } finally {
    _floorTransitioning = false;
  }
}

export function exitCatacomb() {
  if (!_group) return false;
  // A descent is a committed encounter. Normal gameplay may only ascend after
  // the boss is dead and the authored reward chest has actually been claimed.
  // Run teardown still succeeds because resetCatacomb disposes the build first.
  if (state.mode === 'catacomb' && _build) {
    if (!_bossCleared) {
      showBanner('NO RETREAT — CLEAR THE SEALED DUNGEON', 2.8, '#ff9a5a');
      return false;
    }
    if (_rewardChest && _rewardChest.alive) {
      showBanner('CLAIM THE GOLDEN REWARD BEFORE ASCENDING', 2.8, '#ffd36b');
      return false;
    }
    if (isSlotOpen && isSlotOpen()) {
      showBanner('CHOOSE YOUR GOLDEN CHEST REWARD FIRST', 2.6, '#ffd36b');
      return false;
    }
    if (!_floorTransitioning && (state.pendingLevelUp || (state.pendingLevelCount || 0) > 0)) {
      showBanner('CHOOSE YOUR LEVEL-UP REWARDS FIRST', 2.6, '#8fffe5');
      return false;
    }
  }
  const completesForestFinale = _forestFinaleSession && _bossCleared;
  _closeDepthChoice(true);
  _entryGeneration++;
  if (_enteredAtGameTime != null && state.time) {
    addOverworldPause(Math.max(0, state.time.game - _enteredAtGameTime));
    _enteredAtGameTime = null;
  }
  try { disposeCatacombHazards(); } catch (_) {}
  try { disposeCatacombEncounters(); } catch (_) {}
  _teardownChamberMobs();
  clearEnemyProjectiles();
  // Preserve any reward gems the player did not physically sweep up before
  // taking the stairs. They resolve through the normal XP/level-up path.
  try { vacuumAllGemsInstant(); } catch (_) {}
  resetXP();
  resetPickups();
  resetChests();

  if (_build) { try { _build.dispose(); } catch (_) {} _build = null; }
  _disposeExit();
  _layout = null; _roomInfo = null; _bossRoomId = -1;
  _criticalPath = []; _criticalProgress = 0; _activeRoomId = -1;

  state.mode = 'run';
  _group.position.y = -200;
  if (state.envGroup) state.envGroup.position.y = 0;
  if (_entranceMesh) _entranceMesh.visible = true;
  for (const entry of _hiddenOverworld) {
    if (entry.child) entry.child.visible = entry.visible;
  }
  _hiddenOverworld.length = 0;
  if (_promptEl) _promptEl.style.display = 'none';
  if (_progressEl) _progressEl.style.display = 'none';
  _lastProgressText = '';
  _exitActive = false;
  _rewardChest = null;
  if (state.run) state.run.dungeonPhase = 'EXITED';

  // Position and protect the hero BEFORE restoring the parked overworld
  // cohort. This prevents contact, telegraphs, or a terrain tick at the return
  // point from turning a successful dungeon ascent into an apparent death.
  if (_returnPos) {
    state.hero.pos.set(_returnPos.x, _returnPos.y || 0, _returnPos.z);
    state.hero.vel.set(0, 0, 0);
    if (state.hero.mesh) {
      state.hero.mesh.position.x = _returnPos.x;
      state.hero.mesh.position.z = _returnPos.z;
    }
  }
  state.hero.hp = Math.max(1, state.hero.hp || 0);
  state.hero.iFramesUntil = Math.max(state.hero.iFramesUntil || 0, state.time.game + 4.0);
  _restoreOverworldEnemies();

  _returnPos = null;
  _forestFinaleSession = false;
  if (completesForestFinale) {
    // The Crypt Warden replaces Forest's timer-spawned final boss. Credit the
    // normal finale rewards only after the golden chest is claimed and the
    // player actually ascends, preserving the dungeon's claim gate.
    try { questEvent('finalBoss'); } catch (_) {}
    try { grantSigils(5, 'finalBoss'); } catch (_) {}
    try { showBanner('MOONROOT DUNGEON CLEARED — FOREST VICTORY', 3.8, '#ffd36b'); } catch (_) {}
    completeFinalBossVictory(state.hero.pos.x, state.hero.pos.z, { dropEndlessChests: false });
  }
  return true;
}

// ── per-entry room state ─────────────────────────────────────────────────────
function _initRoomInfo() {
  _bossRoomId = _layout.boss;
  _roomInfo = {};
  _roomIds = [];
  for (const r of _layout.rooms) {
    _roomInfo[r.id] = {
      type: r.type,
      status: 'AVAILABLE',
      cleared: false,
      active: false,
      criticalIndex: -1,
      mobs: new Set(),
      doorways: [],
      spawnPts: [],
    };
    _roomIds.push(r.id);
  }
  _criticalPath = _deriveCriticalPath();
  _criticalProgress = 0;
  for (let i = 0; i < _criticalPath.length; i++) {
    const info = _roomInfo[_criticalPath[i]];
    if (!info) continue;
    info.criticalIndex = i;
    if (i === 0) {
      info.status = 'CLEARED';
      info.cleared = true;
    } else if (i === 1) {
      info.status = 'AVAILABLE';
    } else {
      info.status = 'LOCKED';
    }
  }
  _bindRoomBuildRefs();
  _syncAllDoorLocks();
  if (state.run) {
    state.run.dungeonRoom = 0;
    state.run.dungeonRooms = Math.max(1, _criticalPath.length - 1);
  }
}

function _deriveCriticalPath() {
  const start = _layout.entrance;
  const goal = _layout.boss;
  const adj = Array.from({ length: _layout.rooms.length }, () => []);
  for (const edge of _layout.edges) {
    if (!edge.isCritical) continue;
    adj[edge.a].push(edge.b);
    adj[edge.b].push(edge.a);
  }
  const q = [start];
  const parent = new Int32Array(_layout.rooms.length);
  parent.fill(-2);
  parent[start] = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const id = q[qi];
    if (id === goal) break;
    for (const next of adj[id]) {
      if (parent[next] !== -2) continue;
      parent[next] = id;
      q.push(next);
    }
  }
  if (parent[goal] === -2) return [start, goal];
  const path = [];
  for (let id = goal; id >= 0; id = parent[id]) path.push(id);
  path.reverse();
  return path;
}

function _bindRoomBuildRefs() {
  for (const id in _roomInfo) { _roomInfo[id].doorways.length = 0; _roomInfo[id].spawnPts.length = 0; }
  for (const dc of _build.doorwayCells) {
    if (dc.roomId >= 0 && _roomInfo[dc.roomId]) _roomInfo[dc.roomId].doorways.push({ x: dc.x, y: dc.y });
  }
  for (const sp of _build.spawnPointsWorld) {
    if (_roomInfo[sp.roomId]) _roomInfo[sp.roomId].spawnPts.push(sp);
  }
}

function _syncRoomDoorLocks(info) {
  if (!info || !_build) return;
  const progression = info.status === 'LOCKED';
  const encounter = info.status === 'ACTIVE';
  for (const dc of info.doorways) {
    _build.setSealed(dc.x, dc.y, progression, 'progression');
    _build.setSealed(dc.x, dc.y, encounter, 'encounter');
  }
}

function _syncAllDoorLocks() {
  if (!_roomInfo) return;
  for (let i = 0; i < _roomIds.length; i++) _syncRoomDoorLocks(_roomInfo[_roomIds[i]]);
}

// ── spawn / encounter ────────────────────────────────────────────────────────
function _fallbackTier() {
  if (!_fallbackCache) {
    _fallbackCache = ENEMY_TIERS.find(t => t.glb === 'skeleton')
      || ENEMY_TIERS.find(t => t.hp <= 20 && !t.elite && !t.ranged && !t.dungeon);
  }
  return _fallbackCache;
}
function _aliveSkinned() {
  let n = 0;
  for (const e of _chamberMobIds) if (e && e.alive && e.glbKey && e.glbKey.indexOf('skel_') === 0) n++;
  return n;
}
function _pickTier(tierNum) {
  const glb = tierNum >= 3 ? 'skel_mage' : (tierNum === 2 ? 'skel_rogue' : 'skel_minion');
  if (GLTF_CACHE[glb] && _aliveSkinned() < SKEL_CAP) {
    const t = ENEMY_TIERS.find(x => x.glb === glb);
    if (t) return t;
  }
  return _fallbackTier();
}
function _spawnAt(tier, x, z) {
  if (!tier || !_fnSpawnEnemy) return null;
  const depthStep = Math.max(0, _floorDepth - 1);
  const scaledTier = depthStep > 0 ? {
    ...tier,
    hp: Math.max(1, (tier.hp || 1) * (1 + depthStep * 0.32)),
    dmg: Math.max(1, (tier.dmg || 1) * (1 + depthStep * 0.12)),
    spd: Math.min((tier.spd || 1) * (1 + depthStep * 0.025), (tier.spd || 1) + 0.45),
  } : tier;
  try { return _fnSpawnEnemy(scaledTier, x, z) || null; } catch (_) { return null; }
}

function _activateRoom(id) {
  const info = _roomInfo[id];
  if (!info || info.status !== 'AVAILABLE' || _activeRoomId >= 0) return;
  info.status = 'ACTIVE';
  info.active = true;
  _activeRoomId = id;
  _syncRoomDoorLocks(info);
  _spawnRoom(id);
  activateCatacombEncounter(id, info.mobs);
  if (info.mobs.size === 0) {
    _clearRoom(id);
    return;
  }
  const boss = id === _bossRoomId;
  try { showBanner(boss ? 'BOSS CHAMBER SEALED' : `CHAMBER SEALED — ${info.mobs.size} ENEMIES`, 2.4, boss ? '#ffb85c' : '#c89cff'); } catch (_) {}
  _updateProgressHud(true);
}
function _spawnRoom(id) {
  const info = _roomInfo[id];
  const isBoss = id === _bossRoomId;
  const isElite = info.type === TYPE.ELITE;
  const cap = ENEMY_TIERS.find(t => t.glb === 'skel_warrior');
  const r = _layout.rooms[id];
  let roleIndex = 0;

  if (isBoss) {
    const base = cap || _fallbackTier();
    const w = _build.cellToWorld(r.cx, r.cy);
    const bossTier = base ? {
      ...base,
      hp: base.hp * 6,
      dmg: Math.max(base.dmg, 14) * 1.25,
      spd: Math.min(base.spd, 1.9),
      scale: (base.scale || 1) * 1.55,
      elite: true,
      isMiniBoss: true,
      displayName: 'CRYPT WARDEN',
    } : null;
    const bossEnemy = _spawnAt(bossTier, w.x, w.z);
    if (bossEnemy) {
      bossEnemy._isDungeonBoss = true;
      bossEnemy.displayName = 'CRYPT WARDEN';
      decorateCatacombEnemy(bossEnemy, id, roleIndex++);
      info.mobs.add(bossEnemy);
      _chamberMobIds.add(bossEnemy);
    }
  } else if (isElite && cap) {
    const w = _build.cellToWorld(r.cx, r.cy);
    // displayName must exist BEFORE spawnEnemy: its elite-intro cinematic fires
    // inside spawnEnemy, before the spectral role decorator runs.
    const elite = _spawnAt({ ...cap, displayName: 'BELL GUARDIAN' }, w.x, w.z);
    if (elite) {
      decorateCatacombEnemy(elite, id, roleIndex++, 'BELL GUARDIAN');
      info.mobs.add(elite); _chamberMobIds.add(elite);
    }
  }

  const spawnLimit = isBoss ? 4 : 8;
  for (let i = 0; i < info.spawnPts.length && i < spawnLimit; i++) {
    const sp = info.spawnPts[i];
    const e = _spawnAt(_pickTier(sp.tier), sp.x, sp.z);
    if (e) {
      decorateCatacombEnemy(e, id, roleIndex++);
      info.mobs.add(e); _chamberMobIds.add(e);
    }
  }
}

function _enterRoom(id) {
  const info = _roomInfo[id];
  if (!info || info.status !== 'AVAILABLE' || _activeRoomId >= 0) return;
  const t = info.type;
  if (t === TYPE.COMBAT || t === TYPE.ELITE || t === TYPE.BOSS) {
    _activateRoom(id);
  } else if (t === TYPE.TREASURE) {
    const r = _layout.rooms[id];
    const w = _build.cellToWorld(r.cx, r.cy);
    if (_fnSpawnChest) _fnSpawnChest(w.x, w.z, { assetKey: 'kkd_chest' });
    _clearRoom(id);
  } else if (t === TYPE.SHRINE) {
    const r = _layout.rooms[id];
    const w = _build.cellToWorld(r.cx, r.cy);
    if (_fnSpawnHeart) _fnSpawnHeart(w.x, w.z);
    try { grantEmbers(1); } catch (_) {}
    _clearRoom(id);
  } else {
    _clearRoom(id);   // entrance / untyped
  }
}

function _clearRoom(id) {
  const info = _roomInfo[id];
  if (!info || info.status === 'CLEARED') return;
  info.status = 'CLEARED';
  info.cleared = true;
  info.active = false;
  completeCatacombEncounter(id);
  _syncRoomDoorLocks(info);
  if (_activeRoomId === id) _activeRoomId = -1;

  const ci = info.criticalIndex;
  if (ci > 0 && ci === _criticalProgress + 1) {
    _criticalProgress = ci;
    const nextId = _criticalPath[ci + 1];
    if (nextId != null && _roomInfo[nextId] && _roomInfo[nextId].status === 'LOCKED') {
      _roomInfo[nextId].status = 'AVAILABLE';
      _syncRoomDoorLocks(_roomInfo[nextId]);
    }
    if (state.run) state.run.dungeonRoom = Math.min(_criticalProgress, state.run.dungeonRooms || _criticalProgress);
  }
  if (id === _bossRoomId) {
    if (_bossCleared) return;
    _bossCleared = true;
    const r = _layout.rooms[id];
    const w = _build.cellToWorld(r.cx, r.cy);
    const cx = w.x, cz = w.z;
    _dropBossReward(cx, cz);
    _spawnExit(cx, cz);
    if (state.run) {
      state.run.catacombCleared = true;
      state.run.dungeonPhase = 'REWARD';
      if (_forestFinaleSession && state.run.forestPortalTrials) {
        state.run.forestPortalTrials.bossDefeated = true;
      }
    }
    try { showBanner('DUNGEON CONQUERED — CLAIM THE GOLDEN REWARD', 4.0, '#ffd36b'); } catch (_) {}
    try { setUnlockFlag('catacombClear'); } catch (_) {}   // radcat avatar
    // Level-3 gate: clearing the catacomb credits one Portal Shard (the
    // "dungeon" source). Pushed to the same earned-shard queue elite kills use;
    // portalShards drains it back in the overworld, honored only while it still
    // owes earned shards. Dropped just past the overworld entrance so it
    // surfaces where the hero emerges. Cinder-only; no-op on other stages.
    try {
      const shardObjectiveEnabled = !(state.modes
        && (state.modes.bossRush || state.modes.daily || state.modes.weekly));
      if (shardObjectiveEnabled && state.run && state.run.stage && state.run.stage.id === 'cinder'
          && !state.run._catacombShardGranted) {
        (state.run._shardDrops || (state.run._shardDrops = [])).push({ x: ENTRANCE_POS.x, z: ENTRANCE_POS.z + 3 });
        state.run._catacombShardGranted = true;
      }
    } catch (_) {}
  } else {
    try { showBanner(ci > 0 ? 'ROOM CLEARED — THE NEXT GATE OPENS' : 'SIDE CHAMBER CLEARED', 2.3, '#9fe0bf'); } catch (_) {}
  }
  _updateProgressHud(true);
}

function _dropBossReward(cx, cz) {
  if (_fnSpawnChest) _rewardChest = _fnSpawnChest(cx + 2.6, cz, { assetKey: 'kkd_chest_gold' });
  // Catacombs are an opt-in commitment, so their meta payout deliberately
  // beats a normal side event: ~9 Embers, 3 Sigils, a persistent clear tally,
  // and the first-clear Moonbell Collar for MaoMao's Daycare.
  const depthBonus = Math.max(0, _floorDepth - 1);
  try { grantEmbers(Math.max(8, Math.round(_roomCount * 0.65)) + depthBonus * 3); } catch (_) {}
  try { grantSigils(3 + Math.min(4, depthBonus), 'catacomb'); } catch (_) {}
  let reward = null;
  try { reward = grantCatacombReward(_floorDepth, _layout?.seed); } catch (_) {}
  // Jackpot XP fan (about 1.8 current levels; rides dropGem so vacuum + level
  // cascade stay intact rather than bypassing normal progression feedback).
  try {
    const total = Math.ceil((state.hero.xpNext || 100) * (1.8 + depthBonus * 0.35) * (_roomCount / 14));
    // Keep the fan visually generous without the old 20-XP-per-gem floor.
    // At low levels that floor inflated a stated ~1.8-level reward into
    // roughly ten drafts, hiding the descend/return decision behind a long
    // modal cascade. The total now stays level-relative at every depth.
    const N = 12, per = Math.max(1, Math.ceil(total / N));
    if (_fnDropGem) for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      _rewardGemPos.set(cx + Math.cos(a) * 2.2, 0.3, cz + Math.sin(a) * 2.2);
      _fnDropGem(_rewardGemPos, per);
    }
  } catch (_) {}
  if (reward?.moonbellNew) {
    setTimeout(() => {
      try { showBanner('EXCLUSIVE FIND — MAOMAO’S MOONBELL COLLAR', 4.2, '#8fffe5'); } catch (_) {}
    }, 1300);
  }
}

// ── exit stairs (spawned at the boss room on clear) ──────────────────────────
function _makeExitStairs() {
  const g = new THREE.Group();
  const kit = cloneCached('kkd_stairs');
  if (kit) {
    kit.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(kit);
    const sz = new THREE.Vector3(); b.getSize(sz);
    kit.scale.setScalar(3.2 / (sz.y > 1e-3 ? sz.y : 3.2));
    kit.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(kit);
    kit.position.y = -b2.min.y;
    kit.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.add(kit);
  } else {
    for (let i = 0; i < 3; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(2.6 - i * 0.4, 0.2 + i * 0.1, 0.5), _mat(0x6a6050, 0.92));
      step.position.set(0, 0.1 + i * 0.18, i * 0.5);
      step.castShadow = true; step.receiveShadow = true;
      g.add(step);
    }
  }
  const rune = new THREE.Mesh(
    floorDecalGeometry(1.7),
    floorDecalMaterial({ map: _getRuneTex(), color: 0xc87bff, opacity: 0.85 }),
  );
  rune.position.set(0, 0.05, 0);
  applyFloorTier(rune, 'portal');
  g.add(rune);
  const pl = new THREE.PointLight(0xc87bff, 1.8, 12, 1.6);
  pl.position.set(0, 2.0, 0);
  g.add(pl);
  return g;
}
function _spawnExit(cx, cz) {
  if (_exit) return;
  const g = _makeExitStairs();
  g.position.set(cx, 0, cz);
  _group.add(g);   // lives in the container so a build rebuild can't dispose it
  _exit = { group: g, x: cx, z: cz };
}
function _disposeExit() {
  if (!_exit) return;
  if (_exit.group.parent) _exit.group.parent.remove(_exit.group);
  _exit = null;
  _exitActive = false;
}

// ── grid collision (circle-vs-solid-cell slide) ──────────────────────────────
function _slideResolve(px, pz) {
  if (!_build) { _resOut.x = px; _resOut.z = pz; return; }
  const CELL = _build.CELL, Wg = _build.W, Hg = _build.H, r = HERO_R;
  let x = px, z = pz;
  const cc = _build.worldToCell(x, z);
  const cx = cc.x, cy = cc.y;   // read immediately (worldToCell reuses one obj)
  for (let pass = 0; pass < 2; pass++) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy;
      if (_build.walkable(gx, gy)) continue;   // walkable → not solid
      const minX = (gx - Wg / 2) * CELL, minZ = (gy - Hg / 2) * CELL;
      const maxX = minX + CELL, maxZ = minZ + CELL;
      const clx = x < minX ? minX : (x > maxX ? maxX : x);
      const clz = z < minZ ? minZ : (z > maxZ ? maxZ : z);
      const ddx = x - clx, ddz = z - clz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2), pen = r - d;
        x += (ddx / d) * pen; z += (ddz / d) * pen;
      } else {
        // centre inside a solid cell — eject along the shallowest face
        const pl = x - minX, pr = maxX - x, pu = z - minZ, pd = maxZ - z;
        const mn = Math.min(pl, pr, pu, pd);
        if (mn === pl) x = minX - r; else if (mn === pr) x = maxX + r;
        else if (mn === pu) z = minZ - r; else z = maxZ + r;
      }
    }
  }
  _resOut.x = x; _resOut.z = z;
}

function _tickRooms() {
  if (!_roomInfo || !_build || !_layout) return;
  const cc = _build.worldToCell(state.hero.pos.x, state.hero.pos.z);
  const cx = cc.x, cy = cc.y;
  if (cx >= 0 && cy >= 0 && cx < _build.W && cy < _build.H) {
    const rid = _layout.roomId[cy * _build.W + cx];
    if (rid >= 0 && _roomInfo[rid] && _roomInfo[rid].status === 'AVAILABLE' && _activeRoomId < 0) {
      _enterRoom(rid);
    }
  }
  // Clear active rooms whose mobs are all dead. Iterate the cached numeric-id
  // array (no per-frame for-in / string coercion).
  for (let i = 0; i < _roomIds.length; i++) {
    const id = _roomIds[i];
    const info = _roomInfo[id];
    if (!info.active || info.cleared) continue;
    let alive = 0;
    for (const e of info.mobs) if (e && e.alive) alive++;
    if (alive === 0) _clearRoom(id);
  }
}

function _updateProgressHud(force = false) {
  if (!_progressEl) return;
  if (state.mode !== 'catacomb' || !_layout || !_roomInfo) {
    _progressEl.style.display = 'none';
    return;
  }
  let text;
  if (_bossCleared) {
    const rewardPending = !!(_rewardChest && _rewardChest.alive);
    if (!rewardPending && state.run && state.run.dungeonPhase === 'REWARD') {
      state.run.dungeonPhase = 'CHOICE';
    }
    text = rewardPending
      ? `DEPTH ${_floorDepth} CLEARED  •  CLAIM THE GOLDEN REWARD`
      : `DEPTH ${_floorDepth} CLEARED  •  CHOOSE DEEPER OR SURFACE AT THE STAIRS`;
  } else if (_activeRoomId >= 0) {
    const info = _roomInfo[_activeRoomId];
    let alive = 0;
    let boss = null;
    for (const e of info.mobs) {
      if (!e || !e.alive) continue;
      alive++;
      if (e._isDungeonBoss) boss = e;
    }
    if (boss) {
      const hpPct = Math.max(0, Math.ceil((boss.hp / Math.max(1, boss.hpMax)) * 100));
      text = `DEPTH ${_floorDepth}  •  CRYPT WARDEN  ${hpPct}%  •  ${Math.max(0, alive - 1)} MINIONS`;
    } else {
      text = info.criticalIndex > 0
        ? `DEPTH ${_floorDepth}  •  ROOM ${info.criticalIndex} / ${Math.max(1, _criticalPath.length - 1)}  •  DEFEAT ${alive}`
        : `DEPTH ${_floorDepth}  •  SIDE CHAMBER  •  DEFEAT ${alive}`;
    }
    const mechanic = catacombEncounterLabel(_activeRoomId);
    if (mechanic) text += `  •  ${mechanic}`;
  } else {
    const next = Math.min(_criticalProgress + 1, Math.max(1, _criticalPath.length - 1));
    const bossNext = _criticalPath[next] === _bossRoomId;
    text = bossNext
      ? `FLOOR ${_floorDepth}  •  ROOM ${next} / ${Math.max(1, _criticalPath.length - 1)}  •  BOSS GATE OPEN`
      : `FLOOR ${_floorDepth}  •  ROOM ${_criticalProgress} / ${Math.max(1, _criticalPath.length - 1)}  •  ADVANCE TO THE OPEN GATE`;
  }
  if (force || text !== _lastProgressText) {
    _progressEl.textContent = text;
    _progressEl.dataset.phase = (state.run && state.run.dungeonPhase) || 'ACTIVE';
    _progressEl.dataset.room = String(_criticalProgress);
    _progressEl.dataset.rooms = String(Math.max(1, _criticalPath.length - 1));
    _progressEl.dataset.depth = String(_floorDepth);
    _lastProgressText = text;
  }
  if (_progressEl.style.display !== 'block') _progressEl.style.display = 'block';
}

// ── per-frame tick (catacomb mode) ───────────────────────────────────────────
export function tickCatacomb(dt) {
  if (state.mode !== 'catacomb') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    return;
  }
  if (!_group || !_build) return;

  // Torch flicker + nearest-N PointLight pooling (allocation-free).
  _build.torchTick(dt, state.hero.pos);
  _build.tickDoors(dt);

  // Grid collision — hero, then a module-owned post-pass over enemies (keeps
  // enemies.js untouched). tickCatacomb runs AFTER updateHero/updateEnemies.
  const h = state.hero.pos;
  _slideResolve(h.x, h.z); h.x = _resOut.x; h.z = _resOut.z;
  const active = state.enemies.active;
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || !e.alive || !e.mesh) continue;
    const ep = e.mesh.position;
    _slideResolve(ep.x, ep.z); ep.x = _resOut.x; ep.z = _resOut.z;
  }

  _tickRooms();
  _updateProgressHud();

  // Environmental traps — phase advance + damage. Runs on final hero/enemy
  // positions (collision already resolved above). Owns hazardSlow in catacomb.
  tickCatacombHazards(dt);
  tickCatacombEncounters(dt);

  // Exit stairs prompt (only exists after the boss room is cleared).
  if (_exit) {
    const dx = h.x - _exit.x, dz = h.z - _exit.z;
    // The golden chest sits 2.6u from the stairs. A slightly wider choice
    // radius lets the next-step prompt appear while the player is still at the
    // claimed chest instead of demanding a confusing pixel-perfect shuffle.
    _exitActive = (dx * dx + dz * dz) < 3.5 * 3.5;
    if (_exitActive) {
      const rewardPending = !!(_rewardChest && _rewardChest.alive);
      setPromptLabel(_promptBinding, rewardPending ? 'Claim the golden reward first' : 'Choose: delve deeper or return to the surface');
      _promptEl.style.display = 'block';
      if (!rewardPending && state.input && state.input.interactPressed) {
        _openDepthChoice();
        return;
      }
    } else if (_promptEl.style.display !== 'none') {
      _promptEl.style.display = 'none';
    }
  } else if (_promptEl && _promptEl.style.display !== 'none') {
    _promptEl.style.display = 'none';
  }
}

export function isInCatacomb() {
  return state.mode === 'catacomb';
}

export function resetCatacomb() {
  // Run teardown — make sure we're not stuck in catacomb mode and everything
  // this catacomb owns is freed.
  try { disposeCatacombHazards(); } catch (_) {}
  try { disposeCatacombEncounters(); } catch (_) {}
  _closeDepthChoice(false);
  _entryGeneration++;
  _discardParkedOverworldEnemies();
  resetXP();
  resetPickups();
  resetChests();
  if (_chamberMobIds.size > 0) {
    const active = state.enemies.active;
    for (const e of _chamberMobIds) {
      if (!e) continue;
      _retireEnemy(e);
      const idx = active.indexOf(e);
      if (idx >= 0) active.splice(idx, 1);
    }
    _chamberMobIds.clear();
  }
  if (_build) { try { _build.dispose(); } catch (_) {} _build = null; }
  _disposeExit();
  _layout = null; _roomInfo = null; _bossRoomId = -1;
  _returnPos = null; _bossCleared = false; _exitActive = false; _rewardChest = null;
  _floorDepth = 0; _floorTransitioning = false;
  _forestFinaleSession = false;
  _enteredAtGameTime = null;
  _criticalPath = []; _criticalProgress = 0; _activeRoomId = -1;
  if (_group) _group.position.y = -200;
  if (state.envGroup && state.envGroup.position.y < 0) state.envGroup.position.y = 0;
  for (const entry of _hiddenOverworld) {
    if (entry.child) entry.child.visible = entry.visible;
  }
  _hiddenOverworld.length = 0;
  if (_entranceMesh) _entranceMesh.visible = true;
  if (_promptEl) _promptEl.style.display = 'none';
  if (_progressEl) _progressEl.style.display = 'none';
  _lastProgressText = '';
  if (state.run) {
    state.run.dungeonPhase = 'IDLE';
    state.run.dungeonDepth = 0;
    state.run.dungeonRoom = 0;
    state.run.dungeonRooms = 0;
  }
}

/** Focused browser-test snapshot; no mutable internals escape. */
export function _debugCatacombState() {
  const rooms = [];
  if (_roomInfo) for (let i = 0; i < _roomIds.length; i++) {
    const id = _roomIds[i];
    const info = _roomInfo[id];
    const room = _layout && _layout.rooms[id];
    const center = room && _build ? _build.cellToWorld(room.cx, room.cy) : null;
    let alive = 0;
    for (const e of info.mobs) if (e && e.alive) alive++;
    rooms.push({
      id,
      type: info.type,
      encounter: room?.encounter || null,
      status: info.status,
      criticalIndex: info.criticalIndex,
      alive,
      center: center ? { x: center.x, z: center.z } : null,
      doors: info.doorways.map((dc) => ({
        x: dc.x,
        y: dc.y,
        lockMask: _build ? _build.doorLockMask(dc.x, dc.y) : 0,
        collisionBlocked: _build ? !_build.walkable(dc.x, dc.y) : false,
      })),
    });
  }
  let heroCell = null;
  let heroRoomId = -1;
  if (_build && _layout && state.hero && state.hero.pos) {
    const cell = _build.worldToCell(state.hero.pos.x, state.hero.pos.z);
    heroCell = { x: cell.x, y: cell.y };
    if (cell.x >= 0 && cell.y >= 0 && cell.x < _build.W && cell.y < _build.H) {
      heroRoomId = _layout.roomId[cell.y * _build.W + cell.x];
    }
  }
  return {
    mode: state.mode,
    paused: !!(state.time && state.time.paused),
    gameOver: !!state.gameOver,
    pendingLevelUp: !!state.pendingLevelUp,
    pendingLevelCount: state.pendingLevelCount || 0,
    hero: state.hero && state.hero.pos
      ? { x: state.hero.pos.x, z: state.hero.pos.z, cell: heroCell, roomId: heroRoomId }
      : null,
    phase: state.run && state.run.dungeonPhase,
    floorDepth: _floorDepth,
    choiceOpen: !!(_depthChoiceEl && _depthChoiceEl.style.display === 'flex'),
    criticalPath: _criticalPath.slice(),
    criticalProgress: _criticalProgress,
    activeRoomId: _activeRoomId,
    bossRoomId: _bossRoomId,
    bossCleared: _bossCleared,
    rewardPending: !!(_rewardChest && _rewardChest.alive),
    reward: _rewardChest ? {
      alive: !!_rewardChest.alive,
      x: _rewardChest.x,
      z: _rewardChest.z,
      attached: !!(_rewardChest.group && _rewardChest.group.parent),
    } : null,
    exit: _exit ? { x: _exit.x, z: _exit.z } : null,
    parkedOverworldEnemies: _parkedOverworldEnemies.length,
    rooms,
    mechanics: debugCatacombEncounters(),
  };
}
