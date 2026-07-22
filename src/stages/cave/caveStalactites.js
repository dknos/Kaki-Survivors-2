/**
 * Cave stalactite landmark cluster (P4A cohort 2, 2026-05-18).
 *
 * Replaces the Box-as-stalactite placeholder from cohort 1. Authored per
 * docs/CAVE_VISUAL_STYLE.md row P4A-c2:
 *   - Tapered (top-wide / tip-narrow) conical stalactites hanging from the
 *     "ceiling" at y=3.5, tip pointing down.
 *   - 3-5 stalactites per cluster, 4-6 clusters scattered around the cave
 *     bounds (ring + 1-2 interior offsets). Center stays clear so hero spawn
 *     isn't obstructed.
 *   - InstancedMesh for the stone bases (≥6 instances → worth the batch).
 *   - Separate InstancedMesh for the slot-3 moss-emissive tip glow patches,
 *     bloom-tagged via BLOOM_LAYER per the Spider Web FX quality bar.
 *
 * Determinism: scatter uses a local mulberry32 seeded with `0xC0CA0E1`
 * (cohort seed). NOT routed through dailyRng — cave geometry should look
 * the same on Tuesday and Wednesday daily runs, only spawn behavior is
 * date-seeded.
 *
 * Palette discipline:
 *   - Stone base: CAVE_PALETTE.stone (slot 2), roughness 0.85.
 *   - Tip glow:   CAVE_PALETTE.moss  (slot 3), emissive 1.6 (per style doc
 *     "glowmoss 1.4-2.0" band — split-the-middle for tips that aren't
 *     primary glowmoss patches).
 *   - flatShading on the stone base so silhouettes catch light asymmetrically
 *     under bloom (style doc §"Line Weight + Bloom Feel").
 *
 * Disposal: single module-level state pointer; idempotent disposeStalactites
 * tears down both InstancedMeshes + their geometries + materials, matching
 * the dispose contract from src/arenaDecor.js.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';
import { BLOOM_LAYER } from '../../rendering/bloomLayers.js';

const COHORT_SEED = 0xC0CA0E1;
const CEILING_Y   = 3.5;       // hang point per spec
const BODY_HEIGHT = 2.6;       // tip dangles to y ≈ 0.9
const BODY_TOP_R  = 0.55;      // wide top (attached to "ceiling")
const BODY_TIP_R  = 0.06;      // tapered tip
const TIP_R       = 0.18;      // glow patch sphere radius

// 4 ring clusters + 2 interior. 6 clusters × 4-5 stalactites = 24-30 instances.
// Cluster anchors are author-placed so the smoke gets a predictable scatter
// pattern; per-instance jitter inside the cluster uses the seeded RNG so the
// look is varied but deterministic.
//
// Center keep-out: hero spawns near (0,0); we keep cluster anchors ≥10 units
// from origin and interior offsets stay outside a ~5u radius around (0,0).
const CLUSTER_ANCHORS = [
  { cx:  22, cz:   0, count: 5 },   // ring east
  { cx: -22, cz:   0, count: 5 },   // ring west
  { cx:   0, cz:  22, count: 4 },   // ring north
  { cx:   0, cz: -22, count: 4 },   // ring south
  { cx:  12, cz:  14, count: 4 },   // interior NE
  { cx: -14, cz: -10, count: 4 },   // interior SW
];
const CLUSTER_SCATTER_R = 3.5;    // per-stalactite jitter inside cluster

// Tiny local deterministic RNG. Same algorithm as src/dailyRng.js but
// inlined to keep cave geometry independent of the daily-seed plumbing —
// we want consistent cave look every run, not per-day.
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

let _state = null;   // { group, bodyInst, tipsInst, bodyGeo, tipsGeo, bodyMat, tipsMat, count, tipPositions }

/**
 * Build the stalactite cluster group and add it to `parent`. Returns the
 * mounted group (already added). Caller is responsible for attaching the
 * group to caveStage if `parent` is the scene; here we always add to the
 * group the caller passes in so caveStage.js can parent us under its own
 * `caveStage` group.
 *
 * Returns `{ group, count }` so the caller can record stalactiteCount on
 * the caveStage userData for the smoke probe.
 */
