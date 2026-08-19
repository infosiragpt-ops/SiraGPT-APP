---
name: runtime-debugging
description: "Debug SiraGPT production and local runtime issues across routing, providers, streaming, tools, database, and deployment boundaries."
---

# Runtime Debugging

Use this skill when behavior differs between local, CI, and production, or when chat/provider/tool execution fails without an obvious code error.

## Contract

- Prove the failing boundary before changing code.
- Never print secrets, raw cookies, session tokens, OAuth URLs with codes, or full user prompts from logs.
- Prefer focused probes over broad rewrites.
- Keep UI unchanged unless the bug is a visible UI regression.
- After a fix, rerun the exact failing probe, then one broader smoke test.

## Boundary Map

1. **Request entry:** route, auth, CSRF, rate limit, body validation.
2. **Intent/routing:** chat type, model/provider selection, fallback policy.
3. **Provider transport:** API key presence, base URL, model id, timeout, streaming format.
4. **Persistence:** Prisma query, migration state, cache invalidation, Redis availability.
5. **Streaming:** SSE headers, first token timing, abort handling, final persistence.
6. **Frontend state:** optimistic message, refresh race, model list cache, selected chat type.
7. **Deploy:** commit live in `/api/version`, PM2/docker restart, health endpoint, migrations.

## Standard Loop

```bash
curl -sS https://api.siragpt.com/api/version
curl -sS -o /dev/null -w '%{http_code}\n' https://api.siragpt.com/health/ready
npm run type-check
npm run build
```

For backend route work, add a focused node test near the route/service. For frontend state work, prefer a unit test for the state helper or a narrow Playwright smoke when interaction is essential.

## Debug Notes

- If a model appears in admin but not user chat, check `/api/ai/models`, cache namespace `ai-models`, and active/type filters.
- If chat returns fallback text, inspect intent routing before provider code.
- If production differs from local, compare deployed commit, env key names, migrations, and response cache.
- If a provider fails only in streaming, log event type/timing summaries only; do not log raw prompt bodies.

