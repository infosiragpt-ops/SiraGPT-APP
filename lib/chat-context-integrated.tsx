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
  files?: any[]
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
  uploadedFiles: any[]
  setUploadedFiles: (files: any[]) => void
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth()
  const [chats, setChats] = useState<Chat[]>([])
  const [currentChat, setCurrentChat] = useState<Chat | null>(null)
  const [selectedModel, setSelectedModel] = useState("ChatGPT")
  const [isLoading, setIsLoading] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])

  // Load user's chats
  useEffect(() => {
    if (user && token) {
      loadUserChats()
    }
  }, [user, token])

  const loadUserChats = async () => {
    try {
      const response = await apiClient.getChats()
      setChats(response.chats)
    } catch (error) {
      console.error("Failed to load chats:", error)
    }
  }

  const createNewChat = useCallback(async () => {
    if (!user || !token) return

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
        content: `Hello! I'm ${selectedModel}. How can I help you today?`,
        timestamp: new Date().toISOString(),
      }

      newChat.messages = [initialMessage]
      
      setChats((prev) => [newChat, ...prev])
      setCurrentChat(newChat)
      setUploadedFiles([]) // Clear uploaded files for new chat
    } catch (error) {
      console.error("Failed to create chat:", error)
    }
  }, [user, token, selectedModel])

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

      try {
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

  const clearCurrentChat = useCallback(async () => {
    if (!currentChat || !token) return

    try {
      await apiClient.clearChat(currentChat.id)
      
      const initialMessage: Message = {
        id: `msg-${Date.now()}`,
        chatId: currentChat.id,
        role: "ASSISTANT",
        content: `Hello! I'm ${selectedModel}. How can I help you today?`,
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
  }, [currentChat, token, selectedModel])

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