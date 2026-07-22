/**
 * GLTF preload + cache. Adapted from index.html lines 1985-2068 of the original game.
 * Exports a Promise that resolves once all assets are loaded (or failed gracefully).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HERO, AVATARS } from './config.js';
import { preloadKakiLandTerrain } from './stages/kakiland/kakiLandStage.js';
import {
  applyCharacterRimLight,
  attachCharacterCreatureAnimation,
  attachCharacterDamageFlash,
  disposeCharacterMaterialRoot,
  getCharacterMaterialPipelineState,
  isCreatureAnimationEligible,
  prepareCharacterMaterialRoot,
  resetCharacterMaterialControllers,
} from './rendering/materials/characterMaterialPipeline.js';

export const BASE = 'assets/breakroom/';

/** @type {Record<string, any>} */
export const GLTF_CACHE = {};
/** @type {Record<string, THREE.Texture|null>} */
export const TEXTURE_CACHE = {};

// r185 resolves its matching Draco worker + WASM decoder relative to the
// vendored DRACOLoader module. Keeping loader and decoder from the same exact
// Three.js release avoids deprecated decoder overrides and network fallbacks.
const _draco = new DRACOLoader();

const _loader = new GLTFLoader();
_loader.setDRACOLoader(_draco);
const _textureLoader = new THREE.TextureLoader();

function _preload(key, path) {
  return new Promise(resolve => {
    _loader.load(
      path,
      gltf => {
        GLTF_CACHE[key] = gltf;
        resolve(true);
      },
      undefined,
      err => {
        console.warn(`[assets] failed: ${path}`, err);
        GLTF_CACHE[key] = null;
        // Iter 10b — surface asset-load failures via a window CustomEvent so
        // 10c's UI layer can show a user-facing toast instead of leaving the
        // game silently spawnless. We accumulate failures on a shared list
        // so a late listener still sees the full picture (and we dispatch
        // each time so an early listener picks them up immediately too).
        try {
          if (typeof window !== 'undefined') {
            window._kkAssetFailures = window._kkAssetFailures || [];
            window._kkAssetFailures.push({ key, path, err: String(err && err.message || err) });
            window.dispatchEvent(new CustomEvent('kk-asset-load-failed', {
              detail: { failures: window._kkAssetFailures.slice() },
            }));
          }
        } catch (_) { /* event dispatch must never block the load resolve */ }
        resolve(false);
      }
    );
  });
}

// Small authored/AI-assisted raster materials live beside the GLB cache rather
// than as one-off TextureLoaders in scene builders. That keeps first paint
// deterministic: `preloadTown()` resolves only after the plaza material is
// ready, so Town never flashes its primitive fallback floor on a cold visit.
const _textureInflight = new Map();
function _preloadTexture(key, path) {
  if (Object.prototype.hasOwnProperty.call(TEXTURE_CACHE, key)) {
    return Promise.resolve(!!TEXTURE_CACHE[key]);
  }
  const pending = _textureInflight.get(key);
  if (pending) return pending;
  const p = new Promise(resolve => {
    _textureLoader.load(
      path,
      texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 4;
        TEXTURE_CACHE[key] = texture;
        _textureInflight.delete(key);
        resolve(true);
      },
      undefined,
      err => {
        console.warn(`[assets] texture failed: ${path}`, err);
        TEXTURE_CACHE[key] = null;
        _textureInflight.delete(key);
        resolve(false);
      },
    );
  });
  _textureInflight.set(key, p);
  return p;
}

export function getCachedTexture(key) {
  return TEXTURE_CACHE[key] || null;
}

/**
 * Clone a cached GLTF scene. Uses SkeletonUtils.clone for skinned meshes.
 * Returns null if the asset wasn't loaded.
 */
export function cloneCached(key) {
  const gltf = GLTF_CACHE[key];
  if (!gltf) return null;
  return SkeletonUtils.clone(gltf.scene);
}

/**
 * Lazy GLTF loader (iter 33y) — fetches the asset if not yet cached and
 * resolves with `true` when the cache entry is populated, `false` on error.
 * Used by the carousel to fetch non-default hero avatars on demand instead
 * of preloading all 12 at boot (~80 MB GPU memory).
 *
 * Returns an existing in-flight promise if one is pending for the same key,
 * so concurrent callers share a single network request.
 */
const _inflight = new Map();
export function lazyLoadGLTF(key, path) {
  if (GLTF_CACHE[key]) return Promise.resolve(true);
  const pending = _inflight.get(key);
  if (pending) return pending;
  const p = _preload(key, path).then((ok) => {
    _inflight.delete(key);
    return ok;
  });
  _inflight.set(key, p);
  return p;
}

/**
 * Drop a cached GLTF and release its GPU resources. Walks the scene graph
 * to dispose every Material, MaterialMap (Texture), and BufferGeometry so
 * VRAM doesn't leak. Used when we're done with non-selected hero avatars
 * after entering run mode.
 */
export function disposeCachedGLTF(key) {
  const gltf = GLTF_CACHE[key];
  if (!gltf) return false;
  const seenMats = new Set();
  const seenTex = new Set();
  const seenGeo = new Set();
  gltf.scene.traverse((o) => {
    if (o.geometry && !seenGeo.has(o.geometry)) {
      seenGeo.add(o.geometry);
      try { o.geometry.dispose(); } catch (_) {}
    }
    if (!o.material) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of arr) {
      if (!m || seenMats.has(m)) continue;
      seenMats.add(m);
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
        const t = m[slot];
        if (t && !seenTex.has(t)) { seenTex.add(t); try { t.dispose(); } catch (_) {} }
      }
      try { m.dispose(); } catch (_) {}
    }
  });
  GLTF_CACHE[key] = null;
  delete GLTF_CACHE[key];
  return true;
}

