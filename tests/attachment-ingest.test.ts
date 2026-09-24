import assert from "node:assert/strict"
import test from "node:test"

import { blobToFile, DEFAULT_MAX_MEDIA_BYTES, isMediaUpload, validateFile, validateBatch } from "../lib/attachment-ingest"

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

test("audio and video are capped at 10 GB while documents keep the 100 MB cap", () => {
  const MB = 1024 * 1024
  assert.equal(DEFAULT_MAX_MEDIA_BYTES, 10240 * MB)
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
  assert.match(String(rejected.reason), /100 MB/)
  const tenHours = validateFile({ name: "clase-10h.mkv", type: "video/x-matroska", size: 6000 * MB } as unknown as File)
  assert.equal(tenHours.ok, true, "a 6 GB 10-hour lecture is accepted")
  const huge = validateFile({ name: "x.mp4", type: "video/mp4", size: 11000 * MB } as unknown as File)
  assert.equal(huge.code, "size_exceeded")
  assert.match(String(huge.reason), /10 GB/)
  for (const name of ["nota.caf", "llamada.amr", "voz.weba", "podcast.m4b", "clase.ts", "cine.wmv"]) {
    assert.equal(isMediaUpload({ name, type: "" } as unknown as File), true, name)
  }
})

test("supports 50 recordings with a clear 51st rejection and MIME-less formats", () => {
  const files = Array.from({length: 51}, (_, index) => makeFile(`${index}.flac`, ""))
  const result = validateBatch(files)
  assert.equal(result.accepted.length, 50)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /50 audios/)
  assert.equal(validateBatch(files.slice(0, 2), { existingMediaCount: 49 }).accepted.length, 1)
  for (const ext of ["flac", "aac", "wma", "aif", "aiff"]) {
    assert.equal(validateFile({name: `lecture.${ext}`, type: "", size: 200 * 1024 * 1024} as File).ok, true)
  }
})
