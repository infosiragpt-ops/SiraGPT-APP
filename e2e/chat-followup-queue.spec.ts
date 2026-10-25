import { expect, test, type Page, type Route } from "@playwright/test"

// Stateful API doubles keep the first operation pending while the browser
// accepts a second instruction. No account, provider call or stored user data
// is needed. Backend context loading is covered separately by its unit tests.
test.describe.configure({ timeout: 180_000 })
test.use({ locale: "es-PE", viewport: { width: 1440, height: 900 } })

const chatId = "followup-queue-chat"
const ownerId = "followup-queue-user"
const queueKey = `sira:chat-composer-queue:v1:${ownerId}`
const model = { id: "followup-text", name: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", provider: "DeepSeek", type: "TEXT", isActive: true }
const audio = { id: "followup-audio", name: "reunion.wav", type: "audio/wav", mimeType: "audio/wav", url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=", processingStage: "ready" }

type StoredMessage = { id: string; chatId: string; role: string; content: string; timestamp: string; files?: unknown[]; metadata?: string }
type Call = { path: string; body: Record<string, any>; history: string[] }

async function json(route: Route, value: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) })
}

async function setup(page: Page, mode: "agent" | "text") {
  const messages: StoredMessage[] = [
    { id: "initial-user", chatId, role: "USER", content: mode === "agent" ? "Este es el audio de la reunión." : "Responde en español.", files: mode === "agent" ? [audio] : [], timestamp: "2026-10-24T16:00:00.000Z" },
    { id: "initial-assistant", chatId, role: "ASSISTANT", content: "Listo para ayudarte.", timestamp: "2026-10-24T16:00:01.000Z" },
  ]
  const chat = { id: chatId, title: "Seguimiento en el chat", model: model.name, messages, createdAt: "2026-10-24T16:00:00.000Z", updatedAt: "2026-10-24T16:00:01.000Z" }
  const calls: Call[] = []
  let releaseFirst = () => {}
  const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve })
  await page.addInitScript(({ chatId, modelName }) => {
    localStorage.setItem("auth-token", "followup-queue-test-token")
    localStorage.setItem("currentChatId", chatId)
    localStorage.setItem("selectedModel", modelName)
  }, { chatId, modelName: model.name })

  const handler = async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (path === "/auth/me") return json(route, { user: { id: ownerId, name: "Prueba de seguimiento", email: "followup@example.com", plan: "PRO", isAdmin: false, isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100000 } })
    if (path === "/health") return req.method() === "HEAD" ? route.fulfill({ status: 204 }) : json(route, { status: "healthy" })
    if (path === "/ai/models") return json(route, { models: [model] })
    if (path === "/payments/subscription") return json(route, { plan: "PRO", status: "active", apiUsage: 0, monthlyLimit: 100000 })
    if (path === "/chats") return json(route, req.method() === "POST" ? { chat } : { chats: [chat], pagination: { page: 1, total: 1, pages: 1 } })
    if (path === `/chats/${chatId}`) return json(route, { chat })
    if (path === "/ai/intent/semantic") return json(route, { ok: true, intent: "text", confidence: 1 })
    if (path === "/agent/task" || path === "/ai/generate") {
      const body = req.postDataJSON()
      const number = calls.length + 1
      calls.push({ path, body, history: messages.map((message) => message.content) })
      if (number === 1) await firstFinished
      const prompt = String(body.goal || body.prompt || "")
      const reply = number === 1 ? "Primer resultado: la reunión trata sobre el presupuesto." : `Seguimiento ${number} completado con el contexto anterior.`
      const key = body.idempotencyKey || req.headers()["idempotency-key"]
      const metadata = key ? JSON.stringify({ idempotencyKey: key }) : undefined
      messages.push(
        { id: `user-${number}`, chatId, role: "USER", content: prompt, timestamp: new Date().toISOString(), metadata },
        { id: `assistant-${number}`, chatId, role: "ASSISTANT", content: reply, timestamp: new Date().toISOString(), metadata },
      )
      const events = path === "/agent/task" ? [
        { type: "meta", taskId: `followup-task-${number}`, goal: prompt, model: model.name, tools: [] },
        { type: "final_text", markdown: reply },
        { type: "done" },
      ] : [{ content: reply }, "[DONE]"]
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("") })
    }
    // Unknown API traffic is also isolated from the real backend.
    return json(route, {})
  }
  await page.route("**/api/**", handler)
  await page.route("http://localhost:5000/**", handler)
  return { calls, messages, releaseFirst }
}

