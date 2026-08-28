"use client"

/**
 * useAppPins — conversation-scoped persistent app pins (spec §5).
 *
 * Three layers:
 *   A. Server (source of truth): GET/PUT /chats/:id/pins
 *   B. Local draft pins (pre-first-message): localStorage apps.pins.draft.<id>
 *   C. Optimistic store value rendered by PinnedAppRail.
 *
 * Unpin never touches the OAuth connection. Pins survive reloads, model
 * switches and every subsequent message until explicitly closed.
 */

import * as React from "react"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getNormalizedApiBaseUrl } from "@/lib/api-base-url"
import {
  MAX_PINS,
  canAddPin,
  readDraftPins,
  writeDraftPins,
  type PinValidationError,
} from "@/lib/apps-pins"

const PIN_FEATURE_FLAG_KEY = "apps.pins.enabled"

export function appsPinsEnabled(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(PIN_FEATURE_FLAG_KEY) !== "0"
  } catch {
    return true
  }
}

/** Server-declared feature flag (SIRAGPT_APPS_PERSISTENT_PINS). */
export async function fetchAppsPinsEnabled(): Promise<boolean> {
  try {
    const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/apps`, {
      credentials: "include",
      headers: authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return appsPinsEnabled()
    const body = await res.json().catch(() => ({})) as { pinsEnabled?: unknown }
    return body.pinsEnabled !== false
  } catch {
    return appsPinsEnabled()
  }
}

function authHeaders() {
  if (typeof window === "undefined") return { "Content-Type": "application/json" }
  const token = window.localStorage.getItem("auth-token")
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export interface UseAppPinsResult {
  /** Effective pins for the current conversation (visual order). */
  pinnedAppIds: string[]
  /** Monotonic server revision — echoed as If-Match on writes. */
  revision: number
  /** True while a server sync is in flight. */
  syncing: boolean
  /** Server-declared feature flag — rail hidden when false. */
  enabled: boolean
  /** Last rejection reason, cleared on the next successful mutation. */
  lastRejection: { appId: string; code: PinValidationError | string } | null
  pinApp: (appId: string) => Promise<boolean>
  unpinApp: (appId: string) => Promise<void>
  replacePins: (pins: string[]) => Promise<void>
}

export function useAppPins(conversationId: string | null | undefined): UseAppPinsResult {
  const { isAuthenticated } = useAuth()
  const [pinnedAppIds, setPinnedAppIds] = React.useState<string[]>([])
  const [revision, setRevision] = React.useState(0)
  const [syncing, setSyncing] = React.useState(false)
  const [enabled, setEnabled] = React.useState(true)
  const [lastRejection, setLastRejection] = React.useState<UseAppPinsResult["lastRejection"]>(null)
  const conversationRef = React.useRef<string | null | undefined>(conversationId)
  conversationRef.current = conversationId
  const pinsRef = React.useRef<string[]>([])
  pinsRef.current = pinnedAppIds
  const revisionRef = React.useRef(0)
  revisionRef.current = revision

  // Server-declared feature flag (one-time check; kill switch on the backend).
  React.useEffect(() => {
    let cancelled = false
    void fetchAppsPinsEnabled().then((value) => {
      if (!cancelled) setEnabled(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Hydrate when the conversation changes: server pins for real chats,
  // localStorage draft pins before the first message.
  React.useEffect(() => {
    let cancelled = false
    setLastRejection(null)
    if (!conversationId) {
      setPinnedAppIds([])
      setRevision(0)
      return
    }
    const draft = readDraftPins(conversationId)
    if (!isAuthenticated) {
      setPinnedAppIds(draft)
      setRevision(0)
      return
    }
    setPinnedAppIds(draft)
    const syncFromServer = async () => {
      try {
        const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/chats/${encodeURIComponent(conversationId)}/pins`, {
          credentials: "include",
          headers: authHeaders(),
          signal: AbortSignal.timeout(15_000),
        })
        if (cancelled) return
        if (res.ok) {
          const body = await res.json().catch(() => ({ pinnedAppIds: [], revision: 0 })) as { pinnedAppIds?: unknown; revision?: unknown }
          const serverPins = Array.isArray(body.pinnedAppIds) ? body.pinnedAppIds.map(String) : []
          setPinnedAppIds(serverPins.length ? serverPins : draft)
          setRevision(Number.isFinite(Number(body.revision)) ? Number(body.revision) : 0)
        }
      } catch {
        if (!cancelled) setPinnedAppIds(draft)
      }
    }
    void syncFromServer()
    return () => {
      cancelled = true
    }
  }, [conversationId, isAuthenticated])

  const persist = React.useCallback(async (next: string[]) => {
    const id = conversationRef.current
    writeDraftPins(id || "pending", next)
    if (!id) return
    setSyncing(true)
    // Single rebase on 412 PIN_SET_STALE (spec v2 §5): reapply the local
    // intent on top of the canonical state once, then give up.
    const attempt = async (desired: string[], baseRevision: number, isRebase: boolean): Promise<boolean> => {
      const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/chats/${encodeURIComponent(id)}/pins`, {
        method: "PUT",
        credentials: "include",
        headers: {
          ...authHeaders(),
          "If-Match": `"pins-${baseRevision}"`,
        },
        body: JSON.stringify({ pinnedAppIds: desired }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = await res.json().catch(() => ({})) as {
        pinnedAppIds?: unknown
        revision?: unknown
        code?: string
        appId?: string
        details?: { effectivePinnedAppIds?: unknown; effectiveRevision?: unknown }
      }
      if (res.ok) {
        const effective = Array.isArray(body.pinnedAppIds) ? body.pinnedAppIds.map(String) : desired
        setPinnedAppIds(effective)
        setRevision(Number.isFinite(Number(body.revision)) ? Number(body.revision) : baseRevision)
        writeDraftPins(id, effective)
        setLastRejection(null)
        return true
      }
      if (res.status === 412 && !isRebase) {
        const details = body.details || {}
        const canonical = Array.isArray(details.effectivePinnedAppIds)
          ? details.effectivePinnedAppIds.map(String)
          : []
        const canonicalRevision = Number.isFinite(Number(details.effectiveRevision))
          ? Number(details.effectiveRevision)
          : baseRevision
        setPinnedAppIds(canonical)
        setRevision(canonicalRevision)
        // Reapply the local intent (pin/unpin) on the canonical state once.
        const localSet = new Set(desired)
        const rebased = [
          ...canonical.filter((appId) => localSet.has(appId)),
          ...desired.filter((appId) => !canonical.includes(appId)),
        ].slice(0, 4)
        if (rebased.length !== canonical.length || rebased.some((appId, i) => appId !== canonical[i])) {
          writeDraftPins(id, rebased)
          return attempt(rebased, canonicalRevision, true)
        }
        setLastRejection(null)
        return true
      }
      setLastRejection({
        appId: String(body.appId || ""),
        code: String(body.code || `HTTP_${res.status}`),
      })
      const server = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/chats/${encodeURIComponent(id)}/pins`, {
        credentials: "include",
        headers: authHeaders(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null)
      if (server?.ok) {
        const fresh = await server.json().catch(() => ({ pinnedAppIds: [], revision: 0 })) as { pinnedAppIds?: unknown; revision?: unknown }
        setPinnedAppIds(Array.isArray(fresh.pinnedAppIds) ? fresh.pinnedAppIds.map(String) : [])
        setRevision(Number.isFinite(Number(fresh.revision)) ? Number(fresh.revision) : 0)
      }
      return false
    }
    try {
      await attempt(next, revisionRef.current, false)
    } catch {
      // Optimistic state stays; the next turn re-syncs.
    } finally {
      setSyncing(false)
    }
  }, [])

  const pinApp = React.useCallback(async (appId: string): Promise<boolean> => {
    if (!enabled) return false
    const current = pinsRef.current
    if (current.includes(appId)) return true
    if (!canAddPin(current)) {
      setLastRejection({ appId, code: "PIN_LIMIT" })
      return false
    }
    const next = [...current, appId].slice(0, MAX_PINS)
    setPinnedAppIds(next)
    writeDraftPins(conversationRef.current || "pending", next)
    await persist(next)
    return true
  }, [persist])

  const unpinApp = React.useCallback(async (appId: string) => {
    const current = pinsRef.current
    const next = current.filter((id) => id !== appId)
    setPinnedAppIds(next)
    writeDraftPins(conversationRef.current || "pending", next)
    await persist(next)
  }, [persist])

  const replacePins = React.useCallback(async (pins: string[]) => {
    const next = pins.slice(0, MAX_PINS)
    setPinnedAppIds(next)
    writeDraftPins(conversationRef.current || "pending", next)
    await persist(next)
  }, [persist])

  return { pinnedAppIds, revision, syncing, enabled, lastRejection, pinApp, unpinApp, replacePins }
}
