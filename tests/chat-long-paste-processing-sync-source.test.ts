import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

// Regression: the "PEGADO" long-paste chip rendered no processing poller, so
// after the backend marked the .txt ready the chip stayed "processing" and the
// send button kept saying «Espera a que SiraGPT termine de leer … antes de
// enviarlo». Pin both the chip-level poller and the composer-wide safety net.
describe("long paste chip processing sync (source contract)", () => {
  it("mounts the headless processing poller on the PEGADO chip", () => {
    assert.match(
      chatInterface,
      /\{!isFailed && longPasteMeta && !isUploading && file\.id && \(\s*<FileProcessingStatusSync\s+fileId=\{file\.id\}\s+onStatusChange=\{\(status\) => onFileProcessingStatusChange\?\.\(file, status\)\}\s*\/>\s*\)\}/,
    )
  })

  it("keeps a composer-wide safety net that re-reads processing attachments until they settle", () => {
    assert.match(chatInterface, /const processingWatchKey = collectProcessingFileIds\(uploadedFiles\)\.join\(','\);/)
    assert.match(chatInterface, /await hydrateUploadedFileFromBackend\(id\);/)
    assert.match(chatInterface, /if \(!cancelled && attempts < 90\) timer = setTimeout\(tick, 2000\);/)
    assert.match(chatInterface, /\}, \[processingWatchKey, hydrateUploadedFileFromBackend\]\);/)
  })
})
