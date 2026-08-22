"use client"

/**
 * background-streams-context — lets multiple chats stream at the
 * same time. The primary ChatContext still drives the chat the
 * user is *looking at*; this context tracks every OTHER chat
 * whose stream is in flight so the user can switch away, open a
 * new chat, and the first one keeps generating.
 *
 * Shape per active stream:
 *   controller        — AbortController (so the sidebar pill can cancel)
 *   chatId            — which Chat row the stream is appending to
 *   title             — short label shown in the pill / popover
 *   status            — 'streaming' | 'done' | 'error'
 *   partialContent    — what we've received so far (read by any
 *                       consumer that wants to show the chat)
 *   startedAt         — for relative-time UI ("hace 2 min")
 *   error             — short message when status === 'error'
 *
 * The actual POST /ai/generate call still happens in ChatContext;
 * here we only track which streams are live. That keeps the network
 * layer untouched and the risk surface small.
 */

import React from "react"

export type BackgroundStreamStatus = "streaming" | "done" | "error"

export type BackgroundStream = {
  chatId: string
  title: string
  controller: AbortController
  status: BackgroundStreamStatus
  partialContent: string
  startedAt: number
  lastEventId?: string
  error?: string
}

const LAST_EVENT_PREFIX = "siragpt:lastEventId:"

export function readPersistedLastEventId(chatId: string): string | null {
  try {
    if (typeof sessionStorage === "undefined" || !chatId) return null
    return sessionStorage.getItem(`${LAST_EVENT_PREFIX}${chatId}`)
  } catch {
    return null
  }
}

export function persistLastEventId(chatId: string, lastEventId?: string | null): void {
  const id = String(lastEventId || "").trim()
  if (!chatId || !id) return
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(`${LAST_EVENT_PREFIX}${chatId}`, id)
    }
  } catch {
    /* private mode / quota */
  }
}


type Ctx = {
  streams: Map<string, BackgroundStream>
  activeCount: number
  register: (chatId: string, title: string, controller: AbortController) => void
  appendChunk: (chatId: string, chunk: string) => void
  rememberEventId: (chatId: string, lastEventId: string) => void
  complete: (chatId: string) => void
  fail: (chatId: string, error: string) => void
  cancel: (chatId: string) => void
  dismiss: (chatId: string) => void
  get: (chatId: string) => BackgroundStream | undefined
}

const BackgroundStreamsContext = React.createContext<Ctx | null>(null)

export function useBackgroundStreams(): Ctx {
  const ctx = React.useContext(BackgroundStreamsContext)
  if (ctx) return ctx
  // Graceful stub when the provider isn't mounted (public pages,
  // share routes) so consumers never blow up.
  const noop = () => { }
  return {
    streams: new Map(),
    activeCount: 0,
    register: noop,
    appendChunk: noop,
    rememberEventId: noop,
    complete: noop,
    fail: noop,
    cancel: noop,
    dismiss: noop,
    get: () => undefined,
  }
}

