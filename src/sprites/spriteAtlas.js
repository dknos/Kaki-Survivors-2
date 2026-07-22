/** Backward-compatible v1/v2 sprite-atlas loader and v2 hot-table compiler. */
import * as THREE from 'three';

const _atlases = new Map();
const _loading = new Map();

export const ENEMY_SPRITE_COMPLETION = Object.freeze({
  loop: 0,
  fallback: 1,
  release: 2,
});

const FILTERS = Object.freeze({
  nearest: THREE.NearestFilter,
  linear: THREE.LinearFilter,
  'nearest-mipmap-nearest': THREE.NearestMipmapNearestFilter,
  'nearest-mipmap-linear': THREE.NearestMipmapLinearFilter,
  'linear-mipmap-nearest': THREE.LinearMipmapNearestFilter,
  'linear-mipmap-linear': THREE.LinearMipmapLinearFilter,
});

function fail(jsonUrl, message) {
  throw new Error(`[spriteAtlas] ${jsonUrl}: ${message}`);
}

function finitePositive(jsonUrl, value, label) {
  if (!Number.isFinite(value) || value <= 0) fail(jsonUrl, `bad/missing "${label}"`);
}

function integerPositive(jsonUrl, value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    fail(jsonUrl, `bad/missing integer "${label}"`);
  }
}

function validatePage(jsonUrl, page, pageIndex) {
  if (!page || typeof page !== 'object') fail(jsonUrl, `page ${pageIndex} must be an object`);
  if (!Number.isInteger(page.id) || page.id !== pageIndex) {
    fail(jsonUrl, `page ${pageIndex} id must be dense numeric id ${pageIndex}`);
  }
  if (typeof page.image !== 'string' || !page.image) fail(jsonUrl, `page ${pageIndex} missing image`);
  for (const key of ['frameWidth', 'frameHeight', 'cols', 'rows', 'frameCount']) {
    integerPositive(
      jsonUrl,
      page[key],
      `pages[${pageIndex}].${key}`,
      key === 'frameCount' ? 65535 : Number.MAX_SAFE_INTEGER,
    );
  }
  if (page.frameCount > page.cols * page.rows) {
    fail(jsonUrl, `page ${pageIndex} frameCount exceeds its grid`);
  }
}

function validateV1(jsonUrl, json) {
  if (typeof json.image !== 'string') fail(jsonUrl, 'missing "image"');
  for (const key of ['frameWidth', 'frameHeight', 'cols', 'rows', 'frameCount']) {
    finitePositive(jsonUrl, json[key], key);
  }
  if (json.frameCount > json.cols * json.rows) {
    fail(jsonUrl, `frameCount (${json.frameCount}) > cols*rows (${json.cols * json.rows})`);
  }
  if (json.anims) {
    for (const [name, animation] of Object.entries(json.anims)) {
      if (!Number.isFinite(animation.from) || !Number.isFinite(animation.to) || !Number.isFinite(animation.fps)) {
        fail(jsonUrl, `anim "${name}" missing from/to/fps`);
      }
      if (animation.from < 0 || animation.to >= json.frameCount || animation.from > animation.to) {
        fail(jsonUrl, `anim "${name}" range [${animation.from}..${animation.to}] out of bounds (frameCount=${json.frameCount})`);
      }
    }
  }
}

