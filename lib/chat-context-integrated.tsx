"use client"

// KaTeX styles for rendered LaTeX inside markdown chat messages. Imported
// here (where katex is actually used) instead of in app/layout.tsx so the
// stylesheet doesn't bloat the global layout chunk past the Replit dev
// proxy's response size cap.
import "katex/dist/katex.min.css"
import React from "react"
import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react"
import { useAuth } from "./auth-context-integrated"
import { apiClient } from "./api"
import { shouldRecoverImageGenerationViaPolling } from "./image-generation-recovery"
import { aiService, buildProfessionalCapabilityPrompt, shouldUseExistingDocumentFileContext, type ChatIntent } from "./ai-service"
import { buildDocumentChatRequest } from "./document-chat-request"
import { hasCompletedAgentTaskAssistantContent, mergeChatPreservingUserMessages } from "./message-preservation"
import { toast } from "sonner"
import { useBackgroundStreams } from "./background-streams-context"
import {
  save as savePending,
  clear as clearPending,
  retryAll,
  subscribeOnlineRetry,
  type PendingMessage,
} from "./pending-messages"
import { devLog } from "./dev-log"
import { createStreamBuffer, type StreamBuffer } from "./stream-buffer"

// safeUUID: crypto.randomUUID() only exists in secure contexts (HTTPS or
// http://localhost). When the app is opened over a LAN IP / plain HTTP it is
// undefined and throws "crypto.randomUUID is not a function", breaking every
// message send. This falls back to getRandomValues, then Math.random.
function safeUUID(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
    }
  } catch (_) {}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}


// Helper function to check if error is related to monthly API limit
const isMonthlyLimitError = (errorMessage: string) => {
  const lowerMessage = errorMessage.toLowerCase();
  return lowerMessage.includes('monthly api limit exceeded') ||
    lowerMessage.includes('monthly limit exceeded') ||
    lowerMessage.includes('monthly video generation limit exceeded') ||
    lowerMessage.includes('free monthly queries exhausted') ||
    lowerMessage.includes('free daily queries exhausted') ||
    (lowerMessage.includes('monthly') && lowerMessage.includes('limit')) ||
    (lowerMessage.includes('daily') && lowerMessage.includes('limit'));
};

const normalizeChatError = (raw: string): string => {
  if (/does not support image/i.test(raw)) {
    return "El modelo seleccionado no admite imágenes. Intenta con un modelo compatible con visión o adjunta documentos en lugar de imágenes."
  }
  if (/cannot read.*image/i.test(raw)) {
    return "No se pudieron procesar las imágenes adjuntas con este modelo. Intenta con un modelo compatible con visión."
  }
  if (/image input/i.test(raw)) {
    return "El modelo no soporta entrada de imagen. Intenta con un modelo compatible con visión o adjunta documentos en lugar de imágenes."
  }
  if (/content.*policy|safety/i.test(raw)) {
    return "La solicitud no pudo ser procesada debido a las políticas de contenido."
  }
  if (/context.*(window|length|token|exceed)/i.test(raw)) {
    return "El mensaje es demasiado largo para el modelo seleccionado. Intenta reducir el contenido o usar un modelo con mayor capacidad de contexto."
  }
  if (/quota|billing|payment|subscription/i.test(raw)) {
    return "Se alcanzó el límite de uso del proveedor. Intenta más tarde o usa un modelo diferente."
  }
  if (/429|rate.?limit|too many/i.test(raw)) {
    return "El servidor está procesando muchas solicitudes. Intenta de nuevo en unos segundos."
  }
  if (/auth|api.?key|401|403|invalid.*key/i.test(raw)) {
    return "Error de configuración del servicio. Por favor contacta al administrador."
  }
  if (/timeout|timed.?out|ETIMEDOUT/i.test(raw)) {
    return "La solicitud tardó demasiado. Intenta de nuevo."
  }
  if (/failed to fetch|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(raw)) {
    return "No se pudo conectar con el modelo. Verifica tu conexión e intenta de nuevo."
  }
  return raw
};

// Helper function to trigger upgrade modal
const triggerUpgradeModal = (errorMessage: string, errorData?: any) => {
  if (typeof window !== 'undefined') {
    // Trigger upgrade modal
    window.dispatchEvent(new CustomEvent('open-upgrade-modal'));

    // Show toast with usage info if available
    let usageInfo = '';
    if (errorData && errorData.usage) {
      const { current, limit } = errorData.usage;
      usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
    }
    toast.error(`Monthly API limit exceeded.${usageInfo ? ' ' + usageInfo : ''} Please upgrade to continue.`);
  }
};

const resolveAttachmentId = (file: any): string | null => {
  if (!file) return null;
  if (typeof file === 'string') return file;
  return file.id || file.fileId || file.attachmentId || null;
};

const normalizeMessageAttachment = (file: any) => {
  if (!file || typeof file === 'string') return file;
  const name = file.originalName || file.name || file.filename || 'archivo';
  const mimeType = file.mimeType || file.type || file.contentType || null;
  const longPasteMeta =
    file.longPasteMeta ||
    file.longPasteMetadata ||
    file.__siraLongPaste ||
    file.file?.__siraLongPaste ||
    null;
  const longPasteTitle = file.longPasteTitle || longPasteMeta?.title || null;
  return {
    id: resolveAttachmentId(file),
    name: longPasteTitle || name,
    originalName: longPasteTitle || file.originalName || name,
    filename: file.filename || name,
    mimeType,
    type: typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : (file.type || mimeType),
    size: file.size ?? null,
    url: file.url || file.imageUrl || null,
    preview: file.preview || file.objectUrl || null,
    thumbnailUrl: file.thumbnailUrl || null,
    path: file.path || null,
    extractedText: file.extractedText || null,
    openaiFileId: file.openaiFileId || null,
    sourceChannel: file.sourceChannel || null,
    isLongPasteDocument: Boolean(file.isLongPasteDocument || longPasteTitle),
    longPasteTitle,
    longPastePreview: file.longPastePreview || longPasteMeta?.preview || null,
    longPasteMeta: longPasteMeta ? {
      kind: 'long_paste_document',
      title: longPasteMeta.title,
      filename: longPasteMeta.filename,
      preview: longPasteMeta.preview,
      originalCharCount: longPasteMeta.originalCharCount,
      originalWordCount: longPasteMeta.originalWordCount,
      originalLineCount: longPasteMeta.originalLineCount,
      createdAt: longPasteMeta.createdAt,
    } : null,
  };
};

const DOCUMENT_CONTEXT_EXT_RE = /\.(?:docx?|pdf|xlsx?|csv|pptx?|txt|md)$/i;
const DOCUMENT_CONTEXT_MIME_RE =
  /(?:application\/(?:pdf|msword|vnd\.openxmlformats-officedocument|vnd\.ms-|vnd\.oasis\.opendocument)|text\/(?:plain|markdown|csv)|application\/csv)/i;

const parseMessageFiles = (files: any): any[] => {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === 'string') {
    try {
      const parsed = JSON.parse(files);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const isDocumentContextAttachment = (file: any) => {
  if (!file) return false;
  if (typeof file === 'string') return DOCUMENT_CONTEXT_EXT_RE.test(file);
  const mimeType = String(file.mimeType || file.type || file.contentType || '');
  const name = String(file.name || file.originalName || file.filename || file.path || '');
  if (mimeType.startsWith('image/') || file.type === 'image') return false;
  return DOCUMENT_CONTEXT_EXT_RE.test(name) || DOCUMENT_CONTEXT_MIME_RE.test(mimeType);
};

const collectRecentDocumentContextIds = (messages: any[] = []) => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of [...messages].reverse()) {
    for (const file of parseMessageFiles(message?.files)) {
      if (!isDocumentContextAttachment(file)) continue;
      const id = resolveAttachmentId(file);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 4) return ids;
    }
  }
  return ids;
};

interface Message {
  id: string
  chatId: string
  role: "USER" | "ASSISTANT"
  content: string
  tokens?: number
  timestamp: string
  files?: any[]
  videoData?: {
    operationId: string
    status: 'processing' | 'completed' | 'failed'
    filename?: string
    prompt?: string
    error?: string
  }
  thesisData?: {
    sessionId: string
    status: 'initializing' | 'searching' | 'generating' | 'completed' | 'error'
    progress: number
    message: string
    topics: string[]
    sourcesCount?: number
    documentPath?: string
    documentFilename?: string
    error?: string
  }
  presentation?: string // Add this line
  error?: any
  metadata?: string
  sources?: Array<{
    title: string
    url: string
    snippet?: string
    domain?: string
    confidence?: string
  }>
  searchActivity?: {
    provider?: string
    query?: string
    elapsedMs?: number
  }
  memory?: Array<{
    fact: string
    category?: string
    tier?: string
    strength?: number | null
    score?: number | null
  }>
  memoryMeta?: {
    reason?: string
    recalled?: number
  }
  // Claude-style extended thinking (ThinkingTrace). Live streams accumulate
  // `reasoning` from `reasoning_delta` frames with `reasoningStreaming: true`
  // until `reasoning_done` arrives with the duration; historical messages get
  // `reasoning` straight from the persisted column and the duration from
  // metadata.reasoningDurationMs.
  reasoning?: string
  reasoningStreaming?: boolean
  reasoningDurationMs?: number | null
  reasoningToolCalls?: Array<{ index: number; name?: string; args?: string }>
  // Agent harness (AgentTrace). Live streams accumulate `agentSteps` from the
  // typed tool_call_start / tool_executing / tool_result frames (ordered by
  // blockIndex+seq) until `agent_done` closes `agentRun`; historical messages
  // hydrate both from the persisted `agentMetadata` column (see
  // extractAgentTrace in message-component).
  agentSteps?: AgentStepClient[]
  agentRun?: AgentRunClient | null
  agentPermission?: AgentPermissionClient | null
  agentMetadata?: any
}

export interface AgentStepClient {
  id: string
  blockIndex: number
  seq: number
  type: 'tool_call'
  name: string
  humanDescription?: string
  args?: string
  preview?: string
  status: 'planned' | 'executing' | 'completed' | 'error' | 'denied' | 'interrupted'
  isError?: boolean
  durationMs?: number
}

export interface AgentRunClient {
  status: 'running' | 'completed' | 'interrupted'
  toolCalls?: number
  errors?: number
  durationMs?: number
  tokensEstimate?: number
  costUsdEstimate?: number | null
  stoppedReason?: string | null
}

export interface AgentPermissionClient {
  permissionId: string
  id: string
  name: string
  humanDescription?: string
  args?: string
}

function parseMessageMetadata(metadata: unknown): Record<string, any> {
  if (!metadata) return {}
  if (typeof metadata === 'object') return metadata as Record<string, any>
  if (typeof metadata !== 'string') return {}
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Per-stream reasoning handlers for the typed SSE frames (reasoning_delta /
 * reasoning_done / tool_call_delta). All chat-state writes go through
 * functional `setChat` updates keyed by the placeholder message id, so
 * interleaved text/reasoning/tool deltas can never clobber each other; the
 * delta accumulator itself is closure-local to ONE stream. Reasoning deltas
 * are flushed on a short timer (~80ms) instead of per-token to keep the
 * markdown re-render cost bounded.
 */
function createReasoningHandlers(opts: {
  setChat: (updater: (prev: any) => any) => void
  messageId: string
  isCancelled: () => boolean
}) {
  const { setChat, messageId, isCancelled } = opts
  let reasoningAcc = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const toolCalls = new Map<number, { index: number; name?: string; args: string }>()

  const patchMessage = (patch: Record<string, any>) => {
    setChat((prevChat: any) => {
      if (!prevChat) return prevChat
      const newMessages = prevChat.messages.map((msg: any) =>
        msg.id === messageId ? { ...msg, ...patch } : msg
      )
      return { ...prevChat, messages: newMessages }
    })
  }

  const flush = (streaming: boolean, durationMs?: number) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    patchMessage({
      reasoning: reasoningAcc,
      reasoningStreaming: streaming,
      ...(durationMs !== undefined ? { reasoningDurationMs: durationMs } : {}),
    })
  }

  return {
    onReasoning: (delta: string) => {
      if (isCancelled()) return
      reasoningAcc += delta
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(true) }, 80)
    },
    onReasoningDone: (durationMs: number) => {
      if (isCancelled()) return
      flush(false, durationMs)
    },
    onToolCall: (payload: { index: number; name?: string; argsDelta?: string }) => {
      if (isCancelled()) return
      const existing = toolCalls.get(payload.index) || { index: payload.index, args: '' }
      if (payload.name) existing.name = payload.name
      if (payload.argsDelta) existing.args += payload.argsDelta
      toolCalls.set(payload.index, existing)
      patchMessage({ reasoningToolCalls: Array.from(toolCalls.values()) })
    },
  }
}

/**
 * Per-stream handlers for the agent-harness typed SSE frames
 * (tool_call_start / tool_executing / tool_result / permission_request /
 * permission_resolved / agent_done). Steps are keyed by call id and ordered
 * by (blockIndex, seq); a stale frame (seq ≤ the one already applied to that
 * step) is dropped, which makes the reducer safe under reconnects and
 * out-of-order delivery. Same functional-setChat discipline as
 * createReasoningHandlers so agent frames never clobber text/reasoning state.
 */
function createAgentTraceHandlers(opts: {
  setChat: (updater: (prev: any) => any) => void
  messageId: string
  isCancelled: () => boolean
}) {
  const { setChat, messageId, isCancelled } = opts
  const steps = new Map<string, AgentStepClient>()
  let lastSeqByStep = new Map<string, number>()

  const patchMessage = (patch: Record<string, any>) => {
    setChat((prevChat: any) => {
      if (!prevChat) return prevChat
      const newMessages = prevChat.messages.map((msg: any) =>
        msg.id === messageId ? { ...msg, ...patch } : msg
      )
      return { ...prevChat, messages: newMessages }
    })
  }

  const orderedSteps = () =>
    Array.from(steps.values()).sort((a, b) => (a.blockIndex - b.blockIndex) || (a.seq - b.seq))

  return {
    onAgentEvent: (event: import('./api').AgentStreamEvent) => {
      if (isCancelled() && event.type !== 'agent_done') return
      switch (event.type) {
        case 'tool_call_start': {
          const prevSeq = lastSeqByStep.get(event.id) || 0
          if (event.seq <= prevSeq) return
          lastSeqByStep.set(event.id, event.seq)
          steps.set(event.id, {
            id: event.id,
            blockIndex: event.blockIndex,
            seq: event.seq,
            type: 'tool_call',
            name: event.name,
            humanDescription: event.humanDescription,
            args: event.args,
            status: 'planned',
          })
          patchMessage({ agentSteps: orderedSteps(), agentRun: { status: 'running' } })
          break
        }
        case 'tool_executing': {
          const step = steps.get(event.id)
          if (!step || event.seq <= (lastSeqByStep.get(event.id) || 0)) return
          lastSeqByStep.set(event.id, event.seq)
          steps.set(event.id, { ...step, status: 'executing' })
          patchMessage({ agentSteps: orderedSteps() })
          break
        }
        case 'tool_result': {
          const step = steps.get(event.id)
          if (!step || event.seq <= (lastSeqByStep.get(event.id) || 0)) return
          lastSeqByStep.set(event.id, event.seq)
          steps.set(event.id, {
            ...step,
            status: event.status === 'denied' ? 'denied'
              : event.status === 'interrupted' ? 'interrupted'
                : event.isError ? 'error' : 'completed',
            isError: Boolean(event.isError),
            preview: event.preview,
            durationMs: event.durationMs,
          })
          patchMessage({ agentSteps: orderedSteps() })
          break
        }
        case 'permission_request': {
          patchMessage({
            agentPermission: {
              permissionId: event.permissionId,
              id: event.id,
              name: event.name,
              humanDescription: event.humanDescription,
              args: event.args,
            },
          })
          break
        }
        case 'permission_resolved': {
          patchMessage({ agentPermission: null })
          break
        }
        case 'agent_done': {
          patchMessage({
            agentPermission: null,
            agentSteps: orderedSteps(),
            agentRun: {
              status: event.interrupted ? 'interrupted' : 'completed',
              toolCalls: event.toolCalls,
              errors: event.errors,
              durationMs: event.durationMs,
              tokensEstimate: event.tokensEstimate,
              costUsdEstimate: event.costUsdEstimate ?? null,
              stoppedReason: event.stoppedReason ?? null,
            },
          })
          break
        }
      }
    },
  }
}

