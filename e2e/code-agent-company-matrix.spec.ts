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

async function mockMatrixCompany(
  page: Page,
  {
    linkedProject = true,
    malformedCodexLists = false,
  }: { linkedProject?: boolean; malformedCodexLists?: boolean } = {},
) {
  const operations = {
    projectCreates: 0,
    projectUpdates: [] as Array<Record<string, unknown>>,
    projectDeletes: 0,
    proactiveToggles: 0,
    socialPolicyUpdates: 0,
    activityReports: 0,
  }
  let currentProject = { ...project }
  let projectDeleted = false
  let proactiveEnabled = false
  let companyAssociated = linkedProject
  let associatedCodexProjectId = linkedProject ? "codex-matrix-qa" : null
  const missionLedger: any = {
    version: 1,
    summary: {
      missions: 1,
      completed: 1,
      blocked: 0,
      pendingReview: 1,
      approved: 0,
      reports: 0,
      emailQueued: 0,
    },
    records: [{
      id: "run:run-product",
      missionId: "code-excellence",
      missionTitle: "Validar la experiencia de APPS y entregar evidencia",
      objective: "Demostrar que Archivos conserva evidencia verificable.",
      department: "Producto e Ingeniería SiraGPT",
      status: "completed",
      summary: "La experiencia quedó verificada con pruebas de interfaz.",
      author: "Producto e Ingeniería SiraGPT · SiraGPT Agent",
      runId: "run-product",
      source: "run_completion",
      sourceRef: "run:run-product",
      version: 1,
      contentHash: "a".repeat(64),
      createdAt: "2026-07-23T15:45:00.000Z",
      updatedAt: "2026-07-23T15:45:00.000Z",
      deliverables: [{
        id: "checkpoint:abc123",
        name: "Checkpoint Git verificado",
        type: "checkpoint",
        ref: "abc123",
        status: "verified",
      }],
      evidence: [{
        id: "playwright",
        label: "Playwright",
        detail: "La interfaz real de /code pasó la prueba.",
        kind: "verification",
        passed: true,
      }],
      ceoReview: {
        status: "pending",
        reviewedAt: null,
        reviewedBy: null,
        note: null,
      },
    }],
    reports: [] as Array<Record<string, unknown>>,
  }
  await page.addInitScript(({ activeProject, currentUser, timestamp, shouldLinkProject }) => {
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
    if (shouldLinkProject) {
      localStorage.setItem("siragpt:codex-project:ceo-qa", "codex-matrix-qa")
    }
    localStorage.setItem("matrix-qa:user", JSON.stringify(currentUser))
  }, { activeProject: project, currentUser: user, timestamp: now, shouldLinkProject: linkedProject })

  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/projects" && request.method() === "GET") {
      return fulfillJson(route, { projects: projectDeleted ? [] : [currentProject] })
    }
    if (path === "/projects/matrix-qa" && request.method() === "GET") {
      return fulfillJson(route, { project: currentProject })
    }
    if (path === "/projects/matrix-qa" && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>
      operations.projectUpdates.push(body)
      currentProject = { ...currentProject, ...body, updatedAt: now }
      return fulfillJson(route, { project: currentProject })
    }
    if (path === "/projects/matrix-qa" && request.method() === "DELETE") {
      operations.projectDeletes += 1
      projectDeleted = true
      return fulfillJson(route, { deleted: true })
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
        association: companyAssociated && associatedCodexProjectId ? {
          id: "company-link-matrix-qa",
          source: "manual",
          organizationId: null,
          linkedAt: now,
          updatedAt: now,
          codexProject: {
            id: associatedCodexProjectId,
            name: "SiraGPT",
            organizationId: null,
            status: "ready",
            updatedAt: now,
          },
          connectors: [],
        } : null,
        candidates: companyAssociated ? [{
          id: "codex-matrix-qa",
          name: "SiraGPT",
          organizationId: null,
          status: "ready",
          updatedAt: now,
        }] : [],
        connectors: [],
        requiresAssociation: !companyAssociated,
      })
    }
    if (path === "/codex/company-associations" && request.method() === "POST") {
      const body = request.postDataJSON()
      companyAssociated = true
      associatedCodexProjectId = String(body.codexProjectId || "codex-matrix-qa")
      return fulfillJson(route, {
        association: {
          id: "company-link-matrix-qa",
          source: body.source === "created_for_company" ? "created_for_company" : "manual",
          organizationId: null,
          linkedAt: now,
          updatedAt: now,
          codexProject: {
            id: associatedCodexProjectId,
            name: "SiraGPT",
            organizationId: null,
            status: "ready",
            updatedAt: now,
          },
          connectors: [],
        },
      }, 201)
    }
    if (/^\/codex\/projects\/[^/]+\/proactive$/.test(path)) {
      if (request.method() === "POST") {
        proactiveEnabled = true
        operations.proactiveToggles += 1
      } else if (request.method() === "DELETE") {
        proactiveEnabled = false
      }
      return fulfillJson(route, {
        state: {
          enabled: proactiveEnabled,
          enabledAt: proactiveEnabled ? now : null,
          dayKey: "2026-07-23",
          runsToday: 7,
          deptIndex: 4,
          lastCycleAt: "2026-07-23T15:58:00.000Z",
          lastError: null,
        },
        departments: [],
      })
    }
    if (/^\/codex\/projects\/[^/]+\/runs$/.test(path) && request.method() === "GET") {
      if (malformedCodexLists) return fulfillJson(route, {})
      return fulfillJson(route, { runs })
    }
    if (/^\/codex\/projects\/[^/]+\/checkpoints$/.test(path)) {
      if (malformedCodexLists) return fulfillJson(route, { checkpoints: null })
      return fulfillJson(route, { checkpoints: [{ id: "checkpoint-1" }, { id: "checkpoint-2" }] })
    }
    if (/^\/codex\/projects\/[^/]+\/mission-evidence$/.test(path) && request.method() === "GET") {
      return fulfillJson(route, { ledger: missionLedger })
    }
    if (/^\/codex\/projects\/[^/]+\/mission-evidence\/[^/]+\/review$/.test(path) && request.method() === "PATCH") {
      const body = request.postDataJSON() as { status?: "pending" | "approved" | "changes_requested" | "rejected" }
      missionLedger.records[0].ceoReview = {
        status: body.status || "pending",
        reviewedAt: now,
        reviewedBy: "Valeria Castro",
        note: null,
      }
      missionLedger.summary.pendingReview = body.status === "pending" ? 1 : 0
      missionLedger.summary.approved = body.status === "approved" ? 1 : 0
      return fulfillJson(route, { record: missionLedger.records[0] })
    }
    if (/^\/codex\/projects\/[^/]+\/activity-reports$/.test(path) && request.method() === "POST") {
      operations.activityReports += 1
      const body = request.postDataJSON() as { requestEmail?: boolean; confirmEmailQueue?: boolean }
      const queued = body.requestEmail === true && body.confirmEmailQueue === true
      const report = {
        id: `activity:${operations.activityReports}`,
        title: "Resumen de actividad · 2026-07-23",
        summary: "1 misión registrada.",
        author: "CEO Office",
        source: "mission_evidence",
        sourceRef: `activity:${operations.activityReports}`,
        version: 1,
        contentHash: "b".repeat(64),
        createdAt: now,
        period: { from: "2026-07-16T16:00:00.000Z", to: now },
        counts: { missions: 1, completed: 1, blocked: 0, pendingReview: 0, approved: 1 },
        status: queued ? "queued" : "draft",
        delivery: {
          channel: "email",
          status: queued ? "queued" : "not_requested",
          connectionReady: queued,
          permissionGranted: queued,
          permissionMode: "review",
          queuedAt: queued ? now : null,
          sentAt: null,
          reason: queued ? "En cola; no enviado." : "Borrador.",
        },
      }
      missionLedger.reports.unshift(report)
      missionLedger.summary.reports = missionLedger.reports.length
      missionLedger.summary.emailQueued = missionLedger.reports.filter((item: any) => (
        (item.delivery as { status?: string })?.status === "queued"
      )).length
      return fulfillJson(route, { report }, 201)
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
    if (path === "/users/me/notifications") {
      return fulfillJson(route, { items: [], total: 0, unreadCount: 0 })
    }
    if (path === "/cowork/approvals") {
      return fulfillJson(route, { approvals: [] })
    }
    if (path === "/social-posts/operations" && request.method() === "GET") {
      return fulfillJson(route, {
        policy: {
          enabled: false,
          mode: "review",
          autopilot: false,
          objective: "Publicar avances del producto con evidencia verificable.",
          dailyLimit: 3,
          platforms: { facebook: true, linkedin: true, x: true },
          workspaceId: "matrix-qa",
          updatedAt: now,
        },
        providers: [
          {
            platform: "facebook",
            label: "Facebook",
            configured: true,
            scopes: ["pages_manage_posts"],
            supports: { text: true, remoteImage: true, generatedImage: true },
            connection: {
              id: "social-facebook",
              platform: "facebook",
              accountId: "page-qa",
              accountName: "SiraGPT",
              profile: { status: "active", kind: "page" },
              scopes: ["pages_manage_posts"],
              expiresAt: null,
              updatedAt: now,
              connected: true,
            },
          },
          ...(["linkedin", "x"] as const).map((platform) => ({
            platform,
            label: platform === "linkedin" ? "LinkedIn" : "X",
            configured: true,
            scopes: [],
            supports: { text: true, remoteImage: true, generatedImage: true },
            connection: null,
          })),
        ],
        metrics: { queued: 2, publishedToday: 1 },
      })
    }
    if ((path === "/social-posts" || path === "/social-posts/") && request.method() === "GET") {
      return fulfillJson(route, { posts: [] })
    }
    if (path === "/social-posts/operations/policy" && request.method() === "PATCH") {
      operations.socialPolicyUpdates += 1
      const body = request.postDataJSON()
      return fulfillJson(route, {
        policy: {
          enabled: Boolean(body.enabled),
          mode: body.mode === "auto" ? "auto" : "review",
          autopilot: Boolean(body.autopilot),
          objective: String(body.objective || ""),
          dailyLimit: Number(body.dailyLimit || 1),
          platforms: body.platforms || { facebook: true, linkedin: true, x: true },
          workspaceId: body.workspaceId || "matrix-qa",
          updatedAt: now,
        },
      })
    }
    if (path === "/codex/projects" && request.method() === "POST") {
      operations.projectCreates += 1
      return fulfillJson(route, {
        project: {
          id: "codex-matrix-runtime",
          name: "SiraGPT.COM · Empresa",
          status: "ready",
          workspacePath: "projects/codex-matrix-runtime",
          previewUrl: null,
          error: null,
        },
      }, 201)
    }
    if (path === "/codex/projects/codex-matrix-runtime") {
      return fulfillJson(route, {
        project: {
          id: "codex-matrix-runtime",
          name: "SiraGPT.COM · Empresa",
          status: "ready",
          workspacePath: "projects/codex-matrix-runtime",
          previewUrl: null,
          error: null,
        },
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

  return operations
}

test("empty Codex list payloads cannot crash the company panel", async ({ page }) => {
  await page.setViewportSize({ width: 1425, height: 810 })
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await mockMatrixCompany(page, { malformedCodexLists: true })

  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Cambiar empresa de agentes" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Cambiar empresa de agentes" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible()
  expect(pageErrors).toEqual([])
})

test("company switcher can pin, rename and soft-delete an enterprise", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1425, height: 810 })
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  const operations = await mockMatrixCompany(page)

  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })
  const switcher = page.getByTestId("agent-company-switcher")
  await expect(switcher).toBeVisible({ timeout: 30_000 })

  await switcher.click()
  const companyRow = page.getByTestId("agent-company-row-matrix-qa")
  await expect(companyRow).toBeVisible()
  await page.getByTestId("agent-company-actions-matrix-qa").click()
  await page.getByRole("menuitem", { name: "Fijar empresa" }).click()
  await expect.poll(() => operations.projectUpdates.length).toBe(1)
  expect(operations.projectUpdates[0]).toEqual({ isStarred: true })

  await switcher.click()
  await expect(page.getByTestId("agent-company-pinned-matrix-qa")).toBeVisible()
  await page.getByTestId("agent-company-actions-matrix-qa").click()
  await page.getByRole("menuitem", { name: "Editar nombre" }).click()
  const editDialog = page.getByTestId("agent-company-edit-dialog")
  await expect(editDialog).toBeVisible()
  await editDialog.getByLabel("Nombre de la empresa").fill("Acme Operaciones")
  await editDialog.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(editDialog).toBeHidden()
  await expect.poll(() => operations.projectUpdates.length).toBe(2)
  expect(operations.projectUpdates[1]).toEqual({ name: "Acme Operaciones" })
  await expect(switcher).toContainText("Acme Operaciones")

  await switcher.click()
  await page.getByTestId("agent-company-actions-matrix-qa").click()
  await page.getByRole("menuitem", { name: "Eliminar empresa" }).click()
  const deleteDialog = page.getByTestId("agent-company-delete-dialog")
  await expect(deleteDialog).toContainText("Podrás restaurarla durante 30 días")
  await deleteDialog.getByRole("button", { name: "Eliminar empresa" }).click()
  await expect.poll(() => operations.projectDeletes).toBe(1)
  await expect(deleteDialog).toBeHidden()
  await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none")
  await expect(page).not.toHaveURL(/[?&]folder=/)

  await switcher.click()
  await expect(page.getByTestId("agent-company-menu")).toContainText("Sin empresas.")
  await page.screenshot({ path: testInfo.outputPath("company-actions-complete.png"), fullPage: true })
  const unexpectedPageErrors = pageErrors.filter(
    (message) => !message.includes(
      "The document is sandboxed and lacks the 'allow-same-origin' flag",
    ),
  )
  expect(unexpectedPageErrors).toEqual([])
})

