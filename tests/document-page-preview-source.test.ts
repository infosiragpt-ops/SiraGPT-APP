import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

test("composer and message chips render a document page thumb, not a Word icon plus Cargando", () => {
  const composer = source("components/chat-interface-enhanced.tsx")
  const message = source("components/message-component.tsx")
  const thumb = source("components/document-page-thumb.tsx")
  const lib = source("lib/document-first-page.ts")

  assert.match(composer, /DocumentPageThumb/)
  assert.match(composer, /isDocPage/)
  assert.match(message, /DocumentPageThumb/)
  assert.match(message, /isPagePreviewDocument/)
  assert.match(thumb, /Generando vista previa/)
  assert.match(lib, /export function isPagePreviewDocument/)
  assert.match(lib, /renderPdfFirstPage/)
  assert.match(lib, /renderDocxHtml/)
  assert.doesNotMatch(thumb, /Cargando documento\.\.\./)
})

test("page thumbs keep a loading veil so a local File is not a finished page", () => {
  const thumb = source("components/document-page-thumb.tsx")
  assert.match(thumb, /busy \|\| !page/)
  assert.match(thumb, /ThinkingIndicator/)
})

test("PDF/Office composer chips poll processing-status and follow the live stage", () => {
  const composer = source("components/chat-interface-enhanced.tsx")
  const hook = source("hooks/use-file-processing-status.ts")
  assert.match(composer, /FileProcessingStatusSync/)
  assert.match(composer, /describeComposerDocumentThumb/)
  assert.match(composer, /isDocPage[\s\S]{0,900}FileProcessingStatusSync/)
  assert.doesNotMatch(
    composer,
    /file\.status === 'processing'\s*\n\s*\? INDEXING_STATUS_LABEL/,
    "PDF thumbs must not freeze on the default indexing copy after HTTP upload",
  )
  assert.match(hook, /buildFileProcessingStatusUrl/)
  assert.match(hook, /decideProcessingStatusPoll/)
  assert.match(hook, /resolveProcessingPollGiveUp/)
})
