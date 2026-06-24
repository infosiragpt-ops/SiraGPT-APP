"use client"

/**
 * WorkspaceDeploymentsTool — the Deployments module embedded INSIDE the /code
 * workspace tool dock (replaces the old mock PublishingTool). Scoped to the
 * current project: reads `activeFolder` from the workspace context and only
 * shows/creates deployments linked to that project (projectId).
 *
 * Flag-gated: when DEPLOYMENTS_V2 is off (e.g. prod) it renders the `fallback`
 * (the legacy PublishingTool) so nothing regresses.
 */

import * as React from "react"
import { Loader2, Plus, Rocket } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import {
  deploymentsApi,
  type Deployment,
  type DeploymentDetail as DeploymentDetailData,
} from "@/lib/deployments/deployments-api"

import { REPLIT_DEPLOYMENTS_STYLE, statusPill, StatusPill } from "./shared"
import { DeploymentDetail } from "./deployment-detail"
import { EmptyDeploymentDetail } from "./empty-deployment-detail"
import { CreateDeploymentDialog } from "./create-deployment-dialog"

export function WorkspaceDeploymentsTool({ fallback }: { fallback?: React.ReactNode }) {
  const { activeFolder } = useCodeWorkspace()
  const projectId = activeFolder?.id ?? null
  const projectName = activeFolder?.name ?? ""

  const [enabled, setEnabled] = React.useState<boolean | null>(null)
  const [deployments, setDeployments] = React.useState<Deployment[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<DeploymentDetailData | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    deploymentsApi
      .health()
      .then((h) => alive && setEnabled(h.enabled))
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [])

  const loadList = React.useCallback(
    async (preferId?: string) => {
      setLoading(true)
      try {
        const all = await deploymentsApi.list()
        const rows = projectId ? all.filter((d) => d.projectId === projectId) : all
        setDeployments(rows)
        setSelectedId((cur) => {
          const wanted = preferId ?? cur
          if (wanted && rows.some((r) => r.id === wanted)) return wanted
          return rows[0]?.id ?? null
        })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not load deployments.")
      } finally {
        setLoading(false)
      }
    },
    [projectId],
  )

  React.useEffect(() => {
    if (enabled) void loadList()
  }, [enabled, loadList])

  const loadDetail = React.useCallback(async (id: string) => {
    try {
      setDetail(await deploymentsApi.get(id))
    } catch {
      setDetail(null)
    }
  }, [])

  React.useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
    else setDetail(null)
  }, [selectedId, loadDetail])

  const refetch = React.useCallback(() => {
    void loadList()
    if (selectedId) void loadDetail(selectedId)
  }, [loadList, loadDetail, selectedId])

  if (enabled === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (!enabled) return <>{fallback ?? <DisabledState />}</>

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      style={REPLIT_DEPLOYMENTS_STYLE}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Rocket className="h-4 w-4 text-muted-foreground" />
          <span className="truncate text-[13px] font-semibold text-foreground">
            Publishing{projectName ? ` · ${projectName}` : ""}
          </span>
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      {deployments.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
          {deployments.map((d) => {
            const pill = statusPill(d.status)
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setSelectedId(d.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors",
                  d.id === selectedId ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <span className="max-w-[140px] truncate">{d.name}</span>
                <StatusPill tone={pill.tone} label={pill.label} />
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !detail ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : detail ? (
          <DeploymentDetail detail={detail} onRefetch={refetch} />
        ) : (
          <EmptyDeploymentDetail projectName={projectName} onCreate={() => setCreateOpen(true)} />
        )}
      </div>

      <CreateDeploymentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        defaultName={projectName}
        onCreated={(d) => void loadList(d.id)}
      />
    </div>
  )
}

function DisabledState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
      <Rocket className="h-5 w-5" />
      <p className="text-[13px] font-medium text-foreground">Publishing is not enabled</p>
      <p className="max-w-sm text-[12px]">Enable DEPLOYMENTS_V2 to publish this project.</p>
    </div>
  )
}
