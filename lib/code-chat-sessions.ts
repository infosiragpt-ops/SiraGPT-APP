/**
 * Parallel code-agent chat sessions per workspace (localStorage).
 */

import { codexIdForProject } from "./codex-projects"
import type { AgentState } from "./code-agent/types"
import { defaultAgentState } from "./code-agent/types"

export type CodeChatTurn = {
  id: string
  role: "user" | "assistant"
  content: string
  streaming?: boolean
  /** Live Codex-style execution phases for the /code agent turn. */
  agentPhases?: CodeAgentPhase[]
  agentLabel?: string
  /** Real action log + Worked-Summary metrics for a turn that did file work. */
  actions?: import("./code-chat-metrics").CodeChatAction[]
  metrics?: import("./code-chat-metrics").CodeChatMetrics
  /** Real time (ms) from turn start to the first narrated line — the planning
   *  duration shown on the "🧠 …" badge. Measured, never fabricated. */
  planMs?: number
  /** Text voiced with the browser's built-in speech synthesis (Web Speech API,
   *  100% local — no API key, no server call). ChatBubble renders an inline
   *  voice player for turns that carry it (e.g. the greeting). */
  voice?: string
}

export type CodeAgentPhaseStatus = "pending" | "running" | "done" | "error"

export type CodeAgentPhase = {
  key: string
  label: string
  status: CodeAgentPhaseStatus
  detail?: string
}

export type CodeChatSession = {
  id: string
  workspaceId: string
  title: string
  turns: CodeChatTurn[]
  createdAt: number
  updatedAt: number
  /** When true the user renamed it manually — don't re-derive the title from turns. */
  titleLocked?: boolean
  /** FSM state of the /code agent for this session (intake → generate → debug). */
  agent?: AgentState
}

type SessionStore = {
  sessions: CodeChatSession[]
  activeByWorkspace: Record<string, string>
}

const STORAGE_KEY = "code-workspace:agent-sessions:v1"
const MAX_SESSIONS_PER_WORKSPACE = 12

export const CODE_CHAT_SESSIONS_UPDATED_EVENT = "siragpt:code-chat-sessions-updated"

// Version/variant-agnostic on purpose: legacy stores may hold ids whose
// version nibble isn't 1-5 (e.g. UUIDv7) — any 8-4-4-4-12 hex shape is a
// bare project id that must migrate to the canonical `project:` key.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Canonical workspace id for agent sessions (matches Codex tree node ids). */
export function codexWorkspaceSessionKey(folderId: string | null | undefined): string {
  const raw = folderId?.trim() || ""
  if (!raw) return "__default__"
  if (raw.startsWith("local:") || raw.startsWith("project:")) return raw
  if (UUID_RE.test(raw)) return codexIdForProject(raw)
  return raw
}

/** @deprecated Use codexWorkspaceSessionKey — kept for call-site compatibility. */
export function codeWorkspaceKey(folderId: string | null | undefined): string {
  return codexWorkspaceSessionKey(folderId)
}

function migrateSessionStore(parsed: SessionStore): SessionStore {
  const sessions = parsed.sessions.map((s) => {
    const key = codexWorkspaceSessionKey(s.workspaceId)
    return key === s.workspaceId ? s : { ...s, workspaceId: key }
  })
  const activeByWorkspace: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed.activeByWorkspace || {})) {
    activeByWorkspace[codexWorkspaceSessionKey(k)] = v
  }
  return { sessions, activeByWorkspace }
}

function storage(): Storage | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      return globalThis.localStorage as Storage
    }
  } catch {
    /* private mode */
  }
  return null
}

const PHASE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "done",
  "error",
])

