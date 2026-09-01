"""Rebuild only ceiling circuits, then refresh illumination in preserved trim-free rooms."""
import importlib.util
import json
import sys
from pathlib import Path
import bpy

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "assets/scattered-lights"
OUT = ROOT / "public/continuous"
WORK.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location("continuous", ROOT / "scripts/bake_continuous_floor.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
exporter = builder.exporter
lights = {}

for template in builder.TEMPLATES:
    bpy.ops.wm.open_mainfile(filepath=str(ROOT / "assets/no-baseboards" / f"{template}.blend"))
    builder.configure()
    groups = {family: bpy.data.objects[f"{template} {family}"] for family in (*builder.RESOLUTIONS, "ceiling-lights")}
    mats = {family: groups[family].active_material for family in ("ceiling", "ceiling-lights")}
    for material in mats.values():
        material.use_fake_user = True
    for obj in list(bpy.data.objects):
        if obj.name in (f"{template} ceiling", f"{template} ceiling-lights") or (obj.get("bakeSupportOnly") and "ceiling" in obj.name.lower()):
            bpy.data.objects.remove(obj, do_unlink=True)
    ceiling, lights[template] = builder.make_ceiling(template, mats)
    groups.update(builder.prepare(template, {family: [obj] for family, obj in ceiling.items()}))
    builder.make_ceiling(template, mats, support=True)
    bpy.context.view_layer.update()
    print(f"{template}: {len(lights[template])} of 100 fixtures powered", flush=True)
    for family, resolution in builder.RESOLUTIONS.items():
        filename = f"{template}-{family}-scattered.hdr"
        groups[family]["radiance"] = filename
        image = exporter.image_target(groups[family], f"{template} {family} scattered", resolution)
        pbr = family != "details"
        bpy.ops.object.bake(type="DIFFUSE" if pbr else "COMBINED",
            pass_filter={"DIRECT", "INDIRECT"} if pbr else {"DIRECT", "INDIRECT", "DIFFUSE", "EMIT"},
            uv_layer="LightmapUV", margin=0 if family in ("floor", "ceiling") else 8, margin_type="EXTEND")
        if pbr:
            exporter.denoise_lightmap(image)
        exporter.save_image(image, filename)
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK / f"{template}.blend"))
    for family, obj in groups.items():
        if family == "details":
            for uv in list(obj.data.uv_layers):
                if uv.name != "LightmapUV":
                    obj.data.uv_layers.remove(uv)
        if family != "ceiling":
            for color in list(obj.data.color_attributes):
                obj.data.color_attributes.remove(color)
        obj.data.uv_layers.active_index = 0
        obj.data.uv_layers[0].active_render = True
        obj.data.materials.clear()
        for face in obj.data.polygons:
            face.material_index = 0
    exporter.select(list(groups.values()))
    bpy.ops.export_scene.gltf(filepath=str(OUT / f"{template}-scattered.glb"),
        export_format="GLB", use_selection=True, export_materials="NONE", export_extras=True,
        export_yup=True, export_animations=False, export_cameras=False, export_lights=False,
        export_texcoords=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True)

manifest = json.loads((OUT / "modules.json").read_text())
for template in manifest["templates"]:
    name = template["id"]
    template["geometry"] = f"{name}-scattered.glb"
    template["lights"] = lights[name]
    for atlas in template["radiance"]:
        family = atlas["family"]
        filename = f"{name}-{family}-scattered.hdr"
        atlas["file"] = filename
        manifest["materials"][f"{name}-{family}"]["radiance" if family == "details" else "lightmap"] = filename
manifest["bake"]["ceiling"]["powerPattern"] = "Stable scattered circuits, 60% probability; seed 47"
(WORK / "modules.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("Scattered ceiling assets ready; live manifest unchanged.", flush=True)
