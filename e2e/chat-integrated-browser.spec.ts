import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { mkdir } from "node:fs/promises"

/**
 * Integrated navigator beside the computer. APIs are stubbed.
 * LOCAL frontend evidence only; remote pixels/CDP are verified separately in
 * e2e/browser-live-desktop.cjs. No real credentials or production calls.
 */

test.describe.configure({ timeout: 120_000 })
test.use({ locale: "es-PE" })

const user = {
  id: "browser-user",
  name: "Usuario de prueba",
  email: "browser@example.test",
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

const sessionId = "sess-browser-fixture"
const siteA = "https://example.com/a"
const siteB = "https://example.com/b"
const siteC = "https://example.com/c"
type TabFixture = { id: string; history: string[]; index: number }
type BrowserAction = { type: string; tabId?: string; width?: number; height?: number }
function titleFor(url: string): string {
  if (url === "about:blank") return "Nueva pestaña"
  if (url === "https://www.google.com/") return "Google"
  if (url === "https://www.google.com/search?q=google") return "google - Buscar con Google"
  if (url === siteA) return "Página A"
  if (url === siteB) return "Página B"
  if (url === siteC) return "Página C"
  return "Inicio QA"
}

async function mockApi(page: Page, { home = false, initialUrl = "https://www.google.com/" }: { home?: boolean; initialUrl?: string } = {}) {
  const conversationId = home ? null : chat.id
  const ownsConversation = (value: unknown) => home ? value == null || value === "" : value === chat.id
  const tabs: TabFixture[] = [{ id: "fixture-tab-1", history: [home ? "about:blank" : initialUrl], index: 0 }]
  let nextId = 2
  let activeTabId = tabs[0].id
  let presentation: "embedded" | "desktop" = "desktop"
  let viewport = { width: 1920, height: 1080 }
  let chatPosts = 0
  let failNextNavigate = false
  let navigationGate: Promise<void> | null = null
  let release: (() => void) | null = null
  let activityReads = 0
  let sessionPosts = 0
  const navigated: string[] = []
  const actions: BrowserAction[] = []
  const unexpected: string[] = []
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.name + ": " + error.message))
  const active = () => tabs.find((tab) => tab.id === activeTabId)!
  const currentUrl = (tab = active()) => tab.history[tab.index]
  const createTab = () => {
    const tab = { id: `fixture-tab-${nextId++}`, history: ["about:blank"], index: 0 }
    tabs.push(tab)
    activeTabId = tab.id
  }
  const state = () => ({
    tabs: tabs.map((tab) => ({ id: tab.id, title: titleFor(currentUrl(tab)), url: currentUrl(tab) })),
    activeTabId, canGoBack: active().index > 0,
    canGoForward: active().index < active().history.length - 1,
    presentation, viewport: { ...viewport },
  })
  const envelope = () => ({
    ok: true, browser: state(), sessionId, conversationId, userId: user.id,
    conversationBound: !home, sessionKey: home ? "browser-user" : "browser-user_c_browser-chat",
  })
  const reject = async (route: Route, description: string) => {
    unexpected.push(description)
    return fulfillJson(route, { ok: false, error: "unexpected_frontend_fixture_request" }, 501)
  }
  await page.addInitScript(({ home }) => {
    localStorage.setItem("auth-token", "local-browser-fixture-not-a-credential")
    if (!home) localStorage.setItem("currentChatId", "browser-chat")
    localStorage.setItem("siragpt.locale", "es")
    document.cookie = "NEXT_LOCALE=es; path=/; samesite=lax"
  }, { home })
  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")
    const method = request.method()
    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && method === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: [{
      id: "m1", name: "Sira Rápido", displayName: "Sira Rápido", provider: "DeepSeek", type: "TEXT", isActive: true,
    }] })
    if (path === "/payments/subscription") return fulfillJson(route, { plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    if (path === "/chats" && method === "POST") {
      chatPosts++
      if (home) return reject(route, "opening the home browser must not create a chat")
      return fulfillJson(route, { chat }, 201)
    }
    if (path === "/chats" && method === "GET") return fulfillJson(route, { chats: home ? [] : [chat], pagination: { page: 1, limit: 20, total: home ? 0 : 1, pages: home ? 0 : 1 } })
    if (path === `/chats/${chat.id}`) return fulfillJson(route, { chat })
    if (path === "/desktop/status") return fulfillJson(route, { enabled: true, poolWarm: 1 })
    if (path === "/desktop/sessions") return fulfillJson(route, { error: "prefer_agent_computer" }, 503)
    if (path === "/agent-computer/sessions" && method === "POST") {
      const body = request.postDataJSON() as { conversationId?: string } | null
      if (!ownsConversation(body?.conversationId || url.searchParams.get("conversationId"))) return reject(route, "session owner mismatch")
      sessionPosts++
      return fulfillJson(route, { ...envelope(), userId: user.id,
        embedUrl: "/sessions/sess-browser-fixture/novnc/vnc.html?autoconnect=1",
      }, 201)
    }
    if (path === `/agent-computer/sessions/${sessionId}` && method === "GET") return fulfillJson(route, envelope())
    if (path === "/agent-computer/activity" && method === "GET") {
      if (!ownsConversation(url.searchParams.get("conversationId"))) return reject(route, "activity owner mismatch")
      if (url.searchParams.get("browser") === "1") {
        if (url.searchParams.get("sessionId") !== sessionId) return reject(route, "browser activity requires owned session")
        activityReads++
        return fulfillJson(route, envelope())
      }
      return fulfillJson(route, { activity: null, url: currentUrl(), title: titleFor(currentUrl()) })
    }
    if (path === "/agent-computer/navigate" && method === "POST") {
      const body = request.postDataJSON() as { url?: string; conversationId?: string; tabId?: string; sessionId?: string }
      if (body.sessionId !== sessionId) return reject(route, "navigation must reuse the owned session")
      if (!ownsConversation(body.conversationId)) return reject(route, "navigate owner mismatch")
      const tab = body.tabId ? tabs.find((item) => item.id === body.tabId) : active()
      if (!tab || !body.url || !/^https?:\/\//.test(body.url)) return reject(route, "invalid navigation target")
      navigated.push(body.url)
      if (navigationGate) await navigationGate
      if (failNextNavigate) {
        failNextNavigate = false
        return route.fulfill({ status: 502, contentType: "text/html", body: "<!doctype html><title>Local fixture failure</title><p>Upstream unavailable</p>" })
      }
      if (currentUrl(tab) !== body.url) {
        tab.history.splice(tab.index + 1)
        tab.history.push(body.url)
        tab.index++
      }
      activeTabId = tab.id
      return fulfillJson(route, { ...envelope(), url: currentUrl() })
    }
    if (path === "/agent-computer/action" && method === "POST") {
      const body = request.postDataJSON() as { sessionId?: string; conversationId?: string; focus?: string; action?: BrowserAction }
      if (!ownsConversation(body.conversationId)) return reject(route, "action owner mismatch")
      if (!body.action && ["browser", "chrome", "desktop", "terminal", "files"].includes(body.focus || "")) return fulfillJson(route, { ok: true })
      if (body.sessionId !== sessionId || !body.action) return reject(route, "browser action requires owned session")
      const action = body.action
      const selected = action.tabId ? tabs.find((tab) => tab.id === action.tabId) : active()
      actions.push(action)
      switch (action.type) {
        case "browser_tab_create": createTab(); break
        case "browser_tab_select":
          if (!selected || !action.tabId) return reject(route, "select unknown tab")
          activeTabId = selected.id
          break
        case "browser_tab_close": {
          if (!selected || !action.tabId) return reject(route, "close unknown tab")
          const index = tabs.indexOf(selected)
          // Production keeps a real blank replacement before closing the last
          // target: frontend empty state never means losing Chrome/CDP.
          if (tabs.length === 1) createTab()
          tabs.splice(index, 1)
          if (activeTabId === selected.id) activeTabId = tabs[Math.min(index, tabs.length - 1)].id
          break
        }
        case "browser_back": if (active().index > 0) active().index--; break
        case "browser_forward": if (active().index < active().history.length - 1) active().index++; break
        case "browser_reload": break
        case "browser_present": presentation = "embedded"; break
        case "browser_restore": presentation = "desktop"; break
        case "browser_resize":
          if (!Number.isInteger(action.width) || !Number.isInteger(action.height)
            || action.width! < 32 || action.width! > 1920 || action.height! < 32 || action.height! > 1080) {
            return reject(route, "resize requires bounded integer CSS dimensions")
          }
          viewport = { width: action.width!, height: action.height! }
          break
        default: return reject(route, `unknown browser action: ${action.type}`)
      }
      return fulfillJson(route, envelope())
    }
    if (path === "/agent-computer/login-handoff") return fulfillJson(route, { active: false, conversationId })
    if (path.startsWith("/agent-computer/")) return reject(route, `unsupported browser endpoint: ${method} ${path}`)
    // Unrelated application shell APIs are outside this browser fixture.
    return fulfillJson(route, {})
  }
  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
  const fixture = {
    navigated, actions, unexpected, pageErrors, state,
    getActivityReads: () => activityReads,
    getSessionPosts: () => sessionPosts,
    getChatPosts: () => chatPosts,
    failNavigation: () => { failNextNavigate = true },
    holdNavigation: () => { navigationGate = new Promise<void>((resolve) => { release = resolve }) },
    releaseNavigation: () => { release?.(); release = null; navigationGate = null },
  }
  fixtures.set(page, fixture)
  return fixture
}

type BrowserFixture = Awaited<ReturnType<typeof mockApi>>
const fixtures = new WeakMap<Page, BrowserFixture>()
const address = (page: Page) => page.getByRole("textbox", { name: "Dirección del navegador", exact: true })
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true })
async function screenshot(page: Page, name: string) {
  if (process.env.CI) return
  await mkdir("output", { recursive: true })
  await page.screenshot({ path: `output/local-browser-${name}.png`, fullPage: false })
}
async function openPanel(page: Page, viewport = { width: 1280, height: 800 }, { home = false }: { home?: boolean } = {}) {
  await page.setViewportSize(viewport)
  await page.goto(home ? "/agentes?browser=1" : "/agentes?id=browser-chat&browser=1", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-agent-computer-panel")).toBeVisible({ timeout: 60_000 })
  await expect(address(page)).toHaveCount(1)
  await expect(page.getByRole("tablist", { name: "Pestañas del navegador", exact: true })).toHaveCount(1)
  await expect.poll(() => fixtures.get(page)!.getActivityReads()).toBeGreaterThan(0)
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1)
}
async function navigate(page: Page, url: string) {
  await address(page).fill(url)
  await address(page).press("Enter")
  await expect.poll(() => fixtures.get(page)!.state().tabs.find((tab) => tab.id === fixtures.get(page)!.state().activeTabId)?.url).toBe(url)
  await expect(address(page)).toHaveValue(url)
  await expect(page.getByRole("tab", { selected: true })).toContainText(titleFor(url))
}
async function assertInsideViewport(page: Page, control: Locator) {
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  const viewport = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
}
async function assertViewportMatchesHost(page: Page, fixture: BrowserFixture) {
  const box = await page.getByTestId("browser-viewport").boundingBox()
  expect(box).not.toBeNull()
  const scale = Math.min(1, 1920 / box!.width, 1080 / box!.height)
  const expected = { width: Math.max(32, Math.floor(box!.width * scale)), height: Math.max(32, Math.floor(box!.height * scale)) }
  await expect.poll(() => fixture.state().viewport).toEqual(expected)
  expect(fixture.actions.filter((action) => action.type === "browser_resize").at(-1)).toMatchObject(expected)
}

