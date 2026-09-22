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

async function mockMediaPreviewApi(page: Page, opts: { messages?: unknown[] } = {}) {
  const currentChat = { ...chat, messages: opts.messages || chat.messages }
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
        chats: [currentChat],
        pagination: { page: 1, limit: 20, total: 1, pages: 1 },
      })
    }
    if (path === "/chats" && request.method() === "POST") {
      return fulfillJson(route, currentChat)
    }
    if (path === `/chats/${chat.id}`) {
      return fulfillJson(route, { chat: currentChat })
    }
    if (path === "/ai/generate-speech" || path === "/ai/generate-video") {
      return fulfillJson(route, { ok: true, chatId: chat.id })
    }
    return fulfillJson(route, {})
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)
}

async function openChatComposer(page: Page, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport)
  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()
  await expect(composer).toBeVisible({ timeout: 120_000 })
  // The local Next.js dev badge covers the mobile '+' button. It is absent
  // in production; exclude that dev-only chrome, not application UI/errors.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
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
  await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
  const fileInput = page.locator('input[data-accepts-any-format="true"]').first()
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
  await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
  const fileInput = page.locator('input[data-accepts-any-format="true"]').first()
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


for (const scenario of [
  { name: "desktop retries one failed recording and submits the other 49 while processing", width: 1440, height: 900, retryFailed: true, failedIndex: 23 },
  { name: "mobile submits 50 recordings with one failed and 49 processing without horizontal overflow", width: 390, height: 844, retryFailed: false, failedIndex: 0 },
]) test(scenario.name, async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await mockMediaPreviewApi(page)
  let uploadCalls = 0
  let retryCalls = 0
  let submitted: any = null
  let submittedNames: string[] = []
  const records = Array.from({ length: 50 }, (_, index) => ({
    id: `batch-audio-${index}`, name: `recording-${index}.wav`, originalName: `recording-${index}.wav`,
    mimeType: "audio/wav", type: "audio/wav", size: 46, url: MOCK_WAV,
    processingStage: index === scenario.failedIndex ? "failed" : "extracting", processingError: index === scenario.failedIndex ? "Temporary transcription failure" : null,
  }))
  const batchRoute = async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (path === "/files/upload") {
      uploadCalls += 1
      submittedNames = Array.from((req.postDataBuffer()?.toString() || "").matchAll(/filename="([^"]+)"/g), (m) => m[1])
      return fulfillJson(route, { files: records.map((f) => ({ ...f, success: true })) }, 202)
    }
    if (path === "/files/processing-status") {
      const ids = new URL(req.url()).searchParams.get("ids")?.split(",") || []
      expect(ids.length).toBeLessThanOrEqual(50)
      return fulfillJson(route, { files: records.filter((f) => ids.includes(f.id)) })
    }
    if (path === `/files/batch-audio-${scenario.failedIndex}/retry-processing`) {
      retryCalls += 1
      records[scenario.failedIndex].processingStage = "ready"
      records[scenario.failedIndex].processingError = null
      return fulfillJson(route, { file: records[scenario.failedIndex] }, 202)
    }
    if (path === "/agent/task") {
      submitted = req.postDataJSON()
      const events = [{ type: "meta", taskId: "batch-task", goal: "transcribir", model: textModel.name, tools: [] },
        { type: "final_text", markdown: "Se recibieron los 50 audios para transcripción y análisis." }, { type: "done" }]
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") })
    }
    return route.fallback()
  }
  await page.route("**/api/**", batchRoute)
  await page.route("http://localhost:5000/**", batchRoute)
  const composer = await openChatComposer(page, { width: scenario.width, height: scenario.height })
  const files = records.map((f, index) => {
    const wav = Buffer.concat([tinyWavBuffer(), Buffer.alloc(2)])
    wav.writeUInt32LE(38, 4); wav.writeUInt32LE(2, 40); wav.writeInt16LE(index + 1, 44)
    return { name: f.name, mimeType: "audio/wav", buffer: wav }
  })
  await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
  await page.locator('input[data-accepts-any-format="true"]').first().setInputFiles(files)
  await expect(composer.getByTestId("chat-audio-player")).toHaveCount(50)
  await expect(composer.getByTestId("media-attachment-status")).toHaveCount(50)
  const retry = composer.getByRole("button", { name: `Reintentar recording-${scenario.failedIndex}.wav`, exact: true })
  await expect(retry).toBeVisible({ timeout: 30000 })
  expect(submittedNames).toEqual(records.map((f) => f.name))
  await expect(composer.getByTestId("media-attachment-status").filter({ hasText: "Transcribiendo" })).toHaveCount(49)
  await expect(composer.getByTestId("media-attachment-status").filter({ hasText: "No se pudo transcribir" })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width + 1)
  await page.screenshot({ path: testInfo.outputPath(`audio-batch50-${scenario.width}.png`) })
  if (scenario.retryFailed) {
    await retry.click()
    await expect.poll(() => retryCalls).toBe(1)
    await expect(retry).toHaveCount(0, { timeout: 15000 })
    await expect(composer.getByTestId("media-attachment-status").filter({ hasText: "Listo para analizar" })).toHaveCount(1, { timeout: 15000 })
  } else {
    expect(retryCalls).toBe(0)
  }
  expect(uploadCalls).toBe(1)
  await expect(composer.getByTestId("chat-audio-player")).toHaveCount(50)
  const input = composer.locator("textarea").first()
  await input.fill("transcribir y analizar los 50 audios")
  await input.press("Enter")
  await expect.poll(() => submitted?.files?.length, { timeout: 30000 }).toBe(50)
  expect(submitted.files).toEqual(records.map((f) => f.id))
  expect(submitted.model).toBe(textModel.name)
  await expect(page.getByText("Se recibieron los 50 audios para transcripción y análisis.", { exact: false }).first()).toBeVisible()
  expect(pageErrors).toEqual([])
})

