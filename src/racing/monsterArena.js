/** Monster Arena renderer, contact query, recovery, and arena lifecycle. */
import * as THREE from 'three';
import {
  createRacingHorizonMaterial,
  createRacingSkyGradientMaterial,
} from '../rendering/materials/racingBackdropMaterials.js';
import {
  cloneTextureForDeferredUpload,
  requestTextureUploadIfReady,
} from '../rendering/textureUpload.js';
import {
  CROWN_CHAOS_ARENA,
  findMonsterRampTakeoff,
  landingZoneAt,
  nearestMonsterRespawn,
  queryMonsterArenaGround,
} from './monsterArenaDefinition.js';
import { clamp } from './physics.js';

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _color = new THREE.Color();

function _ownedMesh(geometry, material, owned, { cast = false, receive = false } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.raceOwned = true;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  owned.geometries.add(geometry);
  if (Array.isArray(material)) material.forEach((entry) => owned.materials.add(entry));
  else owned.materials.add(material);
  return mesh;
}

function _roundedSlabGeometry(width, depth, height = 0.16, radius = 0.65) {
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const corner = Math.min(radius, halfWidth - 0.01, halfDepth - 0.01);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + corner, -halfDepth);
  shape.lineTo(halfWidth - corner, -halfDepth);
  shape.quadraticCurveTo(halfWidth, -halfDepth, halfWidth, -halfDepth + corner);
  shape.lineTo(halfWidth, halfDepth - corner);
  shape.quadraticCurveTo(halfWidth, halfDepth, halfWidth - corner, halfDepth);
  shape.lineTo(-halfWidth + corner, halfDepth);
  shape.quadraticCurveTo(-halfWidth, halfDepth, -halfWidth, halfDepth - corner);
  shape.lineTo(-halfWidth, -halfDepth + corner);
  shape.quadraticCurveTo(-halfWidth, -halfDepth, -halfWidth + corner, -halfDepth);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    curveSegments: 3,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: Math.min(0.08, height * 0.36),
    bevelThickness: Math.min(0.05, height * 0.25),
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height * 0.5, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function _compose(x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1, pitch = 0, roll = 0) {
  _position.set(x, y, z);
  _euler.set(pitch, yaw, roll);
  _quaternion.setFromEuler(_euler);
  _scale.set(sx, sy, sz);
  _matrix.compose(_position, _quaternion, _scale);
  return _matrix;
}

function _arenaPoint(feature, localX, localZ) {
  const sin = Math.sin(feature.yaw || 0);
  const cos = Math.cos(feature.yaw || 0);
  return {
    x: feature.x + localX * cos + localZ * sin,
    z: feature.z - localX * sin + localZ * cos,
  };
}

function _terrainColor(sample, definition) {
  if (definition.dressing === 'pyramid-yard') {
    if (sample.featureId === 'stadium-berm') return _color.setHex(0x4f493c);
    if (sample.surface === 'ramp-dirt') return _color.setHex(0x8d663c);
    if (sample.district === 'car-pyramid') return _color.setHex(0x55504a);
    if (sample.district === 'bus-pyramid') return _color.setHex(0x4a5457);
    if (sample.district === 'blast-pit') return _color.setHex(0x493b34);
    if (sample.district === 'heavy-gauntlet') return _color.setHex(0x62503c);
    if (sample.district === 'domino-perimeter') return _color.setHex(0x5c5546);
    return _color.setHex(0x6c5942);
  }
  if (sample.featureId === 'stadium-berm') return _color.setHex(0x72502f);
  if (sample.district === 'demolition-bowl') return _color.setHex(0x6d4431);
  if (sample.surface === 'ramp-dirt') return _color.setHex(0x9b6136);
  if (sample.featureId.startsWith('rhythm') || sample.featureId === 'east-cross-bump') return _color.setHex(0x895638);
  if (sample.district === 'crusher-alley') return _color.setHex(0x73503a);
  return _color.setHex(0x7d5738);
}

function _buildTerrain(definition, group, owned, assetLease) {
  const width = definition.bounds.maxX - definition.bounds.minX;
  const depth = definition.bounds.maxZ - definition.bounds.minZ;
  const segmentsX = 72;
  const segmentsZ = 56;
  const columns = segmentsX + 1;
  const rows = segmentsZ + 1;
  const positions = new Float32Array(columns * rows * 3);
  const colors = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  let cursor = 0;
  let uvCursor = 0;
  for (let row = 0; row < rows; row += 1) {
    const v = row / segmentsZ;
    const z = definition.bounds.minZ + v * depth;
    for (let column = 0; column < columns; column += 1) {
      const u = column / segmentsX;
      const x = definition.bounds.minX + u * width;
      const sample = queryMonsterArenaGround(x, z, definition);
      const color = _terrainColor(sample, definition);
      const variation = 0.91 + (((column * 17 + row * 29) % 11) / 10) * 0.14;
      positions[cursor] = x;
      positions[cursor + 1] = sample.height;
      positions[cursor + 2] = z;
      colors[cursor] = color.r * variation;
      colors[cursor + 1] = color.g * variation;
      colors[cursor + 2] = color.b * variation;
      cursor += 3;
      uvs[uvCursor] = u;
      uvs[uvCursor + 1] = v;
      uvCursor += 2;
    }
  }
  const indices = [];
  for (let row = 0; row < segmentsZ; row += 1) {
    for (let column = 0; column < segmentsX; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const map = assetLease?.textures?.monsterArenaDirtColor
    || assetLease?.textures?.mudColor
    || assetLease?.textures?.groundKakiLandV2Color
    || null;
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map,
    normalMap: assetLease?.textures?.monsterArenaDirtNormal || null,
    roughnessMap: assetLease?.textures?.monsterArenaDirtRoughness || null,
    normalScale: new THREE.Vector2(0.72, 0.72),
    emissive: 0x6a4935,
    emissiveMap: map,
    emissiveIntensity: 0.16,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.01,
  });
  const terrain = _ownedMesh(geometry, material, owned, { receive: true });
  terrain.name = `${definition.id}-authored-heightfield`;
  // The camera rig already receives the authoritative height query. Raycasting
  // this district-sized presentation mesh only repeats that work per probe.
  terrain.userData.cameraIgnore = true;
  group.add(terrain);

  const macroTexture = assetLease?.textures?.monsterArenaDirtMacro || null;
  let macro = null;
  if (macroTexture) {
    const macroMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: macroTexture,
      transparent: true,
      opacity: definition.dressing === 'pyramid-yard' ? 0.11 : 0.09,
      blending: THREE.NormalBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      toneMapped: true,
    });
    macro = _ownedMesh(geometry, macroMaterial, owned, { receive: true });
    macro.name = `${definition.id}-large-scale-dirt-variation`;
    macro.renderOrder = 1;
    group.add(macro);
  }
  return { mesh: terrain, macro };
}

function _atlasFrameTexture(source, column, row, owned) {
  if (!source) return null;
  const texture = cloneTextureForDeferredUpload(source);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(0.5, 0.5);
  texture.offset.set(column * 0.5, (1 - row) * 0.5);
  requestTextureUploadIfReady(texture);
  owned.textures.add(texture);
  return texture;
}

