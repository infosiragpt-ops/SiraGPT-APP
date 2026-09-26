"use client"

import { Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { AdminTurnFailureItem } from "@/lib/admin/turn-failures-types"
import { cn } from "@/lib/utils"
import {
  CATEGORY_HINTS,
  categoryLabel,
  formatDateTime,
  formatDuration,
  severityBadgeClass,
  severityLabel,
} from "./turn-failure-labels"

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("break-words text-sm text-foreground", mono && "font-mono text-xs")}>{children || "—"}</div>
    </div>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

export function turnFailureToJson(item: AdminTurnFailureItem): string {
  try {
    return JSON.stringify(item, null, 2)
  } catch {
    return String(item.id)
  }
}

export function TurnFailureDetailDialog({
  item,
  onOpenChange,
}: {
  item: AdminTurnFailureItem | null
  onOpenChange: (open: boolean) => void
}) {
  const m = item?.metadata || {}
  const copy = async () => {
    if (!item) return
    try {
      await navigator.clipboard.writeText(turnFailureToJson(item))
      toast.success("Fallo copiado (JSON) al portapapeles")
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }
  const category = item?.category || null
  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" data-testid="turn-failure-detail">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", severityBadgeClass(item?.severity))}>
              {categoryLabel(category, item?.categoryLabel)}
            </span>
            <span className="break-words">{item?.cause || "Fallo de respuesta"}</span>
          </DialogTitle>
          <DialogDescription>
            {item ? `${formatDateTime(item.createdAt)} · severidad ${severityLabel(item.severity).toLowerCase()}` : ""}
            {category && CATEGORY_HINTS[category] ? ` · ${CATEGORY_HINTS[category]}` : ""}
          </DialogDescription>
        </DialogHeader>

        {item && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Field label="Usuario">{item.userEmail || item.userId}</Field>
              <Field label="Modelo elegido">{m.modelLabel || m.modelPicked}</Field>
              <Field label="Modelo usado">{[m.providerUsed, m.modelUsed].filter(Boolean).join(" · ")}</Field>
              <Field label="Ruta">{m.route}</Field>
              <Field label="Duración">{formatDuration(item.totalMs)}</Field>
              <Field label="Primera respuesta">{formatDuration(m.ttfbMs ?? null)}</Field>
              <Field label="Fin del turno">{m.endReason}</Field>
              <Field label="Estado HTTP">{m.status ? String(m.status) : null}</Field>
              <Field label="Navegador">{m.browser}</Field>
              <Field label="Versión (commit)" mono>{m.commit}</Field>
              <Field label="Ocurrencias">{String(item.occurrences || 1)}</Field>
              <Field label="Request id" mono>{Array.isArray(m.reqIds) ? m.reqIds.join(" ") : null}</Field>
            </div>

            {Array.isArray(m.fallbackChain) && m.fallbackChain.length > 0 && (
              <Field label="Cadena de respaldo">{m.fallbackChain.join(" → ")}</Field>
            )}

            <Block label="Pregunta del usuario">
              <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm">{item.prompt || "—"}</p>
            </Block>

            <Block label="Qué vio el usuario">
              <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm">{item.whatUserSaw || "(nada)"}</p>
            </Block>

            {(m.errorMessage || m.errorCode) && (
              <Block label="Error">
                <p className="whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50/60 p-3 font-mono text-xs text-red-800">
                  {[m.errorCode, m.errorMessage].filter(Boolean).join(" — ")}
                </p>
              </Block>
            )}

            {Array.isArray(m.attachments) && m.attachments.length > 0 && (
              <Block label="Adjuntos">
                <ul className="space-y-1 text-sm">
                  {m.attachments.map((a, i) => (
                    <li key={`${a.name}-${i}`} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.name || "archivo"}</span>
                      <span className="text-xs text-muted-foreground">{[a.type, a.kind, a.textChars != null ? `${a.textChars} caracteres leídos` : null].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            {Array.isArray(m.stages) && m.stages.length > 0 && (
              <Block label="Últimas etapas">
                <ol className="space-y-1 border-l border-border/70 pl-3 text-sm" data-testid="turn-failure-stages">
                  {m.stages.map((st, i) => (
                    <li key={`${st.label}-${i}`} className="flex items-baseline gap-2">
                      <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{formatDuration(st.atMs)}</span>
                      <span className="text-foreground">{st.label}</span>
                      {st.tool && <span className="font-mono text-[11px] text-muted-foreground">{st.tool}</span>}
                    </li>
                  ))}
                </ol>
              </Block>
            )}

            {Array.isArray(m.signals) && m.signals.length > 1 && (
              <Block label="Señales">
                <ul className="space-y-1 text-sm">
                  {m.signals.map((sg, i) => (
                    <li key={`${sg.at}-${i}`} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{sg.source === "client" ? "Navegador" : sg.source === "user" ? "Usuario" : "Servidor"}</span>
                      {" · "}{categoryLabel(sg.category)}{" · "}{sg.cause}
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            {Array.isArray(m.notes) && m.notes.length > 0 && (
              <Block label="Detalle técnico">
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-3 text-xs leading-relaxed">
                  {m.notes.map((n) => `+${formatDuration(n.atMs)}  ${n.kind}${n.data ? `  ${JSON.stringify(n.data)}` : ""}`).join("\n")}
                </pre>
              </Block>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {m.openLink && (
                <Button asChild variant="outline" size="sm">
                  <a href={String(m.openLink)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    Abrir chat
                  </a>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copiar JSON
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