test("mission evidence, CEO review and report survive a reload", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1425, height: 810 })
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  const operations = await mockMatrixCompany(page)

  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Archivos" })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Archivos" }).click()
  const record = page.getByTestId("company-mission-evidence-record")
  await expect(record).toContainText("Pendiente de CEO")
  await record.getByRole("button", { name: /Validar la experiencia de APPS y entregar evidencia/ }).click()
  await expect(record).toContainText("v1 · run_completion")
  await expect(record).toContainText("a".repeat(64))
  await record.getByRole("button", { name: "Aprobar" }).click()
  await expect(record).toContainText("Aprobado por CEO")
  await page.getByRole("button", { name: "Generar reporte" }).click()
  await expect(page.getByText("Resumen de actividad · 2026-07-23", { exact: true })).toBeVisible()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Archivos" })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Archivos" }).click()
  await expect(page.getByTestId("company-mission-evidence-record")).toContainText("Aprobado por CEO")
  await expect(page.getByText("Resumen de actividad · 2026-07-23", { exact: true })).toBeVisible()
  expect(operations.activityReports).toBe(1)
  expect(pageErrors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath("mission-evidence-durable.png"), fullPage: true })
})

test("modern office city renders a moving day and night environment", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1425, height: 810 })
  await mockMatrixCompany(page)
  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })

  const livePreview = page.getByTestId("agent-company-live-preview")
  await expect(livePreview).toBeVisible({ timeout: 30_000 })
  await livePreview.click()

  const overlay = page.getByTestId("agent-office-overlay")
  const scene = page.getByTestId("agent-office-scene")
  const canvas = scene.locator("canvas")
  await expect(overlay).toBeVisible()
  await expect(scene).toHaveAttribute("data-office-ready", "true")
  await expect.poll(async () => Number(await canvas.getAttribute("data-city-building-count"))).toBeGreaterThanOrEqual(25)
  await expect.poll(async () => Number(await canvas.getAttribute("data-city-signature-tower-count"))).toBeGreaterThanOrEqual(3)
  await expect.poll(async () => Number(await canvas.getAttribute("data-city-light-count"))).toBeGreaterThanOrEqual(14)

  const firstFrame = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL("image/png"))
  expect(firstFrame.length).toBeGreaterThan(10_000)
  await page.waitForTimeout(750)
  const secondFrame = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL("image/png"))
  expect(secondFrame).not.toBe(firstFrame)

  const timeToggle = page.getByTestId("agent-office-time-toggle")
  await timeToggle.click()
  await expect(overlay).toHaveAttribute("data-office-phase", "day")
  await page.screenshot({ path: testInfo.outputPath("modern-office-city-day.png"), fullPage: true })
  await timeToggle.click()
  await expect(overlay).toHaveAttribute("data-office-phase", "dusk")
  await timeToggle.click()
  await expect(overlay).toHaveAttribute("data-office-phase", "night")
  await expect(scene).toHaveAttribute("data-office-ready", "true")
  await page.screenshot({ path: testInfo.outputPath("modern-office-city-night.png"), fullPage: true })

  expect(await overlay.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
})

