# OSS catalog — Coding Agents (`AGENTES_CODING_V2`)

Status: Phase 1 (docs + policy). This file is a **permission catalog**, not a
vendoring plan. Do not dump monorepos into the product tree. Do not clone
upstream into `vendor/`, `third_party/`, or `src/upstream/` wholesale.

A 176-repo research pass for Luis informed **Tier S** and the **ban list**
below. Phase 1 records those decisions only. It does **not** clone, vendor,
or list all 176 repositories.

Canonical UI remains **`/agentes`**. `/code` is not a product surface and
must not be revived. Fusion, when a later PR actually takes code, follows
`AGENTS.md` §25 and must land an attribution in `THIRD_PARTY_NOTICES.md`.

Companion: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md)
(target architecture + strict license policy).

Reviewed: 2026-09-08. Licenses below are the public SPDX/GitHub labels at
review time; re-check the upstream `LICENSE` file before any copy.

## How to read this table

| Column | Meaning |
|---|---|
| **GitHub slug** | `owner/repo` of the source we would consult |
| **License** | Public license of that repo (not of every transitive dep) |
| **Pinned purpose** | Why it is on the list |
| **What we take** | `pattern` = rewrite natively; `code` = pin + NOTICE under §25; `none` = do not take |
| **Target module** | Where a later PR would adapt the idea |
| **Status** | `already fused` / `tier-s` / `next` / `banned` |

**Already fused** means a SiraGPT-owned rewrite or historical sidecar already
exists. It does **not** authorize dumping more of that tree.

**Tier S** is the next-wave priority from the 176-repo pass. Pattern first.
No monorepo dump.

## Already fused (Tier S — already in tree)

| GitHub slug | License | Pinned purpose | What we take | Target module | Status |
|---|---|---|---|---|---|
| `anomalyco/opencode` | MIT | Session/prompt loop, permissioned tools, plan→build, file/search/shell contracts | pattern (native SiraCode rewrite; ~0% copy). Historical sidecar only at `vendor/opencode/` | `backend/src/services/sira-code/` | already fused |
| `sst/opencode` | MIT | Tool-catalog / permission-evaluate / clone+publish contracts (Codex harness) | pattern (CommonJS port of contracts, not Effect runtime) | `backend/src/services/codex/opencode-harness.js` | already fused |
| `openclaw/openclaw` | MIT | Channel pairing, cancel/heartbeat, 429 backoff, overlap lease, session isolation | pattern (native CommonJS rewrites). Snapshot under `src/upstream/openclaw/` is reference only | `backend/src/services/agents/`, `backend/src/services/scheduler/`, `backend/src/services/business-channels/` | already fused |
| `NousResearch/hermes-agent` | MIT | PR production loop, skill curator/hygiene, memory bounds, Biblioteca deposit | pattern (native skills + CommonJS). Snapshot under `.agents/hermes-upstream/` | `.agents/skills/`, `backend/src/services/agents/hermes-*.js` | already fused |

See `THIRD_PARTY_NOTICES.md` for the exact SHAs and files already attributed.

## Tier S (176-repo pass — next priorities)

Permitted licenses: MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, PostgreSQL.
Take **pattern** unless a later PR justifies a pinned `code` slice under §25.
No OpenRouter. UI shows brand aliases only (`Sira Rápido`, `Sira Pro`, …).

These are the research-pass priorities **beyond** the already-fused trio.
Do not vendor the trees. Docker on Lenovo is the short-term sandbox; K8s later.

