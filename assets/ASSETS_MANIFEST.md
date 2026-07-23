# Assets Manifest — Kitty Kaki Survivors

Sources, licenses, and use-sites for every external 3D asset shipped with the
game. Anything added must be appended here with source URL + license + author.

All assets below are **CC0** (no attribution required). Where the upstream
license is CC-BY (Poly by Google), the credit line goes in `src/ui.js`
`showCredits()` modal (existing pattern from `assets/breakroom/`).

## Pre-existing — `assets/breakroom/`

Hero, enemies, pickups, primitive props from earlier milestones. See
`ASSETS.md` for the original drop-in list. Not duplicated here.

### Runtime avatar derivatives (2026-07-22)

`assets/breakroom/runtime-avatars/` contains gameplay-ready derivatives of the
existing project avatar GLBs. The originals remain untouched beside them and
retain their existing attribution/license records. The checked-in Blender
script `tools/optimize-runtime-avatars.py` applies silhouette-preserving
decimation plus Draco compression; `AVATAR_OPTIMIZATION.json` records source
and output hashes, byte sizes, and triangle counts for all 13 models.

## Pre-existing — `assets/sprites/`

- `forrest_ground_01/` — Poly Haven, CC0. Forest stage ground PBR pack
  (diff/rough/nor_gl at 1k). Source: https://polyhaven.com/a/forrest_ground_01
- `brown_mud/` — Poly Haven, CC0. Twilight + cinder ground pack.
  Source: https://polyhaven.com/a/brown_mud_03
- `hdri/approaching_storm_1k.hdr` — Poly Haven, CC0.
  Source: https://polyhaven.com/a/approaching_storm

---

## Iter 14 (2026-05-14) — `assets/kits/`

CC0 stylized 3D kits pulled from Poly Pizza CDN
(`https://static.poly.pizza/{uuid}.glb`). Resolved via the public model
pages (`https://poly.pizza/m/{slug}`); see `scripts/fetch-kits.sh` for
the slug→UUID map and a re-runnable fetch script.

### `assets/kits/town/` — forest district buildings

| File                  | Author    | License | Size  | Source slug                |
|-----------------------|-----------|---------|-------|----------------------------|
| `fantasy_house.glb`   | Quaternius | CC0     | 410 KB | https://poly.pizza/m/BH2XHWUNmF |
| `town_house.glb`      | Quaternius | CC0     | 762 KB | https://poly.pizza/m/sDQJBImZuw |
| `fantasy_inn.glb`     | Quaternius | CC0     | 469 KB | https://poly.pizza/m/x3ZcGn3jr4 |
| `tower_house.glb`     | Quaternius | CC0     | 231 KB | https://poly.pizza/m/xm5cViUjra |
| `castle_gate.glb`     | Quaternius | CC0     | 148 KB | https://poly.pizza/m/tKTchdiQzV |
| `fantasy_barracks.glb`| Quaternius | CC0     | 259 KB | https://poly.pizza/m/wTDbVozPAj |

Used by `src/env.js` (kingdom-district buildings) and `src/town.js`
(`Fantasy House` for cabin, `Castle Gate` for adventure gate).

### `assets/kits/dungeon/` — catacomb chamber

| File              | Author       | License | Size  | Source slug                |
|-------------------|--------------|---------|-------|----------------------------|
| `arch.glb`        | Kay Lousberg | CC0     | 46 KB | https://poly.pizza/m/uS8wgBVxOL |
| `pillar.glb`      | Kay Lousberg | CC0     | 24 KB | https://poly.pizza/m/1nt8n3rVKU |
| `pillar_alt.glb`  | Kay Lousberg | CC0     | 26 KB | https://poly.pizza/m/p8JPFIGc09 |
| `pillar_broken.glb` | Kay Lousberg | CC0   | 24 KB | https://poly.pizza/m/8RXyLygEeF |
| `coffin.glb`      | Kay Lousberg | CC0     | 96 KB | https://poly.pizza/m/ySERERWPgE |
| `crypt.glb`       | Kay Lousberg | CC0     | 77 KB | https://poly.pizza/m/iV5x01FYAl |
| `bone1.glb`       | Kay Lousberg | CC0     | 25 KB | https://poly.pizza/m/gVLnQi8VrX |
| `bone2.glb`       | Kay Lousberg | CC0     | 23 KB | https://poly.pizza/m/gVT6iydSY6 |
| `bone3.glb`       | Kay Lousberg | CC0     | 25 KB | https://poly.pizza/m/2jLwMoAb2y |

