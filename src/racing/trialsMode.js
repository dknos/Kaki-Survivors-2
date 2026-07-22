/**
 * Kaki Trials — dedicated side-scrolling monster-truck / rally-buggy runtime.
 *
 * This module intentionally owns its scene, HUD and lifecycle without importing
 * the isometric racing facade. Handling and score decisions stay in the pure
 * trials modules; this file turns their events into readable, playful feedback.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { getRendererDiagnostics } from '../rendering/rendererAccess.js';
import { AVATARS } from '../config.js';
import { isDashPressed, consumeJump } from '../input.js';
import {
  sfx,
  updateRacingAudio,
  stopRacingAudio,
  playRacingImpact,
} from '../audio.js';
import {
  TRIALS_TRACKS,
  TRIALS_TRACK_ORDER,
  getTrialsTrack,
  sampleTrialsGround,
} from './trialsTracks.js';
import {
  getTrialsProfile,
  createTrialsState,
  resetTrialsState,
  stepTrials,
  createTrialsScoreState,
  stepTrialsScore,
  awardTrialsDestruction,
  createTrialsResult,
} from './trialsPhysics.js';
import { buildMonsterTruck } from './monsterSmash.js';
import { createRallyAssetLease, getRallyAssetCacheSnapshot } from './racingAssets.js';
import { buildGhostVehicle, buildTrialsBuggy } from './racingVehicles.js';
import { buildTrialsEnvironment, updateTrialsEnvironment } from './trialsEnvironment.js';
import { attachRacingCameraManager } from './cameras/cameraSessionBinding.js';
import { createTrialsParticleMaterial } from '../rendering/materials/trialsParticleMaterial.js';

const TRIALS_CX = 720;
const TRIALS_CZ = -520;
const COUNTDOWN_SECONDS = 3.35;
const PROGRESS_KEY = 'kks_rally_trials_v1';
const GHOST_HZ = 10;
const MAX_GHOST_SAMPLES = 1800;
const TRIALS_PARTICLE_CAPACITY = 56;
const _cameraTarget = new THREE.Vector3(TRIALS_CX, 4, TRIALS_CZ);
const _particleObject = new THREE.Object3D();
const _touch = { throttle: false, brake: false, noseUp: false, noseDown: false, turbo: false, restart: false };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function _safeSfx(name) {
  try { sfx?.[name]?.(); } catch (_) {}
}

function _hex(value) {
  return `#${Number(value || 0).toString(16).padStart(6, '0')}`;
}

function _ownedMesh(geometry, material, owned) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.raceOwned = true;
  owned.geometries.add(geometry);
  if (Array.isArray(material)) material.forEach((entry) => owned.materials.add(entry));
  else owned.materials.add(material);
  return mesh;
}

function _material(owned, options, basic = false) {
  const material = basic
    ? new THREE.MeshBasicMaterial(options)
    : new THREE.MeshStandardMaterial(options);
  owned.materials.add(material);
  return material;
}

function _readProgress() {
  const fallback = { version: 1, unlocked: ['meadow'], records: {} };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return fallback;
    const unlocked = Array.isArray(parsed.unlocked)
      ? parsed.unlocked.filter((id) => TRIALS_TRACK_ORDER.includes(id))
      : [];
    if (!unlocked.includes('meadow')) unlocked.unshift('meadow');
    const records = parsed.records && typeof parsed.records === 'object' ? parsed.records : {};
    return { version: 1, unlocked: [...new Set(unlocked)], records };
  } catch (_) {
    return fallback;
  }
}

function _writeProgress(progress) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch (_) {}
}

function _validGhost(record, track) {
  const source = Array.isArray(record?.ghost) ? record.ghost : record?.ghost?.samples;
  if (!Array.isArray(source)) return [];
  const samples = [];
  let lastTime = -Infinity;
  for (const sample of source.slice(0, MAX_GHOST_SAMPLES)) {
    const t = Number(sample?.t);
    const x = Number(sample?.x);
    const y = Number(sample?.y);
    const pitch = Number(sample?.p ?? sample?.pitch);
    if (![t, x, y, pitch].every(Number.isFinite) || t < lastTime || t < 0) continue;
    if (x < -5 || x > track.length + 8 || y < -50 || y > 120) continue;
    samples.push({ t, x, y, p: pitch });
    lastTime = t;
  }
  return samples;
}

function _roundedSlabGeometry(width, height, depth, radius = 0.16, bevel = 0.045) {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const corner = Math.max(0.01, Math.min(radius, halfWidth - 0.01, halfHeight - 0.01));
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + corner, -halfHeight);
  shape.lineTo(halfWidth - corner, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + corner);
  shape.lineTo(halfWidth, halfHeight - corner);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - corner, halfHeight);
  shape.lineTo(-halfWidth + corner, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - corner);
  shape.lineTo(-halfWidth, -halfHeight + corner);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + corner, -halfHeight);
  const bevelSize = Math.min(bevel, corner * 0.44, depth * 0.22);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: 4,
    bevelEnabled: bevelSize > 0,
    bevelSegments: 2,
    bevelSize,
    bevelThickness: bevelSize,
  });
  geometry.translate(0, 0, -depth * 0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function _capsuleGeometry(radius, totalLength, capSegments = 5, radialSegments = 10) {
  return new THREE.CapsuleGeometry(
    radius,
    Math.max(0.01, totalLength - radius * 2),
    capSegments,
    radialSegments,
  );
}

function _crownGeometry(width, height, depth = 0.15) {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth, -halfHeight);
  shape.lineTo(-halfWidth * 0.9, halfHeight * 0.55);
  shape.lineTo(-halfWidth * 0.42, halfHeight * 0.05);
  shape.lineTo(0, halfHeight);
  shape.lineTo(halfWidth * 0.42, halfHeight * 0.05);
  shape.lineTo(halfWidth * 0.9, halfHeight * 0.55);
  shape.lineTo(halfWidth, -halfHeight);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: Math.min(0.045, depth * 0.26),
    bevelThickness: Math.min(0.045, depth * 0.26),
  });
  geometry.translate(0, 0, -depth * 0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function _cartTubGeometry(width, height, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(-width * 0.5, height * 0.46);
  shape.lineTo(-width * 0.38, -height * 0.5);
  shape.lineTo(width * 0.38, -height * 0.5);
  shape.lineTo(width * 0.5, height * 0.46);
  shape.lineTo(width * 0.36, height * 0.5);
  shape.lineTo(-width * 0.36, height * 0.5);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.055,
    bevelThickness: 0.055,
  });
  geometry.translate(0, 0, -depth * 0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function _buildArch(session, marker, index, finish = false) {
  const { track, root, owned } = session;
  const ground = sampleTrialsGround(track, marker.x);
  if (!ground) return null;
  const group = new THREE.Group();
  const dark = _material(owned, { color: track.colors.shadow, roughness: 0.62, metalness: 0.18 });
  const glow = _material(owned, {
    color: finish ? 0xfff2a6 : track.colors.accent,
    emissive: finish ? 0xffc95c : track.colors.accent,
    emissiveIntensity: finish ? 1.15 : 0.68,
    roughness: 0.42,
  });
  group.name = finish ? 'kaki-trials-crown-finish' : `kaki-trials-paw-checkpoint-${index + 1}`;
  group.userData.visualTheme = finish ? 'kaki-crown' : 'kaki-paw';
  const postGeometry = _capsuleGeometry(0.22, 5.3, 6, 12);
  for (const side of [-1, 1]) {
    const post = _ownedMesh(postGeometry, dark, owned);
    post.name = `${side < 0 ? 'left' : 'right'}-rounded-gate-post`;
    post.position.set(side * 1.25, 2.65, 0);
    post.scale.z = 1.16;
    post.castShadow = true;
    group.add(post);
    const collar = _ownedMesh(new THREE.TorusGeometry(0.27, 0.075, 7, 16), glow, owned);
    collar.name = `${side < 0 ? 'left' : 'right'}-gate-collar`;
    collar.position.set(side * 1.25, 0.38, 0);
    group.add(collar);
  }
  const arch = _ownedMesh(new THREE.TorusGeometry(1.25, 0.19, 8, 30, Math.PI), glow, owned);
  arch.name = finish ? 'finish-crown-arch' : 'checkpoint-paw-arch';
  arch.position.set(0, 5.04, 0);
  arch.castShadow = true;
  group.add(arch);

  if (finish) {
    const crown = _ownedMesh(_crownGeometry(1.42, 1.02, 0.2), glow, owned);
    crown.name = 'kaki-finish-crown';
    crown.position.set(0, 5.72, 0.16);
    crown.castShadow = true;
    group.add(crown);
    for (const [x, y, size] of [[-0.43, 5.92, 0.1], [0, 6.18, 0.12], [0.43, 5.92, 0.1]]) {
      const jewel = _ownedMesh(new THREE.SphereGeometry(size, 10, 7), dark, owned);
      jewel.name = 'finish-crown-jewel';
      jewel.position.set(x, y, 0.31);
      group.add(jewel);
    }
  } else {
    const pad = _ownedMesh(new THREE.SphereGeometry(0.43, 14, 9), glow, owned);
    pad.name = 'kaki-paw-pad';
    pad.position.set(0, 5.52, 0.2);
    pad.scale.set(1, 0.72, 0.34);
    group.add(pad);
    const toes = [
      [-0.38, 5.87, -0.16],
      [-0.13, 6.03, -0.04],
      [0.15, 6.03, 0.04],
      [0.4, 5.85, 0.16],
    ];
    for (const [x, y, tilt] of toes) {
      const toe = _ownedMesh(new THREE.SphereGeometry(0.16, 10, 7), glow, owned);
      toe.name = 'kaki-paw-toe';
      toe.position.set(x, y, 0.2);
      toe.rotation.z = tilt;
      toe.scale.set(0.86, 1.12, 0.58);
      group.add(toe);
    }
  }
  group.position.set(marker.x, ground.height, -2.2);
  group.userData.markerIndex = index;
  group.userData.finish = finish;
  root.add(group);
  return { group, glow, index, passed: false, baseEmissive: glow.emissiveIntensity };
}

function _buildMarkers(session) {
  session.markers = session.track.checkpoints
    .map((checkpoint, index) => _buildArch(session, checkpoint, index, false))
    .filter(Boolean);
  session.finishMarker = _buildArch(session, { x: session.track.finish }, session.track.checkpoints.length, true);
}

function _obstaclePalette(track, kind) {
  if (kind.includes('candy') || kind.includes('crown')) return [track.colors.accent, 0xffe58a, 0xffffff];
  if (kind.includes('hay')) return [0xf2c85b, 0x9c7130, 0xf8dc83];
  if (kind.includes('rock')) return [0x777b83, 0x4c5058, 0xa7aab0];
  if (kind.includes('ore') || kind.includes('barrel')) return [0x5b6974, 0x292d35, track.colors.accent];
  if (kind.includes('toy')) return [track.colors.accent, 0xffd866, 0x20232b];
  return [0xb87345, 0x5e3827, 0xe9b36d];
}

function _buildObstacle(session, data, index) {
  const { track, root, owned } = session;
  const ground = sampleTrialsGround(track, data.x);
  const group = new THREE.Group();
  group.name = `kaki-trials-obstacle-${data.kind}-${data.id || index}`;
  const colors = _obstaclePalette(track, data.kind);
  const mats = colors.map((color, materialIndex) => _material(owned, {
    color,
    emissive: materialIndex === 2 ? color : 0x000000,
    emissiveIntensity: materialIndex === 2 ? 0.14 : 0,
    roughness: materialIndex === 1 ? 0.9 : 0.66,
    metalness: data.kind.includes('cart') || data.kind.includes('barrel') ? 0.24 : 0.02,
  }));
  const add = (geometry, material = mats[0], x = 0, y = 0, z = 0) => {
    const piece = _ownedMesh(geometry, material, owned);
    piece.position.set(x, y, z);
    piece.castShadow = true;
    piece.userData.debrisSeed = group.children.length + index * 11;
    group.add(piece);
    return piece;
  };
  const width = data.width;
  const height = data.height;

  if (data.kind === 'hay-bale') {
    const radius = height * 0.46;
    const bale = add(_capsuleGeometry(radius, width, 5, 14), mats[0], 0, height * 0.5);
    bale.name = 'rounded-hay-bale';
    bale.rotation.z = Math.PI / 2;
    bale.scale.z = 0.9;
    for (const side of [-0.28, 0.28]) {
      const band = add(new THREE.TorusGeometry(radius * 0.94, 0.065, 6, 18), mats[1], width * side, height * 0.5);
      band.name = 'hay-twine-band';
      band.rotation.y = Math.PI / 2;
      band.scale.z = 0.9;
    }
    for (const side of [-1, 1]) {
      const tuft = add(new THREE.ConeGeometry(0.15, 0.48, 5), mats[2], side * width * 0.38, height * 0.9, 0.25);
      tuft.name = 'hay-tuft';
      tuft.rotation.z = side * 0.48;
    }
  } else if (data.kind.includes('crate')) {
    const crate = add(_roundedSlabGeometry(width, height, 1.7, 0.14, 0.045), mats[0], 0, height * 0.5);
    crate.name = data.kind === 'candy-crate' ? 'candy-paw-crate-shell' : 'rounded-wood-crate-shell';
    for (const sign of [-1, 1]) {
      const brace = add(_capsuleGeometry(0.065, width * 1.12, 4, 8), mats[1], 0, height * 0.5, 0.9);
      brace.name = 'crate-diagonal-brace';
      brace.rotation.z = sign * 0.67;
    }
    if (data.kind === 'candy-crate') {
      const candyRing = add(new THREE.TorusGeometry(height * 0.25, 0.075, 7, 20), mats[2], 0, height * 0.52, 0.93);
      candyRing.name = 'candy-crate-paw-ring';
      const candyPad = add(new THREE.SphereGeometry(height * 0.13, 10, 7), mats[2], 0, height * 0.5, 0.98);
      candyPad.name = 'candy-crate-paw-pad';
      candyPad.scale.set(1.18, 0.82, 0.34);
    } else {
      for (const x of [-0.36, 0.36]) {
        const bolt = add(new THREE.SphereGeometry(0.07, 8, 6), mats[2], width * x, height * 0.5, 0.94);
        bolt.name = 'crate-brass-bolt';
      }
    }
  } else if (data.kind === 'toy-car' || data.kind === 'ore-cart') {
    const oreCart = data.kind === 'ore-cart';
    const chassis = add(
      oreCart
        ? _cartTubGeometry(width, height * 0.62, 1.72)
        : _roundedSlabGeometry(width, height * 0.52, 1.72, 0.3, 0.065),
      mats[0],
      0,
      height * (oreCart ? 0.55 : 0.44),
    );
    chassis.name = oreCart ? 'faceted-ore-cart-tub' : 'rounded-kaki-toy-car-body';
    if (oreCart) {
      const ore = add(new THREE.DodecahedronGeometry(height * 0.25, 0), mats[2], -width * 0.1, height * 0.92, 0.08);
      ore.name = 'glowing-cart-ore';
      ore.scale.set(1.4, 0.84, 0.82);
    } else {
      const canopy = add(new THREE.SphereGeometry(height * 0.43, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.68), mats[2], -width * 0.08, height * 0.69);
      canopy.name = 'toy-car-bubble-canopy';
      canopy.scale.set(1.08, 0.76, 0.9);
      for (const side of [-1, 1]) {
        const ear = add(new THREE.ConeGeometry(height * 0.11, height * 0.24, 3), mats[0], side * width * 0.18, height * 0.88, 0.05);
        ear.name = 'toy-car-kaki-ear';
        ear.rotation.z = side * -0.14;
      }
    }
    const axle = add(_capsuleGeometry(0.07, width * 0.78, 4, 8), mats[1], 0, height * 0.23, 0.08);
    axle.name = 'cart-rounded-axle';
    axle.rotation.z = Math.PI / 2;
    for (const side of [-1, 1]) {
      const wheel = add(new THREE.TorusGeometry(height * 0.18, height * 0.075, 7, 18), mats[1], side * width * 0.31, height * 0.24, 0.93);
      wheel.name = 'cart-rounded-wheel';
      const hub = add(new THREE.TorusGeometry(height * 0.075, height * 0.03, 6, 14), mats[2], side * width * 0.31, height * 0.24, 0.95);
      hub.name = 'cart-wheel-hub-ring';
    }
  } else if (data.kind === 'barrel-stack') {
    for (const [x, y] of [[-0.55, 0.65], [0.55, 0.65], [0, 1.75]]) {
      const barrel = add(_capsuleGeometry(0.5, 1.25, 5, 12), mats[0], x, y);
      barrel.name = 'rounded-ore-barrel';
      barrel.scale.x = 1.04;
      barrel.scale.z = 1.04;
      for (const bandY of [-0.35, 0.35]) {
        const band = add(new THREE.TorusGeometry(0.5, 0.065, 6, 16), mats[2], x, y + bandY);
        band.name = 'barrel-raised-band';
        band.rotation.x = Math.PI / 2;
      }
    }
  } else if (data.kind === 'rock-stack') {
    for (const [x, y, scale] of [
      [-0.82, 0.62, 0.84],
      [0.62, 0.68, 0.94],
      [-0.14, 1.55, 0.76],
      [0.58, 1.63, 0.56],
      [-0.6, 1.46, 0.5],
      [0.02, 2.18, 0.52],
    ]) {
      const rock = add(new THREE.DodecahedronGeometry(scale, 0), mats[0], x, y);
      rock.name = 'clustered-faceted-rock';
      rock.rotation.set(x * 0.2, y * 0.18, x * -0.15);
      rock.scale.set(1 + (index % 3) * 0.06, 0.78 + ((index + Math.round(y * 10)) % 3) * 0.09, 0.82);
    }
  } else {
    const podium = add(_roundedSlabGeometry(width, height * 0.42, 1.75, 0.28, 0.065), mats[0], 0, height * 0.22);
    podium.name = 'crown-stack-rounded-podium';
    const crownGeometry = _crownGeometry(width * 0.27, height * 0.68, 0.18);
    for (const side of [-1, 0, 1]) {
      const crown = add(crownGeometry, mats[2], side * width * 0.29, height * (side === 0 ? 0.67 : 0.62), 0.12);
      crown.name = 'stacked-kaki-crown';
      crown.rotation.z = side * -0.13;
      crown.scale.setScalar(side === 0 ? 1.08 : 0.9);
    }
    const pawPad = add(new THREE.SphereGeometry(height * 0.13, 10, 7), mats[2], 0, height * 0.21, 0.94);
    pawPad.name = 'crown-podium-paw-pad';
    pawPad.scale.set(1.18, 0.78, 0.34);
  }
  group.position.set(data.x, ground?.height || 0, 0.3);
  root.add(group);
  return {
    data,
    group,
    groundY: ground?.height || 0,
    destroyed: false,
    debrisAge: 0,
    hitTime: 0,
  };
}

function _buildObstacles(session) {
  session.obstacles = session.track.obstacles.map((obstacle, index) => _buildObstacle(session, obstacle, index));
}

function _buildParticlePool(session) {
  const geometry = new THREE.IcosahedronGeometry(0.34, 0);
  session.owned.geometries.add(geometry);
  const alphaAttribute = new THREE.InstancedBufferAttribute(new Float32Array(TRIALS_PARTICLE_CAPACITY), 1);
  alphaAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('instanceAlpha', alphaAttribute);
  const material = createTrialsParticleMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  session.owned.materials.add(material);

  const mesh = new THREE.InstancedMesh(geometry, material, TRIALS_PARTICLE_CAPACITY);
  mesh.name = 'kaki-trials-instanced-particle-pool';
  mesh.userData.raceOwned = true;
  mesh.userData.capacity = TRIALS_PARTICLE_CAPACITY;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(TRIALS_PARTICLE_CAPACITY * 3),
    3,
  );
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  session.root.add(mesh);
  session.particleMesh = mesh;
  session.particleAlpha = alphaAttribute;
  session.particles = Array.from({ length: TRIALS_PARTICLE_CAPACITY }, () => ({
    life: 0,
    maxLife: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    grow: 0,
    spin: 0,
    alpha: 0.58,
    scale: 0,
    x: 0,
    y: 0,
    z: 0,
    rotation: 0,
    color: new THREE.Color(session.track.colors.dirt),
  }));
}

function _spawnTrialsPuffs(session, count = 4, strength = 0.5, tone = 'dust') {
  const p = session.physics;
  const ground = sampleTrialsGround(session.track, p.x);
  const baseY = ground?.height ?? Math.max(session.terrainBaseline + 3.2, p.y - session.vehicle.rideHeight);
  const direction = Math.sign(p.vx || 1);
  for (let i = 0; i < count; i++) {
    const particle = session.particles[session.particleCursor++ % session.particles.length];
    const spark = tone === 'spark';
    const turbo = tone === 'turbo';
    particle.life = particle.maxLife = spark ? 0.25 + Math.random() * 0.22 : 0.42 + Math.random() * 0.5;
    particle.vx = -direction * (1.2 + Math.random() * 3.4) + p.vx * (spark ? 0.08 : -0.035);
    particle.vy = (spark ? 2.3 : 0.7) + Math.random() * (spark ? 4.8 : 2.3) * strength;
    particle.vz = (Math.random() - 0.5) * (spark ? 8 : 4.5);
    particle.gravity = spark ? 12 : 2.4;
    particle.grow = spark ? -0.75 : 1.45;
    particle.spin = (Math.random() - 0.5) * (spark ? 13 : 5);
    particle.color.setHex(spark ? (i % 2 ? 0xffd36e : 0xfff6c9) : turbo ? session.track.colors.accent : session.track.colors.dirt);
    particle.alpha = spark ? (state._optReducedFlashing ? 0.4 : 1) : turbo ? 0.72 : 0.58;
    particle.scale = (spark ? 0.12 : 0.25) + Math.random() * (spark ? 0.12 : 0.32) * strength;
    particle.x = p.x - direction * (session.vehicle.id === 'monster' ? 1.8 : 1.25) + (Math.random() - 0.5) * 0.7;
    particle.y = baseY + 0.2 + Math.random() * 0.34;
    particle.z = (Math.random() - 0.5) * 2.4;
    particle.rotation = 0;
  }
}

function _tickTrialsParticles(session, dt) {
  const mesh = session.particleMesh;
  const alphaAttribute = session.particleAlpha;
  if (!mesh || !alphaAttribute) return;
  const damping = Math.exp(-1.35 * dt);
  let visibleCount = 0;
  for (const particle of session.particles) {
    if (particle.life <= 0) continue;
    particle.life -= dt;
    if (particle.life <= 0) continue;
    particle.vy -= particle.gravity * dt;
    particle.vx *= damping;
    particle.vz *= damping;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.z += particle.vz * dt;
    particle.rotation += particle.spin * dt;
    particle.scale *= Math.max(0.84, 1 + particle.grow * dt);
    const fade = clamp(particle.life / Math.max(0.01, particle.maxLife), 0, 1);
    _particleObject.position.set(particle.x, particle.y, particle.z);
    _particleObject.rotation.set(0, 0, particle.rotation);
    _particleObject.scale.setScalar(particle.scale);
    _particleObject.updateMatrix();
    mesh.setMatrixAt(visibleCount, _particleObject.matrix);
    mesh.setColorAt(visibleCount, particle.color);
    alphaAttribute.setX(visibleCount, fade * fade * particle.alpha);
    visibleCount += 1;
  }
  mesh.count = visibleCount;
  if (visibleCount > 0) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    alphaAttribute.needsUpdate = true;
  }
}

function _buildBuggy({ color, driver, owned, decalTexture = null, decalTile = 0 }) {
  return buildTrialsBuggy({ color, driver, owned, isPlayer: true, decalTexture, decalTile });
}

function _buildPlayerVehicle(session, hero) {
  const avatar = AVATARS.find((entry) => entry.id === session.playerAvatarId) || AVATARS[0];
  const color = avatar?.tint && avatar.tint !== 0xffffff
    ? avatar.tint
    : session.track.colors.accent;
  const visual = session.vehicle.id === 'monster'
    ? buildMonsterTruck({
        color,
        driver: hero,
        owned: session.owned,
        decalTexture: session.assetLease?.textures?.monsterDecal || null,
      })
    : _buildBuggy({
        color,
        driver: hero,
        owned: session.owned,
        decalTexture: session.assetLease?.textures?.decalAtlas || null,
        decalTile: ({ meadow: 8, quarry: 9, crown: 10 })[session.track.id] || 8,
      });
  const motion = new THREE.Group();
  motion.name = `kaki-trials-${session.vehicle.id}`;
  visual.root.rotation.y = Math.PI / 2;
  visual.root.position.y = -session.vehicle.rideHeight;
  if (visual.shadow) visual.shadow.visible = false;
  motion.add(visual.root);
  session.root.add(motion);
  const shadow = _ownedMesh(
    new THREE.CircleGeometry(session.vehicle.id === 'monster' ? 2.7 : 1.8, 26),
    _material(session.owned, { color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }, true),
    session.owned,
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.55, 0.62, 1);
  session.root.add(shadow);
  return { ...visual, motion, shadow, bodyBaseY: visual.bodyPivot.position.y };
}

function _buildGhost(session) {
  const motion = new THREE.Group();
  const visual = buildGhostVehicle({ owned: session.owned, color: 0x9ef5ff, opacity: 0.22 });
  visual.root.rotation.y = Math.PI / 2;
  visual.root.position.y = -1.02;
  motion.add(visual.root);
  motion.renderOrder = 2;
  motion.visible = session.pbGhost.length > 1;
  session.root.add(motion);
  return { ...visual, motion, shell: visual.bodyPivot, cursor: 0, lastX: 0 };
}

function _bindHeld(button, key) {
  if (!button) return;
  const release = () => {
    _touch[key] = false;
    button.classList.remove('is-held');
  };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    _touch[key] = true;
    button.classList.add('is-held');
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

function _mountHud(session) {
  if (typeof document === 'undefined') return;
  const root = document.createElement('div');
  root.className = 'kkr-hud kkt-hud';
  root.dataset.mode = 'trials';
  root.style.setProperty('--kkt-accent', _hex(session.track.colors.accent));
  root.innerHTML = `
    <div class="kkt-topbar">
      <div class="kkt-track"><span> KAKI TRIALS · ${session.track.difficultyLabel}</span><strong>${session.track.name}</strong><em>${session.vehicle.name}</em></div>
      <button class="kkr-menu" type="button" data-action="menu">MENU</button>
    </div>
    <div class="kkt-clock"><span>RAW TIME</span><strong>0:00.000</strong><em>EFFECTIVE 0:00.000 · PACE —</em></div>
    <div class="kkt-progress"><span>CHECKPOINT</span><strong>0 / ${session.track.checkpoints.length}</strong><div><i></i></div></div>
    <div class="kkt-speed"><strong>0</strong><span>KM/H</span></div>
    <div class="kkt-style"><span>STYLE</span><strong>0</strong><em>1.0× COMBO</em></div>
    <div class="kkt-heat"><span>TURBO HEAT</span><div><i></i></div><strong>COOL</strong></div>
    <div class="kkr-callout kkt-callout"></div>
    <div class="kkt-countdown"></div>
    <div class="kkt-controls">W THROTTLE · S BRAKE · A NOSE UP · D NOSE DOWN · SHIFT TURBO · SPACE CHECKPOINT · CAMERA ON-SCREEN</div>
    <div class="kkr-camera-control">
      <button class="kkr-camera-cycle" type="button" aria-label="Camera: Isometric. Activate to cycle; hold for camera list."><span>CAMERA</span><strong>ISOMETRIC</strong></button>
      <div class="kkr-camera-list" role="menu" aria-label="Trials camera" hidden>
        <button type="button" role="menuitem" data-camera-mode="isometric">SIDE / ISO</button>
        <button type="button" role="menuitem" data-camera-mode="chase">CHASE</button>
        <button type="button" role="menuitem" data-camera-mode="driver_fpv">DRIVER FPV</button>
      </div>
    </div>
    <div class="kkt-touch" aria-label="Trials touch controls">
      <div class="kkt-touch-drive"><button type="button" data-touch="brake">BRAKE</button><button type="button" data-touch="throttle">THROTTLE</button></div>
      <div class="kkt-touch-lean"><button type="button" data-touch="noseUp">NOSE ↑</button><button type="button" data-touch="noseDown">NOSE ↓</button></div>
      <button type="button" data-touch="turbo">TURBO</button>
      <button type="button" data-touch="restart">↺ CHECKPOINT</button>
    </div>
    <div class="kkr-finish kkt-finish" hidden>
      <div class="kkt-finish-card">
        <span class="kkt-finish-kicker">TRIAL COMPLETE</span>
        <h2>PAWSOME RUN!</h2>
        <strong class="kkt-medal">—</strong>
        <p class="kkt-result-time"></p>
        <p class="kkt-result-style"></p>
        <div><button type="button" data-action="retry">RETRY</button><button type="button" data-action="next">NEXT</button><button type="button" data-action="menu">MENU</button></div>
      </div>
    </div>`;
  (document.querySelector('#ui-root') || document.body).appendChild(root);
  _bindHeld(root.querySelector('[data-touch="throttle"]'), 'throttle');
  _bindHeld(root.querySelector('[data-touch="brake"]'), 'brake');
  _bindHeld(root.querySelector('[data-touch="noseUp"]'), 'noseUp');
  _bindHeld(root.querySelector('[data-touch="noseDown"]'), 'noseDown');
  _bindHeld(root.querySelector('[data-touch="turbo"]'), 'turbo');
  root.querySelector('[data-touch="restart"]')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    _touch.restart = true;
  });
  root.querySelectorAll('[data-action="menu"]').forEach((button) => button.addEventListener('click', () => window.kkReturnToMenu?.()));
  root.querySelector('[data-action="retry"]')?.addEventListener('click', () => restartTrialsMode(session.scene, {
    trackId: session.track.id,
    vehicle: session.vehicle.id,
    playerAvatarId: session.playerAvatarId,
    cameraHost: session.cameraHost,
  }));
  root.querySelector('[data-action="next"]')?.addEventListener('click', () => {
    const current = TRIALS_TRACK_ORDER.indexOf(session.track.id);
    const nextId = TRIALS_TRACK_ORDER[Math.min(TRIALS_TRACK_ORDER.length - 1, current + 1)] || 'meadow';
    restartTrialsMode(session.scene, { trackId: nextId, vehicle: session.vehicle.id, playerAvatarId: session.playerAvatarId, cameraHost: session.cameraHost });
  });
  session.hud = {
    root,
    clock: root.querySelector('.kkt-clock strong'),
    effective: root.querySelector('.kkt-clock em'),
    checkpoint: root.querySelector('.kkt-progress strong'),
    progress: root.querySelector('.kkt-progress i'),
    speed: root.querySelector('.kkt-speed strong'),
    style: root.querySelector('.kkt-style strong'),
    combo: root.querySelector('.kkt-style em'),
    heat: root.querySelector('.kkt-heat'),
    heatFill: root.querySelector('.kkt-heat i'),
    heatLabel: root.querySelector('.kkt-heat strong'),
    callout: root.querySelector('.kkt-callout'),
    countdown: root.querySelector('.kkt-countdown'),
    finish: root.querySelector('.kkt-finish'),
    medal: root.querySelector('.kkt-medal'),
    resultTime: root.querySelector('.kkt-result-time'),
    resultStyle: root.querySelector('.kkt-result-style'),
    next: root.querySelector('[data-action="next"]'),
  };
}

function _callout(session, text, duration = 1.25, tone = '') {
  session.callout = text;
  session.calloutTime = Math.max(session.calloutTime || 0, duration);
  session.calloutTone = tone;
}

function _kickCamera(session, shake = 0.3, punch = 0.3, roll = 0) {
  if (state._optReduceMotion) return;
  // Preserve readable landing/collision feedback without shaking on every
  // small wheel contact or trick.
  if (shake < 0.48) return;
  const fx = session.cameraFx;
  fx.shake = Math.max(fx.shake, clamp(shake, 0, 1.5));
  fx.punch = Math.max(fx.punch, clamp(punch, 0, 1.3));
  fx.roll += clamp(roll, -0.07, 0.07);
}

function _tickCameraFx(session, dt) {
  const fx = session.cameraFx;
  fx.phase += dt * (22 + fx.shake * 22);
  fx.shake *= Math.exp(-8 * dt);
  fx.punch *= Math.exp(-6.5 * dt);
  fx.roll *= Math.exp(-7 * dt);
  session.calloutTime = Math.max(0, (session.calloutTime || 0) - dt);
  if (session.calloutTime <= 0) session.callout = '';
}

function _readControls(session) {
  const move = state.input?.moveVec || { x: 0, y: 0 };
  const vertical = clamp(Number(move.y) || 0, -1, 1);
  const horizontal = clamp(Number(move.x) || 0, -1, 1);
  const wantsForward = _touch.throttle ? 1 : Math.max(0, -vertical);
  const wantsBrake = _touch.brake ? 1 : Math.max(0, vertical);
  const movingForward = session.physics.vx > 0.55;
  const throttle = wantsForward > 0 ? wantsForward : (wantsBrake > 0 && !movingForward ? -wantsBrake : 0);
  const brake = wantsBrake > 0 && movingForward ? wantsBrake : 0;
  const touchLean = (_touch.noseUp ? 1 : 0) - (_touch.noseDown ? 1 : 0);
  return {
    throttle: session.phase === 'racing' ? clamp(throttle, -1, 1) : 0,
    brake: session.phase === 'racing' ? clamp(brake, 0, 1) : 0,
    lean: session.phase === 'racing' ? clamp(touchLean || -horizontal, -1, 1) : 0,
    turbo: session.phase === 'racing' && (_touch.turbo || isDashPressed()),
  };
}

function _updateVehicleVisual(session, dt) {
  const p = session.physics;
  const visual = session.visual;
  visual.motion.position.set(p.x, p.y, 0);
  visual.motion.rotation.z = p.pitch;
  const bounce = Math.sin(session.visualClock * 15) * Math.min(0.08, Math.abs(p.vx) * 0.0025);
  visual.bodyPivot.position.y = visual.bodyBaseY - p.suspensionCompression * (visual.monster ? 0.42 : 0.3) + bounce;
  const direction = Math.sign(p.vx || 1);
  for (const wheel of visual.wheels) wheel.rotation.x += direction * Math.abs(p.vx) * dt / Math.max(0.2, visual.wheelRadius || 0.6);
  for (let i = 0; i < visual.flames.length; i++) {
    const flame = visual.flames[i];
    flame.visible = p.turboActive;
    if (flame.visible) flame.scale.y = 0.75 + ((Math.sin(session.visualClock * 36 + i * 2.4) + 1) * 0.34);
  }
  const ground = sampleTrialsGround(session.track, p.x);
  const groundY = ground?.height ?? session.terrainBaseline;
  const air = Math.max(0, p.y - session.vehicle.rideHeight - groundY);
  visual.shadow.position.set(p.x, groundY + 0.04, 0);
  visual.shadow.scale.set(1.55 + air * 0.035, 0.62 + air * 0.014, 1);
  visual.shadow.material.opacity = clamp(0.26 - air * 0.012, 0.05, 0.26);
  state.hero.pos.set(TRIALS_CX + p.x, p.y, TRIALS_CZ);
  state.hero.vel.set(p.vx, p.vy, 0);
}

function _recordGhostSample(session, force = false) {
  if (session.phase !== 'racing' || (!force && session.physics.finished)) return;
  const time = session.physics.elapsedTime;
  if (!force && time + 1e-6 < session.nextGhostSample) return;
  if (session.ghostSamples.length >= MAX_GHOST_SAMPLES) return;
  session.nextGhostSample = time + 1 / GHOST_HZ;
  session.ghostSamples.push({
    t: Number(time.toFixed(1)),
    x: Number(session.physics.x.toFixed(2)),
    y: Number(session.physics.y.toFixed(2)),
    p: Number(session.physics.pitch.toFixed(3)),
  });
}

function _updateGhost(session, dt) {
  const ghost = session.ghost;
  const samples = session.pbGhost;
  if (!ghost || samples.length < 2 || session.phase === 'countdown') {
    if (ghost) ghost.motion.visible = false;
    return;
  }
  ghost.motion.visible = true;
  const time = session.physics.elapsedTime;
  while (ghost.cursor + 1 < samples.length && samples[ghost.cursor + 1].t <= time) ghost.cursor += 1;
  while (ghost.cursor > 0 && samples[ghost.cursor].t > time) ghost.cursor -= 1;
  const a = samples[ghost.cursor];
  const b = samples[Math.min(samples.length - 1, ghost.cursor + 1)];
  const alpha = b.t > a.t ? clamp((time - a.t) / (b.t - a.t), 0, 1) : 0;
  const x = THREE.MathUtils.lerp(a.x, b.x, alpha);
  ghost.motion.position.set(x, THREE.MathUtils.lerp(a.y, b.y, alpha), -0.45);
  ghost.motion.rotation.z = THREE.MathUtils.lerp(a.p, b.p, alpha);
  const velocity = dt > 0 ? (x - ghost.lastX) / dt : 0;
  for (const wheel of ghost.wheels) wheel.rotation.x += velocity * dt * 1.8;
  ghost.lastX = x;
}

function _animateObstacles(session, dt) {
  for (const obstacle of session.obstacles) {
    if (obstacle.destroyed) {
      obstacle.debrisAge += dt;
      for (const piece of obstacle.group.children) {
        const velocity = piece.userData.debrisVelocity;
        if (!velocity) continue;
        velocity.y -= 13 * dt;
        piece.position.addScaledVector(velocity, dt);
        piece.rotation.x += piece.userData.spinX * dt;
        piece.rotation.y += piece.userData.spinY * dt;
        piece.rotation.z += piece.userData.spinZ * dt;
        piece.scale.multiplyScalar(Math.exp(-0.45 * dt));
      }
      if (obstacle.debrisAge > 2.4) obstacle.group.visible = false;
    } else if (obstacle.hitTime > 0) {
      obstacle.hitTime = Math.max(0, obstacle.hitTime - dt);
      const amount = obstacle.hitTime / 0.45;
      obstacle.group.rotation.z = Math.sin(amount * Math.PI * 5) * amount * 0.13;
      obstacle.group.position.y = obstacle.groundY + Math.sin(amount * Math.PI) * 0.28;
      if (obstacle.hitTime <= 0) {
        obstacle.group.rotation.z = 0;
        obstacle.group.position.y = obstacle.groundY;
      }
    }
  }
}

function _burstObstacle(obstacle, impactSpeed) {
  obstacle.destroyed = true;
  obstacle.debrisAge = 0;
  for (let i = 0; i < obstacle.group.children.length; i++) {
    const piece = obstacle.group.children[i];
    const seed = piece.userData.debrisSeed || i;
    const side = ((seed * 37) % 11) / 5 - 1;
    piece.userData.debrisVelocity = new THREE.Vector3(
      impactSpeed * (0.24 + ((seed * 17) % 7) * 0.035),
      3.5 + ((seed * 29) % 8) * 0.62,
      side * (2.2 + (seed % 4)),
    );
    piece.userData.spinX = side * 4.2;
    piece.userData.spinY = 2.4 + (seed % 5);
    piece.userData.spinZ = side * 5.8;
  }
}

function _resolveObstacleCollision(session, previousX) {
  if (session.obstacleCooldown > 0 || session.physics.crashed || session.physics.finished) return null;
  const p = session.physics;
  const radius = session.vehicle.id === 'monster' ? 2.45 : 1.72;
  const lowX = Math.min(previousX, p.x) - radius;
  const highX = Math.max(previousX, p.x) + radius;
  const vehicleBottom = p.y - session.vehicle.rideHeight * 0.88;
  const vehicleTop = p.y + session.vehicle.rideHeight * 0.82;
  for (const obstacle of session.obstacles) {
    if (obstacle.destroyed) continue;
    const half = obstacle.data.width * 0.5;
    if (highX < obstacle.data.x - half || lowX > obstacle.data.x + half) continue;
    if (vehicleTop < obstacle.groundY || vehicleBottom > obstacle.groundY + obstacle.data.height + 0.6) continue;
    const impactSpeed = Math.abs(p.vx) + Math.max(0, -p.vy) * 0.25;
    const result = awardTrialsDestruction(session.score, p, obstacle.data, impactSpeed, session.vehicle);
    session.obstacleCooldown = 0.38;
    if (result.destroyed) {
      _burstObstacle(obstacle, impactSpeed);
      _spawnTrialsPuffs(session, 8 + Math.round(clamp(impactSpeed / 5, 1, 5)), clamp(impactSpeed / 18, 0.6, 1.5), 'spark');
      _spawnTrialsPuffs(session, 7, clamp(impactSpeed / 20, 0.55, 1.35), 'dust');
      p.vx *= session.vehicle.id === 'monster' ? 0.95 : 0.82;
      p.vy = Math.max(p.vy, session.vehicle.id === 'monster' ? 1.25 : 0.75);
      p.suspensionVelocity += clamp(impactSpeed * 0.12, 0.8, 3.2);
      session.hitStop = Math.max(session.hitStop, session.vehicle.id === 'monster' ? 0.055 : 0.038);
      _callout(session, `${result.label || 'SMASH!'} +${result.points}`, 1.45, 'smash');
      _kickCamera(session, clamp(impactSpeed / 18, 0.45, 1.15), 0.72, (obstacle.data.x % 2 ? 1 : -1) * 0.025);
      playRacingImpact({ strength: clamp(impactSpeed / 22, 0.35, 1), kind: 'smash' });
      _safeSfx('explosion');
      return { ...result, impactSpeed };
    }

    obstacle.hitTime = 0.45;
    _spawnTrialsPuffs(session, 5, clamp(impactSpeed / 15, 0.45, 1.1), 'spark');
    const direction = Math.sign(p.vx || 1);
    p.x = obstacle.data.x - direction * (half + radius + 0.04);
    p.vx *= session.vehicle.id === 'monster' ? -0.12 : -0.28;
    p.vy = Math.max(p.vy, session.vehicle.id === 'monster' ? 1.1 : 2.2);
    p.pitchVelocity -= direction * (session.vehicle.id === 'monster' ? 0.8 : 1.75);
    p.sectionFaults += 1;
    session.score.combo = 1;
    session.score.comboTime = 0;
    session.score.lastEvent = 'BONK!';
    session.score.lastPoints = 0;
    const hardBuggyCrash = session.vehicle.id === 'buggy' && impactSpeed > 10.5;
    if (hardBuggyCrash) {
      p.crashed = true;
      p.crashState = 'tumbled';
      p.crashReason = 'obstacle';
      p.crashTime = 0;
      p.crashes += 1;
      p.grounded = false;
      stepTrialsScore(session.score, p, { crash: true, crashed: true, crashReason: 'obstacle' }, 0);
      session.crashDelay = 1.2;
      _callout(session, 'BUGGY BONK! CHECKPOINT REWIND', 1.5, 'crash');
    } else {
      _callout(session, `BONK! NEED ${result.requiredImpact.toFixed(1)} CRUSH`, 1.2, 'crash');
    }
    _kickCamera(session, clamp(impactSpeed / 14, 0.32, 0.95), 0.3, direction * -0.03);
    playRacingImpact({ strength: clamp(impactSpeed / 18, 0.3, 1), kind: 'crash' });
    _safeSfx('hit');
    return { ...result, impactSpeed, crash: hardBuggyCrash };
  }
  return null;
}

function _medalForPace(track, time) {
  if (time <= track.medals.S) return 'S';
  if (time <= track.medals.A) return 'A';
  if (time <= track.medals.B) return 'B';
  return 'C';
}

function _finishRun(session) {
  if (session.result) return session.result;
  _recordGhostSample(session, true);
  session.result = createTrialsResult(session.track, session.score);
  const progress = session.progress;
  const previous = progress.records[session.track.id];
  const oldBest = Number(previous?.effectiveTime ?? previous?.time);
  session.newBest = !Number.isFinite(oldBest) || session.result.effectiveTime < oldBest - 0.0005;
  if (session.newBest) {
    progress.records[session.track.id] = {
      rawTime: Number(session.result.rawTime.toFixed(3)),
      effectiveTime: Number(session.result.effectiveTime.toFixed(3)),
      styleScore: session.result.styleScore,
      medal: session.result.medal,
      vehicle: session.vehicle.id,
      ghost: session.ghostSamples.slice(0, MAX_GHOST_SAMPLES),
    };
  }
  if (session.result.medal) {
    const index = TRIALS_TRACK_ORDER.indexOf(session.track.id);
    const next = TRIALS_TRACK_ORDER[index + 1];
    if (next && !progress.unlocked.includes(next)) progress.unlocked.push(next);
  }
  _writeProgress(progress);
  session.phase = 'finished';
  session.physics.vx = 0;
  session.physics.vy = 0;
  session.physics.pitchVelocity = 0;
  session.physics.turboActive = false;
  session.hitStop = Math.max(session.hitStop, 0.085);
  const award = session.result.medal ? `${session.result.rank} MEDAL` : 'C RANK';
  _callout(session, `${award} · ${session.newBest ? 'NEW PURRSONAL BEST!' : 'TRIAL COMPLETE!'}`, 2.4, 'finish');
  _kickCamera(session, 0.42, 0.9, 0);
  _safeSfx('victory');
  return session.result;
}

function _handleEvents(session, events) {
  const p = session.physics;
  if (events.turboStart) {
    _callout(session, 'TURBO PAWS!', 0.8, 'turbo');
    _kickCamera(session, 0.1, 0.48, 0);
    _safeSfx('speedBoostActivate');
  }
  if (events.turboOverheat) {
    _callout(session, 'TURBO OVERHEAT · COOL YOUR PAWS!', 1.55, 'overheat');
    _kickCamera(session, 0.48, 0.25, 0.035);
    session.hitStop = Math.max(session.hitStop, 0.035);
    playRacingImpact({ strength: 0.42, kind: 'crash' });
    _safeSfx('uiError');
  } else if (events.turboCool) {
    _callout(session, 'TURBO READY!', 0.9, 'turbo');
    _safeSfx('pickup');
  }
  if (events.flips > 0) {
    _callout(session, events.flipCount > 1 ? `${events.flipCount}× FLIP CHAIN!` : 'FULL KITTY FLIP!', 1.2, 'style');
    _kickCamera(session, 0.24, 0.65, Math.sign(p.pitchVelocity || 1) * 0.025);
    session.hitStop = Math.max(session.hitStop, 0.035);
    _safeSfx('weaponDash');
  }
  if (events.landed) {
    const impact = clamp((events.landingSpeed || 0) / 24, 0.18, 1.15);
    _spawnTrialsPuffs(session, 7 + Math.round(impact * 7), impact, 'dust');
    if (events.landingQuality === 'rough' || events.landingQuality === 'crash') {
      _spawnTrialsPuffs(session, 4 + Math.round(impact * 4), impact, 'spark');
    }
    if (events.landingQuality === 'perfect') {
      _callout(session, `PURRFECT LANDING +${session.score.lastPoints}`, 1.35, 'perfect');
      session.hitStop = Math.max(session.hitStop, 0.055);
      _kickCamera(session, 0.38, 0.78, 0);
    } else if (events.landingQuality === 'clean') {
      _callout(session, `CLEAN PAWS +${session.score.lastPoints}`, 1.05, 'clean');
      session.hitStop = Math.max(session.hitStop, 0.024);
      _kickCamera(session, 0.22, 0.45, 0);
    } else if (events.landingQuality === 'rough') {
      _callout(session, 'ROUGH LANDING · COMBO LOST', 1.25, 'rough');
      session.hitStop = Math.max(session.hitStop, 0.038);
      _kickCamera(session, 0.68, 0.22, Math.sign(p.pitch) * 0.028);
    }
    playRacingImpact({ strength: impact, kind: 'landing' });
    _safeSfx('hit');
  }
  for (const checkpoint of events.checkpoints || []) {
    const marker = session.markers[checkpoint.index];
    if (marker) {
      marker.passed = true;
      marker.baseEmissive = 1.2;
      marker.glow.color.setHex(0x78ffc4);
      marker.glow.emissive.setHex(0x42f5a4);
      marker.glow.emissiveIntensity = 1.2;
    }
    _callout(session, checkpoint.clean ? `${checkpoint.label} · CLEAN SECTION!` : `${checkpoint.label} · CHECKPOINT`, 1.55, 'checkpoint');
    session.hitStop = Math.max(session.hitStop, 0.025);
    _kickCamera(session, 0.16, 0.52, 0);
    _safeSfx('levelUp');
  }
  if (events.crash) {
    session.crashDelay = 1.25;
    session.hitStop = Math.max(session.hitStop, 0.07);
    _callout(session, events.crashReason === 'gap' ? 'KITTY IN THE GAP! REWINDING…' : 'TUMBLE! REWINDING…', 1.55, 'crash');
    _kickCamera(session, 1.05, 0.18, Math.sign(p.pitchVelocity || 1) * 0.055);
    playRacingImpact({ strength: 1, kind: 'crash' });
    _safeSfx('heroHit');
  }
  if (events.finish) _finishRun(session);
}

function _animateWorld(session, dt) {
  updateTrialsEnvironment(session, session.visualClock, dt);
  const freezeAmbientPulse = !!state._optReduceMotion || !!state._optReducedFlashing;
  for (const marker of session.markers) {
    // Passed gates stay mint and substantially brighter in every accessibility
    // mode; only the nonessential breathing animation is suppressed.
    const pulse = marker.passed
      ? (freezeAmbientPulse ? 1 : 1.15)
      : freezeAmbientPulse ? 0.72 : 0.72 + Math.sin(session.visualClock * 3.4 + marker.index) * 0.18;
    marker.glow.emissiveIntensity = marker.baseEmissive * pulse;
  }
  if (session.finishMarker) {
    session.finishMarker.glow.emissiveIntensity = freezeAmbientPulse
      ? session.finishMarker.baseEmissive
      : 1 + Math.sin(session.visualClock * 5) * 0.3;
  }
  _animateObstacles(session, dt);
}

function _restartCheckpoint(session, reason = 'manual') {
  if (!session?.physics || session.physics.finished) return false;
  // A rewind is forgiving, but it is not a clean-section strategy. Carry one
  // fault into the restarted section so its bonus still rewards uninterrupted
  // balance and momentum.
  session.physics.sectionFaults = Math.max(1, session.physics.sectionFaults || 0);
  resetTrialsState(session.physics, {
    track: session.track,
    profile: session.vehicle,
    checkpointIndex: session.physics.checkpointIndex,
    preserveRun: true,
  });
  session.score.combo = 1;
  session.score.comboTime = 0;
  session.score.rawTime = session.physics.elapsedTime;
  session.crashDelay = 0;
  session.obstacleCooldown = 0.45;
  session.hitStop = 0;
  _recordGhostSample(session, true);
  _callout(
    session,
    reason === 'auto' ? 'BACK ON YOUR PAWS!' : 'CHECKPOINT RESTART · CLOCK KEPT',
    1.25,
    'checkpoint',
  );
  _kickCamera(session, 0.16, 0.32, 0);
  session.cameraManager?.onVehicleRespawned();
  _safeSfx('uiClick');
  return true;
}

function _updateHud(session) {
  const hud = session.hud;
  if (!hud) return;
  const p = session.physics;
  const preview = session.result || createTrialsResult(session.track, {
    rawTime: p.elapsedTime,
    styleScore: session.score.styleScore,
  });
  const courseProgress = clamp((p.maxX - session.track.spawn.x) / Math.max(1, session.track.finish - session.track.spawn.x), 0, 1);
  const projected = courseProgress > 0.035 ? preview.effectiveTime / courseProgress : Infinity;
  const pace = Number.isFinite(projected) ? _medalForPace(session.track, projected) : '—';
  hud.clock.textContent = _formatTime(p.elapsedTime);
  hud.effective.textContent = `EFFECTIVE ${_formatTime(preview.effectiveTime)} · PACE ${pace}`;
  hud.checkpoint.textContent = `${Math.max(0, p.checkpointIndex + 1)} / ${session.track.checkpoints.length}`;
  hud.progress.style.transform = `scaleX(${courseProgress})`;
  hud.speed.textContent = String(Math.round(Math.abs(p.vx) * 5));
  hud.style.textContent = Math.round(session.score.styleScore).toLocaleString();
  hud.combo.textContent = `${session.score.combo.toFixed(1)}× COMBO${session.pbGhost.length ? ' · PB GHOST' : ''}`;
  hud.heatFill.style.transform = `scaleX(${clamp(p.turboHeat, 0, 1)})`;
  hud.heat.classList.toggle('is-overheated', p.turboOverheated);
  hud.heat.classList.toggle('is-active', p.turboActive);
  hud.heatLabel.textContent = p.turboOverheated ? 'OVERHEATED' : p.turboActive ? 'BURNING' : 'COOL';
  hud.callout.textContent = session.calloutTime > 0 ? session.callout : '';
  hud.callout.dataset.tone = session.calloutTone || '';
  if (session.phase === 'countdown') {
    hud.countdown.textContent = String(Math.max(1, Math.ceil(session.countdown)));
  } else {
    hud.countdown.textContent = session.goTime > 0 ? 'GO!' : '';
  }
  if (session.result) {
    hud.finish.hidden = false;
    hud.medal.textContent = session.result.medal ? `${session.result.rank} MEDAL` : 'C RANK · NO MEDAL';
    hud.resultTime.textContent = `RAW ${_formatTime(session.result.rawTime)} · STYLE CREDIT −${session.result.styleTimeBonus.toFixed(2)}s · EFFECTIVE ${_formatTime(session.result.effectiveTime)}`;
    hud.resultStyle.textContent = `${session.result.styleScore.toLocaleString()} STYLE · ${session.score.flips} FLIPS · ${session.score.destruction}/${session.obstacles.length} CRUSHED${session.newBest ? ' · NEW PB!' : ''}`;
    const index = TRIALS_TRACK_ORDER.indexOf(session.track.id);
    const nextId = TRIALS_TRACK_ORDER[index + 1];
    if (hud.next) {
      hud.next.hidden = !nextId;
      hud.next.disabled = !!nextId && !session.progress.unlocked.includes(nextId);
      hud.next.textContent = nextId ? `NEXT · ${TRIALS_TRACKS[nextId].difficultyLabel}` : 'ALL CROWNED';
    }
  } else {
    hud.finish.hidden = true;
  }
  const renderInfo = getRendererDiagnostics(state);
  hud.root.dataset.raceMode = 'trials';
  hud.root.dataset.track = session.track.id;
  hud.root.dataset.vehicle = session.vehicle.id;
  hud.root.dataset.triangles = String(renderInfo.triangles || 0);
  hud.root.dataset.drawCalls = String(renderInfo.drawCalls || 0);
  hud.root.dataset.fps = String(Math.round(1 / Math.max(1 / 240, session.frameTimeEma || 1 / 60)));
  hud.root.dataset.assetCount = String(getRallyAssetCacheSnapshot().length);
  hud.root.dataset.assetError = session.assetError || '';
}

function _updateCameraTarget(session) {
  const p = session.physics;
  _cameraTarget.set(
    TRIALS_CX + p.x,
    p.y - session.vehicle.rideHeight * 0.38,
    TRIALS_CZ,
  );
}

function _placeForQa(session, x, speed = 18) {
  const ground = sampleTrialsGround(session.track, x);
  if (!ground) return false;
  const p = session.physics;
  p.x = x;
  p.y = ground.height + session.vehicle.rideHeight;
  p.vx = speed * Math.cos(ground.angle);
  p.vy = speed * Math.sin(ground.angle);
  p.pitch = ground.angle;
  p.pitchVelocity = 0;
  p.grounded = true;
  p.crashed = false;
  p.crashState = 'none';
  p.crashReason = null;
  p.maxX = Math.max(p.maxX, x);
  session.phase = 'racing';
  session.countdown = 0;
  return true;
}

function _installQaHooks(session) {
  if (typeof window === 'undefined') return;
  const hooks = {
    snapshot: () => getTrialsSnapshot(),
    setCameraMode: (mode) => session.cameraManager?.setCameraMode(mode, { instant: true }) || false,
    cycleCamera: (direction = 1) => session.cameraManager?.cycleCamera(direction) || false,
    skipCountdown: () => {
      if (state.racing !== session) return false;
      session.countdown = 0;
      session.phase = 'racing';
      session.goTime = 0.55;
      return true;
    },
    warpCheckpoint: (index = 0) => {
      const targetIndex = clamp(Math.trunc(index), 0, session.track.checkpoints.length - 1);
      const checkpoint = session.track.checkpoints[targetIndex];
      if (!checkpoint || !_placeForQa(session, checkpoint.x - 2.5, 19)) return false;
      session.physics.checkpointIndex = targetIndex - 1;
      session.physics.checkpointId = targetIndex > 0 ? session.track.checkpoints[targetIndex - 1].id : 'spawn';
      return true;
    },
    warpFinish: () => {
      if (!_placeForQa(session, session.track.finish - 2.5, 22)) return false;
      session.physics.checkpointIndex = session.track.checkpoints.length - 1;
      session.physics.checkpointId = session.track.checkpoints.at(-1)?.id || 'spawn';
      return true;
    },
    warpObstacle: (index = 0, speed = 18) => {
      const obstacle = session.obstacles[clamp(Math.trunc(index), 0, session.obstacles.length - 1)];
      return obstacle ? _placeForQa(session, obstacle.data.x - obstacle.data.width - 3, Number(speed) || 18) : false;
    },
    restartCheckpoint: () => _restartCheckpoint(session, 'manual'),
  };
  hooks._trialsSession = session;
  window.__kkRacing = hooks;
  _mountTrialsQaBridge(session, hooks);
}

function _mountTrialsQaBridge(session, hooks) {
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  if (!new URLSearchParams(location.search).has('qa') || !session?.hud?.root) return;
  const actions = {
    'skip-countdown': () => hooks.skipCountdown(),
    checkpoint: () => {
      const moved = hooks.warpCheckpoint(0);
      if (moved) {
        session.physics.vx = 0;
        session.physics.vy = 0;
      }
      return moved;
    },
    obstacle: () => {
      const moved = hooks.warpObstacle(0, 0.01);
      if (moved) {
        session.physics.vx = 0;
        session.physics.vy = 0;
      }
      return moved;
    },
    finish: () => hooks.warpFinish(),
  };
  const bridge = document.createElement('div');
  bridge.dataset.racingQaBridge = 'true';
  bridge.setAttribute('aria-label', 'Trials QA controls');
  Object.assign(bridge.style, {
    position: 'fixed', left: '1px', bottom: '1px', zIndex: '2147483647',
    display: 'flex', width: `${Object.keys(actions).length * 5}px`, height: '5px', opacity: '0.01', overflow: 'hidden',
  });
  for (const [name, action] of Object.entries(actions)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.qaAction = name;
    button.setAttribute('aria-label', `QA ${name}`);
    button.style.cssText = 'width:5px;height:5px;min-width:5px;padding:0;border:0;';
    button.addEventListener('click', () => action());
    bridge.append(button);
  }
  session.hud.root.append(bridge);
  session.qaBridge = bridge;
}

export function enterTrialsMode(scene, options = {}) {
  if (!scene || !state.hero?.mesh) throw new Error('Kaki Trials needs a scene and loaded hero');
  if (state.racing) {
    if (state.racing.raceMode === 'trials') exitTrialsMode(scene, state.racing);
    else throw new Error('Exit the active Kaki Rally session before entering Trials');
  }
  const track = getTrialsTrack(options.trackId || options.trialsTrackId || 'meadow');
  const vehicle = getTrialsProfile(options.vehicle || options.trialsVehicle || 'monster');
  const hero = state.hero.mesh;
  const owned = { geometries: new Set(), materials: new Set(), textures: new Set() };
  const root = new THREE.Group();
  root.name = `kaki-trials-${track.id}-${vehicle.id}`;
  root.position.set(TRIALS_CX, 0, TRIALS_CZ);
  scene.add(root);
  const session = {
    scene,
    root,
    owned,
    assetLease: null,
    assetError: '',
    trialsEnvironment: null,
    track,
    trackId: track.id,
    vehicle,
    vehicleId: vehicle.id,
    raceMode: 'trials',
    playerAvatarId: options.playerAvatarId || 'kitty',
    savedHero: {
      parent: hero.parent,
      position: hero.position.clone(),
      quaternion: hero.quaternion.clone(),
      scale: hero.scale.clone(),
      visible: hero.visible,
      shadowStates: [],
    },
    savedBackground: scene.background,
    savedFog: scene.fog,
    savedEnvVisible: state.envGroup ? state.envGroup.visible : true,
    physics: createTrialsState(track, vehicle),
    score: createTrialsScoreState(),
    progress: _readProgress(),
    pbGhost: [],
    ghostSamples: [],
    nextGhostSample: 0,
    ghost: null,
    visual: null,
    obstacles: [],
    particles: [],
    particleMesh: null,
    particleAlpha: null,
    particleCursor: 0,
    dustClock: 0,
    markers: [],
    clouds: [],
    hud: null,
    phase: 'countdown',
    countdown: COUNTDOWN_SECONDS,
    goTime: 0,
    hitStop: 0,
    crashDelay: 0,
    obstacleCooldown: 0,
    visualClock: 0,
    frameTimeEma: 1 / 60,
    callout: '',
    calloutTime: 0,
    calloutTone: '',
    cameraFx: { shake: 0, punch: 0, roll: 0, phase: 0 },
    result: null,
    newBest: false,
  };
  hero.traverse?.((object) => {
    if (object.isMesh) session.savedHero.shadowStates.push({ object, castShadow: object.castShadow });
  });
  session.pbGhost = _validGhost(session.progress.records[track.id], track);
  try {
    session.assetLease = createRallyAssetLease({
      courseId: track.id,
      mode: 'trials',
      rendererService: state.rendererService,
      trials: true,
    });
    session.assetLease.ready.catch((error) => {
      session.assetError = error?.message || String(error);
    });
    if (state.envGroup) state.envGroup.visible = false;
    buildTrialsEnvironment(session);
    _buildMarkers(session);
    _buildObstacles(session);
    _buildParticlePool(session);
    hero.parent?.remove(hero);
    session.visual = _buildPlayerVehicle(session, hero);
    session.ghost = _buildGhost(session);
    _mountHud(session);

    state.racing = session;
    state.mode = 'racing';
    state.gameOver = false;
    state.victory = false;
    attachRacingCameraManager(session, options.cameraHost || {});
    _updateVehicleVisual(session, 0);
    _updateCameraTarget(session);
    _updateHud(session);
    _installQaHooks(session);
    try { consumeJump(); } catch (_) {}
    return session;
  } catch (error) {
    try { exitTrialsMode(scene, session); } catch (_) {}
    throw error;
  }
}

export function tickTrialsMode(dt) {
  const session = state.racing;
  if (!session || session.raceMode !== 'trials' || !(dt > 0)) return;
  const safeDt = Math.min(Number(dt) || 0, 1 / 20);
  session.frameTimeEma += (safeDt - session.frameTimeEma) * 0.06;
  session.visualClock += safeDt;
  session.goTime = Math.max(0, session.goTime - safeDt);
  session.obstacleCooldown = Math.max(0, session.obstacleCooldown - safeDt);
  _tickCameraFx(session, safeDt);
  _animateWorld(session, safeDt);

  const keyboardRestart = consumeJump();
  const restartPressed = _touch.restart || keyboardRestart;
  _touch.restart = false;
  if (restartPressed && session.phase === 'racing') _restartCheckpoint(session, 'manual');

  let controls = _readControls(session);
  if (session.phase === 'countdown') {
    session.countdown -= safeDt;
    if (session.countdown <= 0) {
      session.countdown = 0;
      session.phase = 'racing';
      session.goTime = 0.62;
      _callout(session, 'GO GO KAKI!', 0.8, 'start');
      _safeSfx('uiClick');
      _recordGhostSample(session, true);
    }
  } else if (session.phase === 'racing' && session.hitStop > 0) {
    session.hitStop = Math.max(0, session.hitStop - safeDt);
    controls = { throttle: 0, brake: 0, lean: 0, turbo: false };
  } else if (session.phase === 'racing') {
    const previousX = session.physics.x;
    const events = stepTrials(session.physics, controls, safeDt, session.track, session.vehicle);
    stepTrialsScore(session.score, session.physics, events, safeDt);
    _handleEvents(session, events);
    _resolveObstacleCollision(session, previousX);
    _recordGhostSample(session);
    if (session.physics.crashed && session.crashDelay > 0) {
      session.crashDelay = Math.max(0, session.crashDelay - safeDt);
      if (session.crashDelay <= 0) _restartCheckpoint(session, 'auto');
    }
  } else {
    controls = { throttle: 0, brake: 0, lean: 0, turbo: false };
  }

  if (session.phase === 'racing' && session.physics.grounded && !session.physics.crashed && Math.abs(session.physics.vx) > 4.5) {
    session.dustClock += safeDt * (session.physics.turboActive ? 2.2 : 1);
    const interval = session.vehicle.id === 'monster' ? 0.055 : 0.075;
    while (session.dustClock >= interval) {
      session.dustClock -= interval;
      _spawnTrialsPuffs(session, session.physics.turboActive ? 2 : 1, clamp(Math.abs(session.physics.vx) / 24, 0.35, 1.25), session.physics.turboActive ? 'turbo' : 'dust');
    }
  } else {
    session.dustClock = 0;
  }
  _tickTrialsParticles(session, safeDt);

  _updateVehicleVisual(session, safeDt);
  _updateGhost(session, safeDt);
  _updateCameraTarget(session);
  _updateHud(session);
  if (session.phase === 'finished') {
    if (!session.audioStopped) {
      session.audioStopped = true;
      try { stopRacingAudio(); } catch (_) {}
    }
  } else {
    try {
      updateRacingAudio({
        speed: Math.abs(session.physics.vx),
        throttle: controls.throttle,
        slip: Math.abs(session.physics.pitchVelocity) * 0.08,
        airborne: !session.physics.grounded,
        boost: session.physics.turboActive,
        turboHeat: session.physics.turboHeat,
        monster: session.vehicle.id === 'monster',
      });
    } catch (_) {}
  }
}

export function restartTrialsMode(scene, options = {}) {
  const current = state.racing?.raceMode === 'trials' ? state.racing : null;
  if (options.checkpoint && current) return _restartCheckpoint(current, 'manual');
  const nextOptions = {
    trackId: options.trackId || current?.track?.id || 'meadow',
    vehicle: options.vehicle || current?.vehicle?.id || 'monster',
    playerAvatarId: options.playerAvatarId || current?.playerAvatarId || 'kitty',
    cameraHost: options.cameraHost || current?.cameraHost || {},
  };
  const ownerScene = scene || current?.scene || state.scene;
  if (current) exitTrialsMode(ownerScene, current);
  return enterTrialsMode(ownerScene, nextOptions);
}

export function exitTrialsMode(scene, explicitSession = null) {
  const session = explicitSession || (state.racing?.raceMode === 'trials' ? state.racing : null);
  if (!session) return;
  for (const key of Object.keys(_touch)) _touch[key] = false;
  try { session.cameraManager?.dispose(); } catch (_) {}
  stopRacingAudio();
  try { session.hud?.root?.remove(); } catch (_) {}
  const hero = state.hero?.mesh;
  if (hero && session.savedHero) {
    try { hero.parent?.remove(hero); } catch (_) {}
    hero.position.copy(session.savedHero.position);
    hero.quaternion.copy(session.savedHero.quaternion);
    hero.scale.copy(session.savedHero.scale);
    hero.visible = session.savedHero.visible;
    for (const entry of session.savedHero.shadowStates || []) {
      entry.object.castShadow = entry.castShadow;
    }
    (session.savedHero.parent || scene || session.scene)?.add(hero);
  }
  try {
    session.root?.traverse?.((object) => {
      if (object.isLight && object.shadow?.map) object.shadow.map.dispose();
    });
  } catch (_) {}
  try { session.particleMesh?.dispose?.(); } catch (_) {}
  try { session.root?.parent?.remove(session.root); } catch (_) {}
  for (const texture of session.owned?.textures || []) { try { texture.dispose(); } catch (_) {} }
  for (const material of session.owned?.materials || []) { try { material.dispose(); } catch (_) {} }
  for (const geometry of session.owned?.geometries || []) { try { geometry.dispose(); } catch (_) {} }
  try { session.assetLease?.release(); } catch (_) {}
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && new URLSearchParams(location.search).has('qa')) {
    document.body.dataset.racingCacheAfterExit = String(getRallyAssetCacheSnapshot().length);
  }
  const ownerScene = scene || session.scene;
  if (ownerScene) {
    ownerScene.background = session.savedBackground;
    ownerScene.fog = session.savedFog;
  }
  if (state.envGroup) state.envGroup.visible = session.savedEnvVisible;
  if (state.racing === session) state.racing = null;
  try {
    if (window.__kkRacing?._trialsSession === session) delete window.__kkRacing;
  } catch (_) {}
}

export function getTrialsCameraTarget() {
  return _cameraTarget;
}

export function getTrialsCameraConfig() {
  const session = state.racing?.raceMode === 'trials' ? state.racing : null;
  if (!session) return { view: 'side', depth: 34, height: 8, frustum: 13, lookAhead: 3, lookAtBase: 0.5, damping: 0.16 };
  const p = session.physics;
  const ground = sampleTrialsGround(session.track, p.x);
  const groundClearance = ground ? p.y - session.vehicle.rideHeight - ground.height : 0;
  const air = p.grounded
    ? Math.max(0, groundClearance)
    : Math.max(2, groundClearance, p.airborneTime * 10, Math.abs(p.vy) * 0.22);
  const speed = clamp(Math.abs(p.vx) / session.vehicle.turboMaxSpeed, 0, 1.15);
  const fx = session.cameraFx;
  const reducedMotion = !!state._optReduceMotion;
  const shake = reducedMotion ? 0 : fx.shake * (session.vehicle.id === 'monster' ? 0.84 : 0.68);
  return {
    view: 'side',
    depth: session.vehicle.id === 'monster' ? 36 : 33,
    height: 7.6 + speed * 1.2 + clamp(air * 0.06, 0, 2.4),
    frustum: 12.4 + speed * 2 + clamp(air * 0.12, 0, 4.2) - fx.punch * 0.7,
    lookAhead: clamp(p.vx * 0.27, -3, 9.5),
    lookAtBase: 0.55,
    damping: p.grounded ? 0.17 : 0.105,
    shakeX: Math.sin(fx.phase * 1.21) * shake,
    shakeY: Math.sin(fx.phase * 1.89 + 0.8) * shake * 0.62,
    shakeZ: Math.cos(fx.phase * 1.47) * shake * 0.32,
    roll: reducedMotion ? 0 : fx.roll + clamp(p.pitchVelocity * 0.0022, -0.018, 0.018),
    chromatic: reducedMotion ? 0 : 0.00075 + (p.turboActive ? 0.00155 : 0) + fx.shake * 0.0009,
    bloom: 0.38 + (p.turboActive ? 0.2 : 0) + clamp(air / 90, 0, 0.13),
  };
}

export function getTrialsSnapshot() {
  const session = state.racing?.raceMode === 'trials' ? state.racing : null;
  if (!session) return null;
  const p = session.physics;
  const result = session.result;
  const destroyed = session.obstacles.filter((obstacle) => obstacle.destroyed).length;
  return {
    mode: 'racing',
    raceMode: 'trials',
    phase: session.phase,
    trackId: session.track.id,
    track: { id: session.track.id, name: session.track.name, difficulty: session.track.difficulty, finish: session.track.finish },
    vehicleId: session.vehicle.id,
    vehicle: { id: session.vehicle.id, name: session.vehicle.name },
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    pitch: p.pitch,
    speed: Math.abs(p.vx),
    grounded: p.grounded,
    heat: p.turboHeat,
    turboHeat: p.turboHeat,
    overheated: p.turboOverheated,
    turboOverheated: p.turboOverheated,
    turboActive: p.turboActive,
    score: session.score.score,
    styleScore: session.score.styleScore,
    combo: session.score.combo,
    checkpointIndex: p.checkpointIndex,
    checkpointId: p.checkpointId,
    checkpoint: { index: p.checkpointIndex, id: p.checkpointId, total: session.track.checkpoints.length },
    crashed: p.crashed,
    crash: { active: p.crashed, reason: p.crashReason, count: p.crashes },
    finished: p.finished,
    finish: { active: p.finished, rawTime: p.finishTime, effectiveTime: result?.effectiveTime ?? null },
    medal: result?.medal || null,
    rank: result?.rank || null,
    ghostSampleCount: session.ghostSamples.length,
    ghostSamples: session.ghostSamples.length,
    pbGhostSampleCount: session.pbGhost.length,
    obstacles: { total: session.obstacles.length, destroyed },
    obstacleTotal: session.obstacles.length,
    obstacleTotals: session.obstacles.length,
    obstacleDestroyed: destroyed,
    flips: p.totalFlips,
    landings: { perfect: p.perfectLandings, clean: p.cleanLandings, rough: p.roughLandings },
    restarts: p.restarts,
    countdown: session.countdown,
    callout: session.callout,
    camera: session.cameraManager?.getSnapshot() || null,
    assets: {
      ids: session.assetLease?.ids || [],
      error: session.assetError || '',
      cache: getRallyAssetCacheSnapshot(),
    },
    performance: {
      fps: Math.round(1 / Math.max(1 / 240, session.frameTimeEma || 1 / 60)),
      drawCalls: getRendererDiagnostics(state).drawCalls ?? null,
      triangles: getRendererDiagnostics(state).triangles ?? null,
    },
  };
}
