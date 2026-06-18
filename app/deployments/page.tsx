"use client"

/**
 * /deployments — Deployments / Publishing module.
 *
 * A faithful UI clone of Replit's Deployments "Overview" tab, wired to the
 * already-built /api/deployments backend. Auth-gated like /code, and mounted
 * only when the DEPLOYMENTS_V2 flag is on (probed via deploymentsApi.health()).
 * The heavy module is lazy-loaded with ssr:false so the route shell paints fast.
 */

import dynamic from "next/dynamic"
import * as React from "react"
import { Loader2, Rocket } from "lucide-react"
import { useRouter } from "next/navigation"

import { useAuth } from "@/lib/auth-context-integrated"
import { deploymentsApi } from "@/lib/deployments/deployments-api"

const DeploymentsModule = dynamic(
  () => import("@/components/deployments/deployments-module").then((mod) => mod.DeploymentsModule),
  { ssr: false, loading: () => <ModuleSkeleton /> },
)

export default function DeploymentsPage() {
  return (
    <DeploymentsGate>
      <DeploymentsHealthGate />
    </DeploymentsGate>
  )
}

// Login-only gate, mirroring app/code/page.tsx CodeWorkspaceGate.
function DeploymentsGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  if (isLoading) return <ModuleSkeleton />

  if (!user) {
    if (typeof window !== "undefined") router.replace("/auth/login?next=/deployments")
    return <ModuleSkeleton />
  }

  return <>{children}</>
}

type HealthState = "loading" | "enabled" | "disabled" | "error"

function DeploymentsHealthGate() {
  const [state, setState] = React.useState<HealthState>("loading")

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const health = await deploymentsApi.health()
        if (cancelled) return
        setState(health.enabled ? "enabled" : "disabled")
      } catch {
        if (cancelled) return
        setState("error")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state === "loading") return <ModuleSkeleton />
  if (state === "enabled") {
    return (
      <div className="h-screen min-h-0 overflow-hidden">
        <DeploymentsModule />
      </div>
    )
  }

  return <DisabledState isError={state === "error"} />
}

function DisabledState({ isError }: { isError: boolean }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
        <Rocket className="h-5 w-5" />
      </span>
      <div>
        <p className="text-[15px] font-semibold text-foreground">
          {isError ? "Could not contact the publishing service" : "Publishing is not enabled"}
        </p>
        <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
          {isError
            ? "Try again in a few moments."
            : "This module requires DEPLOYMENTS_V2. Enable it on the server to start publishing."}
        </p>
      </div>
    </div>
  )
}

function ModuleSkeleton() {
  return (
    <div className="grid h-screen grid-cols-[300px_1fr] overflow-hidden bg-background text-foreground">
      <div className="space-y-3 border-r border-border/60 p-3">
        <div className="flex items-center justify-between">
          <div className="h-5 w-28 animate-pulse rounded bg-muted/40" />
          <div className="h-7 w-16 animate-pulse rounded-md bg-muted/40" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/30" />
        ))}
      </div>
      <div className="flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    </div>
  )
}
