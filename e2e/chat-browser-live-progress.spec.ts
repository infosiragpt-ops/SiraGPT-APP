import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Live browser progress in the existing computer panel. APIs are stubbed.
 * Covers the activity chip (hidden / url-only / full / updates / host-only)
 * and auto-expand on agent navigate (once per chat, manual collapse wins).
 * Browser state and remote form data are explicit fixtures, not remote-pixel evidence.
 * Never captures credentials.
 */

test.describe.configure({ timeout: 240_000 })
test.use({ locale: "es-PE" })

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
  const navigated: string[] = []
  const websiteRequests: string[] = []
  const unexpected: string[] = []
  const pageErrors: string[] = []
  const sessionId = "sess-live"
  const tabId = "live-tab-1"
  let remotePage = { url: "about:blank", title: "Nueva pestaña", formDraft: "" }
  let presentation: "embedded" | "desktop" = "desktop"
  let viewport = { width: 1920, height: 1080 }
  const browser = () => ({
    tabs: [{ id: tabId, title: remotePage.title, url: remotePage.url }],
    activeTabId: tabId, canGoBack: false, canGoForward: false,
    presentation, viewport: { ...viewport },
  })
  const envelope = () => ({
    ok: true, browser: browser(), sessionId, userId: "user_c_liveprogresschat",
    conversationId: chat.id, conversationBound: true, sessionKey: "user_c_liveprogresschat",
  })
  const reject = (route: Route, description: string) => {
    unexpected.push(description)
    return fulfillJson(route, { ok: false, error: "unexpected_live_progress_fixture_request" }, 501)
  }
  const loadWebsite = (url: string, formDraft = "") => {
    websiteRequests.push(url)
    remotePage = { url, title: "Formulario QA", formDraft }
  }
  page.on("pageerror", (error) => pageErrors.push(error.name + ": " + error.message))

  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "live-progress-token")
    localStorage.setItem("currentChatId", "live-progress-chat")
    localStorage.setItem("siragpt.locale", "es")
    document.cookie = "NEXT_LOCALE=es; path=/; samesite=lax"
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
        models: [{ id: "m1", name: "Sira Rápido", displayName: "Sira Rápido", provider: "DeepSeek", type: "TEXT", isActive: true }],
      })
    }
    if (path === "/payments/subscription") {
      return fulfillJson(route, { plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100000 })
    }
    if (path === "/chats" && request.method() === "POST") return fulfillJson(route, { chat }, 201)
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
      const body = request.postDataJSON() as { conversationId?: string } | null
      if ((body?.conversationId || url.searchParams.get("conversationId")) !== chat.id) return reject(route, "session conversation mismatch")
      return fulfillJson(route, {
        ...envelope(),
        embedUrl: "/agent-computer/sessions/sess-live/novnc/vnc.html?autoconnect=1",
      }, 201)
    }
    if (path === `/agent-computer/sessions/${sessionId}` && request.method() === "GET") return fulfillJson(route, envelope())
    if (path === "/agent-computer/navigate" && request.method() === "POST") {
      const body = request.postDataJSON() as { url?: string; conversationId?: string; sessionId?: string; tabId?: string }
      if (body.conversationId !== chat.id || (body.sessionId !== undefined && body.sessionId !== sessionId)) return reject(route, "navigation owner mismatch")
      if ((body.tabId !== undefined && body.tabId !== tabId) || !body.url || !/^https?:\/\//.test(body.url)) return reject(route, "navigation target mismatch")
      navigated.push(body.url)
      loadWebsite(body.url)
      return fulfillJson(route, { ...envelope(), url: remotePage.url })
    }
    if (path === "/agent-computer/action" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        conversationId?: string; sessionId?: string; focus?: string;
        action?: { type?: string; tabId?: string; width?: number; height?: number }
      }
      if (body.conversationId !== chat.id || (body.sessionId !== undefined && body.sessionId !== sessionId)) return reject(route, "action owner mismatch")
      if (!body.action && ["browser", "chrome", "desktop", "files", "terminal"].includes(body.focus || "")) return fulfillJson(route, { ...envelope(), focus: body.focus })
      if (body.sessionId !== sessionId || !body.action || (body.action.tabId !== undefined && body.action.tabId !== tabId)) return reject(route, "browser action session or tab mismatch")
      switch (body.action.type) {
        case "browser_present": presentation = "embedded"; break
        case "browser_restore": presentation = "desktop"; break
        case "browser_resize":
          if (!Number.isInteger(body.action.width) || !Number.isInteger(body.action.height)
            || body.action.width! < 32 || body.action.width! > 1920 || body.action.height! < 32 || body.action.height! > 1080) return reject(route, "invalid browser viewport")
          viewport = { width: body.action.width!, height: body.action.height! }
          break
        default: return reject(route, `unsupported browser action: ${body.action.type}`)
      }
      return fulfillJson(route, envelope())
    }
    if (path === "/agent-computer/activity" && request.method() === "GET") {
      const conversationId = url.searchParams.get("conversationId")
      if (conversationId !== chat.id) return reject(route, "activity conversation mismatch")
      activityHits.push(conversationId)
      if (url.searchParams.get("browser") === "1") {
        if (url.searchParams.get("sessionId") !== sessionId) return reject(route, "browser activity session mismatch")
        return fulfillJson(route, envelope())
      }
      return fulfillJson(route, activity())
    }
    if (path === "/agent-computer/login-handoff") {
      if (url.searchParams.get("conversationId") !== chat.id) return reject(route, "handoff conversation mismatch")
      return fulfillJson(route, { active: false, conversationId: chat.id })
    }
    if (path.startsWith("/agent-computer/")) return reject(route, `unsupported computer endpoint: ${request.method()} ${path}`)

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
  const fixture = { activityHits, navigated, websiteRequests, unexpected, pageErrors,
    agentNavigate: loadWebsite, remotePage: () => ({ ...remotePage }), browser,
  }
  fixtures.set(page, fixture)
  return fixture
}

