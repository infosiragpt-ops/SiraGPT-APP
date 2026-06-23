"use client"

/**
 * LogsTab — Replit-style log table.
 *
 * Initial fill from deploymentsApi.logs(id).entries; then a live SSE tail via
 * new EventSource(logsStreamUrl(id)) listening to open / log / eof events. Each
 * `log` event carries a LogEntry-shaped object. Toolbar: search + "Errors only"
 * + date filter. Bottom status bar: Collapse / Wrap / Colors + ● Live.
 */

import * as React from "react"
import { Check, ChevronDown, Copy, Info, Palette, Search } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { deploymentsApi, type LogEntry } from "@/lib/deployments/deployments-api"

type Connection = "connecting" | "live" | "closed"
type DateFilter = "all" | "hour" | "today"

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number, size = 2) => String(n).padStart(size, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(Math.floor(d.getMilliseconds() / 10))}`
}

function shortDeployment(value: string | null): string {
  if (!value) return "—"
  return value.length > 12 ? value.slice(0, 12) : value
}

export function LogsTab({ deploymentId }: { deploymentId: string }) {
  const [entries, setEntries] = React.useState<LogEntry[]>([])
  const [connection, setConnection] = React.useState<Connection>("connecting")
  const [search, setSearch] = React.useState("")
  const [onlyErrors, setOnlyErrors] = React.useState(false)
  const [dateFilter, setDateFilter] = React.useState<DateFilter>("all")
  const [collapsed, setCollapsed] = React.useState(false)
  const [wrap, setWrap] = React.useState(false)
  const [colors, setColors] = React.useState(true)
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null)

  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // Reset when switching deployments.
  React.useEffect(() => {
    setEntries([])
    setConnection("connecting")
  }, [deploymentId])

  // Initial fill from the REST endpoint.
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await deploymentsApi.logs(deploymentId)
        if (cancelled) return
        setEntries(result.entries)
        setConnection("live")
      } catch {
        // The SSE stream may still fill it; fail soft.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [deploymentId])

  // Live SSE tail.
  React.useEffect(() => {
    const url = deploymentsApi.logsStreamUrl(deploymentId)
    let source: EventSource | null = null
    try {
      source = new EventSource(url, { withCredentials: true })
    } catch {
      setConnection("closed")
      return
    }

    const onOpen = () => setConnection("live")
    const onLog = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as Partial<LogEntry>
        if (payload && typeof payload.message === "string") {
          setEntries((prev) => [
            ...prev,
            {
              ts: typeof payload.ts === "string" ? payload.ts : new Date().toISOString(),
              source: payload.source === "User" ? "User" : "System",
              level: payload.level === "error" ? "error" : "info",
              message: payload.message as string,
              deployment: typeof payload.deployment === "string" ? payload.deployment : null,
              index: typeof payload.index === "number" ? payload.index : undefined,
            },
          ])
        }
      } catch {
        if (typeof event.data === "string") {
          setEntries((prev) => [
            ...prev,
            { ts: new Date().toISOString(), source: "System", level: "info", message: event.data, deployment: null },
          ])
        }
      }
    }
    const onEof = () => {
      setConnection("closed")
      source?.close()
    }
    const onError = () => setConnection("closed")

    source.addEventListener("open", onOpen)
    source.addEventListener("log", onLog as EventListener)
    source.addEventListener("eof", onEof)
    source.onerror = onError

    return () => {
      source?.removeEventListener("open", onOpen)
      source?.removeEventListener("log", onLog as EventListener)
      source?.removeEventListener("eof", onEof)
      source?.close()
    }
  }, [deploymentId])

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    const now = Date.now()
    return entries.filter((entry) => {
      if (onlyErrors && entry.level !== "error") return false
      if (needle && !entry.message.toLowerCase().includes(needle)) return false
      if (dateFilter !== "all") {
        const ts = new Date(entry.ts).getTime()
        if (Number.isFinite(ts)) {
          if (dateFilter === "hour" && now - ts > 60 * 60 * 1000) return false
          if (dateFilter === "today") {
            const d = new Date(ts)
            const today = new Date()
            if (d.toDateString() !== today.toDateString()) return false
          }
        }
      }
      return true
    })
  }, [entries, search, onlyErrors, dateFilter])

  // Auto-scroll to the newest row.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filtered.length])

  const copyRow = (index: number, entry: LogEntry) => {
    void navigator.clipboard
      ?.writeText(`${formatTime(entry.ts)}\t${entry.source}\t${entry.message}`)
      .then(() => {
        setCopiedIndex(index)
        window.setTimeout(() => setCopiedIndex((prev) => (prev === index ? null : prev)), 1500)
      })
  }

  return (
    <section className="flex h-full min-h-[520px] flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <div className="relative min-w-[180px] flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="h-7 rounded-md border-border bg-background px-2 pr-8 text-[12px] shadow-none"
          />
          <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground" />
        </div>
        <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-muted px-2.5 text-[12px] font-medium text-foreground hover:bg-[#ddd9cf]">
          <Checkbox
            checked={onlyErrors}
            onCheckedChange={(v) => setOnlyErrors(v === true)}
            className="h-4 w-4 rounded-[5px] border-border bg-background"
          />
          Errors only
        </label>
        <label className="relative inline-flex h-7 items-center">
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as DateFilter)}
            className="h-7 appearance-none rounded-md border border-transparent bg-muted pl-2.5 pr-7 text-[12px] font-medium text-foreground outline-none hover:bg-[#ddd9cf] focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Filter by date"
          >
            <option value="all">Date</option>
            <option value="hour">Last hour</option>
            <option value="today">Today</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
        </label>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b border-border text-[12px] font-medium text-foreground">
              <th className="w-[28px] px-1 py-1.5">
                <Checkbox disabled className="h-4 w-4 rounded-[5px] border-border bg-muted" />
              </th>
              <th className="w-[174px] px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1">
                  Time <Info className="h-3 w-3 text-muted-foreground" />
                </span>
              </th>
              <th className="w-[96px] px-2 py-1.5 font-medium">Deployment</th>
              <th className="w-[64px] px-2 py-1.5 font-medium">Source</th>
              <th className="px-2 py-1.5 font-medium">Log</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                  {entries.length === 0 ? "Waiting for logs…" : "No logs match the filter."}
                </td>
              </tr>
            ) : (
              filtered.map((entry, index) => {
                const isError = entry.level === "error"
                const cellPad = collapsed ? "py-0.5" : "py-1"
                return (
                  <tr
                    key={`${entry.ts}-${index}`}
                    className={cn(
                      "group border-b border-border/50 align-top transition-colors hover:bg-muted/40",
                      colors && isError && "border-[#b9534b] bg-[#dd9994] hover:bg-[#d98d87]",
                    )}
                  >
                    <td className={cn("px-1", cellPad)} />
                    <td className={cn("whitespace-nowrap px-2 font-mono text-[11px]", isError ? "text-black" : "text-muted-foreground", cellPad)}>
                      {formatTime(entry.ts)}
                    </td>
                    <td className={cn("whitespace-nowrap px-2 font-mono text-[11px]", isError ? "text-black" : "text-muted-foreground", cellPad)}>
                      {shortDeployment(entry.deployment)}
                    </td>
                    <td className={cn("whitespace-nowrap px-2 text-[11px]", isError ? "text-black" : "text-muted-foreground", cellPad)}>
                      {entry.source}
                    </td>
                    <td className={cn("px-2", cellPad)}>
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            "min-w-0 flex-1 font-mono text-[11px] leading-5",
                            wrap ? "whitespace-pre-wrap break-words" : "truncate whitespace-pre",
                            colors && isError ? "text-black" : "text-foreground",
                          )}
                        >
                          {entry.message}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyRow(index, entry)}
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                          aria-label="Copy line"
                        >
                          {copiedIndex === index ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom status bar */}
      <div className="flex h-9 shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-2 text-[12px] text-muted-foreground">
        <BarToggle active={collapsed} onClick={() => setCollapsed((v) => !v)}>
          Collapse
        </BarToggle>
        <BarToggle active={wrap} onClick={() => setWrap((v) => !v)}>
          Wrap
        </BarToggle>
        <BarToggle active={colors} onClick={() => setColors((v) => !v)}>
          <Palette className="h-3.5 w-3.5" />
          Colors
        </BarToggle>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connection === "live" ? "bg-emerald-500" : connection === "connecting" ? "bg-amber-500" : "bg-muted-foreground",
            )}
            aria-hidden
          />
          <span className={connection === "live" ? "text-emerald-600" : "text-muted-foreground"}>
            {connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}
          </span>
        </span>
      </div>
    </section>
  )
}

function BarToggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-foreground",
        active ? "font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  )
}
