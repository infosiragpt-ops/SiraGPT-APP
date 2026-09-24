import { expect, test, type Page, type Route } from "@playwright/test"

test.describe.configure({ timeout: 240_000 })
// This contract checks Spanish UI copy; match the browser's negotiated locale.
test.use({ locale: "es-PE" })

const user = {
  id: "composer-size-user",
  name: "Valeria Castro",
  email: "valeria@example.com",
  plan: "PRO",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
}

const model = {
  id: "composer-size-model",
  name: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
  provider: "Anthropic",
  type: "TEXT",
  contextLength: 500_000,
}

// Extra catalog rows for the model-menu contract: a Sira alias, a decision
// model and an OpenRouter-synced row with no brand icon.
const catalogModels = [
  model,
  { id: "m-sira-pro", name: "deepseek/deepseek-v4-pro", displayName: "Sira Pro", provider: "DeepSeek", type: "TEXT" },
  { id: "m-grok", name: "x-ai/grok-4.6", displayName: "Grok 4.6", provider: "xAI", type: "TEXT" },
  { id: "m-dots", name: "dots/dots3-note-preview:free", displayName: "Dots Studio: Dots3-Note Preview (free)", provider: "OpenRouter", type: "TEXT" },
  { id: "m-jev", name: "typesafe/jev", displayName: "TypeSafe Jev", provider: "TypeSafe", type: "TEXT" },
]

const chat = {
  id: "composer-size-chat",
  title: "Composer size QA",
  model: model.name,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  messages: [
    {
      id: "composer-size-user-message",
      chatId: "composer-size-chat",
      role: "USER",
      content: "Hola",
      timestamp: "2026-07-22T00:00:00.000Z",
    },
    {
      id: "composer-size-assistant-message",
      chatId: "composer-size-chat",
      role: "ASSISTANT",
      content: Array.from(
        { length: 28 },
        (_, index) => `Párrafo ${index + 1}. Contenido de lectura suficiente para comprobar el borde inferior del chat sin ocultar ni desvanecer las últimas líneas.`
      ).join("\n\n"),
      timestamp: "2026-07-22T00:00:01.000Z",
      generationUsage: {
        tokensIn: 263_000,
        tokensOut: 1_100,
        total: 264_100,
        contextTokens: 262_800,
        contextWindow: 500_000,
        model: model.name,
        costTotalUsd: 0.926,
        costInputUsd: 0.0003,
        costOutputUsd: 0.0017,
      },
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

async function mockChatApi(page: Page, state: { hasConversation: boolean }) {
  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "composer-size-token")
    localStorage.setItem("sira:composer:effort", "Max")
    localStorage.removeItem("sira:composer:effort-scale")
    localStorage.setItem("sira.composer.access", "full")
    localStorage.removeItem("currentChatId")
  })

  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: catalogModels })
    if (path === "/payments/subscription") {
      return fulfillJson(route, {
        plan: "PRO",
        status: "active",
        subscription: null,
        apiUsage: 0,
        monthlyLimit: 100_000,
      })
    }
    if (path === "/chats" && request.method() === "GET") {
      return fulfillJson(route, {
        chats: state.hasConversation ? [{ ...chat, messages: [] }] : [],
        pagination: {
          page: 1,
          limit: 20,
          total: state.hasConversation ? 1 : 0,
          pages: state.hasConversation ? 1 : 0,
        },
      })
    }
    if (path === "/chats/composer-size-chat") return fulfillJson(route, { chat })

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
}

