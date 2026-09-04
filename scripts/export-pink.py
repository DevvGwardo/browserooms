"""Export the pink_nub.blend rig to a game-ready GLB via headless Blender.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/export-pink.py -- \
    /Users/devgwardo/Downloads/pink_nub.blend public/models/pinkNUB.glb

Steps: open blend, keep only the nub armature + body + eyes (drop the Cube
junk object), drop the unused second body material slot, drop single-frame
dead actions, bake object transforms into the data (the FBX-lineage meshes
carry a 90deg X rotation + 0.01 scale on the object; without baking, the GLB
skin collapses flat in-engine), export GLB with skins + morphs. Prints
PINK-GLB-OK with counts for the gate evidence.
"""

import sys

import bpy


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 2:
        print("usage: export-pink.py <in.blend> <out.glb>")
        sys.exit(2)
    src, dst = args

    bpy.ops.wm.open_mainfile(filepath=src)

    scn = bpy.context.scene
    keep = {"Nub_rigs.001", "Nub_body.001", "Nub_eyes.001"}
    for o in list(scn.objects):
        if o.name not in keep:
            bpy.data.objects.remove(o, do_unlink=True)

    # The body carries an unused second material slot (0 polys use it).
    body = scn.objects.get("Nub_body.001")
    if body and len(body.material_slots) > 1:
        body.active_material_index = 1
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
    pink = None
    for m in bpy.data.materials:
        if m.name.startswith("M_Cat2") and m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == "BSDF_PRINCIPLED":
                    pink = [round(v, 3) for v in n.inputs["Base Color"].default_value]
    print(f"PINK-GLB-OK bones={bones} meshes={len(meshes)} pink={pink}")


main()
