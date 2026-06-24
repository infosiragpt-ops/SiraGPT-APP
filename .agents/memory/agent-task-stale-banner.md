---
name: Agent task stale banner root cause
description: Why "Sin actualizaciones recientes" appears even when the agent task is running, and the fix pattern.
---

## The rule
Always emit a `step_start` event **before** calling `reactAgent.run()` so the frontend 90 s stale-detection timer resets immediately on task start.

**Why:** `reactAgent.run()` only calls `onStepStart` (which emits `step_start`) after the first LLM round-trip. If the model (e.g. DeepSeek V4 Pro via OpenRouter) takes >90 s, `state.steps.length` never changes, the frontend timer fires, and the user sees "Sin actualizaciones recientes. Puedes cancelar y volver a intentar." — even though the task is actively running.

**How to apply:**
1. Before `reactRunArgs`, declare `let preLoopStepId = null`.
2. After `reactRunArgs` is defined but before `reactAgent.run()`, emit `step_start` with a goal-derived label and store the id in `preLoopStepId`.
3. In `onStepStart`, if `currentStepId === preLoopStepId`, emit `step_done ok:true` and null out `preLoopStepId` before starting the real first step.
4. After `reactAgent.run()` returns, if `preLoopStepId` is still set (zero-step answer), close it then.
5. Model failover path (`reactAgent.run` retry) is safe — `preLoopStepId` is null by that point.

**Location:** `backend/src/services/agents/agent-task-runner.js`, just before `let result = await reactAgent.run(openai, reactRunArgs)`.
