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
  const maxAttempts = 3

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
          }}
        >
          <div
            style={{
              maxWidth: "28rem",
              width: "100%",
              padding: "2rem",
              borderRadius: "0.75rem",
              boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
              border: "1px solid rgba(0,0,0,0.08)",
              textAlign: "center",
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

            <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Error cr&iacute;tico
            </h1>

            <p
              style={{
                fontSize: "0.875rem",
                color: "#666",
                marginBottom: "1rem",
                lineHeight: 1.5,
              }}
            >
              {attempts < maxAttempts
                ? "La aplicaci&oacute;n encontr&oacute; un error cr&iacute;tico al iniciar."
                : "El error persisti&oacute;. Prueba recargar la p&aacute;gina."}
            </p>

            {error.digest && (
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "#999",
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
                    backgroundColor: "#000",
                    color: "#fff",
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
                  border: "1px solid #ddd",
                  backgroundColor: "transparent",
                  color: "#000",
                  fontSize: "0.875rem",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                Recargar p&aacute;gina
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
