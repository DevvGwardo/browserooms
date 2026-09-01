"""Finite, rotation-safe architectural kit. Run in a separate headless Blender.

Blender --background --factory-startup --python scripts/bake_modules.py
Use -- --validate-only for geometry checks, -- --template gallery to rebuild one,
-- --refine-ceiling to rebake only ceiling atlases in saved sources, or
-- --verify-kit for exported bounds and a rotated two-cell seam render.
Original bake_scene.py is imported without running its main or changing its files.
"""

import importlib.util
import json
import math
import struct
import sys
import time
from collections import deque
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("source_bake", ROOT / "scripts/bake_scene.py")
source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source)
ASSETS = ROOT / "assets/modules"
OUT = ROOT / "public/modules"
RESOLUTIONS = {"walls": 2048, "floor": 1024, "ceiling": 2048, "details": 512}
TEMPLATES = ("gallery", "offset", "pillars")
SPAWN = {"position": [0.35, 1.65, 10.1], "yaw": -0.10, "pitch": -0.025}
FLOORS = []
SUPPORT = []
PORTALS = [("north", 0, -16), ("east", 16, 0), ("south", 0, 16), ("west", -16, 0)]


def box(name, x, z, width, depth, mat, family="walls", bottom=0, height=3, solid=True):
    obj = source.cube(name, (x, -z, bottom + height / 2), (width, depth, height), mat, family)
    if solid:
        source.COLLIDERS.append({"min": [x - width / 2, bottom, z - depth / 2], "max": [x + width / 2, bottom + height, z + depth / 2]})
    return obj


def wall(name, x, z, width, depth, mats):
    source.wall_box(name, x, -z, width, depth, mats[0], mats[3])
    # Source skirting projects 15 mm from each wall face; include it conservatively.
    collider = source.COLLIDERS[-1]
    for axis in (0, 2):
        collider["min"][axis] -= 0.015
        collider["max"][axis] += 0.015


def floor_rect(name, xmin, zmin, xmax, zmax, carpet):
    source.mesh_quads(name, [(xmin, -zmax, 0), (xmax, -zmax, 0), (xmax, -zmin, 0), (xmin, -zmin, 0)], [(0, 1, 2, 3)], [carpet], [0], "floor")
    FLOORS.append((xmin, zmin, xmax, zmax))


def ceiling(name, xmin, zmin, xmax, zmax, mats, corridor=False, horizontal=False):
    # Preserve the original inset mineral tiles, angled edges and real T-grid.
    vertices, faces, indices = [], [], []
    width, depth = xmax - xmin, zmax - zmin
    nx = round(width / (0.5 if horizontal and corridor else 1.2))
    nz = round(depth / (1.2 if horizontal and corridor else 0.5 if corridor else 0.6))
    nx, nz = max(1, nx), max(1, nz)
    shift = -0.578 if corridor else 0

    def quad(coords, index):
        base = len(vertices)
        vertices.extend(coords)
        faces.append(tuple(range(base + 3, base - 1, -1)))
        indices.append(index)

    for ix in range(nx):
        for iz in range(nz):
            x0, x1 = xmin + width * ix / nx, xmin + width * (ix + 1) / nx
            y0, y1 = -zmax + depth * iz / nz, -zmax + depth * (iz + 1) / nz
            along = ix if horizontal else iz
            light_slot = along % 4 == 1 if corridor else ix % 3 == 1 and iz % 6 == 3
            off = not corridor and ((ix >= 13 and 19 <= iz < 27) or (ix < 6 and 8 <= iz < 14))
            index = 2 if light_slot and not off else 3 if light_slot else 0
            height = (2.995 if light_slot else 3.012) + shift
            pad, edge = 0.012, 0.023
            inner = [(x0 + edge, y0 + edge, height), (x1 - edge, y0 + edge, height), (x1 - edge, y1 - edge, height), (x0 + edge, y1 - edge, height)]
            outer = [(x0 + pad, y0 + pad, 2.983 + shift), (x1 - pad, y0 + pad, 2.983 + shift), (x1 - pad, y1 - pad, 2.983 + shift), (x0 + pad, y1 - pad, 2.983 + shift)]
            quad(inner, index)
            for k in range(4):
                j = (k + 1) % 4
                quad([outer[k], outer[j], inner[j], inner[k]], 1 if light_slot else 0)
            quad([(x0, y0, 2.978 + shift), (x1, y0, 2.978 + shift), (x1, y0 + pad, 2.978 + shift), (x0, y0 + pad, 2.978 + shift)], 1)
            quad([(x0, y1 - pad, 2.978 + shift), (x1, y1 - pad, 2.978 + shift), (x1, y1, 2.978 + shift), (x0, y1, 2.978 + shift)], 1)
            quad([(x0, y0 + pad, 2.978 + shift), (x0 + pad, y0 + pad, 2.978 + shift), (x0 + pad, y1 - pad, 2.978 + shift), (x0, y1 - pad, 2.978 + shift)], 1)
            quad([(x1 - pad, y0 + pad, 2.978 + shift), (x1, y0 + pad, 2.978 + shift), (x1, y1 - pad, 2.978 + shift), (x1 - pad, y1 - pad, 2.978 + shift)], 1)
    source.mesh_quads(name, vertices, faces, [mats[2], mats[4], mats[7], mats[8]], indices, "ceiling")


