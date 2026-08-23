# Continuity guards

Recurring production regressions (Activos passthrough, /code chrome, doc-engine
hook, SDIE, ChunkLoad, ACS/noVNC, OpenSpec) were wiped by **frontend image
recreates** and **engine-only waves** that overwrote host/VPS patches never
landed in git.

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

## Frontend recreate — HARD BAN

`--force-recreate frontend` and ad-hoc `docker compose ... build frontend`
on the VPS are **forbidden** for engine-only waves and for applying
hot-patches.

The only legal frontend ship is: merge to `production-main` → CI green →
the documented production deploy pipeline that builds from that SHA.

Never:

- Recreate frontend to “be safe” after a backend flag.
- Sed-patch host TSX and then recreate the image.
- Treat `scripts/preserve-code-patches.sh` as permission to rebuild FE.
  That script is a last-resort backup, not a license to recreate.

## Rules for engine-only waves

Engine-only waves **must not**:

- Rebuild or `--force-recreate` the **frontend** image. This is a **HARD BAN**,
  not a suggestion.
- Recreate ACS / `siragpt-computer-orchestrator` / Caddy just to ship a
  backend flag.
- Sed-patch files under `/opt/siragpt` that are not in git.
- Reintroduce **OpenRouter** on any generate path (chat, /code, SDIE,
  doc-engine, computer). DeepSeek V4 Flash / Pro only.

Engine-only waves **may**:

- Recreate **backend** (and workers) after `git pull` on `production-main`.
- Toggle `FEATURE_DOC_ENGINE`, `FEATURE_SDIE_V2`, `SIRAGPT_AGENT_COMPUTER`.
- Bind-mount backend services that already exist in this repo.

Before any *backend* recreate:

```bash
node scripts/assert-continuity-guards.js
bash scripts/reapply-code-ui-lock.sh --check
```

## Anchored features

| # | Feature | SSOT / hook | Guard |
|---|---|---|---|
| 1 | `/admin/models` Activos header quick-off + catalog passthrough (`allowlist ∪ isActive`) | `visible-model-catalog.js`, `lib/admin-activos-lock.ts` | assert + catalog tests |
| 2 | /code desktop UI lock | `lib/code-chrome-lock.ts` | `scripts/reapply-code-ui-lock.sh --check` |
| 3 | /code mobile Grok chrome + EmptyChat null + composer 100% | `lib/code-mobile-grok.ts`, `useResolvedMobile` | assert + source tests |
| 4 | Responsive phone overlays (PR 340) | `hooks/use-mobile.tsx`, `docs/responsive-phone-web.md` | assert |
| 5 | Doc engine e2e (`FEATURE_DOC_ENGINE`, UPN, sectPr, LibreOffice/R2 preview) | `tryDocEngineAfterSelection` + `preview-path.js` | assert + `doc-engine` tests |
| 6 | Pensando… Claude stepper | `components/claude-thinking-timeline.tsx` | assert |
| 7 | SDIE v2 Phase 1 generate path | `backend/src/services/sdie/`, `FEATURE_SDIE_V2` | assert + `sdie-v2-phase1` tests |
| 8 | /code ChunkLoad hard-reload + workspace bootstrap (PR 319) | `lib/client-bundle-recovery.ts`, `CodeWorkspaceBootstrap` | assert + bootstrap tests |
| 9 | ACS / noVNC Computadora (PR 313) | `/api/agent-computer` + Caddy `/agent-computer/*` | assert |
| 10 | DeepSeek-only generate pickers | `lib/generation-model-lock.ts` | assert + catalog/policy tests |
| 11 | OpenSpec in /code | `backend/src/skills/openspec-catalog.js` | assert + `openspec-catalog` tests |

## PR lineage (do not drop)

| PR | What it shipped | Must remain |
|---|---|---|
| #313 | ACS / noVNC Computadora, Caddy, CODE_CONTINUITY | mounts + Caddy `embed-auth` |
| #316 | SDIE v2 Phase 1 | `runSdieTurn` + `FEATURE_SDIE_V2` |
| #319 | /code workspace bootstrap / ChunkLoad | shared helper + ensure API |
| #333 | Docx UPN transplant + preview path | hook + `preview-path.js` |
| #334 | /code mobile Grok chrome | EmptyChat null + `useResolvedMobile` |
| #340 | Responsive phone overlays | overlay breakpoint + hide desktop top bar |
| #380 | Restore orphans + continuity guards | this file + `assert-continuity-guards.js` |

## CI

`node scripts/assert-continuity-guards.js` runs on every PR to
`production-main`. If an engine wave or FE recreate drops an anchor, CI
goes red **before** deploy.

## Related

- `docs/code-ui-lock.md` — desktop chrome contract
- `docs/CODE_CONTINUITY.md` — /code + ACS (HARD BAN on FE recreate)
- `docs/sdie-v2.md` — SDIE Phase 1
- `docs/code-workspace-bootstrap.md` — ChunkLoad / ensure API
- `docs/code-mobile-grok.md` — phone chrome
- `docs/responsive-phone-web.md` — overlay breakpoints
