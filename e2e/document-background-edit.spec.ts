import { readFile } from "node:fs/promises"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { Document, Packer, Paragraph } from "docx"
import JSZip from "jszip"

test.describe.configure({ timeout: 240_000 })

const CHAT_ID = "document-background-chat"
const TASK_ID = "document-background-task"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const ALPHA_SENTINEL = "CENTINELA_DOCUMENTO_ALPHA"
const BETA_SENTINEL = "CENTINELA_DOCUMENTO_BETA"

const user = {
  id: "document-background-user",
  name: "Luis QA",
  email: "luis.qa@example.com",
  plan: "PRO",
  isAdmin: false,
  isSuperAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100_000,
  createdAt: "2026-08-05T14:00:00.000Z",
  updatedAt: "2026-08-05T14:00:00.000Z",
}

const model = {
  id: "document-background-model",
  name: "gpt-5",
  displayName: "GPT-5",
  provider: "OpenAI",
  type: "TEXT",
}

type Artifact = {
  id: string
  filename: string
  mime: string
  format: string
  sizeBytes: number
  downloadUrl: string
  validation: { passed: boolean }
  sourceFileId: string
}

type PersistedTaskState = {
  meta: { taskId: string; goal: string; model: string; tools: string[] }
  steps: Array<{
    id: string
    label: string
    status: "running" | "done"
    toolCalls: Array<Record<string, unknown>>
  }>
  artifacts: Artifact[]
  approvals: Array<Record<string, unknown>>
  checkpoints: Array<Record<string, unknown>>
  qualityGates: Array<Record<string, unknown>>
  repairs: Array<Record<string, unknown>>
  documentAnalysisIds: string[]
  evidenceRefs: Array<Record<string, unknown>>
  finalText: string
  done: boolean
  stoppedReason?: string
}

async function buildDocx(title: string, sentinel: string): Promise<Buffer> {
  const document = new Document({
    title,
    sections: [{
      children: [
        new Paragraph({ text: title, style: "Title" }),
        new Paragraph({ text: sentinel }),
        new Paragraph({ text: "Contenido original que debe conservarse." }),
      ],
    }],
  })
  return Packer.toBuffer(document)
}

