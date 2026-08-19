---
name: Agent-task runtime model slug routing
description: How the agent task worker maps a selected model id to a provider; why slug-prefixed ids must go to OpenRouter.
---

# Agent-task runtime provider detection

`detectAgentRuntimeProvider()` (backend/src/services/agents/agent-task-runner.js) decides which OpenAI-compatible provider the agent runtime drives. If it returns `null`, `normalizeAgentRuntimeModel()` force-remaps the selection to the gpt-4o-mini fallback (`modelRemapped:true`) — a silent downgrade the user notices.

## Rule
Any `provider/model` slug (contains a `/`) routes through **OpenRouter**, exactly like the main chat flow's `inferProviderFromModelId()` in `provider-inference.js`. Only bare ids (no `/`) map to native providers: `gpt-*`/`o\d`/`chatgpt-*` → OpenAI, bare `gemini-*`/`imagen-*` → Gemini, bare `deepseek-(v\d|chat|reasoner)` → direct DeepSeek.

**Why:** the app's display models are OpenRouter slugs (e.g. `openai/gpt-5.5`, `google/gemini-3.5-pro` — see token-budget.js, 400k ctx). A short slug allowlist (anthropic|meta-llama|moonshotai|x-ai|openrouter) missed `openai/`, `google/`, etc., so those returned null and got downgraded to gpt-4o-mini. `openai/gpt-5.5` is NOT native OpenAI — the `openai/` prefix means "OpenAI model served via OpenRouter".

**How to apply:** keep `detectAgentRuntimeProvider` (task runtime) and `inferProviderFromModelId` (chat) in lockstep — both treat slug = OpenRouter. Requires `OPENROUTER_API_KEY` set (it is, in prod), else `resolveAgentRuntimeClient` falls back to OpenAI+gpt-4o-mini again. Native branches must guard on `!id.includes('/')` or slugs leak into them.
