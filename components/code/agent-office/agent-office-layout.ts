export type AgentOfficeLayoutVariant = "full" | "thumbnail"

export type AgentOfficeLayoutDepartment = {
  id: string
  workerCount: number
  logicalAgentCount: number
}

export type AgentOfficeDepartmentPlacement = {
  id: string
  x: number
  z: number
  column: number
  row: number
  isCeo: boolean
}

export type AgentOfficeLayout = {
  departments: AgentOfficeLayoutDepartment[]
  placements: AgentOfficeDepartmentPlacement[]
  columns: number
  rows: number
  zoneWidth: number
  zoneDepth: number
  gapX: number
  gapZ: number
  totalWidth: number
  totalDepth: number
  departmentCount: number
  interactiveWorkerCount: number
  logicalAgentCount: number
  standbyAgentCount: number
}

export type AgentOfficeStandbyAllocation = {
  byDepartment: Map<string, number>
  rendered: number
  overflow: number
}

export type AgentOfficeDeskGrid = {
  count: number
  columns: number
  rows: number
  spacingX: number
  spacingZ: number
}

const FULL_STANDBY_VISUAL_BUDGET = 768
const THUMBNAIL_STANDBY_VISUAL_BUDGET = 36
const FULL_STANDBY_PER_DEPARTMENT = 64
const THUMBNAIL_STANDBY_PER_DEPARTMENT = 6

/**
 * Full mode is the operational company view and therefore never filters or
 * truncates departments. Thumbnail mode intentionally keeps a small populated
 * sample so its decorative card remains cheap to render.
 */
export function selectAgentOfficeDepartments<
  T extends { workers: readonly unknown[] },
>(
  departments: readonly T[],
  variant: AgentOfficeLayoutVariant,
): T[] {
  if (variant === "full") return [...departments]

  const populated = departments.filter(
    (department) => department.workers.length > 0,
  )
  return [...(populated.length > 0 ? populated : departments)].slice(0, 6)
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function oddAtLeast(value: number, minimum: number): number {
  const normalized = Math.max(minimum, Math.ceil(value))
  return normalized % 2 === 0 ? normalized + 1 : normalized
}

function layoutDimensions(
  departments: readonly AgentOfficeLayoutDepartment[],
  variant: AgentOfficeLayoutVariant,
) {
  const count = departments.length
  if (variant === "thumbnail") {
    const columns = Math.min(3, Math.max(1, count))
    return {
      columns,
      rows: Math.max(1, Math.ceil(count / columns)),
      zoneWidth: 7.2,
      zoneDepth: 5.4,
      gapX: 1.2,
      gapZ: 1.1,
    }
  }

  const columns = oddAtLeast(Math.sqrt(Math.max(1, count) * 1.35), 3)
  let rows = oddAtLeast(Math.ceil(Math.max(1, count) / columns), 1)
  while (columns * rows < count) rows += 2

  const baseZoneWidth = count > 48 ? 8.2 : count > 24 ? 9.2 : 10.4
  const baseZoneDepth = count > 48 ? 6 : count > 24 ? 6.8 : 7.6
  const largestVisualRoster = departments.reduce(
    (largest, department) => Math.max(
      largest,
      Math.min(64, Math.max(department.workerCount, department.logicalAgentCount)),
    ),
    0,
  )
  const workerColumns = Math.min(
    12,
    Math.max(4, Math.ceil(Math.sqrt(Math.max(1, largestVisualRoster) * 1.1))),
  )
  const workerRows = Math.max(1, Math.ceil(largestVisualRoster / workerColumns))
  // A detailed desk is 1.95 × 0.9 and its worker has a forgiving 1.04-wide
  // hit capsule. Keep at least 1.9 world units between seats so every real
  // worker stays visually distinct and reliably clickable.
  const zoneWidth = Math.max(baseZoneWidth, 1.5 + workerColumns * 1.9)
  const zoneDepth = Math.max(baseZoneDepth, 1.6 + workerRows * 1.9)
  return {
    columns,
    rows,
    zoneWidth,
    zoneDepth,
    gapX: count > 48 ? 1 : 1.35,
    gapZ: count > 48 ? 0.9 : 1.25,
  }
}

export function buildAgentOfficeDeskGrid(
  workerCount: number,
  zoneWidth: number,
  zoneDepth: number,
  variant: AgentOfficeLayoutVariant,
): AgentOfficeDeskGrid {
  const count = Math.max(
    variant === "thumbnail" ? 2 : 3,
    nonNegativeInteger(workerCount),
  )
  const maxColumns = variant === "thumbnail"
    ? 3
    : Math.max(4, Math.floor((zoneWidth - 1.5) / 1.9))
  const columns = Math.min(maxColumns, count)
  const rows = Math.ceil(count / columns)

  return {
    count,
    columns,
    rows,
    spacingX: Math.min(2.1, (zoneWidth - 1.5) / Math.max(1, columns)),
    spacingZ: Math.min(2.2, (zoneDepth - 1.6) / Math.max(1, rows)),
  }
}

function centeredSlots(columns: number, rows: number) {
  const centerColumn = (columns - 1) / 2
  const centerRow = (rows - 1) / 2
  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const dx = column - centerColumn
    const dz = row - centerRow
    return {
      column,
      row,
      dx,
      dz,
      distance: dx * dx + dz * dz,
      angle: Math.atan2(dz, dx),
    }
  }).sort((left, right) => (
    left.distance - right.distance
    || left.angle - right.angle
    || left.row - right.row
    || left.column - right.column
  ))
}