async function open(page: Page) {
  await page.goto(`/agentes?id=${chatId}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  const composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()
  await expect(composer).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText("Listo para ayudarte.", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
  return composer
}

function bubble(page: Page, text: string) {
  return page.getByTestId("user-message").filter({ hasText: text })
}

for (const mode of ["agent", "text"] as const) {
  test(`a second ${mode} prompt is visible immediately, waits its turn and keeps the next draft`, async ({ page }, info) => {
    const state = await setup(page, mode)
    const composer = await open(page)
    const input = composer.locator("textarea")
    const first = mode === "agent" ? "analiza los audios" : "Explica brevemente qué significa presupuesto."
    const second = mode === "agent" ? "resume los audios en cinco puntos" : "Ahora explícalo con un ejemplo sencillo."
    const draft = "Este borrador todavía no se debe enviar."
    try {
      await input.fill(first)
      await input.press("Enter")
      await expect.poll(() => state.calls.length, { timeout: 30000 }).toBe(1)
      expect(state.calls[0].path).toBe(mode === "agent" ? "/agent/task" : "/ai/generate")
      await expect(input).toHaveValue("")
      await input.fill(second)
      if (mode === "agent") await input.press("Enter")
      else await composer.locator("button.composer-send-button").click()
      await expect(input).toHaveValue("")
      await expect(bubble(page, second)).toHaveCount(1)
      await expect(bubble(page, second)).toBeVisible()
      const queued = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), queueKey)
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({ chatId, msg: second, ownerId })
      expect(state.calls).toHaveLength(1)
      expect(state.calls[0].history).not.toContain(second)
      await input.fill(draft)
      await page.screenshot({ path: info.outputPath(`${mode}-followup-queued.png`) })
      state.releaseFirst()
      await expect.poll(() => state.calls.length, { timeout: 30000 }).toBe(2)
      expect(state.calls[1].body).toMatchObject({ chatId, model: model.name })
      expect(state.calls[1].body.goal || state.calls[1].body.prompt).toBe(second)
      if (mode === "agent") expect(state.calls[1].body.files).toEqual([audio.id])
      expect(state.calls[1].history).toContain("Primer resultado: la reunión trata sobre el presupuesto.")
      await expect(page.getByText("Seguimiento 2 completado con el contexto anterior.", { exact: false }).first()).toBeVisible({ timeout: 30000 })
      await expect(input).toHaveValue(draft)
      await expect(bubble(page, second)).toHaveCount(1)
      await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]").length, queueKey)).toBe(0)
      expect(state.calls).toHaveLength(2)
    } finally {
      state.releaseFirst()
    }
  })
}

test("a restored queue drains once without sending or erasing the independent saved draft", async ({ page }) => {
  const state = await setup(page, "text")
  const prompt = "Amplía la explicación anterior con un ejemplo."
  const draft = "Otro borrador que sigo preparando."
  await page.addInitScript(({ queueKey, ownerId, chatId, prompt, draft }) => {
    if (localStorage.getItem("followup-queue-seeded")) return
    localStorage.setItem("followup-queue-seeded", "1")
    localStorage.setItem(queueKey, JSON.stringify([{ id: "queued-restored", ownerId, chatId, msg: prompt, files: [], idempotencyKey: "restored-followup-key", createdAt: "2026-10-24T16:01:00.000Z" }]))
    localStorage.setItem(`sira:chat-draft:${ownerId}:${chatId}`, draft)
  }, { queueKey, ownerId, chatId, prompt, draft })
  try {
    const composer = await open(page)
    await expect.poll(() => state.calls.length, { timeout: 30000 }).toBe(1)
    expect(state.calls[0].body).toMatchObject({ chatId, prompt, idempotencyKey: "restored-followup-key" })
    await expect(composer.locator("textarea")).toHaveValue(draft)
    state.releaseFirst()
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]").length, queueKey)).toBe(0)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator('[data-testid="chat-composer-surface"]:visible').last().locator("textarea")).toHaveValue(draft, { timeout: 30000 })
    expect(state.calls).toHaveLength(1)
  } finally {
    state.releaseFirst()
  }
})
