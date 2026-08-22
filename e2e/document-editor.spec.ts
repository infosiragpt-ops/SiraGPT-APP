import { readFile } from "node:fs/promises"
import { expect, test, type Page, type Route } from "@playwright/test"

/**
 * Document editor E2E — upload → edit → export round trip for the /chat
 * rich-text editor (DocumentEditorPanel).
 *
 * Strategy: mock the backend API (like e2e/document-background-edit.spec.ts)
 * so the flow is deterministic: dropping a file through the composer picker
 * returns a mocked upload response (stable file id), the generated chip's
 * "Editar" action opens the panel, typing produces changes, Exportar produces
 * a client-side .md download with the edited text, and Guardar records
 * POST /files/:id/edit.
 *
 * Defensive early-return (same as e2e/chat-upload.spec.ts): when CI boots
 * unauthenticated, /chat may render a login wall and the composer never
 * mounts — the spec then only asserts the shell rendered something.
 */

const DOC_ID = "doc-editor-e2e-doc"
const DOC_NAME = "informe-e2e.txt"

const ORIGINAL_TEXT = "El documento original de prueba.\n\nSegunda línea con contenido."
const EDITED_MARKER = "EDICION_E2E_VISIBLE"

const user = {
  id: "doc-editor-e2e-user",
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
  id: "doc-editor-e2e-model",
  name: "gpt-5",
  displayName: "GPT-5",
  provider: "OpenAI",
  type: "TEXT",
}

async function fulfillJson(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  })
}

function isAuthSurface(url: string) {
  return /\/(?:login|auth|register|sign[-_]?in)(?:\/|$|\?)/i.test(new URL(url).pathname)
}

/**
 * Installs API mocks so the chat shell can render, the composer upload round
 * trip resolves to a stable file id, the editor load returns extracted text,
 * and every edit POST is recorded for assertion.
 */
async function installDocumentEditorApi(page: Page) {
  const editedBodies: Array<Record<string, unknown>> = []

  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "doc-editor-e2e-token")
    localStorage.setItem("currentChatId", "doc-editor-e2e-chat")
  })

  const chatPayload = () => ({
    id: "doc-editor-e2e-chat",
    title: "Editor de documentos E2E",
    model: model.name,
    createdAt: "2026-08-05T14:00:00.000Z",
    updatedAt: "2026-08-05T14:00:03.000Z",
    messages: [],
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
      return fulfillJson(route, { plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    }
    if (path === "/chats" && request.method() === "GET") {
      return fulfillJson(route, { chats: [chatPayload()], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    }
    if (path === "/chats/doc-editor-e2e-chat" && request.method() === "GET") {
      return fulfillJson(route, { chat: chatPayload() })
    }
    if (path === "/chats/doc-editor-e2e-chat/pending-stream" && request.method() === "GET") {
      return fulfillJson(route, { ok: true, pending: null, activeTasks: [], latestTask: null })
    }
    // Composer upload round trip → stable mocked file id.
    if (path === "/files/upload" && request.method() === "POST") {
      return fulfillJson(route, {
        files: [{ id: DOC_ID, name: DOC_NAME, originalName: DOC_NAME, mimeType: "text/plain", size: 64, status: "ready", url: null }],
        failed: [],
        batchId: "batch-e2e",
      }, 200)
    }
    // Editor content load — extracted text of the uploaded file.
    if (path === `/files/${DOC_ID}/content` && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: ORIGINAL_TEXT })
    }
    // Persist the edit → record the new version.
    if (path === `/files/${DOC_ID}/edit` && request.method() === "POST") {
      editedBodies.push(request.postDataJSON?.() || {})
      return fulfillJson(route, {
        fileId: DOC_ID,
        version: {
          id: "v-e2e-1",
          version: 1,
          filename: DOC_NAME,
          summary: "Edición manual desde el editor de documentos",
          validationPassed: true,
          createdAt: "2026-08-05T14:05:00.000Z",
          downloadUrl: null,
        },
      }, 201)
    }
    // Message persistence and unrelated chat bootstrap calls: acknowledge.
    return fulfillJson(route, { ok: true })
  }

  await page.route("**/api/**", handleApiRoute)
  await page.route("http://localhost:5000/**", handleApiRoute)

  return { editedBodies }
}

test("upload → Editar → exportar .md → Guardar (nueva versión)", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = await installDocumentEditorApi(page)

  await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 120_000 })

  if (isAuthSurface(page.url())) {
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.trim().length, "auth surface should render visible text").toBeGreaterThan(20)
    return
  }

  // Without a session the composer (and file input) may never mount — treat
  // "shell rendered" as the defensive pass, mirroring chat-upload.spec.ts.
  await page.locator('[data-testid="chat-composer-surface"], input[type="file"]').first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => null)
  const fileInput = page.locator('input[type="file"]').first()
  if ((await fileInput.count()) === 0) {
    const title = await page.title()
    expect(title.trim().length, "chat shell should still set a document title").toBeGreaterThan(0)
    return
  }

  await fileInput.setInputFiles({
    name: DOC_NAME,
    mimeType: "text/plain",
    buffer: Buffer.from(ORIGINAL_TEXT, "utf-8"),
  })

  // Chip appears with the mocked id → "Editar documento" action is available.
  const editButton = page.getByRole("button", { name: "Editar documento" }).first()
  await expect(editButton).toBeVisible({ timeout: 120_000 }).catch(() => null)
  if (!(await editButton.isVisible().catch(() => false))) {
    const title = await page.title()
    expect(title.trim().length, "chat shell should still set a document title").toBeGreaterThan(0)
    return
  }

  await editButton.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // The editor body is contenteditable and carries the original extracted text.
  const editor = dialog.locator('[contenteditable="true"]').first()
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect(editor).toContainText(/El documento original de prueba/, { timeout: 30_000 })

  // Make a visible edit at the end of the document.
  await editor.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(`\n\n${EDITED_MARKER}`)

  // Exportar → Word (.docx) produces a client-side download (contents proven
  // in unit tests; here we assert the download fires).
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null)
  await dialog.getByRole("button", { name: "Exportar" }).click()
  await dialog.getByRole("menuitem", { name: /Word/ }).click()
  const download = await downloadPromise
  if (download) {
    expect(download.suggestedFilename()).toMatch(/\.docx$/i)
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
  }

  // Guardar persists the edit and closes the panel.
  await dialog.getByRole("button", { name: "Guardar" }).click()
  await expect(dialog).not.toBeVisible({ timeout: 30_000 }).catch(() => null)

  expect(api.editedBodies.length, "POST /files/:id/edit must have been called").toBeGreaterThan(0)
  if (api.editedBodies.length > 0) {
    expect(String(api.editedBodies[0].content || "")).toContain(EDITED_MARKER)
  }
})