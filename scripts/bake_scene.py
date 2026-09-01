"""Headless, self-contained Cycles radiance bake for the browser scene.

Run: Blender --background --factory-startup --python scripts/bake_scene.py
Use -- --preview for the source camera only; -- --resume to bake saved source.
All authored dimensions are metres in Blender Z-up; the public schema is Y-up.
"""

import bpy
import json
import math
import random
import sys
import time
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
OUT = ROOT / "public" / "scene"
SAMPLES = 96
WIDTH, DEPTH, HEIGHT = 18.0, 24.0, 3.0
SPAWN = {"position": [1.9, 1.65, -3.15], "yaw": -0.10, "pitch": -0.025}
GROUPS = {"walls": [], "floor": [], "ceiling": [], "details": []}
RESOLUTIONS = {"walls": 4096, "floor": 4096, "ceiling": 2048, "details": 2048}
COLLIDERS = []
random.seed(47)
START = time.monotonic()


def log(message):
    print(f"PIPELINE {time.monotonic() - START:.1f}s {message}", flush=True)


def rgb(hex_color):
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels) + (1,)


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfDiffuse")
    shader.inputs["Color"].default_value = rgb(color)
    shader.inputs["Roughness"].default_value = 0.45
    mat.node_tree.links.new(shader.outputs[0], out.inputs["Surface"])
    return mat, shader


def node(mat, kind, **values):
    n = mat.node_tree.nodes.new(kind)
    for key, value in values.items():
        n.inputs[key].default_value = value
    return n


def wire(mat, output, input_socket):
    mat.node_tree.links.new(output, input_socket)


def math_node(mat, operation, a, b=None):
    n = node(mat, "ShaderNodeMath")
    n.operation = operation
    for index, value in enumerate((a, b)):
        if value is None:
            continue
        if isinstance(value, (int, float)):
            n.inputs[index].default_value = value
        else:
            wire(mat, value, n.inputs[index])
    return n.outputs[0]


def ramp(mat, fac, stops):
    n = node(mat, "ShaderNodeValToRGB")
    for e in list(n.color_ramp.elements)[2:]:
        n.color_ramp.elements.remove(e)
    for index, (pos, color) in enumerate(stops):
        e = n.color_ramp.elements[index] if index < 2 else n.color_ramp.elements.new(pos)
        e.position = pos
        e.color = rgb(color)
    wire(mat, fac, n.inputs[0])
    return n.outputs[0]


def noise(mat, position, scale, detail=2, roughness=0.6):
    n = node(mat, "ShaderNodeTexNoise", Scale=scale, Detail=detail, Roughness=roughness)
    wire(mat, position, n.inputs["Vector"])
    return n.outputs["Fac"]


