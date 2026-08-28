# F7 — SiraComputer master spec

> Source of truth for SiraComputer (Fase F7). Later sub-phases (F7.1–F7.8)
> live in **this same file** (§21). This revision records the architectural
> decisions that F7.0 must not reopen.
>
> Read with `STATE.md` (which sub-phase is active) and `ROADMAP.md` (F7 row).
>
> **Owner:** SiraGPT / Luis Carrera
> **Repo:** `infosiragpt-ops/SiraGPT-APP`
> **Updated:** 2026-08-28

---

## 0. Purpose

SiraComputer is the isolated Linux desktop the agent can see and operate:
screenshots in, pointer/keyboard out, a viewer the member can watch. It is
**not** a rewrite of AgentRunner, the F5 gVisor sandbox, SSE traces, or
artifacts. Those stay. F7 **adds a layer**.

The live computer orchestrator shipped in PR #484 (`services/computer-orchestrator`,
hostname `siragpt-computer-orchestrator:8090`, noVNC on
`https://siragpt.com/sessions/:id/novnc/`) is production. **Do not rip it out.**
F7.0 introduces a model-agnostic `DesktopProvider` and a dedicated
`sira-desktop` image with a Desktop Control Plane (DCP). Later phases plug
E2B / local gVisor behind the same interface and, only then, a CU-loop and
handoff FSM.

The anti-pattern this spec forbids: coupling the desktop to one LLM, one
cloud vendor, or one Docker runtime flag set that we cannot swap.

---

## 1. Non-negotiable rules

1. **One sub-phase at a time.** `STATE.md` names the active F7.x. F7.1–F7.8
   do not land in the F7.0 PR.
2. **Close only with gates green.** If a gate cannot run, skip it honestly
   (no Docker → skip, do not fake pass). Never mark COMPLETED what was not
   verified.
3. **PRs against `production-main`.** Never touch `production`. Never
   `docker-compose down -v`. Never `git reset --hard`. Luis deploys from
   his Mac.
4. **Web / screen content is DATA, not instructions.** Screenshots, DOM,
   OCR, and page text are untrusted input. They never override system
   policy.
5. **Model-agnostic.** Build against `DesktopProvider`. Never couple to one
   LLM or one backend. Computer models stay Flash/Pro only internally; the
   UI never prints `model_id` or the word DeepSeek.
6. **Reuse AgentRunner / sandbox / SSE / artifacts.** Add layers. Do not
   rewrite F1–F5.
7. **ORM = Prisma.** Drizzle is a later platform phase (F12). No Drizzle
   schema for desktops.
