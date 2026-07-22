/**
 * Cave glowmoss mushroom clusters (P4A cohort 10, 2026-05-20).
 *
 * Bioluminescent undergrowth clustered at the FEET of the cohort-9 perimeter
 * stalagmites — visual story: "moss has grown at the foot of the stone
 * pillars." Pure background flora at the cavern edge (r≈30-38), NOT in the
 * playfield.
 *
 * Why perimeter-only (advisor, cohort 10): a standing slot-3-emissive object in
 * the played band would stack a third moss-glow source (after the glowmoss
 * floor patches + gloomshrimp) AND add a vertical silhouette — exactly what
 * distinguishes a 3D pickup/XP-gem from flat decor in a survivors-like. With no
 * cave screenshot gate yet (CC7), pickup-confusion is the one failure mode that
 * can't be smoke-tested, so the mushrooms live entirely outside the play area.
 *
 * Two-tone, so the silhouette does the disambiguation work:
 *   - Stalk: CAVE_PALETTE.stone (slot 2), flatShading, NO emissive.
 *   - Cap:   slot-3 moss emissive dome, bloom-tagged (matches the stalactite
 *            tips / glowmoss patches glow band).
 *
 * Anchors mirror cohort-9's stalagmite ring (8 clusters, radius 33/39
 * alternating) so the mushrooms co-locate with the pillars; tighter scatter
 * (2.5) since undergrowth bunches at the base. Height ≤ ~0.9 so they read as
 * undergrowth, not a competing silhouette with the ≤5u stalagmites.
 *
 * Determinism: inlined mulberry32 seeded 0xC0CA0E5 (next in the cave-cohort
 * sequence: c2=…E1, c3=…E2, c5=…E3, c9=…E4). NOT routed through dailyRng.
 *
 * Static decor — no tickCave wiring (steady perimeter glow reads as "always
 * there, ignore it", which is the point of edge decor). build + dispose only.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';
import { BLOOM_LAYER } from '../../rendering/bloomLayers.js';

const COHORT_SEED = 0xC0CA0E5;
const STALK_H     = 0.42;       // base stalk height (scaled per-instance)
const STALK_TOP_R = 0.07;
const STALK_BOT_R = 0.11;
const CAP_R       = 0.20;       // sphere radius before the dome-flatten scale.y

// Mirror cohort-9 (caveStalagmites.js) anchors so mushrooms ring the same
// pillars. 8 clusters × 3 = 24 mushrooms. Tighter scatter than the stalagmites
// (undergrowth bunches at the base). Min instance r ≈ 33 - 2.5 = 30.5 (≥27).
const CLUSTER_COUNT     = 8;
const CLUSTER_RADII     = [33, 39];
const PER_CLUSTER       = 3;
const CLUSTER_SCATTER_R = 2.5;

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

let _state = null;   // { group, stalkInst, capInst, stalkGeo, capGeo, stalkMat, capMat, count }

/**
 * Build the mushroom clusters under `parent` (the caveStage group). Returns
 * `{ group, count }` so caveStage.js can record mushroomCount on its userData
 * for the smoke probe. Idempotent — disposes a prior build first.
 */
export function buildCaveMushrooms(parent) {
  if (_state) disposeCaveMushrooms();
  if (!parent) return { group: null, count: 0 };

  const total = CLUSTER_COUNT * PER_CLUSTER;

  const stalkGeo = new THREE.CylinderGeometry(STALK_TOP_R, STALK_BOT_R, STALK_H, 6, 1, false);
  const stalkMat = new THREE.MeshStandardMaterial({
    color: CAVE_PALETTE.stone,   // slot 2 — silhouette disambiguates from pickups
    roughness: 0.9,
    metalness: 0.05,
    flatShading: true,
  });

  // Cap: a sphere flattened per-instance (scale.y) into a dome. Slot-3 moss
  // emissive on the bloom layer, matching the stalactite-tip glow band.
  const capGeo = new THREE.SphereGeometry(CAP_R, 10, 7);
  const capMat = new THREE.MeshStandardMaterial({
    color:             0x1f4a40,        // dark moss base so the emissive pops
    emissive:          CAVE_PALETTE.moss,
    emissiveIntensity: 1.4,             // style-doc glowmoss band 1.4-2.0
    roughness:         0.4,
    metalness:         0.05,
  });

  const stalkInst = new THREE.InstancedMesh(stalkGeo, stalkMat, total);
  const capInst   = new THREE.InstancedMesh(capGeo, capMat, total);
  stalkInst.castShadow = false; stalkInst.receiveShadow = false;
  capInst.castShadow = false;   capInst.receiveShadow = false;
  capInst.layers.enable(BLOOM_LAYER);
  stalkInst.name = 'caveStage_mushroomStalks';
  capInst.name   = 'caveStage_mushroomCaps';

  const rng = _mulberry32(COHORT_SEED);
  const dummy = new THREE.Object3D();

  let i = 0;
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const ang = (c / CLUSTER_COUNT) * Math.PI * 2;
    const cr = CLUSTER_RADII[c % CLUSTER_RADII.length];
    const cx = Math.cos(ang) * cr;
    const cz = Math.sin(ang) * cr;
    for (let k = 0; k < PER_CLUSTER; k++) {
      const theta = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * CLUSTER_SCATTER_R;
      const x = cx + Math.cos(theta) * r;
      const z = cz + Math.sin(theta) * r;
      // Overall size 0.7-1.3 → max stalk height 0.42*1.3 = 0.55, cap top ≈ 0.76
      // (< 0.9 cap → undergrowth, not a competing silhouette).
      const sc = 0.7 + rng() * 0.6;
      const yaw = rng() * Math.PI * 2;

      // Stalk: centered at half its scaled height so the foot rests on y=0.
      dummy.position.set(x, (STALK_H * sc) / 2, z);
      dummy.scale.set(sc, sc, sc);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      stalkInst.setMatrixAt(i, dummy.matrix);

      // Cap: sits atop the stalk, flattened to a dome (scale.y * 0.55).
      dummy.position.set(x, STALK_H * sc + CAP_R * sc * 0.2, z);
      dummy.scale.set(sc, sc * 0.55, sc);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      capInst.setMatrixAt(i, dummy.matrix);
      i++;
    }
  }
  stalkInst.instanceMatrix.needsUpdate = true;
  capInst.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'caveStage_mushrooms_grp';
  group.add(stalkInst);
  group.add(capInst);
  parent.add(group);

  _state = { group, stalkInst, capInst, stalkGeo, capGeo, stalkMat, capMat, count: total };
  return { group, count: total };
}

/**
 * Tear down the mushroom clusters. Idempotent — safe when not mounted.
 */
export function disposeCaveMushrooms() {
  if (!_state) return false;
  const { group, stalkGeo, capGeo, stalkMat, capMat } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { stalkGeo && stalkGeo.dispose(); } catch (_) {}
  try { capGeo && capGeo.dispose(); } catch (_) {}
  try { stalkMat && stalkMat.dispose(); } catch (_) {}
  try { capMat && capMat.dispose(); } catch (_) {}
  _state = null;
  return true;
}
