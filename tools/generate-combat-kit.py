"""Generate compact Blender-authored combat FX meshes.

Run with Blender 5.1+:
  blender --background --python tools/generate-combat-kit.py

The output is deliberately single-mesh, single-material geometry so runtime
effects can render many animated copies through one THREE.InstancedMesh draw.
Authored coordinates use the game's Y-up convention and are converted to
Blender's Z-up convention at construction time.
"""

from pathlib import Path
import math

import bpy


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "kits" / "combat"


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def material(name, color, emissive, roughness=0.42, metallic=0.18):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Emission Color"].default_value = (*emissive, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 0.35
    return mat


def to_blender_location(location):
    """Three.js Y-up (x,y,z) -> Blender Z-up (x,-z,y)."""
    x, y, z = location
    return (x, -z, y)


def cone_x(name, center_x, length, radius, points, mat, points_positive=True):
    """Low-poly cone whose tip points along game-space positive/negative X."""
    bpy.ops.mesh.primitive_cone_add(
        vertices=points,
        radius1=radius,
        radius2=0.018,
        depth=length,
        location=to_blender_location((center_x, 0.0, 0.0)),
        rotation=(0.0, math.pi / 2 if points_positive else -math.pi / 2, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def fin(name, location, dimensions, z_rotation, mat):
    bpy.ops.mesh.primitive_cone_add(
        vertices=3,
        radius1=0.5,
        radius2=0.0,
        depth=1.0,
        location=to_blender_location(location),
        rotation=(math.pi / 2, 0.0, z_rotation),
    )
    obj = bpy.context.object
    obj.name = name
    # Blender dimensions map game (x,y,z) -> (x,z,y).
    x, y, z = dimensions
    obj.dimensions = (x, z, y)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
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


def build_nova_claw_shard(mat):
    # Curved, tapered crystal claw. Each cross-section has a left foot, raised
    # ridge and right foot; the three longitudinal facets make the silhouette
    # read from an elevated camera without bevel modifiers or excess topology.
    # Runtime +X remains the launch axis, while the tip hooks toward +Z.
    sections = [
        (-0.38, -0.03, 0.28, 0.18),
        (-0.10,  0.00, 0.25, 0.22),
        ( 0.20,  0.07, 0.20, 0.23),
        ( 0.48,  0.19, 0.13, 0.18),
        ( 0.70,  0.38, 0.018, 0.035),
    ]
    game_vertices = []
    for i, (x, z, width, height) in enumerate(sections):
        prev = sections[max(0, i - 1)]
        nxt = sections[min(len(sections) - 1, i + 1)]
        tx, tz = nxt[0] - prev[0], nxt[1] - prev[1]
        mag = math.hypot(tx, tz) or 1.0
        nx, nz = -tz / mag, tx / mag
        floor_y = -height * 0.30
        game_vertices.extend([
            (x + nx * width, floor_y, z + nz * width),
            (x, height, z),
            (x - nx * width, floor_y, z - nz * width),
        ])

    faces = []
    for i in range(len(sections) - 1):
        a, b = i * 3, (i + 1) * 3
        # Left highlight facet, right shadow facet, and flat underside.
        faces.extend([
            (a, b, b + 1, a + 1),
            (a + 1, b + 1, b + 2, a + 2),
            (a + 2, b + 2, b, a),
        ])
    faces.extend([(0, 1, 2), (12, 14, 13)])

    verts = [to_blender_location(v) for v in game_vertices]
    mesh = bpy.data.meshes.new("nova_claw_shard_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    root = bpy.data.objects.new("nova_claw_shard", mesh)
    bpy.context.collection.objects.link(root)
    root.data.materials.append(mat)
    return root


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


def main():
    reset_scene()
    moon = material(
        "Moonstone Claw",
        (0.72, 0.93, 0.94),
        (0.18, 0.78, 0.80),
    )
    asset = build_nova_claw_shard(moon)
    export_asset(asset, "nova_claw_shard.glb")
    print(f"exported {OUT / 'nova_claw_shard.glb'}")


if __name__ == "__main__":
    main()
