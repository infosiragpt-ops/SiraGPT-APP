import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const aiRoutePath = path.join(process.cwd(), "backend", "src", "routes", "ai.js")
const chatInterfacePath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")

const aiRoute = fs.readFileSync(aiRoutePath, "utf8")
const chatInterface = fs.readFileSync(chatInterfacePath, "utf8")

describe("chat image generation resilience source contract", () => {
  it("keeps image generation alive after mobile/proxy socket close when a chat can persist the result", () => {
    assert.match(
      aiRoute,
      /if\s*\(!detachOnDisconnect\)\s*\{\s*requestAbortController\.abort\(\);\s*\}/,
      "server should only abort a closed image request before a valid chat persistence target exists"
    )
    assert.match(
      aiRoute,
      /requestAbortController\.signal\.aborted\s*&&\s*!clientDisconnected/,
      "server should not treat a disconnected mobile/proxy socket as a real user abort"
    )
  })

  it("polls the chat for generated images on any status-less connection cut", () => {
    assert.match(
      chatInterface,
      /const\s+connectionCut\s*=\s*!status\s*&&\s*!userAborted\s*&&\s*!genError\?\.code/,
      "client should poll for persisted image results whenever the long request closes without an HTTP status"
    )
    assert.doesNotMatch(
      chatInterface,
      /connectionCut[\s\S]{0,120}elapsed\s*>=\s*25000/,
      "client must not wait 25 seconds before recovering image generations on mobile connection cuts"
    )
  })
})
