/**
 * Helltide — timed overlay mega-event (iter 17).
 *
 * Inspired by Diablo IV Helltide: the world TURNS on the player for 3 minutes.
 *   • Sky/fog/light shift to hellfire red (env.js applyHelltideOverlay).
 *   • Spawn rate spikes (state.run.helltideSpawnMul, read by spawnDirector).
 *   • 3-5 concurrent mini-sub-events scattered around the hero: Tortured
 *     Gift Chests, Threat Packs, Hellfire Altars, Mini-Boss Surges.
 *   • Hellfire Embers drop from kills (red gem visual, auto-banked on
 *     proximity pickup). Lost-on-ground at event end.
 *
 * Architectural notes:
 *   • This module owns all helltide state. miniEvents.js calls tickHelltide()
 *     so the existing scheduler stays single-slot for non-helltide events.
 *   • Kill-detection uses a poll-and-diff over state.enemies.active (we can't
 *     edit src/enemies.js this iter). Each tick we walk the active list:
 *     newly-seen enemies get a pre-rolled ember chance; previously-seen
 *     enemies whose alive=false drop an ember at their last-known mesh pos.
 *   • Ember pickups are NOT XP gems — they're a tiny custom pool with
 *     hero-proximity scan. Banked directly to state.run.helltideEmbersBanked.
 *   • Hellfire ember rain is one InstancedMesh of red plane sprites with
 *     curl noise. Capped at 80 instances.
 *
 * Tunables: see constants at the top. All durations in seconds.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENEMY_TIERS, SPAWN } from './config.js';
import { spawnEnemy } from './enemies.js';
import { showBanner, showHelltideBar, hideHelltideBar } from './ui.js';
import { sfx } from './audio.js';
import { bumpLifetime, getMeta, saveMeta } from './meta.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { tex } from './particleTextures.js';
import { makeRuneRingTexture } from './enemyTells.js';
import { spawnKillRing, spawnMagnetSpark } from './fx.js';
import { overworldTime } from './runClock.js';
import { fxTex } from './fxTextures.js';

// ── Tunables ─────────────────────────────────────────────────────────────────
const HELLTIDE_DURATION       = 180;   // sec (3 min — first-cut)
const HELLTIDE_INTERVAL_MIN   = 240;   // earliest next auto-trigger after end (4 min)
const HELLTIDE_INTERVAL_MAX   = 360;   // latest (6 min)
const HELLTIDE_FIRST_AT_MIN   = 240;   // never trigger before this game-time
const HELLTIDE_FIRST_AT_MAX   = 360;   // upper bound for first trigger
const HELLTIDE_COOLDOWN_MIN   = 90;    // safety: at least 90s between events

const SPAWN_MUL_DURING        = 2.5;   // spawnDirector reads this from state.run

// Ember economy
const EMBER_DROP_BASE         = 0.20;  // base chance per kill
const EMBER_DROP_ELITE_BONUS  = 0.05;  // additive for elite (no double-counts)
const EMBER_DROP_BOSS_BONUS   = 0.30;  // additive for mini/final-boss
const EMBER_PICKUP_R          = 1.8;
const EMBER_PICKUP_R2         = EMBER_PICKUP_R * EMBER_PICKUP_R;
const EMBER_CAP               = 256;   // pool ceiling

// Sub-event cadence: one fires every 25-45s; pause if we already have 4 active.
const SUBEVENT_INTERVAL_MIN   = 25;
const SUBEVENT_INTERVAL_MAX   = 45;
const SUBEVENT_MAX_CONCURRENT = 4;

// Altar
const ALTAR_DURATION          = 30;    // sec
const ALTAR_RADIUS            = 8;     // u — kills within this radius double-drop embers

// Mini-boss surge
const SURGE_HP_MUL            = 1.5;   // bump elite HP
const SURGE_EMBER_DROP        = 30;    // banked on kill (in addition to roll)

// Threat pack
const THREAT_PACK_MIN         = 4;
const THREAT_PACK_MAX         = 6;

// Tortured Gift chest
const CHEST_COST              = 50;    // embers to open
const CHEST_PICKUP_R2         = 2.25 * 2.25;
const CHEST_MAX_LIFETIME      = 999;   // event-end cleans them up anyway

// Hellfire ember rain (visual only)
const EMBER_RAIN_CAP          = 80;
const EMBER_RAIN_SPAWN_RATE   = 12;    // per second

// ── Module state ─────────────────────────────────────────────────────────────
let _scene = null;
let _giftPrompt = null;
let _giftPromptWanted = false;
let _giftPromptWantedText = '';
let _giftPromptPainted = false;
let _giftPromptPaintedText = '';
let _runeTex = null;
function _getRuneTex() { return _runeTex || (_runeTex = makeRuneRingTexture()); }
let _giftTexDirect = null;
const _giftTextureLoader = new THREE.TextureLoader();
function _getGiftTexture() {
  const authored = fxTex('helltide_tortured_gift');
  if (authored) return authored;
  if (!_giftTexDirect) {
    _giftTexDirect = _giftTextureLoader.load(new URL('../assets/fx/props/helltide_tortured_gift.webp', import.meta.url).href);
    _giftTexDirect.colorSpace = THREE.SRGBColorSpace;
    _giftTexDirect.minFilter = THREE.LinearMipmapLinearFilter;
    _giftTexDirect.magFilter = THREE.LinearFilter;
  }
  return _giftTexDirect;
}
function _ensureGiftPrompt() {
  if (_giftPrompt) return _giftPrompt;
  _giftPrompt = document.createElement('div');
  _giftPrompt.id = 'kk-helltide-gift-prompt';
  _giftPrompt.style.cssText = `position:fixed;left:50%;bottom:18%;transform:translateX(-50%);z-index:91;display:none;pointer-events:none;padding:6px 11px;border:1px solid rgba(255,126,74,.62);border-radius:7px;background:rgba(28,11,8,.88);color:#ffd7bd;font:700 11px 'Geist Mono',monospace;letter-spacing:.08em;box-shadow:0 5px 16px rgba(0,0,0,.5);`;
  document.body.appendChild(_giftPrompt);
  return _giftPrompt;
}

function _flushGiftPrompt() {
  const prompt = _ensureGiftPrompt();
  if (_giftPromptWanted && _giftPromptWantedText !== _giftPromptPaintedText) {
    prompt.textContent = _giftPromptWantedText;
    _giftPromptPaintedText = _giftPromptWantedText;
  }
  if (_giftPromptWanted !== _giftPromptPainted) {
    prompt.style.display = _giftPromptWanted ? 'block' : 'none';
    _giftPromptPainted = _giftPromptWanted;
  }
}

function _hideGiftPrompt() {
  _giftPromptWanted = false;
  _giftPromptWantedText = '';
  _flushGiftPrompt();
}

function _disposeSubeventVisual(ev) {
  if (!ev) return;
  const roots = [];
  if (ev.group) roots.push(ev.group);
  if (ev.tellRing && ev.tellRing !== ev.group) roots.push(ev.tellRing);
  const geometries = new Set();
  const materials = new Set();
  for (const root of roots) {
    if (root.parent) root.parent.remove(root);
    root.traverse((obj) => {
      // THREE.Sprite instances share one internal quad geometry across the
      // renderer; disposing that shared singleton would corrupt unrelated
      // sprite systems. Only event-owned Mesh geometries are released here.
      if (obj.geometry && !obj.isSprite) geometries.add(obj.geometry);
      if (obj.material) {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const material of list) if (material) materials.add(material);
      }
    });
  }
  // Maps are cached by fxTextures/particleTextures and intentionally survive;
  // only the unique sub-event geometry/material wrappers are released.
  for (const geometry of geometries) { try { geometry.dispose(); } catch (_) {} }
  for (const material of materials) { try { material.dispose(); } catch (_) {} }
  ev.group = null;
  ev.tellRing = null;
}

// Sub-events live here. Each entry: { kind, ...data }
const _subevents = [];
let _nextSubeventAt = 0;

// Banked ember drops (visible red sprites on the ground until picked up)
// Pooled via a small InstancedMesh; per-ember state in _embers.
let _emberInst = null;
const _embers = [];          // { x, z, age, slot, value, alive }
let _activeEmberCount = 0;
let _emberMatrix = new THREE.Matrix4();
let _emberHideMat = null;
const _emberScale = new THREE.Vector3();
const _pillarCamFallback = new THREE.Vector3(0, 60, 60);

// Hellfire rain particles
let _rainInst = null;
const _rain = [];            // { x, y, z, vx, vy, vz, age, life, slot }
let _activeRainCount = 0;
let _rainSpawnAcc = 0;
let _rainMatrix = new THREE.Matrix4();
let _rainHideMat = null;

// Kill-detection scratch: Map<enemyRef, {count, x, z}> of tracked enemies.
//
// IMPORTANT: src/enemies.js killEnemy splices the dead enemy out of
// state.enemies.active in the SAME tick it kills them (updateEnemies →
// damageEnemy → killEnemy → arr.pop). By the time tickHelltide runs we
// CANNOT observe `!alive && in active[]` — the enemy is already gone.
//
// Fix: track snapshots in a parallel Map keyed by enemy ref. Each tick,
// (1) update positions for living entries, (2) detect entries no longer
// in active[] (= dead OR escaped), and drop embers at the last snapshot.
// We need a regular Map (not WeakMap) so we can iterate; manual clear on
// teardown keeps memory bounded.
let _tracked = new Map();              // enemy → { count, x, z }
let _activeScratch = new Set();        // reused per-tick to diff active[] against _tracked

function _clearEmberPool() {
  for (const ember of _embers) {
    if (ember && _emberInst && _emberHideMat) {
      _emberInst.setMatrixAt(ember.slot, _emberHideMat);
    }
  }
  _embers.length = 0;
  _activeEmberCount = 0;
  if (_emberInst) {
    _emberInst.instanceMatrix.needsUpdate = true;
    _emberInst.visible = false;
  }
}

function _clearRainPool() {
  for (const rain of _rain) {
    if (rain && _rainInst && _rainHideMat) {
      _rainInst.setMatrixAt(rain.slot, _rainHideMat);
    }
  }
  _rain.length = 0;
  _activeRainCount = 0;
  if (_rainInst) {
    _rainInst.instanceMatrix.needsUpdate = true;
    _rainInst.visible = false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export function initHelltide(scene, { schedule = true } = {}) {
  _scene = scene;
  for (const ev of _subevents) _disposeSubeventVisual(ev);
  _tracked.clear();
  _activeScratch.clear();
  _subevents.length = 0;
  _clearEmberPool();
  _clearRainPool();
  _rainSpawnAcc = 0;
  _ensureEmberInst();
  _ensureRainInst();
  _ensureGiftPrompt();
  _hideGiftPrompt();
  if (!schedule) {
    state.run.helltideNextAt = 0;
    return;
  }
  // Schedule first trigger.
  // Iter 18 — Hellfire Brazier interactable in town can set a localStorage
  // flag to "queue" a Helltide for the next run. We consume it here so the
  // first trigger fires ~30s into the run instead of the normal 4-6 min auto
  // window. Try/catch around localStorage so SSR / iframe edge cases don't
  // crash init. Clearing the flag once consumed makes the queue single-shot.
  const now = overworldTime();
  let queued = false;
  try {
    queued = (localStorage.getItem('kk_helltide_queued') === 'true');
    if (queued) localStorage.removeItem('kk_helltide_queued');
  } catch (_) {}
  if (queued) {
    state.run.helltideNextAt = now + 30;   // ~30s into the run
  } else {
    state.run.helltideNextAt = now + HELLTIDE_FIRST_AT_MIN +
      Math.random() * (HELLTIDE_FIRST_AT_MAX - HELLTIDE_FIRST_AT_MIN);
  }
}

/** Force-trigger from debug / brazier interactable. */
export function triggerHelltide() {
  if (state.run.helltideActive) return false;
  if (!_scene) return false;
  const now = overworldTime();
  state.run.helltideActive = true;
  state.run.helltideEndAt = now + HELLTIDE_DURATION;
  state.run.helltideSpawnMul = SPAWN_MUL_DURING;
  state.run.helltideEliteBonus = 0.15;
  // Per-event earned counter — resets on every Helltide trigger so multi-event
  // runs credit only the delta. helltideEmbersBanked is the SPENDABLE balance
  // (decremented at chests); helltideEmbersEarnedThisEvent is the LIFETIME-
  // credit input (never decremented, resets here). Codex flagged the prior
  // single-counter design as double-counting across repeated events.
  state.run.helltideEmbersEarnedThisEvent = 0;
  // Apply visual overlay (env.js lerps over ~1.5s)
  if (state.envGroup && typeof state.envGroup.userData.applyHelltideOverlay === 'function') {
    state.envGroup.userData.applyHelltideOverlay(true, 1.0);
  }
  // Banner + audio cue (real bell will land via SFX agent)
  showBanner('⚠ HELLTIDE ⚠ — 3:00', 3.0, '#ff5a28');
  if (sfx && sfx.bossWarn) sfx.bossWarn();
  // FX: a chromatic + shake hit on activation
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.8);
    state.fx.chromaticPulse = Math.max(state.fx.chromaticPulse || 0, 0.7);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.45);
  }
  // First sub-event fires ~5s in to give the player a beat to read the banner.
  _nextSubeventAt = now + 5;
  return true;
}

