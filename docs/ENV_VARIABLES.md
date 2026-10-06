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
| `XAI_API_KEY` | xAI / Grok | Grok chat plus `/api/voice/grok` STT/TTS | `grok-4.3`, `grok-stt`, voice `eve` |
| `OPENAI_API_KEY` | OpenAI | GPT-4o, GPT-4o-mini, embeddings legacy | `gpt-4o` |
| `GOOGLE_AI_API_KEY` | Google AI Studio | Gemini 2.5 Pro, Gemini 2.5 Flash | `gemini-2.5-flash` |
| `GROQ_API_KEY` | Groq Cloud | Llama 3.3 70B, DeepSeek R1 Distill | `llama-3.3-70b-versatile` |
| `CEREBRAS_API_KEY` | Cerebras Inference | Ultra-fast inference | `llama-3.3-70b` |
| `MISTRAL_API_KEY` | Mistral La Plateforme | Mistral Large, Small, Codestral | `mistral-large-latest` |
| `TYPESAFE_API_KEY` | TypeSafe AI (System One) | Jev decision model: `typesafe/jev-latest`, `typesafe/jev-1.13` in the picker, `decide_with_jev` agent tool, RLCD media-intent refinement (`SIRAGPT_RLCD_JEV`, `SIRAGPT_RLCD_JEV_TIMEOUT_MS`, `SIRAGPT_RLCD_JEV_MODEL`); optional `TYPESAFE_BASE_URL`, `TYPESAFE_TIMEOUT_MS`, `TYPESAFE_RETRIES` | `jev-latest` |
| `DEEPSEEK_API_KEY` | DeepSeek API | DeepSeek V4 Flash / Pro (shown with these original names); also the codex coding agent's native tool-calling engine | `deepseek-v4-flash` |

### Codex coding agent — DeepSeek native engine

When `DEEPSEEK_API_KEY` is set the codex agent loop (`/api/codex`, builds behind
`/agentes` and `/apps`) drives every step with DeepSeek V4 through native
function calling (`backend/src/services/codex/deepseek-turn.js`). Power tier →
`deepseek-v4-pro`, other tiers → `deepseek-v4-flash`. A failing DeepSeek step
degrades to Claude (eligible tiers) and then to the prompted provider ladder
(`deepseek → anthropic → openrouter → cerebras`), never to a failed run.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL (OpenAI-compatible) |
| `CODEX_DEEPSEEK_DISABLED` | unset | `1` skips the native DeepSeek engine (ladder rung stays) |
| `CODEX_DEEPSEEK_TIERS` | `eco,standard,power` | Run tiers served by DeepSeek; a tier carved out falls back to the previous engine for that tier |
| `CODEX_DEEPSEEK_MODEL` | unset | Model for every tier (overridden by the two below) |
| `CODEX_DEEPSEEK_MODEL_POWER` | `deepseek-v4-pro` | Model for the Power tier |
| `CODEX_DEEPSEEK_MODEL_STANDARD` | `deepseek-v4-flash` | Model for Eco/Estándar |
| `CODEX_DEEPSEEK_MAX_TOKENS` | `8192` | Output budget per step |
| `CODEX_DEEPSEEK_TEMPERATURE` | `0.2` | Sampling temperature (ignored while thinking is enabled) |
| `CODEX_DEEPSEEK_THINKING` | unset | `1` forces V4 thinking on, `0` off; default: Pro thinks, Flash only on high effort |
| `CODEX_USER_MEMORY` | unset | `0` stops injecting the user's Hermes memory (durable facts + curated block) into the codex system prompt |
| `CODEX_USER_MEMORY_MAX_CHARS` | `3000` | Cap of the injected memory block |
| `CODEX_USER_MEMORY_LIMIT` | `12` | Facts requested from the memory store per run |
| `CODEX_LLM_PROVIDER` | unset | Force a single ladder rung: `deepseek` \| `anthropic` \| `openrouter` \| `cerebras` |

### /agentes task notifications

When a long `/agentes` task reaches a terminal state, `agents/task-store`
publishes `agent.task.completed | failed | cancelled` once per task through
the trigger registry: an inbox notification (rendered by the existing
notification center, linking to the chat) plus the user's webhooks.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_AGENT_TASK_NOTIFY` | unset | `0` disables the terminal notification everywhere; `1` forces it on (even under `NODE_ENV=test`). Default: on in production or whenever `DATABASE_URL` is set, off in tests |

### GitHub workspace "▶ Run" (legacy host runner)

`backend/src/services/github/workspace-runner.service.js` runs a cloned
repository's dev server inside the backend process' own filesystem and
network namespace. It is **disabled by default when `NODE_ENV=production`**;
use the sandboxed codex runner instead.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_WORKSPACE_RUN_ENABLED` | unset | `1` opts a production host in (only where running third-party repos next to the DB/Redis is acceptable) |
| `SIRAGPT_WORKSPACE_RUN_DISABLED` | unset | `1` kill switch in every environment (wins over the opt-in) |

### Free-Tier Fallback Model

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMA4_MODEL_ID` | `Gema4-31B` | Model id used when the FREE plan or exhausted premium pools route to the Gema4 fallback |
| `GEMA4_PROVIDER` | `OpenAI` | Provider client used for the configured Gema4 fallback model |
| `GEMA4_DISPLAY_NAME` | `Gema4 31B` | Public display name returned by `/api/ai/models` |
| `GEMA4_ICON` | `ChatGPTLogo` | Icon key returned with the virtual fallback model |

### Jev tier steering (flash↔pro escalation)

The RLCD × Jev per-turn judge (`backend/src/services/rlcd/jev-turn-judge.js`,
TypeSafe Jev via the native `/v1/systemone` provider) already answers, with
calibrated probabilities, which model family the turn needs. Its verdict is
applied to the Sira flash↔pro tier routing by
`backend/src/services/ai/jev-router.js` inside `/api/ai/generate`: a
`reasoning`/`coding` verdict escalates a flash-tier turn to the pro tier, a
`fast_cheap` verdict vetoes a heuristic pro escalation, everything else stays
advisory (logged as `routing.jev_tier_steering`). No extra network call — it
consumes the judge's single per-turn fan-out. The existing apply guards are
unchanged: the user's picker always wins, plan eligibility and provider
inference still gate the final model. Fail-open by shape.

Activation = the RLCD Jev judge running (`TYPESAFE_API_KEY` + `SIRAGPT_RLCD_JEV`)
plus the steering flag it already defines:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_RLCD_JEV_MODEL_STEERING` | `false` | The judged model family steers the automatic route (never a user-picked model). Off = advisory telemetry only |
| `SIRAGPT_RLCD_JEV_MODEL_CONFIDENCE` | `0.7` | Minimum family confidence for the verdict to steer |
| `SIRAGPT_JEV_PRO_TARGET` | *(derived)* | Override the pro-tier target id; by default the flash id's tier token is swapped (`deepseek-v4-flash` → `deepseek-v4-pro`) |

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

### Chats largos — topes del historial por turno (added 2026-10-02)

Cada turno de `/api/ai/generate` repetía el historial completo: cada imagen
histórica se releía del disco y viajaba en base64 (`detail: high`), cada adjunto
histórico re-adjuntaba su texto extraído entero y la pila de entendimiento
(atribución, saliencia, RLCD, CIRA) corría síncrona sobre 80 filas sin recortar.
El turno N era más lento que el N-1. Topes (0 = sin tope):

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_HISTORY_INLINE_IMAGE_ROWS` | `3` | Filas con imagen más recientes cuyas imágenes viajan al modelo; las anteriores quedan como stub con el nombre |
| `SIRAGPT_HISTORY_ATTACHMENT_TEXT_MAX_CHARS` | `8000` | Tope por adjunto histórico del texto extraído repetido en el prompt (el turno actual re-adjunta los documentos recientes completos por file-context/RAG) |
| `SIRAGPT_UNDERSTANDING_RECENT_MAX_CHARS` | `6000` | Tope por fila para las últimas 6 filas que ve la pila de entendimiento |
| `SIRAGPT_UNDERSTANDING_OLD_MAX_CHARS` | `1500` | Tope por fila para las filas anteriores de esa pila |
| `COMPUTER_ACTION_TIMEOUT_MS` | `45000` | Tope del reenvío de una acción al orquestador del escritorio (`POST /api/agent-computer/action`); 504 `desktop_action_timeout` al agotarse |

### Brief del pedido — entendimiento por turno (added 2026-10-03)

