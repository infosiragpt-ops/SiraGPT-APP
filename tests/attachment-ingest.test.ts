import assert from "node:assert/strict"
import test from "node:test"

import { blobToFile, DEFAULT_MAX_MEDIA_BYTES, isMediaUpload, validateFile } from "../lib/attachment-ingest"

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

test("audio and video are capped at 2 GB while documents keep the 100 MB cap", () => {
  const MB = 1024 * 1024
  assert.equal(DEFAULT_MAX_MEDIA_BYTES, 2048 * MB)
  const video = { name: "clase.mp4", type: "video/mp4", size: 900 * MB } as unknown as File
  const audio = { name: "charla.m4a", type: "", size: 300 * MB } as unknown as File
  const pdf = { name: "libro.pdf", type: "application/pdf", size: 300 * MB } as unknown as File
  assert.equal(isMediaUpload(video), true)
  assert.equal(isMediaUpload(audio), true, "extension fallback when the browser reports no mime")
  assert.equal(isMediaUpload(pdf), false)
  assert.equal(validateFile(video).ok, true)
  assert.equal(validateFile(audio).ok, true)
  const rejected = validateFile(pdf)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, "size_exceeded")
  assert.match(rejected.reason, /100 MB/)
  const huge = validateFile({ name: "x.mp4", type: "video/mp4", size: 3000 * MB } as unknown as File)
  assert.equal(huge.code, "size_exceeded")
  assert.match(huge.reason, /2048 MB/)
})
