# Phase 8E: Promise Concurrency Controls

## Scope

Phase 8E starts the Phase 8E batch from `docs/cto-commercial-ai-ecosystem-roadmap.md` by
introducing a controlled-concurrency primitive in the message-attachments service.
Earlier code mapped every uploaded attachment in parallel to OCR and document analysis
through `Promise.all(rows.map(...))`. With the upload policy capping a single message at
`MAX_UPLOAD_FILES` (default 10) attachments, that pattern can fan out 10 simultaneous
Tesseract / Vision API calls per request and saturate CPU plus external Vision quotas
during normal usage.

This phase replaces those fan-outs with a small `mapWithLimit` helper backed by
[`p-limit@7.3.0`](https://github.com/sindresorhus/p-limit) so OCR and document analysis
run with a configurable concurrency cap. The new helper is exported for unit tests and
is used in the two cascades that build chat context and transcription text from
attachments.

## Dependency

| Package | Version | License | Notes |
|---|---|---|---|
| `p-limit` | `7.3.0` | MIT | ESM-only; loaded via dynamic `import()` from the existing CommonJS backend. Validated against npm registry metadata, GitHub Advisory DB and OSV on 2026-05-01. |

`p-limit` was already part of the Phase 8E plan in
`docs/cto-commercial-ai-ecosystem-roadmap.md`. No GPL/AGPL/LGPL dependencies are
introduced. `THIRD_PARTY_LICENSES.md` was regenerated.

## Changes

- `backend/src/services/message-attachments.js`:
  - Adds a lazily-loaded `loadPLimit()` helper and a `mapWithLimit(items, fn, n)`
    wrapper that fast-paths the empty and single-item cases.
  - Replaces the `Promise.all(rows.map(...))` cascades inside
    `buildUploadedFileContext` and `buildTranscriptionTextFromFiles` with
    `mapWithLimit` so OCR and document analysis honor a per-request concurrency cap.
  - Default cap is `3`, controlled by `MESSAGE_ATTACHMENTS_OCR_CONCURRENCY`.
  - Exports `mapWithLimit` so it can be exercised in isolation by unit tests.
- `backend/.env.example`: documents `MESSAGE_ATTACHMENTS_OCR_CONCURRENCY=3`.
- `backend/tests/message-attachments-concurrency.test.js`: exercises the empty,
  single-item, ordered, capped-concurrency and rejection-propagation cases.
- `backend/package.json` + `backend/package-lock.json`: declares `p-limit@^7.3.0`.
- `THIRD_PARTY_LICENSES.md`: regenerated with `npm run licenses:report` so the new
  packages (`p-limit`, transitive `yocto-queue`) appear under the MIT section.

## Behavior change summary

- Public API surface of `message-attachments` is unchanged. `buildUploadedFileContext`
  and `buildTranscriptionTextFromFiles` accept the same arguments and return the same
  shape; only their internal scheduling is different.
- Output order is preserved: `mapWithLimit` returns results in the same order as the
  input array regardless of completion order.
- When `MESSAGE_ATTACHMENTS_OCR_CONCURRENCY` is unset, invalid or `0`, the helper
  clamps to a minimum of `1` and falls back to the default of `3`.

## Validation

Local:

```bash
cd backend
node --test tests/message-attachments-concurrency.test.js

# Existing regressions stay green:
node --test tests/upload-security-policy.test.js \
            tests/preview-html-sanitizer.test.js
cd ..
npm run licenses:check
```

Manual smoke (frontend already running on :3000, backend on :5000):

1. Upload 6+ images in a single chat message.
2. Confirm OCR completes with the same extracted text per attachment as before.
3. Confirm the backend log does not interleave more than `MESSAGE_ATTACHMENTS_OCR_CONCURRENCY`
   simultaneous OCR runs per request.

Production:

- Re-run `npm run licenses:check` and `npm audit --omit=dev --audit-level=critical`
  before merge.
- Confirm GitHub Actions `frontend`, `backend`, `licenses` and
  `CI · required checks passed` are green.
- Set `MESSAGE_ATTACHMENTS_OCR_CONCURRENCY` to a higher value only on hosts with
  reserved CPU and Vision API headroom.
