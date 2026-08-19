---
name: Finalize-guard runaway loop
description: Why the react-agent could spin to its full step/runtime budget and how interactive-task budgets are gated.
---

# Finalize-guard runaway loop

The react-agent run loop reinjects repair instructions whenever the finalize
guard rejects a `finalize` call, then continues. Historically there was NO cap
on guard rejections, so an *unsatisfiable* guard (e.g. a simple chat request
misrouted into the heavy document pipeline with a weak model that can never
produce the evidence the guard demands) spun until maxSteps/maxRuntime — ~50 min
of LLM calls on a result the client already abandoned at ~90s ("dejó de
responder").

**Rule:** any guard that can reject a terminal action inside a step loop MUST
have a rejection cap that eventually forces a degraded-but-real finalize.
- Two caps: absolute total + consecutive (consecutive resets on genuine
  progress = a successful non-finalize tool call). Either cap trips the breaker.
- When tripped, leave the finalize observation WITHOUT an error so the normal
  terminator fires; the post-loop safety net handles an empty answer.

**Why:** a guard's required evidence is not always reachable by the current
model/route; blocking forever is worse UX and cost than a degraded answer.

**Companion rule — budget by intent, not blanket defaults:** interactive chat
tasks must not inherit heavy-document ceilings. `resolveAgentTaskBudget` gates
defaults: heavy (documentPolicy.autoGenerate OR explicit maxSteps>40) keeps the
generous ceiling; everything else gets a tight interactive ceiling so a stuck
task fails fast and cheap. Explicit caller values always win.

**How to apply:** when touching agent-task budgets or the react-agent loop,
preserve both the breaker and the intent gating; don't reintroduce a single
blanket maxSteps/maxRuntime default for all task types.
