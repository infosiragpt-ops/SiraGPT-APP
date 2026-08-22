"use client"

import * as React from "react"

import {
  readDocumentDraft,
  writeDocumentDraft,
  clearDocumentDraft,
  type DocumentDraft,
} from "@/lib/chat/document-draft"

/**
 * use-document-autosave — resilience layer for the /chat document editor.
 *
 * Golden rule: NEVER lose a user edit. Three cooperating mechanisms:
 *
 *   1. Debounced autosave — `onChange` re-arms a timer (default 1.5s after
 *      the last keystroke) that invokes the injected `save` callback. The
 *      caller decides what "save" means (POST /files/:id/edit); the hook
 *      owns the timing, the retry queue, and the visible status.
 *
 *   2. Retry with backoff — a failed save retries up to 3 times at
 *      0.5s / 2s / 8s. If every attempt fails the status becomes
 *      `"error"` and stays there; `retryNow()` lets the user force an
 *      immediate attempt instead of waiting for the next edit.
 *
 *   3. Local draft — while content is unconfirmed, it mirrors into
 *      localStorage keyed by (fileId, userId). On mount,
 *      `recoverableDraft()` exposes a stored draft that is NEWER than the
 *      server content the panel loaded; recovery is always explicit via
 *      `restoreDraft()` / `discardDraft()` — never silent.
 *
 * Status machine: "idle" → "dirty" → "saving" → "saved" | "error".
 * A keystroke from "saved"/"error" returns to "dirty". While status is
 * dirty/saving/error the hook registers a native `beforeunload` guard so
 * closing the tab warns about unsaved work.
 */

export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error"

export type UseDocumentAutosaveOptions = {
  /** Owner scope for the localStorage draft key. */
  fileId?: string | null
  userId?: string | null
  /** Debounce window after the last change (ms). */
  debounceMs?: number
  /** Backoff delays between retries (ms), one entry per retry. */
  retryDelaysMs?: number[]
  /**
   * Persist the markdown to the server. Must throw on failure so the
   * retry/backoff machinery can engage.
   */
  save: (markdown: string) => Promise<void>
  /** Server FileVersion number the current editor content started from. */
  baseVersion?: number
  /** Disable autosave entirely (manual-save-only mode). */
  enabled?: boolean
}

const DEFAULT_DEBOUNCE_MS = 1500
const DEFAULT_RETRY_DELAYS_MS = [500, 2000, 8000]

