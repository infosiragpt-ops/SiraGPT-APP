# siraGPT Chat Pipeline

**Status:** authoritative. Last verified against code on 2026-04-30.

This document is the single source of truth for how a single chat turn flows through siraGPT, what each stage guarantees, what it persists, and what audit events it emits. It is **descriptive, not aspirational**: every file path, function name, frame field, and audit event listed here is grounded in the current `main` branch.

If you change the pipeline, update this doc in the same commit. If something here drifts from the code, the code wins — fix the doc.

---

## 1. Design principles

The pipeline is shaped by five non-negotiable principles. All of them are already enforced by the current implementation; new modules must respect them.

1. **Deterministic core, optional LLM enrichment.** The orchestrator (envelope builder, planner, validators, response builder, runtime) does not call an LLM unless explicitly wired via `llmClient`. This makes every turn replayable, testable offline, and auditable without external dependencies.
2. **No model auto-routing.** The model is selected by the caller (`selectedModel`) and guarded against silent substitution at the end of the turn (see `chat-controller.js`, stage 7). The router never picks the model for the user.
3. **Frames over free-form output.** Every stage emits a typed frame (`intent_frame`, `plan_frame`, `tool_call_frame`, `artifact_frame`, `validation_frame`, `final_response_frame`, `execution_trace_frame`, `token_usage_frame`, `token_budget_frame`). The client renders frames; it never parses prose.
4. **Privacy-first observability.** The execution trace and audit log never store raw user prompts, raw tool inputs/outputs, or attachment contents. They store counters, durations, statuses, codes, and dimension labels. Token accounting is also content-free (uses `chars/4` estimator).
5. **Append-only audit, replayable envelopes.** Every transition is appended to `sira_audit_logs`. Envelopes are persisted to `sira_task_envelopes` so a turn can be replayed end-to-end from storage alone.

---

## 2. High-level flow

```
                                   ┌──────────────────────────────────────────────────────────────┐
                                   │                          CHAT TURN                            │
                                   └──────────────────────────────────────────────────────────────┘

   Client                                                            Backend (Express)
   ──────                                                            ─────────────────

   POST /api/sira/chat
   { conversationId, userMessage, attachments,
     selectedModel, userPlan, dryRun }
        │
        ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
   │  routes/ai.js                                                                                │
   │     validate request → call sira/chat-controller.handleChatTurn(args, deps)                  │
   └────────────────────────────────────┬────────────────────────────────────────────────────────┘
                                        │
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
   │  sira/chat-controller.js  (handleChatTurnUnlocked, semaphore-protected)                     │
   ├─────────────────────────────────────────────────────────────────────────────────────────────┤
   │   Stage 1   persist user message            audit: turn_started                              │
   │   Stage 2   token budget preflight          audit: token_budget_checked                      │
   │              (block if violated)            audit: turn_blocked_token_budget                 │
   │   Stage 3   engine.runUserMessage  ──────────────────────────────────────────────────────┐  │
   │   Stage 4   persist envelope                                                              │  │
   │   Stage 5   policies (clarify + safety)     audit: clarification_requested                │  │
   │              (return early if asking)                                                     │  │
   │   Stage 6   runtime.runWorkflow    ──────────────────────────────────────────────────────┤  │
   │              (DAG execution)                                                              │  │
   │   Stage 7   model auto-routing guard                                                      │  │
   │   Stage 8   record token usage              audit: token_usage_recorded                   │  │
   │   Stage 9   persist assistant + audit       audit: turn_completed                         │  │
   └────────────────────────────────────┬───────────────────────────────────────────────────────┘  │
                                        │                                                          │
                                        ▼                                                          │
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐    │
   │  sira/engine.js  (runUserMessage)                                                       │ ◄──┘
   ├─────────────────────────────────────────────────────────────────────────────────────────┤
   │  1. task-envelope-builder.buildEnvelope    →  Sira Cognitive Task Envelope              │
   │  2. buildIntentFrame                       →  intent_frame                               │
   │  3. buildPlanFrame                         →  plan_frame                                 │
   │  4. buildToolCallFrame                     →  tool_call_frame                            │
   │  5. buildArtifactFrame                     →  artifact_frame                             │
   │  6. buildValidationFrame  (deterministic)  →  validation_frame                           │
   │  7. response-builder.buildFinalResponseFrame → final_response_frame                      │
   └────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                        │
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  sira/runtime.js  (runWorkflow, executes envelope.workflow_graph as a DAG)              │
   ├─────────────────────────────────────────────────────────────────────────────────────────┤
   │  per node:  tool-registry.get  →  tool-policy.evaluate  →  idempotency-guard            │
   │             →  tool-resilience.invoke (retry + timeout)  →  collect artifacts            │
   │  emits:     node_started, tool_invoked, tool_retry_scheduled, tool_deduplicated,         │
   │             tool_policy_denied, node_completed                                           │
   │  produces:  artifact_frame, validation_frame, execution_trace_frame, evidence_ledger     │
   └─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                                  Response (frames + summary + artifacts)
                                  streamed/returned to client
```

