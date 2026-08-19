import type { Project, ProjectSort } from "./projects-service"

type ProjectListItem = Pick<Project, "id" | "name" | "description" | "isStarred" | "createdAt" | "updatedAt">

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
