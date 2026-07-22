"""Headless fallback exporter for the Forest moonroot crystal GLB.

The canonical Blender construction lives in generate-forest-crystal-kit.py.
This equivalent exporter is useful when Windows Blender interop is unavailable
inside WSL.  It emits the same two-mesh runtime contract with trimesh.
"""

from pathlib import Path
import math

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "kits" / "forest" / "moonroot_crystal_cluster.glb"


def ico(location, dimensions, subdivisions=1):
    mesh = trimesh.creation.icosphere(subdivisions=subdivisions, radius=0.5)
    mesh.apply_scale(np.asarray(dimensions, dtype=float))
    mesh.apply_translation(np.asarray(location, dtype=float))
    return mesh


def cylinder_between(a, b, radius, sections=6):
    av = np.asarray(a, dtype=float)
    bv = np.asarray(b, dtype=float)
    delta = bv - av
    height = float(np.linalg.norm(delta))
    mesh = trimesh.creation.cylinder(radius=radius, height=height, sections=sections)
    transform = trimesh.geometry.align_vectors([0.0, 0.0, 1.0], delta / height)
    transform[:3, 3] = (av + bv) * 0.5
    mesh.apply_transform(transform)
    return mesh


def crystal(base, height, radius, lean, sides=6, twist=0.0):
    base_v = np.asarray(base, dtype=float)
    tip_v = base_v + np.asarray((lean[0], height, lean[1]), dtype=float)
    axis = tip_v - base_v
    axis /= np.linalg.norm(axis)
    helper = np.asarray((0.0, 1.0, 0.0), dtype=float)
    if abs(float(np.dot(axis, helper))) > 0.94:
        helper = np.asarray((1.0, 0.0, 0.0), dtype=float)
    u = np.cross(axis, helper)
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    v /= np.linalg.norm(v)
    shoulder = base_v + (tip_v - base_v) * 0.72

    verts = []
    for center, ring_radius, ring_twist in (
        (base_v, radius, twist),
        (shoulder, radius * 0.78, twist + 0.18),
    ):
        for i in range(sides):
            angle = ring_twist + (i / sides) * math.tau
            rr = ring_radius * (0.92 if i % 2 else 1.06)
            verts.append(center + u * math.cos(angle) * rr + v * math.sin(angle) * rr)
    tip_index = len(verts)
    verts.append(tip_v)
    base_center_index = len(verts)
    verts.append(base_v)

    faces = []
    for i in range(sides):
        n = (i + 1) % sides
        a, b = i, n
        c, d = sides + n, sides + i
        if i % 2:
            faces.extend(((a, b, d), (b, c, d)))
        else:
            faces.extend(((a, b, c), (a, c, d)))
        faces.append((d, c, tip_index))
        faces.append((base_center_index, b, a))

    return trimesh.Trimesh(
        vertices=np.asarray(verts),
        faces=np.asarray(faces),
        process=True,
        validate=True,
    )


def build():
    base_parts = [
        # trimesh subdivision N is one level denser than Blender's ico N;
        # these values match the canonical Blender kit's low-poly budget.
        ico((0.0, 0.17, 0.0), (1.50, 0.42, 1.18), 1),
        ico((-0.55, 0.27, 0.04), (0.54, 0.40, 0.56), 0),
        ico((0.52, 0.25, 0.08), (0.50, 0.36, 0.52), 0),
        ico((0.03, 0.25, 0.40), (0.62, 0.34, 0.46), 0),
    ]
    root_paths = (
        ((-0.16, 0.25, -0.10), (-0.70, 0.16, -0.33), (-0.92, 0.08, -0.12)),
        ((0.18, 0.24, -0.05), (0.64, 0.15, -0.42), (0.91, 0.07, -0.28)),
        ((-0.28, 0.23, 0.12), (-0.58, 0.14, 0.52), (-0.35, 0.06, 0.72)),
        ((0.30, 0.23, 0.10), (0.62, 0.14, 0.44), (0.50, 0.06, 0.69)),
    )
    for path in root_paths:
        for i in range(len(path) - 1):
            base_parts.append(cylinder_between(path[i], path[i + 1], 0.085 - i * 0.018, 5))

    crown_parts = [
        crystal((0.00, 0.31, 0.02), 1.35, 0.27, (0.06, -0.04), 7, 0.12),
        crystal((-0.45, 0.28, 0.02), 0.95, 0.20, (-0.22, 0.05), 6, 0.05),
        crystal((0.45, 0.28, 0.04), 1.04, 0.21, (0.23, 0.04), 6, 0.20),
        crystal((-0.22, 0.29, 0.34), 0.78, 0.15, (-0.10, 0.18), 6, 0.30),
        crystal((0.21, 0.29, 0.36), 0.72, 0.145, (0.10, 0.17), 6, 0.42),
        crystal((-0.73, 0.16, -0.18), 0.34, 0.10, (-0.14, -0.04), 5, 0.10),
        crystal((0.68, 0.16, 0.27), 0.30, 0.09, (0.12, 0.08), 5, 0.36),
        ico((0.0, 0.46, -0.40), (0.66, 0.42, 0.48), 0),
    ]

    base = trimesh.util.concatenate(base_parts)
    base.remove_unreferenced_vertices()
    base.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
        name="Moonroot Stone",
        baseColorFactor=[0.16, 0.22, 0.16, 1.0],
        emissiveFactor=[0.015, 0.025, 0.015],
        metallicFactor=0.0,
        roughnessFactor=0.88,
    ))
    base.metadata.update({
        "assetRole": "base",
        "gameplayPurpose": "forest chokepoint landmark",
    })

    crown = trimesh.util.concatenate(crown_parts)
    crown.remove_unreferenced_vertices()
    crown.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
        name="Moonpetal Crystal",
        baseColorFactor=[0.32, 0.84, 0.76, 1.0],
        emissiveFactor=[0.18, 0.92, 0.78],
        metallicFactor=0.06,
        roughnessFactor=0.24,
    ))
    crown.metadata.update({
        "assetRole": "crystal",
        "gameplayPurpose": "readable moonroot crystal crown",
    })
    return base, crown


def main():
    base, crown = build()
    scene = trimesh.Scene()
    scene.add_geometry(base, geom_name="Moonroot_Base", node_name="Moonroot_Base")
    scene.add_geometry(crown, geom_name="Moonroot_Crystals", node_name="Moonroot_Crystals")
    scene.metadata.update({
        "asset": "moonroot_crystal_cluster",
        "sourceConcept": "assets/source/grok/forest_moonroot_crystal_concept.jpg",
    })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(scene.export(file_type="glb", include_normals=True))
    print(f"exported {OUT}")
    print(f"base triangles={len(base.faces)} crown triangles={len(crown.faces)} total={len(base.faces) + len(crown.faces)}")


if __name__ == "__main__":
    main()
