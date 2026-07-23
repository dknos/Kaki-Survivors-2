/**
 * Enemy system: pooled meshes, spatial hash, seek-hero + light separation,
 * contact damage, and a damage interface for weapons.
 *
 * Highest-risk module: must hold 200+ active enemies at 60fps. To that end:
 *  - No `new` calls in hot loops (temp vectors are module-scoped).
 *  - No skeletal animation mixers — meshes are static (faster + zero allocs).
 *  - Proximity via SpatialHash, never raycasting.
 *  - Pools keyed by glb key; prewarm hides first-horde stall.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENEMY_TIERS, POOL_PREWARM, SPATIAL, SPAWN, DAMAGE, NEMESIS_TIER, DASH } from './config.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import {
  applyCreatureVertexAnim,
  applyDamageFlash,
  applyRimLight,
  cloneCached,
  collapseStaticMeshes,
  findClip,
  getClips,
  GLTF_CACHE,
  resetMaterialControllers,
  upgradeMaterials,
} from './assets.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { dropGem } from './xp.js';
import { spawnDamageNumber } from './damageNumbers.js';
import { spawnKillRing } from './fx.js';
import { spawnDissolveBurst } from './fx/dissolveBurst.js';
import { spawnImpactBurst, burstExplosion } from './vfxBurst.js';
import { spawnEnemyProjectile } from './enemyProjectiles.js';
import { spawnChest, spawnChestRaw } from './chest.js';
// FOREST-V2-A6 — VS-style 3-option treasure chest drops, forest stage only.
// Static import to avoid hot-path dynamic import promises (see commit 358dce1
// re: borgir-salvo dynamic-import stall). dropForestChest is a no-op when the
// forest chest module isn't loaded, so non-forest stages pay nothing.
import { dropForestChest } from './forestChests.js';
import { onRoomBossKilled as _forestRoomBossKilled } from './forestSealedDoors.js';
// FOREST-V2-A8 — VS floor pickups (bomb/magnet/chicken), forest stage only.
// Static import to dodge dynamic-import stall on borgir-salvo deaths (matches
// dropForestChest's rationale above). No-op when the module isn't loaded.
import { dropForestPickup } from './forestPickups.js';
import { dropForestWeapon } from './forestWeaponDrops.js';
import { spawnHeart, spawnStar, spawnBomb, spawnFreeze, spawnChicken } from './pickups.js';
import { sfx } from './audio.js';
import { notifyStageEnemySpawn, notifyStageEnemyKill } from './stageRules.js';
import { rollAffixes, applyAffix } from './enemyAffixes.js';
import { setLeapMarker, clearLeapMarker } from './enemyTells.js';
import { disposeBossTelegraphs } from './bossTelegraphs.js';
// Hot-path: kill handlers — converted from dynamic import() to static (commit
// 358dce1 follow-up). Borgir salvo killing 32 enemies/frame was firing 128+
// dynamic-import Promises per frame, stalling next-frame entry → 20fps.
import { notifyEnemyKilled, notifyEnemySeen } from './codex.js';
import { notifyTutorialEvent } from './tutorial.js';
// PHASE 4 P4J (#140) — Telemetry kill/boss event hook. STATIC import to keep
// the kill chokepoint allocation-free (dynamic import() here would fire
// hundreds of microtasks/frame on borgir salvos — see perf-fix 9509535).
import { event as telemetryEvent } from './telemetry.js';
import { questEvent, grantSigils, recordHyperBossKill, rollRelic, addRelic, bumpLifetime } from './meta.js';
import { tryAchievement, trySecret, showBanner } from './ui.js';
// Sprite FX — STATIC import per perf-fix 9509535. NEVER convert to dynamic
// import() here. damageEnemy + killEnemy fire 100+ times/frame on borgir
// salvos; dynamic-import microtasks would crater FPS (see memory
// feedback_kks_dynamic_import_hotpath).
import {
  ENEMY_SPRITE_STATE,
  spawnSprite,
  spawnEnemySprite,
  moveSprite,
  setEnemySpriteMotion,
  setEnemySpriteState,
  triggerEnemySpriteHit,
  playEnemySpriteDeath,
  releaseEnemySprite,
  releaseAllSprites,
  setSpriteFlash,
  hasSpritePool,
} from './sprites/index.js';
// PHASE 1 P1E (2026-05-17) — boss intro cinematic trigger. Static import:
// triggerBossIntro is a cheap no-op when the tier has already fired this run,
// so calling it on every spawn is safe. Roomboss tier is detected by the
// cinematic tick scan (because forestSealedDoors stamps _isRoomBoss AFTER
// spawnEnemy returns), so this site only fires miniboss + elite.
import { triggerBossIntro as _triggerBossIntro } from './bossIntroCinematic.js';
import { recordDps } from './dpsWindow.js';

// ── Module-scope temp vectors (reuse, never `new` in update loops) ────────────
const _tmpDir   = new THREE.Vector3();
const _tmpPush  = new THREE.Vector3();
const _tmpDelta = new THREE.Vector3();
// iter 33n — separation neighbor buffer; cleared+filled each query.
const _sepBuf   = [];

const CONTACT_CD = 0.5;
// DoT tick cadence — poison/bleed accumulate and resolve in chunks at this rate
// instead of every frame, so a floating number renders ~4x/sec (readable) rather
// than 60x/sec (which floods the 48-slot number pool and starves real hits).
const DOT_TICK = 0.25;
const SEPARATION_DIST = 1.0;
const SEPARATION_NEIGHBORS = 3;
const CONTACT_DIST_SQ = 1.0 * 1.0;   // use a friendly 1.0 unit total contact

let _scene = null;
let _loggedSizes = null;
let _loggedClips = null;

// ── Facetank pressure ────────────────────────────────────────────────────────
// A camping hero (no >2u move in the last 4s) lets the primary mow the
// approach lane before contact attackers ever land a hit. While camping,
// seekers gain +25% closing speed. Cost: one hero distance check per frame,
// one boolean read per enemy. Stamps reset in initEnemies (per run).
let _campMoveT = 0;
let _heroCamping = false;
let _campMul = 1.0;

// ── Tier lookup ───────────────────────────────────────────────────────────────
const _tierByGlb = Object.create(null);
for (const t of ENEMY_TIERS) _tierByGlb[t.glb] = t;
const _VERTEX_ANIM_KINDS = new Set(['crawl', 'flap', 'hover', 'inch']);

// ── 2D billboard horde ──────────────────────────────────────────────────────
// Trash mobs whose glb key has a baked anim in the 'enemies' sprite atlas
// (scripts/bake-enemy-sprites + assets/sprites/enemies_v1.json) render as
// camera-facing billboards from ONE InstancedMesh (1 draw call for the whole
// horde) instead of multi-primitive 3D GLBs. Elites/minibosses/bosses keep the
// 3D path (gated in spawnEnemy). Each sprite enemy carries a bare Object3D as
// e.mesh so every existing e.mesh.position read (collision, FX, drops, kill
// rings) keeps working untouched — only the visual layer changes.
// Grows as more enemies are baked; keys must match anim names in the atlas.
const _SPRITE_KEYS = new Set([
  'zombie', 'goblin', 'skeleton', 'orc', 'demon', 'robot', 'mech', 'xeno',
  'slime', 'wizard', 'ghost', 'spider', 'wolf', 'ant', 'beetle', 'ladybug',
  'grasshopper', 'cockroach', 'mantis', 'wasp', 'bee', 'butterfly', 'caterpillar',
]);
const FOREST_ENEMY_ATLAS_ID = 'forest-enemies-v2';
const V1_ENEMY_ATLAS_ID = 'enemies';
const _FOREST_SPRITE_SPECIES = Object.freeze({
  ant: 0,
  beetle: 1,
  ladybug: 2,
  grasshopper: 3,
  cockroach: 4,
  mantis: 5,
  wasp: 6,
  bee: 7,
  butterfly: 8,
  caterpillar: 9,
  spider: 10,
});
const _anchorPool = [];   // reusable empty Object3D anchors for sprite enemies
let _spriteSpawnSeed = 0;
// Hit-flash white-mix strength for billboard (sprite) enemies (CC4). < 1 so the
// silhouette stays legible mid-swarm; the 3D path flashes emissive white (1.6
// intensity) — this is the unlit-sprite analog. Sole blind-tune knob for the
// sprite flash (no cave/forest screenshot gate); nudge here.
const SPRITE_FLASH_STRENGTH = 0.85;
// Sprite billboard world-height = (tier scale) × this. Matches the 3D path's
// baseFit target (line ~319 normalizes every GLB to 2.0u tall before tier scale),
// so a tier renders the same height whether it draws as a GLB or a billboard. The
// spawn path used to pass tier.scale RAW as the absolute sprite height → sprites
// came out ~half size ("tiny mobs"). Tunable: bump if baked-frame padding reads short.
const SPRITE_FIT_HEIGHT = 2.0;
// Minimum billboard world-height. Floors the small insect tiers (bee/roach/
// ladybug, roster scale 0.55-0.70 → 1.1-1.4u raw) so the late waves that unlock
// them don't read as tiny specks. Tiers ≥0.75 (zombie/goblin/orc/wolf/…) clear
// the floor and keep their roster size, preserving the big/small hierarchy.
const SPRITE_MIN_HEIGHT = 1.5;

// Free a dead/retired enemy's visual + recycle its mesh into the right pool.
// Sprite enemies: kill the billboard slot + recycle the bare anchor (must NOT
// land in a GLB pool). GLB enemies: hide + push back to their glb pool.
function _releaseEnemyMesh(e) {
  // Idempotency guard: callers now include the corpse drain, flushCorpses,
  // teardown AND the pool-exhaustion early-release — a double release would
  // push the same mesh into the pool twice and hand it to two live enemies
  // (pool corruption). Each enemy object releases exactly once.
  if (e._meshReleased) return;
  e._meshReleased = true;
  if (e._isSprite) {
    if (e._spriteSlot >= 0) {
      try { releaseEnemySprite(e._spriteAtlasId || V1_ENEMY_ATLAS_ID, e._spriteSlot); } catch (_) {}
      e._spriteSlot = -1;
    }
    if (e.mesh) {
      e.mesh.visible = false;
      if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
      _anchorPool.push(e.mesh);
    }
    return;
  }
  if (e.mesh) {
    e.mesh.userData?.damageFlashController?.setAmount(0);
    e.mesh.userData?.creatureAnimationController?.updateTime(0);
    resetMaterialControllers(e.mesh, { creatureTime: 0, creatureAmplitude: 1 });
  }
  if (e.mesh) e.mesh.visible = false;
  if (e.mesh && e.mesh.userData && e.mesh.userData._isNemesisMesh) {
    if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
  } else if (e.mesh) {
    const _pool = state.enemies.pools[e.glbKey] || (state.enemies.pools[e.glbKey] = []);
    _pool.push(e.mesh);
  }
}

// A killed v2 enemy stops owning gameplay state immediately, but its instance
// remains in the shared atlas pool for the authored 3-frame death (167ms).
// The anchor is position-only and can be recycled at once; the pool slot
// releases itself when the one-shot reaches its configured completion.
function _playSpriteDeathAndRecycleAnchor(e) {
  if (e._meshReleased) return;
  e._meshReleased = true;
  const atlasId = e._spriteAtlasId || V1_ENEMY_ATLAS_ID;
  if (e._spriteSlot >= 0) {
    try {
      moveSprite(atlasId, e._spriteSlot, e.mesh.position.x, 0.06, e.mesh.position.z);
      if (!playEnemySpriteDeath(atlasId, e._spriteSlot)) {
        releaseEnemySprite(atlasId, e._spriteSlot);
      }
    } catch (_) {
      try { releaseEnemySprite(atlasId, e._spriteSlot); } catch (_) {}
    }
    e._spriteSlot = -1;
  }
  if (e.mesh) {
    e.mesh.visible = false;
    if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
    _anchorPool.push(e.mesh);
  }
}

function _syncEnemySprite(e, fromX, fromZ, dt) {
  if (!e._isSprite || e._spriteSlot < 0) return;
  const atlasId = e._spriteAtlasId || V1_ENEMY_ATLAS_ID;
  const ep = e.mesh.position;
  moveSprite(atlasId, e._spriteSlot, ep.x, 0.06, ep.z);
  if (!e._spriteV2) return;
  const dx = ep.x - fromX;
  const dz = ep.z - fromZ;
  if (dt > 0) {
    const invDt = 1 / dt;
    setEnemySpriteMotion(atlasId, e._spriteSlot, dx * invDt, dz * invDt, Math.hypot(dx, dz) * invDt);
  } else {
    setEnemySpriteMotion(atlasId, e._spriteSlot, 0, 0, 0);
  }
}

/** Run-teardown seam that preserves sprite-vs-GLB pool ownership. */
export function releaseEnemyVisual(enemy) {
  _releaseEnemyMesh(enemy);
}

// Difficulty curve — mirrors spawnDirector.computeDifficulty (not exported there).
// Kept in sync intentionally: this drives rollAffixes() at spawn time.
function _computeDifficulty(t) {
  if (t <= 0) return 0;
  if (t < SPAWN.difficultyRampSec) return t / SPAWN.difficultyRampSec;
  if (t < SPAWN.difficultyMaxSec) {
    const span = SPAWN.difficultyMaxSec - SPAWN.difficultyRampSec;
    const k = (t - SPAWN.difficultyRampSec) / span;
    return 1 + k * (SPAWN.difficultyMax - 1);
  }
  return SPAWN.difficultyMax;
}

