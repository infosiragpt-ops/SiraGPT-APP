import { expect, test, type Locator, type Page, type Route } from "@playwright/test"

import { AGENT_COMPANY_DEPARTMENTS } from "../lib/code-agent-company"

test.describe.configure({ timeout: 120_000 })

const OFFICE_READY_TIMEOUT_MS = 45_000

const now = "2026-08-10T16:00:00.000Z"
const project = {
  id: "office-critical",
  name: "SiraGPT",
  description: "Empresa de agentes",
  instructions: null,
  isStarred: false,
  shareId: null,
  createdAt: now,
  updatedAt: now,
  files: [],
  chats: [],
}

const user = {
  id: "office-critical-user",
  name: "Valeria Castro",
  email: "valeria@example.com",
  plan: "PRO",
  isAdmin: true,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: now,
  updatedAt: now,
}

const CRITICAL_CODEX_PROJECT_ID = "codex-office-critical"
const departmentPoolId = (departmentId: string) => `pool-${departmentId}`
const logicalAgentCount = AGENT_COMPANY_DEPARTMENTS.reduce(
  (total, department) => total + (department.desiredAgents || 1),
  0,
)

function criticalDepartmentPools(projectId = CRITICAL_CODEX_PROJECT_ID) {
  return AGENT_COMPANY_DEPARTMENTS.map((department) => ({
    id: departmentPoolId(department.id),
    projectId,
    departmentId: department.id,
    size: department.desiredAgents || 1,
    dailyBudgetUsd: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }))
}

const criticalDepartments = AGENT_COMPANY_DEPARTMENTS.map((department) => ({
  ...department,
  keywords: [...department.keywords],
  mission: department.mission || department.description,
  kind: department.kind || "coordination",
  desiredAgents: department.desiredAgents || 1,
  custom: false,
  enabled: true,
}))

