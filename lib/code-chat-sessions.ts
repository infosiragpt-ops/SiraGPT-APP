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

function loadStore(): SessionStore {
  const store = storage()
  if (!store) return { sessions: [], activeByWorkspace: {} }
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return { sessions: [], activeByWorkspace: {} }
    const parsed = JSON.parse(raw) as SessionStore
    if (!Array.isArray(parsed.sessions)) return { sessions: [], activeByWorkspace: {} }
    const filtered: SessionStore = {
      sessions: parsed.sessions.filter(
        (s): s is CodeChatSession =>
          Boolean(s)
          && typeof s.id === "string"
          && typeof s.workspaceId === "string"
          && typeof s.title === "string"
          && Array.isArray(s.turns),
      ),
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
      if (typeof queueMicrotask === "function") queueMicrotask(fire)
      else setTimeout(fire, 0)
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
    id: `code-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
  opts?: { title?: string },
  store = loadStore(),
): { store: SessionStore; session: CodeChatSession } {
  const key = codexWorkspaceSessionKey(workspaceId)
  const ensured = ensureDefaultSession(key, store)
  const count = listSessionsForWorkspace(key, ensured).length
  const session: CodeChatSession = {
    id: `code-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    workspaceId: key,
    title: opts?.title?.trim() || `Agente ${count + 1}`,
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
