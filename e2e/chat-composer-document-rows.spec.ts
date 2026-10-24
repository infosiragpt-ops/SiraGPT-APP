import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// Exercise the actual picker, upload transport and composer. Only server APIs
// are replaced: these checks need no account, model call or production data.
test.describe.configure({ timeout: 180_000 })
test.use({ locale: "es-PE" })

const pdfName = "COMPLETO - Guia_Trabajo_Suficiencia_Profesional.pdf"
const wordName = "COR-F-REC-VAC-05.15_9 (Todas las facultades excepto Arquitectura) (2).docx"
const processingLabel = "Subido · Extrayendo texto"
type RecordState = { id: string; name: string; processingStage: string; processingError?: string | null }

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) })
}

async function mockComposerApi(page: Page, processingName?: string) {
  const state = { records: [] as RecordState[], uploads: [] as string[] }
  await page.addInitScript(() => {
    localStorage.setItem("auth-token", "composer-document-test-token")
    localStorage.removeItem("currentChatId")
  })
  const handle = async (route: Route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api(?=\/|$)/, "")
    if (pathname === "/auth/me") return json(route, { user: {
      id: "composer-document-user", name: "Pruebas de documentos", email: "documents@example.com",
      plan: "PRO", isAdmin: false, isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100_000,
    } })
    if (pathname === "/health") {
      if (request.method() === "HEAD") return route.fulfill({ status: 204 })
      return json(route, { status: "healthy" })
    }
    if (pathname === "/ai/models") return json(route, { models: [{
      id: "document-test-model", name: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash",
      provider: "DeepSeek", type: "TEXT", isActive: true,
    }] })
    if (pathname === "/payments/subscription") return json(route, {
      plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000,
    })
    if (pathname === "/chats") return json(route, {
      chats: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 },
    })
    if (pathname === "/files/upload") {
      const body = request.postDataBuffer()?.toString() || ""
      state.uploads.push(body)
      const names = Array.from(body.matchAll(/filename="([^"]+)"/g), (match) => match[1])
      const uploaded = names.map((name) => {
        const record = {
          id: `document-picker-${state.records.length + 1}`, name,
          processingStage: name === processingName ? "extracting" : "ready",
        }
        state.records.push(record)
        return {
          ...record, originalName: name, size: 128, success: true,
          type: name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".docx")
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain",
          url: `/api/files/${record.id}`,
        }
      })
      return json(route, { files: uploaded }, 202)
    }
    const statusMatch = pathname.match(/^\/files\/([^/]+)\/processing-status$/)
    if (statusMatch) {
      const record = state.records.find((item) => item.id === statusMatch[1])
      if (!record) return json(route, {}, 404)
      return json(route, {
        fileId: record.id, stage: record.processingStage, error: record.processingError || null,
        stageAt: "2026-10-24T16:00:00.000Z", isTerminal: ["ready", "failed"].includes(record.processingStage),
      })
    }
    return json(route, {})
  }
  await page.route("**/api/**", handle)
  await page.route("http://localhost:5000/**", handle)
  return state
}

async function openComposer(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
  const composer = page.locator('[data-testid="chat-composer-surface"]:visible').last()
  await expect(composer).toBeVisible({ timeout: 120_000 })
  // The development badge can cover the mobile + control. It is not app UI.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
  await page.evaluate(() => document.fonts.ready)
  return composer
}

async function rowGeometry(row: Locator) {
  return row.evaluate((element) => {
    const open = element.querySelector<HTMLButtonElement>('button[aria-label^="Abrir "]')!
    const icon = open.querySelector("svg")!
    const rect = element.getBoundingClientRect()
    const iconRect = icon.getBoundingClientRect()
    return {
      width: rect.width, height: rect.height, fontSize: getComputedStyle(open).fontSize,
      iconWidth: iconRect.width, iconHeight: iconRect.height,
    }
  })
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`document rows preserve compact geometry and extensions at ${viewport.width}px`, async ({ page }, testInfo) => {
    const state = await mockComposerApi(page, wordName)
    const composer = await openComposer(page, viewport)
    await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
    await page.locator('input[data-accepts-any-format="true"]').first().setInputFiles([
      { name: pdfName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nDocument picker fixture") },
      { name: wordName, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("Document picker Word fixture") },
    ])
    await page.keyboard.press("Escape")
    const rows = composer.getByTestId("composer-document-row")
    await expect(rows).toHaveCount(2)
    await expect.poll(() => state.records.length).toBe(2)
    const expectedHeight = viewport.width < 640 ? 32 : 24
    await expect.poll(async () => Math.round((await rowGeometry(rows.first())).height)).toBe(expectedHeight)
    for (const [index, name] of [pdfName, wordName].entries()) {
      const row = rows.nth(index)
      const open = row.getByRole("button", { name: `Abrir ${name}`, exact: true })
      await expect(open).toHaveAttribute("title", new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      const geometry = await rowGeometry(row)
      expect(geometry.width).toBeLessThanOrEqual(256)
      expect(geometry.fontSize).toBe("13px")
      expect(geometry.iconWidth).toBe(16)
      expect(geometry.iconHeight).toBe(16)
      expect(Math.round(geometry.height)).toBe(expectedHeight)
      const extension = path.extname(name)
      // The tail remains in a visible, unshrinking element when the prefix
      // overflows. Checking layout here catches a return to end truncation.
      const tail = open.locator("span").filter({ hasText: new RegExp(`${extension.replace(".", "\\.")}$`) }).last()
      await expect(tail).toBeVisible()
      expect(await tail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await open.evaluate((element) => Array.from(element.querySelectorAll("span")).some((span) =>
        getComputedStyle(span).textOverflow === "ellipsis" && span.scrollWidth > span.clientWidth,
      ))).toBe(true)
    }
    const busyRow = rows.nth(1)
    const busy = busyRow.getByRole("status", { name: processingLabel, exact: true })
    await expect(busy).toBeVisible()
    const busyBox = await busy.boundingBox()
    expect(busyBox?.width).toBe(14)
    expect(busyBox?.height).toBe(14)
    const phase = busyRow.getByText(processingLabel, { exact: true })
    await expect(phase).toHaveCount(1)
    expect(await phase.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.width <= 1 && rect.height <= 1
    })).toBe(true)
    const before = await rowGeometry(busyRow)
    await composer.locator("textarea").click()
    await page.mouse.move(0, 0)
    await composer.screenshot({ path: testInfo.outputPath(`compact-documents-${viewport.width}.png`), animations: "disabled" })
    state.records.find((record) => record.name === wordName)!.processingStage = "ready"
    await expect(phase).toHaveCount(0, { timeout: 15_000 })
    expect(await rowGeometry(busyRow)).toEqual(before)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await busyRow.getByRole("button", { name: `Quitar ${wordName}`, exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first().getByRole("button", { name: `Abrir ${pdfName}`, exact: true })).toBeVisible()
  })
}