export function useDocumentAutosave(options: UseDocumentAutosaveOptions) {
  const {
    fileId,
    userId,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    save,
    baseVersion = 0,
    enabled = true,
  } = options

  const [status, setStatus] = React.useState<AutosaveStatus>("idle")
  const [lastSavedAt, setLastSavedAt] = React.useState<number | null>(null)
  // Bumped whenever a save attempt starts failing; consumers can show
  // "reintentando (n/3)" while the backoff queue drains.
  const [attempt, setAttempt] = React.useState(0)

  // Refs for values the async retry loop must read fresh without
  // restarting timers or re-registering effects.
  const latestMarkdownRef = React.useRef<string>("")
  const dirtyRef = React.useRef(false)
  const saveFnRef = React.useRef(save)
  const enabledRef = React.useRef(enabled)
  const retryTimersRef = React.useRef<Array<ReturnType<typeof setTimeout>>>([])
  const cancelledRef = React.useRef(false)

  React.useEffect(() => { saveFnRef.current = save }, [save])
  React.useEffect(() => { enabledRef.current = enabled }, [enabled])

  const clearRetryTimers = React.useCallback(() => {
    for (const t of retryTimersRef.current) clearTimeout(t)
    retryTimersRef.current = []
  }, [])

  React.useEffect(() => () => {
    cancelledRef.current = true
    clearRetryTimers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Local draft -------------------------------------------------------
  const persistLocalDraft = React.useCallback((markdown: string) => {
    if (!fileId) return
    writeDocumentDraft(fileId, {
      content: markdown,
      savedAt: Date.now(),
      baseVersion,
    }, userId)
  }, [fileId, userId, baseVersion])

  const dropLocalDraft = React.useCallback(() => {
    if (!fileId) return
    clearDocumentDraft(fileId, userId)
  }, [fileId, userId])

  /**
   * Stored draft newer than `serverUpdatedAt` (epoch ms of the server
   * content the panel just loaded; pass 0/undefined when unknown). Returns
   * null when nothing is recoverable — including when the stored draft
   * matches the loaded content, which must never trigger the banner.
   */
  const recoverableDraft = React.useCallback((serverUpdatedAt?: number): DocumentDraft | null => {
    if (!fileId) return null
    const draft = readDocumentDraft(fileId, userId)
    if (!draft || !draft.content) return null
    if (draft.content === latestMarkdownRef.current) return null
    if (typeof serverUpdatedAt === "number" && serverUpdatedAt > 0 && draft.savedAt <= serverUpdatedAt) {
      return null
    }
    return draft
  }, [fileId, userId])

  const restoreDraft = React.useCallback((draft: DocumentDraft) => {
    latestMarkdownRef.current = draft.content
    dirtyRef.current = true
    setStatus("dirty")
    return draft.content
  }, [])

  const discardDraft = React.useCallback(() => {
    dropLocalDraft()
  }, [dropLocalDraft])

  // ---- Save pipeline (with backoff) --------------------------------------
  const runSave = React.useCallback(async (): Promise<boolean> => {
    const markdown = latestMarkdownRef.current
    setStatus("saving")
    try {
      await saveFnRef.current(markdown)
      dirtyRef.current = false
      dropLocalDraft()
      setLastSavedAt(Date.now())
      setAttempt(0)
      setStatus("saved")
      return true
    } catch {
      return false
    }
  }, [dropLocalDraft])

  const scheduleRetries = React.useCallback((failedAttempt: number) => {
    clearRetryTimers()
    let nextAttempt = failedAttempt + 1
    const scheduleNext = () => {
      const delayIndex = nextAttempt - 1
      if (delayIndex >= retryDelaysMs.length) {
        setAttempt(nextAttempt)
        setStatus("error")
        return
      }
      const delay = retryDelaysMs[delayIndex]
      const timer = setTimeout(() => {
        if (cancelledRef.current) return
        setAttempt(nextAttempt)
        void runSave().then((ok) => {
          if (ok || cancelledRef.current) return
          nextAttempt += 1
          scheduleNext()
        })
      }, delay)
      retryTimersRef.current.push(timer)
    }
    scheduleNext()
  }, [clearRetryTimers, retryDelaysMs.length, runSave])

  const flush = React.useCallback(async (): Promise<boolean> => {
    clearRetryTimers()
    if (!latestMarkdownRef.current || !dirtyRef.current) return false
    const ok = await runSave()
    if (!ok) scheduleRetries(0)
    return ok
  }, [clearRetryTimers, runSave, scheduleRetries])

  const notifyChange = React.useCallback((markdown: string) => {
    latestMarkdownRef.current = markdown
    if (!enabledRef.current) {
      dirtyRef.current = true
      setStatus("idle")
      return
    }
    dirtyRef.current = true
    setStatus("dirty")
    setAttempt(0)
    persistLocalDraft(markdown)
  }, [persistLocalDraft])

  // ---- Debounced autosave timer ------------------------------------------
  React.useEffect(() => {
    if (!enabled) return
    const interval = setInterval(() => {
      if (cancelledRef.current) return
      if (!dirtyRef.current) return
      clearRetryTimers()
      void runSave().then((ok) => {
        if (!ok && !cancelledRef.current) scheduleRetries(0)
      })
    }, debounceMs)
    return () => clearInterval(interval)
  }, [enabled, debounceMs, runSave, scheduleRetries, clearRetryTimers])

  // ---- beforeunload guard --------------------------------------------------
  React.useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      // Legacy Chrome/Edge requires returnValue to actually prompt.
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [])

  const markClean = React.useCallback(() => {
    dirtyRef.current = false
    clearRetryTimers()
    setStatus("idle")
    setAttempt(0)
  }, [clearRetryTimers])

  const resetForContent = React.useCallback((markdown: string) => {
    latestMarkdownRef.current = markdown
    dirtyRef.current = false
    clearRetryTimers()
    setLastSavedAt(null)
    setAttempt(0)
    setStatus("idle")
  }, [clearRetryTimers])

  const retryNow = React.useCallback(() => {
    clearRetryTimers()
    if (!dirtyRef.current) return
    void runSave().then((ok) => {
      if (!ok && !cancelledRef.current) scheduleRetries(0)
    })
  }, [clearRetryTimers, runSave, scheduleRetries])

  return {
    status,
    attempt,
    lastSavedAt,
    notifyChange,
    flush,
    retryNow,
    markClean,
    resetForContent,
    recoverableDraft,
    restoreDraft,
    discardDraft,
    hasUnsavedChanges: () => dirtyRef.current,
  }
}