def make_materials():
    wall, shader = material("Cream chevron paper - linen relief", "c9c3a9")
    pos = node(wall, "ShaderNodeNewGeometry").outputs["Position"]
    xyz = node(wall, "ShaderNodeSeparateXYZ")
    wire(wall, pos, xyz.inputs[0])
    horizontal = math_node(wall, "ADD", xyz.outputs[0], xyz.outputs[1])
    tri = math_node(wall, "MULTIPLY", horizontal, 1 / 0.092)
    tri = math_node(wall, "FRACT", tri)
    tri = math_node(wall, "SUBTRACT", tri, 0.5)
    tri = math_node(wall, "ABSOLUTE", tri)
    phase = math_node(wall, "MULTIPLY", xyz.outputs[2], 1 / 0.056)
    phase = math_node(wall, "ADD", phase, math_node(wall, "MULTIPLY", tri, 1.3))
    wave = math_node(wall, "SINE", math_node(wall, "MULTIPLY", phase, math.tau))
    pattern = math_node(wall, "POWER", math_node(wall, "MAXIMUM", wave, 0), 5)
    aging = noise(wall, pos, 1.8, 3)
    fac = math_node(wall, "ADD", math_node(wall, "MULTIPLY", pattern, 0.14), math_node(wall, "MULTIPLY", aging, 0.55))
    color = ramp(wall, fac, [(0, "d0cbb5"), (1, "b8ad8c")])
    wire(wall, color, shader.inputs["Color"])
    bump = node(wall, "ShaderNodeBump", Strength=0.28, Distance=0.0006)
    relief = math_node(wall, "ADD", pattern, math_node(wall, "MULTIPLY", noise(wall, pos, 220), 0.3))
    wire(wall, relief, bump.inputs["Height"])
    wire(wall, bump.outputs[0], shader.inputs["Normal"])

    carpet, shader = material("Oatmeal loop-pile carpet", "999581")
    pos = node(carpet, "ShaderNodeNewGeometry").outputs["Position"]
    fine = noise(carpet, pos, 125, 2)
    medium = noise(carpet, pos, 7.5, 3)
    broad = noise(carpet, pos, 0.38, 3)
    fac = math_node(carpet, "ADD", math_node(carpet, "MULTIPLY", fine, 0.64), math_node(carpet, "MULTIPLY", medium, 0.24))
    fac = math_node(carpet, "ADD", fac, math_node(carpet, "MULTIPLY", broad, 0.24))
    wire(carpet, ramp(carpet, fac, [(0.12, "706e59"), (0.9, "b4ae96")]), shader.inputs["Color"])
    bump = node(carpet, "ShaderNodeBump", Strength=0.45, Distance=0.003)
    wire(carpet, fine, bump.inputs["Height"])
    wire(carpet, bump.outputs[0], shader.inputs["Normal"])

    tile, shader = material("Warm ivory mineral acoustic tile", "c7c5b8")
    pos = node(tile, "ShaderNodeNewGeometry").outputs["Position"]
    fine = noise(tile, pos, 100, 2)
    broad = noise(tile, pos, 1.5, 2)
    fac = math_node(tile, "ADD", math_node(tile, "MULTIPLY", fine, 0.65), math_node(tile, "MULTIPLY", broad, 0.3))
    wire(tile, ramp(tile, fac, [(0, "adab9c"), (1, "d5d2c5")]), shader.inputs["Color"])
    bump = node(tile, "ShaderNodeBump", Strength=0.25, Distance=0.0012)
    wire(tile, fine, bump.inputs["Height"])
    wire(tile, bump.outputs[0], shader.inputs["Normal"])

    trim, _ = material("Aged putty vinyl skirting", "8c8873")
    rail, _ = material("Warm white enamel T-grid", "c3c1b3")
    outlet, _ = material("Ivory wall plates", "bdb9a2")
    dark, _ = material("Socket apertures", "514f41")
    lamp = bpy.data.materials.new("Fluorescent prismatic diffuser - 3500K")
    lamp.use_nodes = True
    lamp.node_tree.nodes.clear()
    out = node(lamp, "ShaderNodeOutputMaterial")
    emit = node(lamp, "ShaderNodeEmission", Color=(1, 0.965, 0.88, 1), Strength=8.0)
    pos = node(lamp, "ShaderNodeNewGeometry").outputs["Position"]
    n = noise(lamp, pos, 155, 1)
    power = math_node(lamp, "ADD", math_node(lamp, "MULTIPLY", n, 0.7), 7.4)
    wire(lamp, power, emit.inputs["Strength"])
    wire(lamp, emit.outputs[0], out.inputs["Surface"])
    off, _ = material("Unpowered fluorescent diffuser", "a09f92")
    return wall, carpet, tile, trim, rail, outlet, dark, lamp, off