Used by `src/catacomb.js` (chamber set-dress) and twilight pack in
`src/arenaDecor.js` (broken pillar carryover).

### `assets/kits/ruins/` — twilight gravestones

| File                  | Author       | License | Size  | Source slug                |
|-----------------------|--------------|---------|-------|----------------------------|
| `damaged_grave.glb`   | Kay Lousberg | CC0     | 41 KB | https://poly.pizza/m/KWtVNrHXVR |
| `gravestone.glb`      | Kay Lousberg | CC0     | 31 KB | https://poly.pizza/m/lrEHKjTy29 |
| `gravestone_alt.glb`  | Kay Lousberg | CC0     | 30 KB | https://poly.pizza/m/ErfdU1GJSD |

Used by `src/arenaDecor.js` twilight pack.

### `assets/kits/torches/` — light sources

| File              | Author     | License | Size  | Source slug                |
|-------------------|------------|---------|-------|----------------------------|
| `torch_wall.glb`  | Quaternius | CC0     | 37 KB | https://poly.pizza/m/WGsvr4KOZd |
| `torch_stand.glb` | Quaternius | CC0     | 24 KB | https://poly.pizza/m/Gq38E7hFZw |

Used by `src/catacomb.js` wall torches (`torch_wall`) and any future
free-standing brazier set-dress.

---

## Iter 22A (2026-05-14) — `assets/kits/home/`

Cozy-room furniture for the cabin interior (`src/interior.js` +
`src/homeDecor.js`). Player-decoratable via the new `H`-key Decorate
overlay; placements persist via `meta.homePlacements`. All Quaternius CC0.

### `assets/kits/home/` — cozy home furniture

| File                | Author     | License | Size   | Source slug                |
|---------------------|------------|---------|--------|----------------------------|
| `rug.glb`           | Quaternius | CC0     | 7 KB   | https://poly.pizza/m/ZYBzMHnSbM |
| `plant.glb`         | Quaternius | CC0     | 683 KB | https://poly.pizza/m/MbhbP7JrTI |
| `lamp.glb`          | Quaternius | CC0     | 10 KB  | https://poly.pizza/m/RsWYHKkDhD |
| `bed.glb`           | Quaternius | CC0     | 252 KB | https://poly.pizza/m/BuRay4fVFr |
| `bookshelf.glb`     | Quaternius | CC0     | 29 KB  | https://poly.pizza/m/TDgvIuorcX |
| `cauldron.glb`      | Quaternius | CC0     | 46 KB  | https://poly.pizza/m/QaWJOPa6Gt |
| `chair.glb`         | Quaternius | CC0     | 27 KB  | https://poly.pizza/m/IRLaR71Pyn |
| `side_table.glb`    | Quaternius | CC0     | 45 KB  | https://poly.pizza/m/rAEBvfb1FT |
| `sofa.glb`          | Quaternius | CC0     | 15 KB  | https://poly.pizza/m/lmePppSu8a |
| `cat.glb`           | Quaternius | CC0     | 233 KB | https://poly.pizza/m/qKICY6xla2 |
| `chest.glb`         | Quaternius | CC0     | 159 KB | https://poly.pizza/m/RfSBvgcZUD |
| `banner_wall.glb`   | Quaternius | CC0     | 5 KB   | https://poly.pizza/m/Kd94xlw5aj |
| `banner_alt.glb`    | Quaternius | CC0     | 34 KB  | https://poly.pizza/m/svYG8KZxjq |
| `sword_mount.glb`   | Quaternius | CC0     | 133 KB | https://poly.pizza/m/3LyJaWgoJG |
| `shield_mount.glb`  | Quaternius | CC0     | 46 KB  | https://poly.pizza/m/neNWPt8WAx |
| `skull_mount.glb`   | Quaternius | CC0     | 91 KB  | https://poly.pizza/m/VGtSTNRf2O |

Catalog entry IDs and unlock-flag bindings live in
`src/homeDecor.js#HOME_CATALOG`. Wall items (`banner_*`, `*_mount`)
anchor to one of 4 walls × 8 fixed slot positions; floor items snap to
a 10×10 tile grid that masks out the existing fixture footprints (door,
desk, easel, kettle, computer, yarn basket, fireplace).

