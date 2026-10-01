import { expect, test, type BrowserContext, type Page } from "@playwright/test"

// Real responsive Next UI; network/database/model responses are fixed local
// fixtures. This test never calls production or claims model acceptance.
test.use({ locale: "es-PE", serviceWorkers: "block" })
const chatId = "rich-rendering-qa"
const messageId = "rich-rendering-answer"
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
const wideHeaders = Array.from({ length: 9 }, (_, index) => `Columna ${index + 1} de resultados`)
const content = [
  "## Resumen",
  "Ver [el resumen](#resumen) y [documentación][manual].",
  "1. Primer paso\n\n2. Segundo paso",
  `| ${wideHeaders.join(" | ")} |\n| ${wideHeaders.map(() => "---").join(" | ")} |\n| ${wideHeaders.map((_, index) => String(index)).join(" | ")} |`,
  "Identificador largo: " + "documento_".repeat(90),
  "Código inline: `" + "variable_".repeat(80) + "`",
  "```js\nconst formula = '\\(x\\)';\nconst value = '" + "x".repeat(800) + "';\n```",
  "\\[\\sum_{i=1}^{n} x_i = 42\\]",
  "[manual]: https://example.com/docs",
].join("\n\n")

async function installFixture(context: BrowserContext, page: Page, baseURL: string) {
  expect(loopback(new URL(baseURL).hostname), "Rendering fixture is loopback-only").toBe(true)
  const timestamp = new Date().toISOString()
  const user = { id: "render-qa", name: "QA", email: "qa@example.test", plan: "PRO", isAdmin: false, apiUsage: 0, monthlyLimit: 100_000 }
  const model = { id: "render-qa", name: "render-qa", displayName: "Sira QA", provider: "QA", type: "TEXT", isActive: true }
  const chat = { id: chatId, title: "Renderizado enriquecido", model: model.name, createdAt: timestamp, updatedAt: timestamp, messages: [
    { id: "rich-rendering-question", chatId, role: "USER", content: "Muestra resultados", timestamp },
    { id: messageId, chatId, role: "ASSISTANT", content, timestamp, files: null },
  ] }
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await context.addInitScript(({ id }) => {
    localStorage.setItem("auth-token", "offline-rendering-fixture")
    localStorage.setItem("currentChatId", id)
    localStorage.setItem("theme", "light")
  }, { id: chatId })
  await context.route("**/*", async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!["http:", "https:"].includes(url.protocol)) return route.continue()
    const bakedApi = url.origin === "https://siragpt.com" && url.pathname.startsWith("/api/")
    if (!loopback(url.hostname) && !bakedApi) return route.abort("blockedbyclient")
    if (!url.pathname.startsWith("/api/") && url.origin === new URL(baseURL).origin) return route.continue()
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    if (path === "/auth/me") return json({ user })
    if (path.startsWith("/health")) return json({ status: "healthy" })
    if (path === "/ai/models") return json({ models: [model] })
    if (path === "/payments/subscription") return json({ plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    if (path === "/cowork/approvals") return json({ approvals: [] })
    if (path === "/users/me/notifications") return json({ items: [], unreadCount: 0 })
    if (path === "/chats") return json({ chats: [{ ...chat, messages: [] }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    if (path === `/chats/${chatId}`) return json({ chat })
    if (path.endsWith("/pending-stream")) return json({ ok: true, pending: null, activeTasks: [], latestTask: null })
    return json({ ok: true })
  })
  return errors
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]] as const) {
  test(`${name}: tables, long code and math stay inside the conversation`, async ({ context, page, baseURL }, testInfo) => {
    await page.setViewportSize(viewport)
    const errors = await installFixture(context, page, baseURL!)
    await page.goto(`/agentes?id=${chatId}`, { waitUntil: "domcontentloaded" })
    const response = page.locator(`article[data-message-id="${messageId}"]`)
    await expect(response.getByRole("heading", { name: "Resumen" })).toBeVisible({ timeout: 30_000 })
    const region = response.getByRole("region", { name: "Tabla de la respuesta" })
    await expect(region).toBeVisible()
    await expect(response.locator(".katex-display")).toBeVisible()
    await expect(response.locator('a[href="https://example.com/docs"]')).toHaveText("documentación")
    await expect(response.locator("ol li")).toHaveCount(2)
    await expect(response.locator(".chat-code-block code")).toContainText("'\\(x\\)'")
    await region.focus()
    await expect(region).toBeFocused()
    expect(await region.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    await page.keyboard.press("ArrowRight")
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    const anchor = response.getByRole("link", { name: "el resumen" })
    await expect(anchor).not.toHaveAttribute("target", "_blank")
    await anchor.click()
    await expect(page).toHaveURL(/#resumen$/)
    const layout = await response.evaluate(element => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }))
    expect(layout.left).toBeGreaterThanOrEqual(-1)
    expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1)
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1)
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`rich-rendering-${name}.png`), fullPage: true })
  })
}