/**
 * Return the animation clips for a cached GLTF, or empty array.
 * Use with THREE.AnimationMixer to drive idle/walk/attack on enemies.
 */
export function getClips(key) {
  // KayKit skeleton character meshes ship WITHOUT embedded clips — the clips
  // live in the two shared Rig_Medium banks. Splice them in by name so the
  // enemy mixer path (enemies.js _makePooledMesh) drives them like any other
  // animated GLB. Clips are immutable data; sharing across mixers is safe.
  if (key && key.indexOf('skel_') === 0 && key !== 'skel_rig_general' && key !== 'skel_rig_move') {
    return getSkeletonClips();
  }
  const gltf = GLTF_CACHE[key];
  return (gltf && gltf.animations) ? gltf.animations : [];
}

let _skelClips = null;
/** Merged Rig_Medium animation clips (General + MovementBasic). Cached. */
export function getSkeletonClips() {
  if (_skelClips) return _skelClips;
  const g = GLTF_CACHE['skel_rig_general'];
  const m = GLTF_CACHE['skel_rig_move'];
  const out = [];
  if (g && g.animations) out.push(...g.animations);
  if (m && m.animations) out.push(...m.animations);
  if (out.length) _skelClips = out;          // only cache once populated
  return out;
}

/**
 * Pick a clip by fuzzy name match (case-insensitive substring). Used for
 * resilience against varying naming conventions (Idle vs idle vs CharacterIdle).
 */
export function findClip(clips, ...needles) {
  if (!clips || clips.length === 0) return null;
  for (const needle of needles) {
    const n = needle.toLowerCase();
    for (const c of clips) {
      if (c.name && c.name.toLowerCase().includes(n)) return c;
    }
  }
  return clips[0] || null;
}

/**
 * In-place material upgrade for a cloned GLTF scene: bumps Lambert/Phong to
 * MeshStandardMaterial so it reads scene.environment and looks PBR-correct.
 * Idempotent + cheap; safe to call on every spawn.
 */
let _sharedEnvironmentMap = null;
const _pendingEnvironmentMaterials = new Set();

function _materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function _bindEnvironmentMaterial(material, intensity) {
  const supportsEnvironment = material?.isMeshStandardMaterial
    || material?.isMeshLambertMaterial
    || material?.isMeshPhongMaterial;
  if (!supportsEnvironment) return false;
  if (Number.isFinite(intensity)) material.envMapIntensity = intensity;
  if (!_sharedEnvironmentMap) {
    _pendingEnvironmentMaterials.add(material);
    return false;
  }
  _pendingEnvironmentMaterials.delete(material);
  if (material.envMap) return false;
  material.envMap = _sharedEnvironmentMap;
  material.needsUpdate = true;
  return true;
}

/**
 * Register the release-wide HDR map used by upgraded GLB materials. Since
 * r163, scene.environment uses scene.environmentIntensity and no longer reads
 * per-material envMapIntensity. Explicitly binding the shared texture keeps
 * the established hero/enemy intensity values meaningful on r185 and later.
 */
export function setSharedEnvironmentMap(texture) {
  _sharedEnvironmentMap = texture || null;
  if (!_sharedEnvironmentMap) return;
  for (const material of [..._pendingEnvironmentMaterials]) {
    _bindEnvironmentMaterial(material, material.envMapIntensity);
  }
}

/**
 * Give an environment-capable material an explicit release-wide intensity.
 * This also supports r185 Lambert/Phong materials, which now inherit
 * scene.environment even though they did not in the r160 baseline.
 */
export function configureSharedEnvironmentMaterial(material, intensity = 1) {
  _bindEnvironmentMaterial(material, intensity);
  return material;
}

/** Bind the registered HDR map to existing PBR materials without cloning it. */
export function bindSharedEnvironmentMap(root, intensity = null) {
  if (!root?.traverse || !_sharedEnvironmentMap) return 0;
  let count = 0;
  root.traverse((object) => {
    if (!object?.isMesh || !object.material) return;
    for (const material of _materialList(object.material)) {
      if (_bindEnvironmentMaterial(material, intensity)) count++;
    }
  });
  return count;
}

/**
 * iter 33p — collapse non-skinned child Mesh primitives that share a source
 * material into a single merged Mesh per material. Cuts draw calls + scene-
 * graph traversal cost for GLBs authored as many small primitives (Wolf has
 * 21 prims / 4 materials → 4 draws/instance instead of 21).
 *
 * Safe to call on cloned scenes only. Bails if any SkinnedMesh is present
 * (bone-aware merging is a different problem). Returns count of primitives
 * collapsed; 0 means no-op.
 */
