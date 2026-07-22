#!/usr/bin/env python3
"""Convert Monster Arena source art into compact, game-ready raster assets."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/source/grok/monster-arena"
MATERIALS = ROOT / "assets/racing/monster-arena/materials"
VFX = ROOT / "assets/racing/monster-arena/vfx"
DECALS = ROOT / "assets/racing/monster-arena/decals"


def _smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def _edge_safe(image: Image.Image, size: int = 1024) -> Image.Image:
    """Keep the authored center while giving the final texture periodic edges."""

    source = ImageOps.fit(image.convert("RGB"), (size, size), Image.Resampling.LANCZOS)
    half = size // 2
    seed = ImageOps.fit(source, (half, half), Image.Resampling.LANCZOS)
    periodic = Image.new("RGB", (size, size))
    periodic.paste(seed, (0, 0))
    periodic.paste(ImageOps.mirror(seed), (half, 0))
    periodic.paste(ImageOps.flip(seed), (0, half))
    periodic.paste(ImageOps.flip(ImageOps.mirror(seed)), (half, half))

    # A soft square falloff preserves original, non-symmetric macro detail in
    # the center but lets the guaranteed-periodic image own the outer 18%.
    mask = Image.new("L", (size, size))
    pixels = mask.load()
    edge = size * 0.18
    for y in range(size):
        dy = min(y, size - 1 - y)
        for x in range(size):
            dx = min(x, size - 1 - x)
            pixels[x, y] = round(255 * _smoothstep(min(dx, dy) / edge))
    mask = mask.filter(ImageFilter.GaussianBlur(size * 0.018))
    result = Image.composite(source, periodic, mask)

    # Exact one-pixel equality avoids mip seam leakage.
    result.paste(result.crop((0, 0, 1, size)), (size - 1, 0))
    result.paste(result.crop((0, 0, size, 1)), (0, size - 1))
    return result


def _normal_from_height(image: Image.Image, strength: float = 2.45) -> Image.Image:
    height = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
    height = np.asarray(Image.fromarray(np.uint8(height * 255)).filter(ImageFilter.GaussianBlur(1.15)), dtype=np.float32) / 255.0
    gx = np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)
    gy = np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)
    nx = -gx * strength
    ny = gy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack(((nx / length + 1) * 0.5, (ny / length + 1) * 0.5, nz / length), axis=-1)
    return Image.fromarray(np.uint8(np.clip(normal, 0, 1) * 255), "RGB")


def _roughness_from_color(image: Image.Image) -> Image.Image:
    light = np.asarray(image.convert("L").resize((512, 512), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
    # Dry light dirt is rough; dark churned tracks retain a slightly smoother,
    # damp response. Keep the range tight enough for the arcade lighting rig.
    roughness = 0.64 + light * 0.28
    return Image.fromarray(np.uint8(np.clip(roughness, 0, 1) * 255), "L")


def _save_webp(image: Image.Image, path: Path, quality: int = 88) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "WEBP", quality=quality, method=6, exact=True)


def _make_ground_assets() -> None:
    source_a = Image.open(SOURCE / "arena-dirt-source-a.png")
    source_b = Image.open(SOURCE / "arena-dirt-source-b.png")
    base = _edge_safe(source_b)
    macro = _edge_safe(source_a)
    # Pull the generated orange source into the established Kaki umber range.
    macro = ImageEnhance.Color(macro).enhance(0.74)
    macro = ImageEnhance.Contrast(macro).enhance(0.92)
    color = Image.blend(base, macro, 0.23)
    color = ImageEnhance.Color(color).enhance(0.9)
    color = ImageEnhance.Contrast(color).enhance(1.04)
    _save_webp(color, MATERIALS / "arena-dirt-color.webp", 90)
    _save_webp(_normal_from_height(color), MATERIALS / "arena-dirt-normal.webp", 86)
    _save_webp(_roughness_from_color(color), MATERIALS / "arena-dirt-roughness.webp", 88)

    # The macro plate is sampled once over the arena by a shader overlay. Heavy
    # blur prevents it from competing with target silhouettes.
    macro_plate = macro.resize((512, 512), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(7.5))
    _save_webp(macro_plate, MATERIALS / "arena-dirt-macro.webp", 82)


def _make_procedural_decals() -> None:
    size = 1024
    sheet = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Quadrants: paired tire tracks, donut arcs, oil/scorch, rubble/dirt apron.
    from PIL import ImageDraw

    draw = ImageDraw.Draw(sheet, "RGBA")
    for lane in (154, 226):
        for step in range(13):
            y = 28 + step * 36
            wobble = math.sin(step * 0.9) * 11
            draw.rounded_rectangle((lane + wobble - 9, y, lane + wobble + 9, y + 25), 7, fill=(28, 20, 18, 118))
    for width, alpha in ((34, 100), (18, 145), (8, 185)):
        draw.arc((550 - width, 52 - width, 960 + width, 462 + width), 24, 320, fill=(35, 21, 18, alpha), width=max(4, width // 4))
    for radius, alpha in ((194, 42), (145, 55), (94, 68), (52, 85)):
        draw.ellipse((256 - radius, 768 - radius * 0.52, 256 + radius, 768 + radius * 0.52), fill=(21, 17, 17, alpha))
    for index in range(46):
        angle = index * 2.399
        radius = 28 + (index * 37 % 185)
        x = 768 + math.cos(angle) * radius
        y = 768 + math.sin(angle) * radius * 0.58
        r = 3 + index % 8
        color = (91 + index % 3 * 16, 69, 49, 105 + index % 4 * 20)
        draw.polygon(((x - r, y + r), (x + r * 0.3, y - r), (x + r, y + r * 0.5)), fill=color)
    sheet = sheet.filter(ImageFilter.GaussianBlur(0.55))
    _save_webp(sheet, DECALS / "arena-ground-decals.webp", 90)


def _make_vfx_atlas() -> None:
    source = ImageOps.fit(
        Image.open(SOURCE / "arena-vfx-sheet-source.jpg").convert("RGB"),
        (1024, 1024),
        Image.Resampling.LANCZOS,
    )
    atlas = Image.new("RGBA", source.size)
    for row in range(4):
        for column in range(4):
            cell = source.crop((column * 256, row * 256, (column + 1) * 256, (row + 1) * 256))
            rgb = np.asarray(cell, dtype=np.uint8)
            peak = rgb.max(axis=2).astype(np.float32)
            # The Grok sheet was deliberately generated on black. Convert that
            # carrier into smooth alpha while retaining soft charcoal smoke.
            alpha = np.clip((peak - 5.0) * 1.72, 0, 255).astype(np.uint8)
            alpha = np.asarray(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.45)))
            rgba = np.dstack((rgb, alpha))
            atlas.paste(Image.fromarray(rgba, "RGBA"), (column * 256, row * 256))
    atlas = atlas.resize((512, 512), Image.Resampling.LANCZOS)
    _save_webp(atlas, VFX / "arena-vfx-atlas.webp", 84)


def _make_crowd_strip() -> None:
    source = Image.open(SOURCE / "arena-crowd-source.png").convert("RGB")
    crowd = ImageOps.fit(source, (1024, 512), Image.Resampling.LANCZOS)
    crowd = ImageEnhance.Contrast(crowd).enhance(1.08)
    crowd = ImageEnhance.Color(crowd).enhance(0.92)
    _save_webp(crowd, MATERIALS / "arena-crowd-cats.webp", 81)


def main() -> None:
    _make_ground_assets()
    _make_procedural_decals()
    _make_vfx_atlas()
    _make_crowd_strip()
    print(f"MONSTER_MATERIALS={MATERIALS}")
    print(f"MONSTER_DECALS={DECALS}")
    print(f"MONSTER_VFX={VFX}")


if __name__ == "__main__":
    main()