test("desktop company panel shows real Matrix-style operations", async ({ page }, testInfo) => {
  test.setTimeout(360_000)
  await page.setViewportSize({ width: 1425, height: 810 })
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  const operations = await mockMatrixCompany(page)
  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })

  await expect(page.getByRole("tab", { name: "Empresas</>" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Cambiar empresa de agentes" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("agent-company-live-preview")).toBeVisible()
  const officeThumbnail = page.getByTestId("agent-office-thumbnail")
  await expect(officeThumbnail).toHaveAttribute("data-office-ready", "true")
  await expect(officeThumbnail).toHaveAttribute("data-office-paused", "false")
  await expect(officeThumbnail).toHaveAttribute("data-rooftop-office", "true")
  await expect.poll(async () => Number(await officeThumbnail.locator("canvas").getAttribute("data-city-building-count"))).toBeGreaterThanOrEqual(12)
  await expect(page.getByTestId("agent-company-live-preview")).toContainText("Oficina · 1/1 puestos")
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible()
  await expect(page.getByRole("button", { name: "Controlar" })).toContainText(/[1-9]/)

  const companyRail = page.locator("[data-agent-company-dock='apps']")
  await expect(companyRail).toBeVisible()
  await expect(page.getByText("¿Qué quieres construir?", { exact: true })).toBeVisible()
  expect(await companyRail.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("matrix-company-three-pane.png"), fullPage: true })

  await page.getByTestId("agent-company-live-preview").click()
  await expect(page.getByTestId("agent-office-overlay")).toBeVisible()
  await expect(page.getByTestId("agent-office-overlay")).toContainText("Oficina operativa · pools reales")
  await expect(officeThumbnail).toHaveAttribute("data-office-paused", "true")
  await page.waitForTimeout(100)
  const pausedThumbnailFrame = Number(await officeThumbnail.locator("canvas").getAttribute("data-frame-count"))
  await page.waitForTimeout(250)
  expect(
    Number(await officeThumbnail.locator("canvas").getAttribute("data-frame-count")) - pausedThumbnailFrame,
  ).toBeLessThanOrEqual(1)
  const officeScene = page.getByTestId("agent-office-scene")
  const officeCanvas = officeScene.locator("canvas")
  await expect(officeScene).toHaveAttribute("data-office-ready", "true")
  await expect.poll(async () => Number(await officeCanvas.getAttribute("data-worker-count"))).toBe(3)
  await expect(officeScene).toHaveAttribute("data-rooftop-office", "true")
  await expect.poll(async () => Number(await officeCanvas.getAttribute("data-city-building-count"))).toBeGreaterThanOrEqual(25)
  await expect.poll(async () => Number(await officeCanvas.getAttribute("data-city-signature-tower-count"))).toBeGreaterThanOrEqual(3)
  await expect.poll(async () => Number(await officeCanvas.getAttribute("data-city-window-count"))).toBeGreaterThanOrEqual(1_500)
  await expect.poll(async () => Number(await officeCanvas.getAttribute("data-city-mover-count"))).toBeGreaterThanOrEqual(10)
  await expect.poll(async () => Number(await officeCanvas.getAttribute("data-city-light-count"))).toBeGreaterThanOrEqual(14)

  const firstFrame = await officeCanvas.evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl")
    if (!gl) return { dataUrl: "", range: 0, colored: 0 }
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let min = 255
    let max = 0
    let colored = 0
    for (let index = 0; index < pixels.length; index += 64) {
      const luminance = pixels[index] + pixels[index + 1] + pixels[index + 2]
      min = Math.min(min, luminance)
      max = Math.max(max, luminance)
      if (pixels[index + 3] > 0 && luminance > 30) colored += 1
    }
    return { dataUrl: canvas.toDataURL("image/png"), range: max - min, colored }
  })
  expect(firstFrame.dataUrl.length).toBeGreaterThan(10_000)
  expect(firstFrame.range).toBeGreaterThan(100)
  expect(firstFrame.colored).toBeGreaterThan(100)

  const initialWorkerPoint = await officeCanvas.evaluate((canvas) => ({
    x: Number(canvas.dataset.movingWorkerX),
    y: Number(canvas.dataset.movingWorkerY),
  }))
  await page.waitForTimeout(750)
  const secondFrame = await officeCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL("image/png"))
  expect(secondFrame).not.toBe(firstFrame.dataUrl)

  const movedWorkerPoint = await officeCanvas.evaluate((canvas) => ({
    x: Number(canvas.dataset.movingWorkerX),
    y: Number(canvas.dataset.movingWorkerY),
  }))
  expect(
    Math.hypot(
      movedWorkerPoint.x - initialWorkerPoint.x,
      movedWorkerPoint.y - initialWorkerPoint.y,
    ),
  ).toBeGreaterThan(2)

  const timeToggle = page.getByTestId("agent-office-time-toggle")
  await expect(timeToggle).toHaveAttribute(
    "aria-label",
    /Ambiente Auto · (Amanecer|Día|Atardecer|Noche)\. Cambiar ciclo de luz/,
  )
  await timeToggle.click()
  await expect(page.getByTestId("agent-office-overlay")).toHaveAttribute("data-office-phase", "day")
  await page.screenshot({ path: testInfo.outputPath("agent-office-desktop-day.png"), fullPage: true })
  await timeToggle.click()
  await expect(page.getByTestId("agent-office-overlay")).toHaveAttribute("data-office-phase", "dusk")
  await page.screenshot({ path: testInfo.outputPath("agent-office-desktop-dusk.png"), fullPage: true })
  await timeToggle.click()
  await expect(page.getByTestId("agent-office-overlay")).toHaveAttribute("data-office-phase", "night")
  await expect(officeScene).toHaveAttribute("data-office-ready", "true")
  await page.screenshot({ path: testInfo.outputPath("agent-office-desktop-night.png"), fullPage: true })

  const settledWorkerPoint = await officeCanvas.evaluate((canvas) => ({
    x: Number(canvas.dataset.firstWorkerX),
    y: Number(canvas.dataset.firstWorkerY),
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  }))
  expect(Number.isFinite(settledWorkerPoint.x)).toBe(true)
  expect(Number.isFinite(settledWorkerPoint.y)).toBe(true)
  expect(settledWorkerPoint.x).toBeGreaterThan(0)
  expect(settledWorkerPoint.x).toBeLessThan(settledWorkerPoint.width)
  expect(settledWorkerPoint.y).toBeGreaterThan(0)
  expect(settledWorkerPoint.y).toBeLessThan(settledWorkerPoint.height)
  await page.screenshot({ path: testInfo.outputPath("agent-office-desktop-moving.png"), fullPage: true })
  await page.getByRole("button", { name: "Pausar oficina" }).click()
  await expect(page.getByRole("button", { name: "Reanudar oficina" })).toBeVisible()
  await page.waitForTimeout(100)
  const workerPoint = await officeCanvas.evaluate((canvas) => ({
    x: Number(canvas.dataset.firstWorkerX),
    y: Number(canvas.dataset.firstWorkerY),
  }))
  const canvasBox = await officeCanvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  await page.mouse.click(canvasBox!.x + workerPoint.x, canvasBox!.y + workerPoint.y)
  await expect(page.getByTestId("agent-office-roster")).toBeVisible()
  await expect(page.getByTestId("agent-office-roster")).toContainText("Actividad del agente")
  await expect(page.getByTestId("agent-office-roster")).toContainText(/Abrir (sesión|departamento)/)
  await page.waitForTimeout(150)
  expect(await page.getByTestId("agent-office-overlay").evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("agent-office-desktop.png"), fullPage: true })

  await page.getByRole("button", { name: "Cerrar oficina" }).click()
  await expect(page.getByTestId("agent-office-overlay")).toBeHidden()

  await page.getByRole("button", { name: "Controlar" }).click()
  await expect(page.getByTestId("company-control-surface")).toBeVisible()
  await page.getByRole("button", { name: "Cerrar vista de empresa" }).click()
  await expect(page.getByTestId("company-control-surface")).toBeHidden()
  await page.getByRole("button", { name: "Archivos" }).click()
  await expect(page.getByTestId("company-files-surface")).toBeVisible()
  await expect(page.getByTestId("company-mission-evidence-ledger")).toBeVisible()
  await expect(page.getByTestId("company-mission-evidence-record")).toContainText("Pendiente de CEO")
  await page.getByTestId("company-mission-evidence-record")
    .getByRole("button", { name: /Validar la experiencia de APPS y entregar evidencia/ })
    .click()
  await expect(page.getByText("Checkpoint Git verificado", { exact: true })).toBeVisible()
  await expect(page.getByText("La interfaz real de /code pasó la prueba.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Aprobar" }).click()
  await expect(page.getByTestId("company-mission-evidence-record")).toContainText("Aprobado por CEO")
  await page.getByRole("button", { name: "Generar reporte" }).click()
  await expect(page.getByText("Resumen de actividad · 2026-07-23", { exact: true })).toBeVisible()
  expect(operations.activityReports).toBe(1)
  await page.getByRole("button", { name: "Recursos" }).click()
  await expect(page.getByTestId("company-resources-surface")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Activos de la empresa agente" })).toBeVisible()
  await expect(page.getByText("Canales conectados")).toBeVisible()
  await expect(page.getByText("3 compatibles")).toBeVisible()
  await expect(page.getByText("borradores y programadas")).toBeVisible()
  await expect(page.getByText("Facebook", { exact: true })).toBeVisible()
  await expect(page.getByText("LinkedIn", { exact: true })).toBeVisible()
  await expect(page.getByText("X", { exact: true }).last()).toBeVisible()

  expect(await companyRail.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("matrix-company-desktop.png"), fullPage: true })
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) => !(
      message.includes("Encountered two children with the same key")
      && message.includes("customer-success")
    ),
  )
  expect(unexpectedConsoleErrors).toEqual([])
})

