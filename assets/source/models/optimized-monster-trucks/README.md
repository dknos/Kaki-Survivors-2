# Optimized monster-truck donor pack

These four user-supplied Sketchfab GLBs were reduced for browser-game use. The
three static trucks remain development candidates. The animated donor was
promoted to the player-selectable **Tipsy Tumbler** and is loaded only when that
truck is selected.

| Runtime candidate | Original | Optimized | Creator / source / license |
|---|---:|---:|---|
| `chevrolet-silverado-2500hd-monster-truck-optimized-v1.glb` | 4.13 MiB | 0.77 MiB | [amogusstrikesback2](https://sketchfab.com/amogusstrikesback2), [source](https://sketchfab.com/3d-models/chevrolet-silverado-2500hd-monster-truck-175e6eb415894bcca1d4ce10058ac653), CC BY 4.0 |
| `chevrolet-bel-air-monster-truck-optimized-v1.glb` | 5.08 MiB | 0.80 MiB | [amogusstrikesback2](https://sketchfab.com/amogusstrikesback2), [source](https://sketchfab.com/3d-models/chevrolet-bel-air-monster-truck-017b68d0a5b94bd4ae3d19f1cd03c969), CC BY 4.0 |
| `volkswagen-type-2-monster-truck-optimized-v1.glb` | 4.61 MiB | 0.78 MiB | [amogusstrikesback2](https://sketchfab.com/amogusstrikesback2), [source](https://sketchfab.com/3d-models/volkswagen-type-2-monster-truck-3d621c333b9646dca03059cf4b8e809b), CC BY 4.0 |
| `assets/racing/monster-arena/models/tipsy-tumbler-monster-truck-v2.glb` | 51.43 MiB | 3.07 MiB | [aleksandr.yatsenco](https://sketchfab.com/aleksandr.yatsenco), [source](https://sketchfab.com/3d-models/drunk-monster-truck-82b67c22d68343d399439342ab935e0a), CC BY 4.0 |

Processing used glTF Transform to deduplicate and join compatible geometry,
simplify conservatively, quantize vertex attributes, resize and convert texture
payloads to WebP, and prune unused data. The first three use 512 px texture
ceilings. Tipsy Tumbler retains its 14-second animation with 15 channels and
uses a 512 px texture ceiling plus Meshopt compression. Its legacy
specular/glossiness materials were converted to metal/rough so Three.js renders
the embedded paint and grime textures correctly. All source attribution extras
remain embedded in the optimized GLBs.

These models retain third-party vehicle designs. Tipsy Tumbler has a fictional
player-facing identity; the three remaining candidates keep their source names
only in this development folder and are not exposed in the game UI.
