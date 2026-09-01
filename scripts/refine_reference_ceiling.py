"""Ceiling-only upgrade in an isolated headless Blender process.

Blender --background --factory-startup --python-exit-code 1 \
  --python scripts/refine_reference_ceiling.py
Use -- --verify-only to replay the exported maps without rebaking.
Use -- --validate-only to check saved geometry and UVs without rendering.
Use -- --native-preview to update camera-only emission and render the checkpoint.
Never saves over the source scenes, approved maps, or public manifest.
"""

import copy
import hashlib
import importlib.util
import json
import math
import struct
import sys
import time
from pathlib import Path

import bpy
import numpy as np

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public/reference"
WORK = ROOT / "assets/lookdev/ceiling-update"
SOURCE = ROOT / "assets/lookdev/reference-export.blend"
GEOMETRY = "reference-ceiling-refined.glb"
PREFIX = "ceiling-refined"
SPEC = importlib.util.spec_from_file_location("reference_export", ROOT / "scripts/export_reference.py")
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)
PROTECTED = [
    *[OUT / f"{family}-{kind}.png" for family in ("wall", "carpet")
      for kind in ("albedo", "normal", "roughness")],
    *[OUT / filename for filename in ("walls-light.hdr", "floor-light.hdr", "details-radiance.hdr",
                                      "reflection.hdr", "seam-lighting.bin", "reference.glb", "modules.json")],
    SOURCE, ROOT / "assets/lookdev/reference-final-retained-wallpaper.blend",
]


def hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in PROTECTED}


def write_report(name, report):
    (WORK / name).write_text(json.dumps(report, indent=2) + "\n")


def read_glb(path):
    data = path.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + size]), data[28 + size:]


def glb_fingerprints(path):
    gltf, binary = read_glb(path)

    def accessor_hash(index):
        accessor = gltf["accessors"][index]
        view = gltf["bufferViews"][accessor["bufferView"]]
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        width *= {5121: 1, 5123: 2, 5125: 4, 5126: 4}[accessor["componentType"]]
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", width)
        values = b"".join(binary[i:i + width] for i in range(start, start + stride * accessor["count"], stride))
        return {"sha256": hashlib.sha256(values).hexdigest(), "count": accessor["count"],
                "type": accessor["type"], "componentType": accessor["componentType"]}

    return {node["extras"]["surface"]: {
        "extras": node["extras"],
        "transform": {k: node[k] for k in ("matrix", "translation", "rotation", "scale") if k in node},
        "primitives": [{"attributes": {k: accessor_hash(v) for k, v in p["attributes"].items()},
                        "indices": accessor_hash(p["indices"])} for p in gltf["meshes"][node["mesh"]]["primitives"]],
    } for node in gltf["nodes"] if "mesh" in node}


def refined_material():
    mat = bpy.data.materials["Lookdev - refined acoustic tile"].copy()
    mat.name = "Ceiling update - quiet ivory mineral panel"
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    # The old broad 42-67% color ramp was visible mottling, not acoustic pores.
    ramp = nodes["Color Ramp"]
    ramp.color_ramp.elements[0].color = (0.635, 0.621, 0.564, 1)
    ramp.color_ramp.elements[1].color = (0.661, 0.647, 0.590, 1)
    noise = nodes["Noise Texture"]
    noise.inputs["Scale"].default_value = 300
    noise.inputs["Detail"].default_value = 2
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nodes["Bump"].inputs["Strength"].default_value = 0.18
    nodes["Bump"].inputs["Distance"].default_value = 0.00045
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "SurfaceUV"
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    scale.inputs["Scale"].default_value = 1.2
    links.new(uv.outputs["UV"], scale.inputs[0])
    links.new(scale.outputs["Vector"], noise.inputs["Vector"])
    mat["physical_tile_m"] = 1.2
    return mat


def camera_emission_preview(mat):
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL")
    if nodes.get("Camera-only panel radiance"):
        return
    physical = output.inputs["Surface"].links[0].from_socket
    path = nodes.new("ShaderNodeLightPath")
    display = nodes.new("ShaderNodeEmission")
    display.name = "Camera-only panel radiance"
    display.inputs["Color"].default_value = (3.6, 3.55, 2.85, 1)
    display.inputs["Strength"].default_value = 1
    mix = nodes.new("ShaderNodeMixShader")
    mix.name = "Camera display versus unchanged light transport"
    links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(physical, mix.inputs[1])
    links.new(display.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs["Surface"])