def corridor(name, x, z, horizontal, mats, support=False):
    previous = {key: len(value) for key, value in source.GROUPS.items()}
    old_colliders, old_floors = len(source.COLLIDERS), len(FLOORS)
    for side in (-1, 1):
        cx, cz = (x, z + side * 1.355) if horizontal else (x + side * 1.355, z)
        w, d = (4, 0.28) if horizontal else (0.28, 4)
        box(name + " sidewall", cx, cz, w, d, mats[0], height=2.44)
        # No end caps or end bevels: adjacent cells meet at a single plane.
        tx, tz = (x, z + side * 1.2075) if horizontal else (x + side * 1.2075, z)
        tw, td = (4, 0.015) if horizontal else (0.015, 4)
        box(name + " continuous skirting", tx, tz, tw, td, mats[3], "details", height=0.104)
    w, d = (4, 2.43) if horizontal else (2.43, 4)
    floor_rect(name + " carpet", x - w / 2, z - d / 2, x + w / 2, z + d / 2, mats[1])
    ceiling(name + " low tiled ceiling", x - w / 2, z - d / 2, x + w / 2, z + d / 2, mats, True, horizontal)
    if support:
        for family, objects in source.GROUPS.items():
            SUPPORT.extend(objects[previous[family]:])
            del objects[previous[family]:]
        del source.COLLIDERS[old_colliders:]
        del FLOORS[old_floors:]