## Totals
- 36 new GLBs, **4.7 MB** added (post-CDN download).
- Combined `assets/` size after iter 22A: ~60 MB.
- All CC0 — no `ui.js` credit-modal changes required.

## Re-fetch
Run `bash scripts/fetch-kits.sh` from repo root. Idempotent; skips
already-downloaded files. Slug → UUID resolution happens at fetch time
in case Poly Pizza rotates CDN UUIDs (none observed across multiple
runs as of 2026-05-14).

---

## Multi-biome ambient sprites (2026-07-10)

Project-bound raster assets generated with the local Grok Imagine / SuperHeavy
workflow; no external model files or third-party artwork were copied. Final
files live in `assets/textures/`:

- `ambient_moon_moth_256.webp`
- `ambient_ember_moth_256.webp`
- `ambient_star_kitten_256.webp`
- `ambient_glowbat_256.webp`

Used by `src/stageLife.js` as stage-specific pooled ambient-life sprites.
Prompt constraints and production conversion details are recorded in
`assets/textures/README.md`.

---

## Forest lived-in ground albedo (2026-07-12)

- `assets/textures/ground_detail_forest_512.webp` — project-bound seamless
  Forest micro-detail albedo generated with the local Grok Imagine / SuperHeavy
  workflow, then blended over the existing CC0 Poly Haven Forest diffuse.

Used by `src/env.js`. The exact prompt and FFmpeg crop/blend/WebP production
details are recorded in `assets/textures/README.md`. No third-party artwork
beyond the already-listed CC0 Poly Haven base was introduced.

---

## Bullet Hell polish sprites (2026-07-12)

Eight project-bound raster assets were generated with the local Grok Imagine /
SuperHeavy workflow; no external artwork was copied:

- `assets/fx/bullethell/paw_bullet.webp`
- `assets/fx/bullethell/paw_bomb_icon.webp`
- `assets/fx/bullethell/paw_shot.webp`
- `assets/fx/bullethell/cat_bell_reward.webp`
- `assets/fx/foes/foe_boss_velvet.webp`
- `assets/fx/foes/foe_boss_cinder.webp`
- `assets/fx/foes/foe_boss_frost.webp`
- `assets/fx/foes/foe_boss_gold.webp`

Used by `src/bullethell/` for pooled projectile silhouettes, informed reward
choices, and the four biome-specific boss identities. Exact prompts and
conversion details are recorded in `assets/fx/bullethell/README.md`.

---

## Combat readability replacement sprites (2026-07-12)

Four project-bound raster assets were generated with the local Grok Imagine /
SuperHeavy workflow and converted to alpha WebP cutouts:

- `assets/fx/forest/tar_bog.webp` — irregular paw-print Forest tar hazard.
- `assets/fx/weapons/cheesy_burger.webp` — camera-facing Cheesy Burgers weapon.
- `assets/fx/weapons/cheesy_burger_toxic.webp` — evolved double-burger variant.
- `assets/fx/pickups/xp_paw_crystal.webp` — instance-tinted cat-paw XP shard.

They replace an opaque brown circle, multi-mesh burger/"orb" stacks, and
procedural octahedral XP diamonds while retaining the original pooled gameplay
systems. Exact prompts and conversion details are in `assets/fx/README.md`.

---

## Nova and projectile polish (2026-07-13)

Project-owned assets created for the right-click active and ranged-enemy pass:

- `assets/fx/aoe/nova_pawburst.webp` — Grok/SuperHeavy paw-and-yarn Nova seal.
- `assets/fx/projectiles/enemy_cat_spirit_bolt.webp` — Grok/SuperHeavy hostile
  spectral-cat bolt, instance-tinted for magic/fire/ice.
- `assets/kits/combat/nova_claw_shard.glb` — original Blender-authored curved
  moon-crystal claw; 1 mesh, 1 material, 26 triangles, approximately 3 KB.

The Blender source of truth is `tools/generate-combat-kit.py`. The GLB is
generated locally under Blender 5.1 and rendered as a fixed InstancedMesh by
`src/fx/novaBurst.js`; it does not use external artwork or require attribution.
Exact Grok prompts and raster conversion notes are in `assets/fx/README.md`.