// ─────────────────────────────────────────────────────────────────────────────
// SpatialHash
// ─────────────────────────────────────────────────────────────────────────────
class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    /** @type {Map<number, any[]>} */
    this.cells = new Map();
  }

  // Pack 2D coordinates into a 32-bit integer to avoid string allocation in hot loops.
  // This drastically reduces GC pressure and speeds up Map lookups compared to string keys.
  _key(cx, cz) { return ((cx & 0xFFFF) << 16) | (cz & 0xFFFF); }
  _cellCoord(v) { return Math.floor(v / this.cellSize); }

  insert(enemy) {
    const p = enemy.mesh.position;
    const cx = this._cellCoord(p.x);
    const cz = this._cellCoord(p.z);
    const key = this._key(cx, cz);
    enemy._spatialKey = key;
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = []; this.cells.set(key, bucket); }
    bucket.push(enemy);
  }

  remove(enemy) {
    const key = enemy._spatialKey;
    if (key == null) return;
    const bucket = this.cells.get(key);
    if (!bucket) { enemy._spatialKey = null; return; }
    const i = bucket.indexOf(enemy);
    if (i !== -1) {
      // swap-pop
      const last = bucket.length - 1;
      if (i !== last) bucket[i] = bucket[last];
      bucket.pop();
    }
    if (bucket.length === 0) this.cells.delete(key);
    enemy._spatialKey = null;
  }

  /** Call after position update. Rehashes only if cell changed. */
  move(enemy) {
    const p = enemy.mesh.position;
    const cx = this._cellCoord(p.x);
    const cz = this._cellCoord(p.z);
    const key = this._key(cx, cz);
    if (key === enemy._spatialKey) return;
    this.remove(enemy);
    enemy._spatialKey = key;
    let bucket = this.cells.get(key);
    if (!bucket) { bucket = []; this.cells.set(key, bucket); }
    bucket.push(enemy);
  }

  /**
   * Returns array of active enemies within radius r of pos.
   * Iterates all cells overlapping the bounding box of the circle.
   */
  queryRadius(pos, r) {
    return this.queryRadiusInto(pos, r, []);
  }

  /**
   * iter 33n — fill `out` (cleared first) with active enemies within r of pos.
   * Hot callers (per-enemy separation) reuse a module-scope buffer to
   * eliminate ~N array allocs/frame at high enemy counts.
   */
  queryRadiusInto(pos, r, out) {
    out.length = 0;
    const cs = this.cellSize;
    const minCX = Math.floor((pos.x - r) / cs);
    const maxCX = Math.floor((pos.x + r) / cs);
    const minCZ = Math.floor((pos.z - r) / cs);
    const maxCZ = Math.floor((pos.z + r) / cs);
    const rSq = r * r;
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const bucket = this.cells.get(this._key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (!e.alive) continue;
          const dx = e.mesh.position.x - pos.x;
          const dz = e.mesh.position.z - pos.z;
          if (dx * dx + dz * dz <= rSq) out.push(e);
        }
      }
    }
    return out;
  }

  clear() { this.cells.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Init / pooling
// ─────────────────────────────────────────────────────────────────────────────
export function initEnemies(scene) {
  _scene = scene;
  state.enemies.spatial = new SpatialHash(SPATIAL.cellSize);
  state.enemies.pools = {};
  state.enemies.active.length = 0;
  // Stale death-pop corpses from a prior run: hide, don't pool (pools just reset).
  for (const c of _corpses) { if (c.e.mesh) c.e.mesh.visible = false; }
  _corpses.length = 0;
  // Facetank-pressure stamps — per-run reset (game clock restarts at 0).
  _campMoveT = 0;
  _heroCamping = false;
  _campMul = 1.0;
  _spriteSpawnSeed = 0;
  _poolEmptyWarned.clear();
}

// Pool-empty warn fires once per glbKey per run (cleared in initEnemies) —
// a real prewarm deficit stays visible without one line per clone.
const _poolEmptyWarned = new Set();

// The 10-min arc's elite throughput (miniboss ladder giant→dragon, helltide
// elites, sealed-room bosses, mini-events) overlaps enough to drain the
// config counts (giant 3, dragon 2) and force mid-game clones. Top up here:
// these are the heaviest meshes, so a modest +4 each — not the trash-tier
// dozens.
const _PREWARM_TOPUP = { giant: 4, dragon: 4 };

function _makePooledMesh(glbKey, scale) {
  const mesh = cloneCached(glbKey);
  if (!mesh) return null;
  const clips = getClips(glbKey);
  // Roughness picks: bugs (chitinous) shimmer slightly, elites stand out shinier.
  let rough = null;
  const tierCfg = _tierByGlb[glbKey];
  if (tierCfg && tierCfg.elite) rough = 0.55;            // elite = glossier
  else if (tierCfg && tierCfg.procAnim) rough = 0.65;    // bugs = mid-gloss chitin

  // iter 33p — collapse same-material child primitives into one Mesh each.
  // Static, clip-free GLBs only. Cuts draw calls per
  // instance: Wolf 21→4, Bee 16→3, bugs typically 1→1 (no-op).
  const _collapsed = clips.length === 0 ? collapseStaticMeshes(mesh) : 0;
  if (_collapsed > 0 && !_loggedSizes) _loggedSizes = {};
  if (_collapsed > 0 && _loggedSizes && !_loggedSizes['_col_' + glbKey]) {
    _loggedSizes['_col_' + glbKey] = true;
    console.log(`[enemy:${glbKey}] collapsed ${_collapsed} primitives → merged groups`);
  }

  // Own/promote the post-collapse bindings exactly once. Hue/Ghost styling is
  // completed before rim, flash and creature node controllers are attached.
  upgradeMaterials(mesh, 0.55, rough, { rim: false });
  const styledMaterials = new Set();
  mesh.traverse(o => {
    if (!o.isMesh || !o.material) return;
    // Blender-authored encounter kits mark emissive material groups through
    // glTF extras. Named fallback keeps older exports useful if an exporter
    // drops custom properties. Layer membership is clone-local and survives
    // damage flashes / material upgrades.
    if ((o.userData && o.userData.kkBloom) || /Bloom$/i.test(o.name || '')) {
      o.layers.enable(BLOOM_LAYER);
    }
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const material of materials) if (material) styledMaterials.add(material);
  });

  // Per-instance hue jitter for bug-tier meshes so a swarm reads as individuals.
  // Skip Quaternius rigged models — their colors are part of the character design.
  const _tier = _tierByGlb[glbKey];
  if (_tier && _tier.family === 'bug') {
    const hueShift = (Math.random() - 0.5) * 0.18;   // ±9% hue rotation
    const valJitter = 1 + (Math.random() - 0.5) * 0.18;
    const _hsl = { h: 0, s: 0, l: 0 };
    for (const material of styledMaterials) {
      if (!material.color) continue;
      material.color.getHSL(_hsl);
      _hsl.h = (_hsl.h + hueShift + 1) % 1;
      _hsl.l = Math.max(0, Math.min(1, _hsl.l * valJitter));
      material.color.setHSL(_hsl.h, _hsl.s, _hsl.l);
      material.needsUpdate = true;
    }
  }

  // Ghost-style: cool blue tint + translucent
  if (glbKey === 'ghost') {
    const ghostTint = new THREE.Color(0xaad8ff);
    for (const material of styledMaterials) {
      material.transparent = true;
      material.opacity = 0.55;
      material.depthWrite = false;
      if (material.color) material.color.lerp(ghostTint, 0.5);
      if (material.emissive) material.emissive.set(0x223355);
      material.emissiveIntensity = 0.4;
      material.needsUpdate = true;
    }
  }

  applyRimLight(mesh);
  applyDamageFlash(mesh, { color: 0xffffff, intensity: 1.6, amount: 0 });

  // Auto-fit: derive scale from bbox so swap-ins don't break sizing.
  // tier.scale acts as a multiplier on "1 hero-unit tall" baseline (~2 world units).
  // Update world matrix so bbox is correct (cloned scenes are dirty by default).
  mesh.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(mesh);
  const raw = rawBox.getSize(new THREE.Vector3());
  const baseFit = raw.y > 1e-6 ? 2.0 / raw.y : 1;
  mesh.userData.baseFit = baseFit;
  mesh.scale.setScalar(baseFit * scale);
  // Many Quaternius models have origin at center/chest. After scaling, measure
  // bbox.min.y and stash so spawnEnemy can lift the model so feet sit on ground.
  mesh.updateMatrixWorld(true);
  const fitBox = new THREE.Box3().setFromObject(mesh);
  mesh.userData.yOffset = -fitBox.min.y;
  if (!_loggedSizes) {
    _loggedSizes = {};
  }
  if (!_loggedSizes[glbKey]) {
    _loggedSizes[glbKey] = true;
    console.log(`[enemy:${glbKey}] raw=${raw.x.toFixed(2)}x${raw.y.toFixed(2)}x${raw.z.toFixed(2)} fit=${baseFit.toFixed(3)} yOffset=${mesh.userData.yOffset.toFixed(2)}`);
  }
  mesh.visible = false;
  mesh.position.set(0, mesh.userData.yOffset, 0);

  // Animation mixer: attach a mixer + the model's first animation clip if any.
  // We pre-warm the mixer here so spawnEnemy doesn't pay the cost mid-game.
  if (clips.length > 0) {
    const mixer = new THREE.AnimationMixer(mesh);
    const clip = findClip(clips, 'walk', 'run', 'move', 'idle');
    if (clip) {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      mesh.userData.hasClip = true;
    }
    mesh.userData.mixer = mixer;
    mesh.userData.mixerPhase = Math.random() * 1.2;
  }
  if (!_loggedClips) _loggedClips = {};
  if (!_loggedClips[glbKey]) {
    _loggedClips[glbKey] = true;
    console.log(`[enemy:${glbKey}] clips: ${clips.length} ${clips.map(c => c.name).join(',')}`);
  }

  // Portable TSL deformation for ordinary static GLBs only. Authored clips,
  // skinning and morph families retain their native animation paths.
  const tier = _tierByGlb[glbKey];
  if (tier && _VERTEX_ANIM_KINDS.has(tier.procAnim) && clips.length === 0) {
    applyCreatureVertexAnim(mesh, tier.procAnim, { time: 0, amplitude: 1 });
  }
  return mesh;
}

