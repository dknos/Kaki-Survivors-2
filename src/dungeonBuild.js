/**
 * dungeonBuild.js — game-side mesh builder for a generated dungeon layout.
 *
 * Consumes a plain-data layout from dungeonGen.js (generateDungeon) and turns
 * it into THREE meshes built from the KayKit "Dungeon Remastered" kit already
 * registered in assets.js (kkd_* keys, loaded by preloadDungeonKit).
 *
 * Design constraints (see scratchpad/map-catacomb.md):
 *   - Draw-call frugal: floor cells, pool/grate cells, wall edges, and torch
 *     flames are each ONE InstancedMesh (~6 shell draws for a 14-room dungeon,
 *     not hundreds of clones). Feature props (braziers/banners/candles) are
 *     low-count individual clones. Repeated props (pillars, rubble) instance.
 *   - Never trust GLB units: the floor + wall tile Box3 is measured once at
 *     build to derive the fit-scale onto a FIXED world cell (CELL = 2.0u, the
 *     generator's documented "2 world units per cell"). CELL is fixed so the
 *     collision grid + entry point stay identical across the primitive first-
 *     build and the GLB rebuild (dress-later). All meshes null-guard to a
 *     BoxGeometry/PlaneGeometry primitive so a not-yet-cached kit still builds.
 *   - Fixed NE-high ortho camera (hero + (22,38,22)): walls south/east of the
 *     walkable space sit between camera and hero and occlude. So walls on the
 *     NORTH/WEST edge of a floor cell (far side) are full height; walls on the
 *     SOUTH/EAST edge (near side) are shortened via per-instance Y-scale.
 *     [Deviation: the task said full-height where FLOOR-neighbor is north/west,
 *      but that is the occluding side given camera at +x/+z — map-catacomb.md
 *      line 27 is authoritative ("tall walls south/east of walkable space
 *      occlude"). kkd_wall_half is half-WIDTH/full-HEIGHT (verified by bbox),
 *      so it can't reduce occlusion; a per-instance Y-scale of the standard
 *      wall gives a real short parapet in a single draw call.]
 *   - Torches: an emissive flame cone on EVERY anchor (bloom layer), but only a
 *     POOL of 5 THREE.PointLight reassigned each tick to the anchors nearest
 *     the hero (forward renderer — per-light cost is real). torchTick is
 *     allocation-free.
 */
import * as THREE from 'three';
import { cloneCached } from './assets.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { FLOOR, WALL, POOL } from './dungeonGen.js';

// World units per grid cell (fixed — the generator is authored for 2u cells).
const CELL = 2.0;
const SHORT_SCALE = 0.5;   // near-edge (S/E) wall height factor vs full wall
const TORCH_POOL = 5;      // live PointLights reassigned to nearest anchors
export const DOOR_LOCK_PROGRESSION = 1;
export const DOOR_LOCK_ENCOUNTER = 2;

// Prop kind → { key, targetH, mode } mapping. Only kkd_* keys (guaranteed by
// preloadDungeonKit); kinds with no matching kit asset are dropped. targetH is
// the world height the bbox is normalised to (feet on floor).
const PROP_INSTANCED = {
  pillar: { key: 'kkd_pillar', targetH: 2.7 },
  debris: { key: 'kkd_rubble', targetH: 0.75 },
  grave:  { key: 'kkd_coffin', targetH: 0.72 },
  bones:  { key: 'kkd_bone1', targetH: 0.28 },
};
const PROP_SINGLE = {
  brazier:      { key: 'kkd_candle3', targetH: 1.1 },
  banner:       { key: 'kkd_banner',  targetH: 3.2 },
  candle:       { key: 'kkd_candle',  targetH: 1.0 },
  shrineCrystal:{ key: 'kkd_candle3', targetH: 1.4 },
  sarco:        { key: 'kkd_crypt',   targetH: 1.15 },
};
// Dropped kinds (no clean kit asset OR handled functionally by catacomb.js):
//   chest (spawnChest), bossCrystal, ring, moss, roots,
//   icicle, shardIce, banner handled above.

/* ---------- build-time scratch (GC'd after build; never per-frame) --------- */
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _sz = new THREE.Vector3();

