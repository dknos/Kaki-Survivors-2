import {
  Color,
  RenderPipeline,
  Vector3,
} from 'three/webgpu';
import {
  pass,
  uniform,
  vec4,
} from 'three/tsl';

import {
  applyAccessibilityOptions,
  createAccessibilityUniforms,
} from './accessibilityPostfx.js';
import { createChromaticAberration } from './chromaticAberration.js';
import { createColorGradeNode } from './colorGrade.js';
import { createDitheringNode } from './dithering.js';
import { createHeightFogNode } from './heightFog.js';
import {
  BLOOM_LAYER,
  LEGACY_BLOOM_PIXEL_SCALE,
  createSelectiveBloom,
} from './selectiveBloom.js';
import { createVignetteNode } from './vignette.js';

export { BLOOM_LAYER } from './selectiveBloom.js';
export { applyAccessibilityOptions } from './accessibilityPostfx.js';

export const POSTFX_QUALITY_PRESETS = Object.freeze({
  legacy: Object.freeze({
    bloomEnabled: 1,
    bloomPixelScale: LEGACY_BLOOM_PIXEL_SCALE,
    gradingEnabled: 1,
    chromaticEnabled: 1,
    vignetteEnabled: 1,
    ditheringAmount: 0,
  }),
  low: Object.freeze({
    bloomEnabled: 0,
    bloomPixelScale: 0.25,
    gradingEnabled: 0.35,
    chromaticEnabled: 0,
    vignetteEnabled: 0,
    ditheringAmount: 0,
  }),
  medium: Object.freeze({
    bloomEnabled: 1,
    bloomPixelScale: 0.25,
    gradingEnabled: 1,
    chromaticEnabled: 0,
    vignetteEnabled: 1,
    ditheringAmount: 1,
  }),
  high: Object.freeze({
    bloomEnabled: 1,
    bloomPixelScale: 0.75 ** 2,
    gradingEnabled: 1,
    chromaticEnabled: 1,
    vignetteEnabled: 1,
    ditheringAmount: 1,
  }),
  ultra: Object.freeze({
    bloomEnabled: 1,
    bloomPixelScale: 1,
    gradingEnabled: 1,
    chromaticEnabled: 1,
    vignetteEnabled: 1,
    ditheringAmount: 1,
  }),
});

function topologyForPreset(preset) {
  return Object.freeze({
    bloom: preset.bloomEnabled === 1,
    chromatic: preset.chromaticEnabled === 1,
    vignette: preset.vignetteEnabled === 1,
    dithering: preset.ditheringAmount > 0,
  });
}

function topologyMatches(left, right) {
  return left.bloom === right.bloom
    && left.chromatic === right.chromatic
    && left.vignette === right.vignette
    && left.dithering === right.dithering;
}

function validateSamples(value) {
  const samples = Number(value);
  if (!Number.isInteger(samples) || samples < 0) {
    throw new RangeError('Post-processing samples must be a non-negative integer.');
  }
  return samples;
}

function createUniforms() {
  return {
    chromatic: uniform(0.0008),
    vignette: uniform(0.45),
    time: uniform(0),
    fogTint: uniform(new Color(0x3a4a44)),
    fogAmount: uniform(0.18),
    lift: uniform(new Vector3(0.00, 0.00, 0.02)),
    gamma: uniform(new Vector3(1.00, 1.00, 1.05)),
    gain: uniform(new Vector3(1.02, 1.00, 0.98)),
    bloomStrength: uniform(0.70),
    bloomRadius: uniform(0.50),
    bloomThreshold: uniform(0),
    bloomEnabled: uniform(1),
    gradingEnabled: uniform(1),
    chromaticEnabled: uniform(1),
    vignetteEnabled: uniform(1),
    ditheringAmount: uniform(0),
    ...createAccessibilityUniforms(),
  };
}

export class PostPipelineRebuildRequiredError extends Error {
  constructor(fromQuality, toQuality) {
    super(`Switching post-processing quality from ${fromQuality} to ${toQuality} requires a pipeline rebuild.`);
    this.name = 'PostPipelineRebuildRequiredError';
    this.code = 'POST_PIPELINE_REBUILD_REQUIRED';
    this.fromQuality = fromQuality;
    this.toQuality = toQuality;
  }
}

