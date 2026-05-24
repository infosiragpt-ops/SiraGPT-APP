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
  error?: string
}

type Ctx = {
  streams: Map<string, BackgroundStream>
  activeCount: number
  register: (chatId: string, title: string, controller: AbortController) => void
  appendChunk: (chatId: string, chunk: string) => void
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
    complete: noop,
    fail: noop,
    cancel: noop,
    dismiss: noop,
    get: () => undefined,
  }
}

export function BackgroundStreamsProvider({ children }: { children: React.ReactNode }) {
  const [, force] = React.useReducer((n) => n + 1, 0)
  // A plain ref holds the Map. We render on demand via `force` when
  // meaningful transitions happen (register / complete / fail). This
  // avoids rerendering every consumer on each token chunk.
  const streamsRef = React.useRef<Map<string, BackgroundStream>>(new Map())
  const lastChunkTick = React.useRef<Map<string, number>>(new Map())

  // Return a stable reference to the Map so React.useMemo consumers
  // can subscribe to it safely, but only after a force-render.
  const streams = streamsRef.current

  const activeCount = React.useMemo(() =>
    Array.from(streams.values()).filter((s) => s.status === "streaming").length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streams, streams.size, /* force counter via force() */ lastChunkTick.current.size])

  const register = React.useCallback((chatId: string, title: string, controller: AbortController) => {
    streamsRef.current.set(chatId, {
      chatId,
      title: title || "Chat",
      controller,
      status: "streaming",
      partialContent: "",
      startedAt: Date.now(),
    })
    force()
  }, [])

  // Token-level appends are high-frequency — we throttle the render
  // trigger to ~5 Hz so sidebar counters stay snappy without
  // re-rendering on every token.
  const appendChunk = React.useCallback((chatId: string, chunk: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    s.partialContent += chunk
    const now = Date.now()
    const last = lastChunkTick.current.get(chatId) ?? 0
    if (now - last > 200) {
      lastChunkTick.current.set(chatId, now)
      force()
    }
  }, [])

  const complete = React.useCallback((chatId: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    s.status = "done"
    force()
    // Leave the entry in the Map briefly so the sidebar can show the
    // completed-state blue dot before garbage-collecting the stream.
    setTimeout(() => {
      const cur = streamsRef.current.get(chatId)
      if (cur && cur.status === "done") {
        streamsRef.current.delete(chatId)
        force()
      }
    }, 12000)
  }, [])

  const fail = React.useCallback((chatId: string, error: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    s.status = "error"
    s.error = error
    force()
  }, [])

  const cancel = React.useCallback((chatId: string) => {
    const s = streamsRef.current.get(chatId)
    if (!s) return
    try { s.controller.abort() } catch { /* already aborted */ }
    streamsRef.current.delete(chatId)
    force()
  }, [])

  const dismiss = React.useCallback((chatId: string) => {
    streamsRef.current.delete(chatId)
    force()
  }, [])

  const get = React.useCallback((chatId: string) => streamsRef.current.get(chatId), [])

  const value = React.useMemo<Ctx>(() => ({
    streams, activeCount, register, appendChunk, complete, fail, cancel, dismiss, get,
  }), [streams, activeCount, register, appendChunk, complete, fail, cancel, dismiss, get])

  return (
    <BackgroundStreamsContext.Provider value={value}>
      {children}
    </BackgroundStreamsContext.Provider>
  )
}
