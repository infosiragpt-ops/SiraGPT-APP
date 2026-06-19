"use client"

/**
 * DeploymentDetail — Replit "Overview" surface for a single deployment.
 * Suspended amber banner + action row (Resume / Adjust settings /
 * Security scan) + top tabs (Overview / Logs / Domains / Manage).
 */

import * as React from "react"
import { ExternalLink, Globe2, List, Loader2, Play, Settings, ShieldCheck, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  deploymentsApi,
  type DeploymentDetail as DeploymentDetailData,
} from "@/lib/deployments/deployments-api"

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
}: {
  detail: DeploymentDetailData
  onRefetch: () => void
}) {
  const { deployment, versions, domains } = detail
  const [tab, setTab] = React.useState<DetailTab>("overview")
  const [resuming, setResuming] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)

  const isPausedOrSuspended = deployment.status === "paused" || deployment.status === "suspended"
  const isSuspended = deployment.status === "suspended"

  const resume = async () => {
    setResuming(true)
    try {
      await deploymentsApi.resume(deployment.id)
      toast.success("Deployment resumed.")
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not resume.")
    } finally {
      setResuming(false)
    }
  }

  const runSecurityScan = async () => {
    setScanning(true)
    try {
      const scan = await deploymentsApi.securityScan(deployment.id)
      if (scan.status === "passed") {
        toast.success(scan.summary || `Security scan passed · ${scan.findings.length} finding(s).`)
      } else {
        const critical = scan.findings.filter((f) => f.severity === "critical" || f.severity === "high")
        toast.error(
          scan.summary ||
            `Scan found ${scan.findings.length} finding(s)${critical.length ? `, ${critical.length} critical` : ""}.`,
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run security scan.")
    } finally {
      setScanning(false)
    }
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="shrink-0 border-b border-border bg-background">
          <TabsList className="h-10 justify-start rounded-none bg-transparent p-0 px-3 text-foreground">
            <DeploymentTab value="overview" active={tab === "overview"} icon={<Globe2 className="h-3.5 w-3.5" />}>
              Overview
            </DeploymentTab>
            <DeploymentTab value="logs" active={tab === "logs"} icon={<List className="h-3.5 w-3.5" />}>
              Logs
            </DeploymentTab>
            <DeploymentTab value="domains" active={tab === "domains"} icon={<Globe2 className="h-3.5 w-3.5" />}>
              Domains
            </DeploymentTab>
            <DeploymentTab value="manage" active={tab === "manage"} icon={<Settings className="h-3.5 w-3.5" />}>
              Manage
            </DeploymentTab>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="w-full px-7 py-3">
            {tab === "overview" ? (
              <>
                {isSuspended ? <WarningBanner className="mb-3">{PENDING_PAYMENT_BANNER}</WarningBanner> : null}

                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 bg-[#6aa7ff] text-white hover:bg-[#5f9bf0] disabled:bg-[#d9d4c8] disabled:text-[#8d867b]"
                    onClick={() => void resume()}
                    disabled={!isPausedOrSuspended || resuming}
                  >
                    {resuming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 border-transparent bg-muted text-muted-foreground hover:bg-[#e1ddd2] hover:text-foreground"
                    onClick={() => setTab("manage")}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Adjust settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 border-transparent bg-muted text-foreground hover:bg-[#e1ddd2]"
                    onClick={() => void runSecurityScan()}
                    disabled={scanning}
                  >
                    {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    Run security scan
                    <ExternalLink className="h-3 w-3 opacity-70" />
                  </Button>
                </div>
              </>
            ) : null}

            <TabsContent value="overview" className="mt-0">
              <OverviewTab
                deployment={deployment}
                versions={versions}
                domains={domains}
                onRefetch={onRefetch}
                onNavigate={setTab}
              />
            </TabsContent>
            <TabsContent value="logs" className="mt-0">
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
        "relative h-10 rounded-none border-b-2 border-transparent bg-transparent px-3 text-[13px] font-medium shadow-none",
        "gap-1.5 hover:bg-muted/40 data-[state=active]:shadow-none",
        active ? "border-foreground bg-transparent text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {children}
    </TabsTrigger>
  )
}
