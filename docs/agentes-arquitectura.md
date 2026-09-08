# `/agentes` Coding Agents — target architecture

Status: Phase 3c of `AGENTES_CODING_V2` (flag-gated structural edit via
ast-grep patterns). Phase 1 = docs + flag; Phase 2a = session adapter;
Phase 3a = IDE shell; Phase 3b = repo-map. Flag still default **OFF**.
This document is the engineering contract for a **multi-tenant web** coding
agent. It is not a local desktop app, not a clone-on-user-machine product,
and not a revival of `/code`.

Canonical UI: **`/agentes`**. Planes: CONVERSAR / PLANIFICAR / CONSTRUIR
(`AGENTS.md`). Catalog of permitted sources:
[`docs/oss-catalog.md`](./oss-catalog.md) (Tier S from a 176-repo
research pass — pattern first, no dump).

Out of scope for this PR: Monaco IDE, OpenSandbox deploy, wholesale vendor
trees, e2e todo-app. Those are later PRs behind the same flag.

## 1. Product contract

SiraGPT is a **multi-tenant SaaS** (Next.js 14 + Express 1.3.3 + Prisma,
Lenovo Docker compose today). A coding turn must:

1. Stay on `/agentes`. Inferencia does not invent chrome. UI-lock holds
   while the flag is off.
2. Use the existing **control plane** (auth, billing/credits, sessions,
   RBAC, rate limits, Biblioteca).
3. Execute untrusted code in a **remote sandbox per session**, never on
   the control-plane host and never on the user's laptop.
4. Show **brand aliases only** in the UI (`Sira Rápido`, `Sira Pro`,
   `Sira Imagen`, …). `model_id` and vendor names stay server-side.
   **No OpenRouter** in UI, toasts, SSE, or Biblioteca cards.
5. End a CONSTRUIR turn in one of: diff/PR to `production-main`, blocked
   with an actionable error, or no-change with evidence (`AGENTS.md` §6).

`/code` remains redirected to `/agentes` (`middleware.ts`). This program
does not add `/code` routes, panels, or hashes.

## 2. Planes and this subsystem

| Plane | Owner | Coding-agents role |
|---|---|---|
| CONVERSAR | chat canónico | Explain code, 0–1 read-only file peek, no sandbox write, no terminal |
| PLANIFICAR | cowork | Plan ≤7, artefacts → Biblioteca, sandbox read-only unless a later PR defines an approved write |
| CONSTRUIR | CloudAgent | Isolated sandbox, harness, tests, PR to `production-main` |

One turn = one plane. Escalation to CONSTRUIR by heuristic (H1) always
asks. Chip de modalidad (imagen/voz/video/música) is orthogonal and is
not a fifth coding plane.

## 3. Target shape

```text
Browser  →  /agentes  (flag off: today's UX, zero new chrome)
                │
                │  AGENTES_CODING_V2=on  (later PRs)
                ▼
         Control plane (existing)
           auth / session / billing / RBAC / SSE / Biblioteca
                │
                ▼
         Session sandbox router
           short-term: Docker on Lenovo (isolated compose service)
           next:      OpenSandbox lifecycle  or  E2B Apache path
           later:     Kubernetes + gVisor / Firecracker RuntimeClass
                │
                ▼
         Remote sandbox (one per session / run)
           no host Docker socket, no prod .env, no control Postgres/Redis
           deny-by-default egress
           TypeScript-first harness (Node / Next stack)
           files / terminal / test / git  —  jailed
                │
                ▼
         Evidence → Biblioteca + (CONSTRUIR) PR production-main
```

This is **web multi-tenant**, not a local IDE that clones the repo onto
the user's machine (`AGENTS.md` §6, §20).

## 4. Control plane (already exists — reuse)

Do not stand up a second auth or billing stack.