// Deep-sanitize a single persisted turn. localStorage is untrusted: a session
// written by an OLDER build can carry malformed entries (e.g. a null action, an
// action with no `kind`, a half-populated phase) that newer render code assumes
// are well-formed — accessing a field off such an entry throws and crashes the
// whole /code page. We rebuild a clean turn and drop anything that isn't valid.
function sanitizeTurn(raw: unknown): CodeChatTurn | null {
  if (!raw || typeof raw !== "object") return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== "string") return null
  const role: "user" | "assistant" | null =
    t.role === "user" ? "user" : t.role === "assistant" ? "assistant" : null
  if (role === null) return null

  const turn: CodeChatTurn = {
    id: t.id,
    role,
    content: typeof t.content === "string" ? t.content : "",
  }
  if (typeof t.streaming === "boolean") turn.streaming = t.streaming
  if (typeof t.agentLabel === "string") turn.agentLabel = t.agentLabel
  if (typeof t.voice === "string" && t.voice) turn.voice = t.voice
  if (typeof t.planMs === "number" && Number.isFinite(t.planMs)) {
    turn.planMs = t.planMs
  }

  if (Array.isArray(t.agentPhases)) {
    // Rebuild each phase from scratch so a legacy/corrupt entry can't smuggle
    // a non-string `detail` (older builds occasionally stored an object) into
    // the renderer, which would throw "Objects are not valid as a React child".
    const phases: CodeAgentPhase[] = []
    for (const raw of t.agentPhases) {
      if (!raw || typeof raw !== "object") continue
      const p = raw as Record<string, unknown>
      if (typeof p.key !== "string" || typeof p.label !== "string") continue
      if (typeof p.status !== "string" || !PHASE_STATUSES.has(p.status)) continue
      const phase: CodeAgentPhase = {
        key: p.key,
        label: p.label,
        status: p.status as CodeAgentPhaseStatus,
      }
      if (typeof p.detail === "string") phase.detail = p.detail
      phases.push(phase)
    }
    if (phases.length > 0) turn.agentPhases = phases
  }

  if (Array.isArray(t.actions)) {
    // Rebuild each action as a clean {kind,label} pair. glyphForAction tolerates
    // any string kind (falls back to ">_"), so unknown kinds are kept, not dropped.
    const actions: import("./code-chat-metrics").CodeChatAction[] = []
    for (const raw of t.actions) {
      if (!raw || typeof raw !== "object") continue
      const a = raw as Record<string, unknown>
      if (typeof a.kind !== "string" || typeof a.label !== "string") continue
      actions.push({
        kind: a.kind as import("./code-chat-metrics").CodeChatActionKind,
        label: a.label,
      })
    }
    if (actions.length > 0) turn.actions = actions
  }

  if (t.metrics && typeof t.metrics === "object" && !Array.isArray(t.metrics)) {
    turn.metrics = t.metrics as import("./code-chat-metrics").CodeChatMetrics
  }

  return turn
}

// Sanitize a persisted session: validate the identity fields and rebuild its
// turns array, dropping any turn that can't be made safe to render.
function sanitizeSession(raw: unknown): CodeChatSession | null {
  if (!raw || typeof raw !== "object") return null
  const s = raw as Record<string, unknown>
  if (
    typeof s.id !== "string" ||
    typeof s.workspaceId !== "string" ||
    typeof s.title !== "string" ||
    !Array.isArray(s.turns)
  ) {
    return null
  }
  const turns = s.turns
    .map(sanitizeTurn)
    .filter((t): t is CodeChatTurn => t !== null)
  return { ...(s as unknown as CodeChatSession), turns }
}

function loadStore(): SessionStore {
  const store = storage()
  if (!store) return { sessions: [], activeByWorkspace: {} }
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return { sessions: [], activeByWorkspace: {} }
    const parsed = JSON.parse(raw) as SessionStore
    if (!Array.isArray(parsed.sessions)) return { sessions: [], activeByWorkspace: {} }
    const filtered: SessionStore = {
      sessions: parsed.sessions
        .map(sanitizeSession)
        .filter((s): s is CodeChatSession => s !== null),
      activeByWorkspace:
        parsed.activeByWorkspace && typeof parsed.activeByWorkspace === "object"
          ? parsed.activeByWorkspace
          : {},
    }
    return migrateSessionStore(filtered)
  } catch {
    return { sessions: [], activeByWorkspace: {} }
  }
}

function saveStore(store: SessionStore) {
  const s = storage()
  if (!s) return
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(store))
    if (typeof window !== "undefined") {
      // Defer the cross-component notification so it never fires during a
      // React render. saveStore is invoked from inside setState updaters
      // (e.g. ensureDefaultSession / setActiveCodeChatSession passed to
      // setChatSessionStore), which React runs in the render phase and
      // which must stay side-effect-free. Dispatching synchronously there
      // makes listeners (SidebarFoldersDropdown) call setState mid-render —
      // the "Cannot update a component while rendering a different
      // component" warning. The localStorage write above stays synchronous
      // so any immediate readCodeChatStore() still sees fresh data; only
      // the event is pushed past the current render/commit.
      const fire = () => {
        try {
          window.dispatchEvent(new CustomEvent(CODE_CHAT_SESSIONS_UPDATED_EVENT))
        } catch {
          /* noop */
        }
      }
      // A microtask can run before React commits a concurrent render. That is
      // still re-entrant when saveStore is reached from a state updater and can
      // keep a fresh workspace in an endless render/restart cycle. A task runs
      // after the current React work has yielded and committed.
      window.setTimeout(fire, 0)
    }
  } catch {
    /* quota */
  }
}

export function readCodeChatStore(): SessionStore {
  return loadStore()
}

