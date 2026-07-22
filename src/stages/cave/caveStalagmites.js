/**
 * Cave stalagmite perimeter formations (P4A cohort 9, 2026-05-20).
 *
 * Floor-rising stone columns ringing the cave bounds — the mirror of the
 * cohort-2 hanging stalactites (caveStalactites.js). Where the stalactites
 * dangle from the ceiling over the play area, these rise from the floor at the
 * PERIMETER (r≈33-39, well beyond the ~r≤26 decor footprint) so the cavern
 * reads as enclosed by stone without boxing in the gameplay.
 *
 * Why pillars, not a continuous wall ring: the camera is an OrthographicCamera
 * at hero-relative offset (40,60,40) (~47° down). A continuous textured wall
 * ring is a blind-tune trap on an iso/ortho cam (near-side occlusion, UV
 * stretch) — deferred under cron-prompt-v3 step 4d. Discrete GAPPED pillars at
 * the periphery are the proven-safe pattern (same family as the stalactite
 * clusters + town fence): you see between them, and at height ≤~5 they sit well
 * below the sightline through origin so they never occlude the play area.
 *
 * Pro-asset: satisfies the P4A "stone wall textures" acceptance item via the
 * cohort-3 cave_stone diffuse + normal maps (assets/textures/cave_stone_*.png),
 * loaded here mirroring env.js#loadPngTex config. NOT flat placeholder geometry
 * (per memory/feedback_kitty_kaki_fx_quality) — the normal map gives wet-stone
 * relief under the cave's dim hemi light + bloom.
 *
 * Determinism: scatter uses inlined mulberry32 seeded with 0xC0CA0E4 (next in
 * the cave-cohort seed sequence: c2=…E1, c3=…E2, c5=…E3). NOT routed through
 * dailyRng — cave geometry looks identical every run, only spawn is date-seeded.
 *
 * Static decor: no per-frame animation, so this cohort is NOT wired into
 * tickCave — build + dispose only (matches the stalactite cohort's static
 * lifecycle). dispose tears down geometry + material + the 3 textures.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';

const COHORT_SEED = 0xC0CA0E4;
const BODY_HEIGHT = 3.6;        // base stalagmite height (scaled per-instance)
const BASE_R      = 0.62;       // wide foot at floor
// ConeGeometry maps U around the circumference (0..1) and V base→tip (0..1).
// With RepeatWrapping, repeat (2,3) tiles the stone twice around + three times
// up the column so a tall thin pillar doesn't stretch the texture into smears.
// This is the one blind-tune knob in this cohort (no cave screenshot gate) —
// a later visual pass can nudge it without re-deriving anything else.
const TEX_REPEAT  = { u: 2, v: 3 };

// 8 perimeter clusters at 45° spacing, alternating radius 33/39 for an organic
// (non-bar-graph) ring. 4 stalagmites each = 32 InstancedMesh instances. Center
// (hero spawn ~origin) + the r≤26 decor footprint (stalactites at r=22, glowmoss
// 12-26u annulus) stay entirely clear — min instance r ≈ 33 - SCATTER ≈ 30.
const CLUSTER_COUNT     = 8;
const CLUSTER_RADII     = [33, 39];   // alternated by index parity
const PER_CLUSTER       = 4;
const CLUSTER_SCATTER_R = 3.0;        // per-stalagmite jitter inside a cluster

// Inlined deterministic RNG (same algorithm as caveStalactites.js / dailyRng.js,
// kept local so cave geometry is independent of the daily-seed plumbing).
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _state = null;   // { group, inst, geo, mat, textures:[], count }

// Load a cave_stone PNG mirroring env.js#loadPngTex: RepeatWrapping, modest
// anisotropy, sRGB for the color map / NoColorSpace for the normal data.
function _loadStoneTex(loader, url, srgb) {
  const t = loader.load(url, (tx) => { tx.needsUpdate = true; });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(TEX_REPEAT.u, TEX_REPEAT.v);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/**
 * Build the perimeter stalagmite formations and add them under `parent` (the
 * caveStage group). Returns `{ group, count }` so caveStage.js can record
 * stalagmiteCount on its userData for the smoke probe. Idempotent — disposes a
 * prior build first.
 */
