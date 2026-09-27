"use client"

/**
 * Admin → Logs → «Errores del sistema».
 *
 * Every backend / frontend error of siragpt.com grouped into ISSUES by
 * fingerprint (Sentry-like): title, culprit, events, affected users, 24 h
 * sparkline, first / last seen and status (nuevo · en revisión · resuelto ·
 * ignorado). A resolved issue that comes back is reopened as a regression.
 * Live: the admin-wide listener bumps `issuesRevision` on new issues and
 * regressions; the list also refreshes every 15 s.
 */

import { useCallback, useEffect, useState } from "react"
import { RefreshCw, Search, TrendingUp, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiClient } from "@/lib/api"
import { useTurnFailureAlerts } from "@/lib/admin/turn-failure-alerts"
import type { AdminSystemIssueStats, SystemIssueItem } from "@/lib/admin/system-issues-types"
import { cn } from "@/lib/utils"
import { formatRelative } from "../turn-failures/turn-failure-labels"
import { IssueSparkline } from "./issue-sparkline"
import { SystemIssueDetailSheet } from "./system-issue-detail"
import {
  ISSUE_KIND_ORDER,
  ISSUE_STATUS_FILTERS,
  formatCount,
  issueStatusClass,
  issueStatusLabel,
  kindLabel,
  levelClass,
  levelLabel,
} from "./system-issue-labels"

const PAGE_SIZE = 25
const REFRESH_MS = 15_000

type Filters = { status: string; kind: string; q: string; sort: string }
const DEFAULT_FILTERS: Filters = { status: "abiertos", kind: "all", q: "", sort: "recientes" }

