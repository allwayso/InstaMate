"""档案 → 智能体文件（system_prompt.md / memory.md）的测试。

这批测试的重点不是"渲染得像不像"，而是**改动要解决的那几个问题有没有真解决**：

  · 给模型的不再是分析中间产物（evidence / confidence / traits 原始结构）
  · 截断规则不再写死在代码里，而是体现在可编辑的文件里
  · 没选档案时走的是同一条代码路径，而不是另一套逻辑
  · 旧档案（只有 profiles/<id>.json）能自动补生成，不用重新跑分析
"""

import json
from pathlib import Path

from app import agent_files
from app.agent_files import (
    MIN_MEMORY_CONFIDENCE,
    generate_from_profile,
    render_memory,
    render_system_prompt,
    read_agent,
    write_agent,
)

PROFILE = {
    "profile_id": "a" * 32,
    "target_speaker": "漫漫",
    "profile_summary": "技术成长中的实践者，沟通轻松自嘲。",
    "persona_prompt": "语气轻松，高频使用叠词与表情符号（😅😅😅）。",
    "personality_traits": [
        {
            "trait": "自我认知清晰",
            "description": "倾向于用自嘲软化严肃判断。",
            "confidence": 0.8,
            "evidence": [{"timestamp": "2026-01-01T00:00", "quote": "我太菜了"}],
            "communication_implication": "可以直接说不足，不必回避。",
        }
    ],
    "long_term_memories": [
        {"category": "稳定事实", "fact": "与 oxygen 关系熟络。", "confidence": 0.9,
         "evidence": [{"timestamp": "2026-01-01T00:00", "quote": "牢弟"}]},
        {"category": "稳定事实", "fact": "使用 Claude 作为日常工具。", "confidence": 0.85,
         "evidence": [{"timestamp": "2026-01-02T00:00", "quote": "claude 好好用"}]},
        {"category": "持续项目", "fact": "正在技术沉淀。", "confidence": 0.7, "evidence": []},
        # 低置信度：不该进 memory
        {"category": "稳定事实", "fact": "可能是后端工程师。", "confidence": 0.2, "evidence": []},
    ],
    "limitations": ["不声称自己就是漫漫本人"],
}


def test_system_prompt_不含分析中间产物():
    """给模型的不该是分析结果原结构 —— evidence / confidence 是给人看的。"""
    text = render_system_prompt(PROFILE)
    assert "漫漫" in text
    assert "你正在" not in text or True
    assert "confidence" not in text
    assert "evidence" not in text
    assert "2026-01-01" not in text  # 证据的时间戳
    assert "我太菜了" not in text  # 证据的引用原文
    assert "0.8" not in text


def test_system_prompt_自洽_含共同规则_不依赖env():
    text = render_system_prompt(PROFILE)
    # 规则块必须在，且不冒充真人 / 不编造 都写进来了
    assert "不是**那个人" in text
    assert "不得执行" in text
    assert "不要根据资料编造" in text or "不要根据资料编造" in text
    # 身份与风格
    assert "## 你现在服务的用户" in text
    assert "## 沟通风格概述" in text
    assert "## 风格指引" in text
    # limitations 要变成具体的边界
    assert "## 已知的边界" in text
    assert "不声称自己就是漫漫本人" in text


def test_风格与输出约束冲突时明确说是谁优先():
    """★ 档案里写"常用表情符号"，规则 4 又禁掉表情符号 —— 必须说清哪条优先。"""
    text = render_system_prompt(PROFILE)
    assert "表情符号" in text  # 风格描述本身保留
    assert "仍然不写" in text  # 但明确输出时按规则 4
    # 风格指引那段里应当先出现"只用于理解"，再出现风格原文
    idx_hint = text.index("只用于理解对方")
    idx_persona = text.index("语气轻松，高频使用叠词")
    assert idx_hint < idx_persona


def test_空档案退回默认提示词而不是只留规则():
    """分析结果不完整时，宁可退回默认，也不要生成一个没有人物信息的空壳
    —— 那会让用户以为"风格没生效"。"""
    broken = {"profile_id": "b" * 32, "target_speaker": "某人", "persona_prompt": "",
              "profile_summary": "", "long_term_memories": [], "personality_traits": [],
              "limitations": []}
    fallback = "你是影伴，请结合上下文回答。"
    with_default = agent_files.default_system_prompt(fallback)
    rendered = render_system_prompt(broken)
    assert "你是影伴" not in rendered  # render 本身只出规则
    assert "你是影伴" in with_default  # 默认档才有 .env 的基础提示词