function validateV2(jsonUrl, json) {
  if (json.kind !== 'enemy-atlas') fail(jsonUrl, 'v2 kind must be "enemy-atlas"');
  if (!Array.isArray(json.pages) || json.pages.length < 1 || json.pages.length > 2) {
    fail(jsonUrl, 'v2 pages must contain one or two pages');
  }
  json.pages.forEach((page, index) => validatePage(jsonUrl, page, index));
  integerPositive(jsonUrl, json.frameCount, 'frameCount', 65535);
  const pageFrameCount = json.pages.reduce((sum, page) => sum + page.frameCount, 0);
  if (json.frameCount !== pageFrameCount) {
    fail(jsonUrl, `frameCount (${json.frameCount}) must equal page total (${pageFrameCount})`);
  }
  integerPositive(jsonUrl, json.stateCount, 'stateCount', 255);
  if (!Number.isInteger(json.directionCount) || json.directionCount < 4 || json.directionCount > 255) {
    fail(jsonUrl, 'directionCount must be an integer from 4 through 255');
  }
  if (!Array.isArray(json.species) || json.species.length === 0) fail(jsonUrl, 'v2 species must be non-empty');
  if (!json.framePadding || !Number.isInteger(json.framePadding.gutterPixels) || json.framePadding.gutterPixels < 0) {
    fail(jsonUrl, 'v2 framePadding.gutterPixels is required');
  }
  if (!Number.isInteger(json.framePadding.alphaDilationPixels) || json.framePadding.alphaDilationPixels < 0) {
    fail(jsonUrl, 'v2 framePadding.alphaDilationPixels is required');
  }
  for (const page of json.pages) {
    if (json.framePadding.gutterPixels * 2 >= Math.min(page.frameWidth, page.frameHeight)) {
      fail(jsonUrl, `page ${page.id} gutter leaves no frame content`);
    }
  }
  if (!json.texture || typeof json.texture.magFilter !== 'string' || typeof json.texture.minFilter !== 'string') {
    fail(jsonUrl, 'v2 texture filtering metadata is required');
  }
  if (!(json.texture.magFilter in FILTERS) || !(json.texture.minFilter in FILTERS)) {
    fail(jsonUrl, 'v2 texture filter is unsupported');
  }
  if (typeof json.texture.generateMipmaps !== 'boolean') {
    fail(jsonUrl, 'v2 texture.generateMipmaps must be boolean');
  }
  if (json.alphaTest != null && (!Number.isFinite(json.alphaTest) || json.alphaTest < 0 || json.alphaTest > 1)) {
    fail(jsonUrl, 'v2 alphaTest must be within [0, 1]');
  }

  const speciesIds = new Set();
  const speciesNames = new Set();
  for (const species of json.species) {
    if (!Number.isInteger(species.id) || species.id < 0 || species.id > 255 || speciesIds.has(species.id)) {
      fail(jsonUrl, `species "${species.name}" has a bad/duplicate numeric id`);
    }
    if (typeof species.name !== 'string' || !species.name || speciesNames.has(species.name)) {
      fail(jsonUrl, `species id ${species.id} has a bad/duplicate name`);
    }
    speciesIds.add(species.id);
    speciesNames.add(species.name);
    if (!Number.isInteger(species.fallbackState) || species.fallbackState < 0 || species.fallbackState >= json.stateCount) {
      fail(jsonUrl, `${species.name}: bad fallbackState`);
    }
    if (!Number.isInteger(species.defaultDirection)
        || species.defaultDirection < 0 || species.defaultDirection >= json.directionCount) {
      fail(jsonUrl, `${species.name}: bad defaultDirection`);
    }
    finitePositive(jsonUrl, species.nominalSpeed, `${species.name}.nominalSpeed`);
    finitePositive(jsonUrl, species.playbackRate?.min, `${species.name}.playbackRate.min`);
    finitePositive(jsonUrl, species.playbackRate?.max, `${species.name}.playbackRate.max`);
    if (species.playbackRate.min > species.playbackRate.max) fail(jsonUrl, `${species.name}: playback rate min > max`);
    if (!Number.isInteger(species.motionKind) || species.motionKind < 0 || species.motionKind > 255) {
      fail(jsonUrl, `${species.name}: motionKind must be a numeric byte id`);
    }
    if (!Array.isArray(species.states) || species.states.length === 0) fail(jsonUrl, `${species.name}: missing states`);
    const stateIds = new Set();
    for (const state of species.states) {
      if (!Number.isInteger(state.id) || state.id < 0 || state.id >= json.stateCount || stateIds.has(state.id)) {
        fail(jsonUrl, `${species.name}: bad/duplicate state id ${state.id}`);
      }
      if (typeof state.name !== 'string' || !state.name) fail(jsonUrl, `${species.name}: state ${state.id} is missing a name`);
      stateIds.add(state.id);
      finitePositive(jsonUrl, state.fps, `${species.name}.${state.name}.fps`);
      if (typeof state.loop !== 'boolean') fail(jsonUrl, `${species.name}.${state.name}: loop must be boolean`);
      if (!(state.completion in ENEMY_SPRITE_COMPLETION)) {
        fail(jsonUrl, `${species.name}.${state.name}: bad completion ${state.completion}`);
      }
      if (state.completion === 'fallback') {
        if (!Number.isInteger(state.fallbackState)
            || state.fallbackState < 0 || state.fallbackState >= json.stateCount) {
          fail(jsonUrl, `${species.name}.${state.name}: bad fallbackState`);
        }
      }
      if (!Array.isArray(state.directions) || state.directions.length < json.directionCount) {
        fail(jsonUrl, `${species.name}.${state.name}: missing directions`);
      }
      const directionIds = new Set();
      for (const direction of state.directions) {
        if (!Number.isInteger(direction.id) || direction.id < 0
            || direction.id >= json.directionCount || directionIds.has(direction.id)) {
          fail(jsonUrl, `${species.name}.${state.name}: bad/duplicate direction id`);
        }
        directionIds.add(direction.id);
        if (!Number.isInteger(direction.page) || direction.page < 0 || direction.page >= json.pages.length) {
          fail(jsonUrl, `${species.name}.${state.name}.dir${direction.id}: bad page`);
        }
        const page = json.pages[direction.page];
        if (!Number.isInteger(direction.from) || !Number.isInteger(direction.to)
            || direction.from < 0 || direction.from > direction.to || direction.to >= page.frameCount) {
          fail(jsonUrl, `${species.name}.${state.name}.dir${direction.id}: frame range out of bounds`);
        }
        if (direction.mirror != null && typeof direction.mirror !== 'boolean') {
          fail(jsonUrl, `${species.name}.${state.name}.dir${direction.id}: mirror must be boolean`);
        }
      }
    }
    if (!stateIds.has(species.fallbackState)) fail(jsonUrl, `${species.name}: fallback state is not declared`);
  }
}