async function composerMetrics(page: Page) {
  const visibleSurface = page.locator('[data-testid="chat-composer-surface"]:visible').last()
  await expect(visibleSurface).toBeVisible()

  return visibleSurface.evaluate((surface) => {
    const textarea = surface.querySelector("textarea")
    const modelTrigger = surface.querySelector<HTMLElement>(".chat-model-trigger")
    const permission = surface.querySelector<HTMLElement>(".composer-permission-chip")
    const contextTrigger = surface.querySelector<HTMLElement>(".composer-context-trigger")
    const effortChip = surface.querySelector<HTMLElement>(".composer-effort-chip")
    const dictation = surface.querySelector<HTMLElement>(".composer-dictation-button")
    const primaryAction = surface.querySelector<HTMLElement>(".composer-send-button, .composer-stop-button")
    const rect = surface.getBoundingClientRect()
    if (!textarea || !modelTrigger || !permission || !contextTrigger || !effortChip || !dictation || !primaryAction) {
      throw new Error("Composer controls are missing")
    }
    const style = getComputedStyle(surface)

    const textareaRect = textarea.getBoundingClientRect()
    const modelRect = modelTrigger.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      textareaClientHeight: textarea.clientHeight,
      textareaScrollHeight: textarea.scrollHeight,
      textareaOverflowY: getComputedStyle(textarea).overflowY,
      stacked: surface.getAttribute("data-composer-stacked") === "true",
      modelBottomGap: rect.bottom - modelRect.bottom,
      modelBelowText: modelRect.top > textareaRect.top + 8,
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter,
      beforeContent: getComputedStyle(surface, "::before").content,
      modelBackgroundColor: getComputedStyle(modelTrigger).backgroundColor,
      modelBorderColor: getComputedStyle(modelTrigger).borderColor,
      textareaOutlineStyle: getComputedStyle(textarea).outlineStyle,
      placeholder: textarea.getAttribute("placeholder"),
      permissionLabel: permission.textContent?.trim(),
      permissionAria: permission.getAttribute("aria-label") || "",
      permissionTitle: permission.getAttribute("title") || "",
      permissionLevel: permission.getAttribute("data-level") || "",
      effortLabel: effortChip.textContent?.trim().replace(/[▾⌃]/g, "").trim(),
      effortAria: effortChip.getAttribute("aria-label") || "",
      effortPressed: effortChip.getAttribute("aria-pressed") || "",
      hasInlineAgentToggle: Boolean(surface.querySelector(".composer-sira-code-toggle")),
      toolbarOrder: [contextTrigger, modelTrigger, effortChip, dictation, primaryAction]
        .map((element) => element.getBoundingClientRect().left),
    }
  })
}

async function conversationAlignmentMetrics(page: Page) {
  const transcript = page.locator(".chat-conversation-column")
  const composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()

  await expect(transcript).toBeVisible()
  await expect(composer).toBeVisible()

  return page.evaluate(() => {
    const transcriptElement = document.querySelector<HTMLElement>(".chat-conversation-column")
    const composerElement = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="chat-composer-surface"]')
    ).find((element) => element.getClientRects().length > 0)
    if (!transcriptElement || !composerElement) {
      throw new Error("Chat alignment elements are missing")
    }

    const transcriptRect = transcriptElement.getBoundingClientRect()
    const transcriptStyle = getComputedStyle(transcriptElement)
    const composerRect = composerElement.getBoundingClientRect()
    const contentLeft = transcriptRect.left + Number.parseFloat(transcriptStyle.paddingLeft)
    const contentRight = transcriptRect.right - Number.parseFloat(transcriptStyle.paddingRight)

    return {
      leftDelta: Math.abs(contentLeft - composerRect.left),
      rightDelta: Math.abs(contentRight - composerRect.right),
      widthDelta: Math.abs((contentRight - contentLeft) - composerRect.width),
      composerWidth: composerRect.width,
    }
  })
}

async function expectConversationAlignedWithComposer(page: Page) {
  await expect.poll(async () => {
    const metrics = await conversationAlignmentMetrics(page)
    return Math.max(metrics.leftDelta, metrics.rightDelta, metrics.widthDelta)
  }).toBeLessThanOrEqual(1)
}

function expectSameComposerSize(
  actual: { width: number; height: number },
  expected: { width: number; height: number },
) {
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(1)
}

function expectSameComposerWidth(actual: { width: number }, expected: { width: number }) {
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1)
}

