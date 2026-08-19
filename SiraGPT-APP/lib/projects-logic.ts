import type { Project, ProjectSort } from "./projects-service"

type ProjectListItem = Pick<Project, "id" | "name" | "description" | "isStarred" | "createdAt" | "updatedAt">

const PROJECT_ACCENTS = [
  { accent: "#ff0000", soft: "#fff1f1", ink: "#ffffff" },
  { accent: "#0f766e", soft: "#ecfdf5", ink: "#ffffff" },
  { accent: "#1d4ed8", soft: "#eff6ff", ink: "#ffffff" },
  { accent: "#7c2d12", soft: "#fff7ed", ink: "#ffffff" },
  { accent: "#111827", soft: "#f3f4f6", ink: "#ffffff" },
  { accent: "#6d28d9", soft: "#f5f3ff", ink: "#ffffff" },
]

export interface ProjectVisualIdentity {
  initials: string
  accent: string
  soft: string
  ink: string
  title: string
  subtitle: string
  eyebrow: string
}

export function normalizeProjectSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
}

export function projectMatchesSearch(project: ProjectListItem, rawSearch: string): boolean {
  const search = normalizeProjectSearch(rawSearch)
  if (!search) return true

  const haystack = normalizeProjectSearch(`${project.name} ${project.description || ""}`)
  return search.split(" ").every(token => haystack.includes(token))
}

export function filterProjects<T extends ProjectListItem>(projects: T[], rawSearch: string): T[] {
  if (!normalizeProjectSearch(rawSearch)) return [...projects]
  return projects.filter(project => projectMatchesSearch(project, rawSearch))
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function sortProjects<T extends ProjectListItem>(projects: T[], sort: ProjectSort): T[] {
  const dateField = sort === "created" ? "createdAt" : "updatedAt"

  return [...projects].sort((a, b) => {
    if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1

    const dateDelta = timestamp(b[dateField]) - timestamp(a[dateField])
    if (dateDelta !== 0) return dateDelta

    const nameDelta = a.name.localeCompare(b.name)
    if (nameDelta !== 0) return nameDelta

    return a.id.localeCompare(b.id)
  })
}

export function getVisibleProjects<T extends ProjectListItem>(projects: T[], rawSearch: string, sort: ProjectSort): T[] {
  return sortProjects(filterProjects(projects, rawSearch), sort)
}

export function upsertProjectList<T extends ProjectListItem>(projects: T[], project: T, sort: ProjectSort): T[] {
  let found = false
  const next = projects.map(item => {
    if (item.id !== project.id) return item
    found = true
    return { ...item, ...project }
  })

  if (!found) next.unshift(project)
  return sortProjects(next, sort)
}

export function removeProjectFromList<T extends ProjectListItem>(projects: T[], projectId: string): T[] {
  return projects.filter(project => project.id !== projectId)
}

function hashProjectName(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function getProjectInitials(name: string): string {
  const words = String(name || "")
    .trim()
    .match(/[\p{Letter}\p{Number}]+/gu) || []
  if (words.length === 0) return "AP"
  const first = words[0] || ""
  if (words.length === 1) return first.slice(0, 2).toUpperCase()
  const second = words[1] || ""
  return `${first[0] || ""}${second[0] || ""}`.toUpperCase()
}

export function getProjectVisualIdentity(project: Pick<Project, "name" | "description" | "type">): ProjectVisualIdentity {
  const title = String(project.name || "Nueva plataforma").trim() || "Nueva plataforma"
  const palette = PROJECT_ACCENTS[hashProjectName(title) % PROJECT_ACCENTS.length]
  const subtitle = String(project.description || "").trim() || "Workspace privado de software en SiraGPT."
  return {
    initials: getProjectInitials(title),
    accent: palette.accent,
    soft: palette.soft,
    ink: palette.ink,
    title,
    subtitle,
    eyebrow: project.type === "webapp" ? "App privada" : "Proyecto privado",
  }
}

export function daysUntilProjectDelete(deleteAfter: string | null | undefined, nowMs = Date.now()): number | null {
  if (!deleteAfter) return null
  const target = Date.parse(deleteAfter)
  if (Number.isNaN(target)) return null
  return Math.max(0, Math.ceil((target - nowMs) / (24 * 60 * 60 * 1000)))
}
