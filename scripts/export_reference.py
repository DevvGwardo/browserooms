"""Private hybrid-PBR reference export, always from the read-only snapshot.

Blender --background --factory-startup --python scripts/export_reference.py
Use -- --resume-atlases after a completed reference-export.blend checkpoint.
Use -- --verify-export to render the exported GLB and saved texture maps.
"""

import importlib.util
import ctypes
import json
import math
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets/lookdev"
OUT = ROOT / "public/reference"
SOURCE = ASSETS / "reference-final-retained-wallpaper.blend"
RESOLUTIONS = {"walls": 2048, "floor": 1024, "ceiling": 2048, "details": 1024}
COLLECTIONS = {"walls": "Architecture", "floor": "Floor", "ceiling": "Ceiling and lighting", "details": "Trim and fixtures"}
SPAWN = {"position": [-4.2, 1.65, 10], "yaw": -0.38, "pitch": -0.025}
SPEC = importlib.util.spec_from_file_location("reference_builder", ROOT / "scripts/bake_modules.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def log(message):
    print("REFERENCE: " + message, flush=True)


def select(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def configure():
    scene = bpy.context.scene
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for device in prefs.devices:
        device.use = device.type == "METAL"
    assert any(d.use for d in prefs.devices), "Metal device unavailable"
    scene.cycles.device = "GPU"
    scene.cycles.samples = 192
    scene.cycles.max_bounces = 12
    scene.cycles.diffuse_bounces = 8
    scene.cycles.glossy_bounces = 4
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    bpy.context.preferences.filepaths.save_version = 0


def bounds(obj):
    points = [obj.matrix_world @ Vector(p) for p in obj.bound_box]
    points = [(p.x, p.z, -p.y) for p in points]
    return {"min": [min(p[a] for p in points) for a in range(3)],
            "max": [max(p[a] for p in points) for a in range(3)]}


def image_target(obj, name, resolution, color=False):
    image = bpy.data.images.new(name, width=resolution, height=resolution, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "sRGB" if color else "Non-Color"
    for mat in obj.data.materials:
        if not mat:
            continue
        mat.use_nodes = True
        node = mat.node_tree.nodes.get("Reference bake destination") or mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.name = "Reference bake destination"
        node.image = image
        mat.node_tree.nodes.active = node
    select([obj])
    return image


def save_image(image, filename):
    # Force lazy-loaded EXR pixels into memory before changing its source path.
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    rgb = pixels.reshape((-1, 4))[:, :3]
    assert np.isfinite(rgb).all(), filename
    lit = rgb[np.max(rgb, axis=1) > 0.00001]
    assert len(lit), filename
    image.filepath_raw = str(OUT / filename)
    image.file_format = "HDR" if filename.endswith(".hdr") else "PNG"
    image.save()
    if filename.endswith(".png"):
        png8(OUT / filename)
    return {"file": filename, "resolution": list(image.size), "maximum": float(rgb.max()),
            "meanNonBlack": [float(x) for x in lit.mean(axis=0, dtype=np.float64)], "nonBlackPixels": len(lit),
            "fileBytes": (OUT / filename).stat().st_size}


def png8(path):
    # Float bake buffers otherwise save as PNG16, regardless of render settings.
    temporary = path.with_name(path.stem + "-8bit.png")
    subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-y", "-i", str(path),
                    "-pix_fmt", "rgb24", "-frames:v", "1", str(temporary)], check=True)
    temporary.replace(path)


def denoise_lightmap(image):
    # Use Blender's bundled OIDN on lighting only, never on the independent tile maps.
    lib = ctypes.CDLL(str(Path(bpy.app.binary_path).parents[1] / "Resources/lib/libOpenImageDenoise.dylib"))
    ptr, size = ctypes.c_void_p, ctypes.c_size_t
    signatures = {
        "oidnNewDevice": ([ctypes.c_int], ptr), "oidnCommitDevice": ([ptr], None),
        "oidnNewFilter": ([ptr, ctypes.c_char_p], ptr),
        "oidnSetSharedFilterImage": ([ptr, ctypes.c_char_p, ptr, ctypes.c_int, size, size, size, size, size], None),
        "oidnSetFilterBool": ([ptr, ctypes.c_char_p, ctypes.c_bool], None),
        "oidnCommitFilter": ([ptr], None), "oidnExecuteFilter": ([ptr], None),
        "oidnGetDeviceError": ([ptr, ctypes.POINTER(ctypes.c_char_p)], ctypes.c_int),
        "oidnReleaseFilter": ([ptr], None), "oidnReleaseDevice": ([ptr], None),
    }
    for name, (args, result) in signatures.items():
        function = getattr(lib, name)
        function.argtypes, function.restype = args, result
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    device = lib.oidnNewDevice(1)
    lib.oidnCommitDevice(device)
    filter_ = lib.oidnNewFilter(device, b"RT")
    output = pixels.copy()
    for name, values in [(b"color", pixels), (b"output", output)]:
        lib.oidnSetSharedFilterImage(filter_, name, values.ctypes.data, 3, image.size[0], image.size[1], 0, 16, image.size[0] * 16)
    lib.oidnSetFilterBool(filter_, b"hdr", True)
    lib.oidnCommitFilter(filter_)
    lib.oidnExecuteFilter(filter_)
    error = ctypes.c_char_p()
    code = lib.oidnGetDeviceError(device, ctypes.byref(error))
    lib.oidnReleaseFilter(filter_)
    lib.oidnReleaseDevice(device)
    assert code == 0, error.value
    image.pixels.foreach_set(output)
    image.update()


def planar_atlas(obj):
    uv = obj.data.uv_layers["LightmapUV"]
    for loop in obj.data.loops:
        p = obj.matrix_world @ obj.data.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (0.004 + (p.x + 16) / 32 * 0.992, 0.004 + (p.y + 16) / 32 * 0.992)


def detail_atlas(obj):
    # Reserve a third of the atlas for the supplied outlets rather than allocating
    # by world area, which makes their plates subpixel next to 200 m of skirting.
    uv = obj.data.uv_layers["LightmapUV"]
    obj.data.uv_layers.active = uv
    select([obj])
    bpy.context.tool_settings.mesh_select_mode = (False, False, True)
    outlet_slots = {i for i, mat in enumerate(obj.data.materials) if mat and mat.name.startswith(("Lookdev - Wallplates", "Lookdev - Recepticles"))}
    for outlets, offset, scale in [(False, 0.36, 0.63), (True, 0.01, 0.33)]:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.object.mode_set(mode="OBJECT")
        for face in obj.data.polygons:
            face.select = (face.material_index in outlet_slots) == outlets
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=1, correct_aspect=True, scale_to_bounds=True)
        bpy.ops.object.mode_set(mode="OBJECT")
        uv = obj.data.uv_layers["LightmapUV"]
        for face in obj.data.polygons:
            if (face.material_index in outlet_slots) == outlets:
                for loop in face.loop_indices:
                    uv.data[loop].uv.y = offset + uv.data[loop].uv.y * scale


