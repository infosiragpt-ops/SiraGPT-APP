# Task for Agent Core Terminal

## Priority: High

Implement **self-healing agent retry** using the new `classifyTaskError()` function:

1. Open `backend/src/services/agents/agent-task-runner.js` — find where `runAgentTaskJob` is called
2. Add retry logic: if classifyTaskError(error) returns retryable=true, re-queue the job after
   ttlMs milliseconds instead of failing
3. Add max_retries config (default: 3) with environment variable `AGENT_TASK_MAX_RETRIES`
4. Add `attempt` counter to task store snapshots so we can see retry count
5. Update CLAUDE.md when done
6. TEST: `npm test` in backend/ must pass
7. PUSH: `git add -A && git commit -m "feat(agent-runner): self-healing retry with classifyTaskError" && git push sira-org main`
