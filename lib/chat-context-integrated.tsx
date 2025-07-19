"use client"

import type React from "react"
import { createContext, useContext, useState, useCallback, useEffect } from "react"
import { useAuth } from "./auth-context-integrated"
import { apiClient } from "./api"

interface Message {
  id: string
  chatId: string
  role: "USER" | "ASSISTANT"
  content: string
  tokens?: number
  timestamp: string
  files?: any[],
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

interface ChatContextType {
  chats: Chat[]
  currentChat: Chat | null
  createNewChat: () => void
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: string[]) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  isLoading: boolean
  availableModels: any[]

  uploadedFiles: any[]
  setUploadedFiles: (files: any[]) => void
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth()
  const [chats, setChats] = useState<Chat[]>([])
  const [currentChat, setCurrentChat] = useState<Chat | null>(null)
  const [selectedModel, setSelectedModel] = useState("")
  const [availableModels, setAvailableModels] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])
  const [hasInitialized, setHasInitialized] = useState(false)

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
      const modelsResponse = await apiClient.getAIModels()
      setAvailableModels(modelsResponse.models)

      // Set default model
      if (modelsResponse.models.length > 0 && !selectedModel) {
        setSelectedModel(modelsResponse.models[0].name)
      }

      // Load chats
      await loadUserChats()
      setHasInitialized(true)
    } catch (error) {
      console.error("Failed to initialize chat:", error)
    }
  }
  const loadUserChats = async () => {
    try {
      const response = await apiClient.getChats()
      setChats(response.chats)
    } catch (error) {
      console.error("Failed to load chats:", error)
    }
  }

  const createNewChat = useCallback(async () => {
    if (!user || !token || !selectedModel) return

    try {
      const response = await apiClient.createChat({
        title: "New Chat",
        model: selectedModel,
      })

      const newChat = response.chat

      // Add initial assistant message
      const initialMessage: Message = {
        id: `msg-${Date.now()}`,
        chatId: newChat.id,
        role: "ASSISTANT",
        content: `Hello! I'm ${availableModels.find(m => m.name === selectedModel)?.displayName || selectedModel}. How can I help you today?`,
        timestamp: new Date().toISOString(),
      }

      newChat.messages = [initialMessage]

      setChats((prev) => [newChat, ...prev])
      setCurrentChat(newChat)
      setUploadedFiles([]) // Clear uploaded files for new chat
    } catch (error) {
      console.error("Failed to create chat:", error)
    }
  }, [user, token, selectedModel, availableModels])

  const selectChat = useCallback(
    async (chatId: string) => {
      try {
        const response = await apiClient.getChat(chatId)
        setCurrentChat(response.chat)
        setUploadedFiles([]) // Clear uploaded files when switching chats
      } catch (error) {
        console.error("Failed to load chat:", error)
      }
    },
    [],
  )

  const addMessage = useCallback(
    async (content: string, fileIds?: string[]) => {
      if (!currentChat || !user || !token) return

      setIsLoading(true)
      console.log("addMessage working");

      try {
        const userMessage: Message = {
          id: `msg-${Date.now()}`,
          chatId: currentChat.id,
          role: "USER",
          content,
          timestamp: new Date().toDateString(),
        };

        {
          const updatedMessages = [...currentChat.messages, userMessage]
          const updatedChat = {
            ...currentChat,
            messages: updatedMessages,
            title: '',
            updatedAt: new Date().toDateString(),
          }

          setCurrentChat(updatedChat)

          setChats((prev) => prev.map((chat) => (chat.id === currentChat.id ? updatedChat : chat)))
        }
        // Generate AI response with file context
        const response = await apiClient.generateAI({
          model: selectedModel,
          prompt: content,
          chatId: currentChat.id,
          files: fileIds || uploadedFiles.map(f => f.id),
        })

        // Reload the chat to get updated messages
        const chatResponse = await apiClient.getChat(currentChat.id)
        const updatedChat = chatResponse.chat

        setCurrentChat(updatedChat)
        setChats((prev) => prev.map((chat) =>
          chat.id === currentChat.id ? updatedChat : chat
        ))

        // Clear uploaded files after sending message
        setUploadedFiles([])
      } catch (error) {
        console.error("Failed to generate AI response:", error)
      } finally {
        setIsLoading(false)
      }
    },
    [currentChat, user, token, selectedModel, uploadedFiles],
  )

  // const addMessage = useCallback(
  //   async (content: string, fileIds?: string[]) => {
  //     // 1. Shuruaati checks
  //     console.log('log working');

  //     if (!currentChat || !user || !token || !content.trim()) return;

  //     setIsLoading(true);
  //     const chatId = currentChat.id;

  //     // 2. User ka naya message object banayein (for Optimistic UI)
  //     // Isse user ka message turant screen par dikh jaata hai.
  //     const userMessage: Message = {
  //       id: `user-msg-${Date.now()}`,
  //       role: 'USER',
  //       content: content,
  //       timestamp: new Date().toISOString(),
  //       chatId: chatId,
  //       // tokens: 0, // Agar Message type mein hai to add karein
  //     };

  //     // 3. UI ko turant update karein
  //     setCurrentChat((prevChat) => ({
  //       ...prevChat!,
  //       messages: [...prevChat!.messages, userMessage],
  //     }));

  //     // 4. API ke liye poori chat history taiyar karein
  //     // Yahi sabse zaroori hissa hai context ke liye.
  //     const apiMessages = [...currentChat.messages, userMessage].map(msg => ({
  //       role: msg.role === 'USER' ? 'user' : 'assistant',
  //       content: msg.content,
  //     }));

  //     try {
  //       // 5. Backend ko EK hi API call karein, lekin is baar poori history ke saath
  //       // Hum ab 'prompt' nahi, balki 'messages' array bhejenge.
  //       const aiResponse = await apiClient.generateAI({
  //         model: selectedModel,
  //         chatId: chatId,
  //         messages: apiMessages, // <-- BADLAV #1: 'prompt' ke bajaye 'messages'
  //         files: fileIds || uploadedFiles.map(f => f.id),
  //       });

  //       // 6. AI ka jawab object banayein
  //       // Man lete hain ki `generateAI` ab AI ka message return karta hai
  //       const aiMessage: Message = {
  //         id: aiResponse.messageId || `ai-msg-${Date.now()}`,
  //         role: 'ASSISTANT',
  //         content: aiResponse.content,
  //         tokens: aiResponse.tokens,
  //         timestamp: new Date().toISOString(),
  //         chatId: chatId,
  //       };

  //       // 7. Final state ko update karein. DOBARA FETCH KARNE KI ZAROORAT NAHI.
  //       // BADLAV #2: apiClient.getChat() ko hata diya gaya hai.
  //       setCurrentChat((prevChat) => ({
  //         ...prevChat!,
  //         messages: [...prevChat!.messages, aiMessage],
  //       }));

  //       setChats((prev) =>
  //         prev.map((chat) => (chat.id === chatId ? { ...chat, messages: [...chat.messages, aiMessage] } : chat))
  //       );

  //       setUploadedFiles([]);

  //     } catch (error) {
  //       console.error("Failed to generate AI response:", error);
  //       setCurrentChat((prevChat) => ({
  //         ...prevChat!,
  //         messages: prevChat!.messages.filter(msg => msg.id !== userMessage.id),
  //       }));
  //     } finally {
  //       setIsLoading(false);
  //     }
  //   },
  //   [currentChat, user, token, selectedModel, uploadedFiles, setCurrentChat, setChats, setUploadedFiles],
  // );
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

  return (
    <ChatContext.Provider
      value={{
        chats,
        currentChat,
        createNewChat,
        selectChat,
        addMessage,
        clearCurrentChat,
        deleteChat,
        selectedModel,
        setSelectedModel,
        isLoading,
        uploadedFiles,
        setUploadedFiles,
        availableModels,
      }}
    >
      {children}
    </ChatContext.Provider>
  )
}

export function useChat() {
  const context = useContext(ChatContext)
  if (context === undefined) {
    throw new Error("useChat must be used within a ChatProvider")
  }
  return context
}