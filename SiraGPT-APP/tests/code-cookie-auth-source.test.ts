import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

describe("/code cookie-session authentication", () => {
  it("does not reject an authenticated user merely because no legacy bearer token exists", () => {
    assert.doesNotMatch(
      source,
      /!user\s*\|\|\s*!token/,
      "Google OAuth hydrates user from its HttpOnly cookie and intentionally leaves token=null",
    )
    assert.doesNotMatch(
      source,
      /!text\s*\|\|\s*!user\s*\|\|\s*!token/,
      "background repair must also accept the same cookie-authenticated session",
    )
  })

  it("checks per-user Codex access before routing a build into the Codex engine", () => {
    assert.match(source, /codexApi\s*\.\s*access\(\)/)
    assert.match(
      source,
      /const codexAvailable = codexHealth\.enabled === true && codexCanRun/,
      "a public enabled flag is not proof that this account may create Codex projects",
    )
  })
})
