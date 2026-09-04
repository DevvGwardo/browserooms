"""Verify both arms hang down in a nub GLB (GATES_ARMS).

Composes FULL joint matrices (translation + rotation + scale) through the
node parent chain — GLB is Y-up, so down is -Y. (An earlier revision composed
translations only and falsely failed: the down-pose lives in node rotations.)
Each arm segment (Shoulder->Arm->Hand, both sides) must hang >= 70deg below
horizontal, and the elbow must stay nearly straight (upper/forearm direction
cosine >= 0.97, i.e. the forearm was not bent at the elbow to fake it).
"""

import json
import math
import struct
import sys

import numpy as np


def node_matrix(n: dict) -> np.ndarray:
    t = np.array(n.get("translation", [0, 0, 0]))
    q = np.array(n.get("rotation", [0, 0, 0, 1]))
    s = np.array(n.get("scale", [1, 1, 1]))
    x, y, z, w = q
    rot = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
    m = np.eye(4)
    m[:3, :3] = rot * s
    m[:3, 3] = t
    return m


def main():
    path = sys.argv[-1]
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"glTF", "not a GLB"
    length = struct.unpack("<I", data[12:16])[0]
    js = json.loads(data[20 : 20 + length])
    nodes = js["nodes"]
    idx = {n["name"]: k for k, n in enumerate(nodes)}
    parents: dict[int, int] = {}
    for k, n in enumerate(nodes):
        for c in n.get("children", []):
            parents[c] = k

    def world(name: str) -> np.ndarray:
        m = np.eye(4)
        chain = []
        n = idx[name]
        while True:
            chain.append(n)
            if n not in parents:
                break
            n = parents[n]
        for k in reversed(chain):
            m = m @ node_matrix(nodes[k])
        return m[:3, 3]

    parts = {}
    for side in ("R", "L"):
        segs = []
        for a, b in [
            (f"Shoulder_{side}", f"Arm_{side}"),
            (f"Arm_{side}", f"Hand_{side}"),
        ]:
            v = world(b) - world(a)
            v = v / np.linalg.norm(v)
            down = math.degrees(math.asin(max(-1.0, min(1.0, -v[1]))))
            segs.append((a, b, v, down))
            assert down >= 70.0, f"{a}->{b} only {down:.0f}deg down"
        # Elbow straightness: upper vs forearm direction cosine.
        cos_elbow = float(np.dot(segs[0][2], segs[1][2]))
        assert cos_elbow >= 0.97, f"elbow bent (cos={cos_elbow:.3f})"
        parts[side] = [round(s[3]) for s in segs]
    print(f"ARMS-OK R={parts['R']} L={parts['L']} (deg below horizontal)")


main()
