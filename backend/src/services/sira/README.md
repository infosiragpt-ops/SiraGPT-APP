# `services/sira/` — Sira chat pipeline core

This directory is the **deterministic core** of siraGPT's chat pipeline:
intent classification → envelope construction → planner → tool execution
→ validation → response. None of these modules call an LLM directly
unless an `llmClient` is explicitly injected; everything is replayable
offline and testable without external services.

If you are looking for the architecture as a whole, read
[`docs/architecture/PIPELINE.md`](../../../../docs/architecture/PIPELINE.md)
first. That document is the source of truth for **how the pieces fit
together**. This README is the local index for **what each piece is**
and **where to look** when you need to change something.

---

## Module index

| File | One-line purpose | Tests |
|---|---|---|
| `chat-controller.js` | The 9-stage entry point: `handleChatTurn` per turn. | `backend/tests/sira-platform.test.js`, `backend/tests/sira-request-id.test.js`, `backend/tests/sira-http-integration.test.js` |
| `engine.js` | Pure orchestrator: builds envelope + the 5 deterministic frames. | `backend/tests/sira-task-envelope.test.js` (engine block) |
| `runtime.js` | DAG execution of `envelope.workflow_graph`; emits the runtime trace frame. | `backend/tests/sira-runtime.test.js` |
| `task-envelope-builder.js` | Builds the Sira Cognitive Task Envelope from raw input + history + RAG. | `backend/tests/sira-task-envelope.test.js`, `backend/tests/sira-request-id.test.js` |
| `task-envelope-schema.js` | JSON schema + `validateEnvelope`. | `backend/tests/sira-task-envelope.test.js` |
| `frames.js` | Builders for `intent_frame`, `plan_frame`, `tool_call_frame`, `artifact_frame`, `validation_frame`, `final_response_frame`. | `backend/tests/sira-task-envelope.test.js` (frames block) |
| `citation-frame.js` | First-class `citation_frame` wrapping `services/citation-engine.js`. Adds per-citation `marker_count`, `relevance_score`, and a `coverage` block (sources provided / cited / ratio). | `backend/tests/sira-citation-frame.test.js` |
| `execution-trace-frame.js` | Privacy-safe runtime timeline + counters. | `backend/tests/sira-execution-trace-frame.test.ts` (frontend) |
| `tool-registry.js` | Typed tool registry (60+ tools). `register`, `get`, `invoke`, `byCategory`, `integrity`. | `backend/tests/sira-stack-extras.test.js` |
| `tool-policy.js` | Trust boundary: permission + sandbox + risk + side-effect gating per tool. | `backend/tests/sira-stack-extras.test.js` |
| `tool-resilience.js` | Retry / timeout / backoff for tool invocations. | `backend/tests/sira-stack-extras.test.js` |
| `validator-engine.js` | Deterministic validators across artifact / source / code / document / safety families. | `backend/tests/sira-stack-extras.test.js`, `backend/tests/agentic-frameworks.test.js` |
| `hybrid-retrieval.js` | BM25 + dense + RRF + caller-injected reranker. | `backend/tests/sira-stack-extras.test.js` |
| `intent-taxonomy.js` | 14 task families × ~85 intents. | `backend/tests/sira-task-envelope.test.js` |
| `intent-prompts.js` | Prompts + few-shot examples for optional LLM-based intent enrichment. | covered indirectly by envelope tests |
| `policies.js` | Clarification + safety policy constants and evaluators. | `backend/tests/sira-platform.test.js` |
| `pipeline-errors.js` | Stage-aware error taxonomy (`SiraPipelineError` + per-stage subclasses). Express `siraErrorHandler`. | `backend/tests/sira-pipeline-errors.test.js`, `backend/tests/sira-http-integration.test.js` |
| `metrics.js` | Sira-specific Prometheus counters + histograms (turns, durations, errors, budget decisions). Sits on top of `services/agents/metrics.js`. | `backend/tests/sira-health-and-metrics.test.js` |
| `context-compactor.js` | Per-turn context shrinking: dedup → window-fit → summarize-on-overflow → RAG rank+cap → memory cap. Reuses `services/context-window.js`. | `backend/tests/sira-context-compactor.test.js` |
| `chat-modes.js` | 5-mode catalog (chat, research, document, code, presentation) with tool whitelist/blocklist, system prompt addendum, validator profile, intent-family scope. `resolveMode`, `applyModeToToolPlan`, `applyModePrompt`. | `backend/tests/sira-chat-modes.test.js` |
| `memory-store.js` | Unified `put/recall/forget/stats` over the four memory tiers (`short_term`, `conversation`, `semantic`, `project`, `user`). `createInMemoryStore` for tests; `createCompositeStore({...adapters})` for production routing to existing modules. | `backend/tests/sira-memory-store.test.js` |
| `project-workspace.js` | Per-turn loader for project-scoped context (docs, instructions, memory_scope, permissions, recent conversations). Three-role permission model (viewer/editor/owner) with `canAccess(member, capability)`. | `backend/tests/sira-project-workspace.test.js` |
| `turn-events.js` | Pluggable typed event sink emitted into at every chat-controller boundary. Three sinks: `createNoOpEvents()` (default), `createBufferedEvents()` (tests), `createSSEEvents(res)` (HTTP streaming). 13 canonical event names mirrored 1:1 with the audit log. | `backend/tests/sira-turn-events.test.js`, `backend/tests/sira-chat-controller-events.test.js`, `backend/tests/sira-sse-route.test.js` |
| `memory-store-adapters.js` | Concrete adapters that satisfy the `MemoryStore` interface by delegating to existing modules: short_term→gist-memory, semantic→long-term-memory, project→project-memory + Prisma. Plus simple in-process `conversation` and `user` adapters. | `backend/tests/sira-memory-store-adapters.test.js` |
| `production-wiring.js` | Convenience factory that composes the production MemoryStore + projectWorkspaceDeps for the route layer. Single place to swap when the schema evolves (e.g. multi-tenant ProjectMember). | `backend/tests/sira-production-wiring.test.js` |
| `token-ledger.js` | `buildTokenUsageFrame`, in-memory ledger. Deterministic chars/4 estimator + provider-reported merge. | `backend/tests/sira-token-ledger.test.ts` (frontend) |
| `token-budget-policy.js` | Plan caps (FREE/PRO/TEAM/ENTERPRISE) and `assessTokenBudget`. | `backend/tests/sira-token-budget-policy.test.ts` (frontend) |
| `model-adapter.js` | Model abstraction across OpenAI / Anthropic / Groq / Gemini / OpenRouter; auto-routing guard. | `backend/tests/sira-platform.test.js` |
| `llm-instrumentation.js` | Per-provider circuit breaker (closed/half_open/open) + cost ledger + Prometheus metrics for every LLM call. | `backend/tests/sira-llm-instrumentation.test.js` |
| `idempotency-guard.js` | Tool-call deduplication within a workflow. | `backend/tests/sira-runtime.test.js` |
| `session-actor-queue.js` | Per-conversation serialization (one in-flight turn per conversation). | `backend/tests/sira-session-actor-queue.test.ts` (frontend) |
| `storage-schema.js` | Postgres DDL + in-memory adapter for the 7 sira tables. | `backend/tests/sira-platform.test.js` |
| `response-builder.js` | `buildFinalResponse` used by the engine after all frames are assembled. | covered indirectly by engine tests |
| `llm-observability.js` | Sessions / traces / spans / generations vocabulary (Langfuse-compatible). | `backend/tests/sira-stack-extras.test.js` |
| `eval-harness.js` | Offline evaluation harness for envelope/runtime regressions. | invoked by ad-hoc CI extensions |
| `research-engine.js` | Long-running research-mode dispatch (citations, sources, evidence). | covered by integration tests where present |
| `artifact-engine.js` | Per-format artifact generation pipeline. | covered by document/spreadsheet/image suites |
| `document-pipeline-registry.js` | Registry of document-format handlers (DOCX, XLSX, PPTX, PDF). | covered by `tests/document-delivery-policy.test.js` |

