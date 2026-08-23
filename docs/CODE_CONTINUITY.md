# /code continuity (ilación)

Frontend ships as a Next.js **standalone image**. Host TSX is **not** read at
runtime (unlike backend `FEATURE_*` bind-mounts).

## Frontend recreate — HARD BAN

Do **not** run `docker compose ... --force-recreate frontend` or an ad-hoc
`build frontend` on the VPS to apply engine waves, flags, or host patches.

The only legal frontend ship is: merge to `production-main` → CI green →
the production deploy pipeline that builds that SHA.

`scripts/preserve-code-patches.sh` is a last-resort backup of git-anchored
files. It is **not** permission to rebuild or recreate the frontend image.

## Source of truth

1. GitHub `production-main` (this tree). Not `/opt/siragpt` sed patches.
2. Before a **backend** recreate:

   ```bash
   node scripts/assert-continuity-guards.js
   bash scripts/reapply-code-ui-lock.sh --check
   ```

3. Never `compose down -v`. Never recreate frontend just to ship a backend
   flag. Never recreate backend just to ship FE.

## ACS / Computadora

- Same-origin `https://siragpt.com/agent-computer/...` via Caddy
  `forward_auth` → `/api/agent-computer/embed-auth`.
- Mount `agent-computer` + `dept-computer` in `backend/index.js`.
- `orch-client` same-origin embed with `autoconnect=1&reconnect=1`.
- After any backend recreate, confirm `desktopCtx` in `agent-runner` and
  `DEPARTMENT COMPUTER` in the prompt still present.

## OpenSpec in /code

Instruction skills under `backend/src/skills/openspec-*/SKILL.md` are
loaded by the agent-runner via `openspecSkillsRoot()`. Do not move them
to a VPS-only path.
