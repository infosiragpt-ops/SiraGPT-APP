# SirAGPT — Environment Variables Reference

> Generated from the internal orchestration upgrade. All variables below are
> consumed by the Express backend (`backend/index.js`) and its orchestration
> layer (`backend/src/orchestration/`). None affect the Next.js frontend UI.

---

## LLM Providers (Multi-Provider Gateway)

| Variable | Provider | Purpose | Default Model |
|----------|----------|---------|---------------|
| `ANTHROPIC_API_KEY` | Anthropic | Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 | `claude-sonnet-4-6` |
| `OPENROUTER_API_KEY` | OpenRouter | Primary gateway; delegates to 300+ models | varies by routing |
| `OPENAI_API_KEY` | OpenAI | GPT-4o, GPT-4o-mini, embeddings legacy | `gpt-4o` |
| `GOOGLE_AI_API_KEY` | Google AI Studio | Gemini 2.5 Pro, Gemini 2.5 Flash | `gemini-2.5-flash` |
| `GROQ_API_KEY` | Groq Cloud | Llama 3.3 70B, DeepSeek R1 Distill | `llama-3.3-70b-versatile` |
| `CEREBRAS_API_KEY` | Cerebras Inference | Ultra-fast inference | `llama-3.3-70b` |
| `MISTRAL_API_KEY` | Mistral La Plateforme | Mistral Large, Small, Codestral | `mistral-large-latest` |
| `DEEPSEEK_API_KEY` | DeepSeek API | DeepSeek Chat, DeepSeek Reasoner | `deepseek-chat` |

### Free-Tier Fallback Model

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMA4_MODEL_ID` | `Gema4-31B` | Model id used when the FREE plan or exhausted premium pools route to the Gema4 fallback |
| `GEMA4_PROVIDER` | `OpenAI` | Provider client used for the configured Gema4 fallback model |
| `GEMA4_DISPLAY_NAME` | `Gema4 31B` | Public display name returned by `/api/ai/models` |
| `GEMA4_ICON` | `ChatGPTLogo` | Icon key returned with the virtual fallback model |

### Embedding Providers

| Variable | Provider | Purpose |
|----------|----------|---------|
| `VOYAGE_API_KEY` | Voyage AI | Primary embeddings (`voyage-3-large`), recommended by Anthropic |
| `JINA_API_KEY` | Jina AI | Fallback embeddings, v3 multilingual |

### Gateway Tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_LLM_GATEWAY_TIMEOUT_MS` | `45000` | Per-call timeout for LLM invocations |
| `SIRAGPT_LLM_GATEWAY_BREAKER_RESET_MS` | `60000` | Circuit breaker reset timeout (opossum) |
| `SIRAGPT_LLM_MAX_TOKENS` | `4096` | Max tokens per LLM call |

---

## Search Tools

| Variable | Provider | Purpose |
|----------|----------|---------|
| `TAVILY_API_KEY` | Tavily API | Primary web search tool for agents |
| `EXA_API_KEY` | Exa AI | Semantic academic search fallback |
| `FIRECRAWL_API_KEY` | Firecrawl | Deep page scraping (self-hosted optional) |

---

## Observability

| Variable | Purpose |
|----------|---------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse Cloud/self-hosted public key |
| `LANGFUSE_SECRET_KEY` | Langfuse Cloud/self-hosted secret key |
| `LANGFUSE_HOST` | Langfuse host URL (defaults to cloud) |
| `SENTRY_DSN` | Sentry error reporting DSN |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing (`true`/`false`) |

---

## Semantic Cache (Upstash Redis)

| Variable | Purpose |
|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST API URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST API token |
| `SIRAGPT_SEMANTIC_CACHE_TTL_QUICK` | TTL seconds for speed queries (default: 300) |
| `SIRAGPT_SEMANTIC_CACHE_TTL_DEEP` | TTL seconds for deep reasoning (default: 3600) |
| `SIRAGPT_SEMANTIC_CACHE_TTL_DEFAULT` | TTL seconds default (default: 600) |

---

## Storage (Cloudflare R2)

| Variable | Purpose |
|----------|---------|
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret key |
| `R2_BUCKET_NAME` | R2 bucket name for artifacts |
| `R2_ENDPOINT` | R2 endpoint override (auto-resolved from ACCOUNT_ID) |

---

