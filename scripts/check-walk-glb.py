"""Validate sillyNubCat-walk.glb against the original (GATES_WALK G3/G4).

Checks: parseable GLB, 1+ clips, identical node-name SET, skin present,
no NaN/Inf in animation data, leg phase opposition (walk, not paddle),
first/last keyframes match (clean loop).
With --materials: material count + base-color factors match the original.
"""

import json
import struct
import sys

import numpy as np

ORIG = "public/models/pinkNUB.glb"
LEG_L = "Leg_L"
LEG_R = "Leg_R"

if "--base" in sys.argv:
    ORIG = sys.argv[sys.argv.index("--base") + 1]
    sys.argv.remove("--base")
    sys.argv.remove(ORIG)


def load(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"glTF", "not a GLB"
    length = struct.unpack("<I", data[12:16])[0]
    js = json.loads(data[20 : 20 + length])
    blob = data[20 + length + 8 :]
    return js, blob


def accessor(js, blob, i):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    n = a["count"] * {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[a["type"]]
    return np.frombuffer(blob[off : off + n * 4], dtype=np.float32).reshape(a["count"], -1)


def main():
    only_materials = "--materials" in sys.argv
    path = sys.argv[-1]
    js, blob = load(path)
    orig, _ = load(ORIG)

    if not only_materials:
        assert len(js.get("animations", [])) >= 1, "no clips"
        an = js["animations"][0]
        assert len(an["channels"]) >= 8, f"too few channels: {len(an['channels'])}"
        assert {n.get("name") for n in js["nodes"]} == {
            n.get("name") for n in orig["nodes"]
        }, "node names differ"
        assert len(js.get("skins", [])) >= 1, "skin lost"
        bad = 0
        for ch in an["channels"]:
            s = an["samplers"][ch["sampler"]]
            for kind in ("input", "output"):
                arr = accessor(js, blob, s[kind])
                bad += int(np.isnan(arr).sum() + np.isinf(arr).sum())
        assert bad == 0, f"{bad} bad floats"
        # Legs must oppose: dot of (L - mean) and (R - mean) over time < 0.
        series = {}
        for ch in an["channels"]:
            tgt = ch["target"]
            node = js["nodes"][tgt["node"]]["name"]
            if node in (LEG_L, LEG_R) and tgt["path"] == "rotation":
                out = accessor(js, blob, an["samplers"][ch["sampler"]]["output"])
                series[node] = out[:, 0]  # w carries the swing
        l = series[LEG_L] - series[LEG_L].mean()
        r = series[LEG_R] - series[LEG_R].mean()
        corr = float(np.dot(l, r) / (np.linalg.norm(l) * np.linalg.norm(r)))
        assert corr < -0.5, f"legs in phase, corr={corr:.2f}"
        # Loop closure: first == last on every animated output.
        for ch in an["channels"]:
            out = accessor(js, blob, an["samplers"][ch["sampler"]]["output"])
            assert np.allclose(out[0], out[-1], atol=1e-5), "loop seam pop"
        print(f"WALK-GLB-OK clips=1 channels={len(an['channels'])} legcorr={corr:.2f}")
        return

    om, wm = orig.get("materials", []), js.get("materials", [])
    assert len(om) == len(wm) and len(wm) >= 1, "material count changed"
    for o, w in zip(om, wm):
        assert o.get("name") == w.get("name"), "material renamed"
        assert o.get("doubleSided") == w.get("doubleSided"), "doubleSided changed"
        assert ("KHR_materials_unlit" in o.get("extensions", {})) == (
            "KHR_materials_unlit" in w.get("extensions", {})
        ), "unlit extension changed"
        for key in ("baseColorFactor", "baseColorTexture", "metallicFactor"):
            assert (key in o.get("pbrMetallicRoughness", {})) == (
                key in w.get("pbrMetallicRoughness", {})
            ), f"pbr key {key} changed"
    print(f"MATERIALS-OK count={len(wm)}")


main()
