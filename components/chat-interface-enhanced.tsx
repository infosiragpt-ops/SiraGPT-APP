"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import {
  Send,
  Paperclip,
  Mic,
  Square,
  FileText,
  Video,
  Globe,
  Bot,
  ChevronDown,
  X,
  Upload,
  Palette,
  Plus,
  Music,
  FileSpreadsheet,
  File as FileIcon,
  ArrowUp,
  Mail,
  Calendar,
  FolderOpen,
  NetworkIcon,
  Network,
  Monitor,
  Share,
  Search,
  BookOpen,
  Download,
  AudioLines,
  RefreshCw,
  Check,
  GripVertical,
  Info,
  Lock,
  Pin,
  Link2,
  MessageCircle,
  Flag,
  Settings,
  PenSquare,
  MessageSquare} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CredentialWarning } from "@/components/credential-warning"
import { ComposerCharCounter } from "@/components/composer-char-counter"
import { Input } from "@/components/ui/input"
import { useChat } from "@/lib/chat-context-integrated"
import { useAuth } from "@/lib/auth-context-integrated"
import { ThemeToggle } from "@/components/theme-toggle"
import WhatsAppButton from "@/components/WhatsAppButton"
import { PremiumCardIcon } from "@/components/icons/premium-card-icon"
import { SidebarOvalIcon } from "@/components/icons/sidebar-oval-icon"
// Visor de documentos: pesado (PDF.js, mammoth, xlsx, etc.). Solo se
// monta cuando el usuario abre un adjunto, así que lo cargamos por
// demanda. SSR desactivado porque el visor depende de APIs del
// navegador. El prefetch se dispara al pasar el ratón por encima de
// los chips que lo abren.
const UnifiedDocumentViewer = dynamic(
  () => import("@/components/viewers/UnifiedDocumentViewer"),
  { ssr: false, loading: () => null },
)
import type { AttachmentLike } from "@/components/viewers/UnifiedDocumentViewer"
// Wrapper perezoso: importa el módulo solo la primera vez que un
// chip pide precalentar. Mantiene la firma sync-fire-and-forget que
// los callers (useEffect en chips) ya usan.
let __unifiedViewerModulePromise: Promise<typeof import("@/components/viewers/UnifiedDocumentViewer")> | null = null
function loadUnifiedViewerModule() {
  if (!__unifiedViewerModulePromise) {
    __unifiedViewerModulePromise = import("@/components/viewers/UnifiedDocumentViewer")
  }
  return __unifiedViewerModulePromise
}
function prewarmUnifiedDocumentPreview(a: AttachmentLike): void {
  if (typeof window === "undefined") return
  void loadUnifiedViewerModule()
    .then(mod => mod.prewarmUnifiedDocumentPreview(a))
    .catch(() => null)
}
import { getAttachmentLocalFile, toDocumentViewerAttachment } from "@/lib/document-viewer-attachment"
import { SlashCommandMenu, detectSlashFilter, parseSlashPrefix } from "@/components/SlashCommandMenu"
import {
  ImageAspectRatioMark,
  SelectedTextDisplay,
  LinkContextDisplay,
} from "@/components/chat/ComposerInlineDisplays"
import { FileProcessingBadge } from "@/components/file-processing-badge"
import {
  extractFilesFromDataTransfer,
  extractFromClipboardEvent,
  validateBatch,
  filesToFileList,
  logIngest,
} from "@/lib/attachment-ingest"
import { Badge } from "@/components/ui/badge"
import { apiClient } from "@/lib/api"
import { track } from "@/lib/analytics"
import { aiService, buildProfessionalCapabilityPrompt, PROFESSIONAL_CAPABILITY_CONTRACTS, shouldRouteTextPromptThroughAgenticRuntime, shouldRouteThroughAgenticRuntime, type ChatIntent } from "@/lib/ai-service"
import { toast } from "sonner"
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import MessageComponent from "./message-component"
import { ErrorBoundary } from "./error-boundary"
import { Virtuoso } from "react-virtuoso"
import SpeechToTextComponent from "./speech-to-text-component"
import TextToSpeechComponent from "./text-to-speech-component"
import MusicGenerationComponent from "./MusicGenerationComponent"
import { agenticSearchService, type AgenticEvent, type AgenticSource } from "@/lib/agentic-search-service"
import { agentTaskService, normalizeAgentTaskErrorMessage, reduceEvent, initialAgentState, type AgentTaskState } from "@/lib/agent-task-service"
import { devLog } from "@/lib/dev-log"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import VideoGenerationComponent from "./VideoGenerationComponent"
import UpgradeModal from "./UpgradeModal"
import KeyboardShortcutsModal from "./KeyboardShortcutsModal"
import { IconProvider } from "./icon-provider"
import GoogleServicesConnectionCard from "./GoogleServicesConnectionCard"
import {
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { useTranslations } from "next-intl"
import { useArtifactPanel } from "@/lib/artifact-panel-context"
import { ArtifactPanel } from "@/components/chat/ArtifactPanel"
import { ChatEmptyStateHero } from "@/components/chat/ChatEmptyStateHero"
import { GrokVoicePanel } from "@/components/chat/grok-voice-panel"
import { DocumentPreview, type DocumentPreviewTarget } from "./document-preview"
import { CodePreview } from "./code-preview"
import SpotifyResults from "./spotify-results"
// Panel "Computer Use": solo aparece cuando el usuario activa esa
// herramienta. Lo bajamos a dynamic para sacarlo del bundle inicial.
const ComputerUseInterface = dynamic(
  () => import("./ComputerUseInterface"),
  { ssr: false, loading: () => null },
)
import ExtractedDataDownload from "./ExtractedDataDownload"
import { useComputerUse } from "@/hooks/use-computer-use"
import { WordConnector } from "./WordConnector"
// Conector de Excel: forwardRef pesado. next/dynamic no propaga refs,
// así que usamos React.lazy + Suspense en el callsite. La carga se
// dispara cuando el usuario activa la herramienta o pasa el ratón
// por el botón del menú (prefetch).
const ExcelConnector = React.lazy(() =>
  import("./ExcelConnector").then(m => ({ default: m.ExcelConnector })),
)
import type { ExcelConnectorRef } from "./ExcelConnector"
let __excelConnectorModulePromise: Promise<typeof import("./ExcelConnector")> | null = null
function prefetchExcelConnector() {
  if (typeof window === "undefined") return
  if (!__excelConnectorModulePromise) {
    __excelConnectorModulePromise = import("./ExcelConnector")
  }
}
import { resolveModelIconName } from "@/lib/model-icons"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

import {
  buildFileOnlyPrompt,
  createLongPasteDocumentFile,
  getLongPasteMetadata,
  shouldCompilePastedTextAsDocument,
} from "@/lib/long-paste"
import { usePasteCapture } from "@/components/paste-preview-overlay"
import { analyzePastedContent, type PasteCaptureResult, type PasteCaptureAction } from "@/lib/paste-capture"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { useVisualViewportCssVars } from "@/hooks/use-visual-viewport-css-vars"

const resolveUploadFileId = (file: any): string | null => {
  if (!file) return null
  if (typeof file === "string") return file
  return file.id || file.fileId || file.attachmentId || null
}

const collectUploadFileIds = (files: any[] = []): string[] =>
  files.map(resolveUploadFileId).filter((id): id is string => Boolean(id))

const attachmentHasPreviewSource = (attachment: AttachmentLike | null | undefined): boolean =>
  Boolean(attachment?.file || attachment?.url || attachment?.extractedText)

const previewAttachmentKey = (attachment: AttachmentLike | null | undefined): string =>
  String(attachment?.id || attachment?.url || attachment?.name || "")

const isComposerFileUploadPending = (file: any): boolean =>
  Boolean(file && file.status === "uploading" && !resolveUploadFileId(file))

const isComposerFileUploadFailed = (file: any): boolean =>
  Boolean(file && file.status === "failed")

const normalizePlanName = (plan?: string | null): string =>
  String(plan || "FREE").trim().toUpperCase()

const isFreePlanName = (plan?: string | null): boolean =>
  normalizePlanName(plan) === "FREE"

const sanitizeLongPasteMetaForMessage = (meta: any) => {
  if (!meta || meta.kind !== "long_paste_document") return null
  return {
    kind: "long_paste_document",
    title: meta.title,
    filename: meta.filename,
    preview: meta.preview,
    originalCharCount: meta.originalCharCount,
    originalWordCount: meta.originalWordCount,
    originalLineCount: meta.originalLineCount,
    createdAt: meta.createdAt,
  }
}

const buildAgentFileMetadata = (files: any[] = []) =>
  files
    .map((file) => {
      const id = resolveUploadFileId(file)
      if (!id) return null
      const longPasteMeta = getLongPasteMetadata(file)
      const safeLongPasteMeta = sanitizeLongPasteMetaForMessage(longPasteMeta)
      const displayName =
        safeLongPasteMeta?.title ||
        file?.longPasteTitle ||
        file?.originalName ||
        file?.name ||
        file?.filename ||
        "archivo"

      return {
        id,
        name: displayName,
        originalName: displayName,
        filename: file?.filename || file?.name || displayName,
        mimeType: file?.mimeType || file?.type || file?.contentType || null,
        type: file?.type || file?.mimeType || file?.contentType || null,
        size: file?.size ?? null,
        url: file?.url || null,
        openaiFileId: file?.openaiFileId || null,
        sourceChannel: file?.sourceChannel || null,
        isLongPasteDocument: Boolean(file?.isLongPasteDocument || safeLongPasteMeta),
        longPasteTitle: safeLongPasteMeta?.title || file?.longPasteTitle || null,
        longPastePreview: safeLongPasteMeta?.preview || file?.longPastePreview || null,
        longPasteMeta: safeLongPasteMeta,
      }
    })
    .filter(Boolean)

type SearchActivityStatus = "running" | "complete" | "error" | "aborted"
type SearchActivityEntryStatus = "running" | "complete" | "warning" | "error"

type SearchActivityEntry = {
  id: string
  title: string
  body?: string
  meta?: string
  at: number
  status: SearchActivityEntryStatus
  sources?: AgenticSource[]
}

type SearchActivityState = {
  messageId: string
  query: string
  target: number
  batchSize: number
  topK: number
  providers: string[]
  startedAt: number
  updatedAt: number
  status: SearchActivityStatus
  totalCollected: number
  dedupedCount?: number
  selectedCount?: number
  elapsedMs?: number
  entries: SearchActivityEntry[]
}

type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"
type ImageGenerationCount = 1 | 2 | 3 | 4 | 5
type ImageQuality = "512px" | "1K" | "2K" | "4K"
type VideoResolution = "480p" | "720p"
type VideoAspectRatio = "auto" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9"
type VideoDuration = 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
type VoiceModel = "ElevenLabs" | "Mimo Max 02HD"
type VoiceLanguage = "English" | "Spanish" | "German" | "French" | "Portuguese" | "Afrikaans" | "Arabic" | "Armenian" | "Assamese" | "Azerbaijani" | "Belarusian" | "Bengali"
type VoiceAccent = "Neutral" | "Latino" | "US" | "British" | "Spanish" | "Mexican"
type VoiceEffect = "None" | "Studio Clean" | "Warm" | "Cinematic" | "Narration" | "Podcast"
type MusicModel = "ElevenLabs" | "Lyria 3 Pro" | "Mimo Max 02HD"
type MusicStyle = "Auto" | "Cinematic" | "Pop" | "Electronic" | "Ambient" | "Orchestral" | "Latin" | "Hip-Hop" | "Jazz"
type MusicMood = "Balanced" | "Energetic" | "Emotional" | "Dark" | "Happy" | "Epic" | "Relaxed"
type MusicEffect = "None" | "Studio Master" | "Spatial" | "Warm Tape" | "Radio Ready" | "Lo-Fi"

const IMAGE_ASPECT_RATIO_OPTIONS: Array<{ value: ImageAspectRatio; label: string; ratio: string; className: string }> = [
  { value: "1:1", label: "Square", ratio: "1:1", className: "h-7 w-7" },
  { value: "2:3", label: "Portrait", ratio: "2:3", className: "h-8 w-[22px]" },
  { value: "3:2", label: "Landscape", ratio: "3:2", className: "h-[22px] w-8" },
  { value: "3:4", label: "Portrait", ratio: "3:4", className: "h-8 w-6" },
  { value: "4:3", label: "Classic", ratio: "4:3", className: "h-6 w-8" },
  { value: "9:16", label: "Story", ratio: "9:16", className: "h-8 w-[18px]" },
  { value: "16:9", label: "Wide", ratio: "16:9", className: "h-[18px] w-9" },
]

const IMAGE_QUALITY_OPTIONS: ImageQuality[] = ["512px", "1K", "2K", "4K"]
const IMAGE_COUNT_OPTIONS: ImageGenerationCount[] = [1, 2, 3, 4, 5]
const VIDEO_RESOLUTION_OPTIONS: VideoResolution[] = ["480p", "720p"]
const VIDEO_ASPECT_RATIO_OPTIONS: Array<{ value: VideoAspectRatio; label: string; ratio: string; className: string; visibleByDefault?: boolean }> = [
  { value: "auto", label: "Auto", ratio: "Auto", className: "h-6 w-6", visibleByDefault: true },
  { value: "16:9", label: "Wide", ratio: "16:9", className: "h-[16px] w-8", visibleByDefault: true },
  { value: "9:16", label: "Story", ratio: "9:16", className: "h-8 w-[16px]", visibleByDefault: true },
  { value: "1:1", label: "Square", ratio: "1:1", className: "h-7 w-7", visibleByDefault: true },
  { value: "4:3", label: "Classic", ratio: "4:3", className: "h-[22px] w-8", visibleByDefault: true },
  { value: "3:4", label: "Portrait", ratio: "3:4", className: "h-8 w-6" },
  { value: "21:9", label: "Cinema", ratio: "21:9", className: "h-[14px] w-9" },
]
const VIDEO_DURATION_OPTIONS: VideoDuration[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const VOICE_MODEL_OPTIONS: VoiceModel[] = ["ElevenLabs", "Mimo Max 02HD"]
const VOICE_LANGUAGE_OPTIONS: VoiceLanguage[] = ["English", "Spanish", "German", "French", "Portuguese", "Afrikaans", "Arabic", "Armenian", "Assamese", "Azerbaijani", "Belarusian", "Bengali"]
const VOICE_ACCENT_OPTIONS: VoiceAccent[] = ["Neutral", "Latino", "US", "British", "Spanish", "Mexican"]
const VOICE_EFFECT_OPTIONS: VoiceEffect[] = ["None", "Studio Clean", "Warm", "Cinematic", "Narration", "Podcast"]
const MUSIC_MODEL_OPTIONS: MusicModel[] = ["ElevenLabs", "Lyria 3 Pro", "Mimo Max 02HD"]
const MUSIC_STYLE_OPTIONS: MusicStyle[] = ["Auto", "Cinematic", "Pop", "Electronic", "Ambient", "Orchestral", "Latin", "Hip-Hop", "Jazz"]
const MUSIC_MOOD_OPTIONS: MusicMood[] = ["Balanced", "Energetic", "Emotional", "Dark", "Happy", "Epic", "Relaxed"]
const MUSIC_EFFECT_OPTIONS: MusicEffect[] = ["None", "Studio Master", "Spatial", "Warm Tape", "Radio Ready", "Lo-Fi"]
const DEFAULT_IMAGE_MODEL = "bytedance-seed/seedream-4.5"
const DEFAULT_IMAGE_PROVIDER = "OpenAI"
const DEFAULT_VIDEO_MODEL = "veo-fast"

const providerForMediaModel = (modelName: string, fallback = DEFAULT_IMAGE_PROVIDER): string => {
  const value = String(modelName || "").toLowerCase()
  if (value.includes("openrouter") || value.includes("seedream")) return "OpenRouter"
  if (value.includes("google") || value.includes("imagen") || value.includes("gemini") || value.includes("veo")) return "Google"
  if (value.includes("kling")) return "Kling"
  if (value.includes("openai") || value.includes("dall") || value.includes("gpt-image")) return "OpenAI"
  return fallback
}

// `ImageAspectRatioMark` was extracted to
// `components/chat/ComposerInlineDisplays.tsx` to keep this file
// scannable. It is imported at the top and used unchanged below.

const SEARCH_ACTIVITY_MAX_ENTRIES = 140
const ACADEMIC_DEFAULT_TOP_K = 10

const SPANISH_SMALL_NUMBERS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  veinte: 20,
}

function inferAcademicSearchCount(query: string) {
  const normalized = (query || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()

  const numeric = normalized.match(/\b(?:dame|busca|encuentra|selecciona|incluye|necesito|quiero)?\s*(\d{1,3})\s+(?:articulos?|fuentes|referencias|papers?|estudios|documentos)\b/)
    || normalized.match(/\b(?:articulos?|fuentes|referencias|papers?|estudios|documentos)\s+(\d{1,3})\b/)
  if (numeric) {
    const count = Number(numeric[1])
    if (Number.isFinite(count)) return Math.min(Math.max(count, 1), 100)
  }

  const words = Object.keys(SPANISH_SMALL_NUMBERS).join("|")
  const wordPattern = new RegExp(`\\b(${words})\\s+(?:articulos?|fuentes|referencias|papers?|estudios|documentos)\\b`, "i")
  const wordMatch = normalized.match(wordPattern)
  if (wordMatch) return SPANISH_SMALL_NUMBERS[wordMatch[1]] || ACADEMIC_DEFAULT_TOP_K

  return ACADEMIC_DEFAULT_TOP_K
}

function targetForAcademicSearch(topK: number) {
  // Keep the search rigorous without collecting 500 records for simple
  // "dame 5 artículos" prompts. Larger requests still get a broad pool.
  return Math.min(500, Math.max(50, topK * 20))
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatActivityDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function sourceHref(source: AgenticSource) {
  if (source.url) return source.url
  if (source.doi) return `https://doi.org/${source.doi.replace(/^https?:\/\/doi\.org\//i, "")}`
  if (source.pdfUrl) return source.pdfUrl
  return null
}

function sourceMeta(source: AgenticSource) {
  const venue = [
    source.journal || source.source || null,
    source.volume ? `${source.volume}${source.issue ? `(${source.issue})` : ""}` : null,
    source.pages || null,
  ].filter(Boolean).join(", ")
  return [
    source.year ? String(source.year) : null,
    venue || null,
    source.doi ? `DOI ${source.doi.replace(/^https?:\/\/doi\.org\//i, "")}` : null,
  ].filter(Boolean).join(" · ")
}

type DetectedLink = {
  raw: string
  url: string
  host: string
}

const URL_TOKEN_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi

function cleanUrlToken(raw: string) {
  return raw.replace(/[)\].,;!?]+$/g, "")
}

function extractDetectedLinks(value: string): DetectedLink[] {
  if (!value) return []
  const seen = new Set<string>()
  const links: DetectedLink[] = []
  for (const match of value.matchAll(URL_TOKEN_RE)) {
    const raw = cleanUrlToken(match[0] || "")
    if (!raw) continue
    const url = raw.startsWith("www.") ? `https://${raw}` : raw
    try {
      const parsed = new URL(url)
      if (!["http:", "https:"].includes(parsed.protocol)) continue
      const normalized = parsed.toString()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      links.push({
        raw,
        url: normalized,
        host: parsed.hostname.replace(/^www\./, ""),
      })
    } catch {
      continue
    }
  }
  return links.slice(0, 8)
}

function appendTextToken(current: string, token: string) {
  const trimmedToken = token.trim()
  if (!trimmedToken) return current
  if (!current.trim()) return trimmedToken
  return `${current.trimEnd()} ${trimmedToken}`
}

function buildSearchActivityEntry(evt: AgenticEvent, index: number, at: number): SearchActivityEntry | null {
  switch (evt.type) {
    case "start":
      return {
        id: `${evt.type}-${at}-${index}`,
        title: "Preparando búsqueda profesional",
        body: `Consulta: ${evt.query}`,
        meta: `Objetivo ${evt.target} · lotes de ${evt.batchSize} · top ${evt.topK} · ${evt.providers.join(", ")}`,
        at,
        status: "running",
      }
    case "batch":
      return {
        id: `${evt.type}-${evt.batchN}-${at}`,
        title: `${evt.provider} · lote ${evt.batchN}`,
        body: `${evt.unique} fuentes nuevas, ${evt.received} recibidas, ${evt.duplicates} duplicadas.`,
        meta: `${evt.totalCollected}/${evt.target} recopiladas`,
        at,
        status: "running",
        sources: evt.sources.slice(0, 3),
      }
    case "batch_error":
      return {
        id: `${evt.type}-${evt.batchN}-${at}`,
        title: `${evt.provider} tuvo un error parcial`,
        body: evt.error,
        meta: `${evt.totalCollected} fuentes conservadas`,
        at,
        status: "warning",
      }
    case "provider_done":
      return {
        id: `${evt.type}-${evt.provider}-${at}`,
        title: `${evt.provider} completado`,
        body: `${evt.contributed} fuentes aportadas.`,
        meta: evt.reason,
        at,
        status: "complete",
      }
    case "collection_done":
      return {
        id: `${evt.type}-${at}`,
        title: "Recopilación completada",
        body: `${evt.totalCollected} fuentes encontradas, ${evt.deduped} únicas.`,
        meta: `${evt.requestedCalls} llamadas · ${formatActivityDuration(evt.elapsedMs)}`,
        at,
        status: "complete",
      }
    case "ranking_start":
      return {
        id: `${evt.type}-${at}`,
        title: "Seleccionando fuentes de mayor calidad",
        body: evt.message,
        meta: `${evt.pool} candidatas · top ${evt.topK}`,
        at,
        status: "running",
      }
    case "rerank_error":
      return {
        id: `${evt.type}-${at}`,
        title: "Reranking parcial",
        body: evt.error,
        meta: "Se continúa con orden heurístico.",
        at,
        status: "warning",
      }
    case "selected":
      return {
        id: `${evt.type}-${at}`,
        title: `Top ${evt.topK} seleccionado`,
        body: evt.rerankerWasUsed ? "Selección refinada con reranker." : "Selección heurística por relevancia y metadatos.",
        meta: `${evt.sources.length} fuentes listas para síntesis`,
        at,
        status: "complete",
        sources: evt.sources.slice(0, 5),
      }
    case "summary":
      return {
        id: `${evt.type}-${at}`,
        title: "Redactando síntesis final",
        body: "El informe ya está entrando al mensaje del chat.",
        at,
        status: "running",
      }
    case "done":
      return {
        id: `${evt.type}-${at}`,
        title: "Búsqueda lista",
        body: `${evt.stats.selectedCount} fuentes seleccionadas de ${evt.stats.dedupedCount} únicas.`,
        meta: evt.stats.elapsedMs ? formatActivityDuration(evt.stats.elapsedMs) : undefined,
        at,
        status: "complete",
      }
    case "saved":
      return {
        id: `${evt.type}-${at}`,
        title: "Resultado guardado en el chat",
        body: "La respuesta final quedó persistida.",
        at,
        status: "complete",
      }
    case "persist_error":
      return {
        id: `${evt.type}-${at}`,
        title: "No se pudo persistir el resultado",
        body: evt.error,
        at,
        status: "warning",
      }
    case "aborted":
      return {
        id: `${evt.type}-${at}`,
        title: "Búsqueda detenida",
        body: evt.reason,
        meta: evt.provider ? `${evt.provider}${evt.round ? ` · ronda ${evt.round}` : ""}` : undefined,
        at,
        status: "warning",
      }
    case "error":
      return {
        id: `${evt.type}-${at}`,
        title: "Error en la búsqueda",
        body: evt.message,
        at,
        status: "error",
      }
    default:
      return null
  }
}

function applySearchActivityEvent(activity: SearchActivityState, evt: AgenticEvent): SearchActivityState {
  const at = Date.now()
  const entry = buildSearchActivityEntry(evt, activity.entries.length, at)
  const entries = entry
    ? [...activity.entries, entry].slice(-SEARCH_ACTIVITY_MAX_ENTRIES)
    : activity.entries
  const next: SearchActivityState = { ...activity, updatedAt: at, entries }

  switch (evt.type) {
    case "start":
      next.query = evt.query
      next.target = evt.target
      next.batchSize = evt.batchSize
      next.topK = evt.topK
      next.providers = evt.providers
      next.status = "running"
      break
    case "batch":
      next.totalCollected = evt.totalCollected
      next.target = evt.target
      next.status = "running"
      break
    case "collection_done":
      next.totalCollected = evt.totalCollected
      next.dedupedCount = evt.deduped
      next.elapsedMs = evt.elapsedMs
      break
    case "ranking_start":
      next.topK = evt.topK
      break
    case "selected":
      next.selectedCount = evt.sources.length
      break
    case "done":
      next.status = "complete"
      next.totalCollected = evt.stats.totalCollected
      next.dedupedCount = evt.stats.dedupedCount
      next.selectedCount = evt.stats.selectedCount
      next.elapsedMs = evt.stats.elapsedMs
      break
    case "aborted":
      next.status = "aborted"
      break
    case "error":
      next.status = "error"
      break
    default:
      break
  }

  return next
}

function SearchActivityPanel({ activity, onClose }: { activity: SearchActivityState; onClose: () => void }) {
  const elapsed = activity.elapsedMs ?? activity.updatedAt - activity.startedAt
  const statusLabel = activity.status === "complete"
    ? "Completado"
    : activity.status === "aborted"
      ? "Detenido"
      : activity.status === "error"
        ? "Error"
        : "En curso"

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Actividad</h2>
            <span className="text-sm text-muted-foreground">· {formatActivityDuration(elapsed)}</span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{statusLabel} · {activity.totalCollected}/{activity.target} fuentes</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={onClose} aria-label="Cerrar actividad">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-b border-border/40 px-5 py-3">
        <div className="rounded-2xl border border-border/50 bg-muted/25 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Consulta</div>
          <p className="mt-1 line-clamp-3 text-sm leading-6 text-foreground">{activity.query}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-background px-2 py-1">Top {activity.topK}</span>
            <span className="rounded-full bg-background px-2 py-1">Lotes {activity.batchSize}</span>
            <span className="rounded-full bg-background px-2 py-1">{activity.providers.length || 0} proveedores</span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-5 py-5">
          <div className="mb-3 text-sm font-medium text-muted-foreground">Proceso</div>
          <div className="space-y-5">
            {activity.entries.map((entry, entryIndex) => (
              <div key={entry.id} className="relative pl-6">
                <span className={cn(
                  "absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-background",
                  entry.status === "complete" && "bg-emerald-500",
                  entry.status === "running" && "bg-sky-500",
                  entry.status === "warning" && "bg-amber-500",
                  entry.status === "error" && "bg-red-500",
                )} />
                {entryIndex < activity.entries.length - 1 && (
                  <span className="absolute left-[4px] top-5 h-[calc(100%+0.75rem)] w-px bg-border/60" />
                )}
                <div className="text-sm font-medium leading-5 text-foreground">{entry.title}</div>
                {entry.body && <div className="mt-1 text-sm leading-6 text-muted-foreground">{entry.body}</div>}
                {entry.meta && <div className="mt-1 text-xs text-muted-foreground/80">{entry.meta}</div>}
                {entry.sources && entry.sources.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {entry.sources.map((source, index) => {
                      const href = sourceHref(source)
                      return (
                        <div key={`${entry.id}-source-${index}`} className="rounded-lg border border-border/40 bg-muted/20 px-2.5 py-2">
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer" className="line-clamp-2 text-xs font-medium text-sky-700 hover:underline dark:text-sky-300">
                              {source.title || href}
                            </a>
                          ) : (
                            <div className="line-clamp-2 text-xs font-medium">{source.title || "Fuente sin título"}</div>
                          )}
                          <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{sourceMeta(source)}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

// Selected Text Display Component
// `SelectedTextDisplay` and `LinkContextDisplay` were extracted to
// `components/chat/ComposerInlineDisplays.tsx`. They are imported at
// the top of this file and used below with the exact same prop shape.


// Enhanced Actions Dropdown Component
const ActionsDropdown = ({
  chatType,
  setChatType,
  currentPlan,
  isWebSearchActive,
  setIsWebSearchActive,
  isImageGenerationActive,
  setIsImageGenerationActive,
  isVoiceGenerationActive,
  setIsVoiceGenerationActive,
  isMusicGenerationActive,
  setIsMusicGenerationActive,
  isVideoGenerationActive,
  setIsVideoGenerationActive,
  isComputerUseActive,
  setIsComputerUseActive,
  computerUseStatus,
  isGmailActive,
  setIsGmailActive,
  isGoogleCalendarActive,
  setIsGoogleCalendarActive,
  isGoogleDriveActive,
  setIsGoogleDriveActive,
  isSpotifyActive,
  setIsSpotifyActive,
  isWordConnectorActive,
  setIsWordConnectorActive,
  isExcelConnectorActive,
  setIsExcelConnectorActive,
  setShowAudioPanel,
  setAudioTab,
  handleAndUploadFiles,
  isUploading,
  isWebSearching,
  isLoading,
  isGeneratingImage,
  isGeneratingVideo,
  isGeneratingPPT,
  isProcessingGmail,
  isProcessingGoogleServices,
  isProcessingSpotify,

  handleComputerUseToggle,
  handleGmailToggle,
  handleGoogleCalendarToggle,
  handleGoogleDriveToggle,
  handleSpotifyToggle,
  handleWordConnectorToggle,
  handleExcelConnectorToggle,
  closeAllToolsAndConnectors,

}: any) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const [appsOpen, setAppsOpen] = React.useState(false);
  const [mobileAppsOpen, setMobileAppsOpen] = React.useState(false);
  const [justClosed, setJustClosed] = React.useState(false);
  const closeTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const isFreePlan = isFreePlanName(currentPlan);

  const handleFileUpload = (event?: Event | React.SyntheticEvent) => {
    event?.preventDefault?.();
    fileInputRef.current?.click();
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      // Per-batch funnel event (not per-file) — captures the user's
      // intent to attach with non-PII shape (count + total bytes).
      // Filenames are deliberately excluded — they can carry user
      // names / project codenames / sensitive info that doesn't
      // belong in a product-analytics stream.
      const files = Array.from(e.target.files);
      track("chat.file_uploaded", {
        count: files.length,
        total_bytes: files.reduce((acc, f) => acc + (f.size || 0), 0),
      });
      handleAndUploadFiles(e.target.files);
      // Clear the input to allow re-uploading the same file
      e.target.value = '';
      setIsOpen(false);
    }
  };

  // Function to handle single selection - deactivate others when one is selected
  const handleWebSearchToggle = () => {
    setChatType('text');
    if (!isWebSearchActive) {
      closeAllToolsAndConnectors();
    }
    setIsWebSearchActive(!isWebSearchActive);
  };

  const handleImageGenerationToggle = () => {
    if (isGeneratingImage) {
      setIsImageGenerationActive(true);
      setChatType('image');
      return;
    }

    const newState = !isImageGenerationActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setChatType('image');
    } else {
      setChatType('text');
    }

    setIsImageGenerationActive(newState);
  };

  const handleVideoGenerationToggle = () => {
    const newState = !isVideoGenerationActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setChatType('video');
    } else {
      setChatType('text');
    }

    setIsVideoGenerationActive(newState);
  };

  const handleVoiceGenerationToggle = () => {
    const newState = !isVoiceGenerationActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setChatType('text');
    }

    setIsVoiceGenerationActive(newState);
  };

  const handleMusicGenerationToggle = () => {
    const newState = !isMusicGenerationActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setChatType('text');
      setAudioTab('music');
    } else {
      setShowAudioPanel(false);
      setChatType('text');
    }

    setIsMusicGenerationActive(newState);
  };


  const isMenuDisabled = isLoading || isGeneratingVideo || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices;
  const isToolSwitchDisabled = isMenuDisabled || isGeneratingImage;

  const handleDropdownOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setAppsOpen(false);
      setMobileAppsOpen(false);
      // Prevent tooltip from showing immediately after dropdown closes
      setJustClosed(true);
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
      closeTimeoutRef.current = setTimeout(() => {
        setJustClosed(false);
      }, 300); // Wait 300ms before allowing tooltip to show again
    } else {
      setJustClosed(false);
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    }
  };

  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const connectorItems = [
    {
      key: "gmail",
      brand: "gmail",
      label: "Gmail",
      active: isGmailActive,
      disabled: isProcessingGmail,
      dotClassName: "bg-red-500",
      iconClassName: "bg-red-100 dark:bg-red-900/20",
      icon: <img src="/icons/google.png" alt="" aria-hidden="true" className="h-4 w-4" />,
      onClick: handleGmailToggle,
    },
    {
      key: "calendar",
      brand: "calendar",
      label: "Google Calendar",
      active: isGoogleCalendarActive,
      disabled: isProcessingGoogleServices,
      dotClassName: "bg-blue-500",
      iconClassName: "bg-blue-100 dark:bg-blue-900/20",
      icon: <img src="/icons/google-calendar.png" alt="" aria-hidden="true" className="h-4 w-4" />,
      onClick: handleGoogleCalendarToggle,
    },
    {
      key: "drive",
      brand: "drive",
      label: "Google Drive",
      active: isGoogleDriveActive,
      disabled: isProcessingGoogleServices,
      dotClassName: "bg-green-500",
      iconClassName: "bg-green-100 dark:bg-green-900/20",
      icon: <img src="/icons/google-drive.png" alt="" aria-hidden="true" className="h-4 w-4" />,
      onClick: handleGoogleDriveToggle,
    },
    {
      key: "spotify",
      brand: "spotify",
      label: "Spotify",
      active: isSpotifyActive,
      disabled: isProcessingSpotify,
      dotClassName: "bg-green-500",
      iconClassName: "bg-green-100 dark:bg-green-900/20",
      icon: <img src="/icons/spotify.png" alt="" aria-hidden="true" className="h-4 w-4" />,
      onClick: handleSpotifyToggle,
    },
    {
      key: "word",
      brand: "word",
      label: "Word",
      active: isWordConnectorActive,
      disabled: isToolSwitchDisabled,
      dotClassName: "bg-blue-500",
      iconClassName: "bg-blue-100 dark:bg-blue-900/20",
      icon: <img src="/icons/Word.png" alt="" aria-hidden="true" className="h-4 w-4" />,
      onClick: () => {
        handleWordConnectorToggle?.();
        setIsOpen(false);
      },
    },
    {
      key: "excel",
      brand: "excel",
      label: "Excel",
      active: isExcelConnectorActive,
      disabled: isToolSwitchDisabled,
      dotClassName: "bg-blue-500",
      iconClassName: "bg-blue-100 dark:bg-blue-900/20",
      icon: <img src="/icons/Excel.png" alt="" aria-hidden="true" className="h-4 w-4" />,
      onClick: () => {
        handleExcelConnectorToggle?.();
        setIsOpen(false);
      },
    },
  ];

  const activeAppsCount = connectorItems.filter((item) => item.active).length;

  const renderConnectorItems = () => connectorItems.map((item) => (
    <DropdownMenuItem
      key={item.key}
      className="liquid-menu-item chat-app-menu-item"
      data-brand={item.brand}
      data-active={item.active ? "true" : undefined}
      onClick={item.onClick}
      disabled={item.disabled}
    >
      <div className="flex items-center gap-3 w-full">
        <div className={`liquid-icon w-8 h-8 rounded-lg flex items-center justify-center ${item.iconClassName}`}>
          {item.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="liquid-label truncate font-medium text-sm">
            {item.label}
          </div>
        </div>
        {item.active && (
          <div className={`h-2 w-2 shrink-0 rounded-full ${item.dotClassName}`} aria-label="Activa" />
        )}
      </div>
    </DropdownMenuItem>
  ));

  return (
    <TooltipProvider>
      <DropdownMenu dir="ltr" open={isOpen} onOpenChange={handleDropdownOpenChange}>
        <Tooltip open={!isOpen && !justClosed ? undefined : false} delayDuration={300}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Adjuntar archivos y herramientas"
                className="h-9 w-9 p-0 hover:bg-muted/50 rounded-full flex items-center justify-center"
                disabled={isMenuDisabled}
              >
                <Plus className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Attach files & tools</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className="chat-tools-menu liquid-menu-surface"
        >
          {/* File Upload - Only for text chats */}

          <DropdownMenuItem
            className="liquid-menu-item"
            onSelect={handleFileUpload}
            disabled={isUploading || isGeneratingImage}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="liquid-icon w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                <Paperclip className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">Subir archivos</div>
                <div className="text-xs text-muted-foreground">
                  {isUploading ? 'Subiendo…' : 'Imágenes, PDFs, documentos'}
                </div>
              </div>
            </div>
          </DropdownMenuItem>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,application/pdf,.doc,.docx,.xlsx,.ppt,.pptx,.txt,.csv,.tsv,.md,.markdown,.rtf,.odt,.ods,.odp,.json,.xml,.html,.htm,.eml,.msg"
            onChange={handleFilesSelected}
          />
          {/* Web Search */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={handleWebSearchToggle}
            disabled={isWebSearching || isGeneratingImage}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={`liquid-icon w-8 h-8 rounded-lg flex items-center justify-center ${isWebSearchActive
                ? 'bg-green-100 dark:bg-green-900/20'
                : 'bg-emerald-100 dark:bg-emerald-900/20'
                }`}>
                <Globe className={`h-4 w-4 ${isWebSearchActive
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-emerald-600 dark:text-emerald-400'
                  }`} />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isWebSearchActive ? 'Web Search Active' : 'Web Search'}
                </div>
              </div>
              {isWebSearchActive && (
                <div className="w-2 h-2 bg-green-500 rounded-full" />
              )}
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="liquid-menu-item chat-apps-menu-trigger md:hidden"
            onSelect={(event) => {
              event.preventDefault();
              setMobileAppsOpen((open) => !open);
            }}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="liquid-icon w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-900/20 flex items-center justify-center">
                <Network width="13" height="13" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-semibold text-sm">APPs</div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeAppsCount > 0 ? `${activeAppsCount} activa${activeAppsCount > 1 ? "s" : ""}` : "Gmail, Calendar, Drive, Spotify"}
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", mobileAppsOpen && "rotate-180")} />
            </div>
          </DropdownMenuItem>
          {mobileAppsOpen && (
            <div className="chat-mobile-apps-panel md:hidden">
              {renderConnectorItems()}
            </div>
          )}
          <DropdownMenuSub open={appsOpen} onOpenChange={setAppsOpen}>
            <DropdownMenuSubTrigger
              className="liquid-menu-item hidden md:flex"
              onFocus={() => setAppsOpen(true)}
              onPointerEnter={() => setAppsOpen(true)}
              onClick={(e) => {
                e.preventDefault();
                setAppsOpen(true);
              }}
            >
              <div className="flex items-center gap-3 w-full">
                <div className="liquid-icon w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-900/20 flex items-center justify-center">
                  <Network width="13" height="13" />
                </div>
                <div className="flex-1">
                  <div className="liquid-label font-medium text-sm flex items-center">
                    APPs
                  </div>
                </div>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={10}
                alignOffset={-4}
                collisionPadding={12}
                className="liquid-menu-surface w-64"
              >
                {renderConnectorItems()}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* Image Generation */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={handleImageGenerationToggle}
            disabled={isToolSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={`liquid-icon w-8 h-8 rounded-lg flex items-center justify-center ${isImageGenerationActive
                ? 'bg-pink-100 dark:bg-pink-900/20'
                : 'bg-pink-100 dark:bg-pink-900/20'
                }`}>
                <Palette className={`h-4 w-4 ${isImageGenerationActive
                  ? 'text-pink-600 dark:text-pink-400'
                  : 'text-pink-600 dark:text-pink-400'
                  }`} />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isImageGenerationActive ? 'Imágenes activas' : 'Imágenes'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {isFreePlan ? 'Vista previa de generación con IA' : isGeneratingImage ? 'Generando ahora' : 'Genera imágenes con IA'}
                </div>
              </div>
              {(isImageGenerationActive || isGeneratingImage) && (
                <div className={cn("w-2 h-2 bg-pink-500 rounded-full", isGeneratingImage && "animate-pulse")} />
              )}
              {isFreePlan && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>

          {/* Voz / Audio quick action — opens Voice Studio on TTS tab */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={() => { handleVoiceGenerationToggle(); setIsOpen(false); }}
            disabled={isToolSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="liquid-icon w-8 h-8 rounded-lg bg-cyan-100 dark:bg-cyan-900/20 flex items-center justify-center">
                <AudioLines className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">Voz</div>
                <div className="text-xs text-muted-foreground">
                  {isFreePlan ? 'Vista previa ElevenLabs / Mimo HD' : 'ElevenLabs / Mimo HD · TTS'}
                </div>
              </div>
              {isVoiceGenerationActive && (
                <div className="w-2 h-2 bg-cyan-500 rounded-full" />
              )}
              {isFreePlan && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>

          {/* Video Generation */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={handleVideoGenerationToggle}
            disabled={isToolSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={`liquid-icon w-8 h-8 rounded-lg flex items-center justify-center ${isVideoGenerationActive
                ? 'bg-orange-100 dark:bg-orange-900/20'
                : 'bg-orange-100 dark:bg-orange-900/20'
                }`}>
                <Video className={`h-4 w-4 ${isVideoGenerationActive
                  ? 'text-orange-600 dark:text-orange-400'
                  : 'text-orange-600 dark:text-orange-400'
                  }`} />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isVideoGenerationActive ? 'Video Generation Active' : 'Video Generation'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {isFreePlan ? 'Vista previa de video con IA' : 'Create videos with Google Veo 3'}
                </div>
              </div>
              {isVideoGenerationActive && (
                <div className="w-2 h-2 bg-orange-500 rounded-full" />
              )}
              {isFreePlan && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>

          {/* Música quick action */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={() => { handleMusicGenerationToggle(); setIsOpen(false); }}
            disabled={isToolSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="liquid-icon w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-900/20 flex items-center justify-center">
                <Music className="h-4 w-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isMusicGenerationActive ? 'Música activa' : 'Música'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {isFreePlan ? 'Vista previa de música con IA' : 'Lyria 3 Pro · genera canciones con IA'}
                </div>
              </div>
              {isMusicGenerationActive && (
                <div className="w-2 h-2 bg-rose-500 rounded-full" />
              )}
              {isFreePlan && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>

          {/* Computer Use Agent - Temporarily disabled */}
          {/*
        <DropdownMenuItem
          onClick={handleComputerUseToggle}
          disabled={currentPlan === "FREE" || isDisabled}
        >
          <div className="flex items-center gap-3 w-full">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isComputerUseActive
              ? 'bg-indigo-100 dark:bg-indigo-900/20'
              : 'bg-indigo-100 dark:bg-indigo-900/20'
              }`}>
              <Monitor className={`h-4 w-4 ${isComputerUseActive
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-indigo-600 dark:text-indigo-400'
                }`} />
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">
                {isComputerUseActive ? 'Computer Use Active' : 'Computer Use Agent'}
              </div>
              <div className="text-xs text-muted-foreground">
                AI that can control browsers and perform tasks
              </div>
            </div>
            {isComputerUseActive && (
              <div className="w-2 h-2 bg-indigo-500 rounded-full" />
            )}
            {currentPlan === "FREE" && (
              <Badge variant="secondary" className="text-xs">Pro</Badge>
            )}
          </div>
        </DropdownMenuItem>
        */}

          {/* Thesis Generation */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={() => {
              setChatType('thesis');
              setIsOpen(false);
            }}
            disabled={isToolSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={`liquid-icon w-8 h-8 rounded-lg flex items-center justify-center ${chatType === 'thesis'
                ? 'bg-purple-100 dark:bg-purple-900/20'
                : 'bg-purple-100 dark:bg-purple-900/20'
                }`}>
                <BookOpen className={`h-4 w-4 ${chatType === 'thesis'
                  ? 'text-purple-600 dark:text-purple-400'
                  : 'text-purple-600 dark:text-purple-400'
                  }`} />
              </div>
              <div className="flex-1">
                <div className="liquid-label font-medium text-sm">
                  {chatType === 'thesis' ? 'Thesis Generator Active' : 'Thesis Generator'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {isFreePlan ? 'Vista previa de tesis académica' : 'Generate comprehensive academic theses'}
                </div>
              </div>
              {chatType === 'thesis' && (
                <div className="w-2 h-2 bg-purple-500 rounded-full" />
              )}
              {isFreePlan && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>      </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
};
const wrapIconInSmallSquare = (icon: JSX.Element, color: string) => (
  <div className={`h-8 w-8 flex items-center justify-center rounded-md overflow-hidden`} style={{ backgroundColor: color }}>
    {icon}
  </div>
);

const getFileIcon = (file: any) => {
  const isImage = file.type?.startsWith('image/');

  if (isImage && file.url) {
    const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || "";
    const imageUrl = baseUrl + file.url;

    return (
      <img
        src={imageUrl}
        alt={file.name}
        className="h-full w-full object-cover" // Yeh classes <img> ko apne parent container mein fit karengi
      />
    );
  }

  // Non-image files ke liye, purana logic use karein (wrapped icon)
  const extension = file.name?.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'pdf':
      return <img src="/icons/pdf.png" alt="PDF" className="h-8 w-8" />;
    case 'doc':
    case 'docx':
      return <img src="/icons/Word.png" alt="Word" className="h-8 w-8" />;
    case 'xls':
    case 'xlsx':
    case 'csv':
      return <img src="/icons/Excel.png" alt="Excel" className="h-8 w-8" />;
    case 'ppt':
    case 'pptx':
      return <img src="/icons/Bigger P powerpoint.png" alt="PowerPoint" className="h-8 w-8" />;
    case 'txt':
      return wrapIconInSmallSquare(<FileText className="h-5 w-5 text-white" />, "#6b7280"); // grey
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'wmv':
      return wrapIconInSmallSquare(<Video className="h-5 w-5 text-white" />, "#9333ea"); // purple
    case 'mp3':
    case 'wav':
      return wrapIconInSmallSquare(<Music className="h-5 w-5 text-white" />, "#db2777"); // pink
    case 'zip':
    case 'rar':
    case '7z':
      return wrapIconInSmallSquare(<FileIcon className="h-5 w-5 text-white" />, "#eab308"); // yellow
    default:
      return wrapIconInSmallSquare(<FileIcon className="h-5 w-5 text-white" />, "#9ca3af"); // gray
  }
};
// Active Options Display Component - Renders above the textarea
const ActiveOptionsDisplay = ({
  uploadedFiles,
  removeFile,
  uploadProgress,
  retryUpload,
  restoreLongPasteToInput,
  onPreviewAttachment,
}: {
  uploadedFiles: any[];
  removeFile: (index: number) => void;
  uploadProgress: { [key: string]: number };
  retryUpload?: (file: any) => void;
  restoreLongPasteToInput?: (file: any, index: number) => void;
  onPreviewAttachment?: (attachment: AttachmentLike, siblings: AttachmentLike[], index: number) => void;
}) => {
  // Viewer state — same reusable viewer used by sent-message chips, so
  // the user gets identical high-fidelity preview in both contexts.
  const [viewingIndex, setViewingIndex] = React.useState<number | null>(null);
  const viewingAttachment: AttachmentLike | null = React.useMemo(() => {
    if (viewingIndex === null) return null;
    const f = uploadedFiles[viewingIndex];
    if (!f) return null;
    return toDocumentViewerAttachment(f);
  }, [viewingIndex, uploadedFiles]);
  const viewerSiblings: AttachmentLike[] = React.useMemo(
    () => uploadedFiles.map((f: any) => toDocumentViewerAttachment(f)),
    [uploadedFiles]
  );

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const readyAttachments = viewerSiblings.filter((attachment, index) => {
      const file = uploadedFiles[index];
      return file?.status !== "uploading" && file?.status !== "failed" && attachmentHasPreviewSource(attachment);
    });
    if (readyAttachments.length === 0) return;

    let cancelled = false;
    const prewarm = () => {
      if (cancelled) return;
      readyAttachments.forEach((attachment) => prewarmUnifiedDocumentPreview(attachment));
    };
    const requestIdle = (window as any).requestIdleCallback;
    const cancelIdle = (window as any).cancelIdleCallback;
    const handle = typeof requestIdle === "function"
      ? requestIdle(prewarm, { timeout: 1500 })
      : window.setTimeout(prewarm, 120);

    return () => {
      cancelled = true;
      if (typeof cancelIdle === "function") cancelIdle(handle);
      else window.clearTimeout(handle);
    };
  }, [viewerSiblings, uploadedFiles]);

  if (uploadedFiles.length === 0) return null;

  return (
    <div className="p-3  bg-background">
      <div className="flex flex-wrap items-center gap-2 max-h-40 overflow-y-auto">
        {uploadedFiles.map((file, index) => {
          const isImage = file.type?.startsWith('image/');
          const fileId = file.id || file.tempId;
          const rawProgress = uploadProgress[fileId];
          const isUploading = file.status === 'uploading';
          const progress = isUploading
            ? Math.max(1, Math.min(99, rawProgress ?? 1))
            : (rawProgress || 0);
          const isFailed = file.status === 'failed';
          const longPasteMeta = getLongPasteMetadata(file);
          const imageSizeClass = uploadedFiles.length > 1 ? 'h-20 w-20' : 'h-32 w-32';
          const attachment = viewerSiblings[index];
          const canPreview = !isFailed && attachmentHasPreviewSource(attachment);
          const openPreview = () => {
            if (!canPreview || !attachment) return;
            if (onPreviewAttachment) {
              onPreviewAttachment(attachment, viewerSiblings, index);
            } else {
              setViewingIndex(index);
            }
          };

          return (
            <div
              key={index}
              className={cn(
                "relative text-sm rounded-xl",
                "border",
                isFailed ? "border-red-300 dark:border-red-700/50" : "border-gray-200 dark:border-border/60",
                isImage ? `${imageSizeClass} p-0` : "flex items-center gap-2 px-2 py-1",
                // Clickable chip — opens the unified high-fidelity viewer.
                canPreview && "cursor-pointer hover:border-foreground/40 hover:shadow-sm transition-all",
              )}
              title={isFailed ? `Subida fallida: ${file.uploadError || 'error'}` : canPreview ? 'Ver documento' : 'Preparando documento'}
              onClick={openPreview}
              role={canPreview ? 'button' : undefined}
              tabIndex={canPreview ? 0 : undefined}
              onKeyDown={(e) => {
                if (!canPreview) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(); }
              }}
            >
              {isImage ? (
                <>
                  <div className="h-full w-full rounded-md overflow-hidden bg-gray-100 dark:bg-muted/40 flex items-center justify-center relative">
                    {file.preview ? (
                      <img src={file.preview} alt={file.name} className="h-full w-full object-cover" />
                    ) : file.url ? (
                      <img
                        src={`${process.env.NEXT_PUBLIC_IMAGE_URL || ""}${file.url}`}
                        alt={file.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      getFileIcon(file)
                    )}

                    {isUploading && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <div className="text-center">
                          <ThinkingIndicator size="md" className="text-white mx-auto mb-1" />
                          <span className="text-white text-xs font-medium">{Math.round(progress)}%</span>
                        </div>
                      </div>
                    )}

                    {/* Failed overlay — retry CTA over the thumbnail */}
                    {isFailed && retryUpload && (
                      <div className="absolute inset-0 bg-red-900/55 flex flex-col items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 rounded-full bg-white/95 hover:bg-white text-red-600"
                          onClick={(e) => { e.stopPropagation(); retryUpload(file); }}
                          title="Reintentar subida"
                          aria-label="Reintentar subida"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <span className="text-[9.5px] text-white font-medium">Reintentar</span>
                      </div>
                    )}
                  </div>

                  {!isUploading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute top-1 right-1 h-6 w-6 p-0 bg-white dark:bg-background rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                      onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                      title="Quitar"
                      aria-label="Quitar archivo"
                    >
                      <X className="h-4 w-4 text-gray-600 dark:text-foreground" />
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {getFileIcon(file)}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className={`truncate font-medium text-[13px] ${isFailed ? 'text-red-600 dark:text-red-400' : ''}`}>
                      {longPasteMeta?.title || file.name}
                    </span>
                    {longPasteMeta && !isUploading && !isFailed && (
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] leading-tight text-muted-foreground">
                        {/* Solid stats so the user can verify the
                            paste was captured fully — char/word count
                            + detected content kind. Without these the
                            chip reads as a blob with no provenance. */}
                        <span className="tabular-nums">
                          {Intl.NumberFormat('es').format(longPasteMeta.originalCharCount || 0)} car.
                        </span>
                        {longPasteMeta.originalWordCount > 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="tabular-nums">
                              {Intl.NumberFormat('es').format(longPasteMeta.originalWordCount)} pal.
                            </span>
                          </>
                        )}
                        {longPasteMeta.contentKind && longPasteMeta.contentKind !== 'prose' && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="uppercase tracking-wider text-[10px]">
                              {longPasteMeta.contentKind}
                            </span>
                          </>
                        )}
                        <button
                          type="button"
                          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 underline-offset-2 hover:bg-muted/60 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          onClick={(e) => {
                            e.stopPropagation();
                            restoreLongPasteToInput?.(file, index);
                          }}
                          aria-label="Restaurar el texto al campo del composer"
                          title="Restaurar al campo de texto"
                        >
                          Restaurar ↩
                        </button>
                      </div>
                    )}
                    {!isUploading && !isFailed && file.id && !longPasteMeta && (
                      <div className="mt-0.5">
                        <FileProcessingBadge
                          fileId={file.id}
                          onReady={() => toast.success(`Documento listo: ${file.name}`)}
                        />
                      </div>
                    )}
                    {isUploading && (
                      <div className="flex items-center gap-1 mt-1">
                        <div className="flex-1 h-1 bg-gray-200 dark:bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">{Math.round(progress)}%</span>
                      </div>
                    )}
                    {isFailed && (
                      <span className="text-[10px] text-red-500 dark:text-red-400 mt-0.5 truncate">
                        {file.uploadError || 'Error de subida'}
                      </span>
                    )}
                  </div>
                  {!isUploading && (
                    <div className="flex items-center gap-0.5 ml-1">
                      {isFailed && retryUpload && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 hover:bg-red-500/10 rounded-full text-red-600 dark:text-red-400"
                          onClick={(e) => { e.stopPropagation(); retryUpload(file); }}
                          title="Reintentar subida"
                          aria-label="Reintentar subida"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 hover:bg-gray-200 dark:hover:bg-muted rounded-full"
                        onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                        title="Quitar"
                        aria-label="Quitar archivo"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <UnifiedDocumentViewer
        open={viewingIndex !== null}
        onClose={() => setViewingIndex(null)}
        attachment={viewingAttachment}
        siblings={viewerSiblings}
        onNavigate={(next) => {
          const newIdx = viewerSiblings.findIndex(s => s === next);
          if (newIdx >= 0) setViewingIndex(newIdx);
        }}
      />
    </div>
  );
};
// Active Tools Display Component - Shows INSIDE the textarea at the bottom
const ActiveToolsDisplay = ({
  isWebSearchActive,
  setIsWebSearchActive,
  isImageGenerationActive,
  setIsImageGenerationActive,
  isGeneratingImage = false,
  selectedImageAspectRatio,
  setSelectedImageAspectRatio,
  selectedImageQuality,
  setSelectedImageQuality,
  selectedImageCount,
  setSelectedImageCount,
  selectedImageModel,
  setSelectedImageModel,
  isVoiceGenerationActive,
  setIsVoiceGenerationActive,
  selectedVoiceModel,
  setSelectedVoiceModel,
  selectedVoiceLanguage,
  setSelectedVoiceLanguage,
  selectedVoiceAccent,
  setSelectedVoiceAccent,
  selectedVoiceStability,
  setSelectedVoiceStability,
  selectedVoiceEffect,
  setSelectedVoiceEffect,
  isMusicGenerationActive,
  setIsMusicGenerationActive,
  selectedMusicModel,
  setSelectedMusicModel,
  selectedMusicStyle,
  setSelectedMusicStyle,
  selectedMusicMood,
  setSelectedMusicMood,
  selectedMusicDuration,
  setSelectedMusicDuration,
  selectedMusicInfluence,
  setSelectedMusicInfluence,
  selectedMusicEffect,
  setSelectedMusicEffect,
  setShowAudioPanel,
  setAudioTab,
  isVideoGenerationActive,
  setIsVideoGenerationActive,
  selectedVideoResolution,
  setSelectedVideoResolution,
  selectedVideoAspectRatio,
  setSelectedVideoAspectRatio,
  selectedVideoDuration,
  setSelectedVideoDuration,
  selectedVideoAudio,
  setSelectedVideoAudio,
  selectedVideoModel,
  setSelectedVideoModel,
  isComputerUseActive,
  setIsComputerUseActive,
  computerUseStatus,
  isGmailActive,
  setIsGmailActive,
  isGoogleCalendarActive,
  setIsGoogleCalendarActive,
  isGoogleDriveActive,
  setIsGoogleDriveActive,
  isSpotifyActive,
  setIsSpotifyActive,
  isWordConnectorActive,
  setIsWordConnectorActive,
  isExcelConnectorActive,
  setIsExcelConnectorActive,
  selectedModel,
  setSelectedModel,
  availableModels,
  setSelectedProvider,
  chatType,
  setChatType,

  handleComputerUseToggle,
  handleGmailToggle,
  handleGoogleCalendarToggle,
  handleGoogleDriveToggle,
  handleSpotifyToggle,
  handleWordConnectorToggle,
  handleExcelConnectorToggle
}: {
  isWebSearchActive: boolean;
  setIsWebSearchActive: (value: boolean) => void;
  isImageGenerationActive: boolean;
  setIsImageGenerationActive: (value: boolean) => void;
  isGeneratingImage?: boolean;
  selectedImageAspectRatio: ImageAspectRatio;
  setSelectedImageAspectRatio: (ratio: ImageAspectRatio) => void;
  selectedImageQuality: ImageQuality;
  setSelectedImageQuality: (quality: ImageQuality) => void;
  selectedImageCount: ImageGenerationCount;
  setSelectedImageCount: (count: ImageGenerationCount) => void;
  selectedImageModel: string;
  setSelectedImageModel: (model: string) => void;
  isVoiceGenerationActive: boolean;
  setIsVoiceGenerationActive: (value: boolean) => void;
  selectedVoiceModel: VoiceModel;
  setSelectedVoiceModel: (model: VoiceModel) => void;
  selectedVoiceLanguage: VoiceLanguage;
  setSelectedVoiceLanguage: (language: VoiceLanguage) => void;
  selectedVoiceAccent: VoiceAccent;
  setSelectedVoiceAccent: (accent: VoiceAccent) => void;
  selectedVoiceStability: number;
  setSelectedVoiceStability: (stability: number) => void;
  selectedVoiceEffect: VoiceEffect;
  setSelectedVoiceEffect: (effect: VoiceEffect) => void;
  isMusicGenerationActive: boolean;
  setIsMusicGenerationActive: (value: boolean) => void;
  selectedMusicModel: MusicModel;
  setSelectedMusicModel: (model: MusicModel) => void;
  selectedMusicStyle: MusicStyle;
  setSelectedMusicStyle: (style: MusicStyle) => void;
  selectedMusicMood: MusicMood;
  setSelectedMusicMood: (mood: MusicMood) => void;
  selectedMusicDuration: number;
  setSelectedMusicDuration: (duration: number) => void;
  selectedMusicInfluence: number;
  setSelectedMusicInfluence: (influence: number) => void;
  selectedMusicEffect: MusicEffect;
  setSelectedMusicEffect: (effect: MusicEffect) => void;
  setShowAudioPanel: (value: boolean) => void;
  setAudioTab: (tab: 'tts' | 'stt' | 'music' | 'video') => void;
  isVideoGenerationActive: boolean;
  setIsVideoGenerationActive: (value: boolean) => void;
  selectedVideoResolution: VideoResolution;
  setSelectedVideoResolution: (resolution: VideoResolution) => void;
  selectedVideoAspectRatio: VideoAspectRatio;
  setSelectedVideoAspectRatio: (ratio: VideoAspectRatio) => void;
  selectedVideoDuration: VideoDuration;
  setSelectedVideoDuration: (duration: VideoDuration) => void;
  selectedVideoAudio: boolean;
  setSelectedVideoAudio: (enabled: boolean) => void;
  selectedVideoModel: string;
  setSelectedVideoModel: (model: string) => void;
  isComputerUseActive: boolean;
  setIsComputerUseActive: (value: boolean) => void;
  computerUseStatus: 'idle' | 'running' | 'completed' | 'error';
  isGmailActive: boolean;
  setIsGmailActive: (value: boolean) => void;
  isGoogleCalendarActive: boolean;
  setIsGoogleCalendarActive: (value: boolean) => void;
  isGoogleDriveActive: boolean;
  setIsGoogleDriveActive: (value: boolean) => void;
  isSpotifyActive: boolean;
  setIsSpotifyActive: (value: boolean) => void;
  isWordConnectorActive: boolean;
  setIsWordConnectorActive: (value: boolean) => void;
  isExcelConnectorActive: boolean;
  setIsExcelConnectorActive: (value: boolean) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  availableModels: any[];
  setSelectedProvider: (provider: string) => void;
  chatType: string;
  setChatType: (type: any) => void;

  handleComputerUseToggle: () => void;
  handleGmailToggle: () => void;
  handleGoogleCalendarToggle: () => void;
  handleGoogleDriveToggle: () => void;
  handleSpotifyToggle: () => void;
  handleWordConnectorToggle: () => void;
  handleExcelConnectorToggle: () => void;
}) => {
  const [showAllVideoRatios, setShowAllVideoRatios] = React.useState(false);
  const [showAllVideoDurations, setShowAllVideoDurations] = React.useState(false);
  const activeConnectors = [
    isGmailActive && { id: 'gmail', icon: <img src="/icons/google.png" alt="Gmail" className="h-4 w-4" /> },
    isGoogleCalendarActive && { id: 'calendar', icon: <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4" /> },
    isGoogleDriveActive && { id: 'drive', icon: <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4" /> },
    isSpotifyActive && { id: 'spotify', icon: <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4" /> },
    isWordConnectorActive && { id: 'word', icon: <img src="/icons/Word.png" alt="Word" className="h-4 w-4" /> },
    isExcelConnectorActive && { id: 'excel', icon: <img src="/icons/Excel.png" alt="Excel" className="h-4 w-4" /> },
  ].filter(Boolean) as { id: string; icon: JSX.Element }[];

  const hasConnectors = activeConnectors.length > 0;
  const hasOtherTools = isImageGenerationActive || isVoiceGenerationActive || isMusicGenerationActive || isVideoGenerationActive || isWebSearchActive || isComputerUseActive;
  const hasThesis = chatType === 'thesis';

  const handleCloseAllConnectors = () => {
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    setChatType('text');
  };

  const handleImageGenerationClose = () => {
    if (isGeneratingImage) return;
    setIsImageGenerationActive(false);
    setChatType('text');
  };

  const handleVoiceGenerationClose = () => {
    setIsVoiceGenerationActive(false);
    setChatType('text');
  };

  const handleMusicGenerationClose = () => {
    setIsMusicGenerationActive(false);
    setShowAudioPanel(false);
    setChatType('text');
  };

  const handleVideoGenerationClose = () => {
    setIsVideoGenerationActive(false);
    setChatType('text');
  };

  const handleWebSearchClose = () => {
    setIsWebSearchActive(false);
    setChatType('text');
  };

  const handleComputerUseClose = () => {
    setIsComputerUseActive(false);
    setChatType('text');
  };

  const handleThesisClose = () => {
    setChatType('text');
  };

  const mediaModelOptions = React.useMemo(() => {
    const models = Array.isArray(availableModels) ? availableModels : [];
    const pickByKind = (kind: "image" | "video") => {
      const pattern = kind === "image"
        ? /image|imagen|dall|seedream|flux|stable|midjourney|ideogram|recraft|gpt-image/i
        : /video|veo|kling|runway|pika|hailuo|luma/i;
      const type = kind.toUpperCase();
      return models.filter((model: any) => {
        const label = `${model?.name || ""} ${model?.displayName || ""} ${model?.provider || ""}`;
        return String(model?.type || "").toUpperCase() === type || pattern.test(label);
      });
    };
    const normalize = (model: any) => ({
      name: model.name,
      displayName: model.displayName || model.name,
      provider: model.provider || null,
      iconName: resolveModelIconName(model),
    });

    const imageModels = pickByKind("image").map(normalize);
    const videoModels = pickByKind("video").map(normalize);

    return {
      image: imageModels.length ? imageModels : [
        { name: "bytedance-seed/seedream-4.5", displayName: "Seedream 4.5", provider: "OpenRouter", iconName: "SeedreamLogo" },
        { name: "google/imagen-3-0", displayName: "Imagen 3", provider: "Gemini", iconName: "GeminiLogo" },
        { name: "openai/dall-e-3", displayName: "DALL-E 3", provider: "OpenAI", iconName: "ChatGPTLogo" },
      ],
      video: videoModels.length ? videoModels : [
        { name: "veo-fast", displayName: "Veo Fast (8s)", provider: "Google", iconName: "GeminiLogo" },
        { name: "kling-1.6-pro", displayName: "Kling 1.6 Pro (10s)", provider: "Kling", iconName: "Bot" },
        { name: "kling-2-master", displayName: "Kling 2 Master (10s)", provider: "Kling", iconName: "Bot" },
      ],
      voice: VOICE_MODEL_OPTIONS.map((name) => ({
        name,
        displayName: name,
        provider: name === "ElevenLabs" ? "ElevenLabs" : "Mimo",
        iconName: "Bot",
      })),
      music: MUSIC_MODEL_OPTIONS.map((name) => ({
        name,
        displayName: name,
        provider: name === "Lyria 3 Pro" ? "Google" : name === "ElevenLabs" ? "ElevenLabs" : "Mimo",
        iconName: name === "Lyria 3 Pro" ? "GeminiLogo" : "Bot",
      })),
    };
  }, [availableModels]);

  const renderMediaModelPicker = (
    tool: "image" | "voice" | "music" | "video",
    value: string,
    onChange: (name: string, provider?: string | null) => void,
  ) => {
    const options = mediaModelOptions[tool];
    const selected = options.find((option: any) => option.name === value) || options[0];
    const label = selected?.displayName || value || "Modelo";

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="group/media-model relative isolate h-8 max-w-[212px] shrink-0 gap-1.5 overflow-hidden rounded-full border border-zinc-200/72 bg-white/84 px-3 py-0 text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.86),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
            aria-label={`Seleccionar modelo de ${tool}`}
            title={`Modelo: ${label}`}
          >
            <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/media-model:left-[92%] group-hover/media-model:opacity-100 dark:via-white/20" />
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
              <IconProvider name={selected?.iconName || "Bot"} size={18} />
            </span>
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="liquid-menu-surface w-[min(calc(100vw-1rem),18rem)] p-1.5"
        >
          {options.length > 0 ? options.map((option: any) => (
            <DropdownMenuItem
              key={option.name}
              className="chat-active-apps-menu-item h-9 gap-2 text-[12px]"
              onClick={() => onChange(option.name, option.provider)}
            >
              <IconProvider name={option.iconName || "Bot"} size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{option.displayName}</span>
              {option.name === value && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          )) : (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Sin modelos disponibles</div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  if (!hasConnectors && !hasOtherTools && !hasThesis) return null;

  const renderAppSwitchItems = () => (
    <>
      <DropdownMenuItem className="chat-active-apps-menu-item" onSelect={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icons/google.png" alt="Gmail" className="h-4 w-4 shrink-0" />
            <span className="truncate">Gmail</span>
          </div>
          <Switch checked={isGmailActive} onCheckedChange={handleGmailToggle} />
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem className="chat-active-apps-menu-item" onSelect={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4 shrink-0" />
            <span className="truncate">Google Calendar</span>
          </div>
          <Switch checked={isGoogleCalendarActive} onCheckedChange={handleGoogleCalendarToggle} />
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem className="chat-active-apps-menu-item" onSelect={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4 shrink-0" />
            <span className="truncate">Google Drive</span>
          </div>
          <Switch checked={isGoogleDriveActive} onCheckedChange={handleGoogleDriveToggle} />
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem className="chat-active-apps-menu-item" onSelect={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4 shrink-0" />
            <span className="truncate">Spotify</span>
          </div>
          <Switch checked={isSpotifyActive} onCheckedChange={handleSpotifyToggle} />
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem className="chat-active-apps-menu-item" onSelect={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icons/Word.png" alt="Word" className="h-4 w-4 shrink-0" />
            <span className="truncate">Word</span>
          </div>
          <Switch checked={isWordConnectorActive} onCheckedChange={handleWordConnectorToggle} />
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem
        className="chat-active-apps-menu-item"
        onSelect={(e) => e.preventDefault()}
        onMouseEnter={prefetchExcelConnector}
        onFocus={prefetchExcelConnector}
      >
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/icons/Excel.png" alt="Excel" className="h-4 w-4 shrink-0" />
            <span className="truncate">Excel</span>
          </div>
          <Switch checked={isExcelConnectorActive} onCheckedChange={handleExcelConnectorToggle} />
        </div>
      </DropdownMenuItem>
    </>
  );

  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-2">
      {hasConnectors && (
        <div className="chat-active-apps-chip flex max-w-full items-center overflow-hidden rounded-full border border-blue-200 bg-blue-50 text-blue-700 shadow-sm dark:border-blue-800/70 dark:bg-blue-950/30 dark:text-blue-200">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 min-w-0 items-center gap-1.5 px-2.5 text-xs font-semibold"
                aria-label="Abrir APPs activas"
              >
                <Network width="13" height="13" className="shrink-0" />
                <span>APPs</span>
                <div className="ml-0.5 flex min-w-0 items-center gap-0.5">
                  {activeConnectors.map(c => <React.Fragment key={c.id}>{c.icon}</React.Fragment>)}
                </div>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} collisionPadding={12} className="chat-active-apps-menu liquid-menu-surface w-[min(calc(100vw-1.25rem),18rem)] p-1.5">
              {renderAppSwitchItems()}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="mr-1 h-6 w-6 shrink-0 rounded-full p-0 hover:bg-blue-100 dark:hover:bg-blue-900/30"
            onClick={handleCloseAllConnectors}
            aria-label="Cerrar APPs"
            title="Cerrar APPs"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {isWebSearchActive && (
        <div
          className="group/web-search-tool flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-green-200 bg-green-100 px-0 text-xs text-green-700 transition-[width,padding,box-shadow] duration-300 ease-out hover:w-[120px] hover:justify-start hover:px-2 hover:shadow-sm focus-within:w-[120px] focus-within:justify-start focus-within:px-2 focus-within:shadow-sm dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
          aria-label="Web Search activo. Pasa el cursor para cerrar."
        >
          <Globe className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
          <span className="ml-0 max-w-0 overflow-hidden whitespace-nowrap font-medium opacity-0 transition-all duration-250 ease-out group-hover/web-search-tool:ml-1.5 group-hover/web-search-tool:max-w-[72px] group-hover/web-search-tool:opacity-100 group-focus-within/web-search-tool:ml-1.5 group-focus-within/web-search-tool:max-w-[72px] group-focus-within/web-search-tool:opacity-100">
            Web Search
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-0 h-4 w-0 shrink-0 overflow-hidden rounded-full p-0 opacity-0 transition-all duration-250 ease-out hover:bg-green-200 group-hover/web-search-tool:ml-1 group-hover/web-search-tool:w-4 group-hover/web-search-tool:opacity-100 group-focus-within/web-search-tool:ml-1 group-focus-within/web-search-tool:w-4 group-focus-within/web-search-tool:opacity-100 dark:hover:bg-green-800/30"
            onClick={handleWebSearchClose}
            aria-label="Cerrar Web Search"
            title="Cerrar Web Search"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {isImageGenerationActive && (
        <>
          <div className="group/image-liquid relative isolate flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-pink-300/70 bg-pink-100/88 px-3 text-[14px] font-semibold text-pink-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_10px_28px_-22px_rgba(219,39,119,0.75)] backdrop-blur-xl transition-all duration-300 hover:scale-[1.01] hover:border-pink-400/80 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_36px_-22px_rgba(219,39,119,0.9)] dark:border-pink-500/40 dark:bg-pink-900/25 dark:text-pink-200">
            <span className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-[conic-gradient(from_90deg,transparent_0deg,rgba(244,114,182,0.0)_70deg,rgba(244,114,182,0.55)_130deg,rgba(236,72,153,0.22)_190deg,transparent_280deg)] opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/75 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/image-liquid:translate-x-[155%] dark:via-white/25" />
            <span className="pointer-events-none absolute left-7 top-1 h-1.5 w-1.5 rounded-full bg-pink-400/75 shadow-[0_0_12px_rgba(236,72,153,0.75)] motion-safe:animate-pulse" />
            <span className="pointer-events-none absolute bottom-1 right-9 h-1 w-1 rounded-full bg-white/90 shadow-[0_0_10px_rgba(255,255,255,0.9)] motion-safe:animate-bounce" />
            <Palette className="relative z-10 h-4 w-4 drop-shadow-[0_0_8px_rgba(219,39,119,0.35)]" />
            <span className="relative z-10">Imágenes</span>
            {isGeneratingImage && <span className="relative z-10 h-1.5 w-1.5 rounded-full bg-pink-500 animate-pulse" />}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "relative z-10 ml-1 h-5 w-5 rounded-full p-0",
                isGeneratingImage
                  ? "opacity-45 cursor-not-allowed"
                  : "hover:bg-white/50 dark:hover:bg-pink-800/30"
              )}
              onClick={handleImageGenerationClose}
              disabled={isGeneratingImage}
              title={isGeneratingImage ? "La herramienta sigue activa durante la generación" : "Cerrar imágenes"}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {renderMediaModelPicker("image", selectedImageModel, (name, provider) => {
            setSelectedImageModel(name);
            track("model.selected", { model: name, provider: provider || null, surface: "image-tool-picker" });
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group/ratio-trigger relative isolate h-8 shrink-0 gap-2 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-3 py-0 text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Imagen: ${selectedImageAspectRatio}, ${selectedImageQuality}, ${selectedImageCount}`}
                aria-label={`Configurar imagen. Actual ${selectedImageAspectRatio}, ${selectedImageQuality}, ${selectedImageCount}`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/ratio-trigger:left-[92%] group-hover/ratio-trigger:opacity-100 dark:via-white/20" />
                <ImageAspectRatioMark ratio={selectedImageAspectRatio} selected className="h-5 w-5 text-zinc-700 dark:text-white/88" />
                <span>{selectedImageAspectRatio}</span>
                <span>{selectedImageQuality}</span>
                <span>{selectedImageCount} img</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="w-[min(calc(100vw-1.25rem),24rem)] overflow-hidden rounded-[22px] border border-zinc-200/65 bg-white/86 p-0 text-zinc-950 shadow-[0_22px_70px_-36px_rgba(15,23,42,0.55),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl dark:border-white/14 dark:bg-zinc-950/72 dark:text-white dark:shadow-[0_24px_80px_-36px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.16)]"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_24%_18%,rgba(255,255,255,0.92),transparent_30%),radial-gradient(circle_at_72%_45%,rgba(15,23,42,0.08),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.72),rgba(255,255,255,0.26)_44%,rgba(255,255,255,0.58))] dark:bg-[radial-gradient(circle_at_24%_18%,rgba(255,255,255,0.15),transparent_30%),radial-gradient(circle_at_72%_45%,rgba(255,255,255,0.08),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.02)_44%,rgba(255,255,255,0.06))]" />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/70 dark:bg-white/20" />
              <div className="relative z-10">
                <section className="px-4 pb-4 pt-4 sm:px-5 sm:pb-5 sm:pt-5">
                  <h3 className="text-[17px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Aspect Ratio</h3>
                  <div className="mt-4 grid grid-cols-5 gap-1.5 sm:gap-2" role="radiogroup" aria-label="Aspect ratio">
                  {IMAGE_ASPECT_RATIO_OPTIONS.map(option => {
                    if (option.value === "4:3" || option.value === "9:16") return null;
                    const selected = option.value === selectedImageAspectRatio;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          "group/ratio-option relative flex h-[58px] min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl text-center transition-all duration-200",
                          selected
                            ? "bg-zinc-950/[0.075] text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.80),0_12px_26px_-22px_rgba(15,23,42,0.55)] dark:bg-white/12 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_34px_-24px_rgba(255,255,255,0.35)]"
                            : "text-zinc-600 hover:bg-zinc-950/[0.045] hover:text-zinc-950 dark:text-white/68 dark:hover:bg-white/[0.07] dark:hover:text-white"
                        )}
                        onClick={() => setSelectedImageAspectRatio(option.value)}
                        title={`${option.label} ${option.ratio}`}
                      >
                        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_28%_5%,rgba(255,255,255,0.65),transparent_48%)] opacity-0 transition-opacity duration-200 group-hover/ratio-option:opacity-100 dark:bg-[radial-gradient(circle_at_28%_5%,rgba(255,255,255,0.20),transparent_48%)]" />
                        <span className="relative z-10 text-[13px] font-medium leading-none tabular-nums">{option.ratio}</span>
                        <span className="relative z-10 flex h-6 items-center justify-center">
                          <span
                            className={cn(
                              "rounded-[4px] border transition-all duration-200",
                              option.className,
                              selected
                                ? "border-zinc-950 bg-white/45 shadow-[0_0_0_3px_rgba(24,24,27,0.06)] dark:border-white dark:bg-white/8 dark:shadow-[0_0_0_3px_rgba(255,255,255,0.10)]"
                                : "border-zinc-500/65 bg-white/20 group-hover/ratio-option:border-zinc-800 dark:border-white/62 dark:bg-transparent dark:group-hover/ratio-option:border-white"
                            )}
                          />
                        </span>
                      </button>
                    )
                  })}
                  </div>
                  <button
                    type="button"
                    className="mt-4 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium leading-none text-zinc-600 transition-colors hover:text-zinc-950 dark:text-white/66 dark:hover:text-white"
                    aria-label="Ver todos los aspect ratios"
                  >
                    View All <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </section>

                <section className="border-t border-zinc-950/8 px-4 py-4 dark:border-white/10 sm:px-5 sm:py-5">
                  <h3 className="text-[17px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Quality</h3>
                  <div className="mt-4 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Image quality">
                    {IMAGE_QUALITY_OPTIONS.map(option => {
                      const selected = option === selectedImageQuality;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setSelectedImageQuality(option)}
                          className={cn(
                            "relative h-9 rounded-xl px-3 text-[14px] font-medium leading-none text-zinc-600 transition-all duration-200 hover:bg-zinc-950/[0.045] hover:text-zinc-950 dark:text-white/68 dark:hover:bg-white/[0.07] dark:hover:text-white",
                            selected && "bg-zinc-950/[0.075] text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_12px_24px_-22px_rgba(15,23,42,0.45)] dark:bg-white/13 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_12px_30px_-24px_rgba(255,255,255,0.55)]"
                          )}
                        >
                          {option}
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="border-t border-zinc-950/8 px-4 py-4 dark:border-white/10 sm:px-5 sm:py-5">
                  <h3 className="text-[17px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Number of Images</h3>
                  <div className="mt-4 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Number of images">
                    {IMAGE_COUNT_OPTIONS.map(option => {
                      const selected = option === selectedImageCount;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setSelectedImageCount(option)}
                          className={cn(
                            "h-9 min-w-9 rounded-xl px-3 text-[14px] font-medium leading-none text-zinc-600 transition-all duration-200 hover:bg-zinc-950/[0.045] hover:text-zinc-950 dark:text-white/68 dark:hover:bg-white/[0.07] dark:hover:text-white",
                            selected && "bg-zinc-950/[0.075] text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_12px_24px_-22px_rgba(15,23,42,0.45)] dark:bg-white/13 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_12px_30px_-24px_rgba(255,255,255,0.55)]"
                          )}
                        >
                          {option}
                        </button>
                      )
                    })}
                  </div>
                </section>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {isVoiceGenerationActive && (
        <>
          <div className="group/voice-liquid relative isolate flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-cyan-300/70 bg-cyan-100/88 px-3 text-[14px] font-semibold text-cyan-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_10px_28px_-22px_rgba(8,145,178,0.75)] backdrop-blur-xl transition-all duration-300 hover:scale-[1.01] hover:border-cyan-400/80 dark:border-cyan-500/40 dark:bg-cyan-900/25 dark:text-cyan-200">
            <span className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-[conic-gradient(from_90deg,transparent_0deg,rgba(34,211,238,0.0)_70deg,rgba(34,211,238,0.50)_135deg,rgba(6,182,212,0.24)_198deg,transparent_280deg)] opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/75 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/voice-liquid:translate-x-[155%] dark:via-white/25" />
            <AudioLines className="relative z-10 h-4 w-4 drop-shadow-[0_0_8px_rgba(8,145,178,0.35)]" />
            <span className="relative z-10">Voz</span>
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10 ml-1 h-5 w-5 rounded-full p-0 hover:bg-white/50 dark:hover:bg-cyan-800/30"
              onClick={handleVoiceGenerationClose}
              title="Cerrar voz"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {renderMediaModelPicker("voice", selectedVoiceModel, (name) => {
            setSelectedVoiceModel(name as VoiceModel);
            track("model.selected", { model: name, provider: name === "ElevenLabs" ? "ElevenLabs" : "Mimo", surface: "voice-tool-picker" });
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group/voice-trigger relative isolate h-8 shrink-0 gap-2 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-3 py-0 text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Voz: ${selectedVoiceModel}, ${selectedVoiceLanguage}, ${selectedVoiceAccent}, ${selectedVoiceStability}%`}
                aria-label={`Configurar voz. Actual ${selectedVoiceModel}, ${selectedVoiceLanguage}, estabilidad ${selectedVoiceStability} por ciento`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/voice-trigger:left-[92%] group-hover/voice-trigger:opacity-100 dark:via-white/20" />
                <Settings className="h-4 w-4" />
                <span>{selectedVoiceLanguage}</span>
                <span>{selectedVoiceStability}%</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="w-[min(calc(100vw-1rem),15.5rem)] overflow-hidden rounded-[14px] border border-zinc-200/70 bg-white/92 p-0 text-zinc-950 shadow-[0_16px_48px_-32px_rgba(15,23,42,0.55),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl dark:border-white/18 dark:bg-[#08090c]/96 dark:text-white dark:shadow-[0_22px_70px_-38px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.14)]"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_10%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_82%_36%,rgba(34,211,238,0.12),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.78),rgba(255,255,255,0.32)_45%,rgba(255,255,255,0.62))] dark:bg-[radial-gradient(circle_at_18%_8%,rgba(255,255,255,0.13),transparent_26%),radial-gradient(circle_at_82%_36%,rgba(34,211,238,0.16),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025)_45%,rgba(255,255,255,0.055))]" />
              <div className="relative z-10 py-1">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Modelo de voz</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedVoiceModel}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(18rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {VOICE_MODEL_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedVoiceModel(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedVoiceModel === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Language</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedVoiceLanguage}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(22rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {VOICE_LANGUAGE_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedVoiceLanguage(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedVoiceLanguage === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Accent</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedVoiceAccent}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(18rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {VOICE_ACCENT_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedVoiceAccent(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedVoiceAccent === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <div className="border-t border-zinc-950/8 px-2.5 py-2.5 dark:border-white/12">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium leading-none text-zinc-800 dark:text-white/90">Stability</span>
                      <Info className="h-3 w-3 text-zinc-500 dark:text-white/62" />
                    </div>
                    <span className="text-[10.5px] font-medium text-zinc-500 dark:text-white/72">{selectedVoiceStability}%</span>
                  </div>
                  <Slider
                    value={[selectedVoiceStability]}
                    onValueChange={([value]) => setSelectedVoiceStability(value)}
                    min={0}
                    max={100}
                    step={1}
                    className="mt-2"
                  />
                </div>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Effect</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedVoiceEffect}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(18rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {VOICE_EFFECT_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedVoiceEffect(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedVoiceEffect === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <div className="border-t border-zinc-950/8 px-2.5 py-1.5 text-[10.5px] font-medium text-zinc-600 dark:border-white/12 dark:text-white/80">
                  {selectedVoiceModel} / {selectedVoiceLanguage} / {selectedVoiceAccent} / {selectedVoiceEffect}
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {isMusicGenerationActive && (
        <>
          <div className="group/music-liquid relative isolate flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-rose-300/70 bg-rose-100/88 px-3 text-[14px] font-semibold text-rose-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_10px_28px_-22px_rgba(225,29,72,0.75)] backdrop-blur-xl transition-all duration-300 hover:scale-[1.01] hover:border-rose-400/80 dark:border-rose-500/40 dark:bg-rose-900/25 dark:text-rose-200">
            <span className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-[conic-gradient(from_90deg,transparent_0deg,rgba(244,63,94,0.0)_70deg,rgba(244,63,94,0.48)_135deg,rgba(225,29,72,0.22)_198deg,transparent_280deg)] opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/75 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/music-liquid:translate-x-[155%] dark:via-white/25" />
            <Music className="relative z-10 h-4 w-4 drop-shadow-[0_0_8px_rgba(225,29,72,0.35)]" />
            <span className="relative z-10">Música</span>
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10 ml-1 h-5 w-5 rounded-full p-0 hover:bg-white/50 dark:hover:bg-rose-800/30"
              onClick={handleMusicGenerationClose}
              title="Cerrar música"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {renderMediaModelPicker("music", selectedMusicModel, (name) => {
            setSelectedMusicModel(name as MusicModel);
            track("model.selected", { model: name, provider: name === "Lyria 3 Pro" ? "Google" : name === "ElevenLabs" ? "ElevenLabs" : "Mimo", surface: "music-tool-picker" });
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group/music-trigger relative isolate h-8 shrink-0 gap-2 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-3 py-0 text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Música: ${selectedMusicModel}, ${selectedMusicStyle}, ${selectedMusicMood}, ${selectedMusicDuration}s`}
                aria-label={`Configurar música. Actual ${selectedMusicModel}, ${selectedMusicStyle}, ${selectedMusicDuration} segundos`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/music-trigger:left-[92%] group-hover/music-trigger:opacity-100 dark:via-white/20" />
                <Settings className="h-4 w-4" />
                <span>{selectedMusicStyle}</span>
                <span>{selectedMusicDuration}s</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="w-[min(calc(100vw-1rem),15.5rem)] overflow-hidden rounded-[14px] border border-zinc-200/70 bg-white/92 p-0 text-zinc-950 shadow-[0_16px_48px_-32px_rgba(15,23,42,0.55),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl dark:border-white/18 dark:bg-[#08090c]/96 dark:text-white dark:shadow-[0_22px_70px_-38px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.14)]"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_10%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_82%_36%,rgba(244,63,94,0.12),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.78),rgba(255,255,255,0.32)_45%,rgba(255,255,255,0.62))] dark:bg-[radial-gradient(circle_at_18%_8%,rgba(255,255,255,0.13),transparent_26%),radial-gradient(circle_at_82%_36%,rgba(244,63,94,0.16),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025)_45%,rgba(255,255,255,0.055))]" />
              <div className="relative z-10 py-1">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Modelo de música</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedMusicModel}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(18rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {MUSIC_MODEL_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedMusicModel(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedMusicModel === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Style</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedMusicStyle}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(22rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {MUSIC_STYLE_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedMusicStyle(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedMusicStyle === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Mood</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedMusicMood}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(18rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {MUSIC_MOOD_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedMusicMood(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedMusicMood === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <div className="border-t border-zinc-950/8 px-2.5 py-2.5 dark:border-white/12">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium leading-none text-zinc-800 dark:text-white/90">Duration</span>
                      <Info className="h-3 w-3 text-zinc-500 dark:text-white/62" />
                    </div>
                    <span className="text-[10.5px] font-medium text-zinc-500 dark:text-white/72">{selectedMusicDuration}s</span>
                  </div>
                  <Slider
                    value={[selectedMusicDuration]}
                    onValueChange={([value]) => setSelectedMusicDuration(value)}
                    min={5}
                    max={30}
                    step={1}
                    className="mt-2"
                  />
                </div>

                <div className="border-t border-zinc-950/8 px-2.5 py-2.5 dark:border-white/12">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] font-medium leading-none text-zinc-800 dark:text-white/90">Prompt</span>
                    <span className="text-[10.5px] font-medium text-zinc-500 dark:text-white/72">{Math.round(selectedMusicInfluence * 100)}%</span>
                  </div>
                  <Slider
                    value={[selectedMusicInfluence]}
                    onValueChange={([value]) => setSelectedMusicInfluence(value)}
                    min={0}
                    max={1}
                    step={0.05}
                    className="mt-2"
                  />
                </div>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Effect</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62">{selectedMusicEffect}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="liquid-menu-surface max-h-[min(18rem,calc(100vh-2rem))] w-44 overflow-y-auto p-1">
                      {MUSIC_EFFECT_OPTIONS.map(option => (
                        <DropdownMenuItem key={option} className="chat-active-apps-menu-item text-[12px]" onClick={() => setSelectedMusicEffect(option)}>
                          <span className="min-w-0 flex-1 truncate">{option}</span>
                          {selectedMusicEffect === option && <Check className="h-3.5 w-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {isVideoGenerationActive && (
        <>
          <div className="group/video-liquid relative isolate flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-orange-300/70 bg-orange-100/88 px-3 text-[14px] font-semibold text-orange-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_10px_28px_-22px_rgba(234,88,12,0.75)] backdrop-blur-xl transition-all duration-300 hover:scale-[1.01] hover:border-orange-400/80 dark:border-orange-500/40 dark:bg-orange-900/25 dark:text-orange-200">
            <span className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-[conic-gradient(from_90deg,transparent_0deg,rgba(251,146,60,0.0)_70deg,rgba(251,146,60,0.52)_135deg,rgba(249,115,22,0.24)_198deg,transparent_280deg)] opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/75 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/video-liquid:translate-x-[155%] dark:via-white/25" />
            <Video className="relative z-10 h-4 w-4 drop-shadow-[0_0_8px_rgba(234,88,12,0.35)]" />
            <span className="relative z-10">Video</span>
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10 ml-1 h-5 w-5 rounded-full p-0 hover:bg-white/50 dark:hover:bg-orange-800/30"
              onClick={handleVideoGenerationClose}
              title="Cerrar video"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {renderMediaModelPicker("video", selectedVideoModel, (name, provider) => {
            setSelectedVideoModel(name);
            track("model.selected", { model: name, provider: provider || null, surface: "video-tool-picker" });
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group/video-trigger relative isolate h-8 shrink-0 gap-2 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-3 py-0 text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Video: ${selectedVideoAspectRatio}, ${selectedVideoResolution}, ${selectedVideoDuration}s, audio ${selectedVideoAudio ? "on" : "off"}`}
                aria-label={`Configurar video. Actual ${selectedVideoAspectRatio}, ${selectedVideoResolution}, ${selectedVideoDuration} segundos`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/video-trigger:left-[92%] group-hover/video-trigger:opacity-100 dark:via-white/20" />
                <Settings className="h-4 w-4" />
                <span>{selectedVideoAspectRatio}</span>
                <span>{selectedVideoResolution}</span>
                <span>{selectedVideoDuration}s</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="w-[min(calc(100vw-1rem),15.5rem)] overflow-hidden rounded-[14px] border border-zinc-200/70 bg-white/92 p-0 text-zinc-950 shadow-[0_16px_48px_-32px_rgba(15,23,42,0.55),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl dark:border-white/18 dark:bg-[#08090c]/96 dark:text-white dark:shadow-[0_22px_70px_-38px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.14)]"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_10%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_82%_36%,rgba(251,146,60,0.12),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.78),rgba(255,255,255,0.32)_45%,rgba(255,255,255,0.62))] dark:bg-[radial-gradient(circle_at_18%_8%,rgba(255,255,255,0.13),transparent_26%),radial-gradient(circle_at_82%_36%,rgba(251,146,60,0.16),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025)_45%,rgba(255,255,255,0.055))]" />
              <div className="relative z-10">
                <section className="px-2.5 pb-2.5 pt-2.5">
                  <h3 className="text-[12.5px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Resolution</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Video resolution">
                    {VIDEO_RESOLUTION_OPTIONS.map(option => {
                      const selected = option === selectedVideoResolution;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setSelectedVideoResolution(option)}
                          className={cn(
                            "h-6 rounded-md px-2.5 text-[11px] font-medium leading-none text-zinc-600 transition-all duration-200 hover:bg-zinc-950/[0.045] hover:text-zinc-950 dark:text-white/84 dark:hover:bg-white/[0.10] dark:hover:text-white",
                            selected && "bg-zinc-950/[0.075] text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_9px_18px_-16px_rgba(15,23,42,0.45)] dark:bg-white/18 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_1px_rgba(255,255,255,0.06)]"
                          )}
                        >
                          {option}
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="border-t border-zinc-950/8 px-2.5 py-2.5 dark:border-white/12">
                  <h3 className="text-[12.5px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Aspect Ratio</h3>
                  <div className="mt-2 grid grid-cols-5 gap-0.5" role="radiogroup" aria-label="Video aspect ratio">
                    {VIDEO_ASPECT_RATIO_OPTIONS.filter(option => showAllVideoRatios || option.visibleByDefault).map(option => {
                      const selected = option.value === selectedVideoAspectRatio;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setSelectedVideoAspectRatio(option.value)}
                          className={cn(
                            "group/video-ratio-option relative flex h-9 min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md text-center transition-all duration-200",
                            selected
                              ? "bg-zinc-950/[0.075] text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_9px_20px_-16px_rgba(15,23,42,0.55)] dark:bg-white/18 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_1px_rgba(255,255,255,0.06)]"
                              : "text-zinc-600 hover:bg-zinc-950/[0.045] hover:text-zinc-950 dark:text-white/84 dark:hover:bg-white/[0.10] dark:hover:text-white"
                          )}
                          title={`${option.label} ${option.ratio}`}
                        >
                          <span className="relative z-10 text-[10px] font-medium leading-none tabular-nums">{option.ratio}</span>
                          <span className="relative z-10 flex h-4 items-center justify-center scale-[0.78]">
                            {option.value === "auto" ? (
                              <span className={cn("grid h-5 w-5 place-items-center rounded-[5px] border transition-all duration-200", selected ? "border-zinc-950 bg-white/45 dark:border-white dark:bg-white/10" : "border-zinc-500/65 dark:border-white/68")}>
                                <Plus className="h-3.5 w-3.5" />
                              </span>
                            ) : (
                              <span className={cn("rounded-[4px] border transition-all duration-200", option.className, selected ? "border-zinc-950 bg-white/45 dark:border-white dark:bg-white/10" : "border-zinc-500/65 bg-white/20 dark:border-white/68 dark:bg-transparent")} />
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAllVideoRatios(value => !value)}
                    className="mt-2 inline-flex items-center gap-1 rounded-full text-[11px] font-medium leading-none text-zinc-600 transition-colors hover:text-zinc-950 dark:text-white/82 dark:hover:text-white"
                    aria-expanded={showAllVideoRatios}
                  >
                    {showAllVideoRatios ? "View Less" : "View All"} <ChevronDown className={cn("h-3 w-3 transition-transform", showAllVideoRatios && "rotate-180")} />
                  </button>
                </section>

                <section className="border-t border-zinc-950/8 px-2.5 py-2.5 dark:border-white/12">
                  <h3 className="text-[12.5px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Duration</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Video duration">
                    {VIDEO_DURATION_OPTIONS.filter(option => showAllVideoDurations || option <= 7).map(option => {
                      const selected = option === selectedVideoDuration;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setSelectedVideoDuration(option)}
                          className={cn(
                            "h-6 rounded-md px-2 text-[11px] font-medium leading-none text-zinc-600 transition-all duration-200 hover:bg-zinc-950/[0.045] hover:text-zinc-950 dark:text-white/84 dark:hover:bg-white/[0.10] dark:hover:text-white",
                            selected && "bg-zinc-950/[0.075] text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_9px_18px_-16px_rgba(15,23,42,0.45)] dark:bg-white/18 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_1px_rgba(255,255,255,0.06)]"
                          )}
                        >
                          {option}s
                        </button>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAllVideoDurations(value => !value)}
                    className="mt-2 inline-flex items-center gap-1 rounded-full text-[11px] font-medium leading-none text-zinc-600 transition-colors hover:text-zinc-950 dark:text-white/82 dark:hover:text-white"
                    aria-expanded={showAllVideoDurations}
                  >
                    {showAllVideoDurations ? "View Less" : "View All"} <ChevronDown className={cn("h-3 w-3 transition-transform", showAllVideoDurations && "rotate-180")} />
                  </button>
                </section>

                <section className="border-t border-zinc-950/8 px-2.5 py-2.5 dark:border-white/12">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[12.5px] font-semibold leading-none tracking-normal text-zinc-950 dark:text-white">Audio</h3>
                      <Info className="h-3 w-3 text-zinc-500 dark:text-white/72" />
                    </div>
                    <Switch checked={selectedVideoAudio} onCheckedChange={setSelectedVideoAudio} aria-label="Audio" />
                  </div>
                </section>

                <div className="border-t border-zinc-950/8 px-2.5 py-1.5 text-[10.5px] font-medium text-zinc-600 dark:border-white/12 dark:text-white/80">
                  {selectedVideoAspectRatio === "auto" ? "Auto" : selectedVideoAspectRatio} / {selectedVideoResolution} / {selectedVideoDuration}s / Audio {selectedVideoAudio ? "On" : "Off"}
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {isComputerUseActive && (
        <div className="flex items-center gap-1.5 bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 px-2 py-1 rounded-full text-xs border border-indigo-200 dark:border-indigo-800">
          <Monitor className="h-3 w-3" />
          <span className="font-medium">Computer Use</span>
          <div className={`h-2 w-2 rounded-full ml-1 ${computerUseStatus === 'running' ? 'bg-green-500 animate-pulse' :
            computerUseStatus === 'completed' ? 'bg-blue-500' :
              computerUseStatus === 'error' ? 'bg-red-500' : 'bg-gray-400'
            }`} />
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-indigo-200 dark:hover:bg-indigo-800/30 rounded-full ml-1"
            onClick={handleComputerUseClose}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {chatType === 'thesis' && (
        <div className="flex items-center gap-1.5 bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 px-2 py-1 rounded-full text-xs border border-purple-200 dark:border-purple-800">
          <BookOpen className="h-3 w-3" />
          <span className="font-medium">Generador de tesis</span>
          <div className="w-2 h-2 bg-purple-500 rounded-full ml-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 hover:bg-purple-200 dark:hover:bg-purple-800/30 rounded-full ml-1"
            onClick={handleThesisClose}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
};

// Enhanced Model Selector
let selectedVideoModelData;
const NavbarModelSelector = ({
  selectedModel,
  setSelectedModel,
  availableModels,
  setSelectedProvider,
  chatTypes,
  currentChat,
  setCurrentChat,
}: any) => {
  const selectedModelData = availableModels.find((m: any) => m.name === selectedModel);
  const [searchQuery, setSearchQuery] = React.useState("");

  // Keep the call sites intact for model changes, but the picker no
  // longer surfaces a separate "recent models" section.
  const recordRecent = (modelName: string) => {
    void modelName;
  };

  const pickModelForTier = React.useCallback((tier: "instant" | "thinking") => {
    const models = Array.isArray(availableModels) ? availableModels : [];
    const byName = (patterns: RegExp[]) => models.find((m: any) => {
      const label = `${m?.name || ""} ${m?.displayName || ""}`.toLowerCase();
      return patterns.some((pattern) => pattern.test(label));
    });

    if (tier === "instant") {
      return byName([
        /deepseek-v4-flash/,
        /gpt-4o-mini|gpt-5-mini/,
        /flash|fast|mini|haiku|lite|nano|turbo/,
      ]) || models[0];
    }

    return byName([
      /deepseek-v4-pro/,
      /\bgpt-5\b|gpt-4\.1|o[134]\b/,
      /thinking|reason|r1|pro|sonnet|opus|ultra|max/,
    ]) || models[0];
  }, [availableModels]);

  const applyGptModelTier = React.useCallback(async (tier: "instant" | "thinking") => {
    if (!currentChat?.id) return;
    const nextModel = pickModelForTier(tier);
    if (!nextModel?.name) {
      toast.error("No hay modelos disponibles");
      return;
    }

    setSelectedModel(nextModel.name);
    setSelectedProvider(nextModel.provider);
    recordRecent(nextModel.name);
    setCurrentChat?.((chat: any) => chat ? { ...chat, model: nextModel.name } : chat);

    try {
      await apiClient.updateChat(currentChat.id, { model: nextModel.name });
      toast.success(`Modelo actualizado: ${nextModel.displayName || nextModel.name}`);
    } catch (error) {
      toast.error("No se pudo actualizar el modelo del GPT");
    }
  }, [currentChat?.id, pickModelForTier, setCurrentChat, setSelectedModel, setSelectedProvider]);

  const startNewGptChat = React.useCallback(async () => {
    const gptId = currentChat?.customGpt?.id || currentChat?.customGptId;
    if (!gptId) return;
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null;
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/gpts/${gptId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.chat?.id) throw new Error(data?.error || "No se pudo crear el chat");
      localStorage.setItem("currentChatId", data.chat.id);
      window.location.href = `/chat?id=${data.chat.id}`;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo crear el chat");
    }
  }, [currentChat?.customGpt?.id, currentChat?.customGptId]);

  const copyGptLink = React.useCallback(async () => {
    const gpt = currentChat?.customGpt;
    const href = gpt?.shareId
      ? `${window.location.origin}/gpts/share/${gpt.shareId}`
      : `${window.location.origin}/chat?id=${currentChat?.id || ""}`;
    try {
      await navigator.clipboard.writeText(href);
      toast.success("Enlace copiado");
    } catch {
      toast.error("No se pudo copiar el enlace. Cópialo manualmente.");
    }
  }, [currentChat?.customGpt, currentChat?.id]);

  const selectedGptModel = React.useMemo(() => {
    const modelName = currentChat?.model || currentChat?.customGpt?.modelName || selectedModel;
    return availableModels.find((m: any) => m.name === modelName);
  }, [availableModels, currentChat?.customGpt?.modelName, currentChat?.model, selectedModel]);

  const gptAvailableModels = React.useMemo(() => {
    const models = Array.isArray(availableModels) ? availableModels : [];
    return models.filter((model: any) => String(model?.type || "TEXT").toUpperCase() === "TEXT");
  }, [availableModels]);

  const gptModelsByProvider = React.useMemo(() => {
    const order = ["OpenAI", "Anthropic", "Google", "Gemini", "DeepSeek", "xAI", "Groq", "OpenRouter"];
    const groups: Record<string, any[]> = {};
    for (const model of gptAvailableModels) {
      const provider = model?.provider || "Otros";
      (groups[provider] ||= []).push(model);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }, [gptAvailableModels]);

  const describeGptTier = React.useCallback((modelName: string) => {
    const label = String(modelName || "").toLowerCase();
    if (/deepseek-v4-pro|\bgpt-5\b|o[134]\b|thinking|reason|r1|pro|sonnet|opus|ultra|max/.test(label)) {
      return "Thinking";
    }
    return "Instant";
  }, []);

  const applyGptModel = React.useCallback(async (model: any) => {
    if (!currentChat?.id || !model?.name) return;

    setSelectedModel(model.name);
    setSelectedProvider(model.provider);
    recordRecent(model.name);
    setCurrentChat?.((chat: any) => chat ? { ...chat, model: model.name } : chat);
    // User-initiated model swap on a Custom GPT — distinguish from
    // the picker swap below via the `surface` property.
    track("model.selected", {
      model: model.name,
      provider: model.provider || null,
      surface: "gpt",
    });

    try {
      await apiClient.updateChat(currentChat.id, { model: model.name });
      toast.success(`Modelo actualizado: ${model.displayName || model.name}`);
    } catch {
      toast.error("No se pudo actualizar el modelo del GPT");
    }
  }, [currentChat?.id, setCurrentChat, setSelectedModel, setSelectedProvider]);

  const [gptDialog, setGptDialog] = React.useState<null | "about" | "feedback" | "rate" | "report">(null);
  const [projectDialog, setProjectDialog] = React.useState<null | "about">(null);
  const [gptFeedback, setGptFeedback] = React.useState("");
  const [gptReport, setGptReport] = React.useState("");
  const [gptRating, setGptRating] = React.useState(0);
  const [isGptPinned, setIsGptPinned] = React.useState(false);

  React.useEffect(() => {
    const gptId = currentChat?.customGpt?.id || currentChat?.customGptId;
    if (!gptId || typeof window === "undefined") {
      setIsGptPinned(false);
      return;
    }
    try {
      const pinned: string[] = JSON.parse(localStorage.getItem("sira:pinned-gpts") || "[]");
      setIsGptPinned(pinned.includes(gptId));
    } catch {
      setIsGptPinned(false);
    }
  }, [currentChat?.customGpt?.id, currentChat?.customGptId]);

  const togglePinGpt = React.useCallback(() => {
    const gptId = currentChat?.customGpt?.id || currentChat?.customGptId;
    if (!gptId || typeof window === "undefined") return;
    try {
      const pinned: string[] = JSON.parse(localStorage.getItem("sira:pinned-gpts") || "[]");
      const exists = pinned.includes(gptId);
      const next = exists ? pinned.filter((id) => id !== gptId) : [gptId, ...pinned];
      localStorage.setItem("sira:pinned-gpts", JSON.stringify(next));
      const metaKey = "sira:pinned-gpt-items";
      const existingMeta = JSON.parse(localStorage.getItem(metaKey) || "[]");
      const withoutCurrent = existingMeta.filter((item: any) => item?.id !== gptId);
      const nextMeta = exists
        ? withoutCurrent
        : [
            {
              id: gptId,
              name: currentChat?.customGpt?.name || "GPT",
              iconUrl: currentChat?.customGpt?.iconUrl || null,
              modelName: currentChat?.model || currentChat?.customGpt?.modelName || selectedModel,
            },
            ...withoutCurrent,
          ].slice(0, 12);
      localStorage.setItem(metaKey, JSON.stringify(nextMeta));
      window.dispatchEvent(new CustomEvent("siragpt:pinned-gpts-changed"));
      setIsGptPinned(!exists);
      toast.success(exists ? "GPT quitado de la barra lateral" : "GPT fijado en la barra lateral");
    } catch {
      toast.error("No se pudo actualizar el GPT fijado");
    }
  }, [currentChat?.customGpt?.id, currentChat?.customGptId, currentChat?.customGpt?.name, currentChat?.customGpt?.iconUrl, currentChat?.customGpt?.modelName, currentChat?.model, selectedModel]);

  const submitGptFeedback = React.useCallback((kind: "feedback" | "rate" | "report") => {
    const gptId = currentChat?.customGpt?.id || currentChat?.customGptId;
    const payload = {
      gptId,
      chatId: currentChat?.id,
      kind,
      rating: kind === "rate" ? gptRating : undefined,
      text: kind === "report" ? gptReport.trim() : gptFeedback.trim(),
      createdAt: new Date().toISOString(),
    };
    try {
      const key = "sira:gpt-actions";
      const existing = JSON.parse(localStorage.getItem(key) || "[]");
      localStorage.setItem(key, JSON.stringify([payload, ...existing].slice(0, 100)));
      toast.success(kind === "report" ? "Reporte guardado" : kind === "rate" ? "Valoración guardada" : "Comentarios guardados");
      setGptDialog(null);
      setGptFeedback("");
      setGptReport("");
      if (kind === "rate") setGptRating(0);
    } catch {
      toast.error("No se pudo guardar la acción");
    }
  }, [currentChat?.customGpt?.id, currentChat?.customGptId, currentChat?.id, gptFeedback, gptRating, gptReport]);

  const project = currentChat?.project;
  const projectName = project?.name || String(currentChat?.title || "Proyecto").replace(/^Chat in\s+/i, "");
  const activeProjectModelName = currentChat?.model || selectedModel;
  const selectedProjectModel = React.useMemo(() => {
    return availableModels.find((m: any) => m.name === activeProjectModelName);
  }, [availableModels, activeProjectModelName]);
  const projectCounts = project?._count || {
    files: project?.files?.length || 0,
    chats: 0,
    memories: 0,
    documents: project?.documents?.length || 0,
  };

  const applyProjectModel = React.useCallback(async (model: any) => {
    if (!currentChat?.id || !model?.name) return;
    setSelectedModel(model.name);
    setSelectedProvider(model.provider);
    recordRecent(model.name);
    setCurrentChat?.((chat: any) => chat ? { ...chat, model: model.name } : chat);

    try {
      await apiClient.updateChat(currentChat.id, { model: model.name });
      toast.success(`Modelo del proyecto actualizado: ${model.displayName || model.name}`);
    } catch {
      toast.error("No se pudo actualizar el modelo del proyecto");
    }
  }, [currentChat?.id, setCurrentChat, setSelectedModel, setSelectedProvider]);

  const startNewProjectChat = React.useCallback(async () => {
    const projectId = currentChat?.project?.id || currentChat?.projectId;
    if (!projectId) return;
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null;
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/projects/${projectId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          title: `Chat in ${projectName}`.slice(0, 120),
          model: activeProjectModelName,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.chat?.id) throw new Error(data?.error || "No se pudo crear el chat del proyecto");
      localStorage.setItem("currentChatId", data.chat.id);
      window.location.href = `/chat?id=${data.chat.id}`;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo crear el chat del proyecto");
    }
  }, [currentChat?.project?.id, currentChat?.projectId, projectName, activeProjectModelName]);

  const copyProjectLink = React.useCallback(async () => {
    const projectId = currentChat?.project?.id || currentChat?.projectId;
    if (!projectId) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/projects/${projectId}`);
      toast.success("Enlace del proyecto copiado");
    } catch {
      toast.error("No se pudo copiar el enlace del proyecto. Cópialo manualmente.");
    }
  }, [currentChat?.project?.id, currentChat?.projectId]);


  // If this is a video chat type, show video model
  if (chatTypes === "video") {
    const videoModels = (Array.isArray(availableModels) ? availableModels : [])
      .filter((model: any) => {
        const label = `${model?.name || ""} ${model?.displayName || ""} ${model?.provider || ""}`;
        return String(model?.type || "").toUpperCase() === "VIDEO" || /video|veo|kling|runway|pika|hailuo|luma/i.test(label);
      });
    selectedVideoModelData = videoModels.find((m: any) => m.name === selectedModel) || videoModels[0];

    // Filter video models based on search
    const filteredVideoModels = videoModels.filter((model) =>
      model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
      <DropdownMenu onOpenChange={(open) => {
        if (!open) setSearchQuery("");
      }}>
        <DropdownMenuTrigger className="chat-model-trigger flex items-center gap-2 px-3 py-2 rounded-md bg-background hover:bg-muted transition">
          <Video className="h-4 w-4" />
          <span className="chat-model-label text-sm font-medium truncate">{selectedVideoModelData?.displayName || 'Select Video Model'}</span>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-500 rounded-full" title="API Key configured" />
            <ChevronDown className="h-4 w-4 opacity-70" />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[calc(100vw-1.5rem)] p-0 sm:w-56">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar modelos…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
          <ScrollArea className="h-[250px]">
            <div className="p-1">
              {filteredVideoModels.length > 0 ? (
                filteredVideoModels.map((model: any) => (
                  <DropdownMenuItem
                    key={model.name}
                    onSelect={() => {
                      setSelectedModel(model.name);
                      setSearchQuery("");
                      // Video model swap — separate surface so video-
                      // specific funnels stay distinct from text models.
                      track("model.selected", {
                        model: model.name,
                        provider: (model as any).provider || null,
                        surface: "video-picker",
                      });
                    }}
                    className="flex items-center gap-2 py-2"
                  >
                    <Video className="h-5 w-5 flex-shrink-0" />
                    <div className="flex flex-col flex-1">
                      <span className="text-sm">{model.displayName}</span>
                    </div>
                  </DropdownMenuItem>
                ))
              ) : (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No models found
                </div>
              )}
            </div>
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }



  if ((currentChat?.projectId || currentChat?.project) && !(currentChat?.customGptId || currentChat?.customGpt)) {
    const activeModelLabel = selectedProjectModel?.displayName || activeProjectModelName || "Modelo";

    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "chat-context-trigger group/project inline-flex h-11 max-w-[360px] items-center gap-2 rounded-2xl px-3",
              "bg-emerald-500/10 text-foreground hover:bg-emerald-500/15",
              "text-[15px] font-semibold tracking-tight",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "data-[state=open]:bg-emerald-500/15",
            )}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <FolderOpen className="h-4 w-4" />
            </span>
            <span className="min-w-0 truncate">{projectName}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-55 transition-transform duration-200 group-data-[state=open]/project:rotate-180" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} className="w-[calc(100vw-1.5rem)] overflow-hidden rounded-3xl border-border/70 p-2 shadow-2xl sm:w-[342px]">
            <div className="mb-1 flex items-center gap-3 rounded-2xl px-2 py-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <FolderOpen className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{projectName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeModelLabel} · {projectCounts.files} archivos · {projectCounts.documents} docs
                </div>
              </div>
            </div>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="h-12 rounded-2xl px-3 text-[15px]">
                <div className="flex items-center gap-3">
                  <Settings className="h-4 w-4" />
                  <span>Modelo</span>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent sideOffset={10} className="w-[360px] rounded-3xl border-border/70 p-2 shadow-2xl">
                  <div className="px-3 pb-2 pt-1 text-[13px] font-medium text-muted-foreground">
                    Modelos disponibles para este proyecto
                  </div>
                  <ScrollArea className="h-[420px] pr-1">
                    {gptModelsByProvider.length > 0 ? (
                      <div className="space-y-2">
                        {gptModelsByProvider.map(([provider, models]) => (
                          <div key={provider}>
                            <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                              {provider} · {models.length}
                            </div>
                            <div className="space-y-0.5">
                              {models.map((model: any) => {
                                const isActive = model.name === activeProjectModelName;
                                const tier = describeGptTier(model.name || model.displayName);
                                return (
                                  <DropdownMenuItem
                                    key={model.name}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      applyProjectModel(model);
                                    }}
                                    className={cn("rounded-2xl px-3 py-2.5", isActive && "bg-muted/70")}
                                  >
                                    <IconProvider name={resolveModelIconName(model)} className="mr-2 h-5 w-5 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-[14px] font-medium">{model.displayName || model.name}</div>
                                      <div className="truncate text-xs text-muted-foreground">{tier} · {model.name}</div>
                                    </div>
                                    {isActive && <Check className="ml-2 h-4 w-4 shrink-0" />}
                                  </DropdownMenuItem>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No hay modelos disponibles
                      </div>
                    )}
                  </ScrollArea>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>

            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); startNewProjectChat(); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <PenSquare className="mr-3 h-5 w-5" />
              Nuevo chat en proyecto
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setProjectDialog("about"); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <Info className="mr-3 h-5 w-5" />
              Instrucciones y contexto
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                const projectId = currentChat?.project?.id || currentChat?.projectId;
                if (projectId) window.location.href = `/projects/${projectId}`;
              }}
              className="h-12 rounded-2xl px-3 text-[15px]"
            >
              <FolderOpen className="mr-3 h-5 w-5" />
              Abrir proyecto
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); copyProjectLink(); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <Link2 className="mr-3 h-5 w-5" />
              Copiar enlace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog open={projectDialog !== null} onOpenChange={(open) => !open && setProjectDialog(null)}>
          <DialogContent className="max-w-md rounded-3xl">
            <DialogHeader>
              <DialogTitle>{projectName}</DialogTitle>
              <DialogDescription>
                Este chat usa instrucciones, archivos, documentos y memoria aislados del proyecto.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-2xl border border-border/60 p-3">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Archivos</div>
                  <div className="mt-1 text-lg font-semibold">{projectCounts.files}</div>
                </div>
                <div className="rounded-2xl border border-border/60 p-3">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Documentos</div>
                  <div className="mt-1 text-lg font-semibold">{projectCounts.documents}</div>
                </div>
              </div>
              <div className="rounded-2xl border border-border/60 p-3">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Modelo activo</div>
                <div className="mt-1 font-medium">{activeModelLabel}</div>
              </div>
              <div className="rounded-2xl border border-border/60 p-3">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Instrucciones</div>
                <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">
                  {project?.instructions || "Sin instrucciones configuradas."}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setProjectDialog(null)}>Cerrar</Button>
              {(currentChat?.project?.id || currentChat?.projectId) && (
                <Button onClick={() => { window.location.href = `/projects/${currentChat?.project?.id || currentChat?.projectId}` }}>
                  Abrir proyecto
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // If this chat is associated with a custom GPT, show GPT info instead of model selector
  if (currentChat?.customGptId || currentChat?.customGpt) {
    const customGpt = currentChat?.customGpt;
    const customGptName = customGpt?.name || String(currentChat?.title || "Custom GPT").replace(/^Chat with\s+/i, "");
    const customGptIcon = customGpt?.iconUrl;
    const activeModelLabel = selectedGptModel?.displayName || currentChat?.model || customGpt?.modelName || selectedModel || "Modelo";
    const activeModelName = currentChat?.model || customGpt?.modelName || selectedModel;

    const GptIcon = () => customGptIcon ? (
      customGptIcon.startsWith('http') || customGptIcon.startsWith('https') || customGptIcon.startsWith('data:') ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={customGptIcon}
          alt="GPT icon"
          className="h-7 w-7 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 text-sm text-white">
          {customGptIcon}
        </div>
      )
    ) : (
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300">
        <Bot className="h-4 w-4" />
      </div>
    );

    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "chat-context-trigger group/gpt inline-flex h-11 max-w-[360px] items-center gap-2 rounded-2xl px-3",
              "bg-muted/50 text-foreground hover:bg-muted",
              "text-[15px] font-semibold tracking-tight",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "data-[state=open]:bg-muted",
            )}
          >
            <GptIcon />
            <span className="min-w-0 truncate">{customGptName}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-55 transition-transform duration-200 group-data-[state=open]/gpt:rotate-180" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} className="w-[calc(100vw-1.5rem)] overflow-hidden rounded-3xl border-border/70 p-2 shadow-2xl sm:w-[328px]">
            <div className="mb-1 flex items-center gap-3 rounded-2xl px-2 py-2">
              <GptIcon />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{customGptName}</div>
                <div className="truncate text-xs text-muted-foreground">{activeModelLabel}</div>
              </div>
            </div>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="h-12 rounded-2xl px-3 text-[15px]">
                <div className="flex items-center gap-3">
                  <Settings className="h-4 w-4" />
                  <span>Modelo</span>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent sideOffset={10} className="w-[360px] rounded-3xl border-border/70 p-2 shadow-2xl">
                  <div className="px-3 pb-2 pt-1 text-[13px] font-medium text-muted-foreground">
                    Todos los modelos disponibles
                  </div>
                  <ScrollArea className="h-[420px] pr-1">
                    {gptModelsByProvider.length > 0 ? (
                      <div className="space-y-2">
                        {gptModelsByProvider.map(([provider, models]) => (
                          <div key={provider}>
                            <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                              {provider} · {models.length}
                            </div>
                            <div className="space-y-0.5">
                              {models.map((model: any) => {
                                const isActive = model.name === activeModelName;
                                const tier = describeGptTier(model.name || model.displayName);
                                return (
                                  <DropdownMenuItem
                                    key={model.name}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      applyGptModel(model);
                                    }}
                                    className={cn(
                                      "rounded-2xl px-3 py-2.5",
                                      isActive && "bg-muted/70",
                                    )}
                                  >
                                    <IconProvider name={resolveModelIconName(model)} className="mr-2 h-5 w-5 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-[14px] font-medium">{model.displayName || model.name}</div>
                                      <div className="truncate text-xs text-muted-foreground">{tier} · {model.name}</div>
                                    </div>
                                    {isActive && <Check className="ml-2 h-4 w-4 shrink-0" />}
                                  </DropdownMenuItem>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No hay modelos disponibles
                      </div>
                    )}
                  </ScrollArea>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      if (customGpt?.id) window.location.href = `/gpts/create?edit=${customGpt.id}`;
                    }}
                    className="rounded-2xl px-3 py-3 text-[15px]"
                  >
                    Configurar GPT...
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>

            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); startNewGptChat(); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <PenSquare className="mr-3 h-5 w-5" />
              Nuevo chat
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("about"); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <Info className="mr-3 h-5 w-5" />
              Acerca de
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                if (customGpt?.id) window.location.href = `/gpts/create?edit=${customGpt.id}`;
              }}
              className="h-12 rounded-2xl px-3 text-[15px]"
            >
              <Lock className="mr-3 h-5 w-5" />
              Configuración de privacidad
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); togglePinGpt(); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <Pin className="mr-3 h-5 w-5" />
              {isGptPinned ? "Quitar de la barra lateral" : "Mantener en la barra lateral"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); copyGptLink(); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <Link2 className="mr-3 h-5 w-5" />
              Copiar enlace
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("feedback"); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <MessageCircle className="mr-3 h-5 w-5" />
              Enviar comentarios
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("rate"); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <MessageSquare className="mr-3 h-5 w-5" />
              Valorar GPT
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("report"); }} className="h-12 rounded-2xl px-3 text-[15px]">
              <Flag className="mr-3 h-5 w-5" />
              Denunciar GPT
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog open={gptDialog !== null} onOpenChange={(open) => !open && setGptDialog(null)}>
          <DialogContent className="max-w-md rounded-3xl">
            {gptDialog === "about" && (
              <>
                <DialogHeader>
                  <DialogTitle>{customGptName}</DialogTitle>
                  <DialogDescription>
                    {customGpt?.description || "GPT personalizado configurado en siraGPT."}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 text-sm">
                  <div className="rounded-2xl border border-border/60 p-3">
                    <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Modelo activo</div>
                    <div className="mt-1 font-medium">{activeModelLabel}</div>
                  </div>
                  <div className="rounded-2xl border border-border/60 p-3">
                    <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Instrucciones</div>
                    <div className="mt-1 max-h-32 overflow-auto text-muted-foreground">{customGpt?.instructions || "Sin instrucciones visibles."}</div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setGptDialog(null)}>Cerrar</Button>
                  {customGpt?.id && <Button onClick={() => { window.location.href = `/gpts/create?edit=${customGpt.id}` }}>Configurar</Button>}
                </DialogFooter>
              </>
            )}

            {gptDialog === "feedback" && (
              <>
                <DialogHeader>
                  <DialogTitle>Enviar comentarios</DialogTitle>
                  <DialogDescription>Deja una nota sobre la calidad o comportamiento de este GPT.</DialogDescription>
                </DialogHeader>
                <Textarea value={gptFeedback} onChange={(event) => setGptFeedback(event.target.value)} placeholder="Escribe tus comentarios..." className="min-h-28" />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setGptDialog(null)}>Cancelar</Button>
                  <Button onClick={() => submitGptFeedback("feedback")} disabled={!gptFeedback.trim()}>Guardar</Button>
                </DialogFooter>
              </>
            )}

            {gptDialog === "rate" && (
              <>
                <DialogHeader>
                  <DialogTitle>Valorar GPT</DialogTitle>
                  <DialogDescription>Selecciona una valoración para este GPT.</DialogDescription>
                </DialogHeader>
                <div className="flex items-center justify-center gap-2 py-2">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setGptRating(value)}
                      className={cn(
                        "flex h-11 w-11 items-center justify-center rounded-full border text-lg transition",
                        gptRating >= value ? "border-amber-400 bg-amber-50 text-amber-600" : "border-border text-muted-foreground hover:bg-muted",
                      )}
                      aria-label={`${value} estrellas`}
                    >
                      ★
                    </button>
                  ))}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setGptDialog(null)}>Cancelar</Button>
                  <Button onClick={() => submitGptFeedback("rate")} disabled={gptRating === 0}>Guardar valoración</Button>
                </DialogFooter>
              </>
            )}

            {gptDialog === "report" && (
              <>
                <DialogHeader>
                  <DialogTitle>Denunciar GPT</DialogTitle>
                  <DialogDescription>Describe el problema para dejarlo registrado localmente.</DialogDescription>
                </DialogHeader>
                <Textarea value={gptReport} onChange={(event) => setGptReport(event.target.value)} placeholder="Describe el problema..." className="min-h-28" />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setGptDialog(null)}>Cancelar</Button>
                  <Button variant="destructive" onClick={() => submitGptFeedback("report")} disabled={!gptReport.trim()}>Guardar reporte</Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // Stable provider order. Unknown providers fall to the end alphabetically.
  const providerOrder = ["OpenAI", "Anthropic", "Google", "Gemini", "DeepSeek", "xAI", "Groq", "OpenRouter"];
  const groupByProvider = (models: any[]): Array<[string, any[]]> => {
    const groups: Record<string, any[]> = {};
    for (const m of models) {
      const p = m.provider || "Otros";
      (groups[p] ||= []).push(m);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      const ia = providerOrder.indexOf(a); const ib = providerOrder.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  };

  // Filter models based on search query
  const filteredModels = availableModels.filter((model: any) =>
    model.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.provider?.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const grouped = groupByProvider(filteredModels);

  const onPick = (model: any) => {
    setSelectedModel(model.name);
    setSelectedProvider(model.provider);
    recordRecent(model.name);
    setSearchQuery("");
    // Main model-picker funnel event. Programmatic model swaps
    // (auto-fallback, pickModelForTier, etc.) intentionally do NOT
    // emit — only direct user picks do. Dashboards can compare
    // surface=picker vs surface=gpt to see how much of model
    // churn comes from the dropdown vs Custom-GPT navigation.
    track("model.selected", {
      model: model.name,
      provider: model.provider || null,
      surface: "picker",
    });
  };

  // ModelRow — single picker entry. Active state = subtle bg + Check on
  // the right; rows stay one-line and restrained for fast scanning.
  const ModelRow = ({ model }: { model: any }) => {
    const isSelected = model.name === selectedModel;
    const iconName = resolveModelIconName(model);
    const label = model.displayName || model.name;
    return (
      <DropdownMenuItem
        onSelect={() => onPick(model)}
        className={cn(
          "group/row flex min-h-10 items-center gap-3 rounded-lg px-2.5 py-2 cursor-pointer",
          "text-foreground/90 focus:bg-muted/45 data-[highlighted]:bg-muted/45",
          isSelected && "bg-muted/35 text-foreground",
        )}
      >
        <span className="chat-model-icon inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <IconProvider name={iconName} size={20} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-5 tracking-[-0.005em]">
          {label}
        </span>
        {isSelected && (
          <Check className="h-4 w-4 shrink-0 text-foreground/80" strokeWidth={2.25} />
        )}
      </DropdownMenuItem>
    );
  };

  // Default model selector for regular chats
  return (
    <DropdownMenu onOpenChange={(open) => {
      if (!open) setSearchQuery("");
    }}>
      {/* Model selector trigger — h-10, medium weight, subtle surface.
          The always-on red dot was removed: it was a dead indicator
          (every model showed "API Key required" regardless of state),
          which is visual noise and contradicts the premium target. */}
      <DropdownMenuTrigger
        className={cn(
          "chat-model-trigger group/model inline-flex h-10 items-center gap-2 rounded-xl px-3",
          "bg-transparent text-foreground",
          "border border-transparent",
          "text-[13.5px] font-semibold tracking-tight",
          "transition-[background-color,border-color,color] duration-base ease-smooth",
          "hover:bg-muted/45 hover:border-border/40",
          "active:scale-[0.985]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "data-[state=open]:bg-muted/55 data-[state=open]:border-border/50",
        )}
      >
        {selectedModelData && (
          <span className="chat-model-icon inline-flex h-4 w-4 shrink-0 items-center justify-center">
            <IconProvider name={resolveModelIconName(selectedModelData)} size={16} />
          </span>
        )}
        <span className="chat-model-label max-w-[180px] truncate font-medium">{selectedModelData?.displayName || selectedModel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-55 transition-transform duration-200 group-data-[state=open]/model:rotate-180" strokeWidth={2} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={6} collisionPadding={12} className="w-[calc(100vw-1.5rem)] p-0 overflow-hidden rounded-xl border-border/60 shadow-lg sm:w-[340px]">
        <div className="border-b border-border/50 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              placeholder="Buscar modelos"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 rounded-lg border-border/45 bg-background pl-8 text-[13px] shadow-none focus-visible:border-border/70 focus-visible:ring-1 focus-visible:ring-border/60 focus-visible:ring-offset-0"
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>

        <ScrollArea className="chat-model-menu-scroll h-[min(70dvh,440px)]">
          {/* Provider-grouped sections. */}
          {grouped.length > 0 ? (
            <div className="px-1.5 py-2">
              {grouped.map(([provider, models]) => (
                <div key={provider} className="mt-3 first:mt-0">
                  <div className="flex items-center px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/55">
                    <span>{provider}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {models.map((m: any) => (
                      <ModelRow key={m.name} model={m} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-10 text-center text-[12.5px] text-muted-foreground">
              {searchQuery ? "Sin coincidencias" : "Sin modelos disponibles"}
            </div>
          )}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default function ChatInterface() {
  return <ChatInterfaceContent />
}

function ChatInterfaceContent() {
  const tComposer = useTranslations("composer")
  const { active: activeArtifact } = useArtifactPanel()
  const { user } = useAuth()

  const {
    currentChat,
    setCurrentChat,
    addMessage,
    addVideoMessage,
    addThesisMessage,
    clearCurrentChat,
    selectedModel,
    createNewChat,
    setSelectedModel,
    setSelectedProivder,
    selectProvider,
    uploadedFiles,
    selectChat,
    setUploadedFiles,
    chatType, setChatType,
    availableModels, regenerateLastMessage, regenerateMessage,
    editAndRegenerate,
    updateMessageInChat,
    activeStreamingChatIds,
    pendingStop, // Add pendingStop state
    stopStreaming,

  } = useChat()

  const [input, setInput] = React.useState("")
  const currentChatId = currentChat?.id ?? null
  const currentChatIdRef = React.useRef<string | null>(null)
  React.useEffect(() => { currentChatIdRef.current = currentChatId }, [currentChatId])
  const isCurrentChatStreaming = Boolean(currentChatId && activeStreamingChatIds.includes(currentChatId))
  const isCurrentChatLoading = isCurrentChatStreaming
  // Per-chat draft persistence. The composer's text is saved (debounced)
  // to localStorage scoped by chatId and restored when the user comes
  // back to the same conversation after a reload or accidental
  // navigation. See hooks/use-chat-draft.ts for the contract.
  const chatDraft = useChatDraft(currentChat?.id, user?.id)
  const lastRestoredChatIdRef = React.useRef<string | null>(null)
  const [isRecording, setIsRecording] = React.useState(false)
  const [isDictationTranscribing, setIsDictationTranscribing] = React.useState(false)
  const inputRef = React.useRef("")
  const dictationBaseRef = React.useRef("")
  const dictationFinalRef = React.useRef("")
  const dictationInterimRef = React.useRef("")
  const dictationAudioChunksRef = React.useRef<Blob[]>([])
  const dictationMediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const dictationModeRef = React.useRef<"idle" | "native" | "recorder">("idle")
  const dictationPermissionReadyRef = React.useRef(false)
  const dictationNativeFallbackStartedRef = React.useRef(false)
  const dictationShouldTranscribeRecordingRef = React.useRef(false)
  const [searchActivities, setSearchActivities] = React.useState<Record<string, SearchActivityState>>({})
  const [activeSearchActivityId, setActiveSearchActivityId] = React.useState<string | null>(null)

  // Project launcher prefill — when a user starts a chat from the
  // project detail page, their typed draft is stashed under
  // "project-prefill:<chatId>" in sessionStorage. We read it once the
  // chat is loaded here and move it into the composer input so they
  // don't lose their draft crossing the boundary between pages. We
  // deliberately do NOT auto-send — the user might want to edit
  // before firing off the prompt.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (!currentChat?.id) return
    const key = `project-prefill:${currentChat.id}`
    try {
      const draft = sessionStorage.getItem(key)
      if (draft) {
        setInput(prev => prev.trim() ? prev : draft)
        sessionStorage.removeItem(key)
      }
    } catch {
      /* private-mode / blocked storage — harmless */
    }
  }, [currentChat?.id])

  // Restore a previously saved composer draft when entering a chat.
  // Runs AFTER the project-prefill effect so an explicit project draft
  // still wins. Each chat id is restored at most once per mount; further
  // typing is captured by handleTextareaChange below.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const id = currentChat?.id
    if (!id) return
    if (lastRestoredChatIdRef.current === id) return
    lastRestoredChatIdRef.current = id
    const saved = chatDraft.loadInitial()
    if (saved && saved.trim()) {
      setInput(prev => (prev.trim() ? prev : saved))
    }
  }, [currentChat?.id, chatDraft])
  const [isSearching, setIsSearching] = React.useState(false)
  const [showInstructions, setShowInstructions] = React.useState(false)
  const [isGeneratingImage, setIsGeneratingImage] = React.useState(false)
  const [selectedImageAspectRatio, setSelectedImageAspectRatio] = React.useState<ImageAspectRatio>("1:1")
  const [selectedImageQuality, setSelectedImageQuality] = React.useState<ImageQuality>("2K")
  const [selectedImageCount, setSelectedImageCount] = React.useState<ImageGenerationCount>(1)
  const [selectedImageModel, setSelectedImageModel] = React.useState(DEFAULT_IMAGE_MODEL)
  const [isVoiceGenerationActive, setIsVoiceGenerationActive] = React.useState(false)
  const [selectedVoiceModel, setSelectedVoiceModel] = React.useState<VoiceModel>("ElevenLabs")
  const [selectedVoiceLanguage, setSelectedVoiceLanguage] = React.useState<VoiceLanguage>("Spanish")
  const [selectedVoiceAccent, setSelectedVoiceAccent] = React.useState<VoiceAccent>("Latino")
  const [selectedVoiceStability, setSelectedVoiceStability] = React.useState(100)
  const [selectedVoiceEffect, setSelectedVoiceEffect] = React.useState<VoiceEffect>("Studio Clean")
  const [isMusicGenerationActive, setIsMusicGenerationActive] = React.useState(false)
  const [selectedMusicModel, setSelectedMusicModel] = React.useState<MusicModel>("ElevenLabs")
  const [selectedMusicStyle, setSelectedMusicStyle] = React.useState<MusicStyle>("Auto")
  const [selectedMusicMood, setSelectedMusicMood] = React.useState<MusicMood>("Balanced")
  const [selectedMusicDuration, setSelectedMusicDuration] = React.useState(10)
  const [selectedMusicInfluence, setSelectedMusicInfluence] = React.useState(0.3)
  const [selectedMusicEffect, setSelectedMusicEffect] = React.useState<MusicEffect>("Studio Master")
  const [selectedVideoResolution, setSelectedVideoResolution] = React.useState<VideoResolution>("720p")
  const [selectedVideoAspectRatio, setSelectedVideoAspectRatio] = React.useState<VideoAspectRatio>("auto")
  const [selectedVideoDuration, setSelectedVideoDuration] = React.useState<VideoDuration>(5)
  const [selectedVideoAudio, setSelectedVideoAudio] = React.useState(true)
  const [selectedVideoModel, setSelectedVideoModel] = React.useState(DEFAULT_VIDEO_MODEL)
  const imageAbortControllerRef = React.useRef<AbortController | null>(null)
  const isGeneratingImageRef = React.useRef(false)
  const [isGeneratingVideo, setIsGeneratingVideo] = React.useState(false)
  const [isGeneratingPPT, setIsGeneratingPPT] = React.useState(false)
  const [isGeneratingWebDev, setIsGeneratingWebDev] = React.useState(false)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatCreationInitiated = React.useRef(false);
  const prevChatIdRef = React.useRef<string | undefined>();
  // Mirror of `uploadedFiles` for use inside async/event handlers that
  // outlive the render closure (paste listener, drop handler, etc.) —
  // reading from state directly would capture stale values.
  const uploadedFilesRef = React.useRef<any[]>([]);
  React.useEffect(() => { uploadedFilesRef.current = uploadedFiles; }, [uploadedFiles]);

  const handlePasteCaptureActionRef = React.useRef<(action: PasteCaptureAction, result: PasteCaptureResult) => void>(() => {})

  const handlePasteCaptureAction = React.useCallback(
    (action: PasteCaptureAction, result: PasteCaptureResult) => {
      handlePasteCaptureActionRef.current(action, result)
    },
    []
  )

  const pasteCapture = usePasteCapture(handlePasteCaptureAction);
  const capturePastedText = pasteCapture.capture;
  const pasteCapturePendingRef = React.useRef<PasteCaptureResult | null>(null);
  React.useEffect(() => {
    pasteCapturePendingRef.current = pasteCapture.captureResult;
  }, [pasteCapture.captureResult]);

  React.useEffect(() => {
    const onImageRegionEdit = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (!detail.fileId || !detail.imageUrl) {
        toast.error("No se pudo preparar la imagen para edición.");
        return;
      }

      const region = detail.region || {};
      const regionText = [
        `x ${Math.round(region.x || 0)}%`,
        `y ${Math.round(region.y || 0)}%`,
        `ancho ${Math.round(region.width || 0)}%`,
        `alto ${Math.round(region.height || 0)}%`,
      ].join(", ");

      setIsImageGenerationActive(true);
      setChatType("image");
      if (IMAGE_ASPECT_RATIO_OPTIONS.some(option => option.value === detail.aspectRatio)) {
        setSelectedImageAspectRatio(detail.aspectRatio);
      }
      setSelectedImageQuality("2K");
      setSelectedImageCount(1);
      setUploadedFiles([{
        id: detail.fileId,
        fileId: detail.fileId,
        name: "Zona marcada para editar",
        originalName: "Zona marcada para editar",
        type: "image/png",
        mimeType: "image/png",
        url: detail.imageUrl,
        preview: detail.imageUrl,
        status: "ready",
        editRegion: detail.region,
      }]);
      setInput(prev => {
        if (prev.trim()) return prev;
        return `Edita solo la zona marcada (${regionText}): `;
      });
      setTimeout(() => textareaRef.current?.focus(), 0);
    };

    window.addEventListener("siragpt:image-region-edit", onImageRegionEdit);
    return () => window.removeEventListener("siragpt:image-region-edit", onImageRegionEdit);
  }, [setUploadedFiles, setChatType]);

  // "Reuse-in-prompt" bridge — UnifiedDocumentViewer dispatches a
  // CustomEvent on the window when the user clicks the Reply icon in
  // the viewer header. We re-attach the file metadata to the composer's
  // upload list (without re-uploading the binary; the backend `id` is
  // already permanent), and surface a toast so the action is visible.
  // Idempotent: if the same file id is already in the list, we no-op.
  React.useEffect(() => {
    const onReuse = (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {};
      if (!detail.id) return;
      const already = uploadedFilesRef.current.some((f: any) => (f.id || f.tempId) === detail.id);
      if (already) {
        toast(`"${detail.name}" ya está adjunto al prompt`);
        return;
      }
      const reused = {
        id: detail.id,
        tempId: detail.id,
        name: detail.name,
        type: detail.mimeType,
        size: detail.size ?? 0,
        url: detail.url,
        extractedText: detail.extractedText,
        status: 'completed',
      };
      setUploadedFiles((cur: any[]) => [...cur, reused]);
      toast.success(`Adjuntado "${detail.name}" al prompt`);
    };
    window.addEventListener('sira:reuse-attachment', onReuse);
    return () => window.removeEventListener('sira:reuse-attachment', onReuse);
  }, [setUploadedFiles]);
  // True while the IME is composing a multi-keystroke character (CJK,
  // Spanish accents, dead keys). Paste handler must NOT intercept paste
  // during composition or it scrambles the in-flight character.
  const isComposingRef = React.useRef(false);

  // Auto-scroll to bottom function
  const scrollToBottom = React.useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        // Use setTimeout to ensure the DOM has updated before scrolling
        setTimeout(() => {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }, 0);
      }
    }
  }, []);

  // Scroll to bottom only when the chat is changed
  React.useEffect(() => {
    scrollToBottom();
    // scrollToBottom is a stable ref that scrolls the Virtuoso viewport;
    // intentionally scoped to fire on chat-id change only, not on
    // function-identity change (would re-scroll on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat?.id]);

  // Virtualization: hand Virtuoso the existing Radix scroll viewport so
  // the custom scrollbar + scrollToBottom helper above keep working
  // unchanged. Only items in the visible window are reconciled, which
  // is the actual bottleneck on long chats (MessageComponent itself is
  // already React.memo'd). The ref resolves on first paint, so the
  // very first render of a long chat falls back to a plain map (one
  // tick of full-list reconciliation, then Virtuoso owns it).
  const [radixViewport, setRadixViewport] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!scrollAreaRef.current) return;
    const viewport = scrollAreaRef.current.querySelector(
      '[data-radix-scroll-area-viewport]'
    ) as HTMLElement | null;
    if (viewport) setRadixViewport(viewport);
  }, [currentChat?.id]);

  // ── Scroll-to-bottom pill ────────────────────────────────────────
  // Tracks whether the user is currently at the bottom of the message
  // list. If they scroll up (e.g. to read history while a long answer
  // is streaming) we surface a floating pill above the composer that
  // jumps back to the latest message on click — the same affordance
  // ChatGPT / Claude use. Threshold of 96px keeps the pill from
  // appearing on micro-scrolls (single-line keystroke jitter).
  const [isAtBottom, setIsAtBottom] = React.useState(true);
  React.useEffect(() => {
    if (!radixViewport) return;
    const onScroll = () => {
      const distance = radixViewport.scrollHeight - radixViewport.scrollTop - radixViewport.clientHeight;
      setIsAtBottom(distance < 96);
    };
    onScroll();
    radixViewport.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(onScroll)
      : null;
    ro?.observe(radixViewport);
    return () => {
      radixViewport.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [radixViewport]);

  // Lote D · #26 — Smart auto-scroll durante streaming.
  // Si el usuario YA está al final cuando llegan tokens nuevos, lo
  // pegamos al fondo automáticamente para que la respuesta se vea
  // creciendo. Si subió a leer mensajes anteriores (isAtBottom=false),
  // NO lo arrastramos al fondo — el pill "Nuevos mensajes" ya le da
  // el control de cuándo volver. En cuanto vuelve manualmente al
  // fondo, isAtBottom pasa a true y este efecto reanuda el follow.
  //
  // Disparador: el contenido de la última burbuja (la que está
  // recibiendo tokens). Usamos su longitud como proxy barato sin
  // tener que enganchar a cada chunk del SSE.
  const streamingContentLen = React.useMemo(() => {
    if (!isCurrentChatStreaming) return 0;
    const msgs = currentChat?.messages;
    if (!msgs || msgs.length === 0) return 0;
    const last = msgs[msgs.length - 1];
    return typeof last?.content === 'string' ? last.content.length : 0;
  }, [isCurrentChatStreaming, currentChat?.messages]);

  React.useEffect(() => {
    if (!isCurrentChatStreaming) return;
    if (!isAtBottom) return;
    scrollToBottom();
  }, [streamingContentLen, isCurrentChatStreaming, isAtBottom, scrollToBottom]);

  const [isUploading, setIsUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<{ [key: string]: number }>({});

  // Local sending / intent state so Stop button appears immediately on Enter
  const [isSending, setIsSending] = React.useState(false);
  const [sendingChatId, setSendingChatId] = React.useState<string | null>(null);
  const intentAbortControllerRef = React.useRef<AbortController | null>(null);
  // Separate controller for the agentic search so Stop can cancel the
  // SSE stream without clobbering other in-flight requests (intent
  // classification, chat streaming) that live under intentAbortController.
  const searchAbortControllerRef = React.useRef<AbortController | null>(null);
  const currentAgentTaskIdRef = React.useRef<string | null>(null);
  const localJobControllersRef = React.useRef<Map<string, AbortController>>(new Map());
  const agentTaskIdsByChatRef = React.useRef<Map<string, string>>(new Map());
  const activeLocalJobChatIdsRef = React.useRef<Set<string>>(new Set());
  const [activeLocalJobChatIds, setActiveLocalJobChatIds] = React.useState<string[]>([]);

  const syncActiveLocalJobs = React.useCallback(() => {
    setActiveLocalJobChatIds(Array.from(activeLocalJobChatIdsRef.current));
  }, []);

  const markLocalJobBusy = React.useCallback((chatId?: string | null, controller?: AbortController) => {
    if (!chatId) return;
    activeLocalJobChatIdsRef.current.add(chatId);
    if (controller) {
      localJobControllersRef.current.set(chatId, controller);
    }
    syncActiveLocalJobs();
  }, [syncActiveLocalJobs]);

  const markLocalJobIdle = React.useCallback((chatId?: string | null, controller?: AbortController) => {
    if (!chatId) return;
    const tracked = localJobControllersRef.current.get(chatId);
    if (!controller || !tracked || tracked === controller) {
      localJobControllersRef.current.delete(chatId);
      agentTaskIdsByChatRef.current.delete(chatId);
      activeLocalJobChatIdsRef.current.delete(chatId);
      syncActiveLocalJobs();
    }
  }, [syncActiveLocalJobs]);

  // Voice Studio panel state
  const [showAudioPanel, setShowAudioPanel] = React.useState(false);
  const [audioTab, setAudioTab] = React.useState<'tts' | 'stt' | 'music' | 'video'>("tts");

  // Speech-to-Text states 
  const [isSpeechSupported, setIsSpeechSupported] = React.useState(false);
  const recognitionRef = React.useRef<SpeechRecognition | null>(null);

  const [isWebSearching, setIsWebSearching] = React.useState(false)
  const [isWebSearchActive, setIsWebSearchActive] = React.useState(false);
  const [isGmailActive, setIsGmailActive] = React.useState(false);
  const [isProcessingGmail, setIsProcessingGmail] = React.useState(false);
  const [isGoogleCalendarActive, setIsGoogleCalendarActive] = React.useState(false);
  const [isGoogleDriveActive, setIsGoogleDriveActive] = React.useState(false);
  const [isProcessingGoogleServices, setIsProcessingGoogleServices] = React.useState(false);
  const [isSpotifyActive, setIsSpotifyActive] = React.useState(false);
  const [isProcessingSpotify, setIsProcessingSpotify] = React.useState(false);
  const [isImageGenerationActive, setIsImageGenerationActive] = React.useState(false);
  const [isComputerUseActive, setIsComputerUseActive] = React.useState(false);
  const [computerUseStatus, setComputerUseStatus] = React.useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [computerUseScreenshot, setComputerUseScreenshot] = React.useState<string | null>(null);
  const [isWordConnectorActive, setIsWordConnectorActive] = React.useState(false);
  const [isGeneratingWord, setIsGeneratingWord] = React.useState(false);
  const wordConnectorRef = React.useRef<{ updateContent: (content: string) => void; replaceSelection: (content: string) => void; getHTML: () => string; } | null>(null);
  const [selectedWordText, setSelectedWordText] = React.useState<string | null>(null);
  const [isRewriting, setIsRewriting] = React.useState(false);

  const [isExcelConnectorActive, setIsExcelConnectorActive] = React.useState(false);
  const [isGeneratingExcel, setIsGeneratingExcel] = React.useState(false);
  const isCurrentChatLocalJobBusy = Boolean(currentChatId && activeLocalJobChatIds.includes(currentChatId));
  const excelConnectorRef = React.useRef<ExcelConnectorRef | null>(null);

  // Computer Use hook
  const {
    status: computerUseHookStatus,
    screenshot: computerUseHookScreenshot,
    reasoning: computerUseReasoning,
    extractedData: computerUseExtractedData,
    finalUrl: computerUseFinalUrl,
    startComputerUse,
    stopComputerUse,
    addReasoningStep,
    clearReasoning
  } = useComputerUse();

  // Sync hook state with local state
  React.useEffect(() => {
    setComputerUseStatus(computerUseHookStatus);
    setComputerUseScreenshot(computerUseHookScreenshot);
  }, [computerUseHookStatus, computerUseHookScreenshot]);

  // ============================================
  // CENTRALIZED FUNCTIONS FOR TOOLS & CONNECTORS
  // ============================================

  /**
   * Closes all tools and connectors - used when activating a new tool/connector
   * This ensures only one tool/connector is active at a time
   */
  const closeAllToolsAndConnectors = React.useCallback(() => {
    setIsWebSearchActive(false);
    setIsImageGenerationActive(false);
    setIsVoiceGenerationActive(false);
    setIsMusicGenerationActive(false);
    setIsVideoGenerationActive(false);
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsComputerUseActive(false);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
  }, []);

  /**
   * Resets all tools, connectors, and UI states - used when switching chats or clicking "Nuevo chat"
   */
  const resetAllToolsAndConnectors = React.useCallback(() => {
    // Close all tools and connectors
    closeAllToolsAndConnectors();

    // Reset chat type
    setChatType('text');

    // Reset other UI states
    setShowAudioPanel(false);
    setDocumentPreviewUrl(null);
    setActiveSearchActivityId(null);
    setSplitViewContent(null);
    setComposerPreviewIndex(null);
    setSelectedWordText(null);
    uploadedFilesRef.current = [];
    setUploadedFiles([]);
    setUploadProgress({});
    setInput('');
    setSelectedImageModel(DEFAULT_IMAGE_MODEL);
    setSelectedVideoModel(DEFAULT_VIDEO_MODEL);

    // Clear Computer Use state
    if (clearReasoning) clearReasoning();
    setComputerUseStatus('idle');
    setComputerUseScreenshot(null);
  }, [closeAllToolsAndConnectors, setChatType, clearReasoning, setUploadedFiles]);

  const markImageGenerationStopped = React.useCallback(() => {
    setCurrentChat(prevChat => {
      if (!prevChat) return prevChat;
      let changed = false;
      const newMessages = (prevChat.messages || []).map((msg: any) => {
        if (msg.content === '[GENERATING_IMAGE]') {
          changed = true;
          return { ...msg, content: '', error: 'Generación de imagen detenida.' };
        }
        return msg;
      });
      return changed ? { ...prevChat, messages: newMessages } : prevChat;
    });
  }, [setCurrentChat]);

  const stopActiveGeneration = React.useCallback(() => {
    if (intentAbortControllerRef.current) {
      intentAbortControllerRef.current.abort();
      intentAbortControllerRef.current = null;
    }
    const targetChatId = currentChatId;
    const scopedTaskId = targetChatId ? agentTaskIdsByChatRef.current.get(targetChatId) : null;
    const fallbackTaskId = currentAgentTaskIdRef.current;
    const taskId = scopedTaskId || fallbackTaskId;
    if (taskId) {
      if (scopedTaskId && targetChatId) {
        agentTaskIdsByChatRef.current.delete(targetChatId);
      }
      if (fallbackTaskId === taskId) {
        currentAgentTaskIdRef.current = null;
      }
      void agentTaskService.cancelTask(taskId).catch((err) => {
        console.warn('Failed to cancel agent task:', err);
      });
    }
    const scopedController = targetChatId ? localJobControllersRef.current.get(targetChatId) : null;
    if (scopedController) {
      scopedController.abort();
      markLocalJobIdle(targetChatId, scopedController);
      if (searchAbortControllerRef.current === scopedController) {
        searchAbortControllerRef.current = null;
        setIsWebSearching(false);
      }
    } else if (searchAbortControllerRef.current) {
      const controller = searchAbortControllerRef.current;
      controller.abort();
      searchAbortControllerRef.current = null;
      if (targetChatId) {
        markLocalJobIdle(targetChatId, controller);
      }
      setIsWebSearching(false);
    }
    if (imageAbortControllerRef.current) {
      imageAbortControllerRef.current.abort();
      imageAbortControllerRef.current = null;
      isGeneratingImageRef.current = false;
      setIsGeneratingImage(false);
      if (targetChatId) {
        markLocalJobIdle(targetChatId);
      }
      markImageGenerationStopped();
      toast.info('Generación de imagen detenida');
    }
    stopStreaming();
    setIsSending(false);
    setSendingChatId(null);
  }, [currentChatId, markImageGenerationStopped, markLocalJobIdle, stopStreaming]);

  // Add reasoning steps to chat messages as they come in
  React.useEffect(() => {
    if (computerUseReasoning.length > 0 && currentChat && isComputerUseActive) {
      // Find the latest reasoning step
      const latestStep = computerUseReasoning[computerUseReasoning.length - 1];

      // Add reasoning step as a chat message
      const reasoningMessage = {
        id: `msg-reasoning-${latestStep.timestamp}`,
        chatId: currentChat.id,
        role: 'ASSISTANT' as const,
        content: latestStep.text,
        timestamp: new Date(latestStep.timestamp).toISOString(),
        metadata: JSON.stringify({
          type: 'computer_use_reasoning',
          stepNumber: computerUseReasoning.length,
          action: latestStep.action
        })
      };

      // Only add if this reasoning step isn't already in the chat
      const existingMessage = currentChat.messages?.find(msg =>
        msg.id === reasoningMessage.id
      );

      if (!existingMessage) {
        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), reasoningMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }
    }
  }, [computerUseReasoning, currentChat, isComputerUseActive, setCurrentChat]);


  const handleGmailToggle = () => {
    const newState = !isGmailActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsGmailActive(true);
    } else {
      setIsGmailActive(false);
    }
  };

  const handleGoogleCalendarToggle = () => {
    const newState = !isGoogleCalendarActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsGoogleCalendarActive(true);
    } else {
      setIsGoogleCalendarActive(false);
    }
  };

  const handleGoogleDriveToggle = () => {
    const newState = !isGoogleDriveActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsGoogleDriveActive(true);
    } else {
      setIsGoogleDriveActive(false);
    }
  };

  const handleSpotifyToggle = () => {
    const newState = !isSpotifyActive;
    setChatType('text');
    if (newState) {
      closeAllToolsAndConnectors();
      setIsSpotifyActive(true);
    } else {
      setIsSpotifyActive(false);
    }
  };

  const handleComputerUseToggle = () => {
    const newState = !isComputerUseActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setIsComputerUseActive(true);
      setChatType('computer-use');
    } else {
      setIsComputerUseActive(false);
      setChatType('text');
    }
  };

  const handleWordConnectorToggle = async () => {
    devLog("Toggling Word Connector");
    const newState = !isWordConnectorActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setIsWordConnectorActive(true);
      setChatType('text');

      // If toggling on while a chat is already selected, create/select
      // a dedicated chat for the Word Connector so we don't reuse
      // the existing conversation.
      if (currentChat) {
        try {
          const newChat = await createNewChat('text', undefined, undefined, {
            skipInitialProcessing: true,
            isWordConnectorChat: true
          });
          if (newChat?.id) {
            await selectChat(newChat.id);
          }
        } catch (err) {
          console.error('Failed to create/select Word Connector chat', err);
        }
      }
    } else {
      setIsWordConnectorActive(false);
      setChatType('text');
    }
  };

  const handleExcelConnectorToggle = async () => {
    devLog("Toggling Excel Connector");
    const newState = !isExcelConnectorActive;

    if (newState) {
      closeAllToolsAndConnectors();
      setIsExcelConnectorActive(true);
      setChatType('text');

      // Create/select a dedicated chat for the Excel Connector
      if (currentChat) {
        try {
          const newChat = await createNewChat('text', undefined, undefined, {
            skipInitialProcessing: true,
            isExcelConnectorChat: true,
          } as any);
          if (newChat?.id) {
            await selectChat(newChat.id);
          }
        } catch (err) {
          console.error('Failed to create/select Excel Connector chat', err);
        }
      }
    } else {
      setIsExcelConnectorActive(false);
      setChatType('text');
    }
  };

  const handleSpotifyCommand = async (prompt: string) => {
    setIsProcessingSpotify(true);
    try {
      if (!currentChat) {
        await createNewChat('spotify', prompt);
      } else {
        const assistantPlaceholder = {
          id: `msg-assistant-processing-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: '[PROCESSING_SPOTIFY]',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });

        const payload = {
          prompt,
          chatId: currentChat?.id,
        };

        const response = await apiClient.processSpotifyCommand(payload);

        if (response.requiresConnection) {
          const updateChatWithConnection = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_SPOTIFY]') {
                return {
                  ...msg,
                  content: `**Spotify Connection Required**

I can help you with Spotify tasks like:
- Searching for songs
- Managing your playlists

But first, you need to connect your Spotify account securely using the button below.`,
                  metadata: JSON.stringify({
                    type: 'spotify_connection_required',
                    showConnectionCard: true
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithConnection);
          toast.error('Spotify connection required');
        } else {
          const updateChatWithSpotifyResults = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_SPOTIFY]') {
                return {
                  ...msg,
                  content: response.generalResponse || "Here are your Spotify results:",
                  metadata: JSON.stringify({
                    type: 'spotify_results',
                    data: response
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithSpotifyResults);
          toast.success('Spotify response generated!');
        }
      }
    } catch (error: any) {
      console.error('Spotify error:', error);
      const errorMessage = error.message || 'Spotify request failed. Please try again.';

      // Check for monthly API limit exceeded error
      if (isMonthlyLimitError(errorMessage)) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (currentChat?.id && prevChat.id !== currentChat.id) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_SPOTIFY]') {
              return {
                ...msg,
                content: "Monthly API limit exceeded. Please upgrade your plan to continue using Spotify features.",
                error: "Monthly API limit exceeded"
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[PROCESSING_SPOTIFY]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
    } finally {
      setIsProcessingSpotify(false);
    }
  }
  const [isVideoGenerationActive, setIsVideoGenerationActive] = React.useState(false);
  const [subscribeOpen, setSubscribeOpen] = React.useState(false);
  const [isSubscribing, setIsSubscribing] = React.useState(false);
  const [currentUserInfo, setCurrentUserInfo] = React.useState<any>(null);
  const currentPlan = normalizePlanName(user?.plan);
  const isFreePlan = isFreePlanName(currentPlan);
  const [splitViewContent, setSplitViewContent] = React.useState<any>(null)
  const [documentPreviewUrl, setDocumentPreviewUrl] = React.useState<DocumentPreviewTarget | null>(null);
  const [composerPreviewIndex, setComposerPreviewIndex] = React.useState<number | null>(null);
  const [sidePreviewAttachment, setSidePreviewAttachment] = React.useState<AttachmentLike | null>(null);
  const [sidePreviewSiblings, setSidePreviewSiblings] = React.useState<AttachmentLike[]>([]);
  const activeSearchActivity = activeSearchActivityId ? searchActivities[activeSearchActivityId] : null;
  const searchActivityPanelOpen = Boolean(activeSearchActivity);

  React.useEffect(() => {
    setActiveSearchActivityId(null);
  }, [currentChat?.id]);

  const openSearchActivityPanel = React.useCallback((messageId: string) => {
    setActiveSearchActivityId(messageId);
  }, []);

  const closeSearchActivityPanel = React.useCallback(() => {
    setActiveSearchActivityId(null);
  }, []);

  const handleMessageAreaClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const trigger = target?.closest<HTMLElement>('[data-search-activity-id]');
    if (!trigger) return;
    const messageId = trigger.dataset.searchActivityId;
    if (!messageId) return;
    event.preventDefault();
    event.stopPropagation();
    openSearchActivityPanel(messageId);
  }, [openSearchActivityPanel]);
  const [shareModalOpen, setShareModalOpen] = React.useState(false);
  const [shareUrl, setShareUrl] = React.useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Global Cmd/Ctrl + / opens the keyboard shortcuts help modal. We attach
  // at the window level so it works regardless of which child has focus,
  // and skip when the user is mid-IME composition or inside a
  // contenteditable that should claim the slash key.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.key !== "/" && e.key !== "?") return;
      // Avoid stealing the chord while typing inside a textarea where the
      // user might want a literal "/" — but only if no modifier is held.
      // (Here both modifiers are required, so we always toggle.)
      e.preventDefault();
      setShortcutsOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Helper function to check if error is related to monthly API limit
  const isMonthlyLimitError = React.useCallback((errorMessage: string) => {
    const lowerMessage = errorMessage.toLowerCase();
    return lowerMessage.includes('monthly api limit exceeded') ||
      lowerMessage.includes('monthly limit exceeded') ||
      lowerMessage.includes('monthly video generation limit exceeded') ||
      lowerMessage.includes('free monthly queries exhausted') ||
      lowerMessage.includes('upgrade required') ||
      lowerMessage.includes('upgrade_required') ||
      lowerMessage.includes('sube de plan') ||
      (lowerMessage.includes('monthly') && lowerMessage.includes('limit'));
  }, []);


  // Search sources state - all enabled by default

  const chatViewportRef = React.useRef<HTMLDivElement>(null);
  const chatHeaderRef = React.useRef<HTMLDivElement>(null);
  const chatComposerDockRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Slash-command menu state. Tracks whether the menu is open and what filter
  // string the user has typed after the leading "/". The menu auto-opens
  // whenever the input starts with "/" and stays open while the user is still
  // typing the command name.
  const [slashMenuOpen, setSlashMenuOpen] = React.useState(false);
  const [slashMenuFilter, setSlashMenuFilter] = React.useState("");

  React.useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Sync the slash menu's open state + filter with the live input value so
  // that pasting "/goal" or deleting the leading "/" toggles the menu
  // immediately (not only via handleTextareaChange, which can miss
  // programmatic setInput updates).
  React.useEffect(() => {
    const filter = detectSlashFilter(input);
    if (filter === null) {
      setSlashMenuOpen(false);
    } else {
      setSlashMenuOpen(true);
      setSlashMenuFilter(filter);
    }
  }, [input]);

  const detectedLinks = React.useMemo(() => extractDetectedLinks(input), [input]);

  const removeDetectedLink = React.useCallback((link: DetectedLink) => {
    setInput((prev) => {
      const escapedRaw = link.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const escapedUrl = link.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const withoutRaw = prev.replace(new RegExp(`\\s*${escapedRaw}`, "g"), " ")
      const withoutUrl = withoutRaw.replace(new RegExp(`\\s*${escapedUrl}`, "g"), " ")
      return withoutUrl.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trimStart()
    });
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const getComposerTextareaMaxHeight = React.useCallback(() => {
    if (typeof window === "undefined") return 200;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 720;
    const isMobileViewport = window.matchMedia("(max-width: 767px)").matches;
    if (!isMobileViewport) return 200;
    return Math.max(96, Math.min(180, Math.floor(viewportHeight * 0.28)));
  }, []);

  const syncChatLayoutVars = React.useCallback(() => {
    const root = chatViewportRef.current;
    if (!root) return;

    const setPx = (name: string, value: number) => {
      root.style.setProperty(name, `${Math.max(0, Math.ceil(value))}px`);
    };

    setPx("--chat-header-height", chatHeaderRef.current?.getBoundingClientRect().height || 64);
    setPx("--chat-composer-height", chatComposerDockRef.current?.getBoundingClientRect().height || 96);
    setPx("--chat-textarea-max-height", getComposerTextareaMaxHeight());
  }, [getComposerTextareaMaxHeight]);

  const resizeComposerTextarea = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const maxHeight = getComposerTextareaMaxHeight();
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;

    if (scrollHeight > maxHeight) {
      textarea.style.height = `${maxHeight}px`;
      textarea.style.overflowY = "auto";
      window.setTimeout(() => {
        textarea.scrollTop = textarea.scrollHeight;
      }, 0);
    } else {
      textarea.style.height = `${scrollHeight}px`;
      textarea.style.overflowY = "hidden";
    }

    syncChatLayoutVars();
    window.requestAnimationFrame(() => {
      syncChatLayoutVars();
      if (document.activeElement === textarea) {
        scrollToBottom();
      }
    });
  }, [getComposerTextareaMaxHeight, scrollToBottom, syncChatLayoutVars]);

  // Handle textarea input change with smooth scrolling
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    // Persist the in-progress draft per chat (debounced inside the hook).
    chatDraft.save(value);

    // Use requestAnimationFrame to ensure DOM is updated before scrolling
    requestAnimationFrame(resizeComposerTextarea);
  };

  const handleTextareaFocus = React.useCallback(() => {
    resizeComposerTextarea();
    window.requestAnimationFrame(() => {
      syncChatLayoutVars();
      scrollToBottom();
    });
  }, [resizeComposerTextarea, scrollToBottom, syncChatLayoutVars]);

  React.useEffect(() => {
    resizeComposerTextarea();
  }, [input, resizeComposerTextarea]);

  // Instant upgrade function — restringido a super-admins.
  // Para usuarios normales el endpoint devuelve 403, así que evitamos el
  // round-trip y dirigimos al flujo estándar de Stripe Checkout abriendo el
  // UpgradeModal (que internamente llama a apiClient.createStripePayment).
  const instantUpgrade = async (plan: 'PRO' | 'PRO_MAX' | 'ENTERPRISE') => {
    const authedUser: any = currentUserInfo || user;
    const isSuperAdmin =
      authedUser?.isSuperAdmin === true || authedUser?.role === 'SUPER_ADMIN';

    if (!isSuperAdmin) {
      // No emitir la petición — abrir el modal estándar de upgrade.
      setSubscribeOpen(true);
      return;
    }

    try {
      setIsSubscribing(true);
      const planMap: Record<string, { monthlyLimit: number; price?: number }> = {
        PRO: { monthlyLimit: 500000, price: 5 },
        PRO_MAX: { monthlyLimit: 1000000, price: 20 },
        ENTERPRISE: { monthlyLimit: 10000000, price: 200 },
      };

      const payload = {
        plan,
        monthlyLimit: planMap[plan].monthlyLimit,
        price: planMap[plan].price ?? 0,
      };

      const res = await fetch('/api/payments/instant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.warn('instantUpgrade backend failed:', body);
        toast.error('No se pudo aplicar la actualización instantánea.');
        return;
      }

      toast.success('Subscription applied — plan updated');
      setSubscribeOpen(false);
    } catch (err: any) {
      console.error('instantUpgrade error', err);
      toast.error('Error al aplicar la actualización instantánea.');
    } finally {
      setIsSubscribing(false);
    }
  };


  React.useEffect(() => {
    function handleOpenUpgrade(e: any) {
      setSubscribeOpen(true);
    }

    // Global error handler for API limit exceeded errors
    function handleApiLimitError(e: Event) {
      const customEvent = e as CustomEvent;
      const errorMessage = customEvent.detail?.message || customEvent.detail?.error || '';
      if (isMonthlyLimitError(errorMessage)) {
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('open-upgrade-modal', handleOpenUpgrade);
      window.addEventListener('api-limit-error', handleApiLimitError);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('open-upgrade-modal', handleOpenUpgrade);
        window.removeEventListener('api-limit-error', handleApiLimitError);
      }
    };
  }, [setSubscribeOpen, isMonthlyLimitError]);

  const handleToggleSplitView = (content: any) => {
    setDocumentPreviewUrl(null)
    setComposerPreviewIndex(null)
    setSidePreviewAttachment(null)
    setSidePreviewSiblings([])
    setSplitViewContent(content)
  }

  const handleDocumentPreview = (url: DocumentPreviewTarget) => {
    setSplitViewContent(null)
    setComposerPreviewIndex(null)
    setSidePreviewAttachment(null)
    setSidePreviewSiblings([])
    setSplitRatio((current) => {
      const balanced = current < 40 || current > 62 ? 48 : current
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(balanced)); } catch { /* ignore */ }
      return balanced
    })
    setDocumentPreviewUrl(url);
  };

  const handleAttachmentPreview = React.useCallback((attachment: AttachmentLike, siblings: AttachmentLike[] = [], index = 0) => {
    setSplitViewContent(null);
    setDocumentPreviewUrl(null);
    setComposerPreviewIndex(null);
    setActiveSearchActivityId(null);
    setSplitRatio((current) => {
      const balanced = current < 40 || current > 62 ? 48 : current;
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(balanced)); } catch { /* ignore */ }
      return balanced;
    });
    const normalizedSiblings = siblings.length > 0 ? siblings : [attachment];
    setSidePreviewSiblings(normalizedSiblings);
    setSidePreviewAttachment(normalizedSiblings[index] || attachment);
  }, []);

  // Complete chat share functionality
  const handleCompleteShare = async () => {
    if (!currentChat?.id) {
      toast.error("No hay conversación para compartir");
      return;
    }

    try {
      const response = await apiClient.handleShare(currentChat.id);
      const baseUrl = process.env.NEXT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
      const url = `${baseUrl}/share/${response.shareableLink}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Enlace para compartir copiado");
      } catch {
        toast.success("Enlace para compartir creado (no se pudo copiar automáticamente)");
      }
      setShareUrl(url);
      setShareModalOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "intenta nuevamente";
      toast.error(`No se pudo crear el enlace de la conversación: ${message}`);
    }
  };

  const normalizeDictationText = React.useCallback((value: string) => {
    return value.replace(/\s+/g, " ").trim();
  }, []);

  const buildDictationDraft = React.useCallback((interimTranscript = "") => {
    return [
      dictationBaseRef.current,
      dictationFinalRef.current,
      interimTranscript,
    ].map(normalizeDictationText).filter(Boolean).join(" ");
  }, [normalizeDictationText]);

  const appendDictationText = React.useCallback((text: string) => {
    const normalizedText = normalizeDictationText(text);
    if (!normalizedText) return;

    setInput(prev => {
      const nextInput = normalizeDictationText(`${prev} ${normalizedText}`);
      inputRef.current = nextInput;
      return nextInput;
    });
  }, [normalizeDictationText]);

  const resetDictationTranscript = React.useCallback(() => {
    dictationBaseRef.current = "";
    dictationFinalRef.current = "";
    dictationInterimRef.current = "";
  }, []);

  const showMicrophonePermissionError = React.useCallback((error?: any) => {
    const errorName = String(error?.name || error?.message || "");
    const isDenied = /denied|notallowed|not-allowed|permission/i.test(errorName);
    toast.error(
      isDenied
        ? "El micrófono está bloqueado. Actívalo en los permisos del navegador y vuelve a intentarlo."
        : "No se pudo acceder al micrófono. Revisa que esté conectado y permitido.",
    );
  }, []);

  const ensureMicrophonePermission = React.useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia unsupported");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    stream.getTracks().forEach(track => track.stop());
    dictationPermissionReadyRef.current = true;
  }, []);

  const transcribeRecordedDictation = React.useCallback(async (audioBlob: Blob) => {
    if (!audioBlob.size) {
      setIsRecording(false);
      return;
    }

    setIsRecording(false);
    setIsDictationTranscribing(true);

    try {
      const audioFile = new globalThis.File([audioBlob], "dictation.webm", {
        type: audioBlob.type || "audio/webm",
      });
      const response: any = await apiClient.speechToText(audioFile, "scribe_v1");

      if (response?.fallback) {
        toast.error("La transcripción del backend no está disponible con la configuración actual.");
        return;
      }

      if (response?.text) {
        appendDictationText(response.text);
        toast.success("Dictado insertado en el chat.");
      } else {
        toast.error("No se detectó texto en el audio grabado.");
      }
    } catch (error: any) {
      console.error("Dictation transcription error:", error);
      toast.error(error?.message || "No se pudo transcribir el dictado.");
    } finally {
      setIsDictationTranscribing(false);
      dictationModeRef.current = "idle";
      dictationMediaRecorderRef.current = null;
      dictationAudioChunksRef.current = [];
    }
  }, [appendDictationText]);

  const startRecorderDictation = React.useCallback(async () => {
    if (!window.MediaRecorder) {
      toast.error("Este navegador no soporta grabación de audio para dictado.");
      setIsRecording(false);
      dictationModeRef.current = "idle";
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const supportedMimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find(type => MediaRecorder.isTypeSupported(type));
      const mediaRecorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType })
        : new MediaRecorder(stream);

      dictationAudioChunksRef.current = [];
      dictationMediaRecorderRef.current = mediaRecorder;
      dictationModeRef.current = "recorder";
      dictationShouldTranscribeRecordingRef.current = true;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          dictationAudioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(dictationAudioChunksRef.current, {
          type: mediaRecorder.mimeType || "audio/webm",
        });
        stream.getTracks().forEach(track => track.stop());
        if (!dictationShouldTranscribeRecordingRef.current) {
          setIsRecording(false);
          dictationModeRef.current = "idle";
          dictationAudioChunksRef.current = [];
          return;
        }
        void transcribeRecordedDictation(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
      toast.info("Dictado activado. Habla y pulsa detener para insertar el texto.");
    } catch (error) {
      console.error("Recorder dictation start error:", error);
      dictationModeRef.current = "idle";
      setIsRecording(false);
      showMicrophonePermissionError(error);
    }
  }, [showMicrophonePermissionError, transcribeRecordedDictation]);

  React.useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      setIsSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      const preferredLanguage = navigator.languages?.find(lang => lang.toLowerCase().startsWith("es"))
        || navigator.language
        || document.documentElement.lang
        || "es-ES";
      recognition.lang = preferredLanguage.toLowerCase().startsWith("en") ? "es-ES" : preferredLanguage;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript || "";
          if (event.results[i].isFinal) {
            finalTranscript += ` ${transcript}`;
          } else {
            interimTranscript += ` ${transcript}`;
          }
        }

        if (finalTranscript) {
          dictationFinalRef.current = normalizeDictationText(`${dictationFinalRef.current} ${finalTranscript}`);
        }
        dictationInterimRef.current = normalizeDictationText(interimTranscript);
        setInput(buildDictationDraft(dictationInterimRef.current));
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error("Speech recognition error:", event.error);
        const permissionErrors = new Set(["not-allowed", "service-not-allowed"]);
        if (
          permissionErrors.has(event.error)
          && dictationPermissionReadyRef.current
          && !dictationNativeFallbackStartedRef.current
        ) {
          dictationNativeFallbackStartedRef.current = true;
          toast.info("El dictado nativo no se activó. Usaré grabación y transcripción al detener.");
          void startRecorderDictation();
          return;
        }

        if (permissionErrors.has(event.error)) {
          toast.error("El micrófono está bloqueado. Actívalo en los permisos del navegador y vuelve a intentarlo.");
        } else if (event.error !== "no-speech" && event.error !== "aborted") {
          toast.error("No se pudo iniciar el dictado. Inténtalo de nuevo.");
        }
        dictationModeRef.current = "idle";
        setIsRecording(false);
      };

      recognition.onend = () => {
        if (dictationModeRef.current === "recorder") return;

        const committedDraft = buildDictationDraft(dictationInterimRef.current);
        if (committedDraft) {
          setInput(committedDraft);
          inputRef.current = committedDraft;
        }
        resetDictationTranscript();
        dictationModeRef.current = "idle";
        setIsRecording(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (dictationMediaRecorderRef.current?.state === "recording") {
        dictationShouldTranscribeRecordingRef.current = false;
        dictationMediaRecorderRef.current.stop();
      }
    };
  }, [buildDictationDraft, normalizeDictationText, resetDictationTranscript, startRecorderDictation]);

  const handleMicClick = async () => {
    const recognition = recognitionRef.current;

    if (isDictationTranscribing) return;

    if (isRecording) {
      if (dictationModeRef.current === "recorder") {
        dictationShouldTranscribeRecordingRef.current = true;
        dictationMediaRecorderRef.current?.stop();
      } else {
        recognition?.stop();
      }
      return;
    }

    dictationBaseRef.current = inputRef.current;
    dictationFinalRef.current = "";
    dictationInterimRef.current = "";
    dictationPermissionReadyRef.current = false;
    dictationNativeFallbackStartedRef.current = false;

    try {
      await ensureMicrophonePermission();
    } catch (error) {
      showMicrophonePermissionError(error);
      return;
    }

    if (!recognition) {
      void startRecorderDictation();
      return;
    }

    try {
      dictationModeRef.current = "native";
      recognition.start();
      setIsRecording(true);
    } catch (error: any) {
      if (error?.name === "InvalidStateError") {
        setIsRecording(true);
        return;
      }

      console.error("Speech recognition start error:", error);
      toast.info("El dictado nativo no inició. Usaré grabación y transcripción al detener.");
      void startRecorderDictation();
    }
  };

  const renderDictationButton = () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleMicClick}
          disabled={isDictationTranscribing}
          aria-label={isDictationTranscribing ? "Transcribiendo dictado" : isRecording ? "Detener dictado" : "Dictar al chat"}
          aria-pressed={isRecording}
          title={isDictationTranscribing ? "Transcribiendo dictado" : isRecording ? "Detener dictado" : "Dictar al chat"}
          className={cn(
            "relative h-9 w-9 rounded-full p-0 transition-all duration-fast ease-smooth active:scale-[0.96]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            isRecording
              ? "bg-red-500/10 text-red-500 hover:bg-red-500/15 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
              : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
          )}
        >
          {/* Active-state halo — two concentric pulses around the icon
              so the user has unambiguous feedback that the mic is hot.
              The outer ring uses Tailwind `animate-ping` (decays to
              transparent) and the inner ring is a static red border so
              the resting affordance is also tinted, not just animated.
              Hidden via aria-hidden so screen readers only announce the
              button label, not the decoration. */}
          {isRecording && (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full bg-red-500/30 animate-ping"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-red-500/45"
              />
            </>
          )}
          {isDictationTranscribing ? (
            <ThinkingIndicator size="sm" className="h-[17px] w-[17px] relative" />
          ) : isRecording ? (
            <Square className="h-[14px] w-[14px] fill-current relative" strokeWidth={0} />
          ) : (
            <Mic className="h-[17px] w-[17px]" strokeWidth={1.75} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>
          {isDictationTranscribing
            ? "Transcribiendo dictado"
            : isRecording
            ? "Escuchando · toca para detener"
            : isSpeechSupported
              ? "Dictar al chat"
              : "Dictado no soportado por este navegador"}
        </p>
      </TooltipContent>
    </Tooltip>
  );

  // React.useEffect(() => {
  //   console.log(currentChat);

  //   if (currentChat && currentChat.messages.length > 0) {
  //     if (currentChat.messages[0].content !== "Hello! I'm gpt. How can I help you today?") {
  //       const hasImageMessages = currentChat.messages.some(msg =>
  //         msg.role === "ASSISTANT" && (
  //           (msg.content.startsWith('http') && (msg.content.includes('oaidalleapiprodscus') || msg.content.includes('dalle'))) ||
  //           (msg.files && JSON.parse(msg.files.toString() || '[]').some((f: any) => f.type === 'image'))
  //         )
  //       );

  //       const hasVideoMessages = currentChat.messages.some(msg =>
  //         msg.videoData && (msg.videoData.status === 'completed' || msg.videoData.status === 'processing' || msg.videoData.status === 'failed')
  //       );

  //       if (chatType === "video") {
  //         setChatType('video');
  //       } else if (hasImageMessages) {
  //         setChatType('image');
  //       } else {
  //         setChatType('text');
  //       }
  //     }
  //   }
  // }, [currentChat]);
  // Replace the commented useEffect and add a new one for chat switching
  React.useEffect(() => {
    if (prevChatIdRef.current && prevChatIdRef.current !== currentChat?.id) {
      // Reset generation modes when switching chats, except while an image
      // request is actively using the current composer mode.
      if (isGeneratingImageRef.current) {
        setIsImageGenerationActive(true);
        setChatType('image');
      } else {
        closeAllToolsAndConnectors();
        setChatType('text'); // Always default to text when switching chats
      }

      // Clear Computer Use reasoning when switching chats
      clearReasoning();
    }
    prevChatIdRef.current = currentChat?.id;
  }, [currentChat?.id, clearReasoning, closeAllToolsAndConnectors, setChatType]); // Only trigger when chat ID changes


  React.useEffect(() => {
    setShowAudioPanel(false);
    setDocumentPreviewUrl(null)
    setSplitViewContent(null)
    setSelectedWordText(null);

    // Close all connectors first when switching chats, but keep the image
    // tool visibly selected while its request is still running.
    if (isGeneratingImageRef.current) {
      setIsImageGenerationActive(true);
      setChatType('image');
    } else {
      closeAllToolsAndConnectors();
    }

    // Use a small delay to ensure previous connector UI is fully closed
    const timer = setTimeout(() => {
      if (currentChat && (currentChat as any).isWordConnectorChat) {
        devLog('📄 Word Connector chat detected:', currentChat.id);
        devLog('📄 Has wordContent:', !!(currentChat as any).wordContent);
        devLog('📄 wordContent length:', (currentChat as any).wordContent?.length);

        setIsWordConnectorActive(true);

        // Load existing Word content if available
        if ((currentChat as any).wordContent) {
          devLog('📄 Attempting to load Word content into editor...');
          // Wait longer for editor to be ready
          setTimeout(() => {
            if (wordConnectorRef.current) {
              devLog('📄 Ref is ready, updating content...');
              wordConnectorRef.current?.updateContent((currentChat as any).wordContent);
            } else {
              console.warn('📄 WordConnector ref not ready yet');
            }
          }, 500);
        }
      } else if (currentChat && (currentChat as any).isExcelConnectorChat) {
        setIsExcelConnectorActive(true);

        if ((currentChat as any).excelContent) {
          setTimeout(() => {
            excelConnectorRef.current?.loadWorkbook((currentChat as any).excelContent);
          }, 500);
        }
      }
    }, 150);

    return () => clearTimeout(timer);
    // Listing the full `currentChat` would re-fire this on every
    // message append; setChatType is a stable setter. The connector-
    // detect logic runs once per chat-id and shouldn't re-mount the
    // Word/Excel editors on each turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat?.id, closeAllToolsAndConnectors]);


  // Listen for "Nuevo chat" button click to reset all states
  React.useEffect(() => {
    const handleResetChatState = () => {
      devLog('🔄 Resetting all chat states (New Chat clicked)');
      resetAllToolsAndConnectors();
      setComputerUseStatus('idle');
      setComputerUseScreenshot(null);
    };

    window.addEventListener('resetChatState', handleResetChatState);

    return () => {
      window.removeEventListener('resetChatState', handleResetChatState);
    };
  }, [resetAllToolsAndConnectors]);



  // Additional effect: Load content when Word Connector becomes active and ref is ready
  React.useEffect(() => {
    if (isWordConnectorActive && currentChat && (currentChat as any).isWordConnectorChat && (currentChat as any).wordContent) {
      devLog('📄 Word Connector active, checking if ref is ready...');
      // Try loading content when panel becomes active
      const loadContent = () => {
        if (wordConnectorRef.current) {
          devLog('📄 Loading content into active Word Connector...');
          wordConnectorRef.current?.updateContent((currentChat as any).wordContent);
          return true;
        }
        return false;
      };

      // Try immediately
      if (!loadContent()) {
        // If not ready, try again after a short delay
        const timer = setTimeout(loadContent, 300);
        return () => clearTimeout(timer);
      }
    }
    // `currentChat` itself is intentionally NOT in deps — re-firing on
    // every message append would re-load the Word doc, which loses the
    // user's in-flight edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWordConnectorActive, currentChat?.id]);

  React.useEffect(() => {
    if (chatCreationInitiated.current) {
      return;
    }

    const urlChatId = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('id')
      : null;
    if (urlChatId && currentChat?.id !== urlChatId) {
      selectChat(urlChatId);
      return;
    }

    if (currentChat) {
      return;
    }

    const savedChatId = localStorage.getItem('currentChatId');
    if (savedChatId) {
      selectChat(savedChatId)
      return;
    }
  }, [currentChat, createNewChat, availableModels, selectedModel, selectChat]);

  // Note: Legacy shared chat handling has been removed.
  // Shared content is now handled exclusively by the /share pages which
  // automatically save content and redirect to /chat. This prevents
  // duplicate chat creation that was occurring with the old dual-system approach.
  // Listen for Computer Use extraction completion to refresh chat
  React.useEffect(() => {

    const handleExtractionComplete = (event: Event) => {
      const customEvent = event as CustomEvent;
      devLog('Computer Use extraction completed, refreshing chat...');
      // Refresh the current chat to show new messages
      if (currentChat?.id) {
        setTimeout(() => {
          selectChat(currentChat.id);
        }, 500);
      }
    };

    const handleWebSocketExtractionComplete = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'extraction-completed' && data.data.chatId === currentChat?.id) {
          devLog('WebSocket: Computer Use extraction completed, refreshing chat...');
          setTimeout(() => {
            if (currentChat?.id) {
              selectChat(currentChat.id);
            }
          }, 1000);
        }
      } catch (error) {
        // Ignore parse errors for non-JSON WebSocket messages
      }
    };

    window.addEventListener('computer-use-extraction-complete', handleExtractionComplete);

    // Also listen for WebSocket events if available
    if (typeof window !== 'undefined' && (window as any).computerUseWebSocket) {
      (window as any).computerUseWebSocket.addEventListener('message', handleWebSocketExtractionComplete);
    }

    return () => {
      window.removeEventListener('computer-use-extraction-complete', handleExtractionComplete);
      if (typeof window !== 'undefined' && (window as any).computerUseWebSocket) {
        (window as any).computerUseWebSocket.removeEventListener('message', handleWebSocketExtractionComplete);
      }
    };
  }, [currentChat?.id, selectChat]);

  // File upload logic with instant preview, REAL progress, retry, and
  // source-channel telemetry. All state writes use functional updates
  // so concurrent drops/pastes can't clobber each other.
  const handleAndUploadFiles = React.useCallback(async (
    files: FileList,
    sourceChannel: string = 'picker',
  ) => {
    if (files.length === 0) return;

    let filesToUpload = Array.from(files);

    if (chatType === 'video' || chatType === 'image') {
      const imageFiles = filesToUpload.filter(file => file.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        toast.error("Solo se permiten imágenes en este modo.");
        return;
      }
      filesToUpload = imageFiles;
    }

    // Idempotency key — backend dedupes retries of the SAME batch attempt.
    const idempotencyKey = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Build temp objects with stable IDs we can map to per-file progress.
    const tempFiles = filesToUpload.map((file) => {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      const longPasteMeta = getLongPasteMetadata(file);
      return {
        tempId,
        name: file.name,
        type: file.type,
        size: file.size,
        preview,
        file,
        sourceChannel,
        longPasteMeta,
        isLongPasteDocument: Boolean(longPasteMeta),
        status: 'uploading' as 'uploading' | 'ready' | 'failed',
      };
    });

    setUploadedFiles((cur: any[]) => {
      const next = [...cur, ...tempFiles];
      uploadedFilesRef.current = next;
      return next;
    });

    // Initialize per-temp progress at 0.
    setUploadProgress(prev => {
      const next = { ...prev };
      tempFiles.forEach(tf => { next[tf.tempId] = 0; });
      return next;
    });

    setIsUploading(true);
    let optimisticTimer: ReturnType<typeof setInterval> | null = null;

    try {
      let optimisticPct = 6;
      setUploadProgress(prev => {
        const next = { ...prev };
        tempFiles.forEach(tf => { next[tf.tempId] = Math.max(next[tf.tempId] || 0, optimisticPct); });
        return next;
      });
      optimisticTimer = setInterval(() => {
        optimisticPct = Math.min(96, optimisticPct + Math.max(4, Math.round((96 - optimisticPct) * 0.28)));
        setUploadProgress(prev => {
          const next = { ...prev };
          tempFiles.forEach(tf => { next[tf.tempId] = Math.max(next[tf.tempId] || 0, optimisticPct); });
          return next;
        });
        if (optimisticPct >= 96 && optimisticTimer) {
          clearInterval(optimisticTimer);
          optimisticTimer = null;
        }
      }, 90);

      const dt = new DataTransfer();
      filesToUpload.forEach(file => dt.items.add(file));

      // Real upload progress via XHR (see lib/api.ts uploadFiles).
      // The total covers all files in this batch — we apply the same
      // percent to every temp chip in the batch (multipart form makes
      // per-file progress impossible without a chunked endpoint).
      const response: any = await apiClient.uploadFiles(dt.files, {
        sourceChannel,
        idempotencyKey,
        asyncProcessing: true,
        onProgress: (pct) => {
          setUploadProgress(prev => {
            const next = { ...prev };
            tempFiles.forEach(tf => { next[tf.tempId] = Math.max(next[tf.tempId] || 0, pct); });
            return next;
          });
        },
      });

      if (response.files) {
        // Snap to 100% and swap temps for server entries — preserve the
        // original File blob and preview so the chip thumbnail doesn't
        // flash off during the swap.
        setUploadProgress(prev => {
          const next = { ...prev };
          tempFiles.forEach(tf => { next[tf.tempId] = 100; });
          return next;
        });
        const merged = response.files.map((f: any, idx: number) => ({
          ...f,
          file: tempFiles[idx]?.file ?? f.file,
          preview: tempFiles[idx]?.preview ?? f.preview,
          sourceChannel,
          longPasteMeta: tempFiles[idx]?.longPasteMeta ?? f.longPasteMeta,
          isLongPasteDocument: tempFiles[idx]?.isLongPasteDocument || Boolean(f.isLongPasteDocument),
          status: 'ready' as const,
        }));
        const tempIds = new Set(tempFiles.map(tf => tf.tempId));
        setUploadedFiles((cur: any[]) => {
          const next = [
            ...cur.filter((f: any) => !tempIds.has(f.tempId)),
            ...merged,
          ];
          uploadedFilesRef.current = next;
          return next;
        });

        setTimeout(() => {
          setUploadProgress(prev => {
            const next = { ...prev };
            tempFiles.forEach(tf => { delete next[tf.tempId]; });
            return next;
          });
        }, 500);

        // Quiet on success — the chip itself is the confirmation.
        // (Toast was noisy after every drag-drop.)
      } else {
        // Mark temps as failed so the chip shows a retry button.
        const tempIds = new Set(tempFiles.map(tf => tf.tempId));
        setUploadedFiles((cur: any[]) => {
          const next = cur.map(f => tempIds.has(f.tempId) ? { ...f, status: 'failed', uploadError: 'Respuesta sin archivos' } : f);
          uploadedFilesRef.current = next;
          return next;
        });
        toast.error('La subida falló. Toca el ícono de reintento en el archivo.');
      }
    } catch (error: any) {
      console.error('File upload failed:', error);
      const reason = error?.message || 'Error de subida';
      toast.error(reason);
      // Mark as failed (don't remove) so the user can retry without
      // re-dragging the file.
      const tempIds = new Set(tempFiles.map(tf => tf.tempId));
      setUploadedFiles((cur: any[]) => {
        const next = cur.map(f => tempIds.has(f.tempId) ? { ...f, status: 'failed', uploadError: reason } : f);
        uploadedFilesRef.current = next;
        return next;
      });
      // Previews are intentionally KEPT alive on failure so the chip
      // can render its thumbnail next to the retry button.
    } finally {
      if (optimisticTimer) clearInterval(optimisticTimer);
      setIsUploading(false);
    }
  }, [chatType, setUploadedFiles]);

  /**
   * Retry an upload that previously failed. Reuses the in-memory File
   * object stored on the chip — no need for the user to re-drop.
   */
  const retryUpload = React.useCallback((failedFile: any) => {
    const localFile = getAttachmentLocalFile(failedFile);
    if (!localFile) {
      toast.error('No se puede reintentar — el archivo se perdió. Vuelve a arrastrarlo.');
      return;
    }
    setUploadedFiles((cur: any[]) => {
      const next = cur.filter(f => f.tempId !== failedFile.tempId && f.id !== failedFile.id);
      uploadedFilesRef.current = next;
      return next;
    });
    const dt = new DataTransfer();
    try {
      dt.items.add(localFile);
    } catch {
      toast.error('No se puede reintentar — el archivo se perdió. Vuelve a arrastrarlo.');
      return;
    }
    handleAndUploadFiles(dt.files, failedFile.sourceChannel || 'retry');
  }, [handleAndUploadFiles, setUploadedFiles]);

  React.useEffect(() => {
    handlePasteCaptureActionRef.current = (action: PasteCaptureAction, result: PasteCaptureResult) => {
      if (action === "attach_document") {
        const documentFile = createLongPasteDocumentFile(result.normalizedText);
        const { accepted, rejected } = validateBatch([documentFile], {
          existingCount: uploadedFilesRef.current.length,
        });
        if (rejected.length > 0) {
          rejected.forEach(r => toast.error(r.reason));
          return;
        }
        logIngest({
          source: 'paste-long-text',
          count: accepted.length,
          total_bytes: accepted.reduce((s, f) => s + f.size, 0),
          rejected_count: rejected.length,
          rejected_codes: rejected.map(r => r.code),
          had_text: true,
        });
        handleAndUploadFiles(filesToFileList(accepted), 'paste-long-text');
        toast.success('Texto largo adjuntado como documento.');
      } else if (action === "insert_text") {
        setInput(prev => prev ? `${prev}\n\n${result.normalizedText}` : result.normalizedText);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      }
    };
  });

  // Drag and Drop event handlers with drag counter to prevent flickering
  const dragCounter = React.useRef(0);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragIn = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragOut = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    // Use the unified extractor — pulls from BOTH .files and .items so
    // we catch files dragged from sources where one is empty (Linux
    // Firefox + Edge legacy expose only via .items; Safari often only
    // via .files). Then run the validate-batch gate for clean errors.
    const all = extractFilesFromDataTransfer(e.dataTransfer);
    if (all.length === 0) return;
    const { accepted, rejected } = validateBatch(all, {
      existingCount: uploadedFilesRef.current.length,
    });
    if (rejected.length > 0) {
      // Group identical reasons into a single toast so 8 rejected files
      // don't spam 8 toasts.
      const grouped = rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {});
      Object.entries(grouped).forEach(([reason, n]) => {
        toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
      });
    }
    if (accepted.length > 0) {
      logIngest({
        source: 'drop',
        count: accepted.length,
        total_bytes: accepted.reduce((s, f) => s + f.size, 0),
        rejected_count: rejected.length,
        rejected_codes: rejected.map(r => r.code),
      });
      handleAndUploadFiles(filesToFileList(accepted), 'drop');
    }
  };

  // Window-level drag/drop fallback — without this, dropping an image
  // OUTSIDE the chat-viewport (on the sidebar, top bar, or empty
  // margins of the page) lets the browser's default behavior kick in
  // and OPEN THE IMAGE in a new tab, which is the bug the user
  // reported. The React-level onDrop on chat-viewport works fine, but
  // requires the user to land precisely on that surface.
  //
  // The window handlers below run on the BUBBLE phase (no capture),
  // so a drop inside chat-viewport — where handleDrop calls
  // stopPropagation — never reaches them. Drops outside hit window
  // and route through the same accepted/rejected pipeline. The
  // shared `dragCounter` + `isDragging` state means the same overlay
  // appears regardless of where the drag is hovering.
  React.useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragCounter.current++;
      setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      // dragover MUST preventDefault for drop to fire on this target.
      // Without this, the browser falls back to its default handler
      // (open file in new tab) and our drop handler never runs.
      if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      setIsDragging(false);
      dragCounter.current = 0;
      const all = extractFilesFromDataTransfer(e.dataTransfer);
      if (all.length === 0) return;
      const { accepted, rejected } = validateBatch(all, {
        existingCount: uploadedFilesRef.current.length,
      });
      if (rejected.length > 0) {
        const grouped = rejected.reduce<Record<string, number>>((acc, r) => {
          acc[r.reason] = (acc[r.reason] || 0) + 1;
          return acc;
        }, {});
        Object.entries(grouped).forEach(([reason, n]) => {
          toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
        });
      }
      if (accepted.length > 0) {
        logIngest({
          source: 'drop',
          count: accepted.length,
          total_bytes: accepted.reduce((s, f) => s + f.size, 0),
          rejected_count: rejected.length,
          rejected_codes: rejected.map(r => r.code),
        });
        handleAndUploadFiles(filesToFileList(accepted), 'drop');
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hand-off from GlobalDropRedirector — when a file is dropped on a
  // non-/chat page the redirector navigates here and stashes the
  // File[] on window. Pick them up once and run them through the
  // normal validate→upload pipeline so the gesture feels continuous.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __siraPendingFiles?: File[] };
    const pending = w.__siraPendingFiles;
    if (!pending || pending.length === 0) return;
    delete w.__siraPendingFiles;
    const { accepted, rejected } = validateBatch(pending, {
      existingCount: uploadedFilesRef.current.length,
    });
    if (rejected.length > 0) {
      const grouped = rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {});
      Object.entries(grouped).forEach(([reason, n]) => {
        toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
      });
    }
    if (accepted.length > 0) {
      handleAndUploadFiles(filesToFileList(accepted), 'drop');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Clipboard paste handler — wired to BOTH the textarea (so it fires
   * even when text is pasted) AND a document-level listener (so paste
   * works when the input isn't focused, matching Slack/Discord UX).
   *
   * Behavior matrix:
   *   pure text         → default (browser inserts into textarea)
   *   pure files        → ingest, prevent default
   *   text + files      → ingest files AND let text insert (combined send)
   *   image blob only   → ingest as a synthesized "pasted-<ts>.png" file
   *   pure HTML         → strip to plain text, prevent default
   */
  const handleClipboardPaste = React.useCallback((e: ClipboardEvent | React.ClipboardEvent) => {
    // CRITICAL: never intercept paste while the IME is composing — would
    // scramble the in-flight character (Spanish accent, CJK, etc.).
    if (isComposingRef.current) return;

    const native = ('nativeEvent' in e ? e.nativeEvent : e) as ClipboardEvent;
    const cd = native.clipboardData;
    if (!cd) return;

    const { files, text, html } = extractFromClipboardEvent(native, { includeHtml: true });

    // ─── No files ───────────────────────────────────────────────────
    if (files.length === 0) {
      // text/uri-list — user copied a link from the address bar or a
      // browser tab tab strip. Insert the URL(s) as plain text instead
      // of letting Chrome paste the HTML <a> wrapper.
      const uriList = cd.getData('text/uri-list');
      if (uriList && !text) {
        const urls = uriList.split('\n').map(s => s.trim()).filter(Boolean).filter(u => !u.startsWith('#'));
        if (urls.length > 0) {
          e.preventDefault();
          setInput(prev => prev + (prev ? ' ' : '') + urls.join(' '));
          return;
        }
      }
      let htmlFallbackText: string | null = null;
      if (!text && html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        htmlFallbackText = (tmp.textContent || tmp.innerText || '').trim();
      }
      const pastedText = (text && text.trim()) ? text : htmlFallbackText;
      if (pastedText && shouldCompilePastedTextAsDocument(pastedText)) {
        e.preventDefault();
        // NO chooser popup. Direct paste, always:
        //   · Clearly large content (≥1200 chars, ≥200 words, ≥20 lines)
        //     → attach as document chip next to the input.
        //   · Anything smaller → insert as plain text in the input bar.
        const analyzed = analyzePastedContent(pastedText);
        const isClearlyLarge =
          analyzed.charCount >= 1200 ||
          analyzed.wordCount >= 200 ||
          analyzed.lineCount >= 20;
        const action: PasteCaptureAction = isClearlyLarge ? "attach_document" : "insert_text";
        handlePasteCaptureActionRef.current(action, analyzed);
        return;
      }
      // HTML-only paste (rare — usually browsers attach text/plain too).
      // Strip to text via DOM parsing so we don't lose the content.
      if (!text && htmlFallbackText) {
        e.preventDefault();
        setInput(prev => prev + htmlFallbackText);
      }
      // Otherwise let the browser do its native plain-text paste.
      return;
    }

    // ─── Files present — ingest ─────────────────────────────────────
    const { accepted, rejected } = validateBatch(files, {
      existingCount: uploadedFilesRef.current.length,
    });
    if (rejected.length > 0) {
      const grouped = rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {});
      Object.entries(grouped).forEach(([reason, n]) => {
        toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
      });
    }
    if (accepted.length > 0) {
      // Source-channel taxonomy: synthesized "pasted-…" filename means
      // an image blob arrived without a name (clipboard image, screenshot).
      const isImageOnly = accepted.every(f =>
        f.type.startsWith('image/') && /^pasted-/.test(f.name),
      );
      const channel = isImageOnly ? 'paste-image' : 'paste-files';
      logIngest({
        source: channel,
        count: accepted.length,
        total_bytes: accepted.reduce((s, f) => s + f.size, 0),
        rejected_count: rejected.length,
        rejected_codes: rejected.map(r => r.code),
        had_text: !!text,
      });
      // Prevent default so the OS file path string doesn't get pasted
      // as text next to the file. Then handle text ourselves if present.
      if ('preventDefault' in e) e.preventDefault();
      if (text) setInput(prev => prev + text);
      handleAndUploadFiles(filesToFileList(accepted), channel);
    }
  }, [capturePastedText, handleAndUploadFiles]);

  const handleTextareaPaste = React.useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    handleClipboardPaste(e);
    window.requestAnimationFrame(resizeComposerTextarea);
    window.setTimeout(resizeComposerTextarea, 0);
  }, [handleClipboardPaste, resizeComposerTextarea]);

  // Document-level paste listener — catches pastes when the textarea
  // isn't focused (e.g., user paste into the canvas while reading a
  // previous message). Matches Slack/Discord UX.
  React.useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      // CRITICAL: skip if the React onPaste handler on the textarea
      // already handled this event — `defaultPrevented` is set by the
      // React handler when it ingests files. Without this guard the
      // same screenshot ends up duplicated (React handler + document
      // handler both ingest it).
      if (e.defaultPrevented) return;
      // Also skip when the focused element is one of OUR textareas —
      // even if the React handler decided not to preventDefault (pure
      // text paste), we don't want the doc-level handler stealing it.
      const target = e.target as HTMLElement | null;
      if (target && (target as HTMLTextAreaElement) === textareaRef.current) return;

      const cd = e.clipboardData;
      if (!cd) return;
      const hasFile =
        (cd.files && cd.files.length > 0) ||
        (cd.items && Array.from(cd.items).some(i => i.kind === 'file'));
      if (!hasFile) return;
      handleClipboardPaste(e);
    };
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [handleClipboardPaste]);

  // Soft rate-limit queue — instead of dropping a message when the
  // composer is busy streaming a prior turn, we park it in this ref and
  // flush it automatically when the pipeline goes idle. This keeps the
  // "user types 3 things quickly" flow working without losing text.
  const pendingMsgQueueRef = React.useRef<Array<{ chatId: string | null; msg: string; files: any[] }>>([]);
  const queueBurstTimestampsRef = React.useRef<number[]>([]);
  const handleSendRef = React.useRef<() => void>(() => {});

  // ────────────────────────────────────────────────────────────
  // Sidebar auto-collapse — when the user turns on any composer tool
  // (connectors, web search, image/video/thesis, Voice Studio, etc.)
  // we collapse the left rail for a cleaner workspace. Never auto-
  // reopen; the user restores it via the floating PanelLeftOpen chip.
  // ────────────────────────────────────────────────────────────
  const { open: sidebarOpen, setOpen: setSidebarOpen, isMobile: isSidebarMobile } = useSidebar();

  // ────────────────────────────────────────────────────────────
  // Tool activation → auto-collapse the OUTER (visible) sidebar.
  //
  // useSidebar() resolves to the single AppShell provider, so the
  // header trigger, nav sheet and auto-collapse all point at the same
  // visible sidebar. This is especially important on iOS: duplicate
  // sidebar sheets can leave overlays that swallow taps.
  //
  // Hardening notes:
  //   · Edge-triggered via a ref so deactivating a tool does NOT
  //     re-fire the collapse; reopening the sidebar remains a user
  //     action.
  //   · All mutable bits that the effect reads from are funnelled
  //     through one derived boolean so the dependency array stays
  //     tight and React doesn't retrigger on unrelated renders.
  //   · Mobile viewports are a no-op — the outer sidebar there is a
  //     sheet, collapsing is meaningless.
  //   · Guarded for SSR / non-browser environments.
  // ────────────────────────────────────────────────────────────
  const prevAnyToolActiveRef = React.useRef<boolean>(false);
  const anyToolActive =
    !!isWebSearchActive ||
    !!isSpotifyActive ||
    !!isImageGenerationActive ||
    !!isVideoGenerationActive ||
    !!isComputerUseActive ||
    !!isGmailActive ||
    !!isGoogleCalendarActive ||
    !!isGoogleDriveActive ||
    !!isWordConnectorActive ||
    !!isExcelConnectorActive;
  React.useEffect(() => {
    if (isSidebarMobile) {
      prevAnyToolActiveRef.current = anyToolActive;
      return;
    }
    if (anyToolActive && !prevAnyToolActiveRef.current) {
      setSidebarOpen(false);
    }
    prevAnyToolActiveRef.current = anyToolActive;
  }, [anyToolActive, isSidebarMobile, setSidebarOpen]);

  // ────────────────────────────────────────────────────────────
  // Resizable split — chat ↔ right panel (Word/Excel/preview).
  // Ratio is the LEFT pane's width as a percentage. Persisted in
  // localStorage across sessions, defaults to 50/50. Dragging is
  // constrained by real pixel minimums so neither chat nor preview can
  // collapse into an unusable strip.
  // ────────────────────────────────────────────────────────────
  const SPLIT_STORAGE_KEY = 'siraGPT-split-ratio';
  const SPLIT_LEFT_MIN_PX = 420;
  const SPLIT_RIGHT_MIN_PX = 460;
  const SPLIT_MIN_RATIO = 34;
  const SPLIT_MAX_RATIO = 66;
  const [splitRatio, setSplitRatio] = React.useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = React.useState(false);
  const splitContainerRef = React.useRef<HTMLDivElement | null>(null);

  // Hydrate from localStorage after mount to avoid SSR/CSR mismatch.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
      const n = raw ? parseFloat(raw) : NaN;
      if (!Number.isNaN(n)) {
        setSplitRatio(Math.max(SPLIT_MIN_RATIO, Math.min(SPLIT_MAX_RATIO, n)));
      }
    } catch { /* storage unavailable — stick with default */ }
  }, []);

  const clampSplitRatio = React.useCallback((pct: number, containerWidth?: number) => {
    const width = containerWidth || splitContainerRef.current?.getBoundingClientRect().width || 0;
    if (width <= 0) return Math.max(SPLIT_MIN_RATIO, Math.min(SPLIT_MAX_RATIO, pct));

    const leftMinPct = (SPLIT_LEFT_MIN_PX / width) * 100;
    const rightMinPct = (SPLIT_RIGHT_MIN_PX / width) * 100;
    const min = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, leftMinPct));
    const max = Math.max(min, Math.min(SPLIT_MAX_RATIO, 100 - rightMinPct));
    return Math.max(min, Math.min(max, pct));
  }, []);

  const startSplitDrag = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSplit(true);
    const onMove = (ev: MouseEvent) => {
      const el = splitContainerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(clampSplitRatio(pct, rect.width));
    };
    const onUp = () => {
      setIsDraggingSplit(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(splitRatioRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [clampSplitRatio]);

  const resetSplitRatio = React.useCallback(() => {
    const next = clampSplitRatio(50);
    setSplitRatio(next);
    try { localStorage.setItem(SPLIT_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  }, [clampSplitRatio]);

  // Mirror ratio into a ref so the mouseup handler closure (set up
  // at drag-start) can read the latest value without restarting the
  // effect on every ratio change.
  const splitRatioRef = React.useRef(splitRatio);
  React.useEffect(() => { splitRatioRef.current = splitRatio; }, [splitRatio]);

  const composerPreviewSiblings: AttachmentLike[] = React.useMemo(
    () => uploadedFiles.map((f: any) => toDocumentViewerAttachment(f)),
    [uploadedFiles],
  );
  const composerPreviewAttachment = React.useMemo<AttachmentLike | null>(() => {
    if (composerPreviewIndex === null) return null;
    return composerPreviewSiblings[composerPreviewIndex] || null;
  }, [composerPreviewIndex, composerPreviewSiblings]);

  const openComposerDocumentPreview = React.useCallback((index: number) => {
    if (!uploadedFiles[index]) return;
    setSplitViewContent(null);
    setDocumentPreviewUrl(null);
    setSidePreviewAttachment(null);
    setSidePreviewSiblings([]);
    setActiveSearchActivityId(null);
    setSplitRatio((current) => {
      const balanced = current < 40 || current > 62 ? 48 : current;
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(balanced)); } catch { /* ignore */ }
      return balanced;
    });
    setComposerPreviewIndex(index);
  }, [uploadedFiles]);

  React.useEffect(() => {
    if (composerPreviewIndex === null) return;
    if (composerPreviewIndex >= uploadedFiles.length) {
      setComposerPreviewIndex(uploadedFiles.length > 0 ? uploadedFiles.length - 1 : null);
    }
  }, [composerPreviewIndex, uploadedFiles.length]);

  // Auto-collapse sidebar when any workspace tool activates (connectors,
  // web search, media gen, thesis, Voice Studio, Computer Use, etc.) so
  // the main panel stays clean and wide. Same rules: no auto-reopen;
  // skip on mobile (overlay sidebar).
  React.useEffect(() => {
    if (isSidebarMobile) return;
    const toolWorkspaceActive =
      isWordConnectorActive ||
      isExcelConnectorActive ||
      isImageGenerationActive ||
      isVideoGenerationActive ||
      isWebSearchActive ||
      chatType === "thesis" ||
      chatType === "image" ||
      chatType === "video" ||
      showAudioPanel ||
      isGmailActive ||
      isGoogleCalendarActive ||
      isGoogleDriveActive ||
      isSpotifyActive ||
      isComputerUseActive;
    if (toolWorkspaceActive) {
      setSidebarOpen(false);
    }
  }, [
    isSidebarMobile,
    setSidebarOpen,
    isWordConnectorActive,
    isExcelConnectorActive,
    isImageGenerationActive,
    isVideoGenerationActive,
    isWebSearchActive,
    chatType,
    showAudioPanel,
    isGmailActive,
    isGoogleCalendarActive,
    isGoogleDriveActive,
    isSpotifyActive,
    isComputerUseActive,
  ]);

  // ── Slash-command dispatcher ───────────────────────────────────────────
  // Routes parsed slash commands (/goal, /research) to dedicated backends.
  // Streams progress events via SSE and shows the result in a toast (with a
  // link to copy the full markdown report into the next chat reply).
  //
  // Important: this function does NOT post the user's message into the
  // chat history — slash commands are meta-actions, not regular messages.
  // The result IS surfaced through toast + a final notification with
  // the markdown body so the user can paste it back into the conversation.
  const runSlashCommand = React.useCallback(async (slash: { command: string; remainder: string }) => {
    const query = slash.remainder.trim();
    if (!query) {
      toast.info(`Add a query after /${slash.command} (e.g. /${slash.command} latest progress in X)`);
      return;
    }
    const token = (typeof window !== "undefined" ? localStorage.getItem("token") : null) || "";

    if (slash.command === "goal" || slash.command === "research") {
      const endpoint = slash.command === "goal" ? "/api/research-agent/stream" : "/api/scientific-search";
      const isStream = slash.command === "goal";

      const toastId = toast.loading(
        slash.command === "goal"
          ? `🎯 Goal agent activado — buscando papers...`
          : `🔬 Buscando "${query}" en arXiv/PubMed/OpenAlex/CrossRef/Europe PMC...`,
        { duration: Infinity },
      );

      try {
        const apiBase = (typeof window !== "undefined" && (window as any).NEXT_PUBLIC_API_URL) ||
          (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api");
        const url = apiBase.replace(/\/$/, "") + endpoint.replace(/^\/api/, "");

        if (!isStream) {
          // /research → one-shot POST
          const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ query }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          toast.success(`📚 ${data.count || 0} papers · ${data.providers?.length || 0} sources`, {
            id: toastId,
            duration: 6000,
            description: data.papers?.slice(0, 3).map((p: any) => `• ${p.title}`).join("\n") || "",
          });
        } else {
          // /goal → SSE stream the agent phases
          const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ query, depth: "standard" }),
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let papersSeen = 0;
          let findingsSeen = 0;
          let pagesSeen = 0;
          let lastReport: any = null;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            // SSE frames separated by blank line
            const frames = buf.split("\n\n");
            buf = frames.pop() || "";
            for (const frame of frames) {
              const m = frame.match(/^data:\s*(.*)$/m);
              if (!m) continue;
              try {
                const evt = JSON.parse(m[1]);
                if (evt.type === "paper") papersSeen++;
                if (evt.type === "finding") findingsSeen++;
                if (evt.type === "page") pagesSeen++;
                if (evt.type === "phase") {
                  toast.loading(`🎯 ${evt.phase}: ${evt.label} · ${papersSeen} papers · ${pagesSeen} pages · ${findingsSeen} findings`, { id: toastId });
                }
                if (evt.type === "report") lastReport = evt.report;
              } catch { /* malformed frame */ }
            }
          }
          if (lastReport) {
            toast.success(`✅ Goal completado — ${lastReport.stats.findingsExtracted} findings · ${lastReport.stats.papersFound} papers`, {
              id: toastId,
              duration: 8000,
              description: "Reporte copiado al portapapeles — pégalo en el chat para discutirlo.",
            });
            try {
              await navigator.clipboard.writeText(lastReport.report);
            } catch { /* clipboard denied */ }
          } else {
            toast.error(`⚠️ Goal terminado sin reporte`, { id: toastId });
          }
        }
      } catch (err: any) {
        toast.error(`/${slash.command} failed: ${err?.message || err}`, { id: toastId, duration: 6000 });
      }
      return;
    }

    if (slash.command === "summarize") {
      toast.info(`/summarize "${query.slice(0, 80)}..."`);
      // Future: route to a summarization endpoint with current chat + attachments
      return;
    }

    toast.error(`Comando desconocido: /${slash.command}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = async () => {
    let composerFiles = uploadedFilesRef.current.length > 0 ? [...uploadedFilesRef.current] : [...uploadedFiles];
    // Normalize before trim so zero-width chars don't sneak past the
    // "is it empty?" check, and so we can warn on catastrophic pastes.
    const normalized = normalizeChatInput(input);
    if (shouldWarnUser(normalized)) {
      toast.error(
        `El mensaje supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó al máximo permitido.`,
        { duration: 4500 },
      );
    }
    const rawMsg = normalized.value.trim();
    if (!rawMsg && composerFiles.length === 0) return;

    // ── Slash-command intercept ────────────────────────────────────────
    // When the message starts with /goal or /research (or any other known
    // slash command), bypass the normal chat flow and dispatch to the
    // dedicated backend route. The result is shown via toast + posted
    // back as an assistant message into the conversation when complete.
    const slash = parseSlashPrefix(rawMsg);
    if (slash) {
      setInput("");
      try {
        await runSlashCommand(slash);
      } catch (err: any) {
        toast.error(`Slash command failed: ${err?.message || err}`);
      }
      return;
    }

    if (composerFiles.some(isComposerFileUploadPending)) {
      toast.info("Espera a que el documento llegue al 100% antes de enviarlo.", { duration: 2200 });
      return;
    }

    if (composerFiles.some(isComposerFileUploadFailed)) {
      toast.error("No se pudo adjuntar el documento. Reintenta la subida antes de enviar.");
      return;
    }

    const missingFileIds = composerFiles.filter((file: any) => !resolveUploadFileId(file));
    if (missingFileIds.length > 0) {
      toast.error("El documento no esta listo para enviarse. Vuelve a adjuntarlo si el problema continua.");
      return;
    }

    const msg = rawMsg || buildFileOnlyPrompt(composerFiles);
    const activeFreePreviewTool = isFreePlan
      ? (isImageGenerationActive || chatType === 'image')
        ? 'Imágenes'
        : (isVideoGenerationActive || chatType === 'video')
          ? 'Video'
          : isVoiceGenerationActive
            ? 'Voz'
            : isMusicGenerationActive
              ? 'Música'
              : chatType === 'thesis'
                ? 'Tesis'
                : null
      : null;

    if (activeFreePreviewTool) {
      setSubscribeOpen(true);
      toast.info(`${activeFreePreviewTool} está en vista previa para usuarios FREE. Sube de plan para usarla.`, {
        duration: 3800,
      });
      track("premium_tool_preview.blocked_send", {
        tool: activeFreePreviewTool.toLowerCase(),
        plan: currentPlan,
      });
      return;
    }

    // Capture the user's intent to send BEFORE the busy-queue branch
    // so queued messages count toward the same funnel as immediately-
    // sent ones. Properties stay non-PII: only the shape of the
    // message (length, attachments) and the routing context (model).
    track("chat.message_sent", {
      text_length: rawMsg.length,
      has_text: rawMsg.length > 0,
      attachment_count: composerFiles.length,
      model: selectedModel || null,
    });

    const isBusy = isCurrentChatStreaming || isCurrentChatLocalJobBusy || isUploading;

    if (isBusy) {
      // Park the message — we'll drain the queue once the busy flags
      // flip back to idle (see the useEffect watching busy state).
      pendingMsgQueueRef.current.push({ chatId: currentChat?.id ?? null, msg, files: composerFiles });
      setInput("");
      uploadedFilesRef.current = [];
      setUploadedFiles([]);
      const now = Date.now();
      queueBurstTimestampsRef.current = queueBurstTimestampsRef.current.filter(t => now - t < 5000);
      queueBurstTimestampsRef.current.push(now);
      // Only surface the toast when the user actually triggers the
      // "3+ in 5s" burst condition — otherwise a single queued message
      // during a long stream would nag them.
      if (queueBurstTimestampsRef.current.length >= 3 && pendingMsgQueueRef.current.length === 1) {
        toast.info("Procesando tus mensajes…", { duration: 2500 });
      }
      return;
    }

    // Handle rewrite request
    if (selectedWordText) {
      setIsRewriting(true);
      setInput("");

      // Get full document context
      const fullDocumentContent = wordConnectorRef.current?.getHTML() || '';

      // Construct prompt with full context but focus on selected text
      const rewritePrompt = `You are editing a specific part of a document.
      
CONTEXT:
The user has selected the following text to edit:
"${selectedWordText}"

FULL DOCUMENT CONTEXT (for reference only):
${fullDocumentContent}

USER COMMAND:
${msg}

INSTRUCTIONS:
1. Apply the user's command ONLY to the selected text.
2. Use the full document context to ensure consistency in tone, style, and content, but DO NOT rewrite the whole document.
3. Return ONLY the rewritten version of the selected text.
4. Do NOT include any explanations, quotes, or conversational filler.
5. If the user asks to "summarize", summarize only the selected text.
6. If the user asks to "fix grammar", fix it only for the selected text.

REWRITTEN TEXT:`;

      let accumulatedContent = '';
      const streamId = crypto.randomUUID();

      await apiClient.generateWordStream(
        {
          provider: selectProvider,
          model: selectedModel,
          prompt: msg,
          chatId: currentChat?.id,
          streamId,
          mode: 'rewrite',
          selectedText: selectedWordText,
        },
        (chunk) => {
          accumulatedContent += chunk;
        },
        () => {
          // Stream is complete, clean up the response and replace the text
          if (wordConnectorRef.current) {
            // Remove surrounding quotes if AI added them
            let cleanedContent = accumulatedContent.trim();
            if ((cleanedContent.startsWith('"') && cleanedContent.endsWith('"')) ||
              (cleanedContent.startsWith("'") && cleanedContent.endsWith("'"))) {
              cleanedContent = cleanedContent.slice(1, -1);
            }
            wordConnectorRef.current.replaceSelection(cleanedContent);
          }
          setIsRewriting(false);
          setSelectedWordText(null); // Clear the selection display
          toast.success('Text has been rewritten.');
        },
        (error) => {
          console.error('Rewrite error:', error);
          toast.error(error.message || 'Failed to rewrite text.');
          setIsRewriting(false);
        }
      );
      return; // Stop further execution
    }
    const filesToSend = [...composerFiles];
    const buildImageEditPrompt = (rawPrompt: string) => {
      const editFile = filesToSend.find((file: any) => file?.editRegion);
      if (!editFile?.editRegion) return rawPrompt;
      const region = editFile.editRegion;
      return `${rawPrompt}\n\nImage edit target: modify only the marked region of the attached image. Region in percentages from the image top-left: x=${Math.round(region.x || 0)}%, y=${Math.round(region.y || 0)}%, width=${Math.round(region.width || 0)}%, height=${Math.round(region.height || 0)}%. Keep the rest of the image visually unchanged.`;
    };
    setInput("");
    // The message is on its way — drop the saved draft so the next
    // visit to this chat starts with a clean composer instead of
    // re-showing the text the user just sent.
    chatDraft.clear();
    uploadedFilesRef.current = [];
    setUploadedFiles([]);

    let isNewChat = !currentChat;
    let chatToUpdate = currentChat;
    let duumychatId = `temp-chat-${Date.now()}`

    // Handle Word Connector - generate content directly to editor
    if (isWordConnectorActive) {
      try {
        setIsGeneratingWord(true);

        // Create or get chat (IMPORTANT: do NOT trigger generic AI generation here)
        let activeChat = currentChat;
        if (!activeChat) {
          const newChat = await createNewChat('text', msg, undefined, {
            skipInitialProcessing: true,
            isWordConnectorChat: true
          });
          activeChat = (newChat as any) || currentChat;

          if (activeChat?.id) {
            await selectChat(activeChat.id);
          }
        }

        // Add user message to chat for display
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat?.id || '',
          role: 'USER' as const,
          content: msg,
          timestamp: new Date().toISOString(),
          files: filesToSend,
        };

        // Update chat with user message
        setCurrentChat(prevChat => {
          if (!prevChat && activeChat) {
            return { ...activeChat, messages: [userMessage] };
          }
          if (prevChat) {
            const updatedMessages = [...(prevChat.messages || []), userMessage];
            return { ...prevChat, messages: updatedMessages };
          }
          return prevChat;
        });

        const streamId = crypto.randomUUID();
        let accumulatedContent = '';

        // Stream AI response for Word document using dedicated endpoint
        await apiClient.generateWordStream(
          {
            provider: selectProvider,
            model: selectedModel,
            prompt: msg,
            chatId: activeChat?.id,
            files: collectUploadFileIds(filesToSend),
            streamId,
          },
          (chunk) => {
            accumulatedContent += chunk;
            // Update Word editor in real-time
            if (wordConnectorRef.current) {
              wordConnectorRef.current.updateContent(accumulatedContent);
            }
          },
          () => {
            setIsGeneratingWord(false);
            toast.success('Documento generado exitosamente');
            // Final update
            if (wordConnectorRef.current && accumulatedContent) {
              wordConnectorRef.current.updateContent(accumulatedContent);
            }
            // Add AI response message to chat for display
            const aiMessage = {
              id: `msg-ai-${Date.now()}`,
              chatId: activeChat?.id || '',
              role: 'ASSISTANT' as const,
              content: 'Documento generado en el editor de Word',
              timestamp: new Date().toISOString(),
            };
            setCurrentChat(prevChat => {
              if (!prevChat) return prevChat;
              const updatedMessages = [...(prevChat.messages || []), aiMessage];
              return { ...prevChat, messages: updatedMessages };
            });
            // Refresh chat to get updated messages from database
            if (activeChat?.id) {
              setTimeout(() => {
                selectChat(activeChat.id);
              }, 500);
            }
          },
          (error) => {
            setIsGeneratingWord(false);
            console.error('Word generation error:', error);
            toast.error(error.message || 'Error al generar documento');
          }
        );
      } catch (error: any) {
        setIsGeneratingWord(false);
        console.error('Word Connector error:', error);
        toast.error(error?.message || 'Error al generar documento');
      }
      return; // IMPORTANT: Stop execution here - no other API calls should be made
    }

    // Handle Excel Connector - generate content directly into the Syncfusion Spreadsheet
    if (isExcelConnectorActive) {
      try {
        setIsGeneratingExcel(true);

        // Create or get chat (IMPORTANT: do NOT trigger generic AI generation here)
        let activeChat = currentChat;
        if (!activeChat) {
          const newChat = await createNewChat('text', msg, undefined, {
            skipInitialProcessing: true,
            isExcelConnectorChat: true
          } as any);
          activeChat = (newChat as any) || currentChat;

          if (activeChat?.id) {
            await selectChat(activeChat.id);
          }
        }

        // Add user message to chat for display
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat?.id || '',
          role: 'USER' as const,
          content: msg,
          timestamp: new Date().toISOString(),
          files: filesToSend,
        };

        setCurrentChat(prevChat => {
          if (!prevChat && activeChat) {
            return { ...activeChat, messages: [userMessage] };
          }
          if (prevChat) {
            const updatedMessages = [...(prevChat.messages || []), userMessage];
            return { ...prevChat, messages: updatedMessages };
          }
          return prevChat;
        });

        // Generate Excel using simple POST request (no streaming)
        const response = await apiClient.generateExcel({
          provider: selectProvider,
          model: selectedModel,
          prompt: msg,
          chatId: activeChat?.id,
          files: collectUploadFileIds(filesToSend),
        });

        setIsGeneratingExcel(false);

        try {
          const parsedResponse = response.data;
          devLog('Parsed Excel response:', parsedResponse);

          // Check if response has both workbook and actions (chart support)
          let workbookData = parsedResponse;
          let chartActions = [];

          if (parsedResponse.workbook && parsedResponse.actions) {
            // New format with chart actions
            workbookData = parsedResponse.workbook;
            chartActions = parsedResponse.actions;
            devLog('Chart actions detected:', chartActions);
          }

          if (excelConnectorRef.current) {
            excelConnectorRef.current.loadWorkbook(workbookData, chartActions);

            if (chartActions.length > 0) {
              toast.success(`Excel generated with ${chartActions.length} chart(s)!`);
            } else {
              toast.success('Excel generated successfully');
            }
          } else {
            console.error('Excel connector ref is not available');
            toast.error('Excel connector not ready');
          }

          // Add AI response message to chat for display
          const aiMessage = {
            id: `msg-ai-${Date.now()}`,
            chatId: activeChat?.id || '',
            role: 'ASSISTANT' as const,
            content: 'Excel generated in spreadsheet editor',
            timestamp: new Date().toISOString(),
          };
          setCurrentChat(prevChat => {
            if (!prevChat) return prevChat;
            const updatedMessages = [...(prevChat.messages || []), aiMessage];
            return { ...prevChat, messages: updatedMessages };
          });

          if (activeChat?.id) {
            setTimeout(() => {
              selectChat(activeChat.id);
            }, 500);
          }
        } catch (e) {
          console.error('Failed to process Excel response', e);
          toast.error('Failed to load generated Excel');
        }
      } catch (error: any) {
        setIsGeneratingExcel(false);
        console.error('Excel Connector error:', error);
        toast.error(error?.message || 'Failed to generate Excel');
      }

      return;
    }

    // Handle thesis type early - before adding optimistic messages
    // This ensures proper chat creation and message sync for new thesis chats
    if (chatType === 'thesis' && isNewChat) {
      try {
        const topics = msg.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (topics.length >= 1) {
          // For new thesis chats, create directly without optimistic messages
          // createNewChat will handle chat creation and message setup properly
          const newChat = await createNewChat('thesis', msg);
          if (newChat?.id) {
            // Select the newly created chat to show messages properly
            setTimeout(async () => {
              await selectChat(newChat.id);
            }, 300);
          }
        } else {
          toast.error('Please provide at least 1 research topic for thesis generation.\n\nExample: "Artificial Intelligence in Healthcare" or "AI in Healthcare, ML Ethics"');
        }
        return;
      } catch (error: any) {
        console.error('Thesis generation error:', error);
        toast.error(error?.message || 'Thesis generation failed. Please try again.');
        return;
      }
    }

    // Optimistically add the user message to the UI immediately.
    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: currentChat?.id || duumychatId,
      role: 'USER' as const,
      content: msg,
      timestamp: new Date().toISOString(),
      files: filesToSend,
    };
    const assistantPlaceholder = {
      id: `msg-assistant-processing-${Date.now()}`,
      chatId: currentChat?.id || duumychatId,
      role: 'ASSISTANT' as const,
      content: '',
      timestamp: new Date().toISOString(),
    };

    if (isNewChat) {
      const tempChat = {
        id: userMessage.chatId,
        title: msg.substring(0, 30),
        messages: [userMessage, assistantPlaceholder],
        customGptId: null,
        customGpt: null,
      };
      setCurrentChat(tempChat as any);
      chatToUpdate = tempChat as any;
    } else {
      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), userMessage];
        return { ...prevChat, messages: updatedMessages };
      });
    }


    try {
      // After optimistic update, run the logic.
      // For existing chats, we pass `true` to `addMessage` to skip re-adding the user message.
      // For new chats, `createNewChat` will handle creating the chat, and the context will replace the temp chat.

      if (isWebSearchActive) {
        await handleWebSearch(msg);
        return;
      }
      if (isGmailActive) {
        await handleGmailCommand(msg);
        return;
      }
      if (isGoogleCalendarActive || isGoogleDriveActive) {
        await handleGoogleServicesCommand(msg);
        return;
      }
      if (isSpotifyActive) {
        await handleSpotifyCommand(msg);
        return;
      }
      if (isImageGenerationActive || chatType === 'image') {
        await handleImageGeneration(buildImageEditPrompt(msg), collectUploadFileIds(filesToSend));
        return;
      }
      if (isVideoGenerationActive || chatType === 'video') {
        await handleVideoGeneration(msg, collectUploadFileIds(filesToSend));
        return;
      }
      if (chatType === 'thesis' && !isNewChat) {
        // Handle thesis generation for existing chats only
        // New thesis chats are handled earlier in the function
        const topics = msg.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (topics.length >= 1) {
          await addThesisMessage(topics);
        } else {
          // Remove the optimistic messages since validation failed
          setCurrentChat(prevChat => {
            if (!prevChat) return prevChat;
            return {
              ...prevChat,
              messages: prevChat.messages.filter(msg =>
                msg.id !== userMessage.id && msg.id !== assistantPlaceholder.id
              )
            };
          });
          toast.error('Please provide at least 1 research topic for thesis generation.\n\nExample: "Artificial Intelligence in Healthcare" or "AI in Healthcare, Machine Learning Ethics"');
        }
        return;
      }
      if (isComputerUseActive || chatType === 'computer-use') {
        // Handle Computer Use with the hook
        let chatId = currentChat?.id;

        // If no current chat, create a new one first
        if (!chatId) {
          devLog('Creating new chat for computer use...');
          const newChat = await createNewChat('computer-use', msg);
          chatId = newChat.id;

          // Immediately select the new chat to show it in UI and wait for it to load
          devLog('Selecting newly created chat:', chatId);
          await selectChat(chatId ?? '');

          // Wait longer for UI to fully update and messages to load
          await new Promise(resolve => setTimeout(resolve, 1200));

          // Force a second selection to ensure it's properly displayed
          setTimeout(() => {
            selectChat(chatId!);
          }, 100);
        }

        devLog('Starting computer use with:', {
          task: msg,
          chatId: chatId,
          userId: user?.id
        });

        // Set up listener for extraction completion
        const handleExtractionComplete = (event: Event) => {
          const customEvent = event as CustomEvent;
          devLog('Computer Use extraction completed, refreshing chat...', customEvent.detail);

          // Force refresh the chat to show new extracted data
          if (chatId) {
            devLog('Refreshing chat with ID:', chatId);

            // Multiple refresh attempts to ensure UI updates
            selectChat(chatId);

            setTimeout(() => {
              selectChat(chatId);
            }, 500);

            setTimeout(() => {
              selectChat(chatId);
              window.dispatchEvent(new CustomEvent('chat-messages-refresh', {
                detail: { chatId: chatId }
              }));
            }, 1000);

            // Show success message
            toast.success('Computer Use completed - Chat updated!');
          }
        };

        window.addEventListener('computer-use-extraction-complete', handleExtractionComplete);

        await startComputerUse(msg, chatId, user?.id);

        // Clean up listener
        setTimeout(() => {
          window.removeEventListener('computer-use-extraction-complete', handleExtractionComplete);
        }, 30000); // Remove after 30 seconds

        // Add reasoning steps to chat as they come in
        if (computerUseReasoning.length > 0) {
          const reasoningMessage = {
            id: `msg-computer-use-${Date.now()}`,
            chatId: currentChat?.id || duumychatId,
            role: 'ASSISTANT' as const,
            content: 'Computer Use Agent is working...',
            timestamp: new Date().toISOString(),
            metadata: JSON.stringify({
              type: 'computer_use_reasoning',
              reasoning: computerUseReasoning
            })
          };

          setCurrentChat(prevChat => {
            if (!prevChat) return prevChat;
            const updatedMessages = [...(prevChat.messages || []), reasoningMessage];
            return { ...prevChat, messages: updatedMessages };
          });
        }
        return;
      }



      // Mark that we started handling the message so Stop button can appear immediately
      setSendingChatId(chatToUpdate?.id || userMessage.chatId || null);
      setIsSending(true);
      // Classify intent (can be aborted via Stop button)
      const intentController = new AbortController();
      intentAbortControllerRef.current = intentController;

      const intent = await aiService.classifyIntent(
        msg,
        chatToUpdate?.messages || [],
        intentController.signal
      );

      // Clear controller once done
      intentAbortControllerRef.current = null;

      if (intent === 'image' || intent === 'video') {
        const hasNonImageFiles = filesToSend.some(
          (file) => !file.type?.startsWith('image/')
        );
        if (hasNonImageFiles) {
          toast.error("Solo se permiten archivos de imagen para esta tarea.");
          // Note: The optimistic message is already shown. This is a trade-off.
          // A more complex implementation could remove the optimistic message on validation failure.
          return;
        }
      }

      const runContextPipeline = async (pipelineIntent: ChatIntent) => {
        if (isNewChat) {
          await createNewChat('text', msg, filesToSend, { initialIntent: pipelineIntent });
        } else {
          await addMessage(msg, filesToSend, chatToUpdate, true, pipelineIntent);
        }
      };

      switch (intent) {
        case 'image':
          await handleImageGeneration(buildImageEditPrompt(msg), collectUploadFileIds(filesToSend));
          break;
        case 'video':
          await handleVideoGeneration(msg);
          break;
        case 'ppt':
          await handleAgentTask(msg, filesToSend);
          break;
        case 'webdev':
          await handleWebDevGeneration(msg);
          break;
        case 'figma':
          // Figma flowchart generation is handled in addMessage; pass the
          // already-classified intent so the chat bar does not spend a second
          // classifying the same prompt twice.
          await runContextPipeline(intent);
          break;
        case 'chart':
        case 'math':
        case 'viz':
        case 'doc':
        case 'web_search':
        case 'agent_task':
          await handleAgentTask(msg, filesToSend);
          break;
        case 'text':
          if (shouldRouteTextPromptThroughAgenticRuntime(msg, filesToSend)) {
            await handleAgentTask(msg, filesToSend);
          } else {
            await runContextPipeline(intent);
          }
          break;
        case 'plan':
        case 'artifact':
          await runContextPipeline(intent);
          break;
        default:
          if (shouldRouteThroughAgenticRuntime(intent)) {
            await handleAgentTask(msg, filesToSend);
          } else {
            await runContextPipeline(intent);
          }
          break;
      }
    } catch (err: any) {
      console.error('Send error', err);
      devLog('Error details:', {
        message: err?.message,
        status: err?.status,
        statusCode: err?.statusCode,
        errorData: err?.errorData,
        fullError: err
      });

      // If intent / send was aborted by user (via Stop), just exit silently.
      if (err?.name === 'AbortError') {
        return;
      }

      const message = (err && (err.message || '')) as string;
      const status = err?.status || err?.statusCode || (err?.response && err.response.status);
      const errorData = err?.errorData;

      devLog('Checking error conditions:', {
        status,
        message,
        errorData,
        is429: status === 429,
        isMonthlyLimit: isMonthlyLimitError(message),
        isErrorDataMonthlyLimit: errorData && isMonthlyLimitError(errorData.error || '')
      });

      // Check for monthly API limit exceeded error - handle specific API format
      if (status === 429 ||
        isMonthlyLimitError(message) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        devLog('API limit error detected, opening upgrade modal', { status, message, errorData });

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);

        // Extract usage information if available
        let usageInfo = '';
        if (errorData && errorData.usage) {
          const { current, limit } = errorData.usage;
          usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
        }

        // Show proper error message in UI
        const errorMessage = {
          id: `msg-error-${Date.now()}`,
          chatId: chatToUpdate?.id || 'unknown',
          role: 'ASSISTANT' as const,
          content: `Monthly API limit exceeded.${usageInfo} Please upgrade your plan to continue using the service.`,
          timestamp: new Date().toISOString(),
          error: 'Monthly API limit exceeded',
        };

        setCurrentChat(prevChat => {
          if (!prevChat || prevChat.id !== (chatToUpdate?.id || userMessage.chatId)) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), errorMessage];
          return { ...prevChat, messages: updatedMessages };
        });

        toast.error(`Monthly API limit exceeded.${usageInfo ? ' ' + usageInfo : ''} Please upgrade to continue.`);
        return;
      }

      // For other errors, show generic error message
      toast.error(err?.message || 'An error occurred. Please try again.');

      // Add error message to chat
      const errorMessage = {
        id: `msg-error-${Date.now()}`,
        chatId: chatToUpdate?.id || 'unknown',
        role: 'ASSISTANT' as const,
        content: '',
        timestamp: new Date().toISOString(),
        error: err.message || 'An error occurred. Please try again.',
      };

      setCurrentChat(prevChat => {
        if (!prevChat || prevChat.id !== (chatToUpdate?.id || userMessage.chatId)) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), errorMessage];
        return { ...prevChat, messages: updatedMessages };
      });
    } finally {
      setIsSending(false);
      setSendingChatId(null);
      intentAbortControllerRef.current = null;
    }
  }
  const handleGmailCommand = async (prompt: string) => {
    setIsProcessingGmail(true);

    try {
      if (!currentChat) {
        // Create a new Gmail chat like other modes
        await createNewChat('gmail', prompt);
      } else {
        // // Add user message immediately
        // const userMessage = {
        //   id: `msg-user-${Date.now()}`,
        //   chatId: currentChat.id,
        //   role: 'USER' as const,
        //   content: prompt,
        //   timestamp: new Date().toISOString(),
        // };

        // Add processing placeholder
        const assistantPlaceholder = {
          id: `msg-assistant-processing-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: '[PROCESSING_GMAIL]',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });

        // Process with AI like regular chat
        const payload = {
          prompt,
          chatId: currentChat?.id,
          model: selectedModel,
          type: 'gmail',
        };

        const response = await apiClient.generateGmailResponse(payload);

        if (response.requiresConnection) {
          // Handle Gmail connection required
          const updateChatWithConnection = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_GMAIL]') {
                return {
                  ...msg,
                  content: `📧 **Gmail Connection Required**

I can help you with Gmail tasks like:
- Reading your emails
- Sending emails  
- Searching for specific emails
- Managing your inbox

But first, you need to connect your Gmail account securely using the button below.`,
                  metadata: JSON.stringify({
                    type: 'gmail_connection_required',
                    showConnectionCard: true
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithConnection);
          toast.error('Gmail connection required');
        } else {
          // Refresh chat to show AI response
          await selectChat(currentChat?.id ?? "");
          toast.success('Gmail response generated!');
        }
      }
    } catch (error: any) {
      console.error('Gmail error:', error);
      const errorMessage = error.message || 'Gmail request failed. Please try again.';
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        // Update placeholder with limit error
        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (currentChat?.id && prevChat.id !== currentChat.id) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_GMAIL]') {
              return {
                ...msg,
                content: "Monthly API limit exceeded. Please upgrade your plan to continue using Gmail features.",
                error: "Monthly API limit exceeded"
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      // Update placeholder with error
      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[PROCESSING_GMAIL]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
    } finally {
      setIsProcessingGmail(false);
    }
  }

  const handleGoogleServicesCommand = async (prompt: string) => {
    setIsProcessingGoogleServices(true);

    try {
      if (!currentChat) {
        await createNewChat('google_services', prompt);
      } else {
        const isCalendarAction = prompt.toLowerCase().includes('event') || prompt.toLowerCase().includes('meeting') || prompt.toLowerCase().includes('calendar');
        const loadingContent = isCalendarAction ? '[PROCESSING_CALENDAR_ACTION]' : '[PROCESSING_DRIVE_ACTION]';

        const assistantPlaceholder = {
          id: `msg-assistant-processing-${Date.now()}`,
          chatId: currentChat.id,
          role: 'ASSISTANT' as const,
          content: loadingContent,
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });

        const payload = {
          prompt,
          chatId: currentChat?.id,
          model: selectedModel,
        };

        const response = await apiClient.generateGoogleServicesResponse(payload);

        if (response.requiresConnection) {
          const updateChatWithConnection = (prevChat: any) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg: any) => {
              if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
                return {
                  ...msg,
                  content: `**Google Services Connection Required**

I can help you with Google Calendar and Drive tasks. But first, you need to connect your Google account securely.`,
                  metadata: JSON.stringify({
                    type: 'google_services_connection_required',
                    showConnectionCard: true
                  })
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          };

          setCurrentChat(updateChatWithConnection);
          toast.error('Google Services connection required');
        } else {
          await selectChat(currentChat?.id ?? "");
          toast.success('Google Services response generated!');
        }
      }
    } catch (error: any) {
      console.error('Google Services error:', error);
      const errorMessage = error.message || 'Google Services request failed. Please try again.';

      // Check for monthly API limit exceeded error
      if (isMonthlyLimitError(errorMessage)) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (currentChat?.id && prevChat.id !== currentChat.id) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
              return {
                ...msg,
                content: "Monthly API limit exceeded. Please upgrade your plan to continue using Google Services.",
                error: "Monthly API limit exceeded"
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        if (currentChat) {
          setCurrentChat(updateChatWithLimitError);
        }
        return;
      }

      toast.error(errorMessage);

      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      if (currentChat) {
        setCurrentChat(updateChatWithError);
      }
    } finally {
      setIsProcessingGoogleServices(false);
    }
  }

  const handleImageGeneration = async (prompt: string, files?: string[]) => {
    imageAbortControllerRef.current?.abort();
    const controller = new AbortController();
    imageAbortControllerRef.current = controller;
    isGeneratingImageRef.current = true;
    setIsGeneratingImage(true);
    setIsImageGenerationActive(true);
    setChatType('image');

    let activeChat = currentChat as any;
    let activeChatId = activeChat?.id as string | undefined;
    try {
      if (!activeChatId) {
        const newChat = await createNewChat('image', undefined, undefined, {
          skipInitialProcessing: true,
        } as any);
        activeChat = newChat as any;
        activeChatId = activeChat?.id;
      }

      if (!activeChatId) {
        throw new Error('No se pudo crear el chat para generar la imagen.');
      }
      markLocalJobBusy(activeChatId, controller);

      const assistantPlaceholder = {
        id: `msg-assistant-generating-${Date.now()}`,
        chatId: activeChatId,
        role: 'ASSISTANT' as const,
        content: '[GENERATING_IMAGE]',
        timestamp: new Date().toISOString(),
        metadata: JSON.stringify({
          aspectRatio: selectedImageAspectRatio,
          quality: selectedImageQuality,
          imageCount: selectedImageCount,
        }),
      };

      const userMessage = !currentChat ? {
        id: `msg-user-image-${Date.now()}`,
        chatId: activeChatId,
        role: 'USER' as const,
        content: prompt,
        timestamp: new Date().toISOString(),
        files: files || [],
      } : null;

      setCurrentChat(prevChat => {
        if (prevChat && prevChat.id !== activeChatId) return prevChat;
        const baseChat = prevChat?.id === activeChatId
          ? prevChat
          : activeChat
            ? { ...activeChat, messages: [] }
            : prevChat;

        if (!baseChat) return prevChat;
        const existingMessages = baseChat.messages || [];
        const updatedMessages = userMessage
          ? [...existingMessages, userMessage, assistantPlaceholder]
          : [...existingMessages, assistantPlaceholder];
        return { ...baseChat, messages: updatedMessages };
      });

      const payload: { prompt: string; chatId?: string; provider: string; model: string; fileId?: string; aspectRatio?: ImageAspectRatio; quality?: ImageQuality; imageCount?: ImageGenerationCount } = {
        prompt,
        chatId: activeChatId,
        provider: providerForMediaModel(selectedImageModel, selectProvider),
        model: selectedImageModel,
        aspectRatio: selectedImageAspectRatio,
        quality: selectedImageQuality,
        imageCount: selectedImageCount,
      };

      if (files && files[0]) {
        payload.fileId = files[0];
      }
      setUploadedFiles([]);
      await apiClient.generateImage(payload, { signal: controller.signal });

      if (!controller.signal.aborted) {
        if (currentChatIdRef.current === activeChatId) {
          await selectChat(activeChatId);
        }
        toast.success('Imagen generada correctamente');
      }
    } catch (error: any) {
      const wasAbort = controller.signal.aborted || error?.name === 'AbortError';
      if (wasAbort) {
        markImageGenerationStopped();
        return;
      }

      console.error('Image generation failed:', error)
      const errorMessage = error.message || 'Image generation failed. Please try again.';
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[GENERATING_IMAGE]') {
              return {
                ...msg,
                content: 'Monthly API limit exceeded. Please upgrade your plan to continue using image generation.',
                error: 'Monthly API limit exceeded'
              };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        setCurrentChat(updateChatWithLimitError);
        return;
      }

      toast.error(errorMessage);

      const updateChatWithError = (prevChat: any) => {
        if (!prevChat) return prevChat;
        if (prevChat.id !== activeChatId) return prevChat;
        // Find the placeholder and update it with the error
        const newMessages = prevChat.messages.map((msg: any) => {
          if (msg.content === '[GENERATING_IMAGE]') {
            return { ...msg, content: "", error: errorMessage };
          }
          return msg;
        });
        return { ...prevChat, messages: newMessages };
      };

      setCurrentChat(updateChatWithError);
    } finally {
      if (imageAbortControllerRef.current === controller) {
        imageAbortControllerRef.current = null;
      }
      markLocalJobIdle(activeChatId, controller);
      isGeneratingImageRef.current = false;
      setIsGeneratingImage(false)
    }
  }

  const handleVideoGeneration = async (prompt: string, files?: string[]) => {
    let activeChatId = currentChat?.id || null;
    setIsGeneratingVideo(true)
    if (activeChatId) markLocalJobBusy(activeChatId);
    const videoOptions = {
      resolution: selectedVideoResolution,
      aspectRatio: selectedVideoAspectRatio,
      duration: selectedVideoDuration,
      audio: selectedVideoAudio,
      model: selectedVideoModel,
    };
    try {
      if (!currentChat) {
        const newChat = await createNewChat('video', undefined, undefined, {
          skipInitialProcessing: true,
        } as any)
        activeChatId = newChat?.id || activeChatId;
        if (activeChatId) markLocalJobBusy(activeChatId);
        await addVideoMessage(prompt, files, newChat, videoOptions as any)
      } else {
        await addVideoMessage(prompt, files, undefined, videoOptions as any)
      }
      toast.success('Video generation started! This may take 2-5 minutes.')
    } catch (error: any) {
      console.error('Video generation failed:', error)
      const errorMessage = error.message || 'Video generation failed. Please try again.';
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Monthly API limit exceeded. Please upgrade to continue.');
        return;
      }

      toast.error(errorMessage)
    } finally {
      markLocalJobIdle(activeChatId);
      setIsGeneratingVideo(false)
      // Don't auto-reset - user must manually remove
    }
  }

  const handleWebDevGeneration = async (prompt: string) => {
    // Use dedicated webdev streaming API endpoint
    const filesToSend = [...uploadedFiles];
    const professionalPrompt = buildProfessionalCapabilityPrompt('webdev', prompt);
    setUploadedFiles([]); // Clear UI immediately

    try {
      let newChat = currentChat;
      let aiMessagePlaceholder: any;
      if (!currentChat) {
        const response = await apiClient.createChat({
          title: prompt ? prompt.substring(0, 30) : "New Web Dev Chat",
          model: selectedModel,
        });
        newChat = response.chat;
        await selectChat(newChat?.id ?? "");

        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: filesToSend?.length ? collectUploadFileIds(filesToSend) : undefined,
        };
        // Add placeholder for AI response
        aiMessagePlaceholder = {
          id: `msg-ai-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'ASSISTANT' as const,
          content: '',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage, aiMessagePlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      else {
        // Add user message to UI immediately


        // Add placeholder for AI response
        aiMessagePlaceholder = {
          id: `msg-ai-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'ASSISTANT' as const,
          content: '',
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), aiMessagePlaceholder];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      // Call dedicated webdev streaming endpoint
      const streamId = crypto.randomUUID();
      const payload = {
        prompt: professionalPrompt,
        displayPrompt: prompt,
        chatId: newChat?.id || '',
        provider: selectProvider,
        model: selectedModel,
        files: collectUploadFileIds(filesToSend),
        streamId: streamId
      };

      // Use streaming webdev API
      await apiClient.generateWebDevStream(
        payload,
        (chunk) => {
          // Update AI message content with streaming chunks
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: msg.content + chunk };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          });
        },
        () => {
          // Stream completed
          devLog('Web development generation completed');
        },
        (error) => {
          console.error('Web development generation error:', error);
          toast.error(error.message || 'Web development generation failed');
        }
      );

    } catch (error: any) {
      console.error('Web development generation error:', error);
      toast.error(error.message || 'Web development generation failed');
    }
  };

  const handlePPTGeneration = async (prompt: string, files?: any[]) => {
    setIsGeneratingPPT(true);
    try {
      const professionalPrompt = buildProfessionalCapabilityPrompt('ppt', prompt);
      let newChat = currentChat;
      if (!currentChat) {
        const response = await apiClient.createChat({
          title: prompt ? prompt.substring(0, 30) : "Nuevo chat",
          model: selectedModel,
        });
        newChat = response.chat;
        await selectChat(newChat?.id ?? "");

        // Only add user message for new chat (existing chat already has it from handleSend)
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: files,
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }
      // If currentChat exists, user message already added in handleSend
      const assistantPlaceholder = {
        id: `msg-assistant-generating-ppt-${Date.now()}`,
        chatId: newChat?.id || '',
        role: 'ASSISTANT' as const,
        content: '[GENERATING_PPT]',
        timestamp: new Date().toISOString(),
      };

      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
        return { ...prevChat, messages: updatedMessages };
      });

      const payload = {
        prompt: professionalPrompt,
        displayPrompt: prompt,
        chatId: newChat?.id || '',
        provider: selectProvider,
        model: selectedModel,
        files: collectUploadFileIds(files || [])
      };

      const response = await apiClient.generatePPT(payload);
      await selectChat(newChat?.id ?? "");

      toast.success(`Presentation created with ${response.slideCount} slides!`);
    } catch (error: any) {
      console.error('PPT generation failed:', error);
      toast.error(error.message || 'PPT generation failed');
    } finally {
      setIsGeneratingPPT(false);
    }
  };

  // Vector PPT Generation (Gamma-style, pure vector graphics)
  const handleVectorPPTGeneration = async (prompt: string, files?: any[]) => {
    setIsGeneratingPPT(true);
    try {
      const professionalPrompt = buildProfessionalCapabilityPrompt('ppt', prompt);
      let newChat = currentChat;
      if (!currentChat) {
        const response = await apiClient.createChat({
          title: prompt ? prompt.substring(0, 30) : "New Vector PPT",
          model: selectedModel,
        });
        newChat = response.chat;
        await selectChat(newChat?.id ?? "");

        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: newChat?.id || '',
          role: 'USER' as const,
          content: prompt,
          timestamp: new Date().toISOString(),
          files: files,
        };

        setCurrentChat(prevChat => {
          if (!prevChat) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      const assistantPlaceholder = {
        id: `msg-assistant-generating-vector-ppt-${Date.now()}`,
        chatId: newChat?.id || '',
        role: 'ASSISTANT' as const,
        content: '[GENERATING_VECTOR_PPT]',
        timestamp: new Date().toISOString(),
      };

      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), assistantPlaceholder];
        return { ...prevChat, messages: updatedMessages };
      });

      const payload = {
        prompt: professionalPrompt,
        displayPrompt: prompt,
        chatId: newChat?.id || '',
        provider: selectProvider,
        model: selectedModel,
        files: collectUploadFileIds(files || [])
      };

      const response = await apiClient.generateVectorPPT(payload);

      await selectChat(newChat?.id ?? "");

      toast.success(`🎨 Vector presentation created with ${response.slideCount} slides! (${response.colorScheme} theme)`);
    } catch (error: any) {
      console.error('Vector PPT generation failed:', error);
      toast.error(error.message || 'Vector PPT generation failed');
    } finally {
      setIsGeneratingPPT(false);
    }
  };

  // Keep a ref to the latest handleSend so the queue-drain effect below
  // can invoke the closure that sees current state — React declarations
  // would otherwise freeze the version from initial render.
  React.useEffect(() => { handleSendRef.current = handleSend; });

  // Drain queued messages when the pipeline goes idle. Each drain
  // re-populates the composer from the queue and fires handleSend on the
  // next tick so React has a chance to commit the setInput/setFiles
  // updates before the send guard reads them.
  React.useEffect(() => {
    const isBusy = isCurrentChatStreaming || isCurrentChatLocalJobBusy || isUploading;
    if (isBusy) return;
    if (pendingMsgQueueRef.current.length === 0) return;
    const queueChatId = currentChat?.id ?? null;
    const nextIndex = pendingMsgQueueRef.current.findIndex((item) => item.chatId === queueChatId);
    if (nextIndex < 0) return;
    const [next] = pendingMsgQueueRef.current.splice(nextIndex, 1);
    if (!next) return;
    setInput(next.msg);
    uploadedFilesRef.current = next.files || [];
    setUploadedFiles(next.files || []);
    const t = setTimeout(() => { handleSendRef.current(); }, 0);
    return () => clearTimeout(t);
  }, [currentChat?.id, isCurrentChatStreaming, isCurrentChatLocalJobBusy, isUploading, setUploadedFiles]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Prevent Enter key from adding new line when not holding Shift
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === "Escape") {
      // Esc cascade — peel one layer of context per press so the user
      // can back out without reaching for the mouse:
      //   1. Voice Studio open → close it
      //   2. Any active tool/connector → close all
      //   3. Otherwise → blur the textarea
      if (showAudioPanel) {
        e.preventDefault()
        setShowAudioPanel(false)
        return
      }
      if (hasActiveTools) {
        e.preventDefault()
        closeAllToolsAndConnectors()
        return
      }
      ;(e.currentTarget as HTMLTextAreaElement).blur()
    }
  }

  const removeFile = (index: number) => {
    setUploadedFiles((cur: any[]) => {
      const next = cur.filter((_, i) => i !== index);
      uploadedFilesRef.current = next;
      return next;
    });
    setComposerPreviewIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      return index < current ? current - 1 : current;
    });
  }

  const restoreLongPasteToInput = React.useCallback((file: any, index: number) => {
    const metadata = getLongPasteMetadata(file);
    if (!metadata?.text) return;
    setInput(prev => prev ? `${prev}\n\n${metadata.text}` : metadata.text);
    setUploadedFiles((cur: any[]) => cur.filter((_, i) => i !== index));
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [setUploadedFiles]);

  // "Initial" state = the empty-canvas + hero greeting + example chips.
  // We surface it when there's no current chat at all OR when the
  // chat exists but has zero rendered messages (right after
  // `clearCurrentChat`, or a fresh chat created without a seed
  // assistant turn). The previous logic only checked `!currentChat`,
  // which left cleared chats stuck on a blank ScrollArea.
  const hasRenderableMessages = (currentChat?.messages?.length || 0) > 0
  const isInitial =
    !isWordConnectorActive &&
    !isExcelConnectorActive &&
    !hasRenderableMessages

  // Any active tool/connector/thesis mode? Used to conditionally render
  // the "tool pills" row below the input — if nothing is active, we
  // hide the entire bar so the composer stays a clean pill.
  const hasActiveTools = (
    isWebSearchActive || isImageGenerationActive || isVoiceGenerationActive || isMusicGenerationActive || isVideoGenerationActive || isComputerUseActive
    || isGmailActive || isGoogleCalendarActive || isGoogleDriveActive
    || isSpotifyActive || isWordConnectorActive || isExcelConnectorActive
    || chatType === 'thesis'
  );
  const isMediaToolActive = isImageGenerationActive || isVoiceGenerationActive || isMusicGenerationActive || isVideoGenerationActive;
  const isSendingForCurrentChat = isSending && sendingChatId === currentChatId;
  const isStopButtonVisible = isCurrentChatLoading || isCurrentChatStreaming || (pendingStop && isCurrentChatStreaming) || isSendingForCurrentChat || isCurrentChatLocalJobBusy;

  // Shared props bundle for <ActiveToolsDisplay /> — the component is
  // now rendered in a different spot (below the input instead of above)
  // but the prop contract is identical, so centralising it avoids
  // drift between the two composer instances (initial vs in-chat).
  const activeToolsProps = {
    isWebSearchActive, setIsWebSearchActive,
    isImageGenerationActive, setIsImageGenerationActive,
    isGeneratingImage,
    selectedImageAspectRatio, setSelectedImageAspectRatio,
    selectedImageQuality, setSelectedImageQuality,
    selectedImageCount, setSelectedImageCount,
    selectedImageModel, setSelectedImageModel,
    isVoiceGenerationActive, setIsVoiceGenerationActive,
    selectedVoiceModel, setSelectedVoiceModel,
    selectedVoiceLanguage, setSelectedVoiceLanguage,
    selectedVoiceAccent, setSelectedVoiceAccent,
    selectedVoiceStability, setSelectedVoiceStability,
    selectedVoiceEffect, setSelectedVoiceEffect,
    isMusicGenerationActive, setIsMusicGenerationActive,
    selectedMusicModel, setSelectedMusicModel,
    selectedMusicStyle, setSelectedMusicStyle,
    selectedMusicMood, setSelectedMusicMood,
    selectedMusicDuration, setSelectedMusicDuration,
    selectedMusicInfluence, setSelectedMusicInfluence,
    selectedMusicEffect, setSelectedMusicEffect,
    setShowAudioPanel, setAudioTab,
    isVideoGenerationActive, setIsVideoGenerationActive,
    selectedVideoResolution, setSelectedVideoResolution,
    selectedVideoAspectRatio, setSelectedVideoAspectRatio,
    selectedVideoDuration, setSelectedVideoDuration,
    selectedVideoAudio, setSelectedVideoAudio,
    selectedVideoModel, setSelectedVideoModel,
    isComputerUseActive, setIsComputerUseActive,
    computerUseStatus,
    isGmailActive, setIsGmailActive,
    isGoogleCalendarActive, setIsGoogleCalendarActive,
    isGoogleDriveActive, setIsGoogleDriveActive,
    isSpotifyActive, setIsSpotifyActive,
    isWordConnectorActive, setIsWordConnectorActive,
    isExcelConnectorActive, setIsExcelConnectorActive,
    selectedModel, setSelectedModel,
    availableModels,
    setSelectedProvider: setSelectedProivder,
    chatType, setChatType,
    handleComputerUseToggle, handleGmailToggle, handleGoogleCalendarToggle,
    handleGoogleDriveToggle, handleSpotifyToggle, handleWordConnectorToggle,
    handleExcelConnectorToggle,
  };

  const rightPanelActive = Boolean(
    showAudioPanel ||
    searchActivityPanelOpen ||
    documentPreviewUrl ||
    composerPreviewAttachment ||
    sidePreviewAttachment ||
    isWordConnectorActive ||
    isExcelConnectorActive ||
    activeArtifact
  );

  const mainPaneAudioPanelEnabled = false;

  const openGrokVoicePanel = React.useCallback(() => {
    setSplitViewContent(null);
    setDocumentPreviewUrl(null);
    setComposerPreviewIndex(null);
    setSidePreviewAttachment(null);
    setSidePreviewSiblings([]);
    setActiveSearchActivityId(null);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    setShowAudioPanel(true);
    setAudioTab('stt');
  }, []);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      resizeComposerTextarea();
      if (currentChat?.id) {
        scrollToBottom();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    currentChat?.id,
    detectedLinks.length,
    hasActiveTools,
    resizeComposerTextarea,
    scrollToBottom,
    selectedWordText,
    uploadedFiles.length,
  ]);

  useVisualViewportCssVars({
    targetRef: chatViewportRef,
    prefix: "chat",
    onSync: syncChatLayoutVars,
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;

    const scheduleSync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncChatLayoutVars();
      });
    };

    syncChatLayoutVars();

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleSync);
      if (chatHeaderRef.current) resizeObserver.observe(chatHeaderRef.current);
      if (chatComposerDockRef.current) resizeObserver.observe(chatComposerDockRef.current);
      if (textareaRef.current) resizeObserver.observe(textareaRef.current);
    }

    window.addEventListener("resize", scheduleSync);
    window.addEventListener("orientationchange", scheduleSync);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("orientationchange", scheduleSync);
    };
  }, [syncChatLayoutVars, isInitial, hasActiveTools, rightPanelActive]);

  const handleWebSearch = async (searchQuery: string) => {
    if (!searchQuery) {
      toast.error('Please enter a search query');
      return;
    }

    let activeChat = currentChat;
    const isNewChat = !activeChat;

    if (!activeChat) {
      try {
        const response = await apiClient.createChat({
          title: `🔍 Web Search: ${searchQuery.substring(0, 30)}`,
          model: selectedModel,
        });
        activeChat = response.chat;
        await selectChat(activeChat?.id ?? "");
        if (!activeChat?.id) {
          toast.error('Failed to create chat for web search');
          return;
        }
      } catch (error) {
        toast.error('Failed to create chat for web search');
        console.error("Error creating chat for web search:", error);
        return;
      }
    }

    setIsWebSearching(true);
    markLocalJobBusy(activeChat.id);
    const requestedTopK = inferAcademicSearchCount(searchQuery);
    const searchTarget = targetForAcademicSearch(requestedTopK);
    const searchBatchSize = Math.min(20, Math.max(5, requestedTopK));

    try {
      // Only add user message for new chat (existing chat already has it from handleSend)
      if (isNewChat) {
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat.id,
          role: 'USER' as const,
          content: `🔍 Web Search: ${searchQuery}`,
          timestamp: new Date().toISOString(),
        };

        setCurrentChat(prevChat => {
          if (!prevChat || prevChat.id !== activeChat.id) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), userMessage];
          return { ...prevChat, messages: updatedMessages };
        });
      }

      // Add a placeholder AI message for the search results
      const aiMessage = {
        id: `msg-ai-${Date.now() + 1}`, // Ensure unique ID
        chatId: activeChat.id,
        role: 'ASSISTANT' as const,
        content: 'Searching the web...', // Initial loading state
        timestamp: new Date().toISOString(),
      };

      // Add AI message to chat
      setCurrentChat(prevChat => {
        if (!prevChat || prevChat.id !== activeChat.id) return prevChat;
        const updatedMessages = [...(prevChat.messages || []), aiMessage];
        return { ...prevChat, messages: updatedMessages };
      });

      setSearchActivities(prev => ({
        ...prev,
        [aiMessage.id]: {
          messageId: aiMessage.id,
          query: searchQuery,
          target: searchTarget,
          batchSize: searchBatchSize,
          topK: requestedTopK,
          providers: [],
          startedAt: Date.now(),
          updatedAt: Date.now(),
          status: "running",
          totalCollected: 0,
          entries: [],
        },
      }));

      // The chat bubble stays minimal, but it is now a real activity
      // trigger. ReactMarkdown renders this controlled raw HTML through
      // the central rehype-sanitize schema; the parent message list
      // delegates clicks by data-search-activity-id so we do not need
      // to mutate MessageComponent.
      //
      // The badge now carries:
      //   - phase label (Buscando · Recopilando · Seleccionando · Validando · Sintetizando)
      //   - a real determinate progress bar (0-100%)
      //   - an inline counter (12/50 fuentes)
      //   - per-provider chips with their counts (Scopus 8 · OpenAlex 12 · …)
      //   - elapsed time
      // It is fully accessible (role=status, aria-live=polite) so screen
      // readers announce the phase changes.
      const renderStatus = (state: {
        label: string;
        percent?: number;
        counter?: string;
        providers?: Array<{ name: string; count: number }>;
        phase?: string;
        elapsedMs?: number;
      }) => {
        const safeLabel = escapeHtml(state.label);
        const pct = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)));
        const counter = state.counter ? `<span class="agentic-search-status__counter">${escapeHtml(state.counter)}</span>` : "";
        const elapsed = typeof state.elapsedMs === "number"
          ? `<span class="agentic-search-status__elapsed">${(state.elapsedMs / 1000).toFixed(0)}s</span>` : "";
        const chips = (state.providers || [])
          .filter(p => p && p.count > 0)
          .slice(0, 6)
          .map(p => `<span class="agentic-search-status__chip"><b>${escapeHtml(p.name)}</b><i>${p.count}</i></span>`)
          .join("");
        const chipRow = chips ? `<span class="agentic-search-status__chips" aria-hidden="true">${chips}</span>` : "";
        return (
          `<button type="button" class="agentic-search-status" role="status" aria-live="polite" ` +
          `data-search-activity-id="${escapeHtml(aiMessage.id)}" ` +
          `aria-label="Abrir actividad de búsqueda: ${safeLabel}">` +
          `<span class="agentic-search-status__head">` +
          `<span class="agentic-search-status__bars" aria-hidden="true"><span></span><span></span><span></span></span>` +
          `<span class="agentic-search-status__label">${safeLabel}</span>` +
          (counter || "") + (elapsed || "") +
          `<span class="agentic-search-status__hint">Actividad</span>` +
          `</span>` +
          `<progress class="agentic-search-status__progress" value="${pct}" max="100">${pct}%</progress>` +
          chipRow +
          `</button>`
        );
      };

      const updateBubble = (content: string) => {
        setCurrentChat(prev => {
          if (!prev || prev.id !== activeChat.id) return prev;
          const newMessages = prev.messages.map(msg =>
            msg.id === aiMessage.id ? { ...msg, content } : msg
          );
          return { ...prev, messages: newMessages };
        });
      };

      // Local progress state — the badge re-renders on every event so the
      // user sees real motion (counter, %, providers, elapsed seconds).
      const t0 = Date.now();
      const progress = {
        phase: "init" as "init" | "search" | "collect" | "rank" | "select" | "synth" | "validate" | "done",
        label: "Iniciando búsqueda profesional…",
        percent: 5,
        counter: "" as string,
        providers: [] as Array<{ name: string; count: number }>,
      };
      const renderProgress = () => renderStatus({
        label: progress.label,
        percent: progress.percent,
        counter: progress.counter,
        providers: progress.providers,
        phase: progress.phase,
        elapsedMs: Date.now() - t0,
      });

      // Seed the bubble with the initial animated state right away so
      // the user sees motion the instant they trigger the search.
      updateBubble(renderProgress());

      // Wire the Stop button: composer Stop reads searchAbortControllerRef
      // and calls abort(), which propagates through the SSE fetch and —
      // via req.on('close') in search-agentic.js — tears down the
      // orchestrator mid-run. No wasted provider quota.
      const controller = new AbortController();
      searchAbortControllerRef.current = controller;
      markLocalJobBusy(activeChat.id, controller);

      let finalSummary = '';
      let aborted = false;
      let selectedSources: AgenticSource[] = [];
      let summaryArrived = false;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const recordSearchEvent = (evt: AgenticEvent) => {
        setSearchActivities(prev => {
          const current = prev[aiMessage.id];
          if (!current) return prev;
          return { ...prev, [aiMessage.id]: applySearchActivityEvent(current, evt) };
        });
      };

      const bumpProvider = (name: string, count: number) => {
        const i = progress.providers.findIndex(p => p.name === name);
        if (i >= 0) progress.providers[i].count = Math.max(progress.providers[i].count, count);
        else progress.providers.push({ name, count });
      };

      // Build a polished, validated client-side summary as a fallback
      // when the LLM-driven `summary` event takes too long. Uses the
      // exact `selected.sources` we already have, so we never block
      // the user behind a slow rerank/synthesis call.
      const buildClientSummary = (sources: AgenticSource[]): string => {
        if (!Array.isArray(sources) || sources.length === 0) return "";
        const validate = (s: any) => {
          const checks: string[] = [];
          const hasDoi = !!s.doi && /^10\.\d{4,9}\//i.test(String(s.doi));
          if (hasDoi) checks.push("✓ DOI");
          else if (s.url) checks.push("✓ URL");
          else checks.push("⚠ sin enlace");
          const yr = parseInt(String(s.year || s.published || ""), 10);
          const cutoff = new Date().getUTCFullYear() - 5;
          if (Number.isFinite(yr)) checks.push(yr >= cutoff ? "✓ reciente" : `⚠ ${yr}`);
          const url = String(s.url || s.doi || "").toLowerCase();
          if (/(\.edu|\.gov|\.ac\.|scielo|pubmed|crossref|wiley|springer|elsevier|nature)/.test(url)) {
            checks.push("✓ autoridad");
          }
          return checks.join(" · ");
        };
        const lines: string[] = [];
        lines.push(`## Resultados verificados`);
        lines.push(``);
        lines.push(`Encontré ${sources.length} ${sources.length === 1 ? "fuente" : "fuentes"} relevante${sources.length === 1 ? "" : "s"}, validadas por DOI, año y autoridad de dominio:`);
        lines.push(``);
        sources.forEach((s: any, idx: number) => {
          const link = s.doi ? `https://doi.org/${s.doi}` : (s.url || "");
          const title = link ? `[${(s.title || "(sin título)").trim()}](${link})` : (s.title || "(sin título)").trim();
          const meta = [
            (s.authors && s.authors.length > 0) ? (Array.isArray(s.authors) ? s.authors.slice(0, 3).join(", ") : String(s.authors)) : null,
            s.year ? `(${s.year})` : null,
            s.journal || null,
          ].filter(Boolean).join(" · ");
          lines.push(`${idx + 1}. **${title}**`);
          if (meta) lines.push(`   _${meta}_`);
          lines.push(`   ${validate(s)}`);
          lines.push(``);
        });
        return lines.join("\n");
      };

      await agenticSearchService.runStream(
        {
          query: searchQuery,
          chatId: activeChat.id,
          target: searchTarget,
          batchSize: searchBatchSize,
          topK: requestedTopK,
          signal: controller.signal,
        },
        {
          onEvent: (evt) => {
            recordSearchEvent(evt);
            // Translate the verbose event stream into a real progress
            // state — counter + percent + provider chips + elapsed —
            // so the user sees motion AND substance.
            switch (evt.type) {
              case 'start':
                progress.phase = "search";
                progress.label = `Buscando “${evt.query}”…`;
                progress.percent = 10;
                progress.counter = "";
                updateBubble(renderProgress());
                break;
              case 'batch': {
                progress.phase = "collect";
                const total = Math.max(1, evt.target || 1);
                const done = Math.min(total, evt.totalCollected || 0);
                progress.label = "Recopilando fuentes";
                progress.counter = `${done}/${total} fuentes`;
                progress.percent = 10 + Math.round((done / total) * 50);  // 10→60%
                if ((evt as any).provider) bumpProvider(String((evt as any).provider), done);
                updateBubble(renderProgress());
                break;
              }
              case 'collection_done':
                progress.phase = "collect";
                progress.label = "Recopilación completa";
                progress.counter = `${evt.totalCollected} fuentes únicas`;
                progress.percent = 65;
                updateBubble(renderProgress());
                break;
              case 'ranking_start':
                progress.phase = "rank";
                progress.label = `Validando y rankeando ${evt.pool} fuentes`;
                progress.counter = `top ${evt.topK}`;
                progress.percent = 75;
                updateBubble(renderProgress());
                break;
              case 'selected':
                progress.phase = "select";
                progress.label = `Selección lista · ${evt.topK} fuentes finalistas`;
                progress.counter = "";
                progress.percent = 88;
                selectedSources = (evt as any).sources || [];
                // Render a PRELIMINARY answer immediately — the user
                // already has the validated list even if the LLM
                // synthesis stalls. The badge stays above so the user
                // knows the polished summary is still cooking.
                {
                  const preview = buildClientSummary(selectedSources);
                  if (preview) updateBubble(renderProgress() + "\n\n" + preview);
                  else updateBubble(renderProgress());
                }
                // 12s safety net: if the polished `summary` event
                // doesn't arrive, finalize with the client-side one
                // so the user always gets a complete answer.
                if (!fallbackTimer) {
                  fallbackTimer = setTimeout(() => {
                    if (summaryArrived || aborted) return;
                    const fallback = buildClientSummary(selectedSources);
                    if (fallback) {
                      finalSummary = fallback;
                      progress.phase = "done";
                      progress.label = "Resultado validado";
                      progress.percent = 100;
                      updateBubble(fallback);
                    }
                  }, 12000);
                }
                break;
              case 'aborted':
                aborted = true;
                break;
              default:
                break;
            }
          },
          onSummary: (markdown) => {
            summaryArrived = true;
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            finalSummary = markdown;
            updateBubble(markdown);
          },
          onDone: (stats) => {
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            if (aborted) return;
            const tail = `\n\n---\n*Búsqueda agéntica · ${stats.totalCollected} fuentes recopiladas · ${stats.dedupedCount} únicas · ${stats.selectedCount} seleccionadas` +
              (stats.elapsedMs ? ` · ${(stats.elapsedMs / 1000).toFixed(1)}s` : '') + `*`;
            // Always end with a synthesized answer — never with the
            // progress badge. If we never got a server summary, use
            // the client-side fallback we built from `selected`.
            const body = finalSummary || buildClientSummary(selectedSources) || "_No se recuperaron fuentes válidas para esta búsqueda._";
            updateBubble(body + tail);
            markLocalJobIdle(activeChat.id, controller);
            setIsWebSearching(false);
            searchAbortControllerRef.current = null;
            toast.success('Búsqueda agéntica completada');
            if (activeChat?.id) selectChat(activeChat.id);
          },
          onError: (error) => {
            // AbortError is the Stop-button path — cleanup silently.
            if (controller.signal.aborted || /abort/i.test(error.message || '')) {
              recordSearchEvent({ type: "aborted", reason: "Cancelado por el usuario" });
              updateBubble('🛑 Búsqueda detenida por el usuario.');
              markLocalJobIdle(activeChat.id, controller);
              setIsWebSearching(false);
              searchAbortControllerRef.current = null;
              return;
            }
            console.error('Agentic search failed:', error);
            recordSearchEvent({ type: "error", message: error.message || 'Agentic search failed' });
            const errorMessage = error.message || 'Agentic search failed';
            if (isMonthlyLimitError(errorMessage)) {
              setSubscribeOpen(true);
              toast.error('Monthly API limit exceeded. Please upgrade to continue.');
              updateBubble('Monthly API limit exceeded. Please upgrade your plan to continue using web search.');
              markLocalJobIdle(activeChat.id, controller);
              setIsWebSearching(false);
              searchAbortControllerRef.current = null;
              return;
            }
            toast.error(errorMessage);
            updateBubble(`❌ **Búsqueda fallida:** ${errorMessage}`);
            markLocalJobIdle(activeChat.id, controller);
            setIsWebSearching(false);
            searchAbortControllerRef.current = null;
          },
        },
      );

    } catch (error: any) {
      console.error('Web search failed:', error);
      toast.error(error.message || 'Web search failed');
      markLocalJobIdle(activeChat?.id);
      setIsWebSearching(false);
    }
  };

  // ─── Agent task (Claude-style step cards) ────────────────────────────
  // The chat bubble's `content` becomes a JSON-encoded payload wrapped
  // in a sentinel fence (```agent-task-state ... ```). MessageComponent
  // detects the fence and renders <AgenticStepsRenderer state={...}/>.
  // This way step cards live INSIDE the regular message bubble — no
  // parallel surface to maintain — and the persisted message survives
  // a chat reload (the JSON is the source of truth for replay).
  const handleAgentTask = async (goalText: string, filesToSend: any[] = []) => {
    if (!goalText) {
      toast.error('Please enter a task');
      return;
    }
    const systemContract = PROFESSIONAL_CAPABILITY_CONTRACTS.agent_task || '';
    let activeChat = currentChat;
    const isNewChat = !activeChat;

    if (!activeChat) {
      try {
        const response = await apiClient.createChat({
          title: `{} ${goalText.substring(0, 30)}`,
          model: selectedModel,
        });
        activeChat = response.chat;
        await selectChat(activeChat?.id ?? "");
        if (!activeChat?.id) {
          toast.error('Failed to create chat for the agent task');
          return;
        }
      } catch (err) {
        toast.error('Failed to create chat for the agent task');
        return;
      }
    }

    setIsWebSearching(true); // reuse the busy flag — Stop button is wired the same way
    markLocalJobBusy(activeChat.id);

    try {
      if (isNewChat) {
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat.id,
          role: 'USER' as const,
          content: goalText,
          timestamp: new Date().toISOString(),
          files: filesToSend,
        };
        setCurrentChat(prev => {
          if (!prev || prev.id !== activeChat.id) return prev;
          return { ...prev, messages: [...(prev.messages || []), userMessage] };
        });
      }

      const aiMessage = {
        id: `msg-ai-${Date.now() + 1}`,
        chatId: activeChat.id,
        role: 'ASSISTANT' as const,
        content: '```agent-task-state\n' + JSON.stringify({ ...initialAgentState, steps: [], artifacts: [], approvals: [], checkpoints: [], qualityGates: [], repairs: [] }) + '\n```',
        timestamp: new Date().toISOString(),
      };
      setCurrentChat(prev => {
        if (!prev || prev.id !== activeChat.id) return prev;
        return { ...prev, messages: [...(prev.messages || []), aiMessage] };
      });

      const updateBubble = (state: AgentTaskState) => {
        const fenced = '```agent-task-state\n' + JSON.stringify(state) + '\n```' +
          (state.finalText ? '\n\n' + state.finalText : '');
        setCurrentChat(prev => {
          if (!prev || prev.id !== activeChat.id) return prev;
          return {
            ...prev,
            messages: prev.messages.map(m => m.id === aiMessage.id ? { ...m, content: fenced } : m),
          };
        });
      };

      const controller = new AbortController();
      searchAbortControllerRef.current = controller;
      markLocalJobBusy(activeChat.id, controller);
      currentAgentTaskIdRef.current = null;

      let state: AgentTaskState = { ...initialAgentState, steps: [], artifacts: [], approvals: [], checkpoints: [], qualityGates: [], repairs: [] };
      let taskWasAborted = false;
      try {
        const fileIds = collectUploadFileIds(filesToSend);
        const fileMetadata = buildAgentFileMetadata(filesToSend);
        for await (const evt of agentTaskService.runIterator({
          goal: goalText,
          displayGoal: goalText,
          systemContract,
          files: fileIds,
          fileMetadata,
          chatId: activeChat.id,
          model: selectedModel,
          maxSteps: 80,
          maxRuntimeMs: 2 * 60 * 60 * 1000,
          signal: controller.signal,
        })) {
          const taskIdFromEvent = (evt as any).taskId;
          if (taskIdFromEvent) {
            currentAgentTaskIdRef.current = taskIdFromEvent;
            agentTaskIdsByChatRef.current.set(activeChat.id, taskIdFromEvent);
          }
          state = reduceEvent(state, evt);
          updateBubble(state);
        }
        // Stream closed cleanly — surface the "I'm done but there's
        // nothing to show" failure mode that previously left the
        // bubble empty (no artifact, no final_text, no error event).
        // The renderer hides itself when state.done && !state.error
        // && !hasDeliverable, so without this nudge the user sees a
        // blank message after the spinner disappears.
        const finalTextEmpty = !state.finalText || !state.finalText.trim();
        const noArtifacts = !state.artifacts || state.artifacts.length === 0;
        if (!state.done) {
          state = { ...state, done: true, error: state.error || 'stream_closed_without_done' };
          updateBubble(state);
        } else if (!state.error && finalTextEmpty && noArtifacts) {
          state = { ...state, error: 'El asistente no devolvió respuesta. Reintenta o reformula el pedido.' };
          updateBubble(state);
        }
      } catch (err: any) {
        if (controller.signal.aborted || /abort/i.test(err?.message || '')) {
          taskWasAborted = true;
          state = { ...state, done: true, error: 'aborted' };
          updateBubble(state);
        } else {
          const friendly = normalizeAgentTaskErrorMessage(err);
          state = { ...state, done: true, error: friendly };
          updateBubble(state);
        }
      }

      markLocalJobIdle(activeChat.id, controller);
      setIsWebSearching(false);
      searchAbortControllerRef.current = null;
      currentAgentTaskIdRef.current = null;
      if (taskWasAborted || state.error === 'aborted') {
        toast.info('Tarea detenida');
      } else if (state.error) {
        toast.error(state.error);
      } else {
        toast.success('Tarea completada');
      }
      if (activeChat?.id) selectChat(activeChat.id);
    } catch (err: any) {
      console.error('Agent task failed:', err);
      toast.error(err?.message || 'Agent task failed');
      markLocalJobIdle(activeChat?.id);
      setIsWebSearching(false);
      searchAbortControllerRef.current = null;
      currentAgentTaskIdRef.current = null;
    }
  };

  function FeatureRow({ icon, title, desc, included = true }: { icon: React.ReactNode; title: string; desc: string; included?: boolean }) {
    return (
      <div className={`flex items-start gap-3 ${included ? '' : 'opacity-60'}`}>
        <div className="w-8 h-8 rounded-md bg-muted/20 flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
        <div>
          <div className="font-medium text-sm">{title}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={chatViewportRef}
      className="chat-viewport flex flex-col relative overflow-hidden"
      onDragEnter={handleDragIn}
      onDragOver={handleDrag}
      onDragLeave={handleDragOut}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/70 bg-background/95 p-10 text-center shadow-2xl">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Upload className="h-7 w-7" />
            </div>
            <p className="text-base font-semibold">Soltar para adjuntar</p>
            <p className="text-xs leading-5 text-muted-foreground">
              PDF, Word, Excel, PowerPoint, imágenes y datos — sin límite de tamaño.
            </p>
          </div>
        </div>
      )}

      {/* Floating "reopen sidebar" button — appears when the sidebar
          is collapsed (we auto-collapse on Word/Excel/image/video to
          reclaim horizontal real estate). Pinned to the viewport edge
          so the user can always pop the sidebar back with one click. */}
      {!sidebarOpen && !isSidebarMobile && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          title="Mostrar sidebar"
          aria-label="Mostrar sidebar"
          className="fixed left-0 top-1/2 -translate-y-1/2 z-50 flex h-10 w-6 items-center justify-center rounded-r-md border border-l-0 border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-all duration-200 hover:w-8 hover:bg-background hover:text-foreground"
        >
          <SidebarOvalIcon className="h-4 w-4" />
        </button>
      )}

      <div ref={splitContainerRef} className="flex flex-1 overflow-hidden w-full relative">
        {/* Left pane — chat. When a right-side tool panel is active we
            share width with it via the resizable divider; otherwise we
            take the full container. min-w-0 so children can shrink. */}
        <div
          style={rightPanelActive
            ? {
                flex: '1 1 auto',
                minWidth: SPLIT_LEFT_MIN_PX,
                transition: isDraggingSplit ? undefined : 'flex-basis 300ms ease',
              }
            : undefined}
          className={`relative flex flex-col h-full min-w-0 overflow-hidden ${rightPanelActive ? '' : 'w-full'}`}
        >
          {/* Header */}
          <div ref={chatHeaderRef} className="chat-mobile-header absolute top-0 left-0 right-0 z-10 backdrop-blur-sm">
            <div className="chat-header-row flex items-center justify-between">
              <div className="chat-header-left flex min-w-0 items-center gap-2">
                <div className="shrink-0 md:hidden">
                  <SidebarTrigger
                    className={cn(
                      "h-8 w-8 rounded-none border-0 bg-transparent p-0 text-foreground shadow-none",
                      "hover:bg-transparent focus-visible:bg-transparent active:scale-[0.97]"
                    )}
                    aria-label="Abrir el menú lateral"
                    title="Abrir el menú lateral"
                  >
                    <SidebarOvalIcon className="h-5 w-5" />
                  </SidebarTrigger>
                </div>
                {!isMediaToolActive && (
                  <NavbarModelSelector
                    selectedModel={selectedModel}
                    setSelectedModel={setSelectedModel}
                    availableModels={availableModels}
                    setSelectedProvider={setSelectedProivder}
                    chatTypes={chatType}
                    currentChat={currentChat}
                    setCurrentChat={setCurrentChat}
                  />
                )}
              </div>
              <div className="chat-header-actions flex shrink-0 items-center gap-0.5">
                {/* Complete Chat Share Button - only show if there's a chat with messages.
                    Hidden when a right-side panel (preview/artifact/connector) is
                    active so the header fits the narrower pane. */}
                {currentChat?.id && currentChat?.messages && currentChat.messages.length > 0 && !showAudioPanel && !rightPanelActive && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCompleteShare}
                    title="Compartir conversación completa"
                    aria-label="Compartir conversación completa"
                    className="chat-header-icon-btn chat-share-action h-11 w-11 rounded-full"
                  >
                    <Share className="h-5 w-5" />
                  </Button>
                )}
                {/* WhatsApp CTA — marketing surface; hide it when the pane
                    is narrow (split active) so the primary controls stay visible. */}
                {!rightPanelActive && (
                  <WhatsAppButton
                    className="chat-header-icon-btn chat-optional-action"
                    message="Hola 👋, me interesa SiraGPT. ¿Podrían contarme más sobre sus funciones y precios?"
                  />
                )}
                <ThemeToggle className="chat-header-icon-btn" />
                {/* Plan / Upgrade button — unified icon-system:
                    Free plan → text CTA "Subir de plan"
                    Paid + near-quota → text CTA "Upgrade Now" + warning border
                    Paid + healthy → compact icon button with Sparkles glyph
                    The 💰 emoji was replaced with Lucide Sparkles (same stroke
                    family as the rest of the header icons). */}
                {(() => {
                  const usageRatio =
                    currentUserInfo?.apiUsage && currentUserInfo?.monthlyLimit
                      ? currentUserInfo.apiUsage / currentUserInfo.monthlyLimit
                      : 0
                  const isFree = currentPlan === 'FREE'
                  // Collapse the text CTA to icon-only when a right-side
                  // panel is active — the left pane is ~half width then,
                  // and the "Subir de plan" pill was wrapping into the
                  // message area.
                  const isSplitActive = rightPanelActive
                  const showTextCta = !isSplitActive && (isFree || usageRatio >= 0.7)
                  const warn = !isFree && usageRatio >= 0.9
                  const caution = !isFree && usageRatio >= 0.7 && usageRatio < 0.9
                  return (
                    <Button
                      variant={showTextCta ? 'outline' : 'ghost'}
                      size={showTextCta ? 'sm' : 'icon'}
                      onClick={() => setSubscribeOpen(true)}
                      aria-label={isFree ? 'Subir de plan' : 'Gestionar plan'}
                      title={isFree ? 'Subir de plan' : 'Gestionar plan'}
                      className={cn(
                        !showTextCta && 'h-11 w-11 rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]',
                        showTextCta && 'h-11 gap-1.5 rounded-full px-3 text-[13px] font-semibold',
                        warn && 'border-red-500/70 text-red-600 hover:bg-red-500/10 hover:text-red-600',
                        caution && 'border-amber-500/70 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600',
                        'chat-header-icon-btn',
                        'chat-plan-action',
                        'transition-all duration-200',
                      )}
                    >
                      {showTextCta ? (
                        <>
                          <PremiumCardIcon className="h-[18px] w-[24px] shrink-0 drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]" />
                          <span>{isFree ? 'Subir de plan' : 'Mejorar plan'}</span>
                        </>
                      ) : (
                        <PremiumCardIcon className="h-[18px] w-[24px] drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]" />
                      )}
                    </Button>
                  )
                })()}
                <UpgradeModal
                  open={subscribeOpen}
                  onOpenChange={setSubscribeOpen}
                  user={currentUserInfo || user}
                />
                <KeyboardShortcutsModal
                  open={shortcutsOpen}
                  onOpenChange={setShortcutsOpen}
                />
                {/* Share conversation modal */}
                <Dialog open={shareModalOpen} onOpenChange={setShareModalOpen}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>Compartir conversación</DialogTitle>
                      <DialogDescription>
                        Cualquier persona con este enlace podrá ver la conversación. Puedes copiarlo o abrirlo para compartirlo donde necesites.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="mt-4 space-y-3">
                      <div className="text-xs font-medium text-muted-foreground">Enlace para compartir</div>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={shareUrl || ''}
                          className="flex-1 px-2 py-1 rounded-md border bg-muted text-xs overflow-hidden text-ellipsis"
                          onFocus={(e) => e.target.select()}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (!shareUrl) return;
                            navigator.clipboard.writeText(shareUrl);
                            toast.success('Enlace copiado al portapapeles');
                          }}
                        >
                          Copiar enlace
                        </Button>
                      </div>
                    </div>
                    <DialogFooter className="mt-4 flex justify-end gap-2">
                      {shareUrl && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (shareUrl && typeof window !== 'undefined') {
                              window.open(shareUrl, '_blank', 'noopener,noreferrer');
                            }
                          }}
                        >
                          Abrir enlace
                        </Button>
                      )}
                      <DialogClose asChild>
                        <Button size="sm" variant="default">
                          Listo
                        </Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </div>




          {isInitial ? (
            <div className="canvas-ambient chat-initial-stage flex flex-1 items-center justify-center">
              <div className="w-full max-w-[860px] px-4">
                  <div className="space-y-3">
                  {/*
                    Composer — premium production UI.
                    In DARK mode, inherits `composer-surface` from globals.css
                    which applies the design-spec tokens (#0B1118 bg, #1C2430
                    border, 0 12px 32px rgba(0,0,0,0.28) shadow) with a
                    violet-tinted focus ring. In LIGHT mode it uses the Tailwind
                    classes below (soft white surface with layered shadow).
                    The focus state is the ONLY place accent color appears —
                    idle never glows.
                  */}
                  {/*
                    Composer — pill-styled card. rounded-3xl gives the
                    single-row state a pill feel AND looks balanced when
                    chips/tools push it taller. All ingestion artifacts
                    (file chips, selected-text, active tools) live INSIDE
                    the same surface so the user sees one coherent input
                    area, not stacked floating elements above the bar.
                  */}
                  <div className="relative">
                    {pasteCapture.Overlay}
                    {/* Slash-command menu — appears when the input starts with "/" */}
                    <SlashCommandMenu
                      open={slashMenuOpen}
                      filter={slashMenuFilter}
                      onCommandPick={(cmd) => {
                        setInput(cmd.insert);
                        setSlashMenuOpen(false);
                        window.setTimeout(() => {
                          const el = textareaRef.current;
                          if (el) {
                            const len = cmd.insert.length;
                            el.focus();
                            try { el.setSelectionRange(len, len); } catch { /* old Safari */ }
                          }
                        }, 0);
                      }}
                      onClose={() => setSlashMenuOpen(false)}
                    />
                    <CredentialWarning text={input} />
                    <div
                      className={cn(
                        "composer-surface composer-liquid-surface group/composer relative rounded-3xl",
                        pasteCapture.overlayVisible ? "overflow-visible" : "overflow-hidden",
                        "bg-background",
                        "ring-1 ring-black/[0.08] dark:ring-1 dark:ring-white/[0.06]",
                        "shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.42)]",
                        "transition-[border-color,background-color,box-shadow,ring-color] duration-base ease-smooth",
                        "hover:ring-black/[0.14] dark:hover:ring-white/[0.10]",
                        "focus-within:ring-2 focus-within:ring-foreground/[0.16] dark:focus-within:ring-2 dark:focus-within:ring-[hsl(var(--accent-violet))]/45",
                    )}
                  >
                    {/* Chips zone — rendered ABOVE the input row, INSIDE
                        the same rounded card. Hidden entirely when there
                        are no files / selected text / active tools, so
                        empty composer stays as a clean single line. */}
                    <ActiveOptionsDisplay
                      uploadedFiles={uploadedFiles}
                      removeFile={removeFile}
                      uploadProgress={uploadProgress}
                      retryUpload={retryUpload}
                      restoreLongPasteToInput={restoreLongPasteToInput}
                      onPreviewAttachment={(_attachment, _siblings, index) => openComposerDocumentPreview(index)}
                    />
                    <SelectedTextDisplay text={selectedWordText} onClear={() => setSelectedWordText(null)} />
                    <LinkContextDisplay
                      links={detectedLinks}
                      removeLink={removeDetectedLink}
                      isWebSearchActive={isWebSearchActive}
                      setIsWebSearchActive={setIsWebSearchActive}
                    />
                    {/* Tool pills used to live ABOVE the input; moved to
                        a secondary row BELOW the input (see after the
                        TooltipProvider) so the top surface is dedicated
                        to drag-and-drop of files / audio / images. */}
                    <TooltipProvider>
                      <div className="flex items-center gap-2 pl-2 pr-2 py-1.5">
                        {/* LEFT — Plus / attach + tool selector */}
                        <ActionsDropdown
                          chatType={chatType}
                          setChatType={setChatType}
                          currentPlan={currentPlan}
                          isWebSearchActive={isWebSearchActive}
                          setIsWebSearchActive={setIsWebSearchActive}
                          isImageGenerationActive={isImageGenerationActive}
                          setIsImageGenerationActive={setIsImageGenerationActive}
                          isVoiceGenerationActive={isVoiceGenerationActive}
                          setIsVoiceGenerationActive={setIsVoiceGenerationActive}
                          isMusicGenerationActive={isMusicGenerationActive}
                          setIsMusicGenerationActive={setIsMusicGenerationActive}
                          isVideoGenerationActive={isVideoGenerationActive}
                          setIsVideoGenerationActive={setIsVideoGenerationActive}
                          isComputerUseActive={isComputerUseActive}
                          setIsComputerUseActive={setIsComputerUseActive}
                          computerUseStatus={computerUseStatus}
                          isGmailActive={isGmailActive}
                          setIsGmailActive={setIsGmailActive}
                          isGoogleCalendarActive={isGoogleCalendarActive}
                          setIsGoogleCalendarActive={setIsGoogleCalendarActive}
                          isGoogleDriveActive={isGoogleDriveActive}
                          setIsGoogleDriveActive={setIsGoogleDriveActive}
                          isSpotifyActive={isSpotifyActive}
                          setIsSpotifyActive={setIsSpotifyActive}
                          isWordConnectorActive={isWordConnectorActive}
                          setIsWordConnectorActive={setIsWordConnectorActive}
                          isExcelConnectorActive={isExcelConnectorActive}
                          setIsExcelConnectorActive={setIsExcelConnectorActive}
                          setShowAudioPanel={setShowAudioPanel}
                          handleComputerUseToggle={handleComputerUseToggle}
                          handleGmailToggle={handleGmailToggle}
                          handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                          handleGoogleDriveToggle={handleGoogleDriveToggle}
                          handleSpotifyToggle={handleSpotifyToggle}
                          handleWordConnectorToggle={handleWordConnectorToggle}
                          handleExcelConnectorToggle={handleExcelConnectorToggle}
                          closeAllToolsAndConnectors={closeAllToolsAndConnectors}
                          setAudioTab={setAudioTab}
                          handleAndUploadFiles={handleAndUploadFiles}
                          isUploading={isUploading}
                          isWebSearching={isCurrentChatLocalJobBusy}
                          isLoading={isCurrentChatLoading}
                          isGeneratingImage={isCurrentChatLocalJobBusy && isGeneratingImage}
                          isGeneratingVideo={isCurrentChatLocalJobBusy && isGeneratingVideo}
                          isGeneratingPPT={isGeneratingPPT}
                          isProcessingGmail={isCurrentChatLocalJobBusy && isProcessingGmail}
                        />

                        {/* CENTER — single-line textarea, expands vertically up to 200px */}
                        <Textarea
                          ref={textareaRef}
                          value={input}
                          onChange={handleTextareaChange}
                          onKeyDown={handleKeyDown}
                          onKeyPress={handleKeyPress}
                          onFocus={handleTextareaFocus}
                          onPaste={handleTextareaPaste}
                          onCompositionStart={() => { isComposingRef.current = true }}
                          onCompositionEnd={() => { isComposingRef.current = false }}
                          placeholder={
                            isImageGenerationActive
                              ? tComposer("placeholderImage")
                              : isVideoGenerationActive
                                ? tComposer("placeholderVideo")
                                : isVoiceGenerationActive
                                  ? "Describe la voz que quieres crear"
                                  : isMusicGenerationActive
                                    ? "Describe la música que quieres crear"
                                    : isWebSearchActive
                                      ? tComposer("placeholderWebSearch")
                                      : isGmailActive
                                        ? tComposer("placeholderGmail")
                                        : (isGoogleCalendarActive || isGoogleDriveActive)
                                          ? tComposer("placeholderGoogle")
                                          : isSpotifyActive
                                            ? tComposer("placeholderSpotify")
                                            : isWordConnectorActive
                                              ? tComposer("placeholderWord")
                                              : tComposer("placeholderDefault")
                          }
                          className={cn(
                            "textarea-scrollbar min-h-[24px] min-w-0 flex-1 resize-none border-none bg-transparent",
                            "py-1.5 px-1",
                            "text-[15px] leading-[1.45] tracking-[-0.01em] text-foreground",
                            "placeholder:text-muted-foreground/65 placeholder:font-normal",
                            "dark:placeholder:text-[hsl(var(--text-tertiary))]",
                            "outline-none ring-0 focus:outline-none focus:ring-0",
                            "rounded-none transition-colors duration-200",
                          )}
                          style={{
                            minHeight: "24px",
                            maxHeight: "var(--chat-textarea-max-height, 200px)",
                            overflowY: "auto",
                            overflowX: "hidden",
                            wordWrap: "break-word",
                            border: "none",
                            outline: "none",
                            boxShadow: "none",
                          }}
                          rows={1}
                          disabled={isCurrentChatLoading || isCurrentChatLocalJobBusy}
                        />

                        {/* RIGHT — VoiceControls (mic, ghost) + primary action.
                            Primary swaps glyph based on state — never a
                            decorative button. */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          {/* Pulido · contador suave de caracteres. Aparece
                              sólo cuando ya escribiste bastante. */}
                          <ComposerCharCounter input={input} />
                          {!isStopButtonVisible && (
                            renderDictationButton()
                          )}

                          {!isStopButtonVisible && (() => {
                            const hasText = input.trim().length > 0
                            const hasAttachment = uploadedFiles.length > 0
                            const canSend = hasText || hasAttachment
                            const busy = isCurrentChatLocalJobBusy || isUploading
                            // When the user has typed → Send. When idle → open Voice Studio.
                            const action = canSend
                              ? handleSend
                              : openGrokVoicePanel
                            const label = canSend ? 'Enviar (⏎)' : 'Modo de voz'
                            const Icon = canSend ? ArrowUp : AudioLines
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    onClick={action}
                                    disabled={canSend && (isCurrentChatLoading || busy)}
                                    size="icon"
                                    aria-label={label}
                                    title={label}
                                    className={cn(
                                      "h-9 w-9 rounded-full p-0 transition-all duration-base ease-smooth",
                                      "bg-foreground text-background",
                                      "shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_10px_-2px_rgba(0,0,0,0.12)]",
                                      "hover:bg-foreground/92 hover:shadow-[0_2px_4px_rgba(0,0,0,0.12),0_8px_16px_-4px_rgba(0,0,0,0.22)] hover:-translate-y-[0.5px]",
                                      "active:scale-[0.94] active:translate-y-0",
                                      "disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100 disabled:translate-y-0 disabled:hover:translate-y-0",
                                    )}
                                  >
                                    {busy ? (
                                      <ThinkingIndicator size="sm" className="h-[15px] w-[15px]" />
                                    ) : (
                                      <Icon className="h-[16px] w-[16px]" strokeWidth={canSend ? 2.25 : 1.75} />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <p>{label}</p>
                                </TooltipContent>
                              </Tooltip>
                            )
                          })()}

                          {isStopButtonVisible && (
                            <Button
                              onClick={stopActiveGeneration}
                              size="icon"
                              aria-label="Detener generación"
                              title="Detener"
                              disabled={pendingStop && isCurrentChatStreaming}
                              className={cn(
                                "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                "bg-foreground text-background",
                                "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                "hover:bg-foreground/90 active:scale-[0.96]",
                                "disabled:opacity-70 disabled:cursor-not-allowed disabled:active:scale-100",
                              )}
                            >
                              {pendingStop ? (
                                <ThinkingIndicator size="sm" className="h-[15px] w-[15px]" />
                              ) : (
                                <Square className="h-[12px] w-[12px] fill-current" strokeWidth={0} />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </TooltipProvider>

                    {/* Secondary row — active tool / connector pills.
                        Only rendered when something is active, so the
                        composer stays a clean pill in the idle state. */}
                    {hasActiveTools && (
                      <div className="composer-media-controls-row mx-2 mb-2 flex items-center gap-2 overflow-x-auto px-0.5 py-1">
                        <ActiveToolsDisplay {...activeToolsProps} />
                      </div>
                    )}
                  </div>
                  </div>

                  {/* <p className="text-center text-xs text-muted-foreground">
                {isWebSearchActive
                      ? 'Press Enter to search the web, Shift+Enter for new line'
                      : 'Press Enter to send, Shift+Enter for new line'
                }
              </p> */}
                </div>
              </div>
            </div>
          ) : (
            <>
              {mainPaneAudioPanelEnabled && showAudioPanel ? (
                // Voice Studio responsive view
                <div className="flex flex-1 flex-col lg:flex-row">
                  {/* Navigation - Mobile: horizontal tabs, Desktop: vertical sidebar */}
                  <div className="lg:w-56 lg:border-r border-border/40 p-3 sm:p-4">
                    <div className="text-sm font-medium mb-2 hidden lg:block">Audio</div>

                    {/* Mobile: Horizontal scrollable tabs */}
                    <div className="flex lg:hidden overflow-x-auto gap-2 pb-2">
                      <Button
                        variant={audioTab === 'tts' ? 'default' : 'outline'}
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => setAudioTab('tts')}
                      >
                        <Square className="h-4 w-4 mr-1" />
                        <span className="text-xs">TTS</span>
                      </Button>
                      <Button
                        variant={audioTab === 'stt' ? 'default' : 'outline'}
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => setAudioTab('stt')}
                      >
                        <Mic className="h-4 w-4 mr-1" />
                        <span className="text-xs">STT</span>
                      </Button>
                      <Button
                        variant={audioTab === 'music' ? 'default' : 'outline'}
                        size="sm"
                        className="flex-shrink-0"
                        onClick={() => setAudioTab('music')}
                      >
                        <Music className="h-4 w-4 mr-1" />
                        <span className="text-xs">Music</span>
                      </Button>

                    </div>

                    {/* Desktop: Vertical buttons */}
                    <div className="hidden lg:block space-y-2">
                      <Button
                        variant={audioTab === 'tts' ? 'default' : 'outline'}
                        className="w-full justify-start"
                        onClick={() => setAudioTab('tts')}
                      >
                        <Square className="h-4 w-4 mr-2" />
                        Text-to-Speech
                      </Button>
                      <Button
                        variant={audioTab === 'stt' ? 'default' : 'outline'}
                        className="w-full justify-start"
                        onClick={() => setAudioTab('stt')}
                      >
                        <Mic className="h-4 w-4 mr-2" />
                        Speech-to-Text
                      </Button>
                      <Button
                        variant={audioTab === 'music' ? 'default' : 'outline'}
                        className="w-full justify-start"
                        onClick={() => setAudioTab('music')}
                      >
                        <Music className="h-4 w-4 mr-2" />
                        Music
                      </Button>

                    </div>
                  </div>

                  {/* Content area */}
                  <div className="flex-1 p-3 sm:p-4">
                    {audioTab === 'tts' && (
                      <TextToSpeechComponent />
                    )}
                    {audioTab === 'stt' && (
                      <SpeechToTextComponent />
                    )}
                    {audioTab === 'music' && (
                      <MusicGenerationComponent
                        initialDuration={selectedMusicDuration}
                        initialPromptInfluence={selectedMusicInfluence}
                        initialStyle={selectedMusicStyle}
                        initialMood={selectedMusicMood}
                        initialEffect={selectedMusicEffect}
                      />
                    )}
                    {audioTab === 'video' && (
                      <VideoGenerationComponent />
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* Messages */}
                  <ScrollArea className="chat-message-scroll flex-1 w-full" ref={scrollAreaRef} onClickCapture={handleMessageAreaClick}>
                    <div className="chat-message-scroll-content space-y-2 max-w-3xl mx-auto w-full">
                      {(() => {
                        const messages = currentChat?.messages || [];
                        const stableMessages = isCurrentChatStreaming ? messages.slice(0, -1) : messages;
                        const streamingMessage = isCurrentChatStreaming ? messages[messages.length - 1] : null;

                        return (
                          <>

                            {radixViewport && stableMessages.length > 40 ? (
                              // Virtualized path — only items inside the
                              // visible window (plus a 400px overscan
                              // buffer) get reconciled. customScrollParent
                              // hands Virtuoso the existing Radix viewport
                              // so scrollToBottom() above keeps working.
                              <Virtuoso
                                data={stableMessages}
                                customScrollParent={radixViewport}
                                computeItemKey={(_, m) => m.id}
                                increaseViewportBy={400}
                                itemContent={(_, message) => (
                                  <ErrorBoundary
                                    key={message.id}
                                    label={`message:${message.id}`}
                                  >
                                    <MessageComponent
                                      message={message}
                                      user={user}
                                      onRegenerate={regenerateMessage}
                                      updateMessageInChat={editAndRegenerate}
                                      isStreaming={false}
                                      onToggleSplitView={handleToggleSplitView}
                                      onDocumentPreview={handleDocumentPreview}
                                      onAttachmentPreview={handleAttachmentPreview}
                                    />
                                  </ErrorBoundary>
                                )}
                              />
                            ) : (
                              // First render before viewport ref resolves —
                              // identical to the previous non-virtualized
                              // path. Per-message ErrorBoundary preserved.
                              stableMessages.map((message) => (
                                <ErrorBoundary key={message.id} label={`message:${message.id}`}>
                                  <MessageComponent
                                    message={message}
                                    user={user}
                                    onRegenerate={regenerateMessage}
                                    updateMessageInChat={editAndRegenerate}
                                    isStreaming={false}
                                    onToggleSplitView={handleToggleSplitView}
                                    onDocumentPreview={handleDocumentPreview}
                                    onAttachmentPreview={handleAttachmentPreview}
                                  />
                                </ErrorBoundary>
                              ))
                            )}
                            {streamingMessage && (
                              // Isolate layout for the streaming bubble so
                              // each token delta doesn't relayout the whole
                              // message list above. See .streaming-message
                              // in globals.css (contain: layout style).
                              <div
                                className="streaming-message"
                                role="region"
                                aria-live="polite"
                                aria-atomic="false"
                                aria-label="Respuesta del asistente en progreso"
                              >
                                <ErrorBoundary label={`message:${streamingMessage.id}:stream`}>
                                  <MessageComponent
                                    key={streamingMessage.id}
                                    message={streamingMessage}
                                    user={user}
                                    onRegenerate={regenerateMessage}
                                    updateMessageInChat={editAndRegenerate}
                                    isStreaming={true}
                                    onToggleSplitView={handleToggleSplitView}
                                    onDocumentPreview={handleDocumentPreview}
                                    onAttachmentPreview={handleAttachmentPreview}
                                  />
                                </ErrorBoundary>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </ScrollArea>

                  {/* Input & Actions */}

                  <div ref={chatComposerDockRef} className="chat-composer-dock sticky bottom-0 left-0 right-0 z-10">
                    <div className="relative max-w-3xl mx-auto space-y-2 bg-background">
                      {/* Scroll-to-bottom pill — only shown when the
                          user has scrolled up. Floats just above the
                          composer surface so the click target sits in
                          the same zone the user's hand is already
                          near. Aria-live so assistive tech announces
                          "new messages below" as the pill appears. */}
                      <div
                        aria-live="polite"
                        className={cn(
                          "pointer-events-none absolute left-1/2 -top-12 z-20 -translate-x-1/2",
                          "transition-all duration-base ease-smooth",
                          isAtBottom
                            ? "opacity-0 translate-y-1"
                            : "opacity-100 translate-y-0",
                        )}
                      >
                        <button
                          type="button"
                          onClick={scrollToBottom}
                          aria-label={isCurrentChatStreaming ? "Nuevos mensajes, ir al final" : "Ir al final de la conversación"}
                          className={cn(
                            "pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3.5",
                            "border bg-background/95 backdrop-blur-md",
                            "text-[12.5px] font-medium",
                            "shadow-[0_4px_14px_-4px_rgba(15,23,42,0.18),0_1px_2px_rgba(15,23,42,0.06)] dark:shadow-[0_12px_28px_-12px_rgba(0,0,0,0.55)]",
                            "transition-all duration-fast ease-smooth",
                            "hover:-translate-y-[1px]",
                            "active:translate-y-0 active:scale-[0.97]",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                            // Lote D · #27 — when the model is actively
                            // streaming and the user has scrolled up to
                            // read older content, accent the pill so it
                            // reads as "there's new stuff" rather than a
                            // passive "go down".
                            isCurrentChatStreaming
                              ? "border-primary/40 text-primary-foreground bg-primary/95 hover:bg-primary"
                              : "border-border/55 text-foreground/80 hover:bg-background hover:border-border hover:text-foreground",
                          )}
                        >
                          {isCurrentChatStreaming && (
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 rounded-full bg-current animate-pulse"
                            />
                          )}
                          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                          <span>{isCurrentChatStreaming ? "Nuevos mensajes" : "Ir al final"}</span>
                        </button>
                      </div>

                      {/* Input Area */}

                      {/* Same composer as the initial state — chips
                          render INSIDE the same rounded card. */}
                      <CredentialWarning text={input} />
                      <div className="relative">
                        {pasteCapture.Overlay}
                        <div
                          className={cn(
                            "composer-surface composer-liquid-surface group/composer relative rounded-3xl",
                            pasteCapture.overlayVisible ? "overflow-visible" : "overflow-hidden",
                            "bg-background",
                            "ring-1 ring-black/[0.08] dark:ring-1 dark:ring-white/[0.06]",
                            "shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_-4px_rgba(15,23,42,0.06)] dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.42)]",
                            "transition-[border-color,background-color,box-shadow,ring-color] duration-base ease-smooth",
                            "hover:ring-black/[0.14] dark:hover:ring-white/[0.10]",
                            "focus-within:ring-2 focus-within:ring-foreground/[0.16] dark:focus-within:ring-2 dark:focus-within:ring-[hsl(var(--accent-violet))]/45",
                        )}
                      >
                        <ActiveOptionsDisplay
                          uploadedFiles={uploadedFiles}
                          removeFile={removeFile}
                          uploadProgress={uploadProgress}
                          retryUpload={retryUpload}
                          restoreLongPasteToInput={restoreLongPasteToInput}
                          onPreviewAttachment={(_attachment, _siblings, index) => openComposerDocumentPreview(index)}
                        />
                        <SelectedTextDisplay text={selectedWordText} onClear={() => setSelectedWordText(null)} />
                        <LinkContextDisplay
                          links={detectedLinks}
                          removeLink={removeDetectedLink}
                          isWebSearchActive={isWebSearchActive}
                          setIsWebSearchActive={setIsWebSearchActive}
                        />
                        {/* Tool pills relocated below the input — see
                            the matching block after the TooltipProvider
                            closes. Top surface is reserved for drop-zone. */}
                        <TooltipProvider>
                          <div className="flex items-center gap-2 pl-2 pr-2 py-1.5">
                            <ActionsDropdown
                              chatType={chatType}
                              setChatType={setChatType}
                              currentPlan={currentPlan}
                              isWebSearchActive={isWebSearchActive}
                              setIsWebSearchActive={setIsWebSearchActive}
                              isImageGenerationActive={isImageGenerationActive}
                              setIsImageGenerationActive={setIsImageGenerationActive}
                              isVoiceGenerationActive={isVoiceGenerationActive}
                              setIsVoiceGenerationActive={setIsVoiceGenerationActive}
                              isMusicGenerationActive={isMusicGenerationActive}
                              setIsMusicGenerationActive={setIsMusicGenerationActive}
                              isVideoGenerationActive={isVideoGenerationActive}
                              setIsVideoGenerationActive={setIsVideoGenerationActive}
                              isComputerUseActive={isComputerUseActive}
                              setIsComputerUseActive={setIsComputerUseActive}
                              computerUseStatus={computerUseStatus}
                              isGmailActive={isGmailActive}
                              setIsGmailActive={setIsGmailActive}
                              isGoogleCalendarActive={isGoogleCalendarActive}
                              setIsGoogleCalendarActive={setIsGoogleCalendarActive}
                              isGoogleDriveActive={isGoogleDriveActive}
                              setIsGoogleDriveActive={setIsGoogleDriveActive}
                              isSpotifyActive={isSpotifyActive}
                              setIsSpotifyActive={setIsSpotifyActive}
                              isWordConnectorActive={isWordConnectorActive}
                              setIsWordConnectorActive={setIsWordConnectorActive}
                              isExcelConnectorActive={isExcelConnectorActive}
                              setIsExcelConnectorActive={setIsExcelConnectorActive}
                              setShowAudioPanel={setShowAudioPanel}
                              handleComputerUseToggle={handleComputerUseToggle}
                              handleGmailToggle={handleGmailToggle}
                              handleGoogleCalendarToggle={handleGoogleCalendarToggle}
                              handleGoogleDriveToggle={handleGoogleDriveToggle}
                              handleSpotifyToggle={handleSpotifyToggle}
                              handleWordConnectorToggle={handleWordConnectorToggle}
                              handleExcelConnectorToggle={handleExcelConnectorToggle}
                              closeAllToolsAndConnectors={closeAllToolsAndConnectors}
                              setAudioTab={setAudioTab}
                              handleAndUploadFiles={handleAndUploadFiles}
                              isUploading={isUploading}
                              isWebSearching={isCurrentChatLocalJobBusy}
                              isLoading={isCurrentChatLoading}
                              isGeneratingImage={isCurrentChatLocalJobBusy && isGeneratingImage}
                              isGeneratingVideo={isCurrentChatLocalJobBusy && isGeneratingVideo}
                              isGeneratingPPT={isGeneratingPPT}
                              isProcessingGmail={isCurrentChatLocalJobBusy && isProcessingGmail}
                            />
                            <Textarea
                              ref={textareaRef}
                              value={input}
                              onChange={handleTextareaChange}
                              onKeyDown={handleKeyDown}
                              onKeyPress={handleKeyPress}
                              onFocus={handleTextareaFocus}
                              onPaste={handleTextareaPaste}
                              onCompositionStart={() => { isComposingRef.current = true }}
                              onCompositionEnd={() => { isComposingRef.current = false }}
                              placeholder={
                                isImageGenerationActive
                                  ? tComposer("placeholderImage")
                                  : isVideoGenerationActive
                                    ? tComposer("placeholderVideo")
                                    : isVoiceGenerationActive
                                      ? "Describe la voz que quieres crear"
                                      : isMusicGenerationActive
                                        ? "Describe la música que quieres crear"
                                        : isWebSearchActive
                                          ? tComposer("placeholderWebSearch")
                                          : isGmailActive
                                            ? tComposer("placeholderGmail")
                                            : (isGoogleCalendarActive || isGoogleDriveActive)
                                              ? tComposer("placeholderGoogle")
                                              : isSpotifyActive
                                                ? tComposer("placeholderSpotify")
                                                : isWordConnectorActive
                                                  ? tComposer("placeholderWord")
                                                  : tComposer("placeholderDefault")
                              }
                              className={cn(
                                "textarea-scrollbar min-h-[24px] min-w-0 flex-1 resize-none border-none bg-transparent",
                                "py-1.5 px-1",
                                "text-[15px] leading-[1.45] tracking-[-0.01em] text-foreground",
                                "placeholder:text-muted-foreground/65 placeholder:font-normal",
                                "dark:placeholder:text-[hsl(var(--text-tertiary))]",
                                "outline-none ring-0 focus:outline-none focus:ring-0",
                                "rounded-none transition-colors duration-200",
                              )}
                              style={{
                                minHeight: "24px",
                                maxHeight: "var(--chat-textarea-max-height, 200px)",
                                overflowY: "auto",
                                overflowX: "hidden",
                                wordWrap: "break-word",
                                border: "none",
                                outline: "none",
                                boxShadow: "none",
                              }}
                              rows={1}
                              disabled={isCurrentChatLoading || isCurrentChatLocalJobBusy}
                            />
                            <div className="flex shrink-0 items-center gap-1.5">
                              {/* Pulido · contador suave de caracteres. */}
                              <ComposerCharCounter input={input} />
                              {!isStopButtonVisible && (
                                renderDictationButton()
                              )}

                              {!isStopButtonVisible && (() => {
                                const hasText = input.trim().length > 0
                                const hasAttachment = uploadedFiles.length > 0
                                const canSend = hasText || hasAttachment
                                const busy = isCurrentChatLocalJobBusy || isUploading
                                const action = canSend
                                  ? handleSend
                                  : openGrokVoicePanel
                                const label = canSend ? 'Enviar (⏎)' : 'Modo de voz'
                                const Icon = canSend ? ArrowUp : AudioLines
                                return (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        onClick={action}
                                        disabled={canSend && (isCurrentChatLoading || busy)}
                                        size="icon"
                                        aria-label={label}
                                        title={label}
                                        className={cn(
                                          "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                          "bg-foreground text-background",
                                          "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                          "hover:bg-foreground/90 hover:shadow-[0_1px_2px_rgba(0,0,0,0.10),0_4px_10px_-3px_rgba(0,0,0,0.18)]",
                                          "active:scale-[0.96]",
                                          "disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100",
                                        )}
                                      >
                                        {busy ? (
                                          <ThinkingIndicator size="sm" className="h-[15px] w-[15px]" />
                                        ) : (
                                          <Icon className="h-[16px] w-[16px]" strokeWidth={canSend ? 2.25 : 1.75} />
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      <p>{label}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )
                              })()}

                              {isStopButtonVisible && (
                                <Button
                                  onClick={stopActiveGeneration}
                                  size="icon"
                                  aria-label="Detener generación"
                                  title="Detener"
                                  disabled={pendingStop && isCurrentChatStreaming}
                                  className={cn(
                                    "h-9 w-9 rounded-full p-0 transition-all duration-200",
                                    "bg-foreground text-background",
                                    "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
                                    "hover:bg-foreground/90 active:scale-[0.96]",
                                    "disabled:opacity-70 disabled:cursor-not-allowed disabled:active:scale-100",
                                  )}
                                >
                                  {pendingStop ? (
                                    <ThinkingIndicator size="sm" className="h-[15px] w-[15px]" />
                                  ) : (
                                    <Square className="h-[12px] w-[12px] fill-current" strokeWidth={0} />
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        </TooltipProvider>

                        {/* Secondary row — active tool / connector pills.
                            Mirrors the in-chat composer above so both
                            states feel identical to the user. */}
                        {hasActiveTools && (
                          <div className="composer-media-controls-row mx-2 mb-2 flex items-center gap-2 overflow-x-auto px-0.5 py-1">
                            <ActiveToolsDisplay {...activeToolsProps} />
                          </div>
                        )}
                      </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )
          }
        </div>
        {/* Split view alternatives that take the remaining space
            without the resizable divider (code preview / computer use).
            These already use w-full internally. */}
        {splitViewContent && (
          <div className="w-full border-l border-border/40">
            <CodePreview {...splitViewContent} onClose={() => setSplitViewContent(null)} />
          </div>
        )}
        {isComputerUseActive && (
          <div className="w-full border-l border-border/40">
            <ComputerUseInterface
              screenshot={computerUseScreenshot}
              status={computerUseStatus}
              onClose={() => setIsComputerUseActive(false)}
            />
          </div>
        )}

        {/* Resizable right panel — Word / Excel / Document preview.
            Rendered together with the 6px col-resize divider so the
            user can drag the split from 25% to 75% and double-click
            to reset to 50/50. Persisted in localStorage. */}
        {rightPanelActive && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar paneles"
              onMouseDown={startSplitDrag}
              onDoubleClick={resetSplitRatio}
              className={cn(
                'group relative flex w-[6px] cursor-col-resize select-none items-center justify-center shrink-0 transition-colors',
                isDraggingSplit ? 'bg-border/60' : 'bg-transparent hover:bg-border/60',
              )}
            >
              {/* Three dots centered — visual hint for the grab handle.
                  pointer-events-none so the whole 6px strip stays the
                  mouse-hit target. */}
              <div className="pointer-events-none flex flex-col gap-[3px]">
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
                <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
              </div>
            </div>
            <div
              style={{
                width: showAudioPanel
                  ? `clamp(320px, ${100 - splitRatio}%, 420px)`
                  : `clamp(${SPLIT_RIGHT_MIN_PX}px, ${100 - splitRatio}%, 62%)`,
                transition: isDraggingSplit ? undefined : 'width 300ms ease',
              }}
              className="h-full min-w-0 overflow-hidden shrink-0"
            >
              {showAudioPanel && audioTab === 'stt' && (
                <GrokVoicePanel
                  chatId={currentChat?.id || null}
                  onClose={() => setShowAudioPanel(false)}
                />
              )}
              {showAudioPanel && audioTab !== 'stt' && (
                <div className="flex h-full min-h-0 flex-col border-l border-border/40 bg-background">
                  <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">Audio</div>
                      <div className="truncate text-xs text-muted-foreground">Herramientas de audio</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Cerrar panel de audio"
                      title="Cerrar"
                      className="h-8 w-8 rounded-full"
                      onClick={() => setShowAudioPanel(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex gap-2 overflow-x-auto border-b border-border/40 p-3">
                    <Button
                      variant={audioTab === 'tts' ? 'default' : 'outline'}
                      size="sm"
                      className="shrink-0"
                      onClick={() => setAudioTab('tts')}
                    >
                      TTS
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setAudioTab('stt')}
                    >
                      Voz
                    </Button>
                    <Button
                      variant={audioTab === 'music' ? 'default' : 'outline'}
                      size="sm"
                      className="shrink-0"
                      onClick={() => setAudioTab('music')}
                    >
                      Music
                    </Button>
                    <Button
                      variant={audioTab === 'video' ? 'default' : 'outline'}
                      size="sm"
                      className="shrink-0"
                      onClick={() => setAudioTab('video')}
                    >
                      Video
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-3">
                    {audioTab === 'tts' && (
                      <TextToSpeechComponent />
                    )}
                    {audioTab === 'music' && (
                      <MusicGenerationComponent
                        initialDuration={selectedMusicDuration}
                        initialPromptInfluence={selectedMusicInfluence}
                        initialStyle={selectedMusicStyle}
                        initialMood={selectedMusicMood}
                        initialEffect={selectedMusicEffect}
                      />
                    )}
                    {audioTab === 'video' && (
                      <VideoGenerationComponent />
                    )}
                  </div>
                </div>
              )}
              {!showAudioPanel && activeSearchActivity && (
                <SearchActivityPanel
                  activity={activeSearchActivity}
                  onClose={closeSearchActivityPanel}
                />
              )}
              {!showAudioPanel && !activeSearchActivity && documentPreviewUrl && (
                <DocumentPreview
                  url={documentPreviewUrl}
                  onClose={() => setDocumentPreviewUrl(null)}
                />
              )}
              {!showAudioPanel && !activeSearchActivity && !documentPreviewUrl && composerPreviewAttachment && (
                <UnifiedDocumentViewer
                  variant="panel"
                  className="h-full"
                  open={true}
                  onClose={() => setComposerPreviewIndex(null)}
                  attachment={composerPreviewAttachment}
                  siblings={composerPreviewSiblings}
                  onNavigate={(next) => {
                    const idx = composerPreviewSiblings.findIndex(s => s === next || (next.id && s.id === next.id));
                    if (idx >= 0) setComposerPreviewIndex(idx);
                  }}
                />
              )}
              {!showAudioPanel && !activeSearchActivity && !documentPreviewUrl && !composerPreviewAttachment && sidePreviewAttachment && (
                <UnifiedDocumentViewer
                  variant="panel"
                  className="h-full"
                  open={true}
                  onClose={() => {
                    setSidePreviewAttachment(null);
                    setSidePreviewSiblings([]);
                  }}
                  attachment={sidePreviewAttachment}
                  siblings={sidePreviewSiblings}
                  onNavigate={(next) => {
                    const idx = sidePreviewSiblings.findIndex(s => s === next || (next.id && s.id === next.id));
                    if (idx >= 0) setSidePreviewAttachment(sidePreviewSiblings[idx]);
                  }}
                />
              )}
              {!showAudioPanel && !activeSearchActivity && !composerPreviewAttachment && !sidePreviewAttachment && isWordConnectorActive && (
                <WordConnector
                  ref={wordConnectorRef}
                  onClose={() => setIsWordConnectorActive(false)}
                  selectedModel={selectedModel}
                  selectProvider={selectProvider}
                  isGeneratingExternal={isGeneratingWord}
                  isFullPage={true}
                  onTextSelected={(text) => {
                    setSelectedWordText(text);
                  }}
                />
              )}
              {!showAudioPanel && !activeSearchActivity && !composerPreviewAttachment && !sidePreviewAttachment && isExcelConnectorActive && (
                <React.Suspense fallback={<div className="h-full w-full animate-pulse bg-muted/30" aria-hidden="true" />}>
                  <ExcelConnector
                    ref={excelConnectorRef}
                    onClose={() => setIsExcelConnectorActive(false)}
                    isGeneratingExternal={isGeneratingExcel}
                  />
                </React.Suspense>
              )}
              {!showAudioPanel && !activeSearchActivity && activeArtifact && !isWordConnectorActive && !isExcelConnectorActive && !documentPreviewUrl && !composerPreviewAttachment && !sidePreviewAttachment && (
                <ArtifactPanel />
              )}
            </div>
          </>
        )}
      </div>
    </div >
  )
}
