import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getVisibleProjects,
  removeProjectFromList,
  upsertProjectList,
} from "../lib/projects-logic"

type TestProject = {
  id: string
  name: string
  description: string | null
  isStarred: boolean
  createdAt: string
  updatedAt: string
}

function project(input: Partial<TestProject> & Pick<TestProject, "id" | "name">): TestProject {
  return {
    description: null,
    isStarred: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  }
}

describe("project list logic", () => {
  it("filters projects with trimmed, multi-word and accent-insensitive search", () => {
    const projects = [
      project({
        id: "theory",
        name: "Marco Teórico",
        description: "Investigación de educación médica",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      project({
        id: "market",
        name: "Mercado de salud",
        description: "Análisis competitivo",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]

    assert.deepEqual(
      getVisibleProjects(projects, "  marco teorico  ", "activity").map(item => item.id),
      ["theory"]
    )
    assert.deepEqual(
      getVisibleProjects(projects, "educacion medica", "activity").map(item => item.id),
      ["theory"]
    )
  })

  it("keeps starred projects first and upserts without duplicate cards", () => {
    const projects = [
      project({ id: "recent", name: "Proyecto reciente", updatedAt: "2026-01-03T00:00:00.000Z" }),
      project({ id: "starred", name: "Proyecto importante", isStarred: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
      project({ id: "old", name: "Proyecto antiguo", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]

    assert.deepEqual(
      getVisibleProjects(projects, "", "activity").map(item => item.id),
      ["starred", "recent", "old"]
    )

    const updated = project({
      id: "old",
      name: "Proyecto antiguo actualizado",
      isStarred: true,
      updatedAt: "2026-01-04T00:00:00.000Z",
    })
    const next = upsertProjectList(projects, updated, "activity")

    assert.equal(next.length, 3)
    assert.deepEqual(next.map(item => item.id), ["old", "starred", "recent"])
    assert.equal(next[0].name, "Proyecto antiguo actualizado")
    assert.deepEqual(removeProjectFromList(next, "starred").map(item => item.id), ["old", "recent"])
  })
})
