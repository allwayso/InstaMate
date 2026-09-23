import os
import json
import re
import time
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests
from dotenv import load_dotenv


load_dotenv()


# ============================================================
# 配置
# ============================================================

API_KEY = os.getenv("TRIPO_API_KEY") or os.getenv("api_key")

if not API_KEY:
    raise RuntimeError(
        "未找到 Tripo API Key。请在 .env 中设置 "
        "TRIPO_API_KEY=tsk_...（仍兼容原来的 api_key）。"
    )

# 指定你的本地图片
IMAGE_PATH = r"D:/tripo/test.jpg"

# 输出目录
OUTPUT_DIR = r"D:/tripo/output"

# Tripo 中国站 Python/V2 API。海外账户可在 .env 中覆盖 TRIPO_BASE_URL。
BASE_URL = os.getenv(
    "TRIPO_BASE_URL",
    "https://api.tripo3d.com/v2/openapi",
).rstrip("/")

# H3.1 是当前高保真几何模型；模型与参数对照见 TRIPO_MODELS.md。
MODEL_VERSION = os.getenv("TRIPO_MODEL_VERSION", "v3.1-20260211")

# H3 几何质量：standard / detailed（Ultra）。
GEOMETRY_QUALITY = os.getenv("TRIPO_GEOMETRY_QUALITY", "detailed")

# V2 接口当前的高级贴图模型与质量。
TEXTURE_MODEL_VERSION = os.getenv(
    "TRIPO_TEXTURE_MODEL_VERSION",
    "v3.0-20250812",
)
TEXTURE_QUALITY = os.getenv("TRIPO_TEXTURE_QUALITY", "detailed")

# 默认 10 万三角面，比旧的 5 万面保留更多人物细节。
FACE_LIMIT = int(os.getenv("TRIPO_FACE_LIMIT", "100000"))

# 最终 FBX 烘焙贴图默认提升到 4K。
TEXTURE_SIZE = int(os.getenv("TRIPO_TEXTURE_SIZE", "4096"))

# 高质量模式默认优化输入图像，可在 .env 关闭。
ENABLE_IMAGE_AUTOFIX = (
    os.getenv("TRIPO_ENABLE_IMAGE_AUTOFIX", "true").lower()
    in {"1", "true", "yes", "on"}
)

# 自动绑骨配置。mixamo 骨骼命名更方便导入 Blender / Unity / Unreal。
# 双足人形
RIG_MODEL_VERSION = os.getenv("RIG_MODEL_VERSION","v1.0-20240301")
RIG_SPEC = os.getenv("TRIPO_RIG_SPEC", "mixamo")
FBX_PRESET = os.getenv("TRIPO_FBX_PRESET", "mixamo").lower()
RIG_FORMAT = "fbx"

# 轮询间隔
POLL_INTERVAL = float(os.getenv("TRIPO_POLL_INTERVAL", "2"))

# 最长等待时间，秒
TIMEOUT = int(os.getenv("TRIPO_TIMEOUT", "600"))


# ============================================================
# 公共请求头
# ============================================================

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
}


def check_response(response: requests.Response):
    """
    检查 HTTP 和 Tripo API 返回，并保留服务端的具体错误信息。
    """
    try:
        data = response.json()
    except ValueError:
        data = None

    if not response.ok:
        if data is not None:
            detail = json.dumps(data, indent=2, ensure_ascii=False)
        else:
            detail = response.text.strip() or "（响应正文为空）"

        hint = ""
        if response.status_code == 401:
            hint = "\n提示：请检查 API Key 是否正确或已经失效。"
        elif response.status_code == 403:
            hint = (
                "\n提示：鉴权已通过但请求被拒绝，常见原因是账户余额不足、"
                "模型权限不足或内容策略限制。"
            )

        raise RuntimeError(
            f"Tripo API HTTP {response.status_code} {response.reason}\n"
            f"请求：{response.request.method} {response.url}\n"
            f"响应：\n{detail}{hint}"
        )

    if data is None:
        raise RuntimeError(
            "Tripo API 返回了无法解析的非 JSON 响应：\n"
            + (response.text.strip() or "（响应正文为空）")
        )

    if data.get("code") != 0:
        raise RuntimeError(
            "Tripo API 调用失败：\n"
            + json.dumps(data, indent=2, ensure_ascii=False)
        )

    return data


