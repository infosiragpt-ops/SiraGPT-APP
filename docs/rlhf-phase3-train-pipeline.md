# RLHF phase 3 — SFT / DPO train-prep pipeline

Closes the training loop operationally: an admin can take the preference
export from #708 and run a **bounded, flagged, admin-triggered** job that
writes a scrubbed SFT or DPO JSONL artifact. There is no admin dashboard
in this lote. There is no automatic paid fine-tune.

Best-of-N (`SIRAGPT_RLHF_BEST_OF_N`) and `AGENTES_CODING_V2` stay **off**.

## What a job does

1. Admin calls `POST /api/rlhf/jobs` with `format=sft|dpo` and filters.
2. A durable row is written to `rlhf_train_jobs` (`queued` → `running` → `ready`).
3. The worker hydrates `preference_events`, runs the existing flywheel
   export (`backend/src/services/rlhf/export.js`) with PII scrub on, and
   stores the JSONL through the shared object-storage path (R2 when
   configured, otherwise `uploads/rlhf-train/<jobId>/`).
4. `GET /api/rlhf/jobs/:id` returns status + artifact pointers (key,
   bytes, sha256, download path). The JSONL itself is never logged.
5. `GET /api/rlhf/jobs/:id/artifact` streams the file (admin only).

The in-process Bradley-Terry reward model (`POST /api/rlhf/train` and
`SIRAGPT_RLHF_AUTO_TRAIN`) is unchanged. Auto-train still only fits that
local linear RM. It does **not** enqueue a phase-3 job.

## Flags

| Env | Default | Effect |
|-----|---------|--------|
| `SIRAGPT_RLHF_TRAIN_JOBS` | **off** | `1` / `true` / `on` enables the admin job API + worker |
| `SIRAGPT_RLHF_TRAIN_SUBMIT` | **off** | Optional external submit after prep. No-op today (no catalog adapter in-repo) |
| `SIRAGPT_RLHF_TRAIN_JOB_CONCURRENCY` | 1 | In-process workers (capped at 4) |
| `SIRAGPT_RLHF_AUTO_TRAIN` | on | #708 local RM cooldown retrainer only. Never starts a prep job or a paid fine-tune |
| `SIRAGPT_RLHF_BEST_OF_N` | **off** | Leave off |
| `AGENTES_CODING_V2` | **off** | Unrelated. Leave off |

Production sense: leave `SIRAGPT_RLHF_TRAIN_JOBS` unset until an admin
intentionally enables it. Creating a job never calls a model provider.

## HTTP (admin session)

All three require `authenticateToken` + `requireAdmin`. When the flag is
off, mutating/listing endpoints return `403` `{ code: "E_DISABLED" }`.

```bash
# enable on the admin box only
export SIRAGPT_RLHF_TRAIN_JOBS=1

# human-only SFT (RLAIF omitted). minPairs = min rows for SFT.
curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format":"sft","includeRlaif":false,"minPairs":50,"scope":"global"}' \
  https://siragpt.com/api/rlhf/jobs

# DPO pairs, one user (admin-only scope)
curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format":"dpo","includeRlaif":false,"minPairs":20,"scope":"user","scopeUserId":"<userId>"}' \
  https://siragpt.com/api/rlhf/jobs

# poll
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://siragpt.com/api/rlhf/jobs/<id>

# recent jobs
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://siragpt.com/api/rlhf/jobs

# download scrubbed JSONL
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o sft.jsonl \
  https://siragpt.com/api/rlhf/jobs/<id>/artifact
```

Create body:

| Field | Default | Notes |
|-------|---------|-------|
| `format` | required | `sft` \| `dpo` \| `rm` |
| `includeRlaif` | `false` | Human-only unless true |
| `minPairs` | `1` | Min DPO pairs, or min SFT/RM rows. Raise this in prod |
| `scope` | `global` | `user` requires `scopeUserId` (admin-only) |
| `scrubPii` | `true` | Do not turn off except on a locked box |
| `submit` | `false` | Ignored unless `SIRAGPT_RLHF_TRAIN_SUBMIT=1` **and** a catalog adapter exists |

Response `job.result` has counts, `storage` (`r2` \| `local`), `artifactKey`,
`sha256`, `piiHits` (kind counts only), and `downloadPath`. No prompt
text, no emails, no brand-vendor model ids.

## Artifact storage

Same helper as uploads / documents (`backend/src/services/object-storage.js`):

- R2 configured → ref `r2:rlhf-train/<jobId>/<format>.jsonl`
- otherwise → `uploads/rlhf-train/<jobId>/<format>.jsonl` (`UPLOAD_DIR`)

GDPR deleted-user scrub removes those bytes best-effort. Job rows stay
for audit (status + pointers, no raw text).

## Upload recipe — Sira Rápido / Sira Pro

There is **no** in-repo fine-tune client for the Sira catalog. Do not
point this JSONL at a third-party aggregator. Prep-only is the supported
path.

Local / offline (no API spend):

```bash
# SFT — chat messages JSONL (system / user / assistant)
# DPO — TRL / OpenRLHF pair schema from the flywheel export

# Inspect without printing user text:
python -c "import pathlib; p=pathlib.Path('sft.jsonl'); print(sum(1 for _ in p.open()), p.stat().st_size)"
```

Then train with your usual local recipe (TRL SFT / DPO, Axolotl, etc.)
against the **Sira Rápido** or **Sira Pro** checkpoint you already operate.
Keep the resulting adapter private; serve it through the existing catalog
map (brand label on the server, never a raw model id in UI).

If `SIRAGPT_RLHF_TRAIN_SUBMIT=1` and a future first-party catalog adapter
is registered, the worker may add a `submit` step after the artifact is
ready. Today `job.result.submit` is `{ submitted: false, reason: "no_catalog_adapter" }`
even when the flag is on.

## What this lote does not do

- Admin dashboard UI (later lote)
- Construir steering
- Enabling best-of-N or `AGENTES_CODING_V2`
- Changing `preference_events` columns
- Silent provider fallback

## How to verify

```bash
cd backend
SIRAGPT_RLHF_TRAIN_JOBS=1 node --test tests/rlhf-train-jobs.test.js
```