const runs = [
  {
    id: "office-run-trust",
    projectId: "codex-office-critical",
    mode: "build",
    status: "running",
    tier: "pro",
    model: "gpt-5.4",
    planRunId: null,
    departmentPoolId: departmentPoolId("trust"),
    prompt: "[PROACTIVO · Confianza, Privacidad y Cumplimiento] Auditar el aislamiento",
    error: null,
    createdAt: "2026-08-10T15:58:00.000Z",
    startedAt: "2026-08-10T15:58:04.000Z",
    finishedAt: null,
  },
  {
    id: "office-run-product",
    projectId: "codex-office-critical",
    mode: "build",
    status: "done",
    tier: "pro",
    model: "gpt-5.4",
    planRunId: null,
    departmentPoolId: departmentPoolId("product-engineering"),
    prompt: "[PROACTIVO · Producto e Ingeniería] Verificar la megaoficina",
    error: null,
    createdAt: "2026-08-10T15:40:00.000Z",
    startedAt: "2026-08-10T15:40:03.000Z",
    finishedAt: "2026-08-10T15:45:00.000Z",
  },
]

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function mockCriticalOffice(page: Page) {
  const operations = {
    cancelledRunIds: [] as string[],
    cancelActiveCalls: 0,
    retryBodies: [] as Array<Record<string, unknown>>,
  }
  await page.addInitScript(({ activeProject, currentUser, timestamp, departmentSeeds }) => {
    const baseSession = {
      workspaceId: `project:${activeProject.id}`,
      turns: [],
      createdAt: Date.parse(timestamp),
      updatedAt: Date.parse(timestamp),
      agent: { phase: "idle", intakeStep: 0, context: { goal: "" } },
    }
    const sessions = departmentSeeds.map((department, index) => ({
      ...baseSession,
      id: `office-${department.id}`,
      title: department.name,
      departmentId: department.id,
      departmentPoolId: department.poolId,
      createdAt: Date.parse(timestamp) + index,
      updatedAt: Date.parse(timestamp) + index,
      turns: department.id === "product-engineering" ? [{
        id: "office-turn-product",
        role: "assistant",
        content: "Verificando la oficina.",
        codexRunId: "office-run-product",
      }] : [],
    }))

    localStorage.setItem("auth-token", "office-critical-token")
    localStorage.setItem("siragpt:office-sound-enabled", "off")
    localStorage.setItem("code-workspace:active-folder", JSON.stringify(activeProject))
    localStorage.setItem(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions,
        activeByWorkspace: { [`project:${activeProject.id}`]: "office-ceo-office" },
      }),
    )
    localStorage.setItem(
      "code-workspace:codex-registry",
      JSON.stringify([
        {
          id: activeProject.id,
          name: activeProject.name,
          kind: "project",
          updatedAt: Date.parse(timestamp),
        },
      ]),
    )
    localStorage.setItem("siragpt:codex-project:office-ceo-office", "codex-office-critical")
    localStorage.setItem("office-critical:user", JSON.stringify(currentUser))
  }, {
    activeProject: project,
    currentUser: user,
    timestamp: now,
    departmentSeeds: AGENT_COMPANY_DEPARTMENTS.map((department) => ({
      id: department.id,
      name: department.name,
      poolId: departmentPoolId(department.id),
    })),
  })

  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/projects" && request.method() === "GET") {
      return fulfillJson(route, { projects: [project] })
    }
    if (path === `/projects/${project.id}` && request.method() === "GET") {
      return fulfillJson(route, { project })
    }
    if (path === "/codex/health") {
      return fulfillJson(route, { ok: true, enabled: true, previewOrigin: "https://preview.example.test" })
    }
    if (path === "/codex/access") {
      return fulfillJson(route, { ok: true, enabled: true, canRun: true, allowlistConfigured: true })
    }
    if (path === "/codex/company-associations" && request.method() === "GET") {
      return fulfillJson(route, {
        company: {
          id: project.id,
          name: project.name,
          organizationId: null,
          type: "webapp",
          updatedAt: now,
        },
        association: {
          id: "office-critical-association",
          source: "manual",
          organizationId: null,
          linkedAt: now,
          updatedAt: now,
          codexProject: {
            id: "codex-office-critical",
            name: "SiraGPT",
            organizationId: null,
            status: "ready",
            updatedAt: now,
          },
          connectors: [],
        },
        candidates: [],
        connectors: [],
        requiresAssociation: false,
      })
    }
    if (/^\/codex\/projects\/[^/]+\/proactive$/.test(path)) {
      const codexProjectId = path.split("/")[3] || CRITICAL_CODEX_PROJECT_ID
      return fulfillJson(route, {
        state: {
          enabled: false,
          enabledAt: null,
          dayKey: "2026-08-10",
          runsToday: 0,
          deptIndex: 0,
          lastCycleAt: null,
          lastError: null,
          costTodayUsd: 0,
          dailyBudgetUsd: 25,
          budgetBlocked: false,
          lastDepartment: null,
          missionIndex: 0,
          lastMissionId: null,
        },
        departments: criticalDepartments,
        departmentPools: criticalDepartmentPools(codexProjectId),
        capacity: {
          departments: AGENT_COMPANY_DEPARTMENTS.length,
          logicalAgents: logicalAgentCount,
          departmentPools: AGENT_COMPANY_DEPARTMENTS.length,
          physicalAgents: 32,
          writerConcurrency: 32,
          dailyBudgetUsd: 0,
          strategy: "isolated_worktrees_serialized_merge",
        },
      })
    }
    if (/^\/codex\/projects\/[^/]+\/company-resources$/.test(path)) {
      return fulfillJson(route, { resources: { assignments: {}, pinned: [], revision: 0 } })
    }
    if (/^\/codex\/projects\/[^/]+\/runs$/.test(path) && request.method() === "GET") {
      return fulfillJson(route, {
        runs: operations.cancelActiveCalls > 0
          ? runs.map((run) => run.id === "office-run-trust"
            ? { ...run, status: "cancelled", finishedAt: now }
            : run)
          : runs,
      })
    }
    if (/^\/codex\/projects\/[^/]+\/runs$/.test(path) && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>
      operations.retryBodies.push(body)
      return fulfillJson(route, {
        run: {
          ...runs[1],
          id: `office-retry-${operations.retryBodies.length}`,
          mode: "plan",
          status: "queued",
          prompt: body.prompt,
          model: body.model || null,
          tier: body.tier || null,
          departmentPoolId: body.departmentPoolId || null,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        },
      }, 201)
    }
    if (/^\/codex\/runs\/[^/]+\/cancel-family$/.test(path) && request.method() === "POST") {
      const runId = path.split("/")[3]
      operations.cancelledRunIds.push(runId)
      const cancelled = runs
        .filter((run) => run.id === runId || run.planRunId === runId)
        .map((run) => ({ ...run, status: "cancelled", finishedAt: now }))
      return fulfillJson(route, { runs: cancelled, cancelledRunIds: cancelled.map((run) => run.id) })
    }
    if (/^\/codex\/projects\/[^/]+\/runs\/cancel-active$/.test(path) && request.method() === "POST") {
      operations.cancelActiveCalls += 1
      const cancelled = runs
        .filter((run) => run.id === "office-run-trust")
        .map((run) => ({ ...run, status: "cancelled", finishedAt: now }))
      return fulfillJson(route, {
        complete: true,
        requestedRunIds: ["office-run-trust"],
        cancelledRunIds: ["office-run-trust"],
        failedRunIds: [],
        runs: cancelled,
      })
    }
    if (/^\/codex\/projects\/[^/]+\/checkpoints$/.test(path)) {
      return fulfillJson(route, { checkpoints: [] })
    }
    if (/^\/codex\/projects\/[^/]+\/mission-evidence$/.test(path)) {
      return fulfillJson(route, {
        ledger: {
          version: 1,
          summary: {
            missions: 0,
            completed: 0,
            blocked: 0,
            pendingReview: 0,
            approved: 0,
            reports: 0,
            emailQueued: 0,
          },
          records: [],
          reports: [],
        },
      })
    }
    if (path === "/ai/models") {
      return fulfillJson(route, {
        models: [{
          id: "office-model",
          name: "gpt-5.4",
          displayName: "GPT-5.4",
          provider: "OpenAI",
          type: "TEXT",
        }],
      })
    }
    if (path === "/payments/subscription") {
      return fulfillJson(route, {
        plan: "PRO",
        status: "active",
        subscription: null,
        apiUsage: 0,
        monthlyLimit: 100_000,
      })
    }
    if (path === "/users/me/notifications") {
      return fulfillJson(route, { items: [], total: 0, unreadCount: 0 })
    }
    if (path === "/cowork/approvals") return fulfillJson(route, { approvals: [] })
    if (path === "/social-posts/operations") {
      return fulfillJson(route, {
        policy: {
          enabled: false,
          mode: "review",
          autopilot: false,
          objective: "",
          dailyLimit: 1,
          platforms: { facebook: false, linkedin: false, x: false },
          workspaceId: project.id,
          updatedAt: now,
        },
        providers: [],
        metrics: { queued: 0, publishedToday: 0 },
      })
    }
    if (path === "/social-posts" || path === "/social-posts/") {
      return fulfillJson(route, { posts: [] })
    }
    if (path === "/codex/projects") {
      return fulfillJson(route, { projects: [{ id: "codex-office-critical", name: "SiraGPT", status: "ready" }] })
    }
    if (path === "/chats") {
      return fulfillJson(route, { chats: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } })
    }

    return fulfillJson(route, {})
  })
  return operations
}

