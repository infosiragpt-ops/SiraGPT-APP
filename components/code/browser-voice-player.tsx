"use client"

/**
 * BrowserVoicePlayer — reproductor de voz inline del chat de /code.
 *
 * NUNCA se auto-reproduce: el audio se genera y suena SOLO cuando el usuario
 * pulsa play (así también se evita gastar TTS en respuestas que nadie escucha).
 *
 * Calidad primero: al pulsar play genera el audio con ElevenLabs vía el
 * backend (`/elevenlabs/text-to-speech`) usando una voz femenina cálida y el
 * modelo multilingüe (español nativo) — el mismo enfoque que usa OpenClaw
 * (ElevenLabs + fallback del sistema). Si la petición falla (plan FREE, clave
 * no configurada, red), cae con gracia a `speechSynthesis` del navegador
 * prefiriendo una voz femenina en español, para que el botón siempre funcione.
 *
 * El MP3 generado se cachea en el componente: repetir la escucha no vuelve a
 * llamar a la API. Progreso/duración reales cuando hay MP3; estimados en el
 * fallback local. Degrada a nada si no hay ningún motor de voz disponible.
 */

import * as React from "react"
import { Loader2, Pause, Play } from "lucide-react"

import { apiClient } from "@/lib/api"

// Voz femenina premade de ElevenLabs (cálida, profesional) + modelo
// multilingüe para que hable español con acento natural.
const ELEVEN_FEMALE_VOICE_ID = "21m00Tcm4TlvDq8ikWAM" // Rachel
const ELEVEN_MODEL_ID = "eleven_multilingual_v2"
const ELEVEN_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.35,
  use_speaker_boost: true,
}
// El texto hablado de un turno es corto; este tope protege el presupuesto TTS.
const MAX_TTS_CHARS = 2400

// Nombres de voces femeninas es-* típicas de macOS/Windows/Google para que el
// fallback local también suene mujer siempre que el sistema lo permita.
const FEMALE_ES_VOICE_HINTS = /m[oó]nica|paulina|helena|sabina|elvira|isabela|camila|luciana|francisca|soledad|marisol|female|mujer/i

function pickLocalVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices?.() || []
  const es = voices.filter((v) => /^es(-|_)?/i.test(v.lang))
  return (
    es.find((v) => FEMALE_ES_VOICE_HINTS.test(v.name)) ||
    es.find((v) => /google|microsoft/i.test(v.name)) ||
    es[0] ||
    null
  )
}

type EngineState = "idle" | "loading" | "playing" | "paused"