export function BackgroundStreamsProvider({ children }: { children: React.ReactNode }) {
  // `streams` is an immutable render snapshot; `streamsRef` is the latest
  // authoritative snapshot used by token callbacks between throttled renders.
  // Keeping both prevents stale context values without rendering on every
  // token received from the network.
  const [streams, setStreams] = React.useState<Map<string, BackgroundStream>>(() => new Map())
  const streamsRef = React.useRef<Map<string, BackgroundStream>>(streams)
  const lastChunkTick = React.useRef<Map<string, number>>(new Map())
  const gcTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const publish = React.useCallback((next: Map<string, BackgroundStream>) => {
    streamsRef.current = next
    setStreams(next)
  }, [])

  const clearGcTimer = React.useCallback((chatId: string) => {
    const timer = gcTimersRef.current.get(chatId)
    if (timer) clearTimeout(timer)
    gcTimersRef.current.delete(chatId)
  }, [])

  const activeCount = React.useMemo(() =>
    Array.from(streams.values()).filter((s) => s.status === "streaming").length,
    [streams])

  const register = React.useCallback((chatId: string, title: string, controller: AbortController) => {
    clearGcTimer(chatId)
    lastChunkTick.current.delete(chatId)
    const next = new Map(streamsRef.current)
    next.set(chatId, {
      chatId,
      title: title || "Chat",
      controller,
      status: "streaming",
      partialContent: "",
      startedAt: Date.now(),
      lastEventId: readPersistedLastEventId(chatId) || undefined,
    })
    publish(next)
  }, [clearGcTimer, publish])

  // Token-level appends are high-frequency — we throttle the render
  // trigger to ~5 Hz so sidebar counters stay snappy without
  // re-rendering on every token.
  const appendChunk = React.useCallback((chatId: string, chunk: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    const next = new Map(streamsRef.current)
    next.set(chatId, { ...s, partialContent: s.partialContent + chunk })
    // Make the complete content synchronously visible to `get()` even when
    // this token falls inside the render-throttle window.
    streamsRef.current = next
    const now = Date.now()
    const last = lastChunkTick.current.get(chatId) ?? 0
    if (now - last > 200) {
      lastChunkTick.current.set(chatId, now)
      setStreams(next)
    }
  }, [])

  const rememberEventId = React.useCallback((chatId: string, lastEventId: string) => {
    persistLastEventId(chatId, lastEventId)
    const s = streamsRef.current.get(chatId)
    if (!s) return
    const next = new Map(streamsRef.current)
    next.set(chatId, { ...s, lastEventId })
    streamsRef.current = next
  }, [])

  const complete = React.useCallback((chatId: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    const next = new Map(streamsRef.current)
    next.set(chatId, { ...s, status: "done" })
    publish(next)
    clearGcTimer(chatId)
    // Leave the entry in the Map briefly so the sidebar can show the
    // completed-state blue dot before garbage-collecting the stream.
    const timer = setTimeout(() => {
      const cur = streamsRef.current.get(chatId)
      if (cur && cur.status === "done") {
        const afterGc = new Map(streamsRef.current)
        afterGc.delete(chatId)
        streamsRef.current = afterGc
        setStreams(afterGc)
      }
      gcTimersRef.current.delete(chatId)
    }, 12000)
    gcTimersRef.current.set(chatId, timer)
  }, [clearGcTimer, publish])

  const fail = React.useCallback((chatId: string, error: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    clearGcTimer(chatId)
    const next = new Map(streamsRef.current)
    next.set(chatId, { ...s, status: "error", error })
    publish(next)
  }, [clearGcTimer, publish])

  const cancel = React.useCallback((chatId: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    try { s.controller.abort() } catch { /* already aborted */ }
    clearGcTimer(chatId)
    lastChunkTick.current.delete(chatId)
    const next = new Map(streamsRef.current)
    next.delete(chatId)
    publish(next)
  }, [clearGcTimer, publish])

  const dismiss = React.useCallback((chatId: string) => {
    if (!streamsRef.current.has(chatId)) return
    clearGcTimer(chatId)
    lastChunkTick.current.delete(chatId)
    const next = new Map(streamsRef.current)
    next.delete(chatId)
    publish(next)
  }, [clearGcTimer, publish])

  const get = React.useCallback((chatId: string) => streamsRef.current.get(chatId), [])

  React.useEffect(() => () => {
    gcTimersRef.current.forEach((timer) => clearTimeout(timer))
    gcTimersRef.current.clear()
  }, [])

  const value = React.useMemo<Ctx>(() => ({
    streams, activeCount, register, appendChunk, rememberEventId, complete, fail, cancel, dismiss, get,
  }), [streams, activeCount, register, appendChunk, rememberEventId, complete, fail, cancel, dismiss, get])

  return (
    <BackgroundStreamsContext.Provider value={value}>
      {children}
    </BackgroundStreamsContext.Provider>
  )
}
