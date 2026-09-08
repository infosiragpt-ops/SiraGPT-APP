import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Informational Playwright for professional video + audio preview.
 * Generate/media APIs are stubbed; attachment URLs are mocked so CI
 * never needs real files on disk.
 */
test.describe.configure({ timeout: 240_000 })

const user = {
  id: "media-preview-user",
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
  id: "media-preview-text",
  name: "deepseek-v4-flash",
  displayName: "Sira Rapido",
  provider: "DeepSeek",
  type: "TEXT",
  isActive: true,
}

const MOCK_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA="
const MOCK_POSTER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
const MOCK_VIDEO = "data:video/mp4;base64,AAAA"

const chat = {
  id: "media-preview-chat",
  title: "Media preview QA",
  model: textModel.name,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  messages: [
    {
      id: "media-preview-user-message",
      chatId: "media-preview-chat",
      role: "USER",
      content: "mira este clip y esta nota",
      timestamp: "2026-08-26T00:00:00.000Z",
      files: [
        {
          id: "file-video-1",
          name: "clip.mp4",
          mimeType: "video/mp4",
          type: "video/mp4",
          url: MOCK_VIDEO,
          preview: MOCK_VIDEO,
          mediaMeta: { durationSeconds: 8, thumbnailDataUrl: MOCK_POSTER },
        },
        {
          id: "file-audio-1",
          name: "nota.wav",
          mimeType: "audio/wav",
          type: "audio/wav",
          url: MOCK_WAV,
          preview: MOCK_WAV,
          mediaMeta: { durationSeconds: 2, peaks: [0.2, 0.9, 0.4, 0.7, 0.3] },
        },
      ],
    },
    {
      id: "media-preview-assistant-message",
      chatId: "media-preview-chat",
      role: "ASSISTANT",
      content: "Listo, reproduzco el video y el audio.",
      timestamp: "2026-08-26T00:00:01.000Z",
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

async function mockMediaPreviewApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "media-preview-token")
    localStorage.setItem("currentChatId", "media-preview-chat")
  })

  const handleApiRoute = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")

    if (path === "/auth/me") return fulfillJson(route, { user })
    if (path === "/health" && request.method() === "HEAD") return route.fulfill({ status: 204 })
    if (path === "/health") return fulfillJson(route, { status: "healthy" })
    if (path === "/ai/models") return fulfillJson(route, { models: [textModel] })
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
        chats: [chat],
        pagination: { page: 1, limit: 20, total: 1, pages: 1 },
      })
    }
    if (path === "/chats" && request.method() === "POST") {
      return fulfillJson(route, { ...chat, messages: chat.messages })
    }
    if (path === `/chats/${chat.id}`) {
      return fulfillJson(route, { chat })
    }
    if (path === "/ai/generate-speech" || path === "/ai/generate-video") {
      return fulfillJson(route, { ok: true, chatId: chat.id })
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

function tinyWavBuffer(): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(0, 40)
  return header
}

test("seeded chat renders video and audio players instead of filename chips", async ({ page }) => {
  await mockMediaPreviewApi(page)
  await openChatComposer(page)

  const videoPlayer = page.getByTestId("chat-video-player").first()
  const audioPlayer = page.getByTestId("chat-audio-player").first()
  await expect(videoPlayer).toBeVisible({ timeout: 60_000 })
  await expect(audioPlayer).toBeVisible({ timeout: 60_000 })
  await expect(videoPlayer.locator("video")).toHaveCount(1)
  await expect(audioPlayer.locator("audio")).toHaveCount(1)
  await expect(page.getByTestId("chat-video-play").first()).toBeVisible()
  await expect(page.getByTestId("chat-audio-play").first()).toBeVisible()
  await expect(page.getByText("clip.mp4", { exact: true })).toHaveCount(0)

  await page.getByTestId("chat-audio-play").first().click()
  await page.getByTestId("chat-video-play").first().click()
})

test("composer audio upload shows a player with play and duration", async ({ page }) => {
  await mockMediaPreviewApi(page)
  const composer = await openChatComposer(page)
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: "nota.wav",
    mimeType: "audio/wav",
    buffer: tinyWavBuffer(),
  })
  const audioPlayer = composer.getByTestId("chat-audio-player").first()
  await expect(audioPlayer).toBeVisible({ timeout: 30_000 })
  await expect(audioPlayer.getByTestId("chat-audio-play")).toBeVisible()
  await expect(audioPlayer.locator("audio")).toHaveCount(1)
})

test("composer video upload shows a real player not a filename-only chip", async ({ page }) => {
  await mockMediaPreviewApi(page)
  const composer = await openChatComposer(page)
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: "clip.webm",
    mimeType: "video/webm",
    buffer: Buffer.from("webm-mock"),
  })
  const videoPlayer = composer.getByTestId("chat-video-player").first()
  await expect(videoPlayer).toBeVisible({ timeout: 30_000 })
  await expect(videoPlayer.locator("video")).toHaveCount(1)
  await expect(videoPlayer.getByTestId("chat-video-play")).toBeVisible()
  await expect(composer.getByText("clip.webm", { exact: true })).toHaveCount(0)
})
