import type { LiveLogLine } from "@/lib/admin/live-logs-service"

export const MAX_CLIENT_LINES = 5000

function compareIds(a: string, b: string): number {
  const [am, as] = a.split("-").map(Number)
  const [bm, bs] = b.split("-").map(Number)
  if (am !== bm) return am - bm
  return (as || 0) - (bs || 0)
}

/** Append lines (deduped by id, kept in id order), bounded to `max`. */
export function appendLines(current: LiveLogLine[], incoming: LiveLogLine[], max = MAX_CLIENT_LINES): LiveLogLine[] {
  if (!incoming.length) return current
  const seen = new Set(current.map((l) => l.id))
  const fresh = incoming.filter((l) => l && l.id && !seen.has(l.id))
  if (!fresh.length) return current
  const last = current[current.length - 1]
  let next: LiveLogLine[]
  if (!last || fresh.every((l) => compareIds(l.id, last.id) > 0)) {
    next = current.concat(fresh)
  } else {
    next = current.concat(fresh).sort((a, b) => compareIds(a.id, b.id))
  }
  return next.length > max ? next.slice(next.length - max) : next
}

export function applyRepeats(current: LiveLogLine[], updates: Array<{ id: string; repeat: number; lastTs: number }>): LiveLogLine[] {
  if (!updates.length) return current
  const byId = new Map(updates.map((u) => [u.id, u]))
  let changed = false
  const next = current.map((l) => {
    const u = byId.get(l.id)
    if (!u) return l
    changed = true
    return { ...l, repeat: u.repeat, lastTs: u.lastTs }
  })
  return changed ? next : current
}

export function lastLineId(lines: LiveLogLine[]): string | null {
  return lines.length ? lines[lines.length - 1].id : null
}