type SafeUiPhase =
  | "home_open" | "home_empty" | "home_create_tab" | "home_focus" | "home_focus_style"
  | "home_focus_dark_border" | "home_focus_light_border" | "home_focus_outline"
  | "home_focus_inactive" | "home_focus_token_missing" | "home_focus_rule_missing" | "home_focus_rule_unreadable"
  | "home_focus_color_unparsed" | "home_focus_neutral" | "home_focus_color_notblue" | "home_focus_border_zero"
  | "keyboard_tab_focus" | "keyboard_tab_focus_lost" | "keyboard_tab_indicator_missing"
  | "keyboard_close_focus" | "keyboard_close_focus_lost" | "keyboard_close_indicator_missing" | "keyboard_focus_style"
  | "home_navigate" | "home_viewport" | "home_no_chat" | "home_same_session"
  | "home_url_owner" | "home_storage_owner" | "fixture_requests" | "frontend_exceptions"

function safeUiPhase(phase: SafeUiPhase) {
  const annotations = test.info().annotations
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    if (annotations[index].type === "sira_safe_ui_phase") annotations.splice(index, 1)
  }
  annotations.push({ type: "sira_safe_ui_phase", description: phase })
}

async function assertFocusedAddressStyle(page: Page) {
  safeUiPhase("home_focus_style")
  await expect.poll(async () => {
    const state = await address(page).evaluate((element) => {
      const style = getComputedStyle(element)
      const channels = style.borderTopColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      let focusRule = false
      let rulesReadable = true
      // Inspect only whether the owned focus declaration exists. CSS text and
      // custom-property values never leave this browser evaluation.
      const inspectRules = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule
            && rule.selectorText.split(",").some((selector) => selector.trim() === "input.sira-browser-address:focus")
            && rule.style.getPropertyValue("border-color")) focusRule = true
          if ("cssRules" in rule) inspectRules((rule as CSSGroupingRule).cssRules)
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try { inspectRules(sheet.cssRules) } catch { rulesReadable = false }
      }
      return {
        blueBorder: !!channels && Number(channels[1]) < 60 && Number(channels[2]) > 100
          && Number(channels[3]) > 150 && parseFloat(style.borderTopWidth) > 0,
        noOutline: style.outlineStyle === "none",
        active: document.activeElement === element,
        tokenPresent: style.getPropertyValue("--celeste").trim().length > 0,
        focusRule,
        rulesReadable,
        colorParsed: !!channels,
        neutralColor: !!channels && channels[1] === channels[2] && channels[2] === channels[3],
        positiveBorder: parseFloat(style.borderTopWidth) > 0,
      }
    })
    safeUiPhase(!state.blueBorder
      ? (!state.active ? "home_focus_inactive"
        : !state.tokenPresent ? "home_focus_token_missing"
        : !state.focusRule ? (state.rulesReadable ? "home_focus_rule_missing" : "home_focus_rule_unreadable")
        : !state.colorParsed ? "home_focus_color_unparsed"
        : !state.positiveBorder ? "home_focus_border_zero"
        : state.neutralColor ? "home_focus_neutral" : "home_focus_color_notblue")
      : (!state.noOutline ? "home_focus_outline" : "home_focus_style"))
    return { blueBorder: state.blueBorder, outline: state.noOutline ? "none" : "present" }
  }, { message: "The focused omnibox must render a blue border without the browser's second outline" }).toEqual({ blueBorder: true, outline: "none" })
}

