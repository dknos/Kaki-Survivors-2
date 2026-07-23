#!/usr/bin/env python3
"""Build gameplay-ready avatar GLBs while preserving the authored sources.

Run from the repository root through Blender:

  blender --background --python tools/optimize-runtime-avatars.py -- --root .

The checked-in source meshes are unusually dense (roughly 400k-733k triangles)
for characters that are normally 40-120 pixels tall. This deterministic build
creates silhouette-preserving runtime copies and emits an audit report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct

import bpy


AVATARS = (
    ("tower-castle-plain.glb", 36_000),
    ("sote.glb", 36_000),
    ("cowboykaki.glb", 40_000),
    ("pipes.glb", 32_000),
    ("bomdia.glb", 40_000),
    ("mothman.glb", 40_000),
    ("camper.glb", 40_000),
    ("spacekitty.glb", 40_000),
    ("radcat.glb", 40_000),
    ("mona.glb", 40_000),
    ("bezelbug.glb", 40_000),
    ("rockerkaki.glb", 40_000),
    ("borgirboss.glb", 48_000),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    return parser.parse_args(__import__("sys").argv[__import__("sys").argv.index("--") + 1 :])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def glb_triangles(path: Path) -> int:
    with path.open("rb") as stream:
        header = stream.read(20)
        if len(header) != 20 or header[:4] != b"glTF" or header[16:20] != b"JSON":
            raise RuntimeError(f"{path.name}: exported file is not a valid GLB")
        json_length = struct.unpack_from("<I", header, 12)[0]
        document = json.loads(stream.read(json_length).decode("utf-8").rstrip(" \x00"))
    triangles = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor_index = primitive.get("indices", primitive.get("attributes", {}).get("POSITION"))
            count = document["accessors"][accessor_index]["count"] if accessor_index is not None else 0
            mode = primitive.get("mode", 4)
            triangles += count // 3 if mode == 4 else max(0, count - 2)
    return triangles


def mesh_triangles(obj: bpy.types.Object) -> int:
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def scene_meshes() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def simplify(source: Path, output: Path, target: int) -> dict[str, object]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = scene_meshes()
    before = sum(mesh_triangles(obj) for obj in meshes)
    if before <= 0:
        raise RuntimeError(f"{source.name}: imported with no triangles")

    ratio = min(1.0, target / before)
    if ratio < 0.999:
        for obj in meshes:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            modifier = obj.modifiers.new(name="Runtime silhouette decimation", type="DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            obj.select_set(False)

    after = sum(mesh_triangles(obj) for obj in scene_meshes())
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_color_quantization=10,
        export_draco_generic_quantization=12,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_apply=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    exported_triangles = glb_triangles(output)
    return {
        "source": source.as_posix(),
        "output": output.as_posix(),
        "sourceBytes": source.stat().st_size,
        "outputBytes": output.stat().st_size,
        "sourceTriangles": before,
        "runtimeTriangles": exported_triangles,
        "targetTriangles": target,
        "reductionPercent": round((1.0 - after / before) * 100.0, 2),
        "sourceSha256": sha256(source),
        "outputSha256": sha256(output),
    }


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    source_dir = root / "assets" / "breakroom"
    output_dir = source_dir / "runtime-avatars"
    rows = []
    for filename, target in AVATARS:
        source = source_dir / filename
        output = output_dir / filename
        if not source.is_file():
            raise FileNotFoundError(source)
        print(f"[runtime-avatar] {filename}: target {target:,} triangles", flush=True)
        row = simplify(source, output, target)
        row["source"] = source.relative_to(root).as_posix()
        row["output"] = output.relative_to(root).as_posix()
        rows.append(row)
        print(
            f"[runtime-avatar] {filename}: {row['sourceTriangles']:,} -> "
            f"{row['runtimeTriangles']:,} triangles, {row['outputBytes']:,} bytes",
            flush=True,
        )

    report = {
        "schemaVersion": 1,
        "generator": "tools/optimize-runtime-avatars.py",
        "blenderVersion": bpy.app.version_string,
        "method": "Blender Decimate COLLAPSE with triangulated Draco output",
        "assets": rows,
        "totals": {
            "sourceTriangles": sum(row["sourceTriangles"] for row in rows),
            "runtimeTriangles": sum(row["runtimeTriangles"] for row in rows),
            "sourceBytes": sum(row["sourceBytes"] for row in rows),
            "runtimeBytes": sum(row["outputBytes"] for row in rows),
        },
    }
    report_path = output_dir / "AVATAR_OPTIMIZATION.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"[runtime-avatar] report: {report_path}", flush=True)


if __name__ == "__main__":
    main()
