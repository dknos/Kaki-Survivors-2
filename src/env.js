/**
 * Forest environment: ground plane + scattered scenery + lights + fog.
 * Trimmed from original game's buildCastleEnv() (line 4409). No destructibles,
 * no central tower platform — the hero IS the player, no fixed structure here.
 */
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WORLD } from './config.js';
import { tex as particleTex } from './particleTextures.js';
import { bindSharedEnvironmentMap, setSharedEnvironmentMap } from './assets.js';
import { getCapabilitiesForRendererSource } from './rendering/rendererAccess.js';
import {
  createAtmosphereParticleGeometry,
  createAtmosphereParticleMaterial,
} from './rendering/materials/atmosphereParticleMaterial.js';

// ── Per-stage atmospheric particles (iter 15) ────────────────────────────────
// Single instanced-quad cluster per stage, attached to envGroup at boot. Only
// the active stage's cluster is visible + ticked. The TSL material gives each
// particle its own size + alpha on both WebGPU and WebGL 2; the CPU arrays and
// drift behavior remain the released point-particle implementation.
//
// Density target: 200-300 particles per stage. Five clusters stay resident,
// but only the active one is visible, so atmosphere costs one draw per frame.
const ATMOS_SPECS = {
  forest: {
    count: 220,
    radius: 60,          // horizontal disc around hero
    yMin: 0.2,           // points spawn between yMin and yMax (world Y)
    yMax: 14,
    color: 0x9bcf6a,     // sage-green pollen mote
    baseSize: 1.8,
    sizeJitter: 0.8,
    baseAlpha: 0.55,
    alphaJitter: 0.25,
    texKey: 'pollen',
    blending: THREE.AdditiveBlending,
  },
  twilight: {
    count: 140,
    radius: 60,
    yMin: 0.4,
    yMax: 12,
    color: 0x8d829f,     // muted dusk mist; speed aura keeps blue-white
    baseSize: 1.45,
    sizeJitter: 0.55,
    baseAlpha: 0.34,
    alphaJitter: 0.20,
    texKey: 'glowWhite',
    blending: THREE.AdditiveBlending,
  },
  cinder: {
    count: 260,
    radius: 60,
    yMin: 0.1,
    yMax: 16,
    color: 0xff8a3a,     // ember orange
    baseSize: 1.5,
    sizeJitter: 0.9,
    baseAlpha: 0.75,
    alphaJitter: 0.20,
    texKey: 'emberWarm',
    blending: THREE.AdditiveBlending,
  },
  void: {
    count: 200,
    radius: 60,
    yMin: 0.5,
    yMax: 10,
    color: 0xc69cff,     // violet ghost sparkle
    baseSize: 1.6,
    sizeJitter: 0.7,
    baseAlpha: 0.60,
    alphaJitter: 0.35,
    texKey: 'twinkle',
    blending: THREE.AdditiveBlending,
  },
  // P4A cohort 2 — Stonewright Caverns. Slow upward glowmoss spores,
  // SPARSE (cave is meant to feel like dripping silence per
  // docs/CAVE_VISUAL_STYLE.md "deep, wet grottos"). 30-40 particle cap
  // per the cohort 2 brief — well under forest/cinder density. Color is
  // CAVE_PALETTE.moss (#7fffe4); glowWhite texKey tints cleanly via
  // uColor without authoring a dedicated particle bitmap.
  cave: {
    count: 36,
    radius: 50,
    yMin: 0.2,
    yMax: 10,
    color: 0x7fffe4,     // CAVE_PALETTE.moss (slot 3)
    // CC10 (2026-05-20): spores were the LARGEST of any stage (2.4 vs forest
    // 2.0 / cinder 1.5 / void 1.6) AND additive-white on the darkest bg, so
    // they bloomed into big pale puffs — contradicting the "sparse / dripping
    // silence / subtle" intent above. Verified against tools/_thumb_cave_visual
    // .png (CC7 render gate). Pulled down to subtle motes: smallest base size +
    // dimmer alpha so the cyan tint reads without blowing out on the dark bg.
    baseSize: 0.9,
    sizeJitter: 0.35,
    baseAlpha: 0.28,
    alphaJitter: 0.14,
    texKey: 'glowWhite',
    blending: THREE.AdditiveBlending,
  },
};

