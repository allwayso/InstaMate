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
    )


@lru_cache(maxsize=1)
def get_chat_runnable() -> RunnableWithMessageHistory:
    model = get_chat_model()
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", settings.system_prompt),
            MessagesPlaceholder(variable_name="history"),
            ("human", "{message}"),
        ]
    )
    return RunnableWithMessageHistory(
        prompt | model,
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
    states = {state.id: state for state in request.states}
    tool = {
        "type": "function",
        "function": {
            "name": "play_state",
            "description": "让桌面上的 3D 角色播放一个状态动作。用户问候或明确要求动作时选择最合适的状态。",
            "parameters": {
                "type": "object",
                "properties": {"state_id": {"type": "string", "enum": list(states)}},
                "required": ["state_id"],
            },
        },
    }
    state_descriptions = "；".join(
        f"{state.name}({state.id}；触发词：{'、'.join(state.trigger_words) or '无'})"
        for state in request.states
    )
    profile_context = profiles.prompt_context(request.profile_id) if request.profile_id else ""
    matched = matching_state(request.message, request.states)
    action_instruction = (
        f"已按触发词播放「{matched.name}」，请直接回应，不要再调用动作。" if matched else
        "问候或明确的动作请求要调用 play_state；没有合适状态时正常聊天。"
    )
    system = SystemMessage(content=(
        f"{settings.system_prompt}\n你是住在桌面 3D 角色里的影伴。"
        f"{profile_context}\n"
        f"可用状态：{state_descriptions}。{action_instruction}"
        "每轮最多调用一个状态。回复会被朗读，请用简短口语回答，不写表情符号或舞台动作。"
    ))
    history = memory_store.for_session(request.session_id)
    human = HumanMessage(content=request.message)
    messages = [system, *history.messages, human]
    triggers: list[Trigger] = [Trigger(**matched.model_dump(exclude={"trigger_words"}))] if matched else []
    try:
        model = get_chat_model()
    except ModelNotConfigured:
        if not matched:
            raise
        answer = "你好！很高兴见到你。" if matched.clip_id == "wave-right-hand" else f"好的，我来做「{matched.name}」。"
        history.add_messages([human, AIMessage(content=answer)])
        return ChatResponse(session_id=request.session_id, answer=answer, triggers=triggers, local_only=True)
    first = (model if matched or not states else model.bind_tools([tool], tool_choice="auto")).invoke(messages)
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
        result = await run_in_threadpool(
            get_chat_runnable().invoke,
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