| GitHub slug | License | Pinned purpose | What we take | Target module | Status |
|---|---|---|---|---|---|
| `opensandbox-group/OpenSandbox` (alias `alibaba/OpenSandbox`) | Apache-2.0 | Multi-tenant sandbox lifecycle (create/exec/files/pause) + preview/exposePort URL | **pattern** (lifecycle + signed preview stub). Optional later: Apache SDK client only — not the whole monorepo. Phase 3e: `backend/src/services/agentes-coding/preview/` | `backend/src/services/agentes-coding/coding-sandbox/` · `preview/` | already fused (pattern) |
| `e2b-dev/E2B` | Apache-2.0 | JS/Python SDK for isolated code sandboxes (`sandbox.getHost(port)` preview URL) | **pattern** (signed ephemeral URL + localhost metadata). Optional Apache SDK (`e2b` npm) when a later PR enables it. Phase 3e native stub — no E2B dump | `backend/src/services/agentes-coding/preview/` | already fused (pattern) |
| `e2b-dev/infra` | Apache-2.0 | Firecracker microVM orchestration (self-host path) | pattern only (Lenovo is Docker-first; do not vendor the Terraform/Nomad tree) | sandbox provider (later isolation) | tier-s |
| `google/gvisor` | Apache-2.0 | Kernel-level container isolation (`runsc`) | pattern / ops pin of `runsc` binary — not a source dump | Lenovo runner / future K8s RuntimeClass | tier-s |
| `firecracker-microvm/firecracker` | Apache-2.0 | MicroVM isolation for hostile code | pattern / ops binary — not a source dump | later isolation (after Docker) | tier-s |
| `aider-ai/aider` | Apache-2.0 | Repo map + git-diff + lint/test repair loop | **pattern only** (repomap / focused repair). No Python agent dump. Phase 3b: native Node hints | `backend/src/services/agentes-coding/repo-map/` | already fused (pattern) |
| `ast-grep/ast-grep` | MIT | Structural search/replace via AST patterns (`sg` CLI) | **pattern only** (thin Node wrapper + injectable exec). Binary sidecar if present in the sandbox image. No monorepo dump. Phase 3c | `backend/src/services/agentes-coding/structural-edit/` | already fused (pattern) |
| `OpenHands/software-agent-sdk` | MIT | Workspace task loop, ACP-style worker | **pattern only**. Do not take the PolyForm enterprise tree | harness / AgentAdapter (future) | tier-s |
| `All-Hands-AI/OpenHands` | MIT (core) / PolyForm (enterprise) | Full coding-agent product | pattern from MIT core only; **enterprise tree = none** | reference, not control plane | tier-s |
| `cline/cline` | Apache-2.0 | Human-in-the-loop permission UX (ask / once / always / reject) | **HITL patterns only**. Not the VS Code extension, not the desktop UI | permission-resume / `/agentes` confirm card (future) | tier-s |
| `SWE-agent/SWE-agent` | MIT | Eval / benchmark harness | pattern for evals only — never the production control plane | `backend/scripts/` eval (future) | tier-s |
| `SWE-bench/SWE-bench` | MIT | Coding-agent benchmark corpus | pattern / fixture ideas for goldens — not a runtime dep | eval harness (future) | tier-s |
| `mem0ai/mem0` | Apache-2.0 | Long-term agent memory (profile / search / conclude) | **pattern only**. Complements Hermes MEMORY/USER; no Python dump, no hosted lock-in in Phase 1 | `backend/src/services/agents/hermes-*.js` (future) | tier-s |
| `xtermjs/xterm.js` | MIT | In-browser terminal | **pattern only** (JSON/SSE/WS PTY stub). Phase 3a stub (`data-ws-ready`) stays; no `@xterm/xterm` npm (UI-lock + SBOM later) | `backend/src/services/agentes-coding/terminal/` | already fused (pattern) |
| `microsoft/playwright-mcp` | Apache-2.0 | Official Playwright MCP server (a11y snapshots, no vision required) | pattern / optional Apache npm after SSRF + secret review. Not a community MCP dump | existing MCP client + preview QA (future) | tier-s |
| `aaif-goose/goose` (was `block/goose`) | Apache-2.0 | Recipe / ACP-style local agent (AAIF / Linux Foundation) | **pattern only** (recipes, tool loop). Not the desktop app, not a vendor of the Rust tree | harness recipes (future) | tier-s |

## Next (permitted after Tier S)

| GitHub slug | License | Pinned purpose | What we take | Target module | Status |
|---|---|---|---|---|---|
| `kata-containers/kata-containers` | Apache-2.0 | Alternate microVM RuntimeClass | pattern | later K8s isolation | next |
| `google/nsjail` | Apache-2.0 | Process jail for untrusted commands | pattern | harness exec gate (future) | next |
| `microsoft/monaco-editor` | MIT | In-browser code editor | reuse existing `@monaco-editor/react` npm (already in package.json) on the flag-gated `/agentes` IDE | `/agentes` web IDE (Phase 3a) | next |
| `tree-sitter/tree-sitter` | MIT | Syntax-aware repo map / edits | optional `parseTags` hook only — not a monorepo dump, not an npm dep in Phase 3b | `agentes-coding/repo-map` (regex default) | next |
| `BurntSushi/ripgrep` | MIT / Unlicense | Fast workspace search | pattern (SiraCode already has a jailed walker). Binary sidecar only if a later PR proves need | `sira-code/search.js` (already patterned) | next |
| `modelcontextprotocol/typescript-sdk` | MIT | Official MCP TypeScript SDK | code via npm if a later PR needs protocol types | existing `backend/src/services/agent-harness/mcp-client.js` | next |
| `modelcontextprotocol/python-sdk` | MIT | Official MCP Python SDK | none in this Node stack (TS SDK wins) | — | next |
| `modelcontextprotocol/specification` | MIT / CC | MCP protocol contract | pattern | MCP client (already present) | next |
| `microsoft/playwright` | Apache-2.0 | Browser acceptance of generated apps | already in-repo; reuse. Prefer `playwright-mcp` (Tier S) for agent-driven checks | preview / QA gate (future) | next |
| `prisma/prisma` | Apache-2.0 | Control-plane ORM (already in-repo) | already used | control plane | next |
| `isomorphic-git/isomorphic-git` | MIT | In-sandbox git without shelling out | code via npm inside the sandbox image (later) | sandbox git (future) | next |
| `steveukx/git-js` (`simple-git`) | MIT | Node git wrapper | code via npm if isomorphic-git is not enough | sandbox git (future) | next |
| `microsoft/vscode-languageserver-node` | MIT | LSP client types for diagnostics | pattern / npm types | `sira-code/diagnostics.js` (already patterned) | next |
| `codemirror/dev` | MIT | Lighter editor alternative to Monaco | pattern / npm if Monaco is too heavy | `/agentes` IDE fallback (later) | next |
| `yjs/yjs` | MIT | Optional CRDT for multi-tab IDE | pattern only if a later PR needs it | `/agentes` IDE (later) | next |
| `temporalio/sdk-typescript` | MIT | Durable hour-long jobs | pattern / npm — only after Docker sandbox is proven | later orchestration | next |
| `kubernetes-client/javascript` | Apache-2.0 | K8s sandbox scheduling | code via npm when K8s lands | later control-plane scheduler | next |
| `moby/moby` (Docker Engine API) | Apache-2.0 | Short-term Lenovo sandbox runtime | ops / API client — not a source dump | Lenovo Docker compose (short-term) | next |

