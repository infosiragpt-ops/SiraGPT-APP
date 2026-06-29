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

// Per-voice multi-colour palettes for the animated liquid orbs (ElevenLabs-style).
const ORB_PALETTES: [string, string, string][] = [
  ["#a78bfa", "#f0abfc", "#fb923c"],
  ["#fb7185", "#fda4af", "#93c5fd"],
  ["#86efac", "#5eead4", "#fcd34d"],
  ["#f9a8d4", "#c4b5fd", "#fbcfe8"],
  ["#7dd3fc", "#818cf8", "#f0abfc"],
  ["#fdba74", "#f472b6", "#a78bfa"],
  ["#67e8f9", "#60a5fa", "#f472b6"],
  ["#bef264", "#34d399", "#fbbf24"],
]

function orbPalette(seed: string): [string, string, string] {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return ORB_PALETTES[hash % ORB_PALETTES.length]
}

// Inline grain texture (feTurbulence) for the frosted/liquid finish.
const ORB_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

// Keyframes injected once per modal (global names, shared by every orb).
// prefers-reduced-motion disables the motion entirely.
const ORB_KEYFRAMES = `
@keyframes sira-orb-rotate { to { transform: rotate(360deg); } }
@keyframes sira-orb-a { 0%,100% { transform: translate(-8%,-6%) scale(1.10); } 50% { transform: translate(10%,8%) scale(1.32); } }
@keyframes sira-orb-b { 0%,100% { transform: translate(8%,7%) scale(1.22); } 50% { transform: translate(-10%,-8%) scale(1.04); } }
.sira-orb-rot { animation: sira-orb-rotate 12s linear infinite; }
.sira-orb-blob-a { animation: sira-orb-a 9s ease-in-out infinite; }
.sira-orb-blob-b { animation: sira-orb-b 11s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .sira-orb-rot, .sira-orb-blob-a, .sira-orb-blob-b { animation: none !important; }
}
`

function LiquidOrb({
  seed,
  size = 44,
  hasPreview,
  isPlaying,
  onTogglePreview,
}: {
  seed: string
  size?: number
  hasPreview: boolean
  isPlaying: boolean
  onTogglePreview: (e: React.SyntheticEvent) => void
}) {
  const [c1, c2, c3] = orbPalette(seed)
  return (
    <span
      className="group/orb relative shrink-0 overflow-hidden rounded-2xl shadow-[inset_0_-6px_12px_rgba(0,0,0,0.18),inset_0_2px_5px_rgba(255,255,255,0.35),0_4px_10px_-4px_rgba(0,0,0,0.25)]"
      style={{ width: size, height: size }}
    >
      {/* spinning conic base, blurred for the liquid blend */}
      <span
        className="sira-orb-rot absolute"
        style={{ inset: "-55%", background: `conic-gradient(from 0deg, ${c1}, ${c2}, ${c3}, ${c1})`, filter: "blur(6px)" }}
      />
      {/* drifting colour blobs */}
      <span
        className="sira-orb-blob-a absolute inset-0"
        style={{ background: `radial-gradient(60% 60% at 32% 30%, ${c2}, transparent 70%)`, mixBlendMode: "screen" }}
      />
      <span
        className="sira-orb-blob-b absolute inset-0"
        style={{ background: `radial-gradient(55% 55% at 70% 72%, ${c3}, transparent 70%)`, mixBlendMode: "screen" }}
      />
      {/* grain */}
      <span className="absolute inset-0 opacity-[0.22] mix-blend-overlay" style={{ backgroundImage: ORB_NOISE, backgroundSize: "90px 90px" }} />
      {/* top-left sphere sheen */}
      <span className="absolute inset-0" style={{ background: "radial-gradient(42% 38% at 30% 26%, rgba(255,255,255,0.6), transparent 60%)" }} />
      {/* preview play/pause overlay */}
      {hasPreview && (
        <span
          role="button"
          tabIndex={0}
          onClick={onTogglePreview}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onTogglePreview(e)
            }
          }}
          aria-label={isPlaying ? "Pausar muestra" : "Escuchar muestra"}
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-opacity focus:opacity-100 focus:outline-none",
            isPlaying ? "bg-black/15 opacity-100" : "bg-black/0 opacity-0 group-hover/orb:bg-black/20 group-hover/orb:opacity-100"
          )}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/92 text-zinc-900 shadow">
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-px" />}
          </span>
        </span>
      )}
    </span>
  )
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
        <style dangerouslySetInnerHTML={{ __html: ORB_KEYFRAMES }} />
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
                      {/* Animated liquid-gradient orb (ElevenLabs-style) */}
                      <LiquidOrb
                        seed={voice.name}
                        isPlaying={isPlaying}
                        hasPreview={Boolean(voice.previewUrl)}
                        onTogglePreview={(e) => {
                          e.stopPropagation()
                          const item: VoiceItem = { ...voice, previewUrl: previewBaseUrl(voice.previewUrl) }
                          togglePreview(item)
                        }}
                      />

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
