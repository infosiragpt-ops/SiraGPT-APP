import { expect, test, type Page, type Route } from "@playwright/test"

import { AGENT_COMPANY_DEPARTMENTS } from "../lib/code-agent-company"

test.describe.configure({ timeout: 120_000 })

const SCALE_WORKERS = 196
const OFFICE_READY_BUDGET_MS = 15_000
const DRAW_CALL_BUDGET = 2_500
const TRIANGLE_BUDGET = 300_000
const now = "2026-08-10T16:00:00.000Z"

const project = {
  id: "office-scale-196",
  name: "SiraGPT",
  description: "Empresa de agentes a escala real",
  instructions: null,
  isStarred: false,
  shareId: null,
  createdAt: now,
  updatedAt: now,
  files: [],
  chats: [],
}

const user = {
  id: "office-scale-user",
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

const departmentPools = AGENT_COMPANY_DEPARTMENTS.map((department) => ({
  id: `pool-${department.id}`,
  projectId: "codex-office-scale-196",
  departmentId: department.id,
  size: department.desiredAgents || 1,
  dailyBudgetUsd: 25,
  enabled: true,
  createdAt: now,
  updatedAt: now,
}))

// One real CEO chat session plus 195 durable runs gives exactly 196 rendered
// workers. No worker in this fixture comes from standby/capacity markers.
const runs = AGENT_COMPANY_DEPARTMENTS.flatMap((department, departmentIndex) => {
  const runCount = (department.desiredAgents || 1) - (department.id === "ceo-office" ? 1 : 0)
  return Array.from({ length: runCount }, (_, workerIndex) => {
    const active = departmentIndex === 0 || workerIndex === 0 || (
      department.id === "product-engineering" && workerIndex === 1
    )
    const sequence = departmentIndex * 100 + workerIndex
    return {
      id: `scale-run-${department.id}-${workerIndex + 1}`,
      projectId: "codex-office-scale-196",
      departmentPoolId: `pool-${department.id}`,
      swarmTaskId: null,
      mode: "build",
      status: active ? "running" : "done",
      tier: "pro",
      model: "gpt-5.4",
      planRunId: null,
      prompt: `[PROACTIVO · ${department.name}] Worker ${workerIndex + 1}: ${department.mission}`,
      error: null,
      createdAt: new Date(Date.parse(now) - (sequence + 10) * 1_000).toISOString(),
      startedAt: new Date(Date.parse(now) - (sequence + 9) * 1_000).toISOString(),
      finishedAt: active ? null : new Date(Date.parse(now) - sequence * 1_000).toISOString(),
      updatedAt: new Date(Date.parse(now) - sequence * 1_000).toISOString(),
    }
  })
})

expect(runs).toHaveLength(SCALE_WORKERS - 1)

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function mockScaleOffice(page: Page) {
  await page.addInitScript(({ activeProject, currentUser, timestamp }) => {
    const session = {
      id: "scale-ceo-session",
      workspaceId: activeProject.id,
      title: "CEO Office",
      turns: [{
        id: "scale-ceo-turn",
        role: "assistant",
        content: "Coordinando la compañía completa.",
      }],
      createdAt: Date.parse(timestamp),
      updatedAt: Date.parse(timestamp),
      agent: {
        phase: "generating",
        intakeStep: 0,
        context: { goal: "Coordinar la compañía completa" },
      },
    }

    localStorage.setItem("auth-token", "office-scale-token")
    localStorage.setItem("siragpt:office-sound-enabled", "off")
    localStorage.setItem("code-workspace:active-folder", JSON.stringify(activeProject))
    localStorage.setItem(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions: [session],
        activeByWorkspace: { [activeProject.id]: session.id },
      }),
    )
    localStorage.setItem(
      "code-workspace:codex-registry",
      JSON.stringify([{
        id: activeProject.id,
        name: activeProject.name,
        kind: "project",
        updatedAt: Date.parse(timestamp),
      }]),
    )
    localStorage.setItem("siragpt:codex-project:scale-ceo-session", "codex-office-scale-196")
    localStorage.setItem("office-scale:user", JSON.stringify(currentUser))

    ;(window as typeof window & { __officeWebglContextLostCount?: number })
      .__officeWebglContextLostCount = 0
    document.addEventListener("webglcontextlost", () => {
      const trackedWindow = window as typeof window & { __officeWebglContextLostCount?: number }
      trackedWindow.__officeWebglContextLostCount = (
        trackedWindow.__officeWebglContextLostCount || 0
      ) + 1
    }, true)
  }, {
    activeProject: project,
    currentUser: user,
    timestamp: now,
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
          id: "office-scale-association",
          source: "manual",
          organizationId: null,
          linkedAt: now,
          updatedAt: now,
          codexProject: {
            id: "codex-office-scale-196",
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
      return fulfillJson(route, {
        state: {
          // Keep automatic department-chat warming off. The 196 workers under
          // test come from the fixture's one CEO session + 195 durable runs.
          enabled: false,
          enabledAt: null,
          dayKey: "2026-08-10",
          runsToday: runs.length,
          deptIndex: 0,
          lastCycleAt: now,
          lastError: null,
          costTodayUsd: 1.96,
          dailyBudgetUsd: 25,
          budgetBlocked: false,
        },
        departments: AGENT_COMPANY_DEPARTMENTS.map((department) => ({
          ...department,
          custom: false,
          enabled: true,
        })),
        departmentPools,
        capacity: {
          departments: AGENT_COMPANY_DEPARTMENTS.length,
          logicalAgents: SCALE_WORKERS,
          departmentPools: departmentPools.length,
          physicalAgents: SCALE_WORKERS,
          writerConcurrency: 16,
          dailyBudgetUsd: 25,
          strategy: "isolated_worktrees_serialized_merge",
        },
      })
    }
    if (/^\/codex\/projects\/[^/]+\/company-resources$/.test(path)) {
      return fulfillJson(route, { resources: { assignments: {}, pinned: [], revision: 0 } })
    }
    if (/^\/codex\/projects\/[^/]+\/runs$/.test(path) && request.method() === "GET") {
      return fulfillJson(route, { runs })
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
      return fulfillJson(route, {
        projects: [{ id: "codex-office-scale-196", name: "SiraGPT", status: "ready" }],
      })
    }
    if (path === "/chats") {
      return fulfillJson(route, {
        chats: [],
        pagination: { page: 1, limit: 20, total: 0, pages: 0 },
      })
    }

    return fulfillJson(route, {})
  })
}