def bake_tile(mat):
    mesh = bpy.data.meshes.new("Ceiling reusable tile bake mesh")
    mesh.from_pydata([(0, 0, 0), (1.2, 0, 0), (1.2, 1.2, 0), (0, 1.2, 0)], [], [(3, 2, 1, 0)])
    plane = bpy.data.objects.new("Ceiling reusable tile bake", mesh)
    bpy.context.scene.collection.objects.link(plane)
    plane.data.materials.append(mat)
    uv = mesh.uv_layers.new(name="SurfaceUV")
    for loop in mesh.loops:
        co = mesh.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (co.x / 1.2, co.y / 1.2)
    hidden = [(o, o.hide_render) for o in bpy.context.scene.objects if o != plane]
    for obj, _ in hidden:
        obj.hide_render = True
    stats = []
    for kind, bake_type, color in [("albedo", "DIFFUSE", True), ("normal", "NORMAL", False), ("roughness", "ROUGHNESS", False)]:
        image = exporter.image_target(plane, PREFIX + " " + kind, 1024, color)
        exporter.log("Ceiling-only tile bake: " + kind)
        kwargs = {"pass_filter": {"COLOR"}} if color else {}
        bpy.ops.object.bake(type=bake_type, uv_layer="SurfaceUV", normal_space="TANGENT", margin=0, **kwargs)
        stats.append(exporter.save_image(image, f"{PREFIX}-{kind}.png"))
    bpy.data.objects.remove(plane, do_unlink=True)
    for obj, value in hidden:
        obj.hide_render = value
    # One vertex color material covers mineral tiles, restrained rails and off diffusers.
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    vertex = nodes.new("ShaderNodeVertexColor")
    vertex.layer_name = "CeilingTint"
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    links.new(nodes["Color Ramp"].outputs["Color"], multiply.inputs[1])
    links.new(vertex.outputs["Color"], multiply.inputs[2])
    links.new(multiply.outputs[0], nodes["Principled BSDF"].inputs["Base Color"])
    return stats


