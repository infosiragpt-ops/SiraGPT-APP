import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Informational smoke for Imágenes + Voz composer chips.
 * Not part of the critical UI gate (that job only runs chat.spec.ts
 * and chat-upload.spec.ts). Generate APIs are stubbed so CI never bills.
 */
test.describe.configure({ timeout: 240_000 })

const user = {
  id: "media-chips-user",
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

const textModel = {
  id: "media-chips-text",
  name: "deepseek-v4-flash",
  displayName: "Sira Rápido",
  provider: "DeepSeek",
  type: "TEXT",
  isActive: true,
}

const imageModel = {
  id: "media-chips-image",
  name: "gemini-3.1-flash-image",
  displayName: "Gemini 3.1 Flash Image",
  provider: "Google",
  type: "IMAGE",
  isActive: true,
}

const chat = {
  id: "media-chips-chat",
  title: "Media chips QA",
  model: textModel.name,
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

function isMonochromeCssColor(color: string): boolean {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  if (!match) return /(#(?:0{3,8}|f{3,8}|1{3,6}|2{3,6})|black|white|gray|grey|transparent)/i.test(color)
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])]
  return Math.max(...channels) - Math.min(...channels) <= 16
}

async function mockMediaChatApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "media-chips-token")
    localStorage.removeItem("currentChatId")
  })

  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: [textModel, imageModel] })
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
        chats: [],
        pagination: { page: 1, limit: 20, total: 0, pages: 0 },
      })
    }
    if (path === "/chats" && request.method() === "POST") {
      return fulfillJson(route, { ...chat, messages: [] })
    }
    if (path === `/chats/${chat.id}`) {
      return fulfillJson(route, {
        chat: {
          ...chat,
          messages: [
            {
              id: "media-chips-user-message",
              chatId: chat.id,
              role: "USER",
              content: "un gato astronauta",
              timestamp: "2026-08-26T00:00:00.000Z",
            },
            {
              id: "media-chips-assistant-message",
              chatId: chat.id,
              role: "ASSISTANT",
              content: "![imagen](/uploads/images/mock.png)",
              timestamp: "2026-08-26T00:00:01.000Z",
            },
          ],
        },
      })
    }
    if (path === "/ai/generate-image") {
      return fulfillJson(route, {
        ok: true,
        imageUrl: "/uploads/images/mock.png",
        chatId: chat.id,
      })
    }
    if (path === "/ai/generate-speech") {
      return fulfillJson(route, {
        ok: true,
        content: "Audio generado (mock)",
        artifact: {
          id: "speech-1",
          filename: "voz.mp3",
          mime: "audio/mpeg",
          downloadUrl: "/uploads/audio/mock.mp3",
          sizeBytes: 1024,
        },
        state: { done: true },
        assistantMessageId: "media-chips-speech",
        chatId: chat.id,
        model: "Gemini 2.5 Flash TTS",
      })
    }
    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
}

async function openChatComposer(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()
  await expect(composer).toBeVisible({ timeout: 120_000 })
  return composer
}

async function openPlusMenu(page: Page) {
  await page.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
}

async function assertChipIsBlackAndWhite(chip: ReturnType<Page["locator"]>) {
  await expect(chip).toBeVisible()
  const paint = await chip.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      className: element.className,
      inlineStyle: element.getAttribute("style") || "",
      backgroundColor: style.backgroundColor,
      color: style.color,
      borderColor: style.borderColor,
    }
  })
  expect(paint.className, "chip className").not.toMatch(/purple|violet|fuchsia|indigo|cyan|celeste|sky-400|from-purple/i)
  expect(paint.inlineStyle, "chip style").not.toMatch(/purple|violet|fuchsia|#7c3aed|#8b5cf6|#38bdf8|#22d3ee/i)
  expect(isMonochromeCssColor(paint.backgroundColor), `background ${paint.backgroundColor}`).toBe(true)
  expect(isMonochromeCssColor(paint.color), `color ${paint.color}`).toBe(true)
}

test("imagenes flow: B&W chip, settings, empty send disabled, mocked generate", async ({ page }) => {
  await mockMediaChatApi(page)
  const composer = await openChatComposer(page)
  await openPlusMenu(page)
  await page.getByRole("menuitem", { name: /Genera imágenes/ }).click()

  const chip = page.getByTestId("imagenes-mode-chip")
  await assertChipIsBlackAndWhite(chip)

  const textarea = composer.locator("textarea").first()
  await expect(textarea).toHaveAttribute("placeholder", /image/i)

  const send = composer.locator("button.composer-send-button").first()
  await expect(send).toBeDisabled()

  await page.getByRole("button", { name: /Configurar imagen/ }).click()
  const ratio = page.getByRole("radio", { name: "1:1" }).first()
  if (await ratio.count()) await ratio.click()
  await page.keyboard.press("Escape")

  await textarea.fill("un gato astronauta en blanco y negro")
  await expect(send).toBeEnabled()
  await send.click()
  await expect(chip).toBeVisible()
})

test("voz flow: B&W chip, Spanish placeholder, grayscale settings, mocked generate", async ({ page }) => {
  await mockMediaChatApi(page)
  const composer = await openChatComposer(page)
  await openPlusMenu(page)
  await page.getByRole("menuitem", { name: /Texto a voz/ }).click()

  const chip = page.getByTestId("voz-mode-chip")
  await assertChipIsBlackAndWhite(chip)

  const textarea = composer.locator("textarea").first()
  await expect(textarea).toHaveAttribute("placeholder", "Escribe el texto que quieres convertir en voz")

  const send = composer.locator("button.composer-send-button").first()
  await expect(send).toBeDisabled()

  await page.getByRole("button", { name: /Configurar voz/ }).click()
  await expect(page.getByText("Stability")).toBeVisible()
  const slider = page.locator(".voice-stability-slider")
  await expect(slider).toBeVisible()
  const sliderPaint = await slider.evaluate((element) => {
    const range = element.querySelector(".bg-primary")
    return range ? getComputedStyle(range).backgroundColor : ""
  })
  if (sliderPaint) {
    expect(isMonochromeCssColor(sliderPaint), `stability ${sliderPaint}`).toBe(true)
  }
  await page.keyboard.press("Escape")

  await textarea.fill("Hola, esto es una prueba de voz en español.")
  await expect(send).toBeEnabled()
  await send.click()
  await expect(chip).toBeVisible()
})
