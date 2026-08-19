"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

/**
 * Global drag-and-drop catcher mounted at the app shell.
 *
 * Why this exists: chat-interface-enhanced already has its own drop
 * handler scoped to /chat. But users frequently drop files onto the
 * landing or any non-chat page expecting an upload. Without this
 * component the browser falls back to opening the file in a new tab —
 * the bug the user reported as "no hay efecto al arrastrar".
 *
 * Behavior:
 *   • on /chat → no-op, the existing handler in chat-interface owns it
 *   • elsewhere → swallow the drag, show a full-screen overlay that
 *     reads "Suelta aquí para abrir el chat", and on drop hand the
 *     File[] off via window.__siraPendingFiles before navigating.
 *
 * The chat page picks up window.__siraPendingFiles on mount and runs
 * the normal upload pipeline, so the user's drag turns into one
 * uninterrupted gesture: drag → land in chat → file already attached.
 */
export function GlobalDropRedirector() {
  const pathname = usePathname() ?? "/"
  const router = useRouter()
  const [active, setActive] = React.useState(false)
  const counter = React.useRef(0)

  // Skip on /chat — the dedicated handler there owns the gesture.
  const enabled = !pathname.startsWith("/chat")

  React.useEffect(() => {
    if (!enabled) return

    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer?.types?.includes("Files")

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      counter.current++
      setActive(true)
    }
    const onOver = (e: DragEvent) => {
      // Required so drop fires; without preventDefault the browser
      // falls back to "open file in new tab".
      if (!hasFiles(e)) return
      e.preventDefault()
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      counter.current = Math.max(0, counter.current - 1)
      if (counter.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      counter.current = 0
      setActive(false)
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      // Hand off via the window so chat-interface can consume on mount.
      // Files survive client-side navigation because window persists.
      ;(window as unknown as { __siraPendingFiles?: File[] }).__siraPendingFiles =
        Array.from(files)
      router.push("/chat")
    }

    window.addEventListener("dragenter", onEnter)
    window.addEventListener("dragover", onOver)
    window.addEventListener("dragleave", onLeave)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragenter", onEnter)
      window.removeEventListener("dragover", onOver)
      window.removeEventListener("dragleave", onLeave)
      window.removeEventListener("drop", onDrop)
    }
  }, [enabled, router])

  if (!enabled || !active) return null

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/70 bg-background/95 p-10 text-center shadow-2xl">
        <div className="text-base font-semibold">Suelta aquí para abrir el chat</div>
        <div className="text-xs leading-5 text-muted-foreground">
          PDF, Word, Excel, PowerPoint, imágenes y más.
        </div>
      </div>
    </div>
  )
}
