/**
 * Presentation-only world building for Kaki Trials.
 *
 * The authored height field in trialsTracks.js remains the sole source of
 * contact truth. Everything in this module samples that field and renders
 * around it; no course arrays, gaps, obstacle data, scoring, or physics state
 * are modified here.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { sampleTrialsGround } from './trialsTracks.js';

const TAU = Math.PI * 2;
const SURFACE_DEPTH = 8.8;
const TEMP_OBJECT = new THREE.Object3D();
const TEMP_MATRIX = new THREE.Matrix4();
const TEMP_POSITION = new THREE.Vector3();
const TEMP_SCALE = new THREE.Vector3();
const TEMP_QUATERNION = new THREE.Quaternion();
const TEMP_DIRECTION = new THREE.Vector3();
const BACKDROP_ASPECT = 16 / 9;
const BACKDROP_OVERSCAN = 1.12;
const BACKDROP_Z = -54.5;
const BACKDROP_CAMERA_DISTANCE = 140;

export const TRIALS_WORLD_PROFILES = Object.freeze({
  meadow: Object.freeze({
    skyTexture: '../../assets/textures/sky_midday.webp',
    backdropTexture: '../../assets/racing/backdrops-v2/trials-meadow-backdrop.webp',
    detailTexture: '../../assets/racing/terrain-v2/forest-ground-color.webp',
    normalTexture: '../../assets/racing/terrain-v2/forest-ground-normal.webp',
    roughnessTexture: '../../assets/racing/terrain-v2/forest-ground-roughness.webp',
    skyTop: 0x82d9ff,
    skyTint: 0xc2e9ff,
    horizon: 0xffe2ef,
    fog: 0xd8edf0,
    fogNear: 74,
    fogFar: 268,
    sun: 0xfff2b2,
    key: 0xfff0cb,
    fill: 0xc9f2ff,
    earth: 0x9c694f,
    earthDark: 0x69483f,
    trail: 0xc89468,
    shoulder: 0xffd983,
    landmark: 0xf36f9e,
  }),
  quarry: Object.freeze({
    skyTexture: '../../assets/textures/sky_golden.webp',
    backdropTexture: '../../assets/racing/backdrops-v2/trials-quarry-backdrop.webp',
    detailTexture: '../../assets/racing/terrain-v2/cave-ground-color.webp',
    normalTexture: '../../assets/racing/terrain-v2/cave-ground-normal.webp',
    roughnessTexture: '../../assets/racing/terrain-v2/cave-ground-roughness.webp',
    skyTop: 0xaac7d8,
    skyTint: 0xcadce6,
    horizon: 0xe7c2ac,
    fog: 0xb9b3aa,
    fogNear: 76,
    fogFar: 252,
    sun: 0xffd19c,
    key: 0xffd6ab,
    fill: 0xbfe8e5,
    earth: 0x746c65,
    earthDark: 0x3d3c42,
    trail: 0x9e795f,
    shoulder: 0x61d9c1,
    landmark: 0xf8a84e,
  }),
  crown: Object.freeze({
    skyTexture: '../../assets/kakiland/kaki-land-sky-gpt-v2.png',
    backdropTexture: '../../assets/racing/backdrops-v2/trials-crown-backdrop-v2.webp',
    detailTexture: '../../assets/racing/terrain-v2/kakiland-ground-color.webp',
    normalTexture: '../../assets/racing/terrain-v2/kakiland-ground-normal.webp',
    roughnessTexture: '../../assets/racing/terrain-v2/kakiland-ground-roughness.webp',
    skyTop: 0x85ceff,
    skyTint: 0xd5e8ff,
    horizon: 0xffcde8,
    fog: 0xe8d9ef,
    fogNear: 80,
    fogFar: 282,
    sun: 0xfff4c8,
    key: 0xffe5cf,
    fill: 0xd9d0ff,
    earth: 0x8f7aae,
    earthDark: 0x554c78,
    trail: 0xe7bc8e,
    shoulder: 0xff67b7,
    landmark: 0xffd754,
  }),
});

function _profile(track) {
  return TRIALS_WORLD_PROFILES[track?.id] || TRIALS_WORLD_PROFILES.meadow;
}

function _hash(seed) {
  const value = Math.sin(seed * 91.733 + 17.113) * 43758.5453;
  return value - Math.floor(value);
}

function _ownedSets(session) {
  if (!session.owned) session.owned = {};
  const owned = session.owned;
  owned.geometries ||= session.ownedGeometries || new Set();
  owned.materials ||= session.ownedMaterials || new Set();
  owned.textures ||= session.ownedTextures || new Set();
  return owned;
}

function _ownGeometry(session, geometry) {
  _ownedSets(session).geometries.add(geometry);
  return geometry;
}

function _ownMaterial(session, material) {
  const bucket = _ownedSets(session).materials;
  if (Array.isArray(material)) material.forEach((entry) => bucket.add(entry));
  else bucket.add(material);
  return material;
}

function _ownTexture(session, texture) {
  _ownedSets(session).textures.add(texture);
  return texture;
}

function _standard(session, options) {
  return _ownMaterial(session, new THREE.MeshStandardMaterial(options));
}

function _basic(session, options) {
  return _ownMaterial(session, new THREE.MeshBasicMaterial(options));
}

function _mesh(session, geometry, material, name) {
  const mesh = new THREE.Mesh(_ownGeometry(session, geometry), material);
  mesh.name = name;
  mesh.userData.presentationOnly = true;
  return mesh;
}

function _instanced(session, geometry, material, count, name) {
  const mesh = new THREE.InstancedMesh(_ownGeometry(session, geometry), material, count);
  mesh.name = name;
  mesh.userData.presentationOnly = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return mesh;
}

function _instancedFromModel(source, count, name) {
  if (!source?.geometry || !source.material || count <= 0) return null;
  const mesh = new THREE.InstancedMesh(source.geometry, source.material, count);
  mesh.name = name;
  mesh.userData.presentationOnly = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function _texture(session, relativePath, { repeat = null, srgb = true } = {}) {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([255, 255, 255, 255]);
    const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return _ownTexture(session, texture);
  }
  const url = new URL(relativePath, import.meta.url).href;
  const leased = session.assetLease?.getTextureByUrl?.(relativePath)
    || session.assetLease?.getTextureByUrl?.(url)
    || null;
  const texture = leased || _ownTexture(session, new THREE.TextureLoader().load(url));
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
  }
  texture.anisotropy = 4;
  return texture;
}

function _gradientTexture(session, top, bottom, accent) {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([255, 255, 255, 255]);
    const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return _ownTexture(session, texture);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `#${new THREE.Color(top).getHexString()}`);
  gradient.addColorStop(0.68, `#${new THREE.Color(bottom).getHexString()}`);
  gradient.addColorStop(1, `#${new THREE.Color(accent).getHexString()}`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return _ownTexture(session, texture);
}

function _cutawayTexture(session, track, profile) {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([128, 112, 104, 255]);
    const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return _ownTexture(session, texture);
  }
  const palettes = {
    meadow: ['#4c332f', '#79503f', '#a87550', '#d1a46c'],
    quarry: ['#252b36', '#424b58', '#596b72', '#887970'],
    crown: ['#3d345d', '#655080', '#8d668f', '#b6769b'],
  };
  const colors = palettes[track.id];
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  let seed = track.id === 'meadow' ? 771 : track.id === 'quarry' ? 1193 : 1877;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let layer = 0; layer < 11; layer++) {
    const baseY = 28 + layer * 44 + (random() - 0.5) * 14;
    context.beginPath();
    for (let x = -32; x <= canvas.width + 32; x += 32) {
      const y = baseY
        + Math.sin(x * 0.014 + layer * 1.7) * (5 + layer * 0.32)
        + (random() - 0.5) * 7;
      if (x < 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = `${colors[(layer + 1) % colors.length]}b8`;
    context.lineWidth = 20 + (layer % 3) * 8;
    context.stroke();
    context.strokeStyle = `${colors[(layer + 2) % colors.length]}8a`;
    context.lineWidth = 3 + (layer % 2) * 2;
    context.stroke();
  }

  for (let index = 0; index < 340; index++) {
    const x = random() * canvas.width;
    const y = 18 + random() * (canvas.height - 26);
    const size = 0.8 + random() * (track.id === 'quarry' ? 7.4 : 4.8);
    context.save();
    context.translate(x, y);
    context.rotate(random() * TAU);
    context.fillStyle = `${colors[Math.floor(random() * colors.length)]}${track.id === 'crown' ? 'b8' : '92'}`;
    context.beginPath();
    context.ellipse(0, 0, size * (1.2 + random()), size * (0.45 + random() * 0.45), 0, 0, TAU);
    context.fill();
    context.restore();
  }

  context.strokeStyle = `#${new THREE.Color(profile.shoulder).getHexString()}6b`;
  context.lineWidth = track.id === 'quarry' ? 2.2 : 1.4;
  for (let vein = 0; vein < 18; vein++) {
    let x = random() * canvas.width;
    let y = 60 + random() * 390;
    context.beginPath();
    context.moveTo(x, y);
    for (let segment = 0; segment < 5; segment++) {
      x += (random() - 0.35) * 30;
      y += 7 + random() * 18;
      context.lineTo(x, y);
    }
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(0.26, 1);
  texture.anisotropy = 4;
  return _ownTexture(session, texture);
}

function _terrainRanges(track) {
  const ranges = [];
  let start = 0;
  for (const gap of track.gaps) {
    ranges.push([start, Math.max(start, gap.start - 0.02)]);
    start = Math.min(track.length, gap.end + 0.02);
  }
  if (start < track.length) ranges.push([start, track.length]);
  return ranges.filter(([a, b]) => b - a > 0.1);
}

function _sampleRange(track, start, end, spacing = 1.8) {
  const points = [];
  for (let x = start; x < end; x += spacing) {
    const ground = sampleTrialsGround(track, x);
    if (ground) points.push({ x, y: ground.height });
  }
  const last = sampleTrialsGround(track, end);
  if (last) points.push({ x: end, y: last.height });
  return points;
}

function _stripGeometry(points, zMin, zMax, lift = 0) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (const point of points) {
    positions.push(point.x, point.y + lift, zMin, point.x, point.y + lift, zMax);
    uvs.push(point.x / 12, 0, point.x / 12, 1);
  }
  for (let index = 0; index < points.length - 1; index++) {
    const a = index * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function _sideRibbonGeometry(points, drop, thickness, z = SURFACE_DEPTH * 0.5 + 0.035) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (const point of points) {
    positions.push(point.x, point.y - drop, z, point.x, point.y - drop - thickness, z);
    uvs.push(point.x / 18, 0, point.x / 18, 1);
  }
  for (let index = 0; index < points.length - 1; index++) {
    const a = index * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function _strataRibbonGeometry(points, drop, thickness, band) {
  const amplitude = 0.16 + (band % 3) * 0.07;
  const sculpted = points.map((point) => ({
    x: point.x,
    y: point.y
      + Math.sin(point.x * 0.055 + band * 1.71) * amplitude
      + Math.sin(point.x * 0.137 - band * 0.93) * 0.08,
  }));
  return _sideRibbonGeometry(sculpted, drop, thickness, SURFACE_DEPTH * 0.5 + 0.14);
}

function _makeTerrainMaterials(session, profile, track) {
  const detail = _texture(session, profile.detailTexture, { repeat: [3.8, 2.4] });
  const normal = _texture(session, profile.normalTexture, { repeat: [3.8, 2.4], srgb: false });
  const roughness = _texture(session, profile.roughnessTexture, { repeat: [3.8, 2.4], srgb: false });
  const cutawayMap = _cutawayTexture(session, track, profile);
  const earth = _standard(session, {
    color: new THREE.Color(profile.earth).lerp(new THREE.Color(0xffffff), 0.58),
    map: detail,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: roughness,
    roughness: 0.98,
    metalness: 0,
  });
  const turf = _standard(session, {
    color: new THREE.Color(track.colors.ground).lerp(new THREE.Color(0xffffff), 0.64),
    map: detail,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughnessMap: roughness,
    roughness: 0.9,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const trail = _standard(session, {
    color: new THREE.Color(profile.trail).lerp(new THREE.Color(0xffffff), 0.5),
    map: detail,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.32, 0.32),
    roughnessMap: roughness,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const shoulder = _standard(session, {
    color: profile.shoulder,
    emissive: profile.shoulder,
    emissiveIntensity: track.id === 'quarry' ? 0.16 : 0.055,
    roughness: 0.78,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const cutaway = _basic(session, { color: 0xffffff, map: cutawayMap, side: THREE.DoubleSide });
  const bandPalettes = {
    meadow: [0xd6a46a, 0x725044, 0xb97b53],
    quarry: [0x9cb4ba, 0x547c7c, 0xb19982],
    crown: [0xe494bd, 0x76609a, 0x70a080],
  };
  const strataBands = bandPalettes[track.id].map((color, index) => _standard(session, {
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.14),
    emissiveIntensity: index === 0 ? 0.1 : 0.04,
    roughness: 0.88,
    side: THREE.DoubleSide,
  }));
  const inclusion = _standard(session, {
    color: track.id === 'quarry' ? 0x27333d : track.id === 'crown' ? 0xf0acd2 : 0x49342f,
    emissive: track.id === 'crown' ? 0x7d335d : 0x000000,
    emissiveIntensity: track.id === 'crown' ? 0.16 : 0,
    roughness: 0.88,
    side: THREE.DoubleSide,
  });
  return { earth, turf, trail, shoulder, cutaway, strataBands, inclusion };
}

function _addCutawayInclusions(session, points, rangeIndex, materials) {
  const placements = [];
  for (let index = 6; index < points.length - 4; index += 9) {
    const point = points[index];
    const seed = rangeIndex * 97 + index;
    placements.push({
      x: point.x + (_hash(seed + 4) - 0.5) * 6,
      y: point.y - 3.4 - _hash(seed + 9) * 17.5,
      scale: 0.3 + _hash(seed + 13) * 0.7,
      rotation: _hash(seed + 17) * TAU,
    });
  }
  if (!placements.length) return;
  const inclusions = _instanced(
    session,
    new THREE.CircleGeometry(1, 7),
    materials.inclusion,
    placements.length,
    `trials-cutaway-inclusions-${rangeIndex}`,
  );
  placements.forEach((item, index) => {
    _setInstance(
      inclusions,
      index,
      item.x,
      item.y,
      SURFACE_DEPTH * 0.5 + 0.18,
      item.scale * 1.45,
      item.scale * 0.7,
      1,
      item.rotation,
    );
  });
  inclusions.instanceMatrix.needsUpdate = true;
  session.root.add(inclusions);
}

function _buildTerrain(session, world, profile) {
  const { track, root } = session;
  const minimum = Math.min(...track.heightPoints.map((point) => point.y));
  const baseline = minimum - (track.id === 'crown' ? 28 : 23);
  const materials = _makeTerrainMaterials(session, profile, track);

  for (const [rangeIndex, [start, end]] of _terrainRanges(track).entries()) {
    const points = _sampleRange(track, start, end);
    if (points.length < 2) continue;
    if (start <= 0.001) points.unshift({ x: -80, y: points[0].y });
    if (end >= track.length - 0.001) points.push({ x: track.length + 80, y: points[points.length - 1].y });

    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, baseline);
    shape.lineTo(points[0].x, points[0].y - 0.12);
    for (let index = 1; index < points.length; index++) {
      shape.lineTo(points[index].x, points[index].y - 0.12);
    }
    shape.lineTo(points[points.length - 1].x, baseline);
    shape.closePath();
    const bodyGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: SURFACE_DEPTH,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelSize: 0.1,
      bevelThickness: 0.08,
      curveSegments: 1,
      steps: 1,
    });
    bodyGeometry.translate(0, 0, -SURFACE_DEPTH * 0.5);
    const body = _mesh(session, bodyGeometry, materials.earth, `trials-terrain-mass-${rangeIndex}`);
    body.receiveShadow = true;
    root.add(body);

    const cutawayDepth = Math.max(...points.map((point) => point.y - baseline)) + 2.5;
    const cutaway = _mesh(
      session,
      _sideRibbonGeometry(points, 0.62, cutawayDepth, SURFACE_DEPTH * 0.5 + 0.12),
      materials.cutaway,
      `trials-cutaway-art-${rangeIndex}`,
    );
    cutaway.castShadow = false;
    root.add(cutaway);

    const turf = _mesh(session, _stripGeometry(points, -4.38, 4.38, 0.035), materials.turf, `trials-turf-crown-${rangeIndex}`);
    turf.receiveShadow = true;
    root.add(turf);

    const trail = _mesh(session, _stripGeometry(points, -2.75, 2.75, 0.072), materials.trail, `trials-readable-line-${rangeIndex}`);
    trail.receiveShadow = true;
    root.add(trail);

    for (const [sideIndex, [zMin, zMax]] of [[-3.35, -2.9], [2.9, 3.35]].entries()) {
      const shoulder = _mesh(
        session,
        _stripGeometry(points, zMin, zMax, 0.092),
        materials.shoulder,
        `trials-shoulder-${rangeIndex}-${sideIndex}`,
      );
      root.add(shoulder);
    }

    const bandCount = track.id === 'crown' ? 9 : 8;
    for (let band = 0; band < bandCount; band++) {
      const drop = 1.25 + band * 2.8;
      const thickness = 0.12 + (band % 3) * 0.055;
      const fascia = _mesh(
        session,
        _strataRibbonGeometry(points, drop, thickness, band),
        materials.strataBands[band % materials.strataBands.length],
        `trials-strata-${rangeIndex}-${band}`,
      );
      fascia.castShadow = false;
      root.add(fascia);
    }
    _addCutawayInclusions(session, points, rangeIndex, materials);
  }

  session.terrainBaseline = baseline;
  world.baseline = baseline;
  world.materials = materials;
  _buildGapAtmosphere(session, world, profile);
}

function _waveRibbonGeometry(start, end, y, width = 0.16, phase = 0) {
  const segments = Math.max(8, Math.ceil((end - start) / 1.5));
  const points = [];
  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    points.push({ x: THREE.MathUtils.lerp(start, end, t), y: y + Math.sin(t * TAU * 2 + phase) * 0.22 });
  }
  return _sideRibbonGeometry(points, 0, width, 3.7);
}

function _buildGapAtmosphere(session, world, profile) {
  const { track, root } = session;
  const color = track.id === 'meadow' ? 0x6fe4f0 : track.id === 'crown' ? 0xffd9f6 : 0x4de0bd;
  const ribbonMaterial = _basic(session, {
    color,
    transparent: true,
    opacity: track.id === 'quarry' ? 0.42 : 0.68,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  for (const [gapIndex, gap] of track.gaps.entries()) {
    const inset = Math.min(2.5, (gap.end - gap.start) * 0.1);
    for (let layer = 0; layer < 3; layer++) {
      const ribbon = _mesh(
        session,
        _waveRibbonGeometry(gap.start + inset, gap.end - inset, world.baseline + 3.2 + layer * 1.1, 0.14, layer * 1.7),
        ribbonMaterial,
        `trials-gap-glimmer-${gapIndex}-${layer}`,
      );
      ribbon.userData.wavePhase = gapIndex * 0.8 + layer * 1.7;
      ribbon.userData.baseOpacity = ribbonMaterial.opacity;
      root.add(ribbon);
      world.waveRibbons.push(ribbon);
    }
  }
}

function _addLighting(session, world, profile) {
  const group = new THREE.Group();
  group.name = 'trials-studio-lighting';
  group.userData.presentationOnly = true;
  const hemisphere = new THREE.HemisphereLight(profile.fill, session.track.colors.shadow, 1.18);
  hemisphere.name = 'trials-sky-fill';
  const key = new THREE.DirectionalLight(profile.key, 2.35);
  key.name = 'trials-key-light';
  key.position.set(session.track.length * 0.34, 82, 42);
  const rim = new THREE.DirectionalLight(session.track.colors.accent, 0.46);
  rim.name = 'trials-rim-light';
  rim.position.set(session.track.length * 0.64, 22, -34);
  group.add(hemisphere, key, rim);
  session.root.add(group);
  world.lighting = { group, hemisphere, key, rim };
}

function _addSky(session, world, profile) {
  const { track, root } = session;
  if (session.scene) {
    session.scene.background = new THREE.Color(profile.skyTop);
    session.scene.fog = new THREE.Fog(profile.fog, profile.fogNear, profile.fogFar);
  }

  const width = track.length + 280;
  const paintedSky = _texture(session, profile.skyTexture);
  paintedSky.wrapS = THREE.MirroredRepeatWrapping;
  paintedSky.repeat.set(Math.max(1, Math.ceil(width / 760)), 1);
  const skyMaterial = _basic(session, {
    color: profile.skyTint,
    map: paintedSky,
    fog: false,
    depthWrite: false,
    depthTest: false,
  });
  const sky = _mesh(session, new THREE.PlaneGeometry(width, 190), skyMaterial, 'trials-painted-sky');
  sky.position.set(track.length * 0.5, world.baseline + 68, -61);
  sky.renderOrder = -100;
  root.add(sky);
  world.skyTexture = paintedSky;

  const backdropTexture = _texture(session, profile.backdropTexture);
  const backdropMaterial = _basic(session, {
    color: 0xffffff,
    map: backdropTexture,
    fog: false,
    depthWrite: false,
    depthTest: false,
  });
  const backdrop = _mesh(
    session,
    // A 16:9 unit plate is scaled by _fitBackdropToCamera. The old fixed
    // 58x32.625 plate could not cover the speed zoom + look-ahead framing on
    // wide viewports, exposing its hard right and bottom edges.
    new THREE.PlaneGeometry(16, 9),
    backdropMaterial,
    `trials-${track.id}-authored-backdrop-v2`,
  );
  backdrop.position.set(session.physics?.x || 0, (session.physics?.y || 0) + 3, BACKDROP_Z);
  backdrop.scale.setScalar(7);
  backdrop.renderOrder = -84;
  backdrop.frustumCulled = false;
  root.add(backdrop);
  world.backdrop = backdrop;
  world.backdropTexture = backdropTexture;

  const horizonTexture = _gradientTexture(session, profile.skyTop, profile.horizon, profile.fog);
  const horizonMaterial = _basic(session, {
    color: 0xffffff,
    map: horizonTexture,
    transparent: true,
    opacity: 0.16,
    fog: false,
    depthWrite: false,
  });
  const horizon = _mesh(session, new THREE.PlaneGeometry(width, 62), horizonMaterial, 'trials-horizon-gradient');
  horizon.position.set(track.length * 0.5, world.baseline + 22, -56);
  horizon.renderOrder = -90;
  root.add(horizon);

  const sunMaterial = _basic(session, {
    color: profile.sun,
    transparent: true,
    opacity: 0.92,
    fog: false,
    depthWrite: false,
  });
  const haloMaterial = _basic(session, {
    color: profile.sun,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    fog: false,
    depthWrite: false,
  });
  const sun = _mesh(session, new THREE.CircleGeometry(track.id === 'crown' ? 10 : 8, 32), sunMaterial, 'trials-sun-disc');
  sun.position.set(track.length * 0.72, world.baseline + 67, -53.5);
  sun.renderOrder = -80;
  const halo = _mesh(session, new THREE.CircleGeometry(track.id === 'crown' ? 17 : 14, 32), haloMaterial, 'trials-sun-halo');
  halo.position.copy(sun.position);
  halo.position.z -= 0.1;
  halo.renderOrder = -81;
  root.add(halo, sun);
  world.sun = sun;
  world.sunHalo = halo;
}

/**
 * Treat the authored plate like CSS `background-size: cover` in world space.
 *
 * The Trials camera zooms out with speed/air time and looks ahead of the
 * vehicle. Anchoring a barely-oversized plate to physics therefore lets the
 * camera outrun it. Instead, billboard the plate to the live camera and size
 * it from the orthographic frustum. A little overscan absorbs roll/shake and
 * non-16:9 viewports. The plate stays presentation-only: authored 3D terrain
 * and silhouettes render over it normally.
 */
