import * as THREE from 'three';
import { buildRallyCar } from '../racingVehicles.js';
import { createRallyAssetLease } from '../racingAssets.js';
import { crashVehicleProfile } from './crashConfig.js';

const COLORS = [0xff6f91, 0x65d9f3, 0xffc859, 0x83dc86, 0xa986ef, 0xee795e, 0x4bc6ad, 0xe9e0d0, 0x64798f, 0xd24b57, 0xf3a0d3, 0x5f73d9];

const CRASH_MODEL_NAMES = Object.freeze({
  hatchback: 'KakiCat_Traffic_Hatchback',
  sedan: 'KakiCat_Traffic_Sedan',
  wagon: 'KakiCat_Traffic_Wagon',
  pickup: 'KakiCat_Traffic_Pickup',
  suv: 'KakiCat_Traffic_SUV',
  van: 'KakiCat_Traffic_Van',
  boxTruck: 'KakiCat_Traffic_BoxTruck',
  bus: 'KakiCat_Traffic_Bus',
  semi: 'KakiCat_Traffic_SemiTractor',
  trailer: 'KakiCat_Traffic_SemiTrailer',
  tanker: 'KakiCat_Traffic_Tanker',
});

const CRASH_PLAYER_MODEL_NAMES = Object.freeze({
  pocket: 'KakiCat_Player_PocketPouncer',
  muscle: 'KakiCat_Player_KakiMuscle',
  iron: 'KakiCat_Player_IronTabby',
});

function ownGeometry(owned, geometry) {
  owned.geometries.add(geometry);
  return geometry;
}

function ownMaterial(owned, material) {
  owned.materials.add(material);
  return material;
}

function roundedDeck(width, length, height, radius = 0.2) {
  const hw = width * 0.5;
  const hl = length * 0.5;
  const r = Math.min(radius, hw * 0.7, hl * 0.7);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hl);
  shape.lineTo(hw - r, -hl);
  shape.quadraticCurveTo(hw, -hl, hw, -hl + r);
  shape.lineTo(hw, hl - r);
  shape.quadraticCurveTo(hw, hl, hw - r, hl);
  shape.lineTo(-hw + r, hl);
  shape.quadraticCurveTo(-hw, hl, -hw, hl - r);
  shape.lineTo(-hw, -hl + r);
  shape.quadraticCurveTo(-hw, -hl, -hw + r, -hl);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: Math.min(0.08, height * 0.18),
    bevelThickness: Math.min(0.07, height * 0.16),
    curveSegments: 4,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height * 0.5, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function damageReady(mesh) {
  const attribute = mesh.geometry.getAttribute('position');
  if (!attribute?.array) return mesh;
  mesh.userData.baseDamagePositions = attribute.array.slice();
  mesh.userData.damageGeometryIsUnique = true;
  mesh.userData.role ||= 'damage-surface';
  return mesh;
}

