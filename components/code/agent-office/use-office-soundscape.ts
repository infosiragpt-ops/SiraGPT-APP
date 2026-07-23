"use client"

import * as React from "react"

import apiClient from "@/lib/api"
import type { OfficeTimeOfDay } from "@/lib/agent-office-environment"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

type OfficeSoundId = "coast-day" | "coast-night" | "terrace-steps"
export type OfficeSoundState = "off" | "loading" | "elevenlabs" | "local"

type AudioEngine = {
  context: AudioContext
  master: GainNode
  ambienceGain: GainNode
  actionGain: GainNode
  ambienceSource: AudioBufferSourceNode | null
  fallbackSource: AudioBufferSourceNode | null
  stepBuffer: AudioBuffer | null
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

function createAudioEngine(volume: number): AudioEngine | null {
  const AudioContextConstructor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return null

  const context = new AudioContextConstructor({ latencyHint: "interactive" })
  const master = context.createGain()
  const ambienceGain = context.createGain()
  const actionGain = context.createGain()
  master.gain.value = volume
  ambienceGain.gain.value = 0.68
  actionGain.gain.value = 0.42
  ambienceGain.connect(master)
  actionGain.connect(master)
  master.connect(context.destination)
  return {
    context,
    master,
    ambienceGain,
    actionGain,
    ambienceSource: null,
    fallbackSource: null,
    stepBuffer: null,
  }
}

function stopSource(source: AudioBufferSourceNode | null) {
  if (!source) return
  try {
    source.stop()
  } catch {
    // The source may already have completed.
  }
  source.disconnect()
}

function startLocalCoast(engine: AudioEngine, timeOfDay: OfficeTimeOfDay) {
  stopSource(engine.fallbackSource)
  const { context } = engine
  const seconds = 3
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate)
  const data = buffer.getChannelData(0)
  let smooth = 0
  for (let index = 0; index < data.length; index += 1) {
    smooth = smooth * 0.985 + (Math.random() * 2 - 1) * 0.015
    const wave = Math.sin((index / context.sampleRate) * Math.PI * 0.34)
    data[index] = smooth * (0.48 + Math.max(0, wave) * 0.35)
  }

  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  source.buffer = buffer
  source.loop = true
  filter.type = "lowpass"
  filter.frequency.value = timeOfDay === "day" ? 1050 : 720
  gain.gain.value = timeOfDay === "day" ? 0.15 : 0.1
  source.connect(filter)
  filter.connect(gain)
  gain.connect(engine.ambienceGain)
  source.start()
  engine.fallbackSource = source
}

function playSyntheticFootstep(engine: AudioEngine) {
  const { context } = engine
  const duration = 0.09
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) {
    const envelope = 1 - index / data.length
    data[index] = (Math.random() * 2 - 1) * envelope
  }
  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  source.buffer = buffer
  filter.type = "lowpass"
  filter.frequency.value = 290 + Math.random() * 90
  gain.gain.setValueAtTime(0.0001, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration)
  source.connect(filter)
  filter.connect(gain)
  gain.connect(engine.actionGain)
  source.start()
}

function playFootsteps(engine: AudioEngine) {
  if (!engine.stepBuffer) {
    playSyntheticFootstep(engine)
    return
  }
  const source = engine.context.createBufferSource()
  const gain = engine.context.createGain()
  source.buffer = engine.stepBuffer
  source.playbackRate.value = 0.94 + Math.random() * 0.12
  gain.gain.value = 0.2
  source.connect(gain)
  gain.connect(engine.actionGain)
  source.start()
}

function playKeyboardTick(engine: AudioEngine) {
  const { context } = engine
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = "square"
  oscillator.frequency.value = 1450 + Math.random() * 260
  gain.gain.setValueAtTime(0.025, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.025)
  oscillator.connect(gain)
  gain.connect(engine.actionGain)
  oscillator.start()
  oscillator.stop(context.currentTime + 0.028)
}

