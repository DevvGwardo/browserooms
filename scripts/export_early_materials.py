"""Recover original wall/carpet PBR tiles without loading or saving a source scene.

/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
  --python scripts/export_early_materials.py
Append -- --resume to reuse completed raw bake checkpoints after interruption.
Only public/materials/early and assets/early-materials are written. No room bake.
"""

import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public/materials/early"
WORK = ROOT / "assets/early-materials"
SOURCE = ROOT / "assets/backrooms.blend"
SIZE = 2048
SPECS = {
    "wall": {
        "material": "Cream chevron paper - linen relief",
        "bakeMeters": [0.368, 0.448],
        "tileMeters": [0.36, 0.448],
        "uvRepeat": [0.5 / 0.36, 0.5 / 0.448],
        "uvRepeatExpression": ["0.5 / 0.36", "0.5 / 0.448"],
        "detail": "public/textures/wallpaper-detail.png",
        "roughness": 0.85,
        "normalXScale": 0.368 / 0.36,
    },
    "carpet": {
        "material": "Oatmeal loop-pile carpet",
        "bakeMeters": [2.0, 2.0],
        "tileMeters": [2.0, 2.0],
        "uvRepeat": [0.6, 0.6],
        "uvRepeatExpression": ["1.2 / 2.0", "1.2 / 2.0"],
        "detail": "public/textures/carpet-detail.png",
        "roughness": 0.94,
        "normalXScale": 1.0,
    },
}


def log(message):
    print("EARLY MATERIALS: " + message, flush=True)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def png(path, values):
    """Write exact RGB8 codes, with no implicit gamma or view transform."""
    data = np.uint8(np.rint(np.clip(values, 0, 1) * 255))
    height, width, _ = data.shape

    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload)))

    # All work arrays use Blender's bottom-to-top pixel convention.
    rows = b"".join(b"\x00" + row.tobytes() for row in data[::-1])
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))
    return data.astype(np.float32) / 255


def srgb(linear):
    linear = np.maximum(linear, 0)
    return np.where(linear <= 0.0031308, linear * 12.92,
                    1.055 * np.power(linear, 1 / 2.4) - 0.055)


def linear(codes):
    return np.where(codes <= 0.04045, codes / 12.92,
                    np.power((codes + 0.055) / 1.055, 2.4))


def periodic(values):
    """Moisan periodic-plus-smooth FFT decomposition, channel by channel.

    Remove only the smooth Poisson solution induced by edge discontinuities.
    Unlike mirroring/crossfading, this retains interior fibers and chevron phase.
    Edges need not be identical: their step should resemble an interior pixel step.
    """
    height, width, channels = values.shape
    denominator = (2 * np.cos(2 * np.pi * np.arange(height) / height)[:, None]
                   + 2 * np.cos(2 * np.pi * np.arange(width) / width)[None, :] - 4)
    denominator[0, 0] = 1
    output = np.empty_like(values)
    for channel in range(channels):
        image = values[:, :, channel]
        boundary = np.zeros((height, width), dtype=np.float64)
        boundary[0] = image[-1] - image[0]
        boundary[-1] = image[0] - image[-1]
        boundary[:, 0] += image[:, -1] - image[:, 0]
        boundary[:, -1] += image[:, 0] - image[:, -1]
        spectrum = np.fft.fft2(boundary) / denominator
        spectrum[0, 0] = 0
        output[:, :, channel] = image - np.fft.ifft2(spectrum).real
    return output


def edge_stats(values):
    result = {}
    for axis, name in [(1, "horizontal"), (0, "vertical")]:
        edge = np.abs(np.take(values, 0, axis=axis) - np.take(values, -1, axis=axis))
        interior = np.abs(np.diff(values, axis=axis))
        # Compare a wrap cut with every possible interior cut, not just one pixel.
        cuts = interior.mean(axis=(0, 2) if axis == 1 else (1, 2))
        result[name] = {
            "wrapMeanAbs": float(edge.mean()),
            "wrapMaxAbs": float(edge.max()),
            "interiorMeanAbs": float(interior.mean()),
            "interiorCutP95MeanAbs": float(np.percentile(cuts, 95)),
            "wrapToInteriorRatio": float(edge.mean() / max(interior.mean(), 1e-9)),
        }
    return result


