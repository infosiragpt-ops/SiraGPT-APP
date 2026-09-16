"use client"

import { useCallback, useEffect, useRef } from "react"
import { apiClient, type DocumentEditStreamEvent } from "./api"
import type { useChat } from "./chat-context-integrated"
import { collectUploadFileIds, snapshotComposerFilesForMessage } from "./chat/composer-files"
import { readComposerPermission } from "./chat/composer-session"
import { safeUUID } from "./safe-uuid"
import { DOCUMENT_EDIT_STOPPED, advanceDocumentEditSteps, documentEditTaskState, failDocumentEditSteps } from "./document-editor-progress"

type Context = ReturnType<typeof useChat>
type Chat = NonNullable<Context["currentChat"]>
interface Options {
  currentChat: Context["currentChat"]; userId: string | null
  selectedModel: string; selectProvider: string
  setCurrentChat: Context["setCurrentChat"]; selectChat: Context["selectChat"]
  markBusy: (chatId: string, controller?: AbortController) => void
  markIdle: (chatId: string, controller?: AbortController) => void
  notify: (message: string) => void
}
interface Run { chatId: string; streamId: string; controller: AbortController }

/**
 * /agentes document editor: the picked model edits the attached (or latest)
 * document on the server; this adapter only renders progress in the chat
 * bubble. The server persists the turn, so navigating away never loses it and
 * only Stop cancels it.
 */
export function useDocumentEditorChat(options: Options) {
  const { userId } = options
  const latest = useRef(options); latest.current = options
  const runs = useRef(new Map<string, Run>())

  const updateMessage = useCallback((chatId: string, messageId: string, patch: Record<string, unknown>) => {
    latest.current.setCurrentChat((chat) => chat?.id === chatId
      ? { ...chat, messages: chat.messages.map((message) => message.id === messageId ? { ...message, ...patch } : message) }
      : chat)
  }, [])

  const start = useCallback(async (prompt: string, attachments: readonly unknown[], idempotencyKey: string, signal?: AbortSignal,
    onChatReady?: (chatId: string) => void): Promise<boolean> => {
    const context = latest.current
    let chat: Chat | null = context.currentChat
    if (chat && runs.current.has(chat.id)) throw new Error("Ya hay una edición de documento en curso en esta conversación.")
    if (!chat || chat.id.startsWith("temp-chat-")) {
      const response = await apiClient.createChat({ title: prompt.slice(0, 30), model: context.selectedModel })
      chat = response.chat as Chat
      if (!chat?.id) throw new Error("No se pudo crear la conversación para editar el documento.")
      signal?.throwIfAborted()
      onChatReady?.(chat.id)
      await context.selectChat(chat.id)
    }
    signal?.throwIfAborted()
    const chatId = chat.id
    const now = Date.now()
    const userMessage = { id: `msg-user-doc-${now}`, chatId, role: "USER" as const, content: prompt,
      timestamp: new Date().toISOString(), files: snapshotComposerFilesForMessage([...attachments]) }
    let steps = advanceDocumentEditSteps([], "Preparando la edición")
    const assistantMessage = { id: `msg-ai-doc-${now}`, chatId, role: "ASSISTANT" as const, content: documentEditTaskState(steps, false),
      timestamp: new Date().toISOString() }
    latest.current.setCurrentChat((current) => current?.id === chatId
      ? { ...current, messages: [...(current.messages || []), userMessage, assistantMessage] }
      : current)

    const run: Run = { chatId, streamId: safeUUID(), controller: new AbortController() }
    runs.current.set(chatId, run)
    latest.current.markBusy(chatId, run.controller)
    let started = false
    let finished = false
    const settle = (content: string, files?: unknown[]) => {
      finished = true
      updateMessage(chatId, assistantMessage.id, { content, ...(files && files.length ? { files } : {}) })
    }
    try {
      await apiClient.editDocumentStream({
        prompt, chatId, fileIds: collectUploadFileIds([...attachments]), model: context.selectedModel,
        provider: context.selectProvider, streamId: run.streamId, idempotencyKey, permission: readComposerPermission(),
      }, (event: DocumentEditStreamEvent) => {
        if (event.type === "start") { started = true; return }
        if (event.type === "stage") {
          steps = advanceDocumentEditSteps(steps, event.label, event.detail)
          updateMessage(chatId, assistantMessage.id, { content: documentEditTaskState(steps, false) })
          return
        }
        if (event.type === "done") {
          settle(event.content, event.files)
          if (!event.ok && event.code !== "CANCELLED") latest.current.notify(event.content)
        }
      }, run.controller.signal)
      if (!finished) throw new Error("Se perdió la conexión con la edición. Abre de nuevo la conversación para ver el resultado.")
    } catch (error) {
      if (run.controller.signal.aborted) {
        if (!finished) settle(DOCUMENT_EDIT_STOPPED)
      } else if (!started) {
        // Rejected before the server accepted the edit (permission, plan,
        // connection): drop the optimistic turn so the composer keeps the draft.
        latest.current.setCurrentChat((current) => current?.id === chatId
          ? { ...current, messages: current.messages.filter((message) => message.id !== userMessage.id && message.id !== assistantMessage.id) }
          : current)
        throw error
      } else if (!finished) {
        const message = error instanceof Error && error.message ? error.message : "No se pudo completar la edición del documento."
        steps = failDocumentEditSteps(steps)
        settle(documentEditTaskState(steps, true, message))
        latest.current.notify(message)
      }
    } finally {
      if (runs.current.get(chatId) === run) runs.current.delete(chatId)
      latest.current.markIdle(chatId, run.controller)
    }
    // Replace optimistic ids with the persisted turn when it is still on screen.
    if (latest.current.currentChat?.id === chatId) void latest.current.selectChat(chatId)
    return true
  }, [updateMessage])

  const stop = useCallback((chatId: string | null): boolean => {
    const run = chatId ? runs.current.get(chatId) : null
    if (!run) return false
    run.controller.abort()
    void apiClient.stopAIStream(run.streamId, run.chatId).catch(() => {})
    return true
  }, [])

  useEffect(() => {
    const active = runs.current
    return () => {
      // Unmount detaches the local reader only; the server keeps the edit and persists it.
      active.forEach((run) => latest.current.markIdle(run.chatId, run.controller))
      active.clear()
    }
  }, [userId])

  return { start, stop }
}