async function assertKeyboardFocusIndicator(control: Locator, kind: "tab" | "close") {
  await expect.poll(async () => {
    const state = await control.evaluate((element) => ({
      active: document.activeElement === element,
      hasIndicator: getComputedStyle(element).boxShadow !== "none",
    }))
    safeUiPhase(!state.active
      ? (kind === "tab" ? "keyboard_tab_focus_lost" : "keyboard_close_focus_lost")
      : !state.hasIndicator
        ? (kind === "tab" ? "keyboard_tab_indicator_missing" : "keyboard_close_indicator_missing")
        : "keyboard_focus_style")
    return state.hasIndicator
  }).toBe(true)
}

test.beforeEach(() => {
  test.info().annotations.push({ type: "evidence", description: "LOCAL rendered frontend, API fixture; remote Chrome/X11 is a separate real gate" })
})
test.afterEach(async ({ page }) => {
  const fixture = fixtures.get(page)
  fixture?.releaseNavigation()
  if (fixture?.unexpected.length) safeUiPhase("fixture_requests")
  expect(fixture?.unexpected || [], "Unsupported browser requests must fail the fixture").toEqual([])
  if (fixture?.pageErrors.length) safeUiPhase("frontend_exceptions")
  expect(fixture?.pageErrors || [], "No frontend runtime exception").toEqual([])
})

