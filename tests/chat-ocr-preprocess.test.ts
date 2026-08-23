import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyAdaptiveThreshold,
  estimateDeskewAngle,
  isWeakOcrText,
  looksLikeTranscriptionRequest,
  pickUpscaleFactor,
  shouldRetryOcr,
} from "../lib/chat/ocr-preprocess"

describe("chat OCR preprocess helpers", () => {
  it("upscales tiny banners 4× and typical photos 3×", () => {
    assert.equal(pickUpscaleFactor(610, 94), 4)
    assert.equal(pickUpscaleFactor(1600, 900), 3)
  })

  it("retries when confidence or useful characters are low", () => {
    assert.equal(shouldRetryOcr(40, 20), true)
    assert.equal(shouldRetryOcr(90, 3), true)
    assert.equal(shouldRetryOcr(90, 20), false)
    assert.equal(isWeakOcrText("No text found in image"), true)
    assert.equal(isWeakOcrText("https://mecaelectricperu.com.pe", 88), false)
  })

  it("detects transcription requests and binarizes a contrast strip", () => {
    assert.equal(looksLikeTranscriptionRequest("transcribir"), true)
    assert.equal(looksLikeTranscriptionRequest("qué dice esta captura"), true)
    assert.equal(looksLikeTranscriptionRequest("hola"), false)

    const width = 24
    const height = 8
    const data = new Uint8ClampedArray(width * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        data[y * width + x] = x < 12 ? 20 : 230
      }
    }
    applyAdaptiveThreshold({ data, width, height })
    assert.equal(data[4], 0)
    assert.equal(data[20], 255)
    assert.equal(estimateDeskewAngle({ data, width, height }), 0)
  })
})
