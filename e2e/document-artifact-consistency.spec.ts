import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { Document, Packer, Paragraph } from "docx"
import ExcelJS from "exceljs"
import JSZip from "jszip"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

/**
 * Browser UI regression, NOT an editing-engine/conversion acceptance test.
 * Auth, API responses and Office-to-PDF conversion are intercepted. PDF.js
 * renders real three-page PDF bytes; downloads retain real synthetic Office
 * bytes. No backend, account, provider, production URL or new dependency.
 */
test.describe.configure({ timeout: 180_000 })
test.use({ serviceWorkers: "block" })

const formats = ["docx", "xlsx", "pptx", "pdf"] as const
type Format = typeof formats[number]
type Edition = "original" | "editado"
type Fixture = { id: string; filename: string; format: Format; edition: Edition; bytes: Buffer; pdf: Buffer; url: string }
const mime: Record<Format, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
}
const logo: Record<Format, string> = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", pdf: "PDF" }
const chatId = "document-artifact-consistency-qa"
const timestamp = "2026-09-05T15:00:00.000Z"
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname)

async function buildPdf(format: Format, edition: Edition): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= 3; page++) {
    const [width, height] = format === "pptx" ? [960, 540] : [595, 842]
    const sheet = pdf.addPage([width, height])
    sheet.drawRectangle({ x: 0, y: height - 110, width, height: 110, color: rgb(0.04, 0.15, 0.28) })
    sheet.drawText(`QA ${format.toUpperCase()} ${edition}`, { x: 36, y: height - 55, size: 24, font, color: rgb(1, 1, 1) })
    sheet.drawText(`PAGINA ${page} DE 3`, { x: 36, y: height - 175, size: 28, font })
    sheet.drawText("Documento sintetico de QA. No acredita conversion ni edicion.", { x: 36, y: height - 215, size: 11, font })
  }
  return Buffer.from(await pdf.save())
}

