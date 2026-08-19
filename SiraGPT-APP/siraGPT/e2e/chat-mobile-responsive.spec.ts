import { expect, test, type Page, type Route } from "@playwright/test"

test.describe.configure({ timeout: 240_000 })

const models = [
  {
    id: "model-long",
    name: "provider/extremely-long-mobile-model-name-with-context-window-and-reasoning-2026",
    displayName: "Modelo Extremadamente Largo Para Probar Header Mobile 2026",
    provider: "OpenAI",
    type: "TEXT",
  },
  {
    id: "model-fast",
    name: "gpt-4o-mini",
    displayName: "GPT 4o Mini",
    provider: "OpenAI",
    type: "TEXT",
  },
]

const user = {
  id: "user-mobile",
  name: "Valeria Mobile",
  email: "valeria@example.com",
  plan: "STANDARD",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 1200,
  monthlyLimit: 30000,
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
}

const chat = {
  id: "mobile-chat",
  title: "Mobile responsive QA",
  model: models[0].name,
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
  messages: [
    {
      id: "msg-user-1",
      chatId: "mobile-chat",
      role: "USER",
      content: "Hola",
      timestamp: "2026-05-04T00:00:00.000Z",
    },
    {
      id: "msg-assistant-1",
      chatId: "mobile-chat",
      role: "ASSISTANT",
      content: [
        "Hola, Valeria. Esta respuesta incluye una URL larga para probar wrapping:",
        "https://siragpt.example.com/mobile/responsive/una-ruta-muy-larga-con-parametros?conversation=mobile-chat&token=abcdefghijklmnopqrstuvwxyz0123456789",
        "",
        "| Columna larga | Valor |",
        "| --- | --- |",
        "| contenido-con-una-palabra-extremadamente-larga-sin-espacios-para-forzar-wrap | OK |",
      ].join("\n"),
      timestamp: "2026-05-04T00:00:01.000Z",
    },
  ],
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function mockChatApi(page: Page, options: { visualViewportHeight?: number } = {}) {
  await page.addInitScript((visualViewportHeight) => {
    localStorage.setItem("auth-token", "mobile-e2e-token")
    localStorage.setItem("currentChatId", "mobile-chat")
    localStorage.setItem("theme", "dark")

    if (visualViewportHeight) {
      const viewport = new EventTarget()
      Object.defineProperties(viewport, {
        width: { get: () => window.innerWidth },
        height: { get: () => Math.min(visualViewportHeight, window.innerHeight) },
        offsetLeft: { get: () => 0 },
        offsetTop: { get: () => 0 },
        pageLeft: { get: () => window.scrollX },
        pageTop: { get: () => window.scrollY },
        scale: { get: () => 1 },
      })

      try {
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: viewport,
        })
      } catch {
        // Chromium allows this in tests; keep the page usable if a browser refuses it.
      }
    }
  }, options.visualViewportHeight ?? null)

  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") {
      return route.fulfill({ status: 204 })
    }
    if (path === "/health") {
      return fulfillJson(route, {
        status: "healthy",
        timestamp: new Date("2026-05-04T00:00:00.000Z").toISOString(),
        uptime_s: 1,
        checks: [{ name: "frontend", status: "healthy", critical: true, latency_ms: 0 }],
      })
    }
    if (path === "/ai/models") return fulfillJson(route, { models })
    if (path === "/payments/subscription") {
      return fulfillJson(route, {
        plan: "STANDARD",
        status: "active",
        subscription: null,
        apiUsage: user.apiUsage,
        monthlyLimit: user.monthlyLimit,
      })
    }
    if (path === "/chats" && request.method() === "GET") {
      return fulfillJson(route, {
        chats: [{ ...chat, messages: [] }],
        pagination: { page: 1, limit: 20, total: 1, pages: 1 },
      })
    }
    if (path === "/chats/mobile-chat") return fulfillJson(route, { chat })
    if (path === "/chats/mobile-chat/share") return fulfillJson(route, { shareId: "share-mobile" })

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
}

async function waitForMobileChatShell(page: Page, timeout: number) {
  await page.waitForSelector(".chat-viewport", { timeout })
  await page.waitForSelector(".chat-composer-dock textarea", { timeout })
}

async function openMobileChat(
  page: Page,
  width: number,
  height: number,
  options: { visualViewportHeight?: number } = {},
) {
  await page.setViewportSize({ width, height })
  await mockChatApi(page, options)
  let sawChunkParseError = false
  const onPageError = (error: Error) => {
    if (/Invalid or unexpected token/i.test(error.message)) sawChunkParseError = true
  }

  page.on("pageerror", onPageError)
  try {
    await page.goto("/chat?id=mobile-chat", { waitUntil: "commit", timeout: 120_000 })
    try {
      await waitForMobileChatShell(page, 60_000)
    } catch (error) {
      if (!sawChunkParseError) throw error

      // Next dev can occasionally serve a stale/partial first client chunk while
      // cold-compiling this large route. A single reload validates the real UI
      // after the dev server has completed that initial compilation.
      sawChunkParseError = false
      await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 })
      await waitForMobileChatShell(page, 120_000)
    }
  } finally {
    page.off("pageerror", onPageError)
  }
  await page.waitForTimeout(250)
}

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const html = document.documentElement
    const body = document.body
    const chatRoot = document.querySelector<HTMLElement>(".chat-viewport")
    const header = document.querySelector<HTMLElement>(".chat-mobile-header")
    const composer = document.querySelector<HTMLElement>(".chat-composer-dock")
    const scrollContent = document.querySelector<HTMLElement>(".chat-message-scroll-content")

    if (!chatRoot || !header || !composer || !scrollContent) {
      throw new Error("Chat layout nodes are missing")
    }

    const chatRect = chatRoot.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    const scrollStyles = getComputedStyle(scrollContent)
    const rootStyles = getComputedStyle(chatRoot)

    return {
      htmlScrollWidth: html.scrollWidth,
      htmlClientWidth: html.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      chatLeft: chatRect.left,
      chatRight: chatRect.right,
      chatBottom: chatRect.bottom,
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      headerBottom: headerRect.bottom,
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      composerHeight: composerRect.height,
      scrollPaddingBottom: Number.parseFloat(scrollStyles.paddingBottom || "0"),
      viewportHeightVar: rootStyles.getPropertyValue("--chat-viewport-height").trim(),
      keyboardHeightVar: rootStyles.getPropertyValue("--chat-keyboard-height").trim(),
      viewportHeight: Number.parseFloat(rootStyles.getPropertyValue("--chat-viewport-height") || "0"),
      keyboardHeight: Number.parseFloat(rootStyles.getPropertyValue("--chat-keyboard-height") || "0"),
    }
  })
}