For the **adjacent** dirs that the pipeline depends on but does not own,
see `services/agent-runtime/`, `services/ai-product-os/`,
`services/observability/`, `services/security/`, `services/rag/`,
`services/searchBrain/`. PIPELINE.md §4 lists their roles.

---

## Audit events emitted from this directory

Every event lands in `sira_audit_logs(request_id, user_id, event_type,
payload, created_at)`. Payloads are content-free — see PIPELINE.md §6 for
field shape.

| Event | Emitted by | When |
|---|---|---|
| `turn_started` | `chat-controller` | stage 1 |
| `project_context_loaded` | `chat-controller` | stage 1.5 (when projectId is set + access OK) |
| `project_access_denied` | `chat-controller` | stage 1.5 (forbidden) |
| `project_context_error` | `chat-controller` | stage 1.5 (non-forbidden loader error) |
| `memory_recalled` | `chat-controller` | stage 1.7 (when memoryStore is wired) |
| `context_compacted` | `chat-controller` | stage 1.8 (when prior history exists) |
| `token_budget_checked` | `chat-controller` | stage 2 |
| `turn_blocked_token_budget` | `chat-controller` | stage 2, blocked path |
| `envelope_invalid` | `chat-controller` | stage 3, schema rejection |
| `chat_mode_resolved` | `chat-controller` | stage 3.5 (after engine returns valid envelope) |
| `clarification_requested` | `chat-controller` | stage 5, ask path |
| `execution_trace_recorded` | `chat-controller` | stage 6, after runtime |
| `token_usage_recorded` | `chat-controller` | stage 8 |
| `token_usage_ledger_error` | `chat-controller` | stage 8, ledger write failure |
| `citation_frame_built` | `chat-controller` | stage 8.5 (when has_citations) |
| `turn_completed` | `chat-controller` | stage 9 |
| `memory_persisted` | `chat-controller` | stage 9.5 (when memoryStore is wired) |
| `node_started`, `node_completed`, `tool_policy_denied`, `tool_deduplicated`, `tool_invoked`, `tool_retry_scheduled` | `runtime` | recorded into the execution trace timeline (not the main audit log) |

