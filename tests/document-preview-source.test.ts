import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const viewerSourcePath = path.join(process.cwd(), "components/viewers/UnifiedDocumentViewer.tsx")

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

test("DOCX server-conversion probing never blocks the client-side fallback preview", () => {
  const source = viewerSource()

  assert.match(
    source,
    /if \(state === "probing" && hasClientPreviewSource\(a\)\) return <>\{fallback\}<\/>/,
    "DOCX attachments with a file/url/extractedText source must render the fallback immediately while server PDF conversion probes in the background",
  )
  assert.doesNotMatch(
    source,
    /state === "probing" && hasClientPreviewSource\(a\) && !preferServer/,
    "preferServer must not gate the fallback, otherwise DOCX preview can sit on a blank/loading panel while conversion hangs",
  )
})
