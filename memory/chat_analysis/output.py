import json
import re
from pathlib import Path

from chat_analysis.archive import ChatMessage
from chat_analysis.schemas import FinalAnalysis


SAFE_NAME_PATTERN = re.compile(r"[^\w.-]+", re.UNICODE)


def safe_directory_name(name: str) -> str:
    sanitized = SAFE_NAME_PATTERN.sub("_", name).strip("._")
    return sanitized[:80] or "unknown"


def write_messages(messages: list[ChatMessage], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "parsed_messages.json"
    path.write_text(
        json.dumps([message.to_dict() for message in messages], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def write_analysis(result: FinalAnalysis, output_root: Path) -> Path:
    target_dir = output_root / safe_directory_name(result.target_speaker)
    target_dir.mkdir(parents=True, exist_ok=True)

    (target_dir / "long_term_memory.json").write_text(
        json.dumps(
            [item.model_dump() for item in result.long_term_memories],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (target_dir / "personality_profile.json").write_text(
        json.dumps(
            {
                "target_speaker": result.target_speaker,
                "profile_summary": result.profile_summary,
                "personality_traits": [item.model_dump() for item in result.personality_traits],
                "limitations": result.limitations,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (target_dir / "persona_prompt.txt").write_text(result.persona_prompt.strip() + "\n", encoding="utf-8")
    return target_dir
