import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("chat composer single-submit source contract", () => {
  it("uses only keydown to submit Enter so one key press cannot fire handleSend twice", () => {
    assert.doesNotMatch(
      source,
      /onKeyPress=\{handleKeyPress\}/,
      "Textarea must not bind both onKeyDown and the deprecated onKeyPress; browsers can fire both for one Enter press"
    )

    const handleKeyDown = sliceBetween(
      "const handleKeyDown = (e: React.KeyboardEvent) => {",
      "const removeFile"
    )
    assert.match(
      handleKeyDown,
      /e\.key === \"Enter\"[\s\S]{0,140}handleSend\(\)/,
      "Enter submit should remain on keydown, where preventDefault reliably stops newline insertion"
    )

    const keyPressStart = source.indexOf("const handleKeyPress = (e: React.KeyboardEvent) => {")
    if (keyPressStart !== -1) {
      const keyPress = sliceBetween(
        "const handleKeyPress = (e: React.KeyboardEvent) => {",
        "// Prevent Enter key from adding new line when not holding Shift"
      )
      assert.doesNotMatch(
        keyPress,
        /handleSend\(\)/,
        "If a keypress handler exists, it must not submit; keydown already owns Enter sends"
      )
    }
  })

  it("guards the normal chat send path with a synchronous in-flight ref", () => {
    assert.match(
      source,
      /const sendInFlightRef = React\.useRef\(false\)/,
      "handleSend needs a synchronous ref lock; React state updates are too late for double tap/key events"
    )

    const normalSendStart = source.indexOf("// Optimistically add the user message to the UI immediately.")
    assert.notEqual(normalSendStart, -1, "missing normal chat optimistic-send marker")
    const normalSendPreamble = source.slice(Math.max(0, normalSendStart - 240), normalSendStart)
    assert.match(
      normalSendPreamble,
      /if \(sendInFlightRef\.current\) return;[\s\S]{0,120}sendInFlightRef\.current = true;/,
      "the normal chat route must acquire the lock before adding the optimistic user message"
    )

    const finallyStart = source.indexOf("    } finally {", normalSendStart)
    assert.notEqual(finallyStart, -1, "missing handleSend finally block")
    const finallyEnd = source.indexOf("  }\n  const handleGmailCommand", finallyStart)
    assert.notEqual(finallyEnd, -1, "missing handleSend end marker")
    const sendFinally = source.slice(finallyStart, finallyEnd)
    assert.match(
      sendFinally,
      /sendInFlightRef\.current = false;/,
      "the in-flight lock must release when the send pipeline finishes or errors"
    )
  })
})
