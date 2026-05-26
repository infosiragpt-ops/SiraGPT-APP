"use client"

/**
 * settings-context.tsx — single source of truth for all per-user
 * preferences that live in `/settings`. Persists to the backend via
 * GET/PUT /api/users/settings with a 500ms debounced auto-save, and
 * applies the live-preview surface (theme, accent, fontSize, density,
 * reducedMotion, highContrast) onto documentElement as CSS variables
 * + class names so any part of the app re-styles without a reload.
 *
 * Falls back gracefully when the user is anonymous / offline: local
 * state + localStorage keep the UI responsive even when persistence
 * is unavailable, so settings are never blocked by the network.
 */

import React from "react"

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
const STORAGE_KEY = "siraGPT-settings"

export type ThemeChoice = "light" | "dark" | "system"
export type Density = "compact" | "comfortable" | "spacious"
export type FontSize = "small" | "medium" | "large"
export type AccentColor = "default" | "blue" | "green" | "purple" | "orange" | "red"

export type SettingsShape = {
  // GENERAL — display
  theme: ThemeChoice
  accent: AccentColor
  fontSize: FontSize
  density: Density

  // GENERAL — language & region
  interfaceLanguage: string
  spokenLanguage: string
  dateFormat: string
  timeZone: string
  timeFormat: "12h" | "24h"

  // GENERAL — voice & audio
  assistantVoice: string
  autoPlayReplies: boolean
  standaloneVoiceMode: boolean

  // GENERAL — AI models
  defaultModel: string | null
  showAdditionalModels: boolean
  streamResponses: boolean

  // GENERAL — accessibility
  keyboardShortcuts: boolean
  reducedMotion: boolean
  highContrast: boolean

  // MODELOS AI
  favoriteModels: string[]

  // PERSONALIZATION
  baseStyle: "default" | "formal" | "casual" | "technical" | "academic"
  locale: string | null
  preferredTone: string | null
  customInstructions: string | null
  profile: { nickname: string; occupation: string; about: string }
  capabilities: {
    memories: boolean
    voiceHistory: boolean
    webSearch: boolean
    codeInterpreter: boolean
    canvas: boolean
    voice: boolean
    advancedVoice: boolean
    connectorSearch: boolean
  }

  // NOTIFICATIONS
  notifications: {
    channels: {
      replies: "off" | "push"
      tasks: "off" | "push" | "email" | "both"
      projects: "off" | "email"
      recommendations: "off" | "push" | "email" | "both"
    }
    inApp: { toasts: boolean; sound: boolean; desktop: boolean }
    quietHoursStart: string
    quietHoursEnd: string
  }

  // APPS — connection state is stored per-app; UI reads `gmailTokens` etc.
  // from the user object too, so this is a thin mirror.
  apps: Record<string, { connected: boolean }>

  // SECURITY
  security: { mfaApp: boolean; mfaPush: boolean }

  // DATA CONTROLS
  dataControls: {
    shareUsage: boolean
    analytics: boolean
    remoteBrowserData: boolean
    saveChatHistory: boolean
  }

  // ACCOUNT — GPT builder profile
  builderProfile: { name: string; website: string; linkedin: string; github: string; email: string }
}

export const DEFAULT_SETTINGS: SettingsShape = {
  theme: "system",
  accent: "default",
  fontSize: "medium",
  density: "comfortable",
  interfaceLanguage: "es",
  spokenLanguage: "auto",
  dateFormat: "DD/MM/YYYY",
  timeZone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC",
  timeFormat: "24h",
  assistantVoice: "cove",
  autoPlayReplies: false,
  standaloneVoiceMode: false,
  defaultModel: null,
  showAdditionalModels: true,
  streamResponses: true,
  keyboardShortcuts: true,
  reducedMotion: false,
  highContrast: false,
  favoriteModels: [],
  baseStyle: "default",
  locale: null,
  preferredTone: null,
  customInstructions: null,
  profile: { nickname: "", occupation: "", about: "" },
  capabilities: {
    memories: true,
    voiceHistory: false,
    webSearch: true,
    codeInterpreter: true,
    canvas: true,
    voice: true,
    advancedVoice: false,
    connectorSearch: true,
  },
  notifications: {
    channels: { replies: "push", tasks: "both", projects: "email", recommendations: "off" },
    inApp: { toasts: true, sound: false, desktop: false },
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  },
  apps: {},
  security: { mfaApp: false, mfaPush: false },
  dataControls: {
    shareUsage: true,
    analytics: true,
    remoteBrowserData: false,
    saveChatHistory: true,
  },
  builderProfile: { name: "", website: "", linkedin: "", github: "", email: "" },
}