`backend/src/services/request-brief.js` calcula UNA lectura estructurada de lo
que pide el usuario (acción, entregable, objetivo —adjunto / archivo generado /
respuesta anterior—, restricciones, ambigüedad) por turno de `/api/ai/generate`.
Cierra la fila «Analizando tu mensaje» con «Entendí: …», viaja como frame SSE
`request_brief`, entra como bloque de sistema tier 0 y dirige las puertas de
ruteo (editor de documentos / AgentRunner).

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_REQUEST_BRIEF` | `1` | `0`/`off` desactiva el brief (fila, frame, bloque, ruteo y preguntas de aclaración del brief) |
| `SIRAGPT_REQUEST_BRIEF_LLM` | `1` | `0` desactiva el refinado con el tier gratuito (Cerebras) de los briefs de baja confianza con historial; sin `CEREBRAS_API_KEY` nunca corre |
| `SIRAGPT_REQUEST_BRIEF_LLM_TIMEOUT_MS` | `900` | Tope de la llamada de refinado; al agotarse se conserva el brief heurístico |

### Transcripción de enlaces — herramienta `transcribe_url` (added 2026-10-03)

`backend/src/services/agent-harness/tools/transcribe-url-tool.js`: el agente transcribe el
audio de un enlace (YouTube, Vimeo, Drive público, .mp4/.mp3 directos…) entero o de un
minuto a otro. Descarga solo la sección con `yt-dlp --download-sections`, recorta y codifica
con ffmpeg (mono 16 kHz AAC) y transcribe con la escalera de `audio-transcriber` (OpenAI →
Groq → xAI → whisper.cpp local). Un enlace con login (401/403, video privado) devuelve
`media_login_required` con dos caminos para el usuario. La imagen del backend instala
`yt-dlp` (apk) junto a `ffmpeg`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRANSCRIBE_URL_YTDLP` | `yt-dlp` | Binario del descargador |
| `FFMPEG_PATH` | `ffmpeg` | Binario de ffmpeg (compartido con whisper local) |
| `TRANSCRIBE_URL_MAX_SECONDS` | `10800` | Máximo de audio por llamada (3 h); por encima pide un rango (`media_too_long`) |
| `TRANSCRIBE_URL_TIMEOUT_MS` | `1200000` | Tope por proceso (descarga / ffmpeg) y para la transcripción (20 min) |
| `TRANSCRIBE_URL_JS_RUNTIME` | `node` | Runtime JS para el desafío de YouTube: `node` (el Node del propio backend, `--js-runtimes node:<execPath>`), `deno` o `none` |
| `TRANSCRIBE_URL_REMOTE_COMPONENTS` | (vacío) | Pasa `--remote-components` a yt-dlp (p. ej. `ejs:github`) si la imagen no trae `yt-dlp-ejs` |
| `TRANSCRIBE_URL_BROWSER_DISCOVERY` | `1` | Peldaño del navegador headless (Chromium de la imagen) para páginas de reproductor que yt-dlp no conoce; `0` lo apaga |
| `TRANSCRIBE_URL_DISCOVERY_TIMEOUT_MS` | `30000` | Tope del descubrimiento con navegador por enlace |
| `TRANSCRIBE_URL_COMPUTER` | `1` | `0` desactiva el paso que abre una grabación con login dentro del Chrome de la computadora del chat (usa la sesión que el usuario inició ahí; tope 60 s) |
| `TRANSCRIBE_URL_CAPTURE` | `1` | `0` desactiva el último recurso: reproducir la grabación en el navegador (computadora del chat o headless) y grabar su audio (`captureStream` + `MediaRecorder`) cuando no hay stream descargable |
| `TRANSCRIBE_URL_CAPTURE_MAX_RATE` | `2` | Velocidad máxima de reproducción al grabar (1–4); el audio se ralentiza con `atempo` para conservar los tiempos |
| `TRANSCRIBE_URL_TOOL_TIMEOUT_MS` | `TRANSCRIBE_URL_TIMEOUT_MS` + 10 min (30 min) | Tope del harness para una llamada a `transcribe_url` (antes heredaba el tope global de 2 min); un turno de chat con enlace + «transcribe» recibe este tope + 5 min |
| `SIRAGPT_COOKIE_JAR_DIR` | `<UPLOAD_DIR>/cookie-jars` | Carpeta de los `cookies.txt` cifrados por usuario (AES-256 con `ENCRYPTION_KEY`) |

**Escalera (added 2026-10-03, segundo paso):** yt-dlp → si no conoce la página («Unsupported URL», 401/403,
fallo genérico) el **Chromium de la imagen abre la página con las cookies del usuario**, pulsa play y registra
el HLS/DASH/MP4 real que pide el reproductor (`media-discovery.js`); esa URL vuelve a yt-dlp con `Referer` y
las cookies del navegador, y si yt-dlp aún la rechaza, **ffmpeg lee el stream directo** con las cabeceras.
Un reproductor que sigue mostrando login sin medios ⇒ `media_login_required` con dos caminos: adjuntar el
archivo o adjuntar UNA vez `cookies.txt` del sitio (`cookie-jar-store.js` lo guarda cifrado por usuario y
lo reutiliza en los próximos enlaces de esa plataforma; solo viajan las cookies del host del enlace).
La imagen instala `yt-dlp[default]` desde PyPI (trae `yt-dlp-ejs`, el solucionador del desafío de YouTube)
y cada llamada usa el Node 22 del backend como runtime JS.

---

### OCR local con GLM-OCR (Ollama de la Lenovo) — `ollama run glm-ocr` (added 2026-10-03)

`backend/src/services/ollama-ocr.js` + `ocr-engine.runOllamaOcrFallback`: GLM-OCR (Z.ai, 0,9B,
nº 1 en OmniDocBench v1.5) servido por la Ollama que ya corre SiraGPT Mini
(`siragpt-ollama:11434`) es el **primer peldaño del OCR por visión**: Tesseract → **GLM-OCR
local** → modelo de visión de pago (OpenAI). Cubre imágenes adjuntas, PDFs escaneados, imágenes
dentro de Office y el camino `vision`. Llamada nativa `POST /api/chat` con el prompt de tarea
del modelo (`Text Recognition:` / `Table Recognition:` / `Figure Recognition:`), imagen reducida
a `OLLAMA_OCR_MAX_SIDE` y salida Markdown (tablas, fórmulas LaTeX). La disponibilidad se sondea
con `GET /api/tags` y se memoiza `OLLAMA_OCR_PROBE_TTL_MS`: sin Ollama o sin el modelo
descargado el motor sigue al peldaño de pago en < 3 s, sin error para el usuario. Proveedor
reportado: `ollama:glm-ocr`. En `NODE_ENV=test` queda apagado salvo `SIRAGPT_OLLAMA_OCR=1`.

**Instalación del modelo: automática.** Si el sondeo ve la Ollama viva pero sin `glm-ocr`, el
backend le pide descargarlo (`POST /api/pull`, una sola vez, en segundo plano, ~1,9 GB) y vuelve a
sondear al terminar — no hace falta shell en la Lenovo ni reiniciar nada; el primer arranque tras
publicar lo deja instalado. Mientras descarga el motor sigue con el modelo de nube
(`reason: model_pulling`). Un pull fallido se reintenta cada `OLLAMA_OCR_PULL_RETRY_MS`.
Alternativa manual: `docker exec siragpt-ollama ollama pull glm-ocr`. Con `OCR_MODE=vision`
GLM-OCR lee directo sin pasar por Tesseract.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_OLLAMA_OCR` | `1` (`0` apaga) | Interruptor del peldaño local |
| `OLLAMA_OCR_BASE_URL` | `http://siragpt-ollama:11434` | Ollama a usar (acepta `…/v1`, se normaliza). Alias: `OLLAMA_BASE_URL` |
| `OLLAMA_OCR_MODEL` | `glm-ocr` | Modelo (p. ej. `glm-ocr:q8_0`, `glm-ocr:bf16`) |
| `OLLAMA_OCR_TASK` | `text` | Prompt de tarea por defecto: `text` / `table` / `figure` |
| `OLLAMA_OCR_TIMEOUT_MS` | `90000` | Tope por imagen/página |
| `OLLAMA_OCR_PROBE_TIMEOUT_MS` | `2500` | Tope del sondeo `/api/tags` |
| `OLLAMA_OCR_PROBE_TTL_MS` | `300000` | Memo del veredicto disponible/no disponible (5 min) |
| `OLLAMA_OCR_MAX_SIDE` | `2048` | Lado máximo (px) de la imagen enviada |
| `OLLAMA_OCR_NUM_PREDICT` | `8192` | Tokens máximos de salida |
| `OLLAMA_OCR_KEEP_ALIVE` | `30m` | Cuánto queda el modelo cargado en Ollama tras una lectura |
| `OLLAMA_OCR_AUTO_PULL` | `1` (`0` apaga) | Descargar el modelo automáticamente cuando falta |
| `OLLAMA_OCR_PULL_TIMEOUT_MS` | `2700000` | Tope de la descarga (45 min) |
| `OLLAMA_OCR_PULL_RETRY_MS` | `1800000` | Espera antes de reintentar un pull fallido (30 min) |

