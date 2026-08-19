"use client"

/**
 * use-natural-speech.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Thin React binding over the framework-agnostic NaturalSpeechEngine singleton.
 * Components get reactive `state`/`progress` plus stable `speak/toggle/stop`
 * callbacks, and the hook owns subscription lifecycle + unmount cleanup.
 *
 * Because the engine is a module-level singleton, mounting this hook in many
 * message bubbles still shares ONE audio context: pressing "read aloud" on
 * message B automatically stops message A — exactly the behaviour users expect.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  getNaturalSpeechEngine,
  isSpeechSupported,
  type SpeakOptions,
  type SpeechState,
} from "./natural-speech-engine"

export interface UseNaturalSpeech {
  /** True only while this hook instance owns the active utterance. */
  isSpeaking: boolean
  isPaused: boolean
  /** Engine state for the *currently owning* hook ("idle" when not owner). */
  state: SpeechState
  /** 0..1 reading progress for the owning hook. */
  progress: number
  /** Whether the platform exposes the Web Speech API at all. */
  supported: boolean
  /** Start (or restart) reading `text`. */
  speak: (text: string, options?: SpeakOptions) => void
  /** Play ⇄ pause ⇄ restart toggle bound to this hook's text. */
  toggle: (text: string, options?: SpeakOptions) => void
  /** Hard stop. */
  stop: () => void
}

/**
 * @param ownerId  A stable id (e.g. message id) used so only the bubble that
 *                 actually started playback reflects the speaking state.
 */
export function useNaturalSpeech(ownerId: string): UseNaturalSpeech {
  const [state, setState] = useState<SpeechState>("idle")
  const [progress, setProgress] = useState(0)
  const [isOwner, setIsOwner] = useState(false)
  const supported = isSpeechSupported()

  // Track the most recent owner across all hook instances without re-rendering.
  const ownerRef = useRef(ownerId)
  ownerRef.current = ownerId

  useEffect(() => {
    if (!supported) return
    const engine = getNaturalSpeechEngine()

    const offState = engine.on("state", (next) => {
      // Only the hook that launched the current run reflects live state.
      if (!isOwner) return
      setState(next)
      if (next === "idle" || next === "stopped" || next === "error") {
        setProgress(0)
      }
    })
    const offProgress = engine.on("progress", (p) => {
      if (isOwner) setProgress(p)
    })
    const offEnd = engine.on("end", () => {
      if (isOwner) {
        setState("idle")
        setProgress(0)
        setIsOwner(false)
      }
    })

    return () => {
      offState()
      offProgress()
      offEnd()
    }
  }, [supported, isOwner])

  // Stop audio if THIS bubble unmounts mid-read.
  useEffect(() => {
    return () => {
      if (!supported) return
      const engine = getNaturalSpeechEngine()
      if (isOwner && engine.isActive) engine.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, isOwner])

  const speak = useCallback(
    (text: string, options?: SpeakOptions) => {
      if (!supported) return
      const engine = getNaturalSpeechEngine()
      setIsOwner(true)
      setState("preparing")
      setProgress(0)
      void engine.speak(text, options).catch(() => {
        setState("error")
        setIsOwner(false)
      })
    },
    [supported],
  )

  const toggle = useCallback(
    (text: string, options?: SpeakOptions) => {
      if (!supported) return
      const engine = getNaturalSpeechEngine()
      if (isOwner && (engine.state === "speaking" || engine.state === "paused")) {
        engine.toggle()
        setState(engine.state)
      } else {
        speak(text, options)
      }
    },
    [supported, isOwner, speak],
  )

  const stop = useCallback(() => {
    if (!supported) return
    const engine = getNaturalSpeechEngine()
    engine.cancel()
    setState("idle")
    setProgress(0)
    setIsOwner(false)
  }, [supported])

  return {
    isSpeaking: isOwner && state === "speaking",
    isPaused: isOwner && state === "paused",
    state: isOwner ? state : "idle",
    progress: isOwner ? progress : 0,
    supported,
    speak,
    toggle,
    stop,
  }
}

export default useNaturalSpeech
