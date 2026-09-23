from pathlib import Path

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnableLambda
from langchain_core.runnables.history import RunnableWithMessageHistory

import app.main as chat_api
from app.memory import FileChatMessageHistory, FileMemoryStore


def test_history_persists_and_loads(tmp_path: Path) -> None:
    path = tmp_path / "session.json"
    history = FileChatMessageHistory(path, path)
    history.add_messages([HumanMessage(content="你好"), AIMessage(content="你好！")])

    loaded = FileChatMessageHistory(path, path)

    assert [message.content for message in loaded.messages] == ["你好", "你好！"]


def test_history_reads_source_and_writes_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.json"
    destination = tmp_path / "output" / "session.json"
    original = FileChatMessageHistory(source, source)
    original.add_messages([HumanMessage(content="旧消息")])

    history = FileChatMessageHistory(source, destination)
    history.add_messages([AIMessage(content="新消息")])

    loaded = FileChatMessageHistory(destination, destination)
    assert [message.content for message in loaded.messages] == ["旧消息", "新消息"]


def test_langchain_runnable_persists_messages_without_model_network(tmp_path: Path) -> None:
    store = FileMemoryStore(tmp_path, tmp_path)
    prompt = ChatPromptTemplate.from_messages(
        [("system", "测试"), MessagesPlaceholder(variable_name="history"), ("human", "{message}")]
    )
    fake_model = RunnableLambda(lambda _: AIMessage(content="收到"))
    runnable = RunnableWithMessageHistory(
        prompt | fake_model,
        store.for_session,
        input_messages_key="message",
        history_messages_key="history",
    )

    runnable.invoke({"message": "你好"}, {"configurable": {"session_id": "person-1"}})

    reloaded = FileChatMessageHistory(tmp_path / "person-1.json", tmp_path / "person-1.json")
    assert [message.content for message in reloaded.messages] == ["你好", "收到"]


def test_history_endpoint_returns_saved_conversation(tmp_path: Path, monkeypatch) -> None:
    store = FileMemoryStore(tmp_path, tmp_path)
    store.for_session("person-1").add_messages(
        [HumanMessage(content="你好"), AIMessage(content="你好！")]
    )
    monkeypatch.setattr(chat_api, "memory_store", store)

    response = TestClient(chat_api.app).get("/api/chat/person-1")

    assert response.status_code == 200
    assert response.json() == {
        "session_id": "person-1",
        "messages": [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好！"},
        ],
    }


def test_chat_api_saves_and_recovers_session_without_model_network(tmp_path: Path, monkeypatch) -> None:
    store = FileMemoryStore(tmp_path, tmp_path)
    prompt = ChatPromptTemplate.from_messages(
        [("system", "测试"), MessagesPlaceholder(variable_name="history"), ("human", "{message}")]
    )
    fake_model = RunnableLambda(lambda _: AIMessage(content="收到"))
    runnable = RunnableWithMessageHistory(
        prompt | fake_model,
        store.for_session,
        input_messages_key="message",
        history_messages_key="history",
    )
    monkeypatch.setattr(chat_api, "memory_store", store)
    # 这条分支现在按“实际选中的档案”现搭提示词，不再是 @lru_cache 里写死的
    # settings.system_prompt —— 所以这里捕获传进来的 system_message，
    # 顺便断言它确实来自档案文件。
    captured: list[str] = []

    def fake_build(system_message: str):
        captured.append(system_message)
        return runnable

    monkeypatch.setattr(chat_api, "build_chat_runnable", fake_build)
    client = TestClient(chat_api.app)

    posted = client.post("/api/chat", json={"session_id": "person-1", "message": "你好"})
    history = client.get("/api/chat/person-1")

    assert posted.status_code == 200
    assert posted.json() == {"session_id": "person-1", "answer": "收到"}
    assert history.json()["messages"] == [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "收到"},
    ]
    # 没选档案 → 默认档案的系统提示词（含共同规则块）
    assert len(captured) == 1
    assert "你是「影伴」" in captured[0]
    assert "不是**那个人" in captured[0] or "你在**采用**" in captured[0]