async function buildOffice(format: Format, edition: Edition): Promise<Buffer> {
  const title = `QA ${format.toUpperCase()} ${edition}`
  if (format === "docx") return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(title), new Paragraph("Contenido sintetico sin datos de usuarios.")] }] }))
  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet("QA").addRows([[title], ["Dato", "Valor"], ["Prueba", 2027]])
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }
  if (format === "pptx") {
    // Minimal real OOXML package, generated with the root's existing JSZip.
    // The frontend-only CI job does not install backend/pptxgenjs. Conversion
    // remains explicitly intercepted; this package is only download evidence.
    const zip = new JSZip()
    const rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    const presentation = "http://schemas.openxmlformats.org/presentationml/2006/main"
    const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main"
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${[1, 2, 3].map(page => `<Override PartName="/ppt/slides/slide${page}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`)
    zip.file("_rels/.rels", `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`)
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${presentation}" xmlns:r="${office}"><p:sldIdLst>${[1, 2, 3].map(page => `<p:sldId id="${255 + page}" r:id="rId${page}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${rel}">${[1, 2, 3].map(page => `<Relationship Id="rId${page}" Type="${office}/slide" Target="slides/slide${page}.xml"/>`).join("")}</Relationships>`)
    for (let page = 1; page <= 3; page++) zip.file(`ppt/slides/slide${page}.xml`, `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="QA Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="9144000" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="es-ES" sz="3000"/><a:t>${title} - Diapositiva ${page}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
    return zip.generateAsync({ type: "nodebuffer" })
  }
  return buildPdf(format, edition)
}

async function buildFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = []
  for (const edition of ["original", "editado"] as const) {
    for (const [index, format] of formats.entries()) {
      // The real preview URL resolver intentionally accepts hex artifact IDs.
      const id = `${edition === "original" ? "a" : "b"}${String(index + 1).padStart(15, "0")}`
      const filename = `Informe-QA-${edition}.${format}`
      fixtures.push({ id, filename, format, edition, bytes: await buildOffice(format, edition), pdf: await buildPdf(format, edition), url: `/api/agent/artifact/${id}?name=${filename}` })
    }
  }
  return fixtures
}

async function installFixture(context: BrowserContext, baseURL: string, fixtures: Fixture[]) {
  expect(loopback(new URL(baseURL).hostname), "This fixture must never run against production").toBe(true)
  const errors: string[] = []
  const externalRequests: string[] = []
  const user = { id: "document-artifact-qa-user", name: "QA Documentos", email: "qa@example.test", plan: "PRO", isAdmin: false, isSuperAdmin: false, apiUsage: 0, monthlyLimit: 100_000, createdAt: timestamp, updatedAt: timestamp }
  const model = { id: "qa-text", name: "qa-text", displayName: "Sira QA", provider: "QA", type: "TEXT", isActive: true }
  const state = {
    meta: { taskId: "qa-document-task", goal: "Ver documentos sinteticos", model: model.name, tools: [] },
    steps: [], artifacts: fixtures.filter(f => f.edition === "editado").map(f => ({ id: f.id, filename: f.filename, mime: mime[f.format], format: f.format, sizeBytes: f.bytes.length, downloadUrl: f.url, sourceFileId: `source-${f.id}` })),
    approvals: [], checkpoints: [], qualityGates: [], repairs: [], documentAnalysisIds: [], evidenceRefs: [],
    done: true, finalText: "Versiones editadas de fixture, sin ejecutar un modelo.",
  }
  const chat = {
    id: chatId, title: "QA tarjetas y visor", model: model.name, createdAt: timestamp, updatedAt: timestamp,
    messages: [
      { id: "qa-user-message", chatId, role: "USER", content: "Comparar documentos sinteticos.", timestamp },
      { id: "qa-originals", chatId, role: "ASSISTANT", content: "Primera version de fixture.", timestamp, files: fixtures.filter(f => f.edition === "original").map(f => ({ type: "doc", format: f.format, filename: f.filename, url: f.url, mime: mime[f.format], size: f.bytes.length })) },
      { id: "qa-edits", chatId, role: "ASSISTANT", content: "```agent-task-state\n" + JSON.stringify(state) + "\n```", timestamp },
    ],
  }
  await context.addInitScript(({ id }) => {
    localStorage.setItem("auth-token", "local-browser-fixture-only")
    localStorage.setItem("currentChatId", id)
    localStorage.setItem("theme", "light")
  }, { id: chatId })
  await context.route("**/*", async route => {
    const url = new URL(route.request().url())
    if (!["http:", "https:"].includes(url.protocol)) return route.continue()
    if (!loopback(url.hostname)) {
      // Keep QA offline; fallback font is intentional and not typography proof.
      if (url.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "/* Offline QA uses fallback font. */" })
      externalRequests.push(`${url.origin}${url.pathname}`)
      return route.abort("blockedbyclient")
    }
    if (!url.pathname.startsWith("/api/") && url.origin === new URL(baseURL).origin) return route.continue()
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "")
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    if (path === "/auth/me") return json({ user })
    if (path.startsWith("/health")) return route.request().method() === "HEAD" ? route.fulfill({ status: 204 }) : json({ status: "healthy" })
    if (path === "/cowork/approvals") return json({ approvals: [] })
    if (path === "/users/me/notifications") return json({ items: [], unreadCount: 0 })
    if (path === "/ai/models") return json({ models: [model] })
    if (path === "/payments/subscription") return json({ plan: "PRO", status: "active", subscription: null, apiUsage: 0, monthlyLimit: 100_000 })
    if (path === "/chats") return json({ chats: [{ ...chat, messages: [] }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } })
    if (path === `/chats/${chatId}`) return json({ chat })
    if (path.endsWith("/pending-stream")) return json({ ok: true, pending: null, activeTasks: [], latestTask: null })
    const match = path.match(/^\/agent\/artifact\/([ab][0-9]{15})(\/preview\.pdf)?$/)
    if (match) {
      const f = fixtures.find(fixture => fixture.id === match[1])!
      return route.fulfill({ status: 200, contentType: match[2] ? "application/pdf" : mime[f.format], headers: match[2] ? {} : { "Content-Disposition": `attachment; filename="${f.filename}"` }, body: match[2] ? f.pdf : f.bytes })
    }
    if (/generate|agent\/task.*start|doc.*edit/.test(path)) throw new Error(`Unexpected engine/write route: ${path}`)
    return json({ ok: true })
  })
  return { errors, externalRequests }
}

function cardFor(page: Page, fixture: Fixture): Locator {
  return page.getByTestId(fixture.edition === "original" ? "generated-document-card" : "agent-artifact-card").filter({ hasText: fixture.filename })
}

async function verifyDownload(page: Page, card: Locator, fixture: Fixture) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: `Descargar documento: ${fixture.filename}`, exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe(fixture.filename)
  expect(sha256(await readFile((await download.path())!))).toBe(sha256(fixture.bytes))
}

async function settledPdfPage(shell: Locator, pageNumber: number) {
  const renderedPage = shell.locator(`[data-page-num="${pageNumber}"]`)
  await expect.poll(async () => renderedPage.locator("canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext("2d")
    if (!context || canvas.width < 20 || canvas.height < 20) return false
    // The actual fixture paints a navy rectangle across the PDF's top edge.
    // A visible canvas element/changed width is insufficient: after zoom,
    // react-pdf may still be rasterizing into a white/transparent canvas.
    const [red, green, blue, alpha] = context.getImageData(10, 10, 1, 1).data
    return alpha === 255 && red < 100 && green < 100 && blue < 160
  }), { message: `Page ${pageNumber} must contain its real rasterized PDF pixels` }).toBe(true)
  await expect.poll(async () => renderedPage.evaluate(element => {
    const scrollport = element.closest(".overflow-auto")
    if (!scrollport) return false
    const page = element.getBoundingClientRect()
    const viewport = scrollport.getBoundingClientRect()
    const topOffset = page.top - viewport.top
    // A short landscape document may fit entirely in the viewport. In that
    // case scrollIntoView cannot align page 2 to the top: reaching the end of
    // available scroll is valid, but the requested page must remain legible.
    const atEnd = scrollport.scrollTop + scrollport.clientHeight >= scrollport.scrollHeight - 2
    return ((topOffset >= -2 && topOffset <= 24) || atEnd) && page.left >= viewport.left - 1
  }), { message: `Page ${pageNumber} must be positioned within available scrolling, without clipped left edge` }).toBe(true)
  // IntersectionObserver reports floating-point ratios slightly below 1 for
  // fully visible glyph bounds at fractional PDF scales.
  await expect(renderedPage.getByText(`PAGINA ${pageNumber} DE 3`, { exact: true })).toBeInViewport({ ratio: 0.99 })
  await expect(shell.getByRole("spinbutton", { name: "Número de página", exact: true })).toHaveValue(String(pageNumber))
}

async function verifyViewer(page: Page, fixture: Fixture, options: { keepOpen?: boolean } = {}) {
  await cardFor(page, fixture).getByRole("button", { name: `Ver documento: ${fixture.filename}`, exact: true }).click()
  const shell = page.getByTestId("document-preview-shell")
  await expect(shell).toBeVisible()
  await expect(shell.locator("canvas").first()).toBeVisible({ timeout: 60_000 })
  const header = shell.getByTestId("document-preview-header")
  await expect(header.getByTestId("pdf-preview-controls")).toBeVisible()
  await expect(shell.getByTestId("pdf-preview-controls")).toHaveCount(1)
  await expect(shell.getByText(`QA ${fixture.format.toUpperCase()} ${fixture.edition}`, { exact: true }).first()).toBeVisible()
  const pageInput = shell.getByRole("spinbutton", { name: "Número de página", exact: true })
  await expect(pageInput).toHaveValue("1")
  await settledPdfPage(shell, 1)
  await expect(header.getByRole("button", { name: "Página anterior", exact: true })).toBeDisabled()
  const next = header.getByRole("button", { name: "Página siguiente", exact: true })
  expect((await next.boundingBox())!.y - (await shell.boundingBox())!.y).toBeLessThan(140)
  const firstPageWidth = await shell.locator("canvas").first().evaluate(element => element.getBoundingClientRect().width)
  await next.click()
  await settledPdfPage(shell, 2)
  const secondPageRasterWidth = await shell.locator('[data-page-num="2"] canvas').evaluate(element => (element as HTMLCanvasElement).width)
  await header.getByRole("button", { name: "Aumentar zoom", exact: true }).click()
  await expect.poll(() => shell.locator("canvas").first().evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(firstPageWidth)
  // Wait for page 2's new raster dimensions too, not merely page 1's CSS.
  // Sampling an old canvas while another page resizes can hide a blank frame.
  await expect.poll(() => shell.locator('[data-page-num="2"] canvas').evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(secondPageRasterWidth)
  await settledPdfPage(shell, 2)
  await header.getByRole("button", { name: "Página anterior", exact: true }).click()
  await settledPdfPage(shell, 1)
  await next.click()
  await settledPdfPage(shell, 2)
  if (!options.keepOpen) {
    // Do not force click or suppress notifications: this catches download
    // success toasts that used to cover the real close control indefinitely.
    await header.getByRole("button", { name: "Cerrar previsualización", exact: true }).click()
    await expect(shell).toHaveCount(0)
  }
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]] as const) {
  test(`${name}: original and edited document cards share icons; PDF controls navigate and zoom from the header`, async ({ context, page, baseURL }) => {
    expect(baseURL).toBeTruthy()
    const fixtures = await buildFixtures()
    const evidence = await installFixture(context, baseURL!, fixtures)
    page.on("pageerror", error => evidence.errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") evidence.errors.push(message.text()) })
    await page.setViewportSize(viewport)
    await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 120_000 })
    expect(new URL(page.url()).pathname).toBe("/agentes")
    await expect(page).toHaveTitle(/SiraGPT/)
    await expect(page.getByTestId("generated-document-card")).toHaveCount(4, { timeout: 120_000 })
    await expect(page.getByTestId("agent-artifact-card")).toHaveCount(4)
    for (const fixture of fixtures) {
      const card = cardFor(page, fixture)
      await expect(card).toHaveCount(1)
      await card.scrollIntoViewIfNeeded()
      const icon = card.getByRole("img", { name: logo[fixture.format], exact: true })
      await expect(icon).toBeVisible()
      const image = await icon.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, naturalWidth: (element as HTMLImageElement).naturalWidth }))
      expect(image.width).toBe(40)
      expect(image.height).toBe(40)
      expect(image.naturalWidth).toBeGreaterThan(0)
      await expect(card.getByRole("button", { name: `Ver documento: ${fixture.filename}`, exact: true })).toBeVisible()
      await expect(card.locator("button")).toHaveCount(fixture.edition === "original" ? 2 : 3)
      if (name === "desktop") await verifyDownload(page, card, fixture)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    // Original and edited Office previews plus native PDFs use actual PDF.js.
    // Mobile repeats portrait/landscape previews; desktop covers every format.
    for (const fixture of fixtures.filter(f => name === "desktop" || f.format === "pptx" || f.format === "pdf")) await verifyViewer(page, fixture)
    if (name === "desktop") {
      // Change an open three-page document after navigation+manual zoom. The
      // replacement must reset to its own bytes/page 1, not retain stale state.
      await verifyViewer(page, fixtures[0], { keepOpen: true })
      await verifyViewer(page, fixtures[6])
    }
    expect(evidence.externalRequests).toEqual([])
    expect(evidence.errors).toEqual([])
  })
}
