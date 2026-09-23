import json
import re
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from chat_analysis.analyzer import ChatProfileAnalyzer
from chat_analysis.archive import load_archive_bytes, load_parsed_messages
from chat_analysis.config import settings as analysis_settings
from chat_analysis.output import write_messages

from app.agent_files import (
    DEFAULT_AGENT_ID,
    agent_dir,
    count_memory_items,
    AgentFiles,
    ensure_default,
    generate_from_profile,
    read_agent,
)
from app.config import settings


ID_RE = re.compile(r"^[0-9a-f]{32}$")
ROOT = settings.profile_data_dir


def load_agent(profile_id: str | None) -> AgentFiles:
    """决定这次对话用「谁的」提示词和 memory。

    这是本模块对外的唯一入口 —— 对话路径不该再碰 `prompt_context` 那套
    （“每轮读整个档案 JSON 再现场截断”），只读两个生成好的 Markdown 文件。

    三种情况：
      没传 profile_id  → 默认档案（缺失时播种，所以它总是存在）
      传了且已生成      → 直接读
      传了但没生成      → 从 profiles/<id>.json 现场补生成

    第三种是**为了旧数据**：agents/ 是后加的，之前的档案只有 profiles/<id>.json。
    补生成让它们不用重新跑一遍分析（那要花一次模型调用）。
    """
    if not profile_id:
        ensure_default(ROOT, settings.system_prompt)
        agent = read_agent(ROOT, DEFAULT_AGENT_ID)
        if agent is None:  # ensure_default 之后仍读不到，只可能是磁盘问题
            raise ValueError("默认档案无法读取")
        return agent

    profile = get_profile(profile_id)
    if profile is None:
        raise ValueError("人物档案不存在")

    agent = read_agent(ROOT, profile_id)
    if agent is not None:
        return agent

    return generate_from_profile(
        ROOT,
        profile,
        fallback_prompt=settings.system_prompt,
        model_name=settings.model_name,
    )


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def import_zip(data: bytes) -> dict:
    if len(data) > 10_000_000:
        raise ValueError("ZIP 文件不能超过 10 MB")
    messages = load_archive_bytes(data)
    archive_id = uuid4().hex
    write_messages(messages, ROOT / "imports" / archive_id)
    return {
        "archive_id": archive_id,
        "message_count": len(messages),
        "speakers": sorted({message.speaker for message in messages}),
    }


def start_analysis(archive_id: str, target_speaker: str) -> dict:
    if not ID_RE.fullmatch(archive_id):
        raise ValueError("archive_id 不合法")
    parsed = ROOT / "imports" / archive_id / "parsed_messages.json"
    if not parsed.is_file():
        raise FileNotFoundError("聊天归档不存在")
    messages = load_parsed_messages(parsed)
    if target_speaker not in {message.speaker for message in messages}:
        raise ValueError("目标说话者不在归档中")
    if not (analysis_settings.api_key or settings.openai_api_key):
        raise ValueError("未配置分析模型 API Key")
    job_id = uuid4().hex
    job = {
        "job_id": job_id,
        "archive_id": archive_id,
        "target_speaker": target_speaker,
        "status": "queued",
        "created_at": datetime.now().astimezone().isoformat(),
    }
    _write(ROOT / "jobs" / f"{job_id}.json", job)
    return job