---

## Embeddings ladder (RAG + memory)

`backend/src/services/embedding-provider.js` is the single embedding entry point
for RAG (`rag-service`, operational RAG, GraphRAG) and memory (`user-memory-store`,
`memory-semantic`). It is a failover ladder with the same discipline as the chat
gateway: a provider whose key is rejected (401/403) is memoised and skipped, the
first space that serves a dimension becomes sticky for the process (no mixed
vector spaces in one index), and every result is exactly `targetDim` floats 1:1
with the inputs. When no provider can serve, RAG answers from the lexical BM25
pool (`retrievalMode: bm25_degraded`) instead of failing the turn, memory skips
its semantic pass, and `/api/health` reports the `embeddings` check as degraded.
Design notes: `docs/rag-embeddings.md`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_EMBED_PROVIDER_ORDER` | `openai,gemini,voyage,jina,mistral` | Ladder order (comma list). Rungs without a usable key are skipped. Voyage/Jina/Mistral only serve the 1024-dim memory tables. |
| `SIRAGPT_EMBED_MODEL_OPENAI` | `text-embedding-3-small` | OpenAI embedding model (native 1536; `dimensions` for 1024). |
| `SIRAGPT_EMBED_MODEL_GEMINI` | `gemini-embedding-001` | Gemini model (`outputDimensionality` 1536/1024 + L2 normalisation). Keys: `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_AI_API_KEY`. |
| `SIRAGPT_EMBED_MODEL_VOYAGE` / `_JINA` / `_MISTRAL` | `voyage-3-large` / `jina-embeddings-v3` / `mistral-embed` | 1024-dim memory rungs (`VOYAGE_API_KEY`, `JINA_API_KEY`, `MISTRAL_API_KEY`). |
| `SIRA_EMBED_TIMEOUT_MS` | `30000` | Per-request timeout for every rung. `SIRA_EMBED_MAX_RETRIES` (default `2`) bounds the OpenAI SDK's idempotent retries. |
| `SIRAGPT_KEY_REJECT_MEMO_MS` | `300000` | How long a rejected key is remembered (`backend/src/utils/provider-key-health.js`). A new key (different fingerprint) or an admin "apply connection" re-arms the provider immediately. |
| `SIRAGPT_MEMORY_EMBED_PROVIDER` | `auto` | Memory tables (1024-dim): `auto`/`ladder` use the ladder; `openai`, `gemini`, `voyage`, `jina`, `mistral` pin one rung. |
| `SIRAGPT_MEMORY_LLM_MODEL` | `DeepSeek:deepseek-v4-flash` | Model (`Proveedor:modelo` or an id) for memory-fact extraction and nightly consolidation (`backend/src/services/memory-llm-client.js`, `memory/consolidation.js`). It rides the document-agent failover ladder (DeepSeek → Meta → Gemini → xAI → OpenRouter → OpenAI) with thinking off on DeepSeek V4; `SIRAGPT_DOC_AGENT_MODEL` is not inherited. |
## Memoria estilo Claude Code (vault + consolidación)

Ver `docs/memory-architecture.md`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_MEMORY_GREP_MAX_CHARS` | `24000` | Hasta este tamaño de memoria (chars) `memory_search` es solo grep; por encima se suma el peldaño vectorial. |
| `SIRAGPT_MEMORY_CONSOLIDATION` | on | `0` apaga la consolidación nocturna («dreaming») y el botón «Consolidar ahora». |
| `SIRAGPT_MEMORY_CONSOLIDATION_CRON` | `17 3 * * *` | Horario UTC del job `memory-consolidation` (system-cron). |
| `SIRAGPT_MEMORY_CONSOLIDATION_BATCH` | `50` | Usuarios máximos por pase nocturno. |
| `SIRAGPT_COMPACTION_MEMORY` | on | `0` evita extraer hechos a memoria cuando se compacta el contexto de un chat largo. |

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
| `SIRAGPT_LIVE_LOGS` | Admin → Logs → «Registros en vivo»: capture every backend line (default on; `0` disables the capture entirely) |
| `SIRAGPT_LIVE_LOGS_REDIS` | Persist captured lines to the local Redis (default on; `0` = memory ring only) |
| `SIRAGPT_LIVE_LOGS_MAX_LINES` | Capped Redis stream length for all lines (default 60000 ≈ several hours) |
| `SIRAGPT_LIVE_LOGS_MAX_ERRORS` | Capped Redis stream length for warn+ lines (default 20000) |
| `SIRAGPT_LIVE_LOGS_ERROR_DAYS` | Retention of the warn+ stream in days (default 7) |
| `SIRAGPT_LIVE_LOGS_RING` | In-memory ring size used for the live backfill (default 5000) |
| `SIRAGPT_LIVE_LOGS_REDIS_MAX_MB` | Pause log persistence above this Redis size when `maxmemory` is 0 (default 256); with `maxmemory` set it pauses at 60 % |
| `SIRAGPT_LIVE_LOGS_REDIS_PREFIX` | Redis key prefix (default `siragpt:logs:`) |
| `SIRAGPT_LIVE_LOGS_REQUEST_HOURS` | How long the per-request line index lives (default 12 h; older turns are found by scanning the error stream) |
| `SIRAGPT_GENERATION_LOG` | One `[generation]` line per image/video/speech/music generation (default on outside tests; `0` disables) |

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
| `R2_ENDPOINT` | R2 endpoint override (auto-resolved from ACCOUNT_ID). A self-hosted S3 such as MinIO (`http://siragpt-doc-minio:9000`) is addressed path-style automatically |
| `R2_FORCE_PATH_STYLE` | Document sandbox: `true`/`false` to override the path-style decision (default: path-style for any endpoint that is not `*.r2.cloudflarestorage.com`) |

---

## Business Channels

| Variable | Purpose |
|----------|---------|
| `CHANNEL_CREDENTIALS_KEY` | Preferred dedicated 32-byte key, encoded as 64 hexadecimal characters, for channel credential encryption; legacy installations fall back to `ENCRYPTION_KEY` |
| `CHANNEL_PAIRING_PEPPER` | Dedicated high-entropy HMAC pepper for stable, non-reversible sender pairing codes; required in production |

