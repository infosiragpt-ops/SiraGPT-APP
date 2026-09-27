"use client"

/**
 * The admin shell is designed light-only (`.admin-shell` paints #fafafa with
 * #18181b text), but with the global dark theme the `dark` class on <html>
 * flipped every token-based component inside it — dark cards and tabs with
 * dark inherited text, nearly invisible (Admin → Logs, 2026-09-27). While an
 * admin page is mounted the document renders light: the `dark` class is
 * removed (and kept off if the theme machinery re-adds it) and restored when
 * leaving the admin. Tokens, `dark:` variants, portals (dialogs, sheets,
 * toasts) and native controls all follow.
 */

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"

export function AdminLightTheme() {
  const { resolvedTheme } = useTheme()
  const resolvedRef = useRef(resolvedTheme)
  resolvedRef.current = resolvedTheme

  useEffect(() => {
    if (typeof document === "undefined") return
    const html = document.documentElement
    const hadDark = html.classList.contains("dark")
    const previousScheme = html.style.colorScheme
    const strip = () => {
      if (html.classList.contains("dark")) html.classList.remove("dark")
      if (html.style.colorScheme !== "light") html.style.colorScheme = "light"
    }
    strip()
    const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(strip) : null
    observer?.observe(html, { attributes: true, attributeFilter: ["class", "style"] })
    return () => {
      observer?.disconnect()
      const dark = resolvedRef.current ? resolvedRef.current === "dark" : hadDark
      html.classList.toggle("dark", dark)
      html.style.colorScheme = dark ? "dark" : previousScheme || "light"
    }
  }, [])

  return null
}
