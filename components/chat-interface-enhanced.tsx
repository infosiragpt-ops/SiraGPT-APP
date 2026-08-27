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
  ChevronRight,
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
  Chrome,
  AppWindow,
  NetworkIcon,
  Network,
  Monitor,
  Share,
  Search,
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
  MessageSquare,
  Star,
  Disc3,
  Menu as MenuIcon,
  BriefcaseBusiness,
  Maximize2,
  Minimize2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  LOGIN_HANDOFF_WINDOW_EVENT,
  emitLoginHandoff,
  isLiveComputerUsePrompt,
  chatMessageFromDetail,
  shouldPostHandoffChatMessage,
  buildHandoffAssistantMessage,
  type LoginHandoffDetail,
} from "@/lib/computer-login-handoff"
import {
  getSpeechRecognitionCtor,
  isIgnorableSpeechError,
  isSpeechPermissionError,
  resolveDictationLanguage,
  shouldRestartNativeDictation,
} from "@/lib/chat/composer-dictation"
import { motion, AnimatePresence } from "framer-motion"
import { dedupeMessages, mergeChatPreservingUserMessages } from "@/lib/message-preservation"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CredentialWarning } from "@/components/credential-warning"
import { ComposerCharCounter } from "@/components/composer-char-counter"
import { Input } from "@/components/ui/input"
import { useChat, useModelsAndFiles } from "@/lib/chat-context-integrated"
import { useAuth } from "@/lib/auth-context-integrated"
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
import { getAttachmentLocalFile, toDocumentViewerAttachmentWithProgress } from "@/lib/document-viewer-attachment"
import { canOpenComposerPreview } from "@/lib/document-preview-gate"
import { SlashCommandMenu, detectSlashFilter, parseSlashPrefix } from "@/components/SlashCommandMenu"
import { AppsMentionPicker } from "@/components/AppsMentionPicker"
import {
  MENTION_COPY,
  REGISTRY_APP_IDS,
  buildPickerApps,
  detectAtMention,
  filterPickerApps,
  groupPickerApps,
  insertMention,
  resolveMentionedApps,
  type MentionPickerApp,
  type MentionTrigger,
} from "@/lib/apps-mentions"
import {
  connectGptStoreApp,
  resolveConnectPlan,
} from "@/lib/gpts-apps-connect"
import { getNormalizedApiBaseUrl } from "@/lib/api-base-url"
import {
  ImageAspectRatioMark,
  SelectedTextDisplay,
} from "@/components/chat/ComposerInlineDisplays"
import {
  ChatComposerPrimaryAction,
  ChatComposerSurface,
} from "@/components/chat/ChatComposerSurface"
import {
  COMPOSER_TEXTAREA_EXPANDED_MIN_PX,
  COMPOSER_TEXTAREA_MIN_PX,
  measureComposerTextarea,
  shouldShowComposerExpandControl,
} from "@/lib/composer-layout"
import { FileUploadProgress } from "@/components/file-upload-progress"
import { FileProcessingStatusSync } from "@/components/file-processing-status-sync"
import { DocumentPageThumb } from "@/components/document-page-thumb"
import { isPagePreviewDocument } from "@/lib/document-first-page"
import type { FileProcessingStatus } from "@/hooks/use-file-processing-status"
import { describeComposerDocumentThumb, isActiveProcessingStage } from "@/lib/file-processing-vocab"
import {
  extractFilesFromDataTransfer,
  extractFromClipboardEvent,
  validateBatch,
  filesToFileList,
  logIngest,
} from "@/lib/attachment-ingest"
import { Badge } from "@/components/ui/badge"
import {
  apiClient,
  isTerminalAgentTaskRecoveryHttpStatus,
  resolveChatAgentTaskForRecovery,
  shouldDetachAgentTaskRecovery,
} from "@/lib/api"
import { serializeBranchedMessageMetadata } from "@/lib/chat/branch-metadata"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { clampDeepSeekModel } from "@/lib/sse-client"
import { shouldRecoverImageGenerationViaPolling } from "@/lib/image-generation-recovery"
import { track } from "@/lib/analytics"
import { aiService, buildProfessionalCapabilityPrompt, classifyIntentFastPath, extractRequestedVideoAspectRatio, extractRequestedVideoAudio, extractRequestedVideoDurationSeconds, extractRequestedVideoResolution, isComputerRequestPrompt, isImageAnalysisPrompt, isImageOnlyAttachmentTurn, PROFESSIONAL_CAPABILITY_CONTRACTS, shouldAutoActivateVideoGeneration, shouldRouteTextPromptThroughAgenticRuntime, shouldRouteThroughAgenticRuntime, shouldRouteWorkModePromptThroughAgentTask, type ChatIntent } from "@/lib/ai-service"
import { resolveImageAttachmentUrl } from "@/lib/attachment-url"
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
// Optional media studios are several large client bundles. They are loaded
// only after the user opens the corresponding tool, keeping the default chat
// route responsive on first visit.
const SpeechToTextComponent = dynamic(
  () => import("./speech-to-text-component"),
  { ssr: false, loading: () => <ChatToolPanelLoading label="Cargando transcripción…" /> },
)
const TextToSpeechComponent = dynamic(
  () => import("./text-to-speech-component"),
  { ssr: false, loading: () => <ChatToolPanelLoading label="Cargando estudio de voz…" /> },
)
const MusicGenerationComponent = dynamic(
  () => import("./MusicGenerationComponent"),
  { ssr: false, loading: () => <ChatToolPanelLoading label="Cargando estudio de música…" /> },
)
const VoiceCatalogModal = dynamic(
  () => import("./voice/voice-catalog-modal"),
  { ssr: false, loading: () => null },
)
import { agenticSearchService, type AgenticEvent, type AgenticSource } from "@/lib/agentic-search-service"
import { shouldUseDedicatedAcademicSearch } from "@/lib/academic-search-intent"
import {
  RESEARCH_FOLLOW_UP_EVENT,
  buildScientificPapersMessage,
  ensureResearchCommandChat,
  type ResearchResultSource,
} from "@/lib/research-results"
import {
  RESEARCH_ARTIFACT_EVENT,
  buildResearchArtifactPrompt,
  type ResearchArtifactRequest,
} from "@/lib/research-artifacts"
import ResearchResultsWorkbench from "@/components/research/ResearchResultsWorkbench"
import { agentTaskService, normalizeAgentTaskErrorMessage, reduceEvent, initialAgentState, type AgentTaskState } from "@/lib/agent-task-service"
import { pickLastArtifactId } from "@/lib/document-chat-request"
import { devLog } from "@/lib/dev-log"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import { agentsHomeHref, conversationIdFromLocation } from "@/lib/agents-home-path"
import { safeUUID } from "@/lib/safe-uuid"
import { resolveGptIconImageUrl } from "@/lib/gpt-icon-url"
const VideoGenerationComponent = dynamic(
  () => import("./VideoGenerationComponent"),
  { ssr: false, loading: () => <ChatToolPanelLoading label="Cargando estudio de video…" /> },
)
import UpgradeModal from "./UpgradeModal"
import KeyboardShortcutsModal from "./KeyboardShortcutsModal"
import { IconProvider } from "./icon-provider"
import GoogleServicesConnectionCard from "./GoogleServicesConnectionCard"
import { useSidebar } from "@/components/ui/sidebar"
import { useTranslations } from "next-intl"
import { useArtifactPanel } from "@/lib/artifact-panel-context"
import { ArtifactPanel } from "@/components/chat/ArtifactPanel"
import { SourcesPanel } from "@/components/sources-panel"
import { GrokVoicePanel } from "@/components/chat/grok-voice-panel"
import { DocumentPreview, type DocumentPreviewTarget } from "./document-preview"
import { useDocumentPreviewOverlay } from "@/hooks/use-mobile"
import { CodePreview } from "./code-preview"
import SpotifyResults from "./spotify-results"
// Panel "Computer Use": solo aparece cuando el usuario activa esa
// herramienta. Lo bajamos a dynamic para sacarlo del bundle inicial.
const ComputerUseInterface = dynamic(
  () => import("./ComputerUseInterface"),
  { ssr: false, loading: () => null },
)
const CoworkPanel = dynamic(
  () => import("@/components/chat/cowork-panel"),
  { ssr: false, loading: () => <div className="h-full border-l border-border/40 bg-background" /> },
)
const ChatAgentComputerPanel = dynamic(
  () => import("@/components/chat/chat-agent-computer-panel"),
  { ssr: false, loading: () => <div className="h-full border-l border-border/40 bg-background" data-testid="chat-agent-computer-loading" /> },
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
import {
  compareModelProviders,
  resolveModelAttributionName,
  resolveModelIconName,
  resolveModelProviderName,
} from "@/lib/model-icons"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

import {
  buildFileOnlyPrompt,
  createLongPasteDocumentFile,
  getLongPasteMetadata,
} from "@/lib/long-paste"
import { usePasteCapture } from "@/components/paste-preview-overlay"
import { analyzePastedContent, type PasteCaptureResult, type PasteCaptureAction } from "@/lib/paste-capture"
// Universal ingest modules — typed registry + pure paste routing + helpers.
import { routePaste } from "@/lib/attachments/paste-router"
import { htmlToMarkdown } from "@/lib/attachments/html-to-markdown"
import { dedupeFiles } from "@/lib/attachments/file-hash"
import { extractAudioMeta, extractVideoMeta } from "@/lib/attachments/media-meta"
import { defaultAttachmentRegistry } from "@/lib/attachments/registry"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { useVisualViewportCssVars } from "@/hooks/use-visual-viewport-css-vars"
import { buildComposerUploadChunks } from "@/lib/composer/upload-batching"
import {
  isAssistantMessage,
  parseMessageFilesForRender,
  shouldRenderChatMessage,
} from "@/lib/chat/message-rendering"
import {
  attachmentHasPreviewSource,
  buildAgentFileMetadata,
  collectUploadFileIds,
  getAudioMediaMeta,
  getFileProcessingStage,
  isAudioComposerFile,
  isComposerFileProcessingPending,
  isComposerFileUploadFailed,
  isComposerFileUploadPending,
  isVideoComposerFile,
  previewAttachmentKey,
  resolveComposerMediaSrc,
  resolveUploadFileId,
  snapshotComposerFilesForMessage,
} from "@/lib/chat/composer-files"
import { ChatAudioPlayer, ChatVideoPlayer } from "@/components/chat/media-preview-players"
import {
  adoptUnboundComposerQueueItems,
  createPersistedComposerQueueItem,
  readPersistedComposerQueue,
  writePersistedComposerQueue,
  type PersistedComposerQueueItem,
} from "@/lib/chat/composer-queue"
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_PROVIDER,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_MODEL,
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_COUNT_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  MUSIC_EFFECT_OPTIONS,
  MUSIC_MODEL_OPTIONS,
  MUSIC_MOOD_OPTIONS,
  MUSIC_STYLE_OPTIONS,
  MUSIC_STYLE_PROFILES,
  VIDEO_ASPECT_RATIO_OPTIONS,
  VIDEO_RESOLUTION_OPTIONS,
  VOICE_ACCENT_OPTIONS,
  VOICE_COMPOSER_PLACEHOLDER,
  VOICE_EFFECT_OPTIONS,
  VOICE_LANGUAGE_OPTIONS,
  VOICE_MODEL_OPTIONS,
  filterAdminVisibleVideoModels,
  isAdminVisibleVideoModel,
  isImageModelEntry,
  isVideoModelEntry,
  providerForMediaModel,
  type ImageAspectRatio,
  type ImageGenerationCount,
  type ImageQuality,
  type MusicEffect,
  type MusicModel,
  type MusicMood,
  type MusicStyle,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoResolution,
  type VoiceAccent,
  type VoiceEffect,
  type VoiceLanguage,
  type VoiceModel,
} from "@/lib/chat/media-composer-config"
import {
  MEDIA_MENU_DOT_CLASS,
  MEDIA_MENU_ICON_GLYPH_CLASS,
  MEDIA_MENU_ICON_WRAP_CLASS,
  MEDIA_MODE_CHIP_CLOSE_CLASS,
  VOICE_STABILITY_SLIDER_CLASS,
  mediaModeChipChrome,
} from "@/lib/chat/media-mode-chips"
import { clampVideoDuration, resolveVideoDurationSpec, stepVideoDuration } from "@/lib/chat/video-duration"
// Never-throwing clipboard (Capacitor → navigator.clipboard → execCommand fallback).
// Direct navigator.clipboard.writeText() throws NotAllowedError in restrictive
// contexts (preview iframes, denied permission, insecure origin) and, when not
// awaited/caught, surfaces as an unhandled rejection in the dev overlay.
import { writeText as copyTextSafe } from "@/lib/native/clipboard"
import { brandModelLabel, brandProviderLabel } from "@/lib/chat/brand-label"
import {
  clearPinnedModel,
  getPinnedModel,
  isPinnedModel,
  setLastModel,
  setPinnedModel,
} from "@/lib/chat/model-preference"
import {
  enrichImageFilesWithClientOcr,
  isWeakOcrText,
  looksLikeTranscriptionRequest,
  recognizeImageWithRetry,
} from "@/lib/chat/ocr-preprocess"

type ComputerUseAppMode = "browser" | "chrome" | "computer"

function ChatToolPanelLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-28 items-center justify-center gap-3 rounded-xl border border-border/50 bg-muted/20 p-6 text-sm text-muted-foreground"
    >
      <span className="h-2.5 w-2.5 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

const GPT_RATING_OPTIONS = [
  { value: 1, label: "Muy malo" },
  { value: 2, label: "Regular" },
  { value: 3, label: "Bueno" },
  { value: 4, label: "Muy bueno" },
  { value: 5, label: "Excelente" },
] as const

const getGptRatingLabel = (rating: number): string =>
  GPT_RATING_OPTIONS.find((option) => option.value === rating)?.label || ""

// Universal ingest: pasted plain text longer than this becomes a "PEGADO"
// (.txt) chip next to the input — expandable/removable — so the bar stays
// clean. Shorter pastes insert inline at the caret. Configurable per
// deployment via NEXT_PUBLIC_COMPOSER_PASTE_CHIP_THRESHOLD.
const LONG_PASTE_CHIP_THRESHOLD = (() => {
  const n = Number(process.env.NEXT_PUBLIC_COMPOSER_PASTE_CHIP_THRESHOLD)
  return Number.isFinite(n) && n > 0 ? n : 1500
})()

const normalizePlanName = (plan?: string | null): string =>
  String(plan || "FREE").trim().toUpperCase()

const isFreePlanName = (plan?: string | null): boolean =>
  normalizePlanName(plan) === "FREE"

const AGENT_TASK_STATE_FENCE = /```agent-task-state\s*\n?([\s\S]*?)\n?```/i

const parseAgentTaskMessageMetadata = (metadata: unknown): Record<string, any> => {
  if (!metadata) return {}
  if (typeof metadata === "object") return metadata as Record<string, any>
  if (typeof metadata !== "string") return {}
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

const normalizeRecoveredAgentTaskState = (value: unknown, taskId?: string | null): AgentTaskState => {
  const parsed = value && typeof value === "object"
    ? value as Partial<AgentTaskState> & { taskId?: unknown; status?: unknown }
    : {}
  const legacyTaskId = typeof parsed.taskId === "string" && parsed.taskId.trim()
    ? parsed.taskId.trim()
    : null
  const normalizedTaskId = taskId || parsed.meta?.taskId || legacyTaskId
  const normalizedStatus = String(parsed.status || "").toLowerCase()
  return {
    ...initialAgentState,
    ...parsed,
    meta: normalizedTaskId
      ? { ...(parsed.meta || {}), taskId: normalizedTaskId }
      : parsed.meta,
    steps: Array.isArray(parsed.steps)
      ? parsed.steps.map(step => ({ ...step, toolCalls: Array.isArray(step?.toolCalls) ? step.toolCalls : [] }))
      : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
    checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
    qualityGates: Array.isArray(parsed.qualityGates) ? parsed.qualityGates : [],
    repairs: Array.isArray(parsed.repairs) ? parsed.repairs : [],
    documentAnalysisIds: Array.isArray(parsed.documentAnalysisIds) ? parsed.documentAnalysisIds : [],
    evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [],
    finalText: typeof parsed.finalText === "string" ? parsed.finalText : "",
    done: Boolean(parsed.done) || normalizedStatus === "completed",
  }
}

const parseAgentTaskMessageState = (content: unknown): AgentTaskState | null => {
  if (typeof content !== "string") return null
  const match = content.match(AGENT_TASK_STATE_FENCE)
  if (!match?.[1]) return null
  try {
    return normalizeRecoveredAgentTaskState(JSON.parse(match[1]))
  } catch {
    return null
  }
}

const serializeRecoveredAgentTaskState = (state: AgentTaskState): string => {
  const fenced = '```agent-task-state\n' + JSON.stringify(state) + '\n```'
  return state.finalText ? `${fenced}\n\n${state.finalText}` : fenced
}

const getAgentTaskIdFromMessage = (message: any, state?: AgentTaskState | null): string | null => {
  const metadata = parseAgentTaskMessageMetadata(message?.metadata)
  const raw = state?.meta?.taskId || (state as AgentTaskState & { taskId?: unknown } | null)?.taskId || metadata.taskId
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

const findRecoverableAgentTaskMessage = (messages: any[] = [], taskId?: string | null) => {
  const unidentified: Array<{ message: any; state: AgentTaskState; taskId: null }> = []
  let totalCandidates = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (String(message?.role || "").toUpperCase() !== "ASSISTANT") continue
    const state = parseAgentTaskMessageState(message?.content)
    if (!state || state.done) continue
    totalCandidates += 1
    const messageTaskId = getAgentTaskIdFromMessage(message, state)
    if (taskId) {
      if (messageTaskId === taskId) return { message, state, taskId: messageTaskId }
      if (!messageTaskId) unidentified.push({ message, state, taskId: null })
      continue
    }
    return { message, state, taskId: messageTaskId }
  }
  // A single pre-task-id legacy bubble is safe to adopt. With two or more,
  // creating a fresh task-specific bubble is preferable to overwriting the
  // wrong historical execution.
  return taskId && totalCandidates === 1 && unidentified.length === 1 ? unidentified[0] : null
}

const isTerminalAgentTaskStatus = (status: unknown): boolean =>
  new Set(["completed", "cancelled", "canceled", "error", "failed"])
    .has(String(status || "").toLowerCase())

const waitForAgentTaskRecoveryPoll = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

const VIDEO_SOURCE_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i
const IMAGE_TO_VIDEO_REFERENCE_RE =
  /\b(?:image[- ]?to[- ]?video|imagen(?:es)?\s+a\s+video|foto(?:s)?\s+a\s+video)\b|\b(?:pasa(?:r|la|lo|las|los)?|pasar(?:la|lo|las|los)?|convierte(?:la|lo|las|los)?|convertir(?:la|lo|las|los)?|transforma(?:la|lo|las|los)?|transformar(?:la|lo|las|los)?|vuelve(?:la|lo|las|los)?)\b.{0,64}\bvideo\b|\b(?:anima(?:r|la|lo|las|los)?|animala|animalo|dale movimiento|darle movimiento|que se mueva)\b/

const normalizeMediaPromptText = (value: string) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()

const shouldUseLatestImageForVideo = (prompt: string) =>
  IMAGE_TO_VIDEO_REFERENCE_RE.test(normalizeMediaPromptText(prompt))

const isVideoSourceImageAttachment = (file: any) => {
  if (!file) return false
  const mimeType = String(file?.mimeType || file?.type || file?.contentType || "").toLowerCase()
  const name = String(file?.originalName || file?.name || file?.filename || file?.url || file?.imageUrl || "").toLowerCase()
  if (mimeType.startsWith("image/") || file?.type === "image") return true
  return VIDEO_SOURCE_IMAGE_EXT_RE.test(name)
}

const collectLatestGeneratedImageUrls = (messages: any[] = [], maxImages = 4) => {
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    if (String(message?.role || "").toUpperCase() !== "ASSISTANT") continue
    const files = parseMessageFilesForRender(message?.files).filter(isVideoSourceImageAttachment)
    const urls = files
      .map((file: any) => resolveImageAttachmentUrl(file, process.env.NEXT_PUBLIC_IMAGE_URL))
      .map((url: string) => String(url || "").trim())
      .filter(Boolean)
    if (urls.length > 0) return urls.slice(0, maxImages)

    const content = String(message?.content || "").trim()
    if (/^https?:\/\//i.test(content) && /\.(?:png|jpe?g|webp|gif|avif)(?:\?|#|$)/i.test(content)) {
      return [content]
    }
  }
  return []
}

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
  selectedSources?: AgenticSource[]
  elapsedMs?: number
  entries: SearchActivityEntry[]
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

function ComposerInlineLinkHighlights({ value }: { value: string }) {
  if (!value) return null

  const nodes: React.ReactNode[] = []
  let cursor = 0
  let key = 0

  for (const match of value.matchAll(URL_TOKEN_RE)) {
    const token = match[0] || ""
    const start = match.index ?? 0
    const clean = cleanUrlToken(token)
    if (!clean) continue

    if (start > cursor) {
      nodes.push(value.slice(cursor, start))
    }

    nodes.push(
      <span key={`url-${key++}`} className="composer-inline-link-highlight">
        {clean}
      </span>,
    )

    const cleanEnd = start + clean.length
    const tokenEnd = start + token.length
    if (tokenEnd > cleanEnd) {
      nodes.push(value.slice(cleanEnd, tokenEnd))
    }
    cursor = tokenEnd
  }

  if (cursor < value.length) {
    nodes.push(value.slice(cursor))
  }

  return <>{nodes}</>
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
        meta: `Objetivo ${evt.target} · lotes de ${evt.batchSize} · top ${evt.topK}` +
          (evt.discipline && evt.discipline.id !== "general" ? ` · ${evt.discipline.label}` : "") +
          ` · ${evt.providers.join(", ")}`,
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
        meta: `${evt.reason}` + (typeof evt.durationMs === "number" ? ` · ${formatActivityDuration(evt.durationMs)}` : ""),
        at,
        status: "complete",
      }
    case "collection_done":
      return {
        id: `${evt.type}-${at}`,
        title: "Recopilación completada",
        body: `${evt.totalCollected} fuentes encontradas, ${evt.deduped} únicas.`,
        meta: `${evt.requestedCalls} llamadas · ${evt.stopReason || "completo"} · ${formatActivityDuration(evt.elapsedMs)}`,
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
    case "validation_start":
      return {
        id: `${evt.type}-${at}`,
        title: "Comprobando identificadores DOI",
        body: evt.message,
        meta: `${evt.candidates} DOI candidatos`,
        at,
        status: "running",
      }
    case "validation_done":
      return {
        id: `${evt.type}-${at}`,
        title: "Comprobación DOI completada",
        body: `${evt.resolved} resueltos, ${evt.notFound} no localizados.`,
        meta: `${evt.unavailable} no disponibles`,
        at,
        status: evt.notFound > 0 ? "warning" : "complete",
      }
    case "validation_error":
      return {
        id: `${evt.type}-${at}`,
        title: "Comprobación DOI parcial",
        body: evt.error,
        meta: "La búsqueda conserva los resultados y evita afirmar resolución.",
        at,
        status: "warning",
      }
    case "systematic_review":
      return {
        id: `${evt.type}-${at}`,
        title: "Cribado sistemático completado",
        body: `${evt.prisma.screening.recordsScreened} registros cribados; ${evt.prisma.screening.recordsExcluded} excluidos y ${evt.prisma.screening.recordsUncertain} en duda.`,
        meta: `${evt.protocol.framework?.toUpperCase() || "Protocolo"} · certeza preliminar ${evt.certainty.level}`,
        at,
        status: "complete",
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
      next.selectedSources = evt.sources
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

function SearchActivityPanel({ activity, onClose, onSave }: { activity: SearchActivityState; onClose: () => void; onSave: (activity: SearchActivityState, sources?: ResearchResultSource[]) => Promise<void> }) {
  const [view, setView] = React.useState<"process" | "results">(
    activity.status === "complete" && activity.selectedSources?.length ? "results" : "process",
  )
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

      <div className="flex gap-1 border-b border-border/40 px-5 py-2" role="tablist" aria-label="Vista de investigación">
        <Button type="button" variant={view === "process" ? "secondary" : "ghost"} size="sm" role="tab" aria-selected={view === "process"} onClick={() => setView("process")}>Proceso</Button>
        <Button type="button" variant={view === "results" ? "secondary" : "ghost"} size="sm" role="tab" aria-selected={view === "results"} disabled={!activity.selectedSources?.length} onClick={() => setView("results")}>Resultados{activity.selectedSources?.length ? ` (${activity.selectedSources.length})` : ""}</Button>
      </div>

      {view === "results" && activity.selectedSources?.length ? (
        <ScrollArea className="flex-1">
          <ResearchResultsWorkbench
            compact
            query={activity.query}
            sources={activity.selectedSources}
            onSave={(sources) => onSave(activity, sources)}
          />
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1"><div className="px-5 py-5">
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
        </div></ScrollArea>
      )}
    </div>
  )
}

// Selected Text Display Component
// `SelectedTextDisplay` was extracted to
// `components/chat/ComposerInlineDisplays.tsx` and is imported above.


// Enhanced Actions Dropdown Component
const ActionsDropdown = ({
  chatType,
  setChatType,
  currentPlan,
  isWorkModeActive,
  setIsWorkModeActive,
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
  computerUseAppMode,
  setComputerUseAppMode,
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
  openVoicePanel,
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
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
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

  const handleComputerUseAppToggle = (mode: ComputerUseAppMode) => {
    const isSameModeActive = isComputerUseActive && computerUseAppMode === mode;

    if (isSameModeActive) {
      setIsComputerUseActive(false);
      setComputerUseAppMode(null);
      setChatType('text');
      return;
    }

    closeAllToolsAndConnectors();
    setComputerUseAppMode(mode);
    setIsComputerUseActive(true);
    setChatType('computer-use');
    setIsOpen(false);
  };

  const isMenuDisabled = isLoading || isUploading || isWebSearching || isProcessingGmail || isProcessingGoogleServices;
  const isToolSwitchDisabled = isMenuDisabled || isGeneratingImage;
  // Premium tools are also marketing/configuration previews for FREE users.
  // Keep them selectable while a normal chat response is loading so users can
  // open the tool chip and inspect model/settings options without generating.
  const isPremiumPreviewSwitchDisabled = isGeneratingImage || isUploading;

  const handleDropdownOpenChange = (open: boolean) => {
    setIsOpen(open);
    setTooltipOpen(false);
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

  const handleTooltipOpenChange = React.useCallback((open: boolean) => {
    if (open && (isOpen || justClosed || isMenuDisabled)) {
      setTooltipOpen(false);
      return;
    }
    setTooltipOpen(open);
  }, [isMenuDisabled, isOpen, justClosed]);

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

  const controlAppItems = [
    {
      key: "browser-control",
      brand: "browser-control",
      label: "Navegador",
      description: "Navega, busca y extrae datos",
      active: isComputerUseActive && computerUseAppMode === "browser",
      disabled: isToolSwitchDisabled,
      dotClassName: "bg-sky-500",
      iconClassName: "bg-sky-100 dark:bg-sky-900/20",
      icon: <AppWindow className="h-4 w-4 text-sky-600 dark:text-sky-400" />,
      onClick: () => handleComputerUseAppToggle("browser"),
    },
    {
      key: "chrome-control",
      brand: "chrome-control",
      label: "Chrome",
      description: "Automatiza Chrome",
      active: isComputerUseActive && computerUseAppMode === "chrome",
      disabled: isToolSwitchDisabled,
      dotClassName: "bg-blue-500",
      iconClassName: "bg-blue-100 dark:bg-blue-900/20",
      icon: <Chrome className="h-4 w-4 text-blue-600 dark:text-blue-400" />,
      onClick: () => handleComputerUseAppToggle("chrome"),
    },
    {
      key: "computer-control",
      brand: "computer-control",
      label: "Computadora",
      description: "Control local seguro",
      active: isComputerUseActive && computerUseAppMode === "computer",
      disabled: isToolSwitchDisabled,
      dotClassName: "bg-indigo-500",
      iconClassName: "bg-indigo-100 dark:bg-indigo-900/20",
      icon: <Monitor className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />,
      onClick: () => handleComputerUseAppToggle("computer"),
    },
  ];

  const activeAppsCount = [...connectorItems, ...controlAppItems].filter((item) => item.active).length;

  const renderAppMenuItem = (item: {
    key: string;
    brand: string;
    label: string;
    description?: string;
    active: boolean;
    disabled?: boolean;
    dotClassName: string;
    iconClassName: string;
    icon: JSX.Element;
    onClick: () => void;
  }) => (
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
          {item.description && (
            <div className="truncate text-xs text-muted-foreground">
              {item.description}
            </div>
          )}
        </div>
        {item.active && (
          <div className={`h-2 w-2 shrink-0 rounded-full ${item.dotClassName}`} aria-label="Activa" />
        )}
      </div>
    </DropdownMenuItem>
  );

  const renderConnectorItems = () => connectorItems.map((item) => renderAppMenuItem(item));

  const renderControlAppItems = () => controlAppItems.map((item) => renderAppMenuItem(item));

  const renderAppsMenuContent = () => (
    <>
      {renderConnectorItems()}
      <div className="my-1 h-px bg-border/45" />
      <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Control
      </div>
      {renderControlAppItems()}
    </>
  );

  return (
    <TooltipProvider>
      <DropdownMenu dir="ltr" open={isOpen} onOpenChange={handleDropdownOpenChange}>
        <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange} delayDuration={300}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Adjuntar archivos y herramientas"
                className="composer-plus-liquid-button flex h-10 w-10 items-center justify-center rounded-full p-0"
                disabled={isMenuDisabled}
              >
                <Plus className="relative z-10 h-5 w-5" strokeWidth={2.2} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Adjuntar archivos y herramientas</p>
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
              <div className="liquid-icon w-8 h-8 shrink-0 rounded-full bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                <Paperclip className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">Subir archivos</div>
                <div className="truncate text-xs text-muted-foreground">
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
            accept="image/*,audio/*,video/*,application/pdf,.doc,.docx,.xlsx,.ppt,.pptx,.txt,.csv,.tsv,.md,.markdown,.rtf,.odt,.ods,.odp,.json,.xml,.html,.htm,.eml,.msg,.mp3,.wav,.m4a,.aac,.ogg,.mp4,.mov,.webm,.mpeg"
            onChange={handleFilesSelected}
          />
          {/* Web Search */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={handleWebSearchToggle}
            disabled={isWebSearching || isGeneratingImage}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="liquid-icon w-8 h-8 shrink-0 rounded-full bg-emerald-100 dark:bg-emerald-900/20 flex items-center justify-center">
                <Globe className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isWebSearchActive ? 'Búsqueda web activa' : 'Búsqueda web'}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  Busca en internet en tiempo real
                </div>
              </div>
              {isWebSearchActive && (
                <div className="w-2 h-2 shrink-0 bg-emerald-500 rounded-full" />
              )}
            </div>
          </DropdownMenuItem>
          {/* Voice mode. This used to be reachable only by pressing the
              composer's primary button while it was empty, where it rendered as
              a waveform icon sitting right next to the dictation mic — two
              adjacent speech affordances with no way to tell them apart. The
              primary button is now always Send, so voice mode lives here. */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={() => openVoicePanel?.()}
          >
            <div className="flex items-center gap-3 w-full">
              <div className="liquid-icon w-8 h-8 shrink-0 rounded-full bg-violet-100 dark:bg-violet-900/20 flex items-center justify-center">
                <AudioLines className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">Modo de voz</div>
                <div className="truncate text-xs text-muted-foreground">
                  Habla en lugar de escribir
                </div>
              </div>
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
              <div className="liquid-icon w-8 h-8 shrink-0 rounded-full bg-gray-100 dark:bg-gray-900/20 flex items-center justify-center">
                <Network className="h-4 w-4 text-gray-600 dark:text-gray-300" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">Apps</div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeAppsCount > 0 ? `${activeAppsCount} activa${activeAppsCount > 1 ? "s" : ""}` : "Gmail, Drive, Navegador, Chrome"}
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", mobileAppsOpen && "rotate-180")} />
            </div>
          </DropdownMenuItem>
          {mobileAppsOpen && (
            <div className="chat-mobile-apps-panel md:hidden">
              {renderAppsMenuContent()}
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
                <div className="liquid-icon w-8 h-8 shrink-0 rounded-full bg-gray-100 dark:bg-gray-900/20 flex items-center justify-center">
                  <Network className="h-4 w-4 text-gray-600 dark:text-gray-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="liquid-label font-medium text-sm">Apps</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {activeAppsCount > 0 ? `${activeAppsCount} activa${activeAppsCount > 1 ? "s" : ""}` : "Gmail, Drive, Navegador, Chrome"}
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
                {renderAppsMenuContent()}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuSeparator className="liquid-menu-separator" />
          <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            Generar con IA
          </div>

          {/* Image Generation */}
          <DropdownMenuItem
            className="liquid-menu-item"
            onClick={handleImageGenerationToggle}
            disabled={isPremiumPreviewSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={MEDIA_MENU_ICON_WRAP_CLASS}>
                <Palette className={MEDIA_MENU_ICON_GLYPH_CLASS} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isImageGenerationActive ? 'Imágenes activas' : 'Imágenes'}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {isGeneratingImage ? 'Generando ahora' : 'Genera imágenes con IA'}
                </div>
              </div>
              {(isImageGenerationActive || isGeneratingImage) && (
                <div className={cn(MEDIA_MENU_DOT_CLASS, isGeneratingImage && "animate-pulse")} />
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
            disabled={isPremiumPreviewSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={MEDIA_MENU_ICON_WRAP_CLASS}>
                <AudioLines className={MEDIA_MENU_ICON_GLYPH_CLASS} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">{isVoiceGenerationActive ? 'Voz activa' : 'Voz'}</div>
                <div className="truncate text-xs text-muted-foreground">
                  Texto a voz · Gemini y ElevenLabs
                </div>
              </div>
              {isVoiceGenerationActive && (
                <div className={MEDIA_MENU_DOT_CLASS} />
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
            disabled={isPremiumPreviewSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={MEDIA_MENU_ICON_WRAP_CLASS}>
                <Video className={MEDIA_MENU_ICON_GLYPH_CLASS} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isVideoGenerationActive ? 'Video activo' : 'Video'}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  Crea videos con IA
                </div>
              </div>
              {isVideoGenerationActive && (
                <div className={MEDIA_MENU_DOT_CLASS} />
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
            disabled={isPremiumPreviewSwitchDisabled}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={MEDIA_MENU_ICON_WRAP_CLASS}>
                <Music className={MEDIA_MENU_ICON_GLYPH_CLASS} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="liquid-label font-medium text-sm">
                  {isMusicGenerationActive ? 'Música activa' : 'Música'}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  Genera canciones con IA
                </div>
              </div>
              {isMusicGenerationActive && (
                <div className={MEDIA_MENU_DOT_CLASS} />
              )}
              {isFreePlan && (
                <Badge variant="secondary" className="text-xs">Pro</Badge>
              )}
            </div>
          </DropdownMenuItem>

        </DropdownMenuContent>
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
// Human-readable byte size for attachment chips ("1,5 MB").
const formatChipBytes = (bytes: number | null | undefined): string => {
  if (!Number.isFinite(bytes as number) || (bytes as number) <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes as number;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const rounded = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toFixed(1).replace(".", ",");
  return `${rounded} ${units[unit]}`;
};

// "m:ss" / "h:mm:ss" duration label for audio/video chips.
const formatChipDuration = (seconds: number | null | undefined): string => {
  if (!Number.isFinite(seconds as number) || (seconds as number) <= 0) return "";
  const total = Math.round(seconds as number);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

// Mini-waveform for audio chips — normalized peaks (0..1) to bars.
const ChipWaveform = ({ peaks }: { peaks: number[] }) => (
  <span aria-hidden className="flex h-[16px] items-end gap-[1.5px]">
    {peaks.slice(0, 36).map((p, i) => (
      <span
        key={i}
        className="w-[2px] rounded-full bg-zinc-900/70 dark:bg-zinc-100/70"
        style={{ height: `${Math.max(2, Math.round(p * 16))}px` }}
      />
    ))}
  </span>
);

type ActiveOptionsDisplayProps = {
  uploadedFiles: any[];
  removeFile: (index: number) => void;
  uploadProgress: { [key: string]: number };
  retryUpload?: (file: any) => void;
  restoreLongPasteToInput?: (file: any, index: number) => void;
  onPreviewAttachment?: (attachment: AttachmentLike, siblings: AttachmentLike[], index: number) => void;
  onFileProcessingStatusChange?: (file: any, status: FileProcessingStatus) => void;
  moveFile?: (index: number, delta: -1 | 1) => void;
}

function areActiveOptionsDisplayPropsEqual(
  prev: ActiveOptionsDisplayProps,
  next: ActiveOptionsDisplayProps,
) {
  return (
    prev.uploadedFiles === next.uploadedFiles &&
    prev.uploadProgress === next.uploadProgress &&
    prev.removeFile === next.removeFile &&
    prev.retryUpload === next.retryUpload &&
    prev.restoreLongPasteToInput === next.restoreLongPasteToInput &&
    prev.onPreviewAttachment === next.onPreviewAttachment &&
    prev.onFileProcessingStatusChange === next.onFileProcessingStatusChange &&
    prev.moveFile === next.moveFile
  )
}

// Active Options Display Component - Renders above the textarea
const ActiveOptionsDisplay = React.memo(function ActiveOptionsDisplay({
  uploadedFiles,
  removeFile,
  uploadProgress,
  retryUpload,
  restoreLongPasteToInput,
  onPreviewAttachment,
  onFileProcessingStatusChange,
  moveFile,
}: ActiveOptionsDisplayProps) {
  // Screen-reader announcement for keyboard reordering (aria-live).
  const [reorderAnnouncement, setReorderAnnouncement] = React.useState("");
  // Inline expanded preview for "PEGADO" text-snippet chips.
  const [expandedSnippetId, setExpandedSnippetId] = React.useState<string | null>(null);
  // Viewer state — same reusable viewer used by sent-message chips, so
  // the user gets identical high-fidelity preview in both contexts.
  const [viewingIndex, setViewingIndex] = React.useState<number | null>(null);
  const viewingAttachment: AttachmentLike | null = React.useMemo(() => {
    if (viewingIndex === null) return null;
    const f = uploadedFiles[viewingIndex];
    if (!f) return null;
    return toDocumentViewerAttachmentWithProgress(f, uploadProgress);
  }, [viewingIndex, uploadedFiles, uploadProgress]);
  const viewerSiblings: AttachmentLike[] = React.useMemo(
    () => uploadedFiles.map((f: any) => toDocumentViewerAttachmentWithProgress(f, uploadProgress)),
    [uploadedFiles, uploadProgress]
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
    <div className="composer-attachment-rail">
      {/* aria-live announcer so keyboard reordering is narrated. */}
      <span aria-live="polite" className="sr-only">{reorderAnnouncement}</span>
      <div
        role="list"
        aria-label="Archivos adjuntos"
        className="flex flex-wrap items-end gap-2"
      >
        <AnimatePresence initial={false}>
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
          const imageSizeClass = uploadedFiles.length > 1 ? 'h-[4.5rem] w-[4.5rem]' : 'h-20 w-20';
          const attachment = viewerSiblings[index];
          const canPreview = !isFailed
            && !isUploading
            && canOpenComposerPreview({ id: resolveUploadFileId(file), status: file.status })
            && attachmentHasPreviewSource(attachment);
          const openPreview = () => {
            if (!canPreview || !attachment) return;
            if (onPreviewAttachment) {
              onPreviewAttachment(attachment, viewerSiblings, index);
            } else {
              setViewingIndex(index);
            }
          };

          const chipKey = String(file.tempId || file.id || `${file.name}-${index}`);
          const isAudio = isAudioComposerFile(file);
          const isVideo = isVideoComposerFile(file);
          const isDocPage = !isImage && !isAudio && !isVideo && !longPasteMeta
            && isPagePreviewDocument(file.name, file.type || file.mimeType);
          const chipLabel = `${longPasteMeta?.title || file.name}, adjunto ${index + 1} de ${uploadedFiles.length}`;
          const thumbProgress = describeComposerDocumentThumb({
            uploading: isUploading,
            uploadProgress: progress,
            status: file.status,
            stage: getFileProcessingStage(file),
            error: file.processingError || file.uploadError,
          });
          const docBusy = thumbProgress.busy;
          const handleReorder = (delta: -1 | 1) => {
            if (!moveFile) return;
            const target = index + delta;
            if (target < 0 || target >= uploadedFiles.length) return;
            moveFile(index, delta);
            setReorderAnnouncement(`${file.name} movido a la posición ${target + 1} de ${uploadedFiles.length}`);
          };

          return (
            <motion.div
              key={chipKey}
              layout
              initial={{ opacity: 0, scale: 0.85, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: 8 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.7 }}
              className={cn(
                "relative text-sm",
                "border bg-background/90",
                isFailed ? "border-red-300 dark:border-red-700/50" : "border-border/70",
                isImage
                  ? `${imageSizeClass} overflow-hidden rounded-[0.9rem] p-0 shadow-sm`
                  : isDocPage
                    ? "h-[7.75rem] w-[5.7rem] overflow-hidden rounded-[0.9rem] p-0 shadow-sm"
                    : isVideo
                      ? "w-[16.5rem] overflow-hidden rounded-[0.95rem] border-0 bg-transparent p-0 shadow-none"
                      : isAudio
                        ? "min-w-[14.5rem] max-w-[22rem] overflow-hidden rounded-2xl border-0 bg-transparent p-0 shadow-none"
                    : "flex min-h-[3.25rem] min-w-[12.5rem] max-w-[20rem] items-center gap-2.5 rounded-2xl px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
                // Clickable chip — opens the unified high-fidelity viewer.
                canPreview && "cursor-pointer hover:border-foreground/35 hover:shadow-md transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
              title={isFailed
                ? `Subida fallida: ${file.uploadError || 'error'}`
                : isUploading
                  ? 'Subiendo…'
                  : canPreview
                    ? (thumbProgress.busy && thumbProgress.label ? `Ver documento · ${thumbProgress.label}` : 'Ver documento')
                    : (thumbProgress.label || 'Preparando documento')}
              onClick={openPreview}
              role="listitem"
              aria-label={chipLabel}
              tabIndex={0}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  removeFile(index);
                  setReorderAnnouncement(`${file.name} eliminado`);
                  return;
                }
                if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); handleReorder(-1); return; }
                if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); handleReorder(1); return; }
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

                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-1 right-1 h-6 w-6 p-0 bg-white dark:bg-background rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                    onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                    title={isUploading ? "Cancelar subida" : "Quitar"}
                    aria-label={isUploading ? "Cancelar subida" : "Quitar archivo"}
                  >
                    <X className="h-4 w-4 text-gray-600 dark:text-foreground" />
                  </Button>
                </>
              ) : isDocPage ? (
                <>
                  <FileProcessingStatusSync
                    fileId={isUploading ? null : file.id}
                    onReady={() => toast.success(`Documento listo: ${file.name}`)}
                    onStatusChange={(status) => onFileProcessingStatusChange?.(file, status)}
                  />
                  <DocumentPageThumb
                    source={{
                      id: file.id,
                      name: file.name,
                      mimeType: file.type || file.mimeType,
                      size: file.size,
                      file: getAttachmentLocalFile(file),
                      url: file.url,
                    }}
                    busy={docBusy}
                    progress={isUploading ? progress : null}
                    label={thumbProgress.label}
                  />
                  {isFailed && retryUpload && (
                    <div className="absolute inset-0 bg-red-900/55 flex flex-col items-center justify-center gap-1 rounded-[0.9rem]">
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
                      <span className="max-w-[90%] truncate px-1 text-center text-[9.5px] text-white font-medium">
                        {thumbProgress.label || "Reintentar"}
                      </span>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-1 right-1 h-6 w-6 p-0 bg-white dark:bg-background rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                    onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                    title={isUploading ? "Cancelar subida" : "Quitar"}
                    aria-label={isUploading ? "Cancelar subida" : "Quitar archivo"}
                  >
                    <X className="h-4 w-4 text-gray-600 dark:text-foreground" />
                  </Button>
                </>
              ) : isVideo ? (
                <>
                  <ChatVideoPlayer
                    src={resolveComposerMediaSrc(file)}
                    file={getAttachmentLocalFile(file)}
                    poster={file.mediaMeta?.thumbnailDataUrl || file.thumbnailUrl || null}
                    title={file.name || "video"}
                    durationSeconds={file.mediaMeta?.durationSeconds}
                    variant="composer"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-1 right-1 z-30 h-6 w-6 p-0 bg-white dark:bg-background rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                    onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                    title={isUploading ? "Cancelar subida" : "Quitar"}
                    aria-label={isUploading ? "Cancelar subida" : "Quitar archivo"}
                  >
                    <X className="h-4 w-4 text-gray-600 dark:text-foreground" />
                  </Button>
                </>
              ) : isAudio ? (
                <>
                  <ChatAudioPlayer
                    src={resolveComposerMediaSrc(file)}
                    file={getAttachmentLocalFile(file)}
                    title={file.name || "audio"}
                    durationSeconds={getAudioMediaMeta(file)?.durationSeconds}
                    peaks={getAudioMediaMeta(file)?.peaks}
                    variant="composer"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-1 right-1 z-30 h-6 w-6 p-0 bg-white dark:bg-background rounded-full shadow-md flex items-center justify-center hover:bg-gray-100"
                    onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                    title={isUploading ? "Cancelar subida" : "Quitar"}
                    aria-label={isUploading ? "Cancelar subida" : "Quitar archivo"}
                  >
                    <X className="h-4 w-4 text-gray-600 dark:text-foreground" />
                  </Button>
                </>
              ) : (
                <>
                  {getFileIcon(file)}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className={`truncate font-medium text-[13px] ${isFailed ? 'text-red-600 dark:text-red-400' : ''}`}>
                      {longPasteMeta && (
                        <span className="mr-1.5 inline-flex items-center rounded bg-muted px-1 py-px align-middle text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Pegado
                        </span>
                      )}
                      {longPasteMeta?.title || file.name}
                    </span>
                    {/* Secondary metadata line — readable size + media details. */}
                    {!longPasteMeta && !isFailed && (
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] leading-tight text-muted-foreground">
                        {isAudio && Array.isArray(file.mediaMeta?.peaks) && file.mediaMeta.peaks.length > 0 && (
                          <ChipWaveform peaks={file.mediaMeta.peaks} />
                        )}
                        {isAudio && formatChipDuration(file.mediaMeta?.durationSeconds) && (
                          <span className="tabular-nums">{formatChipDuration(file.mediaMeta?.durationSeconds)}</span>
                        )}
                        {formatChipBytes(file.size) && (
                          <span className="tabular-nums">{formatChipBytes(file.size)}</span>
                        )}
                      </span>
                    )}
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
                          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedSnippetId((cur) => (cur === chipKey ? null : chipKey));
                          }}
                          aria-expanded={expandedSnippetId === chipKey}
                          aria-label={expandedSnippetId === chipKey ? "Contraer vista previa del texto pegado" : "Expandir vista previa del texto pegado"}
                          title={expandedSnippetId === chipKey ? "Contraer" : "Expandir"}
                        >
                          {expandedSnippetId === chipKey ? "Contraer ▴" : "Expandir ▾"}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 underline-offset-2 hover:bg-muted/60 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
                    {longPasteMeta && expandedSnippetId === chipKey && (
                      <pre className="mt-1.5 max-h-36 max-w-[340px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 font-sans text-[11.5px] leading-snug text-foreground/85">
                        {longPasteMeta.preview || longPasteMeta.text?.slice(0, 700)}
                        {(longPasteMeta.originalCharCount || 0) > 700 && (
                          <span className="text-muted-foreground">{"\n"}… ({Intl.NumberFormat('es').format(longPasteMeta.originalCharCount)} caracteres en total)</span>
                        )}
                      </pre>
                    )}
                    {!isFailed && !longPasteMeta && (isUploading || file.id) && (
                      <div className="mt-1">
                        <FileUploadProgress
                          uploading={isUploading}
                          uploadProgress={progress}
                          fileId={file.id}
                          onReady={() => toast.success(`Documento listo: ${file.name}`)}
                          onStatusChange={(status) => onFileProcessingStatusChange?.(file, status)}
                        />
                      </div>
                    )}
                    {isFailed && (
                      <span className="text-[10px] text-red-500 dark:text-red-400 mt-0.5 truncate">
                        {file.uploadError || 'Error de subida'}
                      </span>
                    )}
                  </div>
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
                      title={isUploading ? "Cancelar subida" : "Quitar"}
                      aria-label={isUploading ? "Cancelar subida" : "Quitar archivo"}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          );
        })}
        </AnimatePresence>
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
}, areActiveOptionsDisplayPropsEqual);
// Active Tools Display Component - Shows INSIDE the textarea at the bottom
const ActiveToolsDisplay = ({
  isWorkModeActive,
  setIsWorkModeActive,
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
  isGeneratingVoice = false,
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
  onOpenVoiceCatalog,
  selectedVoiceName,
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
  computerUseAppMode,
  setComputerUseAppMode,
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
  onVideoGenerationClose,

  handleComputerUseToggle,
  handleGmailToggle,
  handleGoogleCalendarToggle,
  handleGoogleDriveToggle,
  handleSpotifyToggle,
  handleWordConnectorToggle,
  handleExcelConnectorToggle
}: {
  isWorkModeActive: boolean;
  setIsWorkModeActive: (value: boolean) => void;
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
  isGeneratingVoice?: boolean;
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
  onOpenVoiceCatalog: () => void;
  selectedVoiceName?: string | null;
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
  computerUseAppMode: ComputerUseAppMode | null;
  setComputerUseAppMode: (mode: ComputerUseAppMode | null) => void;
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
  onVideoGenerationClose?: () => void;

  handleComputerUseToggle: () => void;
  handleGmailToggle: () => void;
  handleGoogleCalendarToggle: () => void;
  handleGoogleDriveToggle: () => void;
  handleSpotifyToggle: () => void;
  handleWordConnectorToggle: () => void;
  handleExcelConnectorToggle: () => void;
}) => {
  const [showAllImageRatios, setShowAllImageRatios] = React.useState(false);
  const [showAllVideoRatios, setShowAllVideoRatios] = React.useState(false);
  const activeComputerUseMode = computerUseAppMode || "computer";
  const computerUseAppMeta: Record<ComputerUseAppMode, { label: string; icon: JSX.Element }> = {
    browser: { label: "Navegador", icon: <AppWindow className="h-4 w-4" /> },
    chrome: { label: "Chrome", icon: <Chrome className="h-4 w-4" /> },
    computer: { label: "Computadora", icon: <Monitor className="h-4 w-4" /> },
  };
  const computerUseStatusClass =
    computerUseStatus === "running" ? "bg-green-500 animate-pulse" :
      computerUseStatus === "completed" ? "bg-blue-500" :
        computerUseStatus === "error" ? "bg-red-500" : "bg-gray-400";
  const activeComputerUseIcon = (
    <span className="relative inline-flex h-4 w-4 items-center justify-center">
      {computerUseAppMeta[activeComputerUseMode].icon}
      <span className={cn("absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ring-1 ring-background", computerUseStatusClass)} />
    </span>
  );
  const activeConnectors = [
    isGmailActive && { id: 'gmail', label: 'Gmail', icon: <img src="/icons/google.png" alt="Gmail" className="h-4 w-4" /> },
    isGoogleCalendarActive && { id: 'calendar', label: 'Calendar', icon: <img src="/icons/google-calendar.png" alt="Google Calendar" className="h-4 w-4" /> },
    isGoogleDriveActive && { id: 'drive', label: 'Drive', icon: <img src="/icons/google-drive.png" alt="Google Drive" className="h-4 w-4" /> },
    isSpotifyActive && { id: 'spotify', label: 'Spotify', icon: <img src="/icons/spotify.png" alt="Spotify" className="h-4 w-4" /> },
    isWordConnectorActive && { id: 'word', label: 'Word', icon: <img src="/icons/Word.png" alt="Word" className="h-4 w-4" /> },
    isExcelConnectorActive && { id: 'excel', label: 'Excel', icon: <img src="/icons/Excel.png" alt="Excel" className="h-4 w-4" /> },
    isComputerUseActive && { id: `computer-use-${activeComputerUseMode}`, label: computerUseAppMeta[activeComputerUseMode].label, icon: activeComputerUseIcon },
  ].filter(Boolean) as { id: string; label: string; icon: JSX.Element }[];

  const hasConnectors = activeConnectors.length > 0;
  const hasOtherTools = isWorkModeActive || isImageGenerationActive || isVoiceGenerationActive || isMusicGenerationActive || isVideoGenerationActive || isWebSearchActive;
  const hasThesis = chatType === 'thesis';
  const visibleImageAspectRatioOptions = React.useMemo(
    () => IMAGE_ASPECT_RATIO_OPTIONS.filter(option => showAllImageRatios || option.visibleByDefault || option.value === selectedImageAspectRatio),
    [selectedImageAspectRatio, showAllImageRatios]
  );
  const hiddenImageAspectRatioCount = IMAGE_ASPECT_RATIO_OPTIONS.filter(option => !option.visibleByDefault).length;

  const handleCloseAllConnectors = () => {
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    setIsComputerUseActive(false);
    setComputerUseAppMode(null);
    setChatType('text');
  };

  // Remove a single connector chip (mirrors the direct-setter approach of
  // handleCloseAllConnectors so it never triggers a disconnect side-effect).
  const removeConnector = (id: string) => {
    if (id === 'gmail') setIsGmailActive(false);
    else if (id === 'calendar') setIsGoogleCalendarActive(false);
    else if (id === 'drive') setIsGoogleDriveActive(false);
    else if (id === 'spotify') setIsSpotifyActive(false);
    else if (id === 'word') setIsWordConnectorActive(false);
    else if (id === 'excel') setIsExcelConnectorActive(false);
    else if (id.startsWith('computer-use')) { setIsComputerUseActive(false); setComputerUseAppMode(null); }
  };

  const activateComputerUseMode = (mode: ComputerUseAppMode) => {
    setIsWebSearchActive(false);
    setIsImageGenerationActive(false);
    setIsVoiceGenerationActive(false);
    setIsMusicGenerationActive(false);
    setIsVideoGenerationActive(false);
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    setComputerUseAppMode(mode);
    setIsComputerUseActive(true);
    setChatType('computer-use');
  };

  const handleComputerUseModeSwitch = (mode: ComputerUseAppMode, checked: boolean) => {
    if (checked) {
      activateComputerUseMode(mode);
      return;
    }

    if (isComputerUseActive && activeComputerUseMode === mode) {
      setIsComputerUseActive(false);
      setComputerUseAppMode(null);
      setChatType('text');
    }
  };

  const handleImageGenerationClose = () => {
    if (isGeneratingImage) return;
    setIsImageGenerationActive(false);
    setChatType('text');
  };

  const handleVoiceGenerationClose = () => {
    if (isGeneratingVoice) return;
    setIsVoiceGenerationActive(false);
    setChatType('text');
  };

  const handleMusicGenerationClose = () => {
    setIsMusicGenerationActive(false);
    setShowAudioPanel(false);
    setChatType('text');
  };

  const handleVideoGenerationClose = () => {
    onVideoGenerationClose?.();
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
      // Video: admin catalog only (type=VIDEO + isActive). Hidden/unknown = omit.
      const predicate = kind === "image" ? isImageModelEntry : isAdminVisibleVideoModel;
      return models.filter(predicate);
    };
    const normalize = (model: any) => ({
      name: model.name,
      displayName: model.displayName || model.name,
      provider: model.provider || null,
      iconName: resolveModelIconName(model),
      mode: model?.apiData?.fal?.mode || model?.pricing?.mode || null,
      qualityTier: model?.apiData?.fal?.qualityTier || model?.pricing?.qualityTier || null,
    });

    const imageModels = pickByKind("image").map(normalize);
    const videoModels = pickByKind("video").map(normalize);

    return {
      image: imageModels,
      video: videoModels,
      voice: VOICE_MODEL_OPTIONS.map((name) => ({
        name,
        displayName: name,
        provider: name === "ElevenLabs" ? "ElevenLabs" : "Google",
        iconName: name.startsWith("Gemini") ? "GeminiLogo" : "Bot",
      })),
      music: MUSIC_MODEL_OPTIONS.map((name) => ({
        name,
        displayName: name,
        provider: name === "Lyria 3 Pro" ? "Google" : name === "ElevenLabs" ? "ElevenLabs" : "Mimo",
        iconName: name === "Lyria 3 Pro" ? "GeminiLogo" : "Bot",
      })),
    };
  }, [availableModels]);

  React.useEffect(() => {
    if (!isImageGenerationActive) return;
    const imageOptions = mediaModelOptions.image;
    if (!imageOptions.length) {
      if (selectedImageModel) setSelectedImageModel("");
      return;
    }
    if (!imageOptions.some((option: any) => option.name === selectedImageModel)) {
      setSelectedImageModel(imageOptions[0].name);
    }
  }, [isImageGenerationActive, mediaModelOptions.image, selectedImageModel, setSelectedImageModel]);

  React.useEffect(() => {
    if (!isVideoGenerationActive) return;
    const videoOptions = mediaModelOptions.video;
    if (!videoOptions.length) {
      if (selectedVideoModel) setSelectedVideoModel("");
      return;
    }
    if (!videoOptions.some((option: any) => option.name === selectedVideoModel)) {
      setSelectedVideoModel(videoOptions[0].name);
    }
  }, [isVideoGenerationActive, mediaModelOptions.video, selectedVideoModel, setSelectedVideoModel]);

  React.useEffect(() => {
    const fal = (availableModels || []).find((model: any) => model?.name === selectedVideoModel)?.apiData?.fal
    const durationSpec = resolveVideoDurationSpec(selectedVideoModel, fal)
    const next = clampVideoDuration(selectedVideoDuration, durationSpec, undefined, selectedVideoResolution)
    if (next != null && next !== selectedVideoDuration) setSelectedVideoDuration(next)
  }, [availableModels, selectedVideoModel, selectedVideoDuration, selectedVideoResolution, setSelectedVideoDuration]);

  // Activate a model chosen from the floating fal.ai model gallery (mounted at
  // the page level, decoupled from this composer). Image/video map onto the
  // string-based pickers; audio/3d selections only surface the launcher toast.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const model = (e as CustomEvent).detail as { id?: string; group?: string } | undefined;
      if (!model || !model.id) return;
      if (model.group === "image") setSelectedImageModel(model.id);
      else if (model.group === "video") {
        // Hidden/disabled admin VIDEO rows must not become selectable via the gallery.
        const allowed = (Array.isArray(availableModels) ? availableModels : []).some(
          (entry: any) => isAdminVisibleVideoModel(entry) && String(entry?.name || "") === model.id,
        );
        if (allowed) setSelectedVideoModel(model.id);
      }
    };
    window.addEventListener("siragpt:fal-model-selected", handler as EventListener);
    return () => window.removeEventListener("siragpt:fal-model-selected", handler as EventListener);
  }, [availableModels, setSelectedImageModel, setSelectedVideoModel]);

  const renderMediaModelPicker = (
    tool: "image" | "voice" | "music" | "video",
    value: string,
    onChange: (name: string, provider?: string | null) => void,
  ) => {
    const options = mediaModelOptions[tool];
    const selected = options.find((option: any) => option.name === value) || options[0];
    const label = selected
      ? brandModelLabel(selected)
      : (["image", "video"].includes(tool) ? "Sin modelos" : value || "Modelo");
    const disabled = options.length === 0;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="media-model-trigger group/media-model relative isolate h-7 sm:h-8 max-w-[200px] sm:max-w-[300px] shrink-0 gap-1 sm:gap-1.5 overflow-hidden rounded-full px-2 sm:px-3 py-0 text-[12px] sm:text-[14px] font-semibold"
            aria-label={`Seleccionar modelo de ${tool}`}
            title={`Modelo: ${label}${selected?.provider ? ` · ${selected.provider}` : ""}`}
            disabled={disabled}
            data-media-tool={tool}
          >
            <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/media-model:left-[92%] group-hover/media-model:opacity-100 dark:via-white/20" />
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <IconProvider name={selected?.iconName || "Bot"} size={16} />
            </span>
            <span className="min-w-0 truncate max-w-[60px] sm:max-w-[200px]" title={label}>{label}</span>
            {!disabled && <ChevronDown className="h-3.5 sm:h-4 w-3.5 sm:w-4 shrink-0 opacity-60" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="liquid-menu-surface media-model-menu w-[min(calc(100vw-1rem),18rem)] overflow-hidden"
          data-media-tool={tool}
          style={{ maxHeight: "min(60dvh, 360px)" }}
        >
          {options.length > 0 ? (
            <div className="media-model-scroll overflow-y-auto" style={{ maxHeight: "calc(min(60dvh, 360px) - 0.75rem)" }}>
              <div className="flex flex-col gap-0.5">
                {options.map((option: any) => (
                  <DropdownMenuItem
                    key={option.name}
                    className="media-model-item gap-2"
                    onClick={() => onChange(option.name, option.provider)}
                    data-selected={option.name === value ? "true" : undefined}
                    data-media-tool={tool}
                  >
                    <span className="media-model-logo-chip">
                      <IconProvider name={option.iconName || "Bot"} size={17} className="shrink-0" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold leading-4 text-zinc-900 dark:text-white/92" title={brandModelLabel(option)}>{brandModelLabel(option)}</span>
                      <span className="block truncate text-[10.5px] font-medium leading-3 text-zinc-500 dark:text-white/62" title={[option.provider, option.qualityTier, option.mode].filter(Boolean).join(" / ") || "Modelo"}>
                        {[option.provider, option.qualityTier, option.mode].filter(Boolean).join(" / ") || "Modelo"}
                      </span>
                    </span>
                    {option.name === value && <Check className="h-3.5 w-3.5 shrink-0 opacity-80" />}
                  </DropdownMenuItem>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Activa modelos en Admin Models</div>
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
      <div className="my-1 h-px bg-border/45" />
      <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Control
      </div>
      {(["browser", "chrome", "computer"] as ComputerUseAppMode[]).map((mode) => (
        <DropdownMenuItem key={mode} className="chat-active-apps-menu-item" onSelect={(e) => e.preventDefault()}>
          <div className="flex items-center justify-between w-full gap-4">
            <div className="flex min-w-0 items-center gap-2.5">
              {computerUseAppMeta[mode].icon}
              <span className="truncate">{computerUseAppMeta[mode].label}</span>
            </div>
            <Switch
              checked={isComputerUseActive && activeComputerUseMode === mode}
              onCheckedChange={(checked) => handleComputerUseModeSwitch(mode, checked)}
            />
          </div>
        </DropdownMenuItem>
      ))}
    </>
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
      {activeConnectors.map((c) => (
        <span
          key={c.id}
          className="chat-active-apps-chip inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/80 py-0 pl-2.5 pr-1.5 text-xs font-medium text-foreground shadow-sm"
        >
          <span className="grid h-4 w-4 shrink-0 place-items-center">{c.icon}</span>
          <span className="max-w-[100px] truncate">{c.label}</span>
          <button
            type="button"
            onClick={() => removeConnector(c.id)}
            aria-label={`Quitar ${c.label}`}
            title={`Quitar ${c.label}`}
            className="ml-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {isWorkModeActive && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 py-0 pl-2.5 pr-1.5 text-xs font-medium text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300">
          <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0" />
          <span>Trabajo</span>
          <button
            type="button"
            onClick={() => setIsWorkModeActive(false)}
            aria-label="Cerrar modo Trabajo"
            title="Cerrar modo Trabajo"
            className="ml-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors hover:bg-red-100 dark:hover:bg-red-900/50"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {isWebSearchActive && (
        <div
          className="group/web-search-tool flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-green-200 bg-green-100 px-0 text-xs text-green-700 transition-[width,padding,box-shadow] duration-300 ease-out hover:w-[120px] hover:justify-start hover:px-2 hover:shadow-sm focus-within:w-[120px] focus-within:justify-start focus-within:px-2 focus-within:shadow-sm dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
          aria-label="Búsqueda web activa. Pasa el cursor para cerrar."
        >
          <Globe className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
          <span className="ml-0 max-w-0 overflow-hidden whitespace-nowrap font-medium opacity-0 transition-all duration-250 ease-out group-hover/web-search-tool:ml-1.5 group-hover/web-search-tool:max-w-[86px] group-hover/web-search-tool:opacity-100 group-focus-within/web-search-tool:ml-1.5 group-focus-within/web-search-tool:max-w-[86px] group-focus-within/web-search-tool:opacity-100">
            Búsqueda web
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-0 h-4 w-0 shrink-0 overflow-hidden rounded-full p-0 opacity-0 transition-all duration-250 ease-out hover:bg-green-200 group-hover/web-search-tool:ml-1 group-hover/web-search-tool:w-4 group-hover/web-search-tool:opacity-100 group-focus-within/web-search-tool:ml-1 group-focus-within/web-search-tool:w-4 group-focus-within/web-search-tool:opacity-100 dark:hover:bg-green-800/30"
            onClick={handleWebSearchClose}
            aria-label="Cerrar búsqueda web"
            title="Cerrar búsqueda web"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {isImageGenerationActive && (
        <>
          <div
            data-testid="imagenes-mode-chip"
            className={mediaModeChipChrome("image").className}
          >
            <span className="image-liquid-chip__wave" />
            <span className="image-liquid-chip__gloss" />
            <span className="image-liquid-chip__pulse" />
            <span className="image-liquid-chip__spark" />
            <Palette className="image-liquid-chip__icon relative z-10 h-4 w-4" />
            <span className="relative z-10 text-[12px] sm:text-[14px]">Imágenes</span>
            {isGeneratingImage && <span className="image-liquid-chip__status relative z-10 h-1.5 w-1.5 rounded-full animate-pulse" />}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                MEDIA_MODE_CHIP_CLOSE_CLASS,
                isGeneratingImage
                  ? "opacity-45 cursor-not-allowed"
                  : ""
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
                className="group/ratio-trigger relative isolate h-7 sm:h-8 shrink-0 gap-1 sm:gap-1.5 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-2 sm:px-3 py-0 text-[12px] sm:text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Imagen: ${selectedImageAspectRatio}, ${selectedImageQuality}, ${selectedImageCount}`}
                aria-label={`Configurar imagen. Actual ${selectedImageAspectRatio}, ${selectedImageQuality}, ${selectedImageCount}`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/ratio-trigger:left-[92%] group-hover/ratio-trigger:opacity-100 dark:via-white/20" />
                <ImageAspectRatioMark ratio={selectedImageAspectRatio} selected className="h-4 w-4 text-zinc-700 dark:text-white/88" />
                <span className="hidden sm:inline">{selectedImageAspectRatio}</span>
                <span className="sm:hidden">{selectedImageAspectRatio.replace(':','×')}</span>
                <span className="hidden sm:inline">{selectedImageQuality}</span>
                <span>{selectedImageCount}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="image-settings-menu w-[min(calc(100vw-1.25rem),26rem)]"
            >
              <div>
                <section className="image-settings-section">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="image-settings-label">Aspect Ratio</h3>
                    <span className="image-settings-meta">{showAllImageRatios ? "7 formatos" : "Principales"}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-5 sm:gap-2" role="radiogroup" aria-label="Aspect ratio">
                  {visibleImageAspectRatioOptions.map(option => {
                    const selected = option.value === selectedImageAspectRatio;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          "image-ratio-option group/image-ratio-option",
                          selected && "is-selected"
                        )}
                        onClick={() => setSelectedImageAspectRatio(option.value)}
                        title={`${option.label} ${option.ratio}`}
                      >
                        <span className="relative z-10 text-[12px] font-semibold leading-none tabular-nums">{option.ratio}</span>
                        <span className="relative z-10 flex h-7 items-center justify-center">
                          <span
                            className={cn(
                              "image-ratio-swatch",
                              option.className,
                              selected && "is-selected"
                            )}
                          />
                        </span>
                        <span className="relative z-10 text-[10px] font-medium leading-none">{option.label}</span>
                      </button>
                    )
                  })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAllImageRatios(value => !value)}
                    className="image-settings-more"
                    aria-label="Ver todos los aspect ratios"
                    aria-expanded={showAllImageRatios}
                  >
                    {showAllImageRatios ? "View Less" : `View All (+${hiddenImageAspectRatioCount})`} <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAllImageRatios && "rotate-180")} />
                  </button>
                </section>

                <section className="image-settings-section">
                  <h3 className="image-settings-label">Quality</h3>
                  <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Image quality">
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
                            "image-setting-pill",
                            selected && "is-selected"
                          )}
                        >
                          {option}
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="image-settings-section">
                  <h3 className="image-settings-label">Number of Images</h3>
                  <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Number of images">
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
                            "image-setting-pill min-w-9",
                            selected && "is-selected"
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
          <div data-testid="voz-mode-chip" className={mediaModeChipChrome("voice").className}>
            <span className="media-mode-chip__wave pointer-events-none absolute -inset-8 -z-10 rounded-full opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/35 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/voice-liquid:translate-x-[155%] dark:via-white/20" />
            <AudioLines className="relative z-10 h-3.5 sm:h-4 w-3.5 sm:w-4" />
            <span className="relative z-10 text-[12px] sm:text-[14px]">Voz</span>
            {isGeneratingVoice && <span className="relative z-10 h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" />}
            <Button
              variant="ghost"
              size="sm"
              className={MEDIA_MODE_CHIP_CLOSE_CLASS}
              onClick={handleVoiceGenerationClose}
              disabled={isGeneratingVoice}
              title={isGeneratingVoice ? "La herramienta sigue activa durante la generación" : "Cerrar voz"}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {renderMediaModelPicker("voice", selectedVoiceModel, (name) => {
            setSelectedVoiceModel(name as VoiceModel);
            track("model.selected", { model: name, provider: name === "ElevenLabs" ? "ElevenLabs" : "Google", surface: "voice-tool-picker" });
          })}

          {/* Spinning "Voice" disc — opens the Voice Catalog (voice picker +
              configurations). Sits right after the provider selector per the
              requested order: provider → Voice → configurations. */}
          {selectedVoiceModel === "ElevenLabs" && <button
            type="button"
            onClick={() => onOpenVoiceCatalog()}
            title="Abrir catálogo de voces"
            aria-label="Abrir catálogo de voces"
            className="group/voice-disc relative isolate flex h-7 sm:h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-zinc-200/78 bg-white/86 px-2 sm:px-3 text-[11px] sm:text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
          >
            <Disc3 className="relative z-10 h-3.5 sm:h-4 w-3.5 sm:w-4 motion-safe:animate-spin" style={{ animationDuration: "3.5s" }} />
            <span className="relative z-10 max-w-[96px] truncate">{selectedVoiceName || "Voice"}</span>
          </button>}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group/voice-trigger relative isolate h-7 sm:h-8 shrink-0 gap-1 sm:gap-2 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-2 sm:px-3 py-0 text-[11px] sm:text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Voz: ${selectedVoiceModel}, ${selectedVoiceLanguage}, ${selectedVoiceAccent}, ${selectedVoiceStability}%`}
                aria-label={`Configurar voz. Actual ${selectedVoiceModel}, ${selectedVoiceLanguage}, estabilidad ${selectedVoiceStability} por ciento`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/voice-trigger:left-[92%] group-hover/voice-trigger:opacity-100 dark:via-white/20" />
                <Settings className="h-3.5 sm:h-4 w-3.5 sm:w-4" />
                <span>{selectedVoiceLanguage}</span>
                <span className="hidden sm:inline">{selectedVoiceStability}%</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="w-[min(calc(100vw-1rem),15.5rem)] overflow-hidden rounded-[14px] border border-zinc-200/70 bg-white/92 p-0 text-zinc-950 shadow-[0_16px_48px_-32px_rgba(15,23,42,0.55),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl dark:border-white/18 dark:bg-[#08090c]/96 dark:text-white dark:shadow-[0_22px_70px_-38px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.14)]"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_10%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_82%_36%,rgba(15,23,42,0.06),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.78),rgba(255,255,255,0.32)_45%,rgba(255,255,255,0.62))] dark:bg-[radial-gradient(circle_at_18%_8%,rgba(255,255,255,0.13),transparent_26%),radial-gradient(circle_at_82%_36%,rgba(255,255,255,0.08),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025)_45%,rgba(255,255,255,0.055))]" />
              <div className="relative z-10 py-1">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Modelo de voz</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedVoiceModel}>{selectedVoiceModel}</span>
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
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedVoiceLanguage}>{selectedVoiceLanguage}</span>
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
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedVoiceAccent}>{selectedVoiceAccent}</span>
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
                    className={VOICE_STABILITY_SLIDER_CLASS}
                  />
                </div>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-9 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Effect</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedVoiceEffect}>{selectedVoiceEffect}</span>
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
          <div data-testid="musica-mode-chip" className={mediaModeChipChrome("music").className}>
            <span className="media-mode-chip__wave pointer-events-none absolute -inset-8 -z-10 rounded-full opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/35 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/music-liquid:translate-x-[155%] dark:via-white/20" />
            <Music className="relative z-10 h-3.5 sm:h-4 w-3.5 sm:w-4" />
            <span className="relative z-10 text-[12px] sm:text-[14px]">Música</span>
            <Button
              variant="ghost"
              size="sm"
              className={MEDIA_MODE_CHIP_CLOSE_CLASS}
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
                className="group/music-trigger relative isolate h-7 sm:h-8 shrink-0 gap-1 sm:gap-2 overflow-hidden rounded-full border border-zinc-200/78 bg-white/84 px-2 sm:px-3 py-0 text-[11px] sm:text-[14px] font-semibold text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.84),0_10px_24px_-20px_rgba(15,23,42,0.42)] backdrop-blur-xl transition-all duration-200 hover:border-zinc-300 hover:bg-white dark:border-white/14 dark:bg-zinc-900/82 dark:text-white/90 dark:hover:bg-zinc-800/92"
                title={`Música: ${selectedMusicModel}, ${selectedMusicStyle}, ${selectedMusicMood}, ${selectedMusicDuration}s`}
                aria-label={`Configurar música. Actual ${selectedMusicModel}, ${selectedMusicStyle}, ${selectedMusicDuration} segundos`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/music-trigger:left-[92%] group-hover/music-trigger:opacity-100 dark:via-white/20" />
                <Settings className="h-3.5 sm:h-4 w-3.5 sm:w-4" />
                <span>{selectedMusicStyle}</span>
                <span>{selectedMusicDuration < 60 ? `${selectedMusicDuration}s` : `${Math.floor(selectedMusicDuration / 60)}:${String(selectedMusicDuration % 60).padStart(2, "0")}`}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="chat-active-apps-menu w-[min(calc(100vw-1rem),17rem)] overflow-hidden rounded-[14px] border border-zinc-200/70 bg-white/92 p-0 text-zinc-950 shadow-[0_16px_48px_-32px_rgba(15,23,42,0.55),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl dark:border-white/18 dark:bg-[#08090c]/96 dark:text-white dark:shadow-[0_22px_70px_-38px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.14)]"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_10%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_82%_36%,rgba(15,23,42,0.06),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.78),rgba(255,255,255,0.32)_45%,rgba(255,255,255,0.62))] dark:bg-[radial-gradient(circle_at_18%_8%,rgba(255,255,255,0.13),transparent_26%),radial-gradient(circle_at_82%_36%,rgba(255,255,255,0.08),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025)_45%,rgba(255,255,255,0.055))]" />
              <div className="relative z-10 p-1.5">
                <div className="px-2 pb-2 pt-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-white/58">Producción musical</p>
                      <p className="mt-1 text-[12px] leading-4 text-zinc-700 dark:text-white/78">Define el estilo, energia y acabado antes de generar.</p>
                    </div>
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-zinc-200/80 bg-zinc-50 text-zinc-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/20 dark:bg-white/10 dark:text-white">
                      <Music className="h-4 w-4" />
                    </span>
                  </div>
                </div>
                <DropdownMenuSeparator className="mx-1 mb-1 bg-zinc-950/8 dark:bg-white/12" />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-10 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Modelo de música</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedMusicModel}>{selectedMusicModel}</span>
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
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-12 cursor-pointer items-center justify-between gap-3 px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span className="min-w-0">
                      <span className="block leading-none">Estilo</span>
                      <span className="mt-1 block max-w-[150px] truncate text-[10.5px] font-medium leading-none text-zinc-500 dark:text-white/60">{MUSIC_STYLE_PROFILES[selectedMusicStyle].description}</span>
                    </span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-600 dark:text-white/72" title={MUSIC_STYLE_PROFILES[selectedMusicStyle].label}>{MUSIC_STYLE_PROFILES[selectedMusicStyle].label}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent sideOffset={10} alignOffset={-8} collisionPadding={12} className="liquid-menu-surface max-h-[min(25rem,calc(100vh-2rem))] w-[min(calc(100vw-1rem),19rem)] overflow-y-auto p-1.5">
                      <div className="relative z-10 px-2 pb-1.5 pt-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-white/58">Estilos de producción</p>
                        <p className="mt-1 text-[11.5px] leading-4 text-zinc-600 dark:text-white/68">Selecciona una dirección sonora clara para que el resultado suene intencional.</p>
                      </div>
                      {MUSIC_STYLE_OPTIONS.map(option => {
                        const selected = selectedMusicStyle === option;
                        const profile = MUSIC_STYLE_PROFILES[option];
                        return (
                          <DropdownMenuItem
                            key={option}
                            className={cn(
                              "relative z-10 flex min-h-[3.65rem] cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors",
                              selected
                                ? "bg-zinc-950/[0.055] text-zinc-950 ring-1 ring-zinc-950/10 dark:bg-white/10 dark:text-white dark:ring-white/12"
                                : "text-zinc-800 hover:bg-zinc-950/[0.04] focus:bg-zinc-950/[0.04] dark:text-white/86 dark:hover:bg-white/[0.08] dark:focus:bg-white/[0.08]"
                            )}
                            onClick={() => setSelectedMusicStyle(option)}
                          >
                            <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_0_4px_rgba(0,0,0,0.035)] dark:shadow-[0_0_0_4px_rgba(255,255,255,0.06)]", profile.accentClass)} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-2">
                                <span className="text-[12.5px] font-semibold leading-4">{profile.label}</span>
                                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-zinc-900 dark:text-white" />}
                              </span>
                              <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-white/62">{profile.description}</span>
                            </span>
                          </DropdownMenuItem>
                        )
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-10 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Mood</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedMusicMood}>{selectedMusicMood}</span>
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
                    <span className="text-[10.5px] font-medium text-zinc-500 dark:text-white/72">{selectedMusicDuration < 60 ? `${selectedMusicDuration}s` : `${Math.floor(selectedMusicDuration / 60)}:${String(selectedMusicDuration % 60).padStart(2, "0")}`}</span>
                  </div>
                  <Slider
                    value={[selectedMusicDuration]}
                    onValueChange={([value]) => setSelectedMusicDuration(value)}
                    min={5}
                    max={240}
                    step={5}
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
                  <DropdownMenuSubTrigger className="chat-active-apps-menu-item flex h-10 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-zinc-800 dark:text-white/90">
                    <span>Effect</span>
                    <span className="ml-auto mr-1 max-w-[92px] truncate text-[11px] text-zinc-500 dark:text-white/62" title={selectedMusicEffect}>{selectedMusicEffect}</span>
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

                <div className="mt-1 border-t border-zinc-950/8 px-2.5 py-2 text-[10.5px] font-medium leading-4 text-zinc-600 dark:border-white/12 dark:text-white/72">
                  {MUSIC_STYLE_PROFILES[selectedMusicStyle].label} / {selectedMusicMood} / {selectedMusicEffect} / {selectedMusicDuration < 60 ? `${selectedMusicDuration}s` : `${Math.floor(selectedMusicDuration / 60)}:${String(selectedMusicDuration % 60).padStart(2, "0")}`}
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {isVideoGenerationActive && (
        <>
          <div data-testid="video-mode-chip" className={mediaModeChipChrome("video").className}>
            <span className="video-mode-chip-flow media-mode-chip__wave pointer-events-none absolute -inset-8 -z-10 rounded-full opacity-70 blur-md motion-safe:animate-[spin_8s_linear_infinite]" />
            <span className="pointer-events-none absolute inset-y-[-45%] left-[-35%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/35 to-transparent opacity-70 blur-sm transition-transform duration-700 group-hover/video-liquid:translate-x-[155%] dark:via-white/20" />
            <Video className="relative z-10 h-3.5 sm:h-4 w-3.5 sm:w-4" />
            <span className="relative z-10 text-[12px] sm:text-[14px]">Video</span>
            <Button
              variant="ghost"
              size="sm"
              className={MEDIA_MODE_CHIP_CLOSE_CLASS}
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
                className="video-settings-trigger group/video-trigger relative isolate h-7 sm:h-8 shrink-0 gap-1 sm:gap-2 overflow-hidden rounded-full px-2 sm:px-3 py-0 text-[11px] sm:text-[14px] font-semibold backdrop-blur-xl transition-all duration-200"
                title={`Video: ${selectedVideoAspectRatio}, ${selectedVideoResolution}, ${selectedVideoDuration}s, audio ${selectedVideoAudio ? "on" : "off"}`}
                aria-label={`Configurar video. Actual ${selectedVideoAspectRatio}, ${selectedVideoResolution}, ${selectedVideoDuration} segundos`}
              >
                <span className="pointer-events-none absolute inset-y-[-55%] left-[-65%] -z-10 w-2/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 blur-sm transition-all duration-700 group-hover/video-trigger:left-[92%] group-hover/video-trigger:opacity-100 dark:via-white/20" />
                <Settings className="h-3.5 sm:h-4 w-3.5 sm:w-4" />
                <span className="hidden sm:inline">{selectedVideoAspectRatio}</span>
                <span>{selectedVideoResolution}</span>
                <span>{selectedVideoDuration}s</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={9}
              collisionPadding={12}
              className="video-settings-menu w-[min(calc(100vw-1rem),15.5rem)]"
            >
              <div className="relative z-10">
                <section className="video-settings-section">
                  <h3 className="video-settings-label">Resolución</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Resolución de video">
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
                            "video-setting-pill",
                            selected && "is-selected"
                          )}
                        >
                          {option}
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="video-settings-section">
                  <h3 className="video-settings-label">Formato</h3>
                  <div className="mt-2 grid grid-cols-5 gap-0.5" role="radiogroup" aria-label="Formato de video">
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
                            "video-ratio-option group/video-ratio-option",
                            selected && "is-selected"
                          )}
                          title={`${option.label} ${option.ratio}`}
                        >
                          <span className="relative z-10 text-[10px] font-medium leading-none tabular-nums">{option.ratio}</span>
                          <span className="relative z-10 flex h-4 items-center justify-center scale-[0.78]">
                            {option.value === "auto" ? (
                              <span className={cn("grid h-5 w-5 place-items-center rounded-[5px] border transition-all duration-200", selected ? "border-emerald-700 bg-emerald-50/70 dark:border-emerald-300 dark:bg-emerald-400/10" : "border-zinc-500/65 dark:border-white/68")}>
                                <Plus className="h-3.5 w-3.5" />
                              </span>
                            ) : (
                              <span className={cn("rounded-[4px] border transition-all duration-200", option.className, selected ? "border-emerald-700 bg-emerald-50/70 dark:border-emerald-300 dark:bg-emerald-400/10" : "border-zinc-500/65 bg-white/20 dark:border-white/68 dark:bg-transparent")} />
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAllVideoRatios(value => !value)}
                    className="video-settings-more"
                    aria-expanded={showAllVideoRatios}
                  >
                    {showAllVideoRatios ? "Menos" : "Más"} <ChevronDown className={cn("h-3 w-3 transition-transform", showAllVideoRatios && "rotate-180")} />
                  </button>
                </section>

                <section className="video-settings-section">
                  {(() => {
                    const durationSpec = resolveVideoDurationSpec(selectedVideoModel, (availableModels || []).find((model: any) => model?.name === selectedVideoModel)?.apiData?.fal)
                    const maxLabel = durationSpec.max != null ? `${durationSpec.max}s` : ""
                    if (durationSpec.audioDriven) {
                      return (
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="video-settings-label">Duración</h3>
                          <span className="text-[11px] text-zinc-500 dark:text-white/70">Según audio</span>
                        </div>
                      )
                    }
                    if (!durationSpec.supportsDuration) {
                      return (
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="video-settings-label">Duración</h3>
                          <span className="text-[11px] text-zinc-500 dark:text-white/70">Auto</span>
                        </div>
                      )
                    }
                    const step = durationSpec.step || 1
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="video-settings-label">Duración</h3>
                          <span className="text-[11px] tabular-nums text-zinc-500 dark:text-white/70">{selectedVideoDuration}s · {maxLabel} máx.</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            aria-label="Reducir duración"
                            className="video-setting-pill min-w-7 px-0"
                            onClick={() => {
                              const next = stepVideoDuration(selectedVideoDuration, -1, durationSpec, undefined, selectedVideoResolution)
                              if (next != null) setSelectedVideoDuration(next)
                            }}
                          >−</button>
                          <input
                            type="range"
                            min={durationSpec.min ?? 4}
                            max={durationSpec.max ?? 8}
                            step={step}
                            value={selectedVideoDuration}
                            aria-label="Duración de video"
                            className="h-1 w-full cursor-pointer accent-zinc-900 dark:accent-white"
                            onChange={(event) => {
                              const next = clampVideoDuration(event.target.value, durationSpec, undefined, selectedVideoResolution)
                              if (next != null) setSelectedVideoDuration(next)
                            }}
                          />
                          <button
                            type="button"
                            aria-label="Aumentar duración"
                            className="video-setting-pill min-w-7 px-0"
                            onClick={() => {
                              const next = stepVideoDuration(selectedVideoDuration, 1, durationSpec, undefined, selectedVideoResolution)
                              if (next != null) setSelectedVideoDuration(next)
                            }}
                          >+</button>
                        </div>
                      </>
                    )
                  })()}
                </section>

                <section className="video-settings-section">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <h3 className="video-settings-label">Audio</h3>
                      <Info className="h-3 w-3 text-zinc-500 dark:text-white/72" />
                    </div>
                    <Switch checked={selectedVideoAudio} onCheckedChange={setSelectedVideoAudio} aria-label="Audio" />
                  </div>
                </section>

                <div className="video-settings-summary">
                  {selectedVideoAspectRatio === "auto" ? "Auto" : selectedVideoAspectRatio} / {selectedVideoResolution} / {resolveVideoDurationSpec(selectedVideoModel).audioDriven ? "Según audio" : `${selectedVideoDuration}s`} / Audio {selectedVideoAudio ? "On" : "Off"}
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {chatType === 'thesis' && (
        <div className="flex items-center gap-1.5 bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 px-2 py-1 rounded-full text-xs border border-purple-200 dark:border-purple-800">
          <span className="text-xs leading-none" aria-hidden="true">🎓</span>
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
const MODEL_BRAND_BY_ICON: Record<string, string> = {
  ChatGPTLogo: "openai",
  ClaudeLogo: "anthropic",
  GeminiLogo: "google",
  DeepseekLogo: "deepseek",
  GrokLogo: "xai",
  KimiLogo: "moonshot",
  ZaiLogo: "zai",
  QwenLogo: "qwen",
  MetaLogo: "meta",
  MistralLogo: "mistral",
  NvidiaLogo: "nvidia",
  PoolsideLogo: "poolside",
  OllamaLogo: "ollama",
  SeedreamLogo: "bytedance",
  FalLogo: "fal",
  SoraLogo: "openai",
  KlingLogo: "kling",
  ByteDanceLogo: "bytedance",
  PixverseLogo: "pixverse",
  MinimaxLogo: "minimax",
  WanLogo: "wan",
  LtxLogo: "ltx",
  OpenRouterLogo: "openrouter",
  MessageSquare: "groq",
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const getModelBrandKey = (model: any) => MODEL_BRAND_BY_ICON[resolveModelIconName(model)] || "other"

const getModelDisplayLabel = (model: any) => {
  return brandModelLabel(model)
}

const getNavbarModelSelectorChatSignature = (chat: any) => [
  chat?.id,
  chat?.model,
  chat?.title,
  chat?.customGptId,
  chat?.customGpt?.id,
  chat?.customGpt?.creatorId,
  chat?.customGpt?.creator?.id,
  chat?.customGpt?.name,
  chat?.customGpt?.iconUrl,
  chat?.customGpt?.modelName,
  chat?.customGpt?.shareId,
  chat?.projectId,
  chat?.project?.id,
  chat?.project?.name,
  chat?.project?._count?.files,
  chat?.project?._count?.chats,
  chat?.project?._count?.memories,
  chat?.project?._count?.documents,
].map((part) => String(part ?? "")).join("\u0001")

// Reasoning-effort picker rendered at the bottom of the model dropdown.
// The four stops mirror the backend contract exactly: reasoning-orchestrator's
// EFFORT_ALIASES maps Bajo→low (direct pass), Medio→medium (extended),
// Extra→high (extended+reflection) and Max→max (self-consistency ×3), so the
// slider never offers a level the compute planner would ignore.
const EFFORT_LEVELS = [
  { value: "Bajo", caption: "Rápido y directo. Menos profundidad." },
  { value: "Medio", caption: "Equilibrado. Ideal para el día a día." },
  { value: "Extra", caption: "Más profundidad y reflexión. Más lento." },
  { value: "Max", caption: "Máxima profundidad. Mayor costo y latencia." },
] as const

function EffortSection({ selectedEffort, setSelectedEffort }: {
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
}) {
  const activeIndex = Math.max(0, EFFORT_LEVELS.findIndex((l) => l.value === selectedEffort))
  const active = EFFORT_LEVELS[activeIndex]
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const draggingRef = React.useRef(false)
  const moveTo = (index: number) => {
    const clamped = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index))
    if (clamped !== activeIndex) setSelectedEffort(EFFORT_LEVELS[clamped].value)
  }
  // Real dragging, not just stop-clicks: any x on the track maps to the
  // nearest stop, and pointer capture keeps the drag alive even when the
  // finger/cursor leaves the dropdown. Pointer events cover mouse + touch.
  const indexFromPointer = (clientX: number) => {
    const track = trackRef.current
    if (!track) return activeIndex
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return activeIndex
    const fraction = (clientX - rect.left) / rect.width
    return Math.round(Math.min(1, Math.max(0, fraction)) * (EFFORT_LEVELS.length - 1))
  }
  return (
    <div className="effort-section" onClick={(e) => e.stopPropagation()}>
      <div className="effort-header">
        <span className="effort-title">Effort</span>
        <span className="effort-value">{active.value}</span>
      </div>
      <div
        ref={trackRef}
        className="effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Nivel de esfuerzo de razonamiento"
        aria-valuemin={0}
        aria-valuemax={EFFORT_LEVELS.length - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={active.value}
        onPointerDown={(e) => {
          // Primary button / touch only; capture so the drag survives leaving
          // the track and the dropdown never sees these events as item picks.
          if (e.button !== 0 && e.pointerType === "mouse") return
          draggingRef.current = true
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older browsers */ }
          moveTo(indexFromPointer(e.clientX))
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return
          moveTo(indexFromPointer(e.clientX))
        }}
        onPointerUp={(e) => {
          draggingRef.current = false
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
        }}
        onPointerCancel={() => { draggingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); moveTo(activeIndex + 1) }
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); moveTo(activeIndex - 1) }
          else if (e.key === "Home") { e.preventDefault(); moveTo(0) }
          else if (e.key === "End") { e.preventDefault(); moveTo(EFFORT_LEVELS.length - 1) }
        }}
      >
        <div className="effort-track-line" aria-hidden />
        <div
          className="effort-track-fill"
          aria-hidden
          /* Width is the fraction of the span between first and last stop
             centers (100% - stop size). That keeps the fill end exact on the
             active dot instead of overshooting a full-track percentage. */
          style={{
            width:
              activeIndex <= 0
                ? "0px"
                : `calc((100% - var(--effort-stop-size, 1.75rem)) * ${activeIndex / (EFFORT_LEVELS.length - 1)})`,
          }}
        />
        {EFFORT_LEVELS.map((level, index) => (
          <button
            key={level.value}
            type="button"
            tabIndex={-1}
            aria-hidden
            title={level.value}
            className={cn(
              "effort-stop",
              index <= activeIndex && "effort-stop-reached",
              index === activeIndex && "effort-stop-active",
            )}
            onClick={() => moveTo(index)}
          />
        ))}
      </div>
      <p className="effort-caption">{active.caption}</p>
    </div>
  )
}

function areNavbarModelSelectorPropsEqual(prev: any, next: any) {
  return (
    prev.selectedModel === next.selectedModel &&
    prev.availableModels === next.availableModels &&
    prev.chatTypes === next.chatTypes &&
    prev.setSelectedModel === next.setSelectedModel &&
    prev.setSelectedProvider === next.setSelectedProvider &&
    prev.setCurrentChat === next.setCurrentChat &&
    // Without these two the memo would freeze the slider: clicking a stop
    // updates context state but the dropdown would keep rendering the old one.
    prev.selectedEffort === next.selectedEffort &&
    prev.setSelectedEffort === next.setSelectedEffort &&
    getNavbarModelSelectorChatSignature(prev.currentChat) === getNavbarModelSelectorChatSignature(next.currentChat)
  )
}

const NavbarModelSelector = React.memo(function NavbarModelSelector({
  selectedModel,
  setSelectedModel,
  availableModels,
  setSelectedProvider,
  chatTypes,
  currentChat,
  setCurrentChat,
  selectedEffort,
  setSelectedEffort,
}: any) {
  const { user } = useAuth()
  const liveSelectedModelData = availableModels.find((m: any) => m.name === selectedModel);
  // Anti-flicker: hold the last model that actually matched `selectedModel`.
  // refreshModels (dropdown-open / window-focus / tab-visibility) replaces the
  // list with a new array; if it transiently omits the selected model, find()
  // returns undefined for one render and the brand logo would flash to the
  // generic Bot fallback. Holding the last-known-good entry keeps the chip
  // stable until a real match (or an explicit selection change) replaces it.
  const lastGoodSelectedModelRef = React.useRef<any>(liveSelectedModelData);
  if (liveSelectedModelData) {
    lastGoodSelectedModelRef.current = liveSelectedModelData;
  } else if (
    lastGoodSelectedModelRef.current &&
    lastGoodSelectedModelRef.current.name !== selectedModel
  ) {
    // User picked a genuinely different model not yet in the list: drop the
    // stale entry so we never show a logo for the wrong model.
    lastGoodSelectedModelRef.current = undefined;
  }
  const selectedModelData = liveSelectedModelData || lastGoodSelectedModelRef.current;
  const [searchQuery, setSearchQuery] = React.useState("");
  const [pinnedModel, setPinnedModelState] = React.useState("")
  const [rowMenu, setRowMenu] = React.useState<string | null>(null)
  React.useEffect(() => {
    setPinnedModelState(getPinnedModel())
  }, [])
  // Re-fetch the model list when the picker opens so a model an admin just
  // activated shows up without a page reload (live admin → frontend sync).
  // Use the fine-grained models/files context (NOT useChat) — useChat also
  // subscribes to the streaming/current-chat contexts, which change once per
  // frame while a response streams, defeating this component's React.memo and
  // re-rendering the model-logo chip ~60×/s (the visible logo flicker).
  const { refreshModels } = useModelsAndFiles();

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
      toast.success(`Modelo actualizado: ${brandModelLabel(nextModel)}`);
    } catch (error) {
      toast.error("No se pudo actualizar el modelo del GPT");
    }
  }, [currentChat?.id, pickModelForTier, setCurrentChat, setSelectedModel, setSelectedProvider]);

  const startNewGptChat = React.useCallback(async () => {
    const gptId = currentChat?.customGpt?.id || currentChat?.customGptId;
    if (!gptId) return;
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null;
      const request = await apiClient.prepareMutatingFetch({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const response = await authenticatedFetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/gpts/${gptId}/chat`, request);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.chat?.id) throw new Error(data?.error || "No se pudo crear el chat");
      localStorage.setItem("currentChatId", data.chat.id);
      window.location.href = agentsHomeHref(`id=${data.chat.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo crear el chat");
    }
  }, [currentChat?.customGpt?.id, currentChat?.customGptId]);

  const copyGptLink = React.useCallback(async () => {
    const gpt = currentChat?.customGpt;
    const href = gpt?.shareId
      ? `${window.location.origin}/gpts/share/${gpt.shareId}`
      : `${window.location.origin}${agentsHomeHref(currentChat?.id ? `id=${currentChat.id}` : "")}`;
    const r = await copyTextSafe(href);
    if (r.ok) toast.success("Enlace copiado");
    else toast.error("No se pudo copiar el enlace. Cópialo manualmente.");
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
    const groups: Record<string, any[]> = {};
    for (const model of gptAvailableModels) {
      const provider = resolveModelProviderName(model);
      (groups[provider] ||= []).push(model);
    }
    return Object.entries(groups).sort(([a], [b]) => compareModelProviders(a, b));
  }, [gptAvailableModels]);

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
      toast.success(`Modelo actualizado: ${brandModelLabel(model)}`);
    } catch {
      toast.error("No se pudo actualizar el modelo del GPT");
    }
  }, [currentChat?.id, setCurrentChat, setSelectedModel, setSelectedProvider]);

  const [gptDialog, setGptDialog] = React.useState<null | "about" | "feedback" | "rate" | "report">(null);
  const [projectDialog, setProjectDialog] = React.useState<null | "about">(null);
  const [gptFeedback, setGptFeedback] = React.useState("");
  const [gptReport, setGptReport] = React.useState("");
  const [gptRating, setGptRating] = React.useState(0);
  const [hoveredGptRating, setHoveredGptRating] = React.useState(0);
  const [gptRatingNote, setGptRatingNote] = React.useState("");
  const gptRatingButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [isGptPinned, setIsGptPinned] = React.useState(false);

  const displayGptRating = hoveredGptRating || gptRating;
  const displayGptRatingLabel = getGptRatingLabel(displayGptRating);

  const handleGptRatingKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>, value: number) => {
    let nextRating = value;

    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextRating = Math.min(GPT_RATING_OPTIONS.length, value + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextRating = Math.max(1, value - 1);
    } else if (event.key === "Home") {
      nextRating = 1;
    } else if (event.key === "End") {
      nextRating = GPT_RATING_OPTIONS.length;
    } else {
      return;
    }

    event.preventDefault();
    setGptRating(nextRating);
    setHoveredGptRating(nextRating);
    gptRatingButtonRefs.current[nextRating - 1]?.focus();
  }, []);

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
      text: kind === "report" ? gptReport.trim() : kind === "rate" ? gptRatingNote.trim() : gptFeedback.trim(),
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
      if (kind === "rate") {
        setGptRating(0);
        setHoveredGptRating(0);
        setGptRatingNote("");
      }
    } catch {
      toast.error("No se pudo guardar la acción");
    }
  }, [currentChat?.customGpt?.id, currentChat?.customGptId, currentChat?.id, gptFeedback, gptRating, gptRatingNote, gptReport]);

  const project = currentChat?.project;
  const projectName = project?.name || String(currentChat?.title || "Empresa").replace(/^Chat in\s+/i, "");
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
      toast.success(`Modelo de la empresa actualizado: ${brandModelLabel(model)}`);
    } catch {
      toast.error("No se pudo actualizar el modelo de la empresa");
    }
  }, [currentChat?.id, setCurrentChat, setSelectedModel, setSelectedProvider]);

  const startNewProjectChat = React.useCallback(async () => {
    const projectId = currentChat?.project?.id || currentChat?.projectId;
    if (!projectId) return;
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null;
      const request = await apiClient.prepareMutatingFetch({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          title: `Chat in ${projectName}`.slice(0, 120),
          model: activeProjectModelName,
        }),
      });
      const response = await authenticatedFetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/projects/${projectId}/chat`, request);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.chat?.id) throw new Error(data?.error || "No se pudo crear el chat de la empresa");
      localStorage.setItem("currentChatId", data.chat.id);
      window.location.href = agentsHomeHref(`id=${data.chat.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo crear el chat de la empresa");
    }
  }, [currentChat?.project?.id, currentChat?.projectId, projectName, activeProjectModelName]);

  const copyProjectLink = React.useCallback(async () => {
    const projectId = currentChat?.project?.id || currentChat?.projectId;
    if (!projectId) return;
    const r = await copyTextSafe(`${window.location.origin}/projects/${projectId}`);
    if (r.ok) toast.success("Enlace de la empresa copiado");
    else toast.error("No se pudo copiar el enlace de la empresa. Cópialo manualmente.");
  }, [currentChat?.project?.id, currentChat?.projectId]);

  const ModelLogo = ({ model, compact = false }: { model: any; compact?: boolean }) => (
    <span
      className={cn("model-logo-chip chat-model-icon", compact && "model-logo-chip--sm")}
      data-model-brand={getModelBrandKey(model)}
    >
      <IconProvider name={resolveModelIconName(model)} size={compact ? 14 : 20} />
    </span>
  );

  const ProviderHeading = ({ provider, models }: { provider: string; models: any[] }) => {
    const sample = models[0] ? { ...models[0], provider } : { provider };
    return (
      <div className="model-provider-heading">
        <ModelLogo model={sample} compact />
        <span className="min-w-0 flex-1 truncate">{brandProviderLabel(provider)}</span>
        <span className="model-provider-count">{models.length}</span>
      </div>
    );
  };


  // If this is a video chat type, show video model
  if (chatTypes === "video") {
    const videoModels = filterAdminVisibleVideoModels(
      Array.isArray(availableModels) ? availableModels : [],
    );
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
          <span className="chat-model-label text-sm font-medium truncate">{selectedVideoModelData ? brandModelLabel(selectedVideoModelData) : 'Select Video Model'}</span>
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
                      <span className="text-sm">{brandModelLabel(model)}</span>
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
    const activeModelLabel = brandModelLabel(selectedProjectModel || activeProjectModelName || "Modelo");

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
                <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="gpt-model-submenu model-picker-content w-[min(calc(100vw-1.25rem),20rem)] max-h-[min(70dvh,28rem)] overflow-hidden rounded-2xl p-1.5">
                  <div className="gpt-model-submenu-title relative z-10 px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-muted-foreground">
                    Modelos disponibles para esta empresa
                  </div>
                  <ScrollArea className="gpt-model-submenu-scroll relative z-10 h-[min(58dvh,22rem)] pr-1">
                    {gptModelsByProvider.length > 0 ? (
                      <div className="space-y-2">
                        {gptModelsByProvider.map(([provider, models]) => (
                          <div key={provider}>
                            <ProviderHeading provider={provider} models={models} />
                            <div className="space-y-0.5">
                              {models.map((model: any) => {
                                const isActive = model.name === activeProjectModelName;
                                const isComingSoon = Boolean(model.comingSoon);
                                const label = getModelDisplayLabel(model);
                                const attribution = brandProviderLabel(resolveModelAttributionName(model));
                                return (
                                  <DropdownMenuItem
                                    key={model.name}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      if (!isComingSoon) applyProjectModel(model);
                                    }}
                                    disabled={isComingSoon}
                                    data-selected={isActive ? "true" : undefined}
                                    className={cn("model-picker-row min-h-12 rounded-xl px-2.5 py-2", isComingSoon && "cursor-default opacity-55")}
                                  >
                                    <ModelLogo model={model} />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <div className="liquid-label truncate text-[13.5px] font-semibold leading-5 text-neutral-900 dark:text-foreground">{label}</div>
                                        {isComingSoon && (
                                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pronto</span>
                                        )}
                                      </div>
                                      <div className="truncate text-[12px] font-medium leading-4 text-neutral-500 dark:text-muted-foreground">{attribution}</div>
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
              Nuevo chat en empresa
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
              Abrir empresa
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
                Este chat usa instrucciones, archivos, documentos y memoria aislados de la empresa.
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
                  Abrir empresa
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
    const customGptCreatorId = customGpt?.creatorId || customGpt?.creator?.id;
    const isCustomGptOwner = Boolean(user?.id && customGptCreatorId && customGptCreatorId === user.id);
    const customGptIconSrc = resolveGptIconImageUrl(customGptIcon, {
      token: typeof window !== "undefined" ? window.localStorage.getItem("auth-token") : null,
      baseUrl: process.env.NEXT_PUBLIC_IMAGE_URL || process.env.NEXT_PUBLIC_API_URL,
    });
    const customGptTextIcon = String(customGptIcon || "").trim();
    const activeModelLabel = brandModelLabel(selectedGptModel || currentChat?.model || customGpt?.modelName || selectedModel || "Modelo");
    const activeModelName = currentChat?.model || customGpt?.modelName || selectedModel;
    const gptMenuItemClass = "h-11 rounded-xl px-2.5 text-[13px] font-medium";
    const gptMenuIconClass = "mr-2.5 h-4 w-4 shrink-0 text-muted-foreground";

    const GptIcon = () => customGptIconSrc ? (
      <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-background ring-1 ring-border/60 shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={customGptIconSrc}
          alt={`${customGptName} icon`}
          className="h-full w-full object-cover"
        />
      </span>
    ) : customGptTextIcon && !/^https?:|data:|blob:/i.test(customGptTextIcon) && !customGptTextIcon.startsWith("/") ? (
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-fuchsia-500 to-indigo-600 text-sm text-white shadow-sm ring-1 ring-white/30">
        {customGptTextIcon}
      </span>
    ) : (
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-purple-100 text-purple-700 shadow-sm ring-1 ring-purple-200/70 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-purple-400/20">
        <Bot className="h-4 w-4" />
      </span>
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

          <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} className="gpt-context-menu w-[min(calc(100vw-1rem),18.25rem)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-neutral-200 bg-white p-1.5 text-neutral-900 shadow-xl dark:border-border/70 dark:bg-background/95 dark:text-foreground dark:backdrop-blur">
            <div className="mb-1 flex items-center gap-2.5 rounded-xl px-2.5 py-2">
              <GptIcon />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold leading-5">{customGptName}</div>
                <div className="truncate text-[11px] font-medium leading-4 text-muted-foreground">{activeModelLabel}</div>
              </div>
            </div>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={cn(gptMenuItemClass, "justify-between")}>
                <div className="flex min-w-0 items-center">
                  <Settings className={gptMenuIconClass} />
                  <span>Modelo</span>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent sideOffset={8} collisionPadding={12} className="gpt-model-submenu model-picker-content w-[min(calc(100vw-1.25rem),20rem)] max-h-[min(70dvh,28rem)] overflow-hidden rounded-2xl p-1.5">
                  <div className="gpt-model-submenu-title relative z-10 px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-muted-foreground">
                    Todos los modelos disponibles
                  </div>
                  <ScrollArea className="gpt-model-submenu-scroll relative z-10 h-[min(58dvh,22rem)] pr-1">
                    {gptModelsByProvider.length > 0 ? (
                      <div className="space-y-2">
                        {gptModelsByProvider.map(([provider, models]) => (
                          <div key={provider}>
                            <ProviderHeading provider={provider} models={models} />
                            <div className="space-y-0.5">
                              {models.map((model: any) => {
                                const isActive = model.name === activeModelName;
                                const isComingSoon = Boolean(model.comingSoon);
                                const label = getModelDisplayLabel(model);
                                const attribution = brandProviderLabel(resolveModelAttributionName(model));
                                return (
                                  <DropdownMenuItem
                                    key={model.name}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      if (!isComingSoon) applyGptModel(model);
                                    }}
                                    disabled={isComingSoon}
                                    data-selected={isActive ? "true" : undefined}
                                    className={cn("model-picker-row min-h-12 rounded-xl px-2.5 py-2", isComingSoon && "cursor-default opacity-55")}
                                  >
                                    <ModelLogo model={model} />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <div className="liquid-label truncate text-[13.5px] font-semibold leading-5 text-neutral-900 dark:text-foreground">{label}</div>
                                        {isComingSoon && (
                                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pronto</span>
                                        )}
                                      </div>
                                      <div className="truncate text-[12px] font-medium leading-4 text-neutral-500 dark:text-muted-foreground">{attribution}</div>
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
                  {isCustomGptOwner && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          if (customGpt?.id) window.location.href = `/gpts/create?edit=${customGpt.id}`;
                        }}
                        className="rounded-2xl px-3 py-3 text-[15px]"
                      >
                        Configurar GPT...
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>

            <DropdownMenuSeparator className="my-1" />

            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); startNewGptChat(); }} className={gptMenuItemClass}>
              <PenSquare className={gptMenuIconClass} />
              Nuevo chat
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("about"); }} className={gptMenuItemClass}>
              <Info className={gptMenuIconClass} />
              Acerca de
            </DropdownMenuItem>
            {isCustomGptOwner && (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  if (customGpt?.id) window.location.href = `/gpts/create?edit=${customGpt.id}`;
                }}
                className={gptMenuItemClass}
              >
                <Lock className={gptMenuIconClass} />
                Configuración de privacidad
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); togglePinGpt(); }} className={gptMenuItemClass}>
              <Pin className={gptMenuIconClass} />
              {isGptPinned ? "Quitar de barra" : "Fijar en barra"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); copyGptLink(); }} className={gptMenuItemClass}>
              <Link2 className={gptMenuIconClass} />
              Copiar enlace
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("feedback"); }} className={gptMenuItemClass}>
              <MessageCircle className={gptMenuIconClass} />
              Comentarios
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("rate"); }} className={gptMenuItemClass}>
              <MessageSquare className={gptMenuIconClass} />
              Valorar
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-1" />
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setGptDialog("report"); }} className={cn(gptMenuItemClass, "text-destructive focus:text-destructive")}>
              <Flag className="mr-2.5 h-4 w-4 shrink-0" />
              Denunciar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog
          open={gptDialog !== null}
          onOpenChange={(open) => {
            if (!open) {
              setGptDialog(null);
              setHoveredGptRating(0);
            }
          }}
        >
          <DialogContent
            overlayClassName={gptDialog === "rate" ? "bg-black/60 backdrop-blur-sm" : undefined}
            className={cn(
              gptDialog === "rate"
                ? "max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[460px] gap-0 overflow-hidden rounded-[20px] border border-border/70 bg-background/95 p-0 shadow-[0_24px_80px_rgba(15,23,42,0.28)] backdrop-blur-xl sm:rounded-[20px]"
                : "max-w-md rounded-3xl",
            )}
            onOpenAutoFocus={(event) => {
              if (gptDialog !== "rate") return;
              event.preventDefault();
              window.setTimeout(() => {
                gptRatingButtonRefs.current[(gptRating || 1) - 1]?.focus();
              }, 0);
            }}
            onEscapeKeyDown={() => setHoveredGptRating(0)}
          >
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
                  {isCustomGptOwner && customGpt?.id && <Button onClick={() => { window.location.href = `/gpts/create?edit=${customGpt.id}` }}>Configurar</Button>}
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
                <div className="px-5 pb-5 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
                  <DialogHeader className="space-y-2 pr-8 text-left">
                    <DialogTitle className="text-[1.35rem] font-semibold leading-7 tracking-normal sm:text-2xl">
                      ¿Qué te pareció este GPT?
                    </DialogTitle>
                    <DialogDescription className="text-sm leading-6 text-muted-foreground">
                      Tu valoración ayuda a mejorar la experiencia.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="mt-7 space-y-5">
                    <div className="space-y-3">
                      <div
                        role="radiogroup"
                        aria-label="Valoración del GPT"
                        className="flex items-center justify-center gap-2.5 sm:gap-3"
                        onMouseLeave={() => setHoveredGptRating(0)}
                      >
                        {GPT_RATING_OPTIONS.map((option) => {
                          const { value, label } = option;
                          const isPreviewed = displayGptRating >= value;
                          const isSelected = gptRating >= value;

                          return (
                            <button
                              key={value}
                              ref={(node) => {
                                gptRatingButtonRefs.current[value - 1] = node;
                              }}
                              type="button"
                              role="radio"
                              aria-checked={gptRating === value}
                              aria-label={`Valorar con ${value} ${value === 1 ? "estrella" : "estrellas"}: ${label}`}
                              tabIndex={gptRating === 0 ? (value === 1 ? 0 : -1) : (gptRating === value ? 0 : -1)}
                              onClick={() => setGptRating(value)}
                              onFocus={() => setHoveredGptRating(value)}
                              onBlur={() => setHoveredGptRating(0)}
                              onMouseEnter={() => setHoveredGptRating(value)}
                              onKeyDown={(event) => handleGptRatingKeyDown(event, value)}
                              className={cn(
                                "group flex h-12 w-12 items-center justify-center rounded-full border shadow-sm transition-all duration-200 sm:h-14 sm:w-14",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                                "hover:-translate-y-0.5 hover:scale-105 active:translate-y-0 active:scale-100",
                                isPreviewed
                                  ? "border-amber-300 bg-amber-50 text-amber-500 shadow-[0_10px_24px_rgba(245,158,11,0.18)] dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300"
                                  : "border-zinc-200 bg-white text-zinc-400 hover:border-amber-200 hover:bg-amber-50/70 hover:text-amber-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-500 dark:hover:border-amber-400/35 dark:hover:bg-amber-400/10 dark:hover:text-amber-300",
                                isSelected && "ring-1 ring-amber-300/60 dark:ring-amber-400/35",
                              )}
                            >
                              <Star
                                aria-hidden="true"
                                className={cn(
                                  "h-6 w-6 transition-all duration-200 sm:h-7 sm:w-7",
                                  isPreviewed && "fill-current drop-shadow-[0_2px_6px_rgba(245,158,11,0.25)]",
                                )}
                              />
                            </button>
                          );
                        })}
                      </div>

                      <div className="min-h-7 text-center" aria-live="polite">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-3 py-1 text-sm font-medium transition-colors",
                            displayGptRatingLabel
                              ? "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200"
                              : "text-muted-foreground",
                          )}
                        >
                          {displayGptRatingLabel || "Sin valoración aún"}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="gpt-rating-note" className="text-sm font-medium text-foreground">
                        Comentario opcional
                      </label>
                      <Textarea
                        id="gpt-rating-note"
                        value={gptRatingNote}
                        onChange={(event) => setGptRatingNote(event.target.value)}
                        placeholder="Cuéntanos qué podríamos mejorar…"
                        aria-label="Comentario opcional para la valoración"
                        rows={4}
                        className="min-h-[104px] resize-none rounded-2xl border-border/70 bg-muted/30 px-4 py-3 text-sm leading-6 shadow-inner shadow-black/[0.02] transition focus-visible:ring-2 focus-visible:ring-zinc-400/50 focus-visible:ring-offset-0 dark:bg-white/[0.03]"
                      />
                    </div>
                  </div>
                </div>

                <DialogFooter className="gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end sm:space-x-0 sm:px-7 [&>button]:w-full sm:[&>button]:w-auto">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setGptDialog(null);
                      setHoveredGptRating(0);
                    }}
                    className="h-11 rounded-xl border-border/70 bg-background px-5 text-foreground hover:bg-muted/70"
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={() => submitGptFeedback("rate")}
                    disabled={gptRating === 0}
                    className="h-11 rounded-xl bg-zinc-950 px-5 text-white shadow-sm hover:bg-zinc-800 disabled:bg-zinc-200 disabled:text-zinc-500 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-white/10 dark:disabled:text-white/35"
                  >
                    Guardar valoración
                  </Button>
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

  // Filter models based on search query
  const filteredModels = availableModels.filter((model: any) =>
    model.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.provider?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    resolveModelProviderName(model).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const onPick = (model: any) => {
    setSelectedModel(model.name);
    setSelectedProvider(model.provider);
    recordRecent(model.name);
    setLastModel(model.name);
    setSearchQuery("");
    setRowMenu(null);
    if (currentChat?.id) {
      setCurrentChat?.((chat: any) => chat ? { ...chat, model: model.name } : chat);
      void apiClient.updateChat(currentChat.id, { model: model.name }).catch(() => {});
    }
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

  const pinModel = (model: any) => {
    setPinnedModel(model.name);
    setPinnedModelState(model.name);
    onPick(model);
  };

  const unpinModel = (modelName: string) => {
    if (!isPinnedModel(modelName, pinnedModel)) return;
    clearPinnedModel();
    setPinnedModelState("");
    setRowMenu(null);
  };

  // ModelRow — single picker entry. Active state = subtle bg + Check on
  // the right; rows stay one-line and restrained for fast scanning.
  const ModelRow = ({ model }: { model: any }) => {
    const isSelected = model.name === selectedModel;
    const isComingSoon = Boolean(model.comingSoon);
    const isPinned = isPinnedModel(model.name, pinnedModel);
    const menuOpen = rowMenu === model.name;
    const label = getModelDisplayLabel(model);
    return (
      <DropdownMenuItem
        aria-label={label}
        title={label}
        onSelect={(event) => {
          const target = event.target as HTMLElement | null
          if (isComingSoon || target?.closest?.(".model-picker-row-more, .model-picker-row-menu")) {
            event.preventDefault()
            return
          }
          onPick(model)
        }}
        data-selected={isSelected ? "true" : undefined}
        disabled={isComingSoon}
        className={cn(
          "model-picker-row group/row relative flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1",
          "text-foreground/90 focus:bg-transparent data-[highlighted]:bg-transparent",
          isComingSoon && "cursor-default opacity-55",
        )}
      >
        <ModelLogo model={model} compact />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="liquid-label block truncate text-[12.5px] font-medium leading-4">
              {label}
            </span>
            {isPinned && (
              <span className="model-picker-pin shrink-0 text-[9px] leading-none text-muted-foreground/80" aria-hidden>
                •
              </span>
            )}
            {isComingSoon && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Pronto
              </span>
            )}
          </span>
        </span>
        <button
          type="button"
          aria-label="Más opciones"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="model-picker-row-more -mr-0.5 shrink-0 rounded px-1 py-0.5 text-[11px] font-medium leading-none tracking-widest text-muted-foreground/70 hover:text-foreground"
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRowMenu((current) => current === model.name ? null : model.name);
          }}
        >
          ...
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="model-picker-row-menu absolute right-1 top-full z-30 mt-0.5 min-w-[8.5rem] rounded-md border bg-popover p-1 text-[12px] shadow-md"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {!isSelected && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-muted/70"
                onClick={() => onPick(model)}
              >
                Usar en este chat
              </button>
            )}
            {isPinned ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-muted/70"
                onClick={() => unpinModel(model.name)}
              >
                Quitar fijo
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-muted/70"
                onClick={() => pinModel(model)}
              >
                Fijar modelo
              </button>
            )}
          </div>
        )}
      </DropdownMenuItem>
    );
  };

  // Default model selector for regular chats
  return (
    <DropdownMenu onOpenChange={(open) => {
      if (open) { void refreshModels?.(); }
      else {
        setSearchQuery("");
        setRowMenu(null);
      }
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
          "text-[13.5px] font-semibold",
          "transition-[background-color,border-color,color] duration-base ease-smooth",
          "hover:bg-muted/45 hover:border-border/40",
          "active:bg-muted/55",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "data-[state=open]:bg-muted/55 data-[state=open]:border-border/50",
        )}
      >
        {selectedModelData && <ModelLogo model={selectedModelData} compact />}
        <span className="chat-model-label min-w-0 max-w-[180px] truncate font-medium">{selectedModelData ? getModelDisplayLabel(selectedModelData) : brandModelLabel(selectedModel)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-55 transition-transform duration-200 group-data-[state=open]/model:rotate-180" strokeWidth={2} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} collisionPadding={12} className="model-picker-content w-[min(calc(100vw-1.5rem),16.25rem)] overflow-hidden p-0">
        <div className="model-picker-search-shell hidden sm:block">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/55" />
            <Input
              placeholder="Buscar modelos"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="model-picker-search-input h-7 rounded-md border-0 bg-transparent pl-7 pr-2 text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-[13px]"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>

        <ScrollArea className="chat-model-menu-scroll h-[min(52dvh,300px)]">
          {filteredModels.length > 0 ? (
            <div className="model-picker-list flex flex-col gap-px px-1.5 pb-1.5 pt-1">
              {filteredModels.map((model: any) => (
                <ModelRow key={model.name} model={model} />
              ))}
            </div>
          ) : (
            <div className="px-3 py-10 text-center text-[12.5px] text-muted-foreground">
              {searchQuery ? "Sin coincidencias" : "Sin modelos disponibles"}
            </div>
          )}
        </ScrollArea>
        {typeof setSelectedEffort === "function" && (
          <EffortSection
            selectedEffort={selectedEffort}
            setSelectedEffort={setSelectedEffort}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}, areNavbarModelSelectorPropsEqual);

const WORK_MODE_STORAGE_KEY = 'sira:chat:work-mode';

const EMPTY_CHAT_MESSAGES: any[] = []

type ChatMessageListProps = {
  messages: any[]
  isStreaming: boolean
  radixViewport: HTMLElement | null
  user: any
  onRegenerate: (messageId: string) => void | Promise<void>
  onBranch: (messageId: string) => void | Promise<void>
  updateMessageInChat: (messageId: string, newContent: string, files?: any[]) => void
  onToggleSplitView: (content: any) => void
  onDocumentPreview: (target: DocumentPreviewTarget) => void
  onAttachmentPreview: (attachment: AttachmentLike, siblings: AttachmentLike[], index: number) => void
  onOpenSources: (payload: { sources: any[]; activity: any; memory?: any[]; memoryMeta?: any; messageId?: string }) => void
}

// The transcript is intentionally isolated from composer state. Typing used
// to reconcile every message (including Markdown and artifact renderers) on
// each keystroke because the list lived inside ChatInterfaceContent. Keeping
// stable callback props lets React skip that entire subtree until messages or
// streaming state actually change.
const ChatMessageList = React.memo(function ChatMessageList({
  messages: rawMessages,
  isStreaming,
  radixViewport,
  user,
  onRegenerate,
  onBranch,
  updateMessageInChat,
  onToggleSplitView,
  onDocumentPreview,
  onAttachmentPreview,
  onOpenSources,
}: ChatMessageListProps) {
  const { stableMessages, streamingMessage } = React.useMemo(() => {
    // Two passes are deliberate: the first collapses optimistic/server twins;
    // the second catches duplicates that become adjacent after hidden tool and
    // metadata messages are removed.
    const messages = dedupeMessages(rawMessages)
    const lastMessage = messages[messages.length - 1]
    const streamingCandidate = isStreaming && isAssistantMessage(lastMessage)
      ? lastMessage
      : null
    const stable = dedupeMessages(
      streamingCandidate
        ? messages.slice(0, -1).filter((message) => shouldRenderChatMessage(message))
        : messages.filter((message) => shouldRenderChatMessage(message))
    )
    const streaming = streamingCandidate && shouldRenderChatMessage(streamingCandidate, true)
      ? streamingCandidate
      : null

    return { stableMessages: stable, streamingMessage: streaming }
  }, [isStreaming, rawMessages])

  return (
    <>
      {radixViewport && stableMessages.length > 40 ? (
        <Virtuoso
          data={stableMessages}
          customScrollParent={radixViewport}
          computeItemKey={(_, message) => message.id}
          increaseViewportBy={400}
          itemContent={(_, message) => (
            <ErrorBoundary key={message.id} label={`message:${message.id}`}>
              <MessageComponent
                message={message}
                user={user}
                onRegenerate={onRegenerate}
                onBranch={onBranch}
                updateMessageInChat={updateMessageInChat}
                isStreaming={false}
                onToggleSplitView={onToggleSplitView}
                onDocumentPreview={onDocumentPreview}
                onAttachmentPreview={onAttachmentPreview}
                onOpenSources={onOpenSources}
              />
            </ErrorBoundary>
          )}
        />
      ) : (
        stableMessages.map((message) => (
          <ErrorBoundary key={message.id} label={`message:${message.id}`}>
            <MessageComponent
              message={message}
              user={user}
              onRegenerate={onRegenerate}
              onBranch={onBranch}
              updateMessageInChat={updateMessageInChat}
              isStreaming={false}
              onToggleSplitView={onToggleSplitView}
              onDocumentPreview={onDocumentPreview}
              onAttachmentPreview={onAttachmentPreview}
              onOpenSources={onOpenSources}
            />
          </ErrorBoundary>
        ))
      )}
      {streamingMessage && (
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
              onRegenerate={onRegenerate}
              updateMessageInChat={updateMessageInChat}
              isStreaming={true}
              onToggleSplitView={onToggleSplitView}
              onDocumentPreview={onDocumentPreview}
              onAttachmentPreview={onAttachmentPreview}
            />
          </ErrorBoundary>
        </div>
      )}
    </>
  )
})

ChatMessageList.displayName = "ChatMessageList"

export default function ChatInterface() {
  return <ChatInterfaceContent />
}

function ChatInterfaceContent() {
  const tComposer = useTranslations("composer")
  const { active: activeArtifact, close: closeArtifactPanel } = useArtifactPanel()
  const { user } = useAuth()

  const {
    currentChat,
    setCurrentChat,
    chats,
    addMessage,
    addVideoMessage,
    addThesisMessage,
    clearCurrentChat,
    selectedModel,
    createNewChat,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
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
  const currentChatIdRef = React.useRef<string | null>(currentChatId)
  currentChatIdRef.current = currentChatId
  // Live refs so stable (identity-fixed) callbacks like `branchMessage` can
  // read the latest chat/model without re-creating — required because the
  // memoized MessageComponent ignores callback prop changes.
  const currentChatRef = React.useRef<any>(currentChat)
  currentChatRef.current = currentChat
  const selectedModelRef = React.useRef<string | undefined>(selectedModel)
  selectedModelRef.current = selectedModel
  const isCurrentChatStreaming = Boolean(currentChatId && activeStreamingChatIds.includes(currentChatId))
  const isCurrentChatLoading = isCurrentChatStreaming
  // Per-chat draft persistence. The composer's text is saved (debounced)
  // to localStorage scoped by chatId and restored when the user comes
  // back to the same conversation after a reload or accidental
  // navigation. See hooks/use-chat-draft.ts for the contract.
  const chatDraft = useChatDraft(currentChat?.id, user?.id)
  const lastRestoredDraftScopeRef = React.useRef<string | null>(null)
  const [isRecording, setIsRecording] = React.useState(false)
  const [isDictationTranscribing, setIsDictationTranscribing] = React.useState(false)
  const inputRef = React.useRef("")
  const dictationBaseRef = React.useRef("")
  const dictationFinalRef = React.useRef("")
  const dictationInterimRef = React.useRef("")
  const dictationAudioChunksRef = React.useRef<Blob[]>([])
  const dictationMediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const dictationModeRef = React.useRef<"idle" | "native" | "recorder">("idle")
  const dictationWantListeningRef = React.useRef(false)
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

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const draft = sessionStorage.getItem("publishing-debug-prefill")
      if (draft) {
        setInput(prev => prev.trim() ? prev : draft)
        sessionStorage.removeItem("publishing-debug-prefill")
      }
    } catch {
      /* private-mode / blocked storage — harmless */
    }
  }, [])

  // Public-demo prefill (growth handoff): /demo stashes the tried prompt
  // under "demo-prefill" before sending the visitor through sign-up, so
  // their first chat opens with the demo prompt ready to send. One-shot,
  // never auto-sent — same contract as the prefills above.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const draft = sessionStorage.getItem("demo-prefill")
      if (draft) {
        setInput(prev => prev.trim() ? prev : draft)
        sessionStorage.removeItem("demo-prefill")
      }
    } catch {
      /* private-mode / blocked storage — harmless */
    }
  }, [])

  // Restore a previously saved composer draft when entering a chat.
  // Runs AFTER the project-prefill effect so an explicit project draft
  // still wins. Each chat id is restored at most once per mount; further
  // typing is captured by handleTextareaChange below.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const scope = currentChat?.id ?? "__new__"
    if (lastRestoredDraftScopeRef.current === scope) return
    lastRestoredDraftScopeRef.current = scope
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
  const [isGeneratingVoice, setIsGeneratingVoice] = React.useState(false)
  const [selectedVoiceModel, setSelectedVoiceModel] = React.useState<VoiceModel>("Gemini 2.5 Flash TTS")
  const [selectedVoiceLanguage, setSelectedVoiceLanguage] = React.useState<VoiceLanguage>("Spanish")
  const [selectedVoiceAccent, setSelectedVoiceAccent] = React.useState<VoiceAccent>("Latino")
  const [selectedVoiceStability, setSelectedVoiceStability] = React.useState(100)
  const [selectedVoiceEffect, setSelectedVoiceEffect] = React.useState<VoiceEffect>("Studio Clean")
  // Specific ElevenLabs voice chosen from the Voice Catalog. It is only sent
  // when ElevenLabs is selected; Gemini uses its own production voice.
  const [selectedVoiceId, setSelectedVoiceId] = React.useState<string>("")
  const [selectedVoiceName, setSelectedVoiceName] = React.useState<string>("")
  const [voiceCatalogOpen, setVoiceCatalogOpen] = React.useState(false)
  React.useEffect(() => {
    try {
      const id = localStorage.getItem("siragpt:selectedVoiceId") || ""
      const name = localStorage.getItem("siragpt:selectedVoiceName") || ""
      if (id) setSelectedVoiceId(id)
      if (name) setSelectedVoiceName(name)
    } catch { /* localStorage unavailable */ }
  }, [])
  const handleSelectVoice = React.useCallback((voiceId: string, voiceName: string) => {
    setSelectedVoiceId(voiceId)
    setSelectedVoiceName(voiceName)
    try {
      localStorage.setItem("siragpt:selectedVoiceId", voiceId)
      localStorage.setItem("siragpt:selectedVoiceName", voiceName)
    } catch { /* localStorage unavailable */ }
  }, [])
  const [isMusicGenerationActive, setIsMusicGenerationActive] = React.useState(false)
  const [isGeneratingMusic, setIsGeneratingMusic] = React.useState(false)
  const [selectedMusicModel, setSelectedMusicModel] = React.useState<MusicModel>("ElevenLabs")
  const [selectedMusicStyle, setSelectedMusicStyle] = React.useState<MusicStyle>("Auto")
  const [selectedMusicMood, setSelectedMusicMood] = React.useState<MusicMood>("Balanced")
  const [selectedMusicDuration, setSelectedMusicDuration] = React.useState(30)
  const [selectedMusicInfluence, setSelectedMusicInfluence] = React.useState(0.3)
  const [selectedMusicEffect, setSelectedMusicEffect] = React.useState<MusicEffect>("Studio Master")
  const [selectedVideoResolution, setSelectedVideoResolution] = React.useState<VideoResolution>("720p")
  const [selectedVideoAspectRatio, setSelectedVideoAspectRatio] = React.useState<VideoAspectRatio>("9:16")
  const [selectedVideoDuration, setSelectedVideoDuration] = React.useState<VideoDuration>(DEFAULT_VIDEO_DURATION)
  const [selectedVideoAudio, setSelectedVideoAudio] = React.useState(true)
  const [selectedVideoModel, setSelectedVideoModel] = React.useState(DEFAULT_VIDEO_MODEL)
  const imageAbortControllerRef = React.useRef<AbortController | null>(null)
  const voiceAbortControllerRef = React.useRef<AbortController | null>(null)
  const musicAbortControllerRef = React.useRef<AbortController | null>(null)
  // Dedicated cancel handle for video generation, mirroring the image path so
  // every composer-driven media kind cancels through the same mechanism.
  const videoAbortControllerRef = React.useRef<AbortController | null>(null)
  const currentVideoOperationIdRef = React.useRef<string | null>(null)
  const isGeneratingImageRef = React.useRef(false)
  const isGeneratingVoiceRef = React.useRef(false)
  const isGeneratingMusicRef = React.useRef(false)
  const isGeneratingVideoRef = React.useRef(false)
  const isVideoGenerationActiveRef = React.useRef(false)
  const [isGeneratingVideo, setIsGeneratingVideo] = React.useState(false)
  const [isGeneratingPPT, setIsGeneratingPPT] = React.useState(false)
  const [isGeneratingWebDev, setIsGeneratingWebDev] = React.useState(false)
  const [imageCatalogModels, setImageCatalogModels] = React.useState<any[]>([])
  const [videoCatalogModels, setVideoCatalogModels] = React.useState<any[]>([])
  const refreshImageModels = React.useCallback(async () => {
    const modelsResponse = await apiClient.getAIModels('IMAGE');
    const models = Array.isArray(modelsResponse?.models)
      ? modelsResponse.models.filter(isImageModelEntry)
      : [];
    setImageCatalogModels(models);
    return models;
  }, []);
  const refreshVideoModels = React.useCallback(async () => {
    const modelsResponse = await apiClient.getAIModels('VIDEO');
    const models = filterAdminVisibleVideoModels(
      Array.isArray(modelsResponse?.models) ? modelsResponse.models : [],
    );
    setVideoCatalogModels(models);
    return models;
  }, []);
  const imageModelsForComposer = React.useMemo(() => {
    const source = imageCatalogModels.length ? imageCatalogModels : availableModels;
    return (Array.isArray(source) ? source : []).filter(isImageModelEntry);
  }, [availableModels, imageCatalogModels]);
  const videoModelsForComposer = React.useMemo(() => {
    // Dedicated VIDEO catalog first; never fall back to a heuristic list.
    const source = videoCatalogModels.length ? videoCatalogModels : [];
    return filterAdminVisibleVideoModels(source);
  }, [videoCatalogModels]);
  const composerAvailableModels = React.useMemo(() => {
    const byName = new Map<string, any>();
    for (const model of Array.isArray(availableModels) ? availableModels : []) {
      const name = String(model?.name || '').trim();
      if (name && !isImageModelEntry(model) && !isVideoModelEntry(model)) byName.set(name, model);
    }
    for (const model of imageCatalogModels) {
      const name = String(model?.name || '').trim();
      if (name) byName.set(name, model);
    }
    for (const model of videoCatalogModels) {
      const name = String(model?.name || '').trim();
      if (name) byName.set(name, model);
    }
    if (!imageCatalogModels.length && !videoCatalogModels.length) {
      return availableModels;
    }
    return Array.from(byName.values());
  }, [availableModels, imageCatalogModels, videoCatalogModels]);
  const resolveFreshActiveImageModel = React.useCallback(async (candidate?: string) => {
    const models = await refreshImageModels();
    const requestedName = String(candidate || '').trim();
    const requested = models.find((model: any) => model?.name === requestedName);
    return requested || models[0] || null;
  }, [refreshImageModels]);
  const providerForSelectedImageModel = React.useCallback((modelName: string) => {
    const selected = imageModelsForComposer.find((model: any) => model?.name === modelName);
    return selected?.provider || providerForMediaModel(modelName, selectProvider);
  }, [imageModelsForComposer, selectProvider]);
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const chatLogEndRef = React.useRef<HTMLDivElement>(null)
  const wasStreamingRef = React.useRef(false)
  const chatCreationInitiated = React.useRef(false);
  const prevChatIdRef = React.useRef<string | undefined>();
  const composerHighlightOverlayRef = React.useRef<HTMLDivElement>(null);
  // Mirror of `uploadedFiles` for use inside async/event handlers that
  // outlive the render closure (paste listener, drop handler, etc.) —
  // reading from state directly would capture stale values.
  const uploadedFilesRef = React.useRef<any[]>([]);
  React.useEffect(() => { uploadedFilesRef.current = uploadedFiles; }, [uploadedFiles]);
  const inFlightSendKeysRef = React.useRef<Map<string, { startedAt: number; idempotencyKey: string }>>(new Map());
  // Universal-ingest bookkeeping: chips cancelled mid-upload (their XHR
  // result must not resurrect them) + content-hash dedup of attachments.
  const cancelledTempIdsRef = React.useRef<Set<string>>(new Set());
  const attachmentHashesRef = React.useRef<Set<string>>(new Set());
  const attachmentHashByIdRef = React.useRef<Map<string, string>>(new Map());

  const updateUploadedFileById = React.useCallback((
    fileId: string,
    updater: (file: any) => any,
  ) => {
    setUploadedFiles((cur: any[]) => {
      const next = cur.map((file: any) => resolveUploadFileId(file) === fileId ? updater(file) : file);
      uploadedFilesRef.current = next;
      return next;
    });
  }, [setUploadedFiles]);

  const hydrateUploadedFileFromBackend = React.useCallback(async (fileId: string) => {
    try {
      const payload: any = await apiClient.getFile(fileId);
      const record = payload?.file || payload;
      if (!record?.id) return;

      updateUploadedFileById(fileId, (current: any) => ({
        ...current,
        id: record.id || current.id,
        fileId: record.id || current.fileId,
        name: current.name || record.originalName || record.filename || record.id,
        originalName: record.originalName || current.originalName || current.name,
        filename: record.filename || current.filename,
        type: record.mimeType || current.type,
        mimeType: record.mimeType || current.mimeType || current.type,
        size: record.size ?? current.size,
        url: record.url || current.url,
        extractedText: record.extractedText ?? current.extractedText ?? null,
        openaiFileId: record.openaiFileId || current.openaiFileId || null,
        processingStage: record.processingStage || current.processingStage || "ready",
        processingError: record.processingError ?? current.processingError ?? null,
        status: record.processingStage === "failed"
          ? "failed"
          : record.processingStage === "ready"
            ? "ready"
            : current.status,
      }));
    } catch (error) {
      console.warn("[chat] could not hydrate processed upload:", error);
    }
  }, [updateUploadedFileById]);

  const handleFileProcessingStatusChange = React.useCallback((file: any, status: FileProcessingStatus) => {
    const fileId = status.fileId || resolveUploadFileId(file);
    if (!fileId || !status.stage) return;

    updateUploadedFileById(fileId, (current: any) => ({
      ...current,
      processingStage: status.stage,
      processingError: status.error,
      status: status.stage === "failed"
        ? "failed"
        : status.stage === "ready"
          ? "ready"
          : current.status === "uploading"
            ? "uploading"
            : "processing",
      uploadError: status.stage === "failed"
        ? (status.error || current.uploadError || "No se pudo procesar el documento.")
        : current.uploadError,
    }));

    if (status.stage === "ready") {
      void hydrateUploadedFileFromBackend(fileId);
    }
  }, [hydrateUploadedFileFromBackend, updateUploadedFileById]);

  const handlePasteCaptureActionRef = React.useRef<(action: PasteCaptureAction, result: PasteCaptureResult) => void>(() => {})

  const handlePasteCaptureAction = React.useCallback(
    (action: PasteCaptureAction, result: PasteCaptureResult) => {
      handlePasteCaptureActionRef.current(action, result)
    },
    []
  )

  const pasteCapture = usePasteCapture(handlePasteCaptureAction);
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

  React.useEffect(() => {
    if (wasStreamingRef.current && !isCurrentChatStreaming) {
      try {
        chatLogEndRef.current?.focus({ preventScroll: true })
      } catch { /* ignore */ }
    }
    wasStreamingRef.current = isCurrentChatStreaming
  }, [isCurrentChatStreaming]);

  const [isUploading, setIsUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<{ [key: string]: number }>({});

  // Local sending / intent state so Stop button appears immediately on Enter
  const [isSending, setIsSending] = React.useState(false);
  const [sendingChatId, setSendingChatId] = React.useState<string | null>(null);
  // Synchronous gate for duplicate submit events. React state updates land
  // after the current event turn, so rapid Enter keydown/keypress pairs or
  // double taps can otherwise run handleSend twice with the same composer text.
  // PER-CHAT (a Set of chat ids), NOT a single boolean: handleSend awaits the
  // whole stream to [DONE], so a global latch stayed held for the entire time
  // chat A was responding and silently no-op'ed every send in chat B / a fresh
  // "Nuevo chat" — the "can't use another chat while one is answering" bug.
  const sendInFlightChatsRef = React.useRef<Set<string>>(new Set());
  const intentAbortControllerRef = React.useRef<AbortController | null>(null);
  // Separate controller for the agentic search so Stop can cancel the
  // SSE stream without clobbering other in-flight requests (intent
  // classification, chat streaming) that live under intentAbortController.
  const searchAbortControllerRef = React.useRef<AbortController | null>(null);
  const currentAgentTaskIdRef = React.useRef<string | null>(null);
  const localJobControllersRef = React.useRef<Map<string, AbortController>>(new Map());
  const agentTaskIdsByChatRef = React.useRef<Map<string, string>>(new Map());
  const agentTaskRecoveryControllersRef = React.useRef<Map<string, AbortController>>(new Map());
  const agentTaskRecoveryWakeKeysRef = React.useRef<Map<string, string>>(new Map());
  const terminalAgentTaskIdsByChatRef = React.useRef<Map<string, Set<string>>>(new Map());
  const activeLocalJobChatIdsRef = React.useRef<Set<string>>(new Set());
  const [activeLocalJobChatIds, setActiveLocalJobChatIds] = React.useState<string[]>([]);
  const [agentTaskRecoveryHydrationNonce, setAgentTaskRecoveryHydrationNonce] = React.useState(0);

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

  React.useEffect(() => {
    const onCancel = (event: Event) => {
      const taskId = String((event as CustomEvent<{ taskId?: string }>).detail?.taskId || "")
      if (!taskId) return
      const matchesCurrent = currentAgentTaskIdRef.current === taskId
      let matchesChat = false
      agentTaskIdsByChatRef.current.forEach((id) => {
        if (id === taskId) matchesChat = true
      })
      if (!matchesCurrent && !matchesChat) return
      const scoped = currentChatId ? localJobControllersRef.current.get(currentChatId) : null
      const controller = searchAbortControllerRef.current || scoped
      controller?.abort()
    }
    window.addEventListener("agent-task-cancel", onCancel)
    return () => window.removeEventListener("agent-task-cancel", onCancel)
  }, [currentChatId])

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

  // ─── Durable agent-task recovery ───────────────────────────────────
  // Agent/document tasks execute on the backend and can outlive this page.
  // Reconnect the visible message bubble after reload or chat navigation by
  // discovering the task through the chat-scoped durable pointer and polling
  // its event log. Cleanup aborts only this browser poll; it deliberately does
  // not call cancelTask, so switching chats never stops server-side work.
  React.useEffect(() => {
    const chatId = currentChatId;
    if (!chatId) return;
    if (localJobControllersRef.current.has(chatId)) return;
    if (agentTaskRecoveryControllersRef.current.has(chatId)) return;

    const controller = new AbortController();
    const { signal } = controller;
    const recoveryControllers = agentTaskRecoveryControllersRef.current;
    recoveryControllers.set(chatId, controller);
    // A previous recovery pass can hand off the next durable task while
    // deliberately keeping this chat busy. Claim that pointer immediately so
    // an aborted replacement poll can release only the busy state it owns.
    let recoveredTaskId: string | null = agentTaskIdsByChatRef.current.get(chatId) || null;
    let bubbleMessageId: string | null = null;
    let reachedTerminal = false;
    let recoveryDetached = false;
    let terminalRecoveryLookupFailure = false;

    const releaseRecoveryBusyIfOwned = () => {
      const ownsRecoveryController = recoveryControllers.get(chatId) === controller;
      const trackedTaskId = agentTaskIdsByChatRef.current.get(chatId) || null;
      const stillOwnsRecoveredTask = Boolean(recoveredTaskId && trackedTaskId === recoveredTaskId);
      if (ownsRecoveryController && stillOwnsRecoveredTask && !localJobControllersRef.current.has(chatId)) {
        markLocalJobIdle(chatId);
      }
    };

    const upsertRecoveredBubble = (taskId: string, state: AgentTaskState, status?: string) => {
      if (signal.aborted) return;
      const content = serializeRecoveredAgentTaskState(state);
      setCurrentChat(prevChat => {
        if (!prevChat || prevChat.id !== chatId) return prevChat;
        const messages = [...(prevChat.messages || [])];
        let messageIndex = messages.findIndex((message: any) => {
          const parsedState = parseAgentTaskMessageState(message?.content);
          return getAgentTaskIdFromMessage(message, parsedState) === taskId;
        });
        if (messageIndex < 0 && bubbleMessageId) {
          messageIndex = messages.findIndex((message: any) => message?.id === bubbleMessageId);
        }
        if (messageIndex < 0) {
          const recoverable = findRecoverableAgentTaskMessage(messages, taskId);
          if (recoverable) messageIndex = messages.findIndex((message: any) => message?.id === recoverable.message.id);
        }

        if (messageIndex >= 0) {
          const previous = messages[messageIndex];
          bubbleMessageId = previous.id;
          messages[messageIndex] = {
            ...previous,
            content,
            metadata: JSON.stringify({
              ...parseAgentTaskMessageMetadata(previous.metadata),
              source: "agent-task",
              taskId,
              status: status || (state.done ? (state.error ? "error" : "completed") : "running"),
              updatedAt: new Date().toISOString(),
            }),
          };
        } else {
          bubbleMessageId = `msg-ai-recovery-${taskId}`;
          messages.push({
            id: bubbleMessageId,
            chatId,
            role: "ASSISTANT" as const,
            content,
            timestamp: new Date().toISOString(),
            metadata: JSON.stringify({
              source: "agent-task",
              taskId,
              status: status || "running",
              recovered: true,
            }),
          });
        }
        return { ...prevChat, messages };
      });
    };

    void (async () => {
      try {
        let pendingEnvelope: Awaited<ReturnType<typeof apiClient.getChatPendingStream>> | null = null;
        // A handed-off task already owns the same-chat queue lock. Keep its
        // discovery retry alive (also while the user reads another chat) until
        // the durable endpoint answers; releasing on an unknown result could
        // overlap queued work with a still-running server task.
        const maxDiscoveryAttempts = recoveredTaskId ? Number.POSITIVE_INFINITY : 3;
        for (let attempt = 0; attempt < maxDiscoveryAttempts && !signal.aborted; attempt += 1) {
          try {
            pendingEnvelope = await apiClient.getChatPendingStream(chatId);
            if (pendingEnvelope?.ok) break;
            pendingEnvelope = null;
          } catch (error: any) {
            if (signal.aborted || error?.name === "AbortError") return;
          }
          await waitForAgentTaskRecoveryPoll(Math.min(5000, 400 * (attempt + 1)), signal);
        }
        if (signal.aborted) return;
        if (!pendingEnvelope?.ok) return;

        const messages = currentChatRef.current?.id === chatId
          ? (currentChatRef.current.messages || [])
          : [];
        const localCandidate = findRecoverableAgentTaskMessage(messages);
        const taskPointer = resolveChatAgentTaskForRecovery(
          pendingEnvelope,
          localCandidate?.taskId || null,
          Boolean(localCandidate),
          terminalAgentTaskIdsByChatRef.current.get(chatId),
        );
        const taskId = taskPointer?.taskId || null;

        // latestTask intentionally is not enough by itself: every historic
        // agent chat has one. A terminal task is recovered only when the
        // currently persisted bubble still says it is unfinished.
        if (!taskId) {
          // The durable endpoint is authoritative: if the handed-off task is
          // no longer active, release only the busy marker owned by this poll.
          releaseRecoveryBusyIfOwned();
          return;
        }
        if (localJobControllersRef.current.has(chatId)) return;

        const matchingCandidate = findRecoverableAgentTaskMessage(messages, taskId);
        recoveredTaskId = taskId;
        bubbleMessageId = matchingCandidate?.message?.id || null;
        agentTaskIdsByChatRef.current.set(chatId, taskId);
        markLocalJobBusy(chatId);

        let state = normalizeRecoveredAgentTaskState(matchingCandidate?.state, taskId);
        if (state.steps.length === 0 && !state.done) {
          state = {
            ...state,
            steps: [{
              id: "client-agent-recovery",
              label: "Recuperando tarea en segundo plano",
              icon: "thought",
              reasoning: "Reconectando con la ejecución durable sin reiniciar el trabajo.",
              status: "running",
              toolCalls: [],
            }],
          };
        }
        upsertRecoveredBubble(taskId, state, taskPointer?.status);

        let cursor = 0;
        let failedPolls = 0;
        while (!signal.aborted) {
          let payload: Awaited<ReturnType<typeof agentTaskService.getTaskEvents>> | null = null;
          try {
            payload = await agentTaskService.getTaskEvents(taskId, cursor, { signal });
          } catch (error: any) {
            if (signal.aborted || error?.name === "AbortError") return;
          }

          if (!payload?.ok) {
            failedPolls += 1;
            const statusCode = Number(payload?.statusCode || 0);
            if (isTerminalAgentTaskRecoveryHttpStatus(statusCode)) {
              const accessDenied = statusCode === 401 || statusCode === 403;
              state = {
                ...state,
                done: true,
                error: accessDenied
                  ? "No se pudo reconectar la tarea porque la sesión o los permisos cambiaron."
                  : "La tarea ya no está disponible para reconexión.",
                stoppedReason: accessDenied ? "recovery_access_denied" : "recovery_not_found",
              };
              reachedTerminal = true;
              terminalRecoveryLookupFailure = true;
              upsertRecoveredBubble(taskId, state, "error");
              break;
            }
            if (shouldDetachAgentTaskRecovery(failedPolls)) {
              state = {
                ...state,
                done: false,
                error: "Se perdió temporalmente la conexión con esta tarea. El trabajo del servidor no fue cancelado; vuelve a abrir el chat para reconectar.",
                stoppedReason: "recovery_poll_exhausted",
              };
              recoveryDetached = true;
              upsertRecoveredBubble(taskId, state, "reconnecting");
              break;
            }
            await waitForAgentTaskRecoveryPoll(Math.min(5000, 600 * (2 ** Math.min(failedPolls, 3))), signal);
            continue;
          }

          failedPolls = 0;
          const events = Array.isArray(payload.events) ? payload.events : [];
          const cursorBeforeBatch = cursor;
          for (const event of events) {
            const seq = Number((event as any)?.seq);
            if (Number.isFinite(seq)) cursor = Math.max(cursor, seq);
          }

          if (payload.streamState) {
            // The server snapshot already includes all events up to this poll,
            // so use it as the authority and avoid duplicating steps/artifacts.
            state = normalizeRecoveredAgentTaskState(payload.streamState, taskId);
          } else if (events.length > 0) {
            if (cursorBeforeBatch === 0) state = normalizeRecoveredAgentTaskState(null, taskId);
            for (const event of events) state = reduceEvent(state, event);
          }

          const normalizedStatus = String(payload.status || "").toLowerCase();
          if (!state.done && normalizedStatus === "completed") {
            state = { ...state, done: true, stoppedReason: state.stoppedReason || "recovered_completed" };
          } else if (!state.done && ["cancelled", "canceled"].includes(normalizedStatus)) {
            state = { ...state, done: true, error: state.error || "Tarea detenida.", stoppedReason: "cancelled" };
          } else if (!state.done && ["error", "failed"].includes(normalizedStatus)) {
            state = { ...state, done: true, error: state.error || payload.error || "La tarea agéntica falló.", stoppedReason: "error" };
          }

          upsertRecoveredBubble(taskId, state, payload.status);
          if (state.done || isTerminalAgentTaskStatus(payload.status)) {
            reachedTerminal = true;
            break;
          }
          await waitForAgentTaskRecoveryPoll(900, signal);
        }
      } finally {
        const ownsRecoveryController = recoveryControllers.get(chatId) === controller;
        if ((reachedTerminal || recoveryDetached) && !signal.aborted) {
          let terminalIds = terminalAgentTaskIdsByChatRef.current.get(chatId) || new Set<string>();
          if (reachedTerminal && recoveredTaskId) {
            terminalIds.add(recoveredTaskId);
            // Keep this browser-session dedupe bounded while the durable API
            // converges and removes recently terminal tasks from activeTasks.
            while (terminalIds.size > 20) {
              const oldestTaskId = terminalIds.values().next().value;
              if (!oldestTaskId) break;
              terminalIds.delete(oldestTaskId);
            }
            terminalAgentTaskIdsByChatRef.current.set(chatId, terminalIds);
          }

          let nextTaskPointer: ReturnType<typeof resolveChatAgentTaskForRecovery> = null;
          let nextTaskDiscoveryFailed = false;
          if (reachedTerminal && !terminalRecoveryLookupFailure) {
            try {
              const nextEnvelope = await apiClient.getChatPendingStream(chatId);
              nextTaskPointer = resolveChatAgentTaskForRecovery(
                nextEnvelope,
                null,
                false,
                terminalIds,
              );
            } catch {
              // Keep the busy ownership during a transient handoff failure. A
              // fresh recovery pass retries discovery without overlapping the
              // just-completed task with queued work from the same chat.
              nextTaskDiscoveryFailed = true;
            }
          }

          if (signal.aborted) return;

          const trackedTaskId = agentTaskIdsByChatRef.current.get(chatId) || null;
          const stillOwnsRecoveredTask = Boolean(recoveredTaskId && trackedTaskId === recoveredTaskId);
          const hasReplacementController = localJobControllersRef.current.has(chatId);
          if (stillOwnsRecoveredTask && !hasReplacementController) {
            if (nextTaskPointer?.taskId) {
              // Atomic A → B handoff: retain the busy marker and transfer task
              // ownership before waking the next recovery effect.
              agentTaskIdsByChatRef.current.set(chatId, nextTaskPointer.taskId);
            } else if (!nextTaskDiscoveryFailed) {
              // The durable endpoint confirmed there is no next task.
              markLocalJobIdle(chatId);
            }
          }

          if (ownsRecoveryController) {
            recoveryControllers.delete(chatId);
          }

          if (reachedTerminal && currentChatIdRef.current === chatId) {
            if (nextTaskPointer?.taskId || nextTaskDiscoveryFailed) {
              setAgentTaskRecoveryHydrationNonce(value => value + 1);
            }
            try {
              const refreshed = await apiClient.getChat(chatId);
              setCurrentChat(prevChat => (
                prevChat?.id === chatId
                  ? mergeChatPreservingUserMessages(refreshed.chat, prevChat)
                  : prevChat
              ));
            } catch {
              // The reconstructed bubble is already complete; the durable DB
              // refresh is best-effort and can retry on the next navigation.
            }
          }
        } else if (ownsRecoveryController) {
          recoveryControllers.delete(chatId);
        }
      }
    })();

    return () => {
      // A chat switch must not detach recovery: the durable task keeps
      // running, and releasing its local busy marker here would allow the
      // same-chat queue to start overlapping work. The poll can safely remain
      // in the background because every visible-state write is chat-scoped.
      if (currentChatIdRef.current !== chatId) return;
      const ownsRecoveryController = recoveryControllers.get(chatId) === controller;
      controller.abort();
      if (ownsRecoveryController) {
        recoveryControllers.delete(chatId);
      }
    };
  }, [agentTaskRecoveryHydrationNonce, currentChatId, markLocalJobBusy, markLocalJobIdle, setCurrentChat]);

  // Recovery polls are browser-only. Teardown may stop the poll, but it
  // must NEVER cancel the server job (Word/doc outlives the SSE socket).
  React.useEffect(() => {
    const recoveryControllers = agentTaskRecoveryControllersRef.current;
    return () => {
      for (const controller of recoveryControllers.values()) {
        controller.abort();
      }
      recoveryControllers.clear();
    };
  }, []);

  // selectChat can expose a cached shell first and hydrate its messages from
  // the server a moment later without changing the chat id. Wake recovery once
  // for that newly-arrived unfinished bubble; the active-controller guards
  // above keep normal poll updates from creating a second connection.
  React.useEffect(() => {
    if (!currentChatId) return;
    if (localJobControllersRef.current.has(currentChatId)) return;
    if (agentTaskRecoveryControllersRef.current.has(currentChatId)) return;
    const candidate = findRecoverableAgentTaskMessage(currentChat?.messages || []);
    if (!candidate) return;
    const wakeKey = `${candidate.message?.id || "message"}:${candidate.taskId || "pending"}`;
    if (agentTaskRecoveryWakeKeysRef.current.get(currentChatId) === wakeKey) return;
    agentTaskRecoveryWakeKeysRef.current.set(currentChatId, wakeKey);
    setAgentTaskRecoveryHydrationNonce(value => value + 1);
  }, [currentChat?.messages, currentChatId]);

  // Voice Studio panel state
  const [showAudioPanel, setShowAudioPanel] = React.useState(false);
  const [audioTab, setAudioTab] = React.useState<'tts' | 'stt' | 'music' | 'video'>("tts");
  const [coworkPanelOpen, setCoworkPanelOpen] = React.useState(false);
  const [computerPanelOpen, setComputerPanelOpen] = React.useState(false);
  const [loginHandoffActive, setLoginHandoffActive] = React.useState(false);
  const [loginHandoffSite, setLoginHandoffSite] = React.useState("");
  const [loginHandoffKind, setLoginHandoffKind] = React.useState("");

  // Speech-to-Text states
  const [isSpeechSupported, setIsSpeechSupported] = React.useState(false);
  const recognitionRef = React.useRef<SpeechRecognition | null>(null);

  const [isWebSearching, setIsWebSearching] = React.useState(false)
  const [isWorkModeActive, setIsWorkModeActiveState] = React.useState(false);
  React.useEffect(() => {
    try {
      setIsWorkModeActiveState(window.localStorage.getItem(WORK_MODE_STORAGE_KEY) === '1');
    } catch { /* storage can be disabled without breaking chat */ }
  }, []);
  const setIsWorkModeActive = React.useCallback((value: boolean) => {
    setIsWorkModeActiveState(value);
    try {
      window.localStorage.setItem(WORK_MODE_STORAGE_KEY, value ? '1' : '0');
    } catch { /* storage can be disabled without breaking chat */ }
  }, []);
  const [isWebSearchActive, setIsWebSearchActive] = React.useState(false);
  const isWebSearchActiveRef = React.useRef(isWebSearchActive);
  React.useEffect(() => {
    isWebSearchActiveRef.current = isWebSearchActive;
  }, [isWebSearchActive]);
  const [isGmailActive, setIsGmailActive] = React.useState(false);
  const [isProcessingGmail, setIsProcessingGmail] = React.useState(false);
  const [isGoogleCalendarActive, setIsGoogleCalendarActive] = React.useState(false);
  const [isGoogleDriveActive, setIsGoogleDriveActive] = React.useState(false);
  const [isProcessingGoogleServices, setIsProcessingGoogleServices] = React.useState(false);
  const [isSpotifyActive, setIsSpotifyActive] = React.useState(false);
  const [isProcessingSpotify, setIsProcessingSpotify] = React.useState(false);
  const [isImageGenerationActive, setIsImageGenerationActive] = React.useState(false);
  React.useEffect(() => {
    if (!isImageGenerationActive && chatType !== 'image') return;
    let cancelled = false;
    refreshImageModels()
      .then((models) => {
        if (cancelled) return;
        if (!models.length) {
          setSelectedImageModel('');
          return;
        }
        setSelectedImageModel((current) => (
          current && models.some((model: any) => model?.name === current)
            ? current
            : models[0].name
        ));
      })
      .catch((error) => {
        console.warn('No se pudo refrescar el catalogo de modelos de imagen:', error?.message || error);
      });
    return () => { cancelled = true; };
  }, [chatType, isImageGenerationActive, refreshImageModels]);
  const [isComputerUseActive, setIsComputerUseActive] = React.useState(false);
  const [computerUseAppMode, setComputerUseAppMode] = React.useState<ComputerUseAppMode | null>(null);
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
    sendControllerCommand,
    sendUserAction,
    currentUrl: computerUseCurrentUrl,
    actions: computerUseActions,
    takeoverState: computerUseTakeoverState,
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
  const closeAllToolsAndConnectors = React.useCallback((options: { preserveWebSearch?: boolean; preserveVideo?: boolean } = {}) => {
    if (!options.preserveWebSearch) setIsWebSearchActive(false);
    setIsImageGenerationActive(false);
    setIsVoiceGenerationActive(false);
    setIsMusicGenerationActive(false);
    if (!options.preserveVideo) {
      isVideoGenerationActiveRef.current = false;
      setIsVideoGenerationActive(false);
    }
    setIsGmailActive(false);
    setIsGoogleCalendarActive(false);
    setIsGoogleDriveActive(false);
    setIsSpotifyActive(false);
    setIsComputerUseActive(false);
    setComputerUseAppMode(null);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
  }, []);

  /**
   * Resets all tools, connectors, and UI states - used when switching chats or clicking "Nuevo chat"
   */
  const resetAllToolsAndConnectors = React.useCallback(() => {
    // Close all tools and connectors
    isGeneratingVideoRef.current = false;
    isVideoGenerationActiveRef.current = false;
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("siragpt.composer.videoMode");
      }
    } catch {}
    closeAllToolsAndConnectors();

    // Reset chat type
    setChatType('text');

    // Reset other UI states
    setShowAudioPanel(false);
    setCoworkPanelOpen(false);
    setComputerPanelOpen(false);
    setDocumentPreviewUrl(null);
    setSourcesPanelData(null);
    setActiveSearchActivityId(null);
    setSplitViewContent(null);
    setComposerPreviewIndex(null);
    setSelectedWordText(null);
    uploadedFilesRef.current = [];
    setUploadedFiles([]);
    attachmentHashesRef.current.clear();
    setUploadProgress({});
    setInput('');
    setSelectedImageModel(DEFAULT_IMAGE_MODEL);
    setSelectedVideoModel(DEFAULT_VIDEO_MODEL);

    // Clear Computer Use state
    if (clearReasoning) clearReasoning();
    setComputerUseStatus('idle');
    setComputerUseAppMode(null);
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
    const targetChatId = currentChatId;
    const scopedController = targetChatId ? localJobControllersRef.current.get(targetChatId) : null;
    const ownsSendingState = !targetChatId || sendingChatId === targetChatId;

    if (intentAbortControllerRef.current && ownsSendingState) {
      intentAbortControllerRef.current.abort();
      intentAbortControllerRef.current = null;
    }
    const scopedTaskId = targetChatId ? agentTaskIdsByChatRef.current.get(targetChatId) : null;
    const fallbackTaskId = currentAgentTaskIdRef.current;
    // A visible chat may be recovering task A while a foreground task B runs
    // elsewhere. Never fall back to B when Stop was clicked from A.
    const taskId = targetChatId ? scopedTaskId : fallbackTaskId;
    if (taskId) {
      // A recovered task has no foreground controller. Keep its ownership map
      // until the durable poll observes cancellation; otherwise the same-chat
      // queue could start before the server has actually stopped it.
      if (scopedTaskId && targetChatId && scopedController) {
        agentTaskIdsByChatRef.current.delete(targetChatId);
      }
      if (fallbackTaskId === taskId) {
        currentAgentTaskIdRef.current = null;
      }
      void agentTaskService.cancelTask(taskId).catch((err) => {
        console.warn('Failed to cancel agent task:', err);
      });
    }
    if (scopedController) {
      scopedController.abort();
      markLocalJobIdle(targetChatId, scopedController);
      if (searchAbortControllerRef.current === scopedController) {
        searchAbortControllerRef.current = null;
        setIsWebSearching(false);
      }
    } else if (!targetChatId && searchAbortControllerRef.current) {
      const controller = searchAbortControllerRef.current;
      controller.abort();
      searchAbortControllerRef.current = null;
      setIsWebSearching(false);
    }
    const imageController = imageAbortControllerRef.current;
    const ownsImageGeneration = Boolean(imageController && (!targetChatId || imageController === scopedController));
    if (imageController && ownsImageGeneration) {
      imageController.abort();
      imageAbortControllerRef.current = null;
      isGeneratingImageRef.current = false;
      setIsGeneratingImage(false);
      if (targetChatId) {
        markLocalJobIdle(targetChatId, imageController);
      }
      markImageGenerationStopped();
      toast.info('Generación de imagen detenida');
    }
    const voiceController = voiceAbortControllerRef.current;
    const ownsVoiceGeneration = Boolean(voiceController && (!targetChatId || voiceController === scopedController));
    if (voiceController && ownsVoiceGeneration) {
      const controller = voiceAbortControllerRef.current;
      voiceAbortControllerRef.current = null;
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      toast.info('Generación de voz detenida');
    }
    const musicController = musicAbortControllerRef.current;
    const ownsMusicGeneration = Boolean(musicController && (!targetChatId || musicController === scopedController));
    if (musicController && ownsMusicGeneration) {
      const controller = musicAbortControllerRef.current;
      musicAbortControllerRef.current = null;
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      toast.info('Generación de música detenida');
    }
    if (ownsVoiceGeneration && isGeneratingVoiceRef.current) {
      isGeneratingVoiceRef.current = false;
      setIsGeneratingVoice(false);
      setIsVoiceGenerationActive(true);
    }
    if (ownsMusicGeneration && isGeneratingMusicRef.current) {
      isGeneratingMusicRef.current = false;
      setIsGeneratingMusic(false);
      setIsMusicGenerationActive(true);
    }
    // Video now cancels through the same dedicated-AbortController mechanism as
    // image: abort the kickoff request, then clear the long-running media
    // indicators (video / slides) so the composer returns to idle. (The remote
    // render is a POST→poll job, so server-side completion may still finish;
    // this frees the UI and matches the image path.)
    const videoController = videoAbortControllerRef.current;
    const ownsVideoGeneration = Boolean(videoController && (!targetChatId || videoController === scopedController));
    if (videoController && ownsVideoGeneration) {
      videoController.abort();
      videoAbortControllerRef.current = null;
    }
    const videoOperationId = currentVideoOperationIdRef.current;
    if (videoOperationId && ownsVideoGeneration) {
      currentVideoOperationIdRef.current = null;
      void apiClient.cancelVideoGeneration(videoOperationId).catch((err) => {
        console.warn('Failed to cancel video generation:', err);
      });
    }
    if (ownsVideoGeneration) {
      isGeneratingVideoRef.current = false;
      setIsGeneratingVideo(false);
      setIsGeneratingPPT(false);
      isVideoGenerationActiveRef.current = true;
      setIsVideoGenerationActive(true);
      setChatType('video');
    }
    if (!targetChatId || activeStreamingChatIds.includes(targetChatId)) {
      stopStreaming();
    }
    if (ownsSendingState) {
      setIsSending(false);
      setSendingChatId(null);
    }
  }, [activeStreamingChatIds, currentChatId, markImageGenerationStopped, markLocalJobIdle, sendingChatId, setChatType, stopStreaming]);

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
      setComputerUseAppMode('computer');
      setIsComputerUseActive(true);
      setChatType('computer-use');
    } else {
      setIsComputerUseActive(false);
      setComputerUseAppMode(null);
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
        toast.error('Tu plan necesita una mejora para continuar.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (currentChat?.id && prevChat.id !== currentChat.id) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_SPOTIFY]') {
              return {
                ...msg,
                content: "Tu plan necesita una mejora para continuar usando Spotify.",
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
  const prevVideoGenerationActiveRef = React.useRef(false);
  React.useEffect(() => {
    // Restore after mount only (avoid SSR/session hydration mismatch).
    try {
      if (typeof window === "undefined") return;
      const parsed = JSON.parse(window.sessionStorage.getItem("siragpt.composer.videoMode") || "null");
      if (!parsed?.active) return;
      isVideoGenerationActiveRef.current = true;
      prevVideoGenerationActiveRef.current = true;
      setIsVideoGenerationActive(true);
      setChatType("video");
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    isVideoGenerationActiveRef.current = isVideoGenerationActive;
    try {
      if (typeof window === "undefined") return;
      if (isVideoGenerationActive) {
        window.sessionStorage.setItem(
          "siragpt.composer.videoMode",
          JSON.stringify({ active: true, chatId: currentChatId }),
        );
        prevVideoGenerationActiveRef.current = true;
        return;
      }
      if (prevVideoGenerationActiveRef.current) {
        window.sessionStorage.removeItem("siragpt.composer.videoMode");
        prevVideoGenerationActiveRef.current = false;
      }
    } catch {}
  }, [isVideoGenerationActive, currentChatId]);
  React.useEffect(() => {
    if (!isVideoGenerationActive && chatType !== 'video') return;
    let cancelled = false;
    refreshVideoModels()
      .then((models) => {
        if (cancelled) return;
        if (!models.length) {
          setSelectedVideoModel('');
          return;
        }
        const current = videoCatalogModels.length ? selectedVideoModel : '';
        if (current && models.some((model: any) => model?.name === current)) {
          setSelectedVideoModel(current);
        } else {
          setSelectedVideoModel(String(models[0]?.name ?? ''));
        }
      })
      .catch((error) => {
        console.warn('No se pudo refrescar el catalogo de modelos de video:', error?.message || error);
      });
    return () => { cancelled = true; };
  }, [chatType, isVideoGenerationActive, refreshVideoModels, selectedVideoModel, videoCatalogModels]);
  const [subscribeOpen, setSubscribeOpen] = React.useState(false);
  const [isSubscribing, setIsSubscribing] = React.useState(false);
  const [currentUserInfo, setCurrentUserInfo] = React.useState<any>(null);
  const currentPlan = normalizePlanName(user?.plan);
  const isFreePlan = isFreePlanName(currentPlan);
  const [splitViewContent, setSplitViewContent] = React.useState<any>(null)
  const [documentPreviewUrl, setDocumentPreviewUrl] = React.useState<DocumentPreviewTarget | null>(null);
  const [sourcesPanelData, setSourcesPanelData] = React.useState<{ sources: any[]; activity: any; memory?: any[]; memoryMeta?: any; messageId?: string } | null>(null);
  const [composerPreviewIndex, setComposerPreviewIndex] = React.useState<number | null>(null);
  const [sidePreviewAttachment, setSidePreviewAttachment] = React.useState<AttachmentLike | null>(null);
  const [sidePreviewSiblings, setSidePreviewSiblings] = React.useState<AttachmentLike[]>([]);
  const activeSearchActivity = activeSearchActivityId ? searchActivities[activeSearchActivityId] : null;
  const searchActivityPanelOpen = Boolean(activeSearchActivity);
  const autoVideoActivationRef = React.useRef(false);

  React.useEffect(() => {
    const wantsVideo = shouldAutoActivateVideoGeneration(input);
    const hasOtherActiveTool =
      isWebSearchActive ||
      isImageGenerationActive ||
      isVoiceGenerationActive ||
      isMusicGenerationActive ||
      isComputerUseActive ||
      isGmailActive ||
      isGoogleCalendarActive ||
      isGoogleDriveActive ||
      isSpotifyActive ||
      isWordConnectorActive ||
      isExcelConnectorActive ||
      (chatType !== 'text' && chatType !== 'video');

    if (wantsVideo && !hasOtherActiveTool) {
      if (!isVideoGenerationActive && !autoVideoActivationRef.current) {
        closeAllToolsAndConnectors();
        isVideoGenerationActiveRef.current = true;
        setIsVideoGenerationActive(true);
        setChatType('video');
        autoVideoActivationRef.current = true;
      }

      const requestedDuration = extractRequestedVideoDurationSeconds(input);
      if (requestedDuration) {
        const next = clampVideoDuration(requestedDuration, resolveVideoDurationSpec(selectedVideoModel))
        if (next != null && selectedVideoDuration !== next) {
          setSelectedVideoDuration(next as VideoDuration);
        }
      }
      const requestedAspectRatio = extractRequestedVideoAspectRatio(input);
      if (requestedAspectRatio && selectedVideoAspectRatio !== requestedAspectRatio) {
        setSelectedVideoAspectRatio(requestedAspectRatio as VideoAspectRatio);
      }
      const requestedResolution = extractRequestedVideoResolution(input);
      if (requestedResolution && selectedVideoResolution !== requestedResolution) {
        setSelectedVideoResolution(requestedResolution as VideoResolution);
      }
      const requestedAudio = extractRequestedVideoAudio(input);
      if (requestedAudio !== null && selectedVideoAudio !== requestedAudio) {
        setSelectedVideoAudio(requestedAudio);
      }
      return;
    }
  }, [
    chatType,
    closeAllToolsAndConnectors,
    input,
    isComputerUseActive,
    isExcelConnectorActive,
    isGmailActive,
    isGoogleCalendarActive,
    isGoogleDriveActive,
    isImageGenerationActive,
    isMusicGenerationActive,
    isSpotifyActive,
    isVideoGenerationActive,
    isVoiceGenerationActive,
    isWebSearchActive,
    isWordConnectorActive,
    selectedVideoAspectRatio,
    selectedVideoAudio,
    selectedVideoDuration,
    selectedVideoModel,
    selectedVideoResolution,
    setChatType,
  ]);

  React.useEffect(() => {
    setActiveSearchActivityId(null);
  }, [currentChat?.id]);

  const openSearchActivityPanel = React.useCallback((messageId: string) => {
    setActiveSearchActivityId(messageId);
  }, []);

  const closeSearchActivityPanel = React.useCallback(() => {
    setActiveSearchActivityId(null);
  }, []);

  const saveSearchActivityToLibrary = React.useCallback(async (activity: SearchActivityState, sources?: ResearchResultSource[]) => {
    const selection = sources?.length ? sources : activity.selectedSources
    if (!selection?.length) return
    try {
      const result = await apiClient.saveResearchReferences({
        sources: selection,
        collectionName: "Fuentes guardadas",
        tags: ["chat", "investigación"],
      }) as any
      toast.success(`${result?.references?.length || selection.length} referencias guardadas en Biblioteca`)
    } catch (error: any) {
      toast.error(error?.message || "No se pudieron guardar las referencias")
    }
  }, []);

  React.useEffect(() => {
    const onResearchFollowUp = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt
      if (!prompt) return
      setInput(prompt)
      setActiveSearchActivityId(null)
    }
    document.addEventListener(RESEARCH_FOLLOW_UP_EVENT, onResearchFollowUp)
    return () => document.removeEventListener(RESEARCH_FOLLOW_UP_EVENT, onResearchFollowUp)
  }, [])

  React.useEffect(() => {
    const onResearchArtifact = (event: Event) => {
      const request = (event as CustomEvent<ResearchArtifactRequest>).detail
      if (!request?.sources?.length || !request?.outline?.length) return

      void (async () => {
        const model = currentChatRef.current?.model || selectedModelRef.current
        if (!model) {
          toast.error("Selecciona un modelo antes de crear el archivo")
          return
        }

        let chatId = currentChatRef.current?.id as string | undefined
        const controller = new AbortController()
        const toastId = toast.loading(request.format === "pptx" ? "Preparando presentación científica…" : "Preparando documento científico…", { duration: Infinity })

        try {
          if (!chatId) {
            const created = await apiClient.createChat({
              title: request.title.slice(0, 80),
              model,
            })
            chatId = (created?.chat || created)?.id
            if (!chatId) throw new Error("No se pudo crear la conversación")
            await selectChat(chatId)
          }

          markLocalJobBusy(chatId, controller)
          let streamError = ""
          let completed = false
          const prompt = buildResearchArtifactPrompt(request)

          await apiClient.generateDocStream({
            prompt,
            displayPrompt: request.format === "pptx"
              ? `Crear PowerPoint científico: ${request.title}`
              : `Crear Word científico: ${request.title}`,
            chatId,
            model,
            format: request.format,
            template: "academic",
            complexity: "high",
            outline: request.outline,
            researchSources: request.sources,
          }, (streamEvent) => {
            if (streamEvent?.type === "stage") {
              toast.loading(streamEvent.label || "Construyendo archivo…", {
                id: toastId,
                duration: Infinity,
                description: Number.isFinite(streamEvent.pct) ? `${streamEvent.pct}%` : undefined,
              })
            } else if (streamEvent?.type === "error") {
              streamError = streamEvent.error || "No se pudo generar el archivo"
            } else if (streamEvent?.type === "final") {
              completed = true
            }
          }, { signal: controller.signal })

          if (streamError) throw new Error(streamError)
          if (!completed) throw new Error("La generación terminó sin entregar un archivo")
          await selectChat(chatId)
          toast.success(request.format === "pptx" ? "Presentación científica lista" : "Documento científico listo", {
            id: toastId,
            description: "Disponible para revisar y descargar",
          })
        } catch (error: any) {
          if (controller.signal.aborted || error?.name === "AbortError") {
            toast.info("Generación de documento detenida", { id: toastId })
          } else {
            toast.error(error?.message || "No se pudo crear el archivo", { id: toastId })
          }
        } finally {
          if (chatId) markLocalJobIdle(chatId, controller)
        }
      })()
    }

    document.addEventListener(RESEARCH_ARTIFACT_EVENT, onResearchArtifact)
    return () => document.removeEventListener(RESEARCH_ARTIFACT_EVENT, onResearchArtifact)
  }, [markLocalJobBusy, markLocalJobIdle, selectChat])

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
      lowerMessage.includes('free daily queries exhausted') ||
      lowerMessage.includes('upgrade required') ||
      lowerMessage.includes('upgrade_required') ||
      lowerMessage.includes('sube de plan') ||
      (lowerMessage.includes('monthly') && lowerMessage.includes('limit')) ||
      (lowerMessage.includes('daily') && lowerMessage.includes('limit'));
  }, []);


  // Search sources state - all enabled by default

  const chatViewportRef = React.useRef<HTMLDivElement>(null);
  const chatHeaderRef = React.useRef<HTMLDivElement>(null);
  const chatComposerDockRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [composerExpanded, setComposerExpanded] = React.useState(false)
  const expandComposer = React.useCallback(() => {
    setComposerExpanded((open) => {
      const next = !open
      try {
        window.sessionStorage.setItem("siragpt.composer.expanded", next ? "1" : "0")
      } catch {
        /* quota / private mode */
      }
      return next
    })
  }, [])
  React.useEffect(() => {
    try {
      if (window.sessionStorage.getItem("siragpt.composer.expanded") === "1") {
        setComposerExpanded(true)
      }
    } catch {
      /* private mode */
    }
  }, [])
  const [composerTextOverflows, setComposerTextOverflows] = React.useState(false)
  const composerShowExpand = composerExpanded || composerTextOverflows
  const chatLayoutVarsRef = React.useRef<Record<string, number>>({});
  const composerResizeFrameRef = React.useRef<number | null>(null);
  const textareaLayoutRef = React.useRef<{ height: number; overflowY: string }>({ height: 0, overflowY: "" });

  // Slash-command menu state. Tracks whether the menu is open and what filter
  // string the user has typed after the leading "/". The menu auto-opens
  // whenever the input starts with "/" and stays open while the user is still
  // typing the command name.
  const [slashMenuOpen, setSlashMenuOpen] = React.useState(false);
  const [slashMenuFilter, setSlashMenuFilter] = React.useState("");
  const [mentionMenuOpen, setMentionMenuOpen] = React.useState(false);
  const [mentionTrigger, setMentionTrigger] = React.useState<MentionTrigger | null>(null);
  const [mentionHealthById, setMentionHealthById] = React.useState<Record<string, string>>({});
  const [mentionRegistryIds, setMentionRegistryIds] = React.useState<readonly string[]>(REGISTRY_APP_IDS);
  const [selectedMentionIds, setSelectedMentionIds] = React.useState<string[]>([]);

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
    const caret = textareaRef.current?.selectionStart;
    const mention = detectAtMention(input, caret);
    if (mention && filter === null) {
      setMentionMenuOpen(true);
      setMentionTrigger(mention);
    } else if (!mention) {
      setMentionMenuOpen(false);
      setMentionTrigger(null);
    }
  }, [input]);

  React.useEffect(() => {
    if (!user) return
    let cancelled = false
    const token = typeof window !== "undefined" ? window.localStorage.getItem("auth-token") : null
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
    const api = getNormalizedApiBaseUrl()
    Promise.all([
      authenticatedFetch(`${api}/apps`, {
        credentials: "include",
        headers,
        signal: AbortSignal.timeout(15_000),
      }).then(async (res) => (res.ok ? res.json().catch(() => ({})) : {})),
      authenticatedFetch(`${api}/apps/connections`, {
        credentials: "include",
        headers,
        signal: AbortSignal.timeout(15_000),
      }).then(async (res) => (res.ok ? res.json().catch(() => ({})) : {})),
    ])
      .then(([appsBody, connectionsBody]) => {
        if (cancelled) return
        const manifests = Array.isArray((appsBody as { apps?: unknown }).apps)
          ? (appsBody as { apps: Array<{ id?: string }> }).apps
          : []
        const registry = manifests
          .map((app) => String(app?.id || "").trim())
          .filter(Boolean)
        if (registry.length) setMentionRegistryIds(registry)
        const allowed = new Set(registry.length ? registry : REGISTRY_APP_IDS)
        const next: Record<string, string> = {}
        const list = Array.isArray((connectionsBody as { connections?: unknown }).connections)
          ? (connectionsBody as { connections: Array<{ app?: string; status?: string }> }).connections
          : []
        for (const row of list) {
          const appId = String(row?.app || "").trim()
          const status = String(row?.status || "").trim()
          if (appId && status && allowed.has(appId)) next[appId] = status
        }
        setMentionHealthById(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [user]);

  const mentionPickerApps = React.useMemo(() => {
    const grouped = groupPickerApps(filterPickerApps(
      buildPickerApps(mentionHealthById, undefined, mentionRegistryIds),
      mentionTrigger?.query || "",
    ))
    return grouped.flat.slice(0, 40)
  }, [mentionHealthById, mentionRegistryIds, mentionTrigger]);

  const startAppConnect = React.useCallback(async (app: MentionPickerApp) => {
    const plan = resolveConnectPlan({ id: app.id, name: app.name, domain: app.domain })
    if (plan.kind !== "oauth") {
      toast.message(MENTION_COPY.unavailableDetail(app.name))
      return { status: "unavailable" as const, markConnected: false, message: MENTION_COPY.unavailableDetail(app.name) }
    }
    const token = typeof window !== "undefined" ? window.localStorage.getItem("auth-token") : null
    const result = await connectGptStoreApp(
      { id: app.id, name: app.name, domain: app.domain },
      {
        isAuthenticated: Boolean(user || token),
        loginNext: typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search || ""}` || "/agentes"
          : "/agentes",
        requireLogin: (next) => {
          if (typeof window !== "undefined") {
            window.location.href = `/auth/login?next=${encodeURIComponent(next || "/agentes")}`
          }
        },
        fetchJson: async (requestPath) => {
          const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}${requestPath}`, {
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(20_000),
          })
          const body = await res.json().catch(() => ({})) as Record<string, unknown>
          return { ok: res.ok, status: res.status, body }
        },
        ensureComputer: async () => ({ conversationBound: false }),
        navigateComputer: async () => undefined,
        createConversation: async () => ({ id: "" }),
        openComputerOverlay: () => undefined,
      },
    )
    if (result.redirectUrl) {
      toast.message(result.message)
      window.location.href = result.redirectUrl
      return result
    }
    if (result.status === "computer_opened") {
      toast.message(MENTION_COPY.unavailableDetail(app.name))
      return result
    }
    if (result.status !== "oauth_started") {
      toast.error(result.message)
    }
    return result
  }, [user])

  const handleAppsMentionPick = React.useCallback(async (app: MentionPickerApp) => {
    setMentionMenuOpen(false)
    if (app.status === "connected") {
      const next = insertMention(input, mentionTrigger, app.name)
      setSelectedMentionIds((prev) => (prev.includes(app.id) ? prev : [...prev, app.id]))
      setInput(next)
      chatDraft.save(next)
      window.setTimeout(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const caret = next.length
        try { el.setSelectionRange(caret, caret) } catch { /* old Safari */ }
      }, 0)
      return
    }
    if (app.status === "connect") {
      await startAppConnect(app)
      return
    }
    toast.message(MENTION_COPY.unavailableDetail(app.name))
  }, [chatDraft, input, mentionTrigger, startAppConnect]);

  const detectedLinks = React.useMemo(() => extractDetectedLinks(input), [input]);
  const hasDetectedLinks = detectedLinks.length > 0;

  const syncComposerHighlightScroll = React.useCallback((textarea: HTMLTextAreaElement | null = textareaRef.current) => {
    const overlay = composerHighlightOverlayRef.current;
    if (!overlay || !textarea) return;
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  }, []);

  const handleComposerTextareaScroll = React.useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
    syncComposerHighlightScroll(event.currentTarget);
  }, [syncComposerHighlightScroll]);

  React.useEffect(() => {
    syncComposerHighlightScroll();
  }, [input, hasDetectedLinks, syncComposerHighlightScroll]);

  const syncChatLayoutVars = React.useCallback(() => {
    const root = chatViewportRef.current;
    if (!root) return;

    const setPx = (name: string, value: number) => {
      const roundedValue = Math.max(0, Math.ceil(value));
      if (chatLayoutVarsRef.current[name] === roundedValue) return;
      chatLayoutVarsRef.current[name] = roundedValue;
      root.style.setProperty(name, `${roundedValue}px`);
    };

    setPx("--chat-header-height", chatHeaderRef.current?.getBoundingClientRect().height || 64);
    setPx("--chat-composer-height", chatComposerDockRef.current?.getBoundingClientRect().height || 96);
    setPx("--chat-textarea-max-height", textareaRef.current?.clientHeight || 36);
  }, []);

  const setComposerInputFocused = React.useCallback((focused: boolean) => {
    const root = chatViewportRef.current;
    if (!root) return;
    root.dataset.chatInputFocused = focused ? "true" : "false";
  }, []);

  const applyComposerTextareaMetrics = React.useCallback((
    textarea: HTMLTextAreaElement,
    scrollHeight: number,
    maxHeight: number,
    currentlyStacked = false,
  ) => {
    const measured = measureComposerTextarea({
      scrollHeight,
      minHeight: composerExpanded ? COMPOSER_TEXTAREA_EXPANDED_MIN_PX : COMPOSER_TEXTAREA_MIN_PX,
      maxHeight,
      hasExplicitNewline: textarea.value.includes("\n"),
      charCount: textarea.value.length,
      currentlyStacked: currentlyStacked || composerExpanded,
    });
    const shell = textarea.closest(".composer-textarea-shell") as HTMLElement | null;
    const surface = textarea.closest("[data-testid='chat-composer-surface']") as HTMLElement | null;

    textarea.style.height = `${measured.height}px`;
    textarea.style.setProperty("overflow-y", measured.overflowY, "important");
    if (shell) {
      shell.style.height = `${measured.height}px`;
    }
    if (surface) {
      const stackedValue = (composerExpanded || measured.stacked) ? "true" : "false";
      if (surface.dataset.composerStacked !== stackedValue) {
        surface.dataset.composerStacked = stackedValue;
      }
    }
    return composerExpanded ? { ...measured, stacked: true } : measured;
  }, [composerExpanded]);

  const resizeComposerTextarea = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Grow with content (Claude/ChatGPT control-bar rhythm) up to the CSS
    // max-height, then scroll internally so the surface stays professional.
    // When the prompt wraps, pin the model picker to the footer so the
    // capsule captures the full draft instead of clipping it beside the chip.
    const computedMax = Number.parseFloat(
      window.getComputedStyle(textarea).maxHeight || "0",
    );
    const maxHeight = Number.isFinite(computedMax) && computedMax > 0
      ? computedMax
      : 200;

    const surface = textarea.closest("[data-testid='chat-composer-surface']") as HTMLElement | null;
    const currentlyStacked = surface?.dataset.composerStacked === "true";
    textarea.style.height = "0px";
    let contentScrollHeight = textarea.scrollHeight;
    let measured = applyComposerTextareaMetrics(
      textarea,
      contentScrollHeight,
      maxHeight,
      currentlyStacked,
    );

    // Switching to the stacked grid changes the textarea width, so remasure
    // height after the footer layout is applied. Keep the stacked decision
    // from the first pass so a wider line cannot collapse the toolbar.
    if (measured.stacked) {
      textarea.style.height = "0px";
      contentScrollHeight = textarea.scrollHeight;
      const restacked = applyComposerTextareaMetrics(
        textarea,
        contentScrollHeight,
        maxHeight,
        true,
      );
      measured = { ...restacked, stacked: true };
      if (surface) surface.dataset.composerStacked = "true";
    }

    const previousLayout = textareaLayoutRef.current;
    const heightChanged = previousLayout.height !== measured.height;
    const overflowChanged = previousLayout.overflowY !== measured.overflowY;
    if (heightChanged || overflowChanged) {
      textareaLayoutRef.current = { height: measured.height, overflowY: measured.overflowY };
    }
    if (measured.overflowY === "auto" && document.activeElement === textarea) {
      textarea.scrollTop = textarea.scrollHeight;
    }

    const nextOverflow = shouldShowComposerExpandControl({
      scrollHeight: contentScrollHeight,
      clientHeight: textarea.clientHeight,
      minHeight: COMPOSER_TEXTAREA_MIN_PX,
      value: textarea.value,
    });
    setComposerTextOverflows((prev) => (prev === nextOverflow ? prev : nextOverflow));

    syncChatLayoutVars();
  }, [applyComposerTextareaMetrics, syncChatLayoutVars]);

  const scheduleComposerTextareaResize = React.useCallback(() => {
    if (composerResizeFrameRef.current !== null) return;
    composerResizeFrameRef.current = window.requestAnimationFrame(() => {
      composerResizeFrameRef.current = null;
      resizeComposerTextarea();
    });
  }, [resizeComposerTextarea]);

  React.useEffect(() => {
    return () => {
      if (composerResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(composerResizeFrameRef.current);
        composerResizeFrameRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    scheduleComposerTextareaResize();
  }, [composerExpanded, scheduleComposerTextareaResize]);

  // Handle textarea input change with smooth scrolling
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    // Persist the in-progress draft per chat (debounced inside the hook).
    chatDraft.save(value);
  };

  // Insert text at the textarea caret (replacing any selection), keeping
  // the draft, internal scroll position and caret position consistent.
  // Used by the universal paste router for orchestrated (non-native)
  // insertions: markdown from rich HTML, link URLs, multi-item pastes.
  const insertTextAtCaret = React.useCallback((snippet: string) => {
    if (!snippet) return;
    const ta = textareaRef.current;
    if (!ta) {
      setInput(prev => (prev ? `${prev}\n\n${snippet}` : snippet));
      return;
    }
    const prevValue = ta.value;
    const start = ta.selectionStart ?? prevValue.length;
    const end = ta.selectionEnd ?? start;
    const next = prevValue.slice(0, start) + snippet + prevValue.slice(end);
    setInput(next);
    chatDraft.save(next);
    window.requestAnimationFrame(() => {
      resizeComposerTextarea();
      const caret = start + snippet.length;
      try { ta.setSelectionRange(caret, caret); } catch { /* old Safari */ }
      ta.focus();
    });
  }, [chatDraft, resizeComposerTextarea]);

  const handleTextareaFocus = React.useCallback(() => {
    setComposerInputFocused(true);
    resizeComposerTextarea();
    window.requestAnimationFrame(() => {
      syncChatLayoutVars();
      scrollToBottom();
    });
    window.setTimeout(() => {
      syncChatLayoutVars();
      scrollToBottom();
    }, 120);
  }, [resizeComposerTextarea, scrollToBottom, setComposerInputFocused, syncChatLayoutVars]);

  const handleTextareaBlur = React.useCallback(() => {
    window.setTimeout(() => {
      if (document.activeElement === textareaRef.current) return;
      setComposerInputFocused(false);
      syncChatLayoutVars();
    }, 120);
  }, [setComposerInputFocused, syncChatLayoutVars]);

  React.useEffect(() => {
    scheduleComposerTextareaResize();
  }, [input, scheduleComposerTextareaResize]);

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

      const request = await apiClient.prepareMutatingFetch({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await authenticatedFetch('/api/payments/instant', request);

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
        toast.error('Tu plan necesita una mejora para continuar.');
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

  const handleToggleSplitView = React.useCallback((content: any) => {
    setDocumentPreviewUrl(null)
    setComposerPreviewIndex(null)
    setSidePreviewAttachment(null)
    setSidePreviewSiblings([])
    setSplitViewContent(content)
  }, [])

  const handleDocumentPreview = React.useCallback((url: DocumentPreviewTarget) => {
    setSplitViewContent(null)
    setSourcesPanelData(null)
    setComposerPreviewIndex(null)
    setSidePreviewAttachment(null)
    setSidePreviewSiblings([])
    setSplitRatio((current) => {
      const balanced = current < 40 || current > 62 ? 48 : current
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(balanced)); } catch { /* ignore */ }
      return balanced
    })
    setDocumentPreviewUrl(url);
  }, []);

  const handleAttachmentPreview = React.useCallback((attachment: AttachmentLike, siblings: AttachmentLike[] = [], index = 0) => {
    setSplitViewContent(null);
    setDocumentPreviewUrl(null);
    setSourcesPanelData(null);
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

  // Open the integrated "Fuentes" pane for a message. Mirrors
  // handleDocumentPreview: clears the other right-pane tenants (so the pane
  // isn't suppressed by a stale viewer), rebalances the split, and stores the
  // message's sources. The reverse direction (closing Fuentes when another
  // pane opens) is enforced by the mutual-exclusion effect below.
  const handleOpenSources = React.useCallback((payload: { sources: any[]; activity: any; memory?: any[]; memoryMeta?: any; messageId?: string }) => {
    const hasSources = Array.isArray(payload?.sources) && payload.sources.length > 0;
    const hasMemory = Array.isArray(payload?.memory) && payload.memory.length > 0;
    if (!payload || (!hasSources && !hasMemory)) return;
    setSplitViewContent(null);
    setDocumentPreviewUrl(null);
    setComposerPreviewIndex(null);
    setSidePreviewAttachment(null);
    setSidePreviewSiblings([]);
    setActiveSearchActivityId(null);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    try { closeArtifactPanel(); } catch { /* ignore */ }
    setShowAudioPanel(false);
    setSplitRatio((current) => {
      const balanced = current < 40 || current > 62 ? 48 : current;
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(balanced)); } catch { /* ignore */ }
      return balanced;
    });
    setSourcesPanelData(payload);
  }, [closeArtifactPanel, setShowAudioPanel]);

  // ── Bifurcar conversación ───────────────────────────────────────────────
  // Forks the current chat into a brand-new conversation containing a copy of
  // every message up to AND including the one the user branched from. The
  // original chat is left untouched, so the user can explore an alternate
  // direction without losing context — git-style branching applied to a
  // conversation tree. Powered by the existing createChat + addMessage
  // endpoints; no new backend needed. Reads live state from refs so the
  // callback stays identity-stable (the memoized MessageComponent ignores
  // callback prop changes).
  const branchMessage = React.useCallback(async (messageId: string) => {
    const chat = currentChatRef.current;
    const msgs: any[] = chat?.messages || [];
    const idx = msgs.findIndex((m) => m?.id === messageId);
    if (idx < 0) {
      toast.error("No se pudo bifurcar: mensaje no encontrado");
      return;
    }
    const slice = msgs.slice(0, idx + 1).filter((m) => m && (m.content || m.files));
    if (slice.length === 0) {
      toast.error("No hay contenido para bifurcar");
      return;
    }

    const baseTitle = (chat?.title || "Conversación").slice(0, 40);
    const toastId = toast.loading("Bifurcando conversación…");
    try {
      const created = await apiClient.createChat({
        title: `${baseTitle} (rama)`,
        model: chat?.model || selectedModelRef.current,
      });
      const newChat = created?.chat || created;
      const newChatId = newChat?.id;
      if (!newChatId) throw new Error("createChat no devolvió id");

      for (const m of slice) {
        let files: string[] | undefined;
        try {
          if (Array.isArray(m.files)) files = m.files;
          else if (typeof m.files === "string" && m.files.trim().startsWith("[")) files = JSON.parse(m.files);
        } catch { /* non-fatal: forks can drop unparseable file refs */ }
        await apiClient.addMessage(newChatId, {
          role: String(m.role || "USER").toUpperCase(),
          content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
          files,
          metadata: serializeBranchedMessageMetadata(m.metadata),
        });
      }

      await selectChat(newChatId);
      toast.success("Conversación bifurcada", {
        id: toastId,
        description: `${slice.length} mensaje${slice.length === 1 ? "" : "s"} copiado${slice.length === 1 ? "" : "s"} a la nueva rama`,
      });
    } catch (err: any) {
      console.error("[branch] failed:", err);
      toast.error("No se pudo bifurcar la conversación", {
        id: toastId,
        description: err?.message || "Inténtalo de nuevo",
      });
    }
  }, [selectChat]);

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
      const r = await copyTextSafe(url);
      toast.success(r.ok
        ? "Enlace para compartir copiado"
        : "Enlace para compartir creado (no se pudo copiar automáticamente)");
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
    const SpeechRecognition = getSpeechRecognitionCtor(window as any);

    if (SpeechRecognition) {
      setIsSpeechSupported(true);
      const recognition = new (SpeechRecognition as any)();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = resolveDictationLanguage({
        languages: navigator.languages,
        language: navigator.language,
        documentLang: document.documentElement.lang,
      });

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
        if (isIgnorableSpeechError(event.error)) {
          return;
        }

        if (
          (isSpeechPermissionError(event.error) || event.error === "network")
          && !dictationNativeFallbackStartedRef.current
        ) {
          dictationNativeFallbackStartedRef.current = true;
          dictationWantListeningRef.current = false;
          toast.info("El dictado nativo no se activó. Usaré grabación y transcripción al detener.");
          void startRecorderDictation();
          return;
        }

        if (isSpeechPermissionError(event.error)) {
          toast.error("El micrófono está bloqueado. Actívalo en los permisos del navegador y vuelve a intentarlo.");
        } else {
          toast.error("No se pudo iniciar el dictado. Inténtalo de nuevo.");
        }
        dictationWantListeningRef.current = false;
        dictationModeRef.current = "idle";
        setIsRecording(false);
      };

      recognition.onend = () => {
        if (dictationModeRef.current === "recorder") return;

        if (shouldRestartNativeDictation(dictationModeRef.current, dictationWantListeningRef.current)) {
          try {
            recognition.start();
            return;
          } catch (error: any) {
            if (error?.name === "InvalidStateError") return;
          }
        }

        const committedDraft = buildDictationDraft(dictationInterimRef.current);
        if (committedDraft) {
          setInput(committedDraft);
          inputRef.current = committedDraft;
        }
        resetDictationTranscript();
        dictationWantListeningRef.current = false;
        dictationModeRef.current = "idle";
        setIsRecording(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      dictationWantListeningRef.current = false;
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (dictationMediaRecorderRef.current?.state === "recording") {
        dictationShouldTranscribeRecordingRef.current = false;
        dictationMediaRecorderRef.current.stop();
      }
    };
  }, [buildDictationDraft, normalizeDictationText, resetDictationTranscript, startRecorderDictation]);

  const handleMicClick = () => {
    const recognition = recognitionRef.current;

    if (isDictationTranscribing) return;

    if (isRecording) {
      dictationWantListeningRef.current = false;
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
    dictationNativeFallbackStartedRef.current = false;

    if (!recognition) {
      void startRecorderDictation();
      return;
    }

    try {
      dictationModeRef.current = "native";
      dictationWantListeningRef.current = true;
      recognition.start();
      setIsRecording(true);
    } catch (error: any) {
      if (error?.name === "InvalidStateError") {
        dictationWantListeningRef.current = true;
        setIsRecording(true);
        return;
      }

      console.error("Speech recognition start error:", error);
      dictationWantListeningRef.current = false;
      toast.info("El dictado nativo no inició. Usaré grabación y transcripción al detener.");
      void startRecorderDictation();
    }
  };

  // Composer model selector (Claude-style), rendered inline in the right action
  // cluster next to the mic.
  const renderComposerModelControls = () => {
    if (isMediaToolActive) return null
    return (
      <div className="composer-model-inline flex min-w-0 max-w-[min(52vw,15rem)] shrink items-center justify-end">
        <NavbarModelSelector
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          availableModels={availableModels}
          setSelectedProvider={setSelectedProivder}
          chatTypes={chatType}
          currentChat={currentChat}
          setCurrentChat={setCurrentChat}
          selectedEffort={selectedEffort}
          setSelectedEffort={setSelectedEffort}
        />
      </div>
    )
  }

  // No `title` on the button: the Radix tooltip below is the hover affordance
  // and carries richer copy (it warns when the browser has no speech support).
  // A native title would race it and win with weaker, contradictory text.
  const renderDictationButton = () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleMicClick}
          disabled={isDictationTranscribing}
          aria-label={isDictationTranscribing ? "Transcribiendo dictado" : isRecording ? "Detener dictado" : "Dictar al chat"}
          aria-pressed={isRecording}
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
                className="composer-mic-pulse pointer-events-none absolute inset-0 rounded-full bg-red-500/30 animate-ping"
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

  const renderChatComposer = () => (
    <ChatComposerSurface
      layout="stacked"
      expanded={composerExpanded}
      overlayVisible={pasteCapture.overlayVisible}
      overlay={pasteCapture.Overlay}
      slashMenu={
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
      }
      mentionMenu={
        <AppsMentionPicker
          open={mentionMenuOpen && !slashMenuOpen}
          filter={mentionTrigger?.query || ""}
          apps={mentionPickerApps}
          onPick={(app) => { void handleAppsMentionPick(app); }}
          onClose={() => {
            setMentionMenuOpen(false);
            setMentionTrigger(null);
          }}
        />
      }
      contextTray={
        <>
          <ActiveOptionsDisplay
            uploadedFiles={uploadedFiles}
            removeFile={removeFile}
            uploadProgress={uploadProgress}
            retryUpload={retryUpload}
            restoreLongPasteToInput={restoreLongPasteToInput}
            moveFile={moveFile}
            onPreviewAttachment={handleComposerAttachmentPreview}
            onFileProcessingStatusChange={handleFileProcessingStatusChange}
          />
          <SelectedTextDisplay text={selectedWordText} onClear={() => setSelectedWordText(null)} />
        </>
      }
      leading={
        <>
          <ActionsDropdown {...actionsDropdownProps} />
          {shouldInlineActiveTools && (
            <div className="composer-inline-active-tools">
              <ActiveToolsDisplay {...activeToolsProps} />
            </div>
          )}
        </>
      }
      textarea={
        <div className={cn("composer-textarea-shell min-w-0 flex-1", composerShowExpand && "has-expand-control")}>
          {composerShowExpand ? (
            <button
              type="button"
              onClick={expandComposer}
              aria-pressed={composerExpanded}
              aria-label={composerExpanded ? "Contraer" : "Ampliar"}
              title={composerExpanded ? "Contraer" : "Ampliar"}
              data-testid="chat-composer-expand"
              className="composer-expand-button"
            >
              {composerExpanded ? (
                <Minimize2 className="h-[14px] w-[14px]" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-[14px] w-[14px]" aria-hidden="true" />
              )}
            </button>
          ) : null}
          {hasDetectedLinks && input ? (
            <div
              ref={composerHighlightOverlayRef}
              className="composer-textarea-highlights textarea-scrollbar"
              aria-hidden="true"
            >
              <ComposerInlineLinkHighlights value={input} />
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onFocus={handleTextareaFocus}
            onBlur={handleTextareaBlur}
            onPaste={handleTextareaPaste}
            onScroll={handleComposerTextareaScroll}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            aria-label="Mensaje para SiraGPT"
            enterKeyHint="send"
            data-link-highlights={hasDetectedLinks ? "true" : undefined}
            placeholder={
              isImageGenerationActive
                ? tComposer("placeholderImage")
                : isVideoGenerationActive
                  ? tComposer("placeholderVideo")
                  : isVoiceGenerationActive
                    ? VOICE_COMPOSER_PLACEHOLDER
                    : isMusicGenerationActive
                      ? "Describe la música que quieres crear"
                      : isWebSearchActive
                        ? tComposer("placeholderWebSearch")
                        : isComputerUseActive
                          ? tComposer("placeholderComputer")
                          : isGmailActive
                            ? tComposer("placeholderGmail")
                            : (isGoogleCalendarActive || isGoogleDriveActive)
                              ? tComposer("placeholderGoogle")
                              : isSpotifyActive
                                ? tComposer("placeholderSpotify")
                                : isWordConnectorActive
                                  ? tComposer("placeholderWord")
                                  : isWorkModeActive
                                    ? "Describe el resultado que quieres obtener"
                                    : tComposer("placeholderDefault")
            }
            className={cn(
              "composer-textarea textarea-scrollbar min-h-[24px] min-w-0 w-full resize-none border-none bg-transparent",
              "p-0",
              "text-[15px] leading-[1.5] tracking-normal text-foreground",
              "placeholder:text-muted-foreground/65 placeholder:font-normal",
              "dark:placeholder:text-[hsl(var(--text-tertiary))]",
              "outline-none ring-0 focus:outline-none focus:ring-0",
              "rounded-none transition-colors duration-200",
            )}
            style={{
              minHeight: composerExpanded ? "8.5rem" : "26px",
              maxHeight: composerExpanded ? "min(18rem, 52vh)" : "min(12.5rem, 42vh)",
              overflowY: "hidden",
              overflowX: "hidden",
              wordWrap: "break-word",
              border: "none",
              outline: "none",
              boxShadow: "none",
            }}
            rows={1}
          />
        </div>
      }
      toolbar={
        <div className="composer-toolbar-actions flex shrink-0 items-center gap-1.5">
          <ComposerCharCounter input={input} />
          {renderComposerModelControls()}
          {!isStopButtonVisible && (
            renderDictationButton()
          )}
          <ChatComposerPrimaryAction
            input={input}
            hasAttachment={uploadedFiles.length > 0}
            requiresPromptBeforePrimarySend={requiresPromptBeforePrimarySend}
            busy={isCurrentChatLocalJobBusy || isUploading}
            isStopButtonVisible={isStopButtonVisible}
            shouldPrioritizeStopButton={shouldPrioritizeStopButton}
            pendingStop={pendingStop}
            isCurrentChatStreaming={isCurrentChatStreaming}
            onSend={handleSend}
            onStop={stopActiveGeneration}
            onVoice={isSpeechSupported && !isDictationTranscribing ? handleMicClick : undefined}
            voiceRecording={isRecording}
          />
        </div>
      }
      footer={
        hasActiveTools && !shouldInlineActiveTools ? (
          <div className="composer-footer-active-tools flex items-center gap-1.5 sm:gap-2 overflow-x-auto">
            <ActiveToolsDisplay {...activeToolsProps} />
          </div>
        ) : null
      }
    />
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
      } else if (isGeneratingVoiceRef.current) {
        setIsVoiceGenerationActive(true);
        setChatType('text');
      } else if (isGeneratingMusicRef.current) {
        setIsMusicGenerationActive(true);
        setChatType('text');
      } else if (isGeneratingVideoRef.current || isVideoGenerationActiveRef.current) {
        isVideoGenerationActiveRef.current = true;
        setIsVideoGenerationActive(true);
        setChatType('video');
        closeAllToolsAndConnectors({ preserveWebSearch: isWebSearchActiveRef.current, preserveVideo: true });
      } else {
        closeAllToolsAndConnectors({ preserveWebSearch: isWebSearchActiveRef.current });
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
    } else if (isGeneratingVoiceRef.current) {
      setIsVoiceGenerationActive(true);
      setChatType('text');
    } else if (isGeneratingMusicRef.current) {
      setIsMusicGenerationActive(true);
      setChatType('text');
    } else if (isGeneratingVideoRef.current || isVideoGenerationActiveRef.current) {
      isVideoGenerationActiveRef.current = true;
      setIsVideoGenerationActive(true);
      setChatType('video');
      closeAllToolsAndConnectors({ preserveWebSearch: isWebSearchActiveRef.current, preserveVideo: true });
    } else {
      closeAllToolsAndConnectors({ preserveWebSearch: isWebSearchActiveRef.current });
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
      autoVideoActivationRef.current = false;
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
      ? conversationIdFromLocation(window.location.pathname, window.location.search)
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

    // Picker selections used to bypass the same client-side gate that
    // drag/drop and paste already use. Validate here as the single final
    // preflight so known-bad files (for example Office ~$ lock files) are
    // explained immediately and never become failed retry chips.
    const { accepted, rejected } = validateBatch(filesToUpload, {
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
    if (accepted.length === 0) return;
    filesToUpload = accepted;

    // Content-hash dedup — the same bytes can't be attached twice in a
    // conversation. Hashing must never block an upload, so any failure
    // falls through to "no dedup" silently.
    let batchHashes: Map<File, string> | null = null;
    try {
      const { unique, duplicates, hashes } = await dedupeFiles(filesToUpload, attachmentHashesRef.current);
      if (duplicates.length > 0) {
        toast.info(duplicates.length === 1
          ? `"${duplicates[0].name}" ya está adjunto — duplicado omitido.`
          : `${duplicates.length} archivos duplicados omitidos.`);
      }
      if (unique.length === 0) return;
      filesToUpload = unique;
      batchHashes = hashes;
    } catch { /* hash dedup is best-effort */ }

    // Idempotency key — backend dedupes retries of the SAME batch attempt.
    const idempotencyKey = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Build temp objects with stable IDs we can map to per-file progress.
    const tempFiles = filesToUpload.map((file) => {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const preview = /^(image|audio|video)\//.test(file.type) ? URL.createObjectURL(file) : null;
      const longPasteMeta = getLongPasteMetadata(file);
      const contentHash = batchHashes?.get(file) || null;
      if (contentHash) {
        attachmentHashesRef.current.add(contentHash);
        attachmentHashByIdRef.current.set(tempId, contentHash);
      }
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
        mediaMeta: null as null | { durationSeconds?: number; peaks?: number[]; thumbnailDataUrl?: string | null },
        status: 'uploading' as 'uploading' | 'ready' | 'failed',
      };
    });

    setUploadedFiles((cur: any[]) => {
      const next = [...cur, ...tempFiles];
      uploadedFilesRef.current = next;
      return next;
    });

    // Best-effort media metadata: mini-waveform + duration for audio,
    // thumbnail + duration badge for video. Fire-and-forget; the chip
    // upgrades in place when (and if) extraction succeeds.
    tempFiles.forEach((tf) => {
      const mime = tf.type || '';
      const applyMediaMeta = (meta: { durationSeconds?: number; peaks?: number[]; thumbnailDataUrl?: string | null } | null) => {
        if (!meta) return;
        tf.mediaMeta = { ...(tf.mediaMeta || {}), ...meta };
        setUploadedFiles((cur: any[]) => {
          const next = cur.map(f => (f.tempId === tf.tempId ? { ...f, mediaMeta: tf.mediaMeta } : f));
          uploadedFilesRef.current = next;
          return next;
        });
      };
      if (mime.startsWith('audio/')) {
        void extractAudioMeta(tf.file).then(applyMediaMeta).catch(() => {});
      } else if (mime.startsWith('video/')) {
        void extractVideoMeta(tf.file).then(applyMediaMeta).catch(() => {});
      }
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

      const uploadChunks = buildComposerUploadChunks(filesToUpload, tempFiles);
      let failedChunkCount = 0;

      for (let chunkIndex = 0; chunkIndex < uploadChunks.length; chunkIndex += 1) {
        const chunk = uploadChunks[chunkIndex];
        const chunkTemps = chunk.temps;
        const chunkTempIds = new Set(chunkTemps.map(tf => tf.tempId));

        try {
          // Real upload progress via XHR (see lib/api.ts uploadFiles).
          // Large selections are split into bounded multipart requests so
          // 400 documents do not exceed the edge/body-size guard.
          const response: any = await apiClient.uploadFiles(filesToFileList(chunk.files), {
            sourceChannel,
            idempotencyKey: `${idempotencyKey}-${chunkIndex + 1}`,
            asyncProcessing: true,
            onProgress: (pct) => {
              setUploadProgress(prev => {
                const next = { ...prev };
                chunkTemps.forEach(tf => { next[tf.tempId] = Math.max(next[tf.tempId] || 0, pct); });
                return next;
              });
            },
          });

          if (!response.files) {
            failedChunkCount += 1;
            setUploadedFiles((cur: any[]) => {
              const next = cur.map(f => chunkTempIds.has(f.tempId) ? { ...f, status: 'failed', uploadError: 'Respuesta sin archivos' } : f);
              uploadedFilesRef.current = next;
              return next;
            });
            toast.error('La subida falló. Toca el ícono de reintento en el archivo.');
            continue;
          }

          // Snap this sub-batch to 100% and swap temps for server entries.
          setUploadProgress(prev => {
            const next = { ...prev };
            chunkTemps.forEach(tf => { next[tf.tempId] = 100; });
            return next;
          });
          const failedServerFiles = response.files.filter((f: any) => f?.success === false);
          if (failedServerFiles.length > 0) {
            failedChunkCount += 1;
            const grouped: Record<string, number> = {};
            failedServerFiles.forEach((f: any) => {
              const reason = f?.error || 'No se pudo procesar el archivo.';
              grouped[reason] = (grouped[reason] || 0) + 1;
            });
            Object.entries(grouped).forEach(([reason, n]) => {
              toast.error(n > 1 ? `${reason} (${n} archivos)` : reason);
            });
          }
          const merged = response.files.map((f: any, idx: number) => {
            const failed = f?.success === false;
            const processingStage = f?.processingStage || f?.stage || null;
            return {
              ...f,
              // Keep the tempId so chip identity (animations, hash bookkeeping,
              // cancel tracking) survives the temp → server swap.
              tempId: chunkTemps[idx]?.tempId ?? f.tempId,
              file: chunkTemps[idx]?.file ?? f.file,
              preview: chunkTemps[idx]?.preview ?? f.preview,
              sourceChannel,
              longPasteMeta: chunkTemps[idx]?.longPasteMeta ?? f.longPasteMeta,
              isLongPasteDocument: chunkTemps[idx]?.isLongPasteDocument || Boolean(f.isLongPasteDocument),
              mediaMeta: chunkTemps[idx]?.mediaMeta ?? f.mediaMeta ?? null,
              processingStage,
              status: failed
                ? ('failed' as const)
                : isActiveProcessingStage(processingStage)
                  ? ('processing' as const)
                  : ('ready' as const),
              uploadError: failed ? (f?.error || 'No se pudo procesar el archivo.') : f?.uploadError,
            };
          // A chip removed while its upload was in flight acts as CANCEL —
          // do not resurrect it when the XHR completes.
          }).filter((m: any, idx: number) => !cancelledTempIdsRef.current.has(chunkTemps[idx]?.tempId));
          setUploadedFiles((cur: any[]) => {
            const next = [
              ...cur.filter((f: any) => !chunkTempIds.has(f.tempId)),
              ...merged,
            ];
            uploadedFilesRef.current = next;
            return next;
          });
          chunkTemps.forEach((tf, idx) => {
            const mergedFile = merged[idx];
            if (!mergedFile || !(tf.file instanceof File) || !String(tf.type || "").startsWith("image/")) return;
            void recognizeImageWithRetry(tf.file).then((ocr) => {
              if (!ocr.text) return;
              setUploadedFiles((cur: any[]) => {
                const next = cur.map((f: any) =>
                  f.tempId === tf.tempId
                    ? {
                        ...f,
                        extractedText: ocr.text,
                        ocr: {
                          ...(f.ocr || {}),
                          confidence: ocr.confidence,
                          provider: "tesseract.js",
                          clientPreprocess: true,
                          retries: ocr.retries,
                        },
                      }
                    : f
                );
                uploadedFilesRef.current = next;
                return next;
              });
            }).catch(() => {});
          });

          setTimeout(() => {
            setUploadProgress(prev => {
              const next = { ...prev };
              chunkTemps.forEach(tf => { delete next[tf.tempId]; });
              return next;
            });
          }, 500);
        } catch (chunkError: any) {
          failedChunkCount += 1;
          console.error('File upload chunk failed:', chunkError);
          const reason = chunkError?.message || 'Error de subida';
          setUploadedFiles((cur: any[]) => {
            const next = cur.map(f => chunkTempIds.has(f.tempId) ? { ...f, status: 'failed', uploadError: reason } : f);
            uploadedFilesRef.current = next;
            return next;
          });
          toast.error(reason);
        }
      }

      if (filesToUpload.length >= 25 && failedChunkCount === 0) {
        toast.success(`${filesToUpload.length} archivos recibidos. SiraGPT los analizará en segundo plano.`);
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
      setUploadProgress(prev => {
        const next = { ...prev };
        tempFiles.forEach(tf => { delete next[tf.tempId]; });
        return next;
      });
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

    // ─── No files — route by content through the universal router ────
    if (files.length === 0) {
      // HTML-only flavors (rare) still need a plain-text mirror so the
      // router can apply the long-paste threshold and URL detection.
      let htmlFallbackText: string | null = null;
      if (!text && html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        htmlFallbackText = (tmp.textContent || tmp.innerText || '').trim();
      }
      const effectiveText = (text && text.trim()) ? text : htmlFallbackText;
      const uriList = cd.getData('text/uri-list') || null;

      let actions: ReturnType<typeof routePaste> = [];
      try {
        actions = routePaste(
          { text: effectiveText, html, uriList },
          {
            longTextThreshold: LONG_PASTE_CHIP_THRESHOLD,
            resolveKind: (mime, name) => defaultAttachmentRegistry.resolve(mime, name).kind,
          },
        );
      } catch {
        // Router failure must never eat a paste — native fallback.
        return;
      }
      if (actions.length === 0) return;

      // A single plain-text insert keeps the NATIVE paste (caret-aware,
      // selection-replacing, undo-friendly). Everything else — snippet
      // chips, Word/Docs Markdown, link inserts, multi-action pastes — is
      // orchestrated by us.
      if (actions.length === 1 && actions[0].type === 'insert-text') return;

      e.preventDefault();
      for (const action of actions) {
        switch (action.type) {
          case 'insert-text':
            insertTextAtCaret(action.text);
            break;
          case 'link-chip':
            // URLs stay in the editable text. The composer paints detected
            // URLs inline with a subtle link color instead of creating a
            // separate preview row above the conversation.
            insertTextAtCaret(`${action.url} `);
            break;
          case 'text-snippet-chip':
            // "PEGADO" chip — long pasted text becomes an expandable,
            // removable .txt attachment to keep the bar clean.
            handlePasteCaptureActionRef.current('attach_document', analyzePastedContent(action.text));
            break;
          case 'rich-html': {
            // Word / Google Docs rich paste → sanitized Markdown that
            // preserves bold, lists and tables. Falls back to plain text.
            let content = '';
            try { content = htmlToMarkdown(action.html); } catch { content = ''; }
            if (!content.trim()) content = action.plainText || '';
            content = content.trim();
            if (!content) break;
            if (content.length > LONG_PASTE_CHIP_THRESHOLD) {
              handlePasteCaptureActionRef.current('attach_document', analyzePastedContent(content));
            } else {
              insertTextAtCaret(content);
            }
            break;
          }
          default:
            break;
        }
      }
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
      if (text) insertTextAtCaret(text);
      handleAndUploadFiles(filesToFileList(accepted), channel);
    }
  }, [handleAndUploadFiles, insertTextAtCaret]);

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
  const pendingMsgQueueRef = React.useRef<PersistedComposerQueueItem[]>([]);
  const queueBurstTimestampsRef = React.useRef<number[]>([]);
  const handleSendRef = React.useRef<() => Promise<void>>(async () => {});
  const queuedComposerSendRef = React.useRef<PersistedComposerQueueItem | null>(null);
  const queuedSendSucceededRef = React.useRef<Map<string, boolean>>(new Map());
  const queueDrainClaimsRef = React.useRef<Set<string>>(new Set());
  const hydratedQueueOwnerRef = React.useRef("");
  const queueOwnerId = user?.id ? String(user.id) : "";
  // Reactive mirror of the per-chat queued-message count so the composer can
  // SHOW the user that their extra tasks (sent while the agent is thinking)
  // are queued and will run in order. The ref above is the source of truth;
  // this state just drives the visible "N en cola" chip.
  const [queuedCount, setQueuedCount] = React.useState(0);
  const [queueHydrationVersion, setQueueHydrationVersion] = React.useState(0);
  const syncQueuedCount = React.useCallback((chatId?: string | null) => {
    const cid = chatId ?? currentChatIdRef.current ?? null;
    setQueuedCount(pendingMsgQueueRef.current.filter((q) => q.chatId === cid).length);
  }, []);

  const persistComposerQueue = React.useCallback(() => {
    if (!queueOwnerId) return;
    writePersistedComposerQueue(queueOwnerId, pendingMsgQueueRef.current);
  }, [queueOwnerId]);

  const prevComposerChatIdRef = React.useRef<string | null>(currentChat?.id ?? null);
  React.useEffect(() => {
    const previousChatId = prevComposerChatIdRef.current;
    const nextChatId = currentChat?.id ?? null;
    prevComposerChatIdRef.current = nextChatId;
    if (!nextChatId || String(nextChatId).startsWith("temp-chat-")) return;
    const fromNewChat = previousChatId == null || String(previousChatId).startsWith("temp-chat-");
    if (!fromNewChat) return;
    const adopted = adoptUnboundComposerQueueItems(
      pendingMsgQueueRef.current,
      nextChatId,
      previousChatId,
    );
    if (!adopted.changed) return;
    pendingMsgQueueRef.current = adopted.items;
    persistComposerQueue();
    syncQueuedCount(nextChatId);
  }, [currentChat?.id, persistComposerQueue, syncQueuedCount]);

  // Hydrate tasks that the user explicitly queued while another turn was
  // running. Unlike a plain ref, this survives refreshes and browser restarts.
  React.useEffect(() => {
    if (!queueOwnerId) {
      pendingMsgQueueRef.current = [];
      queueDrainClaimsRef.current.clear();
      hydratedQueueOwnerRef.current = "";
      syncQueuedCount(currentChatIdRef.current);
      setQueueHydrationVersion((version) => version + 1);
      return;
    }
    const stored = readPersistedComposerQueue(queueOwnerId);
    if (hydratedQueueOwnerRef.current !== queueOwnerId) {
      queueDrainClaimsRef.current.clear();
    }
    const live = hydratedQueueOwnerRef.current === queueOwnerId
      ? pendingMsgQueueRef.current
      : [];
    const byId = new Map<string, PersistedComposerQueueItem>();
    for (const item of [...stored, ...live]) byId.set(item.id, item);
    pendingMsgQueueRef.current = Array.from(byId.values());
    hydratedQueueOwnerRef.current = queueOwnerId;
    persistComposerQueue();
    syncQueuedCount(currentChatIdRef.current);
    // Refs do not trigger effects. This version makes the drain effect observe
    // a queue restored from localStorage even if every busy flag stayed idle.
    setQueueHydrationVersion((version) => version + 1);
  }, [persistComposerQueue, queueOwnerId, syncQueuedCount]);

  React.useEffect(() => {
    syncQueuedCount(currentChat?.id ?? null);
  }, [currentChat?.id, syncQueuedCount]);

  const restoreLastQueuedMessage = React.useCallback(() => {
    const chatId = currentChatIdRef.current ?? null;
    const index = pendingMsgQueueRef.current
      .map((item) => item.chatId === chatId && !queueDrainClaimsRef.current.has(item.id))
      .lastIndexOf(true);
    if (index < 0) return;
    const [item] = pendingMsgQueueRef.current.splice(index, 1);
    if (!item) return;
    persistComposerQueue();
    syncQueuedCount(chatId);
    setInput(item.msg);
    chatDraft.save(item.msg);
    uploadedFilesRef.current = item.files;
    setUploadedFiles(item.files);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [chatDraft, persistComposerQueue, setUploadedFiles, syncQueuedCount]);

  const removeLastQueuedMessage = React.useCallback(() => {
    const chatId = currentChatIdRef.current ?? null;
    const index = pendingMsgQueueRef.current
      .map((item) => item.chatId === chatId && !queueDrainClaimsRef.current.has(item.id))
      .lastIndexOf(true);
    if (index < 0) return;
    pendingMsgQueueRef.current.splice(index, 1);
    persistComposerQueue();
    syncQueuedCount(chatId);
    toast.success("Tarea quitada de la cola");
  }, [persistComposerQueue, syncQueuedCount]);

  // ────────────────────────────────────────────────────────────
  // Sidebar auto-collapse — when the user turns on any composer tool
  // (connectors, web search, image/video/thesis, Voice Studio, etc.)
  // we collapse the left rail for a cleaner workspace. Never auto-
  // reopen; the user restores it via the floating PanelLeftOpen chip.
  // ────────────────────────────────────────────────────────────
  const { open: sidebarOpen, setOpen: setSidebarOpen, isMobile: isSidebarMobile, openMobile: sidebarOpenMobile, setOpenMobile: setSidebarOpenMobile } = useSidebar();

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
  const SEARCH_ACTIVITY_RIGHT_MIN_PX = 480;
  const SEARCH_ACTIVITY_RIGHT_MAX_PX = 640;
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
    () => uploadedFiles.map((f: any) => toDocumentViewerAttachmentWithProgress(f, uploadProgress)),
    [uploadedFiles, uploadProgress],
  );
  const composerPreviewAttachment = React.useMemo<AttachmentLike | null>(() => {
    if (composerPreviewIndex === null) return null;
    return composerPreviewSiblings[composerPreviewIndex] || null;
  }, [composerPreviewIndex, composerPreviewSiblings]);

  const openComposerDocumentPreview = React.useCallback((index: number) => {
    const file = uploadedFiles[index];
    if (!file) return;
    if (file.status === "uploading" || !canOpenComposerPreview({
      id: resolveUploadFileId(file),
      status: file.status,
    })) return;
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
  const handleComposerAttachmentPreview = React.useCallback((
    _attachment: AttachmentLike,
    _siblings: AttachmentLike[],
    index: number,
  ) => {
    openComposerDocumentPreview(index);
  }, [openComposerDocumentPreview]);

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
  // Streams progress events via SSE or persists scientific result cards.
  //
  // `/goal` remains a meta-action. `/research` creates or reuses a chat and
  // persists both the query and the scientific result card.
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
          const researchModel = clampDeepSeekModel(currentChatRef.current?.model || selectedModelRef.current)
          if (!researchModel) throw new Error("Selecciona un modelo antes de iniciar la investigación")
          const researchChat = await ensureResearchCommandChat({
            currentChat: currentChatRef.current,
            query,
            model: researchModel,
            createChat: (data) => apiClient.createChat(data),
            addMessage: (chatId, data) => apiClient.addMessage(chatId, data),
          })
          await selectChat(researchChat.id)
          // /research → one-shot POST over 16 sources; ask for a rich set and
          // free OA PDFs (Unpaywall, gated on SIRAGPT_RESEARCH_EMAIL server-side).
          const request = await apiClient.prepareMutatingFetch({
            method: "POST",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ query, limit: 25, unpaywall: true }),
          });
          const res = await authenticatedFetch(url, request);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          // Rank by citations (most-cited first) for the student; nulls last.
          const ranked = Array.isArray(data.papers)
            ? [...data.papers].sort(
                (a: any, b: any) => (Number(b?.citations) || 0) - (Number(a?.citations) || 0),
              )
            : [];
          const payload = {
            query,
            count: typeof data.count === "number" ? data.count : ranked.length,
            providers: Array.isArray(data.providers) ? data.providers : [],
            papers: ranked.slice(0, 25),
          };
          // Persist a rich, clear result card in the conversation instead of a
          // vanishing toast: an assistant message carrying a ```scientific-papers```
          // fenced block that MessageComponent renders as PapersResultCard.
          if (ranked.length > 0) {
            await apiClient.addMessage(researchChat.id, {
              role: "ASSISTANT",
              content: buildScientificPapersMessage(payload),
            })
            await selectChat(researchChat.id)
            toast.success(`📚 ${payload.count} artículos · ${payload.providers.length} fuentes`, {
              id: toastId,
              duration: 4000,
              description: "Ordenados por número de citas ↓",
            });
          } else {
            toast.error(`Sin resultados para “${query}”. Prueba términos en inglés o más específicos.`, {
              id: toastId,
              duration: 6000,
            });
          }
        } else {
          // /goal → SSE stream the agent phases
          const request = await apiClient.prepareMutatingFetch({
            method: "POST",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ query, depth: "standard" }),
          });
          const res = await authenticatedFetch(url, request);
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
            await copyTextSafe(lastReport.report);
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
  }, [selectChat]);

  const handleSend = async () => {
    const queuedSend = queuedComposerSendRef.current;
    queuedComposerSendRef.current = null;
    if (queuedSend) queuedSendSucceededRef.current.set(queuedSend.id, false);
    const markQueuedSendSucceeded = () => {
      if (queuedSend) queuedSendSucceededRef.current.set(queuedSend.id, true);
    };
    let composerFiles = queuedSend
      ? [...queuedSend.files]
      : uploadedFilesRef.current.length > 0
        ? [...uploadedFilesRef.current]
        : [...uploadedFiles];
    // Normalize before trim so zero-width chars don't sneak past the
    // "is it empty?" check, and so we can warn on catastrophic pastes.
    const normalized = normalizeChatInput(queuedSend?.msg ?? input);
    if (shouldWarnUser(normalized)) {
      toast.error(
        `El mensaje supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó al máximo permitido.`,
        { duration: 4500 },
      );
    }
    const rawMsg = normalized.value.trim();
    if (!rawMsg && composerFiles.length === 0) return;

    // If a send is already being processed FOR THIS CHAT, ignore accidental
    // double-submit. Keyed per chat so a stream running in another chat never
    // blocks sending here. The per-message idempotency key below handles retry
    // safety once the send payload has been built.
    const sendLatchKey = currentChat?.id ?? '__new__';

    // ── Slash-command intercept ────────────────────────────────────────
    // Slash commands use their dedicated backend routes. `/research` owns its
    // chat persistence so new and existing conversations behave identically.
    const slash = parseSlashPrefix(rawMsg);
    if (slash) {
      setInput("");
      try {
        await runSlashCommand(slash);
        markQueuedSendSucceeded();
      } catch (err: any) {
        toast.error(`Slash command failed: ${err?.message || err}`);
      }
      return;
    }

    const mentionPayload = resolveMentionedApps(rawMsg, selectedMentionIds, mentionHealthById, undefined, mentionRegistryIds)
    if (mentionPayload.needsConnect[0]) {
      toast.message(MENTION_COPY.connectPrompt(mentionPayload.needsConnect[0].name))
    }
    if (mentionPayload.unavailable[0] && mentionPayload.connectedAppIds.length === 0 && mentionPayload.needsConnect.length === 0) {
      toast.message(MENTION_COPY.unavailableDetail(mentionPayload.unavailable[0].name))
    }

    if (composerFiles.some(isComposerFileUploadPending)) {
      toast.info("Espera a que el documento llegue al 100% antes de enviarlo.", { duration: 2200 });
      return;
    }

    const processingFiles = composerFiles.filter(isComposerFileProcessingPending);
    if (processingFiles.length > 0) {
      const firstName = processingFiles[0]?.name || processingFiles[0]?.originalName || "el documento";
      toast.info(
        processingFiles.length === 1
          ? `Espera a que SiraGPT termine de leer "${firstName}" antes de enviarlo.`
          : `Espera a que SiraGPT termine de leer ${processingFiles.length} documentos antes de enviarlos.`,
        { duration: 2600 },
      );
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
    const fileKey = composerFiles
      .map((file: any) => resolveUploadFileId(file) || file?.id || file?.name || file?.originalName || "")
      .filter(Boolean)
      .sort()
      .join(",");
    const sendKey = `${currentChat?.id || "new"}:${selectedModel || "model"}:${msg}:${fileKey}`;
    const nowForSendKey = Date.now();
    inFlightSendKeysRef.current.forEach((entry, key) => {
      if (nowForSendKey - entry.startedAt > 120_000) inFlightSendKeysRef.current.delete(key);
    });
    if (inFlightSendKeysRef.current.has(sendKey)) {
      return;
    }
    const idempotencyKey = queuedSend?.idempotencyKey || `chat-send-${safeUUID()}`;
    inFlightSendKeysRef.current.set(sendKey, { startedAt: nowForSendKey, idempotencyKey });

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
      inFlightSendKeysRef.current.delete(sendKey);
      return;
    }

    let imageModelForSendOverride: string | undefined;
    if (isImageGenerationActive || chatType === 'image') {
      const selectedImageModelForSend = selectedImageModel?.trim();
      let activeImageModel: any = null;
      try {
        activeImageModel = await resolveFreshActiveImageModel(selectedImageModelForSend);
      } catch (error: any) {
        console.warn('No se pudo refrescar el catalogo de modelos de imagen:', error?.message || error);
      }

      if (!activeImageModel?.name) {
        setIsImageGenerationActive(true);
        setChatType('image');
        toast.error('Activa un modelo de imagen en Admin Models antes de generar.');
        inFlightSendKeysRef.current.delete(sendKey);
        return;
      }

      imageModelForSendOverride = String(activeImageModel.name).trim();
      if (imageModelForSendOverride !== selectedImageModelForSend) {
        setSelectedImageModel(imageModelForSendOverride);
        toast.info(`El modelo seleccionado ya no esta activo. Usare ${brandModelLabel(activeImageModel)}.`);
      }
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

    const isBusy = isCurrentChatStreaming
      || isCurrentChatLocalJobBusy
      || isUploading
      || sendInFlightChatsRef.current.has(sendLatchKey);

    if (isBusy) {
      // An auto-drained item is still claimed in the durable queue. If the
      // chat became busy between scheduling and execution, leave that item in
      // place instead of enqueueing a duplicate with the same idempotency key.
      if (queuedSend) {
        inFlightSendKeysRef.current.delete(sendKey);
        return;
      }
      // Park the message — we'll drain the queue once the busy flags
      // flip back to idle (see the useEffect watching busy state).
      const queuedItem = createPersistedComposerQueueItem({
        id: `queued-${safeUUID()}`,
        ownerId: queueOwnerId || "__session__",
        chatId: currentChat?.id ?? null,
        msg,
        files: composerFiles,
        idempotencyKey,
      });
      pendingMsgQueueRef.current.push(queuedItem);
      persistComposerQueue();
      syncQueuedCount(currentChat?.id ?? null);
      setInput("");
      chatDraft.clear();
      uploadedFilesRef.current = [];
      setUploadedFiles([]);
      attachmentHashesRef.current.clear();
      const now = Date.now();
      queueBurstTimestampsRef.current = queueBurstTimestampsRef.current.filter(t => now - t < 5000);
      queueBurstTimestampsRef.current.push(now);
      // Only surface the toast when the user actually triggers the
      // "3+ in 5s" burst condition — otherwise a single queued message
      // during a long stream would nag them.
      if (queueBurstTimestampsRef.current.length >= 3 && pendingMsgQueueRef.current.length === 1) {
        toast.info("Procesando tus mensajes…", { duration: 2500 });
      }
      inFlightSendKeysRef.current.delete(sendKey);
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

      try {
        let accumulatedContent = '';
        const streamId = safeUUID();

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
        markQueuedSendSucceeded();
      } catch (error: any) {
        console.error('Rewrite error:', error);
        toast.error(error?.message || 'Failed to rewrite text.');
        setIsRewriting(false);
      } finally {
        inFlightSendKeysRef.current.delete(sendKey);
      }
      return; // Stop further execution
    }
    let filesToSend = [...composerFiles];
    const imageAttachments = filesToSend.filter((file: any) =>
      String(file?.type || file?.mimeType || "").startsWith("image/"),
    );
    if (imageAttachments.length > 0) {
      const wantsTranscription = looksLikeTranscriptionRequest(msg);
      const weakOcr = imageAttachments.some((file: any) =>
        isWeakOcrText(file?.extractedText, file?.ocr?.confidence),
      );
      if (wantsTranscription || weakOcr) {
        try {
          filesToSend = await enrichImageFilesWithClientOcr(filesToSend, {
            prompt: msg,
            force: wantsTranscription,
          });
        } catch { /* client OCR is best-effort before the model answers */ }
      }
    }
    const buildImageEditPrompt = (rawPrompt: string) => {
      const editFile = filesToSend.find((file: any) => file?.editRegion);
      if (!editFile?.editRegion) return rawPrompt;
      const region = editFile.editRegion;
      return `${rawPrompt}\n\nImage edit target: modify only the marked region of the attached image. Region in percentages from the image top-left: x=${Math.round(region.x || 0)}%, y=${Math.round(region.y || 0)}%, width=${Math.round(region.width || 0)}%, height=${Math.round(region.height || 0)}%. Keep the rest of the image visually unchanged.`;
    };
    setInput("");
    setSelectedMentionIds([]);
    setMentionMenuOpen(false);
    setMentionTrigger(null);
    // The message is on its way — drop the saved draft so the next
    // visit to this chat starts with a clean composer instead of
    // re-showing the text the user just sent.
    chatDraft.clear();
    uploadedFilesRef.current = [];
    setUploadedFiles([]);
    attachmentHashesRef.current.clear();

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
          files: snapshotComposerFilesForMessage(filesToSend),
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

        const streamId = safeUUID();
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
        markQueuedSendSucceeded();
      } catch (error: any) {
        setIsGeneratingWord(false);
        console.error('Word Connector error:', error);
        toast.error(error?.message || 'Error al generar documento');
      } finally {
        inFlightSendKeysRef.current.delete(sendKey);
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
          files: snapshotComposerFilesForMessage(filesToSend),
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
        markQueuedSendSucceeded();

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
      } finally {
        inFlightSendKeysRef.current.delete(sendKey);
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
          const newChat = await createNewChat('thesis', msg, undefined, { idempotencyKey });
          if (newChat?.id) {
            markQueuedSendSucceeded();
            // Select the newly created chat to show messages properly
            setTimeout(async () => {
              await selectChat(newChat.id);
            }, 300);
          }
        } else {
          toast.error('Please provide at least 1 research topic for thesis generation.\n\nExample: "Artificial Intelligence in Healthcare" or "AI in Healthcare, ML Ethics"');
        }
        inFlightSendKeysRef.current.delete(sendKey);
        return;
      } catch (error: any) {
        console.error('Thesis generation error:', error);
        toast.error(error?.message || 'Thesis generation failed. Please try again.');
        inFlightSendKeysRef.current.delete(sendKey);
        return;
      }
    }

    if (isVideoGenerationActive || chatType === 'video') {
      isGeneratingVideoRef.current = true;
      isVideoGenerationActiveRef.current = true;
      setIsVideoGenerationActive(true);
      setChatType('video');
    }

    if (isVoiceGenerationActive) {
      isGeneratingVoiceRef.current = true;
      setIsGeneratingVoice(true);
      setIsVoiceGenerationActive(true);
      try {
        await handleVoiceGeneration(msg, filesToSend);
        markQueuedSendSucceeded();
      } finally {
        isGeneratingVoiceRef.current = false;
        setIsGeneratingVoice(false);
        setIsVoiceGenerationActive(true);
        inFlightSendKeysRef.current.delete(sendKey);
      }
      return;
    }

    if (isMusicGenerationActive) {
      isGeneratingMusicRef.current = true;
      setIsGeneratingMusic(true);
      setIsMusicGenerationActive(true);
      try {
        await handleMusicGeneration(msg, filesToSend);
        markQueuedSendSucceeded();
      } finally {
        isGeneratingMusicRef.current = false;
        setIsGeneratingMusic(false);
        setIsMusicGenerationActive(true);
        inFlightSendKeysRef.current.delete(sendKey);
      }
      return;
    }

    const deterministicAgenticIntent = classifyIntentFastPath(msg);
    // Image-only turns ("resolver", "resuelve esta derivada", "¿qué dice esta
    // imagen?") need VISION, which lives only in the plain /api/ai/generate
    // path. The queued agent loop has no vision and stalls blind on the image.
    // So even when the TEXT alone classifies as an agentic intent (e.g.
    // "derivada" → math, "imagen" → image), keep image-only turns out of the
    // agent loop entirely — the vision path reads the image and responds.
    const imageOnlyTurn = isImageOnlyAttachmentTurn(filesToSend);
    const hasDedicatedConnector = isGmailActive
      || isGoogleCalendarActive
      || isGoogleDriveActive
      || isSpotifyActive
      || isComputerUseActive
      || isWordConnectorActive
      || isExcelConnectorActive;
    const hasMediaGenerator = isImageGenerationActive
      || isVoiceGenerationActive
      || isMusicGenerationActive
      || isVideoGenerationActive;
    const shouldUseWorkModeAgent = isWorkModeActive
      && !hasDedicatedConnector
      && !hasMediaGenerator
      && shouldRouteWorkModePromptThroughAgentTask(msg, filesToSend);
    const shouldUseAcademicSearch = shouldUseDedicatedAcademicSearch(msg, {
      attachmentCount: filesToSend.length,
      customGptId: currentChat?.customGptId,
      customGpt: currentChat?.customGpt,
    });
    // Document-EDIT turns (attachment + "borra/elimina/agrega/edita…") must
    // enter the durable agent-task path. That backend path owns the current
    // source-preserving Office/PDF editor, artifact persistence and validation.
    // Pure image-analysis turns are still kept out of the queued path because
    // vision runs through /api/ai/generate.
    const shouldStartAgenticLoopImmediately = shouldUseWorkModeAgent
      || (deterministicAgenticIntent
        && ['web_search', 'agent_task', 'math', 'viz', 'chart', 'ppt'].includes(deterministicAgenticIntent)
        && !imageOnlyTurn
        // Same gate as the semantic switch below: no-file analytical turns
        // (web lookups, formulas, charts) belong on the RELIABLE inline
        // /generate agentic loop, not the durable queued path. Without this,
        // the deterministic fast-path queued "busca en la web…" style prompts
        // straight into the agent-task pipeline and the chat froze on
        // "Analizando solicitud" whenever the worker/relay hiccupped.
        && shouldRouteTextPromptThroughAgenticRuntime(msg, filesToSend));
    const shouldStartAgenticLoopForCurrentMessage = shouldStartAgenticLoopImmediately && !shouldUseAcademicSearch;

    if (shouldStartAgenticLoopForCurrentMessage) {
      try {
        if (isLiveComputerUsePrompt(msg)) openComputerPanel();
        await handleAgentTask(msg, filesToSend, { userMessageAlreadyAdded: false });
        markQueuedSendSucceeded();
      } finally {
        inFlightSendKeysRef.current.delete(sendKey);
      }
      return;
    }

    if (sendInFlightChatsRef.current.has(sendLatchKey)) return;
    sendInFlightChatsRef.current.add(sendLatchKey);

    // Optimistically add the user message to the UI immediately.
    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: currentChat?.id || duumychatId,
      role: 'USER' as const,
      content: msg,
      timestamp: new Date().toISOString(),
      files: snapshotComposerFilesForMessage(filesToSend),
      metadata: JSON.stringify({ idempotencyKey }),
    };
    const assistantPlaceholder = {
      id: `msg-assistant-processing-${Date.now()}`,
      chatId: currentChat?.id || duumychatId,
      role: 'ASSISTANT' as const,
      content: '',
      timestamp: new Date().toISOString(),
      metadata: JSON.stringify({ idempotencyKey }),
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
        const updatedMessages = [...(prevChat.messages || []), userMessage, assistantPlaceholder];
        return { ...prevChat, messages: updatedMessages };
      });
    }


    try {
      // After optimistic update, run the logic.
      // For existing chats, we pass `true` to `addMessage` to skip re-adding the user message.
      // For new chats, `createNewChat` will handle creating the chat, and the context will replace the temp chat.

      if (isWebSearchActive || shouldUseAcademicSearch) {
        await handleWebSearch(msg);
        markQueuedSendSucceeded();
        return;
      }
      if (isGmailActive) {
        await handleGmailCommand(msg);
        markQueuedSendSucceeded();
        return;
      }
      if (isGoogleCalendarActive || isGoogleDriveActive) {
        await handleGoogleServicesCommand(msg);
        markQueuedSendSucceeded();
        return;
      }
      if (isSpotifyActive) {
        await handleSpotifyCommand(msg);
        markQueuedSendSucceeded();
        return;
      }
      if (isImageGenerationActive || chatType === 'image') {
        // Even with the "Imágenes" composer mode on (it can be left sticky by
        // a previous generation), an ANALYSIS question about an image
        // ("describe esta imagen", "¿qué ves?") must go to the vision chat
        // path, not the generator — fall through to normal routing.
        if (!isImageAnalysisPrompt(msg)) {
          await handleImageGeneration(buildImageEditPrompt(msg), collectUploadFileIds(filesToSend), imageModelForSendOverride);
          markQueuedSendSucceeded();
          return;
        }
      }
      if (isVideoGenerationActive || chatType === 'video') {
        isGeneratingVideoRef.current = true;
        isVideoGenerationActiveRef.current = true;
        setIsVideoGenerationActive(true);
        setChatType('video');
        try {
          await handleVideoGeneration(msg, collectUploadFileIds(filesToSend), filesToSend);
          markQueuedSendSucceeded();
        } finally {
          isVideoGenerationActiveRef.current = true;
          setIsVideoGenerationActive(true);
          setChatType('video');
        }
        return;
      }
      if (chatType === 'thesis' && !isNewChat) {
        // Handle thesis generation for existing chats only
        // New thesis chats are handled earlier in the function
        const topics = msg.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (topics.length >= 1) {
          await addThesisMessage(topics);
          markQueuedSendSucceeded();
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

        await startComputerUse(msg, chatId, user?.id, computerUseAppMode || 'browser');
        markQueuedSendSucceeded();

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

      const existingRoutingMessages = chatToUpdate?.messages || [];
      const routingMessages = existingRoutingMessages.some((message: any) => message?.id === userMessage.id)
        ? existingRoutingMessages
        : [...existingRoutingMessages, userMessage];
      const intent = await aiService.classifyIntent(
        msg,
        routingMessages,
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
          await createNewChat('text', msg, filesToSend, { initialIntent: pipelineIntent, idempotencyKey });
        } else {
          await addMessage(msg, filesToSend, chatToUpdate, true, pipelineIntent, {
            idempotencyKey,
            mentionedApps: mentionPayload.mentionedApps,
          });
        }
      };

      const runClassifiedAgentTask = () => handleAgentTask(msg, filesToSend, {
        userMessageAlreadyAdded: true,
        assistantMessageId: assistantPlaceholder.id,
      });

      switch (intent) {
        case 'image':
          // "describe esta imagen / ¿qué ves? / transcribe" is image ANALYSIS:
          // run the vision chat path (the plain stream reads attached and
          // historical images). The async classifier can return 'image' for
          // these because the text mentions "imagen" — generating a new image
          // here was a real reported bug ("describir que ves en esta imagen"
          // + attached photo started the image generator).
          if (isImageAnalysisPrompt(msg)) {
            await runContextPipeline('text');
            break;
          }
          await handleImageGeneration(buildImageEditPrompt(msg), collectUploadFileIds(filesToSend));
          break;
        case 'video':
          isGeneratingVideoRef.current = true;
          isVideoGenerationActiveRef.current = true;
          setIsVideoGenerationActive(true);
          setChatType('video');
          await handleVideoGeneration(msg, collectUploadFileIds(filesToSend), filesToSend);
          isVideoGenerationActiveRef.current = true;
          setIsVideoGenerationActive(true);
          setChatType('video');
          break;
        case 'ppt':
          await runClassifiedAgentTask();
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
        case 'web_search':
        case 'agent_task':
          // Same gate as 'text': no-file analytical turns ("ejecuta la
          // fórmula", "haz un gráfico de esto", quick web lookups) run on
          // the RELIABLE inline /generate agentic loop. Uploaded-document
          // work, including source-preserving edits, runs on the durable
          // agent-task path so file artifacts and validation are persisted.
          if (shouldRouteTextPromptThroughAgenticRuntime(msg, filesToSend)) {
            await runClassifiedAgentTask();
          } else {
            await runContextPipeline(intent);
          }
          break;
        case 'doc':
          await runClassifiedAgentTask();
          break;
        case 'text':
          if (shouldRouteTextPromptThroughAgenticRuntime(msg, filesToSend)) {
            await runClassifiedAgentTask();
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
            await runClassifiedAgentTask();
          } else {
            await runContextPipeline(intent);
          }
          break;
      }
      markQueuedSendSucceeded();
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

        // Extract a neutral usage signal if available without exposing internal quotas
        let usageInfo = '';
        if (errorData && errorData.usage) {
          usageInfo = ' Tu actividad del mes ya alcanzó el máximo disponible para tu plan.';
        }

        // Show proper error message in UI
        const errorMessage = {
          id: `msg-error-${Date.now()}`,
          chatId: chatToUpdate?.id || 'unknown',
          role: 'ASSISTANT' as const,
          content: `Tu plan necesita una mejora para continuar.${usageInfo} Elige Pro, Pro Extendido o comunícate por WhatsApp para Enterprise.`,
          timestamp: new Date().toISOString(),
          error: 'Plan upgrade required',
        };

        setCurrentChat(prevChat => {
          if (!prevChat || prevChat.id !== (chatToUpdate?.id || userMessage.chatId)) return prevChat;
          const updatedMessages = [...(prevChat.messages || []), errorMessage];
          return { ...prevChat, messages: updatedMessages };
        });

        toast.error(`Tu plan necesita una mejora para continuar.${usageInfo ? ' ' + usageInfo : ''}`);
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
      sendInFlightChatsRef.current.delete(sendLatchKey);
      inFlightSendKeysRef.current.delete(sendKey);
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
        toast.error('Tu plan necesita una mejora para continuar.');

        // Update placeholder with limit error
        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (currentChat?.id && prevChat.id !== currentChat.id) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_GMAIL]') {
              return {
                ...msg,
                content: "Tu plan necesita una mejora para continuar usando Gmail.",
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
        toast.error('Tu plan necesita una mejora para continuar.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (currentChat?.id && prevChat.id !== currentChat.id) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[PROCESSING_CALENDAR_ACTION]' || msg.content === '[PROCESSING_DRIVE_ACTION]') {
              return {
                ...msg,
                content: "Tu plan necesita una mejora para continuar usando Google Services.",
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

  const handleImageGeneration = async (prompt: string, files?: string[], requestedModel?: string) => {
    let imageModelForRequest = (requestedModel || selectedImageModel || '').trim();
    let activeImageModel: any = null;
    try {
      activeImageModel = await resolveFreshActiveImageModel(imageModelForRequest);
    } catch (error: any) {
      console.warn('No se pudo refrescar el catalogo de modelos de imagen:', error?.message || error);
    }

    if (!activeImageModel?.name) {
      setIsImageGenerationActive(true);
      setChatType('image');
      toast.error('Activa un modelo de imagen en Admin Models antes de generar.');
      return;
    }
    imageModelForRequest = activeImageModel.name;
    if (imageModelForRequest !== selectedImageModel) {
      setSelectedImageModel(imageModelForRequest);
    }
    const imageProviderForRequest = activeImageModel.provider || providerForSelectedImageModel(imageModelForRequest);

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
        const newChat = await createNewChat('image', prompt, undefined, {
          skipInitialProcessing: true,
          model: imageModelForRequest,
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
        const isTemporaryChat = typeof prevChat?.id === 'string' && prevChat.id.startsWith('temp-chat-');
        if (prevChat && prevChat.id !== activeChatId && !isTemporaryChat) return prevChat;
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
        provider: imageProviderForRequest,
        model: imageModelForRequest,
        aspectRatio: selectedImageAspectRatio,
        quality: selectedImageQuality,
        imageCount: selectedImageCount,
      };

      if (files && files[0]) {
        payload.fileId = files[0];
      }
      setUploadedFiles([]);
      attachmentHashesRef.current.clear();
      const imageRequestStartedAt = Date.now();
      try {
        await apiClient.generateImage(payload, { signal: controller.signal });
      } catch (genError: any) {
        const userAborted = controller.signal.aborted || genError?.name === 'AbortError';
        // Mobile Safari and edge proxies can drop a long image request without
        // a usable response while the backend keeps generating and persists
        // the result into the chat. Poll the conversation for the final
        // image/error message on recoverable transport cuts. Functional HTTP
        // errors and explicit user cancellation still go through the outer catch.
        const connectionCut = shouldRecoverImageGenerationViaPolling(genError, imageRequestStartedAt, {
          userAborted,
        });
        if (!connectionCut) {
          throw genError;
        }
        const outcome = await apiClient.waitForGeneratedImage(activeChatId, imageRequestStartedAt, {
          signal: controller.signal,
        });
        if (outcome === 'error') {
          // El backend persistió el fallo como mensaje del chat: recargamos
          // para mostrarlo y avisamos, sin pasar por el catch externo (el
          // mensaje de error ya está en el hilo).
          if (currentChatIdRef.current === activeChatId) {
            await selectChat(activeChatId);
          }
          toast.error('No se pudo generar la imagen. Inténtalo de nuevo.');
          return;
        }
        if (outcome !== 'image') {
          throw genError;
        }
      }

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

      const errorMessage = error.message || 'Image generation failed. Please try again.';
      const status = error?.status || error?.statusCode;
      const errorData = error?.errorData;
      const errorCode = error?.code || errorData?.code;

      if (status === 403 && errorCode === 'image_model_inactive') {
        let fallbackModel: any = null;
        try {
          fallbackModel = await resolveFreshActiveImageModel();
        } catch (refreshError: any) {
          console.warn('No se pudo refrescar el catalogo de modelos de imagen:', refreshError?.message || refreshError);
        }
        const inactiveMessage = fallbackModel?.name
          ? `El modelo seleccionado ya no esta activo. Cambie a ${brandModelLabel(fallbackModel)}; vuelve a enviar la imagen.`
          : 'El modelo seleccionado ya no esta activo. Activa un modelo de imagen en Admin Models antes de generar.';
        if (fallbackModel?.name) {
          setSelectedImageModel(fallbackModel.name);
        }
        toast.error(inactiveMessage);

        const updateChatWithInactiveModelError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          if (prevChat.id !== activeChatId) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[GENERATING_IMAGE]') {
              return { ...msg, content: "", error: inactiveMessage };
            }
            return msg;
          });
          return { ...prevChat, messages: newMessages };
        };

        setCurrentChat(updateChatWithInactiveModelError);
        return;
      }

      console.error('Image generation failed:', error)

      // Check for monthly API limit exceeded error
      if (status === 429 ||
        isMonthlyLimitError(errorMessage) ||
        (errorData && isMonthlyLimitError(errorData.error || ''))) {

        // Show upgrade modal for API limit errors
        setSubscribeOpen(true);
        toast.error('Tu plan necesita una mejora para continuar.');

        const updateChatWithLimitError = (prevChat: any) => {
          if (!prevChat) return prevChat;
          const newMessages = prevChat.messages.map((msg: any) => {
            if (msg.content === '[GENERATING_IMAGE]') {
              return {
                ...msg,
                content: 'Tu plan necesita una mejora para continuar generando imágenes.',
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

  const handleVideoGeneration = async (prompt: string, files?: string[], sourceFiles: any[] = []) => {
    const activeVideoModel = selectedVideoModel.trim() || videoModelsForComposer[0]?.name || "";
    if (!activeVideoModel) {
      toast.error('Activa un modelo VIDEO en Admin > AI Models antes de generar video.');
      return;
    }

    let activeChatId = currentChat?.id || null;
    // Dedicated abort handle (same mechanism as image) so stopActiveGeneration
    // can cancel the kickoff request and return the composer to idle.
    const videoController = new AbortController();
    let pollingStarted = false;
    let operationIdForThisRun: string | null = null;
    let localStateSettled = false;
    const settleLocalVideoState = () => {
      if (localStateSettled) return;
      localStateSettled = true;
      const stillCurrentController = videoAbortControllerRef.current === videoController;
      const stillCurrentOperation = Boolean(operationIdForThisRun && currentVideoOperationIdRef.current === operationIdForThisRun);
      const noNewVideoRun = !videoAbortControllerRef.current && !currentVideoOperationIdRef.current;
      const shouldClearVisibleState = stillCurrentController || stillCurrentOperation || noNewVideoRun;
      if (stillCurrentController) {
        videoAbortControllerRef.current = null;
      }
      if (!operationIdForThisRun || stillCurrentOperation) {
        currentVideoOperationIdRef.current = null;
      }
      markLocalJobIdle(activeChatId, videoController);
      if (shouldClearVisibleState) {
        isGeneratingVideoRef.current = false;
        setIsGeneratingVideo(false);
      }
      isVideoGenerationActiveRef.current = true;
      setIsVideoGenerationActive(true);
      setChatType('video');
    };

    isGeneratingVideoRef.current = true;
    isVideoGenerationActiveRef.current = true;
    setIsGeneratingVideo(true)
    setIsVideoGenerationActive(true);
    setChatType('video');
    videoAbortControllerRef.current = videoController;
    if (activeChatId) markLocalJobBusy(activeChatId, videoController);
    const promptAspectRatio = extractRequestedVideoAspectRatio(prompt);
    const promptResolution = extractRequestedVideoResolution(prompt);
    const promptAudio = extractRequestedVideoAudio(prompt);
    const sourceImageUrls = (!files?.length && shouldUseLatestImageForVideo(prompt))
      ? collectLatestGeneratedImageUrls(currentChat?.messages || [])
      : [];
    const videoOptions = {
      resolution: promptResolution || selectedVideoResolution,
      aspectRatio: promptAspectRatio || selectedVideoAspectRatio,
      duration: clampVideoDuration(selectedVideoDuration, resolveVideoDurationSpec(activeVideoModel || selectedVideoModel, (availableModels || []).find((model: any) => model?.name === (activeVideoModel || selectedVideoModel))?.apiData?.fal)) ?? selectedVideoDuration,
      audio: promptAudio ?? selectedVideoAudio,
      model: activeVideoModel,
      signal: videoController.signal,
      sourceImageUrls,
      sourceImageFiles: sourceFiles,
      onOperationStarted: (operationId: string) => {
        pollingStarted = true;
        operationIdForThisRun = operationId;
        currentVideoOperationIdRef.current = operationId;
        if (activeChatId) markLocalJobBusy(activeChatId, videoController);
      },
      onGenerationSettled: () => {
        settleLocalVideoState();
      },
    };
    try {
      if (!currentChat) {
        const newChat = await createNewChat('video', prompt, undefined, {
          skipInitialProcessing: true,
          model: activeVideoModel || selectedModel,
        } as any)
        activeChatId = newChat?.id || activeChatId;
        if (activeChatId) markLocalJobBusy(activeChatId, videoController);
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
        toast.error('Tu plan necesita una mejora para continuar.');
        return;
      }

      toast.error(errorMessage)
    } finally {
      if (!pollingStarted) {
        settleLocalVideoState();
      }
      // Don't auto-reset - user must manually remove
    }
  }

  const handleWebDevGeneration = async (prompt: string) => {
    // Use dedicated webdev streaming API endpoint
    const filesToSend = [...uploadedFiles];
    const professionalPrompt = buildProfessionalCapabilityPrompt('webdev', prompt);
    setUploadedFiles([]);
    attachmentHashesRef.current.clear(); // Clear UI immediately

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
      const streamId = safeUUID();
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

  // Drain queued messages when a chat's pipeline goes idle.
  // Foreground: current chat idle → restore composer + handleSend.
  // Background: other idle chats → addMessage directly so work continues
  // while the user is reading a different conversation.
  React.useEffect(() => {
    if (pendingMsgQueueRef.current.length === 0) return;
    const queueDrainClaims = queueDrainClaimsRef.current;

    const queueChatId = currentChat?.id ?? null;
    const currentBusy =
      isCurrentChatStreaming || isCurrentChatLocalJobBusy || isUploading;

    // 1) Prefer draining the chat the user is looking at (composer path).
    if (!currentBusy) {
      const nextIndex = pendingMsgQueueRef.current.findIndex(
        (item) => item.chatId === queueChatId && !queueDrainClaims.has(item.id),
      );
      if (nextIndex >= 0) {
        const next = pendingMsgQueueRef.current[nextIndex];
        if (!next) return;
        queueDrainClaims.add(next.id);
        let started = false;
        const t = setTimeout(async () => {
          started = true;
          const claimed = pendingMsgQueueRef.current.find((item) => item.id === next.id);
          if (!claimed) {
            queueDrainClaims.delete(next.id);
            return;
          }
          queuedComposerSendRef.current = claimed;
          try {
            await handleSendRef.current();
            if (queuedSendSucceededRef.current.get(claimed.id) === true) {
              const completedIndex = pendingMsgQueueRef.current.findIndex((item) => item.id === claimed.id);
              if (completedIndex >= 0) {
                pendingMsgQueueRef.current.splice(completedIndex, 1);
                persistComposerQueue();
                syncQueuedCount(queueChatId);
              }
            }
          } catch (error) {
            console.error("No se pudo procesar la tarea en cola; se conservará para reintentar.", error);
          } finally {
            queuedSendSucceededRef.current.delete(claimed.id);
            queueDrainClaims.delete(claimed.id);
          }
        }, 0);
        return () => {
          clearTimeout(t);
          if (!started) queueDrainClaims.delete(next.id);
        };
      }
    }

    // 2) Background drain for any other idle chat with queued work.
    const bgIndex = pendingMsgQueueRef.current.findIndex((item) => {
      if (!item.chatId) return false;
      if (item.chatId === queueChatId) return false;
      if (queueDrainClaims.has(item.id)) return false;
      if (activeStreamingChatIds.includes(item.chatId)) return false;
      if (activeLocalJobChatIdsRef.current.has(item.chatId)) return false;
      return true;
    });
    if (bgIndex < 0) return;
    const bgNext = pendingMsgQueueRef.current[bgIndex];
    if (!bgNext?.chatId || !bgNext.msg?.trim()) return;
    const targetChat =
      currentChat?.id === bgNext.chatId
        ? currentChat
        : (chats || []).find((c: any) => c?.id === bgNext.chatId) || null;
    if (!targetChat) {
      return;
    }
    const files = Array.isArray(bgNext.files) ? bgNext.files : [];
    queueDrainClaims.add(bgNext.id);
    let started = false;
    const t = setTimeout(async () => {
      started = true;
      try {
        await addMessage(bgNext.msg, files, targetChat, false, undefined, {
          idempotencyKey: bgNext.idempotencyKey,
        });
        // Background work stays durable until the chat context confirms the
        // message was accepted. A rejection leaves it in FIFO for retry.
        const completedIndex = pendingMsgQueueRef.current.findIndex((item) => item.id === bgNext.id);
        if (completedIndex >= 0) {
          pendingMsgQueueRef.current.splice(completedIndex, 1);
          persistComposerQueue();
          syncQueuedCount(queueChatId);
        }
      } catch (error) {
        console.error("No se pudo procesar la tarea en cola; se conservará para reintentar.", error);
      } finally {
        queueDrainClaims.delete(bgNext.id);
      }
    }, 0);
    return () => {
      clearTimeout(t);
      if (!started) queueDrainClaims.delete(bgNext.id);
    };
  }, [
    currentChat,
    currentChat?.id,
    chats,
    isCurrentChatStreaming,
    isCurrentChatLocalJobBusy,
    isUploading,
    activeStreamingChatIds,
    activeLocalJobChatIds,
    addMessage,
    persistComposerQueue,
    setUploadedFiles,
    syncQueuedCount,
    queueHydrationVersion,
  ]);

  // Prevent Enter key from adding new line when not holding Shift
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME candidates may emit an Enter keydown while the character is still
    // composing. Never submit or prevent that event until composition ends.
    if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      return
    }
    // El textarea queda libre durante el streaming (paridad Claude); Enter
    // no dispara un segundo turno mientras el actual sigue en curso.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (isCurrentChatLocalJobBusy) return
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

  const removeFile = React.useCallback((index: number) => {
    setUploadedFiles((cur: any[]) => {
      const removed = cur[index];
      // Removing a chip mid-upload acts as CANCEL: remember the tempId so
      // the XHR completion merge doesn't resurrect the chip, and free its
      // dedup hash so the user can re-attach the same file later.
      if (removed?.tempId) cancelledTempIdsRef.current.add(removed.tempId);
      const removedHash = removed ? attachmentHashByIdRef.current.get(removed.tempId || removed.id) : null;
      if (removedHash) {
        attachmentHashesRef.current.delete(removedHash);
        attachmentHashByIdRef.current.delete(removed.tempId || removed.id);
      }
      const next = cur.filter((_, i) => i !== index);
      uploadedFilesRef.current = next;
      return next;
    });
    setComposerPreviewIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      return index < current ? current - 1 : current;
    });
  }, [setUploadedFiles])

  // Keyboard reordering of attachment chips (Alt+←/→ on a focused chip).
  // Preserves every other invariant: send order == visual order.
  const moveFile = React.useCallback((index: number, delta: -1 | 1) => {
    setUploadedFiles((cur: any[]) => {
      const target = index + delta;
      if (index < 0 || index >= cur.length || target < 0 || target >= cur.length) return cur;
      const next = [...cur];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      uploadedFilesRef.current = next;
      return next;
    });
    setComposerPreviewIndex((current) => {
      if (current === null) return null;
      if (current === index) return index + delta;
      if (current === index + delta) return current - delta;
      return current;
    });
  }, [setUploadedFiles]);

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

  // Autofocus the composer whenever the empty state shows (new chat /
  // cleared chat) so the user can start typing without clicking first.
  // Desktop only: focusing on mobile pops the keyboard over the hero.
  React.useEffect(() => {
    if (!isInitial) return undefined
    if (typeof window === "undefined") return undefined
    if (window.matchMedia("(max-width: 767px)").matches) return undefined
    const id = window.setTimeout(() => textareaRef.current?.focus(), 80)
    return () => window.clearTimeout(id)
  }, [isInitial])

  // Any active tool/connector/thesis mode? Used to conditionally render active
  // controls only when needed so the composer stays a clean pill by default.
  const hasActiveTools = (
    isWorkModeActive || isWebSearchActive || isImageGenerationActive || isVoiceGenerationActive || isMusicGenerationActive || isVideoGenerationActive || isComputerUseActive
    || isGmailActive || isGoogleCalendarActive || isGoogleDriveActive
    || isSpotifyActive || isWordConnectorActive || isExcelConnectorActive
    || chatType === 'thesis'
  );
  const isMediaToolActive = isImageGenerationActive || isVoiceGenerationActive || isMusicGenerationActive || isVideoGenerationActive;
  const shouldInlineActiveTools = isMediaToolActive || isWebSearchActive;
  const requiresPromptBeforePrimarySend =
    isImageGenerationActive ||
    isVoiceGenerationActive ||
    isVideoGenerationActive ||
    isMusicGenerationActive ||
    chatType === 'image' ||
    chatType === 'video';
  const isSendingForCurrentChat = Boolean(
    isSending && sendingChatId && currentChatId && sendingChatId === currentChatId
  );
  // Media flags (image/voice/video/PPT/music) are GLOBAL booleans, but the
  // Stop button must only take over the composer in the chat that OWNS the
  // job (media handlers call markLocalJobBusy(chatId)). Otherwise, while chat
  // A generates media, every other chat loses its send button and a Stop
  // clicked from chat B aborts chat A's job.
  const isCurrentChatMediaBusy =
    isCurrentChatLocalJobBusy &&
    (isGeneratingImage || isGeneratingVoice || isGeneratingVideo || isGeneratingPPT || isGeneratingMusic);
  const isIdlePlaceholderComposer = isInitial && !isCurrentChatStreaming && !isCurrentChatLocalJobBusy && !isGeneratingVideo && !isGeneratingImage && !isGeneratingVoice && !isGeneratingMusic && !isGeneratingPPT;
  const isStopButtonVisible = !isIdlePlaceholderComposer && (
    isCurrentChatLoading ||
    isCurrentChatStreaming ||
    (pendingStop && isCurrentChatStreaming) ||
    isSendingForCurrentChat ||
    isCurrentChatLocalJobBusy ||
    isCurrentChatMediaBusy
  );
  const shouldPrioritizeStopButton = isCurrentChatMediaBusy;
  // Shared props bundle for <ActiveToolsDisplay /> — the component is
  // now rendered in a different spot (below the input instead of above)
  // but the prop contract is identical, so centralising it avoids
  // drift between the two composer instances (initial vs in-chat).
  const activeToolsProps = {
    isWorkModeActive, setIsWorkModeActive,
    isWebSearchActive, setIsWebSearchActive,
    isImageGenerationActive, setIsImageGenerationActive,
    isGeneratingImage,
    selectedImageAspectRatio, setSelectedImageAspectRatio,
    selectedImageQuality, setSelectedImageQuality,
    selectedImageCount, setSelectedImageCount,
    selectedImageModel, setSelectedImageModel,
    isVoiceGenerationActive, setIsVoiceGenerationActive,
    isGeneratingVoice,
    selectedVoiceModel, setSelectedVoiceModel,
    selectedVoiceLanguage, setSelectedVoiceLanguage,
    selectedVoiceAccent, setSelectedVoiceAccent,
    selectedVoiceStability, setSelectedVoiceStability,
    selectedVoiceEffect, setSelectedVoiceEffect,
    onOpenVoiceCatalog: () => setVoiceCatalogOpen(true),
    selectedVoiceName,
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
    computerUseAppMode, setComputerUseAppMode,
    computerUseStatus,
    isGmailActive, setIsGmailActive,
    isGoogleCalendarActive, setIsGoogleCalendarActive,
    isGoogleDriveActive, setIsGoogleDriveActive,
    isSpotifyActive, setIsSpotifyActive,
    isWordConnectorActive, setIsWordConnectorActive,
    isExcelConnectorActive, setIsExcelConnectorActive,
    selectedModel, setSelectedModel,
    availableModels: composerAvailableModels,
    setSelectedProvider: setSelectedProivder,
    chatType, setChatType,
    onVideoGenerationClose: () => { autoVideoActivationRef.current = false; },
    handleComputerUseToggle, handleGmailToggle, handleGoogleCalendarToggle,
    handleGoogleDriveToggle, handleSpotifyToggle, handleWordConnectorToggle,
    handleExcelConnectorToggle,
  };


  const previewUsesOverlay = useDocumentPreviewOverlay();
  const documentPreviewOpen = Boolean(
    documentPreviewUrl ||
    composerPreviewAttachment ||
    sidePreviewAttachment
  );
  const rightPanelActive = Boolean(
    coworkPanelOpen ||
    computerPanelOpen ||
    showAudioPanel ||
    searchActivityPanelOpen ||
    (documentPreviewOpen && !previewUsesOverlay) ||
    sourcesPanelData ||
    isWordConnectorActive ||
    isExcelConnectorActive ||
    activeArtifact
  );
  const coworkMobileFullscreen = Boolean((coworkPanelOpen || computerPanelOpen) && isSidebarMobile);
  const effectiveSplitRatio = splitRatio;

  // Mutual exclusion: the Fuentes pane is the lowest-priority right-pane
  // tenant, so if any other viewer becomes active while it's open, close it.
  // handleOpenSources clears the others when opening, so this only fires when
  // a different pane opens afterwards (e.g. a streamed search, a doc preview).
  React.useEffect(() => {
    if (!sourcesPanelData) return;
    if (
      showAudioPanel ||
      coworkPanelOpen ||
      computerPanelOpen ||
      searchActivityPanelOpen ||
      documentPreviewUrl ||
      composerPreviewAttachment ||
      sidePreviewAttachment ||
      isWordConnectorActive ||
      isExcelConnectorActive ||
      activeArtifact
    ) {
      setSourcesPanelData(null);
    }
  }, [
    sourcesPanelData,
    showAudioPanel,
    coworkPanelOpen,
    computerPanelOpen,
    searchActivityPanelOpen,
    documentPreviewUrl,
    composerPreviewAttachment,
    sidePreviewAttachment,
    isWordConnectorActive,
    isExcelConnectorActive,
    activeArtifact,
  ]);

  const mainPaneAudioPanelEnabled = false;

  const openCoworkPanel = React.useCallback(() => {
    setShowAudioPanel(false);
    setActiveSearchActivityId(null);
    setDocumentPreviewUrl(null);
    setComposerPreviewIndex(null);
    setSidePreviewAttachment(null);
    setSidePreviewSiblings([]);
    setSourcesPanelData(null);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    closeArtifactPanel();
    setComputerPanelOpen(false);
    setCoworkPanelOpen(true);
  }, [closeArtifactPanel]);

  React.useEffect(() => {
    if (!coworkPanelOpen && !computerPanelOpen) return;
    if (
      showAudioPanel ||
      searchActivityPanelOpen ||
      documentPreviewUrl ||
      composerPreviewAttachment ||
      sidePreviewAttachment ||
      isWordConnectorActive ||
      isExcelConnectorActive ||
      activeArtifact
    ) {
      setCoworkPanelOpen(false);
      setComputerPanelOpen(false);
    }
  }, [
    coworkPanelOpen,
    computerPanelOpen,
    showAudioPanel,
    searchActivityPanelOpen,
    documentPreviewUrl,
    composerPreviewAttachment,
    sidePreviewAttachment,
    isWordConnectorActive,
    isExcelConnectorActive,
    activeArtifact,
  ]);

  const injectHandoffChat = React.useCallback((detail: LoginHandoffDetail) => {
    const chatId = String(detail.conversationId || currentChatIdRef.current || "").trim();
    if (!detail.active || !chatId) return;
    const chatMessage = chatMessageFromDetail(detail);
    if (!chatMessage) return;
    setCurrentChat((prev) => {
      if (!prev || String(prev.id) !== chatId) return prev;
      if (!shouldPostHandoffChatMessage(prev.messages || [], chatMessage)) return prev;
      return {
        ...prev,
        messages: [...(prev.messages || []), buildHandoffAssistantMessage(chatId, chatMessage, detail)],
      };
    });
    void apiClient.addMessage(chatId, {
      role: "ASSISTANT",
      content: chatMessage,
      metadata: { type: "computer_login_handoff", kind: detail.kind, site: detail.site },
      idempotencyKey: `login-handoff:${chatId}:${detail.kind || "gate"}`,
    }).catch(() => undefined);
  }, [setCurrentChat]);

  const openComputerPanel = React.useCallback(() => {
    setShowAudioPanel(false);
    setActiveSearchActivityId(null);
    setDocumentPreviewUrl(null);
    setComposerPreviewIndex(null);
    setSidePreviewAttachment(null);
    setSidePreviewSiblings([]);
    setSourcesPanelData(null);
    setIsWordConnectorActive(false);
    setIsExcelConnectorActive(false);
    closeArtifactPanel();
    setCoworkPanelOpen(false);
    setComputerPanelOpen(true);
    if (!currentChatIdRef.current) {
      void createNewChat("text", undefined, undefined, { skipInitialProcessing: true });
    }
  }, [closeArtifactPanel, createNewChat]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const computer = params.get("computer");
    if (computer === "1" || computer === "true") openComputerPanel();
    const login = params.get("login");
    if (login === "1" || login === "true") {
      setLoginHandoffActive(true);
      openComputerPanel();
    }
  }, [openComputerPanel]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onHandoff = (event: Event) => {
      const detail = (event as CustomEvent<LoginHandoffDetail>).detail;
      if (!detail) return;
      const id = String(detail.conversationId || "").trim();
      const openId = String(currentChat?.id || "").trim();
      if (id && openId && id !== openId) return;
      if (detail.active) {
        setLoginHandoffActive(true);
        if (detail.site) setLoginHandoffSite(String(detail.site));
        if (detail.kind) setLoginHandoffKind(String(detail.kind));
        openComputerPanel();
        injectHandoffChat(detail);
      } else {
        setLoginHandoffActive(false);
      }
    };
    window.addEventListener(LOGIN_HANDOFF_WINDOW_EVENT, onHandoff);
    return () => window.removeEventListener(LOGIN_HANDOFF_WINDOW_EVENT, onHandoff);
  }, [openComputerPanel, currentChat?.id, injectHandoffChat]);

  React.useEffect(() => {
    const chatId = String(currentChat?.id || "").trim();
    if (!chatId || typeof window === "undefined") return;
    let cancelled = false;
    const pull = async () => {
      try {
        const api = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "");
        const res = await authenticatedFetch(
          `${api}/agent-computer/login-handoff?conversationId=${encodeURIComponent(chatId)}${computerPanelOpen ? "&probe=1" : ""}`,
          { credentials: "include", signal: AbortSignal.timeout(12_000) },
        );
        const body = await res.json().catch(() => ({}));
        if (cancelled || !res.ok) return;
        if (body && body.active) {
          setLoginHandoffActive(true);
          if (body.site) setLoginHandoffSite(String(body.site));
          if (body.kind) setLoginHandoffKind(String(body.kind));
          openComputerPanel();
          const detail = {
            active: true,
            conversationId: chatId,
            site: body.site ? String(body.site) : undefined,
            kind: body.kind ? String(body.kind) : undefined,
            reason: body.reason ? String(body.reason) : undefined,
            title: body.title ? String(body.title) : undefined,
            instruction: body.instruction ? String(body.instruction) : undefined,
            chatMessage: body.chatMessage ? String(body.chatMessage) : undefined,
          };
          emitLoginHandoff(detail);
          injectHandoffChat(detail);
        }
      } catch {
        /* handoff poll is best-effort */
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentChat?.id, openComputerPanel, computerPanelOpen, injectHandoffChat]);

  const openGrokVoicePanel = React.useCallback(() => {
    setCoworkPanelOpen(false);
    setComputerPanelOpen(false);
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

  // Shared props bundle for <ActionsDropdown /> (the "+" tools button).
  // It renders in two spots: inline with the textarea while NO tool is
  // active, and as a compact chip in the bottom tools row once any tool
  // is active (so the "+" sits level with the Voz/Imágenes/Música chips).
  const actionsDropdownProps = {
    chatType, setChatType,
    currentPlan,
    isWorkModeActive, setIsWorkModeActive,
    isWebSearchActive, setIsWebSearchActive,
    isImageGenerationActive, setIsImageGenerationActive,
    isVoiceGenerationActive, setIsVoiceGenerationActive,
    isMusicGenerationActive, setIsMusicGenerationActive,
    isVideoGenerationActive, setIsVideoGenerationActive,
    isComputerUseActive, setIsComputerUseActive,
    computerUseAppMode, setComputerUseAppMode,
    computerUseStatus,
    isGmailActive, setIsGmailActive,
    isGoogleCalendarActive, setIsGoogleCalendarActive,
    isGoogleDriveActive, setIsGoogleDriveActive,
    isSpotifyActive, setIsSpotifyActive,
    isWordConnectorActive, setIsWordConnectorActive,
    isExcelConnectorActive, setIsExcelConnectorActive,
    setShowAudioPanel,
    openVoicePanel: openGrokVoicePanel,
    handleComputerUseToggle, handleGmailToggle, handleGoogleCalendarToggle,
    handleGoogleDriveToggle, handleSpotifyToggle, handleWordConnectorToggle,
    handleExcelConnectorToggle,
    closeAllToolsAndConnectors,
    setAudioTab,
    handleAndUploadFiles,
    isUploading,
    isWebSearching: isCurrentChatLocalJobBusy && isWebSearching,
    isLoading: isCurrentChatLoading,
    isGeneratingImage: isCurrentChatLocalJobBusy && isGeneratingImage,
    isGeneratingVideo: isCurrentChatLocalJobBusy && isGeneratingVideo,
    isGeneratingPPT,
    isProcessingGmail: isCurrentChatLocalJobBusy && isProcessingGmail,
  };

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
        if (i >= 0) progress.providers[i].count += Math.max(0, count);
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
          const hasDoi = s.doiStatus === "format_valid" || (!!s.doi && /^10\.\d{4,9}\//i.test(String(s.doi)));
          if (s.doiResolutionStatus === "resolved") checks.push("✓ DOI resuelto en línea");
          else if (s.doiResolutionStatus === "not_found") checks.push("⚠ DOI no localizado");
          else if (hasDoi) checks.push("DOI con formato válido; resolución no confirmada");
          else if (s.url) checks.push("✓ URL");
          else checks.push("⚠ sin enlace");
          const yr = parseInt(String(s.year || s.published || ""), 10);
          const cutoff = new Date().getUTCFullYear() - 5;
          if (Number.isFinite(yr)) checks.push(yr >= cutoff ? "✓ reciente" : `⚠ ${yr}`);
          const url = String(s.url || s.doi || "").toLowerCase();
          if (/(\.edu|\.gov|\.ac\.|scielo|pubmed|crossref|wiley|springer|elsevier|nature)/.test(url)) {
            checks.push("✓ autoridad");
          }
          if (Number(s.sourceCount) >= 2) checks.push(`✓ ${s.sourceCount} índices`);
          if (s.publicationStage === "preprint") checks.push("⚠ preprint: sin revisión por pares confirmada");
          else if (s.peerReviewStatus === "confirmed") checks.push("✓ revisión por pares confirmada");
          else if (s.peerReviewStatus === "likely_peer_reviewed") checks.push("publicado en revista; revisión por pares no confirmada");
          if (s.studyType && s.studyType !== "unknown") checks.push(`tipo: ${String(s.studyType).replace(/_/g, " ")}`);
          if (s.integrityStatus === "corrected") checks.push("corrección registrada");
          if (s.integrityStatus === "expression_of_concern") checks.push("⚠ expresión de preocupación");
          if (s.integrityStatus === "retracted") checks.push("⚠ retractado");
          return checks.join(" · ");
        };
        const lines: string[] = [];
        lines.push(`## Resultados científicos priorizados`);
        lines.push(``);
        const crossValidated = sources.filter((source) => Number(source.sourceCount) >= 2).length;
        lines.push(`Encontré ${sources.length} ${sources.length === 1 ? "fuente" : "fuentes"} relevante${sources.length === 1 ? "" : "s"}, ordenadas por precisión temática, calidad de metadatos, autoridad del índice y coincidencia entre bases.`);
        if (crossValidated > 0) {
          lines.push(`${crossValidated} ${crossValidated === 1 ? "resultado fue corroborado" : "resultados fueron corroborados"} por más de una base académica.`);
        }
        lines.push(``);
        sources.forEach((s: any, idx: number) => {
          const link = s.doiResolvedUrl || (s.doi ? `https://doi.org/${s.doi}` : (s.url || ""));
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
                if ((evt as any).provider) bumpProvider(String((evt as any).provider), Math.max(0, Number((evt as any).unique) || 0));
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
              case 'validation_start':
                progress.phase = "validate";
                progress.label = "Comprobando DOI en línea";
                progress.counter = `${evt.candidates} candidatos`;
                progress.percent = 82;
                updateBubble(renderProgress());
                break;
              case 'validation_done':
                progress.phase = "validate";
                progress.label = "Comprobación DOI completada";
                progress.counter = `${evt.resolved} resueltos`;
                progress.percent = 86;
                updateBubble(renderProgress());
                break;
              case 'validation_error':
                progress.phase = "validate";
                progress.label = "Comprobación DOI parcial";
                progress.counter = "sin afirmaciones no verificadas";
                progress.percent = 86;
                updateBubble(renderProgress());
                break;
              case 'systematic_review':
                progress.phase = "validate";
                progress.label = "Cribado sistemático completado";
                progress.counter = `${evt.prisma.screening.recordsExcluded} excluidos · ${evt.prisma.screening.recordsUncertain} en duda`;
                progress.percent = 87;
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
              toast.error('Tu plan necesita una mejora para continuar.');
              updateBubble('Tu plan necesita una mejora para continuar usando búsqueda web.');
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

  // ─── Voice generation (deterministic text-to-speech) ─────────────────
  // Voice mode used to route through the agentic loop with a prompt that
  // *asked* a model to call generate_speech; weak fallback models often never
  // did, the finalize gate blocked, and the user got a degraded
  // "service unavailable" answer. Like image/video/music, Voice now uses a
  // dedicated, deterministic backend path that ALWAYS produces the MP3 and
  // persists it as a "Generation N" chat artifact via the same renderer.
  const handleVoiceGeneration = async (msg: string, filesToSend: any[] = []) => {
    const narration = (msg || '').trim();
    if (!narration) {
      toast.error('Escribe el texto que quieres convertir en voz');
      return;
    }

    let activeChat = currentChat;
    if (!activeChat) {
      try {
        const response = await apiClient.createChat({
          title: narration.substring(0, 30),
          model: selectedModel,
        });
        activeChat = response.chat;
        await selectChat(activeChat?.id ?? "");
        if (!activeChat?.id) {
          toast.error('No se pudo crear el chat para la voz');
          return;
        }
      } catch {
        toast.error('No se pudo crear el chat para la voz');
        return;
      }
    }

    voiceAbortControllerRef.current?.abort();
    const controller = new AbortController();
    voiceAbortControllerRef.current = controller;
    markLocalJobBusy(activeChat.id, controller);

    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: activeChat.id,
      role: 'USER' as const,
      content: narration,
      timestamp: new Date().toISOString(),
      files: snapshotComposerFilesForMessage(filesToSend),
    };
    setCurrentChat(prev => {
      if (!prev || prev.id !== activeChat!.id) return prev;
      return { ...prev, messages: [...(prev.messages || []), userMessage] };
    });

    const runningState = {
      meta: { goal: narration.slice(0, 200), model: selectedVoiceModel, tools: ['generate_speech'] },
      steps: [{
        id: 'speech-bootstrap',
        label: 'Generando audio',
        icon: 'thought',
        reasoning: `Convirtiendo el texto a voz con ${selectedVoiceModel}.`,
        status: 'running',
        toolCalls: [],
      }],
      artifacts: [],
      approvals: [],
      checkpoints: [],
      qualityGates: [],
      repairs: [],
      finalText: '',
      done: false,
    };
    const aiMessage = {
      id: `msg-ai-${Date.now() + 1}`,
      chatId: activeChat.id,
      role: 'ASSISTANT' as const,
      content: '```agent-task-state\n' + JSON.stringify(runningState) + '\n```',
      timestamp: new Date().toISOString(),
    };
    setCurrentChat(prev => {
      if (!prev || prev.id !== activeChat!.id) return prev;
      return { ...prev, messages: [...(prev.messages || []), aiMessage] };
    });
    const setBubble = (content: string) => {
      setCurrentChat(prev => {
        if (!prev || prev.id !== activeChat!.id) return prev;
        return { ...prev, messages: prev.messages.map(m => m.id === aiMessage.id ? { ...m, content } : m) };
      });
    };

    try {
      const resp = await apiClient.generateSpeechMessage({
        text: narration,
        chatId: activeChat.id,
        model: selectedVoiceModel,
        language: selectedVoiceLanguage,
        accent: selectedVoiceAccent,
        effect: selectedVoiceEffect,
        stability: selectedVoiceStability,
        voiceId: selectedVoiceModel === 'ElevenLabs' ? (selectedVoiceId || undefined) : undefined,
        voiceSettings: { stability: Math.min(1, Math.max(0, selectedVoiceStability / 100)) },
      }, { signal: controller.signal });
      if (resp?.content) {
        setBubble(resp.content);
      } else {
        throw new Error('El servicio de voz no devolvió audio.');
      }
      toast.success(resp?.model ? `Audio generado con ${resp.model}` : 'Audio generado');
      if (activeChat?.id) selectChat(activeChat.id);
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        const cancelledState = {
          ...runningState,
          done: true,
          error: 'aborted',
          steps: runningState.steps.map(s => ({ ...s, label: 'Generación detenida', status: 'error' })),
        };
        setBubble('```agent-task-state\n' + JSON.stringify(cancelledState) + '\n```');
        return;
      }
      const friendly = err?.message || 'No se pudo generar el audio. Intenta de nuevo.';
      const errorState = {
        ...runningState,
        done: true,
        error: friendly,
        steps: runningState.steps.map(s => ({ ...s, status: 'error' })),
      };
      setBubble('```agent-task-state\n' + JSON.stringify(errorState) + '\n```');
      toast.error(friendly);
    } finally {
      if (voiceAbortControllerRef.current === controller) {
        voiceAbortControllerRef.current = null;
      }
      markLocalJobIdle(activeChat.id, controller);
    }
  };

  // Edit-and-resend while Voice mode is active: regenerate the audio in place
  // with the modified text instead of falling through to normal chat. Reuses
  // editUserMessage (updates the user message + deletes the stale audio in the
  // DB), then calls the deterministic speech endpoint with regenerate:true so
  // only the new assistant audio is persisted (no duplicate user message).
  const handleVoiceEditResend = async (messageId: string, newContent: string) => {
    const narration = (newContent || '').trim();
    if (!currentChat) return;
    if (!narration) {
      toast.error('Escribe el texto que quieres convertir en voz');
      return;
    }
    const chatId = currentChat.id;
    const idx = currentChat.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      // The edited message vanished — fall back to a fresh voice turn.
      await handleVoiceGeneration(narration, []);
      return;
    }
    const messagesUpToEdit = currentChat.messages.slice(0, idx);
    const updatedUserMessage = { ...currentChat.messages[idx], content: narration };
    const runningState = {
      meta: { goal: narration.slice(0, 200), model: selectedVoiceModel, tools: ['generate_speech'] },
      steps: [{
        id: 'speech-bootstrap',
        label: 'Regenerando audio',
        icon: 'thought',
        reasoning: `Convirtiendo el texto editado a voz con ${selectedVoiceModel}.`,
        status: 'running',
        toolCalls: [],
      }],
      artifacts: [],
      approvals: [],
      checkpoints: [],
      qualityGates: [],
      repairs: [],
      finalText: '',
      done: false,
    };
    const aiMessage = {
      id: `msg-ai-voice-regen-${Date.now()}`,
      chatId,
      role: 'ASSISTANT' as const,
      content: '```agent-task-state\n' + JSON.stringify(runningState) + '\n```',
      timestamp: new Date().toISOString(),
    };
    setCurrentChat(prev => {
      if (!prev || prev.id !== chatId) return prev;
      return { ...prev, messages: [...messagesUpToEdit, updatedUserMessage, aiMessage] };
    });
    const setBubble = (content: string) => {
      setCurrentChat(prev => {
        if (!prev || prev.id !== chatId) return prev;
        return { ...prev, messages: prev.messages.map(m => m.id === aiMessage.id ? { ...m, content } : m) };
      });
    };

    voiceAbortControllerRef.current?.abort();
    const controller = new AbortController();
    voiceAbortControllerRef.current = controller;
    markLocalJobBusy(chatId, controller);
    isGeneratingVoiceRef.current = true;
    setIsGeneratingVoice(true);
    try {
      // Persist the edit + delete the stale subsequent messages server-side.
      await apiClient.editUserMessage(messageId, { content: narration });
      const resp = await apiClient.generateSpeechMessage({
        text: narration,
        chatId,
        regenerate: true,
        model: selectedVoiceModel,
        language: selectedVoiceLanguage,
        accent: selectedVoiceAccent,
        effect: selectedVoiceEffect,
        stability: selectedVoiceStability,
        voiceId: selectedVoiceModel === 'ElevenLabs' ? (selectedVoiceId || undefined) : undefined,
        voiceSettings: { stability: Math.min(1, Math.max(0, selectedVoiceStability / 100)) },
      }, { signal: controller.signal });
      if (resp?.content) {
        setBubble(resp.content);
      } else {
        throw new Error('El servicio de voz no devolvió audio.');
      }
      toast.success(resp?.model ? `Audio regenerado con ${resp.model}` : 'Audio regenerado');
      if (chatId) selectChat(chatId);
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        const cancelledState = {
          ...runningState,
          done: true,
          error: 'aborted',
          steps: runningState.steps.map(s => ({ ...s, label: 'Generación detenida', status: 'error' })),
        };
        setBubble('```agent-task-state\n' + JSON.stringify(cancelledState) + '\n```');
        return;
      }
      const friendly = err?.message || 'No se pudo regenerar el audio. Intenta de nuevo.';
      const errorState = {
        ...runningState,
        done: true,
        error: friendly,
        steps: runningState.steps.map(s => ({ ...s, status: 'error' })),
      };
      setBubble('```agent-task-state\n' + JSON.stringify(errorState) + '\n```');
      toast.error(friendly);
    } finally {
      if (voiceAbortControllerRef.current === controller) {
        voiceAbortControllerRef.current = null;
      }
      isGeneratingVoiceRef.current = false;
      setIsGeneratingVoice(false);
      markLocalJobIdle(chatId, controller);
    }
  };

  // Stable wrapper passed to the memoized MessageComponent. A ref keeps the
  // latest closure (isVoiceGenerationActive can toggle after the message
  // rendered) while the callback identity stays constant so memo isn't broken.
  const editRegenRef = React.useRef<(messageId: string, newContent: string, files?: any[]) => void>(() => {});
  React.useEffect(() => {
    editRegenRef.current = (messageId: string, newContent: string, files?: any[]) => {
      if (isVoiceGenerationActive) {
        void handleVoiceEditResend(messageId, newContent);
        return;
      }
      editAndRegenerate(messageId, newContent, files);
    };
  });
  const editAndRegenerateRouter = React.useCallback((messageId: string, newContent: string, files?: any[]) => {
    editRegenRef.current(messageId, newContent, files);
  }, []);

  const handleMusicGeneration = async (msg: string, filesToSend: any[] = []) => {
    const description = (msg || '').trim();
    if (!description) {
      toast.error('Describe la música que quieres crear');
      return;
    }

    let activeChat = currentChat;
    if (!activeChat) {
      try {
        const response = await apiClient.createChat({
          title: description.substring(0, 30),
          model: selectedModel,
        });
        activeChat = response.chat;
        await selectChat(activeChat?.id ?? "");
        if (!activeChat?.id) {
          toast.error('No se pudo crear el chat para la música');
          return;
        }
      } catch {
        toast.error('No se pudo crear el chat para la música');
        return;
      }
    }

    musicAbortControllerRef.current?.abort();
    const controller = new AbortController();
    musicAbortControllerRef.current = controller;
    markLocalJobBusy(activeChat.id, controller);

    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: activeChat.id,
      role: 'USER' as const,
      content: description,
      timestamp: new Date().toISOString(),
      files: snapshotComposerFilesForMessage(filesToSend),
    };
    setCurrentChat(prev => {
      if (!prev || prev.id !== activeChat!.id) return prev;
      return { ...prev, messages: [...(prev.messages || []), userMessage] };
    });

    const runningState = {
      meta: { goal: description.slice(0, 200), model: 'ElevenLabs Music', tools: ['generate_music'] },
      steps: [{
        id: 'music-bootstrap',
        label: 'Componiendo música',
        icon: 'thought',
        reasoning: 'Generando una pista original con ElevenLabs Music.',
        status: 'running',
        toolCalls: [],
      }],
      artifacts: [],
      approvals: [],
      checkpoints: [],
      qualityGates: [],
      repairs: [],
      finalText: '',
      done: false,
    };
    const aiMessage = {
      id: `msg-ai-${Date.now() + 1}`,
      chatId: activeChat.id,
      role: 'ASSISTANT' as const,
      content: '```agent-task-state\n' + JSON.stringify(runningState) + '\n```',
      timestamp: new Date().toISOString(),
    };
    setCurrentChat(prev => {
      if (!prev || prev.id !== activeChat!.id) return prev;
      return { ...prev, messages: [...(prev.messages || []), aiMessage] };
    });
    const setBubble = (content: string) => {
      setCurrentChat(prev => {
        if (!prev || prev.id !== activeChat!.id) return prev;
        return { ...prev, messages: prev.messages.map(m => m.id === aiMessage.id ? { ...m, content } : m) };
      });
    };

    try {
      const resp = await apiClient.generateMusicMessage({
        text: description,
        chatId: activeChat.id,
        durationSeconds: selectedMusicDuration,
        style: selectedMusicStyle,
        mood: selectedMusicMood,
        effect: selectedMusicEffect,
        influence: selectedMusicInfluence,
        model: selectedMusicModel,
      }, { signal: controller.signal });
      if (resp?.content) {
        setBubble(resp.content);
      } else {
        throw new Error('El servicio de música no devolvió audio.');
      }
      toast.success(resp?.model ? `Música generada con ${resp.model}` : 'Música generada');
      if (activeChat?.id) selectChat(activeChat.id);
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        const cancelledState = {
          ...runningState,
          done: true,
          error: 'aborted',
          steps: runningState.steps.map(s => ({ ...s, label: 'Generación detenida', status: 'error' })),
        };
        setBubble('```agent-task-state\n' + JSON.stringify(cancelledState) + '\n```');
        return;
      }
      const friendly = err?.message || 'No se pudo generar la música. Intenta de nuevo.';
      const errorState = {
        ...runningState,
        done: true,
        error: friendly,
        steps: runningState.steps.map(s => ({ ...s, status: 'error' })),
      };
      setBubble('```agent-task-state\n' + JSON.stringify(errorState) + '\n```');
      toast.error(friendly);
    } finally {
      if (musicAbortControllerRef.current === controller) {
        musicAbortControllerRef.current = null;
      }
      markLocalJobIdle(activeChat.id, controller);
    }
  };

  // ─── Agent task (Claude-style step cards) ────────────────────────────
  // The chat bubble's `content` becomes a JSON-encoded payload wrapped
  // in a sentinel fence (```agent-task-state ... ```). MessageComponent
  // detects the fence and renders <AgenticStepsRenderer state={...}/>.
  // This way step cards live INSIDE the regular message bubble — no
  // parallel surface to maintain — and the persisted message survives
  // a chat reload (the JSON is the source of truth for replay).
  const handleAgentTask = async (
    goalText: string,
    filesToSend: any[] = [],
    options: { userMessageAlreadyAdded?: boolean; assistantMessageId?: string; displayGoal?: string } = {},
  ) => {
    if (!goalText) {
      toast.error('Please enter a task');
      return;
    }
    if (isLiveComputerUsePrompt(goalText)) openComputerPanel();
    const { userMessageAlreadyAdded = false, assistantMessageId, displayGoal = goalText } = options;
    const systemContract = PROFESSIONAL_CAPABILITY_CONTRACTS.agent_task || '';

    // «Abre tu computadora y …» — show the live screen without asking for a
    // second click: the right-hand computer panel opens with the run.
    if (isComputerRequestPrompt(goalText)) {
      openComputerPanel();
    }
    let activeChat = currentChatRef.current;
    const liveChatId = activeChat?.id != null ? String(activeChat.id) : '';
    const needsRealChat = !activeChat || liveChatId.startsWith('temp-chat-');

    if (needsRealChat) {
      try {
        const response = await apiClient.createChat({
          title: displayGoal.substring(0, 30),
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

    const isUserRole = (m: any) => String(m?.role || '').toUpperCase() === 'USER';
    const isTempChatId = (id: unknown) => typeof id === 'string' && id.startsWith('temp-chat-');
    const shouldAdoptTempOntoReal = (prev: any) => Boolean(
      prev &&
      isTempChatId(prev.id) &&
      activeChat?.id &&
      !isTempChatId(activeChat.id) &&
      prev.id !== activeChat.id,
    );
    const liveHasUserTurn = (currentChatRef.current?.messages || []).some(isUserRole);

    try {
      // Graft a USER turn with files after createChat/selectChat even when the
      // optimistic path set userMessageAlreadyAdded: true — that flag is stale
      // if the temp-chat row was dropped while the real id was selected.
      if (!userMessageAlreadyAdded || !liveHasUserTurn) {
        const userMessage = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat.id,
          role: 'USER' as const,
          content: displayGoal,
          timestamp: new Date().toISOString(),
          files: snapshotComposerFilesForMessage(filesToSend),
        };
        setCurrentChat(prev => {
          const adoptingTemp = shouldAdoptTempOntoReal(prev);
          if (!prev) return { ...activeChat, messages: [userMessage] } as any;
          if (prev.id !== activeChat.id && !adoptingTemp) return prev;
          const baseMessages = prev.messages || [];
          const nextChat = adoptingTemp ? { ...activeChat, messages: baseMessages } : prev;
          if (baseMessages.some(isUserRole)) return nextChat;
          return { ...nextChat, messages: [...baseMessages, userMessage] };
        });
      }

      const clientBootstrapStepId = 'client-agent-bootstrap';
      const resolvedAssistantMessageId = assistantMessageId || `msg-ai-${Date.now() + 1}`;
      const makeInitialTaskState = (): AgentTaskState => ({
        ...initialAgentState,
        meta: {
          ...(initialAgentState.meta || {}),
          assistantMessageId: resolvedAssistantMessageId,
        },
        steps: [{
          id: clientBootstrapStepId,
          label: 'Analizando solicitud',
          icon: 'thought',
          reasoning: 'Preparando el plan, las fuentes y las herramientas antes de ejecutar la tarea.',
          status: 'running',
          retryCount: 1,
          toolCalls: [],
        }],
        artifacts: [],
        approvals: [],
        checkpoints: [],
        qualityGates: [],
        repairs: [],
      });
      const settleClientBootstrapStep = (current: AgentTaskState): AgentTaskState => {
        if (!current.steps.some(step => step.id === clientBootstrapStepId && step.status === 'running')) return current;
        return {
          ...current,
          steps: current.steps.map(step =>
            step.id === clientBootstrapStepId ? { ...step, status: 'done' as const } : step
          ),
        };
      };

      const initialTaskState = makeInitialTaskState();
      const aiMessage = {
        id: resolvedAssistantMessageId,
        chatId: activeChat.id,
        role: 'ASSISTANT' as const,
        content: '```agent-task-state\n' + JSON.stringify(initialTaskState) + '\n```',
        timestamp: new Date().toISOString(),
      };
      setCurrentChat(prev => {
        const adoptingTemp = shouldAdoptTempOntoReal(prev);
        if (!prev) {
          const seeded = (currentChatRef.current?.messages || []).filter(Boolean);
          const withUser = seeded.some(isUserRole)
            ? seeded
            : [...seeded, {
                id: `msg-user-${Date.now()}`,
                chatId: activeChat.id,
                role: 'USER' as const,
                content: displayGoal,
                timestamp: new Date().toISOString(),
                files: snapshotComposerFilesForMessage(filesToSend),
              }];
          return { ...activeChat, messages: [...withUser, aiMessage] } as any;
        }
        if (prev.id !== activeChat.id && !adoptingTemp) return prev;
        const messages = prev.messages || [];
        const replaced = messages.some(m => m.id === aiMessage.id);
        return {
          ...(adoptingTemp ? { ...activeChat } : prev),
          messages: replaced
            ? messages.map(m => m.id === aiMessage.id ? { ...m, ...aiMessage, error: undefined, progressStage: undefined, progressPct: undefined } : m)
            : [...messages, aiMessage],
        };
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

      let state: AgentTaskState = makeInitialTaskState();
      let taskWasAborted = false;
      try {
        const fileIds = collectUploadFileIds(filesToSend);
        const fileMetadata = buildAgentFileMetadata(filesToSend);
        for await (const evt of agentTaskService.runIterator({
          goal: goalText,
          displayGoal,
          systemContract,
          files: fileIds,
          fileMetadata,
          chatId: activeChat.id,
          lastArtifactId: pickLastArtifactId(currentChatRef.current?.messages || activeChat?.messages),
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
          const eventType = (evt as any).type;
          if (eventType === 'step_start' || eventType === 'final_text' || eventType === 'done' || eventType === 'error') {
            state = settleClientBootstrapStep(state);
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
      // The task belongs to `activeChat`, but the user may have navigated to a
      // different conversation while it was running. Refresh only when that
      // chat is still visible; selecting the completed task's chat here would
      // steal focus and break the background-work contract.
      if (activeChat?.id && currentChatIdRef.current === activeChat.id) {
        void selectChat(activeChat.id);
      }
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
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
          <div className="composer-drop-ants pointer-events-none absolute inset-4 rounded-3xl" aria-hidden />
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/70 bg-background/95 p-10 text-center shadow-2xl">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Upload className="h-7 w-7" />
            </div>
            <p className="text-base font-semibold">Suelta tus archivos aquí</p>
            <p className="text-xs leading-5 text-muted-foreground">
              PDF, Office, imágenes, audio, video y datos — hasta 20 archivos, 100 MB c/u. Se conserva el orden en que los sueltes.
            </p>
          </div>
        </div>
      )}

      {/* Floating "reopen sidebar" button — appears when the sidebar
          is collapsed (we auto-collapse on Word/Excel/image/video to
          reclaim horizontal real estate). Pinned to the viewport edge
          so the user can always pop the sidebar back with one click. */}
      {/* Desktop only: mobile reopens the sheet from the header button,
          so the mid-screen tab never floats over message text on phones. */}
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
          style={rightPanelActive && !coworkMobileFullscreen
            ? {
                flex: '1 1 auto',
                minWidth: SPLIT_LEFT_MIN_PX,
                transition: isDraggingSplit ? undefined : 'flex-basis 300ms ease',
              }
            : undefined}
          className={cn(
            "relative h-full min-w-0 flex-col overflow-hidden",
            coworkMobileFullscreen ? "hidden" : "flex",
            !rightPanelActive && "w-full",
          )}
        >
          {/* Header */}
          <div ref={chatHeaderRef} className="chat-mobile-header absolute top-0 left-0 right-0 z-10">
            <div className="chat-header-row flex items-center justify-between">
              <div className="chat-header-left flex min-w-0 items-center gap-2">
                {/* Desktop toggles the sidebar from its own header; on mobile
                    the sheet needs an opener here — a quiet 40px ghost icon,
                    not the old prominent hamburger disc. */}
                {isSidebarMobile && !sidebarOpenMobile ? (
                  <button
                    type="button"
                    onClick={() => setSidebarOpenMobile(true)}
                    aria-label="Abrir el menú lateral"
                    title="Abrir el menú"
                    data-testid="chat-mobile-sidebar-open"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:hidden"
                  >
                    <SidebarOvalIcon className="h-[18px] w-[18px]" />
                  </button>
                ) : null}
              </div>
              <div className="chat-header-actions flex shrink-0 items-center gap-0.5">
                {currentChat?.id && (
                  <Button
                    variant={coworkPanelOpen ? "secondary" : "ghost"}
                    size="icon"
                    onClick={() => coworkPanelOpen ? setCoworkPanelOpen(false) : openCoworkPanel()}
                    title={coworkPanelOpen ? "Cerrar workspace" : "Abrir workspace y tareas"}
                    aria-label={coworkPanelOpen ? "Cerrar workspace" : "Abrir workspace y tareas"}
                    aria-pressed={coworkPanelOpen}
                    className="chat-header-icon-btn h-11 w-11 rounded-full"
                  >
                    <BriefcaseBusiness className="h-5 w-5" />
                  </Button>
                )}
                <Button
                  variant={computerPanelOpen ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => computerPanelOpen ? setComputerPanelOpen(false) : openComputerPanel()}
                  title="Computadora"
                  aria-label="Computadora"
                  aria-pressed={computerPanelOpen}
                  data-testid="chat-computer-button"
                  className="chat-header-icon-btn chat-computer-action h-11 w-11 rounded-full"
                >
                  <Monitor className="h-5 w-5" />
                </Button>
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
                {/* Upgrade CTA: keep the header clean for paid users.
                    Paid customers manage billing from the account/settings area. */}
                {(() => {
                  const isFree = isFreePlanName(currentPlan)
                  if (!isFree) return null

                  const isSplitActive = rightPanelActive
                  const showTextCta = !isSplitActive
                  return (
                    <Button
                      variant={showTextCta ? 'outline' : 'ghost'}
                      size={showTextCta ? 'sm' : 'icon'}
                      onClick={() => setSubscribeOpen(true)}
                      aria-label="Subir de plan"
                      title="Subir de plan"
                      className={cn(
                        !showTextCta && 'h-11 w-11 rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]',
                        showTextCta && 'h-11 gap-1.5 rounded-full px-3 text-[13px] font-semibold',
                        'chat-header-icon-btn',
                        'chat-plan-action',
                        'transition-all duration-200',
                      )}
                    >
                      {showTextCta ? (
                        <>
                          <PremiumCardIcon className="h-[18px] w-[24px] shrink-0 drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]" />
                          <span>Subir de plan</span>
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
                <VoiceCatalogModal
                  open={voiceCatalogOpen}
                  onOpenChange={setVoiceCatalogOpen}
                  selectedVoiceId={selectedVoiceId || null}
                  onSelectVoice={handleSelectVoice}
                  modelLabel={selectedVoiceModel}
                  language={selectedVoiceLanguage}
                  onLanguageChange={(v) => setSelectedVoiceLanguage(v as VoiceLanguage)}
                  languageOptions={VOICE_LANGUAGE_OPTIONS}
                  accent={selectedVoiceAccent}
                  onAccentChange={(v) => setSelectedVoiceAccent(v as VoiceAccent)}
                  accentOptions={VOICE_ACCENT_OPTIONS}
                  effect={selectedVoiceEffect}
                  onEffectChange={(v) => setSelectedVoiceEffect(v as VoiceEffect)}
                  effectOptions={VOICE_EFFECT_OPTIONS}
                  stability={selectedVoiceStability}
                  onStabilityChange={setSelectedVoiceStability}
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
                            void copyTextSafe(shareUrl).then((r) => {
                              toast[r.ok ? 'success' : 'error'](
                                r.ok
                                  ? 'Enlace copiado al portapapeles'
                                  : 'No se pudo copiar. Selecciónalo y cópialo manualmente.',
                              );
                            });
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
              <div className="chat-composer-frame">
                  <div className="space-y-3">
                  <CredentialWarning text={input} />
                  {renderChatComposer()}

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
                  {/* Messages — `min-h-0` is REQUIRED so this flex-1 scroll
                      area can shrink below its content size. Without it the
                      flex item's implicit `min-height:auto` lets it grow with
                      the message list and push the composer dock off a short
                      (mobile) viewport — the "la barra de chat desaparece"
                      bug after the 2nd message. */}
                  <ScrollArea className="chat-message-scroll flex-1 min-h-0 w-full" ref={scrollAreaRef} onClickCapture={handleMessageAreaClick}>
                    <div
                      role="log"
                      aria-live="polite"
                      aria-relevant="additions"
                      className="chat-log chat-message-scroll-content chat-conversation-column space-y-2 mx-auto w-full"
                    >
                      <ChatMessageList
                        messages={currentChat?.messages ?? EMPTY_CHAT_MESSAGES}
                        isStreaming={isCurrentChatStreaming}
                        radixViewport={radixViewport}
                        user={user}
                        onRegenerate={regenerateMessage}
                        onBranch={branchMessage}
                        updateMessageInChat={editAndRegenerateRouter}
                        onToggleSplitView={handleToggleSplitView}
                        onDocumentPreview={handleDocumentPreview}
                        onAttachmentPreview={handleAttachmentPreview}
                        onOpenSources={handleOpenSources}
                      />
                      <div
                        ref={chatLogEndRef}
                        className="chat-log-end sr-only"
                        tabIndex={-1}
                        aria-hidden="true"
                      />
                    </div>
                  </ScrollArea>

                  {/* Input & Actions */}

                  <div ref={chatComposerDockRef} className="chat-composer-dock sticky bottom-0 left-0 right-0 z-10">
                    <div className="chat-composer-frame relative flex flex-col gap-2">
                      {/* Queued-tasks chip — while the agent is thinking the
                          user can keep sending; messages park in a queue and
                          run in order. This makes that visible (the queue is
                          otherwise a silent ref). */}
                      {queuedCount > 0 && (
                        <div className="flex items-center justify-center" aria-live="polite">
                          <div className="inline-flex items-center gap-1 rounded-full border border-border/55 bg-muted/50 p-1 pl-2.5 text-[11px] font-medium text-muted-foreground">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-[hsl(var(--accent-violet))] opacity-75" />
                              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent-violet))]" />
                            </span>
                            <span>{queuedCount} {queuedCount === 1 ? "tarea en cola" : "tareas en cola"}</span>
                            <button
                              type="button"
                              onClick={restoreLastQueuedMessage}
                              className="inline-flex h-11 items-center rounded-full px-2.5 text-foreground/80 transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-7"
                            >
                              Editar última
                            </button>
                            <button
                              type="button"
                              onClick={removeLastQueuedMessage}
                              aria-label="Quitar última tarea de la cola"
                              title="Quitar última tarea"
                              className="inline-grid h-11 w-11 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-7 sm:w-7"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      )}
                      {/* Scroll-to-bottom pill — only shown when the user has
                          scrolled up. It floats like ChatGPT's affordance so it
                          does not reserve a full-width blank row above the
                          composer or fade the final lines of the transcript. */}
                      <div
                        aria-live="polite"
                        data-testid="chat-scroll-to-bottom"
                        className={cn(
                          "absolute left-1/2 -top-11 z-20 flex -translate-x-1/2 justify-center",
                          "transition-[opacity,transform] duration-base ease-smooth",
                          isAtBottom
                            ? "pointer-events-none translate-y-2 opacity-0"
                            : "translate-y-0 opacity-100",
                          queuedCount > 0 && "!-top-[5.25rem]",
                        )}
                      >
                        <button
                          type="button"
                          onClick={scrollToBottom}
                          tabIndex={isAtBottom ? -1 : 0}
                          aria-hidden={isAtBottom ? true : undefined}
                          aria-label={isCurrentChatStreaming ? "Nuevos mensajes, ir al final" : "Ir al final de la conversación"}
                          className={cn(
                            "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5",
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

                      <CredentialWarning text={input} />
                      {renderChatComposer()}
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
              currentUrl={computerUseCurrentUrl || computerUseFinalUrl}
              actions={computerUseActions}
              takeoverState={computerUseTakeoverState}
              onStop={() => { void stopComputerUse(); }}
              onPause={() => sendControllerCommand("pause-session")}
              onTakeover={() => sendControllerCommand("takeover-start")}
              onRelease={() => sendControllerCommand("takeover-end")}
              onUserClick={(point) => sendUserAction({ type: "click", x: point.x, y: point.y })}
              onUserType={(text) => sendUserAction({ type: "type", text })}
              onClose={() => {
                void stopComputerUse();
                setIsComputerUseActive(false);
                setComputerUseAppMode(null);
                setChatType('text');
              }}
            />
          </div>
        )}

        {/* Resizable right panel — Word / Excel / Document preview.
            Rendered together with the 6px col-resize divider so the
            user can drag the split from 25% to 75% and double-click
            to reset to 50/50. Persisted in localStorage. */}
        {rightPanelActive && (
          <>
            {!coworkMobileFullscreen && (
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
            )}
            <div
              style={{
                width: coworkMobileFullscreen
                  ? '100%'
                  : showAudioPanel
                  ? `clamp(320px, ${100 - effectiveSplitRatio}%, 420px)`
                  : coworkPanelOpen
                    ? 'clamp(320px, 42vw, 720px)'
                  : computerPanelOpen
                    ? 'clamp(320px, 48vw, 880px)'
                  : searchActivityPanelOpen
                    ? `clamp(${SEARCH_ACTIVITY_RIGHT_MIN_PX}px, 34vw, ${SEARCH_ACTIVITY_RIGHT_MAX_PX}px)`
                  : `clamp(${SPLIT_RIGHT_MIN_PX}px, ${100 - effectiveSplitRatio}%, 62%)`,
                transition: isDraggingSplit ? undefined : 'width 300ms ease',
              }}
              className="h-full min-w-0 overflow-hidden shrink-0"
            >
              {coworkPanelOpen && currentChat?.id && (
                <CoworkPanel
                  chatId={currentChat.id}
                  onClose={() => setCoworkPanelOpen(false)}
                />
              )}
              {computerPanelOpen && (
                <ChatAgentComputerPanel
                  key={currentChat?.id || "none"}
                  conversationId={currentChat?.id || ""}
                  loginHandoff={loginHandoffActive}
                  loginHandoffSite={loginHandoffSite}
                  loginHandoffKind={loginHandoffKind}
                  onClose={() => {
                    setComputerPanelOpen(false)
                    setLoginHandoffActive(false)
                  }}
                />
              )}
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
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && activeSearchActivity && (
                <SearchActivityPanel
                  activity={activeSearchActivity}
                  onClose={closeSearchActivityPanel}
                  onSave={saveSearchActivityToLibrary}
                />
              )}
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && documentPreviewUrl && (
                <DocumentPreview
                  url={documentPreviewUrl}
                  onClose={() => setDocumentPreviewUrl(null)}
                />
              )}
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && !documentPreviewUrl && composerPreviewAttachment && (
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
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && !documentPreviewUrl && !composerPreviewAttachment && sidePreviewAttachment && (
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
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && !composerPreviewAttachment && !sidePreviewAttachment && isWordConnectorActive && (
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
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && !composerPreviewAttachment && !sidePreviewAttachment && isExcelConnectorActive && (
                <React.Suspense fallback={<div className="h-full w-full animate-pulse bg-muted/30" aria-hidden="true" />}>
                  <ExcelConnector
                    ref={excelConnectorRef}
                    onClose={() => setIsExcelConnectorActive(false)}
                    isGeneratingExternal={isGeneratingExcel}
                  />
                </React.Suspense>
              )}
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && activeArtifact && !isWordConnectorActive && !isExcelConnectorActive && !documentPreviewUrl && !composerPreviewAttachment && !sidePreviewAttachment && (
                <ArtifactPanel />
              )}
              {!coworkPanelOpen && !computerPanelOpen && !showAudioPanel && !activeSearchActivity && !activeArtifact && !isWordConnectorActive && !isExcelConnectorActive && !documentPreviewUrl && !composerPreviewAttachment && !sidePreviewAttachment && sourcesPanelData && (
                <SourcesPanel
                  sources={sourcesPanelData.sources}
                  activity={sourcesPanelData.activity}
                  memory={sourcesPanelData.memory}
                  memoryMeta={sourcesPanelData.memoryMeta}
                  onClose={() => setSourcesPanelData(null)}
                />
              )}
            </div>
          </>
        )}
        {previewUsesOverlay && documentPreviewUrl && (
          <DocumentPreview
            url={documentPreviewUrl}
            onClose={() => setDocumentPreviewUrl(null)}
          />
        )}
        {previewUsesOverlay && !documentPreviewUrl && composerPreviewAttachment && (
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
        {previewUsesOverlay && !documentPreviewUrl && !composerPreviewAttachment && sidePreviewAttachment && (
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
      </div>
    </div >
  )
}