function _buildGroundDressing(definition, group, owned, assetLease) {
  const atlas = assetLease?.textures?.monsterArenaGroundDecals || null;
  if (!atlas) return { decals: [], materials: [] };
  const textures = [
    _atlasFrameTexture(atlas, 0, 0, owned),
    _atlasFrameTexture(atlas, 1, 0, owned),
    _atlasFrameTexture(atlas, 0, 1, owned),
    _atlasFrameTexture(atlas, 1, 1, owned),
  ];
  const materials = textures.map((map, index) => {
    const material = new THREE.MeshBasicMaterial({
      color: index === 3 ? 0xd3b393 : 0xffffff,
      map,
      transparent: true,
      opacity: index === 2 ? 0.58 : index === 3 ? 0.78 : 0.74,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    owned.materials.add(material);
    return material;
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  owned.geometries.add(geometry);
  const common = definition.dressing === 'pyramid-yard'
    ? [
      [0, -43, 17, 35, 0, 0], [-42, -12, 12, 30, 0, 0], [43, -12, 14, 34, 0, 0],
      [0, 43, 33, 25, 0, 1], [-42, 7, 34, 22, -0.35, 3], [43, 10, 40, 29, -0.35, 3],
      [-74, -19, 23, 12, 0.18, 2], [76, -20, 23, 12, -0.18, 2],
      [0, -3, 20, 18, 0, 2], [0, 63, 27, 16, 0.3, 1],
    ]
    : [
      [0, -39, 15, 27, 0, 0], [-48, -6, 18, 35, 0.06, 0], [38, -9, 14, 34, 0, 0],
      [46, 29, 34, 28, 0, 1], [7, 32, 25, 19, Math.PI / 2, 3], [-58, 31, 31, 18, Math.PI / 2, 3],
      [-65, -31, 22, 13, 0.78, 2], [59, 13, 19, 13, -0.2, 2],
    ];
  const decals = common.map(([x, z, width, depth, yaw, frame], index) => {
    const mesh = new THREE.Mesh(geometry, materials[frame]);
    mesh.name = `${definition.id}-ground-story-decal-${index}`;
    mesh.position.set(x, queryMonsterArenaGround(x, z, definition).height + 0.075, z);
    mesh.rotation.y = yaw;
    mesh.scale.set(width, 1, depth);
    mesh.renderOrder = 2;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  });
  return { decals, materials };
}

function _buildRampReadability(definition, group, owned, assetLease) {
  const rampTexture = (source, repeatX, repeatY) => {
    if (!source) return null;
    const texture = cloneTextureForDeferredUpload(source);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    requestTextureUploadIfReady(texture);
    owned.textures.add(texture);
    return texture;
  };
  const lipMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd26f,
    emissive: 0x6d2d14,
    emissiveIntensity: 0.55,
    roughness: 0.36,
    metalness: 0.45,
  });
  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0x65deef,
    emissive: 0x154b72,
    emissiveIntensity: 0.5,
    roughness: 0.42,
    metalness: 0.38,
  });
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: 0xb89075,
    map: rampTexture(assetLease?.textures?.monsterArenaDirtColor, 1, 3),
    normalMap: rampTexture(assetLease?.textures?.monsterArenaDirtNormal, 1, 3),
    normalScale: new THREE.Vector2(0.42, 0.42),
    roughnessMap: rampTexture(assetLease?.textures?.monsterArenaDirtRoughness, 1, 3),
    roughness: 0.92,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const scarMaterial = new THREE.MeshStandardMaterial({
    color: 0x33231d,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const apronMaterial = new THREE.MeshBasicMaterial({
    color: 0x6d5142,
    map: _atlasFrameTexture(assetLease?.textures?.monsterArenaGroundDecals, 0, 0, owned),
    transparent: true,
    opacity: 0.76,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    toneMapped: true,
  });
  owned.materials.add(lipMaterial);
  owned.materials.add(railMaterial);
  owned.materials.add(sideMaterial);
  owned.materials.add(scarMaterial);
  owned.materials.add(apronMaterial);
  const lipGeometry = new THREE.CapsuleGeometry(0.1, 1, 4, 8);
  lipGeometry.rotateZ(Math.PI / 2);
  const markerGeometry = new THREE.BoxGeometry(1, 0.045, 0.42);
  const edgeBeamGeometry = new THREE.BoxGeometry(0.18, 0.2, 1);
  const supportPostGeometry = new THREE.BoxGeometry(0.14, 1, 0.14);
  const apronGeometry = new THREE.PlaneGeometry(1, 1);
  apronGeometry.rotateX(-Math.PI / 2);
  const sidePositions = [];
  const sideUvs = [];
  const sideIndices = [];
  const scarPositions = [];
  const scarIndices = [];
  const profileSteps = 10;
  for (const side of [-0.5, 0.5]) {
    const baseIndex = sidePositions.length / 3;
    for (let step = 0; step <= profileSteps; step += 1) {
      const t = step / profileSteps;
      const z = t - 0.5;
      const height = t * t * (2 - t);
      sidePositions.push(side, 0, z, side, height, z);
      sideUvs.push(0, t, 1, t);
      if (step < profileSteps) {
        const index = baseIndex + step * 2;
        sideIndices.push(index, index + 2, index + 1, index + 1, index + 2, index + 3);
      }
    }
  }
  for (const lane of [-0.2, 0.2]) {
    const baseIndex = scarPositions.length / 3;
    for (let step = 0; step <= profileSteps; step += 1) {
      const t = step / profileSteps;
      const z = t - 0.5;
      const height = t * t * (2 - t);
      scarPositions.push(lane - 0.035, height, z, lane + 0.035, height, z);
      if (step < profileSteps) {
        const index = baseIndex + step * 2;
        scarIndices.push(index, index + 1, index + 2, index + 1, index + 3, index + 2);
      }
    }
  }
  const sideGeometry = new THREE.BufferGeometry();
  sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sidePositions, 3));
  sideGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(sideUvs, 2));
  sideGeometry.setIndex(sideIndices);
  sideGeometry.computeVertexNormals();
  const scarGeometry = new THREE.BufferGeometry();
  scarGeometry.setAttribute('position', new THREE.Float32BufferAttribute(scarPositions, 3));
  scarGeometry.setIndex(scarIndices);
  scarGeometry.computeVertexNormals();
  owned.geometries.add(lipGeometry);
  owned.geometries.add(markerGeometry);
  owned.geometries.add(sideGeometry);
  owned.geometries.add(scarGeometry);
  owned.geometries.add(edgeBeamGeometry);
  owned.geometries.add(supportPostGeometry);
  owned.geometries.add(apronGeometry);
  const braceCountFor = (ramp) => Math.max(5, Math.round(ramp.length / 2.5));
  const totalEdgeBeams = definition.ramps.reduce((sum, ramp) => sum + braceCountFor(ramp) * 2, 0);
  const totalSupportPosts = definition.ramps.reduce((sum, ramp) => sum + Math.ceil(braceCountFor(ramp) / 2) * 2, 0);
  const rampCount = definition.ramps.length;
  const makeBatch = (geometry, material, count, name, receiveShadow = false) => {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = receiveShadow;
    return mesh;
  };
  // A ramp previously submitted seven individual meshes. All ramps share the
  // same geometry/material grammar, so batch their transforms and keep the
  // complete authored look in eight submissions total (including braces).
  const sides = makeBatch(sideGeometry, sideMaterial, rampCount, 'arena-ramp-retaining-sides-batch', true);
  const scars = makeBatch(scarGeometry, scarMaterial, rampCount, 'arena-ramp-tire-scars-batch', true);
  const aprons = makeBatch(apronGeometry, apronMaterial, rampCount, 'arena-ramp-packed-dirt-aprons-batch', true);
  const lips = makeBatch(lipGeometry, lipMaterial, rampCount, 'arena-ramp-lips-batch');
  const railMarkers = makeBatch(markerGeometry, railMaterial, rampCount * 2, 'arena-ramp-rail-markers-batch');
  const lipMarkers = makeBatch(markerGeometry, lipMaterial, rampCount, 'arena-ramp-lip-markers-batch');
  const edgeBeams = new THREE.InstancedMesh(edgeBeamGeometry, railMaterial, totalEdgeBeams);
  const supportPosts = new THREE.InstancedMesh(supportPostGeometry, railMaterial, totalSupportPosts);
  edgeBeams.name = 'arena-ramp-edge-armor-batch';
  supportPosts.name = 'arena-ramp-side-support-batch';
  edgeBeams.receiveShadow = true;
  supportPosts.receiveShadow = true;
  let edgeInstance = 0;
  let supportInstance = 0;
  let railMarkerInstance = 0;
  for (let rampIndex = 0; rampIndex < definition.ramps.length; rampIndex += 1) {
    const ramp = definition.ramps[rampIndex];
    const rampWorld = _compose(ramp.x, 0, ramp.z, ramp.yaw).clone();
    sides.setMatrixAt(rampIndex, rampWorld.clone().multiply(
      _compose(0, 0, 0, 0, ramp.width, ramp.height, ramp.length).clone(),
    ));
    scars.setMatrixAt(rampIndex, rampWorld.clone().multiply(
      _compose(0, 0.055, 0, 0, ramp.width, ramp.height, ramp.length).clone(),
    ));
    aprons.setMatrixAt(rampIndex, rampWorld.clone().multiply(
      _compose(0, 0.045, -ramp.length * 0.5 - 0.82, 0, ramp.width * 1.2, 1, 2.4).clone(),
    ));
    lips.setMatrixAt(rampIndex, rampWorld.clone().multiply(_compose(
      0,
      ramp.height + 0.13,
      ramp.length * 0.5 - 0.12,
      0,
      Math.max(0.5, ramp.width - 0.65),
      1,
      1,
    ).clone()));
    for (let stripe = 0; stripe < 3; stripe += 1) {
      const t = 0.64 + stripe * 0.1;
      const height = (t * t * (2 - t)) * ramp.height;
      const markerMatrix = rampWorld.clone().multiply(_compose(
        0,
        height + 0.05,
        -ramp.length * 0.5 + t * ramp.length,
        0,
        ramp.width * (0.66 + stripe * 0.08),
        1,
        1,
        -Math.atan2(ramp.height / ramp.length, 1),
      ).clone());
      if (stripe === 2) lipMarkers.setMatrixAt(rampIndex, markerMatrix);
      else {
        railMarkers.setMatrixAt(railMarkerInstance, markerMatrix);
        railMarkerInstance += 1;
      }
    }
    const braceSegments = braceCountFor(ramp);
    for (let segment = 0; segment < braceSegments; segment += 1) {
      const t = (segment + 0.5) / braceSegments;
      const height = (t * t * (2 - t)) * ramp.height;
      const slope = ((4 * t - 3 * t * t) * ramp.height) / ramp.length;
      const z = -ramp.length * 0.5 + t * ramp.length;
      const beamScale = ramp.length / braceSegments * 1.05;
      edgeBeams.setMatrixAt(edgeInstance, rampWorld.clone().multiply(
        _compose(-(ramp.width * 0.5 + 0.04), height + 0.13, z, 0, 1, 1, beamScale, -Math.atan(slope)).clone(),
      ));
      edgeInstance += 1;
      edgeBeams.setMatrixAt(edgeInstance, rampWorld.clone().multiply(
        _compose(ramp.width * 0.5 + 0.04, height + 0.13, z, 0, 1, 1, beamScale, -Math.atan(slope)).clone(),
      ));
      edgeInstance += 1;
      if (segment % 2 === 0) {
        for (const side of [-1, 1]) {
          supportPosts.setMatrixAt(supportInstance, rampWorld.clone().multiply(_compose(
            side * (ramp.width * 0.5 + 0.04),
            Math.max(0.18, height * 0.5),
            z,
            0,
            1,
            Math.max(0.32, height + 0.18),
            1,
          ).clone()));
          supportInstance += 1;
        }
      }
    }
  }
  for (const mesh of [sides, scars, aprons, lips, railMarkers, lipMarkers, edgeBeams, supportPosts]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    group.add(mesh);
  }
}

