import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  MAX_AGENT_TASK_RECOVERY_FAILURES,
  isTerminalAgentTaskRecoveryHttpStatus,
  resolveChatAgentTaskForRecovery,
  shouldDetachAgentTaskRecovery,
} from "../lib/api"

const ROOT = process.cwd()
const componentSource = readFileSync(join(ROOT, "components", "chat-interface-enhanced.tsx"), "utf8")
const apiSource = readFileSync(join(ROOT, "lib", "api.ts"), "utf8")

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

const recoveryEffect = sliceBetween(
  componentSource,
  "// ─── Durable agent-task recovery",
  "// Voice Studio panel state",
)

const recoveryNavigationCleanup = sliceBetween(
  recoveryEffect,
  "return () => {\n      // A chat switch must not detach recovery",
  "  }, [agentTaskRecoveryHydrationNonce",
)

describe("chat agent task background recovery contract", () => {
  it("discovers durable chat tasks through the authenticated API client", () => {
    assert.match(apiSource, /async getChatPendingStream\(chatId: string\)/)
    assert.match(apiSource, /`\/chats\/\$\{encodeURIComponent\(chatId\)\}\/pending-stream`/)
    assert.match(recoveryEffect, /apiClient\.getChatPendingStream\(chatId\)/)
    assert.match(recoveryEffect, /resolveChatAgentTaskForRecovery\(/)
  })

  it("replays task events into the existing agent-state bubble", () => {
    assert.match(recoveryEffect, /agentTaskService\.getTaskEvents\(taskId, cursor, \{ signal \}\)/)
    assert.match(recoveryEffect, /state = normalizeRecoveredAgentTaskState\(payload\.streamState, taskId\)/)
    assert.match(recoveryEffect, /state = reduceEvent\(state, event\)/)
    assert.match(recoveryEffect, /upsertRecoveredBubble\(taskId, state, payload\.status\)/)
  })

  it("prevents duplicate recovery polls and never cancels backend work on navigation", () => {
    assert.match(recoveryEffect, /agentTaskRecoveryControllersRef\.current\.has\(chatId\)/)
    assert.match(recoveryEffect, /localJobControllersRef\.current\.has\(chatId\)/)
    assert.match(recoveryEffect, /return \(\) => \{[\s\S]*controller\.abort\(\)/)
    assert.match(recoveryNavigationCleanup, /if \(currentChatIdRef\.current !== chatId\) return;/)
    assert.doesNotMatch(recoveryNavigationCleanup, /markLocalJobIdle/)
    assert.match(recoveryEffect, /if \(!prevChat \|\| prevChat\.id !== chatId\) return prevChat/)
    assert.doesNotMatch(recoveryEffect, /agentTaskService\.cancelTask/)
  })

  it("covers the reload race where the backend finishes before discovery returns", () => {
    const completedLatest = {
      ok: true,
      pending: null,
      activeTasks: [],
      latestTask: { taskId: "task-finished-during-reload", status: "completed" },
    }
    assert.equal(
      resolveChatAgentTaskForRecovery(completedLatest, "task-finished-during-reload", true)?.taskId,
      "task-finished-during-reload",
      "an unfinished local bubble must reconnect even if discovery observes the task after completion",
    )
    assert.equal(
      resolveChatAgentTaskForRecovery(completedLatest, "task-finished-during-reload", false),
      null,
      "a historic latest task must not reopen once its bubble is already complete",
    )
    assert.match(recoveryEffect, /normalizedStatus === "completed"[\s\S]*done: true[\s\S]*recovered_completed/)
    assert.match(recoveryEffect, /cached shell first and hydrate its messages/)
    assert.match(recoveryEffect, /agentTaskRecoveryWakeKeysRef\.current\.get\(currentChatId\) === wakeKey/)
    assert.match(recoveryEffect, /setAgentTaskRecoveryHydrationNonce\(value => value \+ 1\)/)
    assert.match(recoveryEffect, /if \(state\.done \|\| isTerminalAgentTaskStatus\(payload\.status\)\)[\s\S]*reachedTerminal = true;[\s\S]*break;/)

    const terminalGuard = recoveryEffect.indexOf("if (state.done || isTerminalAgentTaskStatus(payload.status))")
    const nextPollWait = recoveryEffect.indexOf("await waitForAgentTaskRecoveryPoll(900, signal)", terminalGuard)
    assert.ok(terminalGuard >= 0 && nextPollWait > terminalGuard, "terminal tasks must break before scheduling another poll")
  })

  it("prefers the unfinished local task among multiple active pointers", () => {
    const envelope = {
      ok: true,
      pending: null,
      activeTasks: [
        { taskId: "task-a", status: "running" },
        { taskId: "task-b", status: "running" },
      ],
      latestTask: { taskId: "task-b", status: "running" },
    }

    assert.equal(
      resolveChatAgentTaskForRecovery(envelope, "task-b", true)?.taskId,
      "task-b",
      "recovery must attach to the task represented by the local unfinished bubble",
    )
  })

  it("advances to the next active task without reopening a stale terminal pointer", () => {
    const envelope = {
      ok: true,
      pending: null,
      activeTasks: [
        { taskId: "task-a", status: "running" },
        { taskId: "task-b", status: "running" },
      ],
      latestTask: { taskId: "task-b", status: "running" },
    }

    assert.equal(
      resolveChatAgentTaskForRecovery(envelope, null, false, new Set(["task-a"]))?.taskId,
      "task-b",
    )
    assert.match(recoveryEffect, /terminalAgentTaskIdsByChatRef\.current\.get\(chatId\)/)
    assert.match(recoveryEffect, /setAgentTaskRecoveryHydrationNonce\(value => value \+ 1\)/)
  })

  it("normalizes legacy task ids and completed statuses before selecting a bubble", () => {
    assert.match(componentSource, /legacyTaskId = typeof parsed\.taskId === "string"/)
    assert.match(componentSource, /taskId: normalizedTaskId/)
    assert.match(componentSource, /normalizedStatus === "completed"/)
    assert.match(componentSource, /messageTaskId === taskId/)
    assert.match(componentSource, /totalCandidates === 1 && unidentified\.length === 1/)
  })

  it("bounds permanent recovery failures without cancelling backend work", () => {
    for (const statusCode of [401, 403, 404, 410]) {
      assert.equal(isTerminalAgentTaskRecoveryHttpStatus(statusCode), true)
    }
    assert.equal(isTerminalAgentTaskRecoveryHttpStatus(429), false)
    assert.equal(isTerminalAgentTaskRecoveryHttpStatus(500), false)
    assert.equal(shouldDetachAgentTaskRecovery(MAX_AGENT_TASK_RECOVERY_FAILURES - 1), false)
    assert.equal(shouldDetachAgentTaskRecovery(MAX_AGENT_TASK_RECOVERY_FAILURES), true)
    assert.match(recoveryEffect, /statusCode = Number\(payload\?\.statusCode \|\| 0\)/)
    assert.match(recoveryEffect, /isTerminalAgentTaskRecoveryHttpStatus\(statusCode\)[\s\S]*terminalRecoveryLookupFailure = true/)
    assert.match(recoveryEffect, /recoveryDetached = true/)
    assert.match(recoveryEffect, /El trabajo del servidor no fue cancelado/)
    assert.doesNotMatch(recoveryEffect, /agentTaskService\.cancelTask/)
  })

  it("hands busy ownership from task A to task B before draining the same-chat queue", () => {
    assert.match(recoveryEffect, /if \(reachedTerminal && !terminalRecoveryLookupFailure\) \{\s+try \{\s+const nextEnvelope/)
    assert.match(recoveryEffect, /const nextEnvelope = await apiClient\.getChatPendingStream\(chatId\)/)
    assert.match(recoveryEffect, /resolveChatAgentTaskForRecovery\([\s\S]*nextEnvelope[\s\S]*terminalIds/)
    assert.match(recoveryEffect, /if \(nextTaskPointer\?\.taskId\)[\s\S]*agentTaskIdsByChatRef\.current\.set\(chatId, nextTaskPointer\.taskId\)/)
    assert.match(recoveryEffect, /else if \(!nextTaskDiscoveryFailed\)[\s\S]*markLocalJobIdle\(chatId\)/)
    assert.match(recoveryEffect, /nextTaskPointer\?\.taskId \|\| nextTaskDiscoveryFailed[\s\S]*setAgentTaskRecoveryHydrationNonce/)
  })

  it("clears busy only while the recovery still owns the task and controller", () => {
    assert.match(recoveryEffect, /if \(\(reachedTerminal \|\| recoveryDetached\) && !signal\.aborted\)[\s\S]*stillOwnsRecoveredTask[\s\S]*hasReplacementController/)
    assert.match(recoveryEffect, /ownsRecoveryController && stillOwnsRecoveredTask && !localJobControllersRef\.current\.has\(chatId\)/)
    assert.match(recoveryEffect, /if \(signal\.aborted\) return;[\s\S]*trackedTaskId/)
    assert.match(recoveryEffect, /apiClient\.getChat\(chatId\)[\s\S]*prevChat\?\.id === chatId[\s\S]*mergeChatPreservingUserMessages/)
    assert.doesNotMatch(recoveryEffect, /selectChatLatestRef/)
    assert.match(recoveryEffect, /latestTask intentionally is not enough by itself/)
  })

  it("releases a task that cannot be looked up instead of retrying a forbidden handoff forever", () => {
    assert.match(recoveryEffect, /terminalRecoveryLookupFailure = true/)
    assert.match(recoveryEffect, /if \(reachedTerminal && !terminalRecoveryLookupFailure\)/)
    assert.match(recoveryEffect, /else if \(!nextTaskDiscoveryFailed\) \{[\s\S]*markLocalJobIdle\(chatId\)/)
  })
})
