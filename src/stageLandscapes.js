/**
 * Authored, stage-level landscape compositions for the non-Forest biomes.
 *
 * The older arenaDecor packs provide mechanics-adjacent props. This module
 * supplies the larger visual hierarchy the Forest Glade already has: paths,
 * water/terrain breaks, tree lines, and recognizable landmark precincts.
 * Everything static is batched (one InstancedMesh per GLB key, one merged mesh
 * per path network), and all layouts are deterministic.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cloneCached, GLTF_CACHE } from './assets.js';
import { BIOME_FLAGSTONE_REPEAT, getBiomeFlagstoneTexture } from './biomeTextures.js';
import {
  FOREST_PORTAL_POSITIONS,
  FOREST_ROOMS,
  FOREST_WORLD_BOUNDS,
  getForestTravelAnchors,
  getForestTravelCorridors,
} from './forestRooms.js';
import { getStageTerrainLayout, sampleStageTerrain } from './stageTerrainLayout.js';
import { state } from './state.js';
import {
  createTerrainRibbonMaterial,
  createWaterMaterial,
} from './rendering/materials/landscapeMaterials.js';

let _root = null;
let _resources = [];
let _flagstone = null;
const _bakes = new Map();

const TWILIGHT_FOUNTAINS = [
  { x: 25.11, z: 6.11 }, { x: 24.38, z: -1.22 },
  { x: -8.98, z: 31.32 }, { x: -1.07, z: 30.17 },
  { x: -37.21, z: -4.26 }, { x: -37.12, z: 4.30 },
];
const CINDER_BALLISTAS = [
  { x: -19.52, z: 18.13 }, { x: 21.19, z: 33.39 },
  { x: 10.75, z: -38.25 }, { x: 48.50, z: -8.74 },
  { x: -22.89, z: 31.44 }, { x: 33.12, z: 8.32 },
];
const CINDER_CATAPULTS = [
  { x: 44.49, z: 2.65 }, { x: 8.34, z: 25.26 },
  { x: -40.00, z: 16.40 }, { x: 3.69, z: -32.90 },
];
const VOID_PADS = [
  { x: 16.94, z: 29.24, yaw: -0.52 },
  { x: 2.33, z: 27.78, yaw: -0.08 },
  { x: -26.8, z: 17.66, yaw: 0.99 },
  { x: 44.21, z: -1.75, yaw: 1.61 },
  { x: 29.94, z: -33.91, yaw: 2.42 },
  { x: 3.37, z: -26.2, yaw: 3.01 },
];
// Walking due east from spawn is the most common first exploration test. The
// Amber gate sits at z=10, so this authored spur catches a straight east walk
// and bends it back into the portal/room route instead of exposing bare turf.
const FOREST_WILDWOOD_SPURS = Object.freeze([
  Object.freeze([
    Object.freeze({ x: 35, z: 0 }),
    Object.freeze({ x: 68, z: -4 }),
    Object.freeze({ x: 103, z: 0 }),
  ]),
]);

function _track(...items) {
  for (const item of items) if (item) _resources.push(item);
}

function _rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _flagstoneTex() {
  if (_flagstone) return _flagstone;
  _flagstone = getBiomeFlagstoneTexture();
  return _flagstone;
}

function _cloneMat(mat) {
  const source = Array.isArray(mat) ? mat[0] : mat;
  return source && source.clone
    ? source.clone()
    : new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.9 });
}

/** Bake a cached GLB to a world-space BufferGeometry once per active stage. */
function _bakeKit(key) {
  if (_bakes.has(key)) return _bakes.get(key);
  if (!GLTF_CACHE[key]) return null;
  const src = cloneCached(key);
  if (!src) return null;
  src.updateMatrixWorld(true);
  const geos = [];
  const mats = [];
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    for (const attr of Object.keys(geo.attributes)) {
      if (attr !== 'position' && attr !== 'normal' && attr !== 'uv') geo.deleteAttribute(attr);
    }
    geos.push(geo);
    mats.push(_cloneMat(o.material));
  });
  if (!geos.length) return null;

  let geo;
  let mat;
  if (geos.length === 1) {
    geo = geos[0];
    mat = mats[0];
  } else {
    geo = mergeGeometries(geos, true);
    if (geo) {
      for (const g of geos) g.dispose();
      mat = mats;
    } else {
      geo = geos[0];
      mat = mats[0];
      for (let i = 1; i < geos.length; i++) geos[i].dispose();
      for (let i = 1; i < mats.length; i++) mats[i].dispose();
    }
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const bb = geo.boundingBox;
  const baked = {
    geo,
    mat,
    height: Math.max(0.001, bb.max.y - bb.min.y),
    footY: bb.min.y,
  };
  _track(geo);
  if (Array.isArray(mat)) _track(...mat); else _track(mat);
  _bakes.set(key, baked);
  return baked;
}

function _addKitInstances(parent, key, placements, name, purpose, tint = null, chunkSize = 56) {
  const baked = _bakeKit(key);
  if (!baked || !placements.length) return 0;
  if (tint != null && baked.tint !== tint) {
    const mats = Array.isArray(baked.mat) ? baked.mat : [baked.mat];
    for (const mat of mats) {
      if (mat && mat.color) mat.color.setHex(tint);
    }
    baked.tint = tint;
  }
  // Wide radial batches otherwise share one enormous bounding sphere, forcing
  // every off-screen outer prop through the renderer. Spatial chunks preserve
  // instancing while giving the frustum useful spatial cells to reject.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of placements) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const shouldChunk = placements.length >= 16 && (maxX - minX > 72 || maxZ - minZ > 72);
  const batches = [];
  if (shouldChunk) {
    const cells = new Map();
    for (const p of placements) {
      const keyName = `${Math.floor(p.x / chunkSize)},${Math.floor(p.z / chunkSize)}`;
      let cell = cells.get(keyName);
      if (!cell) { cell = []; cells.set(keyName, cell); }
      cell.push(p);
    }
    batches.push(...cells.values());
  } else {
    batches.push(placements);
  }
  const dummy = new THREE.Object3D();
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const inst = new THREE.InstancedMesh(baked.geo, baked.mat, batch.length);
    inst.name = batches.length === 1 ? name : `${name}:chunk${bi}`;
    inst.userData.landscapePurpose = purpose;
    inst.userData.spatialChunk = batches.length > 1;
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      const base = Number.isFinite(p.h) ? p.h / baked.height : (p.s || 1);
      const sx = base * (p.sx || 1);
      const sy = base * (p.sy || 1);
      const sz = base * (p.sz || 1);
      dummy.scale.set(sx, sy, sz);
      dummy.position.set(p.x, p.y ?? (-baked.footY * sy), p.z);
      dummy.rotation.set(p.rx || 0, p.yaw || 0, p.rz || 0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.computeBoundingSphere) inst.computeBoundingSphere();
    parent.add(inst);
  }
  return placements.length;
}

