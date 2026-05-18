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
  Pin,
  Folder,
  Download,
  Archive,
  EyeOff,
  CalendarDays,
  FolderKanban,
  Palette,
  Code2,
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
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { cn, downloadBlob } from "@/lib/utils"
import Link from "next/link"
import UpgradeModal from "./UpgradeModal"
import { ChatSearchDialog } from "./ChatSearchDialog"
import { SidebarFoldersDropdown } from "./sidebar/sidebar-folders-dropdown"
import {
  normalizeNavigationHref,
  useNavigationTransition,
} from "@/components/navigation-transition-context"
import { apiClient } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
// import NotificationCenter from "./notification-center" // Commented out to stop repeated API calls

// Shared liquid-glass styles for the user menu dropdown. Keeping them
// as module constants avoids allocating a new string on every render
// and lets both normal and destructive variants compose via cn().
const LG_ITEM = cn(
  "relative isolate cursor-pointer rounded-xl px-2.5 py-2 text-sm font-medium",
  "text-foreground/85 transition-all duration-200",
  "focus:bg-muted/80 focus:text-foreground focus:backdrop-blur-md",
  "data-[highlighted]:bg-muted/80 data-[highlighted]:text-foreground",
)
const LG_SEP = "my-1 bg-border/60"

const formatSidebarChatTitle = (value: unknown) => {
  return String(value || "")
    .replace(/^🤖\s*Tarea:\s*/i, "{} ")
    .replace(/^🤖\s*/i, "{} ")
    .trim()
}

type SidebarNavItemProps = {
  href: string
  label: React.ReactNode
  tooltip: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  iconClassName: string
  active: boolean
  pending: boolean
  sidebarState: "open" | "closed"
  navigationLabel?: string
  markNavigationIntent: (href: string, label?: string) => void
  prefetchOnHover: (href: string) => void
  onNavigate?: () => void
}

