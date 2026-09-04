import { beforeEach, describe, expect, it } from "vitest"

import {
  readStoredVoiceSetting,
  VOICE_SETTINGS_STORAGE_KEYS,
  writeStoredVoiceSettings,
} from "@/lib/chat/media-composer-config"

describe("voice settings storage", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("declares one key per setting under the composer namespace", () => {
    expect(VOICE_SETTINGS_STORAGE_KEYS).toEqual({
      model: "sira:composer:voice:model",
      language: "sira:composer:voice:language",
      accent: "sira:composer:voice:accent",
      stability: "sira:composer:voice:stability",
      effect: "sira:composer:voice:effect",
    })
  })

  it("falls back when nothing is stored", () => {
    expect(readStoredVoiceSetting("language", "Spanish")).toBe("Spanish")
    expect(readStoredVoiceSetting("stability", 100)).toBe(100)
  })

  it("round-trips valid settings", () => {
    writeStoredVoiceSettings({ language: "English", accent: "Mexican", effect: "Warm", stability: 42, model: "gemini-2.5-flash-tts" })
    expect(readStoredVoiceSetting("language", "Spanish")).toBe("English")
    expect(readStoredVoiceSetting("accent", "Latino")).toBe("Mexican")
    expect(readStoredVoiceSetting("effect", "Studio Clean")).toBe("Warm")
    expect(readStoredVoiceSetting("stability", 100)).toBe(42)
    expect(readStoredVoiceSetting("model", "")).toBe("gemini-2.5-flash-tts")
  })

  it("rejects foreign language/accent/effect values", () => {
    writeStoredVoiceSettings({ language: "Klingon", accent: "Martian", effect: "MegaBass" })
    expect(readStoredVoiceSetting("language", "Spanish")).toBe("Spanish")
    expect(readStoredVoiceSetting("accent", "Latino")).toBe("Latino")
    expect(readStoredVoiceSetting("effect", "Studio Clean")).toBe("Studio Clean")
  })

  it("clamps stability into 0..100 and falls back on garbage", () => {
    writeStoredVoiceSettings({ stability: 250 })
    expect(readStoredVoiceSetting("stability", 100)).toBe(100)
    writeStoredVoiceSettings({ stability: -5 })
    expect(readStoredVoiceSetting("stability", 100)).toBe(0)
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEYS.stability, "not-a-number")
    expect(readStoredVoiceSetting("stability", 100)).toBe(100)
  })

  it("survives a missing localStorage without throwing", () => {
    const getItem = window.localStorage.getItem
    Object.defineProperty(window, "localStorage", { value: undefined, configurable: true })
    try {
      expect(readStoredVoiceSetting("language", "Spanish")).toBe("Spanish")
      expect(() => writeStoredVoiceSettings({ language: "English" })).not.toThrow()
    } finally {
      Object.defineProperty(window, "localStorage", { value: { getItem }, configurable: true })
    }
  })
})
