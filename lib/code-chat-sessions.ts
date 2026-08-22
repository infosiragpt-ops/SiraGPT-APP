/**
 * Parallel code-agent chat sessions per workspace (localStorage).
 */

import type { AgentState } from "./code-agent/types"

import { defaultAgentState } from "./code-agent/types"
import { canonicalCodexWorkspaceId } from "./codex-workspace-identity"
import type { CodexTurnCancellationState } from "./codex/turn-cancellation"

export type CodeChatTurn = {
  id: string
  role: "user" | "assistant"
  content: string
  streaming?: boolean
  /** Durable Codex run represented by this bubble, used for reload recovery. */
  codexRunId?: string
  /** Live Codex-style execution phases for the /code agent turn. */
  agentPhases?: CodeAgentPhase[]
  agentLabel?: string
  /** Durable stop lifecycle. A turn is terminal only after `cancelled`. */
  cancellationState?: CodexTurnCancellationState
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

/** Payload of CODE_CHAT_SESSIONS_UPDATED_EVENT. `activeSessionId` lets each
 *  listener ignore echoes of the session it just wrote itself (F4/H1). */
export type CodeChatSessionsUpdatedDetail = {
  /** Session whose write triggered the event, when known. */
  activeSessionId?: string
}

type SessionStore = {
  sessions: CodeChatSession[]
  activeByWorkspace: Record<string, string>
}

const STORAGE_KEY = "code-workspace:agent-sessions:v1"
const MAX_SESSIONS_PER_WORKSPACE = 12

export const CODE_CHAT_SESSIONS_UPDATED_EVENT = "siragpt:code-chat-sessions-updated"

/** Canonical workspace id for agent sessions (matches Codex tree node ids). */
export function codexWorkspaceSessionKey(folderId: string | null | undefined): string {
  return canonicalCodexWorkspaceId(folderId)
}

/** @deprecated Use codexWorkspaceSessionKey — kept for call-site compatibility. */
export function codeWorkspaceKey(folderId: string | null | undefined): string {
  return codexWorkspaceSessionKey(folderId)
}

function migrateSessionStore(parsed: SessionStore): SessionStore {
  const sessions = parsed.sessions.map((s) => {
    const key = codexWorkspaceSessionKey(s.workspaceId)
    // Empty legacy workspaces shipped with the generic "Agente 1" label. Give
    // only untouched sessions the executive entry-point name; any real chat or
    // user-locked title remains exactly as the user left it.
    const title = s.title === "Agente 1" && s.turns.length === 0 && !s.titleLocked
      ? "CEO Office"
      : s.title
    return key === s.workspaceId && title === s.title ? s : { ...s, workspaceId: key, title }
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

/**
 * F4/H1 — debounce localStorage persistence of the session store.
 *
 * During a Codex stream every batch used to run the full
 * `JSON.stringify(store) + setItem` synchronously (200–500 ms blocked per
 * second of streaming, measured at production-main 1a2b10e65). Writes are now
 * coalesced behind a trailing timer; `flushCodeChatStorePersistence()` makes
 * the write durable immediately for unload and explicit-session-change paths.
 *
 * The timer lives on globalThis so tests can drive it with fake timers and so
 * the module keeps a single scheduler regardless of how many call sites save.
 */
const CODE_CHAT_PERSIST_DEBOUNCE_MS = 1000

type CodeChatPersistScheduler = {
  pendingStore: SessionStore | null
  timer: ReturnType<typeof setTimeout> | null
}

function codeChatPersistScheduler(): CodeChatPersistScheduler {
  const g = globalThis as typeof globalThis & { __codeChatPersistScheduler?: CodeChatPersistScheduler }
  if (!g.__codeChatPersistScheduler) {
    g.__codeChatPersistScheduler = { pendingStore: null, timer: null }
  }
  return g.__codeChatPersistScheduler
}

/** Write the store to localStorage right now (used by flush paths). */
function writeStoreNow(store: SessionStore): boolean {
  const s = storage()
  if (!s) return false
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(store))
    return true
  } catch {
    /* quota */
    return false
  }
}

/**
 * Fire the cross-component notification outside React's render/commit work.
 * saveStore runs inside setState updaters (ensureDefaultSession /
 * setActiveCodeChatSession passed to setChatSessionStore), which React runs in
 * the render phase and which must stay side-effect-free. A microtask can still
 * run before a concurrent render commits and re-enter it; a task runs after
 * React work has yielded.
 */
function scheduleUpdatedEvent() {
  try {
    window.setTimeout(() => {
      try {
        window.dispatchEvent(new CustomEvent(CODE_CHAT_SESSIONS_UPDATED_EVENT))
      } catch {
        /* noop */
      }
    }, 0)
  } catch {
    /* noop */
  }
}

/**
 * Flush any debounced persistence immediately. Wired to pagehide/beforeunload
 * below so a tab close or navigation never loses the last coalesced writes;
 * also exported for explicit flush points (e.g. switching sessions).
 */
export function flushCodeChatStorePersistence() {
  const sched = codeChatPersistScheduler()
  if (sched.timer !== null) {
    clearTimeout(sched.timer)
    sched.timer = null
  }
  const pending = sched.pendingStore
  if (!pending) return
  sched.pendingStore = null
  writeStoreNow(pending)
}

/** Trailing debounce window (ms) — exported for tests and flush call sites. */
export const CODE_CHAT_PERSIST_DEBOUNCE_MS_EXPORT = CODE_CHAT_PERSIST_DEBOUNCE_MS

if (typeof window !== "undefined") {
  // pagehide covers tab close, navigation, and mobile backgrounding;
  // beforeunload is the belt-and-suspenders desktop fallback.
  try {
    window.addEventListener("pagehide", flushCodeChatStorePersistence)
    window.addEventListener("beforeunload", flushCodeChatStorePersistence)
  } catch {
    /* very old engines */
  }
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
  if (typeof t.codexRunId === "string" && t.codexRunId) turn.codexRunId = t.codexRunId
  if (typeof t.agentLabel === "string") turn.agentLabel = t.agentLabel
  if (t.cancellationState === "cancelling" || t.cancellationState === "failed" || t.cancellationState === "cancelled") {
    turn.cancellationState = t.cancellationState
  }
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

function saveStore(store: SessionStore, detail?: CodeChatSessionsUpdatedDetail) {
  // F4/H1 — coalesce writes: keep only the newest store and restart the
  // trailing timer. A burst of stream batches costs one timer bump each
  // (nanoseconds) instead of a full synchronous serialize per batch; the
  // single trailing write lands DEBOUNCE_MS after the last mutation.
  const sched = codeChatPersistScheduler()
  sched.pendingStore = store
  if (sched.timer !== null) clearTimeout(sched.timer)
  sched.timer = setTimeout(() => {
    sched.timer = null
    const pending = sched.pendingStore
    if (!pending) return
    sched.pendingStore = null
    writeStoreNow(pending)
  }, CODE_CHAT_PERSIST_DEBOUNCE_MS)
  if (typeof window !== "undefined") {
    // Cross-component notification (SidebarFoldersDropdown). Listeners that
    // belong to the surface which just wrote re-parse storage for nothing;
    // they pass their active session id so they can skip their own echo
    // (see notifyCodeChatStoreExternally).
    try {
      window.setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent(CODE_CHAT_SESSIONS_UPDATED_EVENT, { detail }))
        } catch {
          /* noop */
        }
      }, 0)
    } catch {
      /* noop */
    }
  }
}

