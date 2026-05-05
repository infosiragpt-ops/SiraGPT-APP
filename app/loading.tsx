// ──────────────────────────────────────────────────────────────
// siraGPT — Loading State (Suspense Fallback)
// ──────────────────────────────────────────────────────────────
// Next.js wraps page content in React Suspense automatically
// when this file exists. Shown during streaming SSR or when
// async server components are resolving.
// ──────────────────────────────────────────────────────────────

import { Loader2 } from "lucide-react"

export default function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground/60">
          Cargando...
        </p>
      </div>
    </div>
  )
}
