"use client"

import * as React from "react"
import {
  Disc3,
  Search,
  Check,
  Play,
  Pause,
  Globe,
  ChevronDown,
  Sparkles,
  SlidersHorizontal,
  Loader2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useVoices } from "@/hooks/use-voices"
import { apiClient } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface VoiceCatalogModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedVoiceId: string | null
  onSelectVoice: (voiceId: string, voiceName: string) => void
  // Voice configuration ("y luego las configuraciones") — kept in sync with
  // the composer so the catalog and the composer pill never disagree.
  modelLabel?: string
  language: string
  onLanguageChange: (language: string) => void
  languageOptions: readonly string[]
  accent: string
  onAccentChange: (accent: string) => void
  accentOptions: readonly string[]
  effect: string
  onEffectChange: (effect: string) => void
  effectOptions: readonly string[]
  stability: number
  onStabilityChange: (stability: number) => void
}

interface VoiceItem {
  voiceId: string
  name: string
  category?: string
  description?: string
  previewUrl?: string
  labels?: Record<string, string>
}

const AVATAR_GRADIENTS = [
  "from-violet-500 to-fuchsia-500",
  "from-sky-500 to-indigo-500",
  "from-amber-500 to-rose-500",
  "from-emerald-500 to-teal-500",
  "from-rose-500 to-purple-500",
  "from-cyan-500 to-blue-600",
  "from-orange-500 to-pink-500",
  "from-lime-500 to-emerald-600",
]

function avatarGradient(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]
}

function initials(name: string): string {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?"
}

