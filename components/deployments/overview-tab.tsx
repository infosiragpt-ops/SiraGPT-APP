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
  RotateCcw,
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

import { InfoBanner, StatusDot, copyToClipboard, timeAgo } from "./shared"
import type { DetailTab } from "./deployment-detail"
import { PublishPipeline } from "./publish-pipeline"

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
  const rollbackTarget =
    liveVersion != null
      ? versions.find((v) => v.id !== liveVersion.id && (v.status === "promoted" || v.status === "rolled_back"))
      : null
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

      <div className="relative">
        <span aria-hidden className="absolute -left-[17px] top-0 bottom-0 border-l border-dashed border-border" />
        <StatusDot status={deployment.status} className="absolute -left-[20px] top-5 h-2 w-2" />

        <section
          className="min-h-[336px] rounded-md px-4 py-4 text-[13px] text-foreground"
          style={{ backgroundColor: "#e2dfd6" }}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[15px] font-semibold">Production</h3>
            {!isSuspended ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 rounded-md border-border bg-background px-2.5 text-[12px] shadow-none hover:bg-muted"
                onClick={() => void publish()}
                disabled={publishing}
              >
                <Rocket className="h-3.5 w-3.5" />
                {hasPublished ? "Republish" : "Publish"}
              </Button>
            ) : null}
          </div>

          {isSuspended ? <InfoBanner className="mb-2.5 bg-[#f3f1ec]">{SUSPENDED_INFO}</InfoBanner> : null}

          <dl className="space-y-0">
            <FieldRow label="Status" trailing={<List className="h-3.5 w-3.5 text-muted-foreground" />}>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={deployment.status} />
                <span className="font-semibold">
                  {liveVersion ? liveVersion.shortHash.slice(0, 8) : "—"} {deployment.status}
                </span>
              </span>
            </FieldRow>

            <FieldRow label="Visibility">
              <span className="inline-flex items-center gap-1.5">
                <VisibilityIcon visibility={deployment.visibility} />
                {VISIBILITY_LABEL[deployment.visibility]}
              </span>
            </FieldRow>

            <FieldRow label="Domain">
              <div className="flex flex-col items-start gap-1.5">
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
                  className="mt-0.5 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <ShoppingCart className="h-3 w-3" />
                  Buy a new domain
                  <span className="rounded bg-[#d7e8ff] px-1.5 py-0 text-[10px] font-medium text-[#1368c4]">Beta</span>
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
                  <span className="text-muted-foreground">(${deployment.monthlyUsd.toFixed(2)}/mo)</span>
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
        </section>

        {liveVersion ? (
          <div className="relative mt-4 flex items-center gap-2 text-[13px] text-muted-foreground">
            <StatusDot status="running" className="absolute -left-[20px] top-2 h-1.5 w-1.5" />
            <span className="font-mono text-[12px] text-muted-foreground">{liveVersion.shortHash.slice(0, 8)}</span>
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#1c8bdc] text-[10px] font-semibold text-white">
              {deployment.name.slice(0, 1).toLowerCase() || "s"}
            </span>
            <span className="text-foreground">{deployment.name}</span>
            <span>published {timeAgo(liveVersion.createdAt)}</span>
            {rollbackTarget ? (
              <button
                type="button"
                onClick={() => void rollback(rollbackTarget.id)}
                disabled={rollingBackId === rollbackTarget.id}
                className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <RotateCcw className={cn("h-3.5 w-3.5", rollingBackId === rollbackTarget.id && "animate-spin")} />
                Roll back
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FieldRow({
  label,
  trailing,
  children,
}: {
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className="grid items-start gap-3 px-0 py-[5px] text-[13px]"
      style={{ gridTemplateColumns: "100px minmax(0, 1fr)" }}
    >
      <dt className="inline-flex items-center gap-1.5 pt-0.5 text-muted-foreground">{label}</dt>
      <span className="flex min-w-0 items-center justify-start gap-1.5 overflow-hidden text-left font-medium">
        {children}
        {trailing}
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
    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
      <span className="min-w-0 max-w-[min(72vw,520px)] truncate text-[13px]">{hostname}</span>
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
      className="text-[12px] font-medium text-[#0b72e7] transition-opacity hover:opacity-80"
    >
      Manage
    </button>
  )
}