def test_chat_with_states_triggers_clip_and_keeps_session_history(tmp_path: Path, monkeypatch) -> None:
    store = FileMemoryStore(tmp_path, tmp_path)
    monkeypatch.setattr(chat_api, "memory_store", store)

    class FakeModel:
        calls = 0

        def bind_tools(self, tools, tool_choice):
            assert tools[0]["function"]["name"] == "play_state"
            assert tool_choice == "auto"
            return self

        def invoke(self, messages):
            self.calls += 1
            if self.calls == 1:
                return AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "play_state",
                        "args": {"state_id": "clip-wave-right-hand"},
                        "id": "call-1",
                    }],
                )
            assert messages[-1].content == "已触发状态「右手挥手」"
            return AIMessage(content="你好，我来挥手。")

    model = FakeModel()
    monkeypatch.setattr(chat_api, "get_chat_model", lambda: model)
    client = TestClient(chat_api.app)
    response = client.post("/api/chat", json={
        "session_id": "person-1",
        "message": "请展示一个友好的欢迎动作",
        "states": [{
            "id": "clip-wave-right-hand",
            "name": "右手挥手",
            "trigger_words": ["你好", "挥手"],
            "clip_id": "wave-right-hand",
        }],
    })

    assert response.status_code == 200
    assert response.json() == {
        "session_id": "person-1",
        "answer": "你好，我来挥手。",
        "triggers": [{
            "id": "clip-wave-right-hand",
            "name": "右手挥手",
            "emotion": "neutral",
            "duration": None,
            "loop": False,
            "clip_id": "wave-right-hand",
        }],
    }
    assert [message.content for message in store.for_session("person-1").messages] == [
        "请展示一个友好的欢迎动作", "你好，我来挥手。",
    ]


def _tool_calling_model(state_id: str, seen: dict):
    """假模型：第一次返回 tool_call，第二次返回文本。把 tool_choice 记下来。"""

    class FakeModel:
        def bind_tools(self, tools, tool_choice="auto"):
            seen["tool_choice"] = tool_choice
            assert tools[0]["function"]["name"] == "play_state"
            return self

        def invoke(self, messages):
            seen.setdefault("system", messages[0].content)
            if any(m.__class__.__name__ == "ToolMessage" for m in messages):
                return AIMessage(content="好的，我来挥挥手。")
            return AIMessage(content="", tool_calls=[
                {"name": "play_state", "args": {"state_id": state_id}, "id": "call-1"}
            ])

    return FakeModel()


WAVE_STATE = {
    "id": "clip-wave-right-hand", "name": "右手挥手",
    "trigger_words": ["你好", "hi", "挥手"], "clip_id": "wave-right-hand",
}


def test_触发词命中时把工具设为必调_但选哪个仍由模型决定(tmp_path: Path, monkeypatch) -> None:
    """★ 这是本文件最关键的用例。

    原来的设计是“命中触发词就自己直接播，不给模型工具”。现在改成：
    **一定要让模型调工具**（否则“配了触发词却什么都没发生”就是坏了），
    但“调哪个状态”仍然由模型按语义选。

    为什么必须这样：实测 temperature=0、同一句「你好呀」、同一个被
    “（右手挥手）”污染过的会话 —— `auto` 模式下 qwen-plus 会把动作写进回复文字、
    根本不调工具（文字不会触发任何东西）；`required` 下 0.7 秒就调了，
    而且仍然自己选中了“右手挥手”。
    """
    monkeypatch.setattr(chat_api, "memory_store", FileMemoryStore(tmp_path, tmp_path))
    seen: dict = {}
    monkeypatch.setattr(chat_api, "get_chat_model", lambda: _tool_calling_model(
        "clip-wave-right-hand", seen))

    response = TestClient(chat_api.app).post("/api/chat", json={
        "session_id": "greeting-1", "message": "你好", "states": [WAVE_STATE],
    })

    assert response.status_code == 200
    # 工具被绑上了，而且是“必须调”
    assert seen["tool_choice"] == "required"
    # 提示还在（告诉模型该去哪几个里选），但不再替它决定
    assert "命中了「右手挥手」的触发词" in seen["system"]
    # 动作真的从模型的选择变成了 trigger
    assert response.json()["triggers"][0]["clip_id"] == "wave-right-hand"


