"""Headless continuous-floor kit; never edits the approved sources or reference maps.

Blender --background --factory-startup --python-exit-code 1 \
  --python scripts/bake_continuous_floor.py
Options after --: --template open-gallery, --geometry-only, --resume, --verify-only,
--metadata-only (repairs metadata against the existing GLBs without rebaking).
"""

import argparse
import hashlib
import importlib.util
import json
import math
import struct
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "assets/continuous"
OUT = ROOT / "public/continuous"
SOURCE = ROOT / "assets/lookdev/ceiling-update/refined-ceiling.blend"
LAYOUT_SOURCE = ROOT / "assets/lookdev/reference-final-retained-wallpaper.blend"
TEMPLATES = ("open-gallery", "open-offset", "open-columns")
RESOLUTIONS = {"walls": 2048, "floor": 1024, "ceiling": 1024, "details": 1024}
SPAWN = {"position": [-4.2, 1.65, 10], "yaw": -0.38, "pitch": -0.025}
PASSAGES = [{"min": -18, "max": -9.12}, {"min": -8.88, "max": 8.88}, {"min": 9.12, "max": 18}]
SPEC = importlib.util.spec_from_file_location("reference_export", ROOT / "scripts/export_reference.py")
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)
exporter.OUT = OUT


def log(message):
    print("CONTINUOUS: " + message, flush=True)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def protected_hashes():
    paths = [SOURCE, LAYOUT_SOURCE, *sorted((ROOT / "public/reference").glob("*"))]
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}


def configure():
    exporter.configure()
    scene = bpy.context.scene
    scene.cycles.samples = 128
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 1
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.resolution_percentage = 100
    scene.camera.data.type = "PERSP"
    scene.camera.data.sensor_fit = "HORIZONTAL"
    scene.camera.data.sensor_width = 36
    scene.camera.data.lens = 36 / (2 * (1280 / 720) * math.tan(math.radians(51.4814167) / 2))
    scene.camera.data.clip_start = 0.03
    scene.camera.data.clip_end = 400


def mesh_object(name, vertices, faces, material, tile=0.5):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(material)
    uv = mesh.uv_layers.new(name="SurfaceUV")
    uv.active_render = True
    for face in mesh.polygons:
        for index in face.loop_indices:
            p = mesh.vertices[mesh.loops[index].vertex_index].co
            pair = (p.x, p.y) if abs(face.normal.z) > 0.8 else (p.y if abs(face.normal.x) > abs(face.normal.y) else p.x, p.z)
            uv.data[index].uv = (pair[0] / tile, pair[1] / tile)
    return obj


def cuboid(name, x0, z0, x1, z1, height, material, bottom=0, open_edges=True):
    vertices = [(x0, -z1, bottom), (x1, -z1, bottom), (x1, -z0, bottom), (x0, -z0, bottom),
                (x0, -z1, height), (x1, -z1, height), (x1, -z0, height), (x0, -z0, height)]
    faces = [(4, 5, 6, 7)]
    # No boundary end faces, bevels, or skirt caps: neighbor wall sides meet exactly.
    for face, edge in [((0, 1, 5, 4), z1), ((1, 2, 6, 5), x1),
                       ((2, 3, 7, 6), z0), ((3, 0, 4, 7), x0)]:
        if not open_edges or abs(abs(edge) - 18) > 1e-6:
            faces.append(face)
    return mesh_object(name, vertices, faces, material)


def wall(name, x0, z0, x1, z1, height, mats, groups, colliders, support=False):
    obj = cuboid(name, x0, z0, x1, z1, height, mats["walls"])
    pad = 0.015
    sx0, sz0, sx1, sz1 = x0 - pad, z0 - pad, x1 + pad, z1 + pad
    if not support:
        sx0, sz0, sx1, sz1 = max(-18, sx0), max(-18, sz0), min(18, sx1), min(18, sz1)
    else:
        sx0 = x0 if abs(abs(x0) - 18) < 1e-6 else sx0
        sz0 = z0 if abs(abs(z0) - 18) < 1e-6 else sz0
        sx1 = x1 if abs(abs(x1) - 18) < 1e-6 else sx1
        sz1 = z1 if abs(abs(z1) - 18) < 1e-6 else sz1
    if support:
        obj["bakeSupportOnly"] = True
    else:
        groups["walls"].append(obj)
        colliders.append({"min": [sx0, 0, sz0], "max": [sx1, height, sz1]})
        if height < 2:
            groups["details"].append(cuboid(name + " cap", sx0, sz0, sx1, sz1, height + 0.035, mats["trim"], bottom=height))


def floor(name, x0, y0, x1, y1, material):
    return mesh_object(name, [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)], [(0, 1, 2, 3)], material, 1.2)


