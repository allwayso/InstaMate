import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env.analysis")


def _path_from_env(name: str, default: str) -> Path:
    value = Path(os.getenv(name, default))
    return value if value.is_absolute() else BASE_DIR / value


@dataclass(frozen=True)
class AnalysisSettings:
    api_key: str = os.getenv("ANALYSIS_OPENAI_API_KEY", "")
    base_url: str | None = os.getenv("ANALYSIS_OPENAI_BASE_URL") or None
    model_name: str = os.getenv("ANALYSIS_MODEL_NAME", "gpt-4o-mini")
    input_dir: Path = _path_from_env("CHAT_ARCHIVE_INPUT_DIR", "./chat_archives")
    output_dir: Path = _path_from_env("CHAT_ANALYSIS_OUTPUT_DIR", "./analysis_output")
    chunk_characters: int = int(os.getenv("CHAT_ANALYSIS_CHUNK_CHARACTERS", "12000"))


settings = AnalysisSettings()
