#!/usr/bin/env python3
"""Generate, edit, or extend one InstaMate clip with Model Studio.

The CSV stays on your machine. This script never prints its API key, and it
does not create a billable task unless --submit is supplied.
"""

import argparse
import base64
import csv
import json
import mimetypes
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


DEFAULT_PROMPT = (
    "5秒、16:9横屏的产品概念片头。温暖的桌面夜景中，几张照片化为柔和光点，"
    "汇聚成一位原创动漫风3D桌面伙伴。角色自然眨眼，轻轻挥手，镜头缓慢推进。"
    "画面温暖、克制、有陪伴感；无文字、无真实软件界面、无品牌标识。"
)
MODELS = ("wan3.0-video", "happyhorse-1.1-t2v", "happyhorse-1.1-i2v")


def read_settings(path: Path) -> tuple[str, str]:
    with path.open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.reader(file))
    settings = {row[0]: row[1] for row in rows if len(row) == 2}
    api_key = settings.get("apiKey", "").strip()
    base_url = settings.get("dashScope", "").strip().rstrip("/")
    parsed = urlsplit(base_url)
    if not api_key or parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("CSV 缺少有效的 apiKey 或 HTTPS dashScope 地址")
    if not parsed.hostname.endswith(".maas.aliyuncs.com") or parsed.path != "/api/v1":
        raise ValueError("CSV 中的 dashScope 地址不是预期的百炼业务空间 API")
    return api_key, base_url


