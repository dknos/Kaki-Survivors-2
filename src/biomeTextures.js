import * as THREE from 'three';

export const BIOME_FLAGSTONE_URL = 'assets/textures/biome_flagstone_512.webp';
export const BIOME_FLAGSTONE_REPEAT = 240;

let _flagstone = null;

/** App-lifetime singleton shared by the full-map ground and route meshes. */
export function getBiomeFlagstoneTexture(anisotropy = null) {
  if (!_flagstone) {
    _flagstone = new THREE.TextureLoader().load(BIOME_FLAGSTONE_URL, (t) => { t.needsUpdate = true; });
    _flagstone.wrapS = _flagstone.wrapT = THREE.RepeatWrapping;
    _flagstone.repeat.set(BIOME_FLAGSTONE_REPEAT, BIOME_FLAGSTONE_REPEAT);
    _flagstone.colorSpace = THREE.SRGBColorSpace;
  }
  if (Number.isFinite(anisotropy)) _flagstone.anisotropy = Math.max(_flagstone.anisotropy || 1, anisotropy);
  return _flagstone;
}