function _buildAtmosCluster(spec) {
  const N = spec.count;
  const positions = new Float32Array(N * 3);
  const sizes     = new Float32Array(N);
  const alphas    = new Float32Array(N);
  const phases    = new Float32Array(N);  // per-point random phase for twinkle
  const seeds     = new Float32Array(N);  // per-point unique seed (xz jitter)
  for (let i = 0; i < N; i++) {
    // Spawn within a disc around origin; main.js shifts to hero on first tick.
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spec.radius;
    positions[i * 3 + 0] = Math.cos(a) * r;
    positions[i * 3 + 1] = spec.yMin + Math.random() * (spec.yMax - spec.yMin);
    positions[i * 3 + 2] = Math.sin(a) * r;
    sizes[i]  = spec.baseSize + (Math.random() - 0.5) * 2 * spec.sizeJitter;
    alphas[i] = Math.max(0, spec.baseAlpha + (Math.random() - 0.5) * 2 * spec.alphaJitter);
    phases[i] = Math.random() * Math.PI * 2;
    seeds[i]  = Math.random() * 1000;
  }
  const sourceGeometry = new THREE.BufferGeometry();
  sourceGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  sourceGeometry.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  sourceGeometry.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));
  // Large bounding sphere so frustum culling doesn't drop the cluster when we
  // wrap-shift points around the hero (positions move freely in world space).
  sourceGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  const map = particleTex(spec.texKey);
  const geometry = createAtmosphereParticleGeometry(sourceGeometry);
  const material = createAtmosphereParticleMaterial({
    map,
    color: spec.color,
    blending: spec.blending,
  });
  const particles = new THREE.Mesh(geometry, material);
  particles.frustumCulled = false;
  particles.userData._atmosSpec = spec;
  particles.userData._phases = phases;
  particles.userData._seeds  = seeds;
  particles.userData._baseAlpha = spec.baseAlpha;
  particles.userData._alphaJitter = spec.alphaJitter;
  particles.userData._tickAcc = Math.random() * 10;  // animation clock offset
  particles.userData._initialized = false;           // hero-centering flag
  // particleTex owns/cache-disposes the texture. This cluster owns only its
  // adapter geometry and node material.
  particles.userData._atmosTextureOwnership = 'shared-particle-texture-cache';
  particles.visible = false;
  return particles;
}

// Per-stage tick functions. All operate on absolute world coords; hero passes
// in its x/z to anchor the wrap-disc. Vertical drift uses world Y bounds (not
// hero-relative) so jumps don't fountain particles.
function _tickForest(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.atmosphereAttributes.position.array;
  const seeds = points.userData._seeds;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Slow upward drift + sin-wave x-jitter
    pos[ix + 1] += dt * (0.6 + Math.sin(t * 0.5 + seeds[i]) * 0.15);
    pos[ix + 0] += dt * Math.sin(t * 0.7 + seeds[i] * 0.13) * 0.20;
    // Respawn at base when above yMax
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 1.0;
    }
    // Horizontal wrap around hero (mirror to opposite edge)
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
  }
  points.geometry.atmosphereAttributes.position.needsUpdate = true;
}

function _tickTwilight(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.atmosphereAttributes.position.array;
  const alphas = points.geometry.atmosphereAttributes.alpha.array;
  const seeds = points.userData._seeds;
  const phases = points.userData._phases;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  const base = points.userData._baseAlpha;
  const aJit = points.userData._alphaJitter;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Slow vertical drift + lateral orbit
    pos[ix + 1] += dt * (0.35 + Math.sin(t * 0.4 + seeds[i]) * 0.10);
    const orbit = t * 0.25 + phases[i];
    pos[ix + 0] += dt * Math.cos(orbit) * 0.30;
    pos[ix + 2] += dt * Math.sin(orbit) * 0.30;
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 1.0;
    }
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
    // Occasional flicker — per-point alpha sine with random phase
    const flicker = 0.5 + 0.5 * Math.sin(t * 2.1 + phases[i] * 3.0);
    alphas[i] = Math.max(0.05, base + (flicker - 0.5) * 2 * aJit);
  }
  points.geometry.atmosphereAttributes.position.needsUpdate = true;
  points.geometry.atmosphereAttributes.alpha.needsUpdate = true;
}