test("browser navigation controls are accessible and unique", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page)
  expect(fixture.navigated, "Opening preserves the existing page without a forced navigation").toEqual([])
  for (const name of ["Atrás", "Adelante", "Recargar página", "Nueva pestaña", "Cerrar navegador"]) {
    await expect(button(page, name)).toHaveCount(1)
    await expect(button(page, name)).toBeVisible()
  }
  await expect(page.getByTestId("integrated-browser-bar")).toHaveCount(1)
  await navigate(page, siteA)
  const navigations = [...fixture.navigated]
  await button(page, "Cerrar navegador").click()
  await expect(page.getByTestId("chat-agent-computer-panel")).toHaveCount(0)
  await page.getByTestId("chat-browser-button").click()
  await expect(address(page)).toHaveCount(1)
  await expect(address(page)).toHaveValue(siteA)
  await expect(page.getByRole("tab", { selected: true })).toContainText("Página A")
  expect(fixture.navigated, "Reopening preserves the current target without replaying navigation").toEqual(navigations)
  await screenshot(page, "desktop")
})
test("tabs create, select and close without losing the session; last tab becomes a real blank target", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page)
  await navigate(page, siteA)
  await button(page, "Nueva pestaña").click()
  await expect(page.getByRole("tab")).toHaveCount(2)
  await expect(page.getByTestId("browser-empty-state")).toBeVisible()
  await navigate(page, siteB)
  await page.getByRole("tab", { name: "Página A", exact: true }).click()
  await expect(address(page)).toHaveValue(siteA)
  await button(page, "Cerrar pestaña Página B").click()
  await expect(page.getByRole("tab")).toHaveCount(1)
  await expect(address(page)).toHaveValue(siteA)
  const sessionCount = fixture.getSessionPosts()
  await button(page, "Cerrar pestaña Página A").click()
  await expect(page.getByRole("tab")).toHaveCount(1)
  await expect(page.getByRole("tab", { selected: true })).toContainText("Nueva pestaña")
  await expect(page.getByTestId("browser-empty-state")).toContainText("Navega con SiraGPT")
  expect(fixture.state().tabs[0].url).toBe("about:blank")
  expect(fixture.getSessionPosts()).toBe(sessionCount)
  await screenshot(page, "empty-desktop")
  await button(page, "Maximizar navegador").click()
  await expect(button(page, "Restaurar navegador")).toBeVisible()
  const expanded = await page.getByTestId("chat-agent-computer-panel").boundingBox()
  expect(expanded!.width).toBeGreaterThan(1000)
  await screenshot(page, "empty-maximized")
  await button(page, "Restaurar navegador").click()
  await expect(button(page, "Maximizar navegador")).toBeVisible()
  expect(fixture.getSessionPosts()).toBe(sessionCount)
})
test("back, forward and reload follow confirmed tab history", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page)
  await navigate(page, siteA)
  await navigate(page, siteB)
  await expect(button(page, "Adelante")).toBeDisabled()
  await button(page, "Atrás").click()
  await expect(address(page)).toHaveValue(siteA)
  await expect(page.getByRole("tab", { selected: true })).toContainText("Página A")
  await button(page, "Adelante").click()
  await expect(address(page)).toHaveValue(siteB)
  const target = fixture.state().activeTabId
  await button(page, "Recargar página").click()
  await expect.poll(() => fixture.actions.filter((action) => action.type === "browser_reload").length).toBe(1)
  expect(fixture.state().activeTabId).toBe(target)
  await expect(address(page)).toHaveValue(siteB)
  await expect(button(page, "Adelante")).toBeDisabled()
})
test("focused URL draft survives activity polling and navigates only on Enter", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page)
  await navigate(page, siteA)
  const before = fixture.navigated.length
  const reads = fixture.getActivityReads()
  await address(page).fill(siteC)
  await expect(address(page)).toBeFocused()
  await expect.poll(() => fixture.getActivityReads(), { timeout: 15_000 }).toBeGreaterThan(reads)
  await expect(address(page)).toHaveValue(siteC)
  expect(fixture.navigated.length).toBe(before)
  await address(page).press("Enter")
  await expect(page.getByRole("tab", { selected: true })).toContainText("Página C")
})
test("a delayed navigation and HTML 502 never claim a new page or strand controls", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page)
  await navigate(page, siteA)
  fixture.holdNavigation()
  fixture.failNavigation()
  await address(page).fill(siteB)
  await address(page).press("Enter")
  await expect.poll(() => fixture.navigated.at(-1)).toBe(siteB)
  await expect(page.getByRole("tab", { selected: true })).toContainText("Página A")
  expect(fixture.state().tabs.find((tab) => tab.id === fixture.state().activeTabId)?.url).toBe(siteA)
  await expect(page.getByRole("status").filter({ hasText: "Abriendo página" })).toHaveCount(1)
  await expect(button(page, "Recargar página")).toBeDisabled()
  await screenshot(page, "loading-local")
  fixture.releaseNavigation()
  await expect(page.getByTestId("browser-error")).toBeVisible()
  await expect(page.getByTestId("browser-error")).toHaveAttribute("role", "alert")
  await expect(page.getByRole("tab", { selected: true })).toContainText("Página A")
  await expect(page.getByTestId("browser-error")).not.toContainText("<!doctype")
  await screenshot(page, "error-local")
  await navigate(page, siteB)
  await expect(page.getByTestId("browser-error")).toHaveCount(0)
})
test("javascript URLs never reach navigate", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page)
  const before = fixture.navigated.length
  await address(page).fill("javascript:alert(1)")
  await address(page).press("Enter")
  await expect(page.getByTestId("browser-error")).toBeVisible()
  expect(fixture.navigated.length).toBe(before)
  expect(fixture.navigated.join("\n")).not.toMatch(/javascript:/i)
})
test("mobile 390x844 keeps one usable omnibox and browser controls inside the screen", async ({ page }) => {
  const fixture = await mockApi(page)
  await openPanel(page, { width: 390, height: 844 })
  await assertViewportMatchesHost(page, fixture)
  await navigate(page, siteA)
  await assertInsideViewport(page, address(page))
  for (const name of ["Atrás", "Adelante", "Recargar página", "Nueva pestaña", "Cerrar navegador"]) {
    await assertInsideViewport(page, button(page, name))
  }
  const size = await address(page).boundingBox()
  expect(size!.width).toBeGreaterThanOrEqual(100)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await screenshot(page, "mobile")
  await button(page, "Cerrar pestaña Página A").click()
  await expect(page.getByTestId("browser-empty-state")).toBeVisible()
  await assertInsideViewport(page, page.getByTestId("browser-empty-state"))
  await screenshot(page, "empty-mobile")
  const mobileViewport = fixture.state().viewport
  await page.setViewportSize({ width: 430, height: 900 })
  await expect.poll(() => fixture.state().viewport).not.toEqual(mobileViewport)
  await assertViewportMatchesHost(page, fixture)
  const restored = fixture.actions.filter((action) => action.type === "browser_restore").length
  await button(page, "Cerrar navegador").click()
  await expect(page.getByTestId("chat-agent-computer-panel")).toHaveCount(0)
  await expect.poll(() => fixture.actions.filter((action) => action.type === "browser_restore").length).toBeGreaterThan(restored)
})


