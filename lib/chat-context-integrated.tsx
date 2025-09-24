"use client"

import type React from "react"
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react"
import { useAuth } from "./auth-context-integrated"
import { apiClient } from "./api"

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
  createNewChat: (type?: 'text' | 'image' | 'video', initialContent?: string) => void
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: string[]) => Promise<void>
  addVideoMessage: (prompt: string) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  selectProvider: string
  setSelectedProivder: (model: string) => void
  isLoading: boolean
  availableModels: any[]
  chatType: 'text' | 'image' | 'video'
  uploadedFiles: any[]
  setChatType: React.Dispatch<React.SetStateAction<'text' | 'image' | 'video'>>
  setUploadedFiles: (files: any[]) => void
  regenerateLastMessage: () => void
  editAndRegenerate: (messageId: string, newContent: string) => void
  updateMessageInChat: (messageId: string, newContent: string) => void
  pollVideoStatus: (operationId: string, messageId: string) => void,

  isStreaming: boolean; // ✅ Naya state add karein
  stopStreaming: () => void; // ✅ Naya function add karein
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
  const [chatType, setChatType] = useState<'text' | 'image' | 'video'>('text')
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
    async (content: string, fileIds?: string[], chat?: any) => { // Added optional 'chat' parameter
      const activeChat = chat || currentChat; // Use provided chat or fallback to currentChat
      if (!activeChat || !user || !token) return;

      // if (abortControllerRef.current) {
      //   abortControllerRef.current.abort();
      //   // Optional: previous stream ke message ko update karein agar zaroori ho
      // }
      // const controller = new AbortController();
      // abortControllerRef.current = controller;

      // STEP 1: User ka message foran UI mein dikhayein
      const userMessage: Message = {
        id: `msg-user-${Date.now()}`,
        chatId: activeChat.id,
        role: 'USER',
        content,
        timestamp: new Date().toISOString(), // Use ISOString for consistency
        files: fileIds?.length ? fileIds : undefined,
      };

      // STEP 2: AI ke jawab ke liye ek khaali placeholder banayein
      // Isse UI mein "AI is typing..." jaisa effect aayega
      const aiMessagePlaceholder: Message = {
        id: `msg-ai-${Date.now()}`,
        chatId: activeChat.id,
        role: 'ASSISTANT',
        content: '', // Shuru mein content khaali hoga
        timestamp: new Date().toISOString(),
      };

      // Foran UI ko user ke message aur AI ke placeholder ke saath update karein
      const updatedMessages = [...activeChat.messages, userMessage, aiMessagePlaceholder];
      const updatedChat = { ...activeChat, messages: updatedMessages };

      setCurrentChat(updatedChat);
      setChats((prev) => prev.map((c) => (c.id === activeChat.id ? updatedChat : c)));
      setUploadedFiles([]); // Uploaded files clear kar dein
      setIsLoading(true); // Loading state start karein
      setIsStreaming(true);
      const streamId = crypto.randomUUID();
      setCurrentStreamId(streamId);
      try {
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
          () => {
            // onClose: Jab stream khatam ho jaye
            setIsLoading(false);
            setIsStreaming(false); // ✅ Streaming khatam ho gayi
            // abortControllerRef.current = null; // AbortController ko reset karein
            setCurrentStreamId(null);
          },
          (error) => {
            console.error("Streaming failed:", error);
            setIsLoading(false);
            setIsStreaming(false); // ✅ Streaming error ke saath khatam
            setCurrentStreamId(null);
            abortControllerRef.current = null; // AbortController ko reset karein
            // if (error.name !== 'AbortError') { // Agar AbortError nahi hai, toh hi toast dikhayein
            //   setCurrentChat((prevChat) => {
            //     if (!prevChat) return prevChat;
            //     const newMessages = prevChat.messages.map((msg) => {
            //       if (msg.id === aiMessagePlaceholder.id) {
            //         return { ...msg, content: "Sorry, an error occurred. Please try again." };
            //       }
            //       return msg;
            //     });
            //     return { ...prevChat, messages: newMessages };
            //   });
            // }
          },

        );
      } catch (error) {
        console.error("Failed to start AI stream:", error);
        setIsLoading(false);
        setIsStreaming(false); // ✅ Streaming error ke saath khatam
        setCurrentStreamId(null);
        // abortControllerRef.current = null; // AbortController ko reset karein
      }

    },
    [currentChat, user, token, selectedModel, uploadedFiles]
  );
  const createNewChat = useCallback(async (type: 'text' | 'image' | 'video' = 'text', initialContent?: string) => {
    if (!user || !token || !selectedModel) return;
    setChatType(type);
    try {
      const response = await apiClient.createChat({
        title: initialContent ? initialContent.substring(0, 30) : "New Chat", // Use first 30 chars of initialContent as title
        model: selectedModel,
      });
      const newChat = response.chat;

      // Initialize messages array
      let messages: Message[] = [];


      newChat.messages = messages;

      setChats((prev) => [newChat, ...prev]);
      localStorage.setItem('currentChatId', newChat.id);
      setCurrentChat(newChat);
      setUploadedFiles([]); // Clear uploaded files for new chat

      // If initialContent is provided, immediately call addMessage to get AI response
            if (initialContent) {
        if (type === 'image') {
          // For image generation, call the image API directly
          try {
            const response = await apiClient.generateImage({
              prompt: initialContent,
              chatId: newChat.id,
              provider: selectProvider,
              model: selectedModel
            });
            // Refresh the chat to get the updated messages
            await selectChat(newChat.id);
          } catch (error) {
            console.error('Image generation failed during chat creation:', error);
            throw error;
          }
        } else if (type === 'video') {
          // For video generation, call addVideoMessage
          await addVideoMessage(initialContent);
        } else {
          // For text, use regular addMessage
          await addMessage(initialContent, [], newChat); // Pass newChat as the third parameter
        }
            return newChat;
      }
    } catch (error) {
      console.error("Failed to create chat:", error);
    }
  }, [user, token, selectedModel, availableModels, setChatType, addMessage]);

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
        () => {
          // onClose: Stop loading
          setIsLoading(false);
        },
        (error) => {
          // onError: Handle error
          console.error("Streaming failed during regeneration:", error);
          setIsLoading(false);
          setCurrentChat((prevChat) => {
            if (!prevChat) return prevChat;
            const errorMessages = prevChat.messages.map((msg) => {
              if (msg.id === aiMessagePlaceholder.id) {
                return { ...msg, content: "Sorry, an error occurred during regeneration." };
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

  const editAndRegenerate = async (messageId: string, newContent: string) => {
    if (!currentChat || isLoading) return;

    // Step 1: Message dhoondein jisko edit kiya gaya
    const messageIndex = currentChat.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      // toast.error("Original message not found in chat.");
      return;
    }

    // const messagesUpToEdit = currentChat.messages.slice(0, messageIndex + 1);

    // messagesUpToEdit[messageIndex].content = newContent;
    const updatedMessages = currentChat.messages
      .slice(0, messageIndex + 1)
      .map((msg, index) => {
        if (index === messageIndex) {

          return { ...msg, content: newContent };
        }
        // 4. Baaki messages ko waise hi rehne dein
        return msg;
      });

    setCurrentChat(prev => prev ? { ...prev, messages: updatedMessages } : null);
    setIsLoading(true);

    try {
      await apiClient.editUserMessage(messageId, { content: newContent });
    } catch (error) {
      //toast.error("Could not save the edited message.");
      // Error ki soorat mein UI ko wapas purani state par le aayein (optional)
      setIsLoading(false);
      return;
    }

    // Step 4: Ab naye (edited) prompt se AI stream shuru karein
    // Yeh code bilkul 'addMessage' jaisa hai, bas user ka message dobara add nahi karta
    const aiMessagePlaceholder: Message = {
      id: `ai-regen-${Date.now()}`,
      chatId: currentChat.id,
      role: 'ASSISTANT',
      content: "",
      tokens: 0,
      timestamp: new Date().toISOString(),

      files: undefined,
    };
    setCurrentChat(prev => prev ? { ...prev, messages: [...prev.messages, aiMessagePlaceholder] } : null);

    const streamId = crypto.randomUUID();
    setCurrentStreamId(streamId);

    await apiClient.generateAIStream(
      {
        provider: selectProvider,

        model: selectedModel,
        prompt: newContent,
        chatId: currentChat.id,
        files: [],
        streamId: streamId
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
      () => {
        // onClose: Stop loading
        setIsLoading(false);
      },
      (error) => {
        // onError: Handle error
        console.error("Streaming failed during regeneration:", error);
        setIsLoading(false);
        setCurrentChat((prevChat) => {
          if (!prevChat) return prevChat;
          const errorMessages = prevChat.messages.map((msg) => {
            if (msg.id === aiMessagePlaceholder.id) {
              return { ...msg, content: "Sorry, an error occurred during regeneration." };
            }
            return msg;
          });
          return { ...prevChat, messages: errorMessages };
        });
      }
    );
    apiClient.clearMessageById(messageId);

  };

  // const addVideoMessage = useCallback(async (prompt: string) => {
  //   if (!currentChat || !user) return

  //   setIsLoading(true)
  //   try {
  //     // Add user message
  //     const userMessageResponse = await apiClient.addMessage(currentChat.id, {
  //       role: 'USER',
  //       content: prompt
  //     })

  //     // Generate video
  //     const videoResponse = await apiClient.generateVideo({
  //       prompt,
  //       aspect_ratio: '16:9'
  //     })

  //     // Add assistant message with video operation data
  //     const assistantMessageResponse = await apiClient.addMessage(currentChat.id, {
  //       role: 'ASSISTANT',
  //       content: `Generating video: "${prompt}"...`,
  //       videoData: {
  //         operationId: videoResponse.operationId,
  //         status: 'processing',
  //         filename: videoResponse.filename,
  //         prompt
  //       }
  //     })

  //     // Start polling for video status
  //     pollVideoStatus(videoResponse.operationId, assistantMessageResponse.message.id)

  //     // Refresh current chat
  //     await selectChat(currentChat.id)
  //   } catch (error) {
  //     console.error("Failed to generate video:", error)
  //   } finally {
  //     setIsLoading(false)
  //   }
  // }, [currentChat, user])
  // Replace the addVideoMessage function with this corrected version:

  // ...existing imports and code...
  const pollVideoStatus = useCallback((operationId: string, messageId: string) => {
    const interval = setInterval(async () => {
      try {
        const statusResponse = await apiClient.getVideoStatus(operationId);

        // Normalize status casing
        const status = (statusResponse.status || '').toLowerCase();

        if (status === 'completed' || status === 'failed') {
          clearInterval(interval);
          setPollingIntervals(prev => {
            const n = new Map(prev);
            n.delete(operationId);
            return n;
          });

          // Refresh chat from DB so the assistant message has updated files/filename
          if (currentChat?.id) {
            await selectChat(currentChat.id);
          }

        } else {
          // Optional: show "processing" in UI by updating that one message
          setCurrentChat(prev => {
            if (!prev) return prev;
            const updated = prev.messages.map(m => {
              if (m.id !== messageId) return m;
              // no DB changes yet; keep content but mark a client-side hint if you want
              return m;
            });
            return { ...prev, messages: updated };
          });
        }
      } catch (error) {
        console.error('Error polling video status:', error);
        clearInterval(interval);
        setPollingIntervals(prev => {
          const n = new Map(prev);
          n.delete(operationId);
          return n;
        });
      }
    }, 10000);

    setPollingIntervals(prev => {
      const n = new Map(prev);
      n.set(operationId, interval);
      return n;
    });
  }, [currentChat?.id, selectChat, setCurrentChat]);
  const addVideoMessage = useCallback(async (prompt: string) => {
    if (!currentChat || !user) return;

    setIsLoading(true);
    try {
      // 1) Save user's message
      await apiClient.addMessage(currentChat.id, {
        role: 'USER',
        content: prompt
      });

      // 2) Kick off video generation
      const videoResponse = await apiClient.generateVideo({
        prompt,
        aspect_ratio: '16:9',
        chatId: currentChat.id
      });

      // 3) Reload chat so we get the assistant placeholder saved by backend
      await selectChat(currentChat.id);

      // 4) Find the assistant message with this operationId inside files JSON
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

      // Use the latest currentChat from state
      let targetMessage = findAssistantByOperation(currentChat, videoResponse.operationId);
      if (!targetMessage) {
        // state race: fetch directly and search
        const fresh = await apiClient.getChat(currentChat.id);
        targetMessage = findAssistantByOperation(fresh.chat, videoResponse.operationId);
        if (fresh?.chat) setCurrentChat(fresh.chat);
      }

      // 5) Start polling using the actual assistant message id if found
      const messageId = targetMessage?.id || videoResponse.operationId; // fallback
      pollVideoStatus(videoResponse.operationId, messageId);
    } catch (error) {
      console.error("❌ Failed to generate video:", error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [currentChat, user, selectChat, setCurrentChat, pollVideoStatus]);

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
    resetChats
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