export function endHelltide(announce = true) {
  if (!state.run.helltideActive) return;
  state.run.helltideActive = false;
  state.run.helltideEndAt = 0;
  state.run.helltideSpawnMul = 1;
  state.run.helltideEliteBonus = 0;
  _hideGiftPrompt();
  // Reverse overlay
  if (state.envGroup && typeof state.envGroup.userData.applyHelltideOverlay === 'function') {
    state.envGroup.userData.applyHelltideOverlay(false);
  }
  // Despawn unopened Tortured Gift chests immediately; threat-pack enemies
  // keep fighting (they're already in state.enemies.active and the spawn
  // director treats them normally). Altars likewise expire naturally.
  for (const ev of _subevents) _disposeSubeventVisual(ev);
  _subevents.length = 0;
  // Clear unclaimed embers (lost-on-ground)
  _clearEmberPool();
  // Lifetime stat updates — credit the per-event EARNED counter, NOT the
  // spendable balance. Codex flagged a double-count bug where multi-event
  // runs credited the cumulative balance every time + spending at chests
  // made totals depend on spending timing instead of pickups.
  const earned = state.run.helltideEmbersEarnedThisEvent || 0;
  const banked = state.run.helltideEmbersBanked || 0;
  state.run.helltideMaxBanked = Math.max(state.run.helltideMaxBanked || 0, earned);
  try {
    if (earned > 0) bumpLifetime('helltideEmbersTotal', earned);
    const meta = getMeta();
    if (!meta.lifetime) meta.lifetime = {};
    const prevMax = meta.lifetime.helltideMaxBanked || 0;
    if (earned > prevMax) {
      meta.lifetime.helltideMaxBanked = earned;
      saveMeta();
    }
  } catch (_) {}
  if (announce) {
    showBanner('HELLTIDE ENDED — BANKED ' + banked + ' ⚜', 3.0, '#ff8a5a');
  }
  // Hide the countdown bar
  try { hideHelltideBar(); } catch (_) {}
  // Schedule next trigger (auto)
  const now = overworldTime();
  const cooldown = HELLTIDE_INTERVAL_MIN +
    Math.random() * (HELLTIDE_INTERVAL_MAX - HELLTIDE_INTERVAL_MIN);
  state.run.helltideNextAt = now + Math.max(HELLTIDE_COOLDOWN_MIN, cooldown);
}

