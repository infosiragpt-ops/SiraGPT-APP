"use client"

import type React from "react"
import { createContext, useContext, useState, useCallback, useEffect } from "react"
import { useAuth } from "./auth-context-integrated"
import { apiClient } from "./api"
import { useRouter } from "next/navigation";
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
}

interface Chat {
  id: string
  userId: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}
interface AnonState {
  isAnon: boolean;
  anonRemaining: number | null;
  anonLimit: number | null;
  anonBlocked: boolean;
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
  pollVideoStatus: (operationId: string, messageId: string) => void
  isAnon: boolean;
  anonRemaining: number | null;
  anonLimit: number | null;
  anonBlocked: boolean;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

// Add helper to generate ephemeral chat
function makeEphemeralChat(model: string): Chat {
  const now = new Date().toISOString();
  return {
    id: `ephemeral-${Date.now()}`,
    userId: 'anon',
    title: 'Guest Chat',
    model,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}
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
  const router = useRouter();
  const [anonState, setAnonState] = useState<AnonState>({
    isAnon: false,
    anonRemaining: null,
    anonLimit: null,
    anonBlocked: false
  });

  const ANON_LS_KEY = 'anon_quota_cache'; 
  // Load user's chats
  // REMOVE the old effect that only ran initializeChat() when (user && token)

useEffect(() => {
  if (hasInitialized) return;

  const init = async () => {
    try {
      const modelsResponse = await apiClient.getAIModels();
      setAvailableModels(modelsResponse.models);

      if (modelsResponse.models.length > 0) {
        setSelectedModel(prev => prev || modelsResponse.models[0].name);
        setSelectedProivder(prev => prev || modelsResponse.models[0].provider);
      }

      if (user && token) {
        await loadUserChats();
        setAnonState(s => ({ ...s, isAnon: false }));
      } else {
        setAnonState(s => ({ ...s, isAnon: true }));
// Inside init() after setting isAnon true
if (!user) {
  try {
    const data = await apiClient.getAnonQuota();
    if (data.isAnon) {
      setAnonState(s => ({
        ...s,
        isAnon: true,
        anonRemaining: data.remaining,
        anonLimit: data.limit,
        anonBlocked: false
      }));
      localStorage.setItem(ANON_LS_KEY, JSON.stringify({
        remaining: data.remaining,
        limit: data.limit,
        timestamp: Date.now()
      }));
    }
  } catch (e) {
    console.warn('Anon quota fetch failed', e);
  }
}
      }
      setHasInitialized(true);
    } catch (e) {
      console.error("Init failed:", e);
    }
  };

  init();
}, [user, token, hasInitialized]);

  // If user logs in after anonymous usage, load chats once
  useEffect(() => {
    if (user && token && hasInitialized && anonState.isAnon) {
      (async () => {
        try {
          await loadUserChats();
          setAnonState(s => ({ ...s, isAnon: false }));
        } catch (e) {
          console.error("Post-login chat load failed:", e);
        }
      })();
    }
  }, [user, token, hasInitialized, anonState.isAnon]);
  const loadUserChats = async () => {
    try {
      const response = await apiClient.getChats()
      setChats(response.chats)
    } catch (error) {
      console.error("Failed to load chats:", error)
    }
  }

   const addMessage = useCallback(
    async (content: string, fileIds?: string[]) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      // Auto-select a model if not yet set but models loaded
      if (!selectedModel) {
        if (availableModels.length > 0) {
          const first = availableModels[0];
            setSelectedModel(first.name);
            setSelectedProivder(first.provider);
        } else {
          toast.error('Models still loading. Please wait a moment.');
          return;
        }
      }

      let activeChat = currentChat;
      if (!activeChat) {
        activeChat = makeEphemeralChat(selectedModel);
        setCurrentChat(activeChat);
        setChats(prev => [activeChat!, ...prev]);
      }

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        chatId: activeChat.id,
        role: 'USER',
        content: trimmed,
        timestamp: new Date().toISOString(),
        files: fileIds?.length ? fileIds : undefined
      };

      const assistantPlaceholder: Message = {
        id: `ai-${Date.now()}`,
        chatId: activeChat.id,
        role: 'ASSISTANT',
        content: '',
        timestamp: new Date().toISOString()
      };

      const updated = {
        ...activeChat,
        messages: [...activeChat.messages, userMessage, assistantPlaceholder],
        updatedAt: new Date().toISOString()
      };
      setCurrentChat(updated);
      setChats(prev => prev.map(c => (c.id === updated.id ? updated : c)));
      setUploadedFiles([]);
      setIsLoading(true);

      try {
        await apiClient.generateAIStream(
          {
            provider: selectProvider || 'OpenAI',
            model: selectedModel,
            prompt: trimmed,
            chatId: user ? activeChat.id : undefined,
            files: user ? (fileIds || []) : undefined
          },
          (chunk) => {
            setCurrentChat(prev => {
              if (!prev) return prev;
              const msgs = prev.messages.map(m =>
                m.id === assistantPlaceholder.id
                  ? { ...m, content: m.content + chunk }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          },
          async () => {
            setIsLoading(false);
               if (!user) {
      // Soft refresh of quota after stream to ensure final server value
      try {
        const data = await apiClient.getAnonQuota();
        if (data.isAnon) {
          setAnonState(s => {
            if (s.anonRemaining === data.remaining && s.anonLimit === data.limit) return s;
            return {
          ...s,
            isAnon: true,
            anonRemaining: data.remaining,
            anonLimit: data.limit,
            anonBlocked: s.anonBlocked // preserve existing (only flips true on error)
        };
          });
        }
      } catch (e) {
        // Ignore silent fetch failure
      }
    }
          },
          (error) => {
            setIsLoading(false);
            if ((error as any).code === 'ANON_LIMIT_REACHED') {
              setAnonState(s => ({ ...s, anonBlocked: true, anonRemaining: 0 }));
              toast.error('Free trial limit reached. Login to continue.');
            } else {
              toast.error(error.message || 'Streaming error');
            }
            setCurrentChat(prev => {
              if (!prev) return prev;
              const msgs = prev.messages.map(m =>
                m.id === assistantPlaceholder.id
                  ? { ...m, content: m.content || 'Error occurred.' }
                  : m
              );
              return { ...prev, messages: msgs };
            });
          }
        );
      } catch (err: any) {
        setIsLoading(false);
        toast.error(err.message || 'Failed to start stream');
      }
    },
    [currentChat, user, selectedModel, selectProvider, availableModels,uploadedFiles]
  );
    const createNewChat = useCallback(
    async (type: 'text' | 'image' | 'video' = 'text', initialContent?: string) => {
      setChatType(type);

      if (!user) {
        if (!selectedModel) {
          if (availableModels.length > 0) {
            const first = availableModels[0];
            setSelectedModel(first.name);
            setSelectedProivder(first.provider);
          } else {
            toast.error('Models still loading.');
            return;
          }
        }
        const eph = makeEphemeralChat(selectedModel || availableModels[0]?.name);
        setChats(prev => [eph, ...prev]);
        setCurrentChat(eph);
        if (initialContent) {
          await addMessage(initialContent, []);
        }
        return;
      }

      if (!token || !selectedModel) return;
      try {
        const response = await apiClient.createChat({
          title: initialContent ? initialContent.substring(0, 30) : 'New Chat',
          model: selectedModel
        });
        const newChat = { ...response.chat, messages: [] as Message[] };
        setChats(prev => [newChat, ...prev]);
        localStorage.setItem('currentChatId', newChat.id);
        setCurrentChat(newChat);
        setUploadedFiles([]);
        if (initialContent) {
          await addMessage(initialContent, []);
        }
      } catch (e) {
        console.error('Failed to create chat:', e);
      }
    },
    [user, token, selectedModel, availableModels,setChatType, addMessage]
  );

  const selectChat = useCallback(
    async (chatId: string) => {


      try {
        const response = await apiClient.getChat(chatId)
        const chat = response.chat
        setCurrentChat(chat)

        // Update the chats list to ensure consistency
        setChats((prev) => prev.map((c) =>
          c.id === chatId ? chat : c
        ))

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


    try {
      // Step 4: Call your streaming function
      await apiClient.generateAIStream(
        {
          provider: selectProvider,

          model: selectedModel,
          prompt: originalUserMessage.content,
          chatId: currentChat.id,
          files: (originalUserMessage.files?.map((f: any) => f.id) as string[]) || [],
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



    await apiClient.generateAIStream(
      {
        provider: selectProvider,

        model: selectedModel,
        prompt: newContent,
        chatId: currentChat.id,
        files: [],
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
    pollVideoStatus,
    isAnon: anonState.isAnon,
    anonRemaining: anonState.anonRemaining,
    anonLimit: anonState.anonLimit,
    anonBlocked: anonState.anonBlocked,
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