/** Pure schema validation exported for focused Node tests and build tooling. */
export function validateAtlasSchema(jsonUrl, json) {
  if (!json || typeof json !== 'object') fail(jsonUrl, 'descriptor must be an object');
  if (json.version === 1) validateV1(jsonUrl, json);
  else if (json.version === 2) validateV2(jsonUrl, json);
  else fail(jsonUrl, `unsupported version ${json.version} (expected 1 or 2)`);
  if (json.blendMode && !['alpha', 'additive'].includes(json.blendMode)) fail(jsonUrl, `bad blendMode "${json.blendMode}"`);
  if (json.billboard && !['screen', 'cylinder', 'none'].includes(json.billboard)) fail(jsonUrl, `bad billboard "${json.billboard}"`);
  return true;
}

function tableIndex(speciesId, stateId, directionId, stateCount, directionCount) {
  return ((speciesId * stateCount + stateId) * directionCount) + directionId;
}

/** Compile all string-rich v2 authoring metadata into allocation-free typed tables. */
export function compileEnemyAtlasV2(json) {
  const speciesCapacity = Math.max(...json.species.map((entry) => entry.id)) + 1;
  const stateCount = json.stateCount;
  const directionCount = json.directionCount;
  const tableLength = speciesCapacity * stateCount * directionCount;
  const compiled = {
    speciesCapacity,
    stateCount,
    directionCount,
    from: new Uint16Array(tableLength),
    to: new Uint16Array(tableLength),
    page: new Uint8Array(tableLength),
    fps: new Float32Array(tableLength),
    loop: new Uint8Array(tableLength),
    flip: new Uint8Array(tableLength),
    completion: new Uint8Array(tableLength),
    fallbackForState: new Uint8Array(tableLength),
    valid: new Uint8Array(tableLength),
    fallbackState: new Uint8Array(speciesCapacity),
    defaultDirection: new Uint8Array(speciesCapacity),
    motionKind: new Uint8Array(speciesCapacity),
    nominalSpeed: new Float32Array(speciesCapacity),
    rateMin: new Float32Array(speciesCapacity),
    rateMax: new Float32Array(speciesCapacity),
    speciesValid: new Uint8Array(speciesCapacity),
    speciesByName: new Map(),
  };
  for (const species of json.species) {
    const speciesId = species.id;
    compiled.speciesValid[speciesId] = 1;
    compiled.speciesByName.set(species.name, speciesId);
    compiled.fallbackState[speciesId] = species.fallbackState;
    compiled.defaultDirection[speciesId] = species.defaultDirection;
    compiled.motionKind[speciesId] = species.motionKind ?? 0;
    compiled.nominalSpeed[speciesId] = species.nominalSpeed;
    compiled.rateMin[speciesId] = species.playbackRate.min;
    compiled.rateMax[speciesId] = species.playbackRate.max;
    for (const state of species.states) {
      for (const direction of state.directions) {
        const index = tableIndex(speciesId, state.id, direction.id, stateCount, directionCount);
        compiled.from[index] = direction.from;
        compiled.to[index] = direction.to;
        compiled.page[index] = direction.page;
        compiled.fps[index] = state.fps;
        compiled.loop[index] = state.loop ? 1 : 0;
        compiled.flip[index] = direction.mirror ? 1 : 0;
        compiled.completion[index] = ENEMY_SPRITE_COMPLETION[state.completion];
        compiled.fallbackForState[index] = state.fallbackState ?? species.fallbackState;
        compiled.valid[index] = 1;
      }
    }
  }
  compiled.index = (speciesId, stateId, directionId) => (
    tableIndex(speciesId, stateId, directionId, stateCount, directionCount)
  );
  return compiled;
}

