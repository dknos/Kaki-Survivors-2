"""Render a self-contained, colorful Kaki Land key-art image in Blender.

Run from the game repository with:
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" --background --python tools/render_kakiland_v2.py
"""

from pathlib import Path
import math
import random

import bpy
from mathutils import Vector


random.seed(23)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "kakiland" / "kaki-land-blender-v2.png"


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.materials, bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def make_material(name, color, metallic=0.0, roughness=0.48, emission=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*color, 1.0)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if emission:
        emission_color = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
        emission_strength = shader.inputs.get("Emission Strength")
        if emission_color:
            emission_color.default_value = (*color, 1.0)
        if emission_strength:
            emission_strength.default_value = emission
    return material


def assign(obj, material):
    obj.data.materials.append(material)
    return obj


def bevel(obj, amount=0.08, segments=2):
    modifier = obj.modifiers.new("Soft edges", "BEVEL")
    modifier.width = amount
    modifier.segments = segments
    return obj


def cube(name, location, dimensions, material, rotation=0.0, bevel_amount=0.0):
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=(0.0, 0.0, rotation))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(obj, material)
    if bevel_amount:
        bevel(obj, bevel_amount)
    return obj


def cylinder(name, location, radius, depth, material, vertices=16, rotation=None, bevel_amount=0.0):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation or (0.0, 0.0, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    assign(obj, material)
    if bevel_amount:
        bevel(obj, bevel_amount)
    return obj


def cone(name, location, radius_bottom, radius_top, depth, material, vertices=12, rotation=None):
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_bottom,
        radius2=radius_top,
        depth=depth,
        location=location,
        rotation=rotation or (0.0, 0.0, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    assign(obj, material)
    return obj


def sphere(name, location, scale, material, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(obj, material)
    return obj


def torus(name, location, major_radius, minor_radius, material, rotation=(math.pi / 2, 0.0, 0.0)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=48,
        minor_segments=12,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    assign(obj, material)
    return obj


def cylinder_between(name, start, end, radius, material, vertices=10):
    start = Vector(start)
    end = Vector(end)
    direction = end - start
    obj = cylinder(name, (start + end) / 2, radius, direction.length, material, vertices=vertices)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    return obj


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_light(name, location, color, energy, radius):
    data = bpy.data.lights.new(name, type="POINT")
    data.color = color
    data.energy = energy
    data.shadow_soft_size = radius
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    return obj


# Start clean before constructing named palette materials; otherwise Blender drops
# those materials as unused during reset_scene().
reset_scene()

# Palette: saturated enough for a game card, with a soft pastel sky around it.
SKY = (0.22, 0.62, 0.94)
ROCK = make_material("Warm sandstone rock", (0.31, 0.14, 0.13), roughness=0.92)
ROCK_LIGHT = make_material("Sunlit rock", (0.50, 0.24, 0.15), roughness=0.84)
DIRT = make_material("Rich earth", (0.22, 0.10, 0.045), roughness=1.0)
GRASS = make_material("Kaki meadow grass", (0.12, 0.49, 0.20), roughness=0.78)
GRASS_LIGHT = make_material("Kaki meadow highlights", (0.28, 0.76, 0.26), roughness=0.68)
STONE = make_material("Portal path stone", (0.22, 0.24, 0.38), metallic=0.08, roughness=0.56)
STONE_LIGHT = make_material("Ruined stone", (0.42, 0.45, 0.58), metallic=0.08, roughness=0.52)
WOOD = make_material("Bridge wood", (0.20, 0.075, 0.035), roughness=0.85)
GOLD = make_material("Ancient gate gold", (0.95, 0.48, 0.05), metallic=0.72, roughness=0.25)
DARK_METAL = make_material("Sealed gate metal", (0.065, 0.045, 0.13), metallic=0.72, roughness=0.25)
CLOUD = make_material("Soft peach cloud", (1.0, 0.70, 0.79), roughness=1.0)
CLOUD_LIGHT = make_material("Cloud silver lining", (0.92, 0.96, 1.0), roughness=0.95)
WATER = make_material("Waterfall glow", (0.06, 0.73, 0.96), metallic=0.08, roughness=0.18, emission=0.45)
EMBER = make_material("Ember portal", (1.0, 0.18, 0.03), metallic=0.08, roughness=0.2, emission=5.0)
TIDE = make_material("Tide portal", (0.02, 0.95, 1.0), metallic=0.08, roughness=0.2, emission=4.8)
BLOOM = make_material("Bloom portal", (0.86, 0.08, 0.92), metallic=0.08, roughness=0.2, emission=4.8)
MAIN_GLOW = make_material("Sealed portal pulse", (0.57, 0.10, 0.98), metallic=0.12, roughness=0.16, emission=3.4)
CRYSTAL_BLUE = make_material("Cyan crystals", (0.05, 0.78, 1.0), roughness=0.16, emission=1.7)
CRYSTAL_PINK = make_material("Pink crystals", (1.0, 0.12, 0.65), roughness=0.18, emission=1.45)
CRYSTAL_ORANGE = make_material("Orange crystals", (1.0, 0.31, 0.03), roughness=0.18, emission=1.45)
FLOWER_YELLOW = make_material("Golden flowers", (1.0, 0.78, 0.06), roughness=0.46)
FLOWER_PINK = make_material("Pink flowers", (1.0, 0.18, 0.52), roughness=0.42)
FLOWER_BLUE = make_material("Blue flowers", (0.18, 0.60, 1.0), roughness=0.42)
LEAF_DARK = make_material("Tree leaf dark", (0.03, 0.26, 0.12), roughness=0.76)
LEAF_LIGHT = make_material("Tree leaf light", (0.22, 0.68, 0.18), roughness=0.72)
TRUNK = make_material("Tree trunks", (0.19, 0.07, 0.025), roughness=0.92)


def make_island(name, x, y, radius, height=4.0):
    # A faceted rock taper gives each island a recognizable floating silhouette.
    cone(f"{name} rock", (x, y, -height / 2 + 0.1), radius * 0.29, radius * 0.96, height, ROCK, vertices=11)
    cone(f"{name} rock ledge", (x, y, -height * 0.20), radius * 0.45, radius * 1.02, height * 0.42, ROCK_LIGHT, vertices=11)
    cylinder(f"{name} dirt shelf", (x, y, 0.05), radius * 1.015, 0.26, DIRT, vertices=32, bevel_amount=0.06)
    cylinder(f"{name} grassy crown", (x, y, 0.22), radius, 0.28, GRASS, vertices=48, bevel_amount=0.10)

    # Cliffs and small ledges avoid a perfectly regular cone.
    for index in range(10):
        angle = (math.tau / 10) * index + 0.19
        ledge_radius = radius * random.uniform(0.70, 0.95)
        px = x + math.cos(angle) * ledge_radius
        py = y + math.sin(angle) * ledge_radius
        sphere(
            f"{name} cliff facet {index}",
            (px, py, random.uniform(-1.2, -0.25)),
            (random.uniform(0.24, 0.54), random.uniform(0.24, 0.54), random.uniform(0.25, 0.70)),
            ROCK_LIGHT if index % 3 == 0 else ROCK,
            subdivisions=1,
        )

    # Flowing cyan waterfalls turn the underside into a more magical silhouette.
    for index, angle in enumerate((0.55, 2.45, 4.50)):
        px = x + math.cos(angle) * radius * 0.82
        py = y + math.sin(angle) * radius * 0.82
        water = cube(
            f"{name} waterfall {index}",
            (px, py, -1.2),
            (0.34, 0.12, 2.05),
            WATER,
            rotation=angle,
            bevel_amount=0.08,
        )
        water.rotation_euler.z = angle


def add_tree(x, y, scale=1.0):
    cylinder("Tree trunk", (x, y, 0.83 * scale), 0.12 * scale, 1.25 * scale, TRUNK, vertices=8)
    sphere("Tree foliage low", (x, y, 1.78 * scale), (0.70 * scale, 0.70 * scale, 0.64 * scale), LEAF_DARK, subdivisions=2)
    sphere("Tree foliage high", (x + 0.10 * scale, y - 0.06 * scale, 2.14 * scale), (0.55 * scale, 0.55 * scale, 0.52 * scale), LEAF_LIGHT, subdivisions=2)


def add_flower_patch(cx, cy, count=9, spread=1.0, colors=(FLOWER_YELLOW, FLOWER_PINK, FLOWER_BLUE)):
    for index in range(count):
        angle = index * 2.399 + 0.27
        distance = spread * (0.15 + ((index * 7) % 10) / 11)
        x = cx + math.cos(angle) * distance
        y = cy + math.sin(angle) * distance
        flower = colors[index % len(colors)]
        cylinder("Flower stem", (x, y, 0.48), 0.025, 0.32, GRASS_LIGHT, vertices=6)
        sphere("Flower bloom", (x, y, 0.68), (0.11, 0.11, 0.08), flower, subdivisions=1)


def add_crystal_cluster(cx, cy, material, size=1.0, count=6):
    for index in range(count):
        angle = index * math.tau / count + 0.32
        distance = 0.30 + (index % 3) * 0.17
        height = size * (0.45 + (index % 4) * 0.16)
        cone(
            "Glowing crystal",
            (cx + math.cos(angle) * distance, cy + math.sin(angle) * distance, 0.45 + height / 2),
            size * 0.13,
            0.0,
            height,
            material,
            vertices=5,
            rotation=(0.12 * (index % 2), 0.08 * (index % 3), angle),
        )


def add_ruin_pillar(x, y, tall=1.0):
    cylinder("Broken ruin pillar", (x, y, 0.35 + tall / 2), 0.16, tall, STONE_LIGHT, vertices=8, bevel_amount=0.03)
    cylinder("Ruin cap", (x, y, 0.37 + tall), 0.24, 0.12, STONE, vertices=8, bevel_amount=0.03)
    sphere("Pillar rune", (x, y - 0.14, 0.72 + tall), (0.08, 0.04, 0.08), CRYSTAL_BLUE, subdivisions=1)


def add_bridge(start, end, name, glow_material):
    start = Vector(start)
    end = Vector(end)
    delta = end - start
    length = delta.length
    angle = math.atan2(delta.y, delta.x)
    direction = delta.normalized()
    perpendicular = Vector((-direction.y, direction.x, 0.0))

    board_count = max(5, int(length / 0.52))
    for index in range(board_count):
        t = (index + 0.5) / board_count
        position = start.lerp(end, t)
        board = cube(
            f"{name} bridge plank {index}",
            (position.x, position.y, 0.51),
            (length / board_count + 0.05, 1.25, 0.20),
            WOOD if index % 2 else STONE,
            rotation=angle,
            bevel_amount=0.035,
        )
        board.rotation_euler.z = angle

    # Two glowing safety rails frame every route from hub to trial island.
    for side in (-1.0, 1.0):
        rail_start = start + perpendicular * side * 0.59 + Vector((0, 0, 0.92))
        rail_end = end + perpendicular * side * 0.59 + Vector((0, 0, 0.92))
        cylinder_between(f"{name} rainbow rail {side}", rail_start, rail_end, 0.043, glow_material, vertices=8)
        for index in range(0, board_count + 1, 2):
            t = index / board_count
            post = start.lerp(end, t) + perpendicular * side * 0.59
            cylinder(f"{name} rail post {side} {index}", (post.x, post.y, 0.71), 0.052, 0.78, STONE_LIGHT, vertices=8)


def add_trial_portal(name, location, glow, crystal, plant_color):
    x, y = location
    # Raised dais plus a bright vertical liquid-light opening.
    cylinder(f"{name} portal dais", (x, y, 0.47), 1.62, 0.34, STONE, vertices=24, bevel_amount=0.09)
    cylinder(f"{name} portal inner", (x, y + 0.025, 2.08), 1.18, 0.09, glow, vertices=48, rotation=(math.pi / 2, 0.0, 0.0))
    torus(f"{name} neon portal ring", (x, y, 2.08), 1.28, 0.17, glow)
    torus(f"{name} outer portal ring", (x, y + 0.025, 2.08), 1.50, 0.06, GOLD)
    add_light(f"{name} portal light", (x, y - 0.8, 2.6), glow.diffuse_color[:3], 470, 3.0)

    for index in range(6):
        angle = index * math.tau / 6
        px = x + math.cos(angle) * 1.82
        py = y + math.sin(angle) * 1.82
        add_ruin_pillar(px, py, 0.52 + (index % 2) * 0.30)
    add_crystal_cluster(x - 1.65, y + 0.5, crystal, size=0.95)
    add_crystal_cluster(x + 1.64, y - 0.45, crystal, size=0.82)
    add_flower_patch(x + 0.15, y - 2.05, count=10, spread=0.72, colors=(plant_color, FLOWER_YELLOW, plant_color))


def add_main_portal():
    # A large sealed gate, slightly front-facing, is the visual center of the map.
    x, y = 0.0, -0.95
    cylinder("Main portal round plaza", (x, y, 0.50), 3.05, 0.34, STONE, vertices=48, bevel_amount=0.10)
    cylinder("Main portal inner locked void", (x, y + 0.04, 3.72), 2.13, 0.10, MAIN_GLOW, vertices=64, rotation=(math.pi / 2, 0.0, 0.0))
    torus("Main boss portal gold rim", (x, y, 3.72), 2.32, 0.25, GOLD)
    torus("Main boss portal locked halo", (x, y - 0.06, 3.72), 2.58, 0.07, MAIN_GLOW)

    # Three distinct lock stones explicitly signal three prerequisite portals.
    lock_positions = [(-1.48, 4.75, EMBER), (0.0, 2.52, TIDE), (1.48, 4.75, BLOOM)]
    for index, (lx, lz, glow) in enumerate(lock_positions):
        sphere(f"Trial lock gem {index}", (lx, y - 0.28, lz), (0.34, 0.12, 0.34), glow, subdivisions=2)
        torus(f"Trial lock ring {index}", (lx, y - 0.18, lz), 0.43, 0.07, DARK_METAL)

    # Dark crossing bands are deliberately easy to read at menu-card scale.
    cylinder_between("Gate seal bar diagonal a", (-1.92, y - 0.16, 2.42), (1.92, y - 0.16, 5.00), 0.11, DARK_METAL, vertices=8)
    cylinder_between("Gate seal bar diagonal b", (-1.92, y - 0.18, 5.00), (1.92, y - 0.18, 2.42), 0.11, DARK_METAL, vertices=8)
    cylinder_between("Gate seal bar horizontal", (-2.06, y - 0.20, 3.72), (2.06, y - 0.20, 3.72), 0.12, DARK_METAL, vertices=8)
    add_light("Main gate purple light", (0.0, -2.4, 4.4), (0.67, 0.13, 1.0), 830, 4.5)

    for index in range(11):
        angle = index * math.tau / 11 + 0.22
        radius = 3.58
        px = math.cos(angle) * radius
        py = y + math.sin(angle) * radius
        add_ruin_pillar(px, py, 0.38 + (index % 3) * 0.18)
    add_crystal_cluster(-3.1, 1.25, CRYSTAL_BLUE, size=0.75, count=5)
    add_crystal_cluster(3.1, 1.30, CRYSTAL_PINK, size=0.75, count=5)


def add_path(center, endpoint, count, accent):
    c = Vector(center)
    e = Vector(endpoint)
    for index in range(1, count + 1):
        point = c.lerp(e, index / (count + 1))
        stone = cylinder(
            "Round rune path stone",
            (point.x, point.y, 0.48),
            0.33 + (index % 2) * 0.04,
            0.12,
            STONE_LIGHT if index % 2 else STONE,
            vertices=10,
            bevel_amount=0.035,
        )
        if index % 3 == 0:
            torus("Path rune", (point.x, point.y, 0.56), 0.17, 0.035, accent, rotation=(0.0, 0.0, 0.0))


def add_cloud_bank(center, scale=1.0, count=5):
    cx, cy, cz = center
    for index in range(count):
        angle = index * math.tau / count
        distance = scale * (0.38 + (index % 3) * 0.18)
        material = CLOUD_LIGHT if index % 2 else CLOUD
        sphere(
            "Puffy cloud",
            (cx + math.cos(angle) * distance, cy + math.sin(angle) * distance, cz + (index % 2) * 0.18),
            (scale * (0.55 + (index % 2) * 0.14), scale * 0.40, scale * 0.28),
            material,
            subdivisions=2,
        )


def setup_scene():
    scene = bpy.context.scene
    # Blender 5 continues to expose Eevee under the stable BLENDER_EEVEE enum.
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.resolution_percentage = 100
    scene.render.image_settings.color_depth = "8"
    scene.render.filepath = str(OUTPUT)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.image_settings.compression = 15
    try:
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_percentage = 100
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.film_transparent = False
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass

    world = bpy.data.worlds.new("Kaki Land Sky") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (*SKY, 1.0)
    background.inputs["Strength"].default_value = 0.42

    # Orthographic isometric composition makes all four islands readable at once.
    camera_data = bpy.data.cameras.new("Kaki Land key art camera")
    camera_data.type = "ORTHO"
    # Give all three trial islands breathing room; this is a menu image, so it
    # must read as a four-island hub even in a narrow card crop.
    camera_data.ortho_scale = 36.5
    camera = bpy.data.objects.new("Kaki Land key art camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (18.5, -25.0, 21.5)
    look_at(camera, (0.0, 0.0, -0.4))
    scene.camera = camera

    sun_data = bpy.data.lights.new("Warm sun", type="SUN")
    sun_data.energy = 3.0
    sun_data.color = (1.0, 0.72, 0.52)
    sun = bpy.data.objects.new("Warm sun", sun_data)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(28), math.radians(-24), math.radians(-28))
    add_light("Cool fill", (-7.0, -8.0, 16.0), (0.20, 0.63, 1.0), 1400, 11.0)
    add_light("Peach rim", (12.0, 9.0, 14.0), (1.0, 0.30, 0.20), 1100, 10.0)


def build_kaki_land():
    # The hub is intentionally large and front-and-center; the upper island is in back,
    # so the player immediately reads a three-way path radiating from the sealed main gate.
    hub = (0.0, 0.0)
    ember_island = (-9.7, -6.0)
    tide_island = (10.3, -5.7)
    bloom_island = (0.0, 10.0)
    make_island("Central hub", *hub, 6.7, height=4.7)
    make_island("Ember trial island", *ember_island, 3.65, height=3.45)
    make_island("Tide trial island", *tide_island, 3.65, height=3.45)
    make_island("Bloom trial island", *bloom_island, 3.65, height=3.45)

    # Bridges terminate before portal plazas so every portal remains an isolated destination.
    add_bridge((-4.72, -2.90, 0.0), (-7.05, -4.38, 0.0), "Ember route", EMBER)
    add_bridge((4.72, -2.78, 0.0), (7.55, -4.20, 0.0), "Tide route", TIDE)
    add_bridge((0.0, 5.45, 0.0), (0.0, 6.95, 0.0), "Bloom route", BLOOM)

    add_main_portal()
    add_trial_portal("Ember", ember_island, EMBER, CRYSTAL_ORANGE, FLOWER_YELLOW)
    add_trial_portal("Tide", tide_island, TIDE, CRYSTAL_BLUE, FLOWER_BLUE)
    add_trial_portal("Bloom", bloom_island, BLOOM, CRYSTAL_PINK, FLOWER_PINK)

    # Hub paths, foliage, and landmark trees make the land feel like a place rather than a board.
    add_path((0.0, 1.6, 0.0), (-5.1, -3.0, 0.0), 7, EMBER)
    add_path((0.0, 1.6, 0.0), (5.1, -3.0, 0.0), 7, TIDE)
    add_path((0.0, 1.9, 0.0), (0.0, 5.5, 0.0), 6, BLOOM)
    for x, y, scale in [(-4.9, 2.5, 0.92), (4.7, 2.9, 1.02), (-4.6, -0.3, 0.66), (4.8, -0.1, 0.74)]:
        add_tree(x, y, scale)
    for x, y in [(-4.5, 3.9), (-3.7, 4.6), (4.4, 4.3), (3.65, 3.7), (-5.2, -2.5), (5.0, -2.6)]:
        add_flower_patch(x, y, count=7, spread=0.58)

    # Themed satellite scenery fills in the map without hiding their portal objectives.
    for x, y, scale in [(-11.9, -4.15, 0.58), (-8.0, -8.22, 0.63), (8.1, -8.0, 0.66), (12.8, -4.2, 0.58), (-2.4, 11.7, 0.61), (2.25, 11.65, 0.64)]:
        add_tree(x, y, scale)
    add_flower_patch(-10.8, -8.25, count=13, spread=0.88, colors=(FLOWER_YELLOW, FLOWER_PINK))
    add_flower_patch(10.9, -8.0, count=13, spread=0.90, colors=(FLOWER_BLUE, FLOWER_YELLOW))
    add_flower_patch(0.2, 7.55, count=13, spread=0.92, colors=(FLOWER_PINK, FLOWER_BLUE))

    # Atmospheric clouds: below rocks and around the outside, not in front of objectives.
    add_cloud_bank((-10.0, -8.0, -2.75), 2.1, 7)
    add_cloud_bank((10.4, -8.4, -2.85), 2.2, 7)
    add_cloud_bank((0.0, 10.6, -2.75), 2.3, 7)
    add_cloud_bank((0.0, 0.0, -4.0), 3.0, 9)
    for position, scale in [((-15.5, 7.0, 4.0), 1.25), ((16.0, 8.4, 3.6), 1.42), ((-15.0, -13.0, 4.1), 1.15), ((15.5, -12.0, 4.0), 1.18)]:
        add_cloud_bank(position, scale, 5)


setup_scene()
build_kaki_land()
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.context.scene.render.filepath = str(OUTPUT)
bpy.ops.render.render(write_still=True)
print(f"Kaki Land render saved to {OUTPUT}")
