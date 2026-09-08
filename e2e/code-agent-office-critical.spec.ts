import { expect, test, type Page, type Route } from "@playwright/test"

import { AGENT_COMPANY_DEPARTMENTS } from "../lib/code-agent-company"

test.describe.configure({ timeout: 120_000 })

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

const runs = [
  {
    id: "office-run-trust",
    projectId: "codex-office-critical",
    mode: "build",
    status: "running",
    tier: "pro",
    model: "gpt-5.4",
    planRunId: null,
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
  await page.addInitScript(({ activeProject, currentUser, timestamp }) => {
    const baseSession = {
      workspaceId: activeProject.id,
      turns: [],
      createdAt: Date.parse(timestamp),
      updatedAt: Date.parse(timestamp),
      agent: { phase: "idle", intakeStep: 0, context: { goal: "" } },
    }
    const sessions = [
      { ...baseSession, id: "office-ceo", title: "CEO Office" },
      {
        ...baseSession,
        id: "office-product",
        title: "Producto e Ingeniería",
        createdAt: Date.parse(timestamp) + 1,
        updatedAt: Date.parse(timestamp) + 1,
        turns: [{ id: "office-turn-product", role: "assistant", content: "Verificando la oficina." }],
      },
      {
        ...baseSession,
        id: "office-sales",
        title: "Ventas",
        createdAt: Date.parse(timestamp) + 2,
        updatedAt: Date.parse(timestamp) + 2,
      },
    ]

    localStorage.setItem("auth-token", "office-critical-token")
    localStorage.setItem("siragpt:office-sound-enabled", "off")
    localStorage.setItem("code-workspace:active-folder", JSON.stringify(activeProject))
    localStorage.setItem(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions,
        activeByWorkspace: { [activeProject.id]: "office-ceo" },
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
    localStorage.setItem("siragpt:codex-project:office-ceo", "codex-office-critical")
    localStorage.setItem("office-critical:user", JSON.stringify(currentUser))
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
        },
        departments: [],
        departmentPools: [],
        capacity: {
          departments: AGENT_COMPANY_DEPARTMENTS.length,
          logicalAgents: 196,
          departmentPools: 0,
          physicalAgents: 16,
          writerConcurrency: 4,
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
      return fulfillJson(route, { projects: [{ id: "codex-office-critical", name: "SiraGPT", status: "ready" }] })
    }
    if (path === "/chats") {
      return fulfillJson(route, { chats: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } })
    }

    return fulfillJson(route, {})
  })
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
  await expect(scene).toHaveAttribute("data-office-ready", "true", { timeout: 15_000 })
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute("aria-label", /\S+/)

  return { dialog, scene, canvas }
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`${viewport.name} opens an accessible office and exposes every department`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    const { dialog } = await openOffice(page, viewport)
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

    await page.screenshot({
      path: `docs/audits/agent-megaoffice-${viewport.name}.png`,
      animations: "disabled",
      caret: "hide",
    })

    const officeNavigation = viewport.name === "desktop"
      ? dialog.getByRole("navigation", { name: "Navegación de la oficina" })
      : dialog.getByRole("navigation", { name: "Navegación móvil de la oficina" })
    await officeNavigation.getByRole("button", { name: "Panel" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId("company-dashboard-surface")).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/code\\?folder=${project.id}`))
  })
}

test("reduced motion keeps the canvas stable without disabling office navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const { dialog, canvas } = await openOffice(page, { width: 1440, height: 900 })

  expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)
  await expect(canvas).toHaveAttribute("data-frame-count", /^\d+$/)
  await page.waitForTimeout(250)
  const firstFrameCount = await canvas.getAttribute("data-frame-count")
  expect(Number(firstFrameCount)).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  await expect(canvas).toHaveAttribute("data-frame-count", firstFrameCount!)

  const departmentSelect = dialog.getByRole("combobox")
  await departmentSelect.selectOption("trust")
  await expect(departmentSelect).toHaveValue("trust")

  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})