export function isHelltideActive() { return !!state.run.helltideActive; }

export function hasHelltideActivity() {
  return isHelltideActive()
    || _subevents.length > 0
    || _activeEmberCount > 0
    || _activeRainCount > 0;
}

/** Hide transient proximity UI while another modal/death state owns the frame. */
export function syncHelltidePromptVisibility(gameplayVisible) {
  if (!gameplayVisible) _hideGiftPrompt();
}

/** Called every frame from src/miniEvents.js tickMiniEvents. */
export function tickHelltide(dt) {
  if (!_scene) return;
  const t = overworldTime();

  // Auto-trigger window
  if (!state.run.helltideActive) {
    if (state.run.helltideNextAt && t >= state.run.helltideNextAt) {
      triggerHelltide();
    }
    // Always tick the visual pools (rain may have lingering particles)
    _tickRain(dt);
    _tickEmbers(dt);
    _hideGiftPrompt();
    return;
  }

  // End-of-event timer
  if (t >= state.run.helltideEndAt) {
    endHelltide();
    return;
  }

  // Sub-events schedule
  if (t >= _nextSubeventAt && _subevents.length < SUBEVENT_MAX_CONCURRENT) {
    _spawnRandomSubevent();
    _nextSubeventAt = t + SUBEVENT_INTERVAL_MIN +
      Math.random() * (SUBEVENT_INTERVAL_MAX - SUBEVENT_INTERVAL_MIN);
  }

  // Tick each sub-event
  _giftPromptWanted = false;
  _giftPromptWantedText = '';
  for (let i = _subevents.length - 1; i >= 0; i--) {
    const ev = _subevents[i];
    if (ev.kind === 'chest')  _tickChest(ev, dt, t, i);
    else if (ev.kind === 'altar') _tickAltar(ev, dt, t, i);
    else if (ev.kind === 'threat') _tickThreat(ev, dt, t, i);
    else if (ev.kind === 'surge')  _tickSurge(ev, dt, t, i);
  }
  _flushGiftPrompt();

  // Kill-detection (poll-and-diff) + ember drops
  _tickKillDetection();

  // Visual: hellfire ember rain
  _tickRain(dt);
  _spawnRainAround(dt);

  // Pickups + visual pulse
  _tickEmbers(dt);

  // Countdown UI
  try {
    const remaining = Math.max(0, state.run.helltideEndAt - t);
    showHelltideBar(remaining, HELLTIDE_DURATION, state.run.helltideEmbersBanked || 0);
  } catch (_) {}
}

