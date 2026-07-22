# Generated combat readability assets

These four project-owned assets were generated through the authenticated local Grok
Imagine / SuperHeavy workflow on 2026-07-12. No third-party artwork was copied.
Sources remain in the Grok session directory; the shipped files were chroma
keyed, inspected, resized with Lanczos, and encoded as alpha WebP.

## `forest/tar_bog.webp` (512x512)

Production prompt:

> Game VFX asset for Kitty Kaki Survivors: a top-down irregular enchanted
> forest tar bog hazard decal, asymmetrical muddy footprint rather than a
> perfect circle, dark cocoa-brown peat with mossy olive edge, three small
> rising bubbles shaped subtly like cat paw pads, thin amber warning rim and a
> few pale cyan magical motes, cozy whimsical hand-painted low-poly 3D game
> style, crisp readable silhouette at 96 pixels, centered with generous
> padding. Put only the decal on a perfectly flat solid #ff00ff chroma-key
> background. The background must be uniform with no floor, shadow, gradient,
> texture, reflection, or lighting variation. Do not use magenta in the
> subject. No character, no text, no logo, no watermark, no square frame, no
> circular disc.

## `weapons/cheesy_burger.webp` (512x512)

Production prompt:

> Game weapon sprite for Kitty Kaki Survivors: one unmistakable delicious
> cheeseburger seen from a slightly elevated three-quarter top-down angle,
> toasted sesame bun, melted golden cheese drips, dark grilled patty, lettuce
> and tomato, chunky cozy low-poly 3D render with hand-painted texture and a
> clean dark cocoa outline, magical warm rim light, premium mobile game pickup
> readability at 96 pixels, centered with generous padding. Put only the burger
> on a perfectly flat solid #00ff00 chroma-key background. The background must
> be uniform with no floor, cast shadow, contact shadow, glow field, gradient,
> texture, reflection, or lighting variation. Do not use bright green in the
> subject; lettuce should be muted deep teal. No plate, no character, no text,
> no logo, no watermark.

## `pickups/xp_paw_crystal.webp` (256x256)

Production prompt:

> Game XP pickup sprite for Kitty Kaki Survivors: a single magical crystal
> shaped like a cute cat paw, one large faceted central paw pad with four
> smaller crystal toe shards, pearly white and pale cyan so it can be
> color-tinted in engine, strong dark navy outer contour, bright internal facet
> highlights, tiny contained star glints, cozy polished low-poly 3D mobile game
> asset, extremely clear at 48 pixels, centered with generous padding. Put only
> the paw crystal on a perfectly flat solid #ff00ff chroma-key background. The
> background must be uniform with no floor, cast shadow, contact shadow, glow
> field, gradient, texture, reflection, or lighting variation. Do not use
> magenta in the subject. No loose pieces, no character, no text, no logo, no
> watermark, no square frame.

## `weapons/cheesy_burger_toxic.webp` (512x512)

Production prompt:

> Game evolved weapon sprite for Kitty Kaki Survivors: one unmistakable
> magical DOUBLE cheeseburger seen from a slightly elevated three-quarter
> top-down angle, two dark grilled patties, toasted sesame bun, thick luminous
> acid-lime cheese drips, small violet cat-paw rune branded into the top bun,
> wisps of contained mint toxic magic hugging the burger silhouette, chunky
> cozy low-poly 3D render with hand-painted texture and a clean dark cocoa
> outline, premium mobile game readability at 96 pixels, centered with generous
> padding. Put only the burger on a perfectly flat solid #ff00ff chroma-key
> background. The background must be uniform with no floor, cast shadow,
> contact shadow, large glow field, gradient, texture, reflection, or lighting
> variation. Do not use magenta in the subject; violet details must be muted
> blue-violet rather than pink. No plate, no character, no text, no logo, no
> watermark.

The tar bog uses normal alpha blending and no selective bloom so it remains
under actors. Burgers and XP paws use alpha-tested world sprites with depth
testing; both stay instanced to preserve browser performance.

## Nova and hostile projectile polish (2026-07-13)

The authenticated Grok Imagine / SuperHeavy workflow produced two additional
project-owned combat cutouts. Originals are preserved in `assets/source/grok/`;
production files were chroma keyed, inspected on a neutral background, resized
with Lanczos, and encoded as alpha WebP.

Source/output mapping:

- `assets/source/grok/nova_burst_paw_sigil.png` →
  `assets/fx/aoe/nova_pawburst.webp`
- `assets/source/grok/enemy_cat_spirit_bolt.png` →
  `assets/fx/projectiles/enemy_cat_spirit_bolt.webp`

### `aoe/nova_pawburst.webp` (512x512)

Production prompt:

> Production-ready game VFX decal for Kitty Kaki Survivors: one top-down
> magical Nova Burst sigil shaped unmistakably like a cat paw, a large pearly
> moonstone central paw pad with four smaller toe glyphs, elegant concentric
> enchanted-yarn arcs and short radial star rays, mint-cyan white and
> restrained lavender energy with warm gold accents, premium cozy dark-fantasy
> low-poly hand-painted 3D game style, strong clean silhouette readable beneath
> a character at 160 pixels, centered with generous padding, perfectly
> symmetrical enough to read as a deliberate player ability. Put only the VFX
> on a perfectly flat solid #ff00ff chroma-key background; the background must
> be uniform with no floor, cast shadow, gradient, texture, reflection,
> lighting variation, checkerboard, or transparency preview. Do not use
> magenta in the subject. No character, no text, no logo, no watermark, no
> square frame, no opaque circular disc, no random scribbles.

