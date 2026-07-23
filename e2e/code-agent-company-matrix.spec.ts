import { expect, test, type Page, type Route } from "@playwright/test"

test.describe.configure({ timeout: 120_000 })

const now = "2026-07-23T16:00:00.000Z"
const project = {
  id: "matrix-qa",
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
  id: "matrix-qa-user",
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
    id: "run-trust",
    projectId: "codex-matrix-qa",
    mode: "build",
    status: "running",
    tier: "pro",
    model: "gpt-5.4",
    planRunId: null,
    prompt: "[PROACTIVO · Confianza, Privacidad y Cumplimiento] Verificar el aislamiento del workspace",
    error: null,
    createdAt: "2026-07-23T15:58:00.000Z",
    startedAt: "2026-07-23T15:58:04.000Z",
    finishedAt: null,
  },
  {
    id: "run-product",
    projectId: "codex-matrix-qa",
    mode: "build",
    status: "done",
    tier: "pro",
    model: "gpt-5.4",
    planRunId: null,
    prompt: "[PROACTIVO · Producto e Ingeniería SiraGPT] Validar la experiencia de APPS y entregar evidencia",
    error: null,
    createdAt: "2026-07-23T15:40:00.000Z",
    startedAt: "2026-07-23T15:40:03.000Z",
    finishedAt: "2026-07-23T15:45:00.000Z",
  },
]

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function mockMatrixCompany(page: Page) {
  await page.addInitScript(({ activeProject, currentUser, timestamp }) => {
    const ceoSession = {
      id: "ceo-qa",
      workspaceId: "matrix-qa",
      title: "CEO Office",
      turns: [],
      createdAt: Date.parse(timestamp),
      updatedAt: Date.parse(timestamp),
      agent: { phase: "idle", intakeStep: 0, context: { goal: "" } },
    }
    const productSession = {
      ...ceoSession,
      id: "product-qa",
      title: "Producto e Ingeniería SiraGPT",
      turns: [{ id: "a-2", role: "assistant", content: "Validando la experiencia de APPS." }],
      createdAt: Date.parse(timestamp) + 1,
      updatedAt: Date.parse(timestamp) + 1,
    }

    localStorage.setItem("auth-token", "matrix-qa-token")
    localStorage.setItem("code-workspace:active-folder", JSON.stringify(activeProject))
    localStorage.setItem(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions: [ceoSession, productSession],
        activeByWorkspace: { "matrix-qa": "ceo-qa" },
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
    localStorage.setItem("matrix-qa:user", JSON.stringify(currentUser))
  }, { activeProject: project, currentUser: user, timestamp: now })

  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/projects" && request.method() === "GET") return fulfillJson(route, { projects: [project] })
    if (path === "/projects/matrix-qa") return fulfillJson(route, { project })
    if (path === "/codex/health") {
      return fulfillJson(route, { ok: true, enabled: true, previewOrigin: "https://preview.example.test" })
    }
    if (path === "/codex/access") {
      return fulfillJson(route, { ok: true, enabled: true, canRun: true, allowlistConfigured: true })
    }
    if (path === "/codex/projects/codex-matrix-qa/proactive") {
      return fulfillJson(route, {
        state: {
          enabled: false,
          enabledAt: null,
          dayKey: "2026-07-23",
          runsToday: 7,
          deptIndex: 4,
          lastCycleAt: "2026-07-23T15:58:00.000Z",
          lastError: null,
        },
        departments: [],
      })
    }
    if (path === "/codex/projects/codex-matrix-qa/runs") return fulfillJson(route, { runs })
    if (path === "/codex/projects/codex-matrix-qa/checkpoints") {
      return fulfillJson(route, { checkpoints: [{ id: "checkpoint-1" }, { id: "checkpoint-2" }] })
    }
    if (path === "/ai/models") {
      return fulfillJson(route, {
        models: [{
          id: "matrix-model",
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
    if (path === "/codex/projects") {
      return fulfillJson(route, { projects: [{ id: "codex-matrix-qa", name: "SiraGPT", status: "ready" }] })
    }
    if (path === "/chats") {
      return fulfillJson(route, { chats: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } })
    }

    return fulfillJson(route, {})
  })
}

test("desktop company panel shows real Matrix-style operations", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1425, height: 810 })
  await mockMatrixCompany(page)
  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })

  await expect(page.getByRole("tab", { name: "Empresas</>" })).toBeVisible()
  await expect(page.getByTestId("agent-company-switcher")).toContainText("SiraGPT.COM")
  await expect(page.getByTestId("agent-company-live-preview")).toBeVisible()
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible()
  await expect(page.getByRole("button", { name: "Controlar" })).toContainText("1")

  const companyRail = page.locator("[data-agent-company-dock='apps']")
  await expect(companyRail).toBeVisible()
  await expect(page.getByText("¿Qué quieres construir?", { exact: true })).toBeVisible()
  expect(await companyRail.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("matrix-company-three-pane.png"), fullPage: true })

  await page.evaluate(() => {
    localStorage.setItem("siragpt:codex-project:ceo-qa", "codex-matrix-qa")
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("agent-company-department-trust")).toContainText("Verificar el aislamiento")
  await expect(page.getByRole("button", { name: "Controlar" })).toContainText("2")
  await page.getByRole("button", { name: "Controlar" }).click()
  await expect(page.getByTestId("agent-company-operating-loop")).toBeVisible()
  await expect(page.getByTestId("agent-company-worker-list")).toContainText("Confianza, Privacidad y Cumplimiento")
  await expect(page.getByTestId("agent-company-worker-list")).toContainText("Producto e Ingeniería SiraGPT")

  expect(await companyRail.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("matrix-company-desktop.png"), fullPage: true })
})

test("mobile company panel remains a single usable vertical surface", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMatrixCompany(page)
  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })

  await expect(page.getByTestId("agent-company-switcher")).toContainText("SiraGPT.COM")
  await expect(page.getByRole("button", { name: "Empresa", pressed: true })).toBeVisible()
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible()

  const panel = page.locator("[data-agent-company-dock='workspace']")
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("matrix-company-mobile.png"), fullPage: true })
})