When you add a new audit event:
1. Add the call site (use `store.audit(name, payload, { userId, requestId })`).
2. Add a row in PIPELINE.md §6.
3. Add a row in this README's table above.
4. Add an audit assertion in the relevant `tests/sira-*.test.js`.

---

## Prometheus metrics emitted from this directory

Registered in `metrics.js` against the shared registry from
`services/agents/metrics.js`. Single scrape at `GET /metrics`.

| Name | Type | Labels |
|---|---|---|
| `sira_chat_turns_total` | counter | `stage`, `status`, `plan` |
| `sira_chat_turn_duration_ms` | histogram | `stage` |
| `sira_pipeline_errors_total` | counter | `stage`, `code` |
| `sira_token_budget_decisions_total` | counter | `decision`, `plan`, `enforcement_mode` |
| `sira_clarifications_requested_total` | counter | — |
| `sira_envelope_invalid_total` | counter | — |
| `sira_llm_calls_total` | counter | `provider`, `model`, `status` |
| `sira_llm_call_duration_ms` | histogram | `provider`, `model` |
| `sira_llm_tokens_total` | counter | `provider`, `model`, `direction` |
| `sira_llm_cost_micro_usd_total` | counter | `provider`, `model` |
| `sira_llm_circuit_state` | gauge | `provider` |

### Streaming events (SSE)

Every event in the audit table above is also emitted to the
`turn-events` sink. When the route mounts `createSSEEvents(res)`
(triggered by `Accept: text/event-stream`), these become real-time
SSE frames the client can render as live progress beats. The
canonical event names live in `turn-events.EVENT_NAMES`. A
synthetic `_end` marker closes the stream after the terminal stage.

When you add a new metric:
1. Register it in `metrics.js` with a help string + labels.
2. Add a thin recorder helper.
3. Add the recorder call at the emit site.
4. Add an assertion in `tests/sira-health-and-metrics.test.js`.

---

## Error taxonomy

Every error thrown inside the pipeline should be a
`SiraPipelineError` (see `pipeline-errors.js`). Per-stage subclasses
exist for `ingress`, `token_budget`, `envelope`, `policy`, `context`,
`rag`, `tool`, `validator`, `stream`, `storage`. Plain Errors are
auto-wrapped at the Express boundary by `siraErrorHandler` so they
still reach the client as a 500 in the same JSON shape — but if you
own the throw site, throw the tagged subclass yourself so the audit
log gets the right `code` + `stage`.