function _fitBackdropToCamera(session, world) {
  const backdrop = world?.backdrop;
  const camera = state.camera;
  if (!backdrop || !camera?.isOrthographicCamera || !session?.root) return;

  camera.updateMatrixWorld?.();
  session.root.updateWorldMatrix?.(true, false);
  camera.getWorldDirection(TEMP_DIRECTION);
  TEMP_POSITION.copy(camera.position).addScaledVector(TEMP_DIRECTION, BACKDROP_CAMERA_DISTANCE);
  session.root.worldToLocal(TEMP_POSITION);
  backdrop.position.copy(TEMP_POSITION);
  camera.getWorldQuaternion(TEMP_QUATERNION);
  backdrop.quaternion.copy(TEMP_QUATERNION);

  const viewWidth = Math.abs(camera.right - camera.left);
  const viewHeight = Math.abs(camera.top - camera.bottom);
  const coverHeight = Math.max(viewHeight, viewWidth / BACKDROP_ASPECT) * BACKDROP_OVERSCAN;
  backdrop.scale.setScalar(coverHeight / 9);
}

function _setInstance(mesh, index, x, y, z, sx, sy, sz, rotationZ = 0, rotationY = 0) {
  TEMP_OBJECT.position.set(x, y, z);
  TEMP_OBJECT.rotation.set(0, rotationY, rotationZ);
  TEMP_OBJECT.scale.set(sx, sy, sz);
  TEMP_OBJECT.updateMatrix();
  mesh.setMatrixAt(index, TEMP_OBJECT.matrix);
}