function textureSettings(json) {
  const texture = json.texture ?? {};
  return {
    magFilter: FILTERS[texture.magFilter ?? 'nearest'] ?? THREE.NearestFilter,
    minFilter: FILTERS[texture.minFilter ?? 'nearest'] ?? THREE.NearestFilter,
    generateMipmaps: texture.generateMipmaps ?? false,
    anisotropy: Math.max(1, Math.min(16, Number(texture.anisotropy) || 1)),
  };
}

function loadTexture(imageUrl, json, expectedPage) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(imageUrl, (texture) => {
      const width = texture.image?.naturalWidth ?? texture.image?.width;
      const height = texture.image?.naturalHeight ?? texture.image?.height;
      if (expectedPage && (width !== expectedPage.cols * expectedPage.frameWidth
          || height !== expectedPage.rows * expectedPage.frameHeight)) {
        texture.dispose();
        reject(new Error(`[spriteAtlas] ${imageUrl}: image dimensions ${width}x${height} do not match grid`));
        return;
      }
      const settings = textureSettings(json);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = settings.magFilter;
      texture.minFilter = settings.minFilter;
      texture.generateMipmaps = settings.generateMipmaps;
      texture.anisotropy = settings.anisotropy;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      resolve(texture);
    }, undefined, reject);
  });
}

function commonRecord(id, json) {
  return {
    id,
    version: json.version,
    kind: json.kind ?? 'sprite-atlas',
    pixelsPerWorldUnit: json.pixelsPerWorldUnit ?? 24,
    anchor: json.anchor ?? [0.5, 0.5],
    blendMode: json.blendMode ?? 'alpha',
    alphaTest: typeof json.alphaTest === 'number' ? json.alphaTest : 0.01,
    cutout: json.cutout ?? (json.alphaTest >= 0.5),
    depthWrite: json.depthWrite ?? (json.alphaTest >= 0.5),
    alphaToCoverage: !!json.alphaToCoverage,
    bloom: !!json.bloom,
    billboard: json.billboard ?? 'screen',
    framePadding: json.framePadding ?? { gutterPixels: 0, alphaDilationPixels: 0 },
    textureConfig: json.texture ?? {
      magFilter: 'nearest', minFilter: 'nearest', generateMipmaps: false, anisotropy: 1,
    },
    palette: json.palette ?? 'neutral',
    fallbackAtlas: json.fallbackAtlas ?? null,
  };
}

