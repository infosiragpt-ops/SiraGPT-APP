"use client"

import { useCallback, useEffect, useRef } from "react"
import { apiClient } from "./api"
import type { useChat } from "./chat-context-integrated"
import { collectUploadFileIds, snapshotComposerFilesForMessage } from "./chat/composer-files"
import { documentSandboxClient, documentJobState, DocumentSandboxClientError, parseDocumentJobPointer,
  serializeDocumentJobState, type DocumentJobPointer, type DocumentJobSnapshot } from "./document-sandbox-client"
import type { AgentTaskState } from "./agent-task-service"

type Context = ReturnType<typeof useChat>
type Chat = NonNullable<Context["currentChat"]>
interface Options {
  currentChat: Context["currentChat"]; userId: string | null; selectedModel: string
  setCurrentChat: Context["setCurrentChat"]; selectChat: Context["selectChat"]
  markBusy: (chatId: string, controller?: AbortController) => void
  markIdle: (chatId: string, controller?: AbortController) => void
  notify: (message: string) => void
}
interface Run {
  chatId: string; messageId: string; pointer: DocumentJobPointer; controller: AbortController
  observing: boolean; suspended: boolean; cancelRequested: boolean; cancelling: boolean; snapshot?: DocumentJobSnapshot; content?: string
}

