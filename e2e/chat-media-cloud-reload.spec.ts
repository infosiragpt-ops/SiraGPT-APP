import { readFile } from "node:fs/promises"
import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Real /agentes frontend with explicitly simulated HTTP APIs. This proves
 * client recovery and delivery rendering, not production transcription.
 * Reloading must only read the persisted job, never enqueue it again.
 */
test.describe.configure({ timeout: 180_000 })
test.use({ locale: "es-PE", viewport: { width: 1440, height: 900 } })

const CHAT_ID = "cloud-transcript-chat"
const FILE_ID = "cloud-transcript-source"
const DELIVERY_ID = "md_cloud_transcript"
const ACK = "Recibí la grabación de prueba. Te avisaré aquí cuando termine."
const TRANSCRIPT = "Transcripción simulada para verificar la entrega después de recargar.\n"
const artifact = {
  id: "cloud-transcript-txt",
  filename: "transcripcion-prueba.txt",
  format: "txt",
  mime: "text/plain",
  sizeBytes: Buffer.byteLength(TRANSCRIPT),
  downloadUrl: "/api/agent/artifact/cloud-transcript-txt",
}

const user = {
  id: "cloud-transcript-owner", name: "Usuario de prueba", email: "qa@example.test",
  plan: "PRO", isAdmin: false, isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100_000,
}

const metadata = { mediaDeliveryHandoff: DELIVERY_ID, transcriptionFileIds: [FILE_ID], stoppedReason: "media_delivery_handoff" }
const handoff = {
  id: "cloud-transcript-handoff", chatId: CHAT_ID, role: "ASSISTANT",
  timestamp: "2026-10-29T12:00:01.000Z", metadata,
  content: "```agent-task-state\n" + JSON.stringify({
    meta: metadata, steps: [], artifacts: [], done: true,
    stoppedReason: "media_delivery_handoff", finalText: ACK,
  }) + "\n```\n\n" + ACK,
}

