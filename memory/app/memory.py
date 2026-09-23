import json
import threading
from pathlib import Path

from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import BaseMessage, messages_from_dict, messages_to_dict


class FileChatMessageHistory(BaseChatMessageHistory):
    def __init__(self, read_path: Path, write_path: Path) -> None:
        self.read_path = read_path
        self.write_path = write_path
        self._lock = threading.RLock()
        self._messages = self._load()

    @property
    def messages(self) -> list[BaseMessage]:
        with self._lock:
            return list(self._messages)

    def add_messages(self, messages: list[BaseMessage]) -> None:
        with self._lock:
            self._messages.extend(messages)
            self._save()

    def clear(self) -> None:
        with self._lock:
            self._messages = []
            self._save()

    def _load(self) -> list[BaseMessage]:
        source = self.write_path if self.write_path.exists() else self.read_path
        if not source.exists():
            return []
        with source.open("r", encoding="utf-8") as file:
            data = json.load(file)
        return messages_from_dict(data)

    def _save(self) -> None:
        self.write_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.write_path.with_suffix(".tmp")
        with temporary_path.open("w", encoding="utf-8") as file:
            json.dump(messages_to_dict(self._messages), file, ensure_ascii=False, indent=2)
        temporary_path.replace(self.write_path)


class FileMemoryStore:
    def __init__(self, read_dir: Path, write_dir: Path) -> None:
        self.read_dir = read_dir
        self.write_dir = write_dir
        self._histories: dict[str, FileChatMessageHistory] = {}
        self._lock = threading.Lock()

    def for_session(self, session_id: str) -> FileChatMessageHistory:
        with self._lock:
            if session_id not in self._histories:
                filename = f"{session_id}.json"
                self._histories[session_id] = FileChatMessageHistory(
                    self.read_dir / filename,
                    self.write_dir / filename,
                )
            return self._histories[session_id]