function _radial(seed, count, rMin, rMax, hMin, hMax) {
  const rand = _rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const wedge = (i / count) * Math.PI * 2;
    const a = wedge + (rand() - 0.5) * (Math.PI * 2 / count) * 0.72;
    const r = rMin + rand() * (rMax - rMin);
    out.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      h: hMin + rand() * (hMax - hMin),
      yaw: rand() * Math.PI * 2,
      rz: (rand() - 0.5) * 0.12,
    });
  }
  return out;
}

function _clustered(seed, anchors, perAnchor, spread, hMin, hMax) {
  const rand = _rng(seed);
  const out = [];
  for (const a of anchors) {
    for (let i = 0; i < perAnchor; i++) {
      const t = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * spread;
      out.push({
        x: a.x + Math.cos(t) * r,
        z: a.z + Math.sin(t) * r,
        h: hMin + rand() * (hMax - hMin),
        yaw: rand() * Math.PI * 2,
      });
    }
  }
  return out;
}

function _outsideKeepouts(placements, keepouts, clearance, footprint = 0) {
  return placements.filter((p) => keepouts.every((k) => {
    const d = (k.r ?? clearance) + footprint;
    const dx = p.x - k.x, dz = p.z - k.z;
    return dx * dx + dz * dz >= d * d;
  }));
}

function _ringAround(seed, anchors, perAnchor, rMin, rMax, hMin, hMax) {
  const rand = _rng(seed);
  const out = [];
  for (const anchor of anchors) {
    for (let i = 0; i < perAnchor; i++) {
      const a = (i / perAnchor) * Math.PI * 2 + (rand() - 0.5) * 0.42;
      const r = rMin + rand() * (rMax - rMin);
      out.push({
        x: anchor.x + Math.cos(a) * r,
        z: anchor.z + Math.sin(a) * r,
        h: hMin + rand() * (hMax - hMin),
        yaw: rand() * Math.PI * 2,
      });
    }
  }
  return out;
}

