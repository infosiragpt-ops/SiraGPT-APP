import type { CodexRun } from "./codex-api"

const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_approval"])
const HARD_TERMINAL_STATUSES = ["done", "error", "cancelled"] as const

type CodexContinuityTurnLike = {
  id: string
  role: string
  streaming?: boolean
  codexRunId?: string
}

function newestFirst(a: CodexRun, b: CodexRun): number {
  return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "")
}

/**
 * Selects the one backend-owned /code run the chat should reconnect to.
 * Pulling the newest completed build also synchronizes the cumulative project
 * tree, so older completed runs do not need to be replayed one by one.
 */
export function selectCodexContinuityRun(
  runs: CodexRun[],
  lastSyncedRunId?: string | null,
): CodexRun | null {
  const automatic = runs
    .filter((run) => run.autoExecute === true)
    .slice()
    .sort(newestFirst)
  const plansWithBuilds = new Set(
    automatic
      .filter((run) => run.mode === "build" && run.planRunId)
      .map((run) => run.planRunId as string),
  )

  const active =
    automatic.find((run) => run.mode === "build" && ACTIVE_STATUSES.has(run.status)) ||
    automatic.find(
      (run) =>
        run.mode === "plan" &&
        ACTIVE_STATUSES.has(run.status) &&
        (run.status !== "waiting_approval" || !plansWithBuilds.has(run.id)),
    )
  if (active) return active

  const syncedRun = automatic.find((run) => run.id === lastSyncedRunId)
  const syncedAt = syncedRun ? Date.parse(syncedRun.createdAt || "") : Number.NaN
  return (
    automatic.find(
      (run) =>
        run.mode === "build" &&
        run.status === "done" &&
        (!syncedRun || Date.parse(run.createdAt || "") > syncedAt),
    ) || null
  )
}

/**
 * A waiting plan is parked so the chat can approve it and follow the build it
 * creates. A waiting build is still active and must keep its stream attached
 * until the pending tool approval is resolved.
 */
export function codexContinuityStreamTerminalStatuses(
  mode: "plan" | "build",
): readonly string[] {
  return mode === "plan"
    ? [...HARD_TERMINAL_STATUSES, "waiting_approval"]
    : HARD_TERMINAL_STATUSES
}

/**
 * Finds the assistant bubble owned by a durable run. The streaming fallback
 * upgrades turns persisted before codexRunId was introduced.
 */
export function selectCodexContinuityAssistantTurn<
  T extends CodexContinuityTurnLike,
>(
  turns: readonly T[],
  runId: string,
  planRunId?: string | null,
): T | null {
  const durableIds = new Set([runId, planRunId].filter(Boolean))
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (
      turn?.role === "assistant" &&
      turn.codexRunId &&
      durableIds.has(turn.codexRunId)
    ) {
      return turn
    }
  }
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn?.role === "assistant" && turn.streaming === true) return turn
  }
  return null
}

/** Replaces the claimed continuity bubble in place instead of appending one. */
export function upsertCodexContinuityTurn<T extends { id: string }>(
  turns: readonly T[],
  next: T,
  replaceId?: string | null,
): T[] {
  const targetId = replaceId || next.id
  const index = turns.findIndex((turn) => turn.id === targetId)
  if (index < 0) return [...turns, next]
  return turns.map((turn, current) =>
    current === index ? { ...turn, ...next, id: turn.id } : turn,
  )
}
