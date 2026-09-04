import { beforeEach, describe, expect, it } from "vitest"

import {
  isSiraVozModel,
  readStoredVoiceStudioVoice,
  VOICE_STUDIO_STORAGE_KEYS,
  writeStoredVoiceStudioVoice,
} from "@/lib/chat/media-composer-config"

describe("Sira Voz (VoiceStudio) composer helpers", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("recognises the local studio row by pattern, never the cloud voices", () => {
    for (const name of ["sira-voz", "Sira Voz", "voicestudio-local", "VoiceStudio", "omnivoice"]) {
      expect(isSiraVozModel(name)).toBe(true)
    }
    for (const name of ["gemini-2.5-flash-tts", "ElevenLabs", "eleven-multilingual-v2", "", null, undefined]) {
      expect(isSiraVozModel(name)).toBe(false)
    }
  })

  it("persists the chosen cloned voice under the composer namespace", () => {
    expect(VOICE_STUDIO_STORAGE_KEYS).toEqual({
      voiceId: "sira:composer:voice:studio-voice-id",
      voiceName: "sira:composer:voice:studio-voice-name",
    })
    expect(readStoredVoiceStudioVoice()).toEqual({ id: "", name: "" })
    writeStoredVoiceStudioVoice({ id: "clx123abc", name: "Mi voz" })
    expect(readStoredVoiceStudioVoice()).toEqual({ id: "clx123abc", name: "Mi voz" })
    writeStoredVoiceStudioVoice(null)
    expect(readStoredVoiceStudioVoice()).toEqual({ id: "", name: "" })
  })

  it("ignores a tampered id", () => {
    window.localStorage.setItem(VOICE_STUDIO_STORAGE_KEYS.voiceId, "../../etc")
    window.localStorage.setItem(VOICE_STUDIO_STORAGE_KEYS.voiceName, "x")
    expect(readStoredVoiceStudioVoice()).toEqual({ id: "", name: "" })
  })
})
