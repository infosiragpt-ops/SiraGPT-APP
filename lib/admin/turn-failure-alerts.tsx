"use client"

/**
 * Admin-wide listener for Admin → Logs. Mounted in the admin layout, so while
 * the «Sonido de errores» toggle is on, alerts play on ANY admin page:
 *   - «Fallos de respuesta»: polls GET /api/admin/turn-failures/recent;
 *     strong / soft chime by category;
 *   - «Errores del sistema»: polls GET /api/admin/system-issues/recent —
 *     only NEW issues and regressions (never a repeat of a known issue);
 *     the stronger «critical» tone;
 *   - «Registros en vivo»: its panel emits `sira:admin-live-log-errors`;
 *     only user-facing error lines (a request served to a user) sound, with
 *     their own ≥5 s throttle;
 *   - unseen counters → badge on the «Logs» menu item + «(3) …» tab title;
 *   - optional desktop Notification when the tab is in the background;
 *   - ≥5 s between chimes per feed, a burst plays once.
 * The toggle click unlocks the shared AudioContext (browser autoplay rules)
 * and the preference persists in localStorage.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { apiClient } from "@/lib/api"
import type { AdminTurnFailureRecent, AdminTurnFailureRecentItem } from "@/lib/admin/turn-failures-types"
import type { AdminSystemIssueAlert, AdminSystemIssueRecent } from "@/lib/admin/system-issues-types"
import {
  ERROR_SOUND_STORAGE_KEY,
  createAlertThrottle,
  getErrorSoundContext,
  playErrorChime,
  strongestTier,
  type AudioContextLike,
} from "@/lib/admin/error-sound"

export { ERROR_SOUND_STORAGE_KEY }
export const SEEN_AT_STORAGE_KEY = "sira-admin-turn-failures-seen-at"
export const ISSUES_SEEN_AT_STORAGE_KEY = "sira-admin-system-issues-seen-at"
const DEFAULT_POLL_MS = 10_000
const HIDDEN_POLL_MS = 20_000
const TITLE_PREFIX_RE = /^\(\d+\)\s+/

export const LIVE_LOG_ERRORS_EVENT = "sira:admin-live-log-errors"

type LiveLogErrorLine = {
  level?: string
  userId?: string | null
  email?: string | null
  chatId?: string | null
  reqId?: string | null
  route?: string | null
  status?: number | null
}

/**
 * A live error line a user actually hit: logged while serving a user's
 * request (user / chat / request+route context). Worker and boot noise with
 * no user attached never sounds.
 */
export function isUserFacingLiveErrorLine(line: LiveLogErrorLine | null | undefined): boolean {
  if (!line) return false
  const level = String(line.level || "").toLowerCase()
  if (level !== "error" && level !== "fatal") return false
  return Boolean(line.userId || line.email || line.chatId || (line.reqId && line.route))
}

export type TurnFailureAlerts = {
  unseen: number
  latest: AdminTurnFailureRecentItem[]
  soundOn: boolean
  notificationsOn: boolean
  setSoundOn: (on: boolean) => Promise<void>
  markSeen: () => void
  /** While the failures view is on screen new rows are seen immediately. */
  setViewing: (viewing: boolean) => void
  /** Increments on every batch of new failures (panels refresh on it). */
  revision: number
  /** «Errores del sistema»: new issues + regressions not seen yet. */
  unseenIssues: number
  latestIssues: AdminSystemIssueAlert[]
  markIssuesSeen: () => void
  setViewingIssues: (viewing: boolean) => void
  issuesRevision: number
  /** Everything unseen (the «Logs» badge and the tab title). */
  totalUnseen: number
}

const TurnFailureAlertsContext = createContext<TurnFailureAlerts | null>(null)

export function useTurnFailureAlerts(): TurnFailureAlerts | null {
  return useContext(TurnFailureAlertsContext)
}