---

## Forest moonroot crystal kit (2026-07-14)

The Forest's former dark cylinder + stacked-cone crystal placeholder is
replaced by one original, project-owned environment kit:

- `assets/kits/forest/moonroot_crystal_cluster.glb` — rooted moss-stone base
  plus an asymmetric five-shard paw crown; 2 meshes, 2 materials, 484
  triangles, approximately 15 KB.
- `assets/source/grok/forest_moonroot_crystal_concept.jpg` — preserved
  Grok/SuperHeavy production concept used as the modeling reference.

`src/arenaDecor.js` bakes the two GLB meshes once and uses two
`THREE.InstancedMesh` draws per Forest crystal room. `src/forestAmber.js`
merges the same geometry for the independently pulsing, shoot-to-detonate
amber nodes. The normal-lit facets stay outside selective bloom so the asset
does not bleach into an anonymous white silhouette.

Canonical Blender source: `tools/generate-forest-crystal-kit.py`. When Windows
Blender interop is unavailable inside WSL, the geometry-equivalent headless
exporter is `tools/export-forest-crystal-kit.py`.

Grok prompt (verbatim):

> Production concept reference for one compact low-poly 3D environment prop
> for Kitty Kaki Survivors: an asymmetric moonroot crystal geode growing from
> a mossy forest stone and curled roots, five branching faceted mint-cyan
> crystal shards forming a subtle cat-paw crown silhouette when viewed from a
> high top-down three-quarter game camera, broad readable base, warm amber rune
> inlay, cozy handcrafted premium game art, simple clean planes suitable for
> Blender modeling and instancing, orthographic isolated asset sheet on
> perfectly flat solid magenta background, no character, no text, no logo, no
> candles, no flame shapes, no straight dark pillar, no floating pieces, no
> photorealism

The GLB geometry and both generator scripts are original project artwork and
require no third-party attribution.

---

## Toy enemy kit (2026-07-13)

Two project-owned, texture-free Blender models add new readable wave mechanics:

- `assets/kits/enemies/clockwork_mouse.glb` — 1 mesh, 3 materials/primitives,
  458 triangles; wind-up pouncer with a guaranteed Leaping tell.
- `assets/kits/enemies/yarn_wisp.glb` — 1 mesh, 3 materials/primitives,
  388 triangles; cat-shaped yarn familiar with a rotating five-bolt ring.

The source of truth is `tools/generate-enemy-kit.py`. Runtime scurry/hover
motion is applied in `src/enemies.js` so pooled copies animate without bones,
mixers, or per-frame allocations. Both models are original project artwork and
require no external attribution.

`assets/breakroom/Dragon-Evolved.glb` is also activated as the new rare
Moonwing late-run elite. It is a pre-existing Quaternius Ultimate Monsters
asset (CC0), already shipped and preloaded by the project; this pass adds no
duplicate file or download weight. Canonical source and license page:
https://quaternius.com/packs/ultimatemonsters.html

---

## Forest weapon relic pickup (2026-07-13)

- `assets/source/grok/weapon_relic_drop.png` — preserved Grok Imagine source.
- `assets/fx/pickups/weapon_relic_drop.webp` — 256px alpha WebP used by the
  pooled Forest weapon-drop system.

The warm-gold cat-paw medallion and enchanted yarn loop replace the anonymous
flat pickup plane while preserving its one shared InstancedMesh draw. The
exact production prompt and chroma-key conversion notes are recorded in
`assets/fx/README.md`.

---

## Monster Smash Arena production-art kit (2026-07-21)

- `assets/racing/monster-arena/models/monster-arena-environment-kit-v1.glb`
  and `assets/source/blender/monster-arena/monster-arena-environment-kit.blend`
  are original project artwork generated by
  `tools/blender/build_monster_arena_environment_kit.py`. No third-party model
  is embedded.
- Dirt, crowd and VFX source images under
  `assets/source/grok/monster-arena/` are project-bound Grok Imagine outputs.
  Their processed runtime derivatives are under
  `assets/racing/monster-arena/`. Exact prompts and processing details are in
  `docs/monster-arena/README.md`; no generated source image is requested at
  runtime.
