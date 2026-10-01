"use client"

import * as React from "react"
import {
  Archive,
  ChevronDown,
  Clock,
  Copy,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  ScrollText,
  Trash2,
  X,
} from "lucide-react"
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
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { useChatList } from "@/lib/chat-context-integrated"
import { readChatFolders, requestChatAction, setComposerPrefill, skillFromChatPrompt } from "@/lib/chat/chat-actions"
import { removePinnedChatId, setChatPinned, usePinnedChats } from "@/lib/chat/pinned-chats"
import { startChatWithSkill } from "@/lib/chat/skills-events"
import { writeText as copyTextSafe } from "@/lib/native/clipboard"
import { cn } from "@/lib/utils"

export const NEW_CHAT_TITLE = "Nuevo chat"

/** The built-in skill that turns a conversation into a reusable skill. */
export const SKILL_CREATOR = {
  name: "skill-creator",
  title: "Creador de skills",
  description: "Crea una skill a partir de lo que hicimos en un chat",
  source: "catalog" as const,
}

const MENU_ITEM =
  "flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[13.5px] focus:bg-muted data-[highlighted]:bg-muted"
const MENU_ICON = "h-[18px] w-[18px] shrink-0 text-foreground/70"
const MENU_KEY = "ml-auto pl-6 text-[12px] font-normal tracking-normal text-muted-foreground/70"
const MENU_SEP = "my-1.5 bg-border/60"

export type ChatTitleMenuChat = {
  id: string
  title?: string | null
  isPinned?: boolean | null
}

/**
 * claude.ai-style chat title at the top-left of /agentes.
 *
 *  - Clicking the TITLE starts the inline rename: the field gets a thin,
 *    professional light-blue border and the text selected.
 *  - Clicking the CHEVRON opens the menu: Programar · Convertir en
 *    habilidad · Copiar ID de sesión · Fijar (P) · Cambiar nombre (R) ·
 *    Añadir al proyecto › · Archivar (A) · Eliminar (D).
 *
 * The single-key shortcuts only work while the menu is open — there are no
 * new global shortcuts. Folders, archive and schedule live in the sidebar;
 * the menu asks it to act (lib/chat/chat-actions).
 */
