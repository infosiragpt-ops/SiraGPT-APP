import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const contextPath = path.join(process.cwd(), "lib", "chat-context-integrated.tsx")
const source = fs.readFileSync(contextPath, "utf8")

describe("chat regenerate attachments source contract", () => {
  it("reuses the shared file-id collector so refresh JSON strings keep attachments", () => {
    assert.match(source, /import \{[^}]*\bcollectMessageFileIds\b[^}]*\} from "\.\/chat\/composer-files"/)
    assert.match(source, /collectMessageFileIds\(originalUserMessage\.files\)/)
    assert.match(source, /collectMessageFileIds\(parsedFiles\)/)
    assert.doesNotMatch(
      source,
      /originalUserMessage\.files\?\.map\(\(f: any\) => f\.id\)/,
      "regenerate must not map .id on a possibly-string files field",
    )
  })
})