function _tickCinder(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.atmosphereAttributes.position.array;
  const seeds = points.userData._seeds;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Fast upward rise + curl noise (embers swirling)
    pos[ix + 1] += dt * (2.6 + Math.sin(t * 0.9 + seeds[i]) * 0.35);
    const curl = t * 1.1 + seeds[i] * 0.07;
    pos[ix + 0] += dt * Math.sin(curl) * 0.55;
    pos[ix + 2] += dt * Math.cos(curl * 0.83) * 0.55;
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 0.5;
    }
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
  }
  points.geometry.atmosphereAttributes.position.needsUpdate = true;
}

function _tickVoid(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.atmosphereAttributes.position.array;
  const alphas = points.geometry.atmosphereAttributes.alpha.array;
  const seeds = points.userData._seeds;
  const phases = points.userData._phases;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  const base = points.userData._baseAlpha;
  const aJit = points.userData._alphaJitter;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Near-static with slow orbital drift
    const orbit = t * 0.12 + phases[i];
    pos[ix + 0] += dt * Math.cos(orbit) * 0.12;
    pos[ix + 2] += dt * Math.sin(orbit) * 0.12;
    pos[ix + 1] += dt * Math.sin(t * 0.18 + seeds[i]) * 0.05;
    // Hard bounds (no vertical respawn — they barely move)
    if (pos[ix + 1] > spec.yMax) pos[ix + 1] = spec.yMax;
    if (pos[ix + 1] < spec.yMin) pos[ix + 1] = spec.yMin;
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
    // Strong twinkle — per-point alpha sine with random phase
    const tw = 0.5 + 0.5 * Math.sin(t * 3.2 + phases[i] * 4.5 + seeds[i] * 0.01);
    alphas[i] = Math.max(0.05, base + (tw - 0.5) * 2 * aJit);
  }
  points.geometry.atmosphereAttributes.position.needsUpdate = true;
  points.geometry.atmosphereAttributes.alpha.needsUpdate = true;
}

// P4A cohort 2 — cave glowmoss spore drift. Slow upward + slight horizontal
// sway. Smaller drift constants than forest (cave is sparser, slower-paced).
// Same wrap-disc pattern: when a point clears yMax it respawns at yMin, when
// it leaves the horizontal disc it mirrors to the opposite edge.
function _tickCave(points, dt, hx, hz) {
  const spec = points.userData._atmosSpec;
  const pos  = points.geometry.atmosphereAttributes.position.array;
  const seeds = points.userData._seeds;
  points.userData._tickAcc += dt;
  const t = points.userData._tickAcc;
  const R = spec.radius, R2 = R * R;
  const N = spec.count;
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    // Slow rise (0.35 u/s ± 0.08 sin wave) — much slower than forest's 0.6+0.15.
    pos[ix + 1] += dt * (0.35 + Math.sin(t * 0.35 + seeds[i]) * 0.08);
    // Slight horizontal sway (0.10 u/s amplitude) — dripping cave is calm.
    pos[ix + 0] += dt * Math.sin(t * 0.45 + seeds[i] * 0.17) * 0.10;
    pos[ix + 2] += dt * Math.cos(t * 0.40 + seeds[i] * 0.21) * 0.10;
    if (pos[ix + 1] > spec.yMax) {
      pos[ix + 1] = spec.yMin + Math.random() * 0.8;
    }
    const dx = pos[ix + 0] - hx;
    const dz = pos[ix + 2] - hz;
    if (dx * dx + dz * dz > R2) {
      pos[ix + 0] = hx - dx;
      pos[ix + 2] = hz - dz;
    }
  }
  points.geometry.atmosphereAttributes.position.needsUpdate = true;
}