function _buildExteriorWorld(definition, group, owned, assetLease) {
  const stadiumX = Number(definition.stadium?.x) || 82;
  const stadiumZ = Number(definition.stadium?.z) || 63;
  const outerExtent = Math.max(360, stadiumX + 250, stadiumZ + 250);
  const apronShape = new THREE.Shape();
  // The exterior is a real continuous ground plane, not a floating arena card.
  // It reaches well beyond the camera's downward rays while leaving the
  // analytical gameplay heightfield unobstructed in the center.
  apronShape.moveTo(-outerExtent, -outerExtent);
  apronShape.lineTo(outerExtent, -outerExtent);
  apronShape.lineTo(outerExtent, outerExtent);
  apronShape.lineTo(-outerExtent, outerExtent);
  apronShape.closePath();
  const arenaHole = new THREE.Path();
  const holeMinX = definition.bounds.minX - 0.6;
  const holeMaxX = definition.bounds.maxX + 0.6;
  const holeMinZ = definition.bounds.minZ - 0.6;
  const holeMaxZ = definition.bounds.maxZ + 0.6;
  arenaHole.moveTo(holeMinX, holeMinZ);
  arenaHole.lineTo(holeMinX, holeMaxZ);
  arenaHole.lineTo(holeMaxX, holeMaxZ);
  arenaHole.lineTo(holeMaxX, holeMinZ);
  arenaHole.closePath();
  apronShape.holes.push(arenaHole);
  const apronTextureSource = assetLease?.textures?.mudColor
    || assetLease?.textures?.groundKakiLandV2Color
    || assetLease?.textures?.groundKakiLand
    || null;
  const apronTexture = cloneTextureForDeferredUpload(apronTextureSource);
  if (apronTexture) {
    apronTexture.wrapS = THREE.RepeatWrapping;
    apronTexture.wrapT = THREE.RepeatWrapping;
    apronTexture.repeat.set(0.035, 0.035);
    owned.textures.add(apronTexture);
  }
  const apronMaterial = new THREE.MeshStandardMaterial({
    color: 0xa58d68,
    map: apronTexture,
    roughness: 0.98,
    metalness: 0,
  });
  const apron = _ownedMesh(new THREE.ShapeGeometry(apronShape), apronMaterial, owned, { receive: true });
  apron.name = `${definition.id}-continuous-exterior-ground`;
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.08;
  group.add(apron);

  const parkingMaterial = new THREE.MeshStandardMaterial({ color: 0x5b5964, roughness: 0.93, metalness: 0.03 });
  const stripeMaterial = new THREE.MeshBasicMaterial({ color: 0xf1dfb9 });
  owned.materials.add(parkingMaterial);
  owned.materials.add(stripeMaterial);
  const parkingGeometry = new THREE.PlaneGeometry(156, 58);
  const parking = _ownedMesh(parkingGeometry, parkingMaterial, owned, { receive: true });
  parking.name = `${definition.id}-exterior-parking`;
  parking.rotation.x = -Math.PI / 2;
  parking.rotation.z = -Math.PI / 4;
  const parkingCenterX = -(stadiumX + 74);
  const parkingCenterZ = -(stadiumZ + 76);
  parking.position.set(parkingCenterX, -0.03, parkingCenterZ);
  group.add(parking);

  const stripeGeometry = new THREE.BoxGeometry(0.12, 0.018, 3.8);
  owned.geometries.add(stripeGeometry);
  const stripes = new THREE.InstancedMesh(stripeGeometry, stripeMaterial, 60);
  stripes.name = 'crown-chaos-parking-stalls';
  let stripeIndex = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let slot = 0; slot < 15; slot += 1) {
      const localX = -46 + slot * 6.5;
      const localZ = -16 + row * 10.4;
      const cos = Math.cos(-Math.PI / 4);
      const sin = Math.sin(-Math.PI / 4);
      const x = parkingCenterX + localX * cos + localZ * sin;
      const z = parkingCenterZ - localX * sin + localZ * cos;
      stripes.setMatrixAt(stripeIndex, _compose(x, 0.01, z, -Math.PI / 4, 1, 1, 1));
      stripeIndex += 1;
    }
  }
  stripes.instanceMatrix.needsUpdate = true;
  group.add(stripes);

  const treeMaterial = new THREE.MeshBasicMaterial({ color: 0x58a968, toneMapped: false });
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x68452f, roughness: 0.98 });
  owned.materials.add(treeMaterial);
  owned.materials.add(trunkMaterial);
  const treeGeometry = new THREE.DodecahedronGeometry(1, 0);
  const trunkGeometry = new THREE.CylinderGeometry(0.42, 0.62, 2, 7);
  owned.geometries.add(treeGeometry);
  owned.geometries.add(trunkGeometry);
  const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, 72);
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, 72);
  trees.name = `${definition.id}-exterior-tree-line`;
  trunks.name = `${definition.id}-exterior-tree-trunks`;
  for (let index = 0; index < 72; index += 1) {
    const angle = index / 72 * Math.PI * 2;
    const radiusX = stadiumX + 21 + (index % 5) * 2.4;
    const radiusZ = stadiumZ + 21 + (index % 7) * 1.8;
    const height = 3.2 + (index % 4) * 0.42;
    const x = Math.cos(angle) * radiusX;
    const z = Math.sin(angle) * radiusZ;
    trees.setMatrixAt(index, _compose(
      x,
      2.2 + height * 0.55,
      z,
      angle,
      2.2 + (index % 3) * 0.34,
      height * 0.72,
      2.2 + ((index + 1) % 3) * 0.32,
    ));
    trunks.setMatrixAt(index, _compose(x, 1.25, z, angle, 1, 1.25, 1));
  }
  trees.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;
  trees.castShadow = false;
  trees.receiveShadow = true;
  trunks.castShadow = false;
  trunks.receiveShadow = true;
  group.add(trunks, trees);

  const tentRoofMaterial = new THREE.MeshBasicMaterial({ color: 0xff4f9b, toneMapped: false });
  const tentSideMaterial = new THREE.MeshBasicMaterial({ color: 0x36cfe9, toneMapped: false });
  const tentRoofGeometry = new THREE.ConeGeometry(1, 1.35, 8);
  const tentSideGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
  owned.materials.add(tentRoofMaterial);
  owned.materials.add(tentSideMaterial);
  owned.geometries.add(tentRoofGeometry);
  owned.geometries.add(tentSideGeometry);
  const tentPoints = [
    [-(stadiumX + 22), -stadiumZ * 0.58],
    [-(stadiumX + 24), stadiumZ * 0.1],
    [-(stadiumX + 20), stadiumZ * 0.66],
    [-stadiumX * 0.48, -(stadiumZ + 23)],
    [0, -(stadiumZ + 25)],
    [stadiumX * 0.52, -(stadiumZ + 22)],
  ];
  const tentRoofs = new THREE.InstancedMesh(tentRoofGeometry, tentRoofMaterial, tentPoints.length);
  const tentSides = new THREE.InstancedMesh(tentSideGeometry, tentSideMaterial, tentPoints.length);
  tentRoofs.name = 'crown-chaos-exterior-fairground-roofs';
  tentSides.name = 'crown-chaos-exterior-fairground-sides';
  tentPoints.forEach(([x, z], index) => {
    tentRoofs.setMatrixAt(index, _compose(x, 5.35, z, index * 0.22, 5.2, 3.8, 5.2));
    tentSides.setMatrixAt(index, _compose(x, 1.65, z, index * 0.22, 4.65, 3.3, 4.65));
  });
  tentRoofs.instanceMatrix.needsUpdate = true;
  tentSides.instanceMatrix.needsUpdate = true;
  tentRoofs.castShadow = false;
  tentSides.castShadow = false;
  group.add(tentSides, tentRoofs);

  const backdropSource = assetLease?.textures?.monsterArenaBackdrop || null;
  const backdropTexture = cloneTextureForDeferredUpload(backdropSource);
  if (backdropTexture) {
    // The node material mirrors alternating copies around the cylinder, so
    // adjacent joins meet on the exact same source texel.
    backdropTexture.wrapS = THREE.ClampToEdgeWrapping;
    backdropTexture.wrapT = THREE.ClampToEdgeWrapping;
    backdropTexture.repeat.set(1, 1);
    backdropTexture.offset.set(0, 0);
    requestTextureUploadIfReady(backdropTexture);
    owned.textures.add(backdropTexture);
  }

  const skyMaterial = createRacingSkyGradientMaterial({
    horizon: 0xf3d58e,
    zenith: 0x42c7df,
  });
  const skyGeometry = new THREE.SphereGeometry(430, 32, 16);
  const sky = _ownedMesh(skyGeometry, skyMaterial, owned);
  sky.name = `${definition.id}-world-anchored-sky`;
  sky.userData.cameraIgnore = true;
  sky.scale.y = 0.72;
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  group.add(sky);

  const backdropMaterial = backdropTexture || backdropSource
    ? createRacingHorizonMaterial(backdropTexture || backdropSource, {
        // Keep the useful distant-landmark band. Four aspect-preserving,
        // alternately mirrored copies cover 360 degrees without a hard seam.
        sourceMin: 0.46,
        sourceMax: 0.77,
        mirroredRepeats: 4,
      })
    : createRacingSkyGradientMaterial({ horizon: 0x8abf87, zenith: 0x42c7df });
  const backdropGeometry = new THREE.CylinderGeometry(315, 315, 88, 64, 1, true);
  const backdrop = _ownedMesh(backdropGeometry, backdropMaterial, owned);
  backdrop.name = `${definition.id}-world-anchored-curved-horizon`;
  backdrop.userData.cameraIgnore = true;
  backdrop.position.y = 32;
  // Put cardinal gameplay views near the middle of a mirrored sector instead
  // of on a join, keeping the default Chase composition naturally asymmetric.
  backdrop.rotation.y = -Math.PI * 0.25;
  backdrop.renderOrder = -90;
  backdrop.frustumCulled = false;
  group.add(backdrop);

  return {
    apron, parking, stripes, trees, trunks, tentRoofs, tentSides,
    backdrop, backdropMaterial, backdropTexture, sky, skyMaterial, apronTexture,
  };
}