/**
 * Extract a single (geometry, material) instancing source from a cached GLB.
 * Bakes the mesh's local transform into a cloned geometry so the caller only
 * needs a world matrix per instance. Returns null when the key isn't cached.
 */
function _meshSource(key) {
  const root = cloneCached(key);
  if (!root) return null;
  root.updateMatrixWorld(true);
  let found = null;
  root.traverse((o) => {
    if (found) return;
    if (o.isMesh && !o.isSkinnedMesh && o.geometry && o.material) found = o;
  });
  if (!found) return null;
  const geo = found.geometry.clone();
  geo.applyMatrix4(found.matrixWorld);   // root is at origin → local == world
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.computeBoundingBox();
  return { geo, mat: Array.isArray(found.material) ? found.material[0] : found.material };
}

export function buildDungeon(layout, parentGroup) {
  const { W, H, grid, roomId, doorway, torches, props, rooms, entrance, spawns } = layout;
  const idx = (x, y) => y * W + x;

  const group = new THREE.Group();
  group.name = 'dungeonBuild';
  if (parentGroup) parentGroup.add(group);

  // Owned disposables (geometries/materials WE created — clones + primitives).
  // Shared cache materials/geometries (individual prop clones) are NOT here:
  // disposing them would corrupt GLTF_CACHE for the next entry.
  const _owned = [];
  const _own = (r) => { if (r) _owned.push(r); return r; };

  const _sealed = new Uint8Array(W * H);
  const _collisionSealed = new Uint8Array(W * H);

  // ── grid → world helpers (cell centres) ──
  // wx = (gx - W/2 + 0.5)*CELL ; inverse cx = floor(wx/CELL + W/2)
  const _cellOut = { x: 0, y: 0 };
  function worldToCell(x, z) {
    _cellOut.x = Math.floor(x / CELL + W / 2);
    _cellOut.y = Math.floor(z / CELL + H / 2);
    return _cellOut;
  }
  const _worldOut = { x: 0, z: 0 };
  function cellToWorld(cx, cy) {
    _worldOut.x = (cx - W / 2 + 0.5) * CELL;
    _worldOut.z = (cy - H / 2 + 0.5) * CELL;
    return _worldOut;
  }
  const cwx = (gx) => (gx - W / 2 + 0.5) * CELL;
  const cwz = (gy) => (gy - H / 2 + 0.5) * CELL;

  function walkable(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
    const c = cy * W + cx;
    // POOL cells render as a floor-level sunken grate (no wall ring), so they
    // must be crossable — otherwise they read as walkable floor but shove the
    // hero/enemies off invisible obstacles mid-room.
    return (grid[c] === FLOOR || grid[c] === POOL) && _collisionSealed[c] === 0;
  }

  /* ------------------------------------------------------------------ FLOORS */
  // Measure the floor tile once to derive the fit-scale onto CELL.
  const floorSrc = _meshSource('kkd_floor_large');
  let floorGeo, floorMat;
  if (floorSrc) {
    floorSrc.geo.computeBoundingBox();
    floorSrc.geo.boundingBox.getSize(_sz);
    const fit = CELL / (_sz.x > 1e-4 ? _sz.x : CELL);
    floorSrc.geo.scale(fit, fit, fit);
    floorSrc.geo.computeBoundingBox();
    floorSrc.geo.translate(0, -floorSrc.geo.boundingBox.max.y, 0);   // top ≈ 0
    floorGeo = _own(floorSrc.geo);
    floorMat = _own(floorSrc.mat.clone());
  } else {
    floorGeo = _own(new THREE.PlaneGeometry(CELL, CELL).rotateX(-Math.PI / 2));
    floorMat = _own(new THREE.MeshStandardMaterial({ color: 0x8a8a90, roughness: 0.95, metalness: 0 }));
  }

  // Grate tile for POOL (sunken pit) cells.
  const grateSrc = _meshSource('kkd_floor_grate');
  let grateGeo, grateMat;
  if (grateSrc) {
    grateSrc.geo.computeBoundingBox();
    grateSrc.geo.boundingBox.getSize(_sz);
    const fit = CELL / (_sz.x > 1e-4 ? _sz.x : CELL);
    grateSrc.geo.scale(fit, fit, fit);
    grateSrc.geo.computeBoundingBox();
    grateSrc.geo.translate(0, -grateSrc.geo.boundingBox.max.y - 0.35, 0);   // sunk
    grateGeo = _own(grateSrc.geo);
    grateMat = _own(grateSrc.mat.clone());
  } else {
    grateGeo = _own(new THREE.PlaneGeometry(CELL, CELL).rotateX(-Math.PI / 2).translate(0, -0.35, 0));
    grateMat = _own(new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 1, metalness: 0 }));
  }

  let floorN = 0, poolN = 0;
  for (let c = 0; c < W * H; c++) { if (grid[c] === FLOOR) floorN++; else if (grid[c] === POOL) poolN++; }

  const floorIM = new THREE.InstancedMesh(floorGeo, floorMat, floorN);
  floorIM.receiveShadow = true;
  floorIM.frustumCulled = false;
  const grateIM = poolN > 0 ? new THREE.InstancedMesh(grateGeo, grateMat, poolN) : null;
  if (grateIM) { grateIM.receiveShadow = true; grateIM.frustumCulled = false; }

  let fi = 0, pi = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const g = grid[idx(x, y)];
    if (g === FLOOR) { _m4.makeTranslation(cwx(x), 0, cwz(y)); floorIM.setMatrixAt(fi++, _m4); }
    else if (g === POOL && grateIM) { _m4.makeTranslation(cwx(x), 0, cwz(y)); grateIM.setMatrixAt(pi++, _m4); }
  }
  floorIM.instanceMatrix.needsUpdate = true;
  group.add(floorIM);
  if (grateIM) { grateIM.instanceMatrix.needsUpdate = true; group.add(grateIM); }

  /* ------------------------------------------------------------------- WALLS */
  // One InstancedMesh for all wall edges; per-instance rotation (N/S vs E/W)
  // and Y-scale (far/tall vs near/short) carried in the instance matrix.
  const wallSrc = _meshSource('kkd_wall');
  let wallGeo, wallMat;
  if (wallSrc) {
    wallSrc.geo.computeBoundingBox();
    wallSrc.geo.boundingBox.getSize(_sz);
    const fit = CELL / (_sz.x > 1e-4 ? _sz.x : CELL);   // native 4-wide → CELL
    wallSrc.geo.scale(fit, fit, fit);
    wallSrc.geo.computeBoundingBox();
    wallSrc.geo.translate(0, -wallSrc.geo.boundingBox.min.y, 0);   // base at y=0
    wallGeo = _own(wallSrc.geo);
    wallMat = _own(wallSrc.mat.clone());
  } else {
    wallGeo = _own(new THREE.BoxGeometry(CELL, 2.0, CELL * 0.28).translate(0, 1.0, 0));
    wallMat = _own(new THREE.MeshStandardMaterial({ color: 0x5c5c64, roughness: 0.95, metalness: 0 }));
  }

  const solid = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) || grid[idx(x, y)] === WALL || grid[idx(x, y)] === 0;
  // dir table: [dx, dy, rotY, ysc]  (N/W far=tall 1.0 ; S/E near=short)
  const HALF = CELL / 2;
  let wallN = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (grid[idx(x, y)] !== FLOOR) continue;
    if (solid(x, y - 1)) wallN++;
    if (solid(x, y + 1)) wallN++;
    if (solid(x - 1, y)) wallN++;
    if (solid(x + 1, y)) wallN++;
  }
  const wallIM = new THREE.InstancedMesh(wallGeo, wallMat, wallN);
  wallIM.castShadow = true;
  wallIM.receiveShadow = true;
  wallIM.frustumCulled = false;
  let wi = 0;
  const _placeWall = (wx, wz, rotY, ysc) => {
    _p.set(wx, 0, wz); _q.setFromAxisAngle(_yAxis, rotY); _s.set(1, ysc, 1);
    _m4.compose(_p, _q, _s); wallIM.setMatrixAt(wi++, _m4);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (grid[idx(x, y)] !== FLOOR) continue;
    const wx = cwx(x), wz = cwz(y);
    if (solid(x, y - 1)) _placeWall(wx, wz - HALF, 0, 1.0);            // north edge → far → tall
    if (solid(x, y + 1)) _placeWall(wx, wz + HALF, 0, SHORT_SCALE);   // south edge → near → short
    if (solid(x - 1, y)) _placeWall(wx - HALF, wz, Math.PI / 2, 1.0);         // west → far → tall
    if (solid(x + 1, y)) _placeWall(wx + HALF, wz, Math.PI / 2, SHORT_SCALE); // east → near → short
  }
  wallIM.instanceMatrix.needsUpdate = true;
  group.add(wallIM);

  /* --------------------------------------------------------- INSTANCED PROPS */
  // Group props by kind first so each instanced kind is one InstancedMesh.
  const _byKind = {};
  if (props) for (const pr of props) {
    if (!PROP_INSTANCED[pr.kind]) continue;
    (_byKind[pr.kind] || (_byKind[pr.kind] = [])).push(pr);
  }
  for (const kind in _byKind) {
    const list = _byKind[kind];
    const spec = PROP_INSTANCED[kind];
    const src = _meshSource(spec.key);
    let geo, mat;
    if (src) {
      src.geo.computeBoundingBox(); src.geo.boundingBox.getSize(_sz);
      const fit = spec.targetH / (_sz.y > 1e-4 ? _sz.y : spec.targetH);
      src.geo.scale(fit, fit, fit);
      src.geo.computeBoundingBox();
      // Centre x/z on the origin and drop feet to y=0.
      src.geo.translate(-((src.geo.boundingBox.max.x + src.geo.boundingBox.min.x) / 2), -src.geo.boundingBox.min.y,
                        -((src.geo.boundingBox.max.z + src.geo.boundingBox.min.z) / 2));
      geo = _own(src.geo); mat = _own(src.mat.clone());
    } else {
      geo = _own(new THREE.BoxGeometry(0.7, spec.targetH, 0.7).translate(0, spec.targetH / 2, 0));
      mat = _own(new THREE.MeshStandardMaterial({ color: 0x6b6156, roughness: 0.95, metalness: 0 }));
    }
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      _p.set(cwx(pr.x), 0, cwz(pr.y));
      _q.setFromAxisAngle(_yAxis, pr.rot || 0);
      const sc = pr.scale || 1; _s.set(sc, sc, sc);
      _m4.compose(_p, _q, _s); im.setMatrixAt(i, _m4);
    }
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  }

  /* ---------------------------------------------------------- SINGLE PROPS */
  if (props) for (const pr of props) {
    const spec = PROP_SINGLE[pr.kind];
    if (!spec) continue;
    _addProp(group, spec.key, cwx(pr.x), cwz(pr.y), spec.targetH, pr.rot || 0);
  }

  /* --------------------------------------------------------------- TORCHES */
  // A flame cone on every anchor (bloom), plus a pool of PointLights that
  // torchTick reassigns to the anchors nearest the hero.
  const nTorch = torches ? torches.length : 0;
  const _torchXYZ = new Float32Array(Math.max(1, nTorch) * 3);
  const coneGeo = _own(new THREE.ConeGeometry(0.16, 0.5, 8));
  const coneMat = _own(new THREE.MeshStandardMaterial({
    color: 0xff7a3a, emissive: 0xff7a3a, emissiveIntensity: 2.2, roughness: 0.4, metalness: 0,
  }));
  let coneIM = null;
  if (nTorch > 0) {
    coneIM = new THREE.InstancedMesh(coneGeo, coneMat, nTorch);
    coneIM.frustumCulled = false;
    coneIM.layers.enable(BLOOM_LAYER);
    for (let i = 0; i < nTorch; i++) {
      const t = torches[i];
      const wx = cwx(t.x) + t.dx * CELL * 0.34;
      const wz = cwz(t.y) + t.dy * CELL * 0.34;
      _m4.makeTranslation(wx, 1.55, wz);
      coneIM.setMatrixAt(i, _m4);
      _torchXYZ[i * 3] = wx; _torchXYZ[i * 3 + 1] = 1.75; _torchXYZ[i * 3 + 2] = wz;
    }
    coneIM.instanceMatrix.needsUpdate = true;
    group.add(coneIM);
  }

  const _lights = [];
  for (let i = 0; i < TORCH_POOL; i++) {
    const pl = new THREE.PointLight(0xff7a3a, 0.0, 11, 2);
    pl.visible = false;
    group.add(pl);
    _lights.push(pl);
  }
  // Ambient kicker so non-torch corners aren't pure black.
  const fill = new THREE.AmbientLight(0x24242c, 0.5);
  group.add(fill);

  // torchTick scratch (allocated once per build; reused every frame).
  const _nearD = new Float32Array(TORCH_POOL);
  const _nearI = new Int32Array(TORCH_POOL);
  let _tphase = 0;
  function torchTick(dt, heroPos) {
    _tphase += dt;
    // Single global cone flicker (one uniform write, not per-cone).
    if (coneMat) coneMat.emissiveIntensity = 1.9 + 0.5 * Math.sin(_tphase * 8.0);
    if (nTorch === 0) return;
    for (let k = 0; k < TORCH_POOL; k++) { _nearD[k] = Infinity; _nearI[k] = -1; }
    const hx = heroPos.x, hz = heroPos.z;
    for (let i = 0; i < nTorch; i++) {
      const dx = _torchXYZ[i * 3] - hx, dz = _torchXYZ[i * 3 + 2] - hz;
      const d = dx * dx + dz * dz;
      // insertion into the 5 nearest (kept sorted ascending)
      if (d >= _nearD[TORCH_POOL - 1]) continue;
      let k = TORCH_POOL - 1;
      while (k > 0 && _nearD[k - 1] > d) { _nearD[k] = _nearD[k - 1]; _nearI[k] = _nearI[k - 1]; k--; }
      _nearD[k] = d; _nearI[k] = i;
    }
    for (let k = 0; k < TORCH_POOL; k++) {
      const pl = _lights[k], i = _nearI[k];
      if (i < 0) { pl.visible = false; continue; }
      pl.visible = true;
      pl.position.set(_torchXYZ[i * 3], _torchXYZ[i * 3 + 1], _torchXYZ[i * 3 + 2]);
      pl.intensity = 0.9 * (0.82 + 0.22 * Math.sin(_tphase * 6.7 + k * 1.3) + 0.1 * Math.sin(_tphase * 12.7 + k));
    }
  }

  /* ----------------------------------------------------------- SEAL BLOCKERS */
  // Dungeon doors are real dedicated portcullis assets. Doorway frames remain
  // visible at all times; the leaf drops/lifts while progression and encounter
  // locks compose through independent bits.
  const _doorRotation = (cx, cy) => {
    const roomAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H) ? roomId[idx(x, y)] : -1;
    return (roomAt(cx - 1, cy) >= 0 || roomAt(cx + 1, cy) >= 0) ? Math.PI / 2 : 0;
  };
  const blockerSrc = _meshSource('kk_dungeon_gate');
  let _blockerGeo;
  let _blockerMat;
  let _blockerIsAsset = false;
  if (blockerSrc) {
    blockerSrc.geo.computeBoundingBox();
    blockerSrc.geo.boundingBox.getSize(_sz);
    const fit = (CELL * 0.94) / (_sz.x > 1e-4 ? _sz.x : CELL);
    blockerSrc.geo.scale(fit, fit, fit);
    blockerSrc.geo.computeBoundingBox();
    blockerSrc.geo.translate(
      -((blockerSrc.geo.boundingBox.min.x + blockerSrc.geo.boundingBox.max.x) * 0.5),
      -blockerSrc.geo.boundingBox.min.y,
      -((blockerSrc.geo.boundingBox.min.z + blockerSrc.geo.boundingBox.max.z) * 0.5),
    );
    _blockerGeo = _own(blockerSrc.geo);
    _blockerMat = _own(blockerSrc.mat.clone());
    if (_blockerMat.color) _blockerMat.color.multiplyScalar(0.82);
    if (_blockerMat.emissive) {
      _blockerMat.emissive.setHex(0x301044);
      _blockerMat.emissiveIntensity = 0.18;
    }
    _blockerIsAsset = true;
  } else {
    _blockerGeo = _own(new THREE.BoxGeometry(CELL * 0.94, 2.2, CELL * 0.30).translate(0, 1.1, 0));
    _blockerMat = _own(new THREE.MeshStandardMaterial({
      color: 0x302739, emissive: 0x4a1c77, emissiveIntensity: 0.28,
      roughness: 0.9, metalness: 0.05,
    }));
  }
  _blockerGeo.computeBoundingBox();
  const _gateHeight = Math.max(2.2, _blockerGeo.boundingBox.max.y - _blockerGeo.boundingBox.min.y);
  const _blockers = new Map();
  const _lockBit = (reason) => reason === 'progression' ? DOOR_LOCK_PROGRESSION : DOOR_LOCK_ENCOUNTER;
  function setSealed(cx, cy, on, reason = 'encounter') {
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return;
    const c = cy * W + cx;
    const before = _sealed[c];
    const bit = _lockBit(reason);
    const after = on ? (before | bit) : (before & ~bit);
    if (after === before) return;
    _sealed[c] = after;
    if (before === 0 && after !== 0) {
      // A gate may be re-locked while its previous leaf is still lifting.
      // Reverse that existing animation instead of orphaning the old mesh by
      // overwriting its Map record with a second leaf.
      const existing = _blockers.get(c);
      if (existing) {
        existing.mesh.userData.lockMask = after;
        existing.mesh.position.y = 0;
        existing.targetY = 0;
        existing.removeOnArrival = false;
        _collisionSealed[c] = 1;
        return;
      }
      const m = new THREE.Mesh(_blockerGeo, _blockerMat);
      m.name = 'dungeonSealedDoor';
      // Encounter state becomes active after the hero crosses the threshold;
      // the leaf must already be physically closed on that frame or a dash can
      // escape into the corridor and leave an active fight behind the player.
      m.position.set(cwx(cx), 0, cwz(cy));
      m.rotation.y = _doorRotation(cx, cy);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.assetKey = _blockerIsAsset ? 'kk_dungeon_gate' : 'fallback';
      m.userData.lockMask = after;
      group.add(m);
      _blockers.set(c, { mesh: m, targetY: 0, removeOnArrival: false });
      _collisionSealed[c] = 1;
    } else {
      const rec = _blockers.get(c);
      if (!rec) return;
      rec.mesh.userData.lockMask = after;
      if (after === 0) {
        rec.targetY = _gateHeight + 0.25;
        rec.removeOnArrival = true;
      } else {
        rec.targetY = 0;
        rec.removeOnArrival = false;
      }
    }
  }

  function tickDoors(dt) {
    if (_blockers.size === 0) return;
    const step = Math.max(0, dt) * 7.5;
    for (const [cell, rec] of _blockers) {
      const y = rec.mesh.position.y;
      const dy = rec.targetY - y;
      if (Math.abs(dy) <= step) {
        rec.mesh.position.y = rec.targetY;
        if (rec.targetY === 0) _collisionSealed[cell] = 1;
        if (rec.removeOnArrival) {
          _collisionSealed[cell] = 0;
          group.remove(rec.mesh);
          _blockers.delete(cell);
        }
      } else {
        rec.mesh.position.y += Math.sign(dy) * step;
        // Logical lock bits switch immediately, but collision follows the
        // visible leaf: close only once bars reach the doorway, and keep the
        // doorway blocked until the rising leaf clears hero height.
        if (rec.targetY === 0 && rec.mesh.position.y <= Math.min(0.65, _gateHeight * 0.3)) {
          _collisionSealed[cell] = 1;
        } else if (rec.targetY > 0 && rec.mesh.position.y >= Math.min(1.6, _gateHeight * 0.72)) {
          _collisionSealed[cell] = 0;
        }
      }
    }
  }

  function doorLockMask(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 0;
    return _sealed[cy * W + cx];
  }

  /* ------------------------------------------------------- doorway → room map */
  const doorwayCells = [];
  if (doorway) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = idx(x, y);
      if (!doorway[c]) continue;
      // The generator marks a doorway on the corridor cell adjacent to a room;
      // tag it with the room it fronts so catacomb can seal a room's mouth.
      let rid = -1;
      if (x < W - 1 && roomId[c + 1] >= 0) rid = roomId[c + 1];
      else if (x > 0 && roomId[c - 1] >= 0) rid = roomId[c - 1];
      else if (y < H - 1 && roomId[c + W] >= 0) rid = roomId[c + W];
      else if (y > 0 && roomId[c - W] >= 0) rid = roomId[c - W];
      doorwayCells.push({ x, y, roomId: rid });
    }
  }

  // Permanent authored doorway surrounds make open passages read as doors,
  // while setSealed adds/removes only the blocking leaf during combat. Wide
  // corridors legitimately contain 3-5 adjacent doorway cells, so instance
  // the frames in one draw instead of cloning dozens of independent GLBs.
  const frameSrc = _meshSource('kkd_wall_doorway');
  if (frameSrc && doorwayCells.length) {
    frameSrc.geo.computeBoundingBox();
    frameSrc.geo.boundingBox.getSize(_sz);
    const fit = CELL / (_sz.x > 1e-4 ? _sz.x : CELL);
    frameSrc.geo.scale(fit, fit, fit);
    frameSrc.geo.computeBoundingBox();
    frameSrc.geo.translate(
      -((frameSrc.geo.boundingBox.min.x + frameSrc.geo.boundingBox.max.x) * 0.5),
      -frameSrc.geo.boundingBox.min.y,
      -((frameSrc.geo.boundingBox.min.z + frameSrc.geo.boundingBox.max.z) * 0.5),
    );
    const frameGeo = _own(frameSrc.geo);
    const frameMat = _own(frameSrc.mat.clone());
    const frames = new THREE.InstancedMesh(frameGeo, frameMat, doorwayCells.length);
    frames.name = 'dungeonDoorFrame';
    frames.userData.assetKey = 'kkd_wall_doorway';
    frames.castShadow = true;
    frames.receiveShadow = true;
    frames.frustumCulled = false;
    for (let i = 0; i < doorwayCells.length; i++) {
      const dc = doorwayCells[i];
      _p.set(cwx(dc.x), 0, cwz(dc.y));
      _q.setFromAxisAngle(_yAxis, _doorRotation(dc.x, dc.y));
      _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      frames.setMatrixAt(i, _m4);
    }
    frames.instanceMatrix.needsUpdate = true;
    group.add(frames);
  }

  /* ----------------------------------------------------------- entry + spawns */
  const eRoom = rooms[entrance];
  const entryWorld = { x: cwx(eRoom.cx), z: cwz(eRoom.cy) };
  const spawnPointsWorld = [];
  if (spawns) for (const s of spawns) {
    spawnPointsWorld.push({ x: cwx(s.x), z: cwz(s.y), tier: s.tier, roomId: s.roomId });
  }

  /* --------------------------------------------------------------- dispose */
  function dispose() {
    for (const rec of _blockers.values()) group.remove(rec.mesh);
    _blockers.clear();
    if (group.parent) group.parent.remove(group);
    for (const pl of _lights) group.remove(pl);   // lights: no shadow maps to free
    // Free per-InstancedMesh instance buffers before detaching children.
    group.traverse((o) => { if (o.isInstancedMesh) { try { o.dispose(); } catch (_) {} } });
    // Individual prop clones share cache geo/mat — just detach (GC handles).
    group.clear();
    // Owned geometries/materials (clones + primitives) — safe to dispose;
    // cache resources (shared prop-clone geo/mat, atlas textures) are NOT here.
    for (const r of _owned) { try { r.dispose(); } catch (_) {} }
    _owned.length = 0;
  }

  return {
    group, walkable, worldToCell, cellToWorld, torchTick,
    rooms, entrance, entryWorld, spawnPointsWorld, doorwayCells, setSealed,
    tickDoors, doorLockMask,
    CELL, W, H, dispose,
  };
}

/**
 * Individual prop clone, bbox-normalised to targetH with feet on the floor.
 * Mirrors catacomb.js's _addKayKitProp. Shares cache geo/mat (do NOT dispose).
 */
function _addProp(parent, key, x, z, targetH, rotY) {
  const m = cloneCached(key);
  if (!m) return null;
  m.updateMatrixWorld(true);
  _box.setFromObject(m);
  _box.getSize(_sz);
  const h = _sz.y > 1e-3 ? _sz.y : 1;
  m.scale.setScalar(targetH / h);
  m.updateMatrixWorld(true);
  _box.setFromObject(m);
  m.position.set(x, -_box.min.y, z);
  m.rotation.y = rotY;
  m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  parent.add(m);
  return m;
}