function serializeTaskState(state: PersistedTaskState): string {
  const fence = "```agent-task-state\n" + JSON.stringify(state) + "\n```"
  return state.finalText ? `${fence}\n\n${state.finalText}` : fence
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

async function installDocumentTaskApi(page: Page) {
  const alphaBytes = await buildDocx("2027", ALPHA_SENTINEL)
  const betaBytes = await buildDocx("2027", BETA_SENTINEL)
  const artifacts: Artifact[] = [
    {
      id: "artifact-alpha",
      filename: "Modelo-Informe-Alpha-2027.docx",
      mime: DOCX_MIME,
      format: "docx",
      sizeBytes: alphaBytes.length,
      downloadUrl: "/api/agent/artifact/artifact-alpha",
      validation: { passed: true },
      sourceFileId: "source-alpha",
    },
    {
      id: "artifact-beta",
      filename: "Modelo-Informe-Beta-2027.docx",
      mime: DOCX_MIME,
      format: "docx",
      sizeBytes: betaBytes.length,
      downloadUrl: "/api/agent/artifact/artifact-beta",
      validation: { passed: true },
      sourceFileId: "source-beta",
    },
  ]

  const runningState: PersistedTaskState = {
    meta: {
      taskId: TASK_ID,
      goal: "Cambiar únicamente el título a 2027 en todos los documentos",
      model: model.name,
      tools: ["document_edit"],
    },
    steps: [{
      id: "document-edit",
      label: "Editando documentos originales",
      status: "running",
      toolCalls: [],
    }],
    artifacts: [],
    approvals: [],
    checkpoints: [],
    qualityGates: [],
    repairs: [],
    documentAnalysisIds: [],
    evidenceRefs: [],
    finalText: "",
    done: false,
  }
  const completedState: PersistedTaskState = {
    ...runningState,
    steps: runningState.steps.map(step => ({ ...step, status: "done" })),
    artifacts,
    finalText: "Listo. Edité ambos documentos en segundo plano y conservé sus contenidos originales.",
    done: true,
    stoppedReason: "source_preserving_document_edit",
  }

  let persistedState = runningState
  let allowCompletion = false
  let pendingRequests = 0
  let eventRequests = 0
  const downloadedArtifactIds: string[] = []

  await page.addInitScript(({ chatId }) => {
    localStorage.setItem("auth-token", "document-background-e2e-token")
    localStorage.setItem("currentChatId", chatId)
  }, { chatId: CHAT_ID })

  const chatPayload = () => ({
    id: CHAT_ID,
    title: "Edición documental en segundo plano",
    model: model.name,
    createdAt: "2026-08-05T14:00:00.000Z",
    updatedAt: "2026-08-05T14:00:03.000Z",
    messages: [
      {
        id: "document-background-user-message",
        chatId: CHAT_ID,
        role: "USER",
        content: "En todos estos documentos cambia únicamente el título a 2027 y devuélveme ambos Word.",
        timestamp: "2026-08-05T14:00:00.000Z",
      },
      {
        id: "document-background-assistant-message",
        chatId: CHAT_ID,
        role: "ASSISTANT",
        content: serializeTaskState(persistedState),
        timestamp: "2026-08-05T14:00:01.000Z",
        metadata: JSON.stringify({
          source: "agent-task",
          taskId: TASK_ID,
          status: persistedState.done ? "completed" : "running",
        }),
      },
    ],
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
        chats: [{ ...chatPayload(), messages: [] }],
        pagination: { page: 1, limit: 20, total: 1, pages: 1 },
      })
    }
    if (path === `/chats/${CHAT_ID}` && request.method() === "GET") {
      return fulfillJson(route, { chat: chatPayload() })
    }
    if (path === `/chats/${CHAT_ID}/pending-stream` && request.method() === "GET") {
      pendingRequests += 1
      const pointer = {
        taskId: TASK_ID,
        status: persistedState.done ? "completed" : "running",
        displayGoal: runningState.meta.goal,
        updatedAt: "2026-08-05T14:00:03.000Z",
      }
      return fulfillJson(route, {
        ok: true,
        pending: null,
        activeTasks: persistedState.done ? [] : [pointer],
        latestTask: pointer,
      })
    }
    if (path === `/agent/task/${TASK_ID}/events` && request.method() === "GET") {
      eventRequests += 1
      if (!allowCompletion) {
        return fulfillJson(route, {
          ok: true,
          status: "running",
          events: [{
            type: "checkpoint",
            id: "background-running",
            label: "Edición documental en curso",
            status: "running",
            seq: eventRequests,
          }],
          streamState: runningState,
        })
      }

      persistedState = completedState
      return fulfillJson(route, {
        ok: true,
        status: "completed",
        events: [
          { type: "file_artifact", artifact: artifacts[0], seq: eventRequests + 1 },
          { type: "file_artifact", artifact: artifacts[1], seq: eventRequests + 2 },
          { type: "final_text", markdown: completedState.finalText, seq: eventRequests + 3 },
          {
            type: "done",
            stoppedReason: completedState.stoppedReason,
            stats: { steps: 1, artifacts: 2 },
            seq: eventRequests + 4,
          },
        ],
        streamState: completedState,
      })
    }
    const artifactMatch = path.match(/^\/agent\/artifacts?\/(artifact-(?:alpha|beta))$/)
    if (artifactMatch && request.method() === "GET") {
      const artifactId = artifactMatch[1]
      downloadedArtifactIds.push(artifactId)
      const body = artifactId === "artifact-alpha" ? alphaBytes : betaBytes
      return route.fulfill({
        status: 200,
        contentType: DOCX_MIME,
        headers: {
          "Content-Disposition": `attachment; filename="${artifactId}.docx"`,
        },
        body,
      })
    }

    // Message persistence and unrelated chat bootstrap calls are not the
    // subject of this proof; acknowledge them without contacting a backend.
    return fulfillJson(route, { ok: true })
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)

  return {
    artifacts,
    allowTaskToComplete: () => { allowCompletion = true },
    evidence: {
      pendingRequests: () => pendingRequests,
      eventRequests: () => eventRequests,
      downloadedArtifactIds,
    },
  }
}

