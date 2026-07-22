import * as THREE from 'three';
import { requestTextureUploadIfReady } from '../rendering/textureUpload.js';

/**
 * Presentation-only environment kit for Kaki Rally.
 *
 * This module deliberately consumes already-sampled track data. It never creates
 * or mutates path samples, collision widths, feature indices, or physics state.
 * Repeated dressing is instanced, resources are shared, and the update function
 * does not allocate.
 */

const ASSET_ROOT = new URL('../../assets/', import.meta.url);

const SKY_ASSETS = Object.freeze({
  forest: 'textures/sky_golden.webp',
  twilight: 'textures/sky_twilight.webp',
  cinder: 'textures/sky_bloodmoon.webp',
  void: 'textures/sky_bloodmoon.webp',
  cave: 'textures/sky_dusk.webp',
  kakiland: 'kakiland/kaki-land-sky-gpt-v2.png',
});

const ROAD_ASSETS = Object.freeze({
  forest: Object.freeze({ color: 'sprites/brown_mud/diff.jpg', normal: 'sprites/brown_mud/nor_gl.jpg', roughness: 'sprites/brown_mud/rough.jpg' }),
  twilight: Object.freeze({ color: 'sprites/brown_mud/diff.jpg', normal: 'sprites/brown_mud/nor_gl.jpg', roughness: 'sprites/brown_mud/rough.jpg' }),
  cinder: Object.freeze({ color: 'textures/cave_stone_diffuse.png', normal: 'textures/cave_stone_normal.png', roughness: 'textures/cave_stone_rough.png' }),
  void: Object.freeze({ color: 'textures/biome_flagstone_512.webp' }),
  cave: Object.freeze({ color: 'textures/cave_stone_diffuse.png', normal: 'textures/cave_stone_normal.png', roughness: 'textures/cave_stone_rough.png' }),
  kakiland: Object.freeze({ color: 'textures/biome_flagstone_512.webp' }),
});

const GROUND_ASSETS = Object.freeze({
  forest: Object.freeze({ color: 'racing/terrain-v2/forest-ground-color.webp', normal: 'racing/terrain-v2/forest-ground-normal.webp', roughness: 'racing/terrain-v2/forest-ground-roughness.webp', repeat: 1.5 }),
  twilight: Object.freeze({ color: 'racing/terrain-v2/twilight-ground-color.webp', normal: 'racing/terrain-v2/twilight-ground-normal.webp', roughness: 'racing/terrain-v2/twilight-ground-roughness.webp', repeat: 1.55 }),
  cinder: Object.freeze({ color: 'racing/terrain-v2/cinder-ground-color.webp', normal: 'racing/terrain-v2/cinder-ground-normal.webp', roughness: 'racing/terrain-v2/cinder-ground-roughness.webp', repeat: 1.45 }),
  void: Object.freeze({ color: 'racing/terrain-v2/void-ground-color.webp', normal: 'racing/terrain-v2/void-ground-normal.webp', roughness: 'racing/terrain-v2/void-ground-roughness.webp', repeat: 1.55 }),
  cave: Object.freeze({ color: 'racing/terrain-v2/cave-ground-color.webp', normal: 'racing/terrain-v2/cave-ground-normal.webp', roughness: 'racing/terrain-v2/cave-ground-roughness.webp', repeat: 1.7 }),
  kakiland: Object.freeze({ color: 'racing/terrain-v2/kakiland-ground-color.webp', normal: 'racing/terrain-v2/kakiland-ground-normal.webp', roughness: 'racing/terrain-v2/kakiland-ground-roughness.webp', repeat: 1.55 }),
});

const AUTHORED_BIOME_PROPS = Object.freeze({
  forest: Object.freeze({ primary: ['forest_tree_gnarled_a', 'forest_tree_gnarled_b'], accent: 'forest_fern_cluster' }),
  twilight: Object.freeze({ primary: ['twilight_tree_lantern'], accent: 'twilight_reed_cluster' }),
  cinder: Object.freeze({ primary: ['cinder_basalt_cluster', 'cinder_dead_tree'], accent: 'cinder_basalt_cluster' }),
  void: Object.freeze({ primary: ['void_bone_spires', 'void_grave_cluster'], accent: 'void_grave_cluster' }),
  cave: Object.freeze({ primary: ['cave_stalagmite_cluster', 'cave_timber_brace'], accent: 'cave_rubble_cluster' }),
  kakiland: Object.freeze({ primary: ['kakiland_blossom_tree'], accent: 'kakiland_flower_cluster' }),
});

export const RALLY_ENVIRONMENT_PROFILES = Object.freeze({
  forest: Object.freeze({
    sky: 0xefd3a4, horizon: 0x61765b, haze: 0xa6b98a,
    ground: 0x6d8050, roadTint: 0x80654d, shoulder: 0x3d563c,
    dark: 0x17362a, mid: 0x3f704a, pale: 0xd9e6a9, glow: 0x9dffb0,
    fogNear: 88, fogFar: 178,
    hemisphere: Object.freeze({ sky: 0xffe6bb, ground: 0x3b543d, intensity: 1.28 }),
    key: Object.freeze({ color: 0xffddb0, intensity: 2.35, position: [-46, 72, -34] }),
  }),
  twilight: Object.freeze({
    sky: 0x101b36, horizon: 0x273b59, haze: 0x4b6680,
    ground: 0x344859, roadTint: 0x536170, shoulder: 0x1d303b,
    dark: 0x142a39, mid: 0x36586b, pale: 0xaed9e8, glow: 0x65e9ff,
    fogNear: 76, fogFar: 166,
    hemisphere: Object.freeze({ sky: 0x8ac9ff, ground: 0x172637, intensity: 1.12 }),
    key: Object.freeze({ color: 0xbbe8ff, intensity: 1.85, position: [38, 66, -48] }),
  }),
  cinder: Object.freeze({
    sky: 0x220907, horizon: 0x6b2113, haze: 0x9b4125,
    ground: 0x6b3122, roadTint: 0x493632, shoulder: 0x4c1c13,
    dark: 0x241315, mid: 0x713025, pale: 0xdf8756, glow: 0xff6a2c,
    fogNear: 72, fogFar: 160,
    hemisphere: Object.freeze({ sky: 0xffa06d, ground: 0x34100d, intensity: 1.05 }),
    key: Object.freeze({ color: 0xffc27e, intensity: 2.3, position: [-36, 61, 44] }),
  }),
  void: Object.freeze({
    sky: 0x0e071b, horizon: 0x26183e, haze: 0x503367,
    ground: 0x332747, roadTint: 0x41394a, shoulder: 0x1f172e,
    dark: 0x171024, mid: 0x4a3264, pale: 0xb9a2d1, glow: 0xd26aff,
    fogNear: 70, fogFar: 154,
    hemisphere: Object.freeze({ sky: 0xaa83e8, ground: 0x130d21, intensity: 0.98 }),
    key: Object.freeze({ color: 0xe2beff, intensity: 1.75, position: [41, 58, -34] }),
  }),
  cave: Object.freeze({
    sky: 0x15151d, horizon: 0x2c3037, haze: 0x566068,
    ground: 0x45474d, roadTint: 0x5c5754, shoulder: 0x292e35,
    dark: 0x24292e, mid: 0x4a5559, pale: 0xa7c9bd, glow: 0x70ffd0,
    fogNear: 72, fogFar: 158,
    hemisphere: Object.freeze({ sky: 0xb6d8d3, ground: 0x20252b, intensity: 0.94 }),
    key: Object.freeze({ color: 0xd8fff1, intensity: 1.78, position: [-42, 62, -28] }),
  }),
  kakiland: Object.freeze({
    sky: 0x8bd6f2, horizon: 0xc4ecf4, haze: 0xe8fbff,
    ground: 0x91be67, roadTint: 0xead6ac, shoulder: 0x6e9f4e,
    dark: 0x315d58, mid: 0x71b16e, pale: 0xfff5ca, glow: 0xff76c5,
    fogNear: 105, fogFar: 205,
    hemisphere: Object.freeze({ sky: 0xdff8ff, ground: 0x66894a, intensity: 1.4 }),
    key: Object.freeze({ color: 0xfff1c9, intensity: 2.5, position: [-50, 78, -38] }),
  }),
});

