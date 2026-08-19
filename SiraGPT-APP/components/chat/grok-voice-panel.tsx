"use client"

import * as React from "react"
import { AudioLines, Mic, Square, Volume2, VolumeX, X } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"
import { apiClient, type GrokVoiceAssistantReply, type GrokVoiceSessionSnapshot } from "@/lib/api"

type VoicePanelStatus = "connecting" | "idle" | "listening" | "processing" | "speaking" | "error"

type VoiceMessage = {
  id: string
  role: "user" | "assistant" | "system"
  text: string
  meta?: string
}

function buildMessageId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function statusLabel(status: VoicePanelStatus) {
  if (status === "connecting") return "Conectando"
  if (status === "listening") return "Escuchando"
  if (status === "processing") return "Procesando"
  if (status === "speaking") return "Respondiendo"
  if (status === "error") return "Revisar"
  return "Listo"
}

function preferredRecorderMimeType() {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return ""
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ]
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ""
}

function extensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a"
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  return "webm"
}

function audioBlobFromBase64(base64: string, mimeType: string) {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mimeType || "audio/mpeg" })
}

export function GrokVoicePanel({
  chatId,
  onClose,
}: {
  chatId?: string | null
  onClose: () => void
}) {
  const [, setSession] = React.useState<GrokVoiceSessionSnapshot | null>(null)
  const [status, setStatus] = React.useState<VoicePanelStatus>("connecting")
  const [liveTranscript, setLiveTranscript] = React.useState("")
  const [messages, setMessages] = React.useState<VoiceMessage[]>([])
  const [muted, setMuted] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const statusRef = React.useRef<VoicePanelStatus>("connecting")
  const sessionIdRef = React.useRef<string | null>(null)
  const chatIdRef = React.useRef<string | null>(chatId || null)
  const sessionRef = React.useRef<GrokVoiceSessionSnapshot | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const submitInFlightRef = React.useRef(false)
  const activeAudioRef = React.useRef<HTMLAudioElement | null>(null)
  const activeAudioUrlRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    statusRef.current = status
  }, [status])

  React.useEffect(() => {
    chatIdRef.current = chatId || null
  }, [chatId])

  const appendMessage = React.useCallback((message: Omit<VoiceMessage, "id">) => {
    setMessages((current) => [...current, { id: buildMessageId(message.role), ...message }])
  }, [])

  const ensureSession = React.useCallback(async () => {
    if (sessionIdRef.current && sessionRef.current) return sessionRef.current
    setStatus("connecting")
    const envelope = await apiClient.createGrokVoiceSession({
      chatId: chatIdRef.current,
      mode: "advanced_voice",
    })
    sessionIdRef.current = envelope.session.id
    sessionRef.current = envelope.session
    setSession(envelope.session)
    setStatus("idle")
    return envelope.session
  }, [])

  React.useEffect(() => {
    let cancelled = false
    ensureSession().catch((cause) => {
      if (cancelled) return
      setStatus("error")
      setError(cause instanceof Error ? cause.message : "No se pudo abrir el modo de voz.")
    })
    return () => {
      cancelled = true
    }
  }, [ensureSession])

  const stopAssistantPlayback = React.useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }
    if (activeAudioRef.current) {
      activeAudioRef.current.pause()
      activeAudioRef.current.src = ""
      activeAudioRef.current = null
    }
    if (activeAudioUrlRef.current) {
      URL.revokeObjectURL(activeAudioUrlRef.current)
      activeAudioUrlRef.current = null
    }
  }, [])

  const speakWithBrowserFallback = React.useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setStatus("idle")
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = "es-ES"
    utterance.rate = 1
    utterance.onend = () => setStatus("idle")
    utterance.onerror = () => setStatus("idle")
    setStatus("speaking")
    window.speechSynthesis.speak(utterance)
  }, [])

  const speakAssistant = React.useCallback((assistant: GrokVoiceAssistantReply) => {
    if (muted || typeof window === "undefined") {
      setStatus("idle")
      return
    }

    stopAssistantPlayback()

    if (assistant.audio?.base64) {
      try {
        const blob = audioBlobFromBase64(assistant.audio.base64, assistant.audio.mimeType)
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        activeAudioRef.current = audio
        activeAudioUrlRef.current = url
        audio.onended = () => {
          stopAssistantPlayback()
          setStatus("idle")
        }
        audio.onerror = () => {
          stopAssistantPlayback()
          speakWithBrowserFallback(assistant.text)
        }
        setStatus("speaking")
        void audio.play().catch(() => {
          stopAssistantPlayback()
          speakWithBrowserFallback(assistant.text)
        })
        return
      } catch {
        stopAssistantPlayback()
      }
    }

    speakWithBrowserFallback(assistant.text)
  }, [muted, speakWithBrowserFallback, stopAssistantPlayback])

  const sendTranscript = React.useCallback(async (text: string) => {
    const transcript = text.trim()
    if (!transcript || submitInFlightRef.current) {
      setStatus("idle")
      return
    }

    submitInFlightRef.current = true
    setStatus("processing")
    setError(null)
    appendMessage({ role: "user", text: transcript })

    try {
      const activeSession = await ensureSession()
      const envelope = await apiClient.sendGrokVoiceTurn(activeSession.id, {
        text: transcript,
        chatId: chatIdRef.current,
        source: "stt",
        respond: true,
      })
      sessionRef.current = envelope.session
      setSession(envelope.session)
      const assistant = envelope.assistant
      if (assistant?.text) {
        appendMessage({
          role: "assistant",
          text: assistant.text,
          meta: assistant.audio
            ? `${assistant.model} · voz xAI ${assistant.audio.voice || "eve"}`
            : assistant.ttsErrorCode
              ? `${assistant.model} · TTS no disponible (${assistant.ttsErrorCode})`
              : assistant.model || "Grok",
        })
        speakAssistant(assistant)
      } else {
        setStatus("idle")
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "No se pudo enviar la voz a Grok."
      setStatus("error")
      setError(message)
      appendMessage({ role: "system", text: message })
    } finally {
      submitInFlightRef.current = false
      setLiveTranscript("")
    }
  }, [appendMessage, ensureSession, speakAssistant])

  const releaseMediaStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const startMediaRecorder = React.useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("El navegador no permite acceder al microfono.")
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = preferredRecorderMimeType()
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    streamRef.current = stream
    recorderRef.current = recorder
    chunksRef.current = []

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }

    recorder.onstop = async () => {
      const recordedMimeType = recorder.mimeType || mimeType || "audio/webm"
      releaseMediaStream()
      setStatus("processing")
      try {
        if (chunksRef.current.length === 0) {
          throw new Error("No se capturo audio para transcribir.")
        }
        const audioBlob = new Blob(chunksRef.current, { type: recordedMimeType })
        const extension = extensionForMimeType(recordedMimeType)
        const audioFile = new File([audioBlob], `grok-voice.${extension}`, { type: recordedMimeType })
        const response = await apiClient.transcribeGrokVoice(audioFile, {
          model: "grok-stt",
          language: "es",
        })
        const transcript = response.text || ""
        setLiveTranscript(transcript)
        await sendTranscript(transcript)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "No se pudo transcribir el audio con xAI."
        setStatus("error")
        setError(message)
        appendMessage({ role: "system", text: message })
      } finally {
        chunksRef.current = []
      }
    }

    recorder.start()
    setStatus("listening")
  }, [appendMessage, releaseMediaStream, sendTranscript])

  const startListening = React.useCallback(async () => {
    if (status === "listening" || status === "processing" || status === "connecting") return
    setError(null)
    setLiveTranscript("")

    try {
      await ensureSession()
      stopAssistantPlayback()
      await startMediaRecorder()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "No se pudo iniciar el modo de voz."
      setStatus("error")
      setError(message)
      toast.error(message)
    }
  }, [ensureSession, startMediaRecorder, status, stopAssistantPlayback])

  const stopListening = React.useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") {
      recorder.stop()
      recorderRef.current = null
      setStatus("processing")
    }
  }, [])

  React.useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop()
      }
      releaseMediaStream()
      stopAssistantPlayback()
      const sessionId = sessionIdRef.current
      if (sessionId) void apiClient.stopGrokVoiceSession(sessionId).catch(() => null)
    }
  }, [releaseMediaStream, stopAssistantPlayback])

  const isBusy = status === "connecting" || status === "processing"
  const isListening = status === "listening"
  const canStart = status === "idle" || status === "error"

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-border/40 bg-background">
      <header className="flex items-center justify-between border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">Modo de voz</h2>
            <Badge variant="secondary" className="h-5 rounded-full px-2 text-[11px]">
              Grok 4.3 + xAI voz
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {statusLabel(status)} · STT/TTS por xAI
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={muted ? "Activar voz" : "Silenciar voz"}
            title={muted ? "Activar voz" : "Silenciar voz"}
            className="h-8 w-8 rounded-full"
            onClick={() => {
              setMuted((current) => !current)
              if (!muted) stopAssistantPlayback()
            }}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Cerrar modo de voz"
            title="Cerrar"
            className="h-8 w-8 rounded-full"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          <div className="rounded-md border border-border/50 bg-muted/25 px-3 py-2 text-xs leading-5 text-muted-foreground">
            Mantén presionado para grabar: SiraGPT transcribe con xAI Grok STT, responde con Grok y reproduce audio xAI.
          </div>

          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "rounded-md px-3 py-2 text-sm leading-5",
                message.role === "user" && "ml-5 bg-foreground text-background",
                message.role === "assistant" && "mr-5 border border-border/50 bg-background",
                message.role === "system" && "border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
              )}
            >
              <p>{message.text}</p>
              {message.meta && (
                <p className="mt-1 text-[11px] text-muted-foreground">{message.meta}</p>
              )}
            </div>
          ))}

          {liveTranscript && (
            <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm leading-5 text-muted-foreground">
              {liveTranscript}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
              {error}
            </div>
          )}
        </div>
      </ScrollArea>

      <footer className="border-t border-border/40 p-4">
        <Button
          type="button"
          className="h-11 w-full rounded-full"
          disabled={isBusy}
          onClick={isListening ? stopListening : startListening}
        >
          {isBusy ? (
            <ThinkingIndicator size="sm" className="mr-2" />
          ) : isListening ? (
            <Square className="mr-2 h-4 w-4 fill-current" />
          ) : canStart ? (
            <Mic className="mr-2 h-4 w-4" />
          ) : (
            <AudioLines className="mr-2 h-4 w-4" />
          )}
          {isListening ? "Detener y responder" : status === "speaking" ? "Reproduciendo voz" : "Hablar con Grok"}
        </Button>
      </footer>
    </section>
  )
}
