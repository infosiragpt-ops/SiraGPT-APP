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

  it("shares the composer safety net with chip polling and re-reads all processing attachments until they settle", () => {
    assert.match(chatInterface, /const processingWatchKey = collectProcessingFileIds\(uploadedFiles\)\.join\(','\);/)
    assert.match(chatInterface, /return subscribeToFileProcessingStatuses\(ids,/)
    assert.match(chatInterface, /handleFileProcessingStatusChange\(/)
    const hook = fs.readFileSync(path.join(process.cwd(), "hooks/use-file-processing-status.ts"), "utf8")
    assert.match(hook, /entries\.slice\(start, start \+ 50\)/)
    assert.match(hook, /\/files\/processing-status\?ids=/)
    assert.match(hook, /navigator\.onLine/)
    assert.doesNotMatch(chatInterface.slice(chatInterface.indexOf("const processingWatchKey ="), chatInterface.indexOf("const retryUpload =")), /getFilesProcessingStatus/)
  })
})
