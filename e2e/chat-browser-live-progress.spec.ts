import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Live browser progress (Claude-style side panel). APIs are stubbed.
 * Covers the activity chip (hidden / url-only / full / updates / host-only)
 * and auto-expand on agent navigate (once per chat, manual collapse wins).
 * Never captures credentials.
 */

test.describe.configure({ timeout: 240_000 })

const user = {
  id: "live-progress-user",
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
  id: "live-progress-chat",
  title: "Progreso QA",
  model: "deepseek-v4-flash",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  messages: [] as unknown[],
}

type ActivityState = {
  activity: { step: number; lastAction: string; lastUrl: string } | null
  url: string | null
  title: string
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function mockApi(page: Page, activity: () => ActivityState) {
  const activityHits: string[] = []

  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "live-progress-token")
    localStorage.setItem("currentChatId", "live-progress-chat")
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
    if (path === "/desktop/status") {
      return fulfillJson(route, { enabled: true, poolWarm: 1 })
    }
    if (path === "/desktop/sessions") {
      return fulfillJson(route, { error: "prefer_agent_computer" }, 503)
    }
    if (path === "/agent-computer/sessions" && request.method() === "POST") {
      return fulfillJson(route, {
        sessionId: "sess-live",
        userId: "user_c_liveprogresschat",
        conversationId: chat.id,
        conversationBound: true,
        sessionKey: "user_c_liveprogresschat",
        embedUrl: "/agent-computer/sessions/sess-live/novnc/vnc.html?autoconnect=1",
      }, 201)
    }
    if (path === "/agent-computer/navigate" && request.method() === "POST") {
      const body = (request.postDataJSON() || {}) as { url?: string }
      return fulfillJson(route, { ok: true, url: body.url, conversationId: chat.id })
    }
    if (path === "/agent-computer/action" && request.method() === "POST") {
      return fulfillJson(route, { ok: true })
    }
    if (path === "/agent-computer/activity" && request.method() === "GET") {
      activityHits.push(url.searchParams.get("conversationId") || "")
      return fulfillJson(route, activity())
    }
    if (path === "/agent-computer/login-handoff") {
      return fulfillJson(route, { active: false, conversationId: chat.id })
    }

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
  return { activityHits }
}

async function openPanel(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/agentes?id=live-progress-chat&browser=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const panel = page.getByTestId("chat-agent-computer-panel")
  await expect(panel).toBeVisible({ timeout: 60_000 })
  await expect(panel).toHaveAttribute("data-chat-computer-view", "compact")
  return panel
}

test("chip stays hidden without progress", async ({ page }) => {
  await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  await openPanel(page)
  await expect(page.getByTestId("chat-computer-activity")).toHaveCount(0)
})

test("chip shows full live progress", async ({ page }) => {
  await mockApi(page, () => ({
    activity: { step: 3, lastAction: "computer_click", lastUrl: "https://www.ejemplo.com/form" },
    url: "https://www.ejemplo.com/form",
    title: "Formulario",
  }))
  await openPanel(page)
  const chip = page.getByTestId("chat-computer-activity")
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip).toContainText("En vivo")
  await expect(chip).toContainText("www.ejemplo.com")
  await expect(chip).toContainText("clic")
  await expect(chip).toContainText("paso 3")
})

test("chip shows url-only progress", async ({ page }) => {
  await mockApi(page, () => ({ activity: null, url: "https://google.com/", title: "" }))
  await openPanel(page)
  const chip = page.getByTestId("chat-computer-activity")
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip).toContainText("En vivo")
  await expect(chip).toContainText("google.com")
})

test("chip shows host only for long urls", async ({ page }) => {
  await mockApi(page, () => ({
    activity: { step: 7, lastAction: "computer_type", lastUrl: "https://www.ejemplo.com/tramite/paso/2?folio=abc123&x=1" },
    url: "https://www.ejemplo.com/tramite/paso/2?folio=abc123&x=1",
    title: "",
  }))
  await openPanel(page)
  const chip = page.getByTestId("chat-computer-activity")
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip).toContainText("www.ejemplo.com")
  await expect(chip).not.toContainText("folio")
})

test("chip labels scroll and keypress actions", async ({ page }) => {
  let action = "computer_scroll"
  await mockApi(page, () => ({
    activity: { step: 2, lastAction: action, lastUrl: "https://www.ejemplo.com/largo" },
    url: "https://www.ejemplo.com/largo",
    title: "",
  }))
  await openPanel(page)
  const chip = page.getByTestId("chat-computer-activity")
  await expect(chip).toContainText("desplazando", { timeout: 30_000 })
  // Next 4s poll picks up the new action from the mocked endpoint.
  action = "computer_keypress"
  await expect(chip).toContainText("tecla", { timeout: 30_000 })
})

test("panel polls the activity endpoint per chat", async ({ page }) => {
  const { activityHits } = await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  await openPanel(page)
  await expect.poll(() => activityHits.length, { timeout: 30_000 }).toBeGreaterThan(0)
  expect(activityHits.every((id) => id === "live-progress-chat")).toBe(true)
})

test("agent navigate auto-expands the panel once", async ({ page }) => {
  await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  const panel = await openPanel(page)
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("siragpt:computer-navigate", {
        detail: { url: "https://www.ejemplo.com/form", conversationId: "live-progress-chat" },
      })
    )
  })
  await expect(panel).toHaveAttribute("data-chat-computer-view", "expanded", { timeout: 30_000 })
  await expect(page.getByTestId("chat-computer-live-desktop")).toBeVisible({ timeout: 30_000 })
})

test("manual collapse wins over later navigates", async ({ page }) => {
  await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  const panel = await openPanel(page)
  const navigate = (url: string) =>
    page.evaluate((href) => {
      window.dispatchEvent(
        new CustomEvent("siragpt:computer-navigate", {
          detail: { url: href, conversationId: "live-progress-chat" },
        })
      )
    }, url)
  await navigate("https://www.ejemplo.com/a")
  await expect(panel).toHaveAttribute("data-chat-computer-view", "expanded", { timeout: 30_000 })
  await page.getByTestId("chat-computer-collapse").click()
  await expect(panel).toHaveAttribute("data-chat-computer-view", "compact", { timeout: 30_000 })
  await navigate("https://www.ejemplo.com/b")
  await page.waitForTimeout(2_000)
  await expect(panel).toHaveAttribute("data-chat-computer-view", "compact")
})
