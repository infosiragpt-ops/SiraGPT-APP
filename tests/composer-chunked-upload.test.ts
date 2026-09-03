import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import {
  CHUNKED_UPLOAD_CHUNK_BYTES,
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  chunkedUploadPercent,
  isRetriableChunkStatus,
  planChunks,
  shouldUseChunkedUpload,
} from "../lib/composer/chunked-upload"
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
  const composer = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")
  const ingest = fs.readFileSync(path.join(process.cwd(), "lib", "attachment-ingest.ts"), "utf8")

  it("the API client announces, streams chunks with retries and completes on the backend endpoints", () => {
    assert.match(api, /async uploadFileChunked\(/)
    assert.match(api, /authed\('\/files\/upload\/chunked\/init', \{/)
    assert.match(api, /withTimeout\(\s*\(chunkSignal\) => this\.authenticatedFetch\(`\$\{this\.baseURL\}\/files\/upload\/chunked\/\$\{session\.uploadId\}\/\$\{plan\.index\}`, \{\s*method: 'PUT',/)
    assert.match(api, /signal: chunkSignal,/)
    assert.match(api, /ms: opts\.chunkTimeoutMs \?\? CHUNKED_UPLOAD_CHUNK_TIMEOUT_MS,/)
    assert.match(api, /body: file\.slice\(plan\.start, plan\.end\),/)
    assert.match(api, /authed\(`\/files\/upload\/chunked\/\$\{session\.uploadId\}\/complete`, \{ method: 'POST'/)
    assert.match(api, /if \(!retriable \|\| attempt >= maxRetries\) \{/)
  })

  it("the composer isolates large media and sends it through the chunked transport with the same response handling", () => {
    assert.match(composer, /import \{ shouldUseChunkedUpload \} from "@\/lib\/composer\/chunked-upload"/)
    assert.match(composer, /isolate: shouldUseChunkedUpload,/)
    assert.match(composer, /chunk\.isolated && chunk\.files\.length === 1 && shouldUseChunkedUpload\(chunk\.files\[0\]\)\s*\? await apiClient\.uploadFileChunked\(chunk\.files\[0\], \{/)
    assert.match(composer, /100 MB por documento; audio y video hasta 2 GB\./)
  })

  it("audio and video get the 2 GB client cap", () => {
    assert.match(ingest, /NEXT_PUBLIC_COMPOSER_MAX_MEDIA_MB, 2048\)/)
    assert.match(ingest, /const max = opts\.maxBytes \?\? \(isMediaUpload\(file\) \? DEFAULT_MAX_MEDIA_BYTES : DEFAULT_MAX_BYTES\)/)
  })
})
