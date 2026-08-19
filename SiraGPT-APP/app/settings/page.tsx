"use client"

import React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AuthGuard } from "@/components/auth-guard"
import { SettingsPanel, type SectionKey } from "@/components/settings/settings-panel"

// The /settings route renders the shared SettingsPanel in full-page mode
// and keeps the section in sync with the ?s= query param (so deep-links
// like /settings?s=security and the command palette still work). The same
// panel is reused inside the floating SettingsDialog opened from the
// sidebar (see components/settings/settings-dialog.tsx).
export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsPageInner />
    </AuthGuard>
  )
}

function SettingsPageInner() {
  const router = useRouter()
  const search = useSearchParams()
  const initialSection = (search.get("s") as SectionKey) || "general"

  const handleSectionChange = React.useCallback(
    (s: SectionKey) => {
      const sp = new URLSearchParams(search.toString())
      sp.set("s", s)
      router.replace(`/settings?${sp.toString()}`, { scroll: false })
    },
    [router, search],
  )

  return (
    <SettingsPanel
      variant="page"
      initialSection={initialSection}
      onSectionChange={handleSectionChange}
    />
  )
}
