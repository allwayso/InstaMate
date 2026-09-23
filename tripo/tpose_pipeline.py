#!/usr/bin/env python
"""T-pose 平面图与 3D 资产管线。

--upto ref 可由 Tripo 从原始照片生成参考图；阿里百炼生成的动漫参考图
也可直接存入 state.json 或用 --image 导入，再进入 model/rig 阶段。
"""

from __future__ import annotations

import argparse
import filecmp
import hashlib
import json
import os
import re
import shutil
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
if (urlparse(BASE_URL).hostname or "").endswith(".aliyuncs.com"):
    raise RuntimeError("Tripo 3D 地址不能填写阿里百炼地址；请分别配置两项服务。")
HEADERS = {"Authorization": f"Bearer {API_KEY}"}
JSON_HEADERS = {**HEADERS, "Content-Type": "application/json"}

# Tripo 平面图流程；阿里百炼生成的参考图可直接进入建模阶段。
IMAGE_MODEL_VERSION = os.getenv("TRIPO_IMAGE_MODEL_VERSION", "gemini_2.5_flash_image_preview")
IMAGE_TEMPLATE = os.getenv("TRIPO_IMAGE_TEMPLATE", "t_pose")
IMAGE_PROMPT = os.getenv(
    "TRIPO_IMAGE_PROMPT",
    "One front-facing full-body anime character in a strict T-pose, centered on a plain "
    "light background. Keep the person's identity, hairstyle and clothing colors. "
    "Show one person and one pose only, with head, hands and feet fully visible. "
    "No turnaround sheet, side or back view, close-up, labels, color swatches or props.",
)

# --- 几何（image_to_model）---
MODEL_VERSION = os.getenv("TRIPO_MODEL_VERSION", "v3.1-20260211")
GEOMETRY_QUALITY = os.getenv("TRIPO_GEOMETRY_QUALITY", "detailed")
FACE_LIMIT = int(os.getenv("TRIPO_FACE_LIMIT", "100000"))
ENABLE_IMAGE_AUTOFIX = os.getenv("TRIPO_ENABLE_IMAGE_AUTOFIX", "true").lower() in {
    "1", "true", "yes", "on",
}

# --- 贴图（texture_model，独立高级贴图）---
TEXTURE_MODEL_VERSION = os.getenv("TRIPO_TEXTURE_MODEL_VERSION", "v3.0-20250812")
TEXTURE_QUALITY = os.getenv("TRIPO_TEXTURE_QUALITY", "detailed")

# --- 绑骨（animate_rig）---
RIG_MODEL_VERSION = os.getenv("RIG_MODEL_VERSION", "v1.0-20240301")
RIG_SPEC = os.getenv("TRIPO_RIG_SPEC", "mixamo")
# ★ 官方 `out_format` 默认就是 glb，而且我们真正需要的就是它：
#   - glb 的贴图是**内嵌**在 bufferView 里；fbx 导出的是 /mnt/pfs/server/... 这种
#     外链绝对路径，浏览器里必然 404（本轮实测踩到）。
#   - glb 转 VRM 是纯 JSON 注入（VRMC_vrm 扩展），不需要 Blender。
RIG_FORMAT = os.getenv("TRIPO_RIG_FORMAT", "glb").lower()

POLL_INTERVAL = float(os.getenv("TRIPO_POLL_INTERVAL", "3"))
TIMEOUT = int(os.getenv("TRIPO_TIMEOUT", "1800"))

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


class TerminalTaskFailure(RuntimeError):
    """服务端明确结束且失败；超时或网络故障不属于此类。"""


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
            raise TerminalTaskFailure(f"{label} 失败：\n" + json.dumps(data, indent=2, ensure_ascii=False))

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
    target = run_dir / "state.json"
    temporary = run_dir / f".state.{os.getpid()}.{time.time_ns()}.tmp"
    try:
        temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


