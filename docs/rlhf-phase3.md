# RLHF phase 3 — dashboard, backfill, daily RM train

Complements `docs/rlhf-phase3-train-pipeline.md` (SFT/DPO prep jobs).
This lote adds the operator UI, historical thumb copy, and a daily
in-process RM pass. Best-of-N stays **off**.

## What lands

1. **Backfill** — `POST /api/rlhf/backfill` copies `Message.feedback`
   (liked/disliked) into `preference_events`. Idempotent on
   `runId = messageId`.
2. **Daily cron** `rlhf-phase3` at 08:00 UTC: backfill then maybe retrain
   the Bradley-Terry RM (`POST /api/rlhf/train` is the same RM).
3. **Admin UI** `/admin/rlhf` — counters, backfill, train RM, enqueue
   SFT/DPO prep (`POST /api/rlhf/jobs` from the train-pipeline lote).

Prep jobs stay behind `SIRAGPT_RLHF_TRAIN_JOBS` (default off). Enabling
them does not call a model provider.

## Verify

```bash
cd backend
node --test tests/rlhf-phase3.test.js tests/rlhf-train-jobs.test.js tests/system-cron.test.js
```

Live (admin): `https://siragpt.com/admin/rlhf` → **Backfill thumbs**, then
**Entrenar RM** when there are enough labels.
