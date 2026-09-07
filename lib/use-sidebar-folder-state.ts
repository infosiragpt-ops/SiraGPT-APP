"use client"

import * as React from "react"
import { apiClient } from "./api"
import { CHAT_FOLDERS_STORAGE_KEY, CHAT_FOLDER_NAMES_STORAGE_KEY, isSameChatFolder, parseChatFolderNameList } from "./sidebar-chat-folders"
import {
  SIDEBAR_FOLDER_MIGRATION_KEY,
  SIDEBAR_FOLDER_LEGACY_NAMES_KEY,
  SIDEBAR_FOLDER_SETTINGS_KEY,
  deserializeSidebarFolderState,
  emptySidebarFolderState,
  isSidebarFolderSnapshot,
  importLegacyFolderNames,
  migrateLegacySidebarFolders,
  normalizeSidebarFolderState,
  serializeSidebarFolderState,
  sidebarFolderCacheKey,
  sidebarFolderMigrationLedgerKey,
  type SidebarFolderSnapshot,
  type SidebarFolderState,
} from "./sidebar-folder-state"

type Session = {
  userId: string
  cancelled: boolean
  hydrated: boolean
  hydrating: boolean
  state: SidebarFolderState
  revision: number
  savedRevision: number
  inFlight: boolean
  timer: ReturnType<typeof setTimeout> | null
  migrationEligible: boolean
  migratedChatIds: Set<string>
  pendingMigrationIds: Set<string>
  lastRemote: SidebarFolderSnapshot | null
  legacyNames: string[]
  legacyImportPending: boolean
}

function readStorage(key: string): unknown {
  try { return JSON.parse(window.localStorage.getItem(key) || "null") } catch { return null }
}

function readIdList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && Boolean(id)))] : []
}

function cache(session: Session) {
  try {
    window.localStorage.setItem(sidebarFolderCacheKey(session.userId), JSON.stringify({
      snapshot: serializeSidebarFolderState(session.state),
      pending: session.revision !== session.savedRevision,
      base: session.lastRemote,
      legacyImportPending: session.legacyImportPending,
      pendingMigrationIds: [...session.pendingMigrationIds],
    }))
  } catch { /* The server remains authoritative when browser storage is unavailable. */ }
}

function readCache(userId: string): { snapshot: unknown; pending: boolean; base: unknown; legacyImportPending: boolean; pendingMigrationIds: string[] } {
  const value = readStorage(sidebarFolderCacheKey(userId))
  // Accept the initial v1 direct snapshot as well as the pending-write envelope.
  if (isSidebarFolderSnapshot(value)) return { snapshot: value, pending: false, base: null, legacyImportPending: false, pendingMigrationIds: [] }
  const stored = value as { snapshot?: unknown; pending?: unknown; base?: unknown; legacyImportPending?: unknown; pendingMigrationIds?: unknown } | null
  return { snapshot: stored?.snapshot, pending: stored?.pending === true, base: stored?.base ?? null, legacyImportPending: stored?.legacyImportPending === true, pendingMigrationIds: readIdList(stored?.pendingMigrationIds) }
}

