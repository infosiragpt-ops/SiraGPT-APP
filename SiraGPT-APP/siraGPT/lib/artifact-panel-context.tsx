"use client"

/**
 * artifact-panel-context — single source of truth for "is an
 * artifact currently open in the side panel, and if so, what?".
 *
 * The panel is rendered in the same resizable right-pane slot that
 * the Word / Excel / Document viewers use, so only one artifact is
 * ever visible at a time. ArtifactCard rows dispatch through
 * useArtifactPanel().open({...}) from anywhere in the chat tree.
 */

import React from "react"

export type ArtifactView = "preview" | "code"

export type ActiveArtifact = {
  code: string
  language: string
  title?: string
  view: ArtifactView
}

type Ctx = {
  active: ActiveArtifact | null
  open: (a: ActiveArtifact) => void
  close: () => void
  setView: (view: ArtifactView) => void
}

const ArtifactPanelContext = React.createContext<Ctx | null>(null)

export function useArtifactPanel(): Ctx {
  const ctx = React.useContext(ArtifactPanelContext)
  if (ctx) return ctx
  // Graceful fallback — lets ArtifactCard mount even outside the
  // provider (e.g. in share pages that render messages read-only).
  // Clicking "Abrir" in that mode just no-ops.
  return {
    active: null,
    open: () => {},
    close: () => {},
    setView: () => {},
  }
}

export function ArtifactPanelProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<ActiveArtifact | null>(null)

  const open = React.useCallback((a: ActiveArtifact) => {
    setActive(a)
  }, [])

  const close = React.useCallback(() => setActive(null), [])

  const setView = React.useCallback((view: ArtifactView) => {
    setActive((prev) => (prev ? { ...prev, view } : prev))
  }, [])

  const value = React.useMemo<Ctx>(() => ({ active, open, close, setView }), [active, open, close, setView])

  return (
    <ArtifactPanelContext.Provider value={value}>
      {children}
    </ArtifactPanelContext.Provider>
  )
}