The entire flow is intended to be **deterministic and content-free at the observability layer**. The only places where LLM calls happen today are (a) optional intent enrichment inside `task-envelope-builder` if `llmClient` is injected, and (b) downstream artifact generators (e.g., document/spreadsheet/visual generators) that the runtime invokes via the tool registry. Neither path stores raw prompts or outputs in audit logs.

---

## 3. Stage contracts

Every stage in `chat-controller.handleChatTurnUnlocked` has a strict contract. These contracts are what task #2 (`request_id` propagation) and task #3 (error taxonomy) will harden.

### Stage 1 — Persist user message

- **File:** `backend/src/services/sira/chat-controller.js`
- **Input:** `{ conversationId, userId, userMessage, attachments[] }`
- **Output:** `persisted_ids.user_message_id`
- **Audit:** `turn_started` with `{ conversation_id, user_id, attachment_count, message_chars }`
- **Failure mode:** storage adapter throws → entire turn aborts with no further audit.

### Stage 2 — Token budget preflight

- **Files:** `backend/src/services/sira/token-budget-policy.js`, `token-ledger.js`
- **Function:** `assessTokenBudget({ user_plan, user_id, conversation_id, projected_usage })`
- **Output:** `token_budget_frame` (decision: `allowed` | `blocked`, violations[])
- **Audit:** `token_budget_checked` always; `turn_blocked_token_budget` when blocked
- **Modes:** `enforce` blocks; `observe` measures only.
- **Failure mode:** returns early before invoking engine; assistant response is a controlled "budget exceeded" message.

### Stage 3 — Engine

- **File:** `backend/src/services/sira/engine.js`
- **Function:** `runUserMessage({ user_message, history, attachments, selected_model, … })`
- **Output:** `{ envelope, intent_frame, plan_frame, tool_call_frame, artifact_frame, validation_frame, final_response_frame, snapshot }`
- **Audit:** `envelope_invalid` on schema failure
- **Failure mode:** envelope construction errors return `stage: "envelope_invalid"` and the turn ends without runtime execution.

### Stage 4 — Persist envelope

- **Table:** `sira_task_envelopes` (`request_id` UNIQUE)
- **Purpose:** make the turn replayable. Any future re-execution can read the envelope, recompute frames, and verify validators without re-asking the user.
- **Failure mode:** persistence failures are logged but do not abort the turn (best-effort).

### Stage 5 — Policy evaluation (clarification + safety)

- **File:** `backend/src/services/sira/policies.js`
- **Function:** `evaluatePolicyForEnvelope(envelope)` → `{ needs_clarification, questions[], safety: { allowed, reasons[] } }`
- **Audit:** `clarification_requested` when the policy decides to ask the user
- **Thresholds:** ask if intent confidence < 0.55; bypass if > 0.82; never ask for "obvious defaults" (language, APA7, Tailwind, responsive, …).
- **Failure mode:** if clarification is needed, the turn returns early with `stage: "needs_clarification"` and the questions; runtime is not invoked.

### Stage 6 — Runtime

