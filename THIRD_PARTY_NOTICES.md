# Third-party notices

Attributions for third-party ARCHITECTURE adapted into this codebase.
(Package licence texts live in the generated THIRD_PARTY_LICENSES.md —
do not add entries there by hand; the licenses CI gate regenerates it.)

- **OpenClaw** (https://github.com/openclaw/openclaw, MIT License) — the
  channel DM-pairing/allowlist security model, adapter contract, registry and
  Telegram adapter in `backend/src/services/business-channels/` are clean-room
  native rewrites derived from OpenClaw's `src/pairing` and `src/channels`
  architecture (code alphabet, TTL, pending cap, signature-first ingress and
  create-if-missing decisions preserved by design).
  The complete OpenClaw copyright and MIT license text is retained at
  `docs/upstream/OPENCLAW-LICENSE`.
  The native ReAct tool-result integrity and call-identity hardening in
  `backend/src/services/react-agent.js` and
  `backend/src/services/agents/tool-call-normalizer.js`
  also draws on OpenClaw's no-progress detection and replay-safe tool pairing
  architecture. The explicit no-op evidence fingerprint and argument-churn
  handling are native adaptations of that architecture, not copied result
  extractors; SiraGPT preserves its own structured output and checkpoint
  semantics. The history packer in
  `backend/src/services/agentic-chat-stream.js` uses the
  complete-turn retention concept reviewed in the existing inactive OpenClaw
  reference snapshot; its upstream revision was not independently verified.
  This is a SiraGPT-owned implementation, not a vendored gateway
  or provider adapter. Audited references and scope are recorded in
  `docs/agent-brain-integrity-20260906.md`.
  The /agentes 429 backoff in `backend/src/utils/task-error-classifier.js`
  fuses OpenClaw's Retry-After idea (parse `Retry-After` / `retry-after-ms`
  / HTTP-date and do not retry before the hint) as a native CommonJS
  rewrite: Spanish user copy, 60s clamp matching the agent-task worker,
  no OpenClaw transport, SDK, env, or vendor names. Not a dump of
  `agents/provider-transport-fetch.ts`.
  Further ports are governed by docs/code/openclaw-port-charter.md.
  The agent-task error presenter in
  `backend/src/utils/task-error-classifier.js` (`presentTaskError`) is a
  native rewrite of OpenClaw's ACP `errorKind` → `stopReason` contract
  (`aborted` stays cancelled; timeout / refusal / generic error stay
  distinct) so `/agentes` can show separate Spanish labels for 503,
  cancel and timeout. Snapshot SHA
  `b56ddcc6ffdfc5be78c1c9c93926518367b876eb`. No OpenClaw runtime was
  vendored.

- **OpenCode** (https://github.com/anomalyco/opencode, MIT License) —
  SiraCode (`backend/src/services/sira-code/`) is an **independent rewrite**
  inspired by OpenCode's session/prompt loop, build vs plan agents,
  permissioned tools (read / edit / bash / grep), the plan→build
  session reminder (execute the approved plan; do not rewrite it),
  the permission reply (ask → once / always / reject, then execute),
  and `SessionPrompt.ensureTitle` (title the session from the first
  real user message, once, without overwriting a custom title). The
  native title helper is local and deterministic — no title-agent LLM,
  no Effect runtime, no silent swallow. No OpenCode source, SST
  console, Nix, desktop, Electron, or TUI was vendored into this tree.
  SiraGPT / SiraCode is **not affiliated with** OpenCode or Anomaly.
  The upstream MIT license text is retained at `vendor/opencode/LICENSE`
  for the historical sidecar reference only; the native engine does not
  depend on that tree.

- **Simple Icons** (https://simpleicons.org/, CC0 1.0) — brand-colored SVGs
  under `public/conexiones-logos/` used as official marks on `/conexiones`
  and `/gpts` app cards.

- **OpenCode** (https://github.com/sst/opencode, MIT License, © SST Inc.) —
  the tool-catalog mapping, permission-evaluate semantics (last-match-wins,
  default ask), read limits, public-repo clone and GitHub publish-plan
  contracts in `backend/src/services/codex/opencode-harness.js` plus the
  `POST /api/codex/projects/clone` and `/projects/:id/github/*` routes in
  `backend/src/routes/codex.js` are CommonJS ports of
  `packages/opencode/src/tool/registry.ts`,
  `packages/opencode/src/permission/index.ts` and
  `packages/opencode/src/tool/{read,write,edit,glob,grep,shell,task,todo,webfetch,websearch,skill,plan}.ts`.
  No Effect-TS runtime was copied. Read-only upstream reference vendored at
  `vendor/opencode/` (see `vendor/opencode/LICENSE`).

- **Hermes Agent** (https://github.com/NousResearch/hermes-agent, MIT License,
  © 2025 Nous Research, commit `8b69ec03af50de892ae0bca1f7e2384a8f6eb5a8`) —
  the `.agents/skills/pr-production-loop/SKILL.md` playbook (branch → commit →
  PR → CI → squash-merge → SHA-pinned publish) is a SiraGPT-native rewrite of
  the PR-lifecycle structure in upstream
  `skills/github/github-pr-workflow/SKILL.md` (branch/commit/open/CI/merge
  sections). No Hermes code, credentials, hostnames or agent runtime was
  copied; all paths, gates (`production-main`, required checks, `publish.sh`
  TARGET+PREVIOUS SHAs) and policies are SiraGPT-owned. The upstream MIT
  license text is retained at `.agents/hermes-upstream/LICENSE` (snapshot
  pinned in `.agents/hermes-upstream/SNAPSHOT.json`).
  The skill-library curator and Biblioteca deposit in
  `backend/src/services/agents/hermes-skill-curator.js`,
  `backend/src/services/agents/hermes-biblioteca.js` and
  `.agents/skills/biblioteca-deposit/SKILL.md` adapt Hermes curator
  observation → stale → archive (never delete) and `logs/curator/REPORT.md`
  landing. No Python curator was copied; every write is keyed by `userId`.