def build(template):
    bpy.ops.wm.read_factory_settings(use_empty=False)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    source.GROUPS = {key: [] for key in RESOLUTIONS}
    source.COLLIDERS = []
    FLOORS.clear()
    SUPPORT.clear()
    mats = source.make_materials()
    floor_rect("Main continuous carpet", -12, -12, 12, 12, mats[1])
    ceiling("Main acoustic ceiling", -12, -12, 12, 12, mats)
    for sign in (-1, 1):
        for side in (-1, 1):
            # Each opening is 2.43 m between walls, 2.40 m between skirting.
            wall("Perimeter return", sign * 6.6075, side * 11.86, 10.785, 0.28, mats)
            wall("Perimeter return", side * 11.86, sign * 6.6075, 0.28, 10.785, mats)
        corridor("East/west vestibule", sign * 14, 0, True, mats)
        corridor("North/south vestibule", 0, sign * 14, False, mats)
        box("Vestibule lintel", sign * 11.86, 0, 0.28, 2.43, mats[0], bottom=2.4, height=0.6)
        box("Vestibule lintel", 0, sign * 11.86, 2.43, 0.28, mats[0], bottom=2.4, height=0.6)

    layouts = {
        "gallery": [
            ("Near wallpaper return", 2.8, 7.9, 0.32, 7.3),
            ("First offset partition", 4.15, 4.4, 2.7, 0.32),
            ("Inner gallery wall", 7.3, -1.0, 0.32, 14.4),
            ("Gallery crosswall", 9.7, 3.8, 4.2, 0.32),
            ("Rear offset return", 3.1, -8.2, 5.7, 0.32),
            ("Left gallery wing", -7.7, 1.6, 7.2, 0.32),
            ("Left rear wing", -8.5, -4.3, 5.6, 0.32),
            ("Foreground column", -0.95, 7.5, 0.85, 0.85),
            ("Gallery column A", 4.5, 0.0, 0.72, 0.72),
            ("Gallery column B", 4.5, -4.8, 0.72, 0.72),
            ("Left room column", -3.8, -6.5, 0.7, 0.7),
        ],
        "offset": [
            ("Entry dogleg", -3.1, 6.0, 8.2, 0.32),
            ("West chamber return", -7.0, 2.8, 0.32, 6.1),
            ("Central hall west", -2.5, -1.1, 0.32, 8.8),
            ("Hall offset east", 2.6, 1.8, 0.32, 10.0),
            ("East chamber crosswall", 7.3, 6.7, 8.7, 0.32),
            ("North chamber crosswall", 2.8, -6.5, 10.3, 0.32),
            ("West chamber wing", -8.1, -5.9, 6.2, 0.32),
            ("Far east return", 8.9, -3.4, 0.32, 5.5),
            ("Entry column", 4.8, 9.0, 0.8, 0.8),
            ("West chamber column", -9.1, 8.8, 0.8, 0.8),
        ],
        "pillars": [
            ("Entry screen", -4.8, 7.1, 5.6, 0.32),
            ("Rear screen", 5.1, -7.8, 6.5, 0.32),
            ("West alcove return", -8.7, -5.7, 0.32, 5.1),
            ("East alcove return", 9.1, 4.5, 0.32, 4.2),
            *[(f"Staggered column {i}", x, z, 0.9 if i % 3 else 1.1, 0.9 if i % 3 else 1.1)
              for i, (x, z) in enumerate([(-1.4, 7.5), (3.5, 5.0), (-5.8, 2.6), (-0.7, 1.4), (5.4, 0.0), (-3.5, -3.5), (2.0, -4.3), (6.8, -4.3), (-5.5, -8.7), (0.0, -9.4)])],
        ],
    }
    for args in layouts[template]:
        wall(*args, mats)
    for x, z in [(-3.0, 8.7), (6.2, -2.1), (-7.8, -8.1)]:
        source.cube("Return air frame", (x, -z, 2.965), (0.48, 0.42, 0.018), mats[4], "details", 0.003)
        for j in range(12):
            source.cube("Return air louvre", (x, -z - 0.172 + j * 0.031, 2.952), (0.41, 0.013, 0.006), mats[6], "details", 0.002)
    for x, z in [(-11.708, 5.8), (11.708, -5.8)]:
        facing = 1 if x < 0 else -1
        source.cube("Duplex outlet plate", (x, -z, 0.31), (0.012, 0.072, 0.116), mats[5], "details", 0.003)
        for height in (0.287, 0.333):
            for dy in (-0.011, 0.011):
                source.cube("Outlet slot", (x + facing * 0.007, -z + dy, height), (0.002, 0.003, 0.015), mats[6], "details")

    camera = bpy.data.cameras.new("Module reference camera")
    camera.lens, camera.sensor_width, camera.clip_start = 23.5, 36, 0.03
    cam = bpy.data.objects.new(camera.name, camera)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    source.camera_from_view(SPAWN)


def metadata(template):
    rooms = [{"id": "main", "bounds": {"min": [-11.7, 0, -11.7], "max": [11.7, 3, 11.7]}}]
    anchors = []
    for name, x, z in PORTALS:
        horizontal = bool(x)
        cx, cz = x * 0.875, z * 0.875
        w, d = (4, 2.4) if horizontal else (2.4, 4)
        rooms.append({"id": name + "-vestibule", "bounds": {"min": [cx - w / 2, 0, cz - d / 2], "max": [cx + w / 2, 2.4, cz + d / 2]}})
        anchors.append({"id": name + "-floor", "roomId": name + "-vestibule", "kind": "floor", "position": [cx, 0, cz], "yaw": 0, "clearance": [1.0, 2.0, 1.0]})
        anchors.append({"id": name + "-ceiling", "roomId": name + "-vestibule", "kind": "ceiling", "position": [cx, 2.4, cz], "yaw": 0, "clearance": [0.5, 0.2, 0.5]})
    for index, (x, z) in enumerate([(-9, 10.4), (9.8, 9.8), (-9.8, -9.8), (9.8, -9.8)]):
        anchors.append({"id": f"main-floor-{index}", "roomId": "main", "kind": "floor", "position": [x, 0, z], "yaw": 0, "clearance": [1.2, 2, 1.2]})
    anchors.append({"id": "main-west-wall", "roomId": "main", "kind": "wall", "position": [-11.718, 1.8, 3.6], "yaw": -math.pi / 2, "clearance": [0.6, 0.6, 0.15]})
    return {"id": template, "geometry": template + ".glb", "radiance": [{"file": f"{template}-{family}.hdr", "family": family, "flipY": False, "resolution": resolution} for family, resolution in RESOLUTIONS.items()], "colliders": source.COLLIDERS.copy(), "rooms": rooms, "anchors": anchors, "lights": light_metadata(source.GROUPS["ceiling"]), "spawn": SPAWN.copy()}