/**
 * Builds one continuous rooftop plan. Full mode always keeps every department
 * and reserves the geometric centre for CEO Office. Thumbnail callers decide
 * which reduced set they want to pass in.
 */
export function buildAgentOfficeLayout(
  input: readonly AgentOfficeLayoutDepartment[],
  variant: AgentOfficeLayoutVariant,
): AgentOfficeLayout {
  const departments = input.map((department) => {
    const workerCount = nonNegativeInteger(department.workerCount)
    return {
      id: department.id,
      workerCount,
      logicalAgentCount: Math.max(
        workerCount,
        nonNegativeInteger(department.logicalAgentCount),
      ),
    }
  })
  const dimensions = layoutDimensions(departments, variant)
  const slots = centeredSlots(dimensions.columns, dimensions.rows)
  const ceoIndex = departments.findIndex((department) => department.id === "ceo-office")
  const ordered = ceoIndex >= 0
    ? [departments[ceoIndex], ...departments.filter((_, index) => index !== ceoIndex)]
    : departments
  const placements = ordered.map((department, index) => {
    const slot = slots[index]
    return {
      id: department.id,
      x: slot.dx * (dimensions.zoneWidth + dimensions.gapX),
      z: slot.dz * (dimensions.zoneDepth + dimensions.gapZ),
      column: slot.column,
      row: slot.row,
      isCeo: department.id === "ceo-office",
    }
  })
  const interactiveWorkerCount = departments.reduce(
    (sum, department) => sum + department.workerCount,
    0,
  )
  const logicalAgentCount = departments.reduce(
    (sum, department) => sum + department.logicalAgentCount,
    0,
  )

  return {
    departments,
    placements,
    ...dimensions,
    totalWidth:
      dimensions.columns * dimensions.zoneWidth
      + Math.max(0, dimensions.columns - 1) * dimensions.gapX,
    totalDepth:
      dimensions.rows * dimensions.zoneDepth
      + Math.max(0, dimensions.rows - 1) * dimensions.gapZ,
    departmentCount: departments.length,
    interactiveWorkerCount,
    logicalAgentCount,
    standbyAgentCount: Math.max(0, logicalAgentCount - interactiveWorkerCount),
  }
}

/**
 * Allocates neutral, non-animated capacity markers. The exact logical count is
 * kept separately; a bounded visual budget prevents a 10k-agent configuration
 * from exhausting the GPU while still giving every department a fair share.
 */
export function allocateAgentOfficeStandbyMarkers(
  layout: AgentOfficeLayout,
  variant: AgentOfficeLayoutVariant,
  budget = variant === "full"
    ? FULL_STANDBY_VISUAL_BUDGET
    : THUMBNAIL_STANDBY_VISUAL_BUDGET,
): AgentOfficeStandbyAllocation {
  const remaining = layout.departments.map((department) => ({
    id: department.id,
    count: Math.min(
      Math.max(0, department.logicalAgentCount - department.workerCount),
      variant === "full"
        ? FULL_STANDBY_PER_DEPARTMENT
        : THUMBNAIL_STANDBY_PER_DEPARTMENT,
    ),
  }))
  const byDepartment = new Map(remaining.map(({ id }) => [id, 0]))
  const limit = Math.min(
    layout.standbyAgentCount,
    nonNegativeInteger(budget),
  )
  let rendered = 0

  while (rendered < limit) {
    let allocated = false
    for (const department of remaining) {
      if (rendered >= limit) break
      const current = byDepartment.get(department.id) || 0
      if (current >= department.count) continue
      byDepartment.set(department.id, current + 1)
      rendered += 1
      allocated = true
    }
    if (!allocated) break
  }

  return {
    byDepartment,
    rendered,
    overflow: Math.max(0, layout.standbyAgentCount - rendered),
  }
}
