import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const viewerSourcePath = path.join(process.cwd(), "components/viewers/UnifiedDocumentViewer.tsx")
const generatedPreviewSourcePath = path.join(process.cwd(), "components/document-preview.tsx")

function viewerSource(): string {
  return readFileSync(viewerSourcePath, "utf8")
}

test("PDF preview uses a bundled/local pdf.js worker instead of a CDN worker", () => {
  const source = viewerSource()

  assert.doesNotMatch(
    source,
    /https:\/\/unpkg\.com\/pdfjs-dist/,
    "a CDN worker can be blocked/offline and leave PDF previews blank",
  )
  assert.match(
    source,
    /pdfjs\.GlobalWorkerOptions\.workerSrc\s*=\s*new URL\(\s*["']pdfjs-dist\/build\/pdf\.worker\.min\.mjs["'],\s*import\.meta\.url\s*\)\.toString\(\)/,
    "the viewer should bundle the exact pdfjs worker with the app",
  )
})

test("generated Office previews use the shared pdf.js renderer instead of a native PDF iframe", () => {
  const source = readFileSync(generatedPreviewSourcePath, "utf8")

  assert.match(
    source,
    /import\("@\/components\/viewers\/UnifiedDocumentViewer"\)\.then\(module => module\.PdfRenderer\)/,
    "generated artifacts must lazily reuse the tested pdf.js renderer",
  )
  assert.match(source, /import type \{ AttachmentLike \} from "@\/components\/viewers\/UnifiedDocumentViewer"/)
  assert.match(source, /ssr: false/)
  assert.doesNotMatch(
    source,
    /import \{[^}]*PdfRenderer[^}]*\} from "@\/components\/viewers\/UnifiedDocumentViewer"/,
    "the generated preview must not pull the full document viewer into the eager chat bundle",
  )
  assert.match(source, /<PdfRenderer a=\{pdfPreviewAttachment\} \/>/)
  assert.doesNotMatch(
    source,
    /state\.kind === "pdfBlob"[\s\S]{0,180}<iframe/,
    "native PDF iframes render as a blank panel on Safari and some embedded browsers",
  )
})

test("office previews wait on the server object instead of painting local File pages mid-upload", () => {
  const source = viewerSource()

  assert.doesNotMatch(
    source,
    /if \(state === "probing" && hasClientPreviewSource\(a\)\) return <>\{fallback\}<\/>/,
    "a local File exists before upload finishes — using it as the probing fallback shows a finished thesis page at 80%",
  )
  assert.match(
    source,
    /resolvePreviewGate\(attachment\)/,
    "the unified viewer must consult the upload/object-ready gate before rendering pages",
  )
  assert.match(
    source,
    /if \(state === "probing"\)/,
    "server PDF conversion must keep the professional loading state while LibreOffice runs",
  )
  assert.match(
    source,
    /PREVIEW_LOADING_LABEL/,
    "loading copy must stay professional and in Spanish",
  )
  assert.match(
    source,
    /isRetryablePreviewHttpStatus/,
    "409/425 from /render (object not yet in R2) must retry instead of falling back to a client renderer",
  )
})

test("spreadsheets use the same LibreOffice PDF path as Word and decks", () => {
  const source = viewerSource()
  assert.match(
    source,
    /case "xlsx":\s+return \(\s+<ServerConvertedPdfRenderer/,
    "xlsx must go through soffice/calc_pdf_Export so sheet layout is not a squashed HTML table",
  )
})

test("generated document preview stays on the loading gate until the object is ready", () => {
  const source = readFileSync(generatedPreviewSourcePath, "utf8")
  assert.match(source, /previewGate\.ready/)
  assert.match(source, /PREVIEW_LOADING_LABEL/)
  assert.match(
    readFileSync(path.join(process.cwd(), "lib/document-preview-gate.ts"), "utf8"),
    /Preparando vista previa/,
  )
  assert.doesNotMatch(
    source,
    /setState\(\{ kind: "loading", message: "Generando vista previa…" \}\)/,
  )
})