def make_ceiling(template, mats, support=False):
    buffers = {family: {"vertices": [], "faces": [], "values": []} for family in ("ceiling", "ceiling-lights")}
    fixtures = []

    def quad(family, points, value):
        b = buffers[family]
        first = len(b["vertices"])
        b["vertices"].extend(points)
        b["faces"].append(tuple(range(first + 3, first - 1, -1)))
        b["values"].append(value)

    # Grid phase is the old -12 m origin, extended rather than recentered.
    for ix in range(-6, 36) if support else range(30):
        for iz in range(-12, 72) if support else range(60):
            if support and 0 <= ix < 30 and 0 <= iz < 60:
                continue
            x0, y0 = -18 + ix * 1.2, -18 + iz * 0.6
            x1, y1 = x0 + 1.2, y0 + 0.6
            x, z = (x0 + x1) / 2, -(y0 + y1) / 2
            slot = ix % 3 == 0 and iz % 6 == 1
            # Repeat the stable circuit pattern across tile edges and bake-support neighbors.
            circuit = hashlib.sha256(f"ceiling-power:47:{ix % 30}:{iz % 60}".encode()).digest()
            powered = int.from_bytes(circuit[:4], "big") / 2**32 < 0.60
            emitting = slot and powered
            h = 3.001 if emitting else 3.002
            pad = 0.007
            inner = [(x0 + pad, y0 + pad, h), (x1 - pad, y0 + pad, h),
                     (x1 - pad, y1 - pad, h), (x0 + pad, y1 - pad, h)]
            outer = [(a, b, 3) for a, b, _ in inner]
            # Repeating coordinate hash, so tints match on all unrotated cell edges.
            tint = 0.982 + (((ix % 30) * 17 + (iz % 60) * 37) % 101) / 100 * 0.018
            if emitting:
                ratio = (1.2 - 0.046) * (0.6 - 0.046) / ((1.2 - 0.014) * (0.6 - 0.014))
                quad("ceiling-lights", inner, ratio)
                if not support:
                    fixtures.append({"id": f"light-{ix:02}-{iz:02}", "position": [round(x, 5), h, round(z, 5)]})
            else:
                quad("ceiling", inner, 0.93 if slot else tint)
            for k in range(4):
                j = (k + 1) % 4
                quad("ceiling", [outer[k], outer[j], inner[j], inner[k]], 0.977)
            for a, b, c, d in [(x0, y0, x1, y0 + pad), (x0, y1 - pad, x1, y1),
                               (x0, y0 + pad, x0 + pad, y1 - pad), (x1 - pad, y0 + pad, x1, y1 - pad)]:
                quad("ceiling", [(a, b, 3), (c, b, 3), (c, d, 3), (a, d, 3)], 0.977)
    objects = {}
    for family, b in buffers.items():
        obj = mesh_object(("Ghost " if support else "Continuous ") + family, b["vertices"], b["faces"], mats[family], 1.2)
        colors = obj.data.color_attributes.new(name="CeilingTint" if family == "ceiling" else "PhysicalPower", type="FLOAT_COLOR", domain="CORNER")
        for face in obj.data.polygons:
            for index in face.loop_indices:
                factor = b["values"][face.index]
                colors.data[index].color = (factor, factor, factor, 1)
                p = obj.data.vertices[obj.data.loops[index].vertex_index].co
                obj.data.uv_layers[0].data[index].uv = (p.x / 1.2, p.y / 1.2)
        obj.data.color_attributes.active_color = colors
        if support:
            obj["bakeSupportOnly"] = True
        objects[family] = obj
    return objects, fixtures


