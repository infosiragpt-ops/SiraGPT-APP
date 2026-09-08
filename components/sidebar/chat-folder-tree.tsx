"use client"

import * as React from "react"
import {
  Folder,
  FolderOpen,
  MessageCircle,
  MoreHorizontal,
  PenSquare,
  Pin,
  Send,
  Settings,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface ChatFolderTreeProps {
  folders: {
    name: string
    isPinned: boolean
    description?: string
    location?: string
  }[]
  expandedFolders: string[]
  activeFolder: string | null
  onToggleExpand: (name: string) => void
  onTogglePin: (name: string) => void
  onEdit: (name: string) => void
  onNewChat: (name: string) => void
  onSendChat: (name: string) => void
  onDelete: (name: string) => void
  onDrop: (event: React.DragEvent, name: string) => void
  renderChats: (name: string) => React.ReactNode
  getChatCount: (name: string) => number
}

type ChatFolderRowProps = Omit<
  ChatFolderTreeProps,
  "folders" | "expandedFolders" | "activeFolder"
> & {
  folder: ChatFolderTreeProps["folders"][number]
  expanded: boolean
  active: boolean
  compactMenu: boolean
}

const actionClassName =
  "h-7 w-7 shrink-0 rounded-md p-0 text-zinc-500 hover:bg-zinc-950/[0.06] hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-ring dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"

const menuActionClassName =
  "h-10 w-full justify-start gap-2.5 rounded-lg px-2.5 text-sm font-normal text-zinc-800 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring dark:text-zinc-100 dark:hover:bg-white/[0.08]"

function ChatFolderRow({
  folder,
  expanded,
  active,
  compactMenu,
  onToggleExpand,
  onTogglePin,
  onEdit,
  onNewChat,
  onSendChat,
  onDelete,
  onDrop,
  renderChats,
  getChatCount,
}: ChatFolderRowProps) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const dragDepth = React.useRef(0)
  const panelId = React.useId()
  const triggerId = React.useId()
  const summaryId = React.useId()
  const count = getChatCount(folder.name)
  const FolderIcon = expanded ? FolderOpen : Folder

  const runAction = (action: (name: string) => void) => {
    setMenuOpen(false)
    action(folder.name)
  }

  return (
    <li className="min-w-0 list-none">
      <div
        className={cn(
          "group/folder flex min-h-9 min-w-0 items-center gap-0.5 rounded-xl px-1.5 text-sm text-zinc-800 transition-colors",
          "hover:bg-zinc-950/[0.055] focus-within:bg-zinc-950/[0.055] dark:text-zinc-200 dark:hover:bg-white/[0.07] dark:focus-within:bg-white/[0.07]",
          (active || menuOpen) && "bg-zinc-950/[0.07] dark:bg-white/[0.09]",
          dragOver && "bg-zinc-950/[0.09] ring-2 ring-inset ring-ring dark:bg-white/[0.12]",
        )}
        onDragEnter={(event) => {
          event.preventDefault()
          dragDepth.current += 1
          setDragOver(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragOver(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          dragDepth.current = 0
          setDragOver(false)
          onDrop(event, folder.name)
        }}
      >
        <button
          id={triggerId}
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${expanded ? "Contraer" : "Expandir"} carpeta ${folder.name}`}
          title={folder.name}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onToggleExpand(folder.name)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" && !expanded) {
              event.preventDefault()
              onToggleExpand(folder.name)
            } else if (event.key === "ArrowLeft" && expanded) {
              event.preventDefault()
              onToggleExpand(folder.name)
            }
          }}
        >
          <FolderIcon className="h-[18px] w-[18px] shrink-0 stroke-[1.7]" aria-hidden="true" />
          <span className="truncate font-normal">{folder.name}</span>
          {folder.isPinned && (
            <Pin className="h-3 w-3 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
          )}
        </button>

        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover/folder:opacity-100 md:group-focus-within/folder:opacity-100",
            (active || menuOpen) && "md:opacity-100",
          )}
        >
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={actionClassName}
                aria-label={`Opciones de la carpeta ${folder.name}`}
                title="Opciones de la carpeta"
              >
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side={compactMenu ? "bottom" : "right"}
              align={compactMenu ? "end" : "start"}
              sideOffset={10}
              collisionPadding={12}
              avoidCollisions
              aria-labelledby={summaryId}
              style={{
                maxWidth: "min(calc(100vw - 24px), var(--radix-popover-content-available-width, calc(100vw - 24px)))",
                maxHeight: "var(--radix-popover-content-available-height, calc(100dvh - 24px))",
              }}
              className="w-72 overflow-y-auto rounded-2xl border border-zinc-200/90 bg-white p-1.5 text-zinc-900 shadow-[0_12px_40px_rgba(0,0,0,0.13)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:shadow-[0_12px_40px_rgba(0,0,0,0.4)]"
            >
              <div className="flex min-w-0 items-center gap-2.5 px-2.5 pb-1 pt-1.5">
                <Folder className="h-[18px] w-[18px] shrink-0 stroke-[1.7]" aria-hidden="true" />
                <span id={summaryId} className="min-w-0 flex-1 truncate text-sm font-medium" title={folder.name}>
                  {folder.name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={actionClassName}
                  aria-label={`${folder.isPinned ? "Desfijar" : "Fijar"} carpeta ${folder.name}`}
                  aria-pressed={folder.isPinned}
                  title={folder.isPinned ? "Desfijar carpeta" : "Fijar carpeta"}
                  onClick={() => onTogglePin(folder.name)}
                >
                  <Pin className={cn("h-[18px] w-[18px] stroke-[1.7]", folder.isPinned && "fill-current")} aria-hidden="true" />
                </Button>
              </div>
              <div className="flex items-center gap-2.5 px-2.5 py-2 text-sm">
                <MessageCircle className="h-[18px] w-[18px] shrink-0 stroke-[1.7] text-zinc-400" aria-hidden="true" />
                <span>{count} {count === 1 ? "tarea" : "tareas"}</span>
              </div>
              {folder.description?.trim() && (
                <p className="break-words px-2.5 pb-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {folder.description}
                </p>
              )}
              <div className="mx-0.5 my-1 h-px bg-zinc-200/80 dark:bg-zinc-700/80" role="separator" />
              <div className="flex min-w-0 items-center gap-2.5 px-2.5 py-2.5 text-sm">
                <Folder className="h-[18px] w-[18px] shrink-0 stroke-[1.7] text-zinc-400" aria-hidden="true" />
                <span className="truncate" title={folder.location?.trim() || "Carpeta de conversaciones"}>
                  {folder.location?.trim() || "Carpeta de conversaciones"}
                </span>
              </div>
              <div className="mx-0.5 my-1 h-px bg-zinc-200/80 dark:bg-zinc-700/80" role="separator" />
              <Button type="button" variant="ghost" className={menuActionClassName} onClick={() => runAction(onEdit)}>
                <Settings className="h-[18px] w-[18px] shrink-0 stroke-[1.7] text-zinc-400" aria-hidden="true" />
                Editar proyecto
              </Button>
              <Button type="button" variant="ghost" className={menuActionClassName} onClick={() => runAction(onSendChat)}>
                <Send className="h-[18px] w-[18px] shrink-0 stroke-[1.7] text-zinc-400" aria-hidden="true" />
                Agregar conversación
              </Button>
              <div className="mx-0.5 my-1 h-px bg-zinc-200/80 dark:bg-zinc-700/80" role="separator" />
              <Button
                type="button"
                variant="ghost"
                className={cn(menuActionClassName, "text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300")}
                onClick={() => runAction(onDelete)}
              >
                <Trash2 className="h-[18px] w-[18px] shrink-0 stroke-[1.7]" aria-hidden="true" />
                Eliminar carpeta
              </Button>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={actionClassName}
            aria-label={`Nuevo chat en ${folder.name}`}
            title="Nuevo chat en esta carpeta"
            onClick={() => onNewChat(folder.name)}
          >
            <PenSquare className="h-[18px] w-[18px] stroke-[1.7]" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div id={panelId} hidden={!expanded}>
        {expanded && (
          count > 0 ? (
            <ul aria-label={`Conversaciones en ${folder.name}`} className="ml-8 mt-0.5 flex min-w-0 flex-col gap-0.5 pb-1">
              {renderChats(folder.name)}
            </ul>
          ) : (
            <p className="mb-1 ml-[38px] py-2 text-sm text-zinc-400 dark:text-zinc-500">Sin chats</p>
          )
        )}
      </div>
    </li>
  )
}

export function ChatFolderTree({ folders, expandedFolders, activeFolder, ...props }: ChatFolderTreeProps) {
  const [compactMenu, setCompactMenu] = React.useState(true)

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const viewport = window.matchMedia("(max-width: 767px)")
    const updatePlacement = () => setCompactMenu(viewport.matches)
    updatePlacement()
    viewport.addEventListener("change", updatePlacement)
    return () => viewport.removeEventListener("change", updatePlacement)
  }, [])

  return (
    <ul className="flex min-w-0 flex-col gap-1" aria-label="Carpetas de conversaciones">
      {folders.map((folder) => (
        <ChatFolderRow
          key={folder.name}
          folder={folder}
          expanded={expandedFolders.includes(folder.name)}
          active={activeFolder === folder.name}
          compactMenu={compactMenu}
          {...props}
        />
      ))}
    </ul>
  )
}
