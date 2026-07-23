/**
 * Bullet-hell mode orchestrator. Self-contained state.mode === 'bullethell'
 * branch: arena, scripted wave loop, boss waves, item phase, mode HUD,
 * hitbox dot. Reuses hero movement / dash / damage and the renderer; owns
 * everything else. Mirrors the enterCatacomb/exitCatacomb shape (park
 * overworld, restore on exit).
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { showBanner } from '../ui.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { tex } from '../particleTextures.js';
import { sfx, setMusicTier } from '../audio.js';
import { gamepadState } from '../gamepad.js';
import { consumeActiveCast } from '../input.js';
import { getMeta, saveMeta } from '../meta.js';
import { playCutscene } from '../cutscene.js';
import { bh, resetBh, ARENA_CX, ARENA_CZ, ARENA_R } from './bhState.js';
import {
  initBullets, updateBullets, clearAllBullets, fadeAllBullets, triggerBomb,
  awardGraze, disposeBullets,
} from './bullets.js';
import { initShots, updateShots, disposeShots } from './shots.js';
import { initFoes, updateFoes, spawnFoe, foesAlive, clearAllFoes, disposeFoes, preloadBossSprite, _debugFoes } from './foes.js';
import { spawnItemPedestal, spawnItemChoiceArc, updateItemPedestal, disposeItems } from './items.js';
import { notifyBh, disposeBhAnnouncer } from './announcer.js';

let _arena = null;         // group: floor disc + boundary ring
let _boundaryRing = null;  // outer ring — shifts red while a boss is up
let _bossRingOn = false;
let _savedBg = null, _savedFog = null;   // overworld sky/fog, restored on exit
let _savedSceneActive = false;           // originals may both legitimately be null
let _savedEnvState = null;               // exact visibility/position restored on exit
let _savedResolutionScale = null;        // remote-mode pixel cap, restored on exit
let _resolutionScaleApplied = false;
let _spaceBgTex = null;    // cached deep-space background (built once, reused)
let _hitboxDot = null;     // the one non-negotiable bullet-hell UI element
let _grazeRing = null;     // thin ring at the graze radius — makes near-miss zone legible
let _grazePulse = 0;       // accumulator for the graze-ring opacity pulse
let _motes = null;         // drifting dust field (parallax depth)
let _heroGlow = null;      // soft ground glow under the hero (presence)
// Live-themeable material refs — swapped/retinted by _applyLevelTheme so a biome
// change re-skins the standing arena without a rebuild.
let _floorMat = null, _backdropMat = null, _haloMat = null;

// The post stack owns 15 render targets. At 4K/high-DPR, leaving them uncapped
// can exhaust integrated-GPU memory and stop canvas presentation while DOM
// damage numbers keep updating. Preserve native resolution up through 1080p;
// only oversized buffers are reduced, proportionally and backend-neutrally.
const REMOTE_ARENA_MAX_RENDER_PIXELS = 1920 * 1080;

function _capRemoteArenaResolution() {
  const service = state.rendererService;
  if (!service?.setDynamicResolutionScale) return;
  const diagnostics = service.getDiagnostics?.() || {};
  const currentScale = Number(diagnostics.dynamicResolutionScale) || 1;
  const width = Number(diagnostics.resolution?.width) || 0;
  const height = Number(diagnostics.resolution?.height) || 0;
  _savedResolutionScale = currentScale;
  _resolutionScaleApplied = false;
  const pixels = width * height;
  if (!(pixels > REMOTE_ARENA_MAX_RENDER_PIXELS)) return;
  const nextScale = Math.max(
    0.4,
    currentScale * Math.sqrt(REMOTE_ARENA_MAX_RENDER_PIXELS / pixels),
  );
  if (nextScale < currentScale - 0.005) {
    service.setDynamicResolutionScale(nextScale);
    _resolutionScaleApplied = true;
  }
}

function _restoreRemoteArenaResolution() {
  if (_resolutionScaleApplied && state.rendererService?.setDynamicResolutionScale) {
    try { state.rendererService.setDynamicResolutionScale(_savedResolutionScale || 1); } catch (_) {}
  }
  _savedResolutionScale = null;
  _resolutionScaleApplied = false;
}

// Arena textures — cached per filename, reused across entries AND biomes (never
// disposed; small webps). exitBulletHell's material.dispose() leaves these
// shared .map/.emissiveMap textures alone. Keyed by filename so each biome's
// floor/nebula loads at most once, on first use (lazy).
const _texCache = new Map();
function _arenaTex(filename, nebula) {
  let t = _texCache.get(filename);
  if (t) return t;
  const L = new THREE.TextureLoader();
  t = L.load('assets/fx/arena/' + filename);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nebula) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); }
  else { t.anisotropy = 4; }
  _texCache.set(filename, t);
  return t;
}

// ── Themed biomes (levels) ───────────────────────────────────────────────────
// One biome per 5-wave block; waves 21+ stay on the last (endless). Each swaps
// the floor + backdrop textures and retints rim/mote/hero glow live via
// _applyLevelTheme. bossNova/bossNovaColor are read by foes.js off bh.level for
// the boss materialize nova — index.js just keeps bh.level current.
const LEVELS = [
  { name: 'ASTRAL SANCTUM', floor: 'bh_floor.webp',        nebula: 'bh_nebula.webp',        rim: 0xff5e8a, mote: 0xb9a0ff, hero: 0x6ad0ff, boss: 'VELVET QUEEN',   bossNova: 'aoe_void',  bossNovaColor: 0xc79bff },
  { name: 'MOLTEN CORE',    floor: 'bh_floor_molten.webp', nebula: 'bh_nebula_molten.webp', rim: 0xff7a3a, mote: 0xffb060, hero: 0xffd06a, boss: 'CINDER TYRANT',  bossNova: 'aoe_fire',  bossNovaColor: 0xff8a3a },
  { name: 'FROST CATHEDRAL',floor: 'bh_floor_frost.webp',  nebula: 'bh_nebula_frost.webp',  rim: 0x7fd8ff, mote: 0xbfe8ff, hero: 0x9adcff, boss: 'HOARFROST SAINT',bossNova: 'aoe_frost', bossNovaColor: 0x9adcff },
  { name: 'GILDED ABYSS',   floor: 'bh_floor_gold.webp',   nebula: 'bh_nebula_gold.webp',   rim: 0xffcf6a, mote: 0xffe6a0, hero: 0xffd86b, boss: 'THE LONG PURR',  bossNova: 'aoe_holy',  bossNovaColor: 0xffd86b },
];
// Waves 1-5 → level 0, 6-10 → 1, 11-15 → 2, 16-20 → 3, 21+ clamp to last.
function levelForWave(n) { return Math.min(LEVELS.length - 1, Math.floor((n - 1) / 5)); }

// ── Scripted wave table ──────────────────────────────────────────────────────
// Each entry: { spawns: [group], reinforce: [{at, spawns}] } or { boss: name }.
// A group is { type, n, arc?, pair? } — arc = [centerAngle, spread] limits the
// spawn ring segment; pair mirrors the group to the opposite side (crossfire).
// One new archetype/pattern is introduced every 1-2 waves; the 5 Track-B foes
// (splitter/charger/weaver/bomber/warden) enter through the level-2/3 blocks,
// then the remix generator takes over past wave 20. Every 5th wave is a boss.
function s(type, n, arc) { return { type, n, arc }; }
function pair(type, n = 1) { return { type, n, pair: true }; }

// 20 authored waves = 4 biomes × 5, bosses at 5/10/15/20 (the `{boss:true}`
// entries are documentation — the boss is driven by `n % 5 === 0` in _spawnWave).
const WAVES = [
  { spawns: [s('drifter', 3)] },                                    // 1  — learn rings              [ASTRAL SANCTUM]
  { spawns: [s('drifter', 2), s('gunner', 1)] },                    // 2  — aimed fans
  { spawns: [s('drifter', 2), s('sniper', 1), s('gunner', 1)] },    // 3  — snipe telegraphs
  { spawns: [pair('gunner'), s('spinner', 1)],                      // 4  — crossfire + spiral volleys
    reinforce: [{ at: 7, spawns: [s('drifter', 2)] }] },
  { boss: true },                                                   // 5  — VELVET QUEEN
  { spawns: [s('rimcaster', 1), s('drifter', 3), s('sniper', 1)] }, // 6  — edge rain                [MOLTEN CORE]
  { spawns: [s('turret', 1), s('spinner', 2)],                      // 7  — gap rings / reversing spiral
    reinforce: [{ at: 8, spawns: [s('gunner', 2)] }] },
  { spawns: [s('wallmaker', 1), s('drifter', 3), s('gunner', 1)] }, // 8  — bullet walls
  { spawns: [pair('sniper'), pair('gunner'), s('spinner', 2)] },    // 9  — crossfire hell
  { boss: true },                                                   // 10 — CINDER TYRANT
  { spawns: [s('turret', 1), s('rimcaster', 1), s('drifter', 4)] }, // 11 — drifters go double-ring  [FROST CATHEDRAL]
  { spawns: [s('splitter', 2), s('drifter', 2), s('gunner', 1)] },  // 12 — NEW: splitters fracture on death
  { spawns: [s('charger', 1), s('spinner', 2), s('sniper', 1)],     // 13 — NEW: charger telegraphed rush
    reinforce: [{ at: 8, spawns: [s('drifter', 2)] }] },
  { spawns: [s('splitter', 2), s('wallmaker', 1), pair('gunner', 2), s('charger', 1)] }, // 14 — remix pressure
  { boss: true },                                                   // 15 — HOARFROST SAINT
  { spawns: [s('weaver', 2), s('rimcaster', 1), s('drifter', 3)] }, // 16 — NEW: weavers lace the arena [GILDED ABYSS]
  { spawns: [s('bomber', 1), s('gunner', 2), s('splitter', 1)],     // 17 — NEW: bomber delayed blossoms
    reinforce: [{ at: 8, spawns: [s('charger', 1)] }] },
  { spawns: [s('warden', 1), s('charger', 1), s('spinner', 2), s('sniper', 1)] }, // 18 — NEW: warden anchor + rush
  { spawns: [s('weaver', 2), pair('bomber', 1), s('turret', 1), s('splitter', 2)] }, // 19 — full remix hell
  { boss: true },                                                   // 20 — THE LONG PURR
];
const BOSS_NAMES = ['VELVET QUEEN', 'CINDER TYRANT', 'HOARFROST SAINT', 'THE LONG PURR'];
const REMIX_POOL = ['drifter', 'spinner', 'gunner', 'sniper', 'rimcaster', 'wallmaker', 'turret',
  'splitter', 'charger', 'weaver', 'bomber', 'warden'];
const HEAVIES = { turret: true, wallmaker: true, rimcaster: true, warden: true, bomber: true };

let _reinforce = [];       // live reinforcement schedule for the current wave

// ── Mode HUD (DOM, owned here — ui.js only hides its survivors elements) ────
let _hudRoot = null;
let _hudWave = null, _hudBombs = null, _hudGrazeFill = null, _hudItems = null;
let _hudBossWrap = null, _hudBossName = null, _hudBossFill = null;
let _hudObjective = null;   // campaign-gate objective ribbon (null campaign = hidden)
let _flashEl = null;
const _hudLast = { wave: -1, bombs: -1, items: -1, bossOn: false, objective: '' };

// ── Bomb input (Space / gamepad B) ──────────────────────────────────────────
let _bombKeyQueued = false;
let _bombKeyHandler = null;

// Perfect-dodge listener: hero.js arms state.run.perfectDodgeUntil on a
// dash-through-projectile — we WATCH it (never edit hero.js) and pay the
// same graze reward stream.
let _lastPdUntil = 0;

// Deep-space background — a radial nebula glow (violet core → near-black edge)
// speckled with stars, baked once into a CanvasTexture and reused. Set as
// scene.background during bullet-hell so the arena floats in space instead of
// the overworld's flat black fog void. Cheap: one 1024² canvas, no per-frame cost.
function _spaceBg() {
  if (_spaceBgTex) return _spaceBgTex;
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // Base radial glow: warm violet core fading to deep space blue-black.
  const rg = g.createRadialGradient(S * 0.5, S * 0.46, S * 0.05, S * 0.5, S * 0.5, S * 0.62);
  rg.addColorStop(0, '#2b1c52');
  rg.addColorStop(0.42, '#160f30');
  rg.addColorStop(1, '#05030e');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  // A couple of soft nebula smudges for depth (additive-ish, low alpha).
  const smudge = (x, y, r, col) => {
    const sg = g.createRadialGradient(x, y, 0, x, y, r);
    sg.addColorStop(0, col); sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  g.globalCompositeOperation = 'lighter';
  smudge(S * 0.30, S * 0.34, S * 0.30, 'rgba(120,70,190,0.22)');
  smudge(S * 0.72, S * 0.64, S * 0.28, 'rgba(60,90,200,0.18)');
  smudge(S * 0.62, S * 0.24, S * 0.18, 'rgba(200,90,150,0.16)');
  // Starfield — three brightness tiers.
  for (let i = 0; i < 620; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const t = Math.random();
    const rad = t > 0.97 ? 2.2 : t > 0.85 ? 1.4 : 0.8;
    const a = t > 0.97 ? 0.95 : t > 0.85 ? 0.7 : 0.4;
    g.fillStyle = `rgba(${220 + Math.random() * 35 | 0}, ${225 + Math.random() * 30 | 0}, 255, ${a})`;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  _spaceBgTex = new THREE.CanvasTexture(c);
  _spaceBgTex.colorSpace = THREE.SRGBColorSpace;
  return _spaceBgTex;
}

function _buildArena(scene) {
  _arena = new THREE.Group();
  _arena.userData.kkBulletHell = true;
  // Build at the biome for the CURRENT wave — fresh entry is wave 0 (→ level 0),
  // but the `|| 1` keeps levelForWave(0) from underflowing to LEVELS[-1].
  const level = LEVELS[levelForWave(bh.wave || 1)];
  const floorTex = _arenaTex(level.floor, false);
  const nebulaTex = _arenaTex(level.nebula, true);

  // Cosmic backdrop — a large unlit nebula plane under everything so the arena
  // floats in space instead of a black void. depthWrite off so it never fights
  // the floor/bullets above it. The .map is swapped per biome by _applyLevelTheme.
  _backdropMat = new THREE.MeshBasicMaterial({ map: nebulaTex, depthWrite: false, color: 0x8a8ab0 });
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_R * 6, ARENA_R * 6),
    _backdropMat,
  );
  backdrop.rotation.x = -Math.PI / 2;
  backdrop.position.y = -1.2;
  backdrop.renderOrder = -2;
  _arena.add(backdrop);

  // Floor — glowing rune-mandala. emissiveMap makes the sigils self-lit so they
  // read even where the key light doesn't reach; both maps swap per biome (the
  // emissive glow is what carries the biome color, so the fixed diffuse tint stays).
  _floorMat = new THREE.MeshStandardMaterial({
    map: floorTex, emissiveMap: floorTex, emissive: 0xffffff, emissiveIntensity: 0.32,
    color: 0x39304f, roughness: 0.82, metalness: 0.12,
  });
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_R, 96),
    _floorMat,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  floor.renderOrder = -1;
  _arena.add(floor);

  // A soft rim halo just outside the disc — separates arena from void; tinted to
  // the biome rim color (retinted live by _applyLevelTheme).
  _haloMat = new THREE.MeshBasicMaterial({ color: level.rim, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(ARENA_R - 0.35, ARENA_R + 1.45, 96),
    _haloMat,
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.05;
  halo.layers.enable(BLOOM_LAYER);
  _arena.add(halo);

  // Concentric guide rings — dodge-read reference lines, not decoration. The
  // outer boundary ring carries the biome rim color (and flips red under a boss).
  for (const r of [8, 16, ARENA_R]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r - 0.08, r + 0.08, 96),
      new THREE.MeshBasicMaterial({ color: r === ARENA_R ? level.rim : 0x6a5a94, transparent: true, opacity: r === ARENA_R ? 0.8 : 0.35, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    if (r === ARENA_R) { ring.layers.enable(BLOOM_LAYER); _boundaryRing = ring; }
    _arena.add(ring);
  }

  // Drifting dust motes — an InstancedMesh spun slowly for parallax depth.
  _motes = _buildMotes(level.mote);
  _arena.add(_motes);

  const light = new THREE.AmbientLight(0x9090b0, 1.05);
  _arena.add(light);
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(10, 24, 8);
  _arena.add(key);
  _arena.position.set(ARENA_CX, 0, ARENA_CZ);
  scene.add(_arena);

  // Soft ground glow that follows the hero — gives the player presence beyond
  // the tiny hitbox dot. Repositioned each tick; retinted per biome.
  _heroGlow = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 32),
    new THREE.MeshBasicMaterial({ color: level.hero, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  _heroGlow.userData.kkBulletHell = true;
  _heroGlow.rotation.x = -Math.PI / 2;
  _heroGlow.layers.enable(BLOOM_LAYER);
  scene.add(_heroGlow);

  // Graze ring — a thin cyan band at the graze radius (bh.stats.grazeR) so the
  // near-miss reward zone is VISIBLE (was invisible) and visibly grows when the
  // Graze Halo item is picked (+35% radius). Unit-radius geometry (outer edge =
  // 1.0); position + scale updated each tick. Cyan matches the HUD graze meter.
  _grazeRing = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.0, 48),
    new THREE.MeshBasicMaterial({ color: 0xaef7ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  _grazeRing.userData.kkBulletHell = true;
  _grazeRing.rotation.x = -Math.PI / 2;
  _grazeRing.layers.enable(BLOOM_LAYER);
  scene.add(_grazeRing);

  _hitboxDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }),
  );
  _hitboxDot.userData.kkBulletHell = true;
  _hitboxDot.renderOrder = 100;
  _hitboxDot.layers.enable(BLOOM_LAYER);
  scene.add(_hitboxDot);
}

// InstancedMesh dust field — ~70 tiny additive quads scattered in a disc above
// the floor. The whole group is rotated slowly in the tick (one cheap update).
function _buildMotes(color) {
  const N = 70;
  const g = new THREE.PlaneGeometry(0.22, 0.22);
  const m = new THREE.MeshBasicMaterial({ map: tex('glowWhite'), color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
  const inst = new THREE.InstancedMesh(g, m, N);
  inst.layers.enable(BLOOM_LAYER);
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const s = new THREE.Vector3();
  const pos = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const a = (i * 2.399963);            // golden-angle scatter
    const rad = Math.sqrt((i + 0.5) / N) * (ARENA_R - 1);
    const sc = 0.5 + ((i * 7) % 10) / 10 * 1.4;
    pos.set(Math.cos(a) * rad, 0.4 + ((i * 13) % 10) / 10 * 3.0, Math.sin(a) * rad);
    s.set(sc, sc, sc);
    mat.compose(pos, q, s);
    inst.setMatrixAt(i, mat);
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

// Re-skin the standing arena to a biome's palette in place — swaps floor +
// backdrop maps and retints the halo / boundary ring / hero glow / motes. Lazy
// texture loads are cached, so repeat/back-and-forth transitions are free.
// Idempotent; a no-op guard if the arena hasn't been built yet.
function _applyLevelTheme(idx) {
  if (!_arena) return;
  const level = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, idx))];
  preloadBossSprite(idx);
  if (_floorMat) {
    const ft = _arenaTex(level.floor, false);
    _floorMat.map = ft;
    _floorMat.emissiveMap = ft;
    _floorMat.needsUpdate = true;
  }
  if (_backdropMat) {
    _backdropMat.map = _arenaTex(level.nebula, true);
    _backdropMat.needsUpdate = true;
  }
  if (_haloMat) _haloMat.color.setHex(level.rim);
  // Don't stomp the red boss ring — the boss-off path restores the biome rim.
  if (_boundaryRing && !_bossRingOn) _boundaryRing.material.color.setHex(level.rim);
  if (_heroGlow) _heroGlow.material.color.setHex(level.hero);
  if (_motes) _motes.material.color.setHex(level.mote);
}

function _buildHud() {
  if (_hudRoot) return;
  _hudRoot = document.createElement('div');
  _hudRoot.id = 'kk-bh-hud';
  _hudRoot.style.cssText = `
    position: fixed; top: max(6px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    pointer-events: none; z-index: 60;
    font-family: 'Courier New', monospace; text-transform: uppercase;`;

  _hudWave = document.createElement('div');
  _hudWave.style.cssText = `font-size: clamp(13px, 1.6vw, 17px); font-weight: 700; letter-spacing: 3px;
    color: #ff5e8a; text-shadow: 0 0 10px #ff5e8a;`;
  _hudWave.textContent = 'WAVE 1';

  // Campaign-gate objective ribbon — sits under the WAVE line inside _hudRoot's
  // flex column (so it inherits the centered/fixed/z60 stage, no body-level
  // bleed). Hidden unless bh.campaign is set (endless mode never shows it).
  _hudObjective = document.createElement('div');
  _hudObjective.style.cssText = `font-size: clamp(9px, 1.05vw, 11px); font-weight: 700; letter-spacing: 1.5px;
    color: #d8a0ff; text-shadow: 0 0 8px rgba(200,123,255,0.75); display: none; text-align: center;`;

  const meterRow = document.createElement('div');
  meterRow.style.cssText = 'display:flex; align-items:center; gap:7px;';
  _hudBombs = document.createElement('div');
  _hudBombs.style.cssText = `font-size: 12px; letter-spacing: 1px; color: #9adcff;
    text-shadow: 0 0 8px #9adcff; min-width: 44px; text-align: right;`;
  const grazeBar = document.createElement('div');
  grazeBar.style.cssText = `width: min(120px, 30vw); height: 5px; border: 1px solid rgba(174,247,255,0.5);
    border-radius: 4px; overflow: hidden; background: rgba(10,20,16,0.6);`;
  _hudGrazeFill = document.createElement('div');
  _hudGrazeFill.style.cssText = `height: 100%; width: 0%;
    background: linear-gradient(90deg, #7fd8ff, #aef7ff); box-shadow: 0 0 8px #aef7ff;`;
  grazeBar.appendChild(_hudGrazeFill);
  const grazeLabel = document.createElement('div');
  grazeLabel.style.cssText = 'font-size: 10px; letter-spacing: 2px; color: rgba(174,247,255,0.75);';
  grazeLabel.textContent = 'GRAZE';
  meterRow.appendChild(_hudBombs);
  meterRow.appendChild(grazeBar);
  meterRow.appendChild(grazeLabel);

  _hudItems = document.createElement('div');
  _hudItems.style.cssText = 'display:flex; gap:6px; min-height: 12px;';

  _hudBossWrap = document.createElement('div');
  _hudBossWrap.style.cssText = `display: none; flex-direction: column; align-items: center;
    gap: 2px; margin-top: 2px; width: min(420px, 66vw);`;
  _hudBossName = document.createElement('div');
  _hudBossName.style.cssText = `font-size: clamp(10px, 1.2vw, 12px); letter-spacing: 3px; color: #ff4a4a;
    text-shadow: 0 0 10px #ff4a4a;`;
  const bossBar = document.createElement('div');
  bossBar.style.cssText = `width: 100%; height: 7px; border: 1px solid rgba(255,74,74,0.7);
    border-radius: 5px; overflow: hidden; background: rgba(20,8,10,0.7);`;
  _hudBossFill = document.createElement('div');
  _hudBossFill.style.cssText = `height: 100%; width: 100%;
    background: linear-gradient(90deg, #ff4a4a, #ff9a6a); box-shadow: 0 0 10px #ff4a4a;`;
  bossBar.appendChild(_hudBossFill);
  _hudBossWrap.appendChild(_hudBossName);
  _hudBossWrap.appendChild(bossBar);

  _hudRoot.appendChild(_hudWave);
  _hudRoot.appendChild(_hudObjective);
  _hudRoot.appendChild(meterRow);
  _hudRoot.appendChild(_hudItems);
  _hudRoot.appendChild(_hudBossWrap);
  document.body.appendChild(_hudRoot);

  // Bomb white-out — the render side of bh.bombFlash (was dead code before).
  _flashEl = document.createElement('div');
  _flashEl.id = 'kk-bh-flash';
  _flashEl.style.cssText = `position: fixed; inset: 0; background: #ffffff;
    opacity: 0; pointer-events: none; z-index: 55;`;
  document.body.appendChild(_flashEl);

  _hudLast.wave = -1; _hudLast.bombs = -1; _hudLast.items = -1; _hudLast.bossOn = false;
  _hudLast.objective = '';
}

function _updateHud() {
  if (!_hudRoot) return;
  if (_hudLast.wave !== bh.wave) {
    _hudWave.textContent = `WAVE ${Math.max(1, bh.wave)}`;
    _hudLast.wave = bh.wave;
  }
  // Campaign objective — progress toward the chapter unlock. Endless entries
  // (bh.campaign null) keep it hidden.
  if (bh.campaign) {
    const max = bh.campaign.maxWave;
    const w = Math.min(Math.max(1, bh.wave), max);
    const label = (bh.campaign.label || 'the gate').toUpperCase();
    const onBoss = bh._lastWaveWasBoss && bh.wave >= max;
    const txt = onBoss ? `BOSS · OPEN ${label}` : `TRIAL ${w}/${max} · ${label}`;
    if (_hudObjective.style.display !== 'block') _hudObjective.style.display = 'block';
    if (_hudLast.objective !== txt) { _hudObjective.textContent = txt; _hudLast.objective = txt; }
  } else if (_hudObjective && _hudObjective.style.display !== 'none') {
    _hudObjective.style.display = 'none';
    _hudLast.objective = '';
  }
  const bombs = bh.stats.bombCharges;
  if (_hudLast.bombs !== bombs) {
    _hudBombs.textContent = bombs > 0 ? '⚡'.repeat(Math.min(6, bombs)) + (bombs > 6 ? `×${bombs}` : '') : '—';
    _hudBombs.title = 'Paw bombs (Space / pad B / touch)';
    _hudLast.bombs = bombs;
  }
  _hudGrazeFill.style.width = (Math.min(1, bh.grazeMeter) * 100).toFixed(1) + '%';
  if (_hudLast.items !== bh.taken.length) {
    _hudItems.innerHTML = '';
    for (const def of bh.taken) {
      const dot = document.createElement('div');
      const col = '#' + def.color.toString(16).padStart(6, '0');
      dot.style.cssText = `width: 10px; height: 10px; border-radius: 3px;
        background: ${col}; box-shadow: 0 0 6px ${col};`;
      dot.title = `${def.name} — ${def.desc}`;
      _hudItems.appendChild(dot);
    }
    _hudLast.items = bh.taken.length;
  }
  const bossOn = !!bh.boss;
  if (bossOn !== _hudLast.bossOn) {
    _hudBossWrap.style.display = bossOn ? 'flex' : 'none';
    _hudLast.bossOn = bossOn;
  }
  if (bossOn) {
    _hudBossName.textContent = bh.bossName;
    _hudBossFill.style.width = (Math.max(0, bh.boss.hp / bh.boss.hpMax) * 100).toFixed(1) + '%';
  }
  _flashEl.style.opacity = bh.bombFlash > 0 ? Math.min(1, (bh.bombFlash / 0.4)) * 0.58 : 0;
}

function _pulseWaveHud() {
  if (!_hudWave || typeof _hudWave.animate !== 'function' || state._optReduceMotion) return;
  _hudWave.animate([
    { transform: 'scale(1)', filter: 'brightness(1)' },
    { transform: 'scale(1.12)', filter: 'brightness(1.8)', offset: 0.35 },
    { transform: 'scale(1)', filter: 'brightness(1)' },
  ], { duration: 420, easing: 'ease-out' });
}

function _disposeHud() {
  if (_hudRoot && _hudRoot.parentNode) _hudRoot.parentNode.removeChild(_hudRoot);
  if (_flashEl && _flashEl.parentNode) _flashEl.parentNode.removeChild(_flashEl);
  _hudRoot = null; _hudWave = null; _hudBombs = null; _hudGrazeFill = null;
  _hudItems = null; _hudBossWrap = null; _hudBossName = null; _hudBossFill = null;
  _hudObjective = null;
  _flashEl = null;
}

// ── Wave spawning ────────────────────────────────────────────────────────────
function _hpScaleFor(n) {
  // GENTLE hp scaling — danger comes from bulletSpeedMul/emitRateMul/bulletDmg,
  // not sponging. Time-to-kill stays snappy all run.
  return 1 + (n - 1) * 0.07;
}

function _pickSpawnPos(type, centerA, spread) {
  const h = state.hero.pos;
  for (let tries = 0; tries < 12; tries++) {
    const a = centerA + (Math.random() - 0.5) * spread;
    const r = type === 'turret' ? 8 + Math.random() * 6
      : (type === 'wallmaker' || type === 'rimcaster') ? ARENA_R - 4 - Math.random() * 2
        : ARENA_R - 4 - Math.random() * 6;
    const x = ARENA_CX + Math.cos(a) * r, z = ARENA_CZ + Math.sin(a) * r;
    // Never telegraph a spawn on top of the hero.
    if (Math.hypot(x - h.x, z - h.z) >= 6) return { x, z };
  }
  const ha = Math.atan2(h.z - ARENA_CZ, h.x - ARENA_CX) + Math.PI;
  return { x: ARENA_CX + Math.cos(ha) * (ARENA_R - 6), z: ARENA_CZ + Math.sin(ha) * (ARENA_R - 6) };
}

function _spawnGroup(g, hpScale) {
  const baseA = g.arc ? g.arc[0] : Math.random() * Math.PI * 2;
  const spread = g.arc ? g.arc[1] : (g.pair ? 0.9 : Math.PI * 2);
  // pair mirrors the group to the opposite rim — opposing crossfire pressure.
  const sides = g.pair ? [0, Math.PI] : [0];
  for (const side of sides) {
    for (let i = 0; i < g.n; i++) {
      const p = _pickSpawnPos(g.type, baseA + side, spread);
      spawnFoe(g.type, p.x, p.z, hpScale);
    }
  }
}

/** Past the authored table: remix 3 archetypes, count creeping toward 12. */
function _remixEntry(n) {
  const over = Math.max(1, n - WAVES.length);
  const total = Math.min(12, 6 + over);
  const types = [...REMIX_POOL].sort(() => Math.random() - 0.5).slice(0, 3);
  const spawns = [];
  let used = 0;
  for (const t of types) {
    const cnt = HEAVIES[t] ? 1 : Math.max(1, Math.floor((total - used) / (types.length - spawns.length)));
    spawns.push(s(t, Math.min(cnt, total - used)));
    used += Math.min(cnt, total - used);
  }
  return { spawns, reinforce: [{ at: 9, spawns: [s('drifter', Math.min(3, 1 + (over >> 1)))] }] };
}

