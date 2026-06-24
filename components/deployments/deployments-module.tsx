"use client"

/**
 * DeploymentsModule — top-level surface for the Deployments / Publishing module.
 *
 * Single Replit-like Publishing surface. Shows the selected deployment detail,
 * or the empty tabbed Overview/Logs/Domains/Manage state before first publish.
 */

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  deploymentsApi,
  type Deployment,
  type DeploymentDetail as DeploymentDetailData,
} from "@/lib/deployments/deployments-api"

import { REPLIT_DEPLOYMENTS_STYLE } from "./shared"
import { DeploymentDetail } from "./deployment-detail"
import { EmptyDeploymentDetail } from "./empty-deployment-detail"
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
          <EmptyDeploymentDetail
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
