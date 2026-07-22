# Enemy sprite bake

Renders 3D enemy GLBs into a single billboard sprite atlas so the trash horde
draws as **one InstancedMesh per atlas (≈1 draw call)** instead of N animated
SkinnedMeshes. This is the fix for the render-bound late-game frame (≈280
enemies alive → ~1700 draw calls → 20 fps). Elites / minibosses / bosses stay
3D; only `_SPRITE_KEYS` tiers in `src/enemies.js` use the atlas.

Distinct from `tools/sprite-gen/` — that pipeline computes **FX** pixel-art by
formula against the 8-color palette. This one bakes the existing full-color
character GLBs, so a 2D trash mob matches the 3D elite of the same tier.

## Run

```bash
node tools/enemy-sprite-bake/run.mjs            # bake all 23 trash tiers
node tools/enemy-sprite-bake/run.mjs zombie     # bake one
node tools/enemy-sprite-bake/run.mjs zombie,orc # subset
```

Output: `assets/sprites/enemies_v1.png` + `assets/sprites/enemies_v1.json`.

## Contract

- **Roster names** in `bake.html` MUST match both the `ENEMY_TIERS` glb keys in
  `src/config.js` and the asset-map keys in `src/assets.js`. The `anim` name the
  sprite system looks up == the tier's glb key.
- **Camera pitch ~47°** matches the gameplay ortho cam `(hp.x+40, 60, hp.z+40)`.
  `billboard: cylinder` only rotates around Y, so the baked pitch IS the pose.
- **alphaTest 0.5** → opaque depth-writing cutout billboards (no blend halos in
  a dense horde). FX atlases stay blended; do not copy this to FX.
- After adding a tier here, add its name to `_SPRITE_KEYS` in `src/enemies.js`.

## Determinism

NOT byte-identical across machines. Unlike the FX pipeline
(`docs/SPRITE_GEN_PIPELINE.md`, which computes every pixel by formula and
enforces an md5sum contract), this baker renders GLBs through
ANGLE/swiftshader — GPU/driver-dependent rasterization, so re-runs produce
visually-equivalent but not bit-equal PNGs. Do NOT apply the FX md5sum
determinism check here. Re-bake only when the roster or camera changes;
review the PNG visually.

## Deps

`playwright-core` + a swiftshader chromium (paths hard-coded in `run.mjs` for
this workstation). The bake renders headless WebGL via ANGLE/swiftshader.
