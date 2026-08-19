---
name: /code Ask/Agent read-only contract
description: Why non-constructive composer modes (ask/plan/image) must short-circuit before patch/debug in the builder FSM and never reach the engine.
---

In the /code conversational builder there are two user-facing primary modes
(Replit-style segmented toggle): **Agent** (maps to composer mode `app`) builds
and edits; **Ask** (mode `ask`) only answers and must NEVER write files. Advanced
sub-modes (build/plan/debug/image) live in the "+" menu.

**Rule:** `nextAgentAction` must return `passthrough` for ask/plan/image at the
TOP of the function — above the `phase === "preview"` patch rule and above the
`isBuildLog(text)` debug rule. The explicit `fixErrorText` "Reparar" bridge is the
only thing allowed to win over it.

**Why:** the preview-patch rule and the pasted-log-debug rule fire on *content*,
not mode. If they run before the mode check, then in Ask mode (a) any normal
question asked after an app was already built (`phase === "preview"`) becomes a
`patch` → file write, and (b) pasting an error log becomes a `debug` → file write.
Either silently breaks the "Ask never touches files" contract.

**Also:** the dispatch `default` branch must gate `runEngine` to constructive
modes only (`app`/`build`) — the OpenCode engine chat path applies returned code
blocks via applyFilesToWorkspace, so ask/plan/image must stream via
`sendPrompt(autoApply:false)` instead. `sendPrompt` already keys autoApply off
`composerMode === "app"`, so non-app modes never auto-apply there.

**How to apply:** when adding any new composer mode or reordering the FSM, keep
non-constructive modes short-circuited first, and keep runEngine behind a
constructive-mode + engineMode + engineAvailable gate. The `generate`/first-build
branch is deterministic-first: only use the engine when the user opts in via the
"Motor" toggle (`engineMode && engineAvailable`), matching the patch branch.