function _addClouds(session, world) {
  const { track, root } = session;
  const cloudCount = Math.ceil((track.length + 150) / 92);
  const puffCount = cloudCount * 4;
  const material = _basic(session, {
    color: track.id === 'quarry' ? 0xe9eef0 : 0xfffbff,
    transparent: true,
    opacity: track.id === 'quarry' ? 0.48 : 0.76,
    fog: false,
    depthWrite: false,
  });
  const puffs = _instanced(session, new THREE.SphereGeometry(1, 12, 8), material, puffCount, 'trials-cloud-bank');
  puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  puffs.frustumCulled = false;
  for (let cloud = 0; cloud < cloudCount; cloud++) {
    const centerX = -24 + cloud * 92 + _hash(cloud + 3) * 26;
    const centerY = world.baseline + (track.id === 'crown' ? 42 : 34) + _hash(cloud + 24) * 12;
    const speed = 0.32 + _hash(cloud + 8) * 0.48;
    const z = -45 + (cloud % 3) * 3.5;
    const pattern = [
      [-3.5, 0, 3.0, 1.35],
      [-0.7, 1.25, 3.8, 1.75],
      [2.6, 0.3, 3.2, 1.42],
      [0.1, -0.35, 4.4, 1.15],
    ];
    for (let puff = 0; puff < pattern.length; puff++) {
      const [dx, dy, sx, sy] = pattern[puff];
      world.cloudPuffs.push({
        baseX: centerX,
        baseY: centerY,
        dx,
        dy,
        sx,
        sy,
        z,
        speed,
        phase: cloud * 0.73,
      });
    }
  }
  root.add(puffs);
  world.cloudMesh = puffs;
  session.clouds = [];
}

