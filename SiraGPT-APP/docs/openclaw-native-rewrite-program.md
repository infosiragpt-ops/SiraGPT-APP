# OpenClaw Native Rewrite Program

Audit date: 2026-07-16
Reference repository: https://github.com/openclaw/openclaw
Audited commit: `63b0cac9f08357176adccb1b99571f6bcea2e971`
License: MIT
Runtime policy: reference-only upstream; SiraGPT-owned implementation

## Objective

Reach capability parity where it improves SiraGPT without importing OpenClaw's
runtime, branding, device assumptions, credentials, release process, or UI.
Every active capability must have a SiraGPT owner surface, a policy boundary,
focused tests, and a rollback path.

This is not a line-for-line port. The audited tree contains desktop/mobile
applications, private-device integrations, release infrastructure, provider
extensions, tests, documentation, and OpenClaw-specific control-plane code.
Copying those files into SiraGPT would create duplicate runtimes and weaken its
security and deployment model.

## Audited Surface

- 25,886 tracked upstream files inventoried.
- 173 package manifests.
- 4,752 upstream test surfaces.
- 43 internal agent/release skills: 39 covered by SiraGPT playbooks, 4 retained
  as reference-only.
- 51 public capabilities classified against concrete SiraGPT services.

## Current Public Capability Matrix

| Status | Count | Meaning |
|---|---:|---|
| covered | 8 | Direct runtime skill available to the SiraGPT agent. |
| adapted | 17 | Equivalent SiraGPT service or workflow is active under a different contract. |
| partial | 8 | Foundations exist, but the user-facing contract or proof is incomplete. |
| reference-only | 6 | Requires a new scoped connector, OAuth grant, or explicit write approval. |
| not-applicable | 12 | Device-local or private-LAN control that must not run in the cloud core. |

The executable report is generated with:

```bash
npm run agent:openclaw:map -- \
  --upstream-root /tmp/openclaw-reference-20260716 \
  --upstream-commit 63b0cac9f08357176adccb1b99571f6bcea2e971 \
  --json
```

## Activation Phases

1. Inventory and runtime truth: classify every public skill and reject false
   active claims when its SiraGPT evidence is absent.
2. Universal information tools: native summarization and structured weather,
   then URL/video/audio extraction with bounded fallbacks.
3. Durable work: TaskFlow-equivalent create/list/get/update contracts now use
   owner isolation, atomic writes, revision conflicts, waits, resumptions,
   blocks, child-task links, and terminal states. These skills are available in
   immediate agent runs, queued background runs, local queue fallback, workspace
   workflows, delegated subagents, retry, and checkpoint recovery. Next, connect
   authorized inbox sources to this runtime.
4. Authorized connectors: Google Workspace, Notion, Trello, email, X, and
   secrets providers with per-user scopes and audit logs.
5. Media parity: owner-scoped transcription, bounded video-frame extraction,
   deterministic spectrograms, TTS, and generated artifacts are active. The
   media inspection tools run without shell access and enforce source size,
   artifact size, process output, count, and deadline limits. Next, route local
   transcription providers through the same contract when provisioned.
6. Device bridge: optional signed desktop/mobile node for local apps and LAN
   hardware. None of these permissions belong in the production server.
7. Release proof: focused tests, capability validation, secret scan, UI lock,
   production health, and one real user-flow check per activated block.

The focused CI gate is `npm --prefix backend run test:openclaw-native`. It
validates the public capability matrix, runtime registry, policy separation,
durable-flow ownership and concurrency, queued-agent tool exposure,
   summarization, weather normalization, media ownership and process limits,
   transcription and artifact contracts, and workspace orchestration.

## Completion Rule

A capability is complete only when the live agent can select it, execute it
under policy, return a truthful result, survive a controlled failure, and pass
its focused tests. A catalog entry, copied folder, prompt claim, or inactive
snapshot does not count as implementation.