test("failed upload retries the same bytes without removing the successful recording", async ({ page }) => {
  await mockMediaPreviewApi(page)
  let calls = 0
  const upload = async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (path !== "/files/upload") return route.fallback()
    calls += 1
    return fulfillJson(route, { files: calls === 1 ? [
      { name: "failed.wav", type: "audio/wav", success: false, error: "Conexión interrumpida" },
      { id: "kept-audio", name: "kept.wav", type: "audio/wav", success: true, processingStage: "ready", url: MOCK_WAV },
    ] : [{ id: "retried-audio", name: "failed.wav", type: "audio/wav", success: true, processingStage: "ready", url: MOCK_WAV }] })
  }
  await page.route("**/api/**", upload)
  await page.route("http://localhost:5000/**", upload)
  const composer = await openChatComposer(page)
  await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
  await page.locator('input[data-accepts-any-format="true"]').first().setInputFiles([
    { name: "failed.wav", mimeType: "audio/wav", buffer: Buffer.concat([tinyWavBuffer(), Buffer.from([1, 0])]) },
    { name: "kept.wav", mimeType: "audio/wav", buffer: Buffer.concat([tinyWavBuffer(), Buffer.from([2, 0])]) },
  ])
  const retry = composer.getByRole("button", { name: "Reintentar failed.wav", exact: true })
  await expect(retry).toBeVisible({ timeout: 30000 })
  await retry.click()
  await expect.poll(() => calls).toBe(2)
  await expect(composer.getByTestId("chat-audio-player")).toHaveCount(2)
  await expect(composer.getByTestId("media-attachment-status").filter({ hasText: "Listo para analizar" })).toHaveCount(2)
})

test("refreshed chat reuses its 50 uploaded audios for analysis and a second failed-audio retry", async ({ page }) => {
  const files = Array.from({ length: 50 }, (_, index) => ({
    id: `historical-audio-${index}`, name: `recording-${index}.wav`, mimeType: "audio/wav", url: MOCK_WAV,
  }))
  const messages: unknown[] = [
    { id: "original-batch", chatId: chat.id, role: "USER", content: "transcribe los 50 audios", files: JSON.stringify(files), timestamp: "2026-08-26T00:00:00.000Z" },
    { id: "original-result", chatId: chat.id, role: "ASSISTANT", content: "Un audio no pudo transcribirse.", timestamp: "2026-08-26T00:00:01.000Z" },
    { id: "earlier-followup", chatId: chat.id, role: "USER", content: "analiza los audios", files: [], timestamp: "2026-08-26T00:00:02.000Z" },
    { id: "earlier-analysis", chatId: chat.id, role: "ASSISTANT", content: "Análisis parcial de la tanda.", timestamp: "2026-08-26T00:00:03.000Z" },
  ]
  await mockMediaPreviewApi(page, { messages })
  const tasks: any[] = []
  let uploadCalls = 0
  let inlineCalls = 0
  const followupApi = async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (path === "/files/upload") uploadCalls += 1
    if (path === "/ai/generate") inlineCalls += 1
    if (path !== "/agent/task") return route.fallback()
    const body = route.request().postDataJSON()
    tasks.push(body)
    const number = tasks.length
    messages.push(
      { id: `followup-${number}`, chatId: chat.id, role: "USER", content: body.goal, files: [], timestamp: `2026-08-26T00:00:0${number + 3}.000Z` },
      { id: `result-${number}`, chatId: chat.id, role: "ASSISTANT", content: `Seguimiento ${number} completado.`, timestamp: `2026-08-26T00:00:0${number + 4}.000Z` },
    )
    await route.fulfill({
      status: 200, contentType: "text/event-stream",
      body: [
        { type: "meta", taskId: `followup-task-${number}`, goal: body.goal, model: textModel.name, tools: [] },
        { type: "final_text", markdown: `Seguimiento ${number} completado.` },
        { type: "done" },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    })
  }
  await page.route("**/api/**", followupApi)
  await page.route("http://localhost:5000/**", followupApi)
  let composer = await openChatComposer(page)
  for (const [index, prompt] of ["analiza los50", "reintenta los audios fallidos"].entries()) {
    if (index > 0) {
      await page.reload({ waitUntil: "domcontentloaded" })
      composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()
      await expect(composer).toBeVisible({ timeout: 60000 })
    }
    await expect(composer.getByTestId("media-attachment-status")).toHaveCount(0)
    const input = composer.locator("textarea").first()
    await input.fill(prompt)
    await input.press("Enter")
    await expect.poll(() => tasks.length, { timeout: 30000 }).toBe(index + 1)
    expect(tasks[index].files).toEqual(files.map((file) => file.id))
    expect(tasks[index].model).toBe(textModel.name)
    await expect(page.getByText(`Seguimiento ${index + 1} completado.`, { exact: false }).first()).toBeVisible()
  }
  expect(uploadCalls).toBe(0)
  expect(inlineCalls).toBe(0)
})
