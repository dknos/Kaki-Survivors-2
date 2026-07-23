import * as THREE from 'three/webgpu';
import {
  ENEMY_SPRITE_DIRECTION,
  ENEMY_SPRITE_STATE,
  disposeAtlases,
  disposeSpritePools,
  ensurePool,
  getSpritePoolStats,
  getSpriteSlotSnapshot,
  loadAtlas,
  playEnemySpriteDeath,
  releaseAllSprites,
  setEnemySpriteMotion,
  setEnemySpriteState,
  spawnEnemySprite,
  spawnSprite,
  tickSpriteSystem,
  triggerEnemySpriteHit,
} from '../sprites/index.js';

const params = new URLSearchParams(location.search);
const requestedBackend = params.get('renderer') || 'webgl';
const initialScenario = params.get('scenario') || 'overview';
const initialAtlasMode = params.get('atlas') || 'v2';
const canvas = document.querySelector('#qa-canvas');
const backendLabel = document.querySelector('#backend');
const title = document.querySelector('#title');
const legend = document.querySelector('#legend');
const species = [
  'ant', 'beetle', 'ladybug', 'grasshopper', 'cockroach',
  'mantis', 'wasp', 'bee', 'butterfly', 'caterpillar', 'spider',
];
const probe = {
  status: 'booting',
  requestedBackend,
  backend: null,
  scenario: initialScenario,
  atlasMode: initialAtlasMode,
  time: 0,
  drawCalls: 0,
  triangles: 0,
  activeSprites: 0,
  errors: [],
};
window.__kkEnemyAnimationQA = probe;

let renderer;
let scene;
let camera;
let paused = false;
let lastTime = 0;
const attackHandles = [];
const hitHandles = [];
const deathHandles = [];

function directionVelocity(direction, speed) {
  if (direction === ENEMY_SPRITE_DIRECTION.TOWARD_CAMERA) return [0, speed];
  if (direction === ENEMY_SPRITE_DIRECTION.CAMERA_RIGHT) return [speed, 0];
  if (direction === ENEMY_SPRITE_DIRECTION.AWAY_FROM_CAMERA) return [0, -speed];
  return [-speed, 0];
}

function spawnV2(speciesId, x, y, options = {}) {
  const nominalSpeed = options.nominalSpeed ?? 2.5;
  const directionId = options.directionId ?? ENEMY_SPRITE_DIRECTION.TOWARD_CAMERA;
  const speed = options.speed ?? nominalSpeed;
  const velocity = directionVelocity(directionId, speed);
  return spawnEnemySprite('forest-enemies-v2', {
    speciesId,
    stateId: ENEMY_SPRITE_STATE.MOVE,
    directionId,
    x,
    y,
    z: 0,
    scale: options.scale ?? 1.45,
    vx: velocity[0],
    vz: velocity[1],
    speed,
    nominalSpeed,
    seed: options.seed ?? speciesId,
    phase: options.phase,
  });
}

function clearShowcase() {
  releaseAllSprites('enemies');
  releaseAllSprites('forest-enemies-v2');
  attackHandles.length = 0;
  hitHandles.length = 0;
  deathHandles.length = 0;
  probe.time = 0;
}

function buildOverview() {
  clearShowcase();
  document.body.classList.remove('dense');
  title.textContent = 'FOREST ENEMY ANIMATION QA';
  legend.textContent = 'V1 remains available as fallback · v2 uses one shared page and deterministic numeric states';
  const firstX = -14.4;
  const columnStep = 3.2;
  const firstY = 8.85;
  const rowStep = 1.72;
  for (let speciesId = 0; speciesId < species.length; speciesId++) {
    const y = firstY - speciesId * rowStep;
    const oldX = firstX;
    // Two synchronized v1 instances explicitly reproduce the previous
    // spawn-at-zero phase behavior in the BEFORE column.
    spawnSprite('enemies', {
      x: oldX - 0.35, y, z: 0, scale: 1.25,
      anim: species[speciesId], randomizePhase: false,
    });
    spawnSprite('enemies', {
      x: oldX + 0.35, y, z: 0, scale: 1.25,
      anim: species[speciesId], randomizePhase: false,
    });

    spawnV2(speciesId, firstX + columnStep, y, {
      speed: 1.25, nominalSpeed: 2.5, seed: speciesId * 31 + 1,
    });
    for (let direction = 0; direction < 4; direction++) {
      spawnV2(speciesId, firstX + columnStep * (direction + 2), y, {
        directionId: direction, seed: speciesId * 31 + direction + 2,
      });
    }
    const attack = spawnV2(speciesId, firstX + columnStep * 6, y, { seed: speciesId * 31 + 7 });
    setEnemySpriteState('forest-enemies-v2', attack, ENEMY_SPRITE_STATE.ATTACK, true);
    attackHandles.push(attack);
    const hit = spawnV2(speciesId, firstX + columnStep * 7, y, { seed: speciesId * 31 + 8 });
    triggerEnemySpriteHit('forest-enemies-v2', hit);
    hitHandles.push(hit);
    const death = spawnV2(speciesId, firstX + columnStep * 8, y, { seed: speciesId * 31 + 9 });
    playEnemySpriteDeath('forest-enemies-v2', death);
    deathHandles.push(death);

    const phaseX = firstX + columnStep * 9;
    for (let phaseIndex = 0; phaseIndex < 3; phaseIndex++) {
      spawnV2(speciesId, phaseX + (phaseIndex - 1) * 0.55, y, {
        scale: 1.08,
        seed: speciesId * 97 + phaseIndex * 19,
      });
    }
  }
  probe.scenario = 'overview';
  probe.atlasMode = 'both';
}

