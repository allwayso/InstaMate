import json
from datetime import datetime
from pathlib import Path
import zipfile

from chat_analysis.archive import load_archive, load_parsed_messages, parse_chat_text
from chat_analysis.output import safe_directory_name


CHAT_TEXT = """·漫漫
2026年9月10日 09:43
我还找了个队友

·oxygen
2026年9月10日 17:13
你别冤枉我哦
"""


def test_parse_chat_text() -> None:
    messages = parse_chat_text(CHAT_TEXT, "聊天记录.txt")

    assert len(messages) == 2
    assert messages[0].speaker == "漫漫"
    assert messages[0].timestamp == datetime(2026, 9, 10, 9, 43)
    assert messages[0].content == "我还找了个队友"


def test_load_archive_reads_txt_only(tmp_path: Path) -> None:
    archive_path = tmp_path / "聊天.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("聊天记录.txt", CHAT_TEXT.encode("utf-8"))
        archive.writestr("图片.jpg", b"not-an-image")

    messages = load_archive(archive_path)

    assert [message.speaker for message in messages] == ["漫漫", "oxygen"]


def test_safe_directory_name() -> None:
    assert safe_directory_name("../漫漫/a") == "漫漫_a"


def test_load_parsed_messages_json(tmp_path: Path) -> None:
    path = tmp_path / "parsed_messages.json"
    messages = parse_chat_text(CHAT_TEXT, "聊天记录.txt")
    path.write_text(json.dumps([message.to_dict() for message in messages]), encoding="utf-8")

    restored = load_parsed_messages(path)

    assert [message.speaker for message in restored] == ["漫漫", "oxygen"]
    assert restored[0].content == "我还找了个队友"