- **File:** `backend/src/services/sira/runtime.js`
- **Function:** `runWorkflow({ envelope, tool_registry, tool_dispatcher, deps })`
- **Output:** `{ tool_results[], artifact_frame, validation_frame, execution_trace_frame, evidence_ledger, audit_trace, summary }`
- **Audit (timeline-only, not in main audit log):** `node_started`, `node_completed`, `tool_policy_denied`, `tool_deduplicated`, `tool_invoked`, `tool_retry_scheduled`
- **Resilience:** see §7. Retries are bounded (max 5, exponential backoff base 25ms / cap 2s); non-retryable codes short-circuit immediately.
- **Failure mode:** node failures are captured in the execution trace; the validation frame decides `ready_to_deliver`. A failed node does not abort the turn; the validator gates the release.

### Stage 7 — Model auto-routing guard

- **File:** `backend/src/services/sira/chat-controller.js` (inline)
- **Check:** `originalSelectedModel === finalSelectedModel`. If they differ, the controller throws `ModelAutoRoutingDetected` and the turn fails. This guarantees the platform never silently swaps a user's model choice.

### Stage 8 — Token usage recording

- **Files:** `token-ledger.js`, `token-budget-policy.js`
- **Function:** `buildTokenUsageFrame({ envelope, runtime, model_usage })` → `token_usage_frame`
- **Audit:** `token_usage_recorded` (or `token_usage_ledger_error` on failure)
- **Privacy:** the frame stores token counts and dimension labels (user, model, intent, family). It never stores raw prompts, attachment content, or tool arguments.

### Stage 9 — Persist assistant response + close turn

- **Tables:** `sira_messages` (assistant role), `sira_artifacts`, `sira_tool_calls`, `sira_validation_reports`, `sira_audit_logs`
- **Audit:** `turn_completed` with `{ request_id, ready_to_deliver, artifact_count, tool_count, token_usage, execution_trace_summary }`

---

## 4. Module map

Every file in `backend/src/services/sira/`, with one-line role.

| File | Role |
|---|---|
| `chat-controller.js` | Entry point; orchestrates the 9 stages above. |
| `engine.js` | Pure orchestrator; builds envelope + 5 deterministic frames. |
| `runtime.js` | Executes `workflow_graph` DAG; emits trace + artifact + validation frames. |
| `task-envelope-builder.js` | Builds the Sira Cognitive Task Envelope from raw input + history + RAG + memory. |
| `task-envelope-schema.js` | JSON schema and validators for the envelope. |
| `tool-registry.js` | Typed tool registry (60+ tools, 10 categories). |
| `tool-policy.js` | Trust boundary; permission + sandbox + risk evaluation per tool. |
| `tool-resilience.js` | Retry/timeout/backoff controller for tool invocations. |
| `validator-engine.js` | Deterministic checks across artifact/source/code/document/safety families. |
| `hybrid-retrieval.js` | BM25 + dense + RRF + reranker pipeline used during envelope build. |
| `frames.js` | Builders for `intent_frame`, `plan_frame`, `tool_call_frame`, `artifact_frame`, `validation_frame`, `final_response_frame`. |
| `execution-trace-frame.js` | Privacy-safe runtime timeline + counters. |
| `intent-taxonomy.js` | 14 task families × ~85 intents with default plan/risk/capabilities. |
| `intent-prompts.js` | Prompts and few-shot examples for optional LLM-based intent enrichment. |
| `policies.js` | Clarification + safety policies (constants + evaluators). |
| `token-ledger.js` | Token accounting (deterministic estimator + provider-reported merge). |
| `token-budget-policy.js` | Plan caps (FREE/PRO/TEAM/ENTERPRISE) and budget decision. |
| `model-adapter.js` | Model abstraction layer (OpenAI, Anthropic, Groq, Gemini, OpenRouter). |
| `idempotency-guard.js` | Tool-call deduplication within a workflow. |
| `session-actor-queue.js` | Per-conversation serialization (one in-flight turn per conversation). |
| `storage-schema.js` | Postgres DDL + in-memory adapter for the 7 sira tables. |
| `response-builder.js` | Final response composer (`buildFinalResponse`) used by the engine after all frames are assembled. The `final_response_frame` itself is built in `frames.js`. |
| `llm-observability.js` | Sessions/traces/spans/generations vocabulary (Langfuse-compatible). |
| `eval-harness.js` | Offline evaluation harness for envelope/runtime regressions. |
| `research-engine.js` | Long-running research-mode dispatch (citations, sources, evidence). |
| `artifact-engine.js` | Per-format artifact generation pipeline. |
| `document-pipeline-registry.js` | Registry of document-format handlers (DOCX, XLSX, PPTX, PDF, …). |