function addMesh(parent, owned, geometry, material, name, position = [0, 0, 0]) {
  const mesh = new THREE.Mesh(ownGeometry(owned, geometry), material);
  mesh.name = name;
  mesh.position.fromArray(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function createWheel(owned, radius, width, side, axle, position, materials) {
  const group = new THREE.Group();
  group.name = `${side}-${axle}-wheel`;
  group.userData.role = 'wheel';
  group.userData.side = side;
  group.userData.axle = axle;
  group.position.fromArray(position);
  group.userData.basePosition = group.position.clone();
  const tire = addMesh(group, owned, new THREE.TorusGeometry(radius * 0.76, radius * 0.24, 8, 20), materials.tire, `${group.name}-tire`);
  tire.rotation.y = Math.PI / 2;
  const rim = addMesh(group, owned, new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, width * 0.92, 14), materials.metal, `${group.name}-rim`);
  rim.rotation.z = Math.PI / 2;
  const hub = addMesh(group, owned, new THREE.CylinderGeometry(radius * 0.13, radius * 0.13, width, 10), materials.accent, `${group.name}-hub`);
  hub.rotation.z = Math.PI / 2;
  return group;
}

function buildTrafficVisual(classId, colorIndex, owned) {
  const profile = crashVehicleProfile(classId);
  const root = new THREE.Group();
  root.name = `crash-vehicle-${classId}`;
  root.userData.vehicleType = classId;
  const bodyPivot = new THREE.Group();
  bodyPivot.name = `${classId}-body-pivot`;
  root.add(bodyPivot);
  const color = new THREE.Color(COLORS[Math.abs(colorIndex || 0) % COLORS.length]);
  const body = ownMaterial(owned, new THREE.MeshPhysicalMaterial({ color, roughness: 0.36, metalness: 0.18, clearcoat: 0.55, clearcoatRoughness: 0.25 }));
  const accent = ownMaterial(owned, new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color(0xffd46a), 0.38), roughness: 0.42, metalness: 0.35 }));
  const dark = ownMaterial(owned, new THREE.MeshStandardMaterial({ color: 0x17191e, roughness: 0.86, metalness: 0.12 }));
  const metal = ownMaterial(owned, new THREE.MeshStandardMaterial({ color: 0xc5ccd0, roughness: 0.28, metalness: 0.75 }));
  const tire = ownMaterial(owned, new THREE.MeshStandardMaterial({ color: 0x101116, roughness: 0.96 }));
  const glass = ownMaterial(owned, new THREE.MeshPhysicalMaterial({ color: 0x244456, emissive: 0x112735, emissiveIntensity: 0.18, roughness: 0.12, transparent: true, opacity: 0.82, clearcoat: 1 }));
  const lamp = ownMaterial(owned, new THREE.MeshBasicMaterial({ color: 0xffe795, toneMapped: false }));
  const materials = { body, accent, dark, metal, tire, glass, lamp };
  const parts = new Map();
  const damageMeshes = [];
  const lowerY = profile.height * 0.32;
  const chassis = damageReady(addMesh(bodyPivot, owned, roundedDeck(profile.width, profile.length, profile.height * 0.34, 0.24), body, `${classId}-chassis`, [0, lowerY, 0]));
  damageMeshes.push(chassis);

  const heavy = ['bus', 'boxTruck', 'trailer', 'tanker'].includes(classId);
  const cabLength = classId === 'pickup' ? profile.length * 0.45 : classId === 'semi' ? profile.length * 0.48 : heavy ? profile.length * 0.72 : profile.length * 0.54;
  const cabZ = classId === 'pickup' ? profile.length * 0.16 : classId === 'semi' ? profile.length * 0.22 : heavy ? -profile.length * 0.03 : -profile.length * 0.08;
  if (classId === 'tanker') {
    const tank = damageReady(addMesh(bodyPivot, owned, new THREE.CylinderGeometry(profile.width * 0.42, profile.width * 0.42, profile.length * 0.77, 20), metal, 'tanker-shell', [0, profile.height * 0.62, -profile.length * 0.06]));
    tank.rotation.x = Math.PI / 2;
    tank.userData.volatile = true;
    damageMeshes.push(tank);
    for (const z of [-profile.length * 0.31, -profile.length * 0.06, profile.length * 0.19]) {
      const band = addMesh(bodyPivot, owned, new THREE.TorusGeometry(profile.width * 0.43, 0.055, 6, 22), dark, `tank-band-${z}`, [0, profile.height * 0.62, z]);
      band.rotation.x = Math.PI / 2;
    }
  } else {
    const upperHeight = heavy ? profile.height * 0.6 : profile.height * 0.5;
    const upper = damageReady(addMesh(bodyPivot, owned, roundedDeck(profile.width * 0.9, cabLength, upperHeight, heavy ? 0.2 : 0.34), heavy ? accent : body, `${classId}-upper-shell`, [0, profile.height * 0.58, cabZ]));
    damageMeshes.push(upper);
  }

  const hood = new THREE.Group();
  hood.name = 'hood';
  addMesh(hood, owned, roundedDeck(profile.width * 0.82, profile.length * 0.2, profile.height * 0.13, 0.13), accent, 'hood-panel');
  hood.position.set(0, profile.height * 0.53, profile.length * 0.37);
  bodyPivot.add(hood);
  parts.set('hood', hood);
  const trunk = new THREE.Group();
  trunk.name = 'trunk';
  addMesh(trunk, owned, roundedDeck(profile.width * 0.8, profile.length * 0.14, profile.height * 0.12, 0.11), accent, 'trunk-panel');
  trunk.position.set(0, profile.height * 0.49, -profile.length * 0.43);
  bodyPivot.add(trunk);
  parts.set('trunk', trunk);

  for (const side of [-1, 1]) {
    const sideName = side < 0 ? 'left' : 'right';
    const door = new THREE.Group();
    door.name = `${sideName}-door`;
    const panel = addMesh(door, owned, new THREE.BoxGeometry(0.08, profile.height * 0.42, profile.length * 0.3, 2, 2, 3), body, `${sideName}-door-panel`);
    panel.position.y = profile.height * 0.47;
    door.position.set(side * profile.width * 0.48, 0, -profile.length * 0.02);
    bodyPivot.add(door);
    parts.set(`${sideName}-door`, door);
    const mirror = new THREE.Group();
    mirror.name = `${sideName}-mirror`;
    addMesh(mirror, owned, new THREE.SphereGeometry(0.12, 10, 6), dark, `${sideName}-mirror-shell`);
    mirror.position.set(side * profile.width * 0.59, profile.height * 0.73, profile.length * 0.15);
    bodyPivot.add(mirror);
    parts.set(`${sideName}-mirror`, mirror);
  }

  for (const [name, z] of [['front-bumper', profile.length * 0.51], ['rear-bumper', -profile.length * 0.51]]) {
    const bumper = new THREE.Group();
    bumper.name = name;
    const bar = addMesh(bumper, owned, new THREE.CapsuleGeometry(0.11, profile.width * 0.78, 5, 10), dark, `${name}-bar`);
    bar.rotation.z = Math.PI / 2;
    bumper.position.set(0, profile.height * 0.25, z);
    bodyPivot.add(bumper);
    parts.set(name, bumper);
  }

  const glassPanels = [];
  for (const [name, z, tilt] of [['windshield', profile.length * 0.14, -0.28], ['rear-glass', -profile.length * 0.27, 0.24]]) {
    const panel = addMesh(bodyPivot, owned, new THREE.PlaneGeometry(profile.width * 0.68, profile.height * 0.36), glass, name, [0, profile.height * 0.78, z]);
    panel.rotation.x = tilt;
    glassPanels.push(panel);
  }

  const wheelRadius = Math.max(0.4, Math.min(0.66, profile.height * 0.28));
  const wheelWidth = wheelRadius * 0.58;
  const wheels = [];
  for (const side of [-1, 1]) for (const axle of [-1, 1]) {
    const wheel = createWheel(
      owned, wheelRadius, wheelWidth, side < 0 ? 'left' : 'right', axle < 0 ? 'rear' : 'front',
      [side * profile.width * 0.55, wheelRadius, axle * profile.length * 0.31], materials,
    );
    bodyPivot.add(wheel);
    wheels.push(wheel);
    parts.set(wheel.name, wheel);
  }
  for (const side of [-1, 1]) {
    const light = addMesh(bodyPivot, owned, new THREE.SphereGeometry(0.1, 10, 6), lamp, `${side < 0 ? 'left' : 'right'}-headlight`, [side * profile.width * 0.3, profile.height * 0.43, profile.length * 0.49]);
    light.scale.z = 0.45;
    const ear = addMesh(bodyPivot, owned, new THREE.ConeGeometry(0.18, 0.42, 5), accent, `${side < 0 ? 'left' : 'right'}-kaki-ear`, [side * profile.width * 0.23, profile.height * 1.01, cabZ]);
    ear.rotation.z = side * -0.18;
  }
  root.userData.parts = parts;
  return { root, bodyPivot, wheels, parts, damageMeshes, glassPanels, profile, productionAttached: false };
}

