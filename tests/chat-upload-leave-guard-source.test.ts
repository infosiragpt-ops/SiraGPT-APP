import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert.ok(startIndex >= 0, `missing ${start}`)
  const endIndex = source.indexOf(end, startIndex)
  assert.ok(endIndex > startIndex, `missing ${end} after ${start}`)
  return source.slice(startIndex, endIndex)
}

// A multi-GB recording uploading in the background must not be lost to an
// accidental tab close: the browser's own confirmation (no in-app UI) is
// armed only while an upload is in flight.
describe("upload leave guard (source contract)", () => {
  it("arms beforeunload only while uploading and always removes it", () => {
    const start = source.indexOf("React.useEffect(() => {\n    if (!isUploading || typeof window === 'undefined') return undefined;")
    assert.ok(start > 0, "the guard effect exists and is gated on isUploading")
    const block = source.slice(start, source.indexOf("}, [isUploading]);", start))
    assert.match(block, /window\.addEventListener\('beforeunload', warn\)/)
    assert.match(block, /return \(\) => window\.removeEventListener\('beforeunload', warn\)/)
    assert.match(block, /event\.preventDefault\(\)/)
  })

  it("keeps isUploading on until the last concurrent upload ends", () => {
    const handler = between("const handleAndUploadFiles = React.useCallback(async (", "}, [chatType, setUploadedFiles]);")
    assert.doesNotMatch(handler, /setIsUploading\(false\)/, "one finished upload must not clear the shared flag")
    const begin = handler.match(/\n\s*(activeUploadsRef\.current \+= 1;\s*setIsUploading\(true\);)/)
    const end = handler.match(/\} finally \{\s*(activeUploadsRef\.current = [^\n]+\n\s*setIsUploading\([^\n]+\);)/)
    assert.ok(begin, "each upload counts itself in before setting isUploading")
    assert.ok(end, "each upload counts itself out in its finally")

    // Replay the handler's own statements: a 3 GB video, then a screenshot
    // pasted and finished while the video still uploads.
    const ref = { current: 0 }
    let uploading = false
    const setIsUploading = (value: boolean) => { uploading = value }
    const run = (code: string) => new Function("activeUploadsRef", "setIsUploading", code)(ref, setIsUploading)
    run(begin[1])
    run(begin[1])
    run(end[1])
    assert.equal(uploading, true, "the video is still uploading: the guard stays armed")
    run(end[1])
    assert.equal(uploading, false, "the last upload ended: the guard is released")
    run(end[1])
    assert.equal(ref.current, 0, "the counter never goes negative")
  })
})
