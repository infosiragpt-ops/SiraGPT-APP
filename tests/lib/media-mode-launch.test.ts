import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  announceMediaModeLaunch,
  consumeMediaModeLaunch,
  isMediaMode,
  MEDIA_LAUNCH_LABELS,
  MEDIA_LAUNCH_MODES,
  MEDIA_MODE_LAUNCH_EVENT,
  storeMediaModeLaunch,
} from "@/lib/chat/media-mode-launch"

describe("sidebar «Más» media-mode launch", () => {
  beforeEach(() => window.sessionStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("lists Video, Voz, Imagen y Música in that order", () => {
    expect(MEDIA_LAUNCH_MODES).toEqual(["video", "voice", "image", "music"])
    expect(MEDIA_LAUNCH_MODES.map((m) => MEDIA_LAUNCH_LABELS[m])).toEqual(["Video", "Voz", "Imagen", "Música"])
  })

  it("stores a launch that is consumed exactly once", () => {
    storeMediaModeLaunch("music", 1_000)
    expect(consumeMediaModeLaunch(1_500)).toBe("music")
    expect(consumeMediaModeLaunch(1_600)).toBeNull()
  })

  it("drops stale, malformed or unknown launches", () => {
    storeMediaModeLaunch("video", 0)
    expect(consumeMediaModeLaunch(61_000)).toBeNull()
    window.sessionStorage.setItem("sira:media-mode-launch", "{nope")
    expect(consumeMediaModeLaunch()).toBeNull()
    window.sessionStorage.setItem("sira:media-mode-launch", JSON.stringify({ mode: "text", at: Date.now() }))
    expect(consumeMediaModeLaunch()).toBeNull()
    storeMediaModeLaunch("chat" as never)
    expect(window.sessionStorage.getItem("sira:media-mode-launch")).toBeNull()
  })

  it("announces the mode live for an open composer", () => {
    const seen: unknown[] = []
    const onLaunch = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(MEDIA_MODE_LAUNCH_EVENT, onLaunch)
    announceMediaModeLaunch("image")
    window.removeEventListener(MEDIA_MODE_LAUNCH_EVENT, onLaunch)
    expect(seen).toEqual(["image"])
    expect(isMediaMode("voice")).toBe(true)
    expect(isMediaMode("docx")).toBe(false)
  })
})