function _catPennantGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.82, -0.72);
  shape.quadraticCurveTo(-1.08, -0.1, -0.72, 0.46);
  shape.lineTo(-0.8, 1.08);
  shape.lineTo(-0.22, 0.68);
  shape.quadraticCurveTo(0, 0.76, 0.22, 0.68);
  shape.lineTo(0.8, 1.08);
  shape.lineTo(0.72, 0.46);
  shape.quadraticCurveTo(1.08, -0.1, 0.82, -0.72);
  shape.quadraticCurveTo(0, -1.08, -0.82, -0.72);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 2);
}

function _addCatPennants(session, world, color) {
  const placements = [];
  for (let x = 18, index = 0; x < session.track.length; x += 48, index++) {
    const ground = sampleTrialsGround(session.track, x);
    if (!ground) continue;
    placements.push({ x, y: ground.height, index });
  }
  if (!placements.length) return;
  const poleMaterial = _standard(session, { color: 0x563f55, roughness: 0.9 });
  const flagMaterial = _standard(session, {
    color,
    emissive: color,
    emissiveIntensity: 0.08,
    roughness: 0.72,
    side: THREE.DoubleSide,
  });
  const poles = _instanced(session, new THREE.CylinderGeometry(0.055, 0.075, 2.8, 7), poleMaterial, placements.length, 'trials-pennant-poles');
  const flags = _instanced(session, _catPennantGeometry(), flagMaterial, placements.length, 'trials-cat-pennants');
  for (let index = 0; index < placements.length; index++) {
    const item = placements[index];
    const side = index % 2 ? -1 : 1;
    _setInstance(poles, index, item.x, item.y + 1.4, side * 4.62, 1, 1.18, 1);
    _setInstance(flags, index, item.x, item.y + 3.62, side * 4.57, 0.86, 0.86, 0.86, side * 0.05);
  }
  poles.instanceMatrix.needsUpdate = true;
  flags.instanceMatrix.needsUpdate = true;
  poles.castShadow = true;
  flags.castShadow = true;
  session.root.add(poles, flags);
  world.pennants = flags;
}

