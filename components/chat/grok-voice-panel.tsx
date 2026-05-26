"use client"

import * as React from "react"
import { AudioLines, Loader2, Mic, Square, Volume2, VolumeX, X } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { apiClient, type GrokVoiceAssistantReply, type GrokVoiceSessionSnapshot } from "@/lib/api"

type VoicePanelStatus = "connecting" | "idle" | "listening" | "processing" | "speaking" | "error"

type VoiceMessage = {
  id: string
  role: "user" | "assistant" | "system"
  text: string
  meta?: string
}

type BrowserSpeechRecognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onresult: ((event: {
    resultIndex: number
    results: ArrayLike<{
      isFinal: boolean
      [index: number]: { transcript: string }
    }>
  }) => void) | null
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null
  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return candidate.SpeechRecognition || candidate.webkitSpeechRecognition || null
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

export function GrokVoicePanel({
  chatId,
  onClose,
}: {
  chatId?: string | null
  onClose: () => void
}) {
  const [session, setSession] = React.useState<GrokVoiceSessionSnapshot | null>(null)
  const [status, setStatus] = React.useState<VoicePanelStatus>("connecting")
  const [liveTranscript, setLiveTranscript] = React.useState("")
  const [messages, setMessages] = React.useState<VoiceMessage[]>([])
  const [muted, setMuted] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [speechRecognitionSupported, setSpeechRecognitionSupported] = React.useState(false)

  const statusRef = React.useRef<VoicePanelStatus>("connecting")
  const sessionIdRef = React.useRef<string | null>(null)
  const chatIdRef = React.useRef<string | null>(chatId || null)
  const sessionRef = React.useRef<GrokVoiceSessionSnapshot | null>(null)
  const transcriptRef = React.useRef("")
  const recognitionRef = React.useRef<BrowserSpeechRecognition | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const submitInFlightRef = React.useRef(false)

  React.useEffect(() => {
    statusRef.current = status
  }, [status])

  React.useEffect(() => {
    chatIdRef.current = chatId || null
  }, [chatId])

  React.useEffect(() => {
    setSpeechRecognitionSupported(Boolean(getSpeechRecognitionCtor()))
  }, [])

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

  const speakAssistant = React.useCallback((assistant: GrokVoiceAssistantReply) => {
    if (muted || typeof window === "undefined" || !("speechSynthesis" in window)) {
      setStatus("idle")
      return
    }

    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(assistant.text)
    utterance.lang = "es-ES"
    utterance.rate = 1
    utterance.onend = () => setStatus("idle")
    utterance.onerror = () => setStatus("idle")
    setStatus("speaking")
    window.speechSynthesis.speak(utterance)
  }, [muted])

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
          meta: assistant.model || "Grok",
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
      transcriptRef.current = ""
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
    const recorder = new MediaRecorder(stream)
    streamRef.current = stream
    recorderRef.current = recorder
    chunksRef.current = []

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }

    recorder.onstop = async () => {
      releaseMediaStream()
      setStatus("processing")
      try {
        const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" })
        const audioFile = new File([audioBlob], "grok-voice.webm", { type: "audio/webm" })
        const response = await apiClient.speechToText(audioFile, "scribe_v1") as { text?: string }
        const transcript = response.text || ""
        transcriptRef.current = transcript
        setLiveTranscript(transcript)
        await sendTranscript(transcript)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "No se pudo transcribir el audio."
        setStatus("error")
        setError(message)
        appendMessage({ role: "system", text: message })
      }
    }

    recorder.start()
    setStatus("listening")
  }, [appendMessage, releaseMediaStream, sendTranscript])

  const startListening = React.useCallback(async () => {
    if (status === "listening" || status === "processing" || status === "connecting") return
    setError(null)
    setLiveTranscript("")
    transcriptRef.current = ""

    try {
      await ensureSession()
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel()
      }

      const RecognitionCtor = getSpeechRecognitionCtor()
      if (!RecognitionCtor) {
        await startMediaRecorder()
        return
      }

      const recognition = new RecognitionCtor()
      recognition.lang = "es-ES"
      recognition.continuous = true
      recognition.interimResults = true
      recognition.onstart = () => setStatus("listening")
      recognition.onerror = (event) => {
        setStatus("error")
        setError(event.error ? `Microfono: ${event.error}` : "No se pudo escuchar el microfono.")
      }
      recognition.onend = () => {
        if (statusRef.current === "listening") setStatus("idle")
      }
      recognition.onresult = (event) => {
        let finalText = ""
        let interimText = ""
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          const text = result[0]?.transcript || ""
          if (result.isFinal) finalText += text
          else interimText += text
        }
        const next = `${transcriptRef.current} ${finalText}`.trim()
        if (finalText) transcriptRef.current = next
        setLiveTranscript(`${transcriptRef.current} ${interimText}`.trim())
      }
      recognitionRef.current = recognition
      recognition.start()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "No se pudo iniciar el modo de voz."
      setStatus("error")
      setError(message)
      toast.error(message)
    }
  }, [ensureSession, startMediaRecorder, status])

  const stopListening = React.useCallback(() => {
    if (recognitionRef.current) {
      const recognition = recognitionRef.current
      recognitionRef.current = null
      setStatus("processing")
      try {
        recognition.stop()
      } catch {
        recognition.abort()
      }
      void sendTranscript(transcriptRef.current)
      return
    }

    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") {
      recorder.stop()
      recorderRef.current = null
      setStatus("processing")
    }
  }, [sendTranscript])

  React.useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort()
      } catch {
        /* ignore cleanup failures */
      }
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop()
      }
      releaseMediaStream()
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel()
      }
      const sessionId = sessionIdRef.current
      if (sessionId) void apiClient.stopGrokVoiceSession(sessionId).catch(() => null)
    }
  }, [releaseMediaStream])

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
              Grok 4
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {statusLabel(status)} · chat normal libre
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
              if (!muted && typeof window !== "undefined" && "speechSynthesis" in window) {
                window.speechSynthesis.cancel()
              }
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
            {speechRecognitionSupported
              ? "Habla y suelta para enviar el turno al panel de voz."
              : "Se usara grabacion local y transcripcion cuando el navegador no soporte voz en vivo."}
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
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : isListening ? (
            <Square className="mr-2 h-4 w-4 fill-current" />
          ) : canStart ? (
            <Mic className="mr-2 h-4 w-4" />
          ) : (
            <AudioLines className="mr-2 h-4 w-4" />
          )}
          {isListening ? "Detener y responder" : status === "speaking" ? "Responder en voz" : "Hablar con Grok"}
        </Button>
      </footer>
    </section>
  )
}