def image_data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0]
    if mime not in ("image/jpeg", "image/png", "image/webp"):
        raise ValueError("首帧图片需为 JPG、PNG 或 WEBP")
    raw = path.read_bytes()
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("首帧图片不能超过 20 MB")
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def upload_video(path: Path, key: str) -> str:
    """Upload a local clip to Model Studio's model-bound temporary OSS storage."""
    if path.suffix.lower() not in (".mp4", ".mov"):
        raise ValueError("参考视频需为 MP4 或 MOV")
    if path.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("参考视频不能超过 100 MB")
    policy_url = "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=wan3.0-video"
    policy = request_json(policy_url, key)["data"]
    upload_host = policy["upload_host"]
    host = urlsplit(upload_host)
    if host.scheme != "https" or not host.hostname or not host.hostname.endswith(".aliyuncs.com"):
        raise ValueError("百炼返回的上传地址不是安全的阿里云 HTTPS 地址")

    file_name = f"instamate-{uuid.uuid4().hex}{path.suffix.lower()}"
    object_key = f"{policy['upload_dir']}/{file_name}"
    fields = {
        "OSSAccessKeyId": policy["oss_access_key_id"],
        "Signature": policy["signature"],
        "policy": policy["policy"],
        "x-oss-object-acl": policy["x_oss_object_acl"],
        "x-oss-forbid-overwrite": policy["x_oss_forbid_overwrite"],
        "key": object_key,
        "success_action_status": "200",
    }
    boundary = f"----instamate-{uuid.uuid4().hex}"
    parts = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    mime = "video/mp4" if path.suffix.lower() == ".mp4" else "video/quicktime"
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode()
    )
    parts.append(path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    request = Request(
        upload_host,
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urlopen(request, timeout=180) as response:
            if response.status != 200:
                raise RuntimeError(f"上传失败: HTTP {response.status}")
    except HTTPError as error:
        raise RuntimeError(f"上传失败: HTTP {error.code}") from error
    return f"oss://{object_key}"


def request_json(url: str, key: str, body: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {key}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        headers["X-DashScope-Async"] = "enable"
        headers["X-DashScope-OssResourceResolve"] = "enable"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers=headers)
    try:
        with urlopen(request, timeout=60) as response:
            result = json.load(response)
    except HTTPError as error:
        try:
            detail = json.load(error)
            reason = f"{detail.get('code', error.code)}: {detail.get('message', '请求失败')}"
        except (ValueError, UnicodeDecodeError):
            reason = f"HTTP {error.code}"
        raise RuntimeError(reason) from error
    if result.get("code"):
        raise RuntimeError(f"{result['code']}: {result.get('message', '请求失败')}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, required=True, help="百炼 API Key CSV 文件")
    parser.add_argument("--model", choices=MODELS, default="wan3.0-video")
    parser.add_argument("--image", type=Path, help="可选：本地首帧图片；HappyHorse i2v 必填")
    parser.add_argument("--video", type=Path, help="本地 MP4/MOV，上传后作为参考视频")
    parser.add_argument("--mode", choices=("edit", "extend"), help="使用参考视频时选择修改或延长")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--duration", type=int, help="输出时长；视频修改/延长默认自动(-1)")
    parser.add_argument("--resolution", choices=("480P", "720P", "1080P"), default="480P")
    parser.add_argument("--output", type=Path, default=Path.home() / "Desktop/instamate-demo-clip.mp4")
    parser.add_argument("--task-id", help="继续查询已提交任务，不会再次创建任务")
    parser.add_argument("--submit", action="store_true", help="真正提交付费生成任务")
    args = parser.parse_args()

    key, base_url = read_settings(args.csv)
    if not args.task_id:
        if args.video and (args.image or args.model != "wan3.0-video"):
            parser.error("--video 当前仅支持 wan3.0-video，且不能同时使用 --image")
        if bool(args.video) != bool(args.mode):
            parser.error("--video 和 --mode edit|extend 需一起使用")
        duration = args.duration if args.duration is not None else (-1 if args.video else 5)
        if args.model == "happyhorse-1.1-i2v" and not args.image:
            parser.error("happyhorse-1.1-i2v 需要 --image")
        if args.model == "happyhorse-1.1-t2v" and args.image:
            parser.error("happyhorse-1.1-t2v 是文生视频，请去掉 --image")
        minimum, maximum = (2, 30) if args.model == "wan3.0-video" else (3, 15)
        if duration != -1 and not minimum <= duration <= maximum:
            parser.error(f"此模型时长需为 {minimum}–{maximum} 秒")
        if duration == -1 and args.model != "wan3.0-video":
            parser.error("此模型不支持自动时长 -1")
        if args.image and not args.image.is_file():
            parser.error("找不到首帧图片")
        if args.video and not args.video.is_file():
            parser.error("找不到参考视频")
        if args.video and args.video.suffix.lower() not in (".mp4", ".mov"):
            parser.error("参考视频需为 MP4 或 MOV")
        if args.video and args.video.stat().st_size > 100 * 1024 * 1024:
            parser.error("参考视频不能超过 100 MB")
        if args.video and args.video.resolve() == args.output.resolve():
            parser.error("输出路径不能与参考视频相同")
        if args.video and args.prompt == DEFAULT_PROMPT:
            parser.error("使用参考视频时，请用 --prompt 写明要修改或延长的内容")
        prompt = ("编辑视频1。" if args.mode == "edit" else "延长视频1。") + args.prompt if args.video else args.prompt

        duration_label = "自动时长" if duration == -1 else f"{duration} 秒"
        print(f"模型: {args.model} | {duration_label} | {args.resolution}")
        source = f"参考视频 {args.video} ({args.mode})" if args.video else f"首帧 {args.image}" if args.image else "仅文字"
        print(f"素材: {source}")
        print(f"输出: {args.output}")
        print(f"提示词: {prompt}")
        if not args.submit:
            print("预览完成。加 --submit 才会提交并计费。")
            return

        input_data = {"prompt": prompt}
        if args.image:
            input_data["media"] = [{"type": "first_frame", "url": image_data_url(args.image)}]
        if args.video:
            print("正在上传参考视频到百炼临时存储…")
            input_data["media"] = [{"type": "reference_video", "url": upload_video(args.video, key)}]
        parameters = {"resolution": args.resolution, "duration": duration}
        if args.model == "wan3.0-video":
            parameters["ratio"] = "adaptive" if args.image or args.video else "16:9"
            parameters["prompt_extend"] = True
        elif args.model == "happyhorse-1.1-t2v":
            parameters["ratio"] = "16:9"
            parameters["watermark"] = False
        else:
            parameters["watermark"] = False

        result = request_json(
            base_url + "/services/aigc/video-generation/video-synthesis",
            key,
            {"model": args.model, "input": input_data, "parameters": parameters},
        )
        task_id = result.get("output", {}).get("task_id")
        if not task_id:
            raise RuntimeError("创建任务未返回 task_id")
        print(f"任务已提交: {task_id}")
    else:
        task_id = args.task_id

    for _ in range(48):
        result = request_json(base_url + "/tasks/" + task_id, key)
        output = result.get("output", {})
        status = output.get("task_status")
        print(f"任务状态: {status}")
        if status == "SUCCEEDED":
            video_url = output.get("video_url", "")
            if urlsplit(video_url).scheme != "https":
                raise RuntimeError("任务成功，但没有安全的 HTTPS 视频下载地址")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with urlopen(video_url, timeout=120) as video, args.output.open("wb") as file:
                while chunk := video.read(1024 * 1024):
                    file.write(chunk)
            print(f"已保存: {args.output}")
            return
        if status not in ("PENDING", "RUNNING"):
            raise RuntimeError(f"任务结束: {status}，{output.get('message', result.get('message', ''))}")
        time.sleep(15)
    print(f"仍在处理。稍后用 --task-id {task_id} 继续查询，不要重复提交。")


if __name__ == "__main__":
    main()
