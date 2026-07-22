/**
 * Camera-aligned minimap projection.
 *
 * Gameplay input is screen-relative on the fixed isometric camera:
 *   screen right -> world (+X, -Z)
 *   screen down  -> world (+X, +Z)
 *
 * Projecting onto those two orthonormal axes makes movement on the minimap
 * match movement on screen. In particular, W / ArrowUp always travels toward
 * the top edge of the map instead of drifting diagonally on a north-up X/Z map.
 * This module is deliberately DOM/THREE-free so its direction contract can be
 * regression-tested in Node.
 */

export const MINIMAP_INV_SQRT2 = Math.SQRT1_2;

/** Write camera-view axes into `out`: right grows right, down grows down. */
export function worldToMinimapAxes(x, z, out) {
  const target = out || { right: 0, down: 0 };
  target.right = (x - z) * MINIMAP_INV_SQRT2;
  target.down = (x + z) * MINIMAP_INV_SQRT2;
  return target;
}

/**
 * Convert an axis-aligned world X/Z box to a camera-view axis-aligned box.
 * All four corners are required because the isometric projection rotates the
 * rectangle into a diamond.
 */
export function worldBoundsToMinimapBounds(bounds, out) {
  const target = out || { minRight: 0, maxRight: 0, minDown: 0, maxDown: 0 };
  let minRight = Infinity;
  let maxRight = -Infinity;
  let minDown = Infinity;
  let maxDown = -Infinity;

  const stamp = (x, z) => {
    const right = (x - z) * MINIMAP_INV_SQRT2;
    const down = (x + z) * MINIMAP_INV_SQRT2;
    if (right < minRight) minRight = right;
    if (right > maxRight) maxRight = right;
    if (down < minDown) minDown = down;
    if (down > maxDown) maxDown = down;
  };

  stamp(bounds.minX, bounds.minZ);
  stamp(bounds.maxX, bounds.minZ);
  stamp(bounds.maxX, bounds.maxZ);
  stamp(bounds.minX, bounds.maxZ);

  target.minRight = minRight;
  target.maxRight = maxRight;
  target.minDown = minDown;
  target.maxDown = maxDown;
  return target;
}

/** Map a projected axis pair into a fitted canvas viewport. */
export function minimapAxesToCanvas(right, down, viewport, out) {
  const target = out || { x: 0, y: 0 };
  const clampedRight = Math.max(viewport.minRight, Math.min(viewport.maxRight, right));
  const clampedDown = Math.max(viewport.minDown, Math.min(viewport.maxDown, down));
  target.x = viewport.ox + (clampedRight - viewport.minRight) * viewport.scale;
  target.y = viewport.oy + (clampedDown - viewport.minDown) * viewport.scale;
  return target;
}

/** Convenience projection used by tests and low-frequency UI code. */
export function worldToMinimapCanvas(x, z, viewport, out) {
  const right = (x - z) * MINIMAP_INV_SQRT2;
  const down = (x + z) * MINIMAP_INV_SQRT2;
  return minimapAxesToCanvas(right, down, viewport, out);
}
