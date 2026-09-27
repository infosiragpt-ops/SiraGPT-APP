/**
 * Live activity log for an assistant turn — the Claude-style "what am I
 * doing" timeline. The backend emits `stage` SSE frames ("Leyendo el archivo
 * adjunto", "Buscando en la web", "Analizando la imagen", "Pensando"…); this
 * pure reducer turns them into ordered steps: every earlier step is done,
 * the newest one is active until text arrives or the stream closes.
 *
 * Stage v2 (edición milimétrica, docs/specs/edicion-milimetrica/SPEC.md §8):
 * a frame may carry `callId` — the tool call it belongs to. A `tool_result`
 * with the callId of an existing row UPDATES that row (done / error, result
 * detail, thumbnails) instead of adding one, so every tool call is exactly
 * one row. Only frames WITHOUT a callId merge by label (heartbeats).
 */

export type ActivityKind = "terminal" | "document" | "search" | "web" | "edit" | "image" | "check" | "thinking"

export type ActivityStep = {
  id: string
  label: string
  tool?: string
  status: "active" | "done" | "error"
  at: number
  /** Underlying runner event (tool_call, iteration_start, final…). */
  step?: string
  /** Tool call this row belongs to (stage v2). */
  callId?: string
  /** Icon family of the tool (stage v2 `kind`). */
  kind?: ActivityKind
  /** The model's own phrase for the step. */
  description?: string
  /** What ran: code / command / path / ops (≤600, secrets redacted by the backend). */
  detail?: string
  /** What came back (the result preview). */
  result?: string
  /** Page / before-after thumbnails (data: URLs live, artifact URLs after a reload). */
  thumbs?: string[]
  ok?: boolean
  endedAt?: number
}

export type ActivityEvent = {
  label?: string
  text?: string
  tool?: string
  type?: string
  step?: string
  callId?: string
  kind?: string
  description?: string
  detail?: string
  preview?: string
  thumbs?: unknown
  ok?: boolean
  status?: string
  at?: number
}

const KINDS: ReadonlySet<string> = new Set(["terminal", "document", "search", "web", "edit", "image", "check", "thinking"])
const MAX_THUMBS_PER_STEP = 2
const SAFE_THUMB_RE = /^(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}|\/api\/agent\/artifact\/[a-f0-9]{8,40}(?:\?[^\s"'<>]*)?)$/

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  const text = value.trim()
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

/** Only image data URLs and our own artifact URLs are ever rendered. */
export function safeThumbs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((t): t is string => typeof t === "string" && SAFE_THUMB_RE.test(t)).slice(0, MAX_THUMBS_PER_STEP)
}

function kindOf(value: unknown): ActivityKind | undefined {
  return typeof value === "string" && KINDS.has(value) ? (value as ActivityKind) : undefined
}

function lastIndexWhere<T>(list: T[], pred: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (pred(list[i])) return i
  return -1
}

export function appendActivity(
  log: ActivityStep[] | undefined,
  event: ActivityEvent,
  now: number = Date.now(),
): ActivityStep[] {
  const current = Array.isArray(log) ? log : []
  const callId = typeof event?.callId === "string" ? event.callId.trim() : ""
  const failed = event?.ok === false || event?.status === "error"

  // Stage v2: the result settles its own call's row.
  if (callId && event?.step === "tool_result") {
    const idx = lastIndexWhere(current, (s) => s.callId === callId)
    if (idx !== -1) {
      const prev = current[idx]
      const result = cleanText(event.detail ?? event.preview, 1200)
      const thumbs = safeThumbs(event.thumbs)
      const next: ActivityStep = {
        ...prev,
        status: failed ? "error" : "done",
        ok: !failed,
        endedAt: now,
        ...(result ? { result } : {}),
        ...(thumbs.length ? { thumbs } : {}),
      }
      return current.map((s, i) => (i === idx ? next : s))
    }
  }

  const label = String(event?.description || event?.label || event?.text || "").trim()
  if (!label) return current
  const last = current[current.length - 1]
  // The same phase reported twice (heartbeat re-announcements) is one row —
  // only for frames that do not belong to a tool call.
  if (!callId && last && !last.callId && last.label === label && last.status === "active") return current
  // A new row settles the earlier un-paired rows; a paired row stays active
  // until its own result (parallel tool calls run side by side).
  const settled = current.map((step) =>
    step.status === "active" && !step.callId ? { ...step, status: "done" as const } : step,
  )
  // A paired result whose call row is missing (reconnect) still lands settled;
  // un-paired frames keep the classic behaviour (the newest row is active).
  const pairedResult = Boolean(callId) && event?.step === "tool_result"
  const kind = kindOf(event?.kind)
  const detail = cleanText(pairedResult ? "" : event?.detail, 1200)
  const result = cleanText(pairedResult ? (event?.detail ?? event?.preview) : "", 1200)
  const description = cleanText(event?.description, 160)
  const thumbs = safeThumbs(event?.thumbs)
  const status: ActivityStep["status"] = failed && callId ? "error" : pairedResult ? "done" : "active"
  return [
    ...settled,
    {
      id: `act-${current.length}-${(callId || label).slice(0, 24)}`,
      label,
      ...(event?.tool ? { tool: String(event.tool) } : {}),
      status,
      at: now,
      ...(event?.step ? { step: String(event.step) } : {}),
      ...(callId ? { callId } : {}),
      ...(kind ? { kind } : {}),
      ...(description ? { description } : {}),
      ...(detail ? { detail } : {}),
      ...(result ? { result } : {}),
      ...(thumbs.length ? { thumbs } : {}),
      ...(pairedResult ? { ok: !failed, endedAt: now } : {}),
    },
  ]
}

/** First visible token / stream end: nothing is active any more. */
export function finalizeActivity(log: ActivityStep[] | undefined): ActivityStep[] {
  const current = Array.isArray(log) ? log : []
  if (!current.some((step) => step.status === "active")) return current
  return current.map((step) => (step.status === "active" ? { ...step, status: "done" as const } : step))
}

/** A turn whose steps belong to tool calls (AgentRunner, stage v2). */
export function hasPairedActivity(log: ActivityStep[] | undefined): boolean {
  return Array.isArray(log) && log.some((step) => Boolean(step && step.callId))
}

/**
 * Timeline of a reloaded AgentRunner turn: the persisted stage events
 * (messages.agent_metadata.activityTrace, relative `at` in ms) replayed
 * through the same reducer, then settled.
 */
export function hydrateActivityTrace(meta: unknown): ActivityStep[] {
  let parsed: any = meta
  if (typeof meta === "string") {
    try { parsed = JSON.parse(meta) } catch { return [] }
  }
  const events = parsed && typeof parsed === "object" && Array.isArray(parsed.activityTrace) ? parsed.activityTrace : null
  if (!events || !events.length) return []
  let log: ActivityStep[] = []
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue
    const at = Number.isFinite(Number(ev.at)) ? Number(ev.at) : 0
    log = appendActivity(log, ev as ActivityEvent, at)
  }
  return finalizeActivity(log)
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

/** Cheap change signature for React.memo: rows, statuses and thumbnails. */
export function activitySignature(log: ActivityStep[] | undefined): string {
  if (!Array.isArray(log) || !log.length) return ""
  let key = String(log.length)
  for (const step of log) {
    key += `|${step?.status || ""}${Array.isArray(step?.thumbs) ? step.thumbs.length : 0}${step?.result ? "r" : ""}`
  }
  return key
}
