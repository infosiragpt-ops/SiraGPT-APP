"use client"

import * as React from "react"
import { apiClient } from "@/lib/api"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { safeUUID } from "@/lib/safe-uuid"
import { ensureResearchCommandChat } from "@/lib/research-results"
import { clearResearchGoalPointer, createResearchEventDecoder, findResearchGoalPointer, saveResearchGoalPointer, type ResearchGoalPointer, type ResearchGoalStatus } from "@/lib/chat/research-goal-client"

type Entry = { pointer: ResearchGoalPointer; controller: AbortController; toastId?: string | number; cancelling?: boolean }
type Options = {
  ownerId: string
  chat: any
  recoveryEnabled?: boolean
  selectChat: (chatId: string) => void | Promise<any>
  refreshChat: (chatId: string) => Promise<void>
  markBusy: (chatId: string, controller: AbortController) => void
  markIdle: (chatId: string, controller?: AbortController) => void
  notify: (kind: "loading" | "success" | "error" | "info", text: string, toastId?: string | number) => string | number | void
}

function waitForPoll(signal: AbortSignal, delay = 2500): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake) }
    const finish = () => { cleanup(); resolve() }
    const abort = () => { cleanup(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })) }
    const wake = () => { if (document.visibilityState !== "hidden" && navigator.onLine !== false) finish() }
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    if (document.visibilityState !== "hidden" && navigator.onLine !== false) timer = setTimeout(finish, delay)
  })
}

