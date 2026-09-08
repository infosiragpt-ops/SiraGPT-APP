"use client"

/**
 * Persist which chats still have a server-side job after the UI leaves.
 * The SSE socket can drop; the job must keep running. On return we poll
 * /chats/:id until the assistant message (or a durable error) appears.
 */

const STORAGE_KEY = "siragpt:running-chat-jobs:v1"
const MAX_AGE_MS = 30 * 60 * 1000

export type RunningChatJob = {
  chatId: string
  kind: "doc" | "stream" | "agent"
  title: string
  startedAt: number
}

function readAll(): RunningChatJob[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter((item): item is RunningChatJob => (
      item
      && typeof item.chatId === "string"
      && item.chatId.length > 0
      && typeof item.startedAt === "number"
      && now - item.startedAt < MAX_AGE_MS
    ))
  } catch {
    return []
  }
}

function writeAll(jobs: RunningChatJob[]) {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(jobs))
  } catch {
    /* private mode */
  }
}

export function rememberRunningChatJob(job: RunningChatJob) {
  const next = readAll().filter((item) => item.chatId !== job.chatId)
  next.push(job)
  writeAll(next)
}

export function forgetRunningChatJob(chatId: string) {
  writeAll(readAll().filter((item) => item.chatId !== chatId))
}

export function listRunningChatJobs(): RunningChatJob[] {
  return readAll()
}