STAGE_FIELDS = {
    "model": ("model_task_id", "model_result", "geometry_files",
              "texture_task_id", "texture_result", "textured_files",
              "prerigcheck_task_id", "prerigcheck_result", "prerigcheck_base_task_id",
              "rig_task_id", "rig_result", "rigged_files", "rig_type",
              "rig_format", "rig_base_task_id"),
    "texture": ("texture_task_id", "texture_result", "textured_files",
                "prerigcheck_task_id", "prerigcheck_result", "prerigcheck_base_task_id",
                "rig_task_id", "rig_result", "rigged_files", "rig_type",
                "rig_format", "rig_base_task_id"),
    "prerigcheck": ("prerigcheck_task_id", "prerigcheck_result", "prerigcheck_base_task_id",
                    "rig_task_id", "rig_result", "rigged_files", "rig_type",
                    "rig_format", "rig_base_task_id"),
    "rig": ("rig_task_id", "rig_result", "rigged_files", "rig_type",
            "rig_format", "rig_base_task_id"),
}


def clear_stage(run_dir: Path, state: dict, stage: str):
    """仅终态失败时清理该任务及下游；下一次调用才会创建新任务。"""
    for key in STAGE_FIELDS[stage]:
        state.pop(key, None)
    save_state(run_dir, state)


def files_ready(paths, suffix: str | None = None) -> bool:
    if not isinstance(paths, list) or not paths:
        return False
    files = [Path(path) for path in paths if isinstance(path, str)]
    return len(files) == len(paths) and all(
        path.is_file() and path.stat().st_size > 0 for path in files
    ) and (suffix is None or any(path.suffix.lower() == suffix for path in files))


def image_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resume_task(run_dir: Path, state: dict, stage: str, label: str,
                payload_factory, created_fields: dict | None = None) -> dict:
    """成功结果复用；已有任务继续等；只有无任务 ID 时才提交。"""
    task_key = f"{stage}_task_id"
    result_key = f"{stage}_result"
    task_id = state.get(task_key)
    result = state.get(result_key)
    if task_id and isinstance(result, dict) and result.get("status") == "success":
        return result

    if not task_id:
        task_id = post_task(payload_factory(), label)
        state[task_key] = task_id
        state.update(created_fields or {})
        state.pop(result_key, None)
        save_state(run_dir, state)
    else:
        print(f"\n>>> 续查已有任务：{label}  ({task_id})")

    try:
        result = wait(task_id, label)
    except TerminalTaskFailure:
        clear_stage(run_dir, state, stage)
        raise
    state[result_key] = result
    save_state(run_dir, state)
    return result


# ============================================================
# 各阶段
# ============================================================

def stage_ref(run_dir: Path, state: dict, image: Path) -> dict:
    """Tripo generate_image：从原始照片得到待用户确认的 T-pose 平面图。"""
    if not image.is_file():
        raise FileNotFoundError(f"找不到原始照片：{image}")
    recorded = state.get("source_image")
    if recorded and Path(recorded).resolve() != image.resolve():
        raise RuntimeError("原始照片与这个 run 已记录的照片不一致；请创建新的 run")
    digest = image_digest(image)
    if state.get("source_image_sha256") and state["source_image_sha256"] != digest:
        raise RuntimeError("原始照片内容已改变；请创建新的 run")
    state["source_image"] = str(image.resolve())
    state["source_image_sha256"] = digest

    if (files_ready(state.get("tpose_ref_files")) and state.get("tpose_ref_image")
            and Path(state["tpose_ref_image"]).is_file()):
        return state

    token = state.get("source_image_token")
    if not token:
        with image.open("rb") as source:
            uploaded = check(requests.post(
                f"{BASE_URL}/upload/sts", headers=HEADERS,
                files={"file": (image.name, source, "application/octet-stream")}, timeout=180,
            ))
        token = uploaded["data"]["image_token"]
        state["source_image_token"] = token
        save_state(run_dir, state)

    task_id = state.get("generate_image_task_id")
    if not task_id:
        task_id = post_task({
            "type": "generate_image", "model_version": IMAGE_MODEL_VERSION,
            "prompt": IMAGE_PROMPT, "template": IMAGE_TEMPLATE, "t_pose": True,
            "file": {"type": image.suffix.lstrip(".").lower(), "file_token": token},
        }, "generate_image (t_pose)")
        state["generate_image_task_id"] = task_id
        save_state(run_dir, state)

    result = state.get("generate_image_result")
    if not isinstance(result, dict) or result.get("status") != "success":
        try:
            result = wait(task_id, "T-pose 参考图")
        except TerminalTaskFailure:
            state.pop("generate_image_task_id", None)
            state.pop("generate_image_result", None)
            save_state(run_dir, state)
            raise
        state["generate_image_result"] = result
        save_state(run_dir, state)

    files = download(result.get("output", {}), run_dir / "00_tpose_ref", {"image": "tpose_ref"})
    images = [path for path in files if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}]
    if not images:
        raise RuntimeError("Tripo 平面图任务已完成，但没有返回可用的参考图")
    state["tpose_ref_files"] = [str(path) for path in files]
    state["tpose_ref_image"] = str(images[0])
    save_state(run_dir, state)
    return state

