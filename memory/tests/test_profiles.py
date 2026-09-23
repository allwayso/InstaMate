from dataclasses import replace
from io import BytesIO
from pathlib import Path
import zipfile

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

import app.main as api
from app import profiles
from app.memory import FileMemoryStore
from chat_analysis.schemas import FinalAnalysis, MemoryCandidate, Evidence


CHAT_TEXT = """·漫漫
2026年9月10日 09:43
我喜欢画画

·oxygen
2026年9月10日 17:13
我知道啦
"""


def make_zip() -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("聊天记录.txt", CHAT_TEXT)
    return buffer.getvalue()


def test_zip_profile_analysis_and_live_chat_context(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(profiles, "ROOT", tmp_path / "profiles")
    monkeypatch.setattr(api, "memory_store", FileMemoryStore(tmp_path / "memory", tmp_path / "memory"))
    monkeypatch.setattr(
        profiles, "analysis_settings",
        replace(profiles.analysis_settings, api_key="mock", base_url="http://localhost"),
    )

    class FakeAnalyzer:
        def __init__(self, settings):
            assert settings.api_key == "mock"

        def analyze(self, messages, target_speaker):
            assert len(messages) == 2
            return FinalAnalysis(
                target_speaker=target_speaker,
                profile_summary="喜欢简洁温和地聊天",
                long_term_memories=[MemoryCandidate(
                    category="preference", fact="喜欢画画", confidence=0.9,
                    evidence=[Evidence(timestamp="2026-09-10T09:43", quote="我喜欢画画")],
                )],
                personality_traits=[],
                persona_prompt="用简洁温和的语气回答。",
                limitations=[],
            )

    class FakeModel:
        def invoke(self, messages):
            assert any("喜欢画画" in str(message.content) for message in messages)
            return AIMessage(content="画画真有趣。")

    monkeypatch.setattr(profiles, "ChatProfileAnalyzer", FakeAnalyzer)
    monkeypatch.setattr(api, "get_chat_model", lambda: FakeModel())
    client = TestClient(api.app)

    imported = client.post("/api/profiles/import", content=make_zip(), headers={"content-type": "application/zip"})
    assert imported.status_code == 200
    assert imported.json()["speakers"] == ["oxygen", "漫漫"]
    archive_id = imported.json()["archive_id"]
    started = client.post("/api/profiles/analyze", json={
        "archive_id": archive_id, "target_speaker": "漫漫",
    })
    assert started.status_code == 202
    job = client.get("/api/profiles/jobs/" + started.json()["job_id"])
    assert job.json()["status"] == "complete"
    profile_id = job.json()["profile_id"]
    profile = client.get("/api/profiles/" + profile_id)
    assert profile.json()["long_term_memories"][0]["fact"] == "喜欢画画"
    assert client.get("/api/profiles").json()["profiles"][0]["profile_id"] == profile_id

    reply = client.post("/api/chat", json={
        "session_id": "person-1", "message": "你喜欢什么？", "profile_id": profile_id,
    })
    assert reply.status_code == 200
    assert reply.json()["answer"] == "画画真有趣。"
    assert [item["content"] for item in client.get("/api/chat/person-1").json()["messages"]] == [
        "你喜欢什么？", "画画真有趣。",
    ]


def test_invalid_zip_is_rejected(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(profiles, "ROOT", tmp_path)
    response = TestClient(api.app).post("/api/profiles/import", content=b"not a zip")
    assert response.status_code == 400
