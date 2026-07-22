#!/usr/bin/env python3
"""Build optimized Kaki Rally terrain color, normal, and roughness maps.

The source plates are preserved under assets/source/grok/racing-terrain-v2.
Runtime maps are deterministic derivatives suitable for GitHub Pages.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "source" / "grok" / "racing-terrain-v2"
OUTPUT = ROOT / "assets" / "racing" / "terrain-v2"

SOURCES = {
    "forest": "mistwood-forest-ground-source.png",
    "twilight": "moonwater-wet-ground-source.png",
    "cinder": "emberfall-ground-source.png",
    "void": "riftbone-ground-source.png",
    "cave": "stonewright-ground-source.jpg",
    "kakiland": "kakiland-ground-source.png",
}

ROUGHNESS = {
    "forest": (196, 42),
    "twilight": (156, 72),
    "cinder": (210, 32),
    "void": (190, 38),
    "cave": (218, 28),
    "kakiland": (184, 35),
}

BRIGHTNESS = {
    "forest": 1.18,
    "twilight": 1.08,
    "cinder": 1.12,
    "void": 1.1,
    "cave": 1.14,
    "kakiland": 1.06,
}


def _contain(image: Image.Image, edge: int) -> Image.Image:
    image = image.convert("RGB")
    if image.width != image.height:
        side = min(image.width, image.height)
        left = (image.width - side) // 2
        top = (image.height - side) // 2
        image = image.crop((left, top, left + side, top + side))
    return image.resize((edge, edge), Image.Resampling.LANCZOS)


def _seamless_mirror(image: Image.Image, edge: int) -> Image.Image:
    """Mirror a source plate into a border-matched 2x2 runtime tile."""
    half = _contain(image, edge // 2)
    tile = Image.new("RGB", (edge, edge))
    tile.paste(half, (0, 0))
    tile.paste(half.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (edge // 2, 0))
    tile.paste(half.transpose(Image.Transpose.FLIP_TOP_BOTTOM), (0, edge // 2))
    tile.paste(
        half.transpose(Image.Transpose.FLIP_LEFT_RIGHT).transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (edge // 2, edge // 2),
    )
    return tile


def _normal_map(image: Image.Image, strength: float = 3.2) -> Image.Image:
    height = np.asarray(image.convert("L").filter(ImageFilter.GaussianBlur(1.15)), dtype=np.float32) / 255.0
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength
    normal = np.dstack((-dx, dy, np.ones_like(height)))
    normal /= np.maximum(np.linalg.norm(normal, axis=2, keepdims=True), 1e-6)
    packed = np.clip((normal * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(packed)


def _roughness_map(image: Image.Image, biome: str) -> Image.Image:
    base, spread = ROUGHNESS[biome]
    rgb = np.asarray(image, dtype=np.float32) / 255.0
    value = rgb.mean(axis=2)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    rough = base + (0.48 - value) * spread
    if biome == "twilight":
        puddle = (rgb[:, :, 2] > rgb[:, :, 0] * 1.18) & (value > 0.38) & (chroma > 0.12)
        rough[puddle] -= 82
    if biome == "cinder":
        ember = (rgb[:, :, 0] > rgb[:, :, 2] * 1.35) & (value > 0.35)
        rough[ember] -= 32
    rough = np.clip(rough, 48, 240).astype(np.uint8)
    return Image.fromarray(rough).filter(ImageFilter.GaussianBlur(0.7))


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    built = []
    for biome, filename in SOURCES.items():
        source = SOURCE / filename
        if not source.is_file():
            raise FileNotFoundError(source)
        color = _seamless_mirror(Image.open(source), 1024)
        color = ImageEnhance.Color(color).enhance(1.18)
        color = ImageEnhance.Contrast(color).enhance(1.24)
        color = ImageEnhance.Brightness(color).enhance(BRIGHTNESS[biome])
        color = ImageEnhance.Sharpness(color).enhance(1.16)
        color_path = OUTPUT / f"{biome}-ground-color.webp"
        normal_path = OUTPUT / f"{biome}-ground-normal.webp"
        rough_path = OUTPUT / f"{biome}-ground-roughness.webp"
        color.save(color_path, "WEBP", quality=88, method=6)
        _normal_map(color.resize((512, 512), Image.Resampling.LANCZOS)).save(
            normal_path, "WEBP", lossless=True, method=6
        )
        _roughness_map(color.resize((512, 512), Image.Resampling.LANCZOS), biome).save(
            rough_path, "WEBP", lossless=True, method=6
        )
        built.extend((color_path, normal_path, rough_path))
    total = sum(path.stat().st_size for path in built)
    print(f"Built {len(built)} terrain maps ({total / 1024 / 1024:.2f} MiB)")


if __name__ == "__main__":
    main()
