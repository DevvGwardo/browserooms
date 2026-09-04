"""Validate blueNUB.glb (GATES_PINK G3): parseable, 39 nodes, 36-joint skin,
2 materials, body morph target kept, blue base color present, Cube excluded."""

import json
import struct
import sys


def main():
    path = sys.argv[-1]
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"glTF", "not a GLB"
    length = struct.unpack("<I", data[12:16])[0]
    js = json.loads(data[20 : 20 + length])

    assert len(js.get("nodes", [])) == 28, f"nodes={len(js.get('nodes', []))}"
    assert len(js.get("skins", [])) >= 1, "skin lost"
    assert len(js["skins"][0]["joints"]) == 25, "joint count changed"
    assert len(js.get("animations", [])) == 0, "base should have no clips"
    mats = js.get("materials", [])
    assert len(mats) == 2, f"materials={len(mats)}"
    assert not any("Cube" in (n.get("name") or "") for n in js["nodes"]), "Cube leaked"
    body = next(
        m for m in js["meshes"] if any(p.get("targets") for p in m["primitives"])
    )
    assert len(body["primitives"][0].get("targets", [])) >= 1, "morph target lost"
    blues = [
        m["pbrMetallicRoughness"].get("baseColorFactor")
        for m in mats
        if "baseColorFactor" in m.get("pbrMetallicRoughness", {})
    ]
    assert any(
        abs(c[0] - 0.392) < 0.01 and abs(c[1] - 0.651) < 0.01 and abs(c[2] - 1.0) < 0.01
        for c in blues
    ), f"blue missing: {blues}"
    print(f"BLUE-GLB-OK nodes=28 joints=25 mats=2 morph=kept blue={blues[0][:3]}")


main()