def get_balance() -> tuple[float, float]:
    """读取账户的可用余额和冻结余额。"""
    url = f"{BASE_URL}/user/balance"
    response = requests.get(url, headers=HEADERS, timeout=30)
    result = check_response(response)
    account = result.get("data", {})
    return float(account.get("balance", 0)), float(account.get("frozen", 0))


def ensure_available_balance():
    """在上传图片前发现零余额，避免得到含糊的任务创建 403。"""
    balance, frozen = get_balance()
    print(f"账户余额：{balance:g}（冻结：{frozen:g}）")

    if balance <= 0:
        raise RuntimeError(
            "Tripo API 可用余额为 0，无法创建 Image -> 3D 计费任务。\n"
            "请先在 https://platform.tripo3d.com/ 充值或领取可用额度，"
            "然后重新运行脚本。"
        )

    return balance, frozen


def validate_settings():
    """在发起计费任务前检查常见的模型/参数组合错误。"""
    generation_models = {
        "v3.1-20260211",
        "v3.0-20250812",
        "v2.5-20250123",
        "v2.0-20240919",
        "P1-20260311",
        "Turbo-v1.0-20250506",
    }
    texture_models = {
        "v3.0-20250812",
        "v2.5-20250123",
    }

    if MODEL_VERSION not in generation_models:
        raise ValueError(
            f"不支持的 TRIPO_MODEL_VERSION={MODEL_VERSION!r}。"
            "可用值见 TRIPO_MODELS.md。"
        )
    if TEXTURE_MODEL_VERSION not in texture_models:
        raise ValueError(
            "不支持的 TRIPO_TEXTURE_MODEL_VERSION="
            f"{TEXTURE_MODEL_VERSION!r}。"
            "可用值见 TRIPO_MODELS.md。"
        )
    if GEOMETRY_QUALITY not in {"standard", "detailed"}:
        raise ValueError(
            "TRIPO_GEOMETRY_QUALITY 只能是 standard 或 detailed"
        )
    if TEXTURE_QUALITY not in {"standard", "detailed"}:
        raise ValueError(
            "V2 接口的 TRIPO_TEXTURE_QUALITY 只能是 "
            "standard 或 detailed"
        )
    if MODEL_VERSION == "P1-20260311" and not 48 <= FACE_LIMIT <= 20000:
        raise ValueError("P1-20260311 的 TRIPO_FACE_LIMIT 必须在 48-20000")
    if FACE_LIMIT <= 0:
        raise ValueError("TRIPO_FACE_LIMIT 必须大于 0")
    if TEXTURE_SIZE not in {1024, 2048, 4096}:
        raise ValueError("TRIPO_TEXTURE_SIZE 建议使用 1024、2048 或 4096")


# ============================================================
# 1. 上传图片
# ============================================================

def upload_image(image_path: str) -> str:
    image_path = Path(image_path)

    if not image_path.exists():
        raise FileNotFoundError(f"找不到图片：{image_path}")

    suffix = image_path.suffix.lower()

    if suffix not in [".jpg", ".jpeg", ".png", ".webp"]:
        raise ValueError(
            "Tripo 图片上传只支持 jpg/jpeg/png/webp"
        )

    url = f"{BASE_URL}/upload/sts"

    print(f"\n[1/7] 上传图片：{image_path}")

    # 不要自己设置 Content-Type。
    # requests 会自动生成 multipart/form-data boundary。
    with open(image_path, "rb") as f:
        files = {
            "file": (
                image_path.name,
                f,
                "application/octet-stream",
            )
        }

        response = requests.post(
            url,
            headers=HEADERS,
            files=files,
            timeout=120,
        )

    result = check_response(response)

    image_token = result["data"]["image_token"]

    print("上传成功")
    print("image_token:", image_token)

    return image_token


# ============================================================
# 2. 创建 Image -> 3D 任务
# ============================================================

def image_file_payload(image_token: str, image_path: str) -> dict:
    """生成 Tripo V2 接口所需的图片文件对象。"""
    suffix = Path(image_path).suffix.lower()

    if suffix in [".jpg", ".jpeg"]:
        file_type = "jpg"
    elif suffix == ".png":
        file_type = "png"
    elif suffix == ".webp":
        file_type = "webp"
    else:
        raise ValueError("不支持的图片格式")

    return {
        "type": file_type,
        "file_token": image_token,
    }