function _routeRibbonGeometry(r, seed, tileWorld) {
  const rand = _rng(seed);
  const rows = Math.max(3, Math.ceil(r.h / 6));
  const positions = new Float32Array((rows + 1) * 2 * 3);
  const uvs = new Float32Array((rows + 1) * 2 * 2);
  const indices = [];
  const cy = Math.cos(r.yaw || 0);
  const sy = Math.sin(r.yaw || 0);
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const localZ = (t - 0.5) * r.h;
    const endSoft = row === 0 || row === rows ? 0.78 : 1;
    const halfWidth = r.w * 0.5 * endSoft * (0.86 + rand() * 0.28);
    const center = row === 0 || row === rows ? 0 : (rand() - 0.5) * r.w * 0.18;
    for (let side = 0; side < 2; side++) {
      const localX = center + (side ? halfWidth : -halfWidth);
      const vi = row * 2 + side;
      positions[vi * 3] = r.x + localX * cy + localZ * sy;
      positions[vi * 3 + 1] = r.y ?? -0.045;
      positions[vi * 3 + 2] = r.z - localX * sy + localZ * cy;
      uvs[vi * 2] = side * r.w / tileWorld;
      uvs[vi * 2 + 1] = t * r.h / tileWorld;
    }
    if (row < rows) {
      const a = row * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function _buildPath(parent, rects, color, name, opacity = 1) {
  const parts = [];
  // The shared texture repeats densely for the full-map ground. Counter-scale route
  // UVs so paths retain a ~3.2u stone cadence while using the same GPU upload.
  const tileWorld = 3.2 * BIOME_FLAGSTONE_REPEAT;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (name === 'forest_moss_routes') {
      parts.push(_routeRibbonGeometry(r, 0xF07E000 + i * 97, tileWorld));
    } else {
      const geo = new THREE.PlaneGeometry(r.w, r.h, 1, 1);
      const uv = geo.attributes.uv;
      for (let j = 0; j < uv.count; j++) {
        uv.setXY(j, uv.getX(j) * r.w / tileWorld, uv.getY(j) * r.h / tileWorld);
      }
      geo.rotateX(-Math.PI / 2);
      geo.rotateY(r.yaw || 0);
      geo.translate(r.x, r.y ?? -0.045, r.z);
      parts.push(geo);
    }
  }
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geo) return null;
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({
    color,
    map: _flagstoneTex(),
    roughness: 0.92,
    metalness: 0.02,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.userData.landscapePurpose = 'navigation-route';
  mesh.receiveShadow = true;
  mesh.renderOrder = -4;
  parent.add(mesh);
  _track(geo, mat);
  return mesh;
}

function _irregularDisk(seed, segments = 30) {
  const rand = _rng(seed);
  const pos = new Float32Array((segments + 1) * 3);
  const uv = new Float32Array((segments + 1) * 2);
  const idx = [];
  uv[0] = uv[1] = 0.5;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const radius = 0.86 + rand() * 0.22;
    const vi = i + 1;
    pos[vi * 3] = Math.cos(a) * radius;
    pos[vi * 3 + 2] = Math.sin(a) * radius;
    uv[vi * 2] = 0.5 + Math.cos(a) * radius * 0.5;
    uv[vi * 2 + 1] = 0.5 + Math.sin(a) * radius * 0.5;
    idx.push(0, vi, ((i + 1) % segments) + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function _buildWater(parent, ponds, palette, name) {
  const geo = _irregularDisk(palette.seed);
  const mat = createWaterMaterial(palette.deep, palette.shallow, palette.opacity);
  const inst = new THREE.InstancedMesh(geo, mat, ponds.length);
  inst.name = name;
  inst.userData.landscapePurpose = 'water-landmark';
  inst.castShadow = false;
  inst.receiveShadow = false;
  inst.renderOrder = -5;
  inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < ponds.length; i++) {
    const p = ponds[i];
    dummy.position.set(p.x, p.y ?? -0.035, p.z);
    dummy.scale.set(p.sx, 1, p.sz);
    dummy.rotation.set(0, p.yaw || 0, 0);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.computeBoundingSphere) inst.computeBoundingSphere();
  inst.onBeforeRender = () => {
    mat.uniforms.uMotionScale.value = state._optReduceMotion ? 0 : 1;
    mat.uniforms.uTime.value = performance.now() * 0.001;
  };
  parent.add(inst);
  _track(geo, mat);
  return inst;
}

function _terrainRibbonGeometry(layout) {
  const points = layout.points;
  const pos = new Float32Array(points.length * 2 * 3);
  const uv = new Float32Array(points.length * 2 * 2);
  const idx = [];
  let travelled = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    const nx = -tz;
    const nz = tx;
    if (i > 0) travelled += Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z);
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? -1 : 1;
      const vi = i * 2 + side;
      pos[vi * 3] = p.x + nx * layout.width * 0.5 * sign;
      pos[vi * 3 + 1] = -0.058;
      pos[vi * 3 + 2] = p.z + nz * layout.width * 0.5 * sign;
      uv[vi * 2] = travelled / 9;
      uv[vi * 2 + 1] = side;
    }
    if (i < points.length - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Build one truthful terrain cut: rendered ribbon, asset banks, safe bridges. */
function _buildTerrainFeature(parent, stageId, keepouts = []) {
  const layout = getStageTerrainLayout(stageId);
  if (!layout) return { terrainCuts: 0, bridges: 0, canyonBanks: 0 };
  const geo = _terrainRibbonGeometry(layout);
  const mat = createTerrainRibbonMaterial(layout);
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.name = `${stageId}_terrain_cut`;
  ribbon.userData.landscapePurpose = 'terrain-cut';
  ribbon.userData.terrainKind = layout.kind;
  ribbon.renderOrder = -6;
  ribbon.receiveShadow = false;
  ribbon.onBeforeRender = () => {
    mat.uniforms.uMotionScale.value = state._optReduceMotion ? 0 : 1;
    mat.uniforms.uTime.value = performance.now() * 0.001;
  };
  parent.add(ribbon);
  _track(geo, mat);

  const banks = [];
  for (let si = 1; si < layout.points.length; si++) {
    const a = layout.points[si - 1];
    const b = layout.points[si];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len, tz = dz / len;
    const nx = -tz, nz = tx;
    const yaw = Math.atan2(-tz, tx);
    const pieces = Math.max(1, Math.ceil(len / 7.7));
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      for (const side of [-1, 1]) {
        banks.push({
          x: x + nx * (layout.width * 0.5 + 0.28) * side,
          y: -0.02,
          z: z + nz * (layout.width * 0.5 + 0.28) * side,
          yaw: yaw + (side < 0 ? Math.PI : 0),
          s: 0.92 + ((si + k) % 3) * 0.06,
        });
      }
    }
  }
  const safeBanks = keepouts.length ? _outsideKeepouts(banks, keepouts, 5.0) : banks;
  const canyonBanks = _addKitInstances(
    parent, 'kk_cliff_edge', safeBanks, `${stageId}_terrain_banks`, 'terrain-bank',
  );

  let bridges = 0;
  for (const key of ['kk_bridge_wood', 'kk_bridge_stone']) {
    const placements = layout.bridges.filter((b) => b.asset === key).map((b) => ({
      x: b.x, y: 0, z: b.z, yaw: b.yaw || 0, s: 1,
    }));
    bridges += _addKitInstances(
      parent, key, placements, `${stageId}_${key}`, 'terrain-crossing',
    );
  }
  return { terrainCuts: 1, bridges, canyonBanks };
}

function _pondBanks(ponds, perPond, seed, targetH = 0.9) {
  const rand = _rng(seed);
  const out = [];
  for (const p of ponds) {
    for (let i = 0; i < perPond; i++) {
      const a = (i / perPond) * Math.PI * 2 + (rand() - 0.5) * 0.25;
      const ca = Math.cos(a), sa = Math.sin(a);
      const cy = Math.cos(p.yaw || 0), sy = Math.sin(p.yaw || 0);
      const lx = ca * p.sx * (0.92 + rand() * 0.16);
      const lz = sa * p.sz * (0.92 + rand() * 0.16);
      out.push({
        x: p.x + lx * cy - lz * sy,
        z: p.z + lx * sy + lz * cy,
        h: targetH * (0.7 + rand() * 0.65),
        yaw: rand() * Math.PI * 2,
        sy: 0.72 + rand() * 0.3,
      });
    }
  }
  return out;
}

function _addReeds(parent, ponds, seed, color, name) {
  const rand = _rng(seed);
  const count = ponds.length * 10;
  const geo = new THREE.CylinderGeometry(0.045, 0.085, 1.25, 5, 1, false);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true });
  const inst = new THREE.InstancedMesh(geo, mat, count);
  inst.name = name;
  inst.userData.landscapePurpose = 'waterside-vegetation';
  const dummy = new THREE.Object3D();
  let n = 0;
  for (const p of ponds) {
    for (let i = 0; i < 10; i++, n++) {
      const a = rand() * Math.PI * 2;
      const edge = 0.82 + rand() * 0.24;
      const lx = Math.cos(a) * p.sx * edge;
      const lz = Math.sin(a) * p.sz * edge;
      const cy = Math.cos(p.yaw || 0), sy = Math.sin(p.yaw || 0);
      const x = p.x + lx * cy - lz * sy;
      const z = p.z + lx * sy + lz * cy;
      const s = 0.65 + rand() * 0.65;
      dummy.position.set(x, 0.625 * s, z);
      dummy.scale.set(0.85 + rand() * 0.4, s, 0.85 + rand() * 0.4);
      dummy.rotation.set((rand() - 0.5) * 0.18, rand() * Math.PI * 2, (rand() - 0.5) * 0.18);
      dummy.updateMatrix();
      inst.setMatrixAt(n, dummy.matrix);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = false;
  inst.receiveShadow = false;
  parent.add(inst);
  _track(geo, mat);
  return count;
}

function _routeRect(a, b, width = 2.6) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.max(0.1, Math.hypot(dx, dz));
  return {
    x: (a.x + b.x) * 0.5,
    z: (a.z + b.z) * 0.5,
    w: width,
    h: length,
    yaw: Math.atan2(dx, dz),
  };
}

function _insetRouteStart(a, b, distance) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const k = Math.min(distance, length * 0.42) / length;
  return { x: a.x + dx * k, z: a.z + dz * k };
}

/**
 * A single moss-road mesh gives all seven Forest rooms readable authored
 * routes without adding a draw call per room. Glade paths lead to every
 * outbound portal; side-room paths lead from the arrival anchor toward the
 * room's landmark/puzzle center. The roads sit below actors and hazards.
 */