export function useSidebarFolderState(userId: string | undefined, knownChatIds: string[]) {
  const activeUser = React.useRef(userId)
  activeUser.current = userId
  const knownIds = React.useRef(knownChatIds)
  knownIds.current = knownChatIds
  const sessionRef = React.useRef<Session | null>(null)
  const [view, setView] = React.useState<{
    userId?: string; ready: boolean; saving: boolean; error: string | null; state: SidebarFolderState
  }>({ ready: false, saving: false, error: null, state: emptySidebarFolderState() })

  const isCurrent = React.useCallback((session: Session) => (
    !session.cancelled && sessionRef.current === session && activeUser.current === session.userId
  ), [])

  const flush = React.useCallback(async (session: Session) => {
    if (!isCurrent(session) || !session.hydrated || session.inFlight || session.revision === session.savedRevision) return
    if (session.timer) { clearTimeout(session.timer); session.timer = null }
    session.inFlight = true
    setView(prev => ({ ...prev, saving: true, error: null }))
    try {
      // Serialize writes. Edits made while a request is running remain in the
      // session and are included in the next request, never an older response.
      while (isCurrent(session) && session.revision !== session.savedRevision) {
        const revision = session.revision
        const snapshot = serializeSidebarFolderState(session.state)
        const migrationIds = [...session.pendingMigrationIds]
        const legacyImportPending = session.legacyImportPending
        await apiClient.updateUserSettings({ [SIDEBAR_FOLDER_SETTINGS_KEY]: snapshot })
        if (!isCurrent(session)) return
        session.savedRevision = revision
        session.lastRemote = snapshot
        cache(session)
        if (migrationIds.length) {
          try {
            const committed = new Set(readIdList(readStorage(sidebarFolderMigrationLedgerKey(session.userId))))
            for (const id of migrationIds) committed.add(id)
            window.localStorage.setItem(sidebarFolderMigrationLedgerKey(session.userId), JSON.stringify([...committed]))
            window.localStorage.setItem(SIDEBAR_FOLDER_MIGRATION_KEY, JSON.stringify(session.userId))
            for (const id of migrationIds) session.pendingMigrationIds.delete(id)
          } catch { /* Keep the pending ledger in the account cache for recovery. */ }
          cache(session)
        }
        if (legacyImportPending) {
          try { window.localStorage.setItem(SIDEBAR_FOLDER_LEGACY_NAMES_KEY, JSON.stringify(session.userId)) } catch { /* optional cache */ }
          session.legacyImportPending = false
          session.legacyNames = []
          cache(session)
        }
      }
      if (isCurrent(session)) setView(prev => ({ ...prev, saving: false, error: null }))
    } catch {
      if (isCurrent(session)) setView(prev => ({ ...prev, saving: false, error: "No se pudieron sincronizar las carpetas. Los cambios siguen en este navegador." }))
    } finally {
      session.inFlight = false
    }
  }, [isCurrent])

  const schedule = React.useCallback((session: Session) => {
    if (!isCurrent(session)) return
    if (session.timer) clearTimeout(session.timer)
    setView(prev => ({ ...prev, saving: true, error: null }))
    session.timer = setTimeout(() => { session.timer = null; void flush(session) }, 400)
  }, [flush, isCurrent])

  const tryMigration = React.useCallback((session: Session) => {
    if (!isCurrent(session) || !session.hydrated || !session.migrationEligible || !knownIds.current.length) return
    const owner = readStorage(SIDEBAR_FOLDER_MIGRATION_KEY)
    if (owner && owner !== session.userId) { session.migrationEligible = false; return }
    const unprocessedIds = knownIds.current.filter(id => !session.migratedChatIds.has(id))
    const legacy = migrateLegacySidebarFolders(readStorage(CHAT_FOLDERS_STORAGE_KEY), unprocessedIds)
    if (!legacy.names.length) return
    for (const id of Object.keys(legacy.assignments)) {
      session.migratedChatIds.add(id)
      session.pendingMigrationIds.add(id)
    }
    session.state = normalizeSidebarFolderState({
      ...session.state,
      assignments: { ...legacy.assignments, ...session.state.assignments },
      names: [...session.state.names, ...legacy.names],
    })
    session.revision += 1
    cache(session)
    setView(prev => ({ ...prev, state: session.state }))
    schedule(session)
  }, [isCurrent, schedule])

  const hydrate = React.useCallback(async (session: Session) => {
    if (!isCurrent(session) || session.hydrating) return
    session.hydrating = true
    setView(prev => ({ ...prev, ready: false, error: null }))
    try {
      const response = await apiClient.getUserSettings()
      if (!isCurrent(session)) return
      if (!response?.settings || typeof response.settings !== "object") throw new Error("Invalid settings response")
      const remote = response.settings[SIDEBAR_FOLDER_SETTINGS_KEY]
      if (remote != null && !isSidebarFolderSnapshot(remote)) throw new Error("Unsupported folder settings")
      const cached = readCache(session.userId)
      const hasRemote = isSidebarFolderSnapshot(remote)
      const hasPending = cached.pending && isSidebarFolderSnapshot(cached.snapshot)
      const conflict = hasPending && JSON.stringify(cached.base) !== JSON.stringify(remote ?? null)
      session.state = deserializeSidebarFolderState(hasPending ? cached.snapshot : hasRemote ? remote : cached.snapshot)
      session.lastRemote = hasPending
        ? (isSidebarFolderSnapshot(cached.base) ? cached.base : null)
        : (hasRemote ? remote : null)
      session.hydrated = true
      session.legacyImportPending = hasPending && cached.legacyImportPending
      session.pendingMigrationIds = new Set(cached.pendingMigrationIds)
      session.migratedChatIds = new Set([
        ...readIdList(readStorage(sidebarFolderMigrationLedgerKey(session.userId))),
        ...cached.pendingMigrationIds,
      ])
      const migrationOwner = readStorage(SIDEBAR_FOLDER_MIGRATION_KEY)
      session.migrationEligible = !conflict && ((!hasRemote && !migrationOwner) || migrationOwner === session.userId)
      setView({
        userId: session.userId, ready: true, saving: false, state: session.state,
        error: conflict ? "Hay cambios locales pendientes y otra versión en tu cuenta. Reintenta para guardar la versión de este navegador." : null,
      })
      if (hasPending || (!hasRemote && isSidebarFolderSnapshot(cached.snapshot))) {
        session.revision += 1
        if (!conflict) schedule(session)
      }
      cache(session)
      if (!conflict) tryMigration(session)
    } catch {
      if (isCurrent(session)) setView(prev => ({ ...prev, ready: false, saving: false, error: "No se pudieron cargar las carpetas de tu cuenta. Reintenta para continuar." }))
    } finally {
      session.hydrating = false
    }
  }, [isCurrent, schedule, tryMigration])

  React.useEffect(() => {
    if (!userId) {
      sessionRef.current = null
      setView({ ready: false, saving: false, error: null, state: emptySidebarFolderState() })
      return
    }
    const session: Session = {
      userId, cancelled: false, hydrated: false, hydrating: false,
      state: emptySidebarFolderState(), revision: 0, savedRevision: 0,
      inFlight: false, timer: null, migrationEligible: false,
      migratedChatIds: new Set(), pendingMigrationIds: new Set(),
      lastRemote: null,
      legacyNames: readStorage(SIDEBAR_FOLDER_LEGACY_NAMES_KEY) ? [] : parseChatFolderNameList(readStorage(CHAT_FOLDER_NAMES_STORAGE_KEY)),
      legacyImportPending: false,
    }
    sessionRef.current = session
    setView({ userId, ready: false, saving: false, error: null, state: session.state })
    void hydrate(session)
    return () => {
      session.cancelled = true
      if (session.timer) clearTimeout(session.timer)
    }
  }, [userId, hydrate])

  React.useEffect(() => {
    const session = sessionRef.current
    if (session) tryMigration(session)
  }, [knownChatIds, tryMigration])

  const update = React.useCallback((updater: (current: SidebarFolderState) => SidebarFolderState) => {
    const session = sessionRef.current
    if (!session || !isCurrent(session) || !session.hydrated) return
    session.state = normalizeSidebarFolderState(updater(session.state))
    session.revision += 1
    cache(session)
    setView(prev => ({ ...prev, state: session.state }))
    schedule(session)
  }, [isCurrent, schedule])

  const retry = React.useCallback(() => {
    const session = sessionRef.current
    if (!session || !isCurrent(session)) return
    if (session.hydrated) void flush(session)
    else void hydrate(session)
  }, [flush, hydrate, isCurrent])

  const importLegacyNames = React.useCallback(() => {
    const session = sessionRef.current
    if (!session || !isCurrent(session) || !session.hydrated || !session.legacyNames.length) return
    session.legacyImportPending = true
    update(current => importLegacyFolderNames(current, session.legacyNames))
  }, [isCurrent, update])

  const currentSession = sessionRef.current
  const legacyNames = currentSession && isCurrent(currentSession) && currentSession.hydrated
    ? currentSession.legacyNames.filter(name => !view.state.names.some(current => isSameChatFolder(current, name)))
    : []

  return {
    ...(view.userId === userId ? view : { ready: false, saving: false, error: null, state: emptySidebarFolderState() }),
    update,
    retry,
    legacyNames,
    importLegacyNames,
  }
}