export function buildStalactiteCluster(parent) {
  if (_state) disposeStalactites();
  if (!parent) return { group: null, count: 0 };

  let total = 0;
  for (const a of CLUSTER_ANCHORS) total += a.count;

  // Tapered cylinder = stalactite body. CylinderGeometry(rTop, rBottom, height).
  // We want the WIDE end at the ceiling and the NARROW end at the tip, but
  // the cylinder's local y-axis points UP and we want the tip pointing
  // DOWN — so we flip via rotation.z = PI per-instance, which swaps top
  // and bottom radii from the viewer's perspective AND points the tip down.
  // Simpler: just author the geometry with BODY_TOP_R as the "bottom" radius
  // (the geometry's local-y- end) and rotate by PI so the geometry's local-y-
  // becomes world +y. Net effect: wide top at ceiling, narrow tip down.
  const bodyGeo = new THREE.CylinderGeometry(
    BODY_TIP_R,        // local top (after rotate = world bottom = tip)
    BODY_TOP_R,        // local bottom (after rotate = world top = ceiling)
    BODY_HEIGHT,
    7,                 // 7-sided silhouette reads more "rock" than 8
    1,
    false,
  );
  const bodyMat = new THREE.MeshStandardMaterial({
    color:     CAVE_PALETTE.stone,
    roughness: 0.85,
    metalness: 0.05,
    flatShading: true,
  });

  // Tip glow patch — small sphere at the bottom of each stalactite. Slot-3
  // moss emissive, bloom-tagged. Sphere geometry reads as a wet droplet of
  // bioluminescence — matches the "glowmoss patches" texture row.
  const tipsGeo = new THREE.SphereGeometry(TIP_R, 10, 8);
  const tipsMat = new THREE.MeshStandardMaterial({
    color:             CAVE_PALETTE.moss,
    emissive:          CAVE_PALETTE.moss,
    emissiveIntensity: 1.6,           // style doc band: glowmoss 1.4-2.0
    roughness:         0.30,
    metalness:         0.05,
    transparent:       true,
    opacity:           0.95,
  });

  const bodyInst = new THREE.InstancedMesh(bodyGeo, bodyMat, total);
  const tipsInst = new THREE.InstancedMesh(tipsGeo, tipsMat, total);
  tipsInst.layers.enable(BLOOM_LAYER);     // glow patches bloom
  bodyInst.castShadow = false; bodyInst.receiveShadow = false;
  tipsInst.castShadow = false; tipsInst.receiveShadow = false;
  bodyInst.name = 'caveStage_stalactiteBodies';
  tipsInst.name = 'caveStage_stalactiteTips';

  const rng = _mulberry32(COHORT_SEED);
  const dummy = new THREE.Object3D();
  // P4A cohort 4: stash per-stalactite tip world positions so the ceiling-drip
  // particle system (src/stages/cave/caveCeilingDrips.js) can spawn drips from
  // each tip without re-deriving matrices. Filled in-loop below; exposed via
  // getStalactiteTipPositions() — single read-only consumer, no mutation.
  const tipPositions = [];

  let i = 0;
  for (const a of CLUSTER_ANCHORS) {
    for (let k = 0; k < a.count; k++) {
      // Polar scatter inside cluster.
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * CLUSTER_SCATTER_R;
      const x = a.cx + Math.cos(theta) * r;
      const z = a.cz + Math.sin(theta) * r;

      // Per-instance length variation so the cluster doesn't look like a
      // bar-graph. Scale Y between 0.75-1.20 of the base height; XZ stays
      // closer to 1.0 so silhouettes don't read as fat-vs-thin.
      const sy = 0.75 + rng() * 0.45;
      const sx = 0.85 + rng() * 0.30;
      const sz = 0.85 + rng() * 0.30;

      // Hang from ceiling: rotate PI around z so geometry's local +y points
      // DOWN in world. That puts the wide end (geometry's -y face) at world
      // top and the tip (geometry's +y face) at world bottom.
      // Cylinder center sits at y = CEILING_Y - (BODY_HEIGHT * sy) / 2.
      const halfH = (BODY_HEIGHT * sy) / 2;
      const bodyY = CEILING_Y - halfH;

      // Slight per-instance lean so they don't all hang plumb. ±0.18 rad
      // (~±10°) feels organic without making them look broken.
      const lean = (rng() - 0.5) * 0.36;
      const tilt = (rng() - 0.5) * 0.36;

      dummy.position.set(x, bodyY, z);
      dummy.scale.set(sx, sy, sz);
      dummy.rotation.set(lean, rng() * Math.PI * 2, Math.PI + tilt);
      dummy.updateMatrix();
      bodyInst.setMatrixAt(i, dummy.matrix);

      // Tip glow sphere sits AT the geometry tip — that's at world y = bodyY
      // - halfH after rotation (since we flipped the cylinder). Center the
      // glow at that point with no rotation/scale jitter (uniform glow reads
      // better than skewed under bloom).
      const tipY = bodyY - halfH;
      dummy.position.set(x, tipY, z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      tipsInst.setMatrixAt(i, dummy.matrix);

      // P4A cohort 4: record this tip's world position for drip spawning.
      tipPositions.push({ x, y: tipY, z });

      i++;
    }
  }
  bodyInst.instanceMatrix.needsUpdate = true;
  tipsInst.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'caveStage_stalactites';
  group.add(bodyInst);
  group.add(tipsInst);
  parent.add(group);

  _state = {
    group, bodyInst, tipsInst,
    bodyGeo, tipsGeo, bodyMat, tipsMat,
    count: total,
    tipPositions,
  };
  return { group, count: total };
}

/**
 * P4A cohort 4: expose stalactite tip world positions for the ceiling-drip
 * particle system. Returns an array of `{x, y, z}` (one per stalactite tip,
 * cohort-2 stalactite spawn order). Empty array when the cluster isn't
 * mounted — caller should self-gate. Read-only contract: do NOT mutate.
 *
 * Minimal-diff addition: positions are recorded during the existing build
 * loop above (no recomputation, no extra traversal).
 */
export function getStalactiteTipPositions() {
  if (!_state || !_state.tipPositions) return [];
  return _state.tipPositions;
}

/**
 * Tear down the stalactite cluster. Idempotent — safe to call when not
 * mounted. Disposes both geometries + both materials.
 */
export function disposeStalactites() {
  if (!_state) return false;
  const { group, bodyGeo, tipsGeo, bodyMat, tipsMat } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { bodyGeo && bodyGeo.dispose(); } catch (_) {}
  try { tipsGeo && tipsGeo.dispose(); } catch (_) {}
  try { bodyMat && bodyMat.dispose(); } catch (_) {}
  try { tipsMat && tipsMat.dispose(); } catch (_) {}
  _state = null;
  return true;
}