export function BrowserVoicePlayer({
  text,
}: {
  text: string
  /** @deprecated La voz ya no se auto-reproduce nunca; se ignora. */
  autoPlay?: boolean
  /** @deprecated Sin auto-play no hay evento que consumir; se ignora. */
  onAutoPlayed?: () => void
}) {
  const [supported, setSupported] = React.useState(true)
  const [state, setState] = React.useState<EngineState>("idle")
  const [progress, setProgress] = React.useState(0)
  const [elapsedS, setElapsedS] = React.useState(0)
  const [realDurationS, setRealDurationS] = React.useState<number | null>(null)

  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const audioSrcRef = React.useRef<string | null>(null)
  const usingLocalRef = React.useRef(false)
  const startedAtRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)

  const speakable = React.useMemo(() => text.trim().slice(0, MAX_TTS_CHARS), [text])

  // Duración estimada (solo para el fallback local, que no reporta duración).
  const estMs = React.useMemo(() => {
    const words = (speakable.match(/\S+/g) || []).length
    return Math.max(1200, Math.round((words / 2.7) * 1000))
  }, [speakable])

  const stopTicker = React.useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    startedAtRef.current = null
  }, [])

  const localTick = React.useCallback(() => {
    if (startedAtRef.current == null) return
    const dt = Date.now() - startedAtRef.current
    const p = Math.min(1, dt / estMs)
    setProgress(p)
    setElapsedS(dt / 1000)
    if (p < 1) rafRef.current = requestAnimationFrame(localTick)
  }, [estMs])

  const stopAll = React.useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    }
    const audio = audioRef.current
    if (audio) {
      try {
        audio.pause()
      } catch {
        /* ignore */
      }
    }
    stopTicker()
    setState("idle")
  }, [stopTicker])

  // Reproduce el MP3 (ya cacheado o recién generado) con progreso REAL.
  const playAudioSrc = React.useCallback((src: string) => {
    let audio = audioRef.current
    if (!audio || audio.src !== src) {
      audio = new Audio(src)
      audio.preload = "auto"
      audioRef.current = audio
      audio.ontimeupdate = () => {
        if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return
        setElapsedS(audio.currentTime)
        setProgress(Math.min(1, audio.currentTime / audio.duration))
      }
      audio.onloadedmetadata = () => {
        if (audio && isFinite(audio.duration) && audio.duration > 0) setRealDurationS(audio.duration)
      }
      audio.onended = () => {
        setProgress(1)
        setState("idle")
      }
      audio.onerror = () => setState("idle")
    }
    usingLocalRef.current = false
    setState("playing")
    void audio.play().catch(() => setState("idle"))
  }, [])

  // Fallback 100% local: speechSynthesis con la mejor voz femenina es-*.
  const playLocal = React.useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSupported(false)
      return
    }
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(speakable)
      u.lang = "es-ES"
      u.rate = 1
      const voice = pickLocalVoice()
      if (voice) u.voice = voice
      u.onend = () => {
        setProgress(1)
        setState("idle")
        stopTicker()
      }
      u.onerror = () => {
        setState("idle")
        stopTicker()
      }
      usingLocalRef.current = true
      setProgress(0)
      setElapsedS(0)
      setState("playing")
      startedAtRef.current = Date.now()
      window.speechSynthesis.speak(u)
      if (typeof requestAnimationFrame === "function") rafRef.current = requestAnimationFrame(localTick)
    } catch {
      setSupported(false)
    }
  }, [localTick, speakable, stopTicker])

  const handlePlay = React.useCallback(async () => {
    // Pausa/reanuda si ya hay reproducción en curso.
    if (state === "playing") {
      if (usingLocalRef.current) {
        stopAll()
      } else if (audioRef.current) {
        audioRef.current.pause()
        setState("paused")
      }
      return
    }
    if (state === "paused" && audioRef.current && !usingLocalRef.current) {
      setState("playing")
      void audioRef.current.play().catch(() => setState("idle"))
      return
    }
    if (state === "loading") return

    // MP3 ya generado en este turno → reproducir sin volver a llamar la API.
    if (audioSrcRef.current) {
      playAudioSrc(audioSrcRef.current)
      return
    }

    // Primera escucha: genera con ElevenLabs (voz femenina multilingüe) y,
    // si el backend lo rechaza (FREE / sin clave / error), usa la voz local.
    setState("loading")
    try {
      const response: any = await apiClient.textToSpeech({
        text: speakable,
        voice_id: ELEVEN_FEMALE_VOICE_ID,
        model_id: ELEVEN_MODEL_ID,
        voice_settings: ELEVEN_VOICE_SETTINGS,
      })
      if (response?.audio_url) {
        const src = `${apiClient.apiBaseURL}${response.audio_url}`
        audioSrcRef.current = src
        playAudioSrc(src)
        return
      }
      playLocal()
    } catch {
      playLocal()
    }
  }, [playAudioSrc, playLocal, speakable, state, stopAll])

  React.useEffect(() => {
    // Solo sondea soporte; sin auto-play. El botón queda listo para el clic.
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      // Aun sin speechSynthesis el camino ElevenLabs funciona vía <audio>;
      // solo marcamos sin soporte cuando tampoco existe Audio.
      if (typeof Audio === "undefined") setSupported(false)
    }
    return () => {
      stopAll()
      audioRef.current = null
    }
    // Mount-only a propósito: la limpieza corta audio al desmontar el turno.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!supported) return null

  const totalS = realDurationS ?? estMs / 1000
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
  const shownS = state === "playing" || state === "paused" ? Math.min(elapsedS, totalS) : progress >= 1 ? totalS : 0
  const isBusy = state === "loading"

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
      style={{ maxWidth: 340 }}
      data-testid="browser-voice-player"
    >
      <button
        type="button"
        onClick={() => void handlePlay()}
        disabled={isBusy}
        aria-label={state === "playing" ? "Pausar voz" : "Reproducir voz"}
        title={state === "playing" ? "Pausar" : "Escuchar respuesta"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted disabled:opacity-60"
      >
        {isBusy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : state === "playing" ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
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