def pixels(image):
    values = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(values)
    return values.reshape((image.size[1], image.size[0], 4))[:, :, :3].copy()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    protected = [SOURCE, ROOT / "assets/modules/gallery.blend", ROOT / "scripts/bake_scene.py",
                 ROOT / "scripts/make_surface_detail.py", ROOT / "scripts/bake_continuous_floor.py",
                 ROOT / "assets/browser-yellow-detail.png", ROOT / "assets/browser-desktop.png"]
    protected += [ROOT / spec["detail"] for spec in SPECS.values()]
    protected += sorted((ROOT / "public/continuous").glob("*-ceiling.hdr"))
    protected += sorted((ROOT / "public/continuous").glob("*.glb"))
    before = {str(p.relative_to(ROOT)): digest(p) for p in protected}
    manifest = ROOT / "public/continuous/modules.json"
    manifest_before = digest(manifest)
    (WORK / "source-checkpoint.json").write_text(json.dumps(before, indent=2) + "\n")

    # Append only original material datablocks. Never open or overwrite either scene.
    with bpy.data.libraries.load(str(SOURCE), link=False) as (available, loaded):
        names = [spec["material"] for spec in SPECS.values()]
        assert all(name in available.materials for name in names), available.materials
        loaded.materials = names
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.render.bake.margin = 0
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    bpy.context.preferences.filepaths.save_version = 0
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    planes = {}
    for prefix, spec in SPECS.items():
        mat = bpy.data.materials[spec["material"]]
        shader = next(n for n in mat.node_tree.nodes if n.type == "BSDF_DIFFUSE")
        assert shader.inputs["Color"].is_linked and shader.inputs["Normal"].is_linked
        spec["sourceDiffuseRoughnessOrenNayar"] = shader.inputs["Roughness"].default_value
        spec["sourceNodeTypes"] = sorted(n.bl_idname for n in mat.node_tree.nodes
                                         if n.type != "TEX_IMAGE")
        w, h = spec["bakeMeters"]
        vertices = ([(0, 0, 0), (w, 0, 0), (w, 0, h), (0, 0, h)] if prefix == "wall"
                    else [(0, 0, 0), (w, 0, 0), (w, h, 0), (0, h, 0)])
        mesh = bpy.data.meshes.new(prefix + " physical tile")
        mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
        mesh.update()
        uv = mesh.uv_layers.new(name="TileUV")
        uv.active_render = True
        for loop, coordinate in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
            loop.uv = coordinate
        plane = bpy.data.objects.new(mesh.name, mesh)
        scene.collection.objects.link(plane)
        mesh.materials.append(mat)
        planes[prefix] = plane
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK / "early-tile-checkpoint.blend"))
    log("Saved source hashes and isolated shader/swatch checkpoint")

    metadata = {
        "version": 1,
        "resolution": [SIZE, SIZE],
        "generator": "scripts/export_early_materials.py",
        "blenderVersion": bpy.app.version_string,
        "source": "assets/backrooms.blend (material datablocks only)",
        "sourceDefinition": "scripts/bake_scene.py:make_materials",
        "preservedComparisonScene": "assets/modules/gallery.blend",
        "bake": {"engine": "Cycles", "device": "CPU", "samples": 16,
                 "albedoPass": "DIFFUSE/COLOR only, no lighting, AO or view transform",
                 "normalPass": "NORMAL, TANGENT, +X +Y +Z (OpenGL)",
                 "roughness": "Matte PBR constants; source diffuse roughness is Oren-Nayar, not microfacet roughness"},
        "colorSpace": {"albedo": "sRGB", "normal": "Non-Color", "roughness": "Non-Color"},
        "textureSettings": {"flipY": False, "wrapS": "RepeatWrapping", "wrapT": "RepeatWrapping",
                            "normalConvention": "OpenGL +Y", "normalScale": [1, 1],
                            "minFilter": "LinearMipmapLinearFilter", "magFilter": "LinearFilter",
                            "generateMipmaps": True},
        "tint": "None. Apply latest continuous palette once in renderer. No surface-detail.ts legacy tint.",
        "detailComposition": "source linear basecolor * (old PNG raw Non-Color grayscale * 2.0); neutral 0.5",
        "seamMethod": "Moisan periodic-plus-smooth FFT on linear RGB before and after detail; on tangent normal XYZ before renormalizing. No mirroring, resynthesis or interior crossfade.",
        "uvConvention": "Current continuous geometry UV0; Blender UV V converted to glTF 1-V; PNG top-down, flipY=false",
        "materials": {},
    }

    for prefix, spec in SPECS.items():
        plane = planes[prefix]
        for obj in scene.objects:
            obj.select_set(obj == plane)
            obj.hide_render = obj != plane
        bpy.context.view_layer.objects.active = plane
        mat = plane.data.materials[0]
        raw_path = WORK / (prefix + "-source-bake.npz")
        fingerprint = {"source": before["assets/backrooms.blend"], "resolution": SIZE,
                       "material": spec["material"], "meters": spec["bakeMeters"]}
        cache_key = json.dumps(fingerprint, sort_keys=True)
        cached = np.load(raw_path) if args.resume and raw_path.exists() else None
        if cached is not None and str(cached["cacheKey"]) == cache_key:
            base, normal = cached["albedo"], cached["normal"]
            log("Resumed " + prefix + " raw bake")
        else:
            raw = {}
            for kind, bake_type in [("albedo", "DIFFUSE"), ("normal", "NORMAL")]:
                image = bpy.data.images.new(prefix + " " + kind, width=SIZE, height=SIZE,
                                            alpha=False, float_buffer=True)
                image.colorspace_settings.name = "Non-Color"
                target = mat.node_tree.nodes.new("ShaderNodeTexImage")
                target.image = image
                mat.node_tree.nodes.active = target
                log("Baking " + prefix + " " + kind)
                kwargs = {"pass_filter": {"COLOR"}} if kind == "albedo" else {}
                bpy.ops.object.bake(type=bake_type, uv_layer="TileUV", margin=0,
                                    normal_space="TANGENT", normal_r="POS_X",
                                    normal_g="POS_Y", normal_b="POS_Z", **kwargs)
                raw[kind] = pixels(image)
                mat.node_tree.nodes.remove(target)
                bpy.data.images.remove(image)
            base, normal = raw["albedo"], raw["normal"]
            np.savez_compressed(raw_path, albedo=base, normal=normal, cacheKey=cache_key)
            log("Saved " + prefix + " raw bake checkpoint")
        assert np.isfinite(base).all() and base.min() > 0
        assert np.std(normal[:, :, :2]) > 0.0001, "Normal bake unexpectedly flat"
        detail_image = bpy.data.images.load(str(ROOT / spec["detail"]), check_existing=False)
        detail_image.colorspace_settings.name = "Non-Color"
        detail_image.scale(SIZE, SIZE)
        detail = pixels(detail_image)[:, :, :1]
        # Old floor shader sampled Three world x,z; Blender floor uses x,y=-z.
        if prefix == "carpet":
            detail = detail[::-1].copy()
        bpy.data.images.remove(detail_image)
        source_with_detail = base * detail * 2
        albedo = periodic(periodic(base) * detail * 2)
        normals = periodic(normal * 2 - 1)
        normals[:, :, 0] *= spec["normalXScale"]
        normals /= np.linalg.norm(normals, axis=2, keepdims=True)
        assert np.isfinite(normals).all() and normals[:, :, 2].min() > 0
        assert albedo.min() > 0 and albedo.max() < 1, "Unexpected clipping"
        maps = {
            "albedo": srgb(albedo),
            "normal": normals * 0.5 + 0.5,
            "roughness": np.full((SIZE, SIZE, 3), spec["roughness"], dtype=np.float32),
        }
        result = dict(spec)
        result["maps"] = {}
        result["rawLinearRGBMean"] = base.mean(axis=(0, 1), dtype=np.float64).tolist()
        result["linearRGBMean"] = albedo.mean(axis=(0, 1), dtype=np.float64).tolist()
        result["detailMultiplierMean"] = float(detail.mean() * 2)
        result["rawSourceWithDetailEdges"] = edge_stats(srgb(source_with_detail))
        result["periodicCorrectionLinearRMS"] = float(np.sqrt(np.mean((albedo - source_with_detail) ** 2)))
        for kind, values in maps.items():
            filename = prefix + "-" + kind + ".png"
            saved = png(OUT / filename, values)
            result["maps"][kind] = {
                "file": filename, "url": "/materials/early/" + filename,
                "colorSpace": metadata["colorSpace"][kind],
                "rgbMean": saved.mean(axis=(0, 1), dtype=np.float64).tolist(),
                "sha256": digest(OUT / filename), "bytes": (OUT / filename).stat().st_size,
                "edges": edge_stats(saved),
            }
            if kind != "roughness":
                for axis in result["maps"][kind]["edges"].values():
                    assert axis["wrapToInteriorRatio"] < 2.5, (filename, axis)
            if kind == "normal":
                error = np.abs(np.linalg.norm(saved * 2 - 1, axis=2) - 1)
                result["normalUnitLengthMaxErrorRGB8"] = float(error.max())
                assert error.max() < 0.007
            if kind == "albedo":
                result["savedLinearRGBMean"] = linear(saved).mean(axis=(0, 1), dtype=np.float64).tolist()
        # Source/finished previews and an offset repeat put all four wraps in view.
        # Preview reduction is a box filter in linear space, not nearest sampling.
        def thumb(values, step=4):
            return values.reshape(SIZE // step, step, SIZE // step, step, 3).mean(axis=(1, 3))

        source_thumb = srgb(thumb(source_with_detail))
        final_thumb = srgb(thumb(albedo))
        png(WORK / (prefix + "-source-vs-tile.png"), np.concatenate([source_thumb, final_thumb], axis=1))
        repeat = np.tile(np.roll(final_thumb, (256, 256), axis=(0, 1)), (2, 2, 1))
        png(WORK / (prefix + "-repeat.png"), repeat)
        png(WORK / (prefix + "-normal-preview.png"), thumb(maps["normal"]))
        # Full-resolution central repeat crossing, avoiding thumbnail loss of fibers.
        shifted = np.roll(maps["albedo"], (SIZE // 2, SIZE // 2), axis=(0, 1))
        png(WORK / (prefix + "-seam-closeup.png"), shifted[SIZE // 2 - 384:SIZE // 2 + 384,
                                                                          SIZE // 2 - 384:SIZE // 2 + 384])
        metadata["materials"][prefix] = result
        log(prefix + " complete: " + json.dumps(result["maps"]["albedo"]["edges"]))

    after = {str(p.relative_to(ROOT)): digest(p) for p in protected}
    assert before == after, "A protected source/geometry/ceiling file changed during export"
    metadata["preservation"] = {"allSourceGeometryAndCeilingHashesUnchanged": True,
                                "sha256": after, "manifestSHA256Before": manifest_before,
                                "manifestSHA256After": digest(manifest),
                                "manifestWritten": False, "liveBlenderAccessed": False}
    metadata["generatorSHA256"] = digest(Path(__file__))
    (OUT / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (WORK / "verification.json").write_text(json.dumps({
        "protectedFilesUnchanged": before == after,
        "protectedSHA256": after,
        "wallRepeat": SPECS["wall"]["uvRepeat"],
        "carpetRepeat": SPECS["carpet"]["uvRepeat"],
        "checks": ["finite nonblack albedo without clipping", "nonflat original shader bump normals",
                   "OpenGL +Y normals renormalized after periodicization and wall gradient scaling",
                   "RGB8 unit normal length error below 0.007",
                   "wrap cuts compared with interior cuts on delivered RGB8 maps",
                   "source scenes, detail PNGs, current geometry and ceiling byte-identical"],
    }, indent=2) + "\n")
    log("Finished. No source scene, current ceiling, manifest or renderer was written.")


if __name__ == "__main__":
    main()
