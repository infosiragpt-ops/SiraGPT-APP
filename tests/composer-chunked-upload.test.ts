import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  CHUNKED_MEDIA_THRESHOLD_BYTES,
  CHUNKED_UPLOAD_CHUNK_BYTES,
  CHUNKED_UPLOAD_PARALLEL,
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  chunkedUploadPercent,
  isRetriableChunkStatus,
  planChunks,
  shouldUseChunkedUpload,
} from "../lib/composer/chunked-upload"
import { classifyChunkFailure } from "../lib/composer/resumable-upload"
import { buildComposerUploadChunks, COMPOSER_UPLOAD_BATCH_LIMITS } from "../lib/composer/upload-batching"

const MB = 1024 * 1024

describe("chunked upload planning", () => {
  it("routes files at or above 80 MB (the proxy limit is 100 MB) to the chunked transport", () => {
    assert.equal(CHUNKED_UPLOAD_THRESHOLD_BYTES, 80 * MB)
    assert.equal(shouldUseChunkedUpload({ size: 80 * MB }), true)
    assert.equal(shouldUseChunkedUpload({ size: 350 * MB }), true)
    assert.equal(shouldUseChunkedUpload({ size: 79 * MB }), false)
    assert.equal(shouldUseChunkedUpload(null), false)
    assert.equal(shouldUseChunkedUpload({ size: 10 * MB }, 5 * MB), true)
  })

  it("routes audio/video from 32 MB (a 5 h lecture at 24-32 kbps is 54-72 MB) to the resumable path", () => {
    assert.equal(CHUNKED_MEDIA_THRESHOLD_BYTES, 32 * MB)
    assert.equal(shouldUseChunkedUpload({ name: "clase-5h.mp3", type: "audio/mpeg", size: 60 * MB }), true)
    assert.equal(shouldUseChunkedUpload({ name: "clase.m4a", type: "", size: 32 * MB }), true, "extension fallback")
    assert.equal(shouldUseChunkedUpload({ name: "clase.mp4", type: "video/mp4", size: 31 * MB }), false)
    assert.equal(shouldUseChunkedUpload({ name: "informe.pdf", type: "application/pdf", size: 60 * MB }), false, "documents keep the 80 MB rule")
    assert.equal(shouldUseChunkedUpload({ name: "app.ts", type: "video/mp2t", size: 1 * MB }), false)
    const files = [{ name: "notas.pdf", type: "application/pdf", size: 5 * MB }, { name: "clase.mp3", type: "audio/mpeg", size: 60 * MB }]
    const chunks = buildComposerUploadChunks(files, ["t1", "t2"], { ...COMPOSER_UPLOAD_BATCH_LIMITS, isolate: shouldUseChunkedUpload })
    assert.deepEqual(chunks.map((c) => [c.files.map((f) => f.name), Boolean(c.isolated)]), [
      [["notas.pdf"], false],
      [["clase.mp3"], true],
    ])
  })

  it("sends 3 chunks in parallel by default and classifies failures without deleting on transient ones", () => {
    assert.equal(CHUNKED_UPLOAD_PARALLEL, 3)
    for (const status of [0, 408, 425, 429, 502, 503, 504]) assert.equal(classifyChunkFailure(status), "transient", String(status))
    assert.equal(classifyChunkFailure(500), "server")
    assert.equal(classifyChunkFailure(401), "auth")
    assert.equal(classifyChunkFailure(403), "auth")
    assert.equal(classifyChunkFailure(404), "gone")
    assert.equal(classifyChunkFailure(507), "storage")
    assert.equal(classifyChunkFailure(409, "chunks_missing"), "missing")
    assert.equal(classifyChunkFailure(409, "upload_completed"), "completed")
    for (const status of [400, 409, 413, 415, 501]) assert.equal(classifyChunkFailure(status), "fatal", String(status))
  })

  it("splits into 16 MB chunks with an exact final chunk", () => {
    assert.equal(CHUNKED_UPLOAD_CHUNK_BYTES, 16 * MB)
    const plans = planChunks(40 * MB + 5)
    assert.equal(plans.length, 3)
    assert.deepEqual(plans[0], { index: 0, start: 0, end: 16 * MB, bytes: 16 * MB })
    assert.deepEqual(plans[2], { index: 2, start: 32 * MB, end: 40 * MB + 5, bytes: 8 * MB + 5 })
    assert.equal(plans.reduce((sum, p) => sum + p.bytes, 0), 40 * MB + 5)
    assert.deepEqual(planChunks(0), [])
    assert.equal(planChunks(10, 4).length, 3)
  })

  it("reports whole-file progress and classifies retriable statuses", () => {
    assert.equal(chunkedUploadPercent(100, 0), 0)
    assert.equal(chunkedUploadPercent(100, 50, 25), 75)
    assert.equal(chunkedUploadPercent(100, 100, 50), 100)
    assert.equal(chunkedUploadPercent(0, 0), 0)
    for (const status of [0, 408, 429, 502, 503, 504]) assert.equal(isRetriableChunkStatus(status), true, String(status))
    for (const status of [400, 401, 403, 413, 415, 500]) assert.equal(isRetriableChunkStatus(status), false, String(status))
  })

  it("isolates chunked files in their own batch while small files still share one", () => {
    const files = [{ name: "a.pdf", size: 5 * MB }, { name: "clase.mp4", size: 300 * MB }, { name: "b.pdf", size: 6 * MB }, { name: "c.png", size: 1 * MB }]
    const temps = files.map((f) => `tmp-${f.name}`)
    const chunks = buildComposerUploadChunks(files, temps, { ...COMPOSER_UPLOAD_BATCH_LIMITS, isolate: shouldUseChunkedUpload })
    assert.deepEqual(chunks.map((c) => [c.files.map((f) => f.name), Boolean(c.isolated)]), [
      [["a.pdf"], false],
      [["clase.mp4"], true],
      [["b.pdf", "c.png"], false],
    ])
    assert.deepEqual(chunks[1].temps, ["tmp-clase.mp4"])
  })
})

