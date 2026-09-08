import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildComposerUploadChunks,
  COMPOSER_UPLOAD_BATCH_LIMITS,
} from "../lib/composer/upload-batching"

type TestFile = { name: string; size: number }

describe("buildComposerUploadChunks", () => {
  it("preserves file-to-chip ordering across count-limited batches", () => {
    const files: TestFile[] = Array.from({ length: 5 }, (_, index) => ({
      name: `file-${index}`,
      size: 10,
    }))
    const temps = files.map((file) => `temp-${file.name}`)

    const chunks = buildComposerUploadChunks(files, temps, {
      maxFiles: 2,
      maxBytes: 1_000,
    })

    assert.deepEqual(chunks.map((chunk) => chunk.files.map((file) => file.name)), [
      ["file-0", "file-1"],
      ["file-2", "file-3"],
      ["file-4"],
    ])
    assert.deepEqual(chunks.flatMap((chunk) => chunk.temps), temps)
  })

  it("starts a new batch before the aggregate byte limit is exceeded", () => {
    const files: TestFile[] = [
      { name: "first", size: 60 },
      { name: "second", size: 50 },
      { name: "third", size: 20 },
    ]

    const chunks = buildComposerUploadChunks(files, ["a", "b", "c"], {
      maxFiles: 50,
      maxBytes: 100,
    })

    assert.deepEqual(chunks.map((chunk) => chunk.files.map((file) => file.name)), [
      ["first"],
      ["second", "third"],
    ])
  })

  it("keeps a single oversized file intact so the server can report it", () => {
    const chunks = buildComposerUploadChunks(
      [{ name: "oversized", size: 101 }],
      ["temp"],
      { maxFiles: 50, maxBytes: 100 },
    )

    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].files[0].name, "oversized")
  })

  it("returns no batches for an empty selection", () => {
    assert.deepEqual(buildComposerUploadChunks([], []), [])
  })

  it("fails fast when optimistic chips are not aligned with files", () => {
    assert.throws(
      () => buildComposerUploadChunks([{ name: "one", size: 1 }], []),
      /same length/,
    )
  })

  it("publishes the backend-compatible request limits once", () => {
    assert.deepEqual(COMPOSER_UPLOAD_BATCH_LIMITS, {
      maxFiles: 50,
      maxBytes: 220 * 1024 * 1024,
    })
  })
})
