import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const root = process.cwd()

test("composer chips pass live upload progress into the right-pane viewer", () => {
  const source = readFileSync(path.join(root, "components/chat-interface-enhanced.tsx"), "utf8")
  assert.match(
    source,
    /toDocumentViewerAttachmentWithProgress\(f,\s*uploadProgress\)/,
    "the composer preview attachment must include the same % the chip is showing",
  )
  assert.match(
    source,
    /composerPreviewSiblings[\s\S]{0,180}toDocumentViewerAttachmentWithProgress/,
  )
})

test("files render waits for the persisted object instead of converting a partial upload", () => {
  const source = readFileSync(path.join(root, "backend/src/routes/files.js"), "utf8")
  assert.match(source, /isPersistedPreviewSource/)
  assert.match(source, /PREVIEW_OBJECT_NOT_READY/)
  assert.match(source, /status\(409\)/)
})

test("R2 /uploads still streams through this origin — no 302 CORS regression", () => {
  const source = readFileSync(path.join(root, "backend/src/middleware/upload-static-access.js"), "utf8")
  assert.doesNotMatch(source, /res\.redirect\(\s*302/)
  assert.match(source, /X-Upload-Source['"]\s*,\s*['"]r2-stream['"]/)
  assert.match(source, /pipeStreamToResponse/)
})