def replace_ceiling(mat, lights):
    old = bpy.data.objects["Reference ceiling"]
    slots = {i: ("emitting" if any(n.type == "EMISSION" for n in m.node_tree.nodes)
                 else "tile" if i == 0 else "off" if i == 3 else "grid")
             for i, m in enumerate(old.data.materials)}
    cells = []
    for face in old.data.polygons:
        if slots[face.material_index] == "grid" or face.normal.z > -0.999:
            continue
        points = [old.matrix_world @ old.data.vertices[i].co for i in face.vertices]
        assert len(points) == 4
        cells.append({"x0": round(min(p.x for p in points) - 0.023, 6),
                      "x1": round(max(p.x for p in points) + 0.023, 6),
                      "y0": round(min(p.y for p in points) - 0.023, 6),
                      "y1": round(max(p.y for p in points) + 0.023, 6),
                      "main": points[0].z > 2.8, "kind": slots[face.material_index], "area": face.area})
    assert len(cells) == 864
    assert sum(c["kind"] == "emitting" for c in cells) == 47
    rng = np.random.default_rng(3847)
    buffers = {name: {"vertices": [], "faces": [], "tints": [], "power": []} for name in ("ceiling", "ceiling-lights")}
    fixtures = []

    def quad(name, points, tint=1.0, power=1.0):
        b = buffers[name]
        start = len(b["vertices"])
        b["vertices"].extend(points)
        b["faces"].append(tuple(range(start + 3, start - 1, -1)))
        b["tints"].append(tint)
        b["power"].append(power)

    for cell in cells:
        x0, x1, y0, y1 = (cell[k] for k in ("x0", "x1", "y0", "y1"))
        grid = 3.000 if cell["main"] else 2.400
        height = grid + (0.001 if cell["kind"] == "emitting" else 0.002)
        pad = 0.007
        inner = [(x0 + pad, y0 + pad, height), (x1 - pad, y0 + pad, height),
                 (x1 - pad, y1 - pad, height), (x0 + pad, y1 - pad, height)]
        outer = [(x, y, grid) for x, y, _ in inner]
        tint = float(rng.uniform(0.982, 1.0)) if cell["kind"] == "tile" else 0.93
        if cell["kind"] == "emitting":
            area = (x1 - x0 - 2 * pad) * (y1 - y0 - 2 * pad)
            ratio = cell["area"] / area
            quad("ceiling-lights", inner, power=ratio)
            center = [round((x0 + x1) / 2, 5), height, round(-(y0 + y1) / 2, 5)]
            match = next(l for l in lights if abs(l["position"][0] - center[0]) < 1e-4
                         and abs(l["position"][2] - center[2]) < 1e-4)
            fixtures.append({"id": match["id"], "position": center,
                             "oldArea": cell["area"], "area": area, "physicalStrength": 8.0 * ratio})
        else:
            quad("ceiling", inner, tint)
        # Vertical 1-2 mm returns, never the old 34 mm diagonal coffer bevel.
        for k in range(4):
            j = (k + 1) % 4
            quad("ceiling", [outer[k], outer[j], inner[j], inner[k]], 0.977)
        for a, b, c, d in [(x0, y0, x1, y0 + pad), (x0, y1 - pad, x1, y1),
                           (x0, y0 + pad, x0 + pad, y1 - pad), (x1 - pad, y0 + pad, x1, y1 - pad)]:
            quad("ceiling", [(a, b, grid), (c, b, grid), (c, d, grid), (a, d, grid)], 0.977)
    emitting_mat = old.data.materials[2].copy()
    emitting_mat.name = "Ceiling update - area-compensated physical emitter"
    nodes, links = emitting_mat.node_tree.nodes, emitting_mat.node_tree.links
    emit = next(n for n in nodes if n.type == "EMISSION")
    # Keep the source color/power but remove prismatic modulation from the flat face.
    for link in list(emit.inputs["Color"].links) + list(emit.inputs["Strength"].links):
        links.remove(link)
    emit.inputs["Color"].default_value = (1, 0.965, 0.88, 1)
    vertex = nodes.new("ShaderNodeVertexColor")
    vertex.layer_name = "PhysicalPower"
    multiply = nodes.new("ShaderNodeMath")
    multiply.operation = "MULTIPLY"
    multiply.inputs[1].default_value = 8.0
    links.new(vertex.outputs["Color"], multiply.inputs[0])
    links.new(multiply.outputs[0], emit.inputs["Strength"])
    camera_emission_preview(emitting_mat)
    bpy.data.objects.remove(old, do_unlink=True)
    result = {}
    for name, b in buffers.items():
        mesh = bpy.data.meshes.new("Refined " + name)
        mesh.from_pydata(b["vertices"], [], b["faces"])
        mesh.update()
        obj = bpy.data.objects.new("Reference " + name, mesh)
        bpy.data.collections["Ceiling and lighting"].objects.link(obj)
        obj["surface"], obj["surfaceFamily"] = name, "ceiling"
        obj.data.materials.append(mat if name == "ceiling" else emitting_mat)
        if name == "ceiling":
            obj["radiance"] = PREFIX + "-light.hdr"
        uv = mesh.uv_layers.new(name="SurfaceUV")
        light_uv = mesh.uv_layers.new(name="LightmapUV") if name == "ceiling" else None
        colors = mesh.color_attributes.new(name="CeilingTint" if name == "ceiling" else "PhysicalPower", type="FLOAT_COLOR", domain="CORNER")
        for face in mesh.polygons:
            factor = b["tints" if name == "ceiling" else "power"][face.index]
            for index in face.loop_indices:
                p = mesh.vertices[mesh.loops[index].vertex_index].co
                uv.data[index].uv = (p.x / 1.2, p.y / 1.2)
                if light_uv:
                    light_uv.data[index].uv = (0.004 + (p.x + 16) / 32 * 0.992, 0.004 + (p.y + 16) / 32 * 0.992)
                colors.data[index].color = (factor, factor, factor, 1)
        mesh.uv_layers.active_index = 0
        mesh.uv_layers[0].active_render = True
        mesh.color_attributes.active_color = colors
        result[name] = obj
    fixtures.sort(key=lambda f: f["id"])
    assert [f["id"] for f in fixtures] == [l["id"] for l in lights]
    return result, {"cells": len(cells), "mainCells": sum(c["main"] for c in cells),
                    "poweredPanels": len(fixtures), "mainPoweredPanels": sum(f["position"][1] > 2.8 for f in fixtures),
                    "unpoweredPanels": sum(c["kind"] == "off" for c in cells), "fixtures": fixtures,
                    "gridWidthMeters": 0.014, "mainTileMeters": [1.2, 0.6], "tileTextureMeters": 1.2,
                    "mainHeights": {"grid": 3.0, "tile": 3.002, "emitter": 3.001},
                    "corridorHeights": {"grid": 2.4, "tile": 2.402, "emitter": 2.401},
                    "physicalEmissionBaseStrength": 8.0, "displayRadiance": [3.6, 3.55, 2.85],
                    "tileTintRange": [0.982, 1.0], "gridTint": 0.977, "offDiffuserTint": 0.93}


