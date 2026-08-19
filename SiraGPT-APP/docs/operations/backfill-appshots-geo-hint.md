# Backfill — Appshots `Session.geoHint`

One-shot housekeeping job that fills `Session.geoHint` ("Madrid, ES")
for Appshots-scoped sessions linked before Task 19 shipped. Without
this pass, the Settings → Appshots device list keeps showing only the
/24 `ipHint` for those older rows.

## When to run

- Once after deploying Task 19 (`add_session_geo_hint` migration +
  inline `resolveGeoHint` in `POST /api/appshots/pair`).
- Ad-hoc later if the operator wants to retry rows that failed at pair
  time (e.g. the upstream `ipwho.is` was down). The job is idempotent
  — it only touches rows where `geoHint IS NULL`.

## How to run

```bash
# Dry-run first to see how many rows would be touched
node backend/src/jobs/backfill-appshots-geo-hint.js --dry-run

# Real pass
node backend/src/jobs/backfill-appshots-geo-hint.js

# Optional knobs
node backend/src/jobs/backfill-appshots-geo-hint.js \
  --batch-size=200 \
  --delay-ms=100 \
  --limit=1000
```

Equivalent env vars (for cron wrappers):
`APPSHOTS_GEO_BACKFILL_DRY_RUN`, `APPSHOTS_GEO_BACKFILL_BATCH`,
`APPSHOTS_GEO_BACKFILL_DELAY_MS`, `APPSHOTS_GEO_BACKFILL_LIMIT`.

## What the summary line means

The job logs a single JSON-shaped summary on completion:

| Field | Meaning |
| --- | --- |
| `scanned` | Total `Session` rows inspected (geoHint NULL + ipHint set). |
| `appshotsCandidates` | Subset whose JWT carries `scope: appshots:capture`. |
| `filled` | Rows actually updated (or that *would have been* in dry-run). |
| `skippedNonAppshots` | Cookie / web sessions — left alone. |
| `skippedUnresolvable` | Geo lookup returned `null` (private IP, upstream down, row vanished mid-batch). Safe to re-run later. |
| `skippedBadIpHint` | `ipHint` did not match the `/24` or `/64` shape produced by `reduceIp()` — pre-migration weirdness. |
| `dryRun` | Boolean — true means nothing was written. |

## Safety notes

- Best-effort: any lookup failure leaves the row at `geoHint = NULL`;
  the UI keeps falling back to `ipHint` exactly as it does today.
- Aborts immediately with `aborted: 'missing_jwt_secret'` when
  `JWT_SECRET` is unset — without it we cannot tell appshots tokens
  apart from regular sessions and we refuse to touch the table.
- Uses the same `resolveGeoHint` helper as the live pair endpoint, so
  the `GEOIP_LOOKUP_URL` override (self-hosted MaxMind, paid provider)
  applies here too. The default `ipwho.is` endpoint has a generous
  free tier; the inter-row `delayMs` keeps us polite.