test("desktop composer keeps the approved width across text, attachment, tool, and chat states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = { hasConversation: false }
  await mockChatApi(page, state)

  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })

  const approved = await composerMetrics(page)
  expect(approved.width).toBeGreaterThan(764)
  expect(approved.width).toBeLessThan(772)
  expect(approved.height).toBeGreaterThan(108)
  expect(approved.height).toBeLessThan(116)
  expect(approved.borderTopWidth).toBe("1px")
  expect(approved.borderRadius).toBe("20px")
  expect(approved.backgroundColor).toBe("rgb(255, 255, 255)")
  expect(approved.backdropFilter).toBe("none")
  expect(approved.beforeContent).toBe("none")
  expect(approved.modelBackgroundColor).toBe("rgba(0, 0, 0, 0)")
  expect(approved.modelBorderColor).toBe("rgba(0, 0, 0, 0)")
  expect(approved.textareaOutlineStyle).toBe("none")
  expect(approved.placeholder).toBe("Escribe un mensaje…")
  expect(approved.permissionLabel).toBe("")
  expect(approved.permissionAria).toBe("Permisos: Acceso completo")
  expect(approved.permissionTitle).toBe("Acceso completo")
  expect(approved.permissionLevel).toBe("full")
  expect(approved.effortLabel).toBe("")
  expect(approved.effortAria).toBe("Modo rápido desactivado")
  expect(approved.effortPressed).toBe("false")
  expect(approved.hasInlineAgentToggle).toBe(false)
  expect(approved.toolbarOrder).toEqual([...approved.toolbarOrder].sort((a, b) => a - b))

  await page.getByTestId("composer-permission-chip").click()
  const permissionMenu = page.locator(".composer-permission-menu:not([hidden])")
  const permissionOptions = permissionMenu.getByTestId("composer-permission-option")
  await expect(permissionOptions).toHaveCount(5)
  await expect.poll(async () => permissionOptions.evaluateAll((rows) => (
    rows.map((row) => row.getAttribute("data-permission-level"))
  ))).toEqual(["default", "read", "protected", "workspace", "full"])
  for (const [index, label] of [
    "Default",
    "Solo lectura",
    "Protegido",
    "Workspace",
    "Acceso completo",
  ].entries()) {
    await expect(permissionOptions.nth(index).getByText(label, { exact: true })).toBeVisible()
  }
  await expect(permissionMenu.getByText("Modo del agente", { exact: true })).toHaveCount(0)
  await expect(permissionMenu.getByText("Construir", { exact: true })).toHaveCount(0)
  await expect(permissionMenu.getByText("Planificar", { exact: true })).toHaveCount(0)
  await expect(permissionMenu.getByTestId("sira-code-agent-toggle")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.getByTestId("composer-permission-chip").click()
  await expect(permissionOptions).toHaveCount(5)
  await page.keyboard.press("Escape")

  const textarea = page.getByTestId("chat-composer-surface").locator("textarea")
  await textarea.fill([
    "Linea 1",
    "Linea 2",
    "Linea 3",
    "Linea 4",
    "Linea 5",
    "Linea 6",
    "Linea 7",
    "Linea 8",
  ].join("\n"))
  await page.waitForTimeout(200)

  const multiline = await composerMetrics(page)
  expectSameComposerWidth(multiline, approved)
  expect(multiline.height).toBeGreaterThan(approved.height)
  expect(multiline.stacked).toBe(true)
  expect(multiline.modelBelowText).toBe(true)
  expect(multiline.modelBottomGap).toBeLessThanOrEqual(16)

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("sira:reuse-attachment", {
      detail: {
        id: "composer-size-file",
        name: "documento-prueba.pdf",
        type: "application/pdf",
        mimeType: "application/pdf",
        size: 2048,
        url: "/api/files/composer-size-file",
      },
    }))
  })
  await expect(page.getByLabel("Archivos adjuntos")).toBeVisible()
  const withAttachment = await composerMetrics(page)
  expectSameComposerWidth(withAttachment, approved)
  expect(withAttachment.height).toBeGreaterThan(multiline.height)
  expect(withAttachment.height - multiline.height).toBeLessThan(160)

  await page.getByRole("button", { name: /Adjuntar archivos y herramientas|attach files & tools/i }).click()
  await page.getByRole("menuitem", { name: /Web Search|Búsqueda web/i }).click()
  const withActiveTool = await composerMetrics(page)
  expectSameComposerSize(withActiveTool, withAttachment)

  state.hasConversation = true
  await page.evaluate(() => {
    localStorage.setItem("currentChatId", "composer-size-chat")
  })
  await page.goto("/agentes?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })
  await expect.poll(async () => (await composerMetrics(page)).width).toBeGreaterThan(764)
  const inConversation = await composerMetrics(page)
  expectSameComposerWidth(inConversation, approved)
})

test("mobile composer keeps its size while a long prompt scrolls internally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = { hasConversation: false }
  await mockChatApi(page, state)

  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })
  const approved = await composerMetrics(page)

  await page.getByTestId("chat-composer-surface").locator("textarea").fill([
    "Linea movil 1",
    "Linea movil 2",
    "Linea movil 3",
    "Linea movil 4",
    "Linea movil 5",
    "Linea movil 6",
  ].join("\n"))
  await page.waitForTimeout(200)

  const multiline = await composerMetrics(page)
  expectSameComposerWidth(multiline, approved)
  expect(multiline.height).toBeGreaterThan(approved.height)
  expect(multiline.stacked).toBe(true)
  expect(multiline.modelBelowText).toBe(true)
})

