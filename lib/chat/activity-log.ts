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
 *
 * Stage v3 (live progress, chat pipeline): a frame may carry `stageId` — one
 * pipeline phase (reading the attachments, recalling memory, searching the
 * web, calling the model…). Its begin opens a row, `tool_progress` frames
 * update that row in place (label / detail / meta), and its `tool_result`
 * settles it with the server-measured `elapsedMs`. Stage rows never carry a
 * callId, so the bubble stays on the thinking timeline (not the rail), and a
 * stage row stays open until its own result even when later phases begin
 * (a new begin of the SAME phase supersedes it: its result was lost).
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
  /** Pipeline phase id (stage v3): begin / progress / result share it. */
  stageId?: string
  /** Pipeline phase family: attachments, memory, rag, web, model, agent_step… */
  phase?: string
  /** Structured facts of the phase (files, pages, words, hits, attempt…). */
  meta?: Record<string, number>
  /** Server-measured duration of a settled stage row. */
  durationMs?: number
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
  stageId?: string
  phase?: string
  meta?: unknown
  elapsedMs?: number
}

const KINDS: ReadonlySet<string> = new Set(["terminal", "document", "search", "web", "edit", "image", "check", "thinking"])
const MAX_THUMBS_PER_STEP = 2
const MAX_META_KEYS = 12
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

/** Only finite numbers survive (files, pages, words, hits, attempt…). */
function cleanMeta(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  let n = 0
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (n >= MAX_META_KEYS) break
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue
    out[key] = raw
    n += 1
  }
  return n ? out : undefined
}

function cleanElapsed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * A new row settles the earlier un-paired, non-stage rows (legacy phases).
 * With `phase`, an open stage row of that same phase is settled too: a phase
 * never runs twice at once, so a new begin for it means the old row's own
 * result was lost (backend error branch, retried request) — never a zombie
 * that ticks until the first text.
 */
function settleLegacyRows(log: ActivityStep[], now: number, phase = ""): ActivityStep[] {
  const superseded = (step: ActivityStep) => step.status === "active" && !step.callId
    && (!step.stageId || Boolean(phase && step.phase === phase))
  if (!log.some(superseded)) return log
  return log.map((step) =>
    superseded(step)
      ? { ...step, status: "done" as const, endedAt: step.endedAt ?? now }
      : step,
  )
}

/**
 * Stage v3: begin / tool_progress / tool_result frames that share a stageId
 * are one row. Progress updates it in place; the result settles it (even
 * after finalizeActivity already closed it); a frame for an unknown stageId
 * (reconnect) lands as its own row.
 */
function appendStageActivity(current: ActivityStep[], event: ActivityEvent, stageId: string, now: number): ActivityStep[] {
  const label = cleanText(String(event.description || event.label || event.text || ""), 160)
  const hasDetail = typeof event.detail === "string"
  const detail = cleanText(event.detail, 300)
  const meta = cleanMeta(event.meta)
  const phase = cleanText(event.phase, 32)
  const elapsedMs = cleanElapsed(event.elapsedMs)
  const failed = event.ok === false || event.status === "error"
  const isProgress = event.step === "tool_progress"
  const isResult = event.step === "tool_result" || event.status === "done" || event.status === "error"
  const idx = lastIndexWhere(current, (s) => s.stageId === stageId)
  const prev = idx === -1 ? null : current[idx]

  const patch = (row: ActivityStep): ActivityStep => {
    const next: ActivityStep = { ...row }
    if (label) next.label = label
    if (hasDetail) {
      if (detail) next.detail = detail
      else delete next.detail
    }
    if (meta) next.meta = meta
    if (phase && !next.phase) next.phase = phase
    return next
  }

  if (prev && isResult) {
    const settled = patch(prev)
    settled.status = failed ? "error" : "done"
    settled.ok = !failed
    settled.endedAt = now
    settled.durationMs = elapsedMs ?? Math.max(0, now - prev.at)
    return current.map((s, i) => (i === idx ? settled : s))
  }
  if (prev && prev.status === "active" && (isProgress || !isResult)) {
    const updated = patch(prev)
    const same = updated.label === prev.label && updated.detail === prev.detail
      && JSON.stringify(updated.meta) === JSON.stringify(prev.meta) && updated.phase === prev.phase
    return same ? current : current.map((s, i) => (i === idx ? updated : s))
  }
  // A late progress frame for a row that already settled changes nothing.
  if (prev && isProgress) return current
  if (!label) return current

  // A begin supersedes the open rows of its own phase; a late result does not.
  const settledEarlier = settleLegacyRows(current, now, isResult ? "" : phase)
  const kind = kindOf(event.kind)
  const startedAt = isResult && elapsedMs !== undefined ? now - elapsedMs : now
  const row: ActivityStep = {
    id: `act-${current.length}-${stageId.slice(0, 24)}`,
    label,
    ...(event.tool ? { tool: String(event.tool) } : {}),
    status: isResult ? (failed ? "error" : "done") : "active",
    at: startedAt,
    ...(event.step ? { step: String(event.step) } : {}),
    stageId,
    ...(phase ? { phase } : {}),
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(meta ? { meta } : {}),
    ...(isResult ? { ok: !failed } : {}),
    ...(isResult && elapsedMs !== undefined ? { endedAt: now, durationMs: elapsedMs } : {}),
  }
  return [...settledEarlier, row]
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

  // Stage v3: pipeline phases pair by stageId (never together with a callId).
  const stageId = !callId && typeof event?.stageId === "string" ? event.stageId.trim().slice(0, 80) : ""
  if (stageId) return appendStageActivity(current, event, stageId, now)

  const label = String(event?.description || event?.label || event?.text || "").trim()
  if (!label) return current
  const last = current[current.length - 1]
  // The same phase reported twice (heartbeat re-announcements) is one row —
  // only for frames that do not belong to a tool call.
  if (!callId && last && !last.callId && !last.stageId && last.label === label && last.status === "active") return current
  // A new row settles the earlier un-paired rows; a paired row stays active
  // until its own result (parallel tool calls run side by side), and a stage
  // row until its own tool_result.
  const settled = settleLegacyRows(current, now)
  // A paired result whose call row is missing (reconnect) still lands settled;
  // un-paired frames keep the classic behaviour (the newest row is active).
  const pairedResult = Boolean(callId) && event?.step === "tool_result"
  const kind = kindOf(event?.kind)
  const detail = cleanText(pairedResult ? "" : event?.detail, 1200)
  const result = cleanText(pairedResult ? (event?.detail ?? event?.preview) : "", 1200)
  const description = cleanText(event?.description, 160)
  const thumbs = safeThumbs(event?.thumbs)
  const phase = cleanText(event?.phase, 32)
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
      ...(phase ? { phase } : {}),
      ...(kind ? { kind } : {}),
      ...(description ? { description } : {}),
      ...(detail ? { detail } : {}),
      ...(result ? { result } : {}),
      ...(thumbs.length ? { thumbs } : {}),
      ...(pairedResult ? { ok: !failed, endedAt: now } : {}),
    },
  ]
}

