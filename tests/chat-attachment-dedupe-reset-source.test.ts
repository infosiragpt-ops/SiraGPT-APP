import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("composer attachment dedupe reset", () => {
  it("clears the content-hash set every time the composer file list is cleared", () => {
    const chat = source("components/chat-interface-enhanced.tsx")
    const clears = Array.from(chat.matchAll(/^[ \t]*(if \(!queuedSend\) )?setUploadedFiles\(\[\]\);$/gm))
    const resets = chat.split("attachmentHashesRef.current.clear()").length - 1
    assert.ok(clears.length > 0, "the composer still clears consumed attachments")
    for (const clear of clears) {
      const nextLine = chat.slice(clear.index! + clear[0].length).split("\n")[1]?.trim()
      assert.equal(nextLine, `${clear[1] || ""}attachmentHashesRef.current.clear();`,
        "clear the duplicate guard under the same condition as the consumed attachments")
    }
    assert.equal(
      resets,
      clears.length,
      "every setUploadedFiles([]) must be paired with attachmentHashesRef.current.clear() — " +
        "otherwise re-attaching the same file after sending reports «duplicado omitido»",
    )
  })
})
