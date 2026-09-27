"use client"

/**
 * Detail drawer of one live log line: full message + body (stack, dump),
 * request context and — on demand — every line of the same request/turn
 * («Ver toda la petición»), so a failed turn can be read end to end.
 */

import { useCallback, useEffect, useState } from "react"
import { Copy, ExternalLink, ListTree, Loader2, MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  fetchRequestLogs,
  formatLinesAsText,
  type LiveLogLine,
  type RequestLogsSummary,
} from "@/lib/admin/live-logs-service"
import { cn } from "@/lib/utils"
import { formatLogTime, levelBadgeClass, levelLabel } from "./live-log-format"

type Props = {
  line: LiveLogLine | null
  onClose: () => void
  onFilterRequest?: (reqId: string) => void
}

async function copyText(text: string, okMessage: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(okMessage)
  } catch {
    toast.error("No se pudo copiar")
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-all font-mono">{children}</div>
    </div>
  )
}

export function LiveLogDetail({ line, onClose, onFilterRequest }: Props) {
  const [trail, setTrail] = useState<{ summary: RequestLogsSummary; lines: LiveLogLine[] } | null>(null)
  const [trailLoading, setTrailLoading] = useState(false)
  const [trailError, setTrailError] = useState<string | null>(null)

  useEffect(() => {
    setTrail(null)
    setTrailError(null)
  }, [line?.id])

  const loadTrail = useCallback(async () => {
    if (!line?.reqId) return
    setTrailLoading(true)
    setTrailError(null)
    try {
      const res = await fetchRequestLogs(line.reqId)
      setTrail({ summary: res.summary, lines: res.lines })
    } catch (err) {
      setTrailError(err instanceof Error ? err.message : "No se pudo cargar la petición")
    } finally {
      setTrailLoading(false)
    }
  }, [line?.reqId])

  const open = Boolean(line)
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" closeLabel="Cerrar" className="w-full overflow-y-auto sm:max-w-2xl" data-testid="live-log-detail">
        {line && (
          <>
            <SheetHeader className="space-y-2 pr-8 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase", levelBadgeClass(line.level))}>
                  {levelLabel(line.level)}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{formatLogTime(line.ts, true)}</span>
                {line.repeat && line.repeat > 1 ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">×{line.repeat}</span>
                ) : null}
              </div>
              <SheetTitle className="break-words font-mono text-sm leading-5">{line.msg}</SheetTitle>
              <SheetDescription className="sr-only">Detalle completo de la línea de registro</SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-4">
              {line.body && line.body !== line.msg && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Detalle</div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-[11px] leading-4">
                    {line.body}
                  </pre>
                </div>
              )}

              <div className="space-y-1.5 rounded-md border border-border/70 p-3">
                <Field label="Fuente">{line.source}{line.tag && line.tag !== line.source ? ` · ${line.tag}` : ""}</Field>
                {line.route && <Field label="Ruta">{line.route}</Field>}
                {(line.email || line.userId) && <Field label="Usuario">{line.email || line.userId}{line.email && line.userId ? ` (${line.userId})` : ""}</Field>}
                {line.chatId && <Field label="Chat">{line.chatId}</Field>}
                {line.reqId && <Field label="Petición">{line.reqId}</Field>}
                {line.queue && <Field label="Cola">{line.queue}{line.jobId ? ` · job ${line.jobId}` : ""}</Field>}
                {typeof line.status === "number" && <Field label="HTTP">{line.status}</Field>}
                {line.commit && <Field label="Versión">{line.commit}</Field>}
                {line.via && <Field label="Origen">{line.via}</Field>}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => copyText(JSON.stringify(line, null, 2), "Línea copiada")}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar
                </Button>
                {line.reqId && (
                  <Button size="sm" variant="outline" onClick={loadTrail} disabled={trailLoading} data-testid="live-log-request-trail">
                    {trailLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ListTree className="mr-1.5 h-3.5 w-3.5" />}
                    Ver toda la petición
                  </Button>
                )}
                {line.reqId && onFilterRequest && (
                  <Button size="sm" variant="ghost" onClick={() => { onFilterRequest(line.reqId as string); onClose() }}>
                    Filtrar en vivo por esta petición
                  </Button>
                )}
                {line.chatId && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={`/agentes?id=${encodeURIComponent(line.chatId)}`} target="_blank" rel="noopener noreferrer">
                      <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Ver el chat <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  </Button>
                )}
              </div>

              {trailError && <p className="text-xs text-red-600">{trailError}</p>}
              {trail && (
                <div className="space-y-2" data-testid="live-log-trail">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-medium">
                      Petición completa · {trail.summary.count} líneas
                      {trail.summary.durationMs != null ? ` · ${(trail.summary.durationMs / 1000).toFixed(1)} s` : ""}
                      {trail.summary.errors ? ` · ${trail.summary.errors} error${trail.summary.errors === 1 ? "" : "es"}` : ""}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => copyText(formatLinesAsText(trail.lines), "Petición copiada")}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar petición
                    </Button>
                  </div>
                  {trail.summary.routes.length > 0 && (
                    <div className="text-[11px] text-muted-foreground">{trail.summary.routes.join(" · ")}{trail.summary.users.length ? ` · ${trail.summary.users.join(", ")}` : ""}</div>
                  )}
                  <ol className="max-h-[50vh] space-y-px overflow-auto rounded-md border border-border/70 font-mono text-[11px]">
                    {trail.lines.map((l) => {
                      const offset = trail.summary.firstTs != null ? (l.ts - trail.summary.firstTs) / 1000 : 0
                      return (
                        <li
                          key={l.id}
                          className={cn(
                            "grid grid-cols-[64px_52px_1fr] gap-2 px-2 py-1",
                            l.level === "error" || l.level === "fatal" ? "bg-red-50/80 text-red-900 dark:bg-red-950/40 dark:text-red-200" : l.level === "warn" ? "bg-amber-50/70 dark:bg-amber-950/30" : "",
                          )}
                        >
                          <span className="tabular-nums text-muted-foreground">+{offset.toFixed(3)}s</span>
                          <span className="uppercase">{l.level}</span>
                          <span className="whitespace-pre-wrap break-words">{l.msg}{l.repeat && l.repeat > 1 ? ` (×${l.repeat})` : ""}</span>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
