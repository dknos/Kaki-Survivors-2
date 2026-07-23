"""Build the performance-bounded Monster Smash traffic kit.

The source GLB stays untouched.  Run from the repository root with:

  blender --background --python tools/optimize-monster-runtime-assets.py

The arena renders one InstancedMesh per authored component, so source triangle
count is multiplied by every crushable of that class.  Ratios below spend
detail where it survives the gameplay camera and aggressively simplify the
high-poly wagon that otherwise dominates the whole arena.
"""

from __future__ import annotations

import json
from pathlib import Path

import bpy


REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "assets/racing/models/arena-traffic-kit-v1.glb"
OUTPUT = REPO / "assets/racing/models/arena-traffic-kit-runtime-v2.glb"
MAX_TEXTURE_EDGE = 512
ATTRIBUTION = {
    "derivativeSource": "assets/racing/models/arena-traffic-kit-v1.glb",
    "sourceOneAuthor": "asian3dmodel",
    "sourceOneLicense": "CC-BY-4.0",
    "sourceOneUrl": (
        "https://sketchfab.com/3d-models/"
        "full-pack-traffic-bussid-part-1-d1f3739ef6fa4ebbb5c7d30a66305f60"
    ),
    "sourceTwoAuthor": "asian3dmodel",
    "sourceTwoLicense": "CC-BY-4.0",
    "sourceTwoUrl": (
        "https://sketchfab.com/3d-models/"
        "pack-traffic-bussid-part-2-6a55c5170f6c4cafbdad2a042aeef4fd"
    ),
}

CLASS_RATIOS = {
    "ArenaTraffic_Sedan": 0.62,
    "ArenaTraffic_Wagon": 0.24,
    "ArenaTraffic_Pickup": 0.58,
    "ArenaTraffic_Van": 0.55,
    "ArenaTraffic_Limousine": 0.45,
    "ArenaTraffic_Bus": 0.45,
    "ArenaTraffic_RV": 0.45,
    "ArenaTraffic_Derby": 0.48,
    "ArenaTraffic_Crown": 0.45,
}


def triangle_count(mesh: bpy.types.Mesh) -> int:
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def owner_name(obj: bpy.types.Object) -> str | None:
    cursor = obj
    while cursor is not None:
        for class_name in CLASS_RATIOS:
            if cursor.name == class_name or cursor.name.startswith(f"{class_name}."):
                return class_name
        cursor = cursor.parent
    return None


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)


def main() -> None:
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    # Blender's GLTF importer does not round-trip scene extras automatically.
    # Reassert the preserved source provenance explicitly so the optimized GLB
    # remains independently attributable when copied away from this repository.
    for key, value in ATTRIBUTION.items():
        bpy.context.scene[key] = value

    before = 0
    after = 0
    class_counts: dict[str, dict[str, int]] = {
        name: {"before": 0, "after": 0, "meshes": 0}
        for name in CLASS_RATIOS
    }

    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        owner = owner_name(obj)
        if owner is None:
            continue
        original = triangle_count(obj.data)
        before += original
        class_counts[owner]["before"] += original
        class_counts[owner]["meshes"] += 1

        # Leave tiny planar/light components intact; decimation there tends to
        # erase the very color breaks that make these cars read as authored.
        if original >= 48:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            modifier = obj.modifiers.new(name="RuntimeLOD", type="DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = CLASS_RATIOS[owner]
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            obj.select_set(False)

        reduced = triangle_count(obj.data)
        after += reduced
        class_counts[owner]["after"] += reduced

    texture_sizes = {}
    for image in bpy.data.images:
        width, height = image.size
        if width <= 0 or height <= 0:
            continue
        original_size = [width, height]
        longest = max(width, height)
        if longest > MAX_TEXTURE_EDGE:
            scale = MAX_TEXTURE_EDGE / longest
            image.scale(max(1, round(width * scale)), max(1, round(height * scale)))
            # Mark the resized pixels as the source for the embedded GLB rather
            # than letting the exporter copy the original 1K/2K payload.
            image.pack()
        texture_sizes[image.name] = {
            "before": original_size,
            "after": list(image.size),
        }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=True,
    )

    print(json.dumps({
        "source": str(SOURCE.relative_to(REPO)),
        "output": str(OUTPUT.relative_to(REPO)),
        "trianglesBefore": before,
        "trianglesAfter": after,
        "reduction": round(1 - after / max(1, before), 4),
        "classes": class_counts,
        "textures": texture_sizes,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
