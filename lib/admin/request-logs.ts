// Log lines of one backend request, as returned by
// GET /api/admin/logs/request/:reqId («Registros en vivo»). The payload shape
// is tolerated loosely (array, or { lines | logs | entries | items }) so the
// failure detail keeps working while that endpoint evolves.

type LogEntry = Record<string, unknown>

function pick(entry: LogEntry, keys: string[]): string {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

function timeLabel(raw: string): string {
  if (!raw) return ""
  const asNumber = Number(raw)
  const date = Number.isFinite(asNumber) && raw.length >= 12 ? new Date(asNumber) : new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toISOString().slice(11, 23)
}

export function requestLogLineText(line: unknown): string {
  if (typeof line === "string") return line
  if (!line || typeof line !== "object") return String(line ?? "")
  const entry = line as LogEntry
  const time = timeLabel(pick(entry, ["ts", "time", "timestamp", "at", "createdAt"]))
  const level = pick(entry, ["level", "severity"]).toUpperCase()
  const message = pick(entry, ["msg", "message", "line", "text"])
  const head = [time, level].filter(Boolean).join(" ")
  if (message) return head ? `${head}  ${message}` : message
  try {
    return head ? `${head}  ${JSON.stringify(entry)}` : JSON.stringify(entry)
  } catch {
    return head || "(registro ilegible)"
  }
}

export function extractRequestLogLines(payload: unknown, max = 500): string[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as LogEntry).lines ?? (payload as LogEntry).logs ?? (payload as LogEntry).entries ?? (payload as LogEntry).items)
      : null
  if (!Array.isArray(list)) return []
  return list.slice(0, max).map(requestLogLineText)
}
