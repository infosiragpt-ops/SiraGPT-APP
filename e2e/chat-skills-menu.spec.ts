import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * «+ → Skills» (claude.ai style) on /agentes: the item sits right under
 * «Subir documento», «Modo de voz» is gone, a picked skill shows as a
 * composer chip and travels as `skills: [name]` on /api/ai/generate.
 * APIs are stubbed so CI never bills.
 */
test.describe.configure({ timeout: 240_000 })

const user = {
  id: "skills-user",
  name: "Valeria Castro",
  email: "valeria@example.com",
  plan: "PRO",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
}

const textModel = {
  id: "skills-text",
  name: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  provider: "DeepSeek",
  type: "TEXT",
  isActive: true,
}

const chat = {
  id: "skills-chat",
  title: "Skills QA",
  model: textModel.name,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  messages: [] as unknown[],
}

const catalog = [
  { name: "docx", title: "Word", description: "Crear y editar documentos Word (.docx).", source: "builtin" },
  { name: "pptx", title: "PowerPoint", description: "Presentaciones .pptx con diseño profesional.", source: "builtin" },
  { name: "xlsx", title: "Excel", description: "Hojas de cálculo .xlsx.", source: "builtin" },
  { name: "pdf", title: "PDF", description: "Leer, crear y editar PDF.", source: "builtin" },
  { name: "csv", title: "CSV", description: "Datos en CSV.", source: "builtin" },
  { name: "informe-ucv", title: "informe-ucv", description: "Formato UCV para informes de investigación.", source: "biblioteca" },
]

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })
}

async function mockApi(page: Page, generateBodies: unknown[]) {
  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "skills-token")
    localStorage.removeItem("currentChatId")
  })
  const handle = async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: [textModel] })
    if (path === "/skills") return fulfillJson(route, { ok: true, skills: catalog })
    if (path === "/payments/subscription") {
      return fulfillJson(route, { plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    }
    if (path === "/chats" && request.method() === "GET") {
      return fulfillJson(route, { chats: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } })
    }
    if (path === "/chats" && request.method() === "POST") return fulfillJson(route, { chat: { ...chat, messages: [] } })
    if (path === `/chats/${chat.id}`) return fulfillJson(route, { chat: { ...chat, messages: [] } })
    if (path.endsWith("/messages") && request.method() === "POST") {
      const sent = (() => { try { return request.postDataJSON() } catch { return {} } })()
      return fulfillJson(route, { message: { ...sent, id: `msg-${Date.now()}`, chatId: chat.id, timestamp: new Date().toISOString() } })
    }
    if (path === "/doc/generate") {
      try { generateBodies.push(request.postDataJSON()) } catch { generateBodies.push(null) }
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'data: {"type":"final","content":"Listo."}\n\n' })
    }
    if (path === "/agent/task" || path === "/agent/task/stream") {
      try { generateBodies.push(request.postDataJSON()) } catch { generateBodies.push(null) }
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' })
    }
    if (path === "/ai/generate") {
      try { generateBodies.push(request.postDataJSON()) } catch { generateBodies.push(null) }
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"content":"Listo."}\n\ndata: [DONE]\n\n',
      })
    }
    return fulfillJson(route, {})
  }
  await page.route("**/api/**", handle)
  await page.route("http://localhost:5000/**", handle)
}

async function openComposer(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()
  await expect(composer).toBeVisible({ timeout: 120_000 })
  return composer
}

test("the + menu offers Skills under «Subir documento» and no «Modo de voz»", async ({ page }) => {
  await mockApi(page, [])
  await openComposer(page)
  await expect(page.getByTestId("chat-computer-badge")).toBeVisible()
  await page.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()

  const items = page.locator(".chat-tools-menu [role='menuitem']:visible")
  const labels = (await items.allInnerTexts()).map((text) => text.split("\n")[0].trim())
  const upload = labels.indexOf("Subir documento")
  expect(upload, labels.join(" | ")).toBeGreaterThanOrEqual(0)
  expect(labels[upload + 1], labels.join(" | ")).toBe("Skills")
  expect(labels.join(" | ")).not.toMatch(/Modo de voz/)

  await page.getByTestId("chat-skills-trigger").hover()
  await expect(page.getByTestId("chat-skill-option-docx")).toBeVisible()
  await expect(page.getByTestId("chat-skill-option-informe-ucv")).toBeVisible()
  await page.screenshot({ path: "test-results/skills-menu.png" })
})

for (const scenario of [
  { name: "chat turn (/api/ai/generate)", skill: "xlsx", prompt: "explica en tres frases qué es una tabla dinámica" },
  { name: "document request (/api/doc/generate)", skill: "pptx", prompt: "haz una presentación de 5 diapositivas sobre energía solar" },
]) {
  test(`a picked skill becomes a chip and rides the ${scenario.name}`, async ({ page }) => {
    const bodies: unknown[] = []
    await mockApi(page, bodies)
    const composer = await openComposer(page)
    await page.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
    await page.getByTestId("chat-skills-trigger").hover()
    await page.getByTestId(`chat-skill-option-${scenario.skill}`).click()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")

    const chip = page.getByTestId(`chat-skill-chip-${scenario.skill}`)
    await expect(chip).toBeVisible()
    await page.screenshot({ path: `test-results/skills-chip-${scenario.skill}.png` })

    const textarea = composer.locator("textarea").first()
    await textarea.fill(scenario.prompt)
    await textarea.press("Enter")

    await expect.poll(() => bodies.length, { timeout: 60_000 }).toBeGreaterThan(0)
    const body = bodies.find((b) => b && typeof b === "object" && ("prompt" in (b as Record<string, unknown>) || "goal" in (b as Record<string, unknown>))) as Record<string, unknown> | undefined
    expect(body?.skills).toEqual([scenario.skill])
    await expect(page.getByTestId(`chat-skill-chip-${scenario.skill}`)).toHaveCount(0)
  })
}