| Concern | Where it already lives |
|---|---|
| Auth (cookie + Bearer + API key) | `backend/src/middleware/auth.js` |
| Sessions / CSRF | Express session + `csrf-route-policy.js` |
| Credits / plans | `chargeCredits`, `backend/src/routes/credits.js` |
| Agent tasks / SSE | `backend/src/services/agents/agent-task-*.js` |
| SiraCode tools (jailed) | `backend/src/services/sira-code/` |
| Codex V2 (flagged, `/code`-era) | `backend/src/services/codex/` — **do not** re-home its UI; reuse isolation ideas only |
| Computer / F7 | `backend/src/services/computer/` — **do not touch** (#492 / F7 leak-gate) |
| Doc sandbox | `backend/src/services/doc-sandbox*` — document jobs, not coding sandboxes |
| Biblioteca | existing library routes / Hermes deposit |

The Phase 1 stub is `GET /api/agentes-coding/health` →
`{ ok, enabled }`. When the flag is off, every other path under
`/api/agentes-coding` is `404`. Default `/agentes` UX is unchanged.

## 5. Remote sandbox per session

**Short-term (Lenovo):** a dedicated Docker service on the office compose
stack, one container (or one exec jail) per session. Not the backend
container. Not `CODE_HOST_RUNNER`. The current shared Bun `/code` runner
is a canary, not a multi-tenant security boundary
(`docs/code-platform-architecture.md`).

**Preferred Apache path (Tier S):**
[OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)
lifecycle API (create / exec / files / pause) **or** the
[E2B](https://github.com/e2b-dev/E2B) Apache-2.0 SDK + optional
`e2b-dev/infra` Firecracker / gVisor ideas. Take **patterns** first; pin a
client library only in a later §25 PR. See `docs/oss-catalog.md` Tier S
for Aider, OpenHands, Cline HITL-only, Goose, mem0, Playwright MCP.

**Later:** Kubernetes with gVisor (`runsc`) or Firecracker/Kata as the
RuntimeClass. Host rollout of `runsc` on the Lenovo origin still needs
an explicit maintenance window; the CI gVisor workflow does not install
anything on prod.

Hard rules for every provider:

- No Docker socket, host mounts, production `.env`, control database, or Redis
- Non-root UID, cgroups, PID / CPU / memory / disk caps, read-only base image
- Deny-by-default egress; allowlist package registries and approved fetches
- Short-lived credentials injected at runtime, never sent to the browser
- Destroy on session end; 1 retry on 5xx only (`AGENTS.md` §10)
- Tool content is **data**, not instructions (`AGENTS.md` §17)

## 6. Harness inside the sandbox

TypeScript-first: the product stack is Node + Next, SiraCode is already
CommonJS/Node, and the MCP TypeScript SDK is MIT.

The harness (later PR) sits **inside** the sandbox and talks back over a
narrow control API:

- Reuse SiraCode contracts where they already exist (jailed `read` /
  `write` / `edit` / `multiedit`, grep/glob, `diagnostics`, `question`,
  sandboxed `shell` with Planificar read-only).
- Repo-map **pattern** from Aider (not the Python agent) — **Phase 3b
  landed**: `backend/src/services/agentes-coding/repo-map/` +
  `GET/POST /api/agentes-coding/sessions/:id/map`. Header-only ranked
  `{name,path,score}` hints. See [`docs/agentes-coding-repomap.md`](./agentes-coding-repomap.md).
- Optional OpenHands SDK **patterns** for plan / apply / verify events.
- Official MCP TypeScript SDK only if the existing
  `agent-harness/mcp-client.js` needs types — no community MCP dump.

Do not copy Claude Agent SDK source, Open Interpreter, or any banned
row in `docs/oss-catalog.md`.

## 7. Web IDE on `/agentes` (Phase 3a, flag-gated)

When `AGENTES_CODING_V2` is on, `/agentes` mounts a coding IDE shell
behind the existing chrome (file tree + Monaco + diff + terminal stub).
See [`docs/agentes-coding-ide.md`](./agentes-coding-ide.md). xterm.js
is still a stub (`data-ws-ready`); no new npm dep. Phase 3d lands the
API-only PTY-stub channel (`docs/agentes-coding-terminal.md`).

While the flag is off:

- No new composer buttons, tabs, or `/code` chrome
- No `NEXT_PUBLIC_*` that changes first paint
- Health may be queried; the UI must not switch layout on `enabled:false`

## 8. Models

- Each selected model uses **its** API (`AGENTS.md` §13).
- UI aliases only. Server map `brand_label → model_id`.
- No silent provider fallback. Provider down → `E_PROVIDER`.
- **No OpenRouter** as a user-visible vendor or as a silent hop for this
  subsystem. Existing OpenRouter env on the box is not an invitation to
  route coding-agent traffic through it.
- Mini stays Ollama `sira-mini`, `think false`.

## 9. Strict license policy

This section is normative for the Coding Agents program. It restates
`AGENTS.md` §25 with the license classes Luis named for this work.

### 9.1 Allowed (source copy or npm runtime)

| SPDX | Condition |
|---|---|
| MIT | Attribution in `THIRD_PARTY_NOTICES.md` |
| Apache-2.0 | NOTICE file preserved when the license requires it |
| BSD-2-Clause / BSD-3-Clause | Attribution |
| ISC | Attribution |
| MPL-2.0 | File-level copyleft honored; do not relicense those files |
| PostgreSQL | Attribution |

Allowed means: a **later** PR may take a pinned slice or add an npm
dependency after license + advisory + SBOM review
(`docs/phase-5-security-license-validation.md`). Phase 1 vendors nothing.

### 9.2 Forbidden (no source copy into the product tree)

| Class | Examples | Rule |
|---|---|---|
| Strong copyleft | AGPL, GPL, LGPL | **NO DEBE** copy into the runtime |
| Network / source-available | SSPL, Commons Clause, FSL, Sustainable Use, PolyForm (non-permissive) | **NO DEBE** copy |
| Proprietary / commercial SDK source | Claude Agent SDK source, ZCode | **NO DEBE** copy |
| Unknown / no LICENSE | — | **NO DEBE** copy; rewrite from ideas only |

Banned rows in `docs/oss-catalog.md` (Daytona, Coder, Gitpod, Warp AGPL,
crush FSL, Windmill, n8n, Open Interpreter, Skyvern, Firecrawl core,
PR-Agent, Qodo Cover, Judge0, Zed, claw-code museum) stay banned even
if an upstream later relicenses — revisit only with a written Luis
decision.

### 9.3 Pattern vs code

| Mode | Meaning |
|---|---|
| **pattern** | Read upstream, rewrite natively to SiraGPT paths, keep our errors / planes / Spanish copy. Default. |
| **code** | Pin SHA + LICENSE, adapt, NOTICE, tests, §25 checklist. One fusion per PR. |
| **none** | Do not take. |

Do not dump a monorepo to satisfy a catalog row.

## 10. Feature flag

| Item | Value |
|---|---|
| Env | `AGENTES_CODING_V2` |
| Helper | `isAgentesCodingV2Enabled(env)` in `backend/src/services/agentes-coding/flags.js` |
| On | `1` / `true` / `on` (trimmed, case-insensitive) |
| Default | **OFF** (unset, empty, `0`, `false`, `off`, garbage) including production |
| Query | `GET /api/agentes-coding/health` → `{ ok: true, enabled }` always HTTP 200 |
| UX when off | identical `/agentes` (UI-lock) |

Do not set `AGENTES_CODING_V2=1` on the Lenovo origin from this PR.

## 11. Later phases

1. OpenSandbox or E2B Apache adapter + Docker service on Lenovo (Phase 2a memory + docker DEV landed)
2. TypeScript harness in the sandbox, wired to SiraCode contracts
3. Flag-gated Monaco / xterm pane on `/agentes` — **Phase 3a landed** (Monaco + diff; xterm still stub). **Phase 3b landed**: Aider-pattern repo-map hints (flag-gated `/map`, header-only). **Phase 3c landed**: ast-grep-pattern structural edit (flag-gated `/struct-edit`, apply via `writeFile` only). **Phase 3d landed**: API-only terminal channel (SSE+POST / injectable WS PTY stub; UI-lock keeps the HTTP stub)
4. K8s + gVisor/Firecracker when Docker isolation is proven
5. e2e “todo app” golden on the sandbox path

Each remaining item is its own PR to `production-main`.