test("keyboard tab navigation moves selection and focus together", async ({ page }) => {
  await mockApi(page)
  await openPanel(page)
  await navigate(page, siteA)
  await button(page, "Nueva pestaña").click()
  await navigate(page, siteB)
  const first = page.getByRole("tab", { name: "Página A", exact: true })
  const second = page.getByRole("tab", { name: "Página B", exact: true })
  await first.click()
  await expect(first).toHaveAttribute("aria-selected", "true")
  await first.focus()
  await first.press("ArrowRight")
  await expect(second).toHaveAttribute("aria-selected", "true")
  safeUiPhase("keyboard_tab_focus")
  await expect(second).toBeFocused()
  await assertKeyboardFocusIndicator(second, "tab")
  await second.press("Home")
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(first).toBeFocused()
  await first.press("Tab")
  const close = button(page, "Cerrar pestaña Página A")
  safeUiPhase("keyboard_close_focus")
  await expect(close).toBeFocused()
  await assertKeyboardFocusIndicator(close, "close")
  await expect(address(page)).toHaveValue(siteA)
})


async function assertHomeBrowserOwnership(page: Page, { dark = false }: { dark?: boolean } = {}) {
  safeUiPhase("home_open")
  const fixture = await mockApi(page, { home: true })
  await openPanel(page, { width: 1280, height: 800 }, { home: true })
  if (dark) await expect(page.locator("html")).toHaveClass(/(?:^|\s)dark(?:\s|$)/)
  const sessionCount = fixture.getSessionPosts()
  safeUiPhase("home_empty")
  expect(fixture.navigated, "A blank home browser must not navigate to a default website").toEqual([])
  await expect(page.getByTestId("browser-empty-state")).toBeVisible()
  safeUiPhase("home_create_tab")
  await button(page, "Nueva pestaña").click()
  await expect(page.getByTestId("browser-empty-state")).toBeVisible()
  safeUiPhase("home_focus")
  await expect(address(page)).toBeFocused()
  await assertFocusedAddressStyle(page)
  safeUiPhase("home_navigate")
  await navigate(page, siteA)
  safeUiPhase("home_viewport")
  await assertViewportMatchesHost(page, fixture)
  safeUiPhase("home_no_chat")
  expect(fixture.getChatPosts()).toBe(0)
  safeUiPhase("home_same_session")
  expect(fixture.getSessionPosts()).toBe(sessionCount)
  safeUiPhase("home_url_owner")
  expect(new URL(page.url()).searchParams.get("id")).toBeNull()
  safeUiPhase("home_storage_owner")
  expect(await page.evaluate(() => localStorage.getItem("currentChatId"))).toBeNull()
  await screenshot(page, dark ? "home-dark-local" : "home-local")
}