/**
 * F4/H1 — re-notify surfaces that skipped their own echo.
 *
 * saveStore always fires CODE_CHAT_SESSIONS_UPDATED_EVENT so every listener
 * (provider context, SidebarFoldersDropdown) stays correct. Listeners may pass
 * the session they just wrote to storage; for that session the notification is
 * a pure echo (the writer already holds the new store in React state), and
 * re-parsing the whole localStorage blob on every stream batch was half of the
 * measured 200–500 ms/s hot path. Call this only when an EXTERNAL change to a
 * session must be pushed onto a surface that ignored its own echoes — e.g.
 * after a background agent finished mutating a session that a mounted panel
 * has open. Never call it from the same tick as the mutation it mirrors: the
 * event fires via setTimeout(0) and would then run before this one.
 */
export function notifyCodeChatStoreExternally(activeSessionId?: string) {
  if (typeof window === "undefined") return
  window.setTimeout(() => {
    try {
      window.dispatchEvent(
        new CustomEvent<CodeChatSessionsUpdatedDetail>(CODE_CHAT_SESSIONS_UPDATED_EVENT, {
          detail: { activeSessionId },
        }),
      )
    } catch {
      /* noop */
    }
  }, 0)
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
    title: "CEO Office",
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
  saveStore(next, { activeSessionId: sessionId })
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
  saveStore(next, { activeSessionId: sessionId })
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


/** OLA200_WAVE_G FE-082 — persist the active session id; refresh must not spawn a duplicate chat. */
export function persistActiveSessionId(workspaceId: string, sessionId: string, store = loadStore()) {
  return setActiveCodeChatSession(workspaceId, sessionId, store)
}
export function reusePersistedSessionOnRefresh(workspaceId: string, store = loadStore()) {
  const ensured = ensureDefaultSession(workspaceId, store)
  const id = getActiveSessionId(workspaceId, ensured)
  if (!id) return null
  return ensured.sessions.find((s) => s.id === id) || null
}
export function shouldCreateSessionOnRefresh(workspaceId: string, store = loadStore()): boolean {
  return listSessionsForWorkspace(workspaceId, store).length === 0
}
