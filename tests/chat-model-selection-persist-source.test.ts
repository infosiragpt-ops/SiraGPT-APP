import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const context = fs.readFileSync(path.join(process.cwd(), "lib", "chat-context-integrated.tsx"), "utf8")
const picker = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

describe("model selection persistence source contract", () => {
  it("does not reset the picker to catalog[0] when a current/pinned pick exists", () => {
    assert.match(context, /pickPreferredCatalogModel/)
    assert.match(context, /getPinnedModel\(\)/)
    assert.doesNotMatch(
      context,
      /setSelectedModel\(modelsResponse\.models\[0\]\.name\)/,
      "reloading models must not clobber a user/pinned selection with catalog[0]",
    )
  })

  it("persists the picker choice on the conversation", () => {
    assert.match(picker, /setLastModel\(model\.name\)/)
    assert.match(picker, /updateChat\(currentChat\.id, \{ model: model\.name \}\)/)
    assert.match(context, /applyChatModelSelection/)
  })
})
