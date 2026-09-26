import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveImageAttachmentCandidates } from "../lib/attachment-url"

// Prod 2026-09-26: after an image turn ended, the user bubble of a (a+b)²
// screenshot stayed a grey placeholder — its composer blob was gone and the
// saved attachment only carried a stale local `path`. The bubble must be able
// to fall back to the server copy (/uploads/…, served from disk or R2).

describe("resolveImageAttachmentCandidates", () => {
  const base = "http://localhost:5000"

  it("tries the local preview first, then the server copy", () => {
    const out = resolveImageAttachmentCandidates(
      {
        preview: "blob:http://localhost:3000/abc",
        url: "/uploads/u1/files-1-x.png",
        path: "/app/uploads/u1/files-1-x.png",
      },
      base,
    )
    assert.deepEqual(out, ["blob:http://localhost:3000/abc", `${base}/uploads/u1/files-1-x.png`])
  })

  it("derives the server copy from a stale local path or an R2 ref", () => {
    assert.deepEqual(
      resolveImageAttachmentCandidates({ path: "/app/uploads/u1/files-1-x.png" }, base),
      [`${base}/uploads/u1/files-1-x.png`],
    )
    assert.deepEqual(
      resolveImageAttachmentCandidates({ path: "r2:uploads/u1/files-2-y.png" }, base),
      [`${base}/uploads/u1/files-2-y.png`],
    )
  })

  it("returns an empty list when nothing is renderable", () => {
    assert.deepEqual(resolveImageAttachmentCandidates({ name: "foto.png" }, base), [])
  })
})
