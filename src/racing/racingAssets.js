import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  RALLY_ASSET_MANIFEST,
  rallyAssetIds,
  trialsAssetIds,
} from './racingManifest.js';
import { getCapabilitiesForRendererSource } from '../rendering/rendererAccess.js';

const _cache = new Map();
const _loader = new THREE.TextureLoader();
// The vendored r185 DRACOLoader resolves its matching worker and WASM payload
// relative to itself; no CDN or version-skewed decoder override is required.
const _dracoLoader = new DRACOLoader();
const _gltfLoader = new GLTFLoader();
_gltfLoader.setMeshoptDecoder(MeshoptDecoder);
_gltfLoader.setDRACOLoader(_dracoLoader);

function _configureTexture(texture, spec, rendererSource) {
  texture.colorSpace = spec.kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (spec.repeat) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.fromArray(spec.repeat);
  } else {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  const maxAnisotropy = getCapabilitiesForRendererSource(rendererSource).maxAnisotropy || 1;
  texture.anisotropy = Math.min(8, maxAnisotropy);
  // TextureLoader marks the texture dirty after image decode. Setting this on
  // the synchronous placeholder causes the renderer to warn every frame.
  if (texture.image) texture.needsUpdate = true;
  return texture;
}

function _acquire(id, rendererSource) {
  const spec = RALLY_ASSET_MANIFEST[id];
  if (!spec) throw new Error(`[Kaki Rally assets] Unknown manifest id: ${id}`);
  let entry = _cache.get(spec.url);
  if (!entry) {
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const fail = (error) => {
      const detail = error?.message || error?.type || 'unknown load error';
      console.error(`[Kaki Rally assets] Failed to load ${id} from ${spec.url}: ${detail}`);
      rejectReady(new Error(`Kaki Rally production asset failed: ${spec.url}`));
    };
    if (spec.kind === 'model') {
      entry = { id, url: spec.url, kind: 'model', gltf: null, refs: 0, ready };
      _gltfLoader.load(spec.url, (gltf) => {
        entry.gltf = gltf;
        resolveReady(gltf);
      }, undefined, fail);
    } else {
      const texture = _configureTexture(_loader.load(
        spec.url,
        (loaded) => {
          _configureTexture(loaded, spec, rendererSource);
          resolveReady(loaded);
        },
        undefined,
        fail,
      ), spec, rendererSource);
      entry = { id, url: spec.url, kind: 'texture', texture, refs: 0, ready };
    }
    _cache.set(spec.url, entry);
  }
  entry.refs += 1;
  return entry;
}

/**
 * Create a reference-counted texture lease. Textures are immediately usable;
 * `ready` resolves after every image has decoded and rejects loudly on failure.
 */
export function createRallyAssetLease({
  courseId = 'forest',
  mode = 'circuit',
  monsterVehicleId = 'meowster',
  renderer = null,
  rendererService = null,
  trials = false,
} = {}) {
  const ids = trials ? trialsAssetIds(courseId) : rallyAssetIds(courseId, mode, monsterVehicleId);
  const entries = ids.map((id) => _acquire(id, rendererService || renderer));
  const textureEntries = entries.filter((entry) => entry.kind === 'texture');
  const entriesById = Object.fromEntries(ids.map((id, index) => [id, entries[index]]));
  const textures = Object.fromEntries(textureEntries.map((entry) => [entry.id, entry.texture]));
  const texturesByUrl = Object.fromEntries(textureEntries.map((entry) => [entry.url, entry.texture]));
  const models = {};
  let released = false;
  return {
    ids: [...ids],
    textures,
    models,
    texturesByUrl,
    getTextureByUrl(url) {
      const source = String(url || '').replaceAll('\\', '/');
      const assetAt = source.lastIndexOf('/assets/');
      const normalized = (assetAt >= 0 ? source.slice(assetAt + 1) : source)
        .replace(/^\.\.\/\.\.\//, '')
        .replace(/^\/?assets\//, 'assets/');
      return texturesByUrl[normalized] || null;
    },
    getModelMesh(name, modelId = 'environmentKitV2') {
      const object = models[modelId]?.scene?.getObjectByName?.(name) || null;
      if (!object || object.isMesh) return object;
      let mesh = null;
      object.traverse?.((child) => {
        if (!mesh && child.isMesh) mesh = child;
      });
      return mesh;
    },
    getModelMeshes(name, modelId = 'environmentKitV2') {
      const object = models[modelId]?.scene?.getObjectByName?.(name) || null;
      if (!object) return [];
      if (object.isMesh) return [object];
      const meshes = [];
      object.traverse?.((child) => {
        if (child.isMesh) meshes.push(child);
      });
      return meshes;
    },
    /** Resolve one production asset without coupling it to the full lease. */
    whenReady(id) {
      const entry = entriesById[id];
      if (!entry) return Promise.reject(new Error(`[Kaki Rally assets] Asset ${id} is not part of this lease`));
      return entry.ready.then((asset) => {
        if (entry.kind === 'model') models[id] = entry.gltf;
        return asset;
      });
    },
    ready: Promise.all(entries.map((entry) => entry.ready)).then(() => {
      for (const id of ids) {
        const entry = entriesById[id];
        if (entry.kind === 'model') models[id] = entry.gltf;
      }
      return { textures, models };
    }),
    release() {
      if (released) return;
      released = true;
      for (const entry of entries) {
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0) {
          if (entry.kind === 'texture') entry.texture.dispose();
          else entry.gltf?.scene?.traverse?.((object) => {
            object.geometry?.dispose?.();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) material?.dispose?.();
          });
          _cache.delete(entry.url);
        }
      }
    },
  };
}

export function getRallyAssetCacheSnapshot() {
  return [..._cache.values()].map(({ id, url, refs, kind, texture, gltf }) => ({
    id,
    url,
    refs,
    kind,
    loaded: kind === 'model' ? !!gltf?.scene : !!texture?.image,
    colorSpace: texture?.colorSpace || '',
  }));
}