export function buildCaveStalagmites(parent) {
  if (_state) disposeCaveStalagmites();
  if (!parent) return { group: null, count: 0 };

  const total = CLUSTER_COUNT * PER_CLUSTER;

  // ConeGeometry(radius, height, radialSegments): apex points +y by default, so
  // no flip needed — base sits on the floor, tip rises. Default vertex normals
  // are smooth (required for the normal map to read; do NOT use flatShading).
  const geo = new THREE.ConeGeometry(BASE_R, BODY_HEIGHT, 7, 1, false);

  const loader = new THREE.TextureLoader();
  const diffuse = _loadStoneTex(loader, 'assets/textures/cave_stone_diffuse.png', true);
  const normal  = _loadStoneTex(loader, 'assets/textures/cave_stone_normal.png', false);

  // color = CAVE_PALETTE.stone: the diffuse PNG is palette-locked GRAYSCALE
  // (cohort 3), so the material color drives the wet-stone hue — and doubles as
  // the fallback tint if the PNG fails to fetch. roughness fixed at 0.9 (no
  // rough map: it would force roughness=1.0 + another blind knob — advisor).
  const mat = new THREE.MeshStandardMaterial({
    color:      CAVE_PALETTE.stone,
    map:        diffuse,
    normalMap:  normal,
    roughness:  0.9,
    metalness:  0.05,
  });

  const inst = new THREE.InstancedMesh(geo, mat, total);
  inst.castShadow = false; inst.receiveShadow = false;   // perf parity w/ stalactites
  inst.name = 'caveStage_stalagmites';

  const rng = _mulberry32(COHORT_SEED);
  const dummy = new THREE.Object3D();

  let i = 0;
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const ang = (c / CLUSTER_COUNT) * Math.PI * 2;
    const cr = CLUSTER_RADII[c % CLUSTER_RADII.length];
    const cx = Math.cos(ang) * cr;
    const cz = Math.sin(ang) * cr;
    for (let k = 0; k < PER_CLUSTER; k++) {
      // Polar scatter inside the cluster.
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * CLUSTER_SCATTER_R;
      const x = cx + Math.cos(theta) * r;
      const z = cz + Math.sin(theta) * r;

      // Per-instance size variation. sy 0.7-1.4 → max height ≈ 5.04 (< 6, stays
      // below the iso sightline through origin → no play-area occlusion).
      const sy = 0.7 + rng() * 0.7;
      const sx = 0.8 + rng() * 0.4;
      const sz = 0.8 + rng() * 0.4;

      // Slight lean so the ring doesn't look plumb/manufactured (±~10°).
      const lean = (rng() - 0.5) * 0.32;
      const tilt = (rng() - 0.5) * 0.32;

      // Cone center sits at half its (scaled) height so the base rests on y=0.
      const halfH = (BODY_HEIGHT * sy) / 2;
      dummy.position.set(x, halfH, z);
      dummy.scale.set(sx, sy, sz);
      dummy.rotation.set(lean, rng() * Math.PI * 2, tilt);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      i++;
    }
  }
  inst.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'caveStage_stalagmites_grp';
  group.add(inst);
  parent.add(group);

  _state = { group, inst, geo, mat, textures: [diffuse, normal], count: total };
  return { group, count: total };
}

/**
 * Tear down the stalagmite formations. Idempotent — safe when not mounted.
 * Disposes geometry, material, and both stone textures.
 */
export function disposeCaveStalagmites() {
  if (!_state) return false;
  const { group, geo, mat, textures } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { geo && geo.dispose(); } catch (_) {}
  try { mat && mat.dispose(); } catch (_) {}
  if (Array.isArray(textures)) {
    for (const t of textures) { try { t && t.dispose(); } catch (_) {} }
  }
  _state = null;
  return true;
}
