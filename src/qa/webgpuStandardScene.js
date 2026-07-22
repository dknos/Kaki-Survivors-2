/**
 * Isolated Gate-2 renderer probe.
 *
 * This page intentionally does not import the production game or its renderer.
 * It proves that the single r185 WebGPU module universe can load representative
 * production assets and render ordinary Three.js content through either the
 * WebGPU backend or WebGPURenderer's forced WebGL 2 backend.
 */
import * as THREE from 'three/webgpu';
import { Mesh as AddonThreeMesh } from 'three';
import { color as tslColor } from 'three/tsl';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ALLOWED_BACKENDS = new Set(['auto', 'webgpu', 'webgl']);
const params = new URLSearchParams(window.location.search);
const requestedBackend = (params.get('renderer') || 'auto').toLowerCase();
const canvas = document.querySelector('#scene-canvas');
const statusElement = document.querySelector('#probe-status');
const detailsElement = document.querySelector('#probe-details');

const probe = {
  status: 'booting',
  requestedBackend,
  backend: null,
  backendFlags: { webgpu: false, webgl: false, webgpuDevice: null, webgl2Context: null },
  threeRevision: THREE.REVISION,
  rendererIsWebGPURenderer: false,
  oneModuleUniverse: AddonThreeMesh === THREE.Mesh,
  navigatorGpuPresent: Boolean(navigator.gpu),
  initializedAt: null,
  firstRenderedAt: null,
  frameCount: 0,
  animationSeconds: 0,
  renderInfo: {
    drawCalls: 0,
    renderCalls: 0,
    frameCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
  },
  assets: {
    hero: { url: './assets/breakroom/pipes.glb', loaded: false },
    enemy: { url: './assets/breakroom/Mushnub.glb', loaded: false },
    instancedEnemy: { url: './assets/kits/enemies/clockwork_mouse.glb', loaded: false },
  },
  features: {
    camera: false,
    directionalLight: false,
    ambientLight: false,
    heroGlb: false,
    enemyGlb: false,
    authoredAnimation: false,
    authoredAnimationClip: null,
    instancedEnemyCount: 0,
    transparentSprite: false,
    canvasTexture: false,
    shadowCasterCount: 0,
    shadowReceiver: false,
    pickup: false,
    tslNodeMaterial: false,
    particleCount: 0,
  },
  runtimeErrors: [],
  error: null,
};

window.__kkWebGPUStandardScene = probe;

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

function actualBackend(renderer) {
  const webgpu = renderer.backend?.isWebGPUBackend === true;
  const webgl = renderer.backend?.isWebGLBackend === true;
  const webgpuDevice = webgpu ? Boolean(renderer.backend?.device) : null;
  const webgl2Context = webgl
    ? (typeof WebGL2RenderingContext !== 'undefined' && renderer.backend?.gl instanceof WebGL2RenderingContext)
    : null;
  probe.backendFlags = { webgpu, webgl, webgpuDevice, webgl2Context };
  if (webgpu === webgl) {
    throw new Error(`Renderer backend flags are invalid (webgpu=${webgpu}, webgl=${webgl}).`);
  }
  return webgpu ? 'webgpu' : 'webgl';
}

function markShadows(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    probe.features.shadowCasterCount += 1;
  });
}

function fitModel(root, height, position) {
  root.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(root);
  const initialSize = initialBox.getSize(new THREE.Vector3());
  if (!Number.isFinite(initialSize.y) || initialSize.y <= 0) {
    throw new Error('Loaded model has no measurable height.');
  }

  const scale = height / initialSize.y;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const fittedBox = new THREE.Box3().setFromObject(root);
  const center = fittedBox.getCenter(new THREE.Vector3());
  root.position.add(new THREE.Vector3(
    position.x - center.x,
    position.y - fittedBox.min.y,
    position.z - center.z,
  ));
  root.updateMatrixWorld(true);
}

