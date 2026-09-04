"""Export a nub .blend rig to a game-ready GLB via headless Blender.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/export-pink.py -- \
    /Users/devgwardo/Downloads/pink_nub.blend public/models/pinkNUB.glb
    [armature body eyes]

Defaults suit pink_nub.blend (Nub_rigs.001, Nub_body.001, Nub_eyes.001).
For naked_NUB.blend pass: Nub_rigs Nub_body Nub_eyes.

Steps: open blend, keep only the armature + body + eyes (drop Cube junk),
drop unused extra body material slots, pose both arms down ~80deg as the new
rest pose (Shoulder swing, forearm follows rigidly — elbow joint untouched),
drop single-frame dead actions, bake object transforms into the data (the
FBX-lineage meshes carry a 90deg X rotation + 0.01 scale on the object;
without baking, the GLB skin collapses flat in-engine), export GLB with
skins + morphs. Prints NUB-GLB-OK with counts and the body base color.
"""

import sys

import bpy


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 2 and len(args) != 5:
        print("usage: export-pink.py <in.blend> <out.glb> [armature body eyes]")
        sys.exit(2)
    src, dst = args[0], args[1]
    arm_name, body_name, eyes_name = (
        args[2:5] if len(args) >= 5 else ("Nub_rigs.001", "Nub_body.001", "Nub_eyes.001")
    )

    bpy.ops.wm.open_mainfile(filepath=src)

    scn = bpy.context.scene
    # Arms down FIRST, on a pristine context (exact recipe — operator hates
    # leftover selection state): swing each whole arm ~80deg below horizontal
    # from the Shoulder as a rest-pose change (forearm follows rigidly,
    # elbow/Hand untouched). Base GLB and walk bake inherit it.
    # NOTE: rotating the Arm by the same world swing would double-rotate the
    # forearm (children inherit the parent swing AND apply their own) — the
    # forearm must keep its relative pose for the arm to stay straight.
    import math
    from mathutils import Quaternion, Vector

    arm = scn.objects.get(arm_name)
    if arm is None or arm.type != "ARMATURE":
        print(f"EXPORT-FAIL: armature {arm_name} missing")
        sys.exit(1)
    # naked_NUB.blend ships with pose_position=REST (posing disabled: every
    # pose op silently no-ops). Force POSE or the arms-down bake does nothing.
    arm.data.pose_position = "POSE"
    scn.view_layers[0].objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    arm_swings = {"Shoulder_R": -80.0, "Shoulder_L": 80.0}
    for bone_name, deg in arm_swings.items():
        pb = arm.pose.bones.get(bone_name)
        if pb is None:
            print(f"EXPORT-FAIL: bone {bone_name} missing")
            sys.exit(1)
        q_rest = pb.bone.matrix_local.to_quaternion()
        swing = Quaternion(Vector((0, 1, 0)), math.radians(deg))
        pb.rotation_quaternion = q_rest.inverted() @ swing @ q_rest
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # NOTE: pose.armature_apply is unreliable headless (silently no-ops in
    # some contexts), so this is intentionally NOT verified here. The exporter
    # preserves the pose as node rotations and scripts/check-arms.py composes
    # full TRS matrices to verify the net result on the exported file.
    arm = scn.objects.get(arm_name)
    keep = {arm_name, body_name, eyes_name}
    for o in list(scn.objects):
        if o.name not in keep:
            bpy.data.objects.remove(o, do_unlink=True)

    # The body may carry unused extra material slots (0 polys use them).
    body = scn.objects.get(body_name)
    while body and len(body.material_slots) > 1:
        from collections import Counter

        use = Counter(p.material_index for p in body.data.polygons)
        if use.get(len(body.material_slots) - 1):
            break
        body.active_material_index = len(body.material_slots) - 1
        bpy.ops.object.select_all(action="DESELECT")
        body.select_set(True)
        scn.view_layers[0].objects.active = body
        bpy.ops.object.material_slot_remove()

    # Bake object transforms into mesh/bone data so mesh space, joint space,
    # and inverse binds agree (unbaked: skin renders pancaked flat).
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Drop single-frame dead actions (static retarget stubs).
    for action in list(bpy.data.actions):
        lo, hi = action.frame_range
        if hi - lo < 0.5:
            bpy.data.actions.remove(action)

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_animations=False,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        use_selection=True,
    )

    arms = [o for o in scn.objects if o.type == "ARMATURE"]
    meshes = [o for o in scn.objects if o.type == "MESH"]
    bones = sum(len(o.data.bones) for o in arms)
    base = None
    if body:
        slot_mats = {s.material.name for s in body.material_slots if s.material}
        for m in bpy.data.materials:
            if not (m.use_nodes and m.name in slot_mats):
                continue
            for n in m.node_tree.nodes:
                if n.type == "BSDF_PRINCIPLED":
                    base = [round(v, 3) for v in n.inputs["Base Color"].default_value]
                    break
            if base:
                break
    print(f"NUB-GLB-OK bones={bones} meshes={len(meshes)} base={base}")


main()
