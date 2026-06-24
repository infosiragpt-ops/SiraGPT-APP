"use client"

/**
 * Admin · Logs — auditoría operativa del sistema, en vivo.
 *
 * The backend (/api/admin/audit-logs[.csv|/search]) exposes the audit feed
 * over REST; this page is the operator console on top of it.
 *
 * Built for tracking software errors (a failed image generation, a session
 * mismatch, a denied admin op) and resolving them fast:
 *   - ALWAYS LIVE: an adaptive poller (self-rescheduling, backoff, tab-hidden
 *     pause) keeps page 1 streaming with a connection indicator — no toggle.
 *   - NEW-ERROR ALERTS: new error events fire a toast, an optional beep, a
 *     "nuevos errores" counter and a brief row highlight (watermark-seeded so
 *     the initial backlog never alerts).
 *   - SELECT + COPY: per-row checkboxes + one-click copy (TSV, paste-ready).
 *   - DATE RANGE + ERRORS-ONLY filters.
 *   - DETAIL + AI DIAGNOSE: click a row for the full untruncated metadata and
 *     a one-click AI root-cause + fix suggestion (FlashGPT, no chat persisted).
 *
 * Realtime is POLLING through apiClient (Bearer header) — deliberately not
 * SSE/EventSource: the app has no token cookie and a JWT must never travel in
 * a URL, so polling is the security-respecting, no-backend-change path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Download, RefreshCw, Search, Sparkles, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

type AuditLogRow = {
  id: string
  actorType?: string | null
  actorId?: string | null
  actorName?: string | null
  resourceType?: string | null
  resourceId?: string | null
  action: string
  metadata?: Record<string, unknown> | null
  createdAt: string
}

const PAGE_SIZE = 25
const LIVE_INTERVAL_MS = 5000
const MAX_LIVE_BACKOFF_MS = 30000
const HIGHLIGHT_MS = 6000
const MAX_LIVE_ROWS = 200

type ConnState = "live" | "reconnecting" | "paused"

function isErrorAction(action: string): boolean {
  return /fail|error|denied|revoked|deleted|mismatch|expired|blocked|rejected|invalid/i.test(action)
}

function actionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (isErrorAction(action)) return "destructive"
  if (/login|session|auth/i.test(action)) return "secondary"
  return "outline"
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "medium" })
  } catch {
    return iso
  }
}

function metadataSummary(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== "object") return ""
  const parts: string[] = []
  if (typeof metadata.reason === "string") parts.push(metadata.reason)
  if (typeof metadata.ip === "string") parts.push(String(metadata.ip))
  if (parts.length === 0) {
    const keys = Object.keys(metadata).slice(0, 3)
    if (keys.length) parts.push(keys.map((k) => `${k}=${String((metadata as any)[k]).slice(0, 24)}`).join(" · "))
  }
  return parts.join(" · ").slice(0, 90)
}

function metadataFull(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== "object") return ""
  try {
    return JSON.stringify(metadata)
  } catch {
    return ""
  }
}

// Convert a <input type="date"> value (YYYY-MM-DD) into an inclusive ISO bound.
function dayBoundIso(date: string, end: boolean): string | undefined {
  if (!date) return undefined
  const suffix = end ? "T23:59:59.999" : "T00:00:00.000"
  const d = new Date(`${date}${suffix}`)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

const rowTime = (r: AuditLogRow): number => {
  const t = Date.parse(r.createdAt)
  return Number.isFinite(t) ? t : 0
}

export default function AdminLogsPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [actionFilter, setActionFilter] = useState<string>("all")
  const [knownActions, setKnownActions] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<AuditLogRow | null>(null)

  // Live engine
  const [connState, setConnState] = useState<ConnState>("live")
  const [newErrorCount, setNewErrorCount] = useState(0)
  const [soundOn, setSoundOn] = useState(false)
  const [recentlyNew, setRecentlyNew] = useState<Set<string>>(new Set())

  // AI diagnosis
  const [diagnosis, setDiagnosis] = useState("")
  const [diagnosing, setDiagnosing] = useState(false)

  // Refs (avoid stale closures in the poller / no re-render churn)
  const filtersRef = useRef({ searchTerm, actionFilter, fromDate, toDate, errorsOnly, page })
  filtersRef.current = { searchTerm, actionFilter, fromDate, toDate, errorsOnly, page }
  const watermark = useRef(0)
  const seededRef = useRef(false)
  const inFlight = useRef(false)
  const failuresRef = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioCtxRef = useRef<any>(null)
  const soundOnRef = useRef(soundOn)
  soundOnRef.current = soundOn
  const diagAbort = useRef<AbortController | null>(null)

  const beep = useCallback(() => {
    if (!soundOnRef.current) return
    try {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!Ctor) return
      if (!audioCtxRef.current) audioCtxRef.current = new Ctor()
      const ctx = audioCtxRef.current
      if (ctx.state === "suspended") ctx.resume().catch(() => {})
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.2)
    } catch {
      /* SSR / autoplay-policy safe */
    }
  }, [])

  const flashRows = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setRecentlyNew((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
    window.setTimeout(() => {
      setRecentlyNew((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }, HIGHLIGHT_MS)
  }, [])

  // Fetch one page from the audit feed with the active filters.
  const fetchPage = useCallback(async (targetPage: number): Promise<AuditLogRow[]> => {
    const f = filtersRef.current
    const fromIso = dayBoundIso(f.fromDate, false)
    const toIso = dayBoundIso(f.toDate, true)
    const common: Record<string, string | number> = { page: targetPage, limit: PAGE_SIZE, order: "desc" }
    if (fromIso) common.from = fromIso
    if (toIso) common.to = toIso
    const params: Record<string, string | number> = { ...common }
    if (f.actionFilter && f.actionFilter !== "all") params.action = f.actionFilter
    const response: any = f.searchTerm.trim()
      ? await apiClient.searchAdminAuditLogs({ q: f.searchTerm.trim(), ...common } as any)
      : await apiClient.getAdminAuditLogs(params as any)
    return response?.items || response?.logs || []
  }, [])

  const ingest = useCallback((items: AuditLogRow[]) => {
    setKnownActions((prev) => {
      const next = new Set(prev)
      items.forEach((row) => row.action && next.add(row.action))
      return Array.from(next).sort()
    })
    setLastUpdated(new Date().toLocaleTimeString("es", { timeStyle: "medium" }))
  }, [])

  // Manual / initial / pagination load (shows the spinner).
  const load = useCallback(async (targetPage: number) => {
    setLoading(true)
    setError(null)
    try {
      const items = await fetchPage(targetPage)
      setRows(items)
      setHasMore(items.length >= PAGE_SIZE)
      ingest(items)
      // Seed the live watermark from the freshest row WITHOUT alerting.
      const maxTs = items.reduce((m, r) => Math.max(m, rowTime(r)), 0)
      if (maxTs > watermark.current) watermark.current = maxTs
      seededRef.current = true
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los logs")
    } finally {
      setLoading(false)
    }
  }, [fetchPage, ingest])

  // Silent live tick: detect + alert new errors, merge into page 1.
  const pollOnce = useCallback(async () => {
    if (inFlight.current) return
    if (typeof document !== "undefined" && document.hidden) { setConnState("paused"); return }
    inFlight.current = true
    try {
      const items = await fetchPage(1)
      failuresRef.current = 0
      setConnState("live")
      ingest(items)

      const wm = watermark.current
      const fresh = items.filter((r) => rowTime(r) > wm)
      const maxTs = items.reduce((m, r) => Math.max(m, rowTime(r)), wm)
      watermark.current = maxTs

      if (seededRef.current && fresh.length > 0) {
        const freshErrors = fresh.filter((r) => isErrorAction(r.action))
        if (freshErrors.length > 0) {
          const n = freshErrors.length
          toast.error(`${n} nuevo${n > 1 ? "s" : ""} error${n > 1 ? "es" : ""} · ${freshErrors[0].action}`, { duration: 6000 })
          beep()
          setNewErrorCount((c) => c + n)
        }
        flashRows(fresh.map((r) => r.id))
      }
      seededRef.current = true

      // Only repaint the table when viewing the live (first) page.
      if (filtersRef.current.page === 1) {
        setRows((prev) => {
          if (fresh.length === 0) return items
          const map = new Map<string, AuditLogRow>()
          ;[...items, ...prev].forEach((r) => { if (!map.has(r.id)) map.set(r.id, r) })
          return Array.from(map.values()).sort((a, b) => rowTime(b) - rowTime(a)).slice(0, MAX_LIVE_ROWS)
        })
      }
    } catch {
      failuresRef.current += 1
      setConnState("reconnecting")
    } finally {
      inFlight.current = false
    }
  }, [fetchPage, ingest, beep, flashRows])

  // Always-on adaptive poller (self-rescheduling setTimeout → supports backoff,
  // never overlaps). Runs for the life of the page.
  useEffect(() => {
    let cancelled = false
    const schedule = (delay: number) => {
      if (cancelled) return
      pollTimer.current = setTimeout(tick, delay)
    }
    const tick = async () => {
      await pollOnce()
      if (cancelled) return
      const failures = failuresRef.current
      const delay = failures > 0
        ? Math.min(LIVE_INTERVAL_MS * 2 ** failures, MAX_LIVE_BACKOFF_MS) + Math.random() * 500
        : LIVE_INTERVAL_MS
      schedule(delay)
    }
    schedule(LIVE_INTERVAL_MS)

    const onVisibility = () => {
      if (typeof document === "undefined") return
      if (document.hidden) {
        setConnState("paused")
      } else {
        setConnState("live")
        if (pollTimer.current) clearTimeout(pollTimer.current)
        void tick()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      if (pollTimer.current) clearTimeout(pollTimer.current)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [pollOnce])

  // Initial load + reload on filter/page changes. Reset the live watermark so
  // a filter switch re-seeds silently against the new result set.
  useEffect(() => {
    seededRef.current = false
    watermark.current = 0
    void load(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, actionFilter, fromDate, toDate])

  const visibleRows = useMemo(
    () => (errorsOnly ? rows.filter((r) => isErrorAction(r.action)) : rows),
    [rows, errorsOnly],
  )

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id))
  const someSelected = selected.size > 0

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleRows.forEach((r) => next.delete(r.id))
      else visibleRows.forEach((r) => next.add(r.id))
      return next
    })
  }

  const handleSearch = () => {
    setPage(1)
    seededRef.current = false
    watermark.current = 0
    void load(1)
  }

  const handleCopy = async () => {
    const source = someSelected ? visibleRows.filter((r) => selected.has(r.id)) : visibleRows
    if (source.length === 0) {
      toast.error("No hay filas para copiar")
      return
    }
    const header = ["Fecha", "Acción", "Actor", "Recurso", "Detalle"].join("\t")
    const lines = source.map((r) => [
      formatTimestamp(r.createdAt),
      r.action,
      r.actorName || r.actorId || r.actorType || "—",
      [r.resourceType, r.resourceId].filter(Boolean).join(":") || "—",
      (metadataFull(r.metadata) || metadataSummary(r.metadata) || "—").replace(/\s+/g, " "),
    ].join("\t"))
    const text = [header, ...lines].join("\n")
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${source.length} ${source.length === 1 ? "evento copiado" : "eventos copiados"} al portapapeles`)
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  const eventToJson = (row: AuditLogRow): string => {
    const payload = {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      actor: { type: row.actorType ?? null, id: row.actorId ?? null, name: row.actorName ?? null },
      resource: { type: row.resourceType ?? null, id: row.resourceId ?? null },
      metadata: row.metadata ?? null,
    }
    try {
      return JSON.stringify(payload, null, 2)
    } catch {
      return String(payload)
    }
  }

  const copyDetail = async (row: AuditLogRow) => {
    try {
      await navigator.clipboard.writeText(eventToJson(row))
      toast.success("Evento copiado (JSON) al portapapeles")
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  // AI root-cause + fix suggestion for an event. Streams from the free FlashGPT
  // path; never persisted to any chat (no chatId).
  const diagnose = useCallback((row: AuditLogRow) => {
    diagAbort.current?.abort()
    const ctrl = new AbortController()
    diagAbort.current = ctrl
    setDiagnosing(true)
    setDiagnosis("")
    const prompt =
`Eres un ingeniero SRE senior de SiraGPT. Diagnostica este evento de auditoría y responde SOLO en español, en markdown conciso.

Acción: ${row.action}
Recurso: ${[row.resourceType, row.resourceId].filter(Boolean).join(":") || "—"}
Actor: ${row.actorName || row.actorId || row.actorType || "—"}
Metadata (JSON):
${JSON.stringify(row.metadata ?? {}, null, 2)}

Devuelve:
1. Causa raíz más probable (1-2 frases).
2. Pasos concretos para solucionarlo (lista numerada y accionable).
3. Cómo prevenir que vuelva a ocurrir.`
    const run = (provider: string, model: string) => apiClient.generateAIStream(
      { provider, model, prompt, streamId: crypto.randomUUID(), disableAgentic: true },
      (chunk) => setDiagnosis((t) => t + chunk),
      () => setDiagnosing(false),
      (err) => {
        // One fallback to a cheap paid model if the free path is unconfigured.
        if (provider === "Cerebras") {
          setDiagnosis("")
          void run("OpenAI", "gpt-4o-mini")
          return
        }
        setDiagnosis(`Error: ${err.message}`)
        setDiagnosing(false)
      },
      ctrl.signal,
    )
    void run("Cerebras", "gpt-oss-120b")
  }, [])

  // Reset the diagnosis panel when switching events.
  useEffect(() => {
    diagAbort.current?.abort()
    setDiagnosis("")
    setDiagnosing(false)
  }, [detailRow])

  const handleExport = async () => {
    setExporting(true)
    try {
      const params: Record<string, string> = {}
      if (actionFilter && actionFilter !== "all") params.action = actionFilter
      const fromIso = dayBoundIso(fromDate, false)
      const toIso = dayBoundIso(toDate, true)
      if (fromIso) params.from = fromIso
      if (toIso) params.to = toIso
      const csv = await apiClient.exportAdminAuditLogsCsv(params as any)
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "audit-logs.csv"
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Logs exportados a CSV")
    } catch (err: any) {
      toast.error(err?.message || "No se pudo exportar el CSV")
    } finally {
      setExporting(false)
    }
  }

  const connDot = connState === "live" ? "#22c55e" : connState === "reconnecting" ? "#f59e0b" : "#9ca3af"
  const connLabel = connState === "live"
    ? `En vivo${lastUpdated ? ` · ${lastUpdated}` : ""}`
    : connState === "reconnecting"
      ? "Reconectando…"
      : "En pausa (pestaña oculta)"

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted-foreground">
            Auditoría del sistema en vivo: sesiones, cambios de roles, acciones administrativas y errores.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div>
                <CardTitle className="text-base">Registro de auditoría</CardTitle>
                <CardDescription>Eventos más recientes primero</CardDescription>
              </div>
              {newErrorCount > 0 && (
                <button
                  type="button"
                  onClick={() => setNewErrorCount(0)}
                  title="Marcar como visto"
                  className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive"
                >
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: "#ef4444" }} aria-hidden />
                  {newErrorCount} nuevo{newErrorCount > 1 ? "s" : ""} error{newErrorCount > 1 ? "es" : ""} · marcar visto
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSearch() }}
                  placeholder="Buscar (usuario, recurso, texto)…"
                  className="w-56 pl-8"
                />
              </div>
              <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setPage(1) }}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Acción" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las acciones</SelectItem>
                  {knownActions.map((action) => (
                    <SelectItem key={action} value={action}>{action}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void load(page)} disabled={loading}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={exporting}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {exporting ? "Exportando…" : "Exportar CSV"}
              </Button>
            </div>
          </div>

          {/* Secondary toolbar — live status, date range, errors-only, sound, copy */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title="Conexión en tiempo real">
              <span
                className={cn("inline-block h-2 w-2 rounded-full", connState === "live" && "animate-pulse")}
                style={{ backgroundColor: connDot }}
                aria-hidden
              />
              {connLabel}
            </span>

            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Desde</span>
              <Input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => { setFromDate(e.target.value); setPage(1) }}
                className="h-8 w-[9.5rem] text-xs"
              />
              <span className="text-xs font-medium text-muted-foreground">Hasta</span>
              <Input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => { setToDate(e.target.value); setPage(1) }}
                className="h-8 w-[9.5rem] text-xs"
              />
              {(fromDate || toDate) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-muted-foreground"
                  onClick={() => { setFromDate(""); setToDate(""); setPage(1) }}
                >
                  Limpiar
                </Button>
              )}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
              <Switch checked={errorsOnly} onCheckedChange={(v) => setErrorsOnly(!!v)} />
              Solo errores
            </label>

            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground" title="Sonar al detectar un error nuevo">
              <Switch checked={soundOn} onCheckedChange={(v) => { setSoundOn(!!v); if (v) beep() }} />
              {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              Sonido
            </label>

            <div className="ml-auto flex items-center gap-2">
              {someSelected && (
                <span className="text-xs text-muted-foreground">{selected.size} seleccionados</span>
              )}
              <Button variant="outline" size="sm" onClick={() => void handleCopy()} disabled={visibleRows.length === 0}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {someSelected ? `Copiar (${selected.size})` : "Copiar todo"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center text-sm text-destructive">
              {error}
            </div>
          ) : visibleRows.length === 0 && !loading ? (
            <div className="rounded-md border border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
              {errorsOnly ? "Sin errores para este filtro." : "Sin eventos para este filtro."}
            </div>
          ) : (
            <>
            {/* Desktop/tablet table; phones get the card list below. */}
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Seleccionar todos"
                    />
                  </TableHead>
                  <TableHead className="w-44">Fecha</TableHead>
                  <TableHead className="w-48">Acción</TableHead>
                  <TableHead className="w-40">Actor</TableHead>
                  <TableHead className="w-36">Recurso</TableHead>
                  <TableHead>Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
                  const isErr = isErrorAction(row.action)
                  const isChecked = selected.has(row.id)
                  const isNew = recentlyNew.has(row.id)
                  return (
                    <TableRow
                      key={row.id}
                      data-state={isChecked ? "selected" : undefined}
                      className={cn("cursor-pointer", isErr && "bg-destructive/5")}
                      style={isNew ? { boxShadow: "inset 3px 0 0 #f59e0b", backgroundColor: "rgba(245,158,11,0.08)" } : undefined}
                      onClick={() => setDetailRow(row)}
                      title="Ver detalle del evento"
                    >
                      <TableCell className="align-middle" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => toggleRow(row.id)}
                          aria-label="Seleccionar evento"
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {formatTimestamp(row.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={actionBadgeVariant(row.action)} className="font-mono text-[11px]">
                          {row.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-40 truncate text-xs" title={row.actorId || undefined}>
                        {row.actorName || row.actorId || row.actorType || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.resourceType || "—"}
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs text-muted-foreground" title={metadataFull(row.metadata) || metadataSummary(row.metadata)}>
                        {metadataSummary(row.metadata) || "—"}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            </div>

            {/* Mobile card list — phones get tappable cards instead of a
                side-scrolling table. Same selection + tap-to-detail behavior. */}
            <div className="space-y-2 md:hidden">
              {visibleRows.map((row) => {
                const isErr = isErrorAction(row.action)
                const isChecked = selected.has(row.id)
                const isNew = recentlyNew.has(row.id)
                return (
                  <div
                    key={row.id}
                    onClick={() => setDetailRow(row)}
                    className={cn("cursor-pointer rounded-lg border bg-card p-3", isErr && "bg-destructive/5")}
                    style={isNew ? { boxShadow: "inset 3px 0 0 #f59e0b", backgroundColor: "rgba(245,158,11,0.08)" } : undefined}
                  >
                    <div className="flex items-start gap-2">
                      <span className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => toggleRow(row.id)}
                          aria-label="Seleccionar evento"
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant={actionBadgeVariant(row.action)} className="font-mono text-[11px]">
                            {row.action}
                          </Badge>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {formatTimestamp(row.createdAt)}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-xs">
                          {row.actorName || row.actorId || row.actorType || "—"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {[row.resourceType, row.resourceId].filter(Boolean).join(" · ") || "—"}
                        </div>
                        {metadataSummary(row.metadata) && (
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {metadataSummary(row.metadata)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            </>
          )}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Página {page}{page === 1 ? " · en vivo" : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
                Siguiente
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Event detail — full record + AI diagnosis. */}
      <Dialog open={!!detailRow} onOpenChange={(o) => { if (!o) setDetailRow(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Detalle del evento</span>
              {detailRow && (
                <Badge variant={actionBadgeVariant(detailRow.action)} className="font-mono text-[11px]">
                  {detailRow.action}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {detailRow ? formatTimestamp(detailRow.createdAt) : ""}
            </DialogDescription>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">Actor</div>
                  <div className="break-all">{detailRow.actorName || detailRow.actorId || detailRow.actorType || "—"}</div>
                  {detailRow.actorId && detailRow.actorName && (
                    <div className="break-all text-xs text-muted-foreground">{detailRow.actorId}</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">Recurso</div>
                  <div className="break-all">{[detailRow.resourceType, detailRow.resourceId].filter(Boolean).join(" · ") || "—"}</div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Metadata</div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-3 text-xs leading-relaxed">
                  {detailRow.metadata ? JSON.stringify(detailRow.metadata, null, 2) : "—"}
                </pre>
              </div>

              {(diagnosis || diagnosing) && (
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5" />
                    Diagnóstico IA {diagnosing && <span className="text-muted-foreground/70">· generando…</span>}
                  </div>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed">
                    {diagnosis || "…"}
                  </pre>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                {diagnosing ? (
                  <Button variant="outline" size="sm" onClick={() => { diagAbort.current?.abort(); setDiagnosing(false) }}>
                    Detener
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => diagnose(detailRow)}>
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    {diagnosis ? "Re-diagnosticar" : "Diagnosticar con IA"}
                  </Button>
                )}
                {diagnosis && !diagnosing && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { void navigator.clipboard.writeText(diagnosis).then(() => toast.success("Diagnóstico copiado")) }}
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copiar diagnóstico
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => void copyDetail(detailRow)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copiar JSON
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
