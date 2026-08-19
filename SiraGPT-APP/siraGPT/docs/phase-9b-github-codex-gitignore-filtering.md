# Phase 9B: GitHub Codex .gitignore Filtering

## Summary

SiraGPT already exposes a Codex/Cursor-style GitHub connector and repository RAG ingestion without cloning repositories or executing remote code. Phase 9B hardens file selection by applying the repository's own `.gitignore` rules before downloading file contents for `/api/codex/github/files` and `/api/codex/github/ingest`.

This keeps generated files, local artifacts and project-specific ignored paths out of the Codex context window and RAG index, while preserving the existing built-in protections for `.env*`, lockfiles, vendor directories, build outputs, unsupported extensions and oversized files.

## Dependency Validation

| Check | Result |
|---|---|
| Package | `ignore@7.0.5` |
| URL | https://github.com/kaelzhang/node-ignore |
| License | MIT, verified from npm metadata and package `LICENSE-MIT` |
| Runtime dependencies | None |
| npm popularity | 237M downloads in the last week at validation time |
| Maintenance | Repository not archived; last push 2025-05-31; active npm release metadata |
| Open issues | Low volume; no blocker for standard `.gitignore` parsing |
| Lock-in risk | Low; it is an adapter around `.gitignore` semantics and can be replaced behind `createRepositoryIgnoreMatcher` |
| GPL/AGPL risk | None detected |

Rejected alternatives:

- Manual glob parsing: easy to get `.gitignore` negation and directory semantics wrong.
- Shelling out to `git check-ignore`: not viable because this connector intentionally does not clone repositories.
- Larger repository ingestion frameworks: unnecessary surface area for this narrow security and relevance fix.

## Implementation

Changed backend-only files:

- `backend/package.json` and `backend/package-lock.json`: adds exact dependency `ignore@7.0.5`.
- `backend/src/services/github-codex-connector.js`: fetches `.gitignore` through Octokit, creates an in-memory matcher, skips ignored repository paths before content download, and returns sanitized filtering metadata.
- `backend/tests/github-codex-connector.test.js`: covers `.gitignore` matching, negation behavior, preservation of secret-file filters and file-fetch accounting.
- `backend/.env.example`: documents that `.gitignore` filtering is automatic and backend-only.

No public Codex route changed:

- `GET /api/codex/github/status`
- `GET /api/codex/github/repo`
- `GET /api/codex/github/files`
- `POST /api/codex/github/ingest`
- `POST /api/codex/github/retrieve`

The status payload now exposes sanitized operational filtering capabilities. It does not expose tokens, file contents or request secrets.

## How To Test Locally

```bash
cd backend
node --test tests/github-codex-connector.test.js
npm audit --omit=dev --audit-level=critical
cd ..
npm run licenses:check
npm run licenses:report
git diff --check
```

Manual smoke:

```bash
curl "http://127.0.0.1:5000/api/codex/github/files?repo=SiraGPT-ORg/siraGPT&branch=main&limit=10"
```

Expected behavior:

- Response includes `filtering.gitignore.applied` when `.gitignore` is readable.
- Response includes `skipped.gitignored` with the count of ignored code-like files.
- Ignored files are not downloaded and therefore cannot enter `rag.ingestCode()`.

## Production Validation

After deploy:

1. Open `/codex`.
2. Analyze `SiraGPT-ORg/siraGPT` on `main`.
3. Confirm the file list excludes paths ignored by the repository.
4. Trigger repository RAG ingestion only when `OPENAI_API_KEY` is configured.
5. Confirm GitHub tokens remain backend-only and are absent from `/api/codex/github/status`.

## Risk

The behavioral change is intentionally conservative. Built-in deny rules still run before `.gitignore`, so project ignore rules cannot re-allow `.env*`, `node_modules`, build outputs or lockfiles. If `.gitignore` is missing, unreadable or oversized, the connector degrades to the previous built-in filtering policy and surfaces a warning only when the optional `.gitignore` read fails unexpectedly.

## Next Step

Phase 9C should add a canonical backend streaming envelope for chat, agents, artifacts and Codex streams, then extend HTTP integration tests around those stream contracts.
