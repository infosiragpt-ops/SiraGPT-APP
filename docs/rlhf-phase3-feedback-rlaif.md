# RLHF phase 3 — rich feedback + RLAIF

Lote 1 of the remaining RLHF stack. Builds on #708 (ledger + RM +
export) and #711 (steering + telemetry). **No** best-of-N default, **no**
`AGENTES_CODING_V2`, **no** `/code` surface, **no** Lenovo publish.

## What lands

### A) Rich human feedback

Thumbs (`POST /chats/messages/:id/feedback` and `POST /api/rlhf/feedback`)
now accept an optional **reason code** plus a size-capped free-text note.

| Field | Shape | Persist |
|-------|--------|---------|
| `reasonCode` | fixed enum (below) | `preference_events.reason_code` (nullable; old rows stay NULL) |
| `reason` | enum **or** free text | mapped to `reasonCode` if it matches the enum, else to `notes` |
| `notes` | free text, max 500 chars | `preference_events.notes` (already existed) |

Chat thumbs keep working with the old `{ feedback, reason }` payload.
Unknown codes are dropped (fail-open). No new `/agentes` chrome.

Spanish-friendly codes (stable English tokens; labels are docs-only):

| Code | Label |
|------|--------|
| `invented` | Inventó datos |
| `wrong_file` | Archivo equivocado |
| `bad_math` | Cálculo incorrecto |
| `wrong_tone` | Tono inadecuado |
| `incomplete` | Incompleto |
| `off_topic` | Fuera de tema |
| `too_long` | Demasiado largo |
| `too_short` | Demasiado corto |
| `harmful` | Inseguro o dañino |
| `other` | Otro |

### Pairwise A/B

`POST /api/rlhf/pair` (same auth as the rest of `/api/rlhf`) records a
durable chosen/rejected pair for **one prompt**:

```json
{
  "prompt": "explica DPO",
  "chosen": "respuesta buena",
  "rejected": "respuesta mala",
  "reasonCode": "incomplete",
  "notes": "la primera no terminó el ejemplo"
}
```

Or two assistant message ids the caller already owns:

```json
{
  "chosenMessageId": "msg_win",
  "rejectedMessageId": "msg_lose"
}
```

Both rows share a `pairId`. DPO export (`GET /api/rlhf/export?format=dpo`)
emits that pair. Fail-open: missing texts return `{ stored: false }`
without throwing.

Regenerate still marks the prior answer `rejected`. If the generate body
carries `reason` / `reasonCode` / `notes`, those attach to the rejected
prior (and the new unlabeled candidate). Structured logger only on the
`/generate` path — no `console.*`.

### B) RLAIF (synthetic labels)

Optional HHH judge (same InstructGPT rubric as `alignment-judge`).
**Off in production unless Luis sets the flag.**

| Env | Default | Effect |
|-----|---------|--------|
| `SIRAGPT_RLHF_RLAIF` | **off** | `1` / `true` / `on` allows synthetic labels |
| `SIRAGPT_RLHF_RLAIF_MAX_PER_USER` | 8 | Cap of synthetic **rows** per user per window |
| `SIRAGPT_RLHF_RLAIF_WINDOW_MS` | 3600000 | Rate-limit window (1 hour) |

Rules:

- Mid scores abstain (`overall` 5–7). Only ≥8 → chosen, ≤4 → rejected.
- Pair proposal needs a score gap ≥ 3.
- Every synthetic row is `source=rlaif`.
- Human labels on the same `runId` win; RLAIF does not overwrite them.
- SFT / DPO / RM export **omit** RLAIF unless `includeRlaif=true`.
- Fail-open. The generate path never awaits the judge. When the flag is
  on, persist fires `proposeFromRecent` via `setImmediate` and logs
  `rlhf.rlaif_skipped` / `rlhf.rlaif_propose_failed` through the privacy
  logger.

`POST /api/rlhf/rlaif/propose` (auth, same as `/feedback`) can also
trigger a pair (`prompt` + `a` + `b`) or a scan of recent unlabeled
turns. Returns `{ enabled: false }` when the flag is off.

## GDPR

The deleted-user scrub still masks `prompt_text`, `response_text`, and
`notes` on `preference_events`. `reason_code` is an enum token, not
user prose.

## What this lote does **not** do

GPU fine-tune jobs, enabling `SIRAGPT_RLHF_BEST_OF_N`, enabling
`AGENTES_CODING_V2`, admin dashboard UI, OpenRouter fallback, `/code`.
Those stay later lotes (pipeline / construir).

## How to verify

```bash
cd backend
node --test tests/rlhf-phase3-feedback-rlaif.test.js \
  tests/rlhf-flywheel.test.js tests/rlhf-phase2-steering.test.js \
  tests/preference-chat-export.test.js tests/scrub-deleted-user-content.test.js
```

Expect `rlaif: false` on `GET /api/rlhf/stats` unless the flag is on.
