"""Bake a looping quadruped walk cycle into sillyNubCat via headless Blender.

Usage (Blender 4.5 LTS):
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/bake-walk.py -- \
    public/models/sillyNubCat.glb public/models/sillyNubCat-walk.glb

Strategy: the source rig is a flat fan (body_00 carries legs, paws, head as
siblings), so a walk reads through leg/paw swing + body bob/roll + head
counter-bob. The script poses `pose.bones` per frame (24 frames @ 24fps = 1s
loop), inserts LOCROT keyframes, then exports with baked animation.

Frame phase (lateral sequence walk, 25/50/75% offsets):
  leg.L / paw.L  : phase 0.0
  leg.R / paw.R  : phase 0.5
  body bob       : 2x frequency, dip when a foot lands
  body roll      : 1x, lean toward the planted foot
  head           : counter-bob + slight yaw sway
"""

import math
import sys

import bpy


def argv():
    args = sys.argv
    if "--" in args:
        return args[args.index("--") + 1 :]
    return []


def main():
    args = argv()
    if len(args) != 2:
        print("usage: bake-walk.py <in.glb> <out.glb>")
        sys.exit(2)
    src, dst = args

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if arm is None:
        print("BAKE-FAIL: no armature after import")
        sys.exit(1)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)

    bones = arm.pose.bones
    need = ["leg.L_04", "leg.R_03", "paw.L_02", "paw.R_01", "body_00", "head_07"]
    missing = [n for n in need if n not in bones]
    if missing:
        print(f"BAKE-FAIL: missing bones {missing}")
        sys.exit(1)

    base = {n: bones[n].rotation_quaternion.copy() for n in need}

    FPS = 24
    FRAMES = 24  # 1s loop
    SWING = 0.55  # leg swing amplitude (rad)
    PAW = 0.35  # paw follow-through amplitude
    BOB = 0.06  # body bob (Blender units, pre-scale)
    ROLL = 0.07
    HEAD = 0.10

    scn = bpy.context.scene
    scn.render.fps = FPS
    scn.frame_start = 0
    scn.frame_end = FRAMES  # Blender duplicates frame 0 -> FRAMES on cyclic export

    import mathutils

    for f in range(FRAMES + 1):
        t = f / FRAMES  # 0..1 across the loop
        scn.frame_set(f)
        # Left leads by half a cycle over right.
        swing_l = math.sin(t * 2 * math.pi) * SWING
        swing_r = math.sin((t + 0.5) * 2 * math.pi) * SWING
        paw_l = math.sin((t - 0.12) * 2 * math.pi) * PAW
        paw_r = math.sin((t + 0.5 - 0.12) * 2 * math.pi) * PAW
        bob = -abs(math.sin(t * 2 * math.pi * 2)) * BOB
        roll = math.sin(t * 2 * math.pi) * ROLL
        head_bob = abs(math.sin(t * 2 * math.pi * 2)) * HEAD
        head_yaw = math.sin(t * 2 * math.pi) * HEAD * 0.6

        # Legs swing about local X (fore-aft) as pre-multiplied world-axis
        # rotations: q = swing * base, so both legs move in the same world
        # plane with opposite phase (post-multiplying would inherit each
        # leg's mirrored bind quat and cancel the phase offset).
        swing_axis = mathutils.Vector((1, 0, 0))
        bones["leg.L_04"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, swing_l) @ base["leg.L_04"]
        )
        bones["leg.R_03"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, swing_r) @ base["leg.R_03"]
        )
        bones["paw.L_02"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, paw_l) @ base["paw.L_02"]
        )
        bones["paw.R_01"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, paw_r) @ base["paw.R_01"]
        )
        # Body: bob on Z, roll about Y (rig is Y-up in Blender after import).
        bones["body_00"].rotation_quaternion = (
            mathutils.Quaternion(mathutils.Vector((0, 0, 1)), roll) @ base["body_00"]
        )
        bones["body_00"].location = (0, 0, bob)
        bones["head_07"].rotation_quaternion = (
            mathutils.Quaternion(mathutils.Vector((0, 1, 0)), head_bob)
            @ mathutils.Quaternion(mathutils.Vector((0, 0, 1)), head_yaw)
            @ base["head_07"]
        )

        for n in need:
            bones[n].keyframe_insert(data_path="rotation_quaternion", frame=f)
        bones["body_00"].keyframe_insert(data_path="location", frame=f)

    for n in need:
        # Linear interpolation reads as mechanical; BEZIER smooths the loop.
        for fc in arm.animation_data.action.fcurves:
            if fc.data_path in ("rotation_quaternion", "location"):
                for kp in fc.keyframe_points:
                    kp.interpolation = "BEZIER"

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_nla_strips=False,
        export_optimize_animation_size=False,
        export_force_sampling=True,
        export_frame_range=True,
    )
    print(f"BAKE-OK: {dst}")


main()
