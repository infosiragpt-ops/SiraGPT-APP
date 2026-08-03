"use client"

import * as React from "react"

import apiClient from "@/lib/api"
import type {
  OfficeTimeOfDay,
  OfficeTimePhase,
} from "@/lib/agent-office-environment"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

type OfficeAmbientSoundId = "coast-day" | "coast-night"
type OfficeCueSoundId =
  | "terrace-steps"
  | "work-start"
  | "work-complete"
  | "approval-ready"
  | "attention"
type OfficeSoundId = OfficeAmbientSoundId | OfficeCueSoundId
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

type AmbientMixProfile = {
  ambienceGain: number
  highpassHz: number
  lowpassHz: number
  fadeSeconds: number
}

type AudioEngine = {
  context: AudioContext
  master: GainNode
  compressor: DynamicsCompressorNode
  ambienceBus: GainNode
  ambienceHighpass: BiquadFilterNode
  ambienceLowpass: BiquadFilterNode
  actionBus: GainNode
  ambience: LoopingSource | null
  stepBuffer: AudioBuffer | null
  cueBuffers: Map<OfficeCueSoundId, AudioBuffer>
}

const SOUND_PREFERENCE_KEY = "siragpt:office-sound-enabled"
const SOUND_VOLUME_KEY = "siragpt:office-sound-volume"
const DEFAULT_VOLUME = 0.28
const AMBIENT_MIX_PROFILES: Record<OfficeAmbientSoundId, AmbientMixProfile> = {
  "coast-day": {
    ambienceGain: 0.7,
    highpassHz: 55,
    lowpassHz: 14_500,
    fadeSeconds: 2.6,
  },
  "coast-night": {
    ambienceGain: 0.64,
    highpassHz: 42,
    lowpassHz: 11_000,
    fadeSeconds: 3.2,
  },
}
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
  const compressor = context.createDynamicsCompressor()
  const ambienceBus = context.createGain()
  const ambienceHighpass = context.createBiquadFilter()
  const ambienceLowpass = context.createBiquadFilter()
  const actionBus = context.createGain()
  master.gain.value = volume
  ambienceBus.gain.value = AMBIENT_MIX_PROFILES["coast-day"].ambienceGain
  ambienceHighpass.type = "highpass"
  ambienceHighpass.frequency.value = AMBIENT_MIX_PROFILES["coast-day"].highpassHz
  ambienceHighpass.Q.value = 0.55
  ambienceLowpass.type = "lowpass"
  ambienceLowpass.frequency.value = AMBIENT_MIX_PROFILES["coast-day"].lowpassHz
  ambienceLowpass.Q.value = 0.4
  actionBus.gain.value = 0.42
  compressor.threshold.value = -20
  compressor.knee.value = 24
  compressor.ratio.value = 2.4
  compressor.attack.value = 0.025
  compressor.release.value = 0.32
  ambienceBus.connect(ambienceHighpass)
  ambienceHighpass.connect(ambienceLowpass)
  ambienceLowpass.connect(master)
  actionBus.connect(master)
  master.connect(compressor)
  compressor.connect(context.destination)
  return {
    context,
    master,
    compressor,
    ambienceBus,
    ambienceHighpass,
    ambienceLowpass,
    actionBus,
    ambience: null,
    stepBuffer: null,
    cueBuffers: new Map(),
  }
}

function applyAmbientMix(engine: AudioEngine, soundId: OfficeAmbientSoundId) {
  const profile = AMBIENT_MIX_PROFILES[soundId]
  const now = engine.context.currentTime
  engine.ambienceBus.gain.setTargetAtTime(profile.ambienceGain, now, 0.18)
  engine.ambienceHighpass.frequency.setTargetAtTime(profile.highpassHz, now, 0.22)
  engine.ambienceLowpass.frequency.setTargetAtTime(profile.lowpassHz, now, 0.22)
  return profile
}

