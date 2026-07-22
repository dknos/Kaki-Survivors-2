/**
 * Isolated r185 RenderPipeline/MRT validation scene.
 *
 * The scene deliberately places three equally obvious HDR emitters far apart:
 * a bright object excluded from bloom, an opaque bloom-layer object, and a
 * transparent additive bloom-layer object. Browser automation captures this
 * exact graph with bloom enabled and disabled and measures each object's halo.
 */
import * as THREE from 'three/webgpu';
import {
  vec3,
} from 'three/tsl';

import { createRendererService } from '../rendering/createRenderer.js';
import { createWaterMaterial } from '../rendering/materials/landscapeMaterials.js';
import {
  BLOOM_LAYER,
  createPostPipeline,
} from '../rendering/postfx/createPostPipeline.js';

const params = new URLSearchParams(window.location.search);
const requestedBackend = (params.get('renderer') || 'auto').toLowerCase();
const accessibilityMode = (params.get('accessibility') || 'standard').toLowerCase();
const quality = (params.get('quality') || 'legacy').toLowerCase();
const reducedAccessibility = accessibilityMode === 'reduced';
const canvas = document.querySelector('#postfx-canvas');
const statusElement = document.querySelector('#probe-status');
const detailsElement = document.querySelector('#probe-details');

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
  navigatorGpuPresent: Boolean(navigator.gpu),
  rendererIsWebGPURenderer: false,
  initialized: false,
  compiled: false,
  compileResult: false,
  compileMethod: false,
  compileDiagnostics: null,
  frameCount: 0,
  renderCalls: 0,
  bloomEnabled: true,
  quality,
  hasBloomGraph: false,
  selectiveBloomMrt: false,
  customOutputNode: false,
  customFragmentNode: false,
  sceneSamples: null,
  accessibility: {
    reduceMotion: reducedAccessibility,
    reduceFlashing: reducedAccessibility,
    highContrast: reducedAccessibility,
    colorblind: 'off',
    uReduceMotion: null,
    uReduceFlashing: null,
    uHighContrast: null,
  },
  objects: {
    brightNonBloom: { layer0: false, bloomLayer: false, material: null },
    opaqueBloom: { layer0: false, bloomLayer: false, material: null },
    additiveBloom: {
      layer0: false,
      bloomLayer: false,
      material: null,
      transparent: false,
      additive: false,
      opacity: null,
    },
    waterSurface: { layer0: false, bloomLayer: false, material: null },
  },
  samplePoints: {},
  renderInfo: {
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
  },
  runtimeErrors: [],
  error: null,
};

window.__kkWebGPUPostfxSmoke = probe;

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

function inspectBackend(renderer) {
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

function makeHdrMaterial(name, color, alpha = 1, blending = THREE.NormalBlending) {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: alpha < 1 || blending !== THREE.NormalBlending,
    depthWrite: alpha >= 1 && blending === THREE.NormalBlending,
    depthTest: true,
    blending,
    toneMapped: true,
  });
  material.name = name;
  material.opacity = alpha;
  material.colorNode = vec3(color[0], color[1], color[2]);
  material.userData.sourceLinearColor = [...color];
  material.userData.sourceHdrPeak = Math.max(...color);
  return material;
}

function addDisc(scene, { name, x, color, bloom = false, alpha = 1, blending }) {
  const material = makeHdrMaterial(name, color, alpha, blending);
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.55, 64), material);
  mesh.name = name;
  mesh.position.set(x, 1.25, 0);
  if (bloom) mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  return mesh;
}

function addReferenceRings(scene, centers) {
  const material = new THREE.MeshBasicMaterial({
    color: 0x1a2945,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    toneMapped: false,
  });
  for (const x of centers) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.84, 96), material);
    ring.position.set(x, 1.25, -0.04);
    scene.add(ring);
  }
}

function addWaterSurface(scene) {
  const material = createWaterMaterial(0x061a32, 0x2bc7de, 0.93, {
    time: 0.75,
    motionScale: 0,
  });
  material.name = 'PostfxSmokeWaterOutputNode';
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10.8, 1.5, 32, 4), material);
  mesh.name = 'MRT-safe custom outputNode water';
  mesh.position.set(0, -2.15, 0);
  scene.add(mesh);
  return mesh;
}

function projectPoint(camera, world, radiusWorld = 0.55) {
  const center = world.clone().project(camera);
  const edge = world.clone().add(new THREE.Vector3(radiusWorld, 0, 0)).project(camera);
  return {
    x: Number(((center.x * 0.5 + 0.5) * canvas.clientWidth).toFixed(2)),
    y: Number(((-center.y * 0.5 + 0.5) * canvas.clientHeight).toFixed(2)),
    radius: Number((Math.abs(edge.x - center.x) * 0.5 * canvas.clientWidth).toFixed(2)),
  };
}

