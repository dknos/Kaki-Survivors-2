import * as THREE from 'three';
import { deformDamageMeshes } from './crashDamage.js';

const pointScratch = new THREE.Vector3();
const normalScratch = new THREE.Vector3();
const worldPointScratch = new THREE.Vector3();
const worldNormalScratch = new THREE.Vector3();
const pivotQuaternionScratch = new THREE.Quaternion();
const meshQuaternionScratch = new THREE.Quaternion();
const scaleScratch = new THREE.Vector3();

function morphIndex(mesh, zone) {
  const dictionary = mesh?.morphTargetDictionary;
  if (!dictionary) return -1;
  const key = Object.keys(dictionary).find((name) => {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === `damage${zone}` || normalized === `${zone}damage` || normalized === `crush${zone}`;
  });
  return key == null ? -1 : dictionary[key];
}

function applyMorphDamage(mesh, zones = {}, exact = false) {
  if (!mesh?.morphTargetInfluences) return false;
  let matched = false;
  for (const zone of ['front', 'rear', 'left', 'right']) {
    const index = morphIndex(mesh, zone);
    if (index < 0) continue;
    const value = Math.min(1, Math.max(0, Number(zones[zone]) || 0));
    mesh.morphTargetInfluences[index] = exact ? value : Math.max(mesh.morphTargetInfluences[index] || 0, value);
    matched = true;
  }
  return matched;
}

function deformInMeshSpace(entity, mesh, localPoint, localNormal, amount, radius) {
  const pivot = entity.visual?.bodyPivot;
  if (!pivot || !mesh?.geometry) return 0;
  pivot.updateWorldMatrix(true, true);
  mesh.updateWorldMatrix(true, false);
  pointScratch.set(localPoint?.x || 0, localPoint?.y || 0, localPoint?.z || 0);
  normalScratch.set(localNormal?.x || 0, localNormal?.y || 0, localNormal?.z || 0).normalize();
  worldPointScratch.copy(pointScratch);
  pivot.localToWorld(worldPointScratch);
  pivot.getWorldQuaternion(pivotQuaternionScratch);
  worldNormalScratch.copy(normalScratch).applyQuaternion(pivotQuaternionScratch).normalize();
  const meshPoint = mesh.worldToLocal(worldPointScratch.clone());
  mesh.getWorldQuaternion(meshQuaternionScratch).invert();
  const meshNormal = worldNormalScratch.clone().applyQuaternion(meshQuaternionScratch).normalize();
  mesh.getWorldScale(scaleScratch);
  const uniformScale = Math.max(0.0001, (Math.abs(scaleScratch.x) + Math.abs(scaleScratch.y) + Math.abs(scaleScratch.z)) / 3);
  return deformDamageMeshes([mesh], meshPoint, meshNormal, amount, radius / uniformScale, 0.34 / uniformScale);
}

function updateGlass(glass, state) {
  if (!glass?.material) return;
  const materials = Array.isArray(glass.material) ? glass.material : [glass.material];
  for (const material of materials) {
    material.userData.crashBaseOpacity ??= material.opacity;
    material.userData.crashBaseRoughness ??= material.roughness;
    if (material.color && !material.userData.crashBaseColor) material.userData.crashBaseColor = material.color.clone();
    if (state === 'intact') {
      material.opacity = material.userData.crashBaseOpacity ?? material.opacity;
      if ('roughness' in material) material.roughness = material.userData.crashBaseRoughness ?? material.roughness;
      if (material.color && material.userData.crashBaseColor) material.color.copy(material.userData.crashBaseColor);
    } else if (state === 'cracked') {
      material.opacity = Math.min(material.userData.crashBaseOpacity ?? 1, 0.58);
      if ('roughness' in material) material.roughness = Math.max(material.userData.crashBaseRoughness || 0, 0.46);
      if (material.color && material.userData.crashBaseColor) material.color.copy(material.userData.crashBaseColor).lerp(new THREE.Color(0xb7dce4), 0.28);
    }
  }
  glass.visible = state !== 'shattered';
}