function createSpriteTexture() {
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = 128;
  spriteCanvas.height = 128;
  const context = spriteCanvas.getContext('2d');
  const glow = context.createRadialGradient(64, 64, 8, 64, 64, 60);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.25, 'rgba(255,213,111,0.96)');
  glow.addColorStop(0.58, 'rgba(142,102,255,0.72)');
  glow.addColorStop(1, 'rgba(34,22,89,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 128, 128);
  context.fillStyle = '#fff7d5';
  context.beginPath();
  context.arc(64, 73, 20, 0, Math.PI * 2);
  context.fill();
  for (const [x, y, r] of [[43, 49, 9], [57, 39, 9], [72, 39, 9], [86, 49, 9]]) {
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(spriteCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'qa-transparent-sprite-canvas-texture';
  return texture;
}

function createSignTexture() {
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 512;
  signCanvas.height = 160;
  const context = signCanvas.getContext('2d');
  context.fillStyle = '#17152d';
  context.fillRect(0, 0, 512, 160);
  context.strokeStyle = '#f4c766';
  context.lineWidth = 9;
  context.strokeRect(8, 8, 496, 144);
  context.fillStyle = '#fff1cc';
  context.font = '700 48px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('r185 · ONE UNIVERSE', 256, 80);
  const texture = new THREE.CanvasTexture(signCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'qa-canvas-texture-sign';
  return texture;
}

function addInstancedEnemies(scene, source, count = 24) {
  source.updateMatrixWorld(true);
  const primitiveMeshes = [];
  source.traverse((object) => {
    if (object.isMesh && object.geometry && object.material) primitiveMeshes.push(object);
  });
  if (primitiveMeshes.length === 0) throw new Error('Instanced enemy GLB contains no mesh primitives.');

  const transforms = [];
  const dummy = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const laneIndex = Math.floor(index / 2);
    dummy.position.set(side * (5.8 + (laneIndex % 3) * 1.05), 0, -4.8 + laneIndex * 0.82);
    dummy.rotation.set(0, side > 0 ? -0.52 : 0.52, 0);
    const scale = 0.43 + (index % 4) * 0.025;
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    transforms.push(dummy.matrix.clone());
  }

  for (const primitive of primitiveMeshes) {
    const geometry = primitive.geometry.clone();
    geometry.applyMatrix4(primitive.matrixWorld);
    const instance = new THREE.InstancedMesh(geometry, primitive.material, count);
    instance.name = `qa-instanced-clockwork-${primitive.name || primitive.id}`;
    instance.castShadow = true;
    instance.receiveShadow = true;
    for (let index = 0; index < count; index += 1) instance.setMatrixAt(index, transforms[index]);
    instance.instanceMatrix.needsUpdate = true;
    scene.add(instance);
    probe.features.shadowCasterCount += 1;
  }

  probe.features.instancedEnemyCount = count;
}

function createParticlePool(scene) {
  const count = 128;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const colorA = new THREE.Color(0x7fe2ff);
  const colorB = new THREE.Color(0xf6bdff);
  for (let index = 0; index < count; index += 1) {
    const angle = index * 2.399963229728653;
    const radius = 0.7 + (index % 17) * 0.075;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = 0.28 + (index % 23) * 0.085;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    const mix = (index % 11) / 10;
    colors[index * 3] = THREE.MathUtils.lerp(colorA.r, colorB.r, mix);
    colors[index * 3 + 1] = THREE.MathUtils.lerp(colorA.g, colorB.g, mix);
    colors[index * 3 + 2] = THREE.MathUtils.lerp(colorA.b, colorB.b, mix);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.11,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(geometry, material);
  particles.name = 'qa-pooled-particles';
  particles.position.set(0, 0.1, 0.5);
  scene.add(particles);
  probe.features.particleCount = count;
  return particles;
}

async function loadStandardScene(scene) {
  const draco = new DRACOLoader();
  draco.setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
  draco.setWorkerLimit(2);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  try {
    const [heroGltf, enemyGltf, instancedEnemyGltf] = await Promise.all([
      loader.loadAsync(probe.assets.hero.url),
      loader.loadAsync(probe.assets.enemy.url),
      loader.loadAsync(probe.assets.instancedEnemy.url),
    ]);

    const hero = heroGltf.scene;
    hero.name = 'qa-production-hero-pipes';
    fitModel(hero, 3.15, new THREE.Vector3(-2.7, 0, 0.4));
    markShadows(hero);
    scene.add(hero);
    probe.assets.hero.loaded = true;
    probe.features.heroGlb = true;

    const enemy = enemyGltf.scene;
    enemy.name = 'qa-production-enemy-mushnub';
    fitModel(enemy, 2.35, new THREE.Vector3(2.65, 0, 0.35));
    markShadows(enemy);
    scene.add(enemy);
    probe.assets.enemy.loaded = true;
    probe.features.enemyGlb = true;

    if (!enemyGltf.animations.length) throw new Error('Mushnub has no authored animation clips.');
    const mixer = new THREE.AnimationMixer(enemy);
    const preferredClip = enemyGltf.animations.find((clip) => /idle/i.test(clip.name)) || enemyGltf.animations[0];
    mixer.clipAction(preferredClip).play();
    probe.features.authoredAnimation = true;
    probe.features.authoredAnimationClip = preferredClip.name;

    addInstancedEnemies(scene, instancedEnemyGltf.scene);
    probe.assets.instancedEnemy.loaded = true;

    return { hero, enemy, mixer, draco };
  } catch (error) {
    draco.dispose();
    throw error;
  }
}

async function run() {
  if (!ALLOWED_BACKENDS.has(requestedBackend)) {
    throw new Error(`Unsupported renderer preference "${requestedBackend}"; use auto, webgpu, or webgl.`);
  }
  if (!canvas) throw new Error('The standard-scene canvas is missing.');
  if (!probe.oneModuleUniverse) throw new Error('three and three/webgpu resolved to different module universes.');

  setStatus(`Initializing Three.js r${THREE.REVISION} (${requestedBackend})…`);
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    forceWebGL: requestedBackend === 'webgl',
  });
  probe.rendererIsWebGPURenderer = renderer.isWebGPURenderer === true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  try {
    await renderer.init();
    probe.initializedAt = performance.now();
    probe.backend = actualBackend(renderer);
    if (requestedBackend === 'webgpu' && probe.backend !== 'webgpu') {
      renderer.dispose();
      throw new Error('WebGPU was required, but Three.js initialized its WebGL 2 fallback.');
    }
    if (requestedBackend === 'webgl' && probe.backend !== 'webgl') {
      renderer.dispose();
      throw new Error('Forced WebGL mode did not initialize the WebGL 2 backend.');
    }

    setStatus(`Loading production assets on ${probe.backend.toUpperCase()}…`);
    setDetails(`Three.js r${THREE.REVISION} · async init complete · compiling representative scene`);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080d22);
    scene.fog = new THREE.Fog(0x080d22, 18, 38);

    const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 80);
    camera.position.set(10.8, 7.5, 15.8);
    camera.lookAt(0, 1.3, 0);
    probe.features.camera = true;

    const hemisphere = new THREE.HemisphereLight(0x9fc9ff, 0x25132e, 1.85);
    scene.add(hemisphere);
    probe.features.ambientLight = true;

    const sun = new THREE.DirectionalLight(0xffddad, 4.2);
    sun.position.set(8, 13, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 36;
    scene.add(sun, sun.target);
    probe.features.directionalLight = true;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 28),
      new THREE.MeshStandardMaterial({ color: 0x253451, roughness: 0.92, metalness: 0.05 }),
    );
    floor.name = 'qa-shadow-receiver';
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    probe.features.shadowReceiver = true;

    const grid = new THREE.GridHelper(30, 30, 0x5574ac, 0x273958);
    grid.position.y = 0.012;
    scene.add(grid);

    const loaded = await loadStandardScene(scene);

    const pickupMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.26, metalness: 0.7 });
    pickupMaterial.colorNode = tslColor(0xffc85c);
    pickupMaterial.emissiveNode = tslColor(0x5b1804);
    const pickup = new THREE.Mesh(new THREE.TorusKnotGeometry(0.48, 0.15, 80, 12), pickupMaterial);
    pickup.name = 'qa-tsl-pickup';
    pickup.position.set(0, 1.28, 0.5);
    pickup.castShadow = true;
    scene.add(pickup);
    probe.features.pickup = true;
    probe.features.tslNodeMaterial = pickupMaterial.isNodeMaterial === true;
    probe.features.shadowCasterCount += 1;

    const spriteTexture = createSpriteTexture();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: spriteTexture,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
    }));
    sprite.name = 'qa-transparent-sprite';
    sprite.position.set(0, 3.25, 0.5);
    sprite.scale.set(1.75, 1.75, 1.75);
    scene.add(sprite);
    probe.features.transparentSprite = sprite.material.transparent === true;

    const signTexture = createSignTexture();
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5.1, 1.6),
      new THREE.MeshBasicMaterial({ map: signTexture, transparent: false }),
    );
    sign.name = 'qa-canvas-texture-sign';
    sign.position.set(0, 4.1, -4.6);
    sign.rotation.x = -0.08;
    scene.add(sign);
    probe.features.canvasTexture = signTexture.isCanvasTexture === true;

    const particles = createParticlePool(scene);

    await renderer.compileAsync(scene, camera);

    const clock = new THREE.Clock();
    let disposed = false;
    const renderFrame = () => {
      if (disposed) return;
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      loaded.mixer.update(delta);
      loaded.hero.position.y = Math.sin(elapsed * 1.45) * 0.035;
      pickup.rotation.x = elapsed * 0.62;
      pickup.rotation.y = elapsed * 1.1;
      pickup.position.y = 1.28 + Math.sin(elapsed * 2.2) * 0.16;
      sprite.material.rotation = Math.sin(elapsed * 0.7) * 0.08;
      particles.rotation.y = elapsed * 0.18;
      particles.position.y = 0.1 + Math.sin(elapsed * 0.9) * 0.08;

      renderer.render(scene, camera);
      probe.frameCount += 1;
      probe.animationSeconds = elapsed;
      probe.renderInfo = {
        drawCalls: renderer.info.render.drawCalls,
        renderCalls: renderer.info.render.calls,
        frameCalls: renderer.info.render.frameCalls,
        triangles: renderer.info.render.triangles,
        points: renderer.info.render.points,
        lines: renderer.info.render.lines,
      };

      if (probe.frameCount === 3) {
        probe.firstRenderedAt = performance.now();
        probe.status = 'ready';
        setStatus(`${probe.backend.toUpperCase()} ready · representative frame rendered`, 'ready');
        setDetails(
          `Three.js r${THREE.REVISION} · ${probe.renderInfo.drawCalls} draw calls · `
          + `${probe.renderInfo.triangles.toLocaleString()} triangles · `
          + `${probe.features.instancedEnemyCount} instanced enemies`,
        );
      } else if (probe.status === 'ready' && probe.frameCount % 30 === 0) {
        setDetails(
          `Three.js r${THREE.REVISION} · ${probe.renderInfo.drawCalls} draw calls · `
          + `${probe.renderInfo.triangles.toLocaleString()} triangles · `
          + `frame ${probe.frameCount}`,
        );
      }
    };

    const resize = () => {
      const width = Math.max(window.innerWidth, 1);
      const height = Math.max(window.innerHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height, false);
    };
    window.addEventListener('resize', resize);

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', resize);
      loaded.mixer.stopAllAction();
      loaded.draco.dispose();
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material?.dispose?.();
      });
      spriteTexture.dispose();
      signTexture.dispose();
      renderer.dispose();
    };
    window.addEventListener('pagehide', dispose, { once: true });

    renderer.setAnimationLoop(renderFrame);
  } catch (error) {
    try { renderer.setAnimationLoop(null); } catch (_) {}
    try { renderer.dispose(); } catch (_) {}
    throw error;
  }
}

run().catch((error) => {
  probe.status = 'error';
  probe.error = serializeError(error);
  setStatus(probe.error, 'error');
  setDetails(
    requestedBackend === 'webgpu'
      ? 'WebGPU was explicitly required. Retry with ?renderer=webgl to exercise the fallback backend.'
      : 'See the browser console and window.__kkWebGPUStandardScene for diagnostics.',
  );
  console.error('[webgpu-standard-scene]', error);
});