async function openOffice(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await mockCriticalOffice(page)
  await page.goto(`/code?folder=${project.id}`, { waitUntil: "domcontentloaded" })

  const entry = page.getByTestId("agent-company-live-preview")
  await expect(entry).toBeVisible({ timeout: 30_000 })
  await entry.click()

  const dialog = page.getByRole("dialog")
  const scene = page.getByTestId("agent-office-scene")
  const canvas = scene.locator("canvas")
  await expect(dialog).toBeVisible()
  await expect(scene).toHaveAttribute("data-office-ready", "true", { timeout: OFFICE_READY_TIMEOUT_MS })
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute("aria-label", /\S+/)

  return { dialog, scene, canvas }
}

type PersistedDepartmentSession = {
  id: string
  workspaceId: string
  title: string
  departmentId: string | null
  departmentPoolId: string | null
}

async function activeDepartmentSession(page: Page): Promise<PersistedDepartmentSession | null> {
  return page.evaluate((workspaceId) => {
    const raw = localStorage.getItem("code-workspace:agent-sessions:v1")
    if (!raw) return null
    const store = JSON.parse(raw) as {
      sessions?: Array<{
        id?: string
        workspaceId?: string
        title?: string
        departmentId?: string
        departmentPoolId?: string
      }>
      activeByWorkspace?: Record<string, string>
    }
    const activeId = store.activeByWorkspace?.[`project:${workspaceId}`]
    const session = store.sessions?.find((candidate) => candidate.id === activeId)
    if (!session?.id || !session.workspaceId || !session.title) return null
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      title: session.title,
      departmentId: session.departmentId || null,
      departmentPoolId: session.departmentPoolId || null,
    }
  }, project.id)
}

