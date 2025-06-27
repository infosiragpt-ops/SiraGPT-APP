"use client"

import * as React from "react"
import {
  Bot,
  MessageSquare,
  Plus,
  Settings,
  User,
  LogOut,
  Crown,
  CreditCard,
  History,
  Sparkles,
  ImageIcon,
  Mic,
  Video,
  Trash2,
  MoreHorizontal,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/lib/auth-context"
import { useChat } from "@/lib/chat-context"
import { useRouter } from "next/navigation"

// LLM Models
const llmModels = [
  {
    name: "ChatGPT",
    icon: Bot,
    description: "GPT-4 & GPT-3.5",
  },
  {
    name: "Claude",
    icon: Sparkles,
    description: "Anthropic AI",
  },
  {
    name: "Grok",
    icon: Bot,
    description: "xAI Model",
  },
  {
    name: "DeepSeek",
    icon: Bot,
    description: "DeepSeek AI",
  },
  {
    name: "Gemini",
    icon: Sparkles,
    description: "Google AI",
  },
]

// Generation Types - Now functional
const generationTypes = [
  {
    name: "Text Chat",
    icon: MessageSquare,
    description: "Chat with AI models",
    available: true,
  },
  {
    name: "Image Generation",
    icon: ImageIcon,
    description: "Generate images with DALL-E",
    available: false, // Will be implemented later
  },
  {
    name: "Audio Generation",
    icon: Mic,
    description: "Generate speech and music",
    available: false, // Will be implemented later
  },
  {
    name: "Video Generation",
    icon: Video,
    description: "Create videos with AI",
    available: false, // Will be implemented later
  },
]

export function AppSidebar() {
  const { user, logout } = useAuth()
  const { chats, currentChat, createNewChat, selectChat, deleteChat, selectedModel, setSelectedModel } = useChat()
  const router = useRouter()
  const [selectedType, setSelectedType] = React.useState("Text Chat")

  const handleLogout = () => {
    logout()
    router.push("/auth/login")
  }

  const handleNewChat = () => {
    createNewChat()
  }

  const handleTypeChange = (typeName: string) => {
    const type = generationTypes.find((t) => t.name === typeName)
    if (type?.available) {
      setSelectedType(typeName)
      // Here you would implement different interfaces for each type
      if (typeName !== "Text Chat") {
        // For now, show coming soon message
        alert(`${typeName} is coming soon! Currently only Text Chat is available.`)
        return
      }
    } else {
      alert(`${typeName} is not available yet. Coming soon!`)
    }
  }

  const formatChatTime = (date: Date) => {
    const now = new Date()
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60))

    if (diffInHours < 1) return "Just now"
    if (diffInHours < 24) return `${diffInHours}h ago`
    if (diffInHours < 48) return "Yesterday"
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  return (
    <Sidebar className="border-r border-border/40">
      <SidebarHeader className="border-b border-border/40 p-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Bot className="h-4 w-4 text-primary-foreground" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">OpenWebUI</span>
            <span className="text-xs text-muted-foreground">AI Platform</span>
          </div>
        </div>

        <Button onClick={handleNewChat} className="mt-3 w-full justify-start h-9 px-3" variant="outline">
          <Plus className="mr-2 h-4 w-4" />
          New Chat
        </Button>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {/* LLM Models */}
        <SidebarGroup>
          <SidebarGroupLabel>AI Models</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {llmModels.map((model) => (
                <SidebarMenuItem key={model.name}>
                  <SidebarMenuButton
                    isActive={selectedModel === model.name}
                    onClick={() => setSelectedModel(model.name)}
                    className="w-full justify-start h-auto py-2"
                  >
                    <model.icon className="mr-2 h-4 w-4 flex-shrink-0" />
                    <div className="flex flex-col items-start min-w-0">
                      <span className="text-sm font-medium">{model.name}</span>
                      <span className="text-xs text-muted-foreground truncate">{model.description}</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Generation Types - Now with functionality */}
        <SidebarGroup>
          <SidebarGroupLabel>Generation Types</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {generationTypes.map((type) => (
                <SidebarMenuItem key={type.name}>
                  <SidebarMenuButton
                    isActive={selectedType === type.name}
                    onClick={() => handleTypeChange(type.name)}
                    className="h-auto py-2"
                    disabled={!type.available}
                  >
                    <type.icon className="mr-2 h-4 w-4 flex-shrink-0" />
                    <div className="flex flex-col items-start min-w-0 flex-1">
                      <div className="flex items-center gap-2 w-full">
                        <span className="text-sm font-medium">{type.name}</span>
                        {!type.available && (
                          <Badge variant="outline" className="text-xs">
                            Soon
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground truncate">{type.description}</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Recent Chats - Only show for Text Chat */}
        {selectedType === "Text Chat" && (
          <SidebarGroup>
            <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {chats.length === 0 ? (
                  <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                    No chats yet. Start a new conversation!
                  </div>
                ) : (
                  chats.map((chat) => (
                    <SidebarMenuItem key={chat.id}>
                      <div className="flex items-center w-full group">
                        <SidebarMenuButton
                          isActive={currentChat?.id === chat.id}
                          onClick={() => selectChat(chat.id)}
                          className="flex-1 justify-start h-auto py-2 pr-8"
                        >
                          <History className="mr-2 h-4 w-4 flex-shrink-0" />
                          <div className="flex flex-col items-start min-w-0 flex-1">
                            <span className="text-sm truncate w-full">{chat.title}</span>
                            <span className="text-xs text-muted-foreground">{formatChatTime(chat.updatedAt)}</span>
                          </div>
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 absolute right-2"
                            >
                              <MoreHorizontal className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => deleteChat(chat.id)} className="text-red-600">
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </SidebarMenuItem>
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-border/40 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="w-full justify-start h-auto py-2">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={user?.avatar || "/placeholder.svg"} />
                    <AvatarFallback>
                      {user?.name
                        ?.split(" ")
                        .map((n) => n[0])
                        .join("") || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="text-sm font-medium truncate">{user?.name || "User"}</span>
                    <span className="text-xs text-muted-foreground">{user?.plan || "Free"} Plan</span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" className="w-56">
                <DropdownMenuItem onClick={() => router.push("/profile")}>
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Crown className="mr-2 h-4 w-4" />
                  Upgrade to Pro
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <CreditCard className="mr-2 h-4 w-4" />
                  Billing
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </DropdownMenuItem>
                {user?.isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => router.push("/admin")}>
                      <Settings className="mr-2 h-4 w-4" />
                      Admin Panel
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600" onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