async function createRecord(id, jsonUrl, json) {
  const base = jsonUrl.replace(/\/[^/]+$/, '/');
  if (json.version === 1) {
    const imageUrl = base + json.image;
    const texture = await loadTexture(imageUrl, json, json);
    return {
      ...commonRecord(id, json),
      imageUrl,
      frameWidth: json.frameWidth,
      frameHeight: json.frameHeight,
      cols: json.cols,
      rows: json.rows,
      frameCount: json.frameCount,
      anims: json.anims ?? { default: { from: 0, to: json.frameCount - 1, fps: 12, loop: false } },
      texture,
      pages: [{
        id: 0, image: json.image, imageUrl, texture,
        frameWidth: json.frameWidth, frameHeight: json.frameHeight,
        cols: json.cols, rows: json.rows, frameCount: json.frameCount,
      }],
      compiled: null,
    };
  }

  const loadedPages = [];
  try {
    for (const page of json.pages) {
      const imageUrl = base + page.image;
      const texture = await loadTexture(imageUrl, json, page);
      loadedPages.push({ ...page, imageUrl, texture });
    }
  } catch (error) {
    for (const page of loadedPages) page.texture.dispose();
    throw error;
  }
  const first = loadedPages[0];
  return {
    ...commonRecord(id, json),
    imageUrl: first.imageUrl,
    frameWidth: first.frameWidth,
    frameHeight: first.frameHeight,
    cols: first.cols,
    rows: first.rows,
    frameCount: json.frameCount,
    anims: null,
    texture: first.texture,
    pages: loadedPages,
    compiled: compileEnemyAtlasV2(json),
    source: json,
  };
}

export async function loadAtlas(id, jsonUrl) {
  if (_atlases.has(id)) return _atlases.get(id);
  if (_loading.has(id)) return _loading.get(id);
  const promise = (async () => {
    const response = await fetch(jsonUrl);
    if (!response.ok) throw new Error(`[spriteAtlas] fetch failed: ${jsonUrl} (${response.status})`);
    const json = await response.json();
    validateAtlasSchema(jsonUrl, json);
    const record = await createRecord(id, jsonUrl, json);
    _atlases.set(id, record);
    return record;
  })();
  _loading.set(id, promise);
  try {
    return await promise;
  } finally {
    _loading.delete(id);
  }
}

export function getAtlas(id) {
  return _atlases.get(id) ?? null;
}

export function getEnemySpriteSpeciesId(id, name) {
  const atlas = _atlases.get(id);
  return atlas?.compiled?.speciesByName.get(name) ?? -1;
}

export function listAtlasIds() {
  return Array.from(_atlases.keys());
}

/**
 * Synchronous texture injection for focused Node tests. Production bootstrap
 * must use loadAtlas so image dimensions and network failures are exercised.
 */
export function _registerAtlasForTests(id, json, textures) {
  validateAtlasSchema(`<test:${id}>`, json);
  const supplied = Array.isArray(textures) ? textures : [textures];
  if (json.version === 1) {
    const map = supplied[0];
    if (!map?.isTexture) throw new TypeError('[spriteAtlas] test registration requires a Texture');
    const record = {
      ...commonRecord(id, json),
      imageUrl: json.image,
      frameWidth: json.frameWidth,
      frameHeight: json.frameHeight,
      cols: json.cols,
      rows: json.rows,
      frameCount: json.frameCount,
      anims: json.anims ?? { default: { from: 0, to: json.frameCount - 1, fps: 12, loop: false } },
      texture: map,
      pages: [{
        id: 0, image: json.image, imageUrl: json.image, texture: map,
        frameWidth: json.frameWidth, frameHeight: json.frameHeight,
        cols: json.cols, rows: json.rows, frameCount: json.frameCount,
      }],
      compiled: null,
    };
    _atlases.set(id, record);
    return record;
  }
  if (supplied.length !== json.pages.length || supplied.some((map) => !map?.isTexture)) {
    throw new TypeError('[spriteAtlas] test registration requires one Texture per page');
  }
  const pages = json.pages.map((page, index) => ({
    ...page,
    imageUrl: page.image,
    texture: supplied[index],
  }));
  const first = pages[0];
  const record = {
    ...commonRecord(id, json),
    imageUrl: first.imageUrl,
    frameWidth: first.frameWidth,
    frameHeight: first.frameHeight,
    cols: first.cols,
    rows: first.rows,
    frameCount: json.frameCount,
    anims: null,
    texture: first.texture,
    pages,
    compiled: compileEnemyAtlasV2(json),
    source: json,
  };
  _atlases.set(id, record);
  return record;
}

export function disposeAtlases() {
  for (const atlas of _atlases.values()) {
    const disposed = new Set();
    for (const page of atlas.pages ?? []) {
      if (page.texture && !disposed.has(page.texture)) {
        disposed.add(page.texture);
        page.texture.dispose();
      }
    }
  }
  _atlases.clear();
  _loading.clear();
}
