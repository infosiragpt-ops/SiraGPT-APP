"use client"

import type React from "react"
import { createContext, useContext, useState, useCallback, useEffect } from "react"
import { useAuth } from "./auth-context-new"

interface Message {
  id: string
  chatId: string
  role: "USER" | "ASSISTANT"
  content: string
  tokens?: number
  timestamp: string
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
  addMessage: (content: string) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  isLoading: boolean
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth()
  const [chats, setChats] = useState<Chat[]>([])
  const [currentChat, setCurrentChat] = useState<Chat | null>(null)
  const [selectedModel, setSelectedModel] = useState("ChatGPT")
  const [isLoading, setIsLoading] = useState(false)

  // Load user's chats
  useEffect(() => {
    if (user && token) {
      loadUserChats()
    }
  }, [user, token])

  const loadUserChats = async () => {
    try {
      const response = await fetch('/api/chats', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        setChats(data.chats)
      }
    } catch (error) {
      console.error("Failed to load chats:", error)
    }
  }

  const createNewChat = useCallback(async () => {
    if (!user || !token) return

    try {
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "New Chat",
          model: selectedModel,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        const newChat = data.chat
        
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
      }
    } catch (error) {
      console.error("Failed to create chat:", error)
    }
  }, [user, token, selectedModel])

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
      if (!currentChat || !user || !token) return

      setIsLoading(true)

      try {
        // Generate AI response
        const response = await fetch('/api/ai/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            model: selectedModel,
            prompt: content,
            chatId: currentChat.id,
          }),
        })

        if (response.ok) {
          const data = await response.json()
          
          // Reload the chat to get updated messages
          const chatResponse = await fetch(`/api/chats/${currentChat.id}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          })

          if (chatResponse.ok) {
            const chatData = await chatResponse.json()
            const updatedChat = chatData.chat
            
            setCurrentChat(updatedChat)
            setChats((prev) => prev.map((chat) => 
              chat.id === currentChat.id ? updatedChat : chat
            ))
          }
        }
      } catch (error) {
        console.error("Failed to generate AI response:", error)
      } finally {
        setIsLoading(false)
      }
    },
    [currentChat, user, token, selectedModel],
  )

  const clearCurrentChat = useCallback(async () => {
    if (!currentChat || !token) return

    try {
      // Delete all messages and reset chat
      const response = await fetch(`/api/chats/${currentChat.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "New Chat",
        }),
      })

      if (response.ok) {
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
      }
    } catch (error) {
      console.error("Failed to clear chat:", error)
    }
  }, [currentChat, token, selectedModel])

  const deleteChat = useCallback(
    async (chatId: string) => {
      if (!token) return

      try {
        const response = await fetch(`/api/chats/${chatId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        })

        if (response.ok) {
          setChats((prev) => prev.filter((chat) => chat.id !== chatId))
          if (currentChat?.id === chatId) {
            setCurrentChat(null)
          }
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