export function ChatTitleMenu({
  chat,
  className,
}: {
  chat: ChatTitleMenuChat | null | undefined
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
  const [folders, setFolders] = React.useState<{ folders: string[]; current: string | null }>({ folders: [], current: null })
  const inputRef = React.useRef<HTMLInputElement>(null)
  const renameFocusTimerRef = React.useRef<number | null>(null)
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

  const cancelRenameFocus = React.useCallback(() => {
    if (renameFocusTimerRef.current === null) return
    window.clearTimeout(renameFocusTimerRef.current)
    renameFocusTimerRef.current = null
  }, [])

  React.useEffect(() => {
    // A new chat resets any inline edit left open on the previous one.
    setEditing(false)
    setPinOverride(null)
    return cancelRenameFocus
  }, [chatId, cancelRenameFocus])

  const startRename = React.useCallback(() => {
    if (!chatId) return
    cancelRenameFocus()
    setDraft(title)
    setEditing(true)
    commitRef.current = "idle"
    renameFocusTimerRef.current = window.setTimeout(() => {
      renameFocusTimerRef.current = null
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)
  }, [chatId, title, cancelRenameFocus])

  const finishRename = React.useCallback(async (save: boolean) => {
    cancelRenameFocus()
    if (commitRef.current === "done") return
    commitRef.current = "done"
    setEditing(false)
    const next = draft.trim()
    if (!save || !chatId || !next || next === title) return
    const ok = await renameChat(chatId, next)
    if (ok) toast.success("Chat renombrado")
    else toast.error("No se pudo cambiar el nombre")
  }, [chatId, draft, renameChat, title, cancelRenameFocus])

  const togglePin = React.useCallback(async () => {
    if (!chatId) return
    const next = !isPinned
    setPinOverride({ id: chatId, pinned: next })
    toast.success(next ? "Chat fijado" : "Chat desfijado")
    const { synced } = await setChatPinned(chatId, next)
    if (!synced) toast.warning("Guardado en este dispositivo; no se pudo sincronizar con tu cuenta.")
  }, [chatId, isPinned])

  const copySessionId = React.useCallback(async () => {
    if (!chatId) return
    const ok = await copyTextSafe(chatId).then(() => true).catch(() => false)
    if (ok) toast.success("ID de sesión copiado")
    else toast.error("No se pudo copiar el ID")
  }, [chatId])

  const convertToSkill = React.useCallback(() => {
    if (!chatId) return
    setComposerPrefill(skillFromChatPrompt(title, chatId))
    startChatWithSkill(SKILL_CREATOR)
  }, [chatId, title])

  const schedule = React.useCallback(() => {
    if (!chatId) return
    requestChatAction({ action: "schedule", chatId, title })
  }, [chatId, title])

  const archive = React.useCallback(() => {
    if (!chatId) return
    requestChatAction({ action: "archive", chatId, title })
  }, [chatId, title])

  const moveToFolder = React.useCallback((folder: string | null) => {
    if (!chatId) return
    requestChatAction({ action: "folder", chatId, title, folder })
  }, [chatId, title])

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

  const onMenuOpenChange = (open: boolean) => {
    if (open) setFolders(readChatFolders(chatId))
    setMenuOpen(open)
  }

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
    else if (key === "a") run(archive)
    else if (key === "d") run(() => setPendingDelete(true))
  }

  if (editing && chatId) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Nombre del chat"
        maxLength={200}
        onPointerDown={cancelRenameFocus}
        onChange={(event) => {
          // Do not select over text entered before the deferred autofocus runs.
          cancelRenameFocus()
          setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          cancelRenameFocus()
          if (event.key === "Enter") {
            event.preventDefault()
            void finishRename(true)
          } else if (event.key === "Escape") {
            event.preventDefault()
            void finishRename(false)
          }
        }}
        onBlur={() => { void finishRename(true) }}
        data-testid="chat-title-rename-input"
        className={cn(
          // Thin, professional light-blue edge: the field is "ready to edit".
          "chat-title-input chat-title-input--celeste h-8 min-w-0 max-w-[48ch] flex-1 rounded-md bg-background px-2 text-[14px] font-medium text-foreground outline-none",
          className,
        )}
      />
    )
  }

  return (
    <>
      <div className={cn("chat-title-group inline-flex h-8 min-w-0 max-w-full items-center rounded-md", className)}>
        <button
          type="button"
          onClick={chatId ? startRename : undefined}
          disabled={!chatId}
          aria-label={chatId ? `Cambiar el nombre del chat: ${title}` : title}
          title={chatId ? "Clic para cambiar el nombre" : title}
          data-testid="chat-title-rename-trigger"
          className={cn(
            "chat-title-trigger inline-flex h-8 min-w-0 max-w-full items-center rounded-md px-1.5 text-left",
            "text-[14px] font-medium text-foreground transition-colors",
            "enabled:hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            "disabled:cursor-default disabled:text-foreground/80",
          )}
        >
          <span className="chat-title-text min-w-0 max-w-[48ch] truncate">{title}</span>
        </button>
        {chatId ? (
          <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`Acciones del chat: ${title}`}
                data-testid="chat-title-menu-trigger"
                className={cn(
                  "chat-title-chevron group/title inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md",
                  "text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  "data-[state=open]:bg-muted/70 data-[state=open]:text-foreground",
                )}
              >
                <ChevronDown
                  aria-hidden="true"
                  className="h-3.5 w-3.5 transition-transform group-data-[state=open]/title:rotate-180"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              onKeyDown={handleMenuKeyDown}
              className="chat-title-menu w-[248px] rounded-2xl border border-border/60 bg-popover p-1.5 shadow-xl"
            >
              <DropdownMenuItem onSelect={() => defer(schedule)} className={MENU_ITEM}>
                <Clock className={MENU_ICON} />
                Programar
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => defer(convertToSkill)} className={MENU_ITEM}>
                <ScrollText className={MENU_ICON} />
                Convertir en habilidad
              </DropdownMenuItem>
              <DropdownMenuSeparator className={MENU_SEP} />
              <DropdownMenuItem onSelect={() => { void copySessionId() }} className={MENU_ITEM}>
                <Copy className={MENU_ICON} />
                Copiar ID de sesión
              </DropdownMenuItem>
              <DropdownMenuSeparator className={MENU_SEP} />
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={cn(MENU_ITEM, "[&>svg:last-child]:ml-auto [&>svg:last-child]:text-muted-foreground/70")}>
                  <FolderPlus className={MENU_ICON} />
                  Añadir al proyecto
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent
                    sideOffset={6}
                    className="chat-title-menu w-56 rounded-2xl border border-border/60 bg-popover p-1.5 shadow-xl"
                  >
                    {folders.folders.length === 0 ? (
                      <div className="px-2.5 py-2 text-[12.5px] text-muted-foreground">
                        Crea una carpeta con + en la barra lateral.
                      </div>
                    ) : (
                      folders.folders.map((folder) => (
                        <DropdownMenuItem
                          key={folder}
                          onSelect={() => moveToFolder(folder)}
                          className={cn(MENU_ITEM, folders.current === folder && "font-medium")}
                          data-testid={`chat-title-folder-${folder}`}
                        >
                          <span className="truncate">{folder}</span>
                          {folders.current === folder ? (
                            <span className="ml-auto text-[11px] text-muted-foreground/70">Actual</span>
                          ) : null}
                        </DropdownMenuItem>
                      ))
                    )}
                    {folders.current ? (
                      <>
                        <DropdownMenuSeparator className={MENU_SEP} />
                        <DropdownMenuItem onSelect={() => moveToFolder(null)} className={MENU_ITEM}>
                          <X className={MENU_ICON} />
                          Quitar del proyecto
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator className={MENU_SEP} />
              <DropdownMenuItem onSelect={() => defer(archive)} className={MENU_ITEM}>
                <Archive className={MENU_ICON} />
                Archivar
                <DropdownMenuShortcut className={MENU_KEY}>A</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => defer(() => setPendingDelete(true))}
                className={cn(
                  MENU_ITEM,
                  "text-red-600 focus:bg-red-500/10 focus:text-red-700 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-700 dark:text-red-400 dark:focus:text-red-300 dark:data-[highlighted]:text-red-300",
                )}
              >
                <Trash2 className="h-[18px] w-[18px] shrink-0" />
                Eliminar
                <DropdownMenuShortcut className={cn(MENU_KEY, "text-red-600/60 dark:text-red-400/60")}>D</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

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
