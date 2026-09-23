import json
import re
import zipfile
from functools import lru_cache

from fastapi import BackgroundTasks, FastAPI, HTTPException, Path, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from app.agent_files import ensure_default
from app.config import settings
from app.memory import FileMemoryStore
from app import profiles


class ChatRequest(BaseModel):
    session_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    message: str = Field(min_length=1, max_length=20000)
    states: list["PlayableState"] = Field(default_factory=list, max_length=100)
    profile_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


class AnalyzeRequest(BaseModel):
    archive_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    target_speaker: str = Field(min_length=1, max_length=100)


class PlayableState(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    trigger_words: list[str] = Field(default_factory=list, max_length=20)
    emotion: str = "neutral"
    duration: float | None = None
    loop: bool = False
    clip_id: str | None = None


class Trigger(BaseModel):
    id: str
    name: str
    emotion: str
    duration: float | None
    loop: bool
    clip_id: str | None


class ChatResponse(BaseModel):
    session_id: str
    answer: str
    triggers: list[Trigger] | None = None
    local_only: bool | None = None


class HistoryMessage(BaseModel):
    role: str
    content: str


class ChatHistoryResponse(BaseModel):
    session_id: str
    messages: list[HistoryMessage]


memory_store = FileMemoryStore(settings.memory_read_dir, settings.memory_write_dir)


# 默认档案必须存在 —— 不选档案时走的就是它。启动时播种，之后它只是普通文件，
# 用户可以直接编辑 agents/default/system_prompt.md 换掉影伴的基础人设。
ensure_default(settings.profile_data_dir, settings.system_prompt)


class ModelNotConfigured(RuntimeError):
    pass


@lru_cache(maxsize=1)
def get_chat_model() -> ChatOpenAI:
    if not settings.openai_api_key.strip():
        raise ModelNotConfigured("大模型密钥未配置。请在 memory/.env 设置 OPENAI_API_KEY 后重启 Python 服务。")
    return ChatOpenAI(
        model=settings.model_name,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        # ★ temperature 必须显式设低。
        #   原来没设，用厂商默认（较高）—— 后果不是“回答更有趣”，而是
        #   **不可靠地遵守工具调用**：在同一段会话历史里，模型会去模仿历史中的
        #   写法（把动作写成文字“（挥手）”）而不是调用 play_state。
        #   实测：同样条件、同一段被污染的会话，temperature=0 能稳定调工具，
        #   不设则不调。
        #   这里要的是可复现的动作触发，不是创意；人设的“活”靠档案提示词，
        #   不靠采样温度。
        temperature=0,
    )


def build_chat_runnable(system_message: str) -> RunnableWithMessageHistory:
    """每次按实际生效的 system message 现搭一条链。

    原来这里是 `@lru_cache(maxsize=1)` 且把 `settings.system_prompt` 写死在提示词里，
    于是**换不了人设** —— 缓存一旦生成就永远是那个 system。现在系统提示词来自
    实际选中的档案文件，所以必须每请求现搭。

    贵的只有 `get_chat_model()`（那层仍然缓存），ChatPromptTemplate 的构造是纯内存操作。
    每次都读一遍 md 文件也是故意的：**用户改完文件下一句话就生效**，不用重启服务。
    """
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", system_message),
            MessagesPlaceholder(variable_name="history"),
            ("human", "{message}"),
        ]
    )
    return RunnableWithMessageHistory(
        prompt | get_chat_model(),
        memory_store.for_session,
        input_messages_key="message",
        history_messages_key="history",
    )


def matching_state(message: str, states: list[PlayableState]) -> PlayableState | None:
    """Explicit trigger words take precedence over model tool selection."""
    text = message.casefold()
    matches: list[tuple[int, PlayableState]] = []
    for state in states:
        for word in state.trigger_words:
            term = word.strip().casefold()
            if not term:
                continue
            if term.isascii() and term.isalnum():
                found = re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", text)
            else:
                found = term in text
            if found:
                matches.append((len(term), state))
    return max(matches, key=lambda item: item[0])[1] if matches else None


