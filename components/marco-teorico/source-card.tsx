"use client"

/**
 * SourceCard — single source row with title, authors, year, and a
 * validation badge (✓ verified / ! unverified / — no DOI). Click
 * opens the DOI (or landing page) in a new tab. Deliberately lean:
 * the detailed source list is secondary to the generated markdown.
 */

import * as React from "react"
import { ExternalLink, Check, AlertTriangle } from "lucide-react"
import type { MarcoSource } from "@/lib/marco-teorico-service"
import { cn } from "@/lib/utils"

type Validation = "valid" | "invalid" | "nodoi" | "pending"

interface Props {
  source: MarcoSource
  validation?: Validation
}

const BADGE: Record<Validation, { label: string; Icon: any; tone: string }> = {
  valid:   { label: "DOI verificado",  Icon: Check,           tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  invalid: { label: "DOI no verificado", Icon: AlertTriangle, tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  nodoi:   { label: "Sin DOI",          Icon: AlertTriangle, tone: "bg-muted text-muted-foreground" },
  pending: { label: "Verificando…",     Icon: AlertTriangle, tone: "bg-muted text-muted-foreground" },
}

export function SourceCard({ source, validation = "pending" }: Props) {
  const badge = BADGE[validation]
  const href = source.doi
    ? `https://doi.org/${source.doi}`
    : (source.openAccessUrl || source.landingUrl || null)

  const authorsLine = (source.authors || []).slice(0, 3).join(", ") +
    (source.authors && source.authors.length > 3 ? " et al." : "")

  return (
    <a
      href={href || "#"}
      target={href ? "_blank" : undefined}
      rel={href ? "noreferrer" : undefined}
      className={cn(
        "block rounded-lg border border-border/60 px-3 py-2.5 transition-colors",
        href ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
      )}
      onClick={(e) => { if (!href) e.preventDefault() }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium line-clamp-2">{source.title}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {authorsLine}{source.year ? ` (${source.year})` : ""}{source.venue ? ` · ${source.venue}` : ""}
          </div>
        </div>
        {href && <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn("inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md", badge.tone)}>
          <badge.Icon className="h-2.5 w-2.5" />
          {badge.label}
        </span>
        {typeof source.citedByCount === "number" && source.citedByCount > 0 && (
          <span className="text-[10px] text-muted-foreground">· {source.citedByCount} citas</span>
        )}
      </div>
    </a>
  )
}