const _dummy = new THREE.Object3D();
const _skyAnchor = new THREE.Vector3();

function _assetUrl(path) {
  if (!path) return '';
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  return new URL(String(path).replace(/^\.\.\/\.\.\/assets\//, '').replace(/^\/?assets\//, ''), ASSET_ROOT).href;
}

function _seed(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function _courseSalt(course) {
  return Number(course?.seed) || (String(course?.id || 'forest').length * 997);
}

function _hex(courseColor, fallback) {
  return Number.isFinite(courseColor) ? courseColor : fallback;
}

function _profileFor(course) {
  return RALLY_ENVIRONMENT_PROFILES[course?.id] || RALLY_ENVIRONMENT_PROFILES.forest;
}

function _makeResourceContext(sets, textureResolver = null) {
  const resources = { geometries: [], materials: [], textures: [] };
  const add = (type, value) => {
    if (!value) return value;
    resources[type].push(value);
    sets[type]?.add(value);
    return value;
  };
  return {
    resources,
    geometry: (value) => add('geometries', value),
    material: (value) => add('materials', value),
    texture: (value) => add('textures', value),
    resolveTexture: typeof textureResolver === 'function' ? textureResolver : null,
  };
}

function _loadTexture(path, rc, {
  color = true,
  repeatX = 1,
  repeatY = 1,
  anisotropy = 4,
} = {}) {
  const assetUrl = _assetUrl(path);
  const resolvedTexture = rc.resolveTexture?.(path) || rc.resolveTexture?.(assetUrl) || null;
  if (rc.resolveTexture && !resolvedTexture) {
    throw new Error(`[Kaki Rally environment] Texture is missing from the active asset lease: ${path}`);
  }
  const texture = resolvedTexture || new THREE.TextureLoader().load(assetUrl);
  const external = !!resolvedTexture;
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = anisotropy;
  // A lease can expose TextureLoader's synchronous placeholder before decode.
  // WebGPU treats a dirty null-image texture as an invalid upload, so only
  // request the sampler refresh when the image is actually ready. TextureLoader
  // performs the first version bump itself when its image finishes decoding.
  requestTextureUploadIfReady(texture);
  return external ? texture : rc.texture(texture);
}

function _courseBounds(samples) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const radius = Math.max(maxX - minX, maxZ - minZ) * 0.5;
  return { minX, maxX, minZ, maxZ, centerX, centerZ, radius };
}

function _trackDistances(samples) {
  const distances = new Float32Array(samples.length);
  let distance = 0;
  for (let i = 1; i < samples.length; i++) {
    distance += Math.hypot(
      samples[i].x - samples[i - 1].x,
      (samples[i].y || 0) - (samples[i - 1].y || 0),
      samples[i].z - samples[i - 1].z,
    );
    distances[i] = distance;
  }
  return distances;
}

function _ribbonGeometry(samples, centerOffset, width, y, rc, distances, uvScale = 5.5) {
  const count = samples.length;
  const positions = new Float32Array(count * 6);
  const uvs = new Float32Array(count * 4);
  const indices = new Uint16Array(count * 6);
  const half = width * 0.5;
  for (let i = 0; i < count; i++) {
    const p = samples[i];
    const left = centerOffset + half;
    const right = centerOffset - half;
    const p6 = i * 6;
    positions[p6] = p.x + p.normal.x * left;
    positions[p6 + 1] = (p.y || 0) + y;
    positions[p6 + 2] = p.z + p.normal.z * left;
    positions[p6 + 3] = p.x + p.normal.x * right;
    positions[p6 + 4] = (p.y || 0) + y;
    positions[p6 + 5] = p.z + p.normal.z * right;
    const t4 = i * 4;
    uvs[t4] = 0;
    uvs[t4 + 1] = distances[i] / uvScale;
    uvs[t4 + 2] = 1;
    uvs[t4 + 3] = distances[i] / uvScale;
    const next = (i + 1) % count;
    const pIndex = i * 6;
    indices[pIndex] = i * 2;
    indices[pIndex + 1] = i * 2 + 1;
    indices[pIndex + 2] = next * 2;
    indices[pIndex + 3] = i * 2 + 1;
    indices[pIndex + 4] = next * 2 + 1;
    indices[pIndex + 5] = next * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return rc.geometry(geometry);
}

function _mesh(geometry, material, { cast = false, receive = false } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.userData.raceOwned = true;
  mesh.userData.presentationOnly = true;
  return mesh;
}

function _placeObject(object, sample, lateral = 0, y = 0) {
  object.position.set(
    sample.x + sample.normal.x * lateral,
    (sample.y || 0) + y,
    sample.z + sample.normal.z * lateral,
  );
  object.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
}

function _setInstance(mesh, index, transform) {
  _dummy.position.set(transform.x, transform.y, transform.z);
  _dummy.rotation.set(transform.rx || 0, transform.yaw || 0, transform.rz || 0);
  _dummy.scale.set(
    transform.sx ?? transform.scale ?? 1,
    transform.sy ?? transform.scale ?? 1,
    transform.sz ?? transform.scale ?? 1,
  );
  _dummy.updateMatrix();
  mesh.setMatrixAt(index, _dummy.matrix);
}

function _instanced(group, geometry, material, transforms, {
  name = 'rally-instances',
  cast = false,
  receive = false,
} = {}) {
  if (!transforms.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.userData.raceOwned = true;
  mesh.userData.presentationOnly = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  for (let i = 0; i < transforms.length; i++) _setInstance(mesh, i, transforms[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
  return mesh;
}

function _organicGeometry(radius, detail, rc, seed = 1) {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const scale = 0.9 + 0.13 * Math.sin(x * 2.7 + seed) * Math.cos(z * 3.1 - seed) + 0.05 * Math.sin(y * 5.3);
    positions.setXYZ(i, x * scale, y * scale * 0.92, z * scale);
  }
  geometry.computeVertexNormals();
  return rc.geometry(geometry);
}

function _spireGeometry(height, radius, segments, rc, seed = 0) {
  const rings = 4;
  const positions = [];
  const indices = [];
  for (let ring = 0; ring < rings; ring++) {
    const v = ring / (rings - 1);
    const ringRadius = radius * (1 - v) * (0.92 + 0.12 * Math.sin(v * 9 + seed));
    for (let side = 0; side < segments; side++) {
      const angle = (side / segments) * Math.PI * 2;
      const wobble = 0.82 + _seed(seed + ring * 17 + side * 3) * 0.32;
      positions.push(Math.cos(angle) * ringRadius * wobble, v * height, Math.sin(angle) * ringRadius * wobble);
    }
  }
  positions.push(0.12 * Math.sin(seed), height * 1.08, 0.12 * Math.cos(seed));
  const tip = rings * segments;
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let side = 0; side < segments; side++) {
      const next = (side + 1) % segments;
      const a = ring * segments + side;
      const b = ring * segments + next;
      const c = (ring + 1) * segments + side;
      const d = (ring + 1) * segments + next;
      indices.push(a, b, c, b, d, c);
    }
  }
  for (let side = 0; side < segments; side++) {
    indices.push((rings - 1) * segments + side, (rings - 1) * segments + (side + 1) % segments, tip);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return rc.geometry(geometry);
}

function _trunkGeometry(rc) {
  const profile = [
    new THREE.Vector2(0.74, 0),
    new THREE.Vector2(0.62, 0.28),
    new THREE.Vector2(0.49, 1.4),
    new THREE.Vector2(0.38, 2.9),
    new THREE.Vector2(0.31, 4.1),
  ];
  return rc.geometry(new THREE.LatheGeometry(profile, 7));
}

function _gravestoneGeometry(rc) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.72, 0);
  shape.lineTo(-0.72, 1.45);
  shape.bezierCurveTo(-0.72, 2.35, 0.72, 2.35, 0.72, 1.45);
  shape.lineTo(0.72, 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.06, bevelSegments: 2 });
  geometry.center();
  geometry.translate(0, 1.05, 0);
  return rc.geometry(geometry);
}

function _pennantGeometry(rc) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(1.45, 0.55);
  shape.lineTo(0.18, 1.05);
  shape.closePath();
  return rc.geometry(new THREE.ShapeGeometry(shape));
}