function _addMeadowStory(session, world, profile) {
  const { track, root } = session;
  const flowerData = [];
  for (let x = 6, index = 0; x < track.length; x += 8, index++) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    flowerData.push({ x, y: ground.height, side: index % 2 ? -1 : 1, index });
  }
  if (flowerData.length) {
    const stems = _instanced(session, new THREE.CylinderGeometry(0.035, 0.055, 0.82, 6), _standard(session, { color: 0x477d48, roughness: 1 }), flowerData.length, 'trials-meadow-flower-stems');
    const blooms = _instanced(session, new THREE.SphereGeometry(0.2, 8, 6), _standard(session, { color: track.colors.accent, emissive: track.colors.accent, emissiveIntensity: 0.1, roughness: 0.8 }), flowerData.length, 'trials-meadow-flower-blooms');
    for (let index = 0; index < flowerData.length; index++) {
      const item = flowerData[index];
      const z = item.side * (4.55 + (item.index % 3) * 0.16);
      _setInstance(stems, index, item.x, item.y + 0.4, z, 1, 1, 1, (item.side * 0.08));
      _setInstance(blooms, index, item.x + item.side * 0.05, item.y + 0.94, z, 1.5, 1.02, 0.94);
    }
    stems.instanceMatrix.needsUpdate = true;
    blooms.instanceMatrix.needsUpdate = true;
    stems.castShadow = true;
    blooms.castShadow = true;
    root.add(stems, blooms);
  }

  const grove = [];
  for (let x = 2, index = 0; x < track.length; x += 27, index++) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    grove.push({ x, y: ground.height, index, scale: 0.78 + _hash(index + 31) * 0.46 });
  }
  if (grove.length) {
    const trunkMaterial = _standard(session, { color: 0x795447, roughness: 0.96 });
    const canopyMaterial = _standard(session, { color: 0x5fa96d, roughness: 0.9 });
    const trunks = _instanced(session, new THREE.CapsuleGeometry(0.22, 2.15, 4, 7), trunkMaterial, grove.length, 'trials-meadow-mochi-trunks');
    const canopies = _instanced(session, new THREE.IcosahedronGeometry(1, 2), canopyMaterial, grove.length * 3, 'trials-meadow-mochi-canopies');
    const leafColors = [new THREE.Color(0x69b978), new THREE.Color(0x89c96f), new THREE.Color(0x4d9869)];
    grove.forEach((item, index) => {
      const z = -8.4 - (index % 3) * 1.25;
      const height = 3.65 * item.scale;
      _setInstance(trunks, index, item.x, item.y + height * 0.43, z, item.scale, item.scale, item.scale, (_hash(index + 4) - 0.5) * 0.1);
      const lobes = [
        [-0.82, 0.05, 1.08],
        [0.72, 0.18, 0.95],
        [-0.02, 0.98, 1.2],
      ];
      lobes.forEach(([dx, dy, scale], lobe) => {
        const instance = index * 3 + lobe;
        _setInstance(canopies, instance, item.x + dx * item.scale, item.y + height + dy * item.scale, z, scale * 1.55 * item.scale, scale * 1.18 * item.scale, scale * item.scale, 0, _hash(index * 7 + lobe) * TAU);
        canopies.setColorAt(instance, leafColors[(index + lobe) % leafColors.length]);
      });
    });
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    trunks.castShadow = true;
    canopies.castShadow = true;
    root.add(trunks, canopies);
  }

  const towerMaterial = _standard(session, { color: 0xf7e6c3, roughness: 0.9 });
  const bladeMaterial = _standard(session, { color: profile.landmark, emissive: profile.landmark, emissiveIntensity: 0.06, roughness: 0.72, side: THREE.DoubleSide });
  const towerGeometry = _ownGeometry(session, new THREE.CylinderGeometry(0.42, 0.82, 7.2, 7));
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(-0.12, 0.15);
  bladeShape.lineTo(0.15, 0.15);
  bladeShape.lineTo(0.7, 3.2);
  bladeShape.quadraticCurveTo(0.1, 3.55, -0.36, 3.12);
  bladeShape.closePath();
  const bladeGeometry = _ownGeometry(session, new THREE.ShapeGeometry(bladeShape));
  for (const [index, x] of [34, 310, 620].entries()) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    const landmark = new THREE.Group();
    landmark.name = `trials-mochi-windmill-${index}`;
    landmark.position.set(x, ground.height, -7.6);
    const tower = new THREE.Mesh(towerGeometry, towerMaterial);
    tower.position.y = 3.6;
    tower.castShadow = true;
    const rotor = new THREE.Group();
    rotor.position.set(0, 6.7, 0.45);
    for (let blade = 0; blade < 4; blade++) {
      const mesh = new THREE.Mesh(bladeGeometry, bladeMaterial);
      mesh.rotation.z = blade * Math.PI * 0.5;
      mesh.castShadow = true;
      rotor.add(mesh);
    }
    const hub = new THREE.Mesh(_ownGeometry(session, new THREE.SphereGeometry(0.38, 10, 7)), bladeMaterial);
    hub.position.z = 0.06;
    rotor.add(hub);
    landmark.add(tower, rotor);
    root.add(landmark);
    world.rotors.push({ group: rotor, speed: 0.48 + index * 0.09, phase: index });
  }
  _addCatPennants(session, world, 0xff85ad);
}

