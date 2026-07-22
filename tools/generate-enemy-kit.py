"""Generate the original low-poly toy-enemy kit for Kitty Kaki Survivors.

Run with Blender 5.1+:
  blender --background --python tools/generate-enemy-kit.py

The exports are intentionally tiny, static GLBs. Runtime motion is applied by
the pooled enemy system so dozens of copies share the same geometry while the
models still bob, roll, scurry, wind up, and pounce in play.
"""

from pathlib import Path
import math

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "kits" / "enemies"


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def material(name, color, emissive=(0.0, 0.0, 0.0), strength=0.0,
             roughness=0.55, metallic=0.0):
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


def cube(name, location, dimensions, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=game_loc(location))
    obj = bpy.context.object
    obj.name = name
    apply_dimensions(obj, dimensions)
    if bevel > 0:
        mod = obj.modifiers.new("soft toy edges", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.data.materials.append(mat)
    return obj


def cone(name, location, dimensions, mat, vertices=4, game_axis="y"):
    rotation = (0.0, 0.0, 0.0)
    if game_axis == "z":
        rotation = (math.pi / 2, 0.0, 0.0)
    elif game_axis == "x":
        rotation = (0.0, math.pi / 2, 0.0)
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=0.5,
        radius2=0.0,
        depth=1.0,
        location=game_loc(location),
        rotation=rotation,
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
        location=mid,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def torus(name, location, major_radius, minor_radius, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        align="WORLD",
        major_segments=12,
        minor_segments=4,
        location=game_loc(location),
        rotation=rotation,
        major_radius=major_radius,
        minor_radius=minor_radius,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def join(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    root = objects[0]
    root.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return root


def build_yarn_wisp():
    plum = material("Moon Yarn", (0.42, 0.20, 0.68), (0.20, 0.04, 0.35), 0.18)
    mint = material("Enchanted Thread", (0.48, 0.94, 0.84), (0.18, 0.72, 0.66), 0.55,
                    roughness=0.32)
    ink = material("Mischief Ink", (0.035, 0.025, 0.075), (0.02, 0.01, 0.05), 0.08)
    # A readable cat-shaped yarn familiar, not a sphere with orbit rings. The
    # separated head, four paws, tall ears and long side-tail survive both
    # chase rotation and the game's small top-down presentation.
    parts = [
        ico("yarn cat body", (0, 0.48, -0.14), (1.10, 0.78, 1.25), plum, 2),
        ico("yarn cat head", (0, 0.67, 0.69), (0.96, 0.82, 0.84), plum, 1),
        cone("left cat ear", (-0.30, 1.12, 0.77), (0.38, 0.62, 0.42), mint),
        cone("right cat ear", (0.30, 1.12, 0.77), (0.38, 0.62, 0.42), mint),
        ico("left front paw", (-0.43, 0.24, 0.56), (0.34, 0.28, 0.42), mint, 1),
        ico("right front paw", (0.43, 0.24, 0.56), (0.34, 0.28, 0.42), mint, 1),
        ico("left back paw", (-0.46, 0.23, -0.48), (0.32, 0.26, 0.38), mint, 1),
        ico("right back paw", (0.46, 0.23, -0.48), (0.32, 0.26, 0.38), mint, 1),
        ico("muzzle yarn", (0, 0.55, 1.03), (0.48, 0.25, 0.24), mint, 1),
        ico("left eye", (-0.21, 0.75, 1.05), (0.13, 0.18, 0.08), ink, 1),
        ico("right eye", (0.21, 0.75, 1.05), (0.13, 0.18, 0.08), ink, 1),
        cone("tiny nose", (0.0, 0.57, 1.20), (0.13, 0.13, 0.10), ink, 3, "z"),
        # Two diagonal surface strands sell the yarn construction without the
        # Saturn/orb silhouette of the previous three full torus rings.
        cylinder_between("body yarn slash a", (-0.50, 0.90, -0.43),
                         (0.50, 0.89, 0.14), 0.045, mint, 5),
        cylinder_between("body yarn slash b", (-0.48, 0.88, 0.14),
                         (0.48, 0.89, -0.43), 0.045, mint, 5),
    ]
    tail = [(-0.44, 0.50, -0.52), (-0.82, 0.52, -0.86), (-1.18, 0.58, -0.74),
            (-1.34, 0.65, -0.34), (-1.17, 0.72, 0.02)]
    for i in range(len(tail) - 1):
        parts.append(cylinder_between(f"loose yarn tail {i}", tail[i], tail[i + 1], 0.070, mint, 6))
    parts.append(ico("tail pom", tail[-1], (0.22, 0.22, 0.22), mint, 1))
    return join(parts, "Yarn_Wisp")


def build_clockwork_mouse():
    brass = material("Warm Brass", (0.72, 0.38, 0.13), (0.10, 0.035, 0.01), 0.10,
                     roughness=0.38, metallic=0.62)
    teal = material("Patina Teal", (0.08, 0.34, 0.36), (0.02, 0.16, 0.18), 0.18,
                    roughness=0.44, metallic=0.38)
    glow = material("Moonstone Eyes", (0.70, 0.98, 0.92), (0.28, 0.96, 0.86), 0.95,
                    roughness=0.20)
    parts = [
        ico("mouse body", (0, 0.43, -0.08), (1.42, 0.78, 1.05), brass, 2),
        ico("mouse head", (0, 0.54, 0.61), (0.82, 0.72, 0.76), teal, 1),
        cone("mouse snout", (0, 0.48, 1.04), (0.46, 0.42, 0.55), teal, 6, "z"),
        ico("left ear", (-0.31, 0.88, 0.48), (0.48, 0.46, 0.24), brass, 1),
        ico("right ear", (0.31, 0.88, 0.48), (0.48, 0.46, 0.24), brass, 1),
        ico("left eye", (-0.22, 0.63, 0.93), (0.13, 0.16, 0.09), glow, 1),
        ico("right eye", (0.22, 0.63, 0.93), (0.13, 0.16, 0.09), glow, 1),
        ico("nose", (0, 0.47, 1.33), (0.14, 0.13, 0.14), glow, 1),
    ]
    for x in (-0.43, 0.43):
        for z in (-0.38, 0.30):
            parts.append(ico(f"wheel {x} {z}", (x, 0.18, z), (0.26, 0.30, 0.18), teal, 1))
    # Wind-up key: stalk and two broad paddles remain visible from top-down.
    parts.extend([
        cylinder_between("key stalk", (0, 0.70, -0.38), (0, 1.25, -0.38), 0.065, brass, 6),
        cube("key left", (-0.22, 1.25, -0.38), (0.38, 0.12, 0.14), brass, 0.035),
        cube("key right", (0.22, 1.25, -0.38), (0.38, 0.12, 0.14), brass, 0.035),
    ])
    tail = [(0, 0.42, -0.62), (0.42, 0.50, -0.98), (0.80, 0.62, -0.82),
            (0.91, 0.76, -0.52)]
    for i in range(len(tail) - 1):
        parts.append(cylinder_between(f"spring tail {i}", tail[i], tail[i + 1], 0.045, brass, 6))
    return join(parts, "Clockwork_Mouse")


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
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"exported {OUT / filename}")


def main():
    reset_scene()
    export_asset(build_yarn_wisp(), "yarn_wisp.glb")
    reset_scene()
    export_asset(build_clockwork_mouse(), "clockwork_mouse.glb")


if __name__ == "__main__":
    main()
