# Continuity guards

Recurring production regressions (Activos passthrough, /code chrome, doc-engine
hook, SDIE, ChunkLoad, ACS/noVNC) were wiped by **frontend image recreates**
and **engine-only waves** that overwrote host/VPS patches never landed in git.

This file is the contract. Source of truth is `production-main`, not the VPS.

## Why features disappear

1. Frontend is a Next.js **standalone Docker image**. Host TSX is not read at
   runtime. A `docker compose ... --force-recreate frontend` throws away any
   file that only existed on the host.
2. Engine-only waves (backend bind-mounts, `FEATURE_*` toggles, ACS Caddy
   edits) sometimes rebuild or recreate the frontend “to be safe”. That
   smashes ACS (Agent Computer / noVNC Computadora) and /code chrome.
3. Admin catalog, doc-engine hook, and SDIE live in backend source. If an
   engine wave recopies an older tree, those hooks vanish even when the
   files still exist as orphans.

## Rules for engine-only waves

Engine-only waves **must not**:

- Rebuild or `--force-recreate` the **frontend** image.
- Recreate ACS / `siragpt-computer-orchestrator` / Caddy just to ship a
  backend flag.
- Sed-patch files under `/opt/siragpt` that are not in git.
- Reintroduce **OpenRouter** on any generate path (chat, /code, SDIE,
  doc-engine, computer). DeepSeek V4 Flash / Pro only.

Engine-only waves **may**:

- Recreate **backend** (and workers) after `git pull` on `production-main`.
- Toggle `FEATURE_DOC_ENGINE`, `FEATURE_SDIE_V2`, `SIRAGPT_AGENT_COMPUTER`.
- Bind-mount backend services that already exist in this repo.

Before any frontend rebuild:

```bash
node scripts/assert-continuity-guards.js
bash scripts/reapply-code-ui-lock.sh --check
bash scripts/preserve-code-patches.sh
```

## Anchored features

| # | Feature | SSOT / hook | Guard |
|---|---|---|---|
| 1 | `/admin/models` Activos + catalog passthrough (`allowlist ∪ isActive`) | `backend/src/services/visible-model-catalog.js` | assert + `visible-model-catalog` tests |
| 2 | /code desktop UI lock | `lib/code-chrome-lock.ts` | `scripts/reapply-code-ui-lock.sh --check` |
| 3 | /code mobile Grok chrome + EmptyChat null | `lib/code-mobile-grok.ts`, `useResolvedMobile` | assert + source tests |
| 4 | Responsive phone overlays | `hooks/use-mobile.tsx`, `docs/responsive-phone-web.md` | assert |
| 5 | Doc engine (`FEATURE_DOC_ENGINE`, UPN, sectPr, preview) | `tryDocEngineAfterSelection` in `source-preserving-document-edit.js` | assert + `doc-engine` tests |
| 6 | Pensando… Claude stepper | `components/claude-thinking-timeline.tsx` | assert |
| 7 | SDIE v2 Phase 1 | `backend/src/services/sdie/`, `FEATURE_SDIE_V2` | assert + `sdie-v2-phase1` tests |
| 8 | /code ChunkLoad hard-reload | `lib/client-bundle-recovery.ts`, `app/code/error.tsx` | assert + bootstrap tests |
| 9 | ACS / noVNC Computadora | `/api/agent-computer` + Caddy `/agent-computer/*` | assert |
| 10 | DeepSeek-only generate | `assertNativeGatewayGenerate`, picker policies | assert |

## CI

`node scripts/assert-continuity-guards.js` runs on every PR to
`production-main`. If an engine wave or FE recreate drops an anchor, CI
goes red **before** deploy.

## Related

- `docs/code-ui-lock.md` — desktop chrome contract
- `docs/CODE_CONTINUITY.md` — /code + ACS deploy recipe
- `docs/sdie-v2.md` — SDIE Phase 1
- `docs/code-workspace-bootstrap.md` — ChunkLoad / ensure API
- `docs/code-mobile-grok.md` — phone chrome
- `docs/responsive-phone-web.md` — overlay breakpoints
