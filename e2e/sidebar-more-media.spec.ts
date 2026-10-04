import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Sidebar «··· Más» (under Empresas) opens Video / Voz / Imagen / Música and
 * picking one opens a fresh chat with that composer mode selected. APIs are
 * stubbed so CI never bills.
 */
test.describe.configure({ timeout: 240_000 })

const user = {
  id: "more-media-user",
  name: "Valeria Castro",
  email: "valeria@example.com",
  plan: "PRO",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
}

const textModel = {
  id: "more-media-text",
  name: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  provider: "DeepSeek",
  type: "TEXT",
  isActive: true,
}

const chat = {
  id: "more-media-chat",
  title: "Más QA",
  model: textModel.name,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  messages: [] as unknown[],
}

const catalog: unknown[] = []
const discover = { ok: true, featured: null, forYou: [], latest: [], categories: [], items: [], total: 0, memoryUsed: false }

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
    if (path === "/skills/library") {
      return fulfillJson(route, {
        ok: true,
        mine: [{ ...catalog[5], author: "por ti", enabled: true, updatedAt: "2026-09-29T10:00:00.000Z", editable: true, removable: true }],
        partners: catalog.slice(0, 5).map((s) => ({ ...s, author: "SiraGPT", enabled: true, updatedAt: null, editable: false, removable: false })),
      })
    }
    if (path === "/skills/discover") return fulfillJson(route, discover)
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

async function openAgentes(page: Page, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport)
  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator('[data-testid="chat-composer-surface"]:visible').last()).toBeVisible({ timeout: 120_000 })
}

const CHIPS = { video: "video-mode-chip", voice: "voz-mode-chip", image: "imagenes-mode-chip", music: "musica-mode-chip" } as const

test("«Más» sits under Empresas and lists Video, Voz, Imagen y Música", async ({ page }) => {
  await mockApi(page, [])
  await openAgentes(page)
  const more = page.getByTestId("sidebar-more-media")
  await expect(more).toBeVisible()
  const empresas = page.locator('a[href="/projects"]').first()
  const [eBox, mBox] = [await empresas.boundingBox(), await more.boundingBox()]
  expect(eBox && mBox && mBox.y > eBox.y).toBeTruthy()

  await more.click()
  const panel = page.getByTestId("sidebar-more-media-panel")
  await expect(panel).toBeVisible()
  const labels = (await panel.getByRole("menuitem").allInnerTexts()).map((t) => t.split("\n")[0].trim())
  expect(labels).toEqual(["Video", "Voz", "Imagen", "Música"])
  await page.screenshot({ path: "test-results/sidebar-more-media.png" })
})

for (const mode of ["video", "voice", "image", "music"] as const) {
  test(`«Más → ${mode}» opens a new chat with that mode selected`, async ({ page }) => {
    await mockApi(page, [])
    await openAgentes(page)
    await page.getByTestId("sidebar-more-media").click()
    await page.getByTestId(`sidebar-more-media-${mode}`).click()
    await expect(page.getByTestId("sidebar-more-media-panel")).toHaveCount(0)
    await expect(page.getByTestId(CHIPS[mode])).toBeVisible({ timeout: 15_000 })
    for (const other of Object.keys(CHIPS) as (keyof typeof CHIPS)[]) {
      if (other !== mode) await expect(page.getByTestId(CHIPS[other])).toHaveCount(0)
    }
    await page.screenshot({ path: `test-results/sidebar-more-media-${mode}.png` })
  })
}

test("«Más» works on phones from the sidebar sheet", async ({ page }) => {
  await mockApi(page, [])
  await openAgentes(page, { width: 390, height: 844 })
  await page.getByRole("button", { name: "Abrir el menú lateral" }).first().click()
  await page.getByTestId("sidebar-more-media").click()
  await expect(page.getByTestId("sidebar-more-media-panel")).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: "test-results/sidebar-more-media-mobile.png" })
  await page.getByTestId("sidebar-more-media-music").click()
  await expect(page.getByTestId("musica-mode-chip")).toBeVisible({ timeout: 15_000 })
})