function titleCase(value: string): string {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function voiceTags(voice: VoiceItem): string[] {
  const labels = voice.labels || {}
  const out: string[] = []
  if (labels.gender) out.push(titleCase(labels.gender))
  if (labels.accent) out.push(titleCase(labels.accent))
  if (labels.use_case) out.push(titleCase(labels.use_case))
  else if (labels.description) out.push(titleCase(labels.description))
  else if (voice.category) out.push(titleCase(voice.category))
  return out.slice(0, 3)
}

/** A small light-theme filter dropdown used in the catalog header. */
function FilterChip({
  icon,
  label,
  value,
  options,
  onChange,
}: {
  icon?: React.ReactNode
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 text-[13px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          {icon}
          <span className="max-w-[120px] truncate">{value && value !== "all" ? value : label}</span>
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
        {options.map((option) => (
          <DropdownMenuItem
            key={option}
            onClick={() => onChange(option)}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>{option === "all" ? label : option}</span>
            {value === option && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function VoiceCatalogModal({
  open,
  onOpenChange,
  selectedVoiceId,
  onSelectVoice,
  modelLabel = "ElevenLabs",
  language,
  onLanguageChange,
  languageOptions,
  accent,
  onAccentChange,
  accentOptions,
  effect,
  onEffectChange,
  effectOptions,
  stability,
  onStabilityChange,
}: VoiceCatalogModalProps) {
  const { voices, loading } = useVoices()
  const [query, setQuery] = React.useState("")
  const [genderFilter, setGenderFilter] = React.useState("all")
  const [categoryFilter, setCategoryFilter] = React.useState("all")
  const [playingId, setPlayingId] = React.useState<string | null>(null)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)

  // Stop any preview when the modal closes.
  React.useEffect(() => {
    if (!open && audioRef.current) {
      audioRef.current.pause()
      setPlayingId(null)
    }
  }, [open])

  const list = React.useMemo<VoiceItem[]>(() => (voices as VoiceItem[]) || [], [voices])

  const genderOptions = React.useMemo(() => {
    const set = new Set<string>()
    list.forEach((v) => v.labels?.gender && set.add(titleCase(v.labels.gender)))
    return ["all", ...Array.from(set).sort()]
  }, [list])

  const categoryOptions = React.useMemo(() => {
    const set = new Set<string>()
    list.forEach((v) => {
      const c = v.labels?.use_case || v.category
      if (c) set.add(titleCase(c))
    })
    return ["all", ...Array.from(set).sort()]
  }, [list])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((v) => {
      if (genderFilter !== "all" && titleCase(v.labels?.gender || "") !== genderFilter) return false
      if (categoryFilter !== "all") {
        const c = titleCase(v.labels?.use_case || v.category || "")
        if (c !== categoryFilter) return false
      }
      if (q) {
        const hay = `${v.name} ${v.description || ""} ${Object.values(v.labels || {}).join(" ")}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [list, query, genderFilter, categoryFilter])

  const togglePreview = (voice: VoiceItem) => {
    if (!voice.previewUrl) return
    if (playingId === voice.voiceId) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = voice.previewUrl
      audioRef.current.currentTime = 0
      audioRef.current.play().catch(() => setPlayingId(null))
      setPlayingId(voice.voiceId)
    }
  }

  const previewBaseUrl = (url?: string) => {
    if (!url) return undefined
    if (url.startsWith("http")) return url
    const root = (apiClient.apiBaseURL || "").replace(/\/$/, "")
    return `${root}${url}`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl gap-0 overflow-hidden rounded-3xl border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl sm:max-w-3xl"
      >
        <audio
          ref={audioRef}
          onEnded={() => setPlayingId(null)}
          className="hidden"
        />
        {/* Header */}
        <DialogHeader className="space-y-0 border-b border-zinc-100 px-6 py-5">
          <div className="flex flex-wrap items-center gap-3">
            <DialogTitle className="flex items-center gap-2 text-xl font-semibold tracking-tight text-zinc-900">
              <Disc3 className="h-5 w-5 text-violet-600" />
              Voice Catalog
            </DialogTitle>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-500">
              {modelLabel}
            </span>
            <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
              {!loading && <span>{filtered.length} voces</span>}
            </div>
          </div>
          <DialogDescription className="sr-only">
            Elige una voz del catálogo y ajusta las configuraciones de generación de voz.
          </DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 px-6 py-3">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar voz…"
              className="h-9 w-full rounded-full border border-zinc-200 bg-white pl-9 pr-3 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
            />
          </div>
          <FilterChip
            icon={<Globe className="h-3.5 w-3.5 text-zinc-400" />}
            label="Idioma"
            value={language}
            options={[...languageOptions]}
            onChange={onLanguageChange}
          />
          <FilterChip label="Género" value={genderFilter} options={genderOptions} onChange={setGenderFilter} />
          <FilterChip label="Categoría" value={categoryFilter} options={categoryOptions} onChange={setCategoryFilter} />
        </div>

        {/* Voice list */}
        <div className="max-h-[42vh] min-h-[220px] overflow-y-auto px-3 pb-2">
          {loading ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-zinc-400">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">Cargando voces…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-zinc-400">
              <Sparkles className="h-6 w-6" />
              <span className="text-sm">No hay voces que coincidan con el filtro.</span>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((voice) => {
                const isSelected = selectedVoiceId === voice.voiceId
                const isPlaying = playingId === voice.voiceId
                const tags = voiceTags(voice)
                return (
                  <li key={voice.voiceId}>
                    <button
                      type="button"
                      onClick={() => onSelectVoice(voice.voiceId, voice.name)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-all",
                        isSelected
                          ? "border-violet-300 bg-violet-50/70 ring-1 ring-violet-200"
                          : "border-transparent hover:border-zinc-200 hover:bg-zinc-50"
                      )}
                    >
                      {/* Avatar + preview */}
                      <span
                        className={cn(
                          "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-semibold text-white",
                          avatarGradient(voice.name)
                        )}
                      >
                        {voice.previewUrl ? (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              const item: VoiceItem = { ...voice, previewUrl: previewBaseUrl(voice.previewUrl) }
                              togglePreview(item)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                e.stopPropagation()
                                const item: VoiceItem = { ...voice, previewUrl: previewBaseUrl(voice.previewUrl) }
                                togglePreview(item)
                              }
                            }}
                            className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 opacity-0 transition-opacity group-hover:bg-black/25 group-hover:opacity-100"
                            aria-label={isPlaying ? "Pausar muestra" : "Escuchar muestra"}
                          >
                            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                          </span>
                        ) : null}
                        {!isPlaying && initials(voice.name)}
                        {isPlaying && <Pause className="h-4 w-4" />}
                      </span>

                      {/* Name + description */}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-semibold text-zinc-900">{voice.name}</span>
                        </span>
                        {voice.description && (
                          <span className="mt-0.5 line-clamp-1 block text-[13px] text-zinc-500">
                            {voice.description}
                          </span>
                        )}
                      </span>

                      {/* Tags */}
                      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-600"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>

                      {/* Selected indicator */}
                      <span
                        className={cn(
                          "flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold transition-colors",
                          isSelected ? "bg-violet-600 text-white" : "text-zinc-400 group-hover:text-zinc-600"
                        )}
                      >
                        {isSelected ? (
                          <>
                            <Check className="h-3.5 w-3.5" /> Selected
                          </>
                        ) : (
                          "Usar"
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Configurations ("y luego las configuraciones") */}
        <div className="border-t border-zinc-100 bg-zinc-50/60 px-6 py-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-zinc-700">
            <SlidersHorizontal className="h-4 w-4 text-zinc-400" />
            Configuración de voz
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ConfigSelect label="Idioma" value={language} options={[...languageOptions]} onChange={onLanguageChange} />
            <ConfigSelect label="Acento" value={accent} options={[...accentOptions]} onChange={onAccentChange} />
            <ConfigSelect label="Efecto" value={effect} options={[...effectOptions]} onChange={onEffectChange} />
          </div>
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between text-[13px] text-zinc-600">
              <span>Estabilidad</span>
              <span className="font-semibold text-zinc-800">{stability}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={stability}
              onChange={(e) => onStabilityChange(Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-violet-600"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConfigSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px] font-medium text-zinc-500">
      {label}
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full appearance-none rounded-xl border border-zinc-200 bg-white px-3 pr-8 text-[13px] font-medium text-zinc-800 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
      </div>
    </label>
  )
}