export function collapseStaticMeshes(root) {
  if (!root) return 0;
  let hasUnsupportedGeometry = false;
  root.traverse((o) => {
    if (!o?.isMesh) return;
    if (o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh) {
      hasUnsupportedGeometry = true;
      return;
    }
    const morphAttributes = o.geometry?.morphAttributes || {};
    if (Object.values(morphAttributes).some((entries) => Array.isArray(entries) && entries.length)) {
      hasUnsupportedGeometry = true;
    }
  });
  if (hasUnsupportedGeometry) return 0;

  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  // Bucket meshes by source material UUID. Each bucket merges to one Mesh.
  const buckets = new Map();
  const candidates = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    if (!o.geometry || !o.material) return;
    if (Array.isArray(o.material)) return;
    candidates.push(o);
  });
  if (candidates.length < 2) return 0;

  for (const o of candidates) {
    const mat = o.material;
    const geo = o.geometry.clone();
    const toRootLocal = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
    geo.applyMatrix4(toRootLocal);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    let b = buckets.get(mat.uuid);
    if (!b) { b = { mat, geoms: [], originals: [] }; buckets.set(mat.uuid, b); }
    b.geoms.push(geo);
    b.originals.push(o);
  }

  let collapsed = 0;
  for (const { mat, geoms, originals } of buckets.values()) {
    if (geoms.length < 2) { for (const g of geoms) g.dispose(); continue; }
    let mergedGeo;
    try { mergedGeo = mergeGeometries(geoms, false); }
    catch (e) { mergedGeo = null; }
    if (!mergedGeo) {
      for (const g of geoms) g.dispose();
      continue;
    }
    for (const o of originals) {
      if (o.parent) o.parent.remove(o);
    }
    // `cloneCached()` shares BufferGeometry with the GLTF cache. Never dispose
    // the removed originals here; only the temporary clones made above belong
    // to this collapse operation.
    for (const g of geoms) if (g !== mergedGeo) g.dispose();
    const m = new THREE.Mesh(mergedGeo, mat);
    m.name = '_collapsed_' + originals[0].name;
    m.userData = { ...(originals[0].userData || {}) };
    if (originals.some((object) => object.userData?.kkBloom)) m.userData.kkBloom = true;
    m.layers.mask = originals.reduce((mask, object) => mask | object.layers.mask, 1);
    m.castShadow = false;
    m.receiveShadow = false;
    root.add(m);
    collapsed += originals.length;
  }
  return collapsed;
}

/**
 * Own and promote one cloned GLTF root, then optionally attach the TSL rim.
 * Pass `{ rim: false }` when callers still need to apply hue/opacity styling;
 * call applyRimLight() after those writes and before adding controllers.
 */
export function upgradeMaterials(root, envMapIntensity = 0.55, roughness = null, options = {}) {
  if (!root) return null;
  const state = prepareCharacterMaterialRoot(root, {
    constructors: THREE,
    envMapIntensity,
    roughness,
    configureMaterial: configureSharedEnvironmentMaterial,
  });
  root.userData.materialOwnership = state.ownership;
  if (options.rim !== false) applyRimLight(root, options.rimOptions || {});
  return state;
}

export function applyRimLight(root, options = {}) {
  if (!root) return null;
  return applyCharacterRimLight(root, {
    ...options,
    onMaterialReplaced: (source, material) => {
      _pendingEnvironmentMaterials.delete(source);
      configureSharedEnvironmentMaterial(material, material.envMapIntensity);
      options.onMaterialReplaced?.(source, material);
    },
  });
}

export function applyDamageFlash(root, options = {}) {
  if (!root) return null;
  const controller = attachCharacterDamageFlash(root, options);
  root.userData.damageFlashController = controller;
  return controller;
}

export function applyCreatureVertexAnim(root, kind, options = {}) {
  if (!root || !isCreatureAnimationEligible(root)) return null;
  const controller = attachCharacterCreatureAnimation(root, { ...options, kind });
  if (controller) root.userData.creatureAnimationController = controller;
  return controller;
}

/** Backward-compatible material-list result for the former shader injector. */
export function injectVertAnim(root, kind) {
  return applyCreatureVertexAnim(root, kind)?.materials || [];
}

export function resetMaterialControllers(root, options = {}) {
  return resetCharacterMaterialControllers(root, options);
}

export function getMaterialPipelineState(root) {
  return getCharacterMaterialPipelineState(root);
}

