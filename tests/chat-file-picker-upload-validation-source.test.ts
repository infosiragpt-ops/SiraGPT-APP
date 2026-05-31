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

describe("chat file picker upload validation source contract", () => {
  it("validates picker files before rendering upload chips or calling the backend", () => {
    const handleAndUploadFiles = sliceBetween(
      "const handleAndUploadFiles = React.useCallback(async (",
      "  /**\n   * Retry an upload that previously failed.",
    )

    const validationIndex = handleAndUploadFiles.indexOf("validateBatch(filesToUpload")
    assert.notEqual(
      validationIndex,
      -1,
      "handleAndUploadFiles must run the same validateBatch gate used by drag/drop and paste, so picker-selected Office lock files never become failed retry chips",
    )

    const tempChipIndex = handleAndUploadFiles.indexOf("const tempFiles = filesToUpload.map")
    assert.notEqual(tempChipIndex, -1, "missing temp upload chip construction")
    assert.ok(
      validationIndex < tempChipIndex,
      "known-bad files must be rejected before temp upload chips are inserted into the composer",
    )

    const backendUploadIndex = handleAndUploadFiles.indexOf("apiClient.uploadFiles")
    assert.notEqual(backendUploadIndex, -1, "missing backend upload call")
    assert.ok(
      validationIndex < backendUploadIndex,
      "known-bad files must be rejected before any network upload is attempted",
    )
  })
})
