"use client"

// codex/dictation-button — mic dictation via the Web Speech API (feature 12).
// Degrades cleanly: if SpeechRecognition is unavailable (Firefox, unsupported
// builds) the button does not render and there are no console errors. The
// detector is injectable so the render logic is testable.

import React, { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Mic, MicOff } from "lucide-react"

type SpeechRecognitionCtor = new () => any

export function getSpeechRecognition(win: any = typeof window !== "undefined" ? window : undefined): SpeechRecognitionCtor | null {
  if (!win) return null
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

export interface DictationButtonProps {
  onTranscript: (text: string) => void
  locale?: string
  /** Injectable for tests; defaults to the global detector. */
  recognitionCtor?: SpeechRecognitionCtor | null
}

export function DictationButton({ onTranscript, locale = "es-ES", recognitionCtor }: DictationButtonProps) {
  const t = useTranslations("codex")
  const Ctor = recognitionCtor !== undefined ? recognitionCtor : getSpeechRecognition()
  const [recording, setRecording] = useState(false)
  const recRef = useRef<any>(null)

  useEffect(() => () => { try { recRef.current?.stop() } catch { /* noop */ } }, [])

  // Feature-detection: render nothing where the API is absent (no errors).
  if (!Ctor) return null
  const Recognition = Ctor // narrowed to non-null after the guard above

  const toggle = () => {
    if (recording) { try { recRef.current?.stop() } catch { /* noop */ } return }
    try {
      const rec = new Recognition()
      rec.lang = locale
      rec.interimResults = true
      rec.continuous = false
      rec.onresult = (e: any) => {
        let text = ""
        for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript
        if (text) onTranscript(text)
      }
      rec.onend = () => setRecording(false)
      rec.onerror = () => setRecording(false)
      recRef.current = rec
      rec.start()
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={recording}
      aria-label={recording ? t("composer.stopDictation") : t("composer.dictate")}
      className={`flex h-8 min-h-[44px] w-8 min-w-[44px] items-center justify-center rounded-lg border border-white/10 transition-colors sm:min-h-0 sm:min-w-0 ${recording ? "bg-red-500/20 text-red-300" : "text-zinc-400 hover:bg-white/5"}`}
    >
      {recording ? <MicOff className="h-4 w-4 animate-pulse" /> : <Mic className="h-4 w-4" />}
    </button>
  )
}
