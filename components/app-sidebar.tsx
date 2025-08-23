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
  ChevronDown,
  PanelLeft,
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
  SidebarTrigger,
  useSidebar,
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
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { useRouter } from "next/navigation"

import { cn } from "@/lib/utils"

// Generation Types with enhanced functionality
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
    available: false,
    badge: "Soon",
  },
  {
    name: "Audio Generation",
    icon: Mic,
    description: "Generate speech and music",
    available: false,
    badge: "Soon",
  },
  {
    name: "Video Generation",
    icon: Video,
    description: "Create videos with AI",
    available: false,
    badge: "Soon",
  },
]

export function AppSidebar() {
  const { user, logout } = useAuth()
  const { chats, currentChat, createNewChat, selectChat, deleteChat, selectedModel, setSelectedModel } = useChat()
  const router = useRouter()
  const [selectedType, setSelectedType] = React.useState("Text Chat")
  const { state, toggleSidebar } = useSidebar()
  const handleLogout = () => {
    localStorage.setItem('currentChatId', "")


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
    } else {
      alert(`${typeName} is not available yet. Coming soon!`)
    }
  }

  const formatChatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60))

    if (diffInHours < 1) return "Just now"
    if (diffInHours < 24) return `${diffInHours}h ago`
    if (diffInHours < 48) return "Yesterday"
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  return (
    <Sidebar className="border-r border-border/40 w-64" collapsible="icon">
      <SidebarHeader className={cn("border-b border-border/40 transition-all", state === 'open' ? 'p-4' : 'p-2')}>
        {/* Jab sidebar open ho to yeh layout dikhega */}
        <div className={cn("flex items-center justify-between", state === 'closed' && 'hidden')}>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Bot className="h-4 w-4 text-primary-foreground" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">OpenWebUI</span>
              <span className="text-xs text-muted-foreground">AI Platform</span>
            </div>
          </div>
          <SidebarTrigger />
        </div>

        {/* Jab sidebar close ho to sirf yeh logo dikhega (hover effect ke saath) */}
        <div className={cn("relative", state === 'open' && 'hidden')}>
          <div className="group flex h-8 w-8 items-center justify-center rounded-lg bg-primary cursor-pointer" onClick={toggleSidebar}>
            <Bot className="h-4 w-4 text-primary-foreground transition-opacity group-hover:opacity-0" />
            <PanelLeft className="h-4 w-4 text-primary-foreground absolute opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
      </SidebarHeader>




      <div className={cn("transition-all", state === 'open' ? 'p-4 pt-2' : 'p-2', "mt-4")}>
        <SidebarMenuButton onClick={() => createNewChat()} className="w-full justify-start h-9 px-3" variant="outline">
          <Plus className="h-4 w-4" />
          {/* Yeh text bhi sirf open state mein dikhega */}
          <span className="group-data-[state=closed]:hidden ml-2">New Chat</span>
        </SidebarMenuButton>
      </div>

      <SidebarContent className="px-2">


        <SidebarSeparator />

        {/* Recent Chats - Only show for Text Chat */}
        {selectedType === "Text Chat" && (
          <SidebarGroup>
            <SidebarGroupLabel className={cn("px-3 py-4 text-center text-sm text-muted-foreground", state === 'closed' && 'hidden')}>
              Recent Chats
            </SidebarGroupLabel>
            <SidebarGroupContent className={cn(state === 'closed' && 'hidden')}>
              <SidebarMenu>
                {chats.length === 0 ? (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                    No chats yet. Start a new conversation!
                  </div>
                ) : (
                  chats.slice(0, 10).map((chat) => (
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
                <SidebarMenuButton className="w-full justify-start h-auto py-3">
                  <Avatar className={state === 'closed' && 'hidden' ? "h-6 w-6" : "h-9 w-9"}>
                    <AvatarImage src={user?.avatar || "/placeholder.svg"} />
                    <AvatarFallback>
                      {user?.name
                        ?.split(" ")
                        .map((n) => n[0])
                        .join("") || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className={cn("flex flex-col items-start min-w-0 flex-1 ml-2", state === 'closed' && 'hidden')}>
                    <span className="text-sm font-medium truncate">{user?.name || "Admin User"}</span>
                    <span className="text-xs text-muted-foreground">{user?.plan || "Enterprise Plan"}</span>
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