/** Returns count of currently active sub-events (for HUD / debug). */
export function helltideSubeventCount() { return _subevents.length; }

// ── Sub-event spawners ───────────────────────────────────────────────────────
function _spawnRandomSubevent() {
  // Weighted pick. Surge is rarer (heavier moment).
  const r = Math.random();
  if (r < 0.35) _spawnChest();
  else if (r < 0.65) _spawnThreatPack();
  else if (r < 0.85) _spawnAltar();
  else _spawnSurge();
}

function _spawnChest(forcedPosition = null) {
  // Tortured Gift chest — costs CHEST_COST embers to open. Pulses red.
  const hp = state.hero.pos;
  const ang = Math.random() * Math.PI * 2;
  const r = 10 + Math.random() * 8;
  const x = forcedPosition && Number.isFinite(forcedPosition.x)
    ? forcedPosition.x : hp.x + Math.cos(ang) * r;
  const z = forcedPosition && Number.isFinite(forcedPosition.z)
    ? forcedPosition.z : hp.z + Math.sin(ang) * r;
  const g = new THREE.Group();
  g.name = 'helltide:TorturedGift';
  g.userData.gameplayPurpose = `Spend ${CHEST_COST} Helltide Embers for XP and a chance to heal`;
  g.userData.interactive = true;

  // Authored crimson cat reliquary. SpriteMaterial keeps the isometric render
  // camera-facing while alphaTest + depthWrite give it honest actor occlusion;
  // it no longer becomes a flat red cube layered over the hero.
  const gift = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _getGiftTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    alphaTest: 0.07,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  }));
  gift.name = 'helltide:TorturedGift:art';
  gift.position.y = 1.45;
  gift.scale.set(3.0, 3.0, 1);
  gift.center.set(0.5, 0.47);
  gift.userData.gameplayPurpose = g.userData.gameplayPurpose;
  g.add(gift);

  // Paw rune sits on the floor as the interactable footprint. It is quiet and
  // shaped, rather than a generic ring hovering over the chest.
  const pawRuneTex = fxTex('catacomb_yarn_paw') || _getRuneTex();
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(2.7, 2.7),
    new THREE.MeshBasicMaterial({
      map: pawRuneTex,
      color: 0xff6a35, transparent: true, opacity: 0.56,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    })
  );
  ring.rotation.order = 'YXZ';
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.055;
  ring.layers.enable(BLOOM_LAYER);
  g.add(ring);
  g.position.set(x, 0, z);
  _scene.add(g);
  _subevents.push({
    kind: 'chest', x, z, group: g, ring, gift,
    spawnedAt: overworldTime(), life: CHEST_MAX_LIFETIME,
  });
}

/** Deterministic QA hook for authored-asset and layering regression tests. */
export function _debugSpawnTorturedGift(x, z) {
  if (!_scene) return null;
  _spawnChest({ x, z });
  const ev = _subevents[_subevents.length - 1];
  return ev && ev.kind === 'chest'
    ? { x: ev.x, z: ev.z, name: ev.group?.name || '' }
    : null;
}

/** Deterministic lifecycle hook; returns the newly-owned visual name, if any. */
export function _debugSpawnHelltideSubevent(kind) {
  if (!_scene) return null;
  if (kind === 'chest') return _debugSpawnTorturedGift(state.hero.pos.x + 4, state.hero.pos.z);
  if (kind === 'threat') _spawnThreatPack();
  else if (kind === 'altar') _spawnAltar();
  else if (kind === 'surge') _spawnSurge();
  else return null;
  const ev = _subevents[_subevents.length - 1];
  return {
    kind: ev?.kind || '',
    visualName: ev?.group?.name || ev?.tellRing?.name || '',
    count: _subevents.length,
  };
}

