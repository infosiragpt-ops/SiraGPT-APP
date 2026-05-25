"use client"

// ──────────────────────────────────────────────────────────────
// siraGPT — Global Error UI
// ──────────────────────────────────────────────────────────────
// Next.js ONLY renders this file when the root layout itself
// throws (e.g. ThemeProvider, AuthProvider crash). It replaces
// the entire page — so this file must include its own <html> and
// <body> tags. Normal error.tsx is preferred for route-level
// errors; this is the last-resort fallback.
//
// Styled with inline CSS so it works without any CSS framework
// or layout component — those may be what crashed in the first
// place.
// ──────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [attempts, setAttempts] = useState(0)
  const [isDark, setIsDark] = useState(false)
  const maxAttempts = 3

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    setIsDark(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])

  // Log immediately — this is the most important diagnostic signal
  useEffect(() => {
    console.error("[global-error]", error.name, error.message)
    if (error.digest) {
      console.error("[global-error] digest:", error.digest)
    }
  }, [error])

  const handleRetry = useCallback(() => {
    const next = attempts + 1
    setAttempts(next)
    if (next >= maxAttempts) return
    reset()
  }, [attempts, reset])

  const bg = isDark ? "#0a0a0f" : "#ffffff"
  const cardBg = isDark ? "#16161e" : "#ffffff"
  const cardBorder = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"
  const cardShadow = isDark ? "0 4px 24px rgba(0,0,0,0.4)" : "0 4px 24px rgba(0,0,0,0.12)"
  const headingColor = isDark ? "#f4f4f5" : "#18181b"
  const bodyColor = isDark ? "#a1a1aa" : "#666666"
  const subColor = isDark ? "#71717a" : "#999999"
  const btnPrimaryBg = isDark ? "#f4f4f5" : "#000000"
  const btnPrimaryColor = isDark ? "#18181b" : "#ffffff"
  const btnOutlineBorder = isDark ? "#3f3f46" : "#dddddd"
  const btnOutlineColor = isDark ? "#e4e4e7" : "#000000"

  return (
    <html>
      <body>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            backgroundColor: bg,
            color: headingColor,
          }}
        >
          <div
            style={{
              maxWidth: "28rem",
              width: "100%",
              padding: "2rem",
              borderRadius: "0.75rem",
              boxShadow: cardShadow,
              border: `1px solid ${cardBorder}`,
              textAlign: "center",
              backgroundColor: cardBg,
            }}
          >
            {/* Icon */}
            <div
              style={{
                margin: "0 auto 1rem",
                width: "3rem",
                height: "3rem",
                borderRadius: "50%",
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.5rem",
              }}
            >
              ⚠️
            </div>

            <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem", color: headingColor }}>
              Error crítico
            </h1>

            <p
              style={{
                fontSize: "0.875rem",
                color: bodyColor,
                marginBottom: "1rem",
                lineHeight: 1.5,
              }}
            >
              {attempts < maxAttempts
                ? "La aplicación encontró un error crítico al iniciar."
                : "El error persistió. Prueba recargar la página."}
            </p>

            {error.digest && (
              <p
                style={{
                  fontSize: "0.75rem",
                  color: subColor,
                  fontFamily: "monospace",
                  marginBottom: "1rem",
                }}
              >
                Error ID: {error.digest}
              </p>
            )}

            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", flexWrap: "wrap" }}>
              {attempts < maxAttempts && (
                <button
                  onClick={handleRetry}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "0.375rem",
                    border: "none",
                    backgroundColor: btnPrimaryBg,
                    color: btnPrimaryColor,
                    fontSize: "0.875rem",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  Intentar de nuevo
                </button>
              )}

              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "0.375rem",
                  border: `1px solid ${btnOutlineBorder}`,
                  backgroundColor: "transparent",
                  color: btnOutlineColor,
                  fontSize: "0.875rem",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                Recargar página
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
