import { test } from "node:test"
import assert from "node:assert/strict"
import { collectImageUploadFileIds } from "../lib/chat/image-references"

test("mixed uploads send only actual image IDs to image generation", () => {
  const files = Object.freeze([
    Object.freeze({ id: "brief", name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    Object.freeze({ id: "product", name: "product.png", mimeType: "image/png" }),
    Object.freeze({ id: "prices", name: "prices.xlsx" }),
    Object.freeze({ id: "logo", name: "logo.webp", type: "image/webp" }),
  ])
  assert.deepEqual(collectImageUploadFileIds(files), ["product", "logo"])
  assert.deepEqual(files.map(file => file.id), ["brief", "product", "prices", "logo"])
})

test("document image previews never become visual references", () => {
  assert.deepEqual(collectImageUploadFileIds([
    { id: "pdf", name: "brief.pdf", thumbnailUrl: "/preview.png", preview: "data:image/png;base64,AA==" },
    { id: "slides", filename: "slides.pptx", imageUrl: "/slide.jpg" },
    { id: "unknown", preview: "/preview.png", thumbnailUrl: "/thumb.jpg" },
  ]), [])
})

test("replied image remains primary before other references and duplicates", () => {
  assert.deepEqual(collectImageUploadFileIds([
    { id: "replied", name: "Imagen original", type: "image/png" },
    { id: "instructions", name: "instructions.pdf" },
    { id: "style", filename: "style.jpg" },
    { fileId: "replied", mimeType: "image/png" },
    { attachmentId: "palette", type: "image", url: "/api/agent/artifact/palette" },
  ]), ["replied", "style", "palette"])
})

test("persisted image metadata supports original names, URLs and content types", () => {
  assert.deepEqual(collectImageUploadFileIds([
    { id: "original", originalName: "Photo.HEIC", filename: "stored.bin" },
    { fileId: "url", url: "/uploads/photo.png?download=1#image" },
    { attachmentId: "content", contentType: "image/jpeg", name: "Camera" },
  ]), ["original", "url", "content"])
})

test("removed or unresolved attachments are not sent as image references", () => {
  assert.deepEqual(collectImageUploadFileIds([
    { id: "deleted", type: "image/png", deletedAt: "2026-10-01" },
    { name: "pending.png", tempId: "temporary" },
    "unknown-file-id", null,
  ]), [])
})
