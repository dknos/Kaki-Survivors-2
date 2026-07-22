/**
 * Gate-3 TSL material gallery.
 *
 * This isolated page compiles and renders every completed custom material
 * family through the pinned r185 WebGPURenderer module universe. It exercises
 * the same node graphs on WebGPU and WebGPURenderer's forced WebGL 2 backend.
 */
import * as THREE from 'three/webgpu';
import { Mesh as RootThreeMesh } from 'three';

import { createRendererService } from '../rendering/createRenderer.js';
import {
  createCreatureAnimationController,
  createCreatureAnimationMaterial,
} from '../rendering/materials/creatureAnimationMaterial.js';
import {
  createDamageFlashController,
  createDamageFlashMaterial,
} from '../rendering/materials/damageFlashMaterial.js';
import {
  createTerrainRibbonMaterial,
  createWaterMaterial,
} from '../rendering/materials/landscapeMaterials.js';
import {
  createTwilightFogMaterial,
  createVoidChasmMaterial,
} from '../rendering/materials/hazardMaterials.js';
import { createRimLightMaterial } from '../rendering/materials/rimLightMaterial.js';
import {
  createCaveSkyDomeMaterial,
  createForestSkyDomeMaterial,
} from '../rendering/materials/skyDomeMaterials.js';
import { createForestGateVeilMaterial } from '../rendering/materials/telegraphMaterials.js';

const params = new URLSearchParams(window.location.search);
const requestedBackend = (params.get('renderer') || 'auto').toLowerCase();
const accessibilityMode = (params.get('accessibility') || 'standard').toLowerCase();
const reducedMotion = accessibilityMode === 'reduced' || params.get('reducedMotion') === '1';
const reducedFlashing = accessibilityMode === 'reduced' || params.get('reducedFlashing') === '1';
const canvas = document.querySelector('#gallery-canvas');
const statusElement = document.querySelector('#probe-status');
const detailsElement = document.querySelector('#probe-details');

const EXPECTED_FAMILIES = Object.freeze([
  'rim-light',
  'damage-flash-with-rim',
  'creature-crawl',
  'creature-flap',
  'creature-hover',
  'creature-inch',
  'water',
  'terrain-abyss-fracture',
  'terrain-lava-ravine',
  'twilight-fog',
  'void-chasm',
  'forest-gate-veil',
  'forest-sky-dome',
  'cave-sky-dome',
]);

const probe = {
  status: 'booting',
  requestedBackend,
  accessibilityMode,
  backend: null,
  backendFlags: {
    webgpu: false,
    webgl: false,
    webgpuDevice: null,
    webgl2Context: null,
  },
  threeRevision: THREE.REVISION,
  rendererIsWebGPURenderer: false,
  oneModuleUniverse: RootThreeMesh === THREE.Mesh,
  navigatorGpuPresent: Boolean(navigator.gpu),
  compiled: false,
  frameCount: 0,
  renderCalls: 0,
  animationSeconds: 0,
  animationAdvanced: false,
  accessibility: {
    reducedMotion,
    reducedFlashing,
    creatureAmplitude: reducedMotion ? 0 : 1,
    surfaceMotionScale: reducedMotion ? 0 : 1,
    flashAmount: reducedFlashing ? 0.18 : 1,
  },
  materials: {
    expectedCount: EXPECTED_FAMILIES.length,
    nodeMaterialCount: 0,
    physicalNodeMaterialCount: 0,
    customOutputCount: 0,
    families: [],
    missingFamilies: [...EXPECTED_FAMILIES],
    voidIgnoresInstanceColor: false,
    skyFactoryBackSide: false,
    skySwatchSideOverride: false,
  },
  renderInfo: {
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
  },
  samplePoints: {},
  runtimeErrors: [],
  error: null,
};

window.__kkWebGPUMaterialGallery = probe;