function _spawnThreatPack() {
  // 4-6 elite-class enemies arrayed in a tight cluster with magenta tell ring.
  const hp = state.hero.pos;
  const D = _approxDifficulty();
  const eliteTiers = ENEMY_TIERS.filter(tier => tier.elite && tier.minD <= D + 1);
  const base = (eliteTiers.length > 0)
    ? eliteTiers[Math.floor(Math.random() * eliteTiers.length)]
    : ENEMY_TIERS.filter(tier => !tier.elite && tier.minD <= D).slice(-1)[0] || ENEMY_TIERS[0];
  const tier = {
    ...base,
    hp: base.hp * 1.4,
    spd: (base.spd || 3) * 1.10,    // aggressive seek
    scale: (base.scale || 1) * 1.05,
    elite: true,
  };
  const ang = Math.random() * Math.PI * 2;
  const r = 11 + Math.random() * 5;
  const cx = hp.x + Math.cos(ang) * r;
  const cz = hp.z + Math.sin(ang) * r;
  const tellRing = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 5.6),
    new THREE.MeshBasicMaterial({
      map: _getRuneTex(),
      color: 0xff44ff, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  tellRing.name = 'helltide:ThreatTell';
  tellRing.userData.gameplayPurpose = 'Marks the arrival zone for a Helltide elite pack';
  tellRing.rotation.order = 'YXZ';
  tellRing.rotation.x = -Math.PI / 2;
  tellRing.position.set(cx, 0.05, cz);
  tellRing.layers.enable(BLOOM_LAYER);
  _scene.add(tellRing);
  const count = THREAT_PACK_MIN + Math.floor(Math.random() * (THREAT_PACK_MAX - THREAT_PACK_MIN + 1));
  const members = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
    const rr = 1.2 + Math.random() * 0.8;
    const ex = cx + Math.cos(a) * rr;
    const ez = cz + Math.sin(a) * rr;
    const e = spawnEnemy(tier, ex, ez);
    if (e) {
      e._helltideThreat = true;
      // Magenta tint
      if (e.mesh && e.mesh.userData && e.mesh.userData.flashMats) {
        for (const fm of e.mesh.userData.flashMats) {
          if (fm.mat && fm.mat.emissive) {
            fm.mat.emissive.setHex(0xff44ff);
            fm.mat.emissiveIntensity = 0.55;
            fm.origEmissive = 0xff44ff;
            fm.origIntensity = 0.55;
          }
        }
      }
      members.push(e);
    }
  }
  _subevents.push({
    kind: 'threat', cx, cz, tellRing, members,
    spawnedAt: overworldTime(), life: 25,   // tell-ring sticks for 25s then fades
  });
}