export function useOfficeSoundscape({
  timeOfDay,
  paused,
  activeCount,
}: {
  timeOfDay: OfficeTimeOfDay
  paused: boolean
  activeCount: number
}) {
  const engineRef = React.useRef<AudioEngine | null>(null)
  const loadKeyRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  const [enabled, setEnabled] = React.useState(false)
  const [state, setState] = React.useState<OfficeSoundState>("off")
  const [volume, setVolumeState] = React.useState(0.36)

  const ensureEngine = React.useCallback(() => {
    if (!engineRef.current) engineRef.current = createAudioEngine(volume)
    return engineRef.current
  }, [volume])

  const disable = React.useCallback(() => {
    loadKeyRef.current += 1
    const engine = engineRef.current
    if (engine) {
      stopSource(engine.ambienceSource)
      stopSource(engine.fallbackSource)
      engine.ambienceSource = null
      engine.fallbackSource = null
      void engine.context.suspend()
    }
    setEnabled(false)
    setState("off")
  }, [])

  const enable = React.useCallback(() => {
    const engine = ensureEngine()
    if (!engine) {
      setState("local")
      return
    }
    setEnabled(true)
    setState("loading")
    startLocalCoast(engine, timeOfDay)
    void engine.context.resume()
  }, [ensureEngine, timeOfDay])

  const toggle = React.useCallback(() => {
    if (enabled) disable()
    else enable()
  }, [disable, enable, enabled])

  const setVolume = React.useCallback((nextVolume: number) => {
    const bounded = Math.min(1, Math.max(0, nextVolume))
    setVolumeState(bounded)
    const engine = engineRef.current
    if (engine) {
      engine.master.gain.setTargetAtTime(bounded, engine.context.currentTime, 0.03)
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadKeyRef.current += 1
      const engine = engineRef.current
      if (!engine) return
      stopSource(engine.ambienceSource)
      stopSource(engine.fallbackSource)
      void engine.context.close()
      engineRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!enabled) return
    const engine = ensureEngine()
    if (!engine) return
    const loadKey = ++loadKeyRef.current
    setState("loading")
    startLocalCoast(engine, timeOfDay)

    const ambientId: OfficeSoundId = timeOfDay === "day" ? "coast-day" : "coast-night"
    void Promise.all([
      fetchOfficeSound(ambientId),
      fetchOfficeSound("terrace-steps").catch(() => null),
    ]).then(async ([ambientEncoded, stepEncoded]) => {
      if (!mountedRef.current || loadKey !== loadKeyRef.current) return
      const ambientBuffer = await engine.context.decodeAudioData(ambientEncoded.slice(0))
      const stepBuffer = stepEncoded
        ? await engine.context.decodeAudioData(stepEncoded.slice(0)).catch(() => null)
        : null
      if (!mountedRef.current || loadKey !== loadKeyRef.current) return

      stopSource(engine.ambienceSource)
      const source = engine.context.createBufferSource()
      source.buffer = ambientBuffer
      source.loop = true
      source.connect(engine.ambienceGain)
      source.start()
      engine.ambienceSource = source
      engine.stepBuffer = stepBuffer
      stopSource(engine.fallbackSource)
      engine.fallbackSource = null
      setState("elevenlabs")
    }).catch(() => {
      if (mountedRef.current && loadKey === loadKeyRef.current) setState("local")
    })
  }, [enabled, ensureEngine, timeOfDay])

  React.useEffect(() => {
    if (!enabled) return
    const engine = engineRef.current
    if (!engine) return
    if (paused || document.visibilityState !== "visible") {
      void engine.context.suspend()
      return
    }
    void engine.context.resume()
  }, [enabled, paused])

  React.useEffect(() => {
    if (!enabled || paused || activeCount <= 0) return
    const engine = engineRef.current
    if (!engine) return
    const footstepInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") playFootsteps(engine)
    }, 2350)
    const keyboardInterval = window.setInterval(() => {
      if (document.visibilityState === "visible") playKeyboardTick(engine)
    }, 5100)
    return () => {
      window.clearInterval(footstepInterval)
      window.clearInterval(keyboardInterval)
    }
  }, [activeCount, enabled, paused])

  React.useEffect(() => {
    const onVisibilityChange = () => {
      const engine = engineRef.current
      if (!engine || !enabled) return
      if (document.visibilityState === "visible" && !paused) void engine.context.resume()
      else void engine.context.suspend()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [enabled, paused])

  return {
    enabled,
    state,
    volume,
    toggle,
    setVolume,
    disable,
  }
}
