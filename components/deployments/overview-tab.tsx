"use client"

import * as React from "react"
import {
  Check,
  Copy,
  Database,
  Globe2,
  List,
  Lock,
  MapPin,
  QrCode,
  Rocket,
  ShoppingCart,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  deploymentsApi,
  type Deployment,
  type DeploymentDomain,
  type DeploymentVersion,
  type PublishPhase,
} from "@/lib/deployments/deployments-api"

import { InfoBanner, PanelCard, StatusDot, copyToClipboard } from "./shared"
import type { DetailTab } from "./deployment-detail"
import { PublishPipeline } from "./publish-pipeline"
import { VersionTimeline } from "./version-timeline"

const VISIBILITY_LABEL: Record<Deployment["visibility"], string> = {
  public: "Public",
  workspace: "Workspace",
  private: "Private",
  password: "Password protected",
}

const SUSPENDED_INFO =
  "Your deployment was suspended due to a billing failure. Navigate to Account > Billing to resolve. If no action is taken your deployment will be deleted 30 days after the date it was suspended. For more assistance reach out to support at support@replit.com."

function VisibilityIcon({ visibility }: { visibility: Deployment["visibility"] }) {
  if (visibility === "workspace") return <Users className="h-3.5 w-3.5 text-muted-foreground" />
  if (visibility === "private" || visibility === "password")
    return <Lock className="h-3.5 w-3.5 text-muted-foreground" />
  return <Globe2 className="h-3.5 w-3.5 text-muted-foreground" />
}