def validate_checkpoint(manifest):
    ceiling = bpy.data.objects["Reference ceiling"]
    emitters = bpy.data.objects["Reference ceiling-lights"]
    assert len(emitters.data.polygons) == 47
    measured = {"main": {"panels": 0, "emitters": 0}, "corridor": {"panels": 0, "emitters": 0}}
    uv_errors = []
    grid_rectangles = {"main": [], "corridor": []}
    for obj in (ceiling, emitters):
        for face in obj.data.polygons:
            points = [obj.matrix_world @ obj.data.vertices[i].co for i in face.vertices]
            main = points[0].z > 2.8
            region = "main" if main else "corridor"
            grid = 3.0 if main else 2.4
            offsets = (0.001,) if obj == emitters else (0, 0.001, 0.002)
            assert all(any(abs(p.z - grid - offset) < 1e-5 for offset in offsets) for p in points)
            if obj == ceiling and face.normal.z < -0.999 and abs(points[0].z - grid) < 1e-5:
                grid_rectangles[region].append([min(p.x for p in points), min(p.y for p in points),
                                                max(p.x for p in points), max(p.y for p in points)])
            if face.normal.z < -0.999 and (obj == emitters or abs(points[0].z - grid - 0.002) < 1e-5):
                width = max(p.x for p in points) - min(p.x for p in points)
                depth = max(p.y for p in points) - min(p.y for p in points)
                actual = sorted([width + 0.014, depth + 0.014])
                expected = [0.6, 1.2] if main else [0.5, 1.215]
                assert all(abs(a - b) < 1e-5 for a, b in zip(actual, expected)), actual
                measured[region]["panels"] += 1
                measured[region]["cellMeters"] = expected
                if obj == emitters:
                    measured[region]["emitters"] += 1
                    center = obj.matrix_world @ face.center
                    fixture = next(f for f in manifest["templates"][0]["lights"]
                                   if abs(f["position"][0] - center.x) < 1e-4
                                   and abs(f["position"][2] + center.y) < 1e-4)
                    assert abs(fixture["position"][1] - center.z) < 1e-5
            for index in face.loop_indices:
                p = obj.matrix_world @ obj.data.vertices[obj.data.loops[index].vertex_index].co
                actual = obj.data.uv_layers["SurfaceUV"].data[index].uv
                uv_errors.extend([abs(actual.x - p.x / 1.2), abs(actual.y - p.y / 1.2)])
                if obj == ceiling:
                    actual = obj.data.uv_layers["LightmapUV"].data[index].uv
                    uv_errors.extend([abs(actual.x - (0.004 + (p.x + 16) / 32 * 0.992)),
                                      abs(actual.y - (0.004 + (p.y + 16) / 32 * 0.992))])
    assert measured["main"]["panels"] == 800 and measured["main"]["emitters"] == 31
    assert measured["corridor"]["panels"] == 64 and measured["corridor"]["emitters"] == 16
    assert max(uv_errors) < 1e-6
    max_overlap = 0.0
    for rectangles in grid_rectangles.values():
        rectangles = np.asarray(rectangles)
        for i, rect in enumerate(rectangles[:-1]):
            overlap = np.maximum(0, np.minimum(rect[2:], rectangles[i + 1:, 2:]) - np.maximum(rect[:2], rectangles[i + 1:, :2]))
            max_overlap = max(max_overlap, float(np.max(overlap[:, 0] * overlap[:, 1])))
    assert max_overlap < 1e-8, ("Coplanar grid overlap", max_overlap)
    power_errors = [abs(f["physicalStrength"] * f["area"] - 8 * f["oldArea"])
                    for f in manifest["bake"]["ceilingRefinement"]["fixtures"]]
    assert max(power_errors) < 1e-10
    pngs = []
    for kind in ("albedo", "normal", "roughness"):
        file = OUT / f"{PREFIX}-{kind}.png"
        data = file.read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack_from(">II", data, 16) == (1024, 1024)
        assert data[24:26] == bytes([8, 2])
        pngs.append(file.name)
    return {"measuredPanels": measured, "physicalUV0AndPlanarUV1MaxError": max(uv_errors),
            "emissionEnergyMaxError": max(power_errors), "allRequiredHeightsVerified": True,
            "fixtureCentersMatchManifest": True, "png1024Rgb8Verified": pngs,
            "maximumCoplanarGridOverlapSquareMeters": max_overlap}