`CHANNEL_PAIRING_PEPPER` must contain at least 32 characters, be generated
independently, and must not reuse `JWT_SECRET`, `ENCRYPTION_KEY`,
`CHANNEL_CREDENTIALS_KEY`, or another signing key.

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
| `CORS_ORIGINS` | localhost in development; required in production | Comma-separated exact-origin allowlist; wildcard is rejected in production |
| `FRONTEND_URL` | `http://localhost:3000` outside production | Canonical browser origin used for the token-free SAML `303` completion redirect |
| `TRUST_PROXY_HOPS` | `0` | Number of known reverse-proxy hops Express may trust; production Compose pins the single Caddy hop |
| `TRUST_PROXY_CIDR` | (empty) | Alternative comma-separated exact proxy CIDRs; mutually exclusive with `TRUST_PROXY_HOPS` |
| `CSP_ENABLED` | `0` in development, `1` in production | Enable Content-Security-Policy |
| `CSP_REPORT_ONLY` | `1` | CSP report-only mode |
| `JWT_SECRET` | required | JWT signing secret |
| `SIRAGPT_MCP_ALLOWED_HOSTS` | empty (MCP deny-all in production) | Global comma-separated hostname ceiling for user-registered external MCP servers |
| `SIRAGPT_MCP_ALLOW_HTTP` | `0` | Outside production only, permits HTTP for loopback MCP endpoints when explicitly set to `1` |
| `SESSION_TOKEN_HASH_MODE` | `compat` in production/staging; `hash` elsewhere | Two-phase session persistence mode. `compat` reads raw/hash but writes raw and never upgrades; `hash` writes hashes and atomically upgrades legacy rows |
| `SESSION_TOKEN_HASH_COMPAT_DRAINED` | `0` | Must be `1` before production may start in `hash` mode, confirming all compat/legacy replicas are drained |
| `SESSION_TOKEN_HASH_BACKFILL_BATCH_SIZE` | `100` | Maximum raw session rows converted in one hash-activation transaction (1–1000) |
| `SESSION_TOKEN_HASH_BACKFILL_MAX_BATCHES` | `10` | Maximum transactions per readiness pass (1–100); later probes continue until no raw rows remain |
| `AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO` | `0.8` | Production readiness ceiling for Redis used/max memory after Lua and `noeviction` checks |
| `AUTH_SECURITY_READY_RETRY_BASE_MS` | `250` | Initial auth-security readiness retry delay after Redis/backfill failure (10–60000 ms) |
| `AUTH_SECURITY_READY_RETRY_MAX_MS` | `5000` | Maximum exponential readiness retry delay (10–60000 ms; never below the base) |
| `OAUTH_STATE_TTL` | `10m` | Signed OAuth state lifetime, clamped to 1–15 minutes; the Redis entry uses the same effective expiry |
| `OAUTH_STATE_RETRY_AFTER_SECONDS` | `5` | Bounded `Retry-After` for fail-closed OAuth state-store outages |
| `OAUTH_STATE_CACHE_MAX_ENTRIES` | `10000` | Maximum live OAuth states in Redis or the non-production memory fallback |
| `OAUTH_STATE_REDIS_CONNECT_TIMEOUT_MS` | `500` | Redis connection deadline for OAuth state (10–2000 ms) |
| `OAUTH_STATE_REDIS_COMMAND_TIMEOUT_MS` | `500` | ioredis and wrapper deadline for each OAuth state command (10–2000 ms) |
| `OAUTH_STATE_REDIS_PREFIX` | `sira:oauth-state:` | Dedicated Redis namespace; state JTIs are SHA-256 keyed |
| `IMPERSONATION_TARGET_LIMIT` | `3` | Attempts in one admin+target sliding window |
| `IMPERSONATION_ADMIN_LIMIT` | `10` | Attempts in the global per-admin sliding window |
| `IMPERSONATION_WINDOW_MS` | `3600000` | Impersonation sliding-window duration (1 second–24 hours) |
| `IMPERSONATION_MEMORY_MAX_KEYS` | `10000` | Maximum local limiter keys outside production |
| `IMPERSONATION_REDIS_CONNECT_TIMEOUT_MS` | `500` | Redis connection deadline for impersonation limiting (10–2000 ms) |
| `IMPERSONATION_REDIS_COMMAND_TIMEOUT_MS` | `500` | ioredis and wrapper deadline for atomic limiter commands (10–2000 ms) |
| `IMPERSONATION_REDIS_PREFIX` | `sira:impersonation:` | Dedicated Redis namespace; admin identifiers are SHA-256 keyed |
| `IMPERSONATION_STORE_RETRY_AFTER_SECONDS` | `5` | Bounded `Retry-After` for fail-closed limiter-store outages (1–300 seconds) |
| `GOOGLE_AUTH_BASE_URL` | backend origin | Canonical public backend origin used to build provider callbacks; HTTPS and non-localhost in production |
| `GOOGLE_AUTH_URI` | derived | Google login callback URL |
| `GOOGLE_REDIRECT_URI` | derived | Gmail callback URL |
| `GOOGLE_REDIRECT_CALENDAR_DRIVE_URI` | derived | Google Calendar/Drive callback URL |
| `OAUTH_POST_CALLBACK_ALLOWED_ORIGINS` | unset | Optional comma-separated exact HTTPS origins for intentional post-OAuth browser handoffs; production also trusts configured frontend origins; capped at 10 entries and 2048 characters |
| `GITHUB_OAUTH_REDIRECT_URI` | derived | GitHub callback URL |
| `GITHUB_OAUTH_SUCCESS_REDIRECT` | `<FRONTEND_URL>/settings` | GitHub post-callback destination |
| `SPOTIFY_REDIRECT_URI` | derived | Spotify callback URL |
| `SPOTIFY_OAUTH_SUCCESS_REDIRECT` | `<FRONTEND_URL>/chat` | Spotify success destination |
| `SPOTIFY_OAUTH_FAILURE_REDIRECT` | `<FRONTEND_URL>/connections` | Spotify failure destination |
| `SAML_REQUEST_TTL_MS` | `300000` | Lifetime for SP-initiated AuthnRequest IDs and RelayState (clamped to 1–15 minutes) |
| `SAML_REQUEST_CACHE_MAX_ENTRIES` | `5000` | Maximum live SAML request/state entries in the bounded cache |
| `SAML_REDIS_CONNECT_TIMEOUT_MS` | `500` | Redis connection deadline for SAML request state (10–2000 ms) |
| `SAML_REDIS_COMMAND_TIMEOUT_MS` | `500` | ioredis and wrapper deadline for every SAML cache command (10–2000 ms) |
| `SAML_REDIS_RETRY_BASE_MS` | `100` | Initial SAML Redis initialization retry delay (10–5000 ms) |
| `SAML_REDIS_RETRY_MAX_MS` | `5000` | Maximum exponential-backoff delay for SAML Redis initialization (10–60000 ms) |
| `SAML_REDIS_PREFIX` | `sira:saml:` | Dedicated Redis namespace for SAML request/state keys |
| `SAML_RELAY_STATE_SECRET` | (derived from `JWT_SECRET`) | Optional dedicated HMAC secret for signed RelayState |
| `SAML_ACS_BODY_LIMIT_BYTES` | `262144` | Exact ACS URL-encoded body limit, clamped to 64–512 KiB |
| `SAML_ACS_RATE_LIMIT_MAX` | `30` | Maximum exact ACS POST attempts per normalized IP bucket/window |
| `SAML_ACS_RATE_LIMIT_WINDOW_MS` | `60000` | Exact ACS distributed limiter window (1 second–15 minutes) |

External MCP registrations require HTTPS in production. The global
`SIRAGPT_MCP_ALLOWED_HOSTS` policy accepts normalized exact hosts and safe
leading-* subdomain patterns such as `*.tools.example.com`; a wildcard never
matches its apex, and wildcards over a public suffix such as `*.com` or
`*.co.uk` are rejected. IP literals, userinfo, private/reserved destinations,
and unsafe non-default HTTPS ports are rejected. Optional
`User.settings.mcpAllowedHosts` and
`Organization.settings.mcpAllowedHosts` lists intersect the global policy and
can only restrict it. Organization restrictions apply only when the agent turn
has an explicit, membership-verified active organization; personal chats use
the global and user layers only. A missing production global allowlist activates
MCP deny-all and reports a degraded MCP health status without preventing the
rest of the backend from starting. HTTP is available only for loopback during
non-production development with `SIRAGPT_MCP_ALLOW_HTTP=1`.

Cookie-authenticated state-changing requests under `/api/*` use the CSRF
double-submit guard. Safe methods and Bearer/API-key clients bypass it. The
Stripe webhook is exempt only at the exact signed webhook path. A standard
`SAMLResponse` POST bypasses Sira CSRF only at the exact
`/api/auth/sso/:orgSlug/callback` assertion-consumer path; SAML signature and
InResponseTo/replay validation still run. Public generated-app mounts
(`/api/apps-ai`, `/api/apps-kv`) remain cookieless. Production requires a
valid explicit `CORS_ORIGINS`, rejects wildcards and enabled `CSRF_DISABLED`,
and requires cookie-auth mutations to send a trusted Origin plus
`Sec-Fetch-Site: same-origin|same-site`.

SP-initiated SAML starts at `GET /api/auth/sso/:orgSlug/login`, where
`@node-saml/node-saml` generates an AuthnRequest and redirects to the IdP.
Each request uses `validateInResponseTo: 'always'`, a short-lived request ID,
and signed one-time RelayState bound to the organization and request. The ACS
also verifies exact Destination and configured Audience before provisioning.
In production, Redis is mandatory for this state and an unavailable store
fails closed with `503`, `Cache-Control: no-store`, and `Retry-After`; bounded
memory fallback exists only outside production. A bounded exponential-backoff
Redis circuit remains fail-closed per attempt and recovers on a later request
without a process restart.

RelayState is also bound to the initiating browser by a high-entropy pre-auth
nonce cookie. It is `HttpOnly`, narrowly scoped to that organization's ACS,
and uses `SameSite=None` (`Secure` in production) for the cross-site SAML POST.
Redis stores only the nonce's SHA-256 hash. The ACS atomically compares and
consumes the hash and clears the cookie, so another browser cannot complete or
burn the initiating browser's login.

On success the form ACS sets the normal session cookie, issues the existing
CSRF cookie pair, and sends a `303` to the `/auth/callback` path on the
validated origin of `FRONTEND_URL`, without a JWT in the URL or response body.
Trusted API/test callers may request JSON only with both
`Accept: application/json` and `X-Sira-Response-Mode: json`; that response also
omits the JWT. IdP CORS is not required:
the exact URL-encoded ACS POST bypasses credentialed app CORS and emits no
credentialed CORS headers, while OIDC GET and all sibling auth routes keep
the normal allowlist. A dedicated fail-closed ACS rate limiter runs before its
bounded body parser and request telemetry; production Redis outages return
`503`, exhausted buckets return `429`, and oversized bodies return `413`.

