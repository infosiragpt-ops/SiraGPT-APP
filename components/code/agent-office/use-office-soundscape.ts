"use client"

import * as React from "react"

import apiClient from "@/lib/api"
import type { OfficeTimeOfDay } from "@/lib/agent-office-environment"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

type OfficeSoundId = "coast-day" | "coast-night" | "terrace-steps"
export type OfficeSoundState =
  | "off"
  | "loading"
  | "elevenlabs"
  | "blocked"
  | "unavailable"

type LoopingSource = {
  source: AudioBufferSourceNode
  gain: GainNode
}

type AudioEngine = {
  context: AudioContext
  master: GainNode
  ambienceBus: GainNode
  actionBus: GainNode
  ambience: LoopingSource | null
  stepBuffer: AudioBuffer | null
}

const SOUND_PREFERENCE_KEY = "siragpt:office-sound-enabled"
const SOUND_VOLUME_KEY = "siragpt:office-sound-volume"
const DEFAULT_VOLUME = 0.32
const encodedSoundCache = new Map<OfficeSoundId, ArrayBuffer>()
const soundRequests = new Map<OfficeSoundId, Promise<ArrayBuffer>>()

function officeSoundUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${apiClient.apiBaseURL}${path.startsWith("/") ? path : `/${path}`}`
}

async function fetchOfficeSound(soundId: OfficeSoundId): Promise<ArrayBuffer> {
  const cached = encodedSoundCache.get(soundId)
  if (cached) return cached
  const inFlight = soundRequests.get(soundId)
  if (inFlight) return inFlight

  const request = (async () => {
    const sound = await apiClient.getOfficeSoundscape(soundId)
    const response = await authenticatedFetch(officeSoundUrl(sound.audio_url), {
      credentials: "include",
      cache: "force-cache",
    })
    if (!response.ok) throw new Error(`Office audio HTTP ${response.status}`)
    const encoded = await response.arrayBuffer()
    if (encoded.byteLength === 0) throw new Error("Office audio is empty")
    encodedSoundCache.set(soundId, encoded)
    return encoded
  })().finally(() => {
    soundRequests.delete(soundId)
  })

  soundRequests.set(soundId, request)
  return request
}

function readStoredPreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_PREFERENCE_KEY) !== "off"
  } catch {
    return true
  }
}

function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(SOUND_VOLUME_KEY)
    if (raw === null) return DEFAULT_VOLUME
    const stored = Number(raw)
    return Number.isFinite(stored) && stored >= 0 && stored <= 1
      ? stored
      : DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

function storePreference(enabled: boolean) {
  try {
    window.localStorage.setItem(SOUND_PREFERENCE_KEY, enabled ? "on" : "off")
  } catch {
    // Private browsing can reject storage writes; audio still works for this session.
  }
}

function storeVolume(volume: number) {
  try {
    window.localStorage.setItem(SOUND_VOLUME_KEY, String(volume))
  } catch {
    // Keep the in-memory volume when persistent storage is unavailable.
  }
}

function createAudioEngine(volume: number): AudioEngine | null {
  const AudioContextConstructor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return null

  const context = new AudioContextConstructor({ latencyHint: "playback" })
  const master = context.createGain()
  const ambienceBus = context.createGain()
  const actionBus = context.createGain()
  master.gain.value = volume
  ambienceBus.gain.value = 0.72
  actionBus.gain.value = 0.3
  ambienceBus.connect(master)
  actionBus.connect(master)
  master.connect(context.destination)
  return {
    context,
    master,
    ambienceBus,
    actionBus,
    ambience: null,
    stepBuffer: null,
  }
}

function stopLoop(
  loop: LoopingSource | null,
  context: AudioContext,
  { immediate = false }: { immediate?: boolean } = {},
) {
  if (!loop) return
  const now = context.currentTime
  const stopAt = immediate ? now : now + 0.18
  try {
    loop.gain.gain.cancelScheduledValues(now)
    loop.gain.gain.setValueAtTime(loop.gain.gain.value, now)
    loop.gain.gain.linearRampToValueAtTime(0.0001, stopAt)
    loop.source.stop(stopAt + 0.02)
  } catch {
    // The source may already have completed or its context may be closing.
  }
  loop.source.onended = () => {
    loop.source.disconnect()
    loop.gain.disconnect()
  }
}

function replaceAmbience(engine: AudioEngine, buffer: AudioBuffer) {
  const { context } = engine
  const now = context.currentTime
  const source = context.createBufferSource()
  const gain = context.createGain()
  source.buffer = buffer
  source.loop = true
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.linearRampToValueAtTime(1, now + 0.7)
  source.connect(gain)
  gain.connect(engine.ambienceBus)
  source.start()

  const previous = engine.ambience
  engine.ambience = { source, gain }
  stopLoop(previous, context)
}

function playFootsteps(engine: AudioEngine) {
  if (!engine.stepBuffer || engine.context.state !== "running") return
  const source = engine.context.createBufferSource()
  const gain = engine.context.createGain()
  source.buffer = engine.stepBuffer
  source.playbackRate.value = 0.96 + Math.random() * 0.08
  gain.gain.value = 0.18
  source.connect(gain)
  gain.connect(engine.actionBus)
  source.onended = () => {
    source.disconnect()
    gain.disconnect()
  }
  source.start()
}

export function useOfficeSoundscape({
  active,
  timeOfDay,
  paused,
  activeCount,
}: {
  active: boolean
  timeOfDay: OfficeTimeOfDay
  paused: boolean
  activeCount: number
}) {
  const engineRef = React.useRef<AudioEngine | null>(null)
  const loadKeyRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  const activeRef = React.useRef(active)
  const desiredEnabledRef = React.useRef(true)
  const volumeRef = React.useRef(DEFAULT_VOLUME)
  const [enabled, setEnabled] = React.useState(false)
  const [state, setState] = React.useState<OfficeSoundState>("off")
  const [volume, setVolumeState] = React.useState(DEFAULT_VOLUME)

  activeRef.current = active

  const ensureEngine = React.useCallback(() => {
    const current = engineRef.current
    if (current && current.context.state !== "closed") return current
    engineRef.current = createAudioEngine(volumeRef.current)
    return engineRef.current
  }, [])

  const stopSession = React.useCallback(() => {
    loadKeyRef.current += 1
    const engine = engineRef.current
    engineRef.current = null
    if (engine) {
      stopLoop(engine.ambience, engine.context, { immediate: true })
      engine.ambience = null
      engine.stepBuffer = null
      void engine.context.close().catch(() => {})
    }
    setEnabled(false)
    setState("off")
  }, [])

  const resume = React.useCallback(async (engine: AudioEngine) => {
    try {
      await engine.context.resume()
      if (!mountedRef.current || engineRef.current !== engine) return false
      return engine.context.state === "running"
    } catch {
      return false
    }
  }, [])

  const enable = React.useCallback(
    async ({ persist = true }: { persist?: boolean } = {}) => {
      desiredEnabledRef.current = true
      if (persist) storePreference(true)
      const engine = ensureEngine()
      if (!engine) {
        setEnabled(false)
        setState("unavailable")
        return
      }
      setEnabled(true)
      setState("loading")
      const running = await resume(engine)
      if (!running && mountedRef.current && engineRef.current === engine) {
        setState("blocked")
      }
    },
    [ensureEngine, resume],
  )

  const disable = React.useCallback(() => {
    desiredEnabledRef.current = false
    storePreference(false)
    stopSession()
  }, [stopSession])

  const toggle = React.useCallback(() => {
    if (enabled && state !== "unavailable") disable()
    else void enable()
  }, [disable, enable, enabled, state])

  const setVolume = React.useCallback((nextVolume: number) => {
    const bounded = Math.min(1, Math.max(0, nextVolume))
    volumeRef.current = bounded
    setVolumeState(bounded)
    storeVolume(bounded)
    const engine = engineRef.current
    if (engine && engine.context.state !== "closed") {
      engine.master.gain.setTargetAtTime(bounded, engine.context.currentTime, 0.04)
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    volumeRef.current = readStoredVolume()
    setVolumeState(volumeRef.current)
    return () => {
      mountedRef.current = false
      stopSession()
    }
  }, [stopSession])

  React.useEffect(() => {
    if (!active) {
      stopSession()
      return
    }

    desiredEnabledRef.current = readStoredPreference()
    if (desiredEnabledRef.current) void enable({ persist: false })
    else {
      setEnabled(false)
      setState("off")
    }

    return () => stopSession()
  }, [active, enable, stopSession])

  React.useEffect(() => {
    if (!active || !enabled) return
    const engine = ensureEngine()
    if (!engine) return
    const loadKey = ++loadKeyRef.current
    setState((current) => (current === "blocked" ? current : "loading"))

    const ambientId: OfficeSoundId = timeOfDay === "day" ? "coast-day" : "coast-night"
    void Promise.all([
      fetchOfficeSound(ambientId),
      fetchOfficeSound("terrace-steps").catch(() => null),
    ])
      .then(async ([ambientEncoded, stepEncoded]) => {
        const ambientBuffer = await engine.context.decodeAudioData(ambientEncoded.slice(0))
        const stepBuffer = stepEncoded
          ? await engine.context.decodeAudioData(stepEncoded.slice(0)).catch(() => null)
          : null
        if (
          !mountedRef.current ||
          loadKey !== loadKeyRef.current ||
          engineRef.current !== engine
        ) {
          return
        }

        replaceAmbience(engine, ambientBuffer)
        engine.stepBuffer = stepBuffer
        setState(
          engine.context.state === "running" || paused ? "elevenlabs" : "blocked",
        )
      })
      .catch(() => {
        if (mountedRef.current && loadKey === loadKeyRef.current) {
          setState("unavailable")
        }
      })
  }, [active, enabled, ensureEngine, paused, timeOfDay])

  React.useEffect(() => {
    if (!active || !enabled) return
    const unlock = () => {
      const engine = engineRef.current
      if (!engine || engine.context.state === "closed") return
      void resume(engine).then((running) => {
        if (!mountedRef.current || engineRef.current !== engine) return
        if (running) setState(engine.ambience ? "elevenlabs" : "loading")
        else setState("blocked")
      })
    }
    window.addEventListener("pointerdown", unlock, { capture: true })
    window.addEventListener("keydown", unlock, { capture: true })
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true })
      window.removeEventListener("keydown", unlock, { capture: true })
    }
  }, [active, enabled, resume])

  React.useEffect(() => {
    const onVisibilityChange = () => {
      const engine = engineRef.current
      if (!engine || !activeRef.current || !desiredEnabledRef.current) return
      if (document.visibilityState === "visible" && !paused) {
        void resume(engine).then((running) => {
          if (running && mountedRef.current && engineRef.current === engine) {
            setState(engine.ambience ? "elevenlabs" : "loading")
          }
        })
      } else {
        void engine.context.suspend().catch(() => {})
      }
    }
    const onPageHide = () => stopSession()
    const onPageShow = () => {
      if (activeRef.current && desiredEnabledRef.current) void enable({ persist: false })
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("pageshow", onPageShow)
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [enable, paused, resume, stopSession])

  React.useEffect(() => {
    const engine = engineRef.current
    if (!active || !enabled || !engine) return
    if (paused || document.visibilityState !== "visible") {
      void engine.context.suspend().catch(() => {})
      return
    }
    void resume(engine)
  }, [active, enabled, paused, resume])

  React.useEffect(() => {
    if (!active || !enabled || paused || activeCount <= 0) return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        const engine = engineRef.current
        if (engine && document.visibilityState === "visible") playFootsteps(engine)
        schedule()
      }, 8_000 + Math.round(Math.random() * 6_000))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [active, activeCount, enabled, paused])

  return {
    enabled,
    state,
    volume,
    toggle,
    setVolume,
    disable,
    retry: enable,
  }
}
