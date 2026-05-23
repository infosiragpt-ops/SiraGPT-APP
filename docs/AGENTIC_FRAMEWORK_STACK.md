# Agentic Framework Stack

siraGPT now wires the agentic runtime through real framework adapters while preserving deterministic fallbacks for CI and local development.

## Active Layers

- **LangGraph**: durable task graph, checkpoint-aware execution metadata, human-in-the-loop capability flag.
- **LangChain**: wraps the existing siraGPT tool registry as typed tool descriptors for multi-tool agent compatibility.
- **LangSmith**: optional tracing/evaluation export when `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` is configured.
- **LlamaIndex**: optional RAG provider behind the AI Product OS RAG adapter via `AGENTIC_RAG_PROVIDER=llamaindex`; stores LlamaIndex `Document` objects and falls back to local ranking unless a live provider is explicitly wired.
- **Semantic Kernel-compatible adapter**: in-process kernel/plugins/memory/multi-agent contract. Microsoft does not ship an official JS SDK, so this avoids non-official npm packages and leaves a clean bridge for Python/C# official runtimes.
- **Vercel AI SDK**: frontend package bridge for converting agent task state to UI-message-compatible parts without replacing the existing SSE stream.

## Environment

```env
REDIS_URL="redis://localhost:6379"
AGENT_QUEUE_NAME="siragpt-agent-tasks"
AGENT_WORKER_CONCURRENCY=2
AGENTIC_RAG_PROVIDER="internal" # internal | llamaindex
AGENTIC_AGENT_ENGINE="react"    # react | langchain
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=""
LANGSMITH_PROJECT="siragpt-agentic-runtime"
```

## Event Contract

- `framework_status`: emitted when a task starts running and reports installed frameworks, active providers and fallbacks.
- `human_approval_required`: reserved for tool/action gates that need user review.
- `human_approval_resolved`: emitted by `POST /api/agent/task/:taskId/approval` with `approve`, `reject` or `edit`.

Generated runtime folders such as `uploads/`, `tmp-smoke*`, `.next.broken*` and `artifacts/` stay local and are ignored by Git.
