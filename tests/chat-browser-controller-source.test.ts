import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const ui = fs.readFileSync(
  path.join(process.cwd(), "components", "ComputerUseInterface.tsx"),
  "utf8",
)
const hook = fs.readFileSync(
  path.join(process.cwd(), "hooks", "use-computer-use.tsx"),
  "utf8",
)
const chat = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

describe("browser controller source contract", () => {
  it("renders a controller chrome with live URL and action log", () => {
    assert.match(ui, /data-testid="browser-controller"/)
    assert.match(ui, /Controlador de navegador/)
    assert.match(ui, /Qué está haciendo/)
    assert.match(ui, /Tomar control/)
    assert.match(ui, /mapContainedImageClick/)
  })

  it("forwards controller commands and click takeover from chat", () => {
    assert.match(hook, /sendControllerCommand/)
    assert.match(hook, /sendUserAction/)
    assert.match(hook, /type: 'user-action'/)
    assert.match(chat, /onTakeover=\{\(\) => sendControllerCommand\("takeover-start"\)\}/)
    assert.match(chat, /onUserClick=\{\(point\) => sendUserAction\(\{ type: "click"/)
  })
})
