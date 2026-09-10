/**
 * Compact work-state for a conversation row.
 *
 * working     — the agent is still doing the job
 * done        — that job just finished
 * needs_reply — a decision panel is waiting for the human (HITL)
 * error       — the job failed
 * idle        — nothing in flight
 *
 * `needs_reply` is only for a structured pause (permission, approval, or
 * clarifying questions). A greeting like "¿en qué te ayudo hoy?" is not HITL.
 */

export type ChatWorkStatus = "idle" | "working" | "done" | "needs_reply" | "error"

export type ChatDecisionKind = "permission" | "approval" | "clarification"

export type ChatDecisionOption = {
  id: string
  label: string
  description?: string
  recommended?: boolean
  replyText?: string
}

export type ChatDecisionRequest = {
  kind: ChatDecisionKind
  title: string
  body?: string
  questions: string[]
  options: ChatDecisionOption[]
  allowCustomReply: boolean
  permissionId?: string
  runId?: string
}

export type ChatAssistantRef = {
  content?: unknown
  metadata?: unknown
  agentPermission?: unknown
  agentRun?: { status?: string; id?: string } | null
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const raw = value.trim()
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* not JSON */
  }
  return null
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function readPermission(value: unknown): { permissionId: string; name: string; humanDescription?: string } | null {
  const record = asRecord(value)
  if (!record) return null
  const permissionId = asText(record.permissionId || record.id)
  if (!permissionId) return null
  const name = asText(record.name) || "herramienta"
  const humanDescription = asText(record.humanDescription) || undefined
  return { permissionId, name, humanDescription }
}

function normalizeOption(raw: unknown, index: number, recommendedIndex: number): ChatDecisionOption | null {
  if (typeof raw === "string") {
    const label = raw.trim()
    if (!label) return null
    return {
      id: `opt-${index}`,
      label,
      recommended: index === recommendedIndex,
      replyText: label,
    }
  }
  const record = asRecord(raw)
  if (!record) return null
  const label = asText(record.label || record.text || record.value || record.answer)
  if (!label) return null
  const recommended = record.recommended === true || index === recommendedIndex
  return {
    id: asText(record.id) || `opt-${index}`,
    label,
    description: asText(record.description) || undefined,
    recommended,
    replyText: asText(record.replyText) || label,
  }
}

function collectQuestionStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const text = asText(value)
    return text ? [text] : []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim()
      if (text) out.push(text)
      continue
    }
    const record = asRecord(item)
    if (!record) continue
    const text = asText(record.question || record.text || record.prompt || record.title)
    if (text) out.push(text)
  }
  return out
}

function collectOptionsFromPayload(payload: Record<string, unknown>): ChatDecisionOption[] {
  const buckets = [payload.options, payload.answers, payload.choices, payload.suggested_answers]
  for (const bucket of buckets) {
    if (!Array.isArray(bucket) || bucket.length === 0) continue
    const recommendedIndex = bucket.findIndex((item) => asRecord(item)?.recommended === true)
    const fallbackIndex = recommendedIndex >= 0 ? recommendedIndex : 0
    const options = bucket
      .map((item, index) => normalizeOption(item, index, fallbackIndex))
      .filter((item): item is ChatDecisionOption => Boolean(item))
    if (options.length) {
      if (!options.some((option) => option.recommended)) options[0].recommended = true
      return options
    }
  }
  if (Array.isArray(payload.questions)) {
    for (const question of payload.questions) {
      const record = asRecord(question)
      if (!record || !Array.isArray(record.options) || record.options.length === 0) continue
      const recommendedIndex = record.options.findIndex((item) => asRecord(item)?.recommended === true)
      const fallbackIndex = recommendedIndex >= 0 ? recommendedIndex : 0
      const options = record.options
        .map((item, index) => normalizeOption(item, index, fallbackIndex))
        .filter((item): item is ChatDecisionOption => Boolean(item))
      if (options.length) {
        if (!options.some((option) => option.recommended)) options[0].recommended = true
        return options
      }
    }
  }
  return []
}

function clarificationPayload(assistant: ChatAssistantRef | null | undefined): Record<string, unknown> | null {
  if (!assistant) return null
  const fromContent = asRecord(assistant.content)
  const fromMetadata = asRecord(assistant.metadata)
  const nestedContent = fromContent
    ? asRecord(fromContent.content) || asRecord(fromContent.message)
    : null
  const candidates = [fromContent, nestedContent, fromMetadata].filter(Boolean) as Record<string, unknown>[]
  for (const candidate of candidates) {
    if (
      Array.isArray(candidate.clarifying_questions)
      || Array.isArray(candidate.questions)
      || candidate.needs_clarification === true
      || candidate.ask_user === true
      || candidate.kind === "clarification"
      || candidate.stage === "needs_clarification"
    ) {
      return candidate
    }
  }
  return null
}