/** Transport-only adapter: reuses the existing chat bubble, thinking, Stop and artifact cards. */
export function useDocumentSandboxChat(options: Options) {
  const { currentChat, userId, markBusy } = options
  const latest = useRef(options); latest.current = options
  const runs = useRef(new Map<string, Run>())
  const hydrated = useRef(new Map<string, string>())
  const starting = useRef(new Set<string>())
  const epoch = useRef(0)
  const visibleChat = useRef<string | null>(null)

  const update = useCallback((run: Run, state: AgentTaskState) => {
    if (run.controller.signal.aborted) return
    const content = serializeDocumentJobState(state)
    run.content = content
    latest.current.setCurrentChat((chat) => chat?.id === run.chatId
      ? { ...chat, messages: chat.messages.map((message) => message.id === run.messageId ? { ...message, content } : message) }
      : chat)
  }, [])
  const settle = useCallback((run: Run, snapshot: DocumentJobSnapshot) => {
    if (run.controller.signal.aborted) return
    run.snapshot = snapshot
    update(run, documentJobState(snapshot))
    if (["done", "failed", "cancelled"].includes(snapshot.status)) {
      hydrated.current.set(run.messageId, serializeDocumentJobState(documentJobState(snapshot)))
      if (runs.current.get(run.chatId) === run) runs.current.delete(run.chatId)
      latest.current.markIdle(run.chatId, run.controller)
      run.controller.abort()
    }
  }, [update])
  const showError = useCallback((run: Run, error: unknown, notify = true) => {
    if (run.controller.signal.aborted) return
    const text = error instanceof DocumentSandboxClientError ? error.message : new DocumentSandboxClientError("E_CONNECTION").message
    // Close the local thinking indicator, not the durable server job. A later
    // navigation can recover an uncertain job; rerenders must not retry it.
    run.suspended = true
    const state: AgentTaskState = { ...documentJobState(run.snapshot, "Estado sin confirmar"), done: true, error: text, finalText: text, artifacts: [] }
    state.steps = state.steps.map((step) => ({ ...step, status: "error" }))
    const admissionAbsent = error instanceof DocumentSandboxClientError &&
      (error.admissionRejected || ["E_NOT_FOUND", "E_ADMISSION_NOT_FOUND"].includes(error.code))
    if (admissionAbsent) {
      hydrated.current.set(run.messageId, serializeDocumentJobState(state))
      if (runs.current.get(run.chatId) === run) runs.current.delete(run.chatId)
    }
    update(run, state)
    latest.current.markIdle(run.chatId, run.controller)
    if (notify) latest.current.notify(text)
    if (admissionAbsent) run.controller.abort()
  }, [update])
  const cancelRun = useCallback(async (run: Run) => {
    run.cancelRequested = true
    if (run.cancelling) return
    run.cancelling = true
    run.suspended = false
    latest.current.markBusy(run.chatId, run.controller)
    update(run, documentJobState(run.snapshot, "Solicitando cancelación"))
    try {
      const snapshot = await documentSandboxClient.cancel(run.pointer, run.controller.signal)
      settle(run, snapshot)
    } catch (error) { showError(run, error) }
    finally { run.cancelling = false }
  }, [settle, showError, update])
  const observe = useCallback(async (run: Run, initial?: DocumentJobSnapshot) => {
    if (run.controller.signal.aborted) return
    run.observing = true
    run.suspended = false
    try {
      const snapshot = initial || await documentSandboxClient.recover(run.pointer, run.controller.signal)
      settle(run, snapshot)
      if (run.controller.signal.aborted) return
      if (run.cancelRequested) await cancelRun(run)
      if (run.controller.signal.aborted) return
      await documentSandboxClient.observe(snapshot.id, (value) => settle(run, value), run.controller.signal)
    } catch (error) { showError(run, error) }
    finally { run.observing = false }
  }, [cancelRun, settle, showError])

  const start = useCallback(async (prompt: string, attachments: readonly unknown[], idempotencyKey: string, signal?: AbortSignal): Promise<boolean> => {
    const context = latest.current
    const startEpoch = epoch.current
    const startKey = `${startEpoch}:${context.userId}:${context.currentChat?.id || "new"}`
    if (starting.current.has(startKey)) throw new DocumentSandboxClientError("E_CONFLICT")
    starting.current.add(startKey)
    let admittedChatKey = startKey
    try {
    const guard = () => {
      signal?.throwIfAborted()
      if (epoch.current !== startEpoch || latest.current.userId !== context.userId) throw new DocumentSandboxClientError("E_CANCELLED")
    }
    // Match the selected model before any job, persistent pointer or paid request.
    const form = await documentSandboxClient.prepare(prompt, attachments, context.selectedModel, signal)
    guard()
    if (latest.current.currentChat?.id !== context.currentChat?.id) throw new DocumentSandboxClientError("E_CANCELLED")
    let chat: Chat | null = context.currentChat
    if (!chat || chat.id.startsWith("temp-chat-")) {
      const response = await apiClient.createChat({ title: prompt.slice(0, 30), model: context.selectedModel })
      chat = response.chat as Chat
      if (!chat?.id) throw new DocumentSandboxClientError("E_CONNECTION")
      guard()
      await context.selectChat(chat.id)
    }
    guard()
    if (runs.current.has(chat.id)) throw new DocumentSandboxClientError("E_CONFLICT")
    const chatId = chat.id
    admittedChatKey = `${startEpoch}:${context.userId}:${chatId}`
    starting.current.add(admittedChatKey)
    const pointer: DocumentJobPointer = { version: 1, idempotencyKey: `doc-${idempotencyKey}` }
    const user = await apiClient.addMessage(chatId, { role: "USER", content: prompt,
      files: collectUploadFileIds([...attachments]), idempotencyKey: `${idempotencyKey}.doc-user` })
    guard()
    const assistant = await apiClient.addMessage(chatId, { role: "ASSISTANT", content: serializeDocumentJobState(documentJobState()),
      metadata: { source: "doc-sandbox", docSandbox: pointer }, idempotencyKey: `${idempotencyKey}.doc-assistant` })
    if (typeof assistant?.message?.id !== "string") throw new DocumentSandboxClientError("E_CONNECTION")
    guard()
    const run: Run = { chatId, messageId: assistant.message.id, pointer, controller: new AbortController(),
      observing: true, suspended: false, cancelRequested: false, cancelling: false }
    runs.current.set(chatId, run)
    context.markBusy(chatId, run.controller)
    context.setCurrentChat((current) => {
      if (current?.id !== chatId) return current
      const added = [user.message && { ...user.message, files: snapshotComposerFilesForMessage([...attachments]) }, assistant.message].filter(Boolean)
      const ids = new Set(added.map((message) => message.id))
      return { ...current, messages: [...current.messages.filter((message) => !ids.has(message.id)), ...added] }
    })
    try {
      const submitted = await documentSandboxClient.submit(form, pointer, run.controller.signal)
      await observe(run, submitted)
    } catch (error) {
      run.observing = false
      const admissionRejected = error instanceof DocumentSandboxClientError &&
        (error.admissionRejected || ["E_NOT_FOUND", "E_ADMISSION_NOT_FOUND"].includes(error.code))
      showError(run, error, !admissionRejected)
      // Definitive rejection must restore the composer's draft/queue. An
      // uncertain commit keeps its same durable key and is never re-posted.
      if (admissionRejected) throw error
    }
    return true
    } finally { starting.current.delete(startKey); starting.current.delete(admittedChatKey) }
  }, [observe, showError])

  const stop = useCallback((chatId: string | null): boolean => {
    const run = chatId ? runs.current.get(chatId) : null
    if (!run) return false
    void cancelRun(run)
    return true
  }, [cancelRun])

  useEffect(() => {
    const chat = currentChat
    const navigated = visibleChat.current !== (chat?.id || null)
    visibleChat.current = chat?.id || null
    if (!chat?.id || !userId) return
    const existing = runs.current.get(chat.id)
    if (existing) {
      if (existing.content && chat.messages.some((message) => message.id === existing.messageId && message.content !== existing.content)) {
        latest.current.setCurrentChat((current) => current?.id === chat.id ? { ...current, messages: current.messages.map((message) =>
          message.id === existing.messageId ? { ...message, content: existing.content! } : message) } : current)
      }
      if (navigated && existing.suspended && !existing.observing && !existing.cancelling) {
        markBusy(chat.id, existing.controller)
        void observe(existing)
      }
      return
    }
    // A chat refresh can observe the persisted pointer before addMessage's
    // response arrives. Its foreground admission already owns recovery.
    if (starting.current.has(`${epoch.current}:${userId}:${chat.id}`)) return
    const pending = [...chat.messages].reverse().find((message) =>
      (navigated || !hydrated.current.has(message.id)) && parseDocumentJobPointer(message.metadata))
    if (!pending) {
      // A background chat refresh can return the original pointer bubble.
      // Reproject the last verified/local error view without another request.
      if (chat.messages.some((message) => hydrated.current.has(message.id) && hydrated.current.get(message.id) !== message.content)) {
        latest.current.setCurrentChat((current) => current?.id === chat.id ? { ...current, messages: current.messages.map((message) =>
          hydrated.current.has(message.id) ? { ...message, content: hydrated.current.get(message.id)! } : message) } : current)
      }
      return
    }
    const pointer = parseDocumentJobPointer(pending.metadata)!
    const run: Run = { chatId: chat.id, messageId: pending.id, pointer, controller: new AbortController(),
      observing: true, suspended: false, cancelRequested: false, cancelling: false }
    runs.current.set(chat.id, run)
    markBusy(chat.id, run.controller)
    void observe(run)
    // Chat navigation does not cancel a server job. The observer updates only
    // its own bubble and keeps working while another conversation is visible.
  }, [currentChat, userId, observe, markBusy])

  useEffect(() => {
    const active = runs.current
    const completed = hydrated.current
    const admissions = starting.current
    const lifecycle = epoch
    return () => {
      lifecycle.current++
      active.forEach((run) => {
        run.controller.abort() // detach transport, never call the cancellation endpoint on navigation/unmount
        latest.current.markIdle(run.chatId, run.controller)
      })
      active.clear(); completed.clear(); admissions.clear()
    }
  }, [userId])

  return { start, stop }
}
