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
is F7.4. F7.0 does not implement or replace it.

---

## 6. Persistence — Prisma, not Drizzle

- Today’s ORM is **Prisma** (`backend/prisma/schema.prisma`).
- F7.0 adds **no** `DesktopSession` (or similar) tables. A no-op in-memory
  handle from `create()` is enough.
- Prisma models for desktop sessions, if needed, are F7.7.
- Drizzle is F12. Do not introduce a second ORM for Computer.

---

## 7. Computer tools + SiraAction (F7.3)

Model-agnostic computer-use. Vendor payloads (Anthropic / OpenAI CUA /
Gemini) are normalized to **SiraAction** before the CU-loop or the
`computer` tool execute anything. The loop never branches on a vendor
SDK. The UI never prints a model id.

Screen, DOM, OCR and page text are **DATA**, not instructions.

### 7.1 SiraAction

Canonical type (`backend/src/services/agent-runner/adapters/sira-action.js`):

`screenshot | click | double_click | move | drag | type | key | scroll | launch | navigate | wait | done | request_handoff`

Adapters:

- `anthropicToSira` — computer_20241022 / 20250124 (`action`, `coordinate`)
- `openaiToSira` — CUA (`type`, `x`/`y`, `keys`, `path`)
- `geminiToSira` — 0–1000 normalized (`click_at`, `type_text_at`, …)

`toSiraActions(payload)` picks an adapter without a model id.

### 7.2 `computer` tool

`backend/src/services/agent-runner/tools.computer.js` — same pattern as
`tools.js`: failures return `ERROR: …`, never throw out of the loop.

`executeComputer(action, ctx)`:

1. Kill switch `SIRAGPT_DESKTOP_ENABLED` unset/0 → fail closed.
2. Reuse `DesktopSessionManager.findByChatId(chatId)` when the chat
   already has a lease; otherwise `acquire`. No session + disabled =
   closed.
3. Talk to DCP via the session handle (`desktop/dcp-client.js`). Tests
   inject `handle.callDcp`.
4. **Always** return a screenshot (fake-able).
5. `type` + `looksLikeSecret` → `ERROR: use request_handoff` and do
   **not** POST `/type`. The secret is never echoed to the model.
6. `request_handoff` returns `HANDOFF_REQUESTED` and does not type.
   The handoff **FSM / UI is F7.4**.

### 7.3 computer_operator hook

Thin role file `orchestrator/computer-operator.js`: prompt + tool
defs + `shouldUseComputerOperator(text)` heuristic. The F4 planner
DAG is not rewritten; `shouldRunComputerLoop` is a hook the existing
orchestrator can call.

---

## 8. CU-loop (F7.3)

`backend/src/services/agent-runner/cu-loop.js`.

### 8.1 Cycle

screenshot → LLM → SiraAction[] → execute (DCP) → screenshot.

Vision: each screenshot is framed as untrusted DATA. Grounding:
coordinates scale back to the native framebuffer when the image sent
to the model was resized (`scalePoint`).

### 8.2 Budgets

| Cap | Default | Env |
|---|---|---|
| steps | **40** | `SIRAGPT_CU_MAX_STEPS` |
| wall | **5 min** | `SIRAGPT_CU_WALL_MS` |
| handoffs | **3** | `SIRAGPT_CU_MAX_HANDOFFS` |

Old screenshots compact every **8** steps (keep the last 2 images).

### 8.3 Verification

`verifyGoal` is programmatic (file exists via DCP `GET /file`, launch
+ typed-text traces). No LLM judge in F7.3.

### 8.4 Abort

`AbortSignal` (Detener) cancels before the next LLM/DCP call and
**releases** the session (`release` → provider `destroy`). No leftover
desktop. Abort is never reported as success.

### 8.5 Out of scope (do not start in F7.3)

Handoff FSM (`handoff-fsm.js`) landed in F7.4. Network policy ·
LocalGvisor `runsc` flags · Prisma `DesktopSession` · replacing the
live computer orchestrator remain later.

---

## 11. Handoff / takeover FSM (F7.4)

This is the **hard leak gate** before SiraComputer is exposed to users.
Screen and web content are DATA. The model never sees credentials.

```
AGENT_CONTROL → HANDOFF_REQUESTED → HUMAN_CONTROL → RESUMING → AGENT_CONTROL
```

