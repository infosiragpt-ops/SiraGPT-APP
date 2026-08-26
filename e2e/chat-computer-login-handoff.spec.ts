import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Informational: computer login-handoff chrome (web + mobile).
 * Not the critical UI gate. APIs are stubbed. Never captures credentials.
 */
test.describe.configure({ timeout: 240_000 })

const user = {
  id: "login-handoff-user",
  name: "Valeria Castro",
  email: "valeria@example.com",
  plan: "PRO",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
}

const chat = {
  id: "login-handoff-chat",
  title: "Login handoff QA",
  model: "deepseek-v4-flash",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  messages: [] as unknown[],
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function mockApi(page: Page, opts: { handoffActive?: boolean } = {}) {
  let handoffActive = opts.handoffActive !== false
  const chatBodies: string[] = []

  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "login-handoff-token")
    localStorage.setItem("currentChatId", "login-handoff-chat")
  })

  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") {
      return fulfillJson(route, {
        models: [{ id: "m1", name: "deepseek-v4-flash", displayName: "Sira Rápido", provider: "DeepSeek", type: "TEXT", isActive: true }],
      })
    }
    if (path === "/payments/subscription") {
      return fulfillJson(route, { plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100000 })
    }
    if (path === "/chats" && request.method() === "GET") {
      return fulfillJson(route, { chats: [{ ...chat, messages: [] }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    }
    if (path === `/chats/${chat.id}`) return fulfillJson(route, { chat })
    if (path === "/agent-computer/sessions" && request.method() === "POST") {
      return fulfillJson(route, {
        sessionId: "sess-handoff",
        userId: "user_c_loginhandoffchat",
        conversationId: chat.id,
        conversationBound: true,
        sessionKey: "user_c_loginhandoffchat",
        embedUrl: "/agent-computer/sessions/sess-handoff/novnc/vnc.html?autoconnect=1",
      }, 201)
    }
    if (path === "/agent-computer/login-handoff" && request.method() === "GET") {
      return fulfillJson(route, {
        active: handoffActive,
        conversationId: chat.id,
        site: "portal.example",
        title: "Inicia sesión en el equipo",
        neverSees: "SiraGPT no ve tu contraseña",
        ready: "Listo",
      })
    }
    if (path === "/agent-computer/login-handoff" && request.method() === "POST") {
      const body = request.postDataJSON() as { action?: string } | null
      if (body?.action === "ready") handoffActive = false
      return fulfillJson(route, { active: handoffActive, released: !handoffActive, conversationId: chat.id })
    }
    if (path === "/ai/generate" || path === "/chats" && request.method() === "POST") {
      chatBodies.push(request.postData() || "")
      return fulfillJson(route, { ok: true })
    }

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
  return { chatBodies, getHandoffActive: () => handoffActive }
}

test("web overlay shows login-handoff chrome and Sira never sees password copy", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await mockApi(page)
  await page.goto("/agentes?id=login-handoff-chat&computer=1&login=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const banner = page.getByTestId("computer-login-handoff-banner")
  await expect(banner).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("computer-login-handoff-privacy")).toContainText("SiraGPT no ve tu contraseña")
  await expect(page.getByTestId("computer-login-handoff-title")).toContainText("Inicia sesión en el equipo")
  await expect(page.getByTestId("computer-login-handoff-ready")).toHaveText("Listo")
  const box = await page.getByTestId("computer-login-handoff-ready").boundingBox()
  expect(box?.height || 0).toBeGreaterThanOrEqual(40)
  await page.getByTestId("computer-login-handoff-ready").click()
  await expect(banner).toHaveCount(0, { timeout: 10_000 })
  expect(captured.chatBodies.join("\n")).not.toMatch(/password\s*[:=]\s*\S+/i)
})

test("mobile viewport overlay is full-screen and usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockApi(page)
  await page.goto("/agentes?id=login-handoff-chat&computer=1&login=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const panel = page.getByTestId("chat-agent-computer-panel")
  await expect(panel).toBeVisible({ timeout: 60_000 })
  await expect(panel).toHaveAttribute("data-full-screen", "1")
  const banner = page.getByTestId("computer-login-handoff-banner")
  await expect(banner).toBeVisible()
  const ready = page.getByTestId("computer-login-handoff-ready")
  const box = await ready.boundingBox()
  expect(box?.height || 0).toBeGreaterThanOrEqual(44)
  expect(box?.width || 0).toBeGreaterThanOrEqual(44)
})

test("overlay auto-opens when login-handoff takeover becomes active (no login query)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await mockApi(page, { handoffActive: true })
  await page.goto("/agentes?id=login-handoff-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const banner = page.getByTestId("computer-login-handoff-banner")
  await expect(banner).toBeVisible({ timeout: 20_000 })
  const panel = page.getByTestId("chat-agent-computer-panel")
  await expect(panel).toHaveAttribute("data-login-handoff", "1")
  await expect(panel).toHaveAttribute("data-chat-computer-view", "expanded")
  await expect(panel).toHaveAttribute("data-user-typeable", "1")
  await expect(page.getByTestId("computer-login-handoff-title")).toContainText("Inicia sesión en el equipo")
  await expect(page.getByTestId("computer-login-handoff-privacy")).toContainText("SiraGPT no ve tu contraseña")
  await expect(page.getByTestId("chat-computer-live-desktop")).toBeVisible()
  await page.getByTestId("computer-login-handoff-ready").click()
  await expect(banner).toHaveCount(0, { timeout: 10_000 })
  expect(captured.getHandoffActive()).toBe(false)
  expect(captured.chatBodies.join("\n")).not.toMatch(/password\s*[:=]\s*\S+/i)
})

test("typed password is not posted to /api/chat after Listo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured: string[] = []
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (/\/(chat|ai\/generate|chats)/.test(path) && request.method() === "POST") {
      captured.push(request.postData() || "")
    }
    return route.fallback()
  })
  await mockApi(page)
  await page.goto("/agentes?id=login-handoff-chat&computer=1&login=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("computer-login-handoff-ready")).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("computer-login-handoff-ready").click()
  const dumped = captured.join("\n")
  expect(dumped).not.toContain("hunter2")
  expect(dumped).not.toMatch(/password\s*[:=]\s*[^"{\s]+/i)
})