def build(template, metadata_only=False):
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    configure()
    mats = {family: bpy.data.objects["Reference " + family].active_material for family in ("walls", "floor", "ceiling", "ceiling-lights")}
    mats["trim"] = bpy.data.materials["Aged putty vinyl skirting"]
    assert mats["walls"].name == "Wallpaper - replace with supplied material"
    for mat in mats.values():
        mat.use_fake_user = True
    for obj in list(bpy.data.objects):
        if obj.type not in ("CAMERA", "EMPTY"):
            bpy.data.objects.remove(obj, do_unlink=True)
    groups = {family: [] for family in RESOLUTIONS}
    colliders = []
    with bpy.data.libraries.load(str(LAYOUT_SOURCE), link=False) as (available, target):
        target.objects = [n for n in available.objects if n.startswith("Lookdev outlet ") or
                          (template == "open-gallery" and "skirting" not in n.lower()
                           and (n.startswith("Reference ") or n == "Half wall timber cap"))]
    outlets = []
    for obj in target.objects:
        bpy.context.scene.collection.objects.link(obj)
        obj.hide_render = False
        obj.hide_set(False)
    # Library-appended objects have stale matrix_world until the linked scene is evaluated.
    # Measure only after this update; later conversion/export otherwise fixes geometry alone.
    bpy.context.view_layer.update()
    for obj in target.objects:
        if obj.name.startswith("Lookdev outlet "):
            outlets.append(obj)
            groups["details"].append(obj)
        elif "cap" in obj.name:
            groups["details"].append(obj)
        else:
            groups["walls"].append(obj)
            b = exporter.bounds(obj)
            for axis in (0, 2):
                b["min"][axis] -= 0.015
                b["max"][axis] += 0.015
            colliders.append(b)
    outlets.sort(key=lambda o: o.name)
    assert len(outlets) == 3
    for obj in outlets:
        obj.data.calc_loop_triangles()
        assert len(obj.data.loop_triangles) == 6569
    if template != "open-gallery":
        # Reuse the supplied optimized shape, mounted on actual new partition faces.
        locations = [(-5, -5.711, 0.34), (5, 4.289, 0.34), (-10.111, 0, 0.34)] if template == "open-offset" else [(-11.5, -9.111, 0.34), (11, 8.889, 0.34), (-9.111, 12, 0.34)]
        for obj, location in zip(outlets, locations):
            obj.location = location
    groups["floor"].append(floor("Full 36 m carpet", -18, -18, 18, 18, mats["floor"]))
    ceilings, fixtures = make_ceiling(template, mats)
    groups["ceiling"].append(ceilings["ceiling"])
    groups["ceiling-lights"] = [ceilings["ceiling-lights"]]
    # Each row is a straight wall crossing the edge normal, not a perimeter segment.
    inner = {"open-gallery": [10.5, 12.5, 10.8, 13, 11.8, 9.8, 12.2, 10.7],
             "open-offset": [7.6, 11.2, 12, 8.4, 11.4, 12.6, 11, 10.8],
             "open-columns": [8.5, 10, 7.5, 12.4, 11, 10.8, 10.8, 11.5]}[template]
    index = 0
    for axis in (0, 1):
        for sign in (-1, 1):
            for lateral in (-9, 9):
                start, end = sorted((sign * 18, sign * inner[index]))
                rect = (start, lateral - 0.1, end, lateral + 0.1) if axis == 0 else (lateral - 0.1, start, lateral + 0.1, end)
                wall(f"Continuous boundary partition {index}", *rect, 3, mats, groups, colliders)
                index += 1
                start, end = sorted((sign * 18, sign * 25.2))
                rect = (start, lateral - 0.1, end, lateral + 0.1) if axis == 0 else (lateral - 0.1, start, lateral + 0.1, end)
                wall("Ghost continuation", *rect, 3, mats, groups, colliders, True)
    interiors = {
        "open-gallery": [(-12.3, -7, -12.1, -2.6, 3), (10.6, 2.8, 10.8, 8.9, 3), (-9, 11.5, -4.5, 11.7, 1.14)],
        "open-offset": [(-10.1, -3.2, -9.9, 5.6, 3), (-9.9, 5.5, -2.4, 5.7, 3),
                        (-3.8, -10.5, -3.6, -3.4, 3), (-3.6, -3.6, 1.2, -3.4, 1.14),
                        (2.8, 0.2, 3, 8.2, 3), (3, -4.5, 11, -4.3, 3),
                        (8.4, 1.6, 8.6, 5.4, 1.14), (-13, -8.1, -7, -7.9, 3),
                        (3.8, -10, 4, -7, 3)],
        "open-columns": [(-9, 2.5, -3.5, 2.7, 1.14), (2.2, -5.4, 7.8, -5.2, 3),
                         (-12, -1.5, -11.8, 3.8, 3), (10.6, 5.6, 10.8, 9, 3),
                         *[(x - w / 2, z - w / 2, x + w / 2, z + w / 2, 3)
                           for x, z, w in [(-6.8, 6.8, 0.75), (-0.8, 5, 0.9), (5, 3.3, 0.8),
                                           (-4.6, -1.8, 0.8), (1.1, -0.8, 0.65), (7.7, -0.2, 0.85),
                                           (-6, -7.3, 0.75), (-0.2, -8.3, 0.9), (5.4, -10.5, 0.75)]]]}
    for i, rect in enumerate(interiors[template]):
        wall(f"{template} interior {i}", *rect, mats, groups, colliders)
    for rect in [(-25.2, -25.2, -18, 25.2), (18, -25.2, 25.2, 25.2),
                 (-18, -25.2, 18, -18), (-18, 18, 18, 25.2)]:
        floor("Ghost neighboring carpet", *rect, mats["floor"])["bakeSupportOnly"] = True
    make_ceiling(template, mats, True)
    exporter.builder.source.camera_from_view(SPAWN)
    meta = {"id": template, "geometry": template + ".glb", "radiance": [
        {"file": f"{template}-{family}.hdr", "family": family, "flipY": False, "resolution": resolution}
        for family, resolution in RESOLUTIONS.items()], "colliders": colliders, "lights": fixtures,
        "rooms": [{"id": "continuous-floor", "bounds": {"min": [-18, 0, -18], "max": [18, 3, 18]}}],
        "anchors": [{"id": f"corner-{x}-{z}", "roomId": "continuous-floor", "kind": "floor",
                     "position": [x, 0, z], "yaw": 0, "clearance": [1.2, 2, 1.2]}
                    for x in (-16, 16) for z in (-16, 16)], "spawn": dict(SPAWN)}
    validation = validate(meta, groups)
    if metadata_only:
        return groups, meta, validation
    prepared = prepare(template, groups)
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK / (template + ".blend")))
    write_json(WORK / (template + "-metadata.json"), meta)
    write_json(WORK / (template + "-validation.json"), validation)
    return prepared, meta, validation


