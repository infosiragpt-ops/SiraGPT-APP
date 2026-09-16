# RLHF phase 2 — inference steering

Closes the loop started in #708: durable preferences now steer the next
chat/agent turn, and ops can see whether that happened. No new `/agentes`
chrome. Best-of-N stays **off**.

## What steering does

At `/api/ai/generate` time (plain stream and agentic loop):

1. Resolve the preference agent: `document` when the turn is document
   analysis, otherwise `chat`.
2. Hydrate the user's helpful rows from Postgres (`preference_events`
   via the flywheel store, plus `Message.feedback` via
   `feedback-durable.loadPreferenceRows`).
3. Embed the current prompt and retrieve the top-2 similar thumbs-up
   answers (same embeddings as RAG).
4. Inject a **size-capped Spanish** few-shot block into the system /
   developer prompt (`## PREFERENCIAS DEL USUARIO` or the existing
   document RLHF heading). The model is told not to mention the block
   and not to copy personal data.

The same block is passed into `runAgenticChat` as `preferenceBlock` so
the agentic extra-system prompt sees it too.

Semantic-enrichment policy still gates the embed call (short "hola"
turns skip it — I2 / trivial TTFT). `SIRAGPT_RLHF_STEERING=0` skips
steering even when enrichment would run.

## Flags

| Env | Default | Effect |
|-----|---------|--------|
| `SIRAGPT_RLHF_STEERING` | **on** | Few-shot injection. `0`/`false`/`off` disables |
| `SIRAGPT_RLHF_STEERING_MAX_CHARS` | 1800 | Hard cap on the injected block |
| `SIRAGPT_RLHF_BEST_OF_N` | **off** | Sample-and-rank with the reward model. Do not enable in production unless you accept N× tokens |
| `SIRAGPT_RLHF_ENABLED` | on | Collection (unchanged from #708) |

`AGENTES_CODING_V2` is unrelated and stays off.

## Fail-open

If Prisma, embeddings, the ledger, or the RM are unavailable, generation
continues with an empty block. Errors are counted as
`steering.failOpen` and logged as `rlhf.steering_skipped` /
`feedback.exemplars_unavailable` through the generate privacy logger
(no `console.*` on the `/generate` path).

## Routing-feedback bridge

When a thumb lands on an assistant message, `rlhf/routing-bridge`
records:

- 👍 → `success`
- 👎 → `disliked`

Regenerate already records `regenerated` on the generate path. All three
are no-ops without a model id in message metadata. Intelligent routing
already consumes `penaltyProvider`; this only feeds outcomes.

### Implicit signals (no thumb needed)

The software also learns from turns that fail on their own. When the
plain generate stream ends in a provider failure, `aiService.generateStream`
calls the route's `onProviderFailure` and `rlhf/routing-bridge`
`recordFromProviderFailure` records:

| Generate outcome | Code | routing-feedback outcome |
|------------------|------|--------------------------|
| «Conexión no disponible» on a picked model (empty completion, 4xx/5xx) | `connection_unavailable` / `sira_mini_unavailable` | `provider_failure` |
| Generic fallback note, nothing streamed | `provider_fallback` | `provider_failure` |
| Stream cut after partial text | `partial_stream` | `provider_failure` |
| First-byte watchdog aborted the turn | `ttfb_abort` | `ttfb_abort` |

Both outcomes weigh like a 👎 for that (intent, difficulty, model)
signature, so a model that keeps failing on a task type gets deprioritized
by intelligent routing. No `preference_events` row is written: a failed
turn has no answer text worth training the reward model on. Counters:
`sira_rlhf_implicit_signals_total`, `sira_rlhf_implicit_signal_kind`,
`sira_rlhf_implicit_signal_code` (also under `implicit` in
`GET /api/rlhf/stats` for admins). The generate privacy logger emits
`rlhf.implicit_signal`. Fail-open like the rest of the bridge.

Note: reasoning deltas now count as the provider's first byte for the
45 s TTFB watchdog (`services/generate-first-byte.js`), so a thinking model
is no longer aborted mid-trace — that abort used to surface as a spurious
«Conexión no disponible» and would have polluted this signal.

## Ops telemetry

No UI. Counters live in `rlhf/metrics.js` (same pattern as
`free-ia-metrics`):

- preference ingest (source / label / agent)
- exemplar hit / miss
- steering applied / skipped / fail-open
- RM score when `/score` or best-of-N actually uses the model
- export count + last payload bytes

`GET /api/rlhf/stats` (auth required, same as #708):

- every caller: `enabled`, `steering`, `bestOfN`, `user` counts, `phase2` flags
- admin / super-admin: full `phase2` snapshot + `global` counts

The process Prometheus scrape (`/metrics`) also includes `sira_rlhf_*`
families.

GDPR: `preference_events` text is still scrubbed by the deleted-user
job from #708. This PR does not add new durable PII columns.

## How to verify

```bash
cd backend
node --test tests/rlhf-phase2-steering.test.js tests/rlhf-flywheel.test.js
```

Source contracts in those files assert:

- `/generate` calls `buildSteeringBlock` and does not use `console.*`
- `SIRAGPT_RLHF_BEST_OF_N` defaults off
- `runAgenticChat` accepts `preferenceBlock`
- chats feedback calls `recordFromThumb` for liked **and** disliked

Live (after publish, admin session):

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  https://siragpt.com/api/rlhf/stats
```

Expect `steering: true`, `bestOfN: false`. After a few thumbs + a
similar follow-up ask, `phase2.steering.applied` (admin) increments and
`phase2.exemplars.hitRate` is > 0.

## Phase 3 (not this PR)

Real fine-tune jobs from the SFT/DPO JSONL export, and an admin
dashboard UI for the counters above. Do not implement those here.
