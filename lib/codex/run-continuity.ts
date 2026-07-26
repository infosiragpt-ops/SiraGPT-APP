import type { CodexRun } from "./codex-api"

const ACTIVE_STATUSES = new Set(["queued", "running"])

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

  const active =
    automatic.find((run) => run.mode === "build" && ACTIVE_STATUSES.has(run.status)) ||
    automatic.find(
      (run) =>
        run.mode === "plan" &&
        (ACTIVE_STATUSES.has(run.status) || run.status === "waiting_approval"),
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
