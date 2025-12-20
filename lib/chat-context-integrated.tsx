"use client"

import React from "react"
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react"
import { useAuth } from "./auth-context-integrated"
import { apiClient } from "./api"
import { aiService } from "./ai-service"
import { toast } from "sonner"

// Helper function to check if error is related to monthly API limit
const isMonthlyLimitError = (errorMessage: string) => {
  const lowerMessage = errorMessage.toLowerCase();
  return lowerMessage.includes('monthly api limit exceeded') ||
    lowerMessage.includes('monthly limit exceeded') ||
    lowerMessage.includes('monthly video generation limit exceeded') ||
    lowerMessage.includes('free monthly queries exhausted') ||
    (lowerMessage.includes('monthly') && lowerMessage.includes('limit'));
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
  createdAt: string
  updatedAt: string
  messages: Message[]
  customGptId?: string
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
    initialFiles?: string[],
    options?: { skipInitialProcessing?: boolean; isWordConnectorChat?: boolean }
  ) => Promise<any>
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: string[], chat?: any, skipUserMessage?: boolean) => Promise<void>
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
  setUploadedFiles: (files: any[]) => void
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

  const abortControllerRef = useRef<AbortController | null>(null); // ✅ AbortController ref


  // Load user's chats
  useEffect(() => {
    if (user && token) {
      initializeChat()
    }
  }, [user, token])

  const initializeChat = async () => {
    if (hasInitialized) return

    try {
      // Load available models first
      const modelsResponse = await apiClient.getAIModels(
        chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE'
      )
      console.log("modelsResponse", modelsResponse);

      setAvailableModels(modelsResponse.models)

      // Set default model
      if (modelsResponse.models.length > 0 && !selectedModel) {
        console.log("SETSELECT MODEL", modelsResponse.models[0]);

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
      // Agar setup hi mukammal nahi hua to kuch na karein
      if (!hasInitialized) return;

      console.log(`>>> CHAT TYPE BADAL GAYA! Naye models fetch kar raha hoon: ${chatType.toUpperCase()}`);

      try {
        const modelsResponse = await apiClient.getAIModels(
          chatType.toString().toUpperCase() as 'TEXT' | 'IMAGE'


        );

        if (modelsResponse.models && modelsResponse.models.length > 0) {
          setAvailableModels(modelsResponse.models);
          console.log(`>>> ${modelsResponse.models.length} models load ho gaye.`, modelsResponse.models);

          // Pehla model by default select karein
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
  //     console.log("Client-side stream abortion requested.");

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
    console.log("Stop Streaming triggered", { currentStreamId, isStreaming, isLoading });

    // IMMEDIATE UI State Reset - no waiting for API
    setPendingStop(true);
    setIsStreaming(false);
    setIsLoading(false);

    // Abort local fetch request immediately
    if (abortControllerRef.current) {
      console.log("Aborting local fetch request");
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
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
      console.log(`Sending stop signal to backend: ${currentStreamId}`);
      apiClient.stopAIStream(currentStreamId)
        .then(() => {
          console.log("Backend stop signal sent successfully");
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
    async (content: string, fileIds?: string[], chat?: any, skipUserMessage?: boolean) => { // Added skipUserMessage and forceFlowChartDiagram parameters
      const activeChat = chat || currentChat; // Use provided chat or fallback to currentChat
      if (!activeChat || !user || !token) return;

      // STEP 1: User ka message UI mein dikhayein (agar already nahi dikhaya gaya)
      if (!skipUserMessage) {
        const userMessage: Message = {
          id: `msg-user-${Date.now()}`,
          chatId: activeChat.id,
          role: 'USER',
          content,
          timestamp: new Date().toISOString(),
          files: fileIds?.length ? fileIds : undefined,
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
        const intent = await aiService.classifyIntent(content, currentChat?.messages || []);
        console.log('intent', intent);

        if (intent === 'chart') {
          const fileId = uploadedFiles.length > 0 ? uploadedFiles[0].id : undefined;
          const chartResponse = await apiClient.generateChart({
            prompt: content,
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
            prompt: content,
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

        } else {
          // Create new AbortController for this request
          const controller = new AbortController();
          abortControllerRef.current = controller;

          // STEP 3: Nayi streaming API call karein
          await apiClient.generateAIStream(
            {
              provider: selectProvider,
              model: selectedModel,
              prompt: content,
              chatId: activeChat.id,
              files: fileIds || [],
              streamId: streamId,
            },
            (chunk) => {
              // Check if we should stop processing chunks
              if (controller.signal.aborted || pendingStop) {
                return;
              }

              // onData: Jab bhi backend se naya text aaye
              setCurrentChat((prevChat) => {
                if (!prevChat) return prevChat;

                const newMessages = prevChat.messages.map((msg) => {
                  if (msg.id === aiMessagePlaceholder.id) {
                    // Placeholder ke content mein naya chunk jodein
                    return { ...msg, content: msg.content + chunk };
                  }
                  return msg;
                });
                return { ...prevChat, messages: newMessages };
              });
            },
            async () => {
              // onClose: Jab stream khatam ho jaye
              if (!controller.signal.aborted && !pendingStop) {
                setIsLoading(false);
                setIsStreaming(false);
                setCurrentStreamId(null);
                abortControllerRef.current = null;
                await selectChat(activeChat.id); // Refetch chat to get permanent IDs
              }
            },
            (error) => {
              console.error("Streaming failed:", error);

              // Check for monthly API limit errors
              const errorMessage = error?.message || '';
              const status = (error as any)?.status || (error as any)?.statusCode;
              const errorData = (error as any)?.errorData;

              if (status === 429 ||
                isMonthlyLimitError(errorMessage) ||
                (errorData && isMonthlyLimitError(errorData.error || ''))) {

                console.log('Monthly limit error detected in streaming');
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
                        return { ...msg, content: "", error: error.message || "An error occurred." };
                      }
                      return msg;
                    });
                    return { ...prevChat, messages: newMessages };
                  });
                }
              }
            },
            controller.signal // Pass the abort signal
          );
        }
      } catch (error: any) {
        console.error("Failed to start AI stream:", error);

        // Check for monthly API limit errors
        const errorMessage = error?.message || '';
        const status = (error as any)?.status || (error as any)?.statusCode;
        const errorData = (error as any)?.errorData;

        if (status === 429 ||
          isMonthlyLimitError(errorMessage) ||
          (errorData && isMonthlyLimitError(errorData.error || ''))) {

          console.log('Monthly limit error detected in catch block');
          triggerUpgradeModal(errorMessage, errorData);

          // Update message with monthly limit error
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
          // Handle other errors normally
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const newMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: "", error: error.message || "An error occurred." };
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
    [currentChat, user, token, selectedModel, uploadedFiles]
  );
  const handleNewChatWithPlaceholder = useCallback(async (newChat: Chat, initialContent: string, placeholderContent: string, uploadedFiles: any[]) => {
    const userMessage = {
      id: `msg-user-${Date.now()}`,
      chatId: newChat.id,
      role: 'USER' as const,
      content: initialContent,
      timestamp: new Date().toISOString(),
      files: uploadedFiles,
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
    initialFiles?: string[],
    options?: { skipInitialProcessing?: boolean; isWordConnectorChat?: boolean }
  ) => {
    if (!user || !token || !selectedModel) return;
    setChatType(type);
    try {
      const response = await apiClient.createChat({
        title: initialContent ? initialContent.substring(0, 30) : "New Chat",
        model: selectedModel,
        isWordConnectorChat: options?.isWordConnectorChat || false,
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
                (imageGenerationPayload as any).fileId = initialFiles[0];
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
                  console.log('Computer Use session started:', result);
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
              await addMessage(initialContent, initialFiles, newChat);
              break;
          }
          await selectChat(newChat.id);
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
  }, [user, token, selectedModel, availableModels, setChatType, addMessage, handleNewChatWithPlaceholder, selectProvider, uploadedFiles]);

  const selectChat = useCallback(
    async (chatId: string) => {
      try {
        const response = await apiClient.getChat(chatId)
        const chat = response.chat
        setCurrentChat(chat)

        // Update the chats list to ensure consistency and add new chat if needed
        setChats((prev) => {
          // Check if chat already exists
          const existingIndex = prev.findIndex(c => c && c.id === chatId)
          if (existingIndex >= 0) {
            // Update existing chat
            return prev.filter(c => c && c.id).map((c) => c.id === chatId ? chat : c)
          } else {
            // Add new chat at the beginning
            return [chat, ...prev]
          }
        })

        // Store the current chat ID in localStorage
        localStorage.setItem('currentChatId', chatId)

        setUploadedFiles([]) // Clear uploaded files when switching chats
      } catch (error) {
        console.error("Failed to load chat:", error)
      } finally {

      }
    },
    [],
  )

  const clearCurrentChat = useCallback(async () => {
    if (!currentChat || !token) return

    try {
      await apiClient.clearChat(currentChat.id)

      const initialMessage: Message = {
        id: `msg-${Date.now()}`,
        chatId: currentChat.id,
        role: "ASSISTANT",
        content: `Hello! I'm ${availableModels.find(m => m.name === selectedModel)?.displayName || selectedModel}. How can I help you today?`,
        timestamp: new Date().toISOString(),
      }

      const clearedChat = {
        ...currentChat,
        title: "New Chat",
        messages: [initialMessage],
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
  }, [currentChat, token, selectedModel, availableModels])

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

    console.log('Regenerating message at index:', targetAiMessageIndex);
    console.log('Messages before regeneration:', messagesBeforeRegeneration.length);
    console.log('Messages to delete from backend:', messagesToDelete.length);
    console.log('Original total messages:', currentChat.messages.length);

    setIsLoading(true);

    // STEP 1: Delete messages from backend first
    try {
      console.log('Deleting messages from backend:', messagesToDelete.map(m => m.id));
      for (const msg of messagesToDelete) {
        if (msg.id && !msg.id.includes('temp-') && !msg.id.includes('ai-regen-')) {
          await apiClient.clearMessageById(msg.id);
          console.log('Deleted message from backend:', msg.id);
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
      console.log('Setting chat state with messages:', newState.messages.length);
      return newState;
    });

    const streamId = crypto.randomUUID();
    setCurrentStreamId(streamId);
    setIsStreaming(true);
    setPendingStop(false);

    // Create new AbortController for regeneration
    const controller = new AbortController();
    abortControllerRef.current = controller;

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

          // onData: Fill the placeholder
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const updatedMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: msg.content + chunk };
              }
              return msg;
            });
            console.log('Processing chunk, total messages:', updatedMessages.length);
            return { ...prevChat, messages: updatedMessages };
          });
        },
        async () => {
          // onClose: Stop loading only if not manually stopped
          if (!controller.signal.aborted && !pendingStop) {
            console.log('Regeneration completed successfully');
            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;

            // Save the updated chat state to ensure persistence
            try {
              console.log('Saving regenerated chat state to backend');
              // The backend streaming endpoint should have already saved the new message
              // Refresh immediately to ensure we have the latest state
              if (currentChat?.id) {
                const freshChat = await apiClient.getChat(currentChat.id);
                setCurrentChat(freshChat.chat);

                // Also update the chat in the chats list to keep sidebar in sync
                setChats(prevChats =>
                  prevChats.filter(chat => chat && chat.id).map(chat =>
                    chat.id === currentChat.id ? freshChat.chat : chat
                  )
                );

                console.log('Chat refreshed after regeneration, total messages:', freshChat.chat.messages.length);
              }
            } catch (error) {
              console.error('Failed to refresh chat after regeneration:', error);
            }
          }
        },
        (error: any) => {
          // onError: Handle error only if not manually stopped
          if (!controller.signal.aborted && !pendingStop) {
            console.error("Streaming failed during regeneration:", error);

            // Check for monthly API limit errors
            const errorMessage = error?.message || '';
            const status = error?.status || error?.statusCode;
            const errorData = error?.errorData;

            if (status === 429 ||
              isMonthlyLimitError(errorMessage) ||
              (errorData && isMonthlyLimitError(errorData.error || ''))) {

              console.log('Monthly limit error detected during regeneration');
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
                    return { ...msg, content: "", error: error.message || "An error occurred during regeneration." };
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
        controller.signal // Pass the abort signal
      );

    } catch (error) {
      console.error("Regeneration failed:", error);
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

          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const updatedMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: msg.content + chunk };
              }
              return msg;
            });
            return { ...prevChat, messages: updatedMessages };
          });
        },
        async () => {
          // Only complete if not manually stopped
          if (!controller.signal.aborted && !pendingStop) {
            setIsLoading(false);
            setIsStreaming(false);
            setCurrentStreamId(null);
            abortControllerRef.current = null;
            await selectChat(currentChat.id); // Refresh chat from DB
          }
        },
        (error: any) => {
          // Only handle error if not manually stopped
          if (!controller.signal.aborted && !pendingStop) {
            console.error("Streaming failed during regeneration:", error);

            // Check for monthly API limit errors
            const errorMessage = error?.message || '';
            const status = error?.status || error?.statusCode;
            const errorData = error?.errorData;

            if (status === 429 ||
              isMonthlyLimitError(errorMessage) ||
              (errorData && isMonthlyLimitError(errorData.error || ''))) {

              console.log('Monthly limit error detected during edit and regeneration');
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
                    return { ...msg, content: "", error: error.message || "An error occurred during regeneration." };
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
        controller.signal // Pass the abort signal
      );
    } catch (error) {
      console.error("Failed to edit and regenerate:", error);
      setIsLoading(false);
      setIsStreaming(false);
      setCurrentStreamId(null);
      abortControllerRef.current = null;
      // Revert UI state on failure
      setCurrentChat(prev => prev ? { ...prev, messages: currentChat.messages } : null);
      toast.error("Failed to regenerate response.");
    }
  }, [currentChat, isLoading, selectProvider, selectedModel, selectChat, setCurrentChat, setIsLoading, setIsStreaming, setCurrentStreamId]);

  const pollVideoStatus = useCallback((operationId: string, messageId: string) => {
    console.log('🔄 Starting polling for:', operationId);

    const interval = setInterval(async () => {
      try {
        const statusResponse = await apiClient.getVideoStatus(operationId);
        console.log('📊 Video status response:', statusResponse);

        // Normalize status casing
        const status = (statusResponse.status || '').toLowerCase();

        if (status === 'completed' || status === 'failed') {
          console.log(' Video processing finished:', status);
          clearInterval(interval);
          setPollingIntervals(prev => {
            const n = new Map(prev);
            n.delete(operationId);
            return n;
          });

          //  Force refresh chat from DB to get updated message with video file
          if (currentChat?.id) {
            console.log('🔄 Refreshing chat to show completed video');
            await selectChat(currentChat.id);
          }

          //  Also ensure loading state is turned off
          setIsLoading(false);

        } else {
          console.log(' Video still processing:', status);
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
          console.log(' Using image from uploadedFiles context:', imageUrl);
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

              console.log('🖼️ Got image URL from API call:', imageUrl);
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

      console.log('🎬 Calling generateVideo with:', {
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

      console.log(' Video generation response:', videoResponse);

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
      console.log('🎯 Starting polling for operation:', videoResponse.operationId, 'message:', messageId);
      pollVideoStatus(videoResponse.operationId, messageId);

    } catch (error) {
      console.error("❌ Failed to generate video:", error);
      throw error;
    } finally {
      setIsLoading(false);
      setUploadedFiles([]); // Clear uploaded files after processing
    }
  }, [currentChat, user, token, selectedModel, uploadedFiles, selectChat, pollVideoStatus]);

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

  const value: ChatContextType = {
    chats,
    currentChat,
    setCurrentChat,
    createNewChat,
    selectChat,
    addMessage,
    addVideoMessage,
    addThesisMessage,
    clearCurrentChat,
    deleteChat,
    selectedModel,
    setSelectedModel,
    selectProvider,
    setSelectedProivder,
    isLoading,
    availableModels,
    chatType,
    setChatType,
    uploadedFiles,
    setUploadedFiles,
    regenerateLastMessage,
    regenerateMessage,
    editAndRegenerate,
    updateMessageInChat,
    pollVideoStatus, isStreaming, pendingStop, stopStreaming,
    pagination,
    isLoadingMore,
    hasMoreChats,
    loadMoreChats,
    resetChats,
  }

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat() {
  const context = useContext(ChatContext)
  if (context === undefined) {
    throw new Error("useChat must be used within a ChatProvider")
  }
  return context
}