function _spawnWave(n) {
  // DANGER scaling — speed/rate/damage climb; hp barely does.
  bh.mods.bulletSpeedMul = Math.min(1.6, 1 + (n - 1) * 0.04);
  bh.mods.emitRateMul = Math.min(1.5, 1 + (n - 1) * 0.03);
  bh.stats.bulletDmg = 12 + Math.floor((n - 1) / 2);
  bh.waveElapsed = 0;
  _reinforce = [];

  const isBoss = (n % 5 === 0);
  if (isBoss) {
    const bossIdx = Math.floor(n / 5) - 1;
    // Boss identity comes from the current biome (bh.level is already set by the
    // wave-advance transition before we get here); BOSS_NAMES is a bare fallback.
    const lvl = LEVELS[levelForWave(n)];
    const name = (lvl && lvl.boss) || BOSS_NAMES[bossIdx % BOSS_NAMES.length];
    if (sfx && sfx.bossWarn) sfx.bossWarn();
    notifyBh(name, '#ff7272', { major: true, priority: 3, duration: 1.8 });
    // Long spawn telegraph — the rune ring IS the boss intro.
    const a = Math.random() * Math.PI * 2;
    spawnFoe('boss', ARENA_CX + Math.cos(a) * 9, ARENA_CZ + Math.sin(a) * 9,
      1 + bossIdx * 0.6, { telegraph: 1.4, name });
    // Late boss waves get a rim escort so the arena isn't a 1v1 shooting range.
    if (n >= 15) _spawnGroup(s('drifter', 2), _hpScaleFor(n));
    bh._lastWaveWasBoss = true;
  } else {
    const entry = WAVES[n - 1] || _remixEntry(n);
    const hpScale = _hpScaleFor(n);
    for (const g of entry.spawns) _spawnGroup(g, hpScale);
    if (entry.reinforce) {
      for (const r of entry.reinforce) _reinforce.push({ at: r.at, spawns: r.spawns, done: false });
    }
    setMusicTier(1);          // combat tier; boss materialize raises to 2
    _pulseWaveHud();
    bh._lastWaveWasBoss = false;
  }
  bh.bombReady = true;   // Thunder Purr rearms every wave
}

