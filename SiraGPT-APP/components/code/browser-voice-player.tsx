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
import { Loader2, Pause, Play, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api"
import { isSupported as isKokoroSupported, isModelCached as isKokoroCached, loadModel as loadKokoro, synthesize as kokoroSynthesize, isReady as isKokoroReady, KOKORO_VOICE } from "@/lib/voice/local-neural-tts"

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

// Nombres de voces femeninas es-* típicas de macOS/Windows/Google/Edge para
// que el fallback local también suene mujer siempre que el sistema lo permita.
const FEMALE_ES_VOICE_HINTS =
  /m[oó]nica|paulina|helena|sabina|dalia|ximena|catalina|ang[eé]lica|esperanza|luz|andrea|elvira|isabela|camila|luciana|francisca|soledad|marisol|female|mujer/i
// Marcas de calidad del propio sistema: las variantes mejoradas/naturales
// suenan MUCHO mejor que las compactas por defecto.
const QUALITY_VOICE_HINTS = /enhanced|mejorada|premium|natural|neural|siri/i

function pickLocalVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices?.() || []
  const es = voices.filter((v) => /^es(-|_)?/i.test(v.lang))
  const female = es.filter((v) => FEMALE_ES_VOICE_HINTS.test(v.name))
  return (
    // 1) Femenina en su variante de calidad (Enhanced/Natural/Neural).
    female.find((v) => QUALITY_VOICE_HINTS.test(v.name)) ||
    // 2) Femenina servida por el navegador (Google/Edge — no localService):
    //    suele ser neural y muy superior a las voces compactas del SO.
    female.find((v) => v.localService === false) ||
    female[0] ||
    // 3) Sin femenina identificable: cualquier es-* de calidad o de navegador.
    es.find((v) => QUALITY_VOICE_HINTS.test(v.name)) ||
    es.find((v) => v.localService === false) ||
    es.find((v) => /google|microsoft/i.test(v.name)) ||
    es[0] ||
    null
  )
}

/** True when the device has at least one Spanish female voice for the fallback. */
export function hasSpanishFemaleVoice(): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false
  const voices = window.speechSynthesis.getVoices?.() || []
  return voices.some((v) => /^es(-|_)?/i.test(v.lang) && FEMALE_ES_VOICE_HINTS.test(v.name))
}

/**
 * Split a speakable text into short phrases that the synthesizer can utter as
 * separate utterances. Doing one utterance per sentence:
 *   - breaks the monotone cadence of the system voice (natural pauses),
 *   - avoids Chrome's ~15 s cap that silently truncates long utterances,
 *   - lets us vary pitch slightly per phrase for a warmer, less robotic feel.
 *
 * Keeps the split conservative: abbreviations (Dr., S.A., 1.5), decimals and
 * single-word fragments are NOT split. Target ~120 chars/phrase max.
 */
const ABBREV_GUARD = /(?:[A-Z]\.|[A-Z]{2,4}\.)/
function splitIntoPhrases(text: string): string[] {
  const clean = toSpeakable(text)
  if (!clean) return []
  const out: string[] = []
  let buf = ""
  const flush = () => {
    const t = buf.trim()
    if (t) out.push(t)
    buf = ""
  }
  // Walk char-by-char so we can detect sentence boundaries (.!?;:) while
  // skipping abbreviations and decimal numbers.
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]
    buf += ch
    if (/[.!?;:]/.test(ch)) {
      // Lookahead: next non-space char starts a new sentence ONLY when the
      // boundary is real (not an abbreviation like "Dr." or a decimal "1.5").
      const rest = clean.slice(i + 1)
      const nextWord = (rest.match(/^\s*([A-ZÁÉÍÓÚÑ0-9])/)?.[1]) ?? ""
      const looksAbbrev = ABBREV_GUARD.test(clean.slice(Math.max(0, i - 6), i + 1))
      const looksDecimal = /\d\.\d/.test(clean.slice(Math.max(0, i - 2), i + 2))
      if (!looksAbbrev && !looksDecimal && nextWord) {
        // Hard cap a single phrase to keep utterances short for Chrome.
        if (buf.length > 220) {
          // Long phrase — split at the last comma/semicolon if any.
          const lastComma = Math.max(buf.lastIndexOf(","), buf.lastIndexOf(";"))
          if (lastComma > 40) {
            out.push(buf.slice(0, lastComma).trim())
            buf = buf.slice(lastComma + 1)
          }
        }
        flush()
      }
    }
  }
  flush()
  return out.length ? out : [clean]
}