export function disposeUpgradedMaterials(root) {
  if (!root) return 0;
  const count = disposeCharacterMaterialRoot(root);
  if (root.userData) {
    root.userData.materialOwnership = null;
    root.userData.damageFlashController = null;
    root.userData.creatureAnimationController = null;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered preload (hotfix #151, 2026-05-18) — splits the previous all-at-boot
// preloadAll into:
//   Tier 1 preloadEssential()  — hero/avatar carousel mesh. Blocks first paint;
//                                XP/orbitals are tiny WebPs preloaded by HTML.
//   Tier 2 preloadStage(id)    — enemy roster + stage-specific decor kits.
//                                Awaited at run-start before world spawns.
//   Tier 3 preloadTown()       — town district kits, lazy on enter
//        preloadCasino()       — casino building/chip/dice, lazy on enter
//        preloadHomeDecor()    — H-overlay furniture set, lazy on enter
//
// Each tier resolves a Promise.all over its _preload([k, p]) pairs. _preload
// itself is idempotent across re-calls (the loader callback is one-shot per
// key, and Tier 2/3 wrappers below skip already-cached entries). Caches are
// SHARED — a model loaded by one tier remains available to every later tier.
// ─────────────────────────────────────────────────────────────────────────────

// Skip keys already cached or in flight. Used by all tier helpers so repeat
// calls (e.g. preloadStage('forest') after a return-to-menu) are no-ops.
function _loadPairs(pairs) {
  return Promise.all(pairs.map(([k, p]) => {
    if (GLTF_CACHE[k]) return Promise.resolve(true);
    return lazyLoadGLTF(k, p);
  }));
}

/**
 * Tier 1 — boot path. Hero donor + the selected avatar override. XP and the
 * orbital weapon are pooled WebP sprites now, so no food GLBs load here.
 * Other avatar overrides load on demand from the hero
 * carousel / menu splash. Particle textures + fxAwait stay in main.js because
 * they're synchronous or non-GLB. Anything else is deferred to Tier 2/3.
 *
 * Note on the 'hero' donor: tower-castle-plain.glb is ~15 MB and is only
 * used as the fallback mesh for AVATARS entries with `glb: null` — namely
 * `kitty` (default), `rune_kitten`, `mire_kitten`, `shroud_kitten`. We keep
 * it in Tier 1 because the carousel previews those avatars at boot via
 * `cloneCached('hero')`. A smaller-donor swap would change the default
 * kitty's silhouette → out of scope for a pure preload-tier refactor.
 * Tracked in HANDOFF: "hero donor is 15 MB, four avatars depend on it."
 */
export function preloadEssential(selectedAvatarId = 'kitty') {
  const selectedAvatar = (AVATARS || []).find(a => a && a.id === selectedAvatarId);
  const avatarOverrides = selectedAvatar && selectedAvatar.glb
    ? [[`hero_${selectedAvatar.id}`, BASE + selectedAvatar.glb]]
    : [];
  const pairs = [
    ['hero', BASE + HERO.glb],
    ...avatarOverrides,
  ];
  return _loadPairs(pairs);
}

// Shared mob roster — encounter decks now select strict per-stage subsets,
// but these compact common models remain in the awaited run tier so a themed
// beat can never hitch the first time it appears. Forest-only insects stay in
// their own stage arm below.
const _CORE_MOB_PAIRS = [
  ['zombie',   BASE + 'Mushnub.glb'],
  ['goblin',   BASE + 'Cactoro.glb'],
  ['skeleton', BASE + 'Goleling.glb'],
  ['orc',      BASE + 'Orc-New.glb'],
  ['demon',    BASE + 'Demon-New.glb'],
  ['robot',    BASE + 'Goleling-Evolved.glb'],
  ['mech',     BASE + 'Yeti.glb'],
  ['xeno',     BASE + 'Blue-Demon.glb'],
  ['slime',    BASE + 'Pink-Slime.glb'],
  ['giant',    BASE + 'Mushroom-King.glb'],
  ['dragon',   BASE + 'Dragon-New.glb'],
  ['wizard',   BASE + 'Wizard.glb'],
  ['ghost',    BASE + 'Ghost.glb'],
  ['spider',   BASE + 'Spider.glb'],
  ['wolf',     BASE + 'Wolf.glb'],
  ['dragon_evo', BASE + 'Dragon-Evolved.glb'],
  ['clockwork_mouse', 'assets/kits/enemies/clockwork_mouse.glb'],
  ['yarn_wisp',       'assets/kits/enemies/yarn_wisp.glb'],
  // Singleton hunter replacing the old cone/box debug silhouette. Three
  // authored material primitives, loaded once and cloned only on its rare
  // scheduled appearance.
  ['nemesis_stalker', 'assets/kits/enemies/nemesis_stalker.glb'],
];

// Final-chapter combat roster. Kept out of _CORE_MOB_PAIRS so other stages do
// not download seven assets they can never spawn. The three small creatures
// are pooled encounter adds; the four bosses remain low-count singleton GLBs.
const _KAKI_LAND_ENEMY_PAIRS = [
  ['kaki_sparkmite',       'assets/kits/enemies/kakiland/kaki_sparkmite.glb'],
  ['kaki_tidesprite',      'assets/kits/enemies/kakiland/kaki_tidesprite.glb'],
  ['kaki_bloomling',       'assets/kits/enemies/kakiland/kaki_bloomling.glb'],
  ['kaki_ember_warden',    'assets/kits/enemies/kakiland/kaki_ember_warden.glb'],
  ['kaki_tideborn_wyrm',   'assets/kits/enemies/kakiland/kaki_tideborn_wyrm.glb'],
  ['kaki_bloom_colossus',  'assets/kits/enemies/kakiland/kaki_bloom_colossus.glb'],
  ['kaki_sovereign',       'assets/kits/enemies/kakiland/kaki_sovereign.glb'],
];

// Forest bugs — only spawn on forest stage per the wave-spawn semantics in
// spawnDirector.js (D-gated, but bug tiers have low minD so they appear
// only in the early-difficulty pool which lines up with forest gameplay).
const _FOREST_BUG_PAIRS = [
  ['ant',         BASE + 'Ant.glb'],
  ['beetle',      BASE + 'Beetle.glb'],
  ['ladybug',     BASE + 'Ladybug.glb'],
  ['grasshopper', BASE + 'Grasshopper.glb'],
  ['cockroach',   BASE + 'Cockroach.glb'],
  ['mantis',      BASE + 'Mantis.glb'],
  ['wasp',        BASE + 'Wasp.glb'],
  ['bee',         BASE + 'Bee.glb'],
  ['butterfly',   BASE + 'Butterfly.glb'],
  ['caterpillar', BASE + 'Caterpillar.glb'],
];

// Shared in-run chest props. The former Rock/Tree/Bush/Dead Tree entries were
// downloaded after buildEnv's one attempted scatter pass and therefore never
// rendered; stage-scoped instanced landscape kits now provide that scenery.
const _ENV_PROP_PAIRS = [
  ['chest',    BASE + 'chest.glb'],
  ['chest_open', BASE + 'chest_open.glb'],
];

// Tiny Blender-authored combat centerpiece kit. Common to every stage because
// Nova is a draftable active everywhere; loaded in the awaited run tier (not
// menu boot) and extracted into one InstancedMesh by fx/novaBurst.js.
const _COMBAT_KIT_PAIRS = [
  ['fx_nova_claw', 'assets/kits/combat/nova_claw_shard.glb'],
  // Pipes' compact three-material paw hook. The signature module keeps one
  // clone plus an instanced chain, so loading this 64 KiB kit with the shared
  // combat tier avoids a first-grapple hitch without adding hot-loop work.
  ['fx_pipes_grapple_hook', 'assets/kits/combat/pipes_grapple_hook.glb'],
];

// Blender-authored landmark kit for every overworld biome. The common cliff
// bank is shared, while Forest downloads only wood and the other stages only
// stone; each compact GLB is instanced by stageLandscapes.
const _LANDMARK_COMMON_PAIRS = [
  ['kk_cliff_edge',   'assets/kits/landmarks/cliff_edge.glb'],
];
const _LANDMARK_FOREST_PAIRS = [
  ['kk_bridge_wood',  'assets/kits/landmarks/bridge_wood.glb'],
  // Compact three-mesh rootstone gate used by all twelve Forest trial
  // portals. forestPortals owns the lightweight animated veil and toggles the
  // authored shutter/bloom meshes for SEALED/CLEARED states.
  ['forest_trial_gate', 'assets/kits/landmarks/forest_trial_gate.glb'],
];
const _LANDMARK_STONE_PAIRS = [
  ['kk_bridge_stone', 'assets/kits/landmarks/bridge_stone.glb'],
];

// Dungeon kits — Kay Lousberg crypts/pillars/bones. Used by:
//   - arenaDecor._buildVoidDecor for the void stage's pillar/bone ring
//   - catacomb.js for the catacomb sub-mode chamber (entered via E on
//     overworld stairs). buildCatacomb runs at boot for the entrance, but
//     the chamber interior gracefully renders sparse without these kits.
// Loaded for void stage; sparse-chamber trade-off documented.
const _DUNGEON_KIT_PAIRS = [
  ['kit_arch',         'assets/kits/dungeon/arch.glb'],
  ['kit_pillar',       'assets/kits/dungeon/pillar.glb'],
  ['kit_pillar2',      'assets/kits/dungeon/pillar_alt.glb'],
  ['kit_pillar_broken','assets/kits/dungeon/pillar_broken.glb'],
  ['kit_coffin',       'assets/kits/dungeon/coffin.glb'],
  ['kit_crypt',        'assets/kits/dungeon/crypt.glb'],
  ['kit_bone1',        'assets/kits/dungeon/bone1.glb'],
  ['kit_bone2',        'assets/kits/dungeon/bone2.glb'],
  ['kit_bone3',        'assets/kits/dungeon/bone3.glb'],
  // Torches — used by catacomb.js chamber. Also referenced by twilight
  // ruins decor; loaded with void since catacomb is the heavier consumer.
  ['kit_torch_wall',   'assets/kits/torches/torch_wall.glb'],
  ['kit_torch_stand',  'assets/kits/torches/torch_stand.glb'],
];

// Twilight ruins kits — gravestones. Loaded only on twilight stage.
const _TWILIGHT_KIT_PAIRS = [
  ['kit_grave',     'assets/kits/ruins/damaged_grave.glb'],
  ['kit_gravestone','assets/kits/ruins/gravestone.glb'],
  ['kit_gravestone2','assets/kits/ruins/gravestone_alt.glb'],
  // Authored moon-garden landscape: dead canopy, pond banks, and collapsed
  // courtyard architecture. These are baked into InstancedMesh pools by
  // stageLandscapes.js, so the added visual density costs one draw per kit.
  ['kkf_tree_bare1', 'assets/kits/forest/Tree_Bare_1_A.glb'],
  ['kkf_tree_bare2', 'assets/kits/forest/Tree_Bare_2_A.glb'],
  ['kkf_bush1',      'assets/kits/forest/Bush_1_A.glb'],
  ['kkf_rock1',      'assets/kits/forest/Rock_1_A.glb'],
  ['kkf_rock3',      'assets/kits/forest/Rock_2_A.glb'],
  ['kit_arch',       'assets/kits/dungeon/arch.glb'],
  ['kit_pillar_broken','assets/kits/dungeon/pillar_broken.glb'],
  ['kkd_wall_broken','assets/kits/dungeon/wall_broken.glb'],
  ['kkd_rubble',     'assets/kits/dungeon/rubble_large.glb'],
];

// Small, stage-scoped landscape subsets. Keeping these separate from the full
// dungeon pack avoids downloading dozens of props a biome never renders.
const _CINDER_LANDSCAPE_PAIRS = [
  ['kkf_tree_bare1', 'assets/kits/forest/Tree_Bare_1_A.glb'],
  ['kkf_rock5',      'assets/kits/forest/Rock_3_H.glb'],
  ['kkd_wall_broken','assets/kits/dungeon/wall_broken.glb'],
  ['kkd_rubble',     'assets/kits/dungeon/rubble_large.glb'],
  ['kkd_crates',     'assets/kits/dungeon/crates_stacked.glb'],
  ['kkd_barrel',     'assets/kits/dungeon/barrel_large.glb'],
];

const _VOID_LANDSCAPE_PAIRS = [
  ['kkd_wall_broken','assets/kits/dungeon/wall_broken.glb'],
  ['kkd_rubble',     'assets/kits/dungeon/rubble_large.glb'],
];

const _CAVE_LANDSCAPE_PAIRS = [
  ['kit_arch',         'assets/kits/dungeon/arch.glb'],
  ['kit_pillar_broken','assets/kits/dungeon/pillar_broken.glb'],
  ['kkd_rubble',       'assets/kits/dungeon/rubble_large.glb'],
  ['kkf_rock1',        'assets/kits/forest/Rock_1_A.glb'],
  ['kkf_rock3',        'assets/kits/forest/Rock_2_A.glb'],
  ['kkf_rock5',        'assets/kits/forest/Rock_3_H.glb'],
];

const _TOWN_KIT_PAIRS = [
  ['kit_house',    'assets/kits/town/fantasy_house.glb'],
  ['kit_house2',   'assets/kits/town/town_house.glb'],
  ['kit_inn',      'assets/kits/town/fantasy_inn.glb'],
  ['kit_keep',     'assets/kits/town/tower_house.glb'],
  ['kit_gate',     'assets/kits/town/castle_gate.glb'],
  ['kit_barracks', 'assets/kits/town/fantasy_barracks.glb'],
  // MaoMao lives physically beside the daycare. This tiny static cat is part
  // of the town district now, not deferred behind the cabin decor preload.
  ['home_cat',     'assets/kits/home/cat.glb'],
];

const _FOREST_BUILDING_PAIRS = [
  ..._TOWN_KIT_PAIRS,
  ['kit_pillar_broken', 'assets/kits/dungeon/pillar_broken.glb'],
];

// ── KayKit imports (scripts/fetch-kaykit.sh) ────────────────────────────────
// Forest Nature accents — curated trees/bushes/rocks scattered as InstancedMesh
// accents ON TOP of the procedural tree field (arenaDecor.js). Loaded on forest.
const _FOREST_ACCENT_PAIRS = [
  // Original Grok-directed, model-authored moonroot geode. arenaDecor
  // extracts its rooted base + crystal crown into two InstancedMesh pools,
  // replacing the old cylinder-and-cone Forest crystal placeholder.
  ['forest_moonroot_crystal', 'assets/kits/forest/moonroot_crystal_cluster.glb'],
  ['kkf_tree1',      'assets/kits/forest/Tree_1_A.glb'],
  ['kkf_tree2',      'assets/kits/forest/Tree_2_A.glb'],
  ['kkf_tree3',      'assets/kits/forest/Tree_2_C.glb'],
  ['kkf_tree4',      'assets/kits/forest/Tree_3_A.glb'],
  ['kkf_tree5',      'assets/kits/forest/Tree_4_A.glb'],
  ['kkf_tree_bare1', 'assets/kits/forest/Tree_Bare_1_A.glb'],
  ['kkf_tree_bare2', 'assets/kits/forest/Tree_Bare_2_A.glb'],
  ['kkf_bush1',      'assets/kits/forest/Bush_1_A.glb'],
  ['kkf_bush2',      'assets/kits/forest/Bush_2_A.glb'],
  ['kkf_bush3',      'assets/kits/forest/Bush_4_A.glb'],
  ['kkf_rock1',      'assets/kits/forest/Rock_1_A.glb'],
  ['kkf_rock2',      'assets/kits/forest/Rock_1_E.glb'],
  ['kkf_rock3',      'assets/kits/forest/Rock_2_A.glb'],
  ['kkf_rock4',      'assets/kits/forest/Rock_3_A.glb'],
  ['kkf_rock5',      'assets/kits/forest/Rock_3_H.glb'],
  // Lockdown arenas use the authored KayKit stone wall as their physical
  // barricade. Keep this in the awaited Forest tier so armLockdown can pool
  // textured meshes synchronously instead of flashing a procedural box first.
  ['kkd_wall',       'assets/kits/dungeon/wall.glb'],
];

// Dungeon Remastered — modular walls/floors/pillars/stairs + dressing props.
// Used by catacomb.js to build a real walled room instead of the bare box.
// Lazy-loaded on catacomb entry (preloadDungeonKit) since the catacomb is
// reachable from any stage, not just void.
const _KAYKIT_DUNGEON_PAIRS = [
  // Dedicated Blender-authored portcullis leaf. Doorway frames remain KayKit;
  // this asset is the animated physical seal rather than a wall used as a door.
  ['kk_dungeon_gate',     'assets/kits/landmarks/dungeon_portcullis.glb'],
  ['kkd_wall',           'assets/kits/dungeon/wall.glb'],
  ['kkd_wall_corner',    'assets/kits/dungeon/wall_corner.glb'],
  ['kkd_wall_corner_sm', 'assets/kits/dungeon/wall_corner_small.glb'],
  ['kkd_wall_doorway',   'assets/kits/dungeon/wall_doorway.glb'],
  ['kkd_wall_arched',    'assets/kits/dungeon/wall_arched.glb'],
  ['kkd_wall_broken',    'assets/kits/dungeon/wall_broken.glb'],
  ['kkd_wall_cracked',   'assets/kits/dungeon/wall_cracked.glb'],
  ['kkd_wall_window',    'assets/kits/dungeon/wall_window_open.glb'],
  ['kkd_wall_endcap',    'assets/kits/dungeon/wall_endcap.glb'],
  ['kkd_wall_half',      'assets/kits/dungeon/wall_half.glb'],
  ['kkd_wall_tsplit',    'assets/kits/dungeon/wall_Tsplit.glb'],
  ['kkd_wall_pillar',    'assets/kits/dungeon/wall_pillar.glb'],
  ['kkd_floor_large',    'assets/kits/dungeon/floor_tile_large.glb'],
  ['kkd_floor_small',    'assets/kits/dungeon/floor_tile_small.glb'],
  ['kkd_floor_dirt',     'assets/kits/dungeon/floor_dirt_large.glb'],
  ['kkd_floor_grate',    'assets/kits/dungeon/floor_tile_big_grate.glb'],
  ['kkd_floor_spikes',   'assets/kits/dungeon/floor_tile_big_spikes.glb'],
  ['kkd_pillar',         'assets/kits/dungeon/pillar_decorated.glb'],
  ['kkd_column',         'assets/kits/dungeon/column.glb'],
  ['kkd_stairs',         'assets/kits/dungeon/stairs.glb'],
  ['kkd_stairs_wide',    'assets/kits/dungeon/stairs_wide.glb'],
  ['kkd_barrel',         'assets/kits/dungeon/barrel_large.glb'],
  ['kkd_barrel_sm',      'assets/kits/dungeon/barrel_small.glb'],
  ['kkd_box',            'assets/kits/dungeon/box_large.glb'],
  ['kkd_crates',         'assets/kits/dungeon/crates_stacked.glb'],
  ['kkd_chest',          'assets/kits/dungeon/chest.glb'],
  ['kkd_chest_gold',     'assets/kits/dungeon/chest_gold.glb'],
  ['kkd_candle3',        'assets/kits/dungeon/candle_triple.glb'],
  ['kkd_candle',         'assets/kits/dungeon/candle_lit.glb'],
  ['kkd_coins',          'assets/kits/dungeon/coin_stack_large.glb'],
  ['kkd_keg',            'assets/kits/dungeon/keg.glb'],
  ['kkd_table',          'assets/kits/dungeon/table_medium.glb'],
  ['kkd_shelf',          'assets/kits/dungeon/shelf_large.glb'],
  ['kkd_rubble',         'assets/kits/dungeon/rubble_large.glb'],
  ['kkd_coffin',         'assets/kits/dungeon/coffin.glb'],
  ['kkd_crypt',          'assets/kits/dungeon/crypt.glb'],
  ['kkd_bone1',          'assets/kits/dungeon/bone1.glb'],
  ['kkd_bone2',          'assets/kits/dungeon/bone2.glb'],
  ['kkd_bone3',          'assets/kits/dungeon/bone3.glb'],
  ['kkd_banner',         'assets/kits/dungeon/banner_thin_brown.glb'],
  ['kkd_sword_shield',   'assets/kits/dungeon/sword_shield.glb'],
];

// Skeletons — 4 rigged character meshes + 2 shared anim banks (Rig_Medium).
// Clips live in skel_rig_*; bind to a cloned char SkinnedMesh by bone name via
// an AnimationMixer. Used for animated elites + catacomb wave mobs (low counts
// only — skinned meshes are too heavy for the full horde). Lazy-loaded.
const _SKELETON_PAIRS = [
  ['skel_mage',        'assets/kits/skeletons/Skeleton_Mage.glb'],
  ['skel_minion',      'assets/kits/skeletons/Skeleton_Minion.glb'],
  ['skel_rogue',       'assets/kits/skeletons/Skeleton_Rogue.glb'],
  ['skel_warrior',     'assets/kits/skeletons/Skeleton_Warrior.glb'],
  ['skel_rig_general', 'assets/kits/skeletons/Rig_Medium_General.glb'],
  ['skel_rig_move',    'assets/kits/skeletons/Rig_Medium_MovementBasic.glb'],
];

/** Char-key list (excludes the anim-only rigs) for spawn-side variant picks. */
export const SKELETON_CHAR_KEYS = ['skel_mage', 'skel_minion', 'skel_rogue', 'skel_warrior'];

/**
 * Tier 2 — run-start. Loads enemy roster + props + stage-specific decor
 * before the world spawns. Idempotent across re-calls (already-cached
 * entries are skipped by _loadPairs). main.js awaits this before
 * rebuildHero and re-runs prewarmPools after.
 *
 * Stage mapping (no explicit per-stage enemy filter exists in
 * spawnDirector.js — every tier with `minD <= D` is eligible, so every
 * stage gets the full core mob roster):
 *   - forest:   core mobs + forest bugs + env props
 *   - twilight: core mobs + env props + ruins kits
 *   - cinder:   core mobs + env props
 *   - void:     core mobs + env props + dungeon kits
 *   - any other id: defensive — load core mobs + env props
 */
export function preloadStage(stageId) {
  const pairs = [..._CORE_MOB_PAIRS, ..._ENV_PROP_PAIRS, ..._COMBAT_KIT_PAIRS, ..._LANDMARK_COMMON_PAIRS];
  switch (stageId) {
    case 'forest':
      pairs.push(..._LANDMARK_FOREST_PAIRS);
      pairs.push(..._FOREST_BUG_PAIRS);
      pairs.push(..._FOREST_ACCENT_PAIRS);
      pairs.push(..._FOREST_BUILDING_PAIRS);
      break;
    case 'twilight':
      pairs.push(..._LANDMARK_STONE_PAIRS);
      pairs.push(..._TWILIGHT_KIT_PAIRS);
      break;
    case 'cinder':
      pairs.push(..._LANDMARK_STONE_PAIRS);
      pairs.push(..._CINDER_LANDSCAPE_PAIRS);
      break;
    case 'void':
      pairs.push(..._LANDMARK_STONE_PAIRS);
      pairs.push(..._DUNGEON_KIT_PAIRS);
      pairs.push(..._VOID_LANDSCAPE_PAIRS);
      break;
    case 'cave':
      pairs.push(..._LANDMARK_STONE_PAIRS);
      pairs.push(..._CAVE_LANDSCAPE_PAIRS);
      break;
    case 'kakiland':
      // Kaki's generated islands use the shared combat roster plus a compact
      // bespoke boss/add kit. No ordinary landscape GLBs are needed here.
      pairs.push(..._KAKI_LAND_ENEMY_PAIRS);
      break;
    default:
      // unknown stage id — load conservative baseline only
      break;
  }
  const loads = [_loadPairs(pairs)];
  if (stageId === 'kakiland') loads.push(preloadKakiLandTerrain());
  return Promise.all(loads).then(([loaded]) => loaded);
}

/**
 * Lazy — KayKit modular dungeon kit + animated skeletons. Awaited by
 * catacomb.js#enterCatacomb so the chamber builds with real walls/props and
 * spawns animated skeleton wave mobs. Reachable from any stage, so it can't
 * ride a fixed preloadStage arm. Idempotent (_loadPairs skips cached keys).
 */
export function preloadDungeonKit() {
  return _loadPairs([..._KAYKIT_DUNGEON_PAIRS, ..._SKELETON_PAIRS]);
}

/**
 * Lazy — just the skeleton meshes + anim rigs, for animated elites that can
 * appear outside the catacomb. Idempotent.
 */
export function preloadSkeletons() {
  return _loadPairs(_SKELETON_PAIRS);
}

/**
 * Tier 3 — town district. Six Quaternius house/keep/inn kits plus a capped
 * cohort of unlocked hero models used as visible townsfolk. The caller picks
 * at most TOWNSFOLK_MAX_PRESENT avatar ids, preventing an all-roster preload
 * from undoing the lazy avatar memory budget.
 */
export function preloadTown(heroAvatarIds = []) {
  const ids = new Set(Array.isArray(heroAvatarIds) ? heroAvatarIds : []);
  const heroPairs = [];
  for (const av of AVATARS || []) {
    if (!ids.has(av.id) || !av.glb) continue; // donor avatars already use `hero`
    heroPairs.push([`hero_${av.id}`, BASE + av.glb]);
  }
  return Promise.all([
    _loadPairs([..._TOWN_KIT_PAIRS, ...heroPairs]),
    _preloadTexture('town_plaza_cobble_v1', 'assets/textures/town_plaza_cobble_v1.png'),
  ]).then(([assets]) => assets);
}

/**
 * Compatibility entry for callers that explicitly prewarm the Forest district.
 * Normal runs now load this set only from preloadStage('forest'), avoiding a
 * multi-megabyte town-kit download when the player chose another biome.
 */
export function preloadForestBuildings() {
  return _loadPairs(_FOREST_BUILDING_PAIRS);
}

/**
 * Tier 3 — casino interior. Building + chip + dice GLBs used by both
 * town.js (Seedy Tent procedural prop) and casinoInterior.js (chip
 * scatter / dice prop). main.js wraps the casino interactable handler
 * to await this before enterCasinoInterior. Idempotent.
 */
export function preloadCasino() {
  return _loadPairs([
    ['casino_building', 'assets/casino/casino_building.glb'],
    ['casino_chip',     'assets/casino/poker_chip.glb'],
    ['casino_dice',     'assets/casino/dice.glb'],
  ]);
}

/**
 * Tier 3 — home decor catalog. 16 Quaternius furniture kits used by
 * homeDecor.js for the H-overlay Decorate mode. main.js's interior-enter
 * handler kicks this off in the background so the assets are ready by
 * the time the player presses H inside the interior. Idempotent.
 */
export function preloadHomeDecor() {
  return _loadPairs([
    ['home_rug',           'assets/kits/home/rug.glb'],
    ['home_plant',         'assets/kits/home/plant.glb'],
    ['home_lamp',          'assets/kits/home/lamp.glb'],
    ['home_bed',           'assets/kits/home/bed.glb'],
    ['home_bookshelf',     'assets/kits/home/bookshelf.glb'],
    ['home_cauldron',      'assets/kits/home/cauldron.glb'],
    ['home_chair',         'assets/kits/home/chair.glb'],
    ['home_side_table',    'assets/kits/home/side_table.glb'],
    ['home_sofa',          'assets/kits/home/sofa.glb'],
    ['home_cat',           'assets/kits/home/cat.glb'],
    ['home_chest',         'assets/kits/home/chest.glb'],
    ['home_banner_wall',   'assets/kits/home/banner_wall.glb'],
    ['home_banner_alt',    'assets/kits/home/banner_alt.glb'],
    ['home_sword_mount',   'assets/kits/home/sword_mount.glb'],
    ['home_shield_mount',  'assets/kits/home/shield_mount.glb'],
    ['home_skull_mount',   'assets/kits/home/skull_mount.glb'],
  ]);
}

/**
 * @deprecated Use preloadEssential() at boot and preloadStage()/preloadTown()
 * /preloadCasino()/preloadHomeDecor() at the appropriate entry points.
 * Kept as a thin wrapper for backward-compat with any external callers
 * (none in-tree at hotfix #151 time).
 */
export function preloadAll(selectedAvatarId) {
  return preloadEssential(selectedAvatarId);
}
