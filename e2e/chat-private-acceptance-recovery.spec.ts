import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Local rendered-UI regression only. Every API is a fixture; this does not
// certify Meta, provider billing, durable database writes or production.
test.describe.configure({ timeout: 120_000 })
test.use({ locale: "es-PE", serviceWorkers: "block" })

const prompt = "Responde solo OK"
const partial = "Respuesta parcial sintética que debe conservarse."
const completed = "Respuesta sintética completa."
const privateDetail = "PRIVATE_ACCEPTANCE_DETAIL_MUST_NOT_RENDER"
const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname)

async function installFixture(context: BrowserContext, page: Page, baseURL: string, failed: boolean) {
  const origin = new URL(baseURL).origin
  expect(isLoopback(new URL(baseURL).hostname), "Never run this fixture against production").toBe(true)
  const chatId = "private-acceptance-recovery-chat"
  const timestamp = new Date().toISOString()
  const user = { id: "private-acceptance-qa", name: "QA local", email: "qa@example.test", plan: "PRO", isAdmin: false,
    isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100_000, createdAt: timestamp, updatedAt: timestamp }
  const model = { id: "qa-meta", name: "muse-spark-1.3-contributor", displayName: "Sira Rápido", provider: "Meta", type: "TEXT", isActive: true }
  const chat: Record<string, any> = { id: chatId, title: "QA recuperación privada", model: model.name,
    createdAt: timestamp, updatedAt: timestamp, messages: [] }
  let generateCount = 0
  let chatReads = 0
  let recoveryReads = 0
  let generatedEnvelope: unknown = null
  let releaseRecovery!: () => void
  const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const blockedExternal: string[] = []
  const forbiddenWrites: string[] = []
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
  await context.addInitScript(({ id }) => {
    localStorage.setItem("auth-token", "offline-private-acceptance-fixture")
    localStorage.setItem("currentChatId", id)
    localStorage.setItem("theme", "light")
  }, { id: chatId })
  await context.routeWebSocket("**", socket => {
    const url = new URL(socket.url())
    if (isLoopback(url.hostname) && url.host === new URL(baseURL).host) socket.connectToServer()
    else { blockedExternal.push(`${url.origin}${url.pathname}`); socket.close() }
  })
  await context.route("**/*", async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!["http:", "https:"].includes(url.protocol)) return route.continue()
    // A previously baked API origin is intercepted, NEVER forwarded remotely.
    const bakedApi = ["https://siragpt.com", "http://localhost:5000"].includes(url.origin) && url.pathname.startsWith("/api/")
    const apiOrigin = url.origin === origin || bakedApi
    if (!apiOrigin) {
      if (url.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "/* offline */" })
      blockedExternal.push(`${url.origin}${url.pathname}`)
      return route.abort("blockedbyclient")
    }
    if (!url.pathname.startsWith("/api/")) return route.continue()
    const apiPath = url.pathname.slice(4)
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
    if (apiPath === "/auth/me") return json({ user })
    if (apiPath.startsWith("/health")) return request.method() === "HEAD" ? route.fulfill({ status: 204 }) : json({ status: "healthy" })
    if (apiPath === "/ai/models") return json({ models: [model] })
    if (apiPath === "/payments/subscription") return json({ plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    if (apiPath === "/cowork/approvals") return json({ approvals: [] })
    if (apiPath === "/users/me/notifications") return json({ items: [], unreadCount: 0 })
    if (apiPath === "/ai/intent/semantic") return json({ ok: true, intent: "text", confidence: 1 })
    if (apiPath === "/chats/active-runs") return json({ runs: [] })
    if (apiPath === "/chats/active-tasks") return json({ ok: true, tasks: [] })
    if (apiPath === "/chats" && request.method() === "GET") return json({ chats: [{ ...chat, messages: [] }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    if (apiPath === `/chats/${chatId}/pending-stream`) return json({ ok: true, pending: null, activeTasks: [], latestTask: null })
    if (apiPath === `/chats/${chatId}` && request.method() === "GET") {
      chatReads++
      if (generateCount) { recoveryReads++; await recoveryGate }
      return json({ chat })
    }
    if (apiPath === `/chats/${chatId}` && request.method() === "PUT") return json({ chat })
    if (apiPath === "/ai/generate" && request.method() === "POST") {
      generateCount++
      const body = request.postDataJSON()
      expect(generateCount, "Recovery must not generate a second turn").toBe(1)
      expect(body.chatId).toBe(chatId)
      expect(body.prompt).toBe(prompt)
      expect(body.model).toBe(model.name)
      expect(body.disableAgentic).toBe(true)
      expect(body.idempotencyKey).toEqual(expect.any(String))
      generatedEnvelope = { model: body.model, provider: body.provider, chatId: body.chatId, prompt: body.prompt,
        idempotencyKey: body.idempotencyKey, streamId: body.streamId, intent: body.intent, disableAgentic: body.disableAgentic }
      const metadata = { idempotencyKey: body.idempotencyKey, streamId: body.streamId }
      chat.messages = [
        { id: "private-recovery-user", chatId, role: "USER", content: prompt, timestamp, metadata: JSON.stringify(metadata) },
        { id: "private-recovery-assistant", chatId, role: "ASSISTANT", content: failed ? partial : completed, timestamp,
          metadata: JSON.stringify({ ...metadata, ...(failed ? { acceptanceFailure: { code: "E_QUOTA", status: "failed", terminal: true,
            retryable: false, message: privateDetail } } : {}) }) },
      ]
      // EOF without [DONE] represents a cut private stream. The history read
      // is deliberately held until the test observes the partial in real DOM.
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "X-Sira-Acceptance": "1", "Cache-Control": "no-cache",
        // next start may use the explicitly intercepted :5000 API origin.
        // Make the synthetic private header browser-readable there as well.
        "Access-Control-Expose-Headers": "X-Sira-Acceptance" },
        body: `data: ${JSON.stringify({ type: "text_delta", content: (failed ? partial : completed) + "\n" })}\n\n${failed ? "" : "data: [DONE]\n\n"}` })
    }
    if (!["GET", "HEAD"].includes(request.method())) {
      forbiddenWrites.push(`${request.method()} ${apiPath}`)
      return json({ error: "Unexpected write in local fixture" }, 409)
    }
    return json({ ok: true })
  })
  return { chatId, generateCount: () => generateCount, chatReads: () => chatReads, recoveryReads: () => recoveryReads,
    generatedEnvelope: () => generatedEnvelope, releaseRecovery, pageErrors, consoleErrors, blockedExternal, forbiddenWrites }
}