def chat_with_states(request: ChatRequest) -> ChatResponse:
    """Use the same persisted conversation and let the model choose one real state."""
    agent = profiles.load_agent(request.profile_id)
    states = {state.id: state for state in request.states}
    tool = {
        "type": "function",
        "function": {
            "name": "play_state",
            "description": (
                "让桌面上的 3D 角色播放一个动作。用户问候、道别、应声，"
                "或聊到情绪、提出想看某个动作时选一个最贴切的；"
                "纯信息问答时不要调用。每轮最多一个。"
            ),
            "parameters": {
                "type": "object",
                "properties": {"state_id": {"type": "string", "enum": list(states)}},
                "required": ["state_id"],
            },
        },
    }
    # 描述里带上情绪和触发词：模型是在这些字面上做选择的，
    # 只给 name 的话它无法区分「双手轮流摇摆」和「左右摇摆」什么时候用。
    state_descriptions = "；".join(
        f"{state.name}({state.id}；情绪：{state.emotion}"
        f"；触发词：{'、'.join(state.trigger_words) or '无'})"
        for state in request.states
    )
    # ★ 触发词不再“抢在模型前面直接播”，而是降级为一条**提示**，
    #   并且命中时把工具设为**必调**。
    #
    #   实测数据（temperature=0，同一句「你好呀」）：
    #     auto 模式：qwen-plus 在被括号动作污染过的会话里**不调工具**，
    #                而是把「（右手挥手）」写进回复文字 —— 文字不会触发任何东西；
    #                换成 qwen3.5-plus 能调但 41 秒。
    #     required：qwen-plus 0.7 秒，而且**仍然自己选是哪一个**动作。
    #
    #   所以这里的分工是：
    #     命中触发词  → required：保证动作真的发生（但“选哪个”还是模型定）
    #     没命中      → auto：完全由模型决定要不要做、做哪个
    #   换句话说，触发词只决定“此刻要不要动作”，**不决定“做哪个”**。
    #   想让模型完全自由（即使聊到问候也不一定动），把 /states 里的触发词清掉即可。
    matched = matching_state(request.message, request.states)
    hint = (
        f"\n（这条消息命中了「{matched.name}」的触发词，请从可用状态里挑一个最贴切的。）"
        if matched else ""
    )
    action_instruction = (
        "你的桌面角色会做动作。遇到问候、道别、应声，或用户聊到情绪、"
        "提出想看某个动作时，调用 play_state 选一个最贴切的动作；"
        "纯信息问答、用户正专注做事时就不要调，不要每句都做动作。"
        # ★ 这条是实测加的，不是防患于未然：
        #   模型会把动作**写进回复文字**（“（右手挥手）”“刚挥完手”），
        #   而文字不会触发任何东西。更麻烦的是它自强化 —— 历史里有一句
        #   “（右手挥手）”，之后就一路照着模仿下去，永远不再调工具。
        #   所以把“文字描写动作是无效的”说破，而不是指望模型自己不说。
        "动作只能通过 play_state 触发。不要在回复里描写动作、也不要用括号补动作"
        "（例如“（挥手）”）—— 那样不会发生任何事。要么调工具，要么就不做动作。"
        + hint
    )
    # ★ 系统提示词来自**实际选中的档案文件**（选不选都是同一条路径）。
    #   原来这里是 `settings.system_prompt + profiles.prompt_context(profile_id)`，
    #   也就是每轮读原始档案 JSON 再现场截断 —— 见 plans/profile-to-agent.md。
    system = SystemMessage(content=(
        f"{agent.system_message()}\n\n"
        f"可用状态：{state_descriptions}。{action_instruction}"
        "每轮最多调用一个状态。回复会被朗读，请用简短口语回答，不写表情符号或舞台动作。"
    ))
    history = memory_store.for_session(request.session_id)
    human = HumanMessage(content=request.message)
    messages = [system, *history.messages, human]
    # triggers 现在**只来自模型的选择**（原来是 matched 命中就预填）。
    triggers: list[Trigger] = []
    try:
        model = get_chat_model()
    except ModelNotConfigured:
        # ★ 没有模型时的兜底：这时没人能做选择，
        #   与其“什么都不发生”，不如让确定性触发词生效，至少本地演示能动起来。
        if not matched:
            raise
        answer = "你好！很高兴见到你。" if matched.clip_id == "wave-right-hand" else f"好的，我来做「{matched.name}」。"
        history.add_messages([human, AIMessage(content=answer)])
        triggers.append(Trigger(**matched.model_dump(exclude={"trigger_words"})))
        return ChatResponse(session_id=request.session_id, answer=answer, triggers=triggers, local_only=True)
    # 有动作可选就把工具绑上去，让模型自己决定要不要调、调哪个。
    # 命中触发词时用 required：模型仍然选哪个，但不能选“什么都不做”——
    # 因为“配了触发词却什么都没发生”对用户来说就是坏了。
    if not states:
        first = model.invoke(messages)
    else:
        choice = "required" if matched else "auto"
        try:
            first = model.bind_tools([tool], tool_choice=choice).invoke(messages)
        except Exception as error:  # noqa: BLE001
            # ★ 思考型模型（qwen3.5-plus / qwen3.8-max 这类）会直接报
            #   “tool_choice does not support being set to required in thinking mode”。
            #   这时不能整个请求失败 —— 退回 auto，宁可这一次可能不触发，
            #   也不要让用户看到“对话报错”。只对 tool_choice 相关的报错这幺做，
            #   其它异常（网络、密钥、限流）原样抛出，否则会把真问题掩盖成“没动作”。
            if "tool_choice" not in str(error):
                raise
            first = model.bind_tools([tool], tool_choice="auto").invoke(messages)
    if isinstance(first, AIMessage) and first.tool_calls:
        messages.append(first)
        for call in first.tool_calls:
            selected = states.get(call.get("args", {}).get("state_id", "")) if call.get("name") == "play_state" else None
            if selected and not triggers:
                triggers.append(Trigger(**selected.model_dump(exclude={"trigger_words"})))
            messages.append(ToolMessage(
                content=f"已触发状态「{selected.name}」" if selected else "状态不存在，未触发",
                tool_call_id=call["id"],
            ))
        reply = model.invoke(messages)
    else:
        reply = first
    answer = message_content_to_text(reply.content)
    history.add_messages([human, AIMessage(content=answer)])
    return ChatResponse(session_id=request.session_id, answer=answer, triggers=triggers)