function normalizeAuthoredName(name = '') {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

function wheelPositionFromName(name) {
  const normalized = `-${normalizeAuthoredName(name)}-`;
  const left = /-(left|lf|fl|l-front|l-rear)-/.test(normalized) || /-wheel-l[fr]-/.test(normalized);
  const right = /-(right|rf|fr|r-front|r-rear)-/.test(normalized) || /-wheel-r[fr]-/.test(normalized);
  const front = /-(front|lf|fl|rf|fr)-/.test(normalized) || /-wheel-[lr]f-/.test(normalized);
  const rear = /-(rear|lr|rl|rr)-/.test(normalized) || /-wheel-[lr]r-/.test(normalized);
  if ((!left && !right) || (!front && !rear)) return null;
  return `${left ? 'left' : 'right'}-${front ? 'front' : 'rear'}-wheel`;
}

function canonicalPartName(name) {
  const normalized = normalizeAuthoredName(name);
  const wheel = wheelPositionFromName(normalized);
  if (wheel) return wheel;
  if (normalized.includes('front-bumper') || normalized.includes('bumper-front')) return 'front-bumper';
  if (normalized.includes('rear-bumper') || normalized.includes('bumper-rear')) return 'rear-bumper';
  if (/(^|-)hood($|-)|bonnet/.test(normalized)) return 'hood';
  if (/(^|-)trunk($|-)|boot-lid|rear-hatch|tailgate/.test(normalized)) return 'trunk';
  const side = /(^|-)(left|lh|driver)($|-)|(^|-)door-l($|-)/.test(normalized) ? 'left'
    : /(^|-)(right|rh|passenger)($|-)|(^|-)door-r($|-)/.test(normalized) ? 'right' : '';
  if (side && normalized.includes('door')) return `${side}-door`;
  if (side && normalized.includes('mirror')) return `${side}-mirror`;
  return null;
}

function authoredSurfaceRole(name) {
  const normalized = normalizeAuthoredName(name);
  if (/(wheel|tire|tyre|rim|hub|glass|window|windshield|windscreen|lamp|light|dashboard|steering|seat|interior|cockpit|canopy|firewall|bulkhead|sill|decal)/.test(normalized)) return null;
  return 'authored-damage-surface';
}

function indexAuthoredVehicle(clone) {
  const parts = new Map();
  const glassPanels = [];
  const damageMeshes = [];
  const renderMeshes = [];
  clone.traverse((object) => {
    const part = canonicalPartName(object.name);
    if (part && !parts.has(part)) parts.set(part, object);
    if (!object.isMesh) return;
    renderMeshes.push(object);
    const normalized = normalizeAuthoredName(object.name);
    if (/(glass|window|windshield|windscreen)/.test(normalized)) glassPanels.push(object);
    if (authoredSurfaceRole(object.name)) {
      object.userData.role = 'authored-damage-surface';
      damageReady(object);
      damageMeshes.push(object);
    }
  });
  const wheels = ['left-front-wheel', 'right-front-wheel', 'left-rear-wheel', 'right-rear-wheel']
    .map((name) => parts.get(name))
    .filter(Boolean);
  return { parts, glassPanels, damageMeshes, renderMeshes, wheels };
}

function cloneModelNode(source, owned, tint) {
  if (!source) return null;
  const clone = source.clone(true);
  clone.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    object.geometry = ownGeometry(owned, object.geometry.clone());
    const cloneOne = (material) => {
      const next = material.clone();
      if (next.color) next.color.lerp(tint, 0.22);
      owned.materials.add(next);
      return next;
    };
    object.material = Array.isArray(object.material) ? object.material.map(cloneOne) : cloneOne(object.material);
  });
  return clone;
}

