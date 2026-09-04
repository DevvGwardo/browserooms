"""Convert naked_NUB.fbx to a game-ready GLB via headless Blender.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/fbx-to-glb.py -- \
    /Users/devgwardo/Downloads/naked_NUB.fbx public/models/nakedNUB.glb

Steps: import FBX, drop the 1-frame static retarget actions (dead weight),
apply only non-armature transforms, export GLB with skins. Prints NUB-GLB-OK
with bone/mesh/material counts for the gate evidence.
"""

import sys

import bpy


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 2:
        print("usage: fbx-to-glb.py <in.fbx> <out.glb>")
        sys.exit(2)
    src, dst = args

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)

    # The FBX body mesh carries a 90° X rotation + 0.01 scale on the OBJECT
    # while the armature does not. Blender renders it fine, but the GLB skin
    # (mesh-space positions vs armature-space inverse binds) collapses flat
    # in-engine. Bake all object transforms into the data so mesh, joints,
    # and inverse binds share one space.
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Drop single-frame retarget actions: static T-pose, ~259 dead curves.
    for action in list(bpy.data.actions):
        lo, hi = action.frame_range
        if hi - lo < 0.5:
            bpy.data.actions.remove(action)

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_animations=False,
        export_skins=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )

    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bones = sum(len(o.data.bones) for o in arms)
    mats = sum(len(o.data.materials) for o in meshes)
    skinned = sum(
        1 for o in meshes for m in o.modifiers if m.type == "ARMATURE" and m.object
    )
    print(f"NUB-GLB-OK bones={bones} meshes={len(meshes)} mats={mats} skinned={skinned}")


main()
