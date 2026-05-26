"use client"

/**
 * /code — Cursor-inspired AI coding workspace.
 *
 * Layout: Cursor Chat (left), editor + terminal (center), Codex folders (right).
 * The whole page is a single client
 * component so the workspace state stays mounted while the user
 * navigates within it; the inner pieces are lazy-loaded so the
 * route shell paints fast and the editor chunk only ships when
 * the page is actually used.
 *
 * Folder scoping: the page reads ?folder=<projectId> from the URL
 * (set by the sidebar dropdown) and hydrates the active folder
 * with the project's metadata so the chat prompt and the top bar
 * can reflect it. This keeps the URL the source of truth, so
 * sharing a link to a workspace works.
 */

import dynamic from "next/dynamic"
import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { CodeWorkspaceProvider, useCodeWorkspace } from "@/lib/code-workspace-context"
import { listCodexProjects } from "@/lib/codex-projects"
import { projectsService } from "@/lib/projects-service"
import { useAuth } from "@/lib/auth-context-integrated"

const CodeWorkspace = dynamic(
  () => import("@/components/code/code-workspace").then((mod) => mod.CodeWorkspace),
  {
    ssr: false,
    loading: () => <CodeWorkspaceSkeleton />,
  },
)

export default function CodeWorkspacePage() {
  return (
    <CodeWorkspaceGate>
      <CodeWorkspaceProvider>
        <React.Suspense fallback={null}>
          <ActiveFolderHydrator />
        </React.Suspense>
        <CodeWorkspace />
      </CodeWorkspaceProvider>
    </CodeWorkspaceGate>
  )
}

// CodeWorkspaceGate — login-only gate. The plan-tier check that
// previously paywalled the workspace behind PRO / PRO_MAX /
// ENTERPRISE has been removed: the workspace is open to every
// authenticated user (FREE included). Backend usage is still
// metered by the existing plan-quota middleware on /api/agent and
// /api/document-ai, so a FREE account that exhausts its monthly
// quota gets a 429 from the API rather than a hard plan gate at
// the page level.
function CodeWorkspaceGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  if (isLoading) return <CodeWorkspaceSkeleton />

  if (!user) {
    if (typeof window !== "undefined") router.replace("/auth/login?next=/code")
    return <CodeWorkspaceSkeleton />
  }

  return <>{children}</>
}

/**
 * ActiveFolderHydrator — converts the ?folder= query param into a
 * fully-hydrated entry on the workspace context. Keeps the page
 * itself dumb so most of the work lives in the provider, and lets
 * the user share /code?folder=<id> links.
 */
function ActiveFolderHydrator() {
  const searchParams = useSearchParams()
  const folderId = searchParams?.get("folder") || null
  const localId = searchParams?.get("local") || null
  const { activeFolder, setActiveFolder, switchCodexWorkspace } = useCodeWorkspace()

  React.useEffect(() => {
    if (localId) {
      if (activeFolder?.id === localId) return
      const entry = listCodexProjects().find((row) => row.id === localId)
      void switchCodexWorkspace({
        id: localId,
        name: entry?.name || localId.replace(/^local:/, ""),
        kind: "local-folder",
      })
      return
    }
    if (!folderId) return
    if (activeFolder?.id === folderId) return
    let cancelled = false
    ;(async () => {
      try {
        const project = await projectsService.get(folderId)
        if (cancelled) return
        setActiveFolder({
          id: project.id,
          name: project.name,
          description: project.description,
          instructions: project.instructions,
        })
      } catch {
        if (cancelled) return
        setActiveFolder({ id: folderId, name: folderId })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folderId, localId, activeFolder?.id, setActiveFolder, switchCodexWorkspace])

  return null
}

function CodeWorkspaceSkeleton() {
  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
        <div className="ml-auto h-5 w-[260px] rounded border border-border/60 bg-muted/30 animate-pulse" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[360px_1fr]">
        <div className="border-r border-border/60 p-3 space-y-3">
          <div className="h-7 w-32 rounded-full bg-muted/40 animate-pulse" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-6 w-28 rounded-md bg-muted/40 animate-pulse" />
            ))}
          </div>
          <div className="flex-1 p-3 space-y-2">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="h-3 rounded bg-muted/30 animate-pulse" style={{ width: `${30 + ((i * 7) % 60)}%` }} />
            ))}
          </div>
        </div>
      </div>
      <div className="h-6 shrink-0 border-t border-border/60 bg-primary/95" />
    </div>
  )
}