function _onWaveClear(scene) {
  bh._itemSpawnedForWave = bh.wave;
  // WAVE CLEAR JUICE: sting + freeze-frame beat; the leftover field dissolves
  // into graze-able sparks instead of blinking out (fairness preserved — the
  // fading bullets can't hit).
  if (sfx && sfx.victory) sfx.victory();
  if (state.fx.hitStop < 0.22) state.fx.hitStop = 0.22;
  fadeAllBullets(0.8);

  // Campaign gate: final boss down → chapter cleared. Win + unlock, no reward
  // pedestal (the unlock IS the reward). _itemSpawnedForWave was set above so
  // the wave loop won't re-fire; bh.won freezes it entirely.
  if (bh.campaign && bh._lastWaveWasBoss && bh.wave >= bh.campaign.maxWave) {
    _campaignWin(scene);
    return;
  }

  const h = state.hero.pos;
  if (bh._lastWaveWasBoss) {
    // Boss reward: CHOICE of three, arced facing the hero.
    const facing = Math.atan2(h.z - ARENA_CZ, h.x - ARENA_CX);
    spawnItemChoiceArc(scene, ARENA_CX, ARENA_CZ, 3, facing);
    notifyBh('Boss charm · choose one', '#ffd27f', { priority: 1, duration: 1.25 });
  } else {
    // Single pedestal at a safe cell partway between center and hero — never
    // force a march to the exact center.
    const hx = h.x - ARENA_CX, hz = h.z - ARENA_CZ;
    const hd = Math.hypot(hx, hz);
    const a = hd > 0.5 ? Math.atan2(hz, hx) : Math.random() * Math.PI * 2;
    const r = Math.min(ARENA_R - 6, Math.max(5, hd * 0.5));
    spawnItemPedestal(scene, ARENA_CX + Math.cos(a) * r, ARENA_CZ + Math.sin(a) * r);
  }
}

