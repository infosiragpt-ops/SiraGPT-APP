"use client"

/**
 * BrowserVoicePlayer — inline voice player powered by the browser's built-in
 * speech synthesis (Web Speech API, `window.speechSynthesis`). It is 100% LOCAL:
 * NO API key, NO server call, NO credit/quota cost — the OS voices do the work.
 *
 * Auto-speaks once on mount (the chat send is a fresh user gesture, so browsers
 * allow speechSynthesis here), with a play/stop control + an estimated progress
 * bar (Web Speech gives no upfront duration, so progress is a smooth estimate).
 * Degrades to nothing when speechSynthesis is unavailable, so the text answer
 * rendered next to it is always the source of truth. Uses inline styles for the
 * dynamic/arbitrary values so it is safe under the curated Tailwind build.
 */

import * as React from "react"
import { Play, StopCircle } from "lucide-react"

export function BrowserVoicePlayer({
  text,
  autoPlay = true,
  onAutoPlayed,
}: {
  text: string
  /** Speak automatically on mount. Pass false for turns rehydrated from
   *  storage so reloading a session doesn't re-voice old messages — the
   *  player still renders and the user can replay manually. */
  autoPlay?: boolean
  /** Fired once when the mount-time auto-play actually starts — lets the
   *  owner consume a "fresh turn" flag so remounts don't re-speak. */
  onAutoPlayed?: () => void
}) {
  const [supported, setSupported] = React.useState(true)
  const [speaking, setSpeaking] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [elapsedS, setElapsedS] = React.useState(0)
  const startedAtRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)
  const autoTriedRef = React.useRef(false)
  // Volatile props read through refs so the mount effect NEVER re-runs on
  // parent re-renders: its cleanup calls the GLOBAL speechSynthesis.cancel(),
  // so an effect churn (autoPlay flipping after consumption, or a new
  // onAutoPlayed closure identity each render) would cut speech mid-sentence.
  const autoPlayRef = React.useRef(autoPlay)
  const onAutoPlayedRef = React.useRef(onAutoPlayed)
  React.useEffect(() => {
    onAutoPlayedRef.current = onAutoPlayed
  })

  const estMs = React.useMemo(() => {
    const words = (text.trim().match(/\S+/g) || []).length
    return Math.max(1200, Math.round((words / 2.7) * 1000))
  }, [text])

  const cancel = React.useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    }
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    startedAtRef.current = null
    setSpeaking(false)
  }, [])

  const tick = React.useCallback(() => {
    if (startedAtRef.current == null) return
    const dt = Date.now() - startedAtRef.current
    const p = Math.min(1, dt / estMs)
    setProgress(p)
    setElapsedS(dt / 1000)
    if (p < 1) rafRef.current = requestAnimationFrame(tick)
  }, [estMs])

  const play = React.useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSupported(false)
      return
    }
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = "es-ES"
      u.rate = 1
      const voices = window.speechSynthesis.getVoices?.() || []
      const es = voices.find((v) => /^es(-|_)/i.test(v.lang)) || voices.find((v) => /^es/i.test(v.lang))
      if (es) u.voice = es
      u.onend = () => {
        setProgress(1)
        setSpeaking(false)
        startedAtRef.current = null
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
      }
      u.onerror = () => {
        setSpeaking(false)
        startedAtRef.current = null
      }
      setProgress(0)
      setElapsedS(0)
      setSpeaking(true)
      startedAtRef.current = Date.now()
      window.speechSynthesis.speak(u)
      if (typeof requestAnimationFrame === "function") rafRef.current = requestAnimationFrame(tick)
    } catch {
      setSupported(false)
    }
  }, [text, tick])

  React.useEffect(() => {
    if (autoTriedRef.current) return
    autoTriedRef.current = true
    if (autoPlayRef.current) {
      onAutoPlayedRef.current?.()
      play()
    } else if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      // Still probe support so an unsupported browser renders nothing.
      setSupported(false)
    }
    return () => cancel()
    // Mount-only on purpose (see refs above): re-running would cancel speech.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!supported) return null

  const totalS = estMs / 1000
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
  const shownS = speaking ? Math.min(elapsedS, totalS) : progress >= 1 ? totalS : 0

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
      style={{ maxWidth: 340 }}
      data-testid="browser-voice-player"
    >
      <button
        type="button"
        onClick={() => (speaking ? cancel() : play())}
        aria-label={speaking ? "Detener voz" : "Reproducir voz"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted"
      >
        {speaking ? <StopCircle className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all duration-100"
          style={{ width: `${Math.round(progress * 100)}%`, backgroundColor: "#C80000" }}
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {fmt(shownS)} / {fmt(totalS)}
      </span>
    </div>
  )
}