test("context popover and model menu with effort submenu use real data", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = { hasConversation: true }
  await mockChatApi(page, state)

  await page.goto("/agentes?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const contextTrigger = page.getByTestId("composer-context-trigger")
  await expect(contextTrigger).toBeVisible({ timeout: 120_000 })

  await contextTrigger.click()
  const contextMenu = page.getByTestId("composer-context-menu")
  await expect(contextMenu).toBeVisible()
  await expect(contextMenu.getByText("Ventana de contexto", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-context-metric")).toHaveText("262.8k / 500k · 53%")
  await expect(contextMenu.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "53")
  await expect(contextMenu.getByText(/Entrada 263k · Salida 1\.1k ·/)).toBeVisible()
  await expect(contextMenu.getByText(/Costo est\. \$0\.926/)).toBeVisible()
  await expect(contextMenu.getByText(/Entrada \$0\.0003 · Salida \$0\.0017 ·/)).toBeVisible()
  await expect(contextMenu.getByText(/Lectura de caché —/)).toBeVisible()

  const contextGeometry = await contextMenu.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height, radius: getComputedStyle(element).borderRadius }
  })
  expect(contextGeometry.width).toBeGreaterThanOrEqual(288)
  expect(contextGeometry.width).toBeLessThanOrEqual(306)
  expect(contextGeometry.height).toBeGreaterThanOrEqual(190)
  expect(contextGeometry.height).toBeLessThanOrEqual(245)
  expect(contextGeometry.radius).toBe("16px")

  await page.keyboard.press("Escape")
  await expect(contextMenu).toBeHidden()

  // Model menu: two-line rows (name + tagline), check on the active model,
  // monogram for the unbranded OpenRouter row, cleaned catalog label.
  await page.locator(".composer-model-inline .chat-model-trigger").click()
  const modelMenu = page.getByTestId("composer-model-menu")
  await expect(modelMenu).toBeVisible()
  await expect(modelMenu.locator(".model-picker-row")).toHaveCount(catalogModels.length)
  await expect(modelMenu.getByText("Dots3-Note Preview", { exact: true })).toBeVisible()
  await expect(modelMenu.getByText(/Dots Studio:|\(free\)/)).toHaveCount(0)
  await expect(modelMenu.locator(".model-logo-monogram")).toHaveCount(1)
  await expect(modelMenu.locator('.model-picker-row[data-selected="true"] .model-picker-row-check')).toBeVisible()
  await expect(modelMenu.locator(".model-picker-row-tagline").first()).not.toBeEmpty()
  await page.waitForTimeout(300) // let the menu fade-in settle before the evidence shot
  await page.screenshot({ path: "test-results/model-menu.png" })

  const search = modelMenu.getByRole("textbox", { name: "Buscar modelos" })
  await search.fill("zzz")
  await expect(modelMenu.getByText("Sin resultados para «zzz»")).toBeVisible()
  await search.fill("")

  // Effort row at the foot, migrated from the old "Max" (Extra high) to Extra.
  const effortRow = modelMenu.getByTestId("composer-effort-trigger")
  await expect(effortRow).toHaveAccessibleName("Esfuerzo: Extra")
  await effortRow.click()
  const effortMenu = page.getByTestId("composer-effort-menu")
  await expect(effortMenu).toBeVisible()
  await expect(effortMenu.getByText(/Un mayor esfuerzo significa respuestas más completas/)).toBeVisible()
  await expect(effortMenu.getByRole("menuitemradio")).toHaveCount(5)
  await expect(effortMenu.getByText("Predeterminado", { exact: true })).toBeVisible()
  await expect(effortMenu.getByText("Mayor uso", { exact: true })).toBeVisible()
  await expect(effortMenu.getByRole("menuitemradio", { name: /Extra/ })).toHaveAttribute("aria-checked", "true")
  await page.waitForTimeout(300) // let the menu fade-in settle before the evidence shot
  await page.screenshot({ path: "test-results/effort-submenu.png" })
  await effortMenu.getByRole("menuitemradio", { name: /Alto/ }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sira:composer:effort"))).toBe("Alto")

  // The lightning is a one-click fast-mode switch that persists.
  await page.keyboard.press("Escape")
  const fastToggle = page.getByTestId("composer-fast-toggle")
  await expect(fastToggle).toHaveAttribute("aria-pressed", "false")
  await fastToggle.click()
  await expect(fastToggle).toHaveAttribute("aria-pressed", "true")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sira.composer.fast"))).toBe("1")
  await page.screenshot({ path: "test-results/composer-toolbar.png", clip: await page.locator('[data-testid="chat-composer-surface"]:visible').last().boundingBox() || undefined })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("composer-fast-toggle")).toHaveAttribute("aria-pressed", "true", { timeout: 120_000 })
})

