import assert from "node:assert/strict"
import test from "node:test"

import {
  getAttachmentLocalFile,
  isFileLike,
  toDocumentViewerAttachment,
} from "../lib/document-viewer-attachment"

function fakeFile(name: string, type: string, size = 12): File {
  return {
    name,
    type,
    size,
    async text() { return "hello" },
    async arrayBuffer() { return new ArrayBuffer(size) },
  } as unknown as File
}

test("document viewer attachments preserve the in-memory upload file", () => {
  const file = fakeFile("local.pdf", "application/pdf", 42)
  const attachment = toDocumentViewerAttachment({
    id: "file_1",
    tempId: "temp_1",
    name: "server-name.pdf",
    type: "application/pdf",
    url: "/uploads/user/server-name.pdf",
    file,
  })

  assert.equal(attachment.id, "file_1")
  assert.equal(attachment.name, "server-name.pdf")
  assert.equal(attachment.mimeType, "application/pdf")
  assert.equal(attachment.size, 42)
  assert.equal(attachment.file, file)
  assert.equal(attachment.url, "/uploads/user/server-name.pdf")
})

test("document viewer attachments accept generated document data URLs", () => {
  const attachment = toDocumentViewerAttachment({
    attachmentId: "generated_1",
    originalName: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA",
  })

  assert.equal(attachment.id, "generated_1")
  assert.equal(attachment.name, "report.docx")
  assert.equal(
    attachment.url,
    "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA",
  )
})

test("document viewer attachments recover upload URLs from stored filesystem paths", () => {
  const attachment = toDocumentViewerAttachment({
    fileId: "file_2",
    filename: "contract.pdf",
    path: "/srv/app/uploads/user/contract.pdf",
  })

  assert.equal(attachment.id, "file_2")
  assert.equal(attachment.name, "contract.pdf")
  assert.equal(attachment.url, "/uploads/user/contract.pdf")
})

test("file-like detection works without relying on browser File globals", () => {
  const file = fakeFile("notes.txt", "text/plain")

  assert.equal(isFileLike(file), true)
  assert.equal(getAttachmentLocalFile({ originalFile: file }), file)
})
