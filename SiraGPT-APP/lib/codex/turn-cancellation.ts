export type CodexTurnCancellationState = "cancelling" | "failed" | "cancelled"

export type CodexRunCancellationTarget = {
  projectId: string
  runId: string
  turnId: string
}

/**
 * Local coordination state for one durable stop attempt. The UI may become
 * terminal only when the engine has crossed its late-run-creation fences and
 * the currently known backend run family has confirmed cancellation.
 */
export type CodexCancellationAttempt = {
  attempt: number
  turnId: string
  target: CodexRunCancellationTarget | null
  status: "cancelling" | "failed"
  engineSettled: boolean
  backendConfirmed: boolean
}

export type CodexCancellationTurn = {
  id: string
  content: string
  streaming?: boolean
  agentLabel?: string
  cancellationState?: CodexTurnCancellationState
}

export type CodexCancellationReloadKind = "active" | "cancelled" | "done" | "error" | "missing"

export type CodexCancellationReloadRun = {
  id: string
  status?: string | null
  planRunId?: string | null
  createdAt?: string | null
}

function updateTurn<T extends CodexCancellationTurn>(
  turns: readonly T[],
  turnId: string,
  update: (turn: T) => T,
): T[] {
  return turns.map((turn) => (turn.id === turnId ? update(turn) : turn))
}

/** Keep the bubble live while durable cancellation is being confirmed. */
export function markCodexTurnCancelling<T extends CodexCancellationTurn>(
  turns: readonly T[],
  turnId: string,
): T[] {
  return updateTurn(turns, turnId, (turn) => ({
    ...turn,
    streaming: true,
    agentLabel: "Deteniendo agente…",
    cancellationState: "cancelling",
  }))
}

/** Cancellation failed: the durable run may still be active and remains retryable. */
export function markCodexTurnCancellationFailed<T extends CodexCancellationTurn>(
  turns: readonly T[],
  turnId: string,
): T[] {
  return updateTurn(turns, turnId, (turn) => ({
    ...turn,
    streaming: true,
    agentLabel: "No se pudo detener · reintenta",
    cancellationState: "failed",
  }))
}

/** Only a confirmed durable cancellation may make the turn terminal. */
export function markCodexTurnCancelled<T extends CodexCancellationTurn>(
  turns: readonly T[],
  turnId: string,
): T[] {
  return updateTurn(turns, turnId, (turn) => ({
    ...turn,
    content: "_Generación detenida._",
    streaming: false,
    agentLabel: "Generación detenida",
    cancellationState: "cancelled",
  }))
}

export function isCodexTurnCancellationLocked(
  turn: Pick<CodexCancellationTurn, "cancellationState">,
): boolean {
  return turn.cancellationState === "cancelling"
    || turn.cancellationState === "failed"
    || turn.cancellationState === "cancelled"
}

/** Ignore late SSE/engine patches once cancellation owns the visual turn. */
export function patchCodexTurnUnlessCancellationLocked<T extends CodexCancellationTurn>(
  turn: T,
  patch: Partial<T>,
): T {
  return isCodexTurnCancellationLocked(turn) ? turn : { ...turn, ...patch }
}

export function classifyCodexCancellationReloadStatus(
  status?: string | null,
): CodexCancellationReloadKind {
  const normalized = String(status || "").trim().toLowerCase()
  if (normalized === "queued" || normalized === "running" || normalized === "waiting_approval") {
    return "active"
  }
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled"
  if (normalized === "done") return "done"
  if (normalized === "error" || normalized === "failed") return "error"
  return "missing"
}

/** Prefer a continued build over its plan when reconciling a persisted bubble. */
export function selectCodexCancellationReloadRun<T extends CodexCancellationReloadRun>(
  runs: readonly T[],
  runId: string,
): T | null {
  const related = runs.filter((run) => run.id === runId || run.planRunId === runId)
  if (related.length === 0) return null
  return related
    .slice()
    .sort((left, right) => {
      const leftChild = left.planRunId === runId ? 1 : 0
      const rightChild = right.planRunId === runId ? 1 : 0
      if (leftChild !== rightChild) return rightChild - leftChild
      return Date.parse(right.createdAt || "") - Date.parse(left.createdAt || "")
    })[0] || null
}

export function reconcileCodexTurnAfterReload<T extends CodexCancellationTurn>(
  turn: T,
  kind: CodexCancellationReloadKind,
): T {
  if (kind === "active") {
    return {
      ...turn,
      streaming: true,
      cancellationState: "failed",
      agentLabel: "Ejecución activa · reintenta detener",
    }
  }
  if (kind === "cancelled") {
    return markCodexTurnCancelled([turn], turn.id)[0]
  }
  if (kind === "done") {
    return {
      ...turn,
      streaming: false,
      cancellationState: undefined,
      agentLabel: "Turno completado",
    }
  }
  return {
    ...turn,
    streaming: false,
    cancellationState: undefined,
    agentLabel: kind === "error" ? "Ejecución terminó con error" : "Ejecución no disponible",
  }
}

export function beginCodexCancellationAttempt({
  previous,
  attempt,
  turnId,
  target,
}: {
  previous: CodexCancellationAttempt | null
  attempt: number
  turnId: string
  target: CodexRunCancellationTarget | null
}): CodexCancellationAttempt {
  const previousTarget = previous?.target
  const sameTarget = previous?.turnId === turnId && (
    (previousTarget === null && target === null)
    || (
      previousTarget !== null
      && previousTarget !== undefined
      && target !== null
      && previousTarget.projectId === target.projectId
      && previousTarget.runId === target.runId
    )
  )
  return {
    attempt,
    turnId,
    target,
    status: "cancelling",
    // A retry of the same target must not wait for an engine that already
    // stopped. A newly discovered run/child gets its own settlement fence.
    engineSettled: sameTarget ? previous.engineSettled : false,
    backendConfirmed: false,
  }
}

export function settleCodexCancellationEngine(
  state: CodexCancellationAttempt,
): CodexCancellationAttempt {
  return { ...state, engineSettled: true }
}

export function confirmCodexCancellationBackend(
  state: CodexCancellationAttempt,
): CodexCancellationAttempt {
  return { ...state, status: "cancelling", backendConfirmed: true }
}

export function failCodexCancellationBackend(
  state: CodexCancellationAttempt,
): CodexCancellationAttempt {
  return { ...state, status: "failed", backendConfirmed: false }
}

export function canFinalizeCodexCancellation(
  state: CodexCancellationAttempt,
): boolean {
  return state.engineSettled && (state.target === null || state.backendConfirmed)
}
