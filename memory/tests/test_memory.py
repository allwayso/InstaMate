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
    monkeypatch.setattr(chat_api, "get_chat_runnable", lambda: runnable)
    client = TestClient(chat_api.app)

    posted = client.post("/api/chat", json={"session_id": "person-1", "message": "你好"})
    history = client.get("/api/chat/person-1")

    assert posted.status_code == 200
    assert posted.json() == {"session_id": "person-1", "answer": "收到"}
    assert history.json()["messages"] == [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "收到"},
    ]


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


def test_explicit_greeting_always_triggers_wave_without_model_tool_choice(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(chat_api, "memory_store", FileMemoryStore(tmp_path, tmp_path))

    class FakeModel:
        def bind_tools(self, *_args, **_kwargs):
            raise AssertionError("explicit state must not depend on model tool selection")

        def invoke(self, messages):
            assert "已按触发词播放「右手挥手」" in messages[0].content
            return AIMessage(content="你好，很高兴见到你。")

    monkeypatch.setattr(chat_api, "get_chat_model", lambda: FakeModel())
    response = TestClient(chat_api.app).post("/api/chat", json={
        "session_id": "greeting-1", "message": "你好",
        "states": [{
            "id": "clip-wave-right-hand", "name": "右手挥手",
            "trigger_words": ["你好", "hi", "挥手"], "clip_id": "wave-right-hand",
        }],
    })
    assert response.status_code == 200
    assert response.json()["triggers"][0]["clip_id"] == "wave-right-hand"
    assert response.json()["answer"] == "你好，很高兴见到你。"


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