function _material(rc, parameters) {
  return rc.material(new THREE.MeshStandardMaterial(parameters));
}

function _basicMaterial(rc, parameters) {
  return rc.material(new THREE.MeshBasicMaterial(parameters));
}

function _registerGlow(env, material) {
  material.userData.rallyBaseEmissiveIntensity = material.emissiveIntensity;
  env.glowMaterials.push(material);
  return material;
}

function _buildSky(group, course, profile, bounds, rc, env, anisotropy) {
  const skyTexture = _loadTexture(SKY_ASSETS[course.id] || SKY_ASSETS.forest, rc, { anisotropy, repeatX: 1.2 });
  skyTexture.wrapT = THREE.ClampToEdgeWrapping;
  const skyMaterial = _basicMaterial(rc, {
    map: skyTexture,
    // Painted skies already carry the authored chapter grade. A strong color
    // multiply would crush the twilight/cinder images into near-black.
    color: 0xffffff,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = _mesh(rc.geometry(new THREE.SphereGeometry(205, 32, 18)), skyMaterial);
  sky.name = 'rally-painted-sky';
  sky.position.set(bounds.centerX, 12, bounds.centerZ);
  sky.scale.y = 0.62;
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  group.add(sky);
  env.sky = sky;

  const hazeMaterial = _basicMaterial(rc, {
    color: profile.haze,
    transparent: true,
    opacity: course.id === 'kakiland' ? 0.24 : 0.16,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const haze = _mesh(rc.geometry(new THREE.CylinderGeometry(150, 173, 42, 48, 1, true)), hazeMaterial);
  haze.name = 'rally-horizon-haze';
  haze.position.set(bounds.centerX, 3, bounds.centerZ);
  group.add(haze);
}

function _terrainGeometry(size, course, profile, bounds, samples, rc) {
  const geometry = new THREE.PlaneGeometry(size, size, 72, 72);
  geometry.rotateX(-Math.PI * 0.5);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const base = new THREE.Color(_hex(course.ground, profile.ground));
  const shadow = base.clone().multiplyScalar(course.id === 'kakiland' ? 0.68 : 0.5);
  const highlight = base.clone().lerp(new THREE.Color(profile.pale), course.id === 'kakiland' ? 0.3 : 0.2);
  const vertexColor = new THREE.Color();
  const amplitude = ({ forest: 0.85, twilight: 0.5, cinder: 1.1, void: 0.72, cave: 0.92, kakiland: 0.42 })[course.id] || 0.7;
  for (let index = 0; index < positions.count; index++) {
    const localX = positions.getX(index);
    const localZ = positions.getZ(index);
    const worldX = localX + bounds.centerX;
    const worldZ = localZ + bounds.centerZ;
    let distanceSq = Infinity;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 5) {
      const sample = samples[sampleIndex];
      const dx = worldX - sample.x;
      const dz = worldZ - sample.z;
      distanceSq = Math.min(distanceSq, dx * dx + dz * dz);
    }
    const trackClearance = course.trackWidth * 0.62 + 2.4;
    const relief = THREE.MathUtils.smoothstep(Math.sqrt(distanceSq), trackClearance, trackClearance + 18);
    const macro = 0.52
      + Math.sin(worldX * 0.117 + worldZ * 0.071) * 0.23
      + Math.cos(worldZ * 0.153 - worldX * 0.043) * 0.18
      + (_seed(index * 1.37 + _courseSalt(course) * 0.019) - 0.5) * 0.16;
    positions.setY(index, -0.22 - relief * amplitude * Math.max(0.08, macro));
    const tone = THREE.MathUtils.clamp(
      0.4 + macro * 0.52 + (_seed(index * 3.17 + _courseSalt(course) * 0.041) - 0.5) * 0.2,
      0.12,
      0.98,
    );
    vertexColor.lerpColors(shadow, highlight, tone);
    colors[index * 3] = vertexColor.r;
    colors[index * 3 + 1] = vertexColor.g;
    colors[index * 3 + 2] = vertexColor.b;
  }
  positions.needsUpdate = true;
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return rc.geometry(geometry);
}

function _buildGround(group, course, profile, bounds, samples, rc, anisotropy) {
  // The rally camera is high and oblique; a generous terrain apron prevents
  // the sky dome from reading as a streaky floor beyond the old small square.
  const size = Math.max(360, (bounds.radius + 132) * 2);
  const assets = GROUND_ASSETS[course.id] || GROUND_ASSETS.forest;
  const groundMap = _loadTexture(assets.color, rc, {
    anisotropy,
    repeatX: assets.repeat,
    repeatY: assets.repeat,
  });
  const normalMap = _loadTexture(assets.normal, rc, { color: false, anisotropy, repeatX: assets.repeat, repeatY: assets.repeat });
  const roughnessMap = _loadTexture(assets.roughness, rc, { color: false, anisotropy, repeatX: assets.repeat, repeatY: assets.repeat });
  const groundMaterial = _material(rc, {
    map: groundMap,
    normalMap,
    roughnessMap,
    normalScale: new THREE.Vector2(0.48, 0.48),
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  const terrainGeometry = _terrainGeometry(size, course, profile, bounds, samples, rc);
  const ground = _mesh(terrainGeometry, groundMaterial, { receive: true });
  ground.name = 'rally-biome-ground';
  ground.position.set(bounds.centerX, 0, bounds.centerZ);
  group.add(ground);

  // A translucent unlit art pass keeps the authored macro texture readable
  // from the high isometric camera while the PBR layer below still receives
  // relief, normals, lighting and car/tree shadows.
  const artMaterial = _basicMaterial(rc, {
    map: groundMap,
    color: 0xffffff,
    transparent: true,
    opacity: ({
      forest: 0.82,
      twilight: 0.76,
      cinder: 0.8,
      void: 0.74,
      cave: 0.7,
      kakiland: 0.78,
    })[course.id] || 0.76,
    depthWrite: false,
    fog: true,
    toneMapped: false,
  });
  const art = _mesh(rc.geometry(terrainGeometry.clone()), artMaterial);
  art.name = 'rally-biome-ground-art';
  art.position.set(bounds.centerX, 0.028, bounds.centerZ);
  art.renderOrder = -4;
  group.add(art);
}

function _buildTrackLayers(group, course, profile, samples, rc, anisotropy) {
  const distances = _trackDistances(samples);
  const width = course.trackWidth;
  const roadAssets = ROAD_ASSETS[course.id] || ROAD_ASSETS.forest;
  const colorMap = _loadTexture(roadAssets.color, rc, { anisotropy });
  const normalMap = roadAssets.normal ? _loadTexture(roadAssets.normal, rc, { color: false, anisotropy }) : null;
  const roughnessMap = roadAssets.roughness ? _loadTexture(roadAssets.roughness, rc, { color: false, anisotropy }) : null;

  const basinMaterial = _material(rc, {
    color: new THREE.Color(_hex(course.shoulder, profile.shoulder)).multiplyScalar(0.63),
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const shoulderMaterial = _material(rc, {
    color: _hex(course.shoulder, profile.shoulder),
    roughness: 0.97,
    side: THREE.DoubleSide,
  });
  const roadMaterial = _material(rc, {
    map: colorMap,
    normalMap,
    roughnessMap,
    color: _hex(course.road, profile.roadTint),
    roughness: roughnessMap ? 0.88 : 0.94,
    metalness: 0.015,
    normalScale: new THREE.Vector2(0.42, 0.42),
    side: THREE.DoubleSide,
  });
  const grooveMaterial = _basicMaterial(rc, {
    color: course.id === 'kakiland' ? 0x9b7f70 : 0x21191a,
    transparent: true,
    opacity: course.id === 'twilight' ? 0.2 : 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const edgeMaterial = _basicMaterial(rc, {
    color: _hex(course.curb, profile.pale),
    transparent: true,
    opacity: 0.64,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const basin = _mesh(_ribbonGeometry(samples, 0, width + 5.8, -0.015, rc, distances), basinMaterial, { receive: true });
  basin.name = 'rally-track-basin';
  const shoulder = _mesh(_ribbonGeometry(samples, 0, width + 3.0, 0.02, rc, distances), shoulderMaterial, { receive: true });
  shoulder.name = 'rally-track-shoulder';
  const road = _mesh(_ribbonGeometry(samples, 0, width, 0.085, rc, distances), roadMaterial, { receive: true });
  road.name = 'rally-track-surface';
  group.add(basin, shoulder, road);

  const grooveWidth = course.mode === 'stock' ? 0.78 : 0.5;
  const grooveOffset = Math.min(width * 0.24, course.mode === 'stock' ? 3.1 : 2.15);
  for (const side of [-1, 1]) {
    const groove = _mesh(_ribbonGeometry(samples, side * grooveOffset, grooveWidth, 0.105, rc, distances), grooveMaterial);
    groove.name = 'rally-tire-wear';
    group.add(groove);
    const edge = _mesh(_ribbonGeometry(samples, side * (width * 0.5 - 0.11), 0.13, 0.112, rc, distances), edgeMaterial);
    edge.name = 'rally-edge-paint';
    group.add(edge);
  }
}

function _buildCurbsAndRails(group, course, profile, samples, rc) {
  const stockWall = course.mode === 'stock' || course.mode === 'monster';
  const step = stockWall ? 3 : 4;
  const first = [];
  const second = [];
  const posts = [];
  const rails = [];
  for (let i = 0, stripe = 0; i < samples.length; i += step, stripe++) {
    const sample = samples[i];
    for (const side of [-1, 1]) {
      const target = (stripe + (side > 0 ? 1 : 0)) % 2 ? first : second;
      target.push({
        x: sample.x + sample.normal.x * side * (course.trackWidth * 0.5 + 0.34),
        y: (sample.y || 0) + (stockWall ? 0.24 : 0.17),
        z: sample.z + sample.normal.z * side * (course.trackWidth * 0.5 + 0.34),
        yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
        sx: stockWall ? 1.18 : 0.9,
        sy: stockWall ? 1.28 : 0.72,
        sz: stockWall ? 1.38 : 1.02,
      });
      if (stockWall && i % 6 === 0) {
        const lateral = side * (course.trackWidth * 0.5 + 1.05);
        posts.push({
          x: sample.x + sample.normal.x * lateral,
          y: (sample.y || 0) + 0.86,
          z: sample.z + sample.normal.z * lateral,
          yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
          sy: 1.25,
        });
        rails.push({
          x: sample.x + sample.normal.x * lateral,
          y: (sample.y || 0) + 1.16,
          z: sample.z + sample.normal.z * lateral,
          yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
          sz: 2.75,
        });
      }
    }
  }
  const curbGeometry = rc.geometry(new THREE.CapsuleGeometry(0.19, 1.08, 3, 7));
  curbGeometry.rotateX(Math.PI * 0.5);
  const light = _material(rc, { color: _hex(course.curb, profile.pale), roughness: 0.58, metalness: 0.06 });
  const accent = _material(rc, {
    color: _hex(course.accent, profile.glow),
    emissive: _hex(course.accent, profile.glow),
    emissiveIntensity: course.id === 'kakiland' ? 0.18 : 0.32,
    roughness: 0.52,
  });
  _instanced(group, curbGeometry, light, first, { name: 'rally-curb-light', cast: true, receive: true });
  _instanced(group, curbGeometry, accent, second, { name: 'rally-curb-accent', cast: true, receive: true });

  if (stockWall) {
    const postGeometry = _spireGeometry(1.25, 0.18, 6, rc, 31);
    const railGeometry = rc.geometry(new THREE.CapsuleGeometry(0.12, 1.35, 3, 6));
    railGeometry.rotateX(Math.PI * 0.5);
    const metal = _material(rc, { color: 0x948b88, roughness: 0.42, metalness: 0.64 });
    _instanced(group, postGeometry, metal, posts, { name: 'rally-guard-posts', cast: true });
    _instanced(group, railGeometry, metal, rails, { name: 'rally-guard-rails', cast: true });
  }
}

function _distanceSqToTrack2D(x, z, samples) {
  let minimum = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    const abX = b.x - a.x;
    const abZ = b.z - a.z;
    const lengthSq = abX * abX + abZ * abZ;
    const projection = lengthSq > 1e-8
      ? THREE.MathUtils.clamp(((x - a.x) * abX + (z - a.z) * abZ) / lengthSq, 0, 1)
      : 0;
    const dx = x - (a.x + abX * projection);
    const dz = z - (a.z + abZ * projection);
    minimum = Math.min(minimum, dx * dx + dz * dz);
  }
  return minimum;
}

function _acceptTracksideSite(site, course, samples, requiredClearance) {
  const centerDistance = Math.sqrt(_distanceSqToTrack2D(site.x, site.z, samples));
  const edgeClearance = centerDistance - course.trackWidth * 0.5;
  if (edgeClearance < requiredClearance) return false;
  site.edgeClearance = edgeClearance;
  site.requiredClearance = requiredClearance;
  return true;
}

function _makeScatterSites(course, samples) {
  const sites = [];
  const halfWidth = course.trackWidth * 0.5;
  const salt = _courseSalt(course) * 0.001;
  for (let i = 6, serial = 0; i < samples.length; i += 6, serial++) {
    for (const side of [-1, 1]) {
      if ((serial + (side > 0 ? 2 : 0)) % 7 === 0) continue;
      const p = samples[i];
      const jitter = _seed(serial * 41 + side * 13 + 2 + salt);
      const scale = 0.78 + _seed(serial * 19 + side * 7 + salt) * 0.64;
      const lateral = side * (halfWidth + 6.4 + jitter * 7.4);
      const site = {
        x: p.x + p.normal.x * lateral,
        y: 0,
        z: p.z + p.normal.z * lateral,
        yaw: _seed(serial * 29 + side * 5 + salt) * Math.PI * 2,
        scale,
        seed: serial * 2 + (side > 0 ? 1 : 0),
        tier: 0,
      };
      // Test against the complete circuit, not only the source sample. This is
      // what keeps trees and rockwork out of hairpins, linked corners and the
      // lower route of player-drawn figure eights.
      if (_acceptTracksideSite(site, course, samples, Math.max(4.8, scale * 3.4))) sites.push(site);
    }
  }
  for (let i = 14, serial = 0; i < samples.length; i += 13, serial++) {
    const side = serial % 2 ? -1 : 1;
    const p = samples[i];
    const lateral = side * (halfWidth + 21 + _seed(serial * 67 + salt) * 12);
    const scale = 1.15 + _seed(serial * 11 + salt) * 0.9;
    const site = {
      x: p.x + p.normal.x * lateral,
      y: 0,
      z: p.z + p.normal.z * lateral,
      yaw: _seed(serial * 17 + salt) * Math.PI * 2,
      scale,
      seed: 100 + serial,
      tier: 1,
    };
    if (_acceptTracksideSite(site, course, samples, Math.max(5.4, scale * 3.4))) sites.push(site);
  }
  return sites;
}

function _makeDressingSites(course, samples) {
  const sites = [];
  const halfWidth = course.trackWidth * 0.5;
  const salt = _courseSalt(course) * 0.001;
  for (let index = 3, serial = 0; index < samples.length; index += 5, serial++) {
    const sample = samples[index];
    for (const side of [-1, 1]) {
      const roll = _seed(serial * 73 + side * 17 + salt);
      if (roll < 0.16) continue;
      const lateral = side * (halfWidth + 11 + roll * 28);
      const scale = 0.78 + _seed(serial * 47 + side * 5 + salt) * 0.9;
      const site = {
        x: sample.x + sample.normal.x * lateral,
        y: -0.08,
        z: sample.z + sample.normal.z * lateral,
        yaw: _seed(serial * 31 + side * 11 + salt) * Math.PI * 2,
        scale,
      };
      if (_acceptTracksideSite(site, course, samples, Math.max(2.4, scale * 1.75))) sites.push(site);
    }
  }
  return sites;
}

function _partTransforms(sites, yFactor, scaleFactors, filter = null) {
  const transforms = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    if (filter && !filter(site)) continue;
    transforms.push({
      x: site.x,
      y: site.y + yFactor * site.scale,
      z: site.z,
      yaw: site.yaw,
      sx: site.scale * scaleFactors[0],
      sy: site.scale * scaleFactors[1],
      sz: site.scale * scaleFactors[2],
    });
  }
  return transforms;
}

function _buildBiomeScatter(group, course, profile, sites, rc, env) {
  const dark = _material(rc, { color: profile.dark, roughness: 0.92 });
  const mid = _material(rc, { color: profile.mid, roughness: 0.86 });
  const pale = _material(rc, { color: profile.pale, roughness: 0.78 });
  const glow = _material(rc, {
    color: profile.glow,
    emissive: profile.glow,
    emissiveIntensity: course.id === 'kakiland' ? 0.36 : 1.15,
    roughness: 0.36,
  });
  _registerGlow(env, glow);

  if (course.id === 'forest' || course.id === 'twilight' || course.id === 'kakiland') {
    const trunks = _trunkGeometry(rc);
    const canopy = _organicGeometry(1.75, 1, rc, course.id.length);
    const crownScale = course.id === 'kakiland' ? [1.25, 0.78, 1.25] : [1.08, 1.22, 1.08];
    _instanced(group, trunks, course.id === 'twilight' ? dark : mid, _partTransforms(sites, 0, [0.54, 1.08, 0.54]), { name: `${course.id}-trunks`, cast: true, receive: true });
    _instanced(group, canopy, course.id === 'kakiland' ? pale : dark, _partTransforms(sites, 4.45, crownScale), { name: `${course.id}-canopies`, cast: true });
    const canopyLobes = [];
    for (const site of sites) {
      const tangentX = Math.cos(site.yaw);
      const tangentZ = Math.sin(site.yaw);
      for (const side of [-1, 1]) {
        const lobeScale = site.scale * (0.62 + ((site.seed + (side > 0 ? 1 : 0)) % 3) * 0.07);
        canopyLobes.push({
          x: site.x + tangentX * side * site.scale * 1.18,
          y: 4.05 * site.scale + (side > 0 ? 0.34 : -0.06),
          z: site.z + tangentZ * side * site.scale * 1.18,
          yaw: site.yaw + side * 0.32,
          sx: lobeScale * (course.id === 'kakiland' ? 1.22 : 1.05),
          sy: lobeScale * (course.id === 'kakiland' ? 0.7 : 0.92),
          sz: lobeScale * 1.08,
        });
      }
    }
    _instanced(group, canopy, course.id === 'twilight' ? mid : (course.id === 'kakiland' ? glow : mid), canopyLobes, {
      name: `${course.id}-clustered-canopy-lobes`,
      cast: true,
    });

    const accentSites = sites.filter((site) => site.seed % 3 === 0);
    if (course.id === 'twilight') {
      const lantern = _organicGeometry(0.31, 1, rc, 42);
      const transforms = accentSites.map((site) => ({
        x: site.x + Math.cos(site.yaw) * site.scale,
        y: 3.3 * site.scale,
        z: site.z + Math.sin(site.yaw) * site.scale,
        scale: site.scale,
      }));
      _instanced(group, lantern, glow, transforms, { name: 'twilight-lanterns' });
    } else if (course.id === 'forest') {
      const mushroom = _organicGeometry(0.52, 1, rc, 8);
      const transforms = accentSites.map((site) => ({ x: site.x + 1.5, y: 0.52, z: site.z - 0.8, sx: site.scale, sy: site.scale * 0.48, sz: site.scale }));
      _instanced(group, mushroom, glow, transforms, { name: 'forest-moonroot-caps' });
    } else {
      const pennant = _pennantGeometry(rc);
      const transforms = accentSites.map((site) => ({ x: site.x, y: 4.2 * site.scale, z: site.z, yaw: site.yaw, scale: site.scale }));
      const flags = _instanced(group, pennant, glow, transforms, { name: 'kakiland-pennants' });
      if (flags) env.animatedObjects.push({ object: flags, baseY: flags.position.y, phase: 1.7, amplitude: 0.055 });
    }
    return;
  }

  if (course.id === 'void') {
    const stone = _gravestoneGeometry(rc);
    const crystals = _spireGeometry(2.7, 0.65, 6, rc, 51);
    _instanced(group, stone, pale, _partTransforms(sites, 0, [0.72, 1.05, 0.72]), { name: 'void-grave-markers', cast: true, receive: true });
    _instanced(group, crystals, glow, _partTransforms(sites, 0, [0.48, 0.88, 0.48], (site) => site.seed % 2 === 0), { name: 'void-rift-crystals', cast: true });
    return;
  }

  const stone = _spireGeometry(course.id === 'cinder' ? 5.4 : 4.6, course.id === 'cinder' ? 1.8 : 1.35, 7, rc, course.id === 'cinder' ? 63 : 74);
  const crystal = _spireGeometry(2.5, 0.58, 6, rc, 81);
  _instanced(group, stone, course.id === 'cinder' ? dark : mid, _partTransforms(sites, 0, [0.76, 1.16, 0.76]), { name: `${course.id}-rock-spires`, cast: true, receive: true });
  _instanced(group, crystal, glow, _partTransforms(sites, 0, [0.68, 1.0, 0.68], (site) => site.seed % 3 === 0), { name: `${course.id}-glow-crystals`, cast: true });
}

function _buildAuthoredBiomeScatter(group, course, sites, dressingSites, assetLease) {
  const kit = AUTHORED_BIOME_PROPS[course.id] || AUTHORED_BIOME_PROPS.forest;
  let authoredCount = 0;
  for (let propIndex = 0; propIndex < kit.primary.length; propIndex++) {
    const name = kit.primary[propIndex];
    const sources = assetLease.getModelMeshes?.(name)
      || [assetLease.getModelMesh?.(name)].filter(Boolean);
    if (!sources.length) continue;
    const transforms = sites
      .filter((site, index) => index % kit.primary.length === propIndex)
      .map((site) => ({
        x: site.x,
        y: site.y - 0.06,
        z: site.z,
        yaw: site.yaw,
        scale: site.scale * (site.tier ? 1.08 : 0.92),
      }));
    let builtParts = 0;
    sources.forEach((source, partIndex) => {
      if (!source?.geometry || !source.material) return;
      if (_instanced(group, source.geometry, source.material, transforms, {
        name: `${course.id}-authored-${name}-part-${partIndex}`,
        cast: true,
        receive: true,
      })) builtParts += 1;
    });
    if (builtParts) authoredCount += transforms.length;
  }
  const accents = assetLease.getModelMeshes?.(kit.accent)
    || [assetLease.getModelMesh?.(kit.accent)].filter(Boolean);
  if (accents.length) {
    const accentTransforms = sites
      .filter((site) => site.tier === 0)
      .map((site, index) => ({
        x: site.x + Math.cos(site.yaw + 0.7) * (1.6 + (index % 3) * 0.45),
        y: site.y,
        z: site.z + Math.sin(site.yaw + 0.7) * (1.6 + (index % 3) * 0.45),
        yaw: site.yaw - 0.4,
        scale: site.scale * 0.9,
      }));
    accentTransforms.push(...dressingSites.map((site, index) => ({
      x: site.x + Math.cos(site.yaw) * ((index % 3) - 1) * 0.7,
      y: site.y,
      z: site.z + Math.sin(site.yaw) * ((index % 3) - 1) * 0.7,
      yaw: site.yaw,
      scale: site.scale * (course.id === 'forest' || course.id === 'twilight' ? 1.05 : 0.86),
    })));
    let builtParts = 0;
    accents.forEach((accent, partIndex) => {
      if (!accent?.geometry || !accent.material) return;
      if (_instanced(group, accent.geometry, accent.material, accentTransforms, {
        name: `${course.id}-authored-${kit.accent}-part-${partIndex}`,
        cast: course.id !== 'kakiland',
        receive: true,
      })) builtParts += 1;
    });
    if (builtParts) authoredCount += accentTransforms.length;
  }
  return authoredCount;
}

function _canvasGateTexture(course, rc) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const accent = `#${_hex(course.accent, 0xffffff).toString(16).padStart(6, '0')}`;
  const gradient = context.createLinearGradient(0, 0, 1024, 256);
  gradient.addColorStop(0, '#17121d');
  gradient.addColorStop(0.5, '#2c2031');
  gradient.addColorStop(1, '#17121d');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1024, 256);
  context.strokeStyle = accent;
  context.lineWidth = 20;
  context.strokeRect(10, 10, 1004, 236);
  context.textAlign = 'center';
  context.fillStyle = '#fff5dc';
  context.font = '900 82px Georgia, serif';
  context.fillText('KAKI RALLY', 512, 104);
  context.fillStyle = accent;
  context.font = '800 39px Arial, sans-serif';
  context.fillText(String(course.name || course.chapter || '').toUpperCase(), 512, 176);
  context.fillStyle = '#fff5dc';
  context.font = '700 20px Arial, sans-serif';
  context.fillText('COURAGE  •  CONTROL  •  CHAOS', 512, 217);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return rc.texture(texture);
}

function _canvasFinishTexture(course, rc) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const columns = 16;
  const rows = 2;
  const tileWidth = canvas.width / columns;
  const tileHeight = canvas.height / rows;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      context.fillStyle = (row + column) % 2 ? '#241d28' : '#fff3d2';
      context.fillRect(column * tileWidth, row * tileHeight, tileWidth + 1, tileHeight + 1);
    }
  }
  context.strokeStyle = `#${_hex(course.accent, 0xffffff).toString(16).padStart(6, '0')}`;
  context.lineWidth = 10;
  context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return rc.texture(texture);
}

function _buildInfrastructure(group, course, profile, samples, rc, env, atlasTexture) {
  const gate = new THREE.Group();
  gate.name = 'rally-ceremonial-start-gate';
  const archPoints = [
    new THREE.Vector3(-course.trackWidth * 0.62, 0, 0),
    new THREE.Vector3(-course.trackWidth * 0.59, 4.6, 0),
    new THREE.Vector3(-course.trackWidth * 0.35, 7.4, 0),
    new THREE.Vector3(0, 8.15, 0),
    new THREE.Vector3(course.trackWidth * 0.35, 7.4, 0),
    new THREE.Vector3(course.trackWidth * 0.59, 4.6, 0),
    new THREE.Vector3(course.trackWidth * 0.62, 0, 0),
  ];
  const archCurve = new THREE.CatmullRomCurve3(archPoints, false, 'centripetal', 0.5);
  const archGeometry = rc.geometry(new THREE.TubeGeometry(archCurve, 40, 0.28, 7, false));
  const archMaterial = _material(rc, { color: profile.pale, roughness: 0.38, metalness: 0.55 });
  const arch = _mesh(archGeometry, archMaterial, { cast: true });
  gate.add(arch);

  const signMaterial = _basicMaterial(rc, { map: _canvasGateTexture(course, rc), side: THREE.DoubleSide, toneMapped: false });
  const sign = _mesh(rc.geometry(new THREE.PlaneGeometry(Math.min(9.8, course.trackWidth * 0.72), 2.42)), signMaterial);
  sign.position.set(0, 6.4, -0.32);
  gate.add(sign);

  const ringGeometry = rc.geometry(new THREE.TorusGeometry(0.48, 0.11, 6, 20));
  const glowMaterial = _material(rc, {
    color: _hex(course.accent, profile.glow),
    emissive: _hex(course.accent, profile.glow),
    emissiveIntensity: 1.25,
    roughness: 0.32,
  });
  _registerGlow(env, glowMaterial);
  for (const x of [-course.trackWidth * 0.48, course.trackWidth * 0.48]) {
    const beacon = _mesh(ringGeometry, glowMaterial);
    beacon.position.set(x, 4.95, -0.2);
    beacon.rotation.y = Math.PI * 0.5;
    gate.add(beacon);
  }
  _placeObject(gate, samples[0], 0, 0.08);
  group.add(gate);

  const finishMaterial = _basicMaterial(rc, {
    map: _canvasFinishTexture(course, rc),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const finish = _mesh(rc.geometry(new THREE.PlaneGeometry(course.trackWidth, 1.35)), finishMaterial);
  finish.name = 'rally-checkered-finish-line';
  finish.rotation.x = -Math.PI * 0.5;
  _placeObject(finish, samples[0], 0, 0.125);
  group.add(finish);

  const sponsorGeometry = rc.geometry(new THREE.PlaneGeometry(5.2, 3.25));
  const sponsorMaterial = _basicMaterial(rc, {
    map: atlasTexture,
    color: 0xffffff,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const frameGeometry = rc.geometry(new THREE.TorusGeometry(2.95, 0.13, 6, 24, Math.PI));
  const sponsorIndices = [0.12, 0.43, 0.71].map((fraction) => Math.floor(samples.length * fraction) % samples.length);
  for (let i = 0; i < sponsorIndices.length; i++) {
    const sample = samples[sponsorIndices[i]];
    const side = i % 2 ? 1 : -1;
    const candidateSides = [side, -side];
    const lateral = course.trackWidth * 0.5 + 8.2;
    const placement = candidateSides
      .map((candidateSide) => ({
        side: candidateSide,
        x: sample.x + sample.normal.x * candidateSide * lateral,
        z: sample.z + sample.normal.z * candidateSide * lateral,
      }))
      .find((candidate) => _acceptTracksideSite(candidate, course, samples, 3.2));
    if (!placement) continue;
    const board = new THREE.Group();
    board.name = 'rally-decal-atlas-board';
    const panel = _mesh(sponsorGeometry, sponsorMaterial);
    panel.position.y = 2.25;
    board.add(panel);
    const frame = _mesh(frameGeometry, archMaterial, { cast: true });
    frame.position.y = 0.65;
    board.add(frame);
    _placeObject(board, sample, placement.side * lateral, 0);
    board.rotation.y += placement.side < 0 ? Math.PI : 0;
    group.add(board);
  }

  // Removed the old four wedge-shaped spectator stands. Their oversized,
  // unoccupied silhouettes looked like stray blocks in the isometric view;
  // authored trees, rockwork and sponsor boards now dress those sightlines.
}

/** Returns a clone-safe lighting/fog descriptor for the current chapter. */
export function getRallyLightingProfile(courseOrId) {
  const id = typeof courseOrId === 'string' ? courseOrId : courseOrId?.id;
  const source = RALLY_ENVIRONMENT_PROFILES[id] || RALLY_ENVIRONMENT_PROFILES.forest;
  return {
    background: source.sky,
    fogColor: source.horizon,
    fogNear: source.fogNear,
    fogFar: source.fogFar,
    hemisphere: { ...source.hemisphere },
    key: { ...source.key, position: [...source.key.position] },
  };
}

/**
 * Builds the presentation layer around an existing sampled race course.
 *
 * `atlasTexture` may be supplied by the caller and remains caller-owned. When
 * omitted, the bundled ImageGen decal atlas is loaded and owned by this module.
 */
export function buildRallyEnvironment({
  root,
  course,
  samples,
  ownedGeometries,
  ownedMaterials,
  ownedTextures,
  mode = course?.mode || 'circuit',
  atlasTexture = null,
  assetLease = null,
  textureResolver = null,
  anisotropy = 4,
} = {}) {
  if (!root?.add) throw new TypeError('buildRallyEnvironment requires a Three.js root group');
  if (!course?.id) throw new TypeError('buildRallyEnvironment requires a course definition');
  if (!Array.isArray(samples) || samples.length < 8) throw new TypeError('buildRallyEnvironment requires sampled track points');

  const rc = _makeResourceContext({
    geometries: ownedGeometries,
    materials: ownedMaterials,
    textures: ownedTextures,
  }, textureResolver);
  const group = new THREE.Group();
  group.name = `kaki-rally-environment-${course.id}-${mode}`;
  group.userData.presentationOnly = true;
  root.add(group);

  const profile = _profileFor(course);
  const bounds = _courseBounds(samples);
  const env = {
    group,
    courseId: course.id,
    mode,
    profile,
    lighting: getRallyLightingProfile(course),
    bounds,
    resources: rc.resources,
    externalSets: { geometries: ownedGeometries, materials: ownedMaterials, textures: ownedTextures },
    glowMaterials: [],
    animatedObjects: [],
    sky: null,
    elapsed: 0,
    disposed: false,
    authoredReady: false,
    authoredScatter: null,
  };

  const decalAtlas = atlasTexture || _loadTexture('racing/kaki-rally-decal-atlas-imagegen-v1.webp', rc, { anisotropy });
  if (decalAtlas) {
    decalAtlas.wrapS = decalAtlas.wrapT = THREE.ClampToEdgeWrapping;
    decalAtlas.repeat.set(1, 1);
  }

  _buildSky(group, course, profile, bounds, rc, env, anisotropy);
  _buildGround(group, course, profile, bounds, samples, rc, anisotropy);
  _buildTrackLayers(group, course, profile, samples, rc, anisotropy);
  _buildCurbsAndRails(group, course, profile, samples, rc);
  const scenerySites = _makeScatterSites(course, samples);
  const dressingSites = _makeDressingSites(course, samples);
  env.sceneryLayout = {
    primary: scenerySites,
    dressing: dressingSites,
  };
  const fallbackScatter = new THREE.Group();
  fallbackScatter.name = `${course.id}-procedural-scatter-fallback`;
  group.add(fallbackScatter);
  _buildBiomeScatter(fallbackScatter, course, profile, scenerySites, rc, env);
  // The previous ring of oversized procedural spires read as isolated blocks
  // from the isometric camera. The expanded sculpted terrain and authored kit
  // now carry the horizon without that placeholder-looking silhouette.
  // Biome identity now comes from the authored Blender kit. The former giant
  // procedural landmark used scaled primitives that read as floating blocks
  // from the top-down camera.
  _buildInfrastructure(group, course, profile, samples, rc, env, decalAtlas);

  if (assetLease?.ready) {
    assetLease.ready.then(() => {
      if (env.disposed) return;
      const authored = new THREE.Group();
      authored.name = `${course.id}-authored-environment-kit-v2`;
      const count = _buildAuthoredBiomeScatter(authored, course, scenerySites, dressingSites, assetLease);
      if (count > 0) {
        group.add(authored);
        fallbackScatter.visible = false;
        env.authoredScatter = authored;
        env.authoredReady = true;
      }
    }).catch(() => {});
  }

  return env;
}

/** Performs subtle ambient motion without creating per-frame objects. */
export function updateRallyEnvironment(env, time, dt = 0) {
  if (!env || env.disposed) return;
  env.elapsed = Number.isFinite(time) ? time : env.elapsed + Math.max(0, dt);
  const t = env.elapsed;
  for (let i = 0; i < env.glowMaterials.length; i++) {
    const material = env.glowMaterials[i];
    const base = material.userData.rallyBaseEmissiveIntensity ?? 1;
    material.emissiveIntensity = base * (0.92 + Math.sin(t * 1.8 + i * 1.37) * 0.12);
  }
  for (let i = 0; i < env.animatedObjects.length; i++) {
    const animated = env.animatedObjects[i];
    const object = animated.object;
    if (animated.spin) object.rotation.y += animated.spin * dt;
    if (animated.amplitude) object.position.y = (animated.baseY || 0) + Math.sin(t * 1.15 + animated.phase) * animated.amplitude;
  }
}

/**
 * Keep the finite sky mesh centered on the active camera without inheriting
 * camera rotation. Translation then behaves like an infinitely distant sky,
 * while yaw still reveals the correct world direction and authored clouds no
 * longer drift on their own.
 */
export function syncRallySkyToCamera(env, camera) {
  if (!env?.sky || env.disposed || !camera?.position || !env.group) return;
  env.group.updateWorldMatrix?.(true, false);
  _skyAnchor.copy(camera.position);
  env.group.worldToLocal(_skyAnchor);
  env.sky.position.x = _skyAnchor.x;
  env.sky.position.z = _skyAnchor.z;
}

/**
 * Removes the environment and disposes only resources created by this module.
 * Caller-owned atlas textures are never registered here and are therefore safe.
 */
export function disposeRallyEnvironment(env) {
  if (!env || env.disposed) return;
  env.disposed = true;
  env.group?.removeFromParent();
  for (const type of ['geometries', 'materials', 'textures']) {
    const resources = env.resources[type];
    const external = env.externalSets[type];
    for (let i = 0; i < resources.length; i++) {
      resources[i]?.dispose?.();
      external?.delete(resources[i]);
    }
    resources.length = 0;
  }
  env.glowMaterials.length = 0;
  env.animatedObjects.length = 0;
}