def cube(name, center, dimensions, mat, family, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Subtle manufactured edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    GROUPS[family].append(obj)
    return obj


def wall_box(name, x, y, w, d, mat, trim, height=HEIGHT):
    obj = cube(name, (x, y, height / 2), (w, d, height), mat, "walls", 0.009)
    COLLIDERS.append({"min": [x - w / 2, 0, -y - d / 2], "max": [x + w / 2, height, -y + d / 2]})
    # Thin independent skirting retains the small top lip instead of a painted stripe.
    for sx in (-1, 1):
        cube(name + " skirting side", (x + sx * (w / 2 + 0.006), y, 0.052), (0.018, d + 0.02, 0.104), trim, "details", 0.004)
    for sy in (-1, 1):
        cube(name + " skirting end", (x, y + sy * (d / 2 + 0.006), 0.052), (w, 0.018, 0.104), trim, "details", 0.004)
    return obj


def mesh_quads(name, vertices, faces, mats, indices, family, planar=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    for mat in mats:
        mesh.materials.append(mat)
    for face, index in zip(mesh.polygons, indices):
        face.material_index = index
    if planar:
        uv = mesh.uv_layers.new(name="RadianceUV")
        for face in mesh.polygons:
            for loop_index in face.loop_indices:
                co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
                uv.data[loop_index].uv = (0.006 + co.x / WIDTH * 0.988, 0.006 + co.y / DEPTH * 0.988)
    GROUPS[family].append(obj)
    return obj


def camera_from_view(view):
    cam = bpy.context.scene.camera
    x, y, z = view["position"]
    cam.location = (x, -z, y)
    yaw, pitch = view["yaw"], view["pitch"]
    direction = Vector((-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    wall, carpet, tile, trim, rail, outlet, dark, lamp, off = make_materials()
    for name, x, y, w, d in [
        ("West perimeter", -0.14, 12, 0.28, 24.56),
        ("East perimeter", 18.14, 12, 0.28, 24.56),
        ("Entry perimeter", 9, -0.14, 18, 0.28),
        ("Far perimeter", 9, 24.14, 18, 0.28),
        ("Near wallpaper return", 4.6, 3.5, 0.32, 7),
        ("First offset partition", 5.9, 7.0, 2.9, 0.32),
        ("Inner gallery wall", 9.4, 11.6, 0.32, 16.8),
        ("Gallery crosswall", 13.5, 7.0, 5.3, 0.32),
        ("East side return", 15.95, 12.0, 0.32, 9.8),
        ("Rear room partition", 12.6, 19.6, 6.1, 0.32),
        ("Back west return", 3.7, 21.1, 7.4, 0.32),
        ("Left gallery wing", 1.4, 13.0, 2.8, 0.32),
        ("Left rear wing", 1.6, 17.2, 3.2, 0.32),
        ("Foreground column", 0.65, 5.8, 0.85, 0.85),
        ("Gallery column A", 5.8, 11.7, 0.72, 0.72),
        ("Gallery column B", 5.8, 16.5, 0.72, 0.72),
        ("East room column", 12.3, 12.8, 0.7, 0.7),
    ]:
        wall_box(name, x, y, w, d, wall, trim)

    mesh_quads("Continuous carpet", [(0, 0, 0), (18, 0, 0), (18, 24, 0), (0, 24, 0)], [(0, 1, 2, 3)], [carpet], [0], "floor", True)
    # Each tile has an inset surface, an angled edge and a real 24 mm grid rail.
    vertices, faces, indices = [], [], []
    lamp_count = 0
    def quad(coords, index):
        base = len(vertices)
        vertices.extend(coords)
        faces.append(tuple(range(base + 3, base - 1, -1)))
        indices.append(index)

    for ix in range(15):
        for iy in range(40):
            x0, x1 = ix * 1.2, (ix + 1) * 1.2
            y0, y1 = iy * 0.6, (iy + 1) * 0.6
            light_slot = ix % 3 == 1 and iy % 6 == 3
            circuit_off = (ix >= 9 and 18 <= iy < 28) or (ix < 6 and 23 <= iy < 29)
            on = light_slot and not circuit_off
            if on:
                lamp_count += 1
            index = 2 if on else 3 if light_slot else 0
            z = 2.995 if light_slot else 3.012
            pad, edge = 0.012, 0.023
            quad([(x0 + edge, y0 + edge, z), (x1 - edge, y0 + edge, z), (x1 - edge, y1 - edge, z), (x0 + edge, y1 - edge, z)], index)
            inner = [(x0 + edge, y0 + edge, z), (x1 - edge, y0 + edge, z), (x1 - edge, y1 - edge, z), (x0 + edge, y1 - edge, z)]
            outer = [(x0 + pad, y0 + pad, 2.983), (x1 - pad, y0 + pad, 2.983), (x1 - pad, y1 - pad, 2.983), (x0 + pad, y1 - pad, 2.983)]
            for k in range(4):
                j = (k + 1) % 4
                quad([outer[k], outer[j], inner[j], inner[k]], 1 if light_slot else 0)
            quad([(x0, y0, 2.978), (x1, y0, 2.978), (x1, y0 + pad, 2.978), (x0, y0 + pad, 2.978)], 1)
            quad([(x0, y1 - pad, 2.978), (x1, y1 - pad, 2.978), (x1, y1, 2.978), (x0, y1, 2.978)], 1)
            quad([(x0, y0 + pad, 2.978), (x0 + pad, y0 + pad, 2.978), (x0 + pad, y1 - pad, 2.978), (x0, y1 - pad, 2.978)], 1)
            quad([(x1 - pad, y0 + pad, 2.978), (x1, y0 + pad, 2.978), (x1, y1 - pad, 2.978), (x1 - pad, y1 - pad, 2.978)], 1)
    mesh_quads("Recessed ceiling and fluorescent circuits", vertices, faces, [tile, rail, lamp, off], indices, "ceiling", True)

    for x, y, facing in [(4.428, 4.8, -1), (4.428, 1.4, -1), (9.225, 14.4, -1), (9.574, 10.2, 1), (0.011, 9.8, 1)]:
        cube("Duplex outlet plate", (x, y, 0.31), (0.012, 0.072, 0.116), outlet, "details", 0.003)
        for z in (0.287, 0.333):
            for dy in (-0.011, 0.011):
                cube("Outlet slot", (x + facing * 0.007, y + dy, z), (0.002, 0.003, 0.015), dark, "details")

    # A few framed return-air grilles break the sterile procedural repetition.
    for x, y in [(3.0, 9.9), (13.8, 4.5), (7.8, 20.1)]:
        cube("Return air frame", (x, y, 2.965), (0.48, 0.42, 0.018), rail, "details", 0.003)
        for j in range(12):
            cube("Return air louvre", (x, y - 0.172 + j * 0.031, 2.952), (0.41, 0.013, 0.006), dark, "details", 0.002)

    # Bake each family as one mesh, keeping UV islands globally nonoverlapping.
    for family, objects in GROUPS.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = family
        obj["radiance"] = f"radiance-{list(GROUPS).index(family)}.hdr"
        obj["surfaceFamily"] = family
        if family in ("walls", "details"):
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.008, area_weight=1.0, correct_aspect=True, scale_to_bounds=True)
            bpy.ops.object.mode_set(mode="OBJECT")
        obj.data.uv_layers.active.name = "RadianceUV"

    camera = bpy.data.cameras.new("Spawn reference camera")
    camera.lens = 23.5
    camera.sensor_width = 36
    camera.clip_start = 0.03
    cam = bpy.data.objects.new(camera.name, camera)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    camera_from_view(SPAWN)
    log(f"Built {lamp_count} powered fluorescent panels and {len(COLLIDERS)} colliders")


def configure():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "METAL"
    scene.cycles.device = "GPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 6
    scene.cycles.glossy_bounces = 0
    scene.cycles.transmission_bounces = 0
    scene.cycles.use_denoising = True
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.015
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 1.0
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_diffuse = True
    scene.render.bake.use_pass_color = True
    scene.render.bake.use_pass_glossy = False
    scene.render.bake.use_pass_transmission = False
    scene.render.bake.use_pass_emit = True
    log("Cycles Metal configured: 96 samples, six diffuse bounces, black environment")


def save_metadata(bake_seconds=0, atlas_stats=None):
    metadata = {
        "name": "The vacant floor",
        "version": 1,
        "geometry": "environment.glb",
        "radiance": [{"file": f"radiance-{i}.hdr", "flipY": False, "resolution": RESOLUTIONS[name], "family": name} for i, name in enumerate(GROUPS)],
        "spawn": SPAWN,
        "viewpoints": [
            {"name": "Entry gallery", **SPAWN},
            {"name": "The long room", "position": [3.8, 1.65, -9.4], "yaw": -0.22, "pitch": -0.01},
            {"name": "Quiet circuit", "position": [11.4, 1.65, -9.4], "yaw": -0.42, "pitch": -0.02},
            {"name": "Rear passage", "position": [8.0, 1.65, -22.2], "yaw": -1.36, "pitch": -0.01},
        ],
        "colliders": COLLIDERS,
        "bounds": {"min": [0, 0, -24], "max": [18, 3.03, 0]},
        "bake": {
            "engine": "Cycles", "device": "Metal", "samples": SAMPLES,
            "resolution": 4096, "diffuseBounces": 6, "totalBounces": 8,
            "pass": "COMBINED: diffuse color, direct, indirect and emission; no glossy/transmission",
            "colorSpace": "Linear Rec.709 / scene-linear RGBE; no view transform baked",
            "uv": "TEXCOORD_0; glTF V=1-Blender V; RGBELoader flipY=false",
            "coordinateSystem": "glTF Y-up; Blender (x,y,z) maps to (x,z,-y)",
            "camera": {"verticalFovDegrees": math.degrees(2 * math.atan((36 / (1280 / 720)) / (2 * 23.5))), "exposureStops": 1.0, "viewTransform": "AgX", "look": "Medium High Contrast"},
            "seconds": round(bake_seconds, 2), "atlases": atlas_stats or [],
        },
    }
    (OUT / "scene.json").write_text(json.dumps(metadata, indent=2) + "\n")


def bake():
    import numpy as np
    start = time.monotonic()
    stats = []
    for index, family in enumerate(GROUPS):
        obj = bpy.data.objects[family]
        resolution = RESOLUTIONS[family]
        image = bpy.data.images.new(f"Radiance {family}", width=resolution, height=resolution, alpha=False, float_buffer=True)
        image.colorspace_settings.name = "Non-Color"
        for slot in obj.material_slots:
            mat = slot.material
            tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
            tex.name = "Radiance bake destination"
            tex.image = image
            mat.node_tree.nodes.active = tex
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        log(f"Bake starting {family} {resolution}x{resolution}")
        bpy.ops.object.bake(type="COMBINED", pass_filter={"DIRECT", "INDIRECT", "DIFFUSE", "EMIT"}, margin=12, margin_type="EXTEND", use_clear=True, uv_layer="RadianceUV")
        image.filepath_raw = str(OUT / f"radiance-{index}.hdr")
        image.file_format = "HDR"
        image.save()
        values = np.empty(resolution * resolution * 4, dtype=np.float32)
        image.pixels.foreach_get(values)
        values = values.reshape((-1, 4))[:, :3]
        lit = values[np.max(values, axis=1) > 0.00001]
        stats.append({"family": family, "resolution": resolution, "maximum": float(values.max()), "meanNonBlack": [float(x) for x in lit.mean(axis=0)], "nonBlackPixels": len(lit)})
        log(f"Saved {image.filepath_raw}: {stats[-1]}")
    bake_seconds = time.monotonic() - start
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "backrooms.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for name in GROUPS:
        bpy.data.objects[name].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects["walls"]
    bpy.ops.export_scene.gltf(filepath=str(OUT / "environment.glb"), export_format="GLB", use_selection=True, export_materials="NONE", export_extras=True, export_yup=True, export_animations=False, export_cameras=False, export_lights=False, export_texcoords=True)
    save_metadata(bake_seconds, stats)
    log(f"COMPLETE bake {bake_seconds:.1f}s")
    # Validate the delivered UV/radiance appearance without a second light solve.
    for index, family in enumerate(GROUPS):
        obj = bpy.data.objects[family]
        mat = bpy.data.materials.new(f"Verification radiance {family}")
        mat.use_nodes = True
        mat.node_tree.nodes.clear()
        tex = node(mat, "ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(OUT / f"radiance-{index}.hdr"), check_existing=False)
        tex.image.colorspace_settings.name = "Non-Color"
        emit = node(mat, "ShaderNodeEmission", Strength=1)
        out = node(mat, "ShaderNodeOutputMaterial")
        wire(mat, tex.outputs["Color"], emit.inputs["Color"])
        wire(mat, emit.outputs[0], out.inputs["Surface"])
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for face in obj.data.polygons:
            face.material_index = 0
    bpy.context.scene.cycles.samples = 32
    bpy.context.scene.render.filepath = str(ASSETS / "baked-reference.png")
    bpy.ops.render.render(write_still=True)
    log("Reloaded-HDR radiance reference rendered")


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    if "--resume" in sys.argv:
        bpy.ops.wm.open_mainfile(filepath=str(ASSETS / "backrooms.blend"))
        COLLIDERS.extend(json.loads((OUT / "scene.json").read_text())["colliders"])
    else:
        build()
    configure()
    if "--resume" not in sys.argv:
        save_metadata()
        bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / "backrooms.blend"))
        bpy.context.scene.render.filepath = str(ASSETS / "reference.png")
        bpy.ops.render.render(write_still=True)
        log("Spawn reference rendered")
    if "--preview" not in sys.argv:
        bake()


if __name__ == "__main__":
    main()
