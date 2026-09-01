import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

describe("/agentes header", () => {
  it("does not expose the cowork workspace shortcut", () => {
    assert.doesNotMatch(chatInterface, /Abrir workspace y tareas/)
    assert.doesNotMatch(chatInterface, /aria-pressed=\{coworkPanelOpen\}[\s\S]{0,180}<BriefcaseBusiness/)
  })

  it("keeps the computer and share actions", () => {
    assert.match(chatInterface, /data-testid="chat-computer-button"/)
    assert.match(chatInterface, /title="Compartir conversación completa"/)
  })
})