async function downloadFromCard(page: Page, card: Locator, filename: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: `Descargar documento: ${filename}` }).click(),
  ])
  expect(download.suggestedFilename()).toBe(filename)
  const downloadedPath = await download.path()
  expect(downloadedPath, `${filename} must be downloaded through the UI`).not.toBeNull()
  return readFile(downloadedPath!)
}

async function expectEditedDocx(
  buffer: Buffer,
  ownSentinel: string,
  otherSentinel: string,
) {
  const zip = await JSZip.loadAsync(buffer)
  const documentXmlEntry = zip.file("word/document.xml")
  expect(documentXmlEntry, "download must contain word/document.xml").not.toBeNull()
  const documentXml = await documentXmlEntry!.async("string")

  expect(documentXml).toMatch(/<w:t(?:\s[^>]*)?>2027<\/w:t>/)
  expect(documentXml).toMatch(/<w:pStyle[^>]*w:val="Title"[^>]*\/>[\s\S]*?<w:t(?:\s[^>]*)?>2027<\/w:t>/)
  expect(documentXml).toContain(ownSentinel)
  expect(documentXml).not.toContain(otherSentinel)
  expect(documentXml).not.toMatch(/ANEXOS/i)
}

test("recovers a persisted batch edit after reload and downloads both isolated DOCX results", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const task = await installDocumentTaskApi(page)

  await page.goto(`/chat?id=${CHAT_ID}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect.poll(task.evidence.pendingRequests, { timeout: 120_000 }).toBeGreaterThan(0)
  await expect.poll(task.evidence.eventRequests, { timeout: 120_000 }).toBeGreaterThan(0)

  // Reload while the durable task is still running. Recovery must discover the
  // same task again instead of starting a second document edit.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 })
  task.allowTaskToComplete()

  const cards = page.getByTestId("agent-artifact-card")
  await expect(cards).toHaveCount(2, { timeout: 120_000 })
  await expect.poll(task.evidence.pendingRequests).toBeGreaterThanOrEqual(2)
  await expect.poll(task.evidence.eventRequests).toBeGreaterThanOrEqual(2)

  const alphaCard = cards.filter({ hasText: task.artifacts[0].filename })
  const betaCard = cards.filter({ hasText: task.artifacts[1].filename })
  await expect(alphaCard).toBeVisible()
  await expect(betaCard).toBeVisible()
  await expect(alphaCard.getByText("Validado", { exact: true })).toBeVisible()
  await expect(betaCard.getByText("Validado", { exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(alphaCard.getByTestId("agent-artifact-filename")).toBeVisible()
  await expect(betaCard.getByTestId("agent-artifact-filename")).toBeVisible()
  expect(await alphaCard.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await betaCard.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  const alphaDownload = await downloadFromCard(page, alphaCard, task.artifacts[0].filename)
  const betaDownload = await downloadFromCard(page, betaCard, task.artifacts[1].filename)

  expect(task.evidence.downloadedArtifactIds).toEqual(["artifact-alpha", "artifact-beta"])
  await expectEditedDocx(alphaDownload, ALPHA_SENTINEL, BETA_SENTINEL)
  await expectEditedDocx(betaDownload, BETA_SENTINEL, ALPHA_SENTINEL)
})
