import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _path_from_env(name: str, default: str) -> Path:
    value = Path(os.getenv(name, default))
    return value if value.is_absolute() else BASE_DIR / value


@dataclass(frozen=True)
class Settings:
    model_name: str = os.getenv("MODEL_NAME", "gpt-4o-mini")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_base_url: str | None = os.getenv("OPENAI_BASE_URL") or None
    system_prompt: str = os.getenv(
        "SYSTEM_PROMPT", "你是一个有帮助的助手，请结合历史对话回答用户。"
    )
    memory_read_dir: Path = _path_from_env("MEMORY_READ_DIR", "./memory_data")
    memory_write_dir: Path = _path_from_env("MEMORY_WRITE_DIR", "./memory_data")
    profile_data_dir: Path = _path_from_env("PROFILE_DATA_DIR", "./profile_data")
    allowed_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv(
            "ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"
        ).split(",")
        if origin.strip()
    )


settings = Settings()
