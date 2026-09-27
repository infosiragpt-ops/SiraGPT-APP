"use client"

/**
 * Admin-wide listener for failed user turns (Admin → Logs → «Fallos de
 * respuesta»). Mounted in the admin layout, so while the «Sonido de errores»
 * toggle is on, the error chime plays on ANY admin page:
 *   - polls GET /api/admin/turn-failures/recent (cheap, admin-only);
 *   - unseen counter → badge on the «Logs» menu item + «(3) …» tab title;
 *   - optional desktop Notification when the tab is in the background;
 *   - only failures sound; ≥5 s between chimes, a burst plays once.
 * The toggle click unlocks the AudioContext (browser autoplay rules) and
 * the preference persists in localStorage.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { apiClient } from "@/lib/api"
import type { AdminTurnFailureRecent, AdminTurnFailureRecentItem } from "@/lib/admin/turn-failures-types"
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
const DEFAULT_POLL_MS = 10_000
const HIDDEN_POLL_MS = 20_000
const TITLE_PREFIX_RE = /^\(\d+\)\s+/

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

type ProviderProps = {
  children: React.ReactNode
  pollMs?: number
  fetchRecent?: (since: string | null) => Promise<AdminTurnFailureRecent>
  audioFactory?: () => AudioContextLike | null
  now?: () => number
}

const defaultFetchRecent = (since: string | null) => apiClient.getAdminTurnFailuresRecent(since)
const defaultNow = () => Date.now()

export function TurnFailureAlertsProvider({
  children,
  pollMs = DEFAULT_POLL_MS,
  fetchRecent = defaultFetchRecent,
  // Default: the admin panel's shared AudioContext (lib/admin/error-sound).
  audioFactory = getErrorSoundContext,
  now = defaultNow,
}: ProviderProps) {
  // Props live in refs so callbacks stay stable and the poll loop never
  // restarts on a re-render.
  const fetchRef = useRef(fetchRecent)
  fetchRef.current = fetchRecent
  const audioFactoryRef = useRef(audioFactory)
  audioFactoryRef.current = audioFactory
  const nowRef = useRef(now)
  nowRef.current = now
  const [unseen, setUnseen] = useState(0)
  const [latest, setLatest] = useState<AdminTurnFailureRecentItem[]>([])
  const [soundOn, setSoundOnState] = useState(false)
  const [notificationsOn, setNotificationsOn] = useState(false)
  const [revision, setRevision] = useState(0)

  const soundOnRef = useRef(false)
  const viewingRef = useRef(false)
  const watermarkRef = useRef<string | null>(null)
  const seenIdsRef = useRef<Set<string>>(new Set())
  const audioRef = useRef<AudioContextLike | null>(null)
  const throttleRef = useRef(createAlertThrottle({ minIntervalMs: 5000, now: () => nowRef.current() }))
  const notifyThrottleRef = useRef(createAlertThrottle({ minIntervalMs: 15000, now: () => nowRef.current() }))
  const unseenRef = useRef(0)
  unseenRef.current = unseen

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

  const handleNew = useCallback((items: AdminTurnFailureRecentItem[]) => {
    if (!items.length) return
    setLatest((prev) => [...items, ...prev].slice(0, 20))
    setRevision((r) => r + 1)
    if (viewingRef.current) markSeen()
    else setUnseen((u) => u + items.length)
    if (!soundOnRef.current) return
    const gate = throttleRef.current.offer(items.length)
    if (gate.play) playErrorChime(ensureAudio(), strongestTier(items))
    const hidden = typeof document !== "undefined" && document.hidden
    if (hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const notifyGate = notifyThrottleRef.current.offer(items.length)
      if (notifyGate.play) {
        try {
          const first = items[0]
          const n = notifyGate.count
          const notification = new Notification(`SiraGPT · ${n} fallo${n === 1 ? "" : "s"} de respuesta`, {
            body: [first.categoryLabel || first.category, first.cause, first.userEmail].filter(Boolean).join(" · "),
            tag: "sira-turn-failure",
          })
          notification.onclick = () => {
            try { window.focus() } catch { /* ignore */ }
            try { window.location.assign("/admin/logs?tab=fallos") } catch { /* ignore */ }
          }
        } catch {
          /* Notification unsupported in this context */
        }
      }
    }
  }, [ensureAudio, markSeen])

  // Poll loop: the first call seeds the watermark (backlog never sounds) and
  // counts what arrived since the admin last looked (badge survives reloads).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const seedSeenAt = readStorage(SEEN_AT_STORAGE_KEY) || new Date(nowRef.current()).toISOString()
    if (!readStorage(SEEN_AT_STORAGE_KEY)) writeStorage(SEEN_AT_STORAGE_KEY, seedSeenAt)

    const schedule = (ms: number) => {
      if (cancelled) return
      timer = setTimeout(tick, ms)
    }
    const tick = async () => {
      try {
        if (watermarkRef.current == null) {
          const seed = await fetchRef.current(seedSeenAt)
          if (cancelled) return
          for (const it of seed.items || []) seenIdsRef.current.add(it.id)
          setUnseen(Number(seed.count) || 0)
          setLatest((seed.items || []).slice(0, 20))
          watermarkRef.current = seed.serverTime || new Date(nowRef.current()).toISOString()
        } else {
          const res = await fetchRef.current(watermarkRef.current)
          if (cancelled) return
          const fresh = (res.items || []).filter((it) => !seenIdsRef.current.has(it.id))
          for (const it of fresh) seenIdsRef.current.add(it.id)
          if (seenIdsRef.current.size > 2000) {
            seenIdsRef.current = new Set(Array.from(seenIdsRef.current).slice(-500))
          }
          if (res.serverTime) watermarkRef.current = res.serverTime
          if (fresh.length) handleNew(fresh)
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
  }, [handleNew, pollMs])

  // «(3) Admin · SiraGPT» while there are unseen failures. Next can reset
  // the title on navigation, so it is re-applied on every change + poll.
  useEffect(() => {
    applyUnseenTitle(unseen)
    if (typeof window === "undefined") return
    const id = window.setInterval(() => applyUnseenTitle(unseenRef.current), 2000)
    return () => {
      window.clearInterval(id)
      applyUnseenTitle(0)
    }
  }, [unseen])

  const value = useMemo<TurnFailureAlerts>(() => ({
    unseen,
    latest,
    soundOn,
    notificationsOn,
    setSoundOn,
    markSeen,
    setViewing,
    revision,
  }), [unseen, latest, soundOn, notificationsOn, setSoundOn, markSeen, setViewing, revision])

  return <TurnFailureAlertsContext.Provider value={value}>{children}</TurnFailureAlertsContext.Provider>
}
