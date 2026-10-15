import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

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
})
