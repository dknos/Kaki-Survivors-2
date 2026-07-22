# Forest Textures (PHASE 3 P3A + P3B — FOREST-V2-A32/A33)

Two historical tileable surface textures for the original Forest decor
silhouettes in `src/arenaDecor.js`. The moonroot GLB replacement no longer
uses the leaf/facet texture; bark remains on the Sap Hollow stone-root stubs.
Added to ship PR #136 (`feat(textures): tree bark + leaf textures on forest
decor`).

## Files

| File | Size | Use |
|------|------|-----|
| `forest_bark_512.png`   | 256×256 grayscale PNG-8 (~42 KB) | Runtime map on Sap Hollow stone-root stubs |
| `forest_leaves_512.png` | 256×256 grayscale PNG-8 (~30 KB) | Legacy source retained for reproducibility; no runtime request |

Total: ~72 KB (budget 500 KB per the FOREST-V2-A32 brief).

## Source

**Procedurally generated.** See `tools/_gen_tree_textures.mjs` for the
deterministic generator (mulberry32 PRNG, value-noise fBm + horizontal
crack threshold for bark; toroidally-wrapped soft-blob speckle + macro
fBm for leaves). Re-running the generator produces byte-identical PNGs.

ambientCG and Kenney nature packs were considered (per the agent brief)
but rejected because:

1. The minimum useful ambientCG bark zip (Bark012 1K) is ~19 MB before
   extraction, and palette-quantizing it to the locked forest 8-color
   palette would need ImageMagick (not installed in this workspace) or a
   second tool chain.
2. Procedural generation guarantees palette-neutrality on the first try
   (see "Palette" below) and is CI-reproducible.

No third-party assets were downloaded; no attribution is required.

The generator itself is original code, MIT-licensed alongside the
repository.

## Palette

Both textures are pure-luminance (single grayscale channel encoded as
RGB triplet for PNG compatibility, sRGB color space). They contain no
color information.

This is critical for palette discipline: the locked 8-color forest
palette in `docs/FOREST_VISUAL_STYLE.md` requires "no off-palette
colors." When a luminance texture is bound as `MeshStandardMaterial.map`
the GPU multiplies it pointwise by `material.color` (a palette slot)
plus `material.emissive`. The result is therefore always a shaded
variation of the existing palette slot — never a new hue. The squint
test passes by construction.

Verified slots that consume these textures (in `src/arenaDecor.js`):

| Builder | Body (bark) tint | Tip (leaves) tint | Tip emissive |
|---------|------------------|-------------------|--------------|
| `_buildSapHollowDecor`       | `0x2d3a55` (slot 2) | n/a (no tips)       | n/a |

## Tiling parameters

Set in `src/arenaDecor.js` at texture load time:

- `wrapS = wrapT = THREE.RepeatWrapping`
- `anisotropy = min(8, renderer.capabilities.getMaxAnisotropy())`
- `colorSpace = THREE.SRGBColorSpace`
- Bark `repeat.set(1, 4)` (tall vertical run on trunks)
- Leaves formerly used `repeat.set(2, 2)`; the authored moonroot GLB replaced
  those cone-tip consumers.

## P3B addendum — stone texture (FOREST-V2-A33, PR #137)

Added one additional procedural texture for the forest landmark + coffin
stone surfaces (shrine base, shrine obelisk, altar pedestal, altar pillar,
coffin lid, coffin base). Same generator pattern as P3A:

| File | Size | Use |
|------|------|-----|
| `forest_stone_512.png` | 256×256 grayscale PNG-8 (~41 KB) | `MeshStandardMaterial.map` on the cat-stele shrine, altar, and coffin stone surfaces |

Generator: `tools/_gen_stone_texture.mjs` — mulberry32(0x57104E55) seeded,
4-octave value-noise fBm centered near luminance 0.70, 10 Bresenham crack
hairlines, 5% moss-speck density. Re-running yields a byte-identical PNG.

Tiling parameters (set in `src/forestLandmarks.js` and `src/forestCoffins.js`):

- `wrapS = wrapT = THREE.RepeatWrapping`
- `repeat.set(1, 1)` — small surfaces, no tiling needed
- `anisotropy = 8`
- `colorSpace = THREE.SRGBColorSpace`

Palette: same luminance-only contract as P3A. The shared texture is
multiplied into the existing palette slot color (slot-1 bone `0xc7b89a`
for the sculpted cat stele, altar pillar, and coffin lid; slot-3 brown
`0x6b4f3a` for the altar pedestal and coffin base). The shrine's green moss
clumps use their flat material rather than pretending to be textured stone.
Squint test holds.

The texture instance is a module-private singleton inside each consumer
file so the loader fires exactly once per scene (`TextureLoader.load` is
cached, but the wrap/anisotropy setup runs only once either way).

## P3D addendum — sky-dome gradient textures (FOREST-V2-A34, PR #138)

Five 256×128 RGB sRGB vertical-gradient PNGs (`sky_midday.png`,
`sky_golden.png`, `sky_dusk.png`, `sky_twilight.png`, `sky_bloodmoon.png`)
consumed by `src/forestSkyDome.js`. Each file is ~0.5 KB (~2.5 KB total)
thanks to identical-row PNG filtering on a pure vertical gradient.
Generator: `tools/_gen_sky_textures.mjs`. Palette: atmospheric slot set
(BONE/DARK/AMBER/GOLD + slot-7 0xffd86b + cohort 20 reaper 0xff2020) —
no new hex constants. ShaderMaterial crossfades over 3s on day/night
phase change. `ClampToEdgeWrapping`, `LinearFilter`, `anisotropy = 8`,
`colorSpace = SRGBColorSpace`.

## P3E addendum — ground plane detail normals (FOREST-V2-A35, PR #139)

One additional procedural normal map for the main forest ground plane
(`src/env.js` `loadPack('assets/sprites/forrest_ground_01/')`). Overrides
the 1.4 MB Poly Haven `nor_gl.jpg` with a repo-tracked, palette-neutral,
deterministic tangent-space normal at 256×256 (~100 KB).

| File | Size | Use |
|------|------|-----|
| `forest_ground_normal_512.png` | 256×256 RGB PNG, NoColorSpace (~100 KB) | `MeshStandardMaterial.normalMap` on the forest stage ground plane |

Generator: `tools/_gen_ground_normal.mjs` — mulberry32-seeded 4-octave
value-noise fBm heightmap + 32 Gaussian-profile pebble stamps (random
sign, radius 4-9 px), converted to tangent-space normals via central
differences. STRENGTH=2.5 keeps the source map subtle so `env.js`'s
existing `normalScale = (0.6, 0.6)` reads as believable forest-floor
micro-detail under all four day/night phases (MIDDAY → BLOOD_MOON).

The Poly Haven rough JPG is retained. Its diffuse is now represented in the
authored Forest albedo blend below, and its normal is replaced by this compact
procedural map. Twilight pack (`brown_mud/`) is untouched by P3E.

`colorSpace = THREE.NoColorSpace` is mandatory: tangent-space normal data
must NOT be sRGB-decoded by the GPU, or the gradient direction inverts.

## Forest lived-in ground albedo (2026-07-12)

`ground_detail_forest_512.webp` is a 512×512 seamless sRGB WebP used by
`src/env.js` as Forest's diffuse map. It adds fine leaf fragments, clover
specks, petals, twigs, needles, pebbles, and moss without painting fake paths
under the authored moss-road and paw-trail systems.

The micro-detail layer was generated through the local authenticated Grok
Imagine / SuperHeavy workflow with this production prompt:

> Production seamless game texture for Kitty Kaki Survivors, square top-down
> forest ground MICRO-DETAIL albedo only. Uniform natural mossy grass and muted
> brown soil fibers with very small evenly scattered leaf fragments, tiny
> clover specks, miniature cream flower petals, fine twigs, pine needles, tiny
> pebbles, and subtle moss flecks. Every individual motif must be tiny, under 2
> percent of the tile width, low contrast, non-directional, and distributed
> without clusters. Perfectly seamless on all four edges, flat diffuse
> lighting, no shadows, no perspective, no raised objects. Absolutely no
> paths, no trails, no roads, no paw-print rows, no large leaves, no large
> clovers, no large flowers, no rock piles, no mushroom clusters, no central
> motif, no obvious quadrant repetition, no text, no logo, no watermark.
> Designed to blend at 25 percent opacity over an existing realistic PBR
> forest albedo beneath 3D characters and combat effects.

Grok's 1024×1024 output presented the seamless motif in a 2×2 proof. The
top-left 512×512 source tile was cropped and blended 28% over the downsampled
Poly Haven `forrest_ground_01/diff.jpg`, then encoded with FFmpeg/libwebp at
quality 84. The shipped texture is about 87 KB. The runtime keeps the existing
Poly Haven roughness plus the project-authored Forest normal, and no longer
downloads the retired 834 KB diffuse or 1.4 MB normal first.

## Multi-biome ambient sprites (2026-07-10)

Four transparent top-down sprites generated through the local authenticated
Grok Imagine / SuperHeavy workflow. `src/stageLife.js` renders each as one
pooled `InstancedMesh`, replacing the former one-butterfly-for-every-biome
placeholder while retaining a single ambient draw call per stage.

| File | In-game identity |
|------|------------------|
| `ambient_moon_moth_256.webp` | Twilight moon moth with cyan crescent markings |
| `ambient_ember_moth_256.webp` | Cinder charcoal moth with glowing ember cracks |
| `ambient_star_kitten_256.webp` | Void cyan cat-head comet wisp |
| `ambient_glowbat_256.webp` | Cave teal bioluminescent cat-bat |

The production prompt for each requested one centered, directly overhead,
cozy low-poly creature; a crisp silhouette readable at 64 px; transparent
background; and explicitly no ground, shadow, scenery, text, logo, border, or
UI. Grok's 1024 px RGBA outputs were inspected, then resized to 256 px WebP
with alpha using FFmpeg (`lanczos`, quality 82). Total shipped size is ~48 KB.

## License

Project-authored procedural and generated assets are distributed with the
game. Third-party texture sources and licenses are documented in their
respective sections above and in `assets/ASSETS_MANIFEST.md`.
