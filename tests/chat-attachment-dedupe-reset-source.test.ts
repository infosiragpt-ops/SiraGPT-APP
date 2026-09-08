import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("composer attachment dedupe reset", () => {
  it("clears the content-hash set every time the composer file list is cleared", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const clears = chat.split("setUploadedFiles([]);").length - 1
    const resets = chat.split("attachmentHashesRef.current.clear()").length - 1
    assert.ok(clears >= 5, `expected at least 5 composer clears, found ${clears}`)
    assert.equal(
      resets,
      clears,
      "every setUploadedFiles([]) must be paired with attachmentHashesRef.current.clear() — " +
        "otherwise re-attaching the same file after sending reports «duplicado omitido»",
    )
  })
})