async function installSimulatedMediaApi(page: Page) {
  let delivered = false
  let chatReads = 0
  const statusReads: string[][] = []
  const writes: string[] = []
  const errors: string[] = []
  const downloads: string[] = []

  const chat = () => ({
    id: CHAT_ID, title: "Transcripción en curso · prueba simulada", model: "deepseek-v4-flash",
    createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:02.000Z",
    messages: [
      { id: "cloud-transcript-request", chatId: CHAT_ID, role: "USER", content: "Transcribe la grabación de prueba.", timestamp: "2026-10-29T12:00:00.000Z" },
      handoff,
      ...(delivered ? [{
        id: "cloud-transcript-delivery", chatId: CHAT_ID, role: "ASSISTANT", timestamp: "2026-10-29T12:03:00.000Z",
        metadata: { source: "media-delivery", mediaDelivery: DELIVERY_ID, transcriptionFileIds: [FILE_ID], artifacts: [artifact] },
        content: "```agent-task-state\n" + JSON.stringify({
          // Match the compact envelope persisted by media-delivery.js;
          // optional agent-only arrays (e.g. repairs) are deliberately absent.
          steps: [], artifacts: [artifact], checkpoints: [], done: true,
          stoppedReason: "transcription_finalize", finalText: "La transcripción está lista para descargar.",
        }) + "\n```\n\nLa transcripción está lista para descargar.",
      }] : []),
    ],
  })
  const json = (route: Route, payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })

  await page.addInitScript(({ chatId }) => {
    localStorage.setItem("auth-token", "cloud-transcription-simulated-session")
    localStorage.setItem("currentChatId", chatId)
    localStorage.setItem("siragpt.locale", "es")
    document.cookie = "NEXT_LOCALE=es; path=/; samesite=lax"
  }, { chatId: CHAT_ID })
  page.on("pageerror", error => errors.push(error.message))

  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url())
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${path}`)
      return json(route, { error: "unexpected_write_during_read_only_recovery" }, 501)
    }
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 })
    if (path === "/auth/me") return json(route, { user })
    if (path === "/health") return json(route, { status: "healthy" })
    if (path === "/ai/models") return json(route, { models: [{ id: "cloud-transcript-model", name: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", provider: "DeepSeek", type: "TEXT", isActive: true }] })
    if (path === "/payments/subscription") return json(route, { plan: "PRO", status: "active", apiUsage: 0, monthlyLimit: 100_000 })
    if (path === "/users/me/notifications") return json(route, { items: [], unreadCount: 0 })
    if (path === "/cowork/approvals") return json(route, { approvals: [] })
    if (path === "/chats") return json(route, { chats: [{ ...chat(), messages: [] }], pagination: { page: 1, total: 1, pages: 1 } })
    if (path === `/chats/${CHAT_ID}`) { chatReads += 1; return json(route, { chat: chat() }) }
    if (path === `/chats/${CHAT_ID}/pending-stream`) return json(route, { ok: true, pending: null, activeTasks: [], latestTask: null })
    if (path === "/files/processing-status") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean)
      statusReads.push(ids)
      return json(route, { files: ids.filter(id => id === FILE_ID).map(id => ({
        id, processingStage: delivered ? "ready" : "extracting",
        processingProgress: delivered ? null : { stage: "transcribing", percent: 67, etaSeconds: 240 },
      })) })
    }
    if (path === "/agent/artifact/cloud-transcript-txt") {
      downloads.push(artifact.id)
      return route.fulfill({ status: 200, contentType: artifact.mime, headers: { "Content-Disposition": `attachment; filename="${artifact.filename}"` }, body: TRANSCRIPT })
    }
    return json(route, {})
  }
  await page.route("**/api/**", handle)
  await page.route("http://localhost:5000/**", handle)
  return { statusReads, writes, errors, downloads, chatReads: () => chatReads, deliver: () => { delivered = true } }
}

test("simulated API: reload retains cloud progress and reads the final delivery without resubmitting", async ({ page }, info) => {
  const state = await installSimulatedMediaApi(page)
  await page.goto(`/agentes?id=${CHAT_ID}`, { waitUntil: "domcontentloaded", timeout: 120_000 })

  const progress = page.locator("[data-cloud-task-status]")
  await expect(progress).toHaveCount(1, { timeout: 90_000 })
  await expect(progress).toContainText("67 %")
  await expect(page.getByText(ACK, { exact: true })).toBeVisible()
  expect(state.statusReads).not.toHaveLength(0)
  expect(state.statusReads.every(ids => ids.length === 1 && ids[0] === FILE_ID)).toBe(true)
  const beforeReload = state.statusReads.length
  const beforeReloadChatReads = state.chatReads()

  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(progress).toHaveCount(1, { timeout: 90_000 })
  await expect(progress).toContainText("67 %")
  await expect(page.getByText(ACK, { exact: true })).toBeVisible()
  await expect.poll(() => state.statusReads.length).toBeGreaterThan(beforeReload)
  expect(state.chatReads()).toBeGreaterThan(beforeReloadChatReads)
  expect(state.statusReads.every(ids => ids.length === 1 && ids[0] === FILE_ID)).toBe(true)
  expect(state.writes).toEqual([])
  await page.screenshot({ path: info.outputPath("simulated-cloud-progress-after-reload.png"), animations: "disabled" })

  state.deliver()
  // The production polling interval owns this transition: no navigation,
  // synthetic focus event or second prompt is needed to fetch the delivery.
  const card = page.getByTestId("agent-artifact-card").filter({ hasText: artifact.filename })
  await expect(card).toBeVisible({ timeout: 40_000 })
  await expect(progress).toHaveCount(0)
  await expect(page.getByText("La transcripción está lista para descargar.", { exact: true })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: `Descargar documento: ${artifact.filename}` }).click(),
  ])
  expect(download.suggestedFilename()).toBe(artifact.filename)
  const downloadedPath = await download.path()
  expect(downloadedPath).not.toBeNull()
  expect(await readFile(downloadedPath!, "utf8")).toBe(TRANSCRIPT)
  expect(state.downloads).toEqual([artifact.id])
  expect(state.writes).toEqual([])
  expect(state.errors).toEqual([])
  await page.screenshot({ path: info.outputPath("simulated-cloud-delivery.png"), animations: "disabled" })
})
