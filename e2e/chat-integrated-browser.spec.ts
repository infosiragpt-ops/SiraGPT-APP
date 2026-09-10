import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Integrated navigator beside the computer. APIs are stubbed.
 * Never captures credentials. Covers header globe, address bar, and navigate.
 */

test.describe.configure({ timeout: 240_000 })

const user = {
  id: "browser-user",
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
  id: "browser-chat",
  title: "Navegador QA",
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

async function mockApi(page: Page) {
  const navigated: string[] = []

  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "browser-token")
    localStorage.setItem("currentChatId", "browser-chat")
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
        sessionId: "sess-browser",
        userId: "user_c_browserchat",
        conversationId: chat.id,
        conversationBound: true,
        sessionKey: "user_c_browserchat",
        embedUrl: "/agent-computer/sessions/sess-browser/novnc/vnc.html?autoconnect=1",
      }, 201)
    }
    if (path === "/agent-computer/navigate" && request.method() === "POST") {
      const body = (request.postDataJSON() || {}) as { url?: string; conversationId?: string }
      navigated.push(String(body.url || ""))
      return fulfillJson(route, { ok: true, url: body.url, conversationId: body.conversationId || chat.id })
    }
    if (path === "/agent-computer/action" && request.method() === "POST") {
      return fulfillJson(route, { ok: true })
    }
    if (path === "/agent-computer/login-handoff") {
      return fulfillJson(route, { active: false, conversationId: chat.id })
    }

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
  return { navigated }
}

test("globe beside the computer opens the integrated navigator", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await mockApi(page)
  await page.goto("/agentes?id=browser-chat&browser=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const panel = page.getByTestId("chat-agent-computer-panel")
  await expect(panel).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("chat-browser-button")).toBeVisible()
  const bar = page.getByTestId("integrated-browser-bar").first()
  await expect(bar).toBeVisible()
  await page.getByTestId("integrated-browser-url").first().fill("https://id.elsevier.com")
  await page.getByTestId("integrated-browser-go").first().click()
  await expect.poll(() => captured.navigated.join("\n")).toContain("https://id.elsevier.com/")
})

test("javascript URLs never reach navigate", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await mockApi(page)
  await page.goto("/agentes?id=browser-chat&browser=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("integrated-browser-bar").first()).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("integrated-browser-url").first().fill("javascript:alert(1)")
  await page.getByTestId("integrated-browser-go").first().click()
  expect(captured.navigated.join("\n")).not.toMatch(/javascript:/i)
})