function makeBloomPassFacade(uniforms, selectiveBloom, initialPixelScale) {
  const facade = {};
  let pixelScale = initialPixelScale;
  Object.defineProperties(facade, {
    strength: {
      enumerable: true,
      get: () => uniforms.bloomStrength.value,
      set: (value) => { uniforms.bloomStrength.value = Number(value) || 0; },
    },
    radius: {
      enumerable: true,
      get: () => uniforms.bloomRadius.value,
      set: (value) => { uniforms.bloomRadius.value = Number(value) || 0; },
    },
    threshold: {
      enumerable: true,
      get: () => uniforms.bloomThreshold.value,
      set: (value) => { uniforms.bloomThreshold.value = Number(value) || 0; },
    },
    resolutionScale: {
      enumerable: true,
      get: () => selectiveBloom?.getResolutionScale() ?? Math.sqrt(pixelScale),
      set: (value) => {
        const resolutionScale = Math.min(1, Math.max(1 / 64, Number(value) || 0));
        pixelScale = resolutionScale * resolutionScale;
        selectiveBloom?.setResolutionScale(resolutionScale);
      },
    },
    pixelScale: {
      enumerable: true,
      get: () => selectiveBloom?.getPixelScale() ?? pixelScale,
      set: (value) => {
        pixelScale = Math.min(1, Math.max(1 / 4096, Number(value) || 0));
        selectiveBloom?.setPixelScale(pixelScale);
      },
    },
  });
  return facade;
}

/**
 * Stable Three.js r185 RenderPipeline/TSL post-processing graph.
 *
 * The graph is constructed once. Per-frame gameplay and accessibility changes
 * only write uniforms. The returned compatibility fields match the legacy
 * `{ composer, bloomComposer, bloomPass, postFXPass, setCamera }` shape.
 */
