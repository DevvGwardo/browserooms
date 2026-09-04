"""Bake a looping quadruped walk cycle via headless Blender.

Usage (Blender 4.5 LTS) — naked NUB rig:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/bake-walk.py -- \
    public/models/nakedNUB.glb public/models/nakedNUB-walk.glb

Strategy: keyframe pose.bones per frame (24 frames @ 24fps = 1s loop) with a
lateral-sequence walk (legs oppose at half-cycle phase), foot follow-through,
hip bob/roll, and head counter-bob; then export with baked animation.

Frame phase (lateral sequence walk, 25/50/75% offsets):
  Leg_L / Foot_L : phase 0.0
  Leg_R / Foot_R : phase 0.5
  hip bob        : 2x frequency, dip when a foot lands
  hip roll       : 1x, lean toward the planted foot
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
    need = ["Leg_L", "Leg_R", "Foot_L", "Foot_R", "Root_hip", "Head"]
    missing = [n for n in need if n not in bones]
    if missing:
        print(f"BAKE-FAIL: missing bones {missing}")
        sys.exit(1)

    base = {n: bones[n].rotation_quaternion.copy() for n in need}
    base_loc = {n: bones[n].location.copy() for n in need}

    FPS = 24
    FRAMES = 24  # 1s loop
    SWING = 0.5  # thigh swing amplitude (rad)
    FOOT = 0.35  # foot follow-through (lags the thigh)
    # The FBX bind pose rests the belly on the ground (belly verts at y~0,
    # held by Leg/Foot joints). A standing cat needs the hip line ~0.55m up:
    # bake a static lift into Root_hip so the loop stands on its feet.
    LIFT = 0.42
    BOB = 0.035  # hip bob (Blender units: rig is ~1.2m tall, meters-ish)
    ROLL = 0.06
    HEAD = 0.08

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
        foot_l = math.sin((t - 0.1) * 2 * math.pi) * FOOT
        foot_r = math.sin((t + 0.5 - 0.1) * 2 * math.pi) * FOOT
        bob = -abs(math.sin(t * 2 * math.pi * 2)) * BOB
        roll = math.sin(t * 2 * math.pi) * ROLL
        head_bob = abs(math.sin(t * 2 * math.pi * 2)) * HEAD
        head_yaw = math.sin(t * 2 * math.pi) * HEAD * 0.6

        # Legs swing about local X (fore-aft) as pre-multiplied world-axis
        # rotations: q = swing * base, so both legs move in the same world
        # plane with opposite phase (post-multiplying would inherit each
        # leg's mirrored bind quat and cancel the phase offset).
        swing_axis = mathutils.Vector((1, 0, 0))
        bones["Leg_L"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, swing_l) @ base["Leg_L"]
        )
        bones["Leg_R"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, swing_r) @ base["Leg_R"]
        )
        bones["Foot_L"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, foot_l) @ base["Foot_L"]
        )
        bones["Foot_R"].rotation_quaternion = (
            mathutils.Quaternion(swing_axis, foot_r) @ base["Foot_R"]
        )
        # Hips: lift+bob on Y (armature is Y-up inside Blender after the
        # fbx-to-glb transform bake; Z is forward, not up).
        bones["Root_hip"].location = (
            base_loc["Root_hip"][0],
            base_loc["Root_hip"][1] + LIFT + bob,
            base_loc["Root_hip"][2],
        )
        bones["Head"].rotation_quaternion = (
            mathutils.Quaternion(mathutils.Vector((0, 1, 0)), head_bob)
            @ mathutils.Quaternion(mathutils.Vector((0, 0, 1)), head_yaw)
            @ base["Head"]
        )

        for n in need:
            bones[n].keyframe_insert(data_path="rotation_quaternion", frame=f)
        bones["Root_hip"].keyframe_insert(data_path="location", frame=f)

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
