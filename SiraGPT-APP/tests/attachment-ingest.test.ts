import assert from "node:assert/strict"
import test from "node:test"

import { blobToFile, validateFile } from "../lib/attachment-ingest"

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const XLS_MIME = "application/vnd.ms-excel"

function makeFile(name: string, type: string, body = "data") {
  return new File([body], name, { type })
}

test("client upload policy accepts modern .xlsx uploads", () => {
  const byMime = validateFile(makeFile("dataset.xlsx", XLSX_MIME))
  assert.equal(byMime.ok, true)

  const browserOctetStream = validateFile(makeFile("browser-fallback.xlsx", "application/octet-stream"))
  assert.equal(browserOctetStream.ok, true)
})

test("client upload policy accepts legacy binary .xls uploads", () => {
  const accepted = validateFile(makeFile("legacy.xls", XLS_MIME))

  assert.equal(accepted.ok, true)
})

test("client upload policy keeps pasted image blobs uploadable with a generated filename", () => {
  const file = blobToFile(new Blob(["png-bytes"], { type: "image/png" }))

  assert.match(file.name, /^pasted-\d{4}-\d{2}-\d{2}T/)
  assert.match(file.name, /\.png$/)
  assert.equal(validateFile(file).ok, true)
})
