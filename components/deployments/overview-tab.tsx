"use client"

import * as React from "react"
import {
  Check,
  Copy,
  Database,
  Globe2,
  List,
  Loader2,
  Lock,
  QrCode,
  Rocket,
  RotateCcw,
  Settings,
  ShoppingCart,
  X,
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
  if (visibility === "workspace") return <Users className="h-4 w-4 text-[#cfcfcf]" />
  if (visibility === "private" || visibility === "password") return <Lock className="h-4 w-4 text-[#cfcfcf]" />
  return <Globe2 className="h-4 w-4 text-[#cfcfcf]" />
}

function displayUrl(hostname: string): string {
  return /^https?:\/\//i.test(hostname) ? hostname : `https://${hostname}`
}

export function OverviewTab({
  deployment,
  versions,
  domains,
  onRefetch,
  onNavigate,
  autoPublishSignal = 0,
  onAutoPublishConsumed,
}: {
  deployment: Deployment
  versions: DeploymentVersion[]
  domains: DeploymentDomain[]
  onRefetch: () => void
  onNavigate: (tab: DetailTab) => void
  autoPublishSignal?: number
  onAutoPublishConsumed?: () => void
}) {
  const [publishing, setPublishing] = React.useState(false)
  const [phases, setPhases] = React.useState<PublishPhase[] | null>(null)
  const [failureMessage, setFailureMessage] = React.useState<string | null>(null)
  const [rollingBackId, setRollingBackId] = React.useState<string | null>(null)
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)
  const [showReferral, setShowReferral] = React.useState(true)
  const [resuming, setResuming] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)

  const customDomains = domains.filter((d) => d.kind !== "default")
  const publishedVersions = versions.filter((v) => v.status === "promoted" || v.status === "rolled_back" || v.isLive)
  const hasPublished = versions.some((v) => v.status === "promoted")
  const liveVersion = versions.find((v) => v.isLive) ?? versions.find((v) => v.status === "promoted") ?? null
  const rollbackTarget =
    liveVersion != null
      ? versions.find((v) => v.id !== liveVersion.id && (v.status === "promoted" || v.status === "rolled_back"))
      : null
  const isSuspended = deployment.status === "suspended"
  const isPausedOrSuspended = deployment.status === "paused" || deployment.status === "suspended"
  const publisher = liveVersion?.publishedById || deployment.name || "kk"

  const publish = React.useCallback(async () => {
    setPublishing(true)
    setPhases(null)
    setFailureMessage(null)
    try {
      const result = await deploymentsApi.publish(deployment.id)
      setPhases(result.phases)
      setFailureMessage(result.failureMessage ?? null)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not publish."
      setFailureMessage(message)
      setPhases([{ name: "provision", status: "failed", logs: [message] }])
      toast.error(message)
    }
  }, [deployment.id])

  React.useEffect(() => {
    if (!autoPublishSignal || publishing) return
    onAutoPublishConsumed?.()
    void publish()
  }, [autoPublishSignal, onAutoPublishConsumed, publish, publishing])

  const onPipelineDone = () => {
    setPublishing(false)
    setPhases(null)
    setFailureMessage(null)
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
        toast.success(scan.summary || `Security scan passed - ${scan.findings.length} finding(s).`)
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
    <div className="min-h-full bg-[#1f1f1f] pb-8 text-[#f4f4f4]">
      {publishing ? (
        <div className="px-4 pt-3">
          <PublishPipeline
            phases={phases ?? []}
            resolved={phases !== null}
            deployment={deployment}
            failureMessage={failureMessage}
            onDone={onPipelineDone}
            onViewLogs={() => onNavigate("logs")}
          />
        </div>
      ) : null}

      <div className="relative px-4 pt-3">
        <span aria-hidden className="absolute bottom-0 left-[4px] top-3 border-l border-dashed border-[#3a3a3a]" />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {isPausedOrSuspended ? (
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[6px] border-0 bg-[#0f6ecb] px-3 text-[13px] font-medium text-white shadow-none hover:bg-[#1679dc] disabled:bg-[#303030] disabled:text-[#7b7b7b]"
              onClick={() => void resume()}
              disabled={resuming}
            >
              {resuming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[6px] border-0 bg-[#0f6ecb] px-3 text-[13px] font-medium text-white shadow-none hover:bg-[#1679dc] disabled:bg-[#303030] disabled:text-[#7b7b7b]"
              onClick={() => void publish()}
              disabled={publishing}
            >
              {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              {hasPublished ? "Republish" : "Publish"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 rounded-[6px] border-0 bg-[#292929] px-3 text-[13px] font-medium text-[#a7a7a7] shadow-none hover:bg-[#313131] hover:text-white"
            onClick={() => onNavigate("manage")}
          >
            <Settings className="h-3.5 w-3.5" />
            Adjust settings
          </Button>
        </div>

        <StatusDot status={deployment.status} className="absolute left-[1px] top-[112px] h-2 w-2 bg-[#2d9cff]" />

        <section className="rounded-[6px] bg-[#242424] px-4 pb-4 pt-4 text-[14px] text-white">
          <h3 className="mb-3 text-[16px] font-semibold leading-none text-white">Production</h3>

          {isSuspended ? <InfoBanner className="mb-3 border-[#3f3f3f] bg-[#2b2b2b] text-[#d6d6d6]">{SUSPENDED_INFO}</InfoBanner> : null}

          <dl className="space-y-[12px]">
            <FieldRow label="Status" trailing={<List className="h-4 w-4 text-[#a7a7a7]" />}>
              <span className="inline-flex items-center gap-2">
                <StatusDot status={deployment.status} className="h-2 w-2" />
                <strong className="font-semibold text-white">{publisher}</strong>
                <span className="text-white">
                  published {liveVersion ? timeAgo(liveVersion.createdAt) : "just now"}
                </span>
              </span>
            </FieldRow>

            <FieldRow label="Visibility">
              <span className="inline-flex items-center gap-1.5 text-white">
                <VisibilityIcon visibility={deployment.visibility} />
                {VISIBILITY_LABEL[deployment.visibility]}
              </span>
            </FieldRow>

            <FieldRow label="SEO Rating">
              <span className="inline-flex items-center gap-2">
                <span className="rounded-full bg-[#2f7d4a] px-[10px] py-[5px] text-[11px] font-semibold leading-none text-white">
                  HEALTHY
                </span>
                <button
                  type="button"
                  onClick={() => void runSecurityScan()}
                  disabled={scanning}
                  className="h-7 rounded-[6px] border border-[#555] bg-[#242424] px-3 text-[12px] font-medium text-white hover:bg-[#2f2f2f]"
                >
                  {scanning ? "Reviewing..." : "Review SEO with Agent"}
                </button>
              </span>
            </FieldRow>

            <FieldRow label="Domain">
              <div className="flex flex-col items-start gap-2">
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
                  className="mt-0.5 inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-[#474747] bg-[#292929] px-2 text-[12px] font-medium text-white transition-colors hover:bg-[#333]"
                >
                  <ShoppingCart className="h-3.5 w-3.5" />
                  Buy a new domain
                  <span className="rounded-[4px] bg-[#17385d] px-1.5 py-0.5 text-[10px] font-semibold text-[#4aa3ff]">Beta</span>
                </button>
              </div>
            </FieldRow>

            <FieldRow label="Geography">{deployment.geographyLabel}</FieldRow>

            <FieldRow label="Type">
              <span className="inline-flex flex-wrap items-center gap-1.5 text-white">
                {deployment.machineLabel}
                {typeof deployment.monthlyUsd === "number" ? (
                  <span className="text-[#c7c7c7]">(${deployment.monthlyUsd.toFixed(2)}/mo)</span>
                ) : null}
                <ManageLink onClick={() => onNavigate("manage")} />
              </span>
            </FieldRow>

            <FieldRow label="Database">
              <span className="inline-flex flex-wrap items-center gap-1.5 text-white">
                <Database className={cn("h-4 w-4", deployment.databaseConnected ? "text-[#39b66a]" : "text-[#a7a7a7]")} />
                {deployment.databaseConnected ? "Production database connected" : "Not connected"}
                <ManageLink onClick={() => onNavigate("manage")} />
              </span>
            </FieldRow>
          </dl>
        </section>

        {showReferral ? (
          <section className="relative mt-3 rounded-[6px] bg-[#242424] px-4 pb-4 pt-4 text-white">
            <button
              type="button"
              aria-label="Dismiss referral"
              className="absolute right-4 top-4 rounded-sm p-1 text-[#c9c9c9] hover:bg-[#303030] hover:text-white"
              onClick={() => setShowReferral(false)}
            >
              <X className="h-4 w-4" />
            </button>
            <h3 className="pr-8 text-[16px] font-semibold leading-none">Earn $20 for every friend who joins Replit Core</h3>
            <p className="mt-5 text-[14px] leading-none text-white">
              Share your link. When a friend signs up and upgrades to Replit Core, you'll both get $20 in credits.
            </p>
            <div className="mt-4 flex gap-2">
              <input
                readOnly
                value={`replit.com/refer/${deployment.name || "siragpt"}`}
                className="h-8 min-w-0 flex-1 rounded-[6px] border border-[#4a4a4a] bg-[#2a2a2a] px-3 text-[14px] text-white outline-none"
              />
              <Button
                size="sm"
                className="h-8 gap-1.5 rounded-[6px] bg-[#0f7bea] px-3 text-[13px] text-white hover:bg-[#1688ff]"
                onClick={() => copyValue("referral", `https://replit.com/refer/${deployment.name || "siragpt"}`)}
              >
                {copiedKey === "referral" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copy link
              </Button>
            </div>
          </section>
        ) : null}

        <ol className="mt-4 space-y-[14px] pb-6">
          {(publishedVersions.length ? publishedVersions : versions).slice(0, 12).map((version) => {
            const canRollback = !version.isLive && version.status === "promoted"
            return (
              <li key={version.id} className="relative flex min-w-0 items-center gap-3 pl-2 text-[14px] text-[#d7d7d7]">
                <span
                  aria-hidden
                  className={cn(
                    "absolute -left-[20px] top-2 h-1.5 w-1.5 rounded-full",
                    version.isLive ? "bg-[#2d9cff]" : "bg-[#247a3c]",
                  )}
                />
                <span className="w-[76px] shrink-0 font-mono text-[13px] text-[#d7d7d7]">{version.shortHash.slice(0, 8)}</span>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#1688dc] text-[10px] font-semibold text-white">
                  v
                </span>
                <span className="min-w-0 truncate">
                  {publisher} published {timeAgo(version.createdAt)}
                </span>
                {version.isRollback ? <span className="text-[12px] text-[#9a9a9a]">Rollback</span> : null}
                {canRollback && rollbackTarget ? (
                  <button
                    type="button"
                    onClick={() => void rollback(version.id)}
                    disabled={rollingBackId === version.id}
                    className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[#a7a7a7] transition-colors hover:bg-[#2d2d2d] hover:text-white disabled:opacity-50"
                  >
                    <RotateCcw className={cn("h-3.5 w-3.5", rollingBackId === version.id && "animate-spin")} />
                    Roll back
                  </button>
                ) : null}
              </li>
            )
          })}
        </ol>
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
    <div className="grid grid-cols-[100px_minmax(0,1fr)] items-start gap-0 text-[14px] leading-none">
      <dt className="pt-0.5 text-white">{label}</dt>
      <dd className="flex min-w-0 items-center justify-start gap-2 overflow-hidden text-left text-white">
        {children}
        {trailing}
      </dd>
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
  const url = displayUrl(hostname)
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 max-w-[min(72vw,520px)] truncate text-[14px] font-semibold text-white hover:underline"
      >
        {url}
      </a>
      <button
        type="button"
        onClick={() => onCopy(copyKey, url)}
        className="text-[#c9c9c9] transition-colors hover:text-white"
        aria-label="Copy domain"
      >
        {copiedKey === copyKey ? <Check className="h-4 w-4 text-[#8ce99a]" /> : <Copy className="h-4 w-4" />}
      </button>
      <button type="button" className="text-[#c9c9c9] transition-colors hover:text-white" aria-label="QR" title="QR">
        <QrCode className="h-4 w-4" />
      </button>
    </span>
  )
}

function ManageLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-[13px] font-medium text-[#1f8fff] transition-opacity hover:opacity-80">
      Manage
    </button>
  )
}