function setStatus(message, state = 'loading') {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function setDetails(message) {
  detailsElement.textContent = message;
}

function serializeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

window.addEventListener('error', (event) => {
  probe.runtimeErrors.push(event.message || 'window error');
});

window.addEventListener('unhandledrejection', (event) => {
  probe.runtimeErrors.push(`Unhandled rejection: ${serializeError(event.reason)}`);
});

function backendFlags(renderer) {
  const webgpu = renderer.backend?.isWebGPUBackend === true;
  const webgl = renderer.backend?.isWebGLBackend === true;
  const webgpuDevice = webgpu ? Boolean(renderer.backend?.device) : null;
  const webgl2Context = webgl
    ? (typeof WebGL2RenderingContext !== 'undefined'
      && renderer.backend?.gl instanceof WebGL2RenderingContext)
    : null;
  if (webgpu === webgl) {
    throw new Error(`Renderer backend flags are invalid (webgpu=${webgpu}, webgl=${webgl}).`);
  }
  return { webgpu, webgl, webgpuDevice, webgl2Context };
}

function createLabelTexture(text) {
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 512;
  labelCanvas.height = 96;
  const context = labelCanvas.getContext('2d');
  context.fillStyle = 'rgba(4, 7, 18, 0.90)';
  context.fillRect(4, 8, 504, 80);
  context.strokeStyle = 'rgba(157, 218, 255, 0.72)';
  context.lineWidth = 4;
  context.strokeRect(5, 9, 502, 78);
  context.fillStyle = '#fff0c7';
  context.font = '700 31px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 256, 49);
  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = `gallery-label-${text}`;
  return texture;
}

function addLabel(scene, text, x, y, z, width = 2.55) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: createLabelTexture(text),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  }));
  sprite.position.set(x, y, z);
  sprite.scale.set(width, width * 0.1875, 1);
  sprite.renderOrder = 1000;
  scene.add(sprite);
  return sprite;
}

function addPad(scene, x, z, width = 2.75, depth = 2.75) {
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.10, depth),
    new THREE.MeshStandardMaterial({
      color: 0x111b31,
      roughness: 0.91,
      metalness: 0.05,
    }),
  );
  pad.position.set(x, -0.09, z);
  pad.receiveShadow = true;
  scene.add(pad);
  return pad;
}

function createSkyTexture(top, bottom) {
  const textureCanvas = document.createElement('canvas');
  textureCanvas.width = 64;
  textureCanvas.height = 64;
  const context = textureCanvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function tagFamily(material, family, registry) {
  material.userData.tslMaterialFamily = family;
  registry.add(material);
  return material;
}

function addCharacterMaterials(scene, registry, animationControllers) {
  const z = -5.0;
  const xs = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5];
  const labels = ['RIM', 'DAMAGE + RIM', 'CRAWL', 'FLAP', 'HOVER', 'INCH'];
  for (let index = 0; index < xs.length; index += 1) addPad(scene, xs[index], z);

  // Hero GLBs using KHR_materials_specular/ior load as MeshPhysicalMaterial.
  // Keep the gallery's primary rim sample on that exact lighting-model path.
  const rimSource = new THREE.MeshPhysicalMaterial({
    color: 0x7053a6,
    roughness: 0.56,
    metalness: 0.08,
    emissive: 0x080315,
    emissiveIntensity: 0.26,
    ior: 1.42,
    specularIntensity: 0.74,
    specularColor: 0xcfe5ff,
    clearcoat: 0.16,
    clearcoatRoughness: 0.38,
  });
  const rimMaterial = tagFamily(
    createRimLightMaterial(rimSource),
    'rim-light',
    registry,
  );
  const rimMesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.62, 0.22, 96, 14), rimMaterial);
  rimMesh.position.set(xs[0], 1.05, z);
  rimMesh.castShadow = true;
  scene.add(rimMesh);

  const flashSource = new THREE.MeshStandardMaterial({
    color: 0x8b362e,
    roughness: 0.63,
    emissive: 0x210400,
    emissiveIntensity: 0.42,
  });
  const flashMaterial = tagFamily(
    createDamageFlashMaterial(createRimLightMaterial(flashSource)),
    'damage-flash-with-rim',
    registry,
  );
  const flashMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.82, 2), flashMaterial);
  flashMesh.position.set(xs[1], 1.00, z);
  flashMesh.castShadow = true;
  const flashRoot = new THREE.Group();
  flashRoot.add(flashMesh);
  scene.add(flashRoot);
  const flashController = createDamageFlashController(flashRoot, {
    amount: probe.accessibility.flashAmount,
  });

  const geometries = {
    crawl: new THREE.BoxGeometry(1.45, 1.25, 1.35, 8, 8, 8),
    flap: new THREE.BoxGeometry(2.20, 0.42, 0.82, 12, 4, 4),
    hover: new THREE.OctahedronGeometry(0.92, 3),
    inch: new THREE.SphereGeometry(0.78, 24, 14),
  };
  const kinds = ['crawl', 'flap', 'hover', 'inch'];
  kinds.forEach((kind, kindIndex) => {
    const source = new THREE.MeshStandardMaterial({
      color: [0x507a48, 0xc57549, 0x4f79a6, 0x9b657e][kindIndex],
      roughness: 0.72,
      metalness: 0.02,
      emissive: 0x03070b,
      emissiveIntensity: 0.18,
    });
    let material = createCreatureAnimationMaterial(source, { kind });
    material = createRimLightMaterial(material, { strength: 0.24 });
    tagFamily(material, `creature-${kind}`, registry);
    const mesh = new THREE.Mesh(geometries[kind], material);
    mesh.position.set(xs[kindIndex + 2], kind === 'flap' ? 1.18 : 1.0, z);
    if (kind === 'inch') mesh.scale.set(1.28, 0.88, 0.88);
    mesh.castShadow = true;
    scene.add(mesh);
    const controller = createCreatureAnimationController(mesh, {
      kind,
      amplitude: probe.accessibility.creatureAmplitude,
    });
    animationControllers.push(controller);
  });

  labels.forEach((label, index) => addLabel(scene, label, xs[index], 2.30, z, 2.35));
  return { flashController, animatedMeshes: kinds.length };
}

