export const SOFTWARE_WEBGPU_ARGS = Object.freeze([
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--use-vulkan=swiftshader',
  '--enable-dawn-features=allow_unsafe_apis',
  '--enable-precise-memory-info',
]);

export const SOFTWARE_WEBGL_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-precise-memory-info',
]);

function parseOverride(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch (_) {}
  return String(raw).split(/\s+/).filter(Boolean);
}

/** Choose a software-GPU profile that can actually satisfy the request. */
export function resolveChromiumArgs(backend = 'auto', override = null) {
  const explicit = parseOverride(override);
  if (explicit) return explicit;
  return backend === 'webgpu'
    ? [...SOFTWARE_WEBGPU_ARGS]
    : [...SOFTWARE_WEBGL_ARGS];
}
