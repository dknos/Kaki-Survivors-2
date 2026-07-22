/**
 * Shared non-ring marker for world pickups and reward containers.
 *
 * A Forest run used to have several unrelated gold rune circles: consumables,
 * weapon relics, treasure chests, and evolution coffins each brought their own
 * variant.  Aside from looking like unexplained ground AoEs, those markers
 * stayed visible when their tiny body art was occluded by authored terrain.
 *
 * This helper gives every reward the same compact Grok-authored paw-and-
 * whisker badge.  It is deliberately not a halo, circle, or bloom source:
 * the pickup body owns identity, while this only answers "this is worth
 * walking to".  Callers still own placement, animation, pool lifetime, and
 * disposal.
 */
import * as THREE from 'three';
import { fxTex, fxTier } from '../fxTextures.js';
import { tex } from '../particleTextures.js';

/**
 * Create a floor-parallel reward marker.
 *
 * @param {{
 *   size?: number,
 *   opacity?: number,
 *   cap?: number,
 *   instanced?: boolean,
 *   gameplayPurpose?: string,
 *   userData?: object,
 * }} opts
 */
export function createPickupMarker(opts = {}) {
  const size = opts.size != null ? opts.size : 1.12;
  const instanced = !!opts.instanced;
  const cap = opts.cap | 0;
  if (instanced && cap < 1) {
    throw new Error('createPickupMarker: instanced markers require cap >= 1');
  }

  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    // The fallback is a compact white twinkle, never a legacy ring. It only
    // appears if the manifest itself is unavailable during a dev boot.
    map: fxTex('pickup_paw_aura') || tex('twinkle'),
    color: 0xffffff,
    transparent: true,
    opacity: opts.opacity != null ? opts.opacity : 0.76,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = instanced
    ? new THREE.InstancedMesh(geometry, material, cap)
    : new THREE.Mesh(geometry, material);
  if (instanced) {
    // A hidden zero-scale matrix can still be submitted as a draw. Callers
    // raise this as slots become live, so unopened pools cost no instances.
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
  }
  mesh.renderOrder = fxTier('kill_pickup');
  mesh.userData.visualRole = 'interactive_pickup_marker';
  mesh.userData.asset = 'pickup_paw_aura';
  mesh.userData.gameplayPurpose = opts.gameplayPurpose || 'walk-to reward marker';
  if (opts.userData) Object.assign(mesh.userData, opts.userData);

  return { geometry, material, mesh };
}
