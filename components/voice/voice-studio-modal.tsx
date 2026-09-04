"use client"

/**
 * Sira Voz — Estudio de voz (VoiceStudio, open source, 100 % local, gratis).
 *
 * One dialog for the four studio features the local engine offers:
 *   Mis voces   → clone a voice from a 3–20 s recording/upload, audition it,
 *                 pick it for the Voz composer mode
 *   Doblar      → dub a video/audio into another language (auto-clones the
 *                 original speakers or uses one of your voices)
 *   Transcribir → speech-to-text with timestamps (+ SRT)
 *   Audiolibro  → chapterized M4B/MP3 from pasted text or .txt/.md/.epub/.pdf
 *   Trabajos    → progress + results of long jobs (they also land in the chat)
 *
 * Everything talks to /api/voice-studio/* through apiClient (Bearer auth).
 */

import * as React from "react"
import {
  AudioLines,
  BookAudio,
  Check,
  Clapperboard,
  Download,
  FileAudio,
  ListChecks,
  Loader2,
  MessageSquareText,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
import { apiClient, type VoiceStudioJob, type VoiceStudioStatus, type VoiceStudioVoice } from "@/lib/api"
import { SIRA_VOZ_LABEL, SIRA_VOZ_TAGLINE } from "@/lib/chat/media-composer-config"
import { cn } from "@/lib/utils"

export type VoiceStudioTab = "voices" | "dub" | "transcribe" | "audiobook" | "jobs"

export interface VoiceStudioChatFile {
  id: string
  name: string
  mimeType: string | null
  size?: number | null
}

export interface VoiceStudioModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: VoiceStudioTab
  selectedVoiceId: string | null
  onSelectVoice: (voice: { id: string; name: string } | null) => void
  language: string
  languageOptions: readonly string[]
  /** Files already attached in this chat (big media goes through the chunked upload). */
  chatFiles?: VoiceStudioChatFile[]
  /** Returns the chat the results should be posted to (creating one if needed). */
  ensureChatId?: () => Promise<string | null>
  onJobFinished?: (job: VoiceStudioJob) => void
  onInsertText?: (text: string) => void
}

const TABS: Array<{ id: VoiceStudioTab; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }> = [
  { id: "voices", label: "Mis voces", icon: Mic, hint: "Clona tu voz en segundos" },
  { id: "dub", label: "Doblar", icon: Clapperboard, hint: "Vídeos y audios a otro idioma" },
  { id: "transcribe", label: "Transcribir", icon: FileAudio, hint: "Texto con tiempos y SRT" },
  { id: "audiobook", label: "Audiolibro", icon: BookAudio, hint: "Libros narrados por capítulos" },
  { id: "jobs", label: "Trabajos", icon: ListChecks, hint: "Progreso y descargas" },
]

const LANGUAGE_LABELS: Record<string, string> = {
  English: "Inglés",
  Spanish: "Español",
  German: "Alemán",
  French: "Francés",
  Portuguese: "Portugués",
  Italian: "Italiano",
  Afrikaans: "Afrikáans",
  Arabic: "Árabe",
  Armenian: "Armenio",
  Assamese: "Asamés",
  Azerbaijani: "Azerí",
  Belarusian: "Bielorruso",
  Bengali: "Bengalí",
  Chinese: "Chino",
  Japanese: "Japonés",
  Korean: "Coreano",
  Russian: "Ruso",
  Dutch: "Neerlandés",
  Polish: "Polaco",
  Turkish: "Turco",
  Hindi: "Hindi",
  Catalan: "Catalán",
  Quechua: "Quechua",
  Auto: "Automático",
}

const DUB_TARGET_LANGUAGES = ["Spanish", "English", "Portuguese", "French", "German", "Italian", "Chinese", "Japanese", "Korean", "Arabic", "Russian", "Dutch", "Polish", "Turkish", "Hindi", "Quechua"] as const

const MAX_RECORD_SECONDS = 20
const MB = 1024 * 1024

