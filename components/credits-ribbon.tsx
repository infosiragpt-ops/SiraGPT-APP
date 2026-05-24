"use client"

import { useEffect, useState } from "react"
import { AlertCircle, ArrowRight, Sparkles, Zap } from "lucide-react"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { apiClient } from "@/lib/api"
import { cn } from "@/lib/utils"

interface TokenPool {
  used: string
  limit: string | null
  remaining: string | null
  unlimited: boolean
  exhausted: boolean
  usedPercent: number | null
}

interface CallsBlock {
  dailyLimit: number | null
  remaining: number | null
  exhausted: boolean
}

interface CreditsBalance {
  computedAt: string
  plan: string
  defaultModel: { name: string; provider: string; displayName: string } | null
  fallbackModel: { name: string; provider: string; displayName: string } | null
  calls: CallsBlock
  premiumTokens: TokenPool
  gemaTokens: TokenPool
  notices: Array<{ code: string; level: "info" | "warning" | "error"; message: string }>
}

function formatTokens(value: string | null | undefined): string {
  if (value == null) return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} K`
  return n.toLocaleString()
}

function planLabel(plan: string): string {
  switch (String(plan || "").toUpperCase()) {
    case "FREE":
      return "Plan gratuito"
    case "PRO":
      return "Pro"
    case "PRO_MAX":
      return "Pro Max"
    case "ENTERPRISE":
      return "Enterprise"
    default:
      return plan || "—"
  }
}

interface Props {
  /**
   * Si se pasa, oculta el botón de "Comprar más" (útil cuando la cinta
   * ya vive dentro de la página de billing y el botón sería redundante).
   */
  hideBuyButton?: boolean
  className?: string
}

/**
 * Cinta de consumo (spec del prompt maestro): visualiza el plan activo,
 * llamadas diarias restantes (Free), tokens premium consumidos y tokens
 * de fallback Gema4. Si algún pool está agotado muestra una alerta
 * accionable. No expone márgenes ni costos internos.
 */
export function CreditsRibbon({ hideBuyButton, className }: Props) {
  const [data, setData] = useState<CreditsBalance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiClient
      .getCreditsBalance()
      .then((payload) => {
        if (!cancelled) setData(payload as CreditsBalance)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err?.message || "No se pudo cargar el consumo")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading && !data) {
    return (
      <Card className={cn("p-4", className)}>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Sparkles className="h-4 w-4 animate-pulse" />
          Cargando consumo…
        </div>
      </Card>
    )
  }

  if (error || !data) {
    return (
      <Card className={cn("p-4 border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/20", className)}>
        <div className="flex items-start gap-3 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
          <div>
            <p className="font-medium">No se pudo cargar tu consumo.</p>
            <p className="text-xs text-muted-foreground">{error || "Reintenta más tarde."}</p>
          </div>
        </div>
      </Card>
    )
  }

  const criticalNotice = data.notices.find((n) => n.level === "error")
  const warningNotice = data.notices.find((n) => n.level === "warning")
  const tone = criticalNotice ? "destructive" : warningNotice ? "amber" : "neutral"

  return (
    <Card
      className={cn(
        "p-4 border",
        tone === "destructive" && "border-red-500/40 bg-red-50/30 dark:bg-red-950/20",
        tone === "amber" && "border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/20",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Zap className="h-5 w-5 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{planLabel(data.plan)}</span>
              {data.defaultModel && (
                <Badge variant="outline" className="text-[10px]">
                  Modelo predeterminado: {data.defaultModel.displayName}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Cinta de consumo · actualizada {new Date(data.computedAt).toLocaleTimeString()}
            </p>
          </div>
        </div>
        {!hideBuyButton && (
          <Button size="sm" asChild>
            <Link href="/plan">
              Comprar más créditos
              <ArrowRight className="ml-2 h-3 w-3" />
            </Link>
          </Button>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {/* Llamadas diarias — solo Free */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">Llamadas hoy</span>
            <span className={cn(
              "font-medium",
              data.calls.exhausted && "text-red-600",
            )}>
              {data.calls.dailyLimit == null
                ? "Sin límite diario"
                : `${data.calls.remaining ?? 0} / ${data.calls.dailyLimit}`}
            </span>
          </div>
          {data.calls.dailyLimit != null && (
            <Progress
              value={
                data.calls.dailyLimit > 0
                  ? Math.max(
                      0,
                      Math.min(
                        100,
                        Math.round(
                          (((data.calls.dailyLimit ?? 0) - (data.calls.remaining ?? 0)) /
                            (data.calls.dailyLimit ?? 1)) *
                            100,
                        ),
                      ),
                    )
                  : 0
              }
              className="h-2"
            />
          )}
        </div>

        {/* Tokens premium */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">Tokens premium</span>
            <span className={cn(
              "font-medium",
              data.premiumTokens.exhausted && "text-red-600",
            )}>
              {data.premiumTokens.unlimited
                ? "Sin límite"
                : `${formatTokens(data.premiumTokens.used)} / ${formatTokens(data.premiumTokens.limit)}`}
            </span>
          </div>
          {!data.premiumTokens.unlimited && (
            <Progress value={data.premiumTokens.usedPercent ?? 0} className="h-2" />
          )}
        </div>

        {/* Tokens Gema4 */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">
              Tokens {data.fallbackModel?.displayName || "Gema4"}
            </span>
            <span className={cn(
              "font-medium",
              data.gemaTokens.exhausted && "text-red-600",
            )}>
              {data.gemaTokens.unlimited
                ? "Sin límite"
                : `${formatTokens(data.gemaTokens.used)} / ${formatTokens(data.gemaTokens.limit)}`}
            </span>
          </div>
          {!data.gemaTokens.unlimited && (
            <Progress value={data.gemaTokens.usedPercent ?? 0} className="h-2" />
          )}
        </div>
      </div>

      {(criticalNotice || warningNotice) && (
        <div
          className={cn(
            "mt-4 flex items-start gap-2 rounded-md p-2 text-xs",
            criticalNotice ? "bg-red-100/60 text-red-800 dark:bg-red-950/40 dark:text-red-200"
                           : "bg-amber-100/60 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
          )}
        >
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{(criticalNotice || warningNotice)!.message}</span>
        </div>
      )}
    </Card>
  )
}

export default CreditsRibbon