def message_content_to_text(content: object) -> str:
    return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)


app = FastAPI(title="LangChain Memory Chat API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials="*" not in settings.allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse, response_model_exclude_unset=True)
async def chat(request: ChatRequest) -> ChatResponse:
    if request.profile_id and profiles.get_profile(request.profile_id) is None:
        raise HTTPException(status_code=404, detail="人物档案不存在")
    try:
        if request.states or request.profile_id:
            return await run_in_threadpool(chat_with_states, request)
        # 没状态也没档案：走默认档案的提示词。原来这条分支用的是一个
        # `@lru_cache` 里写死的 settings.system_prompt，换不了人设；
        # 现在它和带档案的路径只差“读了哪个文件”。
        result = await run_in_threadpool(
            build_chat_runnable(profiles.load_agent(None).system_message()).invoke,
            {"message": request.message},
            {"configurable": {"session_id": request.session_id}},
        )
        return ChatResponse(
            session_id=request.session_id,
            answer=message_content_to_text(result.content),
        )
    except ModelNotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/chat/{session_id}", response_model=ChatHistoryResponse)
def chat_history(
    session_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,128}$"),
) -> ChatHistoryResponse:
    messages = []
    for message in memory_store.for_session(session_id).messages:
        if isinstance(message, HumanMessage):
            messages.append(HistoryMessage(role="user", content=message_content_to_text(message.content)))
        elif isinstance(message, AIMessage):
            messages.append(HistoryMessage(role="assistant", content=message_content_to_text(message.content)))
    return ChatHistoryResponse(session_id=session_id, messages=messages)


@app.post("/api/profiles/import")
async def import_profile(request: Request) -> dict:
    data = await request.body()
    try:
        return await run_in_threadpool(profiles.import_zip, data)
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/profiles/analyze", status_code=202)
def analyze_profile(request: AnalyzeRequest, background: BackgroundTasks) -> dict:
    try:
        job = profiles.start_analysis(request.archive_id, request.target_speaker)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    background.add_task(profiles.run_analysis, job["job_id"])
    return job


@app.get("/api/profiles/jobs/{job_id}")
def profile_job(job_id: str) -> dict:
    job = profiles.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="分析任务不存在")
    return job


@app.get("/api/profiles")
def profile_list() -> dict:
    return {"profiles": profiles.list_profiles()}


@app.get("/api/profiles/{profile_id}")
def profile_detail(profile_id: str) -> dict:
    profile = profiles.get_profile(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="人物档案不存在")
    return profile


# ── 智能体（系统提示词 + memory 文件）────────────────────────────────────
#
# 这几个端点的用途是**让用户看见智能体到底拿到了什么**。
# “不用让智能体读整个档案”这个改动如果没有可查看的地方，
# 用户就只能靠猜 —— 那是比改动前更糟的状态。


@app.get("/api/agents")
def agent_list() -> dict:
    return {
        "default": profiles.describe_agent(None),
        "profiles": [
            item for item in (profiles.describe_agent(p["profile_id"]) for p in profiles.list_profiles())
            if item is not None
        ],
    }


@app.get("/api/agents/{agent_id}")
def agent_detail(agent_id: str) -> dict:
    try:
        # 'default' 也走这里 —— 它是合法取值，不是特殊分支
        described = profiles.describe_agent(
            None if agent_id == profiles.DEFAULT_AGENT_ID else agent_id
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if described is None:
        raise HTTPException(status_code=404, detail="该档案还没有生成智能体文件")
    return described


@app.post("/api/agents/{agent_id}/regenerate")
def agent_regenerate(agent_id: str) -> dict:
    """重新渲染生成文件。分析结果（profiles/<id>.json）原封不动。"""
    if agent_id == profiles.DEFAULT_AGENT_ID:
        raise HTTPException(status_code=400, detail="默认档案可以直接编辑文件，不需要重新生成")
    try:
        return profiles.describe_agent(agent_id, regenerate=True)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
