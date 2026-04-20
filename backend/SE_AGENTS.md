# SE-Agent framework — API reference

End-to-end API documentation for the SE-agent suite implemented over the
Liu et al. 2024 survey and the GEAR (Shen et al. ACL 2025) paper.

All endpoints are mounted at `/api/se-agents` and require the standard
bearer-token auth (same as the rest of siraGPT) unless noted.

---

## Quickstart

```bash
# 1. Ingest code into a collection.
curl -X POST http://localhost:5000/api/rag/ingest-code \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection":"my-repo","files":[{"filename":"math.ts","content":"export function add(a,b){return a+b;}"}]}'

# 2. (Optional, for multi-hop) Extract triples for GEAR retrieval.
curl -X POST http://localhost:5000/api/rag/ingest-triples \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection":"my-repo"}'

# 3. Ask a specialist agent.
curl -X POST http://localhost:5000/api/se-agents/review \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection":"my-repo","files":["math.ts"]}'
```

Or use the single-entry chat dispatcher:

```bash
curl -X POST http://localhost:5000/api/se-agents/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"review my add function","collection":"my-repo","context":{"files":["math.ts"]}}'
```

---

## Architecture

```
                ┌───────────────────────────┐
                │  User chat message        │
                └─────────────┬─────────────┘
                              │
                ┌─────────────▼─────────────┐
                │  orchestrator.routeIntent │ ← LLM intent classifier
                └─────────────┬─────────────┘
                              │
         ┌────────┬───────────┼───────────┬──────────┬────────┐
         │        │           │           │          │        │
         ▼        ▼           ▼           ▼          ▼        ▼
   requirements  debug   maintenance  test_gen   code_gen   general
   code_review   static_check    log_analysis                 │
                                                              │
                                                              ▼
                                                     (existing RAG chat)

Each specialist runs on top of:
  ┌─────────────────────────────────────────────┐
  │ agent-core (ReAct loop + tool registry)     │
  │  - Planning / Memory / Perception / Action  │
  │  - Retry w/ backoff, onStep streaming       │
  │  - Trace compaction, tool-result cache      │
  └────────────────────┬────────────────────────┘
                       │
             ┌─────────▼──────────┐
             │   SE tool registry  │
             │  - read_file        │
             │  - list_files       │
             │  - search_docs      │ ← hybrid cosine+BM25 RRF
             │  - search_code      │ ← BM25 identifier-aware
             │  - search_graph     │ ← GEAR SyncGE
             │  - get_symbol       │
             │  - static_checks    │
             │  - propose_patch    │
             └─────────┬──────────┘
                       │
           ┌───────────▼───────────┐
           │    RAG layer          │
           │  rag-service          │ ← cosine/hybrid/graph retrieve
           │  code-chunker         │ ← AST-lite per language
           │  triple-graph + DBS   │ ← GEAR multi-hop
           │  gist-memory          │ ← session-scoped triples
           └───────────┬───────────┘
                       │
               ┌───────▼─────────┐
               │   rag-store      │ ← in-memory OR pgvector (flag)
               └──────────────────┘
```

---

## Specialist endpoints

Every specialist endpoint below accepts `collection` (string, optional,
default `'code'`) and `maxIters` (integer, optional, default varies by
agent, range 1-25). All return `{ ok: true, ...result, stats }` where
`stats` carries `approxPromptTokens`, `approxCompletionTokens`,
`toolCalls`, `toolCacheHits`, `durationMs`.

### POST `/api/se-agents/review` — code review (§4.3)

Body:
- `files`: `string[]` (optional) — source ids to review
- `focus`: `string` (optional, ≤500) — hint like "focus on auth"

Result:
- `summary`: 1-3 sentence verdict
- `findings`: `[{ file, start_line, end_line, severity, category, issue, suggestion, confidence }]`
- `counts`: `{ critical, high, medium, low, info }`

### POST `/api/se-agents/test-gen` — test generation (§4.4)

