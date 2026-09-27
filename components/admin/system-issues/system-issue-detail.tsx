"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, Copy, Eye, EyeOff, ExternalLink, RotateCcw, Search as SearchIcon, TrendingUp } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { apiClient } from "@/lib/api"
import type { SystemIssueDetail, SystemIssueItem, SystemIssueStatus } from "@/lib/admin/system-issues-types"
import { cn } from "@/lib/utils"
import { RequestLogsSection } from "../turn-failures/turn-failure-detail"
import { formatDateTime, formatRelative } from "../turn-failures/turn-failure-labels"
import { IssueSparkline } from "./issue-sparkline"
import { formatCount, issueStatusClass, issueStatusLabel, kindLabel, levelClass, levelLabel } from "./system-issue-labels"

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("break-words text-sm text-foreground", mono && "font-mono text-xs")}>{children || "—"}</div>
    </div>
  )
}

function Block({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="min-w-0" data-testid={testId}>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </section>
  )
}

const STATUS_ACTIONS: Array<{ to: SystemIssueStatus; label: string; icon: typeof CheckCircle2; show: (s: SystemIssueStatus) => boolean }> = [
  { to: "en_revision", label: "En revisión", icon: SearchIcon, show: (s) => s === "nuevo" },
  { to: "resuelto", label: "Marcar resuelto", icon: CheckCircle2, show: (s) => s === "nuevo" || s === "en_revision" },
  { to: "ignorado", label: "Ignorar", icon: EyeOff, show: (s) => s === "nuevo" || s === "en_revision" },
  { to: "nuevo", label: "Reabrir", icon: RotateCcw, show: (s) => s === "resuelto" || s === "ignorado" },
]

