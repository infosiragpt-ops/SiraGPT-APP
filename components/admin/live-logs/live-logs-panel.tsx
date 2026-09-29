"use client"

/**
 * Admin → Logs → «Registros en vivo» — every line the backend prints, live,
 * Replit-style: newest at the bottom, errors red, warnings amber.
 *
 *   - Streams over fetch (Bearer) from GET /api/admin/logs/live; reconnects
 *     with backoff and resumes after the last line (no gaps, no duplicates).
 *   - Server-side filters (level, source, text, user, request); pause/resume
 *     buffers new lines instead of dropping them.
 *   - Windowed rendering (fixed row height) keeps thousands of lines smooth.
 *   - Click a line → full body + context + «Ver toda la petición».
 *   - A checkbox before the time selects lines (Shift+click = range, header
 *     box = everything loaded); «Copiar seleccionadas» copies just those in
 *     the same text format as the export, so a warning can be pasted as-is.
 *   - New error lines raise `onNewErrors` and a `sira:admin-live-log-errors`
 *     window event (the admin-wide alert/sound system can subscribe).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDownToLine, Copy, Download, Pause, Play, Search, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  formatLinesAsText,
  isErrorLevel,
  LiveLogsHttpError,
  openLiveLogStream,
  type LiveLogFilter,
  type LiveLogLevelFilter,
  type LiveLogLine,
  type LiveLogStats,
} from "@/lib/admin/live-logs-service"
import { hasTextSelection, type CopyRecord } from "@/lib/admin/log-copy"
import { useLogSelection } from "@/lib/admin/use-log-selection"
import { HeaderCheckbox, LogSelectionBar, RowCheckbox } from "@/components/admin/log-selection-bar"
import { cn } from "@/lib/utils"
import { LiveLogDetail } from "./live-log-detail"
import { appendLines, applyRepeats, MAX_CLIENT_LINES } from "./live-logs-buffer"
import { formatLogTime, levelBadgeClass, levelLabel, levelRowClass, sourceLabel, userLabel } from "./live-log-format"

const ROW_H = 30
const OVERSCAN = 12
const LEVEL_FILTER_LABELS: Record<string, string> = {
  info: "Info y superior",
  all: "Todos (incl. depuración)",
  warn: "Avisos y errores",
  error: "Solo errores",
}
const STALE_MS = 45_000
const GRID = "grid grid-cols-[18px_92px_64px_minmax(90px,150px)_52px_minmax(0,1fr)] md:grid-cols-[18px_104px_72px_minmax(110px,170px)_56px_minmax(120px,200px)_minmax(0,1fr)] items-center gap-2"

type ConnState = "connecting" | "live" | "reconnecting" | "error"

const LINE_NOUN = { one: "línea", many: "líneas", feminine: true }
const lineId = (line: LiveLogLine) => line.id
const lineToRecord = (line: LiveLogLine): CopyRecord => ({
  id: line.id,
  at: line.ts,
  headline: line.msg,
  fields: [
    ["Nivel", line.level.toUpperCase()],
    ["Fuente", line.source],
    ["Usuario", line.email || line.userId],
    ["Petición", line.reqId],
    ["Chat", line.chatId],
    ["Versión", line.commit],
    ["Repeticiones", line.repeat && line.repeat > 1 ? line.repeat : null],
    ["Detalle", line.body && line.body !== line.msg ? line.body : null],
  ],
  raw: line,
})
const LINE_FORMAT_OVERRIDE = { texto: formatLinesAsText }

type Props = {
  onNewErrors?: (lines: LiveLogLine[]) => void
  /** Test seam: replace the network stream. */
  openStream?: typeof openLiveLogStream
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function LiveLogsPanel({ onNewErrors, openStream = openLiveLogStream }: Props) {
  const [lines, setLines] = useState<LiveLogLine[]>([])
  const [conn, setConn] = useState<ConnState>("connecting")
  const [connError, setConnError] = useState<string | null>(null)
  const [stats, setStats] = useState<LiveLogStats | null>(null)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  // Default hides debug (fast successful reads, [*-dbg] traces): «si pasa
  // normal, no reportarlo». «Todos» still shows everything.
  const [level, setLevel] = useState<LiveLogLevelFilter>("info")
  const [source, setSource] = useState<string>("all")
  const [draftQ, setDraftQ] = useState("")
  const [draftUser, setDraftUser] = useState("")
  const [reqId, setReqId] = useState<string>("")
  const [selected, setSelected] = useState<LiveLogLine | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const q = useDebounced(draftQ.trim(), 400)
  const user = useDebounced(draftUser.trim(), 400)

  const pausedRef = useRef(false)
  const pendingRef = useRef<LiveLogLine[]>([])
  const onNewErrorsRef = useRef(onNewErrors)
  onNewErrorsRef.current = onNewErrors
  pausedRef.current = paused

  const filter: LiveLogFilter = useMemo(() => ({
    level,
    source: source !== "all" ? source : undefined,
    q: q.length >= 2 ? q : undefined,
    user: user || undefined,
    reqId: reqId || undefined,
  }), [level, source, q, user, reqId])
  const filterKey = JSON.stringify(filter)

  const ingest = useCallback((incoming: LiveLogLine[], isLive: boolean) => {
    if (!incoming.length) return
    if (isLive) {
      const errs = incoming.filter((l) => isErrorLevel(l.level))
      if (errs.length) {
        try { onNewErrorsRef.current?.(errs) } catch { /* ignore */ }
        try { window.dispatchEvent(new CustomEvent("sira:admin-live-log-errors", { detail: { count: errs.length, lines: errs } })) } catch { /* ignore */ }
      }
    }
    if (isLive && pausedRef.current) {
      pendingRef.current = appendLines(pendingRef.current, incoming, MAX_CLIENT_LINES)
      setPendingCount(pendingRef.current.length)
      return
    }
    setLines((prev) => appendLines(prev, incoming))
  }, [])

  // Connection loop — one per filter; resumes after the last seen line.
  useEffect(() => {
    let alive = true
    const unmount = new AbortController()
    let connCtrl: AbortController | null = null
    let lastSeenAt = Date.now()
    let resumeAfter: string | null = null
    setLines([])
    pendingRef.current = []
    setPendingCount(0)
    setConn("connecting")
    setConnError(null)

    const watchdog = setInterval(() => {
      if (connCtrl && Date.now() - lastSeenAt > STALE_MS) connCtrl.abort()
    }, 5000)

    const run = async () => {
      let attempt = 0
      while (alive) {
        connCtrl = new AbortController()
        const onAbort = () => connCtrl?.abort()
        unmount.signal.addEventListener("abort", onAbort)
        try {
          await openStream({
            filter,
            after: resumeAfter,
            backfill: 400,
            signal: connCtrl.signal,
            onEvent: (ev) => {
              lastSeenAt = Date.now()
              setLastEventAt(lastSeenAt)
              switch (ev.event) {
                case "hello":
                  attempt = 0
                  setConn("live")
                  setConnError(null)
                  if (ev.data?.stats) setStats(ev.data.stats)
                  break
                case "backfill":
                  ingest(ev.data || [], false)
                  if (ev.data?.length) resumeAfter = ev.data[ev.data.length - 1].id
                  break
                case "lines":
                  ingest(ev.data || [], true)
                  if (ev.data?.length) resumeAfter = ev.data[ev.data.length - 1].id
                  break
                case "repeat":
                  setLines((prev) => applyRepeats(prev, ev.data || []))
                  break
                case "ping":
                  if (ev.data?.stats) setStats(ev.data.stats)
                  break
                default:
                  break
              }
            },
          })
        } catch (err) {
          if (!alive) return
          if (err instanceof LiveLogsHttpError && (err.status === 401 || err.status === 403)) {
            setConn("error")
            setConnError("Tu sesión no tiene permiso para ver los registros del servidor.")
            return
          }
          if (err instanceof LiveLogsHttpError && err.status === 429) {
            setConnError(err.message)
          }
        } finally {
          unmount.signal.removeEventListener("abort", onAbort)
        }
        if (!alive) return
        setConn("reconnecting")
        attempt += 1
        const wait = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4))
        await new Promise((r) => setTimeout(r, wait))
      }
    }
    void run()
    return () => {
      alive = false
      clearInterval(watchdog)
      unmount.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, openStream, ingest])

  const resume = useCallback(() => {
    const buffered = pendingRef.current
    pendingRef.current = []
    setPendingCount(0)
    setPaused(false)
    if (buffered.length) setLines((prev) => appendLines(prev, buffered))
  }, [])

  const total = lines.length

  // ── Windowed list ────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const atBottomRef = useRef(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewH(el.clientHeight || 600)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !autoScroll || !atBottomRef.current) return
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
  }, [lines, autoScroll])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 1.5
  }, [])

  const jumpToEnd = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = true
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    setAutoScroll(true)
  }, [])

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const windowed = lines.slice(start, end)

  const counts = useMemo(() => {
    let errors = 0
    let warns = 0
    for (const l of lines) {
      if (isErrorLevel(l.level)) errors += l.repeat || 1
      else if (l.level === "warn") warns += l.repeat || 1
    }
    return { errors, warns }
  }, [lines])

  const sources = useMemo(() => {
    const set = new Set<string>()
    for (const l of lines) if (l.source) set.add(l.source)
    if (source !== "all") set.add(source)
    return Array.from(set).sort().slice(0, 40)
  }, [lines, source])

  // Lines leave the buffer (filter change, «Limpiar», the client cap); the
  // hook re-derives the selection from `lines`, so counts stay exact.
  const selection = useLogSelection({
    rows: lines,
    getId: lineId,
    toRecord: lineToRecord,
    formatOverride: LINE_FORMAT_OVERRIDE,
    noun: LINE_NOUN,
    filePrefix: "registros-siragpt",
  })
  const copyAll = useCallback(() => { void selection.copyRows(lines) }, [selection, lines])
  const exportLines = useCallback(() => selection.exportRows(lines), [selection, lines])

  const statusDot =
    conn === "live" && !paused ? "bg-emerald-500" : conn === "error" ? "bg-red-500" : paused ? "bg-amber-500" : "bg-slate-400 animate-pulse"
  const statusText = conn === "error"
    ? "Sin conexión"
    : paused
      ? `Pausado${pendingCount ? ` · ${pendingCount} nuevas` : ""}`
      : conn === "live"
        ? `En vivo${lastEventAt ? ` · ${formatLogTime(lastEventAt)}` : ""}`
        : conn === "reconnecting" ? "Reconectando…" : "Conectando…"

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4 text-card-foreground shadow-sm" data-testid="live-logs-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full border border-border/70 px-2.5 py-1 text-xs font-medium" data-testid="live-logs-status">
          <span className={cn("h-2 w-2 rounded-full", statusDot)} />
          {statusText}
        </span>
        <Button size="sm" variant="outline" onClick={() => (paused ? resume() : setPaused(true))} data-testid="live-logs-pause">
          {paused ? <Play className="mr-1.5 h-3.5 w-3.5" /> : <Pause className="mr-1.5 h-3.5 w-3.5" />}
          {paused ? "Reanudar" : "Pausar"}
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          <Switch checked={level === "error"} onCheckedChange={(v) => setLevel(v ? "error" : "info")} data-testid="live-logs-errors-only" />
          Solo errores
        </label>
        <Select value={level} onValueChange={(v) => setLevel(v as LiveLogLevelFilter)}>
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Nivel mínimo">
            <SelectValue>{LEVEL_FILTER_LABELS[level] || level}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="info">Info y superior</SelectItem>
            <SelectItem value="all">Todos (incl. depuración)</SelectItem>
            <SelectItem value="warn">Avisos y errores</SelectItem>
            <SelectItem value="error">Solo errores</SelectItem>
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Fuente">
            <SelectValue>{source === "all" ? "Todas las fuentes" : source}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las fuentes</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={draftQ} onChange={(e) => setDraftQ(e.target.value)} placeholder="Buscar en el log…" className="h-8 w-[200px] pl-8 text-xs" aria-label="Buscar en el log" />
        </div>
        <Input value={draftUser} onChange={(e) => setDraftUser(e.target.value)} placeholder="Usuario (email o id)" className="h-8 w-[180px] text-xs" aria-label="Filtrar por usuario" />
        {reqId && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 font-mono text-[11px]">
            petición {reqId.slice(0, 12)}…
            <button type="button" aria-label="Quitar filtro de petición" onClick={() => setReqId("")}>
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="live-logs-counts">
            {total.toLocaleString("es")} líneas · <span className={counts.errors ? "font-semibold text-red-600" : ""}>{counts.errors} errores</span> · {counts.warns} avisos
          </span>
          <Button size="sm" variant="ghost" onClick={copyAll} disabled={!total} title="Copiar todo">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={exportLines} disabled={!total} title="Exportar">
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setLines([]); pendingRef.current = []; setPendingCount(0); selection.clear() }} disabled={!total} title="Limpiar pantalla">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {connError && (
        <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{connError}</div>
      )}

      <LogSelectionBar
        count={selection.count}
        noun={LINE_NOUN}
        format={selection.format}
        onFormatChange={selection.setFormat}
        onCopy={() => void selection.copySelected()}
        onExport={() => selection.exportSelected()}
        onClear={selection.clear}
        testIdPrefix="live-logs"
      />

      <div className="overflow-hidden rounded-lg border border-border/70">
        <div className={cn(GRID, "border-b border-border/70 bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground")} role="row">
          <HeaderCheckbox
            allSelected={selection.allSelected}
            someSelected={selection.someSelected}
            disabled={!total}
            onToggle={selection.toggleAll}
            label="Seleccionar todas las líneas cargadas"
            testId="live-logs-select-all"
          />
          <span>Hora</span>
          <span>Versión</span>
          <span>Fuente</span>
          <span>Nivel</span>
          <span className="hidden md:block">Usuario</span>
          <span>Log</span>
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative h-[62vh] min-h-[320px] overflow-y-auto font-mono text-[12px]"
          data-testid="live-logs-list"
          role="rowgroup"
        >
          {total === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {conn === "live" ? "Esperando registros…" : statusText}
            </div>
          ) : (
            <div style={{ height: total * ROW_H, position: "relative" }}>
              {windowed.map((line, i) => (
                <div
                  key={line.id}
                  role="row"
                  tabIndex={0}
                  data-level={line.level}
                  data-testid="live-log-row"
                  aria-selected={selection.isSelected(line.id)}
                  onClick={() => { if (!hasTextSelection()) setSelected(line) }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setSelected(line)
                    else if (e.key === " ") { e.preventDefault(); selection.toggle(line.id, e.shiftKey) }
                  }}
                  className={cn(
                    GRID,
                    "absolute left-0 right-0 cursor-pointer border-b border-border/40 px-3 outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    levelRowClass(line.level),
                    selection.isSelected(line.id) && "bg-foreground/[0.06] shadow-[inset_2px_0_0_0_hsl(var(--foreground))]",
                  )}
                  style={{ top: (start + i) * ROW_H, height: ROW_H }}
                  title={line.msg}
                >
                  <RowCheckbox
                    checked={selection.isSelected(line.id)}
                    onToggle={(range) => selection.toggle(line.id, range)}
                    label={`Seleccionar la línea de las ${formatLogTime(line.ts)}`}
                    testId="live-log-select"
                  />
                  <span className="tabular-nums text-muted-foreground">{formatLogTime(line.ts)}</span>
                  <span className="truncate text-muted-foreground">{line.commit || "—"}</span>
                  <span className="truncate">{sourceLabel(line)}</span>
                  <span>
                    <span className={cn("rounded px-1 py-px text-[10px] font-semibold uppercase", levelBadgeClass(line.level))}>{levelLabel(line.level)}</span>
                  </span>
                  <span className="hidden truncate text-muted-foreground md:block">{userLabel(line)}</span>
                  <span className="truncate">
                    {line.msg}
                    {line.repeat && line.repeat > 1 ? <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">×{line.repeat}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Se muestran las últimas {MAX_CLIENT_LINES.toLocaleString("es")} líneas. Las claves y contraseñas se ocultan antes de guardarse.
          {stats?.redis ? ` · Historial: ${stats.redis === "ready" ? (stats.paused ? "pausado (Redis ocupado)" : "guardado") : "solo memoria"}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5">
            <Switch checked={autoScroll} onCheckedChange={(v) => { setAutoScroll(!!v); if (v) jumpToEnd() }} />
            Seguir el final
          </label>
          <Button size="sm" variant="ghost" onClick={jumpToEnd} className="h-7 text-[11px]">
            <ArrowDownToLine className="mr-1 h-3 w-3" /> Ir al final
          </Button>
        </div>
      </div>

      <LiveLogDetail line={selected} onClose={() => setSelected(null)} onFilterRequest={(id) => setReqId(id)} />
    </div>
  )
}

export default LiveLogsPanel
