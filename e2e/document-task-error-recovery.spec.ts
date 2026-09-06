import { expect, test, type BrowserContext, type Page } from "@playwright/test"

/**
 * Browser recovery regression, not provider/edit-engine or database acceptance.
 * The API fixture mirrors the persisted USER/ASSISTANT task metadata and the
 * pending-stream/events envelopes. Only the local Next UI is real; no provider,
 * production request, document edit or database write is performed.
 */
test.describe.configure({ timeout: 120_000 })
test.use({ locale: "es-PE", serviceWorkers: "block" })

const chatId = "document-error-recovery-chat"
const taskId = "document-error-recovery-task"
const userMessageId = "document-error-original-user"
const assistantMessageId = "document-error-assistant"
const filename = "siragpt-release-pr563-original.pptx"
const prompt = `En ${filename}, cambia el título de la primera diapositiva a "Historia de los Dinosaurios de 1998".`
const failure = 'No encontré el texto "primera diapositiva" dentro del PPTX.'
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
const terminalCases = [
  {
    name: "completed-target-not-found",
    status: "completed",
    stoppedReason: "source_preserving_document_target_not_found",
    // Exact buildSourcePreservingFailureMarkdown response. The deterministic
    // backend finish uses status=completed, no state.error, even for this failure.
    finalText: `No pude editar el archivo original sin cambiarlo: ${failure}. No generé un documento nuevo para evitar entregarte contenido que no conserve tu archivo. Indica el texto exacto, página, encabezado, tabla o sección donde debo aplicar el cambio y lo reintento sobre el mismo documento.`,
  },
  {
    name: "failed-task",
    status: "failed",
    stoppedReason: "error",
    finalText: "La edición no pudo completarse. El documento original no fue modificado.",
  },
] as const