test("375px mobile chat keeps header, messages, composer, tools, and chips within the viewport", async ({ page }) => {
  await openMobileChat(page, 375, 667)

  await page.getByRole("button", { name: /Adjuntar archivos y herramientas|attach files & tools/i }).click()
  await page.getByRole("menuitem", { name: /Web Search/i }).click()

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("sira:reuse-attachment", {
      detail: {
        id: "file-mobile-1",
        name: "contrato-super-largo-para-probar-chip-mobile-responsive.pdf",
        mimeType: "application/pdf",
        size: 2048,
        url: "/api/files/file-mobile-1",
      },
    }))
  })

  const textarea = page.locator(".chat-composer-dock textarea")
  await textarea.fill([
    "Linea uno con texto normal",
    "Linea dos con mas contenido",
    "Linea tres con una URL https://siragpt.example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "Linea cuatro",
    "Linea cinco",
    "Linea seis",
  ].join("\n"))
  await page.waitForTimeout(250)

  const metrics = await layoutMetrics(page)
  expect(metrics.htmlScrollWidth).toBeLessThanOrEqual(metrics.htmlClientWidth + 1)
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1)
  expect(metrics.headerLeft).toBeGreaterThanOrEqual(metrics.chatLeft - 1)
  expect(metrics.headerRight).toBeLessThanOrEqual(metrics.chatRight + 1)
  expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.chatBottom + 1)
  expect(metrics.composerTop).toBeGreaterThan(metrics.headerBottom)
  expect(metrics.scrollPaddingBottom).toBeGreaterThanOrEqual(metrics.composerHeight - 1)
  expect(metrics.viewportHeightVar).toMatch(/px$/)
  expect(metrics.keyboardHeightVar).toMatch(/px$/)
})

test("390px mobile model and tools menus stay inside the viewport", async ({ page }) => {
  await openMobileChat(page, 390, 844)

  await page.locator(".chat-model-trigger").first().click()
  const modelMenu = page.locator('[role="menu"]').filter({ hasText: "Modelo Extremadamente Largo" }).first()
  await expect(modelMenu).toBeVisible()
  const modelBox = await modelMenu.boundingBox()
  expect(modelBox).not.toBeNull()
  expect(modelBox!.x).toBeGreaterThanOrEqual(0)
  expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(390)
  expect(modelBox!.height).toBeLessThanOrEqual(844)
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: /Adjuntar archivos y herramientas|attach files & tools/i }).click()
  const toolsMenu = page.locator('[role="menu"]').filter({ hasText: /Subir archivos|Upload Files/ }).first()
  await expect(toolsMenu).toBeVisible()
  await expect(toolsMenu.getByText("Gmail", { exact: true })).toBeVisible()
  await expect(toolsMenu.getByText("Google Drive", { exact: true })).toBeVisible()
  const toolsBox = await toolsMenu.boundingBox()
  expect(toolsBox).not.toBeNull()
  expect(toolsBox!.x).toBeGreaterThanOrEqual(0)
  expect(toolsBox!.x + toolsBox!.width).toBeLessThanOrEqual(390)
  expect(toolsBox!.height).toBeLessThanOrEqual(844)

  const metrics = await layoutMetrics(page)
  expect(metrics.htmlScrollWidth).toBeLessThanOrEqual(metrics.htmlClientWidth + 1)
  expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.chatBottom + 1)
})

test("390px mobile chat stays pinned when visualViewport is reduced by a simulated keyboard", async ({ page }) => {
  await openMobileChat(page, 390, 844, { visualViewportHeight: 520 })

  const textarea = page.locator(".chat-composer-dock textarea")
  await textarea.focus()
  await textarea.fill([
    "Linea uno",
    "Linea dos",
    "Linea tres",
    "Linea cuatro",
    "Linea cinco",
    "Linea seis",
  ].join("\n"))
  await page.waitForTimeout(250)

  const metrics = await layoutMetrics(page)
  expect(metrics.viewportHeight).toBeLessThanOrEqual(521)
  expect(metrics.keyboardHeight).toBeGreaterThanOrEqual(320)
  expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.chatBottom + 1)
  expect(metrics.scrollPaddingBottom).toBeGreaterThanOrEqual(metrics.composerHeight - 1)
  expect(metrics.htmlScrollWidth).toBeLessThanOrEqual(metrics.htmlClientWidth + 1)
})
