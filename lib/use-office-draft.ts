"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiClient } from "./api"
import { useChat } from "./chat-context-integrated"
import { createOfficeDraftQueue, type OfficeSaveStatus } from "./office-draft-queue"
import { toast } from "sonner"

/** Autosave only the native editor's draft, never reconstruct an uploaded Office file. */
export function useOfficeDraft(kind: "word" | "excel") {
  const { currentChat, setCurrentChat } = useChat()
  const [status, setStatus] = useState<OfficeSaveStatus>("saved")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef(true)
  const chatId = currentChat?.id
  const activeChatId = useRef(chatId)
  activeChatId.current = chatId
  const queueEpoch = useRef(0)
  const field = kind === "word" ? "wordContent" : "excelContent"
  const queue = useMemo(() => {
    const epoch = ++queueEpoch.current
    const isCurrent = () => active.current && activeChatId.current === chatId && queueEpoch.current === epoch
    return createOfficeDraftQueue<unknown>({
    initial: currentChat?.[field] ?? null,
    persist: async (value, previous) => {
      if (!chatId) throw new Error("No chat")
      await apiClient.saveOfficeDraft(chatId, kind, value, previous)
    },
    onStatus: (value) => { if (isCurrent()) setStatus(value) },
    onSaved: (value) => setCurrentChat((chat) => isCurrent() && chat && chat.id === chatId ? { ...chat, [field]: value } : chat),
    })
    // A queue belongs to a chat. New keystrokes/context updates must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, kind])

  useEffect(() => { queue.sync(currentChat?.[field] ?? null) }, [queue, currentChat, field])

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    const ok = await queue.flush()
    if (!ok) toast.error("No se guardaron los cambios. Conserva abierto el editor y vuelve a guardar; si editaste desde otra ventana, descarga tu copia antes de recargar.")
    return ok
  }, [queue])

  const change = useCallback((value: unknown) => {
    queue.change(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void save() }, 700)
  }, [queue, save])

  useEffect(() => {
    active.current = true
    setStatus("saved")
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.dirty) { event.preventDefault(); event.returnValue = "" }
    }
    window.addEventListener("beforeunload", warn)
    return () => {
      active.current = false
      window.removeEventListener("beforeunload", warn)
      if (timer.current) clearTimeout(timer.current)
      // The closure retains the old chat ID when navigation detaches the editor.
      void queue.flush().then((ok) => { if (!ok) toast.error("Hay cambios del documento que no pudieron guardarse.") })
    }
  }, [queue])

  return { change, save, status, label: { saved: "Guardado", unsaved: "Cambios pendientes", saving: "Guardando…", error: "No guardado" }[status] }
}
