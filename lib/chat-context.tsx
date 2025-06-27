"use client"

import type React from "react"
import { createContext, useContext, useState, useCallback, useEffect } from "react"
import { db, type Chat, type Message } from "./database"
import { useAuth } from "./auth-context"
import { aiService } from "./ai-service"

interface ChatContextType {
  chats: Chat[]
  currentChat: Chat | null
  createNewChat: () => void
  selectChat: (chatId: string) => void
  addMessage: (content: string) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  isLoading: boolean
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [chats, setChats] = useState<Chat[]>([])
  const [currentChat, setCurrentChat] = useState<Chat | null>(null)
  const [selectedModel, setSelectedModel] = useState("ChatGPT")
  const [isLoading, setIsLoading] = useState(false)

  // Load user's chats
  useEffect(() => {
    if (user) {
      loadUserChats()
    }
  }, [user])

  const loadUserChats = async () => {
    if (!user) return
    try {
      const userChats = await db.getChatsByUserId(user.id)
      setChats(userChats.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()))
    } catch (error) {
      console.error("Failed to load chats:", error)
    }
  }

  const createNewChat = useCallback(async () => {
    if (!user) return

    const newChat: Chat = {
      id: `chat-${Date.now()}`,
      userId: user.id,
      title: "New Chat",
      messages: [
        {
          id: `msg-${Date.now()}`,
          chatId: `chat-${Date.now()}`,
          role: "assistant",
          content: `Hello! I'm ${selectedModel}. How can I help you today?`,
          timestamp: new Date(),
        },
      ],
      model: selectedModel,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    try {
      const savedChat = await db.createChat(newChat)
      setChats((prev) => [savedChat, ...prev])
      setCurrentChat(savedChat)
    } catch (error) {
      console.error("Failed to create chat:", error)
    }
  }, [user, selectedModel])

  const selectChat = useCallback(
    (chatId: string) => {
      const chat = chats.find((c) => c.id === chatId)
      if (chat) {
        setCurrentChat(chat)
      }
    },
    [chats],
  )

  const addMessage = useCallback(
    async (content: string) => {
      if (!currentChat || !user) return

      setIsLoading(true)

      // Add user message
      const userMessage: Message = {
        id: `msg-${Date.now()}`,
        chatId: currentChat.id,
        role: "user",
        content,
        timestamp: new Date(),
      }

      const updatedMessages = [...currentChat.messages, userMessage]
      const updatedChat = {
        ...currentChat,
        messages: updatedMessages,
        title:
          currentChat.title === "New Chat"
            ? content.slice(0, 50) + (content.length > 50 ? "..." : "")
            : currentChat.title,
        updatedAt: new Date(),
      }

      setCurrentChat(updatedChat)
      setChats((prev) => prev.map((chat) => (chat.id === currentChat.id ? updatedChat : chat)))

      try {
        // Generate AI response
        const aiResponse = await aiService.generateResponse(selectedModel, selectedModel.toLowerCase(), content)

        const assistantMessage: Message = {
          id: `msg-${Date.now() + 1}`,
          chatId: currentChat.id,
          role: "assistant",
          content: aiResponse,
          timestamp: new Date(),
        }

        const finalMessages = [...updatedMessages, assistantMessage]
        const finalChat = {
          ...updatedChat,
          messages: finalMessages,
          updatedAt: new Date(),
        }

        setCurrentChat(finalChat)
        setChats((prev) => prev.map((chat) => (chat.id === currentChat.id ? finalChat : chat)))

        // Save to database
        await db.updateChat(currentChat.id, finalChat)

        // Track API usage
        await db.createApiUsage({
          userId: user.id,
          model: selectedModel,
          tokens: content.length + aiResponse.length,
          cost: 0.001 * (content.length + aiResponse.length),
          timestamp: new Date(),
        })
      } catch (error) {
        console.error("Failed to generate AI response:", error)
      } finally {
        setIsLoading(false)
      }
    },
    [currentChat, user, selectedModel],
  )

  const clearCurrentChat = useCallback(async () => {
    if (!currentChat) return

    const clearedChat = {
      ...currentChat,
      messages: [
        {
          id: `msg-${Date.now()}`,
          chatId: currentChat.id,
          role: "assistant" as const,
          content: `Hello! I'm ${selectedModel}. How can I help you today?`,
          timestamp: new Date(),
        },
      ],
      updatedAt: new Date(),
    }

    setCurrentChat(clearedChat)
    setChats((prev) => prev.map((chat) => (chat.id === currentChat.id ? clearedChat : chat)))

    try {
      await db.updateChat(currentChat.id, clearedChat)
    } catch (error) {
      console.error("Failed to clear chat:", error)
    }
  }, [currentChat, selectedModel])

  const deleteChat = useCallback(
    async (chatId: string) => {
      try {
        await db.deleteChat(chatId)
        setChats((prev) => prev.filter((chat) => chat.id !== chatId))
        if (currentChat?.id === chatId) {
          setCurrentChat(null)
        }
      } catch (error) {
        console.error("Failed to delete chat:", error)
      }
    },
    [currentChat],
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
