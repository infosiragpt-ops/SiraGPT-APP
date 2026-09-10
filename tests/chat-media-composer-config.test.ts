import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_ASPECT_RATIO_OPTIONS,
  MUSIC_STYLE_OPTIONS,
  MUSIC_STYLE_PROFILES,
  VIDEO_ASPECT_RATIO_OPTIONS,
  VOICE_COMPOSER_PLACEHOLDER,
  VOICE_LANGUAGE_OPTIONS,
  VOICE_MODEL_CATALOG,
  VOICE_MODEL_OPTIONS,
  defaultVoiceAccentFor,
  describeVoiceStability,
  isElevenVoiceModel,
  isImageModelEntry,
  isVideoModelEntry,
  providerForMediaModel,
  voiceAccentsFor,
  voiceBcp47For,
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
    // Sira Voz stays first (local, free); cloud engines follow. Legacy labels
    // ("Gemini 2.5 Flash TTS", "ElevenLabs") still resolve server-side.
    assert.deepEqual([...VOICE_MODEL_OPTIONS], [
      "Sira Voz",
      "Multilingual V2",
      "Eleven V3",
      "Flash V2.5",
      "Gemini Flash TTS",
      "Gemini Pro TTS",
      "OpenAI TTS",
      "OpenAI TTS HD",
      "GPT-4o mini TTS",
      "Turbo V2.5",
    ])
    assert.equal(VOICE_COMPOSER_PLACEHOLDER, "Escribe el texto que quieres convertir en voz")
    assert.equal(DEFAULT_VIDEO_MODEL, "")
  })

  it("covers every UI language with per-language accents and bcp47 tags", () => {
    assert.ok(VOICE_LANGUAGE_OPTIONS.length >= 44)
    for (const language of VOICE_LANGUAGE_OPTIONS) {
      const accents = voiceAccentsFor(language)
      assert.ok(accents.length >= 2, `${language} offers accents`)
      assert.ok(accents.includes(defaultVoiceAccentFor(language)))
      assert.match(voiceBcp47For(language), /^[a-z]{2,3}-[A-Z]{2}$/)
    }
    // Accent follows language: Spanish keeps Latino, English defaults to US.
    assert.deepEqual(voiceAccentsFor("Spanish").slice(0, 2), ["Latino", "Mexican"])
    assert.equal(defaultVoiceAccentFor("English"), "US")
  })

  it("gates the ElevenLabs voice disc without false-positiving Google/OpenAI", () => {
    assert.equal(isElevenVoiceModel("Multilingual V2"), true)
    assert.equal(isElevenVoiceModel("ElevenLabs"), true)
    assert.equal(isElevenVoiceModel("Gemini Flash TTS"), false)
    assert.equal(isElevenVoiceModel("OpenAI TTS"), false)
    assert.equal(isElevenVoiceModel("Sira Voz"), false)
  })

  it("labels stability and catalog engines for the picker", () => {
    assert.equal(describeVoiceStability(80), "Estable")
    assert.equal(describeVoiceStability(20), "Muy expresivo")
    const labels = VOICE_MODEL_CATALOG.map((m) => m.label)
    for (const option of VOICE_MODEL_OPTIONS) {
      assert.ok(labels.includes(option), `${option} has catalog metadata`)
    }
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