function _buildStadium(definition, group, owned, assetLease) {
  const stadiumX = Number(definition.stadium?.x) || 82;
  const stadiumZ = Number(definition.stadium?.z) || 63;
  const fallbackGroup = new THREE.Group();
  fallbackGroup.name = `${definition.id}-stadium-loading-fallback`;
  group.add(fallbackGroup);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x464756, roughness: 0.78, metalness: 0.2 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x171a22, roughness: 0.43, metalness: 0.7 });
  const crowdMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: assetLease?.textures?.monsterArenaCrowd || null,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const barrierMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.38, metalness: 0.58 });
  owned.materials.add(concrete);
  owned.materials.add(darkSteel);
  owned.materials.add(crowdMaterial);
  owned.materials.add(barrierMaterial);

  const standGeometry = new THREE.BoxGeometry(1, 1, 1);
  const crowdGeometry = new THREE.PlaneGeometry(1, 1);
  const barrierGeometry = new THREE.BoxGeometry(1, 1, 1);
  owned.geometries.add(standGeometry);
  owned.geometries.add(crowdGeometry);
  owned.geometries.add(barrierGeometry);
  const standTransforms = [];
  const crowdTransforms = [];
  const barrierTransforms = [];

  const longSegments = Math.max(7, Math.round(stadiumX / 11.2));
  const shortSegments = Math.max(5, Math.floor((stadiumZ - 5) / 10.5));
  for (const side of [-1, 1]) {
    for (let segment = -longSegments; segment <= longSegments; segment += 1) {
      const x = segment * 11.2;
      for (let tier = 0; tier < 3; tier += 1) {
        standTransforms.push(_compose(x, 2.1 + tier * 2.2, side * (stadiumZ + tier * 3.4), 0, 10.4, 1.8, 4.2).clone());
        crowdTransforms.push(_compose(
          x,
          4.28 + tier * 2.2,
          side * (stadiumZ - 2.82 + tier * 3.4),
          side > 0 ? Math.PI : 0,
          9.8,
          1.5,
          1,
        ).clone());
      }
    }
  }
  for (const side of [-1, 1]) {
    for (let segment = -shortSegments; segment <= shortSegments; segment += 1) {
      const z = segment * 10.5;
      for (let tier = 0; tier < 3; tier += 1) {
        standTransforms.push(_compose(side * (stadiumX + tier * 3.3), 2.1 + tier * 2.2, z, 0, 4.1, 1.8, 9.7).clone());
        crowdTransforms.push(_compose(
          side * (stadiumX - 2.82 + tier * 3.3),
          4.28 + tier * 2.2,
          z,
          side > 0 ? -Math.PI / 2 : Math.PI / 2,
          9.1,
          1.5,
          1,
        ).clone());
      }
    }
  }
  const barrierCount = Math.max(40, Math.round(Math.PI * (stadiumX + stadiumZ) / 5.8));
  for (let i = 0; i < barrierCount; i += 1) {
    const angle = i / barrierCount * Math.PI * 2;
    const x = Math.cos(angle) * (stadiumX - 2);
    const z = Math.sin(angle) * (stadiumZ - 2);
    barrierTransforms.push(_compose(x, 1.1, z, -angle, 6.5, 1.25, 0.45).clone());
  }

  const stands = new THREE.InstancedMesh(standGeometry, concrete, standTransforms.length);
  stands.name = 'crown-chaos-grandstand-tiers';
  stands.castShadow = false;
  stands.receiveShadow = true;
  standTransforms.forEach((matrix, index) => stands.setMatrixAt(index, matrix));
  stands.instanceMatrix.needsUpdate = true;
  const crowds = new THREE.InstancedMesh(crowdGeometry, crowdMaterial, crowdTransforms.length);
  crowds.name = 'crown-chaos-crowd-card-atlas';
  crowdTransforms.forEach((matrix, index) => crowds.setMatrixAt(index, matrix));
  crowds.instanceMatrix.needsUpdate = true;
  const barriers = new THREE.InstancedMesh(barrierGeometry, barrierMaterial, barrierTransforms.length);
  barriers.name = 'crown-chaos-safety-barrier';
  barriers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(barrierTransforms.length * 3), 3);
  const barrierColors = [0xffd274, 0xff6ca7, 0x62dff2];
  barrierTransforms.forEach((matrix, index) => {
    barriers.setMatrixAt(index, matrix);
    barriers.setColorAt(index, new THREE.Color(barrierColors[index % barrierColors.length]));
  });
  barriers.instanceMatrix.needsUpdate = true;
  barriers.instanceColor.needsUpdate = true;
  barriers.castShadow = false;
  fallbackGroup.add(stands, barriers);
  group.add(crowds);

  const towerMaterial = darkSteel;
  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0xfff1c2, emissive: 0xffb75b, emissiveIntensity: 2.4, roughness: 0.18 });
  owned.materials.add(lampMaterial);
  const towers = [];
  for (const [x, z] of [
    [-(stadiumX - 7), -(stadiumZ - 8)],
    [stadiumX - 7, -(stadiumZ - 8)],
    [-(stadiumX - 7), stadiumZ - 9],
    [stadiumX - 7, stadiumZ - 9],
  ]) {
    const tower = new THREE.Group();
    const pole = _ownedMesh(new THREE.CylinderGeometry(0.22, 0.34, 22, 8), towerMaterial, owned, { cast: true });
    pole.position.y = 11;
    tower.add(pole);
    const lamp = _ownedMesh(new THREE.BoxGeometry(5.8, 1.3, 0.9), lampMaterial, owned, { cast: true });
    lamp.position.y = 22;
    tower.add(lamp);
    tower.position.set(x, 0, z);
    fallbackGroup.add(tower);
    towers.push({ group: tower, light: null, lamp });
  }

  const jumbotron = new THREE.Group();
  const screenSupports = [];
  const screenMaterial = new THREE.MeshStandardMaterial({ color: 0x182435, emissive: 0xff4c9f, emissiveIntensity: 0.65, roughness: 0.2, metalness: 0.4 });
  const screenFaceMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: assetLease?.textures?.monsterKeyArt || null,
    toneMapped: false,
  });
  owned.materials.add(screenMaterial);
  owned.materials.add(screenFaceMaterial);
  const screen = _ownedMesh(new THREE.BoxGeometry(18, 8.5, 1.1), screenMaterial, owned, { cast: true });
  screen.position.y = 15;
  jumbotron.add(screen);
  const screenFace = _ownedMesh(new THREE.PlaneGeometry(16.8, 7.35), screenFaceMaterial, owned);
  screenFace.name = 'crown-chaos-jumbotron-art';
  screenFace.position.set(0, 15, 0.56);
  jumbotron.add(screenFace);
  for (const x of [-7.3, 7.3]) {
    const support = _ownedMesh(new THREE.CylinderGeometry(0.35, 0.55, 12, 8), darkSteel, owned, { cast: true });
    support.position.set(x, 6, 0);
    jumbotron.add(support);
    screenSupports.push(support);
  }
  jumbotron.position.set(0, 0, -stadiumZ);
  group.add(jumbotron);
  return { fallbackGroup, stands, crowds, barriers, towers, screen, screenFace, screenSupports, screenMaterial, jumbotron };
}

