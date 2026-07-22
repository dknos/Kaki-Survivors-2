/** Isolated dual-backend compile probe for the remaining instanced TSL families. */
import * as THREE from 'three/webgpu';

import {
  createAtmosphereParticleGeometry,
  createAtmosphereParticleMaterial,
} from '../rendering/materials/atmosphereParticleMaterial.js';
import { createSpritePoolMaterial } from '../rendering/materials/spritePoolMaterial.js';
import { createTrialsParticleMaterial } from '../rendering/materials/trialsParticleMaterial.js';

THREE.Node.captureStackTrace = true;

const params = new URLSearchParams(location.search);
const requestedBackend = params.get('renderer') || 'webgl';
const requestedFamily = params.get('family') || 'all';
const canvas = document.querySelector('#probe-canvas');
const probe = {
  status: 'booting',
  requestedBackend,
  requestedFamily,
  backend: null,
  compiled: false,
  frames: 0,
  drawCalls: 0,
  triangles: 0,
  errors: [],
};
window.__kkWebGPUInstancedMaterialsProbe = probe;

function texture(width, height, pixels) {
  const result = new THREE.DataTexture(new Uint8Array(pixels), width, height);
  result.colorSpace = THREE.SRGBColorSpace;
  result.minFilter = THREE.NearestFilter;
  result.magFilter = THREE.NearestFilter;
  result.needsUpdate = true;
  return result;
}

function atlasTexture() {
  const pixels = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const active = x > 0 && x < 7 && y > 0 && y < 3;
      pixels.push(active ? 255 : 0, 120 + x * 14, 80 + y * 35, active ? 255 : 0);
    }
  }
  return texture(8, 4, pixels);
}

function particleTexture() {
  return texture(2, 2, [
    255, 255, 255, 0,
    255, 235, 160, 255,
    255, 235, 160, 255,
    255, 255, 255, 0,
  ]);
}

function addAtmosphere(scene) {
  const source = new THREE.BufferGeometry();
  source.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -3.3, 2.0, 0,
    -2.4, 1.2, -0.8,
    -1.5, 2.6, 0.3,
  ]), 3));
  source.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array([2.1, 1.4, 2.6]), 1));
  source.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array([0.9, 0.55, 0.75]), 1));
  source.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  const geometry = createAtmosphereParticleGeometry(source);
  const material = createAtmosphereParticleMaterial({
    map: particleTexture(),
    color: 0xffc76c,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
}

function addTrials(scene) {
  const geometry = new THREE.IcosahedronGeometry(0.38, 0);
  geometry.setAttribute(
    'instanceAlpha',
    new THREE.InstancedBufferAttribute(new Float32Array([0.25, 0.6, 1]), 1),
  );
  const material = createTrialsParticleMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, 3);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([
    1, 0.3, 0.1,
    0.2, 0.8, 1,
    0.8, 1, 0.3,
  ]), 3);
  const object = new THREE.Object3D();
  for (let i = 0; i < 3; i += 1) {
    object.position.set(-0.7 + i * 0.9, 1.1 + i * 0.35, 0);
    object.updateMatrix();
    mesh.setMatrixAt(i, object.matrix);
  }
  scene.add(mesh);
}

function addSprite(scene) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('aFrame', new THREE.InstancedBufferAttribute(new Float32Array([0, 0]), 1));
  geometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(new Float32Array([2.2, 2.2]), 1));
  geometry.setAttribute('aFlash', new THREE.InstancedBufferAttribute(new Float32Array([0, 0.8]), 1));
  const material = createSpritePoolMaterial({
    texture: atlasTexture(),
    cols: 1,
    rows: 1,
    frameWidth: 8,
    frameHeight: 4,
    anchor: [0.5, 1],
    billboard: 'screen',
    alphaTest: 0.5,
    blendMode: 'normal',
  });
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  const matrix = new THREE.Matrix4();
  matrix.setPosition(2.0, 0, 0);
  mesh.setMatrixAt(0, matrix);
  matrix.setPosition(4.3, 0, -0.5);
  mesh.setMatrixAt(1, matrix);
  mesh.frustumCulled = false;
  scene.add(mesh);
}

async function run() {
  if (!['webgpu', 'webgl'].includes(requestedBackend)) {
    throw new Error('renderer must be webgpu or webgl');
  }
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: requestedBackend === 'webgl',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  probe.backend = renderer.backend?.isWebGPUBackend
    ? 'webgpu'
    : renderer.backend?.isWebGLBackend ? 'webgl' : 'unknown';
  if (probe.backend !== requestedBackend) {
    throw new Error(`requested ${requestedBackend}, initialized ${probe.backend}`);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b18);
  scene.fog = new THREE.Fog(0x070b18, 4, 20);
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 80);
  camera.position.set(0, 3.6, 12);
  camera.lookAt(0.6, 1.2, 0);
  if (requestedFamily === 'all' || requestedFamily === 'atmosphere') addAtmosphere(scene);
  if (requestedFamily === 'all' || requestedFamily === 'trials') addTrials(scene);
  if (requestedFamily === 'all' || requestedFamily === 'sprite') addSprite(scene);

  await renderer.compileAsync(scene, camera);
  probe.compiled = true;
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    probe.frames += 1;
    probe.drawCalls = renderer.info.render.drawCalls ?? renderer.info.render.calls ?? 0;
    probe.triangles = renderer.info.render.triangles ?? 0;
    if (probe.frames >= 3) {
      probe.status = 'ready';
      renderer.setAnimationLoop(null);
    }
  });
}

run().catch((error) => {
  probe.status = 'error';
  probe.errors.push(error?.stack || String(error));
  console.error(error);
});
