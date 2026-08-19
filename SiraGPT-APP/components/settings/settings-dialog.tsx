"use client"

// ────────────────────────────────────────────────────────────
// SettingsDialog — floating Claude-style settings window.
// Wraps the shared <SettingsPanel variant="modal" /> in a large,
// centered Dialog. Opened from the sidebar "Configuración" item.
// The /settings route still exists (deep-links, command palette, etc.)
// and renders the same panel in variant="page".
// ────────────────────────────────────────────────────────────

import React from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { SettingsPanel, type SectionKey } from "@/components/settings/settings-panel"

export function SettingsDialog({
  open,
  onOpenChange,
  initialSection = "general",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: SectionKey
}) {
  // Remount the panel each time the dialog opens so it resets to the
  // requested initial section and re-reads fresh data (sessions, stats…).
  const [mountKey, setMountKey] = React.useState(0)
  React.useEffect(() => {
    if (open) setMountKey((k) => k + 1)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Dimensions are inline so the floating window never depends on
        // Tailwind JIT generating brand-new arbitrary values (which can lag
        // in dev / be purged). Layout/visual classes stay in className.
        style={{ width: "min(96vw, 980px)", height: "min(88vh, 880px)", maxWidth: "980px" }}
        className="p-0 gap-0 overflow-hidden flex flex-col sm:rounded-2xl"
      >
        <SettingsPanel key={mountKey} variant="modal" initialSection={initialSection} />
      </DialogContent>
    </Dialog>
  )
}