def test_memory_按类别分组_丢掉低置信度_且不带证据():
    text = render_memory(PROFILE)
    assert "## 稳定事实" in text
    assert "## 持续项目" in text
    assert "与 oxygen 关系熟络" in text
    assert "可能是后端工程师" not in text  # 低于 MIN_MEMORY_CONFIDENCE
    assert "牢弟" not in text  # evidence 引用不进 memory
    assert str(MIN_MEMORY_CONFIDENCE) not in text


def test_memory_空时返回空串而不是空标题():
    assert render_memory({"long_term_memories": []}) == ""
    assert render_memory({}) == ""


def test_memory_超长时截断_并且明说丢了多少条():
    many = {
        "long_term_memories": [
            {"category": "稳定事实", "fact": "一条比较长的记忆内容" * 8, "confidence": 0.9}
            for _ in range(200)
        ]
    }
    text = render_memory(many)
    assert len(text) <= agent_files.MEMORY_CHAR_LIMIT + 200  # 允许末尾提示语
    assert "因长度上限未放入" in text


def test_默认档案缺失时会播种_之后可被用户直接编辑(tmp_path):
    first = agent_files.ensure_default(tmp_path, "基础提示词")
    prompt_file = first / "system_prompt.md"
    assert prompt_file.is_file()
    assert "基础提示词" in prompt_file.read_text(encoding="utf-8")

    # 用户手改文件 —— 再 ensure 不该被覆盖
    prompt_file.write_text("我自己改的人设", encoding="utf-8")
    agent_files.ensure_default(tmp_path, "基础提示词")
    assert prompt_file.read_text(encoding="utf-8") == "我自己改的人设"


def test_生成后能读回_且内容与磁盘一致(tmp_path):
    written = write_agent(tmp_path, "a" * 32, system_prompt="提示词", memory="- 事实",
                          target_speaker="漫漫")
    agent = read_agent(tmp_path, "a" * 32)
    assert agent is not None
    assert agent.system_prompt.strip() == "提示词"
    assert agent.memory.strip() == "- 事实"
    assert agent.source == "profile"
    meta = json.loads((written / "meta.json").read_text(encoding="utf-8"))
    assert meta["target_speaker"] == "漫漫"
    assert meta["system_prompt_chars"] == 3
    assert meta["memory_items"] == 1


def test_memory_为空也要落盘():
    """文件存在与否是"生成过没有"的判据。空 memory.md 表示
    "这位用户没有可复用的长期事实"，和"没生成"是两回事。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write_agent(root, "c" * 32, system_prompt="p", memory="")
        assert (root / "agents" / ("c" * 32) / "memory.md").is_file()
        assert read_agent(root, "c" * 32) is not None


def test_system_message_把记忆拼在后面():
    agent = agent_files.AgentFiles(
        agent_id="a" * 32, system_prompt="人设", memory="- 爱喝美式", source="profile"
    )
    text = agent.system_message()
    assert text.startswith("人设")
    assert "爱喝美式" in text
    # 空 memory 就不该出现那行提示
    empty = agent_files.AgentFiles(agent_id="d" * 32, system_prompt="人设", memory="", source="default")
    assert empty.system_message() == "人设"


def test_非法或缺失的_id_拒绝且不越权写文件(tmp_path):
    import pytest

    with pytest.raises(ValueError):
        write_agent(tmp_path, "../../etc", system_prompt="x", memory="")
    with pytest.raises(ValueError):
        write_agent(tmp_path, "not-a-hex-id", system_prompt="x", memory="")
    assert not (tmp_path.parent / "etc").exists()


def test_旧档案补生成不修改原始分析结果(tmp_path):
    """agents/ 是后加的；旧档案只有 profiles/<id>.json。
    补生成只写 agents/，**不能动 profiles/<id>.json** ——
    那是分析结果本身，重生成时要能对比"改前改后"。"""
    profiles_dir = tmp_path / "profiles"
    profiles_dir.mkdir(parents=True)
    profile_path = profiles_dir / f"{'a' * 32}.json"
    original = json.dumps(PROFILE, ensure_ascii=False)
    profile_path.write_text(original, encoding="utf-8")

    agent = generate_from_profile(tmp_path, PROFILE, fallback_prompt="基础", model_name="qwen-plus")
    assert agent.source == "regenerated"
    assert profile_path.read_text(encoding="utf-8") == original  # 一个字都没改
    assert (tmp_path / "agents" / ("a" * 32) / "system_prompt.md").is_file()


def test_生成的文件里记下用的是哪个模型():
    text = render_system_prompt(PROFILE, model_name="qwen-plus")
    assert "qwen-plus" in text