def create_image_to_model_task(
    image_token: str,
    image_path: str,
) -> str:
    url = f"{BASE_URL}/task"

    payload = {
        "type": "image_to_model",

        "model_version": MODEL_VERSION,

        # 控制模型复杂度，默认 10 万三角面。
        "face_limit": FACE_LIMIT,

        "file": image_file_payload(image_token, image_path),

        # 先专注生成高质量几何，下一步再用独立高级贴图模型。
        "texture": False,
        "pbr": False,

        # 高质量模式默认开启，也可通过 .env 关闭。
        "enable_image_autofix": ENABLE_IMAGE_AUTOFIX,

    }

    # geometry_quality 是 H3 专用参数；P 系列不支持它。
    if MODEL_VERSION in {"v3.0-20250812", "v3.1-20260211"}:
        payload["geometry_quality"] = GEOMETRY_QUALITY

    headers = {
        **HEADERS,
        "Content-Type": "application/json",
    }

    print("\n[2/7] 创建高质量图片 -> 3D 几何任务")

    response = requests.post(
        url,
        headers=headers,
        json=payload,
        timeout=60,
    )

    result = check_response(response)

    task_id = result["data"]["task_id"]

    print("任务创建成功")
    print("task_id:", task_id)

    return task_id


# ============================================================
# 2b. 创建独立高级贴图任务（主流程第 4 步执行）
# ============================================================