- `handoff-fsm.js` is in-memory (Prisma `HandoffEvent` is optional; not
  required for the unit gate). No Drizzle.
- Events: `handoff_requested` / `granted` / `returned` / `timeout`.
- The member may **force takeover** (`grant`) from `AGENT_CONTROL`.
- On `HUMAN_CONTROL`: every agent DCP action (`/click` `/type` `/key` …)
  returns **423 Locked**. Screenshots to the LLM are paused or masked.
  `looksLikeSecret` still blocks `type`. Password field values are not
  logged.
- On `handoff_returned`: one **new** screenshot; the CU-loop continues;
  secrets are not re-typed.
- Abort / timeout **pause** the task. They never declare success.
- REST sketched at `POST /api/desktop/session/:id/handoff`
  `{action: grant|return|request, reason?}`.
- SSE `handoff_*` rides the existing generate/trace stage channel.
  Do not rewrite F3.
- UI (Spanish): `HandoffBanner` + toggle «El agente controla ↔ Tú
  controlas». Overlay: «El agente no verá lo que escribas».
  `viewOnly=false` only while `HUMAN_CONTROL`.
- Do not couple to one LLM. Do not print `model_id` / DeepSeek /
  OpenRouter in the UI.
- Do not replace the live computer orchestrator.

F7.4 green is **not** a license to expose SiraComputer to every user.
F7.5 (egress allowlist) is still required. F7 itself stays IN_PROGRESS.

---

## 21. Phase table (F7.0–F7.8)

