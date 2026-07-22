# Sprite atlas visual contract

The sprite renderer is a fixed-capacity `InstancedMesh` system. It is used for
dense ordinary-enemy hordes and small FX; it must not grow one Object3D,
material, mixer, or shadow caster per rendered sprite.

V1 descriptors remain supported for intentional pixel-art FX and non-Forest
enemy fallback. Their legacy default is nearest filtering without mipmaps.

V2 `enemy-atlas` descriptors use numeric species, state, and direction IDs in
the runtime. They declare one or two texture pages, per-state ranges/FPS/loop
completion, mirroring, padding, filtering, mipmaps, and an explicit fallback
state. Rendered 3D sprites use linear magnification, trilinear minification,
safe gutters, depth writes, and an authored alpha cutoff; these settings are
atlas-local and never mutate FX textures.

Forest v2 owns 512 shared slots and one draw submission. Movement, facing,
state, flip, hit pose, and death completion mutate typed per-slot arrays in
place. Spawned loops use deterministic phase variation, movement controls
playback rate, stationary sprites retain facing, attack falls back to move, and
death releases its slot. Teardown/room retirement releases immediately.

The source audit, reproducible Blender authoring, supersampled bake, silhouette
validation, and generated evidence live under `tools/enemy-sprite-bake/` and
`docs/enemy-animation/`.