def run_analysis(job_id: str) -> None:
    job_path = ROOT / "jobs" / f"{job_id}.json"
    job = _read(job_path)
    job["status"] = "running"
    _write(job_path, job)
    try:
        messages = load_parsed_messages(
            ROOT / "imports" / job["archive_id"] / "parsed_messages.json"
        )
        analyzer_settings = replace(
            analysis_settings,
            api_key=analysis_settings.api_key or settings.openai_api_key,
            base_url=analysis_settings.base_url or settings.openai_base_url,
            model_name=analysis_settings.model_name
            if analysis_settings.api_key else settings.model_name,
        )
        result = ChatProfileAnalyzer(analyzer_settings).analyze(
            messages, job["target_speaker"]
        )
        profile = {
            "profile_id": job_id,
            "archive_id": job["archive_id"],
            "created_at": datetime.now().astimezone().isoformat(),
            **result.model_dump(),
        }
        _write(ROOT / "profiles" / f"{job_id}.json", profile)

        # ★ 分析的产物不是给人看的 JSON，而是**给智能体用的两个文件**。
        #   在这里一次性渲染好，对话时只读这两个文件；
        #   否则每一轮都要读原始档案、按代码里写死的规则现场截断。
        #   放在 job 置成 complete **之前**：渲染失败就当任务失败，
        #   宁可让用户看见失败，也不要留一个“任务成功但智能体拿到的是默认人设”的隐形状态。
        directory = generate_from_profile(
            ROOT,
            profile,
            fallback_prompt=settings.system_prompt,
            model_name=analyzer_settings.model_name,
        )
        job["agent_dir"] = str(directory)
        job["status"] = "complete"
        job["profile_id"] = job_id
        job["finished_at"] = datetime.now().astimezone().isoformat()
    except Exception as error:
        job["status"] = "failed"
        job["error"] = str(error)[:500]
    _write(job_path, job)


def get_job(job_id: str) -> dict | None:
    if not ID_RE.fullmatch(job_id):
        return None
    path = ROOT / "jobs" / f"{job_id}.json"
    return _read(path) if path.is_file() else None


def get_profile(profile_id: str) -> dict | None:
    if not ID_RE.fullmatch(profile_id):
        return None
    path = ROOT / "profiles" / f"{profile_id}.json"
    return _read(path) if path.is_file() else None


def list_profiles() -> list[dict]:
    directory = ROOT / "profiles"
    if not directory.is_dir():
        return []
    result = []
    for path in sorted(directory.glob("*.json"), reverse=True):
        profile = _read(path)
        result.append({
            "profile_id": profile["profile_id"],
            "target_speaker": profile["target_speaker"],
            "profile_summary": profile["profile_summary"],
            "created_at": profile["created_at"],
        })
    return result


def _agent_meta(agent_id: str) -> dict:
    path = agent_dir(ROOT, agent_id) / "meta.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def describe_agent(profile_id: str | None, *, regenerate: bool = False) -> dict:
    """给前端看的：这份智能体**实际加载了什么**。

    为什么要专门一个函数：改成“只读生成好的文件”之后，
    用户如果看不到那两个文件的内容，就变成了“不知道智能体拿到了什么”——
    那比改动前更糟。所以把生效的全文一并返回。

    regenerate=True 时强制重新渲染（用于“改完档案重生成”），
    但**不动 profiles/<id>.json** —— 原始分析结果保留，可以对比重生成前后差了什么。
    """
    agent_id = profile_id or DEFAULT_AGENT_ID

    if regenerate:
        profile = get_profile(agent_id)
        if profile is None:
            raise ValueError("人物档案不存在")
        agent = generate_from_profile(
            ROOT,
            profile,
            fallback_prompt=settings.system_prompt,
            model_name=settings.model_name,
        )
    else:
        agent = load_agent(profile_id)

    meta = _agent_meta(agent.agent_id)
    return {
        "agent_id": agent.agent_id,
        "target_speaker": meta.get("target_speaker", ""),
        "source": agent.source,
        "generated_at": meta.get("generated_at", ""),
        "model_name": meta.get("model_name", ""),
        "directory": str(agent_dir(ROOT, agent.agent_id)),
        "system_prompt": agent.system_prompt,
        "memory": agent.memory,
        "system_prompt_chars": len(agent.system_prompt),
        "memory_items": agent.memory.count("\n- "),
    }


# ── 旧的每轮截断实现 ──────────────────────────────────────────────────────
#
# 已删除。原来它是：
#
#     def prompt_context(profile_id: str) -> str:
#         profile = get_profile(profile_id)                        # 每轮读整个 JSON
#         memories = [m["fact"][:300] for m in ...[:15]]
#         return (...[:1000] ... [:2500] ... )[:5000]              # 每轮截断
#
# 问题在于：给模型的是**分析中间产物**（含 evidence 引用、性格置信度），
# 而不是“给智能体用的东西”；截断规则又写死在代码里，想调就得改 Python。
# 现在换成 agents/<id>/system_prompt.md + memory.md，
# 对话只看这两个文件，且它们可以直接编辑。