function readStorage(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

export function applyUnseenTitle(unseen: number) {
  if (typeof document === "undefined") return
  const base = document.title.replace(TITLE_PREFIX_RE, "")
  const next = unseen > 0 ? `(${unseen > 99 ? "99+" : unseen}) ${base}` : base
  if (document.title !== next) document.title = next
}

type RecentPayload<T> = { serverTime: string; count: number; items: T[] }

/**
 * One polled feed: the first call seeds the watermark from the last «seen»
 * time (the backlog counts but never sounds); later calls hand only rows
 * not seen before to `onFresh`.
 */
function useRecentFeed<T extends { id: string }>({
  fetchRef,
  seenAtKey,
  pollMs,
  nowRef,
  onSeed,
  onFresh,
}: {
  fetchRef: React.MutableRefObject<(since: string | null) => Promise<RecentPayload<T>>>
  seenAtKey: string
  pollMs: number
  nowRef: React.MutableRefObject<() => number>
  onSeed: (count: number, items: T[]) => void
  onFresh: (items: T[]) => void
}) {
  const onSeedRef = useRef(onSeed)
  onSeedRef.current = onSeed
  const onFreshRef = useRef(onFresh)
  onFreshRef.current = onFresh
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let watermark: string | null = null
    let seenIds = new Set<string>()
    const seedSeenAt = readStorage(seenAtKey) || new Date(nowRef.current()).toISOString()
    if (!readStorage(seenAtKey)) writeStorage(seenAtKey, seedSeenAt)

    const schedule = (ms: number) => {
      if (cancelled) return
      timer = setTimeout(tick, ms)
    }
    const tick = async () => {
      try {
        if (watermark == null) {
          const seed = await fetchRef.current(seedSeenAt)
          if (cancelled) return
          for (const it of seed.items || []) seenIds.add(it.id)
          onSeedRef.current(Number(seed.count) || 0, seed.items || [])
          watermark = seed.serverTime || new Date(nowRef.current()).toISOString()
        } else {
          const res = await fetchRef.current(watermark)
          if (cancelled) return
          const fresh = (res.items || []).filter((it) => !seenIds.has(it.id))
          for (const it of fresh) seenIds.add(it.id)
          if (seenIds.size > 2000) seenIds = new Set(Array.from(seenIds).slice(-500))
          if (res.serverTime) watermark = res.serverTime
          if (fresh.length) onFreshRef.current(fresh)
        }
      } catch {
        /* admin API unavailable — retry on the next tick */
      }
      const hidden = typeof document !== "undefined" && document.hidden
      schedule(hidden ? HIDDEN_POLL_MS : pollMs)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [fetchRef, nowRef, pollMs, seenAtKey])
}

type ProviderProps = {
  children: React.ReactNode
  pollMs?: number
  fetchRecent?: (since: string | null) => Promise<AdminTurnFailureRecent>
  fetchIssueAlerts?: (since: string | null) => Promise<AdminSystemIssueRecent>
  audioFactory?: () => AudioContextLike | null
  now?: () => number
}

const defaultFetchRecent = (since: string | null) => apiClient.getAdminTurnFailuresRecent(since)
const defaultFetchIssueAlerts = (since: string | null) => apiClient.getAdminSystemIssuesRecent(since)
const defaultNow = () => Date.now()

function notify(title: string, body: string, tag: string, href: string) {
  try {
    const notification = new Notification(title, { body, tag })
    notification.onclick = () => {
      try { window.focus() } catch { /* ignore */ }
      try { window.location.assign(href) } catch { /* ignore */ }
    }
  } catch {
    /* Notification unsupported in this context */
  }
}

export function TurnFailureAlertsProvider({
  children,
  pollMs = DEFAULT_POLL_MS,
  fetchRecent = defaultFetchRecent,
  fetchIssueAlerts = defaultFetchIssueAlerts,
  // Default: the admin panel's shared AudioContext (lib/admin/error-sound).
  audioFactory = getErrorSoundContext,
  now = defaultNow,
}: ProviderProps) {
  // Props live in refs so callbacks stay stable and the poll loops never
  // restart on a re-render.
  const fetchRef = useRef(fetchRecent)
  fetchRef.current = fetchRecent
  const fetchIssuesRef = useRef(fetchIssueAlerts)
  fetchIssuesRef.current = fetchIssueAlerts
  const audioFactoryRef = useRef(audioFactory)
  audioFactoryRef.current = audioFactory
  const nowRef = useRef(now)
  nowRef.current = now
  const [unseen, setUnseen] = useState(0)
  const [latest, setLatest] = useState<AdminTurnFailureRecentItem[]>([])
  const [unseenIssues, setUnseenIssues] = useState(0)
  const [latestIssues, setLatestIssues] = useState<AdminSystemIssueAlert[]>([])
  const [soundOn, setSoundOnState] = useState(false)
  const [notificationsOn, setNotificationsOn] = useState(false)
  const [revision, setRevision] = useState(0)
  const [issuesRevision, setIssuesRevision] = useState(0)

  const soundOnRef = useRef(false)
  const viewingRef = useRef(false)
  const viewingIssuesRef = useRef(false)
  const audioRef = useRef<AudioContextLike | null>(null)
  const throttleRef = useRef(createAlertThrottle({ minIntervalMs: 5000, now: () => nowRef.current() }))
  const notifyThrottleRef = useRef(createAlertThrottle({ minIntervalMs: 15000, now: () => nowRef.current() }))
  const issueThrottleRef = useRef(createAlertThrottle({ minIntervalMs: 5000, now: () => nowRef.current() }))
  const liveLogThrottleRef = useRef(createAlertThrottle({ minIntervalMs: 5000, now: () => nowRef.current() }))
  const issueNotifyThrottleRef = useRef(createAlertThrottle({ minIntervalMs: 15000, now: () => nowRef.current() }))
  const totalUnseen = unseen + unseenIssues
  const totalUnseenRef = useRef(0)
  totalUnseenRef.current = totalUnseen

  const ensureAudio = useCallback((): AudioContextLike | null => {
    if (!audioRef.current) audioRef.current = audioFactoryRef.current()
    const ctx = audioRef.current
    if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
      void ctx.resume().catch(() => {})
    }
    return ctx
  }, [])

  // Restore the persisted preference; after a reload the AudioContext stays
  // locked until the first user gesture, so unlock it on the first input.
  useEffect(() => {
    const stored = readStorage(ERROR_SOUND_STORAGE_KEY) === "1"
    soundOnRef.current = stored
    setSoundOnState(stored)
    if (typeof Notification !== "undefined") setNotificationsOn(stored && Notification.permission === "granted")
    if (!stored || typeof window === "undefined") return
    const unlock = () => {
      ensureAudio()
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
    window.addEventListener("pointerdown", unlock)
    window.addEventListener("keydown", unlock)
    return () => {
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
  }, [ensureAudio])

  const setSoundOn = useCallback(async (on: boolean) => {
    soundOnRef.current = on
    setSoundOnState(on)
    writeStorage(ERROR_SOUND_STORAGE_KEY, on ? "1" : "0")
    if (!on) {
      setNotificationsOn(false)
      return
    }
    // The toggle click is the user gesture that unlocks audio; a soft
    // preview confirms the sound works.
    playErrorChime(ensureAudio(), "soft")
    if (typeof Notification !== "undefined") {
      try {
        const permission = Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission
        setNotificationsOn(permission === "granted")
      } catch {
        setNotificationsOn(false)
      }
    }
  }, [ensureAudio])

  const markSeen = useCallback(() => {
    writeStorage(SEEN_AT_STORAGE_KEY, new Date(nowRef.current()).toISOString())
    setUnseen(0)
  }, [])

  const setViewing = useCallback((viewing: boolean) => {
    viewingRef.current = viewing
    if (viewing) markSeen()
  }, [markSeen])

  const markIssuesSeen = useCallback(() => {
    writeStorage(ISSUES_SEEN_AT_STORAGE_KEY, new Date(nowRef.current()).toISOString())
    setUnseenIssues(0)
  }, [])

  const setViewingIssues = useCallback((viewing: boolean) => {
    viewingIssuesRef.current = viewing
    if (viewing) markIssuesSeen()
  }, [markIssuesSeen])

  const backgroundNotificationsAllowed = () =>
    typeof document !== "undefined" && document.hidden
    && typeof Notification !== "undefined" && Notification.permission === "granted"

  const handleNewFailures = useCallback((items: AdminTurnFailureRecentItem[]) => {
    if (!items.length) return
    setLatest((prev) => [...items, ...prev].slice(0, 20))
    setRevision((r) => r + 1)
    if (viewingRef.current) markSeen()
    else setUnseen((u) => u + items.length)
    if (!soundOnRef.current) return
    const gate = throttleRef.current.offer(items.length)
    if (gate.play) playErrorChime(ensureAudio(), strongestTier(items))
    if (backgroundNotificationsAllowed()) {
      const notifyGate = notifyThrottleRef.current.offer(items.length)
      if (notifyGate.play) {
        const first = items[0]
        const n = notifyGate.count
        notify(
          `SiraGPT · ${n} fallo${n === 1 ? "" : "s"} de respuesta`,
          [first.categoryLabel || first.category, first.cause, first.userEmail].filter(Boolean).join(" · "),
          "sira-turn-failure",
          "/admin/logs?tab=fallos",
        )
      }
    }
  }, [ensureAudio, markSeen])

  const handleNewIssues = useCallback((items: AdminSystemIssueAlert[]) => {
    if (!items.length) return
    setLatestIssues((prev) => [...items, ...prev].slice(0, 20))
    setIssuesRevision((r) => r + 1)
    if (viewingIssuesRef.current) markIssuesSeen()
    else setUnseenIssues((u) => u + items.length)
    if (!soundOnRef.current) return
    // New issues and regressions only ever arrive here: the stronger tone.
    const gate = issueThrottleRef.current.offer(items.length)
    if (gate.play) playErrorChime(ensureAudio(), "critical")
    if (backgroundNotificationsAllowed()) {
      const notifyGate = issueNotifyThrottleRef.current.offer(items.length)
      if (notifyGate.play) {
        const first = items[0]
        const regression = first.type === "regresion"
        notify(
          regression ? "SiraGPT · Regresión: volvió un error resuelto" : "SiraGPT · Nuevo error del sistema",
          [first.title, first.culprit].filter(Boolean).join(" · "),
          "sira-system-issue",
          "/admin/logs?tab=errores",
        )
      }
    }
  }, [ensureAudio, markIssuesSeen])

  const seedFailures = useCallback((count: number, items: AdminTurnFailureRecentItem[]) => {
    setUnseen(count)
    setLatest(items.slice(0, 20))
  }, [])
  const seedIssues = useCallback((count: number, items: AdminSystemIssueAlert[]) => {
    setUnseenIssues(count)
    setLatestIssues(items.slice(0, 20))
  }, [])

  useRecentFeed<AdminTurnFailureRecentItem>({
    fetchRef,
    seenAtKey: SEEN_AT_STORAGE_KEY,
    pollMs,
    nowRef,
    onSeed: seedFailures,
    onFresh: handleNewFailures,
  })
  useRecentFeed<AdminSystemIssueAlert>({
    fetchRef: fetchIssuesRef,
    seenAtKey: ISSUES_SEEN_AT_STORAGE_KEY,
    pollMs,
    nowRef,
    onSeed: seedIssues,
    onFresh: handleNewIssues,
  })

  // «Registros en vivo» error lines (only while that panel streams): one
  // shared sound, user-facing errors only, throttled.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onLiveErrors = (event: Event) => {
      if (!soundOnRef.current) return
      const detail = (event as CustomEvent<{ lines?: LiveLogErrorLine[] }>).detail
      const hits = (Array.isArray(detail?.lines) ? detail.lines : []).filter(isUserFacingLiveErrorLine)
      if (!hits.length) return
      const gate = liveLogThrottleRef.current.offer(hits.length)
      if (gate.play) playErrorChime(ensureAudio(), "strong")
    }
    window.addEventListener(LIVE_LOG_ERRORS_EVENT, onLiveErrors)
    return () => window.removeEventListener(LIVE_LOG_ERRORS_EVENT, onLiveErrors)
  }, [ensureAudio])

  // «(3) Admin · SiraGPT» while there is anything unseen. Next can reset the
  // title on navigation, so it is re-applied on every change + poll.
  useEffect(() => {
    applyUnseenTitle(totalUnseen)
    if (typeof window === "undefined") return
    const id = window.setInterval(() => applyUnseenTitle(totalUnseenRef.current), 2000)
    return () => {
      window.clearInterval(id)
      applyUnseenTitle(0)
    }
  }, [totalUnseen])

  const value = useMemo<TurnFailureAlerts>(() => ({
    unseen,
    latest,
    soundOn,
    notificationsOn,
    setSoundOn,
    markSeen,
    setViewing,
    revision,
    unseenIssues,
    latestIssues,
    markIssuesSeen,
    setViewingIssues,
    issuesRevision,
    totalUnseen,
  }), [unseen, latest, soundOn, notificationsOn, setSoundOn, markSeen, setViewing, revision,
    unseenIssues, latestIssues, markIssuesSeen, setViewingIssues, issuesRevision, totalUnseen])

  return <TurnFailureAlertsContext.Provider value={value}>{children}</TurnFailureAlertsContext.Provider>
}
