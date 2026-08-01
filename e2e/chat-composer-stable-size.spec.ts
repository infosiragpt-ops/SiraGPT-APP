import { expect, test, type Page, type Route } from "@playwright/test"

test.describe.configure({ timeout: 240_000 })

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
}

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
      content: "Hola, lista para ayudarte.",
      timestamp: "2026-07-22T00:00:01.000Z",
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
    localStorage.removeItem("currentChatId")
  })

  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: [model] })
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
  return page.getByTestId("chat-composer-surface").evaluate((surface) => {
    const textarea = surface.querySelector("textarea")
    const rect = surface.getBoundingClientRect()
    if (!textarea) throw new Error("Composer textarea is missing")

    return {
      width: rect.width,
      height: rect.height,
      textareaClientHeight: textarea.clientHeight,
      textareaScrollHeight: textarea.scrollHeight,
      textareaOverflowY: getComputedStyle(textarea).overflowY,
    }
  })
}

async function conversationAlignmentMetrics(page: Page) {
  const transcript = page.locator(".chat-conversation-column")
  const composer = page.getByTestId("chat-composer-surface")

  await expect(transcript).toBeVisible()
  await expect(composer).toBeVisible()

  return page.evaluate(() => {
    const transcriptElement = document.querySelector<HTMLElement>(".chat-conversation-column")
    const composerElement = document.querySelector<HTMLElement>('[data-testid="chat-composer-surface"]')
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

  await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })

  const approved = await composerMetrics(page)
  expect(approved.width).toBeGreaterThan(820)
  expect(approved.width).toBeLessThan(835)
  expect(approved.height).toBeGreaterThan(92)
  expect(approved.height).toBeLessThan(97)

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
  expectSameComposerSize(multiline, approved)
  expect(multiline.textareaScrollHeight).toBeGreaterThan(multiline.textareaClientHeight)
  expect(multiline.textareaOverflowY).toBe("auto")

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
  expect(withAttachment.height).toBeGreaterThan(approved.height)
  expect(withAttachment.height - approved.height).toBeLessThan(120)

  await page.getByRole("button", { name: /Adjuntar archivos y herramientas|attach files & tools/i }).click()
  await page.getByRole("menuitem", { name: /Web Search|Búsqueda web/i }).click()
  const withActiveTool = await composerMetrics(page)
  expectSameComposerSize(withActiveTool, withAttachment)

  state.hasConversation = true
  await page.evaluate(() => {
    localStorage.setItem("currentChatId", "composer-size-chat")
  })
  await page.goto("/chat?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })
  const inConversation = await composerMetrics(page)
  expectSameComposerSize(inConversation, approved)
})

test("mobile composer keeps its size while a long prompt scrolls internally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = { hasConversation: false }
  await mockChatApi(page, state)

  await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
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
  expectSameComposerSize(multiline, approved)
  expect(multiline.textareaScrollHeight).toBeGreaterThan(multiline.textareaClientHeight)
  expect(multiline.textareaOverflowY).toBe("auto")
})

test("conversation content rail aligns with the composer on desktop, narrow panes, and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = { hasConversation: true }
  await mockChatApi(page, state)

  await page.goto("/chat?id=composer-size-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.getByTestId("chat-composer-surface")).toBeVisible({ timeout: 120_000 })

  const desktop = await conversationAlignmentMetrics(page)
  expect(desktop.composerWidth).toBeGreaterThan(820)
  expect(desktop.composerWidth).toBeLessThan(835)
  await expectConversationAlignedWithComposer(page)

  // Sidebar/panel width changes must recenter the shared rail in its pane.
  await page.setViewportSize({ width: 900, height: 900 })
  await expectConversationAlignedWithComposer(page)

  await page.setViewportSize({ width: 390, height: 844 })
  await expectConversationAlignedWithComposer(page)
})
