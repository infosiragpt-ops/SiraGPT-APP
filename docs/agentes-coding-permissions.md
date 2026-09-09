# Harness HITL permissions (AGENTES_CODING_V2 Phase 4b)

Human-in-the-loop **permission gate** for the Phase 4a coding harness.
Cline-pattern decisions only: **ask / once / always / reject**. Default
**OFF**. Canonical UI stays `/agentes`.

This is not a Cline VS Code dump, not a new `/agentes` confirm card,
not F7 / SiraComputer, and not a durable BullMQ job.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md) (`cline/cline`
Apache-2.0 — **HITL patterns only**). Harness loop:
[`docs/agentes-coding-harness.md`](./agentes-coding-harness.md).
In-repo cousins: `sira-code/permission-resume.js` (same four
decisions, different session store).

## What this PR adds

| Piece | Path |
|---|---|
| Policy + grants | `backend/src/services/agentes-coding/harness/permissions.js` |
| HTTP | `GET /api/agentes-coding/sessions/:id/harness/:runId/permissions` |
| HTTP | `POST …/harness/:runId/permissions/:permissionId/resolve` |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays
**off** on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from
this PR. Caps (`MAX_STEPS` / tokens / timeout) are unchanged. HITL
wait does **not** consume the run timeout; resume arms a fresh timer.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). A later
xterm / confirm card needs its own UI-lock exception.

## Default policy (simple, documented)

Injectable via `createAgentesCodingRouter({ permissionPolicy })` or
`runSession({ permissionPolicy })`. Default:

| Tool | Verdict |
|---|---|
| `read` / `list` | allow |
| `write` under `src/` `docs/` `notes/` `tests/` `test/` | allow |
| `write` named `README.md` `package.json` `tsconfig.json` `CHANGELOG.md` | allow |
| `write` anywhere else (`.env`, `secrets/`, …) | ask |
| `exec` | ask |
| unknown tool | ask |

`deny` from a policy stops the run with `E_PERMISSION_DENIED` (no
HITL). Path jail still wins: an escaping path is executed and recorded
as `E_PATH_ESCAPE` on the tool result (no permission prompt).

## Decisions

`POST …/resolve` body `{ decision }`:

| Public | Aliases | Effect |
|---|---|---|
| `allow_once` | `once`, `allow` | run the paused tool, do not remember |
| `allow_always` | `always`, `always_allow` | run + session grant for that tool |
| `reject` | `deny` | run `cancelled` with `E_PERMISSION_DENIED` |

Session grants live on the in-process harness store (same pattern as
export/deploy). Destroying the session forgets them.

```json
{
  "ok": true,
  "run": {
    "id": "hrn_…",
    "status": "awaiting_permission",
    "pendingPermissions": [
      {
        "id": "prm_…",
        "tool": "exec",
        "args": { "command": "echo ok" },
        "reason": "exec_requires_approval",
        "message": "Este comando necesita tu permiso para ejecutarse."
      }
    ]
  }
}
```

## Errors (Spanish)

`E_PERMISSION_DENIED` (reject or policy deny) ·
`E_PERMISSION_NOT_FOUND` · plus the harness catalog
(`docs/agentes-coding-harness.md`). Flag off → HTTP `404 not_found`.

## Out of scope

Enabling the flag on Lenovo, Cline webview/extension, `/agentes`
confirm chrome, durable BullMQ, real xterm pane, Daytona, reviving
`/code`.

## Tests

```bash
cd backend && node --test tests/agentes-coding-harness.test.js tests/agentes-coding-harness-permissions.test.js
```
