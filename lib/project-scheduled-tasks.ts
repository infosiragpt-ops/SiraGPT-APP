export const PROJECT_SCHEDULED_STORAGE_PREFIX = "sira:project-scheduled:"

export type ProjectScheduledFrequency = "manual" | "daily" | "weekly"
export type ProjectScheduledApproval = "manual" | "auto"

export type ProjectScheduledTask = {
  id: string
  name: string
  instructions: string
  frequency: ProjectScheduledFrequency
  approval: ProjectScheduledApproval
  requireComputer: boolean
  createdAt: string
}

export function projectScheduledStorageKey(projectId: string): string {
  return `${PROJECT_SCHEDULED_STORAGE_PREFIX}${projectId}`
}

export function parseProjectScheduledTasks(raw: unknown): ProjectScheduledTask[] {
  if (!Array.isArray(raw)) return []
  const out: ProjectScheduledTask[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === "string" ? row.id.trim() : ""
    const name = typeof row.name === "string" ? row.name.trim() : ""
    const instructions = typeof row.instructions === "string" ? row.instructions.trim() : ""
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      instructions,
      frequency: row.frequency === "daily" || row.frequency === "weekly" ? row.frequency : "manual",
      approval: row.approval === "auto" ? "auto" : "manual",
      requireComputer: Boolean(row.requireComputer),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
    })
  }
  return out
}

export function readProjectScheduledTasks(projectId: string): ProjectScheduledTask[] {
  if (typeof window === "undefined" || !projectId) return []
  try {
    return parseProjectScheduledTasks(JSON.parse(localStorage.getItem(projectScheduledStorageKey(projectId)) || "[]"))
  } catch {
    return []
  }
}

export function writeProjectScheduledTasks(projectId: string, tasks: ProjectScheduledTask[]): ProjectScheduledTask[] {
  const next = parseProjectScheduledTasks(tasks)
  if (typeof window !== "undefined" && projectId) {
    try {
      localStorage.setItem(projectScheduledStorageKey(projectId), JSON.stringify(next))
    } catch {
      /* ignore quota */
    }
  }
  return next
}
