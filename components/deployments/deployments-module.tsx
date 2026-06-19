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
import {
  deploymentsApi,
  type Deployment,
  type DeploymentDetail as DeploymentDetailData,
} from "@/lib/deployments/deployments-api"

import { REPLIT_DEPLOYMENTS_STYLE } from "./shared"
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
    <div className="h-full min-h-0 bg-background text-foreground" style={REPLIT_DEPLOYMENTS_STYLE}>
      <section className="h-full min-h-0">
        {detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : detail ? (
          <DeploymentDetail detail={detail} onRefetch={refetchSelected} />
        ) : (
          <EmptyDetail
            onCreate={() => setCreateOpen(true)}
            hasDeployments={deployments.length > 0}
            loading={listLoading}
          />
        )}
      </section>

      <CreateDeploymentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />
    </div>
  )
}

function EmptyDetail({
  onCreate,
  hasDeployments,
  loading,
}: {
  onCreate: () => void
  hasDeployments: boolean
  loading: boolean
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Rocket className="h-5 w-5" />}
      </span>
      <div>
        <p className="text-[14px] font-semibold text-foreground">
          {loading ? "Loading deployments" : hasDeployments ? "Select a deployment" : "Publish this project"}
        </p>
        <p className="mt-1 max-w-sm text-[12px] text-muted-foreground">
          {loading
            ? "Checking the publishing service."
            : hasDeployments
            ? "Choose one from the list to view its status, logs, and domains."
            : "Publish a shareable version of your project to get started."}
        </p>
      </div>
      {!loading && !hasDeployments ? (
        <Button size="sm" className="h-9 gap-1.5" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          New deployment
        </Button>
      ) : null}
    </div>
  )
}