function _buildFreestyleDressing(group, owned) {
  const fallbackGroup = new THREE.Group();
  fallbackGroup.name = 'crown-chaos-freestyle-loading-fallback';
  group.add(fallbackGroup);
  const steel = new THREE.MeshStandardMaterial({ color: 0x35424e, roughness: 0.48, metalness: 0.58 });
  const cyan = new THREE.MeshStandardMaterial({ color: 0x4ee0ef, emissive: 0x123c58, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.45 });
  const pink = new THREE.MeshStandardMaterial({ color: 0xff5c9f, emissive: 0x5e163d, emissiveIntensity: 0.5, roughness: 0.42, metalness: 0.4 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x202834, roughness: 0.38, metalness: 0.72 });
  owned.materials.add(steel);
  owned.materials.add(cyan);
  owned.materials.add(pink);
  owned.materials.add(trim);
  const containerGeometry = new THREE.BoxGeometry(10, 3.5, 3.2, 2, 1, 1);
  const trimGeometry = new THREE.BoxGeometry(1, 1, 1);
  owned.geometries.add(containerGeometry);
  owned.geometries.add(trimGeometry);
  const containerSpecs = [
    [-66, 1.8, 19, 0, cyan], [-66, 5.25, 19, 0, pink], [-55, 1.8, 19, 0, steel],
    [-71, 1.8, -30, Math.PI / 2, pink], [66, 1.8, -31, Math.PI / 2, cyan],
  ];
  const trimTransforms = [];
  for (const [x, y, z, yaw, material] of containerSpecs) {
    const container = new THREE.Mesh(containerGeometry, material);
    container.name = 'crown-chaos-corrugated-freestyle-container';
    container.position.set(x, y, z);
    container.rotation.y = yaw;
    container.castShadow = true;
    container.receiveShadow = true;
    fallbackGroup.add(container);
    const feature = { x, z, yaw };
    for (let rib = 0; rib < 10; rib += 1) {
      const localX = -4.5 + rib;
      for (const localZ of [-1.63, 1.63]) {
        const point = _arenaPoint(feature, localX, localZ);
        trimTransforms.push(_compose(point.x, y, point.z, yaw, 0.075, 3.16, 0.075).clone());
      }
      const roofPoint = _arenaPoint(feature, localX, 0);
      trimTransforms.push(_compose(roofPoint.x, y + 1.77, roofPoint.z, yaw, 0.09, 0.08, 3.18).clone());
    }
    for (const end of [-1, 1]) {
      for (const localZ of [-1.5, 0, 1.5]) {
        const point = _arenaPoint(feature, end * 5.03, localZ);
        trimTransforms.push(_compose(point.x, y, point.z, yaw, 0.1, 3.3, 0.1).clone());
      }
      const doorBar = _arenaPoint(feature, end * 5.06, 0);
      trimTransforms.push(_compose(doorBar.x, y, doorBar.z, yaw, 0.08, 0.12, 2.82).clone());
    }
  }
  const containerTrim = new THREE.InstancedMesh(trimGeometry, trim, trimTransforms.length);
  containerTrim.name = 'crown-chaos-container-ribs-and-door-frames';
  trimTransforms.forEach((matrix, index) => containerTrim.setMatrixAt(index, matrix));
  containerTrim.instanceMatrix.needsUpdate = true;
  containerTrim.castShadow = true;
  fallbackGroup.add(containerTrim);
  const ringMaterial = new THREE.MeshStandardMaterial({ color: 0xffd66f, emissive: 0x8a4018, emissiveIntensity: 0.65, roughness: 0.4, metalness: 0.5 });
  owned.materials.add(ringMaterial);
  for (const [x, z, radius] of [[-47, -4, 4.4], [38, -4, 5.2], [8, 31, 5.8], [46, 29, 8.5]]) {
    const ring = _ownedMesh(new THREE.RingGeometry(radius - 0.15, radius, 40), ringMaterial, owned);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, queryMonsterArenaGround(x, z).height + 0.08, z);
    fallbackGroup.add(ring);
  }
  return { fallbackGroup };
}