test("mobile company panel remains a single usable vertical surface", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMatrixCompany(page)
  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })

  await expect(page.getByRole("button", { name: "Cambiar empresa de agentes" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Empresa", pressed: true })).toBeVisible()
  await expect(page.getByTestId("agent-company-department-ceo-office")).toBeVisible()

  const panel = page.locator("[data-agent-company-dock='workspace']")
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("matrix-company-mobile.png"), fullPage: true })

  await page.getByTestId("agent-company-live-preview").click()
  await expect(page.getByTestId("agent-office-overlay")).toBeVisible()
  await expect(page.getByTestId("agent-office-scene")).toHaveAttribute("data-office-ready", "true")
  const soundToggle = page.getByTestId("agent-office-sound-toggle")
  await expect(soundToggle).toBeVisible()
  await expect(soundToggle).toHaveAttribute(
    "aria-label",
    /^(Activar|Desactivar|Reintentar) sonido de la oficina$/,
  )
  await expect(page.getByRole("button", { name: "Pausar oficina" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Ver agentes" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Cerrar oficina" })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Filtrar por departamento" })).toBeVisible()
  expect(await page.getByTestId("agent-office-overlay").evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("agent-office-mobile.png"), fullPage: true })
})

test("PROACTIVO provisions and confirms a real company runtime before turning on", async ({ page }) => {
  await page.setViewportSize({ width: 1425, height: 810 })
  const operations = await mockMatrixCompany(page, { linkedProject: false })
  await page.goto("/code?folder=matrix-qa", { waitUntil: "domcontentloaded" })

  await expect(page.getByRole("button", { name: "Cambiar empresa de agentes" })).toBeVisible({ timeout: 30_000 })
  const companyRail = page.locator("[data-agent-company-dock='apps']")
  await expect(companyRail).toHaveAttribute("data-proactive", "off", { timeout: 15_000 })
  await companyRail.getByRole("button", { name: /^PROACTIVO$/ }).click()

  await expect(companyRail).toHaveAttribute("data-proactive", "on")
  await expect(companyRail.getByRole("button", { name: /PROACTIVO · ON|EN EJECUCIÓN/ })).toBeVisible()
  expect(operations.projectCreates).toBe(1)
  expect(operations.proactiveToggles).toBe(1)
})