export function prewarmPools() {
  // Per-run reset of the once-per-key pool-empty warn (prewarmPools runs on
  // every Embark; initEnemies only runs once at boot).
  _poolEmptyWarned.clear();
  const activeStageId = state.run && state.run.stage ? state.run.stage.id : '';
  const spriteHordeReady = hasSpritePool(V1_ENEMY_ATLAS_ID)
    || (activeStageId === 'forest' && hasSpritePool(FOREST_ENEMY_ATLAS_ID));
  for (const key of Object.keys(POOL_PREWARM)) {
    const tier = _tierByGlb[key];
    if (!tier) { console.warn(`[enemies] prewarm: no tier for "${key}"`); continue; }
    if (tier.kakiLandOnly && activeStageId !== 'kakiland') continue;
    // A live 512-slot enemy atlas is the canonical path for every trash tier
    // and exceeds the global 350-enemy cap. Prewarming hundreds of hidden GLB
    // clones in parallel consumed CPU/GPU memory without ever lending a mesh.
    // Keep GLB prewarm as the fallback when atlas bootstrap failed or is late.
    if (spriteHordeReady && _SPRITE_KEYS.has(key) && !tier.elite) continue;
    if (!GLTF_CACHE[key]) { console.warn(`[enemies] prewarm: GLTF "${key}" not loaded`); continue; }

    const n = POOL_PREWARM[key] + (_PREWARM_TOPUP[key] || 0);
    const pool = state.enemies.pools[key] || (state.enemies.pools[key] = []);
    // Deficit-based: prewarmPools runs on EVERY Embark and teardown returns
    // all meshes, so an unconditional `i = 0` loop grew every pool by n per
    // run (scene-resident GLB clones leaking linearly per session).
    for (let i = pool.length; i < n; i++) {
      const mesh = _makePooledMesh(key, tier.scale);
      if (!mesh) break;
      _scene.add(mesh);
      pool.push(mesh);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn / kill
// ─────────────────────────────────────────────────────────────────────────────
export function spawnEnemy(tierConfig, x, z) {
  const key = tierConfig.glb;

  // ── 2D billboard path (trash only) ──
  // If this tier is sprite-eligible AND a billboard slot is available, render
  // it from the shared 'enemies' atlas (1 draw call for the whole horde) and
  // back it with a bare Object3D anchor. Falls through to the 3D GLB path if
  // the atlas isn't loaded yet (slot < 0) so the first wave never goes blank.
  let mesh = null;
  let spriteSlot = -1;
  let spriteAtlasId = V1_ENEMY_ATLAS_ID;
  let spriteV2 = false;
  const wantSprite = _SPRITE_KEYS.has(key)
    && !tierConfig.elite && !tierConfig.isMiniBoss && !tierConfig.isFinalBoss;
  if (wantSprite) {
    const forestSpeciesId = _FOREST_SPRITE_SPECIES[key];
    const activeStageId = state.run?.stage?.id || '';
    spriteV2 = activeStageId === 'forest'
      && forestSpeciesId !== undefined
      && hasSpritePool(FOREST_ENEMY_ATLAS_ID);
    const scale = tierConfig.spriteScale
      || Math.max(SPRITE_MIN_HEIGHT, (tierConfig.scale || 1) * SPRITE_FIT_HEIGHT);
    if (spriteV2) {
      spriteAtlasId = FOREST_ENEMY_ATLAS_ID;
      let vx = (state.hero?.pos?.x ?? x) - x;
      let vz = (state.hero?.pos?.z ?? z) - z;
      const magnitude = Math.hypot(vx, vz);
      if (magnitude > 0.0001) {
        const speed = tierConfig.spd || 1;
        vx = vx / magnitude * speed;
        vz = vz / magnitude * speed;
      }
      spriteSlot = spawnEnemySprite(spriteAtlasId, {
        x, y: 0.06, z, scale,
        speciesId: forestSpeciesId,
        stateId: ENEMY_SPRITE_STATE.MOVE,
        vx,
        vz,
        speed: tierConfig.spd,
        nominalSpeed: tierConfig.spd,
        seed: _spriteSpawnSeed++,
      });
    } else {
      spriteSlot = spawnSprite(spriteAtlasId, {
        x, y: 0.06, z, scale, anim: key,
      });
    }
    if (spriteSlot >= 0) {
      mesh = _anchorPool.pop() || new THREE.Object3D();
      // Position-only anchors stay off-scene. The billboard pool owns the
      // renderable, so attaching hundreds of empty Object3Ds only bloated
      // scene traversal in bloom, main, and shadow passes.
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.position.set(x, 0, z);
      mesh.visible = true;
    }
  }

  if (!mesh) {
    let pool = state.enemies.pools[key];
    if (!pool) pool = state.enemies.pools[key] = [];
    mesh = pool.pop();
    if (!mesh) {
      // Pool exhausted. A matching death-pop corpse would hand its mesh back
      // in <=90ms anyway — early-release it instead of paying for a mid-game
      // clone (material clones + bbox fit + mixer = frame hitch at exactly
      // the spike moments that drained the pool). Scan OLDEST-first: the
      // newest corpse just started its pop and truncating it blinks visibly;
      // the oldest is a frame or two from vanishing anyway.
      for (let ci = 0; ci < _corpses.length; ci++) {
        if (_corpses[ci].e.glbKey !== key) continue;
        _releaseEnemyMesh(_corpses[ci].e);
        const _cl = _corpses.length - 1;
        if (ci !== _cl) _corpses[ci] = _corpses[_cl];
        _corpses.pop();
        mesh = pool.pop();
        break;
      }
    }
    if (!mesh) {
      // Pool exhausted — clone fresh and warn (means POOL_PREWARM was too small).
      if (!_poolEmptyWarned.has(key)) {
        _poolEmptyWarned.add(key);
        console.warn(`[enemies] pool empty for "${key}" — cloning mid-game`);
      }
      mesh = _makePooledMesh(key, tierConfig.scale);
      if (!mesh) return null;
      _scene.add(mesh);
    }
    const fit = mesh.userData && mesh.userData.baseFit ? mesh.userData.baseFit : 1;
    mesh.scale.setScalar(fit * tierConfig.scale);
    // yOffset was computed at pool-time AFTER scale was applied — it's already in
    // world units. Do NOT multiply by tier.scale again (was clipping models into ground).
    const yOff = (mesh.userData && mesh.userData.yOffset) || 0;
    mesh.position.set(x, yOff, z);
    mesh.visible = true;
  }

  /** @type {import('./state.js').EnemyInstance} */
  // Hyper mode: 1.5× HP/spd/dmg across the board.
  // Daily 'HARDER SPAWNS' modifier stacks an additional HP multiplier.
  // Stage 2+ also stacks an HP multiplier (e.g. Twilight Hollow = 1.30×).
  // Weekly HALF_HP_HALF_DMG (iter 9) stamps weeklyEnemyHpMul=0.5 & weeklyEnemyDmgMul=0.5.
  const hyper    = state.modes && state.modes.hyper ? 1.5 : 1;
  const dailyHp  = state.run && state.run.dailyHpMul ? state.run.dailyHpMul : 1;
  const stageHp  = state.run && state.run.stageHpMul ? state.run.stageHpMul : 1;
  const weeklyHp = state.run && state.run.weeklyEnemyHpMul ? state.run.weeklyEnemyHpMul : 1;
  const weeklyDg = state.run && state.run.weeklyEnemyDmgMul ? state.run.weeklyEnemyDmgMul : 1;
  // Iter 33d — time-based scaling so the hero stops one-shotting at 3 min.
  // D ramps 0→1 over first 60 s, then 1→10 by 20 min. HP and damage both
  // ride that curve (HP harder, damage softer) on top of all other multipliers.
  const _D       = _computeDifficulty(state.time && state.time.game ? state.time.game : 0);
  const rampHp   = 1 + SPAWN.rampHpPerD  * _D;
  const rampDmg  = 1 + SPAWN.rampDmgPerD * _D;
  // Final boss ignores (or damps) the per-stage HP mult so its tuned ~25-45s
  // TTK stays flat across stages instead of inverting on harder ones (a void
  // boss was ~1.85× a forest boss while hero DPS is stage-invariant). Trash +
  // mini-bosses keep full stage scaling. See SPAWN.finalBossStageHpDamp.
  const _bossDamp  = (SPAWN.finalBossStageHpDamp != null) ? SPAWN.finalBossStageHpDamp : 1;
  const effStageHp = tierConfig.isFinalBoss ? (1 + (stageHp - 1) * _bossDamp) : stageHp;
  const hpMul    = hyper * dailyHp * effStageHp * weeklyHp * rampHp;
  const enemy = {
    mesh,
    glbKey: key,
    displayName: tierConfig.displayName || null,
    family: tierConfig.family || null,
    hp: tierConfig.hp * hpMul,
    hpMax: tierConfig.hp * hpMul,
    spd: tierConfig.spd * hyper,
    dmg: tierConfig.dmg * hyper * weeklyDg * rampDmg,
    // Gem value rides the difficulty curve like HP/dmg: trash 1 early, 2 by
    // ~min 5, scaling late. Elite/final values map to xp.js color tiers.
    // /1.5 not /2.5: the stairstep plateaued at value 3 across the entire
    // 330-450s band while xpNext compounded — the late-game level drought.
    // Elites scale with the same ramp their HP rides (a dragon paying 10 XP
    // at L30 was 0.27% of a level for the most expensive kill in the band).
    xp: tierConfig.isFinalBoss ? 50
      : (tierConfig.elite ? 10 + Math.round(_D * 4) : 1 + Math.floor(_D / 1.5)),
    // Spawn-time dmg ramp, re-applied to ranged projectiles at fire time —
    // r is the SHARED tier config object, so r.projDmg must never be mutated.
    // Below D=3 ranged bolts fire at 2/3 damage (~6 vs 9): wizards arrive at
    // D=0.8 and the compressed D-curve (max at 11:00) reaches D=3 by ~2:20 —
    // a no-build hero can't outrun projSpeed 11, so the early crossfire
    // teaches dodging without deleting fresh saves.
    _rampDmg: rampDmg * (tierConfig.ranged && _D < 3 ? 0.67 : 1),
    contactCooldown: 0,
    elite: !!tierConfig.elite,
    isFinalBoss: !!tierConfig.isFinalBoss,
    isMiniBoss: !!tierConfig.isMiniBoss,
    // Authored Kaki Land portal bosses carry their route identity from the
    // spawn tier so boss telegraphs and intro presentation can select the
    // correct signature before the first gameplay tick.
    kakiLandPortalId: tierConfig.kakiLandPortalId || null,
    kakiLandPatternId: tierConfig.kakiLandPatternId || null,
    _kakiEncounterAdd: !!tierConfig.kakiLandEncounterAdd,
    _kakiEncounterRole: tierConfig.kakiLandEncounterRole || null,
    // Shared crowd-control contract used by Nova, roots, spores and pulls.
    // These flags were historically read by several weapons but never
    // stamped, allowing boss-class enemies to be frozen or displaced.
    _heavy: !!(tierConfig.isFinalBoss || tierConfig.isMiniBoss),
    _noKnockback: !!(tierConfig.isFinalBoss || tierConfig.isMiniBoss),
    // Yaw offset added to atan2(dx,dz) when facing the hero.
    // - `faceFlip: true`  → π   (GLB authored facing +Z forward)
    // - `faceYaw: <rad>`  → arbitrary radian offset (e.g. ±π/2 for sideways)
    // faceYaw wins if both set.
    faceYaw: (typeof tierConfig.faceYaw === 'number')
      ? tierConfig.faceYaw
      : (tierConfig.faceFlip ? Math.PI : 0),
    alive: true,
    _spatialKey: null,
    knockVx: 0,
    knockVz: 0,
    slowMul: 1,
    _dotDps: 0,
    _dotUntil: 0,
    _dotAcc: 0,
    _flashUntil: 0,
    _wasFlashing: false,
    // Vulnerability debuff (A3): incoming dmg multiplier active until _vulnerableUntil.
    // Mirrors _frozenUntil pattern. Stacking rule (see applyVulnerability): max mul wins,
    // longest duration wins, so a stronger debuff can't be overridden by a weaker one.
    _vulnerableUntil: 0,
    _vulnerableMul: 1.0,
    // 2D billboard state (see _SPRITE_KEYS). _isSprite gates the GLB-only
    // anim/mixer/facing paths + routes mesh recycling through _releaseEnemyMesh.
    _isSprite: spriteSlot >= 0,
    _spriteSlot: spriteSlot,
    _spriteAtlasId: spriteSlot >= 0 ? spriteAtlasId : null,
    _spriteV2: spriteSlot >= 0 && spriteV2,
    procAnim: tierConfig.procAnim || null,
    ranged: tierConfig.ranged || null,
    rangedCD: tierConfig.ranged ? (Math.random() * tierConfig.ranged.cooldown) : 0,
    _patternPhase: tierConfig.ranged && tierConfig.ranged.pattern === 'ring'
      ? Math.random() * Math.PI * 2 : 0,
    _animPhase: Math.random() * 6,
    // yOffset is already in world units (computed post-scale at pool time)
    _baseY: (mesh.userData && mesh.userData.yOffset ? mesh.userData.yOffset : 0),
    _baseScale: (mesh.userData && mesh.userData.baseFit ? mesh.userData.baseFit : 1) * tierConfig.scale,
    // FE-C3A — room-scope despawn tag. Stamp the room the enemy spawned in
    // so updateEnemies can silently retire enemies from rooms the player
    // has left (>60u from hero). 'arena' for non-Forest stages so the
    // despawn check can early-out on stage mismatch. Bosses/elites are
    // exempt at the despawn site, not here, so the tag stays uniform.
    room: (state.run && state.run.stage && state.run.stage.id === 'forest')
      ? (state.run.currentRoom || 'glade')
      : 'arena',
  };

  // Pool reuse starts from neutral controller values without touching material
  // properties or rebuilding node graphs.
  resetMaterialControllers(mesh, { creatureTime: 0, creatureAmplitude: 1 });

  // Selective shadow casting — only elites/mini/final cast real shadows.
  // Swarm enemies keep blob shadows for performance (200 casters would tank).
  const castOn = !!(tierConfig.elite || tierConfig.isMiniBoss || tierConfig.isFinalBoss);
  if (mesh.userData._castSet !== castOn) {
    mesh.traverse(o => { if (o.isMesh) o.castShadow = castOn; });
    mesh.userData._castSet = castOn;
  }

  // ── Iter 8 affix roll — must run BEFORE spatial insert so Swift's spd/dmg
  // mutation lands on the enemy that the rest of the loop will read. Final +
  // mini-bosses are skipped by rollAffixes() itself.
  try { rollAffixes(enemy, _computeDifficulty(state.time.game)); } catch (e) { console.warn('[enemies.rollAffixes]', e); }
  if (tierConfig.fixedAffix) {
    try { applyAffix(enemy, tierConfig.fixedAffix); } catch (e) { console.warn('[enemies.fixedAffix]', tierConfig.fixedAffix, e); }
  }

  state.enemies.spatial.insert(enemy);
  state.enemies.active.push(enemy);
  // Stage-rule spawn hook (e.g. per-stage tweaks to fresh enemies).
  try { notifyStageEnemySpawn(enemy); } catch (_) {}
  // Codex discovery: stamp the bestiary the first time we see this tier.
  try { notifyEnemySeen(key); } catch (_) {}
  // PHASE 1 P1E — boss intro cinematic. First-of-tier per run only; module
  // self-gates via state.run._cinematicSeen so repeated calls are cheap no-ops.
  if (enemy.isFinalBoss)     { try { _triggerBossIntro(enemy, 'finalboss'); } catch (_) {} }
  else if (enemy.isMiniBoss) { try { _triggerBossIntro(enemy, 'miniboss'); } catch (_) {} }
  else if (enemy.elite && !enemy.isFinalBoss) { try { _triggerBossIntro(enemy, 'elite'); } catch (_) {} }
  return enemy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nemesis Elite (C3) — procedural mesh + custom spawn (bypasses pool path)
// ─────────────────────────────────────────────────────────────────────────────
//
// The Nemesis flows through updateEnemies for movement/contact/damage (so
// the hunter behaviour falls out of the existing seek-hero loop for free at
// the configured spd) but is NOT a pooled GLB clone — the procedural body
// keeps the obsidian + bloom-glow silhouette under our control and lets the
// core stay layer-tagged across the flash/freeze/debuff mutations (those
// touch material.emissive / spd, never mesh.layers, so a one-shot enable at
// build time survives). The mesh is disposed in onNemesisKilled, not pooled.
function _buildNemesisFallbackMesh() {
  const g = new THREE.Group();
  // Body: chunky obsidian torso. ConeGeometry inverted (apex down) reads as
  // a hulking forward-leaning silhouette from the iso camera.
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 2.4, 6),
    new THREE.MeshStandardMaterial({
      color: NEMESIS_TIER.color,
      roughness: 0.45,
      metalness: 0.35,
      emissive: 0x000000,
      emissiveIntensity: 0,
    }),
  );
  body.position.y = 1.2;
  body.castShadow = true;
  g.add(body);

  // Shoulders: two squat boxes flanking the body to break the cone read.
  const shoulderMat = new THREE.MeshStandardMaterial({
    color: 0x18181c, roughness: 0.55, metalness: 0.30,
  });
  for (const dx of [-0.55, 0.55]) {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.7), shoulderMat);
    sh.position.set(dx, 1.8, 0);
    sh.castShadow = true;
    g.add(sh);
  }

  // Glowing core: small inset emissive sphere at chest height. Bloom-layer
  // enabled so the post-fx pipeline picks it up. setHex with emissive +
  // toneMapped: false keeps the red brilliant under HDR composite.
  const coreMat = new THREE.MeshStandardMaterial({
    color: NEMESIS_TIER.glowColor,
    emissive: NEMESIS_TIER.glowColor,
    emissiveIntensity: 2.4,
    roughness: 0.2,
    metalness: 0.0,
    toneMapped: false,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), coreMat);
  core.position.set(0, 1.6, 0.55);   // pushed forward as "chest eye"
  core.layers.enable(BLOOM_LAYER);
  g.add(core);

  // Twin pin-prick eyes on the upper body — same emissive material so the
  // bloom pass treats them as one continuous glow.
  for (const ex of [-0.18, 0.18]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), coreMat);
    eye.position.set(ex, 2.05, 0.50);
    eye.layers.enable(BLOOM_LAYER);
    g.add(eye);
  }

  // Subtle red rim light at the base — sits low so it pools around the feet
  // for the silhouette to read in dark stages. Bloom-tagged.
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.85, 16),
    new THREE.MeshBasicMaterial({
      color: NEMESIS_TIER.glowColor,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.04;
  rim.layers.enable(BLOOM_LAYER);
  g.add(rim);

  // Scale to NEMESIS_TIER.scale (1.4× silhouette).
  g.scale.setScalar(NEMESIS_TIER.scale);
  g.userData._isNemesisMesh = true;
  g.userData._nemesisCore = core;
  upgradeMaterials(g, 0.82, null, { rim: false });
  const isBodyObject = (object) => (object.layers.mask & (1 << BLOOM_LAYER)) === 0;
  applyRimLight(g, { filterObject: isBodyObject });
  applyDamageFlash(g, {
    color: 0xffffff,
    intensity: 1.6,
    amount: 0,
    // Preserve the core/eyes/rim exclusions exactly.
    filterObject: isBodyObject,
    filterMaterial: (material) => !/ruby|yarn/i.test(material.name || ''),
  });
  return g;
}

// Author in Blender as a real clockwork cat hunter, with a deliberately tiny
// three-primitive material budget. The legacy procedural silhouette remains a
// failure-safe only; it should never be the live path after the awaited combat
// preload completes.
const _nemesisFitBox = new THREE.Box3();
function _buildNemesisMesh() {
  const authored = cloneCached('nemesis_stalker');
  if (!authored) return _buildNemesisFallbackMesh();

  if (getClips('nemesis_stalker').length === 0) collapseStaticMeshes(authored);
  upgradeMaterials(authored, 0.82, 0.32, { rim: false });
  authored.updateWorldMatrix(true, true);
  _nemesisFitBox.setFromObject(authored);
  if (!_nemesisFitBox.isEmpty()) authored.position.y -= _nemesisFitBox.min.y;

  const g = new THREE.Group();
  g.name = 'Clockwork Stalker';
  g.add(authored);
  const authoredScale = NEMESIS_TIER.scale * 0.86;
  g.scale.setScalar(authoredScale);
  g.userData.baseScale = authoredScale;
  g.userData._isNemesisMesh = true;
  g.userData.authoredAsset = 'nemesis_stalker';

  authored.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.castShadow = true;
    o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const isRuby = mats.some((mat) => /ruby|yarn/i.test(mat.name || ''));
    if (isRuby) {
      o.layers.enable(BLOOM_LAYER);
      if (!g.userData._nemesisCore) g.userData._nemesisCore = o;
      return;
    }
  });
  applyRimLight(authored);
  g.userData.damageFlashController = applyDamageFlash(authored, {
    color: 0xffffff,
    intensity: 1.6,
    amount: 0,
    filterObject: (object) => (object.layers.mask & (1 << BLOOM_LAYER)) === 0,
    filterMaterial: (material) => !/ruby|yarn/i.test(material.name || ''),
  });
  return g;
}