function _buildForestRoutes(parent) {
  const rects = [];
  const glade = FOREST_ROOMS.glade.center;
  const bridges = getStageTerrainLayout('forest')?.bridges || [];
  const bridgeWest = bridges[0];
  const bridgeEast = bridges[1];
  for (const [key, portal] of Object.entries(FOREST_PORTAL_POSITIONS)) {
    const crossing = key === 'toCrystalchoir'
      ? bridgeWest
      : (key === 'toBramblemaze' ? bridgeEast : null);
    if (crossing) {
      rects.push(_routeRect(_insetRouteStart(glade, crossing, 10), crossing, 1.8));
      rects.push(_routeRect(crossing, portal, 1.8));
    } else {
      rects.push(_routeRect(_insetRouteStart(glade, portal, 10), portal, 1.8));
    }
    // Stop the Glade road at the gate. A continuous moss road all the way to
    // the remote chamber advertised a walkable route that bypassed the portal
    // verb; the Wildwood now visually closes behind each portal instead.
  }
  for (const room of Object.values(FOREST_ROOMS)) {
    if (room.isHub) continue;
    const anchors = getForestTravelAnchors(room.id);
    if (!anchors) continue;
    rects.push(_routeRect(anchors.entry, room.center, room.id === 'glowfen' ? 3.0 : 2.2));
  }
  for (const spur of FOREST_WILDWOOD_SPURS) {
    for (let i = 1; i < spur.length; i++) rects.push(_routeRect(spur[i - 1], spur[i], 2.7));
  }
  return _buildPath(parent, rects, 0x98a87f, 'forest_moss_routes', 0.50)
    ? rects.length
    : 0;
}

