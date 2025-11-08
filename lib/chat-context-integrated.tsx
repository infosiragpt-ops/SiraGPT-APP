"use client"

import type React from "react"
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react"
import { useAuth } from "./auth-context-integrated"
import { apiClient } from "./api"
import { aiService } from "./ai-service"
import { toast } from "sonner"

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
  createNewChat: (type?: 'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify', initialContent?: string, initialFiles?: string[]) => Promise<any>
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: string[], chat?: any, skipUserMessage?: boolean) => Promise<void>
  addVideoMessage: (prompt: string, fileIds?: string[]) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  selectProvider: string
  setSelectedProivder: (model: string) => void
  isLoading: boolean
  availableModels: any[]
  chatType: 'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify'
  uploadedFiles: any[]
  setChatType: React.Dispatch<React.SetStateAction<'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify'>>
  setUploadedFiles: (files: any[]) => void
  regenerateLastMessage: () => void
  editAndRegenerate: (messageId: string, newContent: string, files?: any[]) => void
  updateMessageInChat: (messageId: string, newContent: string) => void
  pollVideoStatus: (operationId: string, messageId: string) => void,

  isStreaming: boolean;
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
  const [chatType, setChatType] = useState<'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify'>('text')
  const [pollingIntervals, setPollingIntervals] = useState<Map<string, NodeJS.Timeout>>(new Map())
  const [pagination, setPagination] = useState<PaginationInfo | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMoreChats, setHasMoreChats] = useState(true)
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);



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

  const stopStreaming = useCallback(async () => {
    console.log("Working Stop Streaming", currentStreamId);

    if (currentStreamId) {
      console.log(`Frontend se stop signal bhej raha hoon: ${currentStreamId}`);
      try {
        await apiClient.stopAIStream(currentStreamId);


        // States ko foran reset karein takay UI update ho
        setIsStreaming(false);
        setIsLoading(false);
        setCurrentStreamId(null);
      } catch (error) {

        console.error("Failed to send stop signal:", error);
      }
    }
  }, [currentStreamId]);
  const addMessage = useCallback(
    async (content: string, fileIds?: string[], chat?: any, skipUserMessage?: boolean) => { // Added skipUserMessage parameter
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
        setChats((prev) => prev.map((c) => (c.id === activeChat.id ? updatedChat : c)));
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
      setIsStreaming(true);
      const streamId = crypto.randomUUID();
      setCurrentStreamId(streamId);
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

        } else {
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
              // onData: Jab bhi backend se naya text aaye
              // Hum state mein AI message ke content ko update karte rahenge
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
              setIsLoading(false);
              setIsStreaming(false);
              setCurrentStreamId(null);
              await selectChat(activeChat.id); // Refetch chat to get permanent IDs
            },
            (error) => {
              console.error("Streaming failed:", error);
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
            },

          );
        }
      } catch (error: any) {
        console.error("Failed to start AI stream:", error);
        setIsLoading(false);
        setIsStreaming(false);
        setCurrentStreamId(null);

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

  const createNewChat = useCallback(async (type: 'text' | 'image' | 'video' | 'webdev' | 'gmail' | 'google_services' | 'spotify' = 'text', initialContent?: string, initialFiles?: string[]) => {
    if (!user || !token || !selectedModel) return;
    setChatType(type);
    try {
      const response = await apiClient.createChat({
        title: initialContent ? initialContent.substring(0, 30) : "New Chat",
        model: selectedModel,
      });
      const newChat = response.chat;
      newChat.messages = [];

      setChats((prev) => [newChat, ...prev]);
      localStorage.setItem('currentChatId', newChat.id);
      setCurrentChat(newChat);
      setUploadedFiles([]);

      if (initialContent) {
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
    } catch (error) {
      console.error("Failed to create chat:", error);
    }
  }, [user, token, selectedModel, availableModels, setChatType, addMessage, handleNewChatWithPlaceholder]);

  const selectChat = useCallback(
    async (chatId: string) => {
      try {
        const response = await apiClient.getChat(chatId)
        const chat = response.chat
        setCurrentChat(chat)

        // Update the chats list to ensure consistency and add new chat if needed
        setChats((prev) => {
          // Check if chat already exists
          const existingIndex = prev.findIndex(c => c.id === chatId)
          if (existingIndex >= 0) {
            // Update existing chat
            return prev.map((c) => c.id === chatId ? chat : c)
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
      setChats((prev) => prev.map((chat) =>
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


  const regenerateLastMessage = async () => {
    if (!currentChat || isLoading) return;

    // Aakhri AI message aur usse pehle wala User message dhoondein
    let lastAiMessageIndex = -1;
    // let lastAu=
    for (let i = currentChat.messages.length - 1; i >= 0; i--) {
      if (currentChat.messages[i].role === 'ASSISTANT') {
        lastAiMessageIndex = i;
        break; // Jaise hi mil jaye, loop rok dein
      }
    }
    if (lastAiMessageIndex === -1) {
      //toast.info("No AI message to regenerate.");
      return;
    }

    const lastUserMessage = currentChat.messages[lastAiMessageIndex - 1];
    const lastAiMessage = currentChat.messages[lastAiMessageIndex];
    if (!lastUserMessage || lastUserMessage.role !== 'USER') {
      // toast.error("Could not find the original prompt.");
      return;
    }

    const originalUserMessage = currentChat.messages[lastAiMessageIndex - 1];
    if (!originalUserMessage || originalUserMessage.role !== 'USER') {
      return;
    }


    const messagesBeforeRegeneration = currentChat.messages.slice(0, lastAiMessageIndex);
    console.log('messagesBeforeRegeneration.content ', messagesBeforeRegeneration);

    setCurrentChat(prev => prev ? { ...prev, messages: messagesBeforeRegeneration } : null);
    setIsLoading(true);

    const aiMessagePlaceholder: Message = {
      id: `ai-regen-${Date.now()}`,
      chatId: currentChat.id,
      role: 'ASSISTANT',
      content: "",
      tokens: 0,
      timestamp: new Date().toISOString(),

      files: undefined,
    };

    // Ab yeh `setCurrentChat` error nahi dega
    setCurrentChat(prev => {
      if (!prev) return null;
      return {
        ...prev,
        messages: [...prev.messages, aiMessagePlaceholder]
      };
    });

    const streamId = crypto.randomUUID();
    setCurrentStreamId(streamId);
    try {
      // Step 4: Call your streaming function
      await apiClient.generateAIStream(
        {
          provider: selectProvider,
          model: selectedModel,
          prompt: originalUserMessage.content,
          chatId: currentChat.id,
          files: (originalUserMessage.files?.map((f: any) => f.id) as string[]) || [],
          streamId: streamId,
        },
        (chunk) => {
          // onData: Fill the placeholder
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
          // onClose: Stop loading
          setIsLoading(false);
          await selectChat(currentChat.id);
        },
        (error) => {
          // onError: Handle error
          console.error("Streaming failed during regeneration:", error);
          setIsLoading(false);
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
      );

      apiClient.clearMessageById(lastUserMessage.id);
      apiClient.clearMessageById(lastAiMessage.id);

    } catch (error) {
      setIsLoading(false);
    }


    const updateMessageInChat = (messageId: string, newContent: string) => {
      setCurrentChat(prevChat => {
        if (!prevChat) return null;

        const updatedMessages = prevChat.messages.map(msg => {
          if (msg.id === messageId) {
            return { ...msg, content: newContent };
          }
          return msg;
        });

        return { ...prevChat, messages: updatedMessages };
      });
    };
  };

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
    const streamId = crypto.randomUUID();
    setCurrentStreamId(streamId);

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
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);
          await selectChat(currentChat.id); // Refresh chat from DB
        },
        (error) => {
          console.error("Streaming failed during regeneration:", error);
          setIsLoading(false);
          setIsStreaming(false);
          setCurrentStreamId(null);
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
      );
    } catch (error) {
      console.error("Failed to edit and regenerate:", error);
      setIsLoading(false);
      setIsStreaming(false);
      setCurrentStreamId(null);
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
  // ...later...


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
    editAndRegenerate,
    updateMessageInChat,
    pollVideoStatus, isStreaming, stopStreaming,
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
