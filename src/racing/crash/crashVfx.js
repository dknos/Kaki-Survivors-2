import * as THREE from 'three';
import { state } from '../../state.js';
import {
  createRacingVfx,
  spawnRacingDamageSmoke,
  spawnRacingDust,
  spawnRacingImpact,
  updateRacingVfx,
} from '../racingVfx.js';

function proxyAt(point, velocity = {}) {
  return {
    physics: {
      x: point?.x || 0,
      y: point?.y || 0,
      z: point?.z || 0,
      yaw: Math.atan2(velocity.x || 0, velocity.z || 1),
      vx: velocity.x || 0,
      vy: velocity.y || 0,
      vz: velocity.z || 0,
      speed: Math.hypot(velocity.x || 0, velocity.z || 0),
      integrity: 100,
    },
  };
}

export function createCrashVfx({ root, owned, atlas = null }) {
  const pooled = createRacingVfx({
    root,
    owned,
    course: { id: 'cinder' },
    capacity: 340,
    vfxAtlas: atlas,
  });
  const explosionPool = [];
  const boomPool = [];
  const flashMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc45f,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xffdc72,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  owned.materials.add(flashMaterial);
  owned.materials.add(ringMaterial);
  const sphereGeometry = new THREE.IcosahedronGeometry(1, 2);
  const ringGeometry = new THREE.RingGeometry(0.78, 1, 48);
  owned.geometries.add(sphereGeometry);
  owned.geometries.add(ringGeometry);
  for (let index = 0; index < 6; index++) {
    const sphere = new THREE.Mesh(sphereGeometry, flashMaterial.clone());
    owned.materials.add(sphere.material);
    sphere.visible = false;
    sphere.userData.vfx = { life: 0, maxLife: 1 };
    root.add(sphere);
    explosionPool.push(sphere);
  }
  for (let index = 0; index < 3; index++) {
    const ring = new THREE.Mesh(ringGeometry, ringMaterial.clone());
    owned.materials.add(ring.material);
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ring.userData.vfx = { life: 0, maxLife: 1 };
    root.add(ring);
    boomPool.push(ring);
  }
  return { pooled, explosionPool, boomPool, explosionCursor: 0, boomCursor: 0 };
}

export function spawnCrashImpact(vfx, event, strength = 1) {
  if (!vfx || !event?.point) return;
  const velocity = event.velocity || { x: event.direction?.x || 0, y: 0, z: event.direction?.z || 0 };
  const proxy = proxyAt(event.point, velocity);
  spawnRacingImpact(vfx.pooled, proxy, Math.min(1.8, strength), strength > 0.8 ? 'debris' : 'spark');
  if (strength > 0.75) spawnRacingDust(vfx.pooled, proxy, Math.min(1.4, strength), false);
}

export function spawnCrashSmoke(vfx, entity) {
  if (!vfx || !entity?.body || !(entity.damage?.smoke > 0.05)) return;
  const position = entity.body.translation();
  const velocity = entity.body.linvel();
  const proxy = proxyAt(position, velocity);
  proxy.physics.integrity = Math.max(1, 100 * (1 - entity.damage.severity));
  spawnRacingDamageSmoke(vfx.pooled, proxy);
}

export function spawnCrashExplosion(vfx, point, strength = 1) {
  if (!vfx || !point) return;
  const mesh = vfx.explosionPool[vfx.explosionCursor++ % vfx.explosionPool.length];
  mesh.position.set(point.x, Math.max(0.7, point.y || 0.7), point.z);
  mesh.scale.setScalar(0.7);
  mesh.visible = true;
  mesh.material.opacity = state._optReducedFlashing ? 0.28 : 0.82;
  mesh.userData.vfx.life = mesh.userData.vfx.maxLife = state._optReducedFlashing ? 0.28 : 0.42;
  mesh.userData.vfx.strength = strength;
  const proxy = proxyAt(point);
  for (let burst = 0; burst < (state._optReducedFlashing ? 2 : 4); burst++) {
    spawnRacingImpact(vfx.pooled, proxy, Math.min(1.8, strength + burst * 0.1), 'debris');
    spawnRacingDust(vfx.pooled, proxy, Math.min(1.5, strength), true);
  }
}

export function spawnKakiBoomVfx(vfx, point) {
  if (!vfx || !point) return;
  const ring = vfx.boomPool[vfx.boomCursor++ % vfx.boomPool.length];
  ring.position.set(point.x, 0.16, point.z);
  ring.scale.setScalar(1);
  ring.visible = true;
  ring.material.opacity = state._optReducedFlashing ? 0.34 : 0.78;
  ring.userData.vfx.life = ring.userData.vfx.maxLife = state._optReduceMotion ? 0.62 : 0.82;
}

export function updateCrashVfx(vfx, dt) {
  if (!vfx) return;
  updateRacingVfx(vfx.pooled, dt);
  for (const sphere of vfx.explosionPool) {
    const data = sphere.userData.vfx;
    if (data.life <= 0) { sphere.visible = false; continue; }
    data.life = Math.max(0, data.life - dt);
    const t = 1 - data.life / data.maxLife;
    const scale = 0.7 + t * 7.5 * (data.strength || 1);
    sphere.scale.setScalar(scale);
    sphere.material.opacity = (1 - t) * (state._optReducedFlashing ? 0.2 : 0.72);
  }
  for (const ring of vfx.boomPool) {
    const data = ring.userData.vfx;
    if (data.life <= 0) { ring.visible = false; continue; }
    data.life = Math.max(0, data.life - dt);
    const t = 1 - data.life / data.maxLife;
    ring.scale.setScalar(1 + t * 23);
    ring.material.opacity = (1 - t) * (state._optReducedFlashing ? 0.26 : 0.68);
  }
}