// Accent color → CSS variable payload. Values are HSL triplets so they
// plug into tailwind's `hsl(var(--primary))` pattern without edits to
// globals.css.
const ACCENT_HSL: Record<AccentColor, string> = {
  default: "0 0% 9%",
  blue:    "217 91% 60%",
  green:   "142 71% 45%",
  purple:  "271 81% 56%",
  orange:  "25 95% 53%",
  red:     "0 84% 60%",
}

const FONT_SIZE_PX: Record<FontSize, string> = {
  small: "14px",
  medium: "16px",
  large: "18px",
}

const DENSITY_SCALE: Record<Density, string> = {
  compact: "0.85",
  comfortable: "1",
  spacious: "1.15",
}

function applyPreviewVars(s: SettingsShape) {
  if (typeof document === "undefined") return
  const root = document.documentElement

  // Theme — prefer explicit choice, else system preference.
  root.classList.remove("dark")
  const systemDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
  if (s.theme === "dark" || (s.theme === "system" && systemDark)) root.classList.add("dark")

  // Accent — drives --primary for tailwind/shadcn tokens.
  root.style.setProperty("--primary", ACCENT_HSL[s.accent])
  const primaryFgHsl = s.accent === "default" ? "0 0% 98%" : "0 0% 100%"
  root.style.setProperty("--primary-foreground", primaryFgHsl)

  // Font size — base html font-size, everything else scales via rem.
  root.style.fontSize = FONT_SIZE_PX[s.fontSize]

  // Density — custom var we can multiply against spacing utilities.
  root.style.setProperty("--density-scale", DENSITY_SCALE[s.density])

  // Accessibility toggles as classes so CSS can key off them.
  root.classList.toggle("reduce-motion", !!s.reducedMotion)
  root.classList.toggle("high-contrast", !!s.highContrast)
}

type Ctx = {
  settings: SettingsShape
  loaded: boolean
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  savedAt: number | null
  update: (patch: Partial<SettingsShape> | ((prev: SettingsShape) => Partial<SettingsShape>)) => void
  reset: () => void
}

const SettingsContext = React.createContext<Ctx | null>(null)

export function useSettings(): Ctx {
  const ctx = React.useContext(SettingsContext)
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>")
  return ctx
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<SettingsShape>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = React.useState(false)
  const [saveStatus, setSaveStatus] = React.useState<Ctx['saveStatus']>('idle')
  const [savedAt, setSavedAt] = React.useState<number | null>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstPersistSkip = React.useRef(true)

  // Hydrate once: localStorage first (instant), then backend (authoritative).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        setSettings((prev) => mergeDeep(prev, parsed))
      }
    } catch { /* ignore */ }

    const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
    if (!token) { setLoaded(true); return }
    fetch(`${API_BASE}/users/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.settings) setSettings((prev) => mergeDeep(prev, data.settings))
      })
      .catch(() => { /* offline — localStorage state is enough */ })
      .finally(() => setLoaded(true))
  }, [])

  // Apply preview vars every time settings change — this is what makes
  // theme/accent/density/fontSize flip live without a reload.
  React.useEffect(() => { applyPreviewVars(settings) }, [settings])

  // Debounced persist: bundles rapid toggle chains into one PUT so a
  // user dragging a slider doesn't generate 50 network calls.
  React.useEffect(() => {
    if (!loaded) return
    if (firstPersistSkip.current) { firstPersistSkip.current = false; return }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* ignore */ }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSaveStatus('saving')
    debounceRef.current = setTimeout(() => {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      if (!token) { setSaveStatus('idle'); return }
      fetch(`${API_BASE}/users/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          setSaveStatus('saved')
          setSavedAt(Date.now())
        })
        .catch(() => {
          setSaveStatus('error')
          // localStorage keeps the UI in sync so the user doesn't lose
          // their choice; error state just flags it for next retry.
        })
    }, 500)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [settings, loaded])

  const update = React.useCallback<Ctx["update"]>((patch) => {
    setSettings((prev) => {
      const p = typeof patch === "function" ? patch(prev) : patch
      return mergeDeep(prev, p)
    })
  }, [])

  const reset = React.useCallback(() => setSettings(DEFAULT_SETTINGS), [])

  return (
    <SettingsContext.Provider value={{ settings, loaded, saveStatus, savedAt, update, reset }}>
      {children}
    </SettingsContext.Provider>
  )
}

function mergeDeep<T extends Record<string, any>>(target: T, source: Partial<T> | undefined): T {
  if (!source) return target
  const isObj = (x: any) => x && typeof x === "object" && !Array.isArray(x)
  if (!isObj(target) || !isObj(source)) return (source as T) ?? target
  const out: any = { ...target }
  for (const k of Object.keys(source)) {
    const sv = (source as any)[k]
    const tv = (target as any)[k]
    if (isObj(sv) && isObj(tv)) out[k] = mergeDeep(tv, sv)
    else if (sv !== undefined) out[k] = sv
  }
  return out as T
}