async function expectAccessibleTouchTarget(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(40)
  expect(box!.height).toBeGreaterThanOrEqual(40)
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`${viewport.name} opens an accessible office and exposes every department`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    const { dialog, scene, canvas } = await openOffice(page, viewport)
    await expect(dialog).toHaveAttribute("aria-modal", "true")
    await expect(dialog).toHaveAttribute("aria-labelledby", "agent-office-title")
    await expect(dialog.locator("#agent-office-title")).toHaveText("Oficina de agentes")
    await expect(dialog).toHaveAttribute("data-office-phase", "night")
    await expect(dialog).toHaveAttribute("data-office-time", "night")
    await expect(scene).toHaveAttribute("data-office-phase", "night")
    await expect.poll(async () => Number(await canvas.getAttribute("data-city-light-count"))).toBeGreaterThanOrEqual(14)

    const timeToggle = dialog.getByTestId("agent-office-time-toggle")
    const soundToggle = dialog.getByTestId("agent-office-sound-toggle")
    const pauseToggle = dialog.getByRole("button", { name: "Pausar oficina" })
    const closeToggle = dialog.getByRole("button", { name: "Cerrar oficina" })
    await expect(timeToggle).toBeVisible()
    await expect(timeToggle).toHaveAttribute("aria-label", "Ambiente Noche. Cambiar ciclo de luz")
    await expect(soundToggle).toBeVisible()
    await expect(soundToggle).toHaveAttribute("aria-label", /^(Activar|Desactivar|Reintentar) sonido de la oficina$/)
    await expect(pauseToggle).toBeVisible()
    await expect(closeToggle).toBeVisible()
    await expectAccessibleTouchTarget(timeToggle)
    await expectAccessibleTouchTarget(soundToggle)
    await expectAccessibleTouchTarget(pauseToggle)
    await expectAccessibleTouchTarget(closeToggle)

    const departmentSelect = dialog.getByRole("combobox")
    await expect(departmentSelect).toBeVisible()

    const optionValues = await departmentSelect.locator("option").evaluateAll((options) => (
      options.map((option) => (option as HTMLOptionElement).value)
    ))
    expect(optionValues[0]).toBe("all")
    expect(optionValues.slice(1).sort()).toEqual(
      AGENT_COMPANY_DEPARTMENTS.map((department) => department.id).sort(),
    )
    await expect(dialog).toHaveAttribute("data-department-count", String(AGENT_COMPANY_DEPARTMENTS.length))
    await expect(dialog).toHaveAttribute("data-logical-agent-count", "196")
    await expect(canvas).toHaveAttribute("data-office-workstation-count", "196")
    await expect(dialog).toHaveAttribute("data-interactive-worker-count", /^[1-9]\d*$/)
    if (viewport.name === "desktop") {
      const departmentList = dialog.getByTestId("agent-office-department-list")
      await expect(departmentList).toBeVisible()
      await expect(departmentList.locator("[data-department-id]")).toHaveCount(AGENT_COMPANY_DEPARTMENTS.length)
    }
    const horizontalOverflow = await dialog.evaluate((node) => {
      const viewportWidth = document.documentElement.clientWidth
      return Array.from(node.querySelectorAll<HTMLElement>("*"))
        .filter((element) => element.offsetParent !== null)
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            tag: element.tagName.toLowerCase(),
            testId: element.dataset.testid || null,
            className: typeof element.className === "string" ? element.className : "",
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          }
        })
        .filter((element) => element.left < -1 || element.right > viewportWidth + 1)
        .slice(0, 8)
    })
    expect(horizontalOverflow).toEqual([])

    await expect(dialog.getByRole("button", { name: "Cerrar oficina" })).toBeFocused()

    const officeNavigation = viewport.name === "desktop"
      ? dialog.getByRole("navigation", { name: "Navegación de la oficina" })
      : dialog.getByRole("navigation", { name: "Navegación móvil de la oficina" })
    await officeNavigation.getByRole("button", { name: "Panel" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId("company-dashboard-surface")).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/code\\?folder=${project.id}`))
  })
}

test("office navigation opens every operational company surface", async ({ page }) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  let { dialog } = await openOffice(page, { width: 1440, height: 900 })

  for (const destination of [
    { label: "Panel", view: "dashboard", testId: "company-dashboard-surface" },
    { label: "Controlar", view: "control", testId: "company-control-surface" },
    { label: "Archivos", view: "files", testId: "company-files-surface" },
    { label: "Recursos", view: "resources", testId: "company-resources-surface" },
  ] as const) {
    const navigation = dialog.getByRole("navigation", { name: "Navegación de la oficina" })
    await navigation.getByRole("button", { name: destination.label, exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId("agent-company-preview-surface")).toHaveAttribute(
      "data-company-view",
      destination.view,
    )
    await expect(page.locator(`[data-testid="${destination.testId}"]:visible`)).toBeVisible()
    await page.getByRole("button", { name: "Cerrar vista de empresa" }).click()
    await expect(page.getByTestId("agent-company-preview-surface")).toBeHidden()

    if (destination.label !== "Recursos") {
      await page.getByTestId("agent-company-live-preview").click()
      dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      await expect(page.getByTestId("agent-office-scene")).toHaveAttribute(
        "data-office-ready",
        "true",
        { timeout: OFFICE_READY_TIMEOUT_MS },
      )
    }
  }
})

test("Controlar inspects, stops and retries real run families with their department context", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const operations = await mockCriticalOffice(page)
  await page.goto(`/code?folder=${project.id}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("agent-company-live-preview")).toBeVisible({ timeout: 30_000 })

  await page.getByRole("button", { name: /^Controlar(?:\s+\d+)?$/ }).click()
  const surface = page.locator('[data-testid="company-control-surface"]:visible')
  await expect(surface).toBeVisible()

  const stop = surface.getByRole("button", { name: /Detener Auditar el aislamiento/ })
  const retry = surface.getByRole("button", { name: /Reintentar Verificar la megaoficina/ })
  const inspect = surface
    .getByTestId("company-run-actions-office-run-product")
    .getByRole("button", { name: /Inspeccionar Verificar la megaoficina/ })
  await expect(stop).toBeVisible()
  await expect(retry).toBeVisible()
  await expect(inspect).toBeVisible()
  await expectAccessibleTouchTarget(stop)
  await expectAccessibleTouchTarget(retry)
  await expectAccessibleTouchTarget(inspect)

  await stop.click()
  await expect.poll(() => operations.cancelledRunIds).toEqual(["office-run-trust"])
  await expect(surface.getByRole("button", { name: /Reintentar Auditar el aislamiento/ })).toBeVisible()

  await retry.click()
  await expect.poll(() => operations.retryBodies.length).toBe(1)
  expect(operations.retryBodies[0]).toMatchObject({
    mode: "plan",
    prompt: "[PROACTIVO · Producto e Ingeniería] Verificar la megaoficina",
    model: "gpt-5.4",
    tier: "pro",
    autoExecute: true,
    departmentPoolId: departmentPoolId("product-engineering"),
  })

  await inspect.click()
  await expect(page.locator('[data-testid="company-task-surface"]:visible')).toBeVisible()
})