Adjacent supporting directories (not detailed in this doc, but in scope of the pipeline):

- `services/agent-runtime/` — Sira agent orchestrator, task envelope validation, runtime hooks.
- `services/ai-product-os/` — semantic intent router, skill system, model router, planner.
- `services/agentic/` — agentic task execution, enterprise runtime, QA board, operating core.
- `services/observability/` — tracing adapters, metric collection.
- `services/security/` — permission checks, sensitive data redaction.
- `services/rag/` — document pipeline, chunking, embedding, hybrid search.
- `services/searchBrain/` — semantic search, memory retrieval.

---

## 5. Frame catalog

A frame is a typed, JSON-serializable object that travels between stages. Every frame includes `request_id` and a `kind` discriminator. The client treats frames as the authoritative payload; prose summaries are derived from frames, never the other way around.

| Frame | Built by | Key fields |
|---|---|---|
| `intent_frame` | `frames.buildIntentFrame` | `primary_intent`, `secondary_intents[]`, `goal`, `confidence`, `needs_clarification`, `clarifying_questions[]` |
| `plan_frame` | `frames.buildPlanFrame` | `workflow_type`, `execution_mode`, `steps[]` (id, name, agent, tools[], depends_on[]), `retry_policy`, `timeout_policy`, `gates[]`, `evidence_ledger[]`, `audit_trace[]` |
| `tool_call_frame` | `frames.buildToolCallFrame` | `tool_calls[]` (tool, tool_type, priority, risk_level, arguments, expected_output), `optional[]`, `forbidden[]` |
| `artifact_frame` | `frames.buildArtifactFrame` | `artifacts[]` (type, format, name, required, role), `document_specification`, `spreadsheet_specification`, `visual_specification`, `image_specification`, `video_specification`, `accessibility` |
| `validation_frame` | `frames.buildValidationFrame` | `checks[]` (name, status, score, detail), `aggregate_score`, `minimum_acceptance_score`, `ready_to_deliver`, `regenerate_required` |
| `final_response_frame` | `frames.buildFinalResponseFrame` | `request_id`, `delivery_mode`, `ready_to_deliver`, `release_decision`, `must_include[]`, `must_not_include[]`, `user_visible_summary`, `artifact_cards[]`, `warnings[]` |
| `citation_frame` | `citation-frame.buildCitationFrame` | `language`, `has_citations`, `annotated_text`, `footnotes`, `citations[]` (index, source_id, title, snippet, relevance_score, marker_count), `coverage` (sources_provided, sources_cited, coverage_ratio) |
| `execution_trace_frame` | `execution-trace-frame.composeExecutionTrace` | `started_at`, `finished_at`, `duration_ms`, `status`, `counters`, `nodes[]`, `tools[]`, `timeline[]`, `privacy` (no raw payloads) |
| `token_usage_frame` | `token-ledger.buildTokenUsageFrame` | `request_id`, `accounting_method`, `estimator_version`, `dimensions` (user/model/intent/family), `usage` (input/tool/output/total), `inputs_profile`, `runtime_profile`, `privacy` |
| `token_budget_frame` | `token-budget-policy.assessTokenBudget` | `decision`, `enforcement_mode`, `user_plan`, `caps`, `projected_usage`, `current_usage`, `violations[]` |

---

## 6. Audit event reference

Every event lands in `sira_audit_logs(request_id, user_id, event_type, payload, created_at)`. Payloads are always content-free.