/**
 * Spawn the singleton Nemesis. Called from spawnDirector.spawnNemesis() once
 * per cycle. Does NOT push into a pool — mesh is freshly built, disposed on
 * kill. Returns the enemy-shaped object (or null if scene not initialised).
 *
 * Difficulty / stage HP multipliers are replicated here because we bypass the
 * pooled spawnEnemy() block at line 340-358. Without this, late-game nemesis
 * HP stays at the 800 baseline while standard mobs are 6× scaled.
 */
export function spawnNemesis(x, z) {
  if (!_scene) return null;
  const mesh = _buildNemesisMesh();
  mesh.position.set(x, 0, z);
  _scene.add(mesh);

  // Mirror the multiplier block from spawnEnemy(). Hyper/daily/stage/weekly
  // + the time-based difficulty ramp all apply to the nemesis the same way
  // they apply to every other enemy at spawn time.
  const hyper    = state.modes && state.modes.hyper ? 1.5 : 1;
  const dailyHp  = state.run && state.run.dailyHpMul ? state.run.dailyHpMul : 1;
  const stageHp  = state.run && state.run.stageHpMul ? state.run.stageHpMul : 1;
  const weeklyHp = state.run && state.run.weeklyEnemyHpMul ? state.run.weeklyEnemyHpMul : 1;
  const weeklyDg = state.run && state.run.weeklyEnemyDmgMul ? state.run.weeklyEnemyDmgMul : 1;
  const _D       = _computeDifficulty(state.time && state.time.game ? state.time.game : 0);
  const rampHp   = 1 + SPAWN.rampHpPerD  * _D;
  const rampDmg  = 1 + SPAWN.rampDmgPerD * _D;
  const hpMul    = hyper * dailyHp * stageHp * weeklyHp * rampHp;

  const enemy = {
    mesh,
    glbKey: '__nemesis__',
    hp: NEMESIS_TIER.hp * hpMul,
    hpMax: NEMESIS_TIER.hp * hpMul,
    spd: NEMESIS_TIER.spd * hyper,
    dmg: NEMESIS_TIER.dmg * hyper * weeklyDg * rampDmg,
    contactCooldown: 0,
    elite: true,                  // treated as elite by killEnemy drop tables
    isFinalBoss: false,
    isMiniBoss: false,
    isNemesis: true,              // gates the custom kill branch + skips affix roll
    _heavy: true,
    _noKnockback: true,
    faceYaw: 0,
    alive: true,
    _spatialKey: null,
    knockVx: 0, knockVz: 0,
    slowMul: 1,
    _dotDps: 0, _dotUntil: 0, _dotAcc: 0,
    _flashUntil: 0, _wasFlashing: false,
    _vulnerableUntil: 0, _vulnerableMul: 1.0,
    procAnim: null, ranged: null, rangedCD: 0,
    _animPhase: 0,
    _baseY: 0,
    _baseScale: (mesh.userData && mesh.userData.baseScale) || NEMESIS_TIER.scale,
    // FE-C3A — room tag. Nemesis is exempt from room-scope despawn at the
    // despawn site (it's a boss-tier hunter that should follow the player
    // across rooms), but the field is stamped for symmetry with spawnEnemy.
    room: (state.run && state.run.stage && state.run.stage.id === 'forest')
      ? (state.run.currentRoom || 'glade')
      : 'arena',
  };

  state.enemies.spatial.insert(enemy);
  state.enemies.active.push(enemy);
  return enemy;
}

// Procedural body anim for static GLBs that have no AnimationMixer clip.
// Drives whole-mesh transform — no skeleton required.
function _applyProcAnim(e) {
  const m = e.mesh;
  const p = e._animPhase;
  const baseY = e._baseY || 0;
  const baseS = e._baseScale || 1;
  switch (e.procAnim) {
    case 'crawl': {
      // Subtle leg-compress: tiny scale pulse + tiny bob. NO body tilt (was
      // tipping the model through the ground at large amplitudes).
      const wob = Math.sin(p * 12);
      m.scale.x = baseS * (1 + wob * 0.04);
      m.scale.z = baseS * (1 - wob * 0.025);
      m.scale.y = baseS;
      m.position.y = baseY + Math.abs(wob) * 0.015;
      break;
    }
    case 'flap': {
      // Wing flap — scale X big amplitude reads as wings closing/opening from iso
      const flap = Math.sin(p * 18);
      m.scale.x = baseS * (1 + flap * 0.30);
      m.scale.z = baseS * (1 - flap * 0.08);
      m.scale.y = baseS;
      m.position.y = baseY + Math.sin(p * 4) * 0.35 + 0.2;
      break;
    }
    case 'hover': {
      // Rapid wing micro-jitter + soft float
      m.scale.x = baseS * (1 + Math.sin(p * 60) * 0.08);
      m.scale.z = baseS;
      m.scale.y = baseS;
      m.position.y = baseY + Math.sin(p * 6) * 0.20 + 0.25;
      break;
    }
    case 'hop': {
      // Vertical bounce — modest height so it doesn't read as flying
      const h = Math.max(0, Math.sin(p * 3.5));
      m.position.y = baseY + h * 0.30;
      // Slight squash on contact (frame where h ≈ 0)
      const squash = 1 - (1 - h) * 0.10;
      m.scale.y = baseS * squash;
      break;
    }
    case 'inch': {
      // Accordion squash along length
      const s = Math.sin(p * 4.5);
      m.scale.x = baseS * (1 + s * 0.14);
      m.scale.z = baseS * (1 - s * 0.10);
      m.scale.y = baseS;
      m.position.y = baseY + Math.abs(s) * 0.03;
      break;
    }
    case 'pad': {
      // Quadruped padding gait — gentle vertical bob + slight side-to-side
      // shoulder roll. Reads as a wolf/dog stalking forward.
      const stride = Math.sin(p * 8);
      const roll   = Math.sin(p * 4);     // half-frequency = shoulder sway
      m.position.y = baseY + Math.abs(stride) * 0.08;
      m.scale.x = baseS * (1 + stride * 0.05);
      m.scale.z = baseS * (1 - stride * 0.03);
      m.scale.y = baseS * (1 + Math.abs(stride) * 0.02);
      m.rotation.z = roll * 0.07;
      break;
    }
    case 'scurry': {
      // Wind-up toy gait: quick wheel chatter with a tiny anticipatory lean.
      const step = Math.sin(p * 18);
      m.position.y = baseY + Math.abs(step) * 0.035;
      m.scale.x = baseS * (1 + step * 0.025);
      m.scale.z = baseS * (1 - step * 0.035);
      m.scale.y = baseS * (1 + Math.abs(step) * 0.018);
      m.rotation.z = Math.sin(p * 9) * 0.045;
      break;
    }
    case 'wisp': {
      // Hovering yarn spirit: float and breathe without shader deformation.
      const hover = Math.sin(p * 4.2);
      m.position.y = baseY + 0.32 + hover * 0.16;
      m.scale.x = baseS * (1 + hover * 0.035);
      m.scale.z = baseS * (1 - hover * 0.025);
      m.scale.y = baseS;
      m.rotation.z = Math.sin(p * 2.1) * 0.08;
      break;
    }
  }
}

// Trash death-poof budget: above 10 kills/s only every 2nd kill gets the
// authored paw puff. The dissolve/sprite dust layers still cover every kill.
let _trashPoofSec = -1;
let _trashPoofKills = 0;
// Multi-kill micro hit-stop: >=6 deaths inside a 100ms window → 0.04s freeze
// with a 0.5s refractory. BYPASSES the >=40%-maxHP big-kill gate in
// damageEnemy so a salvo wipe of trash still reads as a crunch.
let _multiKillWinStart = 0;
let _multiKillCount = 0;
let _multiKillNextEligible = 0;
// Death scale-pop: GLB corpses linger ~90ms scaled (x1.25, slight y-squash)
// before pool return so deaths read as a pop, not a vanish. Capped so a
// borgir salvo can't starve the GLB pools mid-frame. Sprite billboards have
// no per-slot scale hook — they release immediately (no pop).
const CORPSE_POP_CAP = 40;
const _corpses = []; // {e, t}

/**
 * Finish the stage through the same reward/victory path as a killed final
 * boss.  Forest's Grove-Trial route calls this after the Crypt Warden reward
 * is claimed and the player ascends, so it cannot be bypassed by merely
 * entering the dungeon.  Keeping the ceremony here also prevents the two
 * finale paths from drifting apart.
 */
export function completeFinalBossVictory(x = state.hero.pos.x, z = state.hero.pos.z, {
  dropEndlessChests = true,
} = {}) {
  if (state.gameOver) return false;
  state.fx.bloomBoost = 1.0;
  state.fx.shake = 0.9;
  if (sfx && sfx.victory) sfx.victory();
  try { tryAchievement('first_victory'); } catch (_) {}

  // BorgirBoss unlock — record this stage's final-boss win under hypermode.
  if (state.modes && state.modes.hyper) {
    const stageId = state.run && state.run.stage && state.run.stage.id;
    if (stageId) {
      try {
        const justFlipped = recordHyperBossKill(stageId);
        if (justFlipped) showBanner('🍔 BORGIRBOSS UNLOCKED', 4.0, '#ffd27f');
      } catch (_) {}
    }
  }

  // Roll + persist a relic for the death-screen reveal.
  try {
    const drop = rollRelic();
    addRelic(drop);
    state.run.relicDrop = drop;
  } catch (_) {}

  if (state.modes && state.modes.endless) {
    if (dropEndlessChests) {
      try {
        spawnChestRaw(x + 2, z);
        spawnChestRaw(x - 2, z);
      } catch (_) {}
    }
    try { showBanner('THE SEAM OPENS AGAIN', 4.0, '#ff5555'); } catch (_) {}
  } else {
    // Victory is an explicit run outcome, not a flavored death. Stamp it
    // before gameOver so every synchronous observer sees a coherent terminal
    // state, then freeze combat through the existing gameOver gate.
    state.victory = true;
    if (state.run) {
      state.run.outcome = {
        kind: 'victory',
        stageId: state.run.stage ? state.run.stage.id : null,
        at: state.time.game,
      };
    }
    if (state.hero) {
      state.hero.hp = Math.max(1, state.hero.hp || 0);
      if (state.hero.vel && typeof state.hero.vel.set === 'function') state.hero.vel.set(0, 0, 0);
      state.hero.iFramesUntil = Infinity;
    }
    state.gameOver = true;
    // 1.4 matches updateDeathAnim's hardcoded total.
    state.dyingUntil = state.time.real + 1.4;
  }
  return true;
}