function updateDamageTint(entity, severity = 0) {
  const amount = Math.min(1, Math.max(0, Number(severity) || 0));
  entity.visual?.bodyPivot?.traverse?.((object) => {
    if (!object.isMesh || !object.material || object.userData?.role === 'wheel') return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.color) continue;
      material.userData.crashBaseColor ||= material.color.clone();
      material.userData.crashBaseRoughness ??= material.roughness;
      material.color.copy(material.userData.crashBaseColor).lerp(new THREE.Color(0x211916), Math.min(0.48, amount * 0.5));
      if ('roughness' in material) material.roughness = Math.min(1, (material.userData.crashBaseRoughness ?? material.roughness) + amount * 0.24);
    }
  });
}

export function applyCrashDamagePresentation(entity, event = {}) {
  if (!entity?.visual) return 0;
  if (entity.visual.productionModel) entity.visual.productionModel.visible = true;
  let moved = 0;
  for (const mesh of entity.visual.damageMeshes || []) {
    mesh.visible = true;
    if (!applyMorphDamage(mesh, event.zones || entity.damage?.zones)) {
      moved += deformInMeshSpace(entity, mesh, event.localPoint, event.localNormal, (Number(event.amount) || 0) * 2.2, Math.max(0.85, (entity.profile || entity.playerProfile)?.width * 0.66 || 1.1));
    }
  }
  for (const glass of entity.visual.glassPanels || []) updateGlass(glass, event.glass || entity.damage?.glass || 'intact');
  updateDamageTint(entity, event.severity ?? entity.damage?.severity ?? 0);
  return moved;
}

export function applyCrashDamageSnapshot(entity, snapshot = {}) {
  if (!entity?.visual) return false;
  if (entity.visual.productionModel) entity.visual.productionModel.visible = true;
  let authored = false;
  for (const mesh of entity.visual.damageMeshes || []) {
    mesh.visible = true;
    authored = applyMorphDamage(mesh, snapshot.damageZones || snapshot.zones || {}, true) || authored;
  }
  for (const glass of entity.visual.glassPanels || []) updateGlass(glass, snapshot.glass || 'intact');
  updateDamageTint(entity, snapshot.damage ?? snapshot.severity ?? 0);
  return authored;
}

export function resetCrashDamagePresentation(entity) {
  if (!entity?.visual) return;
  if (entity.visual.productionModel) entity.visual.productionModel.visible = true;
  for (const mesh of entity.visual.damageMeshes || []) {
    const position = mesh.geometry?.getAttribute?.('position');
    const originals = mesh.userData?.baseDamagePositions;
    if (position?.array && originals?.length === position.array.length) {
      position.array.set(originals);
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals?.();
      mesh.geometry.computeBoundingSphere?.();
    }
    if (mesh.morphTargetInfluences) mesh.morphTargetInfluences.fill(0);
    mesh.visible = true;
  }
  for (const glass of entity.visual.glassPanels || []) {
    glass.visible = true;
    const materials = Array.isArray(glass.material) ? glass.material : [glass.material];
    for (const material of materials) {
      if (!material) continue;
      if (material.userData.crashBaseOpacity != null) material.opacity = material.userData.crashBaseOpacity;
      if (material.userData.crashBaseRoughness != null) material.roughness = material.userData.crashBaseRoughness;
      if (material.color && material.userData.crashBaseColor) material.color.copy(material.userData.crashBaseColor);
    }
  }
  entity.visual.bodyPivot?.traverse?.((object) => {
    if (!object.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      if (material.color && material.userData.crashBaseColor) material.color.copy(material.userData.crashBaseColor);
      if ('roughness' in material && material.userData.crashBaseRoughness != null) material.roughness = material.userData.crashBaseRoughness;
    }
  });
}
