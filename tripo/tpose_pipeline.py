#!/usr/bin/env python
"""
Tripo T-pose 资产管线：参考图 -> T-pose 3D -> 自动绑骨

为什么单独一个脚本（而不是塞进 tripo.py）：
    官方 API 里 `t_pose` 属于 **generate_image** 接口，不属于 image_to_model。
    要拿到"绑骨友好的 T-pose 模型"，正确顺序是：

        ① upload         上传原始照片
        ② generate_image t_pose=true / template=t_pose  -> 标准 T-pose 参考图
        ③ image_to_model 从参考图重建 3D                 -> T-pose 的几何
        ④ animate_rig    自动绑骨                        -> 带骨骼模型

    分阶段执行是刻意的：②的产物（参考图）很便宜且**肉眼可判**，
    先看再决定要不要继续花后面的积分。状态存在 state.json，可随时续跑。

用法：
    # 只做第 ①② 步（产出 T-pose 参考图，便宜、可肉眼检查）
    python tpose_pipeline.py --image D:/Active-Desktop-Pet/trail.jpg --upto ref

    # 看过参考图满意后，续跑 ③
    python tpose_pipeline.py --run output/tpose_20260923_xxxxxx --upto model

    # 再续跑 ④
    python tpose_pipeline.py --run output/tpose_20260923_xxxxxx --upto rig
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from dotenv import load_dotenv


# ============================================================
# 配置
# ============================================================

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

API_KEY = os.getenv("TRIPO_API_KEY") or os.getenv("api_key")
if not API_KEY:
    raise RuntimeError(
        "未找到 Tripo API Key。请在 tripo/.env 中设置 "
        "TRIPO_API_KEY=tsk_...（仍兼容原来的 api_key）。"
    )

BASE_URL = os.getenv("TRIPO_BASE_URL", "https://api.tripo3d.com/v2/openapi").rstrip("/")
HEADERS = {"Authorization": f"Bearer {API_KEY}"}
JSON_HEADERS = {**HEADERS, "Content-Type": "application/json"}

# --- ② T-pose 参考图（generate_image）---
# 模板清单里 t_pose 标注 "Best with: Nano Banana, ar 1:1"。
IMAGE_MODEL_VERSION = os.getenv("TRIPO_IMAGE_MODEL_VERSION", "gemini_2.5_flash_image_preview")
IMAGE_TEMPLATE = os.getenv("TRIPO_IMAGE_TEMPLATE", "t_pose")
IMAGE_PROMPT = os.getenv(
    "TRIPO_IMAGE_PROMPT",
    "Full body photo of the same person standing in a strict T-pose: arms fully "
    "horizontal and straight out to the sides, palms facing down, legs straight and "
    "slightly apart, facing the camera directly. Keep the person's identity, face, "
    "hairstyle and clothing identical to the reference image. Plain light grey "
    "background, even lighting, whole body visible from head to toe, nothing cropped.",
)

# --- ③ 几何（image_to_model）---
MODEL_VERSION = os.getenv("TRIPO_MODEL_VERSION", "v3.1-20260211")
GEOMETRY_QUALITY = os.getenv("TRIPO_GEOMETRY_QUALITY", "detailed")
FACE_LIMIT = int(os.getenv("TRIPO_FACE_LIMIT", "100000"))
ENABLE_IMAGE_AUTOFIX = os.getenv("TRIPO_ENABLE_IMAGE_AUTOFIX", "true").lower() in {
    "1", "true", "yes", "on",
}

# --- ③b 贴图（texture_model，独立高级贴图）---
TEXTURE_MODEL_VERSION = os.getenv("TRIPO_TEXTURE_MODEL_VERSION", "v3.0-20250812")
TEXTURE_QUALITY = os.getenv("TRIPO_TEXTURE_QUALITY", "detailed")

# --- ④ 绑骨（animate_rig）---
RIG_MODEL_VERSION = os.getenv("RIG_MODEL_VERSION", "v1.0-20240301")
RIG_SPEC = os.getenv("TRIPO_RIG_SPEC", "mixamo")
# ★ 官方 `out_format` 默认就是 glb，而且我们真正需要的就是它：
#   - glb 的贴图是**内嵌**在 bufferView 里；fbx 导出的是 /mnt/pfs/server/... 这种
#     外链绝对路径，浏览器里必然 404（本轮实测踩到）。
#   - glb 转 VRM 是纯 JSON 注入（VRMC_vrm 扩展），不需要 Blender。
RIG_FORMAT = os.getenv("TRIPO_RIG_FORMAT", "glb").lower()

POLL_INTERVAL = float(os.getenv("TRIPO_POLL_INTERVAL", "3"))
TIMEOUT = int(os.getenv("TRIPO_TIMEOUT", "1800"))

DEFAULT_IMAGE = r"D:/Active-Desktop-Pet/trail.jpg"
DEFAULT_OUTPUT_ROOT = str(HERE / "output")


# ============================================================
# 基础工具
# ============================================================

def check(response: requests.Response) -> dict:
    """校验 HTTP + Tripo 业务码，失败时完整回显服务端信息。"""
    try:
        data = response.json()
    except ValueError:
        data = None

    if not response.ok:
        detail = json.dumps(data, indent=2, ensure_ascii=False) if data else (
            response.text.strip() or "（响应正文为空）"
        )
        hint = ""
        if response.status_code == 401:
            hint = "\n提示：API Key 可能不正确或已失效。"
        elif response.status_code == 403:
            hint = "\n提示：鉴权通过但请求被拒，常见原因是余额不足、模型权限不足或内容策略限制。"
        raise RuntimeError(
            f"Tripo API HTTP {response.status_code} {response.reason}\n"
            f"请求：{response.request.method} {response.url}\n响应：\n{detail}{hint}"
        )

    if data is None:
        raise RuntimeError("Tripo 返回了非 JSON 响应：\n" + (response.text.strip() or "（空）"))

    if data.get("code") != 0:
        raise RuntimeError("Tripo 业务错误：\n" + json.dumps(data, indent=2, ensure_ascii=False))

    return data


def balance() -> tuple[float, float]:
    result = check(requests.get(f"{BASE_URL}/user/balance", headers=HEADERS, timeout=30))
    account = result.get("data", {})
    return float(account.get("balance", 0)), float(account.get("frozen", 0))


def post_task(payload: dict, label: str) -> str:
    print(f"\n>>> 创建任务：{label}")
    print("    参数：" + json.dumps(payload, ensure_ascii=False))
    result = check(requests.post(f"{BASE_URL}/task", headers=JSON_HEADERS, json=payload, timeout=60))
    task_id = result["data"]["task_id"]
    print(f"    task_id: {task_id}")
    return task_id


def wait(task_id: str, label: str) -> dict:
    print(f"\n>>> 等待：{label}  ({task_id})")
    started = time.time()
    last = None
    while True:
        if time.time() - started > TIMEOUT:
            raise TimeoutError(f"{label} 等待超过 {TIMEOUT} 秒")

        data = check(requests.get(f"{BASE_URL}/task/{task_id}", headers=HEADERS, timeout=60))["data"]
        status, progress = data.get("status"), data.get("progress", 0)

        if progress != last or status != "running":
            print(f"    状态：{status}  进度：{progress}%   （已等待 {time.time()-started:.0f}s）")
            last = progress

        if status == "success":
            credits = data.get("credits_consumed", data.get("consumed_credit"))
            print(f"    ✅ 完成，消耗积分：{credits}")
            return data

        if status in {"failed", "failure", "cancelled", "canceled", "banned", "expired"}:
            raise RuntimeError(f"{label} 失败：\n" + json.dumps(data, indent=2, ensure_ascii=False))

        time.sleep(POLL_INTERVAL)


# ------------------------------------------------------------
# 下载
# ------------------------------------------------------------

def _collect_urls(obj, path="output") -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            items.extend(_collect_urls(v, f"{path}.{k}"))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            items.extend(_collect_urls(v, f"{path}.{i}"))
    elif isinstance(obj, str) and obj.startswith(("http://", "https://")):
        items.append((path, obj))
    return items


def _safe(name: str) -> str:
    name = re.sub(r"[^0-9A-Za-z._-]+", "_", name).strip("._")
    return name or "file"


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 9999):
        cand = path.with_name(f"{path.stem}_{i}{path.suffix}")
        if not cand.exists():
            return cand
    raise RuntimeError(f"无法生成不重复文件名：{path}")


def _filename(response: requests.Response, url: str) -> str:
    disp = response.headers.get("Content-Disposition", "")
    m = re.search(r"filename\*?=(?:UTF-8''|\")?([^\";]+)", disp, re.I)
    if m and m.group(1).strip().strip('"'):
        return Path(unquote(m.group(1).strip().strip('"'))).name
    return Path(unquote(Path(urlparse(url).path).name)).name or "download"


def _ext_from_type(ctype: str) -> str:
    return {
        "model/gltf-binary": ".glb",
        "model/gltf+json": ".gltf",
        "application/zip": ".zip",
        "application/x-zip-compressed": ".zip",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }.get(ctype.lower().split(";", 1)[0].strip(), "")


def _unzip(zip_path: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    root = out_dir.resolve()
    got: list[Path] = []
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            target = (out_dir / member.filename).resolve()
            if os.path.commonpath([str(root), str(target)]) != str(root):
                raise RuntimeError(f"ZIP 含不安全路径：{member.filename}")
            zf.extract(member, out_dir)
            if not member.is_dir():
                got.append(target)
    return got


def download(output: dict, dest: Path, hints: dict[str, str] | None = None) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    hints = hints or {}
    got: list[Path] = []
    seen: set[str] = set()

    for field, url in _collect_urls(output):
        if url in seen:
            continue
        seen.add(url)

        r = requests.get(url, stream=True, timeout=600)
        r.raise_for_status()

        original = _filename(r, url)
        suffix = Path(original).suffix or _ext_from_type(r.headers.get("Content-Type", ""))

        hint = hints.get(url)
        if hint:
            name = _safe(hint) + suffix
        elif original != "download":
            name = _safe(original)
            if suffix and not Path(name).suffix:
                name += suffix
        else:
            name = _safe(field.replace("output.", "")) + suffix

        path = _unique(dest / name)
        with open(path, "wb") as fh:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    fh.write(chunk)
        got.append(path.resolve())
        size = path.stat().st_size
        print(f"    已保存 {path.name}  ({size/1024/1024:.2f} MB)")

        if path.suffix.lower() == ".zip" or "zip" in r.headers.get("Content-Type", "").lower():
            got.extend(_unzip(path, dest / f"{path.stem}_files"))

    if not got:
        print("    ⚠️ output 里没有可下载的 URL")
    return got


# ============================================================
# 状态
# ============================================================

def load_state(run_dir: Path) -> dict:
    p = run_dir / "state.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_state(run_dir: Path, state: dict):
    (run_dir / "state.json").write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ============================================================
# 各阶段
# ============================================================

def stage_ref(run_dir: Path, state: dict, image: Path) -> dict:
    """① 上传原图  ② generate_image(t_pose) -> T-pose 参考图"""
    gen_id = state.get("generate_image_task_id")
    if not gen_id:
        print("\n" + "=" * 64)
        print("阶段 ① 上传原始照片")
        print("=" * 64)

        if not image.exists():
            raise FileNotFoundError(f"找不到图片：{image}")
        print(f"    {image}  {image.stat().st_size/1024:.0f} KB")
        with open(image, "rb") as fh:
            up = check(
                requests.post(
                    f"{BASE_URL}/upload/sts",
                    headers=HEADERS,
                    files={"file": (image.name, fh, "application/octet-stream")},
                    timeout=180,
                )
            )
        token = up["data"]["image_token"]
        state["source_image"] = str(image.resolve())
        state["source_image_token"] = token
        print(f"    image_token: {token}")
        save_state(run_dir, state)

        print("\n" + "=" * 64)
        print(f"阶段 ② 生成 T-pose 参考图（generate_image / template={IMAGE_TEMPLATE}）")
        print("=" * 64)
        payload = {
            "type": "generate_image",
            "model_version": IMAGE_MODEL_VERSION,
            "prompt": IMAGE_PROMPT,
            "template": IMAGE_TEMPLATE,
            "t_pose": True,
            "file": {"type": image.suffix.lstrip(".").lower(), "file_token": token},
        }
        gen_id = post_task(payload, "generate_image (t_pose)")
        state["generate_image_task_id"] = gen_id
        save_state(run_dir, state)
    else:
        print(f"\n>>> 复用已有 T-pose 任务：{gen_id}")

    result = state.get("generate_image_result")
    if not result:
        result = wait(gen_id, "T-pose 参考图")
        state["generate_image_result"] = result
        save_state(run_dir, state)


    files = download(result.get("output", {}), run_dir / "00_tpose_ref", {"image": "tpose_ref"})
    state["tpose_ref_files"] = [str(p) for p in files]
    save_state(run_dir, state)

    imgs = [p for p in files if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}]
    if imgs:
        state["tpose_ref_image"] = str(imgs[0])
        save_state(run_dir, state)
        print(f"\n    ➜ T-pose 参考图：{imgs[0]}")
    return state


def stage_model(run_dir: Path, state: dict, skip_texture: bool) -> dict:
    """③ image_to_model（从 T-pose 参考图） + ③b texture_model"""
    ref = state.get("tpose_ref_image")
    if not ref or not Path(ref).exists():
        raise RuntimeError(
            "缺少 T-pose 参考图。先跑 --upto ref，或确认 state.json 里的 tpose_ref_image。"
        )
    ref_path = Path(ref)
    print("\n" + "=" * 64)
    print(f"阶段 ③ 从 T-pose 参考图重建 3D：{ref_path.name}")
    print("=" * 64)

    with open(ref_path, "rb") as fh:
        up = check(
            requests.post(
                f"{BASE_URL}/upload/sts",
                headers=HEADERS,
                files={"file": (ref_path.name, fh, "application/octet-stream")},
                timeout=180,
            )
        )
    ref_token = up["data"]["image_token"]
    state["tpose_ref_token"] = ref_token

    payload = {
        "type": "image_to_model",
        "model_version": MODEL_VERSION,
        "face_limit": FACE_LIMIT,
        "file": {"type": ref_path.suffix.lstrip(".").lower(), "file_token": ref_token},
        # 几何优先：贴图由独立的 texture_model 任务做（质量更高）。
        "texture": False,
        "pbr": False,
        "enable_image_autofix": ENABLE_IMAGE_AUTOFIX,
    }
    if MODEL_VERSION in {"v3.0-20250812", "v3.1-20260211"}:
        payload["geometry_quality"] = GEOMETRY_QUALITY

    model_id = post_task(payload, "image_to_model (T-pose)")
    state["model_task_id"] = model_id
    save_state(run_dir, state)

    result = wait(model_id, "T-pose 几何")
    state["model_result"] = result
    save_state(run_dir, state)
    files = download(result.get("output", {}), run_dir / "01_geometry")
    state["geometry_files"] = [str(p) for p in files]
    save_state(run_dir, state)

    if skip_texture:
        print("\n    （--skip-texture：跳过贴图，绑骨直接用几何任务）")
        state["texture_task_id"] = None
        save_state(run_dir, state)
        return state

    print("\n" + "=" * 64)
    print(f"阶段 ③b 生成高级 PBR 贴图（{TEXTURE_MODEL_VERSION} / {TEXTURE_QUALITY}）")
    print("=" * 64)
    tex_id = post_task(
        {
            "type": "texture_model",
            "original_model_task_id": model_id,
            "model_version": TEXTURE_MODEL_VERSION,
            "texture_prompt": {
                "image": {"type": ref_path.suffix.lstrip(".").lower(), "file_token": ref_token}
            },
            "texture": True,
            "pbr": True,
            "texture_quality": TEXTURE_QUALITY,
            "texture_alignment": "original_image",
            "bake": True,
        },
        "texture_model",
    )
    state["texture_task_id"] = tex_id
    save_state(run_dir, state)

    result = wait(tex_id, "PBR 贴图")
    state["texture_result"] = result
    save_state(run_dir, state)
    files = download(result.get("output", {}), run_dir / "02_textured")
    state["textured_files"] = [str(p) for p in files]
    save_state(run_dir, state)
    return state


def stage_rig(run_dir: Path, state: dict) -> dict:
    """④ animate_prerigcheck -> animate_rig"""
    base = state.get("texture_task_id") or state.get("model_task_id")
    if not base:
        raise RuntimeError("缺少上游任务 id。先跑 --upto model。")

    # 换了 out_format 就必须重绑（旧产物是另一种格式，不能复用）
    if state.get("rig_task_id") and state.get("rig_format") != RIG_FORMAT:
        print(f"\n  ⚠️ out_format 由 {state.get('rig_format')} 变为 {RIG_FORMAT}，重新绑定")
        for k in ("rig_task_id", "rig_result", "rigged_files", "rig_type"):
            state.pop(k, None)
        save_state(run_dir, state)

    print("\n" + "=" * 64)
    print("阶段 ④a 绑骨预检（animate_prerigcheck）")
    print("=" * 64)
    check_id = post_task(
        {"type": "animate_prerigcheck", "original_model_task_id": base},
        "animate_prerigcheck",
    )
    state["prerigcheck_task_id"] = check_id
    save_state(run_dir, state)

    result = wait(check_id, "绑骨预检")
    state["prerigcheck_result"] = result
    save_state(run_dir, state)

    out = result.get("output", {}) or {}
    riggable = out.get("riggable", result.get("riggable"))
    rig_type = out.get("rig_type", result.get("rig_type"))
    print(f"    riggable={riggable}  rig_type={rig_type}")
    if not riggable:
        raise RuntimeError("模型未通过绑骨预检（riggable=false）。")

    print("\n" + "=" * 64)
    print(f"阶段 ④b 自动绑骨（animate_rig / {rig_type} / {RIG_SPEC} / {RIG_FORMAT}）")
    print("=" * 64)
    rig_id = post_task(
        {
            "type": "animate_rig",
            "original_model_task_id": base,
            "model_version": RIG_MODEL_VERSION,
            "out_format": RIG_FORMAT,
            "rig_type": rig_type,
            "spec": RIG_SPEC,
        },
        f"animate_rig ({rig_type})",
    )
    state["rig_task_id"] = rig_id
    state["rig_type"] = rig_type
    state["rig_format"] = RIG_FORMAT
    save_state(run_dir, state)

    result = wait(rig_id, "自动绑骨")
    state["rig_result"] = result
    save_state(run_dir, state)
    files = download(result.get("output", {}), run_dir / "03_rigged")
    state["rigged_files"] = [str(p) for p in files]
    state["status"] = "success"
    state["finished_at"] = datetime.now().astimezone().isoformat()
    save_state(run_dir, state)
    return state


# ============================================================
# 入口
# ============================================================

def main():
    global RIG_FORMAT  # 必须在任何使用 RIG_FORMAT 的语句之前

    ap = argparse.ArgumentParser(description="Tripo T-pose 资产管线")
    ap.add_argument("--image", default=None,
                    help="原始照片路径（做参考图用）。续跑时以 state.json 里记录的原图为准，"
                         "显式传入且不一致会报错，避免静默换图。")
    ap.add_argument("--run", help="已有 run 目录（续跑）")
    ap.add_argument("--upto", choices=["ref", "model", "rig"], default="ref", help="跑到哪个阶段停")
    ap.add_argument("--skip-texture", action="store_true", help="跳过独立贴图任务")
    ap.add_argument("--out-format", choices=["glb", "fbx"], default=RIG_FORMAT,
                    help="绑骨产物格式。glb 内嵌贴图（推荐）；fbx 贴图是外链绝对路径")
    ap.add_argument("--output-root", default=DEFAULT_OUTPUT_ROOT)
    args = ap.parse_args()

    RIG_FORMAT = args.out_format

    if args.run:
        run_dir = Path(args.run).resolve()
        if not run_dir.exists():
            raise SystemExit(f"run 目录不存在：{run_dir}")
    else:
        run_dir = Path(args.output_root).resolve() / datetime.now().strftime("tpose_%Y%m%d_%H%M%S")
        run_dir.mkdir(parents=True, exist_ok=True)

    state = load_state(run_dir)
    state["status"] = "running"
    state.pop("error", None)
    state.pop("failed_at", None)

    # ★ 原图以 state 里记录的为准，**不乱用 --image 的默认值**。
    #   踩过的坑：`--upto rig` 续跑时没传 --image，args.image 静默落回
    #   `DEFAULT_IMAGE = trail.jpg`，于是整个管线（参考图→建模→贴图→绑骨→转 VRM）
    #   全程照着**另一张照片**跑。每一步都"成功"，产物看起来也正常，
    #   只有把人物对照一下才发现换人了 —— 这种静默替换比直接报错危险得多。
    recorded_image = state.get("source_image")
    explicit_image = Path(args.image).resolve() if args.image else None
    if recorded_image:
        image_path = Path(recorded_image).resolve()
        if explicit_image and explicit_image != image_path:
            raise SystemExit(
                f"\n  ✗ 这个 run 用的原图是：\n      {image_path}\n"
                f"    与 --image 指定的：\n      {explicit_image}\n"
                f"    不一致。换原图请开一个新的 run（不带 --run），"
                f"不要续跑旧 run —— 否则产物会混着两张照片的血统。\n"
            )
    else:
        image_path = explicit_image or Path(DEFAULT_IMAGE).resolve()
        if explicit_image is None:
            print(f"\n  ⚠️ 未指定 --image，回退到默认图：{image_path}")
    state.setdefault("created_at", datetime.now().astimezone().isoformat())
    state.setdefault("run_dir", str(run_dir))
    state.setdefault("settings", {
        "api_base_url": BASE_URL,
        "image_model_version": IMAGE_MODEL_VERSION,
        "image_template": IMAGE_TEMPLATE,
        "model_version": MODEL_VERSION,
        "geometry_quality": GEOMETRY_QUALITY,
        "face_limit": FACE_LIMIT,
        "texture_model_version": TEXTURE_MODEL_VERSION,
        "texture_quality": TEXTURE_QUALITY,
        "rig_model": RIG_MODEL_VERSION,
        "rig_spec": RIG_SPEC,
        "rig_format": RIG_FORMAT,
    })

    print("=" * 64)
    print("Tripo T-pose 管线：参考图 -> T-pose 3D -> 自动绑骨")
    print("=" * 64)
    print(f"  run 目录 : {run_dir}")
    print(f"  跑到阶段 : {args.upto}")
    bal, frozen = balance()
    state["account"] = {"balance_before": bal, "frozen": frozen}
    print(f"  账户余额 : {bal:g}（冻结 {frozen:g}）")
    if bal <= 0:
        raise SystemExit("余额为 0，无法创建计费任务。")

    try:
        # ★ 少了前置阶段就先补跑前置阶段，而不是直接跳到目标阶段。
        #   `--upto X` 的语义是"跑到 X 为止"，不是"只跑 X"。
        #   原先这里写的是 `args.upto == "ref" and ...`，于是 `--upto rig`
        #   在全新 run 上会直接调 stage_model，而那时 state 里还没有参考图，
        #   必然抛 "缺少 T-pose 参考图"。只有分三段手动跑才碰不到（上一轮就是这么绕过去的）。
        if "tpose_ref_image" not in state:
            state = stage_ref(run_dir, state, image_path)
        if args.upto in {"model", "rig"} and "model_task_id" not in state:
            state = stage_model(run_dir, state, args.skip_texture)
        # ★ 不能只判 "rig_task_id 是否存在"：换了 out_format 时必须重绑，
        # 而旧产物仍然在 state 里，只判存在性会直接跳过。
        needs_rig = args.upto == "rig" and (
            "rig_task_id" not in state or state.get("rig_format") != RIG_FORMAT
        )
        if needs_rig:
            state = stage_rig(run_dir, state)

        state.setdefault("status", "success")
        save_state(run_dir, state)

    except Exception as err:
        state["status"] = "failed"
        state["error"] = str(err)
        state["failed_at"] = datetime.now().astimezone().isoformat()
        save_state(run_dir, state)
        raise

    bal2, _ = balance()
    print("\n" + "=" * 64)
    print("完成")
    print("=" * 64)
    print(f"  资产目录 : {run_dir}")
    print(f"  状态文件 : {run_dir/'state.json'}")
    print(f"  余额变化 : {bal:g} -> {bal2:g} （消耗 {bal-bal2:g}）")
    for key in ("tpose_ref_image", "geometry_files", "textured_files", "rigged_files"):
        if state.get(key):
            print(f"  {key}:")
            vals = state[key] if isinstance(state[key], list) else [state[key]]
            for v in vals:
                print(f"    - {v}")
    print("=" * 64)
    print(f"\n续跑下一阶段：\n  python {Path(__file__).name} --run \"{run_dir}\" --upto "
          f"{'model' if args.upto == 'ref' else 'rig'}")


if __name__ == "__main__":
    main()
