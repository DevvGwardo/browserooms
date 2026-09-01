"""Create no-baseboard work copies and wall-only bakes without changing live assets.

Blender --background --factory-startup --python-exit-code 1 \
  --python scripts/remove_baseboards.py
"""

import importlib.util
import json
import sys
from pathlib import Path

import bmesh
import bpy

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "assets/no-baseboards"
OUT = ROOT / "public/continuous"
TEMPLATES = ("open-gallery", "open-offset", "open-columns")
FAMILIES = ("walls", "floor", "ceiling", "details", "ceiling-lights")
SPEC = importlib.util.spec_from_file_location("reference_export", ROOT / "scripts/export_reference.py")
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)
exporter.OUT = OUT


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    for template in TEMPLATES:
        bpy.ops.wm.open_mainfile(filepath=str(ROOT / "assets/continuous" / (template + ".blend")))
        if bpy.context.object and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        exporter.configure()
        bpy.context.scene.cycles.samples = 128
        bpy.context.scene.cycles.use_denoising = True
        bpy.context.view_layer.update()
        groups = {family: bpy.data.objects[template + " " + family] for family in FAMILIES}
        details = groups["details"]
        mesh = bmesh.new()
        mesh.from_mesh(details.data)
        low_faces = [face for face in mesh.faces
                     if all((details.matrix_world @ vertex.co).z <= 0.13 for vertex in face.verts)]
        removed = len(low_faces)
        # Delete whole low faces only; BMesh retains surviving loop UVs without repacking.
        bmesh.ops.delete(mesh, geom=low_faces, context="FACES")
        mesh.to_mesh(details.data)
        mesh.free()
        details.data.update()
        helpers = [obj for obj in bpy.context.scene.objects
                   if obj.type == "MESH" and obj.get("bakeSupportOnly")
                   and "skirting" in obj.name.lower()
                   and all((obj.matrix_world @ vertex.co).z <= 0.13 for vertex in obj.data.vertices)]
        for obj in helpers:
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.context.view_layer.update()
        print(f"NO BASEBOARDS: {template}: removed {removed} low detail faces and {len(helpers)} skirting helpers", flush=True)

        filename = template + "-walls-no-baseboards.hdr"
        walls = groups["walls"]
        walls["radiance"] = filename
        image = exporter.image_target(walls, template + " walls no-baseboards bake", 2048)
        print(f"NO BASEBOARDS: {template}: baking walls, 2048px, 128 Metal samples", flush=True)
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"},
                            uv_layer="LightmapUV", margin=8, margin_type="EXTEND")
        exporter.denoise_lightmap(image)
        exporter.save_image(image, filename)
        # Keep the reusable material-bearing checkpoint before export-only cleanup.
        bpy.ops.wm.save_as_mainfile(filepath=str(WORK / (template + ".blend")))

        for family, obj in groups.items():
            if family == "details":
                for uv in list(obj.data.uv_layers):
                    if uv.name != "LightmapUV":
                        obj.data.uv_layers.remove(uv)
            if family != "ceiling":
                for colors in list(obj.data.color_attributes):
                    obj.data.color_attributes.remove(colors)
            obj.data.uv_layers.active_index = 0
            obj.data.uv_layers[0].active_render = True
            obj.data.materials.clear()
            for face in obj.data.polygons:
                face.material_index = 0
        exporter.select(list(groups.values()))
        bpy.ops.export_scene.gltf(filepath=str(OUT / (template + "-no-baseboards.glb")),
            export_format="GLB", use_selection=True, export_materials="NONE", export_extras=True,
            export_yup=True, export_animations=False, export_cameras=False, export_lights=False,
            export_texcoords=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
            export_active_vertex_color_when_no_material=True)
        print(f"NO BASEBOARDS: {template}: saved new wall atlas, work copy, and GLB", flush=True)

    # Read the current manifest last so concurrent material and palette updates survive.
    manifest = json.loads((OUT / "modules.json").read_text())
    for meta in manifest["templates"]:
        template = meta["id"]
        if template not in TEMPLATES:
            continue
        meta["geometry"] = template + "-no-baseboards.glb"
        filename = template + "-walls-no-baseboards.hdr"
        for atlas in meta["radiance"]:
            if atlas["family"] == "walls":
                atlas["file"] = filename
        manifest["materials"][template + "-walls"]["lightmap"] = filename
    (WORK / "modules.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("NO BASEBOARDS: proposed manifest saved to assets/no-baseboards/modules.json", flush=True)


if __name__ == "__main__":
    main()