/** Browser connections observe durable jobs; only the existing Stop explicitly cancels them. */
export function useResearchGoal(options: Options) {
  const optionsRef = React.useRef(options)
  optionsRef.current = options
  const entriesRef = React.useRef(new Map<string, Entry>())
  const terminalRef = React.useRef(new Set<string>())
  const mountedRef = React.useRef(true)

  const finish = React.useCallback(async (entry: Entry, status: ResearchGoalStatus) => {
    const { pointer, controller } = entry
    if (entriesRef.current.get(pointer.chatId) !== entry) return
    // GET is authoritative: a report event can precede its DB acknowledgement.
    if (status.status === "running") return
    try { await optionsRef.current.refreshChat(pointer.chatId) } catch { /* durable report remains recoverable on the next chat refresh */ }
    if (controller.signal.aborted || entriesRef.current.get(pointer.chatId) !== entry) return
    terminalRef.current.add(pointer.runId)
    clearResearchGoalPointer(pointer)
    entriesRef.current.delete(pointer.chatId)
    optionsRef.current.markIdle(pointer.chatId, controller)
    if (status.status === "completed") {
      optionsRef.current.notify("success", `Investigación completada · ${status.result?.stats?.findingsExtracted || 0} hallazgos · ${status.result?.stats?.papersFound || 0} artículos`, entry.toastId)
    } else if (status.status === "cancelled") optionsRef.current.notify("info", "Investigación detenida.", entry.toastId)
    else optionsRef.current.notify("error", status.error || "No se pudo completar la investigación. Puedes reintentar.", entry.toastId)
  }, [])

  const poll = React.useCallback(async (entry: Entry) => {
    let failures = 0
    while (!entry.controller.signal.aborted && mountedRef.current && entriesRef.current.get(entry.pointer.chatId) === entry) {
      try {
        if (document.visibilityState === "hidden" || navigator.onLine === false) await waitForPoll(entry.controller.signal)
        const response = await authenticatedFetch(`${getSameOriginApiBaseUrl()}/research-agent/runs/${encodeURIComponent(entry.pointer.runId)}`, { credentials: "include", signal: entry.controller.signal })
        if (response.status === 401 || response.status === 403) throw Object.assign(new Error("auth"), { status: response.status })
        if (!response.ok) throw Object.assign(new Error("status"), { status: response.status })
        failures = 0
        const status = await response.json() as ResearchGoalStatus
        if (status.runId !== entry.pointer.runId || status.chatId !== entry.pointer.chatId) throw new Error("run_mismatch")
        if (status.status !== "running") { await finish(entry, status); return }
      } catch (error: any) {
        if (entry.controller.signal.aborted) return
        failures++
        if ((error?.status === 404 && failures >= 3) || error?.status === 401 || error?.status === 403) {
          // Never resend an uncertain POST: preserve the query as a real user message.
          await finish(entry, { ...entry.pointer, status: "failed", error: "No se pudo recuperar la investigación. Tu consulta permanece guardada en el chat." })
          return
        }
      }
      try { await waitForPoll(entry.controller.signal, Math.min(15_000, 2500 * Math.max(1, failures))) } catch { return }
    }
  }, [finish])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of entriesRef.current.values()) {
        entry.controller.abort() // disconnect is deliberately not server cancellation
        optionsRef.current.markIdle(entry.pointer.chatId, entry.controller)
      }
      entriesRef.current.clear()
    }
  }, [options.ownerId])

  const recovered = React.useMemo(() => options.recoveryEnabled === false ? null : findResearchGoalPointer(options.ownerId, options.chat),
    [options.ownerId, options.chat?.id, options.chat?.messages, options.recoveryEnabled])
  React.useEffect(() => {
    if (!recovered || terminalRef.current.has(recovered.runId) || entriesRef.current.has(recovered.chatId)) return
    const entry: Entry = { pointer: recovered, controller: new AbortController() }
    entriesRef.current.set(recovered.chatId, entry)
    optionsRef.current.markBusy(recovered.chatId, entry.controller)
    void poll(entry)
  }, [options.ownerId, options.chat?.id, recovered?.runId, poll])

  const start = React.useCallback(async (input: { query: string; model: string; provider: string; chat: any }): Promise<boolean> => {
    const opts = optionsRef.current
    if (!opts.ownerId || !input.model) return false
    if (input.chat?.id && entriesRef.current.has(input.chat.id)) { opts.notify("info", "Espera a que termine la investigación actual."); return false }
    const runId = `rr_${safeUUID()}`
    let userMessageId: string | undefined
    const chat = await ensureResearchCommandChat({
      currentChat: input.chat?.id?.startsWith("temp-chat-") ? null : input.chat,
      query: input.query,
      model: input.model,
      createChat: data => apiClient.createChat(data),
      addMessage: async (chatId, data) => {
        const saved = await apiClient.addMessage(chatId, { ...data, metadata: { researchRunId: runId }, idempotencyKey: `research-user-${runId}` })
        userMessageId = saved?.message?.id || saved?.id
        return saved
      },
    })
    const pointer: ResearchGoalPointer = { runId, chatId: chat.id, ownerId: opts.ownerId }
    const entry: Entry = { pointer, controller: new AbortController() }
    entry.toastId = opts.notify("loading", "Investigación iniciada — buscando artículos…") || undefined
    entriesRef.current.set(chat.id, entry)
    saveResearchGoalPointer(pointer)
    opts.markBusy(chat.id, entry.controller)
    try { await opts.selectChat(chat.id) } catch { /* persisted metadata recovers the run even if chat hydration is temporarily unavailable */ }
    let response: Response
    try {
      const request = await apiClient.prepareMutatingFetch({ method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", signal: entry.controller.signal,
        body: JSON.stringify({ query: input.query, depth: "standard", chatId: chat.id, model: input.model, provider: input.provider, runId, userMessageId }) })
      response = await authenticatedFetch(`${getSameOriginApiBaseUrl()}/research-agent/stream`, request)
      if (!response.ok || !response.body) {
        if (response.status >= 400 && response.status < 500) {
          await finish(entry, { ...pointer, status: "failed", error: "No se pudo iniciar la investigación con el modelo seleccionado. Tu consulta permanece guardada." })
          return true
        }
        throw new Error("transport")
      }
    } catch {
      if (!entry.controller.signal.aborted) { opts.notify("info", "Reconectando la investigación guardada…", entry.toastId); void poll(entry) }
      return true // the query is persisted; never restore it as an unsent duplicate
    }
    const reader = response.body.getReader()
    void (async () => {
      let papers = 0, findings = 0
      const decoder = createResearchEventDecoder(event => {
        if (event.type === "paper") papers++
        if (event.type === "finding") findings++
        if (event.type === "phase") optionsRef.current.notify("loading", `Investigación: ${event.label || event.phase} · ${papers} artículos · ${findings} hallazgos`, entry.toastId)
      })
      try {
        while (!entry.controller.signal.aborted) {
          const chunk = await reader.read()
          decoder.push(chunk.value, chunk.done)
          if (chunk.done) break
        }
      } catch { /* reconnect through the durable GET, not a second POST */ }
      finally { try { reader.releaseLock() } catch {} }
      if (!entry.controller.signal.aborted) await poll(entry)
    })()
    return true
  }, [finish, poll])

  const stop = React.useCallback((chatId?: string | null): boolean => {
    const entry = chatId ? entriesRef.current.get(chatId) : null
    if (!entry) return false
    if (entry.cancelling) return true
    entry.cancelling = true
    void (async () => {
      try {
        const request = await apiClient.prepareMutatingFetch({ method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" })
        const response = await authenticatedFetch(`${getSameOriginApiBaseUrl()}/research-agent/runs/${encodeURIComponent(entry.pointer.runId)}/cancel`, request)
        if (!response.ok) throw new Error("cancel")
        const status = await response.json()
        if (status.runId !== entry.pointer.runId || !["cancelled", "completed", "failed"].includes(status.status)) throw new Error("cancel_not_acknowledged")
        // Free the existing Stop/composer only after the durable acknowledgement.
        await finish(entry, { ...entry.pointer, ...status })
        entry.controller.abort()
      } catch {
        entry.cancelling = false
        optionsRef.current.notify("error", "No se pudo confirmar la detención. Vuelve a pulsar Detener.", entry.toastId)
      }
    })()
    return true
  }, [finish])
  return { start, stop }
}