test("composer popovers remain inside a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = { hasConversation: true }
  await mockChatApi(page, state)

  await page.goto("/agentes?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await page.getByTestId("composer-context-trigger").press("Enter")
  const contextMenu = page.getByTestId("composer-context-menu")
  await expect(contextMenu).toBeVisible({ timeout: 120_000 })

  for (const menu of [contextMenu]) {
    const rect = await menu.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(8)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(382)
  }

  await page.keyboard.press("Escape")
  await page.locator(".composer-model-inline .chat-model-trigger").click()
  const modelMenu = page.getByTestId("composer-model-menu")
  await expect(modelMenu).toBeVisible()
  await modelMenu.getByTestId("composer-effort-trigger").click()
  const effortMenu = page.getByTestId("composer-effort-menu")
  await expect(effortMenu).toBeVisible()
  for (const menu of [modelMenu, effortMenu]) {
    const rect = await menu.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(8)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(382)
  }
  await page.waitForTimeout(300) // let the menu fade-in settle before the evidence shot
  await page.screenshot({ path: "test-results/effort-submenu-mobile.png" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test("conversation content rail aligns with the composer on desktop, narrow panes, and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = { hasConversation: true }
  await mockChatApi(page, state)

  await page.goto("/agentes?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })

  const desktop = await conversationAlignmentMetrics(page)
  expect(desktop.composerWidth).toBeGreaterThan(764)
  expect(desktop.composerWidth).toBeLessThan(772)
  await expectConversationAlignedWithComposer(page)

  // Sidebar/panel width changes must recenter the shared rail in its pane.
  await page.setViewportSize({ width: 900, height: 900 })
  await expectConversationAlignedWithComposer(page)

  await page.setViewportSize({ width: 390, height: 844 })
  await expectConversationAlignedWithComposer(page)
})

test("conversation reaches the composer edge and the return pill reserves no row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = { hasConversation: true }
  await mockChatApi(page, state)

  await page.goto("/agentes?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })

  const viewport = page.locator(".chat-message-scroll [data-radix-scroll-area-viewport]")
  await expect.poll(async () => viewport.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(160)

  const geometry = await page.evaluate(() => {
    const messageScroll = document.querySelector<HTMLElement>(".chat-message-scroll")
    const messageContent = document.querySelector<HTMLElement>(".chat-message-scroll-content")
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-composer-surface"]')
    const dock = document.querySelector<HTMLElement>(".chat-composer-dock")
    const pill = document.querySelector<HTMLElement>('[data-testid="chat-scroll-to-bottom"]')
    if (!messageScroll || !messageContent || !composer || !dock || !pill) {
      throw new Error("Chat edge geometry elements are missing")
    }

    return {
      composerGap: composer.getBoundingClientRect().top - messageScroll.getBoundingClientRect().bottom,
      contentPaddingBottom: Number.parseFloat(getComputedStyle(messageContent).paddingBottom),
      dockPaddingTop: Number.parseFloat(getComputedStyle(dock).paddingTop),
      pillPosition: getComputedStyle(pill).position,
      pillBottom: pill.getBoundingClientRect().bottom,
      composerTop: composer.getBoundingClientRect().top,
    }
  })

  expect(geometry.composerGap).toBeGreaterThanOrEqual(0)
  expect(geometry.composerGap).toBeLessThanOrEqual(4)
  expect(geometry.contentPaddingBottom).toBeLessThanOrEqual(4)
  expect(geometry.dockPaddingTop).toBeLessThanOrEqual(4)
  expect(geometry.pillPosition).toBe("absolute")
  // The hidden state eases down by 8px before fading. It may touch, but must
  // never overlap, the composer; its visible state sits above this boundary.
  expect(geometry.pillBottom).toBeLessThanOrEqual(geometry.composerTop)
})

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`plus menu omits retired actions on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const state = { hasConversation: true }
    await mockChatApi(page, state)

    await page.goto("/agentes?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
    await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })

    await page.getByRole("button", { name: "Adjuntar archivos y herramientas" }).press("Enter")

    const toolsMenu = page.getByRole("menu", { name: "Adjuntar archivos y herramientas" })
    for (const label of ["Subir archivos", "Imágenes", "Voz", "Video", "Música"]) {
      await expect(toolsMenu.getByText(label, { exact: true })).toBeVisible()
    }
    for (const retiredLabel of [
      "Trabajo",
      "Trabajo activo",
      "Planifica, ejecuta y entrega archivos",
      "Generador de tesis",
      "Vista previa de tesis académica",
    ]) {
      await expect(toolsMenu.getByText(retiredLabel, { exact: true })).toHaveCount(0)
    }
  })
}