def light_metadata(objects):
    """Only the emitting panel faces, excluding unpowered panels and bake support."""
    bpy.context.view_layer.update()
    positions = []
    for obj in objects:
        emitting = {i for i, mat in enumerate(obj.data.materials)
                    if mat and mat.node_tree and any(n.type == "EMISSION" for n in mat.node_tree.nodes)}
        for face in obj.data.polygons:
            if face.material_index not in emitting:
                continue
            p = obj.matrix_world @ face.center
            positions.append([round(p.x, 5), round(p.z, 5), round(-p.y, 5)])
    positions.sort(key=lambda p: (p[0], p[2], p[1]))
    return [{"id": f"light-{i:03}", "position": position} for i, position in enumerate(positions)]


def validate(meta):
    colliders = meta["colliders"]
    for family, objects in source.GROUPS.items():
        for obj in objects:
            for vertex in obj.data.vertices:
                point = obj.matrix_world @ vertex.co
                assert abs(point.x) <= 16.00001 and abs(point.y) <= 16.00001, (obj.name, list(point))
    for c in colliders:
        assert all(c["min"][a] < c["max"][a] for a in range(3))
        assert all(-16.00001 <= c[key][a] <= 16.00001 for key in ("min", "max") for a in (0, 2))

    def free(x, z, radius=0.24):
        if not any(a - 1e-6 <= x <= c + 1e-6 and b - 1e-6 <= z <= d + 1e-6 for a, b, c, d in FLOORS):
            return False
        return not any(c["min"][1] < 1.8 and c["max"][1] > 0 and c["min"][0] - radius < x < c["max"][0] + radius and c["min"][2] - radius < z < c["max"][2] + radius for c in colliders)

    sx, _, sz = meta["spawn"]["position"]
    assert free(sx, sz), "Spawn blocked"
    step = 0.2
    start = (round(sx / step), round(sz / step))
    seen, queue = {start}, deque([start])
    while queue:
        ix, iz = queue.popleft()
        for cell in [(ix + 1, iz), (ix - 1, iz), (ix, iz + 1), (ix, iz - 1)]:
            if cell not in seen and abs(cell[0]) <= 80 and abs(cell[1]) <= 80 and free(cell[0] * step, cell[1] * step):
                seen.add(cell)
                queue.append(cell)
    for name, x, z in PORTALS:
        assert (round(x / step), round(z / step)) in seen, f"Unreachable {name}"
        for lateral in (-0.95, 0, 0.95):
            px, pz = (x, lateral) if x else (lateral, z)
            assert free(px, pz), f"Blocked portal {name}"
        for delta in (-0.01, 0, 0.01):
            assert free(x * 0.75 + (delta if x else 0), z * 0.75 + (delta if z else 0)), "Discontinuous room/corridor floor"
    for anchor in meta["anchors"]:
        if anchor["kind"] != "floor":
            continue
        x, y, z = anchor["position"]
        w, h, d = anchor["clearance"]
        assert not any(c["min"][1] < h and c["max"][1] > y and c["min"][0] < x + w / 2 and c["max"][0] > x - w / 2 and c["min"][2] < z + d / 2 and c["max"][2] > z - d / 2 for c in colliders), anchor["id"]
        assert all(free(x + dx * w / 2, z + dz * d / 2, 0) for dx in (-1, 1) for dz in (-1, 1)), anchor["id"]
    return {"reachablePortals": 4, "navigationRadius": 0.24, "navigationHeight": 1.8, "navigationGridMeters": step, "reachableGridCells": len(seen), "floorAnchorsChecked": sum(a["kind"] == "floor" for a in meta["anchors"]), "boundsInsideCell": True, "roomCorridorFloorContinuous": True, "portalClearWidth": 2.4, "portalClearHeight": 2.4}