| Sub | Goal | In F7.0 PR? | Gate (summary) |
|---|---|---|---|
| **F7.0** | `DesktopProvider` interface + `infra/desktop` image (Xvfb, openbox, x11vnc/noVNC, xdotool, scrot, DCP `:9000`). `start.sh` touches `/workspace/.desktop_ready` when healthy. Tests: docker build; container start; health + screenshot; honest skip without Docker. | **YES — this PR** | §22.1 |
| **F7.1** | `E2BDesktopProvider` real + in-memory `DesktopSessionManager` warm pool. acquire() p50 < 800 ms when pool is warm. Frontend never shows the generic provision error while starting or when pool>0. | **COMPLETED** (unit gate) | §22.1 provision (unit) |
| **F7.2** | Full DCP + authenticated same-origin WS proxy + DesktopScreen first frame | **COMPLETED** (merged #488) | §22.2 |
| **F7.3** | `computer_*` / `computer` tool + Anthropic/OpenAI/Gemini → SiraAction + CU-loop (vision, grounding, verification, budget, AbortSignal) | **COMPLETED** (CI desktop-f73) | §22.3 |
| **F7.4** | Handoff / takeover FSM (HARD leak gate) | **this PR** | §22.4 |
| F7.5 | Egress allowlist — do not start | no | — |
| F7.6 | LocalGvisor full flags (`runsc`, `--network none`) | no | fail-closed like F5 `resolveSandboxRuntime` |
| F7.7 | Prisma `DesktopSession` tables | no | migrate deploy |
| F7.8 | Frontend panel rewrite | no | UI lock; no `model_id` / DeepSeek |

F7.5–F7.8 detail will grow **in this file** when that sub-phase becomes
active. Do not implement them early.

### F7.4 row (normative)

- Path: `backend/src/services/desktop/handoff-fsm.js` (in-memory).
- States: `AGENT_CONTROL → HANDOFF_REQUESTED → HUMAN_CONTROL → RESUMING → AGENT_CONTROL`.
- Events: `handoff_requested` / `handoff_granted` / `handoff_returned` / `handoff_timeout`.
- Member can **force grant** without the agent asking.
- DCP `input_mode=human` already 423s agent mutations (F7.2). Session
  manager syncs DCP + FSM. CU-loop `waitForResume` on HUMAN_CONTROL.
- During HUMAN_CONTROL: screenshots to the model are **paused**
  (placeholder / mask). No live password form reaches the LLM.
  `looksLikeSecret` stays. Do not log password field values.
- After `handoff_returned`: one **new** screenshot; loop continues;
  secrets are never re-typed.
- REST: `POST /api/desktop/sessions/:id/handoff` and alias
  `/api/desktop/session/:id/handoff` `{action: grant|return|request, reason?}`.
- SSE: `handoff_*` on the existing generate/trace `type:'stage'` channel.
- UI: `HandoffBanner` + toggle «El agente controla ↔ Tú controlas».
  Overlay: «El agente no verá lo que escribas».
  `DesktopScreen` `viewOnly=false` **only** in `HUMAN_CONTROL`.
- Tests: `backend/tests/desktop-f7-handoff.test.js` — no Docker / no E2B.
- CI job `desktop-f74` with `npm ci` (same as desktop-f71/f72/f73).
- Kill switch `SIRAGPT_DESKTOP_ENABLED` fail-closed.
- Out of scope: `network-policy.js`, `secrets/vault.js`, LocalGvisor
  `runsc`, Prisma `DesktopSession`, replacing the live computer
  orchestrator. F7.4 green ≠ expose to all users (F7.5 still required).

### F7.3 row (normative)

- Adapters: `backend/src/services/agent-runner/adapters/`
  (`sira-action`, `anthropicToSira`, `openaiToSira`, `geminiToSira`).
- Tool: `backend/src/services/agent-runner/tools.computer.js` —
  `executeComputer` → DCP via `DesktopSessionManager` (reuse chat
  lease, else acquire). Kill switch fail-closed.
- Loop: `backend/src/services/agent-runner/cu-loop.js` — maxSteps 40,
  wall 5 min, maxHandoffs 3, compact every 8, scale coords, AbortSignal
  releases the session.
- `request_handoff` is an **action** that returns `HANDOFF_REQUESTED`.
  FSM / UI = F7.4.
- Tests: `backend/tests/desktop-f7-cu-loop.test.js` (fake provider +
  fake LLM; no Docker / no live E2B).
- CI job `desktop-f73` with `npm ci` (same as desktop-f71/f72).
- Out of scope: `handoff-fsm.js`, `network-policy.js`, Prisma desktop
  tables, LocalGvisor `runsc`, replacing the live computer orchestrator.

### F7.2 row (normative)

- DCP: `infra/desktop/dcp/dcp.py` on `127.0.0.1:9000` only.
  Routes: health, screenshot, click, double_click, move, drag, type,
  key, scroll, launch, navigate, exec, file get/post, cursor,
  input_mode (`agent`|`human` → 423 Locked on agent actions when
  human), mask. Ready file contract unchanged
  (`/workspace/.desktop_ready` after GET `/health` 200).
- Viewer WS: `GET /ws/desktop/:sessionId` on the same-origin host
  (siragpt.com). Token scoped `userId`/`chatId`/`sessionId`. Proxy
  to the session handle's noVNC/websockify **loopback** port. Do not
  publish container ports. Never `api.siragpt.com`.
- Frontend: `components/desktop/DesktopScreen.tsx` (`@novnc/novnc`
  RFB on a canvas). First framebuffer update ends the black panel.
  `viewOnly=true` in agent mode. Wired into
  `department-computer-pane` for `/api/desktop` leases. If
  `SIRAGPT_DESKTOP_ENABLED` is off, the live computer orchestrator
  path is unchanged.
- Persistence: still in-memory (no Prisma `DesktopSession`).
- Tests: `backend/tests/desktop-f7-dcp.test.js` (DRY DCP + mocked
  xdotool; WS wrong-user 403). Screenshot-diff skips honestly
  without Docker. No live E2B.
- Out of scope: CU-loop, `tools.computer`, handoff FSM, Prisma
  desktop tables, LocalGvisor `runsc` flags, replacing the live
  computer orchestrator.

### F7.1 row (normative)

- Path: `backend/src/services/desktop/session-manager.js`
- Provider: `backend/src/services/desktop/provider/E2BDesktopProvider.js`
  (isolated `require('@e2b/desktop')`; inject `Desktop` / `createDesktop`
  in tests). Missing `E2B_API_KEY` fails CLOSED in Spanish — no network.
- `acquire(chatId)` → `{ sessionId, wsUrl, provider, expiresAt, status }`
  1. take a warm healthy desktop from the in-memory pool
  2. else `provider.create()` + `waitHealthy` (~20s) while refill continues
- `release` / `heartbeat` / `status` (`starting|ready|human_control|
  agent_control|idle|dead` — human/agent are placeholders; FSM is F7.4)
- Pool: `DESKTOP_POOL_MIN` default **2**, `DESKTOP_POOL_MAX` default 20.
  Do not raise MIN (Lenovo/prod memory).
- Reaper: idle > `DESKTOP_SESSION_TTL_MIN` (default 15) and unhealthy.
- Kill switch: `SIRAGPT_DESKTOP_ENABLED` unset/0 → acquire fails closed.
- Provider kind: `DESKTOP_PROVIDER` (`e2b` | `local_gvisor`). Default:
  `e2b` when a key is present; otherwise do not silently lie.
- Tests: `backend/tests/desktop-f7-provision.test.js` (fake provider;
  no Docker / no live E2B). Optional live E2B skips honestly.
- Frontend: computer pane shows «Preparando escritorio…» while starting;
  never the generic «El escritorio no está disponible» when pool>0.
  First-frame placeholder only — no noVNC DesktopScreen (F7.2 / F7.3).
- Out of scope: WS proxy, CU-loop, handoff FSM, Prisma `DesktopSession`,
  LocalGvisor `runsc` flags, replacing the #484 orchestrator.

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

### 22.2 DCP + viewer gate (F7.2)

Always-on without Docker / E2B:

1. DCP source binds `127.0.0.1:9000` and exposes the F7.2 routes.
2. Click / type / scroll succeed against a DRY DCP (fake xdotool).
3. `input_mode=human` returns **423** on agent mutations.
4. Viewer token for user A is rejected on user B's session (403).
5. Kill switch unset/0 rejects `/ws/desktop` (503).
6. Upstream target must be loopback. No container port publish.

Screenshot-diff against a running `sira-desktop` container may skip
honestly when Docker (or the image) is absent.

### 22.3 CU-loop gate (F7.3)

Always-on without Docker / E2B:

1. Vendor adapters emit SiraAction[] (Anthropic / OpenAI / Gemini).
2. `executeComputer` always returns a screenshot (fake-able).
3. `looksLikeSecret` on type → `ERROR: use request_handoff`; DCP `/type`
   is not called. Secret is not echoed.
4. `request_handoff` returns `HANDOFF_REQUESTED` without typing.
5. Scripted “abre chromium y busca X” → `verifyGoal` ok / done.
6. Abort (Detener) calls `release` / `destroy`; no leftover session.
7. Kill switch unset/0 fails closed.
8. No `network-policy.js`. Live E2B / Docker skip honestly if a later
   test adds them. `handoff-fsm.js` is F7.4.

### 22.4 Handoff leak gate (F7.4)

Always-on without Docker / E2B:

1. FSM walks AGENT_CONTROL → HANDOFF_REQUESTED → HUMAN_CONTROL →
   RESUMING → AGENT_CONTROL. Force `grant` is allowed.
2. During HUMAN_CONTROL, POST DCP `/click` `/type` `/key` return **423**.
   `executeComputer` returns locked and does not type.
3. A mock LLM inspects every payload: no secret string, no unmasked
   password screenshot. Screenshots are paused or `/mask`.
4. After `handoff_returned` the CU-loop continues with a **new**
   screenshot and does not re-type secrets.
5. Abort / timeout → `ok:false`, never `done`.
6. Kill switch unset/0 fails closed on `/handoff`.
7. No `network-policy.js` / `secrets/vault.js`. No live E2B / Docker.

---

## 23. Honesty, deploy, and out of scope

### Honesty

`STATE.md` shows:

- **F7 IN_PROGRESS** while any F7.x is open.
- **F7.0 COMPLETED** only if §22.1 passed (including a real docker build
  + health + screenshot), or
- **F7.0 IN_PROGRESS** if the docker gate was skipped or failed — say so
  in `STATE.md`. Unit-contract green is not enough to close F7.0.
- **F7.1 COMPLETED** only if `desktop-f7-provision.test.js` is green
  (warm-pool acquire SLO, no generic error, reaper, kill switch). Live
  E2B may skip honestly.
- **F7.3 COMPLETED** only if `desktop-f7-cu-loop.test.js` is green
  **and** the `desktop-f73` CI job has been seen green (this PR: run
  33215826539). Do not mark COMPLETED on local-only runs if a new CI
  job fails.

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