function _addQuarryStory(session, world, profile) {
  const { track, root } = session;
  const rockData = [];
  const crystalData = [];
  for (let x = 8, index = 0; x < track.length; x += 14, index++) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    const side = index % 2 ? -1 : 1;
    rockData.push({ x: x + (_hash(index) - 0.5) * 5, y: ground.height, z: side * (4.7 + _hash(index + 2) * 1.2), index });
    if (index % 3 === 0) crystalData.push({ x: x + 4, y: ground.height, z: -side * 4.65, index });
  }
  const rockMaterial = _standard(session, { color: 0x57565c, roughness: 1 });
  const rocks = _instanced(session, new THREE.IcosahedronGeometry(1, 1), rockMaterial, rockData.length, 'trials-quarry-rockfall');
  rockData.forEach((item, index) => {
    const scale = 0.45 + _hash(item.index + 14) * 0.85;
    _setInstance(rocks, index, item.x, item.y + scale * 0.42, item.z, scale * 1.2, scale * 0.72, scale, (_hash(item.index + 4) - 0.5) * 0.8, _hash(item.index + 7) * TAU);
  });
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = true;
  root.add(rocks);

  const spireData = [];
  for (let x = 16, index = 0; x < track.length; x += 34, index++) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    spireData.push({ x, y: ground.height, index });
  }
  if (spireData.length) {
    const spireMaterial = _standard(session, { color: 0x454b53, roughness: 0.94 });
    const spires = _instanced(session, new THREE.ConeGeometry(1.5, 5.8, 6), spireMaterial, spireData.length, 'trials-quarry-background-spires');
    spireData.forEach((item, index) => {
      const scale = 0.7 + _hash(index + 71) * 0.75;
      _setInstance(spires, index, item.x, item.y + 2.4 * scale, -8.5 - (index % 3), scale, scale, scale, (_hash(index + 19) - 0.5) * 0.22, _hash(index + 23) * TAU);
    });
    spires.instanceMatrix.needsUpdate = true;
    spires.castShadow = true;
    root.add(spires);
  }

  if (crystalData.length) {
    const crystalMaterial = _standard(session, { color: profile.shoulder, emissive: profile.shoulder, emissiveIntensity: 0.42, roughness: 0.34, metalness: 0.08 });
    const crystals = _instanced(session, new THREE.ConeGeometry(0.52, 2.5, 5), crystalMaterial, crystalData.length, 'trials-quarry-glowmoss-crystals');
    crystalData.forEach((item, index) => {
      const scale = 0.7 + _hash(item.index + 13) * 0.65;
      _setInstance(crystals, index, item.x, item.y + scale, item.z, scale, scale, scale, (item.index % 2 ? -1 : 1) * 0.18);
    });
    crystals.instanceMatrix.needsUpdate = true;
    crystals.castShadow = true;
    root.add(crystals);
    crystalMaterial.userData.trialsBaseEmissive = crystalMaterial.emissiveIntensity;
    world.pulseMaterials.push(crystalMaterial);
  }

  const portalMaterial = _standard(session, { color: 0x3b3940, roughness: 0.96 });
  const braceMaterial = _standard(session, { color: profile.landmark, metalness: 0.42, roughness: 0.48 });
  const portalGeometry = _ownGeometry(session, new THREE.TorusGeometry(3.1, 0.34, 7, 18, Math.PI));
  const supportGeometry = _ownGeometry(session, new THREE.CylinderGeometry(0.28, 0.36, 4.1, 7));
  for (const [index, x] of [36, 430, 780].entries()) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    const portal = new THREE.Group();
    portal.name = `trials-quarry-catworks-${index}`;
    portal.position.set(x, ground.height, -6.8);
    const arch = new THREE.Mesh(portalGeometry, braceMaterial);
    arch.position.y = 3.8;
    const left = new THREE.Mesh(supportGeometry, portalMaterial);
    left.position.set(-3.1, 2, 0);
    const right = left.clone();
    right.position.x = 3.1;
    portal.add(arch, left, right);
    root.add(portal);
  }
  _addCatPennants(session, world, profile.shoulder);
}

