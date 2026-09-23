# 人物档案 → 智能体（系统提示词 + memory 文件）

## 要解决的问题

现在的实现是**每一轮对话都去读原始档案并现场截断**：

```python
# memory/app/profiles.py  （改动前）
def prompt_context(profile_id: str) -> str:
    profile = get_profile(profile_id)          # ← 每轮读 JSON
    memories = [m["fact"][:300] for m in profile["long_term_memories"][:15]]
    return (f"...{profile['profile_summary'][:1000]}"
            f"...{profile['persona_prompt'][:2500]}"
            f"..." + "；".join(memories))[:5000]   # ← 每轮截断
```

问题有三层：

1. **智能体读的是"分析中间产物"，不是"给智能体的东西"**
   `profile_summary` / `persona_prompt` / `personality_traits` / `evidence` 是给人看的分析结果，
   直接塞给模型既浪费上下文，也把"证据引用"这种分析细节混进了对话。
2. **截断规则藏在代码里** —— 想调「哪些记忆进提示词」，得改 Python。
3. **没有默认档案的概念** —— 不选档案时只有一个 `.env` 里的 `SYSTEM_PROMPT`，
   和"选了档案"是两套完全不同的路径。

## 目标

分析完成时**一次性产出两个文件**，之后对话只读这两个文件：

```
profile_data/agents/<profile_id>/system_prompt.md    ← 系统提示词
profile_data/agents/<profile_id>/memory.md           ← memory 文件
profile_data/agents/<profile_id>/meta.json           ← 生成时间 / 来源 / 模型
profile_data/agents/default/system_prompt.md         ← 默认（不选档案时用）
profile_data/agents/default/memory.md
profile_data/profiles/<profile_id>.json              ← 原始分析结果，保留供追溯与重新生成
```

要点：

- **两个文件都是可读可编辑的 Markdown**，不是代码里的模板。想改人设直接改文件。
- **system_prompt.md 是自洽的完整提示词**（含共同规则块），不依赖 `.env` ——
  这样"选了档案"和"没选档案"是同一条代码路径，只是文件不同。
- **memory.md 只放事实，不放 evidence 原文** —— 证据是分析产物的质量保证，不是对话素材。
- **默认档案是一等公民**：启动时若缺失，用 `.env` 的 `SYSTEM_PROMPT` 播种一份，
  之后它就是一个普通文件，用户可以直接编辑。

## 为什么用目录而不是 `<id>.json` 里加字段

- 文件可以被用户直接打开、编辑、甚至版本管理，JSON 里塞长文本做不到这一点。
- 重新生成时只覆盖这两个文件，**分析结果本身不动**（可对比"重新生成前后差了什么"）。
- `default` 不是 32 位 hex，天然不会和真实 profile_id 撞名。

## 加载路径

```
请求带 profile_id  → agents/<id>/     （缺失时用 profiles/<id>.json 现场生成一次，兼容旧档案）
请求不带 profile_id → agents/default/  （启动时保证存在）
```

## 验证

- 纯函数渲染（`render_system_prompt` / `render_memory`）在 Node/Python 里直接测，不需要模型。
- 端到端：选档案 / 不选档案 两种情况的 system message 内容断言。
