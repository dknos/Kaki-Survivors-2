#!/usr/bin/env node
/**
 * Focused direction contract for the camera-aligned minimap.
 *
 * Mirrors hero.js' isometric input remap, then proves each screen-space input
 * changes only the matching minimap axis. This stays browser-free so a broken
 * sign/rotation fails instantly in CI instead of relying on pixel inspection.
 */
import assert from 'node:assert/strict';
import {
  worldBoundsToMinimapBounds,
  worldToMinimapAxes,
  worldToMinimapCanvas,
} from '../src/minimapProjection.js';

const SQRT_HALF = Math.SQRT1_2;
const viewport = {
  minRight: -100,
  maxRight: 100,
  minDown: -100,
  maxDown: 100,
  ox: 0,
  oy: 0,
  scale: 1,
};

function worldDeltaForInput(screenX, screenY) {
  return {
    x: (screenX + screenY) * SQRT_HALF,
    z: (screenY - screenX) * SQRT_HALF,
  };
}

function projectedDeltaForInput(screenX, screenY) {
  const world = worldDeltaForInput(screenX, screenY);
  const origin = worldToMinimapCanvas(0, 0, viewport);
  const moved = worldToMinimapCanvas(world.x, world.z, viewport);
  return { x: moved.x - origin.x, y: moved.y - origin.y };
}

const up = projectedDeltaForInput(0, -1);
const down = projectedDeltaForInput(0, 1);
const left = projectedDeltaForInput(-1, 0);
const right = projectedDeltaForInput(1, 0);

assert.ok(Math.abs(up.x) < 1e-10 && up.y < -0.99, `up projected incorrectly: ${JSON.stringify(up)}`);
assert.ok(Math.abs(down.x) < 1e-10 && down.y > 0.99, `down projected incorrectly: ${JSON.stringify(down)}`);
assert.ok(left.x < -0.99 && Math.abs(left.y) < 1e-10, `left projected incorrectly: ${JSON.stringify(left)}`);
assert.ok(right.x > 0.99 && Math.abs(right.y) < 1e-10, `right projected incorrectly: ${JSON.stringify(right)}`);

const axes = worldToMinimapAxes(-SQRT_HALF, -SQRT_HALF);
assert.ok(Math.abs(axes.right) < 1e-10 && axes.down < -0.99, 'world-to-view helper drifted');

const bounds = worldBoundsToMinimapBounds({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
assert.ok(Math.abs(bounds.minRight + 10 * Math.SQRT2) < 1e-10, 'rotated minRight bound incorrect');
assert.ok(Math.abs(bounds.maxDown - 10 * Math.SQRT2) < 1e-10, 'rotated maxDown bound incorrect');

console.log('[smoke-minimap-projection] PASS — W/up maps up, D/right maps right');