def create_texture_task(
    original_task_id: str,
    image_token: str,
    image_path: str,
) -> str:
    """使用原图为高质量几何生成高清 PBR 贴图。"""
    url = f"{BASE_URL}/task"
    payload = {
        "type": "texture_model",
        "original_model_task_id": original_task_id,
        "model_version": TEXTURE_MODEL_VERSION,
        "texture_prompt": {
            "image": image_file_payload(image_token, image_path),
        },
        "texture": True,
        "pbr": True,
        "texture_quality": TEXTURE_QUALITY,
        "texture_alignment": "original_image",
        "bake": True,
    }

    print(
        "\n[4/7] 生成高级 PBR 贴图："
        f"{TEXTURE_MODEL_VERSION} / {TEXTURE_QUALITY}"
    )
    response = requests.post(
        url,
        headers={**HEADERS, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    result = check_response(response)
    task_id = result["data"]["task_id"]
    print("高级贴图任务已创建")
    print("task_id:", task_id)
    return task_id


# ============================================================
# 3. 等待任务完成
# ============================================================

def wait_for_task(task_id: str):
    url = f"{BASE_URL}/task/{task_id}"

    start_time = time.time()

    last_progress = None

    while True:

        if time.time() - start_time > TIMEOUT:
            raise TimeoutError(
                f"任务等待超过 {TIMEOUT} 秒"
            )

        response = requests.get(
            url,
            headers=HEADERS,
            timeout=60,
        )

        result = check_response(response)

        data = result["data"]

        status = data.get("status")
        progress = data.get("progress", 0)

        if progress != last_progress:
            print(
                f"任务状态：{status} "
                f"进度：{progress}%"
            )
            last_progress = progress

        if status == "success":
            print("任务完成")
            return data

        if status in {
            "failed",
            "failure",
            "cancelled",
            "canceled",
            "banned",
            "expired",
        }:
            raise RuntimeError(
                "任务失败：\n"
                + json.dumps(
                    data,
                    indent=2,
                    ensure_ascii=False,
                )
            )

        time.sleep(POLL_INTERVAL)


# ============================================================
# 5. GLB -> 静态贴图 FBX
# ============================================================

def create_fbx_conversion_task(
    original_task_id: str,
) -> str:

    if FBX_PRESET not in {"blender", "3dsmax", "mixamo"}:
        raise ValueError(
            "TRIPO_FBX_PRESET 只能是 blender、3dsmax 或 mixamo"
        )

    url = f"{BASE_URL}/task"

    payload = {
        "type": "convert_model",

        "original_model_task_id": original_task_id,

        "format": "FBX",

        # 将材质效果烘焙进 PNG 贴图，便于 Unity/UE/Blender 导入。
        "bake": True,

        "texture_format": "PNG",

        "texture_size": TEXTURE_SIZE,

        # 不启用 quad，也不设置 face_limit：保持原始网格拓扑。
        "quad": False,

        # 此处是绑骨前的静态备份；骨骼/蒙皮由后续 animate_rig 生成。
        "with_animation": False,

        # 对齐后续 Mixamo 骨架命名及常用游戏引擎导入流程。
        "fbx_preset": FBX_PRESET,

        # 让模型原点位于底部中心，导入场景后更容易落地。
        "pivot_to_center_bottom": True,
    }

    headers = {
        **HEADERS,
        "Content-Type": "application/json",
    }

    print("\n[5/7] 导出静态贴图 FBX")

    response = requests.post(
        url,
        headers=headers,
        json=payload,
        timeout=60,
    )

    result = check_response(response)

    task_id = result["data"]["task_id"]

    print("静态 FBX 转换任务已创建")
    print("task_id:", task_id)

    return task_id


# ============================================================
# 6. 绑骨预检 -> 自动绑骨
# ============================================================

def create_rig_check_task(original_task_id: str) -> str:
    """检查模型是否适合绑骨，并让 Tripo 推荐骨骼类型。"""
    url = f"{BASE_URL}/task"
    payload = {
        "type": "animate_prerigcheck",
        "original_model_task_id": original_task_id,
    }

    print("\n[6/7] 检查模型是否可以绑骨")
    response = requests.post(
        url,
        headers={**HEADERS, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    result = check_response(response)
    task_id = result["data"]["task_id"]
    print("绑骨预检任务已创建")
    print("task_id:", task_id)
    return task_id


def create_rig_task(original_task_id: str, rig_type: str) -> str:
    """使用预检推荐的类型，生成 Mixamo 兼容骨骼模型。"""
    if RIG_SPEC not in {"mixamo", "tripo"}:
        raise ValueError("TRIPO_RIG_SPEC 只能是 mixamo 或 tripo")

    url = f"{BASE_URL}/task"
    payload = {
        "type": "animate_rig",
        "original_model_task_id": original_task_id,
        "model_version": RIG_MODEL_VERSION,
        "out_format": RIG_FORMAT,
        "rig_type": rig_type,
        "spec": RIG_SPEC,
    }

    print(f"\n[7/7] 自动绑骨：{rig_type} / {RIG_SPEC} / {RIG_FORMAT}")
    response = requests.post(
        url,
        headers={**HEADERS, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    result = check_response(response)
    task_id = result["data"]["task_id"]
    print("自动绑骨任务已创建")
    print("task_id:", task_id)
    return task_id


# ============================================================
# 下载任务返回的全部文件
# ============================================================

def collect_named_urls(obj, path="output"):
    """递归返回 (字段路径, URL)，用于下载任务返回的全部文件。"""
    items = []

    if isinstance(obj, dict):
        for key, value in obj.items():
            items.extend(collect_named_urls(value, f"{path}.{key}"))
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            items.extend(collect_named_urls(value, f"{path}.{index}"))
    elif isinstance(obj, str) and obj.startswith(("http://", "https://")):
        items.append((path, obj))

    return items


def safe_filename(value: str) -> str:
    """把任务字段名转换成 Windows 可用文件名。"""
    value = re.sub(r"[^0-9A-Za-z._-]+", "_", value).strip("._")
    return value or "file"


def unique_path(path: Path) -> Path:
    """文件已存在时追加序号，避免覆盖同名产物。"""
    if not path.exists():
        return path

    for index in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{index}{path.suffix}")
        if not candidate.exists():
            return candidate

    raise RuntimeError(f"无法为文件生成不重复名称：{path}")


def response_filename(response: requests.Response, url: str) -> str:
    """优先从响应头获取文件名，否则使用 URL 路径。"""
    disposition = response.headers.get("Content-Disposition", "")
    match = re.search(r"filename\*?=(?:UTF-8''|\")?([^\";]+)", disposition, re.I)
    if match:
        name = unquote(match.group(1).strip().strip('"'))
        if name:
            return Path(name).name

    url_name = unquote(Path(urlparse(url).path).name)
    return url_name or "download"


def extension_from_content_type(content_type: str) -> str:
    content_type = content_type.lower().split(";", 1)[0].strip()
    return {
        "model/gltf-binary": ".glb",
        "model/gltf+json": ".gltf",
        "application/zip": ".zip",
        "application/x-zip-compressed": ".zip",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "application/octet-stream": "",
    }.get(content_type, "")


def extract_zip_safely(zip_path: Path, extract_dir: Path) -> list[Path]:
    """解压模型/贴图包，并阻止 ZIP 路径穿越。"""
    extract_dir.mkdir(parents=True, exist_ok=True)
    root = extract_dir.resolve()
    extracted = []

    with zipfile.ZipFile(zip_path, "r") as archive:
        for member in archive.infolist():
            target = (extract_dir / member.filename).resolve()
            if os.path.commonpath([str(root), str(target)]) != str(root):
                raise RuntimeError(f"ZIP 中包含不安全路径：{member.filename}")
            archive.extract(member, extract_dir)
            if not member.is_dir():
                extracted.append(target)

    return extracted


def download_output_files(
    output,
    destination: Path,
    name_hints: dict[str, str] | None = None,
) -> list[Path]:
    """下载 output 中的全部 URL，并自动解压 ZIP。"""
    destination.mkdir(parents=True, exist_ok=True)
    name_hints = name_hints or {}
    downloaded = []
    seen_urls = set()

    for field_path, url in collect_named_urls(output):
        if url in seen_urls:
            continue
        seen_urls.add(url)

        print("下载：", url)
        response = requests.get(url, stream=True, timeout=300)
        response.raise_for_status()

        original_name = response_filename(response, url)
        original_suffix = Path(original_name).suffix
        suffix = original_suffix or extension_from_content_type(
            response.headers.get("Content-Type", "")
        )

        hint = name_hints.get(url)
        if hint:
            filename = safe_filename(hint) + suffix
        elif original_name != "download":
            filename = safe_filename(original_name)
            if suffix and not Path(filename).suffix:
                filename += suffix
        else:
            filename = safe_filename(field_path.replace("output.", "")) + suffix

        file_path = unique_path(destination / filename)
        with open(file_path, "wb") as file_handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    file_handle.write(chunk)

        downloaded.append(file_path.resolve())
        print("已保存：", file_path)

        content_type = response.headers.get("Content-Type", "").lower()
        if file_path.suffix.lower() == ".zip" or "zip" in content_type:
            extracted = extract_zip_safely(
                file_path,
                destination / f"{file_path.stem}_files",
            )
            downloaded.extend(extracted)
            print(f"已解压：{len(extracted)} 个文件")

    if not downloaded:
        print("警告：任务 output 中没有发现可下载 URL")

    return downloaded


def save_manifest(run_dir: Path, manifest: dict):
    """保存任务和本地文件清单，便于引擎导入与故障恢复。"""
    manifest_path = run_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as file_handle:
        json.dump(manifest, file_handle, indent=2, ensure_ascii=False)
    return manifest_path


# ============================================================
# 主流程
# ============================================================

def main():
    print("=" * 60)
    print("Tripo 图片 -> 高质量 PBR 3D -> 静态 FBX -> 绑骨 FBX")
    print("=" * 60)

    validate_settings()

    # 创建任务需要额度。先检查，避免上传后才收到难以判断的 403。
    balance, frozen = ensure_available_balance()

    run_dir = (
        Path(OUTPUT_DIR)
        / datetime.now().strftime("tripo_asset_%Y%m%d_%H%M%S")
    )
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "status": "running",
        "created_at": datetime.now().astimezone().isoformat(),
        "input_image": str(Path(IMAGE_PATH).resolve()),
        "account": {"balance_before": balance, "frozen": frozen},
        "settings": {
            "api_base_url": BASE_URL,
            "generation_model": MODEL_VERSION,
            "geometry_quality": GEOMETRY_QUALITY,
            "face_limit": FACE_LIMIT,
            "texture_model": TEXTURE_MODEL_VERSION,
            "texture_quality": TEXTURE_QUALITY,
            "fbx_texture_size": TEXTURE_SIZE,
            "rig_model": RIG_MODEL_VERSION,
            "rig_spec": RIG_SPEC,
            "fbx_preset": FBX_PRESET,
            "rig_format": RIG_FORMAT,
        },
        "stages": {},
        "files": [],
    }
    manifest_path = save_manifest(run_dir, manifest)

    def record_stage(name, task_id, result, files=None):
        manifest["stages"][name] = {
            "task_id": task_id,
            "status": result.get("status"),
            "credits_consumed": result.get(
                "credits_consumed",
                result.get("consumed_credit"),
            ),
            "output": result.get("output", {}),
        }
        if files:
            paths = [str(Path(path).resolve()) for path in files]
            manifest["stages"][name]["files"] = paths
            manifest["files"].extend(paths)
        save_manifest(run_dir, manifest)

    try:
        # 1-3. 上传、生成高质量 3D 几何，并立刻下载全部输出。
        image_token = upload_image(IMAGE_PATH)
        model_task_id = create_image_to_model_task(image_token, IMAGE_PATH)

        print("\n[3/7] 等待高质量 3D 几何生成")
        model_result = wait_for_task(model_task_id)
        model_output = model_result.get("output", {})
        generated_files = download_output_files(
            model_output,
            run_dir / "01_generated_geometry",
        )
        record_stage(
            "generated_geometry",
            model_task_id,
            model_result,
            generated_files,
        )

        # 4. 独立高级贴图模型：用原图生成高清 PBR 贴图。
        texture_task_id = create_texture_task(
            model_task_id,
            image_token,
            IMAGE_PATH,
        )
        texture_result = wait_for_task(texture_task_id)
        textured_files = download_output_files(
            texture_result.get("output", {}),
            run_dir / "02_textured_pbr",
        )
        record_stage(
            "textured_pbr",
            texture_task_id,
            texture_result,
            textured_files,
        )

        # 5. 导出带贴图的静态 FBX，作为未绑骨的原始资产备份。
        # 后续绑骨使用贴图任务，不使用转换结果，避免转换影响拓扑。
        convert_task_id = create_fbx_conversion_task(texture_task_id)
        convert_result = wait_for_task(convert_task_id)
        static_fbx_files = download_output_files(
            convert_result.get("output", {}),
            run_dir / "03_static_fbx",
        )
        record_stage(
            "static_fbx",
            convert_task_id,
            convert_result,
            static_fbx_files,
        )

        # 6. 绑骨预检会返回最合适的 biped/quadruped/... 类型。
        check_task_id = create_rig_check_task(texture_task_id)
        check_result = wait_for_task(check_task_id)
        check_output = check_result.get("output", {})
        record_stage("rig_check", check_task_id, check_result)

        riggable = check_output.get("riggable", check_result.get("riggable"))
        rig_type = check_output.get("rig_type", check_result.get("rig_type"))
        if not riggable:
            raise RuntimeError(
                "该模型未通过 Tripo 绑骨预检。请使用正面、四肢无遮挡、"
                "姿势清晰的角色图片重新生成。"
            )
        if not rig_type:
            raise RuntimeError(
                "绑骨预检成功，但响应中缺少 rig_type：\n"
                + json.dumps(check_result, indent=2, ensure_ascii=False)
            )
        print("推荐骨骼类型：", rig_type)

        # 7. 生成 Mixamo/Tripo 骨骼模型。
        rig_task_id = create_rig_task(texture_task_id, rig_type)
        rig_result = wait_for_task(rig_task_id)
        rigged_files = download_output_files(
            rig_result.get("output", {}),
            run_dir / "04_rigged",
        )
        record_stage("rigged", rig_task_id, rig_result, rigged_files)

        manifest["rig_type"] = rig_type
        manifest["status"] = "success"
        manifest["completed_at"] = datetime.now().astimezone().isoformat()
        save_manifest(run_dir, manifest)

    except Exception as error:
        manifest["status"] = "failed"
        manifest["error"] = str(error)
        manifest["failed_at"] = datetime.now().astimezone().isoformat()
        save_manifest(run_dir, manifest)
        raise

    print("\n全部完成")
    print("资产目录：", run_dir.resolve())
    print("文件清单：", manifest_path.resolve())
    print("下载文件数：", len(manifest["files"]))
    print("骨骼类型：", manifest["rig_type"])
    print("=" * 60)


if __name__ == "__main__":
    main()
