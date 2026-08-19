"use client"

import * as React from "react"
import { Globe2, List, Loader2, Rocket, Settings } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import type { DetailTab } from "./deployment-detail"

type EmptyDeploymentDetailProps = {
  loading?: boolean
  hasDeployments?: boolean
  projectName?: string
  onCreate: () => void
}

export function EmptyDeploymentDetail({
  loading = false,
  hasDeployments = false,
  projectName = "",
  onCreate,
}: EmptyDeploymentDetailProps) {
  const [tab, setTab] = React.useState<DetailTab>("overview")
  const disabled = loading || hasDeployments
  const projectLabel = projectName ? `"${projectName}"` : "this project"

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="shrink-0 border-b border-border bg-background">
          <TabsList className="h-10 justify-start rounded-none bg-transparent p-0 px-3 text-foreground">
            <EmptyDeploymentTab value="overview" active={tab === "overview"} icon={<Globe2 className="h-3.5 w-3.5" />}>
              Overview
            </EmptyDeploymentTab>
            <EmptyDeploymentTab value="logs" active={tab === "logs"} icon={<List className="h-3.5 w-3.5" />}>
              Logs
            </EmptyDeploymentTab>
            <EmptyDeploymentTab value="domains" active={tab === "domains"} icon={<Globe2 className="h-3.5 w-3.5" />}>
              Domains
            </EmptyDeploymentTab>
            <EmptyDeploymentTab value="manage" active={tab === "manage"} icon={<Settings className="h-3.5 w-3.5" />}>
              Manage
            </EmptyDeploymentTab>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-3">
          <TabsContent value="overview" className="mt-0">
            <EmptyPanel
              loading={loading}
              icon={<Rocket className="h-5 w-5" />}
              title={loading ? "Loading deployments" : hasDeployments ? "Select a deployment" : "Publish this project"}
              detail={
                loading
                  ? "Checking the publishing service."
                  : hasDeployments
                    ? "Choose a deployment to view status, logs, domains, and management settings."
                    : `Create a deployment for ${projectLabel} to get status, domains, logs, and version history.`
              }
              actionLabel="Publish"
              onCreate={onCreate}
              disabled={disabled}
            />
          </TabsContent>
          <TabsContent value="logs" className="mt-0">
            <EmptyPanel
              icon={<List className="h-5 w-5" />}
              title="No logs yet"
              detail="Create a deployment to stream build output, runtime logs, and recent deploy activity."
              actionLabel="Publish"
              onCreate={onCreate}
              disabled={disabled}
            />
          </TabsContent>
          <TabsContent value="domains" className="mt-0">
            <EmptyPanel
              icon={<Globe2 className="h-5 w-5" />}
              title="No domains yet"
              detail="Create a deployment before adding generated domains or connecting a custom domain."
              actionLabel="Publish"
              onCreate={onCreate}
              disabled={disabled}
            />
          </TabsContent>
          <TabsContent value="manage" className="mt-0">
            <EmptyPanel
              icon={<Settings className="h-5 w-5" />}
              title="No deployment settings yet"
              detail="Create a deployment to manage runtime type, visibility, lifecycle actions, and publish history."
              actionLabel="Publish"
              onCreate={onCreate}
              disabled={disabled}
            />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}

function EmptyPanel({
  loading = false,
  icon,
  title,
  detail,
  actionLabel,
  onCreate,
  disabled,
}: {
  loading?: boolean
  icon: React.ReactNode
  title: string
  detail: string
  actionLabel: string
  onCreate: () => void
  disabled: boolean
}) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      </span>
      <div>
        <p className="text-[14px] font-semibold text-foreground">{title}</p>
        <p className="mt-1 max-w-sm text-[12px] leading-5 text-muted-foreground">{detail}</p>
      </div>
      {!disabled ? (
        <Button size="sm" className="h-9 gap-1.5" onClick={onCreate}>
          <Rocket className="h-3.5 w-3.5" />
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

function EmptyDeploymentTab({
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