def validate(meta, groups):
    bpy.context.view_layer.update()
    colliders = meta["colliders"]
    for c in colliders:
        assert c["min"][1] >= -1e-5, ("Collider below floor", c)
        assert all(c["min"][axis] < c["max"][axis] for axis in range(3)), c
    def free(x, z):
        return not any(c["min"][0] - 0.24 < x < c["max"][0] + 0.24 and c["min"][2] - 0.24 < z < c["max"][2] + 0.24 for c in colliders)
    sx, _, sz = meta["spawn"]["position"]
    assert free(sx, sz)
    step = 0.2
    start = (round(sx / step), round(sz / step))
    seen, queue = {start}, deque([start])
    while queue:
        x, z = queue.popleft()
        for cell in ((x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)):
            if cell not in seen and max(abs(cell[0]), abs(cell[1])) <= 90 and free(cell[0] * step, cell[1] * step):
                seen.add(cell)
                queue.append(cell)
    crossings = []
    for face, axis, sign in (("west", 0, -1), ("east", 0, 1), ("north", 1, -1), ("south", 1, 1)):
        for offset in (-14, -6, 0, 6, 14, -13.56, 13.56):
            p = (18 * sign, offset) if axis == 0 else (offset, 18 * sign)
            assert free(*p) and (round(p[0] / step), round(p[1] / step)) in seen, (face, offset)
            crossings.append({"face": face, "offset": offset, "reachable": True})
    all_free = sum(free(x * step, z * step) for x in range(-90, 91) for z in range(-90, 91))
    assert len(seen) == all_free, ("Isolated walkable pocket", len(seen), all_free)
    for x in (-18, 18):
        for z in (-18, 18):
            assert (round(x / step), round(z / step)) in seen
    for anchor in meta["anchors"]:
        if anchor["kind"] != "floor":
            continue
        x, y, z = anchor["position"]
        w, h, d = anchor["clearance"]
        assert (round(x / step), round(z / step)) in seen, ("Unreachable anchor", anchor["id"])
        assert abs(x) + w / 2 <= 18 and abs(z) + d / 2 <= 18, anchor["id"]
        assert not any(c["min"][1] < y + h and c["max"][1] > y and
                       c["min"][0] < x + w / 2 and c["max"][0] > x - w / 2 and
                       c["min"][2] < z + d / 2 and c["max"][2] > z - d / 2 for c in colliders), anchor["id"]
    for family, objects in groups.items():
        for obj in objects:
            bounds = exporter.bounds(obj)
            assert all(-18.00001 <= bounds[k][a] <= 18.00001 for k in ("min", "max") for a in (0, 2)), obj.name
            if family == "floor":
                assert bounds["min"] == [-18, 0, -18] and bounds["max"] == [18, 0, 18]
            if family in ("ceiling", "ceiling-lights"):
                assert 2.99999 <= bounds["min"][1] <= bounds["max"][1] <= 3.00201
    assert any(math.hypot(l["position"][0] - SPAWN["position"][0], l["position"][2] - SPAWN["position"][2]) < 6 for l in meta["lights"])
    log(f"{meta['id']}: all {len(crossings)} broad edge crossings and all {all_free} walkable samples reachable")
    return {"crossings": crossings, "reachableSamples": len(seen), "allFreeSamples": all_free,
            "navigationRadius": 0.24, "navigationGridMeters": step, "fullSquareFloorArea": 1296,
            "floorCornersCovered": True, "ceilingHeights": [3, 3.001, 3.002], "isolatedWalkablePockets": 0,
            "boundaryWallThickness": 0.2, "boundaryColliderHalfWidth": 0.115, "outletTrianglesEach": 6569,
            "floorAnchorsChecked": sum(a["kind"] == "floor" for a in meta["anchors"]),
            "minimumColliderY": min(c["min"][1] for c in colliders),
            "sourceGalleryCompositionRetained": meta["id"] == "open-gallery"}


def prepare(template, groups):
    result = {}
    for family, objects in groups.items():
        exporter.select(objects)
        bpy.ops.object.convert(target="MESH")
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = template + " " + family
        # Normalize transforms so exported POSITION is already in world-scaled meters.
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        obj["surface"] = "ceiling-lights" if family == "ceiling-lights" else template + "-" + family
        obj["surfaceFamily"] = "ceiling" if family == "ceiling-lights" else family
        if family != "ceiling-lights":
            obj["radiance"] = f"{template}-{family}.hdr"
        for uv in list(obj.data.uv_layers):
            if family != "details" and uv.name != "SurfaceUV":
                obj.data.uv_layers.remove(uv)
        if family != "ceiling-lights":
            uv = obj.data.uv_layers.new(name="LightmapUV")
            obj.data.uv_layers.active = uv
            if family in ("floor", "ceiling"):
                for loop in obj.data.loops:
                    p = obj.data.vertices[loop.vertex_index].co
                    uv.data[loop.index].uv = ((p.x + 18) / 36, (p.y + 18) / 36)
            elif family == "details":
                exporter.detail_atlas(obj)
            else:
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=1, correct_aspect=True, scale_to_bounds=True)
                bpy.ops.object.mode_set(mode="OBJECT")
        result[family] = obj
    return result


