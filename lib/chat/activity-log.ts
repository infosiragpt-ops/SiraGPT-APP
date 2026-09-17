/**
 * Live activity log for an assistant turn — the Claude-style "what am I
 * doing" timeline. The backend emits `stage` SSE frames ("Leyendo el archivo
 * adjunto", "Buscando en la web", "Analizando la imagen", "Pensando"…); this
 * pure reducer turns them into ordered steps: every earlier step is done,
 * the newest one is active until text arrives or the stream closes.
 */

export type ActivityStep = {
  id: string
  label: string
  tool?: string
  status: "active" | "done" | "error"
  at: number
}

export type ActivityEvent = {
  label?: string
  text?: string
  tool?: string
  type?: string
}

export function appendActivity(
  log: ActivityStep[] | undefined,
  event: ActivityEvent,
  now: number = Date.now(),
): ActivityStep[] {
  const label = String(event?.label || event?.text || "").trim()
  const current = Array.isArray(log) ? log : []
  if (!label) return current
  const last = current[current.length - 1]
  // The same phase reported twice (heartbeat re-announcements) is one row.
  if (last && last.label === label && last.status === "active") return current
  const settled = current.map((step) => (step.status === "active" ? { ...step, status: "done" as const } : step))
  return [
    ...settled,
    {
      id: `act-${current.length}-${label.slice(0, 24)}`,
      label,
      ...(event?.tool ? { tool: String(event.tool) } : {}),
      status: "active",
      at: now,
    },
  ]
}

/** First visible token / stream end: nothing is active any more. */
export function finalizeActivity(log: ActivityStep[] | undefined): ActivityStep[] {
  const current = Array.isArray(log) ? log : []
  if (!current.some((step) => step.status === "active")) return current
  return current.map((step) => (step.status === "active" ? { ...step, status: "done" as const } : step))
}

/** Rows for the thinking placeholder — reuses its agent-step contract. */
export function activityToPlaceholderSteps(log: ActivityStep[] | undefined): Array<{
  id: string
  name?: string
  label: string
  status: "executing" | "done" | "error"
}> {
  return (Array.isArray(log) ? log : []).map((step) => ({
    id: step.id,
    ...(step.tool ? { name: step.tool } : {}),
    label: step.label,
    status: step.status === "active" ? "executing" : step.status,
  }))
}

/** Total thinking time when the model exposed no reasoning duration. */
export function activityDurationMs(
  log: ActivityStep[] | undefined,
  endedAt: number | null | undefined,
): number | null {
  const current = Array.isArray(log) ? log : []
  if (!current.length || !endedAt) return null
  const started = current[0].at
  if (!Number.isFinite(started) || endedAt <= started) return null
  return endedAt - started
}