test("a processing failure remains visible below its compact row and retains retry", async ({ page }, testInfo) => {
  const state = await mockComposerApi(page, pdfName)
  const composer = await openComposer(page, { width: 1440, height: 900 })
  await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
  await page.locator('input[data-accepts-any-format="true"]').first().setInputFiles({
    name: pdfName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nFailure-state fixture"),
  })
  await page.keyboard.press("Escape")
  await expect.poll(() => state.records.length).toBe(1)
  state.records[0].processingStage = "failed"
  state.records[0].processingError = "processing: fixture failure"
  const row = composer.getByTestId("composer-document-row")
  const failure = row.getByText("No se pudo procesar el documento", { exact: true })
  await expect(failure).toBeVisible({ timeout: 15_000 })
  const open = row.getByRole("button", { name: `Abrir ${pdfName}`, exact: true })
  await expect(open).toHaveAttribute("aria-disabled", "true")
  await expect(row.getByRole("button", { name: `Reintentar ${pdfName}`, exact: true })).toBeVisible()
  const openBox = await open.boundingBox()
  const errorBox = await failure.boundingBox()
  expect(errorBox!.y).toBeGreaterThanOrEqual(openBox!.y + openBox!.height)
  await composer.screenshot({ path: testInfo.outputPath("document-error.png"), animations: "disabled" })
})

test("the folder picker uploads nested documents and excludes operating-system and secret files", async ({ page }, testInfo) => {
  const state = await mockComposerApi(page)
  const composer = await openComposer(page, { width: 1440, height: 900 })
  const folder = testInfo.outputPath("Documentos")
  await mkdir(path.join(folder, "Legal"), { recursive: true })
  await mkdir(path.join(folder, "Administracion"), { recursive: true })
  await Promise.all([
    writeFile(path.join(folder, "Legal", "informe.txt"), "Contenido de prueba idéntico"),
    writeFile(path.join(folder, "Administracion", "informe.txt"), "Contenido de prueba idéntico"),
    writeFile(path.join(folder, ".DS_Store"), "Metadatos sintéticos"),
    writeFile(path.join(folder, ".env"), "FIXTURE_ONLY=true"),
  ])
  await composer.getByRole("button", { name: "Adjuntar archivos y herramientas" }).click()
  const labels = (await page.locator(".chat-tools-menu [role='menuitem']:visible").allInnerTexts()).map((text) => text.split("\n")[0].trim())
  const upload = labels.indexOf("Subir documento")
  expect(upload).toBeGreaterThanOrEqual(0)
  expect(labels[upload + 1]).toBe("Agregar carpeta")
  const chooserPromise = page.waitForEvent("filechooser")
  await page.getByTestId("composer-add-folder").click()
  const chooser = await chooserPromise
  expect(await chooser.element().getAttribute("data-testid")).toBe("composer-folder-input")
  await chooser.setFiles(folder)
  await expect.poll(() => state.records.length).toBe(2)
  expect(state.records.map((record) => record.name)).toEqual(["informe.txt", "informe.txt"])
  expect(state.uploads.join("\n")).toContain("folder-picker")
  expect(state.uploads.join("\n")).not.toContain("FIXTURE_ONLY")
  expect(state.uploads.join("\n")).not.toContain(".DS_Store")
  const rows = composer.getByTestId("composer-document-row")
  await expect(rows).toHaveCount(2)
  const titles = await rows.locator('button[aria-label="Abrir informe.txt"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute("title")))
  expect(titles.some((title) => title?.includes("Documentos/Legal/informe.txt"))).toBe(true)
  expect(titles.some((title) => title?.includes("Documentos/Administracion/informe.txt"))).toBe(true)
  await composer.screenshot({ path: testInfo.outputPath("folder-documents.png"), animations: "disabled" })
  await rows.first().getByRole("button", { name: "Quitar informe.txt", exact: true }).click()
  await expect(rows).toHaveCount(1)
})