### `projectiles/enemy_cat_spirit_bolt.webp` (256x256)

Final targeted production prompt (after rejecting two uneven-background
variants):

> Production-ready directional enemy projectile sprite for Kitty Kaki
> Survivors: one compact hostile magical spirit shaped like a tiny mischievous
> low-poly cat mask flying horizontally to the right, sharp cat ears and bright
> almond eyes leading the silhouette, short whisker-fang streaks and one
> tapered twisted-yarn energy tail trailing to the left, pearly white and pale
> cyan body designed for purple fire and ice tinting in engine, polished cozy
> dark-fantasy mobile-game VFX, strong high-contrast silhouette readable at 40
> pixels, centered and filling about 70 percent of the canvas. CRITICAL CUTOUT
> REQUIREMENT: place the subject on an edge-to-edge perfectly uniform pure flat
> #00ff00 green background with exactly one color in every background pixel;
> no pink or magenta, no background lighting, no vignette, no gradient, no
> floor, no shadow, no halo, no texture, no transparency preview. Do not use
> green anywhere in the subject. No circle, no orb, no diamond, no cube, no
> text, no logo, no watermark, no frame, no loose pieces.

The Nova seal is a non-bloom floor layer rendered below opaque actors. Hostile
bolts use one painted core InstancedMesh plus one restrained bloom halo for two
draws total, replacing up to 144 transient primitive drawables.

## Forest weapon relic pickup (2026-07-13)

Source/output mapping:

- `assets/source/grok/weapon_relic_drop.png`
- `assets/fx/pickups/weapon_relic_drop.webp` (256x256 alpha WebP)

Production prompt:

> Production-ready game pickup sprite for Kitty Kaki Survivors: one floating
> enchanted weapon relic token viewed top-down three-quarter, an ornate dark
> cocoa and warm gold cat-paw medallion wrapped by a pale cyan enchanted yarn
> loop, tiny readable crossed wand and claw glyphs worked into the metal,
> pearly mint-blue magic highlights, premium cozy low-poly hand-painted 3D
> mobile-game asset, clean bold silhouette readable at 48 pixels, centered and
> filling about 72 percent of the canvas with generous padding. Put only the
> object on a perfectly uniform pure flat #ff00ff chroma-key background with
> exactly one background color, no floor, no cast shadow, no contact shadow,
> no large glow field, no gradient, no texture, no reflection, no transparency
> preview. Do not use magenta or pink in the subject. No character, no text,
> no logo, no watermark, no frame, no loose pieces.

The source was keyed in RGBA, premultiplied before Lanczos downsampling to
avoid magenta edge bleed, restored to straight alpha, and losslessly encoded
to WebP. The runtime material is alpha-tested, depth-tested, and shared by the
existing four-slot InstancedMesh pool.

## Paw-shaped enemy death feedback (2026-07-14)

Source/output mapping:

- `assets/source/imagegen/kill_paw_poof_source.png`
- `assets/fx/deaths/kill_paw_poof.webp` (256x256 additive WebP)

Production prompt:

> One single centered enemy-death impact burst shaped like a whimsical cat
> paw, formed from four compact ivory-and-aqua magical dust puffs, tiny peach
> star flecks, one short curled yarn wisp, and soft chunky smoky scallops;
> premium hand-painted cozy game VFX with a crisp silhouette at 64 pixels,
> isolated on pure black for additive blending. No complete circle, ring,
> halo, rune, sigil, target marker, text, character, floor, or watermark.

The old arcane circle expanded to more than three times its starting size and
looked like a persistent objective marker during dense waves. The replacement
poof stays compact, randomly rotates for variation, dissolves in 0.18-0.34s,
uses a single 64-slot InstancedMesh, and opts out of selective bloom so it
cannot wash over the hero.

## Cat-paw consumable marker (2026-07-14)

Source/output mapping:

- `assets/source/grok/pickup_paw_aura.png`
- `assets/fx/pickups/pickup_paw_aura.webp` (512x512 additive WebP)

Production prompt:

> Production game VFX decal texture for a cozy top-down 3D cat horde game:
> one compact magical CAT PAW pickup marker, a centered paw print with four
> toe beans, surrounded by broken whisker crescents and three tiny star
> glints, pearl cyan, mint, soft pink, and warm cream highlights, premium
> hand-painted fantasy VFX, crisp high-contrast silhouette readable at 64
> pixels, orthographic straight-down view, perfectly centered with generous
> empty padding, pure black background for additive blending. No complete
> circle, no ring, no donut, no yellow or gold, no text, no letters, no
> character, no item, no scenery, no perspective, no watermark, no border.

The badge replaces the generic yellow circles beneath bomb, magnet, and
chicken drops. Its broken whisker silhouette cannot be confused with a portal
or damage telegraph. All three pickup families share instanced geometry and
the cached texture; empty families submit zero instances.
