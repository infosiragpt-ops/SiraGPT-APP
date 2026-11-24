"use client"

/* eslint-disable @next/next/no-img-element -- Renders arbitrary user/generated chat image thumbnail in forward dialog. */

import * as React from "react"
import { MessageSquare, MessageSquarePlus, Search, X } from "lucide-react"
import type { ChatImageActionPayload } from "@/lib/chat/image-actions"

export interface ForwardChatSummary {
  id: string
  title?: string
  updatedAt?: string
}

export function ImageForwardDialog({
  image,
  chats,
  currentChatId,
  onClose,
  onForwardToChat,
  onForwardToNewChat,
}: {
  image: ChatImageActionPayload | null
  chats: ForwardChatSummary[]
  currentChatId?: string | null
  onClose: () => void
  onForwardToChat: (chatId: string, image: ChatImageActionPayload) => void | Promise<void>
  onForwardToNewChat: (image: ChatImageActionPayload) => void | Promise<void>
}) {
  const [query, setQuery] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!image) return
    setQuery("")
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [image, onClose])

  if (!image) return null

  const normalizedQuery = query.trim().toLowerCase()
  const filteredChats = (Array.isArray(chats) ? chats : [])
    .filter((chat) => chat && chat.id && chat.id !== currentChatId)
    .filter((chat) => {
      if (!normalizedQuery) return true
      return String(chat.title || "Nuevo chat").toLowerCase().includes(normalizedQuery)
    })
    .slice(0, 20)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reenviar imagen a otro chat"
      data-testid="image-forward-dialog"
      className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src={image.url}
              alt={image.name}
              className="h-9 w-9 shrink-0 rounded-lg border border-zinc-200 object-cover dark:border-zinc-700"
            />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold leading-tight">Reenviar imagen</h3>
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{image.prompt || image.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar diálogo de reenvío"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={() => void onForwardToNewChat(image)}
            className="mb-2.5 flex w-full items-center gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50/80 px-3 py-2.5 text-left text-sm font-medium text-zinc-900 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0" />
            <span>Crear un nuevo chat con esta imagen</span>
          </button>

          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar conversación…"
              aria-label="Buscar conversación para reenviar"
              className="h-9 w-full rounded-xl border border-zinc-200 bg-white pl-8 pr-3 text-sm outline-none focus:border-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:focus:border-white"
            />
          </div>

          <div className="max-h-60 overflow-y-auto">
            {filteredChats.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
                No se encontraron otras conversaciones.
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filteredChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => void onForwardToChat(chat.id, image)}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-zinc-400" />
                    <span className="min-w-0 flex-1 truncate">{chat.title || "Conversación sin título"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
