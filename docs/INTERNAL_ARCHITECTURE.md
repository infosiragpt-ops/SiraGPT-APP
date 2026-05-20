# Internal Architecture

SirAGPT keeps the web UI frozen. All upgrades in this branch live behind existing Express routes, SSE event names, JSON contracts, and status codes.

## Multi-LLM Gateway

```mermaid
flowchart TD
  A[Existing /api/ai/generate] --> B[Task classifier]
  B --> C[LLM routing config]
  C --> D[Opossum circuit breaker]
  D --> E{Provider}
  E -->|primary| OR[OpenRouter]
  E --> AN[Anthropic direct]
  E --> OA[OpenAI]
  E --> GG[Google AI Studio]
  E --> GR[Groq]
  E --> CB[Cerebras]
  E --> MI[Mistral]
  E --> DS[DeepSeek]
  E --> VOY[Voyage/Jina embeddings]
  D --> F[Retry with exponential jitter]
  F --> G[Fallback cascade]
  G --> H[Same SSE stream shape]
```

Routing is configured in `backend/src/orchestration/llm-routing.config.js`. Provider failures are isolated with `opossum`, retry-after headers are respected, and provider choice is scored by quality, latency, and cost.

## LangGraph Checkpoints

```mermaid
stateDiagram-v2
  [*] --> planner
  planner --> retriever
  retriever --> tool_executor
  tool_executor --> critic
  critic --> synthesizer
  synthesizer --> finalizer
  finalizer --> [*]
```

Each node can persist state to `agent_checkpoints` with `thread_id`, `checkpoint_id`, `parent_checkpoint_id`, `state`, `metadata`, and `created_at`. The `state` column has a GIN index for operational inspection.

## RAG And Document Pipeline

```mermaid
flowchart LR
  Upload[Existing upload button] --> ParserPlan[Parser planner]
  ParserPlan --> Marker[Marker PDF]
  ParserPlan --> Docling[Docling fallback]
  ParserPlan --> MarkItDown[MarkItDown Office]
  ParserPlan --> OCR[Surya OCR]
  Marker --> Chunks[Semantic chunks]
  Docling --> Chunks
  MarkItDown --> Chunks
  OCR --> Chunks
  Chunks --> Embeddings[Voyage primary / Jina fallback]
  Embeddings --> PG[(pgvector)]
```

The planner is internal and does not add UI toggles. Existing extraction remains the fallback when optional parser services are not installed.

## Memory Lifecycle

```mermaid
sequenceDiagram
  participant User
  participant Chat
  participant Memory
  participant PG as PostgreSQL pgvector
  User->>Chat: existing chat turn
  Chat->>Memory: extract durable facts async
  Memory->>PG: upsert user_memories
  Chat->>Memory: recall top-k before next turn
  Memory->>Chat: compact memory block
```

`backend/src/orchestration/memory-adapter.js` exposes a Mem0-compatible facade over the existing long-term memory and pgvector store.

## OpenClaw Multichannel

```mermaid
flowchart TD
  WhatsApp --> OpenClaw
  Telegram --> OpenClaw
  Slack --> OpenClaw
  Discord --> OpenClaw
  Signal --> OpenClaw
  iMessage --> OpenClaw
  OpenClaw --> InternalAPI[SirAGPT internal API key]
  InternalAPI --> Orchestration
  Orchestration --> Memory
  Orchestration --> RAG
```

OpenClaw is optional and deployable via `infra/openclaw/docker-compose.yml`. The web application exposes no new visible routes.

## Observability

```mermaid
flowchart LR
  Gateway --> Langfuse
  LangGraph --> Langfuse
  RAG --> Langfuse
  Express --> Sentry
  Gateway --> Pino
```

Langfuse and Sentry are sampled via environment variables and must never block request handling.
