import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const postfxDir = join(testDir, '..', 'postfx');
const files = [
  'accessibilityPostfx.js',
  'chromaticAberration.js',
  'colorGrade.js',
  'createPostPipeline.js',
  'dithering.js',
  'heightFog.js',
  'selectiveBloom.js',
  'vignette.js',
];

function source(name) {
  return readFileSync(join(postfxDir, name), 'utf8');
}

test('all post-processing modules are valid ESM without legacy GLSL surfaces', () => {
  for (const file of files) {
    const path = join(postfxDir, file);
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    assert.doesNotMatch(source(file), /ShaderMaterial|EffectComposer|ShaderPass|vertexShader|fragmentShader/);
  }
});

test('selective bloom uses r185 MRT layer membership and material blending', () => {
  const text = source('selectiveBloom.js');
  assert.match(text, /from 'three\/webgpu'/);
  assert.match(text, /from 'three\/tsl'/);
  assert.match(text, /three\/addons\/tsl\/display\/BloomNode\.js/);
  assert.match(text, /onObjectUpdate\(\(\{ object \}\)/);
  assert.match(text, /object\?\.layers\?\.isEnabled\(layer\)/);
  assert.match(text, /getSelectiveBloomIntensity\(object\)/);
  assert.match(text, /mrt\(\{ output, bloom: bloomOutput \}\)/);
  assert.match(text, /setBlendMode\('bloom', new BlendMode\(MaterialBlending\)\)/);
  assert.match(text, /LEGACY_BLOOM_RESOLUTION_SCALE = 0\.25/);
  assert.match(text, /LEGACY_BLOOM_PIXEL_SCALE = LEGACY_BLOOM_RESOLUTION_SCALE \*\* 2/);
  assert.match(text, /return Math\.sqrt\(safePixelScale\)/);
  assert.match(text, /setResolutionScale\(bloomPixelScaleToResolutionScale\(pixelScale\)\)/);
});

test('pipeline builds one stable graph and retains the gameplay state facade', () => {
  const text = source('createPostPipeline.js');
  assert.match(text, /new RenderPipeline\(renderer, outputNode\)/);
  assert.match(text, /const scenePass = pass\(scene, camera, \{ samples: sceneSamples \}\)/);
  assert.match(text, /composer,/);
  assert.match(text, /bloomComposer,/);
  assert.match(text, /bloomPass,/);
  assert.match(text, /postFXPass,/);
  assert.match(text, /setCamera\(nextCamera\)/);
  assert.doesNotMatch(text, /export function createComposer/);
  assert.doesNotMatch(text, /export function resizeComposer/);
  assert.match(text, /renderPipeline\.dispose\(\)/);
  assert.match(text, /selectiveBloom\?\.dispose\(\)/);
  assert.match(text, /scenePass\.dispose\(\)/);
  assert.match(text, /renderer\.backend\?\.isWebGPUBackend !== true/);
  assert.match(text, /await scenePass\.compileAsync\(renderer\)/);
  assert.match(text, /renderer\.setRenderTarget\(previousRenderTarget\)/);
  assert.match(text, /renderer\.setMRT\(previousMrt\)/);
  assert.match(text, /warmupRenderCount \+= 1/);

  const renderBody = text.match(/const composer = \{[\s\S]*?\n  \};/)?.[0] || '';
  assert.match(renderBody, /renderPipeline\.render\(\)/);
  assert.doesNotMatch(renderBody, /createSelectiveBloom|createChromaticAberration|new RenderPipeline/);
});

test('legacy shader constants, accessibility uniforms, and HDR-safe optional dither are retained', () => {
  const pipeline = source('createPostPipeline.js');
  const chromatic = source('chromaticAberration.js');
  const fog = source('heightFog.js');
  const grade = source('colorGrade.js');
  const vignette = source('vignette.js');
  const accessibility = source('accessibilityPostfx.js');

  assert.match(pipeline, /chromatic: uniform\(0\.0008\)/);
  assert.match(pipeline, /vignette: uniform\(0\.45\)/);
  assert.match(pipeline, /fogAmount: uniform\(0\.18\)/);
  assert.match(pipeline, /ditheringAmount: uniform\(0\)/);
  assert.match(chromatic, /mul\(distance\)\.mul\(2\)/);
  assert.match(chromatic, /sceneColorNode\.sample\(sampleUv\)/);
  assert.match(chromatic, /bloomTextureNode\.sample\(sampleUv\)/);
  assert.doesNotMatch(chromatic, /convertToTexture|isRTTNode|renderTarget/);
  assert.match(fog, /smoothstep\(0, 0\.7, uv\(\)\.y\)/);
  assert.match(fog, /opposite the legacy/);
  assert.match(fog, /255\/121\/0/);
  assert.doesNotMatch(fog, /uv\(\)\.y\.oneMinus\(\)/);
  assert.match(grade, /vec3\(0\.001\)/);
  assert.match(grade, /sub\(0\.04\)\.mul\(1\.18\)/);
  assert.match(vignette, /smoothstep\(0\.35, 0\.95, distance\.mul\(1\.4\)\)/);
  assert.match(accessibility, /uReduceMotion: uniform\(0\)/);
  assert.match(accessibility, /uReduceFlashing: uniform\(0\)/);
  assert.match(accessibility, /uColorblind: uniform\(0\)/);
  assert.match(accessibility, /uHighContrast: uniform\(0\)/);
  const dithering = source('dithering.js');
  assert.doesNotMatch(dithering, /\bclamp\s*\(/);
  assert.match(dithering, /inputNode\.rgb\.add\(vec3\(noise\)\)/);
  assert.match(pipeline, /medium:[\s\S]*?ditheringAmount: 1/);
  assert.match(pipeline, /high:[\s\S]*?ditheringAmount: 1/);
  assert.match(pipeline, /ultra:[\s\S]*?ditheringAmount: 1/);
});

test('quality topology prunes disabled graphs and crossing a topology boundary rebuilds', () => {
  const pipeline = source('createPostPipeline.js');
  assert.match(pipeline, /const graphTopology = topologyForPreset\(initialPreset\)/);
  assert.match(pipeline, /const selectiveBloom = graphTopology\.bloom[\s\S]*\? createSelectiveBloom/);
  assert.match(pipeline, /: null;/);
  assert.match(pipeline, /PostPipelineRebuildRequiredError/);
  assert.match(pipeline, /POST_PIPELINE_REBUILD_REQUIRED/);
  assert.match(pipeline, /requiresRebuildForQuality\(nextQuality\)/);
  assert.match(pipeline, /graphTopology\.chromatic[\s\S]*\? createChromaticAberration/);
  assert.match(pipeline, /graphTopology\.dithering[\s\S]*\? createDitheringNode/);
  assert.match(pipeline, /graphTopology\.vignette[\s\S]*\? createVignetteNode/);
});

test('legacy bloom target scale accounts for both composer and UnrealBloomPass halving', () => {
  const bloom = source('selectiveBloom.js');
  assert.match(bloom, /LEGACY_BLOOM_RESOLUTION_SCALE = 0\.25/);
  assert.match(bloom, /LEGACY_BLOOM_PIXEL_SCALE = LEGACY_BLOOM_RESOLUTION_SCALE \*\* 2/);
  assert.match(bloom, /6\.25% pixels/);
});
