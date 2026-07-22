import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  copyPerfHudDiagnostics,
  formatPerfHudDiagnostics,
  normalizePerfHudDiagnostics,
} from '../perfHudDiagnostics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function completeSnapshot() {
  return {
    backend: 'webgpu',
    deviceDescription: 'WebGPU test adapter',
    threeRevision: '185',
    resolution: { width: 1600, height: 900 },
    dpr: 1.25,
    quality: 'high',
    fps: 59.8,
    cpuFrameTimeMs: 6.25,
    renderSubmissionTimeMs: 1.5,
    gpuFrameTimeMs: 4.75,
    drawCalls: 72,
    triangles: 123456,
    points: 80,
    lines: 12,
    geometries: 64,
    textures: 33,
    renderTargets: 5,
    activeScene: 'forest',
    activeMode: 'run',
    dynamicResolutionScale: 0.9,
    compilationEventCount: 4,
    recentCompilationEvents: [{
      type: 'pipeline', label: 'forest-postfx', status: 'complete', durationMs: 12.5,
    }],
    deviceLossCount: 1,
  };
}

test('normalization keeps service metrics and fills unavailable startup context', () => {
  const normalized = normalizePerfHudDiagnostics({
    backend: 'webgl', fps: 0, cpuFrameTimeMs: null,
  }, {
    fps: 48.5,
    cpuFrameTimeMs: 20.6,
    resolution: { width: 1280, height: 720 },
    dpr: 1,
    activeScene: 'town',
    activeMode: 'town',
  });
  assert.equal(normalized.backend, 'webgl');
  assert.equal(normalized.fps, 48.5);
  assert.equal(normalized.cpuFrameTimeMs, 20.6);
  assert.deepEqual(normalized.resolution, {
    width: 1280, height: 720, cssWidth: 0, cssHeight: 0,
  });
  assert.equal(normalized.dpr, 1);
  assert.equal(normalized.activeScene, 'town');
  assert.equal(normalized.activeMode, 'town');
});

test('F3 diagnostics rows cover the renderer bug-report contract', () => {
  const report = formatPerfHudDiagnostics(completeSnapshot()).join('\n');
  for (const expected of [
    'Backend: webgpu',
    'Device: WebGPU test adapter',
    'Three.js: 185',
    'Resolution: 1600x900 @ DPR 1.25',
    'Quality: high',
    'FPS: 59.8',
    'CPU frame: 6.25 ms',
    'GPU frame: 4.75 ms',
    'Draw calls: 72',
    'Triangles: 123456',
    'Points: 80',
    'Lines: 12',
    'Textures: 33',
    'Render targets: 5',
    'Scene: forest',
    'Mode: run',
    'Dynamic resolution: 0.9',
    'Compilation events: 4',
    'Latest compilation: pipeline forest-postfx — complete, 12.50 ms',
    'Device losses: 1',
  ]) assert.match(report, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('copy uses Clipboard API when available', async () => {
  let copied = null;
  const text = await copyPerfHudDiagnostics(completeSnapshot(), {
    clipboard: { async writeText(value) { copied = value; } },
    documentRef: null,
  });
  assert.equal(copied, text);
  assert.match(text, /Backend: webgpu/);
  assert.match(text, /Compilation events: 4/);
});

test('copy falls back to a transient inaccessible textarea and restores focus', async () => {
  const appended = [];
  let fallbackFocused = false;
  let fallbackSelected = false;
  let originalFocusRestored = false;
  let copyCommands = 0;
  const documentRef = {
    activeElement: { focus() { originalFocusRestored = true; } },
    body: { appendChild(node) { appended.push(node); } },
    createElement(tagName) {
      assert.equal(tagName, 'textarea');
      return {
        style: {},
        setAttribute(name, value) { this[name] = value; },
        focus() { fallbackFocused = true; },
        select() { fallbackSelected = true; },
        remove() { this.removed = true; },
      };
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      copyCommands += 1;
      return true;
    },
  };

  const text = await copyPerfHudDiagnostics(completeSnapshot(), {
    clipboard: null,
    documentRef,
  });
  assert.match(text, /Backend: webgpu/);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]['aria-hidden'], 'true');
  assert.equal(appended[0].tabIndex, -1);
  assert.match(appended[0].style.cssText, /pointer-events:none/);
  assert.equal(appended[0].removed, true);
  assert.equal(fallbackFocused, true);
  assert.equal(fallbackSelected, true);
  assert.equal(originalFocusRestored, true);
  assert.equal(copyCommands, 1);
});

test('overlay remains non-interactive while hidden and keeps legacy probes', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src/perfHUD.js'), 'utf8');
  assert.match(source, /_el\.hidden = true/);
  assert.match(source, /pointer-events: none/);
  assert.match(source, /get\('rendererDiagnostics'\) === '1'/);
  assert.match(source, /_copyButton\.tabIndex = _on \? 0 : -1/);
  assert.match(source, /window\.kkPerfSnapshot =/);
  assert.match(source, /-- ms\/frame --/);
});