function flatGeometry(width = 2.45, depth = 2.45, segments = 24) {
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function addGroundMaterials(scene, registry, animatedMaterials) {
  const z = 0.2;
  const xs = [-6, -3, 0, 3, 6];
  const labels = ['WATER', 'ABYSS', 'LAVA', 'TWILIGHT FOG', 'VOID CHASM'];
  xs.forEach((x) => addPad(scene, x, z));

  const water = tagFamily(
    createWaterMaterial(0x071a38, 0x4ca9d1, 0.88),
    'water',
    registry,
  );
  water.setMotionScale(probe.accessibility.surfaceMotionScale);
  const waterInstance = new THREE.InstancedMesh(flatGeometry(), water, 1);
  waterInstance.position.set(xs[0], 0.02, z);
  waterInstance.setMatrixAt(0, new THREE.Matrix4());
  waterInstance.instanceMatrix.needsUpdate = true;
  scene.add(waterInstance);
  animatedMaterials.push(water);

  const abyss = tagFamily(createTerrainRibbonMaterial({
    kind: 'abyss-fracture',
    colors: { deep: 0x03010a, shallow: 0x38215f, edge: 0x4fc8e6 },
  }), 'terrain-abyss-fracture', registry);
  abyss.setMotionScale(probe.accessibility.surfaceMotionScale);
  const abyssMesh = new THREE.Mesh(flatGeometry(), abyss);
  abyssMesh.position.set(xs[1], 0.02, z);
  scene.add(abyssMesh);
  animatedMaterials.push(abyss);

  const lava = tagFamily(createTerrainRibbonMaterial({
    kind: 'lava-ravine',
    colors: { deep: 0x240200, shallow: 0xff5b12, edge: 0xffce55 },
  }), 'terrain-lava-ravine', registry);
  lava.setMotionScale(probe.accessibility.surfaceMotionScale);
  const lavaMesh = new THREE.Mesh(flatGeometry(), lava);
  lavaMesh.position.set(xs[2], 0.02, z);
  scene.add(lavaMesh);
  animatedMaterials.push(lava);

  const fog = tagFamily(createTwilightFogMaterial({
    heroX: xs[3],
    heroZ: z,
    inner: 0.45,
    outer: 1.42,
  }), 'twilight-fog', registry);
  const fogMesh = new THREE.Mesh(flatGeometry(), fog);
  fogMesh.position.set(xs[3], 0.09, z);
  scene.add(fogMesh);

  const chasm = tagFamily(createVoidChasmMaterial(), 'void-chasm', registry);
  const chasmInstance = new THREE.InstancedMesh(flatGeometry(), chasm, 1);
  const chasmMatrix = new THREE.Matrix4().makeTranslation(xs[4], 0.04, z);
  chasmInstance.setMatrixAt(0, chasmMatrix);
  chasmInstance.setColorAt(0, new THREE.Color(0x00ffff));
  chasmInstance.instanceMatrix.needsUpdate = true;
  if (chasmInstance.instanceColor) chasmInstance.instanceColor.needsUpdate = true;
  scene.add(chasmInstance);
  probe.materials.voidIgnoresInstanceColor = chasm.userData.ignoresInstanceColor === true
    && Boolean(chasmInstance.instanceColor);

  labels.forEach((label, index) => addLabel(scene, label, xs[index], 0.52, z - 1.18, 2.35));
}

function addVerticalMaterials(scene, registry, animatedMaterials) {
  const z = 5.15;
  const xs = [-5, 0, 5];
  const labels = ['FOREST GATE VEIL', 'FOREST SKY', 'CAVE SKY'];
  xs.forEach((x) => addPad(scene, x, z, 3.45, 0.72));

  const veil = tagFamily(
    createForestGateVeilMaterial(0x7df0c4),
    'forest-gate-veil',
    registry,
  );
  veil.setMotionScale(probe.accessibility.surfaceMotionScale);
  const veilMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.65, 8, 8), veil);
  veilMesh.position.set(xs[0], 1.42, z);
  scene.add(veilMesh);
  animatedMaterials.push(veil);

  const forest = tagFamily(
    createForestSkyDomeMaterial(
      createSkyTexture('#6cb8df', '#ead59b'),
      createSkyTexture('#261536', '#cf744f'),
      { blend: 0.56 },
    ),
    'forest-sky-dome',
    registry,
  );
  const forestFactorySide = forest.side;
  forest.setMotionScale(probe.accessibility.surfaceMotionScale);
  // The production material is BackSide because gameplay renders it from
  // inside a dome. A flat gallery swatch is viewed from outside, so use a
  // QA-only side override while retaining the factory flag in probe state.
  forest.side = THREE.DoubleSide;
  const forestMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.7), forest);
  forestMesh.position.set(xs[1], 1.42, z);
  forestMesh.renderOrder = 900;
  scene.add(forestMesh);

  const cave = tagFamily(
    createCaveSkyDomeMaterial(0x1a1820, 0x4a4a52),
    'cave-sky-dome',
    registry,
  );
  const caveFactorySide = cave.side;
  cave.side = THREE.DoubleSide;
  const caveMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.7), cave);
  caveMesh.position.set(xs[2], 1.42, z);
  caveMesh.renderOrder = 900;
  scene.add(caveMesh);

  probe.materials.skyFactoryBackSide = forestFactorySide === THREE.BackSide
    && caveFactorySide === THREE.BackSide;
  probe.materials.skySwatchSideOverride = forest.side === THREE.DoubleSide
    && cave.side === THREE.DoubleSide;

  labels.forEach((label, index) => addLabel(scene, label, xs[index], 3.05, z, 3.0));
}