export function createPostPipeline({
  renderer,
  scene,
  camera,
  quality = 'legacy',
  bloomLayer = BLOOM_LAYER,
  accessibility = null,
  samples = 0,
} = {}) {
  if (!renderer) throw new TypeError('createPostPipeline requires a renderer.');
  if (!scene || !camera) throw new TypeError('createPostPipeline requires a scene and camera.');
  const initialPreset = POSTFX_QUALITY_PRESETS[quality];
  if (!initialPreset) throw new RangeError(`Unknown post-processing quality: ${quality}`);
  const graphTopology = topologyForPreset(initialPreset);
  const sceneSamples = validateSamples(samples);

  const uniforms = createUniforms();
  // Legacy post targets were not multisampled. Explicitly opt out so
  // renderer antialias settings cannot silently multiply MRT memory/bandwidth.
  const scenePass = pass(scene, camera, { samples: sceneSamples });
  const selectiveBloom = graphTopology.bloom
    ? createSelectiveBloom({
      scenePass,
      layer: bloomLayer,
      strength: uniforms.bloomStrength,
      radius: uniforms.bloomRadius,
      threshold: uniforms.bloomThreshold,
      enabled: uniforms.bloomEnabled,
      reduceFlashing: uniforms.uReduceFlashing,
      pixelScale: initialPreset.bloomPixelScale,
    })
    : null;
  const sceneColorNode = selectiveBloom?.sceneColorNode || scenePass.getTextureNode('output');
  const chromatic = graphTopology.chromatic
    ? createChromaticAberration({
      sceneColorNode,
      bloomTextureNode: selectiveBloom?.bloomTextureNode || null,
      amount: uniforms.chromatic,
      reduceMotion: uniforms.uReduceMotion,
      enabled: uniforms.chromaticEnabled,
    })
    : {
      node: selectiveBloom
        ? vec4(
          sceneColorNode.rgb.add(selectiveBloom.bloomTextureNode.rgb),
          sceneColorNode.a,
        )
        : sceneColorNode,
      inputTextures: selectiveBloom
        ? [sceneColorNode, selectiveBloom.bloomTextureNode]
        : [sceneColorNode],
      dispose() {},
    };
  const fogged = createHeightFogNode({
    inputNode: chromatic.node,
    tint: uniforms.fogTint,
    amount: uniforms.fogAmount,
  });
  const graded = createColorGradeNode({
    inputNode: fogged,
    lift: uniforms.lift,
    gamma: uniforms.gamma,
    gain: uniforms.gain,
    colorblind: uniforms.uColorblind,
    highContrast: uniforms.uHighContrast,
    enabled: uniforms.gradingEnabled,
  });
  const vignetted = graphTopology.vignette
    ? createVignetteNode({
      inputNode: graded,
      intensity: uniforms.vignette,
      enabled: uniforms.vignetteEnabled,
    })
    : graded;
  const outputNode = graphTopology.dithering
    ? createDitheringNode({
      inputNode: vignetted,
      amount: uniforms.ditheringAmount,
    })
    : vignetted;

  const renderPipeline = new RenderPipeline(renderer, outputNode);
  const postFXPass = { uniforms };
  const bloomPass = makeBloomPassFacade(uniforms, selectiveBloom, initialPreset.bloomPixelScale);
  let disposed = false;
  let activeQuality = null;
  let width = null;
  let height = null;
  let compiled = false;
  let warmupRenderCount = 0;

  function setQuality(nextQuality = 'legacy') {
    const preset = POSTFX_QUALITY_PRESETS[nextQuality];
    if (!preset) throw new RangeError(`Unknown post-processing quality: ${nextQuality}`);
    if (!topologyMatches(topologyForPreset(preset), graphTopology)) {
      throw new PostPipelineRebuildRequiredError(activeQuality || quality, nextQuality);
    }
    activeQuality = nextQuality;
    uniforms.bloomEnabled.value = preset.bloomEnabled;
    uniforms.gradingEnabled.value = preset.gradingEnabled;
    uniforms.chromaticEnabled.value = preset.chromaticEnabled;
    uniforms.vignetteEnabled.value = preset.vignetteEnabled;
    uniforms.ditheringAmount.value = preset.ditheringAmount;
    if (selectiveBloom) selectiveBloom.setPixelScale(preset.bloomPixelScale);
    else bloomPass.pixelScale = preset.bloomPixelScale;
    return preset;
  }

  // RenderPipeline passes and BloomNode track renderer drawing-buffer size.
  // This method exists for the legacy resize façade and diagnostics only.
  function setSize(nextWidth, nextHeight) {
    width = Math.max(1, Math.floor(nextWidth || 1));
    height = Math.max(1, Math.floor(nextHeight || 1));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderPipeline.dispose();
    chromatic.dispose();
    selectiveBloom?.dispose();
    scenePass.dispose();
  }

  /**
   * Compile the fully configured MRT scene pass, then submit one loading-screen
   * warmup frame so BloomNode and the fullscreen graph build before gameplay.
   */
  async function compile(nextScene = scenePass.scene, nextCamera = scenePass.camera) {
    if (disposed) throw new Error('Cannot compile a disposed post-processing pipeline.');
    if (nextScene) scenePass.scene = nextScene;
    if (nextCamera) scenePass.camera = nextCamera;
    // r185 PassNode.compileAsync() restores these on success but not when
    // renderer.compileAsync rejects. Guard the failure path so a friendly boot
    // error cannot strand the renderer on the offscreen MRT.
    const previousRenderTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    try {
      await scenePass.compileAsync(renderer);
    } finally {
      renderer.setRenderTarget(previousRenderTarget);
      renderer.setMRT(previousMrt);
    }
    renderPipeline.render();
    compiled = true;
    warmupRenderCount += 1;
    return true;
  }

  const composer = {
    render() {
      if (!disposed) renderPipeline.render();
    },
    setSize,
    compile,
    dispose,
    get pipeline() { return renderPipeline; },
  };

  // Compatibility no-op: MRT selective bloom is produced by the beauty pass,
  // so the old explicit first composer render must not submit a second scene.
  const bloomComposer = {
    renderToScreen: false,
    render() {},
    setSize,
    dispose() {},
  };

  const facade = {
    pipeline: renderPipeline,
    renderPipeline,
    scenePass,
    selectiveBloom,
    uniforms,
    composer,
    bloomComposer,
    bloomPass,
    postFXPass,
    render: () => composer.render(),
    resize: setSize,
    setSize,
    setQuality,
    getQuality: () => activeQuality,
    hasBloomGraph: () => graphTopology.bloom,
    requiresRebuildForQuality(nextQuality) {
      const preset = POSTFX_QUALITY_PRESETS[nextQuality];
      if (!preset) throw new RangeError(`Unknown post-processing quality: ${nextQuality}`);
      return !topologyMatches(topologyForPreset(preset), graphTopology);
    },
    setAccessibility: (options) => applyAccessibilityOptions(postFXPass, options),
    setCamera(nextCamera) {
      if (nextCamera) scenePass.camera = nextCamera;
    },
    setScene(nextScene) {
      if (nextScene) scenePass.scene = nextScene;
    },
    getSize: () => ({ width, height }),
    compile,
    getDiagnostics: () => ({
      quality: activeQuality,
      graphTopology: { ...graphTopology },
      sceneSamples,
      compiled,
      warmupRenderCount,
    }),
    dispose,
  };

  setQuality(quality);
  if (accessibility) facade.setAccessibility(accessibility);
  return facade;
}
