import assert from "node:assert/strict"
import test from "node:test"

import {
  allocateAgentOfficeStandbyMarkers,
  buildAgentOfficeDeskGrid,
  buildAgentOfficeLayout,
  selectAgentOfficeDepartments,
} from "../components/code/agent-office/agent-office-layout"

test("full department selection never truncates or hides empty departments", () => {
  const departments = Array.from({ length: 14 }, (_, index) => ({
    id: index === 7 ? "ceo-office" : `department-${index}`,
    workers: index % 2 === 0 ? [{ id: `worker-${index}` }] : [],
  }))

  const full = selectAgentOfficeDepartments(departments, "full")
  const thumbnail = selectAgentOfficeDepartments(departments, "thumbnail")

  assert.equal(full.length, 14)
  assert.deepEqual(full.map((department) => department.id), departments.map((department) => department.id))
  assert.ok(full.some((department) => department.workers.length === 0))
  assert.equal(thumbnail.length, 6)
  assert.ok(thumbnail.every((department) => department.workers.length > 0))
})

test("full office layout keeps every department and centres CEO Office", () => {
  const departments = [
    { id: "engineering", workerCount: 3, logicalAgentCount: 24 },
    { id: "marketing", workerCount: 2, logicalAgentCount: 18 },
    { id: "ceo-office", workerCount: 1, logicalAgentCount: 8 },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `department-${index}`,
      workerCount: index % 3,
      logicalAgentCount: 4 + index,
    })),
  ]

  const layout = buildAgentOfficeLayout(departments, "full")

  assert.equal(layout.departmentCount, departments.length)
  assert.equal(layout.placements.length, departments.length)
  assert.deepEqual(
    new Set(layout.placements.map((placement) => placement.id)),
    new Set(departments.map((department) => department.id)),
  )
  const ceo = layout.placements.find((placement) => placement.id === "ceo-office")
  assert.ok(ceo)
  assert.equal(ceo.x, 0)
  assert.equal(ceo.z, 0)
  assert.equal(ceo.isCeo, true)
  assert.equal(layout.interactiveWorkerCount, departments.reduce((sum, row) => sum + row.workerCount, 0))
  assert.equal(layout.logicalAgentCount, departments.reduce((sum, row) => sum + row.logicalAgentCount, 0))
})

test("logical capacity never replaces or undercounts interactive real workers", () => {
  const layout = buildAgentOfficeLayout([
    { id: "ceo-office", workerCount: 5, logicalAgentCount: 1 },
    { id: "engineering", workerCount: 2, logicalAgentCount: 12 },
  ], "full")

  assert.equal(layout.interactiveWorkerCount, 7)
  assert.equal(layout.logicalAgentCount, 17)
  assert.equal(layout.standbyAgentCount, 10)

  const allocation = allocateAgentOfficeStandbyMarkers(layout, "full")
  assert.equal(allocation.rendered, 10)
  assert.equal(allocation.overflow, 0)
  assert.equal(allocation.byDepartment.get("ceo-office"), 0)
  assert.equal(allocation.byDepartment.get("engineering"), 10)
})

test("standby visualization stays bounded while preserving the exact logical total", () => {
  const layout = buildAgentOfficeLayout([
    { id: "ceo-office", workerCount: 1, logicalAgentCount: 10_000 },
    { id: "engineering", workerCount: 4, logicalAgentCount: 196 },
  ], "full")
  const allocation = allocateAgentOfficeStandbyMarkers(layout, "full")

  assert.equal(layout.logicalAgentCount, 10_196)
  assert.equal(layout.interactiveWorkerCount, 5)
  assert.equal(layout.standbyAgentCount, 10_191)
  assert.ok(allocation.rendered <= 128)
  assert.equal(allocation.rendered + allocation.overflow, layout.standbyAgentCount)
})

test("196 logical agents remain exact and are represented as neutral standby capacity", () => {
  const layout = buildAgentOfficeLayout([
    { id: "ceo-office", workerCount: 1, logicalAgentCount: 16 },
    { id: "engineering", workerCount: 4, logicalAgentCount: 64 },
    { id: "operations", workerCount: 0, logicalAgentCount: 64 },
    { id: "market-intelligence", workerCount: 2, logicalAgentCount: 52 },
  ], "full")
  const allocation = allocateAgentOfficeStandbyMarkers(layout, "full")

  assert.equal(layout.logicalAgentCount, 196)
  assert.equal(layout.interactiveWorkerCount, 7)
  assert.equal(layout.standbyAgentCount, 189)
  assert.equal(allocation.rendered, 189)
  assert.equal(allocation.overflow, 0)
})

test("large real rosters grow the zone and keep detailed workers clickable", () => {
  const layout = buildAgentOfficeLayout([
    { id: "ceo-office", workerCount: 1, logicalAgentCount: 16 },
    { id: "engineering", workerCount: 64, logicalAgentCount: 64 },
  ], "full")
  const grid = buildAgentOfficeDeskGrid(
    64,
    layout.zoneWidth,
    layout.zoneDepth,
    "full",
  )

  assert.equal(grid.count, 64)
  assert.ok(grid.columns >= 8)
  assert.ok(grid.spacingX >= 1.89)
  assert.ok(grid.spacingZ >= 1.89)
  assert.ok(layout.zoneWidth > 10.4)
  assert.ok(layout.zoneDepth > 7.6)
})

test("thumbnail layout remains compact for its caller-selected subset", () => {
  const departments = Array.from({ length: 6 }, (_, index) => ({
    id: index === 0 ? "ceo-office" : `department-${index}`,
    workerCount: 1,
    logicalAgentCount: 8,
  }))
  const layout = buildAgentOfficeLayout(departments, "thumbnail")
  const allocation = allocateAgentOfficeStandbyMarkers(layout, "thumbnail")

  assert.equal(layout.departmentCount, 6)
  assert.ok(layout.columns <= 3)
  assert.equal(layout.zoneWidth, 7.2)
  assert.ok(allocation.rendered <= 36)
})
