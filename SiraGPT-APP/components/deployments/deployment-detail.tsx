"use client"

/**
 * DeploymentDetail - Replit-style tab shell for one deployment.
 * The child tabs keep the existing deployment actions and data flow.
 */

import * as React from "react"
import { Globe2, List, Settings } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { type DeploymentDetail as DeploymentDetailData } from "@/lib/deployments/deployments-api"

import { WarningBanner } from "./shared"
import { OverviewTab } from "./overview-tab"
import { LogsTab } from "./logs-tab"
import { DomainsTab } from "./domains-tab"
import { ManageTab } from "./manage-tab"

export type DetailTab = "overview" | "logs" | "domains" | "manage"

const PENDING_PAYMENT_BANNER =
  "You have a delinquent payment. Please update your payment method to use Reserved VM deployments."

export function DeploymentDetail({
  detail,
  onRefetch,
  autoPublishSignal = 0,
  onAutoPublishConsumed,
}: {
  detail: DeploymentDetailData
  onRefetch: () => void
  autoPublishSignal?: number
  onAutoPublishConsumed?: () => void
}) {
  const { deployment, versions, domains } = detail
  const [tab, setTab] = React.useState<DetailTab>("overview")
  const isSuspended = deployment.status === "suspended"
  const contentClassName = tab === "logs" || tab === "overview" ? "h-full w-full" : "w-full px-3 py-0"

  React.useEffect(() => {
    if (autoPublishSignal) setTab("overview")
  }, [autoPublishSignal])

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
      <div className="flex h-full min-h-0 flex-col bg-[#1f1f1f] text-white">
        <div className="shrink-0 border-b border-[#353535] bg-[#1f1f1f]">
          <TabsList className="h-[46px] justify-start rounded-none bg-transparent p-0 px-0 text-white">
            <DeploymentTab value="overview" active={tab === "overview"} icon={<Globe2 className="h-4 w-4" />}>
              Overview
            </DeploymentTab>
            <DeploymentTab value="logs" active={tab === "logs"} icon={<List className="h-4 w-4" />}>
              Logs
            </DeploymentTab>
            <DeploymentTab value="domains" active={tab === "domains"} icon={<Globe2 className="h-4 w-4" />}>
              Domains
            </DeploymentTab>
            <DeploymentTab value="manage" active={tab === "manage"} icon={<Settings className="h-4 w-4" />}>
              Manage
            </DeploymentTab>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#1f1f1f]">
          <div className={contentClassName}>
            {tab === "overview" && isSuspended ? (
              <div className="px-4 pt-2">
                <WarningBanner className="border-[#6c5619] bg-[#332c12] text-[#f4e7a8]">{PENDING_PAYMENT_BANNER}</WarningBanner>
              </div>
            ) : null}

            <TabsContent value="overview" className="mt-0 h-full">
              <OverviewTab
                deployment={deployment}
                versions={versions}
                domains={domains}
                onRefetch={onRefetch}
                onNavigate={setTab}
                autoPublishSignal={autoPublishSignal}
                onAutoPublishConsumed={onAutoPublishConsumed}
              />
            </TabsContent>
            <TabsContent value="logs" className="mt-0 h-full">
              <LogsTab deploymentId={deployment.id} />
            </TabsContent>
            <TabsContent value="domains" className="mt-0">
              <DomainsTab
                deploymentId={deployment.id}
                deployment={deployment}
                domains={domains}
                versions={versions}
                onRefetch={onRefetch}
              />
            </TabsContent>
            <TabsContent value="manage" className="mt-0">
              <ManageTab deployment={deployment} onRefetch={onRefetch} />
            </TabsContent>
          </div>
        </div>
      </div>
    </Tabs>
  )
}

function DeploymentTab({
  value,
  active,
  icon,
  children,
}: {
  value: DetailTab
  active: boolean
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        "relative h-[46px] rounded-none border-b-2 border-transparent bg-transparent px-4 text-[14px] font-medium shadow-none",
        "gap-2 text-white hover:bg-[#262626] data-[state=active]:shadow-none",
        active ? "border-[#0f7bea] bg-[#17345a] text-white" : "text-[#dcdcdc]",
      )}
    >
      {icon}
      {children}
    </TabsTrigger>
  )
}