def test_没有触发词时交给模型自己决定要不要动作(tmp_path: Path, monkeypatch) -> None:
    """纯信息问答不应该被强行塞一个动作。"""
    monkeypatch.setattr(chat_api, "memory_store", FileMemoryStore(tmp_path, tmp_path))
    seen: dict = {}

    class QuietModel:
        def bind_tools(self, tools, tool_choice="auto"):
            seen["tool_choice"] = tool_choice
            return self

        def invoke(self, messages):
            return AIMessage(content="17 乘 23 等于 391。")

    monkeypatch.setattr(chat_api, "get_chat_model", lambda: QuietModel())
    response = TestClient(chat_api.app).post("/api/chat", json={
        "session_id": "math-1", "message": "17 乘 23 等于多少", "states": [WAVE_STATE],
    })

    assert seen["tool_choice"] == "auto"
    assert response.json().get("triggers") in (None, [])


def test_思考型模型拒绝强制工具时退回_auto_而不是报错(tmp_path: Path, monkeypatch) -> None:
    """★ qwen3.5-plus / qwen3.8-max 这类思考型模型直接报

        tool_choice does not support being set to required in thinking mode

    如果这里不处理，用户换一个更强的模型就会看到“对话报错”，而不是“这次没做动作”。
    只对 tool_choice 相关的错这么退；其它异常（网络/密钥/限流）必须原样抛出，
    否则会把真问题掩盖成“没动作”。
    """
    import pytest

    monkeypatch.setattr(chat_api, "memory_store", FileMemoryStore(tmp_path, tmp_path))
    seen: dict = {}
    model = _tool_calling_model("clip-wave-right-hand", seen)
    real_bind = model.bind_tools

    def bind_or_reject(tools, tool_choice="auto"):
        if tool_choice == "required":
            raise RuntimeError(
                "Error code: 400 - The tool_choice parameter does not support "
                "being set to required or object in thinking mode"
            )
        return real_bind(tools, tool_choice)

    model.bind_tools = bind_or_reject
    monkeypatch.setattr(chat_api, "get_chat_model", lambda: model)

    response = TestClient(chat_api.app).post("/api/chat", json={
        "session_id": "thinking-1", "message": "你好", "states": [WAVE_STATE],
    })

    assert response.status_code == 200, response.text
    assert seen["tool_choice"] == "auto"  # 退回去了
    # 退回去之后这次仍然触发了（模型自己愿意调）
    assert response.json()["triggers"][0]["clip_id"] == "wave-right-hand"

    # 其它异常不能被吃掉
    def boom(tools, tool_choice="auto"):
        raise RuntimeError("Connection error")

    model.bind_tools = boom
    with pytest.raises(RuntimeError, match="Connection error"):
        TestClient(chat_api.app).post("/api/chat", json={
            "session_id": "thinking-2", "message": "你好", "states": [WAVE_STATE],
        })


def test_missing_model_keeps_greeting_action_and_reports_other_chat_error(tmp_path: Path, monkeypatch) -> None:
    store = FileMemoryStore(tmp_path, tmp_path)
    monkeypatch.setattr(chat_api, "memory_store", store)

    def unconfigured_model():
        raise chat_api.ModelNotConfigured("请配置模型密钥")

    monkeypatch.setattr(chat_api, "get_chat_model", unconfigured_model)
    client = TestClient(chat_api.app)
    states = [{
        "id": "clip-wave-right-hand", "name": "右手挥手",
        "trigger_words": ["你好"], "clip_id": "wave-right-hand",
    }]
    greeting = client.post("/api/chat", json={
        "session_id": "offline-1", "message": "你好", "states": states,
    })
    assert greeting.status_code == 200
    assert greeting.json()["local_only"] is True
    assert greeting.json()["triggers"][0]["clip_id"] == "wave-right-hand"
    assert len(client.get("/api/chat/offline-1").json()["messages"]) == 2

    unknown = client.post("/api/chat", json={
        "session_id": "offline-1", "message": "今天怎么样", "states": states,
    })
    assert unknown.status_code == 503
    assert unknown.json()["detail"] == "请配置模型密钥"
    assert len(client.get("/api/chat/offline-1").json()["messages"]) == 2