function SidebarNavItem({
  href,
  label,
  tooltip,
  icon: Icon,
  iconClassName,
  active,
  pending,
  sidebarState,
  navigationLabel,
  markNavigationIntent,
  prefetchOnHover,
  onNavigate,
}: SidebarNavItemProps) {
  const intentLabel = navigationLabel ?? (typeof label === "string" ? label : undefined)
  const markIntent = React.useCallback(() => {
    markNavigationIntent(href, intentLabel)
  }, [href, intentLabel, markNavigationIntent])

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <SidebarMenuButton
          asChild
          isActive={active}
          className={cn(
            "group/nav w-full justify-start h-9 px-3 rounded-lg",
            "transition-[background-color,color,box-shadow] duration-fast ease-smooth",
            "hover:bg-muted/45",
            active && "bg-accent text-accent-foreground shadow-[inset_2px_0_0_0_hsl(var(--accent-violet)/0.65)] dark:shadow-[inset_2px_0_0_0_hsl(var(--accent-violet)/0.7)]",
            pending && "opacity-70"
          )}
          variant="default"
        >
          <Link
            href={href}
            prefetch
            scroll={false}
            aria-current={active ? "page" : undefined}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1"
            onPointerDown={markIntent}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                if (event.key === " ") event.preventDefault()
                markIntent()
              }
            }}
            onMouseEnter={() => prefetchOnHover(href)}
            onClick={() => {
              markIntent()
              onNavigate?.()
            }}
          >
            <Icon className={cn("h-4 w-4 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]", iconClassName)} />
            <span className="group-data-[state=closed]:hidden -ml-0.2 transition-colors duration-200 group-hover/nav:text-primary">
              {label}
            </span>
          </Link>
        </SidebarMenuButton>
      </TooltipTrigger>
      <TooltipContent side="right" className={sidebarState === "open" ? "hidden" : ""}>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  )
}

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
  //   3. The target route is marked active optimistically before
  //      router.push resolves. In dev, route compilation can take
  //      seconds; the sidebar still acknowledges the click in-frame.
  // ────────────────────────────────────────────────────────────
  const SIDEBAR_ROUTES = React.useMemo(
    () => [
      '/chat', '/gpts', '/parafraseo', '/projects', '/design', '/code', '/library',
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
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar()
  const [, startNavTransition] = React.useTransition()
  const {
    pendingHref,
    markNavigationIntent: markSharedNavigationIntent,
    clearNavigationIntent,
  } = useNavigationTransition()
  const [newChatPending, setNewChatPending] = React.useState(false)
  const normalizedPathname = normalizeNavigationHref(pathname)
  const activePathname = pendingHref ?? normalizedPathname
  const isPendingRoute = React.useCallback(
    (href: string) => pendingHref === normalizeNavigationHref(href),
    [pendingHref],
  )
  const navigate = React.useCallback((href: string, label?: string) => {
    // Mobile should close the sheet immediately after a tap. Desktop
    // stays open so the active item can change in-frame; collapsing it
    // here makes navigation feel slower and removes the feedback target.
    if (isMobile) setOpenMobile(false)

    // If we're already on the route, don't push again. Keeping the
    // current frame avoids a redundant RSC fetch.
    const targetHref = normalizeNavigationHref(href)
    if (normalizedPathname === targetHref || normalizedPathname.startsWith(`${targetHref}/`)) {
      clearNavigationIntent()
      return
    }
    markSharedNavigationIntent(targetHref, label)
    startNavTransition(() => { router.push(href, { scroll: false }) })
  }, [
    clearNavigationIntent,
    isMobile,
    markSharedNavigationIntent,
    normalizedPathname,
    router,
    setOpenMobile,
  ])
  React.useEffect(() => {
    if (!newChatPending) return
    const id = window.setTimeout(() => setNewChatPending(false), 250)
    return () => window.clearTimeout(id)
  }, [newChatPending])
  const prefetchOnHover = React.useCallback((href: string) => {
    try { router.prefetch(href) } catch { /* ignore */ }
  }, [router])
  const markNavigationIntent = React.useCallback((href: string, label?: string) => {
    const targetHref = normalizeNavigationHref(href)
    if (normalizedPathname === targetHref || normalizedPathname.startsWith(`${targetHref}/`)) return
    markSharedNavigationIntent(targetHref, label)
    try { router.prefetch(targetHref) } catch { /* ignore */ }
  }, [markSharedNavigationIntent, normalizedPathname, router])
  const markNewChatIntent = React.useCallback(() => {
    setNewChatPending(true)
    markSharedNavigationIntent("/chat", t("newChat"))
  }, [markSharedNavigationIntent, t])
  const [upgradeOpen, setUpgradeOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)

  // ── Global keyboard shortcut: ⌘K / Ctrl+K opens chat search ──────
  // Mirrors the affordance every Claude / Linear / Notion user
  // already has in muscle memory. Skipped while focus is in an
  // input/textarea/contenteditable so we don't hijack regular typing.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const isTyping =
        tag === "input" || tag === "textarea" || target?.isContentEditable === true
      const isCmdK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"
      if (!isCmdK) return
      // ⌘K from anywhere — even mid-input — should still open search.
      // This is the convention every productivity app follows, so the
      // `isTyping` gate above only protects accidental letter shortcuts
      // (none added here yet, just the gate skeleton for future ones).
      if (isTyping && !isCmdK) return
      event.preventDefault()
      setSearchOpen((current) => !current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const [editingChatId, setEditingChatId] = React.useState<string | null>(null)
  const [editTitle, setEditTitle] = React.useState("")
  const [optimisticUpdates, setOptimisticUpdates] = React.useState<Record<string, string>>({})
  const [pinnedGpts, setPinnedGpts] = React.useState<Array<{ id: string; name: string; iconUrl?: string | null; modelName?: string | null }>>([])
  const [pinnedChatIds, setPinnedChatIds] = React.useState<string[]>([])
  const [archivedChatIds, setArchivedChatIds] = React.useState<string[]>([])
  const [hiddenChatIds, setHiddenChatIds] = React.useState<string[]>([])
  const [chatFolders, setChatFolders] = React.useState<Record<string, string>>({})
  const [scheduledChats, setScheduledChats] = React.useState<Record<string, { at: string; note?: string; title?: string }>>({})
  const [scheduleTarget, setScheduleTarget] = React.useState<any | null>(null)
  const [scheduleAt, setScheduleAt] = React.useState("")
  const [scheduleNote, setScheduleNote] = React.useState("")

  // Scroll area ref for infinite scroll
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const editInputRef = React.useRef<HTMLInputElement>(null)

  const handleLogout = () => {
    localStorage.setItem("currentChatId", "")
    logout()
    router.push("/")
  }

  React.useEffect(() => {
    const loadPinnedGpts = () => {
      try {
        const items = JSON.parse(localStorage.getItem("sira:pinned-gpt-items") || "[]")
        setPinnedGpts(Array.isArray(items) ? items.filter((item) => item?.id && item?.name).slice(0, 12) : [])
      } catch {
        setPinnedGpts([])
      }
    }
    loadPinnedGpts()
    window.addEventListener("siragpt:pinned-gpts-changed", loadPinnedGpts)
    window.addEventListener("storage", loadPinnedGpts)
    return () => {
      window.removeEventListener("siragpt:pinned-gpts-changed", loadPinnedGpts)
      window.removeEventListener("storage", loadPinnedGpts)
    }
  }, [])

  React.useEffect(() => {
    try {
      const readArray = (key: string) => {
        const value = JSON.parse(localStorage.getItem(key) || "[]")
        return Array.isArray(value) ? value.filter((id) => typeof id === "string") : []
      }
      const readRecord = (key: string) => {
        const value = JSON.parse(localStorage.getItem(key) || "{}")
        return value && typeof value === "object" && !Array.isArray(value) ? value : {}
      }
      setPinnedChatIds(readArray("sira:pinned-chat-ids"))
      setArchivedChatIds(readArray("sira:archived-chat-ids"))
      setHiddenChatIds(readArray("sira:hidden-chat-ids"))
      setChatFolders(readRecord("sira:chat-folders"))
      setScheduledChats(readRecord("sira:scheduled-chats"))
    } catch {
      setPinnedChatIds([])
      setArchivedChatIds([])
      setHiddenChatIds([])
      setChatFolders({})
      setScheduledChats({})
    }
  }, [])

  const persistArrayState = React.useCallback((
    key: string,
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    updater: (current: string[]) => string[],
  ) => {
    setter((current) => {
      const next = updater(Array.isArray(current) ? current : [])
      try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const togglePinnedChat = React.useCallback((chat: any) => {
    persistArrayState("sira:pinned-chat-ids", setPinnedChatIds, (current) => {
      const exists = current.includes(chat.id)
      toast.success(exists ? "Chat desfijado" : "Chat fijado")
      return exists ? current.filter((id) => id !== chat.id) : [chat.id, ...current]
    })
  }, [persistArrayState])

  const archiveChatLocally = React.useCallback((chat: any) => {
    persistArrayState("sira:archived-chat-ids", setArchivedChatIds, (current) => (
      current.includes(chat.id) ? current : [chat.id, ...current]
    ))
    toast.success("Chat archivado")
  }, [persistArrayState])

  const hideChatLocally = React.useCallback((chat: any) => {
    persistArrayState("sira:hidden-chat-ids", setHiddenChatIds, (current) => (
      current.includes(chat.id) ? current : [chat.id, ...current]
    ))
    toast.success("Chat ocultado")
  }, [persistArrayState])

  const moveChatToFolder = React.useCallback((chat: any, folder: string | null) => {
    setChatFolders((current) => {
      const next = { ...(current || {}) }
      if (folder) next[chat.id] = folder
      else delete next[chat.id]
      try { localStorage.setItem("sira:chat-folders", JSON.stringify(next)) } catch {}
      return next
    })
    toast.success(folder ? `Movido a ${folder}` : "Chat quitado de carpeta")
  }, [])

  const createFolderAndMove = React.useCallback((chat: any) => {
    const folder = window.prompt("Nombre de la carpeta")
    if (!folder?.trim()) return
    moveChatToFolder(chat, folder.trim())
  }, [moveChatToFolder])

  const downloadChatExport = React.useCallback(async (chat: any) => {
    try {
      const activeChat = currentChat
      let source: any
      if (activeChat && activeChat.id === chat.id && activeChat.messages?.length) {
        source = activeChat
      } else {
        source = (await apiClient.getChat(chat.id)).chat
      }
      const messages = Array.isArray(source.messages) ? source.messages : []
      const body = [
        `# ${source.title || "Chat"}`,
        "",
        `- ID: ${source.id}`,
        `- Modelo: ${source.model || "N/A"}`,
        `- Actualizado: ${source.updatedAt || chat.updatedAt || ""}`,
        "",
        ...messages.flatMap((message: any) => [
          `## ${message.role || "MESSAGE"}`,
          "",
          String(message.content || "").trim(),
          "",
        ]),
      ].join("\n")
      const filename = `${String(source.title || "chat").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_") || "chat"}.md`
      downloadBlob(new Blob([body], { type: "text/markdown;charset=utf-8" }), filename)
      toast.success("Descarga iniciada")
    } catch (error) {
      toast.error("No se pudo descargar el chat")
    }
  }, [currentChat])

  const openScheduleDialog = React.useCallback((chat: any) => {
    const current = scheduledChats[chat.id]
    setScheduleTarget(chat)
    setScheduleAt(current?.at || "")
    setScheduleNote(current?.note || "")
  }, [scheduledChats])

  const saveScheduledChat = React.useCallback(() => {
    if (!scheduleTarget?.id) return
    if (!scheduleAt) {
      toast.error("Elige fecha y hora")
      return
    }
    setScheduledChats((current) => {
      const next = {
        ...(current || {}),
        [scheduleTarget.id]: {
          at: scheduleAt,
          note: scheduleNote.trim(),
          title: scheduleTarget.title,
        },
      }
      try { localStorage.setItem("sira:scheduled-chats", JSON.stringify(next)) } catch {}
      return next
    })
    setScheduleTarget(null)
    setScheduleAt("")
    setScheduleNote("")
    toast.success("Chat programado")
  }, [scheduleAt, scheduleNote, scheduleTarget])

  const handleNewChat = () => {
    markNewChatIntent()
    setCurrentChat(null);
    localStorage.removeItem('currentChatId');

    // Reset connector/tool state after the click frame has painted.
    // Dispatching synchronously blocks the visual "new chat" reset.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('resetChatState'));
    }, 0);

    const hasQuery = typeof window !== "undefined" && window.location.search.length > 0
    if (!pathname.startsWith('/chat') || hasQuery) {
      startNavTransition(() => { router.replace('/chat', { scroll: false }) })
    } else {
      window.setTimeout(clearNavigationIntent, 0)
    }
    if (isMobile) {
      setOpenMobile(false);
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

  const startPinnedGptChat = async (gptId: string) => {
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/gpts/${gptId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.chat?.id) throw new Error(data?.error || "No se pudo abrir el GPT")
      localStorage.setItem("currentChatId", data.chat.id)
      markSharedNavigationIntent("/chat", data.chat?.title || "Chat")
      router.push(`/chat?id=${data.chat.id}`, { scroll: false })
      if (isMobile) setOpenMobile(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo abrir el GPT")
    }
  }

  const handleChatClick = (chatId: string) => {
    markSharedNavigationIntent("/chat", "Chat")
    selectChat(chatId)
    // Navigate to chat page if not already there
    if (!pathname.startsWith('/chat')) {
      startNavTransition(() => { router.push(`/chat?id=${chatId}`, { scroll: false }) })
    } else {
      window.setTimeout(clearNavigationIntent, 0)
    }
    if (isMobile) {
      setOpenMobile(false);
    }
  }

  const handleSearchClick = React.useCallback(() => {
    setSearchOpen(true)
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])



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
        // Chat refresh failed but update succeeded — no log to avoid noise
      }

      // Keep optimistic update active - it will persist until natural refresh
      // This ensures the UI shows the updated title immediately and it persists
      // The optimistic update will remain until page refresh or chat list reload

      toast.success("Chat renombrado")
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
  const isOnChatPage = activePathname.startsWith('/chat')
  const isOnLibraryPage = activePathname.startsWith('/library')
  const isOnGPTsPage = activePathname.startsWith('/gpts')
  const isOnParaphrasePage = activePathname.startsWith('/parafraseo')
  const isOnProjectsPage = activePathname.startsWith('/projects')
  const isOnDesignPage = activePathname.startsWith('/design')
  const isOnCodePage = activePathname.startsWith('/code')

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
                className="h-10 w-10 rounded-lg object-contain"
              />

            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">Sira GPT</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 mt-0.5">AI Platform</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* <NotificationCenter /> */} {/* Commented out to stop repeated API calls */}
            <SidebarTrigger
              aria-label="Ocultar barra lateral"
              title="Ocultar barra lateral"
              className="h-8 w-8 rounded-full border border-border/60 bg-background text-muted-foreground shadow-none transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
            >
              <PanelLeft className="h-4 w-4" />
            </SidebarTrigger>
          </div>
        </div>
        {/* Jab sidebar close ho to sirf yeh logo dikhega (hover effect ke saath) */}
        <div className={cn("relative", state === "open" && "hidden")}>
          <div
            className="group flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
            onClick={toggleSidebar}
            role="button"
            aria-label="Mostrar barra lateral"
            title="Mostrar barra lateral"
          >
            <Bot className="h-4 w-4 transition-opacity group-hover:opacity-0" />
            <PanelLeft className="absolute h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
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
              <button
                onPointerDown={markNewChatIntent}
                onClick={handleNewChat}
                data-sidebar="menu-button"
                className="group/nav peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent/80 active:bg-sidebar-accent/60 disabled:opacity-50"
              >
                <PenSquare className="h-4 w-4 text-indigo-500 transition-transform duration-200 ease-out group-hover/nav:scale-[1.15] group-hover/nav:-translate-y-[1px] group-active/nav:scale-[0.95]" />
                <span className="group-data-[state=closed]:hidden -ml-0.2 text-sidebar-accent-foreground">{t("newChat")}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className={state === "open" ? "hidden" : ""}>
              <p>{t("newChat")}</p>
            </TooltipContent>
          </Tooltip>

          {pinnedGpts.length > 0 && (
            <div className={cn("mt-1 space-y-1", state === "closed" && "hidden")}>
              {pinnedGpts.map((gpt) => (
                <button
                  key={gpt.id}
                  type="button"
                  onClick={() => startPinnedGptChat(gpt.id)}
                  className="group/nav flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground"
                  title={gpt.name}
                >
                  {gpt.iconUrl ? (
                    gpt.iconUrl.startsWith("http") || gpt.iconUrl.startsWith("https") || gpt.iconUrl.startsWith("data:") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={gpt.iconUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/40 text-[10px] text-purple-700 dark:text-purple-300">
                        {gpt.iconUrl}
                      </span>
                    )
                  ) : (
                    <Sparkles className="h-4 w-4 text-purple-500" />
                  )}
                  <span className="min-w-0 truncate">{gpt.name}</span>
                </button>
              ))}
            </div>
          )}

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={handleSearchClick}
                onPointerDown={handleSearchClick}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    if (event.key === " ") event.preventDefault()
                    handleSearchClick()
                  }
                }}
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

          <SidebarNavItem
            href="/library"
            label={t("library")}
            tooltip={t("library")}
            icon={Images}
            iconClassName="text-amber-500"
            active={isOnLibraryPage}
            pending={isPendingRoute("/library")}
            sidebarState={state}
            markNavigationIntent={markNavigationIntent}
            prefetchOnHover={prefetchOnHover}
            onNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />

          <SidebarNavItem
            href="/gpts"
            label={t("gpts")}
            tooltip={t("gpts")}
            icon={LayoutGrid}
            iconClassName="text-emerald-500"
            active={isOnGPTsPage}
            pending={isPendingRoute("/gpts")}
            sidebarState={state}
            markNavigationIntent={markNavigationIntent}
            prefetchOnHover={prefetchOnHover}
            onNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />

          <SidebarNavItem
            href="/parafraseo"
            label="Parafraseo"
            tooltip="Parafraseo"
            icon={Sparkles}
            iconClassName="text-teal-500"
            active={isOnParaphrasePage}
            pending={isPendingRoute("/parafraseo")}
            sidebarState={state}
            markNavigationIntent={markNavigationIntent}
            prefetchOnHover={prefetchOnHover}
            onNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />

          {/* Projects — file-bucket workspaces. Placed right after GPTs
              because both are "context-rich chat entry points": GPTs
              are reusable personas, Projects are task-scoped bundles.
              Same interaction / hover language as every other nav row
              so the sidebar reads as one coherent column. */}
          <SidebarNavItem
            href="/projects"
            label={t("projects")}
            tooltip={t("projects")}
            icon={FolderKanban}
            iconClassName="text-rose-500"
            active={isOnProjectsPage}
            pending={isPendingRoute("/projects")}
            sidebarState={state}
            markNavigationIntent={markNavigationIntent}
            prefetchOnHover={prefetchOnHover}
            onNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />

          {/* Design — siraGPT's Claude-Design-style canvas, placed
              right under Projects since both are workspace-shaped
              artifacts (design extends the workflow with a visual
              output surface). Palette icon keeps it distinct from
              FolderKanban without clashing visually. */}
          <SidebarNavItem
            href="/design"
            label={t("design")}
            tooltip={t("design")}
            icon={Palette}
            iconClassName="text-fuchsia-500"
            active={isOnDesignPage}
            pending={isPendingRoute("/design")}
            sidebarState={state}
            markNavigationIntent={markNavigationIntent}
            prefetchOnHover={prefetchOnHover}
            onNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />

          {/* Código — Cursor-style code workspace at /code (Monaco
              editor + virtual file tree + AI chat panel). Sits
              directly under Diseño so the two creative surfaces
              (visual + textual) live next to each other. Code2
              icon (with the angle brackets) is the lucide
              convention for a code-editor entry. */}
          <SidebarNavItem
            href="/code"
            label={t("code")}
            tooltip={t("code")}
            icon={Code2}
            iconClassName="text-emerald-500"
            active={isOnCodePage}
            pending={isPendingRoute("/code")}
            sidebarState={state}
            markNavigationIntent={markNavigationIntent}
            prefetchOnHover={prefetchOnHover}
            onNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />

        </TooltipProvider>

      </div>

      <SidebarContent
        className="px-2 overflow-y-auto custom-scrollbar flex-1"
        ref={scrollAreaRef}
        onScroll={handleScroll}
      >
        <SidebarSeparator />

        {/* Folders dropdown — projects act as the user's "carpetas". Sits
            above the recent-chats list so the user can pick a workspace
            scope before browsing individual conversations. Hidden when
            the sidebar is collapsed to icon mode (no room for the tree). */}
        {selectedType === "Text Chat" && (
          <SidebarFoldersDropdown
            collapsed={state === "closed"}
            onMobileNavigate={() => { if (isMobile) setOpenMobile(false) }}
          />
        )}

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
                      const seenChatIds = new Set<string>()
                      const visibleChats = chats.filter((c) => {
                        if (!c?.id || seenChatIds.has(c.id)) return false
                        seenChatIds.add(c.id)
                        if (hiddenChatIds.includes(c.id) || archivedChatIds.includes(c.id)) return false
                        return true
                      })
                      const visibleById = new Map(visibleChats.map((chat) => [chat.id, chat]))
                      const pinnedChats = pinnedChatIds.map((id) => visibleById.get(id)).filter(Boolean) as any[]
                      const pinnedSet = new Set(pinnedChats.map((chat) => chat.id))
                      const validChats = visibleChats.filter((chat) => !pinnedSet.has(chat.id))
                      const buckets = groupChatsByTime(validChats)
                      const groupDefs: Array<[keyof typeof buckets, string]> = [
                        ["today", t("today")],
                        ["yesterday", t("yesterday")],
                        ["last7Days", t("last7Days")],
                        ["older", t("older")],
                      ]

                      const renderChatItem = (chat: any) => {
                        const isEditing = editingChatId === chat.id
                        const displayTitle = formatSidebarChatTitle(optimisticUpdates[chat.id] || chat.title)
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
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <SidebarMenuButton
                                        isActive={currentChat?.id === chat.id && pathname.startsWith('/chat')}
                                        aria-current={currentChat?.id === chat.id && pathname.startsWith('/chat') ? 'page' : undefined}
                                        onClick={() => !isEditing && handleChatClick(chat.id)}
                                        className={cn(
                                          "h-8 min-w-0 flex-1 justify-start py-0 pr-1 transition-all",
                                          "focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1",
                                        )}
                                      >
                                          <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <span className="text-sm flex-1 truncate">
                                              {displayTitle}
                                            </span>
                                            <span className="flex shrink-0 items-center gap-1 text-muted-foreground/55">
                                              {pinnedChatIds.includes(chat.id) && (
                                                <Pin className="h-3 w-3" aria-label="Chat fijado" />
                                              )}
                                              {chatFolders[chat.id] && (
                                                <Folder className="h-3 w-3" aria-label={`Carpeta ${chatFolders[chat.id]}`} />
                                              )}
                                              {scheduledChats[chat.id] && (
                                                <CalendarDays className="h-3 w-3" aria-label="Chat programado" />
                                              )}
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
                                        className="flex h-8 w-8 shrink-0 items-center justify-center p-0 opacity-100 md:opacity-0 transition-opacity md:group-hover:opacity-100"
                                        aria-label="Acciones del chat"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                      align="end"
                                      onClick={(e) => e.stopPropagation()}
                                      className="w-[268px] rounded-2xl p-1.5 shadow-xl"
                                    >
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          togglePinnedChat(chat)
                                        }}
                                        className="h-11 rounded-xl text-[15px]"
                                      >
                                        <Pin className="mr-3 h-5 w-5" />
                                        {pinnedChatIds.includes(chat.id) ? "Desfijar chat" : "Fijar chat"}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          handleEditClick(chat, event as any)
                                        }}
                                        className="h-11 rounded-xl text-[15px]"
                                      >
                                        <Edit2 className="mr-3 h-5 w-5" />
                                        Editar
                                      </DropdownMenuItem>
                                      <DropdownMenuSub>
                                        <DropdownMenuSubTrigger className="h-11 rounded-xl px-2 text-[15px]">
                                          <Folder className="mr-3 h-5 w-5" />
                                          Mover a carpeta
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuPortal>
                                          <DropdownMenuSubContent className="w-56 rounded-2xl p-1.5">
                                            {["Trabajo", "Proyecto", "Personal"].map((folder) => (
                                              <DropdownMenuItem
                                                key={folder}
                                                onSelect={(event) => {
                                                  event.preventDefault()
                                                  moveChatToFolder(chat, folder)
                                                }}
                                                className="h-10 rounded-xl"
                                              >
                                                <Folder className="mr-2 h-4 w-4" />
                                                {folder}
                                                {chatFolders[chat.id] === folder && <Check className="ml-auto h-4 w-4" />}
                                              </DropdownMenuItem>
                                            ))}
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                              onSelect={(event) => {
                                                event.preventDefault()
                                                createFolderAndMove(chat)
                                              }}
                                              className="h-10 rounded-xl"
                                            >
                                              <Plus className="mr-2 h-4 w-4" />
                                              Nueva carpeta...
                                            </DropdownMenuItem>
                                            {chatFolders[chat.id] && (
                                              <DropdownMenuItem
                                                onSelect={(event) => {
                                                  event.preventDefault()
                                                  moveChatToFolder(chat, null)
                                                }}
                                                className="h-10 rounded-xl"
                                              >
                                                <X className="mr-2 h-4 w-4" />
                                                Quitar de carpeta
                                              </DropdownMenuItem>
                                            )}
                                          </DropdownMenuSubContent>
                                        </DropdownMenuPortal>
                                      </DropdownMenuSub>
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          downloadChatExport(chat)
                                        }}
                                        className="h-11 rounded-xl text-[15px]"
                                      >
                                        <Download className="mr-3 h-5 w-5" />
                                        Descargar
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          openScheduleDialog(chat)
                                        }}
                                        className="h-11 rounded-xl text-[15px]"
                                      >
                                        <CalendarDays className="mr-3 h-5 w-5" />
                                        Programar
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          archiveChatLocally(chat)
                                        }}
                                        className="h-11 rounded-xl text-[15px]"
                                      >
                                        <Archive className="mr-3 h-5 w-5" />
                                        Archivar
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          hideChatLocally(chat)
                                        }}
                                        className="h-11 rounded-xl text-[15px]"
                                      >
                                        <EyeOff className="mr-3 h-5 w-5" />
                                        Ocultar
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onSelect={(event) => {
                                          event.preventDefault()
                                          const confirmed = window.confirm(`Eliminar "${displayTitle}"? Esta acción no se puede deshacer.`)
                                          if (confirmed) deleteChat(chat.id)
                                        }}
                                        className="h-11 rounded-xl text-[15px] text-red-600 focus:text-red-600"
                                      >
                                        <Trash2 className="mr-3 h-5 w-5" />
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

                      return (
                        <>
                          {pinnedChats.length > 0 && (
                            <React.Fragment key="pinned">
                              <div className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 select-none">
                                Fijados
                              </div>
                              {pinnedChats.map(renderChatItem)}
                            </React.Fragment>
                          )}
                          {groupDefs.map(([key, label]) => {
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
                          })}
                        </>
                      )
                    })()}

                    {/* Loading indicator at the bottom */}
                    {isLoadingMore && (
                      <SidebarMenuItem>
                        <div className="flex items-center justify-center py-3">
                          <ThinkingIndicator size="sm" className="mr-2" />
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
                    // Liquid-glass surface — CSS variables auto-switch per theme
                    "w-64 overflow-hidden rounded-2xl p-1.5",
                    "border border-border/50 bg-popover/75 backdrop-blur-2xl backdrop-saturate-150",
                    // Outer ambient shadow + inner top highlight
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

      <Dialog
        open={Boolean(scheduleTarget)}
        onOpenChange={(open) => {
          if (open) return
          setScheduleTarget(null)
          setScheduleAt("")
          setScheduleNote("")
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Programar chat</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {scheduleTarget?.title || "Selecciona una fecha y hora para este chat."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="schedule-chat-at">
                Fecha y hora
              </label>
              <Input
                id="schedule-chat-at"
                type="datetime-local"
                value={scheduleAt}
                onChange={(event) => setScheduleAt(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="schedule-chat-note">
                Nota opcional
              </label>
              <Textarea
                id="schedule-chat-note"
                value={scheduleNote}
                onChange={(event) => setScheduleNote(event.target.value)}
                placeholder="Agregar una indicación o recordatorio"
                className="min-h-24 resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setScheduleTarget(null)
                setScheduleAt("")
                setScheduleNote("")
              }}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={saveScheduledChat}>
              Programar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}
