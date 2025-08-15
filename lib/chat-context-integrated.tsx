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
  // createNewChat: () => void
  createNewChat: (type?: 'text' | 'image', initialContent?: string) => void
  selectChat: (chatId: string) => void
  addMessage: (content: string, files?: string[]) => Promise<void>
  clearCurrentChat: () => void
  deleteChat: (chatId: string) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  isLoading: boolean
  availableModels: any[]
  chatType: 'text' | 'image';
  uploadedFiles: any[]
  setChatType: React.Dispatch<React.SetStateAction<'text' | 'image'>>;
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
  const [chatType, setChatType] = useState<'text' | 'image'>('text');
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

  const addMessage = useCallback(
    async (content: string, fileIds?: string[], chat?: any) => { // Added optional 'chat' parameter
      const activeChat = chat || currentChat; // Use provided chat or fallback to currentChat
      if (!activeChat || !user || !token) return;

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

      try {
        // STEP 3: Nayi streaming API call karein
        await apiClient.generateAIStream(
          {
            model: selectedModel,
            prompt: content,
            chatId: activeChat.id,
            files: fileIds || [],
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
            // Yahan hum chat list (sidebar) ko bhi update kar sakte hain
            // Taake poora message save ho jaye
            // if (currentChat) {
            //   // We can trigger a final state update to ensure everything is synced
            //   selectChat(currentChat.id)
            // }
          },
          (error) => {
            // onError: Agar koi error aaye
            console.error("Streaming failed:", error);
            setIsLoading(false);
            // UI mein error message dikhayein
            setCurrentChat((prevChat) => {
              if (!prevChat) return prevChat;
              const newMessages = prevChat.messages.map((msg) => {
                if (msg.id === aiMessagePlaceholder.id) {
                  return { ...msg, content: "Sorry, an error occurred. Please try again." };
                }
                return msg;
              });
              return { ...prevChat, messages: newMessages };
            });
          }
        );
      } catch (error) {
        console.error("Failed to start AI stream:", error);
        setIsLoading(false);
      }

    },
    [currentChat, user, token, selectedModel, uploadedFiles]
  );
  const createNewChat = useCallback(async (type: 'text' | 'image' = 'text', initialContent?: string) => {
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

      // if (initialContent) {
      //   // Add user's initial message
      //   const initialMessage: Message = {
      //     id: `msg-${Date.now()}`,
      //     chatId: newChat.id,
      //     role: "USER",
      //     content: initialContent,
      //     timestamp: new Date().toISOString(),
      //   };
      //   messages = [initialMessage];
      // }
      // If no initialContent, keep messages empty to avoid default message

      newChat.messages = messages;

      setChats((prev) => [newChat, ...prev]);
      localStorage.setItem('currentChatId', newChat.id);
      setCurrentChat(newChat);
      setUploadedFiles([]); // Clear uploaded files for new chat

      // If initialContent is provided, immediately call addMessage to get AI response
      if (initialContent) {
        await addMessage(initialContent, [], newChat); // Pass newChat as the third parameter
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

  // const addMessage = useCallback(
  //   async (content: string, fileIds?: string[]) => {
  //     if (!currentChat || !user || !token) return

  //     setIsLoading(true)

  //     try {
  //       const userMessage: Message = {
  //         id: `msg-${Date.now()}`,
  //         chatId: currentChat.id,
  //         role: "USER",
  //         content,
  //         timestamp: new Date().toDateString(),
  //         files: fileIds && fileIds.length > 0 ? fileIds : undefined,
  //       };

  //       {
  //         const updatedMessages = [...currentChat.messages, userMessage]
  //         const updatedChat = {
  //           ...currentChat,
  //           messages: updatedMessages,
  //           title: '',
  //           updatedAt: new Date().toDateString(),
  //         }

  //         setCurrentChat(updatedChat)

  //         setChats((prev) => prev.map((chat) => (chat.id === currentChat.id ? updatedChat : chat)))
  //       }
  //       // Generate AI response with file context
  //       const response = await apiClient.generateAI({
  //         model: selectedModel,
  //         prompt: content,
  //         chatId: currentChat.id,
  //         files: fileIds || [],
  //       })

  //       // Reload the chat to get updated messages including the AI response
  //       const chatResponse = await apiClient.getChat(currentChat.id)
  //       const updatedChat = chatResponse.chat

  //       setCurrentChat(updatedChat)
  //       setChats((prev) => prev.map((chat) =>
  //         chat.id === currentChat.id ? updatedChat : chat
  //       ))

  //       // Clear uploaded files after sending message
  //       setUploadedFiles([])
  //     } catch (error) {
  //       console.error("Failed to generate AI response:", error)
  //       // On error, reload the chat to ensure we have the latest state
  //       try {
  //         const chatResponse = await apiClient.getChat(currentChat.id)
  //         const updatedChat = chatResponse.chat
  //         setCurrentChat(updatedChat)
  //         setChats((prev) => prev.map((chat) =>
  //           chat.id === currentChat.id ? updatedChat : chat
  //         ))
  //       } catch (reloadError) {
  //         console.error("Failed to reload chat after error:", reloadError)
  //       }
  //     } finally {
  //       setIsLoading(false)
  //     }
  //   },
  //   [currentChat, user, token, selectedModel],
  // )
  // ✅ YEH SAHI STREAMING WALA addMessage FUNCTION HAI


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
        chatType,
        setChatType,
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