// Campaign gate cleared — the final boss is down. Grant the chapter unlock,
// freeze the wave machine, play a victory beat, then drop to the menu so the
// newly-opened chapter is visible in the select. Called once from _onWaveClear.
function _campaignWin(scene) {
  bh.won = true;
  const camp = bh.campaign;
  bh.campaign = null;
  if (state.run) state.run._bhCampaign = null;   // never re-arm on a later entry
  // Grant the unlock (idempotent) + persist for the chapter select.
  try {
    const m = getMeta();
    if (camp && camp.unlockFlag && !m[camp.unlockFlag]) { m[camp.unlockFlag] = true; saveMeta(); }
  } catch (_) {}
  // Surface the unlock as a banner too — if the cutscene fails to mount (caught
  // below), this is the only on-screen confirmation the gate was cleared.
  try { showBanner(`${((camp && camp.label) || 'A NEW GATE').toUpperCase()} UNLOCKED`, 3.0, '#ffd86b'); } catch (_) {}
  clearAllFoes();
  fadeAllBullets(0.6);
  const label = (camp && camp.label) || 'A new path';
  try {
    playCutscene({
      image: 'assets/screens/victory.webp',
      title: 'THE GATE IS BROKEN',
      accent: '#c87bff',
      lines: [
        'The storm of light stills. The trial is passed, little knight.',
        label + ' lies open before you.',
      ],
      onDone: () => {
        try { if (typeof window !== 'undefined' && window.kkReturnToMenu) window.kkReturnToMenu(); } catch (_) {}
      },
    });
  } catch (_) {
    // Cutscene failed to mount — still bail to the menu so the run can't hang.
    try { if (typeof window !== 'undefined' && window.kkReturnToMenu) window.kkReturnToMenu(); } catch (_) {}
  }
}