export function extractChatDecisionRequest(assistant: ChatAssistantRef | null | undefined): ChatDecisionRequest | null {
  if (!assistant) return null

  const permission = readPermission(assistant.agentPermission)
  if (permission) {
    return {
      kind: "permission",
      title: "El agente necesita tu decisión",
      body: permission.humanDescription,
      questions: [`El agente quiere usar ${permission.name}`],
      options: [
        { id: "allow", label: "Permitir", recommended: true, replyText: "Permitir" },
        { id: "always_allow_in_chat", label: "Permitir siempre en este chat", replyText: "Permitir siempre en este chat" },
        { id: "deny", label: "Denegar", replyText: "Denegar" },
      ],
      allowCustomReply: false,
      permissionId: permission.permissionId,
    }
  }

  const runStatus = String(assistant.agentRun?.status || "").toLowerCase()
  if (WAITING_TASK_STATUSES.has(runStatus)) {
    return {
      kind: "approval",
      title: "El agente necesita tu decisión",
      body: "El agente no puede continuar hasta que apruebes el siguiente paso.",
      questions: ["¿Apruebas que el agente continúe?"],
      options: [
        { id: "approve", label: "Aprobar y continuar", recommended: true, replyText: "Aprobado, continúa." },
        { id: "reject", label: "Rechazar", replyText: "Rechazado. No continúes." },
      ],
      allowCustomReply: true,
      runId: asText(assistant.agentRun?.id) || undefined,
    }
  }

  const payload = clarificationPayload(assistant)
  if (!payload) return null
  const questions = collectQuestionStrings(
    payload.clarifying_questions || payload.questions || payload.prompts,
  )
  const options = collectOptionsFromPayload(payload)
  if (!questions.length && !options.length) return null
  const resolvedOptions = options.length
    ? options
    : [{
        id: "continue",
        label: "Continuar con el criterio del agente",
        recommended: true,
        replyText: "Continúa con tu mejor criterio y toma la decisión por mí.",
      }]
  return {
    kind: "clarification",
    title: "El agente necesita tu decisión",
    body: asText(payload.text || payload.clarification_reason || payload.reason) || undefined,
    questions,
    options: resolvedOptions,
    allowCustomReply: true,
  }
}

export function lastMessageRole(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return ""
  const last = messages[messages.length - 1] as { role?: unknown }
  return String(last?.role || "").toLowerCase()
}

export function lastAssistantMessage(messages: unknown): ChatAssistantRef | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown }
    const role = String(message?.role || "").toLowerCase()
    if (role === "assistant" || role === "ai") {
      return messages[i] as ChatAssistantRef
    }
  }
  return null
}

export function extractChatDecisionRequestFromMessages(messages: unknown): ChatDecisionRequest | null {
  const assistant = lastAssistantMessage(messages)
  const request = extractChatDecisionRequest(assistant)
  if (!request) return null
  const role = lastMessageRole(messages)
  if ((role === "user" || role === "human") && request.kind === "clarification") return null
  return request
}

export function resolveChatWorkStatus(input: {
  streamStatus?: string | null
  streamContent?: string | null
  activeTaskStatus?: string | null
  lastMessageRole?: string | null
  lastAssistant?: ChatAssistantRef | null
}): ChatWorkStatus {
  const stream = String(input.streamStatus || "").toLowerCase()
  const task = String(input.activeTaskStatus || "").toLowerCase()
  const last = input.lastAssistant
  const runStatus = String(last?.agentRun?.status || "").toLowerCase()
  const waitingHitl =
    Boolean(readPermission(last?.agentPermission))
    || WAITING_TASK_STATUSES.has(runStatus)
    || WAITING_TASK_STATUSES.has(task)
  const decision = extractChatDecisionRequest(last)
  const lastRole = String(input.lastMessageRole || "").toLowerCase()
  const userAlreadyReplied = lastRole === "user" || lastRole === "human"

  if (stream === "streaming" && !waitingHitl && !decision) return "working"
  if (WORKING_TASK_STATUSES.has(task) && !waitingHitl) return "working"
  if (waitingHitl) return "needs_reply"
  if (decision && !userAlreadyReplied) return "needs_reply"
  if (stream === "error") return "error"
  if (stream === "done") return "done"
  return "idle"
}
