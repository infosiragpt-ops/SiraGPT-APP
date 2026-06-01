# OpenClaw/Hermes-Style Agent Mode Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Convert SiraGPT work turns from fragile simple chat into a durable agent runtime that plans, uses tools, verifies evidence/artifacts, recovers from transport failures, and finalizes only with grounded output.

**Architecture:** Keep lightweight greetings/explanations fast, but route document Q&A, research, data work, code work, deliverables, and long-running goals through `agent-task`. The backend ReAct loop remains the execution core; deterministic routing, execution profiles, task plans, finalize guards, durable events, and recovery policies decide whether a response is safe to show.

**Tech Stack:** Next.js/React frontend, Express backend, ReAct tool loop, OpenAI-compatible providers, SiraGPT RAG, Document Intelligence, durable agent-task event store, GitHub Actions CI/deploy.

---

## Acceptance Criteria

- Uploaded-document questions never use simple text chat; they run as durable agent tasks.
- The agent must analyze the uploaded file with Document Intelligence and retrieve private RAG context before finalizing.
- Existing-document Q&A must stay chat-only unless the user explicitly asks for a new Word/PDF/Excel/PPT/etc. file.
- Finalization is blocked until required tools succeed, or the user gets a truthful actionable failure/recovery message.
- Transport failures are recovered from durable task events before surfacing an error.
- UI shows agent steps/checkpoints/tool progress rather than pretending it is a normal chat.

## Phase 1 — Durable agent route for document Q&A

**Objective:** Fix the immediate gap Luis observed: second/follow-up questions about an uploaded Word must behave as an agentic document task.

**Files:**
- Modify: `lib/ai-service.ts`
- Modify: `backend/src/services/agents/agentic-execution-profile.js`
- Modify: `backend/src/services/agents/agent-task-plan.js`
- Test: `tests/ai-service-intent.test.ts`
- Test: `backend/tests/agentic-execution-profile.test.js`
- Test: `backend/tests/agent-task-plan.test.js`

**Implementation:**
- Route existing-document questions to `agent_task`, not `text`.
- Make `shouldRouteTextPromptThroughAgenticRuntime()` return true for uploaded-document understanding prompts.
- Override misleading keyword routes like “investigación” when the prompt is asking about an uploaded document.
- Require `docintel_analyze` + `rag_retrieve` before finalization for private-file tasks.
- Do not require `create_document`/`verify_artifact` for chat-only questions about an existing document.

**Verification:**
- `node --test .test-dist/tests/ai-service-intent.test.js`
- `node --test backend/tests/agentic-execution-profile.test.js backend/tests/agent-task-plan.test.js`

## Phase 2 — Agent UX parity

**Objective:** Make the user feel an agent is working, not a chat is loading.

**Tasks:**
- Show a persistent “Agente trabajando” panel for agent-task turns.
- Surface plan phases: analyze → retrieve → reason → verify → final.
- Show tool names in human labels: “Analizando documento”, “Buscando evidencia privada”, “Verificando respuesta”.
- Show recovery events when stream/durable recovery happens.

## Phase 3 — Stronger tool policy

**Objective:** Make the agent choose capabilities deterministically instead of relying on prompt wording.

**Tasks:**
- Add execution profiles for document Q&A, document editing, source research, data analysis, code repair, and deliverable generation.
- Attach minimum tool calls and quality gates per profile.
- Expand finalize guard to validate evidence/artifact metadata, not only tool names.

## Phase 4 — Durable multi-step autonomy

**Objective:** Move closer to Hermes/OpenClaw long-running behavior.

**Tasks:**
- Add resumable task checkpoints and replayable plans.
- Add retry/repair loops around failed tools with bounded attempts.
- Add background continuation for long tasks with user-visible status.
- Add “resume task” and “cancel task” controls.

## Phase 5 — External-agent capability layer

**Objective:** Enable OpenClaw/Hermes-like action breadth safely.

**Tasks:**
- Add connector/tools for filesystem/project operations only inside allowed workspaces.
- Add approvals for destructive actions.
- Add memory/context recall with citations to prior tasks.
- Add audit logs for every tool/action/final answer.

## Current Phase 1 Status

Implemented in this change set. Remaining phases are planned and should be implemented incrementally with tests and production deploys.
