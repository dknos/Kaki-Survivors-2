"""Author deterministic, non-destructive Forest enemy deformation assets.

Run with the repository wrapper (Windows Blender is supported from WSL):

    blender -b --python tools/enemy-sprite-bake/author_forest_animation.py

The original assets/breakroom GLBs are read-only. Eight fused static models
receive named morph-pose libraries; Bee keeps its three rigid components and
gets stable semantic node names. Wasp is intentionally not re-exported because
its source GLB already contains usable Flying, Attack, and Death clips.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy


SCRIPT = Path(__file__).resolve()
ROOT = SCRIPT.parents[2]
SOURCE_DIR = ROOT / "assets" / "breakroom"
OUTPUT_DIR = ROOT / "assets" / "source" / "enemy-animation" / "forest-v2"

FUSED_SPECIES = (
    "ant", "beetle", "ladybug", "grasshopper", "cockroach",
    "mantis", "butterfly", "caterpillar",
)
SOURCE_NAMES = {
    "ant": "Ant.glb",
    "beetle": "Beetle.glb",
    "ladybug": "Ladybug.glb",
    "grasshopper": "Grasshopper.glb",
    "cockroach": "Cockroach.glb",
    "mantis": "Mantis.glb",
    "bee": "Bee.glb",
    "butterfly": "Butterfly.glb",
    "caterpillar": "Caterpillar.glb",
}

# Local Blender coordinates after glTF's Y-up -> Blender Z-up conversion.
# Most source models face along glTF Z (local Blender Y). The three historical
# faceYaw=-PI/2 models face along glTF X (local Blender X).
FORWARD_AXIS = {
    "grasshopper": 0,
    "bee": 0,
}


def argv_species() -> set[str] | None:
    if "--" not in sys.argv:
        return None
    args = sys.argv[sys.argv.index("--") + 1 :]
    if not args:
        return None
    selected: set[str] = set()
    for value in args:
        selected.update(part.strip().lower() for part in value.split(",") if part.strip())
    unknown = selected.difference((*FUSED_SPECIES, "bee"))
    if unknown:
        raise ValueError(f"Unknown species: {', '.join(sorted(unknown))}")
    return selected


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(source: Path) -> list[bpy.types.Object]:
    before = set(bpy.data.objects)
    result = bpy.ops.import_scene.gltf(filepath=str(source))
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender failed to import {source}")
    return [obj for obj in bpy.data.objects if obj not in before]


def mesh_objects(objects: list[bpy.types.Object]) -> list[bpy.types.Object]:
    return sorted((obj for obj in objects if obj.type == "MESH"), key=lambda obj: obj.name)


def axis_metrics(obj: bpy.types.Object, species: str) -> dict[str, float | int]:
    if not obj.data.vertices:
        raise RuntimeError(f"{species}: imported mesh has no vertices")
    forward_axis = FORWARD_AXIS.get(species, 1)
    side_axis = 1 if forward_axis == 0 else 0
    coords = [vertex.co.copy() for vertex in obj.data.vertices]
    values = [[co[index] for co in coords] for index in range(3)]
    mins = [min(axis) for axis in values]
    maxs = [max(axis) for axis in values]
    return {
        "forwardAxis": forward_axis,
        "sideAxis": side_axis,
        "forwardCenter": (mins[forward_axis] + maxs[forward_axis]) * 0.5,
        "sideCenter": (mins[side_axis] + maxs[side_axis]) * 0.5,
        "ground": mins[2],
        "forwardSize": max(maxs[forward_axis] - mins[forward_axis], 1e-6),
        "sideSize": max(maxs[side_axis] - mins[side_axis], 1e-6),
        "height": max(maxs[2] - mins[2], 1e-6),
    }


def smooth_positive(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def deform_point(species: str, state: str, frame: int, co, metrics):
    out = co.copy()
    forward_axis = int(metrics["forwardAxis"])
    side_axis = int(metrics["sideAxis"])
    fc = float(metrics["forwardCenter"])
    sc = float(metrics["sideCenter"])
    ground = float(metrics["ground"])
    length = float(metrics["forwardSize"])
    width = float(metrics["sideSize"])
    height = float(metrics["height"])

    forward = out[forward_axis]
    side = out[side_axis]
    vertical = out[2]
    u = max(-1.0, min(1.0, (forward - fc) * 2.0 / length))
    v = max(-1.0, min(1.0, (side - sc) * 2.0 / width))
    h = max(0.0, min(1.0, (vertical - ground) / height))

    if state == "move":
        theta = frame * math.tau / 6.0
        stride = math.sin(theta)
        alternate = math.sin(theta + u * math.pi * 1.15)

        if species == "ant":
            forward = fc + (forward - fc) * (1.0 + 0.045 * math.cos(theta) * u)
            forward += length * (0.018 * alternate + 0.012 * stride * h)
            side += width * (0.085 * alternate * (0.35 + 0.65 * (1.0 - h)) + 0.025 * stride * u)
            vertical += height * 0.025 * (1.0 - math.cos(theta * 2.0)) * h
        elif species == "beetle":
            planted = math.sin(theta * 0.5)
            forward = fc + (forward - fc) * (1.0 + 0.025 * math.cos(theta))
            side += width * (0.035 * planted * (0.3 + h) + 0.018 * alternate * (1.0 - h))
            vertical = ground + (vertical - ground) * (0.96 + 0.045 * abs(math.cos(theta)))
            vertical += height * 0.015 * abs(stride) * h
        elif species == "ladybug":
            shell = 0.5 + 0.5 * math.sin(theta)
            side = sc + (side - sc) * (0.97 + 0.055 * shell * h)
            forward = fc + (forward - fc) * (1.025 - 0.05 * shell)
            vertical = ground + (vertical - ground) * (0.95 + 0.075 * shell)
            side += width * 0.025 * alternate * (1.0 - h)
        elif species == "grasshopper":
            lift = (0.0, -0.08, 0.32, 0.62, 0.28, -0.10)[frame]
            extension = (-0.10, -0.18, 0.22, 0.34, 0.12, -0.16)[frame]
            forward = fc + (forward - fc) * (1.0 + extension * (0.35 + 0.65 * abs(u)))
            # Hind section extends opposite the head during takeoff.
            forward += length * extension * 0.08 * smooth_positive((-u + 1.0) * 0.5)
            vertical = ground + (vertical - ground) * (1.0 - 0.18 * min(0.0, lift))
            vertical += height * (lift + 0.06 * u * extension) * (0.2 + 0.8 * h)
            side += width * 0.025 * stride * (1.0 - h)
        elif species == "cockroach":
            head = smooth_positive((u + 1.0) * 0.5)
            side += width * (0.055 * alternate * (0.25 + 0.75 * (1.0 - h)) + 0.10 * stride * head * head)
            forward += length * 0.018 * math.cos(theta + u * math.pi)
            vertical += height * 0.008 * abs(stride) * h
        elif species == "mantis":
            fore = smooth_positive((u + 0.1) / 1.1)
            rear = smooth_positive((-u + 0.25) / 1.25)
            side += width * (0.12 * alternate * fore + 0.035 * stride * rear)
            forward += length * (0.035 * math.cos(theta) * fore - 0.012 * stride * rear)
            vertical += height * (0.07 * abs(stride) * fore - 0.025 * math.cos(theta) * rear) * h
        elif species == "butterfly":
            # Broad open/closed silhouettes; not whole-object scaling. Wing
            # vertices fold toward the body and rise in a shallow V.
            openness = (1.0, 0.58, 0.16, 0.48, 0.94, 0.68)[frame]
            fold = math.sin((1.0 - openness) * math.pi * 0.48)
            side = sc + (side - sc) * openness
            vertical += abs(v) * width * 0.42 * fold * (0.3 + 0.7 * h)
            forward += length * 0.025 * math.sin(theta + abs(v) * math.pi)
        elif species == "caterpillar":
            wave = math.sin(u * math.pi * 2.2 - theta)
            contraction = math.cos(theta) * 0.06
            forward = fc + (forward - fc) * (1.0 - contraction)
            forward += length * 0.035 * math.sin(u * math.pi - theta) * h
            vertical += height * 0.16 * wave * (0.12 + 0.88 * h)
            side += width * 0.035 * math.sin(u * math.pi * 2.0 - theta) * h

    elif state == "attack":
        progress = frame / 2.0
        snap = (0.0, 1.0, 0.35)[frame]
        fore = smooth_positive((u + 0.1) / 1.1)
        if species == "mantis":
            side += width * 0.58 * snap * fore * (0.2 + 0.8 * h)
            forward += length * 0.22 * snap * fore
            vertical += height * 0.16 * snap * fore
        elif species == "grasshopper":
            forward += length * 0.28 * snap * (0.25 + 0.75 * abs(u))
            vertical = ground + (vertical - ground) * (1.0 + 0.22 * snap)
            side += width * 0.12 * snap * u
        elif species == "butterfly":
            openness = (0.85, 0.08, 1.0)[frame]
            side = sc + (side - sc) * openness
            vertical += abs(v) * width * (1.0 - openness) * 0.5 * (0.25 + h)
        elif species == "caterpillar":
            forward = fc + (forward - fc) * (1.0 + 0.16 * snap)
            vertical += height * 0.22 * snap * fore * h
            side += width * 0.10 * snap * math.sin(u * math.pi)
        elif species == "cockroach":
            side += width * 0.28 * snap * fore * fore
            forward += length * 0.16 * snap * fore
            vertical += height * 0.035 * snap * h
        elif species == "ant":
            forward += length * 0.22 * snap * fore
            side += width * 0.15 * snap * math.sin(u * math.pi) * (0.3 + h)
            vertical = ground + (vertical - ground) * (1.0 - 0.08 * snap)
        elif species == "ladybug":
            side = sc + (side - sc) * (1.0 + 0.26 * snap * h)
            vertical += height * 0.15 * snap * h
            forward = fc + (forward - fc) * (1.0 - 0.08 * snap)
        elif species == "beetle":
            forward = fc + (forward - fc) * (1.0 + 0.20 * snap)
            vertical = ground + (vertical - ground) * (1.0 - 0.16 * snap)
            side += width * 0.08 * snap * u * h

    elif state == "death":
        progress = frame / 2.0
        ripple = math.sin(u * math.pi * 1.5 + progress * math.pi)
        vertical = ground + (vertical - ground) * (1.0 - 0.72 * progress)
        side = sc + (side - sc) * (1.0 + 0.34 * progress)
        forward = fc + (forward - fc) * (1.0 - 0.12 * progress)
        side += width * 0.18 * progress * ripple * (0.25 + 0.75 * h)
        vertical += height * 0.08 * math.sin(progress * math.pi) * (1.0 - abs(u))
        if species in {"bee", "butterfly"}:
            side = sc + (side - sc) * (1.0 + 0.45 * progress)
        if species == "caterpillar":
            vertical += height * 0.10 * progress * math.sin(u * math.pi * 3.0) * h

    out[forward_axis] = forward
    out[side_axis] = side
    out[2] = vertical
    return out


def add_pose_library(obj: bpy.types.Object, species: str) -> list[str]:
    # Shape keys keep the source topology/materials intact and let the browser
    # baker select exact strong poses without root-transform fakery.
    obj.shape_key_add(name="Basis", from_mix=False)
    metrics = axis_metrics(obj, species)
    source_coords = [vertex.co.copy() for vertex in obj.data.vertices]
    names: list[str] = []
    for state, count in (("move", 6), ("attack", 3), ("death", 3)):
        for frame in range(count):
            name = f"{state}_{frame}"
            key = obj.shape_key_add(name=name, from_mix=False)
            for index, source in enumerate(source_coords):
                key.data[index].co = deform_point(species, state, frame, source, metrics)
            key.value = 0.0
            names.append(name)
    obj.data.shape_keys.name = f"{species}_forest_v2_pose_library"
    obj["kkAnimationAuthoring"] = "species-specific morph pose library"
    obj["kkSpecies"] = species
    obj["kkSource"] = f"assets/breakroom/{SOURCE_NAMES[species]}"
    obj["kkMovePoseCount"] = 6
    obj["kkAttackPoseCount"] = 3
    obj["kkDeathPoseCount"] = 3
    return names


def export_glb(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(target),
        export_format="GLB",
        export_animations=False,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_materials="EXPORT",
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_draco_mesh_compression_enable=False,
        check_existing=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender failed to export {target}")


def author_fused(species: str) -> dict:
    reset_scene()
    source = SOURCE_DIR / SOURCE_NAMES[species]
    objects = import_glb(source)
    meshes = mesh_objects(objects)
    if len(meshes) != 1:
        raise RuntimeError(f"{species}: expected one fused mesh, found {len(meshes)}")
    poses = add_pose_library(meshes[0], species)
    target = OUTPUT_DIR / f"{species}-authored.glb"
    export_glb(target)
    return {
        "species": species,
        "source": str(source.relative_to(ROOT)).replace("\\", "/"),
        "output": str(target.relative_to(ROOT)).replace("\\", "/"),
        "authoringPath": "non-destructive-morph-pose-library",
        "poses": poses,
    }


def author_bee() -> dict:
    reset_scene()
    source = SOURCE_DIR / SOURCE_NAMES["bee"]
    objects = import_glb(source)
    meshes = mesh_objects(objects)
    if len(meshes) != 3:
        raise RuntimeError(f"bee: expected three rigid mesh nodes, found {len(meshes)}")
    # The source has one tiny, translucent 64-triangle wing plane and two much
    # denser opaque body groups. Vertex count is stable across Blender versions,
    # unlike the renamed alpha surface modes in Blender 4.x/5.x.
    wing = min(meshes, key=lambda obj: len(obj.data.vertices))
    bodies = [obj for obj in meshes if obj is not wing]
    wing.name = "Bee_Wings"
    wing.data.name = "Bee_Wings_Mesh"
    wing["kkRigidRole"] = "wings"
    for index, obj in enumerate(sorted(bodies, key=lambda item: len(item.data.vertices), reverse=True)):
        obj.name = f"Bee_Body_{index}"
        obj.data.name = f"Bee_Body_Mesh_{index}"
        obj["kkRigidRole"] = "body"
    for obj in meshes:
        obj["kkAnimationAuthoring"] = "baker-driven rigid component motion"
        obj["kkSpecies"] = "bee"
        obj["kkSource"] = "assets/breakroom/Bee.glb"
    target = OUTPUT_DIR / "bee-authored.glb"
    export_glb(target)
    return {
        "species": "bee",
        "source": str(source.relative_to(ROOT)).replace("\\", "/"),
        "output": str(target.relative_to(ROOT)).replace("\\", "/"),
        "authoringPath": "rigid-component-animation-in-baker",
        "components": [obj.name for obj in meshes],
    }


def main() -> None:
    selected = argv_species()
    records = []
    for species in FUSED_SPECIES:
        if selected is None or species in selected:
            print(f"[forest-author] {species}")
            records.append(author_fused(species))
    if selected is None or "bee" in selected:
        print("[forest-author] bee")
        records.append(author_bee())
    existing_records = []
    manifest_path = OUTPUT_DIR / "AUTHORING_MANIFEST.json"
    if selected is not None and manifest_path.exists():
        try:
            existing_records = json.loads(manifest_path.read_text(encoding="utf-8")).get("assets", [])
        except (OSError, ValueError):
            existing_records = []
    merged = {record.get("species"): record for record in existing_records if record.get("species")}
    merged.update({record["species"]: record for record in records})
    order = (*FUSED_SPECIES, "bee")
    manifest = {
        "schemaVersion": 1,
        "generatedBy": "tools/enemy-sprite-bake/author_forest_animation.py",
        "blenderVersion": bpy.app.version_string,
        "originalAssetsModified": False,
        "wasp": {
            "source": "assets/breakroom/Wasp.glb",
            "authoringPath": "sample-source-clips",
            "clips": ["WaspArmature|Wasp_Flying", "WaspArmature|Wasp_Attack", "WaspArmature|Wasp_Death"],
        },
        "assets": [merged[species] for species in order if species in merged],
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=False)
        handle.write("\n")
    print(f"[forest-author] wrote {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