type ProgressFixture = Awaited<ReturnType<typeof mockApi>>
const fixtures = new WeakMap<Page, ProgressFixture>()
const address = (page: Page) => page.getByRole("textbox", { name: "Dirección del navegador", exact: true })
async function showDesktop(page: Page) {
  const desktop = page.getByTestId("agent-computer-dock-os").getByRole("button", { name: "Escritorio", exact: true })
  await desktop.click()
  await expect(desktop).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("chat-computer-collapse")).toBeVisible()
}
async function agentNavigate(page: Page, fixture: ProgressFixture, url: string, formDraft = "") {
  // The agent has already navigated remotely before its event reaches the UI.
  fixture.agentNavigate(url, formDraft)
  await page.evaluate((href) => window.dispatchEvent(new CustomEvent("siragpt:computer-navigate", {
    detail: { url: href, conversationId: "live-progress-chat", tool: "computer_navigate" },
  })), url)
}
async function openPanel(page: Page, mode: "computer" | "browser" = "computer") {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/agentes?id=live-progress-chat&${mode}=1`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  const panel = page.getByTestId("chat-agent-computer-panel")
  await expect(panel).toBeVisible({ timeout: 60_000 })
  if (mode === "computer") {
    await page.getByTestId("chat-computer-expand").click()
    await showDesktop(page)
  } else {
    await expect(page.getByRole("tab", { selected: true })).toHaveCount(1)
  }
  await expect(panel).toHaveAttribute("data-chat-computer-view", "expanded")
  return panel
}

test.afterEach(async ({ page }) => {
  const fixture = fixtures.get(page)
  expect(fixture?.unexpected || []).toEqual([])
  expect(fixture?.pageErrors || []).toEqual([])
})

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
  await expect(chip).toContainText("Navegador")
  await expect(chip).toContainText("www.ejemplo.com")
  await expect(chip).toContainText("clic")
  await expect(chip).toContainText("paso 3")
})

test("chip shows url-only progress", async ({ page }) => {
  await mockApi(page, () => ({ activity: null, url: "https://google.com/", title: "" }))
  await openPanel(page)
  const chip = page.getByTestId("chat-computer-activity")
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip).toContainText("Navegador")
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
  const fixture = await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  const panel = await openPanel(page, "browser")
  await page.getByRole("button", { name: "Cerrar navegador", exact: true }).click()
  await expect(panel).toHaveCount(0)
  await agentNavigate(page, fixture, "https://www.ejemplo.com/form")
  await expect(panel).toHaveAttribute("data-chat-computer-view", "expanded", { timeout: 30_000 })
  await expect(page.getByTestId("chat-computer-live-desktop")).toBeVisible({ timeout: 30_000 })
  await expect(address(page)).toHaveValue("https://www.ejemplo.com/form")
  expect(fixture.navigated).toEqual([])
})

test("manual collapse wins over later navigates", async ({ page }) => {
  const fixture = await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  const panel = await openPanel(page, "browser")
  await agentNavigate(page, fixture, "https://www.ejemplo.com/a")
  await expect(address(page)).toHaveValue("https://www.ejemplo.com/a")
  await expect(panel).toHaveAttribute("data-chat-computer-view", "expanded", { timeout: 30_000 })
  // Collapse belongs to the existing desktop mode, not the clean browser bar.
  await showDesktop(page)
  await page.getByTestId("chat-computer-collapse").click()
  await expect(panel).toHaveAttribute("data-chat-computer-view", "compact", { timeout: 30_000 })
  await agentNavigate(page, fixture, "https://www.ejemplo.com/b")
  await expect(address(page)).toHaveValue("https://www.ejemplo.com/b")
  await page.waitForTimeout(2_000)
  await expect(panel).toHaveAttribute("data-chat-computer-view", "compact")
  expect(fixture.navigated).toEqual([])
})

test("agent navigation and collapsing never replay a website request", async ({ page }) => {
  const fixture = await mockApi(page, () => ({ activity: null, url: null, title: "" }))
  await openPanel(page, "browser")
  await expect(page.getByTestId("browser-empty-state")).toBeVisible()
  await expect(address(page)).toHaveValue("")
  expect(fixture.navigated).toEqual([])
  expect(fixture.websiteRequests).toEqual([])
  await agentNavigate(page, fixture, "https://example.com/filled-form", "Respuesta sin enviar")
  await expect(address(page)).toHaveValue("https://example.com/filled-form")
  const before = fixture.websiteRequests.length
  await showDesktop(page)
  await page.getByTestId("chat-computer-collapse").click()
  await page.getByTestId("chat-computer-expand").click()
  await expect(page.getByTestId("chat-computer-live-desktop")).toBeVisible()
  await expect(address(page)).toHaveValue("https://example.com/filled-form")
  expect(fixture.remotePage().formDraft).toBe("Respuesta sin enviar")
  expect(fixture.websiteRequests.length).toBe(before)
  expect(fixture.navigated).toEqual([])
})

test("finished activity clears stale site and step", async ({ page }) => {
  let active = true
  await mockApi(page, () => active ? { activity: { step: 3, lastAction: "computer_click", lastUrl: "https://example.com" }, url: "https://example.com", title: "" } : { activity: null, url: null, title: "" })
  await openPanel(page)
  await expect(page.getByTestId("chat-computer-activity")).toContainText("paso 3")
  active = false
  await expect(page.getByTestId("chat-computer-activity")).toHaveCount(0, { timeout: 15000 })
})
