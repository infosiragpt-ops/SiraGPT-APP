"use client"

import dynamic from "next/dynamic"
import * as React from "react"
import { useRouter } from "next/navigation"

import { CodeWorkspaceProvider } from "@/lib/code-workspace-context"
import { useAuth } from "@/lib/auth-context-integrated"

const CodexAgentPanel = dynamic(
  () => import("@/components/codex/codex-agent-panel").then((mod) => mod.CodexAgentPanel),
  { ssr: false, loading: () => <AppsSkeleton /> },
)

export default function AppsPage() {
  return (
    <AppsGate>
      <CodeWorkspaceProvider>
        <CodexAgentPanel surface="apps" />
      </CodeWorkspaceProvider>
    </AppsGate>
  )
}

function AppsGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  React.useEffect(() => {
    if (!isLoading && !user) router.replace("/auth/login?next=/apps")
  }, [isLoading, router, user])

  if (isLoading) return <AppsSkeleton />

  if (!user) return <AppsSkeleton />

  return <>{children}</>
}

function AppsSkeleton() {
  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-3">
        <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
        <div className="ml-auto h-7 w-24 animate-pulse rounded-md bg-white/10" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[42%] min-w-[400px] border-r border-white/10 p-3">
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-white/[0.06]" />
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 p-3">
          <div className="h-full animate-pulse rounded-xl bg-white/[0.04]" />
        </div>
      </div>
    </div>
  )
}
