import * as THREE from 'three';
import {
  createCrashDebrisBody,
  createCrashStaticTrimesh,
} from './crashPhysics.js';

function authoredMeshArrays(object, root) {
  const position = object.geometry?.getAttribute?.('position');
  if (!position || position.count < 3) return null;
  root.updateWorldMatrix(true, false);
  object.updateWorldMatrix(true, false);
  const toRoot = root.matrixWorld.clone().invert().multiply(object.matrixWorld);
  const point = new THREE.Vector3();
  const vertices = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index).applyMatrix4(toRoot);
    vertices[index * 3] = point.x;
    vertices[index * 3 + 1] = point.y;
    vertices[index * 3 + 2] = point.z;
  }
  const source = object.geometry.index?.array;
  const indices = source
    ? Uint32Array.from(source)
    : Uint32Array.from({ length: position.count }, (_, index) => index);
  return { vertices, indices };
}

function authoredColliderMeshes(model) {
  const colliders = [];
  model.traverse((object) => {
    if (!object.isMesh) return;
    const explicit = object.name.startsWith('COLLIDER_') || object.userData?.collision === true;
    const authoredWalkway = object.userData?.role === 'sidewalk';
    if (!explicit && !authoredWalkway) return;
    if (explicit) object.visible = false;
    colliders.push(object);
  });
  return colliders;
}

function makeAuthoredBreakable(root, node, physics) {
  node.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(node);
  const size = bounds.getSize(new THREE.Vector3());
  const center = root.worldToLocal(bounds.getCenter(new THREE.Vector3()));
  const wrapper = new THREE.Group();
  wrapper.name = `${node.name}-physical-root`;
  wrapper.position.copy(center);
  root.add(wrapper);
  wrapper.attach(node);
  const role = node.userData?.role || 'breakable';
  const entity = {
    id: node.name,
    classId: role === 'breakable-structure' ? 'structure' : 'roadside-prop',
    kind: role,
    visual: { root: wrapper },
    breakThreshold: Number(node.userData?.break_threshold) || (role === 'breakable-structure' ? 2800 : 1550),
    broken: false,
    visualBodyCentered: true,
  };
  const volume = Math.max(0.08, size.x * size.y * size.z);
  createCrashDebrisBody(physics, entity, {
    x: center.x,
    y: center.y,
    z: center.z,
    width: Math.max(0.15, size.x),
    height: Math.max(0.15, size.y),
    length: Math.max(0.15, size.z),
    mass: Math.min(2200, Math.max(24, volume * (role === 'breakable-structure' ? 42 : 24))),
  });
  entity.body.setBodyType(physics.RAPIER.RigidBodyType.Fixed, false);
  return entity;
}

function prepareAtmosphereMesh(object, worldView) {
  const namedAtmosphere = /^(?:Atmosphere_|CloudLayer_)/.test(object.name);
  if (!object.isMesh || (object.userData?.role !== 'atmosphere' && !namedAtmosphere)) return;
  object.material = Array.isArray(object.material)
    ? object.material.map((material) => material.clone())
    : object.material.clone();
  object.userData.atmosphereOrigin = object.position.clone();
  object.userData.atmosphereKind ||= object.name.startsWith('CloudLayer_')
    ? 'cloud'
    : object.userData.atmosphere_kind || 'ground-fog';
  object.userData.atmospherePhase = Number(object.userData.phase) || 0;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    material.transparent = true;
    material.depthWrite = false;
    material.userData.atmosphereBaseOpacity = material.opacity;
  }
  worldView.atmosphere.push(object);
}