## Multichannel (OpenClaw)

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_API_KEY` | API key for SiraGPT→OpenClaw auth |
| `OPENCLAW_GATEWAY_URL` | OpenClaw gateway URL (default: `http://openclaw:8787`) |
| `SIRAGPT_INTERNAL_API_URL` | Backend URL OpenClaw calls into (default: `http://siragpt-backend:5000`) |

---

## Security / Middleware

| Variable | Default | Purpose |
|----------|---------|---------|
| `CSRF_DISABLED` | `0` | Disable CSRF double-submit protection (test env only) |
| `CSRF_PEPPER` | (derived from JWT_SECRET) | HMAC pepper for CSRF token hashing |
| `CORS_ORIGINS` | `*` in dev, `siragpt.io,localhost:3000` in prod | Comma-separated CORS allowlist |
| `CSP_ENABLED` | `0` in dev, `1` in prod | Enable Content-Security-Policy |
| `CSP_REPORT_ONLY` | `1` | CSP report-only mode |
| `JWT_SECRET` | required | JWT signing secret |

---

## Rate Limiting

| Variable | Default | Purpose |
|----------|---------|---------|
| `RATE_LIMIT_AUTH_MAX` | `30` | Max auth requests per window |
| `RATE_LIMIT_EXPENSIVE_MAX` | `180` | Max expensive (LLM) requests per window |
| `RATE_LIMIT_API_MAX` | `3000` | Max general API requests per window |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | Rate limit window duration |
| `RATE_LIMIT_STORE` | `redis` | Rate limit store: `redis` or `memory` |
| `RATE_LIMIT_REDIS_PREFIX` | `rl:` | Redis key prefix for rate limit counters |

---

## Database / Session

| Variable | Purpose |
|----------|---------|
| `PRISMA_DATABASE_URL` | PostgreSQL connection string used by Prisma |
| `DATABASE_URL` | Optional legacy/adapter PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (sessions, queues, rate limits, cache) |
| `SESSION_SECRET` | Express session signing secret |

---

## General

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `5000` | Express backend port |
| `NODE_ENV` | `development` | Environment: `development`, `production`, `test` |
| `SIRAGPT_RESEARCH_EMAIL` | — | Email for polite User-Agent in scientific search |
| `IDEMPOTENCY_ENABLED` | `false` | Enable Stripe-style replay protection |
| `MAINTENANCE_MODE_ENABLED` | `false` | Enable 503 maintenance mode |

---

## Optional Scientific Search Keys

| Variable | Provider | Purpose |
|----------|----------|---------|
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar | Higher rate limits |
| `NCBI_API_KEY` | NCBI PubMed | Higher rate limits |
| `CORE_API_KEY` | CORE | Higher rate limits |

---

## Document Pipeline Parsers

| Variable | Default | Purpose |
|----------|---------|---------|
| `MARKER_BIN` | `marker` | Path to Marker Python CLI for PDF parsing |
| `MARKER_TIMEOUT_MS` | `120000` | Marker process timeout in ms |
| `DOCLING_BIN` | `docling` | Path to Docling Python CLI for technical documents |
| `DOCLING_TIMEOUT_MS` | `120000` | Docling process timeout in ms |
| `MARKITDOWN_BIN` | `markitdown` | Path to MarkItDown CLI for Office docs |
| `MARKITDOWN_TIMEOUT_MS` | `60000` | MarkItDown process timeout in ms |
| `SIRAGPT_SEMANTIC_CHUNK_SIZE` | `1200` | Semantic chunking character size |
| `SIRAGPT_SEMANTIC_CHUNK_OVERLAP` | `200` | Semantic chunk overlap characters |

---

## Web Scraping (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIRECRAWL_HOST` | `https://api.firecrawl.dev` | Firecrawl API host (cloud or self-hosted) |
| `SEARXNG_URL` | — | SearXNG self-hosted meta-search JSON API URL |

---

## Helicone Proxy (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HELICONE_API_KEY` | — | Helicone observability proxy API key |
| `HELICONE_BASE_URL` | `https://oai.helicone.ai` | Helicone proxy base URL |

---

## CrewAI Bridge (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_CREWAI_MODEL` | `gpt-4o-mini` | Model used by CrewAI Python workflows |
| `SIRAGPT_MULTI_AGENT_FRAMEWORK` | `builtin` | `builtin` or `crewai` |

---

## Security Middleware

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_INPUT_SANITIZER_MODE` | `block` | XSS/prompt injection mode: `block`, `warn`, `off` |
