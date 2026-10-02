import { expect, test, type Page, type Route } from "@playwright/test"

test.describe.configure({ timeout: 240_000 })
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

const SHOTS = process.env.AUDIT_SHOTS || "test-results/audit"
const user = { id: "audit-user", name: "Luis", email: "luis@example.com", plan: "PRO", isAdmin: true, isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100_000, createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" }
const textModel = { id: "m1", name: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", provider: "DeepSeek", type: "TEXT", isActive: true }
const chat = {
  id: "audit-chat", title: "Hola", model: textModel.name, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
  messages: [
    { id: "u1", role: "USER", content: "Hola", chatId: "audit-chat", createdAt: "2026-09-30T00:00:01.000Z", timestamp: "2026-09-30T00:00:01.000Z" },
    { id: "a1", role: "ASSISTANT", content: "¡Hola, Luis! ¿En qué te ayudo hoy?", chatId: "audit-chat", createdAt: "2026-09-30T00:00:05.000Z", timestamp: "2026-09-30T00:00:05.000Z", model: textModel.name },
  ],
}
async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })
}
async function mockApi(page: Page) {
  await page.addInitScript(({ chatId }) => {
    localStorage.setItem("auth-token", "audit-token")
    localStorage.setItem("currentChatId", chatId)
    localStorage.setItem("theme", "light")
  }, { chatId: chat.id })
  const handle = async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: [textModel] })
    if (path === "/skills") return fulfillJson(route, { ok: true, skills: [] })
    if (path === "/memory") return fulfillJson(route, { entries: [], markdown: "", stats: { total: 0, byCategory: {} } })
    if (path === "/payments/subscription") return fulfillJson(route, { plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    if (path === "/chats" && request.method() === "GET") return fulfillJson(route, { chats: [{ ...chat, messages: undefined }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    if (path === `/chats/${chat.id}`) return fulfillJson(route, { chat })
    if (path === "/chats/active-tasks") return fulfillJson(route, { ok: true, tasks: [] })
    return fulfillJson(route, {})
  }
  await page.route("**/api/**", handle)
  await page.route("http://localhost:5000/**", handle)
}


test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false })

test("atom · sidebar + login", async ({ page }) => {
  await mockApi(page)
  await page.goto(`/agentes?id=${chat.id}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator('[data-testid="chat-composer-surface"]:visible').last()).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(1200)
  const brand = page.locator('[data-testid="sidebar-brand"]')
  await expect(brand).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/atom-desktop-light.png`, fullPage: false })
  await brand.screenshot({ path: `${SHOTS}/atom-sidebar-brand.png` })
  await page.evaluate(() => { document.documentElement.classList.add("dark") })
  await page.waitForTimeout(600)
  await brand.screenshot({ path: `${SHOTS}/atom-sidebar-brand-dark.png` })
  // Collapsed rail
  await page.keyboard.press("Meta+b")
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/atom-desktop-collapsed-dark.png`, clip: { x: 0, y: 0, width: 120, height: 120 } })
  const info = await page.evaluate(() => {
    const atoms = Array.from(document.querySelectorAll('svg[data-brand="atom"]')).map(s => ({ w: s.getBoundingClientRect().width, visible: !!(s as unknown as HTMLElement).getClientRects().length }))
    return { atoms, knots: document.querySelectorAll('svg[data-brand="knot"]').length }
  })
  console.log("ATOM_INFO", JSON.stringify(info))
  await page.goto("/auth/login", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/atom-login.png`, fullPage: false })
})