export function killEnemy(enemy) {
  if (!enemy.alive) return;
  enemy.alive = false;
  enemy.mesh.visible = false;

  // Punch List #3 (2026-05-16) — Dissolve-to-Gold death burst. Pre-pooled
  // (256 cap, ZERO per-death allocation) so this is safe at hundreds of
  // deaths/sec. `state.run.lowFx` kill-switch is checked inside spawn. Fired
  // here at the top of killEnemy so EVERY death branch (trash, elite,
  // totem, pylon, bell, nemesis, mini/final boss) gets the dust pop without
  // duplicating the call in each early-return.
  const _stageId = (state.run && state.run.stage && state.run.stage.id) || 'forest';
  try { spawnDissolveBurst(enemy.mesh.position, _stageId); } catch (_) { /* fx must never block gameplay */ }

  // Sprite FX: dust-puff on every death. Anchored to ground (y=0.05). Pool
  // bypasses on low-fx. STATIC import only — killEnemy is the hottest of all
  // hot paths (borgir salvo = 32 deaths/frame). Returns -1 if atlas not
  // loaded yet — safe no-op. try/catch isolates sprite faults from the
  // kill-cleanup pipeline below.
  try {
    spawnSprite('fx/dust_puff_v1', {
      x: enemy.mesh.position.x,
      y: 0.05,
      z: enemy.mesh.position.z,
      scale: 1.0,
      anim: 'default',
    });
  } catch (_) {}

  // Totem branch: custom death handling lives in src/totems.js (drops chest,
  // schedules respawn, removes mesh from scene since totems aren't pooled).
  if (enemy.isTotem) {
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./totems.js').then(({ onTotemKilled }) => onTotemKilled(enemy));
    return;
  }
  // Pylon branch: same shape — custom mesh, custom death drops.
  if (enemy.isPylon) {
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./pylons.js').then(({ onPylonKilled }) => onPylonKilled(enemy));
    return;
  }
  // Bell branch: same shape — risk/reward, guaranteed chest + ember bonus.
  if (enemy.isBell) {
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./bells.js').then(({ onBellKilled }) => onBellKilled(enemy));
    return;
  }
  // Nemesis branch (C3): same shape — custom procedural mesh + bespoke
  // reward bundle. spawnDirector owns the schedule reset + banner + drops
  // (single-active rule lives there), this branch just tears down the mesh
  // and notifies. Kill ring fires before this so the player gets the
  // elite-scale red flash on the killing blow. XP gem and run.kills bump
  // are intentionally still credited via the standard tail of killEnemy —
  // we splice here and dropGem is replicated in onNemesisKilled.
  if (enemy.isNemesis) {
    spawnKillRing(enemy.mesh.position.x, enemy.mesh.position.z, true);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.45);
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.7);
    if (sfx && sfx.eliteDeath) sfx.eliteDeath();
    state.enemies.spatial.remove(enemy);
    const idx = state.enemies.active.indexOf(enemy);
    if (idx >= 0) state.enemies.active.splice(idx, 1);
    import('./spawnDirector.js').then(({ onNemesisKilled }) => onNemesisKilled(enemy));
    return;
  }

  // FOREST-V2-A14 — sealed-door room progression: notify the cohort that this
  // tagged room boss died (unseals the return portal + banner + chest). Runs
  // BEFORE the standard miniboss cleanup so the chest drop happens before
  // dropForestChest fires again below for the regular miniboss chest path —
  // both chests dropping at the same coord is fine (pool dedupes spatially).
  if (enemy._isRoomBoss) { try { _forestRoomBossKilled(enemy); } catch (_) {} }

  // Iter 19 (FX_AUDIT_V2 §198): full boss-windup telegraph teardown if a
  // mini-boss or final boss dies during its windup. Previously only
  // _tellRing was dropped here, leaving _engulfInner / _sonicInner /
  // _quakeMeshes orphaned in-scene until the next-run reset. disposeBoss-
  // Telegraphs walks every per-enemy mesh + zeroes the mid-windup state.
  // try/catch keeps a regression in telegraph code from blocking enemy
  // pool return + spatial-hash removal further down in killEnemy.
  if (enemy.isMiniBoss || enemy.isFinalBoss) {
    try { disposeBossTelegraphs(enemy); } catch (_) {}
  }
  enemy._telegraphInit = false;

  // Paw-poof feedback (final boss is covered by the victory cinematic).
  // Volatile elites skip this standard pass because their charged poof is
  // emitted beside the queued detonation below. Trash uses a compact 0.18s
  // version and a per-second density budget for high-kill-rate salvos.
  if (!enemy.isFinalBoss && !enemy._volatile) {
    if (enemy.elite || enemy.isMiniBoss) {
      spawnKillRing(enemy.mesh.position.x, enemy.mesh.position.z, enemy.elite);
    } else {
      const sec = Math.floor(state.time.game);
      if (sec !== _trashPoofSec) { _trashPoofSec = sec; _trashPoofKills = 0; }
      _trashPoofKills++;
      if (_trashPoofKills <= 10 || (_trashPoofKills & 1) === 0) {
        spawnKillRing(enemy.mesh.position.x, enemy.mesh.position.z, false, { life: 0.18, scale: 0.8 });
      }
    }
  }

  // ── Iter 8 Volatile affix: queue a 0.2s-delayed explosion. We DON'T fire
  // here because damageEnemy(volatile_neighbor) might trigger another Volatile
  // death → another explosion → unbounded recursion. The pendingVolatile queue
  // is drained at the top of updateEnemies on the NEXT frame, so chains span
  // frames (0.2s/link) and stay paused-aware via state.time.game.
  if (enemy._volatile && state.fx && state.fx.pendingVolatile) {
    state.fx.pendingVolatile.push({
      x: enemy.mesh.position.x,
      z: enemy.mesh.position.z,
      t: state.time.game + 0.2,
    });
    // Visual: a single larger paw-shaped charged poof. The actual damaging
    // detonation remains the orange smoke/ember/shockwave burst below.
    spawnKillRing(enemy.mesh.position.x, enemy.mesh.position.z, true);
  }

  // Drops: heart (HP) and star (gem vacuum). Healing-rebalance 2026-05-21
  // (user-authorized): heart frequency ~halved — elite 1.0 → 0.5 (no longer a
  // guaranteed heart on every elite), normal 0.05 → 0.025. A found heart still
  // heals the full 25, just drops "much rarer" per the design intent.
  if (!enemy.isFinalBoss) {
    const heartRoll = enemy.elite ? 0.5 : 0.025;
    if (Math.random() < heartRoll) {
      spawnHeart(enemy.mesh.position.x, enemy.mesh.position.z);
    }
    const starRoll = enemy.elite ? 0.50 : 0.02;
    if (Math.random() < starRoll) {
      spawnStar(enemy.mesh.position.x + (enemy.elite ? 1 : 0), enemy.mesh.position.z);
    }
  }
  // FOREST-V2-A6 — forest stage replaces the slot-machine chest with the
  // 3-option treasure chest (Weapon/Gold/Heal+Passive). Stage-gate keeps
  // non-forest stages on the existing slot-machine path untouched.
  // Forest's owner-managed chest/pickup/weapon roots are overworld-only.
  // Dungeon mobs use generic run-owned drops that catacomb.js tears down.
  const _forestChestStage = !!(state.mode === 'run'
    && state.run && state.run.stage && state.run.stage.id === 'forest');
  // Elites have a chance to drop a chest at their death position
  if (enemy.elite && !enemy.isFinalBoss && !enemy.isMiniBoss && Math.random() < SPAWN.chestEliteDropChance) {
    if (_forestChestStage) dropForestChest(enemy.mesh.position);
    else                   spawnChest(enemy.mesh.position.x, enemy.mesh.position.z);
  }
  // Mini-boss: guaranteed chest + 2 hearts + 1 star + 1 bomb (proper reward).
  if (enemy.isMiniBoss && !enemy._isDungeonBoss) {
    const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;
    if (_forestChestStage) dropForestChest(enemy.mesh.position);
    else                   spawnChest(ex, ez);
    spawnHeart(ex - 1.2, ez);
    spawnHeart(ex + 1.2, ez);
    spawnStar(ex, ez + 1.2);
    spawnBomb(ex, ez - 1.2);
    // Portal Shards (explore objective): a mini-boss death offers up an EARNED
    // shard. Pushed as plain data — no import into this hot death path;
    // tickPortalShards drains the queue and honors it only while shards are
    // still owed (extras are discarded).
    const shardObjectiveEnabled = !(state.modes
      && (state.modes.bossRush || state.modes.daily || state.modes.weekly));
    const forestUsesPortalTrials = !!(state.run && state.run.stage
      && state.run.stage.id === 'forest' && state.run.forestPortalTrials);
    const kakiLandPortalRoute = !!(state.run && state.run.stage
      && state.run.stage.id === 'kakiland');
    if (state.mode === 'run' && shardObjectiveEnabled
        && !forestUsesPortalTrials && !kakiLandPortalRoute && !enemy._isRoomBoss) {
      (state.run._shardDrops || (state.run._shardDrops = [])).push({ x: ex, z: ez });
    }
  }
  // Rare drops from regular kills: bomb 0.1%, freeze 0.5%, chicken 0.1%
  // (chicken halved 0.2%→0.1% in the 2026-05-21 healing rebalance — the
  // full-heal chicken stays iconic but drops "much rarer").
  // Iteration 1: bomb 0.3%→0.1% — floor-bomb screen wipes were 76-98% of all
  // damage dealt, trivializing the weapon game. Thresholds are cumulative, so
  // the freeze/chicken bands shift down to keep their rates unchanged.
  if (!enemy.isFinalBoss && !enemy.isMiniBoss) {
    const r = Math.random();
    if (r < 0.001) spawnBomb(enemy.mesh.position.x, enemy.mesh.position.z);
    else if (r < 0.006) spawnFreeze(enemy.mesh.position.x, enemy.mesh.position.z);
    else if (r < 0.007) spawnChicken(enemy.mesh.position.x, enemy.mesh.position.z);
  }
  // Elites: 8% freeze, 2.5% chicken (chicken halved 5%→2.5%, healing rebalance)
  if (enemy.elite && !enemy.isFinalBoss && !enemy.isMiniBoss) {
    if (Math.random() < 0.08) spawnFreeze(enemy.mesh.position.x, enemy.mesh.position.z);
    if (Math.random() < 0.025) spawnChicken(enemy.mesh.position.x, enemy.mesh.position.z);
  }
  // FOREST-V2-A8 — VS floor pickups (bomb 1% / magnet 2% / chicken 4% gated).
  // One Math.random() roll; chicken HP gate read AT DROP TIME (VS-accurate).
  if (_forestChestStage && !enemy.isFinalBoss) {
    dropForestPickup(enemy.mesh.position, Math.random(),
      state.hero.hp / (state.hero.hpMax || 1));
  }
  // FOREST-V2-A17 — ground weapon drops off miniboss/elite/room-boss kills.
  // Additive with cohort 8 pickups (separate roll inside the module).
  if (_forestChestStage && !enemy.isFinalBoss && !enemy.isNemesis) {
    dropForestWeapon(enemy.mesh.position, enemy);
  }
  // Final boss always drops a chest (player can still grab it after victory
  // anim — fine). Raw: the forest picker's 8-chest pool cap silently no-ops
  // and must never eat the victory reward.
  if (enemy.isFinalBoss) {
    spawnChestRaw(enemy.mesh.position.x + 2, enemy.mesh.position.z);
  }

  // Drop XP gem — value stamped at spawn so it rides the difficulty curve.
  // xp === 0 is an explicit no-drop stamp (trapCorridor AFK-farm guard);
  // undefined/null still falls back to 1.
  if (enemy.xp !== 0) dropGem(enemy.mesh.position, enemy.xp || 1);

  state.run.kills++;
  state.run.noDmgKills = (state.run.noDmgKills || 0) + 1;
  // Multi-kill micro hit-stop (see counters above killEnemy). Real-time
  // clock — hitStop freezes game time, so game-clock windows would wedge.
  const _mkNow = state.time.real;
  if (_mkNow - _multiKillWinStart > 0.10) { _multiKillWinStart = _mkNow; _multiKillCount = 0; }
  if (++_multiKillCount >= 6 && _mkNow >= _multiKillNextEligible) {
    if (state.fx.hitStop < 0.04) state.fx.hitStop = 0.04;
    // 1.5s refractory: marks burst spikes, not steady-state farm. At 0.5s a
    // sustained late-game mow read as recurring frame hitches (~8% dilation).
    _multiKillNextEligible = _mkNow + 1.5;
  }
  // PHASE 4 P4J — telemetry hook. event() is allocation-free (counter bump
  // only); boss_clear fires on miniboss/final/room-boss kills so balance
  // tuning (P4I) can read p50 TTK directly from boss-clear inter-arrival.
  try {
    telemetryEvent('kill');
    if (enemy.isMiniBoss || enemy.isFinalBoss || enemy._isRoomBoss) {
      telemetryEvent('boss_clear');
    }
  } catch (_) {}
  // Codex: bump kill tally for this tier (silently throttled in codex.js).
  try { notifyEnemyKilled(enemy.glbKey); } catch (_) {}
  // Tutorial: 3-kill auto-advance for stage 2.
  try { notifyTutorialEvent('enemyKill'); } catch (_) {}
  // Stage-rule kill hook (e.g. Cinder "Eruption" bonus heart near puddles).
  try { notifyStageEnemyKill(enemy); } catch (_) {}

  // Vampirism passive: heal a small flat amount per kill, capped at level value.
  const vampHpPerKill = state.run.passive_vampHpPerKill || 0;
  if (vampHpPerKill > 0 && state.hero.hp < state.hero.hpMax) {
    state.hero.hp = Math.min(state.hero.hpMax, state.hero.hp + vampHpPerKill);
  }

  // Quest progress hooks — increment hunt/boss counters at the source.
  // Iter 11c — SHOP_TREE Greed tier-3 "Sigil Sense" (+1 per owned level) adds
  // bonus sigils on every mini-boss kill. Read state.run.passive_miniBossSigilBonus
  // (baked by applyMetaUpgrades) and stack additively on the base grant of 1.
  // Final boss grant is intentionally untouched — node text scopes to mini-boss.
  const miniBossSigilBonus = (state.run && state.run.passive_miniBossSigilBonus) || 0;
  try {
    questEvent('kill', { tier: enemy.glbKey });
    if (enemy.isMiniBoss)  { questEvent('miniBoss');  grantSigils(1 + miniBossSigilBonus, 'miniBoss'); }
    if (enemy.isFinalBoss) { questEvent('finalBoss'); grantSigils(5, 'finalBoss'); }
  } catch (_) {}

  // Achievements
  try {
    tryAchievement('first_kill');
    if (enemy.elite) tryAchievement('first_elite');
    if (state.run.kills >= 100) tryAchievement('kills_100');
    // Secret: Flawless — 100 kills this run without taking damage
    if (state.run.flawless && state.run.noDmgKills >= 100) trySecret('pacifist_100');
  } catch (_) {}

  // Secret: lifetime bug kills (explicit family tag; wolves and animated toy
  // enemies also use procAnim but must not count as insects).
  const tier = _tierByGlb[enemy.glbKey];
  if (tier && tier.family === 'bug') {
    try {
      const total = bumpLifetime('bugKills', 1);
      if (total >= 500) trySecret('bug_lord');
    } catch (_) {}
  }

  // Final boss kill = victory (or just a banner in Endless mode)
  if (enemy.isFinalBoss && !state.gameOver) {
    completeFinalBossVictory(enemy.mesh.position.x, enemy.mesh.position.z);
  }

  // Mini-boss tally
  if (enemy.isMiniBoss) {
    state.run.miniBossKills = (state.run.miniBossKills || 0) + 1;
    if (state.run.miniBossKills >= 3) {
      import('./ui.js').then(({ tryAchievement }) => tryAchievement('minibox_x3'));
    }
  }

  // Death presentation. Forest v2 stays in its existing batch slot for the
  // authored 167ms one-shot, while collision/spatial ownership is detached
  // below in this same call. V1 remains the safe immediate-release fallback.
  if (enemy._isSprite && enemy._spriteV2) {
    _playSpriteDeathAndRecycleAnchor(enemy);
  } else if (!enemy._isSprite && enemy.mesh && _corpses.length < CORPSE_POP_CAP) {
    enemy.mesh.visible = true;
    const s = enemy._baseScale || 1;
    enemy.mesh.scale.set(s * 1.25, s * 0.85, s * 1.25);
    _corpses.push({ e: enemy, t: state.time.game + 0.09 });
  } else {
    _releaseEnemyMesh(enemy);
  }

  // Remove from spatial hash
  state.enemies.spatial.remove(enemy);

  // Splice from active list
  const arr = state.enemies.active;
  const i = arr.indexOf(enemy);
  if (i !== -1) {
    const last = arr.length - 1;
    if (i !== last) arr[i] = arr[last];
    arr.pop();
  }

  if (sfx) {
    if (enemy.elite || enemy.isMiniBoss || enemy.isFinalBoss) {
      if (sfx.eliteDeath) sfx.eliteDeath();
    } else if (sfx.enemyDeath) {
      sfx.enemyDeath();
    }
  }
}

// Heavy throttle counter for enemyHurt — 1-in-4 calls actually fire (in
// addition to audio.js's own 30ms gap). Prevents a wall of crit-pings during
// large swarms while keeping per-hit feedback present.
let _enemyHurtCounter = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Damage interface (called by weapons)
// ─────────────────────────────────────────────────────────────────────────────

// A3 — Stacking vulnerability debuff.
// Any weapon/effect can call `applyVulnerability(enemy, mul, duration)` to mark
// `enemy` as taking `mul`× incoming damage for `duration` seconds. Stacking
// rule: highest multiplier wins, longest expiry wins — so a stronger or
// longer-lasting debuff is never clobbered by a weaker/shorter one.
// Mirrors the `_frozenUntil` pattern; checked inside damageEnemy() as a single
// branch (cheap per-tick cost, no allocations).
export function applyVulnerability(enemy, mul, duration) {
  if (!enemy || !enemy.alive) return;
  const now = (state.time && state.time.game) ? state.time.game : 0;
  const m = (typeof mul === 'number' && mul > 1) ? mul : 1;
  const d = (typeof duration === 'number' && duration > 0) ? duration : 0;
  if (m > (enemy._vulnerableMul || 1)) enemy._vulnerableMul = m;
  const expiry = now + d;
  if (expiry > (enemy._vulnerableUntil || 0)) enemy._vulnerableUntil = expiry;
}