function recordSamplePoints(camera, objects) {
  probe.samplePoints = {
    brightNonBloom: projectPoint(camera, objects.brightNonBloom.position),
    opaqueBloom: projectPoint(camera, objects.opaqueBloom.position),
    additiveBloom: projectPoint(camera, objects.additiveBloom.position),
    waterSurface: projectPoint(camera, objects.waterSurface.position, 0.45),
  };
}

function readSceneSamples(postfx) {
  const renderTarget = postfx.scenePass?.renderTarget || postfx.scenePass?._renderTarget || null;
  const diagnostics = postfx.getDiagnostics?.() || null;
  const value = diagnostics?.sceneSamples ?? renderTarget?.samples;
  return Number.isFinite(value) ? Number(value) : null;
}

async function waitForRenderedFrames(count = 3) {
  const target = probe.frameCount + count;
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for rendered frames.')), 10_000);
    function poll() {
      if (probe.frameCount >= target) {
        window.clearTimeout(timeout);
        resolve();
      } else {
        window.requestAnimationFrame(poll);
      }
    }
    poll();
  });
}

async function run() {
  if (!['auto', 'webgpu', 'webgl'].includes(requestedBackend)) {
    throw new Error(`Unsupported renderer preference "${requestedBackend}".`);
  }
  if (!['standard', 'reduced'].includes(accessibilityMode)) {
    throw new Error(`Unsupported accessibility mode "${accessibilityMode}".`);
  }
  if (quality !== 'legacy') {
    throw new Error(`The post-processing smoke scene requires the legacy parity graph, not "${quality}".`);
  }
  if (!canvas) throw new Error('The post-processing smoke canvas is missing.');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03050d);
  const aspect = window.innerWidth / window.innerHeight;
  const verticalHalfExtent = 4;
  const camera = new THREE.OrthographicCamera(
    -verticalHalfExtent * aspect,
    verticalHalfExtent * aspect,
    verticalHalfExtent,
    -verticalHalfExtent,
    0.1,
    30,
  );
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  // Wide separation keeps the Gaussian tail from a valid bloom member out of
  // the bright non-bloom control's measurement annulus.
  const centers = [-5, 0, 5];
  addReferenceRings(scene, centers);
  const objects = {
    brightNonBloom: addDisc(scene, {
      name: 'HDR bright excluded from bloom',
      x: centers[0],
      color: [4.0, 4.0, 4.0],
    }),
    opaqueBloom: addDisc(scene, {
      name: 'HDR opaque selective bloom',
      x: centers[1],
      color: [4.2, 1.65, 0.22],
      bloom: true,
    }),
    additiveBloom: addDisc(scene, {
      name: 'HDR transparent additive selective bloom',
      x: centers[2],
      color: [3.7, 0.18, 2.2],
      bloom: true,
      alpha: 0.52,
      blending: THREE.AdditiveBlending,
    }),
    waterSurface: addWaterSurface(scene),
  };

  probe.customOutputNode = objects.waterSurface.material.outputNode?.isNode === true;
  probe.customFragmentNode = objects.waterSurface.material.fragmentNode?.isNode === true;
  for (const [key, object] of Object.entries(objects)) {
    probe.objects[key] = {
      layer0: object.layers.isEnabled(0),
      bloomLayer: object.layers.isEnabled(BLOOM_LAYER),
      material: object.material?.type || null,
      hdrPeak: Number(object.material?.userData?.sourceHdrPeak || 0),
      ...(key === 'additiveBloom' ? {
        transparent: object.material.transparent === true,
        additive: object.material.blending === THREE.AdditiveBlending,
        opacity: object.material.opacity,
      } : {}),
    };
  }

  let postfx = null;
  setStatus(`Initializing Three.js r${THREE.REVISION} (${requestedBackend})…`);
  const service = createRendererService({
    canvas,
    preferredBackend: requestedBackend,
    pipelineFactory({ renderer, scene: activeScene, camera: activeCamera }) {
      postfx = createPostPipeline({
        renderer,
        scene: activeScene,
        camera: activeCamera,
        quality,
        samples: 0,
        accessibility: {
          reduceMotion: reducedAccessibility,
          reduceFlashing: reducedAccessibility,
          highContrast: reducedAccessibility,
          colorblind: 'off',
        },
      });

      // Freeze unrelated legacy-look effects so image deltas isolate MRT bloom.
      // Their node graphs still compile as part of the RenderPipeline.
      postfx.uniforms.fogAmount.value = 0;
      postfx.uniforms.chromatic.value = 0;
      postfx.uniforms.vignette.value = 0;
      postfx.uniforms.gradingEnabled.value = 0;
      postfx.uniforms.bloomStrength.value = 1.65;
      postfx.uniforms.bloomRadius.value = 0.58;
      postfx.uniforms.bloomThreshold.value = 0.08;
      return postfx;
    },
    settings: {
      antialias: true,
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: 1,
      dprCap: 1,
      scene,
      camera,
      threeRevision: THREE.REVISION,
      rendererProperties: {
        outputColorSpace: THREE.SRGBColorSpace,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1,
      },
    },
  });

  await service.initialize();
  probe.initialized = true;
  probe.backend = service.backend;
  probe.rendererIsWebGPURenderer = service.renderer?.isWebGPURenderer === true;
  probe.backendFlags = inspectBackend(service.renderer);
  probe.hasBloomGraph = postfx?.hasBloomGraph?.() === true;
  probe.selectiveBloomMrt = Boolean(postfx?.selectiveBloom?.mrt && postfx?.scenePass);
  probe.compileMethod = typeof postfx?.compile === 'function';
  probe.sceneSamples = readSceneSamples(postfx);

  setStatus(`Compiling MRT RenderPipeline on ${service.backend.toUpperCase()}…`);
  probe.compileResult = await service.pipeline.compile(scene, camera);
  probe.compiled = probe.compileResult === true;
  probe.compileDiagnostics = postfx.getDiagnostics?.() || null;
  probe.sceneSamples = readSceneSamples(postfx);
  recordSamplePoints(camera, objects);

  const uniforms = postfx.uniforms;
  probe.accessibility.uReduceMotion = uniforms.uReduceMotion.value;
  probe.accessibility.uReduceFlashing = uniforms.uReduceFlashing.value;
  probe.accessibility.uHighContrast = uniforms.uHighContrast.value;

  window.__kkWebGPUPostfxControl = {
    async setBloomEnabled(enabled) {
      postfx.uniforms.bloomEnabled.value = enabled ? 1 : 0;
      probe.bloomEnabled = Boolean(enabled);
      await waitForRenderedFrames(4);
      return probe.frameCount;
    },
    async showOnly(objectName = 'all') {
      if (objectName !== 'all' && !Object.hasOwn(objects, objectName)) {
        throw new RangeError(`Unknown post-processing probe object "${objectName}".`);
      }
      for (const [name, object] of Object.entries(objects)) {
        // Keep the custom outputNode surface present in every selective-bloom
        // isolation capture so the MRT compatibility path stays exercised.
        object.visible = name === 'waterSurface'
          || objectName === 'all'
          || name === objectName;
      }
      await waitForRenderedFrames(4);
    },
    async setReducedAccessibility(enabled) {
      postfx.setAccessibility({
        reduceMotion: enabled,
        reduceFlashing: enabled,
        highContrast: enabled,
        colorblind: 'off',
      });
      probe.accessibility.uReduceMotion = uniforms.uReduceMotion.value;
      probe.accessibility.uReduceFlashing = uniforms.uReduceFlashing.value;
      probe.accessibility.uHighContrast = uniforms.uHighContrast.value;
      await waitForRenderedFrames(4);
    },
    getPipeline: () => postfx,
  };
  window.__kkWebGPUPostfxDebug = { scene, camera, objects, service, postfx };

  let cleanupStarted = false;
  window.addEventListener('pagehide', () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    Promise.resolve(service.setAnimationLoop(null))
      .catch(() => {})
      .then(() => service.dispose())
      .catch(() => {});
  }, { once: true });

  await service.setAnimationLoop(() => {
    probe.frameCount += 1;
    service.render(scene, camera);
    probe.renderCalls += 1;
    const info = service.renderer.info?.render || {};
    probe.renderInfo = {
      drawCalls: Number(info.drawCalls ?? info.calls ?? 0),
      triangles: Number(info.triangles || 0),
      points: Number(info.points || 0),
      lines: Number(info.lines || 0),
    };

    if (probe.frameCount >= 14 && probe.status !== 'ready') {
      probe.status = 'ready';
      setStatus(`${service.backend.toUpperCase()} MRT selective bloom ready`, 'ready');
      setDetails(
        `Three.js r${THREE.REVISION} · ${accessibilityMode} accessibility · `
        + `${probe.renderInfo.drawCalls} draws · ${probe.renderInfo.triangles} triangles`,
      );
    }
  });

  window.addEventListener('resize', () => {
    const nextAspect = window.innerWidth / window.innerHeight;
    camera.left = -verticalHalfExtent * nextAspect;
    camera.right = verticalHalfExtent * nextAspect;
    camera.updateProjectionMatrix();
    service.resize(window.innerWidth, window.innerHeight, { updateStyle: false });
    recordSamplePoints(camera, objects);
  });
}

run().catch((error) => {
  probe.status = 'error';
  probe.error = serializeError(error);
  setStatus('Post-processing smoke scene failed.', 'error');
  setDetails(probe.error);
  console.error(error);
});
