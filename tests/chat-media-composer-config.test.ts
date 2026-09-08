import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_ASPECT_RATIO_OPTIONS,
  MUSIC_STYLE_OPTIONS,
  MUSIC_STYLE_PROFILES,
  VIDEO_ASPECT_RATIO_OPTIONS,
  VOICE_COMPOSER_PLACEHOLDER,
  VOICE_MODEL_OPTIONS,
  isImageModelEntry,
  isVideoModelEntry,
  providerForMediaModel,
} from "../lib/chat/media-composer-config"

describe("chat media composer configuration", () => {
  it("publishes complete, unique image/video aspect-ratio choices", () => {
    assert.equal(new Set(IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value)).size, IMAGE_ASPECT_RATIO_OPTIONS.length)
    assert.equal(new Set(VIDEO_ASPECT_RATIO_OPTIONS.map((option) => option.value)).size, VIDEO_ASPECT_RATIO_OPTIONS.length)
    assert.ok(IMAGE_ASPECT_RATIO_OPTIONS.some((option) => option.value === "16:9"))
    assert.ok(VIDEO_ASPECT_RATIO_OPTIONS.some((option) => option.value === "auto"))
  })

  it("keeps every guided music style backed by a profile", () => {
    for (const style of MUSIC_STYLE_OPTIONS) {
      assert.equal(MUSIC_STYLE_PROFILES[style].label, style)
      assert.ok(MUSIC_STYLE_PROFILES[style].description.length > 10)
    }
  })

  it("keeps working voice defaults and avoids forcing a video engine", () => {
    assert.deepEqual(VOICE_MODEL_OPTIONS, ["Gemini 2.5 Flash TTS", "ElevenLabs", "Sira Voz"])
    assert.equal(VOICE_COMPOSER_PLACEHOLDER, "Escribe el texto que quieres convertir en voz")
    assert.equal(DEFAULT_VIDEO_MODEL, "")
  })

  it("classifies provider and model capabilities deterministically", () => {
    // google/* models route direct to Google in the reconciled drift config.
    assert.equal(providerForMediaModel("google/imagen-4"), "Google")
    assert.equal(providerForMediaModel("Veo 3"), "Google")
    assert.equal(providerForMediaModel("Kling 2.1"), "Kling")
    assert.equal(isImageModelEntry({ displayName: "GPT Image 1" }), true)
    assert.equal(isVideoModelEntry({ name: "Sora 2" }), true)
    assert.equal(isImageModelEntry({ type: "text", name: "GPT" }), false)
  })
})
