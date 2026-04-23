"use client"
import * as React from "react"
import { useTranslations } from "next-intl"
import { useBackgroundStreams } from "@/lib/background-streams-context"
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
  FolderKanban,
  Palette,
  Loader2,
  PenSquare,
  Shield,

  Edit2,
  Check,
  X,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { useRouter, usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import Link from "next/link"
import UpgradeModal from "./UpgradeModal"
import { ChatSearchDialog } from "./ChatSearchDialog"
import { apiClient } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
// import NotificationCenter from "./notification-center" // Commented out to stop repeated API calls

// Shared liquid-glass styles for the user menu dropdown. Keeping them
// as module constants avoids allocating a new string on every render
// and lets both normal and destructive variants compose via cn().
const LG_ITEM = cn(
  "relative isolate cursor-pointer rounded-xl px-2.5 py-2 text-sm font-medium",
  "text-foreground/85 transition-all duration-200",
  "focus:bg-white/70 focus:text-foreground focus:backdrop-blur-md",
  "data-[highlighted]:bg-white/70 data-[highlighted]:text-foreground data-[highlighted]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6)]",
  "dark:focus:bg-white/10 dark:data-[highlighted]:bg-white/10",
  "dark:data-[highlighted]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]",
)
const LG_SEP = "my-1 bg-white/30 dark:bg-white/10"

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
  const t = useTranslations("sidebar")
  const bgStreams = useBackgroundStreams()
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
  // NB: pathname is declared here (not further down like the original)
  // because the navigation helpers below depend on it. The later
  // `const pathname = usePathname()` line is intentionally removed as
  // part of the same change.
  const pathname = usePathname()

  // ────────────────────────────────────────────────────────────
  // Perceived-latency fixes for sidebar navigation.
  //
  // Problem: clicking "GPTs" (or any other nav item that fires
  // router.push synchronously) felt sluggish because Next needs to
  // fetch the route's JS + RSC payload before the new page paints.
  // Fix is 3-layer:
  //   1. On mount, prefetch every top-level destination. By the time
  //      the user clicks, the payload is already warm in memory.
  //   2. onMouseEnter additionally prefetches (covers hot-reloaded
  //      routes + lets React be opportunistic about data fetches
  //      kicked off by the target's server components).
  //   3. router.push runs inside React.startTransition so the click
  //      feels instant visually: `isPending` flips true immediately
  //      and the pressed-state styling (lower opacity + spinner dot)
  //      renders in the same frame.
  // ────────────────────────────────────────────────────────────
  const SIDEBAR_ROUTES = React.useMemo(
    () => [
      '/chat', '/gpts', '/projects', '/design', '/library',
      '/billing', '/settings', '/profile',
    ],
    [],
  )
  React.useEffect(() => {
    // Fire-and-forget. Next.js dedupes internally, so repeated
    // prefetches from re-mounts are cheap.
    for (const p of SIDEBAR_ROUTES) {
      try { router.prefetch(p) } catch { /* ignore */ }
    }
  }, [router, SIDEBAR_ROUTES])

  const [selectedType, setSelectedType] = React.useState("Text Chat")
  const { state, toggleSidebar, isMobile, setOpen, setOpenMobile } = useSidebar()
  const [navPending, startNavTransition] = React.useTransition()
  const [pendingHref, setPendingHref] = React.useState<string | null>(null)
  const navigate = React.useCallback((href: string) => {
    // Collapse the sidebar immediately so the destination page opens
    // with the cleanest possible workspace.
    if (isMobile) setOpenMobile(false)
    else setOpen(false)

    // If we're already on the route, don't push again. The explicit
    // collapse above is still intentional and should be preserved.
    if (pathname === href || pathname.startsWith(href + '/')) return
    setPendingHref(href)
    startNavTransition(() => { router.push(href) })
  }, [isMobile, pathname, router, setOpen, setOpenMobile])
  // Clear the pending marker once navigation settled. pathname is
  // the trigger: it changes the frame after router.push resolves.
  React.useEffect(() => {
    if (!navPending && pendingHref && (pathname === pendingHref || pathname.startsWith(pendingHref + '/'))) {
      setPendingHref(null)
    }
  }, [navPending, pendingHref, pathname])
  const prefetchOnHover = React.useCallback((href: string) => {
    try { router.prefetch(href) } catch { /* ignore */ }
  }, [router])
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [editingChatId, setEditingChatId] = React.useState<string | null>(null)
  const [editTitle, setEditTitle] = React.useState("")
  const [optimisticUpdates, setOptimisticUpdates] = React.useState<Record<string, string>>({})

  // Scroll area ref for infinite scroll
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const editInputRef = React.useRef<HTMLInputElement>(null)

  const handleLogout = () => {
    localStorage.setItem("currentChatId", "")
    logout()
    router.push("/")
  }

  const handleNewChat = () => {
    setCurrentChat(null);
    localStorage.removeItem('currentChatId');

    // Dispatch custom event to reset all connector and tool states
    window.dispatchEvent(new CustomEvent('resetChatState'));

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
    const diffInMinutes = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60)
    )

    if (diffInMinutes < 1) return t("justNow")
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`
    const diffInHours = Math.floor(diffInMinutes / 60)
    if (diffInHours < 24) return `${diffInHours}h ago`
    if (diffInHours < 48) return t("yesterday")
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  /**
   * Compact inline timestamp for the new single-line chat item — no
   * trailing "ago", no double digits cramming against the row edge.
   * Older-than-7-days renders as a localised short date (e.g. "14 mar")
   * so the timestamp stays readable without taking a full line.
   */
  const formatChatTimeCompact = (dateString: string) => {
    const date = new Date(dateString)
    const diffInMinutes = Math.floor((Date.now() - date.getTime()) / 60000)
    if (diffInMinutes < 1) return ""
    if (diffInMinutes < 60) return `${diffInMinutes}m`
    const hours = Math.floor(diffInMinutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
  }

  /**
   * Partition chats into time buckets for the ChatGPT/Claude-style
   * date groupings rendered in the sidebar. Buckets returned in render
   * order; empty buckets are filtered out at the call site so we don't
   * render an empty "Today" header when there are no chats today.
   *
   * Day boundaries use the local timezone via new Date() — timestamps
   * stored in UTC still bucket correctly because both sides of the
   * subtraction are converted consistently.
   */
  const groupChatsByTime = (items: Array<{ id: string; updatedAt: string } & Record<string, any>>) => {
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const today = new Date()
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const startOfYesterday = startOfToday - DAY
    const weekAgo = now - 7 * DAY

    const buckets: Record<"today" | "yesterday" | "last7Days" | "older", typeof items> = {
      today: [], yesterday: [], last7Days: [], older: [],
    }
    for (const chat of items) {
      const ts = new Date(chat.updatedAt).getTime()
      if (ts >= startOfToday) buckets.today.push(chat)
      else if (ts >= startOfYesterday) buckets.yesterday.push(chat)
      else if (ts >= weekAgo) buckets.last7Days.push(chat)
      else buckets.older.push(chat)
    }
    return buckets
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

  const handleGPTsClick = () => navigate("/gpts")
  const handleProjectsClick = () => navigate("/projects")
  const handleDesignClick = () => navigate("/design")
  const handleLibraryClick = () => navigate("/library")

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



  // Handle edit chat title
  const handleEditClick = (chat: any, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation()
      e.preventDefault()
    }
    setEditingChatId(chat.id)
    setEditTitle(chat.title)
    // Small delay for smooth animation
    setTimeout(() => {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }, 50)
  }

  // Handle save edited title
  const handleSaveEdit = async (chatId: string) => {
    if (!editTitle.trim()) {
      setEditingChatId(null)
      return
    }

    const newTitle = editTitle.trim()
    const originalTitle = chats.find(c => c.id === chatId)?.title || ""

    // Optimistic update - update immediately
    setOptimisticUpdates(prev => ({ ...prev, [chatId]: newTitle }))

    // Update current chat immediately if it's the one being edited
    if (currentChat?.id === chatId) {
      setCurrentChat({ ...currentChat, title: newTitle })
    }

    setEditingChatId(null)
    setEditTitle("")

    try {
      // Call API to update on server
      await apiClient.updateChat(chatId, { title: newTitle })

      // Silently fetch updated chat to sync with server without navigation
      try {
        const chatResponse = await apiClient.getChat(chatId)
        const refreshedChat = chatResponse.chat

        // Update currentChat if it's the active one (without navigation)
        if (currentChat?.id === chatId) {
          setCurrentChat(refreshedChat)
        }

        // Note: The optimistic update will handle the display
        // The chats array will sync naturally on next refresh or navigation
        // We don't call selectChat to avoid navigation
      } catch (refreshError) {
        // If refresh fails, that's okay - optimistic update will handle display
        console.log('Could not refresh chat, but update was successful')
      }

      // Keep optimistic update active - it will persist until natural refresh
      // This ensures the UI shows the updated title immediately and it persists
      // The optimistic update will remain until page refresh or chat list reload

      toast.success("Chat renamed successfully")
    } catch (error) {
      console.error('Failed to update chat title:', error)

      // Revert optimistic update on error
      setOptimisticUpdates(prev => {
        const updated = { ...prev }
        delete updated[chatId]
        return updated
      })

      // Revert current chat if it was updated
      if (currentChat?.id === chatId) {
        setCurrentChat({ ...currentChat, title: originalTitle })
      }

      toast.error('Failed to update chat title')
    }
  }

  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditingChatId(null)
    setEditTitle("")
    // Remove any optimistic updates when canceling
    if (editingChatId) {
      setOptimisticUpdates(prev => {
        const updated = { ...prev }
        delete updated[editingChatId]
        return updated
      })
    }
  }

  // Handle key press in edit input
  const handleEditKeyDown = (e: React.KeyboardEvent, chatId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit(chatId)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
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
  const isOnProjectsPage = pathname.startsWith('/projects')
  const isOnDesignPage = pathname.startsWith('/design')

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
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">Sira GPT</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 mt-0.5">AI Platform</span>
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
        <TooltipProvider>
          {/* Shared pattern for nav items — the `group` enables
              hover-coordinated transforms on the icon and color fade on
              the label without spreading timing logic across children:
              - row: bg-muted/40 on hover with rounded-lg (150ms)
              - icon: scale 1.15 + -translateY(1px) on hover (200ms ease-out), scale 0.95 on active for press feedback
              - label: color fade to primary on hover */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleNewChat}
                className="group/nav w-full justify-start h-9 px-3 rounded-lg transition-colors duration-150 hover:bg-muted/40"
              >
                <PenSquare className="h-4 w-4 text-indigo-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">{t("newChat")}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("newChat")}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleSearchClick}
                className="group/nav w-full justify-start h-9 px-3 rounded-lg transition-colors duration-150 hover:bg-muted/40"
                variant="default"
              >
                <Search className="h-4 w-4 text-sky-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">{t("searchChats")}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("searchChats")}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleLibraryClick}
                onMouseEnter={() => prefetchOnHover('/library')}
                className={cn(
                  "group/nav w-full justify-start h-9 px-3 rounded-lg transition-colors duration-150 hover:bg-muted/40",
                  pendingHref === '/library' && "opacity-70"
                )}
                variant="default"
              >
                <Images className="h-4 w-4 text-amber-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">{t("library")}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("library")}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleGPTsClick}
                onMouseEnter={() => prefetchOnHover('/gpts')}
                className={cn(
                  "group/nav w-full justify-start h-9 px-3 rounded-lg transition-colors duration-150 hover:bg-muted/40",
                  isOnGPTsPage && "bg-accent text-accent-foreground",
                  pendingHref === '/gpts' && "opacity-70"
                )}
                variant="default"
              >
                <LayoutGrid className="h-4 w-4 text-emerald-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">{t("gpts")}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("gpts")}</p>
            </TooltipContent>
          </Tooltip>

          {/* Projects — file-bucket workspaces. Placed right after GPTs
              because both are "context-rich chat entry points": GPTs
              are reusable personas, Projects are task-scoped bundles.
              Same interaction / hover language as every other nav row
              so the sidebar reads as one coherent column. */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleProjectsClick}
                onMouseEnter={() => prefetchOnHover('/projects')}
                className={cn(
                  "group/nav w-full justify-start h-9 px-3 rounded-lg transition-colors duration-150 hover:bg-muted/40",
                  isOnProjectsPage && "bg-accent text-accent-foreground",
                  pendingHref === '/projects' && "opacity-70"
                )}
                variant="default"
              >
                <FolderKanban className="h-4 w-4 text-rose-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">{t("projects")}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("projects")}</p>
            </TooltipContent>
          </Tooltip>

          {/* Design — siraGPT's Claude-Design-style canvas, placed
              right under Projects since both are workspace-shaped
              artifacts (design extends the workflow with a visual
              output surface). Palette icon keeps it distinct from
              FolderKanban without clashing visually. */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleDesignClick}
                onMouseEnter={() => prefetchOnHover('/design')}
                className={cn(
                  "group/nav w-full justify-start h-9 px-3 rounded-lg transition-colors duration-150 hover:bg-muted/40",
                  isOnDesignPage && "bg-accent text-accent-foreground",
                  pendingHref === '/design' && "opacity-70"
                )}
                variant="default"
              >
                <Palette className="h-4 w-4 text-fuchsia-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">{t("design")}</span>
              </SidebarMenuButton>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("design")}</p>
            </TooltipContent>
          </Tooltip>

        </TooltipProvider>

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
                "px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60 select-none",
                state === "closed" && "hidden"
              )}
            >
              {t("recentChats")}
            </SidebarGroupLabel>
            <SidebarGroupContent
              className={cn(state === "closed" && "hidden")}
            >
              <SidebarMenu>
                {chats.length === 0 ? (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("noChats")}
                  </div>
                ) : (
                  <>
                    {(() => {
                      // Split the validated chats into time buckets so
                      // the sidebar reads like a journal instead of a
                      // flat wall — matches the mental model users
                      // already have from ChatGPT/Claude. Each chat's
                      // inline timestamp stays compact so the group
                      // header provides the coarse context and the row
                      // just shows the fine offset ("3h", "2d").
                      const validChats = chats.filter(c => c && c.id)
                      const buckets = groupChatsByTime(validChats)
                      const groupDefs: Array<[keyof typeof buckets, string]> = [
                        ["today", t("today")],
                        ["yesterday", t("yesterday")],
                        ["last7Days", t("last7Days")],
                        ["older", t("older")],
                      ]

                      const renderChatItem = (chat: any) => {
                        const isEditing = editingChatId === chat.id
                        const displayTitle = optimisticUpdates[chat.id] || chat.title
                        const isTruncated = displayTitle.length > 25
                        // Per-chat streaming indicator — drives the small
                        // blue spinner that sits to the left of the 3-dot
                        // menu while this chat's stream is still generating.
                        const isStreaming = bgStreams.get(chat.id)?.status === "streaming"

                        return (
                          <SidebarMenuItem key={chat.id}>
                            <div className="flex w-full items-center gap-0.5 group">
                              {isEditing ? (
                                <div className="flex-1 flex items-center gap-1.5 px-2 py-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                                  <Input
                                    ref={editInputRef}
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    onKeyDown={(e) => handleEditKeyDown(e, chat.id)}
                                    onBlur={() => handleSaveEdit(chat.id)}
                                    className="h-7 text-sm flex-1 px-2 py-1"
                                    onClick={(e) => e.stopPropagation()}
                                    autoFocus
                                  />
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 hover:bg-green-100 dark:hover:bg-green-900/20"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSaveEdit(chat.id)
                                    }}
                                  >
                                    <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-900/20"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleCancelEdit()
                                    }}
                                  >
                                    <X className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                                  </Button>
                                </div>
                              ) : (
                                <>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <SidebarMenuButton
                                          isActive={currentChat?.id === chat.id && pathname.startsWith('/chat')}
                                          onClick={() => !isEditing && handleChatClick(chat.id)}
                                          className={cn(
                                            "h-8 min-w-0 flex-1 justify-start py-0 pr-1 transition-all",
                                          )}
                                        >
                                          <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <span className="text-sm flex-1 truncate">
                                              {displayTitle}
                                            </span>
                                            {/* Timestamp fades on row-hover so the 3-dot menu
                                                doesn't fight it for the right slot. tabular-nums
                                                keeps widths aligned between "3h" and "12d". */}
                                            <span className="text-[11px] text-muted-foreground/60 shrink-0 tabular-nums transition-opacity duration-150 group-hover:opacity-0">
                                              {formatChatTimeCompact(chat.updatedAt)}
                                            </span>
                                          </div>
                                        </SidebarMenuButton>
                                      </TooltipTrigger>
                                      {isTruncated && (
                                        <TooltipContent side="right" className="max-w-xs">
                                          <p className="break-words">{displayTitle}</p>
                                        </TooltipContent>
                                      )}
                                    </Tooltip>
                                  </TooltipProvider>
                                  {isStreaming && (
                                    <span
                                      className="flex h-8 w-7 shrink-0 items-center justify-center"
                                      title="Generando…"
                                    >
                                      <Loader2
                                        aria-label="Chat en progreso"
                                        className="h-3.5 w-3.5 animate-spin text-primary"
                                        strokeWidth={2.25}
                                      />
                                    </span>
                                  )}
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="flex h-8 w-8 shrink-0 items-center justify-center p-0 opacity-0 transition-opacity group-hover:opacity-100"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                                      <DropdownMenuItem
                                        onClick={(e) => handleEditClick(chat, e)}
                                      >
                                        <Edit2 className="mr-2 h-4 w-4" />
                                        Rename
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          deleteChat(chat.id)
                                        }}
                                        className="text-red-600 focus:text-red-600"
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </>
                              )}
                            </div>
                          </SidebarMenuItem>
                        )
                      }

                      return groupDefs.map(([key, label]) => {
                        const items = buckets[key]
                        if (items.length === 0) return null
                        return (
                          <React.Fragment key={key}>
                            <div className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 select-none">
                              {label}
                            </div>
                            {items.map(renderChatItem)}
                          </React.Fragment>
                        )
                      })
                    })()}

                    {/* Loading indicator at the bottom */}
                    {isLoadingMore && (
                      <SidebarMenuItem>
                        <div className="flex items-center justify-center py-3">
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          <span className="text-xs text-muted-foreground">{t("loadingMoreChats")}</span>
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
                          {t("loadMoreChats")}
                        </Button>
                      </SidebarMenuItem>
                    )}

                    {/* End of chats indicator */}
                    {!hasMoreChats && !isLoadingMore && chats.length >= 20 && (
                      <SidebarMenuItem>
                        <div className="text-center py-2 text-xs text-muted-foreground opacity-50">
                          {t("allChatsLoaded")}
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
                  <SidebarMenuButton className="group/user flex-1 justify-start h-auto py-3">
                    <Avatar
                      className={cn(
                        "ring-2 ring-primary/0 transition-all duration-200 group-hover/user:ring-primary/40",
                        state === "closed" && "hidden" ? "h-6 w-6" : "h-9 w-9",
                      )}
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
                        {user?.isSuperAdmin ? t("superAdministrator") : user?.isAdmin ? t("administrator") : user?.plan || t("freePlan")}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  sideOffset={12}
                  className={cn(
                    // Liquid-glass surface
                    "w-64 overflow-hidden rounded-2xl p-1.5",
                    "border border-white/30 bg-white/55 backdrop-blur-2xl backdrop-saturate-150",
                    "dark:border-white/10 dark:bg-neutral-900/55",
                    // Outer ambient shadow + inner top highlight in one declaration
                    "shadow-[0_12px_48px_-12px_rgba(0,0,0,0.22),inset_0_1px_0_0_rgba(255,255,255,0.55)]",
                    "dark:shadow-[0_12px_48px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_0_rgba(255,255,255,0.08)]",
                  )}
                >
                  <DropdownMenuItem
                    onClick={() => navigate("/profile")}
                    onMouseEnter={() => prefetchOnHover("/profile")}
                    className={LG_ITEM}
                  >
                    <User className="mr-2 h-4 w-4" />
                    {t("profile")}
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onClick={() => navigate("/billing")}
                    onMouseEnter={() => prefetchOnHover("/billing")}
                    className={LG_ITEM}
                  >
                    <CreditCard className="mr-2 h-4 w-4" />
                    {t("billing")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => navigate("/settings")}
                    onMouseEnter={() => prefetchOnHover("/settings")}
                    className={LG_ITEM}
                  >
                    <Settings className="mr-2 h-4 w-4" />
                    {t("settings")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => navigate("/privacy-policy")}
                    onMouseEnter={() => prefetchOnHover("/privacy-policy")}
                    className={LG_ITEM}
                  >
                    <Shield className="mr-2 h-4 w-4" />
                    {t("privacyPolicy")}
                  </DropdownMenuItem>
                  {user?.isAdmin && (
                    <>
                      <DropdownMenuSeparator className={LG_SEP} />
                      <DropdownMenuItem
                        onClick={() => navigate("/admin")}
                        onMouseEnter={() => prefetchOnHover("/admin")}
                        className={LG_ITEM}
                      >
                        <Settings className="mr-2 h-4 w-4" />
                        {t("adminPanel")}
                      </DropdownMenuItem>
                    </>
                  )}
                  {user?.isSuperAdmin && (
                    <>
                      <DropdownMenuSeparator className={LG_SEP} />
                      <DropdownMenuItem
                        onClick={() => navigate("/super-admin")}
                        onMouseEnter={() => prefetchOnHover("/super-admin")}
                        className={LG_ITEM}
                      >
                        <Shield className="mr-2 h-4 w-4 text-red-600" />
                        <span className="text-red-600">{t("superAdminPanel")}</span>
                      </DropdownMenuItem>
                    </>
                  )}
                  {/* Hidden return option for super admin accessing other accounts */}
                  {typeof window !== "undefined" && localStorage.getItem('superadmin-return-data') && (
                    <>
                      <DropdownMenuSeparator className={LG_SEP} />
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
                        className={cn(LG_ITEM, "text-orange-600")}
                      >
                        <Shield className="mr-2 h-4 w-4" />
                        {t("returnToSuperAdmin")}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator className={LG_SEP} />
                  <DropdownMenuItem
                    className={cn(LG_ITEM, "text-red-600 focus:text-red-600 data-[highlighted]:text-red-600")}
                    onClick={handleLogout}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    {t("logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Upgrade button for FREE users or users approaching limit - only visible when sidebar is open */}
              {shouldShowUpgrade && state === "open" && (
                <Button
                  onClick={handleUpgradeClick}
                  size="sm"
                  variant={usagePercentage >= 90 ? "destructive" : "outline"}
                  className={`ml-2 h-7 px-2 text-xs ${usagePercentage >= 90
                    ? ""
                    : "border-primary text-primary hover:bg-primary hover:text-primary-foreground"
                    }`}
                >
                  <Crown className="h-3 w-3 mr-1" />
                  {usagePercentage >= 90 ? t("upgradeNow") : t("upgrade")}
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