function _crownShapeGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-1.2, -0.7);
  shape.lineTo(-1.35, 0.65);
  shape.lineTo(-0.72, 0.1);
  shape.lineTo(-0.28, 1.15);
  shape.lineTo(0.12, 0.08);
  shape.lineTo(0.88, 0.82);
  shape.lineTo(1.2, -0.7);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 2);
}

function _addCrownStory(session, world, profile) {
  const { track, root } = session;
  const crownMaterial = _standard(session, { color: profile.landmark, emissive: profile.landmark, emissiveIntensity: 0.26, roughness: 0.54, side: THREE.DoubleSide });
  const crownGeometry = _ownGeometry(session, _crownShapeGeometry());
  const placements = [];
  for (let x = 18, index = 0; x < track.length; x += 58, index++) {
    const ground = sampleTrialsGround(track, x);
    if (ground) placements.push({ x, y: ground.height, side: index % 2 ? -1 : 1, index });
  }
  const crowns = _instanced(session, crownGeometry, crownMaterial, placements.length, 'trials-crown-roadside-crests');
  placements.forEach((item, index) => {
    _setInstance(crowns, index, item.x, item.y + 3.6, item.side * 4.72, 0.78, 0.78, 0.78, item.side * 0.05);
  });
  crowns.instanceMatrix.needsUpdate = true;
  crowns.castShadow = true;
  root.add(crowns);
  crownMaterial.userData.trialsBaseEmissive = crownMaterial.emissiveIntensity;
  world.pulseMaterials.push(crownMaterial);

  const islandData = [];
  for (let x = 12, index = 0; x < track.length; x += 66, index++) {
    const ground = sampleTrialsGround(track, x);
    if (!ground) continue;
    islandData.push({ x, y: ground.height, index });
  }
  if (islandData.length) {
    const islandMaterial = _standard(session, { color: 0x735f99, roughness: 0.84 });
    const capMaterial = _standard(session, { color: 0xffb9dc, emissive: 0xff77bc, emissiveIntensity: 0.08, roughness: 0.7 });
    const islands = _instanced(session, new THREE.IcosahedronGeometry(1, 1), islandMaterial, islandData.length, 'trials-crown-floating-islands');
    const caps = _instanced(session, new THREE.SphereGeometry(1, 12, 8), capMaterial, islandData.length, 'trials-crown-island-gardens');
    islandData.forEach((item, index) => {
      const scale = 0.85 + _hash(index + 47) * 0.72;
      const y = item.y + 5.2 + (index % 3) * 1.15;
      const z = -9.5 - (index % 2) * 2;
      _setInstance(islands, index, item.x, y, z, 2.5 * scale, 1.75 * scale, 1.55 * scale, Math.PI, _hash(index + 4) * TAU);
      _setInstance(caps, index, item.x, y + 1.18 * scale, z, 2.35 * scale, 0.42 * scale, 1.42 * scale);
    });
    islands.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    islands.castShadow = true;
    caps.castShadow = true;
    root.add(islands, caps);
  }

  const ribbonColors = [0xff66b7, 0xffd45b, 0x75e4ff];
  for (let ribbonIndex = 0; ribbonIndex < ribbonColors.length; ribbonIndex++) {
    const curvePoints = [];
    const samples = 44;
    for (let index = 0; index < samples; index++) {
      const t = index / (samples - 1);
      curvePoints.push(new THREE.Vector3(
        THREE.MathUtils.lerp(-55, track.length + 55, t),
        world.baseline + 24 + ribbonIndex * 2.1 + Math.sin(t * TAU * 3 + ribbonIndex * 1.4) * 5.5,
        -27 - ribbonIndex * 1.3,
      ));
    }
    const curve = new THREE.CatmullRomCurve3(curvePoints);
    const geometry = new THREE.TubeGeometry(curve, Math.ceil(track.length / 5), 0.28, 5, false);
    const material = _basic(session, { color: ribbonColors[ribbonIndex], transparent: true, opacity: 0.52, depthWrite: false, fog: true });
    const ribbon = _mesh(session, geometry, material, `trials-cloudway-ribbon-${ribbonIndex}`);
    root.add(ribbon);
  }

  const palaceMaterial = _basic(session, { color: 0x9a78c9, transparent: true, opacity: 0.5, depthWrite: false, fog: true, side: THREE.DoubleSide });
  const palaceGeometry = _ownGeometry(session, _catPennantGeometry());
  for (const [index, x] of [38, 560, 980].entries()) {
    const palace = new THREE.Mesh(palaceGeometry, palaceMaterial);
    palace.name = `trials-cloud-palace-${index}`;
    palace.position.set(x, world.baseline + 34 + index * 4, -31);
    palace.scale.set(11 + index * 2, 15 + index * 2, 1);
    palace.userData.presentationOnly = true;
    root.add(palace);
  }
  _addCatPennants(session, world, profile.shoulder);
}