---

## Rate Limiting

| Variable | Default | Purpose |
|----------|---------|---------|
| `RATE_LIMIT_AUTH_MAX` | `30` | Max auth requests per window |
| `RATE_LIMIT_EXPENSIVE_MAX` | `180` | Max expensive (LLM) requests per window |
| `RATE_LIMIT_API_MAX` | `3000` | Max general API requests per window |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | Rate limit window duration |
| `RATE_LIMIT_STORE` | `auto` (`redis` in Compose) | General store selection: `auto`, `redis`, or `memory` |
| `RATE_LIMIT_REDIS_PREFIX` | `rl:` | Redis key prefix for rate limit counters |
| `RATE_LIMIT_SENSITIVE_POLICY` | `distributed` in production | Sensitive auth/API-key/billing policy: `distributed`, `memory`, or `fail-open`; production accepts only `distributed` |
| `RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS` | `1000` | Per-command/pipeline ioredis and outer wrapper timeout (10–30000 ms) |
| `RATE_LIMIT_STORE_RETRY_AFTER_SECONDS` | `5` | `Retry-After` for fail-closed 503 responses (1–300 seconds) |
| `RATE_LIMIT_BILLING_CHECKOUT_MAX` | `10` | Checkout attempts per user |
| `RATE_LIMIT_BILLING_CHECKOUT_IP_MAX` | `100` | Checkout attempts per normalized shared IP |
| `RATE_LIMIT_BILLING_VERIFY_MAX` | `20` | Checkout verification attempts per user |
| `RATE_LIMIT_BILLING_VERIFY_IP_MAX` | `200` | Verification attempts per normalized shared IP |
| `RATE_LIMIT_BILLING_PLAN_CHANGE_MAX` | `5` | Plan/subscription mutations per user |
| `RATE_LIMIT_BILLING_PLAN_CHANGE_IP_MAX` | `50` | Plan/subscription mutations per normalized shared IP |
| `RATE_LIMIT_BILLING_WINDOW_MS` | `900000` | Checkout and verification window |
| `RATE_LIMIT_BILLING_PLAN_WINDOW_MS` | `3600000` | Plan/subscription mutation window |
| `RATE_LIMIT_BILLING_REFUND_MAX` | `5` | Admin grant/refund attempts per admin |
| `RATE_LIMIT_BILLING_REFUND_IP_MAX` | `50` | Admin grant/refund attempts per normalized shared IP |
| `RATE_LIMIT_BILLING_REFUND_WINDOW_MS` | `3600000` | Admin refund window |
| `SIRAGPT_API_KEY_AUDIT_COUNTER_MAX` | `10000` | Maximum in-process API-key audit-sampling counters |

Billing atomically consumes its user and IP dimensions, with a higher IP
ceiling for offices and carrier NAT. IPv6 addresses are grouped by `/64`;
IPv4 is canonicalized from Express `req.ip`/the socket only, never raw
`X-Forwarded-For`. Production startup rejects a missing Redis URL,
process-memory sensitive limiting, and `memory`/`fail-open` sensitive
policies. The general catch-all API limiter remains fail-open on store errors
so a Redis incident does not brick unrelated API reads.

---

## Database / Session

| Variable | Purpose |
|----------|---------|
| `PRISMA_DATABASE_URL` | Runtime Prisma datasource; direct PostgreSQL or remote `prisma+postgres:` |
| `DIRECT_DATABASE_URL` | Direct PostgreSQL datasource for migrations, pg preflight, and advisory locking |
| `DATABASE_URL` | Legacy runtime fallback and direct-migration candidate |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | PostgreSQL TLS certificate verification; defaults to `true`, disabled only by explicit `false` |
| `DATABASE_SSL_CA` | Optional inline PEM CA or CA file path; overrides URL `sslrootcert` and is never logged |
| `DATABASE_SSL_CERT` | Optional inline PEM client certificate or file path; overrides URL `sslcert` and is never logged |
| `DATABASE_SSL_KEY` | Optional inline PEM client private key or file path; overrides URL `sslkey` and is never logged |
| `POSTGRES_HOST` | Host used for the POSTGRES-only local compatibility fallback |
| `POSTGRES_PORT` | Port used for the POSTGRES-only local compatibility fallback (default `5432`) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials and database used by the POSTGRES-only fallback |
| `MIGRATION_COMMAND_TIMEOUT_MS` | Per-Prisma-child hard deadline (default `300000`) |
| `BOOT_COMMAND_TIMEOUT_MS` | Auxiliary boot-command deadline, including `fuser` cleanup (default `5000`) |
| `MIGRATION_DB_CONNECT_TIMEOUT_MS` | Boot `pg` connection timeout (default `10000`) |
| `MIGRATION_DB_QUERY_TIMEOUT_MS` | Boot `pg` query timeout (default `15000`) |
| `MIGRATION_DB_STATEMENT_TIMEOUT_MS` | Boot PostgreSQL statement timeout (default `15000`) |
| `MIGRATION_LOCK_TIMEOUT_MS` | Total lock deadline including connect/query (default `120000`) |
| `MIGRATION_BASELINE_CONFIRM` | Exact confirm phrase for reviewed U0 one-off `scripts/baseline-migration-history.js` (`I_REVIEWED_PRODUCTION_SCHEMA`); never read by boot/`--migrate-only` |
| `MIGRATION_BASELINE_DRY_RUN` | Inventory + equivalence check only for the U0 baseline script (default `0`) |
| `SKIP_MIGRATIONS` | Skip migrations during normal local boot only; rejected by `--migrate-only` (default `0`) |
| `MIGRATION_NONFATAL` | Explicit degraded policy for normal boot only; `--migrate-only` remains strict |
| `DATABASE_POOL_MIN` | Instrumentation lower bound (default `2`, capped by max) |
| `DATABASE_POOL_MAX` | Prisma v6 `connection_limit` (default `10`, clamp `1..100`) |
| `DATABASE_POOL_TIMEOUT_MS` | Prisma acquire timeout in ms (default `10000`, clamp `1000..300000`, rounded up to `pool_timeout` seconds) |
| `DATABASE_POOL_AUTOSCALE_ENABLED` | Enable advisory-only pool recommendations; never resizes live Prisma |
| `DATABASE_POOL_AUTOSCALE_INTERVAL_MS` | Recommendation sampling interval (default `30000`, clamp `1000..3600000`) |
| `DATABASE_POOL_AUTOSCALE_MIN` | Advisory recommendation floor (default `2`, clamp `1..100`) |
| `DATABASE_POOL_AUTOSCALE_MAX` | Advisory recommendation ceiling (default `50`, clamp `1..100` and never below min) |
| `DATABASE_POOL_AUTOSCALE_COLD_SAMPLES` | Consecutive cold samples before advisory scale-down (default `3`, clamp `1..20`) |
| `REDIS_URL` | Redis connection string (sessions, queues, rate limits, cache) |
| `SESSION_SECRET` | Express session signing secret |

Local pool URL controls and estimated capacity telemetry apply only to direct
`postgres:`/`postgresql:` datasources. `prisma+postgres:` remote/Accelerate
URLs are not rewritten and expose capacity as unobservable, so local pool
estimates and recommendations are omitted.

Runtime resolution prefers `PRISMA_DATABASE_URL` and uses `DATABASE_URL` only
as fallback. Direct migration resolution prefers `DIRECT_DATABASE_URL`, then a
direct `DATABASE_URL`, then a direct `PRISMA_DATABASE_URL`. A remote runtime and
different direct migration URL are valid; conflicting aliases for one role
fail closed without logging values. Remote-only migration startup exits with
`DIRECT_DATABASE_URL_REQUIRED` instead of copying the remote URL.

When all three URL roles are empty, the pure resolver may synthesize one local
runtime/direct URL from `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB`. Any explicit URL disables synthesis:
a direct `PRISMA_DATABASE_URL` remains the migration fallback, while a remote
`PRISMA_DATABASE_URL` without a direct URL fails closed.

Boot-time PostgreSQL connections map URL `sslrootcert`/`sslcert`/`sslkey` to
an explicit `pg` `ssl.ca`/`cert`/`key` object, then strip URL-level SSL
controls so they cannot override it. `DATABASE_SSL_CA`, `DATABASE_SSL_CERT`,
and `DATABASE_SSL_KEY` take precedence per field. Each accepts inline PEM or a
regular PEM file up to 1 MiB; certificate and key must be paired. Unusable URL
material fails with a stable value-free code, and contents/paths are never
logged. Insecure or conflicting URL modes fail closed unless
`DATABASE_SSL_REJECT_UNAUTHORIZED=false` is explicit.

