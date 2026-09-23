import argparse
from pathlib import Path

from chat_analysis.analyzer import ChatProfileAnalyzer
from chat_analysis.archive import load_archive, load_parsed_messages
from chat_analysis.config import settings
from chat_analysis.output import safe_directory_name, write_analysis, write_messages


def find_archive(path_value: str | None) -> Path:
    if path_value:
        return Path(path_value)
    archives = sorted(settings.input_dir.glob("*.zip"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not archives:
        raise FileNotFoundError(f"{settings.input_dir} 中没有 ZIP 归档")
    return archives[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="从微信聊天 ZIP 中抽取长期记忆与沟通人格提示词")
    parser.add_argument("archive", nargs="?", help="微信聊天 ZIP 或 parsed_messages.json；省略时读取配置目录中最新 ZIP")
    parser.add_argument("--target", action="append", help="目标说话者，可重复指定；省略时分析全部参与者")
    parser.add_argument("--parse-only", action="store_true", help="只解析聊天，不调用模型")
    args = parser.parse_args()

    archive_path = find_archive(args.archive)
    messages = load_parsed_messages(archive_path) if archive_path.suffix.lower() == ".json" else load_archive(archive_path)
    archive_output = settings.output_dir / safe_directory_name(archive_path.stem)
    parsed_path = write_messages(messages, archive_output)
    participants = sorted({message.speaker for message in messages})
    print(f"已解析 {len(messages)} 条消息：{parsed_path}")
    print(f"参与者：{', '.join(participants)}")

    if args.parse_only:
        return

    analyzer = ChatProfileAnalyzer(settings)
    for target in args.target or participants:
        target_dir = write_analysis(analyzer.analyze(messages, target), archive_output)
        print(f"已生成 {target} 的分析：{target_dir}")


if __name__ == "__main__":
    main()