function _buildPyramidYardDressing(definition, group, owned, assetLease) {
  const fallbackGroup = new THREE.Group();
  fallbackGroup.name = 'pileup-pyramid-loading-fallback';
  group.add(fallbackGroup);
  const preparePadTexture = (source, repeatX, repeatY) => {
    if (!source) return null;
    const texture = cloneTextureForDeferredUpload(source);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    requestTextureUploadIfReady(texture);
    owned.textures.add(texture);
    return texture;
  };
  const asphalt = new THREE.MeshStandardMaterial({
    color: 0x9499a6,
    map: preparePadTexture(assetLease?.textures?.monsterArenaDirtColor, 2.8, 2.1),
    normalMap: preparePadTexture(assetLease?.textures?.monsterArenaDirtNormal, 2.8, 2.1),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughnessMap: preparePadTexture(assetLease?.textures?.monsterArenaDirtRoughness, 2.8, 2.1),
    roughness: 0.86,
    metalness: 0.04,
  });
  const hazard = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false });
  const steel = new THREE.MeshStandardMaterial({ color: 0x242b31, roughness: 0.4, metalness: 0.76 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xffd36d, emissive: 0xff6d22, emissiveIntensity: 1.25, roughness: 0.3, metalness: 0.35 });
  owned.materials.add(asphalt);
  owned.materials.add(hazard);
  owned.materials.add(steel);
  owned.materials.add(lamp);

  const pads = [
    { id: 'car', x: -42, z: 7, width: 31, depth: 18, color: 0xffcc58 },
    { id: 'bus', x: 43, z: 10, width: 36, depth: 25, color: 0x62e5f3 },
  ];
  const gantries = [];
  const markerMatrices = [];
  const markerColors = [];
  const markerGeometry = new THREE.BoxGeometry(1, 0.055, 0.42);
  const wearGeometry = new THREE.PlaneGeometry(1, 1);
  wearGeometry.rotateX(-Math.PI / 2);
  const wearTexture = _atlasFrameTexture(assetLease?.textures?.monsterArenaGroundDecals, 0, 1, owned);
  const wearMaterial = new THREE.MeshBasicMaterial({
    color: 0x6c6672,
    map: wearTexture,
    transparent: true,
    opacity: 0.64,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    toneMapped: true,
  });
  owned.geometries.add(markerGeometry);
  owned.geometries.add(wearGeometry);
  owned.materials.add(wearMaterial);
  for (const pad of pads) {
    const padMesh = _ownedMesh(_roundedSlabGeometry(pad.width, pad.depth, 0.18, 0.9), asphalt, owned, { receive: true });
    padMesh.name = `pileup-${pad.id}-pyramid-impact-pad`;
    padMesh.position.set(pad.x, queryMonsterArenaGround(pad.x, pad.z, definition).height + 0.015, pad.z);
    fallbackGroup.add(padMesh);
    const wear = new THREE.Mesh(wearGeometry, wearMaterial);
    wear.name = `pileup-${pad.id}-pyramid-oil-and-impact-wear`;
    wear.position.set(pad.x, padMesh.position.y + 0.205, pad.z);
    wear.scale.set(pad.width * 0.76, 1, pad.depth * 0.68);
    wear.rotation.y = pad.id === 'bus' ? -0.16 : 0.22;
    wear.renderOrder = 3;
    fallbackGroup.add(wear);
    const xCount = Math.ceil(pad.width / 2);
    const zCount = Math.ceil(pad.depth / 2);
    for (const side of [-1, 1]) {
      for (let index = 0; index < xCount; index += 1) {
        const x = pad.x - pad.width * 0.5 + (index + 0.5) * pad.width / xCount;
        const z = pad.z + side * pad.depth * 0.5;
        markerMatrices.push(_compose(x, 0.12, z, 0, pad.width / xCount * 0.82, 1, 1).clone());
        markerColors.push((index + (side > 0 ? 1 : 0)) % 2 ? 0x16191c : pad.color);
      }
      for (let index = 0; index < zCount; index += 1) {
        const x = pad.x + side * pad.width * 0.5;
        const z = pad.z - pad.depth * 0.5 + (index + 0.5) * pad.depth / zCount;
        markerMatrices.push(_compose(x, 0.12, z, Math.PI / 2, pad.depth / zCount * 0.82, 1, 1).clone());
        markerColors.push((index + (side > 0 ? 1 : 0)) % 2 ? 0x16191c : pad.color);
      }
    }

    const gantry = new THREE.Group();
    gantry.name = `pileup-${pad.id}-pyramid-gantry`;
    // Keep the frame on the far side of the pile so the isometric camera sees
    // the vehicle silhouette cleanly instead of looking through a foreground beam.
    const gantryZ = pad.z - pad.depth * 0.5 - 2.2;
    for (const side of [-1, 1]) {
      const pole = _ownedMesh(new THREE.BoxGeometry(0.5, 10, 0.5), steel, owned, { cast: true });
      pole.position.set(pad.x + side * (pad.width * 0.5 - 1.4), 5, gantryZ);
      gantry.add(pole);
    }
    const beam = _ownedMesh(new THREE.BoxGeometry(pad.width - 2.4, 0.65, 0.65), steel, owned, { cast: true });
    beam.position.set(pad.x, 9.7, gantryZ);
    gantry.add(beam);
    for (let lightIndex = 0; lightIndex < 5; lightIndex += 1) {
      const beacon = _ownedMesh(new THREE.BoxGeometry(1.1, 0.32, 0.24), lamp, owned);
      beacon.position.set(pad.x - 5.6 + lightIndex * 2.8, 9.7, gantryZ - 0.45);
      gantry.add(beacon);
    }
    fallbackGroup.add(gantry);
    gantries.push(gantry);
  }
  const markers = new THREE.InstancedMesh(markerGeometry, hazard, markerMatrices.length);
  markers.name = 'pileup-pyramid-yard-hazard-border';
  markers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(markerMatrices.length * 3), 3);
  markerMatrices.forEach((matrix, index) => {
    markers.setMatrixAt(index, matrix);
    markers.setColorAt(index, new THREE.Color(markerColors[index]));
  });
  markers.instanceMatrix.needsUpdate = true;
  markers.instanceColor.needsUpdate = true;
  fallbackGroup.add(markers);

  const dominoLaneMaterial = new THREE.MeshBasicMaterial({
    color: 0xffbf58,
    transparent: true,
    opacity: 0.34,
    toneMapped: false,
    depthWrite: false,
  });
  const blastRingMaterial = new THREE.MeshStandardMaterial({
    color: 0xff5b28,
    emissive: 0xff2a08,
    emissiveIntensity: 1.05,
    roughness: 0.4,
    metalness: 0.32,
  });
  owned.materials.add(dominoLaneMaterial);
  owned.materials.add(blastRingMaterial);
  const dominoLanes = [];
  for (const [x, z, width, depth] of [
    [0, 73, 108, 6.8],
    [0, -73, 108, 6.8],
    [104, 0, 6.8, 82],
    [-104, 0, 6.8, 82],
  ]) {
    const lane = _ownedMesh(new THREE.PlaneGeometry(width, depth), dominoLaneMaterial, owned);
    lane.name = 'pileup-domino-perimeter-lane';
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(x, queryMonsterArenaGround(x, z, definition).height + 0.07, z);
    lane.renderOrder = 1;
    fallbackGroup.add(lane);
    dominoLanes.push(lane);
  }
  const blastRing = _ownedMesh(new THREE.RingGeometry(16.6, 17.4, 56), blastRingMaterial, owned);
  blastRing.name = 'pileup-hot-car-blast-pit-ring';
  blastRing.rotation.x = -Math.PI / 2;
  blastRing.position.set(0, 0.11, 43);
  fallbackGroup.add(blastRing);
  return { fallbackGroup, pads, markers, dominoLanes, blastRing, gantries };
}

function _placement(definition, x, z, yaw = 0, options = {}) {
  return {
    x,
    y: options.y ?? queryMonsterArenaGround(x, z, definition).height,
    z,
    yaw,
    sx: options.sx ?? 1,
    sy: options.sy ?? 1,
    sz: options.sz ?? 1,
    pitch: options.pitch ?? 0,
    roll: options.roll ?? 0,
  };
}

function _instanceEnvironmentModule(gltf, moduleName, placements, parent, options = {}) {
  const source = gltf?.scene?.getObjectByName?.(moduleName);
  if (!source || !placements.length) return [];
  source.updateWorldMatrix(true, true);
  const inverseSource = source.matrixWorld.clone().invert();
  const meshes = [];
  let componentIndex = 0;
  source.traverse((object) => {
    if (!object.isMesh) return;
    const sourceMatrix = inverseSource.clone().multiply(object.matrixWorld);
    const instances = new THREE.InstancedMesh(object.geometry, object.material, placements.length);
    instances.name = `${moduleName.toLowerCase()}-instances-${componentIndex}`;
    instances.userData.productionModule = moduleName;
    instances.castShadow = options.cast !== false;
    instances.receiveShadow = options.receive !== false;
    instances.frustumCulled = true;
    placements.forEach((placement, index) => {
      const matrix = _compose(
        placement.x,
        placement.y,
        placement.z,
        placement.yaw,
        placement.sx,
        placement.sy,
        placement.sz,
        placement.pitch,
        placement.roll,
      ).clone().multiply(sourceMatrix);
      instances.setMatrixAt(index, matrix);
    });
    instances.instanceMatrix.needsUpdate = true;
    parent.add(instances);
    meshes.push(instances);
    componentIndex += 1;
  });
  return meshes;
}

function _stadiumModulePlacements(definition) {
  const stadiumX = Number(definition.stadium?.x) || 82;
  const stadiumZ = Number(definition.stadium?.z) || 63;
  const barrierX = stadiumX - 2.4;
  const barrierZ = stadiumZ - 2.4;
  const circumference = Math.PI * (3 * (barrierX + barrierZ) - Math.sqrt((3 * barrierX + barrierZ) * (barrierX + 3 * barrierZ)));
  const boundaryCount = Math.max(64, Math.round(circumference / 4.45));
  const barriers = [];
  const guardrails = [];
  const fences = [];
  for (let index = 0; index < boundaryCount; index += 1) {
    const angle = index / boundaryCount * Math.PI * 2;
    const x = Math.cos(angle) * barrierX;
    const z = Math.sin(angle) * barrierZ;
    const yaw = Math.PI / 2 - angle;
    barriers.push(_placement(definition, x, z, yaw));
    guardrails.push(_placement(definition, Math.cos(angle) * (barrierX + 0.22), Math.sin(angle) * (barrierZ + 0.22), yaw, { y: queryMonsterArenaGround(x, z, definition).height + 0.9 }));
    if (index % 2 === 0) fences.push(_placement(definition, Math.cos(angle) * (barrierX + 0.46), Math.sin(angle) * (barrierZ + 0.46), yaw, { y: queryMonsterArenaGround(x, z, definition).height + 1.35, sx: 2.02 }));
  }

  const stands = [];
  const longSegments = Math.max(7, Math.round(stadiumX / 10.8));
  const shortSegments = Math.max(5, Math.floor((stadiumZ - 5) / 10.3));
  for (const side of [-1, 1]) {
    for (let segment = -longSegments; segment <= longSegments; segment += 1) {
      const x = segment * 10.8;
      const z = side * (stadiumZ + 1.4);
      stands.push(_placement(definition, x, z, side > 0 ? Math.PI : 0));
    }
    for (let segment = -shortSegments; segment <= shortSegments; segment += 1) {
      const x = side * (stadiumX + 1.35);
      const z = segment * 10.3;
      stands.push(_placement(definition, x, z, side > 0 ? -Math.PI / 2 : Math.PI / 2));
    }
  }
  const towers = [
    [-(stadiumX - 7), -(stadiumZ - 8)], [stadiumX - 7, -(stadiumZ - 8)],
    [-(stadiumX - 7), stadiumZ - 9], [stadiumX - 7, stadiumZ - 9],
  ].map(([x, z]) => _placement(definition, x, z));
  return { barriers, guardrails, fences, stands, towers };
}