P3005 never auto-baselines from boot or `--migrate-only` and never invokes
`prisma migrate resolve` on those paths. After U0, unbaselined databases fail
closed with `MIGRATION_HISTORY_BASELINE_REQUIRED`. The reviewed one-off
`scripts/baseline-migration-history.js` (via `deploy-production-baseline-*`)
proves schema equivalence and marks existing directories applied without
replaying DDL — do this before schema-bearing units. Release `--migrate-only`
fails non-zero on preflight, lock, migration, release, or `SKIP_MIGRATIONS=1`;
only normal local boot may skip or use `MIGRATION_NONFATAL=1`.

---

## Payments (Stripe) + sales WhatsApp

`/planes` sells exactly two plans: **Pro** ($10 USD/mes, backend plan code
`PRO_MAX`, Stripe Checkout) and **Hablemos** (WhatsApp). The page reads
`GET /api/payments/config` at runtime, so enabling sales in production only
needs the backend `.env` — no frontend rebuild.

| Variable | Required | Purpose |
|----------|----------|---------|
| `STRIPE_SECRET_KEY` | yes (to sell) | `sk_live_…` / `sk_test_…`. Without it checkout answers 503 and `/planes` degrades to WhatsApp activation. |
| `STRIPE_WEBHOOK_SECRET` | recommended | Signs `POST /api/payments/stripe/webhook` (renewals, cancellations, failed invoices). The first purchase is fulfilled by `POST /api/payments/verify-session` even without it. |
| `STRIPE_PRICE_PRO_MAX` | no | Override the Stripe price id. If absent the backend **auto-provisions** the product + $10/month price on the first checkout (`stripe-setup.getPriceIdForPlan` → `stripeService.ensurePriceForPlan`, idempotent by `metadata.plan`) and caches it in `systemSettings`. |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` | no | Same override for the legacy $5 tier and the contact-only tier. |
| `SIRAGPT_WHATSAPP_NUMBER` | yes (Hablemos) | Sales number, digits with country code (`51999123456`). Served by `GET /api/payments/config`; wins over the build-time value. |
| `NEXT_PUBLIC_WHATSAPP_NUMBER` | no | Build-time fallback baked into the Next.js bundle (landing pricing, sidebar WhatsApp button). |
| `FRONTEND_URL` | yes | Base for Stripe `success_url` / `cancel_url` (`/payment/success`, `/payment/cancel`). Must be `https://siragpt.com` in production. |
| `ALLOW_STRIPE_DEMO` | dev only | `true` + `NODE_ENV!=production` simulates paid sessions without keys. Never in production. |

## General

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `5000` | Express backend port |
| `NODE_ENV` | `development` | Environment: `development`, literal `production`, or `test`; the `prod` alias is rejected at startup |
| `SIRAGPT_RESEARCH_EMAIL` | — | Email for polite User-Agent in scientific search |
| `IDEMPOTENCY_ENABLED` | `false` | Enable Stripe-style replay protection |
| `MAINTENANCE_MODE_ENABLED` | `false` | Enable 503 maintenance mode |
| `SMTP_FROM_NAME` | `SiraGPT` | Sender display name of every outgoing mail (`backend/src/services/email.js`; quotes are dropped). The address stays `SMTP_USER` |
| `SLACK_ENCRYPTION_KEY` | optional | 32-byte key (hex or base64) for saved Slack webhooks. Now optional: without it `SIRAGPT_ENCRYPTION_KEY` is used, else a stable HKDF subkey of the mandatory `ENCRYPTION_KEY`. Only a production server with none of the three answers `503 slack_encryption_unconfigured`; a webhook saved under an old random key must be pasted again once (`409 slack_reconnect_required`) |

## RLHF flywheel

Collects thumbs + regenerates into `preference_events`, fits an in-process Bradley-Terry reward model, and exports SFT/DPO JSONL. Phase 2 injects a compact few-shot block from those preferences at generate time. See `docs/rlhf-flywheel.md`, `docs/rlhf-phase2-steering.md`, and `docs/rlhf-phase3-feedback-rlaif.md`. Prisma persist is fail-open (in-memory only when the client is not ready). Best-of-N at generation time stays **off** unless explicitly enabled. RLAIF stays **off** unless explicitly enabled.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_RLHF_ENABLED` | on | `0` / `false` / `off` stops collecting preference events |
| `SIRAGPT_RLHF_STEERING` | on | `0` / `false` / `off` skips few-shot preference injection at generate time |
| `SIRAGPT_RLCD_ENABLED` | on | RLCD ledger (#722): registra decisiones tipadas (`intent_triage` / `execution_lane` / `model_route` / `compute_mode`) y une resultados. `0` / `false` / `off` apaga el ledger. See `docs/rlcd.md` |
| `SIRAGPT_RLCD_LANE_STEERING` | on | RLCD ledger: la probabilidad calibrada puede forzar el bucle agéntico en turnos de código |
| `SIRAGPT_RLCD_LANE_THRESHOLD` | 0.6 | RLCD ledger: umbral de probabilidad calibrada para forzar el carril agéntico |
| `SIRAGPT_RLHF_STEERING_MAX_CHARS` | 1800 | Size cap for the injected preference block |
| `SIRAGPT_RLHF_BEST_OF_N` | off | `1` / `true` / `on` enables inference-time best-of-N (multiplies token cost). Leave off in production |
| `SIRAGPT_RLHF_RLAIF` | off | `1` / `true` / `on` allows synthetic HHH labels; abstains on mid scores. Leave off in production |
| `SIRAGPT_RLHF_RLAIF_MAX_PER_USER` | 8 | Cap of synthetic rows per user per window |
| `SIRAGPT_RLHF_RLAIF_WINDOW_MS` | 3600000 | RLAIF rate-limit window (milliseconds) |
| `SIRAGPT_RLHF_AUTO_TRAIN` | on | `0` disables the cooldown retrainer after new labels. Local Bradley-Terry RM only — never enqueues a phase-3 job |
| `SIRAGPT_RLHF_TRAIN_JOBS` | off | `1` / `true` / `on` enables admin SFT/DPO prep jobs (`POST /api/rlhf/jobs`). Leave off in production until an admin wants a JSONL artifact |
| `SIRAGPT_RLHF_TRAIN_SUBMIT` | off | Optional submit after prep. No-op today (no in-repo catalog fine-tune adapter). Do not treat this as a paid auto-train switch |
| `SIRAGPT_RLHF_TRAIN_JOB_CONCURRENCY` | 1 | In-process prep workers (capped at 4) |
| `SYSTEM_CRON_RLHF_SCHEDULE` | `0 8 * * *` | Daily backfill of Message.feedback + local RM train (UTC) |
| `SIRAGPT_RLCD_DOCUMENTS` | **off** | Document-analysis RLCD (#721 + phase 2 + phase 3): confidence trailer, evidence blend (extract/RAG scores/page cites), claim labels, Spanish defer, Brier/ECE on document thumbs. Independent of `SIRAGPT_RLCD_ENABLED`. `1` / `true` / `on` enables. Code default stays off (prod `.env` may already be on — do not change it from this PR). See `docs/rlhf-rlcd-documents.md` |
| `SIRAGPT_RLCD_DEFER_THRESHOLD` | `0.45` | Document RLCD: defer when predicted confidence is below this (0.05–0.95) |
| `SIRAGPT_RLCD_MAX_DEFER_RATE` | `0.25` | Document RLCD: cap of document turns that may defer in this process (0–1) |
| `SIRAGPT_RLCD_PROMPT` | on (if documents on) | `0` / `off` skips the hidden confidence-trailer contract |
| `SIRAGPT_RLCD_PHRASE` | on (if documents on) | `0` / `off` skips the compact Spanish “Confianza baja/media” line |
| `SIRAGPT_RLCD_AUTO_THRESHOLD` | **off** | Document RLCD: apply the ECE-suggested defer threshold when there are enough labeled outcomes. Leave off unless an operator is watching `/api/rlcd/stats` → `documents` |
| `SIRAGPT_RLCD_AUTO_THRESHOLD_MIN_N` | `20` | Minimum labeled document outcomes before auto-threshold is usable |

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

---

## Edición milimétrica de Office (AgentRunner)

Motor `sira_office.py` en el sandbox + tools `inspect_document` / `office_edit` /
`render_preview` v2 / `verify_visual`, revisión con visión, gate de
verificación v2, timeline con miniaturas. Spec:
`docs/specs/edicion-milimetrica/SPEC.md`. Métricas F.2 en `/metrics`
(`office_verify_total`, `office_verify_attempts_per_turn`,
`office_pagination_changed_total`, `office_vision_disagreement_total`,
`office_tool_latency_ms`) + una línea `[office-edit]` por turno. Evals de los 10
escenarios contra la ruta real: `node scripts/run-office-evals.js --user <id>
--fixtures <dir>` (dentro del contenedor del backend).

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_OFFICE_ENGINE` | `1` | `0` = comportamiento previo a la Fase B: sin tools de oficina, render v1, gate de verificación anterior |
| `SIRAGPT_OFFICE_ENGINE_TIMEOUT_MS` | `170000` | Tope por llamada al motor (mín. 10 s, máx. 600 s) |
| `SIRAGPT_VISUAL_VERIFY_VISION` | `1` (off en `NODE_ENV=test`) | Revisión del antes/después con un modelo de visión |
| `SIRAGPT_VISION_VERIFY_MODEL` | escalera | Fuerza el modelo de visión (`Proveedor:modelo` o id). Sin él: el modelo elegido si ve imágenes → `deepseek-flash` → `grok-4.6` → `gemini-3.5-flash` / `gemini-3-flash-preview` → `gpt-5.6-sol`; un 400/404/415/422 degrada 6 h |
| `SIRAGPT_DEEPSEEK_VISION_MODEL` / `SIRAGPT_XAI_VISION_MODEL` / `SIRAGPT_GEMINI_VISION_MODEL` / `SIRAGPT_OPENAI_VISION_MODEL` | ver arriba | Modelo de visión por proveedor en la escalera |
| `SIRAGPT_AGENT_VISION_IN_LOOP` | `0` | `1` adjunta las imágenes al loop (solo si el modelo del loop tiene visión); se conservan las 2 últimas |
| `SIRAGPT_AGENT_THUMBS` | `1` (off en `NODE_ENV=test`) | Miniaturas (≤2 por paso, ≤80 KB) en el SSE del timeline |
| `SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS` | `60000` | Presupuesto de compactación del loop (8000–120000); el pedido y el último mapa del documento se restauran tras compactar |
| `SIRAGPT_AGENT_RUNNER_MAX_TOKENS` | `8192` en turnos de documentos | Salida por llamada al modelo |
| `SIRAGPT_AGENT_RUNNER_TRUNCATION_MAX_TOKENS` | `16384` | Techo del reintento cuando el modelo corta una llamada a herramienta por `max_tokens`: min(2× el presupuesto, el techo de salida del modelo, este valor). Con 8192 (el techo de la mayoría de los modelos del catálogo) solo aplica el aviso de dividir el trabajo |
| `SIRAGPT_DOC_AGENT_SDK_MAX_RETRIES` | `1` | Reintentos del SDK por llamada del AgentRunner / memoria / traducción (`doc-agent/llm-runtime.js`, máx. 5). El loop ya reintenta por su cuenta; `0` evita que un 429 sin saldo llegue dos veces al proveedor |
| `SIRAGPT_DOC_AGENT_LLM_TIMEOUT_MS` | `180000` | Tope por llamada al modelo del AgentRunner (mín. 1000); cabe una respuesta de documento de 8192 tokens |
| `SIRAGPT_DOCUMENT_EDITOR_ENGINE` | `office` | Editor del chat (`/api/ai/document-edit`): Excel / PowerPoint / PDF en el loop de oficina del AgentRunner; `legacy` = loop anterior del sandbox |
| `SIRAGPT_DOCUMENT_EDITOR_VISUAL_VERIFY` | `1` (off en `NODE_ENV=test`) | Verificación visual (sira_office + visión) en el `finish` del docx-engine de Word |
| `DOC_SANDBOX_QUEUE_WAIT_MS` | `90000` | Espera máxima en cola cuando el servicio de sandbox responde `429 at_capacity` (sondeo cada 2–5 s, checkpoint «Esperando un sandbox libre…»). Agotada la espera el turno falla como `sandbox_capacity` (categoría `capacity`, reintentable, «Cancelado por el sistema» en Admin → Logs). `0` = fallar al primer 429 |
| `SANDBOX_CREATE_TIMEOUT_MS` | `60000` | Tope por intento de `POST /v1/sessions` (arranque del contenedor). Cada intento tiene su propio presupuesto: la espera en cola no consume el tiempo del comando. `DOC_SANDBOX_CONCURRENCY` es la concurrencia del worker BullMQ del módulo `doc-sandbox` (TS), no la del AgentRunner; el límite real de contenedores vive en `SANDBOX_MAX_CONCURRENCY` del servicio `siragpt-sandbox` |