def prepare(template):
    for family, objects in source.GROUPS.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = family
        obj["radiance"], obj["surfaceFamily"] = f"{template}-{family}.hdr", family
        if family in ("walls", "details"):
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.008, area_weight=1.0, correct_aspect=True, scale_to_bounds=True)
            bpy.ops.object.mode_set(mode="OBJECT")
        else:
            uv = obj.data.uv_layers.new(name="RadianceUV")
            for face in obj.data.polygons:
                for loop in face.loop_indices:
                    co = obj.matrix_world @ obj.data.vertices[obj.data.loops[loop].vertex_index].co
                    uv.data[loop].uv = (0.004 + (co.x + 16) / 32 * 0.992, 0.004 + (co.y + 16) / 32 * 0.992)
        obj.data.uv_layers.active.name = "RadianceUV"
    mats = tuple(bpy.data.materials[name] for name in ["Cream chevron paper - linen relief", "Oatmeal loop-pile carpet", "Warm ivory mineral acoustic tile", "Aged putty vinyl skirting", "Warm white enamel T-grid", "Ivory wall plates", "Socket apertures", "Fluorescent prismatic diffuser - 3500K", "Unpowered fluorescent diffuser"])
    for sign in (-1, 1):
        corridor("Bake-only neighbouring collar", sign * 18, 0, True, mats, True)
        corridor("Bake-only neighbouring collar", 0, sign * 18, False, mats, True)
    for obj in SUPPORT:
        obj["bakeSupportOnly"] = True