def stage_model(run_dir: Path, state: dict, skip_texture: bool) -> dict:
    """③ image_to_model（从 T-pose 参考图） + ③b texture_model"""
    ref = state.get("tpose_ref_image")
    if not ref or not Path(ref).exists():
        raise RuntimeError(
            "缺少动漫 T-pose 参考图。先由阿里百炼生成，或使用 --image 导入。"
        )
    ref_path = Path(ref)
    print("\n" + "=" * 64)
    print(f"阶段 ③ 从 T-pose 参考图重建 3D：{ref_path.name}")
    print("=" * 64)

    def upload_ref() -> str:
        # 仅在确需新建任务时上传；已有 task_id 可以直接续查。
        with open(ref_path, "rb") as fh:
            up = check(requests.post(
                f"{BASE_URL}/upload/sts", headers=HEADERS,
                files={"file": (ref_path.name, fh, "application/octet-stream")}, timeout=180,
            ))
        token = up["data"]["image_token"]
        state["tpose_ref_token"] = token
        save_state(run_dir, state)
        return token

    def model_payload() -> dict:
        token = upload_ref()
        payload = {
            "type": "image_to_model",
            "model_version": MODEL_VERSION,
            "face_limit": FACE_LIMIT,
            "file": {"type": ref_path.suffix.lstrip(".").lower(), "file_token": token},
            "texture": False,
            "pbr": False,
            "enable_image_autofix": ENABLE_IMAGE_AUTOFIX,
        }
        if MODEL_VERSION in {"v3.0-20250812", "v3.1-20260211"}:
            payload["geometry_quality"] = GEOMETRY_QUALITY
        return payload

    model_result = resume_task(
        run_dir, state, "model", "T-pose 几何", model_payload,
    )
    if not files_ready(state.get("geometry_files")):
        files = download(model_result.get("output", {}), run_dir / "01_geometry")
        state["geometry_files"] = [str(p) for p in files]
        save_state(run_dir, state)
        if not files_ready(state["geometry_files"]):
            raise RuntimeError("Tripo 几何任务已完成，但未得到可用的模型文件")

    if skip_texture:
        print("\n    （--skip-texture：跳过贴图，绑骨直接用几何任务）")
        return state

    print("\n" + "=" * 64)
    print(f"阶段 ③b 生成高级 PBR 贴图（{TEXTURE_MODEL_VERSION} / {TEXTURE_QUALITY}）")
    print("=" * 64)
    def texture_payload() -> dict:
        token = upload_ref()
        return {
            "type": "texture_model",
            "original_model_task_id": state["model_task_id"],
            "model_version": TEXTURE_MODEL_VERSION,
            "texture_prompt": {
                "image": {"type": ref_path.suffix.lstrip(".").lower(), "file_token": token}
            },
            "texture": True,
            "pbr": True,
            "texture_quality": TEXTURE_QUALITY,
            "texture_alignment": "original_image",
            "bake": True,
        }

    texture_result = resume_task(
        run_dir, state, "texture", "PBR 贴图", texture_payload,
    )
    if not files_ready(state.get("textured_files")):
        files = download(texture_result.get("output", {}), run_dir / "02_textured")
        state["textured_files"] = [str(p) for p in files]
        save_state(run_dir, state)
        if not files_ready(state["textured_files"]):
            raise RuntimeError("Tripo 贴图任务已完成，但未得到可用的贴图模型文件")
    return state