function attachAuthoredVehicleModel(visual, gltf, sourceName, profile, owned, colorIndex = 0) {
  if (!visual || !gltf?.scene || visual.productionAttached) return false;
  const source = sourceName ? gltf.scene.getObjectByName(sourceName) : null;
  if (!source) return false;
  source.updateWorldMatrix(true, true);
  const clone = cloneModelNode(source, owned, new THREE.Color(COLORS[Math.abs(colorIndex) % COLORS.length]));
  if (!clone) return false;
  const fallbackMeshes = [];
  visual.bodyPivot.traverse((object) => { if (object.isMesh) fallbackMeshes.push(object); });
  const box = new THREE.Box3().setFromObject(clone);
  const size = box.getSize(new THREE.Vector3());
  const scale = Math.min(
    profile.width / Math.max(0.01, size.x),
    profile.height / Math.max(0.01, size.y),
    profile.length / Math.max(0.01, size.z),
  );
  clone.scale.multiplyScalar(scale);
  clone.updateWorldMatrix(true, true);
  const fitted = new THREE.Box3().setFromObject(clone);
  const center = fitted.getCenter(new THREE.Vector3());
  clone.position.x -= center.x;
  clone.position.z -= center.z;
  clone.position.y -= fitted.min.y;
  clone.name = `${profile.id}-production-vehicle`;
  clone.userData.role = 'production-shell';
  visual.bodyPivot.add(clone);
  const authored = indexAuthoredVehicle(clone);
  // Authored geometry is the only production presentation. The procedural
  // model remains an invisible loading fallback and is never revealed by a hit.
  for (const mesh of fallbackMeshes) mesh.visible = false;
  visual.productionModel = clone;
  visual.productionRenderMeshes = authored.renderMeshes;
  visual.fallbackMeshes = fallbackMeshes;
  visual.damageMeshes = authored.damageMeshes;
  visual.glassPanels = authored.glassPanels;
  visual.parts = authored.parts;
  if (authored.wheels.length === 4) visual.wheels = authored.wheels;
  visual.productionAttached = true;
  return true;
}