/**
 * First visible token / stream end: nothing is active any more. Settled rows
 * get an end time (`now`) so they report a duration; pass `null` to settle
 * without one (a replayed trace whose `at` values are relative).
 */
export function finalizeActivity(log: ActivityStep[] | undefined, now: number | null = Date.now()): ActivityStep[] {
  const current = Array.isArray(log) ? log : []
  if (!current.some((step) => step.status === "active")) return current
  return current.map((step) => {
    if (step.status !== "active") return step
    const endedAt = step.endedAt ?? (typeof now === "number" ? now : undefined)
    return { ...step, status: "done" as const, ...(endedAt !== undefined ? { endedAt } : {}) }
  })
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
  // Persisted `at` values are relative: settle without a wall-clock end.
  return finalizeActivity(log, null)
}

/**
 * How long a settled row took: the server's measure, else its own end, else
 * the next row's start (legacy rows settle when the next phase begins).
 */
export function activityStepDurationMs(step: ActivityStep | undefined, next?: ActivityStep | null): number | undefined {
  if (!step || step.status === "active") return undefined
  if (typeof step.durationMs === "number" && Number.isFinite(step.durationMs) && step.durationMs >= 0) return step.durationMs
  // A stage row is timed by its own result only; a legacy row ends where the next begins.
  const nextAt = !step.stageId && next && typeof next.at === "number" ? next.at : null
  const end = typeof step.endedAt === "number" ? step.endedAt : nextAt
  if (end === null || !Number.isFinite(step.at)) return undefined
  const ms = end - step.at
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/** Rows for the thinking placeholder — reuses its agent-step contract. */
export function activityToPlaceholderSteps(log: ActivityStep[] | undefined): Array<{
  id: string
  name?: string
  label: string
  status: "executing" | "done" | "error"
  /** When the row began (client ms on live turns). */
  at: number
  /** One-line note under the label (file sizes, sources, attempt…). */
  detail?: string
  phase?: string
  durationMs?: number
  /** Human backend phrase: shown as-is, never re-mapped as a tool name. */
  verbatim?: boolean
}> {
  const rows = Array.isArray(log) ? log : []
  return rows.map((step, i) => {
    const durationMs = activityStepDurationMs(step, rows[i + 1])
    return {
      id: step.id,
      ...(step.tool ? { name: step.tool } : {}),
      label: step.label,
      status: step.status === "active" ? "executing" : step.status,
      at: step.at,
      ...(step.detail ? { detail: step.detail } : {}),
      ...(step.phase ? { phase: step.phase } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(step.stageId || step.phase ? { verbatim: true } : {}),
    }
  })
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

/**
 * Cheap change signature for React.memo: rows, statuses, thumbnails, end
 * times — plus the label and note of live rows, which progress frames update
 * in place.
 */
export function activitySignature(log: ActivityStep[] | undefined): string {
  if (!Array.isArray(log) || !log.length) return ""
  let key = String(log.length)
  for (const step of log) {
    key += `|${step?.status || ""}${Array.isArray(step?.thumbs) ? step.thumbs.length : 0}${step?.result ? "r" : ""}`
    key += `:${step?.endedAt ?? ""}:${step?.durationMs ?? ""}`
    if (step?.status === "active") key += `:${step.label || ""}:${step.detail || ""}`
  }
  return key
}