test("Panel stops every active family through the authoritative project endpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const operations = await mockCriticalOffice(page)
  await page.goto(`/code?folder=${project.id}`, { waitUntil: "domcontentloaded" })

  await page.getByRole("button", { name: "Panel", exact: true }).click()
  const surface = page.locator('[data-testid="company-dashboard-surface"]:visible')
  await expect(surface).toBeVisible({ timeout: 30_000 })

  const cancelAll = surface.getByRole("button", { name: "Cancelar ejecución de agentes" })
  await expect(cancelAll).toBeEnabled()
  await expectAccessibleTouchTarget(cancelAll)
  await cancelAll.click()

  await expect.poll(() => operations.cancelActiveCalls).toBe(1)
  await expect(page.getByText(/1 familia de ejecución detenida/)).toBeVisible()
  await expect(cancelAll).toBeDisabled()
})

test("all 14 departments open their isolated chat seat without external services", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockCriticalOffice(page)
  await page.goto(`/code?folder=${project.id}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible({ timeout: 30_000 })

  await expect.poll(() => activeDepartmentSession(page), {
    message: "CEO Office must remain the canonical active department session after hydration",
  }).toEqual({
    id: "office-ceo-office",
    workspaceId: `project:${project.id}`,
    title: "CEO Office",
    departmentId: "ceo-office",
    departmentPoolId: departmentPoolId("ceo-office"),
  })

  for (const department of AGENT_COMPANY_DEPARTMENTS) {
    const row = page.getByTestId(`agent-company-department-${department.id}`)
    await expect(row).toBeAttached()
    await row.getByRole("button", { name: `Abrir ${department.name}`, exact: true }).click()
    await expect.poll(() => activeDepartmentSession(page), {
      message: `Opening ${department.name} must activate its durable department session`,
    }).toEqual({
      id: `office-${department.id}`,
      workspaceId: `project:${project.id}`,
      title: department.name,
      departmentId: department.id,
      departmentPoolId: departmentPoolId(department.id),
    })
  }

  const persistedDepartments = await page.evaluate((workspaceId) => {
    const raw = localStorage.getItem("code-workspace:agent-sessions:v1")
    if (!raw) return []
    const store = JSON.parse(raw) as {
      sessions?: Array<{
        workspaceId?: string
        title?: string
        departmentId?: string
        departmentPoolId?: string
      }>
    }
    return (store.sessions || [])
      .filter((session) => session.workspaceId === `project:${workspaceId}` && session.departmentId)
      .map((session) => ({
        title: session.title || null,
        departmentId: session.departmentId || null,
        departmentPoolId: session.departmentPoolId || null,
      }))
  }, project.id)
  expect(persistedDepartments).toHaveLength(AGENT_COMPANY_DEPARTMENTS.length)
  expect(persistedDepartments).toEqual(expect.arrayContaining(
    AGENT_COMPANY_DEPARTMENTS.map((department) => ({
      title: department.name,
      departmentId: department.id,
      departmentPoolId: departmentPoolId(department.id),
    })),
  ))
})

test("reduced motion keeps the canvas stable without disabling office navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const { dialog, canvas } = await openOffice(page, { width: 1440, height: 900 })

  expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)
  await expect(canvas).toHaveAttribute("data-frame-count", /^\d+$/)
  await page.waitForTimeout(250)
  const firstFrameCount = await canvas.getAttribute("data-frame-count")
  expect(Number(firstFrameCount)).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  const settledFrameCount = Number(await canvas.getAttribute("data-frame-count"))
  expect(settledFrameCount - Number(firstFrameCount)).toBeLessThanOrEqual(1)

  const departmentSelect = dialog.getByRole("combobox")
  await departmentSelect.selectOption("trust")
  await expect(departmentSelect).toHaveValue("trust")

  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})
