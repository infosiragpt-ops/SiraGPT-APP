import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  assert.ok(from >= 0, `missing ${start}`)
  const to = text.indexOf(end, from)
  assert.ok(to > from, `missing ${end}`)
  return text.slice(from, to)
}

describe("chat composer dictation source contract", () => {
  it("starts native speech recognition in the same click, without awaiting getUserMedia first", () => {
    const handle = sliceBetween(source, "const handleMicClick = ", "const renderComposerModelControls")
    assert.match(handle, /dictationWantListeningRef\.current = true/)
    assert.match(handle, /recognition\.start\(\)/)
    assert.doesNotMatch(
      handle,
      /await ensureMicrophonePermission/,
      "awaiting getUserMedia before start() drops the user gesture and Chrome/Safari abort dictation",
    )
  })

  it("restarts native recognition when the browser ends the session while the mic is still open", () => {
    const effect = sliceBetween(source, "React.useEffect(() => {\n    const SpeechRecognition", "const handleMicClick")
    assert.match(effect, /shouldRestartNativeDictation\(/)
    assert.match(effect, /recognition\.start\(\)/)
  })

  it("clears the listen latch when the user taps stop", () => {
    const handle = sliceBetween(source, "const handleMicClick = ", "const renderComposerModelControls")
    assert.match(handle, /if \(isRecording\) \{[\s\S]*dictationWantListeningRef\.current = false/)
  })
})
