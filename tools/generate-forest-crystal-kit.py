"""Generate the authored Forest moonroot crystal kit.

Run with Blender 5.1+:
  blender --background --python tools/generate-forest-crystal-kit.py

The model replaces the old runtime cylinder-plus-cones crystal.  It is split
into exactly two static meshes (rooted base + crystal crown), allowing every
Forest copy to remain batched in two THREE.InstancedMesh draws.
"""

from pathlib import Path
import math

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "kits" / "forest"


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def material(name, color, emissive=(0.0, 0.0, 0.0), strength=0.0,
             roughness=0.58, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Emission Color"].default_value = (*emissive, 1.0)
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def game_loc(location):
    """Three.js Y-up (x,y,z) -> Blender Z-up (x,-z,y)."""
    x, y, z = location
    return (x, -z, y)


def game_dims(dimensions):
    x, y, z = dimensions
    return (x, z, y)


def apply_dimensions(obj, dimensions):
    obj.dimensions = game_dims(dimensions)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def ico(name, location, dimensions, mat, subdivisions=1):
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=subdivisions,
        radius=0.5,
        location=game_loc(location),
    )
    obj = bpy.context.object
    obj.name = name
    apply_dimensions(obj, dimensions)
    obj.data.materials.append(mat)
    return obj


def cylinder_between(name, a, b, radius, mat, vertices=6):
    av = Vector(game_loc(a))
    bv = Vector(game_loc(b))
    delta = bv - av
    mid = (av + bv) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=delta.length,
        end_fill_type="NGON",
        location=mid,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0.0, 0.0, 1.0)).rotation_difference(delta.normalized())
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def join(objects, name, role):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    root = objects[0]
    root.name = name
    root["assetRole"] = role
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return root


def crystal(name, base, height, radius, lean, mat, sides=6, twist=0.0):
    """Create a faceted shard with a real shoulder ring and pointed crown."""
    base_v = Vector(base)
    tip_v = base_v + Vector((lean[0], height, lean[1]))
    axis = (tip_v - base_v).normalized()
    helper = Vector((0.0, 1.0, 0.0))
    if abs(axis.dot(helper)) > 0.94:
        helper = Vector((1.0, 0.0, 0.0))
    u = axis.cross(helper).normalized()
    v = axis.cross(u).normalized()
    shoulder = base_v.lerp(tip_v, 0.72)

    game_verts = []
    for ring_center, ring_radius, ring_twist in (
        (base_v, radius, twist),
        (shoulder, radius * 0.78, twist + 0.18),
    ):
        for i in range(sides):
            a = ring_twist + (i / sides) * math.tau
            # Alternating radii keep the crown asymmetric without adding noise.
            rr = ring_radius * (0.92 if i % 2 else 1.06)
            p = ring_center + u * (math.cos(a) * rr) + v * (math.sin(a) * rr)
            game_verts.append(tuple(p))
    game_verts.append(tuple(tip_v))

    faces = []
    faces.append(tuple(range(sides - 1, -1, -1)))
    for i in range(sides):
        n = (i + 1) % sides
        a, b = i, n
        c, d = sides + n, sides + i
        if i % 2:
            faces.extend(((a, b, d), (b, c, d)))
        else:
            faces.extend(((a, b, c), (a, c, d)))
        faces.append((d, c, sides * 2))

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata([game_loc(p) for p in game_verts], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def build_moonroot():
    base_mat = material(
        "Moonroot Stone",
        (0.16, 0.22, 0.16),
        emissive=(0.015, 0.025, 0.015),
        strength=0.08,
        roughness=0.88,
    )
    crystal_mat = material(
        "Moonpetal Crystal",
        (0.32, 0.84, 0.76),
        emissive=(0.18, 0.92, 0.78),
        strength=1.15,
        roughness=0.24,
        metallic=0.06,
    )

    # A wide, irregular rooted foot anchors the prop to the ground.  The old
    # asset had no foot at all, which made its cylinder read like a candle.
    base_parts = [
        ico("mossy geode plinth", (0.0, 0.17, 0.0), (1.50, 0.42, 1.18), base_mat, 2),
        ico("left shoulder stone", (-0.55, 0.27, 0.04), (0.54, 0.40, 0.56), base_mat, 1),
        ico("right shoulder stone", (0.52, 0.25, 0.08), (0.50, 0.36, 0.52), base_mat, 1),
        ico("rear shoulder stone", (0.03, 0.25, 0.40), (0.62, 0.34, 0.46), base_mat, 1),
    ]
    root_paths = (
        ((-0.16, 0.25, -0.10), (-0.70, 0.16, -0.33), (-0.92, 0.08, -0.12)),
        ((0.18, 0.24, -0.05), (0.64, 0.15, -0.42), (0.91, 0.07, -0.28)),
        ((-0.28, 0.23, 0.12), (-0.58, 0.14, 0.52), (-0.35, 0.06, 0.72)),
        ((0.30, 0.23, 0.10), (0.62, 0.14, 0.44), (0.50, 0.06, 0.69)),
    )
    for path_i, path in enumerate(root_paths):
        for seg_i in range(len(path) - 1):
            base_parts.append(cylinder_between(
                f"moonroot {path_i}-{seg_i}", path[seg_i], path[seg_i + 1],
                0.085 - seg_i * 0.018, base_mat, 6,
            ))

    # Five shards make the paw-crown read from the game's high camera, while
    # the broad front gem supplies a recognizable palm instead of a flame tip.
    crown_parts = [
        crystal("heart shard", (0.00, 0.31, 0.02), 1.35, 0.27, (0.06, -0.04), crystal_mat, 7, 0.12),
        crystal("left toe shard", (-0.45, 0.28, 0.02), 0.95, 0.20, (-0.22, 0.05), crystal_mat, 6, 0.05),
        crystal("right toe shard", (0.45, 0.28, 0.04), 1.04, 0.21, (0.23, 0.04), crystal_mat, 6, 0.20),
        crystal("rear left toe shard", (-0.22, 0.29, 0.34), 0.78, 0.15, (-0.10, 0.18), crystal_mat, 6, 0.30),
        crystal("rear right toe shard", (0.21, 0.29, 0.36), 0.72, 0.145, (0.10, 0.17), crystal_mat, 6, 0.42),
        # Ground chips make the silhouette asymmetric even when an instance
        # happens to rotate its tallest shard directly behind the hero.
        crystal("left ground chip", (-0.73, 0.16, -0.18), 0.34, 0.10, (-0.14, -0.04), crystal_mat, 5, 0.10),
        crystal("right ground chip", (0.68, 0.16, 0.27), 0.30, 0.09, (0.12, 0.08), crystal_mat, 5, 0.36),
        ico("paw palm gem", (0.0, 0.46, -0.40), (0.66, 0.42, 0.48), crystal_mat, 1),
    ]

    base = join(base_parts, "Moonroot_Base", "base")
    crown = join(crown_parts, "Moonroot_Crystals", "crystal")
    base["gameplayPurpose"] = "forest chokepoint landmark"
    crown["gameplayPurpose"] = "readable moonroot crystal crown"
    return base, crown


def export_asset(objects, filename):
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(OUT / filename),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    print(f"exported {OUT / filename}")


def main():
    reset_scene()
    objects = build_moonroot()
    export_asset(objects, "moonroot_crystal_cluster.glb")


if __name__ == "__main__":
    main()
