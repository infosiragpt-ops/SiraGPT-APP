import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
const styles = readFileSync("app/globals.css", "utf8")
const surface = readFileSync("components/chat/ChatComposerSurface.tsx", "utf8")

describe("professional /code composer split-pane layout", () => {

  it("uses the shared professional send arrow on a black disc", () => {
    assert.match(surface, /export function ComposerSendArrow/)
    assert.match(
      styles,
      /\.code-composer__send\s*\{[\s\S]{0,220}background-color: #0a0a0a !important;[\s\S]{0,80}color: #fff !important;/,
    )
  })
})
