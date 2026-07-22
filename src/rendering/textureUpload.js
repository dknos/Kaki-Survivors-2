/**
 * Mark a decoded texture for upload without exposing WebGPU to the null-image
 * placeholder returned synchronously by TextureLoader.
 *
 * TextureLoader performs the real version bump after it assigns the decoded
 * image. Callers only need an extra bump when they reconfigure a texture that
 * is already ready (for example, changing its wrapping mode).
 */
export function requestTextureUploadIfReady(texture) {
  if (!texture?.image) return false;
  texture.needsUpdate = true;
  return true;
}

/**
 * Clone a texture whose TextureLoader source may still be decoding.
 *
 * Three r185 increments a clone's version during `Texture.copy()`. That is
 * normally useful, but it makes a clone of a null-image loader placeholder
 * look upload-ready to WebGPURenderer. The clone still shares the source's
 * image, so its owner can call requestTextureUploadIfReady after the asset
 * lease resolves.
 */
export function cloneTextureForDeferredUpload(source) {
  const sharedSource = source?.source;
  const sharedSourceVersion = sharedSource?.version;
  const texture = source?.clone?.();
  if (!texture) return null;
  if (!texture.image) {
    // `version` is a writable numeric field on both pinned r185 objects. This
    // clone has not been published to a material or renderer yet, so clearing
    // copy()'s premature Texture and shared Source bumps cannot invalidate an
    // existing backend resource.
    texture.version = 0;
    if (sharedSource && Number.isFinite(sharedSourceVersion)) {
      sharedSource.version = sharedSourceVersion;
    }
  }
  return texture;
}
