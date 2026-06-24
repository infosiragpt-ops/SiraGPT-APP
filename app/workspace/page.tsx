"use client"

/**
 * /workspace — Replit-style hub.
 * Connect GitHub, then import/clone repos into real server-side workspaces.
 */

import * as React from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { GithubConnectCard } from "@/components/workspace/github-connect-card"
import { ImportRepoPanel } from "@/components/workspace/import-repo-panel"
import type { GithubStatus } from "@/lib/github-service"

export default function WorkspaceHubPage() {
  const [connected, setConnected] = React.useState(false)

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Importa código desde GitHub y trabaja con control de versiones completo.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <GithubConnectCard onChange={(s: GithubStatus) => setConnected(Boolean(s.connected))} />
        <ImportRepoPanel connected={connected} />
      </div>
    </div>
  )
}
