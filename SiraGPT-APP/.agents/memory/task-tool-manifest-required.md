---
name: Task-tool manifest is mandatory for dispatch
description: Why every LLM-callable agent tool must have a tool-manifest entry, or it is silently denied at dispatch.
---

# Every task-tool needs a manifest

In the SiraGPT agent, `react-agent.js` runs two gates before executing any tool the LLM calls:
1. `ctx.toolGate.authorize(name, ...)` → `authorizeToolCall` → `getManifest(name)`.
2. `ctx.checkToolBudget(name, usage)` → `checkToolUsageBudget` → `getManifest(name)`.

Both return `{ ok:false, reason:'unknown_tool' }` when the tool has **no manifest** in `backend/src/services/agents/tool-manifest.js`. Only `finalize` is exempt (both gates skip `name !== 'finalize'`).

**Why:** A tool can be defined and added to `buildTaskTools()` (so it's advertised to the LLM) yet still be denied at runtime because it lacks a manifest. The failure is silent — the tool's side effects (e.g. `cycle_stage` progress events for the professional document cycle) simply never happen, and there's no boot error. `validateAllBuiltinManifests()` is non-fatal (it already reports several pre-existing `skill_*`/`scientific_search` invalids without blocking boot), so a missing manifest won't be caught at startup either.

**How to apply:** When adding any new tool to `buildTaskTools()`, also register a manifest. Manifests are merged into `BUILTIN_MANIFESTS` via `Object.assign(...)` from the `get*Manifests()` factory functions (e.g. `getCoworkManifests()`); add the entry inside the matching factory. The schema is strict (ajv, `additionalProperties:false`): `audit_policy` enum is `off|sample|every-call|every-call-plus-args`; `side_effect_level` enum is `none|local-fs|remote-read|remote-write|destructive`. For a harmless event-only tool, use empty `scopes`, `requires_auth:false`, `side_effect_level:"none"`, `audit_policy:"off"`. Verify with `validateAllBuiltinManifests()` + `authorizeToolCall` + `checkToolUsageBudget` before trusting it.