/** Media URLs come back as `/api/...` paths; resolve them against the backend root like the artifact players do. */
function resolveMediaUrl(downloadUrl?: string | null): string | null {
  if (!downloadUrl) return null
  if (/^https?:\/\//i.test(downloadUrl)) return downloadUrl
  const root = String(apiClient.apiBaseURL || "").replace(/\/api$/, "")
  return `${root}${downloadUrl}`
}

function languageLabel(name: string): string {
  return LANGUAGE_LABELS[name] || name
}

function formatBytes(bytes?: number | null): string {
  const n = Number(bytes) || 0
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function formatClock(seconds?: number | null): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`
}

function isActiveJob(job: VoiceStudioJob | null | undefined): boolean {
  return Boolean(job && (job.status === "queued" || job.status === "running"))
}

function jobStatusLabel(job: VoiceStudioJob): string {
  switch (job.status) {
    case "queued": return "En cola"
    case "running": return job.stage ? job.stage.charAt(0).toUpperCase() + job.stage.slice(1) : "En proceso"
    case "done": return "Listo"
    case "failed": return "Error"
    case "cancelled": return "Cancelado"
    default: return job.status
  }
}

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { message?: string })?.message
  return typeof message === "string" && message.trim() ? message : fallback
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// ── Shared chrome ─────────────────────────────────────────────────────────

const FIELD_CLASS = "h-10 rounded-xl border-zinc-200 bg-white text-[13px] text-zinc-900 shadow-none focus-visible:ring-zinc-900/15 dark:border-white/12 dark:bg-zinc-900 dark:text-white"
const SELECT_CLASS = cn(FIELD_CLASS, "w-full appearance-none px-3 pr-8 outline-none")
const PRIMARY_BUTTON = "h-10 rounded-full bg-zinc-950 px-4 text-[13px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
const SECONDARY_BUTTON = "h-9 rounded-full border border-zinc-200 bg-white px-3 text-[12.5px] font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:border-white/12 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
const CARD_CLASS = "rounded-2xl border border-zinc-200/90 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-zinc-900/70"

function NativeSelect({ value, onChange, options, className, "aria-label": ariaLabel }: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  className?: string
  "aria-label"?: string
}) {
  return (
    <div className="relative">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(SELECT_CLASS, className)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">▾</span>
    </div>
  )
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle: string }) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold leading-tight text-zinc-950 dark:text-white">{title}</h3>
        <p className="text-[12.5px] text-zinc-500 dark:text-white/60">{subtitle}</p>
      </div>
    </div>
  )
}

function FilePicker({ accept, file, onFile, hint, chatFiles, chatFileId, onChatFile, disabled }: {
  accept: string
  file: File | null
  onFile: (file: File | null) => void
  hint: string
  chatFiles?: VoiceStudioChatFile[]
  chatFileId?: string
  onChatFile?: (id: string) => void
  disabled?: boolean
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  return (
    <div className="space-y-2">
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/70 px-4 py-5 text-center transition-colors dark:border-white/15 dark:bg-white/[0.03]",
          !disabled && "cursor-pointer hover:border-zinc-400 hover:bg-zinc-50 dark:hover:bg-white/[0.05]",
        )}
        role="button"
        tabIndex={0}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !disabled) inputRef.current?.click() }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const dropped = e.dataTransfer.files?.[0]; if (dropped && !disabled) onFile(dropped) }}
      >
        <Upload className="h-5 w-5 text-zinc-500" />
        {file ? (
          <p className="text-[13px] font-medium text-zinc-900 dark:text-white">{file.name} <span className="font-normal text-zinc-500">· {formatBytes(file.size)}</span></p>
        ) : (
          <p className="text-[13px] font-medium text-zinc-900 dark:text-white">Arrastra un archivo o haz clic para elegirlo</p>
        )}
        <p className="text-[11.5px] text-zinc-500 dark:text-white/55">{hint}</p>
        <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0] || null)} />
      </div>
      {chatFiles && chatFiles.length > 0 && onChatFile && (
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-zinc-500 dark:text-white/55">o usa un adjunto del chat</span>
          <div className="min-w-0 flex-1">
            <NativeSelect
              aria-label="Archivo adjunto del chat"
              value={chatFileId || ""}
              onChange={(id) => { onChatFile(id); if (id) onFile(null) }}
              options={[{ value: "", label: "— ninguno —" }, ...chatFiles.map((f) => ({ value: f.id, label: `${f.name}${f.size ? ` · ${formatBytes(f.size)}` : ""}` }))]}
              className="h-9"
            />
          </div>
        </div>
      )}
    </div>
  )
}

function useBlobAudio() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const urlRef = React.useRef<string | null>(null)
  const [playingKey, setPlayingKey] = React.useState<string | null>(null)
  const stop = React.useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setPlayingKey(null)
  }, [])
  const play = React.useCallback((key: string, blob: Blob) => {
    stop()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    urlRef.current = url
    audioRef.current = audio
    audio.onended = () => stop()
    audio.onerror = () => stop()
    setPlayingKey(key)
    void audio.play().catch(() => stop())
  }, [stop])
  React.useEffect(() => stop, [stop])
  return { play, stop, playingKey }
}

// ── Voices ────────────────────────────────────────────────────────────────

function VoicesPanel({ status, voices, loading, selectedVoiceId, onSelectVoice, language, languageOptions, onVoicesChange }: {
  status: VoiceStudioStatus | null
  voices: VoiceStudioVoice[]
  loading: boolean
  selectedVoiceId: string | null
  onSelectVoice: (voice: { id: string; name: string } | null) => void
  language: string
  languageOptions: readonly string[]
  onVoicesChange: () => Promise<void>
}) {
  const { play, stop, playingKey } = useBlobAudio()
  const [name, setName] = React.useState("")
  const [voiceLanguage, setVoiceLanguage] = React.useState(language || "Spanish")
  const [refText, setRefText] = React.useState("")
  const [sample, setSample] = React.useState<{ blob: Blob; filename: string; source: "record" | "upload" } | null>(null)
  const [recording, setRecording] = React.useState(false)
  const [elapsed, setElapsed] = React.useState(0)
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [testText, setTestText] = React.useState("Hola, soy tu nueva voz en SiraGPT. ¿Qué creamos hoy?")
  const [testing, setTesting] = React.useState(false)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const timerRef = React.useRef<number | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const stopRecording = React.useCallback(() => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRecording(false)
  }, [])

  React.useEffect(() => () => { stopRecording() }, [stopRecording])

  const startRecording = async () => {
    try {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        toast.error("Tu navegador no permite grabar. Sube un archivo de audio.")
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m))
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm"
        const blob = new Blob(chunksRef.current, { type })
        const ext = /mp4/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : "webm"
        if (blob.size > 0) setSample({ blob, filename: `grabacion.${ext}`, source: "record" })
      }
      recorderRef.current = recorder
      recorder.start(250)
      setElapsed(0)
      setRecording(true)
      const startedAt = Date.now()
      timerRef.current = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000)
        setElapsed(seconds)
        if (seconds >= MAX_RECORD_SECONDS) stopRecording()
      }, 250)
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo acceder al micrófono"))
      stopRecording()
    }
  }

  const createVoice = async () => {
    if (!name.trim()) { toast.error("Ponle un nombre a la voz"); return }
    if (!sample) { toast.error("Graba o sube una muestra de 3 a 20 segundos"); return }
    setCreating(true)
    try {
      const res = await apiClient.cloneVoiceStudioVoice({ audio: sample.blob, filename: sample.filename, name: name.trim(), language: voiceLanguage, refText: refText.trim() || undefined })
      toast.success(`Voz «${res.voice.name}» creada`)
      setName("")
      setRefText("")
      setSample(null)
      await onVoicesChange()
      onSelectVoice({ id: res.voice.id, name: res.voice.name })
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo crear la voz"))
    } finally {
      setCreating(false)
    }
  }

  const deleteVoice = async (voice: VoiceStudioVoice) => {
    if (!window.confirm(`¿Eliminar la voz «${voice.name}»?`)) return
    setDeleting(voice.id)
    try {
      await apiClient.deleteVoiceStudioVoice(voice.id)
      if (selectedVoiceId === voice.id) onSelectVoice(null)
      await onVoicesChange()
      toast.success("Voz eliminada")
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo eliminar la voz"))
    } finally {
      setDeleting(null)
    }
  }

  const previewVoice = async (voice: VoiceStudioVoice) => {
    if (playingKey === `voice:${voice.id}`) { stop(); return }
    try {
      const blob = await apiClient.fetchVoiceStudioVoicePreview(voice.id)
      play(`voice:${voice.id}`, blob)
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo reproducir la muestra"))
    }
  }

  const testVoice = async () => {
    if (!testText.trim()) return
    if (playingKey === "test") { stop(); return }
    setTesting(true)
    try {
      const blob = await apiClient.previewVoiceStudioSpeech({ text: testText.trim().slice(0, 600), voiceId: selectedVoiceId || null, language: voiceLanguage })
      play("test", blob)
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo generar la prueba"))
    } finally {
      setTesting(false)
    }
  }

  const languageChoices = languageOptions.map((l) => ({ value: l, label: languageLabel(l) }))

  return (
    <div className="space-y-4">
      <SectionTitle icon={Mic} title="Mis voces" subtitle="Clona tu voz con una muestra de 3 a 20 segundos y úsala en Voz, doblajes y audiolibros." />

      <div className={CARD_CLASS}>
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-white/55">Voz activa para Sira Voz</p>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => onSelectVoice(null)}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
              !selectedVoiceId ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950" : "border-zinc-200 hover:bg-zinc-50 dark:border-white/12 dark:hover:bg-white/[0.04]",
            )}
          >
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">Voz predeterminada de Sira</span>
              <span className={cn("block text-[11.5px]", !selectedVoiceId ? "text-white/70 dark:text-zinc-600" : "text-zinc-500 dark:text-white/55")}>Narrador neutro, +600 idiomas</span>
            </span>
            {!selectedVoiceId && <Check className="h-4 w-4 shrink-0" />}
          </button>
          {loading && voices.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando tus voces…</div>
          )}
          {voices.map((voice) => {
            const active = selectedVoiceId === voice.id
            return (
              <div
                key={voice.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-2 py-2 transition-colors",
                  active ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950" : "border-zinc-200 hover:bg-zinc-50 dark:border-white/12 dark:hover:bg-white/[0.04]",
                )}
              >
                <button
                  type="button"
                  onClick={() => void previewVoice(voice)}
                  title="Escuchar la muestra"
                  aria-label={`Escuchar la muestra de ${voice.name}`}
                  className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", active ? "bg-white/15 dark:bg-zinc-950/10" : "bg-zinc-100 dark:bg-white/10")}
                >
                  {playingKey === `voice:${voice.id}` ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-px" />}
                </button>
                <button type="button" onClick={() => onSelectVoice({ id: voice.id, name: voice.name })} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-semibold">{voice.name}</span>
                  <span className={cn("block text-[11.5px]", active ? "text-white/70 dark:text-zinc-600" : "text-zinc-500 dark:text-white/55")}>{languageLabel(voice.language)} · voz clonada</span>
                </button>
                {active && <Check className="h-4 w-4 shrink-0" />}
                <button
                  type="button"
                  onClick={() => void deleteVoice(voice)}
                  disabled={deleting === voice.id}
                  title="Eliminar voz"
                  aria-label={`Eliminar la voz ${voice.name}`}
                  className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", active ? "hover:bg-white/15 dark:hover:bg-zinc-950/10" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-white/10")}
                >
                  {deleting === voice.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={testText} onChange={(e) => setTestText(e.target.value)} maxLength={600} placeholder="Escribe algo para escuchar la voz activa" className={cn(FIELD_CLASS, "flex-1")} />
          <Button type="button" onClick={() => void testVoice()} disabled={testing || !status?.ok} className={PRIMARY_BUTTON}>
            {testing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : playingKey === "test" ? <Pause className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
            {playingKey === "test" ? "Detener" : "Probar voz"}
          </Button>
        </div>
      </div>

      <div className={CARD_CLASS}>
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-white/55">Clonar una voz nueva</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Nombre</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Mi voz, Narrador, Abuela…" className={FIELD_CLASS} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Idioma de la muestra</Label>
            <NativeSelect aria-label="Idioma de la muestra" value={voiceLanguage} onChange={setVoiceLanguage} options={languageChoices} />
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => (recording ? stopRecording() : void startRecording())}
            disabled={creating}
            className={cn(
              "flex items-center justify-center gap-2 rounded-2xl border px-4 py-4 text-[13px] font-semibold transition-colors",
              recording ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950" : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-white/12 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800",
            )}
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            {recording ? `Grabando… ${elapsed}s / ${MAX_RECORD_SECONDS}s · Detener` : "Grabar con el micrófono"}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={creating || recording}
            className="flex items-center justify-center gap-2 rounded-2xl border border-zinc-200 bg-white px-4 py-4 text-[13px] font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-white/12 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
          >
            <Upload className="h-4 w-4" />
            Subir un audio (≤ 25 MB)
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > 25 * MB) { toast.error("La muestra supera los 25 MB"); return }
              setSample({ blob: file, filename: file.name, source: "upload" })
            }}
          />
        </div>
        {sample && (
          <div className="mt-2 flex items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2 text-[12.5px] text-zinc-800 dark:bg-white/[0.06] dark:text-white/85">
            <AudioLines className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{sample.source === "record" ? "Grabación lista" : sample.filename} · {formatBytes(sample.blob.size)}</span>
            <button type="button" onClick={() => (playingKey === "sample" ? stop() : play("sample", sample.blob))} className="text-[12px] font-semibold underline-offset-2 hover:underline">{playingKey === "sample" ? "Detener" : "Escuchar"}</button>
            <button type="button" onClick={() => setSample(null)} className="text-[12px] font-semibold underline-offset-2 hover:underline">Quitar</button>
          </div>
        )}
        <div className="mt-3 space-y-1.5">
          <Label className="text-[12px] text-zinc-700 dark:text-white/75">Texto de la muestra <span className="font-normal text-zinc-500">(opcional, mejora la fidelidad)</span></Label>
          <Textarea value={refText} onChange={(e) => setRefText(e.target.value)} maxLength={1000} rows={2} placeholder="Escribe exactamente lo que dice la grabación" className={cn(FIELD_CLASS, "h-auto min-h-[64px] resize-y")} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-zinc-500 dark:text-white/55">Consejo: habla claro, sin música de fondo, entre 3 y 20 segundos.</p>
          <Button type="button" onClick={() => void createVoice()} disabled={creating || recording || !status?.ok} className={PRIMARY_BUTTON}>
            {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
            Crear voz
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Job progress card (shared by Dub / Audiobook / Jobs) ───────────────────

function JobCard({ job, onCancel, onOpenChat, compact }: { job: VoiceStudioJob; onCancel?: (job: VoiceStudioJob) => void; onOpenChat?: (job: VoiceStudioJob) => void; compact?: boolean }) {
  const [downloading, setDownloading] = React.useState<"file" | "srt" | null>(null)
  const active = isActiveJob(job)
  const result = job.result || null
  const download = async (kind: "file" | "srt") => {
    setDownloading(kind)
    try {
      if (kind === "srt") {
        const blob = await apiClient.downloadVoiceStudioSubtitles(job.id)
        triggerDownload(blob, `${(result?.filename || "doblaje").replace(/\.[a-z0-9]+$/i, "")}.srt`)
      } else {
        const blob = await apiClient.downloadVoiceStudioJob(job.id)
        const name = job.kind === "audiobook"
          ? `${(result?.title || "audiolibro").replace(/[\\/:*?"<>|]+/g, " ").trim()}.${result?.format || "m4b"}`
          : result?.filename || "resultado"
        triggerDownload(blob, name)
      }
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo descargar"))
    } finally {
      setDownloading(null)
    }
  }
  const Icon = job.kind === "audiobook" ? BookAudio : Clapperboard
  const mediaUrl = resolveMediaUrl(result?.downloadUrl)
  const isVideo = String(result?.mime || "").startsWith("video/")
  return (
    <div className={cn(CARD_CLASS, "space-y-3")}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-900 dark:bg-white/10 dark:text-white"><Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-zinc-950 dark:text-white">{job.title || (job.kind === "audiobook" ? "Audiolibro" : "Doblaje")}</p>
          <p className={cn("text-[12px]", job.status === "failed" ? "text-red-600 dark:text-red-300" : "text-zinc-500 dark:text-white/60")}>
            {jobStatusLabel(job)}{active ? ` · ${job.progress}%` : ""}
          </p>
        </div>
        {active && onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onCancel(job)} className={SECONDARY_BUTTON}>Cancelar</Button>
        )}
      </div>
      {active && <Progress value={job.progress} className="h-1.5 bg-zinc-200 dark:bg-white/10 [&>div]:bg-zinc-950 dark:[&>div]:bg-white" />}
      {job.status === "failed" && job.error && (
        <p className="rounded-xl border border-red-200/70 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-400/25 dark:bg-red-500/10 dark:text-red-200">{job.error}</p>
      )}
      {job.status === "done" && result && (
        <div className="space-y-2">
          {!compact && mediaUrl && (
            isVideo
              ? <video controls preload="metadata" src={mediaUrl} className="w-full rounded-xl bg-black" />
              : <audio controls preload="metadata" src={mediaUrl} className="w-full" />
          )}
          <p className="text-[12px] text-zinc-600 dark:text-white/65">
            {result.kind === "audiobook"
              ? `${result.chapters || 0} capítulo${result.chapters === 1 ? "" : "s"}${result.durationSeconds ? ` · ${formatClock(result.durationSeconds)}` : ""} · ${(result.format || "m4b").toUpperCase()} · ${formatBytes(result.sizeBytes)}`
              : `${result.segments || 0} frases dobladas${result.durationSeconds ? ` · ${formatClock(result.durationSeconds)}` : ""} · ${formatBytes(result.sizeBytes)}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => void download("file")} disabled={downloading !== null} className={SECONDARY_BUTTON}>
              {downloading === "file" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}Descargar
            </Button>
            {job.kind === "dub" && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void download("srt")} disabled={downloading !== null} className={SECONDARY_BUTTON}>
                {downloading === "srt" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}Subtítulos .srt
              </Button>
            )}
            {job.chatId && onOpenChat && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChat(job)} className={SECONDARY_BUTTON}>
                <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Ver en el chat
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Dub ───────────────────────────────────────────────────────────────────

function DubPanel({ status, voices, selectedVoiceId, language, chatFiles, ensureChatId, onJobStarted, activeJob }: {
  status: VoiceStudioStatus | null
  voices: VoiceStudioVoice[]
  selectedVoiceId: string | null
  language: string
  chatFiles?: VoiceStudioChatFile[]
  ensureChatId?: () => Promise<string | null>
  onJobStarted: (job: VoiceStudioJob) => void
  activeJob: VoiceStudioJob | null
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [chatFileId, setChatFileId] = React.useState("")
  const [target, setTarget] = React.useState(DUB_TARGET_LANGUAGES.includes(language as (typeof DUB_TARGET_LANGUAGES)[number]) && language !== "Spanish" ? "Spanish" : language === "Spanish" ? "English" : "Spanish")
  const [source, setSource] = React.useState("Auto")
  const [voiceMode, setVoiceMode] = React.useState<"auto" | "mine">(selectedVoiceId ? "mine" : "auto")
  const [voiceId, setVoiceId] = React.useState(selectedVoiceId || "")
  const [keepBackground, setKeepBackground] = React.useState(true)
  const [speakers, setSpeakers] = React.useState("0")
  const [starting, setStarting] = React.useState(false)
  const mediaFiles = React.useMemo(() => (chatFiles || []).filter((f) => /^(video|audio)\//.test(f.mimeType || "") || /\.(mp4|mov|mkv|webm|m4v|mp3|wav|m4a|ogg|opus|flac)$/i.test(f.name)), [chatFiles])
  const directLimit = (status?.limits?.directMediaMb || 95) * MB

  const start = async () => {
    if (!file && !chatFileId) { toast.error("Elige un vídeo o audio para doblar"); return }
    if (file && file.size > directLimit) { toast.error(`Para archivos de más de ${Math.round(directLimit / MB)} MB, adjúntalo primero en el chat y elígelo aquí.`); return }
    setStarting(true)
    try {
      const chatId = ensureChatId ? await ensureChatId() : null
      const res = await apiClient.startVoiceStudioDub({
        media: file || undefined,
        filename: file?.name,
        fileId: file ? undefined : chatFileId,
        targetLanguage: target,
        sourceLanguage: source !== "Auto" ? source : undefined,
        voiceId: voiceMode === "mine" && voiceId ? voiceId : null,
        numSpeakers: Number(speakers) > 0 ? Number(speakers) : null,
        keepBackground,
        chatId,
      })
      toast.success("Doblaje en marcha. Te avisamos cuando esté listo.")
      onJobStarted(res.job)
      setFile(null)
      setChatFileId("")
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo iniciar el doblaje"))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle icon={Clapperboard} title="Doblar vídeo o audio" subtitle="Transcribe, traduce y vuelve a grabar cada frase con la voz original clonada (o con tu voz). Conserva la música y el ambiente." />
      {activeJob && <JobCard job={activeJob} compact />}
      <div className={cn(CARD_CLASS, "space-y-3")}>
        <FilePicker
          accept="video/*,audio/*,.mkv,.mov"
          file={file}
          onFile={(f) => { setFile(f); if (f) setChatFileId("") }}
          hint={`Vídeo o audio hasta ${status?.limits?.directMediaMb || 95} MB en subida directa · más grandes: adjúntalos en el chat`}
          chatFiles={mediaFiles}
          chatFileId={chatFileId}
          onChatFile={setChatFileId}
          disabled={starting}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Doblar al</Label>
            <NativeSelect aria-label="Idioma de destino" value={target} onChange={setTarget} options={DUB_TARGET_LANGUAGES.map((l) => ({ value: l, label: languageLabel(l) }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Idioma original</Label>
            <NativeSelect aria-label="Idioma original" value={source} onChange={setSource} options={[{ value: "Auto", label: "Detectar automáticamente" }, ...DUB_TARGET_LANGUAGES.map((l) => ({ value: l, label: languageLabel(l) }))]} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Voz del doblaje</Label>
            <NativeSelect
              aria-label="Voz del doblaje"
              value={voiceMode === "auto" ? "auto" : voiceId || "auto"}
              onChange={(v) => { if (v === "auto") { setVoiceMode("auto"); setVoiceId("") } else { setVoiceMode("mine"); setVoiceId(v) } }}
              options={[{ value: "auto", label: "Clonar a cada hablante original (recomendado)" }, ...voices.map((v) => ({ value: v.id, label: `Mi voz: ${v.name}` }))]}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Hablantes</Label>
            <NativeSelect aria-label="Número de hablantes" value={speakers} onChange={setSpeakers} options={[{ value: "0", label: "Detectar automáticamente" }, { value: "1", label: "1 hablante" }, { value: "2", label: "2 hablantes" }, { value: "3", label: "3 hablantes" }, { value: "4", label: "4 hablantes" }]} />
          </div>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-2.5 dark:border-white/12">
          <span className="text-[12.5px] text-zinc-800 dark:text-white/85">Conservar música y sonido ambiente</span>
          <Switch checked={keepBackground} onCheckedChange={setKeepBackground} />
        </label>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-zinc-500 dark:text-white/55">Tarda unos minutos por cada minuto de vídeo. El resultado aparece en el chat y en «Trabajos».</p>
          <Button type="button" onClick={() => void start()} disabled={starting || !status?.ok || isActiveJob(activeJob)} className={PRIMARY_BUTTON}>
            {starting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Clapperboard className="mr-1.5 h-4 w-4" />}
            Doblar
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Transcribe ────────────────────────────────────────────────────────────

function TranscribePanel({ status, language, languageOptions, chatFiles, onInsertText }: {
  status: VoiceStudioStatus | null
  language: string
  languageOptions: readonly string[]
  chatFiles?: VoiceStudioChatFile[]
  onInsertText?: (text: string) => void
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [chatFileId, setChatFileId] = React.useState("")
  const [lang, setLang] = React.useState(language || "Auto")
  const [working, setWorking] = React.useState(false)
  const [result, setResult] = React.useState<{ text: string; srt: string; language: string | null; duration: number | null; segments: Array<{ start: number; end: number; text: string }> } | null>(null)
  const [copied, setCopied] = React.useState(false)
  const mediaFiles = React.useMemo(() => (chatFiles || []).filter((f) => /^(video|audio)\//.test(f.mimeType || "") || /\.(mp4|mov|mkv|webm|m4v|mp3|wav|m4a|ogg|opus|flac)$/i.test(f.name)), [chatFiles])
  const directLimit = (status?.limits?.directMediaMb || 95) * MB

  const run = async () => {
    if (!file && !chatFileId) { toast.error("Elige un audio o vídeo para transcribir"); return }
    if (file && file.size > directLimit) { toast.error(`Para archivos de más de ${Math.round(directLimit / MB)} MB, adjúntalo primero en el chat y elígelo aquí.`); return }
    setWorking(true)
    setResult(null)
    try {
      const res = await apiClient.transcribeWithVoiceStudio({ media: file || undefined, filename: file?.name, fileId: file ? undefined : chatFileId, language: lang !== "Auto" ? lang : undefined })
      setResult({ text: res.text, srt: res.srt, language: res.language, duration: res.duration, segments: res.segments || [] })
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo transcribir"))
    } finally {
      setWorking(false)
    }
  }

  const copy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("No se pudo copiar")
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle icon={FileAudio} title="Transcribir" subtitle="Reconocimiento de voz de alta precisión con marcas de tiempo. Descarga el texto o los subtítulos .srt." />
      <div className={cn(CARD_CLASS, "space-y-3")}>
        <FilePicker
          accept="audio/*,video/*,.mkv,.mov"
          file={file}
          onFile={(f) => { setFile(f); if (f) setChatFileId("") }}
          hint={`Audio o vídeo hasta ${status?.limits?.directMediaMb || 95} MB · más grandes: adjúntalos en el chat`}
          chatFiles={mediaFiles}
          chatFileId={chatFileId}
          onChatFile={setChatFileId}
          disabled={working}
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Idioma</Label>
            <NativeSelect aria-label="Idioma del audio" value={lang} onChange={setLang} options={[{ value: "Auto", label: "Detectar automáticamente" }, ...languageOptions.map((l) => ({ value: l, label: languageLabel(l) }))]} />
          </div>
          <Button type="button" onClick={() => void run()} disabled={working || !status?.ok} className={PRIMARY_BUTTON}>
            {working ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileAudio className="mr-1.5 h-4 w-4" />}
            {working ? "Transcribiendo…" : "Transcribir"}
          </Button>
        </div>
      </div>
      {result && (
        <div className={cn(CARD_CLASS, "space-y-3")}>
          <p className="text-[12px] text-zinc-500 dark:text-white/60">
            {result.language ? `Idioma: ${languageLabel(result.language)} · ` : ""}{result.duration ? `${formatClock(result.duration)} · ` : ""}{result.segments.length} segmentos · {result.text.length.toLocaleString("es")} caracteres
          </p>
          <Textarea readOnly value={result.text} rows={8} className={cn(FIELD_CLASS, "h-auto min-h-[160px] resize-y font-normal leading-relaxed")} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className={SECONDARY_BUTTON}>{copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : null}{copied ? "Copiado" : "Copiar texto"}</Button>
            {onInsertText && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onInsertText(result.text)} className={SECONDARY_BUTTON}><MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Insertar en el chat</Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => triggerDownload(new Blob([result.text], { type: "text/plain;charset=utf-8" }), "transcripcion.txt")} className={SECONDARY_BUTTON}><Download className="mr-1.5 h-3.5 w-3.5" />.txt</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => triggerDownload(new Blob([result.srt], { type: "text/plain;charset=utf-8" }), "transcripcion.srt")} className={SECONDARY_BUTTON}><Download className="mr-1.5 h-3.5 w-3.5" />.srt</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Audiobook ─────────────────────────────────────────────────────────────

function AudiobookPanel({ status, voices, selectedVoiceId, language, languageOptions, chatFiles, ensureChatId, onJobStarted, activeJob }: {
  status: VoiceStudioStatus | null
  voices: VoiceStudioVoice[]
  selectedVoiceId: string | null
  language: string
  languageOptions: readonly string[]
  chatFiles?: VoiceStudioChatFile[]
  ensureChatId?: () => Promise<string | null>
  onJobStarted: (job: VoiceStudioJob) => void
  activeJob: VoiceStudioJob | null
}) {
  const [mode, setMode] = React.useState<"text" | "file">("text")
  const [text, setText] = React.useState("")
  const [file, setFile] = React.useState<File | null>(null)
  const [chatFileId, setChatFileId] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [author, setAuthor] = React.useState("")
  const [voiceId, setVoiceId] = React.useState(selectedVoiceId || "")
  const [lang, setLang] = React.useState(language || "Spanish")
  const [format, setFormat] = React.useState<"m4b" | "mp3">("m4b")
  const [starting, setStarting] = React.useState(false)
  const bookFiles = React.useMemo(() => (chatFiles || []).filter((f) => /\.(txt|md|markdown|epub|pdf)$/i.test(f.name) || /^(text\/|application\/(pdf|epub))/.test(f.mimeType || "")), [chatFiles])

  const start = async () => {
    if (mode === "text" && text.trim().length < 20) { toast.error("Pega el texto del libro (al menos unas líneas)"); return }
    if (mode === "file" && !file && !chatFileId) { toast.error("Sube un .txt, .md, .epub o .pdf"); return }
    setStarting(true)
    try {
      const chatId = ensureChatId ? await ensureChatId() : null
      const res = await apiClient.startVoiceStudioAudiobook({
        text: mode === "text" ? text : undefined,
        file: mode === "file" && file ? file : undefined,
        filename: file?.name,
        fileId: mode === "file" && !file ? chatFileId : undefined,
        title: title.trim() || undefined,
        author: author.trim() || undefined,
        voiceId: voiceId || null,
        language: lang,
        format,
        chatId,
      })
      toast.success("Audiolibro en marcha. Te avisamos cuando esté listo.")
      onJobStarted(res.job)
      setText("")
      setFile(null)
      setChatFileId("")
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo iniciar el audiolibro"))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle icon={BookAudio} title="Audiolibro" subtitle="Convierte un libro o un texto largo en un audiolibro por capítulos (M4B con marcadores o MP3)." />
      {activeJob && <JobCard job={activeJob} compact />}
      <div className={cn(CARD_CLASS, "space-y-3")}>
        <div className="flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-white/[0.06]">
          {(["text", "file"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn("flex-1 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors", mode === m ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950" : "text-zinc-600 hover:text-zinc-900 dark:text-white/65 dark:hover:text-white")}
            >
              {m === "text" ? "Pegar texto" : "Subir libro"}
            </button>
          ))}
        </div>
        {mode === "text" ? (
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={400000} placeholder={"# Capítulo 1\nHabía una vez…\n\n# Capítulo 2\n…  (los títulos con # separan capítulos; también puedes pegar el texto sin marcas)"} className={cn(FIELD_CLASS, "h-auto min-h-[170px] resize-y leading-relaxed")} />
        ) : (
          <FilePicker
            accept=".txt,.md,.markdown,.epub,.pdf,text/plain,text/markdown,application/epub+zip,application/pdf"
            file={file}
            onFile={(f) => { setFile(f); if (f) setChatFileId("") }}
            hint={`.txt, .md, .epub o .pdf hasta ${status?.limits?.bookFileMb || 64} MB`}
            chatFiles={bookFiles}
            chatFileId={chatFileId}
            onChatFile={setChatFileId}
            disabled={starting}
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Título</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Nombre del audiolibro" className={FIELD_CLASS} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Autor <span className="font-normal text-zinc-500">(opcional)</span></Label>
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={160} placeholder="Autor o narrador" className={FIELD_CLASS} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Voz</Label>
            <NativeSelect aria-label="Voz del audiolibro" value={voiceId} onChange={setVoiceId} options={[{ value: "", label: "Voz predeterminada de Sira" }, ...voices.map((v) => ({ value: v.id, label: `Mi voz: ${v.name}` }))]} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px] text-zinc-700 dark:text-white/75">Idioma</Label>
            <NativeSelect aria-label="Idioma del audiolibro" value={lang} onChange={setLang} options={languageOptions.map((l) => ({ value: l, label: languageLabel(l) }))} />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-white/[0.06]">
            {(["m4b", "mp3"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFormat(f)} className={cn("rounded-full px-3 py-1.5 text-[12px] font-semibold uppercase transition-colors", format === f ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950" : "text-zinc-600 hover:text-zinc-900 dark:text-white/65 dark:hover:text-white")}>{f}</button>
            ))}
            <span className="self-center px-2 text-[11.5px] text-zinc-500 dark:text-white/55">{format === "m4b" ? "capítulos navegables (Apple Books, Audible)" : "compatible con todo"}</span>
          </div>
          <Button type="button" onClick={() => void start()} disabled={starting || !status?.ok || isActiveJob(activeJob)} className={PRIMARY_BUTTON}>
            {starting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <BookAudio className="mr-1.5 h-4 w-4" />}
            Crear audiolibro
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Jobs ──────────────────────────────────────────────────────────────────

function JobsPanel({ jobs, loading, onRefresh, onCancel, onOpenChat }: { jobs: VoiceStudioJob[]; loading: boolean; onRefresh: () => void; onCancel: (job: VoiceStudioJob) => void; onOpenChat: (job: VoiceStudioJob) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <SectionTitle icon={ListChecks} title="Trabajos" subtitle="Doblajes y audiolibros en curso o terminados. Los resultados también quedan en el chat." />
        <Button type="button" variant="ghost" size="sm" onClick={onRefresh} className={SECONDARY_BUTTON}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Actualizar</Button>
      </div>
      {jobs.length === 0 ? (
        <div className={cn(CARD_CLASS, "text-center text-[13px] text-zinc-500 dark:text-white/60")}>Todavía no has lanzado ningún trabajo.</div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => <JobCard key={job.id} job={job} onCancel={onCancel} onOpenChat={onOpenChat} />)}
        </div>
      )}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────

export default function VoiceStudioModal({
  open,
  onOpenChange,
  initialTab = "voices",
  selectedVoiceId,
  onSelectVoice,
  language,
  languageOptions,
  chatFiles,
  ensureChatId,
  onJobFinished,
  onInsertText,
}: VoiceStudioModalProps) {
  const [tab, setTab] = React.useState<VoiceStudioTab>(initialTab)
  const [status, setStatus] = React.useState<VoiceStudioStatus | null>(null)
  const [voices, setVoices] = React.useState<VoiceStudioVoice[]>([])
  const [voicesLoading, setVoicesLoading] = React.useState(false)
  const [jobs, setJobs] = React.useState<VoiceStudioJob[]>([])
  const [jobsLoading, setJobsLoading] = React.useState(false)
  const finishedRef = React.useRef<Set<string>>(new Set())
  const knownActiveRef = React.useRef<Set<string>>(new Set())

  React.useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  const loadStatus = React.useCallback(async () => {
    try {
      setStatus(await apiClient.getVoiceStudioStatus())
    } catch {
      setStatus({ configured: false, ok: false, status: "unreachable" })
    }
  }, [])

  const loadVoices = React.useCallback(async () => {
    setVoicesLoading(true)
    try {
      const res = await apiClient.listVoiceStudioVoices()
      setVoices(Array.isArray(res?.voices) ? res.voices : [])
    } catch {
      /* keep the previous list */
    } finally {
      setVoicesLoading(false)
    }
  }, [])

  const loadJobs = React.useCallback(async () => {
    setJobsLoading(true)
    try {
      const res = await apiClient.listVoiceStudioJobs()
      const list = Array.isArray(res?.jobs) ? res.jobs : []
      setJobs(list)
      for (const job of list) {
        if (isActiveJob(job)) {
          knownActiveRef.current.add(job.id)
        } else if (knownActiveRef.current.has(job.id) && !finishedRef.current.has(job.id)) {
          finishedRef.current.add(job.id)
          knownActiveRef.current.delete(job.id)
          if (job.status === "done") toast.success(job.kind === "audiobook" ? "Tu audiolibro está listo" : "Tu doblaje está listo")
          else if (job.status === "failed") toast.error(job.error || "El trabajo falló")
          onJobFinished?.(job)
        }
      }
    } catch {
      /* keep the previous list */
    } finally {
      setJobsLoading(false)
    }
  }, [onJobFinished])

  React.useEffect(() => {
    if (!open) return
    void loadStatus()
    void loadVoices()
    void loadJobs()
  }, [open, loadStatus, loadVoices, loadJobs])

  const hasActive = jobs.some(isActiveJob)
  React.useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(() => { void loadJobs() }, 4000)
    return () => window.clearInterval(timer)
  }, [hasActive, loadJobs])

  const handleJobStarted = React.useCallback((job: VoiceStudioJob) => {
    knownActiveRef.current.add(job.id)
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)])
    window.setTimeout(() => { void loadJobs() }, 1500)
  }, [loadJobs])

  const cancelJob = React.useCallback(async (job: VoiceStudioJob) => {
    try {
      await apiClient.cancelVoiceStudioJob(job.id)
      await loadJobs()
    } catch (err) {
      toast.error(errorMessage(err, "No se pudo cancelar"))
    }
  }, [loadJobs])

  const openChat = React.useCallback((job: VoiceStudioJob) => {
    onJobFinished?.(job)
    onOpenChange(false)
  }, [onJobFinished, onOpenChange])

  const activeDub = jobs.find((j) => j.kind === "dub" && isActiveJob(j)) || null
  const activeAudiobook = jobs.find((j) => j.kind === "audiobook" && isActiveJob(j)) || null
  const ready = Boolean(status?.ok)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] w-[min(100vw-1rem,60rem)] max-w-none flex-col gap-0 overflow-hidden rounded-3xl border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl dark:border-white/12 dark:bg-zinc-950 dark:text-white sm:max-w-none">
        <DialogHeader className="border-b border-zinc-200/80 px-5 py-4 text-left dark:border-white/10">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <DialogTitle className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
              <AudioLines className="h-5 w-5" />
              Estudio de voz · {SIRA_VOZ_LABEL}
            </DialogTitle>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", ready ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950" : "bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-white/70")} data-testid="voice-studio-status">
              {status == null ? "Conectando…" : ready ? "Gratis · 100 % local" : status.status === "starting" ? "Arrancando el motor…" : "No disponible"}
            </span>
          </div>
          <DialogDescription className="text-[12.5px] text-zinc-500 dark:text-white/60">{SIRA_VOZ_TAGLINE} Sin registros ni suscripciones. +600 idiomas.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200/80 px-3 py-2 dark:border-white/10 sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:px-3 sm:py-4" aria-label="Secciones del estudio de voz">
            {TABS.map(({ id, label, icon: Icon, hint }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                data-testid={`voice-studio-tab-${id}`}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-semibold transition-colors",
                  tab === id ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950" : "text-zinc-700 hover:bg-zinc-100 dark:text-white/75 dark:hover:bg-white/[0.06]",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block leading-tight">{label}</span>
                  <span className={cn("hidden text-[11px] font-normal leading-tight sm:block", tab === id ? "text-white/70 dark:text-zinc-600" : "text-zinc-500 dark:text-white/50")}>{hint}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            {status && !status.configured && (
              <div className="mb-4 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-[12.5px] text-zinc-700 dark:border-white/12 dark:bg-white/[0.04] dark:text-white/75">
                Sira Voz todavía no está activado en este servidor. Cuando el motor local esté en marcha, aquí podrás clonar voces, doblar vídeos, transcribir y crear audiolibros gratis.
              </div>
            )}
            {status && status.configured && !status.ok && (
              <div className="mb-4 flex items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-[12.5px] text-zinc-700 dark:border-white/12 dark:bg-white/[0.04] dark:text-white/75">
                <Loader2 className="h-4 w-4 animate-spin" />
                {status.status === "starting" ? "El motor de voz está arrancando. Suele tardar uno o dos minutos." : "El motor de voz no responde. Intenta de nuevo en unos segundos."}
                <button type="button" onClick={() => void loadStatus()} className="ml-auto text-[12px] font-semibold underline-offset-2 hover:underline">Reintentar</button>
              </div>
            )}
            {tab === "voices" && (
              <VoicesPanel status={status} voices={voices} loading={voicesLoading} selectedVoiceId={selectedVoiceId} onSelectVoice={onSelectVoice} language={language} languageOptions={languageOptions} onVoicesChange={loadVoices} />
            )}
            {tab === "dub" && (
              <DubPanel status={status} voices={voices} selectedVoiceId={selectedVoiceId} language={language} chatFiles={chatFiles} ensureChatId={ensureChatId} onJobStarted={handleJobStarted} activeJob={activeDub} />
            )}
            {tab === "transcribe" && (
              <TranscribePanel status={status} language={language} languageOptions={languageOptions} chatFiles={chatFiles} onInsertText={onInsertText ? (text) => { onInsertText(text); onOpenChange(false) } : undefined} />
            )}
            {tab === "audiobook" && (
              <AudiobookPanel status={status} voices={voices} selectedVoiceId={selectedVoiceId} language={language} languageOptions={languageOptions} chatFiles={chatFiles} ensureChatId={ensureChatId} onJobStarted={handleJobStarted} activeJob={activeAudiobook} />
            )}
            {tab === "jobs" && (
              <JobsPanel jobs={jobs} loading={jobsLoading} onRefresh={() => void loadJobs()} onCancel={(job) => void cancelJob(job)} onOpenChat={openChat} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