function buildDense(atlasMode = 'v2') {
  clearShowcase();
  document.body.classList.add('dense');
  title.textContent = `350-ENEMY DETERMINISTIC SWARM — ${atlasMode.toUpperCase()}`;
  legend.textContent = '350 active sprites · 512 fixed slots · one enemy-atlas submission';
  const cols = 25;
  const rows = 14;
  for (let index = 0; index < cols * rows; index++) {
    const speciesId = index % species.length;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = (col - (cols - 1) / 2) * 1.18 + ((row & 1) ? 0.25 : -0.25);
    const y = ((rows - 1) / 2 - row) * 1.42;
    if (atlasMode === 'v1') {
      spawnSprite('enemies', {
        x, y, z: 0, scale: 0.86, anim: species[speciesId],
        randomizePhase: true,
      });
    } else {
      const directionId = index & 3;
      const nominalSpeed = 1 + speciesId * 0.35;
      const speed = nominalSpeed * (0.5 + (index % 7) / 6);
      spawnV2(speciesId, x, y, {
        scale: 0.86,
        directionId,
        speed,
        nominalSpeed,
        seed: index * 2654435761,
      });
    }
  }
  probe.scenario = 'dense';
  probe.atlasMode = atlasMode;
}

function updateProbe() {
  const id = probe.atlasMode === 'v1' ? 'enemies' : 'forest-enemies-v2';
  const stats = getSpritePoolStats(id);
  probe.activeSprites = stats?.activeCount ?? 0;
  probe.activePages = stats?.activePages ?? 0;
  probe.drawCalls = renderer.info.render.drawCalls ?? renderer.info.render.calls ?? 0;
  probe.triangles = renderer.info.render.triangles ?? 0;
  probe.textures = renderer.info.memory?.textures ?? null;
  probe.attackAlive = attackHandles.filter((handle) => getSpriteSlotSnapshot('forest-enemies-v2', handle)).length;
  probe.hitAlive = hitHandles.filter((handle) => getSpriteSlotSnapshot('forest-enemies-v2', handle)).length;
  probe.deathAlive = deathHandles.filter((handle) => getSpriteSlotSnapshot('forest-enemies-v2', handle)).length;
}

function renderOnce() {
  renderer.info.reset();
  renderer.render(scene, camera);
  updateProbe();
}

function snapshot() {
  return {
    status: probe.status,
    requestedBackend: probe.requestedBackend,
    backend: probe.backend,
    scenario: probe.scenario,
    atlasMode: probe.atlasMode,
    time: probe.time,
    drawCalls: probe.drawCalls,
    triangles: probe.triangles,
    activeSprites: probe.activeSprites,
    activePages: probe.activePages,
    textures: probe.textures,
    attackAlive: probe.attackAlive,
    hitAlive: probe.hitAlive,
    deathAlive: probe.deathAlive,
    errors: [...probe.errors],
  };
}

function step(seconds) {
  const dt = Math.max(0, Math.min(0.25, Number(seconds) || 0));
  tickSpriteSystem(dt, camera);
  probe.time += dt;
  renderOnce();
  return snapshot();
}

