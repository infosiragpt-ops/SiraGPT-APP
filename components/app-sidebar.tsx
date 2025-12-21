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
  Search,
  Library,
  Images,
  LayoutGrid,
  Loader2,
  PenSquare,
  Shield,
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
import { useRouter, usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import Link from "next/link"
import UpgradeModal from "./UpgradeModal"
import { ChatSearchDialog } from "./ChatSearchDialog"
// import NotificationCenter from "./notification-center" // Commented out to stop repeated API calls

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
  const {
    chats,
    currentChat,
    createNewChat,
    setCurrentChat,
    selectChat,
    deleteChat,
    selectedModel,
    setSelectedModel,
    loadMoreChats,
    hasMoreChats,
    isLoadingMore,
    pagination
  } = useChat()
  const router = useRouter()
  const pathname = usePathname()
  const [selectedType, setSelectedType] = React.useState("Text Chat")
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar()
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)

  // Scroll area ref for infinite scroll
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)

  const handleLogout = () => {
    localStorage.setItem("currentChatId", "")
    logout()
    router.push("/")
  }

  const handleNewChat = () => {
    setCurrentChat(null);
    localStorage.removeItem('currentChatId');
    // Navigate to chat if not already there
    if (!pathname.startsWith('/chat')) {
      router.push('/chat')
    }
    if (isMobile) {
      setTimeout(() => {
        setOpenMobile(false);
      }, 500);
    }
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
    const diffInHours = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60 * 60)
    )

    if (diffInHours < 1) return "Just now"
    if (diffInHours < 24) return `${diffInHours}h ago`
    if (diffInHours < 48) return "Yesterday"
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  const isAnon = !user
  const isFreeUser = user?.plan?.toLowerCase() === "free"
  
  // Show upgrade button for free users OR users approaching their monthly limit (70% or more)
  const currentUsage = user?.apiUsage || 0
  const monthlyLimit = user?.monthlyLimit || 0
  const usagePercentage = monthlyLimit > 0 ? (currentUsage / monthlyLimit) * 100 : 0
  const shouldShowUpgrade = isFreeUser || usagePercentage >= 70

  const handleUpgradeClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setUpgradeOpen(true)
  }

  const handleGPTsClick = () => {
    router.push("/gpts")
  }

  const handleLibraryClick = () => {
    router.push("/library")
  }

  const handleChatClick = (chatId: string) => {
    selectChat(chatId)
    // Navigate to chat page if not already there
    if (!pathname.startsWith('/chat')) {
      router.push(`/chat?id=${chatId}`)
    }
    if (isMobile) {
      setTimeout(() => {
        setOpenMobile(false);
      }, 500);
    }
  }

  const handleSearchClick = () => {
    setSearchOpen(true)
  }

  // Handle load more chats
  const handleLoadMore = () => {
    if (hasMoreChats && !isLoadingMore && loadMoreChats) {
      loadMoreChats()
    }
  }

  // Infinite scroll handler
  const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    const bottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50 // 50px threshold

    if (bottom && hasMoreChats && !isLoadingMore && loadMoreChats) {
      loadMoreChats()
    }
  }, [hasMoreChats, isLoadingMore, loadMoreChats])

  // Check if we're on GPTs page
  const isOnGPTsPage = pathname.startsWith('/gpts')

  return (
    <Sidebar className="border-r border-border/40 w-64" collapsible="icon">
      <SidebarHeader
        className={cn(
          "border-b border-border/40 transition-all",
          state === "open" ? "p-4" : "p-2"
        )}
      >
        {/* Jab sidebar open ho to yeh layout dikhega */}
        <div
          className={cn(
            "flex items-center justify-between",
            state === "closed" && "hidden"
          )}
        >
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg  ">

              <img
                src="/sira-gpt.png"
                alt="Icon"
                className="h-10 w-10  brightness-0 dark:brightness-0 dark:invert"
              />

            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">Sira GPT</span>
              <span className="text-xs text-muted-foreground">AI Platform</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* <NotificationCenter /> */} {/* Commented out to stop repeated API calls */}
            <SidebarTrigger />
          </div>
        </div>
        {/* Jab sidebar close ho to sirf yeh logo dikhega (hover effect ke saath) */}
        <div className={cn("relative", state === "open" && "hidden")}>
          <div
            className="group flex h-8 w-8 items-center justify-center rounded-lg bg-primary cursor-pointer"
            onClick={toggleSidebar}
          >
            <Bot className="h-4 w-4 text-primary-foreground transition-opacity group-hover:opacity-0" />
            <PanelLeft className="h-4 w-4 text-primary-foreground absolute opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
      </SidebarHeader>

      {/* New Chat, Search, and Library buttons */}
      <div
        className={cn(
          "transition-all flex flex-col ",
          state === "open" ? "p-4 pt-2 pl-2" : "p-2"
        )}
      >
        <SidebarMenuButton
          onClick={handleNewChat}
          className="w-full justify-start h-9 px-3"

        >
          <PenSquare className="h-4 w-4" />
          <span className="group-data-[state=closed]:hidden -ml-0.2">New Chat</span>
        </SidebarMenuButton>

        <SidebarMenuButton
          onClick={handleSearchClick}
          className="w-full justify-start h-9 px-3 hover:bg-accent hover:text-accent-foreground transition-colors"
          variant="default"
        >
          <Search className="h-4 w-4" />
          <span className="group-data-[state=closed]:hidden -ml-0.2">Search chats</span>
        </SidebarMenuButton>

        <SidebarMenuButton
          onClick={handleLibraryClick}
          className="w-full justify-start h-9 px-3"
          variant="default"
        >
          <Images className="h-4 w-4" />
          <span className="group-data-[state=closed]:hidden -ml-0.2">Library</span>
        </SidebarMenuButton>

        <SidebarMenuButton
          onClick={handleGPTsClick}
          className={cn(
            "w-full justify-start h-9 px-3 hover:bg-accent hover:text-accent-foreground transition-colors",
            isOnGPTsPage && "bg-accent text-accent-foreground"
          )}
          variant="default"
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="group-data-[state=closed]:hidden -ml-0.2">GPTs</span>
        </SidebarMenuButton>
      </div>

      <SidebarContent
        className="px-2 overflow-y-auto custom-scrollbar flex-1"
        ref={scrollAreaRef}
        onScroll={handleScroll}
      >
        <SidebarSeparator />

        {/* Recent Chats - Only show for Text Chat */}
        {selectedType === "Text Chat" && (
          <SidebarGroup>
            <SidebarGroupLabel
              className={cn(
                "px-3 py-4 text-center text-sm text-muted-foreground",
                state === "closed" && "hidden"
              )}
            >
              Recent Chats
            </SidebarGroupLabel>
            <SidebarGroupContent
              className={cn(state === "closed" && "hidden")}
            >
              <SidebarMenu>
                {chats.length === 0 ? (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                    No chats yet. Start a new conversation!
                  </div>
                ) : (
                  <>
                    {chats.filter(chat => chat && chat.id).map((chat) => (
                      <SidebarMenuItem key={chat.id}>
                        <div className="flex items-center w-full group">
                          <SidebarMenuButton
                            isActive={currentChat?.id === chat.id && pathname.startsWith('/chat')}
                            onClick={() => handleChatClick(chat.id)}
                            className="flex-1 justify-start h-auto py-2 pr-8"
                          >
                            <History className="mr-2 h-4 w-4 flex-shrink-0" />
                            <div className="flex flex-col items-start min-w-0 flex-1">
                              <span className="text-sm truncate w-full">
                                {chat.title}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {formatChatTime(chat.updatedAt)}
                              </span>
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
                              <DropdownMenuItem
                                onClick={() => deleteChat(chat.id)}
                                className="text-red-600"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </SidebarMenuItem>
                    ))}

                    {/* Loading indicator at the bottom */}
                    {isLoadingMore && (
                      <SidebarMenuItem>
                        <div className="flex items-center justify-center py-3">
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          <span className="text-xs text-muted-foreground">Loading more chats...</span>
                        </div>
                      </SidebarMenuItem>
                    )}

                    {/* Load more button (manual trigger) */}
                    {hasMoreChats && !isLoadingMore && chats.length >= 20 && (
                      <SidebarMenuItem>
                        <Button
                          variant="ghost"
                          onClick={handleLoadMore}
                          className="w-full justify-center text-xs text-muted-foreground py-2 h-8 hover:bg-accent hover:text-accent-foreground"
                        >
                          <ChevronDown className="h-3 w-3 mr-1" />
                          Load more chats
                        </Button>
                      </SidebarMenuItem>
                    )}

                    {/* End of chats indicator */}
                    {!hasMoreChats && !isLoadingMore && chats.length >= 20 && (
                      <SidebarMenuItem>
                        <div className="text-center py-2 text-xs text-muted-foreground opacity-50">
                          All chats loaded
                        </div>
                      </SidebarMenuItem>
                    )}
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-border/40 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center w-full">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton className="flex-1 justify-start h-auto py-3">
                    <Avatar
                      className={
                        state === "closed" && "hidden" ? "h-6 w-6" : "h-9 w-9"
                      }
                    >
                      <AvatarImage src={user?.avatar || "/placeholder.svg"} />
                      <AvatarFallback>
                        {user?.name
                          ?.split(" ")
                          .map((n) => n[0])
                          .join("") || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className={cn(
                        "flex flex-col items-start min-w-0 flex-1 ml-2",
                        state === "closed" && "hidden"
                      )}
                    >
                      <span className="text-sm font-medium truncate">
                        {user?.name || "Admin User"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {user?.isSuperAdmin ? "Super Administrator" : user?.isAdmin ? "Administrator" : user?.plan || "Free Plan"}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" className="w-56">
                  <DropdownMenuItem onClick={() => router.push("/profile")}>
                    <User className="mr-2 h-4 w-4" />
                    Profile
                  </DropdownMenuItem>

                  <DropdownMenuItem onClick={() => router.push("/billing")}>
                    <CreditCard className="mr-2 h-4 w-4" />
                    Billing
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => router.push("/settings")}>
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => router.push("/privacy-policy")}>
                    <Shield className="mr-2 h-4 w-4" />
                    Privacy Policy
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
                  {user?.isSuperAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => router.push("/super-admin")}>
                        <Shield className="mr-2 h-4 w-4 text-red-600" />
                        <span className="text-red-600">Super Admin Panel</span>
                      </DropdownMenuItem>
                    </>
                  )}
                  {/* Hidden return option for super admin accessing other accounts */}
                  {typeof window !== "undefined" && localStorage.getItem('superadmin-return-data') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={async () => {
                          const returnData = localStorage.getItem('superadmin-return-data')
                          if (returnData) {
                            const { originalToken } = JSON.parse(returnData)
                            if (originalToken) {
                              localStorage.setItem('auth-token', originalToken)
                              localStorage.removeItem('superadmin-return-data')
                              window.location.href = '/super-admin'
                            }
                          }
                        }}
                        className="text-orange-600"
                      >
                        <Shield className="mr-2 h-4 w-4" />
                        Return to Super Admin
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600"
                    onClick={handleLogout}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Upgrade button for FREE users or users approaching limit - only visible when sidebar is open */}
              {shouldShowUpgrade && state === "open" && (
                <Button
                  onClick={handleUpgradeClick}
                  size="sm"
                  variant={usagePercentage >= 90 ? "destructive" : "outline"}
                  className={`ml-2 h-7 px-2 text-xs ${
                    usagePercentage >= 90 
                      ? "" 
                      : "border-primary text-primary hover:bg-primary hover:text-primary-foreground"
                  }`}
                >
                  <Crown className="h-3 w-3 mr-1" />
                  {usagePercentage >= 90 ? 'Upgrade Now' : 'Upgrade'}
                </Button>
              )}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* Shared Upgrade modal */}
      <UpgradeModal
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        user={user}
      />

      {/* Chat Search Dialog */}
      <ChatSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
      />
    </Sidebar>
  )
}