def bake_tile(family, material_name, size, resolution):
    # Copy nested shader groups: emission extraction must not change room shaders.
    mat = bpy.data.materials[material_name].copy()
    mat.name = "Reference tile " + family

    def copy_groups(tree):
        for node in tree.nodes:
            if node.type == "GROUP":
                node.node_tree = node.node_tree.copy()
                copy_groups(node.node_tree)
    copy_groups(mat.node_tree)
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    plane = bpy.context.object
    plane.name = "Reference physical tile " + family
    if family == "walls":
        plane.rotation_euler.x = math.pi / 2
        plane.location = (size / 2, 0, size / 2)
    else:
        plane.location = (size / 2, size / 2, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    plane.data.uv_layers.active.name = "SurfaceUV"
    plane.data.uv_layers.active.active_render = True
    plane.data.materials.append(mat)
    hidden = [(obj, obj.hide_render) for obj in bpy.context.scene.objects if obj != plane and obj.type != "EMPTY"]
    for obj, _ in hidden:
        obj.hide_render = True
    stats = []
    prefix = "wall" if family == "walls" else "carpet"
    # Cycles tangent normal includes the shader's actual bump/normal strength.
    for kind, bake_type, color in [("albedo", "DIFFUSE", True), ("normal", "NORMAL", False), ("roughness", "ROUGHNESS", False)]:
        image = image_target(plane, prefix + " " + kind, resolution, color)
        log(f"Baking {prefix} {kind} {resolution}px")
        kwargs = {"pass_filter": {"COLOR"}} if kind == "albedo" else {}
        bpy.ops.object.bake(type=bake_type, uv_layer="SurfaceUV", normal_space="TANGENT", margin=0, **kwargs)
        stats.append(save_image(image, f"{prefix}-{kind}.png"))
    bpy.data.objects.remove(plane, do_unlink=True)
    for obj, value in hidden:
        obj.hide_render = value
    return stats


def prepare_geometry(groups):
    result = {}
    for family, objects in groups.items():
        select(objects)
        # Apply evaluated bevels before merging so the inset and outlet silhouettes survive.
        bpy.ops.object.convert(target="MESH")
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = "Reference " + family
        obj["surface"] = family
        obj["surfaceFamily"] = family
        obj["radiance"] = family + ("-light.hdr" if family in ("walls", "floor") else "-radiance.hdr")
        if family in ("walls", "floor"):
            for uv in list(obj.data.uv_layers):
                if uv.name != "SurfaceUV":
                    obj.data.uv_layers.remove(uv)
            obj.data.uv_layers["SurfaceUV"].active_render = True
        else:
            # Existing imported UVs still feed fixture textures during the bake.
            for uv in obj.data.uv_layers:
                uv.active_render = True
        uv = obj.data.uv_layers.new(name="LightmapUV")
        obj.data.uv_layers.active = uv
        if family in ("floor", "ceiling"):
            planar_atlas(obj)
        elif family == "details":
            detail_atlas(obj)
        else:
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=1, correct_aspect=True, scale_to_bounds=True)
            bpy.ops.object.mode_set(mode="OBJECT")
        result[family] = obj
    return result


