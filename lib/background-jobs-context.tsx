"use client"

/**
 * background-jobs-context — layout-level tracker for durable agent jobs
 * (Word / PPT / agent turns). Unlike BackgroundStreams, this does NOT
 * hold an AbortController and never cancels work on unmount. The server
 * job (BullMQ + task-store) outlives the tab; this context only mirrors
 * it so the sidebar/chips can show a spinner and we can toast in Spanish
 * when the user leaves or the job finishes in another chat.
 */

import React from "react"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient, type AgentTaskPointer } from "@/lib/api"

export type BackgroundJobStatus = "running" | "done" | "error"

export type BackgroundJob = {
  chatId: string
  taskId?: string
  title: string
  status: BackgroundJobStatus
  startedAt: number
}

type Ctx = {
  jobs: Map<string, BackgroundJob>
  runningChatIds: string[]
  isRunning: (chatId: string) => boolean
  register: (chatId: string, title: string, taskId?: string) => void
  complete: (chatId: string, opts?: { currentChatId?: string | null; title?: string }) => void
  fail: (chatId: string) => void
  dismiss: (chatId: string) => void
  cancel: (chatId: string) => Promise<void>
  noteLeftChat: (chatId: string, title?: string) => void
  setWatchedChatId: (chatId: string | null) => void
}

const BackgroundJobsContext = React.createContext<Ctx | null>(null)

const STORAGE_KEY = "sira:background-jobs"
const POLL_MS = 4000

function loadPersisted(): Map<string, BackgroundJob> {
  if (typeof window === "undefined") return new Map()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Map()
    const next = new Map<string, BackgroundJob>()
    for (const item of parsed) {
      if (!item?.chatId) continue
      next.set(item.chatId, {
        chatId: String(item.chatId),
        taskId: item.taskId ? String(item.taskId) : undefined,
        title: String(item.title || "Chat"),
        status: item.status === "done" || item.status === "error" ? item.status : "running",
        startedAt: Number(item.startedAt) || Date.now(),
      })
    }
    return next
  } catch {
    return new Map()
  }
}

function persist(jobs: Map<string, BackgroundJob>) {
  if (typeof window === "undefined") return
  try {
    const running = Array.from(jobs.values()).filter((j) => j.status === "running")
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(running))
  } catch {
    /* storage can be disabled */
  }
}

export function useBackgroundJobs(): Ctx {
  const ctx = React.useContext(BackgroundJobsContext)
  if (ctx) return ctx
  const noop = () => {}
  return {
    jobs: new Map(),
    runningChatIds: [],
    isRunning: () => false,
    register: noop,
    complete: noop,
    fail: noop,
    dismiss: noop,
    cancel: async () => {},
    noteLeftChat: noop,
    setWatchedChatId: noop,
  }
}

