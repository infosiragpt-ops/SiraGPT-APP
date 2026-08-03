import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiClientMock = vi.hoisted(() => ({
  apiBaseURL: "https://siragpt.test/api",
  getOfficeSoundscape: vi.fn(),
}))

const authenticatedFetchMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({
  default: apiClientMock,
}))

vi.mock("@/lib/authenticated-fetch", () => ({
  authenticatedFetch: authenticatedFetchMock,
}))

import { useOfficeSoundscape } from "@/components/code/agent-office/use-office-soundscape"

type FakeSource = {
  buffer: AudioBuffer | null
  loop: boolean
  playbackRate: { value: number }
  onended: (() => void) | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

type FakeFilter = {
  type: BiquadFilterType
  frequency: ReturnType<typeof audioParam>
  Q: ReturnType<typeof audioParam>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

const contexts: FakeAudioContext[] = []
let resumeAllowed = true

function audioParam(value = 1) {
  return {
    value,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(function setValue(next: number) {
      this.value = next
    }),
    linearRampToValueAtTime: vi.fn(function ramp(next: number) {
      this.value = next
    }),
    setTargetAtTime: vi.fn(function target(next: number) {
      this.value = next
    }),
  }
}

class FakeAudioContext {
  state: AudioContextState = "suspended"
  currentTime = 0
  destination = {}
  filters: FakeFilter[] = []
  close = vi.fn(async () => {
    this.state = "closed"
  })
  resume = vi.fn(async () => {
    if (!resumeAllowed) throw new DOMException("Autoplay blocked", "NotAllowedError")
    this.state = "running"
  })
  suspend = vi.fn(async () => {
    this.state = "suspended"
  })
  decodeAudioData = vi.fn(async () => ({} as AudioBuffer))
  createGain = vi.fn(() => ({
    gain: audioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  createDynamicsCompressor = vi.fn(() => ({
    threshold: audioParam(),
    knee: audioParam(),
    ratio: audioParam(),
    attack: audioParam(),
    release: audioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  createBiquadFilter = vi.fn(() => {
    const filter: FakeFilter = {
      type: "lowpass",
      frequency: audioParam(),
      Q: audioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    this.filters.push(filter)
    return filter
  })
  createBufferSource = vi.fn((): FakeSource => ({
    buffer: null,
    loop: false,
    playbackRate: { value: 1 },
    onended: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }))

  constructor() {
    contexts.push(this)
  }
}

function renderSoundscape(active = true) {
  return renderHook(
    ({ isActive }) =>
      useOfficeSoundscape({
        active: isActive,
        timeOfDay: "day",
        paused: false,
        activeCount: 2,
      }),
    { initialProps: { isActive: active } },
  )
}

describe("office soundscape lifecycle", () => {
  beforeEach(() => {
    cleanup()
    contexts.length = 0
    resumeAllowed = true
    localStorage.clear()
    vi.clearAllMocks()
    vi.stubGlobal("AudioContext", FakeAudioContext)
    apiClientMock.getOfficeSoundscape.mockImplementation(async (soundId: string) => ({
      audio_url: `/elevenlabs/audio/${soundId}.mp3`,
    }))
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16),
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("starts the prerecorded ElevenLabs ambience when the office opens", async () => {
    const { result } = renderSoundscape()

    await waitFor(() => expect(result.current.state).toBe("elevenlabs"))

    expect(result.current.enabled).toBe(true)
    expect(result.current.volume).toBe(0.28)
    expect(apiClientMock.getOfficeSoundscape).toHaveBeenCalledWith("coast-day")
    expect(apiClientMock.getOfficeSoundscape).toHaveBeenCalledWith("terrace-steps")
    expect(contexts[0]?.resume).toHaveBeenCalled()
    expect(contexts[0]?.filters.map((filter) => filter.type)).toEqual([
      "highpass",
      "lowpass",
    ])
    expect(contexts[0]?.filters[0]?.frequency.value).toBe(55)
    expect(contexts[0]?.filters[1]?.frequency.value).toBe(14_500)
  })

  it("respects an explicit mute preference on later office openings", async () => {
    localStorage.setItem("siragpt:office-sound-enabled", "off")
    const { result } = renderSoundscape()

    await waitFor(() => expect(result.current.state).toBe("off"))

    expect(result.current.enabled).toBe(false)
    expect(apiClientMock.getOfficeSoundscape).not.toHaveBeenCalled()
    expect(contexts).toHaveLength(0)
  })

  it("closes the audio context when the office closes", async () => {
    const { result, rerender } = renderSoundscape()
    await waitFor(() => expect(result.current.state).toBe("elevenlabs"))
    const context = contexts[0]

    rerender({ isActive: false })

    await waitFor(() => expect(result.current.state).toBe("off"))
    expect(context?.close).toHaveBeenCalled()
  })

  it("recovers from browser autoplay blocking on the next user interaction", async () => {
    resumeAllowed = false
    const { result } = renderSoundscape()
    await waitFor(() => expect(result.current.state).toBe("blocked"))

    resumeAllowed = true
    act(() => window.dispatchEvent(new Event("pointerdown")))

    await waitFor(() => expect(result.current.state).toBe("elevenlabs"))
    expect(contexts[0]?.resume.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("stops immediately when the browser page is being discarded", async () => {
    const { result } = renderSoundscape()
    await waitFor(() => expect(result.current.state).toBe("elevenlabs"))
    const context = contexts[0]

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))

    await waitFor(() => expect(result.current.state).toBe("off"))
    expect(context?.close).toHaveBeenCalled()
  })

  it("persists a deliberate mute and restores the selected volume", async () => {
    const { result } = renderSoundscape()
    await waitFor(() => expect(result.current.state).toBe("elevenlabs"))

    act(() => result.current.setVolume(0.21))
    act(() => result.current.toggle())

    expect(localStorage.getItem("siragpt:office-sound-volume")).toBe("0.21")
    expect(localStorage.getItem("siragpt:office-sound-enabled")).toBe("off")
    expect(result.current.enabled).toBe(false)
  })

  it("plays restrained operational cues only after a live count changes", async () => {
    const { result, rerender } = renderHook(
      ({ activeCount, approvalCount, attentionCount }) =>
        useOfficeSoundscape({
          active: true,
          timeOfDay: "night",
          timePhase: "night",
          paused: false,
          activeCount,
          approvalCount,
          attentionCount,
        }),
      {
        initialProps: {
          activeCount: 2,
          approvalCount: 0,
          attentionCount: 0,
        },
      },
    )

    await waitFor(() => expect(result.current.state).toBe("elevenlabs"))
    expect(apiClientMock.getOfficeSoundscape).toHaveBeenCalledWith("coast-night")
    expect(apiClientMock.getOfficeSoundscape).not.toHaveBeenCalledWith("work-start")
    expect(contexts[0]?.filters[0]?.frequency.value).toBe(42)
    expect(contexts[0]?.filters[1]?.frequency.value).toBe(11_000)

    rerender({ activeCount: 3, approvalCount: 0, attentionCount: 0 })
    await waitFor(() =>
      expect(apiClientMock.getOfficeSoundscape).toHaveBeenCalledWith("work-start"),
    )

    rerender({ activeCount: 3, approvalCount: 1, attentionCount: 0 })
    await waitFor(() =>
      expect(apiClientMock.getOfficeSoundscape).toHaveBeenCalledWith("approval-ready"),
    )

    rerender({ activeCount: 3, approvalCount: 1, attentionCount: 1 })
    await waitFor(() =>
      expect(apiClientMock.getOfficeSoundscape).toHaveBeenCalledWith("attention"),
    )
  })
})
