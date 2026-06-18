"use client"

/**
 * deployments/shared — presentational helpers for the Deployments module.
 *
 * Small copies of the visual language used by components/code/workspace-tool-panels.tsx
 * (PanelCard, ActivityRow, StatusPill, ToolShell, ToolTabs) so the new module looks
 * native without reaching into that file's private (non-exported) helpers.
 */

import * as React from "react"
import { AlertTriangle, Info } from "lucide-react"

import { cn } from "@/lib/utils"
import type { DeploymentStatus } from "@/lib/deployments/deployments-api"

export function ToolShell({
  eyebrow,
  title,
  detail,
  action,
  children,
}: {
  eyebrow: string
  title: string
  detail: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border/50 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
            <h2 className="mt-1 text-[18px] font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">{detail}</p>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  )
}

export function PanelGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 lg:grid-cols-2">{children}</div>
}

export function PanelCard({
  title,
  detail,
  icon,
  action,
  children,
  className,
}: {
  title: string
  detail?: string
  icon?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-lg border border-border/60 bg-card/80 p-4 shadow-sm", className)}>
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
          {detail ? <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{detail}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  )
}

export function ActivityRow({
  label,
  value,
  children,
}: {
  label: string
  value?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 truncate text-right font-medium">
        {children ?? value}
      </span>
    </div>
  )
}

export type PillTone = "ready" | "building" | "failed" | "warn" | "running" | "idle" | "success"

export function StatusPill({ tone, label }: { tone: PillTone; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        (tone === "ready" || tone === "success") && "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
        (tone === "warn" || tone === "building" || tone === "running") &&
          "border-amber-500/25 bg-amber-500/10 text-amber-600",
        tone === "failed" && "border-rose-500/25 bg-rose-500/10 text-rose-600",
        tone === "idle" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  )
}

/** Maps a deployment status to a StatusPill tone + UI label. */
export function statusPill(status: DeploymentStatus): { tone: PillTone; label: string } {
  switch (status) {
    case "building":
      return { tone: "building", label: "Building" }
    case "running":
      return { tone: "running", label: "Running" }
    case "failed":
      return { tone: "failed", label: "Failed" }
    case "suspended":
      return { tone: "failed", label: "Suspended" }
    case "paused":
      return { tone: "idle", label: "Paused" }
    case "shut_down":
      return { tone: "idle", label: "Shut down" }
    default:
      return { tone: "idle", label: status }
  }
}

export function copyToClipboard(value: string, onCopied: () => void, onError: () => void) {
  void navigator.clipboard?.writeText(value).then(onCopied, onError)
}

/** Amber ⚠ warning banner (Replit's pending-payment / pre-publish style). */
export function WarningBanner({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1 text-[12px] leading-5 text-amber-700/90">{children}</p>
    </div>
  )
}

/** Neutral ⓘ info banner (Replit's grey suspended-explainer style). */
export function InfoBanner({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/40 px-4 py-3",
        className,
      )}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-[12px] leading-5 text-muted-foreground">{children}</p>
    </div>
  )
}

/** Small colored status dot matching the StatusPill tone for a deployment status. */
export function StatusDot({ status, className }: { status: DeploymentStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        status === "running" && "bg-emerald-500",
        status === "building" && "bg-amber-500",
        (status === "failed" || status === "suspended") && "bg-rose-500",
        (status === "paused" || status === "shut_down") && "bg-muted-foreground/50",
        className,
      )}
    />
  )
}

/**
 * timeAgo — tiny relative-time formatter for the Replit-like history rail.
 * "just now" / "2m ago" / "3h ago" / "5d ago" / "2mo ago".
 */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ""
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (diffSec < 45) return "just now"
  const min = Math.round(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.round(months / 12)
  return `${years}y ago`
}