| Event | Stage | Payload (key fields) |
|---|---|---|
| `turn_started` | 1 | `conversation_id`, `user_id`, `attachment_count`, `message_chars` |
| `token_budget_checked` | 2 | `decision`, `enforcement_mode`, `projected_usage`, `caps`, `violations[]` |
| `turn_blocked_token_budget` | 2 | `decision`, `violations[]`, `projected_usage` |
| `envelope_invalid` | 3 | `errors[]` (validator-reported schema errors) |
| `clarification_requested` | 5 | `questions[]`, `reasons[]` |
| `execution_trace_recorded` | 6 | `request_id`, `status`, `duration_ms`, `counters` |
| `token_usage_recorded` | 8 | `request_id`, `dimensions`, `usage`, `accounting_method`, `estimated` |
| `token_usage_ledger_error` | 8 | `request_id`, `error_message` |
| `turn_completed` | 9 | `request_id`, `ready_to_deliver`, `artifact_count`, `tool_count`, `token_usage`, `execution_trace_summary` |

Runtime emits these into the execution trace timeline (not the main audit log):

`node_started`, `node_completed`, `tool_policy_denied`, `tool_deduplicated`, `tool_invoked`, `tool_retry_scheduled`.

---

## 7. Tool subsystem

A tool invocation flows through four guards before it actually runs.

```
runtime.runWorkflow
   │
   ▼
 tool-registry.get(name)         ──►  not found  → tool_policy_denied (code: tool_not_found)
   │
   ▼
 tool-policy.evaluate            ──►  denied      → tool_policy_denied
   │                                    (permission, risk, sandbox, side-effect, human-confirm)
   ▼
 idempotency-guard               ──►  duplicate   → tool_deduplicated (cached result)
   │
   ▼
 tool-resilience.invoke
   │   try N times with backoff
   │   retry_on:    tool_timeout, invalid_json, file_generation_error, source_validation_failure
   │   non-retry:   permission_denied, tool_policy_denied, needs_human_approval,
   │                tool_not_found, invalid_input
   ▼
 tool result  →  artifact_frame + validation feed
```

Tool descriptor shape (registered via `tool-registry.register`):

```js
{
  name, displayName, description, category, riskLevel,
  permissionsRequired: [],
  timeoutMs, retryable, requiresHumanConfirmation,
  manifest: {
    inputSchema, outputSchema,
    allowedFormats: [], forbiddenFormats: [],
    sideEffectLevel,         // 'none' | 'low' | 'medium' | 'high'
    sandboxRequired,         // boolean
    auditPolicy              // 'silent' | 'summary' | 'full'
  },
  execute(input, context) → SiraToolResult
}
```

Tool result shape:

```js
{
  status: 'success' | 'error' | 'requires_confirmation' | 'skipped_dry_run',
  output?, error?: { code, message }, metadata?, artifacts?
}
```

Policy profiles: `interactive` (all permissions), `sandbox` (only `execute_sandboxed_code`), `locked_down` (only `read_uploaded_file`).

---

## 8. Validation subsystem

Five validator families, one per concern. Each runs deterministically; none calls an LLM.

| Family | Checks |
|---|---|
| `artifact_validator` | `file_opens`, `mime_match`, `extension_match`, `min_pages`, `min_rows`, `min_words`, `contains_text`, `format_sovereignty`, `no_lorem_ipsum`, `size_reasonable` |
| `source_validator` | `no_fake_doi`, `doi_or_url_present`, `sources_match_claims`, `citation_style_correct`, `year_recent_enough`, `domain_authoritative`, `every_claim_has_source`, `no_hallucinated_quotes` |
| `code_validator` | `parses`, `no_secrets_committed`, `no_dangerous_calls`, `cyclomatic_under_threshold`, `passes_lint`, `passes_tests`, `no_syntax_errors`, `no_unused_imports` |
| `document_validator` | `cover_page_present`, `toc_present`, `has_h1`, `headings_hierarchical`, `references_present`, `tables_render`, `charts_render`, `min_word_count` |
| `safety_validator` | `no_pii_in_logs`, `no_prompt_injection_response`, `respects_robots`, `no_captcha_bypass`, `no_destructive_action_without_approval`, `no_self_harm_content` |