export function attachCrashProductionModel(visual, gltf, classId, owned, colorIndex = 0) {
  return attachAuthoredVehicleModel(
    visual,
    gltf,
    CRASH_MODEL_NAMES[classId],
    crashVehicleProfile(classId),
    owned,
    colorIndex,
  );
}

export function attachCrashPlayerProductionModel(visual, gltf, profile, owned) {
  return attachAuthoredVehicleModel(
    visual,
    gltf,
    CRASH_PLAYER_MODEL_NAMES[profile?.id],
    profile,
    owned,
    profile?.id === 'pocket' ? 1 : profile?.id === 'iron' ? 5 : 0,
  );
}

export function createCrashAssetLease(renderer = null) {
  return createRallyAssetLease({ courseId: 'forest', mode: 'crash', renderer });
}

export function buildCrashPlayerVisual({ profile, hero, owned, decalTexture }) {
  const palette = profile.id === 'pocket' ? 0x65d9f3 : profile.id === 'iron' ? 0xd96b45 : 0xff6f91;
  const visual = buildRallyCar({
    color: palette,
    driver: hero,
    owned,
    isPlayer: true,
    mode: 'stock',
    variant: profile.id === 'iron' ? 3 : profile.id === 'pocket' ? 1 : 0,
    decalTexture,
    decalTile: profile.id === 'iron' ? 11 : profile.id === 'pocket' ? 5 : 2,
    detailTier: 'showcase',
    // Catastrophe retains its existing authored-shell lifecycle while the mode
    // is deferred. Its attachment path hides the procedural body wholesale,
    // so do not install the shared Rally shadow-only driver proxy here.
    optimizeDriverShadow: false,
  });
  const parts = new Map();
  visual.bodyPivot.traverse((object) => {
    if (/^(front-bumper|rear-bumper|hood|trunk|left-door|right-door|left-mirror|right-mirror|left-front-wheel|right-front-wheel|left-rear-wheel|right-rear-wheel)$/.test(object.name)) parts.set(object.name, object);
  });
  // Existing rally art has separate bumpers/wheels; add stable aliases for
  // authored damage rules even when a trim piece has a more specific name.
  const byName = (name) => visual.root.getObjectByName(name);
  parts.set('front-bumper', byName('front-bumper'));
  parts.set('rear-bumper', byName('rear-bumper'));
  parts.set('hood', byName('rally-nose'));
  visual.parts = parts;
  visual.glassPanels = [byName('bubble-cockpit')].filter(Boolean);
  return visual;
}

export function buildCrashTrafficVisual(options) {
  return buildTrafficVisual(options.classId, options.colorIndex, options.owned);
}