test("renders 196 real workers within the megaoffice performance budget", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await mockScaleOffice(page)
  await page.goto(`/code?folder=${project.id}`, { waitUntil: "domcontentloaded" })

  const entry = page.getByTestId("agent-company-live-preview")
  await expect(entry).toBeVisible({ timeout: 30_000 })

  const readyStartedAt = await page.evaluate(() => performance.now())
  await entry.click()

  const dialog = page.getByRole("dialog")
  const scene = page.getByTestId("agent-office-scene")
  const canvas = scene.locator("canvas")
  await expect(dialog).toBeVisible()
  await expect(scene).toHaveAttribute("data-office-ready", "true", {
    timeout: OFFICE_READY_BUDGET_MS,
  })
  const officeReadyMs = await page.evaluate(
    (startedAt) => performance.now() - startedAt,
    readyStartedAt,
  )

  await expect(dialog).toHaveAttribute("data-interactive-worker-count", String(SCALE_WORKERS))
  await expect(scene).toHaveAttribute("data-office-interactive-worker-count", String(SCALE_WORKERS))
  await expect(canvas).toHaveAttribute("data-office-interactive-worker-count", String(SCALE_WORKERS))
  await expect(canvas).toHaveAttribute("data-office-rendered-interactive-worker-count", String(SCALE_WORKERS))
  await expect(canvas).toHaveAttribute("data-office-standby-agent-count", "0")
  await expect(canvas).toHaveAttribute("data-office-rendered-standby-agent-count", "0")
  await expect(canvas).toHaveAttribute("data-worker-count", String(SCALE_WORKERS), { timeout: 10_000 })

  await expect.poll(
    async () => Number(await canvas.getAttribute("data-office-draw-calls")),
    { timeout: 10_000 },
  ).toBeGreaterThan(0)
  await expect.poll(
    async () => Number(await canvas.getAttribute("data-office-triangles")),
    { timeout: 10_000 },
  ).toBeGreaterThan(0)

  const drawCalls = Number(await canvas.getAttribute("data-office-draw-calls"))
  const triangles = Number(await canvas.getAttribute("data-office-triangles"))
  const frameCount = Number(await canvas.getAttribute("data-frame-count"))
  const metrics = {
    workers: SCALE_WORKERS,
    standbyWorkers: 0,
    officeReadyMs: Math.round(officeReadyMs),
    drawCalls,
    triangles,
    frameCount,
    budgets: {
      officeReadyMs: OFFICE_READY_BUDGET_MS,
      drawCalls: DRAW_CALL_BUDGET,
      triangles: TRIANGLE_BUDGET,
    },
  }

  await expect(canvas).toHaveAttribute("data-compact-worker-x", /^\d+$/, { timeout: 10_000 })
  await expect(canvas).toHaveAttribute("data-compact-worker-y", /^\d+$/, { timeout: 10_000 })
  const compactWorkerX = Number(await canvas.getAttribute("data-compact-worker-x"))
  const compactWorkerY = Number(await canvas.getAttribute("data-compact-worker-y"))
  const compactWorkerName = await canvas.getAttribute("data-compact-worker-name")
  expect(compactWorkerName).toBeTruthy()
  await canvas.click({ position: { x: compactWorkerX, y: compactWorkerY } })
  const roster = dialog.getByTestId("agent-office-roster")
  await expect(roster).toBeVisible()
  await expect(roster.getByText(compactWorkerName!, { exact: true })).toBeVisible()
  await roster.getByRole("button", { name: "Cerrar panel" }).click()
  await expect(roster).toBeHidden()

  const pause = dialog.getByRole("button", { name: "Pausar oficina" })
  await pause.click()
  await expect(scene).toHaveAttribute("data-office-paused", "true")
  await expect(dialog.getByRole("button", { name: "Reanudar oficina" })).toBeVisible()
  await page.waitForTimeout(300)

  const frameBeforeZoom = Number(await canvas.getAttribute("data-frame-count"))
  const canvasBeforeZoom = await canvas.screenshot({ animations: "disabled" })
  await dialog.getByRole("button", { name: "Acercar cámara" }).click()
  await expect.poll(
    async () => Number(await canvas.getAttribute("data-frame-count")),
    { timeout: 5_000 },
  ).toBeGreaterThan(frameBeforeZoom)
  const canvasAfterZoom = await canvas.screenshot({ animations: "disabled" })
  expect(canvasAfterZoom.equals(canvasBeforeZoom)).toBe(false)

  const frameBeforeReset = Number(await canvas.getAttribute("data-frame-count"))
  await dialog.getByRole("button", { name: "Restablecer cámara" }).click()
  await expect.poll(
    async () => Number(await canvas.getAttribute("data-frame-count")),
    { timeout: 5_000 },
  ).toBeGreaterThan(frameBeforeReset)

  const webglContextLostCount = await page.evaluate(() => (
    (window as typeof window & { __officeWebglContextLostCount?: number })
      .__officeWebglContextLostCount || 0
  ))
  expect(webglContextLostCount).toBe(0)

  console.info(`[megaoffice-scale] ${JSON.stringify({
    ...metrics,
    cameraZoomChanged: !canvasAfterZoom.equals(canvasBeforeZoom),
    webglContextLostCount,
  })}`)

  expect(officeReadyMs).toBeLessThanOrEqual(OFFICE_READY_BUDGET_MS)
  expect(drawCalls).toBeGreaterThan(0)
  expect(drawCalls).toBeLessThanOrEqual(DRAW_CALL_BUDGET)
  expect(triangles).toBeGreaterThan(0)
  expect(triangles).toBeLessThanOrEqual(TRIANGLE_BUDGET)
})