Each validator returns `{ validator, checks[], score, summary }`. The validator engine composes a `validation_frame` with `aggregate_score`, `minimum_acceptance_score`, and `ready_to_deliver`. The release gate uses `ready_to_deliver`.

---

## 9. RAG subsystem

The retrieval pipeline lives in `hybrid-retrieval.js`. It is invoked during envelope construction when the intent or attachment plan calls for grounded context.

```
query
  │
  ▼  metadata + temporal pre-filters (source_id, year range, language)
  │
  ├──► BM25 (k1=1.5, b=0.75)         ──►  sparse hits
  │
  ├──► dense cosine (if embeddings)  ──►  dense hits
  │
  ▼  reciprocal-rank fusion (k=60)
  │
  ▼  cross-encoder rerank (caller-injected, optional)
  │
  ▼  citation grounding (extract source spans per hit)
  │
  ▼  hits[] + trace { mode, candidates, after_filters, sparse_used, dense_used, rerank_used }
```

Modes: `sparse`, `dense`, `hybrid`. The trace is what the envelope embeds for evidence; raw chunk text is **not** persisted in the audit log.

---

## 10. Token economics

### Plan caps (`token-budget-policy.resolveTokenBudgetCaps`)

| Plan | Input/turn | Total/turn | Conversation | Daily |
|---|---|---|---|---|
| `FREE` | 24k | 96k | 500k | 750k |
| `PRO` | 64k | 180k | 2M | 5M |
| `TEAM` | 96k | 260k | 5M | 15M |
| `ENTERPRISE` | 180k | 500k | 25M | 75M |

### Accounting

- **Estimator:** `chars/4`, version `chars_div_4.v1`. Used when the provider does not report `usage`.
- **Provider-reported merge:** when present, provider numbers replace the estimate for `prompt_tokens` and `completion_tokens`; tool tokens remain estimated.
- **Dimensions:** `user_id`, `model_id`, `task_intent`, `task_family`. These are the only fields used for aggregation; no message text touches the ledger.

### Decision

`assessTokenBudget` returns `decision: 'allowed' | 'blocked'`, `enforcement_mode: 'enforce' | 'observe'`, and `violations[]` with codes (`input_tokens_exceeded`, `turn_tokens_exceeded`, `conversation_tokens_exceeded`, `daily_tokens_exceeded`). In `enforce` mode, blocked turns short-circuit at stage 2.

---

## 11. Storage schema

All seven tables are defined in `sira/storage-schema.js`. Postgres DDL is shipped via `SCHEMA_DDL`; tests use `createInMemoryStorage()` with the same shape.

| Table | Purpose |
|---|---|
| `sira_conversations` | One row per conversation. |
| `sira_messages` | All messages (system, user, assistant, tool). `content` is JSONB. |
| `sira_task_envelopes` | One row per turn. `request_id` UNIQUE. Used for replay. |
| `sira_tool_calls` | One row per tool invocation. Status, error, timing. |
| `sira_artifacts` | One row per produced artifact. Validation status, storage URL. |
| `sira_validation_reports` | One row per turn. Aggregate score + per-check JSONB. |
| `sira_audit_logs` | Append-only audit trail. Event type + JSONB payload. |

---

## 12. Observability stack

Three layers, each with a different audience and retention.

| Layer | Audience | Retention | Source |
|---|---|---|---|
| **Audit log** (`sira_audit_logs`) | compliance, support, replay | indefinite | `chat-controller`, `runtime` |
| **Execution trace** (`execution_trace_frame`) | engineering, debugging | per-turn (in DB + frame) | `runtime`, `execution-trace-frame.js` |
| **LLM tracing** (sessions/traces/spans/generations) | model performance, cost | configurable (Langfuse/Phoenix-compatible) | `llm-observability.js` |

`llm-observability.js` defines the vocabulary (`session`, `trace`, `span`, `generation`, `event`, `score`) with `span_kind` ∈ {`tool_call`, `retrieval`, `rerank`, `generation`, `validation`, `artifact_render`, `policy_check`, `router_decision`, `memory_op`, `external_api`, `internal`, `user_clarification`, `human_approval`}. Adapters can ship spans to Langfuse, Phoenix, Helicone, or stay in-process.