- The existing `assets/racing/models/arena-traffic-kit-v1.glb` remains a
  modified derivative of two CC BY 4.0 packs by
  [asian3dmodel](https://sketchfab.com/nguyenhoanglam20100609):
  [Full Pack Traffic Bussid Part 1](https://sketchfab.com/3d-models/full-pack-traffic-bussid-part-1-d1f3739ef6fa4ebbb5c7d30a66305f60)
  and
  [Pack Traffic Bussid Part 2](https://sketchfab.com/3d-models/pack-traffic-bussid-part-2-6a55c5170f6c4cafbdad2a042aeef4fd).
  Both source URLs and the license are also embedded in the derived GLB.
- `assets/racing/models/arena-traffic-kit-runtime-v2.glb` is the production
  runtime derivative of that preserved v1 kit. It reduces 15,025 source
  triangles to 6,729, caps embedded texture edges at 512 px, and is generated
  reproducibly with
  `blender --background --python tools/optimize-monster-runtime-assets.py`.
  It retains the v1 kit's CC BY 4.0 source attribution and does not replace or
  modify the source file.

The user-supplied Sketchfab audience is now also represented by
`assets/racing/monster-arena/models/arena-audience-bank-v1.glb`, an optimized
derivative of [Audience On Stage (people whatching concert)](https://sketchfab.com/3d-models/audience-on-stage-people-whatching-concert-a1cf1dd513b842e089d79bc2bc90b4ad)
by [AGUNG.IHACKSTUFF@GMAIL.COM](https://sketchfab.com/agung.ihackstuff), licensed
CC BY 4.0. The runtime derivative freezes a posed frame, removes the floor,
rigs, and animation track, reduces the geometry, and converts its retained
textures to 256 px WebP. No Poly Pizza model was needed for this pass.

Four additional user-supplied CC BY 4.0 monster trucks were optimized. Three
static candidates remain under `assets/source/models/optimized-monster-trucks/`
and are excluded from the runtime manifest. The animated donor by
[aleksandr.yatsenco](https://sketchfab.com/aleksandr.yatsenco), sourced from
[Drunk Monster Truck](https://sketchfab.com/3d-models/drunk-monster-truck-82b67c22d68343d399439342ab935e0a),
ships under the fictional player-facing name **Tipsy Tumbler** as
`assets/racing/monster-arena/models/tipsy-tumbler-monster-truck-v2.glb`.
It is licensed CC BY 4.0, retains the source animation and attribution metadata,
and is leased only when selected so the other monster-truck bodies are not
downloaded with it. Exact source sizes and processing details are recorded in
the candidate directory's `README.md`.

---

## Victory crew hangout (2026-07-16)

- `assets/source/grok/victory_crew_hangout_20260716.png` — preserved 1280×720
  Grok Imagine production source.
- `assets/screens/victory_crew_hangout_20260716.webp` — compact runtime splash
  shown by the dedicated victory results layout and Reaper-outlast summary.

The image is original project artwork with a text-free, UI-safe right side.
Runtime conversion used FFmpeg/libwebp at the source resolution; the CSS keeps
`image-rendering: pixelated` so hard clusters survive responsive scaling.

Grok prompt (verbatim):

> Final production game victory backdrop, 16:9, MUST LOOK LIKE A NATIVE
> 320x180 SNES-era PIXEL ART SCREENSHOT integer-upscaled to 1280x720. Hard
> square pixel clusters, chunky jagged 1-pixel stair-step outlines, flat cel
> colors, limited 24-color palette, zero smooth vector lines, zero painterly
> gradients, zero antialiasing. Cute neo-chibi late-1990s homemade Geocities
> webpage mood. Original hero crew relaxing in a cozy clubhouse after a win:
> plush cream cat with pink ears and red kerchief, big friendly charcoal wolf
> with gold bandana, tiny orange cowboy cat, cheerful mustached mechanic in red
> shirt and blue overalls, green twin-tail idol explorer, small pink-winged
> moth friend. They share burgers and fries around a glowing CRT, high-five,
> laugh, crown trophy and pixel confetti. Group fills left and center 62
> percent. Right 34 percent is dark calm lavender night with faint empty retro
> window frames and stars for live results UI. No words of any kind, no
> letters, no numbers, no symbols resembling text, no logos, no watermark, no
> photorealism, no copyrighted characters, no extra limbs, no weapons, no
> horror. Composition readable when displayed at 1280x720 and cropped to 16:9.