def verify_and_render(manifest):
    bpy.ops.wm.open_mainfile(filepath=str(WORK / "refined-ceiling.blend"))
    write_report("geometry-validation.json", validate_checkpoint(manifest))
    exporter.configure()
    scene = bpy.context.scene
    for obj in scene.objects:
        if obj.type != "CAMERA":
            obj.hide_render = True
    bpy.ops.import_scene.gltf(filepath=str(OUT / GEOMETRY))
    imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    assert len(imported) == 5
    for obj in imported:
        obj.hide_render = False
        desc = manifest["materials"][obj["surface"]]
        mat = bpy.data.materials.new("Saved map replay - " + obj["surface"])
        mat.use_nodes = True
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        nodes.clear()

        def texture(file, channel, color=False, repeat=False):
            tex = nodes.new("ShaderNodeTexImage")
            tex.image = bpy.data.images.load(str(OUT / file), check_existing=False)
            tex.image.colorspace_settings.name = "sRGB" if color else "Non-Color"
            tex.extension = "REPEAT" if repeat else "EXTEND"
            uv = nodes.new("ShaderNodeUVMap")
            uv.uv_map = obj.data.uv_layers[channel].name
            links.new(uv.outputs["UV"], tex.inputs["Vector"])
            return tex.outputs["Color"]

        def multiply(a, b):
            mix = nodes.new("ShaderNodeMixRGB")
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1
            links.new(a, mix.inputs[1])
            links.new(b, mix.inputs[2])
            return mix.outputs[0]

        if desc["kind"] == "pbr":
            assert len(obj.data.uv_layers) == 2
            color = multiply(texture(desc["albedo"], 0, True, True), texture(desc["lightmap"], 1))
            if desc.get("vertexColors"):
                vertex = nodes.new("ShaderNodeVertexColor")
                vertex.layer_name = obj.data.color_attributes[0].name
                color = multiply(color, vertex.outputs["Color"])
        elif desc["kind"] == "radiance":
            assert len(obj.data.uv_layers) == 1
            color = texture(desc["radiance"], 0)
        else:
            color = None
        emission = nodes.new("ShaderNodeEmission")
        if color:
            links.new(color, emission.inputs["Color"])
        else:
            emission.inputs["Color"].default_value = (*desc["color"], 1)
        output = nodes.new("ShaderNodeOutputMaterial")
        links.new(emission.outputs[0], output.inputs["Surface"])
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    all_bounds = [exporter.bounds(o) for o in imported]
    bounds = {key: [op(b[key][a] for b in all_bounds) for a in range(3)] for key, op in [("min", min), ("max", max)]}
    assert all(abs(bounds["min"][a] + 16) < 1e-4 and abs(bounds["max"][a] - 16) < 1e-4 for a in (0, 2))
    assert abs(bounds["max"][1] - 3.002) < 1e-4
    scene.cycles.samples = 32
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.resolution_percentage = 100
    for name, view in [("front-reference", manifest["templates"][0]["spawn"]),
                       ("upward-ceiling", {"position": [-4.2, 1.65, 10], "yaw": -0.38, "pitch": 0.72})]:
        exporter.builder.source.camera_from_view(view)
        scene.render.filepath = str(WORK / (name + ".png"))
        bpy.ops.render.render(write_still=True)
    return {"exportedBounds": bounds, "importedMeshes": len(imported),
            "replay": "Exported GLB, saved albedo times E/pi and vertex tint; unchanged saved detail radiance. Display-only panel radiance. No fresh lighting solution.",
            "renders": ["front-reference.png", "upward-ceiling.png"]}


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    before = hashes()
    if "--native-preview" in sys.argv:
        public_before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file()}
        manifest = json.loads((WORK / "modules.json").read_text())
        bpy.ops.wm.open_mainfile(filepath=str(WORK / "refined-ceiling.blend"))
        exporter.configure()
        emitter = bpy.data.objects["Reference ceiling-lights"].active_material
        physical = next(n for n in emitter.node_tree.nodes if n.type == "EMISSION" and n.name != "Camera-only panel radiance")
        old_color = tuple(physical.inputs["Color"].default_value)
        old_strength_link = physical.inputs["Strength"].links[0].from_socket
        camera_emission_preview(emitter)
        assert tuple(physical.inputs["Color"].default_value) == old_color
        assert physical.inputs["Strength"].links[0].from_socket == old_strength_link
        geometry = validate_checkpoint(manifest)
        write_report("geometry-validation.json", geometry)
        bpy.ops.wm.save_as_mainfile(filepath=str(WORK / "refined-ceiling.blend"))
        scene = bpy.context.scene
        scene.cycles.samples = 64
        scene.render.resolution_x, scene.render.resolution_y = 1280, 720
        scene.render.resolution_percentage = 100
        renders = []
        for name, view in [("native-front-reference", manifest["templates"][0]["spawn"]),
                           ("native-upward-ceiling", {"position": [-4.2, 1.65, 10], "yaw": -0.38, "pitch": 0.72})]:
            exporter.builder.source.camera_from_view(view)
            scene.render.filepath = str(WORK / (name + ".png"))
            bpy.ops.render.render(write_still=True)
            renders.append(name + ".png")
        manifest["bake"]["ceilingRefinement"]["nativePreview"] = "Is Camera Ray: descriptor RGB at strength 1; all non-camera transport keeps area-compensated source emission."
        write_report("modules.json", manifest)
        assert hashes() == before
        assert public_before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file()}
        write_report("native-preview-validation.json", {"physicalEmissionInputsUnchanged": True,
            "allPublicFileHashesUnchanged": True, "cameraRadiance": [3.6, 3.55, 2.85], "renders": renders,
            "maximumCoplanarGridOverlapSquareMeters": geometry["maximumCoplanarGridOverlapSquareMeters"]})
        return
    if "--validate-only" in sys.argv:
        manifest = json.loads((WORK / "modules.json").read_text())
        bpy.ops.wm.open_mainfile(filepath=str(WORK / "refined-ceiling.blend"))
        write_report("geometry-validation.json", validate_checkpoint(manifest))
        assert hashes() == before
        return
    if "--verify-only" in sys.argv:
        manifest = json.loads((WORK / "modules.json").read_text())
        write_report("render-validation.json", verify_and_render(manifest))
        assert hashes() == before
        return
    start = time.monotonic()
    write_report("protected-before.json", before)
    manifest = json.loads((OUT / "modules.json").read_text())
    original = copy.deepcopy(manifest)
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    exporter.configure()
    bpy.data.collections["Incoming Assets"].hide_render = True
    material = refined_material()
    textures = bake_tile(material)
    ceiling, refinement = replace_ceiling(material, manifest["templates"][0]["lights"])
    image = exporter.image_target(ceiling["ceiling"], "Ceiling-only E/pi", 2048)
    exporter.log("Baking ceiling only: DIFFUSE DIRECT+INDIRECT, no COLOR, 2048px")
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer="LightmapUV", margin=8, margin_type="EXTEND")
    exporter.denoise_lightmap(image)
    atlas = exporter.save_image(image, PREFIX + "-light.hdr")
    atlas.update({"family": "ceiling", "gpuHalfFloatRgbaBytes": 2048 ** 2 * 8})
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK / "refined-ceiling.blend"))
    groups = {family: bpy.data.objects["Reference " + family] for family in ("walls", "floor", "details")}
    groups.update(ceiling)
    # Strip only export copies. The saved checkpoint above retains physical shaders.
    for family, obj in groups.items():
        if family == "details":
            for uv in list(obj.data.uv_layers):
                if uv.name != "LightmapUV":
                    obj.data.uv_layers.remove(uv)
        if family == "ceiling-lights":
            for attr in list(obj.data.color_attributes):
                obj.data.color_attributes.remove(attr)
        obj.data.uv_layers.active_index = 0
        obj.data.uv_layers[0].active_render = True
        obj.data.materials.clear()
        for face in obj.data.polygons:
            face.material_index = 0
    exporter.select(list(groups.values()))
    bpy.ops.export_scene.gltf(filepath=str(OUT / GEOMETRY), export_format="GLB", use_selection=True,
                              export_materials="NONE", export_extras=True, export_yup=True, export_animations=False,
                              export_cameras=False, export_lights=False, export_texcoords=True,
                              export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True)
    fingerprints = glb_fingerprints(OUT / GEOMETRY)
    old_fingerprints = glb_fingerprints(OUT / "reference.glb")
    for family in ("walls", "floor", "details"):
        assert fingerprints[family] == old_fingerprints[family], (family, "Existing geometry/UV/extras changed")
    write_report("preserved-geometry.json", {k: fingerprints[k] for k in ("walls", "floor", "details")})
    gltf, _ = read_glb(OUT / GEOMETRY)
    assert not gltf.get("materials")
    nodes = [n for n in gltf["nodes"] if "mesh" in n]
    assert len(nodes) == 5
    assert set(fingerprints) == {"walls", "floor", "details", "ceiling", "ceiling-lights"}
    triangles = 0
    for node in nodes:
        family = node["extras"]["surface"]
        primitives = gltf["meshes"][node["mesh"]]["primitives"]
        assert len(primitives) == 1
        attrs = primitives[0]["attributes"]
        assert "TEXCOORD_0" in attrs
        if family in ("walls", "floor", "ceiling"):
            assert "TEXCOORD_1" in attrs
        if family == "ceiling":
            assert "COLOR_0" in attrs
        count = gltf["accessors"][primitives[0]["indices"]]["count"] // 3
        if family == "ceiling-lights":
            assert count == 94
        triangles += count
    meta = manifest["templates"][0]
    meta["geometry"] = GEOMETRY
    meta["lights"] = [{"id": f["id"], "position": f["position"]} for f in refinement["fixtures"]]
    meta["radiance"] = [dict(a, file=PREFIX + "-light.hdr") if a["family"] == "ceiling" else a for a in meta["radiance"]]
    manifest["materials"]["ceiling"] = {"kind": "pbr", "family": "ceiling", "albedo": PREFIX + "-albedo.png",
        "normal": PREFIX + "-normal.png", "roughness": PREFIX + "-roughness.png", "lightmap": PREFIX + "-light.hdr",
        "normalScale": 1, "roughnessFactor": 1, "vertexColors": True}
    manifest["materials"]["ceiling-lights"] = {"kind": "emission", "family": "ceiling", "color": [3.6, 3.55, 2.85]}
    manifest["bake"]["atlases"] = [atlas if a["family"] == "ceiling" else a for a in manifest["bake"]["atlases"]]
    manifest["bake"]["tileTextures"] += textures
    manifest["bake"]["physicalTileMeters"]["ceiling"] = 1.2
    manifest["bake"].update({"triangles": triangles, "drawCallsPerRoom": 5, "geometryBytes": (OUT / GEOMETRY).stat().st_size})
    refinement["seconds"] = round(time.monotonic() - start, 2)
    refinement["checkpoint"] = "assets/lookdev/ceiling-update/refined-ceiling.blend"
    refinement["lightmapPass"] = "DIFFUSE DIRECT+INDIRECT without COLOR; E/pi, OIDN HDR"
    refinement["oldGeometryAttributeBytesUnchanged"] = ["walls", "floor", "details"]
    manifest["bake"]["ceilingRefinement"] = refinement
    for key in ("colliders", "rooms", "anchors", "spawn"):
        assert meta[key] == original["templates"][0][key]
    for family in ("walls", "floor", "details"):
        assert manifest["materials"][family] == original["materials"][family]
    exporter.builder.source.GROUPS = {"ceiling": list(ceiling.values())}
    exporter.builder.FLOORS[:] = [(-12, -12, 12, 12), (-16, -1.215, -12, 1.215),
                                (12, -1.215, 16, 1.215), (-1.215, -16, 1.215, -12), (-1.215, 12, 1.215, 16)]
    refinement["navigation"] = exporter.builder.validate(meta)
    write_report("modules.json", manifest)
    render_report = verify_and_render(manifest)
    write_report("render-validation.json", render_report)
    after = hashes()
    assert before == after, "Protected assets changed"
    write_report("protected-after.json", after)
    write_report("validation.json", {"protectedHashesUnchanged": True, "protectedFiles": len(before),
        "geometryAttributeBytesUnchanged": ["walls", "floor", "details"], "triangles": triangles,
        "drawCallsPerRoom": 5, "poweredPanelFaces": 47, "fixtureIdsAndHorizontalCentersUnchanged": True,
        "render": render_report, "refinement": refinement})
    exporter.log("Ceiling-only update complete: " + str(WORK / "modules.json"))


if __name__ == "__main__":
    main()