def stage_rig(run_dir: Path, state: dict, skip_texture: bool) -> dict:
    """④ animate_prerigcheck -> animate_rig"""
    base = state.get("model_task_id") if skip_texture else state.get("texture_task_id")
    if not base:
        raise RuntimeError("缺少上游任务 id。先跑 --upto model。")

    # 上游任务或格式变更时，先等旧任务到终态，避免遗失仍在计费的 task_id。
    prior_rig_base = state.get("rig_base_task_id")
    prior_format = state.get("rig_format")
    if state.get("rig_task_id") and (
        (prior_rig_base and prior_rig_base != base)
        or (prior_format and prior_format != RIG_FORMAT)
    ):
        resume_task(run_dir, state, "rig", "旧格式绑骨任务", None)
        clear_stage(run_dir, state, "rig")

    prior_check_base = state.get("prerigcheck_base_task_id")
    if (state.get("prerigcheck_task_id") and prior_check_base
            and prior_check_base != base):
        resume_task(run_dir, state, "prerigcheck", "旧绑骨预检", None)
        clear_stage(run_dir, state, "prerigcheck")

    print("\n" + "=" * 64)
    print("阶段 ④a 绑骨预检（animate_prerigcheck）")
    print("=" * 64)
    check_result = resume_task(
        run_dir, state, "prerigcheck", "绑骨预检",
        lambda: {"type": "animate_prerigcheck", "original_model_task_id": base},
        {"prerigcheck_base_task_id": base},
    )
    out = check_result.get("output", {}) or {}
    riggable = out.get("riggable", check_result.get("riggable"))
    rig_type = out.get("rig_type", check_result.get("rig_type"))
    print(f"    riggable={riggable}  rig_type={rig_type}")
    if not riggable:
        raise RuntimeError("模型未通过绑骨预检（riggable=false）。")

    print("\n" + "=" * 64)
    print(f"阶段 ④b 自动绑骨（animate_rig / {rig_type} / {RIG_SPEC} / {RIG_FORMAT}）")
    print("=" * 64)
    rig_result = resume_task(
        run_dir, state, "rig", f"自动绑骨（{RIG_FORMAT}）",
        lambda: {
            "type": "animate_rig",
            "original_model_task_id": base,
            "model_version": RIG_MODEL_VERSION,
            "out_format": RIG_FORMAT,
            "rig_type": rig_type,
            "spec": RIG_SPEC,
        },
        {"rig_type": rig_type, "rig_format": RIG_FORMAT, "rig_base_task_id": base},
    )
    expected_suffix = f".{RIG_FORMAT}"
    if not files_ready(state.get("rigged_files"), expected_suffix):
        files = download(rig_result.get("output", {}), run_dir / "03_rigged")
        state["rigged_files"] = [str(p) for p in files]
        save_state(run_dir, state)
        if not files_ready(state["rigged_files"], expected_suffix):
            raise RuntimeError(f"Tripo 绑骨任务已完成，但未得到可用的 {RIG_FORMAT.upper()} 文件")
    state["status"] = "success"
    state["finished_at"] = datetime.now().astimezone().isoformat()
    save_state(run_dir, state)
    return state


# ============================================================
# 入口
# ============================================================