function getRegenerationAttempt(message?: Message | null): number {
  const meta = parseMessageMetadata(message?.metadata)
  const raw = meta?.regeneration?.attempt ?? meta?.regenerationAttempt ?? meta?.regenerateAttempt
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.min(999, Math.floor(value)) : 0
}

type VideoGenerationOptions = {
  resolution?: '480p' | '720p'
  aspectRatio?: 'auto' | '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
  duration?: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
  audio?: boolean
  model?: string
  sourceImageUrls?: string[]
  // Optional cancel signal so the composer can abort the kickoff request,
  // mirroring the dedicated AbortController image generation already uses.
  signal?: AbortSignal
}

// Update the Chat interface around line 24

interface Chat {
  id: string
  userId: string
  title: string
  model: string
  isWordConnectorChat?: boolean
  wordContent?: string
  isExcelConnectorChat?: boolean
  excelContent?: any
  createdAt: string
  updatedAt: string
  messages: Message[]
  customGptId?: string
  projectId?: string | null
  project?: {
    id: string
    name: string
    description?: string | null
    instructions?: string | null
    isStarred?: boolean
    shareId?: string | null
    createdAt?: string
    updatedAt?: string
    files?: Array<{
      id: string
      originalName: string
      mimeType: string
      size: number
      createdAt?: string
    }>
    documents?: Array<{
      id: string
      title: string
      updatedAt?: string
    }>
    _count?: {
      files: number
      chats: number
      memories: number
      documents: number
    }
  } | null
  customGpt?: {
    id: string
    name: string
    description?: string
    iconUrl?: string
    instructions?: string
    greetingMessage?: string
    conversationStarters?: string[]
    modelName?: string
    temperature?: number
    visibility?: string
    shareId?: string
    knowledgeFiles?: Array<{
      id: string
      originalName: string
      extractedText?: string
    }>
  }
}
interface PaginationInfo {
  page: number
  limit: number
  total: number
  pages: number
}
interface ChatContextType {
  chats: Chat[]
  currentChat: Chat | null
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat | null>>
  createNewChat: (
    type?: 'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify' | 'computer-use' | 'thesis',
    initialContent?: string,
    initialFiles?: any[],
    options?: { skipInitialProcessing?: boolean; isWordConnectorChat?: boolean; isExcelConnectorChat?: boolean; projectId?: string; initialIntent?: ChatIntent; model?: string }
  ) => Promise<any>
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: any[], chat?: any, skipUserMessage?: boolean, intentOverride?: ChatIntent) => Promise<void>
  addVideoMessage: (prompt: string, fileIds?: string[], chat?: any, options?: VideoGenerationOptions) => Promise<void>
  addThesisMessage: (topics: string[]) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => Promise<boolean> | boolean
  selectedModel: string
  setSelectedModel: (model: string) => void
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
  selectProvider: string
  setSelectedProivder: (model: string) => void
  isLoading: boolean
  availableModels: any[]
  refreshModels: () => void | Promise<void>
  chatType: 'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify' | 'computer-use' | 'thesis'
  uploadedFiles: any[]
  setChatType: React.Dispatch<React.SetStateAction<'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify' | 'computer-use' | 'thesis'>>
  setUploadedFiles: React.Dispatch<React.SetStateAction<any[]>>
  regenerateLastMessage: () => void
  regenerateMessage: (messageId?: string) => void
  editAndRegenerate: (messageId: string, newContent: string, files?: any[]) => void
  updateMessageInChat: (messageId: string, newContent: string) => void
  pollVideoStatus: (operationId: string, messageId: string) => void,

  isStreaming: boolean;
  activeStreamingChatIds: string[];
  pendingStop: boolean;
  stopStreaming: () => void;
  pagination: PaginationInfo | null
  isLoadingMore: boolean
  hasMoreChats: boolean
  loadMoreChats: () => Promise<void>
  resetChats: () => void
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth()
  // Mirror streaming state into the BackgroundStreams context so
  // the sidebar can show an "N chats in progress" pill and streams
  // keep advertising progress even when the user navigates to a
  // different chat. The actual network call still lives here.
  const bg = useBackgroundStreams()
  const [chats, setChats] = useState<Chat[]>([])
  const [currentChat, setCurrentChat] = useState<Chat | null>(null)
  const [selectedModel, setSelectedModel] = useState("")
  // Composer reasoning-effort picker (Bajo/Medio/Extra/Max), Claude-style.
  // Persisted so the user's choice survives reloads; sent to the backend as
  // `reasoningEffort` and mapped to the compute plan there.
  const [selectedEffort, setSelectedEffortState] = useState<string>("Medio")
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("sira:composer:effort")
      if (saved) setSelectedEffortState(saved)
    } catch { /* ignore */ }
  }, [])
  const setSelectedEffort = useCallback((effort: string) => {
    setSelectedEffortState(effort)
    try { window.localStorage.setItem("sira:composer:effort", effort) } catch { /* ignore */ }
  }, [])
  const [selectProvider, setSelectedProivder] = useState("")
  const [availableModels, setAvailableModels] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])
  const [hasInitialized, setHasInitialized] = useState(false)
  const [chatType, setChatType] = useState<'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify' | 'computer-use' | 'thesis'>('text')
  const [pollingIntervals, setPollingIntervals] = useState<Map<string, NodeJS.Timeout>>(new Map())
  const [pagination, setPagination] = useState<PaginationInfo | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMoreChats, setHasMoreChats] = useState(true)
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeStreamingChatIds, setActiveStreamingChatIds] = useState<string[]>([]);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState(false);
  // Synchronous mirror for the stream-chunk guards. addMessage omits
  // pendingStop from its deps on purpose, so the callback closes over a
  // STALE value: after a stop, the next send captured pendingStop=true
  // forever and silently dropped every chunk of the new stream (the
  // backend answered; the UI never rendered it). Guards must read this
  // ref, never the state value.
  const pendingStopRef = useRef(false);
  const setPendingStopSynced = useCallback((value: boolean) => {
    pendingStopRef.current = value;
    setPendingStop(value);
  }, []);

  const abortControllerRef = useRef<AbortController | null>(null);
  const streamControllersRef = useRef<Map<string, { streamId: string; controller: AbortController }>>(new Map());
  const activeStreamingChatIdsRef = useRef<Set<string>>(new Set());
  const streamBufferRef = useRef<StreamBuffer | null>(null);
  const currentStreamIdRef = useRef<string | null>(null)
  const chatsRef = useRef<Chat[]>([])
  const isStreamingRef = useRef(false)
  const currentChatRef = useRef<Chat | null>(null)

  useEffect(() => { chatsRef.current = chats }, [chats])
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
  useEffect(() => { currentStreamIdRef.current = currentStreamId }, [currentStreamId])
  useEffect(() => { currentChatRef.current = currentChat }, [currentChat])

  const syncActiveStreamingState = useCallback(() => {
    const ids = Array.from(activeStreamingChatIdsRef.current)
    setActiveStreamingChatIds(ids)
    setIsStreaming(ids.length > 0)
    setIsLoading(ids.length > 0)
  }, [])

  const markChatStreaming = useCallback((chatId: string, streamId?: string, controller?: AbortController) => {
    if (!chatId) return
    activeStreamingChatIdsRef.current.add(chatId)
    if (streamId && controller) {
      streamControllersRef.current.set(chatId, { streamId, controller })
    }
    if (currentChatRef.current?.id === chatId && streamId) {
      currentStreamIdRef.current = streamId
      setCurrentStreamId(streamId)
    }
    syncActiveStreamingState()
  }, [syncActiveStreamingState])

  const markChatIdle = useCallback((chatId: string, streamId?: string) => {
    if (!chatId) return
    const tracked = streamControllersRef.current.get(chatId)
    if (!streamId || !tracked || tracked.streamId === streamId) {
      streamControllersRef.current.delete(chatId)
      activeStreamingChatIdsRef.current.delete(chatId)
    }
    if (currentChatRef.current?.id === chatId) {
      currentStreamIdRef.current = null
      setCurrentStreamId(null)
    }
    syncActiveStreamingState()
  }, [syncActiveStreamingState])

  const discardActiveStreamForChat = useCallback(
    (chatId: string, options: { notifyBackend?: boolean } = {}) => {
      if (!chatId) return

      const tracked = streamControllersRef.current.get(chatId)
      const isCurrentChat = currentChatRef.current?.id === chatId
      const streamIdToStop = tracked?.streamId || (isCurrentChat ? currentStreamIdRef.current : null)

      // Abort the browser-side request immediately. Default text streams
      // are stored per chat in streamControllersRef; non-default streams
      // (doc/math/viz/plan/artifact) still use the legacy current-chat
      // abortControllerRef, so cover both paths.
      try { tracked?.controller.abort() } catch { /* already aborted */ }
      if (isCurrentChat && abortControllerRef.current) {
        try { abortControllerRef.current?.abort() } catch { /* already aborted */ }
        abortControllerRef.current = null
      }

      streamControllersRef.current.delete(chatId)
      activeStreamingChatIdsRef.current.delete(chatId)
      clearPending(chatId)
      bg.cancel(chatId)

      if (isCurrentChat) {
        currentStreamIdRef.current = null
        setCurrentStreamId(null)
        setPendingStopSynced(false)
        streamBufferRef.current?.dispose()
        streamBufferRef.current = null
      }

      syncActiveStreamingState()

      if (options.notifyBackend && streamIdToStop) {
        apiClient.stopAIStream(streamIdToStop)
          .catch((error) => {
            console.error("Failed to stop deleted chat stream:", error)
          })
      }
    },
    [bg, syncActiveStreamingState],
  )

  // Stable, identity-preserving snapshot getter for consumers that
  // need the full current chat occasionally (e.g. exporting from the
  // sidebar) without subscribing to its updates. Used by ChatList
  // consumers so the sidebar stays inert during token streams.
  const getCurrentChatSnapshot = useCallback(() => currentChatRef.current, [])

  // Dispose the per-frame stream buffer when the provider unmounts so a
  // late rAF callback can't fire setState on a torn-down tree.
  useEffect(() => {
    return () => {
      streamBufferRef.current?.dispose();
      streamBufferRef.current = null;
    };
  }, []);

  // Load user's chats
  useEffect(() => {
    if (user && token) {
      initializeChat()
    }
    // initializeChat has its own hasInitialized guard so it runs once
    // per session; listing it would lint-loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, token])

  const initializeChat = async () => {
    if (hasInitialized) return

    try {
      // Load available models first
      const modelsResponse = await apiClient.getAIModels(
        chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE' | 'VIDEO'
      )
      devLog("modelsResponse", modelsResponse);

      setAvailableModels(modelsResponse.models)

      // Set default model
      if (modelsResponse.models.length > 0 && !selectedModel) {
        devLog("default model selected:", modelsResponse.models[0]);

        setSelectedModel(modelsResponse.models[0].name)
        setSelectedProivder(modelsResponse.models[0].provider)
      }

      // Load chats
      await loadUserChats()
      setHasInitialized(true)
    } catch (error) {
      console.error("Failed to initialize chat:", error)
    }
  }

  useEffect(() => {
    const loadModelsForType = async () => {
      // Skip until the initial setup is complete.
      if (!hasInitialized) return;

      devLog(`chat type changed, fetching models for: ${chatType.toUpperCase()}`);

      try {
        const modelsResponse = await apiClient.getAIModels(
          chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE' | 'VIDEO'
        );

        if (modelsResponse.models && modelsResponse.models.length > 0) {
          setAvailableModels(modelsResponse.models);
          devLog(`${modelsResponse.models.length} models loaded.`, modelsResponse.models);

          // Select the first model by default.
          setSelectedModel(modelsResponse.models[0].name);
          setSelectedProivder(modelsResponse.models[0].provider);
        } else {
          setAvailableModels([]);
          setSelectedModel("");
          console.warn(`>>> Is type (${chatType}) ke liye koi models nahi mile.`);
        }
      } catch (e) {
        console.error(">>> Models load karte waqt error:", chatType, e);
      }
    };

    loadModelsForType();
  }, [chatType, hasInitialized]);

  // Re-fetch the available models on demand (used when the picker opens and
  // when the tab regains focus) so a model an admin just activated shows up
  // WITHOUT a full page reload. Updates the list only — never disturbs the
  // user's current selection. getAIModels sends Cache-Control: no-cache, so
  // this reads the live DB, not the 5-min server cache.
  const refreshModels = useCallback(async () => {
    if (!hasInitialized) return;
    try {
      const r = await apiClient.getAIModels(
        chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE' | 'VIDEO'
      );
      if (Array.isArray(r?.models)) setAvailableModels(r.models);
    } catch {
      /* best-effort: keep the existing list on a transient failure */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatType, hasInitialized]);

  // Pick up admin model changes when the user tabs back to the app.
  useEffect(() => {
    if (!hasInitialized) return;
    const onFocus = () => { void refreshModels(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshModels(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshModels, hasInitialized]);

  // const loadUserChats = async () => {
  //   try {
  //     const response = await apiClient.getChats()
  //     setChats(response.chats)
  //   } catch (error) {
  //     console.error("Failed to load chats:", error)
  //   }
  // }
  const loadUserChats = async (page: number = 1, limit: number = 20) => {
    try {
      const response = await apiClient.getChats({ page, limit })

      if (page === 1) {
        // First page - replace all chats
        setChats(response.chats)
      } else {
        // Subsequent pages - append to existing chats
        setChats(prev => [...prev, ...response.chats])
      }

      setPagination(response.pagination)
      setHasMoreChats(response.pagination.page < response.pagination.pages)
    } catch (error) {
      console.error("Failed to load chats:", error)
    }
  }

  // Load more chats for infinite scroll
  const loadMoreChats = useCallback(async () => {
    if (!hasMoreChats || isLoadingMore || !pagination) return

    setIsLoadingMore(true)
    try {
      await loadUserChats(pagination.page + 1, pagination.limit)
    } catch (error) {
      console.error("Failed to load more chats:", error)
    } finally {
      setIsLoadingMore(false)
    }
  }, [hasMoreChats, isLoadingMore, pagination])

  const resetChats = useCallback(() => {
    setChats([])
    setPagination(null)
    setHasMoreChats(true)
    loadUserChats()
  }, [])
  // ✅ Naya function: Streaming ko rokne ke liye
  // const stopStreaming = useCallback(() => {
  //   if (abortControllerRef.current) {
  //     abortControllerRef.current.abort(); // Fetch request ko abort karein
  //     devLog("Client-side stream abortion requested.");

  //     // UI state ko immediately update karein
  //     setIsLoading(false);
  //     setIsStreaming(false);
  //     abortControllerRef.current = null;

  //     // Last AI message ko update karein taaki user ko pata chale ki generation ruk gayi hai
  //     setCurrentChat(prevChat => {
  //       if (!prevChat) return prevChat;
  //       const lastMessageIndex = prevChat.messages.length - 1;
  //       if (lastMessageIndex >= 0 && prevChat.messages[lastMessageIndex].role === 'ASSISTANT') {
  //         const lastMessage = prevChat.messages[lastMessageIndex];
  //         // Agar message khaali ya incomplete hai, toh usko "Stopped" mark karein
  //         if (lastMessage.content === '' || (lastMessage.content.trim().length > 0 && !lastMessage.content.endsWith('.'))) {
  //           const updatedMessages = [...prevChat.messages];
  //           updatedMessages[lastMessageIndex] = {
  //             ...lastMessage,
  //             content: lastMessage.content + " (Generation stopped by user)."
  //           };
  //           return { ...prevChat, messages: updatedMessages };
  //         }
  //       }
  //       return prevChat;
  //     });
  //   }
  // }, [setCurrentChat]);

  const stopStreaming = useCallback(() => {
    const targetChatId = currentChatRef.current?.id || null;
    const targetStream = targetChatId ? streamControllersRef.current.get(targetChatId) : null;
    const streamIdToStop = targetStream?.streamId || currentStreamId;
    devLog("Stop Streaming triggered", { currentStreamId: streamIdToStop, targetChatId, isStreaming, isLoading });

    // IMMEDIATE UI State Reset - no waiting for API
    setPendingStopSynced(true);
    if (targetChatId) {
      markChatIdle(targetChatId, streamIdToStop || undefined);
    } else {
      setIsStreaming(false);
      setIsLoading(false);
    }

    // Abort local fetch request immediately
    if (targetStream?.controller) {
      devLog("Aborting chat-scoped fetch request");
      targetStream.controller.abort();
    } else if (abortControllerRef.current) {
      devLog("Aborting local fetch request");
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Flush any tokens still in the per-frame buffer so the user sees
    // the full last batch before "(Generation stopped by user)" is
    // appended below, then dispose the buffer so no later flush leaks.
    if (streamBufferRef.current) {
      streamBufferRef.current.flush();
      streamBufferRef.current.dispose();
      streamBufferRef.current = null;
    }

    // Update the last AI message to show it was stopped
    setCurrentChat(prevChat => {
      if (!prevChat) return prevChat;
      const lastMessageIndex = prevChat.messages.length - 1;
      if (lastMessageIndex >= 0 && prevChat.messages[lastMessageIndex].role === 'ASSISTANT') {
        const lastMessage = prevChat.messages[lastMessageIndex];
        // Only update if content exists and doesn't already have stopped text
        if (lastMessage.content !== undefined && !lastMessage.content.includes('(Generation stopped')) {
          const updatedMessages = [...prevChat.messages];
          const stoppedContent = lastMessage.content.trim() === ''
            ? "(Generation stopped by user)"
            : lastMessage.content + "\n\n(Generation stopped by user)";

          updatedMessages[lastMessageIndex] = {
            ...lastMessage,
            content: stoppedContent
          };
          return { ...prevChat, messages: updatedMessages };
        }
      }
      return prevChat;
    });

    // Send stop signal to backend (non-blocking)
    if (streamIdToStop) {
      devLog(`Sending stop signal to backend: ${streamIdToStop}`);
      apiClient.stopAIStream(streamIdToStop)
        .then(() => {
          devLog("Backend stop signal sent successfully");
        })
        .catch((error) => {
          console.error("Failed to send stop signal to backend:", error);
        })
        .finally(() => {
          setCurrentStreamId(null);
          setPendingStopSynced(false);
        });
    } else {
      setCurrentStreamId(null);
      setPendingStopSynced(false);
    }
  }, [currentStreamId, isStreaming, isLoading, markChatIdle]);
  const addMessage = useCallback(
    async (content: string, fileIds?: any[], chat?: any, skipUserMessage?: boolean, intentOverride?: ChatIntent) => { // Added skipUserMessage and forceFlowChartDiagram parameters
      const activeChat = chat || currentChat; // Use provided chat or fallback to currentChat
      if (!activeChat || !user || !token) return;
      const displayFiles = Array.isArray(fileIds)
        ? fileIds.filter(Boolean).map(normalizeMessageAttachment)
        : [];
      const normalizedFileIds = displayFiles
        .map(resolveAttachmentId)
        .filter((id): id is string => Boolean(id));
      const conversationForRouting = activeChat?.messages || currentChat?.messages || [];
      const historicalDocumentFileIds = normalizedFileIds.length === 0 && shouldUseExistingDocumentFileContext(content, conversationForRouting)
        ? collectRecentDocumentContextIds(conversationForRouting)
        : [];
      const requestFileIds = normalizedFileIds.length > 0 ? normalizedFileIds : historicalDocumentFileIds;

      // Save to pending messages BEFORE sending — survive crashes/offline
      savePending(content, activeChat.id, requestFileIds?.length ? requestFileIds : undefined, intentOverride);

      // STEP 1: User ka message UI mein dikhayein (agar already nahi dikhaya gaya)
      if (!skipUserMessage) {
        const userMessage: Message = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat.id,
          role: 'USER',
          content,
          timestamp: new Date().toISOString(),
          files: displayFiles.length ? displayFiles : undefined,
        };

        // Update chat with user message
        const updatedMessages = [...activeChat.messages, userMessage];
        const updatedChat = { ...activeChat, messages: updatedMessages };

        setCurrentChat(updatedChat);
        setChats((prev) => prev.filter(c => c && c.id).map((c) => (c.id === activeChat.id ? updatedChat : c)));
      }

      // STEP 2: AI ke jawab ke liye placeholder
      const aiMessagePlaceholder: Message = {
        id: `msg-ai-${Date.now()}`,
        chatId: activeChat.id,
        role: 'ASSISTANT',
        content: '',
        timestamp: new Date().toISOString(),
      };

      // Add AI placeholder to chat
      setCurrentChat(prevChat => {
        if (!prevChat) return prevChat;
        if (prevChat.id !== activeChat.id) return prevChat;
        return {
          ...prevChat,
          messages: [...prevChat.messages, aiMessagePlaceholder]
        };
      });

      setUploadedFiles([]); // Uploaded files clear kar dein
      const streamId = safeUUID();
      markChatStreaming(activeChat.id, streamId);
      // Reset pending stop state
      setPendingStopSynced(false);
      try {
        const intent = intentOverride || await aiService.classifyIntent(content, conversationForRouting);
        const professionalPrompt = buildProfessionalCapabilityPrompt(intent, content);
        devLog('intent', intent);

        if (intent === 'chart') {
          const fileId = normalizedFileIds.length > 0 ? normalizedFileIds[0] : undefined;
          const chartResponse = await apiClient.generateChart({
            prompt: professionalPrompt,
            displayPrompt: content,
            chatId: activeChat.id,
            fileId,
          });

          const { assistantMessage } = chartResponse;

          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) =>
              msg.id === aiMessagePlaceholder.id ? assistantMessage : msg
            );
            return { ...prevChat, messages: newMessages };
          });

          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else if (intent === 'figma') {
          // Handle Figma flowchart generation
          const figmaResponse = await apiClient.generateFigmaFlowchart({
            prompt: professionalPrompt,
            displayPrompt: content,
            chatId: activeChat.id,
            conversationHistory: activeChat.messages || [],
          });

          const { assistantMessage } = figmaResponse;

          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) =>
              msg.id === aiMessagePlaceholder.id ? assistantMessage : msg
            );
            return { ...prevChat, messages: newMessages };
          });

          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else if (intent === 'artifact') {
          // Interactive React artefact — calculators, simulators,
          // quizzes, dashboards with inputs. Server emits JSX; front
          // mounts it in a sandboxed iframe with React + Babel +
          // curated CDN libs.
          const controller = new AbortController();
          abortControllerRef.current = controller;
          let finalMsg: any = null;
          let lastStage = 'Diseñando el artefacto';
          let lastPct = 0;
          const renderProgress = () => {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id
                  ? { ...m, content: '', progressStage: lastStage, progressPct: lastPct }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          };
          try {
            await apiClient.generateArtifactStream(
              { prompt: professionalPrompt, displayPrompt: content, chatId: activeChat.id, model: selectedModel },
              (ev: any) => {
                if (controller.signal.aborted) return;
                if (ev.type === 'stage') {
                  lastStage = ev.label || lastStage;
                  lastPct = typeof ev.pct === 'number' ? ev.pct : lastPct;
                  renderProgress();
                } else if (ev.type === 'final') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: ev.content || 'Listo.',
                    files: ev.file ? [ev.file] : [],
                  };
                } else if (ev.type === 'error') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: `No pude generar el artefacto: ${ev.error || 'error desconocido'}.`,
                    files: [],
                  };
                }
              },
              { signal: controller.signal },
            );
          } catch (err: any) {
            if (err?.name !== 'AbortError') {
              finalMsg = finalMsg || {
                id: aiMessagePlaceholder.id,
                role: 'ASSISTANT',
                content: `No pude generar el artefacto: ${err?.message || 'error de red'}.`,
                files: [],
              };
            }
          }
          if (finalMsg) {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id ? finalMsg : m
              );
              return { ...prev, messages: msgs };
            });
          }
          abortControllerRef.current = null;
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else if (intent === 'doc' || intent === 'ppt') {
          // Document generation — Word / Excel / PowerPoint / PDF / SVG.
          // Same SSE + progressStage contract as viz/math/plan; the
          // assistant message carries a `doc`-typed file with a base64
          // data URL that <DocArtifactDisplay/> turns into a download
          // card (and inline preview for PDF/SVG).
          const controller = new AbortController();
          abortControllerRef.current = controller;
          let finalMsg: any = null;
          let lastStage = 'Generando documento';
          let lastPct = 0;
          const renderProgress = () => {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id
                  ? { ...m, content: '', progressStage: lastStage, progressPct: lastPct }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          };
          try {
            const docRequest = buildDocumentChatRequest({
              prompt: content,
              chatId: activeChat.id,
              model: selectedModel,
              fileIds: requestFileIds,
            });
            await apiClient.generateDocStream(
              docRequest,
              (ev: any) => {
                if (controller.signal.aborted) return;
                if (ev.type === 'stage') {
                  lastStage = ev.label || lastStage;
                  lastPct = typeof ev.pct === 'number' ? ev.pct : lastPct;
                  renderProgress();
                } else if (ev.type === 'final') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: ev.content || 'Listo.',
                    files: ev.file ? [ev.file] : [],
                  };
                  // The persisted assistantMessage strips the
                  // dataUrl to keep rows small; the SSE `file`
                  // payload still has it. Patch the assistant
                  // message's first file with the real dataUrl so
                  // the in-session download button works.
                  if (finalMsg?.files?.[0] && ev.file?.dataUrl) {
                    finalMsg.files[0] = { ...finalMsg.files[0], dataUrl: ev.file.dataUrl };
                  }
                } else if (ev.type === 'error') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: `No pude generar el documento: ${ev.error || 'error desconocido'}.`,
                    files: [],
                  };
                }
              },
              { signal: controller.signal },
            );
          } catch (err: any) {
            if (err?.name !== 'AbortError') {
              finalMsg = finalMsg || {
                id: aiMessagePlaceholder.id,
                role: 'ASSISTANT',
                content: `No pude generar el documento: ${err?.message || 'error de red'}.`,
                files: [],
              };
            }
          }
          if (finalMsg) {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id ? finalMsg : m
              );
              return { ...prev, messages: msgs };
            });
          }
          abortControllerRef.current = null;
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else if (intent === 'viz') {
          // Data-visualisation dispatch. The server picks the best
          // renderer (matplotlib PNG for static reports, Plotly for
          // interactive, Chart.js / Recharts for dashboards, D3 for
          // custom visuals, Mermaid for diagrams) and emits an
          // assistant message with a single `viz`-typed file. Inline
          // rendering is handled by <VizArtifactDisplay/>.
          const controller = new AbortController();
          abortControllerRef.current = controller;
          let finalMsg: any = null;
          let lastStage = 'Generando visualización';
          let lastPct = 0;
          const renderProgress = () => {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id
                  ? { ...m, content: '', progressStage: lastStage, progressPct: lastPct }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          };
          try {
            await apiClient.generateVizStream(
              { prompt: professionalPrompt, displayPrompt: content, chatId: activeChat.id, model: selectedModel },
              (ev: any) => {
                if (controller.signal.aborted) return;
                if (ev.type === 'stage') {
                  lastStage = ev.label || lastStage;
                  lastPct = typeof ev.pct === 'number' ? ev.pct : lastPct;
                  renderProgress();
                } else if (ev.type === 'final') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: ev.content || 'Listo.',
                    files: ev.file ? [ev.file] : [],
                  };
                } else if (ev.type === 'error') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: `No pude generar la visualización: ${ev.error || 'error desconocido'}.`,
                    files: [],
                  };
                }
              },
              { signal: controller.signal },
            );
          } catch (err: any) {
            if (err?.name !== 'AbortError') {
              finalMsg = finalMsg || {
                id: aiMessagePlaceholder.id,
                role: 'ASSISTANT',
                content: `No pude generar la visualización: ${err?.message || 'error de red'}.`,
                files: [],
              };
            }
          }
          if (finalMsg) {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id ? finalMsg : m
              );
              return { ...prev, messages: msgs };
            });
          }
          abortControllerRef.current = null;
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else if (intent === 'math') {
          // Math / science solver via SSE. The backend streams staging
          // events ("Analizando el problema → Consultando modelo →
          // Ejecutado Python en 340 ms → Formateando respuesta con
          // LaTeX") then emits the final markdown string, which the
          // existing ReactMarkdown + remark-math + rehype-katex
          // pipeline renders with KaTeX automatically.
          const controller = new AbortController();
          abortControllerRef.current = controller;

          let finalMsg: any = null;
          let lastStage = 'Resolviendo';
          let lastPct = 0;

          const renderProgress = () => {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id
                  ? { ...m, content: '', progressStage: lastStage, progressPct: lastPct }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          };

          try {
            await apiClient.solveMathStream(
              { prompt: professionalPrompt, displayPrompt: content, chatId: activeChat.id, model: selectedModel },
              (ev: any) => {
                if (controller.signal.aborted) return;
                if (ev.type === 'stage') {
                  lastStage = ev.label || lastStage;
                  lastPct = typeof ev.pct === 'number' ? ev.pct : lastPct;
                  renderProgress();
                } else if (ev.type === 'final') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: ev.content || 'Listo.',
                    files: [],
                  };
                } else if (ev.type === 'error') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: `No pude resolver el problema: ${ev.error || 'error desconocido'}.`,
                    files: [],
                  };
                }
              },
              { signal: controller.signal },
            );
          } catch (err: any) {
            if (err?.name !== 'AbortError') {
              finalMsg = finalMsg || {
                id: aiMessagePlaceholder.id,
                role: 'ASSISTANT',
                content: `No pude resolver el problema: ${err?.message || 'error de red'}.`,
                files: [],
              };
            }
          }

          if (finalMsg) {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id ? finalMsg : m
              );
              return { ...prev, messages: msgs };
            });
          }

          abortControllerRef.current = null;
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else if (intent === 'plan') {
          // Architectural floor-plan DXF generation via SSE. The server
          // emits progress events (stage / tokens) so the user sees
          // "Consultando modelo · 2.3k tokens · 45%" instead of a silent
          // spinner for 30-60s. On `final`/`error` we swap the
          // placeholder for the assistant message returned by the
          // backend (which is already persisted in the DB).
          const controller = new AbortController();
          abortControllerRef.current = controller;

          let finalMsg: any = null;
          let lastStage = 'Generando plano';
          let lastPct = 0;
          let tokenCount = 0;

          const renderProgress = () => {
            // When the LLM is streaming tokens, append a compact
            // counter to the stage so the user sees motion even
            // while pct hovers in one band.
            const stageLabel = tokenCount
              ? `${lastStage} · ${(tokenCount / 1000).toFixed(1)}k tokens`
              : lastStage;
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id
                  ? { ...m, content: '', progressStage: stageLabel, progressPct: lastPct }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          };

          try {
            await apiClient.generatePlanStream(
              { prompt: professionalPrompt, displayPrompt: content, chatId: activeChat.id, model: selectedModel },
              (ev: any) => {
                if (controller.signal.aborted) return;
                if (ev.type === 'stage') {
                  lastStage = ev.label || lastStage;
                  lastPct = typeof ev.pct === 'number' ? ev.pct : lastPct;
                  renderProgress();
                } else if (ev.type === 'tokens') {
                  tokenCount = ev.count || tokenCount;
                  lastPct = typeof ev.pct === 'number' ? ev.pct : lastPct;
                  renderProgress();
                } else if (ev.type === 'final') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: 'Plano generado.',
                    files: [{ type: 'plan', dxf: ev.dxf, plan: ev.plan }],
                  };
                } else if (ev.type === 'error') {
                  finalMsg = ev.assistantMessage || {
                    id: aiMessagePlaceholder.id,
                    role: 'ASSISTANT',
                    content: `No pude generar el plano: ${ev.error || 'error desconocido'}.`,
                    files: [],
                  };
                }
              },
              { signal: controller.signal },
            );
          } catch (err: any) {
            if (err?.name !== 'AbortError') {
              finalMsg = finalMsg || {
                id: aiMessagePlaceholder.id,
                role: 'ASSISTANT',
                content: `No pude generar el plano: ${err?.message || 'error de red'}.`,
                files: [],
              };
            }
          }

          if (finalMsg) {
            setCurrentChat((prev) => {
              if (!prev) return prev;
              const msgs = prev.messages.map((m: any) =>
                m.id === aiMessagePlaceholder.id ? finalMsg : m
              );
              return { ...prev, messages: msgs };
            });
          }

          abortControllerRef.current = null;
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);

        } else {
          // Create new AbortController for this request
          const controller = new AbortController();
          abortControllerRef.current = controller;
          markChatStreaming(activeChat.id, streamId, controller);

          // Register this chat's stream in the BackgroundStreams
          // context so it keeps accruing tokens even if the user
          // switches to a different chat. The sidebar pill reads
          // from there to show "N chats en progreso".
          bg.register(activeChat.id, activeChat.title || 'Nuevo chat', controller);

          // Per-frame buffer: accumulate SSE chunks and apply to React
          // state once per animation frame. Without this, a long answer
          // does hundreds of full-chat re-renders per second.
          streamBufferRef.current?.dispose();
          const fgBuffer = createStreamBuffer({
            onFlush: (joined) => {
              setCurrentChat((prevChat) => {
                if (!prevChat) return prevChat;
                if (prevChat.id !== activeChat.id) return prevChat;
                const newMessages = prevChat.messages.map((msg) => {
                  if (msg.id === aiMessagePlaceholder.id) {
                    return { ...msg, content: msg.content + joined };
                  }
                  return msg;
                });
                return { ...prevChat, messages: newMessages };
              });
            },
          });
          streamBufferRef.current = fgBuffer;

          // STEP 3: Nayi streaming API call karein
          await apiClient.generateAIStream(
            {
              provider: selectProvider,
              model: selectedModel,
              reasoningEffort: selectedEffort,
              prompt: content,
              chatId: activeChat.id,
              files: requestFileIds,
              streamId: streamId,
            },
            (chunk) => {
              // Always accumulate in the background-streams store so
              // the user sees progress even if they navigated away.
              bg.appendChunk(activeChat.id, chunk);

              // Check if we should stop processing chunks for the
              // foreground chat view.
              if (controller.signal.aborted || pendingStopRef.current) {
                return;
              }

              // Queue the chunk; the buffer flushes once per frame.
              fgBuffer.append(chunk);
            },
            async () => {
              // onClose: Jab stream khatam ho jaye
              fgBuffer.flush();
              fgBuffer.dispose();
              if (streamBufferRef.current === fgBuffer) streamBufferRef.current = null;
              clearPending(activeChat.id);
              bg.complete(activeChat.id);
              if (!controller.signal.aborted && !pendingStopRef.current) {
                setIsLoading(false);
                setIsStreaming(false);
                setCurrentStreamId(null);
                abortControllerRef.current = null;
                // After the stream ends, fetch the persisted chat so we can
                // swap optimistic IDs for server IDs. We retry up to 3 times
                // with a delay because the backend may still be persisting
                // (document uploads add 1-3s after [DONE]).
                const syncIds = async (attempt = 1) => {
                  if (activeStreamingChatIdsRef.current.has(activeChat.id)) return;
                  try {
                    const resp = await apiClient.getChat(activeChat.id);
                    const serverChat = resp.chat;
                    setCurrentChat(prev => {
                      if (!prev || prev.id !== activeChat.id || activeStreamingChatIdsRef.current.has(activeChat.id)) return prev;
                      const merged = mergeChatPreservingUserMessages(serverChat, prev);
                      // If the merge preserved all local content (same
                      // message count), the IDs are synced — we're done.
                      return merged;
                    });
                  } catch {
                    if (attempt < 3) {
                      setTimeout(() => syncIds(attempt + 1), 2000 * attempt);
                    }
                  }
                };
                setTimeout(() => syncIds(), 2000);
              }
            },
            (error) => {
              console.error("Streaming failed:", error);
              // Flush whatever made it through before the error so the
              // partial answer is visible, then dispose.
              fgBuffer.flush();
              fgBuffer.dispose();
              if (streamBufferRef.current === fgBuffer) streamBufferRef.current = null;
              // Mirror the failure into BackgroundStreams so the
              // sidebar pill shows the error state for this chat.
              bg.fail(activeChat.id, error?.message || 'stream failed');

              // Check for monthly API limit errors
              const errorMessage = error?.message || '';
              const status = (error as any)?.status || (error as any)?.statusCode;
              const errorData = (error as any)?.errorData;

              if (status === 429 ||
                isMonthlyLimitError(errorMessage) ||
                (errorData && isMonthlyLimitError(errorData.error || ''))) {

                devLog('Monthly limit error detected in streaming');
                triggerUpgradeModal(errorMessage, errorData);

                // Update message with monthly limit error
                if (!controller.signal.aborted && !pendingStopRef.current && error.name !== 'AbortError') {
                  setCurrentChat((prevChat) => {
                    if (!prevChat) return prevChat;
                    const newMessages = prevChat.messages.map((msg) => {
                      if (msg.id === aiMessagePlaceholder.id) {
                        let usageInfo = '';
                        if (errorData && errorData.usage) {
                          const { current, limit } = errorData.usage;
                          usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
                        }
                        return {
                          ...msg,
                          content: `Monthly API limit exceeded.${usageInfo} Please upgrade your plan to continue using the service.`,
                          error: "Monthly API limit exceeded"
                        };
                      }
                      return msg;
                    });
                    return { ...prevChat, messages: newMessages };
                  });
                }

                setIsLoading(false);
                setIsStreaming(false);
                setCurrentStreamId(null);
                abortControllerRef.current = null;
                return;
              }

              // Only update UI if not manually stopped
              if (!controller.signal.aborted && !pendingStopRef.current) {
                setIsLoading(false);
                setIsStreaming(false);
                setCurrentStreamId(null);
                abortControllerRef.current = null;

                if (error.name !== 'AbortError') {
                  setCurrentChat((prevChat) => {
                    if (!prevChat) return prevChat;
                    const newMessages = prevChat.messages.map((msg) => {
                      if (msg.id === aiMessagePlaceholder.id) {
                        return { ...msg, content: "", error: normalizeChatError(error.message || "An error occurred.") };
                      }
                      return msg;
                    });
                    return { ...prevChat, messages: newMessages };
                  });
                }
              }
            },
            controller.signal, // Pass the abort signal
            {
              ...createReasoningHandlers({
                setChat: setCurrentChat,
                messageId: aiMessagePlaceholder.id,
                isCancelled: () => controller.signal.aborted || pendingStopRef.current,
              }),
              ...createAgentTraceHandlers({
                setChat: setCurrentChat,
                messageId: aiMessagePlaceholder.id,
                isCancelled: () => controller.signal.aborted || pendingStopRef.current,
              }),
              onReplace: (replacement) => {
                if (controller.signal.aborted || pendingStopRef.current) {
                  return;
                }
                // Drop any queued tokens — the replacement is authoritative.
                fgBuffer.dispose();
                if (streamBufferRef.current === fgBuffer) streamBufferRef.current = null;
                setCurrentChat((prevChat) => {
                  if (!prevChat) return prevChat;
                  const newMessages = prevChat.messages.map((msg) => {
                    if (msg.id === aiMessagePlaceholder.id) {
                      return { ...msg, content: replacement };
                    }
                    return msg;
                  });
                  return { ...prevChat, messages: newMessages };
                });
                // The corrective replacement is the final answer — release the
                // composer immediately instead of waiting for [DONE]. Some
                // backends pause briefly between the replace frame and the
                // terminator (e.g. while persisting), and that gap was leaving
                // the stop button visible after the visible reply was rendered.
                setIsLoading(false);
                setIsStreaming(false);
              },
              onSources: (payload) => {
                if (controller.signal.aborted || pendingStopRef.current) return;
                setCurrentChat((prevChat) => {
                  if (!prevChat || prevChat.id !== activeChat.id) return prevChat;
                  const newMessages = prevChat.messages.map((msg) => {
                    if (msg.id === aiMessagePlaceholder.id) {
                      return {
                        ...msg,
                        sources: payload.sources,
                        searchActivity: {
                          provider: payload.provider,
                          query: payload.query,
                          elapsedMs: payload.elapsedMs,
                        },
                      };
                    }
                    return msg;
                  });
                  return { ...prevChat, messages: newMessages };
                });
              },
              onMemory: (payload) => {
                if (controller.signal.aborted || pendingStopRef.current) return;
                setCurrentChat((prevChat) => {
                  if (!prevChat || prevChat.id !== activeChat.id) return prevChat;
                  const newMessages = prevChat.messages.map((msg) => {
                    if (msg.id === aiMessagePlaceholder.id) {
                      return {
                        ...msg,
                        memory: payload.items,
                        memoryMeta: { reason: payload.reason, recalled: payload.items?.length },
                      };
                    }
                    return msg;
                  });
                  return { ...prevChat, messages: newMessages };
                });
              },
            }
          );
        }
        // Clear pending on successful completion (sync intents like chart/figma)
        clearPending(activeChat.id);
      } catch (error: any) {
        console.error("Failed to start AI stream:", error);

        // If the stream already completed successfully (onClose was called),
        // don't wipe the content the user can already see.
        if (!isStreamingRef.current && aiMessagePlaceholder) {
          const alreadyHasContent = (() => {
            let hasContent = false;
            setCurrentChat(prev => {
              if (!prev) return prev;
              const msg = prev.messages?.find((m: any) => m.id === aiMessagePlaceholder.id);
              hasContent = !!(msg?.content && typeof msg.content === 'string' && msg.content.trim().length > 10);
              return prev;
            });
            return hasContent;
          })();
          if (alreadyHasContent) {
            // Stream completed, this is a post-DONE socket error. Leave the content alone.
            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            return;
          }
        }

        // Check for monthly API limit errors
        const errorMessage = error?.message || '';
        const status = (error as any)?.status || (error as any)?.statusCode;
        const errorData = (error as any)?.errorData;

        if (status === 429 ||
          isMonthlyLimitError(errorMessage) ||
          (errorData && isMonthlyLimitError(errorData.error || ''))) {

          devLog('Monthly limit error detected in catch block');
          triggerUpgradeModal(errorMessage, errorData);

          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                let usageInfo = '';
                if (errorData && errorData.usage) {
                  const { current, limit } = errorData.usage;
                  usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
                }
                return {
                  ...msg,
                  content: `Monthly API limit exceeded.${usageInfo} Please upgrade your plan to continue using the service.`,
                  error: "Monthly API limit exceeded"
                };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          });
        } else {
          // Handle other errors normally — only if placeholder doesn't already have real content
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                const existing = typeof msg.content === 'string' ? msg.content.trim() : '';
                if (existing.length > 10) return msg; // Keep streamed content
                return { ...msg, content: "", error: normalizeChatError(error.message || "An error occurred.") };
              }
              return msg;
            });
            return { ...prevChat, messages: newMessages };
          });
        }

        setIsLoading(false);
        setIsStreaming(false);
        setCurrentStreamId(null);
      } finally {
        markChatIdle(activeChat.id, streamId);
      }
    },
    // bg / pendingStop / selectChat / selectProvider are intentionally
    // omitted — they're either refs, secondary helpers, or recreated
    // per render. The hook is scoped to the user-facing inputs
    // (chat, auth, model, files) that matter for the send action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentChat, user, token, selectedModel, uploadedFiles, markChatStreaming, markChatIdle]
  );

  const retryPendingMessage = useCallback(async (msg: PendingMessage) => {
    try {
      // If the original send is still streaming, the pending draft is not
      // actually stale yet. Retrying now would call addMessage() again,
      // creating a second ASSISTANT placeholder/stream for the same USER turn.
      if (activeStreamingChatIdsRef.current.has(msg.chatId)) return false

      let targetChat =
        currentChatRef.current?.id === msg.chatId
          ? currentChatRef.current
          : chatsRef.current.find((chat) => chat?.id === msg.chatId)

      if (!targetChat) {
        const response = await apiClient.getChat(msg.chatId)
        targetChat = response.chat
      }

      if (!targetChat) return false

      const createdAt = Date.parse(msg.createdAt)
      const messages: any[] = targetChat.messages || []

      // Find the index of the matching USER message in the chat.
      const echoedIndex = messages.findIndex((message: any) => {
        if (String(message?.role || "").toUpperCase() !== "USER") return false
        if (message?.content !== msg.content) return false
        const messageTime = Date.parse(message?.timestamp || message?.createdAt || "")
        if (!Number.isFinite(createdAt) || !Number.isFinite(messageTime)) return true
        return Math.abs(messageTime - createdAt) < 10 * 60 * 1000
      })

      const alreadyEchoed = echoedIndex !== -1

      if (alreadyEchoed) {
        // Check whether an ASSISTANT turn already follows the matched user message.
        // If yes, the AI already replied — re-sending would create a duplicate response.
        // Clear the stale pending entry and return success without calling addMessage.
        const hasAssistantReply = messages.slice(echoedIndex + 1).some(
          (m: any) => String(m?.role || "").toUpperCase() === "ASSISTANT" &&
                      m?.content && String(m.content).trim().length > 0
        )
        if (hasAssistantReply) {
          return true
        }
      }

      await addMessage(
        msg.content,
        msg.fileIds,
        targetChat,
        alreadyEchoed,
        msg.intentOverride as ChatIntent | undefined,
      )
      return true
    } catch (error) {
      console.warn("Pending message retry failed:", error)
      return false
    }
  }, [addMessage])

  useEffect(() => {
    if (!user || !token) return
    void retryAll(retryPendingMessage)
    return subscribeOnlineRetry(retryPendingMessage)
  }, [user, token, retryPendingMessage])

  const handleNewChatWithPlaceholder = useCallback(async (newChat: Chat, initialContent: string, placeholderContent: string, uploadedFiles: any[]) => {
    const displayFiles = Array.isArray(uploadedFiles)
      ? uploadedFiles.filter(Boolean).map(normalizeMessageAttachment)
      : [];
    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: newChat.id,
      role: 'USER' as const,
      content: initialContent,
      timestamp: new Date().toISOString(),
      files: displayFiles,
    };

    const assistantPlaceholder = {
      id: `msg-assistant-processing-${Date.now()}`,
      chatId: newChat.id,
      role: 'ASSISTANT' as const,
      content: placeholderContent,
      timestamp: new Date().toISOString(),
    };

    setCurrentChat(prevChat => {
      if (!prevChat) return prevChat;
      const updatedMessages = [...(prevChat.messages || []), userMessage, assistantPlaceholder];
      return { ...prevChat, messages: updatedMessages };
    });
  }, []);

  const createNewChat = useCallback(async (
    type: 'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify' | 'computer-use' | 'thesis' = 'text',
    initialContent?: string,
    initialFiles?: any[],
    options?: { skipInitialProcessing?: boolean; isWordConnectorChat?: boolean; isExcelConnectorChat?: boolean; projectId?: string; initialIntent?: ChatIntent; model?: string }
  ) => {
    const chatModel = options?.model || selectedModel;
    if (!user || !token || !chatModel) return;
    setChatType(type);
    try {
      const response = await apiClient.createChat({
        title: initialContent ? initialContent.substring(0, 30) : "Nuevo chat",
        model: chatModel,
        isWordConnectorChat: options?.isWordConnectorChat || false,
        isExcelConnectorChat: options?.isExcelConnectorChat || false,
        projectId: options?.projectId,
      });
      const newChat = response.chat;
      newChat.messages = [];

      setChats((prev) => [newChat, ...prev]);
      localStorage.setItem('currentChatId', newChat.id);
      setCurrentChat(newChat);
      setUploadedFiles([]);

      if (initialContent && !options?.skipInitialProcessing) {
        try {
          switch (type) {
            case 'image':
              await handleNewChatWithPlaceholder(newChat, initialContent, '[GENERATING_IMAGE]', uploadedFiles);

              const imageGenerationPayload = {
                prompt: initialContent,
                chatId: newChat.id,
                provider: selectProvider,
                model: chatModel,
              };
              if (initialFiles && initialFiles.length > 0) {
                (imageGenerationPayload as any).fileId = resolveAttachmentId(initialFiles[0]);
              }
              {
                const imageRequestStartedAt = Date.now();
                try {
                  await apiClient.generateImage(imageGenerationPayload);
                } catch (genError: any) {
                  const elapsed = Date.now() - imageRequestStartedAt;
                  // El edge proxy de la Reserved VM corta la conexión a los
                  // ~30s mientras el backend sigue generando y persiste la
                  // imagen en el chat; en ese caso sondeamos hasta que aparezca
                  // y recargamos el chat. Cualquier otro error se propaga.
                  const connectionCut = shouldRecoverImageGenerationViaPolling(genError, imageRequestStartedAt, {
                    nowMs: imageRequestStartedAt + elapsed,
                  });
                  if (!connectionCut) {
                    throw genError;
                  }
                  const outcome = await apiClient.waitForGeneratedImage(newChat.id, imageRequestStartedAt);
                  if (outcome === 'timeout') {
                    throw genError;
                  }
                  // 'image' o 'error' ya quedaron persistidos en el chat;
                  // recargamos para que el usuario vea la imagen o el aviso.
                  await selectChat(newChat.id);
                }
              }
              break;
            case 'video':
              await addVideoMessage(initialContent, [], newChat);
              break;
            case 'gmail':
              await handleNewChatWithPlaceholder(newChat, initialContent, '[PROCESSING_GMAIL]', uploadedFiles);

              await apiClient.generateGmailResponse({
                prompt: initialContent,
                chatId: newChat.id,
                model: selectedModel,
                type: 'gmail',
              });
              break;
            case 'google_services':
              const isCalendarAction = initialContent.toLowerCase().includes('event') || initialContent.toLowerCase().includes('meeting') || initialContent.toLowerCase().includes('calendar');
              const loadingContent = isCalendarAction ? '[PROCESSING_CALENDAR_ACTION]' : '[PROCESSING_DRIVE_ACTION]';

              await handleNewChatWithPlaceholder(newChat, initialContent, loadingContent, uploadedFiles);

              await apiClient.generateGoogleServicesResponse({
                prompt: initialContent,
                chatId: newChat.id,
                model: selectedModel,
              });
              break;
            case 'spotify':
              await handleNewChatWithPlaceholder(newChat, initialContent, '[PROCESSING_SPOTIFY]', uploadedFiles);

              await apiClient.processSpotifyCommand({
                prompt: initialContent,
                chatId: newChat.id,
              });
              break;
            case 'computer-use':
              await handleNewChatWithPlaceholder(newChat, initialContent, '[STARTING_COMPUTER_USE]', uploadedFiles);

              // Start Computer Use session
              try {
                const response = await apiClient.startComputerUseChatIntegration({
                  message: initialContent,
                  chatId: newChat.id,
                  sessionId: `chat-${newChat.id}-${Date.now()}`
                });

                if (response.ok) {
                  const result = await response.json();
                  devLog('Computer Use session started:', result);
                } else {
                  console.error('Failed to start Computer Use session:', response.statusText);
                  await handleNewChatWithPlaceholder(newChat, initialContent, '[COMPUTER_USE_ERROR]', uploadedFiles);
                }
              } catch (cuError) {
                console.error('Failed to start Computer Use session:', cuError);
                // Update the message to show error
                await handleNewChatWithPlaceholder(newChat, initialContent, '[COMPUTER_USE_ERROR]', uploadedFiles);
              }
              break;
            case 'thesis':
              // Handle thesis generation with topics (comma-separated)
              const topics = initialContent ? initialContent.split(',').map(t => t.trim()).filter(t => t.length > 0) : []
              if (topics.length >= 1) {
                // Call addThesisMessage directly - it should be available from context
                // If it's not available, the error will be caught in the outer try-catch
                await addThesisMessage(topics, newChat);
              } else {
                await handleNewChatWithPlaceholder(newChat, initialContent || '', '[THESIS_ERROR: Need at least 1 topic]', uploadedFiles);
              }
              break;
            default:
              await addMessage(initialContent, initialFiles, newChat, false, options?.initialIntent);
              break;
          }
        } catch (error) {
          console.error(`${type} processing failed during chat creation:`, error);
          throw error;
        }
        return newChat;
      }
      // Return newChat even if no initialContent
      return newChat;
    } catch (error) {
      console.error("Failed to create chat:", error);
      throw error; // Re-throw to allow error handling in caller
    }
    // addThesisMessage / addVideoMessage / selectChat are defined later
    // and adding them here would be use-before-define. Latest closure is
    // captured at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, token, selectedModel, availableModels, setChatType, addMessage, handleNewChatWithPlaceholder, selectProvider, uploadedFiles]);

  const selectChat = useCallback(
    async (chatId: string) => {
      const targetIsStreaming = activeStreamingChatIdsRef.current.has(chatId)
      const cachedChat = chatsRef.current.find(chat => chat?.id === chatId)
      if (cachedChat) {
        setCurrentChat(prev => {
          if (prev?.id === chatId && (prev.messages?.length || 0) > 0) return prev
          return { ...cachedChat, messages: cachedChat.messages || [] }
        })
        localStorage.setItem('currentChatId', chatId)
        setUploadedFiles([])
      }

      // If this specific chat is still streaming, keep the optimistic
      // client copy. Fetching it now can race persistence and replace a
      // growing answer with an older DB snapshot. Other chats remain
      // selectable so one background generation never locks the app.
      if (targetIsStreaming) return

      try {
        const response = await apiClient.getChat(chatId)
        const chat = response.chat
        setCurrentChat(prev => {
          if (!prev || prev.id !== chatId) return mergeChatPreservingUserMessages(chat, prev)

          // Re-check this chat in case it started streaming while the
          // API call was in flight.
          if (activeStreamingChatIdsRef.current.has(chatId)) return prev;

          // NEVER overwrite a local chat that has more assistant content
          // than the server returned — the backend may not have persisted
          // the last turn yet (common with document uploads).
          const prevAssistantContent = prev.messages
            ?.filter((m: any) => m?.role?.toUpperCase() !== 'USER' && m?.content)
            .reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) || 0
          const serverAssistantContent = (chat.messages || [])
            .filter((m: any) => m?.role?.toUpperCase() !== 'USER' && m?.content)
            .reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) || 0

          if (
            prevAssistantContent > serverAssistantContent &&
            !hasCompletedAgentTaskAssistantContent(chat.messages || [])
          ) {
            return prev
          }

          return mergeChatPreservingUserMessages(chat, prev)
        })

        setChats((prev) => {
          const existingIndex = prev.findIndex(c => c && c.id === chatId)
          if (existingIndex >= 0) {
            return prev.filter(c => c && c.id).map((c) =>
              c.id === chatId ? mergeChatPreservingUserMessages(chat, c) : c
            )
          } else {
            return [chat, ...prev]
          }
        })

        localStorage.setItem('currentChatId', chatId)

        setUploadedFiles([])
      } catch (error) {
        console.error("Failed to load chat:", error)
        // Stale/deleted chat id (e.g. restored from localStorage) → clear the
        // dead pointer so it isn't re-requested (and re-logged) on every load.
        if ((error as any)?.status === 404 || (error as any)?.statusCode === 404) {
          try { if (localStorage.getItem('currentChatId') === chatId) localStorage.removeItem('currentChatId') } catch { /* private mode */ }
          setCurrentChat((prev: any) => (prev?.id === chatId ? null : prev))
          setChats((prev: any[]) => prev.filter((c) => c && c.id !== chatId))
        }
      }
    },
    [],
  )

  const clearCurrentChat = useCallback(async () => {
    if (!currentChat || !token) return

    try {
      await apiClient.clearChat(currentChat.id)

      // Empty messages array — the chat surface re-renders the
      // empty-state hero (greeting + example prompt chips) instead of
      // a pre-seeded assistant turn the user never asked for. Matches
      // Claude.ai's "clear chat" UX where the canvas resets fully.
      const clearedChat = {
        ...currentChat,
        title: "Nuevo chat",
        messages: [],
        updatedAt: new Date().toISOString(),
      }

      setCurrentChat(clearedChat)
      setChats((prev) => prev.filter(chat => chat && chat.id).map((chat) =>
        chat.id === currentChat.id ? clearedChat : chat
      ))
      setUploadedFiles([]) // Clear uploaded files
    } catch (error) {
      console.error("Failed to clear chat:", error)
    }
  }, [currentChat, token])

  const deleteChat = useCallback(
    async (chatId: string): Promise<boolean> => {
      if (!token) return false

      const wasCurrentChat = currentChatRef.current?.id === chatId
      discardActiveStreamForChat(chatId, { notifyBackend: true })

      try {
        await apiClient.deleteChat(chatId)
        setChats((prev) => prev.filter((chat) => chat.id !== chatId))
        setCurrentChat(prev => (prev?.id === chatId ? null : prev))
        if (wasCurrentChat) {
          try { localStorage.removeItem('currentChatId') } catch { /* ignore storage failures */ }
          setUploadedFiles([])
        } else {
          try {
            if (localStorage.getItem('currentChatId') === chatId) {
              localStorage.removeItem('currentChatId')
            }
          } catch { /* ignore storage failures */ }
        }
        return true
      } catch (error) {
        console.error("Failed to delete chat:", error)
        return false
      }
    },
    [discardActiveStreamForChat, token],
  )


  const regenerateMessageImpl = async (messageId?: string) => {
    if (!currentChat || isLoading) return;

    let targetAiMessageIndex = -1;

    if (messageId) {
      // Find the specific message to regenerate
      targetAiMessageIndex = currentChat.messages.findIndex(m => m.id === messageId && m.role === 'ASSISTANT');
    } else {
      // Find the last AI message if no messageId provided (for backward compatibility)
      for (let i = currentChat.messages.length - 1; i >= 0; i--) {
        if (currentChat.messages[i].role === 'ASSISTANT') {
          targetAiMessageIndex = i;
          break;
        }
      }
    }

    if (targetAiMessageIndex === -1) {
      console.warn("No AI message found to regenerate.");
      return;
    }

    const targetUserMessageIndex = targetAiMessageIndex - 1;
    if (targetUserMessageIndex < 0 || currentChat.messages[targetUserMessageIndex].role !== 'USER') {
      console.error("Could not find the corresponding user message.");
      return;
    }

    const originalUserMessage = currentChat.messages[targetUserMessageIndex];
    const nextRegenerationAttempt = getRegenerationAttempt(currentChat.messages[targetAiMessageIndex]) + 1;

    // Keep only messages up to (and including) the user message we want to regenerate from
    const messagesBeforeRegeneration = currentChat.messages.slice(0, targetAiMessageIndex);

    // Get messages that need to be deleted from backend (AI message + all subsequent messages)
    const messagesToDelete = currentChat.messages.slice(targetAiMessageIndex);

    devLog('Regenerating message at index:', targetAiMessageIndex);
    devLog('Messages before regeneration:', messagesBeforeRegeneration.length);
    devLog('Messages to delete from backend:', messagesToDelete.length);
    devLog('Original total messages:', currentChat.messages.length);

    setIsLoading(true);

    // STEP 1: Delete messages from backend first
    try {
      devLog('Deleting messages from backend:', messagesToDelete.map(m => m.id));
      for (const msg of messagesToDelete) {
        if (msg.id && !msg.id.includes('temp-') && !msg.id.includes('ai-regen-')) {
          await apiClient.clearMessageById(msg.id);
          devLog('Deleted message from backend:', msg.id);
        }
      }
    } catch (error) {
      console.error('Error deleting messages from backend:', error);
      setIsLoading(false);
      toast.error('Failed to delete previous messages. Please try again.');
      return;
    }

    // STEP 2: Update UI state and start regeneration

    const aiMessagePlaceholder: Message = {
      id: `ai-regen-${Date.now()}`,
      chatId: currentChat.id,
      role: 'ASSISTANT',
      content: "",
      tokens: 0,
      timestamp: new Date().toISOString(),
      files: undefined,
      metadata: JSON.stringify({ regeneration: { attempt: nextRegenerationAttempt } }),
    };

    // Update chat to include messages before regeneration + new placeholder
    setCurrentChat(prev => {
      if (!prev) return null;
      const newState = {
        ...prev,
        messages: [...messagesBeforeRegeneration, aiMessagePlaceholder]
      };
      devLog('Setting chat state with messages:', newState.messages.length);
      return newState;
    });

    const streamId = safeUUID();
    setCurrentStreamId(streamId);
    setIsStreaming(true);
    setPendingStopSynced(false);

    // Create new AbortController for regeneration
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Per-frame buffer (regenerate path).
    streamBufferRef.current?.dispose();
    const regenBuffer = createStreamBuffer({
      onFlush: (joined) => {
        setCurrentChat((prevChat) => {
          if (!prevChat) return prevChat;
          const updatedMessages = prevChat.messages.map((msg) => {
            if (msg.id === aiMessagePlaceholder.id) {
              return { ...msg, content: msg.content + joined };
            }
            return msg;
          });
          return { ...prevChat, messages: updatedMessages };
        });
      },
    });
    streamBufferRef.current = regenBuffer;

    try {
      // Call the streaming function with the original user message
      await apiClient.generateAIStream(
        {
          provider: selectProvider,
          model: selectedModel,
          reasoningEffort: selectedEffort,
          prompt: originalUserMessage.content,
          chatId: currentChat.id,
          files: (originalUserMessage.files?.map((f: any) => f.id) as string[]) || [],
          streamId: streamId,
          regenerate: true,
          regenerationAttempt: nextRegenerationAttempt,
        },
        (chunk) => {
          // Check if we should stop processing chunks
          if (controller.signal.aborted || pendingStopRef.current) {
            return;
          }
          regenBuffer.append(chunk);
        },
        async () => {
          // onClose: Stop loading only if not manually stopped
          regenBuffer.flush();
          regenBuffer.dispose();
          if (streamBufferRef.current === regenBuffer) streamBufferRef.current = null;
          if (!controller.signal.aborted && !pendingStopRef.current) {
            devLog('Regeneration completed successfully');
            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;

            // Delayed ID sync — same pattern as addMessage onClose.
            // The backend may still be persisting the regenerated turn.
            const regenChatId = currentChat?.id;
            if (regenChatId) {
              const syncIds = async (attempt = 1) => {
                if (isStreamingRef.current) return;
                try {
                  const freshChat = await apiClient.getChat(regenChatId);
                  setCurrentChat(prev => {
                    if (!prev || prev.id !== regenChatId || isStreamingRef.current) return prev;
                    return mergeChatPreservingUserMessages(freshChat.chat, prev);
                  });
                  setChats(prevChats =>
                    prevChats.filter(chat => chat && chat.id).map(chat =>
                      chat.id === regenChatId ? mergeChatPreservingUserMessages(freshChat.chat, chat) : chat
                    )
                  );
                } catch {
                  if (attempt < 3) {
                    setTimeout(() => syncIds(attempt + 1), 2000 * attempt);
                  }
                }
              };
              setTimeout(() => syncIds(), 2000);
            }
          }
        },
        (error: any) => {
          // onError: Handle error only if not manually stopped
          regenBuffer.flush();
          regenBuffer.dispose();
          if (streamBufferRef.current === regenBuffer) streamBufferRef.current = null;
          if (!controller.signal.aborted && !pendingStopRef.current) {
            console.error("Streaming failed during regeneration:", error);

            // Check for monthly API limit errors
            const errorMessage = error?.message || '';
            const status = error?.status || error?.statusCode;
            const errorData = error?.errorData;

            if (status === 429 ||
              isMonthlyLimitError(errorMessage) ||
              (errorData && isMonthlyLimitError(errorData.error || ''))) {

              devLog('Monthly limit error detected during regeneration');
              triggerUpgradeModal(errorMessage, errorData);

              setCurrentChat((prevChat) => {
                if (!prevChat) return prevChat;
                const errorMessages = prevChat.messages.map((msg) => {
                  if (msg.id === aiMessagePlaceholder.id) {
                    let usageInfo = '';
                    if (errorData && errorData.usage) {
                      const { current, limit } = errorData.usage;
                      usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
                    }
                    return {
                      ...msg,
                      content: `Monthly API limit exceeded.${usageInfo} Please upgrade your plan to continue using the service.`,
                      error: "Monthly API limit exceeded"
                    };
                  }
                  return msg;
                });
                return { ...prevChat, messages: errorMessages };
              });
            } else {
              setCurrentChat((prevChat) => {
                if (!prevChat) return prevChat;
                const errorMessages = prevChat.messages.map((msg) => {
                  if (msg.id === aiMessagePlaceholder.id) {
                    return { ...msg, content: "", error: normalizeChatError(error.message || "An error occurred during regeneration.") };
                  }
                  return msg;
                });
                return { ...prevChat, messages: errorMessages };
              });
            }

            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;
          }
        },
        controller.signal, // Pass the abort signal
        {
          ...createReasoningHandlers({
            setChat: setCurrentChat,
            messageId: aiMessagePlaceholder.id,
            isCancelled: () => controller.signal.aborted || pendingStopRef.current,
          }),
          ...createAgentTraceHandlers({
            setChat: setCurrentChat,
            messageId: aiMessagePlaceholder.id,
            isCancelled: () => controller.signal.aborted || pendingStopRef.current,
          }),
          onReplace: (replacement) => {
            if (controller.signal.aborted || pendingStopRef.current) {
              return;
            }
            regenBuffer.dispose();
            if (streamBufferRef.current === regenBuffer) streamBufferRef.current = null;
            setCurrentChat((prevChat) => {
              if (!prevChat) return prevChat;
              const updatedMessages = prevChat.messages.map((msg) => {
                if (msg.id === aiMessagePlaceholder.id) {
                  return { ...msg, content: replacement };
                }
                return msg;
              });
              return { ...prevChat, messages: updatedMessages };
            });
          },
        }
      );

    } catch (error) {
      console.error("Regeneration failed:", error);
      // Defensive: if generateAIStream throws before onError fires, the
      // buffer would otherwise stay alive and flush into a stale tree.
      streamBufferRef.current?.dispose();
      streamBufferRef.current = null;
      setIsLoading(false);
      setIsStreaming(false);
      setCurrentStreamId(null);
      abortControllerRef.current = null;
    }
  };

  // Stable identities via a latest-ref. Previously these two were plain
  // closures recreated every render, which forced the `currentChatValue`
  // useMemo to recompute on every render → a render storm during streaming
  // that crashed the chat page ("Algo salió mal"). The ref keeps the impl
  // fresh while the exported callbacks stay referentially stable.
  const regenerateMessageRef = useRef(regenerateMessageImpl)
  regenerateMessageRef.current = regenerateMessageImpl
  const regenerateMessage = useCallback((messageId?: string) => regenerateMessageRef.current(messageId), [])
  const regenerateLastMessage = useCallback(() => regenerateMessageRef.current(), [])

  const editAndRegenerate = useCallback(async (messageId: string, newContent: string, files?: any[]) => {
    if (!currentChat || isLoading) return;

    const messageIndex = currentChat.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const originalMessage = currentChat.messages[messageIndex];
    const messagesUpToEdit = currentChat.messages.slice(0, messageIndex);
    const updatedFiles = files ?? originalMessage.files;

    const updatedUserMessage = {
      ...originalMessage,
      content: newContent,
      files: updatedFiles,
    };

    const aiMessagePlaceholder: Message = {
      id: `ai-regen-${Date.now()}`,
      chatId: currentChat.id,
      role: 'ASSISTANT',
      content: "",
      timestamp: new Date().toISOString(),
    };

    // Update UI state in one go to prevent race conditions
    setCurrentChat(prev => prev ? { ...prev, messages: [...messagesUpToEdit, updatedUserMessage, aiMessagePlaceholder] } : null);
    setIsLoading(true);
    setIsStreaming(true);
    setPendingStopSynced(false);
    const streamId = safeUUID();
    setCurrentStreamId(streamId);

    // Create new AbortController for edit and regeneration
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Register this chat as actively streaming so the UI lights up the
    // thinking placeholder (animated SVG) and the stop-chat button —
    // same path the normal send flow uses via markChatStreaming.
    markChatStreaming(currentChat.id, streamId, controller);

    try {
      // Update the message in the backend. This should also handle deleting subsequent messages.
      await apiClient.editUserMessage(messageId, { content: newContent });

      const parsedFiles = typeof updatedUserMessage.files === 'string'
        ? JSON.parse(updatedUserMessage.files)
        : updatedUserMessage.files;

      // Documento adjunto + verbo de edición → mismo camino del editor de
      // documentos que el envío normal. El stream genérico respondería con
      // el gate de aclaración ("¿qué formato quieres?") y la instrucción de
      // edición se perdería — exactamente el bug de "reenviar" reportado.
      const editFilesArr: any[] = Array.isArray(parsedFiles) ? parsedFiles : [];
      const editFileIds = editFilesArr.map((f: any) => String(f?.id || f?.fileId || '')).filter(Boolean);
      const editHasDocAttachment = editFilesArr.some((f: any) => {
        const name = String(f?.name || f?.originalName || f?.filename || '');
        const mime = String(f?.mimeType || f?.type || '');
        return /\.(docx?|xlsx?|pptx?|pdf|txt|md|csv)$/i.test(name)
          || /(wordprocessingml|spreadsheetml|presentationml|msword|ms-excel|ms-powerpoint|pdf|text\/)/i.test(mime);
      });
      const editVerbHay = `${newContent} ${newContent.replace(/([a-zA-Z])\1+/g, '$1')}`;
      const editLooksLikeDocEdit = /\b(agrega\w*|a[ñn]ad\w*|borr\w*|elimin\w*|quit\w*|reemplaz\w*|complet\w*|rellen\w*|llen\w*|edit\w*|modific\w*|corrig\w*|insert\w*|cambi\w*|actualiz\w*)\b/i.test(editVerbHay);
      if (editHasDocAttachment && editLooksLikeDocEdit && editFileIds.length) {
        let docFinalMsg: any = null;
        let docStage = 'Editando documento';
        let docPct = 0;
        const renderDocProgress = () => {
          setCurrentChat((prev) => {
            if (!prev) return prev;
            const msgs = prev.messages.map((m: any) =>
              m.id === aiMessagePlaceholder.id
                ? { ...m, content: '', progressStage: docStage, progressPct: docPct }
                : m
            );
            return { ...prev, messages: msgs };
          });
        };
        renderDocProgress();
        try {
          await apiClient.generateDocStream(
            { prompt: newContent, chatId: currentChat.id, files: editFileIds },
            (ev: any) => {
              if (controller.signal.aborted) return;
              if (ev.type === 'stage') {
                docStage = ev.label || docStage;
                docPct = typeof ev.pct === 'number' ? ev.pct : docPct;
                renderDocProgress();
              } else if (ev.type === 'final') {
                docFinalMsg = ev.assistantMessage || {
                  id: aiMessagePlaceholder.id,
                  role: 'ASSISTANT',
                  content: ev.content || 'Listo.',
                  files: ev.file ? [ev.file] : [],
                };
                if (docFinalMsg?.files?.[0] && ev.file?.dataUrl) {
                  docFinalMsg.files[0] = { ...docFinalMsg.files[0], dataUrl: ev.file.dataUrl };
                }
              } else if (ev.type === 'error') {
                docFinalMsg = ev.assistantMessage || {
                  id: aiMessagePlaceholder.id,
                  role: 'ASSISTANT',
                  content: `No pude editar el documento: ${ev.error || 'error desconocido'}.`,
                  files: [],
                };
              }
            },
            { signal: controller.signal },
          );
        } catch (err: any) {
          if (err?.name !== 'AbortError') {
            docFinalMsg = docFinalMsg || {
              id: aiMessagePlaceholder.id,
              role: 'ASSISTANT',
              content: `No pude editar el documento: ${err?.message || 'error de red'}.`,
              files: [],
            };
          }
        }
        if (docFinalMsg) {
          setCurrentChat((prev) => {
            if (!prev) return prev;
            const msgs = prev.messages.map((m: any) =>
              m.id === aiMessagePlaceholder.id ? { ...docFinalMsg, id: docFinalMsg.id || aiMessagePlaceholder.id } : m
            );
            return { ...prev, messages: msgs };
          });
        }
        markChatIdle(currentChat.id, streamId);
        setIsLoading(false);
        setIsStreaming(false);
        setCurrentStreamId(null);
        abortControllerRef.current = null;
        return;
      }

      // Per-frame buffer (edit-and-regenerate path).
      streamBufferRef.current?.dispose();
      const editBuffer = createStreamBuffer({
        onFlush: (joined) => {
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const updatedMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: msg.content + joined };
              }
              return msg;
            });
            return { ...prevChat, messages: updatedMessages };
          });
        },
      });
      streamBufferRef.current = editBuffer;

      // Now, generate the new response
      await apiClient.generateAIStream(
        {
          provider: selectProvider,
          model: selectedModel,
          reasoningEffort: selectedEffort,
          prompt: newContent,
          chatId: currentChat.id,
          files: Array.isArray(parsedFiles) ? parsedFiles : [], // Pass file IDs
          streamId: streamId,
          regenerate: true,
        },
        (chunk) => {
          // Check if we should stop processing chunks
          if (controller.signal.aborted || pendingStopRef.current) {
            return;
          }
          editBuffer.append(chunk);
        },
        async () => {
          // Only complete if not manually stopped
          editBuffer.flush();
          editBuffer.dispose();
          if (streamBufferRef.current === editBuffer) streamBufferRef.current = null;
          if (!controller.signal.aborted && !pendingStopRef.current) {
            markChatIdle(currentChat.id, streamId);
            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;

            // Delayed ID sync — same pattern as addMessage/regenerateMessage onClose.
            const editChatId = currentChat.id;
            const syncIds = async (attempt = 1) => {
              if (isStreamingRef.current) return;
              try {
                const freshChat = await apiClient.getChat(editChatId);
                setCurrentChat(prev => {
                  if (!prev || prev.id !== editChatId || isStreamingRef.current) return prev;
                  return mergeChatPreservingUserMessages(freshChat.chat, prev);
                });
                setChats(prevChats =>
                  prevChats.filter(chat => chat && chat.id).map(chat =>
                    chat.id === editChatId ? mergeChatPreservingUserMessages(freshChat.chat, chat) : chat
                  )
                );
              } catch {
                if (attempt < 3) {
                  setTimeout(() => syncIds(attempt + 1), 2000 * attempt);
                }
              }
            };
            setTimeout(() => syncIds(), 2000);
          }
        },
        (error: any) => {
          // Only handle error if not manually stopped
          editBuffer.flush();
          editBuffer.dispose();
          if (streamBufferRef.current === editBuffer) streamBufferRef.current = null;
          if (!controller.signal.aborted && !pendingStopRef.current) {
            console.error("Streaming failed during regeneration:", error);

            // Check for monthly API limit errors
            const errorMessage = error?.message || '';
            const status = error?.status || error?.statusCode;
            const errorData = error?.errorData;

            if (status === 429 ||
              isMonthlyLimitError(errorMessage) ||
              (errorData && isMonthlyLimitError(errorData.error || ''))) {

              devLog('Monthly limit error detected during edit and regeneration');
              triggerUpgradeModal(errorMessage, errorData);

              setCurrentChat((prevChat) => {
                if (!prevChat) return prevChat;
                const errorMessages = prevChat.messages.map((msg) => {
                  if (msg.id === aiMessagePlaceholder.id) {
                    let usageInfo = '';
                    if (errorData && errorData.usage) {
                      const { current, limit } = errorData.usage;
                      usageInfo = ` You've used ${current?.toLocaleString()} out of ${limit?.toLocaleString()} tokens this month.`;
                    }
                    return {
                      ...msg,
                      content: `Monthly API limit exceeded.${usageInfo} Please upgrade your plan to continue using the service.`,
                      error: "Monthly API limit exceeded"
                    };
                  }
                  return msg;
                });
                return { ...prevChat, messages: errorMessages };
              });
            } else {
              setCurrentChat((prevChat) => {
                if (!prevChat) return prevChat;
                const errorMessages = prevChat.messages.map((msg) => {
                  if (msg.id === aiMessagePlaceholder.id) {
                    return { ...msg, content: "", error: normalizeChatError(error.message || "An error occurred during regeneration.") };
                  }
                  return msg;
                });
                return { ...prevChat, messages: errorMessages };
              });
            }

            markChatIdle(currentChat.id, streamId);
            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;
          }
        },
        controller.signal, // Pass the abort signal
        {
          ...createReasoningHandlers({
            setChat: setCurrentChat,
            messageId: aiMessagePlaceholder.id,
            isCancelled: () => controller.signal.aborted || pendingStopRef.current,
          }),
          ...createAgentTraceHandlers({
            setChat: setCurrentChat,
            messageId: aiMessagePlaceholder.id,
            isCancelled: () => controller.signal.aborted || pendingStopRef.current,
          }),
          onReplace: (replacement) => {
            if (controller.signal.aborted || pendingStopRef.current) {
              return;
            }
            editBuffer.dispose();
            if (streamBufferRef.current === editBuffer) streamBufferRef.current = null;
            setCurrentChat((prevChat) => {
              if (!prevChat) return prevChat;
              const updatedMessages = prevChat.messages.map((msg) => {
                if (msg.id === aiMessagePlaceholder.id) {
                  return { ...msg, content: replacement };
                }
                return msg;
              });
              return { ...prevChat, messages: updatedMessages };
            });
          },
        }
      );
    } catch (error) {
      console.error("Failed to edit and regenerate:", error);
      streamBufferRef.current?.dispose();
      streamBufferRef.current = null;
      markChatIdle(currentChat.id, streamId);
      setIsLoading(false);
      setIsStreaming(false);
      setCurrentStreamId(null);
      abortControllerRef.current = null;
      // Revert UI state on failure
      setCurrentChat(prev => prev ? { ...prev, messages: currentChat.messages } : null);
      toast.error("No se pudo regenerar la respuesta.");
    }
    // pendingStop is a boolean state read inside the regen loop; the
    // latest closure is captured at call time, so listing it would
    // re-create the callback on every keystroke that flips the flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat, isLoading, selectProvider, selectedModel, selectChat, setCurrentChat, setIsLoading, setIsStreaming, setCurrentStreamId, markChatStreaming, markChatIdle]);

  const pollVideoStatus = useCallback((operationId: string, messageId: string) => {
    devLog('🔄 Starting polling for:', operationId);

    const interval = setInterval(async () => {
      try {
        const statusResponse = await apiClient.getVideoStatus(operationId);
        devLog('📊 Video status response:', statusResponse);

        // Normalize status casing
        const status = (statusResponse.status || '').toLowerCase();

        if (status === 'completed' || status === 'failed') {
          devLog(' Video processing finished:', status);
          clearInterval(interval);
          setPollingIntervals(prev => {
            const n = new Map(prev);
            n.delete(operationId);
            return n;
          });

          //  Force refresh chat from DB to get updated message with video file
          if (currentChat?.id) {
            devLog('🔄 Refreshing chat to show completed video');
            await selectChat(currentChat.id);
          }

          //  Also ensure loading state is turned off
          setIsLoading(false);

        } else {
          devLog(' Video still processing:', status);
          // Optional: show "processing" in UI by updating that one message
          setCurrentChat(prev => {
            if (!prev) return prev;
            const updated = prev.messages.map(m => {
              if (m.id !== messageId) return m;
              // Mark as processing if needed
              return m;
            });
            return { ...prev, messages: updated };
          });
        }
      } catch (error) {
        console.error(' Error polling video status:', error);
        clearInterval(interval);
        setPollingIntervals(prev => {
          const n = new Map(prev);
          n.delete(operationId);
          return n;
        });
        setIsLoading(false);
      }
    }, 5000); // Reduced polling interval to 5 seconds for faster updates

    setPollingIntervals(prev => {
      const n = new Map(prev);
      n.set(operationId, interval);
      return n;
    });
  }, [currentChat?.id, selectChat, setCurrentChat]);

  const addVideoMessage = useCallback(async (prompt: string, fileIds?: string[], chat?: any, options?: VideoGenerationOptions) => {
    const activeChat = chat || currentChat; // Use provided chat or fallback to currentChat
    if (!activeChat || !user) return;
    const aspectRatio = options?.aspectRatio || '16:9';
    const duration = options?.duration || 8;
    const resolution = options?.resolution || '720p';
    const audio = options?.audio ?? true;
    const model = options?.model || selectedModel;

    setIsLoading(true);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const backendBaseUrl = baseUrl.replace('/api', '');
      const imageUrls: string[] = [];
      const addImageUrl = (rawUrl?: string | null) => {
        const raw = String(rawUrl || '').trim();
        if (!raw) return;
        const url = raw.startsWith('http') ? raw : `${backendBaseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`;
        if (!imageUrls.includes(url)) imageUrls.push(url);
      };

      (options?.sourceImageUrls || []).forEach(addImageUrl);

      // First try to get image URL from uploadedFiles context
      if (uploadedFiles && uploadedFiles.length > 0) {
        uploadedFiles
          .filter(f => f.type?.startsWith('image/') || f.mimeType?.startsWith('image/'))
          .forEach((imageFile) => addImageUrl(imageFile.url));
      }

      // Fallback/enrichment from the API so every selected image id is included.
      if (fileIds && fileIds.length > 0) {
        try {
          for (const fileId of fileIds) {
            const fileResponse = await apiClient.getFile(fileId);
            const file = fileResponse.file;

            if (file && file.mimeType?.startsWith('image/')) {
              if (file.url) {
                addImageUrl(file.url);
              } else if (file.filename && file.userId) {
                addImageUrl(`/uploads/${file.userId}/${file.filename}`);
              }
            }
          }
        } catch (err) {
          console.error('Error getting file details for video generation:', err);
        }
      }

      const imageUrl = imageUrls[0] || null;

      // REMOVE THIS BLOCK - Backend handles user message creation
      // await apiClient.addMessage(activeChat.id, {
      //   role: 'USER',
      //   content: prompt,
      //   files: fileIds
      // });

      devLog('🎬 Calling generateVideo with:', {
        prompt,
        aspect_ratio: aspectRatio,
        duration,
        resolution,
        audio,
        chatId: activeChat.id,
        files: fileIds,
        image_url: imageUrl,
        image_urls: imageUrls
      });

      // 2) Kick off video generation with files and image URL
      const videoResponse = await apiClient.generateVideo({
        prompt,
        aspect_ratio: aspectRatio,
        duration,
        resolution,
        audio,
        chatId: activeChat.id,
        files: fileIds,
        ...(imageUrl && { image_url: imageUrl }),
        ...(imageUrls.length > 0 && { image_urls: imageUrls }),
        model
      }, { signal: options?.signal });

      devLog(' Video generation response:', videoResponse);

      //  Refresh chat to get the updated messages from backend
      await selectChat(activeChat.id);

      const findAssistantByOperation = (chat: any, opId: string) => {
        if (!chat?.messages) return null;
        for (const m of chat.messages) {
          if (m.role !== 'ASSISTANT' || !m.files) continue;
          try {
            const files = typeof m.files === 'string' ? JSON.parse(m.files) : m.files;
            if (Array.isArray(files) && files.some((f: any) => f?.type === 'video' && f?.operationId === opId)) {
              return m;
            }
          } catch {
            // ignore bad JSON
          }
        }
        return null;
      };

      //  Get the updated chat after refresh
      const freshChat = await apiClient.getChat(activeChat.id);
      let targetMessage = findAssistantByOperation(freshChat.chat, videoResponse.operationId);

      if (!targetMessage) {
        console.warn('Could not find assistant message for operation:', videoResponse.operationId);
        // Use operationId as fallback
        targetMessage = { id: videoResponse.operationId };
      }

      const messageId = targetMessage?.id || videoResponse.operationId;
      devLog('🎯 Starting polling for operation:', videoResponse.operationId, 'message:', messageId);
      pollVideoStatus(videoResponse.operationId, messageId);

    } catch (error) {
      console.error("❌ Failed to generate video:", error);
      throw error;
    } finally {
      setIsLoading(false);
      setUploadedFiles([]); // Clear uploaded files after processing
    }
    // `token` intentionally omitted — apiClient reads the latest auth
    // token at call time, so adding it here only triggers unnecessary
    // re-creations of this callback on token refresh.
  }, [currentChat, user, selectedModel, uploadedFiles, selectChat, pollVideoStatus]);

  const addThesisMessage = useCallback(async (topics: string[], chat?: any) => {
    const activeChat = chat || currentChat;
    if (!activeChat || !user) return;

    setIsLoading(true);
    try {
      // Create user message first
      await apiClient.addMessage(activeChat.id, {
        role: 'USER',
        content: topics.join(', ')
      });

      // Start thesis generation
      const response = await apiClient.generateThesis({
        topics: topics,
        chatId: activeChat.id
      });

      // Create assistant message with thesis data
      const assistantMessage = await apiClient.addMessage(activeChat.id, {
        role: 'ASSISTANT',
        content: '🔍 **Initializing Thesis Generation**\n\nPreparing to research and analyze your topics...\n\n*Starting academic source search*',
        metadata: JSON.stringify({
          thesisData: {
            sessionId: response.sessionId,
            status: 'initializing',
            progress: 5,
            message: 'Starting thesis generation...',
            topics: topics
          }
        })
      });

      // Refresh chat to get the updated messages
      await selectChat(activeChat.id);

      // Start polling for thesis status - pass chatId to ensure correct chat is updated
      pollThesisStatus(response.sessionId, assistantMessage.message.id, activeChat.id);

      toast.success('Thesis generation started!');
    } catch (error: any) {
      console.error("Failed to start thesis generation:", error);
      toast.error(error.message || 'Failed to start thesis generation');
      throw error;
    } finally {
      setIsLoading(false);
    }
    // pollThesisStatus is defined just below — adding it here would
    // be a use-before-define. We use the latest closure (recreated
    // each render is fine for a long-running stream-start handler).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat, user, token, selectChat]);

  const pollThesisStatus = useCallback((sessionId: string, messageId: string, chatId: string) => {
    const interval = setInterval(async () => {
      try {
        const statusResponse = await apiClient.getThesisStatus(sessionId);

        // Update message in the specific chat (works for both new and existing chats)
        setChats(prevChats => {
          return prevChats.filter(chat => chat && chat.id).map(chat => {
            if (chat.id === chatId) {
              const updatedMessages = chat.messages.map(msg => {
                if (msg.id === messageId) {
                let progressContent = '';
                
                // Generate detailed progress content based on status and message
                if (statusResponse.status === 'searching') {
                  progressContent = `🔍 **Searching Academic Sources**\n\n`;
                  
                  // Show cumulative search progress based on screenshots
                  const searchSteps = [
                    'Google Scholar', 'ResearchGate', 'PubMed', 'ArXiv', 'IEEE Xplore', 'Wikipedia', 'Google Search'
                  ];
                  
                  const completedSources = statusResponse.screenshots?.map((s: any) => s.source) || [];
                  
                  searchSteps.forEach(step => {
                    if (completedSources.includes(step)) {
                      progressContent += `✅ ${step} - Completed\n`;
                    } else if (statusResponse.currentSource === step) {
                      progressContent += `🔍 ${step} - Searching...\n`;
                    } else {
                      progressContent += `⏳ ${step} - Pending\n`;
                    }
                  });
                  
                  progressContent += `\n*Progress: ${statusResponse.progress || 30}%*`;
                } else if (statusResponse.status === 'generating') {
                  progressContent = `📝 **Generating Thesis Document**\n\n`;
                  progressContent += `Analyzing collected sources and writing comprehensive thesis...\n`;
                  progressContent += `Creating structured academic document with citations.\n\n`;
                  progressContent += `*Progress: ${statusResponse.progress || 70}%*`;
                } else if (statusResponse.status === 'completed') {
                  progressContent = `✅ **Thesis Generation Completed!**\n\n`;
                  progressContent += `Your comprehensive academic thesis is ready.\n`;
                  if (statusResponse.documentFilename) {
                    progressContent += `**Document:** ${statusResponse.documentFilename}\n`;
                  }
                  if (statusResponse.sourcesCount) {
                    progressContent += `**Sources:** ${statusResponse.sourcesCount} academic references\n`;
                  }
                  progressContent += `\nClick Preview to view or Download to save the document.`;
                } else if (statusResponse.status === 'error') {
                  progressContent = `❌ **Thesis Generation Error**\n\n${statusResponse.error || 'An unexpected error occurred.'}`;
                } else {
                  progressContent = `⏳ **Processing...**\n\n${statusResponse.message || 'Working on your thesis generation...'}`;
                }

                  return {
                    ...msg,
                    content: progressContent,
                    thesisData: {
                      sessionId,
                      status: statusResponse.status,
                      progress: statusResponse.progress || 0,
                      message: statusResponse.message,
                      topics: statusResponse.topics || [],
                      sourcesCount: statusResponse.sourcesCount,
                      documentPath: statusResponse.documentPath,
                      documentFilename: statusResponse.documentFilename,
                      error: statusResponse.error,
                      currentSource: statusResponse.currentSource,
                      currentUrl: statusResponse.currentUrl,
                      currentScreenshot: statusResponse.currentScreenshot,
                      screenshots: statusResponse.screenshots || []
                    }
                  };
                }
                return msg;
              });
              return { ...chat, messages: updatedMessages };
            }
            return chat;
          });
        });

        // Also update currentChat if it matches the chatId (for immediate UI update)
        setCurrentChat(prevChat => {
          if (!prevChat || prevChat.id !== chatId) return prevChat;
          
          // Use the same update logic to keep them in sync
          const updatedMessages = prevChat.messages.map(msg => {
            if (msg.id === messageId) {
              let progressContent = '';
              
              if (statusResponse.status === 'searching') {
                progressContent = `🔍 **Searching Academic Sources**\n\n`;
                const searchSteps = [
                  'Google Scholar', 'ResearchGate', 'PubMed', 'ArXiv', 'IEEE Xplore', 'Wikipedia', 'Google Search'
                ];
                const completedSources = statusResponse.screenshots?.map((s: any) => s.source) || [];
                searchSteps.forEach(step => {
                  if (completedSources.includes(step)) {
                    progressContent += `✅ ${step} - Completed\n`;
                  } else if (statusResponse.currentSource === step) {
                    progressContent += `🔍 ${step} - Searching...\n`;
                  } else {
                    progressContent += `⏳ ${step} - Pending\n`;
                  }
                });
                progressContent += `\n*Progress: ${statusResponse.progress || 30}%*`;
              } else if (statusResponse.status === 'generating') {
                progressContent = `📝 **Generating Thesis Document**\n\n`;
                progressContent += `Analyzing collected sources and writing comprehensive thesis...\n`;
                progressContent += `Creating structured academic document with citations.\n\n`;
                progressContent += `*Progress: ${statusResponse.progress || 70}%*`;
              } else if (statusResponse.status === 'completed') {
                progressContent = `✅ **Thesis Generation Completed!**\n\n`;
                progressContent += `Your comprehensive academic thesis is ready.\n`;
                if (statusResponse.documentFilename) {
                  progressContent += `**Document:** ${statusResponse.documentFilename}\n`;
                }
                if (statusResponse.sourcesCount) {
                  progressContent += `**Sources:** ${statusResponse.sourcesCount} academic references\n`;
                }
                progressContent += `\nClick Preview to view or Download to save the document.`;
              } else if (statusResponse.status === 'error') {
                progressContent = `❌ **Thesis Generation Error**\n\n${statusResponse.error || 'An unexpected error occurred.'}`;
              } else {
                progressContent = `⏳ **Processing...**\n\n${statusResponse.message || 'Working on your thesis generation...'}`;
              }

              return {
                ...msg,
                content: progressContent,
                thesisData: {
                  sessionId,
                  status: statusResponse.status,
                  progress: statusResponse.progress || 0,
                  message: statusResponse.message,
                  topics: statusResponse.topics || [],
                  sourcesCount: statusResponse.sourcesCount,
                  documentPath: statusResponse.documentPath,
                  documentFilename: statusResponse.documentFilename,
                  error: statusResponse.error,
                  currentSource: statusResponse.currentSource,
                  currentUrl: statusResponse.currentUrl,
                  currentScreenshot: statusResponse.currentScreenshot,
                  screenshots: statusResponse.screenshots || []
                }
              };
            }
            return msg;
          });
          return { ...prevChat, messages: updatedMessages };
        });

        // Stop polling when completed or error
        if (statusResponse.status === 'completed' || statusResponse.status === 'error') {
          clearInterval(interval);
          setPollingIntervals(prev => {
            const newMap = new Map(prev);
            newMap.delete(sessionId);
            return newMap;
          });
        }
      } catch (error) {
        console.error('Error polling thesis status:', error);
      }
    }, 2000); // Poll every 2 seconds for more frequent updates

    // Store interval for cleanup
    setPollingIntervals(prev => {
      const newMap = new Map(prev);
      newMap.set(sessionId, interval);
      return newMap;
    });
  }, []);

  // Cleanup function for polling intervals
  React.useEffect(() => {
    return () => {
      // Cleanup all polling intervals when component unmounts
      pollingIntervals.forEach((interval) => {
        clearInterval(interval);
      });
      setPollingIntervals(new Map());
    };
    // Empty deps array: cleanup must run only on unmount. Listing
    // pollingIntervals here would re-run cleanup on every map change,
    // clearing intervals we're actively polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Video polling function


  // const pollVideoStatus = useCallback((operationId: string, messageId: string) => {
  //   const interval = setInterval(async () => {
  //     try {
  //       const statusResponse = await apiClient.getVideoStatus(operationId)

  //       if (statusResponse.status === 'completed' || statusResponse.status === 'failed') {
  //         // Clear interval
  //         clearInterval(interval)
  //         setPollingIntervals(prev => {
  //           const newMap = new Map(prev)
  //           newMap.delete(operationId)
  //           return newMap
  //         })

  //         // Update message in current chat
  //         if (currentChat) {
  //           setCurrentChat(prevChat => {
  //             if (!prevChat) return prevChat

  //             const updatedMessages = prevChat.messages.map(msg => {
  //               if (msg.id === messageId) {
  //                 return {
  //                   ...msg,
  //                   content: statusResponse.status === 'completed' 
  //                     ? `Video generated successfully: "${statusResponse.prompt}"`
  //                     : `Video generation failed: ${statusResponse.error}`,
  //                   videoData: {
  //                     ...msg.videoData!,
  //                     status: statusResponse.status,
  //                     filename: statusResponse.filename,
  //                     error: statusResponse.error
  //                   }
  //                 }
  //               }
  //               return msg
  //             })

  //             return {
  //               ...prevChat,
  //               messages: updatedMessages
  //             }
  //           })
  //         }
  //       }
  //     } catch (error) {
  //       console.error('Error polling video status:', error)
  //       clearInterval(interval)
  //       setPollingIntervals(prev => {
  //         const newMap = new Map(prev)
  //         newMap.delete(operationId)
  //         return newMap
  //       })
  //     }
  //   }, 5000) // Poll every 5 seconds

  //   // Store interval for cleanup
  //   setPollingIntervals(prev => {
  //     const newMap = new Map(prev)
  //     newMap.set(operationId, interval)
  //     return newMap
  //   })
  // }, [currentChat])

  const updateMessageInChat = useCallback((messageId: string, newContent: string) => {
    setCurrentChat(prevChat => {
      if (!prevChat) return prevChat

      const updatedMessages = prevChat.messages.map(msg => {
        if (msg.id === messageId) {
          return { ...msg, content: newContent }
        }
        return msg
      })

      return {
        ...prevChat,
        messages: updatedMessages
      }
    })
  }, [])

  // Cleanup polling intervals on unmount
  useEffect(() => {
    return () => {
      pollingIntervals.forEach(interval => clearInterval(interval))
    }
  }, [pollingIntervals])

  // ────────────────────────────────────────────────────────────────
  // Context split (task #57). The provider still owns all state in a
  // single place, but exposes it through four separate React contexts
  // so each consumer only re-renders when *its* slice changes:
  //
  //   ChatListContext       lista de chats + selección       (sidebar)
  //   CurrentChatContext    chat actual + historial          (lista de mensajes)
  //   StreamingContext      isStreaming/isLoading/addMessage (composer)
  //   ModelsFilesContext    modelos + archivos adjuntos      (badge / composer)
  //
  // Sub-values are memoized on their real inputs. While Sira responde,
  // sólo `currentChat` cambia por frame; los demás value objects
  // conservan identidad y la sidebar / catálogo no se re-renderizan.
  //
  // `useChat()` se mantiene como hook de compatibilidad — compone los
  // cuatro contextos en un único objeto. Los consumidores legacy
  // siguen funcionando sin cambios, pero pierden el beneficio del
  // split hasta migrarse a los hooks específicos.
  // ────────────────────────────────────────────────────────────────

  const currentChatId = currentChat?.id ?? null
  const currentChatTitle = currentChat?.title ?? null

  // Identity-stable wrappers for the action callbacks exposed on
  // ChatListContext. Several of the originals (`createNewChat`,
  // `deleteChat`) depend on `currentChat` or `addMessage`, which means
  // their identity changes on every token flush during a stream. If we
  // included those raw references in `chatListValue`, the memo would
  // be invalidated every frame and the sidebar would re-render. The
  // wrappers below are created once and forward to the latest
  // implementation via refs — so the sidebar sees a frozen value
  // object while a stream is in progress. (Task #57.)
  const createNewChatRef = useRef(createNewChat)
  const selectChatRef = useRef(selectChat)
  const deleteChatRef = useRef(deleteChat)
  const loadMoreChatsRef = useRef(loadMoreChats)
  const resetChatsRef = useRef(resetChats)
  useEffect(() => { createNewChatRef.current = createNewChat }, [createNewChat])
  useEffect(() => { selectChatRef.current = selectChat }, [selectChat])
  useEffect(() => { deleteChatRef.current = deleteChat }, [deleteChat])
  useEffect(() => { loadMoreChatsRef.current = loadMoreChats }, [loadMoreChats])
  useEffect(() => { resetChatsRef.current = resetChats }, [resetChats])
  const stableCreateNewChat = useCallback(((...args: Parameters<typeof createNewChat>) =>
    createNewChatRef.current(...args)) as typeof createNewChat, [])
  const stableSelectChat = useCallback((chatId: string) => selectChatRef.current(chatId), [])
  const stableDeleteChat = useCallback((chatId: string) => deleteChatRef.current(chatId), [])
  const stableLoadMoreChats = useCallback(() => loadMoreChatsRef.current(), [])
  const stableResetChats = useCallback(() => resetChatsRef.current(), [])

  const chatListValue = useMemo<ChatListContextType>(() => ({
    chats,
    pagination,
    hasMoreChats,
    isLoadingMore,
    isLoadingChats: isLoading,
    currentChatId,
    currentChatTitle,
    setCurrentChat,
    selectChat: stableSelectChat,
    deleteChat: stableDeleteChat,
    createNewChat: stableCreateNewChat,
    loadMoreChats: stableLoadMoreChats,
    resetChats: stableResetChats,
    getCurrentChatSnapshot,
  }), [
    chats, pagination, hasMoreChats, isLoadingMore, isLoading,
    currentChatId, currentChatTitle,
    setCurrentChat, stableSelectChat, stableDeleteChat, stableCreateNewChat,
    stableLoadMoreChats, stableResetChats, getCurrentChatSnapshot,
  ])

  const currentChatValue = useMemo<CurrentChatContextType>(() => ({
    currentChat,
    setCurrentChat,
    updateMessageInChat,
    regenerateMessage,
    regenerateLastMessage,
    editAndRegenerate,
    clearCurrentChat,
    addVideoMessage,
    addThesisMessage,
    pollVideoStatus,
    chatType,
    setChatType,
  }), [
    currentChat,
    setCurrentChat, updateMessageInChat, regenerateMessage, regenerateLastMessage,
    editAndRegenerate, clearCurrentChat, addVideoMessage, addThesisMessage,
    pollVideoStatus, chatType, setChatType,
  ])

  const streamingValue = useMemo<StreamingContextType>(() => ({
    isStreaming,
    activeStreamingChatIds,
    pendingStop,
    isLoading,
    stopStreaming,
    addMessage,
  }), [isStreaming, activeStreamingChatIds, pendingStop, isLoading, stopStreaming, addMessage])

  const modelsFilesValue = useMemo<ModelsFilesContextType>(() => ({
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    selectProvider,
    setSelectedProivder,
    availableModels,
    refreshModels,
    uploadedFiles,
    setUploadedFiles,
  }), [
    selectedModel, setSelectedModel, selectedEffort, setSelectedEffort, selectProvider, setSelectedProivder,
    availableModels, refreshModels, uploadedFiles, setUploadedFiles,
  ])

  return (
    <ChatListContext.Provider value={chatListValue}>
      <ModelsFilesContext.Provider value={modelsFilesValue}>
        <StreamingContext.Provider value={streamingValue}>
          <CurrentChatContext.Provider value={currentChatValue}>
            {children}
          </CurrentChatContext.Provider>
        </StreamingContext.Provider>
      </ModelsFilesContext.Provider>
    </ChatListContext.Provider>
  )
}

// ────────────────────────────────────────────────────────────────────
// Split contexts (task #57)
// ────────────────────────────────────────────────────────────────────

interface ChatListContextType {
  chats: Chat[]
  pagination: PaginationInfo | null
  hasMoreChats: boolean
  isLoadingMore: boolean
  isLoadingChats: boolean
  /** Only the id/title summary of the active chat — full object lives
   *  in CurrentChatContext so token streams don't re-render the sidebar. */
  currentChatId: string | null
  currentChatTitle: string | null
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat | null>>
  selectChat: (chatId: string) => void
  deleteChat: (chatId: string) => Promise<boolean> | boolean
  createNewChat: ChatContextType["createNewChat"]
  loadMoreChats: () => Promise<void>
  resetChats: () => void
  /** Read the current chat without subscribing — useful for rare
   *  click handlers (e.g. exporting) that need messages on demand. */
  getCurrentChatSnapshot: () => Chat | null
}

interface CurrentChatContextType {
  currentChat: Chat | null
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat | null>>
  updateMessageInChat: (messageId: string, newContent: string) => void
  regenerateMessage: (messageId?: string) => void
  regenerateLastMessage: () => void
  editAndRegenerate: (messageId: string, newContent: string, files?: any[]) => void
  clearCurrentChat: () => void
  addVideoMessage: (prompt: string, fileIds?: string[], chat?: any, options?: VideoGenerationOptions) => Promise<void>
  addThesisMessage: (topics: string[]) => Promise<void>
  pollVideoStatus: (operationId: string, messageId: string) => void
  chatType: ChatContextType["chatType"]
  setChatType: ChatContextType["setChatType"]
}

interface StreamingContextType {
  isStreaming: boolean
  activeStreamingChatIds: string[]
  pendingStop: boolean
  isLoading: boolean
  stopStreaming: () => void
  addMessage: ChatContextType["addMessage"]
}

interface ModelsFilesContextType {
  selectedModel: string
  setSelectedModel: (model: string) => void
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
  selectProvider: string
  setSelectedProivder: (model: string) => void
  availableModels: any[]
  refreshModels: () => void | Promise<void>
  uploadedFiles: any[]
  setUploadedFiles: React.Dispatch<React.SetStateAction<any[]>>
}

const ChatListContext = createContext<ChatListContextType | undefined>(undefined)
const CurrentChatContext = createContext<CurrentChatContextType | undefined>(undefined)
const StreamingContext = createContext<StreamingContextType | undefined>(undefined)
const ModelsFilesContext = createContext<ModelsFilesContextType | undefined>(undefined)

export function useChatList(): ChatListContextType {
  const ctx = useContext(ChatListContext)
  if (!ctx) throw new Error("useChatList must be used within a ChatProvider")
  return ctx
}

export function useCurrentChat(): CurrentChatContextType {
  const ctx = useContext(CurrentChatContext)
  if (!ctx) throw new Error("useCurrentChat must be used within a ChatProvider")
  return ctx
}

export function useStreamingState(): StreamingContextType {
  const ctx = useContext(StreamingContext)
  if (!ctx) throw new Error("useStreamingState must be used within a ChatProvider")
  return ctx
}

export function useModelsAndFiles(): ModelsFilesContextType {
  const ctx = useContext(ModelsFilesContext)
  if (!ctx) throw new Error("useModelsAndFiles must be used within a ChatProvider")
  return ctx
}

/**
 * Legacy composite hook. Internally subscribes to the four split
 * contexts and returns them as the original flat shape so existing
 * consumers keep working unchanged. Components that only need a
 * subset should migrate to the specific hooks above for the
 * re-render savings (sidebar, message list, composer, model badge).
 */
export function useChat(): ChatContextType {
  const list = useChatList()
  const current = useCurrentChat()
  const streaming = useStreamingState()
  const mf = useModelsAndFiles()
  // Reconstruct the historical `currentChat` field from the dedicated
  // context (NOT the id-only summary in `list`) so consumers see the
  // full Chat object with messages, exactly as before.
  return useMemo<ChatContextType>(() => ({
    chats: list.chats,
    currentChat: current.currentChat,
    setCurrentChat: current.setCurrentChat,
    createNewChat: list.createNewChat,
    selectChat: list.selectChat,
    addMessage: streaming.addMessage,
    addVideoMessage: current.addVideoMessage,
    addThesisMessage: current.addThesisMessage,
    clearCurrentChat: current.clearCurrentChat,
    deleteChat: list.deleteChat,
    selectedModel: mf.selectedModel,
    setSelectedModel: mf.setSelectedModel,
    selectedEffort: mf.selectedEffort,
    setSelectedEffort: mf.setSelectedEffort,
    selectProvider: mf.selectProvider,
    setSelectedProivder: mf.setSelectedProivder,
    isLoading: streaming.isLoading,
    availableModels: mf.availableModels,
    refreshModels: mf.refreshModels,
    chatType: current.chatType,
    setChatType: current.setChatType,
    uploadedFiles: mf.uploadedFiles,
    setUploadedFiles: mf.setUploadedFiles,
    regenerateLastMessage: current.regenerateLastMessage,
    regenerateMessage: current.regenerateMessage,
    editAndRegenerate: current.editAndRegenerate,
    updateMessageInChat: current.updateMessageInChat,
    pollVideoStatus: current.pollVideoStatus,
    isStreaming: streaming.isStreaming,
    activeStreamingChatIds: streaming.activeStreamingChatIds,
    pendingStop: streaming.pendingStop,
    stopStreaming: streaming.stopStreaming,
    pagination: list.pagination,
    isLoadingMore: list.isLoadingMore,
    hasMoreChats: list.hasMoreChats,
    loadMoreChats: list.loadMoreChats,
    resetChats: list.resetChats,
  }), [list, current, streaming, mf])
}
