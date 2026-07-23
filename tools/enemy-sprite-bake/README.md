# Enemy sprite bake

Renders 3D enemy GLBs into a single billboard sprite atlas so the trash horde
draws as **one InstancedMesh per atlas (≈1 draw call)** instead of N animated
SkinnedMeshes. This is the fix for the render-bound late-game frame (≈280
enemies alive → ~1700 draw calls → 20 fps). Elites / minibosses / bosses stay
3D; only `_SPRITE_KEYS` tiers in `src/enemies.js` use the atlas.

Distinct from `tools/sprite-gen/` — that pipeline computes **FX** pixel-art by
formula against the 8-color palette. This one bakes the existing full-color
character GLBs, so a 2D trash mob matches the 3D elite of the same tier.

## Forest v2 workflow

```bash
node tools/inspect-forest-enemies.mjs \
  --json docs/enemy-animation/FOREST_SOURCE_AUDIT.json

# Rebuild the non-destructive morph/rigid-component source derivatives when
# their authored poses change. Original assets/breakroom files stay untouched.
blender --background --python tools/enemy-sprite-bake/author_forest_animation.py

# Deterministically sample source clips/authored poses, pack the atlas, and run
# frame-bound, grounding, luminance, silhouette, and Spider-facing validation.
node tools/enemy-sprite-bake/run.mjs

# Regenerate the WebGL2/WebGPU motion sequence and dense-swarm evidence.
node tools/capture-enemy-animation-showcase.mjs
node tools/benchmark-enemy-sprites.mjs
```

Primary output:

- `assets/sprites/forest_enemies_v2.png`
- `assets/sprites/forest_enemies_v2.json`
- `docs/enemy-animation/SILHOUETTE_VALIDATION.json`
- `docs/enemy-animation/evidence/showcase/`
- `docs/enemy-animation/evidence/BENCHMARK_350.json`

`assets/sprites/enemies_v1.*` remains the bootstrap and non-Forest fallback.
The v2 roster is the ten authored Forest creatures plus Spider, whose real
walk/attack/death clips and red face marker make directional validation exact.

## Contract

- **Roster names and numeric IDs** in `bake.html` MUST match
  `_FOREST_SPRITE_SPECIES` in `src/enemies.js`.
- **Camera pitch ~47°** matches the gameplay ortho cam `(hp.x+40, 60, hp.z+40)`.
  `billboard: cylinder` only rotates around Y, so the baked pitch IS the pose.
- Supersampled 4× renders are downsampled into 112×112 cells with three-pixel
  gutters and alpha dilation. V2 uses linear filtering and mipmaps; intentional
  pixel-art FX atlases retain their own nearest-filter metadata.
- Depth-writing alpha-tested cutouts keep dense hordes sortable. FX atlases
  stay blended; do not copy the enemy cutout policy to FX.
- After adding a species, update the audit, authoring manifest, v2 validator,
  showcase row count, and `_FOREST_SPRITE_SPECIES`.

## Determinism

Pose sampling, packing, lighting, camera, guttering, and manifest generation are
deterministic. Raster bytes may differ slightly across GPU/driver versions, so
validation uses normalized silhouettes and visual metrics rather than an
FX-style checksum. The checked-in evidence is generated through the pinned
Chromium/SwiftShader profile in `run.mjs`.

## Deps

`playwright-core` + a swiftshader chromium (paths hard-coded in `run.mjs` for
this workstation). The bake renders headless WebGL via ANGLE/swiftshader.