/** Leaning pitch per phrase index — oscillates around 1.08 for warmth. */
function phrasePitch(index: number, total: number, isQuestion: boolean): number {
  if (isQuestion) return 1.14 // questions rise at the end
  const base = 1.08
  const wave = Math.sin((index / Math.max(1, total)) * Math.PI) * 0.03
  return Math.max(1.0, Math.min(1.16, base + wave))
}

/**
 * El sintetizador puebla getVoices() de forma asíncrona (Chrome lo entrega
 * vacío en la primera llamada). Espera una vez a `voiceschanged` (con tope)
 * para no hablar con la voz robótica por defecto.
 */
function waitForVoices(timeoutMs = 600): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if ((synth.getVoices?.() || []).length > 0) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      synth.removeEventListener?.("voiceschanged", finish)
      resolve()
    }
    synth.addEventListener?.("voiceschanged", finish)
    window.setTimeout(finish, timeoutMs)
  })
}

/**
 * El resumen puede traer markdown (negritas, backticks, viñetas, emojis);
 * leído tal cual suena robótico ("asterisco asterisco…"). Se limpia a prosa.
 */
function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // bloques de código fuera
    .replace(/[*_`#>~]+/g, "")
    .replace(/^\s*[-•]\s+/gm, ", ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // enlaces → su texto
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ") // emojis
    .replace(/\s+/g, " ")
    .trim()
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
  const [kokoroAvailable, setKokoroAvailable] = React.useState(isKokoroSupported())
  const [kokoroReady, setKokoroReady] = React.useState(isKokoroCached() && isKokoroReady())
  const [kokoroDownloading, setKokoroDownloading] = React.useState(false)
  const [kokoroProgress, setKokoroProgress] = React.useState(0)

  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const audioSrcRef = React.useRef<string | null>(null)
  const usingLocalRef = React.useRef(false)
  const startedAtRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)
  // Per-play override of stopAll so the phrase queue's pending timeout honors a
  // mid-speech stop without leaving a queued setTimeout that speaks after stop.
  const stopAllRef = React.useRef<() => void>(() => {})

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
    // Clear any pending phrase-queue timeout from playLocal.
    stopAllRef.current = () => {}
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
  // Prosodia por frases: una utterance por oración con micro-pausas y pitch
  // variable → suena menos robótico Y evita el corte de Chrome en >15s.
  const playLocal = React.useCallback(async () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSupported(false)
      return
    }
    try {
      window.speechSynthesis.cancel()
      await waitForVoices()
      const voice = pickLocalVoice()
      // Degradación honesta: si no hay voz femenina española, avisa UNA vez
      // y sugiere "Mejorar voz" (Kokoro local) para no repetir el aviso.
      const hasFemale = voice && FEMALE_ES_VOICE_HINTS.test(voice.name)
      if (!hasFemale && !kokoroReady) {
        try {
          const warnedKey = "siragpt:voice-no-female-es-warned"
          if (!sessionStorage.getItem(warnedKey)) {
            sessionStorage.setItem(warnedKey, "1")
            toast.info("Tu dispositivo no tiene voz femenina en español. Toca el icono ✨ para descargar una voz natural gratuita.", { duration: 6000 })
          }
        } catch { /* private mode */ }
      }
      const phrases = splitIntoPhrases(speakable)
      if (!phrases.length) {
        setState("idle")
        return
      }
      usingLocalRef.current = true
      setProgress(0)
      setElapsedS(0)
      setState("playing")
      startedAtRef.current = Date.now()

      const total = phrases.length
      let idx = 0
      let cancelled = false

      const speakNext = () => {
        if (cancelled) return
        if (idx >= total) {
          setProgress(1)
          setState("idle")
          stopTicker()
          return
        }
        const phrase = phrases[idx]
        const u = new SpeechSynthesisUtterance(phrase)
        u.lang = "es-ES"
        u.voice = voice
        u.rate = 1.03
        u.pitch = phrasePitch(idx, total, /\?\s*$/.test(phrase))
        u.onend = () => {
          if (cancelled) return
          idx += 1
          setProgress(idx / total)
          // Micro-pausa entre frases (150-250ms) para prosodia natural.
          const pause = phrase.endsWith(":") || phrase.endsWith(";") ? 250 : 160
          window.setTimeout(speakNext, pause)
        }
        u.onerror = () => {
          if (cancelled) return
          idx += 1
          window.setTimeout(speakNext, 120)
        }
        window.speechSynthesis.speak(u)
      }
      speakNext()
      if (typeof requestAnimationFrame === "function") rafRef.current = requestAnimationFrame(localTick)

      // Patch stopAll so the cancel flag is honored by the pending timeout.
      const origStop = stopAll
      stopAllRef.current = () => {
        cancelled = true
        origStop()
      }
    } catch {
      setSupported(false)
    }
  }, [localTick, speakable, stopTicker])

  const handlePlay = React.useCallback(async () => {
    // Pausa/reanuda si ya hay reproducción en curso.
    if (state === "playing") {
      if (usingLocalRef.current) {
        stopAllRef.current()
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

    // Primera escucha: escalera Kokoro (local) → ElevenLabs (API) → prosodia local.
    setState("loading")
    try {
      // Tier 1: Kokoro neural local (si ya está descargado). Gratis, calidad alta.
      if (kokoroReady) {
        const blob = await kokoroSynthesize(speakable, KOKORO_VOICE)
        if (blob) {
          const src = URL.createObjectURL(blob)
          audioSrcRef.current = src
          playAudioSrc(src)
          return
        }
      }
      // Tier 2: ElevenLabs (voz femenina multilingüe vía API).
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
      // Tier 3: speechSynthesis con prosodia por frases.
      void playLocal()
    } catch {
      void playLocal()
    }
  }, [playAudioSrc, playLocal, speakable, state, stopAll, kokoroReady])

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

  const handleDownloadKokoro = React.useCallback(async () => {
    if (!kokoroAvailable || kokoroReady || kokoroDownloading) return
    setKokoroDownloading(true)
    setKokoroProgress(0)
    try {
      const ok = await loadKokoro((loaded, total) => {
        setKokoroProgress(total > 0 ? Math.round((loaded / total) * 100) : 0)
      })
      if (ok) setKokoroReady(true)
    } finally {
      setKokoroDownloading(false)
    }
  }, [kokoroAvailable, kokoroReady, kokoroDownloading])

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
      {/* Opt-in neural voice: downloads Kokoro (~80MB) once, then all
          reproductions are local — no API, quality close to ElevenLabs. */}
      {kokoroAvailable && !kokoroReady && (
        <button
          type="button"
          onClick={() => void handleDownloadKokoro()}
          disabled={kokoroDownloading}
          aria-label="Mejorar voz (descarga una vez)"
          title={kokoroDownloading ? `Descargando voz… ${kokoroProgress}%` : "Mejorar voz — descarga una vez (~80MB), gratis para siempre"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-violet-500 hover:bg-violet-50 disabled:opacity-60"
        >
          {kokoroDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      {kokoroReady && (
        <span title="Voz neural local activa" className="shrink-0">
          <Sparkles className="h-3 w-3 text-violet-400" />
        </span>
      )}
    </div>
  )
}