// main.js reads this before a death-retry so the bounded gate survives
// _restartBulletHell (which passes it back into enterBulletHell's param).
export function getBhCampaign() { return bh.campaign; }

export function enterBulletHell(scene, campaign = null) {
  resetBh();
  // Campaign gate: a bounded chapter-transition entry (Level 3 → Level 4). null
  // for the endless menu/start-screen mode. resetBh() nulled it above; re-apply
  // from the param so a death-retry (main.js _restartBulletHell passes the saved
  // campaign back) stays bounded.
  bh.campaign = campaign || null;
  if (bh.campaign) {
    try {
      notifyBh(`Trial · clear ${bh.campaign.maxWave} waves · ${(bh.campaign.label || 'gate')}`, '#c87bff',
        { major: true, priority: 3, duration: 2.2 });
    } catch (_) {}
  }
  // Finale carryover — an explore run's build pre-buffs the finale ("your run
  // feeds the payoff"). Computed + stashed by portalShards._enterPortal while
  // the explore build was still intact; consumed once here. A direct/menu entry
  // has no carry (powerScore 0 → untouched), so bullet-hell stays a clean
  // standalone mode.
  try {
    const carry = state.run && state.run._finaleCarry;
    if (carry && carry.powerScore > 0) {
      const ps = carry.powerScore;
      bh.stats.dmg *= 1 + Math.min(0.6, ps * 0.02);        // up to +60% shot dmg
      bh.stats.fireRate *= 1 + Math.min(0.4, ps * 0.012);  // up to +40% fire rate
      bh.stats.bombCharges += Math.min(3, Math.floor(ps / 12));
    }
    if (state.run) state.run._finaleCarry = null;          // consume once
  } catch (_) {}
  state.mode = 'bullethell';
  _capRemoteArenaResolution();
  // Remove the overworld from scene traversal while this remote arena is live.
  // Merely translating it down (the old path) still submitted large ground and
  // stage meshes whose bounding volumes intersected the Bullet Hell frustum.
  // Preserve the exact incoming state because campaign handoffs may enter from
  // another mode that already parked the environment.
  const envGroup = state.envGroup || null;
  const envGround = envGroup?.userData?.ground || null;
  _savedEnvState = envGroup ? {
    group: envGroup,
    visible: envGroup.visible,
    y: envGroup.position.y,
    ground: envGround,
    groundVisible: envGround?.visible,
  } : null;
  if (envGroup) envGroup.visible = false;
  // Swap the overworld sky/fog for a deep-space backdrop so the arena floats in
  // a nebula instead of a flat black void (restored verbatim on exit). Fog is
  // recolored to deep space (not removed) so remote arena geometry fades into
  // the nebula; the arena itself (r=24, close to the camera) stays clear.
  _savedBg = scene.background;
  _savedFog = scene.fog;
  _savedSceneActive = true;
  scene.background = _spaceBg();
  scene.fog = new THREE.Fog(0x0b0718, 52, 150);
  // Snapshot hero fields the mode/items mutate.
  bh._heroSnap = { hp: state.hero.hp, hpMax: state.hero.hpMax };
  state.hero.hp = state.hero.hpMax;
  state.hero.pos.set(ARENA_CX, 0, ARENA_CZ);
  state.hero.vel.set(0, 0, 0);
  _bossRingOn = false;
  _lastPdUntil = (state.run && state.run.perfectDodgeUntil) || 0;
  _buildArena(scene);
  initBullets(scene);
  initShots(scene);
  initFoes(scene);
  _buildHud();
  // Manual bomb: Space (keydown, edge) — pad B is polled in tick.
  _bombKeyQueued = false;
  _bombKeyHandler = (e) => {
    if (e.code === 'Space' && bh.active && !state.gameOver && !state.time.paused) _bombKeyQueued = true;
  };
  window.addEventListener('keydown', _bombKeyHandler);
  // Debug/QA hooks, same pattern as window.kkTriggerHelltide in main.js.
  // __kkBh carries wave / grazeMeter / grazeCount / boss / bossName live.
  if (typeof window !== 'undefined') {
    window.__kkBh = bh;
    window.__kkBhWarp = (x, z) => state.hero.pos.set(ARENA_CX + x, 0, ARENA_CZ + z);
    window.__kkBhFoes = _debugFoes;
    // World → screen px, for QA scripts that need to aim the mouse at a foe.
    window.__kkBhScreen = (x, z) => {
      const v = new THREE.Vector3(x, 1, z).project(state.camera);
      return { sx: (v.x * 0.5 + 0.5) * window.innerWidth, sy: (-v.y * 0.5 + 0.5) * window.innerHeight };
    };
    // Fast-forward: clears the field and queues wave n next (QA boss access).
    window.__kkBhSetWave = (n) => {
      clearAllFoes();
      fadeAllBullets(0.2);
      disposeItems(scene);
      bh.wave = n - 1;
      bh._itemSpawnedForWave = n - 1;
      bh._lastWaveWasBoss = false;
      bh.waveDelay = 0.5;
      // Force-set jumps can cross biomes — apply the theme now so the arena AND
      // the boss nova (foes.js reads bh.level) match the wave about to spawn.
      const nl = levelForWave(n);
      if (nl !== bh.level) { bh.level = nl; _applyLevelTheme(nl); }
    };
    window.__kkBhKillAll = () => { for (const f of _debugFoes()) f.hp = 0; };
  }
  // Endless entries get the generic "how to play" hint. Campaign (gate) entries
  // keep their "TRIAL OF THE …" banner from above — showBanner has no queue, so
  // an unconditional call here would clobber the trial banner before it paints.
  if (!bh.campaign) notifyBh('Bullet Hell · hold fire · dash · graze', '#aef7ff',
    { major: true, priority: 3, duration: 2.0 });
}

