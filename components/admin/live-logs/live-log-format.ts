import type { LiveLogLevel, LiveLogLine } from "@/lib/admin/live-logs-service"

export const LEVEL_LABELS: Record<LiveLogLevel, string> = {
  trace: "trace",
  debug: "debug",
  info: "info",
  warn: "aviso",
  error: "error",
  fatal: "fatal",
}

export function levelLabel(level: string): string {
  return LEVEL_LABELS[level as LiveLogLevel] || level
}

export function levelBadgeClass(level: string): string {
  switch (level) {
    case "fatal":
      return "bg-red-700 text-white"
    case "error":
      return "bg-red-600 text-white"
    case "warn":
      return "bg-amber-500/90 text-white"
    case "debug":
    case "trace":
      return "bg-muted text-muted-foreground"
    default:
      return "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200"
  }
}

/** Row tint: errors red (like Replit), warnings amber, the rest neutral. */
export function levelRowClass(level: string): string {
  if (level === "error" || level === "fatal") return "bg-red-50/80 hover:bg-red-100/80 dark:bg-red-950/35 dark:hover:bg-red-950/55"
  if (level === "warn") return "bg-amber-50/60 hover:bg-amber-100/60 dark:bg-amber-950/25 dark:hover:bg-amber-950/40"
  return "hover:bg-muted/50"
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** «18:59:02.013» (ms precision), or «26/09 18:59:02.013» with the date. */
export function formatLogTime(ts: number, withDate = false): string {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return "—"
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  return withDate ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}` : time
}

export function userLabel(line: Pick<LiveLogLine, "email" | "userId">): string {
  if (line.email) return line.email
  if (line.userId) return line.userId.length > 12 ? `${line.userId.slice(0, 10)}…` : line.userId
  return ""
}

export function sourceLabel(line: Pick<LiveLogLine, "source" | "tag">): string {
  if (line.source && line.source !== "backend") return line.source
  return line.tag ? line.tag : "backend"
}