function attachAuthoredWorld({ root, physics, worldView, gltf }) {
  const model = gltf.scene.clone(true);
  model.name = 'pawprint-moonpaw-authored-environment-v2';
  root.add(model);
  model.traverse((object) => {
    if (!object.isMesh) return;
    if (object.userData?.role === 'signal-lamp') {
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => material.clone())
        : object.material.clone();
    }
    prepareAtmosphereMesh(object, worldView);
    object.castShadow = !['primary-road', 'road-marking', 'road-wear', 'lane-reflector', 'atmosphere'].includes(object.userData?.role);
    object.receiveShadow = object.userData?.role !== 'atmosphere';
  });
  root.updateWorldMatrix(true, true);
  for (const [index, colliderMesh] of authoredColliderMeshes(model).entries()) {
    const arrays = authoredMeshArrays(colliderMesh, root);
    if (!arrays) continue;
    const role = colliderMesh.userData?.role || (colliderMesh.name.includes('Road') ? 'road' : 'environment');
    const entity = createCrashStaticTrimesh(physics, {
      id: `authored-${colliderMesh.name}-${index}`,
      ...arrays,
      friction: role === 'road-collision' ? 1.32 : role === 'sidewalk' ? 1.08 : 1.18,
      metadata: { events: false, kind: 'environment', role },
    });
    worldView.staticColliders.push(entity);
  }
  const breakableNodes = [];
  model.traverse((object) => {
    if (object.name.startsWith('BREAKABLE_')) breakableNodes.push(object);
  });
  for (const node of breakableNodes) {
    const entity = makeAuthoredBreakable(root, node, physics);
    worldView.breakables.push(entity);
    if (node.name.startsWith('BREAKABLE_TrafficSignal_')) {
      const index = Number(node.name.match(/(\d+)$/)?.[1]) || 0;
      const lamps = ['Red', 'Amber', 'Green']
        .map((color) => node.getObjectByName(`Signal_${index}_Lamp_${color}`))
        .filter(Boolean);
      worldView.signals.push({
        root: entity.visual.root,
        lamps,
        housing: node.getObjectByName(`TrafficSignal_${index}_Housing`),
      });
    }
  }
  worldView.signals.sort((a, b) => a.root.name.localeCompare(b.root.name));
  worldView.model = model;
  worldView.ground = model.getObjectByName('Moonpaw_FreightDistrict_Ground');
  worldView.roads = [
    model.getObjectByName('Road_NS_Authored'),
    model.getObjectByName('Road_EW_Authored'),
  ].filter(Boolean);
  worldView.authored = true;
  return worldView;
}

function buildAuthoredCrashWorld({ root, physics, assetLease }) {
  const worldView = {
    ground: null,
    roads: [],
    signals: [],
    breakables: [],
    debrisProps: [],
    staticColliders: [],
    atmosphere: [],
    atmosphereTime: 0,
    model: null,
    authored: false,
    disposed: false,
    ready: null,
  };
  worldView.ready = assetLease.whenReady('crashEnvironmentV2').then((gltf) => {
    if (worldView.disposed || physics.disposed) return worldView;
    return attachAuthoredWorld({ root, physics, worldView, gltf });
  });
  return worldView;
}

export function buildCrashWorld({ root, physics, assetLease = null }) {
  if (!assetLease?.whenReady) {
    throw new Error('Kaki Catastrophe requires its authored Moonpaw environment asset');
  }
  return buildAuthoredCrashWorld({ root, physics, assetLease });
}

export function updateCrashSignalVisuals(worldView, signalStates) {
  for (const [index, signal] of (worldView?.signals || []).entries()) {
    const state = signalStates[index] || 'red';
    signal.lamps.forEach((lamp, lampIndex) => {
      const active = (state === 'red' && lampIndex === 0)
        || (state === 'amber' && lampIndex === 1)
        || (state === 'green' && lampIndex === 2);
      const materials = Array.isArray(lamp.material) ? lamp.material : [lamp.material];
      for (const material of materials) {
        if (!material) continue;
        if ('emissiveIntensity' in material) {
          material.userData.signalBaseIntensity ??= material.emissiveIntensity || 1;
          material.emissiveIntensity = active ? material.userData.signalBaseIntensity : 0.025;
        }
        material.opacity = active ? 1 : 0.20;
        material.transparent = !active;
      }
    });
  }
}

export function updateCrashWorldAtmosphere(worldView, dt) {
  if (!worldView?.atmosphere?.length || worldView.disposed) return;
  worldView.atmosphereTime += Math.max(0, Number(dt) || 0);
  const time = worldView.atmosphereTime;
  for (const object of worldView.atmosphere) {
    const origin = object.userData.atmosphereOrigin;
    if (!origin) continue;
    const phase = object.userData.atmospherePhase || 0;
    const kind = object.userData.atmosphereKind;
    object.position.copy(origin);
    if (kind === 'cloud') {
      object.position.x += Math.sin(time * 0.035 + phase) * 5.5;
      object.position.z += Math.cos(time * 0.021 + phase) * 1.8;
    } else if (kind === 'steam') {
      object.position.y += Math.sin(time * 0.72 + phase) * 0.20;
      object.position.x += Math.sin(time * 0.31 + phase) * 0.16;
    } else if (kind === 'ground-fog') {
      object.position.x += Math.sin(time * 0.055 + phase) * 1.7;
    }
    const pulse = kind === 'rain'
      ? 0.82 + Math.sin(time * 0.75 + phase) * 0.10
      : 0.88 + Math.sin(time * 0.23 + phase) * 0.10;
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      material.opacity = Math.max(0.01, (material.userData.atmosphereBaseOpacity || 0.1) * pulse);
    }
  }
}

export function disposeCrashWorld(worldView) {
  if (!worldView || worldView.disposed) return false;
  worldView.disposed = true;
  worldView.atmosphere.length = 0;
  return true;
}
