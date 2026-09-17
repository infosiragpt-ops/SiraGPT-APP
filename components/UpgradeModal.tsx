"use client"

/**
 * UpgradeModal — compatibility shim.
 *
 * The plans experience is no longer a dialog: it lives on the full-screen
 * page `/planes` (two plans only — Pro $10/mes via Stripe and "Hablemos"
 * via WhatsApp — with a back button, Claude-style). Every legacy caller
 * (sidebar "Mejorar plan", chat quota errors, the `open-upgrade-modal`
 * window event, the /code top bar) still mounts this component with
 * `open` / `onOpenChange`, so instead of touching a dozen call sites we
 * keep the props contract and turn "open" into a navigation.
 *
 * Renders nothing. `user`, `onSubscribe` and `isSubscribing` are accepted
 * for backwards compatibility and intentionally ignored: checkout is
 * handled by the page itself.
 */

import * as React from "react"
import { useRouter } from "next/navigation"

export const PLANS_PATH = "/planes"

type Plan = "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE"

interface UpgradeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user?: unknown
  onSubscribe?: (plan: Exclude<Plan, "FREE">) => Promise<void>
  isSubscribing?: boolean
}

export default function UpgradeModal({ open, onOpenChange }: UpgradeModalProps) {
  const router = useRouter()

  React.useEffect(() => {
    if (!open) return
    // Close the (virtual) dialog first so the parent state settles, then go
    // full screen. Same tick: the user sees no flash of an empty modal.
    onOpenChange(false)
    router.push(PLANS_PATH)
  }, [open, onOpenChange, router])

  return null
}