export function listSessionsForWorkspace(workspaceId: string, store = loadStore()): CodeChatSession[] {
  const key = codexWorkspaceSessionKey(workspaceId)
  return store.sessions
    .filter((s) => s.workspaceId === key)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getActiveSessionId(workspaceId: string, store = loadStore()): string | null {
  const key = codexWorkspaceSessionKey(workspaceId)
  const active = store.activeByWorkspace[key]
  if (active && store.sessions.some((s) => s.id === active && s.workspaceId === key)) {
    return active
  }
  const first = listSessionsForWorkspace(key, store)[0]
  return first?.id ?? null
}

export function createCodeChatSessionId(): string {
  return `code-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export function ensureDefaultSession(workspaceId: string, store = loadStore()): SessionStore {
  const key = codexWorkspaceSessionKey(workspaceId)
  const existing = listSessionsForWorkspace(key, store)
  if (existing.length > 0) {
    const activeId = getActiveSessionId(key, store)
    if (activeId) return store
    return {
      ...store,
      activeByWorkspace: { ...store.activeByWorkspace, [key]: existing[0].id },
    }
  }
  const session: CodeChatSession = {
    id: createCodeChatSessionId(),
    workspaceId: key,
    title: "Agente 1",
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    agent: defaultAgentState(),
  }
  const next: SessionStore = {
    sessions: [...store.sessions, session],
    activeByWorkspace: { ...store.activeByWorkspace, [key]: session.id },
  }
  saveStore(next)
  return next
}

export function createCodeChatSession(
  workspaceId: string,
  opts?: { title?: string; id?: string },
  store = loadStore(),
): { store: SessionStore; session: CodeChatSession } {
  const key = codexWorkspaceSessionKey(workspaceId)
  const ensured = ensureDefaultSession(key, store)
  const count = listSessionsForWorkspace(key, ensured).length
  const session: CodeChatSession = {
    id: opts?.id || createCodeChatSessionId(),
    workspaceId: key,
    title: opts?.title?.trim() || `Agente ${count + 1}`,
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    titleLocked: Boolean(opts?.title?.trim()),
    agent: defaultAgentState(),
  }
  let sessions = [...ensured.sessions, session]
  const perWs = sessions.filter((s) => s.workspaceId === key)
  if (perWs.length > MAX_SESSIONS_PER_WORKSPACE) {
    const drop = perWs[MAX_SESSIONS_PER_WORKSPACE - 1]
    sessions = sessions.filter((s) => s.id !== drop.id)
  }
  const next: SessionStore = {
    sessions,
    activeByWorkspace: { ...ensured.activeByWorkspace, [key]: session.id },
  }
  saveStore(next)
  return { store: next, session }
}

export function setActiveCodeChatSession(
  workspaceId: string,
  sessionId: string,
  store = loadStore(),
): SessionStore {
  const key = codexWorkspaceSessionKey(workspaceId)
  if (!store.sessions.some((s) => s.id === sessionId && s.workspaceId === key)) return store
  const next = {
    ...store,
    activeByWorkspace: { ...store.activeByWorkspace, [key]: sessionId },
  }
  saveStore(next)
  return next
}

export function deriveCodeChatSessionTitle(turns: CodeChatTurn[]): string {
  const first = turns.find((t) => t.role === "user" && t.content.trim())
  if (!first) return "Nuevo chat"
  const line = first.content.trim().split("\n")[0]?.trim() || "Nuevo chat"
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

export function updateCodeChatSessionTurns(
  sessionId: string,
  updater: (prev: CodeChatTurn[]) => CodeChatTurn[],
  store = loadStore(),
): SessionStore {
  const next: SessionStore = {
    ...store,
    sessions: store.sessions.map((s) => {
      if (s.id !== sessionId) return s
      const turns = updater(s.turns)
      // A manually renamed session keeps its title; otherwise derive from turns.
      const title = s.titleLocked ? s.title : deriveCodeChatSessionTitle(turns)
      return { ...s, turns, title, updatedAt: Date.now() }
    }),
  }
  saveStore(next)
  return next
}

/** Patch the agent FSM state of a session (persists immediately). */
export function updateCodeChatSessionAgent(
  sessionId: string,
  updater: (prev: AgentState) => AgentState,
  store = loadStore(),
): SessionStore {
  const next: SessionStore = {
    ...store,
    sessions: store.sessions.map((s) => {
      if (s.id !== sessionId) return s
      const agent = updater(s.agent ?? defaultAgentState())
      return { ...s, agent, updatedAt: Date.now() }
    }),
  }
  saveStore(next)
  return next
}

/** Manually rename a session. Locks the title against turn-derived updates. */
export function renameCodeChatSession(
  sessionId: string,
  title: string,
  store = loadStore(),
): SessionStore {
  const clean = title.trim().slice(0, 80)
  if (!clean) return store
  const next: SessionStore = {
    ...store,
    sessions: store.sessions.map((s) =>
      s.id === sessionId ? { ...s, title: clean, titleLocked: true, updatedAt: Date.now() } : s,
    ),
  }
  saveStore(next)
  return next
}

/** Delete a session, reassigning the workspace's active session when needed. */
export function deleteCodeChatSession(sessionId: string, store = loadStore()): SessionStore {
  const target = store.sessions.find((s) => s.id === sessionId)
  if (!target) return store
  const sessions = store.sessions.filter((s) => s.id !== sessionId)
  const activeByWorkspace = { ...store.activeByWorkspace }
  if (activeByWorkspace[target.workspaceId] === sessionId) {
    const fallback = sessions.find((s) => s.workspaceId === target.workspaceId)
    if (fallback) activeByWorkspace[target.workspaceId] = fallback.id
    else delete activeByWorkspace[target.workspaceId]
  }
  const next: SessionStore = { sessions, activeByWorkspace }
  saveStore(next)
  return next
}
