---
name: Model picker empty-catalog fallback
description: Why the /code (and chat) model picker can be empty, and the policy.fallbackModel contract that unblocks it.
---

`/api/ai/models?type=TEXT` can legitimately return `{ models: [] }` for ANY plan
(confirmed on FREE and ENTERPRISE). The TEXT catalog is empty when there are no
`isActive:true` AIModel rows of that type AND no provider keys
(`DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`) are set to inject virtual rows. This
is by design, not a bug — do not "fix" it by seeding rows.

When the catalog is empty the response still includes `policy.fallbackModel`
(e.g. `{name:"Gema4-31B", provider:"OpenAI", displayName:"Gema4"}`) — the model
the backend actually routes to. Any model picker MUST consume
`policy.fallbackModel` when `models` is empty, or it gets stuck on an empty /
"Cargando modelos…" state and downstream send guards (empty `activeModelName`)
block Ask/Agent.

**Why:** the shared chat context (`lib/chat-context-integrated.tsx`) stores only
`modelsResponse.models` and discards `policy`, so any consumer relying on
`availableModels` alone breaks on an empty catalog.

**How to apply:** in a consumer that can't change the context, fetch
`apiClient.getAIModels(type)` locally and read `policy.fallbackModel`; fold it
into the active-model resolution and synthesize a single-item picker list. When a
real catalog later loads, prefer it and drop any persisted choice that isn't in
the catalog.