Body:
- `source`: `string` (required) — source id
- `symbol`: `string` (optional) — function/class name
- `language`: `string` (optional)

Result:
- `test_file`: full source of the test file
- `test_cases`: `[{ name, scenario }]` where scenario ∈ `happy_path|edge_case|error_path|regression`
- `uncovered`: scenarios the agent could NOT test (with reasons)
- `framework`: detected test framework

### POST `/api/se-agents/debug` — debugging (§4.5)

Body:
- `error`: `string` (required) — error message or stacktrace
- `context`: `string` (optional) — "fails only when list is empty"
- `suspicion`: `string[]` (optional) — filenames the user suspects

Result:
- `hypothesis`, `root_cause_file`, `root_cause_lines`
- `patches`: `[{ source, start_line, end_line, replacement, rationale, confidence }]`
- `tests_to_add`: regression test descriptions
- `stacktrace_hints`: parsed file:line pairs the agent seeded with

### POST `/api/se-agents/maintenance` — issue resolution (§4.8)

Body:
- `ticket`: `string` (required) — user-written bug report or feature gap
- `title`: `string` (optional)
- `reporter`: `string` (optional) — "customer", "qa", etc.
- `initialSuspicion`: `string[]` (optional)

Result:
- `status`: `resolved | likely_fix | not_localised | out_of_scope`
- `localisation`: `{ confidence, primary_file, primary_symbol, related_files[], rationale }`
- `hypothesis`, `patches[]`, `tests_to_add[]`, `open_questions[]`
- `ticket_hints`: `{ filePaths, symbols, urls, quotedStrings }` extracted from the ticket

### POST `/api/se-agents/code-gen` — code generation (§4.2)

Body:
- `spec`: `string` (required)
- `strategy`: `'single_path' | 'multi_path'` (default `single_path`)
- `numPaths`: integer (default 3) — when multi_path
- `language`: string

Result:
- `code`, `language`, `file_path`, `rationale`, `assumptions[]`
- `chosen_among`: per-candidate summary (multi_path only)

### POST `/api/se-agents/requirements` — requirements engineering (§4.1)

Body:
- `request`: `string` (required)
- `relatedFiles`: `string[]`, `domainContext`: `string`

Result:
- `title`, `summary`, `estimated_complexity`
- `user_stories`: As/I want/so that
- `acceptance_criteria`: Given/When/Then
- `non_goals`, `open_questions`, `assumptions` (with evidence)
- `suggested_files_touched[]`

### POST `/api/se-agents/static-check` — static analysis (§4.3)

Body:
- `files`: `string[]` (required, ≥1)

Result:
- `summary`, `findings` (confirmed-only after LLM audit)
- `raw`: raw deterministic-linter hits per file

### POST `/api/se-agents/log-analysis` — IT ops (§4.6)

Body:
- `logs`: `string | string[]` (required)
- `topK`: integer (default 8)
- `correlateWithCode`: boolean (default true)

Result:
- `top_clusters`: `[{ signature, count, likely_root_cause, correlated_source, severity, confidence, suggested_action }]`
- `total_lines`

---

## Orchestrator endpoints

### POST `/api/se-agents/chat` — single-entry dispatcher

Body: `{ message, collection?, context? }` where `context` carries
per-agent extras (files, spec, ticket, error, suspicion, logs).

Response:
```json
{ "ok": true, "intent": "code_review", "confidence": 0.9,
  "agent": "code_review", "result": {...}, "fallback_to_rag_chat": false }
```

When `intent === "general"`, `fallback_to_rag_chat: true` signals the
frontend to delegate to the existing RAG chat.

### POST `/api/se-agents/orchestrate` — explicit modes

Body: `{ mode, ... }` where mode ∈ `route | pipeline | collaborate | consensus`.

- **`route`** → just the intent classifier.
- **`pipeline`**: `{ recipe, input }`. Recipes: `review_and_test`,
  `generate_review_test`, `end_to_end_dev` (§4.7).