def render_source(template, reflection=False):
    scene = bpy.context.scene
    exporter.builder.source.camera_from_view(SPAWN)
    scene.render.filepath = str(WORK / (template + "-source-front.png"))
    bpy.ops.render.render(write_still=True)
    if reflection:
        camera = scene.camera
        data = camera.data.copy()
        panorama = bpy.data.objects.new("Continuous reflection camera", data)
        scene.collection.objects.link(panorama)
        panorama.location = camera.location
        panorama.rotation_euler = (math.pi / 2, 0, 0)
        data.type = "PANO"
        data.panorama_type = "EQUIRECTANGULAR"
        scene.camera = panorama
        scene.render.resolution_x, scene.render.resolution_y = 1024, 512
        scene.render.image_settings.file_format = "OPEN_EXR"
        scene.render.image_settings.color_depth = "32"
        scene.render.filepath = str(WORK / "reflection.exr")
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(scene.render.filepath, check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        exporter.save_image(image, "reflection.hdr")
        scene.camera = camera
        bpy.data.objects.remove(panorama, do_unlink=True)
        configure()


def export_glb(template, groups):
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
    bpy.ops.export_scene.gltf(filepath=str(OUT / (template + ".glb")), export_format="GLB", use_selection=True,
        export_materials="NONE", export_extras=True, export_yup=True, export_animations=False,
        export_cameras=False, export_lights=False, export_texcoords=True, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True)
    return verify_glb(template)


def verify_glb(template):
    data = (OUT / (template + ".glb")).read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    binary = data[28 + length:]
    assert not gltf.get("materials")
    def accessor(index):
        a = gltf["accessors"][index]
        view = gltf["bufferViews"][a["bufferView"]]
        width = {"VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        return np.ndarray((a["count"], width), dtype="<f4", buffer=binary,
                          offset=view.get("byteOffset", 0) + a.get("byteOffset", 0),
                          strides=(view.get("byteStride", width * 4), 4))
    stats = {}
    nodes = [n for n in gltf["nodes"] if "mesh" in n]
    assert len(nodes) == 5
    for node in nodes:
        surface = node["extras"]["surface"]
        family = surface.removeprefix(template + "-")
        primitives = gltf["meshes"][node["mesh"]]["primitives"]
        assert len(primitives) == 1
        primitive = primitives[0]
        attrs = primitive["attributes"]
        p = accessor(attrs["POSITION"])
        assert p[:, [0, 2]].min() >= -18.00001 and p[:, [0, 2]].max() <= 18.00001
        assert "TEXCOORD_0" in attrs
        uv_error = None
        if family in ("walls", "floor", "ceiling"):
            assert "TEXCOORD_1" in attrs
        if family in ("floor", "ceiling"):
            uv = accessor(attrs["TEXCOORD_1"])
            expected = (p[:, [0, 2]] + 18) / 36
            uv_error = float(np.abs(uv - expected).max())
            assert uv_error < 1e-6, (surface, uv_error)
            assert np.allclose(p[:, 1], 0) if family == "floor" else np.all((p[:, 1] >= 2.99999) & (p[:, 1] <= 3.00201))
            surface_uv = accessor(attrs["TEXCOORD_0"])
            expected = np.column_stack((p[:, 0] / 1.2, 1 + p[:, 2] / 1.2))
            assert float(np.abs(surface_uv - expected).max()) < 2e-6
        if family == "ceiling":
            assert "COLOR_0" in attrs
        stats[family] = {"vertices": len(p), "triangles": gltf["accessors"][primitive["indices"]]["count"] // 3,
                         "bounds": {"min": p.min(axis=0).tolist(), "max": p.max(axis=0).tolist()}, "planarUVMaxError": uv_error}
    return {"geometryBytes": len(data), "vertices": sum(v["vertices"] for v in stats.values()),
            "triangles": sum(v["triangles"] for v in stats.values()), "drawCalls": 5, "meshes": stats}


def replay_material(obj, descriptor):
    mat = bpy.data.materials.new("Saved continuous maps " + obj["surface"])
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    def texture(file, channel, color=False, repeat=False):
        node = nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(str(OUT / file), check_existing=True)
        node.image.colorspace_settings.name = "sRGB" if color else "Non-Color"
        node.extension = "REPEAT" if repeat else "EXTEND"
        uv = nodes.new("ShaderNodeUVMap")
        uv.uv_map = obj.data.uv_layers[channel].name
        links.new(uv.outputs["UV"], node.inputs["Vector"])
        return node.outputs["Color"]
    def multiply(a, b):
        node = nodes.new("ShaderNodeMixRGB")
        node.blend_type = "MULTIPLY"
        node.inputs[0].default_value = 1
        links.new(a, node.inputs[1])
        links.new(b, node.inputs[2])
        return node.outputs[0]
    color = None
    if descriptor["kind"] == "pbr":
        color = multiply(texture(descriptor["albedo"], 0, True, True), texture(descriptor["lightmap"], 1))
        if descriptor.get("vertexColors"):
            vertex = nodes.new("ShaderNodeVertexColor")
            vertex.layer_name = obj.data.color_attributes[0].name
            color = multiply(color, vertex.outputs["Color"])
    elif descriptor["kind"] == "radiance":
        color = texture(descriptor["radiance"], 0)
    emission = nodes.new("ShaderNodeEmission")
    if color:
        links.new(color, emission.inputs["Color"])
    else:
        emission.inputs["Color"].default_value = (*descriptor["color"], 1)
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(emission.outputs[0], output.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def verify_renders(manifest):
    bpy.ops.wm.open_mainfile(filepath=str(WORK / "open-gallery.blend"))
    configure()
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        if obj.type == "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)
    scene.cycles.samples = 32
    imports = {}
    for meta in manifest["templates"]:
        bpy.ops.import_scene.gltf(filepath=str(OUT / meta["geometry"]))
        objects = [o for o in bpy.context.selected_objects if o.type == "MESH"]
        for obj in objects:
            replay_material(obj, manifest["materials"][obj["surface"]])
            obj.hide_render = True
        imports[meta["id"]] = objects
    copies = []
    for meta in manifest["templates"]:
        for obj in copies:
            bpy.data.objects.remove(obj, do_unlink=True)
        copies = []
        # Fronts also include real neighboring cells; a single exported square has no enclosure.
        for ix in (-1, 0, 1):
            for iz in (-1, 0, 1):
                template = TEMPLATES[(TEMPLATES.index(meta["id"]) + ix + iz) % 3]
                for source in imports[template]:
                    obj = source.copy()
                    scene.collection.objects.link(obj)
                    obj.hide_render = False
                    obj.location += Vector((ix * 36, -iz * 36, 0))
                    obj["overviewCopy"] = True
                    copies.append(obj)
        exporter.builder.source.camera_from_view(meta["spawn"])
        scene.render.filepath = str(WORK / (meta["id"] + "-saved-front.png"))
        bpy.ops.render.render(write_still=True)
    # A true adjacent-template replay, not a short ghost collar masquerading as a room.
    exporter.builder.source.camera_from_view({"position": [14, 1.65, 4], "yaw": -math.pi / 2, "pitch": 0.08})
    scene.render.filepath = str(WORK / "boundary-eye-level.png")
    bpy.ops.render.render(write_still=True)
    for obj in scene.objects:
        if obj.get("overviewCopy") and obj.get("surfaceFamily") == "ceiling":
            obj.hide_render = True
    scene.camera.data.type = "ORTHO"
    scene.camera.data.ortho_scale = 116
    scene.camera.location = (0, 0, 95)
    scene.camera.rotation_euler = (0, 0, 0)
    scene.render.resolution_x, scene.render.resolution_y = 1400, 1400
    scene.render.filepath = str(WORK / "boundary-overview.png")
    bpy.ops.render.render(write_still=True)
    return {"savedMapFronts": [t + "-saved-front.png" for t in TEMPLATES],
            "boundaryRenders": ["boundary-eye-level.png", "boundary-overview.png"],
            "replay": "Actual exported GLBs and saved diffuse E/pi maps, ceiling vertex tints and camera display emitters; specular excluded from this diagnostic."}


def manifest_base():
    materials = {"ceiling-lights": {"kind": "emission", "family": "ceiling", "color": [3.6, 3.55, 2.85]}}
    for template in TEMPLATES:
        for family, prefix in (("walls", "wall"), ("floor", "carpet"), ("ceiling", "ceiling-refined")):
            material_root = "../materials/early" if family in ("walls", "floor") else "../reference"
            materials[template + "-" + family] = {"kind": "pbr", "family": family,
                **{kind: f"{material_root}/{prefix}-{kind}.png" for kind in ("albedo", "normal", "roughness")},
                "lightmap": f"{template}-{family}.hdr", "normalScale": 1, "roughnessFactor": 1,
                **({"uvScale": [0.5 / 0.36, 0.5 / 0.448]} if family == "walls" else {"uvScale": [0.6, 0.6]} if family == "floor" else {}),
                **({"vertexColors": True} if family == "ceiling" else {"sheen": 0.15 if family == "floor" else 0})}
        materials[template + "-details"] = {"kind": "radiance", "family": "details", "radiance": template + "-details.hdr"}
    return {"version": 2, "layout": "continuous", "cellSize": 36, "boundaryPassages": PASSAGES,
        "palette": {"walls": [1.38, 1.48, 0.50], "ceiling": [1.12, 1.18, 0.64], "floor": [1.15, 1.18, 0.68]},
        "templates": [], "materials": materials, "environment": "reflection.hdr", "bake": {
            "sourceSnapshot": str(SOURCE.relative_to(ROOT)), "layoutSource": str(LAYOUT_SOURCE.relative_to(ROOT)),
            "wallMaterial": "Wallpaper - replace with supplied material", "engine": "Cycles", "device": "Metal", "samples": 128,
            "diffuseBounces": 8, "totalBounces": 12, "ghostSupportMeters": 7.2, "rotations": False,
            "camera": {"verticalFovDegrees": 51.4814167, "exposureStops": 1, "viewTransform": "AgX", "look": "Medium High Contrast"},
            "pbrLighting": "DIFFUSE DIRECT+INDIRECT without COLOR: outgoing unit-albedo E/pi; specular-only environment, no environment diffuse.",
            "uv": "PBR UV0=SurfaceUV; UV1=LightmapUV. Details UV0=LightmapUV. glTF V=1-Blender V; all images flipY=false.",
            "planarLightmap": {"padding": 0, "blender": "u=(x+18)/36; v=(y+18)/36", "gltf": "u=(x+18)/36; v=(z+18)/36"},
            "physicalTileMeters": {"walls": 0.5, "floor": 1.2, "ceiling": 1.2},
            "ceiling": {"tileMeters": [1.2, 0.6], "gridWidthMeters": 0.014, "gridHeight": 3,
                "panelHeight": 3.002, "emitterHeight": 3.001, "displayRadiance": [3.6, 3.55, 2.85],
                "physicalStrength": 8 * (1.154 * 0.554) / (1.186 * 0.586), "lightSlot": "ix%3==0 && iz%6==1; Blender Y ascending from -18"},
            "lightingDenoiser": "Blender-bundled OpenImageDenoise RT HDR on lighting-only atlases", "templates": []}}


def verify_boundaries():
    signatures, reports = {}, {}
    for template in TEMPLATES:
        bpy.ops.wm.open_mainfile(filepath=str(WORK / (template + ".blend")))
        scene = bpy.context.scene
        aspect = scene.render.resolution_x / scene.render.resolution_y
        fov = math.degrees(2 * math.atan(scene.camera.data.sensor_width / (2 * scene.camera.data.lens * aspect)))
        assert abs(fov - 51.4814167) < 1e-5
        signature = {}
        ceiling_area = 0
        for family in (*RESOLUTIONS, "ceiling-lights"):
            obj = bpy.data.objects[template + " " + family]
            for axis, label in ((0, "x"), (1, "y")):
                for sign in (-1, 1):
                    polygons = []
                    for face in obj.data.polygons:
                        points = [obj.matrix_world @ obj.data.vertices[i].co for i in face.vertices]
                        # Clip faces to the invariant outer 3.6 m strip, including long stub sides.
                        clipped = []
                        for a, b in zip(points, points[1:] + points[:1]):
                            da, db = sign * a[axis] - 14.4, sign * b[axis] - 14.4
                            if da >= -1e-6:
                                clipped.append(a)
                            if (da < 0) != (db < 0):
                                clipped.append(a.lerp(b, da / (da - db)))
                        if len(clipped) < 3:
                            continue
                        cross = sum(((clipped[i] - clipped[0]).cross(clipped[i + 1] - clipped[0]).length
                                     for i in range(1, len(clipped) - 1)), 0)
                        if cross < 1e-8:
                            continue
                        if family in ("walls", "details"):
                            assert not all(abs(sign * p[axis] - 18) < 1e-6 for p in clipped), (template, family, "Boundary cap")
                        tint = None
                        if family == "ceiling":
                            tint = round(obj.data.color_attributes["CeilingTint"].data[face.loop_start].color[0], 5)
                        polygons.append((tuple(sorted(tuple(round(v, 5) for v in p) for p in clipped)), tint))
                    signature[f"{family}-{label}{sign}"] = sorted(polygons)
            if family in ("ceiling", "ceiling-lights"):
                ceiling_area += sum(face.area * max(0, -face.normal.z) for face in obj.data.polygons)
        assert abs(ceiling_area - 1296) < 0.02, (template, ceiling_area)
        meta = json.loads((WORK / (template + "-metadata.json")).read_text())
        lights = [l for l in meta["lights"] if max(abs(l["position"][0]), abs(l["position"][2])) >= 14.4]
        signature["edgeLights"] = lights
        if signatures:
            baseline = signatures[TEMPLATES[0]]
            for key in signature:
                assert signature[key] == baseline[key], (template, key, "Boundary geometry differs")
        signatures[template] = signature
        reports[template] = {"projectedCeilingArea": ceiling_area, "fullSquareFloorArea": 1296,
            "cameraVerticalFovDegrees": fov, "cameraExposureStops": scene.view_settings.exposure,
            "identicalOuterBandGeometry": True, "edgePoweredFixtures": len(lights),
            "noBoundaryWallOrSkirtingEndcaps": True, "export": verify_glb(template)}
    write_json(WORK / "boundary-validation.json", reports)
    return reports


def repair_metadata():
    manifest_path = OUT / "modules.json"
    original = json.loads(manifest_path.read_text())
    protected = [p for directory in (WORK, OUT) for p in directory.iterdir()
                 if p.suffix in (".blend", ".glb", ".hdr", ".exr", ".png", ".bin")]
    before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    replacements, reports = {}, {}
    for template in TEMPLATES:
        _, rebuilt, _ = build(template, metadata_only=True)
        live = next(t for t in original["templates"] if t["id"] == template)
        candidate = dict(live, colliders=rebuilt["colliders"])
        # Validate coordinator-visible anchors/spawn, not merely freshly generated defaults.
        navigation = validate(candidate, {})
        bpy.ops.import_scene.gltf(filepath=str(OUT / live["geometry"]))
        bpy.context.view_layer.update()
        wall_mesh = next(o for o in bpy.context.selected_objects if o.type == "MESH" and o.get("surface") == template + "-walls")
        points = [wall_mesh.matrix_world @ v.co for v in wall_mesh.data.vertices]
        points = np.asarray([(p.x, p.z, -p.y) for p in points])
        faces = [points[list(face.vertices)] for face in wall_mesh.data.polygons]
        face_min = np.asarray([p.min(axis=0) for p in faces])
        face_max = np.asarray([p.max(axis=0) for p in faces])
        covered = np.zeros(len(faces), dtype=bool)
        errors = []
        for collider in candidate["colliders"]:
            low, high = np.asarray(collider["min"]).copy(), np.asarray(collider["max"]).copy()
            for axis in (0, 2):
                if low[axis] > -18 + 1e-5:
                    low[axis] += 0.015
                if high[axis] < 18 - 1e-5:
                    high[axis] -= 0.015
            # Adjacent walls can share a vertex or edge, so connected-component counting
            # would conflate them. Match complete rendered faces inside each unpadded box.
            matching = np.all(face_min >= low - 2e-5, axis=1) & np.all(face_max <= high + 2e-5, axis=1)
            assert matching.any(), (template, "Collider has no rendered wall faces", collider)
            measured_low, measured_high = face_min[matching].min(axis=0), face_max[matching].max(axis=0)
            error = float(max(np.abs(measured_low - low).max(), np.abs(measured_high - high).max()))
            assert error < 2e-5, (template, "Collider extents differ from rendered faces", collider, error)
            errors.append(error)
            covered |= matching
        assert covered.all(), (template, "Rendered wall faces without colliders", int((~covered).sum()))
        changed = [i for i, (old, new) in enumerate(zip(live["colliders"], candidate["colliders"])) if old != new]
        reports[template] = {"changedColliderIndices": changed, "collidersMatchedToGlbWallFaces": len(errors),
            "renderedWallFacesCovered": len(faces),
            "colliderToGlbAabbMaximumErrorMeters": max(errors), "horizontalSkirtingAllowanceMeters": 0.015,
            "roomsUnchanged": True, "anchorsUnchanged": True, "navigation": navigation}
        replacements[template] = candidate["colliders"]
    # Read again immediately before merging so coordinator additions survive the repair.
    current = json.loads(manifest_path.read_text())
    for meta in current["templates"]:
        if meta["id"] not in replacements:
            continue
        previous = next(t for t in original["templates"] if t["id"] == meta["id"])
        assert all(meta[key] == previous[key] for key in ("colliders", "rooms", "anchors", "spawn")), "Navigation metadata changed concurrently"
        meta["colliders"] = replacements[meta["id"]]
    expected = json.loads(manifest_path.read_text())
    unchanged = json.loads(json.dumps(current))
    for meta in unchanged["templates"]:
        meta["colliders"] = next(t["colliders"] for t in expected["templates"] if t["id"] == meta["id"])
    assert unchanged == expected, "Repair would alter a non-collider manifest field"
    temporary = OUT / "modules.metadata.tmp"
    write_json(temporary, current)
    temporary.replace(manifest_path)
    for template in TEMPLATES:
        path = WORK / (template + "-metadata.json")
        stored = json.loads(path.read_text())
        if stored["colliders"] != replacements[template]:
            stored["colliders"] = replacements[template]
            write_json(path, stored)
        path = WORK / (template + "-validation.json")
        stored = json.loads(path.read_text())
        stored.update(reports[template]["navigation"])
        stored["colliderToGlbAabbMaximumErrorMeters"] = reports[template]["colliderToGlbAabbMaximumErrorMeters"]
        write_json(path, stored)
    assert before == {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    write_json(WORK / "metadata-repair-validation.json", {"templates": reports,
        "onlyManifestColliderFieldsChanged": True, "coordinatorFieldsPreserved": True,
        "unchangedGeneratedFiles": before})
    log("Metadata repaired against all existing GLB wall faces; geometry, bakes and coordinator fields preserved")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", choices=TEMPLATES)
    parser.add_argument("--geometry-only", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--metadata-only", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    before = protected_hashes()
    if args.metadata_only:
        repair_metadata()
        assert before == protected_hashes()
        return
    write_json(WORK / "protected-before.json", before)
    if args.verify_only:
        manifest = json.loads((OUT / "modules.json").read_text())
        verify_boundaries()
        write_json(WORK / "render-validation.json", verify_renders(manifest))
        assert before == protected_hashes()
        return
    for template in ([args.template] if args.template else TEMPLATES):
        start = time.monotonic()
        if args.resume:
            bpy.ops.wm.open_mainfile(filepath=str(WORK / (template + ".blend")))
            configure()
            groups = {family: bpy.data.objects[template + " " + family] for family in (*RESOLUTIONS, "ceiling-lights")}
            meta = json.loads((WORK / (template + "-metadata.json")).read_text())
            validation = json.loads((WORK / (template + "-validation.json")).read_text())
        else:
            groups, meta, validation = build(template)
        if args.geometry_only:
            validation["export"] = export_glb(template, groups)
            write_json(WORK / (template + "-validation.json"), validation)
            continue
        render_source(template, template == "open-gallery")
        atlases = []
        for family, resolution in RESOLUTIONS.items():
            image = exporter.image_target(groups[family], template + " " + family + " bake", resolution)
            log(f"{template}: baking {family} {resolution}px at 128 Metal samples")
            pbr = family != "details"
            bpy.ops.object.bake(type="DIFFUSE" if pbr else "COMBINED",
                pass_filter={"DIRECT", "INDIRECT"} if pbr else {"DIRECT", "INDIRECT", "DIFFUSE", "EMIT"},
                uv_layer="LightmapUV", margin=0 if family in ("floor", "ceiling") else 8, margin_type="EXTEND")
            if pbr:
                exporter.denoise_lightmap(image)
            stat = exporter.save_image(image, f"{template}-{family}.hdr")
            stat.update({"family": family, "gpuHalfFloatRgbaBytes": resolution ** 2 * 8})
            atlases.append(stat)
        bpy.ops.wm.save_as_mainfile(filepath=str(WORK / (template + ".blend")))
        validation["export"] = export_glb(template, groups)
        write_json(WORK / (template + "-validation.json"), validation)
        write_json(WORK / (template + "-bake.json"), {"id": template, "seconds": round(time.monotonic() - start, 2),
            "atlases": atlases, **validation["export"]})
        log(template + " baked and exported")
    if not args.geometry_only and all((WORK / (t + "-bake.json")).exists() for t in TEMPLATES):
        manifest = manifest_base()
        manifest["templates"] = [json.loads((WORK / (t + "-metadata.json")).read_text()) for t in TEMPLATES]
        manifest["bake"]["templates"] = [json.loads((WORK / (t + "-bake.json")).read_text()) for t in TEMPLATES]
        assert (OUT / "reflection.hdr").exists()
        write_json(OUT / "modules.json", manifest)
        subprocess.run(["bun", str(ROOT / "scripts/build_continuous_edges.ts")], cwd=ROOT, check=True)
        verify_boundaries()
        write_json(WORK / "render-validation.json", verify_renders(manifest))
    assert before == protected_hashes(), "Protected source or reference file changed"
    write_json(WORK / "protected-after.json", protected_hashes())
    log("Protected source scenes and every public/reference file remain byte-identical")


if __name__ == "__main__":
    main()