function _storyModulePlacements(definition) {
  const stadiumX = Number(definition.stadium?.x) || 82;
  const stadiumZ = Number(definition.stadium?.z) || 63;
  const edgeX = stadiumX - 12;
  const edgeZ = stadiumZ - 13;
  const containers = definition.dressing === 'pyramid-yard'
    ? [[-edgeX, -edgeZ, 0], [-edgeX, -edgeZ + 5, 0], [edgeX, edgeZ - 4, Math.PI / 2]]
    : [[-66, 19, 0], [-66, 19, 0, 3.52], [-55, 19, 0], [-71, -30, Math.PI / 2], [66, -31, Math.PI / 2]];
  const containerPlacements = containers.map(([x, z, yaw, y]) => _placement(definition, x, z, yaw, { y: y ?? queryMonsterArenaGround(x, z, definition).height }));

  const tireStacks = [
    [-edgeX, -edgeZ * 0.48, 0], [-edgeX + 3.2, -edgeZ * 0.48, 0.12],
    [edgeX, edgeZ * 0.45, Math.PI], [edgeX - 3.2, edgeZ * 0.45, -0.1],
    [-edgeX * 0.76, edgeZ, Math.PI / 2], [edgeX * 0.72, -edgeZ, Math.PI / 2],
  ].map(([x, z, yaw]) => _placement(definition, x, z, yaw));
  const drums = [
    [-edgeX + 7, -edgeZ + 5], [-edgeX + 8.2, -edgeZ + 5.8], [-edgeX + 9.2, -edgeZ + 4.5],
    [edgeX - 8, edgeZ - 5], [edgeX - 9.2, edgeZ - 6.2],
  ].map(([x, z], index) => _placement(definition, x, z, index * 0.7));
  const crates = [
    [-edgeX + 4.5, -edgeZ + 7], [-edgeX + 6, -edgeZ + 7.4],
    [edgeX - 5, edgeZ - 7], [edgeX - 6.6, edgeZ - 7.4],
  ].map(([x, z], index) => _placement(definition, x, z, index * 0.25));
  const cones = [];
  for (let index = 0; index < 14; index += 1) {
    const x = -edgeX * 0.42 + index * (edgeX * 0.84 / 13);
    cones.push(_placement(definition, x, -edgeZ + 3 + Math.sin(index * 1.7) * 0.45, index * 0.17));
  }
  const bollards = [-4, -2, 0, 2, 4].map((offset) => _placement(definition, offset, -stadiumZ + 5, 0));
  const toolCarts = [_placement(definition, -edgeX + 10.5, -edgeZ + 8, 0.35), _placement(definition, edgeX - 11, edgeZ - 8, Math.PI + 0.2)];
  const scaffolds = [_placement(definition, -edgeX, edgeZ * 0.1, 0), _placement(definition, edgeX, -edgeZ * 0.12, Math.PI)];
  const speakers = [
    _placement(definition, -stadiumX + 7, -stadiumZ + 10, 0.5),
    _placement(definition, stadiumX - 7, -stadiumZ + 10, -0.5),
    _placement(definition, -stadiumX + 7, stadiumZ - 10, Math.PI - 0.5),
    _placement(definition, stadiumX - 7, stadiumZ - 10, Math.PI + 0.5),
  ];
  const gates = [_placement(definition, 0, -stadiumZ + 3.8, 0)];
  if (definition.dressing === 'pyramid-yard') {
    gates.push(_placement(definition, -42, 7 - 13.2, 0), _placement(definition, 43, 10 - 16.5, 0));
  }
  const cameras = [
    _placement(definition, -stadiumX + 8, -stadiumZ + 6, 0.7),
    _placement(definition, stadiumX - 8, -stadiumZ + 6, -0.7),
    _placement(definition, -stadiumX + 8, stadiumZ - 6, Math.PI - 0.7),
    _placement(definition, stadiumX - 8, stadiumZ - 6, Math.PI + 0.7),
  ];
  const banners = [
    _placement(definition, -stadiumX + 2.1, -stadiumZ * 0.34, Math.PI / 2, { y: 4.2 }),
    _placement(definition, stadiumX - 2.1, stadiumZ * 0.34, -Math.PI / 2, { y: 4.2 }),
    _placement(definition, -stadiumX * 0.42, stadiumZ - 2.1, Math.PI, { y: 4.2 }),
    _placement(definition, stadiumX * 0.42, -stadiumZ + 2.1, 0, { y: 4.2 }),
  ];
  const exteriorTrees = [];
  for (let index = 0; index < 56; index += 1) {
    const angle = index / 56 * Math.PI * 2;
    const x = Math.cos(angle) * (stadiumX + 23 + (index % 5) * 1.4);
    const z = Math.sin(angle) * (stadiumZ + 22 + (index % 7) * 1.1);
    const scale = 0.78 + (index % 4) * 0.11;
    exteriorTrees.push(_placement(definition, x, z, angle * 1.7, { y: 0, sx: scale, sy: scale, sz: scale }));
  }
  const exteriorTents = [
    [-(stadiumX + 22), -stadiumZ * 0.58], [-(stadiumX + 24), stadiumZ * 0.1],
    [-(stadiumX + 20), stadiumZ * 0.66], [-stadiumX * 0.48, -(stadiumZ + 23)],
    [0, -(stadiumZ + 25)], [stadiumX * 0.52, -(stadiumZ + 22)],
  ].map(([x, z], index) => _placement(definition, x, z, index * 0.32, { y: 0, sx: 1.05, sy: 1.05, sz: 1.05 }));
  return {
    containerPlacements, tireStacks, drums, crates, cones, bollards, toolCarts,
    scaffolds, speakers, gates, cameras, banners, exteriorTrees, exteriorTents,
  };
}

export function attachMonsterEnvironmentKit(arena, gltf) {
  if (!arena || !gltf?.scene || arena.environmentKitAttached) return false;
  const root = new THREE.Group();
  root.name = `${arena.definition.id}-production-environment-kit`;
  const stadium = _stadiumModulePlacements(arena.definition);
  const story = _storyModulePlacements(arena.definition);
  const meshes = [];
  const add = (name, placements, options) => meshes.push(..._instanceEnvironmentModule(gltf, name, placements, root, options));
  add('ArenaKit_ConcreteBarrier', stadium.barriers);
  add('ArenaKit_Guardrail', stadium.guardrails);
  add('ArenaKit_FencePanel', stadium.fences);
  add('ArenaKit_GrandstandBay', stadium.stands);
  add('ArenaKit_LightTower', stadium.towers);
  add('ArenaKit_ScoreboardFrame', [_placement(arena.definition, 0, -(Number(arena.definition.stadium?.z) || 63), 0, { y: 0 })]);
  add('ArenaKit_Container', story.containerPlacements);
  add('ArenaKit_TireStack', story.tireStacks);
  add('ArenaKit_FuelDrum', story.drums);
  add('ArenaKit_Crate', story.crates);
  add('ArenaKit_Cone', story.cones, { cast: false });
  add('ArenaKit_Bollard', story.bollards);
  add('ArenaKit_ToolCart', story.toolCarts);
  add('ArenaKit_Scaffold', story.scaffolds);
  add('ArenaKit_SpeakerCluster', story.speakers);
  add('ArenaKit_ServiceGate', story.gates);
  add('ArenaKit_Camera', story.cameras);
  add('ArenaKit_BannerFrame', story.banners);
  add('ArenaKit_ExteriorTree', story.exteriorTrees);
  add('ArenaKit_EventTent', story.exteriorTents);
  add('ArenaKit_BrokenBarrier', stadium.barriers.filter((_, index) => index % 29 === 7).map((placement) => ({ ...placement, y: placement.y + 0.08 })));
  arena.group.add(root);
  arena.stadium.fallbackGroup.visible = false;
  arena.stadium.screen.visible = false;
  for (const support of arena.stadium.screenSupports || []) support.visible = false;
  for (const object of [arena.exterior?.trees, arena.exterior?.trunks, arena.exterior?.tentRoofs, arena.exterior?.tentSides]) {
    if (object) object.visible = false;
  }
  if (arena.definition.dressing === 'pyramid-yard') {
    for (const gantry of arena.dressing.gantries || []) gantry.visible = false;
    for (const lane of arena.dressing.dominoLanes || []) lane.visible = false;
    if (arena.dressing.blastRing) arena.dressing.blastRing.visible = false;
  } else if (arena.dressing.fallbackGroup) {
    arena.dressing.fallbackGroup.visible = false;
  }
  arena.environmentKitRoot = root;
  arena.environmentKitMeshes = meshes;
  arena.environmentKitAttached = meshes.length >= 18;
  return arena.environmentKitAttached;
}

/** Add a visible hero bank to the camera-facing east grandstand. */
export function attachMonsterAudience(arena, gltf) {
  if (!arena || !gltf?.scene || arena.audienceAttached) return false;
  const stadiumX = Number(arena.definition?.stadium?.x) || 82;
  const root = new THREE.Group();
  root.name = `${arena.definition.id}-optimized-3d-audience`;
  const banks = [];
  const bankY = 10.1;
  const placements = [
    [stadiumX - 8, 2.6, Math.PI / 2, 0.2],
  ];
  for (const [x, z, yaw, phase] of placements) {
    const bank = gltf.scene.clone(true);
    bank.name = `${arena.definition.id}-audience-bank-${banks.length + 1}`;
    bank.position.set(x, bankY, z);
    bank.rotation.y = yaw;
    bank.scale.setScalar(1.08);
    bank.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = false;
      object.receiveShadow = false;
      object.frustumCulled = true;
    });
    root.add(bank);
    banks.push({ group: bank, baseY: bankY, phase });
  }
  arena.group.add(root);
  arena.audienceRoot = root;
  arena.audienceBanks = banks;
  arena.audienceAttached = banks.length > 0;
  return arena.audienceAttached;
}

