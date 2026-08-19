"use client"
/**
 * LanguageToggle — scaffold-only language switcher for the user
 * settings surface. Persists the chosen locale in two places:
 *
 *   1. localStorage (`siragpt.locale`)  — read on next mount so the
 *      picker remembers the last choice immediately, before next-intl
 *      re-renders against the cookie.
 *   2. NEXT_LOCALE cookie (year-long, lax, /)  — next-intl resolves
 *      from this cookie on every request, so a hard refresh / SSR
 *      hit picks up the new language without negotiating again.
 *
 * Intentionally NOT wired into the existing UI per CLAUDE.md rule #1
 * (no UI mutation). The component is exposed so a future settings
 * page can render it as-is.
 */
import { useEffect, useState, useCallback } from "react"
import { Languages } from "lucide-react"

const STORAGE_KEY = "siragpt.locale"
const COOKIE_NAME = "NEXT_LOCALE"
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

type LocaleCode = "es" | "en"

const LOCALE_LABELS: Record<LocaleCode, string> = {
  es: "Español",
  en: "English",
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"))
  return match ? decodeURIComponent(match[2]) : null
}

function writeCookie(name: string, value: string) {
  if (typeof document === "undefined") return
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
}

function readInitialLocale(): LocaleCode {
  if (typeof window === "undefined") return "es"
  const fromStorage = window.localStorage.getItem(STORAGE_KEY)
  if (fromStorage === "es" || fromStorage === "en") return fromStorage
  const fromCookie = readCookie(COOKIE_NAME)
  if (fromCookie === "es" || fromCookie === "en") return fromCookie
  return "es"
}

export type LanguageToggleProps = {
  className?: string
  /** Fires after the locale is persisted but before any reload. */
  onChange?: (next: LocaleCode) => void
  /** If true, a full reload is triggered so next-intl picks up the cookie. */
  reloadOnChange?: boolean
}

export function LanguageToggle({ className, onChange, reloadOnChange = false }: LanguageToggleProps) {
  const [locale, setLocale] = useState<LocaleCode>("es")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setLocale(readInitialLocale())
    setMounted(true)
  }, [])

  const apply = useCallback(
    (next: LocaleCode) => {
      setLocale(next)
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Storage may be disabled (private mode, quota); cookie still wins.
      }
      writeCookie(COOKIE_NAME, next)
      onChange?.(next)
      if (reloadOnChange) {
        window.location.reload()
      }
    },
    [onChange, reloadOnChange],
  )

  // Render a stable shell on the server to avoid hydration mismatch when
  // the localStorage value disagrees with the SSR cookie pick.
  const current = mounted ? locale : "es"

  return (
    <div
      role="group"
      aria-label="Language"
      className={
        className ??
        "inline-flex items-center gap-1 rounded-full border border-border bg-background px-1 py-1 text-sm"
      }
    >
      <Languages className="ml-1 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {(Object.keys(LOCALE_LABELS) as LocaleCode[]).map((code) => {
        const active = code === current
        return (
          <button
            key={code}
            type="button"
            aria-pressed={active}
            onClick={() => apply(code)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
              (active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {LOCALE_LABELS[code]}
          </button>
        )
      })}
    </div>
  )
}

export default LanguageToggle