const _TICKERS = {
  forest:   _tickForest,
  twilight: _tickTwilight,
  cinder:   _tickCinder,
  void:     _tickVoid,
  cave:     _tickCave,
};
// ─────────────────────────────────────────────────────────────────────────────

export function buildEnv(scene, rendererSource) {
  const group = new THREE.Group();
  group.name = 'envGroup';

  // ── HDRI environment ──
  // Provides soft ambient reflections + light directionality for all PBR materials.
  // Doesn't override scene.background (we keep the dark fog color), only `environment`.
  new HDRLoader().load('assets/sprites/hdri/approaching_storm_1k.hdr', (hdrTex) => {
    hdrTex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdrTex;
    setSharedEnvironmentMap(hdrTex);
    // Preserve the legacy environment's softer 0.70 reflection strength, then
    // bind already-created upgraded assets at their own stored intensities.
    bindSharedEnvironmentMap(group, 0.70);
    bindSharedEnvironmentMap(scene);
  });

  // ── PBR ground: Poly Haven forrest_ground_01 (CC0) ──
  // diff + rough + normal at 1k. Heavy tiling (180×180) means 1k = plenty.
  const loader = new THREE.TextureLoader();
  const maxAniso = getCapabilitiesForRendererSource(rendererSource).maxAnisotropy || 1;
  const repeat = 180;

  function prepTex(t, srgb) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = Math.min(maxAniso, 8);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // Stage-keyed texture packs. Forest = default; Twilight = brown_mud (CC0
   // Poly Haven). Pre-loaded so swaps are instant when the player picks a stage.
  function loadPack(base, slots = null) {
    const use = slots || { diff: true, rough: true, normal: true };
    return {
      diff: use.diff === false ? null
        : prepTex(loader.load(base + 'diff.jpg', t => t.needsUpdate = true), true),
      rough: use.rough === false ? null
        : prepTex(loader.load(base + 'rough.jpg', t => t.needsUpdate = true), false),
      normal: use.normal === false ? null
        : prepTex(loader.load(base + 'nor_gl.jpg', t => t.needsUpdate = true), false),
    };
  }
  const groundPacks = {
    // Forest's generated albedo and procedural normal are assigned below;
    // don't download the retired 834 KB diff + 1.4 MB normal first.
    forest: loadPack('assets/sprites/forrest_ground_01/', { diff: false, rough: true, normal: false }),
    twilight: loadPack('assets/sprites/brown_mud/'),
  };

  // Cozy lived-in albedos generated as seamless production textures. Forest
  // now gets the same authored-detail treatment: clover, paw trails, petals,
  // roots, and leaf litter remain visible even between 3D prop clusters. These
  // maps replace base colour only; Forest/Twilight retain their PBR roughness
  // and normal response while constructed biomes keep the simple recipe.
  function loadStageAlbedo(stageId) {
    const t = loader.load(
      `assets/textures/ground_detail_${stageId}_512.webp`,
      tex => { tex.needsUpdate = true; },
    );
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // WORLD.groundSize is 2400u. 180 repeats yields a 13.3u source tile;
    // individual paw prints and petals therefore land around prop scale while
    // the larger painted rock/flower motifs remain flat ground detail instead
    // of looking like collision-sized objects.
    t.repeat.set(180, 180);
    t.anisotropy = Math.min(maxAniso, 8);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const livedInAlbedos = {
    forest: loadStageAlbedo('forest'),
    twilight: loadStageAlbedo('twilight'),
    cinder: loadStageAlbedo('cinder'),
    void: loadStageAlbedo('void'),
    cave: loadStageAlbedo('cave'),
  };
  groundPacks.forest.diff = livedInAlbedos.forest;
  groundPacks.twilight.diff = livedInAlbedos.twilight;

  // Constructed/underground biomes use their own authored albedo with constant
  // roughness. The old Cave normal map produced broad diagonal bands, so these
  // packs deliberately avoid reintroducing that broken relief texture.
  groundPacks.cinder = { diff: livedInAlbedos.cinder, rough: null, normal: null };
  groundPacks.void   = { diff: livedInAlbedos.void, rough: null, normal: null };
  groundPacks.cave   = { diff: livedInAlbedos.cave, rough: null, normal: null };

  // FOREST-V2-A35 (PR #139, PHASE 3 P3E): swap the forest pack's normal
  // map for a procedural, palette-neutral tangent-space map (mulberry32 +
  // 4-octave fBm + rejection-sampled pebble stamps). Replaces the 1.4 MB
  // Poly Haven `nor_gl.jpg`. NoColorSpace prevents sRGB decode (normal data
  // must stay linear). Matches diff/rough wrap+repeat so all three packs
  // tile identically. See tools/_gen_ground_normal.mjs.
  const groundNormalTex = loader.load(
    'assets/textures/forest_ground_normal_512.png',
    t => t.needsUpdate = true,
  );
  groundNormalTex.wrapS = groundNormalTex.wrapT = THREE.RepeatWrapping;
  groundNormalTex.repeat.set(repeat, repeat);
  groundNormalTex.anisotropy = Math.min(maxAniso, 8);
  groundNormalTex.colorSpace = THREE.NoColorSpace;
  groundPacks.forest.normal = groundNormalTex;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.groundSize, WORLD.groundSize, 1, 1),
    new THREE.MeshStandardMaterial({
      map: groundPacks.forest.diff,
      roughnessMap: groundPacks.forest.rough,
      normalMap: groundPacks.forest.normal,
      roughness: 0.95,
      metalness: 0.0,
      normalScale: new THREE.Vector2(0.6, 0.6),
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.08;
  ground.receiveShadow = true;
  group.add(ground);

  // Cinematic 3-light setup: warm key + cool fill + sky hemi. HDRI fills ambient.
  // Dropped raw AmbientLight (HDRI environment provides it already).
  // Sky=cool blue, ground=neutral dark gray (NOT green — green bounce was
  // tinting hero shadow with a sickly tint). Drop intensity slightly so the
  // shadow stays readably dark.
  const hemi = new THREE.HemisphereLight(0xaaccff, 0x1a1a1f, 0.28);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe4b8, 2.2);    // warm key
  sun.position.set(60, 80, 40);
  // Soft shadow casting — only the sun casts. Camera frustum sized to a 60u
  // box around the action area so we don't waste shadow-map texels.
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 4;          // PCFSoftShadow blur radius
  const sc = sun.shadow.camera;
  sc.near = 0.5; sc.far = 200;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40;
  sc.updateProjectionMatrix();
  // Make the shadow camera follow the hero — set up a target the engine
  // re-points each frame from main.js.
  sun.target.position.set(0, 0, 0);
  group.add(sun.target);
  group.add(sun);
  const fill = new THREE.DirectionalLight(0x5577aa, 0.25);  // cool fill
  fill.position.set(-30, 30, -30);
  group.add(fill);

  // ── Per-stage atmospheric particle clusters (iter 15) ──
  // Build all four at boot; applyStageTint toggles visibility per stage.
  // Each cluster ticks itself when active (tickAtmosphere below).
  const atmosClusters = {};
  for (const id of Object.keys(ATMOS_SPECS)) {
    const cluster = _buildAtmosCluster(ATMOS_SPECS[id]);
    cluster.name = `atmos_${id}`;
    group.add(cluster);
    atmosClusters[id] = cluster;
  }
  group.userData.atmosClusters = atmosClusters;
  group.userData._activeStageId = null;
  // P4A cohort 3 — expose groundPacks on envGroup userData so the cave smoke
  // phase 4 (and any future stage smoke) can verify a stage-specific pack
  // materialized rather than fell through to brown_mud. Texture references
  // already held by ground.material; this is a metadata handle only.
  group.userData.groundPacks = groundPacks;
  group.userData.livedInAlbedos = livedInAlbedos;

  scene.add(group);
  // Stash the sun on the group so main.js can re-point it each frame.
  group.userData.sun = sun;
  group.userData.hemi = hemi;
  group.userData.fill = fill;
  // Stash the ground mesh + scene ref so applyStageTint can recolor on demand.
  group.userData.ground = ground;
  group.userData.scene = scene;
  group.userData.baseFogColor = scene.fog ? scene.fog.color.getHex() : null;
  // Capture baseline lighting once so per-stage swaps can restore on forest.
  const BASE_LIGHT = {
    sunColor:    sun.color.getHex(),
    sunIntensity: sun.intensity,
    hemiSky:     hemi.color.getHex(),
    hemiGround:  hemi.groundColor.getHex(),
    hemiIntensity: hemi.intensity,
    fillColor:   fill.color.getHex(),
    fillIntensity: fill.intensity,
  };
  group.userData.applyStageTint = (stage) => {
    if (!stage) return;
    const id = stage.id;
    const isForest   = id === 'forest';
    const isTwilight = id === 'twilight';
    const isCinder   = id === 'cinder';
    const isVoid     = id === 'void';
    const isCave     = id === 'cave';
    const isKakiLand = id === 'kakiland';
    // Ground pack: Forest/ Twilight keep their organic surfaces; the three
    // constructed/underground biomes share the compact authored stone albedo
    // and become distinct through tint, lighting, and landscape composition.
    const packKey = isForest ? 'forest'
      : (isTwilight ? 'twilight' : (isCinder ? 'cinder' : (isVoid ? 'void' : 'cave')));
    const pack = groundPacks[packKey];
    // Kaki Land owns its floating-island terrain. Hide the shared infinite
    // ground there, then explicitly restore it for every normal stage/town.
    ground.visible = !isKakiLand;
    if (ground.material) {
      ground.material.map         = pack.diff;
      ground.material.roughnessMap= pack.rough || null;
      ground.material.normalMap   = pack.normal || null;
      const tint = stage.groundTint || 0xffffff;
      if (ground.material.color) ground.material.color.setHex(tint);
      // Cinder reads better at slightly higher roughness so highlights don't
      // smear over the hot fog. Cave sits between dry forest and cinder —
      // wet stone reads as 0.85 mean (texture variance ±0.08 over the top).
      ground.material.roughness = isCinder ? 1.0 : (isCave ? 0.85 : 0.95);
      ground.material.metalness = 0.0;
      ground.material.needsUpdate = true;
    }
    if (scene.fog && scene.fog.color) {
      scene.fog.color.setHex(stage.fogColor || group.userData.baseFogColor || 0x061008);
    }
    // ── Per-stage lighting (iter 14) ──
    // Reset to forest baseline, then mutate.
    sun.color.setHex(BASE_LIGHT.sunColor);
    sun.intensity = BASE_LIGHT.sunIntensity;
    hemi.color.setHex(BASE_LIGHT.hemiSky);
    hemi.groundColor.setHex(BASE_LIGHT.hemiGround);
    hemi.intensity = BASE_LIGHT.hemiIntensity;
    fill.color.setHex(BASE_LIGHT.fillColor);
    fill.intensity = BASE_LIGHT.fillIntensity;
    if (isTwilight) {
      // Cooler dusk: dim sun, blue-violet hemi.
      sun.color.setHex(0x9fb0e0);
      sun.intensity = 1.1;
      hemi.color.setHex(0x6a78a8);
      hemi.groundColor.setHex(0x1a1422);
      hemi.intensity = 0.20;
      fill.color.setHex(0x6a78c8);
      fill.intensity = 0.30;
    } else if (isCinder) {
      // Hot orange sun, scorched hemi.
      sun.color.setHex(0xff8a4a);
      sun.intensity = 1.8;
      hemi.color.setHex(0x884030);
      hemi.groundColor.setHex(0x2a0c08);
      hemi.intensity = 0.40;
      fill.color.setHex(0xaa3320);
      fill.intensity = 0.45;
    } else if (isVoid) {
      // Crypt-light: sun almost off, violet hemi — torches must carry it.
      sun.color.setHex(0x4a3a6a);
      sun.intensity = 0.4;
      hemi.color.setHex(0x553388);
      hemi.groundColor.setHex(0x0a0612);
      hemi.intensity = 0.35;
      fill.color.setHex(0x6644aa);
      fill.intensity = 0.20;
    } else if (isCave) {
      // P4A cohort 2 — Stonewright Caverns lighting. Cooler/darker than
      // forest: sun is a dim cold-blue stand-in for indirect light filtering
      // through the cave mouth, the hemi reads cool-mint above (matches the
      // glowmoss tint) and slot-1 shadow below (matches the fog), and the
      // fill is a low cool counter-bounce. Ambient base drop comes from
      // hemi.intensity going to 0.18 (vs forest 0.28). Cave's slot-2
      // groundTint + slot-1 fogColor pipe in from the STAGES entry above.
      sun.color.setHex(0x6d7a90);          // pale slate, not warm
      sun.intensity = 0.55;                // dim — caves don't get sun
      hemi.color.setHex(0x4c7a72);         // mint-shadow sky (slot-3-leaning)
      hemi.groundColor.setHex(0x1a1820);   // CAVE_PALETTE.shadow (slot 1)
      hemi.intensity = 0.18;               // darker than forest baseline 0.28
      fill.color.setHex(0x4c6a78);         // cool counter-bounce
      fill.intensity = 0.18;
    } else if (isKakiLand) {
      // High, clear sky: warm sunlight with cool cloud bounce. The island
      // builder supplies its own clouds/sky texture, so no generic fog tint.
      sun.color.setHex(0xffe3a8);
      sun.intensity = 1.75;
      hemi.color.setHex(0x89c9f2);
      hemi.groundColor.setHex(0x31517a);
      hemi.intensity = 0.42;
      fill.color.setHex(0x85d6ff);
      fill.intensity = 0.36;
    }
    // ── Per-stage atmospheric particles (iter 15) ──
    // Show only the cluster for the active stage; flag others off so
    // tickAtmosphere skips them. Reset _initialized so the first tick
    // re-centers the disc on the hero's current position.
    group.userData._activeStageId = id;
    if (atmosClusters) {
      for (const k of Object.keys(atmosClusters)) {
        const c = atmosClusters[k];
        c.visible = (k === id);
        if (c.visible) c.userData._initialized = false;
      }
    }
  };
  // ── Helltide overlay (iter 17) ──
  // Hot red-orange sky/fog + warm hemi shift while the Helltide event is
  // active. Snapshots the LIVE stage-tinted values at activation time so
  // restoration on endHelltide brings us back to the current stage (not the
  // forest baseline). Atmospheric particles are NOT touched here — they
  // continue running in parallel under the overlay tint.
  //
  // applyHelltideOverlay(active, intensity)
  //   active=true  → snapshot + lerp toward hellfire tint over ~1.5s
  //   active=false → lerp back to snapshot over ~1.5s, clear snapshot at end
  // Intensity (default 1.0) scales how aggressive the red shift is so future
  // callers can do a "high-tier Helltide" without re-authoring the overlay.
  let _helltideTween = null;   // { dir: +1 or -1, t: 0..1, intensity, snap, target }
  const _HELLTIDE_TARGET = {
    sun:    { color: 0xff5a28, intensity: 1.6 },
    hemi:   { sky: 0xff6e3a, ground: 0x3a0a06, intensity: 0.55 },
    fill:   { color: 0xff4422, intensity: 0.55 },
    fogHex: 0x3a0a06,
  };
  function _hexLerp(a, b, k) {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return ((Math.round(ar + (br - ar) * k) << 16) |
            (Math.round(ag + (bg - ag) * k) << 8)  |
             Math.round(ab + (bb - ab) * k)) >>> 0;
  }
  group.userData.applyHelltideOverlay = (active, intensity) => {
    const itn = (intensity == null) ? 1.0 : Math.max(0, Math.min(1.5, intensity));
    if (active) {
      // Snapshot CURRENT (live, stage-tinted) values — not the baseline.
      const snap = {
        sunColor: sun.color.getHex(), sunIntensity: sun.intensity,
        hemiSky:  hemi.color.getHex(), hemiGround: hemi.groundColor.getHex(),
        hemiIntensity: hemi.intensity,
        fillColor: fill.color.getHex(), fillIntensity: fill.intensity,
        fogHex: scene.fog && scene.fog.color ? scene.fog.color.getHex() : null,
      };
      _helltideTween = { dir: +1, t: 0, intensity: itn, snap, dur: 1.5 };
    } else {
      if (!_helltideTween) return;   // nothing to undo
      _helltideTween = { ...(_helltideTween), dir: -1, t: 0, dur: 1.5 };
    }
  };
  // Per-frame tween advancer; called from tickAtmosphere.
  function _stepHelltideTween(dt) {
    if (!_helltideTween) return;
    const tw = _helltideTween;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const k = tw.dir > 0 ? tw.t : (1 - tw.t);   // 0→1 ramp in, 1→0 ramp out
    const blend = k * tw.intensity;
    const snap = tw.snap;
    const T = _HELLTIDE_TARGET;
    sun.color.setHex(_hexLerp(snap.sunColor, T.sun.color, blend));
    sun.intensity = snap.sunIntensity + (T.sun.intensity - snap.sunIntensity) * blend;
    hemi.color.setHex(_hexLerp(snap.hemiSky, T.hemi.sky, blend));
    hemi.groundColor.setHex(_hexLerp(snap.hemiGround, T.hemi.ground, blend));
    hemi.intensity = snap.hemiIntensity + (T.hemi.intensity - snap.hemiIntensity) * blend;
    fill.color.setHex(_hexLerp(snap.fillColor, T.fill.color, blend));
    fill.intensity = snap.fillIntensity + (T.fill.intensity - snap.fillIntensity) * blend;
    if (snap.fogHex != null && scene.fog && scene.fog.color) {
      scene.fog.color.setHex(_hexLerp(snap.fogHex, T.fogHex, blend));
    }
    if (tw.t >= 1) {
      if (tw.dir < 0) _helltideTween = null;  // fully restored — release snap
      // dir > 0 finished: hold at full hellfire tint until endHelltide flips it.
    }
  }
  // ── Tick the active stage's atmospheric particles (iter 15) ──
  // Called once per gameplay frame from main.js. dt is real-time (not
  // game-time) so atmosphere keeps drifting during hit-stop/pause for life.
  // hero is optional; falls back to (0,0) if undefined (e.g. title-screen
  // hover where the run hasn't started yet — but main.js guards anyway).
  group.userData.tickAtmosphere = (dt, hero) => {
    _stepHelltideTween(dt);
    const id = group.userData._activeStageId;
    if (!id) return;
    const cluster = atmosClusters[id];
    if (!cluster || !cluster.visible) return;
    const ticker = _TICKERS[id];
    if (!ticker) return;
    const hx = hero && hero.pos ? hero.pos.x : 0;
    const hz = hero && hero.pos ? hero.pos.z : 0;
    // First-frame re-center: shift the disc-centered initial spawn so the
    // points appear around the hero, not origin.
    if (!cluster.userData._initialized) {
      const pos = cluster.geometry.atmosphereAttributes.position.array;
      const N = cluster.userData._atmosSpec.count;
      for (let i = 0; i < N; i++) {
        pos[i * 3 + 0] += hx;
        pos[i * 3 + 2] += hz;
      }
      cluster.geometry.atmosphereAttributes.position.needsUpdate = true;
      cluster.userData._initialized = true;
    }
    // Clamp dt for safety (long pauses / tab-switch resume).
    const safeDt = Math.min(dt, 0.05);
    ticker(cluster, safeDt, hx, hz);
  };
  return group;
}