function reset(scenario = probe.scenario, atlasMode = probe.atlasMode) {
  if (scenario === 'dense') buildDense(atlasMode === 'v1' ? 'v1' : 'v2');
  else buildOverview();
  tickSpriteSystem(0, camera);
  renderOnce();
  return snapshot();
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function benchmark(options = {}) {
  const atlasMode = options.atlasMode === 'v1' ? 'v1' : 'v2';
  const iterations = Math.max(300, Number(options.iterations) || 3000);
  reset('dense', atlasMode);
  paused = true;
  for (let index = 0; index < 120; index++) tickSpriteSystem(1 / 60, camera);
  const cpuSamples = [];
  const batchSize = 100;
  for (let start = 0; start < iterations; start += batchSize) {
    const count = Math.min(batchSize, iterations - start);
    const begin = performance.now();
    for (let index = 0; index < count; index++) tickSpriteSystem(1 / 60, camera);
    cpuSamples.push((performance.now() - begin) / count);
  }
  cpuSamples.sort((a, b) => a - b);
  const cpuMean = cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length;

  const frameTimes = [];
  const submissionTimes = [];
  const warmupFrames = 30;
  const measuredFrames = Math.max(90, Number(options.frames) || 180);
  await new Promise((resolve) => {
    let previous = 0;
    let frame = 0;
    renderer.setAnimationLoop((time) => {
      tickSpriteSystem(1 / 60, camera);
      const submitStart = performance.now();
      renderer.render(scene, camera);
      const submission = performance.now() - submitStart;
      if (frame >= warmupFrames) {
        if (previous > 0) frameTimes.push(time - previous);
        submissionTimes.push(submission);
      }
      previous = time;
      frame++;
      if (frame >= warmupFrames + measuredFrames) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });
  frameTimes.sort((a, b) => a - b);
  submissionTimes.sort((a, b) => a - b);
  renderOnce();
  const atlas = atlasMode === 'v1'
    ? { width: 4 * 128, height: 23 * 128, mipmaps: false }
    : { width: 20 * 112, height: 20 * 112, mipmaps: true };
  const baseBytes = atlas.width * atlas.height * 4;
  const textureBytes = Math.round(baseBytes * (atlas.mipmaps ? 4 / 3 : 1));
  const meanFrameMs = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
  const result = {
    backend: probe.backend,
    atlasMode,
    activeSprites: getSpritePoolStats(atlasMode === 'v1' ? 'enemies' : 'forest-enemies-v2').activeCount,
    capacity: 512,
    enemyAtlasDrawCalls: 1,
    sceneDrawCalls: probe.drawCalls,
    triangles: probe.triangles,
    textureBaseBytes: baseBytes,
    textureBytes,
    cpuAnimationMs: {
      mean: cpuMean,
      p50: percentile(cpuSamples, 0.5),
      p95: percentile(cpuSamples, 0.95),
    },
    frameMs: {
      mean: meanFrameMs,
      p50: percentile(frameTimes, 0.5),
      p95: percentile(frameTimes, 0.95),
      sustainedFps: 1000 / meanFrameMs,
    },
    renderSubmissionMs: {
      p50: percentile(submissionTimes, 0.5),
      p95: percentile(submissionTimes, 0.95),
    },
    gpuFrameMs: null,
    gpuFrameMsReason: 'Browser timestamp queries are unavailable in this portable WebGPU/WebGL2 QA harness.',
  };
  paused = true;
  return result;
}

async function run() {
  if (!['webgpu', 'webgl'].includes(requestedBackend)) throw new Error('renderer must be webgpu or webgl');
  renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    forceWebGL: requestedBackend === 'webgl',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  probe.backend = renderer.backend?.isWebGPUBackend
    ? 'webgpu'
    : renderer.backend?.isWebGLBackend ? 'webgl' : 'unknown';
  if (probe.backend !== requestedBackend) throw new Error(`requested ${requestedBackend}, got ${probe.backend}`);
  backendLabel.textContent = `${probe.backend} · LINEAR + MIPMAPS · A2C OFF`;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x162315);
  camera = new THREE.OrthographicCamera(-17.3, 17.3, 10.8, -10.8, 0.1, 100);
  camera.position.set(0, 0, 30);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  await Promise.all([
    loadAtlas('enemies', 'assets/sprites/enemies_v1.json'),
    loadAtlas('forest-enemies-v2', 'assets/sprites/forest_enemies_v2.json'),
  ]);
  ensurePool(scene, 'enemies', 512);
  ensurePool(scene, 'forest-enemies-v2', 512);
  if (initialScenario === 'dense') buildDense(initialAtlasMode === 'v1' ? 'v1' : 'v2');
  else buildOverview();
  await renderer.compileAsync(scene, camera);
  tickSpriteSystem(0, camera);
  renderOnce();

  Object.assign(probe, {
    status: 'ready',
    pause() { paused = true; return snapshot(); },
    resume() { paused = false; lastTime = 0; return true; },
    step,
    reset,
    benchmark,
  });
  renderer.setAnimationLoop((time) => {
    if (paused) return;
    const dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 0;
    lastTime = time;
    tickSpriteSystem(dt, camera);
    probe.time += dt;
    renderOnce();
  });
}

run().catch((error) => {
  probe.status = 'error';
  probe.errors.push(error?.stack || String(error));
  console.error(error);
});

addEventListener('beforeunload', () => {
  renderer?.setAnimationLoop(null);
  disposeSpritePools();
  disposeAtlases();
});
