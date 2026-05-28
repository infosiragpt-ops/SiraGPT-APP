import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const globalsPath = path.join(process.cwd(), "app", "globals.css")
const viewportHookPath = path.join(process.cwd(), "hooks", "use-visual-viewport-css-vars.ts")

const globals = fs.readFileSync(globalsPath, "utf8")
const viewportHook = fs.readFileSync(viewportHookPath, "utf8")

describe("mobile keyboard composer source contract", () => {
  it("marks the visual viewport target when the keyboard is open", () => {
    assert.match(
      viewportHook,
      /KEYBOARD_OPEN_HEIGHT_PX\s*=\s*120/,
      "keyboard-open detection should ignore small Safari toolbar changes"
    )
    assert.match(
      viewportHook,
      /target\.dataset\[`\$\{prefix\}Keyboard`\]\s*=/,
      "viewport sync should expose a data attribute for CSS keyboard overrides"
    )
  })

  it("removes the iOS Safari toolbar clearance while the keyboard is open", () => {
    const iosClearanceIndex = globals.indexOf("@supports (-webkit-touch-callout: none)")
    const keyboardOverrideIndex = globals.indexOf('.chat-viewport[data-chat-keyboard="open"]')

    assert.notEqual(iosClearanceIndex, -1, "missing iOS Safari clearance block")
    assert.notEqual(keyboardOverrideIndex, -1, "missing keyboard-open composer clearance override")
    assert.ok(
      keyboardOverrideIndex > iosClearanceIndex,
      "keyboard-open override must come after the iOS clearance block so it wins"
    )
    assert.match(
      globals.slice(keyboardOverrideIndex, keyboardOverrideIndex + 240),
      /--chat-mobile-bottom-clearance:\s*max\(env\(safe-area-inset-bottom,\s*0px\),\s*0\.25rem\)/,
      "keyboard-open composer should stay close to the visual viewport bottom"
    )
  })
})
