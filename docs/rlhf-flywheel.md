# RLHF flywheel

InstructGPT-style loop inside SiraGPT: collect human preferences → fit a
linear Bradley-Terry reward model on the same embeddings as RAG → export
SFT / DPO / RM JSONL for an external fine-tune. There is **no** in-process
GPU PPO in this slice.

## What lands where

| Signal | Writer | Durable row |
|--------|--------|-------------|
| Chat 👍 / 👎 | `POST /chats/messages/:id/feedback` → `feedback-ledger.record` | `preference_events` (`source=explicit`) plus `Message.feedback` |
| Regenerar | `saveChatAndTrackUsage` when `regenerate` | prior row marked `rejected`; new candidate `unlabeled` |
| Explicit pair | `POST /api/rlhf/pair` | chosen + rejected with a shared `pairId` |
| Optional RLAIF | `SIRAGPT_RLHF_RLAIF=1` | only high-confidence HHH scores |
| Implicit failure (Conexión no disponible, TTFB abort, partial stream) | `routing-bridge.recordFromProviderFailure` from the generate route | none — routing-feedback penalty + `sira_rlhf_implicit_*` counters only (see phase 2 doc) |

On boot the process attaches Prisma (`attachPrisma`) and, in `setImmediate`,
loads the latest active RM snapshot and hydrates the in-memory feedback
ledger from the newest `preference_events` (fail-open if the table is
missing). `findExemplars` can also hydrate a user from `Message.feedback`
via `feedback-durable.loadPreferenceRows`.

Thumbs-up records `routing-feedback` `success` and thumbs-down records
`disliked` when the assistant message metadata carries a model id
(fail-open; no model → no-op). Regenerates already record `regenerated`
on the generate path.

## Flags

| Env | Default | Effect |
|-----|---------|--------|
| `SIRAGPT_RLHF_ENABLED` | on | Collection. `0`/`false`/`off` skips writes |
| `SIRAGPT_RLHF_STEERING` | on | Few-shot preference injection at generate time. Cheap retrieval; fail-open |
| `SIRAGPT_RLHF_STEERING_MAX_CHARS` | 1800 | Cap for the injected block |
| `SIRAGPT_RLHF_BEST_OF_N` | **off** | Inference-time sample-and-rank. Leave off in production unless you accept N× tokens |
| `SIRAGPT_RLHF_RLAIF` | off | Synthetic labels. Mid scores abstain |
| `SIRAGPT_RLHF_AUTO_TRAIN` | on | Retrain the local Bradley-Terry RM after new labels (cooldown). `0` for tests / freeze. Never starts a phase-3 job |
| `SIRAGPT_RLHF_TRAIN_JOBS` | **off** | Admin SFT/DPO prep jobs. See `docs/rlhf-phase3-train-pipeline.md` |
| `SIRAGPT_RLHF_TRAIN_SUBMIT` | **off** | Optional submit after prep. No-op until a catalog adapter exists |

Prisma persist never blocks a thumb or a generate: errors stay in-memory
and log once.

## HTTP

Mounted at `/api/rlhf` (auth required; train is admin):

- `POST /feedback` — explicit thumb (`helpful` / `label`, optional `chatId`)
- `POST /pair` — chosen vs rejected for one prompt
- `GET /stats` — caller counts
- `GET /export?format=sft\|dpo\|rm` — JSONL download
- `POST /score` / `POST /rerank` — score or rank with the RM
- `POST /train` — fit the RM now
- `GET /model` — active snapshot metrics
- `POST /jobs` / `GET /jobs` / `GET /jobs/:id` — admin SFT/DPO prep (flagged, off by default)

Brand names only in user-facing copy. Exports and logs must not dump
secrets or raw provider model ids into UI/toasts.

## Export SFT / DPO

Need a logged-in session (or admin for a full dump). PII is scrubbed
by default (`ada@example.com` → `<EMAIL>`).

```bash
# chosen, non-RLAIF rows → instruction/response JSONL
curl -fsS -H "Authorization: Bearer $TOKEN" \
  'https://siragpt.com/api/rlhf/export?format=sft' -o sft.jsonl

# same-prompt chosen/rejected pairs (TRL / OpenRLHF DPO schema)
curl -fsS -H "Authorization: Bearer $TOKEN" \
  'https://siragpt.com/api/rlhf/export?format=dpo' -o dpo.jsonl

# pointwise RM rows (prompt + response + label)
curl -fsS -H "Authorization: Bearer $TOKEN" \
  'https://siragpt.com/api/rlhf/export?format=rm' -o rm.jsonl
```

Pass `scrubPii=0` only on a locked admin box. GDPR scrub of
`preference_events` text runs with the existing deleted-user job.

Phase 2 (inference steering + ops telemetry) is documented in
`docs/rlhf-phase2-steering.md`.

Phase 3 (admin SFT/DPO prep jobs, still no paid auto-train) is
`docs/rlhf-phase3-train-pipeline.md`.

## Out of scope (later lotes)

Admin dashboard UI, enabling best-of-N by default, a hidden aggregator
fallback, and any `/code` surface.