## Transcripción de audio (escalera)

`backend/src/services/audio-transcriber.js`. Orden por defecto: OpenAI → Groq →
xAI → (Meta solo opt-in) → Whisper local (`whisper.cpp`, sin clave). Un
proveedor que rechaza la clave (401/403) o no tiene saldo (402 / 429 de
facturación) se salta durante `TRANSCRIBE_PROVIDER_COOLDOWN_MS`; la línea final
del log resume la escalera (`providers tried: openai(429 billing) groq(ok)
local(model not readable by uid 100 …)`). Al arrancar, el backend registra un
WARN `[local-whisper] unavailable: <motivo>` si el motor local no puede correr
(binario, modelo, permisos del modelo, ffmpeg).

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRANSCRIBE_PROVIDERS` | `openai,groq,xai,meta,local` | Orden de la escalera (`voicestudio` opcional; listar `meta` aquí también la habilita) |
| `GROQ_API_KEY` | — | Activa el peldaño Groq (`/openai/v1/audio/transcriptions`) |
| `GROQ_TRANSCRIBE_MODEL` | `whisper-large-v3-turbo` | Modelo STT de Groq |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Base OpenAI-compatible de Groq |
| `TRANSCRIBE_GROQ_DISABLED` | off | `1` desactiva Groq sin quitar la clave |
| `SIRAGPT_META_TRANSCRIPTION` | off | `1` habilita Meta (su API no tiene STT: respondía 404); sin la bandera se salta y se registra a nivel debug |
| `TRANSCRIBE_PROVIDER_COOLDOWN_MS` | `1800000` (30 min) | Memoria de clave rechazada / sin saldo por proveedor (reusa `utils/provider-key-health`) |
| `WHISPER_CPP_BIN` / `WHISPER_CPP_MODEL` | `/usr/local/bin/whisper-cli` / `/usr/local/share/whisper/ggml-base.bin` | Motor local; el modelo debe ser legible por `appuser` (uid 100): la imagen lo deja en `0644` |

## Chat attachments — any format (optional)

Every file type is accepted in the `/agentes` composer. Defaults need no configuration.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_FILE_SIZE` / `UPLOAD_MAX_FILE_MB` | `1024` | Per-file cap in MB for documents and every non-media format (chunked upload above 80 MB) |
| `NEXT_PUBLIC_COMPOSER_MAX_FILE_MB` | `1024` | Same cap enforced by the composer before uploading (build-time) |
| `MAX_MEDIA_FILE_MB` / `NEXT_PUBLIC_COMPOSER_MAX_MEDIA_MB` | `10240` | Audio/video cap (see PR #785) |
| `SIRAGPT_MEMORY_SAFE_MAX_BYTES` | `157286400` | Above this size only streaming readers run (PDF, media, archives, capped text); other formats are stored and described by name/type/size |
| `UNIVERSAL_EXTRACT_MAX_CHARS` | `2097152` | Text cap for long-tail formats (iWork, WordPerfect, Visio, 7z/tar, .msg/.eml/.mbox, MOBI) |
| `UNIVERSAL_ARCHIVE_MEMBER_MAX_BYTES` | `1048576` | Bytes read per archive member (piped to stdout, never unpacked to disk) |
| `UNIVERSAL_ARCHIVE_MAX_MEMBERS_READ` | `60` | Readable archive members whose text is included |
| `UNIVERSAL_ARCHIVE_MAX_LISTED` | `500` | Archive entries listed in the inventory |
| `UNIVERSAL_ARCHIVE_MAX_UNPACKED_BYTES` | `2147483648` | Above this declared unpacked size only the index is shown |
| `UNIVERSAL_EXTRACT_TIMEOUT_MS` | `90000` | Per-command timeout (LibreOffice gets at least 120 s) |

## Turn failure tracker — Admin → Logs → «Fallos de respuesta» (optional)

One `AuditLog` row (`action = turn_failed`) per user question the platform failed:
error shown, no answer, hang, turn never finalized, lost attachment, failed tool,
unusable answer (leaked markup, echo, claimed file not delivered…) or thumbs-down.
Normal turns write nothing. All defaults are safe for production.

| Variable | Default | Purpose |
|---|---|---|
| `SIRAGPT_TURN_FAILURES` | on (off under `NODE_ENV=test`) | `0` disables recording and the non-2xx middleware |
| `SIRAGPT_TURN_PROGRESS` | on | Live progress of a chat turn (`backend/src/services/turn-progress.js`): begin / progress / result rows paired by `stageId` for clients that send `progressProtocol: 2`, with real facts (files, counts, sources, model display name, attempt n of m, wait seconds). `0` / `false` / `off` keeps only the legacy begin-only `stage` frames |
| `SIRAGPT_TURN_FAILURE_RETENTION_DAYS` | `30` | Rows older than this are deleted by the `sweep-turn-failures` cron (they carry prompt excerpts) |
| `SIRAGPT_TURN_FAILURE_RATE_LIMIT` | `30` | Max new rows per identical cause per minute (floods are counted, not stored) |
| `SIRAGPT_TURN_SIN_CIERRE_MS` | `600000` | A turn with no activity and no finalize for this long is recorded as «Turno sin cerrar» |
| `SYSTEM_CRON_TURN_FAILURE_SWEEP_SCHEDULE` | `50 4 * * *` | Retention sweep schedule (UTC) |

### Errores del sistema (Admin → Logs → «Errores del sistema»)

Backend / frontend errors of siragpt.com grouped into issues by fingerprint
(`backend/src/services/observability/system-errors/`, AuditLog rows
`system_issue`, `system_issue_alert`, `system_issue_status`; no migration).
Captures `console.error` (and provider/Redis/Prisma/queue `console.warn`),
uncaught exceptions, unhandled rejections, Express 5xx and `/api/telemetry/error`.

| Variable | Default | Purpose |
|---|---|---|
| `SIRAGPT_SYSTEM_ERRORS` | on (off under `NODE_ENV=test`) | `0` disables capture (the page then stays empty) |
| `SIRAGPT_SYSTEM_ERRORS_FLUSH_MS` | `5000` | How often captured events are grouped and written |
| `SIRAGPT_SYSTEM_ISSUE_RETENTION_DAYS` | `30` | Issues silent for this long are deleted by the `sweep-turn-failures` cron; alert rows after 7 days |
| `SIRAGPT_ENVIRONMENT` | `NODE_ENV` | Environment label stored on every sample |

### Stale-run watchdog (`backend/src/jobs/stale-run-watchdog.js`)

| Variable | Default | Purpose |
|---|---|---|
| `STALE_RUN_WATCHDOG_DISABLED` | off | `1` turns the scan off |
| `STALE_RUN_WARN_MINUTES` / `STALE_RUN_CRITICAL_MINUTES` | `15` / `45` | Silence before a non-terminal run alerts (warn / critical) — once per run and severity, persisted in AuditLog (`stale_run_alerted`) |
| `STALE_RUN_ALERT_COOLDOWN_MINUTES` | `30` | In-memory cooldown between sweeps (first-level cache) |
| `STALE_RUN_ABANDON_HOURS` | `24` | A live run (agent task `queued`/`running`, codex run `running`/`waiting_approval`) silent this long is closed as «abandonado» (agent task → `failed`; codex plan awaiting approval → `cancelled`; codex run → `error`, reason in `error`), recorded once (`stale_run_abandoned`), never alerted again. Terminal rows (`completed`/`failed`/`cancelled`/`error`/`done`) are never scanned. `0` never closes |

### Cowork runs (`backend/src/services/cowork/control-plane.js`)

| Variable | Default | Purpose |
|---|---|---|
| `SIRAGPT_COWORK_STALE_RUN_MS` | `7200000` (2 h) | `queued`/`running`/`paused` sin actualización → `failed` al crear el siguiente run del usuario |
| `SIRAGPT_COWORK_STALE_HEARTBEAT_MS` | `900000` (15 min) | `running` sin paso ni latido → `failed` (libera el cupo del plan: «Your plan allows 12 concurrent Cowork task(s)») |
| `SIRAGPT_COWORK_STALE_APPROVAL_MS` | `86400000` (24 h) | `waiting_approval` sin actividad → `failed` |
| `SIRAGPT_COWORK_HEARTBEAT_MS` | `300000` (5 min) | Latido (`touchRun`) del turno de chat mientras el run está vivo, para que un paso largo no se cierre como abandonado |

El aviso «run bootstrap failed (legacy chat continues)» se registra como WARN
una vez por minuto (con el recuento del minuto anterior) y el resto a `info`.

## Volcado de producción 2026-10-03 — OCR local acotado y cierre HTTP

| Variable | Default | Descripción |
|---|---|---|
| `SIRAGPT_OCR_LOCAL_IMAGE_BUDGET_MS` | `20000` | Presupuesto de reloj (ms) de TODO el intento local de Tesseract sobre UNA imagen (ambas pasadas). Pasado el plazo no arranca otra variante, un `recognize()` colgado se abandona terminando el worker y la imagen pasa a los peldaños de visión (GLM-OCR local → nube). Una foto de WhatsApp retuvo la subida 371 s en producción. El pase por mosaicos conserva su propio `SIRAGPT_OCR_IMAGE_BUDGET_MS` (12 s). |
| `SIRAGPT_HTTP_CLOSE_GRACE_MS` | `3500` | Gracia (ms) que `http_server_close` da a las peticiones en vuelo antes de cortar los sockets que sigan abiertos (SSE, long-poll). Debe quedar por debajo del presupuesto de 5 s del paso; con `keepAliveTimeout` de 2 min un `server.close()` a secas nunca terminaba. Los sockets ociosos keep-alive se sueltan de inmediato. |

## Plantilla obligatoria y edición quirúrgica de láminas (added 2026-10-03)

| Variable | Default | Descripción |
|---|---|---|
| `SIRAGPT_TEMPLATE_LINEAGE` | on | `0` desactiva la barrera de linaje: con ella activa, un turno «crea una ppt/word con este formato» + plantilla adjunta (.pptx/.potx/.docx/.dotx) solo entrega archivos que DESCIENDEN de la plantilla (mismo esquema de color y fuentes del tema, mismos masters, mismos layouts, sin láminas de muestra). Un deck reconstruido con un tema de SiraGPT se marca `template_not_followed`, no se entrega y el modelo recibe la causa para rehacerlo sobre la plantilla. |

## Billing failover and provider keys (optional)

When the provider of a user-selected model has no credit/quota left
(Anthropic «credit balance is too low», HTTP 402, «Insufficient Balance»,
OpenAI `insufficient_quota`), the turn keeps that model and reports `E_PROVIDER`.
Internal requests without a pinned model may use a configured, funded model
of a comparable tier if failover is enabled. The provider shows as «Sin saldo»
in the picker until the memo expires or an admin saves another key.
Provider SDK clients follow the key currently in env (Admin → Conexiones swaps
it at runtime), so no client keeps a stale key.

| Variable | Default | Purpose |
|---|---|---|
| `SIRAGPT_BILLING_FAILOVER` | on | `0` disables failover for unpinned internal requests; selected models never switch providers |
| `SIRAGPT_BILLING_FAILOVER_MEMO_MS` | `600000` | How long a provider stays «sin saldo» before it is tried again (a per-minute quota window is memoised only for its wait, 30–120 s, and is not shown as «Sin saldo») |
| `SIRAGPT_BILLING_FAILOVER_ORDER` | `DeepSeek,Cerebras,Gemini,Groq,Mistral,OpenRouter,xAI,OpenAI,Anthropic,Meta,Kimi,Z.ai` | Preference among funded providers (same tier first) |
| `SIRAGPT_BILLING_FAILOVER_LAST_RESORT` | on | When an unpinned internal request finds no funded model in the picker list, try the last-resort rungs (DeepSeek V4 Flash direct, then through its second transport, Gemini 2.5 Flash for image turns). `0` disables them. Never used for a model the user picked |
| `SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS` | `150000` | An agentic chat turn that hit a step timeout is regenerated once through the plain stream only when it has no attachments or generated files and started less than this many ms ago; otherwise it ends with an honest «tardó más de lo previsto» error (`backend/src/services/ai/agentic-degrade-policy.js`). A dry / rejected / rate-limited provider never regenerates: the turn ends naming the model and the cause |
| `SIRAGPT_IMAGE_AUTH_FALLBACK` | off | `1` / `true` / `on` lets `/api/ai/generate-image` render with another active image model when the picked one's provider answers 401/403 or has no key (recorded as `substitutedFrom`). Off by default (owner policy: a picked model is never switched); the user instead reads which image model failed and why (sin saldo / clave rechazada / no permite el modelo / no configurado / límite por minuto) |
| `SIRAGPT_OPENAI_FILES_UPLOAD` | on | `0` skips the optional OpenAI Files upload of documents (it now always runs in the background and is skipped while OpenAI rejects the key) |
| `SIRAGPT_MODELS_DEBUG` | off | `1` prints `[models-dbg]` latency lines for `GET /api/ai/models` (debug level) |
