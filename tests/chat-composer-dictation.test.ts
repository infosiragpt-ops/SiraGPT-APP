import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  getSpeechRecognitionCtor,
  isIgnorableSpeechError,
  isSpeechPermissionError,
  resolveDictationLanguage,
  shouldRestartNativeDictation,
} from "../lib/chat/composer-dictation"

describe("composer dictation helpers", () => {
  it("prefers the standard SpeechRecognition constructor", () => {
    const ctor = function SpeechRecognition() {}
    assert.equal(getSpeechRecognitionCtor({ SpeechRecognition: ctor as any }), ctor)
  })

  it("falls back to webkitSpeechRecognition", () => {
    const ctor = function webkitSpeechRecognition() {}
    assert.equal(getSpeechRecognitionCtor({ webkitSpeechRecognition: ctor as any }), ctor)
  })

  it("returns null when the browser has no speech API", () => {
    assert.equal(getSpeechRecognitionCtor({}), null)
    assert.equal(getSpeechRecognitionCtor(undefined), null)
  })

  it("keeps Spanish and remaps English UI language to es-ES", () => {
    assert.equal(resolveDictationLanguage({ languages: ["es-MX", "en"], language: "en-US" }), "es-MX")
    assert.equal(resolveDictationLanguage({ language: "en-US" }), "es-ES")
    assert.equal(resolveDictationLanguage({}), "es-ES")
  })

  it("restarts native listening only while the user still wants the mic open", () => {
    assert.equal(shouldRestartNativeDictation("native", true), true)
    assert.equal(shouldRestartNativeDictation("native", false), false)
    assert.equal(shouldRestartNativeDictation("idle", true), false)
    assert.equal(shouldRestartNativeDictation("recorder", true), false)
  })

  it("classifies speech errors", () => {
    assert.equal(isSpeechPermissionError("not-allowed"), true)
    assert.equal(isSpeechPermissionError("network"), false)
    assert.equal(isIgnorableSpeechError("no-speech"), true)
    assert.equal(isIgnorableSpeechError("aborted"), true)
    assert.equal(isIgnorableSpeechError("network"), false)
  })
})
