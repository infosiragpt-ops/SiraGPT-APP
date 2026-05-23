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
import { aiService, buildProfessionalCapabilityPrompt, shouldAnswerFromExistingDocument, type ChatIntent } from "./ai-service"
import { buildDocumentChatRequest } from "./document-chat-request"
import { mergeChatPreservingUserMessages } from "./message-preservation"
import { toast } from "sonner"
import { useBackgroundStreams } from "./background-streams-context"
import { save as savePending, clear as clearPending, retryAll } from "./pending-messages"
import { devLog } from "./dev-log"
import { createStreamBuffer, type StreamBuffer } from "./stream-buffer"

// Helper function to check if error is related to monthly API limit
const isMonthlyLimitError = (errorMessage: string) => {
  const lowerMessage = errorMessage.toLowerCase();
  return lowerMessage.includes('monthly api limit exceeded') ||
    lowerMessage.includes('monthly limit exceeded') ||
    lowerMessage.includes('monthly video generation limit exceeded') ||
    lowerMessage.includes('free monthly queries exhausted') ||
    (lowerMessage.includes('monthly') && lowerMessage.includes('limit'));
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
    options?: { skipInitialProcessing?: boolean; isWordConnectorChat?: boolean; isExcelConnectorChat?: boolean; projectId?: string; initialIntent?: ChatIntent }
  ) => Promise<any>
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: any[], chat?: any, skipUserMessage?: boolean, intentOverride?: ChatIntent) => Promise<void>
  addVideoMessage: (prompt: string, fileIds?: string[]) => Promise<void>
  addThesisMessage: (topics: string[]) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  selectProvider: string
  setSelectedProivder: (model: string) => void
  isLoading: boolean
  availableModels: any[]
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
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const streamBufferRef = useRef<StreamBuffer | null>(null);
  const chatsRef = useRef<Chat[]>([])
  const isStreamingRef = useRef(false)
  const currentChatRef = useRef<Chat | null>(null)

  useEffect(() => { chatsRef.current = chats }, [chats])
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
  useEffect(() => { currentChatRef.current = currentChat }, [currentChat])

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

  // Retry pending messages when the user logs back in
  useEffect(() => {
    if (!user || !token || !addMessage) return
    // Try to send any messages that were saved while offline
    retryAll(async (msg) => {
      try {
        await addMessage(msg.content, msg.fileIds, undefined, false, msg.intentOverride as any)
        return true
      } catch {
        return false
      }
    })
    // addMessage closes over user+token (already in deps); listing the
    // function would lint-loop since it's recreated per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, token])

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
        chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE'
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
          chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE'
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
    devLog("Stop Streaming triggered", { currentStreamId, isStreaming, isLoading });

    // IMMEDIATE UI State Reset - no waiting for API
    setPendingStop(true);
    setIsStreaming(false);
    setIsLoading(false);

    // Abort local fetch request immediately
    if (abortControllerRef.current) {
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
    if (currentStreamId) {
      devLog(`Sending stop signal to backend: ${currentStreamId}`);
      apiClient.stopAIStream(currentStreamId)
        .then(() => {
          devLog("Backend stop signal sent successfully");
        })
        .catch((error) => {
          console.error("Failed to send stop signal to backend:", error);
        })
        .finally(() => {
          setCurrentStreamId(null);
          setPendingStop(false);
        });
    } else {
      setCurrentStreamId(null);
      setPendingStop(false);
    }
  }, [currentStreamId, isStreaming, isLoading]);
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
      const historicalDocumentFileIds = normalizedFileIds.length === 0 && shouldAnswerFromExistingDocument(content, conversationForRouting)
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
        return {
          ...prevChat,
          messages: [...prevChat.messages, aiMessagePlaceholder]
        };
      });

      setUploadedFiles([]); // Uploaded files clear kar dein
      setIsLoading(true); // Loading state start karein
      setIsStreaming(true); // Immediately set streaming to true so stop button appears
      const streamId = crypto.randomUUID();
      setCurrentStreamId(streamId);
      // Reset pending stop state
      setPendingStop(false);
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
              if (controller.signal.aborted || pendingStop) {
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
              if (!controller.signal.aborted && !pendingStop) {
                setIsLoading(false);
                setIsStreaming(false);
                setCurrentStreamId(null);
                abortControllerRef.current = null;
                // After the stream ends, fetch the persisted chat so we can
                // swap optimistic IDs for server IDs. We retry up to 3 times
                // with a delay because the backend may still be persisting
                // (document uploads add 1-3s after [DONE]).
                const syncIds = async (attempt = 1) => {
                  if (isStreamingRef.current) return;
                  try {
                    const resp = await apiClient.getChat(activeChat.id);
                    const serverChat = resp.chat;
                    setCurrentChat(prev => {
                      if (!prev || prev.id !== activeChat.id || isStreamingRef.current) return prev;
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
                if (!controller.signal.aborted && !pendingStop && error.name !== 'AbortError') {
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
              if (!controller.signal.aborted && !pendingStop) {
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
              onReplace: (replacement) => {
                if (controller.signal.aborted || pendingStop) {
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
        setIsLoading(false);
        setIsStreaming(false);
        setCurrentStreamId(null);
      }
    },
    // bg / pendingStop / selectChat / selectProvider are intentionally
    // omitted — they're either refs, secondary helpers, or recreated
    // per render. The hook is scoped to the user-facing inputs
    // (chat, auth, model, files) that matter for the send action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentChat, user, token, selectedModel, uploadedFiles]
  );
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
    options?: { skipInitialProcessing?: boolean; isWordConnectorChat?: boolean; isExcelConnectorChat?: boolean; projectId?: string; initialIntent?: ChatIntent }
  ) => {
    if (!user || !token || !selectedModel) return;
    setChatType(type);
    try {
      const response = await apiClient.createChat({
        title: initialContent ? initialContent.substring(0, 30) : "Nuevo chat",
        model: selectedModel,
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
                model: selectedModel,
              };
              if (initialFiles && initialFiles.length > 0) {
                (imageGenerationPayload as any).fileId = resolveAttachmentId(initialFiles[0]);
              }
              await apiClient.generateImage(imageGenerationPayload);
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
      // Block selectChat during active streaming — the content the user
      // is watching on screen is more up-to-date than anything the API
      // can return, and a fetch here would race the DB write.
      if (isStreamingRef.current) return;

      const cachedChat = chatsRef.current.find(chat => chat?.id === chatId)
      if (cachedChat) {
        setCurrentChat(prev => {
          if (prev?.id === chatId && (prev.messages?.length || 0) > 0) return prev
          return { ...cachedChat, messages: cachedChat.messages || [] }
        })
        localStorage.setItem('currentChatId', chatId)
        setUploadedFiles([])
      }

      try {
        const response = await apiClient.getChat(chatId)
        const chat = response.chat
        setCurrentChat(prev => {
          if (!prev || prev.id !== chatId) return mergeChatPreservingUserMessages(chat, prev)

          // Re-check streaming in case it started while the API call was in flight
          if (isStreamingRef.current) return prev;

          // NEVER overwrite a local chat that has more assistant content
          // than the server returned — the backend may not have persisted
          // the last turn yet (common with document uploads).
          const prevAssistantContent = prev.messages
            ?.filter((m: any) => m?.role?.toUpperCase() !== 'USER' && m?.content)
            .reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) || 0
          const serverAssistantContent = (chat.messages || [])
            .filter((m: any) => m?.role?.toUpperCase() !== 'USER' && m?.content)
            .reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) || 0

          if (prevAssistantContent > serverAssistantContent) {
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
    async (chatId: string) => {
      if (!token) return

      try {
        await apiClient.deleteChat(chatId)
        setChats((prev) => prev.filter((chat) => chat.id !== chatId))
        if (currentChat?.id === chatId) {
          setCurrentChat(null)
          setUploadedFiles([])
        }
      } catch (error) {
        console.error("Failed to delete chat:", error)
      }
    },
    [currentChat, token],
  )


  const regenerateMessage = async (messageId?: string) => {
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

    const streamId = crypto.randomUUID();
    setCurrentStreamId(streamId);
    setIsStreaming(true);
    setPendingStop(false);

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
          prompt: originalUserMessage.content,
          chatId: currentChat.id,
          files: (originalUserMessage.files?.map((f: any) => f.id) as string[]) || [],
          streamId: streamId,
          regenerate: true,
        },
        (chunk) => {
          // Check if we should stop processing chunks
          if (controller.signal.aborted || pendingStop) {
            return;
          }
          regenBuffer.append(chunk);
        },
        async () => {
          // onClose: Stop loading only if not manually stopped
          regenBuffer.flush();
          regenBuffer.dispose();
          if (streamBufferRef.current === regenBuffer) streamBufferRef.current = null;
          if (!controller.signal.aborted && !pendingStop) {
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
          if (!controller.signal.aborted && !pendingStop) {
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
          onReplace: (replacement) => {
            if (controller.signal.aborted || pendingStop) {
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

  // Backward compatibility wrapper
  const regenerateLastMessage = () => regenerateMessage();

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
    setPendingStop(false);
    const streamId = crypto.randomUUID();
    setCurrentStreamId(streamId);

    // Create new AbortController for edit and regeneration
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Update the message in the backend. This should also handle deleting subsequent messages.
      await apiClient.editUserMessage(messageId, { content: newContent });

      const parsedFiles = typeof updatedUserMessage.files === 'string'
        ? JSON.parse(updatedUserMessage.files)
        : updatedUserMessage.files;

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
          prompt: newContent,
          chatId: currentChat.id,
          files: Array.isArray(parsedFiles) ? parsedFiles : [], // Pass file IDs
          streamId: streamId,
          regenerate: true,
        },
        (chunk) => {
          // Check if we should stop processing chunks
          if (controller.signal.aborted || pendingStop) {
            return;
          }
          editBuffer.append(chunk);
        },
        async () => {
          // Only complete if not manually stopped
          editBuffer.flush();
          editBuffer.dispose();
          if (streamBufferRef.current === editBuffer) streamBufferRef.current = null;
          if (!controller.signal.aborted && !pendingStop) {
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
          if (!controller.signal.aborted && !pendingStop) {
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

            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;
          }
        },
        controller.signal, // Pass the abort signal
        {
          onReplace: (replacement) => {
            if (controller.signal.aborted || pendingStop) {
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
  }, [currentChat, isLoading, selectProvider, selectedModel, selectChat, setCurrentChat, setIsLoading, setIsStreaming, setCurrentStreamId]);

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

  const addVideoMessage = useCallback(async (prompt: string, fileIds?: string[], chat?: any) => {
    const activeChat = chat || currentChat; // Use provided chat or fallback to currentChat
    if (!activeChat || !user) return;

    setIsLoading(true);
    try {
      //  Alternative approach: Use uploadedFiles from context if available
      let imageUrl = null;

      // First try to get image URL from uploadedFiles context
      if (uploadedFiles && uploadedFiles.length > 0) {
        const imageFile = uploadedFiles.find(f => f.type?.startsWith('image/'));
        if (imageFile && imageFile.url) {
          const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
          const backendBaseUrl = baseUrl.replace('/api', '');
          imageUrl = imageFile.url.startsWith('http') ? imageFile.url : `${backendBaseUrl}${imageFile.url}`;
          devLog(' Using image from uploadedFiles context:', imageUrl);
        }
      }

      // Fallback to API call if no image found in context
      if (!imageUrl && fileIds && fileIds.length > 0) {
        try {
          for (const fileId of fileIds) {
            const fileResponse = await apiClient.getFile(fileId);
            const file = fileResponse.file;

            if (file && file.mimeType?.startsWith('image/')) {
              const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
              const backendBaseUrl = baseUrl.replace('/api', '');

              if (file.url) {
                imageUrl = file.url.startsWith('http') ? file.url : `${backendBaseUrl}${file.url}`;
              } else if (file.filename && file.userId) {
                imageUrl = `${backendBaseUrl}/uploads/${file.userId}/${file.filename}`;
              }

              devLog('🖼️ Got image URL from API call:', imageUrl);
              break;
            }
          }
        } catch (err) {
          console.error('Error getting file details for video generation:', err);
        }
      }

      // REMOVE THIS BLOCK - Backend handles user message creation
      // await apiClient.addMessage(activeChat.id, {
      //   role: 'USER',
      //   content: prompt,
      //   files: fileIds
      // });

      devLog('🎬 Calling generateVideo with:', {
        prompt,
        aspect_ratio: '16:9',
        chatId: activeChat.id,
        files: fileIds,
        image_url: imageUrl
      });

      // 2) Kick off video generation with files and image URL
      const videoResponse = await apiClient.generateVideo({
        prompt,
        aspect_ratio: '16:9',
        chatId: activeChat.id,
        files: fileIds,
        ...(imageUrl && { image_url: imageUrl }),
        model: selectedModel
      });

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
  const stableDeleteChat = useCallback((chatId: string) => { void deleteChatRef.current(chatId) }, [])
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
    pendingStop,
    isLoading,
    stopStreaming,
    addMessage,
  }), [isStreaming, pendingStop, isLoading, stopStreaming, addMessage])

  const modelsFilesValue = useMemo<ModelsFilesContextType>(() => ({
    selectedModel,
    setSelectedModel,
    selectProvider,
    setSelectedProivder,
    availableModels,
    uploadedFiles,
    setUploadedFiles,
  }), [
    selectedModel, setSelectedModel, selectProvider, setSelectedProivder,
    availableModels, uploadedFiles, setUploadedFiles,
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
  deleteChat: (chatId: string) => void
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
  addVideoMessage: (prompt: string, fileIds?: string[]) => Promise<void>
  addThesisMessage: (topics: string[]) => Promise<void>
  pollVideoStatus: (operationId: string, messageId: string) => void
  chatType: ChatContextType["chatType"]
  setChatType: ChatContextType["setChatType"]
}

interface StreamingContextType {
  isStreaming: boolean
  pendingStop: boolean
  isLoading: boolean
  stopStreaming: () => void
  addMessage: ChatContextType["addMessage"]
}

interface ModelsFilesContextType {
  selectedModel: string
  setSelectedModel: (model: string) => void
  selectProvider: string
  setSelectedProivder: (model: string) => void
  availableModels: any[]
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
    selectProvider: mf.selectProvider,
    setSelectedProivder: mf.setSelectedProivder,
    isLoading: streaming.isLoading,
    availableModels: mf.availableModels,
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
    pendingStop: streaming.pendingStop,
    stopStreaming: streaming.stopStreaming,
    pagination: list.pagination,
    isLoadingMore: list.isLoadingMore,
    hasMoreChats: list.hasMoreChats,
    loadMoreChats: list.loadMoreChats,
    resetChats: list.resetChats,
  }), [list, current, streaming, mf])
}
