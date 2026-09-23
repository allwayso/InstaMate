# InstaMate 对话记忆与聊天分析

这个目录整合自独立的记忆模块。主页的聊天面板通过 Next.js 的
`/api/chat` 服务端路由连接这里的 Python API；浏览器不会读取模型密钥。
这条前端路由默认仅供本机访问。
离线分析仍由命令行运行，分析结果不会自动注入在线对话。

本项目包含两个相互解耦的模块：

1. **在线对话 API**：接收前端消息，调用 LangChain 模型，并按会话持久化聊天记忆。
2. **离线聊天分析**：解析微信聊天 ZIP/TXT，抽取长期记忆、分析沟通风格并生成人格提示词。

两个模块使用不同的配置文件和输出目录，离线分析结果不会自动注入在线对话。

## 环境要求

- Python 3.10+
- OpenAI 或兼容 OpenAI API 的模型服务

安装依赖：

```bash
python -m pip install -r requirements.txt
```

## 一、在线对话 API

### 配置

在本目录复制 `.env.example` 为 `.env`，填入自己的密钥。压缩包自带的
`.env`、`.env.analysis` 和分析结果没有导入仓库。

```env
OPENAI_API_KEY=你的密钥
OPENAI_BASE_URL=
MODEL_NAME=gpt-4o-mini
SYSTEM_PROMPT=你是一个有帮助的助手，请结合历史对话回答用户。
MEMORY_READ_DIR=./memory_data
MEMORY_WRITE_DIR=./memory_data
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

- `MEMORY_READ_DIR`：首次加载历史记忆的目录。
- `MEMORY_WRITE_DIR`：新对话记忆的保存目录。
- `ALLOWED_ORIGINS`：允许访问 API 的前端地址，多个地址使用英文逗号分隔。

### 启动

```bash
cd memory
./.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

默认地址：`http://127.0.0.1:8000`

接口文档：`http://127.0.0.1:8000/docs`

### 对话接口

`POST /api/chat`

请求示例：

```json
{
  "session_id": "user_001",
  "message": "你好，请记住我喜欢简洁的回答。"
}
```

响应示例：

```json
{
  "session_id": "user_001",
  "answer": "好的，我会尽量简洁回答。"
}
```

同一 `session_id` 的历史消息保存在：

```text
memory_data/user_001.json
```

健康检查：

```text
GET /health
```

`GET /api/chat/{session_id}` 返回此会话保存的用户和助手消息，供主页刷新后恢复对话。
前端使用浏览器本地存储保存随机会话 ID；点击「新对话」会换一个 ID，旧记录仍留在
`memory_data/` 中。

前端在另一个终端运行 `cd web && npm run dev`。如果 Python 服务不在默认地址，
可在 `web/.env.local` 中设置 `MEMORY_API_URL=http://127.0.0.1:8000`。

## 二、离线聊天分析

离线分析代码位于 `chat_analysis/`，不会依赖或修改 `app/` 中的在线对话逻辑。

### 支持的聊天格式

ZIP 中需包含一个或多个 TXT 文件，每条消息格式如下：

```text
·发送者
2026年9月10日 09:43
消息正文
```

支持 UTF-8、GB18030 和 UTF-16 文本编码。压缩包内的图片、视频等附件不会被读取或发送给模型。

### 配置

在本目录复制 `.env.analysis.example` 为 `.env.analysis`，填入分析服务配置：

```env
ANALYSIS_OPENAI_API_KEY=你的密钥
ANALYSIS_OPENAI_BASE_URL=
ANALYSIS_MODEL_NAME=gpt-4o-mini
CHAT_ARCHIVE_INPUT_DIR=./chat_archives
CHAT_ANALYSIS_OUTPUT_DIR=./analysis_output
CHAT_ANALYSIS_CHUNK_CHARACTERS=12000
```

- `CHAT_ARCHIVE_INPUT_DIR`：未在命令中指定 ZIP 时，从该目录选择最新归档。
- `CHAT_ANALYSIS_OUTPUT_DIR`：解析及分析结果的独立输出目录。
- `CHAT_ANALYSIS_CHUNK_CHARACTERS`：每次发送给模型的聊天文本字符数上限。

### 仅解析聊天

该操作不会调用模型：

```bash
python -m chat_analysis.cli "聊天记录.zip" --parse-only
```

输出文件：

```text
analysis_output/<归档名>/parsed_messages.json
```

已解析的 JSON 也可以作为分析输入，无需重新提供原始 ZIP。解析结果放在
`analysis_output/` 下时会被 Git 忽略；本次导入的解析结果仅保存在当前工作区。

### 分析全部参与者

```bash
python -m chat_analysis.cli "聊天记录.zip"
```

### 分析指定参与者

```bash
python -m chat_analysis.cli "聊天记录.zip" --target "漫漫"
```

也可从已有解析结果继续：

```bash
./.venv/bin/python -m chat_analysis.cli analysis_output/imported/parsed_messages.json --target "目标说话者"
```

可重复使用 `--target`：

```bash
python -m chat_analysis.cli "聊天记录.zip" --target "漫漫" --target "oxygen"
```

如果省略 ZIP 路径，程序会分析 `CHAT_ARCHIVE_INPUT_DIR` 中最后修改的 ZIP：

```bash
python -m chat_analysis.cli
```

### 分析输出

每位参与者会使用独立目录：

```text
analysis_output/<归档名>/<参与者>/
├── long_term_memory.json
├── personality_profile.json
└── persona_prompt.txt
```

- `long_term_memory.json`：带置信度和原文证据的长期记忆。
- `personality_profile.json`：沟通倾向、证据、置信度和交流建议。
- `persona_prompt.txt`：可供后续系统提示词组合使用的人格风格提示词。

分析器会要求模型忽略聊天内容中的指令，避免保存密码、令牌、精确住址等敏感数据，并避免无证据的敏感属性推断或心理诊断。

## 项目结构

```text
app/                    在线对话 API
chat_analysis/          离线聊天分析
memory_data/            在线会话记忆
analysis_output/        离线分析结果
tests/                  自动化测试
.env                    在线对话配置
.env.analysis           离线分析配置
requirements.txt        Python 依赖
```

## 测试

```bash
python -m pytest -q
```

当前测试覆盖文件记忆持久化、微信 TXT 解析、ZIP 读取和安全输出目录名称处理。

## 数据安全

- `.env`、`.env.analysis`、在线记忆和离线分析结果均已加入 `.gitignore`。
- 聊天记录可能包含私人信息，请仅在已授权的模型服务中处理。
- `persona_prompt.txt` 用于模拟沟通风格，不应用于冒充真实人物。