function StatCard({ label, value, hint, tone = "default" }: { label: string; value: string; hint?: string; tone?: "default" | "alert" }) {
  return (
    <div className={cn("rounded-lg border px-4 py-3", tone === "alert" ? "border-red-200 bg-red-50/60 dark:border-red-400/30 dark:bg-red-500/10" : "border-border/70 bg-background")}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "alert" && "text-red-700 dark:text-red-300")}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function SystemIssuesPanel() {
  const alerts = useTurnFailureAlerts()
  const [items, setItems] = useState<SystemIssueItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<AdminSystemIssueStats | null>(null)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [draftQ, setDraftQ] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)

  // While this view is on screen, new issues count as seen (no badge).
  useEffect(() => {
    alerts?.setViewingIssues(true)
    return () => alerts?.setViewingIssues(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts?.setViewingIssues])

  // Deep links: ?issue=<id> (desktop notification) opens the drawer;
  // ?fp=<fingerprint> (a failed turn's «Ver en Errores del sistema») finds
  // the issue whatever its status.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const id = params.get("issue")
      if (id && /^[A-Za-z0-9_-]{4,80}$/.test(id)) setOpenId(id)
      const fp = params.get("fp")
      if (fp && /^[a-f0-9]{8,40}$/.test(fp)) {
        setDraftQ(fp)
        setFilters({ ...DEFAULT_FILTERS, status: "todos", q: fp })
      }
    } catch { /* ignore */ }
  }, [])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [list, st] = await Promise.all([
        apiClient.getAdminSystemIssues({
          status: filters.status,
          kind: filters.kind !== "all" ? filters.kind : undefined,
          q: filters.q.trim().length >= 2 ? filters.q.trim() : undefined,
          sort: filters.sort,
          page,
          limit: PAGE_SIZE,
        }),
        apiClient.getAdminSystemIssueStats().catch(() => null),
      ])
      setItems(Array.isArray(list?.items) ? list.items : [])
      setTotal(Number(list?.total) || 0)
      if (st) setStats(st)
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los errores del sistema")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [filters, page])

  useEffect(() => { void load(false) }, [load])

  const issuesRevision = alerts?.issuesRevision ?? 0
  useEffect(() => {
    if (issuesRevision === 0) return
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuesRevision])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) void load(true)
    }, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [load])

  const setFilter = (patch: Partial<Filters>) => {
    setPage(1)
    setFilters((f) => ({ ...f, ...patch }))
  }

  const onChanged = (item: SystemIssueItem) => {
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...item } : it)))
    void load(true)
  }

  return (
    <div className="space-y-4" data-testid="system-issues-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-background px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium" title="Suena en cualquier página del panel con cada error NUEVO o regresión (no con cada repetición)">
          <Switch
            checked={!!alerts?.soundOn}
            onCheckedChange={(v) => { void alerts?.setSoundOn(!!v) }}
            aria-label="Sonido de errores"
            data-testid="system-issues-sound-toggle"
          />
          {alerts?.soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-muted-foreground" />}
          <span>Sonido de errores: {alerts?.soundOn ? "activado" : "desactivado"}</span>
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">· suena con errores nuevos y regresiones</span>
        </label>
        <Button variant="outline" size="sm" onClick={() => void load(false)} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          Actualizar
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Abiertos" value={formatCount(stats?.open)} tone={(stats?.open || 0) > 0 ? "alert" : "default"} hint="nuevos + en revisión" />
        <StatCard label="Nuevos 24 h" value={formatCount(stats?.new24h)} />
        <StatCard label="Regresiones" value={formatCount(stats?.regressions)} tone={(stats?.regressions || 0) > 0 ? "alert" : "default"} hint="volvieron tras resolverse" />
        <StatCard label="Eventos 24 h" value={formatCount(stats?.events24h)} hint={stats?.spikes ? `${stats.spikes} con pico` : "ráfagas agrupadas"} />
        <StatCard label="Resueltos 7 días" value={formatCount(stats?.resolved7d)} />
      </div>

      {stats && stats.byKind.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Errores abiertos por tipo">
          {stats.byKind.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => setFilter({ kind: filters.kind === k.kind ? "all" : k.kind })}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                filters.kind === k.kind ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900" : "border-border/70 bg-background hover:bg-muted/50",
              )}
            >
              {kindLabel(k.kind)} · {k.count}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-background px-4 py-3">
        <div className="w-40">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Estado</div>
          <Select value={filters.status} onValueChange={(v) => setFilter({ status: v })}>
            <SelectTrigger className="h-8 text-xs" data-testid="system-issues-status-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ISSUE_STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Tipo</div>
          <Select value={filters.kind} onValueChange={(v) => setFilter({ kind: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tipos</SelectItem>
              {ISSUE_KIND_ORDER.map((k) => <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Orden</div>
          <Select value={filters.sort} onValueChange={(v) => setFilter({ sort: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="recientes">Más recientes</SelectItem>
              <SelectItem value="frecuentes">Más frecuentes 24 h</SelectItem>
              <SelectItem value="usuarios">Más usuarios</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Buscar</div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setFilter({ q: draftQ }) }}
              onBlur={() => { if (draftQ !== filters.q) setFilter({ q: draftQ }) }}
              placeholder="mensaje, función, ruta o huella"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/70 bg-background">
        {error ? (
          <div className="px-4 py-6 text-center text-sm text-destructive">{error}</div>
        ) : items.length === 0 && !loading ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="system-issues-empty">
            {filters.status === "abiertos" && filters.kind === "all" && !filters.q
              ? "Sin errores abiertos. Cualquier error nuevo del backend o del navegador aparecerá aquí al instante."
              : "Sin errores para este filtro."}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(it.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  data-testid="system-issue-row"
                >
                  <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", levelClass(it.level))}>{levelLabel(it.level)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-mono text-[13px] font-medium text-foreground" title={it.title}>{it.title}</span>
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      {it.culprit && <span className="max-w-[28rem] truncate font-mono" title={it.culprit}>{it.culprit}</span>}
                      <span>{kindLabel(it.kind, it.kindLabel)}</span>
                      <span className={cn("rounded-full border px-1.5 py-px font-medium", issueStatusClass(it.status))}>{issueStatusLabel(it.status)}</span>
                      {it.regression && <span className="rounded-full bg-fuchsia-600 px-1.5 py-px font-semibold text-white">Regresión</span>}
                      {it.spike && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-orange-500 px-1.5 py-px font-semibold text-white">
                          <TrendingUp className="h-3 w-3" /> Pico
                        </span>
                      )}
                      <span>visto {formatRelative(it.lastSeen)} · primera vez {formatRelative(it.firstSeen)}</span>
                    </span>
                  </span>
                  <IssueSparkline values={it.sparkline} className="mt-1 hidden sm:block" />
                  <span className="w-16 shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums">{formatCount(it.count)}</span>
                    <span className="block text-[10px] text-muted-foreground">eventos</span>
                  </span>
                  <span className="hidden w-16 shrink-0 text-right md:block">
                    <span className="block text-sm font-semibold tabular-nums">{formatCount(it.usersCount)}</span>
                    <span className="block text-[10px] text-muted-foreground">usuarios</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            Página {page} · {total} error{total === 1 ? "" : "es"}{page === 1 ? " · en vivo" : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
            <Button variant="outline" size="sm" disabled={loading || page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </div>
        </div>
      </div>

      <SystemIssueDetailSheet issueId={openId} onOpenChange={(open) => { if (!open) setOpenId(null) }} onChanged={onChanged} />
    </div>
  )
}