test("home browser uses the owned member session without fabricating a conversation", async ({ page }) => {
  await assertHomeBrowserOwnership(page)
})

test("home browser preserves the focused omnibox and owned member session in the saved dark theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"))
  await assertHomeBrowserOwnership(page, { dark: true })
})


test.describe("reference browser frame", () => {
  test.use({ deviceScaleFactor: 2 })
  test("matches the compact reference and keeps desktop tools reachable without a bottom dock", async ({ page }) => {
    const fixture = await mockApi(page, { initialUrl: "https://www.google.com/search?q=google" })
    await openPanel(page, { width: 724, height: 1078 })
    await expect(page.getByTestId("agent-computer-dock-os")).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Abrir en otra pestaña" })).toHaveAttribute("href", "https://www.google.com/search?q=google")
    await expect.poll(() => page.getByRole("tab", { selected: true }).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    const tab = await page.getByRole("tab", { selected: true }).boundingBox()
    const add = await button(page, "Nueva pestaña").boundingBox()
    expect(add!.x - tab!.x - tab!.width).toBeLessThan(40)
    for (const name of ["Más opciones del navegador", "Anotar página", "Interactuar con la página", "Cerrar navegador"]) {
      await assertInsideViewport(page, button(page, name))
    }
    const frame = await page.getByTestId("agent-computer-shell").boundingBox()
    expect(frame!.x).toBe(7)
    expect(frame!.y).toBe(1)
    await screenshot(page, "reference-frame")
    await button(page, "Más opciones del navegador").click()
    await page.getByRole("menuitem", { name: "Escritorio", exact: true }).click()
    await expect(page.getByTestId("agent-computer-dock-os")).toBeVisible()
    await expect.poll(() => fixture.actions.filter((action) => action.type === "browser_restore").length).toBeGreaterThan(0)
    await page.getByTestId("agent-computer-dock-os").getByRole("button", { name: "Navegador", exact: true }).click()
    await expect(page.getByTestId("agent-computer-dock-os")).toHaveCount(0)
    await expect(address(page)).toHaveValue("https://www.google.com/search?q=google")
    expect(fixture.navigated).toEqual([])
  })
})
