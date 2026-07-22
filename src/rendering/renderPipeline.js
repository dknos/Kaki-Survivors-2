/**
 * Backend-neutral render-pipeline adapter.
 *
 * The first WebGPU milestone can use the direct renderer path. TSL post-FX can
 * later inject a factory returning the stable r185 RenderPipeline without
 * changing gameplay call sites.
 */
export function createRenderPipeline({
  renderer,
  scene = null,
  camera = null,
  pipelineFactory = null,
  onBeforeRender = null,
  onAfterRender = null,
} = {}) {
  if (!renderer || typeof renderer.render !== 'function') {
    throw new TypeError('createRenderPipeline requires a renderer.');
  }

  let activeScene = scene;
  let activeCamera = camera;
  let pipeline = null;
  let initialized = false;
  let disposed = false;

  function updatePipelineBinding(kind, value) {
    if (!pipeline) return;

    const method = kind === 'scene' ? 'setScene' : 'setCamera';
    if (typeof pipeline[method] === 'function') {
      pipeline[method](value);
      return;
    }

    // A stable r185 RenderPipeline does not itself expose scene/camera setters;
    // the scene PassNode owns those references. Pipeline factories may expose
    // that node as `scenePass` so the neutral adapter can update it directly.
    const scenePass = pipeline.scenePass;
    if (scenePass && kind in scenePass) {
      scenePass[kind] = value;
      return;
    }

    throw new Error(
      `The active render pipeline cannot change ${kind}. `
      + `Expose ${method}() or the underlying PassNode as pipeline.scenePass.`,
    );
  }

  async function build(factory = pipelineFactory) {
    if (disposed) throw new Error('Cannot initialize a disposed render pipeline.');
    const previousPipeline = pipeline;
    const nextPipeline = factory
      ? await factory({ renderer, scene: activeScene, camera: activeCamera })
      : null;
    if (nextPipeline && typeof nextPipeline.render !== 'function') {
      if (typeof nextPipeline.dispose === 'function') nextPipeline.dispose();
      throw new TypeError('A render pipeline factory must return an object with render().');
    }
    pipeline = nextPipeline;
    if (
      previousPipeline
      && previousPipeline !== nextPipeline
      && typeof previousPipeline.dispose === 'function'
    ) {
      previousPipeline.dispose();
    }
    initialized = true;
    return pipeline;
  }

  const adapter = {
    async initialize() {
      if (!initialized) await build();
      return this;
    },

    setScene(nextScene) {
      if (nextScene === activeScene) return this;
      updatePipelineBinding('scene', nextScene);
      activeScene = nextScene;
      return this;
    },

    setCamera(nextCamera) {
      if (nextCamera === activeCamera) return this;
      updatePipelineBinding('camera', nextCamera);
      activeCamera = nextCamera;
      return this;
    },

    resize(width, height, pixelRatio) {
      if (pipeline && typeof pipeline.setSize === 'function') {
        pipeline.setSize(width, height, pixelRatio);
      } else if (pipeline && typeof pipeline.resize === 'function') {
        pipeline.resize(width, height, pixelRatio);
      }
    },

    render(nextScene = activeScene, nextCamera = activeCamera) {
      if (disposed) return false;
      if (!initialized) {
        throw new Error('Render pipeline must be initialized before render().');
      }
      if (nextScene !== activeScene) this.setScene(nextScene);
      if (nextCamera !== activeCamera) this.setCamera(nextCamera);
      if (typeof onBeforeRender === 'function') onBeforeRender({
        renderer,
        pipeline,
        scene: activeScene,
        camera: activeCamera,
      });
      try {
        if (pipeline) pipeline.render();
        else {
          if (!activeScene || !activeCamera) {
            throw new Error('Direct rendering requires both a scene and a camera.');
          }
          renderer.render(activeScene, activeCamera);
        }
      } finally {
        if (typeof onAfterRender === 'function') onAfterRender({
          renderer,
          pipeline,
          scene: activeScene,
          camera: activeCamera,
        });
      }
      return true;
    },

    async compile(nextScene = activeScene, nextCamera = activeCamera) {
      if (pipeline && typeof pipeline.compile === 'function') {
        await pipeline.compile(nextScene, nextCamera);
        return true;
      }
      if (!nextScene || !nextCamera || typeof renderer.compileAsync !== 'function') return false;
      await renderer.compileAsync(nextScene, nextCamera);
      return true;
    },

    async replace(nextFactory) {
      pipelineFactory = nextFactory || null;
      await build(pipelineFactory);
      return this;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (pipeline && typeof pipeline.dispose === 'function') pipeline.dispose();
      pipeline = null;
      activeScene = null;
      activeCamera = null;
    },

    getPipeline() { return pipeline; },
    getScene() { return activeScene; },
    getCamera() { return activeCamera; },
  };

  return adapter;
}
