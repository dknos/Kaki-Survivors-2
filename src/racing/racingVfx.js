import * as THREE from 'three';
import { state } from '../state.js';
import {
  cloneTextureForDeferredUpload,
  requestTextureUploadIfReady,
} from '../rendering/textureUpload.js';

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _color = new THREE.Color();

const SURFACE_PALETTE = Object.freeze({
  forest: Object.freeze({ dust: 0x745541, secondary: 0x9b7653, sparkle: 0xa5d48a }),
  twilight: Object.freeze({ dust: 0x6f8793, secondary: 0xa8c9d5, sparkle: 0x75dbff }),
  cinder: Object.freeze({ dust: 0x4c3530, secondary: 0x765047, sparkle: 0xff7738 }),
  void: Object.freeze({ dust: 0x574268, secondary: 0x8b6ba4, sparkle: 0xcf79ff }),
  cave: Object.freeze({ dust: 0x77716c, secondary: 0xa7a096, sparkle: 0x73efc5 }),
  kakiland: Object.freeze({ dust: 0xb7a677, secondary: 0xdce8b2, sparkle: 0xff85c9 }),
});

function _own(owned, geometry, material) {
  owned.geometries.add(geometry);
  owned.materials.add(material);
}

function _makeInstanced(root, owned, geometry, material, capacity, name) {
  _own(owned, geometry, material);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.userData.raceOwned = true;
  for (let i = 0; i < capacity; i++) {
    _matrix.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, _matrix);
    mesh.setColorAt(i, _color.setHex(0xffffff));
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  root.add(mesh);
  return mesh;
}

function _atlasFrame(source, column, row, owned) {
  if (!source) return null;
  const texture = cloneTextureForDeferredUpload(source);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(0.25, 0.25);
  texture.offset.set(column * 0.25, (3 - row) * 0.25);
  requestTextureUploadIfReady(texture);
  owned.textures.add(texture);
  return texture;
}

function _pool(capacity) {
  return Array.from({ length: capacity }, () => ({
    life: 0,
    maxLife: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    drag: 0,
    gravity: 0,
    size: 0,
    grow: 0,
    yaw: 0,
    spin: 0,
    stretch: 1,
    color: 0xffffff,
  }));
}

