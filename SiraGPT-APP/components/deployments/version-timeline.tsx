"use client"

/**
 * VersionTimeline — history of published versions (Replit "Overview" lower half).
 * Each row: 8-char short hash (monospace), "publicado hace X", live dot,
 * rollback pill, and a Rollback action on non-live promoted versions.
 */

import * as React from "react"
import { RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DeploymentVersion } from "@/lib/deployments/deployments-api"

import { timeAgo } from "./shared"

export function VersionTimeline({
  versions,
  rollingBackId,
  onRollback,
}: {
  versions: DeploymentVersion[]
  rollingBackId: string | null
  onRollback: (versionId: string) => void
}) {
  if (versions.length === 0) {
    return (
      <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">
        No published versions yet.
      </p>
    )
  }

  return (
    <ol className="space-y-2">
      {versions.map((version) => {
        const canRollback = !version.isLive && version.status === "promoted"
        return (
          <li
            key={version.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  version.isLive ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] text-foreground">
                    {version.shortHash.slice(0, 8)}
                  </span>
                  {version.isLive ? (
                    <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                      Live
                    </span>
                  ) : null}
                  {version.isRollback ? (
                    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Rollback
                    </span>
                  ) : null}
                  {version.status === "failed" ? (
                    <span className="inline-flex items-center rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-600">
                      Failed
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">published {timeAgo(version.createdAt)}</p>
              </div>
            </div>
            {canRollback ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1.5"
                disabled={rollingBackId === version.id}
                onClick={() => onRollback(version.id)}
              >
                <RotateCcw className={cn("h-3.5 w-3.5", rollingBackId === version.id && "animate-spin")} />
                Rollback
              </Button>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