export function tickBulletHell(dt, scene) {
  if (!bh.active) return;

  // Keep hero inside the arena (updateHero already moved them this frame).
  const h = state.hero.pos;
  const rx = h.x - ARENA_CX, rz = h.z - ARENA_CZ;
  const d = Math.hypot(rx, rz);
  if (d > ARENA_R - 1) {
    h.x = ARENA_CX + rx * (ARENA_R - 1) / d;
    h.z = ARENA_CZ + rz * (ARENA_R - 1) / d;
  }

  // Manual bomb (Space queued on keydown / pad B edge from the poll).
  if (_bombKeyQueued || consumeActiveCast()
      || (gamepadState.connected && gamepadState.justPressed && gamepadState.justPressed.b)) {
    _bombKeyQueued = false;
    if (!state.gameOver) triggerBomb();
  }

  // Perfect dodge → graze reward stream. hero.js arms perfectDodgeUntil on a
  // dash through a projectile; each NEW arming pays a chunk of graze meter.
  const pd = (state.run && state.run.perfectDodgeUntil) || 0;
  if (pd > _lastPdUntil + 1e-6) {
    _lastPdUntil = pd;
    awardGraze(4, h.x, h.z);
  }

  updateFoes(dt);
  updateBullets(dt);
  updateShots(dt);

  // Hitbox dot rides the hero, scaled to the live hitR so Velvet Hitbox is visible.
  if (_hitboxDot) {
    _hitboxDot.position.set(h.x, 1.0, h.z);
    const s = bh.stats.hitR / 0.34;
    _hitboxDot.scale.setScalar(s);
  }
  // Soft ground glow follows the hero (presence); motes drift for parallax.
  if (_heroGlow) _heroGlow.position.set(h.x, 0.03, h.z);
  // Graze ring rides the hero and scales to the live graze radius (Graze Halo
  // grows it); a gentle opacity pulse reads the zone as an active reward field.
  if (_grazeRing) {
    _grazePulse += dt * 3;
    _grazeRing.position.set(h.x, 0.04, h.z);
    _grazeRing.scale.setScalar(bh.stats.grazeR);
    _grazeRing.material.opacity = 0.16 + 0.10 * (0.5 + 0.5 * Math.sin(_grazePulse));
  }
  if (_motes) _motes.rotation.y += dt * 0.06;
  if (_floorMat) {
    const targetGlow = bh.itemPending ? 0.46 : (bh.boss ? 0.22 : 0.30);
    _floorMat.emissiveIntensity += (targetGlow - _floorMat.emissiveIntensity) * Math.min(1, dt * 4);
  }
  if (bh.bombFlash > 0) bh.bombFlash -= dt;

  // Boss presence shifts the boundary ring red (and back to the biome rim).
  if (_boundaryRing) {
    const bossOn = !!bh.boss;
    if (bossOn !== _bossRingOn) {
      _bossRingOn = bossOn;
      const rim = LEVELS[Math.min(LEVELS.length - 1, bh.level || 0)].rim;
      _boundaryRing.material.color.setHex(bossOn ? 0xff4a4a : rim);
    }
  }

  // Wave loop: foes dead → bullets fade → pedestal(s) → pickup → next wave.
  // Frozen once bh.won (campaign cleared) so no wave 6 spawns under the splash.
  if (!state.gameOver && !bh.won) {
    if (bh.itemPending) {
      if (updateItemPedestal(dt, scene)) bh.waveDelay = 1.2;
    } else if (foesAlive() === 0) {
      if (bh.wave > 0 && bh._itemSpawnedForWave < bh.wave) {
        _onWaveClear(scene);
      } else {
        bh.waveDelay -= dt;
        if (bh.waveDelay <= 0) {
          bh.wave++;
          // Biome transition: crossing into a new 5-wave block re-themes the
          // arena. Set bh.level + apply the theme BEFORE _spawnWave so a boss
          // materialize (foes.js) reads the right nova; defer the biome banner
          // to AFTER _spawnWave so it wins the single banner slot over the
          // per-wave "WAVE n" banner (showBanner shows only the latest).
          const nl = levelForWave(bh.wave);
          const themed = (nl !== bh.level);
          if (themed) { bh.level = nl; _applyLevelTheme(nl); }
          _spawnWave(bh.wave);
          if (themed) {
            const lv = LEVELS[nl];
            notifyBh(lv.name, '#' + lv.rim.toString(16).padStart(6, '0'),
              { major: true, priority: 2, duration: 1.6 });
          }
          bh.waveDelay = 2.0;
        }
      }
    } else {
      // Mid-wave: clock the timed reinforcements.
      bh.waveElapsed += dt;
      for (const r of _reinforce) {
        if (!r.done && bh.waveElapsed >= r.at) {
          r.done = true;
          for (const g of r.spawns) _spawnGroup(g, _hpScaleFor(bh.wave));
        }
      }
    }
  }

  _updateHud();
}

