"""Export a nub .blend rig to a game-ready GLB via headless Blender.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/export-pink.py -- \
    /Users/devgwardo/Downloads/pink_nub.blend public/models/pinkNUB.glb
    [armature body eyes]

Defaults suit pink_nub.blend (Nub_rigs.001, Nub_body.001, Nub_eyes.001).
For naked_NUB.blend pass: Nub_rigs Nub_body Nub_eyes.

Steps: open blend, keep only the armature + body + eyes (drop Cube junk),
drop unused extra body material slots, drop single-frame dead actions, bake
object transforms into the data (the FBX-lineage meshes carry a 90deg X
rotation + 0.01 scale on the object; without baking, the GLB skin collapses
flat in-engine), export GLB with skins + morphs. Prints NUB-GLB-OK with
counts and the body base color for the gate evidence.
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