export function BackgroundJobsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  const [jobs, setJobs] = React.useState<Map<string, BackgroundJob>>(() => loadPersisted())
  const jobsRef = React.useRef(jobs)
  const toastedDoneRef = React.useRef<Set<string>>(new Set())
  const notedLeaveRef = React.useRef<Set<string>>(new Set())
  const knownRunningRef = React.useRef<Set<string>>(new Set())
  const seenOnServerRef = React.useRef<Set<string>>(new Set(
    Array.from(jobs.values()).filter((j) => j.status === "running").map((j) => j.chatId),
  ))
  const watchedChatIdRef = React.useRef<string | null>(null)

  const publish = React.useCallback((next: Map<string, BackgroundJob>) => {
    jobsRef.current = next
    persist(next)
    setJobs(next)
  }, [])

  const isRunning = React.useCallback((chatId: string) => {
    return jobsRef.current.get(chatId)?.status === "running"
  }, [])

  const register = React.useCallback((chatId: string, title: string, taskId?: string) => {
    if (!chatId) return
    const prev = jobsRef.current.get(chatId)
    const next = new Map(jobsRef.current)
    next.set(chatId, {
      chatId,
      taskId: taskId || prev?.taskId,
      title: title || prev?.title || "Chat",
      status: "running",
      startedAt: prev?.startedAt || Date.now(),
    })
    knownRunningRef.current.add(chatId)
    toastedDoneRef.current.delete(chatId)
    publish(next)
  }, [publish])

  const complete = React.useCallback((chatId: string, opts?: { currentChatId?: string | null; title?: string }) => {
    const prev = jobsRef.current.get(chatId)
    if (!prev && !opts?.title) {
      knownRunningRef.current.delete(chatId)
      return
    }
    const title = opts?.title || prev?.title || "Chat"
    const next = new Map(jobsRef.current)
    if (prev) next.set(chatId, { ...prev, status: "done" })
    else next.delete(chatId)
    knownRunningRef.current.delete(chatId)
    publish(next)
    const inOtherChat = Boolean(opts?.currentChatId && opts.currentChatId !== chatId)
    if (inOtherChat && !toastedDoneRef.current.has(chatId)) {
      toastedDoneRef.current.add(chatId)
    }
    window.setTimeout(() => {
      const cur = jobsRef.current.get(chatId)
      if (cur && cur.status === "done") {
        const after = new Map(jobsRef.current)
        after.delete(chatId)
        publish(after)
      }
    }, 12000)
  }, [publish])

  const fail = React.useCallback((chatId: string) => {
    const prev = jobsRef.current.get(chatId)
    if (!prev) return
    const next = new Map(jobsRef.current)
    next.set(chatId, { ...prev, status: "error" })
    knownRunningRef.current.delete(chatId)
    publish(next)
  }, [publish])

  const dismiss = React.useCallback((chatId: string) => {
    if (!jobsRef.current.has(chatId)) return
    const next = new Map(jobsRef.current)
    next.delete(chatId)
    knownRunningRef.current.delete(chatId)
    notedLeaveRef.current.delete(chatId)
    publish(next)
  }, [publish])

  const cancel = React.useCallback(async (chatId: string) => {
    if (!chatId) return
    const job = jobsRef.current.get(chatId)
    try {
      await apiClient.stopAIStream(job?.taskId || `job:${chatId}`, chatId)
    } catch {
      /* backend cancel is best-effort; still drop local running state */
    }
    fail(chatId)
    dismiss(chatId)
  }, [fail, dismiss])

  const noteLeftChat = React.useCallback((chatId: string, title?: string) => {
    if (!chatId) return
    if (jobsRef.current.get(chatId)?.status !== "running") return
    if (notedLeaveRef.current.has(chatId)) return
    notedLeaveRef.current.add(chatId)
  }, [])

  const setWatchedChatId = React.useCallback((chatId: string | null) => {
    const prev = watchedChatIdRef.current
    watchedChatIdRef.current = chatId
    if (chatId) notedLeaveRef.current.delete(chatId)
    if (prev && prev !== chatId && jobsRef.current.get(prev)?.status === "running") {
      noteLeftChat(prev, jobsRef.current.get(prev)?.title)
    }
  }, [noteLeftChat])

  React.useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    const tick = async () => {
      try {
        const payload = await apiClient.getActiveAgentTasks()
        if (cancelled) return
        const serverTasks = Array.isArray(payload?.tasks) ? payload.tasks : []
        const byChat = new Map<string, AgentTaskPointer>()
        for (const task of serverTasks) {
          const chatId = String(task?.chatId || "").trim()
          if (!chatId) continue
          byChat.set(chatId, task)
        }

        const next = new Map(jobsRef.current)
        let changed = false
        for (const [chatId, task] of byChat) {
          const prev = next.get(chatId)
          if (!prev || prev.status !== "running" || prev.taskId !== task.taskId) {
            next.set(chatId, {
              chatId,
              taskId: task.taskId,
              title: prev?.title || String(task.displayGoal || "Chat").slice(0, 80),
              status: "running",
              startedAt: prev?.startedAt || Date.now(),
            })
            changed = true
          }
          knownRunningRef.current.add(chatId)
          seenOnServerRef.current.add(chatId)
        }

        for (const chatId of Array.from(knownRunningRef.current)) {
          if (byChat.has(chatId)) continue
          // A locally-registered job that the server has not yet indexed
          // must stay running — otherwise a 4s poll would "complete" a
          // Word job that just started.
          if (!seenOnServerRef.current.has(chatId)) continue
          const prev = next.get(chatId)
          if (prev?.status === "running") {
            next.set(chatId, { ...prev, status: "done" })
            changed = true
            toastedDoneRef.current.add(chatId)
          }
          knownRunningRef.current.delete(chatId)
          seenOnServerRef.current.delete(chatId)
        }

        if (changed) publish(next)
      } catch {
        /* poll is best-effort */
      }
    }
    void tick()
    const timer = window.setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isAuthenticated, publish])

  const runningChatIds = React.useMemo(
    () => Array.from(jobs.values()).filter((j) => j.status === "running").map((j) => j.chatId),
    [jobs],
  )

  const value = React.useMemo<Ctx>(() => ({
    jobs, runningChatIds, isRunning, register, complete, fail, dismiss, cancel, noteLeftChat, setWatchedChatId,
  }), [jobs, runningChatIds, isRunning, register, complete, fail, dismiss, cancel, noteLeftChat, setWatchedChatId])

  return (
    <BackgroundJobsContext.Provider value={value}>
      {children}
    </BackgroundJobsContext.Provider>
  )
}