export function damageEnemy(enemy, dmg, source) {
  if (!enemy || !enemy.alive) return;
  // Scripted encounter wards are a hard damage gate, not an enormous HP
  // sponge. The Kaki phase director clears this only after priority adds die.
  // Rate-limit the feedback channel so auto-fire cannot hold bloom at 100%.
  if (enemy._encounterInvulnerable) {
    const now = state.time && state.time.game ? state.time.game : 0;
    if (now >= (enemy._encounterWardFxAt || 0)) {
      enemy._encounterWardFxAt = now + 0.18;
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.18);
    }
    return;
  }
  // ── A3 vulnerability debuff ──
  // Single-branch incoming-damage multiplier. Applied FIRST so every downstream
  // multiplier (signature, passive, crit, variance) composes on top of it.
  // Generic hook — any weapon/effect can call applyVulnerability() to feed this.
  if (enemy._vulnerableUntil && state.time.game < enemy._vulnerableUntil) {
    dmg *= enemy._vulnerableMul;
  }
  // ── Iter 7 character signature multipliers ──
  // Phoenix Ember Burst calls in with source='phoenix' and we skip these so the
  // burst stays a flat 200 baseline (and avoids any future recursive surprises).
  if (source !== 'phoenix') {
    // Sniper "Headhunter": +70% above 80% HP, -30% below 20% HP. Was +200%,
    // but routed through the central damageEnemy it hit EVERY weapon and (since
    // swarm trash is struck near full HP) was a near-unconditional global x3 →
    // dominant archetype. x1.7 keeps it the strongest signature without homogenizing.
    if (state.run.signature_executeBonus) {
      const r = enemy.hp / Math.max(1, enemy.hpMax);
      if (r > 0.80) dmg *= 1.7;
      else if (r < 0.20) dmg *= 0.7;
    }
    // Clockwork "Tempo": run-time-scaling damage bonus, capped at +60%.
    if (state.run.signature_tempoBonus) {
      dmg *= (1 + state.run.signature_tempoBonus);
    }
  }
  // ── Iter 11a SHOP_TREE Power tier 1 "Sharpened Edge": outgoing damage mul.
  // Composes AFTER iter-7 signature multipliers, BEFORE iter-8 shield clamp,
  // so a sharpened-edge hit still gets clamped to 1 vs a shielded mob (the
  // shield design is "consume N hits", not "absorb N damage"). Skip phoenix
  // (self-burst flat baseline) and volatile (chain explosion, fixed 35 dmg).
  if (source !== 'phoenix' && source !== 'volatile') {
    // FE-V2 Landmarks (2026-05-17): Moss Shrine grants +5% per shrine, banked
    // into state.run._dmgGlobalBonus. Composes on top of passive_dmg (SHOP_TREE
    // Sharpened Edge) — same skip rules apply (phoenix/volatile bypass).
    dmg *= (state.run.passive_dmg || 1) * (1 + (state.run._dmgGlobalBonus || 0));
    // Iter 2 — perfect-dodge pulse: hero.js arms state.run.perfectDodgeUntil
    // when a hit is absorbed by DASH i-frames. Same skip rules as passive_dmg.
    if (state.run.perfectDodgeUntil && state.time.game < state.run.perfectDodgeUntil) {
      dmg *= DASH.perfectDodge.dmgMul;
    }
  }
  // ── Iter 8 Shielded affix: clamp incoming dmg to 1 until shield depleted ──
  // Sits BETWEEN iter-7 multipliers (which scale the raw weapon dmg upward) and
  // the crit/variance roll below — so a Sniper Headhunter shot vs. a shielded
  // wizard still ticks the shield by 1, regardless of the executeBonus multiplier.
  // Crit/variance jitter past the clamp is intentional (a shielded crit shows ~1.4 dmg).
  if (enemy._shieldHp && enemy._shieldHp > 0) {
    enemy._shieldHp -= 1;
    if (dmg > 1) dmg = 1;
    if (enemy._shieldHp <= 0) {
      enemy._shieldHp = 0;
      enemy._shieldedRim = false;   // 8c reads this for the gold-rim flicker
    }
  }
  // Variance + crit rolls (DoT skips crit by passing dmg with isDoT flag in future)
  const variance = 1 + (Math.random() - 0.5) * 2 * DAMAGE.variance;
  // Iter 11a SHOP_TREE Power tier 3 "Critical Eye" folds additively into the
  // base 8% crit chance — single roll keeps isCrit semantics consistent for the
  // damage-number tier ('crit'), shake bump, and longer flash duration below.
  // Skip phoenix so the Ember Burst stays a deterministic flat 200 baseline.
  const critChance = DAMAGE.critChance + (source !== 'phoenix' ? (state.run.passive_critChance || 0) : 0);
  const isCrit = Math.random() < critChance;
  // Frostbloom freeze (and Sigil Bell stun): frozen enemies take +25% damage.
  const frozenMul = (enemy._frozenUntil && state.time.game < enemy._frozenUntil) ? 1.25 : 1;
  // Berserk passive: damage scales with hero's missing HP.
  const berserkMax = state.run.passive_berserkMax || 0;
  const hpPct = state.hero.hpMax > 0 ? state.hero.hp / state.hero.hpMax : 1;
  const berserkMul = berserkMax > 0 ? (1 + berserkMax * Math.max(0, 1 - hpPct)) : 1;
  const finalDmg = dmg * variance * (isCrit ? DAMAGE.critMul : 1) * frozenMul * berserkMul;
  // Tallies use APPLIED damage (capped at HP removed) — overkill must not
  // inflate the death-screen breakdown or DPS panel (a 9999 trap hit on a
  // 10hp ant used to log 9999 and dwarf every real weapon). The floating
  // damage number keeps the raw roll — overkill juice is intentional there.
  const _hpBefore = enemy.hp;
  const encounterFloor = (enemy._encounterDamageFloorHp > 0)
    ? Math.min(enemy.hpMax || enemy._encounterDamageFloorHp, enemy._encounterDamageFloorHp)
    : 0;
  enemy.hp = Math.max(encounterFloor, enemy.hp - finalDmg);
  // Arm immunity synchronously on the threshold hit. Several weapons can
  // resolve in the same frame; without this, every later hit would replay FX
  // against a floor-clamped boss before the phase director's next tick.
  if (encounterFloor > 0 && enemy.hp <= encounterFloor + 1e-6) {
    enemy._encounterFloorReached = true;
    enemy._encounterInvulnerable = true;
  }
  const appliedDmg = Math.min(finalDmg, Math.max(0, _hpBefore));
  // ── Iter 8 Vampiric affix: heal a % of the damage you just took, capped at hpMax.
  // Runs BEFORE the kill check so a chip-damage tick can't slip through and kill
  // a vampiric mob that should have healed back up.
  if (enemy._vampPct && enemy._vampPct > 0 && enemy.hp > 0) {
    enemy.hp = Math.min(enemy.hpMax, enemy.hp + finalDmg * enemy._vampPct);
  }
  state.run.dmgDealt += appliedDmg;
  recordDps(state.run._dpsWin, state.time.game, appliedDmg);
  // Per-source damage tally (drives the death-screen breakdown).
  const src = source || enemy._dmgSource || 'other';
  if (!state.run.dmgByWeapon) state.run.dmgByWeapon = {};
  state.run.dmgByWeapon[src] = (state.run.dmgByWeapon[src] || 0) + appliedDmg;
  spawnDamageNumber(enemy.mesh.position, finalDmg, isCrit);

  // Sprite FX: hit-flash on every applied-damage hit. Pool bypasses when
  // state.run.lowFx is set (bypassWhenLowFx flag at pool init). Returns -1
  // if atlas not loaded yet — safe no-op. try/catch so a sprite fault
  // never blocks the enemy update tick. STATIC import only (see top-of-file).
  try {
    spawnSprite('fx/hit_flash_v1', {
      x: enemy.mesh.position.x,
      y: enemy.mesh.position.y + 0.8,
      z: enemy.mesh.position.z,
      scale: 0.7,
      anim: 'default',
    });
  } catch (_) {}

  // ── Iter 24a/b/c: hit-feel pipeline ──
  //
  // Goal: every hit should READ — flash, spark, knock, sound. The intent
  // is to make level-1 trash combat feel like contact, not "stuff dissolving
  // near my character". Weighting:
  //   • dmgFrac = finalDmg / hpMax (0..1+) → how much this hit MATTERS
  //   • heavy   = dmgFrac >= 0.10 (10% maxHP) OR isCrit
  //   • huge    = dmgFrac >= 0.40 (40% maxHP)
  //
  // Per-tick continuous sources (orbitals, DoT, web, volatile chain) are
  // gated OUT of the heavy pipeline so they don't strobe/lock the screen.
  const hpFrac = enemy.hpMax > 0 ? finalDmg / enemy.hpMax : 0;
  const dmgFracClamped = Math.min(1.5, hpFrac);
  const willKill = enemy.hp <= 0;
  const heavy = (isCrit || dmgFracClamped >= 0.10);
  const huge = dmgFracClamped >= 0.40;
  // Continuous per-tick damage sources — skip the per-hit pipeline since they
  // resolve every frame and would saturate. They still spawn damage numbers
  // and apply hp, just without flash extension / knock / hit-pause / burst.
  //   • 'orbitals'   — base orbital burger ticking at hit cooldown
  //   • 'toxic_halo' — evolved orbitals poison DoT (per-frame in enemies.js:930)
  //   • 'sanctum'    — Sticky Web burning patch DoT (weapons/web.js:129)
  //   • 'web'        — generic web slow contact damage (defensive — current
  //                    web slow is non-damaging, but reserved)
  //   • 'volatile'   — Volatile-affix chain explosion (already AoE'd)
  //   • 'phoenix'    — Ember Burst self-damage AoE (one-shot, fine)
  //   • 'dash'       — hero dash hits, already self-juiced by dash impulse
  const isTickSource = (source === 'orbitals' || source === 'toxic_halo' ||
                       source === 'sanctum'  || source === 'web' ||
                       source === 'volatile' || source === 'phoenix' ||
                       source === 'dash');

  // Hit-flash duration: scales modestly with damage. Crit gets the longest
  // window so the player can SEE the crit landed even mid-swarm. Capped so a
  // huge oneshot doesn't leave the body glowing for half a second.
  const flashDur = isCrit ? 0.18 : (heavy ? 0.14 : 0.09);
  // Extend (never shorten) the flash window — multi-source hits stack readably.
  const flashEndCandidate = state.time.game + flashDur;
  if (flashEndCandidate > (enemy._flashUntil || 0)) enemy._flashUntil = flashEndCandidate;
  if (enemy._spriteV2 && enemy._spriteSlot >= 0) {
    triggerEnemySpriteHit(enemy._spriteAtlasId, enemy._spriteSlot);
  }

  // Knockback: only for "heavy" non-tick hits. Direction = from hero outward
  // (most weapons fire from the hero). Additive (`+=`) so a dash impulse on
  // the same frame doesn't get overwritten by a damage tick. Cap final knock
  // velocity so a flurry of crits doesn't fling enemies into next zip code.
  if (heavy && !isTickSource) {
    const hp = state.hero && state.hero.pos;
    if (hp) {
      let dx = enemy.mesh.position.x - hp.x;
      let dz = enemy.mesh.position.z - hp.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-3) {
        const inv = 1 / len;
        dx *= inv; dz *= inv;
        // Impulse magnitude scales with dmg fraction (clamped 0.10..1.0).
        // Range: 2.5..7.5 u/s. Iter 13 decay loop (line ~1005) kills these
        // off in ~3-4 frames — reads as a jolt, not a punt.
        const impulse = 2.5 + Math.min(1.0, dmgFracClamped) * 5.0;
        enemy.knockVx += dx * impulse;
        enemy.knockVz += dz * impulse;
        // Cap so layered hits don't unboundedly accumulate
        const KCAP = 12;
        if (enemy.knockVx >  KCAP) enemy.knockVx =  KCAP;
        if (enemy.knockVx < -KCAP) enemy.knockVx = -KCAP;
        if (enemy.knockVz >  KCAP) enemy.knockVz =  KCAP;
        if (enemy.knockVz < -KCAP) enemy.knockVz = -KCAP;
      }
    }
  }

  // Impact sparks — heavy hits get a small burst at the contact point.
  // Color follows damage type (crit = pink, huge = warm-red, normal = ember).
  // Skip tick sources (would strobe). Killing blows spark too (iteration 1 —
  // suppressing them made lethal hits the LEAST juiced hit of all).
  if (heavy && !isTickSource) {
    const burstColor = isCrit ? 0xff9ad6 : (huge ? 0xff7544 : 0xffb14a);
    const burstY = (enemy.mesh.position.y || 0) + 0.6;
    try {
      spawnImpactBurst(
        enemy.mesh.position.x, burstY, enemy.mesh.position.z,
        burstColor,
        Math.min(1, 0.4 + dmgFracClamped),
      );
    } catch (_) {}
  }

  // SFX with damage-scaled gain. Throttle still drops layered calls inside
  // the 30ms window — the gain that lands is whichever call won the race.
  // Heavy hits piggyback on `sfx.hit` (the meatier sample) so they stand out
  // from the ambient enemyHurt stream.
  if (sfx) {
    // The light enemyHurt chatter still runs on its 1-in-4 counter to avoid
    // swarm machine-gunning. Gain scales 0.18..0.45 across the dmg range.
    if ((++_enemyHurtCounter & 3) === 0 && sfx.enemyHurt) {
      const g = 0.18 + Math.min(0.27, dmgFracClamped * 0.5);
      sfx.enemyHurt({ gain: g });
    }
    // Heavy / crit gets the punchier `hit` bucket on top so the player HEARS
    // big hits land. Bypasses the enemyHurt counter — heavy hits are rarer.
    // Skip on the kill blow — enemyDeath/eliteDeath play below and stacking
    // hit + death same-frame muddles the death moment.
    if (heavy && sfx.hit && !isTickSource && !willKill) {
      const g = 0.32 + Math.min(0.40, dmgFracClamped * 0.55);
      // Slight pitch drop on huge hits so they feel weighty (rate=0.92 == ~-1.5 semitones).
      const rate = huge ? 0.92 : 1.0;
      sfx.hit({ gain: g, rate });
    }
    // Crit accent — a distinct high "ching" over the hit sample so a crit is
    // audible, not just visible (pink spark). Fires from ANY source (incl. the
    // always-on starter orbitals) so crits are never silent; sfx.crit has its
    // own 90ms debounce so a swarm can't turn it into a solid tone.
    if (isCrit && sfx.crit) {
      sfx.crit();
    }
  }

  // Shake — scales with damage. Per-frame cap (0.45) keeps swarm hits from
  // saturating the camera. Crit floor preserved from prior behavior.
  if (heavy) {
    const shakeAmt = 0.10 + Math.min(0.35, dmgFracClamped * 0.45);
    if (state.fx.shake < shakeAmt) state.fx.shake = shakeAmt;
  } else if (isCrit) {
    if (state.fx.shake < 0.20) state.fx.shake = 0.20;
  }

  // Hit-pause — micro-freeze on huge non-tick hits. Cross-frame eligibility
  // gate prevents orbitals/autoaim from re-triggering every frame and locking
  // the world. Only consumes the existing `state.fx.hitStop` field which
  // main.js already reads at L927 and L1069 — NO main.js change required.
  if (huge && !isTickSource && !willKill) {
    const now = state.time.real;
    if (now >= (state.fx._hitPauseNextEligible || 0)) {
      const dur = 0.05 + Math.min(0.04, dmgFracClamped * 0.04);   // 50..90ms
      if (state.fx.hitStop < dur) state.fx.hitStop = dur;
      state.fx._hitPauseNextEligible = now + 0.22;   // 220ms gap floor
    }
  }

  if (enemy.hp <= 0) {
    // Kill hit-stop + shake are RESERVED for elites/bosses. Trash kills get
    // neither: in a swarm you kill ~20-30 trash/sec, and main.js freezes the
    // world (logicDt=0) while state.fx.hitStop>0 — a 40ms freeze on every trash
    // kill keeps the world frozen most of the time, which reads as a per-hit
    // fps STUTTER, not impact weight. The shake was already omitted here for the
    // same swarm reason; the freeze had been left in, which was the real cause.
    // Big kills are rare enough that the freeze stays a satisfying punctuation.
    const bigKill = enemy.elite || enemy.isMiniBoss || enemy.isFinalBoss;
    if (bigKill) {
      const stopDur = enemy.isFinalBoss ? 0.16 : (enemy.isMiniBoss ? 0.14 : 0.12);
      if (state.fx.hitStop < stopDur) state.fx.hitStop = stopDur;
      if (state.fx.shake < 0.40) state.fx.shake = 0.40;
    }
    killEnemy(enemy);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Release all pending death-pop corpses immediately. Called from run teardown
// (main.js) — without it, enemies killed in a run's final ~90ms stay visible
// as frozen ghost meshes through town/menu and hold slots from the cap.
export function flushCorpses() {
  for (let ci = _corpses.length - 1; ci >= 0; ci--) {
    _releaseEnemyMesh(_corpses[ci].e);
  }
  _corpses.length = 0;
  // Run teardown has already released every active enemy. Catch any detached
  // v2 death one-shots and any legacy loop whose logical owner disappeared.
  releaseAllSprites(FOREST_ENEMY_ATLAS_ID);
  releaseAllSprites(V1_ENEMY_ATLAS_ID);
}

// Per-frame update
// ─────────────────────────────────────────────────────────────────────────────
export function updateEnemies(dt) {
  const heroPos = state.hero.pos;
  const active = state.enemies.active;
  const spatial = state.enemies.spatial;
  // iter 33n — hoist per-frame constants (was recomputed inside loop branches).
  const _now = state.time.game;
  const _knockDecay = Math.pow(0.0008, dt);

  // ── Facetank pressure: camping = no movement INTENT for 4s. Keyed off
  // hero velocity (zeroed when idle), not net displacement — stutter-step
  // orbiting and a pinned-but-trying player must never read as camping.
  // _campMul lerps in/out over ~0.6s so the horde never visibly snaps speed
  // the frame the player taps a key (rubber-band feel).
  // `_now < _campMoveT` guards a game-clock reset (run restart).
  {
    const hv = state.hero.vel;
    const moving = hv && (Math.abs(hv.x) + Math.abs(hv.z)) > 0.5;
    if (moving || _now < _campMoveT) _campMoveT = _now;
    _heroCamping = (_now - _campMoveT) > 4;
    const _campTarget = _heroCamping ? 1.25 : 1.0;
    _campMul += (_campTarget - _campMul) * Math.min(1, dt * 2.5);
  }

  // Drain death-pop corpses whose ~90ms linger expired (see killEnemy tail).
  // Deadline >0.2s in the future is impossible (linger is 0.09s) — means the
  // game clock reset under us (run restart); release instead of wedging the
  // mesh visible until the NEW run's clock passes the OLD run's timestamp.
  for (let ci = _corpses.length - 1; ci >= 0; ci--) {
    if (_now < _corpses[ci].t && _corpses[ci].t - _now <= 0.2) continue;
    _releaseEnemyMesh(_corpses[ci].e);
    const _cl = _corpses.length - 1;
    if (ci !== _cl) _corpses[ci] = _corpses[_cl];
    _corpses.pop();
  }

  // ⚡ Bolt: Hoisted deep property accesses and array lengths out of the O(N) active enemy loop
  // to avoid repeated M-length evaluations, keeping loop fast for 16.6ms frame budget.
  const _webs = (state && state.webs && state.webs.list) ? state.webs.list : null;
  const _websLen = _webs ? _webs.length : 0;

  const _fzones = (state && state.run && state.run.forestSlowZones) ? state.run.forestSlowZones : null;
  const _fzonesLen = _fzones ? _fzones.length : 0;

  const _tzones = (state && state.run && state.run.twilightSlowZones) ? state.run.twilightSlowZones : null;
  const _tzonesLen = _tzones ? _tzones.length : 0;

  const _czones = (state && state.run && state.run.cinderSlowZones) ? state.run.cinderSlowZones : null;
  const _czonesLen = _czones ? _czones.length : 0;

  const _ruleSlow = (state && state.run && state.run.stageRuleEnemySlow) ? state.run.stageRuleEnemySlow : 1;

  // ── Iter 8: drain queued Volatile explosions (entries whose t <= now).
  // Done BEFORE the main loop so the active set is stable while we iterate.
  // damageEnemy → killEnemy → push new entry is fine (next frame at earliest).
  const pv = state.fx && state.fx.pendingVolatile;
  if (pv && pv.length > 0) {
    const now = _now;
    // Walk backwards so swap-pop is safe.
    for (let pi = pv.length - 1; pi >= 0; pi--) {
      const v = pv[pi];
      if (v.t > now) continue;
      // Radius 4u, 35 flat dmg, source 'volatile' (avoids signature multipliers).
      const _vpos = _tmpPush.set(v.x, 0, v.z);   // reuse temp vec
      const hits = state.enemies.spatial ? state.enemies.spatial.queryRadius(_vpos, 4) : [];
      for (let hi = 0; hi < hits.length; hi++) {
        damageEnemy(hits[hi], 35, 'volatile');
      }
      // Hero damage if hero inside the explosion radius.
      const dxh = heroPos.x - v.x;
      const dzh = heroPos.z - v.z;
      if (dxh * dxh + dzh * dzh <= 16) {
        try { heroTakeDamage(35); } catch (_) {}
      }
      // Visual: full bomb-style explosion (smoke + embers + flashstar +
      // shockwave layered, ~0.5s total). Hellfire amber tint so it reads
      // as "volatile detonation" distinct from the cool paw poof.
      try { burstExplosion(v.x, v.z, 4.0, 0xff7a28); } catch (_) {}
      // Audio + camera punch — light feedback so the explosion reads.
      if (sfx && sfx.eliteDeath) sfx.eliteDeath();
      state.fx.shake = Math.max(state.fx.shake || 0, 0.35);
      // swap-pop
      const last = pv.length - 1;
      if (pi !== last) pv[pi] = pv[last];
      pv.pop();
    }
  }

  // ── Iter 8: reset Frosted aura slow each frame. Set to 0.75 below if ANY
  // _frostAura enemy is within range. hero.js currently does NOT read this
  // (flagged as a divergence in the agent report).
  state.run.affix_frostSlow = 1;

  // ── FE-C3A — Forest room-scope despawn ───────────────────────────────────
  // When the hero changes Forest rooms, any standard enemy whose room tag
  // disagrees with the hero's current room AND is >60u away gets silently
  // pool-returned. Bosses, mini-bosses and the Nemesis are exempt so a
  // mid-fight teleport doesn't lose the boss. Non-Forest stages skip the
  // entire block so other stages pay zero cost.
  const _stageId = state.run && state.run.stage && state.run.stage.id;
  if (_stageId === 'forest') {
    const _curRoom = (state.run && state.run.currentRoom) || 'glade';
    // 60u² to avoid sqrt; bounds check uses distance to HERO, not room
    // boundary, per spec ("distance from current player > 60u").
    const ROOM_DESPAWN_R2 = 60 * 60;
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      if (!e.alive) continue;
      if (e.isFinalBoss || e.isMiniBoss || e.isNemesis) continue;
      if (!e.room || e.room === _curRoom) continue;
      const ep = e.mesh && e.mesh.position;
      if (!ep) continue;
      const dx = ep.x - heroPos.x;
      const dz = ep.z - heroPos.z;
      if (dx * dx + dz * dz <= ROOM_DESPAWN_R2) continue;
      // Silent pool-return. Mirrors killEnemy's tail (lines ~899-907): hide
      // mesh, push to pool, remove from spatial + active. NO drops, NO SFX,
      // NO banner — this is a quiet retirement, not a death.
      e.alive = false;
      // Sprite slot or GLB mesh recycling (sprite anchors must NOT enter a GLB
      // pool — _releaseEnemyMesh routes by e._isSprite). Nemesis mesh is
      // exempted from pooling inside the helper.
      _releaseEnemyMesh(e);
      try { state.enemies.spatial.remove(e); } catch (_) {}
      // swap-pop (active is the live array; safe because we walk backwards)
      const _last = active.length - 1;
      if (i !== _last) active[i] = active[_last];
      active.pop();
    }
  }

  // Iterate backwards so killEnemy splices are safe (it uses swap-pop too,
  // but backward iteration plays nicest with any future direct splicing).
  for (let i = active.length - 1; i >= 0; i--) {
    const e = active[i];
    if (!e.alive) continue;

    const ep = e.mesh.position;
    const spriteFromX = ep.x;
    const spriteFromZ = ep.z;
    if (!e._isSprite) {
      // ── Animation mixer ──
      const mixer = e.mesh.userData && e.mesh.userData.mixer;
      if (mixer) mixer.update(dt);
    }

    // ── Procedural animation (only if no GLB clip is playing) ──
    if (e.procAnim && !e._isSprite && !(e.mesh.userData && e.mesh.userData.hasClip)) {
      e._animPhase += dt;
      _applyProcAnim(e);
      e.mesh.userData?.creatureAnimationController?.updateTime(e._animPhase);
    }

    // ── Damage flash: edge-triggered TSL controller ──
    const flashController = e.mesh.userData?.damageFlashController;
    if (flashController) {
      const isFlashing = e._flashUntil && _now < e._flashUntil;
      if (isFlashing !== e._wasFlashing) {
        flashController.setFlashing(isFlashing);
        e._wasFlashing = isFlashing;
      }
    } else if (e._isSprite && e._spriteSlot >= 0) {
      // Billboard parity (CC4): the sprite atlas has no per-mesh emissive, so
      // flash the instance white via the pool's per-instance aFlash attribute.
      // Edge-triggered exactly like the 3D path above — one write per flash
      // transition, so the no-hit case stays zero-cost. Strength < 1 keeps the
      // silhouette legible mid-swarm (the one blind-tune knob; nudge here).
      const isFlashing = e._flashUntil && _now < e._flashUntil;
      if (isFlashing !== e._wasFlashing) {
        try { setSpriteFlash(e._spriteAtlasId || V1_ENEMY_ATLAS_ID, e._spriteSlot, isFlashing ? SPRITE_FLASH_STRENGTH : 0); } catch (_) {}
        e._wasFlashing = isFlashing;
      }
    }

    // A held Pipes target is positioned by the signature weapon after this
    // update. Suspend seek, ranged fire, affix movement, separation and contact
    // while preserving animation, hit flash and DoT. The short expiry is a
    // fail-safe: if the weapon stops ticking unexpectedly, normal AI resumes.
    const combatControl = e._combatControl;
    if (combatControl && combatControl.until && _now > combatControl.until) {
      e._combatControl = null;
    }
    const combatControlled = !!(e._combatControl && e._combatControl.kind === 'pipes-hook');

    if (!combatControlled) {
      // ── Seek hero ──
      _tmpDir.set(heroPos.x - ep.x, 0, heroPos.z - ep.z);
      const distSq = _tmpDir.x * _tmpDir.x + _tmpDir.z * _tmpDir.z;

    // ── Web slow check ──
    let slow = 1;
    for (let w = 0; w < _websLen; w++) {
      const W = _webs[w];
      if (W.ttl <= 0) continue;
      const wdx = ep.x - W.x, wdz = ep.z - W.z;
      if (wdx * wdx + wdz * wdz <= W.radius * W.radius) {
        if (W.slowMul < slow) slow = W.slowMul;
      }
    }
    // Forest chokepoint slow-zones (swarm Phase 3) — same shape as webs.
    // Zones are derived from amber hotspots in stageHazards.loadForestHazards
    // and published to state.run.forestSlowZones so this loop can read without
    // an import cycle. Short-circuit when not forest so other stages pay zero
    // cost. r² is precomputed; mul=0.55 funnels swarms into single-file lines
    // through the cluster gaps.
    if (_fzonesLen > 0) {
      for (let z = 0; z < _fzonesLen; z++) {
        const Z = _fzones[z];
        const zdx = ep.x - Z.x, zdz = ep.z - Z.z;
        if (zdx * zdx + zdz * zdz <= Z.r2) {
          if (Z.mul < slow) slow = Z.mul;
        }
      }
    }
    // Twilight hedge-corridor slow-zones (swarm Phase 3) — same shape as forest.
    // Derived from hedge midpoints in stageHazards.loadTwilightHazards and
    // published to state.run.twilightSlowZones. Short-circuit when not twilight
    // so other stages pay zero cost. mul=0.65 funnels swarms through gaps.
    if (_tzonesLen > 0) {
      for (let z = 0; z < _tzonesLen; z++) {
        const Z = _tzones[z];
        const zdx = ep.x - Z.x, zdz = ep.z - Z.z;
        if (zdx * zdx + zdz * zdz <= Z.r2) {
          if (Z.mul < slow) slow = Z.mul;
        }
      }
    }
    // Cinder catapult slow-zones (swarm Phase 3) — same shape as twilight.
    // Derived from catapult positions in stageHazards.loadCinderHazards and
    // published to state.run.cinderSlowZones. Short-circuit when not cinder
    // so other stages pay zero cost. mul=0.7 funnels swarms around the
    // wreckage (figure-eight kiting per docs/CINDER_VISUAL_STYLE.md).
    if (_czonesLen > 0) {
      for (let z = 0; z < _czonesLen; z++) {
        const Z = _czones[z];
        const zdx = ep.x - Z.x, zdz = ep.z - Z.z;
        if (zdx * zdx + zdz * zdz <= Z.r2) {
          if (Z.mul < slow) slow = Z.mul;
        }
      }
    }
    // Stage-rule global slow (Forest "Overgrowth" spore pulse).
    if (_ruleSlow < slow) slow = _ruleSlow;
    e.slowMul = slow;

    // ── Frost / stun: restore spd when freeze expires (Frostbloom + Sigil Bell) ──
    if (e._frozenUntil) {
      if (_now >= e._frozenUntil) {
        if (e._frozenWasSpd !== undefined) {
          e.spd = e._frozenWasSpd;
          e._frozenWasSpd = undefined;
        }
        e._frozenUntil = 0;
      }
    }

      if (distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const inv = 1 / dist;
        const dx = _tmpDir.x * inv;
        const dz = _tmpDir.z * inv;

      // Ranged AI: stop at `stopAt`, fire on cooldown when within `range`.
      const r = e.ranged;
      let walkScale = 1;
      if (r) {
        e.rangedCD -= dt * slow;
        if (dist <= r.range) {
          if (dist <= r.stopAt) {
            walkScale = -0.3;            // gentle backpedal so we don't get melee'd
          } else {
            walkScale = 0;               // hold position to cast
          }
          if (e.rangedCD <= 0) {
            e.rangedCD = r.cooldown;
            if (e._spriteV2 && e._spriteSlot >= 0) {
              setEnemySpriteState(e._spriteAtlasId, e._spriteSlot, ENEMY_SPRITE_STATE.ATTACK, true);
            }
            // Iter 2 threat depth — lead aim + difficulty-gated fan.
            // `r` is the SHARED tier config object: read-only, never mutate.
            // Lead: aim at heroPos + lead × hero velocity (hero.js stamps
            // state.hero.vel every frame, zeroed when idle) so straight-line
            // running eats the bolt and changing direction is the dodge.
            let ax = dx, az = dz;
            if (r.lead) {
              const hv = state.hero.vel;
              const lx = (heroPos.x + hv.x * r.lead) - ep.x;
              const lz = (heroPos.z + hv.z * r.lead) - ep.z;
              const lm = Math.sqrt(lx * lx + lz * lz);
              if (lm > 1e-4) { ax = lx / lm; az = lz / lm; }
            }
            const isRing = r.pattern === 'ring' && r.patternCount > 1;
            const fanN = isRing
              ? r.patternCount
              : ((r.fanAt && r.fanCount > 1 && _computeDifficulty(_now) >= r.fanAt)
                ? r.fanCount : 1);
            const bDmg = r.projDmg * (e._rampDmg || 1);
            for (let b = 0; b < fanN; b++) {
              let bx, bz;
              if (isRing) {
                const a = e._patternPhase + (b / fanN) * Math.PI * 2;
                bx = Math.cos(a);
                bz = Math.sin(a);
              } else {
                const off = (b - (fanN - 1) / 2) * (r.fanSpread || 0);
                const ca = Math.cos(off), sa = Math.sin(off);
                bx = ax * ca - az * sa;
                bz = ax * sa + az * ca;
              }
              // Fire from chest height; spawn slightly forward along each bolt
              // path. kind comes from the tier's ranged config (wasp 'fire')
              // so mixed shooters stay visually triageable; default 'magic'.
              spawnEnemyProjectile(
                ep.x + bx * 0.6,
                1.0,
                ep.z + bz * 0.6,
                bDmg, r.projSpeed, r.projTtl,
                r.kind || 'magic', bx, bz,
              );
            }
            if (isRing) e._patternPhase = (e._patternPhase + (r.patternSpin || 0)) % (Math.PI * 2);
          }
        }
      }

      // Walk (scaled by slow + rangedAI behavior + Cursed Bell enrage).
      // _flee inverts the seek direction (used by Treasure Goblin mini-event).
      const enrage = (e._enrageUntil && _now < e._enrageUntil) ? 1.5 : 1.0;
      // Facetank pressure: camping hero → swarm-in speed (lerped _campMul,
      // up to 1.25). ONLY on closing vectors: a fleeing goblin or a ranged
      // backpedal (walkScale<0) speeding up would punish standing still to
      // shoot — the inverse of the intent. Clamped so the stack with Cursed
      // Bell enrage (1.5×) can never exceed 1.9× total.
      let spdMul = enrage;
      if (!e._flee && walkScale > 0) {
        spdMul *= _campMul;
        if (spdMul > 1.9) spdMul = 1.9;
      }
      const fleeMul = e._flee ? -1 : 1;
      const step = e.spd * slow * spdMul * dt * walkScale * fleeMul;
      ep.x += dx * step;
      ep.z += dz * step;

        // Face hero (XZ angle). Three.js: rotation.y of 0 looks down +Z;
        // atan2(x,z) is the standard "face this vector" formula.
        e.mesh.rotation.y = Math.atan2(dx, dz) + (e.faceYaw || 0);
      }
    }

    // ── Poison DoT (Toxic Halo, bleed, spore, signature DoTs) ──
    // Accumulate and resolve in DOT_TICK chunks rather than dps*dt every frame.
    // damageEnemy spawns a floating number + hit-flash on EVERY call, so a
    // per-frame DoT floods the 48-slot number pool (starving real weapon/crit
    // numbers) and streams rounded-to-'0' garbage. Chunking preserves total
    // damage (dps * DOT_TICK per fire) so TTK is unchanged within one tick.
    if (e._dotUntil && _now < e._dotUntil) {
      e._dotAcc = (e._dotAcc || 0) + dt;
      if (e._dotAcc >= DOT_TICK) {
        const dps = e._dotDps || 0;
        // while-loop catches large dt (e.g. tab refocus) so we never under-apply.
        while (e._dotAcc >= DOT_TICK) {
          e._dotAcc -= DOT_TICK;
          damageEnemy(e, dps * DOT_TICK, e._dotSource || 'orbitals');
          if (!e.alive) break;
        }
        if (!e.alive) continue;
      }
    } else if (e._dotAcc) {
      e._dotAcc = 0;   // DoT expired / none active — reset so pooled reuse starts clean
    }

    if (combatControlled) {
      // Weapon tick writes the controlled position and calls the same guarded
      // spatial move again later this frame. Keeping the current cell valid
      // here protects projectiles during zero-dt/hit-stop frames.
      spatial.move(e);
      _syncEnemySprite(e, spriteFromX, spriteFromZ, dt);
      continue;
    }

    // Static destructibles (totems, pylons, bells) skip movement + contact;
    // their own tickers handle behavior. DoT/flash above still applies.
    if (e.isTotem || e.isPylon || e.isBell) {
      _syncEnemySprite(e, spriteFromX, spriteFromZ, dt);
      continue;
    }

    // ── Iter 8 affix per-frame readers (early-out: only touch enemies
    // whose affix slots are actually set; the vast majority of swarm trash
    // skips this block entirely).
    if (e.affixes) {
      // Frosted aura: if hero is within _frostAura units, stamp the per-frame
      // slow on state.run. Reset to 1 at top of updateEnemies above.
      if (e._frostAura) {
        const fdx = heroPos.x - ep.x;
        const fdz = heroPos.z - ep.z;
        if (fdx * fdx + fdz * fdz <= e._frostAura * e._frostAura) {
          state.run.affix_frostSlow = 0.75;
        }
      }
      // Leaping: 4s cycle. Tick CD down; when ≤ 0, capture target hero pos and
      // start a 0.6s windup. When windup completes, translate enemy by 8u toward
      // captured target and reset CD. Dash-cancellable because the hero has time
      // to relocate during the windup — the lock is at TELL start, not landing.
      if (typeof e._leapCD === 'number') {
        if (e._leapWindup > 0) {
          e._leapWindup -= dt;
          if (e._leapWindup <= 0) {
            // Resolve leap: move 8u toward captured target (clamped to leap len).
            const ldx = (e._leapTargetX !== undefined ? e._leapTargetX : heroPos.x) - ep.x;
            const ldz = (e._leapTargetZ !== undefined ? e._leapTargetZ : heroPos.z) - ep.z;
            const lmag = Math.sqrt(ldx * ldx + ldz * ldz);
            if (lmag > 1e-4) {
              const k = Math.min(8, lmag) / lmag;
              ep.x += ldx * k;
              ep.z += ldz * k;
            }
            // Iter 10b — leap resolved; release the landing-zone marker.
            try { clearLeapMarker(e); } catch (_) {}
            e._leapWindup = 0;
            e._leapCD = 4.0;
            e._leapTargetX = undefined;
            e._leapTargetZ = undefined;
          } else {
            // Iter 10b — refresh the marker each tick so the per-frame prune
            // in updateEnemyTells doesn't sweep it. setLeapMarker scales the
            // ring as windup remaining → 0 (grows = "about to land").
            try {
              setLeapMarker(
                e._leapTargetX !== undefined ? e._leapTargetX : heroPos.x,
                e._leapTargetZ !== undefined ? e._leapTargetZ : heroPos.z,
                e._leapWindup,
                0.6,
                e,
              );
            } catch (_) {}
          }
        } else {
          e._leapCD -= dt;
          if (e._leapCD <= 0) {
            // Begin windup — capture hero pos NOW so the player can dodge
            // by leaving the marked landing zone during the 0.6s tell.
            e._leapWindup = 0.6;
            e._leapTargetX = heroPos.x;
            e._leapTargetZ = heroPos.z;
            // Iter 10b — paint the marker at full windup (small scale, will
            // grow toward landing).
            try { setLeapMarker(heroPos.x, heroPos.z, 0.6, 0.6, e); } catch (_) {}
          }
        }
      }
    }

    // ── Knockback velocity (from dash, etc.) — additive on top of walk ──
    if (e.knockVx !== 0 || e.knockVz !== 0) {
      ep.x += e.knockVx * dt;
      ep.z += e.knockVz * dt;
      // Exponential decay (fast — ~85% per frame at 60fps).
      // iter 33n — _knockDecay hoisted to once-per-frame at top of updateEnemies.
      e.knockVx *= _knockDecay;
      e.knockVz *= _knockDecay;
      if (Math.abs(e.knockVx) < 0.05) e.knockVx = 0;
      if (Math.abs(e.knockVz) < 0.05) e.knockVz = 0;
    }

    // ── Light separation ──
    // Query a small radius and push apart from up to 3 nearest neighbors.
    // iter 33n — queryRadiusInto reuses _sepBuf instead of allocating a fresh
    // array per enemy per frame (~N allocs/frame eliminated at high counts).
    const neighbors = spatial.queryRadiusInto(ep, SEPARATION_DIST, _sepBuf);
    let pushed = 0;
    _tmpPush.set(0, 0, 0);
    for (let k = 0; k < neighbors.length && pushed < SEPARATION_NEIGHBORS; k++) {
      const o = neighbors[k];
      if (o === e || !o.alive) continue;
      const op = o.mesh.position;
      const ddx = ep.x - op.x;
      const ddz = ep.z - op.z;
      const dSq = ddx * ddx + ddz * ddz;
      if (dSq <= 1e-6 || dSq >= SEPARATION_DIST * SEPARATION_DIST) continue;
      const d = Math.sqrt(dSq);
      const overlap = (SEPARATION_DIST - d) / SEPARATION_DIST; // 0..1
      const inv = 1 / d;
      _tmpPush.x += ddx * inv * overlap;
      _tmpPush.z += ddz * inv * overlap;
      pushed++;
    }
    if (pushed > 0) {
      // Gentle nudge — keep magnitude < movement step so swarms still close.
      const pushStep = 1.5 * dt;
      ep.x += _tmpPush.x * pushStep;
      ep.z += _tmpPush.z * pushStep;
    }

    // ── Spatial hash position update ──
    spatial.move(e);

    // ── Contact damage ──
    if (e.contactCooldown > 0) e.contactCooldown -= dt;
    _tmpDelta.set(heroPos.x - ep.x, 0, heroPos.z - ep.z);
    const contactSq = _tmpDelta.x * _tmpDelta.x + _tmpDelta.z * _tmpDelta.z;
    if (contactSq <= CONTACT_DIST_SQ && e.contactCooldown <= 0) {
      const dmgMul = (e._enrageUntil && _now < e._enrageUntil) ? 1.25 : 1.0;
      heroTakeDamage(e.dmg * dmgMul);
      if (e._spriteV2 && e._spriteSlot >= 0) {
        setEnemySpriteState(e._spriteAtlasId, e._spriteSlot, ENEMY_SPRITE_STATE.ATTACK, true);
      }
      e.contactCooldown = CONTACT_CD;
    }
    // Follow after all seek, leap, knockback and separation writes so the
    // rendered position no longer trails the logical entity by one frame.
    _syncEnemySprite(e, spriteFromX, spriteFromZ, dt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public spatial query (for weapons / AoE)
// ─────────────────────────────────────────────────────────────────────────────
export function queryRadius(pos, r) {
  if (!state.enemies.spatial) return [];
  return state.enemies.spatial.queryRadius(pos, r);
}

/** Allocation-free spatial query for hot callers that own a reusable buffer. */
export function queryRadiusInto(pos, r, out) {
  out.length = 0;
  if (!state.enemies.spatial) return out;
  return state.enemies.spatial.queryRadiusInto(pos, r, out);
}

/**
 * Move an externally controlled enemy while keeping its billboard and spatial
 * cell synchronized. Returns false for dead/parked targets so mode transitions
 * cannot accidentally reinsert an overworld enemy into the Catacomb.
 */
export function setControlledEnemyXZ(enemy, x, z) {
  if (!enemy || !enemy.alive || !enemy.mesh) return false;
  if (enemy._spatialKey == null || !state.enemies.spatial) return false;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const oldX = enemy.mesh.position.x;
  const oldZ = enemy.mesh.position.z;
  enemy.mesh.position.x = x;
  enemy.mesh.position.z = z;
  if (enemy._isSprite && enemy._spriteSlot >= 0) {
    try {
      const atlasId = enemy._spriteAtlasId || V1_ENEMY_ATLAS_ID;
      moveSprite(atlasId, enemy._spriteSlot, x, 0.06, z);
      if (enemy._spriteV2) {
        const dx = x - oldX;
        const dz = z - oldZ;
        const moved = Math.abs(dx) + Math.abs(dz) > 0.0001;
        const magnitude = Math.hypot(dx, dz);
        const speed = moved ? Math.max(0, enemy.spd || 0) : 0;
        const factor = magnitude > 0.0001 ? speed / magnitude : 0;
        setEnemySpriteMotion(atlasId, enemy._spriteSlot, dx * factor, dz * factor, speed);
      }
    } catch (_) {}
  }
  state.enemies.spatial.move(enemy);
  return true;
}
