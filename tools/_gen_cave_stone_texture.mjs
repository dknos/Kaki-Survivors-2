#!/usr/bin/env node
/**
 * _gen_cave_stone_texture.mjs — P4A cohort 3 (2026-05-18)
 *
 * Deterministic procedural generator for the cave ground texture pack.
 * Mirrors the structure of `_gen_stone_texture.mjs` (forest stone, PR #137)
 * and `_gen_ground_normal.mjs` (forest ground normal, PR #139) so the cave
 * pack drops into env.js#groundPacks with the same shape as forest/twilight.
 *
 * Outputs:
 *   assets/textures/cave_stone_diffuse.png   — 256² RGB grayscale-luminance
 *                                              PNG, near-0.70 luminance band
 *                                              so STAGES.cave.groundTint
 *                                              (0x4a4a52 slot-2 stone) still
 *                                              reads as wet stone after the
 *                                              MeshStandardMaterial.color
 *                                              multiply.
 *   assets/textures/cave_stone_normal.png    — 256² tangent-space normal map,
 *                                              gentle wet-stone pebble
 *                                              relief (slightly stronger than
 *                                              forest ground normal — caves
 *                                              read wetter / more uneven).
 *   assets/textures/cave_stone_rough.png     — 256² R=G=B grayscale roughness
 *                                              map, mean ~0.85 with small fBm
 *                                              variance so highlights don't
 *                                              read perfectly uniform. Caves
 *                                              are wet stone — roughness sits
 *                                              between dry forest (~0.95) and
 *                                              pure puddle (~0.4).
 *
 * Palette discipline: diffuse is PURE LUMINANCE — no hue is encoded in the
 * PNG. The slot-2 wet-stone tint comes from STAGES.cave.groundTint applied
 * via `ground.material.color`. This keeps the cave pack palette-locked to
 * the 5-color cave contract per docs/CAVE_VISUAL_STYLE.md.
 *
 * Determinism: every PRNG seed is hard-coded (mulberry32). Re-running the
 * script yields byte-identical PNGs. Seeds chosen to NOT collide with the
 * forest generators (different magic numbers).
 *
 * Run:
 *   node tools/_gen_cave_stone_texture.mjs
 *   (no npm install — pngjs already vendored in node_modules/)
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SIZE = 256;

// Normal-map output strength. Caves want a slightly wetter / more uneven feel
// than forest ground (which uses STRENGTH=2.5), so we push to 3.2. env.js
// separately scales via `material.normalScale`; this stays gentle enough that
// the in-engine knob has a usable range.
const NORMAL_STRENGTH = 3.2;

// ── mulberry32 PRNG (matches _gen_stone_texture.mjs) ───────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── value-noise on a torus (wrap-safe; matches forest generators) ──────────
function makeNoise(seed, grid) {
  const rand = mulberry32(seed);
  const vals = new Float32Array(grid * grid);
  for (let i = 0; i < vals.length; i++) vals[i] = rand();
  function at(gx, gy) {
    const x = ((gx % grid) + grid) % grid;
    const y = ((gy % grid) + grid) % grid;
    return vals[y * grid + x];
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  return function sample(u, v) {
    const fx = u * grid;
    const fy = v * grid;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = smooth(fx - ix);
    const ty = smooth(fy - iy);
    const a = at(ix,     iy);
    const b = at(ix + 1, iy);
    const c = at(ix,     iy + 1);
    const d = at(ix + 1, iy + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty)
         + (c * (1 - tx) + d * tx) * ty;
  };
}

function fbm(seed, octaves) {
  const noises = [];
  let g = 4;
  for (let o = 0; o < octaves; o++) {
    noises.push({ n: makeNoise(seed + o * 19, g), amp: 1 / (1 << o) });
    g *= 2;
  }
  return function (u, v) {
    let s = 0;
    let norm = 0;
    for (const { n, amp } of noises) {
      s += n(u, v) * amp;
      norm += amp;
    }
    return s / norm;
  };
}

// ── diffuse: midtone-anchored fBm + crack hairlines + small moss specks ───
// Output is a 24-bit RGB triple where R=G=B (grayscale luminance), so the
// slot-2 wet-stone groundTint multiply on the material side decides the
// actual hue. Mean luminance ~0.70 (matches `_gen_stone_texture.mjs`).
function generateDiffuse() {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 2 }); // RGB

  const surface  = fbm(0xCA7E5705, 4);   // broad mottle
  const grit     = fbm(0xCA7E6172, 3);   // fine speckle
  const fineRand = mulberry32(0xCAB10B14);

  const lum = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const broad = surface(u, v);
      const fine  = grit(u * 3, v * 3);
      const grain = (fineRand() - 0.5) * 0.05;
      // Same recipe as forest stone — base 0.70, ±0.20 broad, ±0.04 fine.
      lum[y * SIZE + x] = 0.70 + (broad - 0.5) * 0.20 + (fine - 0.5) * 0.08 + grain;
    }
  }

  // 12 crack hairlines via Bresenham (slightly more than forest's 10 — caves
  // read more fractured). Luminance dip -0.20 (deeper than forest -0.18 so
  // cracks remain visible after the dark slot-2 tint multiply).
  const crackRand = mulberry32(0xCAFEC0CA);
  const CRACK_COUNT = 12;
  for (let c = 0; c < CRACK_COUNT; c++) {
    const x0 = Math.floor(crackRand() * SIZE);
    const y0 = Math.floor(crackRand() * SIZE);
    const ang = crackRand() * Math.PI * 2;
    const len = 36 + Math.floor(crackRand() * 56); // 36..91 px
    const x1 = x0 + Math.round(Math.cos(ang) * len);
    const y1 = y0 + Math.round(Math.sin(ang) * len);
    drawLineWrapped(lum, x0, y0, x1, y1, -0.20);
  }

  // Sparse moss-speck luminance bumps — diffuse stays palette-locked, so the
  // "moss" is just slightly brighter pixels (+0.05). The slot-3 glowmoss
  // authored cave details carry the actual cyan emissive.
  const mossRand = mulberry32(0xC0CA0E55);
  const MOSS_P = 0.04;     // slightly sparser than forest (0.05)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (mossRand() < MOSS_P) {
        addLumWrapped(lum, x, y, +0.05);
        addLumWrapped(lum, x + 1, y, +0.025);
        addLumWrapped(lum, x - 1, y, +0.025);
        addLumWrapped(lum, x, y + 1, +0.025);
        addLumWrapped(lum, x, y - 1, +0.025);
      }
    }
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let L = lum[y * SIZE + x];
      if (L < 0.20) L = 0.20;
      if (L > 0.92) L = 0.92;
      const idx = (y * SIZE + x) * 3;   // colorType=2 → 3 bytes/pixel
      const b = Math.round(L * 255);
      png.data[idx]     = b;
      png.data[idx + 1] = b;
      png.data[idx + 2] = b;
    }
  }
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 9 });
}

// ── normal: fBm heightmap → tangent-space normal map + pebble stamps ───────
function stampPebble(h, cx, cy, radius, sign, amplitude) {
  const r2 = radius * radius;
  const inv2sigma2 = 1 / (2 * (radius * 0.5) * (radius * 0.5));
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const x = ((cx + dx) % SIZE + SIZE) % SIZE;
      const y = ((cy + dy) % SIZE + SIZE) % SIZE;
      const falloff = Math.exp(-d2 * inv2sigma2);
      h[y * SIZE + x] += sign * amplitude * falloff;
    }
  }
}

function generateNormal() {
  const broad = fbm(0xCAFEFEED, 4);
  const fine  = fbm(0xC0CAB001, 3);
  const h = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const hb = broad(u, v) - 0.5;
      const hf = fine(u * 2, v * 2) - 0.5;
      // Caves read wetter — slightly more amplitude on the broad layer.
      h[y * SIZE + x] = hb * 0.75 + hf * 0.30;
    }
  }

  // 40 pebble stamps (slightly more than forest's 32 — cave floors read more
  // strewn with loose stone). Radius 4-10 px, mix of dips and bumps.
  const pRand = mulberry32(0xCABE1135);
  const PEBBLE_COUNT = 40;
  for (let i = 0; i < PEBBLE_COUNT; i++) {
    const cx = Math.floor(pRand() * SIZE);
    const cy = Math.floor(pRand() * SIZE);
    const radius = 4 + Math.floor(pRand() * 7); // 4..10
    const sign = pRand() < 0.5 ? -1 : +1;
    const amp = 0.14 + pRand() * 0.12;
    stampPebble(h, cx, cy, radius, sign, amp);
  }

  const png = new PNG({ width: SIZE, height: SIZE, colorType: 2 }); // RGB
  const sample = (x, y) => h[((y % SIZE) + SIZE) % SIZE * SIZE
                            + ((x % SIZE) + SIZE) % SIZE];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = sample(x + 1, y) - sample(x - 1, y);
      const dy = sample(x, y + 1) - sample(x, y - 1);
      const nx = -dx * NORMAL_STRENGTH;
      const ny = -dy * NORMAL_STRENGTH;
      const nz = 1.0;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      const rx = nx * invLen;
      const ry = ny * invLen;
      const rz = nz * invLen;
      const idx = (y * SIZE + x) * 3;   // colorType=2 → 3 bytes/pixel
      png.data[idx]     = Math.max(0, Math.min(255, Math.round((rx * 0.5 + 0.5) * 255)));
      png.data[idx + 1] = Math.max(0, Math.min(255, Math.round((ry * 0.5 + 0.5) * 255)));
      png.data[idx + 2] = Math.max(0, Math.min(255, Math.round((rz * 0.5 + 0.5) * 255)));
    }
  }
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 9 });
}

// ── roughness: gentle fBm around 0.85 mean ────────────────────────────────
// Wet stone reads wetter than dry forest dirt; mean roughness 0.85 with small
// ±0.08 variance from a single-octave noise lookup so highlights flicker
// across the surface without ever spiking to a mirror. Single channel
// duplicated to RGB for max texture-loader compat (matches the forest pack
// which is also RGB-stored grayscale).
function generateRough() {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: 2 }); // RGB
  const variance = fbm(0xC0CAB07F, 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const r = 0.85 + (variance(u, v) - 0.5) * 0.16;     // 0.77..0.93
      const clamped = Math.max(0.55, Math.min(0.98, r));
      const idx = (y * SIZE + x) * 3;
      const b = Math.round(clamped * 255);
      png.data[idx]     = b;
      png.data[idx + 1] = b;
      png.data[idx + 2] = b;
    }
  }
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 9 });
}

// Bresenham line, wrapping (toroidal). Adds `delta` luminance per pixel.
function drawLineWrapped(lum, x0, y0, x1, y1, delta) {
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const maxSteps = dx - dy + 2;
  let steps = 0;
  while (steps++ < maxSteps) {
    addLumWrapped(lum, x, y, delta);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function addLumWrapped(lum, x, y, delta) {
  const xx = ((x % SIZE) + SIZE) % SIZE;
  const yy = ((y % SIZE) + SIZE) % SIZE;
  lum[yy * SIZE + xx] += delta;
}

const repoRoot = new URL('../', import.meta.url);
writeFileSync(new URL('assets/textures/cave_stone_diffuse.png', repoRoot), generateDiffuse());
writeFileSync(new URL('assets/textures/cave_stone_normal.png',  repoRoot), generateNormal());
writeFileSync(new URL('assets/textures/cave_stone_rough.png',   repoRoot), generateRough());
console.log('[gen-cave-stone] wrote diffuse+normal+rough to assets/textures/cave_stone_{diffuse,normal,rough}.png');
