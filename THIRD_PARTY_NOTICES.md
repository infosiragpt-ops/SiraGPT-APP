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
  The /agentes idempotent cancel in
  `backend/src/services/agents/agent-task-cancel.js` fuses OpenClaw's
  already-aborted + idempotent run-handle clear
  (`infra/abort-signal.js`, `agents/pi-embedded-runner/runs.ts`) as a
  native CommonJS rewrite: a reconnect mid-run (or a second Stop) returns
  `already` + `E_CANCELLED` without a second abort or event. Snapshot SHA
  `b56ddcc6ffdfc5be78c1c9c93926518367b876eb`. No OpenClaw runtime,
  OpenRouter, or extra env. Not a dump of the upstream runner.
  The /agentes 429 backoff in `backend/src/utils/task-error-classifier.js`
  fuses OpenClaw's Retry-After idea (parse `Retry-After` / `retry-after-ms`
  / HTTP-date and do not retry before the hint) as a native CommonJS
  rewrite: Spanish user copy, 60s clamp matching the agent-task worker,
  no OpenClaw transport, SDK, env, or vendor names. Not a dump of
  `agents/provider-transport-fetch.ts`.
  The /agentes still-alive pulse in `backend/src/services/agents/task-store.js`
  (`touchTaskHeartbeat`) and `agent-task-event-resume.js` fuses OpenClaw's
  task `lastEventAt` activity stamp (media/subagent records, ACP wait) as a
  native CommonJS rewrite: ISO string, no event-log growth, `alive` on
  GET `/api/agent/task/:id/events` after SSE drop. Not a dump of
  `agents/media-generation-task-status-shared.ts` or the ACP control plane.
  Further ports are governed by docs/code/openclaw-port-charter.md.
  The agent-task error presenter in
  `backend/src/utils/task-error-classifier.js` (`presentTaskError`) is a
  native rewrite of OpenClaw's ACP `errorKind` → `stopReason` contract
  (`aborted` stays cancelled; timeout / refusal / generic error stay
  distinct) so `/agentes` can show separate Spanish labels for 503,
  cancel and timeout. Snapshot SHA
  `b56ddcc6ffdfc5be78c1c9c93926518367b876eb`. No OpenClaw runtime was
  vendored.
  The per-job overlap lease in
  `backend/src/services/scheduler/overlap-lease.js` (wired into
  `scheduler.js` and `cron-as-turn.js`) is a native CommonJS rewrite of
  OpenClaw's in-process active-job set and "already-running" skip: Redis
  SET NX + PX with token renew/release, Spanish fail-closed copy when
  the lease is held, and an honest single-process Map if Redis is down.
  Not a dump of `cron/active-jobs.ts` or `cron/service/ops.ts`. Snapshot
  SHA `b56ddcc6ffdfc5be78c1c9c93926518367b876eb`.

- **OpenCode** (https://github.com/anomalyco/opencode, MIT License) —
  SiraCode (`backend/src/services/sira-code/`) is an **independent rewrite**
  inspired by OpenCode's session/prompt loop, build vs plan agents,
  permissioned tools (read / edit / bash / grep), the plan→build
  session reminder (execute the approved plan; do not rewrite it),
  the permission reply (ask → once / always / reject, then execute),
  `SessionPrompt.ensureTitle` (title the session from the first
  real user message, once, without overwriting a custom title),
  tool-result truncation / transcript prune (`Truncate.output` +
  `SessionCompaction.prune`: cap by lines and bytes, keep the recent
  tail, shrink older tool output), and a reconnect summary
  (`SessionSummary`: compact snapshot so the client hydrates without
  the full event log), and a per-turn tool-round guard
  (`agent.steps` / last-step finalize: cap tool executions in one
  user turn and stop with a Spanish /agentes label), a
  sandboxed `bash`/`shell` contract (allowlisted read-ish
  commands, timeout + size caps, no network unless `allowNetwork`,
  Planificar stays read-only even after permission-resume; ~0%
  copy of `vendor/opencode` `shell.ts` — see AGENTS.md §25), and
  workspace-jailed grep/glob matching the OpenCode search contract
  (`pattern` / `path` / `include` / `limit`, bounded previews).
  The native helpers are local and deterministic — no title-agent
  LLM, no Effect runtime, no Snapshot git-diff, no MAX_STEPS
  prompt dump, no ripgrep sidecar, no global tool-output
  directory, no silent swallow. No OpenCode source, SST console,
  Nix, desktop, Electron, or TUI was vendored into this tree.
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
  `backend/src/services/agents/hermes-skill-hygiene.js`,
  `backend/src/services/agents/hermes-biblioteca.js` and
  `.agents/skills/biblioteca-deposit/SKILL.md` adapt Hermes curator
  observation → stale → archive (never delete), consolidation/rename-map
  hygiene, and `logs/curator/REPORT.md` landing. Native hash/name dedupe
  plus high-signal Biblioteca promote with provenance is SiraGPT-owned.
  No Python curator was copied; every write is keyed by `userId`.
  The skill-prompt sandbox and content-free `skill_run` audit in
  `backend/src/services/agents/skill-prompt-sandbox.js` adapt Hermes
  skill-load-into-context plus scan-before-inject (same MEMORY/USER
  pattern already live). Optional SKILL.md bodies stay reference data
  (AGENTS.md §17); they are never treated as system instructions.
  The memory write guard in
  `backend/src/services/agents/memory-write-guard.js` adapts the Hermes
  MEMORY.md / USER.md character-limit contract (tools/memory_tool.py)
  plus a per-user write rate-limit. Errors are Spanish with §16 codes
  (`E_PARAMS` / `E_QUOTA`). No Python memory tool was copied.
  Session-memory compaction and ranked retrieval in
  `backend/src/services/agents/hermes-memory-compaction.js` adapt the
  Hermes MEMORY.md / USER.md bounded-store idea (fold older log text,
  never drop profile facts). Native CommonJS; no `tools/memory_tool.py`
  dump, no OpenRouter, no paid summarizer on the default path.

  The owner checks in `backend/src/routes/hermes.js`,
  `backend/src/services/agents/cron/hermes-cron-bridge.js` and
  `backend/src/services/agents/hermes-tools.js` are SiraGPT-owned security
  corrections to the existing native bridge, not newly copied Hermes code.
  They use SiraGPT's canonical authentication and job ownership contracts;
  no upstream credentials, authentication server or scheduler is activated.