def main():
    global RIG_FORMAT  # 必须在任何使用 RIG_FORMAT 的语句之前

    ap = argparse.ArgumentParser(description="Tripo 3D 建模与绑骨管线")
    ap.add_argument("--image", help="--upto ref 时为原始照片；其他阶段为已生成的动漫参考图")
    ap.add_argument("--run", help="已有 run 目录（续跑）")
    ap.add_argument("--upto", choices=["ref", "model", "rig"], default="rig", help="跑到哪个阶段停")
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
    if args.upto != "ref" and args.image:
        source = Path(args.image).resolve()
        if not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise SystemExit("--image 必须是已生成的 PNG/JPG/WEBP 参考图")
        recorded_ref = state.get("tpose_ref_image")
        if recorded_ref:
            recorded_path = Path(recorded_ref).resolve()
            if not recorded_path.is_file() or not filecmp.cmp(source, recorded_path, shallow=False):
                raise SystemExit(
                    "--image 与这个 run 已记录的动漫参考图不一致；"
                    "如需更换人物或参考图，请创建新的 run。"
                )
        else:
            dest_dir = run_dir / "00_tpose_ref"
            dest_dir.mkdir(exist_ok=True)
            dest = dest_dir / ("tpose_ref" + source.suffix.lower())
            if source != dest.resolve():
                shutil.copyfile(source, dest)
            state["tpose_ref_image"] = str(dest.resolve())
            state["tpose_ref_files"] = [str(dest.resolve())]
            save_state(run_dir, state)
    ref_image = state.get("tpose_ref_image")
    if args.upto != "ref" and (not ref_image or not Path(ref_image).is_file()):
        raise SystemExit("缺少动漫 T-pose 参考图；先在网页用阿里百炼生成，或用 --image 导入")
    source_image = None
    if args.upto == "ref":
        recorded_source = state.get("source_image")
        source_image = Path(args.image or recorded_source).resolve() if (args.image or recorded_source) else None
        if source_image is None or not source_image.is_file():
            raise SystemExit("--upto ref 需要可读取的原始照片；请使用 --image 指定")
        if recorded_source and Path(recorded_source).resolve() != source_image:
            raise SystemExit("--image 与这个 run 已记录的原始照片不一致；请创建新的 run")
    state.setdefault("status", "running")

    state.setdefault("created_at", datetime.now().astimezone().isoformat())
    state.setdefault("run_dir", str(run_dir))
    state.setdefault("settings", {
        "api_base_url": BASE_URL,
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
    print("Tripo 3D 管线：已确认参考图 -> 几何/贴图 -> 自动绑骨")
    print("=" * 64)
    print(f"  run 目录 : {run_dir}")
    print(f"  跑到阶段 : {args.upto}")
    try:
        bal, frozen = balance()
        state["account"] = {"balance_before": bal, "frozen": frozen}
        print(f"  账户余额 : {bal:g}（冻结 {frozen:g}）")
    except Exception as error:
        bal = None
        print(f"  暂无法读取余额：{error}；已有任务仍可续查")

    state["status"] = "running"
    state.pop("error", None)
    state.pop("failed_at", None)
    save_state(run_dir, state)

    try:
        if args.upto == "ref":
            state = stage_ref(run_dir, state, source_image)
        else:
            state = stage_model(run_dir, state, args.skip_texture)
            if args.upto == "rig":
                state = stage_rig(run_dir, state, args.skip_texture)

        state["status"] = "success"
        save_state(run_dir, state)

    except Exception as err:
        state["status"] = "failed"
        state["error"] = str(err)
        state["failed_at"] = datetime.now().astimezone().isoformat()
        save_state(run_dir, state)
        raise

    try:
        bal2, _ = balance()
    except Exception:
        bal2 = None
    print("\n" + "=" * 64)
    print("完成")
    print("=" * 64)
    print(f"  资产目录 : {run_dir}")
    print(f"  状态文件 : {run_dir/'state.json'}")
    if bal is not None and bal2 is not None:
        print(f"  余额变化 : {bal:g} -> {bal2:g} （消耗 {bal-bal2:g}）")
    for key in ("tpose_ref_image", "geometry_files", "textured_files", "rigged_files"):
        if state.get(key):
            print(f"  {key}:")
            vals = state[key] if isinstance(state[key], list) else [state[key]]
            for v in vals:
                print(f"    - {v}")
    print("=" * 64)
    print(f"\n续跑下一阶段：\n  python {Path(__file__).name} --run \"{run_dir}\" --upto "
          f"rig")


if __name__ == "__main__":
    main()