---

## 13. Cross-references

- `docs/AGENTIC_FRAMEWORK_STACK.md` — active framework adapters (LangGraph, LangChain, LlamaIndex, Semantic Kernel-compatible, Vercel AI SDK).
- `docs/UNIVERSAL_SEARCH_BRAIN.md` — search-brain semantics.
- `docs/agentic/PLAN_4H.md`, `STATUS_4H.md`, `DECISIONS.md` — 4-hour sprint plan that introduced the token ledger, budget preflight, and execution trace frame.
- `docs/chatagentic-capability-smoke-report.md` — capability smoke report for the chat-agentic surface.
- `docs/document-chat-integration-report.md`, `document-generation-validation-report.md` — document subsystem reports.

---

## 14. Known gaps and roadmap

These are the pieces that are deliberately not yet here. Each will be addressed in its own commit so the diff stays auditable.

| # | Gap | Planned in | Status |
|---|---|---|---|
| 1 | `request_id` end-to-end propagation: HTTP middleware → chat-controller → engine → envelope, echoed back as `X-Request-Id`. | task 2 | **done** — `backend/src/middleware/request-id.js`, `tests/sira-request-id.test.js` |
| 2 | Stage-aware error taxonomy: `SiraPipelineError` + per-stage subclasses, `wrapAsSiraError`, `toHttpResponse`, `toAuditPayload`, `siraErrorHandler`. | task 3 | **done** — `backend/src/services/sira/pipeline-errors.js`, `tests/sira-pipeline-errors.test.js`, first migrated site: chat-controller input validation |
| 3 | Deep `/health/{live,ready}` + composite `/health` (DB + Redis + queue + process + model-providers). Prometheus `/metrics` covering chat turns, durations, budget decisions, pipeline errors, clarifications, envelope rejections. | task 4 | **done** — `backend/src/services/observability/health-check.js`, `backend/src/services/sira/metrics.js`, `backend/index.js`, `tests/sira-health-and-metrics.test.js` |
| 4 | HTTP-layer integration tests for the full request lifecycle (middleware → request-id → controller → error handler → response) including `/health`, `/metrics`, and the chat endpoint. Browser-level Playwright coverage of the full chat → upload → RAG → tool-call → stream → citation flow is a separate, larger effort tracked outside this gap. | task 5 | **done** for the HTTP slice — `tests/sira-http-integration.test.js`. Browser-level E2E remains pending. |
| 5 | Module-level navigation docs: `services/sira/README.md` (full module index, audit-event + metric tables, "how to add a stage / frame / tool / validator", invariants) and `services/observability/README.md` (health-check contract + when to add a probe). | task 6 | **done** — `backend/src/services/sira/README.md`, `backend/src/services/observability/README.md` |
| 6 | First-class `compactContext({messages, model, ragChunks, memoryGists, summarizer})` that owns the per-turn shrinking decision: dedup → window-fit → summarize-on-overflow → rank+cap RAG → cap memory. Reuses the existing `fitMessagesToContext` for window logic instead of forking it. | task 7 | **done** — `backend/src/services/sira/context-compactor.js`, `tests/sira-context-compactor.test.js`. Wiring into `task-envelope-builder` is deliberately a separate follow-up to keep this diff small. |

---

## 15. Conventions for future changes

- **Add a stage:** add a new section in §3 with the same fields. Update §6 with any new audit events.
- **Add a frame:** add it to §5 and to `frames.js` (or its own builder); update the engine snapshot.
- **Add a tool:** register via `tool-registry.register`. Provide `manifest`. Confirm `tool-policy` profile coverage. Add tests under `backend/tests/`.
- **Add a validator:** add to the appropriate family in `validator-engine.js`. Add tests. Update §8.
- **Add a storage table:** update `storage-schema.js` (DDL + in-memory). Update §11.
- **Document:** every PR that changes a stage updates this file in the same commit.

---

*This document is owned by everyone who touches the chat pipeline. If you see drift between the doc and the code, the code is right and the doc is broken — fix it.*
