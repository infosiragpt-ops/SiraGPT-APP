"use client"

// SettingsDialog — Claude-style floating settings window.
// Wraps <SettingsPanel variant="modal" />. Opened from sidebar Configuración.
// The /settings route still exists for deep-links and the command palette.

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
  const [mountKey, setMountKey] = React.useState(0)
  React.useEffect(() => {
    if (open) setMountKey((k) => k + 1)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        style={{
          width: "min(96vw, 1040px)",
          height: "min(88vh, 760px)",
          maxWidth: "1040px",
        }}
        className="p-0 gap-0 overflow-hidden flex flex-col sm:rounded-2xl border-border/70 bg-white dark:bg-background shadow-[0_24px_80px_-20px_rgba(0,0,0,0.28)]"
      >
        <SettingsPanel key={mountKey} variant="modal" initialSection={initialSection} />
      </DialogContent>
    </Dialog>
  )
}