export function SystemIssueDetailSheet({
  issueId,
  onOpenChange,
  onChanged,
}: {
  issueId: string | null
  onOpenChange: (open: boolean) => void
  onChanged?: (item: SystemIssueItem) => void
}) {
  const [detail, setDetail] = useState<SystemIssueDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<SystemIssueStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    if (!issueId) return
    setLoading(true)
    apiClient.getAdminSystemIssue(issueId)
      .then((res) => { if (!cancelled) setDetail(res?.item || null) })
      .catch((err: any) => { if (!cancelled) setError(err?.message || "No se pudo leer el error") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [issueId])

  const changeStatus = async (to: SystemIssueStatus) => {
    if (!detail) return
    setSaving(to)
    try {
      const res = await apiClient.setAdminSystemIssueStatus(detail.id, to)
      const item = res?.item
      if (item) {
        setDetail((d) => (d ? { ...d, ...item } : d))
        onChanged?.(item)
      }
      toast.success(to === "resuelto" ? "Marcado como resuelto: si vuelve a ocurrir se reabrirá como regresión" : `Estado: ${issueStatusLabel(to)}`)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo cambiar el estado")
    } finally {
      setSaving(null)
    }
  }

  const copy = async () => {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(detail, null, 2))
      toast.success("Error copiado (JSON) al portapapeles")
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  const d = detail
  return (
    <Sheet open={!!issueId} onOpenChange={onOpenChange}>
      <SheetContent side="right" closeLabel="Cerrar" className="w-full overflow-y-auto sm:max-w-2xl" data-testid="system-issue-detail">
        <SheetHeader className="space-y-2 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            {d && <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", levelClass(d.level))}>{levelLabel(d.level)}</span>}
            {d && <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">{kindLabel(d.kind, d.kindLabel)}</span>}
            {d && <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", issueStatusClass(d.status))} data-testid="system-issue-status">{issueStatusLabel(d.status)}</span>}
            {d?.regression && <span className="rounded-full bg-fuchsia-600 px-2 py-0.5 text-[11px] font-semibold text-white">Regresión</span>}
            {d?.spike && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                <TrendingUp className="h-3 w-3" /> Pico: {d.lastHour} en 1 h
              </span>
            )}
          </div>
          <SheetTitle className="break-words font-mono text-[15px] leading-snug">{d?.title || (loading ? "Cargando…" : "Error del sistema")}</SheetTitle>
          <SheetDescription className="break-words">
            {d?.culprit ? <span className="font-mono text-xs">{d.culprit}</span> : null}
          </SheetDescription>
        </SheetHeader>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        {d && (
          <div className="mt-4 space-y-5">
            <div className="flex flex-wrap gap-2">
              {STATUS_ACTIONS.filter((a) => a.show(d.status)).map((a) => (
                <Button
                  key={a.to}
                  size="sm"
                  variant={a.to === "resuelto" ? "default" : "outline"}
                  disabled={saving !== null}
                  onClick={() => void changeStatus(a.to)}
                  data-testid={`system-issue-action-${a.to}`}
                >
                  <a.icon className="mr-1.5 h-3.5 w-3.5" />
                  {saving === a.to ? "Guardando…" : a.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => void copy()}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copiar JSON
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Field label="Eventos">{formatCount(d.count)}</Field>
              <Field label="Últimas 24 h">{formatCount(d.events24h)}</Field>
              <Field label="Usuarios afectados">{formatCount(d.usersCount)}</Field>
              <Field label="Primera vez">{`${formatDateTime(d.firstSeen)} · ${formatRelative(d.firstSeen)}`}</Field>
              <Field label="Última vez">{`${formatDateTime(d.lastSeen)} · ${formatRelative(d.lastSeen)}`}</Field>
              <Field label="Líneas de log">{formatCount(d.lines)}</Field>
              <Field label="Entorno">{d.environment}</Field>
              <Field label="Versión (commit)" mono>{d.commits.length ? d.commits.join(" · ") : d.lastCommit}</Field>
              <Field label="Huella" mono>{d.fingerprint}</Field>
            </div>
            {d.resolvedAt && <p className="text-xs text-muted-foreground">Resuelto {formatRelative(d.resolvedAt)}{d.resolvedBy ? ` por ${d.resolvedBy}` : ""}.</p>}

            <Block label="Eventos por hora (48 h)">
              <IssueSparkline values={d.hours48} width={520} height={44} className="w-full" />
            </Block>

            <Block label={`Muestras (${d.samples.length})`} testId="system-issue-samples">
              <ol className="space-y-3">
                {d.samples.map((s, i) => (
                  <li key={`${s.at}-${i}`} className="rounded-md border border-border/70 bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">{formatDateTime(s.at)}</span>
                      {s.method || s.route ? <span className="font-mono text-foreground">{[s.method, s.route].filter(Boolean).join(" ")}</span> : null}
                      {s.status ? <span className="font-mono">HTTP {s.status}</span> : null}
                      {s.queue ? <span>cola {s.queue}</span> : null}
                      {s.tag ? <span className="font-mono">[{s.tag}]</span> : null}
                      {s.burst > 1 ? <span className="rounded bg-muted px-1.5">×{s.burst} líneas en ráfaga</span> : null}
                    </div>
                    {s.message && <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-foreground">{s.message}</p>}
                    {s.stack && (
                      <details className="mt-2" open={i === 0}>
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Traza (stack)</summary>
                        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre rounded bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100" data-testid="system-issue-stack">
                          {s.stack}
                        </pre>
                      </details>
                    )}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      {s.reqId ? <span className="font-mono">req {s.reqId}</span> : null}
                      {s.page ? <span>página {s.page}</span> : null}
                      {s.browser ? <span>{s.browser}</span> : null}
                      {s.host ? <span>host {s.host}</span> : null}
                      {s.commit ? <span className="font-mono">{s.commit}</span> : null}
                    </div>
                    {s.reqId && <div className="mt-2"><RequestLogsSection reqIds={[s.reqId]} /></div>}
                  </li>
                ))}
              </ol>
            </Block>

            {d.users.length > 0 && (
              <Block label={`Usuarios afectados (${d.usersCount})`} testId="system-issue-users">
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {d.users.map((u) => (
                    <li key={u.id} className="rounded-full border border-border/70 px-2 py-0.5">{u.email || u.name || u.id}</li>
                  ))}
                </ul>
              </Block>
            )}

            {d.linkedTurns.length > 0 && (
              <Block label="Fallos de respuesta relacionados" testId="system-issue-linked-turns">
                <ul className="space-y-2">
                  {d.linkedTurns.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-2.5 text-xs">
                      <div className="min-w-0">
                        <div className="font-medium">{t.categoryLabel || t.category} · {t.cause}</div>
                        <div className="truncate text-muted-foreground">{t.userEmail} · {t.prompt}</div>
                      </div>
                      {t.openLink && (
                        <a href={t.openLink} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground">
                          <ExternalLink className="h-3.5 w-3.5" /> Chat
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            {d.history.length > 0 && (
              <Block label="Historial">
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {d.history.map((h, i) => (
                    <li key={`${h.at}-${i}`}>
                      <Eye className="mr-1 inline h-3 w-3" />
                      {formatDateTime(h.at)} · {h.by || "admin"}: {issueStatusLabel(h.from)} → {issueStatusLabel(h.to)}
                    </li>
                  ))}
                </ul>
              </Block>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