function _forestSegmentDistanceSq(px, pz, a, b) {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const wx = px - a.x;
  const wz = pz - a.z;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 1e-8 ? (wx * vx + wz * vz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (a.x + vx * t);
  const dz = pz - (a.z + vz * t);
  return dx * dx + dz * dz;
}

function _forestRouteSegments() {
  const segments = [];
  const glade = FOREST_ROOMS.glade.center;
  const bridges = getStageTerrainLayout('forest')?.bridges || [];
  const bridgeWest = bridges[0];
  const bridgeEast = bridges[1];
  for (const [key, portal] of Object.entries(FOREST_PORTAL_POSITIONS)) {
    const crossing = key === 'toCrystalchoir'
      ? bridgeWest
      : (key === 'toBramblemaze' ? bridgeEast : null);
    if (crossing) {
      segments.push([_insetRouteStart(glade, crossing, 10), crossing]);
      segments.push([crossing, portal]);
    } else {
      segments.push([_insetRouteStart(glade, portal, 10), portal]);
    }
  }
  for (const corridor of getForestTravelCorridors()) {
    const room = FOREST_ROOMS[corridor.roomId];
    if (room) segments.push([corridor.to, room.center]);
  }
  for (const spur of FOREST_WILDWOOD_SPURS) {
    for (let i = 1; i < spur.length; i++) segments.push([spur[i - 1], spur[i]]);
  }
  return segments;
}

/**
 * Deterministic, coverage-based Wildwood dressing. The older Forest systems
 * placed hundreds of props, but only around a handful of room anchors. A 28u
 * macro grid guarantees that every camera-sized patch inside the finite map
 * gets a small composition. Real KayKit trees/bushes/rocks are spatially
 * chunked by `_addKitInstances`, so off-screen cells cost no render calls.
 */
function _buildForestWildwood(parent) {
  const rand = _rng(0xF07E57A1);
  const routes = _forestRouteSegments();
  const terrainSample = {};
  const treeA = [];
  const treeB = [];
  const bushes = [];
  const rocks = [];
  const anchors = [];
  const b = FOREST_WORLD_BOUNDS;
  const step = 22;

  const nearRoute = (x, z, padding) => {
    const r2 = padding * padding;
    for (const [a, end] of routes) {
      if (_forestSegmentDistanceSq(x, z, a, end) <= r2) return true;
    }
    return false;
  };
  const nearPortal = (x, z, padding = 6.5) => {
    const r2 = padding * padding;
    for (const portal of Object.values(FOREST_PORTAL_POSITIONS)) {
      const dx = x - portal.x;
      const dz = z - portal.z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  };
  const allowed = (x, z, routePadding = 4.5) => {
    // The Glade already owns dense authored crystals, flowers, amber, houses,
    // and hazards. Begin the coverage grid outside it so this expansion fixes
    // the actual corridor/outer-world holes without double-rendering spawn.
    if (x * x + z * z < 65 * 65) return false;
    if (nearRoute(x, z, routePadding) || nearPortal(x, z)) return false;
    if (sampleStageTerrain('forest', x, z, terrainSample).active) return false;
    return x > b.minX + 4 && x < b.maxX - 4 && z > b.minZ + 4 && z < b.maxZ - 4;
  };

  let cell = 0;
  for (let z = b.minZ + step * 0.5; z < b.maxZ - step * 0.4; z += step) {
    for (let x = b.minX + step * 0.5; x < b.maxX - step * 0.4; x += step, cell++) {
      const ax = x + (rand() - 0.5) * 9;
      const az = z + (rand() - 0.5) * 9;
      if (!allowed(ax, az)) continue;
      anchors.push({ x: ax, z: az });

      const a = rand() * Math.PI * 2;
      const treeTarget = (cell & 1) === 0 ? treeA : treeB;
      const treeR = 3.8 + rand() * 2.8;
      const treeX = ax + Math.cos(a) * treeR;
      const treeZ = az + Math.sin(a) * treeR;
      if (allowed(treeX, treeZ, 9.0)) {
        treeTarget.push({
          x: treeX,
          z: treeZ,
          h: 4.7 + rand() * 3.1,
          yaw: rand() * Math.PI * 2,
          sx: 0.82 + rand() * 0.34,
          sz: 0.82 + rand() * 0.34,
          rz: (rand() - 0.5) * 0.08,
        });
      }
      for (let i = 0; i < 2; i++) {
        const ba = a + i * Math.PI + (rand() - 0.5) * 0.7;
        const br = 2.2 + rand() * 5.4;
        const bushX = ax + Math.cos(ba) * br;
        const bushZ = az + Math.sin(ba) * br;
        if (allowed(bushX, bushZ, 2.8)) {
          bushes.push({
            x: bushX,
            z: bushZ,
            h: 0.82 + rand() * 0.72,
            yaw: rand() * Math.PI * 2,
            sx: 0.78 + rand() * 0.52,
            sz: 0.78 + rand() * 0.52,
          });
        }
      }
      const ra = a + Math.PI * 0.72;
      const rockR = 2.5 + rand() * 4.5;
      const rockX = ax + Math.cos(ra) * rockR;
      const rockZ = az + Math.sin(ra) * rockR;
      if (allowed(rockX, rockZ, 2.6)) {
        rocks.push({
          x: rockX,
          z: rockZ,
          h: 0.62 + rand() * 0.82,
          yaw: rand() * Math.PI * 2,
          sx: 0.72 + rand() * 0.65,
          sy: 0.62 + rand() * 0.55,
          sz: 0.72 + rand() * 0.65,
        });
      }
    }
  }

  // Compose staggered Wildwood pockets between the separated authored rooms.
  // They visually close the retired walk-through routes while preserving the
  // logical endpoints used by the minimap's dotted portal connections.
  let corridorIndex = 0;
  for (const corridor of getForestTravelCorridors()) {
    const dx = corridor.to.x - corridor.from.x;
    const dz = corridor.to.z - corridor.from.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    for (const t of [0.24, 0.50, 0.76]) {
      const side = ((corridorIndex++ & 1) ? -1 : 1);
      const offset = side * (10.5 + rand() * 3.0);
      const cx = corridor.from.x + dx * t + nx * offset;
      const cz = corridor.from.z + dz * t + nz * offset;
      if (!allowed(cx, cz, 9.0)) continue;
      const target = (corridorIndex & 1) ? treeA : treeB;
      target.push({
        x: cx, z: cz,
        h: 4.8 + rand() * 2.5,
        yaw: rand() * Math.PI * 2,
        sx: 0.86 + rand() * 0.28,
        sz: 0.86 + rand() * 0.28,
      });
      for (const along of [-1, 1]) {
        const bx = cx + (dx / len) * along * (1.8 + rand() * 1.4);
        const bz = cz + (dz / len) * along * (1.8 + rand() * 1.4);
        if (!allowed(bx, bz, 2.8)) continue;
        bushes.push({
          x: bx, z: bz,
          h: 0.88 + rand() * 0.54,
          yaw: rand() * Math.PI * 2,
          sx: 0.84 + rand() * 0.38,
          sz: 0.84 + rand() * 0.38,
        });
      }
    }
  }

  // East Gate garden bridges the Glade's 45u authored edge to the coverage
  // grid's 65u start. Keep the three silhouettes off the road and portal pad,
  // but inside the first five-second walk camera footprint.
  bushes.push(
    { x: 54, z: 0, h: 1.18, yaw: 0.4, sx: 1.15, sz: 0.92 },
    { x: 58, z: 20, h: 1.02, yaw: 2.1, sx: 0.92, sz: 1.18 },
    { x: 65, z: -10, h: 1.08, yaw: 1.2, sx: 1.08, sz: 0.96 },
  );
  rocks.push({ x: 62, z: 1.5, h: 0.92, yaw: 1.25, sx: 1.12, sy: 0.74, sz: 0.96 });
  treeA.push({ x: 69, z: -15, h: 5.2, yaw: 0.8, sx: 0.92, sz: 0.92 });

  // A tall irregular tree line makes the finite boundary legible before the
  // movement clamp is reached. It prevents the 2,400u ground plane from
  // masquerading as an infinite playable level.
  let edgeIndex = 0;
  const edgeTree = (x, z, yaw, inwardX, inwardZ) => {
    const target = (edgeIndex++ & 1) ? treeA : treeB;
    target.push({
      x: x + (rand() - 0.5) * 0.7,
      z: z + (rand() - 0.5) * 0.7,
      h: 5.4 + rand() * 2.0,
      yaw: yaw + (rand() - 0.5) * 0.55,
      sx: 0.82 + rand() * 0.28,
      sz: 0.82 + rand() * 0.28,
    });
    bushes.push({
      x: x + inwardX * (2.6 + rand() * 1.0),
      z: z + inwardZ * (2.6 + rand() * 1.0),
      h: 0.82 + rand() * 0.46,
      yaw: rand() * Math.PI * 2,
      sx: 0.82 + rand() * 0.35,
      sz: 0.82 + rand() * 0.35,
    });
    if ((edgeIndex & 1) === 0) rocks.push({
      x: x + inwardX * (4.1 + rand() * 1.2),
      z: z + inwardZ * (4.1 + rand() * 1.2),
      h: 0.58 + rand() * 0.52,
      yaw: rand() * Math.PI * 2,
      sx: 0.76 + rand() * 0.42,
      sy: 0.62 + rand() * 0.32,
      sz: 0.76 + rand() * 0.42,
    });
  };
  for (let x = b.minX + 4; x <= b.maxX - 4; x += 9) {
    edgeTree(x, b.minZ, 0, 0, 1);
    edgeTree(x, b.maxZ, Math.PI, 0, -1);
  }
  for (let z = b.minZ + 10; z <= b.maxZ - 10; z += 9) {
    edgeTree(b.minX, z, Math.PI / 2, 1, 0);
    edgeTree(b.maxX, z, -Math.PI / 2, -1, 0);
  }

  const counts = { cells: anchors.length };
  counts.trees = _addKitInstances(parent, 'kkf_tree1', treeA, 'forest_wildwood_tree_a', 'wildwood-canopy', null, 80);
  counts.trees += _addKitInstances(parent, 'kkf_tree3', treeB, 'forest_wildwood_tree_b', 'wildwood-canopy', null, 80);
  counts.bushes = _addKitInstances(parent, 'kkf_bush2', bushes, 'forest_wildwood_bushes', 'wildwood-understory', null, 80);
  counts.rocks = _addKitInstances(parent, 'kkf_rock2', rocks, 'forest_wildwood_rocks', 'wildwood-ground-break', null, 80);
  return counts;
}

function _buildForest(parent) {
  const counts = {};
  counts.routes = _buildForestRoutes(parent);
  const wildwood = _buildForestWildwood(parent);
  counts.wildwoodCells = wildwood.cells;
  counts.wildwoodTrees = wildwood.trees;
  counts.wildwoodBushes = wildwood.bushes;
  counts.wildwoodRocks = wildwood.rocks;
  Object.assign(counts, _buildTerrainFeature(parent, 'forest'));
  counts.keep = _addKitInstances(parent, 'kit_keep', [
    { x: 0, z: -50, s: 7.5, yaw: 0 },
  ], 'forest_kingdom_keep', 'distant-landmark');
  counts.houses = _addKitInstances(parent, 'kit_house', [
    { x: 36, z: -24, s: 4.0, yaw: 0.30 },
    { x: 32, z: -36, s: 3.8, yaw: 1.65 },
    { x: -38, z: -44, s: 3.6, yaw: 0.10 },
    { x: 56, z: 74, s: 3.4, yaw: 0.20, y: -0.8, rz: 0.2 },
  ], 'forest_kingdom_houses', 'district-story');
  counts.houses += _addKitInstances(parent, 'kit_house2', [
    { x: 46, z: -34, s: 4.2, yaw: -0.40 },
    { x: -36, z: -26, s: 4.0, yaw: -0.20 },
    { x: 64, z: 84, s: 3.0, yaw: 1.10, y: -1.0, rz: 0.35 },
  ], 'forest_kingdom_townhouses', 'district-story');
  counts.inn = _addKitInstances(parent, 'kit_inn', [
    { x: 42, z: -42, s: 4.0, yaw: 0.95 },
  ], 'forest_kingdom_inn', 'district-story');
  counts.barracks = _addKitInstances(parent, 'kit_barracks', [
    { x: -44, z: -36, s: 4.6, yaw: 0.55 },
  ], 'forest_kingdom_barracks', 'district-story');
  counts.ruins = _addKitInstances(parent, 'kit_pillar_broken', [
    { x: 52, z: 88, s: 2.0, yaw: -0.60 },
    { x: 60, z: 80, s: 1.8, yaw: 1.20 },
  ], 'forest_old_ruin_pillars', 'district-story');
  counts.gate = _addKitInstances(parent, 'kit_gate', [
    { x: 0, z: 60, s: 4.8, yaw: 0 },
  ], 'forest_kingdom_gate', 'navigation-landmark');
  return counts;
}

function _buildTwilight(parent) {
  const ponds = [
    { x: -10, z: -6, sx: 5.4, sz: 3.1, yaw: -0.28 },
    { x: 14, z: 14, sx: 4.7, sz: 2.8, yaw: 0.42 },
    { x: -25, z: 18, sx: 3.7, sz: 2.2, yaw: -0.72 },
    { x: 58, z: -36, sx: 7.2, sz: 3.4, yaw: 0.28 },
    { x: -64, z: -42, sx: 6.4, sz: 3.1, yaw: -0.38 },
    { x: 57, z: 62, sx: 5.3, sz: 2.8, yaw: 0.62 },
  ];
  _buildPath(parent, [
    { x: 0, z: 0, w: 11, h: 10 },
    { x: 43, z: 0, w: 82, h: 3.4 },
    { x: -43, z: 0, w: 82, h: 3.4 },
    { x: 0, z: 45, w: 3.6, h: 82 },
    { x: 0, z: -45, w: 3.6, h: 82 },
    { x: -38, z: 38, w: 3.3, h: 92, yaw: -0.78 },
    { x: 39, z: -39, w: 3.3, h: 92, yaw: -0.78 },
  ], 0x5b5872, 'twilight_moonstone_routes', 0.94);
  _buildWater(parent, ponds, {
    seed: 0x71A710, deep: 0x071827, shallow: 0x355b78, opacity: 0.82,
  }, 'twilight_moonwater');

  const counts = { water: ponds.length };
  Object.assign(counts, _buildTerrainFeature(parent, 'twilight'));
  counts.reeds = _addReeds(parent, ponds, 0x71A711, 0x273b38, 'twilight_water_reeds');
  counts.bankRocks = _addKitInstances(parent, 'kkf_rock1', _outsideKeepouts(_pondBanks(ponds, 6, 0x71A712), TWILIGHT_FOUNTAINS, 3.6), 'twilight_pond_banks', 'water-bank', 0x59636f);
  counts.trees = _addKitInstances(parent, 'kkf_tree_bare1', _outsideKeepouts(_radial(0x71A713, 34, 16, 104, 5.5, 9.2), TWILIGHT_FOUNTAINS, 4.2), 'twilight_bare_tree_line', 'biome-silhouette', 0x5a4e57);
  counts.trees += _addKitInstances(parent, 'kkf_tree_bare2', _outsideKeepouts(_radial(0x71A714, 28, 20, 108, 4.8, 8.4), TWILIGHT_FOUNTAINS, 4.2), 'twilight_bent_tree_line', 'biome-silhouette', 0x514852);
  counts.bushes = _addKitInstances(parent, 'kkf_bush1', _outsideKeepouts(_clustered(0x71A715, ponds, 4, 4.5, 0.65, 1.05), TWILIGHT_FOUNTAINS, 3.6), 'twilight_pond_brush', 'water-bank', 0x31433d);
  const graveyards = [{ x: -30, z: 0 }, { x: 2, z: 27 }, { x: -74, z: 55 }, { x: 71, z: -63 }];
  counts.graves = _addKitInstances(parent, 'kit_grave', _outsideKeepouts(_clustered(0x71A716, graveyards, 8, 5.6, 1.0, 1.6), TWILIGHT_FOUNTAINS, 3.8), 'twilight_grave_orchards', 'story-landmark');
  counts.graves += _addKitInstances(parent, 'kit_gravestone2', _outsideKeepouts(_clustered(0x71A717, graveyards, 6, 6.0, 1.0, 1.5), TWILIGHT_FOUNTAINS, 3.8), 'twilight_gravestones', 'story-landmark');
  counts.arches = _addKitInstances(parent, 'kit_arch', _outsideKeepouts([
    { x: -18, z: 14, h: 4.8, yaw: -0.72 },
    { x: 23, z: -7, h: 5.2, yaw: 1.5 },
    { x: 1, z: 30, h: 4.5, yaw: 0.05 },
  ], TWILIGHT_FOUNTAINS, 4.2), 'twilight_ruined_arches', 'navigation-landmark');
  counts.ruins = _addKitInstances(parent, 'kit_pillar_broken', _outsideKeepouts(_clustered(0x71A718, [{ x: -18, z: 14 }, { x: 23, z: -7 }, { x: 1, z: 30 }], 3, 3.5, 1.8, 3.8), TWILIGHT_FOUNTAINS, 4.2), 'twilight_broken_pillars', 'ruin-precinct');
  counts.ruins += _addKitInstances(parent, 'kkd_wall_broken', _outsideKeepouts([
    { x: -21, z: 12, h: 3.5, yaw: -0.65 }, { x: -15, z: 17, h: 3.2, yaw: -0.8 },
    { x: 20, z: -10, h: 3.4, yaw: 1.35 }, { x: 26, z: -4, h: 3.1, yaw: 1.7 },
  ], TWILIGHT_FOUNTAINS, 4.2), 'twilight_courtyard_walls', 'ruin-precinct');
  counts.rubble = _addKitInstances(parent, 'kkd_rubble', _outsideKeepouts(_clustered(0x71A719, [{ x: -18, z: 14 }, { x: 23, z: -7 }, { x: 1, z: 30 }], 3, 4.2, 0.6, 1.2), TWILIGHT_FOUNTAINS, 4.2), 'twilight_ruin_rubble', 'ruin-precinct');
  return counts;
}

function _addBasalt(parent, keepouts) {
  const rand = _rng(0xC1D3A0);
  const SHELF_COUNT = 22;
  const SPIRE_COUNT = 52;
  const shelfGeo = new THREE.CylinderGeometry(1, 1.15, 0.32, 8, 1, false);
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x241716, roughness: 0.98, flatShading: true });
  const shelves = new THREE.InstancedMesh(shelfGeo, shelfMat, SHELF_COUNT);
  shelves.name = 'cinder_basalt_shelves';
  shelves.userData.landscapePurpose = 'terrain-break';
  const dummy = new THREE.Object3D();
  for (let i = 0; i < SHELF_COUNT; i++) {
    let a, r, x, z;
    for (let attempt = 0; attempt < 30; attempt++) {
      a = (i / SHELF_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.3;
      r = 15 + rand() * 86;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      // Shelf footprint can reach ~4.5u from its center after non-uniform
      // scale + yaw. Keep the entire shelf outside the 3u repair stay-zone.
      if (_outsideKeepouts([{ x, z }], keepouts, 5.0, 4.5).length) break;
    }
    dummy.position.set(x, 0.06, z);
    dummy.scale.set(2.0 + rand() * 2.8, 0.7 + rand() * 0.8, 1.5 + rand() * 2.2);
    dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    dummy.updateMatrix();
    shelves.setMatrixAt(i, dummy.matrix);
  }
  shelves.instanceMatrix.needsUpdate = true;
  parent.add(shelves);

  const spireGeo = new THREE.ConeGeometry(0.8, 3.2, 7, 1, false);
  const spireMat = new THREE.MeshStandardMaterial({ color: 0x35201d, roughness: 0.94, flatShading: true });
  const spires = new THREE.InstancedMesh(spireGeo, spireMat, SPIRE_COUNT);
  spires.name = 'cinder_basalt_spires';
  spires.userData.landscapePurpose = 'biome-silhouette';
  for (let i = 0; i < SPIRE_COUNT; i++) {
    let a, r, x, z;
    for (let attempt = 0; attempt < 30; attempt++) {
      a = (i / SPIRE_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.25;
      r = 30 + rand() * 78;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      if (_outsideKeepouts([{ x, z }], keepouts, 5.0).length) break;
    }
    const sy = 0.65 + rand() * 1.25;
    dummy.position.set(x, 1.6 * sy, z);
    dummy.scale.set(0.65 + rand() * 0.8, sy, 0.65 + rand() * 0.8);
    dummy.rotation.set((rand() - 0.5) * 0.18, rand() * Math.PI * 2, (rand() - 0.5) * 0.18);
    dummy.updateMatrix();
    spires.setMatrixAt(i, dummy.matrix);
  }
  spires.instanceMatrix.needsUpdate = true;
  parent.add(spires);
  _track(shelfGeo, shelfMat, spireGeo, spireMat);
  return { shelves: SHELF_COUNT, spires: SPIRE_COUNT };
}

function _buildCinder(parent) {
  _buildPath(parent, [
    { x: 0, z: 0, w: 12, h: 10 },
    { x: 51, z: 0, w: 96, h: 3.8 },
    { x: -51, z: 0, w: 96, h: 3.8 },
    { x: 0, z: 51, w: 3.8, h: 96 },
    { x: 0, z: -51, w: 3.8, h: 96 },
    { x: 42, z: 42, w: 3.5, h: 106, yaw: -Math.PI / 4 },
  ], 0x4a2923, 'cinder_siege_roads', 0.92);
  const keepouts = [
    ...CINDER_BALLISTAS.map((p) => ({ ...p, r: 5.2 })),
    ...CINDER_CATAPULTS.map((p) => ({ ...p, r: 3.8 })),
  ];
  const counts = _addBasalt(parent, keepouts);
  Object.assign(counts, _buildTerrainFeature(parent, 'cinder', keepouts));
  counts.trees = _addKitInstances(parent, 'kkf_tree_bare1', _outsideKeepouts(_radial(0xC1D3A1, 38, 17, 108, 4.5, 8.2), keepouts, 5.0), 'cinder_charred_tree_line', 'biome-silhouette', 0x4a2924);
  counts.rocks = _addKitInstances(parent, 'kkf_rock5', _outsideKeepouts(_radial(0xC1D3A2, 64, 12, 110, 0.7, 2.2), keepouts, 5.0), 'cinder_basalt_boulders', 'terrain-break', 0x3b2b2a);
  const camps = CINDER_BALLISTAS;
  const supplyAnchors = camps.map((p) => {
    const r = Math.max(1, Math.hypot(p.x, p.z));
    return { x: p.x + p.x / r * 6.4, z: p.z + p.z / r * 6.4 };
  });
  counts.walls = _addKitInstances(parent, 'kkd_wall_broken', camps.map((a, i) => {
    const r = Math.max(1, Math.hypot(a.x, a.z));
    return {
    x: a.x + a.x / r * 6.0, z: a.z + a.z / r * 6.0,
    h: 3.0 + (i % 3) * 0.3, yaw: Math.atan2(-a.z, -a.x) + Math.PI / 2,
  }; }), 'cinder_outpost_walls', 'ballista-outpost');
  counts.crates = _addKitInstances(parent, 'kkd_crates', _outsideKeepouts(_clustered(0xC1D3A3, supplyAnchors, 2, 1.5, 0.8, 1.25), keepouts, 5.0), 'cinder_supply_crates', 'ballista-outpost');
  counts.barrels = _addKitInstances(parent, 'kkd_barrel', _outsideKeepouts(_clustered(0xC1D3A4, supplyAnchors, 2, 1.7, 0.75, 1.1), keepouts, 5.0), 'cinder_supply_barrels', 'ballista-outpost');
  counts.rubble = _addKitInstances(parent, 'kkd_rubble', _outsideKeepouts(_clustered(0xC1D3A5, supplyAnchors, 3, 2.0, 0.55, 1.15), keepouts, 5.0), 'cinder_siege_rubble', 'ballista-outpost');
  return counts;
}

function _buildVoid(parent) {
  const padAnchors = VOID_PADS;
  const outerAnchors = [
    { x: 0, z: 82, yaw: 0 },
    { x: 78, z: 61, yaw: 0.90 },
    { x: 86, z: -52, yaw: 2.10 },
    { x: 0, z: -88, yaw: Math.PI },
    { x: -82, z: -58, yaw: -2.20 },
    { x: -88, z: 48, yaw: -1.05 },
  ];
  const routes = [{ x: 0, z: 0, w: 13, h: 11 }];
  for (const p of [...padAnchors, ...outerAnchors]) {
    const len = Math.hypot(p.x, p.z);
    const inner = 5.5;
    const outer = Math.max(inner + 2, len - 2.5);
    const mid = (inner + outer) * 0.5;
    routes.push({
      x: p.x / len * mid,
      z: p.z / len * mid,
      w: 3.25,
      h: outer - inner,
      yaw: Math.atan2(p.x, p.z),
    });
  }
  _buildPath(parent, routes, 0x393052, 'void_shattered_causeways', 0.94);
  const precincts = [
    ...padAnchors, ...outerAnchors,
  ];
  const counts = {};
  Object.assign(counts, _buildTerrainFeature(parent, 'void'));
  counts.arches = _addKitInstances(parent, 'kit_arch', precincts.map((p, i) => ({ ...p, h: 5.0 + (i % 2) * 0.7 })), 'void_precinct_arches', 'portal-precinct');
  counts.pillars = _addKitInstances(parent, 'kit_pillar', _ringAround(0xB01D01, precincts, 2, 4.3, 5.4, 3.2, 5.3), 'void_precinct_pillars', 'portal-precinct');
  counts.pillars += _addKitInstances(parent, 'kit_pillar_broken', _ringAround(0xB01D02, precincts, 3, 4.1, 6.0, 1.4, 3.4), 'void_broken_pillars', 'portal-precinct');
  counts.walls = _addKitInstances(parent, 'kkd_wall_broken', precincts.map((p, i) => ({
    x: p.x + Math.cos(p.yaw + Math.PI / 2) * 4.6,
    z: p.z + Math.sin(p.yaw + Math.PI / 2) * 4.6,
    h: 3.1 + (i % 3) * 0.35,
    yaw: p.yaw + Math.PI / 2,
  })), 'void_shattered_walls', 'portal-precinct');
  counts.rubble = _addKitInstances(parent, 'kkd_rubble', _ringAround(0xB01D03, precincts, 4, 3.9, 5.8, 0.55, 1.25), 'void_precinct_rubble', 'portal-precinct');
  return counts;
}

function _buildCave(parent) {
  const ponds = [
    { x: -10, z: -6, sx: 5.6, sz: 3.2, yaw: -0.25 },
    { x: 12, z: 11, sx: 4.6, sz: 2.9, yaw: 0.35 },
    { x: 21, z: -12, sx: 3.7, sz: 2.4, yaw: -0.55 },
    { x: -58, z: 44, sx: 7.2, sz: 3.6, yaw: 0.48 },
    { x: 64, z: -48, sx: 6.8, sz: 3.4, yaw: -0.34 },
    { x: 74, z: 66, sx: 5.4, sz: 2.9, yaw: 0.72 },
  ];
  _buildWater(parent, ponds, {
    seed: 0xCA7E01, deep: 0x06191d, shallow: 0x2b6562, opacity: 0.76,
  }, 'caveStage_grottoWater');
  _buildPath(parent, [
    { x: 8.5, z: 8.5, w: 3.2, h: 24, yaw: -Math.PI / 4 },
    { x: 17, z: 17, w: 8, h: 6, yaw: -Math.PI / 4 },
    { x: 42, z: 42, w: 3.2, h: 74, yaw: -Math.PI / 4 },
    { x: -42, z: 42, w: 3.0, h: 96, yaw: Math.PI / 4 },
    { x: 45, z: -45, w: 3.0, h: 102, yaw: Math.PI / 4 },
  ], 0x555761, 'caveStage_vaultPath', 0.9);
  const counts = { water: ponds.length };
  Object.assign(counts, _buildTerrainFeature(parent, 'cave'));
  counts.bankRocks = _addKitInstances(parent, 'kkf_rock3', _pondBanks(ponds, 8, 0xCA7E02, 0.85), 'caveStage_grottoBanks', 'water-bank', 0x4a525b);
  counts.steppingStones = _addKitInstances(parent, 'kkf_rock1', [
    { x: -14.0, z: -6.5, h: 0.65, yaw: 0.2, sy: 0.55 },
    { x: -11.8, z: -5.9, h: 0.75, yaw: 1.1, sy: 0.5 },
    { x: -9.6, z: -5.6, h: 0.7, yaw: 2.0, sy: 0.52 },
    { x: -7.4, z: -5.8, h: 0.68, yaw: 2.6, sy: 0.5 },
  ], 'caveStage_steppingStones', 'water-crossing', 0x56616a);
  counts.arches = _addKitInstances(parent, 'kit_arch', [
    { x: 17, z: 17, h: 5.5, yaw: -Math.PI / 4 },
  ], 'caveStage_vaultArch', 'vault-landmark');
  counts.pillars = _addKitInstances(parent, 'kit_pillar_broken', [
    { x: 13.8, z: 18.8, h: 3.4, yaw: 0.2 },
    { x: 19.2, z: 13.8, h: 2.8, yaw: 1.1 },
    { x: 21.0, z: 18.4, h: 2.2, yaw: 2.3 },
  ], 'caveStage_vaultPillars', 'vault-landmark');
  counts.rubble = _addKitInstances(parent, 'kkd_rubble', _clustered(0xCA7E03, [{ x: 17, z: 17 }], 7, 5.0, 0.55, 1.2), 'caveStage_vaultRubble', 'vault-landmark');
  counts.outerRocks = _addKitInstances(parent, 'kkf_rock5', _radial(0xCA7E04, 72, 38, 108, 0.8, 2.8), 'caveStage_outerKarst', 'biome-silhouette', 0x46505a);
  counts.outerRuins = _addKitInstances(parent, 'kit_pillar_broken', _clustered(0xCA7E05, [
    { x: -68, z: -55 }, { x: 72, z: 58 }, { x: -74, z: 61 }, { x: 68, z: -69 },
  ], 5, 7.0, 1.8, 4.5), 'caveStage_outerVaults', 'story-landmark');
  return counts;
}

export function buildStageLandscape(stageId, parent) {
  disposeStageLandscape();
  if (!parent || !['forest', 'twilight', 'cinder', 'void', 'cave'].includes(stageId)) return null;
  const root = new THREE.Group();
  root.name = `__stageLandscape_${stageId}`;
  root.userData.stageId = stageId;
  if (stageId === 'forest') root.userData.environmentDensityOwner = true;
  let counts;
  if (stageId === 'forest') counts = _buildForest(root);
  else if (stageId === 'twilight') counts = _buildTwilight(root);
  else if (stageId === 'cinder') counts = _buildCinder(root);
  else if (stageId === 'void') counts = _buildVoid(root);
  else counts = _buildCave(root);
  root.userData.counts = counts;
  parent.add(root);
  _root = root;
  if (state.run) state.run.terrainLayoutReady = stageId;
  return root;
}

export function disposeStageLandscape() {
  if (state.run) state.run.terrainLayoutReady = null;
  if (_root && _root.parent) _root.parent.remove(_root);
  if (_root) {
    _root.traverse((o) => {
      if (o.isInstancedMesh && o.dispose) {
        try { o.dispose(); } catch (_) {}
      }
    });
  }
  for (const r of _resources) {
    try { if (r && r.dispose) r.dispose(); } catch (_) {}
  }
  _resources = [];
  _root = null;
  _flagstone = null;
  _bakes.clear();
}
