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

import {
  CODE_NEW_CODE_CHAT_EVENT,
  CODE_OPEN_TOOL_EVENT,
  CodeWorkspaceProvider,
  setActiveCodexProject,
  type CodeNewChatDetail,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import { listCodexProjects } from "@/lib/codex-projects"
import { codexProjectIdFromWorkspaceId } from "@/lib/codex-workspace-identity"
import { resolveCodeWorkspaceFolder } from "@/lib/code-workspace-route"
import { codexApi } from "@/lib/codex/codex-api"
import { persistWorkspaceCodexProject } from "@/lib/codex/codex-project-link"
import { projectsService } from "@/lib/projects-service"
import { useAuth } from "@/lib/auth-context-integrated"
import { useCodexHealth } from "@/lib/codex/use-codex-health"
import {
  buildCodeLoginNext,
  classifyFolderLoadError,
  encodeLoginNext,
} from "@/lib/code-folder-utils"

const CodeWorkspace = dynamic(
  () => import("@/components/code/code-workspace").then((mod) => mod.CodeWorkspace),
  {
    ssr: false,
    loading: CodeWorkspaceSkeleton,
  },
)

// The real agent surface (Codex V2): a plan → build → run → observe → auto-fix
// loop with a run timeline, plan cards, checkpoints/rollback and a live preview
// — an agent you give orders to, not a one-shot template generator.
const CodexAgentPanel = dynamic(
  () => import("@/components/codex/codex-agent-panel").then((mod) => mod.CodexAgentPanel),
  {
    ssr: false,
    loading: () => <CodeWorkspaceSkeleton />,
  },
)

// WorkspaceSurface — mount the real Codex agent when the V2 flag is on
// (useCodexHealth probes GET /api/codex/health, public + sticky), otherwise
// fall back to the legacy deterministic CodeWorkspace so /code is never broken.
function WorkspaceSurface() {
  const { enabled, loading } = useCodexHealth()
  if (loading) return <CodeWorkspaceSkeleton />
  return enabled ? <CodexAgentPanel surface="code" /> : <CodeWorkspace />
}

export default function CodeWorkspacePage() {
  return (
    <CodeWorkspaceGate>
      <CodeWorkspaceProvider>
        <React.Suspense fallback={null}>
          <ActiveFolderHydrator />
        </React.Suspense>
        <WorkspaceSurface />
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
    if (typeof window !== "undefined") {
      // Preserve ?folder= / ?local= / ?tool= / ?agent= through login.
      // Use location.search (not useSearchParams) so the gate stays outside Suspense.
      router.replace(
        `/auth/login?next=${encodeLoginNext(buildCodeLoginNext(window.location.search))}`,
      )
    }
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
  const router = useRouter()
  const folderId = searchParams?.get("folder") || null
  const localId = searchParams?.get("local") || null
  const toolId = searchParams?.get("tool") || null
  const agentId = searchParams?.get("agent") || null
  const { activeFolder, setActiveFolder, switchCodexWorkspace, hydrateFiles } = useCodeWorkspace()
  const firedAgentRef = React.useRef<string | null>(null)
  const hydratedFolderRef = React.useRef<string | null>(null)
  const [routeIssue, setRouteIssue] = React.useState<0 | 1 | 2>(0)
  const [hydrationAttempt, setHydrationAttempt] = React.useState(0)

  React.useEffect(() => {
    if (localId) {
      setRouteIssue(0)
      if (hydratedFolderRef.current === localId) return
      hydratedFolderRef.current = localId
      const entry = listCodexProjects().find((row) => row.id === localId)
      void switchCodexWorkspace({
        id: localId,
        name: entry?.name || localId.replace(/^local:/, ""),
        kind: "local-folder",
      })
      return
    }
    if (!folderId) {
      hydratedFolderRef.current = null
      setRouteIssue(0)
      return
    }
    if (hydratedFolderRef.current === folderId) return
    let cancelled = false
    ;(async () => {
      try {
        const [directCodexProject, project] = await resolveCodeWorkspaceFolder(
          folderId,
          projectsService.get,
          codexApi.getProject,
        )
        if (cancelled) return
        const workspaceId = `${directCodexProject ? "codex" : "project"}:${project.id}`
        setRouteIssue(0)
        hydratedFolderRef.current = folderId
        if (directCodexProject) {
          persistWorkspaceCodexProject(workspaceId, project.id)
        }
        setActiveCodexProject(directCodexProject ? project.id : null)
        setActiveFolder(directCodexProject
          ? { id: workspaceId, name: project.name }
          : {
              id: workspaceId,
              name: project.name,
              description: project.description,
              instructions: project.instructions,
            })
        // Hydrate editor FS from Project.codeWorkspace when present (not knowledge files).
        if (!directCodexProject) {
          try {
            const remote = await projectsService.getCodeWorkspace(project.id)
            const entries = Object.entries(remote.workspace?.files || {})
            if (entries.length > 0) {
              hydrateFiles(
                entries.map(([path, entry]) => ({
                  path,
                  content: typeof entry?.content === "string" ? entry.content : "",
                })),
              )
            }
          } catch {
            /* fail soft — browser localStorage remains */
          }
        }
      } catch (error) {
        if (cancelled) return
        // Differentiated kinds for UI copy (not-found vs auth vs network/server).
        const classified = classifyFolderLoadError(error)
        if (classified.kind === "not_found" || classified.kind === "forbidden") {
          setRouteIssue(1)
          hydratedFolderRef.current = folderId
          setActiveCodexProject(null)
          setActiveFolder(null)
        } else {
          setRouteIssue(2)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folderId, localId, hydrationAttempt, setActiveFolder, switchCodexWorkspace, hydrateFiles])

  React.useEffect(() => {
    if (!toolId) return
    try {
      window.localStorage.setItem("code-workspace:pending-tool", toolId)
    } catch {
      /* fail soft */
    }
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CODE_OPEN_TOOL_EVENT, { detail: { toolId } }))
    }, 120)
  }, [toolId])

  React.useEffect(() => {
    const titleByAgent: Record<string, string> = {
      builder: "Builder Agent",
      assistant: "Assistant Agent",
      debugger: "Debugger Agent",
    }
    const title = agentId ? titleByAgent[agentId] : null
    if (!title) return
    if (folderId && hydratedFolderRef.current !== folderId) return
    const workspaceId = localId || activeFolder?.id || null
    if (!workspaceId) return
    const projectId = codexProjectIdFromWorkspaceId(workspaceId, { assumeProject: true })
    const signature = `${workspaceId}:${agentId}`
    if (firedAgentRef.current === signature) return
    firedAgentRef.current = signature

    const detail: CodeNewChatDetail = {
      workspaceId,
      name: activeFolder?.name || workspaceId.replace(/^(?:project|codex|local):/, "") || "Workspace",
      kind: localId ? "local-folder" : "project",
      projectId: projectId || undefined,
      title,
    }
    const openAgent = () => {
      window.dispatchEvent(new CustomEvent(CODE_NEW_CODE_CHAT_EVENT, { detail }))
    }
    window.setTimeout(openAgent, 220)
    window.setTimeout(openAgent, 900)
  }, [activeFolder?.id, activeFolder?.name, agentId, folderId, localId])

  if (!routeIssue) return null
  return (
    <div
      className="absolute left-1/2 top-3 z-50 flex w-[min(680px,calc(100vw-24px))] -translate-x-1/2 items-center justify-between gap-3 rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-100"
      role="alert"
      data-testid="code-workspace-route-error"
    >
      <span>
        {routeIssue === 1
          ? "Workspace no disponible"
          : "No se pudo cargar"}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md border border-current px-2.5 py-1 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900"
        onClick={() => {
          if (routeIssue === 2) {
            hydratedFolderRef.current = null
            setRouteIssue(0)
            setHydrationAttempt((attempt) => attempt + 1)
            return
          }
          setRouteIssue(0)
          router.replace("/code")
        }}
      >
        {routeIssue === 2 ? "Reintentar" : "Abrir workspaces"}
      </button>
    </div>
  )
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