function _spawnAltar() {
  // Hellfire Altar — rune disc with timer; kills near it drop 2× embers.
  const hp = state.hero.pos;
  const ang = Math.random() * Math.PI * 2;
  const r = 9 + Math.random() * 7;
  const x = hp.x + Math.cos(ang) * r;
  const z = hp.z + Math.sin(ang) * r;
  const g = new THREE.Group();
  g.name = 'helltide:EmberAltar';
  g.userData.gameplayPurpose = 'Kills inside the rune award double Helltide Embers';
  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(ALTAR_RADIUS * 2, ALTAR_RADIUS * 2),
    new THREE.MeshBasicMaterial({
      map: _getRuneTex(),
      color: 0xff8a3a, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  disc.rotation.order = 'YXZ';
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  disc.layers.enable(BLOOM_LAYER);
  g.add(disc);
  // Tiny pillar of light at the center
  const pillar = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 4.0),
    new THREE.MeshBasicMaterial({
      map: tex('glowRed') || tex('emberWarm'),
      color: 0xff5a28, transparent: true, opacity: 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  pillar.position.y = 2.0;
  pillar.layers.enable(BLOOM_LAYER);
  g.add(pillar);
  g.position.set(x, 0, z);
  _scene.add(g);
  _subevents.push({
    kind: 'altar', x, z, group: g, disc, pillar,
    spawnedAt: overworldTime(), life: ALTAR_DURATION,
  });
}

function _spawnSurge() {
  // Mini-Boss-class surge — single big elite. We intentionally DON'T set
  // isMiniBoss=true because src/enemies.js killEnemy treats that flag as a
  // real mini-boss (guaranteed chest, hearts/star/bomb, miniBoss quest
  // event, sigil grant). That would inflate quest counters and stack
  // duplicate rewards on top of the surge's 30-ember drop. Helltide surges
  // read as boss-class to the ember-roll path (which checks isMiniBoss),
  // so we apply that flag locally via the enemy ref AFTER spawn — the
  // tracker reads it for ember count, but the kill-time reward path
  // already ran from the tier we hand to spawnEnemy.
  const hp = state.hero.pos;
  const D = _approxDifficulty();
  const elites = ENEMY_TIERS.filter(tier => tier.elite && tier.minD <= D + 1);
  if (elites.length === 0) {
    _spawnThreatPack();   // fallback
    return;
  }
  const base = elites[Math.floor(Math.random() * elites.length)];
  const tier = {
    ...base,
    hp: base.hp * SURGE_HP_MUL,                       // 1.5× elite HP
    scale: (base.scale || 1) * 1.20,                  // visibly bigger silhouette
    elite: true,
  };
  const ang = Math.random() * Math.PI * 2;
  const r = 14 + Math.random() * 4;
  const x = hp.x + Math.cos(ang) * r;
  const z = hp.z + Math.sin(ang) * r;
  const e = spawnEnemy(tier, x, z);
  if (e) {
    e._helltideSurge = true;
  }
  showBanner('SURGE — HELLBORN', 1.8, '#ff8a4a');
  if (sfx && sfx.bossWarn) sfx.bossWarn();
  if (state.fx) {
    state.fx.shake = Math.max(state.fx.shake || 0, 0.4);
    state.fx.chromaticPulse = Math.max(state.fx.chromaticPulse || 0, 0.6);
  }
  _subevents.push({
    kind: 'surge', x, z, enemy: e,
    spawnedAt: overworldTime(), life: 90,    // sub-event entry expires off its own kill or 90s
  });
}

// ── Sub-event tickers ────────────────────────────────────────────────────────
function _tickChest(ev, dt, t, idx) {
  // Slow paw-rune rotation + a tiny chest breathing motion. Keep the group
  // grounded so the interaction footprint never floats with the artwork.
  if (ev.ring) {
    ev.ring.rotation.y += dt * 0.55;
    ev.ring.material.opacity = 0.46 + Math.sin((t - ev.spawnedAt) * 2.4) * 0.10;
  }
  if (ev.gift) {
    ev.gift.position.y = 1.45 + Math.sin((t - ev.spawnedAt) * 2.1) * 0.05;
    const pulse = 3.0 + Math.sin((t - ev.spawnedAt) * 2.1) * 0.035;
    ev.gift.scale.set(pulse, pulse, 1);
  }
  // Hero proximity → unlock if the player has enough embers.
  const dx = state.hero.pos.x - ev.x;
  const dz = state.hero.pos.z - ev.z;
  const d2 = dx * dx + dz * dz;
  if (d2 <= 4.0 * 4.0) {
    const banked = state.run.helltideEmbersBanked || 0;
    _giftPromptWanted = true;
    _giftPromptWantedText = banked >= CHEST_COST
      ? `TORTURED GIFT · ${CHEST_COST} ⚜ · STEP CLOSER TO OPEN`
      : `TORTURED GIFT · NEED ${CHEST_COST - banked} MORE ⚜`;
  }
  if (d2 <= CHEST_PICKUP_R2) {
    const banked = state.run.helltideEmbersBanked || 0;
    if (banked >= CHEST_COST) {
      state.run.helltideEmbersBanked = banked - CHEST_COST;
      // Reward: 1-2 gems + a small spark burst. We drop XP gems (value 5)
      // so the player gets the magnetism + level-up benefit.
      import('./xp.js').then(({ dropGem }) => {
        const drops = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < drops; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = 0.5 + Math.random() * 0.5;
          const p = new THREE.Vector3(ev.x + Math.cos(a) * rr, 0.4, ev.z + Math.sin(a) * rr);
          dropGem(p, 5);
        }
      });
      // 25% chance: spawn a heart on top for HP.
      if (Math.random() < 0.25) {
        import('./pickups.js').then(({ spawnHeart }) => spawnHeart(ev.x, ev.z));
      }
      spawnKillRing(ev.x, ev.z, true);
      for (let s = 0; s < 14; s++) {
        const a = (s / 14) * Math.PI * 2;
        spawnMagnetSpark(ev.x + Math.cos(a) * 0.8, 0.6, ev.z + Math.sin(a) * 0.8, 0xff5a28);
      }
      showBanner('+⚜ TORTURED GIFT', 1.8, '#ff8a4a');
      if (state.fx) {
        state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.6);
        state.fx.shake = Math.max(state.fx.shake || 0, 0.3);
      }
      if (sfx && sfx.chestOpen) sfx.chestOpen();
      _giftPromptWanted = false;
      _giftPromptWantedText = '';
      _disposeSubeventVisual(ev);
      _subevents.splice(idx, 1);
    }
    // Insufficient: silent (player will figure it out via the cost icon)
  }
}

function _tickAltar(ev, dt, t, idx) {
  const age = t - ev.spawnedAt;
  if (age >= ev.life) {
    _disposeSubeventVisual(ev);
    _subevents.splice(idx, 1);
    return;
  }
  // Pulse + spin
  if (ev.disc) {
    ev.disc.rotation.y += dt * 0.8;
    ev.disc.material.opacity = 0.55 + 0.35 * Math.abs(Math.sin(t * 3.0));
  }
  if (ev.pillar) {
    ev.pillar.lookAt(state.camera ? state.camera.position : _pillarCamFallback);
    ev.pillar.material.opacity = 0.55 + 0.30 * Math.abs(Math.sin(t * 4.5));
  }
}

function _tickThreat(ev, dt, t, idx) {
  const age = t - ev.spawnedAt;
  // Fade the tell ring after 5s of life — pack now reads as ambient elites.
  if (ev.tellRing) {
    const k = Math.min(1, age / 5);
    ev.tellRing.material.opacity = 0.9 * (1 - k * 0.9);
    ev.tellRing.rotation.y += dt * 1.2;
  }
  // Cleanup when ring fully faded
  if (age >= ev.life) {
    _disposeSubeventVisual(ev);
    _subevents.splice(idx, 1);
  }
}

function _tickSurge(ev, dt, t, idx) {
  const age = t - ev.spawnedAt;
  // Pop the entry when the mini-boss is dead — guaranteed ember drop.
  if (ev.enemy && !ev.enemy.alive) {
    const x = ev.enemy.mesh ? ev.enemy.mesh.position.x : ev.x;
    const z = ev.enemy.mesh ? ev.enemy.mesh.position.z : ev.z;
    for (let i = 0; i < SURGE_EMBER_DROP; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = 0.5 + Math.random() * 1.4;
      _spawnEmber(x + Math.cos(a) * rr, z + Math.sin(a) * rr, 1);
    }
    _subevents.splice(idx, 1);
    return;
  }
  if (age >= ev.life) {
    _subevents.splice(idx, 1);
  }
}

// ── Kill-detection (track-and-diff) ──────────────────────────────────────────
// Two-pass detector that survives same-tick splice:
//   Pass 1: walk state.enemies.active. For each enemy:
//     - newly-seen → pre-roll ember count, insert into _tracked with
//       current mesh position.
//     - seen → refresh x/z to current mesh position (so we drop embers at
//       the death position, not the spawn position).
//     - mark in _activeScratch so we can diff after.
//   Pass 2: walk _tracked. Any entry NOT in _activeScratch has been
//     removed from active[] (= dead OR despawned/escaped). Spawn the
//     pre-rolled embers at the snapshotted x/z, then drop from _tracked.
//
// We treat "removed from active[]" as a successful kill from the player's
// POV: ranged escapes are extremely rare for the elite/mini-boss tiers that
// matter most. False positives on non-kill removals (e.g. treasure-goblin
// escape) are an acceptable trade for not editing enemies.js.
function _tickKillDetection() {
  const arr = state.enemies.active;
  _activeScratch.clear();
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || !e.mesh) continue;
    _activeScratch.add(e);
    let snap = _tracked.get(e);
    if (!snap) {
      // Pre-roll ember count for this enemy
      let p = EMBER_DROP_BASE;
      if (e.elite) p += EMBER_DROP_ELITE_BONUS;
      const bossClass = e.isMiniBoss || e.isFinalBoss || e._helltideSurge;
      if (bossClass) p += EMBER_DROP_BOSS_BONUS;
      let count = 0;
      if (bossClass) count = 1;        // boss-class always >= 1
      if (Math.random() < p) count += 1;
      snap = { count, x: e.mesh.position.x, z: e.mesh.position.z };
      _tracked.set(e, snap);
    } else {
      snap.x = e.mesh.position.x;
      snap.z = e.mesh.position.z;
    }
  }
  // Diff: drop entries that vanished from active[] this tick.
  for (const [e, snap] of _tracked) {
    if (_activeScratch.has(e)) continue;
    // Vanished → spawn pre-rolled embers at last-known position.
    if (snap.count > 0) {
      let mul = 1;
      for (const ev of _subevents) {
        if (ev.kind !== 'altar') continue;
        const ddx = snap.x - ev.x;
        const ddz = snap.z - ev.z;
        if (ddx * ddx + ddz * ddz <= ALTAR_RADIUS * ALTAR_RADIUS) { mul = 2; break; }
      }
      for (let k = 0; k < snap.count * mul; k++) {
        const a = Math.random() * Math.PI * 2;
        const rr = 0.2 + Math.random() * 0.4;
        _spawnEmber(snap.x + Math.cos(a) * rr, snap.z + Math.sin(a) * rr, 1);
      }
    }
    _tracked.delete(e);
  }
}

