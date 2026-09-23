#!/usr/bin/env python
"""
Tripo 资产检查器：把一个 GLB/FBX 产物的关键事实打印出来。

用途：
    - 确认 geometry 是不是 T-pose（T-pose 是绑骨和 clip 复用的前提）
    - 确认 rig 的骨骼数、命名、rest pose
    - 确认蒙皮/贴图/动画是否齐全

用法：
    python inspect_asset.py <file.glb> [--render out.png] [--json]
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np


# ------------------------------------------------------------------
# GLB 解析
# ------------------------------------------------------------------

CTYPE = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load_glb(path: Path):
    raw = path.read_bytes()
    if raw[:4] != b"glTF":
        raise ValueError(f"不是 GLB 文件：{path}（FBX 请先转成 GLB，或用 --fbx 说明）")
    json_len = struct.unpack("<I", raw[12:16])[0]
    gltf = json.loads(raw[20 : 20 + json_len])
    bin_off = 20 + json_len + 8
    return gltf, raw, bin_off


def accessor(gltf, raw, bin_off, index):
    a = gltf["accessors"][index]
    bv = gltf["bufferViews"][a["bufferView"]]
    off = bin_off + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    fmt, size = CTYPE[a["componentType"]]
    n = NCOMP[a["type"]]
    arr = np.frombuffer(raw, f"<{fmt}", count=a["count"] * n, offset=off)
    return arr.reshape(a["count"], n).astype(np.float64)


# ------------------------------------------------------------------
# 变换
# ------------------------------------------------------------------

def quat_to_mat(q):
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def local_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"]).reshape(4, 4).T
    m = np.eye(4)
    m[:3, :3] = quat_to_mat(node.get("rotation", [0, 0, 0, 1])) @ np.diag(node.get("scale", [1, 1, 1]))
    m[:3, 3] = node.get("translation", [0, 0, 0])
    return m


def world_matrices(gltf):
    nodes = gltf["nodes"]
    out: dict[int, np.ndarray] = {}

    def walk(i, parent):
        m = parent @ local_matrix(nodes[i])
        out[i] = m
        for c in nodes[i].get("children", []):
            walk(c, m)

    for r in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    return out


# ------------------------------------------------------------------
# 网格拓扑
# ------------------------------------------------------------------

def components(positions, faces, tol=1e-5):
    """按位置量化做并查集，返回 (连通块数, 最大块占比, 边界边数, 非流形边数)。"""
    q = np.round(positions / tol).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    t = inv[faces]
    parent = np.arange(inv.max() + 1)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    e = np.vstack([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    for a, b in e:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    roots = np.array([find(i) for i in range(len(parent))])
    _, sizes = np.unique(roots, return_counts=True)
    es = np.sort(e, axis=1)
    _, cnt = np.unique(es, axis=0, return_counts=True)
    return len(sizes), sizes.max() / sizes.sum(), int((cnt == 1).sum()), int((cnt > 2).sum())


# ------------------------------------------------------------------
# 渲染（点云 z-buffer，足够看清朝向/姿势）
# ------------------------------------------------------------------

def render(positions, normals, view_dir, lo, hi, w, h, out_path: Path):
    from PIL import Image, ImageDraw

    c = np.array(view_dir, float)
    c /= np.linalg.norm(c)
    right = np.cross([0, 1, 0.0], c)
    right /= np.linalg.norm(right)

    u, v, d, nd = positions @ right, positions[:, 1], positions @ c, normals @ c
    m = (v >= lo) & (v <= hi)
    u, v, d, nd = u[m], v[m], d[m], nd[m]

    half = max(hi - lo, 1e-6) * 0.62
    px = np.clip(((u / half * 0.5 + 0.5) * w).astype(int), 0, w - 1)
    py = np.clip(((1 - (v - lo) / (hi - lo)) * (h - 1)).astype(int), 0, h - 1)

    zb = np.full((h, w), -1e9)
    np.maximum.at(zb, (py, px), d)
    img = np.zeros((h, w, 3), np.float32)
    hit = d >= zb[py, px] - 1e-9
    lam = np.clip(nd * 0.8 + 0.2, 0, 1) * 0.85 + 0.15
    base = np.array([0.60, 0.67, 0.79])
    for k in range(3):
        np.maximum.at(img[:, :, k], (py[hit], px[hit]), base[k] * lam[hit])
    bg = np.full((h, w, 3), 0.07, np.float32)
    img = np.where(img.sum(2, keepdims=True) > 0, img, bg)

    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(out_path)


# ------------------------------------------------------------------
# 主流程
# ------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--render", help="渲染三视图到这个前缀")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    path = Path(args.file)
    gltf, raw, bin_off = load_glb(path)

    info: dict = {"file": str(path), "size_mb": round(path.stat().st_size / 1048576, 2)}

    print("=" * 66)
    print(f"文件：{path.name}   {info['size_mb']} MB")
    print("=" * 66)

    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    skins = gltf.get("skins", [])
    anims = gltf.get("animations", [])
    print(f"  nodes {len(nodes)} | meshes {len(meshes)} | skins {len(skins)} | animations {len(anims)}")
    print(f"  materials {len(gltf.get('materials', []))} | images {len(gltf.get('images', []))}")
    info.update(nodes=len(nodes), meshes=len(meshes), skins=len(skins), animations=len(anims),
                materials=len(gltf.get("materials", [])), images=len(gltf.get("images", [])))

    # ---- 顶点 ----
    prim = meshes[0]["primitives"][0]
    V = accessor(gltf, raw, bin_off, prim["attributes"]["POSITION"])
    attrs = list(prim["attributes"].keys())
    idx = accessor(gltf, raw, bin_off, prim["indices"]).astype(np.int64) if "indices" in prim else None
    F = idx.reshape(-1, 3) if idx is not None else np.arange(len(V)).reshape(-1, 3)
    print(f"\n  顶点 {len(V):,}  三角面 {len(F):,}")
    print(f"  属性 {attrs}")

    bb0, bb1 = V.min(0), V.max(0)
    dim = bb1 - bb0
    print(f"  包围盒 min {np.round(bb0,4)}  max {np.round(bb1,4)}")
    print(f"  尺寸 X{dim[0]:.4f}  Y{dim[1]:.4f}  Z{dim[2]:.4f}")
    info.update(vertices=len(V), triangles=len(F), attributes=attrs,
                bbox=[[float(x) for x in bb0], [float(x) for x in bb1]],
                dims=[float(x) for x in dim])

    # ---- 姿势判定（用网格本身，不需要骨骼）----
    print("\n  --- 姿势判定 ---")
    if len(skins) == 0:
        # T-pose：左右跨度（水平手臂）应接近身高
        height = dim[1]
        # 找左右轴：取高度中段以上（手臂所在高度）的横向最大跨度
        arm_band = V[(V[:, 1] > bb0[1] + height * 0.65) & (V[:, 1] < bb0[1] + height * 0.85)]
        if len(arm_band):
            spans = {ax: arm_band[:, ax].max() - arm_band[:, ax].min() for ax in (0, 2)}
            lat = max(spans, key=spans.get)
            print(f"    手臂高度带上的横向跨度：X{spans[0]:.4f}  Z{spans[2]:.4f}  → 左右轴 = {'XZ'[lat*2//2] if False else ['X','Y','Z'][lat]}")
            print(f"    手臂跨度 / 身高 = {spans[lat]/height:.3f}   （T-pose 应 ≈ 1.0；垂臂 ≈ 0.3）")
            verdict = "T-POSE ✅" if spans[lat] / height > 0.75 else (
                "A-pose / 垂臂 ⚠️" if spans[lat] / height > 0.45 else "垂臂 ❌"
            )
            print(f"    ⇒ {verdict}")
            info["arm_span_over_height"] = float(spans[lat] / height)
            info["pose_verdict"] = verdict
            info["lateral_axis"] = ["X", "Y", "Z"][lat]
    else:
        print("    （有骨骼，见下方 rest pose 分析）")

    # ---- 拓扑 ----
    ncomp, biggest, bnd, nonman = components(V, F)
    print("\n  --- 拓扑 ---")
    print(f"    连通块 {ncomp}   最大块占比 {biggest*100:.1f}%")
    print(f"    边界边 {bnd:,}   非流形边 {nonman:,}")
    info.update(components=ncomp, biggest_ratio=float(biggest), boundary_edges=bnd, nonmanifold_edges=nonman)

    # ---- 骨骼 ----
    if skins:
        skin = skins[0]
        joints = skin["joints"]
        names = [nodes[j].get("name", f"<node{j}>") for j in joints]
        print("\n  --- 骨骼 ---")
        print(f"    joints {len(joints)}   有 inverseBindMatrices: {'inverseBindMatrices' in skin}")
        print(f"    命名前缀：{sorted({n.split(':')[0].split('_')[0] for n in names})[:4]}")
        info.update(joints=len(joints), joint_names=names)

        wm = world_matrices(gltf)
        pos = {n: wm[j][:3, 3] for n, j in zip(names, joints)}

        def get(*cands):
            for c in cands:
                for n in names:
                    if n.split(":")[-1].lower() == c.lower():
                        return pos[n]
            return None

        lsh, rsh = get("LeftShoulder", "LeftArm"), get("RightShoulder", "RightArm")
        lh, rh = get("LeftHand"), get("RightHand")
        la, ra = get("LeftArm", "LeftUpperArm"), get("RightArm", "RightUpperArm")
        le, re_ = get("LeftForeArm", "LeftLowerArm"), get("RightForeArm", "RightLowerArm")

        print("\n  --- rest pose ---")
        if lsh is not None and lh is not None:
            print(f"    左肩 y={lsh[1]:.4f}  左手 y={lh[1]:.4f}   差 {abs(lh[1]-lsh[1]):.4f}")
            print(f"    右肩 y={rsh[1]:.4f}  右手 y={rh[1]:.4f}   差 {abs(rh[1]-rsh[1]):.4f}")
        for tag, a, e in (("左", la, le), ("右", ra, re_)):
            if a is not None and e is not None and np.linalg.norm(e - a) > 1e-9:
                d = (e - a) / np.linalg.norm(e - a)
                ang = np.degrees(np.arcsin(np.clip(abs(d[1]), 0, 1)))
                print(f"    {tag}上臂与水平面夹角 {ang:6.2f}°   方向 {np.round(d,3)}")
                info[f"{'left' if tag=='左' else 'right'}_arm_angle_deg"] = float(ang)
        if lh is not None and rh is not None:
            span = abs(lh[0] - rh[0]) + abs(lh[2] - rh[2])
            print(f"    双手横向跨度 {span:.4f}   身高 {dim[1]:.4f}")
            info["hand_span"] = float(span)
        hip = get("Hips")
        head = get("Head")
        if hip is not None and head is not None:
            print(f"    hips y={hip[1]:.4f}  head y={head[1]:.4f}  → 身高 {head[1]-hip[1]:.4f}")
            # 只有【网格高度】能判单位是不是米（VRM 要求米制、成人 1.4-2.1）。
            # 别用 hips→head 的躯干长去推，那会把 0.98 单位的模型误判成"米制"。
            _h = dim[1]
            print(
                "    （尺度：" + (
                    f"米制、成人身高 ✅ {_h:.3f} m" if 1.4 <= _h <= 2.1
                    else f"⚠️ 疑似归一化到 ~1 单位（高 {_h:.3f}）→ 需缩放 ×{1.7/_h:.2f}"
                ) + "）"
            )
            info["hips_head_dy"] = float(head[1] - hip[1])

    # ---- 渲染 ----
    if args.render:
        N = accessor(gltf, raw, bin_off, prim["attributes"]["NORMAL"])
        N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        lo, hi = bb0[1], bb1[1]
        outs = []
        for tag, vd in (("front+X", (1, 0, 0)), ("front-X", (-1, 0, 0)), ("front+Z", (0, 0, 1)), ("front-Z", (0, 0, -1))):
            p = Path(f"{args.render}_{tag.replace('+','p').replace('-','m')}.png")
            render(V, N, vd, lo, hi, 420, 900, p)
            outs.append(str(p))
        print("\n  已渲染：")
        for o in outs:
            print(f"    {o}")

    if args.json:
        print("\n--- JSON ---")
        print(json.dumps(info, ensure_ascii=False, indent=2))
    print("=" * 66)


if __name__ == "__main__":
    main()
