"""Generate the small, optimized bridge/cliff/dungeon-door GLB kit.

Run with Blender 4.2+:
  blender -b --python tools/generate-landmark-kit.py

The script is intentionally deterministic and keeps every asset origin at its
walkable/animation seam so the runtime can instance and animate it directly.
"""

from pathlib import Path
import math

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "kits" / "landmarks"
STONE_TEX = ROOT / "assets" / "textures" / "landmark_slate_masonry_512.webp"
WOOD_TEX = ROOT / "assets" / "textures" / "landmark_weathered_wood_512.webp"


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def image_material(name, path, roughness=0.9, tint=(1, 1, 1, 1)):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Base Color"].default_value = tint
    if path.exists():
        image = bpy.data.images.load(str(path), check_existing=True)
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Linear"
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def flat_material(name, color, roughness=0.85, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def to_blender_location(location):
    """Three.js Y-up (x,y,z) -> Blender Z-up (x,-z,y)."""
    x, y, z = location
    return (x, -z, y)


def to_blender_dimensions(dimensions):
    x, y, z = dimensions
    return (x, z, y)


def cube(name, location, dimensions, material, bevel=0.04, rotation=(0, 0, 0)):
    # The authored numbers throughout this file are game-space Three.js values.
    # A Three Y yaw maps directly to Blender Z yaw under (x,y,z)->(x,-z,y).
    rx, ry, rz = rotation
    bpy.ops.mesh.primitive_cube_add(
        location=to_blender_location(location),
        rotation=(rx, -rz, ry),
    )
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = to_blender_dimensions(dimensions)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        mod = obj.modifiers.new("soft_chips", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.data.materials.append(material)
    return obj


def cylinder_between(name, a, b, radius, material, vertices=8):
    a, b = Vector(to_blender_location(a)), Vector(to_blender_location(b))
    vec = b - a
    mid = (a + b) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=vec.length, location=mid)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(vec.normalized())
    obj.data.materials.append(material)
    return obj


def join_asset(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    objects[0].name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return objects[0]


def export_asset(obj, filename):
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(OUT / filename),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )


def build_stone_bridge(stone, iron):
    objects = []
    # Z is the crossing direction. The deck top is y=0 so heroes never appear
    # sunk into an asset while gameplay remains on the shared ground plane.
    for i in range(9):
        z = -3.6 + i * 0.9
        y = -0.13 + 0.025 * math.cos((i - 4) * math.pi / 8)
        objects.append(cube(
            f"deck_{i:02d}", (0, y, z), (3.65, 0.26, 0.86), stone,
            bevel=0.055, rotation=(0, (i % 3 - 1) * 0.006, (i % 2 - 0.5) * 0.008),
        ))
    for side in (-1, 1):
        x = side * 1.68
        for i in range(7):
            z = -2.8 + i * 0.93
            objects.append(cube(
                f"parapet_{side}_{i}", (x, 0.23, z), (0.30, 0.46, 0.82), stone,
                bevel=0.05, rotation=(0, 0, side * (i % 2 - 0.5) * 0.025),
            ))
    for z in (-2.15, 2.15):
        objects.append(cube(f"pier_{z}", (0, -0.66, z), (3.15, 1.15, 0.55), stone, bevel=0.08))
    for side in (-1, 1):
        objects.append(cylinder_between(
            f"brace_{side}", (side * 1.25, -0.10, -2.6), (side * 1.25, -0.78, 0), 0.07, iron, 8,
        ))
        objects.append(cylinder_between(
            f"brace_{side}_b", (side * 1.25, -0.78, 0), (side * 1.25, -0.10, 2.6), 0.07, iron, 8,
        ))
    return join_asset(objects, "landmark_bridge_stone")


def build_wood_bridge(wood, rope, iron):
    objects = []
    for i in range(14):
        z = -3.58 + i * 0.55
        yaw = (i % 5 - 2) * 0.008
        objects.append(cube(
            f"plank_{i:02d}", (0, -0.075 + (i % 3) * 0.008, z),
            (3.05 - (i % 4) * 0.04, 0.16, 0.50), wood, bevel=0.025,
            rotation=(0, yaw, (i % 2 - 0.5) * 0.012),
        ))
        for x in (-1.18, 1.18):
            bpy.ops.mesh.primitive_cylinder_add(
                vertices=8, radius=0.035, depth=0.05,
                location=to_blender_location((x, 0.025, z)),
            )
            nail = bpy.context.object
            nail.name = f"nail_{i}_{x}"
            nail.data.materials.append(iron)
            objects.append(nail)
    for x in (-1.1, 1.1):
        objects.append(cube(f"beam_{x}", (x, -0.25, 0), (0.18, 0.24, 7.55), wood, bevel=0.03))
    post_z = (-3.25, -1.1, 1.1, 3.25)
    for side in (-1, 1):
        x = side * 1.43
        for z in post_z:
            objects.append(cube(f"post_{side}_{z}", (x, 0.53, z), (0.16, 1.12, 0.16), wood, bevel=0.025))
        for a, b in zip(post_z[:-1], post_z[1:]):
            objects.append(cylinder_between(
                f"rope_{side}_{a}", (x, 0.88, a), (x, 0.72, (a + b) * 0.5), 0.035, rope, 7,
            ))
            objects.append(cylinder_between(
                f"rope_{side}_{b}", (x, 0.72, (a + b) * 0.5), (x, 0.88, b), 0.035, rope, 7,
            ))
    return join_asset(objects, "landmark_bridge_wood")


def build_cliff_edge(stone, dark):
    objects = []
    for i in range(9):
        x = -3.8 + i * 0.95
        h = 0.62 + (i * 37 % 5) * 0.12
        z = ((i * 17) % 5 - 2) * 0.06
        objects.append(cube(
            f"cliff_{i:02d}", (x, -0.22 + h * 0.18, z), (1.03, h, 0.72 + (i % 3) * 0.16),
            stone, bevel=0.12, rotation=((i % 3 - 1) * 0.06, (i % 4 - 1.5) * 0.08, (i % 2 - 0.5) * 0.12),
        ))
    objects.append(cube("cliff_shadow", (0, -0.35, 0.28), (8.5, 0.55, 0.42), dark, bevel=0.10))
    return join_asset(objects, "landmark_cliff_edge")


def build_portcullis(iron, wood):
    objects = []
    for i in range(7):
        x = -0.78 + i * 0.26
        objects.append(cube(f"bar_{i}", (x, 1.35, 0), (0.085, 2.45, 0.11), iron, bevel=0.018))
        bpy.ops.mesh.primitive_cone_add(
            vertices=8, radius1=0.085, radius2=0, depth=0.30,
            location=to_blender_location((x, 0.125, 0)),
        )
        spike = bpy.context.object
        spike.name = f"spike_{i}"
        spike.data.materials.append(iron)
        objects.append(spike)
    for y in (0.72, 1.48, 2.22):
        objects.append(cube(f"crossbar_{y}", (0, y, 0), (1.86, 0.16, 0.17), wood, bevel=0.025))
    for x in (-0.94, 0.94):
        objects.append(cube(f"runner_{x}", (x, 1.34, 0), (0.12, 2.68, 0.19), iron, bevel=0.02))
    gate = join_asset(objects, "dungeon_portcullis")
    # Origin on the floor is load-bearing: dungeonBuild animates position.y.
    gate.data.transform(gate.matrix_world)
    gate.matrix_world.identity()
    return gate


def main():
    reset_scene()
    stone = image_material("Grok Slate Masonry", STONE_TEX, roughness=0.94)
    wood = image_material("Grok Weathered Wood", WOOD_TEX, roughness=0.88, tint=(0.82, 0.72, 0.60, 1))
    iron = flat_material("Blackened Iron", (0.105, 0.12, 0.14), roughness=0.57, metallic=0.68)
    rope = flat_material("Hemp Rope", (0.24, 0.16, 0.085), roughness=1.0)
    dark = flat_material("Cliff Crevice", (0.035, 0.028, 0.045), roughness=1.0)

    for builder, filename in (
        (lambda: build_stone_bridge(stone, iron), "bridge_stone.glb"),
        (lambda: build_wood_bridge(wood, rope, iron), "bridge_wood.glb"),
        (lambda: build_cliff_edge(stone, dark), "cliff_edge.glb"),
        (lambda: build_portcullis(iron, wood), "dungeon_portcullis.glb"),
    ):
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        asset = builder()
        export_asset(asset, filename)
        print(f"exported {OUT / filename}")


if __name__ == "__main__":
    main()
