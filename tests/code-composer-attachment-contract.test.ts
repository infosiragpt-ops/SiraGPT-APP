import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildCodeAttachmentPromptBlock,
  codeAttachmentFileId,
  codeAttachmentId,
  composeCodePromptWithAttachments,
  formatCodeAttachmentBytes,
  type CodeComposerAttachment,
} from "../lib/code-agent/composer-attachments"

function attachment(overrides: Partial<CodeComposerAttachment> = {}): CodeComposerAttachment {
  return {
    tempId: "temp-1",
    name: "captura.png",
    mimeType: "image/png",
    size: 1_536,
    status: "ready",
    ...overrides,
  }
}

describe("code composer attachment contract", () => {
  it("uses stable server ids when available and falls back to the optimistic id", () => {
    assert.equal(codeAttachmentId(attachment({ id: "server-1" })), "server-1")
    assert.equal(codeAttachmentId(attachment()), "temp-1")
    assert.equal(codeAttachmentFileId(attachment({ fileId: "file-1" })), "file-1")
    assert.equal(codeAttachmentFileId(attachment()), null)
  })

  it("describes only ready files without leaking browser blobs into the prompt", () => {
    const prompt = buildCodeAttachmentPromptBlock([
      attachment({ id: "image-1", url: "/api/files/image-1" }),
      attachment({ tempId: "pending", name: "pending.pdf", status: "uploading" }),
    ])

    assert.match(prompt, /captura\.png/)
    assert.match(prompt, /image\/png/)
    assert.match(prompt, /id=image-1/)
    assert.match(prompt, /url=\/api\/files\/image-1/)
    assert.doesNotMatch(prompt, /pending\.pdf/)
  })

  it("keeps plain text unchanged when no attachment is ready", () => {
    assert.equal(
      composeCodePromptWithAttachments("  Corrige el encabezado  ", [
        attachment({ status: "failed" }),
      ]),
      "Corrige el encabezado",
    )
  })

  it("provides a useful instruction for an attachment-only turn", () => {
    const prompt = composeCodePromptWithAttachments("", [attachment()])
    assert.match(prompt, /^Revisa los archivos adjuntos/)
    assert.match(prompt, /Archivos adjuntos del usuario/)
  })

  it("formats attachment sizes consistently", () => {
    assert.equal(formatCodeAttachmentBytes(0), "")
    assert.equal(formatCodeAttachmentBytes(800), "800 B")
    assert.equal(formatCodeAttachmentBytes(1_536), "2 KB")
    assert.equal(formatCodeAttachmentBytes(1.5 * 1024 * 1024), "1.5 MB")
    assert.equal(formatCodeAttachmentBytes(12 * 1024 * 1024), "12 MB")
  })
})