function stopLoop(
  loop: LoopingSource | null,
  context: AudioContext,
  {
    immediate = false,
    fadeSeconds = 0.28,
  }: { immediate?: boolean; fadeSeconds?: number } = {},
) {
  if (!loop) return
  const now = context.currentTime
  const stopAt = immediate ? now : now + fadeSeconds
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

function replaceAmbience(
  engine: AudioEngine,
  buffer: AudioBuffer,
  soundId: OfficeAmbientSoundId,
) {
  const { context } = engine
  const now = context.currentTime
  const profile = applyAmbientMix(engine, soundId)
  const source = context.createBufferSource()
  const gain = context.createGain()
  source.buffer = buffer
  source.loop = true
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.linearRampToValueAtTime(1, now + profile.fadeSeconds)
  source.connect(gain)
  gain.connect(engine.ambienceBus)
  source.start()

  const previous = engine.ambience
  engine.ambience = { source, gain }
  stopLoop(previous, context, { fadeSeconds: profile.fadeSeconds })
}

function playActionCue(
  engine: AudioEngine,
  buffer: AudioBuffer,
  gainValue: number,
) {
  if (engine.context.state !== "running") return
  const source = engine.context.createBufferSource()
  const gain = engine.context.createGain()
  source.buffer = buffer
  gain.gain.value = gainValue
  source.connect(gain)
  gain.connect(engine.actionBus)
  source.onended = () => {
    source.disconnect()
    gain.disconnect()
  }
  source.start()
}

function playFootsteps(engine: AudioEngine) {
  if (!engine.stepBuffer || engine.context.state !== "running") return
  const source = engine.context.createBufferSource()
  const gain = engine.context.createGain()
  source.buffer = engine.stepBuffer
  source.playbackRate.value = 0.96 + Math.random() * 0.08
  gain.gain.value = 0.12
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
  timePhase,
  paused,
  activeCount,
  attentionCount = 0,
  approvalCount = 0,
}: {
  active: boolean
  timeOfDay: OfficeTimeOfDay
  timePhase?: OfficeTimePhase
  paused: boolean
  activeCount: number
  attentionCount?: number
  approvalCount?: number
}) {
  const engineRef = React.useRef<AudioEngine | null>(null)
  const loadKeyRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  const activeRef = React.useRef(active)
  const desiredEnabledRef = React.useRef(true)
  const volumeRef = React.useRef(DEFAULT_VOLUME)
  const operationalCountsRef = React.useRef({
    initialized: false,
    activeCount,
    attentionCount,
    approvalCount,
  })
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
      engine.cueBuffers.clear()
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

  const playCue = React.useCallback(
    async (soundId: Exclude<OfficeCueSoundId, "terrace-steps">) => {
      const engine = engineRef.current
      if (
        !engine ||
        engine.context.state === "closed" ||
        paused ||
        document.visibilityState !== "visible"
      ) {
        return
      }

      let buffer = engine.cueBuffers.get(soundId)
      if (!buffer) {
        try {
          const encoded = await fetchOfficeSound(soundId)
          buffer = await engine.context.decodeAudioData(encoded.slice(0))
        } catch {
          return
        }
        if (
          !mountedRef.current ||
          engineRef.current !== engine
        ) {
          return
        }
        engine.cueBuffers.set(soundId, buffer)
      }

      const gainByCue: Record<Exclude<OfficeCueSoundId, "terrace-steps">, number> = {
        "work-start": 0.34,
        "work-complete": 0.32,
        "approval-ready": 0.3,
        attention: 0.28,
      }
      playActionCue(engine, buffer, gainByCue[soundId])
    },
    [paused],
  )

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

    const ambientId: OfficeAmbientSoundId =
      timePhase === "dusk" || timePhase === "night" || timeOfDay === "night"
        ? "coast-night"
        : "coast-day"
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

        replaceAmbience(engine, ambientBuffer, ambientId)
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
  }, [active, enabled, ensureEngine, paused, timeOfDay, timePhase])

  React.useEffect(() => {
    const previous = operationalCountsRef.current
    if (!active) {
      previous.initialized = false
      previous.activeCount = activeCount
      previous.attentionCount = attentionCount
      previous.approvalCount = approvalCount
      return
    }

    if (!previous.initialized) {
      previous.initialized = true
      previous.activeCount = activeCount
      previous.attentionCount = attentionCount
      previous.approvalCount = approvalCount
      return
    }

    let cue: Exclude<OfficeCueSoundId, "terrace-steps"> | null = null
    if (attentionCount > previous.attentionCount) cue = "attention"
    else if (approvalCount > previous.approvalCount) cue = "approval-ready"
    else if (activeCount > previous.activeCount) cue = "work-start"
    else if (activeCount < previous.activeCount) cue = "work-complete"

    previous.activeCount = activeCount
    previous.attentionCount = attentionCount
    previous.approvalCount = approvalCount

    if (cue && enabled && !paused) void playCue(cue)
  }, [
    active,
    activeCount,
    approvalCount,
    attentionCount,
    enabled,
    paused,
    playCue,
  ])

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