export function createRacingVfx({ root, owned, course, capacity = 168, vfxAtlas = null }) {
  const puffsCapacity = Math.max(96, capacity);
  const debrisCapacity = Math.max(48, Math.round(capacity * 0.45));
  const skidCapacity = 112;
  const puffMaterial = vfxAtlas ? new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: _atlasFrame(vfxAtlas, 0, 1, owned),
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    alphaTest: 0.012,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }) : new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const debrisMaterial = vfxAtlas ? new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: _atlasFrame(vfxAtlas, 1, 2, owned),
    vertexColors: true,
    transparent: true,
    opacity: 0.94,
    alphaTest: 0.012,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  }) : new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.76,
    metalness: 0.08,
    flatShading: true,
  });
  const skidMaterial = new THREE.MeshBasicMaterial({
    color: 0x18141a,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const puffs = _makeInstanced(
    root,
    owned,
    vfxAtlas ? new THREE.PlaneGeometry(1.25, 1.25) : new THREE.IcosahedronGeometry(0.5, 1),
    puffMaterial,
    puffsCapacity,
    'rally-contact-puffs',
  );
  const debris = _makeInstanced(
    root,
    owned,
    vfxAtlas ? new THREE.PlaneGeometry(1.35, 1.35) : new THREE.TetrahedronGeometry(0.34, 0),
    debrisMaterial,
    debrisCapacity,
    'rally-impact-debris',
  );
  const skids = _makeInstanced(
    root,
    owned,
    new THREE.PlaneGeometry(0.34, 1.75),
    skidMaterial,
    skidCapacity,
    'rally-skid-marks',
  );
  puffs.userData.productionAtlas = !!vfxAtlas;
  debris.userData.productionAtlas = !!vfxAtlas;
  skids.renderOrder = -1;
  return {
    courseId: course.id,
    palette: SURFACE_PALETTE[course.id] || SURFACE_PALETTE.forest,
    puffMesh: puffs,
    debrisMesh: debris,
    skidMesh: skids,
    puffs: _pool(puffsCapacity),
    debris: _pool(debrisCapacity),
    skids: _pool(skidCapacity),
    puffCursor: 0,
    debrisCursor: 0,
    skidCursor: 0,
    time: 0,
    productionAtlas: !!vfxAtlas,
  };
}

function _spawn(pool, cursorKey, vfx) {
  const cursor = vfx[cursorKey]++ % pool.length;
  return pool[cursor];
}

function _wheelContact(p, side, rear = true) {
  const sin = Math.sin(p.yaw);
  const cos = Math.cos(p.yaw);
  const lateral = side * 1.05;
  const longitudinal = rear ? -1.18 : 0.98;
  return {
    x: p.x + lateral * cos + longitudinal * sin,
    z: p.z - lateral * sin + longitudinal * cos,
  };
}

export function spawnRacingDust(vfx, car, strength = 1, boost = false) {
  if (!vfx || !car?.physics) return;
  const p = car.physics;
  for (const side of [-1, 1]) {
    const particle = _spawn(vfx.puffs, 'puffCursor', vfx);
    const contact = _wheelContact(p, side, true);
    particle.life = particle.maxLife = boost ? 0.34 : 0.66;
    particle.x = contact.x;
    particle.y = 0.18 + Math.random() * 0.09;
    particle.z = contact.z;
    particle.vx = -p.vx * 0.075 + side * Math.cos(p.yaw) * (0.5 + Math.random());
    particle.vy = 0.7 + Math.random() * (boost ? 0.8 : 0.48);
    particle.vz = -p.vz * 0.075 - side * Math.sin(p.yaw) * (0.5 + Math.random());
    particle.drag = 1.05;
    particle.gravity = boost ? 1.8 : 0.48;
    particle.size = (boost ? 0.28 : 0.46) * strength;
    particle.grow = boost ? 1.3 : 2.25;
    particle.yaw = Math.random() * Math.PI;
    particle.spin = (Math.random() - 0.5) * 2.2;
    particle.stretch = boost ? 1.55 : 0.72;
    particle.color = boost ? vfx.palette.sparkle : (side > 0 ? vfx.palette.dust : vfx.palette.secondary);
  }
}

export function spawnRacingSkid(vfx, car, strength = 1) {
  if (!vfx || !car?.physics || strength < 0.12) return;
  const p = car.physics;
  for (const side of [-1, 1]) {
    const mark = _spawn(vfx.skids, 'skidCursor', vfx);
    const contact = _wheelContact(p, side, true);
    mark.life = mark.maxLife = 6.2;
    mark.x = contact.x;
    mark.y = 0.135;
    mark.z = contact.z;
    mark.size = 0.72 + Math.min(0.5, strength * 0.22);
    mark.stretch = 0.8 + Math.min(0.8, p.speed * 0.025);
    mark.yaw = p.yaw;
    mark.color = 0x18141a;
  }
}

export function spawnRacingDamageSmoke(vfx, car) {
  if (!vfx || !car?.physics) return;
  const p = car.physics;
  const particle = _spawn(vfx.puffs, 'puffCursor', vfx);
  particle.life = particle.maxLife = 1.3;
  particle.x = p.x + Math.sin(p.yaw) * 0.82;
  particle.y = p.y + 1.1;
  particle.z = p.z + Math.cos(p.yaw) * 0.82;
  particle.vx = -p.vx * 0.045 + (Math.random() - 0.5) * 0.42;
  particle.vy = 1.1 + Math.random() * 0.55;
  particle.vz = -p.vz * 0.045 + (Math.random() - 0.5) * 0.42;
  particle.drag = 0.36;
  particle.gravity = -0.12;
  particle.size = p.integrity < 18 ? 0.58 : 0.4;
  particle.grow = 1.15;
  particle.yaw = Math.random() * Math.PI;
  particle.spin = (Math.random() - 0.5) * 0.7;
  particle.stretch = 1;
  particle.color = p.integrity < 18 ? 0x171419 : 0x66646b;
}

export function spawnRacingImpact(vfx, car, strength = 0.5, kind = 'spark') {
  if (!vfx || !car?.physics) return;
  const p = car.physics;
  const reduced = !!state._optReducedFlashing;
  const count = Math.round(4 + Math.min(1.5, strength) * (kind === 'debris' ? 8 : 5) * (reduced ? 0.65 : 1));
  for (let i = 0; i < count; i++) {
    const shard = _spawn(vfx.debris, 'debrisCursor', vfx);
    const angle = Math.random() * Math.PI * 2;
    const impulse = (2.8 + Math.random() * 6.2) * (0.55 + strength * 0.6);
    shard.life = shard.maxLife = kind === 'debris' ? 0.75 + Math.random() * 0.42 : 0.3 + Math.random() * 0.2;
    shard.x = p.x;
    shard.y = Math.max(0.42, p.y + 0.55);
    shard.z = p.z;
    shard.vx = Math.cos(angle) * impulse - p.vx * 0.035;
    shard.vy = (kind === 'debris' ? 2.3 : 1.3) + Math.random() * impulse * 0.48;
    shard.vz = Math.sin(angle) * impulse - p.vz * 0.035;
    shard.drag = kind === 'debris' ? 0.72 : 1.65;
    shard.gravity = kind === 'debris' ? 13 : 8;
    shard.size = kind === 'debris' ? 0.22 + Math.random() * 0.24 : 0.09 + Math.random() * 0.1;
    shard.grow = -0.12;
    shard.yaw = Math.random() * Math.PI;
    shard.spin = (Math.random() - 0.5) * 15;
    shard.stretch = kind === 'debris' ? 1 : 2.8;
    shard.color = kind === 'debris'
      ? (i % 3 === 0 ? vfx.palette.sparkle : 0x30262d)
      : (i % 2 ? 0xffd36f : 0xfff4d2);
  }
}

function _stampPool(mesh, pool, dt, kind) {
  for (let i = 0; i < pool.length; i++) {
    const item = pool[i];
    if (item.life <= 0) {
      _matrix.makeScale(0, 0, 0);
      mesh.setMatrixAt(i, _matrix);
      continue;
    }
    item.life = Math.max(0, item.life - dt);
    const life = item.life / item.maxLife;
    if (kind !== 'skid') {
      const damping = Math.exp(-item.drag * dt);
      item.vx *= damping;
      item.vz *= damping;
      item.vy -= item.gravity * dt;
      item.x += item.vx * dt;
      item.y = Math.max(0.08, item.y + item.vy * dt);
      item.z += item.vz * dt;
      item.yaw += item.spin * dt;
    }
    const fade = kind === 'skid'
      ? Math.min(1, life * 2.2) * Math.min(1, (1 - life) * 12)
      : Math.min(1, life * 2.6);
    const size = Math.max(0, item.size * (1 + item.grow * (1 - life)) * fade);
    if (kind === 'skid') {
      _euler.set(-Math.PI / 2, 0, -item.yaw);
      _scale.set(size, size * item.stretch, 1);
    } else if (mesh.userData.productionAtlas) {
      _euler.set(0, Math.PI * 0.25, 0);
      _scale.set(size, size * item.stretch, 1);
    } else {
      _euler.set(item.yaw * 0.23, item.yaw, item.yaw * 0.37);
      _scale.set(size, size * item.stretch, size);
    }
    _quaternion.setFromEuler(_euler);
    _position.set(item.x, item.y, item.z);
    _matrix.compose(_position, _quaternion, _scale);
    mesh.setMatrixAt(i, _matrix);
    mesh.setColorAt(i, _color.setHex(item.color).multiplyScalar(kind === 'skid' ? 0.5 + fade * 0.5 : 0.58 + fade * 0.42));
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

export function updateRacingVfx(vfx, dt) {
  if (!vfx || !(dt > 0)) return;
  vfx.time += dt;
  _stampPool(vfx.puffMesh, vfx.puffs, dt, 'puff');
  _stampPool(vfx.debrisMesh, vfx.debris, dt, 'debris');
  _stampPool(vfx.skidMesh, vfx.skids, dt, 'skid');
}
