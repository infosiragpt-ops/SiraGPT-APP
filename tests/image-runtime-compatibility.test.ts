import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import sharp from "sharp"
import { RawImage } from "@huggingface/transformers"
import { optimizeImage } from "next/dist/server/image-optimizer"

// Native compatibility checks: real image bytes, Sharp, the Next optimizer and
// Transformers' image adapter. No network, model downloads or provider mocks.
// These complement browser/production checks; they are not editing-engine E2E.
const createPng = () => sharp({
  create: { width: 32, height: 16, channels: 4, background: "#ff0000" },
}).png().toBuffer()

test("Next and Transformers resolve the same patched native image runtime", () => {
  const { satisfies } = require("semver") as { satisfies: (version: string, range: string) => boolean }
  assert.ok(satisfies(sharp.versions.sharp, ">=0.35.4"), "Sharp must include the patched native codecs")
  assert.ok(satisfies(require("next/package.json").version, ">=15.5.25"), "Next must include the image security fixes")
  const rootSharp = require.resolve("sharp")
  for (const consumer of ["next", "@huggingface/transformers"]) {
    const fromConsumer = createRequire(require.resolve(consumer))
    assert.equal(fromConsumer.resolve("sharp"), rootSharp)
    assert.equal(fromConsumer("sharp").versions.sharp, sharp.versions.sharp)
  }
})

test("Sharp preserves decoded RGBA pixels across PNG encoding and resize", async () => {
  const input = await createPng()
  const resized = await sharp(input).resize(8, 4).png().toBuffer()
  const { data, info } = await sharp(resized).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height, info.channels], [8, 4, 4])
  for (let offset = 0; offset < data.length; offset += 4) {
    assert.deepEqual([...data.subarray(offset, offset + 4)], [255, 0, 0, 255])
  }
})

for (const [contentType, format] of [
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
] as const) {
  test(`Next optimizes real PNG bytes to ${format} without changing aspect ratio`, async () => {
    const output = await optimizeImage({
      buffer: await createPng(), contentType, quality: 80, width: 16,
    })
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.format, format)
    assert.deepEqual([metadata.width, metadata.height], [16, 8])
    assert.ok(output.length > 0)
  })
}

test("Next accepts patched AVIF decoding and encoding with native Sharp", async () => {
  const input = await sharp(await createPng()).avif({ quality: 80 }).toBuffer()
  const output = await optimizeImage({
    buffer: input, contentType: "image/avif", quality: 80, width: 16,
  })
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.format, "heif")
  assert.equal(metadata.compression, "av1")
  assert.deepEqual([metadata.width, metadata.height], [16, 8])
})

test("Next retains the configured input pixel limit", async () => {
  await assert.rejects(optimizeImage({
    buffer: await createPng(), contentType: "image/png", quality: 80,
    width: 16, limitInputPixels: 128,
  }), /pixel limit/i)
})

test("Next rejects invalid image bytes without producing an output", async () => {
  await assert.rejects(optimizeImage({
    buffer: Buffer.from("not an image"), contentType: "image/png", quality: 80, width: 16,
  }), /unsupported image format|corrupt|invalid/i)
})

test("Transformers decodes and resizes real bytes through its Sharp adapter", async () => {
  const png = await createPng()
  const input = await RawImage.fromBlob(new Blob([new Uint8Array(png)], { type: "image/png" }))
  assert.deepEqual([input.width, input.height, input.channels], [32, 16, 4])
  const resized = await input.resize(8, 4, { resample: "lanczos" })
  assert.deepEqual([resized.width, resized.height, resized.channels], [8, 4, 4])
  assert.deepEqual([...resized.data.slice(0, 4)], [255, 0, 0, 255])
  assert.deepEqual(resized.toTensor("CHW").dims, [4, 4, 8])
})

test("Transformers rejects malformed image input through the native adapter", async () => {
  await assert.rejects(RawImage.fromBlob(new Blob(["not an image"], { type: "image/png" })),
    /unsupported image format|corrupt|invalid/i)
})