for (const [name, viewport, failed] of [
  ["desktop failure", { width: 1440, height: 1000 }, true],
  ["mobile failure", { width: 390, height: 844 }, true],
  ["desktop success control", { width: 1440, height: 1000 }, false],
] as const) {
  test(`${name}: private stream recovery preserves content and terminal meaning`, async ({ context, page, baseURL }, testInfo) => {
    await page.setViewportSize(viewport)
    const fixture = await installFixture(context, page, baseURL!, failed)
    try {
      await page.goto(`/agentes?id=${fixture.chatId}`, { waitUntil: "domcontentloaded", timeout: 60_000 })
      const composer = page.getByTestId("chat-composer-surface").locator("textarea")
      await Promise.all([
        expect.poll(fixture.chatReads, { timeout: 30_000 }).toBeGreaterThan(0),
        expect(composer).toBeVisible({ timeout: 30_000 }),
      ])
      await composer.fill(prompt)
      await composer.press("Enter")
      await expect.poll(fixture.generateCount).toBe(1)
      const assistant = page.locator("article.msg--assistant")
      await expect(assistant).toContainText(failed ? partial : completed)
      if (failed) {
        await expect.poll(fixture.recoveryReads, { message: "Private partial EOF must recover the persisted terminal turn" }).toBeGreaterThan(0)
        await expect(page.locator('[title="Tarea completada"]')).toHaveCount(0)
      }
      fixture.releaseRecovery()
      await expect(page.locator(".composer-stop-button:visible")).toHaveCount(0)
      await expect(assistant).toContainText(failed ? partial : completed)
      const evidence = await mkdtemp(path.join(tmpdir(), "siragpt-private-recovery-"))
      // On small screens the history panel is deliberately unmounted until
      // the user opens it. Exercise that real interaction before inspecting it.
      if (viewport.width < 768) await page.getByRole("button", { name: "Abrir el menú lateral", exact: true }).click()
      if (failed) {
        await expect(page.locator('[title="Tarea con error"]')).toHaveCount(1)
        await expect(page.locator('[title="Tarea completada"]')).toHaveCount(0)
      } else {
        await expect(page.locator('[title="Tarea completada"]')).toHaveCount(1)
        await expect(page.locator('[title="Tarea con error"]')).toHaveCount(0)
      }
      if (viewport.width < 768) {
        const historyScreenshot = path.join(evidence, "mobile-error-history.png")
        await page.screenshot({ path: historyScreenshot, fullPage: false, animations: "disabled" })
        await testInfo.attach("history-screenshot", { path: historyScreenshot, contentType: "image/png" })
        await page.getByRole("dialog", { name: "Menú lateral" }).getByRole("button", { name: /Contraer barra lateral/ }).click()
        await expect(page.locator('[data-sidebar="sidebar"][data-mobile="true"]')).toHaveCount(0)
        await expect(composer).toBeVisible()
      }
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sira_pending_messages") || "[]"))).toEqual([])
      await expect(page.locator("article.msg--user")).toHaveCount(1)
      await expect(assistant).toHaveCount(1)
      await expect(page.locator("article.msg--user").getByTestId("user-message")).toHaveText(prompt)
      await expect(page.locator("body")).not.toContainText(privateDetail)
      expect(new URL(page.url()).pathname).toBe("/agentes")
      await expect(page).toHaveTitle(/SiraGPT/)
      await expect(page.locator("[data-nextjs-dialog-overlay]")).toHaveCount(0)
      const screenshot = path.join(evidence, `${name.replaceAll(" ", "-")}.png`)
      await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" })
      await testInfo.attach("terminal-screenshot", { path: screenshot, contentType: "image/png" })
      // Wake the actual online-retry subscriber, then reload the same chat.
      // Neither operation is permission to repeat a terminal billed request.
      await page.evaluate(() => window.dispatchEvent(new Event("online")))
      const reads = fixture.chatReads()
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
      await expect.poll(fixture.chatReads, { timeout: 30_000 }).toBeGreaterThan(reads)
      await expect(composer).toBeVisible({ timeout: 30_000 })
      await expect(page.locator("article.msg--assistant")).toContainText(failed ? partial : completed)
      await expect(page.locator("article.msg--assistant")).toHaveCount(1)
      await expect(page.locator("article.msg--user")).toHaveCount(1)
      await expect(page.locator("article.msg--user").getByTestId("user-message")).toHaveText(prompt)
      await expect(page.locator(".composer-stop-button:visible")).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sira_pending_messages") || "[]"))).toEqual([])
      expect(fixture.generateCount()).toBe(1)
      expect(fixture.forbiddenWrites).toEqual([])
      expect(fixture.blockedExternal).toEqual([])
      expect(fixture.pageErrors).toEqual([])
      // A deliberately failed stream may log its sanitized terminal failure;
      // no private stored cause or unrelated application error is accepted.
      expect(fixture.consoleErrors.filter(message => !failed || !/Streaming failed:[\s\S]*La prueba no puede continuar con el presupuesto acreditado/.test(message))).toEqual([])
      await testInfo.attach("local-qa.json", { contentType: "application/json", body: JSON.stringify({ syntheticOnly: true,
        productionVerified: false, name, screenshot, generateCount: fixture.generateCount(), recoveryReads: fixture.recoveryReads(),
        consoleErrors: fixture.consoleErrors, pageErrors: fixture.pageErrors, externalRequestsBlocked: fixture.blockedExternal }, null, 2) })
    } finally {
      await testInfo.attach("fixture-observations.json", { contentType: "application/json", body: JSON.stringify({
        syntheticOnly: true, generatedEnvelope: fixture.generatedEnvelope(), generateCount: fixture.generateCount(),
        chatReads: fixture.chatReads(), recoveryReads: fixture.recoveryReads(), pageErrors: fixture.pageErrors,
        consoleErrors: fixture.consoleErrors, blockedExternal: fixture.blockedExternal, forbiddenWrites: fixture.forbiddenWrites,
        articles: await page.locator("article").evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute("data-message-id"),
          role: node.getAttribute("aria-label"), text: node.textContent }))).catch(() => []),
      }, null, 2) })
      fixture.releaseRecovery()
    }
  })
}
