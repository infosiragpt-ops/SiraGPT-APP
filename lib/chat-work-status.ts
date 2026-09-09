/**
 * Compact work-state for a conversation row.
 *
 * working     — the agent is still doing the job
 * done        — that job just finished
 * needs_reply — the agent is waiting for the user to answer in the chat
 * error       — the job failed
 * idle        — nothing in flight
 */

export type ChatWorkStatus = "idle" | "working" | "done" | "needs_reply" | "error"

const WORKING_TASK_STATUSES = new Set([
  "queued",
  "running",
  "planning",
  "executing",
  "verifying",
  "shipping",
  "in_progress",
  "streaming",
])

const WAITING_TASK_STATUSES = new Set([
  "waiting_approval",
  "paused",
  "blocked",
  "needs_input",
  "awaiting_user",
  "waiting",
  "pending_approval",
  "approval",
])

export function assistantAsksUser(content: unknown): boolean {
  const raw = String(content || "").trim()
  if (!raw) return false
  const last = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || raw
  if (/[?¿]\s*$/.test(last)) return true
  return /^(¿|puedes|podrías|quieres|confirma|dime|responde|me puedes|me podrías)\b/i.test(last)
}

export function lastAssistantMessage(messages: unknown): {
  content?: unknown
  agentPermission?: unknown
  agentRun?: { status?: string } | null
} | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown }
    const role = String(message?.role || "").toLowerCase()
    if (role === "assistant" || role === "ai") {
      return messages[i] as {
        content?: unknown
        agentPermission?: unknown
        agentRun?: { status?: string } | null
      }
    }
  }
  return null
}

export function resolveChatWorkStatus(input: {
  streamStatus?: string | null
  streamContent?: string | null
  activeTaskStatus?: string | null
  lastAssistant?: {
    content?: unknown
    agentPermission?: unknown
    agentRun?: { status?: string } | null
  } | null
}): ChatWorkStatus {
  const stream = String(input.streamStatus || "").toLowerCase()
  if (stream === "streaming") return "working"

  const task = String(input.activeTaskStatus || "").toLowerCase()
  if (WORKING_TASK_STATUSES.has(task)) return "working"

  const last = input.lastAssistant
  const runStatus = String(last?.agentRun?.status || "").toLowerCase()
  if (last?.agentPermission || WAITING_TASK_STATUSES.has(runStatus) || WAITING_TASK_STATUSES.has(task)) {
    return "needs_reply"
  }
  if (assistantAsksUser(last?.content) || (stream === "done" && assistantAsksUser(input.streamContent))) {
    return "needs_reply"
  }
  if (stream === "error") return "error"
  if (stream === "done") return "done"
  return "idle"
}