def export_and_bake(meta, previous=None):
    import numpy as np
    template = meta["id"]
    start = time.monotonic()
    stats = [s for s in previous["atlases"] if s["family"] != "ceiling"] if previous else []
    for family, resolution in RESOLUTIONS.items():
        if previous and family != "ceiling":
            continue
        obj = bpy.data.objects[family]
        image = bpy.data.images.new(f"{template} {family} radiance", width=resolution, height=resolution, alpha=False, float_buffer=True)
        image.colorspace_settings.name = "Non-Color"
        for slot in obj.material_slots:
            mat = slot.material
            tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
            tex.name, tex.image = "Radiance bake destination", image
            mat.node_tree.nodes.active = tex
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        source.log(f"{template}: baking {family} {resolution}px")
        bpy.ops.object.bake(type="COMBINED", pass_filter={"DIRECT", "INDIRECT", "DIFFUSE", "EMIT"}, margin=8, margin_type="EXTEND", use_clear=True, uv_layer="RadianceUV")
        image.filepath_raw = str(OUT / f"{template}-{family}.hdr")
        image.file_format = "HDR"
        image.save()
        pixels = np.empty(resolution * resolution * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        rgb = pixels.reshape((-1, 4))[:, :3]
        lit = rgb[np.max(rgb, axis=1) > 0.00001]
        assert np.isfinite(rgb).all() and len(lit) > 0
        stats.append({"family": family, "resolution": resolution, "maximum": float(rgb.max()), "meanNonBlack": [float(x) for x in lit.mean(axis=0)], "nonBlackPixels": len(lit), "fileBytes": Path(image.filepath_raw).stat().st_size, "gpuHalfFloatRgbaBytes": resolution * resolution * 8})
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS / f"{template}.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for family in RESOLUTIONS:
        bpy.data.objects[family].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects["walls"]
    bpy.ops.export_scene.gltf(filepath=str(OUT / f"{template}.glb"), export_format="GLB", use_selection=True, export_materials="NONE", export_extras=True, export_yup=True, export_animations=False, export_cameras=False, export_lights=False, export_texcoords=True)
    data = (OUT / f"{template}.glb").read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + size])
    meshes = [n for n in gltf["nodes"] if "mesh" in n]
    assert len(meshes) == 4 and {n["extras"]["surfaceFamily"] for n in meshes} == set(RESOLUTIONS)
    for n in meshes:
        assert (OUT / n["extras"]["radiance"]).exists()
        assert all("TEXCOORD_0" in p["attributes"] for p in gltf["meshes"][n["mesh"]]["primitives"])
    triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for mesh in gltf["meshes"] for p in mesh["primitives"])
    # Re-render the actual saved HDRs, not a fresh lighting solution.
    for family in RESOLUTIONS:
        obj = bpy.data.objects[family]
        mat = bpy.data.materials.new("Reloaded atlas " + family)
        mat.use_nodes = True
        mat.node_tree.nodes.clear()
        tex = source.node(mat, "ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(OUT / f"{template}-{family}.hdr"), check_existing=False)
        tex.image.colorspace_settings.name = "Non-Color"
        emit = source.node(mat, "ShaderNodeEmission", Strength=1)
        output = source.node(mat, "ShaderNodeOutputMaterial")
        source.wire(mat, tex.outputs["Color"], emit.inputs["Color"])
        source.wire(mat, emit.outputs[0], output.inputs["Surface"])
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for face in obj.data.polygons:
            face.material_index = 0
    bpy.context.scene.cycles.samples = 32
    bpy.context.scene.render.filepath = str(ASSETS / f"{template}-baked.png")
    source.camera_from_view(meta["spawn"])
    bpy.ops.render.render(write_still=True)
    if template == "gallery":
        bpy.data.images["Render Result"].save_render(str(OUT / "preview.png"))
        source.camera_from_view({"position": [0, 1.65, 15.4], "yaw": 0, "pitch": 0})
        bpy.context.scene.render.filepath = str(ASSETS / "gallery-portal.png")
        bpy.ops.render.render(write_still=True)
    stats.sort(key=lambda s: list(RESOLUTIONS).index(s["family"]))
    return {"template": template, "seconds": round(time.monotonic() - start + (previous["seconds"] if previous else 0), 2), "triangles": triangles, "geometryBytes": len(data), "atlases": stats}


def verify_kit():
    from mathutils import Matrix, Quaternion, Vector
    manifest = json.loads((OUT / "modules.json").read_text())
    assert {t["id"] for t in manifest["templates"]} == set(TEMPLATES)
    report = {}
    for template in manifest["templates"]:
        data = (OUT / template["geometry"]).read_bytes()
        gltf = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
        bounds = []

        def walk(index, parent):
            node = gltf["nodes"][index]
            if "matrix" in node:
                local = Matrix([node["matrix"][i:i + 4] for i in range(0, 16, 4)]).transposed()
            else:
                x, y, z, w = node.get("rotation", [0, 0, 0, 1])
                local = Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])), Quaternion((w, x, y, z)), Vector(node.get("scale", [1, 1, 1])))
            world = parent @ local
            if "mesh" in node:
                assert node["extras"]["radiance"] == f"{template['id']}-{node['extras']['surfaceFamily']}.hdr"
                for primitive in gltf["meshes"][node["mesh"]]["primitives"]:
                    assert "TEXCOORD_0" in primitive["attributes"]
                    accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
                    for x in (accessor["min"][0], accessor["max"][0]):
                        for y in (accessor["min"][1], accessor["max"][1]):
                            for z in (accessor["min"][2], accessor["max"][2]):
                                bounds.append(world @ Vector((x, y, z)))
            for child in node.get("children", []):
                walk(child, world)

        for index in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
            walk(index, Matrix.Identity(4))
        lo = [min(v[a] for v in bounds) for a in range(3)]
        hi = [max(v[a] for v in bounds) for a in range(3)]
        assert all(abs(lo[a] + 16) < 0.0001 and abs(hi[a] - 16) < 0.0001 for a in (0, 2)), (lo, hi)
        assert abs(lo[1]) < 0.0001 and hi[1] <= 3.013, (lo, hi)
        for rotation in range(4):
            for _, x, z in PORTALS:
                rx, rz = x, z
                for _ in range(rotation):
                    rx, rz = -rz, rx
                assert (rx, rz) in [(px, pz) for _, px, pz in PORTALS]
        report[template["id"]] = {"exportedBounds": {"min": lo, "max": hi}, "fourRotationsPortalAligned": True, "meshFamilies": 4, "colliderCount": len(template["colliders"]), "anchorCount": len(template["anchors"])}
    bpy.ops.wm.open_mainfile(filepath=str(ASSETS / "gallery.blend"))
    source.configure()
    for obj in bpy.context.scene.objects:
        if obj.get("bakeSupportOnly"):
            obj.hide_render = True
    for family in RESOLUTIONS:
        obj = bpy.data.objects[family]
        mat = bpy.data.materials.new("Rotated seam radiance " + family)
        mat.use_nodes = True
        mat.node_tree.nodes.clear()
        tex = source.node(mat, "ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(OUT / f"gallery-{family}.hdr"), check_existing=False)
        tex.image.colorspace_settings.name = "Non-Color"
        emit = source.node(mat, "ShaderNodeEmission", Strength=1)
        output = source.node(mat, "ShaderNodeOutputMaterial")
        source.wire(mat, tex.outputs["Color"], emit.inputs["Color"])
        source.wire(mat, emit.outputs[0], output.inputs["Surface"])
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for face in obj.data.polygons:
            face.material_index = 0
        clone = obj.copy()
        bpy.context.collection.objects.link(clone)
        clone.matrix_world = Matrix.Translation((0, -32, 0)) @ Matrix.Rotation(math.pi / 2, 4, "Z") @ obj.matrix_world
    source.camera_from_view({"position": [0.35, 1.65, 14.0], "yaw": math.pi - 0.08, "pitch": 0})
    bpy.context.scene.cycles.samples = 32
    bpy.context.scene.render.filepath = str(ASSETS / "gallery-rotated-seam.png")
    bpy.ops.render.render(write_still=True)
    (ASSETS / "export-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    source.log(f"Exported kit verified: {report}")


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    if "--export-lights" in sys.argv:
        path = OUT / "modules.json"
        manifest = json.loads(path.read_text())
        for template in manifest["templates"]:
            bpy.ops.wm.open_mainfile(filepath=str(ASSETS / f"{template['id']}.blend"))
            template["lights"] = light_metadata([bpy.data.objects["ceiling"]])
            assert template["lights"], f"No powered lights found in {template['id']}"
            print(f"{template['id']}: {len(template['lights'])} powered fixtures", flush=True)
        path.write_text(json.dumps(manifest, indent=2) + "\n")
        return
    if "--verify-kit" in sys.argv:
        verify_kit()
        return
    selected = [sys.argv[sys.argv.index("--template") + 1]] if "--template" in sys.argv else list(TEMPLATES)
    assert all(t in TEMPLATES for t in selected)
    manifest_path = OUT / "modules.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"version": 1, "cellSize": 32, "templates": [], "bake": {}}
    checks, prepared = {}, []
    # Validate every requested layout before spending time rendering any template.
    for template in selected:
        build(template)
        meta = metadata(template)
        checks[template] = validate(meta)
        prepared.append(meta)
        source.log(f"{template}: validated {checks[template]}")
    (ASSETS / "validation.json").write_text(json.dumps(checks, indent=2) + "\n")
    if "--validate-only" in sys.argv:
        return
    statistics = manifest.get("bake", {}).get("templates", [])
    for meta in prepared:
        template = meta["id"]
        previous = None
        if "--refine-ceiling" in sys.argv:
            previous = next(s for s in statistics if s["template"] == template)
            bpy.ops.wm.open_mainfile(filepath=str(ASSETS / f"{template}.blend"))
            source.configure()
        else:
            build(template)
            prepare(template)
            source.configure()
            bpy.context.scene.render.filepath = str(ASSETS / f"{template}-reference.png")
            bpy.ops.render.render(write_still=True)
        stats = export_and_bake(meta, previous)
        stats["validation"] = checks[template]
        statistics = [s for s in statistics if s["template"] != template] + [stats]
        manifest["templates"] = [t for t in manifest["templates"] if t["id"] != template] + [meta]
        manifest["templates"].sort(key=lambda t: TEMPLATES.index(t["id"]))
        manifest["bake"] = {"engine": "Cycles", "device": "Metal", "samples": 96, "diffuseBounces": 6, "totalBounces": 8, "world": "black", "pass": "COMBINED: diffuse color, direct, indirect and emission; no glossy/transmission", "colorSpace": "Linear Rec.709 / scene-linear RGBE; neutral source materials; runtime tint/detail not baked", "uv": "TEXCOORD_0; glTF V=1-Blender V; RGBELoader flipY=false", "coordinateSystem": "glTF Y-up metres, cell centered on x/z=0", "camera": {"verticalFovDegrees": 46.61769049, "exposureStops": 1, "viewTransform": "AgX", "look": "Medium High Contrast"}, "atlasResolutions": RESOLUTIONS, "bakeSupport": "4m non-export neighbouring corridor collars with matching fluorescent spacing", "templates": statistics, "totalGpuHalfFloatRgbaBytes": sum(a["gpuHalfFloatRgbaBytes"] for s in statistics for a in s["atlases"]), "totalHdrFileBytes": sum(a["fileBytes"] for s in statistics for a in s["atlases"]), "totalGeometryBytes": sum(s["geometryBytes"] for s in statistics)}
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        source.log(f"{template}: complete")


if __name__ == "__main__":
    main()
