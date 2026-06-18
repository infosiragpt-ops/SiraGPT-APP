"use client"

/**
 * DeploymentsModule — top-level surface for the Deployments / Publishing module.
 *
 * Left: a slim selectable list of the user's deployments + "New deployment".
 * Right: the selected deployment's detail panel (Replit Overview clone).
 * Owns the selected-id state and refetches after mutations.
 */

import * as React from "react"
import { Loader2, Plus, Rocket } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  deploymentsApi,
  type Deployment,
  type DeploymentDetail as DeploymentDetailData,
} from "@/lib/deployments/deployments-api"

import { statusPill, StatusPill, timeAgo } from "./shared"
import { DeploymentDetail } from "./deployment-detail"
import { CreateDeploymentDialog } from "./create-deployment-dialog"

export function DeploymentsModule() {
  const [deployments, setDeployments] = React.useState<Deployment[]>([])
  const [listLoading, setListLoading] = React.useState(true)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<DeploymentDetailData | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)

  const loadList = React.useCallback(async (preferId?: string) => {
    setListLoading(true)
    try {
      const rows = await deploymentsApi.list()
      setDeployments(rows)
      setSelectedId((current) => {
        const wanted = preferId ?? current
        if (wanted && rows.some((r) => r.id === wanted)) return wanted
        return rows[0]?.id ?? null
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load deployments.")
    } finally {
      setListLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadList()
  }, [loadList])

  const loadDetail = React.useCallback(async (id: string) => {
    setDetailLoading(true)
    try {
      const data = await deploymentsApi.get(id)
      setDetail(data)
    } catch (error) {
      setDetail(null)
      toast.error(error instanceof Error ? error.message : "Could not load deployment.")
    } finally {
      setDetailLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  // Refetch both list (for the status pill) and the detail panel after a mutation.
  const refetchSelected = React.useCallback(() => {
    void loadList()
    if (selectedId) void loadDetail(selectedId)
  }, [loadList, loadDetail, selectedId])

  const onCreated = (deployment: Deployment) => {
    void loadList(deployment.id)
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_1fr]">
      {/* Left: selector */}
      <aside className="flex min-h-0 flex-col border-r border-border/60 bg-background">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-muted-foreground" />
            <span className="text-[13px] font-semibold text-foreground">Publishing</span>
          </div>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {listLoading ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/30" />
              ))}
            </div>
          ) : deployments.length === 0 ? (
            <p className="px-3 py-4 text-[12px] text-muted-foreground">
              You do not have deployments yet. Create the first one.
            </p>
          ) : (
            <ul className="space-y-1">
              {deployments.map((deployment) => {
                const pill = statusPill(deployment.status)
                const isActive = deployment.id === selectedId
                return (
                  <li key={deployment.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(deployment.id)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                        isActive
                          ? "border-border bg-muted/60"
                          : "border-transparent hover:border-border/60 hover:bg-muted/30",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-foreground">{deployment.name}</span>
                        <StatusPill tone={pill.tone} label={pill.label} />
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {deployment.typeLabel} · {timeAgo(deployment.updatedAt)}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Right: detail */}
      <section className="min-h-0">
        {detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : detail ? (
          <DeploymentDetail detail={detail} onRefetch={refetchSelected} />
        ) : (
          <EmptyDetail onCreate={() => setCreateOpen(true)} hasDeployments={deployments.length > 0} />
        )}
      </section>

      <CreateDeploymentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />
    </div>
  )
}

function EmptyDetail({ onCreate, hasDeployments }: { onCreate: () => void; hasDeployments: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
        <Rocket className="h-5 w-5" />
      </span>
      <div>
        <p className="text-[14px] font-semibold text-foreground">
          {hasDeployments ? "Select a deployment" : "No deployments yet"}
        </p>
        <p className="mt-1 max-w-sm text-[12px] text-muted-foreground">
          {hasDeployments
            ? "Choose one from the list to view its status, logs, and domains."
            : "Publish a shareable version of your project to get started."}
        </p>
      </div>
      {!hasDeployments ? (
        <Button size="sm" className="h-9 gap-1.5" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          New deployment
        </Button>
      ) : null}
    </div>
  )
}