async function installRecoveryFixture(context: BrowserContext, page: Page, baseURL: string, terminal: typeof terminalCases[number]) {
  expect(loopback(new URL(baseURL).hostname), "Recovery fixtures must never run against production").toBe(true)
  const timestamp = new Date().toISOString()
  const user = { id: "document-recovery-qa", name: "QA Documentos", email: "qa@example.test", plan: "PRO", isAdmin: false, isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100_000, createdAt: timestamp, updatedAt: timestamp }
  const model = { id: "qa-recovery", name: "qa-recovery", displayName: "Sira QA", provider: "QA", type: "TEXT", isActive: true }
  const runningState = {
    meta: { taskId, goal: prompt, model: model.name, tools: ["document_edit"] },
    steps: [{ id: "edit-original", label: "Editando presentación original", status: "running", toolCalls: [] }],
    artifacts: [], approvals: [], checkpoints: [], qualityGates: [], repairs: [], documentAnalysisIds: [], evidenceRefs: [],
    done: false, finalText: "", lastEventAt: Date.now(),
  }
  const failedState = {
    ...runningState, steps: [{ ...runningState.steps[0], status: "error" }],
    done: true, finalText: terminal.finalText, stoppedReason: terminal.stoppedReason,
    ...(terminal.status === "failed" ? { error: failure } : {}),
  }
  // The shared taskId on the USER is legitimate metadata, not a state bubble.
  // The DB assistant can lag the durable terminal snapshot; recovery must only
  // update the ASSISTANT and preserve its terminal state over that stale row.
  const chat = {
    id: chatId, title: "QA recuperación de edición fallida", model: model.name, createdAt: timestamp, updatedAt: timestamp,
    messages: [
      { id: userMessageId, chatId, role: "USER", content: prompt, timestamp,
        metadata: JSON.stringify({ source: "agent-task-user", taskId }),
        files: JSON.stringify([{ id: "document-recovery-source", name: filename, filename, type: "doc", format: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", url: "/api/agent/artifact/aaaaaaaaaaaaaaaa?name=" + filename }]),
      },
      { id: assistantMessageId, chatId, role: "ASSISTANT", content: "```agent-task-state\n" + JSON.stringify(runningState) + "\n```", timestamp,
        metadata: JSON.stringify({ source: "agent-task", taskId, status: "running" }),
      },
    ],
  }
  let failed = false
  let eventRequests = 0
  let failedEventRequests = 0
  let chatRequests = 0
  const errors: string[] = []
  const unexpectedExternal: string[] = []
  const forbiddenWrites: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  await context.addInitScript(({ id }) => {
    localStorage.setItem("auth-token", "offline-document-recovery-fixture")
    localStorage.setItem("currentChatId", id)
    localStorage.setItem("theme", "light")
  }, { id: chatId })
  await context.route("**/*", async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!["http:", "https:"].includes(url.protocol)) return route.continue()
    const bakedApi = url.origin === "https://siragpt.com" && url.pathname.startsWith("/api/")
    if (!loopback(url.hostname) && !bakedApi) {
      if (url.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "/* Offline fixture font fallback. */" })
      unexpectedExternal.push(`${url.origin}${url.pathname}`)
      return route.abort("blockedbyclient")
    }
    if (!url.pathname.startsWith("/api/") && url.origin === new URL(baseURL).origin) return route.continue()
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
    if (!["GET", "HEAD"].includes(request.method()) && /^\/(?:agent\/task|chats|generate)/.test(path)) {
      forbiddenWrites.push(`${request.method()} ${path}`)
      return json({ error: "Unexpected mutation during read-only recovery fixture" }, 409)
    }
    if (path === "/auth/me") return json({ user })
    if (path.startsWith("/health")) return request.method() === "HEAD" ? route.fulfill({ status: 204 }) : json({ status: "healthy" })
    if (path === "/ai/models") return json({ models: [model] })
    if (path === "/payments/subscription") return json({ plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    if (path === "/cowork/approvals") return json({ approvals: [] })
    if (path === "/users/me/notifications") return json({ items: [], unreadCount: 0 })
    if (path === "/chats") return json({ chats: [{ ...chat, messages: [] }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    if (path === `/chats/${chatId}`) { chatRequests += 1; return json({ chat }) }
    if (path === `/chats/${chatId}/pending-stream`) {
      const pointer = { taskId, status: failed ? terminal.status : "running", displayGoal: prompt, updatedAt: timestamp }
      return json({ ok: true, pending: null, activeTasks: failed ? [] : [pointer], latestTask: pointer })
    }
    if (path === `/agent/task/${taskId}/events`) {
      eventRequests += 1
      if (failed) failedEventRequests += 1
      return json({ ok: true, status: failed ? terminal.status : "running", events: [], streamState: failed ? failedState : runningState })
    }
    return json({ ok: true })
  })
  return { failTask: () => { failed = true }, eventRequests: () => eventRequests, failedEventRequests: () => failedEventRequests, chatRequests: () => chatRequests, errors, unexpectedExternal, forbiddenWrites }
}

for (const [viewportName, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]] as const) {
  for (const terminal of terminalCases) {
    test(`${viewportName}: ${terminal.name} reload preserves the user prompt and stops the spinner`, async ({ context, page, baseURL }, testInfo) => {
      await page.setViewportSize(viewport)
      const fixture = await installRecoveryFixture(context, page, baseURL!, terminal)
      await page.goto(`/agentes?id=${chatId}`, { waitUntil: "domcontentloaded", timeout: 60_000 })
      await expect.poll(fixture.eventRequests).toBeGreaterThan(0)
      fixture.failTask()
      for (let reload = 1; reload <= 2; reload++) {
        const previousFailedRequests = fixture.failedEventRequests()
        const previousChatRequests = fixture.chatRequests()
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
        await expect.poll(fixture.failedEventRequests).toBeGreaterThan(previousFailedRequests)
        await expect.poll(fixture.chatRequests).toBeGreaterThan(previousChatRequests)
        expect(new URL(page.url()).pathname).toBe("/agentes")
        await expect(page).toHaveTitle(/SiraGPT/)
        const userBubble = page.locator(`article.msg--user[data-message-id="${userMessageId}"]`)
        const assistantBubble = page.locator(`article.msg--assistant[data-message-id="${assistantMessageId}"]`)
        await expect(userBubble.getByTestId("user-message")).toHaveText(prompt)
        await expect(userBubble).toContainText(filename)
        await expect(userBubble).not.toContainText("agent-task-state")
        // A terminal bubble may present the public finalText rather than
        // repeat its internal state.error. The production target-not-found
        // response includes the exact failure detail in finalText itself.
        if (terminal.status === "completed") await expect(assistantBubble).toContainText(failure)
        await expect(assistantBubble).toContainText(terminal.finalText)
        await expect(page.getByRole("status", { name: "Agente trabajando", exact: true })).toHaveCount(0)
        await expect(page.locator(".composer-stop-button:visible")).toHaveCount(0)
        await expect(page.getByTestId("agent-artifact-card")).toHaveCount(0)
        await expect(page.locator("article.msg--user")).toHaveCount(1)
        await expect(page.locator("article.msg--assistant")).toHaveCount(1)
        await expect(page.locator("[data-nextjs-dialog-overlay]")).toHaveCount(0)
      }
      const layout = await page.locator("article.msg--user, article.msg--assistant").evaluateAll(articles => articles.map(article => {
        const ancestry = []
        let element: Element | null = article
        for (let depth = 0; element && depth < 8; depth++, element = element.parentElement) {
          const box = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          ancestry.push({ tag: element.tagName, classes: element.className, left: box.left, right: box.right, width: box.width, minWidth: style.minWidth, display: style.display, overflowX: style.overflowX })
        }
        const textEdges = Array.from(article.querySelectorAll("p")).flatMap(paragraph => {
          const range = document.createRange()
          range.selectNodeContents(paragraph)
          return Array.from(range.getClientRects()).filter(box => box.width > 0).map(box => ({ left: box.left, right: box.right }))
        })
        return { id: article.getAttribute("data-message-id"), clientWidth: article.clientWidth, scrollWidth: article.scrollWidth, ancestry, textEdges }
      }))
      await testInfo.attach("message-layout.json", { contentType: "application/json", body: JSON.stringify(layout, null, 2) })
      for (const message of layout) {
        expect(message.ancestry[0].left, `${message.id} must not escape the left viewport edge`).toBeGreaterThanOrEqual(-1)
        expect(message.ancestry[0].right, `${message.id} must not escape the right viewport edge`).toBeLessThanOrEqual(viewport.width + 1)
        // User-bubble affordances add intrinsic overflow outside the article's
        // box, but must still fit the viewport. Check actual text line bounds
        // too, so overflow:hidden or truncation cannot mask a wrapping bug.
        expect(message.ancestry[0].left + message.scrollWidth, `${message.id} horizontal content must fit the viewport`).toBeLessThanOrEqual(viewport.width + 1)
        for (const line of message.textEdges) {
          expect(line.left, `${message.id} text must not be clipped on the left`).toBeGreaterThanOrEqual(-1)
          expect(line.right, `${message.id} text must not be clipped on the right`).toBeLessThanOrEqual(viewport.width + 1)
        }
      }
      const composer = page.getByTestId("chat-composer-surface").locator("textarea")
      await composer.fill("Puedo continuar después del error.")
      await expect(composer).toHaveValue("Puedo continuar después del error.")
      await expect(page.locator(".composer-send-button:visible")).toBeEnabled()
      expect(fixture.forbiddenWrites, "recovery must not rewrite messages, retry, cancel or start another task").toEqual([])
      expect(fixture.unexpectedExternal, "fixture must remain offline").toEqual([])
      expect(fixture.errors, "no application/runtime errors").toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`document-recovery-${terminal.name}-${viewportName}.png`), fullPage: false })
    })
  }
}