export function exitBulletHell(scene) {
  if (!bh.active) return;
  bh.active = false;
  if (_bombKeyHandler) {
    window.removeEventListener('keydown', _bombKeyHandler);
    _bombKeyHandler = null;
  }
  _bombKeyQueued = false;
  clearAllFoes();
  clearAllBullets();
  disposeFoes(scene);
  disposeBullets(scene);
  disposeShots(scene);
  disposeItems(scene);
  disposeBhAnnouncer();
  _disposeHud();
  if (_arena) {
    scene.remove(_arena);
    _arena.traverse(o => {
      // .map/.emissiveMap are the shared cached biome textures (in _texCache) —
      // NOT disposed here (reused next entry/biome); geometry + material are
      // per-build. All biome webps stay resident across entries by design.
      if (o.isMesh) { o.geometry.dispose(); if (o.material) o.material.dispose(); }
    });
    _arena = null;
    _boundaryRing = null;
    _motes = null;
    _floorMat = null; _backdropMat = null; _haloMat = null;
  }
  if (_heroGlow) {
    scene.remove(_heroGlow);
    _heroGlow.geometry.dispose(); _heroGlow.material.dispose();
    _heroGlow = null;
  }
  if (_grazeRing) {
    scene.remove(_grazeRing);
    _grazeRing.geometry.dispose(); _grazeRing.material.dispose();
    _grazeRing = null;
  }
  if (_hitboxDot) {
    scene.remove(_hitboxDot);
    _hitboxDot.geometry.dispose(); _hitboxDot.material.dispose();
    _hitboxDot = null;
  }
  if (bh._heroSnap) {
    state.hero.hpMax = bh._heroSnap.hpMax;
    state.hero.hp = Math.min(bh._heroSnap.hp, state.hero.hpMax);
    bh._heroSnap = null;
  }
  // Bring the hero back from the remote arena coords before any other mode
  // (menu idle render, town, run) frames them.
  state.hero.pos.set(0, 0, 0);
  state.hero.vel.set(0, 0, 0);
  _restoreRemoteArenaResolution();
  if (_savedEnvState) {
    const saved = _savedEnvState;
    if (saved.group === state.envGroup) {
      saved.group.position.y = saved.y;
      saved.group.visible = saved.visible;
      if (saved.ground && typeof saved.groundVisible === 'boolean') {
        saved.ground.visible = saved.groundVisible;
      }
    }
    _savedEnvState = null;
  }
  // Restore the overworld sky/fog exactly as they were on entry.
  if (_savedSceneActive) {
    scene.background = _savedBg;
    scene.fog = _savedFog;
    _savedBg = null; _savedFog = null;
    _savedSceneActive = false;
  }
  if (typeof window !== 'undefined') {
    delete window.__kkBh;
    delete window.__kkBhWarp;
    delete window.__kkBhFoes;
    delete window.__kkBhScreen;
    delete window.__kkBhSetWave;
    delete window.__kkBhKillAll;
  }
}