function _addAuthoredTrialsStory(session, world) {
  const { track, root, assetLease } = session;
  const kit = {
    meadow: { primary: ['forest_tree_gnarled_a', 'forest_tree_gnarled_b'], accent: 'forest_fern_cluster' },
    quarry: { primary: ['cave_stalagmite_cluster', 'cave_timber_brace'], accent: 'cave_rubble_cluster' },
    crown: { primary: ['kakiland_blossom_tree'], accent: 'kakiland_flower_cluster' },
  }[track.id];
  if (!kit) return 0;
  const group = new THREE.Group();
  group.name = `trials-${track.id}-authored-environment-kit-v2`;
  const placements = [];
  for (let x = 18, index = 0; x < track.length - 10; x += 27 + (index % 3) * 4, index++) {
    const ground = sampleTrialsGround(track, x);
    if (ground) placements.push({ x, y: ground.height, index });
  }
  let count = 0;
  for (let propIndex = 0; propIndex < kit.primary.length; propIndex++) {
    const name = kit.primary[propIndex];
    const sources = assetLease.getModelMeshes?.(name)
      || [assetLease.getModelMesh?.(name)].filter(Boolean);
    const selected = placements.filter((item) => item.index % kit.primary.length === propIndex);
    let builtParts = 0;
    sources.forEach((source, partIndex) => {
      const mesh = _instancedFromModel(source, selected.length, `trials-${track.id}-authored-${name}-part-${partIndex}`);
      if (!mesh) return;
      selected.forEach((item, index) => {
        const scale = (track.id === 'quarry' ? 1.22 : 1.05) * (0.82 + _hash(item.index + 21) * 0.38);
        _setInstance(mesh, index, item.x, item.y - 0.05, -6.6 - (item.index % 2) * 0.75, scale, scale, scale, 0, (_hash(item.index + 8) - 0.5) * 0.55);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      builtParts += 1;
    });
    if (builtParts) count += selected.length;
  }
  const accentSources = assetLease.getModelMeshes?.(kit.accent)
    || [assetLease.getModelMesh?.(kit.accent)].filter(Boolean);
  const accentPlacements = placements.filter((item) => item.index % 2 === 0);
  let builtAccentParts = 0;
  accentSources.forEach((accentSource, partIndex) => {
    const accents = _instancedFromModel(accentSource, accentPlacements.length, `trials-${track.id}-authored-${kit.accent}-part-${partIndex}`);
    if (!accents) return;
    accentPlacements.forEach((item, index) => {
      const scale = 0.58 + _hash(item.index + 41) * 0.28;
      _setInstance(accents, index, item.x + 3.4, item.y, -5.35, scale, scale, scale, 0, _hash(item.index + 4) * TAU);
    });
    accents.instanceMatrix.needsUpdate = true;
    accents.computeBoundingSphere();
    group.add(accents);
    builtAccentParts += 1;
  });
  if (builtAccentParts) count += accentPlacements.length;
  if (count > 0) {
    root.add(group);
    world.authoredStory = group;
    world.authoredReady = true;
  }
  return count;
}

/**
 * Build a Trials presentation world into `session.root`.
 *
 * Required session fields: root, track. Supported ownership layouts are either
 * `session.owned.{geometries,materials,textures}` or the corresponding
 * `ownedGeometries`, `ownedMaterials`, and `ownedTextures` sets.
 */
export function buildTrialsEnvironment(session) {
  if (session && !session.track && session.course) session.track = session.course;
  if (!session?.root || !session?.track) {
    throw new TypeError('buildTrialsEnvironment requires a session with root and track/course');
  }
  const profile = _profile(session.track);
  const world = {
    id: session.track.id,
    profile,
    baseline: 0,
    cloudMesh: null,
    cloudPuffs: [],
    waveRibbons: [],
    rotors: [],
    pulseMaterials: [],
    clock: 0,
    cloudMatricesInitialized: false,
    reducedMotion: false,
    reducedFlashing: false,
    lighting: null,
    authoredReady: false,
    authoredStory: null,
    drawCallGroups: Object.freeze({ terrain: 'per contiguous range', decor: 'instanced by family', atmosphere: 'single cloud bank' }),
  };
  session.trialsEnvironment = world;
  _buildTerrain(session, world, profile);
  _addSky(session, world, profile);
  _addClouds(session, world);
  if (session.assetLease?.ready) {
    session.assetLease.ready.then(() => {
      if (session.trialsEnvironment === world) _addAuthoredTrialsStory(session, world);
    }).catch(() => {});
  } else if (session.track.id === 'quarry') _addQuarryStory(session, world, profile);
  else if (session.track.id === 'crown') _addCrownStory(session, world, profile);
  else _addMeadowStory(session, world, profile);
  _addLighting(session, world, profile);
  return world;
}

/** Animate only ambient presentation state; physics and course data are untouched. */
export function updateTrialsEnvironment(session, time, dt = 0) {
  const world = session?.trialsEnvironment;
  if (!world) return;
  const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  world.clock = Number.isFinite(time) ? time : world.clock + safeDt;
  _fitBackdropToCamera(session, world);
  const t = world.clock;
  const reducedMotion = !!state._optReduceMotion;
  const reducedFlashing = !!state._optReducedFlashing;
  const accessibilityChanged = world.reducedMotion !== reducedMotion
    || world.reducedFlashing !== reducedFlashing;
  const animateAmbientMotion = !reducedMotion;
  const animateAmbientPulse = !reducedMotion && !reducedFlashing;
  world.reducedMotion = reducedMotion;
  world.reducedFlashing = reducedFlashing;

  // Build the cloud matrices once even when reduced motion was enabled before
  // entering Trials. Thereafter a reduced-motion toggle freezes their current
  // world-space positions without paying the per-frame matrix upload.
  if (world.cloudMesh && world.cloudPuffs.length && (animateAmbientMotion || !world.cloudMatricesInitialized)) {
    const span = session.track.length + 180;
    const cloudTime = animateAmbientMotion ? t : 0;
    for (let index = 0; index < world.cloudPuffs.length; index++) {
      const puff = world.cloudPuffs[index];
      const x = ((puff.baseX + cloudTime * puff.speed + 90) % span + span) % span - 90;
      const y = puff.baseY + puff.dy + Math.sin(cloudTime * 0.42 + puff.phase) * 0.42;
      TEMP_POSITION.set(x + puff.dx, y, puff.z);
      TEMP_SCALE.set(puff.sx, puff.sy, 1.25);
      TEMP_MATRIX.compose(TEMP_POSITION, TEMP_QUATERNION.identity(), TEMP_SCALE);
      world.cloudMesh.setMatrixAt(index, TEMP_MATRIX);
    }
    world.cloudMesh.instanceMatrix.needsUpdate = true;
    world.cloudMatricesInitialized = true;
  }

  if (animateAmbientMotion) {
    for (const rotor of world.rotors) {
      rotor.group.rotation.z = t * rotor.speed + rotor.phase;
    }
  }
  if (animateAmbientMotion || accessibilityChanged) {
    for (const ribbon of world.waveRibbons) {
      if (animateAmbientMotion) ribbon.position.y = Math.sin(t * 1.4 + ribbon.userData.wavePhase) * 0.12;
      ribbon.material.opacity = animateAmbientPulse
        ? ribbon.userData.baseOpacity + Math.sin(t * 1.8 + ribbon.userData.wavePhase) * 0.14
        : ribbon.userData.baseOpacity;
    }
  }
  if (animateAmbientPulse || accessibilityChanged) {
    for (let index = 0; index < world.pulseMaterials.length; index++) {
      const material = world.pulseMaterials[index];
      const baseIntensity = material.userData.trialsBaseEmissive ?? material.emissiveIntensity;
      material.emissiveIntensity = animateAmbientPulse
        ? baseIntensity * (0.82 + Math.sin(t * 2.2 + index * 1.3) * 0.24)
        : baseIntensity;
    }
  }
  if (world.sunHalo) {
    const followX = session.physics?.x;
    if (Number.isFinite(followX)) {
      world.sun.position.x = followX + 48;
      world.sunHalo.position.x = world.sun.position.x;
    }
    const pulse = animateAmbientPulse ? 1 + Math.sin(t * 0.72) * 0.035 : 1;
    world.sunHalo.scale.setScalar(pulse);
  }
}