def verify_export():
    manifest = json.loads((OUT / "modules.json").read_text())
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    configure()
    scene = bpy.context.scene
    for obj in scene.objects:
        if obj.type != "CAMERA":
            obj.hide_render = True
    bpy.ops.import_scene.gltf(filepath=str(OUT / "reference.glb"))
    imported = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]
    assert len(imported) == 4
    all_bounds = []
    for obj in imported:
        obj.hide_render = False
        all_bounds.append(bounds(obj))
        descriptor = manifest["materials"][obj["surface"]]
        mat = bpy.data.materials.new("Reloaded hybrid " + obj["surface"])
        mat.use_nodes = True
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        nodes.clear()

        def texture(filename, channel, color=False, repeat=False):
            tex = nodes.new("ShaderNodeTexImage")
            tex.image = bpy.data.images.load(str(OUT / filename), check_existing=False)
            tex.image.colorspace_settings.name = "sRGB" if color else "Non-Color"
            tex.extension = "REPEAT" if repeat else "EXTEND"
            uv = nodes.new("ShaderNodeUVMap")
            uv.uv_map = obj.data.uv_layers[channel].name
            links.new(uv.outputs["UV"], tex.inputs["Vector"])
            return tex.outputs["Color"]

        if descriptor["kind"] == "pbr":
            albedo = texture(descriptor["albedo"], 0, True, True)
            light = texture(descriptor["lightmap"], 1)
            multiply = nodes.new("ShaderNodeMixRGB")
            multiply.blend_type = "MULTIPLY"
            multiply.inputs[0].default_value = 1
            links.new(albedo, multiply.inputs[1])
            links.new(light, multiply.inputs[2])
            color = multiply.outputs[0]
        else:
            color = texture(descriptor["radiance"], 0)
        emission = nodes.new("ShaderNodeEmission")
        links.new(color, emission.inputs["Color"])
        output = nodes.new("ShaderNodeOutputMaterial")
        links.new(emission.outputs[0], output.inputs["Surface"])
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    exported_bounds = {key: [operation(b[key][a] for b in all_bounds) for a in range(3)]
                       for key, operation in [("min", min), ("max", max)]}
    for axis in (0, 2):
        assert abs(exported_bounds["min"][axis] + 16) < 0.0001
        assert abs(exported_bounds["max"][axis] - 16) < 0.0001
    scene.cycles.samples = 16
    scene.render.filepath = str(ASSETS / "reference-pbr-diffuse-reconstruction.png")
    bpy.ops.render.render(write_still=True)
    for descriptor in manifest["materials"].values():
        for key in ("albedo", "normal", "roughness"):
            if key in descriptor:
                data = (OUT / descriptor[key]).read_bytes()
                assert data[:8] == b"\x89PNG\r\n\x1a\n"
                assert data[24] == 8 and data[25] == 2, (descriptor[key], "Expected 8-bit RGB", list(data[24:26]))
    report = {"exportedBounds": exported_bounds, "importedMeshCount": len(imported),
              "png8RgbVerified": True, "reconstruction": "reference-pbr-diffuse-reconstruction.png",
              "comparison": "Diffuse-only saved-map replay: albedo times E/pi; excludes view-dependent specular and runtime sheen."}
    (ASSETS / "reference-export-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    log("Verified: " + json.dumps(report))


def main():
    start = time.monotonic()
    OUT.mkdir(parents=True, exist_ok=True)
    if "--verify-export" in sys.argv:
        verify_export()
        return
    resume = "--resume-atlases" in sys.argv
    bpy.ops.wm.open_mainfile(filepath=str(ASSETS / "reference-export.blend" if resume else SOURCE))
    configure()
    scene = bpy.context.scene
    if resume:
        manifest = json.loads((ASSETS / "reference-export-metadata.json").read_text())
        groups = {family: bpy.data.objects["Reference " + family] for family in RESOLUTIONS}
        planar_atlas(groups["ceiling"])
        if groups["details"].data.uv_layers.get("SourceUV"):
            groups["details"].data.uv_layers["SourceUV"].name = "UVMap"
        detail_atlas(groups["details"])
    else:
        incoming = bpy.data.collections["Incoming Assets"]
        incoming.hide_render = True
        excluded = set(incoming.all_objects)
        groups = {family: [o for o in bpy.data.collections[name].all_objects if o.type == "MESH" and o not in excluded and not o.hide_render]
                  for family, name in COLLECTIONS.items()}
        builder.source.GROUPS = groups
        builder.source.COLLIDERS = [bounds(obj) for obj in groups["walls"]]
        builder.FLOORS[:] = [(b["min"][0], b["min"][2], b["max"][0], b["max"][2]) for b in map(bounds, groups["floor"])]
        meta = builder.metadata("reference")
        meta["spawn"] = SPAWN
        meta["radiance"] = [{"file": f + ("-light.hdr" if f in ("walls", "floor") else "-radiance.hdr"), "family": f, "flipY": False, "resolution": r} for f, r in RESOLUTIONS.items()]
        validation = builder.validate(meta)
        log("Navigation validated: " + json.dumps(validation))
        aspect = scene.render.resolution_x * scene.render.pixel_aspect_x / (scene.render.resolution_y * scene.render.pixel_aspect_y)
        manifest = {"version": 1, "cellSize": 32, "templates": [meta], "materials": {
            "walls": {"kind": "pbr", "family": "walls", "albedo": "wall-albedo.png", "normal": "wall-normal.png", "roughness": "wall-roughness.png", "lightmap": "walls-light.hdr", "normalScale": 1, "roughnessFactor": 1, "sheen": 0},
            "floor": {"kind": "pbr", "family": "floor", "albedo": "carpet-albedo.png", "normal": "carpet-normal.png", "roughness": "carpet-roughness.png", "lightmap": "floor-light.hdr", "normalScale": 1, "roughnessFactor": 1, "sheen": 0.15},
            "ceiling": {"kind": "radiance", "family": "ceiling", "radiance": "ceiling-radiance.hdr"},
            "details": {"kind": "radiance", "family": "details", "radiance": "details-radiance.hdr"}},
             "bake": {"sourceSnapshot": SOURCE.name, "wallMaterial": "Wallpaper - replace with supplied material", "engine": "Cycles", "device": "Metal", "samples": 192, "diffuseBounces": 8, "totalBounces": 12,
                     "camera": {"verticalFovDegrees": math.degrees(2 * math.atan(scene.camera.data.sensor_width / (2 * scene.camera.data.lens * aspect))), "exposureStops": scene.view_settings.exposure, "viewTransform": scene.view_settings.view_transform, "look": scene.view_settings.look.replace("AgX - ", "")},
                     "pbrLighting": "DIFFUSE DIRECT+INDIRECT, no COLOR: unit-albedo outgoing diffuse E/pi. THREE.lightMapIntensity=pi; no environment diffuse.",
                     "uv": "PBR TEXCOORD_0=SurfaceUV physically tiled; TEXCOORD_1=LightmapUV. Radiance TEXCOORD_0=LightmapUV. glTF V=1-Blender V; all surface textures flipY=false.",
                     "normal": "OpenGL tangent-space +Y, baked shader normal including source strength; runtime normalScale=1.",
                     "colorSpace": "Albedo PNG sRGB; normal/roughness PNG Non-Color; light/radiance HDR scene-linear Rec.709 RGBE.",
                     "physicalTileMeters": {"walls": 0.5, "floor": 1.2}, "validation": validation}}
        scene.render.filepath = str(ASSETS / "reference-pbr-source.png")
        log("Rendering exact source camera")
        if "--reuse-renders" not in sys.argv:
            bpy.ops.render.render(write_still=True)
        shutil.copyfile(ASSETS / "reference-pbr-source.png", OUT / "preview.png")
        # EXR is scene-linear, bypassing AgX/exposure; HDR conversion uses image.save.
        camera = scene.camera
        panorama_data = camera.data.copy()
        panorama = bpy.data.objects.new("Reference reflection camera", panorama_data)
        scene.collection.objects.link(panorama)
        panorama.location = camera.location
        panorama.rotation_euler = (math.pi / 2, 0, 0)
        panorama_data.type = "PANO"
        panorama_data.panorama_type = "EQUIRECTANGULAR"
        scene.camera = panorama
        old_res = (scene.render.resolution_x, scene.render.resolution_y)
        scene.render.resolution_x, scene.render.resolution_y = 1024, 512
        scene.cycles.samples = 64
        scene.render.image_settings.file_format = "OPEN_EXR"
        scene.render.image_settings.color_depth = "32"
        scene.render.filepath = str(ASSETS / "reference-reflection.exr")
        log("Rendering linear specular reflection environment")
        if "--reuse-renders" not in sys.argv:
            bpy.ops.render.render(write_still=True)
        reflection = bpy.data.images.load(scene.render.filepath, check_existing=False)
        reflection.colorspace_settings.name = "Non-Color"
        save_image(reflection, "reflection.hdr")
        manifest["environment"] = "reflection.hdr"
        scene.camera = camera
        bpy.data.objects.remove(panorama, do_unlink=True)
        scene.render.resolution_x, scene.render.resolution_y = old_res
        configure()
        manifest["bake"]["tileTextures"] = bake_tile("walls", "Wallpaper - replace with supplied material", 0.5, 2048) + bake_tile("floor", "Lookdev - supplied carpet", 1.2, 1024)
        groups = prepare_geometry(groups)
        (ASSETS / "reference-export-metadata.json").write_text(json.dumps(manifest, indent=2) + "\n")
        bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "reference-export.blend"))
    stats = []
    for family, obj in groups.items():
        filename = obj["radiance"]
        if resume and "--details-only" in sys.argv and family != "details":
            previous = json.loads((OUT / "modules.json").read_text())
            stats.append(next(s for s in previous["bake"]["atlases"] if s["family"] == family))
            continue
        image = image_target(obj, "Reference atlas " + family, RESOLUTIONS[family])
        log(f"Baking {family} {RESOLUTIONS[family]}px")
        if family in ("walls", "floor"):
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer="LightmapUV", margin=8, margin_type="EXTEND")
            denoise_lightmap(image)
        else:
            bpy.ops.object.bake(type="COMBINED", pass_filter={"DIRECT", "INDIRECT", "DIFFUSE", "EMIT"}, uv_layer="LightmapUV", margin=8, margin_type="EXTEND")
        stat = save_image(image, filename)
        stat.update({"family": family, "gpuHalfFloatRgbaBytes": RESOLUTIONS[family] ** 2 * 8})
        stats.append(stat)
    # Save reusable bake state before stripping source UVs/materials for GLB only.
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "reference-export.blend"))
    for family, obj in groups.items():
        if family not in ("walls", "floor"):
            for uv in list(obj.data.uv_layers):
                if uv.name != "LightmapUV":
                    obj.data.uv_layers.remove(uv)
        obj.data.uv_layers.active_index = 0
        obj.data.uv_layers[0].active_render = True
        obj.data.materials.clear()
        for face in obj.data.polygons:
            face.material_index = 0
    select(list(groups.values()))
    bpy.ops.export_scene.gltf(filepath=str(OUT / "reference.glb"), export_format="GLB", use_selection=True,
                              export_materials="NONE", export_extras=True, export_yup=True, export_animations=False,
                              export_cameras=False, export_lights=False, export_texcoords=True)
    data = (OUT / "reference.glb").read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
    nodes = [n for n in gltf["nodes"] if "mesh" in n]
    assert len(nodes) == 4
    assert not gltf.get("materials")
    for node in nodes:
        family = node["extras"]["surface"]
        primitives = gltf["meshes"][node["mesh"]]["primitives"]
        assert len(primitives) == 1, (family, len(primitives))
        for p in primitives:
            assert "TEXCOORD_0" in p["attributes"]
            if family in ("walls", "floor"):
                assert "TEXCOORD_1" in p["attributes"]
    triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for mesh in gltf["meshes"] for p in mesh["primitives"])
    for texture in manifest["bake"]["tileTextures"]:
        texture["fileBytes"] = (OUT / texture["file"]).stat().st_size
    manifest["bake"].update({"atlases": stats, "lightingDenoiser": "Blender-bundled OpenImageDenoise RT, HDR, walls/floor only", "triangles": triangles, "drawCallsPerRoom": len(nodes), "geometryBytes": len(data), "seconds": round(time.monotonic() - start, 2)})
    (OUT / "modules.json").write_text(json.dumps(manifest, indent=2) + "\n")
    subprocess.run(["bun", str(ROOT / "scripts/build_seam_lighting.ts")], cwd=ROOT, check=True)
    log("Complete: " + json.dumps({"triangles": triangles, "drawCalls": len(nodes), "lights": len(manifest["templates"][0]["lights"]), "seconds": manifest["bake"]["seconds"]}))


if __name__ == "__main__":
    main()
