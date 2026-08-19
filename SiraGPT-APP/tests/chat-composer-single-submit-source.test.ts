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
    // The global boolean lock (sendInFlightRef) became a PER-SEND keyed map so
    // one chat's streaming turn no longer blocks sending in other chats
    // (6af6361b7). The double-submit guarantee is unchanged: a synchronous ref
    // (state updates are too late for double tap/key events) checked BEFORE the
    // optimistic user message, released when the pipeline settles.
    assert.match(
      source,
      /const inFlightSendKeysRef = React\.useRef<Map<string/,
      "handleSend needs a synchronous keyed ref lock; React state updates are too late for double tap/key events"
    )

    assert.match(
      source,
      /const sendKey = `\$\{currentChat\?\.id \|\| "new"\}[\s\S]{0,160}\$\{fileKey\}`;/,
      "the send key must identify the send (chat + model + message + files) so duplicates dedupe but other chats stay unblocked"
    )

    assert.match(
      source,
      /if \(inFlightSendKeysRef\.current\.has\(sendKey\)\) \{\s*return;/,
      "a duplicate in-flight send (same key) must return synchronously before any state or network work"
    )

    const guardIndex = source.indexOf("if (inFlightSendKeysRef.current.has(sendKey))")
    const optimisticIndex = source.indexOf("// Optimistically add the user message to the UI immediately.")
    assert.notEqual(optimisticIndex, -1, "missing normal chat optimistic-send marker")
    assert.ok(
      guardIndex !== -1 && guardIndex < optimisticIndex,
      "the keyed lock must be acquired before adding the optimistic user message"
    )

    assert.match(
      source,
      /inFlightSendKeysRef\.current\.delete\(sendKey\);/,
      "the in-flight key must release when the send pipeline finishes or errors"
    )
  })
})
