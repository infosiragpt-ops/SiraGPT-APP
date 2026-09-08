import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import path from "node:path"

const root = process.cwd()

describe("duplicate Mini replay delivers tokens after Safari abort", () => {
  it("api.ts always onData for duplicate_turn_replay", () => {
    const src = readFileSync(path.join(root, "lib/api.ts"), "utf8")
    assert.match(src, /jsonData\.type === 'duplicate_turn_replay'/)
    assert.match(src, /onData\(jsonData\.content\)/)
  })

  it("chat-context paints replace/onData unless the user stopped", () => {
    const src = readFileSync(path.join(root, "lib/chat-context-integrated.tsx"), "utf8")
    assert.match(src, /pendingStopsRef\.current\.has\(activeChat\.id\)/)
    assert.doesNotMatch(
      src,
      /onReplace: \(replacement\) => \{\s*if \(controller\.signal\.aborted \|\| pendingStopsRef/,
    )
  })
})
