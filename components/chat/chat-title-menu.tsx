"use client"

import * as React from "react"
import { ChevronDown, Pencil, Pin, PinOff, Share, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { useChatList } from "@/lib/chat-context-integrated"
import { removePinnedChatId, setChatPinned, usePinnedChats } from "@/lib/chat/pinned-chats"
import { cn } from "@/lib/utils"

export const NEW_CHAT_TITLE = "Nuevo chat"

const MENU_ITEM =
  "flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13.5px] focus:bg-muted data-[highlighted]:bg-muted"
const MENU_ICON = "h-4 w-4 shrink-0 text-muted-foreground"
const MENU_KEY = "ml-auto pl-6 text-[12px] font-normal tracking-normal text-muted-foreground/70"

export type ChatTitleMenuChat = {
  id: string
  title?: string | null
  isPinned?: boolean | null
}

/**
 * claude.ai-style chat title at the top-left of /agentes: the title itself
 * is the trigger of a small menu (Fijar · Cambiar nombre · Compartir chat ·
 * Eliminar). The single-key shortcuts shown in the menu only work while the
 * menu is open — there are no new global shortcuts.
 */
export function ChatTitleMenu({
  chat,
  onShare,
  className,
}: {
  chat: ChatTitleMenuChat | null | undefined
  onShare?: () => void
  className?: string
}) {
  const { renameChat, deleteChat } = useChatList()
  const pinnedIds = usePinnedChats()
  const [pinOverride, setPinOverride] = React.useState<{ id: string; pinned: boolean } | null>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [pendingDelete, setPendingDelete] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  // Blur after Enter/Escape must not save twice.
  const commitRef = React.useRef<"idle" | "done">("idle")

  const chatId = chat?.id || null
  const title = (chat?.title || "").trim() || NEW_CHAT_TITLE
  const isPinned = chatId
    ? pinOverride?.id === chatId
      ? pinOverride.pinned
      : Boolean(chat?.isPinned) || pinnedIds.includes(chatId)
    : false

  React.useEffect(() => {
    // A new chat resets any inline edit left open on the previous one.
    setEditing(false)
    setPinOverride(null)
  }, [chatId])

  const startRename = React.useCallback(() => {
    if (!chatId) return
    setDraft(title)
    setEditing(true)
    commitRef.current = "idle"
    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)
  }, [chatId, title])

  const finishRename = React.useCallback(async (save: boolean) => {
    if (commitRef.current === "done") return
    commitRef.current = "done"
    setEditing(false)
    const next = draft.trim()
    if (!save || !chatId || !next || next === title) return
    const ok = await renameChat(chatId, next)
    if (ok) toast.success("Chat renombrado")
    else toast.error("No se pudo cambiar el nombre")
  }, [chatId, draft, renameChat, title])

  const togglePin = React.useCallback(async () => {
    if (!chatId) return
    const next = !isPinned
    setPinOverride({ id: chatId, pinned: next })
    toast.success(next ? "Chat fijado" : "Chat desfijado")
    const { synced } = await setChatPinned(chatId, next)
    if (!synced) toast.warning("Guardado en este dispositivo; no se pudo sincronizar con tu cuenta.")
  }, [chatId, isPinned])

  const confirmDelete = React.useCallback(async () => {
    if (!chatId || deleting) return
    setDeleting(true)
    try {
      const ok = await deleteChat(chatId)
      if (!ok) {
        toast.error("No se pudo eliminar el chat")
        return
      }
      removePinnedChatId(chatId)
      setPendingDelete(false)
      toast.success("Chat eliminado")
    } catch {
      toast.error("No se pudo eliminar el chat")
    } finally {
      setDeleting(false)
    }
  }, [chatId, deleteChat, deleting])

  // Radix closes the menu on select before the deferred action runs, so the
  // inline input / dialog never fights the menu for focus.
  const defer = (action: () => void) => window.setTimeout(action, 0)

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    const run = (action: () => void) => {
      event.preventDefault()
      setMenuOpen(false)
      defer(action)
    }
    if (key === "p") run(() => { void togglePin() })
    else if (key === "r") run(startRename)
    else if (key === "d") run(() => setPendingDelete(true))
  }

  if (editing && chatId) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Nombre del chat"
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            void finishRename(true)
          } else if (event.key === "Escape") {
            event.preventDefault()
            void finishRename(false)
          }
        }}
        onBlur={() => { void finishRename(true) }}
        className={cn(
          "chat-title-input h-8 min-w-0 max-w-[48ch] flex-1 rounded-md border border-border/70 bg-background px-2 text-[14px] font-medium text-foreground outline-none",
          "focus-visible:border-foreground/40",
          className,
        )}
      />
    )
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild disabled={!chatId}>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={chatId ? `Acciones del chat: ${title}` : title}
            title={title}
            data-testid="chat-title-menu-trigger"
            className={cn(
              "chat-title-trigger group/title inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-left",
              "text-[14px] font-medium text-foreground transition-colors",
              "enabled:hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "disabled:cursor-default disabled:text-foreground/80",
              className,
            )}
          >
            <span className="chat-title-text min-w-0 max-w-[48ch] truncate">{title}</span>
            {chatId ? (
              <ChevronDown
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/title:rotate-180"
              />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          onKeyDown={handleMenuKeyDown}
          className="chat-title-menu w-60 rounded-xl border border-border/60 bg-popover p-1.5 shadow-lg"
        >
          <DropdownMenuItem onSelect={() => { void togglePin() }} className={MENU_ITEM}>
            {isPinned ? <PinOff className={MENU_ICON} /> : <Pin className={MENU_ICON} />}
            {isPinned ? "Desfijar" : "Fijar"}
            <DropdownMenuShortcut className={MENU_KEY}>P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => defer(startRename)} className={MENU_ITEM}>
            <Pencil className={MENU_ICON} />
            Cambiar nombre
            <DropdownMenuShortcut className={MENU_KEY}>R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onShare?.()} disabled={!onShare} className={MENU_ITEM}>
            <Share className={MENU_ICON} />
            Compartir chat
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-1 bg-border/60" />
          <DropdownMenuItem
            onSelect={() => defer(() => setPendingDelete(true))}
            className={cn(
              MENU_ITEM,
              "text-red-600 focus:bg-red-500/10 focus:text-red-700 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-700 dark:text-red-400 dark:focus:text-red-300 dark:data-[highlighted]:text-red-300",
            )}
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            Eliminar
            <DropdownMenuShortcut className={cn(MENU_KEY, "text-red-600/60 dark:text-red-400/60")}>D</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar chat</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Seguro que quieres eliminar <span className="font-medium text-foreground">“{title}”</span>?
              Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500/50"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deleting ? (
                <>
                  <ThinkingIndicator size="sm" className="mr-2" />
                  Eliminando
                </>
              ) : (
                "Eliminar"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default ChatTitleMenu