// ── Ember pool ───────────────────────────────────────────────────────────────
function _ensureEmberInst() {
  if (_emberInst) return;
  const map = tex('emberWarm') || tex('glowRed');
  const mat = new THREE.MeshBasicMaterial({
    map, color: 0xff4a18, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const geo = new THREE.PlaneGeometry(0.55, 0.55);
  _emberInst = new THREE.InstancedMesh(geo, mat, EMBER_CAP);
  _emberInst.visible = false;
  _emberInst.frustumCulled = false;
  _emberInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _emberInst.layers.enable(BLOOM_LAYER);
  _emberHideMat = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < EMBER_CAP; i++) _emberInst.setMatrixAt(i, _emberHideMat);
  _emberInst.instanceMatrix.needsUpdate = true;
  if (_scene) _scene.add(_emberInst);
}

function _spawnEmber(x, z, value) {
  if (!_emberInst) _ensureEmberInst();
  // Find free slot
  let slot = -1;
  for (let i = 0; i < EMBER_CAP; i++) {
    if (!_embers[i] || !_embers[i].alive) { slot = i; break; }
  }
  if (slot === -1) return;
  _embers[slot] = { x, z, age: 0, slot, value: value || 1, alive: true };
  _activeEmberCount += 1;
  _emberInst.visible = true;
}

function _tickEmbers(dt) {
  if (!_emberInst) return;
  const hx = state.hero.pos.x, hz = state.hero.pos.z;
  const t = state.time.real;
  let dirty = false;
  for (let i = 0; i < _embers.length; i++) {
    const em = _embers[i];
    if (!em || !em.alive) continue;
    em.age += dt;
    // Bob + tiny rotation
    const y = 0.35 + Math.sin(t * 5 + i * 0.7) * 0.08;
    const sc = 1.0 + Math.sin(t * 7 + i * 0.5) * 0.10;
    _emberMatrix.makeRotationY(t * 1.2 + i * 0.3);
    _emberMatrix.scale(_emberScale.set(sc, sc, sc));
    _emberMatrix.setPosition(em.x, y, em.z);
    _emberInst.setMatrixAt(em.slot, _emberMatrix);
    dirty = true;
    // Pickup
    const dx = hx - em.x;
    const dz = hz - em.z;
    if (dx * dx + dz * dz <= EMBER_PICKUP_R2) {
      em.alive = false;
      _activeEmberCount = Math.max(0, _activeEmberCount - 1);
      _emberInst.setMatrixAt(em.slot, _emberHideMat);
      const v = em.value || 1;
      state.run.helltideEmbersBanked = (state.run.helltideEmbersBanked || 0) + v;
      // Per-event earned tracker (never decremented by chest spending) — what
      // endHelltide credits to lifetime. See triggerHelltide comment.
      state.run.helltideEmbersEarnedThisEvent = (state.run.helltideEmbersEarnedThisEvent || 0) + v;
      // tiny spark burst for feedback
      spawnMagnetSpark(em.x, 0.6, em.z, 0xff5a28);
      if (sfx && sfx.pickup) sfx.pickup();
      if (_activeEmberCount === 0) _emberInst.visible = false;
    }
  }
  if (dirty) _emberInst.instanceMatrix.needsUpdate = true;
}

// ── Hellfire ember rain (visual) ─────────────────────────────────────────────
function _ensureRainInst() {
  if (_rainInst) return;
  const map = tex('emberWarm');
  const mat = new THREE.MeshBasicMaterial({
    map, color: 0xff7a3a, transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const geo = new THREE.PlaneGeometry(0.35, 0.35);
  _rainInst = new THREE.InstancedMesh(geo, mat, EMBER_RAIN_CAP);
  _rainInst.visible = false;
  _rainInst.frustumCulled = false;
  _rainInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _rainInst.layers.enable(BLOOM_LAYER);
  _rainHideMat = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < EMBER_RAIN_CAP; i++) _rainInst.setMatrixAt(i, _rainHideMat);
  _rainInst.instanceMatrix.needsUpdate = true;
  if (_scene) _scene.add(_rainInst);
}

function _spawnRainAround(dt) {
  if (!state.run.helltideActive) return;
  _rainSpawnAcc += dt * EMBER_RAIN_SPAWN_RATE;
  while (_rainSpawnAcc >= 1) {
    _rainSpawnAcc -= 1;
    // Find free slot
    let slot = -1;
    for (let i = 0; i < EMBER_RAIN_CAP; i++) {
      if (!_rain[i] || !_rain[i].alive) { slot = i; break; }
    }
    if (slot === -1) break;
    const hp = state.hero.pos;
    const ang = Math.random() * Math.PI * 2;
    const rr = 6 + Math.random() * 22;
    const x = hp.x + Math.cos(ang) * rr;
    const z = hp.z + Math.sin(ang) * rr;
    _rain[slot] = {
      x, z, y: 14 + Math.random() * 6,
      vx: (Math.random() - 0.5) * 0.6,
      vy: -(3 + Math.random() * 2),
      vz: (Math.random() - 0.5) * 0.6,
      age: 0, life: 2.0 + Math.random() * 1.2,
      slot, alive: true,
    };
    _activeRainCount += 1;
    _rainInst.visible = true;
  }
}

function _tickRain(dt) {
  if (!_rainInst) return;
  let dirty = false;
  const t = state.time.real;
  for (let i = 0; i < _rain.length; i++) {
    const r = _rain[i];
    if (!r || !r.alive) continue;
    r.age += dt;
    if (r.age >= r.life || r.y <= 0.1) {
      r.alive = false;
      _activeRainCount = Math.max(0, _activeRainCount - 1);
      _rainInst.setMatrixAt(r.slot, _rainHideMat);
      dirty = true;
      continue;
    }
    // Curl noise
    r.vx += Math.sin(t * 1.5 + r.slot * 0.3) * 0.2 * dt;
    r.vz += Math.cos(t * 1.3 + r.slot * 0.4) * 0.2 * dt;
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.z += r.vz * dt;
    // Fade near ground (last 0.5s of life)
    const fade = Math.max(0, Math.min(1, (r.life - r.age) / 0.5));
    const sc = 0.6 + fade * 0.6;
    _rainMatrix.makeScale(sc, sc, sc);
    _rainMatrix.setPosition(r.x, r.y, r.z);
    _rainInst.setMatrixAt(r.slot, _rainMatrix);
    dirty = true;
  }
  if (dirty) _rainInst.instanceMatrix.needsUpdate = true;
  if (_activeRainCount === 0) _rainInst.visible = false;
}

// ── Teardown ─────────────────────────────────────────────────────────────────
export function teardownHelltide() {
  // Hard reset: end overlay, drop everything, hide UI. Called from
  // _teardownActiveRun in main.js so the next run starts clean.
  if (state.run.helltideActive) {
    endHelltide(false);
  } else {
    // Even when inactive, make sure the visual pools + WeakMap reset.
    try { hideHelltideBar(); } catch (_) {}
  }
  for (const ev of _subevents) _disposeSubeventVisual(ev);
  _subevents.length = 0;
  _hideGiftPrompt();
  _clearEmberPool();
  _clearRainPool();
  _tracked.clear();
  _activeScratch.clear();
  state.run.helltideEmbersBanked = 0;
  state.run.helltideMaxBanked = 0;
  // Force the auto-trigger schedule to the first-trigger window (resetState
  // already zeros helltideNextAt; initHelltide will be called again from main).
  state.run.helltideNextAt = 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _approxDifficulty() {
  // Mirror of spawnDirector.computeDifficulty via the SPAWN constants (avoid
  // the import cycle). A hardcoded copy capped at 7 went stale when the curve
  // compressed to 660s and ran helltide intensity permanently soft.
  const t = overworldTime();
  const ramp = SPAWN.difficultyRampSec || 60;
  if (t < ramp) return t / ramp;
  const span = (SPAWN.difficultyMaxSec || 660) - ramp;
  return Math.min(SPAWN.difficultyMax || 10,
    1 + (t - ramp) * ((SPAWN.difficultyMax - 1) / span));
}
