import { detectRendererBackend, getRendererCapabilities } from './rendererCapabilities.js';
import { readRendererInfo } from './rendererDiagnostics.js';

/**
 * Backend-neutral reads for gameplay and QA modules. The stable service wins;
 * raw-renderer fallbacks support isolated tests and preview tooling.
 */
export function getRendererService(gameState) {
  return gameState?.rendererService || null;
}

export function getRendererInstance(gameState) {
  return getRendererService(gameState)?.renderer || gameState?.renderer || null;
}

export function getRendererCanvas(gameState) {
  const service = getRendererService(gameState);
  return service?.canvas
    || service?.renderer?.domElement
    || gameState?.renderer?.domElement
    || null;
}

export function getRendererDiagnostics(gameState, overrides = {}) {
  const service = getRendererService(gameState);
  if (typeof service?.getDiagnostics === 'function') {
    try { return service.getDiagnostics(overrides); } catch (_) {}
  }
  const renderer = getRendererInstance(gameState);
  return {
    backend: detectRendererBackend(renderer),
    ...readRendererInfo(renderer?.info),
    ...overrides,
  };
}

export function getActiveRendererCapabilities(gameState, options = {}) {
  const service = getRendererService(gameState);
  if (typeof service?.getCapabilities === 'function') {
    try { return service.getCapabilities(options); } catch (_) {}
  }
  return getRendererCapabilities(getRendererInstance(gameState), options);
}

export function getCapabilitiesForRendererSource(source, options = {}) {
  if (typeof source?.getCapabilities === 'function') {
    try { return source.getCapabilities(options); } catch (_) {}
  }
  return getRendererCapabilities(source?.renderer || source || null, options);
}
