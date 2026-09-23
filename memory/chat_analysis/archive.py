import json
from io import BytesIO
import re
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path


HEADER_PATTERN = re.compile(
    r"(?m)^·(?P<speaker>[^\r\n]+)\r?\n"
    r"(?P<timestamp>\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2})\r?\n"
)


@dataclass(frozen=True)
class ChatMessage:
    speaker: str
    timestamp: datetime
    content: str
    source: str

    def to_dict(self) -> dict[str, str]:
        result = asdict(self)
        result["timestamp"] = self.timestamp.isoformat(timespec="minutes")
        return result


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别聊天文本编码，仅支持 UTF-8、GB18030 和 UTF-16")


def parse_chat_text(text: str, source: str) -> list[ChatMessage]:
    matches = list(HEADER_PATTERN.finditer(text))
    if not matches:
        raise ValueError(f"{source} 中未找到微信聊天消息")

    messages: list[ChatMessage] = []
    for index, match in enumerate(matches):
        content_end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        content = text[match.end():content_end].strip()
        messages.append(
            ChatMessage(
                speaker=match.group("speaker").strip(),
                timestamp=datetime.strptime(match.group("timestamp"), "%Y年%m月%d日 %H:%M"),
                content=content,
                source=source,
            )
        )
    return messages


def load_archive(archive_path: Path) -> list[ChatMessage]:
    if not archive_path.is_file():
        raise FileNotFoundError(f"聊天归档不存在：{archive_path}")

    messages: list[ChatMessage] = []
    with zipfile.ZipFile(archive_path, metadata_encoding="gbk") as archive:
        text_entries = [entry for entry in archive.infolist() if entry.filename.lower().endswith(".txt")]
        if not text_entries:
            raise ValueError("压缩包中没有 TXT 聊天记录")
        for index, entry in enumerate(text_entries, start=1):
            source = entry.filename if "�" not in entry.filename else f"chat_{index}.txt"
            messages.extend(parse_chat_text(decode_text(archive.read(entry)), source))

    return sorted(messages, key=lambda message: message.timestamp)


def load_archive_bytes(data: bytes, *, max_uncompressed: int = 20_000_000) -> list[ChatMessage]:
    """Parse uploaded ZIP in memory without extracting paths or persisting the raw archive."""
    messages: list[ChatMessage] = []
    with zipfile.ZipFile(BytesIO(data), metadata_encoding="gbk") as archive:
        entries = [
            entry for entry in archive.infolist()
            if not entry.is_dir() and entry.filename.lower().endswith(".txt")
        ]
        if not entries:
            raise ValueError("压缩包中没有 TXT 聊天记录")
        if len(entries) > 100 or sum(entry.file_size for entry in entries) > max_uncompressed:
            raise ValueError("TXT 文件过多或解压后超过 20 MB")
        for index, entry in enumerate(entries, start=1):
            source = entry.filename if "�" not in entry.filename else f"chat_{index}.txt"
            messages.extend(parse_chat_text(decode_text(archive.read(entry)), source))
    return sorted(messages, key=lambda message: message.timestamp)


def load_parsed_messages(path: Path) -> list[ChatMessage]:
    """从先前 parse-only 的 JSON 结果继续分析，无需保留原始聊天 ZIP。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("parsed_messages.json 必须是消息数组")
    messages: list[ChatMessage] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not all(
            isinstance(item.get(key), str) for key in ("speaker", "timestamp", "content", "source")
        ):
            raise ValueError(f"第 {index + 1} 条解析消息缺少必需字段")
        messages.append(
            ChatMessage(
                speaker=item["speaker"],
                timestamp=datetime.fromisoformat(item["timestamp"]),
                content=item["content"],
                source=item["source"],
            )
        )
    return sorted(messages, key=lambda message: message.timestamp)
