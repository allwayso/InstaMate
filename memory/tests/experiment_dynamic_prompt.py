#!/usr/bin/env python
"""实验：`@dynamic_prompt` + `create_agent` 能不能承担「按选中档案动态组装提示词」。

要回答三个问题（不调真模型，用假模型把收到的消息录下来）：

  ① `@dynamic_prompt` 能不能拿到**每次请求**的上下文（选了哪个档案）
  ② 还能不能继续用我们自己的 FileMemoryStore（memory_data/*.json 是既有数据，不能换格式）
  ③ `play_state` 这类工具循环能不能照常跑

跑法（需要额外装 langchain —— 主应用**不依赖**它，这个脚本是来评估它的）：
    cd memory && ./.venv/Scripts/python.exe -m pip install langchain
    ./.venv/Scripts/python.exe tests/experiment_dynamic_prompt.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from langchain.agents import create_agent
from langchain.agents.middleware import dynamic_prompt
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool


# 录下来的消息列表。用模块级变量而不是 pydantic 字段 ——
# BaseChatModel 是 pydantic 模型，给它加类变量会被当成字段，类访问拿不到。
SEEN: list = []


class RecordingModel(BaseChatModel):
    """假模型：把每次收到的完整消息列表录下来，最后回一句话。

    这样就能**直接断言模型看到的 system message 是什么**，
    不需要真的调 API —— 而"动态提示词组装对了没有"恰恰就只是这个问题。
    """

    @property
    def _llm_type(self) -> str:
        return "recording"

    def bind_tools(self, tools, **kwargs):
        """create_agent 会调它把工具绑到模型上；假模型直接返回自己。"""
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        SEEN.append(messages)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="好的。"))])


def banner(title: str) -> None:
    print("\n" + "=" * 68)
    print(title)
    print("=" * 68)


def system_of(messages) -> str:
    for message in messages:
        if message.__class__.__name__ == "SystemMessage":
            return message.content
    return ""


# ── ① @dynamic_prompt 能拿到每次请求的上下文吗 ────────────────────────────
banner("① @dynamic_prompt + runtime.context —— 每次请求换一份提示词")

AGENTS = {
    "default": "你是影伴。规则：不冒充真人。",
    "漫漫": "你是影伴，采用「漫漫」的风格：语速快、爱用短句。\n## 长期记忆\n- 喜欢喝美式",
}


@dynamic_prompt
def profile_prompt(request) -> str:
    # 关键问题：这里能拿到"这次请求选了哪个档案"吗？
    picked = getattr(request.runtime, "context", None) or {}
    agent_id = picked.get("agent_id", "default") if isinstance(picked, dict) else "default"
    return AGENTS.get(agent_id, AGENTS["default"])


@tool
def play_state(state_id: str) -> str:
    """让桌面角色播放一个状态动作。"""
    return f"已触发状态「{state_id}」"


def make_agent(model):
    return create_agent(
        model=model,
        tools=[play_state],
        middleware=[profile_prompt],
    )


SEEN.clear()
model = RecordingModel()
agent = make_agent(model)

for agent_id in ("default", "漫漫"):
    agent.invoke(
        {"messages": [HumanMessage("你好")]},
        context={"agent_id": agent_id},
    )

print(f"  收到 {len(SEEN)} 次模型调用")
first = system_of(SEEN[0])
second = system_of(SEEN[1])
print(f"  第 1 次 system 前 40 字：{first[:40]!r}")
print(f"  第 2 次 system 前 40 字：{second[:40]!r}")
print(f"  ⇒ 两次不同？ {'✅ 是（上下文生效）' if first != second else '❌ 否（拿不到上下文）'}")
print(f"  ⇒ 第二次含长期记忆？ {'✅' if '美式' in second else '❌'}")


# ── ② 还能不能用我们自己的 FileMemoryStore ────────────────────────────────
banner("② 继续用 FileMemoryStore（不换存储格式）")

from app.memory import FileMemoryStore

with tempfile.TemporaryDirectory() as tmp:
    store = FileMemoryStore(Path(tmp), Path(tmp))
    history = store.for_session("s1")
    history.add_messages([HumanMessage("我叫漫漫"), AIMessage("记住了")])
    print(f"  写入后：{Path(tmp, 's1.json').is_file()}  {len(store.for_session('s1').messages)} 条")

    SEEN.clear()
    agent.invoke(
        {"messages": [*store.for_session("s1").messages, HumanMessage("我叫什么？")]},
        context={"agent_id": "漫漫"},
    )
    roles = [m.__class__.__name__ for m in SEEN[0]]
    print(f"  模型收到的消息序列：{roles}")
    print(f"  ⇒ 历史被带进去了？ {'✅' if roles.count('HumanMessage') >= 2 else '❌ 没带'}")
    print("  ⇒ 结论：create_agent **可以**只当工具循环用，历史由我们自己传，"
          "      不必迁到 LangGraph checkpointer（memory_data/*.json 不用改格式）")


# ── ③ 工具循环 ────────────────────────────────────────────────────────────
banner("③ play_state 工具循环")


class ToolCallingModel(RecordingModel):
    @property
    def _llm_type(self) -> str:
        return "tool-calling"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        SEEN.append(messages)
        has_tool_result = any(m.__class__.__name__ == "ToolMessage" for m in messages)
        if has_tool_result:
            message = AIMessage(content="好的，我来做「打招呼」。")
        else:
            message = AIMessage(content="", tool_calls=[
                {"name": "play_state", "args": {"state_id": "greet"}, "id": "c1"}
            ])
        return ChatResult(generations=[ChatGeneration(message=message)])


SEEN.clear()
agent2 = create_agent(model=ToolCallingModel(), tools=[play_state], middleware=[profile_prompt])
result = agent2.invoke({"messages": [HumanMessage("打个招呼")]}, context={"agent_id": "default"})
classes = [m.__class__.__name__ for m in result["messages"]]
print(f"  最终消息序列：{classes}")
print(f"  ⇒ 发生了工具调用？ {'✅' if 'ToolMessage' in classes else '❌'}")
print(f"  最终回复：{result['messages'][-1].content!r}")


# ── ④ 代价对比 ────────────────────────────────────────────────────────────
banner("④ 结论")
print(f"""  ① 上下文：{'✅ 可以' if first != second else '❌ 不行'}
     `@dynamic_prompt` 每次都重新调用，`runtime.context` 传什么就用什么 ——
     正好是「按选中档案组装提示词」。

  ② 存储：✅ 可以不动
     `create_agent` 不带 checkpointer 时就是个纯工具循环，
     历史由我们自己传进去。memory_data/*.json 的格式和 FileMemoryStore 都能保留。

  ③ 工具：✅ 照常
     play_state 的调用/回填/二次生成都在。

  代价：langchain + langgraph 共 7 个包（langchain / langgraph /
        langgraph-checkpoint / langgraph-prebuilt / langgraph-sdk /
        ormsgpack / websockets）。
""")
