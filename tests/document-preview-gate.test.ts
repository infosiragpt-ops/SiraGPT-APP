import assert from "node:assert/strict"
import test from "node:test"

import {
  CONVERSION_LOADING_LABEL,
  INDEXING_STATUS_LABEL,
  UPLOAD_STATUS_LABEL,
  canOpenComposerPreview,
  clampPreviewProgress,
  hasServerBackedPreviewUrl,
  isPreviewObjectReady,
  isRetryablePreviewError,
  isRetryablePreviewHttpStatus,
  isStableServerFileId,
  resolvePreviewGate,
} from "../lib/document-preview-gate"

test("temp composer ids are not stable server ids", () => {
  assert.equal(isStableServerFileId("temp-171000-abc"), false)
  assert.equal(isStableServerFileId("temp_1"), false)
  assert.equal(isStableServerFileId("file_01HXYZ"), true)
})

test("blob/data URLs do not count as a server-backed object", () => {
  assert.equal(hasServerBackedPreviewUrl("blob:https://siragpt.com/abc"), false)
  assert.equal(hasServerBackedPreviewUrl("data:application/pdf;base64,AAAA"), false)
  assert.equal(hasServerBackedPreviewUrl("/uploads/user/tesis.docx"), true)
})

test("in-flight HTTP uploads stay gated even when a local File exists", () => {
  const gate = resolvePreviewGate({
    id: "temp-1",
    status: "uploading",
    uploadProgress: 87,
    file: { name: "tesis.docx" },
  })
  assert.equal(gate.ready, false)
  assert.equal(gate.phase, "uploading")
  assert.equal(gate.label, UPLOAD_STATUS_LABEL)
  assert.equal(canOpenComposerPreview({
    id: "temp-1",
    status: "uploading",
  }), false)
  assert.equal(isPreviewObjectReady({
    id: "temp-1",
    status: "uploading",
    uploadProgress: 87,
    file: { name: "tesis.docx" },
  }), false)
})

test("HTTP upload at 100% still waits for the persisted file id", () => {
  const gate = resolvePreviewGate({
    id: "temp-2",
    status: "uploading",
    uploadProgress: 100,
    file: {},
  })
  assert.equal(gate.ready, false)
  assert.equal(canOpenComposerPreview({ id: "temp-2", status: "uploading" }), false)
})

test("a persisted server object opens the preview", () => {
  const gate = resolvePreviewGate({
    id: "file_abc",
    url: "/uploads/user/tesis.docx",
    status: "ready",
    uploadProgress: 100,
  })
  assert.equal(gate.ready, true)
  assert.equal(gate.phase, "ready")
  assert.equal(canOpenComposerPreview({
    id: "file_abc",
    url: "/uploads/user/tesis.docx",
    status: "ready",
  }), true)
})

test("RAG processing after persist allows original-byte preview", () => {
  const gate = resolvePreviewGate({
    id: "file_abc",
    url: "/uploads/user/tesis.docx",
    status: "processing",
    processingStage: "extracting",
    uploadProgress: 80,
  })
  assert.equal(gate.ready, true)
  assert.equal(gate.phase, "indexing")
  assert.equal(gate.label, INDEXING_STATUS_LABEL)
  assert.equal(canOpenComposerPreview({
    id: "file_abc",
    status: "processing",
  }), true)
})

test("failed uploads stay closed", () => {
  const gate = resolvePreviewGate({
    id: "temp-9",
    status: "failed",
    uploadProgress: 40,
  })
  assert.equal(gate.ready, false)
  assert.equal(gate.phase, "failed")
  assert.equal(canOpenComposerPreview({ id: "file_x", status: "failed" }), false)
})

test("message attachments without an upload status are treated as ready", () => {
  const gate = resolvePreviewGate({
    id: "file_msg",
    url: "/uploads/user/paper.pdf",
  })
  assert.equal(gate.ready, true)
  assert.equal(gate.phase, "ready")
})

test("conversion loading copy is the professional Spanish skeleton", () => {
  assert.equal(CONVERSION_LOADING_LABEL, "Generando vista previa…")
  assert.equal(INDEXING_STATUS_LABEL, "Subido · preparando índice…")
})

test("retryable preview statuses keep the loading gate up", () => {
  assert.equal(isRetryablePreviewHttpStatus(409), true)
  assert.equal(isRetryablePreviewHttpStatus(425), true)
  assert.equal(isRetryablePreviewHttpStatus(404), false)
  assert.equal(isRetryablePreviewError({ retryable: true }), true)
  assert.equal(isRetryablePreviewError(new Error("preview-object-not-ready")), true)
  assert.equal(isRetryablePreviewError(new Error("http-503")), false)
})

test("progress is clamped to 0..100", () => {
  assert.equal(clampPreviewProgress(-4), 0)
  assert.equal(clampPreviewProgress(140), 100)
  assert.equal(clampPreviewProgress("nope"), 0)
})