describe("chunked upload wiring (source contract)", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")
  const engine = fs.readFileSync(path.join(process.cwd(), "lib", "composer", "resumable-upload.ts"), "utf8")
  const composer = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")
  const ingest = fs.readFileSync(path.join(process.cwd(), "lib", "attachment-ingest.ts"), "utf8")

  it("the API client runs the resumable engine over the authenticated transport", () => {
    assert.match(api, /async uploadFileChunked\(/)
    assert.match(api, /engine\.createHttpChunkTransport<FileUploadResponse>\(\{/)
    assert.match(api, /fetch: \(path, init\) => this\.authenticatedFetch\(`\$\{this\.baseURL\}\$\{path\}`, init\),/)
    assert.match(api, /prepare: \(url, init\) => prepareAuthenticatedRequest\(url, init, \{ bearerToken: this\._getAccessTokenSnapshot\(\) \}\),/)
    assert.match(api, /return engine\.runResumableUpload<FileUploadResponse>\(\{/)
    assert.match(api, /parallel: opts\.parallel \?\? CHUNKED_UPLOAD_PARALLEL,/)
  })

  it("the engine announces, resumes from the status route, streams XHR chunks and completes", () => {
    assert.match(engine, /deps\.fetch\("\/files\/upload\/chunked\/init", \{/)
    assert.match(engine, /deps\.fetch\(`\/files\/upload\/chunked\/\$\{encodeURIComponent\(uploadId\)\}`, \{ method: "GET", signal \}\)/)
    assert.match(engine, /const url = `\$\{base\}\/files\/upload\/chunked\/\$\{encodeURIComponent\(uploadId\)\}\/\$\{index\}`/)
    assert.match(engine, /xhr\.open\("PUT", url, true\)/)
    assert.match(engine, /body: file\.slice\(plan\.start, plan\.end\),/)
    assert.match(engine, /deps\.fetch\(`\/files\/upload\/chunked\/\$\{encodeURIComponent\(uploadId\)\}\/complete`, \{/)
    assert.match(engine, /\{ method: "DELETE", keepalive: true \}/)
  })

  it("the composer isolates large media and sends it through the chunked transport with the same response handling", () => {
    assert.match(composer, /import \{ shouldUseChunkedUpload \} from "@\/lib\/composer\/chunked-upload"/)
    assert.match(composer, /isolate: shouldUseChunkedUpload,/)
    assert.match(composer, /chunk\.isolated && chunk\.files\.length === 1 && shouldUseChunkedUpload\(chunk\.files\[0\]\)\s*\? await apiClient\.uploadFileChunked\(chunk\.files\[0\], \{/)
    assert.match(composer, /Hasta 1 GB por documento; audio y video hasta 10 GB \(unas 10 horas por archivo\)\./)
  })

  it("audio and video get the 10 GB client cap", () => {
    assert.match(ingest, /NEXT_PUBLIC_COMPOSER_MAX_MEDIA_MB, 10240\)/)
    assert.match(ingest, /const max = opts\.maxBytes \?\? \(isMediaUpload\(file\) \? DEFAULT_MAX_MEDIA_BYTES : DEFAULT_MAX_BYTES\)/)
  })
})
