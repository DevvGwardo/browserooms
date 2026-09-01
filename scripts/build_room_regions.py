"""Bake new enclosed regions without changing the active kit or its source assets."""

import argparse
import copy
import importlib.util
import json
import math
import random
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "assets/room-regions"
OUT = ROOT / "public/continuous"
SOURCE = ROOT / "assets/scattered-lights/open-gallery.blend"
SPEC = importlib.util.spec_from_file_location("continuous", ROOT / "scripts/bake_continuous_floor.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
exporter = builder.exporter
CONFIGS = {
    "medium-suites": {
        "x": [-14.4, -7.8, -0.2, 6.2, 14.4],
        "z": [-14.4, -8.0, -0.8, 7.4, 14.4], "seed": 19,
    },
    "medium-offset": {
        "x": [-14.4, -6.4, 0.4, 8.0, 14.4],
        "z": [-14.4, -6.6, -0.4, 6.4, 14.4], "seed": 71,
    },
    "small-warren": {
        "x": [-14.4, -8.8, -3.0, 2.2, 8.0, 14.4],
        "z": [-14.4, -9.4, -5.0, 0.2, 4.8, 9.8, 14.4], "seed": 37,
        "merges": [((1, 2), (1, 3)), ((3, 4), (4, 4))],
    },
    "small-offset": {
        "x": [-14.4, -9.2, -4.8, 0.2, 4.6, 9.6, 14.4],
        "z": [-14.4, -9.8, -4.6, 0.0, 5.0, 9.4, 14.4], "seed": 113,
        "merges": [((1, 1), (2, 1)), ((3, 3), (3, 4))],
    },
}


def layout(template):
    config = CONFIGS[template]
    rng = random.Random(config["seed"])
    xs, zs = config["x"], config["z"]
    cells = {(i, j): [xs[i], zs[j], xs[i + 1], zs[j + 1]]
             for j in range(len(zs) - 1) for i in range(len(xs) - 1)}
    for a, b in config.get("merges", []):
        first, second = cells[a], cells.pop(b)
        cells[a] = [min(first[0], second[0]), min(first[1], second[1]),
                    max(first[2], second[2]), max(first[3], second[3])]
    rooms = [{"id": f"{template}-room-{i + 1:02}", "rect": rect, "doors": []}
             for i, rect in enumerate(cells.values())]
    seams = []
    for i, first in enumerate(rooms):
        a = first["rect"]
        for j in range(i + 1, len(rooms)):
            b = rooms[j]["rect"]
            for axis in (0, 1):
                lateral = 1 - axis
                lo, hi = max(a[lateral], b[lateral]), min(a[lateral + 2], b[lateral + 2])
                if hi - lo < 0.01:
                    continue
                shared = a[axis + 2] if abs(a[axis + 2] - b[axis]) < 0.001 else (
                    b[axis + 2] if abs(b[axis + 2] - a[axis]) < 0.001 else None)
                if shared is not None:
                    seams.append({"rooms": [i, j], "axis": axis, "at": shared, "lo": lo, "hi": hi})

    external = []
    for axis in (0, 1):
        for sign in (-1, 1):
            at = sign * 14.4
            lateral = 1 - axis
            for pocket, target in enumerate((-12.0, 0.0, 12.0)):
                target += rng.uniform(-0.65, 0.65)
                options = []
                for i, room in enumerate(rooms):
                    rect = room["rect"]
                    if abs(rect[axis + (2 if sign > 0 else 0)] - at) > 0.001:
                        continue
                    lo, hi = rect[lateral] + 1.05, rect[lateral + 2] - 1.05
                    lo = max(lo, (-14.4, -8.0, 10.0)[pocket])
                    hi = min(hi, (-10.0, 8.0, 14.4)[pocket])
                    if lo <= hi:
                        center = min(hi, max(lo, target))
                        options.append((abs(center - target), i, center))
                _, room, center = min(options)
                external.append({"rooms": [room], "axis": axis, "at": at,
                                 "center": center, "width": 1.5, "height": 2.3,
                                 "edge": ("west" if sign < 0 else "east") if axis == 0 else
                                         ("north" if sign < 0 else "south"), "pocket": pocket})

    # A tree reaches every room. Edge exchanges concentrate unavoidable exterior
    # junctions, rather than adding a third doorway to nearly every small room.
    parents = list(range(len(rooms)))
    def root(i):
        while parents[i] != i:
            i = parents[i]
        return i
    order = list(range(len(seams)))
    rng.shuffle(order)
    tree = set()
    for edge in order:
        a, b = map(root, seams[edge]["rooms"])
        if a != b:
            parents[a] = b
            tree.add(edge)
    external_degree = [0] * len(rooms)
    for door in external:
        external_degree[door["rooms"][0]] += 1
    def score(edges):
        degrees = external_degree.copy()
        for edge in edges:
            for room in seams[edge]["rooms"]:
                degrees[room] += 1
        return sum(50 * (d > 2) + 4 * max(0, d - 3) + 150 * max(0, d - 4) for d in degrees)
    cost = score(tree)
    best, best_cost = tree.copy(), cost
    for iteration in range(12000):
        add = rng.randrange(len(seams))
        if add in tree:
            continue
        start, end = seams[add]["rooms"]
        adjacency = [[] for _ in rooms]
        for edge in tree:
            a, b = seams[edge]["rooms"]
            adjacency[a].append((b, edge))
            adjacency[b].append((a, edge))
        todo, previous = [start], {start: None}
        for room in todo:
            if room == end:
                break
            for neighbor, edge in adjacency[room]:
                if neighbor not in previous:
                    previous[neighbor] = (room, edge)
                    todo.append(neighbor)
        path, room = [], end
        while room != start:
            room, edge = previous[room]
            path.append(edge)
        remove = rng.choice(path)
        candidate = (tree - {remove}) | {add}
        candidate_cost = score(candidate)
        temperature = max(0.3, 18 * (1 - iteration / 12000))
        if candidate_cost <= cost or rng.random() < math.exp((cost - candidate_cost) / temperature):
            tree, cost = candidate, candidate_cost
            if cost < best_cost:
                best, best_cost = tree.copy(), cost

    doors = list(external)
    for edge, seam in enumerate(seams):
        if edge not in best:
            continue
        width = 1.35 if template.startswith("small") else 1.45
        lo, hi = seam["lo"] + 0.3 + width / 2, seam["hi"] - 0.3 - width / 2
        fraction = (0.18, 0.78, 0.36, 0.86, 0.25)[edge % 5]
        doors.append({**seam, "center": lo + (hi - lo) * fraction, "width": width, "height": 2.3})
    for i, door in enumerate(doors):
        door["id"] = f"{template}-door-{i + 1:02}"
        for room in door["rooms"]:
            rooms[room]["doors"].append(door)
    return rooms, seams, doors


def build(template, live):
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    builder.configure()
    mats = {family: bpy.data.objects[f"open-gallery {family}"].active_material
            for family in ("walls", "floor", "ceiling", "ceiling-lights")}
    for mat in mats.values():
        mat.use_fake_user = True
    groups = {family: [] for family in (*builder.RESOLUTIONS, "ceiling-lights")}
    for obj in list(bpy.data.objects):
        if obj.name in ("open-gallery walls", "open-gallery details") or (
                obj.get("bakeSupportOnly") and "continuation" in obj.name.lower()):
            bpy.data.objects.remove(obj, do_unlink=True)
    # Keep the checkpoint's exact carpet, ceiling vertices, phase, tints and UVs.
    retained = {}
    for family in ("floor", "ceiling", "ceiling-lights"):
        obj = bpy.data.objects[f"open-gallery {family}"]
        obj.name = f"{template} {family}"
        obj["surface"] = "ceiling-lights" if family == "ceiling-lights" else f"{template}-{family}"
        if family != "ceiling-lights":
            obj["radiance"] = f"{template}-{family}.hdr"
        retained[family] = obj
    colliders = []
    rooms, seams, doors = layout(template)

    def partition(axis, at, lo, hi, openings, name, outer=False):
        thickness = (at - 0.2, at) if outer and at > 0 else (
            (at, at + 0.2) if outer else (at - 0.1, at + 0.1))
        def rectangle(a, b):
            return (thickness[0], a, thickness[1], b) if axis == 0 else (a, thickness[0], b, thickness[1])
        cursor = lo
        for door in sorted(openings, key=lambda d: d["center"]):
            left, right = door["center"] - door["width"] / 2, door["center"] + door["width"] / 2
            if left > cursor + 0.001:
                builder.wall(name, *rectangle(cursor, left), 3, mats, groups, colliders)
            rect = rectangle(left, right)
            lintel = builder.cuboid(name + " lintel", *rect, 3, mats["walls"], bottom=door["height"])
            # cuboid intentionally omits bottom faces for ordinary walls; lintels
            # need a visible soffit above the actual walk-through opening.
            soffit = builder.mesh_object(name + " soffit", [
                (rect[0], -rect[1], door["height"]), (rect[2], -rect[1], door["height"]),
                (rect[2], -rect[3], door["height"]), (rect[0], -rect[3], door["height"])],
                [(0, 1, 2, 3)], mats["walls"])
            groups["walls"].extend((lintel, soffit))
            colliders.append({"min": [rect[0] - 0.015, door["height"], rect[1] - 0.015],
                              "max": [rect[2] + 0.015, 3, rect[3] + 0.015]})
            cursor = right
        if cursor < hi - 0.001:
            builder.wall(name, *rectangle(cursor, hi), 3, mats, groups, colliders)

    for axis in (0, 1):
        for sign in (-1, 1):
            partition(axis, sign * 14.4, -14.4, 14.4,
                      [d for d in doors if d.get("edge") and d["axis"] == axis and d["at"] == sign * 14.4],
                      f"{template} core boundary", outer=True)
            for lateral in (-9, 9):
                lo, hi = sorted((sign * 18, sign * 14.4))
                rect = (lo, lateral - 0.1, hi, lateral + 0.1) if axis == 0 else (lateral - 0.1, lo, lateral + 0.1, hi)
                builder.wall(f"{template} foyer divider", *rect, 3, mats, groups, colliders)
                lo, hi = sorted((sign * 18, sign * 25.2))
                rect = (lo, lateral - 0.1, hi, lateral + 0.1) if axis == 0 else (lateral - 0.1, lo, lateral + 0.1, hi)
                builder.wall("Ghost common continuation", *rect, 3, mats, groups, colliders, support=True)
    for i, seam in enumerate(seams):
        partition(seam["axis"], seam["at"], seam["lo"], seam["hi"],
                  [d for d in doors if d["rooms"] == seam["rooms"]], f"{template} partition {i}")

    with bpy.data.libraries.load(str(builder.LAYOUT_SOURCE), link=False) as (available, target):
        target.objects = sorted(n for n in available.objects if n.startswith("Lookdev outlet "))[:3]
    # Mount original outlet geometry just outside the south-facing core wall.
    south_rooms = [r for r in rooms if abs(r["rect"][3] - 14.4) < 0.001]
    for obj, room in zip(target.objects, south_rooms[:3]):
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = None
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = (math.pi / 2, 0, math.pi)
        lo, hi = room["rect"][0] + 0.25, room["rect"][2] - 0.25
        spans, cursor = [], lo
        for door in sorted((d for d in room["doors"] if d.get("edge") == "south"), key=lambda d: d["center"]):
            spans.append((cursor, door["center"] - door["width"] / 2 - 0.1))
            cursor = door["center"] + door["width"] / 2 + 0.1
        spans.append((cursor, hi))
        left, right = max(spans, key=lambda span: span[1] - span[0])
        x = (left + right) / 2
        obj.location = (x, -14.199, 0.34)
        obj.hide_render = False
        obj.hide_set(False)
        groups["details"].append(obj)
    bpy.context.view_layer.update()
    prepared = builder.prepare(template, {family: groups[family] for family in ("walls", "details")})
    prepared.update(retained)
    room_meta = []
    for room in rooms:
        x0, z0, x1, z1 = room["rect"]
        inset = [0.2 if abs(v) == 14.4 else 0.1 for v in (x0, z0, x1, z1)]
        room_meta.append({"id": room["id"],
                          "bounds": {"min": [x0 + inset[0], 0, z0 + inset[1]],
                                     "max": [x1 - inset[2], 3, z1 - inset[3]]},
                          "doorIds": [d["id"] for d in room["doors"]],
                          "doorCount": len(room["doors"]),
                          "kind": "relief" if max(x1 - x0, z1 - z0) > 8.5 and template.startswith("small") else "room"})
    anchors = [{"id": r["id"] + "-center", "roomId": r["id"], "kind": "floor",
                "position": [(r["bounds"]["min"][0] + r["bounds"]["max"][0]) / 2, 0,
                             (r["bounds"]["min"][2] + r["bounds"]["max"][2]) / 2],
                "yaw": 0, "clearance": [1.2, 2, 1.2]} for r in room_meta]
    index = min((i for i, r in enumerate(room_meta) if r["doorCount"] == 2),
                key=lambda i: sum(v * v for v in anchors[i]["position"]))
    x, _, z = anchors[index]["position"]
    front = rooms[index]["doors"][0]
    dx, dz = (front["at"], front["center"]) if front["axis"] == 0 else (front["center"], front["at"])
    spawn = {"position": [x, 1.65, z], "yaw": math.atan2(x - dx, z - dz), "pitch": -0.025}
    exporter.builder.source.camera_from_view(spawn)
    meta = {"id": template, "region": template.split("-")[0], "geometry": template + ".glb",
            "radiance": [{"file": f"{template}-{family}.hdr", "family": family,
                          "flipY": False, "resolution": resolution} for family, resolution in builder.RESOLUTIONS.items()],
            "colliders": colliders, "lights": copy.deepcopy(next(t for t in live["templates"] if t["id"] == "open-gallery")["lights"]),
            "rooms": room_meta, "anchors": anchors, "spawn": spawn,
            "doors": [{"id": d["id"], "roomIds": [rooms[i]["id"] for i in d["rooms"]],
                       "position": [d["at"], 0, d["center"]] if d["axis"] == 0 else [d["center"], 0, d["at"]],
                       "width": d["width"], "height": d["height"], "axis": "x" if d["axis"] == 0 else "z",
                       **({"edge": d["edge"], "pocket": d["pocket"]} if d.get("edge") else {})} for d in doors]}
    builder.write_json(WORK / f"{template}-metadata.json", meta)
    return prepared, meta


def export(template, groups):
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
    bpy.ops.export_scene.gltf(filepath=str(OUT / f"{template}.glb"), export_format="GLB", use_selection=True,
        export_materials="NONE", export_extras=True, export_yup=True, export_animations=False,
        export_cameras=False, export_lights=False, export_texcoords=True, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", choices=CONFIGS)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    WORK.mkdir(parents=True, exist_ok=True)
    live = json.loads((OUT / "modules.json").read_text())
    for template in ([args.template] if args.template else CONFIGS):
        groups, meta = build(template, live)
        for family, resolution in builder.RESOLUTIONS.items():
            image = exporter.image_target(groups[family], f"{template} {family} bake", resolution)
            builder.log(f"{template}: baking {family} {resolution}px, 128 Metal samples")
            pbr = family != "details"
            bpy.ops.object.bake(type="DIFFUSE" if pbr else "COMBINED",
                pass_filter={"DIRECT", "INDIRECT"} if pbr else {"DIRECT", "INDIRECT", "DIFFUSE", "EMIT"},
                uv_layer="LightmapUV", margin=0 if family in ("floor", "ceiling") else 8, margin_type="EXTEND")
            if pbr:
                exporter.denoise_lightmap(image)
            exporter.save_image(image, f"{template}-{family}.hdr")
        bpy.ops.wm.save_as_mainfile(filepath=str(WORK / f"{template}.blend"))
        export(template, groups)
        builder.log(f"{template}: ready, {len(meta['rooms'])} rooms")
    proposed = json.loads((OUT / "modules.json").read_text())
    for existing in proposed["templates"]:
        if existing["id"].startswith("open-"):
            existing["region"] = "large"
    for template in CONFIGS:
        metadata = WORK / f"{template}-metadata.json"
        if not metadata.exists() or not (OUT / f"{template}.glb").exists():
            continue
        proposed["templates"] = [t for t in proposed["templates"] if t["id"] != template]
        proposed["templates"].append(json.loads(metadata.read_text()))
        for family in builder.RESOLUTIONS:
            descriptor = copy.deepcopy(proposed["materials"][f"open-gallery-{family}"])
            descriptor["radiance" if family == "details" else "lightmap"] = f"{template}-{family}.hdr"
            proposed["materials"][f"{template}-{family}"] = descriptor
    builder.write_json(WORK / "modules.json", proposed)


if __name__ == "__main__":
    main()