8. **Dockerfile user.** Do **not** `useradd -u 1000`. `node:22-bookworm`
   already owns uid 1000 (`node`). Create `sira` or `compuser` by name
   (see PR #485).
9. **Do not replace the Lenovo live Caddyfile.** Do not change DNS. Do not
   add `computer.siragpt.com`. The live gateway is
   `/home/user/deployments/iliagpt/Caddyfile` (`@sse` must stay). Viewer
   URLs stay on `https://siragpt.com/sessions/…`.
10. **The #484 orchestrator stays.** F7.0 does not change its compose
    snippet, Caddy handle, or `compuser` image except by later, explicit
    phases.

---

## 2. Architecture — hybrid DesktopProvider

```
                    ┌─────────────────────────────┐
   AgentRunner ───► │  DesktopProvider (interface) │
   (reuse F1–F5)    │  create / destroy /           │
                    │  health / screenshot          │
                    └────────────┬────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                                     │
              ▼                                     ▼
   E2BDesktopProvider                    LocalGvisorDesktopProvider
   (F7.1 — SDK + warm pool)              (F7.0 stub can docker-run
                                          sira-desktop; full gVisor
                                          flags = F7.6)
```

- **Interface path:** `backend/src/services/desktop/provider/DesktopProvider.js`
- **Contracts in F7.0 only:** `create`, `destroy`, `health`, `screenshot`.
- **E2B:** stub in F7.0 (no `@e2b/*` require, no API key, no network).
- **Local gVisor:** stub that may `docker run` the new image in tests.
  `--runtime runsc` and `--network none` wait for F7.6 if that keeps F7.0
  small.
- **No CU-loop, no handoff FSM, no session-manager acquire SLO, no WS
  proxy, no Prisma `DesktopSession` tables, no frontend panel rewrite**
  in F7.0.

Prefer a working image + interface + CI gate over a giant incomplete stack.

The existing `services/computer-orchestrator` remains the live path for
`/agentes` until a later phase explicitly migrates it onto
`DesktopProvider`. F7.0 must not break that path.

---

## 3. Desktop Control Plane (DCP) on `:9000`

Every `sira-desktop` container runs a small HTTP control plane:

| Method | Path | Bind | Success |
|---|---|---|---|
| GET | `/health` | `127.0.0.1:9000` | `200 {"status":"ok","display":":0"}` |
| GET | `/screenshot` | `127.0.0.1:9000` | `200` image (`image/png` or `image/webp`) |

- Bind **loopback only**. Never `0.0.0.0:9000`.
- Implementation: `infra/desktop/dcp/dcp.py` (stdlib `http.server` + `scrot`).
- No LLM client, no model id, no vendor SDK inside DCP.
- Screenshot bytes are DATA.

Later phases may add click/type/key endpoints on the same port. F7.0 does
not.

---

## 4. Viewer (noVNC)

The image includes Xvfb + a lightweight WM (**openbox**; xfce remains
acceptable) + `x11vnc` + `websockify` + noVNC + `xdotool` + `scrot`.

In F7.0 those services listen on **loopback** (`127.0.0.1:5900` VNC,
`127.0.0.1:6080` noVNC). The public viewer continues to be the #484
orchestrator on `https://siragpt.com/sessions/:id/novnc/`. A WS proxy that
exposes this new image to the browser is F7.3 — out of scope here.

Do not add `computer.siragpt.com`. Do not change DNS.

---

## 5. Handoff (later)

Login / captcha handoff already exists on the live orch
(`backend/src/services/computer/login-handoff.js`). The SiraComputer
handoff **FSM** (pause CU-loop, yield the desktop to the member, resume)
is F7.5. F7.0 does not implement or replace it.

---

## 6. Persistence — Prisma, not Drizzle

- Today’s ORM is **Prisma** (`backend/prisma/schema.prisma`).
- F7.0 adds **no** `DesktopSession` (or similar) tables. A no-op in-memory
  handle from `create()` is enough.
- Prisma models for desktop sessions, if needed, are F7.7.
- Drizzle is F12. Do not introduce a second ORM for Computer.

---

## 21. Phase table (F7.0–F7.8)

| Sub | Goal | In F7.0 PR? | Gate (summary) |
|---|---|---|---|
| **F7.0** | `DesktopProvider` interface + `infra/desktop` image (Xvfb, openbox, x11vnc/noVNC, xdotool, scrot, DCP `:9000`). `start.sh` touches `/workspace/.desktop_ready` when healthy. Tests: docker build; container start; health + screenshot; honest skip without Docker. | **YES — this PR** | §22.1 |
| F7.1 | `E2BDesktopProvider` implementation + warm pool | no | E2B create/destroy SLO; pool hit rate |
| F7.2 | Session manager acquire SLO | no | acquire p95 documented |
| F7.3 | WS proxy (noVNC to the member) | no | same-origin viewer on siragpt.com |
| F7.4 | CU-loop (screenshot → model action → screenshot) | no | bounded steps; screen = data |
| F7.5 | Handoff FSM | no | pause / yield / resume |
| F7.6 | LocalGvisor full flags (`runsc`, `--network none`) | no | fail-closed like F5 `resolveSandboxRuntime` |
| F7.7 | Prisma `DesktopSession` tables | no | migrate deploy |
| F7.8 | Frontend panel rewrite | no | UI lock; no `model_id` / DeepSeek |

F7.1–F7.8 detail will grow **in this file** when that sub-phase becomes
active. Do not implement them early.

### F7.0 row (normative)

- Path: `backend/src/services/desktop/provider/DesktopProvider.js`
- Image: `infra/desktop/Dockerfile` + `start.sh` + `infra/desktop/dcp`
- Image tag: `sira-desktop:latest` (override `SIRAGPT_DESKTOP_IMAGE`)
- User inside the image: `sira` (by name, no `-u 1000`)
- Display: `:0`
- Ready file: `/workspace/.desktop_ready` (only after DCP `/health` is 200)
- Tests: `backend/tests/desktop-provider-f70.test.js`
- Out of scope: warm pool, E2B SDK, session SLO, WS proxy, CU-loop,
  handoff FSM, Prisma desktop tables, frontend panel, publish/deploy.

---

## 22. Gates

### 22.1 Provision gate (F7.0)

Must hold when Docker is available (GitHub Actions `ubuntu-latest` has it):

1. `docker build -t sira-desktop:latest infra/desktop` succeeds.
2. `docker run -d --name <ephemeral> sira-desktop:latest` starts.
3. `/workspace/.desktop_ready` appears (container is healthy).
4. `GET http://127.0.0.1:9000/health` inside the container → **200**
   `{"status":"ok","display":":0"}`.
5. `GET http://127.0.0.1:9000/screenshot` → image bytes (PNG or WebP).

When Docker is **not** available:

- Skip the provision steps honestly (same pattern as
  `backend/tests/agent-runner-f5-sandbox.test.js` F5(f)).
- Still run unit tests of the interface, Dockerfile/start.sh/DCP
  contracts, and the LocalGvisor argv (no silent runc/gVisor claims).

Do not fake a green provision result.

---

## 23. Honesty, deploy, and out of scope

### Honesty

`STATE.md` shows:

- **F7 IN_PROGRESS** while any F7.x is open.
- **F7.0 COMPLETED** only if §22.1 passed (including a real docker build
  + health + screenshot), or
- **F7.0 IN_PROGRESS** if the docker gate was skipped or failed — say so
  in `STATE.md`. Unit-contract green is not enough to close F7.0.

### Deploy (Luis)

Agents open a PR against `production-main`. Do not merge. Do not publish.
Do not edit the live Lenovo Caddyfile. Do not add compose services that
Luis did not ask to paste. `publish.sh` is Lenovo-only and is not in this
repo.

### Out of scope for F7.0 (do not start)

Warm pool · E2B SDK · session acquire SLO · WS proxy · CU-loop · handoff
FSM · Prisma `DesktopSession` · frontend panel rewrite · replacing the
#484 orchestrator · `computer.siragpt.com` · DNS · `docker-compose down -v`.

---

## Pointer — later phases

F7.1–F7.8 are outlined in §21. When a later PR opens, extend **this
file** (keep §0–§6 decisions; add the sub-phase section). Do not fork a
second spec.