function recordScreenSamples(camera) {
  const points = {
    rim: new THREE.Vector3(-7.5, 1.05, -5),
    damage: new THREE.Vector3(-4.5, 1.0, -5),
    water: new THREE.Vector3(-6, 0.04, 0.2),
    voidChasm: new THREE.Vector3(6, 0.05, 0.2),
    gateVeil: new THREE.Vector3(-5, 1.42, 5.15),
    forestSky: new THREE.Vector3(0, 1.42, 5.15),
    caveSky: new THREE.Vector3(5, 1.42, 5.15),
  };
  for (const [name, world] of Object.entries(points)) {
    const projected = world.clone().project(camera);
    probe.samplePoints[name] = {
      x: Number(((projected.x * 0.5 + 0.5) * canvas.clientWidth).toFixed(2)),
      y: Number(((-projected.y * 0.5 + 0.5) * canvas.clientHeight).toFixed(2)),
    };
  }
}

async function run() {
  if (!['auto', 'webgpu', 'webgl'].includes(requestedBackend)) {
    throw new Error(`Unsupported renderer preference "${requestedBackend}".`);
  }
  if (!['standard', 'reduced'].includes(accessibilityMode)) {
    throw new Error(`Unsupported accessibility mode "${accessibilityMode}".`);
  }
  if (!canvas) throw new Error('The material-gallery canvas is missing.');
  if (!probe.oneModuleUniverse) throw new Error('three and three/webgpu resolved to different module universes.');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b19);
  const camera = new THREE.PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    90,
  );
  camera.position.set(0, 16.5, 20.5);
  camera.lookAt(0, 0.8, 0);

  scene.add(new THREE.HemisphereLight(0xa9cbff, 0x2a142e, 2.1));
  const keyLight = new THREE.DirectionalLight(0xffd9aa, 4.0);
  keyLight.position.set(8, 13, 9);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -12;
  keyLight.shadow.camera.right = 12;
  keyLight.shadow.camera.top = 12;
  keyLight.shadow.camera.bottom = -12;
  scene.add(keyLight, keyLight.target);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(21, 15),
    new THREE.MeshStandardMaterial({ color: 0x0b1021, roughness: 0.96, metalness: 0.01 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.15;
  floor.receiveShadow = true;
  scene.add(floor);

  const materialRegistry = new Set();
  const animationControllers = [];
  const animatedMaterials = [];
  addCharacterMaterials(scene, materialRegistry, animationControllers);
  addGroundMaterials(scene, materialRegistry, animatedMaterials);
  addVerticalMaterials(scene, materialRegistry, animatedMaterials);
  window.__kkWebGPUMaterialGalleryDebug = { scene, camera, materialRegistry };

  const families = [...materialRegistry]
    .map((material) => material.userData.tslMaterialFamily)
    .filter(Boolean)
    .sort();
  probe.materials.nodeMaterialCount = [...materialRegistry]
    .filter((material) => material.isNodeMaterial === true).length;
  probe.materials.physicalNodeMaterialCount = [...materialRegistry]
    .filter((material) => material.isMeshPhysicalNodeMaterial === true).length;
  probe.materials.customOutputCount = [...materialRegistry]
    .filter((material) => material.outputNode?.isNode === true).length;
  probe.materials.families = families;
  probe.materials.missingFamilies = EXPECTED_FAMILIES.filter((family) => !families.includes(family));

  setStatus(`Initializing Three.js r${THREE.REVISION} (${requestedBackend})…`);
  const service = createRendererService({
    canvas,
    preferredBackend: requestedBackend,
    settings: {
      antialias: true,
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.25),
      dprCap: 1.25,
      scene,
      camera,
      threeRevision: THREE.REVISION,
      rendererProperties: {
        outputColorSpace: THREE.SRGBColorSpace,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      },
      configureRenderer(renderer) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
      },
    },
  });

  await service.initialize();
  probe.backend = service.backend;
  probe.rendererIsWebGPURenderer = service.renderer?.isWebGPURenderer === true;
  probe.backendFlags = backendFlags(service.renderer);

  setStatus(`Compiling ${materialRegistry.size} node materials on ${service.backend.toUpperCase()}…`);
  setDetails(
    `${accessibilityMode} accessibility · ${probe.materials.customOutputCount} MRT-safe custom outputs`,
  );
  await service.pipeline.compile(scene, camera);
  probe.compiled = true;
  recordScreenSamples(camera);

  const freezeFrame = 18;
  await service.setAnimationLoop(() => {
    probe.frameCount += 1;
    const deterministicTime = Math.min(probe.frameCount, freezeFrame) / 15;
    probe.animationSeconds = deterministicTime;
    probe.animationAdvanced = probe.frameCount >= 8 && deterministicTime > 0;
    for (const controller of animationControllers) controller.updateTime(deterministicTime);
    for (const material of animatedMaterials) material.setAnimationTime?.(deterministicTime);

    service.render(scene, camera);
    probe.renderCalls += 1;
    const info = service.renderer.info?.render || {};
    probe.renderInfo = {
      drawCalls: Number(info.drawCalls ?? info.calls ?? 0),
      triangles: Number(info.triangles || 0),
      points: Number(info.points || 0),
      lines: Number(info.lines || 0),
    };

    if (probe.frameCount >= freezeFrame && probe.status !== 'ready') {
      probe.status = 'ready';
      setStatus(
        `${service.backend.toUpperCase()} ready · ${materialRegistry.size}/${EXPECTED_FAMILIES.length} families`,
        'ready',
      );
      setDetails(
        `Three.js r${THREE.REVISION} · ${accessibilityMode} accessibility · `
        + `${probe.renderInfo.drawCalls} draws · ${probe.renderInfo.triangles} triangles`,
      );
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    service.resize(window.innerWidth, window.innerHeight, { updateStyle: false });
    recordScreenSamples(camera);
  });
}

run().catch((error) => {
  probe.status = 'error';
  probe.error = serializeError(error);
  setStatus('Material gallery failed.', 'error');
  setDetails(probe.error);
  console.error(error);
});