export function buildMonsterArena({
  root,
  owned,
  assetLease = null,
  definition = CROWN_CHAOS_ARENA,
} = {}) {
  if (!root || !owned) throw new Error('buildMonsterArena requires root and owned resource sets');
  const group = new THREE.Group();
  group.name = `${definition.id}-authored-arena`;
  root.add(group);
  const exterior = _buildExteriorWorld(definition, group, owned, assetLease);
  const terrainBuilt = _buildTerrain(definition, group, owned, assetLease);
  const groundDressing = _buildGroundDressing(definition, group, owned, assetLease);
  _buildRampReadability(definition, group, owned, assetLease);
  const stadium = _buildStadium(definition, group, owned, assetLease);
  const dressing = definition.dressing === 'pyramid-yard'
    ? _buildPyramidYardDressing(definition, group, owned, assetLease)
    : _buildFreestyleDressing(group, owned);
  return {
    definition,
    group,
    terrain: terrainBuilt.mesh,
    terrainMacro: terrainBuilt.macro,
    groundDressing,
    exterior,
    stadium,
    dressing,
    time: 0,
    environmentKitAttached: false,
    environmentKitRoot: null,
    environmentKitMeshes: [],
    audienceAttached: false,
    audienceRoot: null,
    audienceBanks: [],
    disposed: false,
  };
}

export function updateMonsterArena(arena, time, dt = 0, crowdPulse = 0) {
  if (!arena || arena.disposed) return;
  arena.time = Number(time) || arena.time + dt;
  const pulse = clamp(Number(crowdPulse) || 0, 0, 1);
  arena.stadium.screenMaterial.emissiveIntensity = 0.48 + pulse * 1.4 + Math.sin(arena.time * 2.2) * 0.08;
  for (let i = 0; i < arena.stadium.towers.length; i += 1) {
    const tower = arena.stadium.towers[i];
    if (tower.light) tower.light.intensity = 16 + pulse * 14 + Math.sin(arena.time * 1.7 + i) * 1.5;
  }
  for (const bank of arena.audienceBanks || []) {
    const cheer = Math.sin(arena.time * (1.45 + pulse * 0.9) + bank.phase);
    bank.group.position.y = bank.baseY + cheer * (0.025 + pulse * 0.075);
  }
}

export function disposeMonsterArena(arena) {
  if (!arena || arena.disposed) return;
  arena.disposed = true;
  arena.group?.parent?.remove(arena.group);
}

export function monsterArenaContact(arena, kart) {
  const definition = arena?.definition || arena || CROWN_CHAOS_ARENA;
  const ground = queryMonsterArenaGround(kart?.x || 0, kart?.z || 0, definition);
  const takeoff = findMonsterRampTakeoff(kart, definition);
  const ramp = takeoff?.ramp || definition.ramps.find((entry) => entry.id === ground.featureId);
  let launches = false;
  let rampVelocity = 0;
  let rampDirection = null;
  let takeoffSlope = 0;
  let suspensionRebound = 0;
  if (ramp && takeoff) {
    const forwardX = Math.sin(ramp.yaw || 0);
    const forwardZ = Math.cos(ramp.yaw || 0);
    const along = takeoff.along ?? ((kart.vx || 0) * forwardX + (kart.vz || 0) * forwardZ);
    launches = along > 5.5;
    if (launches) {
      rampDirection = { x: forwardX, z: forwardZ };
      takeoffSlope = Math.max(0, takeoff.takeoffSlope || 0);
      suspensionRebound = clamp(-(Number(kart.suspensionVelocity) || 0) * 0.22, 0, 2.2);
      rampVelocity = along * Math.sin(Math.atan(takeoffSlope)) + suspensionRebound;
    }
  }
  return {
    nearest: { index: 0, distance: 0 },
    onRoad: ground.insideBounds,
    surface: ground.surface,
    surfaceGrip: ground.surfaceGrip,
    surfaceDrag: ground.surfaceDrag,
    groundHeight: ground.height,
    groundNormal: ground.normal,
    groundPitch: ground.pitch,
    groundRoll: ground.roll,
    district: ground.district,
    featureId: ground.featureId,
    signature: ground.signature,
    landing: ground.landing,
    landingZone: landingZoneAt(kart?.x || 0, kart?.z || 0, definition),
    ramp: launches,
    rampVelocity,
    rampDirection,
    takeoffSlope,
    suspensionRebound,
    preserveRampSpeed: launches,
    boostPad: false,
    repairBay: false,
    sampleGround(x, z) {
      return queryMonsterArenaGround(x, z, definition);
    },
  };
}

export function resolveMonsterArenaBounds(arena, kart) {
  const definition = arena?.definition || arena || CROWN_CHAOS_ARENA;
  const bounds = definition.bounds;
  let hit = false;
  let nx = 0;
  let nz = 0;
  if (kart.x < bounds.minX) { kart.x = bounds.minX; nx = 1; hit = true; }
  else if (kart.x > bounds.maxX) { kart.x = bounds.maxX; nx = -1; hit = true; }
  if (kart.z < bounds.minZ) { kart.z = bounds.minZ; nz = 1; hit = true; }
  else if (kart.z > bounds.maxZ) { kart.z = bounds.maxZ; nz = -1; hit = true; }
  if (!hit) return { hit: false, speed: 0 };
  const inward = Math.max(0, kart.vx * -nx + kart.vz * -nz);
  if (nx) kart.vx = Math.abs(kart.vx) * nx * 0.38;
  if (nz) kart.vz = Math.abs(kart.vz) * nz * 0.38;
  kart.angularVelocity = (kart.angularVelocity || 0) + (nx || -nz) * clamp(inward * 0.025, -0.65, 0.65);
  return { hit: true, speed: inward };
}

export function respawnMonsterKart(arena, kart, preferredId = '') {
  const definition = arena?.definition || arena || CROWN_CHAOS_ARENA;
  const spawn = preferredId
    ? definition.spawnPoints.find((entry) => entry.id === preferredId) || definition.spawnPoints[0]
    : nearestMonsterRespawn(kart?.x, kart?.z, definition);
  if (!kart || !spawn) return null;
  Object.assign(kart, {
    x: spawn.x,
    z: spawn.z,
    y: queryMonsterArenaGround(spawn.x, spawn.z, definition).height,
    previousX: spawn.x,
    previousZ: spawn.z,
    yaw: spawn.yaw,
    vx: 0,
    vz: 0,
    vy: 0,
    speed: 0,
    grounded: true,
    wrecked: false,
    wreckTime: 0,
    rescueTime: 0,
    stuntPitch: 0,
    stuntPitchVelocity: 0,
    stuntRoll: 0,
    stuntRollVelocity: 0,
    airTime: 0,
  });
  return spawn;
}

export function createMonsterArenaNavigationSamples(definition = CROWN_CHAOS_ARENA) {
  const x = Math.max(12, Math.abs(definition.bounds.softX) - 8);
  const z = Math.max(12, Math.abs(definition.bounds.softZ) - 7);
  const points = [
    [-x * 0.92, -z * 0.8], [-x * 0.28, -z], [x * 0.38, -z * 0.96], [x * 0.92, -z * 0.68],
    [x, z * 0.32], [x * 0.68, z * 0.92], [0, z], [-x * 0.7, z * 0.9], [-x, z * 0.2],
  ];
  return points.map(([x, z], index) => {
    const next = points[(index + 1) % points.length];
    const dx = next[0] - x;
    const dz = next[1] - z;
    const length = Math.hypot(dx, dz) || 1;
    const tangent = { x: dx / length, y: 0, z: dz / length };
    return { x, z, tangent, normal: { x: -tangent.z, y: 0, z: tangent.x } };
  });
}

export function monsterArenaRenderSnapshot(arena) {
  return {
    id: arena?.definition?.id || '',
    districts: arena?.definition?.districts?.length || 0,
    ramps: arena?.definition?.ramps?.length || 0,
    landingZones: arena?.definition?.landingZones?.length || 0,
    hasExterior: !!arena?.exterior?.backdrop,
    productionEnvironmentAttached: !!arena?.environmentKitAttached,
    productionEnvironmentMeshes: arena?.environmentKitMeshes?.length || 0,
    groundDecals: arena?.groundDressing?.decals?.length || 0,
    crowdCards: arena?.stadium?.crowds?.count || 0,
    audienceBanks: arena?.audienceBanks?.length || 0,
    bounds: arena?.definition?.bounds || null,
  };
}