- **`collaborate`**: `{ spec, maxRounds, language }` — author↔reviewer loop.
- **`consensus`**: `{ spec, numAgents, language }` — N parallel code-gens, vote by review score.

---

## Observability & ops endpoints

### GET `/api/se-agents/metrics`

Prometheus text format. No auth (scrape endpoint). Metrics:
- `se_agent_invocations_total{agent, terminatedBy}`
- `se_agent_errors_total{agent}`
- `se_agent_tokens_total{agent}`
- `se_agent_tool_calls_total{agent, tool}`
- `se_agent_tool_cache_hits_total{agent}`
- `se_agent_rate_limited_total{reason}`
- `se_agent_injection_signals_total{agent, rule}`
- `se_agent_duration_ms` histogram
- `se_agent_rag_chunks{collection}` gauge

### GET `/api/se-agents/usage`

Caller's current budget consumption — hour + day windows, with caps.

### GET `/api/se-agents/health`

Liveness (200) or readiness failure (503 if OPENAI_API_KEY missing).

---

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. |
| `RAG_RERANK_MODEL` | `gpt-4o-mini` | LLM reranker model. |
| `BUDGET_DAILY_TOKENS_DEFAULT` | `2000000` | Hard daily cap per user. |
| `BUDGET_HOURLY_TOKENS_DEFAULT` | `500000` | Hard hourly cap per user. |
| `BUDGET_RPM_DEFAULT` | `60` | Requests per minute per user. |
| `USE_PG_STORE` | `0` | Switch to pgvector-backed RAG store (requires migration). |
| `AUDIT_LOG_PATH` | — | If set, append audit records to this path instead of stderr. |
| `OPENAI_LIVE_TESTS` | `0` | When `1`, enables `tests/e2e-live.test.js`. |

---

## Security

- **Auth**: every endpoint except `/metrics` and `/health` uses the project's
  `authenticateToken` middleware.
- **Rate-limiting**: per-user token budget (hour+day) and requests-per-minute
  cap; returns `429` with `Retry-After`.
- **Prompt-injection guard**: pre-scans user-provided text for well-known
  injection patterns; emits metrics+audit. Does NOT block by default —
  the real defense is input sandboxing inside specialist agents.
- **Audit log**: every invocation records `{ user, agent, tokens, terminated_by,
  injection_hits, error }` with secret-regex redaction.
- **Tool sandbox**: all tools are READ-ONLY. `propose_patch` returns a
  diff proposal; the user applies it. No shell, no writes, no outbound HTTP.

---

## Persistence

**Default**: in-memory Maps keyed by `(userId, collection)`. Data dies
on process restart.

**Production**: set `USE_PG_STORE=1` and run migration
`20260420000000_rag_store`. Adds `rag_chunks` + `rag_triples` tables
with pgvector cosine indices. See `backend/src/services/rag-store.js`.

**Migration status**: the adapter is in place (`rag-store.js`) and the
SQL migration is ready to apply. The core `rag-service.js` still uses
its internal Map for most paths as a transitional measure — the
cutover is a separate focused change to keep the 300+ test baseline
green while we verify the pg paths in production.

---

## Roadmap

- [ ] Cut over `rag-service` internal Map to `rag-store` adapter (behind
      `USE_PG_STORE`) so restart survives.
- [ ] Frontend: wire the chat input to `/api/se-agents/chat` with a
      "Agent: <intent>" banner when the router picks a specialist.
- [ ] Per-tier budget caps (FREE / PRO / ENTERPRISE from existing user
      schema) instead of single default.
- [ ] Streaming responses via SSE so long agent runs show progress.
- [ ] Redis-backed budget ledger for multi-instance deploys.

---

## Tests

```bash
npm test                      # unit (all stubs, fast)
OPENAI_LIVE_TESTS=1 npm test  # also runs tests/e2e-live.test.js (real API)
```

Current: **302+** unit tests across 19 test files covering RAG
primitives, GEAR (chunking, triples, DBS, gist), all specialist
agents, the orchestrator, security (injection guard, budget,
mutex), and the bug-fix regression suite.