## Banned (no source copy, no vendor tree, no “inspired dump”)

AGPL, GPL, LGPL (as a product-tree copy), FSL, SSPL, Commons Clause,
Sustainable Use, and commercial / proprietary source are **no**. Using a
hosted API with a published SDK that is itself MIT/Apache is a separate
decision and still requires a later PR.

| GitHub slug | License / terms | Pinned purpose (why it appeared) | What we take | Target module | Status |
|---|---|---|---|---|---|
| `daytonaio/daytona` | AGPL / frozen upstream | Cloud workspace product | none | — | banned |
| `coder/coder` | AGPL-3.0 | Self-hosted cloud IDE | none | — | banned |
| `gitpod-io/gitpod` | AGPL-3.0 | Cloud workspace | none | — | banned |
| `warpdotdev/Warp` | AGPL (terminal) | Agent terminal UX | none | — | banned |
| `charmbracelet/crush` | FSL-1.1 | TUI coding agent | none | — | banned |
| `windmill-labs/windmill` | AGPL-3.0 | Workflow / jobs OS | none | — | banned |
| `n8n-io/n8n` | Sustainable Use License | Workflow automation | none | — | banned |
| `openinterpreter/open-interpreter` | (operator ban) | Local-machine agent that runs on the user device | none — violates “no clone on user machines” | — | banned |
| `Skyvern-AI/skyvern` | AGPL-3.0 | Browser automation agent | none | — | banned |
| `mendableai/firecrawl` (core) | AGPL-3.0 | Crawl / scrape engine | none (hosted API + existing key is a later product decision, not a source copy) | — | banned |
| `qodo-ai/pr-agent` | operator ban | Autoreview bot | none | — | banned |
| `qodo-ai/qodo-cover` | operator ban | Coverage agent | none | — | banned |
| `judge0/judge0` | GPL-2.0 | Online judge / code exec | none | — | banned |
| `zed-industries/zed` | GPL-3.0 / AGPL components | Desktop editor | none | — | banned |
| Anthropic Claude Agent SDK **source** | proprietary | Claude Code harness | none — do not copy SDK source into this tree. Official npm client, if ever added, is a later licensed-dep PR | — | banned |
| ZCode (proprietary) | proprietary | Closed coding product | none | — | banned |
| `claw-code` museum / archive trees | archival / mixed | Historical curiosity | none — not a live product source | — | banned |
| Continue / Roo Code archived dumps | mixed / stale | Abandoned IDE forks | none | — | banned |
| OpenHands **enterprise / PolyForm** tree | PolyForm / commercial | Enterprise-only sources | none | — | banned |
| `cline/cline` VS Code / desktop surface | Apache-2.0 (surface still banned) | Full Cline UI | none — HITL **patterns** are Tier S; the extension/app is not | — | banned (UI) |
| Community MCP servers (unreviewed) | mixed | Ad-hoc tool servers | none until license + SSRF + secret review | — | banned until reviewed |

Community MCP servers are **not** auto-allowed. Each server needs its own
license + SSRF + secret review before it is allowlisted.

## License gate (short)

Allowed for source copy or npm runtime: **MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, MPL-2.0, PostgreSQL** — with `THIRD_PARTY_NOTICES.md`
(and `NOTICE` when the license requires it).

Not allowed as a source copy into the product tree: **AGPL, GPL, LGPL, FSL,
SSPL, Commons Clause, Sustainable Use, PolyForm (non-permissive),
commercial / proprietary terms**.

Full text: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) § License
policy. Procedure: `AGENTS.md` §25.

## What Phase 1 does **not** do

- Clone 176 (or 120) repos into `third_party/`
- Vendor OpenSandbox, E2B, Monaco, xterm, tree-sitter, or ast-grep
- Ship a Monaco IDE on default `/agentes` UX (Phase 3a is flag-gated;
  off ⇒ identical first paint)
- Enable `AGENTES_CODING_V2` in production
- Touch F7 / #492 / SiraComputer
- Introduce OpenRouter as a user-visible vendor
