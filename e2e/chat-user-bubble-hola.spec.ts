import { expect, test, type Page, type Route } from "@playwright/test"

test.describe.configure({ timeout: 240_000 })

const user = {
  id: "hola-bubble-user",
  name: "Luis Car",
  email: "luis@example.com",
  plan: "PRO",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
}

const model = {
  id: "hola-bubble-model",
  name: "deepseek-v4-flash",
  displayName: "Sira Rápido",
  provider: "DeepSeek",
  type: "TEXT",
}

const chat = {
  id: "hola-bubble-chat",
  title: "hola",
  model: model.name,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  messages: [
    {
      id: "hola-bubble-user-message",
      chatId: "hola-bubble-chat",
      role: "USER",
      content: "hola",
      timestamp: "2026-08-24T00:00:00.000Z",
    },
    {
      id: "hola-bubble-assistant-message",
      chatId: "hola-bubble-chat",
      role: "ASSISTANT",
      content: "¡Hola, Luis! ¿En qué te ayudo hoy?",
      timestamp: "2026-08-24T00:00:01.000Z",
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

async function mockChatApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "hola-bubble-token")
    localStorage.setItem("currentChatId", "hola-bubble-chat")
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
        chats: [{ ...chat, messages: [] }],
        pagination: { page: 1, limit: 20, total: 1, pages: 1 },
      })
    }
    if (path === "/chats/hola-bubble-chat") return fulfillJson(route, { chat })

    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
}

test("el mensaje corto del usuario se renderiza horizontalmente", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockChatApi(page)
  await page.goto("/agentes?id=hola-bubble-chat", { waitUntil: "domcontentloaded", timeout: 120_000 })

  const bubble = page.getByTestId("user-message").filter({ hasText: "hola" }).last()
  await expect(bubble).toBeVisible({ timeout: 120_000 })
  await expect(bubble).toContainText("hola")

  const result = await bubble.evaluate((element) => {
    const styles = getComputedStyle(element)
    const text = element.querySelector(".chat-user-bubble-inner") || element
    const range = document.createRange()
    range.selectNodeContents(text)
    const linePositions = new Set(
      Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)),
    )
    return {
      text: (text.textContent || "").replace(/\s+/g, " ").trim(),
      width: element.getBoundingClientRect().width,
      writingMode: styles.writingMode,
      wordBreak: styles.wordBreak,
      overflowWrap: styles.overflowWrap,
      lineCount: linePositions.size,
    }
  })

  expect(result.text).toBe("hola")
  expect(result.width).toBeGreaterThan(44)
  expect(result.writingMode).toBe("horizontal-tb")
  expect(result.wordBreak).toBe("normal")
  expect(result.overflowWrap).toBe("break-word")
  expect(result.lineCount).toBe(1)
})
