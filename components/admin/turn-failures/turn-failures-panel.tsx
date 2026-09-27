"use client"

/**
 * Admin → Logs → «Fallos de respuesta».
 *
 * One row per user question the platform failed (error, no answer, hang,
 * lost attachment, failed tool, unusable answer, thumbs-down). Normal turns
 * never appear. Live: new rows arrive with the admin-wide alerts poller
 * (`revision`), counters and «Causas principales» refresh with them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bell, BellOff, Download, RefreshCw, Search, Volume2, VolumeX } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiClient } from "@/lib/api"
import { useTurnFailureAlerts } from "@/lib/admin/turn-failure-alerts"
import type {
  AdminTurnFailureItem,
  AdminTurnFailureStats,
} from "@/lib/admin/turn-failures-types"
import { cn } from "@/lib/utils"
import { TopCausesPanel, type CauseWindow } from "./top-causes-panel"
import { TurnFailureDetailDialog } from "./turn-failure-detail"
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  categoryLabel,
  formatDateTime,
  formatDuration,
  formatRelative,
  severityBadgeClass,
} from "./turn-failure-labels"

const PAGE_SIZE = 25
const STATS_REFRESH_MS = 30_000
const HIGHLIGHT_MS = 6000

type Filters = {
  category: string
  model: string
  user: string
  q: string
  from: string
  to: string
}

const EMPTY_FILTERS: Filters = { category: "all", model: "all", user: "", q: "", from: "", to: "" }

function dayBoundIso(date: string, end: boolean): string | undefined {
  if (!date) return undefined
  const d = new Date(`${date}${end ? "T23:59:59.999" : "T00:00:00.000"}`)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

function toQuery(filters: Filters) {
  return {
    category: filters.category !== "all" ? filters.category : undefined,
    model: filters.model !== "all" ? filters.model : undefined,
    user: filters.user.trim() || undefined,
    q: filters.q.trim().length >= 2 ? filters.q.trim() : undefined,
    from: dayBoundIso(filters.from, false),
    to: dayBoundIso(filters.to, true),
  }
}

function StatCard({ label, value, hint, tone = "default" }: { label: string; value: string; hint?: string; tone?: "default" | "alert" }) {
  return (
    <div className={cn("rounded-lg border px-4 py-3", tone === "alert" ? "border-red-200 bg-red-50/60" : "border-border/70 bg-background")}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "alert" && "text-red-700")}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export function TurnFailuresPanel() {
  const alerts = useTurnFailureAlerts()
  const [items, setItems] = useState<AdminTurnFailureItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<AdminTurnFailureStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [causeWindow, setCauseWindow] = useState<CauseWindow>("24h")
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [draftQ, setDraftQ] = useState("")
  const [draftUser, setDraftUser] = useState("")
  const [detail, setDetail] = useState<AdminTurnFailureItem | null>(null)
  const [recentlyNew, setRecentlyNew] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const knownIds = useRef<Set<string>>(new Set())
  const seeded = useRef(false)

  // While this view is on screen, new failures count as seen (no badge).
  useEffect(() => {
    alerts?.setViewing(true)
    return () => alerts?.setViewing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts?.setViewing])

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res = await apiClient.getAdminTurnFailures({ ...toQuery(filters), page, limit: PAGE_SIZE })
      const list = Array.isArray(res?.items) ? res.items : []
      if (seeded.current) {
        const fresh = list.filter((it) => !knownIds.current.has(it.id)).map((it) => it.id)
        if (fresh.length) {
          setRecentlyNew((prev) => new Set([...Array.from(prev), ...fresh]))
          window.setTimeout(() => {
            setRecentlyNew((prev) => {
              const next = new Set(prev)
              fresh.forEach((id) => next.delete(id))
              return next
            })
          }, HIGHLIGHT_MS)
        }
      }
      list.forEach((it) => knownIds.current.add(it.id))
      seeded.current = true
      setItems(list)
      setTotal(typeof res?.total === "number" ? res.total : null)
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los fallos")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [filters, page])

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      setStats(await apiClient.getAdminTurnFailureStats())
    } catch {
      /* keep the previous counters */
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => { void loadList(false) }, [loadList])
  useEffect(() => { void loadStats() }, [loadStats])

  // Live: every batch the admin-wide poller detects refreshes the view.
  const revision = alerts?.revision ?? 0
  useEffect(() => {
    if (revision === 0) return
    void loadList(true)
    void loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return
      void loadStats()
      if (page === 1) void loadList(true)
    }, STATS_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [loadList, loadStats, page])

  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    stats?.byModel24h.forEach((m) => m.name && m.name !== "—" && set.add(m.name))
    items.forEach((it) => it.model && set.add(it.model))
    return Array.from(set).sort()
  }, [stats, items])

  const setFilter = (patch: Partial<Filters>) => {
    setPage(1)
    setFilters((f) => ({ ...f, ...patch }))
  }

  const openById = async (id: string) => {
    const local = items.find((it) => it.id === id)
    if (local) { setDetail(local); return }
    try {
      const res = await apiClient.getAdminTurnFailures({ id, limit: 1 })
      if (res?.items?.[0]) setDetail(res.items[0])
      else toast.error("Ese fallo ya no está disponible")
    } catch {
      toast.error("No se pudo abrir el fallo")
    }
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      const csv = await apiClient.exportAdminTurnFailuresCsv(toQuery(filters))
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "fallos-de-respuesta.csv"
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Fallos exportados a CSV")
    } catch (err: any) {
      toast.error(err?.message || "No se pudo exportar el CSV")
    } finally {
      setExporting(false)
    }
  }

  const rate = stats?.failureRate24h
  const rateText = rate && rate.total ? `${rate.failed} de ${rate.total} preguntas` : `${rate?.failed ?? 0} fallos`
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS)

  return (
    <div className="space-y-4" data-testid="turn-failures-panel">
      {/* Sound + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-background px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium" title="Suena en cualquier página del panel cuando un usuario no recibe una respuesta correcta">
            <Switch
              checked={!!alerts?.soundOn}
              onCheckedChange={(v) => { void alerts?.setSoundOn(!!v) }}
              aria-label="Sonido de errores"
              data-testid="turn-failure-sound-toggle"
            />
            {alerts?.soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-muted-foreground" />}
            <span data-testid="turn-failure-sound-status">Sonido de errores: {alerts?.soundOn ? "activado" : "desactivado"}</span>
          </label>
          {alerts?.soundOn && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {alerts.notificationsOn ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              {alerts.notificationsOn ? "Avisos de escritorio activados" : "Avisos de escritorio desactivados (permiso del navegador)"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { void loadList(false); void loadStats() }} disabled={loading}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Actualizar
          </Button>
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {exporting ? "Exportando…" : "Exportar CSV"}
          </Button>
        </div>
      </div>

      {/* Counters */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Última hora" value={String(stats?.counts.lastHour ?? "—")} tone={(stats?.counts.lastHour || 0) > 0 ? "alert" : "default"} />
        <StatCard label="Últimas 24 h" value={String(stats?.counts.last24h ?? "—")} hint={rateText} />
        <StatCard
          label="Tasa de fallo 24 h"
          value={rate?.pct != null ? `${rate.pct}%` : "—"}
          hint={rate?.total ? `sobre ${rate.total} preguntas de usuarios` : "sin datos de volumen"}
        />
        <StatCard label="Últimos 7 días" value={String(stats?.counts.last7d ?? "—")} />
      </div>

      {/* By category (click to filter) */}
      {stats && stats.byCategory24h.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Fallos por tipo en 24 h">
          {stats.byCategory24h.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => setFilter({ category: filters.category === c.name ? "all" : c.name })}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                filters.category === c.name ? "border-zinc-900 bg-zinc-900 text-white" : "border-border/70 bg-background hover:bg-muted/50",
              )}
            >
              {categoryLabel(c.name, c.label)} · {c.count}
            </button>
          ))}
        </div>
      )}

      <TopCausesPanel
        causes={stats?.topCauses || null}
        window={causeWindow}
        onWindowChange={setCauseWindow}
        onOpenExample={(id) => void openById(id)}
        loading={statsLoading && !stats}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-background px-4 py-3">
        <div className="w-48">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Tipo</div>
          <Select value={filters.category} onValueChange={(v) => setFilter({ category: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tipos</SelectItem>
              {CATEGORY_ORDER.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Modelo</div>
          <Select value={filters.model} onValueChange={(v) => setFilter({ model: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los modelos</SelectItem>
              {modelOptions.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Usuario</div>
          <Input
            value={draftUser}
            onChange={(e) => setDraftUser(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setFilter({ user: draftUser }) }}
            onBlur={() => { if (draftUser !== filters.user) setFilter({ user: draftUser }) }}
            placeholder="correo o id"
            className="h-8 text-xs"
          />
        </div>
        <div className="min-w-[12rem] flex-1">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Buscar</div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setFilter({ q: draftQ }) }}
              placeholder="pregunta, causa o lo que vio el usuario"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Desde</div>
          <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter({ from: e.target.value })} className="h-8 w-[9.5rem] text-xs" />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Hasta</div>
          <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter({ to: e.target.value })} className="h-8 w-[9.5rem] text-xs" />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setDraftQ(""); setDraftUser(""); setPage(1); setFilters(EMPTY_FILTERS) }}>
            Limpiar
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/70 bg-background">
        {error ? (
          <div className="px-4 py-6 text-center text-sm text-destructive">{error}</div>
        ) : items.length === 0 && !loading ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="turn-failures-empty">
            {hasFilters ? "Sin fallos para este filtro." : "Sin fallos de respuesta. Cuando un usuario no reciba una respuesta correcta aparecerá aquí al instante."}
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-36">Fecha</TableHead>
                    <TableHead className="w-44">Tipo</TableHead>
                    <TableHead className="w-44">Usuario</TableHead>
                    <TableHead className="w-32">Modelo</TableHead>
                    <TableHead>Pregunta</TableHead>
                    <TableHead>Qué vio el usuario</TableHead>
                    <TableHead className="w-20 text-right">Duración</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow
                      key={it.id}
                      className={cn("cursor-pointer", recentlyNew.has(it.id) && "bg-amber-50")}
                      style={recentlyNew.has(it.id) ? { boxShadow: "inset 3px 0 0 #f59e0b" } : undefined}
                      onClick={() => setDetail(it)}
                      data-testid="turn-failure-row"
                    >
                      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={formatDateTime(it.createdAt)}>
                        {formatDateTime(it.createdAt)}
                        <div className="text-[11px]">{formatRelative(it.createdAt)}</div>
                      </TableCell>
                      <TableCell>
                        <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", severityBadgeClass(it.severity))}>
                          {categoryLabel(it.category, it.categoryLabel)}
                        </span>
                        <div className="mt-1 max-w-44 truncate text-[11px] text-muted-foreground" title={it.cause || undefined}>{it.cause}</div>
                      </TableCell>
                      <TableCell className="max-w-44 truncate text-xs" title={it.userEmail || it.userId || undefined}>{it.userEmail || it.userId || "—"}</TableCell>
                      <TableCell className="max-w-32 truncate text-xs">{it.model || "—"}</TableCell>
                      <TableCell className="max-w-xs truncate text-xs" title={it.prompt || undefined}>{it.prompt || "—"}</TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={it.whatUserSaw || undefined}>{it.whatUserSaw || "(nada)"}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatDuration(it.totalMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2 p-2 md:hidden">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setDetail(it)}
                  className={cn("w-full rounded-lg border bg-card p-3 text-left", recentlyNew.has(it.id) && "border-amber-300 bg-amber-50")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium", severityBadgeClass(it.severity))}>
                      {categoryLabel(it.category, it.categoryLabel)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{formatRelative(it.createdAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-sm font-medium">{it.cause}</div>
                  <div className="truncate text-xs text-muted-foreground">{it.userEmail || it.userId} · {it.model || "—"}</div>
                  <div className="mt-1 line-clamp-2 text-xs">{it.prompt}</div>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            Página {page}{total != null ? ` · ${total} fallo${total === 1 ? "" : "s"}` : ""}{page === 1 ? " · en vivo" : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
            <Button variant="outline" size="sm" disabled={loading || items.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </div>
        </div>
      </div>

      <TurnFailureDetailDialog item={detail} onOpenChange={(open) => { if (!open) setDetail(null) }} />
    </div>
  )
}