export function OverviewTab({
  deployment,
  versions,
  domains,
  onRefetch,
  onNavigate,
}: {
  deployment: Deployment
  versions: DeploymentVersion[]
  domains: DeploymentDomain[]
  onRefetch: () => void
  onNavigate: (tab: DetailTab) => void
}) {
  const [publishing, setPublishing] = React.useState(false)
  const [phases, setPhases] = React.useState<PublishPhase[] | null>(null)
  const [rollingBackId, setRollingBackId] = React.useState<string | null>(null)
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)

  const customDomains = domains.filter((d) => d.kind !== "default")
  const hasPublished = versions.some((v) => v.status === "promoted")
  const liveVersion = versions.find((v) => v.isLive) ?? versions.find((v) => v.status === "promoted") ?? null
  const isSuspended = deployment.status === "suspended"

  const publish = async () => {
    setPublishing(true)
    setPhases(null)
    try {
      const result = await deploymentsApi.publish(deployment.id)
      setPhases(result.phases)
    } catch (error) {
      setPublishing(false)
      toast.error(error instanceof Error ? error.message : "Could not publish.")
    }
  }

  const onPipelineDone = () => {
    setPublishing(false)
    setPhases(null)
    const failed = (phases ?? []).some((p) => p.status === "failed")
    toast[failed ? "error" : "success"](failed ? "Publish failed." : "Deployment published.")
    onRefetch()
  }

  const rollback = async (versionId: string) => {
    setRollingBackId(versionId)
    try {
      await deploymentsApi.rollback(deployment.id, versionId)
      toast.success("Rollback applied.")
      onRefetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not roll back.")
    } finally {
      setRollingBackId(null)
    }
  }

  const copyValue = (key: string, value: string) => {
    copyToClipboard(
      value,
      () => {
        setCopiedKey(key)
        window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500)
      },
      () => toast.error("Could not copy."),
    )
  }

  return (
    <div className="space-y-3">
      {publishing && phases ? <PublishPipeline phases={phases} onDone={onPipelineDone} /> : null}

      <PanelCard
        title="Production"
        detail={deployment.name}
        icon={<Globe2 className="h-4 w-4" />}
        action={
          <Button size="sm" className="h-8 gap-1.5" onClick={() => void publish()} disabled={publishing}>
            <Rocket className="h-3.5 w-3.5" />
            {hasPublished ? "Republish" : "Publish"}
          </Button>
        }
      >
        {/* Vertical timeline rail: dashed line down the left + a status dot at the top. */}
        <div className="relative pl-5">
          <span
            aria-hidden
            className="absolute left-[3px] top-1.5 bottom-1 border-l border-dashed border-border/70"
          />
          <span className="absolute left-0 top-1">
            <StatusDot status={deployment.status} className="h-2 w-2" />
          </span>

          {isSuspended ? <InfoBanner className="mb-3">{SUSPENDED_INFO}</InfoBanner> : null}

          <dl className="space-y-1">
            <FieldRow label="Status" icon={<List className="h-3.5 w-3.5 text-muted-foreground" />}>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={deployment.status} />
                <span className="font-mono text-[11px]">
                  {liveVersion ? liveVersion.shortHash.slice(0, 8) : "—"}
                </span>
                <span className="text-muted-foreground">· {deployment.status}</span>
              </span>
            </FieldRow>

            <FieldRow label="Visibility">
              <span className="inline-flex items-center gap-1.5">
                <VisibilityIcon visibility={deployment.visibility} />
                {VISIBILITY_LABEL[deployment.visibility]}
              </span>
            </FieldRow>

            <FieldRow label="Domain">
              <div className="flex flex-col items-end gap-1.5">
                <DomainLine
                  hostname={deployment.defaultDomain}
                  copyKey="default"
                  copiedKey={copiedKey}
                  onCopy={copyValue}
                />
                {customDomains.map((domain) => (
                  <DomainLine
                    key={domain.id}
                    hostname={domain.hostname}
                    copyKey={domain.id}
                    copiedKey={copiedKey}
                    onCopy={copyValue}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => onNavigate("domains")}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
                >
                  <ShoppingCart className="h-3 w-3" />
                  Buy a new domain
                  <span className="rounded-full border border-border bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground">
                    Beta
                  </span>
                </button>
              </div>
            </FieldRow>

            <FieldRow label="Geography">
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                {deployment.geographyLabel}
              </span>
            </FieldRow>

            <FieldRow label="Type">
              <span className="inline-flex items-center gap-1.5">
                {deployment.machineLabel}
                {typeof deployment.monthlyUsd === "number" ? (
                  <span className="text-muted-foreground">· ${deployment.monthlyUsd.toFixed(2)}/month</span>
                ) : null}
                <ManageLink onClick={() => onNavigate("manage")} />
              </span>
            </FieldRow>

            <FieldRow label="Database">
              <span className="inline-flex items-center gap-1.5">
                <Database
                  className={cn(
                    "h-3.5 w-3.5",
                    deployment.databaseConnected ? "text-emerald-600" : "text-muted-foreground",
                  )}
                />
                {deployment.databaseConnected ? "Production database connected" : "Not connected"}
                <ManageLink onClick={() => onNavigate("manage")} />
              </span>
            </FieldRow>
          </dl>
        </div>
      </PanelCard>

      <PanelCard title="History" detail="Recent deploys from this workspace">
        <VersionTimeline versions={versions} rollingBackId={rollingBackId} onRollback={(id) => void rollback(id)} />
      </PanelCard>
    </div>
  )
}

function FieldRow({
  label,
  icon,
  children,
}: {
  label: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md px-2 py-2 text-[12px] hover:bg-muted/30">
      <span className="inline-flex items-center gap-1.5 pt-0.5 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-right font-medium">
        {children}
        {icon}
      </span>
    </div>
  )
}

function DomainLine({
  hostname,
  copyKey,
  copiedKey,
  onCopy,
}: {
  hostname: string
  copyKey: string
  copiedKey: string | null
  onCopy: (key: string, value: string) => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="truncate font-mono text-[11px]">{hostname}</span>
      <button
        type="button"
        onClick={() => onCopy(copyKey, hostname)}
        className="text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Copy domain"
      >
        {copiedKey === copyKey ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        className="text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Código QR"
        title="QR"
      >
        <QrCode className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

function ManageLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
    >
      Manage
    </button>
  )
}