---

## How to ...

### Add a new stage

1. Add a numbered section in PIPELINE.md §3 with the same field shape
   as the existing stages (purpose, file, contract, audit events,
   failure mode).
2. Add the stage name to `STAGES` in `pipeline-errors.js` if it can
   raise an error you want classified.
3. Add a stage-specific subclass in `pipeline-errors.js` if needed.
4. If the stage emits events, register them in `sira_audit_logs` and
   document them in PIPELINE.md §6 + this README.

### Add a new frame

1. Add a builder in `frames.js` (or a dedicated `<frame>-frame.js` file
   if it is large, like `execution-trace-frame.js`).
2. Wire it into `engine.js` (or `runtime.js` if it is runtime-derived).
3. Add a row in PIPELINE.md §5 with key fields.
4. Add a builder test in `backend/tests/sira-task-envelope.test.js`.

### Add a new tool

1. Construct the descriptor and register it via `tool-registry.register`.
2. Confirm coverage in every `tool-policy` profile (interactive,
   sandbox, locked_down).
3. Set `manifest.sandboxRequired` and `manifest.sideEffectLevel` honestly.
4. Add a test in `backend/tests/sira-stack-extras.test.js`.

### Add a new validator

1. Add the check inside the appropriate family in `validator-engine.js`.
2. Update PIPELINE.md §8 with the new check name.
3. Add a test in `backend/tests/sira-stack-extras.test.js`.

### Add a new storage table

1. Add the DDL + in-memory adapter shape in `storage-schema.js`.
2. Update PIPELINE.md §11.
3. Migrate existing callers if the table replaces something.

### Add a new audit event or metric

See the dedicated tables above.

---

## Invariants — never break these

1. **Deterministic core.** No module here may call an LLM directly
   unless an `llmClient` is explicitly injected. The engine, runtime,
   validators, response-builder must remain replayable offline.
2. **No model auto-routing.** The model is selected by the caller and
   guarded against silent substitution at chat-controller stage 7.
3. **No raw payloads in the audit log.** Use `redactDetails` /
   `toAuditPayload` from `pipeline-errors.js` before writing structured
   error info to `sira_audit_logs`. The execution trace + token frames
   are already content-free by construction.
4. **One request id per turn.** Every entry in `sira_audit_logs` for a
   single turn must share `request_id`. The HTTP layer threads it via
   `requestIdMiddleware`; the controller pins it onto every audit
   meta and the envelope.
5. **Append-only audit.** Never delete or update an audit row.
   Migrations of audit semantics happen by adding new event types.
6. **Privacy-first observability.** Token accounting uses the
   `chars/4.v1` estimator unless the provider reports usage. No
   message text touches the ledger.

---

## Testing the way the pipeline composes

Three layers of coverage:

1. **Unit tests** under `backend/tests/sira-*.test.js` cover each
   module in isolation. `node --test`, no external services.
2. **HTTP integration tests** at `backend/tests/sira-http-integration.test.js`
   spin up an in-process Express app and fire real HTTP requests
   against the same middleware order as production. Catches
   middleware ordering, error-handler activation, header propagation.
3. **Backend smoke test in CI** (`Boot server and verify /health`)
   actually boots the full server with Postgres + Redis service
   containers and exercises the deep `/health` probe, which means
   any breakage in DB pooling or Redis connection lands as a CI
   failure rather than a runtime regression.

Browser-level Playwright coverage of the full chat → upload → RAG →
tool-call → stream → citation flow is tracked outside this directory
as a follow-up to PIPELINE.md §14.4.

---

## See also

- [`docs/architecture/PIPELINE.md`](../../../../docs/architecture/PIPELINE.md) — authoritative architecture map.
- [`docs/AGENTIC_FRAMEWORK_STACK.md`](../../../../docs/AGENTIC_FRAMEWORK_STACK.md) — active framework adapters.
- [`docs/UNIVERSAL_SEARCH_BRAIN.md`](../../../../docs/UNIVERSAL_SEARCH_BRAIN.md) — search-brain semantics.
- [`docs/agentic/{PLAN,STATUS,DECISIONS}_4H.md`](../../../../docs/agentic/) — sprint history.
